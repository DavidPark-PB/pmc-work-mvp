/**
 * src/services/oms/lineId.js — Deterministic external_line_id fallback.
 *
 * Owner directive §7:
 *   external_line_id 가 플랫폼에서 안정적으로 제공되면 그대로 사용.
 *   없으면 deterministic fallback key 를 만든다.
 *   hash 입력에는 가능한 안정적인 필드만 사용.
 *   raw array position 만 단독 key 로 사용하지 않는다.
 *
 * 규약 (설계 문서 §4.3):
 *   external_line_id = 'auto:' + sha256(
 *     externalOrderId + '|' + marketplaceSku + '|' + variantId + '|' +
 *     quantity + '|' + unitPrice + '|' + rowIndex
 *   ).slice(0, 40)
 */
'use strict';

const crypto = require('crypto');

/**
 * @typedef {Object} LineIdInput
 * @property {string}      externalOrderId
 * @property {string|null} marketplaceSku
 * @property {string|null} variantId
 * @property {number}      quantity
 * @property {number|null} unitPrice
 * @property {number}      rowIndex           0-based position — only ONE of several inputs
 */

/**
 * Build a deterministic external_line_id from stable line fields + row index.
 * Row index alone is NEVER used as key.
 *
 * @param {LineIdInput} input
 * @returns {string}   'auto:' + 40-hex-char sha256 prefix
 */
function buildDeterministicLineId(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('buildDeterministicLineId: input required');
  }
  if (!input.externalOrderId) {
    throw new Error('buildDeterministicLineId: externalOrderId required');
  }
  if (input.rowIndex == null || !Number.isFinite(input.rowIndex) || input.rowIndex < 0) {
    throw new Error('buildDeterministicLineId: rowIndex must be non-negative integer');
  }

  const parts = [
    String(input.externalOrderId),
    input.marketplaceSku == null ? '' : String(input.marketplaceSku),
    input.variantId == null ? '' : String(input.variantId),
    String(input.quantity == null ? '' : input.quantity),
    input.unitPrice == null ? '' : String(input.unitPrice),
    String(input.rowIndex),
  ];
  const canonical = parts.join('|');
  const hex = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `auto:${hex.slice(0, 40)}`;
}

/**
 * Resolve external_line_id — use provided value if present, else build deterministic fallback.
 * @param {string|null|undefined} externalLineId  from channel payload
 * @param {LineIdInput} fallbackInput
 * @returns {string}
 */
function resolveExternalLineId(externalLineId, fallbackInput) {
  const trimmed = typeof externalLineId === 'string' ? externalLineId.trim() : '';
  if (trimmed.length > 0) return trimmed;
  return buildDeterministicLineId(fallbackInput);
}

/**
 * Hash a canonical JSON payload for channel_order_events dedup (Owner §1).
 * Object key ordering is canonicalised so equivalent payloads produce identical hashes.
 * @param {any} payload
 * @returns {string}   hex sha256 (64 chars)
 */
function payloadHash(payload) {
  const canonical = canonicalStringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

module.exports = {
  buildDeterministicLineId,
  resolveExternalLineId,
  payloadHash,
};
