'use strict';

/**
 * src/services/oms/multiProductComparisonService.js — Phase 8N.
 *
 * Read-only side-by-side comparison of multiple physical products so the
 * Owner can decide where to invest time/money first.
 *
 * SAFETY & SCOPE:
 *   • Pure projection over pre-assembled ownerDecisions[] + optional
 *     financialMetrics[]. No DB / API / marketplace calls · no scoring
 *     algorithm invented · never re-ranks or re-orders based on new logic.
 *   • Preserves existing priority (Phase 8B/8I ranking) as the primary
 *     ordering signal · financial metrics rendered side-by-side (Owner
 *     rule §8N: "existing priority + financial metrics 나란히").
 *   • UNKNOWN never rendered as 0. Category blending never happens.
 *
 * INPUT:
 *   items[] = [
 *     { ownerDecision, financialMetrics?, ... },
 *     ...
 *   ]
 *
 * OUTPUT:
 *   { generated_at, rows[], columns[], caveats[] }
 *   rows[] preserves input order (caller ranks it first, e.g. by priority).
 */

const DEFAULT_COLUMNS = Object.freeze([
  'physical_product_id',
  'title',
  'decision',
  'priority',
  'urgency',
  'confidence_level',
  'confidence_overall_tier',
  'on_hand',
  'available',
  'replacement_difficulty',
  'has_current_supplier_or_executable',
  'cost_context.historical_accounting_cost_krw',
  'cost_context.historical_typical_supplier_cost_krw_median',
  'cost_context.observed_secondary_market_ask_min_krw',
  'financial.accounting.expected_sale_proceeds',
  'financial.accounting.gross_profit',
  'financial.accounting.gross_margin_pct',
  'financial.accounting.break_even_price',
  'financial.accounting.inventory_value',
  'financial.replacement.gross_profit',
  'financial.replacement.gross_margin_pct',
  'financial.secondary_market_ask.gross_profit',
  'financial.secondary_market_ask.gross_margin_pct',
  'missing_evidence_count',
  'data_quality_flag',
]);

function buildMultiProductComparison(items = [], opts = {}) {
  const columns = Array.isArray(opts.columns) && opts.columns.length ? opts.columns : DEFAULT_COLUMNS;
  const rows = [];
  const generated_at = opts.generatedAt || null;
  for (const item of items) {
    if (!item) continue;
    const od = item.ownerDecision || null;
    if (!od) continue;
    const fm = item.financialMetrics || null;
    rows.push(_projectRow(od, fm));
  }
  const caveats = [
    'ordering preserved from caller · this service NEVER re-ranks or invents an ROI score',
    'financial metrics are additive · missing inputs surface as "확인되지 않음" (never 0)',
    'secondary_market_ask columns are REFERENCE ONLY · not supplier or accounting cost',
    'category blending prohibited · each scenario evaluated independently',
  ];
  return { generated_at, columns: [...columns], rows, caveats };
}

function _projectRow(od, fm) {
  const headline = od.headline || {};
  const inv = od.inventory || {};
  const sp = od.supply || {};
  const cc = od.cost_context || {};
  const reasons = od.reasons || {};
  const jc = od.judgment_confidence || {};
  const jcDims = jc.by_dimension || {};

  const fmScenarios = (fm && fm.scenarios) || {};

  return {
    physical_product_id: od.physical_product_id ?? null,
    title: od.product?.title ?? null,
    set_code: od.product?.set_code ?? null,
    language: od.product?.language ?? null,

    decision: headline.decision_status ?? null,
    priority: headline.priority_score ?? null,
    urgency: headline.urgency_label ?? null,
    confidence_level: headline.confidence_level ?? null,
    confidence_overall_tier: jc.overall_tier ?? null,
    confidence_by_dimension: {
      demand:  jcDims.demand?.tier ?? null,
      supply:  jcDims.supply?.tier ?? null,
      cost:    jcDims.cost?.tier ?? null,
      identity: jcDims.identity?.tier ?? null,
    },

    on_hand: inv.on_hand ?? null,
    available: inv.available ?? null,
    replacement_difficulty: sp.replacement_difficulty ?? null,
    has_current_supplier_or_executable: sp.has_current_supplier_or_executable ?? null,
    supplier_diversity: sp.supplier_diversity ?? null,
    current_supply_quality: sp.current_supply_quality ?? null,

    cost_context: {
      historical_accounting_cost_krw:              cc.historical_accounting_cost_krw ?? null,
      historical_typical_supplier_cost_krw_median: cc.historical_typical_supplier_cost_krw_median ?? null,
      observed_secondary_market_ask_min_krw:       cc.observed_secondary_market_ask_min_krw ?? null,
    },

    financial: {
      accounting:            _projectScenario(fmScenarios.accounting),
      replacement:           _projectScenario(fmScenarios.replacement),
      secondary_market_ask:  _projectScenario(fmScenarios.secondary_market_ask),
    },

    missing_evidence_count: (reasons.missing_evidence || []).length,
    data_quality_flag: headline.decision_status === 'INSUFFICIENT_DATA' ? true : false,
  };
}

function _projectScenario(s) {
  if (!s) {
    return {
      cost_basis_source: null,
      cost_basis_krw: null,
      expected_sale_proceeds: { status: 'UNKNOWN', amount_krw: null },
      gross_profit: { status: 'UNKNOWN', amount_krw: null },
      gross_margin_pct: { status: 'UNKNOWN', pct: null },
      break_even_price: { status: 'UNKNOWN', amount_krw: null },
      inventory_value: { status: 'UNKNOWN', amount_krw: null },
    };
  }
  return {
    cost_basis_source: s.cost_basis_source ?? null,
    cost_basis_krw: s.cost_basis_krw ?? null,
    expected_sale_proceeds: _sa(s.expected_sale_proceeds),
    gross_profit: _sa(s.gross_profit),
    gross_margin_pct: { status: s.gross_margin?.status ?? 'UNKNOWN', pct: s.gross_margin?.pct ?? null },
    break_even_price: _sa(s.break_even_price),
    inventory_value: _sa(s.inventory_value),
  };
}
function _sa(m) {
  return { status: m?.status ?? 'UNKNOWN', amount_krw: m?.amount_krw ?? null };
}

module.exports = {
  buildMultiProductComparison,
  DEFAULT_COLUMNS,
};
