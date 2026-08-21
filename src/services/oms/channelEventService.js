/**
 * src/services/oms/channelEventService.js — channel_order_events read/write helper.
 *
 * Owner directive §12: raw ingestion journal 흐름
 *   raw API response
 *   → raw event persist
 *   → normalize
 *   → canonical persist
 *   → raw event mark processed
 *
 *   Normalization 실패 시 raw event 는 남아 있어야 한다.
 *
 * Idempotency (080 migration):
 *   - source_event_id 있으면 (channel, source_event_id) UNIQUE
 *   - 없으면 (channel, payload_hash) UNIQUE
 *   Insert 시 conflict 나면 기존 row 조회해서 반환 (upsert).
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { payloadHash } = require('./lineId');

/**
 * Persist a raw channel event. Idempotent per Owner §1 rules.
 *
 * Phase 8P-20.8A · duplicate-path lookup also returns processing_status +
 * linked_order_id so per-channel ingestors can decide whether to short-circuit
 * (already-processed, unchanged event) or retry (pending / failed / linked-null).
 *
 * Phase 8P-20.8B · optional `stageObserver` observability. When present, the
 * observer is invoked at DB boundaries (INSERT · DUPLICATE_LOOKUP) so callers
 * can measure/log exactly where wall-clock is spent. The service itself remains
 * format-agnostic — it never emits OMS_EBAY_* lines. Observer errors are
 * swallowed so a broken observer cannot corrupt ingestion.
 *
 * Observer contract:
 *   stageObserver(stageName, phase, meta)
 *     stageName ∈ { 'channel_event_insert', 'channel_event_duplicate_lookup' }
 *     phase     ∈ { 'start', 'done', 'fail' }
 *     meta      · phase='start': {}
 *               · phase='done' : { elapsedMs, isNew? }
 *               · phase='fail' : { elapsedMs, errorClass, message }
 *
 * Phase 8P-20.8C · optional `existingEventHint` (VERIFIED prefetch result).
 * When present AND the hint validates against the current identity rule for
 * this call (sourceEventId or payload_hash), persistRawEvent SKIPS the INSERT
 * and duplicate SELECT round-trips and returns immediately with source:'prefetch'.
 * If the hint doesn't verify (stale, wrong identity, drifted payload), the
 * call FALLS OPEN to the standard INSERT+fallback-SELECT path — the optimization
 * cannot cause a lost event, a duplicate row, or a bypass of DB uniqueness.
 *
 * @param {Object} params
 * @param {string}  params.channel
 * @param {string|null} [params.externalOrderId]
 * @param {string|null} [params.sourceEventId]
 * @param {string}  params.eventType
 * @param {string|null} [params.rawStatus]
 * @param {any}     params.rawPayload
 * @param {Function} [params.stageObserver]        optional; see contract above
 * @param {Object|null} [params.existingEventHint] optional prefetched row (see prefetchExistingEvents)
 *        Shape: { id, source_event_id, payload_hash, processing_status, linked_order_id }
 * @returns {Promise<{ id:number, isNew:boolean, payloadHash:string, processingStatus:string, linkedOrderId:number|null, source?:'prefetch' }>}
 */
