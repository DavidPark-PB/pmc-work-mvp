'use strict';

/**
 * engine1DryRunJob.js — Commerce OS v1 Engine 1 배선 (Dry-run)
 * ---------------------------------------------------------------------------
 * killPrice(경쟁최저 총액) + listingProfitabilityCalculator(랜딩코스트)
 * + product_matches.confidence → 추천가 + AUTO/REVIEW/BLOCK + price_events 발행.
 *
 * v1 MVP 범위 고정: 가격 엔진만. 광고·공급처·가지치기 없음.
 * ⚠️ 이 잡은 가격을 절대 변경하지 않는다 — PriceRecommendationCreated 이벤트만 발행.
 *    실제 적용은 Dry-run GO 기준(AUTO 정밀도 ≥98% 등) 충족 +
 *    pricing_guardrails.auto_apply_enabled=true 이후 별도 적용 경로에서.
 *
 * 데이터 소스:
 *   - product_matches (status='approved')      → Identity confidence
 *   - competitor_listings (live 조회 or 캐시)   → 경쟁 최저 총액 + 신선도
 *   - sku_master (cost_krw, weight, 치수)       → Landing Cost
 *   - repricing_rules (undercut, min_margin)    → 가격 규칙
 *   - pricing_guardrails                        → 안전장치
 *
 * 실행: node src/jobs/engine1DryRunJob.js
 */

const { getClient } = require('../db/supabaseClient');
const EbayAPI = require('../api/ebayAPI');
const engine = require('../engines/priceEngine');
const events = require('../services/priceEventService');
const { getShippingQuotes, ASSUMPTIONS } = require('../services/listingProfitabilityCalculator');

const CONFIG = {
  // 기본 false — CompetitorMonitor가 2h마다 갱신하는 competitor_listings 캐시 사용.
  // (신선도 임계 48h 대비 충분 + eBay Browse API 일일 쿼터 절약.
  //  true로 켜면 실행 시점 라이브가 조회 — 쿼터 소진 시 자동으로 캐시 폴백.)
  LIVE_LOOKUP: false,
  PUSH_TELEGRAM: true,
  CREATE_BLOCK_TASKS: true, // BLOCK → 직원 데이터 태스크 자동 생성
  MAX_SKUS: 2000,
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 승인된 매칭 로드 — our_sku별 [{competitor_item_id, seller_id, confidence}] */
async function loadApprovedMatches(db) {
  const { data, error } = await db.from('product_matches')
    .select('our_sku, our_item_id, competitor_item_id, seller_id, confidence')
    .eq('status', 'approved');
  if (error) throw new Error(`product_matches 로드 실패: ${error.message}`);
  const bySku = new Map();
  for (const m of data || []) {
    if (!bySku.has(m.our_sku)) bySku.set(m.our_sku, []);
    bySku.get(m.our_sku).push(m);
  }
  return bySku;
}

/** 경쟁 리스팅 캐시 (가격/배송/신선도) */
async function loadCompetitorListings(db, itemIds) {
  const out = new Map();
  for (let i = 0; i < itemIds.length; i += 500) {
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, status, last_seen')
      .in('ebay_item_id', itemIds.slice(i, i + 500));
    for (const l of data || []) out.set(String(l.ebay_item_id), l);
  }
  return out;
}

/** 직전 관측 경쟁 총액 (서킷브레이커용) */
async function loadPrevCompetitorTotals(db, itemIds) {
  const out = new Map();
  for (let i = 0; i < itemIds.length; i += 500) {
    const { data } = await db.from('competitor_price_history')
      .select('competitor_item_id, old_total, changed_at')
      .in('competitor_item_id', itemIds.slice(i, i + 500))
      .order('changed_at', { ascending: false });
    for (const h of data || []) {
      const k = String(h.competitor_item_id);
      if (!out.has(k)) out.set(k, Number(h.old_total) || null);
    }
  }
  return out;
}

/** sku_master에서 Landing Cost 입력 로드 */
async function loadSkuMaster(db, skus) {
  const out = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const { data } = await db.from('sku_master')
      .select('internal_sku, cost_krw, weight_gram, default_packaging_weight_g, width_cm, height_cm, length_cm, weight_status, automation_enabled')
      .in('internal_sku', skus.slice(i, i + 500));
    for (const s of data || []) out.set(s.internal_sku, s);
  }
  return out;
}

