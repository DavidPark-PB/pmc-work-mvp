/**
 * src/services/oms/marketplaceIdentityService.js — Phase 8P-21B
 *
 * Deterministic bridge between marketplace-line identifiers and sku_master.
 *
 * Owner directive (21A audit):
 *   - EXACT matching only. No title lookup. No fuzzy match. No LLM.
 *   - Channel-scoped AND identity_type-scoped.
 *   - Bulk resolver uses bounded IN(...) chunking · no unbounded parallelism.
 *   - Malformed / null identity → no match (never a throw).
 *   - Zero marketplace API calls · zero write side-effects on the read functions.
 *
 * Identity precedence (per channel) — the caller (omsSkuMatcher) builds the
 * candidate list in priority order; this service does not decide priority.
 *
 * Conflict safety (mandatory · Task 5):
 *   If a single order-item's candidate list resolves to MULTIPLE distinct
 *   sku_master_ids across identity types, the resolver returns a
 *   { conflict: true, hits: [...] } signal instead of silently first-hit-winning.
 *   The caller must surface this as OWNER_REVIEW · never auto-link.
 *
 * Write helpers (Owner-only tools) are isolated behind an explicit param and are
 * NOT called from the ingestion path.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { validateEbaySkuAuthority } = require('../ebay/skuAuthorityValidator');

//   Allowlist mirrors migration 097 chk_marketplace_identity_type constraint.
//   Keep in sync; the DB is authoritative but validating in JS catches bad calls
//   before they hit the DB (avoids error spam in ingestion path).
const IDENTITY_TYPE_ALLOWLIST = Object.freeze(new Set([
  'ebay_listing_id', 'ebay_sku',
  'shopify_variant_id', 'shopify_product_id', 'shopify_sku',
  'naver_product_order_id', 'naver_product_id', 'naver_sku',
  'coupang_vendor_item_id', 'coupang_option_id', 'coupang_sku',
  'qoo10_item_code', 'qoo10_option_code', 'qoo10_sku',
  'shopee_item_id', 'shopee_model_id', 'shopee_sku',
  'upc_ean', 'gtin',
]));

const SOURCE_ALLOWLIST = Object.freeze(new Set([
  'owner_confirmed', 'ingest_seed', 'catalog_export', 'auto_inferred_review',
]));

const CONFIDENCE_ALLOWLIST = Object.freeze(new Set([
  'high', 'medium', 'low', 'review_pending',
]));

const SELECT_COLS = 'id, channel, identity_type, identity_value, sku_master_id, source, confidence';

//   ─────────────────────────────────────────────────────────
//   READ SIDE · zero-write · ingestion-path safe
//   ─────────────────────────────────────────────────────────

/**
 * Resolve a single identity to its sku_master row (or null).
 *
 * @param {Object} args
 * @param {string} args.channel
 * @param {string} args.identityType
 * @param {string|null|undefined} args.identityValue
 * @returns {Promise<{id:number, channel:string, identity_type:string, identity_value:string, sku_master_id:number, source:string, confidence:string}|null>}
 */
async function resolveByIdentity({ channel, identityType, identityValue } = {}) {
  if (!_isPresent(channel) || !_isPresent(identityType) || !_isPresent(identityValue)) return null;
  if (!IDENTITY_TYPE_ALLOWLIST.has(identityType)) return null;
  const db = getClient();
  const { data, error } = await db
    .from('marketplace_identity')
    .select(SELECT_COLS)
    .eq('channel', channel)
    .eq('identity_type', identityType)
    .eq('identity_value', String(identityValue))
    .maybeSingle();
  if (error) {
    //   Absent table = null (fail-open). Any other error = throw so caller sees it.
    if (_isMissingTableError(error)) return null;
    throw error;
  }
  return data || null;
}

/**
 * Bulk resolve many (channel, identityType, identityValue) candidates in one
 * pass. Groups by channel+identity_type · chunks each group at bounded size ·
 * sequential (no unbounded Promise.all).
 *
 * @param {Array<{channel:string, identityType:string, identityValue:string}>} candidates
 * @param {number} [chunkSize=100]
 * @returns {Promise<{
 *   resolve: (candidate) => Object|null,     // exact per-candidate lookup
 *   stats: { queries:number, rowsFound:number, elapsedMs:number },
 * }>}
 */
