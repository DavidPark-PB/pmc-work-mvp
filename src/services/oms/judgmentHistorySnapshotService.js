'use strict';

/**
 * src/services/oms/judgmentHistorySnapshotService.js — Phase 8M.
 *
 * Pure snapshot builder + read-only diff over two Owner Decisions.
 *
 * Answers: "왜 이 상품의 판단이 바뀌었는가?"
 *
 * SAFETY (Phase 8M scope):
 *   • Pure functions · zero DB / API / marketplace / migration
 *   • No persistence — snapshots stay in memory of the caller. Any
 *     persistence layer (DB table / evidence log) is a FUTURE step that
 *     will require a Supabase migration → Owner approval.
 *   • Read-only contract · never mutates the passed ownerDecision(s)
 *   • Phase 8K judgment_confidence / provenance schemas UNCHANGED
 *
 * OUTPUT SHAPES:
 *   snapshot: { snapshot_at, physical_product_id, decision, priority,
 *               urgency, confidence, key_reasons, financial_metrics_summary,
 *               provenance_summary, source_generated_at }
 *   diff:     { changed[], unchanged_count, before_snapshot_at,
 *               after_snapshot_at, delta[] }
 *
 * NEVER invents fields · every value verbatim from the input projection.
 */

const CHANGE_KIND = Object.freeze({
  DECISION_CHANGED:               'DECISION_CHANGED',
  PRIORITY_CHANGED:               'PRIORITY_CHANGED',
  URGENCY_CHANGED:                'URGENCY_CHANGED',
  CONFIDENCE_TIER_CHANGED:        'CONFIDENCE_TIER_CHANGED',
  REASON_CODES_CHANGED:           'REASON_CODES_CHANGED',
  COST_CONTEXT_CHANGED:           'COST_CONTEXT_CHANGED',
  FINANCIAL_METRIC_STATUS_FLIP:   'FINANCIAL_METRIC_STATUS_FLIP',
  FINANCIAL_METRIC_AMOUNT_CHANGED:'FINANCIAL_METRIC_AMOUNT_CHANGED',
});

/**
 * Build a compact snapshot from an ownerDecision + optional financialMetrics.
 *
 * @param {Object} ownerDecision   result of buildOwnerDecision
 * @param {Object} [financialMetrics]  result of buildFinancialMetrics (optional)
 * @param {Object} [opts]
 * @param {string} [opts.snapshotAt=new Date().toISOString()]
 *        Caller-supplied timestamp. Snapshots the moment the Owner
 *        viewed / captured this state. Never derived internally.
 * @returns {Object}
 */
function buildJudgmentHistorySnapshot(ownerDecision, financialMetrics = null, opts = {}) {
  if (opts.snapshotAt == null) {
    throw new Error('buildJudgmentHistorySnapshot: opts.snapshotAt required (caller-supplied ISO timestamp · never derived).');
  }
  const headline = ownerDecision?.headline || {};
  const reasons = ownerDecision?.reasons || {};
  const jc = ownerDecision?.judgment_confidence || {};
  const jcDims = jc.by_dimension || {};

  return {
    snapshot_at: opts.snapshotAt,
    physical_product_id: ownerDecision?.physical_product_id ?? null,
    source_generated_at: ownerDecision?.generated_at ?? null,
    decision: headline.decision_status ?? null,
    priority: headline.priority_score ?? null,
    urgency: headline.urgency_label ?? null,
    confidence: {
      overall_tier: jc.overall_tier ?? null,
      confidence_level: headline.confidence_level ?? null,
      demand_tier:  jcDims.demand?.tier ?? null,
      supply_tier:  jcDims.supply?.tier ?? null,
      cost_tier:    jcDims.cost?.tier ?? null,
      identity_tier: jcDims.identity?.tier ?? null,
    },
    key_reasons: {
      reason_codes:              (reasons.reason_codes || []).slice(),
      hold_quantity_blockers:    (reasons.hold_quantity_blockers || []).slice(),
      missing_evidence:          (reasons.missing_evidence || []).slice(),
    },
    cost_context_snapshot: _cloneCostContext(ownerDecision?.cost_context),
    financial_metrics_summary: _summariseFinancialMetrics(financialMetrics),
    provenance_summary:        _summariseProvenance(ownerDecision?.data_provenance),
  };
}

/**
 * Diff two snapshots (BEFORE, AFTER). Only reports changed fields.
 *
 * ORDER MATTERS: before is snapshot at time T0, after at T1.
 */