/** 내 현재 총액 */
async function loadMyPrices(db, skus) {
  const out = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const { data } = await db.from('ebay_products')
      .select('sku, item_id, price_usd, shipping_usd')
      .in('sku', skus.slice(i, i + 500));
    for (const m of data || []) {
      out.set(m.sku, {
        itemId: m.item_id,
        total: r2((Number(m.price_usd) || 0) + (Number(m.shipping_usd) || 0)),
      });
    }
  }
  return out;
}

/** SKU별 repricing_rules (sku 지정 룰 우선, 없으면 글로벌 룰) */
async function loadRules(db) {
  const { data } = await db.from('repricing_rules')
    .select('sku, undercut_amount, min_margin_pct, is_active')
    .eq('is_active', true);
  const bySku = new Map();
  let global = null;
  for (const rule of data || []) {
    if (rule.sku) bySku.set(rule.sku, rule);
    else global = rule;
  }
  return { bySku, global };
}

/** 국제배송비(KRW): 무게·치수 완전할 때만 최저 견적. 아니면 null → Incomplete. */
function intlShippingKrw(sm) {
  const weightG = (Number(sm.weight_gram) || 0) + (Number(sm.default_packaging_weight_g) || 0);
  if (!(weightG > 0) || sm.weight_status === 'unknown') return null;
  if (!(sm.length_cm > 0 && sm.width_cm > 0 && sm.height_cm > 0)) return null;
  const quotes = getShippingQuotes({
    weightKg: weightG / 1000,
    lengthCm: Number(sm.length_cm), widthCm: Number(sm.width_cm), heightCm: Number(sm.height_cm),
  });
  const best = quotes.find((q) => q.recommended) || quotes[0];
  return best ? best.total_krw : null;
}

