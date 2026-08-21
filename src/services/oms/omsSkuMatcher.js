/**
 * src/services/oms/omsSkuMatcher.js — Reuse existing skuMatcher for OMS.
 *
 * Owner directive §8: 기존 skuMatcher.js 를 재사용한다. 새 matcher 를 중복 구현하지 않는다.
 *
 * Existing behaviour (src/services/skuMatcher.js):
 *   matchOrderLine({ marketplace_sku, listing_id, option_id }, { marketplace })
 *   → { matched_sku_id, match_status, match_confidence, match_reason }
 *
 * This wrapper:
 *   1) Bridges CanonicalOrderItem (camelCase, variantId) ↔ legacy shape (snake_case, option_id).
 *   2) Also resolves products.id when possible (existing matcher only returns sku_master.id).
 *   3) Never throws — returns { skuMasterId, productId, matchStatus, matchConfidence, matchReason }.
 *
 * Phase 8P-21B · STEP 0: marketplace_identity resolver runs BEFORE the legacy
 * 3-strategy chain. Owner-curated identity table is the deterministic authority.
 * Legacy waterfall runs only when the identity table has no hit — 100% backward
 * compatible. Conflicting identities (multiple identity_types → different
 * sku_master_ids on the same order-item) are surfaced as OWNER_REVIEW · NEVER
 * auto-linked. `match_status` reuses the existing 'matched_link' enum value
 * (allowlisted in migration 079 CHECK constraint · no migration needed).
 * `match_reason` starts with 'identity_exact:<type>' so audits can distinguish
 * identity hits from legacy 'link_exact' hits.
 */
'use strict';

const { matchOrderLine: legacyMatchOrderLine } = require('../skuMatcher');
const { getClient } = require('../../db/supabaseClient');
const {
  resolveManyByIdentities,
  resolveItemCandidates,
} = require('./marketplaceIdentityService');

/**
 * Phase 8P-21B · Build channel-specific identity candidate list from a
 * CanonicalOrderItem, in priority order (strongest identity first).
 *
 * ONLY uses fields the canonical adapter actually exposes:
 *   listingId, variantId, marketplaceSku
 *
 * Never uses title. Never uses transactionId (not exposed by CanonicalOrderItem).
 *
 * @param {string} channel
 * @param {import('./canonicalOrder').CanonicalOrderItem} item
 * @returns {Array<{channel:string, identityType:string, identityValue:string}>}
 */
function buildIdentityCandidates(channel, item) {
  if (!item || !channel) return [];
  const listingId = item.listingId != null && String(item.listingId).trim() !== '' ? String(item.listingId) : null;
  const variantId = item.variantId != null && String(item.variantId).trim() !== '' ? String(item.variantId) : null;
  const marketplaceSku = item.marketplaceSku != null && String(item.marketplaceSku).trim() !== '' ? String(item.marketplaceSku) : null;
  const out = [];
  switch (channel) {
    case 'ebay':
      if (listingId) out.push({ channel, identityType: 'ebay_listing_id', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'ebay_sku', identityValue: marketplaceSku });
      break;
    case 'shopify':
      if (variantId) out.push({ channel, identityType: 'shopify_variant_id', identityValue: variantId });
      if (listingId) out.push({ channel, identityType: 'shopify_product_id', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'shopify_sku', identityValue: marketplaceSku });
      break;
    case 'naver':
      if (listingId) out.push({ channel, identityType: 'naver_product_id', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'naver_sku', identityValue: marketplaceSku });
      break;
    case 'coupang':
      if (variantId) out.push({ channel, identityType: 'coupang_option_id', identityValue: variantId });
      if (listingId) out.push({ channel, identityType: 'coupang_vendor_item_id', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'coupang_sku', identityValue: marketplaceSku });
      break;
    case 'qoo10':
      if (variantId) out.push({ channel, identityType: 'qoo10_option_code', identityValue: variantId });
      if (listingId) out.push({ channel, identityType: 'qoo10_item_code', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'qoo10_sku', identityValue: marketplaceSku });
      break;
    case 'shopee':
      if (variantId) out.push({ channel, identityType: 'shopee_model_id', identityValue: variantId });
      if (listingId) out.push({ channel, identityType: 'shopee_item_id', identityValue: listingId });
      if (marketplaceSku) out.push({ channel, identityType: 'shopee_sku', identityValue: marketplaceSku });
      break;
    default:
      //   Unknown channels: nothing — legacy matcher will run.
      break;
  }
  return out;
}

/**
 * Match a single canonical item.
 *
 * Phase 8P-21B priority chain (STEP 0 added):
 *   0. marketplace_identity exact hit (Owner-curated)
 *   1. sku_listing_link (marketplace, listing_id, option_id)    — matched_link
 *   2. sku_listing_link.marketplace_sku                          — matched_marketplace_sku
 *   3. sku_master.internal_sku == marketplaceSku                 — matched_internal_sku
 *   4. no_match → failed
 *
 * @param {Object} args
 * @param {string} args.channel                CanonicalOrder.channel
 * @param {import('./canonicalOrder').CanonicalOrderItem} args.item
 * @param {Function} [args.identityResolver]   optional pre-built bulk resolver (from resolveManyByIdentities)
 *                                             — bulk path passes it to avoid per-item DB round-trips.
 * @returns {Promise<{ skuMasterId:number|null, productId:number|null, matchStatus:string, matchConfidence:string|null, matchReason:string|null }>}
 */
