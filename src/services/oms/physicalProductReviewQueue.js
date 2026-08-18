'use strict';

/**
 * src/services/oms/physicalProductReviewQueue.js — Phase 8P-3 · READ-ONLY.
 *
 * Owner review queue for PHYSICAL_PRODUCT_MISSING SKUs surfaced by the
 * Phase 8P-2 audit. Compresses ~100 candidates into rank-ordered items
 * + deterministic groupings so Owner can review highest-leverage
 * physical identities first.
 *
 * SoT reuse: calls `runPhysicalIdentityCoverageRecoveryAudit` and filters
 * to `classification === 'PHYSICAL_PRODUCT_MISSING'` + `proposed_action
 * === 'CREATE_PHYSICAL_PRODUCT_REVIEW'`. NEVER re-implements the audit.
 *
 * SAFETY:
 *   • Zero DB write · zero migration · zero mapping repair · zero
 *     physical_products insert · zero sku_master_link insert
 *   • Never uses title/name similarity as authoritative mapping. Titles
 *     may appear as REVIEW EVIDENCE ONLY (labelled identity_authority=false,
 *     review_evidence_only=true).
 *   • Grouping key is EXACT identifiers only (listing_id · product_id ·
 *     Owner-curated pilot mapping ID). No fuzzy title-similarity groups.
 *   • Decision template is returned per item but NEVER persisted.
 *   • BP invariants preserved · never attaches unknown SKUs to physical#1.
 */

const auditMod = require('./physicalIdentityCoverageRecoveryAudit');

const DEFAULT_TOP_N = 100;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_CHANNELS = ['shopify', 'ebay'];
const DEFAULT_REVIEW_LIMIT = 20;
const LEVERAGE_TIERS = [5, 10, 20, 50];

const DECISION_ENUM = Object.freeze({
  CREATE_NEW_PHYSICAL:      'CREATE_NEW_PHYSICAL',
  LINK_TO_EXISTING_PHYSICAL: 'LINK_TO_EXISTING_PHYSICAL',
  MARK_NON_PHYSICAL:        'MARK_NON_PHYSICAL',
  DEFER:                    'DEFER',
  NEEDS_MORE_EVIDENCE:      'NEEDS_MORE_EVIDENCE',
});

//   Phase 8P-4 canonical-writer interface schema (definition only · NO
//   implementation ships in this phase). Owner reviews the plan and
//   returns objects of this shape to a future writer service.
const CANONICAL_WRITER_INTERFACE = Object.freeze({
  version: 'v8p4.plan',
  execution_allowed: false,
  operations_supported: [
    'CREATE_NEW_PHYSICAL',
    'LINK_TO_EXISTING_PHYSICAL',
    'MARK_NON_PHYSICAL',
  ],
  operation_schemas: {
    CREATE_NEW_PHYSICAL: {
      creation_candidate_id: 'string · from physical_creation_candidates[].id',
      sku_master_ids: 'integer[] · the exact cohort',
      proposed_display_name: 'string · Owner-approved',
      set_code: 'string | null',
      language: 'string | null',
      unit_type: 'string | null',
      note: 'string | null',
      owner_confirmed: 'boolean · must be true',
    },
    LINK_TO_EXISTING_PHYSICAL: {
      creation_candidate_id: 'string',
      sku_master_ids: 'integer[]',
      target_physical_product_id: 'integer',
      owner_authoritative_bridge: 'string · Owner-supplied evidence identifier',
      owner_confirmed: 'boolean · must be true',
    },
    MARK_NON_PHYSICAL: {
      creation_candidate_id: 'string',
      sku_master_ids: 'integer[]',
      reason: 'string',
      owner_confirmed: 'boolean · must be true',
    },
  },
  writer_contract: {
    idempotent: true,
    append_only_audit_log: true,
    validates_before_write: true,
    requires_owner_confirmed: true,
    forbids_fuzzy_matching: true,
    respects_bp_invariant_lock: true,
  },
  note: 'Interface schema only · Phase 8P-4 does NOT include a writer implementation · Owner must approve writer construction as Phase 8P-5',
});

/**
 * @param {Object} args
 * @param {Object} args.db                       Supabase-like client
 * @param {number} [args.topN=100]               Passed to underlying audit
 * @param {number} [args.lookbackDays=90]
 * @param {string[]} [args.channels]
 * @param {number} [args.reviewLimit=20]         Cap on top_review_queue rows
 * @param {number} [args.physicalScanLimit=500]
 * @param {number} [args.asOfMs]
 * @param {Object} [args.fxRates]
 * @param {Object} [args.pilotMappings]          injectable for tests
 * @returns {Promise<Object>}
 */
