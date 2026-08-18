'use strict';

/**
 * src/services/oms/soldPriceCoverageAudit.js — Phase 8P-1 · READ-ONLY.
 *
 * Cross-physical coverage audit for RECENT_SOLD_PRICE_MEDIAN eligibility.
 *
 * PURPOSE: answer whether Phase 8P returns UNKNOWN because:
 *   (A) minSamples=3 too strict,
 *   (B) 30d lookback too short,
 *   (C) physical identity mapping the dominant bottleneck,
 *   (D) multiple factors.
 *
 * Never mutates. Never applies migrations. Never changes recentSoldPriceService
 * defaults. Never repairs mappings. Never calls marketplace APIs.
 *
 * PERFORMANCE (Phase 8P-1 Part 6):
 *   ONE query per (channel × table) — 6 queries for {shopify,ebay} × {orders, items, identity_walk_3_tables}
 *   Coverage buckets calculated in memory from the batch payload.
 *   Result: query count is O(1) in physical set size (not O(N)).
 *
 * PII: never surfaces buyer name/email/phone/address. Provenance only
 * carries order_item_id, order_id, external_order_number, channel, sku,
 * shipped_at, unit_price_native, currency, amount_krw.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_WINDOWS = [30, 60, 90];
const DEFAULT_THRESHOLDS = [1, 2, 3, 5, 10];
const DEFAULT_CHANNELS = ['shopify', 'ebay'];
const KNOWN_CURRENCIES = new Set(['KRW', 'USD', 'JPY', 'CNY']);
const ELIGIBLE_ORDER_STATUS = new Set(['shipped', 'completed']);
const ELIGIBLE_PAYMENT_STATUS = new Set(['paid']);

const IDENTITY_CLASS = Object.freeze({
  KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P: 'KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P',
  NO_CANONICAL_PHYSICAL_MAPPING:      'NO_CANONICAL_PHYSICAL_MAPPING',
  AMBIGUOUS:                          'AMBIGUOUS',
  UNKNOWN:                            'UNKNOWN',
});

/**
 * @param {Object} args
 * @param {Object} args.db                       Supabase-like client (injectable)
 * @param {number[]|null} [args.physicalIds]     restrict to these physicals; null = all
 * @param {number} [args.maxWindowDays=90]       maximum lookback window (per Part 1)
 * @param {number[]} [args.windows=[30,60,90]]
 * @param {number[]} [args.thresholds=[1,2,3,5,10]]
 * @param {string[]} [args.channels=['shopify','ebay']]
 * @param {number} [args.physicalScanLimit=500]  bound on physical set size
 * @param {number} [args.asOfMs=Date.now()]      injectable clock
 * @param {Object} [args.fxRates]                {usdKrw, krwJpyRate, krwCnyRate}
 * @param {string} [args.usdKrwSource]
 * @returns {Promise<Object>}                    full audit payload
 */
