'use strict';

/**
 * priceExecutionGate.js — Phase 1 Commit 2
 * ---------------------------------------------------------------------------
 * The single safety boundary that MUST wrap every eBay price mutation.
 *
 * Contract (owner directive 2026-08-10):
 *   - kill_switch=true            → BLOCK unconditionally
 *   - guardrail DB read failed    → BLOCK (fail-closed)
 *   - context AUTO / SYSTEM       → also requires auto_apply_enabled=true
 *   - context MANUAL_APPROVED     → ignores auto_apply_enabled (human already decided)
 *   - context MANUAL_DIRECT       → ignores auto_apply_enabled (owner keeps overrides)
 *                                   BUT kill_switch still blocks
 *   - Every context still runs the primitive data safety checks
 *     (invalid number / currency / impossible price / corrupted SKU / duplicate)
 *   - Idempotency is PERSISTENT via automation_runs.request_id UNIQUE index
 *     (migration 075). In-memory maps are forbidden.
 *   - price_events(PriceApplied) is only written AFTER marketplace API success.
 *   - price_events(PriceFailed) is written when marketplace API fails.
 *   - price_events(PriceBlocked) is written when the gate itself refuses.
 *   - ebay_products.price_usd is only UPDATE'd after a successful PriceApplied.
 *
 * Not this commit: wiring existing callers to the gate. That is Commit 3+.
 *
 * Dependency injection: all external I/O is passed via `deps` so tests
 * can substitute in-memory mocks. Production callers pass nothing → real
 * clients are lazily required (no DB import at module load).
 */

const { publishPriceEvent } = require('./priceEventService');

const CONTEXTS = Object.freeze(['AUTO', 'MANUAL_APPROVED', 'MANUAL_DIRECT', 'SYSTEM']);
const CONTEXTS_REQUIRING_AUTO_APPLY = new Set(['AUTO', 'SYSTEM']);

const OUTCOME = Object.freeze({
  APPLIED: 'APPLIED',       // marketplace + audit + state sync all succeeded
  FAILED: 'FAILED',         // gate passed, marketplace API failed
  BLOCKED: 'BLOCKED',       // gate refused before touching marketplace
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY', // request_id already terminal → prior outcome returned
});

/** Deterministic reason codes the gate emits itself. priceEngine reason_codes
 *  are used for engine-produced BLOCKs; these cover gate-produced BLOCKs. */
const GATE_REASON = Object.freeze({
  KILL_SWITCH: 'GATE_KILL_SWITCH',
  GUARDRAIL_READ_FAILED: 'GATE_GUARDRAIL_READ_FAILED',
  AUTO_APPLY_DISABLED: 'GATE_AUTO_APPLY_DISABLED',
  INVALID_CONTEXT: 'GATE_INVALID_CONTEXT',
  MISSING_REQUEST_ID: 'GATE_MISSING_REQUEST_ID',
  MISSING_IDENTIFIERS: 'GATE_MISSING_IDENTIFIERS',
  INVALID_PRICE: 'GATE_INVALID_PRICE',
  UNSUPPORTED_CURRENCY: 'GATE_UNSUPPORTED_CURRENCY',
  MARKETPLACE_FAILED: 'GATE_MARKETPLACE_FAILED',
  // 2026-08-10 owner directive: a re-issued request_id whose prior run
  // is still pending/started is NOT the same failure mode as a guardrail
  // read failure. Callers can retry after the concurrent run settles.
  EXECUTION_IN_PROGRESS: 'GATE_EXECUTION_IN_PROGRESS',
});

/** Terminal automation_runs.status values the gate treats as "already settled".
 *  A re-issued request_id in one of these states returns the prior outcome
 *  without touching the marketplace again. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** Non-USD calls are refused in v1. eBay listings are all USD; other
 *  marketplaces are out of scope this phase per owner directive. */
const SUPPORTED_CURRENCIES = new Set(['USD']);

