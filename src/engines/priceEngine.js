'use strict';

/**
 * priceEngine.js — Commerce OS v1 Engine 1 (Price) 판정 엔진
 * ---------------------------------------------------------------------------
 * 원칙: Data → Confidence → Permission → Automation
 * 엔진은 가격을 "결정"하지 않는다. SKU별 권한(AUTO/REVIEW/BLOCK)을 판정하고
 * 근거(reason_code + confidence_snapshot)를 남긴다.
 *
 * 이 모듈은 순수 함수만 포함한다 — DB/네트워크/텔레그램 호출 없음 (테스트 용이).
 * I/O 배선은 src/jobs/engine1DryRunJob.js, 이벤트 발행은 src/services/priceEventService.js.
 *
 * Data Contract v1 준수:
 *   게이팅(안전 판정) = min(축들) — 최약 링크가 지배.
 *   정렬(Review Queue) = 가중 점수 — 급한 것부터.
 *   Overall ≥ 0.95 AUTO / 0.80~0.94 REVIEW / < 0.80 BLOCK.
 *   recommended_price = max(경쟁최저총액 − UNDERCUT, landing_cost 기반 floor).
 */

const RULE_VERSION = 'engine1-v1.0.0';

const ACTION = Object.freeze({ AUTO: 'AUTO', REVIEW: 'REVIEW', BLOCK: 'BLOCK' });

/** Reason Codes — enum, 자유텍스트 금지. AUTO도 reason 필수(KPI 집계). */
const REASON = Object.freeze({
  // AUTO — 어떤 근거로 자동인지
  AUTO_UNDERCUT_SAFE: 'AUTO_UNDERCUT_SAFE',
  AUTO_MATCH_CONFIRMED: 'AUTO_MATCH_CONFIRMED',
  AUTO_PRICE_MAINTAINED: 'AUTO_PRICE_MAINTAINED',
  // REVIEW — 사람 승인
  REVIEW_LOW_CONFIDENCE: 'REVIEW_LOW_CONFIDENCE',
  REVIEW_FLOOR_BINDS: 'REVIEW_FLOOR_BINDS',
  REVIEW_COMPETITOR_BELOW_COST: 'REVIEW_COMPETITOR_BELOW_COST',
  REVIEW_MAX_DROP_EXCEEDED: 'REVIEW_MAX_DROP_EXCEEDED',
  REVIEW_PRICE_ANOMALY: 'REVIEW_PRICE_ANOMALY',
  // BLOCK — 가격 문제가 아니라 데이터 태스크
  BLOCK_LANDING_COST_UNKNOWN: 'BLOCK_LANDING_COST_UNKNOWN',
  BLOCK_NO_MATCH: 'BLOCK_NO_MATCH',
  BLOCK_MAP: 'BLOCK_MAP',
  BLOCK_API_ERROR: 'BLOCK_API_ERROR',
  BLOCK_STALE_COMPETITOR: 'BLOCK_STALE_COMPETITOR',
});

/** BLOCK reason → 직원 데이터 태스크 타입 (exceptionTask.js 라우팅) */
const BLOCK_TASK_TYPE = Object.freeze({
  BLOCK_LANDING_COST_UNKNOWN: 'LANDING_COST_DATA_MISSING', // weight_gram/치수/cost_krw 보완
  BLOCK_NO_MATCH: 'SKU_MATCH_FAILED',                      // 매핑 확인/등록 (기존 타입 재사용)
  BLOCK_MAP: 'MAP_POLICY_CHECK',                           // MAP 정책 등록/해제
  BLOCK_STALE_COMPETITOR: 'COMPETITOR_DATA_STALE',         // 크롤 재수집
  BLOCK_API_ERROR: 'AUTOMATION_FAILED',                    // 기존 타입 재사용
});

const DEFAULTS = Object.freeze({
  UNDERCUT_USD: 1.0,          // repricing_rules.undercut_amount 없을 때
  MIN_MARGIN_PCT: 15,         // repricing_rules.min_margin_pct 없을 때
  AUTO_THRESHOLD: 0.95,
  REVIEW_THRESHOLD: 0.80,
  FRESH_HOURS: 48,
  ANOMALY_DROP_PCT: 30,
  DAILY_MAX_DROP_PCT: 15,
  // 정렬용 가중치 (게이팅에는 사용 안 함 — 게이팅은 min)
  SORT_WEIGHTS: { identity: 0.4, price: 0.25, cost: 0.25, supplier: 0.10 },
});

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ─────────────────────────── Confidence Model ─────────────────────────── */

