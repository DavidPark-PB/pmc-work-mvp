'use strict';

/**
 * src/services/oms/shadowValidationService.js — Phase 8O.
 *
 * READ-ONLY shadow-mode validation across N physicals.
 *
 * For each physical:
 *   • runs financialMetricsOrchestrator (auto sale price + auto shipping)
 *   • classifies anomalies without auto-correcting:
 *       – DATA_BUG                     (clear invariant violation · e.g., negative KRW)
 *       – MISSING_DATA                 (UNKNOWN cascade root cause)
 *       – EXPECTED_BUSINESS_CONDITION  (legitimately unusual · e.g., loss on aged stock)
 *       – POLICY_CANDIDATE             (needs Owner judgment)
 *
 * Never mutates anything · never sends notifications · never writes DB.
 * All DB access flows through caller-supplied `db` + `ownerDecisionFn`.
 */

//   Lazy reference · destructured import would cache a binding that
//   test monkey-patches never reach.
const orchestratorMod = require('./financialMetricsOrchestrator');

const ANOMALY_TYPE = Object.freeze({
  DATA_BUG:                     'DATA_BUG',
  MISSING_DATA:                 'MISSING_DATA',
  EXPECTED_BUSINESS_CONDITION:  'EXPECTED_BUSINESS_CONDITION',
  POLICY_CANDIDATE:             'POLICY_CANDIDATE',
});

const IMPLAUSIBLE_MARGIN_HIGH_PCT = 100;    // > 100% is impossible under normal cost accounting
const LARGE_COST_DIVERGENCE_RATIO = 3;      // accounting/replacement > 3× → flag
const SECONDARY_OUTLIER_MIN_RATIO = 10;     // secondary min < replacement/10 → outlier
const NEGATIVE_MARGIN_LOSS_PCT = -50;       // <= -50% margin is worth surfacing as loss
//   Phase 8P · conservative divergence threshold: sold median vs listing
//   asking price differ by > 25% (either direction) → flag for Owner review.
//   Owner Part 9: do not automatically declare either source wrong.
const SOLD_VS_LISTING_DIVERGENCE_PCT = 25;

/**
 * @param {Object} args
 * @param {number[]} args.physicalProductIds
 * @param {Function} args.ownerDecisionFn        (physicalId) → ownerDecision
 * @param {Object}   args.db                     Supabase-like client
 * @param {Object}   [args.autoSalePriceOpts]
 * @param {Object}   [args.autoShippingOpts]
 * @param {Object}   [args.manualByPhysical]     { [id]: {manual} }
 * @returns {Promise<{physicals: Array, summary: Object}>}
 */
async function runShadowValidation(args = {}) {
  const {
    physicalProductIds = [],
    ownerDecisionFn, db,
    autoSalePriceOpts = {}, autoShippingOpts = {},
    manualByPhysical = {},
  } = args;
  if (!Array.isArray(physicalProductIds) || physicalProductIds.length === 0) {
    throw new Error('runShadowValidation: physicalProductIds[] required');
  }
  if (typeof ownerDecisionFn !== 'function') {
    throw new Error('runShadowValidation: ownerDecisionFn required (injectable)');
  }
  if (!db || typeof db.from !== 'function') {
    throw new Error('runShadowValidation: db required');
  }

  const physicals = [];
  for (const id of physicalProductIds) {
    physicals.push(await _runOne(id, ownerDecisionFn, db, { autoSalePriceOpts, autoShippingOpts, manual: manualByPhysical[id] || {} }));
  }

  const summary = _buildSummary(physicals);
  return { generated_at: new Date().toISOString(), count: physicals.length, physicals, summary };
}

