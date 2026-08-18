'use strict';

/**
 * src/services/oms/financialMetricsService.js — Phase 8L.
 *
 * Additive read-only calculation surface for 5 financial metrics:
 *
 *   1. expected_sale_proceeds  = sale_price - marketplace_fee - shipping
 *   2. gross_profit            = expected_sale_proceeds - cost_basis
 *   3. gross_margin_pct        = gross_profit / expected_sale_proceeds
 *   4. break_even_price        = (cost_basis + shipping + fixed_fee) / (1 - fee_pct)
 *   5. inventory_value         = quantity × per_unit_cost   (single category, no blending)
 *
 * INPUT CONTRACT — all monetary amounts KRW. Caller is responsible for FX
 *   prior to call. FX ambiguity at call site → pass null → metric UNKNOWN.
 *
 * COST BASIS — caller MUST explicitly choose a single category. This
 *   module NEVER blends supplier / accounting / secondary market values.
 *   Recognized values: 'sku_master_cost_krw', 'historical_supplier_median_krw',
 *   'secondary_ask_min_krw', 'landed_cost_krw', 'supplier_quote_krw'.
 *
 * OUTPUT CONTRACT — every metric returns {status, ...fields, formula,
 *   provenance}. status is 'AVAILABLE' or 'UNKNOWN'. Amounts are null
 *   when UNKNOWN. NEVER fabricated to 0.
 *
 * DECISION CONTRACT UNCHANGED — this module never modifies
 *   inventoryOwnerDecisionService output shape. Callers invoke it
 *   separately with explicit inputs and surface the result as an
 *   optional additive read-only extension.
 */

// Reuse existing marketplace fee default from Hermes Phase 18A.
//   Keeping the same constant guarantees no drift between calculators.
const { ASSUMPTIONS: HERMES_ASSUMPTIONS } = require('../listingProfitabilityCalculator');
const DEFAULT_MARKETPLACE_FEE_PCT = HERMES_ASSUMPTIONS.ebay_fee_pct;   // 0.18

const COST_BASIS_SOURCES = Object.freeze([
  'sku_master_cost_krw',
  'historical_supplier_median_krw',
  'secondary_ask_min_krw',
  'landed_cost_krw',
  'supplier_quote_krw',
]);

const INVENTORY_VALUE_CATEGORY = Object.freeze({
  ACCOUNTING:                'accounting',
  REPLACEMENT:               'replacement',
  SECONDARY_MARKET_ASK:      'secondary_market_ask',
});

/**
 * Compute expected_sale_proceeds = sale_price - marketplace_fee - shipping.
 *
 * @param {Object} args
 * @param {number|null} args.expected_sale_price_krw       explicit sale price KRW
 * @param {string|null} args.expected_sale_price_source    provenance label
 * @param {number|null} [args.marketplace_fee_pct]         defaults to 0.18
 * @param {number|null} [args.marketplace_fixed_fee_krw]   defaults to 0
 * @param {number|null} args.seller_borne_shipping_krw     null → UNKNOWN (not 0)
 * @param {string|null} [args.shipping_source]             provenance label
 * @returns {Object}
 */
function computeExpectedSaleProceeds(args = {}) {
  const missing = [];
  const salePrice = _positiveKrwOrNull(args.expected_sale_price_krw);
  if (salePrice == null) missing.push('expected_sale_price_krw');

  const shippingKrw = _nonNegativeKrwOrNull(args.seller_borne_shipping_krw);
  if (shippingKrw == null) missing.push('seller_borne_shipping_krw');

  const feePct = _feePctOrDefault(args.marketplace_fee_pct);
  if (feePct == null) missing.push('marketplace_fee_pct');
  const fixedFee = _nonNegativeKrwOrDefault(args.marketplace_fixed_fee_krw, 0);

  const formula = 'sale_price_krw - (sale_price_krw × fee_pct + fixed_fee_krw) - shipping_krw';

  if (missing.length > 0) {
    return {
      status: 'UNKNOWN',
      amount_krw: null,
      formula,
      missing,
      provenance: {
        expected_sale_price_source: args.expected_sale_price_source ?? null,
        shipping_source: args.shipping_source ?? null,
        marketplace_fee_pct: feePct,
        marketplace_fixed_fee_krw: fixedFee,
      },
    };
  }

  const marketplaceFeeKrw = Math.round(salePrice * feePct + fixedFee);
  const amount = _roundKrw(salePrice - marketplaceFeeKrw - shippingKrw);

  return {
    status: 'AVAILABLE',
    amount_krw: amount,
    formula,
    breakdown: {
      sale_price_krw: salePrice,
      marketplace_fee_krw: marketplaceFeeKrw,
      shipping_krw: shippingKrw,
    },
    provenance: {
      expected_sale_price_source: args.expected_sale_price_source ?? null,
      shipping_source: args.shipping_source ?? null,
      marketplace_fee_pct: feePct,
      marketplace_fixed_fee_krw: fixedFee,
    },
  };
}

