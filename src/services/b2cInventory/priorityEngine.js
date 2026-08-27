'use strict';
/**
 * priorityEngine.js — B2C Inventory Distribution OS · Phase 4 · Rule V1.
 *
 * Owner directive (2026-08-25):
 *   · Pure functions only · NO DB · NO scheduler · NO task INSERT
 *   · Priority Engine 은 (SKU scorecard row, channel, config, options) 을 받아
 *     각 SKU × channel 조합의 priority_level / priority_score / reasons 를 반환.
 *   · cost_krw NULL SKU 는 사라지지 않음 · COST_MISSING flag + P0 승격 금지.
 *   · stock_age_days low confidence (proxy) 단독으로 P0 승격 금지.
 *   · Priority 4 등급 P0/P1/P2/P3 · 겹치지 않는 명시적 rule.
 *
 * Sales/Inventory 비중 (Owner 지정):
 *   · Sales Validation      30
 *   · Inventory Value       30
 *   · Channel Gap           20
 *   · Stock/Aging           10 (low confidence 이면 최대 3점)
 *   · Margin/Data Quality   10 (V1: cost 있으면 5, 없으면 0)
 *
 * Threshold: 프로덕션 분포 (2026-08-25 probe) 기반.
 *   · inventory_value P50=₩500k · P75=₩1.12M · P90=₩1.52M
 *   · sales_90d       P50=2 · P75=5 · P90=14 · P95=28
 *   · high value threshold: margin_settings b2c.high_value_threshold_krw = 500000 (P50)
 */

const AUTO_TASK_CHANNELS = new Set(['coupang', 'naver', '11st', 'gmarket']);

//   ── 1. resolveEligibility ─────────────────────────────────
//   Owner spec §2. Fail-closed 원칙.
//   returns true | false (never null · Priority Engine 은 true/false 만 소비)
function resolveEligibility(channelEligibility, channel, defaultMode) {
  if (Array.isArray(channelEligibility)) {
    return channelEligibility.includes(channel);
  }
  //   null/undefined/기타 → default_mode 로 결정
  const mode = Number(defaultMode);
  if (mode === 1)   /* KOREA_ALL */ return AUTO_TASK_CHANNELS.has(channel);
  //   NONE(0) 또는 unknown → false (fail closed)
  return false;
}

//   ── 2. Sales Validation Score (max 30) ────────────────────
//   Bucketed clamp — production sales_90d 분포 반영.
//   0=0 · 1=10 · 2~5=18 · 6~14=24 · 15+=30
function calculateSalesValidationScore(ebay_sales_90d, shopify_sales_90d) {
  const s = (Number(ebay_sales_90d) || 0) + (Number(shopify_sales_90d) || 0);
  if (s <= 0) return 0;
  if (s === 1)  return 10;
  if (s <= 5)   return 18;
  if (s <= 14)  return 24;
  return 30;
}

//   ── 3. Inventory Value Score (max 30) ─────────────────────
//   cost missing → 0 (unit_cost 없으면 inventory_value_krw 도 0 이므로 자연 0)
//   Bucket: 프로덕션 분포 반영 · P50=500k / P75=1.1M / P90=1.5M / P95=1.9M
function calculateInventoryValueScore(inventory_value_krw, unit_cost) {
  if (unit_cost == null) return 0;                                       //   COST_MISSING 방어
  const v = Number(inventory_value_krw) || 0;
  if (v <= 0)         return 0;
  if (v < 100000)     return 5;      //   ₩100k 미만
  if (v < 300000)     return 12;     //   ₩100k-300k
  if (v < 500000)     return 18;     //   ₩300k-500k (P50)
  if (v < 1000000)    return 24;     //   ₩500k-1M (P50-P75)
  if (v < 3000000)    return 28;     //   ₩1M-3M (P75-P99)
  return 30;                          //   > ₩3M (P99+)
}