/**
 * 4축 신뢰도 산출.
 * @param {object} p
 * @param {number|null} p.identityConfidence  product_matches.confidence (0~1). null = 매칭 없음
 * @param {number|null} p.competitorAgeHours  경쟁가 마지막 확인 후 경과 시간
 * @param {boolean}     p.anomalySuspect      경쟁가 급락 의심 (서킷브레이커 감지)
 * @param {object}      p.landingCost         computeLandingCost() 결과
 * @param {number|null} p.supplierConfidence  Engine 5 전까지 null → 1.0 취급
 * @param {object}      [p.thresholds]
 * @returns {{identity:number, price:number, cost:number, supplier:number, overall:number, sortScore:number}}
 */
function computeConfidence(p) {
  const t = { FRESH_HOURS: DEFAULTS.FRESH_HOURS, ...(p.thresholds || {}) };

  const identity = p.identityConfidence == null ? 0 : Math.max(0, Math.min(1, Number(p.identityConfidence)));

  // Price 축: 신선도 + 이상가격. 신선도 임계 내 1.0, 초과 시 감쇠, 2배 초과 0.
  let price = 1.0;
  if (p.competitorAgeHours == null) price = 0;
  else if (p.competitorAgeHours > t.FRESH_HOURS * 2) price = 0;
  else if (p.competitorAgeHours > t.FRESH_HOURS) price = 0.5;
  if (p.anomalySuspect) price = Math.min(price, 0.5);

  // Cost 축: Landing Cost Complete 여부가 지배.
  const cost = p.landingCost && p.landingCost.complete ? 1.0 : 0;

  // Supplier 축: Engine 5 활성 전까지 NULL → 1.0 취급 (계약 명시).
  const supplier = p.supplierConfidence == null ? 1.0 : Math.max(0, Math.min(1, Number(p.supplierConfidence)));

  const axes = { identity, price, cost, supplier };
  const overall = Math.min(identity, price, cost, supplier); // 게이팅 = min. 최약 링크가 지배.

  const w = DEFAULTS.SORT_WEIGHTS;
  const sortScore = r2(identity * w.identity + price * w.price + cost * w.cost + supplier * w.supplier);

  return { ...axes, overall, sortScore };
}

/* ─────────────────────────── Landing Cost ─────────────────────────── */

/**
 * Landing Cost Complete 판정 + USD 환산.
 * Complete = 도매원가 + 국제배송(무게·부피 존재) + 국내배송 + eBay fee 전부 산출 가능.
 * @param {object} p
 * @param {number|null} p.costKrw            sku_master.cost_krw
 * @param {number|null} p.intlShippingKrw    getShippingQuotes() 최저가 total_krw (무게·치수 없으면 null)
 * @param {number}      [p.domesticShippingKrw=0]
 * @param {number}      [p.usdKrw=1450]
 * @returns {{complete:boolean, missing:string[], baseCostUsd:number|null}}
 *   baseCostUsd = (원가+국제배송+국내배송)/환율 — fee는 가격 비례라 floor 산식에서 처리.
 */
function computeLandingCost(p) {
  const missing = [];
  if (!(Number(p.costKrw) > 0)) missing.push('cost_krw');
  if (!(Number(p.intlShippingKrw) > 0)) missing.push('intl_shipping'); // weight_gram/치수 부재 포함
  const complete = missing.length === 0;
  if (!complete) return { complete, missing, baseCostUsd: null };
  const usdKrw = Number(p.usdKrw) > 0 ? Number(p.usdKrw) : 1450;
  const totalKrw = Number(p.costKrw) + Number(p.intlShippingKrw) + (Number(p.domesticShippingKrw) || 0);
  return { complete, missing, baseCostUsd: r2(totalKrw / usdKrw) };
}

