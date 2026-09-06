'use strict';

/**
 * src/services/oms/ebayShipmentEvidence.js — OMS-SHIP-EVIDENCE-E1 (2026-09-06).
 *
 * Neutral eBay shipment-evidence helper.
 *
 * Owner-approved contract:
 *   · Canonical evidence payload from ONE eBay Completed-scope observation
 *   · Deterministic hash for idempotent re-observation
 *     — SAME external fact → SAME payload_hash (invariant §8)
 *     — runtime/fetched_at MUST NOT enter the hash (§7, §8, §16)
 *   · Persist into existing `channel_order_events` (mig 080) · zero migration
 *   · OMS identity resolution: EXACT (channel, external_order_id) match only
 *     — no fuzzy fallback (§12)
 *
 * Explicit non-scope:
 *   · No OMS lifecycle mutation (E1 defers to E2 projector)
 *   · No legacy `orders` write (existing observer path owns that)
 *   · No new migration · no new scheduler · no new fetcher
 *   · Not a god-service: this helper does canonical/hash/resolve/persist ·
 *     the observer orchestrates
 */

const crypto = require('crypto');

const EVENT_TYPE   = 'shipment_evidence';
const OBSERVED_VIA = 'ebay_getorders_completed_scope';

/**
 * Build the canonical evidence object for one order observation.
 *
 * Minimal · stable · PII-free. No buyer, address, phone, email, listing details.
 *
 * @param {object} input
 * @param {string} input.orderId               raw eBay <OrderID>
 * @param {string|null} input.rawOrderStatus   raw eBay <OrderStatus> (e.g. 'Completed')
 * @param {string|null} input.shippedTimeRaw   raw eBay <ShippedTime> string · null when absent
 * @param {string|null} input.paidTimeRaw      raw eBay <PaidTime> string · null when absent
 * @param {string|null} input.cancelStatusRaw  raw eBay <CancelStatus> · null when absent
 * @param {Array<{number:string, carrier:string}>} input.trackings  observed tracking entries
 * @returns {object} canonical evidence · shape stable across runs
 */
function buildEvidenceCanonical({
  orderId, rawOrderStatus, shippedTimeRaw, paidTimeRaw, cancelStatusRaw, trackings,
}) {
  //   Trackings: text-only · trim · reject empty · deduplicate by number · sort
  //   deterministically so hash is stable regardless of XML block ordering (§9).
  const sortedTrackings = _canonicalizeTrackings(trackings);

  //   Owner rule §6/§21: absent evidence stays null · never invented.
  return {
    order_id:          String(orderId || ''),
    raw_order_status:  _nullIfEmpty(rawOrderStatus),
    shipped_time_raw:  _nullIfEmpty(shippedTimeRaw),
    paid_time_raw:     _nullIfEmpty(paidTimeRaw),
    cancel_status_raw: _nullIfEmpty(cancelStatusRaw),
    trackings:         sortedTrackings,
    observed_via:      OBSERVED_VIA,
  };
}

/**
 * Deterministic sha256 hex hash of canonical evidence.
 *
 * CRITICAL INVARIANT (§7, §8): the hash MUST NOT include fetched_at, runtime
 * timestamps, scheduler run id, lease id, or any value that varies between
 * observations of the same external fact.
 *
 * Keys assembled in a fixed order below · JSON.stringify preserves insertion
 * order in V8/Node · array elements are pre-sorted in buildEvidenceCanonical.
 *
 * @param {object} canonical from buildEvidenceCanonical
 * @returns {string} 64-char hex sha256
 */
