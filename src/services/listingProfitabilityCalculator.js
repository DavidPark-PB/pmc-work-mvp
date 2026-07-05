'use strict';

/**
 * Hermes Phase 18A — read-only listing profitability calculator.
 *
 * Local CSV export/validation/calculation only. No marketplace calls, DB writes,
 * AI calls, execution requests, packets, or listing mutations.
 */

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const ASSUMPTIONS = {
  usd_krw: 1450,
  ebay_fee_pct: 0.18,
  destination_country: '미국',
};

const INPUT_COLUMNS = [
  'item_id',
  'sku',
  'title',
  'current_price_usd',
  'quantity',
  'quantity_sold',
  'listing_type',
  'view_url',
  'image_url',
  'product_cost_krw',
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'operator_note',
];

const PHASE = '18A';
const TEST_SANDBOX_RE = /(test|sample|mock|demo)/i;

const FUEL_SURCHARGE = {
  KPL: 0,
  '쉽터': 0,
  '윤': 2000,
  'EMS프리미엄': 0,
  'K-Packet': 0,
};

const KPACKET_RATES_US = [
  [0.1, 3500], [0.2, 6100], [0.3, 8700], [0.5, 13900],
  [1.0, 23000], [1.5, 32100], [2.0, 41200],
];

const KPL_US = {
  divisor: 6000,
  service: 'EXD-CD/EE',
  unit: 'kg',
  rates: [
    [0.5, 13900], [1.0, 18900], [1.5, 24900], [2.0, 52290], [2.5, 56700],
    [3.0, 61050], [3.5, 65400], [4.0, 69750], [4.5, 74090], [5.0, 78440],
    [6.0, 86880], [7.0, 95320], [8.0, 103770], [9.0, 112210], [10.0, 120650],
    [15.0, 162860], [20.0, 200850],
  ],
};

const SHIPTER_US = {
  divisor: 5000,
  service: 'US_PRIO',
  unit: 'kg',
  note: '화물에 15% 세금 발생 주의',
  rates: [
    [0.5, 34900], [1.0, 43200], [1.5, 52200], [2.0, 59100], [2.5, 66900],
    [3.0, 74500], [3.5, 78900], [4.0, 83400], [4.5, 87900], [5.0, 92300],
    [6.0, 107000], [7.0, 115000], [8.0, 124000], [9.0, 133000], [10.0, 143000],
    [15.0, 190000], [20.0, 237000],
  ],
};

const YUN_US = {
  divisor: 6000,
  service: '표준(KRTHZXR)',
  unit: 'g',
  rates: [
    [500, 12000], [1000, 17000], [1500, 22000], [2000, 27000], [2500, 32000],
    [3000, 38000], [4000, 48000], [5000, 60000], [10000, 100000],
  ],
};

const EMS_PREMIUM_US_ZONE_E = [
  [71, 713310], [75, 749750], [80, 795300], [90, 886400], [100, 863500],
  [110, 943200], [120, 1022900], [130, 1102600], [140, 1182300], [150, 1262000],
  [160, 1341700], [170, 1421400], [180, 1501100], [190, 1580800], [200, 1660500],
  [250, 2059000], [300, 2313500],
];

