/**
 * src/services/oms/inventoryOwnerDecisionService.js — Phase 8E · READ-ONLY.
 *
 * Owner Decision Console projection.
 *
 * Consumes EXISTING source-of-truth services · duplicates NO business logic:
 *   assessInventoryDecision         (inventoryDecisionEngine · Phase 8A)
 *   _internals._rankAction          (inventoryExceptionQueueService · Phase 8B)
 *   assessStrategicHold             (via inventoryDecisionEngine → hold source)
 *   replacementSupplyCurveService   (via strategic hold)
 *   replacementEvidenceService      (via strategic hold)
 *   channelSalesEvidence            (via strategic hold)
 *
 * Owner directive (Phase 8E):
 *   · Do NOT invent new numbers · verbatim upstream where possible
 *   · Preserve null / UNKNOWN
 *   · Recommend Owner actions · NEVER execute
 *   · No auto purchase · no auto strategic hold · no marketplace mutation
 *   · Cost semantics stay separated (typical supplier ref · accounting cost ·
 *     observed secondary ask are DIFFERENT categories)
 */
'use strict';

const { assessInventoryDecision, DECISION } = require('./inventoryDecisionEngine');
const { _internals: queueInternals } = require('./inventoryExceptionQueueService');
const _rankAction = queueInternals._rankAction;
// Phase 8K · pure explainability layer (deterministic derivation · no logic
//   changes to decision / action / priority / urgency).
const { translate: _translateReason, KNOWN_REASON_CODES } = require('./inventoryReasonExplanations');
// judgmentConfidencePolicy is required lazily below to avoid a circular
//   require with this module (it imports ACTION from here).

// Actions the system MUST NEVER execute — surfaced for Owner clarity.
const FORBIDDEN_AUTOMATIC_ACTIONS = Object.freeze([
  'AUTO_PURCHASE',
  'AUTO_STRATEGIC_HOLD',
  'AUTO_MARKETPLACE_PRICE_CHANGE',
  'AUTO_LISTING_CHANGE',
  'AUTO_INVENTORY_ADJUSTMENT',
  'AUTO_STRATEGIC_HOLD_UNIT_ALLOCATION',
]);

// Action code enum (Owner-facing explainability · never executable here).
const ACTION = Object.freeze({
  NO_ACTION:                'NO_ACTION',
  WATCH_ONLY:               'WATCH_ONLY',
  CHECK_PRIMARY_SUPPLIER:   'CHECK_PRIMARY_SUPPLIER',
  CHECK_SECONDARY_MARKET:   'CHECK_SECONDARY_MARKET',
  CONFIRM_EXECUTABLE_QUOTE: 'CONFIRM_EXECUTABLE_QUOTE',
  REVIEW_REPLENISHMENT:     'REVIEW_REPLENISHMENT',
  REVIEW_STOCK_PROTECTION:  'REVIEW_STOCK_PROTECTION',
  REVIEW_DATA_QUALITY:      'REVIEW_DATA_QUALITY',
});

const ACTION_STATUSES_FOR_RANK = new Set([DECISION.WATCH, DECISION.REPLENISH, DECISION.PROTECT_STOCK]);

/**
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} [args.asOf=Date.now()]
 * @param {Function} [args.assessFn]    injectable · defaults to assessInventoryDecision
 */