async function buildPhysicalProductReviewQueue(args = {}) {
  const {
    db,
    topN = DEFAULT_TOP_N,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    channels = DEFAULT_CHANNELS,
    reviewLimit = DEFAULT_REVIEW_LIMIT,
    physicalScanLimit = 500,
    asOfMs,
    fxRates = {},
    pilotMappings = null,
  } = args;
  if (!db || typeof db.from !== 'function') {
    throw new Error('buildPhysicalProductReviewQueue: db required');
  }

  //   Phase 8P-2 audit is the sole SoT for classification. NEVER re-classify.
  const audit = await auditMod.runPhysicalIdentityCoverageRecoveryAudit({
    db, topN, lookbackDays, channels, physicalScanLimit, asOfMs, fxRates, pilotMappings,
  });
  let queryCount = audit.query_count;

  //   Filter to Owner review scope (Owner rule §1)
  const missingCandidates = (audit.results || []).filter(r =>
    r.classification === auditMod.CLASSIFICATION.PHYSICAL_PRODUCT_MISSING &&
    r.proposed_action === auditMod.PROPOSED_ACTION.CREATE_PHYSICAL_PRODUCT_REVIEW,
  );

  //   Q-extra: enrich with sku_master title (HUMAN review evidence only) ·
  //   labelled identity_authority=false, review_evidence_only=true. Batch
  //   one query for the missing set.
  const missingSkuIds = missingCandidates.map(c => c.sku_master_id);
  const skuMasterRows = await _selectIn(db, 'sku_master', 'id, internal_sku, title, product_type, brand, category, status', 'id', missingSkuIds);
  if (missingSkuIds.length) queryCount++;
  const skuMasterById = new Map(skuMasterRows.map(r => [r.id, r]));

  //   Build enriched items with rank inputs + review_evidence
  //   NOTE: recovery audit exposes only counts + IDs · we need per-item
  //   channels/listing_ids for grouping. Query the union of order items
  //   for the missing set once (batch). We ONLY read fields we already
  //   read in the audit (no new PII surface).
  const perSkuListingContext = await _fetchListingContextForSkus({ db, skuIds: missingSkuIds, lookbackDays, channels, asOfMs });
  queryCount += perSkuListingContext.query_count;

  const enriched = missingCandidates.map(c => {
    const master = skuMasterById.get(c.sku_master_id);
    const ctx = perSkuListingContext.bySkuId.get(c.sku_master_id) || {};
    return {
      sku_master_id: c.sku_master_id,
      internal_sku: master?.internal_sku ?? c.sku ?? null,
      channels: c.channels || [],
      completed_sale_items: c.completed_sale_items,
      completed_orders: c.completed_orders,
      sales_observations_30d: c.sales_observations_recovered_30d,
      sales_observations_60d: c.sales_observations_recovered_60d,
      sales_observations_90d: c.sales_observations_recovered_90d,
      listing_context: {
        marketplace_skus: (ctx.marketplace_skus || []).slice(0, 5),
        listing_ids:      (ctx.listing_ids || []).slice(0, 5),
        product_ids:      (ctx.product_ids || []).slice(0, 5),
        variant_ids:      (ctx.variant_ids || []).slice(0, 5),
      },
      review_evidence: [
        //   Owner rule §3 · every textual clue MUST carry the labels
        _labeledEvidence('sku_master.title', master?.title ?? null),
        _labeledEvidence('sku_master.internal_sku', master?.internal_sku ?? null),
        _labeledEvidence('sku_master.brand', master?.brand ?? null),
        _labeledEvidence('sku_master.category', master?.category ?? null),
        _labeledEvidence('sku_master.product_type', master?.product_type ?? null),
      ].filter(e => e.value != null),
      identity_authority: false,
      review_evidence_only: true,
    };
  });

  //   Rank deterministically (Owner rule §2)
  const ranked = enriched.slice().sort(_reviewComparator);
  ranked.forEach((item, i) => { item.review_rank = i + 1; });

  //   Grouping · EXACT identifiers only (Owner rule §4).
  //   NOTE (Phase 8P-4): review_groups are EVIDENCE groups · a single SKU
  //   with both listing_id and product_id appears in TWO evidence groups.
  //   They exist for Owner audit only.  For actual physical creation
  //   targets, see `physical_creation_candidates` below.
  const groups = _buildReviewGroups(ranked);

  //   Phase 8P-4 · union-find cohorts of SKUs sharing ANY exact
  //   authoritative identifier (listing_id OR product_id). Each cohort =
  //   AT MOST ONE physical_creation_candidate. A SKU with no shared
  //   identifiers becomes a singleton candidate. Never uses title
  //   similarity. Never auto-attaches to any existing physical.
  const creationCandidates = _buildPhysicalCreationCandidates(ranked);
  const evidenceStats = _computeEvidenceStats(ranked, groups);

  //   Cumulative leverage (Owner rule §5)
  const totalReviewableCompletedItems = ranked.reduce((a, x) => a + (x.completed_sale_items || 0), 0);
  const totalReviewable30d = ranked.reduce((a, x) => a + (x.sales_observations_30d || 0), 0);
  const cumulative_leverage = LEVERAGE_TIERS.map(tier => {
    const slice = ranked.slice(0, tier);
    const items = slice.reduce((a, x) => a + (x.completed_sale_items || 0), 0);
    const obs30 = slice.reduce((a, x) => a + (x.sales_observations_30d || 0), 0);
    return {
      tier: `top_${tier}`,
      candidate_count: slice.length,
      completed_sale_items_covered: items,
      pct_of_reviewable_completed_sale_items: totalReviewableCompletedItems > 0
        ? Math.round((items / totalReviewableCompletedItems) * 10000) / 100
        : 0,
      observations_30d_covered: obs30,
    };
  });

  const top_review_queue = ranked.slice(0, Math.max(0, Number(reviewLimit) || DEFAULT_REVIEW_LIMIT))
    .map(item => ({ ...item, decision_template: _decisionTemplate(item) }));

  //   BP diagnostic pass-through · assert no unknown SKU attached
  const bpDiag = audit.bp_diagnostic;
  const bp_invariants = {
    physical_product_id: 1,
    physical_exists: bpDiag?.physical_exists ?? false,
    currently_linked_sku_master_ids: (bpDiag?.currently_linked_sku_master_ids || []).slice().sort(),
    zero_auto_attachments: bpDiag?.deterministic_bp_candidates?.length === 0 && bpDiag?.ambiguous_bp_candidates?.length === 0,
    note: 'Phase 8P-3 NEVER attaches SKUs to BP · physical#1 mapping only changes via canonical writer (not this service)',
  };

  //   Phase 8P-4 · Top-N canonical creation review plan. Uses cohort-level
  //   candidates so a single physical isn't reviewed multiple times.
  //   Franchise caveat compares against existing physicals' canonical_title.
  //   One extra read-only query · titles NEVER used as authority.
  const existingPhysicalsRes = await db.from('physical_products').select('id, canonical_title').limit(physicalScanLimit);
  queryCount++;
  const existingPhysicalsForCaveat = (existingPhysicalsRes && existingPhysicalsRes.data) || [];
  const creationPlan = _buildCreationReviewPlan({
    creationCandidates, ranked,
    limit: Math.max(0, Number(reviewLimit) || DEFAULT_REVIEW_LIMIT),
    existingPhysicals: existingPhysicalsForCaveat,
  });

  return {
    generated_at: audit.generated_at,
    lookback_days: audit.lookback_days,
    channels: audit.channels,
    physicals_scanned: audit.physicals_scanned,
    summary: {
      excluded_skus: audit.total_excluded_sku_master_ids,
      analyzed_top_n: audit.analyzed_top_n,
      physical_missing_candidates: missingCandidates.length,
      review_groups: groups.length,
      ungrouped_candidates: groups.filter(g => g.sku_master_ids.length === 1).length,
      completed_sales_represented: totalReviewableCompletedItems,
      observations_30d_represented: totalReviewable30d,
      observations_90d_represented: ranked.reduce((a, x) => a + (x.sales_observations_90d || 0), 0),
      //   Phase 8P-4 · disambiguate evidence-vs-creation counts
      physical_creation_candidates: creationCandidates.length,
      multi_sku_creation_candidates: creationCandidates.filter(c => c.sku_master_ids.length > 1).length,
      singleton_creation_candidates: creationCandidates.filter(c => c.sku_master_ids.length === 1).length,
    },
    evidence_stats: evidenceStats,
    cumulative_leverage,
    review_groups: groups,
    physical_creation_candidates: creationCandidates,
    creation_review_plan: creationPlan,
    canonical_writer_interface: CANONICAL_WRITER_INTERFACE,
    top_review_queue,
    bp_invariants,
    query_count: queryCount,
    fx_used: audit.fx_used,
    note: 'READ-ONLY · zero DB write · titles are HUMAN review evidence only · never authoritative · decision_template NEVER persisted',
  };
}

