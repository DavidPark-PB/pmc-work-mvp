'use strict';

/**
 * src/web/routes/shippingRateAdmin.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * READ + WRITE admin surface for the shipping rate master:
 *
 *   GET  /versions              → list rate versions
 *   POST /versions/:id/activate → promote draft → active (owner directive §3)
 *   POST /import/preview        → parse xlsx and return validation report (READ ONLY)
 *   POST /import/commit         → parse + insert (idempotent, transactional)
 *   GET  /services              → list services under active (or ?versionId=)
 *   GET  /countries             → list countries under active
 *   GET  /surcharges            → list surcharges under active
 *   POST /surcharges/:id        → update value/enabled/note (weekly FSC input)
 *   POST /quote                 → single-quote tester (§10 admin surface)
 *   POST /quote/batch           → batch quote (auto-listing dry-run)
 *
 * Owner-only. Reuses the existing `requireAdmin` middleware.
 *
 * NO marketplace mutation. NO eBay call. NO DB business writes on GET.
 * `POST /import/commit` and `POST /surcharges/:id` are the ONLY DB writers —
 * both are scoped strictly to the 5 rate-master tables.
 */

const express = require('express');
const multer  = require('multer');
const router  = express.Router();

const { requireAdmin } = require('../../middleware/auth');
const { getClient }    = require('../../db/supabaseClient');
const importer         = require('../../services/shipping/rateMasterImporter');
const quoteService     = require('../../services/shipping/shippingQuoteService');
const repo             = require('../../services/shipping/rateMasterRepository');
const bands            = require('../../services/shipping/shippingPolicyBands');
const adapter          = require('../../services/shipping/autoListingPricingAdapter');

router.use(requireAdmin);

//   64 MB upload cap — a normal rate book is <500 KB; the workbook shipped
//   with the initial seed is 155 KB. 64 MB leaves headroom for future
//   multi-provider workbooks without turning this into an ingestion vector.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