async function resolveManyByIdentities(candidates, chunkSize = 100) {
  const t0 = Date.now();
  const stats = { queries: 0, rowsFound: 0, elapsedMs: 0 };
  if (!Array.isArray(candidates) || candidates.length === 0) {
    stats.elapsedMs = Date.now() - t0;
    return { resolve: () => null, stats };
  }
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? Math.min(chunkSize, 500) : 100;

  //   Group unique identity_values by (channel, identityType) — one bulk query per group.
  const groups = new Map();  // `${channel}|${identityType}` → Set<value>
  for (const c of candidates) {
    if (!c || !_isPresent(c.channel) || !_isPresent(c.identityType) || !_isPresent(c.identityValue)) continue;
    if (!IDENTITY_TYPE_ALLOWLIST.has(c.identityType)) continue;
    const key = `${c.channel}|${c.identityType}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(String(c.identityValue));
  }

  //   `${channel}|${identityType}|${identityValue}` → row
  const found = new Map();
  const db = getClient();

  for (const [groupKey, valuesSet] of groups) {
    const [channel, identityType] = groupKey.split('|');
    const values = [...valuesSet];
    for (let i = 0; i < values.length; i += size) {
      const slice = values.slice(i, i + size);
      stats.queries += 1;
      const { data, error } = await db
        .from('marketplace_identity')
        .select(SELECT_COLS)
        .eq('channel', channel)
        .eq('identity_type', identityType)
        .in('identity_value', slice);
      if (error) {
        if (_isMissingTableError(error)) continue;   //   fail-open · empty result
        throw error;
      }
      for (const r of (data || [])) {
        stats.rowsFound += 1;
        found.set(`${r.channel}|${r.identity_type}|${r.identity_value}`, r);
      }
    }
  }

  stats.elapsedMs = Date.now() - t0;

  const resolve = (candidate) => {
    if (!candidate || !_isPresent(candidate.channel) || !_isPresent(candidate.identityType) || !_isPresent(candidate.identityValue)) return null;
    return found.get(`${candidate.channel}|${candidate.identityType}|${String(candidate.identityValue)}`) || null;
  };
  return { resolve, stats };
}

/**
 * Resolve a single order-item against an ordered list of identity candidates.
 * Enforces conflict safety (Task 5): if multiple identities resolve to
 * DIFFERENT sku_master_ids, no auto-link — return a conflict signal.
 *
 * @param {Array<{channel:string, identityType:string, identityValue:string}>} candidates
 *        In caller-defined priority order (strongest identity first).
 * @param {Object} [opts]
 * @param {Function} [opts.resolver] optional pre-built resolver (from resolveManyByIdentities)
 * @returns {Promise<
 *   | { status:'no_match', sku_master_id:null, hits:[] }
 *   | { status:'matched', sku_master_id:number, hit:Object, hits:Array<Object> }
 *   | { status:'conflict', sku_master_id:null, hits:Array<Object>, conflictingSkuMasterIds:number[] }
 * >}
 */
async function resolveItemCandidates(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(_isValidCandidate) : [];
  if (list.length === 0) return { status: 'no_match', sku_master_id: null, hits: [] };

  let resolver = opts.resolver;
  if (typeof resolver !== 'function') {
    const built = await resolveManyByIdentities(list);
    resolver = built.resolve;
  }

  const hits = [];
  const seenSkuMasterIds = new Set();
  for (const c of list) {
    const r = resolver(c);
    if (r && r.sku_master_id != null) {
      hits.push(r);
      seenSkuMasterIds.add(r.sku_master_id);
    }
  }

  if (hits.length === 0) return { status: 'no_match', sku_master_id: null, hits: [] };
  if (seenSkuMasterIds.size > 1) {
    return {
      status: 'conflict',
      sku_master_id: null,
      hits,
      conflictingSkuMasterIds: [...seenSkuMasterIds],
    };
  }
  //   Deterministic single-sku_master result. Return the first (highest-priority) hit.
  return { status: 'matched', sku_master_id: hits[0].sku_master_id, hit: hits[0], hits };
}

//   ─────────────────────────────────────────────────────────
//   WRITE SIDE · Owner-only · NOT invoked from ingestion path
//   ─────────────────────────────────────────────────────────

/**
 * Upsert a marketplace_identity row. Owner-only tool. NOT called by ingestion.
 *
 * @param {Object} args
 * @param {string} args.channel
 * @param {string} args.identityType         must be in IDENTITY_TYPE_ALLOWLIST
 * @param {string} args.identityValue
 * @param {number} args.skuMasterId
 * @param {'owner_confirmed'|'ingest_seed'|'catalog_export'|'auto_inferred_review'} [args.source='owner_confirmed']
 * @param {'high'|'medium'|'low'|'review_pending'} [args.confidence='high']
 * @param {string|null} [args.notes]
 * @param {number|null} [args.createdBy]
 * @returns {Promise<{id:number, channel:string, identity_type:string, identity_value:string, sku_master_id:number}>}
 */
async function upsertIdentity({
  channel, identityType, identityValue, skuMasterId,
  source = 'owner_confirmed', confidence = 'high', notes = null, createdBy = null,
} = {}) {
  if (!_isPresent(channel)) throw new Error('upsertIdentity: channel required');
  if (!IDENTITY_TYPE_ALLOWLIST.has(identityType)) throw new Error(`upsertIdentity: identity_type not in allowlist: ${identityType}`);
  if (!_isPresent(identityValue)) throw new Error('upsertIdentity: identity_value required');
  if (!Number.isInteger(skuMasterId) || skuMasterId <= 0) throw new Error('upsertIdentity: skuMasterId required (positive integer)');
  if (!SOURCE_ALLOWLIST.has(source)) throw new Error(`upsertIdentity: source not in allowlist: ${source}`);
  if (!CONFIDENCE_ALLOWLIST.has(confidence)) throw new Error(`upsertIdentity: confidence not in allowlist: ${confidence}`);

  //   Phase 8P-22B · guard against seeded malformed / non-unique eBay ebay_sku identities.
  //   Owner-confirmed inserts are trusted and bypass. Only ingest_seed / catalog_export are gated.
  if (channel === 'ebay' && identityType === 'ebay_sku' && source !== 'owner_confirmed') {
    const evidence = await _collectEbayIdentityEvidence(String(identityValue));
    const verdict = validateEbaySkuAuthority(String(identityValue), evidence);
    if (!verdict.ok) {
      const err = new Error(`upsertIdentity: rejected ebay_sku='${identityValue}' via 8P-22B guard: ${verdict.verdict}${verdict.reason ? ' · ' + verdict.reason : ''}`);
      err.code = 'H22B_EBAY_SKU_REJECTED';
      err.verdict = verdict.verdict;
      throw err;
    }
  }

  const db = getClient();
  const now = new Date().toISOString();
  const row = {
    channel,
    identity_type: identityType,
    identity_value: String(identityValue),
    sku_master_id: skuMasterId,
    source,
    confidence,
    notes,
    created_by: createdBy,
    updated_at: now,
  };
  const { data, error } = await db
    .from('marketplace_identity')
    .upsert(row, { onConflict: 'channel,identity_type,identity_value' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

//   ─────────────────────────────────────────────────────────
//   helpers
//   ─────────────────────────────────────────────────────────

function _isPresent(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return s.length > 0;
}
function _isValidCandidate(c) {
  return c && _isPresent(c.channel) && _isPresent(c.identityType) && _isPresent(c.identityValue)
    && IDENTITY_TYPE_ALLOWLIST.has(c.identityType);
}
function _isMissingTableError(err) {
  const msg = err && (err.message || err.hint || err.details || String(err));
  return typeof msg === 'string' && (/does not exist/i.test(msg) || err?.code === '42P01');
}

/**
 * Phase 8P-22B · gather evidence for eBay ebay_sku ingest-seed guard.
 * Reads sku_listing_link to count distinct listing_ids using this msku value.
 * Fail-open: any DB error returns "no evidence" (validator still catches
 * pattern-based rejects like price/uuid; only non-uniqueness detection is soft).
 */
async function _collectEbayIdentityEvidence(identityValue) {
  try {
    const db = getClient();
    const { data, error } = await db
      .from('sku_listing_link')
      .select('listing_id')
      .eq('marketplace', 'ebay')
      .eq('marketplace_sku', identityValue)
      .limit(50);
    if (error) return { observedListingIds: 0 };
    const set = new Set((data || []).map(r => String(r.listing_id)));
    return { observedListingIds: set };
  } catch (_e) {
    return { observedListingIds: 0 };
  }
}

module.exports = {
  //   read side · used by ingestion path (safe · fail-open on missing table)
  resolveByIdentity,
  resolveManyByIdentities,
  resolveItemCandidates,
  //   write side · Owner tools only · NEVER invoked from ingestion
  upsertIdentity,
  //   constants (exported for tests + admin UIs)
  IDENTITY_TYPE_ALLOWLIST,
  SOURCE_ALLOWLIST,
  CONFIDENCE_ALLOWLIST,
};