// ─── helpers ──────────────────────────────────────

function _labeledEvidence(field, value) {
  return {
    field, value,
    identity_authority: false,
    review_evidence_only: true,
  };
}

function _decisionTemplate(item) {
  return {
    review_target_type: 'sku_master',
    sku_master_id: item.sku_master_id,
    owner_decision: null,                    // enum from DECISION_ENUM
    target_physical_product_id: null,        // required for LINK_TO_EXISTING_PHYSICAL
    proposed_display_name: null,             // required for CREATE_NEW_PHYSICAL
    note: null,
    auto_create_allowed: false,
    auto_link_allowed: false,
    persisted: false,
    schema_note: 'Owner returns this object to a future canonical writer · this service NEVER writes',
  };
}

function _reviewComparator(a, b) {
  //   Owner rule §2 (deterministic ranking):
  //   1. completed_sale_items DESC
  //   2. sales_observations_30d DESC
  //   3. sales_observations_90d DESC
  //   4. channels.length DESC
  //   5. sku_master_id ASC (stable tie-break)
  if (b.completed_sale_items !== a.completed_sale_items) return b.completed_sale_items - a.completed_sale_items;
  if (b.sales_observations_30d !== a.sales_observations_30d) return b.sales_observations_30d - a.sales_observations_30d;
  if (b.sales_observations_90d !== a.sales_observations_90d) return b.sales_observations_90d - a.sales_observations_90d;
  const chA = (a.channels || []).length, chB = (b.channels || []).length;
  if (chB !== chA) return chB - chA;
  return (a.sku_master_id || 0) - (b.sku_master_id || 0);
}