/**
 * Compute gross_profit = expected_sale_proceeds - cost_basis.
 *
 * Cost basis MUST be an explicit single-category value. This function
 * NEVER derives, averages, or blends across supplier / accounting /
 * secondary market observations.
 *
 * @param {Object} args
 * @param {Object} args.expected_sale_proceeds   result of computeExpectedSaleProceeds
 * @param {number|null} args.cost_basis_krw      per-physical-unit KRW cost basis
 * @param {string} args.cost_basis_source        one of COST_BASIS_SOURCES
 */
function computeGrossProfit(args = {}) {
  const missing = [];
  const proceeds = args.expected_sale_proceeds || null;
  if (!proceeds || proceeds.status !== 'AVAILABLE' || proceeds.amount_krw == null) {
    missing.push('expected_sale_proceeds');
  }

  const cost = _positiveKrwOrNull(args.cost_basis_krw);
  if (cost == null) missing.push('cost_basis_krw');

  const source = args.cost_basis_source ?? null;
  if (!COST_BASIS_SOURCES.includes(source)) {
    missing.push('cost_basis_source_must_be_one_of_COST_BASIS_SOURCES');
  }

  const formula = 'expected_sale_proceeds_krw - cost_basis_krw';

  if (missing.length > 0) {
    return {
      status: 'UNKNOWN',
      amount_krw: null,
      formula,
      missing,
      provenance: {
        cost_basis_source: source,
        proceeds_status: proceeds ? proceeds.status : null,
      },
    };
  }

  const amount = _roundKrw(proceeds.amount_krw - cost);

  return {
    status: 'AVAILABLE',
    amount_krw: amount,
    formula,
    breakdown: {
      expected_sale_proceeds_krw: proceeds.amount_krw,
      cost_basis_krw: cost,
    },
    provenance: {
      cost_basis_source: source,
      proceeds_status: proceeds.status,
    },
  };
}

/**
 * Compute gross_margin_pct = gross_profit / expected_sale_proceeds.
 *
 * MARGIN semantics (profit / revenue) — NOT markup (profit / cost).
 * Denominator zero or non-positive → UNKNOWN (never 0 or NaN or Infinity).
 */
function computeGrossMargin(args = {}) {
  const missing = [];
  const gp = args.gross_profit || null;
  if (!gp || gp.status !== 'AVAILABLE' || gp.amount_krw == null) missing.push('gross_profit');

  const proceeds = args.expected_sale_proceeds || null;
  if (!proceeds || proceeds.status !== 'AVAILABLE' || proceeds.amount_krw == null) {
    missing.push('expected_sale_proceeds');
  }

  const formula = 'gross_profit_krw / expected_sale_proceeds_krw × 100 (MARGIN · NOT markup)';

  if (missing.length > 0) {
    return { status: 'UNKNOWN', pct: null, formula, missing };
  }
  if (!(proceeds.amount_krw > 0)) {
    return {
      status: 'UNKNOWN', pct: null, formula,
      missing: ['expected_sale_proceeds_must_be_positive_for_margin'],
      note: `denominator ${proceeds.amount_krw} is not positive · margin undefined`,
    };
  }

  const raw = (gp.amount_krw / proceeds.amount_krw) * 100;
  const pct = Math.round(raw * 10000) / 10000;   // 4 decimals

  return {
    status: 'AVAILABLE',
    pct,
    formula,
    breakdown: {
      gross_profit_krw: gp.amount_krw,
      expected_sale_proceeds_krw: proceeds.amount_krw,
    },
  };
}

/**
 * Compute break_even_price = (cost_basis + shipping + fixed_fee) / (1 - fee_pct).
 *
 * Inverse of the marketplace-fee percentage. When fee_pct >= 1 the
 * inverse is undefined (division by zero or negative) → UNKNOWN.
 *
 * Verification: at break-even sale price
 *   proceeds = price × (1 - fee_pct) - fixed_fee - shipping = cost_basis
 *   → price = (cost_basis + shipping + fixed_fee) / (1 - fee_pct)
 */