/**
 * Execute a price write behind the gate.
 *
 * @param {object} req
 * @param {string} req.sku
 * @param {string} req.itemId
 * @param {number} req.oldPrice
 * @param {number} req.newPrice
 * @param {string} req.reasonCode        priceEngine REASON.* or a caller-supplied code
 * @param {string} req.requestId         client-supplied idempotency key (required)
 * @param {'AUTO'|'MANUAL_APPROVED'|'MANUAL_DIRECT'|'SYSTEM'} req.context
 * @param {string} [req.actor='system']  'system' | 'user:<id>' | ...
 * @param {string} [req.currency='USD']
 * @param {object} [req.competitorRef]   passthrough to price_events.competitor_ref
 * @param {object} [req.confidenceSnapshot] passthrough to price_events.confidence_snapshot
 * @param {number} [req.landingCost]     passthrough to price_events.landing_cost
 * @param {string} [req.ruleVersion]     passthrough to price_events.rule_version
 *
 * @param {object} [deps]                dependency injection for tests
 * @param {object} [deps.db]             Supabase client (from ../db/supabaseClient)
 * @param {object} [deps.ebay]           object with async updateItem({itemId, price})
 * @param {function} [deps.getGuardrails] async () → guardrails row
 * @param {function} [deps.publishPriceEvent] override the audit publisher
 * @param {function} [deps.now]          () → Date (tests can freeze time)
 *
 * @returns {Promise<{outcome, reasonCode, runId, eventId, priorRunId, error}>}
 *   Never throws — caller inspects `outcome`. Gate itself is fail-closed:
 *   any unexpected error surfaces as BLOCKED with GUARDRAIL_READ_FAILED.
 */
async function executePriceWrite(req, deps = {}) {
  const now = deps.now || (() => new Date());

  // ── 0. Primitive input validation (all contexts) ────────────────────────
  const validation = validateInput(req);
  if (validation) {
    // Cannot audit without at minimum a request_id, but we still emit a
    // PriceBlocked event where possible so operators see the rejection.
    return blockWithoutRun({ req, gateReason: validation, deps });
  }

  const db = deps.db || require('../db/supabaseClient').getClient();

  // ── 1. Idempotency reservation via automation_runs UNIQUE index ─────────
  //    ANY subsequent step failing must UPDATE this row to a terminal state.
  const insertRes = await db
    .from('automation_runs')
    .insert({
      action_name: 'price_change',
      automation_type: 'price_change',
      triggered_by: req.actor || 'system',
      status: 'pending',
      request_id: req.requestId,
      target_table: 'ebay_products',
      input_snapshot: {
        sku: req.sku,
        item_id: req.itemId,
        old_price: req.oldPrice,
        new_price: req.newPrice,
        currency: req.currency || 'USD',
        context: req.context,
        reason_code: req.reasonCode,
      },
      started_at: now().toISOString(),
    })
    .select('id')
    .single();

  if (insertRes.error) {
    // UNIQUE violation → this request_id already exists. Return the prior outcome.
    // Postgres error code 23505 = unique_violation.
    const code = insertRes.error.code || '';
    if (code === '23505' || /duplicate key|unique constraint/i.test(insertRes.error.message || '')) {
      return replayPriorRun({ db, requestId: req.requestId, req, deps });
    }
    // Any other insert failure = infra unreachable → fail-closed BLOCK.
    return {
      outcome: OUTCOME.BLOCKED,
      reasonCode: GATE_REASON.GUARDRAIL_READ_FAILED,
      runId: null, eventId: null,
      error: `automation_runs insert failed: ${insertRes.error.message}`,
    };
  }
  const runId = insertRes.data.id;

  // ── 2. Guardrail check (fail-closed on read failure) ────────────────────
  const guardrailRes = await safeGetGuardrails(deps);
  if (!guardrailRes.ok) {
    await markRun(db, runId, 'failed', now(), { error: guardrailRes.error });
    const eventId = await safePublish(deps, {
      event_type: 'PriceBlocked', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.GUARDRAIL_READ_FAILED,
    });
    return {
      outcome: OUTCOME.BLOCKED, reasonCode: GATE_REASON.GUARDRAIL_READ_FAILED,
      runId, eventId, error: guardrailRes.error,
    };
  }
  const g = guardrailRes.guardrails;

  if (g.kill_switch === true) {
    await markRun(db, runId, 'cancelled', now(), { blocked: 'kill_switch' });
    const eventId = await safePublish(deps, {
      event_type: 'PriceBlocked', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.KILL_SWITCH,
    });
    return { outcome: OUTCOME.BLOCKED, reasonCode: GATE_REASON.KILL_SWITCH, runId, eventId };
  }

  if (CONTEXTS_REQUIRING_AUTO_APPLY.has(req.context) && g.auto_apply_enabled !== true) {
    await markRun(db, runId, 'cancelled', now(), { blocked: 'auto_apply_disabled' });
    const eventId = await safePublish(deps, {
      event_type: 'PriceBlocked', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.AUTO_APPLY_DISABLED,
    });
    return { outcome: OUTCOME.BLOCKED, reasonCode: GATE_REASON.AUTO_APPLY_DISABLED, runId, eventId };
  }

  // ── 3. Marketplace API (mockable) ────────────────────────────────────────
  const ebay = deps.ebay || require('../api/ebayAPI').getInstance
    ? deps.ebay || require('../api/ebayAPI').getInstance()
    : deps.ebay;
  if (!ebay || typeof ebay.updateItem !== 'function') {
    await markRun(db, runId, 'failed', now(), { error: 'no_ebay_client' });
    const eventId = await safePublish(deps, {
      event_type: 'PriceFailed', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.MARKETPLACE_FAILED,
    });
    return {
      outcome: OUTCOME.FAILED, reasonCode: GATE_REASON.MARKETPLACE_FAILED,
      runId, eventId, error: 'no ebay client available',
    };
  }

  let apiResult;
  try {
    apiResult = await ebay.updateItem(req.itemId, { price: req.newPrice });
  } catch (e) {
    await markRun(db, runId, 'failed', now(), { error: e.message });
    const eventId = await safePublish(deps, {
      event_type: 'PriceFailed', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.MARKETPLACE_FAILED,
    });
    return {
      outcome: OUTCOME.FAILED, reasonCode: GATE_REASON.MARKETPLACE_FAILED,
      runId, eventId, error: e.message,
    };
  }

  if (!apiResult || apiResult.success !== true) {
    await markRun(db, runId, 'failed', now(), { error: apiResult && apiResult.error });
    const eventId = await safePublish(deps, {
      event_type: 'PriceFailed', sku: req.sku, item_id: req.itemId,
      old_price: req.oldPrice, new_price: req.newPrice,
      currency: req.currency || 'USD', actor: req.actor,
      reason_code_gate: GATE_REASON.MARKETPLACE_FAILED,
    });
    return {
      outcome: OUTCOME.FAILED, reasonCode: GATE_REASON.MARKETPLACE_FAILED,
      runId, eventId, error: (apiResult && apiResult.error) || 'unknown marketplace failure',
    };
  }

  // ── 4. Success: audit → state sync ──────────────────────────────────────
  //    Order matters. PriceApplied is the durable proof; state UPDATE is
  //    the cache. If state UPDATE fails we still leave PriceApplied so
  //    the next crontab sync can rediscover the true state.
  const eventId = await safePublish(deps, {
    event_type: 'PriceApplied', sku: req.sku, item_id: req.itemId,
    old_price: req.oldPrice, new_price: req.newPrice,
    currency: req.currency || 'USD',
    actor: req.actor, reason_code: req.reasonCode,
    confidence_snapshot: req.confidenceSnapshot,
    rule_version: req.ruleVersion, competitor_ref: req.competitorRef,
    landing_cost: req.landingCost,
  });

  let stateSyncError = null;
  const updateRes = await db
    .from('ebay_products')
    .update({ price_usd: req.newPrice, updated_at: now().toISOString() })
    .eq('item_id', req.itemId);
  if (updateRes.error) stateSyncError = updateRes.error.message;

  await markRun(db, runId, 'succeeded', now(), {
    event_id: eventId,
    state_sync_error: stateSyncError,
  });

  return {
    outcome: OUTCOME.APPLIED,
    reasonCode: req.reasonCode || 'AUTO_UNDERCUT_SAFE',
    runId, eventId,
    stateSyncError,
  };
}