function _buildReviewGroups(rankedItems) {
  //   Grouping · EXACT identifiers only (Owner rule §4).
  //   A group is a set of SKUs that share ONE deterministic identifier.
  //   Grouping keys (in priority order):
  //     1. exact listing_id (marketplace + listing_id · deterministic)
  //     2. exact product_id (products.id · deterministic)
  //     3. sku_master_id (fallback · always a singleton group)
  //   NEVER groups by title similarity.
  const groups = new Map();       // groupKey → { sku_master_ids, listing_ids, product_ids, items }
  for (const item of rankedItems) {
    const listingKeys = (item.listing_context.listing_ids || []).map(l => `listing:${l}`);
    const productKeys = (item.listing_context.product_ids || []).map(p => `product:${p}`);
    const keys = [...listingKeys, ...productKeys];
    if (keys.length === 0) {
      keys.push(`sku:${item.sku_master_id}`);     // singleton fallback
    }
    for (const k of keys) {
      if (!groups.has(k)) {
        groups.set(k, {
          review_group_id: k,
          group_basis: k.startsWith('listing:') ? 'exact_listing_id' :
                       k.startsWith('product:') ? 'exact_product_id' : 'singleton_sku_master_id',
          sku_master_ids: new Set(),
          channels: new Set(),
          listing_ids: new Set(),
          product_ids: new Set(),
          items: [],
          _agg: { completed_sale_items: 0, observations_30d: 0, observations_60d: 0, observations_90d: 0 },
          _titles: [],
        });
      }
      const g = groups.get(k);
      g.sku_master_ids.add(item.sku_master_id);
      for (const ch of item.channels) g.channels.add(ch);
      for (const l of item.listing_context.listing_ids) g.listing_ids.add(l);
      for (const p of item.listing_context.product_ids) g.product_ids.add(p);
      g.items.push(item);
      const titleEv = item.review_evidence.find(e => e.field === 'sku_master.title');
      if (titleEv?.value && !g._titles.includes(titleEv.value)) g._titles.push(titleEv.value);
    }
  }
  //   Deduplicate: aggregate each SKU's contribution once per group
  const out = [];
  for (const g of groups.values()) {
    const skuIds = [...g.sku_master_ids];
    let items = 0, o30 = 0, o60 = 0, o90 = 0;
    for (const it of g.items) {
      items += it.completed_sale_items || 0;
      o30 += it.sales_observations_30d || 0;
      o60 += it.sales_observations_60d || 0;
      o90 += it.sales_observations_90d || 0;
    }
    out.push({
      review_group_id: g.review_group_id,
      group_basis: g.group_basis,
      sku_master_ids: skuIds.sort((a, b) => a - b),
      channels: [...g.channels].sort(),
      listing_ids: [...g.listing_ids].sort(),
      product_ids: [...g.product_ids].sort(),
      completed_sale_items: items,
      observations_30d: o30,
      observations_60d: o60,
      observations_90d: o90,
      review_evidence: g._titles.slice(0, 5).map(t => _labeledEvidence('sku_master.title(group_sample)', t)),
      suggested_owner_question: g.group_basis === 'exact_listing_id'
        ? 'Do these SKUs (all appearing on the same listing) represent one physical product?'
        : g.group_basis === 'exact_product_id'
          ? 'Do these SKUs (sharing products.id) represent one physical product?'
          : 'Does this SKU represent a single new physical product · or should it be linked to an existing one?',
      auto_create_allowed: false,
      auto_link_allowed: false,
    });
  }
  //   Sort groups by leverage (completed items DESC · then observations_30d DESC · then id)
  out.sort((a, b) => {
    if (b.completed_sale_items !== a.completed_sale_items) return b.completed_sale_items - a.completed_sale_items;
    if (b.observations_30d !== a.observations_30d) return b.observations_30d - a.observations_30d;
    return String(a.review_group_id).localeCompare(String(b.review_group_id));
  });
  return out;
}

