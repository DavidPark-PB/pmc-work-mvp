'use strict';

/**
 * src/services/oms/judgmentHistoryRepository.js — Phase 8O.
 *
 * Append-only persistence adapter for judgment snapshots.
 *
 * SAFETY:
 *   • append-only semantics · never UPDATE · never DELETE
 *   • fingerprint idempotency (physical_product_id, sha256(payload))
 *   • deterministic JSON serialization for the fingerprint (keys sorted)
 *   • payload byte-size cap (default 32 KB) · rejects larger writes
 *   • rejects malformed / identity-less snapshots
 *   • never writes / reads secrets or tokens
 *   • production DB write requires migration 094 applied (Owner-gated)
 *
 * ALL DB access flows through a caller-supplied `db` argument so tests
 * inject a stub. The default `getClient()` is used only when Owner has
 * approved production apply of migration 094.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 'v8o.1';
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024;   // 32 KB
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

/**
 * Compute the deterministic fingerprint of a snapshot.
 *
 * Uses recursively-sorted JSON. Two snapshots with identical structural
 * content produce identical fingerprints regardless of key order.
 */
function fingerprintSnapshot(snapshot) {
  const canonical = _deterministicStringify(_forFingerprint(snapshot));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Assemble the row that will be INSERTed. Pure · no DB access.
 * Rejects invalid inputs by throwing before any write is attempted.
 */
function toDbRow(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('judgmentHistoryRepository.toDbRow: snapshot object required');
  }
  const physicalId = Number.isInteger(snapshot.physical_product_id) && snapshot.physical_product_id > 0
    ? snapshot.physical_product_id : null;
  if (physicalId == null) {
    throw new Error('judgmentHistoryRepository.toDbRow: snapshot.physical_product_id must be a positive integer (identity required · Phase 8O §2)');
  }
  const identityKey = String(opts.product_identity_key || snapshot.product_identity_key || '').trim();
  if (!identityKey) {
    throw new Error('judgmentHistoryRepository.toDbRow: product_identity_key required (durable anchor · never persist an identity-less snapshot)');
  }
  const snapshotAt = _iso(snapshot.snapshot_at);
  if (!snapshotAt) {
    throw new Error('judgmentHistoryRepository.toDbRow: snapshot.snapshot_at must be a valid ISO timestamp');
  }
  const writtenBy = opts.written_by ? String(opts.written_by).slice(0, 100) : null;
  if (writtenBy && _looksLikeSecret(writtenBy)) {
    throw new Error('judgmentHistoryRepository.toDbRow: written_by must NOT contain a token / secret');
  }

  const fp = fingerprintSnapshot(snapshot);
  const payload = JSON.stringify(_stripEphemeral(snapshot));
  const bytes = Buffer.byteLength(payload, 'utf8');
  const maxBytes = Number.isFinite(opts.max_payload_bytes) ? opts.max_payload_bytes : DEFAULT_MAX_PAYLOAD_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`judgmentHistoryRepository.toDbRow: payload ${bytes}B exceeds cap ${maxBytes}B · refuse write`);
  }

  return {
    physical_product_id: physicalId,
    product_identity_key: identityKey.slice(0, 200),
    snapshot_at: snapshotAt,
    schema_version: SCHEMA_VERSION,
    source_generated_at: _iso(snapshot.source_generated_at),
    decision: _strOrNull(snapshot.decision, 50),
    priority: Number.isFinite(snapshot.priority) ? snapshot.priority : null,
    urgency: _strOrNull(snapshot.urgency, 30),
    confidence_level: _strOrNull(snapshot.confidence?.confidence_level, 20),
    confidence_overall_tier: _strOrNull(snapshot.confidence?.overall_tier, 20),
    confidence_by_dimension: snapshot.confidence || {},
    key_reasons: snapshot.key_reasons || {},
    cost_context_snapshot: snapshot.cost_context_snapshot || {},
    financial_metrics_summary: snapshot.financial_metrics_summary || {},
    provenance_summary: snapshot.provenance_summary || {},
    fingerprint: fp,
    written_by: writtenBy,
    payload_bytes: bytes,
  };
}