function computeBreakEvenPrice(args = {}) {
  const missing = [];
  const cost = _positiveKrwOrNull(args.cost_basis_krw);
  if (cost == null) missing.push('cost_basis_krw');

  const source = args.cost_basis_source ?? null;
  if (!COST_BASIS_SOURCES.includes(source)) {
    missing.push('cost_basis_source_must_be_one_of_COST_BASIS_SOURCES');
  }

  const shippingKrw = _nonNegativeKrwOrNull(args.seller_borne_shipping_krw);
  if (shippingKrw == null) missing.push('seller_borne_shipping_krw');

  const feePct = _feePctOrDefault(args.marketplace_fee_pct);
  if (feePct == null) missing.push('marketplace_fee_pct');
  const fixedFee = _nonNegativeKrwOrDefault(args.marketplace_fixed_fee_krw, 0);

  const formula = '(cost_basis_krw + shipping_krw + fixed_fee_krw) / (1 - fee_pct)';

  if (missing.length > 0) {
    return {
      status: 'UNKNOWN', amount_krw: null, formula, missing,
      provenance: { cost_basis_source: source, marketplace_fee_pct: feePct, marketplace_fixed_fee_krw: fixedFee },
    };
  }
  if (!(feePct < 1)) {
    return {
      status: 'UNKNOWN', amount_krw: null, formula,
      missing: ['fee_pct_must_be_less_than_1_for_break_even'],
      note: `fee_pct ${feePct} >= 1 · break-even undefined (denominator <= 0)`,
      provenance: { cost_basis_source: source, marketplace_fee_pct: feePct, marketplace_fixed_fee_krw: fixedFee },
    };
  }

  const amount = _roundKrw((cost + shippingKrw + fixedFee) / (1 - feePct));

  return {
    status: 'AVAILABLE',
    amount_krw: amount,
    formula,
    breakdown: {
      cost_basis_krw: cost,
      shipping_krw: shippingKrw,
      fixed_fee_krw: fixedFee,
      fee_pct: feePct,
      denominator: 1 - feePct,
    },
    provenance: {
      cost_basis_source: source,
      marketplace_fee_pct: feePct,
      marketplace_fixed_fee_krw: fixedFee,
    },
  };
}

/**
 * Compute inventory_value = physical_quantity × per_unit_cost_krw
 * for a SINGLE named cost category. NEVER blends categories.
 *
 * @param {Object} args
 * @param {number|null} args.physical_quantity           integer >= 0
 * @param {number|null} args.per_unit_cost_krw           KRW per physical unit
 * @param {string}      args.cost_basis_source           one of COST_BASIS_SOURCES
 * @param {string}      args.category                    one of INVENTORY_VALUE_CATEGORY
 */
function computeInventoryValue(args = {}) {
  const missing = [];
  const qty = _nonNegativeIntegerOrNull(args.physical_quantity);
  if (qty == null) missing.push('physical_quantity');

  const perUnit = _positiveKrwOrNull(args.per_unit_cost_krw);
  if (perUnit == null) missing.push('per_unit_cost_krw');

  const source = args.cost_basis_source ?? null;
  if (!COST_BASIS_SOURCES.includes(source)) {
    missing.push('cost_basis_source_must_be_one_of_COST_BASIS_SOURCES');
  }

  const category = args.category ?? null;
  const validCategory = Object.values(INVENTORY_VALUE_CATEGORY).includes(category);
  if (!validCategory) missing.push('category_must_be_one_of_INVENTORY_VALUE_CATEGORY');

  const formula = 'physical_quantity × per_unit_cost_krw (single category · no blending)';

  if (missing.length > 0) {
    return {
      status: 'UNKNOWN', amount_krw: null, per_unit_krw: null, quantity: null,
      category: category || null,
      formula, missing,
      provenance: { cost_basis_source: source },
    };
  }

  const amount = _roundKrw(qty * perUnit);

  return {
    status: 'AVAILABLE',
    amount_krw: amount,
    per_unit_krw: perUnit,
    quantity: qty,
    category,
    formula,
    provenance: {
      cost_basis_source: source,
    },
  };
}

/**
 * Aggregate convenience — compute all 5 metrics with a single input bag.
 * Failures cascade: gross_profit UNKNOWN if proceeds UNKNOWN; margin
 * UNKNOWN if either UNKNOWN. inventory_value and break_even_price are
 * INDEPENDENT of proceeds (compute standalone from their own inputs).
 */
function computeFinancialMetrics(args = {}) {
  const expected_sale_proceeds = computeExpectedSaleProceeds(args);
  const gross_profit = computeGrossProfit({ ...args, expected_sale_proceeds });
  const gross_margin = computeGrossMargin({ expected_sale_proceeds, gross_profit });
  const break_even_price = computeBreakEvenPrice(args);
  const inventory_value = computeInventoryValue(args);
  return {
    expected_sale_proceeds,
    gross_profit,
    gross_margin,
    break_even_price,
    inventory_value,
  };
}

// ─── input validators ───────────────────────────────────

function _positiveKrwOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function _nonNegativeKrwOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function _nonNegativeKrwOrDefault(v, def) {
  if (v === undefined || v === null) return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
function _nonNegativeIntegerOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function _feePctOrDefault(v) {
  if (v === undefined || v === null) return DEFAULT_MARKETPLACE_FEE_PCT;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : null;
}
function _roundKrw(v) {
  return Math.round(v);
}

module.exports = {
  computeExpectedSaleProceeds,
  computeGrossProfit,
  computeGrossMargin,
  computeBreakEvenPrice,
  computeInventoryValue,
  computeFinancialMetrics,
  COST_BASIS_SOURCES,
  INVENTORY_VALUE_CATEGORY,
  DEFAULT_MARKETPLACE_FEE_PCT,
};