async function persistRawEvent({
  channel,
  externalOrderId = null,
  sourceEventId = null,
  eventType,
  rawStatus = null,
  rawPayload,
  stageObserver,
  existingEventHint,
}) {
  if (!channel) throw new Error('channelEventService.persistRawEvent: channel required');
  if (!eventType) throw new Error('channelEventService.persistRawEvent: eventType required');
  if (rawPayload == null) throw new Error('channelEventService.persistRawEvent: rawPayload required');

  //   Phase 8P-20.8B · safe observer wrapper. Never throws.
  const emit = (stageName, phase, meta) => {
    if (typeof stageObserver !== 'function') return;
    try { stageObserver(stageName, phase, meta || {}); } catch (_e) { /* observer errors must not break ingestion */ }
  };

  const hash = payloadHash(rawPayload);

  //   Phase 8P-20.8C · verified prefetch hit path (fails OPEN on any doubt).
  //   Verification MUST reproduce the exact identity precedence used by the two
  //   partial UNIQUE indexes in migration 080:
  //     sourceEventId != null  →  (channel, source_event_id)     [payload may drift]
  //     sourceEventId == null  →  (channel, payload_hash)         [source_event_id IS NULL row]
  //   IMPORTANT · we do NOT emit the channel_event_insert observer event here.
  //   No DB round-trip occurred, so counting this as an event_insert_duplicate
  //   would corrupt the 8P-20.8B DB-boundary metrics. Callers distinguish the
  //   two paths via the `source: 'prefetch'` return field.
  if (_isVerifiedHint(existingEventHint, sourceEventId, hash)) {
    return {
      id: existingEventHint.id,
      isNew: false,
      payloadHash: hash,
      processingStatus: existingEventHint.processing_status,
      linkedOrderId: existingEventHint.linked_order_id,
      source: 'prefetch',
    };
  }

  const size = Buffer.byteLength(JSON.stringify(rawPayload), 'utf8');
  const db = getClient();

  const row = {
    channel,
    external_order_id: externalOrderId,
    source_event_id: sourceEventId,
    event_type: eventType,
    payload_hash: hash,
    raw_status: rawStatus,
    raw_payload: rawPayload,
    payload_size_bytes: size,
    processing_status: 'pending',
  };

  //   Boundary 1 · INSERT (may either succeed or 23505-UNIQUE-violate)
  emit('channel_event_insert', 'start');
  const _tInsert = Date.now();
  const { data, error } = await db.from('channel_order_events').insert(row).select().single();
  const insertMs = Date.now() - _tInsert;

  if (!error) {
    //   Phase 8P-20.8A · consistent shape for insert-succeeded path
    emit('channel_event_insert', 'done', { elapsedMs: insertMs, isNew: true });
    return { id: data.id, isNew: true, payloadHash: hash, processingStatus: 'pending', linkedOrderId: null };
  }

  // Duplicate — look up existing row via the same key rule as the UNIQUE indexes
  const isUnique = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
  if (!isUnique) {
    emit('channel_event_insert', 'fail', {
      elapsedMs: insertMs,
      errorClass: _classifyDbError(error),
      message: _safeErrMsg(error),
    });
    throw error;
  }
  //   UNIQUE-violation is a *successful outcome* of the insert boundary (idempotent semantics),
  //   just with isNew=false. Timing still counts toward insert wall-clock.
  emit('channel_event_insert', 'done', { elapsedMs: insertMs, isNew: false });

  //   Phase 8P-20.8A · include processing_status + linked_order_id so the
  //   caller can short-circuit already-processed unchanged events.
  //   Boundary 2 · DUPLICATE_LOOKUP (only fires on isNew=false)
  emit('channel_event_duplicate_lookup', 'start');
  const _tDup = Date.now();
  const lookup = db.from('channel_order_events')
    .select('id, processing_status, linked_order_id')
    .eq('channel', channel);
  const existingQ = sourceEventId
    ? lookup.eq('source_event_id', sourceEventId).is('source_event_id', undefined) === undefined
      ? lookup.eq('source_event_id', sourceEventId)
      : lookup
    : lookup.eq('payload_hash', hash).is('source_event_id', null);

  const { data: existing, error: e2 } = await existingQ.maybeSingle();
  const dupMs = Date.now() - _tDup;
  if (e2) {
    emit('channel_event_duplicate_lookup', 'fail', {
      elapsedMs: dupMs,
      errorClass: _classifyDbError(e2),
      message: _safeErrMsg(e2),
    });
    throw e2;
  }
  if (!existing) {
    emit('channel_event_duplicate_lookup', 'fail', {
      elapsedMs: dupMs,
      errorClass: 'not_found',
      message: 'unique_violation_but_no_row',
    });
    throw error;                              // truly unexpected
  }
  emit('channel_event_duplicate_lookup', 'done', { elapsedMs: dupMs });
  return {
    id: existing.id,
    isNew: false,
    payloadHash: hash,
    processingStatus: existing.processing_status,
    linkedOrderId: existing.linked_order_id,
  };
}

