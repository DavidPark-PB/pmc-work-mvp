/**
 * src/services/oms/inventoryBaselineService.js — Phase 6D-2.
 *
 * Owner directive:
 *   Legacy stock (products.stock / ebay_products.stock) is NEVER auto-adopted
 *   as physical initial on_hand. Baseline is created only from an explicit
 *   physical count + owner/admin confirmation. Legacy values are captured as
 *   evidence in metadata for historical audit — never as source-of-truth.
 *
 * Contract (movement layer):
 *   movement_type      = 'receipt'
 *   physical_product_id = X
 *   quantity_delta     = countedQuantity (>= 0)
 *   reservation_delta  = 0
 *   idempotency_key    = 'initial_baseline:physical=<id>'  ← exactly one per physical
 *   metadata           = { reason, source, legacy_evidence:{...}, approved:true }
 *
 * NEVER writes to products.stock / ebay_products.stock / marketplace APIs.
 * Duplicate baseline INSERT is blocked by UNIQUE partial index on idempotency_key.
 *
 * Future adjustments to on_hand are made via SEPARATE adjustment movements —
 * baseline row is never UPDATE'd or DELETE'd.
 */
'use strict';

const { getClient } = require('../../db/supabaseClient');
const reconcile = require('./physicalInventoryReconcile');
const { logActivity } = require('./activityLogger');

const BASELINE_MOVEMENT_TYPE = 'receipt';
const BASELINE_REASON = 'initial_baseline';
const BASELINE_SOURCE = 'physical_count';

/**
 * Build a deterministic idempotency key for a physical_product's initial baseline.
 * Same physical_product_id always maps to the same key → UNIQUE partial index
 * on `inventory_movements.idempotency_key` enforces "exactly one baseline".
 */
function buildBaselineIdempotencyKey(physicalProductId) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('buildBaselineIdempotencyKey: physicalProductId required positive integer');
  }
  return `initial_baseline:physical=${physicalProductId}`;
}

/**
 * @typedef {Object} BaselineProposal
 * @property {number}  physical_product_id
 * @property {boolean} physical_product_exists
 * @property {boolean} baseline_already_exists
 * @property {Object|null} existing_baseline_movement    { id, quantity_delta, occurred_at, actor_id, metadata }
 * @property {boolean} legacy_auto_approvable            (from reconcile · informational only)
 * @property {boolean} physical_count_required           (always true in Phase 6D-2)
 * @property {Object}  legacy_evidence                   full reconcile snapshot
 * @property {Object}  current_shadow_state              { on_hand, reserved, available, movement_count }
 * @property {string}  status                            'ready_for_physical_count' | 'baseline_exists' | 'physical_not_found'
 * @property {string}  next_action                       human-readable
 * @property {string}  idempotency_key
 * @property {string}  generatedAt
 */

/**
 * READ-ONLY proposal for a physical_product baseline. Never writes.
 *
 * @param {number} physicalProductId
 * @returns {Promise<BaselineProposal>}
 */