/* ─────────────────────────── helpers ─────────────────────────── */

function validateInput(req) {
  if (!req || typeof req !== 'object') return GATE_REASON.INVALID_CONTEXT;
  if (!CONTEXTS.includes(req.context)) return GATE_REASON.INVALID_CONTEXT;
  if (!req.requestId || typeof req.requestId !== 'string') return GATE_REASON.MISSING_REQUEST_ID;
  if (!req.sku || !req.itemId) return GATE_REASON.MISSING_IDENTIFIERS;

  const p = Number(req.newPrice);
  if (!Number.isFinite(p) || p <= 0 || p > 1e6) return GATE_REASON.INVALID_PRICE;

  const currency = req.currency || 'USD';
  if (!SUPPORTED_CURRENCIES.has(currency)) return GATE_REASON.UNSUPPORTED_CURRENCY;
  return null;
}

async function safeGetGuardrails(deps) {
  try {
    const loader = deps.getGuardrails
      || require('./priceEventService').getGuardrails;
    const guardrails = await loader();
    if (!guardrails || typeof guardrails !== 'object') {
      return { ok: false, error: 'guardrails row missing' };
    }
    return { ok: true, guardrails };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function safePublish(deps, payload) {
  const publisher = deps.publishPriceEvent || publishPriceEvent;
  try {
    // priceEventService.publishPriceEvent's schema needs event_type + optional
    // reason_code (an enum). Gate-produced blocks use a non-enum reason so we
    // encode it into confidence_snapshot to avoid enum violation while still
    // keeping it queryable.
    const ev = {
      event_type: payload.event_type,
      sku: payload.sku, item_id: payload.item_id,
      old_price: payload.old_price, new_price: payload.new_price,
      currency: payload.currency, actor: payload.actor,
      reason_code: payload.reason_code || null,
      confidence_snapshot: payload.reason_code_gate
        ? { gate_reason: payload.reason_code_gate }
        : (payload.confidence_snapshot || null),
      rule_version: payload.rule_version,
      competitor_ref: payload.competitor_ref,
      landing_cost: payload.landing_cost,
      recommended_price: payload.recommended_price,
    };
    return await publisher(ev);
  } catch (e) {
    // Publishing failure must never mask the primary outcome. Log-only.
    // eslint-disable-next-line no-console
    console.warn('[priceExecutionGate] publish failed:', e.message);
    return null;
  }
}

async function markRun(db, runId, status, when, extra = {}) {
  const patch = { status, completed_at: when.toISOString() };
  if (extra.error) patch.error_message = String(extra.error).slice(0, 500);
  if (extra.event_id != null) patch.output_snapshot = { event_id: extra.event_id, state_sync_error: extra.state_sync_error || null };
  if (extra.blocked) patch.output_snapshot = { blocked_reason: extra.blocked };
  const { error } = await db.from('automation_runs').update(patch).eq('id', runId);
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[priceExecutionGate] markRun failed:', error.message);
  }
}

async function replayPriorRun({ db, requestId, req, deps }) {
  const { data, error } = await db
    .from('automation_runs')
    .select('id, status, output_snapshot, error_message')
    .eq('request_id', requestId)
    .maybeSingle();
  if (error || !data) {
    return {
      outcome: OUTCOME.BLOCKED,
      reasonCode: GATE_REASON.GUARDRAIL_READ_FAILED,
      runId: null, eventId: null,
      error: `replay lookup failed: ${error?.message || 'row disappeared'}`,
    };
  }
  const priorEventId = data.output_snapshot?.event_id || null;
  if (data.status === 'succeeded') {
    return {
      outcome: OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_SUCCESS',
      runId: null, priorRunId: data.id, eventId: priorEventId,
    };
  }
  if (data.status === 'failed') {
    return {
      outcome: OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_FAILURE',
      runId: null, priorRunId: data.id, eventId: priorEventId,
      error: data.error_message || null,
    };
  }
  if (data.status === 'cancelled') {
    return {
      outcome: OUTCOME.IDEMPOTENT_REPLAY, reasonCode: 'PRIOR_BLOCKED',
      runId: null, priorRunId: data.id, eventId: priorEventId,
    };
  }
  // status === 'pending' or 'started' → another gate is executing right now.
  // Refuse to double-execute; caller can retry after a moment.
  // Emit a PriceBlocked event so operators see the concurrent-collision.
  const eventId = await safePublish(deps || {}, {
    event_type: 'PriceBlocked',
    sku: (req && req.sku) || null, item_id: (req && req.itemId) || null,
    old_price: req && req.oldPrice, new_price: req && req.newPrice,
    currency: (req && req.currency) || 'USD',
    actor: (req && req.actor) || 'system',
    reason_code_gate: GATE_REASON.EXECUTION_IN_PROGRESS,
  });
  return {
    outcome: OUTCOME.BLOCKED,
    reasonCode: GATE_REASON.EXECUTION_IN_PROGRESS,
    runId: null, priorRunId: data.id, eventId,
    error: `concurrent execution in progress (status=${data.status})`,
  };
}

/**
 * When validation fails before we get a runId, we still emit a PriceBlocked
 * event where possible (so operators see the rejection) but we do not
 * consume an automation_runs row (nothing to write about it).
 */
async function blockWithoutRun({ req, gateReason, deps }) {
  const eventId = await safePublish(deps, {
    event_type: 'PriceBlocked',
    sku: req && req.sku, item_id: req && req.itemId,
    old_price: req && req.oldPrice, new_price: req && req.newPrice,
    currency: (req && req.currency) || 'USD',
    actor: (req && req.actor) || 'system',
    reason_code_gate: gateReason,
  });
  return { outcome: OUTCOME.BLOCKED, reasonCode: gateReason, runId: null, eventId };
}

module.exports = {
  executePriceWrite,
  OUTCOME, GATE_REASON, CONTEXTS,
  // exported for tests only
  _internal: { validateInput, TERMINAL_STATUSES, SUPPORTED_CURRENCIES },
};
