/**
 * src/services/oms/shopifyOrderNumber.js — Shopify order-number normalization for
 * canonical ↔ legacy reconciliation.
 *
 * Owner Step 5 §2 · §7:
 *   Legacy `public.orders.order_no` is written by `src/services/orderSync.js:391`
 *   as `${order.order_number || order.id}-${item.id}`. Concrete examples from
 *   production:
 *     '3051-16209818550437', '3051-16209818583205'
 *
 *   Canonical `oms_orders.external_order_number` is written by
 *   `src/services/oms/adapters/shopifyOrderAdapter.js` from `raw.name`
 *   (Shopify's human-facing order label — store-customisable). Examples:
 *     'CC3051', '#1001', or NULL.
 *
 *   So `CC3051` (canonical) and `3051-<line>` (legacy) refer to the same order
 *   only after `CC` (or any leading non-digit prefix) is stripped from canonical
 *   and the `-<line>` suffix is stripped from legacy.
 *
 *   Fallback: when canonical `external_order_number` is NULL (adapter couldn't
 *   read raw.name / raw.order_number), the legacy row uses `order.id` instead of
 *   `order.order_number`. In that case canonical `external_order_id` (raw.id · a
 *   long numeric string) is the correct identity to compare — legacy will show
 *   `<raw.id>-<line>`.
 *
 * This file contains ONLY pure functions. No I/O.
 */
'use strict';

/**
 * Extract the first contiguous digit group from a Shopify order label.
 * Returns null if no digit group is present.
 *
 *   'CC3051'          → '3051'
 *   '#1001'           → '1001'
 *   '3051'            → '3051'
 *   'SHOP-2028-A'     → '2028'          (first digit group)
 *   '6848032768165'   → '6848032768165'
 *   null / '' / 'AB'  → null
 *
 * The rule is deliberately narrow: strip leading non-digits, then capture the
 * next contiguous digit run. It intentionally does NOT try to be clever about
 * multi-segment labels — those would be a schema drift that requires investigation.
 *
 * @param {string|null|undefined} s
 * @returns {string|null}
 */
function extractLeadingNumeric(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Given a canonical row (external_order_number and external_order_id), return the
 * legacy order-identity string that legacy `order_no` prefixes should equal.
 *
 * Priority:
 *   1. external_order_number → strip non-digit prefix → digits
 *   2. else external_order_id (used when adapter couldn't populate name)
 *
 * Returns null when neither yields a usable identity — the caller should surface
 * this canonical row as `canonical_only + reason='missing_legacy_join_key'`
 * rather than falling back to fuzzy matching.
 *
 * @param {{external_order_number?: string|null, external_order_id?: string|null}} canonicalRow
 * @returns {string|null}
 */
function normalizeShopifyOrderNumberForLegacy(canonicalRow) {
  if (!canonicalRow) return null;
  const fromName = extractLeadingNumeric(canonicalRow.external_order_number);
  if (fromName) return fromName;
  const fromId = canonicalRow.external_order_id != null
    ? String(canonicalRow.external_order_id).trim()
    : null;
  if (fromId && /^\d+$/.test(fromId)) return fromId;
  return null;
}

/**
 * Extract the order-identity portion of a legacy `orders.order_no`. Legacy stores
 * `<order_identity>-<line_id>` (per orderSync.js:391). Returns the substring
 * before the first '-' — no LIKE/contains ambiguity.
 *
 *   '3051-16209818550437'   → '3051'
 *   '6848032768165-9999'    → '6848032768165'
 *   '3051'                  → '3051'                (no dash — order-only)
 *   ''                      → null
 *
 * @param {string|null|undefined} orderNo
 * @returns {string|null}
 */
function extractLegacyOrderIdentity(orderNo) {
  if (orderNo == null) return null;
  const s = String(orderNo).trim();
  if (!s) return null;
  const dash = s.indexOf('-');
  return dash > 0 ? s.slice(0, dash) : s;
}

module.exports = {
  extractLeadingNumeric,
  normalizeShopifyOrderNumberForLegacy,
  extractLegacyOrderIdentity,
};
