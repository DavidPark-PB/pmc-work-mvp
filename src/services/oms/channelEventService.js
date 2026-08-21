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
 * @param {Object} params
 * @param {string}  params.channel
 * @param {string|null} [params.externalOrderId]
 * @param {string|null} [params.sourceEventId]
 * @param {string}  params.eventType
 * @param {string|null} [params.rawStatus]
 * @param {any}     params.rawPayload
 * @param {Function} [params.stageObserver]  optional; see contract above
 * @returns {Promise<{ id:number, isNew:boolean, payloadHash:string, processingStatus:string, linkedOrderId:number|null }>}
 */
async function persistRawEvent({
  channel,
  externalOrderId = null,
  sourceEventId = null,
  eventType,
  rawStatus = null,
  rawPayload,
  stageObserver,
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
};
