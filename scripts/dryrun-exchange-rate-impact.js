#!/usr/bin/env node
/**
 * dryrun-exchange-rate-impact.js — Phase 2-1 dry-run
 * ---------------------------------------------------------------------------
 * Simulate the impact of changing margin_settings.exchange_rate_usd from
 * its current value to a candidate (default 1300) on Engine 1's per-SKU
 * decision. Reads production data read-only. Does NOT modify any DB row
 * and does NOT call any marketplace API. Emits a diff report.
 *
 * Usage:
 *   node scripts/dryrun-exchange-rate-impact.js               (default: 1400 → 1300, 200 SKUs)
 *   node scripts/dryrun-exchange-rate-impact.js --new=1350 --limit=500
 *   node scripts/dryrun-exchange-rate-impact.js --old=1400 --new=1300 --limit=1000
 *
 * Output: JSON-lines to logs/dryrun-exchange-rate-<timestamp>.jsonl
 *         + summary to stdout.
 */
'use strict';

require('dotenv').config({ path: __dirname + '/../config/.env' });
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function argVal(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

const OLD_RATE = Number(argVal('old', 1400));
const NEW_RATE = Number(argVal('new', 1300));
const LIMIT = Number(argVal('limit', 200));

if (!Number.isFinite(OLD_RATE) || !Number.isFinite(NEW_RATE) || OLD_RATE <= 0 || NEW_RATE <= 0) {
  console.error('bad --old / --new value');
  process.exit(1);
}

const engine = require('../src/engines/priceEngine');
const { getShippingQuotes, ASSUMPTIONS } = require('../src/services/listingProfitabilityCalculator');
const { getClient } = require('../src/db/supabaseClient');

// ── Data loaders (read-only, mirror of engine1DryRunJob logic) ─────────────

async function loadData() {
  const db = getClient();
  const [pm, sm, ep, rules, guardrailsRow] = await Promise.all([
    db.from('product_matches')
      .select('our_sku, competitor_item_id, seller_id, confidence')
      .eq('status', 'approved')
      .limit(20000)
      .then(r => r.data || []),
    db.from('sku_master')
      .select('internal_sku, cost_krw, weight_gram, default_packaging_weight_g, length_cm, width_cm, height_cm')
      .not('cost_krw', 'is', null)
      .limit(20000)
      .then(r => r.data || []),
    db.from('ebay_products')
      .select('sku, item_id, price_usd, shipping_usd, updated_at')
      .neq('status', 'ended')
      .limit(20000)
      .then(r => r.data || []),
    db.from('repricing_rules')
      .select('sku, undercut_amount, min_margin_pct, is_active')
      .eq('is_active', true)
      .limit(5000)
      .then(r => r.data || []),
    db.from('pricing_guardrails').select('*').eq('id', 1).maybeSingle()
      .then(r => r.data || {}),
  ]);
  return { pm, sm, ep, rules, guardrails: guardrailsRow };
}

// ── Helper: compute landing cost at a specific rate ─────────────────────────

function intlShippingKrwFor(sm) {
  const weight = (sm.weight_gram || 0) + (sm.default_packaging_weight_g || 0);
  if (!(weight > 0)) return null;
  const quotes = getShippingQuotes({
    weightKg: weight / 1000,
    lengthCm: sm.length_cm || 0,
    widthCm: sm.width_cm || 0,
    heightCm: sm.height_cm || 0,
  });
  if (!quotes || quotes.length === 0) return null;
  return quotes[0].total_krw;
}

function decideAt(rate, sm, my, competitorTotal, prevCompetitorTotal, identity, ageHours, todayDropPctUsed, rules, guardrails) {
  const landing = sm && sm.cost_krw != null
    ? engine.computeLandingCost({
        costKrw: sm.cost_krw,
        intlShippingKrw: intlShippingKrwFor(sm),
        usdKrw: rate,           // ← the variable under test
      })
    : { complete: false, missing: ['sku_master'], baseCostUsd: null };
  const rule = rules || {};
  return engine.decideSku({
    sku: my ? my.sku : (sm ? sm.internal_sku : '(unknown)'),
    itemId: my ? my.item_id : null,
    currentTotal: my ? (Number(my.price_usd) || 0) + (Number(my.shipping_usd) || 0) : 0,
    competitorTotal,
    prevCompetitorTotal,
    identityConfidence: identity,
    competitorAgeHours: ageHours,
    landingCost: landing,
    supplierConfidence: null,
    todayDropPctUsed,
    rules: {
      undercut: Number(rule.undercut_amount) || undefined,
      minMarginPct: Number(rule.min_margin_pct) || undefined,
      ebayFeePct: ASSUMPTIONS.ebay_fee_pct,
    },
    guardrails,
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[dryrun] Loading data (limit=${LIMIT})...`);
  const { pm, sm, ep, rules, guardrails } = await loadData();

  const smBySku = new Map(sm.map(r => [r.internal_sku, r]));
  const epBySku = new Map(ep.map(r => [r.sku, r]));
  const pmBySku = new Map();
  for (const m of pm) {
    if (!pmBySku.has(m.our_sku)) pmBySku.set(m.our_sku, m);
  }
  const rulesBySku = new Map(rules.filter(r => r.sku).map(r => [r.sku, r]));
  const globalRule = rules.find(r => !r.sku) || {};

  // Pool = SKUs with matches + our listing + cost. Sample first LIMIT.
  const pool = [];
  for (const [sku, m] of pmBySku) {
    const my = epBySku.get(sku);
    const smRow = smBySku.get(sku);
    if (!my || !smRow) continue;
    pool.push({ sku, my, sm: smRow, match: m, rule: rulesBySku.get(sku) || globalRule });
    if (pool.length >= LIMIT) break;
  }
  console.log(`[dryrun] Simulating ${pool.length} SKUs @ old=${OLD_RATE} vs new=${NEW_RATE}`);

  // For simplicity we do NOT re-fetch competitor prices — the exchange rate
  // doesn't affect them. We use a placeholder competitorTotal from
  // ebay_products.price_usd - 5 (rough undercut) if no real data. This still
  // makes the recommended-price arithmetic honest for the impact study.
  const now = new Date();

  const outDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `dryrun-exchange-rate-${now.toISOString().slice(0, 19).replace(/[:.]/g, '')}.jsonl`);
  const outFd = fs.openSync(outPath, 'w');

  const stats = {
    total: pool.length,
    old_actions: {}, new_actions: {},
    action_changed: 0,
    price_changed: 0,
    price_delta_sum: 0,
    price_delta_max: 0,
    price_delta_min: 0,
    became_review_floor_binds: 0,
    became_auto: 0,
  };

  for (const row of pool) {
    // simulated competitor: just use ebay_products.price_usd - 1 as competitor total
    const compTotal = row.my.price_usd ? Math.max(1, Number(row.my.price_usd) - 1) : 20;
    const identity = row.match?.confidence != null ? Number(row.match.confidence) : null;
    const ageHours = 2; // pretend fresh

    const dOld = decideAt(OLD_RATE, row.sm, row.my, compTotal, compTotal, identity, ageHours, 0, row.rule, guardrails);
    const dNew = decideAt(NEW_RATE, row.sm, row.my, compTotal, compTotal, identity, ageHours, 0, row.rule, guardrails);

    stats.old_actions[dOld.action + ':' + dOld.reason_code] =
      (stats.old_actions[dOld.action + ':' + dOld.reason_code] || 0) + 1;
    stats.new_actions[dNew.action + ':' + dNew.reason_code] =
      (stats.new_actions[dNew.action + ':' + dNew.reason_code] || 0) + 1;

    if (dOld.action !== dNew.action || dOld.reason_code !== dNew.reason_code) stats.action_changed += 1;
    if (dOld.reason_code === 'REVIEW_FLOOR_BINDS' && dNew.reason_code === 'AUTO_UNDERCUT_SAFE') stats.became_auto += 1;
    if (dNew.reason_code === 'REVIEW_FLOOR_BINDS' && dOld.reason_code === 'AUTO_UNDERCUT_SAFE') stats.became_review_floor_binds += 1;

    const p1 = dOld.recommended_price;
    const p2 = dNew.recommended_price;
    if (p1 != null && p2 != null && Math.abs(p1 - p2) > 0.005) {
      stats.price_changed += 1;
      const delta = p2 - p1;
      stats.price_delta_sum += delta;
      if (delta > stats.price_delta_max) stats.price_delta_max = delta;
      if (delta < stats.price_delta_min) stats.price_delta_min = delta;
    }

    fs.writeSync(outFd, JSON.stringify({
      sku: row.sku,
      item_id: row.my.item_id,
      cost_krw: row.sm.cost_krw,
      weight_gram: row.sm.weight_gram,
      current_price: row.my.price_usd,
      competitor_total: compTotal,
      old_rate: OLD_RATE, new_rate: NEW_RATE,
      old: { action: dOld.action, reason: dOld.reason_code, floor: dOld.floor, target: dOld.target, recommended: dOld.recommended_price },
      new: { action: dNew.action, reason: dNew.reason_code, floor: dNew.floor, target: dNew.target, recommended: dNew.recommended_price },
    }) + '\n');
  }
  fs.closeSync(outFd);

  const avgDelta = stats.price_changed > 0 ? stats.price_delta_sum / stats.price_changed : 0;

  console.log('\n═══════ Dry-run summary ═══════');
  console.log(`Rates: OLD=${OLD_RATE} → NEW=${NEW_RATE}   (${((OLD_RATE - NEW_RATE) / OLD_RATE * 100).toFixed(2)}% lower)`);
  console.log(`Total SKUs sampled: ${stats.total}`);
  console.log(`Action changed:     ${stats.action_changed}  (${(stats.action_changed / stats.total * 100).toFixed(1)}%)`);
  console.log(`Recommended price changed: ${stats.price_changed}  (${(stats.price_changed / stats.total * 100).toFixed(1)}%)`);
  console.log(`  avg delta:  ${avgDelta >= 0 ? '+' : ''}${avgDelta.toFixed(2)} USD`);
  console.log(`  max delta:  +${stats.price_delta_max.toFixed(2)} USD`);
  console.log(`  min delta:  ${stats.price_delta_min.toFixed(2)} USD`);
  console.log(`AUTO → REVIEW_FLOOR_BINDS (더 보수적): ${stats.became_review_floor_binds}`);
  console.log(`REVIEW_FLOOR_BINDS → AUTO (덜 보수적): ${stats.became_auto}`);
  console.log('\n─── action distribution ───');
  console.log('OLD:', JSON.stringify(stats.old_actions, null, 2));
  console.log('NEW:', JSON.stringify(stats.new_actions, null, 2));
  console.log(`\nPer-SKU JSONL: ${outPath}`);
  console.log('\n⚠️  This simulation:');
  console.log('    - Reads production DB read-only');
  console.log('    - Does NOT modify margin_settings');
  console.log('    - Uses a placeholder competitor price (real re-simulation would use live/cached competitor data)');
})();