async function buildOwnerDecision({ physicalProductId, asOf = Date.now(), assessFn = null } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('physicalProductId required positive integer');
  }
  const _assess = assessFn || (id => assessInventoryDecision({ physicalProductId: id, asOf }));

  // Single upstream call · projection only (Owner §Part 7 · no duplicate assess).
  const decisionResult = await _assess(physicalProductId);
  if (!decisionResult) return _errorProjection(physicalProductId, asOf, { error: 'assess_returned_null' });
  if (decisionResult.error) return _errorProjection(physicalProductId, asOf, decisionResult);

  const phy = decisionResult.physical || null;
  const decision = decisionResult.decision || {};
  const inv = decisionResult.inventory_summary || {};
  const dm = decisionResult.demand_summary || {};
  const sp = decisionResult.supply_summary || {};
  const cc = decisionResult.cost_context || {};

  // Reuse queue-service ranking (SoT) · never recompute score locally.
  const priority = ACTION_STATUSES_FOR_RANK.has(decision.status)
    ? _rankAction(decisionResult, phy || { id: physicalProductId, canonical_title: null })
    : { priority_score: 0, priority_reasons: [] };

  const dep60 = sp.secondary_market_dependency_by_target
    ? (sp.secondary_market_dependency_by_target[60] ?? null)
    : null;

  const recommended = _recommendActions({ decision: decision.status, supply: sp });

  // Phase 8K · derive judgment confidence + data provenance.
  //   NEVER modifies decision / action / priority / urgency / cost numbers.
  //   Any field the upstream does not surface is null or 'UNKNOWN' verbatim.
  const { deriveJudgmentConfidence } = require('./judgmentConfidencePolicy');
  const { judgment_confidence, recommended_evidence_actions } = deriveJudgmentConfidence(decisionResult);
  const reason_code_explanations = _buildReasonExplanations(decision.reason_codes || [], { dm, sp });
  const data_provenance = _buildDataProvenance(decisionResult);

  return {
    physical_product_id: physicalProductId,
    generated_at: decisionResult.generated_at,

    headline: {
      decision_status: decision.status,
      confidence_level: decision.confidence_level,
      priority_score: priority.priority_score,
      urgency_label: _urgencyLabel(decision.status, priority.priority_score),
      one_line_summary: _oneLineSummary({ decision: decision.status, phy, inv, dm, sp }),
    },

    product: {
      title: phy?.canonical_title ?? null,
      set_code: phy?.set_code ?? null,
      language: phy?.language ?? null,
      unit_type: phy?.unit_type ?? null,
    },

    inventory: {
      on_hand: _passthrough(inv.on_hand),
      reserved: _passthrough(inv.reserved),
      available: _passthrough(inv.available),
    },

    demand: {
      trusted: dm.trusted ?? null,
      units_7d: _passthrough(dm.units_7d),
      units_30d: _passthrough(dm.units_30d),
      velocity_30d: _passthrough(dm.velocity_30d),
      raw_days_of_supply: _passthrough(dm.raw_days_of_supply),
      demand_pattern: dm.demand_pattern ?? null,
      largest_shipment_units_30d: _passthrough(dm.largest_shipment_units_30d),
      largest_shipment_share_30d: _passthrough(dm.largest_shipment_share_30d),
    },

    supply: {
      verdict: sp.verdict ?? null,
      replacement_difficulty: sp.replacement_difficulty ?? null,
      current_supply_quality: sp.current_supply_quality ?? null,
      evidenced_replacement_depth: _passthrough(sp.evidenced_replacement_depth),
      depth_gap: _passthrough(decision.depth_gap),
      uncovered_at_60: _passthrough(sp.uncovered_at_60),
      uncovered_at_100: _passthrough(sp.uncovered_at_100),
      secondary_market_dependency_at_60: dep60,
      has_current_supplier_or_executable: sp.has_current_supplier_or_executable ?? null,
      supplier_diversity: _passthrough(sp.supplier_diversity),
    },

    // Owner §Part 3 · categories STAY separated. No auto ratio · no auto
    // margin. Consumers must NEVER treat these three numbers as the same
    // semantic thing.
    cost_context: {
      historical_typical_supplier_cost_krw_median: _passthrough(cc.historical_typical_supplier_cost_krw_median),
      historical_accounting_cost_krw: _passthrough(cc.historical_accounting_cost_krw),
      observed_secondary_market_ask_min_krw: _passthrough(cc.observed_secondary_market_ask_min_krw),
      note: 'typical supplier ref · accounting cost · observed secondary ask are DIFFERENT semantic categories. Do not combine automatically.',
    },

    reasons: {
      reason_codes: [...(decision.reason_codes || [])],
      hold_quantity_blockers: [...(decision.hold_quantity_blockers || [])],
      missing_evidence: [...(decisionResult.missing_evidence || [])],
      // Phase 8K · Korean plain-language explanation per reason_code.
      //   Unknown code → original string verbatim. Never modifies reason_codes.
      reason_code_explanations,
    },

    recommended_actions: recommended,
    // Phase 8K · Owner review actions to close evidence gaps · never promises
    //   confidence will rise · reuses Phase 8F ACTION enum only.
    recommended_evidence_actions,
    // Phase 8K · deterministic explainability tier per dimension + overall.
    judgment_confidence,
    // Phase 8K · upstream metadata projection · null/UNKNOWN when unavailable.
    data_provenance,
    forbidden_automatic_actions: [...FORBIDDEN_AUTOMATIC_ACTIONS],
    priority_reasons: [...(priority.priority_reasons || [])],

    // Full upstream verbatim so the CLI (or future UI) can inspect any
    // sub-section without re-fetching or re-assessing.
    source_snapshot: {
      inventory_decision: decisionResult,
    },
  };
}