async function _runOne(physicalProductId, ownerDecisionFn, db, opts) {
  const out = { physical_product_id: physicalProductId, anomalies: [], error: null };
  let od;
  try {
    od = await ownerDecisionFn(physicalProductId);
  } catch (err) {
    out.error = { stage: 'ownerDecision', message: err.message };
    return out;
  }
  if (!od || od.error) {
    out.error = { stage: 'ownerDecision', message: od?.error || 'null owner_decision' };
    return out;
  }
  out.decision = od.headline?.decision_status ?? null;
  out.priority = od.headline?.priority_score ?? null;
  out.title = od.product?.title ?? null;

  let result;
  try {
    result = await orchestratorMod.buildFinancialMetricsWithAutoInputs({
      ownerDecision: od, db,
      manual: opts.manual,
      autoSalePriceOpts: opts.autoSalePriceOpts,
      autoShippingOpts: opts.autoShippingOpts,
    });
  } catch (err) {
    out.error = { stage: 'orchestrator', message: err.message };
    return out;
  }
  out.inputs_resolution = result.inputs_resolution;
  out.financial_metrics = result.financial_metrics;

  //   Detect anomalies without auto-fixing.
  _classifyAnomalies(out, od);
  return out;
}

function _classifyAnomalies(row, od) {
  const push = (type, kind, detail) => row.anomalies.push({ type, kind, detail });

  const spRes = row.inputs_resolution?.sale_price;
  const shRes = row.inputs_resolution?.shipping;

  //   Missing data — surface the shape but don't call it a bug.
  if (spRes?.resolution === 'UNKNOWN') push(ANOMALY_TYPE.MISSING_DATA, 'sale_price_unknown', { note: spRes.note });
  if (shRes?.resolution === 'UNKNOWN') push(ANOMALY_TYPE.MISSING_DATA, 'shipping_unknown', { note: shRes.note });

  //   Freshness signal on auto sale price
  const spObs = spRes?.auto_observation;
  if (spObs && spObs.freshness_status === 'STALE') {
    push(ANOMALY_TYPE.MISSING_DATA, 'sale_price_stale', { observed_at: spObs.observed_at, listing_id: spObs.listing_id });
  }
  if (spObs && spObs.listing_status && spObs.listing_status !== 'active') {
    push(ANOMALY_TYPE.MISSING_DATA, 'listing_not_active', { listing_status: spObs.listing_status, listing_id: spObs.listing_id });
  }

  //   Currency mismatch — sale price came from ebay_products (USD) but listing_status wrong
  if (spObs && spObs.currency && spObs.currency !== 'USD') {
    push(ANOMALY_TYPE.DATA_BUG, 'sale_price_currency_unexpected', { currency: spObs.currency });
  }

  //   Cross-scenario checks per financial metric
  const scenarios = row.financial_metrics?.scenarios || {};
  for (const [k, s] of Object.entries(scenarios)) {
    const gp = s.gross_profit, gm = s.gross_margin, ivp = s.inventory_value;

    if (gm?.status === 'AVAILABLE' && gm.pct > IMPLAUSIBLE_MARGIN_HIGH_PCT) {
      push(ANOMALY_TYPE.DATA_BUG, 'implausible_margin_over_100', { scenario: k, pct: gm.pct });
    }
    if (gm?.status === 'AVAILABLE' && gm.pct < NEGATIVE_MARGIN_LOSS_PCT) {
      push(ANOMALY_TYPE.EXPECTED_BUSINESS_CONDITION, 'severe_loss_margin', { scenario: k, pct: gm.pct, note: 'aged stock or intentional loss-leader' });
    }
    if (gp?.status === 'AVAILABLE' && gp.amount_krw < 0) {
      push(ANOMALY_TYPE.EXPECTED_BUSINESS_CONDITION, 'negative_profit', { scenario: k, amount_krw: gp.amount_krw });
    }
    //   inventory value non-negative invariant
    if (ivp?.status === 'AVAILABLE' && ivp.amount_krw < 0) {
      push(ANOMALY_TYPE.DATA_BUG, 'negative_inventory_value', { scenario: k, amount_krw: ivp.amount_krw });
    }
  }

  //   Category-level divergence between accounting vs replacement (POLICY_CANDIDATE)
  const acc = od.cost_context?.historical_accounting_cost_krw;
  const rep = od.cost_context?.historical_typical_supplier_cost_krw_median;
  if (Number.isFinite(acc) && Number.isFinite(rep) && acc > 0 && rep > 0) {
    const ratio = Math.max(acc, rep) / Math.min(acc, rep);
    if (ratio > LARGE_COST_DIVERGENCE_RATIO) {
      push(ANOMALY_TYPE.POLICY_CANDIDATE, 'accounting_vs_replacement_divergence', { accounting_krw: acc, replacement_krw: rep, ratio: Math.round(ratio * 100) / 100 });
    }
  }

  //   Secondary market outlier vs replacement (POLICY_CANDIDATE per Owner backlog)
  const sec = od.cost_context?.observed_secondary_market_ask_min_krw;
  if (Number.isFinite(sec) && Number.isFinite(rep) && sec > 0 && rep > 0) {
    if (sec * SECONDARY_OUTLIER_MIN_RATIO < rep) {
      push(ANOMALY_TYPE.POLICY_CANDIDATE, 'secondary_market_outlier_far_below_replacement', { secondary_min_krw: sec, replacement_krw: rep });
    }
  }

  //   Provenance completeness
  const spSourceMissing = spRes?.resolution === 'AUTO_OBSERVED' && !spObs?.listing_id;
  if (spSourceMissing) push(ANOMALY_TYPE.MISSING_DATA, 'provenance_missing_sale_price', {});

  //   Phase 8P · SOLD_VS_LISTING_PRICE_DIVERGENCE.
  //   When both candidates existed (regardless of which was selected), flag
  //   large divergence for Owner review. NEVER auto-declare either wrong.
  const seen = spRes?.candidates_seen || [];
  const soldCandidate = seen.find(c => c.type === 'RECENT_SOLD_PRICE_MEDIAN' && c.status === 'RECENT_SOLD_PRICE_MEDIAN' && Number.isFinite(c.value));
  const listingCandidate = seen.find(c => c.type === 'OBSERVED_LISTING_PRICE' && Number.isFinite(c.value));
  //   When SOLD is selected, listing candidate isn't in candidates_seen. Try
  //   to also read the raw auto_observation for a listing snapshot present
  //   in row.inputs_resolution (Phase 8P shadow additive · no change to
  //   orchestrator return shape required).
  const listingValue = listingCandidate?.value
    ?? (spRes?.auto_observation && spRes.auto_observation.status === 'OBSERVED_LISTING_PRICE' ? spRes.auto_observation.amount_krw : null);
  if (Number.isFinite(soldCandidate?.value) && Number.isFinite(listingValue) && soldCandidate.value > 0 && listingValue > 0) {
    const ratio = Math.abs(soldCandidate.value - listingValue) / Math.max(soldCandidate.value, listingValue);
    const pct = Math.round(ratio * 10000) / 100;
    if (pct > SOLD_VS_LISTING_DIVERGENCE_PCT) {
      push(ANOMALY_TYPE.POLICY_CANDIDATE, 'sold_vs_listing_price_divergence', {
        sold_median_krw: soldCandidate.value,
        listing_price_krw: listingValue,
        divergence_pct: pct,
        threshold_pct: SOLD_VS_LISTING_DIVERGENCE_PCT,
        note: 'Owner must judge which price is authoritative · service NEVER auto-corrects',
      });
    }
  }
}

function _buildSummary(rows) {
  const byType = Object.fromEntries(Object.values(ANOMALY_TYPE).map(t => [t, 0]));
  const byKind = new Map();
  let errored = 0;
  for (const r of rows) {
    if (r.error) errored++;
    for (const a of (r.anomalies || [])) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      byKind.set(a.kind, (byKind.get(a.kind) || 0) + 1);
    }
  }
  return {
    physicals_total: rows.length,
    physicals_errored: errored,
    anomalies_by_type: byType,
    anomalies_by_kind: Object.fromEntries([...byKind.entries()].sort((a, b) => b[1] - a[1])),
  };
}

module.exports = {
  runShadowValidation,
  ANOMALY_TYPE,
  IMPLAUSIBLE_MARGIN_HIGH_PCT,
  LARGE_COST_DIVERGENCE_RATIO,
  SECONDARY_OUTLIER_MIN_RATIO,
  NEGATIVE_MARGIN_LOSS_PCT,
  SOLD_VS_LISTING_DIVERGENCE_PCT,
};
