'use strict';

/**
 * tests/services/shippingImportUiSchema.test.js — PMC-CCOREA-SHIPPING-1B
 * (2026-09-13 · import UI provider-error fix).
 *
 * Locks in the fix for the owner-reported error:
 *   "Cannot read properties of undefined (reading 'provider')"
 * seen when uploading v2 workbook via the production admin console.
 *
 * Root cause: importer refactor (ac553f2) began returning per-provider
 * `versions[]` (plural), but preview route still emitted `version: parsed.version`
 * (singular · undefined) and the SPA read `jP.version.provider`.
 *
 * This suite verifies BOTH ends of the contract:
 *
 *   Level A · Backend response shape (runtime, stubbed importer)
 *     A1  preview  → returns versions[]  (never `version` singular)
 *     A2  commit   → returns created[] + skipped[] derived from importer.versions[]
 *     A3  commit   → alreadyImported flag carried through per created entry
 *     A4  commit   → SHIPTER/FedEx/KoreaPost land in skipped[] with reason
 *     A5  preview  → parse failure returns { ok:false, errors[] } — no versions dereferenced
 *     A6  commit   → importer throw becomes 500 { ok:false, error }
 *
 *   Level B · Frontend consumer safety (source-level guarantees)
 *     B1  onUpload reads `versions` (plural) never `version.provider` (singular)
 *     B2  commit handler reads `created` and `skipped` (never stale flat fields)
 *     B3  in-flight guard prevents concurrent uploads
 *     B4  input.disabled reset in finally (never leaves button dead)
 *     B5  loadVersions() invoked after commit success (list auto-refreshes)
 *     B6  malformed JSON body shows a user error (not a stack trace)
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const http    = require('node:http');
const path    = require('node:path');

const REPO         = path.resolve(__dirname, '../..');
const ROUTE_JS     = path.join(REPO, 'src/web/routes/shippingRateAdmin.js');
const SPA_JS       = path.join(REPO, 'public/js/shippingRateAdmin.js');
const MOD_IMPORTER = require.resolve(path.join(REPO, 'src/services/shipping/rateMasterImporter'));
const MOD_AUTH     = require.resolve(path.join(REPO, 'src/middleware/auth'));
const MOD_SB       = require.resolve(path.join(REPO, 'src/db/supabaseClient'));
const MOD_QUOTE_SVC   = require.resolve(path.join(REPO, 'src/services/shipping/shippingQuoteService'));
const MOD_REPO        = require.resolve(path.join(REPO, 'src/services/shipping/rateMasterRepository'));
const MOD_BANDS       = require.resolve(path.join(REPO, 'src/services/shipping/shippingPolicyBands'));
const MOD_ADAPTER     = require.resolve(path.join(REPO, 'src/services/shipping/autoListingPricingAdapter'));

//   ─────────────────────────────────────────────────────────────
//   Level A · runtime backend tests
//   ─────────────────────────────────────────────────────────────

let _importerStub = null;
function _passthroughMiddleware(_req, _res, next) { next(); }

function buildRouteApp(stub) {
  _importerStub = stub;
  //   Stub every dependency the router pulls in so we can require the module
  //   under test without needing a database or a session.
  const stubs = [
    [MOD_AUTH,        { requireAdmin: _passthroughMiddleware }],
    [MOD_SB,          { getClient: () => ({ from() { throw new Error('stub: DB not used'); } }) }],
    [MOD_IMPORTER,    _importerStub],
    [MOD_QUOTE_SVC,   { calculateQuotes: async () => [] }],
    [MOD_REPO,        {
      getActiveVersion: async () => null,
      listServices:     async () => [],
    }],
    [MOD_BANDS,       {
      listBands: async () => [],
      upsertBand: async () => ({}),
      deleteBand: async () => ({}),
    }],
    [MOD_ADAPTER,     {
      listShadowResults: async () => ({ total: 0, results: [] }),
    }],
  ];
  for (const [id, exp] of stubs) {
    delete require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports: exp };
  }
  delete require.cache[require.resolve(ROUTE_JS)];

  const express = require('express');
  const app = express();
  app.use('/api/shipping/rate-admin', require(ROUTE_JS));
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function multipart(fieldName, filename, content) {
  const boundary = '----claudetest' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`,
    'utf8'
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function postFile({ port, path: p, filename = 'workbook.xlsx', content = 'stub' }) {
  const { body, contentType } = multipart('workbook', filename, content);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function withApp(stub, fn) {
  const app = buildRouteApp(stub);
  const server = await listen(app);
  const port = server.address().port;
  try { return await fn(port); }
  finally { await new Promise((r) => server.close(r)); }
}

test('UI-SCHEMA-A1 · preview returns versions[] (plural, never singular `version`)', async () => {
  await withApp({
    parseAndValidate: async () => ({
      ok: true,
      versions: [
        { provider: 'eGS',      source_name: 'CCOREA_v2', effective_from: '2026-09-13', note: null },
        { provider: 'KPL',      source_name: 'CCOREA_v2', effective_from: '2026-09-13', note: null },
        { provider: 'SHIPTER',  source_name: 'CCOREA_v2', effective_from: null,          note: 'no brackets' },
      ],
      primaryProviderForCountries: 'eGS',
      services: new Array(62), countries: new Array(202), brackets: new Array(3957), surcharges: new Array(8),
      errors: [], warnings: [],
    }),
    importWorkbook: async () => ({ versions: [], errors: [], warnings: [] }),
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/preview' });
    assert.equal(r.statusCode, 200, `body=${r.raw.slice(0, 200)}`);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.versions), 'versions must be an array');
    assert.equal(r.json.versions.length, 3);
    assert.equal(r.json.versions[0].provider, 'eGS');
    //   The singular field that broke the SPA MUST NOT be present.
    assert.equal(r.json.version, undefined, 'preview response must NOT carry singular `version`');
    assert.equal(r.json.primaryProviderForCountries, 'eGS');
    assert.equal(r.json.counts.services,   62);
    assert.equal(r.json.counts.countries,  202);
    assert.equal(r.json.counts.brackets,   3957);
    assert.equal(r.json.counts.surcharges, 8);
  });
});

test('UI-SCHEMA-A2 · commit returns created[] + skipped[] derived from importer.versions[]', async () => {
  await withApp({
    parseAndValidate: async () => ({ ok: true, versions: [], services: [], countries: [], brackets: [], surcharges: [], errors: [], warnings: [] }),
    importWorkbook: async () => ({
      versions: [
        { provider: 'eGS', versionId: 101, alreadyImported: false, rowCounts: { services: 40, countries: 200, brackets: 3200, surcharges: 8 } },
        { provider: 'KPL', versionId: 102, alreadyImported: false, rowCounts: { services: 22, countries: 0,   brackets: 757,  surcharges: 0 } },
        { provider: 'SHIPTER',   skipped: true, reason: 'no rate loaded' },
        { provider: 'FedEx',     skipped: true, reason: 'no rate loaded' },
        { provider: 'KoreaPost', skipped: true, reason: 'no rate loaded' },
      ],
      errors: [], warnings: ['some warning'],
    }),
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/commit' });
    assert.equal(r.statusCode, 200, `body=${r.raw.slice(0, 200)}`);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.created) && r.json.created.length === 2, `created=${JSON.stringify(r.json.created)}`);
    assert.ok(Array.isArray(r.json.skipped) && r.json.skipped.length === 3);
    const eGS = r.json.created.find(x => x.provider === 'eGS');
    assert.ok(eGS && eGS.versionId === 101 && eGS.rowCounts && eGS.rowCounts.brackets === 3200);
    const skipShipter = r.json.skipped.find(x => x.provider === 'SHIPTER');
    assert.ok(skipShipter && skipShipter.reason === 'no rate loaded');
    //   Stale flat fields (from the pre-refactor singular schema) MUST NOT
    //   appear at the top level of the commit response.
    assert.equal(r.json.versionId,       undefined);
    assert.equal(r.json.alreadyImported, undefined);
    assert.equal(r.json.rowCounts,       undefined);
  });
});

test('UI-SCHEMA-A3 · commit propagates alreadyImported per-provider (no duplicate-run false success)', async () => {
  await withApp({
    parseAndValidate: async () => ({ ok: true, versions: [], services: [], countries: [], brackets: [], surcharges: [], errors: [], warnings: [] }),
    importWorkbook: async () => ({
      versions: [
        { provider: 'eGS', versionId: 101, alreadyImported: true, rowCounts: { services: 0, countries: 0, brackets: 0, surcharges: 0 } },
        { provider: 'KPL', versionId: 102, alreadyImported: false, rowCounts: { services: 22, countries: 0, brackets: 757, surcharges: 0 } },
      ],
      errors: [], warnings: [],
    }),
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/commit' });
    assert.equal(r.statusCode, 200);
    const eGS = r.json.created.find(x => x.provider === 'eGS');
    const KPL = r.json.created.find(x => x.provider === 'KPL');
    assert.equal(eGS.alreadyImported, true,  'eGS must be marked alreadyImported');
    assert.equal(KPL.alreadyImported, false, 'KPL must NOT be marked alreadyImported');
  });
});

test('UI-SCHEMA-A4 · commit places every skipped provider in skipped[] with reason', async () => {
  await withApp({
    parseAndValidate: async () => ({ ok: true, versions: [], services: [], countries: [], brackets: [], surcharges: [], errors: [], warnings: [] }),
    importWorkbook: async () => ({
      versions: [
        { provider: 'SHIPTER',   skipped: true, reason: 'no rate loaded' },
        { provider: 'FedEx',     skipped: true, reason: 'no rate loaded' },
        { provider: 'KoreaPost', skipped: true, reason: 'no rate loaded' },
      ],
      errors: [], warnings: [],
    }),
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/commit' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json.created.length, 0);
    assert.equal(r.json.skipped.length, 3);
    for (const s of r.json.skipped) {
      assert.ok(['SHIPTER', 'FedEx', 'KoreaPost'].includes(s.provider));
      assert.equal(s.reason, 'no rate loaded');
    }
  });
});

test('UI-SCHEMA-A5 · preview parse failure surfaces errors[] cleanly (no dereferencing undefined `versions`)', async () => {
  await withApp({
    parseAndValidate: async () => ({
      ok: false,
      errors: ['xlsx parse failed: bad zip'],
      warnings: [],
      //   Deliberately omit `versions` — the route MUST cope.
    }),
    importWorkbook: async () => ({ versions: [], errors: [], warnings: [] }),
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/preview' });
    assert.equal(r.statusCode, 200, `body=${r.raw.slice(0, 200)}`);
    assert.equal(r.json.ok, false);
    assert.ok(Array.isArray(r.json.versions),  'versions must still be an array (possibly empty)');
    assert.equal(r.json.versions.length, 0);
    assert.ok(r.json.errors.length >= 1);
    assert.match(r.json.errors[0], /xlsx parse failed/);
  });
});

test('UI-SCHEMA-A6 · commit importer throw becomes 500 { ok:false, error }', async () => {
  await withApp({
    parseAndValidate: async () => ({ ok: true, versions: [], services: [], countries: [], brackets: [], surcharges: [], errors: [], warnings: [] }),
    importWorkbook: async () => { throw new Error('DB unavailable'); },
  }, async (port) => {
    const r = await postFile({ port, path: '/api/shipping/rate-admin/import/commit' });
    assert.equal(r.statusCode, 500);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /DB unavailable/);
    //   No success-shaped fields — must never leak a partial success illusion.
    assert.equal(r.json.created, undefined);
    assert.equal(r.json.skipped, undefined);
  });
});

//   ─────────────────────────────────────────────────────────────
//   Level B · frontend consumer safety (source-level)
//   ─────────────────────────────────────────────────────────────
//   These lock in the exact patterns the SPA relies on so a future
//   refactor cannot silently reintroduce the `undefined.provider` bug.

const _spaSrc = () => fs.readFileSync(SPA_JS, 'utf8');

test('UI-SCHEMA-B1 · onUpload reads versions[] (plural) never version.provider (singular)', () => {
  const src = _spaSrc();
  //   The singular pattern is what broke production. It must not return.
  assert.ok(!/jP\.version\.provider/.test(src),
    'SPA MUST NOT read jP.version.provider (singular field is gone)');
  assert.ok(!/jP\.version\.source_name/.test(src),
    'SPA MUST NOT read jP.version.source_name');
  assert.ok(!/jP\.version\.effective_from/.test(src),
    'SPA MUST NOT read jP.version.effective_from');
  //   The plural read MUST be present.
  assert.ok(/jP\.versions/.test(src),
    'SPA MUST read jP.versions (plural array)');
  //   And it must guard with Array.isArray to survive malformed responses.
  assert.ok(/Array\.isArray\(jP\.versions\)/.test(src),
    'SPA MUST guard jP.versions with Array.isArray');
});

test('UI-SCHEMA-B2 · commit handler reads created[] + skipped[] never stale flat fields', () => {
  const src = _spaSrc();
  assert.ok(/jC\.created/.test(src),  'SPA MUST read jC.created');
  assert.ok(/jC\.skipped/.test(src),  'SPA MUST read jC.skipped');
  //   Stale flat fields must not be dereferenced at commit time.
  assert.ok(!/jC\.alreadyImported/.test(src),
    'SPA MUST NOT read jC.alreadyImported (moved into created[] entries)');
  assert.ok(!/jC\.versionId\b/.test(src),
    'SPA MUST NOT read jC.versionId flat (moved into created[] entries)');
  assert.ok(!/jC\.rowCounts\b/.test(src),
    'SPA MUST NOT read jC.rowCounts flat (moved into created[] entries)');
});

test('UI-SCHEMA-B3 · in-flight guard prevents concurrent uploads (double-click safety)', () => {
  const src = _spaSrc();
  assert.ok(/_uploadInFlight/.test(src),
    'SPA MUST declare an in-flight guard flag');
  assert.ok(/_uploadInFlight\s*=\s*true/.test(src),
    'SPA MUST set the flag before beginning fetch');
  assert.ok(/_uploadInFlight\s*=\s*false/.test(src),
    'SPA MUST clear the flag in finally');
});

test('UI-SCHEMA-B4 · input disabled/re-enabled around the request (never leaves button dead)', () => {
  const src = _spaSrc();
  //   The upload button is <input id="sra-upload"> in the shipping-rate-admin page.
  assert.ok(/inputEl\.disabled\s*=\s*true/.test(src),
    'SPA MUST disable the upload input while a request is in flight');
  assert.ok(/inputEl\.disabled\s*=\s*false/.test(src),
    'SPA MUST re-enable the input in finally');
  //   finally-block is where the re-enable must live so a thrown error
  //   never leaves the button dead.
  assert.ok(/finally\s*\{[\s\S]{0,400}inputEl\.disabled\s*=\s*false/.test(src),
    'SPA MUST re-enable the input inside a finally block');
});

test('UI-SCHEMA-B5 · loadVersions() invoked after commit success (list auto-refreshes)', () => {
  const src = _spaSrc();
  //   The versions list must refresh once a commit succeeds so the owner sees
  //   the just-created rows without a manual reload.
  assert.ok(/loadVersions\s*\(/.test(src),
    'SPA MUST call loadVersions() after commit success');
  //   And it must be awaited (or explicitly not) inside the success path,
  //   AFTER the created/skipped rendering.
  assert.ok(/await\s+loadVersions\s*\(|loadVersions\s*\(\)\s*\./.test(src),
    'SPA SHOULD await loadVersions to serialize the reload');
});

test('UI-SCHEMA-B6 · malformed JSON body shows a user error (no stack trace leak)', () => {
  const src = _spaSrc();
  //   The rewritten handler wraps res.json() in a try/catch and re-checks
  //   the parsed body is an object before dereferencing anything.
  assert.ok(/typeof\s+jP\s*!==?\s*['"]object['"]/.test(src) || /!jP\s*\|\|\s*typeof\s+jP/.test(src),
    'SPA MUST guard against a non-object preview body');
  assert.ok(/typeof\s+jC\s*!==?\s*['"]object['"]/.test(src) || /!jC\s*\|\|\s*typeof\s+jC/.test(src),
    'SPA MUST guard against a non-object commit body');
  //   The user-visible error must be Korean-styled (owner directive UI language).
  assert.ok(/예상하지 못한 응답/.test(src),
    'SPA MUST surface a Korean "unexpected response" error to the user');
});