async function _fetchListingContextForSkus({ db, skuIds, lookbackDays, channels, asOfMs }) {
  //   Batch-fetch order items for the missing SKU set so we can surface
  //   listing_id / product_id / marketplace_sku / variant_id · NO PII.
  //   NOTE: we filter by sku_master_id IN · already scoped to top-N missing.
  const out = { bySkuId: new Map(), query_count: 0 };
  if (!skuIds.length) return out;
  const now = Number.isFinite(asOfMs) ? asOfMs : Date.now();
  const daysN = Math.max(1, Number(lookbackDays) || 90);
  const startIso = new Date(now - daysN * 86400_000).toISOString();
  const endIso = new Date(now).toISOString();
  //   One query per channel for orders in window · one items query for those orders
  const eligibleOrderIds = new Set();
  const orderChannelById = new Map();
  for (const ch of channels) {
    const res = await db.from('oms_orders')
      .select('id, channel, shipped_at, cancelled_at, order_status, payment_status')
      .eq('channel', ch).gte('shipped_at', startIso).lte('shipped_at', endIso);
    out.query_count++;
    for (const o of (res && res.data) || []) {
      if (!o.shipped_at || o.cancelled_at || o.order_status !== 'shipped' && o.order_status !== 'completed') continue;
      if (o.payment_status !== 'paid') continue;
      eligibleOrderIds.add(o.id); orderChannelById.set(o.id, ch);
    }
  }
  if (!eligibleOrderIds.size) return out;
  //   Fetch order items where sku_master_id IN skuIds AND order_id IN eligibleOrderIds
  const itemsRes = await db.from('oms_order_items')
    .select('id, order_id, sku_master_id, listing_id, variant_id, marketplace_sku, product_id')
    .in('sku_master_id', skuIds);
  out.query_count++;
  for (const it of (itemsRes && itemsRes.data) || []) {
    if (!eligibleOrderIds.has(it.order_id)) continue;
    if (!it.sku_master_id) continue;
    let entry = out.bySkuId.get(it.sku_master_id);
    if (!entry) {
      entry = { marketplace_skus: new Set(), listing_ids: new Set(), product_ids: new Set(), variant_ids: new Set() };
      out.bySkuId.set(it.sku_master_id, entry);
    }
    if (it.marketplace_sku) entry.marketplace_skus.add(String(it.marketplace_sku));
    if (it.listing_id) entry.listing_ids.add(String(it.listing_id));
    if (it.product_id != null && Number.isFinite(Number(it.product_id))) entry.product_ids.add(Number(it.product_id));
    if (it.variant_id) entry.variant_ids.add(String(it.variant_id));
  }
  //   Convert Sets to sorted arrays
  for (const [k, v] of out.bySkuId) {
    out.bySkuId.set(k, {
      marketplace_skus: [...v.marketplace_skus].sort(),
      listing_ids: [...v.listing_ids].sort(),
      product_ids: [...v.product_ids].sort((a, b) => a - b),
      variant_ids: [...v.variant_ids].sort(),
    });
  }
  return out;
}

// ─── Phase 8P-4 · union-find cohort builder ───────