//   Phase 8P-20.8C · Verify a prefetched hint against the SAME identity rule
//   the DB uses at INSERT time. If it doesn't match perfectly, return false and
//   the caller falls through to the authoritative INSERT+SELECT path.
function _isVerifiedHint(hint, sourceEventId, computedHash) {
  if (!hint || typeof hint !== 'object') return false;
  if (hint.id == null) return false;
  //   Case A: source_event_id-keyed identity
  if (sourceEventId != null) {
    return hint.source_event_id != null && String(hint.source_event_id) === String(sourceEventId);
  }
  //   Case B: payload_hash-keyed identity (source_event_id must be NULL on both sides)
  return hint.source_event_id == null
    && hint.payload_hash != null
    && String(hint.payload_hash) === String(computedHash);
}

//   Phase 8P-20.8D · Public identity-verification helper. Same rule as the
//   internal _isVerifiedHint used inside persistRawEvent — exported so callers
//   (channel ingestors that pre-hash their candidates) can predict whether a
//   prefetched hint will produce a prefetch-hit BEFORE calling persistRawEvent,
//   without duplicating the identity rule (single source of truth · no drift).
function verifyEventHint({ hint, sourceEventId = null, payloadHash: computedHash } = {}) {
  return _isVerifiedHint(hint, sourceEventId, computedHash);
}

/**
 * Phase 8P-20.8C · Bulk-prefetch existing channel_order_events by identity.
 *
 * Purpose: replace N sequential per-order INSERT+23505+SELECT round-trips with
 * a small number of bounded IN(...) SELECTs so callers can decide up-front
 * which candidates already exist and can be short-circuited without touching
 * the DB per-row.
 *
 * Identity precedence exactly mirrors persistRawEvent + the migration-080
 * partial UNIQUE indexes:
 *   sourceEventId != null  →  match (channel, source_event_id)
 *   sourceEventId == null  →  match (channel, source_event_id IS NULL, payload_hash)
 *
 * Guarantees:
 *   • Never SELECTs raw_payload (only id, source_event_id, payload_hash,
 *     processing_status, linked_order_id — the fields short-circuit needs).
 *   • Bounded IN(...) chunking (default 100, override via chunkSize).
 *   • Sequential chunks — no unbounded Promise.all over hundreds of DB calls.
 *   • Empty input → zero DB queries.
 *   • DB is still authoritative: a prefetch miss followed by an INSERT race is
 *     handled by the existing 23505 fallback inside persistRawEvent.
 *
 * @param {Object} args
 * @param {string} args.channel
 * @param {Array<{ sourceEventId:string|null, payloadHash:string }>} args.candidates
 * @param {number} [args.chunkSize=100]
 * @returns {Promise<{ resolve:(candidate)=>Object|null, stats:{ queries:number, rowsFound:number, elapsedMs:number } }>}
 */
