'use strict';

/**
 * src/services/oms/financialMetricsAssembler.js — Phase 8L integration.
 *
 * Thin adapter: takes an existing Owner Decision projection (from
 * buildOwnerDecision) and optional caller-supplied sale-price/shipping
 * context, produces 3 INDEPENDENT cost-basis scenarios:
 *
 *   • accounting            (sku_master.cost_krw baseline · historical)
 *   • replacement           (historical supplier median · caller opt-in)
 *   • secondary_market_ask  (secondary min · REFERENCE ONLY, not supplier)
 *
 * NEVER blends categories. NEVER auto-derives sale price. NEVER auto-uses
 * secondary ask as supplier/accounting cost. If any input is missing,
 * the affected metrics return status='UNKNOWN' verbatim from the
 * calculation service.
 *
 * CONTRACT PROMISES:
 *   • Zero DB / API / marketplace queries — pure projection over already
 *     assembled ownerDecision fields.
 *   • Owner Decision output shape UNCHANGED — this returns a separate
 *     `financial_metrics` object the route surfaces as an additive field.
 *   • Phase 8K decision/action/priority/urgency/judgment_confidence/provenance
 *     never modified.
 */

const fm = require('./financialMetricsService');

/**
 * @param {Object} ownerDecision      output of inventoryOwnerDecisionService.buildOwnerDecision
 * @param {Object} [opts]
 * @param {number|null} [opts.expected_sale_price_krw]
 * @param {string|null} [opts.expected_sale_price_source]
 * @param {number|null} [opts.seller_borne_shipping_krw]
 * @param {string|null} [opts.shipping_source]
 * @param {number|null} [opts.marketplace_fee_pct]
 * @param {number|null} [opts.marketplace_fixed_fee_krw]
 * @returns {Object} {
 *   scenarios: { accounting, replacement, secondary_market_ask },
 *   inputs_used: {...},
 *   missing_inputs: [...],
 *   caveats: [...],
 * }
 */
function buildFinancialMetrics(ownerDecision, opts = {}) {
  const cc = (ownerDecision && ownerDecision.cost_context) || {};
  const inv = (ownerDecision && ownerDecision.inventory) || {};
  const missing_inputs = [];
  const caveats = [];

  // Sale-price + shipping are caller-supplied (Owner rule §3). Never
  //   auto-derive. Missing → downstream UNKNOWN, not zero.
  const salePriceKrw = _finiteOrNull(opts.expected_sale_price_krw);
  const salePriceSrc = opts.expected_sale_price_source ?? null;
  const shippingKrw = _finiteOrNull(opts.seller_borne_shipping_krw);
  const shippingSrc = opts.shipping_source ?? null;
  if (salePriceKrw == null) missing_inputs.push('expected_sale_price_krw');
  if (shippingKrw == null) missing_inputs.push('seller_borne_shipping_krw');

  const feePct = _finiteOrNull(opts.marketplace_fee_pct);
  const fixedFee = _finiteOrNull(opts.marketplace_fixed_fee_krw);

  const commonPricingInputs = {
    expected_sale_price_krw: salePriceKrw,
    expected_sale_price_source: salePriceSrc,
    seller_borne_shipping_krw: shippingKrw,
    shipping_source: shippingSrc,
    marketplace_fee_pct: feePct,
    marketplace_fixed_fee_krw: fixedFee,
  };

  // On-hand physical quantity for inventory value. `on_hand` is the
  //   physical-unit count from inventoryShadowService verbatim. Caller MUST
  //   ensure per-unit cost is expressed per the same physical unit
  //   (per IV8 semantics test).
  const onHand = _finiteIntOrNull(inv.on_hand);
  if (onHand == null) missing_inputs.push('physical_quantity_on_hand');

  const scenarios = {
    accounting: _computeScenario({
      pricing: commonPricingInputs,
      cost_krw: _finiteOrNull(cc.historical_accounting_cost_krw),
      cost_source: 'sku_master_cost_krw',
      category: 'accounting',
      physical_quantity: onHand,
      cost_note: 'sku_master.cost_krw · last-known wholesale · NOT timestamped · NOT current replacement cost',
    }),
    replacement: _computeScenario({
      pricing: commonPricingInputs,
      cost_krw: _finiteOrNull(cc.historical_typical_supplier_cost_krw_median),
      cost_source: 'historical_supplier_median_krw',
      category: 'replacement',
      physical_quantity: onHand,
      cost_note: 'historical supplier reference median · never current executable · Owner Part 6',
    }),
    secondary_market_ask: _computeScenario({
      pricing: commonPricingInputs,
      cost_krw: _finiteOrNull(cc.observed_secondary_market_ask_min_krw),
      cost_source: 'secondary_ask_min_krw',
      category: 'secondary_market_ask',
      physical_quantity: onHand,
      cost_note: '시장 참고가 · SECONDARY MARKET ASK · NOT a supplier quote · NOT accounting cost',
    }),
  };

  // Category cross-check caveats (Owner rule §5)
  if (scenarios.secondary_market_ask.inventory_value.status === 'AVAILABLE') {
    caveats.push('inventory_value.secondary_market_ask is a MARKET REFERENCE valuation · not an accounting figure');
  }
  if (scenarios.replacement.inventory_value.status === 'AVAILABLE') {
    caveats.push('inventory_value.replacement uses historical supplier reference · not current executable cost');
  }

  return {
    generated_at: ownerDecision?.generated_at ?? null,
    physical_product_id: ownerDecision?.physical_product_id ?? null,
    scenarios,
    inputs_used: {
      pricing: commonPricingInputs,
      physical_quantity_on_hand: onHand,
      cost_context_snapshot: {
        historical_accounting_cost_krw: _finiteOrNull(cc.historical_accounting_cost_krw),
        historical_typical_supplier_cost_krw_median: _finiteOrNull(cc.historical_typical_supplier_cost_krw_median),
        observed_secondary_market_ask_min_krw: _finiteOrNull(cc.observed_secondary_market_ask_min_krw),
      },
    },
    missing_inputs,
    caveats,
    note: 'ADDITIVE read-only projection · Owner Decision contract UNCHANGED · category blending prohibited · UNKNOWN never rendered as 0',
  };
}

function _computeScenario({ pricing, cost_krw, cost_source, category, physical_quantity, cost_note }) {
  const expected_sale_proceeds = fm.computeExpectedSaleProceeds(pricing);
  const gross_profit = fm.computeGrossProfit({
    expected_sale_proceeds,
    cost_basis_krw: cost_krw,
    cost_basis_source: cost_source,
  });
  const gross_margin = fm.computeGrossMargin({ expected_sale_proceeds, gross_profit });
  const break_even_price = fm.computeBreakEvenPrice({
    cost_basis_krw: cost_krw,
    cost_basis_source: cost_source,
    seller_borne_shipping_krw: pricing.seller_borne_shipping_krw,
    marketplace_fee_pct: pricing.marketplace_fee_pct,
    marketplace_fixed_fee_krw: pricing.marketplace_fixed_fee_krw,
  });
  const inventory_value = fm.computeInventoryValue({
    physical_quantity,
    per_unit_cost_krw: cost_krw,
    cost_basis_source: cost_source,
    category,
  });
  return {
    cost_basis_source: cost_source,
    category,
    cost_basis_krw: cost_krw,
    cost_basis_note: cost_note,
    expected_sale_proceeds,
    gross_profit,
    gross_margin,
    break_even_price,
    inventory_value,
  };
}

function _finiteOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _finiteIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

module.exports = {
  buildFinancialMetrics,
};
