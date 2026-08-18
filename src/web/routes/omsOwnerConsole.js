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
  // Phase 8L integration · additive read-only financial metrics projection.
  //   Pure adapter over ownerDecision + caller-supplied pricing opts. No DB.
  const financialMetricsFn = deps.financialMetricsFn || ((ownerDecision, opts) => require('../../services/oms/financialMetricsAssembler').buildFinancialMetrics(ownerDecision, opts));
  // Phase 8N · multi-product comparison · pure projection
  const compareFn = deps.compareFn || ((items, opts) => require('../../services/oms/multiProductComparisonService').buildMultiProductComparison(items, opts));
  // Phase 8O · auto-input orchestrator. Default factory resolves its own
  //   Supabase client via financialMetricsOrchestratorDefaults so the
  //   route source has zero direct DB coupling (I17-I20 / J11 guard).
  const orchestratorFn = deps.orchestratorFn || (args => require('../../services/oms/financialMetricsOrchestrator')
    .buildFinancialMetricsWithAutoInputs({ ...args, db: args.db || require('../../services/oms/financialMetricsOrchestratorDefaults').defaultDb() }));

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

  // ─── 6b) Financial metrics (Phase 8L integration + 8O auto-mode · READ-ONLY) ─
  //   Additive read-only surface. Owner Decision + optional caller-supplied
  //   pricing inputs (query string). Returns 3 independent cost-basis
  //   scenarios (accounting / replacement / secondary_market_ask).
  //
  //   Phase 8O: `?auto=1` runs the orchestrator (auto sale-price observation
  //   + auto shipping candidate). Manual query-param overrides still win
  //   (Owner rule §5.1). Secondary market ask NEVER used as sale-price
  //   fallback. UNKNOWN never rendered as 0.
  //
  //   Never mutates Owner Decision. Never derives sale price · never
  //   auto-selects cost basis · UNKNOWN when inputs missing.
  router.get('/financial-metrics/:physicalId', async (req, res) => {
    const id = _parsePositiveInt(req.params.physicalId);
    if (!id) return res.status(400).json({ error: 'invalid_physical_id', message: 'physicalId must be positive integer' });
    const opts = _parseFinancialMetricsOpts(req.query);
    const autoMode = req.query.auto === '1' || req.query.auto === 'true';
    try {
      const ownerDecision = await ownerDecisionFn({ physicalProductId: id });
      if (ownerDecision && ownerDecision.error) return res.status(404).json({ error: ownerDecision.error });
      if (!autoMode) {
        const financial_metrics = financialMetricsFn(ownerDecision, opts);
        return res.json({ owner_decision: ownerDecision, financial_metrics, mode: 'manual' });
      }
      //   Auto-mode: orchestrator resolves inputs (manual > auto > UNKNOWN)
      const db = null;   // orchestrator default factory resolves DB
      const auto = await orchestratorFn({
        ownerDecision, db,
        manual: opts,
        autoSalePriceOpts: _parseAutoSalePriceOpts(req.query),
        autoShippingOpts: _parseAutoShippingOpts(req.query),
      });
      return res.json({
        owner_decision: ownerDecision,
        financial_metrics: auto.financial_metrics,
        inputs_resolution: auto.inputs_resolution,
        mode: 'auto',
      });
    } catch (err) {
      res.status(500).json({ error: 'financial_metrics_failed', message: err && err.message ? err.message : String(err) });
    }
  });

  // ─── 6c) Multi-product comparison (Phase 8N · READ-ONLY) ─
  //   Owner picks a set of physicalIds to compare side-by-side.
  //   Preserves existing priority ordering · no new ROI algorithm.
  //   Financial metrics are OPTIONAL per item (query param opts apply
  //   uniformly to all items · same sale-price/shipping/fee assumptions).
  router.get('/compare', async (req, res) => {
    const idsRaw = String(req.query.ids || '').trim();
    if (!idsRaw) return res.status(400).json({ error: 'ids_required', message: 'ids=1,2,3 required' });
    const ids = idsRaw.split(',').map(s => _parsePositiveInt(s.trim())).filter(v => v != null);
    if (ids.length === 0) return res.status(400).json({ error: 'invalid_ids', message: 'no valid positive integer ids parsed' });
    if (ids.length > 25) return res.status(400).json({ error: 'too_many_ids', message: 'max 25 items per comparison' });
    const financialOpts = _parseFinancialMetricsOpts(req.query);
    const autoMode = req.query.auto === '1' || req.query.auto === 'true';
    const autoSalePriceOpts = _parseAutoSalePriceOpts(req.query);
    const autoShippingOpts = _parseAutoShippingOpts(req.query);
    try {
      const items = [];
      const db = null;   // orchestrator default factory resolves DB
      for (const id of ids) {
        const ownerDecision = await ownerDecisionFn({ physicalProductId: id });
        if (ownerDecision && ownerDecision.error) {
          items.push({ ownerDecision: { physical_product_id: id, error: ownerDecision.error }, financialMetrics: null });
          continue;
        }
        let fm;
        if (autoMode) {
          //   orchestratorFn resolves its own db when db=null (default factory)
          const auto = await orchestratorFn({ ownerDecision, db, manual: financialOpts, autoSalePriceOpts, autoShippingOpts });
          fm = auto.financial_metrics;
        } else {
          fm = financialMetricsFn(ownerDecision, financialOpts);
        }
        items.push({ ownerDecision, financialMetrics: fm });
      }
      const comparison = compareFn(items, { generatedAt: new Date().toISOString() });
      res.json({ comparison, item_count: items.length, financial_opts_applied: financialOpts, mode: autoMode ? 'auto' : 'manual' });
    } catch (err) {
      res.status(500).json({ error: 'compare_failed', message: err && err.message ? err.message : String(err) });
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

function _parseAutoSalePriceOpts(query) {
  //   Phase 8O · caller-supplied FX only (Phase 2-2C). Never falls back to a
  //   hard-coded rate.
  const opts = {};
  for (const f of ['usdKrw', 'usdKrwSource', 'usdKrwObservedAt']) {
    if (query[f] !== undefined && query[f] !== '') {
      if (f === 'usdKrw') {
        const n = Number(query[f]);
        opts[f] = Number.isFinite(n) ? n : null;
      } else {
        opts[f] = String(query[f]).slice(0, 200);
      }
    }
  }
  return opts;
}

function _parseAutoShippingOpts(query) {
  //   Owner supplies package dims per SKU (sku_master has weight only ·
  //   Phase 8O known gap). If dims absent → shipping UNKNOWN.
  const opts = {};
  for (const f of ['lengthCm', 'widthCm', 'heightCm']) {
    if (query[f] !== undefined && query[f] !== '') {
      const n = Number(query[f]);
      opts[f] = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  if (query.destinationCountry) opts.destinationCountry = String(query.destinationCountry).slice(0, 30);
  return opts;
}

function _parseFinancialMetricsOpts(query) {
  //   Whitelist + strict numeric coercion for query params. Any invalid
  //   value → null · downstream marks the metric UNKNOWN (never 0-fabricates).
  const opts = {};
  const numFields = [
    'expected_sale_price_krw',
    'seller_borne_shipping_krw',
    'marketplace_fee_pct',
    'marketplace_fixed_fee_krw',
  ];
  for (const f of numFields) {
    if (query[f] !== undefined && query[f] !== '') {
      const n = Number(query[f]);
      opts[f] = Number.isFinite(n) ? n : null;
    }
  }
  //   Provenance strings are bounded to 200 chars to prevent log/response
  //   inflation. Bad type or empty → null.
  const strFields = ['expected_sale_price_source', 'shipping_source'];
  for (const f of strFields) {
    if (typeof query[f] === 'string' && query[f].length > 0) {
      opts[f] = query[f].slice(0, 200);
    }
  }
  return opts;
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