async function getBaselineProposal(physicalProductId) {
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    throw new Error('getBaselineProposal: physicalProductId required positive integer');
  }
  const db = getClient();

  // 1) Verify physical exists
  const { data: phy, error: eP } = await db.from('physical_products')
    .select('id, canonical_title, set_code, language, region, unit_type, status')
    .eq('id', physicalProductId)
    .maybeSingle();
  if (eP) throw eP;
  if (!phy) {
    return {
      physical_product_id: physicalProductId,
      physical_product_exists: false,
      baseline_already_exists: false,
      existing_baseline_movement: null,
      legacy_auto_approvable: false,
      physical_count_required: true,
      legacy_evidence: null,
      current_shadow_state: null,
      status: 'physical_not_found',
      next_action: `physical_products #${physicalProductId} does not exist`,
      idempotency_key: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const key = buildBaselineIdempotencyKey(physicalProductId);

  // 2) Baseline already exists?
  const { data: existing, error: eE } = await db.from('inventory_movements')
    .select('id, quantity_delta, reservation_delta, occurred_at, created_at, metadata, actor_id, physical_product_id')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (eE) throw eE;

  // 3) Legacy evidence (reconcile snapshot · READ-ONLY)
  const legacyEvidence = await reconcile.buildLegacyStockCandidatesForPhysical(physicalProductId);

  const status = existing ? 'baseline_exists' : 'ready_for_physical_count';
  const nextAction = existing
    ? `baseline movement #${existing.id} already exists (quantity_delta=${existing.quantity_delta}). Adjustments must use a separate movement — do NOT re-baseline.`
    : `Owner/staff must supply --count <N> --apply after physical shelf count. Legacy stock evidence is informational only.`;

  return {
    physical_product: {
      id: phy.id,
      canonical_title: phy.canonical_title,
      set_code: phy.set_code,
      language: phy.language,
      region: phy.region,
      unit_type: phy.unit_type,
      status: phy.status,
    },
    physical_product_id: physicalProductId,
    physical_product_exists: true,
    baseline_already_exists: !!existing,
    existing_baseline_movement: existing || null,
    legacy_auto_approvable: legacyEvidence.legacy_auto_approvable,
    physical_count_required: true,
    legacy_evidence: legacyEvidence,
    current_shadow_state: legacyEvidence.new_shadow_state,
    status,
    next_action: nextAction,
    idempotency_key: key,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @typedef {Object} BaselineApplyResult
 * @property {'applied'|'idempotent'|'invalid'|'blocked'|'error'} status
 * @property {number|null} movement_id
 * @property {number|null} quantity_delta
 * @property {string|null} idempotency_key
 * @property {string[]}    errors
 * @property {Object|null} existing_baseline           when idempotent
 */

/**
 * Apply an initial baseline receipt movement for a physical_product.
 *
 * Rules:
 *   - confirm !== true             → invalid (write 0)
 *   - countedQuantity not integer  → invalid (write 0)
 *   - countedQuantity < 0          → invalid (write 0)
 *   - physical does not exist      → blocked (write 0)
 *   - baseline already exists      → idempotent (no new insert)
 *   - otherwise                    → insert single receipt row · legacy evidence in metadata
 *
 * NEVER touches products.stock / ebay_products.stock / marketplace APIs.
 *
 * @param {Object} args
 * @param {number} args.physicalProductId
 * @param {number} args.countedQuantity     integer >= 0
 * @param {number|null} [args.actorId]
 * @param {boolean} [args.confirm=false]
 * @param {string|null} [args.note]         optional operator note
 * @returns {Promise<BaselineApplyResult>}
 */
async function applyInitialBaseline({ physicalProductId, countedQuantity, actorId = null, confirm = false, note = null }) {
  const out = { status: 'error', movement_id: null, quantity_delta: null, idempotency_key: null, errors: [], existing_baseline: null };

  if (confirm !== true) {
    out.status = 'invalid';
    out.errors.push('confirm must be true to write · this endpoint is dry-run by default');
    return out;
  }
  if (!Number.isInteger(physicalProductId) || physicalProductId <= 0) {
    out.status = 'invalid';
    out.errors.push('physicalProductId required positive integer');
    return out;
  }
  if (!Number.isInteger(countedQuantity)) {
    out.status = 'invalid';
    out.errors.push('countedQuantity required integer (non-integer rejected)');
    return out;
  }
  if (countedQuantity < 0) {
    out.status = 'invalid';
    out.errors.push('countedQuantity must be >= 0');
    return out;
  }

  const db = getClient();

  // Physical exists?
  const { data: phy, error: eP } = await db.from('physical_products')
    .select('id, canonical_title')
    .eq('id', physicalProductId)
    .maybeSingle();
  if (eP) { out.errors.push(eP.message); return out; }
  if (!phy) {
    out.status = 'blocked';
    out.errors.push(`physical_products #${physicalProductId} does not exist`);
    return out;
  }

  const key = buildBaselineIdempotencyKey(physicalProductId);
  out.idempotency_key = key;

  // Existing baseline?
  const { data: existing, error: eE } = await db.from('inventory_movements')
    .select('id, quantity_delta, reservation_delta, occurred_at, created_at, metadata, actor_id')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (eE) { out.errors.push(eE.message); return out; }
  if (existing) {
    out.status = 'idempotent';
    out.movement_id = existing.id;
    out.quantity_delta = existing.quantity_delta;
    out.existing_baseline = existing;
    out.errors.push('baseline movement already exists for this physical — no new insert · use a separate adjustment movement to change on_hand');
    return out;
  }

  // Legacy evidence snapshot for metadata (READ-ONLY reconcile call)
  let legacySnapshot = null;
  try {
    const r = await reconcile.buildLegacyStockCandidatesForPhysical(physicalProductId);
    legacySnapshot = {
      products_candidates: r.legacy_products_candidates,
      ebay_listings: r.legacy_ebay_listings,
      conflicts: r.conflicts,
      linked_sku_master_ids: r.linked_sku_master_ids,
      internal_skus: r.internal_skus,
      captured_at: r.generatedAt,
    };
  } catch (_e) { /* proceed without evidence · rare */ }

  const insertRow = {
    physical_product_id: physicalProductId,
    movement_type: BASELINE_MOVEMENT_TYPE,
    quantity_delta: countedQuantity,
    reservation_delta: 0,
    idempotency_key: key,
    reason_code: BASELINE_REASON,
    actor_id: actorId,
    metadata: {
      reason: BASELINE_REASON,
      source: BASELINE_SOURCE,
      legacy_evidence: legacySnapshot,
      approved: true,
      operator_note: note,
      confirmed_by_actor_id: actorId,
    },
    occurred_at: new Date().toISOString(),
  };

  const { data: inserted, error: eI } = await db.from('inventory_movements')
    .insert(insertRow)
    .select('id')
    .single();
  if (eI) {
    // Race: another admin apply this same second.
    if (eI.code === '23505' || /duplicate|unique/i.test(eI.message || '')) {
      const { data: found } = await db.from('inventory_movements')
        .select('id, quantity_delta, reservation_delta, occurred_at, metadata')
        .eq('idempotency_key', key)
        .maybeSingle();
      if (found) {
        out.status = 'idempotent';
        out.movement_id = found.id;
        out.quantity_delta = found.quantity_delta;
        out.existing_baseline = found;
        out.errors.push('race: another actor inserted the baseline concurrently · no double insert');
        return out;
      }
    }
    out.errors.push(eI.message);
    return out;
  }

  out.status = 'applied';
  out.movement_id = inserted.id;
  out.quantity_delta = countedQuantity;
  out.errors = [];

  // Activity log (PII-free · sanitiser also applies in activityLogger)
  try {
    await logActivity({
      action: 'physical_baseline_created',
      entityType: 'inventory_movement',
      entityId: inserted.id,
      actorId, actorType: actorId ? 'user' : 'system',
      metadata: {
        physical_product_id: physicalProductId,
        counted_quantity: countedQuantity,
        idempotency_key: key,
        canonical_title: phy.canonical_title,
      },
    });
  } catch (_e) { /* never break baseline write */ }

  return out;
}

module.exports = {
  BASELINE_MOVEMENT_TYPE,
  BASELINE_REASON,
  BASELINE_SOURCE,
  buildBaselineIdempotencyKey,
  getBaselineProposal,
  applyInitialBaseline,
};