// ─── action translation (explainability layer) ──────────

function _recommendActions({ decision, supply }) {
  const out = [];
  if (decision === DECISION.SELL_NORMALLY) {
    return [_makeAction(ACTION.NO_ACTION, {
      label: 'No action', description: 'Continue normal selling.', risk_level: 'none',
    })];
  }
  if (decision === DECISION.INSUFFICIENT_DATA) {
    return [_makeAction(ACTION.REVIEW_DATA_QUALITY, {
      label: 'Review data quality',
      description: 'Missing evidence — inspect missing_evidence and collect trusted demand/supply signals before any operational decision.',
      risk_level: 'none',
    })];
  }
  if (decision === DECISION.WATCH) {
    out.push(_makeAction(ACTION.WATCH_ONLY, {
      label: 'Watch only',
      description: 'Business signals are ambiguous. Do not act. Continue observing 7d / 30d demand and supply evidence.',
      risk_level: 'none',
    }));
    if (supply?.current_supply_quality === 'ask_only') {
      out.push(_makeAction(ACTION.CONFIRM_EXECUTABLE_QUOTE, {
        label: 'Confirm executable quote',
        description: 'Current supply is a SECONDARY_MARKET_ASK only. Contact the seller to convert ASK → EXECUTABLE_QUOTE before any purchase decision.',
        risk_level: 'low',
      }));
    }
    if (supply?.has_current_supplier_or_executable === false) {
      out.push(_makeAction(ACTION.CHECK_PRIMARY_SUPPLIER, {
        label: 'Check primary supplier',
        description: 'No current SUPPLIER_QUOTE or EXECUTABLE_QUOTE evidence on file. Contact primary distributor for a current quote.',
        risk_level: 'low',
      }));
    } else if (supply?.current_supply_quality !== 'ask_only' && (supply?.secondary_market_dependency_by_target?.[60] ?? 0) > 0.5) {
      // Only trigger secondary-market broadening when supply is via primary
      // channel but coverage is emerging from secondary — avoid duplicating
      // CONFIRM_EXECUTABLE_QUOTE when ask_only.
      out.push(_makeAction(ACTION.CHECK_SECONDARY_MARKET, {
        label: 'Check secondary market',
        description: 'Coverage at 60 units depends heavily on secondary-market asks. Broaden the survey — junggonara / bunjang / karrot / KREAM.',
        risk_level: 'low',
      }));
    }
    return out;
  }
  if (decision === DECISION.REPLENISH) {
    return [_makeAction(ACTION.REVIEW_REPLENISHMENT, {
      label: 'Review replenishment',
      description: 'Days-of-supply below minimum operating stock. Owner reviews procurement (SUPPLIER_QUOTE / EXECUTABLE_QUOTE) — no auto-purchase.',
      risk_level: 'medium',
    })];
  }
  if (decision === DECISION.PROTECT_STOCK) {
    return [_makeAction(ACTION.REVIEW_STOCK_PROTECTION, {
      label: 'Review stock protection',
      description: 'Reduce sellable exposure — consider raising price or delisting a portion. Owner approval required for every listing / pricing change.',
      risk_level: 'medium',
    })];
  }
  return [];
}

function _makeAction(code, { label, description, risk_level }) {
  return {
    code,
    label,
    description,
    risk_level,
    requires_owner_approval: true,
    executable_by_system: false,
  };
}

// ─── helpers ────────────────────────────────────────────

/**
 * Compact per-physical Owner summary line (Owner §Part 5 · digest enrichment
 * DESIGN surface). NOT wired into the digest by default — the exception
 * fingerprint is derived from (id, status, priority_score) only, and any
 * formatting change here MUST NOT flow into that fingerprint. Callers that
 * choose to include it must not derive fingerprint from this string.
 */
