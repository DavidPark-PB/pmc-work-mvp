/**
 * src/services/oms/physicalSpecificCoverage.js — Phase 7A-4e · READ-ONLY.
 *
 * Owner directive (7A-4e — Physical Trust Unification):
 *   ONE shared authoritative physical identity diagnostic is used by
 *   ebayPhysicalUnmatchedReporter · physicalSpecificCoverage · channelSalesEvidence.
 *
 *   This module is a thin wrapper around physicalIdentityDiagnostic that keeps
 *   the legacy output field names required by consumers (channelSalesEvidence,
 *   scripts/oms-sales-velocity.js) while adopting the 7A-4c semantics:
 *
 *     - business-time window = oms_orders.shipped_at (never imported_at)
 *     - set-name multi-word phrase matching
 *     - set_code word-boundary matching (sv9 != sv9a)
 *     - language / unit semantics decisive
 *     - sku_master → link → sellable → components → physical graph
 *     - trust gate operates on UNIQUE UNRESOLVED IDENTITIES (not raw item count)
 *     - E-classified structured false positives DO NOT block trust
 */
'use strict';

const { analysePhysicalIdentity, _internals: shared } = require('./physicalIdentityDiagnostic');

/**
 * Analyse physical-specific mapping coverage for a physical_product on one channel.
 * READ-ONLY. Never mutates any table.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {'shopify'|'ebay'} [args.channel='shopify']
 * @param {number} [args.days=30]
 */
async function analysePhysicalIdentityCoverage({ physicalProductId, channel = 'shopify', days = 30 } = {}) {
  const nowMs = Date.now();
  const result = await analysePhysicalIdentity({ physicalProductId, channel, days, nowMs });
  const daysN = result.days;

  if (result.error) {
    return _emptyLegacy(physicalProductId, channel, daysN, result.error);
  }

  const knownIdentities = result.known_identities;
  const knownItemCount = result.known_shipped_events.length;
  const shippedItemCount = knownItemCount;    // shipped_at window is authoritative — all in-window items are shipped
  const physCoveragePct = knownItemCount > 0 ? 100 : null;

  const unresolvedUnique = result.unresolved_unique_identities;
  const potentialUnmappedDetails = result.groups
    .filter(g => g.classification !== 'E_FALSE_POSITIVE')
    .slice(0, 20)
    .map(g => ({
      order_item_id: g.sample_items[0]?.order_item_id ?? null,
      external_order_number: g.sample_items[0]?.external_order_number ?? null,
      listing_id: g.listing_id ?? null,
      variant_id: g.variant_ids[0] ?? null,
      marketplace_sku: g.marketplace_sku_examples[0] ?? null,
      title: g.title_examples[0] ?? null,
      hints: g.hit_tokens,
      classification: g.classification,
      reason: g.reason,
      items_count: g.items_count,
      raw_quantity: g.raw_quantity,
      physical_units_per_sold_unit: g.physical_units_per_sold_unit,
      proposed_physical_units_if_owner_confirms: g.proposed_physical_units_if_owner_confirms,
    }));

  // identity_universe_confidence: never claim 'high' (Owner §3)
  let identityUniverseConfidence = 'unknown';
  if (knownIdentities.length === 0) identityUniverseConfidence = 'unknown';
  else if (unresolvedUnique > 0) identityUniverseConfidence = 'low';
  else identityUniverseConfidence = 'medium';

  // velocity_trusted — window-completeness gate remains caller's responsibility (channelSalesEvidence)
  //   trusted only if:
  //     - known identities exist
  //     - unresolved unique identities === 0
  //     - physical mapping coverage 100% within known-identity items (auto by shared module semantics)
  let trusted = false;
  let reason = null;
  if (knownIdentities.length === 0) {
    reason = 'no_known_identities_for_physical';
  } else if (unresolvedUnique > 0) {
    reason = `potential_unmapped_same_physical(${unresolvedUnique})`;
  } else if (knownItemCount === 0) {
    // Legitimate zero window: no items on known identities and no unresolved candidates
    trusted = true;
    reason = 'no_historical_items_for_known_identities';
  } else if (physCoveragePct != null && physCoveragePct < 100) {
    reason = `physical_specific_mapping_coverage_below_100(${physCoveragePct}%)`;
  } else {
    trusted = true;
    reason = 'known_identity_items_fully_mapped_and_no_potential_related';
  }

  return {
    physical_product_id: physicalProductId,
    channel, days: daysN,
    physical: result.physical
      ? { id: result.physical.id, canonical_title: result.physical.canonical_title, set_code: result.physical.set_code, language: result.physical.language, region: result.physical.region, unit_type: result.physical.unit_type }
      : null,
    // Legacy field name kept for consumers (channelSalesEvidence, sales velocity CLI):
    known_shopify_identities: knownIdentities.map(k => ({
      listing_id: k.listing_id, variant_id: k.variant_id, sku_master_id: k.sku_master_id,
    })),
    historical_items_for_known_identities: knownItemCount,
    shipped_items_for_known_identities: shippedItemCount,
    physical_units_shipped_7d: result.known_mapped_physical_units_7d,
    physical_units_shipped_30d: result.known_mapped_physical_units_30d,
    physical_mapping_coverage_pct: physCoveragePct,
    identity_universe_confidence: identityUniverseConfidence,
    // 7A-4e: potential_unmapped_same_physical is now UNIQUE UNRESOLVED IDENTITIES (not raw item count).
    potential_unmapped_same_physical: unresolvedUnique,
    potential_unmapped_details: potentialUnmappedDetails,
    diagnostic_hints_used: [
      ...result.diagnostic_hints.phrases.map(p => `phrase:${p}`),
      ...(result.diagnostic_hints.set_code ? [`set_code:${result.diagnostic_hints.set_code}`] : []),
    ],
    diagnostic_hints: result.diagnostic_hints,
    window_start: result.window_start,
    window_end: result.window_end,
    window_time_field: result.window_time_field,
    velocity_trusted: trusted,
    trust_reason: reason,
    generated_at: result.generated_at,
  };
}

function _emptyLegacy(physicalId, channel, days, reason) {
  return {
    physical_product_id: physicalId, channel, days,
    physical: null,
    known_shopify_identities: [],
    historical_items_for_known_identities: 0,
    shipped_items_for_known_identities: 0,
    physical_units_shipped_7d: 0,
    physical_units_shipped_30d: 0,
    physical_mapping_coverage_pct: null,
    identity_universe_confidence: 'unknown',
    potential_unmapped_same_physical: 0,
    potential_unmapped_details: [],
    diagnostic_hints_used: [],
    diagnostic_hints: { phrases: [], set_code: null, language: '', unit_type: '' },
    velocity_trusted: false,
    trust_reason: reason,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  analysePhysicalIdentityCoverage,
  // Exposed for tests / diagnostic tools
  _internals: {
    buildStructuredHints: shared.buildStructuredHints,
    _idKey: (l, v) => `${l ?? ''}|${v ?? ''}`,
  },
};
