/**
 * src/web/routes/omsOwnerConsole.js — Phase 8I · Owner Decision Dashboard API.
 *
 * READ-ONLY (except one explicitly-gated record endpoint that delegates to the
 * canonical Phase 7C-4/5 ingestor via Phase 8G intake service).
 *
 * ZERO parallel business logic. Endpoints project verbatim from:
 *   inventoryExceptionQueueService.buildInventoryExceptionQueue
 *   inventoryOwnerDecisionService.buildOwnerDecision
 *   inventoryOwnerActionWorkflowService.buildOwnerActionWorkflow
 *   inventoryOwnerEvidenceIntakeService.{previewOwnerEvidence, recordOwnerEvidence, previewOwnerEvidenceReassessment}
 *
 * Owner directive (Phase 8I §14):
 *   NO auto purchase / auto hold / marketplace mutation / inventory mutation
 *   NO scheduler / cron change / notification send / new migration
 */
'use strict';

const express = require('express');

/**
 * Factory so tests can inject dependencies (avoids hitting the real DB /
 * ingestor / assess pipeline). Default export at the bottom binds to the
 * real services.
 */
function buildRouter(deps = {}) {
  const router = express.Router();

  // Owner-only. Reuses existing admin guard (Owner = role='admin' — no new tier).
  const requireAdmin = deps.requireAdmin || require('../../middleware/auth').requireAdmin;
  router.use(requireAdmin);

  const queueFn = deps.queueFn || (opts => require('../../services/oms/inventoryExceptionQueueService').buildInventoryExceptionQueue(opts));
  const ownerDecisionFn = deps.ownerDecisionFn || (args => require('../../services/oms/inventoryOwnerDecisionService').buildOwnerDecision(args));
  const workflowFn = deps.workflowFn || (ownerDecision => require('../../services/oms/inventoryOwnerActionWorkflowService').buildOwnerActionWorkflow(ownerDecision));
  const previewFn = deps.previewFn || ((input, opts) => require('../../services/oms/inventoryOwnerEvidenceIntakeService').previewOwnerEvidence(input, opts));
  const recordFn = deps.recordFn || ((input, opts) => require('../../services/oms/inventoryOwnerEvidenceIntakeService').recordOwnerEvidence(input, opts));
  const reassessFn = deps.reassessFn || (args => require('../../services/oms/inventoryOwnerEvidenceIntakeService').previewOwnerEvidenceReassessment(args));
  // Phase 8J · timeline · SoT reuse (no parallel logic)
  const evidenceHistoryFn = deps.evidenceHistoryFn || (args => require('../../services/oms/replacementEvidenceService').listReplacementObservationsForOwner(args));

  // ─── 1) Batch exception queue ─────────────────────────
  // Owner §Part 10: ONE call for the page. Detail is lazy per-item.
  router.get('/inventory-exceptions', async (req, res) => {
    try {
      const limit = _parseOptionalPositiveInt(req.query.limit);
      if (req.query.limit !== undefined && limit === null) {
        return res.status(400).json({ error: 'invalid_limit', message: 'limit must be a positive integer' });
      }
      const activeOnly = req.query.activeOnly === 'false' ? false : true;
      const result = await queueFn({ limit, activeOnly, concurrency: 4 });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'inventory_exceptions_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 2) Owner decision detail (Phase 8E projection) ──
  router.get('/inventory-decision/:physicalId', async (req, res) => {
    const id = _parsePositiveInt(req.params.physicalId);
    if (!id) return res.status(400).json({ error: 'invalid_physical_id', message: 'physicalId must be positive integer' });
    try {
      const ownerDecision = await ownerDecisionFn({ physicalProductId: id });
      if (ownerDecision && ownerDecision.error) return res.status(404).json({ error: ownerDecision.error, decision: ownerDecision });
      res.json(ownerDecision);
    } catch (err) {
      res.status(500).json({ error: 'inventory_decision_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 3) Owner action workflow (Phase 8F projection) ──
  router.get('/inventory-actions/:physicalId', async (req, res) => {
    const id = _parsePositiveInt(req.params.physicalId);
    if (!id) return res.status(400).json({ error: 'invalid_physical_id', message: 'physicalId must be positive integer' });
    try {
      const ownerDecision = await ownerDecisionFn({ physicalProductId: id });
      if (ownerDecision && ownerDecision.error) return res.status(404).json({ error: ownerDecision.error });
      const workflow = workflowFn(ownerDecision);
      res.json({ owner_decision: ownerDecision, workflow });
    } catch (err) {
      res.status(500).json({ error: 'inventory_actions_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 4) Evidence PREVIEW (never writes) ──────────────
  router.post('/evidence/preview', express.json({ limit: '32kb' }), async (req, res) => {
    const input = _sanitizeEvidenceInput(req.body || {});
    try {
      const result = await previewFn(input);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'evidence_preview_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 5) Evidence RECORD (explicit two-gate: confirm + identity + [current-quote]) ─
  router.post('/evidence/record', express.json({ limit: '32kb' }), async (req, res) => {
    const body = req.body || {};
    // omsAdmin.js convention: writes require {confirm: true} — surface the hard gate here too.
    if (body.confirm !== true) {
      return res.status(400).json({ error: 'confirm_must_be_true', message: 'send {confirm: true} to record evidence' });
    }
    // Legacy shared-password admin (userId=0) cannot record — Owner must be a real user.
    if (req.user && req.user.isLegacy) {
      return res.status(403).json({ error: 'legacy_admin_cannot_record_evidence', message: 'Legacy shared-password admin cannot record evidence. Log in as a real Owner account.' });
    }
    const identityConfirmed = body.identityConfirmed === true;
    const currentQuoteConfirmed = body.currentQuoteConfirmed === true;
    const input = _sanitizeEvidenceInput(body);
    try {
      const result = await recordFn(input, { identityConfirmed, currentQuoteConfirmed, actorId: req.user?.id ?? null });
      // Map ingestor status → HTTP status (mirrors omsAdmin baseline pattern).
      if (result && result.persistence === 'NOT_WRITTEN_GATE_REJECTED') {
        return res.status(400).json({ error: 'gate_rejected', result });
      }
      if (result && result.error === 'physical_not_found') {
        return res.status(404).json({ error: 'physical_not_found', result });
      }
      const status = result?.plan?.status;
      if (status === 'failed') return res.status(409).json({ error: 'record_failed', result });
      if (status === 'partial') return res.status(207).json(result);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'evidence_record_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 6a) Evidence history timeline (Phase 8J · READ-ONLY) ─
  // Owner Console UI renders past observations (SoT via getReplacementEvidence
  // analyser). Never exposes raw evidence.jsonb — only allow-listed derived
  // fields.
  router.get('/evidence-history/:physicalId', async (req, res) => {
    const id = _parsePositiveInt(req.params.physicalId);
    if (!id) return res.status(400).json({ error: 'invalid_physical_id', message: 'physicalId must be positive integer' });
    const limit = _parseOptionalPositiveInt(req.query.limit);
    if (req.query.limit !== undefined && limit === null) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be a positive integer' });
    }
    try {
      const result = await evidenceHistoryFn({ physicalProductId: id, limit: limit ?? 50 });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'evidence_history_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 6) Reassessment AFTER a successful record ───────
  // Client passes the BEFORE snapshot it captured pre-record. Server re-runs
  // canonical assess and returns Phase 8G reassessment (BEFORE/AFTER).
  router.post('/evidence/reassess-after-record', express.json({ limit: '256kb' }), async (req, res) => {
    const body = req.body || {};
    const id = _parsePositiveInt(body.physicalId);
    if (!id) return res.status(400).json({ error: 'invalid_physical_id' });
    if (!body.beforeSnapshot || typeof body.beforeSnapshot !== 'object') {
      return res.status(400).json({ error: 'beforeSnapshot_required', message: 'client must send the BEFORE Phase 8E/8F snapshot captured pre-record' });
    }
    try {
      const result = await reassessFn({ physicalProductId: id, beforeSnapshot: body.beforeSnapshot, mode: 'around_record' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'reassess_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  return router;
}

// ─── helpers ────────────────────────────────────────────

function _parsePositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function _parseOptionalPositiveInt(v) {
  if (v === undefined || v === null || v === '') return null;
  return _parsePositiveInt(v);
}

/**
 * Allow-list keys the intake service consumes. Anything the client sends
 * outside this list is silently dropped so route handlers can't be tricked
 * into forwarding stray fields.
 */
const ALLOWED_EVIDENCE_FIELDS = Object.freeze([
  'physicalId', 'evidenceType', 'source', 'supplierName', 'supplierId',
  'sourceListingId', 'currency', 'price', 'priceBasis', 'physicalUnitsPerOffer',
  'minimumOrderQuantity', 'availabilityStatus', 'leadTimeDays', 'observedAt',
  'sourceClass', 'availableQuantityMin', 'availableQuantityMax', 'availableQuantityExact',
  'maxReplenishableQuantity', 'unitsPerCarton', 'cartonCount',
  'identityConfirmed', 'currentQuoteConfirmed',
]);

function _sanitizeEvidenceInput(body) {
  const out = {};
  for (const k of ALLOWED_EVIDENCE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  // Coerce physicalId to positive integer (server-side; client identity is not trusted).
  if (out.physicalId != null) {
    const n = parseInt(out.physicalId, 10);
    out.physicalId = Number.isInteger(n) && n > 0 ? n : null;
  }
  return out;
}

module.exports = buildRouter();
module.exports.buildRouter = buildRouter;
module.exports._internals = { _parsePositiveInt, _parseOptionalPositiveInt, _sanitizeEvidenceInput, ALLOWED_EVIDENCE_FIELDS };