function formatCompactOwnerSummary(ownerDecision) {
  const s = ownerDecision.headline?.decision_status ?? '?';
  const p = ownerDecision.headline?.priority_score ?? '?';
  const t = ownerDecision.product?.title ?? `phys#${ownerDecision.physical_product_id}`;
  const avail = ownerDecision.inventory?.available ?? '?';
  const dem = ownerDecision.demand?.demand_pattern ?? '?';
  const diff = ownerDecision.supply?.replacement_difficulty ?? 'UNKNOWN';
  const depth = ownerDecision.supply?.evidenced_replacement_depth ?? '?';
  const quality = ownerDecision.supply?.current_supply_quality ?? '?';
  const actions = (ownerDecision.recommended_actions || []).map(a => a.code).join(' / ');
  return [
    `#${ownerDecision.physical_product_id} [${s} · ${p}] ${t}`,
    `  available ${avail}`,
    `  demand: ${dem}`,
    `  supply: ${diff} · depth ${depth} · ${quality}`,
    `  action: ${actions || 'none'}`,
  ].join('\n');
}

function _urgencyLabel(status, score) {
  if (status === DECISION.INSUFFICIENT_DATA) return 'data_quality';
  if (status === DECISION.SELL_NORMALLY) return 'none';
  if (score >= 300) return 'critical';
  if (score >= 200) return 'high';
  if (score >= 100) return 'medium';
  return 'low';
}

function _oneLineSummary({ decision, phy, inv, dm, sp }) {
  const parts = [decision];
  if (inv?.available != null) parts.push(`available ${inv.available}`);
  if (dm?.demand_pattern) parts.push(`demand ${dm.demand_pattern}`);
  if (sp?.replacement_difficulty) parts.push(`replacement ${sp.replacement_difficulty}`);
  const title = phy?.canonical_title ? ` — ${phy.canonical_title}` : '';
  return parts.join(' · ') + title;
}

// null/undefined preserved verbatim so UNKNOWN stays UNKNOWN. Owner §Part 1.
function _passthrough(v) {
  if (v === undefined) return null;
  return v;
}

// ─── Phase 8K helpers ──────────────────────────────────

/**
 * Build a `{reason_code: koreanExplanation}` map. Never mutates the input
 * array. Never invents reason codes. Unknown code → verbatim passthrough
 * (Owner rule 6). Additive display only — decision / action untouched.
 */
function _buildReasonExplanations(reasonCodes, extra) {
  const dm = extra?.dm || {};
  const sp = extra?.sp || {};
  const ctx = {
    largest_shipment_units_30d: dm.largest_shipment_units_30d ?? null,
    largest_shipment_share_30d: dm.largest_shipment_share_30d ?? null,
    evidenced_depth: sp.evidenced_replacement_depth ?? null,
  };
  const out = {};
  for (const code of reasonCodes) {
    out[code] = _translateReason(code, ctx);
  }
  return out;
}

/**
 * Whitelist enum for provenance source (Owner rule 6 — no arbitrary tables).
 */