async function runEngine1DryRun() {
  const started = Date.now();
  const db = getClient();

  console.log('[engine1] 시작 — guardrails/매칭 로드 중...');
  const guardrails = await events.getGuardrails();
  const matchesBySku = await loadApprovedMatches(db);
  const skus = [...matchesBySku.keys()].slice(0, CONFIG.MAX_SKUS);
  console.log(`[engine1] 승인된 매칭 SKU ${skus.length}개 — 데이터 로드 중...`);

  const allCompIds = [...new Set([].concat(...skus.map((s) => matchesBySku.get(s).map((m) => String(m.competitor_item_id)))))];
  const listingCache = await loadCompetitorListings(db, allCompIds);
  const prevTotals = await loadPrevCompetitorTotals(db, allCompIds);
  const skuMaster = await loadSkuMaster(db, skus);
  const myPrices = await loadMyPrices(db, skus);
  const rules = await loadRules(db);
  const todayDropMap = await events.getTodayDropPctMap(skus);
  console.log(`[engine1] 로드 완료 — 경쟁리스팅 ${listingCache.size} · sku_master ${skuMaster.size} · 내가격 ${myPrices.size} · 판정 시작`);

  // 라이브 조회 (실패해도 캐시로 폴백)
  let live = new Map();
  if (CONFIG.LIVE_LOOKUP) {
    try {
      const ebay = new EbayAPI();
      const arr = await ebay.getCompetitorItems(allCompIds);
      live = new Map(arr.map((l) => [String(l.itemId), l]));
    } catch (e) {
      console.warn('[engine1] 라이브 조회 실패 — 캐시가 사용:', e.message);
    }
  }

  const decisions = [];
  for (const sku of skus) {
    const matches = matchesBySku.get(sku);
    const my = myPrices.get(sku);
    const sm = skuMaster.get(sku);

    // 경쟁 최저 총액 (전 셀러 min) + 신선도 + 참조
    let best = null;
    for (const m of matches) {
      const id = String(m.competitor_item_id);
      const l = live.get(id);
      const c = listingCache.get(id);
      let total = null, ageHours = null;
      if (l && l.price > 0) { total = r2(l.price + (l.shippingCost || 0)); ageHours = 0; }
      else if (c && c.price > 0 && c.status === 'active') {
        total = r2(Number(c.price) + (Number(c.shipping) || 0));
        ageHours = c.last_seen ? (Date.now() - new Date(c.last_seen).getTime()) / 3.6e6 : null;
      }
      if (total != null && (best == null || total < best.total)) {
        best = { total, ageHours, seller_id: m.seller_id, competitor_item_id: id, identity: Number(m.confidence) };
      }
    }

    const landing = sm
      ? engine.computeLandingCost({
          costKrw: sm.cost_krw,
          intlShippingKrw: intlShippingKrw(sm),
          usdKrw: ASSUMPTIONS.usd_krw,
        })
      : { complete: false, missing: ['sku_master'], baseCostUsd: null };

    const rule = rules.bySku.get(sku) || rules.global || {};
    const todayDropPctUsed = todayDropMap.get(sku) || 0;

    const d = engine.decideSku({
      sku,
      itemId: my ? my.itemId : null,
      currentTotal: my ? my.total : 0,
      competitorTotal: best ? best.total : null,
      prevCompetitorTotal: best ? prevTotals.get(best.competitor_item_id) : null,
      identityConfidence: best ? best.identity : null,
      competitorAgeHours: best ? best.ageHours : null,
      landingCost: landing,
      supplierConfidence: null, // Engine 5 전까지 NULL → 1.0 취급
      todayDropPctUsed,
      rules: {
        undercut: Number(rule.undercut_amount) || undefined,
        minMarginPct: Number(rule.min_margin_pct) || undefined,
        ebayFeePct: ASSUMPTIONS.ebay_fee_pct,
      },
      guardrails,
    });
    d.current_total = my ? my.total : null;
    d.landing_cost_usd = landing.baseCostUsd;
    d.competitor_ref = best
      ? { seller_id: best.seller_id, competitor_item_id: best.competitor_item_id, competitor_total: best.total }
      : null;
    decisions.push(d);
  }

  // 이벤트 발행 (추천만 — 가격 변경 없음)
  console.log(`[engine1] 판정 완료 ${decisions.length}건 — price_events 기록 중...`);
  await events.publishRecommendations(decisions, { actor: 'system:engine1-dryrun' });

  // BLOCK → 직원 데이터 태스크
  const blocks = decisions.filter((d) => d.action === 'BLOCK');
  let blockTasks = 0;
  if (CONFIG.CREATE_BLOCK_TASKS && blocks.length) {
    blockTasks = await events.createBlockDataTasks(blocks);
  }

  // 요약
  const count = (a, rc) => decisions.filter((d) => d.action === a && (!rc || d.reason_code === rc)).length;
  const summary = {
    total: decisions.length,
    auto: count('AUTO'),
    review: count('REVIEW'),
    block: count('BLOCK'),
    coverage_pct: decisions.length ? r2(count('AUTO') / decisions.length * 100) : 0,
    block_breakdown: {
      landing_cost: count('BLOCK', 'BLOCK_LANDING_COST_UNKNOWN'),
      no_match: count('BLOCK', 'BLOCK_NO_MATCH'),
      stale: count('BLOCK', 'BLOCK_STALE_COMPETITOR'),
    },
    block_tasks_created: blockTasks,
    kill_switch: guardrails.kill_switch,
    ms: Date.now() - started,
  };
  console.log('[engine1] Dry-run 완료:', JSON.stringify(summary));

  if (CONFIG.PUSH_TELEGRAM) {
    try {
      const telegram = require('../services/telegramBot');
      await telegram.sendMessage([
        '🤖 *Engine 1 Dry-run* (가격 변경 없음 — 추천만)',
        `대상 ${summary.total} · 🟢AUTO ${summary.auto} (${summary.coverage_pct}%) · 🟡REVIEW ${summary.review} · 🔴BLOCK ${summary.block}`,
        `BLOCK 내역 — 랜딩코스트 ${summary.block_breakdown.landing_cost} · 매칭 ${summary.block_breakdown.no_match} · 신선도 ${summary.block_breakdown.stale}`,
        blockTasks ? `→ 직원 데이터 태스크 ${blockTasks}건 생성` : '',
      ].filter(Boolean).join('\n'));
    } catch (e) { console.warn('[engine1] 텔레그램 실패(무시):', e.message); }
  }
  return summary;
}

module.exports = { runEngine1DryRun, CONFIG };

if (require.main === module) {
  runEngine1DryRun().then(() => process.exit(0)).catch((e) => {
    console.error('[engine1] 실패:', e);
    process.exit(1);
  });
}
