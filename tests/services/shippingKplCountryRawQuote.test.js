'use strict';

/**
 * tests/services/shippingKplCountryRawQuote.test.js — PMC SHIPPING QUOTE CONTRACT FIX (2026-09-14).
 *
 * Production audit (project tsqposttkfrvgkyhwade, SELECT only):
 *   · eGS active v3 → 202 shipping_countries rows
 *   · KPL active v4 → 0 rows, while KPL_SF_US (US × 39) / KPL_SF_JP (JP × 42) brackets exist
 *   · shippingQuoteService resolves the country inside the SAME rate_version_id →
 *     every KPL quote returned COUNTRY_NOT_IN_MASTER
 *   · /api/internal/shipping/quote went through autoListingPricingAdapter →
 *     shipping_policy_bands = 0 rows made top-level ok:false (NO_SHIPPING_POLICY)
 *
 * Locks in:
 *   A. importer stores provider-scoped countries (KPL → US, JP only; eGS 202 unchanged)
 *   C. /quote is a raw shipping-cost contract independent of policy bands / margin
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const http    = require('node:http');
const path    = require('node:path');

const REPO      = path.resolve(__dirname, '../..');
const WB_PATH   = path.join(REPO, 'data/shipping/CCOREA_통합배송비_기본데이터_v2.xlsx');
const importer  = require(path.join(REPO, 'src/services/shipping/rateMasterImporter'));

const ROUTE_JS      = require.resolve(path.join(REPO, 'src/web/routes/shippingInternal.js'));
const TOKEN_MW      = require.resolve(path.join(REPO, 'src/middleware/internalToken.js'));
const MOD_SB_CLIENT = require.resolve(path.join(REPO, 'src/db/supabaseClient.js'));
const MOD_REPO      = require.resolve(path.join(REPO, 'src/services/shipping/rateMasterRepository.js'));
const MOD_QUOTE     = require.resolve(path.join(REPO, 'src/services/shipping/shippingQuoteService.js'));
const MOD_ADAPTER   = require.resolve(path.join(REPO, 'src/services/shipping/autoListingPricingAdapter.js'));
const MOD_BANDS     = require.resolve(path.join(REPO, 'src/services/shipping/shippingPolicyBands.js'));
const MOD_RECORDER  = require.resolve(path.join(REPO, 'src/services/shipping/shadowRecorder.js'));

const OK_TOKEN = 'k'.repeat(40);

function loadWorkbookOrSkip(t) {
  if (!fs.existsSync(WB_PATH)) { t.skip('v2 workbook not present (gitignored)'); return null; }
  return fs.readFileSync(WB_PATH);
}

//   ─────────────────────────────────────────────────────────────
//   Capturing Supabase stub for importWorkbook
//   ─────────────────────────────────────────────────────────────
function makeImportClient({ existingVersions = [] } = {}) {
  const inserts = [];
  let nextVersionId = 100;
  let nextChildId = 1000;
  return {
    inserts,
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, val) { filters[col] = val; return chain; },
        maybeSingle: async () => {
          const hit = existingVersions.find(v =>
            v.provider === filters.provider && v.source_name === filters.source_name && v.effective_from === filters.effective_from);
          return { data: hit || null, error: null };
        },
        insert(rows) {
          const arr = Array.isArray(rows) ? rows : [rows];
          inserts.push({ table, rows: arr });
          const returned = table === 'shipping_rate_versions'
            ? arr.map(() => ({ id: nextVersionId++ }))
            : arr.map(() => ({ id: nextChildId++ }));
          return {
            select() {
              return {
                single: async () => ({ data: returned[0], error: null }),
                then(res, rej) { return Promise.resolve({ data: returned, error: null }).then(res, rej); },
              };
            },
          };
        },
        delete() { return { eq: async () => ({ data: null, error: null }) }; },
      };
      return chain;
    },
  };
}

function countriesInsertedFor(client, versionId) {
  return client.inserts
    .filter(i => i.table === 'shipping_countries')
    .flatMap(i => i.rows)
    .filter(r => r.rate_version_id === versionId);
}

//   ═════════════════════════════════════════════════════════════
//   A · importer — provider-scoped countries
//   ═════════════════════════════════════════════════════════════

test('D1 · KPL import version gets exactly US + JP countries (benchmarked to its own services)', async (t) => {
  const buf = loadWorkbookOrSkip(t); if (!buf) return;
  const client = makeImportClient();
  const out = await importer.importWorkbook(client, buf);
  assert.deepEqual(out.errors, []);
  const kpl = out.versions.find(v => v.provider === 'KPL');
  assert.ok(kpl && kpl.versionId, `KPL version must be created: ${JSON.stringify(out.versions)}`);
  assert.equal(kpl.rowCounts.countries, 2);
  const rows = countriesInsertedFor(client, kpl.versionId).sort((a, b) => a.country_code.localeCompare(b.country_code));
  assert.deepEqual(rows.map(r => [r.country_code, r.benchmark_service_code]), [['JP', 'KPL_SF_JP'], ['US', 'KPL_SF_US']]);
  //   Descriptive columns copied verbatim from 국가_Master (same values as production eGS v3 rows).
  assert.deepEqual(
    rows.map(({ country_code, country_name, express_zone, is_eu, vat_rate }) => ({ country_code, country_name, express_zone, is_eu, vat_rate })),
    [
      { country_code: 'JP', country_name: 'Japan', express_zone: 'P', is_eu: false, vat_rate: 0 },
      { country_code: 'US', country_name: 'U.S.',  express_zone: 'E', is_eu: false, vat_rate: 0 },
    ],
  );
  //   No workbook-only key leaks into the payload.
  assert.ok(rows.every(r => !('_rowNum' in r)));
});

test('D2 · KPL version receives NO other country (eGS 202-country master is not copied)', async (t) => {
  const buf = loadWorkbookOrSkip(t); if (!buf) return;
  const client = makeImportClient();
  const out = await importer.importWorkbook(client, buf);
  const kpl = out.versions.find(v => v.provider === 'KPL');
  const codes = countriesInsertedFor(client, kpl.versionId).map(r => r.country_code);
  assert.equal(codes.length, 2);
  for (const other of ['DE', 'GB', 'CA', 'AU', 'KR']) assert.ok(!codes.includes(other), `${other} must not be copied into KPL`);
});

test('D3 · eGS version keeps all 202 countries with workbook benchmarks; skipped providers create no version', async (t) => {
  const buf = loadWorkbookOrSkip(t); if (!buf) return;
  const client = makeImportClient();
  const out = await importer.importWorkbook(client, buf);
  const eGS = out.versions.find(v => v.provider === 'eGS');
  assert.equal(eGS.rowCounts.countries, 202);
  const us = countriesInsertedFor(client, eGS.versionId).find(r => r.country_code === 'US');
  assert.equal(us.benchmark_service_code, 'EGS_STD_US');
  //   SHIPTER / FedEx / KoreaPost: existing "no rate-loaded service → no version" rule.
  const skipped = out.versions.filter(v => v.skipped).map(v => v.provider).sort();
  assert.deepEqual(skipped, ['FedEx', 'KoreaPost', 'SHIPTER']);
  const versionInserts = client.inserts.filter(i => i.table === 'shipping_rate_versions').flatMap(i => i.rows.map(r => r.provider)).sort();
  assert.deepEqual(versionInserts, ['KPL', 'eGS']);
  //   Surcharges stay primary-only.
  const surchargeVersionIds = new Set(client.inserts.filter(i => i.table === 'shipping_surcharges').flatMap(i => i.rows.map(r => r.rate_version_id)));
  assert.deepEqual([...surchargeVersionIds], [eGS.versionId]);
});

test('D4 · re-import is idempotent per provider (full no-op; partial re-import only adds the new provider)', async (t) => {
  const buf = loadWorkbookOrSkip(t); if (!buf) return;
  const parsed = await importer.parseAndValidate(buf);
  const meta = (p) => { const v = parsed.versions.find(x => x.provider === p); return { id: p === 'eGS' ? 3 : 4, status: 'active', ...v }; };

  //   Both providers already imported → no child rows at all.
  const full = makeImportClient({ existingVersions: [meta('eGS'), meta('KPL')] });
  const outFull = await importer.importWorkbook(full, buf);
  assert.ok(outFull.versions.filter(v => !v.skipped).every(v => v.alreadyImported));
  assert.equal(full.inserts.length, 0);

  //   eGS already imported, KPL new → only KPL rows (with its 2 countries).
  const partial = makeImportClient({ existingVersions: [meta('eGS')] });
  const outPartial = await importer.importWorkbook(partial, buf);
  const kpl = outPartial.versions.find(v => v.provider === 'KPL');
  assert.equal(outPartial.versions.find(v => v.provider === 'eGS').alreadyImported, true);
  assert.equal(kpl.rowCounts.countries, 2);
  assert.deepEqual(partial.inserts.filter(i => i.table === 'shipping_countries').flatMap(i => i.rows.map(r => r.country_code)).sort(), ['JP', 'US']);

  //   Two fresh imports produce identical country payloads (reproducible without manual correction).
  const a = makeImportClient(); await importer.importWorkbook(a, buf);
  const b = makeImportClient(); await importer.importWorkbook(b, buf);
  const strip = (c) => c.inserts.filter(i => i.table === 'shipping_countries').map(i => i.rows.map(({ rate_version_id, ...r }) => r));
  assert.deepEqual(strip(a), strip(b));
});

test('D4b · selectCountriesForProvider generalizes: only bracket country keys, zone keys ignored, unknown keys reported', () => {
  const parsed = {
    primaryProviderForCountries: 'eGS',
    countries: [
      { country_code: 'US', country_name: 'U.S.', express_zone: 'E', is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_STD_US' },
      { country_code: 'DE', country_name: 'Germany', express_zone: 'M', is_eu: true, vat_rate: 0.19, benchmark_service_code: 'EGS_STD_EU_DE' },
      { country_code: 'FR', country_name: 'France', express_zone: 'M', is_eu: true, vat_rate: 0.2, benchmark_service_code: 'EGS_STD_EU_FR' },
    ],
    services: [
      { provider: 'NEWCO', service_code: 'NEWCO_EU', coverage: 'EU' },
      { provider: 'NEWCO', service_code: 'NEWCO_DE', coverage: 'DE' },
      { provider: 'ZONED', service_code: 'ZONED_X', coverage: 'GLOBAL' },
    ],
    brackets: [
      { provider: 'NEWCO', service_code: 'NEWCO_EU', country_key: 'DE' },
      { provider: 'NEWCO', service_code: 'NEWCO_DE', country_key: 'DE' },
      { provider: 'NEWCO', service_code: 'NEWCO_EU', country_key: 'fr' },
      { provider: 'NEWCO', service_code: 'NEWCO_EU', country_key: 'XX' },
      { provider: 'NEWCO', service_code: 'NEWCO_EU', country_key: '__ALL__' },
      { provider: 'ZONED', service_code: 'ZONED_X', country_key: '__ZONE__', zone_key: 'A' },
      { provider: 'eGS',   service_code: 'EGS_STD_US', country_key: 'US' },
    ],
  };
  const newco = importer.selectCountriesForProvider(parsed, 'NEWCO');
  assert.deepEqual(newco.countries.map(c => [c.country_code, c.benchmark_service_code, c.vat_rate]), [['DE', 'NEWCO_DE', 0.19], ['FR', 'NEWCO_EU', 0.2]]);
  assert.deepEqual(newco.missingCountryKeys, ['XX']);
  assert.deepEqual(importer.selectCountriesForProvider(parsed, 'ZONED'), { countries: [], missingCountryKeys: [] });
  assert.equal(importer.selectCountriesForProvider(parsed, 'eGS').countries.length, 3);
  //   Master rows are copied, never mutated.
  assert.equal(parsed.countries[1].benchmark_service_code, 'EGS_STD_EU_DE');
});

test('D14a · KPL version with its own-benchmark countries passes activation guard even when no eGS version is active', async () => {
  const client = {
    from(table) {
      const rows = {
        shipping_services:      [{ service_code: 'KPL_SF_US', rate_loaded: true, active: true, rate_version_id: 4 }, { service_code: 'KPL_SF_JP', rate_loaded: true, active: true, rate_version_id: 4 }],
        shipping_rate_brackets: [{ service_code: 'KPL_SF_US' }, { service_code: 'KPL_SF_JP' }],
        shipping_countries:     [{ country_code: 'US', benchmark_service_code: 'KPL_SF_US' }, { country_code: 'JP', benchmark_service_code: 'KPL_SF_JP' }],
        shipping_rate_versions: [],
      }[table] || [];
      const chain = {
        select() { return chain; }, eq() { return chain; }, in() { return chain; },
        range: async (from) => ({ data: from === 0 ? rows : [], error: null }),
        then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
      };
      return chain;
    },
  };
  await importer.assertVersionActivatable(client, 4);
});

//   ═════════════════════════════════════════════════════════════
//   C · raw internal quote (real route + real quote engine + fixture repo)
//   ═════════════════════════════════════════════════════════════

const EGS_V = 3;
const KPL_V = 4;

function buildFixtureRepo() {
  const services = [
    { _v: EGS_V, service_code: 'EGS_STD_US', service_name: 'eGS Standard - US', vol_divisor: 6000, sale_type: 'B2C', rate_loaded: true, perkg_surcharge_krw: 2000, active: true },
    { _v: KPL_V, provider: 'KPL', service_code: 'KPL_SF_US', service_name: 'KPL SF Express US', vol_divisor: 6000, sale_type: 'B2C', rate_loaded: true, perkg_surcharge_krw: 0, active: true, coverage: 'US' },
    { _v: KPL_V, provider: 'KPL', service_code: 'KPL_SF_JP', service_name: 'KPL SF Express JP', vol_divisor: 6000, sale_type: 'B2C', rate_loaded: true, perkg_surcharge_krw: 0, active: true, coverage: 'JP' },
  ];
  const master = [
    { country_code: 'US', country_name: 'U.S.', express_zone: 'E', is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_STD_US' },
    { country_code: 'JP', country_name: 'Japan', express_zone: 'P', is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_EXPRESS' },
    { country_code: 'DE', country_name: 'Germany', express_zone: 'M', is_eu: true, vat_rate: 0.19, benchmark_service_code: 'EGS_STD_EU_DE' },
  ];
  const brackets = [
    { _v: EGS_V, provider: 'eGS', service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 16100 },
    { _v: EGS_V, provider: 'eGS', service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.6, base_rate: 17400 },
    { _v: KPL_V, provider: 'KPL', service_code: 'KPL_SF_US', country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 13900 },
    { _v: KPL_V, provider: 'KPL', service_code: 'KPL_SF_US', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 18900 },
    { _v: KPL_V, provider: 'KPL', service_code: 'KPL_SF_JP', country_key: 'JP', zone_key: null, weight_to_kg: 0.5, base_rate: 6450 },
  ];
  //   Countries per version produced by the SAME importer rule used in production imports.
  const parsed = { primaryProviderForCountries: 'eGS', countries: master, services: services.map(s => ({ provider: s.provider || 'eGS', ...s })), brackets };
  const countries = [
    ...importer.selectCountriesForProvider(parsed, 'eGS').countries.map(c => ({ ...c, _v: EGS_V })),
    ...importer.selectCountriesForProvider(parsed, 'KPL').countries.map(c => ({ ...c, _v: KPL_V })),
  ];
  const versions = {
    eGS: { id: EGS_V, provider: 'eGS', effective_from: '2026-09-01', status: 'active' },
    KPL: { id: KPL_V, provider: 'KPL', effective_from: '2026-09-13', status: 'active' },
  };
  const calls = { getCountry: [], findApplicableBand: 0 };
  const repo = {
    async getActiveVersion(_s, provider = 'eGS') { return versions[provider] || null; },
    async listServices(_s, v) { return services.filter(s => s._v === v); },
    async getService(_s, v, code) { return services.find(s => s._v === v && s.service_code === code) || null; },
    async getCountry(_s, v, code) {
      calls.getCountry.push([v, code]);
      return countries.find(c => c._v === v && c.country_code === String(code || '').toUpperCase()) || null;
    },
    async findApplicableBracket(_s, v, code, { chargeableKg, countryCode }) {
      const rows = brackets.filter(b => b._v === v && b.service_code === code && b.weight_to_kg >= chargeableKg).sort((a, b) => a.weight_to_kg - b.weight_to_kg);
      return rows.find(r => r.country_key === String(countryCode || '').toUpperCase()) || null;
    },
    async listEnabledSurcharges() { return []; },
  };
  return { repo, calls, countries };
}

function buildApp(fixture) {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  for (const mod of [ROUTE_JS, TOKEN_MW, MOD_SB_CLIENT, MOD_REPO, MOD_QUOTE, MOD_ADAPTER, MOD_BANDS, MOD_RECORDER]) delete require.cache[mod];
  const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  stub(MOD_SB_CLIENT, { getClient: () => ({ from() { throw new Error('test: DB must not be touched directly'); } }) });
  stub(MOD_REPO, fixture.repo);
  //   shipping_policy_bands has 0 rows in production.
  stub(MOD_BANDS, { findApplicableBand: async () => { fixture.calls.findApplicableBand++; return null; } });
  stub(MOD_RECORDER, { recordShadowResult: async () => ({ id: 1, deduped: false }) });

  const express = require('express');
  const app = express();
  app.use('/api/internal/shipping', require(ROUTE_JS));
  app.use((_req, res) => res.status(401).json({ error: 'Authentication required' }));
  return app;
}

async function withApp(fixture, fn) {
  const server = await new Promise((resolve) => { const s = buildApp(fixture).listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

function post(port, p, { body = {}, headers = { Authorization: `Bearer ${OK_TOKEN}` } } = {}) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ statusCode: res.statusCode, raw: text, json });
      });
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

const QUOTE = '/api/internal/shipping/quote';
const PREVIEW = '/api/internal/shipping/listing-preview';

test('D5 · KPL US 0.5kg → 200 ok:true, KPL_SF_US 13,900원 (policy bands 0 rows)', async () => {
  const fixture = buildFixtureRepo();
  await withApp(fixture, async (port) => {
    const r = await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 0, widthCm: 0, heightCm: 0, saleType: 'B2C', marketplace: 'ebay' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'raw');
    assert.equal(r.json.blockedReason, null);
    assert.equal(r.json.quote.ok, true);
    assert.equal(r.json.quote.totalShippingCostKrw, 13900);
    assert.equal(r.json.quote.appliedWeightBracketKg, 0.5);
    assert.equal(r.json.quote.rateVersionId, KPL_V);
  });
  assert.equal(fixture.calls.findApplicableBand, 0, 'raw quote must never consult policy bands');
});

test('D6 · KPL JP 0.5kg → 200 ok:true, KPL_SF_JP 6,450원', async () => {
  await withApp(buildFixtureRepo(), async (port) => {
    const r = await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'KPL_SF_JP', destinationCountry: 'JP', actualWeightKg: 0.5, saleType: 'B2C' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.quote.totalShippingCostKrw, 6450);
  });
});

test('D7 · KPL DE → COUNTRY_NOT_IN_MASTER (KPL scope stays US/JP)', async () => {
  await withApp(buildFixtureRepo(), async (port) => {
    const r = await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'DE', actualWeightKg: 0.5, saleType: 'B2C' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.blockedReason, 'COUNTRY_NOT_IN_MASTER');
    assert.equal(r.json.quote.ok, false);
  });
});

test('D8 · policy bands 0 rows: /quote ok:true while /listing-preview still reports NO_SHIPPING_POLICY', async () => {
  const fixture = buildFixtureRepo();
  await withApp(fixture, async (port) => {
    const body = { provider: 'eGS', serviceCode: 'EGS_STD_US', destinationCountry: 'US', actualWeightKg: 0.5, saleType: 'B2C', marketplace: 'ebay', productCostKrw: 12000, platformFeeRate: 0.13, targetMarginRate: 0.2 };
    const raw = await post(port, QUOTE, { body });
    assert.equal(raw.json.ok, true);
    assert.equal(raw.json.quote.totalShippingCostKrw, 17100);
    assert.equal('listingItemPrice' in raw.json, false, 'raw quote carries no listing price fields');
    assert.equal('policyBand' in raw.json, false);
    assert.equal(fixture.calls.findApplicableBand, 0);

    const preview = await post(port, PREVIEW, { body });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json.ok, false);
    assert.equal(preview.json.mode, 'shadow');
    assert.equal(preview.json.listingBlockedReason, 'NO_SHIPPING_POLICY');
    assert.equal(fixture.calls.findApplicableBand, 1);
  });
});

test('D9 · quote failure → HTTP 200 with top-level ok:false + blockedReason; engine exception → 500 internal_quote_failed', async () => {
  const fixture = buildFixtureRepo();
  await withApp(fixture, async (port) => {
    const over = await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 25, saleType: 'B2C' } });
    assert.deepEqual([over.statusCode, over.json.ok, over.json.blockedReason], [200, false, 'WEIGHT_OVER_MAX_BRACKET']);

    const noVersion = await post(port, QUOTE, { body: { provider: 'SHIPTER', serviceCode: 'SHIPTER_X', destinationCountry: 'US', actualWeightKg: 0.5 } });
    assert.deepEqual([noVersion.json.ok, noVersion.json.blockedReason], [false, 'RATE_NOT_LOADED']);
  });
  fixture.repo.getActiveVersion = async () => { throw new Error('db down'); };
  await withApp(fixture, async (port) => {
    const r = await post(port, QUOTE, { body: { provider: 'eGS', destinationCountry: 'US', actualWeightKg: 0.5 } });
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.json, { ok: false, error: 'internal_quote_failed' });
    assert.ok(!r.raw.includes('db down'));
  });
});

test('D10 · token missing / wrong / env unset keep existing responses on /quote and /listing-preview', async () => {
  await withApp(buildFixtureRepo(), async (port) => {
    for (const p of [QUOTE, PREVIEW]) {
      const missing = await post(port, p, { headers: {} });
      assert.deepEqual([missing.statusCode, missing.json.error], [401, 'INVALID_INTERNAL_TOKEN']);
      const wrong = await post(port, p, { headers: { Authorization: `Bearer ${'w'.repeat(40)}` } });
      assert.deepEqual([wrong.statusCode, wrong.json.error], [401, 'INVALID_INTERNAL_TOKEN']);
      assert.ok(!wrong.raw.includes(OK_TOKEN) && !wrong.raw.includes('w'.repeat(40)));
    }
    delete process.env.SHIPPING_QUOTE_INTERNAL_TOKEN;
    const unset = await post(port, QUOTE);
    assert.deepEqual([unset.statusCode, unset.json.error], [503, 'INTERNAL_TOKEN_NOT_CONFIGURED']);
    process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  });
});

test('D11 · admin session cookie cannot reach the internal quote routes', async () => {
  await withApp(buildFixtureRepo(), async (port) => {
    for (const p of [QUOTE, PREVIEW]) {
      const r = await post(port, p, { headers: { Cookie: 'pmc_session=admin-session-value; connect.sid=abc' }, body: { provider: 'KPL', destinationCountry: 'US', actualWeightKg: 0.5 } });
      assert.equal(r.statusCode, 401);
      assert.equal(r.json.error, 'INVALID_INTERNAL_TOKEN');
    }
  });
});

test('D13 · eGS US 0.5kg 20×15×10 → 17,100원 (§11 sample) through the raw route', async () => {
  await withApp(buildFixtureRepo(), async (port) => {
    const r = await post(port, QUOTE, { body: { provider: 'eGS', serviceCode: 'EGS_STD_US', destinationCountry: 'US', actualWeightKg: 0.5, lengthCm: 20, widthCm: 15, heightCm: 10, saleType: 'B2C' } });
    assert.equal(r.json.ok, true);
    assert.equal(r.json.quote.chargeableWeightKg, 0.5);
    assert.equal(r.json.quote.baseRateKrw, 16100);
    assert.equal(r.json.quote.demandSurchargeKrw, 1000);
    assert.equal(r.json.quote.totalShippingCostKrw, 17100);
    assert.equal(r.json.quote.rateVersionId, EGS_V);
  });
});

test('D14 · provider active-version isolation: country lookups stay inside each provider version', async () => {
  const fixture = buildFixtureRepo();
  await withApp(fixture, async (port) => {
    await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 0.5 } });
    await post(port, QUOTE, { body: { provider: 'eGS', serviceCode: 'EGS_STD_US', destinationCountry: 'US', actualWeightKg: 0.5 } });
    //   eGS service code requested against the KPL version must not resolve.
    const cross = await post(port, QUOTE, { body: { provider: 'KPL', serviceCode: 'EGS_STD_US', destinationCountry: 'US', actualWeightKg: 0.5 } });
    assert.deepEqual([cross.json.ok, cross.json.blockedReason], [false, 'SERVICE_NOT_IN_MASTER']);
    //   KPL LISTING quote without serviceCode resolves to its own benchmark (KPL_SF_US), never an eGS service.
    const bench = await post(port, QUOTE, { body: { provider: 'KPL', destinationCountry: 'US', actualWeightKg: 0.5 } });
    assert.deepEqual([bench.json.ok, bench.json.quote.serviceCode], [true, 'KPL_SF_US']);
  });
  assert.deepEqual(fixture.calls.getCountry.slice(0, 3), [[KPL_V, 'US'], [EGS_V, 'US'], [KPL_V, 'US']]);
  assert.equal(fixture.countries.filter(c => c._v === EGS_V).length, 3);
  assert.deepEqual(fixture.countries.filter(c => c._v === KPL_V).map(c => c.country_code).sort(), ['JP', 'US']);
});

test('raw quote ignores listing-price inputs (whitelist)', () => {
  delete require.cache[ROUTE_JS];
  const { pickRawQuoteInput } = require(ROUTE_JS);
  const input = pickRawQuoteInput({
    provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 1.023, lengthCm: 0, widthCm: 0, heightCm: 0, saleType: 'B2C', marketplace: 'ebay',
    productCostKrw: 19500, platformFeeRate: 0.13, targetMarginRate: 0.2, sellingCurrencyKrwRate: 1300, shippingPolicyFeeKrw: 10000, quotePurpose: 'weird',
  });
  assert.deepEqual(input, { provider: 'KPL', serviceCode: 'KPL_SF_US', destinationCountry: 'US', actualWeightKg: 1.023, lengthCm: 0, widthCm: 0, heightCm: 0, saleType: 'B2C', marketplace: 'ebay', quotePurpose: 'LISTING' });
  assert.deepEqual(pickRawQuoteInput(['x']), { quotePurpose: 'LISTING' });
});