async function runSoldPriceCoverageAudit(args = {}) {
  const {
    db,
    physicalIds = null,
    maxWindowDays = 90,
    windows = DEFAULT_LOOKBACK_WINDOWS,
    thresholds = DEFAULT_THRESHOLDS,
    channels = DEFAULT_CHANNELS,
    physicalScanLimit = 500,
    asOfMs,
    fxRates = {},
    usdKrwSource = null,
  } = args;
  if (!db || typeof db.from !== 'function') throw new Error('runSoldPriceCoverageAudit: db required');
  const nowMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const maxWindow = Math.max(1, Number(maxWindowDays) || 90);
  const windowStartIso = new Date(nowMs - maxWindow * ONE_DAY_MS).toISOString();
  const windowEndIso   = new Date(nowMs).toISOString();
  const fxTable = _fxTable(fxRates);

  //   ── Query 1: pull physical products (bounded)
  const physicals = await _selectPhysicals(db, physicalIds, physicalScanLimit);
  const physicalIdList = physicals.map(p => p.id);

  //   ── Query 2-4: batch identity walk (physical → sellable_units → components(qty=1) → sku_master_link)
  const identityMap = await _buildIdentityMap(db, physicalIdList);
  //   Also gather quantity-per-unit != 1 mappings for classification.
  const identityAllQtyMap = await _buildAllQtyIdentityMap(db, physicalIdList);

  //   ── Query 5-6 per channel: orders + items in the max window
  const perChannelData = {};
  let queryCount = 4;   // physicals + 3 identity walk tables
  for (const ch of channels) {
    const orders = await _selectEligibleOrders(db, ch, windowStartIso, windowEndIso);
    queryCount++;
    if (orders.length === 0) { perChannelData[ch] = { orders: [], items: [] }; continue; }
    const items = await _selectItemsForOrders(db, orders.map(o => o.id));
    queryCount++;
    perChannelData[ch] = { orders, items };
  }

  //   ── In-memory aggregation
  const perPhysical = new Map();   // physical_id → { windows: {30:[], 60:[], 90:[]}, exclusions, ... }
  for (const p of physicals) perPhysical.set(p.id, _emptyPhysicalRow(p));

  //   items_sku_not_in_known accounting — collect distinct sku_master_ids that were excluded
  const excludedSkuMap = new Map();   // sku_master_id → { affected_items, affected_orders_set, channels_set, sample_count }

  for (const ch of Object.keys(perChannelData)) {
    const { orders, items } = perChannelData[ch];
    const orderById = new Map(orders.map(o => [o.id, o]));
    for (const it of items) {
      const ord = orderById.get(it.order_id);
      if (!ord) continue;
      //   Eligibility · order-level (was already filtered by _selectEligibleOrders)
      //   Line-level checks (matching recentSoldPriceService · same rules)
      const q = Number(it.quantity);
      const u = Number(it.unit_price);
      const d = Number(it.discount);
      const cur = String(it.currency || '').toUpperCase();
      const lineExclusion = _lineExclusionReason({ q, u, d, cur, fxTable });
      if (lineExclusion) continue;   // ineligible for coverage regardless of physical mapping
      //   Physical-mapping resolution
      const resolvedPhysical = _resolvePhysicalForSku(it.sku_master_id, identityMap);
      if (!resolvedPhysical) {
        //   sku_master_id not in known set for ANY audited physical
        const key = it.sku_master_id ?? 'null';
        const entry = excludedSkuMap.get(key) || { sku_master_id: it.sku_master_id ?? null, affected_items: 0, affected_orders: new Set(), channels: new Set(), sample_count: 0 };
        entry.affected_items++;
        entry.affected_orders.add(it.order_id);
        entry.channels.add(ch);
        entry.sample_count++;
        excludedSkuMap.set(key, entry);
        continue;
      }
      //   Record observation for the physical
      const shippedMs = new Date(ord.shipped_at).getTime();
      const ageDays = (nowMs - shippedMs) / ONE_DAY_MS;
      const amountKrw = Math.round(u * fxTable[cur]);
      const obs = {
        order_item_id: it.id, order_id: it.order_id,
        external_order_number: ord.external_order_number ?? null,
        channel: ch, sku_master_id: it.sku_master_id,
        unit_price_native: u, currency: cur,
        amount_krw: amountKrw, fx_rate_used: fxTable[cur],
        shipped_at: ord.shipped_at,
        age_days: ageDays,
      };
      for (const pid of resolvedPhysical) {
        const row = perPhysical.get(pid);
        if (!row) continue;
        row.all_observations.push(obs);
      }
    }
  }

  //   ── Bucket observations into 30/60/90 windows and compute stats
  for (const row of perPhysical.values()) {
    for (const w of windows) {
      const bucket = row.all_observations
        .filter(o => o.age_days <= w)
        .map(o => o.amount_krw)
        .filter(v => Number.isFinite(v) && v > 0);
      row.windows[w] = {
        sample_count: bucket.length,
        median: bucket.length ? _median(bucket.slice().sort((a, b) => a - b)) : null,
        min: bucket.length ? Math.min(...bucket) : null,
        max: bucket.length ? Math.max(...bucket) : null,
      };
    }
  }

  //   ── Coverage matrix across (windows × thresholds)
  const coverage_matrix = _buildCoverageMatrix(perPhysical, windows, thresholds);

  //   ── Policy simulation (Part 4)
  const policy_simulation = _simulatePolicies(perPhysical);

  //   ── Median stability (Part 5)
  const price_stability = _medianStability(perPhysical, windows);

  //   ── Identity exclusion analysis (Part 2)
  const identity_exclusions = await _classifyExcludedIdentities({
    db, excludedSkuMap, identityAllQtyMap, physicalIdList,
  });

  return {
    generated_at: new Date(nowMs).toISOString(),
    physical_products_scanned: physicals.length,
    windows_days: windows, thresholds, channels,
    fx_used: {
      table: fxTable,
      usdKrwSource: usdKrwSource ?? null,
    },
    coverage_matrix,
    policy_simulation,
    price_stability,
    identity_exclusions,
    query_count: queryCount + identity_exclusions.additional_query_count,
    note: 'READ-ONLY audit · never mutates DB · never repairs mappings · never applies migration',
  };
}