const PROVENANCE_SOURCE = Object.freeze({
  INVENTORY_MOVEMENTS_LEDGER: 'inventory_movements_ledger',
  OMS_ORDER_ITEMS: 'oms_order_items',
  PHYSICAL_MARKET_OBSERVATIONS: 'physical_market_observations',
  PHYSICAL_SCARCITY_SNAPSHOTS: 'physical_scarcity_snapshots',
  INTERNAL_ACCOUNTING: 'internal_accounting',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Project upstream provenance metadata verbatim. NEVER runs a new DB query.
 * NEVER guesses table names. NEVER exposes evidence.jsonb. Missing metadata
 * → null (or 'UNKNOWN' where the field is a source enum).
 */
function _buildDataProvenance(decisionResult) {
  const hold = decisionResult?.strategic_hold_source || {};
  const inv = hold.inventory || {};
  const supply = hold.supply_risk || {};
  const historyCtx = hold.historical_reference_context || {};
  const histCost = hold.historical_reference_product_cost || null;

  // Inventory — inventoryShadowService/inventoryBaselineService don't currently
  //   stamp as_of on the returned inventory object. When they do, this
  //   projection surfaces it verbatim. Until then → null.
  const inventoryProvenance = _hasAny(inv)
    ? {
        source: PROVENANCE_SOURCE.INVENTORY_MOVEMENTS_LEDGER,
        as_of: inv.as_of ?? null,
        snapshot_id: inv.snapshot_id ?? null,
        note: inv.as_of == null ? 'as_of not stamped by upstream inventoryShadowService' : null,
      }
    : { source: PROVENANCE_SOURCE.UNKNOWN, as_of: null, snapshot_id: null, note: 'inventory upstream missing' };

  // Demand — channelSalesEvidence exposes shipment counts via strategic_hold_source
  //   in `demand_concentration.total_shipments_30d`. Window is 30 days constant.
  //   `latest_observed_at` is not surfaced by upstream today → null.
  const dc = hold.demand_concentration || {};
  const demandProvenance = _hasAny(hold.demand)
    ? {
        source: PROVENANCE_SOURCE.OMS_ORDER_ITEMS,
        window_days: 30,
        shipment_count_30d: dc.total_shipments_30d ?? null,
        latest_observed_at: null,
        note: 'latest_observed_at not surfaced by upstream channelSalesEvidence',
      }
    : { source: PROVENANCE_SOURCE.UNKNOWN, window_days: null, shipment_count_30d: null, latest_observed_at: null, note: 'demand upstream missing' };

  // Supply — replacementSupplyCurveService gives observation counts via
  //   secondary_market_depth[i].{fresh_observations, total} · replacement_price_observed_at
  //   is the freshest supply-side observation timestamp when present.
  const supplyProvenance = _hasAny(supply)
    ? {
        source: PROVENANCE_SOURCE.PHYSICAL_MARKET_OBSERVATIONS,
        observations_count: supply.observation_count ?? null,
        current_supply_layers: supply.current_supply_layers ?? null,
        secondary_market_fresh_observations: _sumSecondaryFresh(supply.secondary_market_depth),
        freshest_observation_at: historyCtx.replacement_price_observed_at ?? null,
        freshness_policy_days: null,   // not surfaced by upstream policy at Phase 8E level
        latest_snapshot_id: historyCtx.latest_snapshot_id ?? null,
        latest_snapshot_calculated_at: historyCtx.latest_snapshot_calculated_at ?? null,
        latest_snapshot_engine_version: historyCtx.latest_snapshot_engine_version ?? null,
      }
    : { source: PROVENANCE_SOURCE.UNKNOWN, observations_count: null, current_supply_layers: null, secondary_market_fresh_observations: null, freshest_observation_at: null, freshness_policy_days: null, latest_snapshot_id: null, latest_snapshot_calculated_at: null, latest_snapshot_engine_version: null };

  const costProvenance = {
    historical_typical_supplier_cost_krw_median: histCost
      ? {
          source: PROVENANCE_SOURCE.PHYSICAL_MARKET_OBSERVATIONS,
          observation_count: histCost.observation_count ?? null,
          currency: histCost.currency ?? null,
          status: histCost.status ?? null,
          note: histCost.note ?? null,
          oldest_observed_at: null,
          freshest_observed_at: null,
        }
      : { source: PROVENANCE_SOURCE.UNKNOWN, observation_count: null, currency: null, status: null, note: null, oldest_observed_at: null, freshest_observed_at: null },
    historical_accounting_cost_krw: (hold.historical_accounting_cost && hold.historical_accounting_cost.cost_krw != null)
      ? {
          source: PROVENANCE_SOURCE.INTERNAL_ACCOUNTING,
          observation_count: null,
          note: hold.historical_accounting_cost.note ?? null,
          oldest_observed_at: null,
          freshest_observed_at: null,
        }
      : { source: PROVENANCE_SOURCE.UNKNOWN, observation_count: null, note: null, oldest_observed_at: null, freshest_observed_at: null },
    observed_secondary_market_ask_min_krw: (supply.observed_secondary_market_unit_cost_min != null)
      ? {
          source: PROVENANCE_SOURCE.PHYSICAL_MARKET_OBSERVATIONS,
          observation_count: _sumSecondaryFresh(supply.secondary_market_depth),
          freshest_observed_at: null,   // per-bucket timestamps not surfaced
          note: 'secondary market ask min · not an executable quote',
        }
      : { source: PROVENANCE_SOURCE.UNKNOWN, observation_count: null, freshest_observed_at: null, note: null },
  };

  return {
    inventory: inventoryProvenance,
    demand: demandProvenance,
    supply: supplyProvenance,
    cost_context: costProvenance,
    note: 'Metadata projection from strategic_hold_source · NO new DB query · unavailable fields are null / UNKNOWN (Owner rule 6)',
  };
}

function _hasAny(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) if (obj[k] !== null && obj[k] !== undefined) return true;
  return false;
}
function _sumSecondaryFresh(depth) {
  if (!Array.isArray(depth)) return null;
  const total = depth.reduce((sum, b) => sum + (Number(b?.fresh_observations) || 0), 0);
  return Number.isFinite(total) ? total : null;
}

function _errorProjection(physicalProductId, asOf, decisionResult) {
  return {
    physical_product_id: physicalProductId,
    generated_at: new Date(asOf).toISOString(),
    error: decisionResult.error || 'unknown_error',
    headline: {
      decision_status: DECISION.INSUFFICIENT_DATA,
      confidence_level: 'low',
      priority_score: 0,
      urgency_label: 'data_quality',
      one_line_summary: `INSUFFICIENT_DATA · ${decisionResult.error || 'unknown_error'}`,
    },
    product: null,
    inventory: null,
    demand: null,
    supply: null,
    cost_context: null,
    reasons: {
      reason_codes: [decisionResult.error || 'unknown_error'],
      hold_quantity_blockers: [],
      missing_evidence: [decisionResult.error || 'unknown_error'],
    },
    recommended_actions: [_makeAction(ACTION.REVIEW_DATA_QUALITY, {
      label: 'Review data quality',
      description: 'Physical product data missing or assess failed — no decision possible.',
      risk_level: 'none',
    })],
    // Phase 8K · error path · everything is UNKNOWN because no upstream data
    recommended_evidence_actions: [ACTION.REVIEW_DATA_QUALITY],
    judgment_confidence: {
      overall_tier: 'UNKNOWN',
      headline_confidence_level: 'low',
      derived_matches_headline: false,
      by_dimension: {
        demand:   { tier: 'UNKNOWN', trusted: null, trust_reason: null, recommended_evidence_actions: [ACTION.REVIEW_DATA_QUALITY] },
        supply:   { tier: 'UNKNOWN', current_supply_quality: null, evidence_confidence_upstream: null, current_supply_layers: null, has_current_supplier_or_executable: null, secondary_market_dependency_at_60: null, recommended_evidence_actions: [] },
        cost:     { tier: 'UNKNOWN', category_tiers: { supplier: 'UNKNOWN', accounting: 'UNKNOWN', secondary_market: 'UNKNOWN' }, freshness_verified: false, typical_supplier_observation_count: null, secondary_market_fresh_observations_count: null, recommended_evidence_actions: [ACTION.REVIEW_DATA_QUALITY] },
        identity: { tier: 'UNKNOWN', identity_verified: null, hold_quantity_blockers: [], recommended_evidence_actions: [] },
      },
      note: 'error path — no upstream data available',
    },
    data_provenance: {
      inventory:    { source: 'UNKNOWN', as_of: null, snapshot_id: null, note: 'error path — no upstream data' },
      demand:       { source: 'UNKNOWN', window_days: null, shipment_count_30d: null, latest_observed_at: null, note: 'error path — no upstream data' },
      supply:       { source: 'UNKNOWN', observations_count: null, current_supply_layers: null, secondary_market_fresh_observations: null, freshest_observation_at: null, freshness_policy_days: null, latest_snapshot_id: null, latest_snapshot_calculated_at: null, latest_snapshot_engine_version: null },
      cost_context: {
        historical_typical_supplier_cost_krw_median: { source: 'UNKNOWN', observation_count: null, currency: null, status: null, note: null, oldest_observed_at: null, freshest_observed_at: null },
        historical_accounting_cost_krw:              { source: 'UNKNOWN', observation_count: null, note: null, oldest_observed_at: null, freshest_observed_at: null },
        observed_secondary_market_ask_min_krw:       { source: 'UNKNOWN', observation_count: null, freshest_observed_at: null, note: null },
      },
      note: 'error path — no upstream data available',
    },
    forbidden_automatic_actions: [...FORBIDDEN_AUTOMATIC_ACTIONS],
    priority_reasons: [],
    source_snapshot: { inventory_decision: decisionResult },
  };
}

module.exports = {
  buildOwnerDecision,
  formatCompactOwnerSummary,
  ACTION,
  FORBIDDEN_AUTOMATIC_ACTIONS,
  PROVENANCE_SOURCE,   // Phase 8K
  _internals: { _buildReasonExplanations, _buildDataProvenance },   // test hooks
};
