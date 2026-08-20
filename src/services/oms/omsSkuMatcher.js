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
 */
'use strict';

const { matchOrderLine: legacyMatchOrderLine } = require('../skuMatcher');
const { getClient } = require('../../db/supabaseClient');

/**
 * Match a single canonical item.
 *
 * @param {Object} args
 * @param {string} args.channel                CanonicalOrder.channel
 * @param {import('./canonicalOrder').CanonicalOrderItem} args.item
 * @returns {Promise<{ skuMasterId:number|null, productId:number|null, matchStatus:string, matchConfidence:string|null, matchReason:string|null }>}
 */
async function matchCanonicalItem({ channel, item }) {
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
 * Bulk match — sequential (skuMatcher hits DB per line).
 * Failures on individual items do NOT abort the batch (§13).
 *
 * @param {Object} args
 * @param {string} args.channel
 * @param {import('./canonicalOrder').CanonicalOrderItem[]} args.items
 * @returns {Promise<Array<{ item: import('./canonicalOrder').CanonicalOrderItem, match: Object }>>}
 */
async function matchCanonicalItems({ channel, items }) {
  const out = [];
  for (const item of (items || [])) {
    const match = await matchCanonicalItem({ channel, item });
    out.push({ item, match });
  }
  return out;
}

module.exports = {
  matchCanonicalItem,
  matchCanonicalItems,
};
