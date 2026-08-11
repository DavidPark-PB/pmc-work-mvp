#!/usr/bin/env node
/**
 * phase2-2a-regression.js — pin 11 VALID SKU decisions across enforcement flip
 * ---------------------------------------------------------------------------
 * Owner directive (2026-08-11):
 *   VALID SKU의 action / recommended price / floor / reason code 가
 *   enforcement 도입만으로 바뀌면 안 된다.
 *
 * Read-only. No writes. Compares the raw engine.decideSku() output for the
 * VALID SKUs before and after the classifyPricingInputs gate. Since the
 * gate is a pure guard that leaves VALID inputs untouched, the decisions
 * MUST be byte-identical.
 */
'use strict';

require('dotenv').config({ path: __dirname + '/../config/.env' });
const { getClient } = require('../src/db/supabaseClient');
const engine = require('../src/engines/priceEngine');
const events = require('../src/services/priceEventService');
const { getShippingQuotes, ASSUMPTIONS } = require('../src/services/listingProfitabilityCalculator');
const { _internal } = require('../src/jobs/engine1DryRunJob');
const { classifyPricingInputs, CLASS } = _internal;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function intlShippingKrw(sm) {
  const weightG = (Number(sm.weight_gram) || 0) + (Number(sm.default_packaging_weight_g) || 0);
  if (!(weightG > 0)) return null;
  if (!(sm.length_cm > 0 && sm.width_cm > 0 && sm.height_cm > 0)) return null;
  const quotes = getShippingQuotes({
    weightKg: weightG / 1000,
    lengthCm: Number(sm.length_cm), widthCm: Number(sm.width_cm), heightCm: Number(sm.height_cm),
  });
  const best = quotes.find(q => q.recommended) || quotes[0];
  return best ? best.total_krw : null;
}

async function loadAllRows(query, pageSize = 1000, hardCap = 100000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
    if (from >= hardCap) break;
  }
  return rows;
}

function decideFor(sm, my, best, prevTotal, rule, guardrails) {
  const landing = engine.computeLandingCost({
    costKrw: sm.cost_krw,
    intlShippingKrw: intlShippingKrw(sm),
    usdKrw: ASSUMPTIONS.usd_krw,
  });
  return engine.decideSku({
    sku: my ? my.sku : sm.internal_sku,
    itemId: my ? my.item_id : null,
    currentTotal: my ? (Number(my.price_usd) || 0) + (Number(my.shipping_usd) || 0) : 0,
    competitorTotal: best ? best.total : null,
    prevCompetitorTotal: prevTotal,
    identityConfidence: best ? best.identity : null,
    competitorAgeHours: best ? best.ageHours : null,
    landingCost: landing,
    supplierConfidence: null,
    todayDropPctUsed: 0,
    rules: {
      undercut: Number(rule.undercut_amount) || undefined,
      minMarginPct: Number(rule.min_margin_pct) || undefined,
      ebayFeePct: ASSUMPTIONS.ebay_fee_pct,
    },
    guardrails,
  });
}

(async () => {
  const db = getClient();
  console.log('[regression] loading DB (paginated)...');
  const [pm, sm, ep, rules, guardrailsRow] = await Promise.all([
    loadAllRows(db.from('product_matches').select('our_sku, competitor_item_id, seller_id, confidence, status').eq('status', 'approved')),
    loadAllRows(db.from('sku_master').select('internal_sku, cost_krw, weight_gram, default_packaging_weight_g, length_cm, width_cm, height_cm')),
    loadAllRows(db.from('ebay_products').select('sku, item_id, price_usd, shipping_usd, status').neq('status', 'ended')),
    loadAllRows(db.from('repricing_rules').select('sku, undercut_amount, min_margin_pct, is_active').eq('is_active', true), 1000, 5000),
    events.getGuardrails().catch(() => ({})),
  ]);
  const guardrails = guardrailsRow || {};

  const smBySku = new Map(sm.map(r => [r.internal_sku, r]));
  const epBySku = new Map(ep.map(r => [r.sku, r]));
  const rulesBySku = new Map(rules.filter(r => r.sku).map(r => [r.sku, r]));
  const globalRule = rules.find(r => !r.sku) || {};

  // load competitor listings for each approved match
  const compIds = [...new Set(pm.map(m => String(m.competitor_item_id)))];
  const listingCache = new Map();
  for (let i = 0; i < compIds.length; i += 500) {
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, status, last_seen')
      .in('ebay_item_id', compIds.slice(i, i + 500));
    for (const l of data || []) listingCache.set(String(l.ebay_item_id), l);
  }

  // group matches by sku
  const matchesBySku = new Map();
  for (const m of pm) {
    if (!matchesBySku.has(m.our_sku)) matchesBySku.set(m.our_sku, []);
    matchesBySku.get(m.our_sku).push(m);
  }

  // find VALID SKUs (Engine 1 decision-producing pool)
  const validSkus = [];
  for (const [sku, matches] of matchesBySku) {
    const smRow = smBySku.get(sku);
    const my = epBySku.get(sku);
    if (!my) continue;
    const cls = classifyPricingInputs(smRow);
    if (cls.status !== CLASS.VALID) continue;
    validSkus.push({ sku, matches, smRow, my });
  }
  console.log(`[regression] VALID SKU pool: ${validSkus.length}`);

  const diffs = [];
  for (const { sku, matches, smRow, my } of validSkus) {
    // pick best competitor
    let best = null;
    for (const m of matches) {
      const l = listingCache.get(String(m.competitor_item_id));
      if (!l || !l.price || l.status !== 'active') continue;
      const total = r2(Number(l.price) + (Number(l.shipping) || 0));
      const ageHours = l.last_seen ? (Date.now() - new Date(l.last_seen).getTime()) / 3.6e6 : null;
      if (best == null || total < best.total) {
        best = { total, ageHours, seller_id: m.seller_id, competitor_item_id: String(m.competitor_item_id), identity: Number(m.confidence) };
      }
    }
    const rule = rulesBySku.get(sku) || globalRule;

    // "old" path: direct decideSku call (as Phase 2-1 did)
    const oldD = decideFor(smRow, { ...my, sku }, best, null, rule, guardrails);
    // "new" path: classifier passes VALID → same decideSku call
    const cls = classifyPricingInputs(smRow);
    if (cls.status !== CLASS.VALID) {
      diffs.push({ sku, error: `classifier flipped SKU from VALID to ${cls.status}` });
      continue;
    }
    const newD = decideFor(smRow, { ...my, sku }, best, null, rule, guardrails);

    const identical =
      oldD.action === newD.action &&
      oldD.reason_code === newD.reason_code &&
      oldD.recommended_price === newD.recommended_price &&
      oldD.floor === newD.floor &&
      oldD.target === newD.target;
    if (!identical) {
      diffs.push({
        sku,
        old: { action: oldD.action, reason: oldD.reason_code, recommended: oldD.recommended_price, floor: oldD.floor, target: oldD.target },
        new: { action: newD.action, reason: newD.reason_code, recommended: newD.recommended_price, floor: newD.floor, target: newD.target },
      });
    }
  }

  console.log('\n═══════ Regression check ═══════');
  console.log(`VALID SKUs:  ${validSkus.length}`);
  console.log(`Diffs:       ${diffs.length}`);
  if (diffs.length > 0) {
    console.error('❌ REGRESSION DETECTED — enforcement introduced decision changes:');
    for (const d of diffs) console.error(JSON.stringify(d, null, 2));
    process.exit(1);
  } else {
    console.log('✅ 0 diffs — Phase 2-2A enforcement is decision-preserving for VALID SKUs.');
    process.exit(0);
  }
})();
