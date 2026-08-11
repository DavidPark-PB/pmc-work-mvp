#!/usr/bin/env node
/**
 * phase2-2c-impact.js — read-only impact analysis for the 1450 → 1300
 * Engine 1 usdKrw switch.
 *
 * Owner directive (2026-08-11):
 *   "숫자 변화는 정상일 수 있다. 다만 11 SKU 기준 old/new diff 보고."
 *
 * Zero writes. Zero marketplace API. Runs the same decideSku() pipeline
 * twice per VALID SKU and prints the delta.
 */
'use strict';

require('dotenv').config({ path: __dirname + '/../config/.env' });
const { getClient } = require('../src/db/supabaseClient');
const engine = require('../src/engines/priceEngine');
const events = require('../src/services/priceEventService');
const { getShippingQuotes, ASSUMPTIONS } = require('../src/services/listingProfitabilityCalculator');
const { _internal } = require('../src/jobs/engine1DryRunJob');
const { classifyPricingInputs, CLASS } = _internal;

const OLD_RATE = 1450;   // listingProfitabilityCalculator ASSUMPTIONS.usd_krw before Phase 2-2C
const NEW_RATE = 1300;   // margin_settings.exchange_rate_usd after Phase 2-1 owner UPDATE

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

function decide(rate, sm, my, best, prevTotal, rule, guardrails) {
  const landing = engine.computeLandingCost({
    costKrw: sm.cost_krw,
    intlShippingKrw: intlShippingKrw(sm),
    usdKrw: rate,
  });
  return engine.decideSku({
    sku: my.sku, itemId: my.item_id,
    currentTotal: (Number(my.price_usd) || 0) + (Number(my.shipping_usd) || 0),
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
  console.log(`[impact] 1450 → 1300 (${((1450 - 1300) / 1450 * 100).toFixed(2)}% lower)`);
  console.log('[impact] loading...');
  const [pm, sm, ep, rules, guardrails] = await Promise.all([
    loadAllRows(db.from('product_matches').select('our_sku, competitor_item_id, seller_id, confidence, status').eq('status', 'approved')),
    loadAllRows(db.from('sku_master').select('internal_sku, cost_krw, weight_gram, default_packaging_weight_g, length_cm, width_cm, height_cm')),
    loadAllRows(db.from('ebay_products').select('sku, item_id, price_usd, shipping_usd, status').neq('status', 'ended')),
    loadAllRows(db.from('repricing_rules').select('sku, undercut_amount, min_margin_pct, is_active').eq('is_active', true), 1000, 5000),
    events.getGuardrails().catch(() => ({})),
  ]);

  const smBySku = new Map(sm.map(r => [r.internal_sku, r]));
  const epBySku = new Map(ep.map(r => [r.sku, r]));
  const rulesBySku = new Map(rules.filter(r => r.sku).map(r => [r.sku, r]));
  const globalRule = rules.find(r => !r.sku) || {};

  const compIds = [...new Set(pm.map(m => String(m.competitor_item_id)))];
  const listingCache = new Map();
  for (let i = 0; i < compIds.length; i += 500) {
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, status, last_seen')
      .in('ebay_item_id', compIds.slice(i, i + 500));
    for (const l of data || []) listingCache.set(String(l.ebay_item_id), l);
  }

  const matchesBySku = new Map();
  for (const m of pm) {
    if (!matchesBySku.has(m.our_sku)) matchesBySku.set(m.our_sku, []);
    matchesBySku.get(m.our_sku).push(m);
  }

  const validSkus = [];
  for (const [sku, matches] of matchesBySku) {
    const smRow = smBySku.get(sku);
    const my = epBySku.get(sku);
    if (!my) continue;
    const cls = classifyPricingInputs(smRow);
    if (cls.status !== CLASS.VALID) continue;
    validSkus.push({ sku, matches, smRow, my });
  }

  console.log(`[impact] VALID SKU pool: ${validSkus.length}`);
  console.log('');

  const rows = [];
  const stats = {
    action_changed: 0, price_changed: 0, floor_changed: 0,
    price_delta_sum: 0, price_delta_max: 0, price_delta_min: 0,
    old_actions: {}, new_actions: {},
    became_competitor_below_cost: 0,
    became_floor_binds: 0,
  };

  for (const { sku, matches, smRow, my } of validSkus) {
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

    const oldD = decide(OLD_RATE, smRow, { ...my, sku }, best, null, rule, guardrails);
    const newD = decide(NEW_RATE, smRow, { ...my, sku }, best, null, rule, guardrails);

    stats.old_actions[`${oldD.action}:${oldD.reason_code}`] = (stats.old_actions[`${oldD.action}:${oldD.reason_code}`] || 0) + 1;
    stats.new_actions[`${newD.action}:${newD.reason_code}`] = (stats.new_actions[`${newD.action}:${newD.reason_code}`] || 0) + 1;
    if (oldD.action !== newD.action || oldD.reason_code !== newD.reason_code) stats.action_changed += 1;
    if (oldD.floor !== newD.floor) stats.floor_changed += 1;
    if (oldD.reason_code !== 'REVIEW_COMPETITOR_BELOW_COST' && newD.reason_code === 'REVIEW_COMPETITOR_BELOW_COST') stats.became_competitor_below_cost += 1;
    if (oldD.reason_code !== 'REVIEW_FLOOR_BINDS' && newD.reason_code === 'REVIEW_FLOOR_BINDS') stats.became_floor_binds += 1;

    const p1 = oldD.recommended_price, p2 = newD.recommended_price;
    if (p1 != null && p2 != null && Math.abs(p1 - p2) > 0.005) {
      stats.price_changed += 1;
      const d = p2 - p1;
      stats.price_delta_sum += d;
      if (d > stats.price_delta_max) stats.price_delta_max = d;
      if (d < stats.price_delta_min) stats.price_delta_min = d;
    }

    rows.push({
      sku,
      cost_krw: smRow.cost_krw,
      current_price_usd: my.price_usd,
      competitor_total: best ? best.total : null,
      old: { action: oldD.action, reason: oldD.reason_code, floor: oldD.floor, target: oldD.target, recommended: oldD.recommended_price },
      new: { action: newD.action, reason: newD.reason_code, floor: newD.floor, target: newD.target, recommended: newD.recommended_price },
      floor_delta: oldD.floor != null && newD.floor != null ? +(newD.floor - oldD.floor).toFixed(2) : null,
      price_delta: oldD.recommended_price != null && newD.recommended_price != null ? +(newD.recommended_price - oldD.recommended_price).toFixed(2) : null,
    });
  }

  const avgDelta = stats.price_changed > 0 ? stats.price_delta_sum / stats.price_changed : 0;

  console.log('═══════ Impact summary (1450 → 1300) ═══════');
  console.log(`VALID SKUs analysed:                 ${validSkus.length}`);
  console.log(`Action changed:                      ${stats.action_changed}`);
  console.log(`Recommended price changed:           ${stats.price_changed}`);
  console.log(`  avg delta:  ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(2)} USD`);
  console.log(`  max delta:  +${stats.price_delta_max.toFixed(2)} USD`);
  console.log(`  min delta:  ${stats.price_delta_min.toFixed(2)} USD`);
  console.log(`Floor changed:                       ${stats.floor_changed}`);
  console.log(`Became REVIEW_COMPETITOR_BELOW_COST: ${stats.became_competitor_below_cost}`);
  console.log(`Became REVIEW_FLOOR_BINDS:           ${stats.became_floor_binds}`);
  console.log('OLD action distribution:', stats.old_actions);
  console.log('NEW action distribution:', stats.new_actions);
  console.log('');
  console.log('Per-SKU:');
  rows.forEach((r, i) => {
    console.log(`  ${i+1}. ${r.sku}  cost=₩${r.cost_krw}  comp=$${r.competitor_total}  floor:${r.old.floor}→${r.new.floor} (${r.floor_delta >= 0 ? '+' : ''}${r.floor_delta})  rec:${r.old.recommended}→${r.new.recommended} (${r.price_delta})  ${r.old.reason} → ${r.new.reason}`);
  });
})();