function _buildPhysicalCreationCandidates(rankedItems) {
  //   Owner rule §2: 1 unresolved SKU = AT MOST 1 creation candidate.
  //   Multi-SKU cohort ONLY when they share EXACT authoritative identifier
  //   (listing_id · product_id · Owner-curated pilot mapping). Title
  //   similarity NEVER merges.
  //
  //   Union-find: each SKU starts in its own set · shared exact identifier
  //   unions two sets. Result is disjoint cohorts.
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const item of rankedItems) parent.set(item.sku_master_id, item.sku_master_id);

  //   Index SKUs by listing_id and product_id · union across shares
  const skusByListingId = new Map();
  const skusByProductId = new Map();
  for (const item of rankedItems) {
    for (const l of (item.listing_context.listing_ids || [])) {
      const k = String(l);
      if (!skusByListingId.has(k)) skusByListingId.set(k, []);
      skusByListingId.get(k).push(item.sku_master_id);
    }
    for (const p of (item.listing_context.product_ids || [])) {
      const k = Number(p);
      if (!Number.isFinite(k)) continue;
      if (!skusByProductId.has(k)) skusByProductId.set(k, []);
      skusByProductId.get(k).push(item.sku_master_id);
    }
  }
  for (const ids of skusByListingId.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  for (const ids of skusByProductId.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);

  //   Assemble cohorts
  const byRoot = new Map();
  for (const item of rankedItems) {
    const r = find(item.sku_master_id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(item);
  }

  //   Owner rule §7 · same franchise/brand NEVER auto-unions two SKUs. The
  //   union-find above only fires on exact identifier hits · brand/title
  //   is not consulted. Sanity assert (defensive): every cohort has proof
  //   of a shared exact identifier or is a singleton.
  const out = [];
  let idx = 0;
  for (const [rootSku, items] of byRoot) {
    const skuIds = items.map(i => i.sku_master_id).sort((a, b) => a - b);
    const listing_ids = _unionArrays(items.map(i => i.listing_context.listing_ids || []));
    const product_ids = _unionArrays(items.map(i => i.listing_context.product_ids || [])).map(Number).filter(Number.isFinite);
    const channels = _unionArrays(items.map(i => i.channels || []));
    const completed_sale_items = items.reduce((a, x) => a + (x.completed_sale_items || 0), 0);
    const observations_30d = items.reduce((a, x) => a + (x.sales_observations_30d || 0), 0);
    const observations_60d = items.reduce((a, x) => a + (x.sales_observations_60d || 0), 0);
    const observations_90d = items.reduce((a, x) => a + (x.sales_observations_90d || 0), 0);
    //   Cohort bridge: the exact identifier that caused this cohort to
    //   union (or 'sku:<id>' for singleton).
    const cohort_bridge = _cohortBridge(items, skusByListingId, skusByProductId, rootSku);
    idx++;
    out.push({
      id: `pcc-${idx}`,
      cohort_root_sku_master_id: rootSku,
      sku_master_ids: skuIds,
      channels,
      listing_ids,
      product_ids,
      completed_sale_items, observations_30d, observations_60d, observations_90d,
      cohort_bridge,
      auto_create_allowed: false,
      auto_link_allowed: false,
    });
  }
  //   Rank cohorts by completed_sale_items DESC (Owner rule §2)
  out.sort((a, b) => {
    if (b.completed_sale_items !== a.completed_sale_items) return b.completed_sale_items - a.completed_sale_items;
    if (b.observations_30d !== a.observations_30d) return b.observations_30d - a.observations_30d;
    return a.cohort_root_sku_master_id - b.cohort_root_sku_master_id;
  });
  //   Reassign deterministic IDs after final sort
  out.forEach((c, i) => { c.id = `pcc-${i + 1}`; c.cohort_rank = i + 1; });
  return out;
}

function _unionArrays(arrs) {
  const s = new Set();
  for (const a of arrs) for (const v of (a || [])) if (v != null) s.add(v);
  return [...s].sort();
}

function _cohortBridge(items, skusByListingId, skusByProductId, rootSku) {
  //   Report the identifier that caused this cohort to exist.
  if (items.length === 1) return { basis: 'singleton_sku_master_id', value: `sku:${rootSku}` };
  //   Look for a listing_id shared by ≥2 SKUs in this cohort
  const cohortSkuSet = new Set(items.map(i => i.sku_master_id));
  for (const [lid, skus] of skusByListingId) {
    const inCohort = skus.filter(s => cohortSkuSet.has(s));
    if (inCohort.length >= 2) return { basis: 'exact_listing_id', value: `listing:${lid}`, sku_master_ids: [...new Set(inCohort)].sort((a, b) => a - b) };
  }
  for (const [pid, skus] of skusByProductId) {
    const inCohort = skus.filter(s => cohortSkuSet.has(s));
    if (inCohort.length >= 2) return { basis: 'exact_product_id', value: `product:${pid}`, sku_master_ids: [...new Set(inCohort)].sort((a, b) => a - b) };
  }
  return { basis: 'transitive_exact_identifier', value: 'union-find cohort · multiple exact identifier links' };
}

function _computeEvidenceStats(rankedItems, evidenceGroups) {
  const uniqueSkus = new Set(rankedItems.map(i => i.sku_master_id));
  const listingIds = new Set(rankedItems.flatMap(i => (i.listing_context.listing_ids || []).map(String)));
  const productIds = new Set(rankedItems.flatMap(i => (i.listing_context.product_ids || []).map(Number).filter(Number.isFinite)));
  //   How many SKUs appear in BOTH a listing evidence group and a product evidence group?
  const skusWithListing = new Set(rankedItems.filter(i => (i.listing_context.listing_ids || []).length > 0).map(i => i.sku_master_id));
  const skusWithProduct = new Set(rankedItems.filter(i => (i.listing_context.product_ids || []).length > 0).map(i => i.sku_master_id));
  const skusInBoth = [...skusWithListing].filter(s => skusWithProduct.has(s));
  //   How many evidence groups does the average SKU appear in?
  const skuAppearanceCount = new Map();
  for (const g of evidenceGroups) {
    for (const sid of g.sku_master_ids) skuAppearanceCount.set(sid, (skuAppearanceCount.get(sid) || 0) + 1);
  }
  const duplicatedSkuCount = [...skuAppearanceCount.values()].filter(n => n > 1).length;
  const totalGroupParticipations = [...skuAppearanceCount.values()].reduce((a, b) => a + b, 0);
  //   Multi-SKU exact-identifier groups
  const multiSkuGroups = evidenceGroups.filter(g => g.sku_master_ids.length > 1);
  return {
    unique_sku_master_ids: uniqueSkus.size,
    unique_listing_ids: listingIds.size,
    unique_product_ids: productIds.size,
    skus_with_listing_evidence: skusWithListing.size,
    skus_with_product_evidence: skusWithProduct.size,
    skus_in_both_listing_and_product_evidence: skusInBoth.length,
    evidence_groups_total: evidenceGroups.length,
    evidence_groups_multi_sku: multiSkuGroups.length,
    total_sku_group_participations: totalGroupParticipations,
    duplicated_sku_count_across_evidence_groups: duplicatedSkuCount,
    note: 'Evidence groups intentionally may exceed unique SKU count · use physical_creation_candidates for actual creation targets',
  };
}

function _buildCreationReviewPlan({ creationCandidates, ranked, limit, existingPhysicals }) {
  //   Take top-N cohorts and produce Owner-facing decision recommendations.
  //   NEVER auto-attaches. NEVER recommends LINK_TO_EXISTING_PHYSICAL by
  //   franchise/title alone (Owner rule §7). PHYSICAL_PRODUCT_MISSING
  //   input means no bridge to existing physical existed at 8P-2 audit
  //   time · so LINK is only surfaced when a caller-supplied Owner
  //   authoritative bridge later reappears (not this phase).
  const rankedByCohortRoot = new Map();
  for (const c of creationCandidates) {
    //   Attach the highest-rank item's title as diagnostic display name
    const sampleItem = ranked.find(r => r.sku_master_id === c.cohort_root_sku_master_id) || ranked[0];
    rankedByCohortRoot.set(c.cohort_root_sku_master_id, sampleItem);
  }
  const plan = creationCandidates.slice(0, Math.max(0, Number(limit) || 20)).map((c, i) => {
    const sampleItem = rankedByCohortRoot.get(c.cohort_root_sku_master_id) || { review_evidence: [] };
    const titleEv = sampleItem.review_evidence.find(e => e.field === 'sku_master.title');
    const internalSkuEv = sampleItem.review_evidence.find(e => e.field === 'sku_master.internal_sku');
    const brandEv = sampleItem.review_evidence.find(e => e.field === 'sku_master.brand');
    const proposedName = titleEv?.value ?? internalSkuEv?.value ?? `sku_master_id=${c.cohort_root_sku_master_id}`;

    //   Recommendation logic (Owner rule §5)
    const hasListingEvidence = c.listing_ids.length > 0;
    const hasProductEvidence = c.product_ids.length > 0;
    const hasSalesEvidence = c.completed_sale_items > 0;
    let proposed_decision = null;
    let confidence = 'UNKNOWN';
    let reason;
    if (!hasSalesEvidence) {
      proposed_decision = DECISION_ENUM.DEFER;
      reason = 'no_completed_sales_evidence';
    } else if (!hasListingEvidence && !hasProductEvidence) {
      proposed_decision = DECISION_ENUM.NEEDS_MORE_EVIDENCE;
      confidence = 'LOW';
      reason = 'sales_present_but_no_listing_or_product_identifier_bridge';
    } else if (titleEv?.value) {
      proposed_decision = DECISION_ENUM.CREATE_NEW_PHYSICAL;
      confidence = 'LOW';   //   Owner rule §5 · title is review-only · Owner must confirm before writer runs
      reason = 'listing_or_product_evidence_present · sku_master.title present · Owner must confirm physical merchandise identity before create';
    } else {
      proposed_decision = DECISION_ENUM.NEEDS_MORE_EVIDENCE;
      confidence = 'LOW';
      reason = 'listing_or_product_evidence_present_but_no_display_name_hint';
    }

    //   Extra guard (Owner rule §7): if title contains a franchise word
    //   (NIKKE/Pokemon/BP/etc) that ALSO matches an existing physical's
    //   canonical_title, we do NOT recommend LINK. We recommend
    //   CREATE_NEW_PHYSICAL and add a caveat note. Title never authoritative.
    const franchiseSensitive = _detectFranchiseWordOverlap(titleEv?.value ?? null, existingPhysicals);
    const franchise_caveat = franchiseSensitive
      ? 'Title mentions the same franchise/brand as an existing physical (e.g., NIKKE/BP). This alone is NOT authoritative · Owner MUST verify with an exact identifier bridge before choosing LINK_TO_EXISTING_PHYSICAL. Recommendation stays CREATE_NEW_PHYSICAL.'
      : null;

    return {
      review_rank: i + 1,
      creation_candidate_id: c.id,
      cohort_root_sku_master_id: c.cohort_root_sku_master_id,
      sku_master_ids: c.sku_master_ids,
      completed_sale_items: c.completed_sale_items,
      observations_30d: c.observations_30d,
      observations_60d: c.observations_60d,
      observations_90d: c.observations_90d,
      channels: c.channels,
      listing_ids: c.listing_ids,
      product_ids: c.product_ids,
      cohort_bridge: c.cohort_bridge,
      exact_identifier_evidence: {
        listing_ids: c.listing_ids,
        product_ids: c.product_ids,
      },
      title_review_only: titleEv
        ? { field: titleEv.field, value: titleEv.value, identity_authority: false, review_evidence_only: true }
        : null,
      brand_review_only: brandEv
        ? { field: brandEv.field, value: brandEv.value, identity_authority: false, review_evidence_only: true }
        : null,
      existing_physical_authoritative_bridge: null,   //   PHYSICAL_PRODUCT_MISSING by construction · no bridge
      proposed_decision,
      proposed_display_name: proposedName,
      confidence,
      reason,
      franchise_caveat,
      auto_create_allowed: false,
      auto_link_allowed: false,
      write_allowed: false,
      decision_template: {
        review_target_type: 'physical_creation_candidate',
        creation_candidate_id: c.id,
        sku_master_ids: c.sku_master_ids,
        owner_decision: null,                       // DECISION_ENUM
        target_physical_product_id: null,           // required for LINK_TO_EXISTING_PHYSICAL
        proposed_display_name: null,                // required for CREATE_NEW_PHYSICAL
        owner_authoritative_bridge: null,           // required for LINK_TO_EXISTING_PHYSICAL
        owner_confirmed: false,                     // writer will reject unless true
        note: null,
        auto_create_allowed: false,
        auto_link_allowed: false,
        persisted: false,
        writer_interface_version: CANONICAL_WRITER_INTERFACE.version,
      },
    };
  });
  return {
    limit,
    total_candidates_available: creationCandidates.length,
    plan,
    note: 'Recommendations · not decisions · Owner must set owner_confirmed=true and complete required fields before a future writer runs',
  };
}

function _detectFranchiseWordOverlap(title, existingPhysicals) {
  //   READ-ONLY caveat detector. Extracts alphanumeric tokens ≥3 chars
  //   from the title and existing physicals' canonical_title, checks for
  //   any overlap. NEVER used as authority · only sets a caveat flag
  //   surfaced to Owner. Prevents Owner from accidentally choosing LINK
  //   because "NIKKE" appears in both titles.
  if (!title || !Array.isArray(existingPhysicals) || !existingPhysicals.length) return false;
  const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/i).filter(t => t.length >= 3);
  const candidateTokens = new Set(tokenize(title));
  for (const p of existingPhysicals) {
    const existingTokens = new Set(tokenize(p.canonical_title || ''));
    for (const t of candidateTokens) if (existingTokens.has(t)) return true;
  }
  return false;
}

async function _selectIn(db, table, cols, col, values) {
  if (!values || !values.length) return [];
  const res = await db.from(table).select(cols).in(col, values);
  if (res && res.error) throw new Error(`${table} select failed: ${res.error.message}`);
  return (res && res.data) || [];
}

module.exports = {
  buildPhysicalProductReviewQueue,
  DECISION_ENUM,
  LEVERAGE_TIERS,
  DEFAULT_TOP_N,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_REVIEW_LIMIT,
  CANONICAL_WRITER_INTERFACE,
};
