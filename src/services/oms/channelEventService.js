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
 * @param {Object} params
 * @param {string}  params.channel
 * @param {string|null} [params.externalOrderId]
 * @param {string|null} [params.sourceEventId]
 * @param {string}  params.eventType
 * @param {string|null} [params.rawStatus]
 * @param {any}     params.rawPayload
 * @returns {Promise<{ id:number, isNew:boolean, payloadHash:string }>}
 */
async function persistRawEvent({
  channel,
  externalOrderId = null,
  sourceEventId = null,
  eventType,
  rawStatus = null,
  rawPayload,
}) {
  if (!channel) throw new Error('channelEventService.persistRawEvent: channel required');
  if (!eventType) throw new Error('channelEventService.persistRawEvent: eventType required');
  if (rawPayload == null) throw new Error('channelEventService.persistRawEvent: rawPayload required');

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

  const { data, error } = await db.from('channel_order_events').insert(row).select().single();
  if (!error) {
    return { id: data.id, isNew: true, payloadHash: hash };
  }

  // Duplicate — look up existing row via the same key rule as the UNIQUE indexes
  const isUnique = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
  if (!isUnique) throw error;

  const lookup = db.from('channel_order_events').select('id').eq('channel', channel);
  const existingQ = sourceEventId
    ? lookup.eq('source_event_id', sourceEventId).is('source_event_id', undefined) === undefined
      ? lookup.eq('source_event_id', sourceEventId)
      : lookup
    : lookup.eq('payload_hash', hash).is('source_event_id', null);

  const { data: existing, error: e2 } = await existingQ.maybeSingle();
  if (e2) throw e2;
  if (!existing) throw error;                              // truly unexpected
  return { id: existing.id, isNew: false, payloadHash: hash };
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
