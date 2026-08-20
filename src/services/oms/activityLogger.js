/**
 * src/services/oms/activityLogger.js — oms_activity_log writer (PII-filtered).
 *
 * Owner directive §11 · §16:
 *   activity_log 에는 buyer email/phone/address/raw payload 를 복제하지 않는다.
 *   sanitizeActivityData() 로 감싸서 저장한다.
 *
 * 최소 지원 actions (§16):
 *   raw_event_received | order_normalized | order_created | order_updated |
 *   order_item_matched | order_item_unmatched | normalization_failed
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const { sanitizeActivityData } = require('./piiFilter');

const ALLOWED_ACTIONS = new Set([
  'raw_event_received',
  'order_normalized',
  'order_created',
  'order_updated',
  'order_item_matched',
  'order_item_unmatched',
  'normalization_failed',
  // extension slot (Step 4+) — status_changed, hold_created, ... allowed via passthrough
]);

const ALLOWED_ACTOR_TYPES = new Set(['user','system','automation','external']);
const ALLOWED_ENTITY_TYPES = new Set([
  'order','order_item','shipment','hold','lost_sale','decision','inventory_movement','channel_event',
]);

/**
 * Write one activity log row. PII in previous/new/metadata is stripped BEFORE persistence.
 *
 * @param {Object} args
 * @param {string} args.action
 * @param {string} args.entityType
 * @param {number} args.entityId
 * @param {number|null} [args.actorId]
 * @param {string} [args.actorType='system']
 * @param {any}    [args.previousData]
 * @param {any}    [args.newData]
 * @param {any}    [args.metadata]
 * @returns {Promise<{id:number}>}
 */
async function logActivity({
  action,
  entityType,
  entityId,
  actorId = null,
  actorType = 'system',
  previousData = null,
  newData = null,
  metadata = null,
}) {
  if (!action || typeof action !== 'string') {
    throw new Error('activityLogger.logActivity: action required');
  }
  if (!ALLOWED_ACTOR_TYPES.has(actorType)) {
    throw new Error(`activityLogger: actorType invalid (${actorType})`);
  }
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`activityLogger: entityType invalid (${entityType})`);
  }
  if (!Number.isInteger(entityId) || entityId <= 0) {
    throw new Error(`activityLogger: entityId must be positive integer, got ${entityId}`);
  }

  // Non-fatal warning for undocumented action (still persisted).
  if (!ALLOWED_ACTIONS.has(action) && process.env.NODE_ENV !== 'production') {
    // Silent in production. Dev logs a hint but does not block.
    // Avoid console.log flood for hot paths.
  }

  const row = {
    actor_id: actorId,
    actor_type: actorType,
    entity_type: entityType,
    entity_id: entityId,
    action,
    previous_data: sanitizeActivityData(previousData),
    new_data: sanitizeActivityData(newData),
    metadata: sanitizeActivityData(metadata),
  };

  const { data, error } = await getClient()
    .from('oms_activity_log')
    .insert(row)
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id };
}

/**
 * Build a shallow diff object safe for activity log (business fields only).
 * Excludes buyer/shipping/rawPayload etc. by definition of what we pass in.
 * @param {Object} before
 * @param {Object} after
 * @param {string[]} fields
 * @returns {{ previous: Object, next: Object } | null}   null if no change
 */
function diffFields(before, after, fields) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const previous = {};
  const next = {};
  let changed = false;
  for (const f of fields) {
    const b = before ? before[f] : undefined;
    const a = after ? after[f] : undefined;
    if (b !== a) {
      previous[f] = b === undefined ? null : b;
      next[f] = a === undefined ? null : a;
      changed = true;
    }
  }
  return changed ? { previous, next } : null;
}

module.exports = {
  logActivity,
  diffFields,
  // for tests
  ALLOWED_ACTIONS,
  ALLOWED_ACTOR_TYPES,
  ALLOWED_ENTITY_TYPES,
};