/**
 * floor 총액(USD): 이 총액 밑으로 팔면 min_margin 미달.
 * price*(1 - fee - margin) = baseCost → floor = baseCost / (1 - fee - margin)
 */
function computeFloor({ baseCostUsd, ebayFeePct = 0.18, minMarginPct = DEFAULTS.MIN_MARGIN_PCT }) {
  const denom = 1 - ebayFeePct - minMarginPct / 100;
  if (denom <= 0) return Infinity;
  return r2(baseCostUsd / denom);
}

/* ─────────────────────────── 판정 (핵심) ─────────────────────────── */

/**
 * Engine 1 단일 SKU 판정.
 * 모든 가격은 "총액"(상품가+배송비, USD) 기준.
 *
 * @param {object} input
 * @param {string}      input.sku
 * @param {string}      input.itemId
 * @param {number}      input.currentTotal        내 현재 총액
 * @param {number|null} input.competitorTotal     경쟁 최저 총액 (전 셀러 min)
 * @param {number|null} input.prevCompetitorTotal 직전 관측 경쟁 총액 (서킷브레이커용)
 * @param {number|null} input.identityConfidence
 * @param {number|null} input.competitorAgeHours
 * @param {object}      input.landingCost         computeLandingCost() 결과
 * @param {number|null} [input.supplierConfidence]
 * @param {boolean}     [input.isMapRestricted]
 * @param {boolean}     [input.apiError]
 * @param {number}      [input.todayDropPctUsed]  오늘 이미 인하한 누적 %(일일 캡 검사)
 * @param {object}      [input.rules]             { undercut, minMarginPct, ebayFeePct }
 * @param {object}      [input.guardrails]        pricing_guardrails 행
 * @returns {{sku, item_id, recommended_price, action, reason_code, confidence_snapshot, rule_version, floor, target}}
 */
