'use strict';

/**
 * src/services/oms/physicalIdentityCoverageRecoveryAudit.js — Phase 8P-2 · READ-ONLY.
 *
 * Diagnoses the 329 NO_CANONICAL_PHYSICAL_MAPPING SKUs surfaced by
 * Phase 8P-1 and classifies each into a recovery class WITHOUT writing
 * anything. Owner uses the output to decide which links to add via the
 * canonical writer (not this service).
 *
 * DETERMINISTIC BRIDGES considered (from canonical OMS data only · no fuzzy):
 *   1. `oms_order_items.listing_id` (+ optional variant_id) shared with
 *      already-mapped sibling items → same eBay listing → same physical.
 *   2. `oms_order_items.product_id` shared with already-mapped sibling
 *      items → same products.id → same physical.
 *   3. `sku_listing_link.(marketplace, listing_id, option_id)` variant
 *      relationship → surfaced as diagnostic context (NOT sole authority).
 *   4. `pilotMappings.js` Owner-curated evidence (loaded as data · treated
 *      as strong Owner-signed hint · never auto-promoted alone).
 *
 * SAFETY:
 *   • Zero DB write · zero migration · zero mapping repair · zero physical
 *     creation · zero marketplace call · zero notification · zero scheduler.
 *   • Never uses title/name similarity as authoritative mapping. Title
 *     may appear in diagnostic evidence context only.
 *   • Never modifies recentSoldPriceService defaults.
 *   • Every DB access via injected `db` argument.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CLASSIFICATION = Object.freeze({
  DETERMINISTIC_EXISTING_EVIDENCE: 'DETERMINISTIC_EXISTING_EVIDENCE',
  PHYSICAL_PRODUCT_MISSING:        'PHYSICAL_PRODUCT_MISSING',
  HUMAN_REVIEW_REQUIRED:           'HUMAN_REVIEW_REQUIRED',
  INVALID_OR_ORPHANED_SKU:         'INVALID_OR_ORPHANED_SKU',
  UNKNOWN:                         'UNKNOWN',
});

const PROPOSED_ACTION = Object.freeze({
  ADD_EXISTING_LINK:              'ADD_EXISTING_LINK',
  CREATE_PHYSICAL_PRODUCT_REVIEW: 'CREATE_PHYSICAL_PRODUCT_REVIEW',
  HUMAN_REVIEW:                   'HUMAN_REVIEW',
  IGNORE_ORPHAN:                  'IGNORE_ORPHAN',
  NONE:                           'NONE',
});

const DEFAULT_TOP_N = 100;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_CHANNELS = ['shopify', 'ebay'];
const ELIGIBLE_ORDER_STATUS = new Set(['shipped', 'completed']);
const ELIGIBLE_PAYMENT_STATUS = new Set(['paid']);

async function runPhysicalIdentityCoverageRecoveryAudit(args = {}) {
  const {
    db,
    topN = DEFAULT_TOP_N,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    channels = DEFAULT_CHANNELS,
    physicalScanLimit = 500,
    asOfMs,
    fxRates = {},
    pilotMappings = null,       // injectable · defaults to require('./pilotMappings') if available
  } = args;
  if (!db || typeof db.from !== 'function') throw new Error('runPhysicalIdentityCoverageRecoveryAudit: db required');
  const nowMs = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const windowStartIso = new Date(nowMs - lookbackDays * ONE_DAY_MS).toISOString();
  const windowEndIso   = new Date(nowMs).toISOString();
  const fxTable = _fxTable(fxRates);
  let queryCount = 0;
  const inc = () => (queryCount += 1);

  //   ── Q1: physicals (bounded)
  const physicalsRes = await db.from('physical_products').select('id, canonical_title').limit(physicalScanLimit); inc();
  const physicals = (physicalsRes && physicalsRes.data) || [];
  const physicalIdList = physicals.map(p => p.id);

  //   ── Q2-3: canonical identity walk (Phase 8P-2a schema fix).
  //   `sellable_units` (086) has NO physical_product_id column · consumption
  //   is expressed ONLY through `sellable_unit_components` (087). The correct
  //   walk is:
  //     physical_products.id
  //     → sellable_unit_components.physical_product_id · .sellable_unit_id
  //     → sku_master_link.sellable_unit_id · .sku_master_id
  //   For AUTHORITATIVE Phase 8P identity, filter components by
  //   quantity_per_unit=1 (single-unit consumption). Multipack components
  //   (qty!=1) are surfaced separately in `allQtySuToPhysicals` for
  //   DIAGNOSTIC classification only (never authoritative).
  const compsAll = await _selectIn(
    db, 'sellable_unit_components',
    'sellable_unit_id, physical_product_id, quantity_per_unit',
    'physical_product_id', physicalIdList,
  ); inc();
  //   Build TWO maps: qty=1 authoritative · all-qty diagnostic
  const qty1SuToPhysicals = new Map();   // sellable_unit_id → Set(physical_id) · qty=1 only
  const allQtySuToPhysicals = new Map(); // sellable_unit_id → Set(physical_id) · any qty (diagnostic)
  for (const c of compsAll) {
    if (!c.sellable_unit_id || !Number.isInteger(c.physical_product_id)) continue;
    if (!allQtySuToPhysicals.has(c.sellable_unit_id)) allQtySuToPhysicals.set(c.sellable_unit_id, new Set());
    allQtySuToPhysicals.get(c.sellable_unit_id).add(c.physical_product_id);
    if (Number(c.quantity_per_unit) === 1) {
      if (!qty1SuToPhysicals.has(c.sellable_unit_id)) qty1SuToPhysicals.set(c.sellable_unit_id, new Set());
      qty1SuToPhysicals.get(c.sellable_unit_id).add(c.physical_product_id);
    }
  }
  const authoritativeSuIds = [...qty1SuToPhysicals.keys()];
  //   ── Q4: sku_master_link for authoritative sellable_units only
  const links = await _selectIn(db, 'sku_master_link', 'sku_master_id, sellable_unit_id', 'sellable_unit_id', authoritativeSuIds); inc();
  //   sku_master_id → Set(physical_id) · AUTHORITATIVE (qty=1 SoT)
  const knownSkuToPhysicals = new Map();
  for (const l of links) {
    if (!l.sku_master_id) continue;
    const pids = qty1SuToPhysicals.get(l.sellable_unit_id);
    if (!pids) continue;
    if (!knownSkuToPhysicals.has(l.sku_master_id)) knownSkuToPhysicals.set(l.sku_master_id, new Set());
    for (const pid of pids) knownSkuToPhysicals.get(l.sku_master_id).add(pid);
  }
  const mappedSkuMasterIds = new Set(knownSkuToPhysicals.keys());

  //   ── Q5-6 per channel: orders + items in lookback window
  const perChannelData = {};
  for (const ch of channels) {
    const orders = await _selectEligibleOrders(db, ch, windowStartIso, windowEndIso); inc();
    if (orders.length === 0) { perChannelData[ch] = { orders: [], items: [] }; continue; }
    const items = await _selectItemsForOrders(db, orders.map(o => o.id)); inc();
    perChannelData[ch] = { orders, items };
  }

  //   ── In-memory: identify excluded sku_master_ids + collect all item context
  const excludedSkuMap = new Map();   // sku_master_id → { sample_count, affected_items, orders:Set, channels:Set, obs_by_window:{30,60,90}, items:[] }
  for (const ch of Object.keys(perChannelData)) {
    const { orders, items } = perChannelData[ch];
    const orderById = new Map(orders.map(o => [o.id, o]));
    for (const it of items) {
      const ord = orderById.get(it.order_id);
      if (!ord) continue;
      //   Same line-level exclusion as Phase 8P-1
      const q = Number(it.quantity);
      const u = Number(it.unit_price);
      const d = Number(it.discount);
      const cur = String(it.currency || '').toUpperCase();
      if (!(q > 0)) continue;
      if (!Number.isFinite(u) || u <= 0) continue;
      if (Number.isFinite(d) && d > 0) continue;
      if (!['KRW', 'USD', 'JPY', 'CNY'].includes(cur)) continue;
      if (!Number.isFinite(fxTable[cur]) || fxTable[cur] <= 0) continue;
      if (it.sku_master_id == null || mappedSkuMasterIds.has(it.sku_master_id)) continue;

      const key = it.sku_master_id;
      let entry = excludedSkuMap.get(key);
      if (!entry) {
        entry = {
          sku_master_id: key,
          sample_count: 0, affected_items: 0,
          orders: new Set(), channels: new Set(),
          items: [],
          obs_by_window: { 30: 0, 60: 0, 90: 0 },
        };
        excludedSkuMap.set(key, entry);
      }
      entry.sample_count++;
      entry.affected_items++;
      entry.orders.add(it.order_id);
      entry.channels.add(ch);
      const ageDays = (nowMs - new Date(ord.shipped_at).getTime()) / ONE_DAY_MS;
      for (const w of [30, 60, 90]) if (ageDays <= w) entry.obs_by_window[w]++;
      entry.items.push({
        order_item_id: it.id, order_id: it.order_id,
        external_order_number: ord.external_order_number ?? null,
        channel: ch, listing_id: it.listing_id, variant_id: it.variant_id,
        marketplace_sku: it.marketplace_sku, product_id: it.product_id,
        unit_price_native: u, currency: cur,
        amount_krw: Math.round(u * fxTable[cur]),
        shipped_at: ord.shipped_at, age_days: ageDays,
      });
    }
  }

  //   ── Sort by sample_count · slice topN
  const excludedRanked = [...excludedSkuMap.values()].sort((a, b) => b.sample_count - a.sample_count);
  const excludedTop = excludedRanked.slice(0, topN);
  const excludedTopIds = excludedTop.map(e => e.sku_master_id);

  //   ── Q7: sku_master rows for the top-N (existence + name/sku)
  const skuMasterRows = await _selectIn(db, 'sku_master', 'id, internal_sku, title, status', 'id', excludedTopIds); inc();
  const skuMasterById = new Map(skuMasterRows.map(r => [r.id, r]));

  //   ── Q8: sku_listing_link rows for the top-N (variant/listing context)
  const linkRowsRes = await _selectIn(db, 'sku_listing_link', 'sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary', 'sku_id', excludedTopIds); inc();
  const linkRowsBySku = new Map();
  for (const l of linkRowsRes) {
    if (!linkRowsBySku.has(l.sku_id)) linkRowsBySku.set(l.sku_id, []);
    linkRowsBySku.get(l.sku_id).push(l);
  }

  //   ── Q9: sibling items on same listing_ids (bridge #1 candidates) — batch by
  //   unique listing_ids across all top-N SKUs.
  const uniqueListingIds = [...new Set(excludedTop.flatMap(e => e.items.map(i => i.listing_id).filter(Boolean)))];
  const siblingItemsRes = uniqueListingIds.length
    ? await _selectIn(db, 'oms_order_items', 'id, listing_id, variant_id, marketplace_sku, sku_master_id, product_id', 'listing_id', uniqueListingIds)
    : [];
  if (uniqueListingIds.length) inc();
  const siblingItems = siblingItemsRes || [];
  //   Group siblings by listing_id
  const siblingsByListing = new Map();
  for (const s of siblingItems) {
    if (!s.listing_id) continue;
    if (!siblingsByListing.has(s.listing_id)) siblingsByListing.set(s.listing_id, []);
    siblingsByListing.get(s.listing_id).push(s);
  }

  //   ── Q10: sibling items via shared product_id (bridge #2)
  const uniqueProductIds = [...new Set(excludedTop.flatMap(e => e.items.map(i => i.product_id).filter(v => Number.isFinite(Number(v)) && Number(v) > 0)))];
  const productSiblingRes = uniqueProductIds.length
    ? await _selectIn(db, 'oms_order_items', 'id, product_id, sku_master_id', 'product_id', uniqueProductIds)
    : [];
  if (uniqueProductIds.length) inc();
  const siblingsByProduct = new Map();
  for (const s of productSiblingRes || []) {
    if (!s.product_id) continue;
    if (!siblingsByProduct.has(s.product_id)) siblingsByProduct.set(s.product_id, []);
    siblingsByProduct.get(s.product_id).push(s);
  }

  //   ── Load pilotMappings (Owner-curated hints)
  const curatedBySkuId = _loadPilotMappings(pilotMappings);

  //   ── Classify each top-N sku
  const results = excludedTop.map(entry => _classifyOne({
    entry, skuMasterById, linkRowsBySku,
    siblingsByListing, siblingsByProduct,
    knownSkuToPhysicals, physicals,
    curatedBySkuId,
  }));

  //   ── Coverage leverage simulation
  const leverageSim = _simulateLeverage({ results, physicals, excludedTop, existingKnown: knownSkuToPhysicals, allExcluded: excludedRanked });

  //   ── BP diagnostic (physical_id=1)
  const bpDiag = _bpDiagnostic({
    physicalId: 1, physicals, knownSkuToPhysicals, results, allExcluded: excludedRanked,
  });

  //   ── Top opportunities · sorted primarily by deterministic safety, then samples, then leverage
  const topOpportunities = results
    .filter(r => r.classification === CLASSIFICATION.DETERMINISTIC_EXISTING_EVIDENCE || r.classification === CLASSIFICATION.PHYSICAL_PRODUCT_MISSING)
    .sort((a, b) => {
      //   1. deterministic safety (DETERMINISTIC before PHYSICAL_MISSING)
      const rankOrder = { DETERMINISTIC_EXISTING_EVIDENCE: 0, PHYSICAL_PRODUCT_MISSING: 1 };
      const r = rankOrder[a.classification] - rankOrder[b.classification];
      if (r !== 0) return r;
      //   2. completed sale observations
      if (b.completed_sale_items !== a.completed_sale_items) return b.completed_sale_items - a.completed_sale_items;
      //   3. SOLD_MEDIAN eligibility gain — approximate by 30d obs
      return (b.sales_observations_recovered_30d || 0) - (a.sales_observations_recovered_30d || 0);
    })
    .slice(0, 20);

  return {
    generated_at: new Date(nowMs).toISOString(),
    lookback_days: lookbackDays,
    channels,
    physicals_scanned: physicals.length,
    total_excluded_sku_master_ids: excludedRanked.length,
    analyzed_top_n: excludedTop.length,
    counts_by_classification: _countBy(results, r => r.classification),
    counts_by_proposed_action: _countBy(results, r => r.proposed_action),
    results,
    top_recovery_opportunities: topOpportunities,
    coverage_leverage_simulation: leverageSim,
    bp_diagnostic: bpDiag,
    query_count: queryCount,
    fx_used: fxTable,
    note: 'READ-ONLY audit · never writes DB · never repairs mappings · never creates physical_products · never uses title similarity as authoritative mapping · Phase 8P policy untouched',
  };
}

// ─── classification ─────────────────────────────

function _classifyOne({ entry, skuMasterById, linkRowsBySku, siblingsByListing, siblingsByProduct, knownSkuToPhysicals, physicals, curatedBySkuId }) {
  const skuId = entry.sku_master_id;
  const master = skuMasterById.get(skuId);
  const linkRows = linkRowsBySku.get(skuId) || [];
  const items = entry.items;

  //   INVALID_OR_ORPHANED_SKU · sku_master row missing
  if (!master) {
    return _finalize(entry, {
      sku_master_row: null,
      classification: CLASSIFICATION.INVALID_OR_ORPHANED_SKU,
      proposed_action: PROPOSED_ACTION.IGNORE_ORPHAN,
      missing_evidence: ['sku_master_row'],
      evidence: [],
      candidate_physical_products: [],
      deterministic_target_physical_product_id: null,
      existing_links: { sku_listing_link_rows: linkRows.length, sku_master_link_rows: 0 },
    });
  }

  //   Gather deterministic candidates from sibling evidence.
  const candidateSet = new Map();   // physical_id → { evidence_types:Set, confidence_basis:Set }
  const addCandidate = (pid, evType, basis) => {
    if (!Number.isFinite(pid)) return;
    if (!candidateSet.has(pid)) candidateSet.set(pid, { physical_product_id: pid, evidence_types: new Set(), confidence_basis: new Set() });
    candidateSet.get(pid).evidence_types.add(evType);
    candidateSet.get(pid).confidence_basis.add(basis);
  };

  //   Bridge #1: shared listing_id
  const uniqueListings = [...new Set(items.map(i => i.listing_id).filter(Boolean))];
  for (const l of uniqueListings) {
    const siblings = siblingsByListing.get(l) || [];
    for (const s of siblings) {
      if (s.sku_master_id == null || s.sku_master_id === skuId) continue;
      const pids = knownSkuToPhysicals.get(s.sku_master_id);
      if (!pids) continue;
      for (const pid of pids) addCandidate(pid, 'shared_listing_id', `oms_order_items.listing_id=${l} · sibling_sku_master_id=${s.sku_master_id}`);
    }
  }

  //   Bridge #2: shared product_id
  const uniqueProducts = [...new Set(items.map(i => i.product_id).filter(v => Number.isFinite(Number(v)) && Number(v) > 0))];
  for (const p of uniqueProducts) {
    const siblings = siblingsByProduct.get(p) || [];
    for (const s of siblings) {
      if (s.sku_master_id == null || s.sku_master_id === skuId) continue;
      const pids = knownSkuToPhysicals.get(s.sku_master_id);
      if (!pids) continue;
      for (const pid of pids) addCandidate(pid, 'shared_product_id', `oms_order_items.product_id=${p} · sibling_sku_master_id=${s.sku_master_id}`);
    }
  }

  //   Bridge #3: variant-adjacency via sku_listing_link (diagnostic only · NOT authoritative alone)
  const linkContext = linkRows.map(l => ({ marketplace: l.marketplace, listing_id: l.listing_id, option_id: l.option_id }));

  //   Bridge #4: pilotMappings.js curated hint (Owner-signed)
  const curated = curatedBySkuId.get(skuId);
  if (curated && Number.isFinite(curated.physical_product_id)) {
    addCandidate(curated.physical_product_id, 'pilot_mappings_owner_curated', `pilotMappings.js · ${curated.evidence || 'owner-curated'}`);
  }

  //   Build candidate objects for output
  const physicalTitleById = new Map(physicals.map(p => [p.id, p.canonical_title]));
  const candidates = [...candidateSet.values()].map(c => ({
    physical_product_id: c.physical_product_id,
    title: physicalTitleById.get(c.physical_product_id) ?? null,
    evidence_types: [...c.evidence_types],
    confidence_basis: [...c.confidence_basis].slice(0, 5),   // cap for report readability
  }));

  //   Decide classification
  //   PHYSICAL_PRODUCT_MISSING · no deterministic candidate emerged AND sku is not evidenced against ANY existing physical
  if (candidates.length === 0) {
    return _finalize(entry, {
      sku_master_row: { id: master.id, internal_sku: master.internal_sku, title_present: !!master.title, status: master.status ?? null },
      classification: CLASSIFICATION.PHYSICAL_PRODUCT_MISSING,
      proposed_action: PROPOSED_ACTION.CREATE_PHYSICAL_PRODUCT_REVIEW,
      missing_evidence: ['sibling_listing_id_bridge', 'sibling_product_id_bridge', 'pilot_curated_mapping'],
      evidence: [],
      candidate_physical_products: [],
      deterministic_target_physical_product_id: null,
      existing_links: { sku_listing_link_rows: linkRows.length, sku_master_link_rows: 0, sku_listing_context: linkContext.slice(0, 10) },
    });
  }
  //   DETERMINISTIC · exactly one candidate physical
  if (candidates.length === 1) {
    const pid = candidates[0].physical_product_id;
    return _finalize(entry, {
      sku_master_row: { id: master.id, internal_sku: master.internal_sku, title_present: !!master.title, status: master.status ?? null },
      classification: CLASSIFICATION.DETERMINISTIC_EXISTING_EVIDENCE,
      proposed_action: PROPOSED_ACTION.ADD_EXISTING_LINK,
      missing_evidence: [],
      evidence: candidates[0].confidence_basis,
      candidate_physical_products: candidates,
      deterministic_target_physical_product_id: pid,
      existing_links: { sku_listing_link_rows: linkRows.length, sku_master_link_rows: 0, sku_listing_context: linkContext.slice(0, 10) },
    });
  }
  //   Multiple candidates → HUMAN_REVIEW_REQUIRED
  return _finalize(entry, {
    sku_master_row: { id: master.id, internal_sku: master.internal_sku, title_present: !!master.title, status: master.status ?? null },
    classification: CLASSIFICATION.HUMAN_REVIEW_REQUIRED,
    proposed_action: PROPOSED_ACTION.HUMAN_REVIEW,
    missing_evidence: ['unique_physical_candidate'],
    evidence: candidates.flatMap(c => c.confidence_basis.slice(0, 2)),
    candidate_physical_products: candidates,
    deterministic_target_physical_product_id: null,
    existing_links: { sku_listing_link_rows: linkRows.length, sku_master_link_rows: 0, sku_listing_context: linkContext.slice(0, 10) },
  });
}

function _finalize(entry, extra) {
  return {
    sku_master_id: entry.sku_master_id,
    sku: extra.sku_master_row?.internal_sku ?? null,
    product_name: extra.sku_master_row?.title_present ? '(title omitted · diagnostic-only)' : null,
    channels: [...entry.channels],
    completed_sale_items: entry.affected_items,
    completed_orders: entry.orders.size,
    sales_observations_recovered_30d: entry.obs_by_window[30],
    sales_observations_recovered_60d: entry.obs_by_window[60],
    sales_observations_recovered_90d: entry.obs_by_window[90],
    ...extra,
    auto_write_allowed: false,
  };
}

// ─── coverage leverage simulation ───────────────

function _simulateLeverage({ results, physicals, excludedTop, existingKnown, allExcluded }) {
  //   For each deterministic result, add its physical_id to a projected
  //   "physical → observations count" map keyed by (window). Compute how
  //   many physicals would newly meet each policy threshold.
  const projectedObsByPhysical = new Map();   // physical_id → {30:count, 60:count, 90:count}
  //   Baseline coverage counts (current)
  const currentEligibleByPolicy = _emptyPolicyMap();
  //   The audit sees only excluded observations · to compute CURRENT coverage
  //   we'd need to include ELIGIBLE (mapped) observations too. We conservatively
  //   report:
  //     - incremental_eligible_observations = number of newly-recoverable observations from deterministic candidates
  //     - incremental_physicals             = physicals whose observation count crosses each policy threshold under simulation
  //   True coverage_pct requires Phase 8P-1 audit run.
  for (const r of results) {
    if (r.classification !== CLASSIFICATION.DETERMINISTIC_EXISTING_EVIDENCE) continue;
    const pid = r.deterministic_target_physical_product_id;
    if (!Number.isFinite(pid)) continue;
    if (!projectedObsByPhysical.has(pid)) projectedObsByPhysical.set(pid, { 30: 0, 60: 0, 90: 0 });
    const b = projectedObsByPhysical.get(pid);
    b[30] += r.sales_observations_recovered_30d;
    b[60] += r.sales_observations_recovered_60d;
    b[90] += r.sales_observations_recovered_90d;
  }
  const policies = [
    { name: 'A', lookback_days: 30, min_samples: 3 },
    { name: 'B', lookback_days: 30, min_samples: 2 },
    { name: 'C', lookback_days: 60, min_samples: 3 },
    { name: 'D', lookback_days: 90, min_samples: 3 },
  ];
  const out = [];
  for (const pol of policies) {
    let incrementalPhysicals = 0;
    let incrementalObs = 0;
    for (const [_pid, b] of projectedObsByPhysical) {
      incrementalObs += b[pol.lookback_days];
      if (b[pol.lookback_days] >= pol.min_samples) incrementalPhysicals++;
    }
    out.push({
      policy: pol.name, lookback_days: pol.lookback_days, min_samples: pol.min_samples,
      incremental_physicals_would_gain_median: incrementalPhysicals,
      incremental_eligible_observations: incrementalObs,
      note: 'Simulation only · Phase 8P policy NOT applied · requires Owner to add the deterministic links before real effect',
    });
  }
  return {
    baseline_note: 'Baseline current coverage computed by Phase 8P-1 audit · this Phase 8P-2 simulation reports only DELTAS from deterministic recovery',
    projected_deterministic_links: [...projectedObsByPhysical.entries()].map(([pid, b]) => ({ physical_product_id: pid, ...b })),
    policies: out,
  };
}

function _emptyPolicyMap() {
  return { A: 0, B: 0, C: 0, D: 0 };
}

// ─── BP diagnostic ─────────────────────────────

function _bpDiagnostic({ physicalId, physicals, knownSkuToPhysicals, results, allExcluded }) {
  const bpExists = physicals.some(p => p.id === physicalId);
  const bpKnownSkus = [];
  for (const [skuId, pids] of knownSkuToPhysicals.entries()) {
    if (pids.has(physicalId)) bpKnownSkus.push(skuId);
  }
  //   Excluded SKUs that mention BP as a candidate physical
  const bpCandidates = results.filter(r => (r.candidate_physical_products || []).some(c => c.physical_product_id === physicalId));
  const bpDeterministic = bpCandidates.filter(r => r.classification === CLASSIFICATION.DETERMINISTIC_EXISTING_EVIDENCE && r.deterministic_target_physical_product_id === physicalId);
  const bpAmbiguous = bpCandidates.filter(r => r.classification === CLASSIFICATION.HUMAN_REVIEW_REQUIRED);
  return {
    physical_product_id: physicalId,
    physical_exists: bpExists,
    currently_linked_sku_master_ids: bpKnownSkus,
    excluded_bp_candidates_by_class: _countBy(bpCandidates, r => r.classification),
    deterministic_bp_candidates: bpDeterministic.map(r => _bpSummary(r)),
    ambiguous_bp_candidates: bpAmbiguous.map(r => _bpSummary(r)),
    total_excluded_with_bp_candidate: bpCandidates.length,
    note: 'BP admission requires deterministic evidence (shared_listing_id / shared_product_id / owner_curated) · title similarity NEVER admits',
  };
}
function _bpSummary(r) {
  return {
    sku_master_id: r.sku_master_id, sku: r.sku,
    completed_sale_items: r.completed_sale_items,
    evidence: r.evidence,
    missing_evidence: r.missing_evidence,
  };
}

// ─── pilotMappings loader ─────────────────────

function _loadPilotMappings(injected) {
  const out = new Map();
  let src;
  if (injected) src = injected;
  else {
    try { src = require('./pilotMappings'); } catch (_) { return out; }
  }
  //   Expected shape: pilotMappings.PILOTS = [{physicalProductId, links: [{skuMasterId, evidence}], excluded: [{skuMasterId, reason}]}]
  const pilots = src && (src.PILOTS || src.default || src);
  if (!Array.isArray(pilots)) return out;
  for (const pilot of pilots) {
    const pid = Number(pilot.physicalProductId);
    if (!Number.isFinite(pid)) continue;
    for (const link of (pilot.links || [])) {
      if (!Number.isFinite(link.skuMasterId)) continue;
      out.set(link.skuMasterId, { physical_product_id: pid, evidence: link.evidence });
    }
    //   NOTE: pilot.excluded[] intentionally NOT auto-mapped · exclusion means Owner said DO NOT link.
  }
  return out;
}

// ─── query helpers ─────────────────────────────

async function _selectIn(db, table, cols, col, values) {
  if (!values || !values.length) return [];
  const res = await db.from(table).select(cols).in(col, values);
  if (res && res.error) throw new Error(`${table} select failed: ${res.error.message}`);
  return (res && res.data) || [];
}
async function _selectEligibleOrders(db, channel, windowStartIso, windowEndIso) {
  const res = await db.from('oms_orders')
    .select('id, channel, external_order_number, shipped_at, cancelled_at, order_status, payment_status')
    .eq('channel', channel)
    .gte('shipped_at', windowStartIso)
    .lte('shipped_at', windowEndIso);
  if (res && res.error) throw new Error(`oms_orders select failed: ${res.error.message}`);
  return ((res && res.data) || []).filter(o =>
    o.shipped_at && o.cancelled_at == null &&
    ELIGIBLE_ORDER_STATUS.has(String(o.order_status)) &&
    ELIGIBLE_PAYMENT_STATUS.has(String(o.payment_status))
  );
}
async function _selectItemsForOrders(db, orderIds) {
  if (!orderIds.length) return [];
  const res = await db.from('oms_order_items')
    .select('id, order_id, sku_master_id, product_id, listing_id, variant_id, marketplace_sku, quantity, unit_price, discount, currency')
    .in('order_id', orderIds);
  if (res && res.error) throw new Error(`oms_order_items select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

function _fxTable({ usdKrw, krwJpyRate, krwCnyRate } = {}) {
  const t = { KRW: 1 };
  if (Number.isFinite(Number(usdKrw))     && Number(usdKrw)     > 0) t.USD = Number(usdKrw);
  if (Number.isFinite(Number(krwJpyRate)) && Number(krwJpyRate) > 0) t.JPY = Number(krwJpyRate);
  if (Number.isFinite(Number(krwCnyRate)) && Number(krwCnyRate) > 0) t.CNY = Number(krwCnyRate);
  return t;
}
function _countBy(arr, fn) {
  const out = {};
  for (const x of arr) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}

module.exports = {
  runPhysicalIdentityCoverageRecoveryAudit,
  CLASSIFICATION,
  PROPOSED_ACTION,
  DEFAULT_TOP_N,
  DEFAULT_LOOKBACK_DAYS,
};