//   ── 4. Channel Gap Score (max 20) ─────────────────────────
//   eligible 인 자동 대상 4채널 중 몇 개가 NONE/ERROR 상태인가.
//   denominator = 이 SKU 에서 실제 eligible 인 채널 수 (0이면 score=0)
function calculateChannelGapScore(evaluations) {
  //   evaluations: 이 SKU 의 4채널에 대한 각 evaluation (이 SKU 의 다른 채널들의 상태)
  //   여기서는 (target_channel_status, eligible) 배열
  const eligibleCount = evaluations.filter(e => e.eligible).length;
  if (eligibleCount === 0) return 0;
  const gapCount = evaluations.filter(e => e.eligible && (e.channel_status === 'NONE' || e.channel_status === 'ERROR')).length;
  //   gap 비율에 따라 max 20
  const ratio = gapCount / eligibleCount;
  return Math.round(ratio * 20);
}

//   ── 5. Aging Score (max 10) · low confidence 시 max 3 ────
function calculateAgingScore(stock_age_days, stock_age_source, oldStockDays, veryOldStockDays) {
  if (stock_age_days == null) return 0;
  const d = Number(stock_age_days);
  const oldD = Number(oldStockDays) || 60;
  const veryOldD = Number(veryOldStockDays) || 90;
  let raw = 0;
  if (d < oldD)          raw = Math.round((d / oldD) * 5);      //   < 60일: 0-5
  else if (d < veryOldD) raw = 7;                                //   60-90일
  else                    raw = 10;                              //   90+일
  //   low confidence (sku_created_at proxy) → cap at 3
  const isLow = stock_age_source === 'sku_created_at' || stock_age_source == null;
  if (isLow) return Math.min(raw, 3);
  return raw;
}

//   ── 6. Margin / Data Quality Score (max 10) ───────────────
//   V1 은 cost 여부만 반영. 향후 margin 계산 도입 시 확장.
function calculateMarginScore(unit_cost) {
  if (unit_cost == null) return 0;
  //   Data completeness bonus (cost 있음)
  return 5;
}

//   ── 7. Data Quality flags ─────────────────────────────────
function computeDataQualityFlags(scorecard) {
  const flags = [];
  if (scorecard.unit_cost == null && Number(scorecard.stock_qty) > 0) {
    flags.push('COST_MISSING');
  }
  //   stock_age_source proxy → STOCK_AGE_PROXY (정보용)
  if (scorecard.stock_age_source === 'sku_created_at') {
    flags.push('STOCK_AGE_PROXY');
  }
  //   STOCK_SOURCE_WEAK: stock_qty 는 platform_listings/ebay_products 에서 옴 (inventory_movements 미완).
  //   현재 100% weak 이므로 flag 는 항상 붙지 않게 하지 않고 · 정보용으로 대량 붙이지 않음.
  //   MISSING_PRODUCT_TITLE
  if (!scorecard.title || String(scorecard.title).trim() === '') {
    flags.push('MISSING_PRODUCT_TITLE');
  }
  return flags;
}

//   ── 8. Priority Level (P0/P1/P2/P3) ───────────────────────
//   Owner spec §5-§8 명시적 rule · 겹치지 않음.
function calculatePriorityLevel({
  stock_qty, channel_status, eligible,
  ebay_sales_90d, shopify_sales_90d,
  inventory_value_krw, stock_age_days, stock_age_confidence,
  data_quality_flags,
  config,
}) {
  //   불충족 base condition → P3 (Task 후보 아님)
  if (Number(stock_qty) <= 0) return null;                          //   재고 없음 → level=null (Task 안 만듦)
  if (channel_status !== 'NONE' && channel_status !== 'ERROR') return null;   //   이미 등록됨
  if (!eligible) return null;                                       //   eligibility=false → Task 안 만듦

  const hasSales = (Number(ebay_sales_90d) || 0) > 0 || (Number(shopify_sales_90d) || 0) > 0;
  const invValue = Number(inventory_value_krw) || 0;
  const age = Number(stock_age_days) || 0;
  const isCostMissing = (data_quality_flags || []).includes('COST_MISSING');
  const highConf = stock_age_confidence === 'high';
  const HV = Number(config.high_value_threshold_krw) || 500000;
  const OLD = Number(config.old_stock_days) || 60;
  const VOLD = Number(config.very_old_stock_days) || 90;

  //   P0 · 판매 검증 있고 아래 중 하나:
  //     · inventory_value_krw >= HIGH_VALUE_THRESHOLD (cost 필요)
  //     · aging >= OLD AND confidence != low
  //     · aging >= VERY_OLD AND inventory_value > 0 (proxy 여도 정말 오래된 것)
  if (hasSales && !isCostMissing) {
    const cond_value = invValue >= HV;
    const cond_age_conf = (age >= OLD) && highConf;
    const cond_age_veryold = (age >= VOLD) && (invValue > 0);
    if (cond_value || cond_age_conf || cond_age_veryold) return 'p0';
  }

  //   P1 · 판매 검증 있음 · P0 아님
  if (hasSales) return 'p1';

  //   P2 · 판매 검증 없음 · eligible · stock 있음 · channel NONE/ERROR
  //     (base condition 은 위에서 이미 통과)
  //   P3 · V1 에서는 P2 와 겹침 → 명시적 rule 로 분리:
  //     · P3 = 판매검증 없음 AND (stock_qty 낮음 OR cost missing OR title missing)
  //     · 즉 "관심도 낮음 + 데이터 부족" 인 상품
  const isLowConfidence =
    isCostMissing ||
    (data_quality_flags || []).includes('MISSING_PRODUCT_TITLE') ||
    Number(stock_qty) <= 1;
  if (isLowConfidence) return 'p3';
  return 'p2';
}