function diffJudgmentHistorySnapshots(before, after) {
  if (!before || !after) throw new Error('diffJudgmentHistorySnapshots: both snapshots required');
  const delta = [];

  if (before.decision !== after.decision) {
    delta.push({ kind: CHANGE_KIND.DECISION_CHANGED, from: before.decision, to: after.decision });
  }
  if (before.priority !== after.priority) {
    delta.push({ kind: CHANGE_KIND.PRIORITY_CHANGED, from: before.priority, to: after.priority });
  }
  if (before.urgency !== after.urgency) {
    delta.push({ kind: CHANGE_KIND.URGENCY_CHANGED, from: before.urgency, to: after.urgency });
  }
  const bc = before.confidence || {}, ac = after.confidence || {};
  for (const dim of ['overall_tier', 'demand_tier', 'supply_tier', 'cost_tier', 'identity_tier', 'confidence_level']) {
    if (bc[dim] !== ac[dim]) {
      delta.push({ kind: CHANGE_KIND.CONFIDENCE_TIER_CHANGED, dimension: dim, from: bc[dim], to: ac[dim] });
    }
  }
  //   Reason codes are ordered sets · diff both additions & removals.
  const brc = new Set((before.key_reasons?.reason_codes) || []);
  const arc = new Set((after.key_reasons?.reason_codes) || []);
  const added = [...arc].filter(x => !brc.has(x));
  const removed = [...brc].filter(x => !arc.has(x));
  if (added.length || removed.length) {
    delta.push({ kind: CHANGE_KIND.REASON_CODES_CHANGED, added, removed });
  }
  //   Cost context field-by-field.
  const bcc = before.cost_context_snapshot || {}, acc = after.cost_context_snapshot || {};
  for (const k of ['historical_typical_supplier_cost_krw_median', 'historical_accounting_cost_krw', 'observed_secondary_market_ask_min_krw']) {
    if (bcc[k] !== acc[k]) {
      delta.push({ kind: CHANGE_KIND.COST_CONTEXT_CHANGED, field: k, from: bcc[k], to: acc[k] });
    }
  }
  //   Financial metrics — status flips and amount changes per scenario/metric.
  const bfm = before.financial_metrics_summary || {};
  const afm = after.financial_metrics_summary || {};
  for (const scenario of ['accounting', 'replacement', 'secondary_market_ask']) {
    const bs = bfm[scenario] || {}, as = afm[scenario] || {};
    for (const metric of ['expected_sale_proceeds', 'gross_profit', 'gross_margin', 'break_even_price', 'inventory_value']) {
      const bm = bs[metric] || {}, am = as[metric] || {};
      if (bm.status !== am.status) {
        delta.push({ kind: CHANGE_KIND.FINANCIAL_METRIC_STATUS_FLIP, scenario, metric, from: bm.status ?? null, to: am.status ?? null });
      } else if (bm.status === 'AVAILABLE' && am.status === 'AVAILABLE') {
        const bv = _metricValue(bm), av = _metricValue(am);
        if (bv !== av) {
          delta.push({ kind: CHANGE_KIND.FINANCIAL_METRIC_AMOUNT_CHANGED, scenario, metric, from: bv, to: av });
        }
      }
    }
  }

  return {
    before_snapshot_at: before.snapshot_at,
    after_snapshot_at: after.snapshot_at,
    physical_product_id: after.physical_product_id ?? before.physical_product_id ?? null,
    changed: delta.map(d => d.kind).filter((k, i, a) => a.indexOf(k) === i),
    unchanged: delta.length === 0,
    delta,
  };
}

// ─── helpers ──────────────────────────────────────────

function _cloneCostContext(cc) {
  if (!cc || typeof cc !== 'object') return {};
  return {
    historical_typical_supplier_cost_krw_median: cc.historical_typical_supplier_cost_krw_median ?? null,
    historical_accounting_cost_krw: cc.historical_accounting_cost_krw ?? null,
    observed_secondary_market_ask_min_krw: cc.observed_secondary_market_ask_min_krw ?? null,
  };
}

function _summariseFinancialMetrics(fm) {
  if (!fm || !fm.scenarios) return {};
  const out = {};
  for (const [k, s] of Object.entries(fm.scenarios)) {
    out[k] = {
      cost_basis_source: s.cost_basis_source,
      cost_basis_krw: s.cost_basis_krw ?? null,
      expected_sale_proceeds: _statusAndAmount(s.expected_sale_proceeds),
      gross_profit: _statusAndAmount(s.gross_profit),
      gross_margin: _statusAndPct(s.gross_margin),
      break_even_price: _statusAndAmount(s.break_even_price),
      inventory_value: _statusAndAmount(s.inventory_value),
    };
  }
  return out;
}
function _statusAndAmount(m) {
  return { status: m?.status ?? null, amount_krw: m?.amount_krw ?? null };
}
function _statusAndPct(m) {
  return { status: m?.status ?? null, pct: m?.pct ?? null };
}
function _metricValue(m) {
  return m?.amount_krw != null ? m.amount_krw : (m?.pct != null ? m.pct : null);
}

function _summariseProvenance(dp) {
  if (!dp || typeof dp !== 'object') return {};
  const out = { sources_seen: new Set(), by_area: {} };
  for (const area of ['inventory', 'demand', 'supply']) {
    const src = dp[area]?.source ?? null;
    if (src) out.sources_seen.add(src);
    out.by_area[area] = { source: src };
  }
  const cc = dp.cost_context || {};
  out.by_area.cost_context = {};
  for (const k of Object.keys(cc)) {
    const src = cc[k]?.source ?? null;
    if (src) out.sources_seen.add(src);
    out.by_area.cost_context[k] = { source: src };
  }
  return { sources_seen: [...out.sources_seen], by_area: out.by_area };
}

module.exports = {
  buildJudgmentHistorySnapshot,
  diffJudgmentHistorySnapshots,
  CHANGE_KIND,
};