/**
 * Per-physical diagnostic (BP path). Returns eligible observations
 * BEFORE minSamples gating for 30/60/90d. NO PII.
 */
async function diagnosePhysical({ physicalProductId, db, fxRates = {}, channels = DEFAULT_CHANNELS, asOfMs } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('diagnosePhysical: physicalProductId required (positive integer)');
  }
  const nowMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const audit = await runSoldPriceCoverageAudit({
    db, physicalIds: [physicalProductId],
    channels, fxRates, asOfMs: nowMs,
  });
  const row = audit.coverage_matrix.per_physical.find(r => r.physical_product_id === physicalProductId);
  return {
    physical_product_id: physicalProductId,
    generated_at: audit.generated_at,
    windows: row?.windows || {},
    eligible_observations: row?.all_observations_safe || [],
    note: 'Diagnostic only · no PII · does not change minSamples policy',
    audit_query_count: audit.query_count,
  };
}

// ─── helpers · queries ────────────────────────────

async function _selectPhysicals(db, physicalIds, limit) {
  if (Array.isArray(physicalIds) && physicalIds.length > 0) {
    const res = await db.from('physical_products').select('id, canonical_title').in('id', physicalIds);
    if (res && res.error) throw new Error(`physical_products select failed: ${res.error.message}`);
    return (res && res.data) || [];
  }
  const res = await db.from('physical_products').select('id, canonical_title').limit(limit);
  if (res && res.error) throw new Error(`physical_products select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

async function _buildIdentityMap(db, physicalIdList) {
  //   physical_id → Set(sku_master_id) · walk qty=1 only (Phase 8P convention).
  //   Phase 8P-2b schema-correct walk (see migrations 086/087):
  //     sellable_unit_components.physical_product_id · .sellable_unit_id · .quantity_per_unit
  //     → sku_master_link.sellable_unit_id · .sku_master_id
  //   sellable_units (086) has NO physical_product_id column.
  if (!physicalIdList.length) return new Map();
  const compRes = await db.from('sellable_unit_components')
    .select('sellable_unit_id, physical_product_id, quantity_per_unit')
    .in('physical_product_id', physicalIdList);
  const comps = ((compRes && compRes.data) || []).filter(c => Number(c.quantity_per_unit) === 1);
  //   sellable_unit_id → Set(physical_id) · qty=1 only
  const suToPhysicals = new Map();
  for (const c of comps) {
    if (!c.sellable_unit_id || !Number.isInteger(c.physical_product_id)) continue;
    if (!suToPhysicals.has(c.sellable_unit_id)) suToPhysicals.set(c.sellable_unit_id, new Set());
    suToPhysicals.get(c.sellable_unit_id).add(c.physical_product_id);
  }
  const singleSuIds = [...suToPhysicals.keys()];
  if (!singleSuIds.length) return new Map();
  const linkRes = await db.from('sku_master_link').select('sku_master_id, sellable_unit_id').in('sellable_unit_id', singleSuIds);
  const links = (linkRes && linkRes.data) || [];
  const skuToPhysicals = new Map();
  for (const l of links) {
    if (!l.sku_master_id) continue;
    const pids = suToPhysicals.get(l.sellable_unit_id);
    if (!pids) continue;
    if (!skuToPhysicals.has(l.sku_master_id)) skuToPhysicals.set(l.sku_master_id, new Set());
    for (const pid of pids) skuToPhysicals.get(l.sku_master_id).add(pid);
  }
  return skuToPhysicals;
}

async function _buildAllQtyIdentityMap(db, physicalIdList) {
  //   ALL sku_master_ids known via sku_master_link → sellable_unit(→ physical)
  //   regardless of quantity_per_unit. Used for classification of excluded IDs.
  //   Phase 8P-2b schema-correct walk via sellable_unit_components.
  if (!physicalIdList.length) return new Map();
  const compRes = await db.from('sellable_unit_components')
    .select('sellable_unit_id, physical_product_id, quantity_per_unit')
    .in('physical_product_id', physicalIdList);
  const comps = (compRes && compRes.data) || [];
  const suToPhysicals = new Map();
  for (const c of comps) {
    if (!c.sellable_unit_id || !Number.isInteger(c.physical_product_id)) continue;
    if (!suToPhysicals.has(c.sellable_unit_id)) suToPhysicals.set(c.sellable_unit_id, new Set());
    suToPhysicals.get(c.sellable_unit_id).add(c.physical_product_id);
  }
  const suIds = [...suToPhysicals.keys()];
  if (!suIds.length) return new Map();
  const linkRes = await db.from('sku_master_link').select('sku_master_id, sellable_unit_id').in('sellable_unit_id', suIds);
  const links = (linkRes && linkRes.data) || [];
  const skuMap = new Map();
  for (const l of links) {
    if (!l.sku_master_id) continue;
    const pids = suToPhysicals.get(l.sellable_unit_id);
    if (!pids) continue;
    if (!skuMap.has(l.sku_master_id)) skuMap.set(l.sku_master_id, new Set());
    for (const pid of pids) skuMap.get(l.sku_master_id).add(pid);
  }
  return skuMap;
}

async function _selectEligibleOrders(db, channel, windowStartIso, windowEndIso) {
  //   Order-level eligibility applied in-query where possible.
  const res = await db.from('oms_orders')
    .select('id, channel, external_order_number, shipped_at, cancelled_at, order_status, payment_status')
    .eq('channel', channel)
    .gte('shipped_at', windowStartIso)
    .lte('shipped_at', windowEndIso);
  if (res && res.error) throw new Error(`oms_orders select failed: ${res.error.message}`);
  const rows = (res && res.data) || [];
  return rows.filter(o =>
    o.shipped_at &&
    o.cancelled_at == null &&
    ELIGIBLE_ORDER_STATUS.has(String(o.order_status)) &&
    ELIGIBLE_PAYMENT_STATUS.has(String(o.payment_status))
  );
}

async function _selectItemsForOrders(db, orderIds) {
  if (!orderIds.length) return [];
  const res = await db.from('oms_order_items')
    .select('id, order_id, sku_master_id, quantity, unit_price, discount, currency')
    .in('order_id', orderIds);
  if (res && res.error) throw new Error(`oms_order_items select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

async function _classifyExcludedIdentities({ db, excludedSkuMap, identityAllQtyMap, physicalIdList }) {
  //   Classify each excluded sku_master_id by whether canonical OMS mapping
  //   exists elsewhere. NEVER fuzzy-matches. Uses only sku_master_link SoT.
  const excludedIds = [...excludedSkuMap.keys()].filter(x => x !== 'null');
  const skuIdList = excludedIds.map(x => Number(x)).filter(Number.isInteger);
  let additional_query_count = 0;
  const linkMap = new Map();   // sku_master_id → Set(sellable_unit_id)
  if (skuIdList.length) {
    const res = await db.from('sku_master_link').select('sku_master_id, sellable_unit_id').in('sku_master_id', skuIdList);
    additional_query_count++;
    for (const l of (res && res.data) || []) {
      if (!linkMap.has(l.sku_master_id)) linkMap.set(l.sku_master_id, new Set());
      linkMap.get(l.sku_master_id).add(l.sellable_unit_id);
    }
  }
  //   Phase 8P-2b schema-correct walk · sellable_unit_components is the SoT
  //   for BOTH physical_product_id AND quantity_per_unit (sellable_units 086
  //   has no physical_product_id column). One query gives us both dimensions.
  const suIds = [...new Set([...linkMap.values()].flatMap(s => [...s]))];
  const suToPhysical = new Map();
  if (suIds.length) {
    const compRes = await db.from('sellable_unit_components')
      .select('sellable_unit_id, physical_product_id, quantity_per_unit')
      .in('sellable_unit_id', suIds);
    additional_query_count++;
    for (const c of (compRes && compRes.data) || []) {
      if (!c.sellable_unit_id || !Number.isInteger(c.physical_product_id)) continue;
      //   Same sideband shape as before: physical_id + quantities set for
      //   classification (single physical → number, multi-physical → object)
      const entry = suToPhysical.get(c.sellable_unit_id);
      if (!entry) {
        suToPhysical.set(c.sellable_unit_id, { physical_id: c.physical_product_id, quantities: new Set([Number(c.quantity_per_unit)]) });
      } else if (entry.quantities) {
        entry.quantities.add(Number(c.quantity_per_unit));
        //   NOTE: a sellable_unit can contain multiple physicals (bundle) ·
        //   we keep the FIRST physical for compatibility; the calling
        //   classifier uses physicals_linked derived from the full link set.
      }
    }
  }

  const distinct_excluded_sku_master_ids = excludedSkuMap.size;
  let affected_items_total = 0;
  const affectedOrdersUnion = new Set();
  const channelsUnion = new Set();
  const byClass = {
    [IDENTITY_CLASS.KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P]: 0,
    [IDENTITY_CLASS.NO_CANONICAL_PHYSICAL_MAPPING]: 0,
    [IDENTITY_CLASS.AMBIGUOUS]: 0,
    [IDENTITY_CLASS.UNKNOWN]: 0,
  };
  const perId = [];
  for (const [key, e] of excludedSkuMap.entries()) {
    affected_items_total += e.affected_items;
    for (const oid of e.affected_orders) affectedOrdersUnion.add(oid);
    for (const ch of e.channels) channelsUnion.add(ch);
    const skuId = e.sku_master_id;
    let cls = IDENTITY_CLASS.UNKNOWN;
    let physicalsLinked = [];
    let hasQtyOtherThan1 = false;
    if (skuId == null) {
      cls = IDENTITY_CLASS.UNKNOWN;
    } else if (!linkMap.has(skuId)) {
      cls = IDENTITY_CLASS.NO_CANONICAL_PHYSICAL_MAPPING;
    } else {
      const suIdsForSku = [...linkMap.get(skuId)];
      const pids = new Set();
      for (const suId of suIdsForSku) {
        const entry = suToPhysical.get(suId);
        if (typeof entry === 'number') pids.add(entry);
        else if (entry && entry.physical_id) {
          pids.add(entry.physical_id);
          if (entry.quantities && [...entry.quantities].some(q => q !== 1)) hasQtyOtherThan1 = true;
        }
      }
      physicalsLinked = [...pids];
      if (pids.size === 0) cls = IDENTITY_CLASS.UNKNOWN;
      else if (pids.size > 1) cls = IDENTITY_CLASS.AMBIGUOUS;
      else if (hasQtyOtherThan1) cls = IDENTITY_CLASS.KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P;
      else cls = IDENTITY_CLASS.KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P;
      //   NOTE: qty=1 mapping exists yet excluded → this means excluded from
      //   a DIFFERENT audited physical's perspective (SKU maps to a different
      //   physical than the one we were checking). That IS a legitimate
      //   exclusion — the mapping exists, but not to the audited physical
      //   set. Still classified as KNOWN_MAPPING_NOT_RECOGNIZED_BY_8P for
      //   the "an existing canonical mapping proves there is a physical
      //   home for this sku · Phase 8P just didn't attribute it here".
    }
    byClass[cls] = (byClass[cls] || 0) + 1;
    perId.push({
      sku_master_id: skuId,
      affected_items: e.affected_items,
      affected_orders: e.affected_orders.size,
      channels: [...e.channels],
      sample_count: e.sample_count,
      classification: cls,
      physicals_linked: physicalsLinked,
    });
  }
  //   Sort by completed-sale frequency
  const top = perId.slice().sort((a, b) => b.sample_count - a.sample_count).slice(0, 25);
  return {
    distinct_excluded_sku_master_ids,
    affected_items_total,
    affected_orders_total: affectedOrdersUnion.size,
    channels: [...channelsUnion],
    top_excluded_ids: top,
    by_classification: byClass,
    additional_query_count,
  };
}

// ─── helpers · in-memory analysis ─────────────────

function _lineExclusionReason({ q, u, d, cur, fxTable }) {
  if (!(q > 0)) return 'zero_quantity';
  if (!Number.isFinite(u) || u <= 0) return 'nonpositive_price';
  if (Number.isFinite(d) && d > 0) return 'discounted';
  if (!KNOWN_CURRENCIES.has(cur)) return 'unknown_currency';
  if (!Number.isFinite(fxTable[cur]) || fxTable[cur] <= 0) return 'fx_unavailable';
  return null;
}

function _resolvePhysicalForSku(skuId, identityMap) {
  if (skuId == null) return null;
  const pids = identityMap.get(skuId);
  if (!pids || pids.size === 0) return null;
  //   AMBIGUOUS · a sku that qty=1-links to MULTIPLE physicals cannot be
  //   uniquely attributed. Exclude from any physical's coverage; will be
  //   classified as AMBIGUOUS in identity_exclusions.
  if (pids.size > 1) return null;
  return [...pids];
}

function _emptyPhysicalRow(physical) {
  return {
    physical_product_id: physical.id,
    canonical_title: physical.canonical_title ?? null,
    all_observations: [],
    windows: {},
    get all_observations_safe() {
      //   PII-free provenance
      return this.all_observations.map(o => ({
        order_item_id: o.order_item_id, order_id: o.order_id,
        external_order_number: o.external_order_number,
        channel: o.channel, sku_master_id: o.sku_master_id,
        unit_price_native: o.unit_price_native, currency: o.currency,
        amount_krw: o.amount_krw, fx_rate_used: o.fx_rate_used,
        shipped_at: o.shipped_at, age_days: Math.round(o.age_days * 100) / 100,
      }));
    },
  };
}

function _buildCoverageMatrix(perPhysical, windows, thresholds) {
  const per_physical = [];
  const totals = { total: perPhysical.size, by_window: {} };
  for (const w of windows) {
    totals.by_window[w] = Object.fromEntries(thresholds.map(t => [`>=${t}`, 0]));
  }
  for (const row of perPhysical.values()) {
    const summary = { physical_product_id: row.physical_product_id, canonical_title: row.canonical_title, windows: row.windows };
    per_physical.push({ ...summary, all_observations_safe: row.all_observations_safe });
    for (const w of windows) {
      const cnt = row.windows[w]?.sample_count || 0;
      for (const t of thresholds) if (cnt >= t) totals.by_window[w][`>=${t}`]++;
    }
  }
  const percentageByWindow = {};
  for (const w of windows) {
    percentageByWindow[w] = {};
    for (const t of thresholds) {
      const c = totals.by_window[w][`>=${t}`];
      percentageByWindow[w][`>=${t}`] = { count: c, pct: totals.total > 0 ? Math.round((c / totals.total) * 10000) / 100 : 0 };
    }
  }
  return { total_physicals: totals.total, absolute: totals.by_window, coverage: percentageByWindow, per_physical };
}

function _simulatePolicies(perPhysical) {
  //   Fixed simulation set per Part 4
  const POLICIES = [
    { name: 'A', lookback_days: 30, min_samples: 3 },
    { name: 'B', lookback_days: 30, min_samples: 2 },
    { name: 'C', lookback_days: 60, min_samples: 3 },
    { name: 'D', lookback_days: 90, min_samples: 3 },
  ];
  const total = perPhysical.size;
  const out = [];
  for (const pol of POLICIES) {
    let gained = 0;
    let staleRisk = 0;
    const medians = [];
    const newestAges = [];
    for (const row of perPhysical.values()) {
      const bucket = row.windows[pol.lookback_days];
      if (!bucket || bucket.sample_count < pol.min_samples) continue;
      gained++;
      medians.push(bucket.median);
      //   stale-risk: newest sale age > 14 days
      const obsInWindow = row.all_observations.filter(o => o.age_days <= pol.lookback_days);
      const newestAge = obsInWindow.length ? Math.min(...obsInWindow.map(o => o.age_days)) : null;
      if (newestAge != null) newestAges.push(newestAge);
      if (newestAge != null && newestAge > 14) staleRisk++;
    }
    out.push({
      policy: pol.name,
      lookback_days: pol.lookback_days,
      min_samples: pol.min_samples,
      physicals_gaining_candidate: gained,
      coverage_pct: total > 0 ? Math.round((gained / total) * 10000) / 100 : 0,
      median_sample_count: medians.length ? _median(medians.slice().sort((a, b) => a - b)) : null,
      stale_risk_count: staleRisk,
      newest_sale_age_distribution: _ageDistribution(newestAges),
    });
  }
  return out;
}

function _medianStability(perPhysical, windows) {
  //   For physicals with >=3 observations in EACH window listed, compute
  //   pairwise divergence between the medians.
  if (!windows.length) return { comparable_physicals: 0, divergences: [] };
  const smallestWindow = Math.min(...windows);
  const results = [];
  for (const row of perPhysical.values()) {
    const meds = {};
    let allEligible = true;
    for (const w of windows) {
      const b = row.windows[w];
      if (!b || b.sample_count < 3 || b.median == null) { allEligible = false; break; }
      meds[w] = b.median;
    }
    if (!allEligible) continue;
    const values = Object.values(meds);
    const min = Math.min(...values), max = Math.max(...values);
    const divergence_pct = min > 0 ? Math.round(((max - min) / min) * 10000) / 100 : null;
    results.push({
      physical_product_id: row.physical_product_id,
      medians: meds,
      min, max,
      divergence_pct,
      material: divergence_pct != null && divergence_pct > 10,   // >10% flagged materially different
    });
  }
  return {
    windows_compared: windows,
    comparable_physicals: results.length,
    materially_different_count: results.filter(r => r.material).length,
    per_physical: results.slice(0, 50),   // cap for report readability
  };
}

function _ageDistribution(ages) {
  if (!ages.length) return { count: 0 };
  const sorted = ages.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_days: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    p90_days: Math.round(sorted[Math.floor(sorted.length * 0.9)] * 10) / 10,
    max_days: Math.round(sorted[sorted.length - 1] * 10) / 10,
  };
}

function _median(sortedAsc) {
  const n = sortedAsc.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function _fxTable({ usdKrw, krwJpyRate, krwCnyRate } = {}) {
  const t = { KRW: 1 };
  if (Number.isFinite(Number(usdKrw))     && Number(usdKrw)     > 0) t.USD = Number(usdKrw);
  if (Number.isFinite(Number(krwJpyRate)) && Number(krwJpyRate) > 0) t.JPY = Number(krwJpyRate);
  if (Number.isFinite(Number(krwCnyRate)) && Number(krwCnyRate) > 0) t.CNY = Number(krwCnyRate);
  return t;
}

module.exports = {
  runSoldPriceCoverageAudit,
  diagnosePhysical,
  IDENTITY_CLASS,
  DEFAULT_LOOKBACK_WINDOWS,
  DEFAULT_THRESHOLDS,
  DEFAULT_CHANNELS,
};