function decideSku(input) {
  const g = {
    auto_threshold: DEFAULTS.AUTO_THRESHOLD,
    review_threshold: DEFAULTS.REVIEW_THRESHOLD,
    competitor_fresh_hours: DEFAULTS.FRESH_HOURS,
    anomaly_drop_pct: DEFAULTS.ANOMALY_DROP_PCT,
    daily_max_drop_pct: DEFAULTS.DAILY_MAX_DROP_PCT,
    kill_switch: false,
    ...(input.guardrails || {}),
  };
  const rules = {
    undercut: DEFAULTS.UNDERCUT_USD,
    minMarginPct: DEFAULTS.MIN_MARGIN_PCT,
    ebayFeePct: 0.18,
    ...(input.rules || {}),
  };

  // 서킷브레이커: 경쟁가 직전 대비 급락 → 이상가격 의심
  const anomalySuspect = !!(
    input.prevCompetitorTotal > 0 && input.competitorTotal > 0 &&
    (input.prevCompetitorTotal - input.competitorTotal) / input.prevCompetitorTotal * 100 >= g.anomaly_drop_pct
  );

  const conf = computeConfidence({
    identityConfidence: input.identityConfidence,
    competitorAgeHours: input.competitorAgeHours,
    anomalySuspect,
    landingCost: input.landingCost,
    supplierConfidence: input.supplierConfidence,
    thresholds: { FRESH_HOURS: g.competitor_fresh_hours },
  });

  const base = {
    sku: input.sku,
    item_id: input.itemId,
    confidence_snapshot: {
      identity: conf.identity, price: conf.price, cost: conf.cost,
      supplier: conf.supplier, overall: conf.overall, sort_score: conf.sortScore,
    },
    rule_version: RULE_VERSION,
    recommended_price: null,
    floor: null,
    target: null,
  };
  const out = (action, reason_code, extra = {}) => ({ ...base, ...extra, action, reason_code });

  /* ── BLOCK 판정 (데이터 부재 — 추천 자체가 불가·위험) ── */
  if (input.apiError) return out(ACTION.BLOCK, REASON.BLOCK_API_ERROR);
  if (input.isMapRestricted) return out(ACTION.BLOCK, REASON.BLOCK_MAP);
  if (input.identityConfidence == null || !(input.competitorTotal > 0)) {
    return out(ACTION.BLOCK, REASON.BLOCK_NO_MATCH);
  }
  if (!input.landingCost || !input.landingCost.complete) {
    return out(ACTION.BLOCK, REASON.BLOCK_LANDING_COST_UNKNOWN, {
      missing_data: input.landingCost ? input.landingCost.missing : ['landing_cost'],
    });
  }
  if (input.competitorAgeHours == null || input.competitorAgeHours > g.competitor_fresh_hours) {
    return out(ACTION.BLOCK, REASON.BLOCK_STALE_COMPETITOR);
  }
  // 축 min < 0.80 — 데이터 신뢰 부족 → BLOCK.
  // 단, anomaly(서킷브레이커)로만 낮아진 경우는 계약대로 REVIEW_PRICE_ANOMALY로 보낸다.
  const overallExAnomaly = Math.min(conf.identity, conf.cost, conf.supplier,
    anomalySuspect ? 1 : conf.price);
  if (overallExAnomaly < g.review_threshold) {
    return out(ACTION.BLOCK, REASON.BLOCK_NO_MATCH);
  }

  /* ── 가격 산출 (v1 규칙) ── */
  const target = r2(input.competitorTotal - rules.undercut);        // 1등 시도
  const floor = computeFloor({
    baseCostUsd: input.landingCost.baseCostUsd,
    ebayFeePct: rules.ebayFeePct,
    minMarginPct: rules.minMarginPct,
  });
  const recommended = r2(Math.max(target, floor));                  // 단 손해 금지
  const priced = { recommended_price: recommended, floor, target };

  /* ── REVIEW 판정 (추천은 있으나 사람 승인 필요) ── */
  if (anomalySuspect) return out(ACTION.REVIEW, REASON.REVIEW_PRICE_ANOMALY, priced);
  if (input.competitorTotal < input.landingCost.baseCostUsd) {
    // 네이버 프로모/오소싱 의심 — 경쟁 총액이 내 원가보다 낮음
    return out(ACTION.REVIEW, REASON.REVIEW_COMPETITOR_BELOW_COST, priced);
  }
  if (conf.overall < g.auto_threshold) {
    return out(ACTION.REVIEW, REASON.REVIEW_LOW_CONFIDENCE, priced);
  }
  if (floor > target) {
    // 최저가로 못 가는데 이익은 남음 → 사람이 전략 판단
    return out(ACTION.REVIEW, REASON.REVIEW_FLOOR_BINDS, priced);
  }
  const dropPct = input.currentTotal > 0
    ? (input.currentTotal - recommended) / input.currentTotal * 100 : 0;
  const usedPct = Number(input.todayDropPctUsed) || 0;
  if (dropPct > 0 && usedPct + dropPct > g.daily_max_drop_pct) {
    return out(ACTION.REVIEW, REASON.REVIEW_MAX_DROP_EXCEEDED, priced);
  }

  /* ── AUTO 판정 ── */
  if (Math.abs(recommended - input.currentTotal) < 0.01) {
    return out(ACTION.AUTO, REASON.AUTO_PRICE_MAINTAINED, priced); // 이미 최저·적정
  }
  return out(ACTION.AUTO, REASON.AUTO_UNDERCUT_SAFE, priced);
}

/**
 * AUTO 실행 가능 여부 최종 게이트 (적용 직전 호출).
 * kill_switch / auto_apply_enabled / 일일 자동변경 비율 상한.
 */
function canAutoApply({ guardrails, autoAppliedToday, catalogSize }) {
  const g = guardrails || {};
  if (g.kill_switch) return { ok: false, why: 'kill_switch' };
  if (!g.auto_apply_enabled) return { ok: false, why: 'auto_apply_disabled(dry-run)' };
  const cap = Number(g.daily_auto_ratio_cap_pct) || 20;
  if (catalogSize > 0 && (autoAppliedToday / catalogSize) * 100 >= cap) {
    return { ok: false, why: 'daily_auto_ratio_cap' };
  }
  return { ok: true, why: null };
}

module.exports = {
  RULE_VERSION, ACTION, REASON, BLOCK_TASK_TYPE, DEFAULTS,
  computeConfidence, computeLandingCost, computeFloor, decideSku, canAutoApply,
};
