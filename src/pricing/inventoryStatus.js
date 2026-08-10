'use strict';

/**
 * inventoryStatus.js — Phase 1 Commit 8
 * ---------------------------------------------------------------------------
 * Central helper that turns a raw ebay_api_stock value into an explicit
 * inventory status. Callers who ask "is this SKU in stock?" MUST use this
 * — never `raw ?? something ?? 0`.
 *
 * Owner directive (2026-08-10):
 *   UNKNOWN != ZERO. A missing / null / non-integer value means "we don't
 *   know", not "there are zero units left". Treating UNKNOWN as ZERO is what
 *   caused Hermes overstock / slow_mover signals to fire on SKUs that had
 *   simply never been synced.
 *
 * Status vocabulary:
 *   UNKNOWN        — null / undefined / column missing / non-numeric / non-integer
 *   INVALID        — a value that looks numeric but is out of bounds (< 0)
 *   OUT_OF_STOCK   — value is exactly 0 (confirmed by eBay)
 *   KNOWN_STOCK    — value is a positive integer
 */

const STATUS = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  INVALID: 'INVALID',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  KNOWN_STOCK: 'KNOWN_STOCK',
});

/**
 * Classify a single raw quantity value.
 * @param {*} raw
 * @returns {{ status: string, quantity: number | null }}
 */
function classifyQuantity(raw) {
  if (raw === null || raw === undefined) return { status: STATUS.UNKNOWN, quantity: null };
  if (typeof raw === 'boolean') return { status: STATUS.INVALID, quantity: null };
  // Guard against Number('') === 0 and Number('  ') === 0 silently
  // upgrading a missing value to a confirmed sold-out.
  if (typeof raw === 'string' && raw.trim() === '') return { status: STATUS.UNKNOWN, quantity: null };
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { status: STATUS.UNKNOWN, quantity: null };
  if (!Number.isInteger(n)) return { status: STATUS.INVALID, quantity: null };
  if (n < 0) return { status: STATUS.INVALID, quantity: null };
  if (n === 0) return { status: STATUS.OUT_OF_STOCK, quantity: 0 };
  return { status: STATUS.KNOWN_STOCK, quantity: n };
}

/**
 * Read the marketplace-observed quantity from an ebay_products row.
 * Never falls back to `row.stock` — that field is the local editable
 * representation and mixing the two is what produced the historical
 * corruption.
 *
 * @param {object} row  ebay_products row (or subset)
 */
function fromEbayProductsRow(row) {
  if (!row || typeof row !== 'object') return { status: STATUS.UNKNOWN, quantity: null };
  return classifyQuantity(row.ebay_api_stock);
}

/**
 * True only when we are certain the SKU can be sold right now.
 * UNKNOWN, INVALID, OUT_OF_STOCK all return false — fail-closed.
 */
function isSellable(row) {
  return fromEbayProductsRow(row).status === STATUS.KNOWN_STOCK;
}

/**
 * True only when we are certain the SKU is currently sold out.
 * UNKNOWN returns false — do NOT confuse "we don't know" with "sold out".
 */
function isConfirmedOutOfStock(row) {
  return fromEbayProductsRow(row).status === STATUS.OUT_OF_STOCK;
}

/**
 * True when the value is either UNKNOWN or INVALID.
 * Signals that need a confirmed integer quantity (overstock, slow_mover)
 * should short-circuit when this returns true instead of silently
 * substituting 0.
 */
function isKnown(row) {
  const s = fromEbayProductsRow(row).status;
  return s === STATUS.KNOWN_STOCK || s === STATUS.OUT_OF_STOCK;
}

/**
 * Normalise a value coming FROM eBay's Trading API for INSERT/UPDATE into
 * ebay_products.ebay_api_stock. Returns null (write NULL) when the API did
 * not give us a valid integer. Combined with migration 076 (DROP DEFAULT)
 * this means UNKNOWN is preserved as NULL end-to-end.
 *
 * @param {*} raw  the `item.quantity` field returned by eBay
 * @returns {number | null}  int to write, or null to write NULL
 */
function toDbValue(raw) {
  const c = classifyQuantity(raw);
  if (c.status === STATUS.KNOWN_STOCK || c.status === STATUS.OUT_OF_STOCK) {
    return c.quantity;
  }
  return null;
}

module.exports = {
  STATUS,
  classifyQuantity,
  fromEbayProductsRow,
  isSellable,
  isConfirmedOutOfStock,
  isKnown,
  toDbValue,
};
