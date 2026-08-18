'use strict';

/**
 * src/services/oms/shippingCandidateService.js — Phase 8O.
 *
 * READ-ONLY projection: assemble a shipping CANDIDATE for a physical
 * product using existing weight/dimension data + shippingRateEngine.
 *
 * IMPORTANT: This is a candidate/estimate. Actual shipping depends on
 * packaging, service level chosen at fulfillment, and rate-table freshness.
 * Callers MUST render the number labelled as "예상 배송비" · never as final.
 *
 * Lineage (audited 2026-08-18):
 *   physical → sellable_units → sellable_unit_components (qty=1)
 *   → sku_master_link → sku_master.weight_gram
 *   → shippingRateEngine.getQuotes({country, actualKg, l, w, h})
 *
 * KNOWN GAPS (Phase 8O data gap backlog):
 *   1. sku_master has weight_gram but NO length/width/height columns —
 *      shipping is unavailable (volumetric can't be computed) until dims
 *      are captured. Falls back to UNKNOWN when dims missing.
 *   2. Destination country is caller-supplied (defaults to '미국' matching
 *      Hermes assumption). NO auto-derivation from listing country.
 *   3. Rate table date/version is not surfaced by shippingRateEngine —
 *      provenance carries the engine identifier only.
 *
 * SAFETY:
 *   • Zero DB write · zero marketplace call
 *   • Reads only sellable_unit_components, sku_master_link, sku_master
 *   • Returns UNKNOWN when any required input is missing · never
 *     fabricates zero.
 *   • Owner-supplied override (see financialMetricsOrchestrator) wins
 *     over the auto-computed candidate.
 */

const shippingEngine = require('../shippingRateEngine');

const DEFAULT_DESTINATION = '미국';
const CANDIDATE_STATUS = Object.freeze({
  ESTIMATED: 'ESTIMATED',
  UNKNOWN:   'UNKNOWN',
});

async function assembleShippingCandidate({
  physicalProductId, db,
  destinationCountry = DEFAULT_DESTINATION,
  lengthCm = null, widthCm = null, heightCm = null,
  serviceLevel = 'cheapest',
} = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('assembleShippingCandidate: physicalProductId required (positive integer)');
  }
  if (!db || typeof db.from !== 'function') {
    throw new Error('assembleShippingCandidate: db (Supabase-like client) required');
  }

  // Walk to sku_master to pull weight_gram
  const sellableUnits = await _select(db, 'sellable_units', 'id, physical_product_id', { physical_product_id: physicalProductId });
  if (!sellableUnits.length) return _unknown('no_sellable_unit_for_physical');
  const suIds = sellableUnits.map(r => r.id);
  const components = await _selectIn(db, 'sellable_unit_components', 'sellable_unit_id, quantity_per_unit', 'sellable_unit_id', suIds);
  const suSingle = components.filter(c => Number(c.quantity_per_unit) === 1).map(c => c.sellable_unit_id);
  if (!suSingle.length) return _unknown('no_single_unit_component');
  const links = await _selectIn(db, 'sku_master_link', 'sku_master_id, sellable_unit_id', 'sellable_unit_id', suSingle);
  const smIds = [...new Set(links.map(l => l.sku_master_id))];
  if (!smIds.length) return _unknown('no_sku_master_link');
  const skuMasters = await _selectIn(db, 'sku_master', 'id, internal_sku, weight_gram', 'id', smIds);

  // Weight — median across bridged sku_masters (identical semantics as accounting cost walk)
  const weights = skuMasters
    .map(s => Number(s.weight_gram))
    .filter(v => Number.isFinite(v) && v > 0);
  if (!weights.length) return _unknown('no_weight_gram_in_sku_master', { smIds });

  const weightGram = _median(weights);
  const weightKg = weightGram / 1000;

  // Dimensions — Phase 8O gap: sku_master has NO length/width/height columns.
  //   Caller may pass them explicitly (from packaging spec or Owner input).
  //   Missing → UNKNOWN because volumetric weight determines carrier price.
  const dimsProvided = _finiteOrNull(lengthCm) != null && _finiteOrNull(widthCm) != null && _finiteOrNull(heightCm) != null;
  if (!dimsProvided) {
    return _unknown('dimensions_missing', {
      note: 'sku_master lacks length/width/height columns · Owner must supply dims OR migration adds columns',
      weight_gram: weightGram,
      weight_kg: weightKg,
    });
  }

  const l = Number(lengthCm), w = Number(widthCm), h = Number(heightCm);
  //   shippingRateEngine.getQuotes throws only if country is missing — we
  //   pass the caller default. Empty return array is treated as UNKNOWN.
  let quotes;
  try {
    quotes = shippingEngine.getQuotes({ country: destinationCountry, actualKg: weightKg, lengthCm: l, widthCm: w, heightCm: h });
  } catch (err) {
    return _unknown('shipping_engine_error', { message: err.message });
  }
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return _unknown('shipping_engine_returned_no_quotes', { destinationCountry, weightKg });
  }

  //   Sort by total ascending; pick cheapest if serviceLevel='cheapest'.
  //   Note: shippingRateEngine returns { carrier, base, fuel, total, chargeKg,
  //   volKg } — different naming than Hermes getShippingQuotes.
  const sorted = quotes.slice().sort((a, b) => (a.total || Infinity) - (b.total || Infinity));
  const chosen = sorted[0];
  const amount = _finiteOrNull(chosen.total);
  if (amount == null || amount < 0) return _unknown('shipping_engine_amount_invalid', { chosen });

  return {
    status: CANDIDATE_STATUS.ESTIMATED,
    amount_krw: amount,
    carrier: chosen.carrier || null,
    service: chosen.service || null,
    chargeable_weight_kg: chosen.chargeKg ?? null,
    volumetric_weight_kg: chosen.volKg ?? null,
    weight_used_kg: weightKg,
    dimensions_used_cm: { length: l, width: w, height: h },
    destination_country: destinationCountry,
    service_level: serviceLevel,
    rate_engine: 'shippingRateEngine.v1',
    rate_version: null,   // engine does not surface version yet · Phase 8O backlog
    all_quotes: sorted.map(q => ({ carrier: q.carrier, total_krw: q.total, service: q.service })),
    confidence_note: '예상 배송비 · rate_table 최신성 미보증 · 실제 배송비는 fulfillment 단계에서 재산정 필요',
  };
}

function _unknown(reason, ctx = {}) {
  return {
    status: CANDIDATE_STATUS.UNKNOWN,
    reason,
    amount_krw: null,
    carrier: null,
    service: null,
    chargeable_weight_kg: null,
    volumetric_weight_kg: null,
    weight_used_kg: ctx.weight_kg ?? null,
    dimensions_used_cm: null,
    destination_country: null,
    service_level: null,
    rate_engine: 'shippingRateEngine.v1',
    context: ctx,
  };
}

function _finiteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
async function _select(db, table, cols, eq) {
  const q = db.from(table).select(cols);
  const [k, v] = Object.entries(eq)[0];
  const res = await q.eq(k, v);
  if (res && res.error) throw new Error(`select ${table} failed: ${res.error.message}`);
  return (res && res.data) || [];
}
async function _selectIn(db, table, cols, col, values) {
  if (!values || !values.length) return [];
  const res = await db.from(table).select(cols).in(col, values);
  if (res && res.error) throw new Error(`select ${table} failed: ${res.error.message}`);
  return (res && res.data) || [];
}

module.exports = {
  assembleShippingCandidate,
  CANDIDATE_STATUS,
  DEFAULT_DESTINATION,
};
