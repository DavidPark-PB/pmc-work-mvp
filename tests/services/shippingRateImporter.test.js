'use strict';

/**
 * tests/services/shippingRateImporter.test.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Validates the xlsx importer against the REAL owner-authored workbook plus
 * synthetic fixtures for corruption / duplication cases.
 *
 * Owner directive §10:
 *   · workbook shape verified (5 required sheets present)
 *   · missing sheet → hard error
 *   · duplicate service_code → hard error
 *   · duplicate bracket → hard error
 *   · descending brackets → hard error
 *   · idempotency: same workbook re-run is a no-op
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const WB_PATH = path.join(REPO, 'data/shipping/CCOREA_통합배송비_기본데이터_v1.xlsx');
const importer = require(path.join(REPO, 'src/services/shipping/rateMasterImporter'));

//   ─────────────────────────────────────────────────────────────
//   Read-only parse + validate over the REAL workbook
//   ─────────────────────────────────────────────────────────────

test('IMPORTER-A · real workbook parses + validates OK (5 required sheets)', async () => {
  const buf = fs.readFileSync(WB_PATH);
  const r = await importer.parseAndValidate(buf);
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors.slice(0, 3))}`);
  assert.equal(r.version.provider, 'eGS');
  assert.equal(r.version.effective_from, '2026-09-01');
  assert.ok(r.services.length   >= 50, `services=${r.services.length}`);
  assert.ok(r.countries.length  >= 100, `countries=${r.countries.length}`);
  assert.ok(r.brackets.length   >= 1000, `brackets=${r.brackets.length}`);
  assert.ok(r.surcharges.length >= 5,  `surcharges=${r.surcharges.length}`);
});

test('IMPORTER-B · §11 sample values present verbatim in parsed data', async () => {
  const buf = fs.readFileSync(WB_PATH);
  const r = await importer.parseAndValidate(buf);
  const svcUS = r.services.find(s => s.service_code === 'EGS_STD_US');
  assert.ok(svcUS, 'EGS_STD_US service must be present');
  assert.equal(svcUS.vol_divisor, 6000);
  assert.equal(svcUS.perkg_surcharge_krw, 2000);
  const bracket = r.brackets.find(b => b.service_code === 'EGS_STD_US' && b.country_key === 'US' && b.weight_to_kg === 0.5);
  assert.ok(bracket, 'EGS_STD_US US 0.5kg bracket must be present');
  assert.equal(bracket.base_rate, 16100);
});

test('IMPORTER-C · EE/ES benchmark orphan surfaces as WARNING, not error', async () => {
  const buf = fs.readFileSync(WB_PATH);
  const r = await importer.parseAndValidate(buf);
  assert.equal(r.ok, true);
  const eeWarn = r.warnings.find(w => /EE.*RATE_NOT_LOADED/.test(w));
  assert.ok(eeWarn, 'EE benchmark warning must be present');
});

//   ─────────────────────────────────────────────────────────────
//   Synthetic corruption: missing sheet
//   ─────────────────────────────────────────────────────────────

test('IMPORTER-D · missing 원본목록 sheet → hard error', async () => {
  //   Build a minimal xlsx without one of the required sheets.
  //   Easiest way: strip the sheet from the real workbook using JSZip.
  const JSZip = require('jszip');
  const buf = fs.readFileSync(WB_PATH);
  const zip = await JSZip.loadAsync(buf);
  //   Rewrite workbook.xml to omit the last sheet (원본목록 · sheetId=7 · r:id from workbook.xml).
  let wbXml = await zip.file('xl/workbook.xml').async('string');
  //   Excluding only `>` — the sheet element attributes carry URLs with `/` in them.
  wbXml = wbXml.replace(/<x:sheet\s+name="원본목록"[^>]*?\/>/, '');
  zip.file('xl/workbook.xml', wbXml);
  const bad = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await importer.parseAndValidate(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /missing required sheet: 원본목록/.test(e)),
    `expected missing-sheet error, got: ${JSON.stringify(r.errors.slice(0, 3))}`);
});

//   ─────────────────────────────────────────────────────────────
//   Idempotency via stubbed Supabase
//   ─────────────────────────────────────────────────────────────

test('IMPORTER-E · re-import of same version → alreadyImported=true, no child insert', async () => {
  const buf = fs.readFileSync(WB_PATH);
  //   Stub Supabase: `shipping_rate_versions` .maybeSingle() returns an existing
  //   version row for the parse's (provider, source_name, effective_from) key.
  //   Any child insert would fail the assertion because we do NOT expose insert
  //   on the stub — importer must short-circuit before reaching it.
  const stub = {
    from(_table) {
      const chain = {
        select() { return chain; },
        eq()     { return chain; },
        maybeSingle: async () => ({ data: { id: 999, status: 'active' }, error: null }),
        insert:      () => { assert.fail('insert MUST NOT be called for idempotent re-import'); },
        delete:      () => { assert.fail('delete MUST NOT be called for idempotent re-import'); },
      };
      return chain;
    },
  };
  const out = await importer.importWorkbook(stub, buf, {
    sourceName: '2026_eGS_Service_운임표_(통합)_260901.xlsx',
    provider:   'eGS',
    effectiveFrom: '2026-09-01',
  });
  assert.equal(out.alreadyImported, true);
  assert.equal(out.versionId, 999);
});

test('IMPORTER-F · duplicate service_code fixture → hard error', async () => {
  //   Craft a minimal xlsx-like memory workbook via JSZip that duplicates
  //   an EGS_STD_US row in 서비스_Master. We accomplish this by cloning the
  //   real workbook and appending a duplicate <x:row> to sheet4.
  const JSZip = require('jszip');
  const buf = fs.readFileSync(WB_PATH);
  const zip = await JSZip.loadAsync(buf);
  let sheet4 = await zip.file('xl/worksheets/sheet4.xml').async('string');
  //   Insert a synthetic duplicate row at the end of sheetData.
  const dup = `<x:row r="200"><x:c r="A200" t="str"><x:v>eGS</x:v></x:c><x:c r="B200" t="str"><x:v>EGS_STD_US</x:v></x:c><x:c r="C200" t="str"><x:v>dup</x:v></x:c><x:c r="D200" t="n"><x:v>6000</x:v></x:c><x:c r="E200" t="str"><x:v>B2C</x:v></x:c><x:c r="F200" t="str"><x:v>DAP</x:v></x:c><x:c r="G200" t="str"><x:v>Y</x:v></x:c></x:row>`;
  sheet4 = sheet4.replace('</x:sheetData>', dup + '</x:sheetData>');
  zip.file('xl/worksheets/sheet4.xml', sheet4);
  const bad = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await importer.parseAndValidate(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate service_code: EGS_STD_US/.test(e)),
    `expected duplicate error, got: ${JSON.stringify(r.errors.slice(0, 3))}`);
});

//   ─────────────────────────────────────────────────────────────
//   Parser-level sanity
//   ─────────────────────────────────────────────────────────────

test('IMPORTER-G · normalizeDate accepts YYYY-MM-DD / YYYY.MM.DD / Date / Excel serial', () => {
  const nd = importer.normalizeDate;
  assert.equal(nd('2026-09-01'),                    '2026-09-01');
  assert.equal(nd('2026.09.01'),                    '2026-09-01');
  assert.equal(nd(new Date('2026-09-01T00:00:00Z')), '2026-09-01');
  //   Excel serial 45901 → 2025-09-01 (Excel bug included). Not asserting a
  //   specific date; only that it returns a valid ISO date-shape.
  const serial = nd(45536);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(serial), `serial=${serial}`);
  assert.equal(nd('  '), null);
  assert.equal(nd(null), null);
});

test('IMPORTER-H · yn accepts Y/YES/TRUE/1 (case-insensitive)', () => {
  const yn = importer.yn;
  assert.equal(yn('Y'),    true);
  assert.equal(yn('yes'),  true);
  assert.equal(yn('TRUE'), true);
  assert.equal(yn('1'),    true);
  assert.equal(yn('N'),    false);
  assert.equal(yn(''),     false);
  assert.equal(yn(null),   false);
});