async function matchCanonicalItem({ channel, item, identityResolver }) {
  //   ─── STEP 0 · marketplace_identity ───
  const candidates = buildIdentityCandidates(channel, item);
  if (candidates.length > 0) {
    let identityResult = null;
    try {
      identityResult = await resolveItemCandidates(candidates,
        typeof identityResolver === 'function' ? { resolver: identityResolver } : {});
    } catch (_err) {
      //   Identity path is fail-open · fall through to legacy matcher.
      identityResult = null;
    }
    if (identityResult && identityResult.status === 'matched') {
      const skuMasterId = identityResult.sku_master_id;
      const productId = await resolveProductIdBySkuMasterId(skuMasterId);
      return {
        skuMasterId,
        productId,
        //   Reuse existing enum value (079 CHECK constraint allowlist).
        matchStatus: 'matched_link',
        matchConfidence: 'high',
        //   Distinguish from legacy 'link_exact' so audits can attribute provenance.
        matchReason: `identity_exact:${identityResult.hit.identity_type}`,
      };
    }
    if (identityResult && identityResult.status === 'conflict') {
      //   Explicit no-auto-link · Owner review required.
      return {
        skuMasterId: null,
        productId: null,
        matchStatus: 'failed',
        matchConfidence: null,
        matchReason: `identity_conflict:sku_masters=${identityResult.conflictingSkuMasterIds.join(',')}`,
      };
    }
    //   status === 'no_match' → fall through to legacy waterfall.
  }

  //   ─── STEPS 1-4 · legacy waterfall (unchanged) ───
  const legacyShape = {
    marketplace_sku: item?.marketplaceSku ?? null,
    listing_id: item?.listingId ?? null,
    option_id: item?.variantId ?? null,
  };
  let matchResult;
  try {
    matchResult = await legacyMatchOrderLine(legacyShape, { marketplace: channel });
  } catch (err) {
    return {
      skuMasterId: null,
      productId: null,
      matchStatus: 'pending',                      // do NOT set 'failed' on transient errors
      matchConfidence: null,
      matchReason: `matcher_error:${err && err.message ? err.message.slice(0, 80) : 'unknown'}`,
    };
  }

  const skuMasterId = matchResult.matched_sku_id || null;
  let productId = null;

  if (skuMasterId) {
    productId = await resolveProductIdBySkuMasterId(skuMasterId);
  }

  return {
    skuMasterId,
    productId,
    matchStatus: matchResult.match_status || 'pending',
    matchConfidence: matchResult.match_confidence || null,
    matchReason: matchResult.match_reason || null,
  };
}

/**
 * Best-effort: given a sku_master.id, find the linked products.id.
 * sku_master.internal_sku maps to products.sku by convention.
 * Returns null on any mismatch — never throws.
 */
async function resolveProductIdBySkuMasterId(skuMasterId) {
  try {
    const db = getClient();
    const { data: sm } = await db.from('sku_master')
      .select('internal_sku')
      .eq('id', skuMasterId)
      .maybeSingle();
    const internalSku = sm && sm.internal_sku;
    if (!internalSku) return null;
    const { data: p } = await db.from('products')
      .select('id')
      .eq('sku', internalSku)
      .maybeSingle();
    return p ? p.id : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Bulk match — sequential (legacy skuMatcher hits DB per line).
 * Phase 8P-21B: prefetches marketplace_identity for ALL items in ONE bulk
 * pass to avoid N per-item identity DB round-trips. Legacy waterfall still
 * runs per-item (unchanged).
 * Failures on individual items do NOT abort the batch (§13).
 *
 * @param {Object} args
 * @param {string} args.channel
 * @param {import('./canonicalOrder').CanonicalOrderItem[]} args.items
 * @returns {Promise<Array<{ item: import('./canonicalOrder').CanonicalOrderItem, match: Object }>>}
 */
async function matchCanonicalItems({ channel, items }) {
  const list = Array.isArray(items) ? items : [];
  //   Phase 8P-21B · bulk-prefetch identity candidates once per batch (bounded chunks).
  //   Fail-open on any error · legacy matcher still runs.
  let resolver = null;
  try {
    const allCandidates = list.flatMap((it) => buildIdentityCandidates(channel, it));
    if (allCandidates.length > 0) {
      const built = await resolveManyByIdentities(allCandidates);
      resolver = built.resolve;
    }
  } catch (_err) { resolver = null; }

  const out = [];
  for (const item of list) {
    const match = await matchCanonicalItem({ channel, item, identityResolver: resolver });
    out.push({ item, match });
  }
  return out;
}

module.exports = {
  matchCanonicalItem,
  matchCanonicalItems,
  //   Phase 8P-21B · exported for tests + admin surface
  buildIdentityCandidates,
};