function hashEvidence(canonical) {
  const ordered = {
    order_id:          canonical.order_id,
    raw_order_status:  canonical.raw_order_status,
    shipped_time_raw:  canonical.shipped_time_raw,
    paid_time_raw:     canonical.paid_time_raw,
    cancel_status_raw: canonical.cancel_status_raw,
    trackings:         (canonical.trackings || []).map(t => ({
      number: t.number, carrier: t.carrier,
    })),
    observed_via:      canonical.observed_via,
  };
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Resolve OMS `linked_order_id` for an eBay OrderID.
 *
 * EXACT match only (owner rule §12): channel='ebay' AND external_order_id=<id>.
 * No fuzzy fallback to buyer / SKU / tracking / address / date.
 *
 * Given `uq_oms_orders_channel_external UNIQUE (channel, external_order_id)`
 * (mig 078:106), a healthy DB should return 0 or 1 rows. Two or more rows
 * indicate a schema-invariant violation and MUST be reported as ambiguous —
 * do not arbitrarily pick.
 *
 * @param {object} db      Supabase client
 * @param {string} externalOrderId
 * @returns {Promise<{linkedOrderId: number|null, ambiguous: boolean}>}
 */
async function resolveOmsLinkedOrderId(db, externalOrderId) {
  const { data, error } = await db
    .from('oms_orders')
    .select('id')
    .eq('channel', 'ebay')
    .eq('external_order_id', externalOrderId);
  if (error) throw new Error(`resolveOmsLinkedOrderId ${externalOrderId}: ${error.message}`);
  const rows = data || [];
  if (rows.length === 0) return { linkedOrderId: null, ambiguous: false };
  if (rows.length === 1) return { linkedOrderId: rows[0].id, ambiguous: false };
  return { linkedOrderId: null, ambiguous: true };
}

/**
 * Persist one evidence row into channel_order_events.
 *
 * INSERT ... ON CONFLICT DO NOTHING semantics against the existing
 * `uq_channel_order_events_channel_hash` partial UNIQUE (mig 080:87-88 ·
 * `(channel, payload_hash) WHERE source_event_id IS NULL`).
 *
 * We use raw INSERT + PG error code 23505 catch instead of PostgREST upsert
 * because the target uniqueness is a partial index; direct upsert on partial
 * indexes is fragile across PostgREST versions.
 *
 * Preserves the FIRST durable evidence row (§11): duplicates do NOT touch
 * fetched_at or any column of the existing row.
 *
 * @param {object} db
 * @param {object} p
 * @param {object} p.canonical         canonical evidence · goes to raw_payload
 * @param {string} p.hash              deterministic sha256 hex · goes to payload_hash
 * @param {string} p.externalOrderId
 * @param {string|null} p.rawStatus    goes to raw_status
 * @param {string} p.importedAt        ISO · goes to fetched_at (NOT in hash)
 * @param {number|null} p.linkedOrderId
 * @returns {Promise<{inserted: boolean, duplicate: boolean}>}
 */
async function persistEvidence(db, {
  canonical, hash, externalOrderId, rawStatus, importedAt, linkedOrderId,
}) {
  const payloadStr = JSON.stringify(canonical);
  const row = {
    channel:            'ebay',
    external_order_id:  externalOrderId,
    source_event_id:    null,
    event_type:         EVENT_TYPE,
    payload_hash:       hash,
    raw_status:         rawStatus == null ? null : String(rawStatus),
    raw_payload:        canonical,
    payload_size_bytes: Buffer.byteLength(payloadStr, 'utf8'),
    fetched_at:         importedAt,
    processed_at:       null,
    processing_status:  'pending',
    error_message:      null,
    linked_order_id:    linkedOrderId,
  };
  const { data, error } = await db
    .from('channel_order_events')
    .insert(row)
    .select('id');
  if (error) {
    //   PostgreSQL unique_violation · benign for our idempotency contract.
    if (error.code === '23505') return { inserted: false, duplicate: true };
    throw new Error(`persistEvidence ${externalOrderId}: ${error.message}`);
  }
  const inserted = Array.isArray(data) && data.length > 0;
  return { inserted, duplicate: !inserted };
}

/* ─────────────────────────────── internals ─────────────────────────────── */

function _nullIfEmpty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function _canonicalizeTrackings(trackings) {
  //   Owner rule §5: TEXT only · trim · reject empty · never uppercase.
  //   Deduplicate by tracking number (retain first-seen carrier for that number).
  //   Sort by [number, carrier] so same evidence yields same hash regardless of
  //   input ordering (§9). This mirrors classifyOrderObservations dedup but
  //   ADDITIONALLY sorts (existing classifier used Map insertion order).
  if (!Array.isArray(trackings)) return [];
  const dedup = new Map();
  for (const t of trackings) {
    if (t == null) continue;
    const number  = String(t.number || '').trim();
    const carrier = String(t.carrier || '').trim();
    if (number === '') continue;
    if (!dedup.has(number)) dedup.set(number, { number, carrier });
  }
  return Array.from(dedup.values()).sort((a, b) => {
    if (a.number !== b.number) return a.number < b.number ? -1 : 1;
    if (a.carrier !== b.carrier) return a.carrier < b.carrier ? -1 : 1;
    return 0;
  });
}

module.exports = {
  EVENT_TYPE,
  OBSERVED_VIA,
  buildEvidenceCanonical,
  hashEvidence,
  resolveOmsLinkedOrderId,
  persistEvidence,
  //   Exposed for tests only. Do not import from other callers.
  _internals: { _nullIfEmpty, _canonicalizeTrackings },
};
