/**
 * src/services/ebay/skuAuthorityValidator.js — Phase 8P-22B
 *
 * Deterministic validator for eBay SKU authority.
 *
 * Prevents malformed / non-unique eBay SKU artifacts (e.g. "19.90", "47.94",
 * UUID fallbacks) from becoming authoritative sku_master.internal_sku or
 * marketplace_identity(identity_type='ebay_sku') rows.
 *
 * Scope: eBay seed path only. Other channels/paths are unaffected.
 * Owner rule (H22B): evidence-based rejection. Never a broad "short numeric
 * always invalid" rule without cross-listing evidence.
 *
 * Verdicts:
 *   VALID_AUTHORITY        — safe to use as authoritative eBay SKU
 *   INVALID_BLANK          — null/empty/whitespace
 *   INVALID_PRICE_SHAPED   — matches /^\d+\.\d\d?$/ (e.g. "19.90", "47.94")
 *   INVALID_UUID_ARTIFACT  — matches UUID-shape AND flagged as generated
 *                            fallback (canonicalUuidArtifact:true) — a bare
 *                            UUID from an authoritative seller field is NOT
 *                            rejected by this validator alone
 *   INVALID_NON_UNIQUE     — evidence shows the value belongs to >1 distinct
 *                            listing_id (caller must supply that evidence)
 *   INVALID_OTHER          — other categorical rejections (too short with no
 *                            corroborating listing evidence, control chars, etc.)
 */
'use strict';

const PRICE_SHAPE = /^\d+\.\d{1,2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_OR_WHITESPACE = /[\x00-\x1F\x7F]/;

/**
 * Validate whether a proposed eBay SKU value should be accepted as
 * authoritative identity.
 *
 * @param {string|number|null|undefined} value
 * @param {Object} [ctx]
 * @param {boolean} [ctx.canonicalUuidArtifact]  caller asserts this UUID came
 *   from a generated fallback path (ingest wrapper's uuid-fallback), not from
 *   an authoritative seller field. Only then does UUID_SHAPE reject.
 * @param {Set<string>|Array<string>|number|null} [ctx.observedListingIds]
 *   listing_ids on which this value has been observed. If size > 1, the value
 *   is non-unique and cannot be authoritative.
 * @returns {{ ok: boolean, verdict: string, reason?: string }}
 */
function validateEbaySkuAuthority(value, ctx = {}) {
  if (value == null) return _fail('INVALID_BLANK', 'null');
  const raw = String(value);
  if (raw.length === 0) return _fail('INVALID_BLANK', 'empty');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return _fail('INVALID_BLANK', 'whitespace only');
  if (CONTROL_OR_WHITESPACE.test(trimmed)) return _fail('INVALID_OTHER', 'control/whitespace character');

  if (PRICE_SHAPE.test(trimmed)) return _fail('INVALID_PRICE_SHAPED', `price-shaped '${trimmed}'`);
  if (UUID_SHAPE.test(trimmed) && ctx.canonicalUuidArtifact === true) {
    return _fail('INVALID_UUID_ARTIFACT', `generated UUID fallback '${trimmed}'`);
  }

  const observed = _sizeOfObserved(ctx.observedListingIds);
  if (observed > 1) return _fail('INVALID_NON_UNIQUE', `observed on ${observed} distinct listing_ids`);

  return { ok: true, verdict: 'VALID_AUTHORITY' };
}

/**
 * Small helpers — exported for reuse by drift monitor + tests.
 */
function isPriceShapedEbaySku(value) { return typeof value === 'string' && PRICE_SHAPE.test(value.trim()); }
function isUuidShapedEbaySku(value) { return typeof value === 'string' && UUID_SHAPE.test(value.trim()); }

function _fail(verdict, reason) { return { ok: false, verdict, reason }; }
function _sizeOfObserved(o) {
  if (o == null) return 0;
  if (typeof o === 'number') return o;
  if (o instanceof Set) return o.size;
  if (Array.isArray(o)) return new Set(o.map(String)).size;
  return 0;
}

module.exports = {
  validateEbaySkuAuthority,
  isPriceShapedEbaySku,
  isUuidShapedEbaySku,
  //   Regex exposed for advanced callers / diagnostic scripts
  _PRICE_SHAPE: PRICE_SHAPE,
  _UUID_SHAPE: UUID_SHAPE,
};