//   GET /versions ────────────────────────────────────────────────
router.get('/versions', async (_req, res) => {
  try {
    const db = getClient();
    const r = await db
      .from('shipping_rate_versions')
      .select('id, provider, source_name, effective_from, effective_to, status, imported_at, imported_by, note')
      .order('imported_at', { ascending: false })
      .limit(200);
    if (r.error) throw r.error;
    res.json({ ok: true, versions: r.data || [] });
  } catch (e) {
    console.error('[shippingRateAdmin] versions failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /versions/:id/activate ─────────────────────────────────
router.post('/versions/:id/activate', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const db = getClient();
    const out = await importer.activateVersion(db, id);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[shippingRateAdmin] activate failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /import/preview ─────────────────────────────────────────
router.post('/import/preview', upload.single('workbook'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'workbook file missing' });
    const parsed = await importer.parseAndValidate(req.file.buffer);
    res.json({
      ok:        parsed.ok,
      version:   parsed.version,
      counts:    {
        services:   parsed.services   ? parsed.services.length   : 0,
        countries:  parsed.countries  ? parsed.countries.length  : 0,
        brackets:   parsed.brackets   ? parsed.brackets.length   : 0,
        surcharges: parsed.surcharges ? parsed.surcharges.length : 0,
      },
      errors:    parsed.errors,
      warnings:  parsed.warnings,
      //   Owner-friendly first-5 sample of each sheet for spot-checking.
      previewRows: {
        services:   (parsed.services   || []).slice(0, 5),
        countries:  (parsed.countries  || []).slice(0, 5),
        brackets:   (parsed.brackets   || []).slice(0, 5),
        surcharges: (parsed.surcharges || []).slice(0, 5),
      },
    });
  } catch (e) {
    console.error('[shippingRateAdmin] import/preview failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /import/commit ──────────────────────────────────────────
router.post('/import/commit', upload.single('workbook'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'workbook file missing' });
    const db = getClient();
    const out = await importer.importWorkbook(db, req.file.buffer, {
      sourceName:    req.body.sourceName    || req.file.originalname || 'upload',
      provider:      req.body.provider      || null,
      effectiveFrom: req.body.effectiveFrom || null,
      importedBy:    req.user?.id || null,
    });
    res.json({ ok: (out.errors || []).length === 0, ...out });
  } catch (e) {
    console.error('[shippingRateAdmin] import/commit failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   GET /services /countries /surcharges ────────────────────────
async function _resolveVersionId(req) {
  const q = parseInt(req.query.versionId, 10);
  if (Number.isFinite(q)) return q;
  const active = await repo.getActiveVersion(getClient(), req.query.provider || 'eGS');
  return active ? active.id : null;
}

router.get('/services', async (req, res) => {
  try {
    const versionId = await _resolveVersionId(req);
    if (!versionId) return res.json({ ok: true, versionId: null, services: [] });
    const services = await repo.listServices(getClient(), versionId);
    res.json({ ok: true, versionId, services });
  } catch (e) {
    console.error('[shippingRateAdmin] services failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/countries', async (req, res) => {
  try {
    const versionId = await _resolveVersionId(req);
    if (!versionId) return res.json({ ok: true, versionId: null, countries: [] });
    const db = getClient();
    const r = await db
      .from('shipping_countries')
      .select('country_code, country_name, express_zone, is_eu, vat_rate, benchmark_service_code')
      .eq('rate_version_id', versionId)
      .order('country_code', { ascending: true });
    if (r.error) throw r.error;
    res.json({ ok: true, versionId, countries: r.data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/surcharges', async (req, res) => {
  try {
    const versionId = await _resolveVersionId(req);
    if (!versionId) return res.json({ ok: true, versionId: null, surcharges: [] });
    const db = getClient();
    const r = await db
      .from('shipping_surcharges')
      .select('id, rule_code, scope, value, unit, enabled, effective_from, effective_to, note')
      .eq('rate_version_id', versionId)
      .order('rule_code', { ascending: true });
    if (r.error) throw r.error;
    res.json({ ok: true, versionId, surcharges: r.data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /surcharges/:id — update value / enabled / note (weekly FSC entry).
router.post('/surcharges/:id', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const patch = {};
    if (req.body.value !== undefined) {
      const n = Number(req.body.value);
      if (!Number.isFinite(n)) return res.status(400).json({ ok: false, error: 'value must be numeric' });
      patch.value = n;
    }
    if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
    if (req.body.note    !== undefined) patch.note    = String(req.body.note).slice(0, 500);
    if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'no fields to update' });
    const db = getClient();
    const r = await db
      .from('shipping_surcharges')
      .update(patch)
      .eq('id', id)
      .select('id, rule_code, value, unit, enabled, note')
      .maybeSingle();
    if (r.error) throw r.error;
    res.json({ ok: true, surcharge: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /quote — single-quote tester (§10 admin surface). READ-ONLY.
router.post('/quote', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const out = await quoteService.calculateShippingQuote(req.body || {}, { supabase: getClient() });
    res.json(out);
  } catch (e) {
    console.error('[shippingRateAdmin] quote failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   POST /quote/batch — auto-listing dry-run. Body: { inputs:[...], provider }.
router.post('/quote/batch', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const inputs = Array.isArray(req.body?.inputs) ? req.body.inputs : [];
    if (inputs.length > 500) return res.status(400).json({ ok: false, error: 'batch max 500' });
    const out = await quoteService.calculateShippingQuotes(inputs, { supabase: getClient() });
    res.json({ ok: true, quotes: out });
  } catch (e) {
    console.error('[shippingRateAdmin] quote/batch failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   ─── Shipping policy bands (owner directive §8) ─────────────────
router.get('/policy-bands', async (_req, res) => {
  try {
    const db = getClient();
    const r = await db
      .from('shipping_policy_bands')
      .select('*')
      .order('marketplace', { ascending: true })
      .order('min_chargeable_weight_kg', { ascending: true })
      .limit(500);
    if (r.error) throw r.error;
    res.json({ ok: true, bands: r.data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/policy-bands', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.marketplace || !b.ebay_policy_id) {
      return res.status(400).json({ ok: false, error: 'marketplace and ebay_policy_id required' });
    }
    if (!b.destination_country && !b.destination_region) {
      return res.status(400).json({ ok: false, error: 'destination_country OR destination_region required' });
    }
    const payload = {
      marketplace:              String(b.marketplace),
      destination_country:      b.destination_country ? String(b.destination_country).toUpperCase() : null,
      destination_region:       b.destination_region ? String(b.destination_region).toUpperCase() : null,
      min_chargeable_weight_kg: Number(b.min_chargeable_weight_kg) || 0,
      max_chargeable_weight_kg: Number(b.max_chargeable_weight_kg) || 999,
      ebay_policy_id:           String(b.ebay_policy_id),
      policy_name:              b.policy_name ? String(b.policy_name) : null,
      buyer_shipping_fee_krw:   Number(b.buyer_shipping_fee_krw) || 0,
      active:                   b.active !== false,
      created_by:               req.user?.id || null,
      note:                     b.note ? String(b.note).slice(0, 500) : null,
    };
    const r = await getClient().from('shipping_policy_bands').insert(payload).select('*').single();
    if (r.error) throw r.error;
    res.json({ ok: true, band: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/policy-bands/:id', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (b.active !== undefined)              patch.active                   = !!b.active;
    if (b.buyer_shipping_fee_krw !== undefined) patch.buyer_shipping_fee_krw = Number(b.buyer_shipping_fee_krw) || 0;
    if (b.ebay_policy_id !== undefined)       patch.ebay_policy_id           = String(b.ebay_policy_id);
    if (b.policy_name !== undefined)          patch.policy_name              = b.policy_name ? String(b.policy_name) : null;
    if (b.note !== undefined)                 patch.note                     = b.note ? String(b.note).slice(0, 500) : null;
    const r = await getClient().from('shipping_policy_bands').update(patch).eq('id', id).select('*').maybeSingle();
    if (r.error) throw r.error;
    res.json({ ok: true, band: r.data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   ─── Shadow results (owner review of legacy-vs-new comparison) ──
//   Correction (2026-09-13): the /auto-listing-preview endpoint moved to
//   /api/internal/shipping/quote (server-to-server, token-authenticated).
//   Automation never calls a rate-admin URL anymore. What remains here is
//   the ADMIN owner-facing list/csv of past shadow results.
router.get('/shadow-results', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = req.query.status && ['ok','blocked'].includes(req.query.status) ? req.query.status : null;
    const country = req.query.country ? String(req.query.country).slice(0, 2).toUpperCase() : null;
    let q = getClient().from('shipping_quote_shadow_results')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status)  q = q.eq('status', status);
    if (country) q = q.eq('destination_country', country);
    const r = await q;
    if (r.error) throw r.error;
    res.json({ ok: true, total: r.count || 0, results: r.data || [], limit, offset });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/shadow-results/summary', async (_req, res) => {
  try {
    const db = getClient();
    const total = await db.from('shipping_quote_shadow_results').select('id', { count: 'exact', head: true });
    const blocked = await db.from('shipping_quote_shadow_results').select('id', { count: 'exact', head: true }).eq('status', 'blocked');
    if (total.error)   throw total.error;
    if (blocked.error) throw blocked.error;
    res.json({
      ok: true,
      total:   total.count || 0,
      blocked: blocked.count || 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

//   CSV download — owner review. Column order matches migration 115.
router.get('/shadow-results.csv', async (_req, res) => {
  try {
    const r = await getClient().from('shipping_quote_shadow_results')
      .select('*').order('created_at', { ascending: false }).limit(2000);
    if (r.error) throw r.error;
    const cols = [
      'id','listing_job_id','product_ref','marketplace','destination_country',
      'legacy_listing_price','new_listing_price','difference_amount','difference_pct',
      'legacy_shipping_cost','new_shipping_cost','chargeable_weight_kg',
      'service_code','rate_version_id','policy_band_id','status','blocked_reason','created_at',
    ];
    const rows = (r.data || []).map(row => cols.map(c => {
      const v = row[c];
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
    const csv = [cols.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shipping-shadow-results.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