/**
 * Append a snapshot to judgment_snapshots. Uses caller-supplied db so
 * tests can inject a stub. Returns { status, row, reason? }.
 *   status='INSERTED'   — row was written
 *   status='DUPLICATE'  — fingerprint collision (idempotent · noop)
 *   status='REJECTED'   — invariant violation · reason surfaced
 */
async function appendSnapshot({ snapshot, db, opts = {} }) {
  if (!db || typeof db.from !== 'function') {
    throw new Error('appendSnapshot: db (Supabase-like client) required · never uses production client by default');
  }
  let row;
  try {
    row = toDbRow(snapshot, opts);
  } catch (err) {
    return { status: 'REJECTED', reason: err.message, row: null };
  }

  const res = await db.from('judgment_snapshots').insert(row).select();
  if (res && res.error) {
    // Fingerprint-uniqueness conflict → treat as idempotent duplicate
    const msg = String(res.error.message || res.error.code || '');
    if (/uq_judgment_snapshots_physical_fingerprint|duplicate|unique/i.test(msg)) {
      return { status: 'DUPLICATE', reason: 'fingerprint_conflict', row };
    }
    return { status: 'REJECTED', reason: msg || 'insert_failed', row: null };
  }
  return { status: 'INSERTED', row: (res && res.data && res.data[0]) || row };
}

/**
 * List snapshots for a physical, newest first, paginated.
 * Never returns malformed rows · never mutates DB.
 */
async function listSnapshots({ physicalProductId, db, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('listSnapshots: physicalProductId must be a positive integer');
  }
  const cappedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const capOffset = Math.max(0, Number(offset) || 0);
  if (!db || typeof db.from !== 'function') {
    throw new Error('listSnapshots: db (Supabase-like client) required');
  }
  const res = await db.from('judgment_snapshots')
    .select('id, physical_product_id, product_identity_key, snapshot_at, created_at, schema_version, source_generated_at, decision, priority, urgency, confidence_level, confidence_overall_tier, confidence_by_dimension, key_reasons, cost_context_snapshot, financial_metrics_summary, provenance_summary, fingerprint, written_by, payload_bytes')
    .eq('physical_product_id', physicalProductId)
    .order('snapshot_at', { ascending: false })
    .order('id', { ascending: false })
    .range(capOffset, capOffset + cappedLimit - 1);
  if (res && res.error) throw new Error(res.error.message || 'listSnapshots_failed');
  return {
    physical_product_id: physicalProductId,
    limit: cappedLimit,
    offset: capOffset,
    items: (res && res.data) || [],
  };
}

// ─── helpers ────────────────────────────────────────────

function _iso(v) {
  if (v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
function _strOrNull(v, max) {
  if (v == null) return null;
  return String(v).slice(0, max);
}
function _forFingerprint(snapshot) {
  // The fingerprint intentionally EXCLUDES snapshot_at so two identical
  // observations at different times still detect the invariant that the
  // payload didn't change (idempotency at the payload level). snapshot_at
  // is the write-order signal, not the state signal.
  return _stripEphemeral(snapshot);
}
function _stripEphemeral(snapshot) {
  const out = { ...snapshot };
  delete out.snapshot_at;
  return out;
}
function _deterministicStringify(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_deterministicStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _deterministicStringify(v[k])).join(',') + '}';
}
function _looksLikeSecret(s) {
  //   Guard against accidentally storing tokens/keys in written_by.
  const t = String(s).trim();
  if (t.length > 40 && /^[A-Za-z0-9._\-]+$/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t)) return true;   // JWT-ish
  if (/^sk[_-]/i.test(t)) return true;                                                                     // sk_ prefixes
  if (/^eyJ[a-zA-Z0-9_-]{20,}/.test(t)) return true;                                                       // JWT
  return false;
}

module.exports = {
  fingerprintSnapshot,
  toDbRow,
  appendSnapshot,
  listSnapshots,
  SCHEMA_VERSION,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
};