async function prefetchExistingEvents({ channel, candidates, chunkSize = 100 } = {}) {
  if (!channel) throw new Error('channelEventService.prefetchExistingEvents: channel required');
  const t0 = Date.now();
  const stats = { queries: 0, rowsFound: 0, elapsedMs: 0 };
  if (!Array.isArray(candidates) || candidates.length === 0) {
    stats.elapsedMs = Date.now() - t0;
    return { resolve: () => null, stats };
  }
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? Math.min(chunkSize, 500) : 100;

  //   Deduplicate identities so we don't waste chunk slots on repeated hashes.
  const sourceIds = new Set();
  const hashes = new Set();
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    if (c.sourceEventId != null) sourceIds.add(String(c.sourceEventId));
    else if (c.payloadHash != null) hashes.add(String(c.payloadHash));
  }

  const rowsBySourceId = new Map();
  const rowsByHash = new Map();
  const db = getClient();

  const SELECT_COLS = 'id, source_event_id, payload_hash, processing_status, linked_order_id';

  //   Chunked lookup · source_event_id path
  if (sourceIds.size > 0) {
    for (const chunk of _chunkArray([...sourceIds], size)) {
      stats.queries += 1;
      const { data, error } = await db.from('channel_order_events')
        .select(SELECT_COLS)
        .eq('channel', channel)
        .in('source_event_id', chunk);
      if (error) throw error;
      for (const r of (data || [])) {
        if (r.source_event_id != null) {
          rowsBySourceId.set(String(r.source_event_id), r);
          stats.rowsFound += 1;
        }
      }
    }
  }

  //   Chunked lookup · payload_hash path (restricted to source_event_id IS NULL)
  if (hashes.size > 0) {
    for (const chunk of _chunkArray([...hashes], size)) {
      stats.queries += 1;
      const { data, error } = await db.from('channel_order_events')
        .select(SELECT_COLS)
        .eq('channel', channel)
        .is('source_event_id', null)
        .in('payload_hash', chunk);
      if (error) throw error;
      for (const r of (data || [])) {
        if (r.source_event_id == null && r.payload_hash != null) {
          rowsByHash.set(String(r.payload_hash), r);
          stats.rowsFound += 1;
        }
      }
    }
  }

  stats.elapsedMs = Date.now() - t0;

  const resolve = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.sourceEventId != null) {
      return rowsBySourceId.get(String(candidate.sourceEventId)) || null;
    }
    if (candidate.payloadHash != null) {
      return rowsByHash.get(String(candidate.payloadHash)) || null;
    }
    return null;
  };
  return { resolve, stats };
}

function _chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

//   Phase 8P-20.8B · PII-safe error message + generic DB-error classifier.
//   Keeps observer meta free of raw payload / buyer email / phone / OAuth tokens.
function _safeErrMsg(err) {
  if (!err) return 'unknown';
  const m = String(err.message || err);
  return m
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, '<phone>')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1<token>')
    .slice(0, 200);
}
function _classifyDbError(err) {
  if (!err) return 'unknown';
  if (err.code === '23505') return 'unique_violation';
  const s = String(err.message || err);
  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(s)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(s)) return 'network';
  return 'db';
}

/**
 * Mark an existing event as processed / failed / skipped.
 *
 * @param {number} eventId
 * @param {Object} update
 * @param {'processed'|'failed'|'skipped'} update.processingStatus
 * @param {number|null} [update.linkedOrderId]
 * @param {string|null} [update.errorMessage]
 */
async function markProcessed(eventId, update) {
  if (!eventId) throw new Error('channelEventService.markProcessed: eventId required');
  const patch = {
    processing_status: update.processingStatus,
    processed_at: new Date().toISOString(),
  };
  if (update.linkedOrderId != null) patch.linked_order_id = update.linkedOrderId;
  if (update.errorMessage != null) patch.error_message = String(update.errorMessage).slice(0, 2000);
  const { error } = await getClient()
    .from('channel_order_events')
    .update(patch)
    .eq('id', eventId);
  if (error) throw error;
  return true;
}

/**
 * Fetch pending events for a channel (foreground reprocessing).
 * @param {Object} args
 * @param {string} [args.channel]
 * @param {number} [args.limit=50]
 * @returns {Promise<Array>}
 */
async function listPendingEvents({ channel, limit = 50 } = {}) {
  let q = getClient()
    .from('channel_order_events')
    .select('*')
    .eq('processing_status', 'pending')
    .order('fetched_at', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 500)));
  if (channel) q = q.eq('channel', channel);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

module.exports = {
  persistRawEvent,
  markProcessed,
  listPendingEvents,
  //   Phase 8P-20.8C · bulk existing-event prefetch (generic, non-eBay)
  prefetchExistingEvents,
  //   Re-export the canonical identity helper so callers use a single source of truth
  //   (avoids drift between ebayIngestor and channelEventService hash computation).
  payloadHash,
  //   Phase 8P-20.8D · export identity-verification helper for prospective fast-path detection.
  verifyEventHint,
};