function toNumber(value, fallback = null) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number.parseFloat(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function toInteger(value, fallback = 0) {
  const n = Number.parseInt(String(value || '').replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  const n = toNumber(value, 0) || 0;
  return Math.round(n);
}

function roundPct(value) {
  const n = toNumber(value, 0) || 0;
  return Math.round(n * 10000) / 10000;
}

function safety() {
  return {
    read_only: true,
    local_csv_export_allowed: true,
    marketplace_write: false,
    db_write: false,
    ai_call: false,
    ebay_call: false,
    get_item_called: false,
    revise_fixed_price_item_called: false,
    execution_request_created: false,
    packet_created: false,
    price_changes: false,
    inventory_changes: false,
    listing_changes: false,
  };
}

function parseCsvFile(file) {
  const absolutePath = path.resolve(String(file || ''));
  const text = fs.readFileSync(absolutePath, 'utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return { absolutePath, parsed, rows: parsed.data || [], fields: parsed.meta?.fields || [] };
}

function writeCsvFile(file, rows, columns = INPUT_COLUMNS) {
  const absolutePath = path.resolve(String(file || ''));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const csv = Papa.unparse(rows, { columns });
  fs.writeFileSync(absolutePath, `${csv}\n`, 'utf8');
  return absolutePath;
}

function normalizeListingRow(row) {
  return {
    item_id: String(row['Item ID'] || row.item_id || '').trim(),
    sku: String(row.SKU || row.sku || '').trim(),
    title: String(row.Title || row.title || '').trim(),
    current_price_usd: String(row['Price (USD)'] || row.current_price_usd || '').trim(),
    quantity: String(row.Quantity || row.quantity || '').trim(),
    quantity_sold: String(row['Quantity Sold'] || row.quantity_sold || '').trim(),
    listing_type: String(row['Listing Type'] || row.listing_type || '').trim(),
    view_url: String(row['View URL'] || row.view_url || '').trim(),
    image_url: String(row['Image URL'] || row.image_url || '').trim(),
    product_cost_krw: '',
    weight_kg: '',
    length_cm: '',
    width_cm: '',
    height_cm: '',
    operator_note: '',
  };
}

function isTestOrSandbox(row) {
  return TEST_SANDBOX_RE.test(`${row.item_id || ''} ${row.sku || ''} ${row.title || ''}`);
}

function buildEmptyValidation(errors = []) {
  return {
    valid: false,
    valid_rows: 0,
    invalid_rows: 0,
    blocked_rows: 0,
    errors,
  };
}

function baseOutput(extra = {}) {
  return {
    phase: PHASE,
    mode: 'read_only',
    assumptions: { ...ASSUMPTIONS },
    rows_scanned: 0,
    rows_calculated: 0,
    blocked_rows: 0,
    loss_count: 0,
    low_margin_count: 0,
    healthy_count: 0,
    results: [],
    marketplace_write: false,
    db_write: false,
    ai_call: false,
    no_ebay_call: true,
    no_execution_requests_created: true,
    no_packets_created: true,
    no_price_inventory_listing_changes: true,
    safety: safety(),
    ...extra,
  };
}

function exportListingProfitabilityInput({ listings, out } = {}) {
  if (!listings) throw new Error('listings is required');
  if (!out) throw new Error('out is required');
  const { rows } = parseCsvFile(listings);
  const templateRows = rows.map(normalizeListingRow);
  const outputPath = writeCsvFile(out, templateRows, INPUT_COLUMNS);
  return baseOutput({
    operation: 'listing_profitability_input_export',
    listings_file: path.resolve(listings),
    output_file: outputPath,
    template_rows: templateRows.length,
    rows_scanned: rows.length,
    columns: INPUT_COLUMNS,
    source: 'phase_18a_listing_profitability_input_export_v1',
  });
}

function validateListingProfitabilityInput({ file } = {}) {
  if (!file) throw new Error('file is required');
  const { absolutePath, parsed, rows, fields } = parseCsvFile(file);
  const errors = [];
  for (const column of INPUT_COLUMNS) {
    if (!fields.includes(column)) errors.push({ row: 1, field: column, code: 'missing_required_column' });
  }
  for (const parseError of parsed.errors || []) {
    errors.push({ row: (parseError.row || 0) + 2, field: '', code: 'csv_parse_error', message: parseError.message });
  }

  const itemIdCounts = new Map();
  for (const row of rows) {
    const itemId = String(row.item_id || '').trim();
    if (itemId) itemIdCounts.set(itemId, (itemIdCounts.get(itemId) || 0) + 1);
  }
  const duplicates = new Set([...itemIdCounts.entries()].filter(([, count]) => count > 1).map(([itemId]) => itemId));
  const invalidRows = new Set();
  const blockedRows = new Set();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const itemId = String(row.item_id || '').trim();
    const price = toNumber(row.current_price_usd, null);
    const cost = toNumber(row.product_cost_krw, null);
    const weight = toNumber(row.weight_kg, null);
    const length = toNumber(row.length_cm, null);
    const width = toNumber(row.width_cm, null);
    const height = toNumber(row.height_cm, null);
    const rowErrors = [];

    if (!itemId) rowErrors.push({ row: rowNumber, field: 'item_id', code: 'missing_item_id' });
    if (itemId && duplicates.has(itemId)) rowErrors.push({ row: rowNumber, field: 'item_id', code: 'duplicate_item_id', item_id: itemId });
    if (price == null) rowErrors.push({ row: rowNumber, field: 'current_price_usd', code: 'current_price_usd_not_numeric', item_id: itemId });
    if (cost == null) rowErrors.push({ row: rowNumber, field: 'product_cost_krw', code: 'product_cost_krw_not_numeric', item_id: itemId });
    else if (cost <= 0) rowErrors.push({ row: rowNumber, field: 'product_cost_krw', code: 'product_cost_krw_must_be_greater_than_zero', item_id: itemId, value: row.product_cost_krw });
    if (weight == null) rowErrors.push({ row: rowNumber, field: 'weight_kg', code: 'weight_kg_not_numeric', item_id: itemId });
    else if (weight <= 0) rowErrors.push({ row: rowNumber, field: 'weight_kg', code: 'weight_kg_must_be_greater_than_zero', item_id: itemId, value: row.weight_kg });
    for (const [field, value] of [['length_cm', length], ['width_cm', width], ['height_cm', height]]) {
      if (value == null) rowErrors.push({ row: rowNumber, field, code: `${field}_not_numeric`, item_id: itemId });
      else if (value < 0) rowErrors.push({ row: rowNumber, field, code: `${field}_must_be_greater_than_or_equal_to_zero`, item_id: itemId, value: row[field] });
    }
    if (isTestOrSandbox(row)) {
      rowErrors.push({ row: rowNumber, field: 'item_id', code: 'test_or_sandbox_row_blocked', item_id: itemId });
      blockedRows.add(index);
    }

    if (rowErrors.length > 0) invalidRows.add(index);
    errors.push(...rowErrors);
  });

  const structurallyInvalid = INPUT_COLUMNS.some(column => !fields.includes(column));
  const validRows = structurallyInvalid ? 0 : rows.length - invalidRows.size;
  const validation = {
    valid: errors.length === 0 && rows.length > 0,
    valid_rows: Math.max(0, validRows),
    invalid_rows: structurallyInvalid ? rows.length : invalidRows.size,
    blocked_rows: blockedRows.size,
    errors,
  };
  return baseOutput({
    operation: 'listing_profitability_input_validate',
    file: absolutePath,
    rows_scanned: rows.length,
    blocked_rows: blockedRows.size,
    validation,
    ready_for_profitability_calculation: validation.valid_rows > 0,
    source: 'phase_18a_listing_profitability_input_validate_v1',
  });
}

function volWeight(length, width, height, divisor) {
  return length && width && height ? Math.round((length * width * height / divisor) * 1000) / 1000 : 0;
}

function lookupRate(rates, weight, unit) {
  const comparable = unit === 'g' ? weight * 1000 : weight;
  for (const [threshold, price] of rates) {
    if (comparable <= threshold) return price;
  }
  return rates[rates.length - 1][1];
}

function quoteFromConfig(carrier, cfg, actualKg, length, width, height) {
  const volKg = volWeight(length, width, height, cfg.divisor);
  const chargeKg = Math.max(actualKg, volKg);
  const base = lookupRate(cfg.rates, chargeKg, cfg.unit || 'kg');
  const fuel = Math.round((FUEL_SURCHARGE[carrier] || 0) * chargeKg);
  return {
    carrier,
    service: cfg.service || '-',
    chargeable_weight_kg: Math.round(chargeKg * 100) / 100,
    volumetric_weight_kg: Math.round(volKg * 100) / 100,
    base_krw: base,
    fuel_surcharge_krw: fuel,
    total_krw: base + fuel,
    note: cfg.note || '',
  };
}

function getShippingQuotes({ weightKg, lengthCm, widthCm, heightCm, destinationCountry = ASSUMPTIONS.destination_country }) {
  if (destinationCountry !== '미국') return [];
  const quotes = [];
  const actualKg = weightKg;
  const kpVolKg = volWeight(lengthCm, widthCm, heightCm, 6000);
  const kpChargeKg = Math.max(actualKg, kpVolKg);
  if (actualKg <= 2 && kpChargeKg <= 2) {
    quotes.push({
      carrier: 'K-Packet',
      service: '우체국 K-Packet(등기)',
      chargeable_weight_kg: Math.round(kpChargeKg * 100) / 100,
      volumetric_weight_kg: Math.round(kpVolKg * 100) / 100,
      base_krw: lookupRate(KPACKET_RATES_US, kpChargeKg, 'kg'),
      fuel_surcharge_krw: 0,
      total_krw: lookupRate(KPACKET_RATES_US, kpChargeKg, 'kg'),
      note: '최대 2kg / D+4~7일 / 종추적 / 서명없이 배달',
    });
  }
  quotes.push(quoteFromConfig('KPL', KPL_US, actualKg, lengthCm, widthCm, heightCm));
  quotes.push(quoteFromConfig('쉽터', SHIPTER_US, actualKg, lengthCm, widthCm, heightCm));
  quotes.push(quoteFromConfig('윤익스프레스', YUN_US, actualKg, lengthCm, widthCm, heightCm));
  if (actualKg >= 71) {
    const volKg = volWeight(lengthCm, widthCm, heightCm, 6000);
    const chargeKg = Math.max(actualKg, volKg);
    const base = lookupRate(EMS_PREMIUM_US_ZONE_E, chargeKg, 'kg');
    quotes.push({
      carrier: 'EMS프리미엄',
      service: '우체국 EMS프리미엄(Zone E)',
      chargeable_weight_kg: Math.round(chargeKg * 100) / 100,
      volumetric_weight_kg: Math.round(volKg * 100) / 100,
      base_krw: base,
      fuel_surcharge_krw: 0,
      total_krw: base,
      note: '고중량특송 / Zone E / 최소 71kg',
    });
  }
  quotes.sort((a, b) => a.total_krw - b.total_krw || a.carrier.localeCompare(b.carrier));
  return quotes.map((quote, index) => ({ ...quote, recommended: index === 0 }));
}

function calculateListingProfitability({ file } = {}) {
  const validationResult = validateListingProfitabilityInput({ file });
  const { absolutePath, rows } = parseCsvFile(file);
  const invalidRowNumbers = new Set((validationResult.validation.errors || []).map(error => error.row).filter(row => row > 1));
  const results = [];
  for (const [index, row] of rows.entries()) {
    if (invalidRowNumbers.has(index + 2)) continue;
    const currentPriceUsd = toNumber(row.current_price_usd, 0) || 0;
    const productCostKrw = toNumber(row.product_cost_krw, 0) || 0;
    const weightKg = toNumber(row.weight_kg, 0) || 0;
    const lengthCm = toNumber(row.length_cm, 0) || 0;
    const widthCm = toNumber(row.width_cm, 0) || 0;
    const heightCm = toNumber(row.height_cm, 0) || 0;
    const shippingQuotes = getShippingQuotes({ weightKg, lengthCm, widthCm, heightCm });
    const recommended = shippingQuotes[0] || null;
    const revenueKrw = roundMoney(currentPriceUsd * ASSUMPTIONS.usd_krw);
    const ebayFeeKrw = roundMoney(revenueKrw * ASSUMPTIONS.ebay_fee_pct);
    const shippingKrw = recommended ? recommended.total_krw : 0;
    const estimatedProfitKrw = revenueKrw - ebayFeeKrw - shippingKrw - productCostKrw;
    const marginPct = revenueKrw > 0 ? estimatedProfitKrw / revenueKrw : 0;
    let profitabilityStatus = 'healthy';
    if (!recommended) profitabilityStatus = 'blocked';
    else if (estimatedProfitKrw < 0) profitabilityStatus = 'loss';
    else if (marginPct < 0.10) profitabilityStatus = 'low_margin';

    results.push({
      item_id: String(row.item_id || '').trim(),
      sku: String(row.sku || '').trim(),
      title: String(row.title || '').trim(),
      current_price_usd: currentPriceUsd,
      quantity: toInteger(row.quantity, 0),
      quantity_sold: toInteger(row.quantity_sold, 0),
      listing_type: row.listing_type || '',
      revenue_krw: revenueKrw,
      ebay_fee_krw: ebayFeeKrw,
      shipping_krw: shippingKrw,
      product_cost_krw: productCostKrw,
      estimated_profit_krw: roundMoney(estimatedProfitKrw),
      margin_pct: roundPct(marginPct),
      profitability_status: profitabilityStatus,
      recommended_shipping_quote: recommended,
      shipping_quotes: shippingQuotes,
      view_url: row.view_url || '',
      image_url: row.image_url || '',
      operator_note: row.operator_note || '',
    });
  }

  const counts = results.reduce((acc, row) => {
    acc[row.profitability_status] = (acc[row.profitability_status] || 0) + 1;
    return acc;
  }, {});

  return baseOutput({
    operation: 'listing_profitability_calculate',
    file: absolutePath,
    rows_scanned: rows.length,
    rows_calculated: results.length,
    blocked_rows: validationResult.validation.blocked_rows + (rows.length - results.length - validationResult.validation.blocked_rows),
    loss_count: counts.loss || 0,
    low_margin_count: counts.low_margin || 0,
    healthy_count: counts.healthy || 0,
    validation: validationResult.validation,
    results,
    source: 'phase_18a_listing_profitability_calculate_v1',
  });
}

module.exports = {
  ASSUMPTIONS,
  INPUT_COLUMNS,
  exportListingProfitabilityInput,
  validateListingProfitabilityInput,
  calculateListingProfitability,
  getShippingQuotes,
};