//   ── 9. Priority Score (0..100) · Owner 지정 비중 ──────────
function calculatePriorityScore(sub) {
  //   sub = { sales, inventory, gap, aging, margin }
  const total =
    (Number(sub.sales)     || 0) +   //   max 30
    (Number(sub.inventory) || 0) +   //   max 30
    (Number(sub.gap)       || 0) +   //   max 20
    (Number(sub.aging)     || 0) +   //   max 10 (low confidence 이면 3)
    (Number(sub.margin)    || 0);    //   max 10
  return Math.max(0, Math.min(100, Math.round(total * 100) / 100));
}

//   ── 10. Reasons (사람이 읽는 설명) ────────────────────────
function buildReasons({
  scorecard, channel, eligible, channel_status, priority_level,
  sub_scores, data_quality_flags, config,
}) {
  const r = [];
  if (!eligible) r.push(`${channel} eligibility=false · 자동 Task 대상 아님`);
  if (Number(scorecard.stock_qty) <= 0) r.push('현재고 0 · Task 대상 아님');
  const sales = (Number(scorecard.ebay_sales_90d) || 0) + (Number(scorecard.shopify_sales_90d) || 0);
  if (sales > 0) {
    r.push(`eBay ${scorecard.ebay_sales_90d || 0}건 · Shopify ${scorecard.shopify_sales_90d || 0}건 최근 90일 판매 (합 ${sales})`);
  } else if (Number(scorecard.stock_qty) > 0) {
    r.push('최근 90일 판매 검증 없음 (P2/P3)');
  }
  const inv = Number(scorecard.inventory_value_krw) || 0;
  if (inv >= (Number(config.high_value_threshold_krw) || 500000)) {
    r.push(`재고금액 ₩${Math.round(inv).toLocaleString('ko-KR')} · HIGH_VALUE threshold 이상`);
  } else if (inv > 0) {
    r.push(`재고금액 ₩${Math.round(inv).toLocaleString('ko-KR')}`);
  }
  //   Channel gap
  const missingLabel = channel === 'coupang' ? '쿠팡' : channel === 'naver' ? '네이버' : channel;
  if (channel_status === 'NONE') r.push(`${missingLabel} 미등록 (자동 Task 후보)`);
  else if (channel_status === 'ERROR') r.push(`${missingLabel} 상태=ERROR · 재등록 필요`);
  //   Aging
  const age = Number(scorecard.stock_age_days) || 0;
  if (age > 0) {
    if (scorecard.stock_age_source === 'sku_created_at') {
      r.push(`재고일수 ${age}일 (SKU 생성일 기반 proxy · low confidence)`);
    } else if (scorecard.stock_age_source === 'inventory_movement') {
      r.push(`재고일수 ${age}일 (실 receipt 기반)`);
    }
  }
  //   Data quality flags
  for (const f of (data_quality_flags || [])) {
    if (f === 'COST_MISSING') r.push('cost_krw 없음 · P0 승격 제외 · DATA_QUALITY 태스크 후보');
    if (f === 'STOCK_AGE_PROXY') { /* 이미 위에서 표현됨 */ }
    if (f === 'MISSING_PRODUCT_TITLE') r.push('제목 없음 · 데이터 보정 필요');
  }
  return r;
}

//   ── 11. evaluateSkuChannel — 단일 SKU × Channel 평가 ────
//   Input:
//     scorecard: v_sku_b2c_scorecard row · { sku_master_id, internal_sku, title, unit_cost,
//                stock_qty, inventory_value_krw, stock_age_days, stock_age_source,
//                sales_30d, sales_90d, ebay_sales_90d, shopify_sales_90d, live_channels,
//                registered_channels, observed_channels, missing_channels_seen, channel_eligibility }
//     channel: 'coupang' | 'naver' | '11st' | 'gmarket'
//     channelStatus: from v_sku_channel_matrix · 'NONE' | 'ERROR' | 'LIVE' | ...
//     allChannelStatuses: [{ channel, channel_status, eligible }] for gap calc
//     config: margin_settings b2c.* values
//     options: { defaultMode }
//   Output: full evaluation object (Owner spec §14 · reasons 포함)
function evaluateSkuChannel({ scorecard, channel, channelStatus, allChannelStatuses, config, options }) {
  const eligible = resolveEligibility(scorecard.channel_eligibility, channel, options.defaultMode);
  const data_quality_flags = computeDataQualityFlags(scorecard);

  //   sub-scores
  const sub = {
    sales:     calculateSalesValidationScore(scorecard.ebay_sales_90d, scorecard.shopify_sales_90d),
    inventory: calculateInventoryValueScore(scorecard.inventory_value_krw, scorecard.unit_cost),
    gap:       calculateChannelGapScore(allChannelStatuses),
    aging:     calculateAgingScore(scorecard.stock_age_days, scorecard.stock_age_source, config.old_stock_days, config.very_old_stock_days),
    margin:    calculateMarginScore(scorecard.unit_cost),
  };
  const priority_score = calculatePriorityScore(sub);

  const stock_age_confidence = (scorecard.stock_age_source === 'inventory_movement') ? 'high' : 'low';

  const priority_level = calculatePriorityLevel({
    stock_qty: scorecard.stock_qty,
    channel_status: channelStatus,
    eligible,
    ebay_sales_90d: scorecard.ebay_sales_90d,
    shopify_sales_90d: scorecard.shopify_sales_90d,
    inventory_value_krw: scorecard.inventory_value_krw,
    stock_age_days: scorecard.stock_age_days,
    stock_age_confidence,
    data_quality_flags,
    config,
  });

  const reasons = buildReasons({
    scorecard, channel, eligible, channel_status: channelStatus, priority_level,
    sub_scores: sub, data_quality_flags, config,
  });

  return {
    sku_master_id: scorecard.sku_master_id,
    internal_sku:  scorecard.internal_sku,
    title:         scorecard.title,
    channel,
    channel_status: channelStatus,
    eligible,

    stock_qty:            Number(scorecard.stock_qty) || 0,
    unit_cost:            scorecard.unit_cost,
    inventory_value_krw:  Number(scorecard.inventory_value_krw) || 0,
    stock_age_days:       scorecard.stock_age_days,
    stock_age_source:     scorecard.stock_age_source,
    stock_age_confidence,
    ebay_sales_90d:       Number(scorecard.ebay_sales_90d) || 0,
    shopify_sales_90d:    Number(scorecard.shopify_sales_90d) || 0,

    priority_level,
    priority_score,

    sales_validation_score:  sub.sales,
    inventory_value_score:   sub.inventory,
    channel_gap_score:       sub.gap,
    aging_score:             sub.aging,
    margin_score:            sub.margin,

    data_quality_flags,
    reasons,
  };
}

module.exports = {
  AUTO_TASK_CHANNELS,
  resolveEligibility,
  calculateSalesValidationScore,
  calculateInventoryValueScore,
  calculateChannelGapScore,
  calculateAgingScore,
  calculateMarginScore,
  computeDataQualityFlags,
  calculatePriorityLevel,
  calculatePriorityScore,
  buildReasons,
  evaluateSkuChannel,
};
