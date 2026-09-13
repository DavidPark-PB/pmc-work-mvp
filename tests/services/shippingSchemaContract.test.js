'use strict';

/**
 * tests/services/shippingSchemaContract.test.js — PMC-CCOREA-SHIPPING-1B
 * (2026-09-13 · bracket schema contract + atomic import + activation guard).
 *
 * Owner-reported production error on V2 upload:
 *   "eGS: brackets insert (chunk 0): Could not find the 'provider' column of
 *    'shipping_rate_brackets' in the schema cache"
 *   same for KPL.
 *
 * Root cause: importer built each bracket payload with a `provider` key, but
 * shipping_rate_brackets has no such column. Provider is derivable via
 * rate_version_id → shipping_rate_versions.provider, and no code queries
 * brackets by provider, so the fix is to strip the key from the payload —
 * NOT to add a redundant column to the schema.
 *
 * This suite locks in
 *   §3  schema contract — every importer payload key exists in the actual
 *       production column list for its target table (snapshot committed
 *       from information_schema.columns · project tsqposttkfrvgkyhwade ·
 *       2026-09-13 audit)
 *   §4  atomicity — mid-brackets failure triggers cascade cleanup so no
 *       incomplete version row survives (FK ON DELETE CASCADE ensures
 *       children die with the parent)
 *   §5  activation guard — assertVersionActivatable() rejects versions
 *       with zero brackets, missing benchmark services, or empty benchmark
 *       services, with machine-readable `.code` on the thrown error
 *   §7  regression — bracket payload MUST NOT contain `provider`; reimport
 *       after failure creates a NEW version (never `alreadyImported`);
 *       reimport after success is idempotent
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');
const fs      = require('node:fs');

const REPO     = path.resolve(__dirname, '../..');
const importer = require(path.join(REPO, 'src/services/shipping/rateMasterImporter'));

//   ─────────────────────────────────────────────────────────────
//   Production column snapshot (audit 2026-09-13 · project
//   tsqposttkfrvgkyhwade). This is the ground truth the importer
//   payloads must conform to. Any migration that changes a column
//   MUST also update this snapshot — the divergence catches drift.
//   ─────────────────────────────────────────────────────────────
const PROD_COLUMNS = {
  shipping_rate_versions: [
    'id', 'provider', 'source_name', 'effective_from', 'effective_to',
    'status', 'imported_at', 'imported_by', 'note',
  ],
  shipping_services: [
    'id', 'rate_version_id', 'provider', 'service_code', 'service_name',
    'vol_divisor', 'sale_type', 'incoterm', 'rate_loaded', 'coverage',
    'usage', 'perkg_surcharge_krw', 'active',
  ],
  shipping_countries: [
    'id', 'rate_version_id', 'country_code', 'country_name', 'express_zone',
    'is_eu', 'vat_rate', 'benchmark_service_code',
  ],
  shipping_rate_brackets: [
    'id', 'rate_version_id', 'service_code', 'country_key', 'zone_key',
    'weight_to_kg', 'base_rate', 'currency', 'note', 'active',
    //   NOTE: no `provider` — that column is intentionally absent because
    //   provider is derivable from rate_version_id and no code queries it.
  ],
  shipping_surcharges: [
    'id', 'rate_version_id', 'rule_code', 'scope', 'value', 'unit',
    'enabled', 'effective_from', 'effective_to', 'note',
  ],
};

//   ─────────────────────────────────────────────────────────────
//   Fake supabase client that captures every insert so we can
//   inspect exactly what keys the importer sends. Reused across
//   contract / atomicity / activation tests.
//   ─────────────────────────────────────────────────────────────
function makeCapturingClient({ failBracketsChunk = null, existingVersions = [], insertedIds = {} } = {}) {
  const captured = { inserts: [], updates: [], deletes: [], selects: [] };
  //   Assign auto-increment ids per table so version → child FKs match.
  const nextId = { versions: 100, services: 200, countries: 300, brackets: 400, surcharges: 500 };

  function makeQuery(table) {
    const state = { table, filters: [] };
    const chain = {
      select() { return chain; },
      eq(col, val) { state.filters.push([col, val]); return chain; },
      in(col, vals) { state.filters.push([col, vals]); return chain; },
      gte() { return chain; },
      lte() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() { return chain._resolveSelect(true); },
      single() { return chain._resolveSelect(true); },
      then(res, rej) { return chain._resolveSelect(false).then(res, rej); },
      _resolveSelect(single) {
        //   Serve idempotency lookup: existingVersions match by (provider, source_name, effective_from).
        if (table === 'shipping_rate_versions' && state.filters.some(([c]) => c === 'provider')) {
          const provider = state.filters.find(([c]) => c === 'provider')?.[1];
          const source_name = state.filters.find(([c]) => c === 'source_name')?.[1];
          const effective_from = state.filters.find(([c]) => c === 'effective_from')?.[1];
          const hit = existingVersions.find(v =>
            v.provider === provider && v.source_name === source_name && v.effective_from === effective_from
          );
          return Promise.resolve({ data: hit || null, error: null });
        }
        //   Default: empty result.
        return Promise.resolve({ data: single ? null : [], error: null });
      },
    };
    return chain;
  }

  return {
    _captured: captured,
    from(table) {
      const chain = {
        insert(rows) {
          const arr = Array.isArray(rows) ? rows : [rows];
          captured.inserts.push({ table, rows: arr });
          if (table === 'shipping_rate_brackets' && failBracketsChunk != null) {
            //   Simulate the exact PostgREST error owner saw in production.
            return {
              select() {
                return Promise.resolve({
                  data: null,
                  error: { message: "Could not find the 'provider' column of 'shipping_rate_brackets' in the schema cache" },
                });
              },
            };
          }
          const returned = arr.map(() => ({ id: nextId[tableToKey(table)]++ }));
          return {
            select() {
              return {
                single() { return Promise.resolve({ data: returned[0], error: null }); },
                then(res, rej) { return Promise.resolve({ data: returned, error: null }).then(res, rej); },
              };
            },
          };
        },
        update(patch) {
          captured.updates.push({ table, patch });
          const chainUpd = {
            eq() { return chainUpd; },
            select() { return chainUpd; },
            maybeSingle() { return Promise.resolve({ data: {}, error: null }); },
            then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
          };
          return chainUpd;
        },
        delete() {
          const chainDel = {
            eq(col, val) { captured.deletes.push({ table, filter: [col, val] }); return Promise.resolve({ data: null, error: null }); },
          };
          return chainDel;
        },
        select() { return makeQuery(table).select(); },
        ...makeQuery(table),
      };
      return chain;
    },
  };
}
function tableToKey(t) {
  return ({
    shipping_rate_versions: 'versions', shipping_services: 'services',
    shipping_countries: 'countries', shipping_rate_brackets: 'brackets',
    shipping_surcharges: 'surcharges',
  })[t] || 'x';
}

//   Load the real v2 workbook, or skip cleanly on CI without it.
//   (parseAndValidate is a local closure inside importWorkbook — cannot be
//   monkey-patched at the module-exports level, so tests that need the
//   full importWorkbook path have to drive it with a real xlsx buffer.)
const _V2_PATH = path.join(REPO, 'data/shipping/CCOREA_통합배송비_기본데이터_v2.xlsx');
function _loadV2OrSkip() {
  if (!fs.existsSync(_V2_PATH)) {
    //   v2 workbook is gitignored; on CI without it, these tests skip.
    //   The CONTRACT-3 / ATOMIC-2 / GUARD-* tests still run without a workbook.
    return null;
  }
  return fs.readFileSync(_V2_PATH);
}

//   Small parseAndValidate-shaped fixture. eGS has brackets so it should
//   attempt insert; KPL has only 2 brackets to keep the fixture tiny.
function fixtureParsed() {
  return {
    ok: true,
    versions: [
      { provider: 'eGS', source_name: 'CCOREA_v2', effective_from: '2026-09-13', note: null },
      { provider: 'KPL', source_name: 'CCOREA_v2', effective_from: '2026-09-13', note: null },
    ],
    primaryProviderForCountries: 'eGS',
    services: [
      { provider: 'eGS', service_code: 'EGS_STD_US', service_name: 'eGS STD US', vol_divisor: 6000, sale_type: null, incoterm: null, rate_loaded: true, coverage: null, usage: null, perkg_surcharge_krw: 2000, active: true },
      { provider: 'KPL', service_code: 'KPL_STD',    service_name: 'KPL STD',    vol_divisor: 6000, sale_type: null, incoterm: null, rate_loaded: true, coverage: null, usage: null, perkg_surcharge_krw: 0,    active: true },
    ],
    countries: [
      { country_code: 'US', country_name: 'United States', express_zone: null, is_eu: false, vat_rate: 0, benchmark_service_code: 'EGS_STD_US' },
    ],
    brackets: [
      { provider: 'eGS', service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 16100, currency: 'KRW', note: null, active: true },
      { provider: 'eGS', service_code: 'EGS_STD_US', country_key: 'US', zone_key: null, weight_to_kg: 1.0, base_rate: 20000, currency: 'KRW', note: null, active: true },
      { provider: 'KPL', service_code: 'KPL_STD',    country_key: 'US', zone_key: null, weight_to_kg: 0.5, base_rate: 12000, currency: 'KRW', note: null, active: true },
    ],
    surcharges: [
      { rule_code: 'FSC', scope: 'ALL', value: 15, unit: 'PCT', enabled: true, effective_from: null, effective_to: null, note: null },
    ],
    errors: [], warnings: [],
  };
}

//   ═════════════════════════════════════════════════════════════
//   §3 · schema contract
//   ═════════════════════════════════════════════════════════════

test('CONTRACT-1 · bracket insert payload has NO `provider` key (production schema has no such column)', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  const client = makeCapturingClient();
  await importer.importWorkbook(client, buf);

  const bracketInserts = client._captured.inserts.filter(i => i.table === 'shipping_rate_brackets');
  assert.ok(bracketInserts.length >= 1, 'expected at least one bracket insert');
  for (const chunk of bracketInserts) {
    for (const row of chunk.rows) {
      assert.equal(row.provider, undefined,
        `bracket payload MUST NOT carry a provider key — found ${JSON.stringify(row)}`);
      assert.equal(row._rowNum, undefined,
        `bracket payload MUST NOT carry a _rowNum internal marker`);
    }
  }
});

test('CONTRACT-2 · every importer payload key exists in the production column snapshot', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  const client = makeCapturingClient();
  await importer.importWorkbook(client, buf);

  for (const { table, rows } of client._captured.inserts) {
    const cols = new Set(PROD_COLUMNS[table] || []);
    assert.ok(cols.size > 0, `PROD_COLUMNS snapshot missing for ${table} — update snapshot`);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        assert.ok(cols.has(key),
          `${table} payload has key "${key}" that does NOT exist in production columns [${[...cols].join(', ')}]`);
      }
    }
  }
});

test('CONTRACT-3 · PROD_COLUMNS snapshot stays in sync with migration 112 CREATE TABLE definitions', () => {
  //   Read migration 112 and confirm every column we snapshot appears there.
  //   Any DROP/RENAME in a later migration would need snapshot updates too —
  //   this test would catch that as a stale entry.
  const mig = fs.readFileSync(path.join(REPO, 'supabase/migrations/112_shipping_rate_master.sql'), 'utf8');
  //   Absence check: shipping_rate_brackets MUST NOT declare a provider column.
  const bracketBlock = mig.match(/create\s+table\s+.*shipping_rate_brackets[\s\S]*?\n\);/i);
  assert.ok(bracketBlock, 'migration 112 must define shipping_rate_brackets');
  assert.ok(!/\bprovider\b/i.test(bracketBlock[0]),
    'migration 112 shipping_rate_brackets MUST NOT declare a provider column');
});

//   ═════════════════════════════════════════════════════════════
//   §4 · atomicity
//   ═════════════════════════════════════════════════════════════

test('ATOMIC-1 · brackets insert failure triggers version DELETE (cascade cleans children)', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  const client = makeCapturingClient({ failBracketsChunk: 0 });
  const out = await importer.importWorkbook(client, buf);

  //   Every provider that reaches bracket insert fails → each triggers cleanup.
  const deletes = client._captured.deletes.filter(d => d.table === 'shipping_rate_versions');
  //   v2 has 2 rate-loaded providers (eGS + KPL); others (SHIPTER/FedEx/KoreaPost)
  //   are skipped before insert. Expect exactly 2 deletes.
  assert.equal(deletes.length, 2, `expected 2 version deletes (eGS + KPL) — got ${deletes.length}`);
  //   `errors[]` names both providers with the exact PostgREST error string.
  assert.ok(out.errors.some(e => /eGS.*provider.*column/.test(e)), `eGS error missing: ${JSON.stringify(out.errors)}`);
  assert.ok(out.errors.some(e => /KPL.*provider.*column/.test(e)), `KPL error missing: ${JSON.stringify(out.errors)}`);
  //   No successful `created[]` entries — every provider hit the failure branch.
  assert.equal(out.versions.filter(v => !v.skipped && v.versionId).length, 0,
    'no version should be marked successful when brackets insert failed');
});

test('ATOMIC-2 · migration 112 declares ON DELETE CASCADE on every child FK (cleanup precondition)', () => {
  const mig = fs.readFileSync(path.join(REPO, 'supabase/migrations/112_shipping_rate_master.sql'), 'utf8');
  //   Each child table's rate_version_id must be `... references
  //   shipping_rate_versions(id) on delete cascade`.
  const CHILD_TABLES = ['shipping_services', 'shipping_countries', 'shipping_rate_brackets', 'shipping_surcharges'];
  for (const t of CHILD_TABLES) {
    const block = mig.match(new RegExp(`create\\s+table\\s+.*${t}[\\s\\S]*?\\n\\);`, 'i'));
    assert.ok(block, `migration 112 must define ${t}`);
    assert.ok(/references\s+shipping_rate_versions\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i.test(block[0]),
      `${t}.rate_version_id MUST reference shipping_rate_versions(id) ON DELETE CASCADE — atomic cleanup depends on it`);
  }
});

test('ATOMIC-3 · reimport after failure is NOT flagged alreadyImported (version was cleaned up)', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  //   Owner semantic: after a failure, cascade delete removes the version
  //   row. A second import attempt against a clean DB (no existingVersions)
  //   MUST re-attempt the insert path — never return alreadyImported=true.
  const client = makeCapturingClient({ existingVersions: [] });
  const out = await importer.importWorkbook(client, buf);
  const alreadyImported = out.versions.filter(v => v.alreadyImported);
  assert.equal(alreadyImported.length, 0,
    `after cleanup, reimport must NOT trip alreadyImported — got ${JSON.stringify(alreadyImported)}`);
});

test('ATOMIC-4 · reimport of a SUCCESSFUL prior version IS flagged alreadyImported (true idempotency)', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  //   Prior successful import → both providers exist in shipping_rate_versions.
  //   Read the actual v2 source_name + effective_from from the parsed workbook
  //   so the idempotency check matches. Load once so the source_name matches
  //   what parseAndValidate uses at runtime.
  const parsed = await importer.parseAndValidate(buf);
  const existingVersions = parsed.versions
    .filter(v => v.provider === 'eGS' || v.provider === 'KPL')
    .map((v, i) => ({ id: 100 + i, provider: v.provider, source_name: v.source_name, effective_from: v.effective_from, status: 'active' }));
  const client = makeCapturingClient({ existingVersions });
  const out = await importer.importWorkbook(client, buf);
  const alreadyImported = out.versions.filter(v => v.alreadyImported);
  assert.equal(alreadyImported.length, existingVersions.length,
    `all pre-existing providers should be idempotent — got ${JSON.stringify(out.versions.map(v => ({p: v.provider, ai: v.alreadyImported})))}`);
  //   And no new version inserts fired.
  assert.equal(client._captured.inserts.filter(i => i.table === 'shipping_rate_versions').length, 0,
    'no version inserts should fire when providers were already imported');
});

//   ═════════════════════════════════════════════════════════════
//   §5 · activation guard
//   ═════════════════════════════════════════════════════════════

//   PostgREST default hard limit — a bare .select() returns at most this many
//   rows. The activation-guard 1000-row bug was owner-reported on 2026-09-13
//   when eGS v3 with 3,876 brackets triggered false SERVICE_WITHOUT_BRACKETS.
const POSTGREST_DEFAULT_CAP = 1000;

//   Activation guard fake. Behaviour choices, all deliberate:
//     · `.range(from,to)` slices `rows` at [from..to] inclusive — the SAME
//       slicing PostgREST does, so pagination bugs surface at test time.
//     · A bare `.select().eq()...then` (no `.range`) is CAPPED at
//       POSTGREST_DEFAULT_CAP rows — this is how PostgREST actually behaves
//       and how the bug got past the previous fake (which returned all rows).
//     · `.update()`/`.delete()` chains support `.eq/.select/.maybeSingle/then`
//       so the full activateVersion() flow (supersede + activate) can be
//       exercised end-to-end.
function _activationClient({
  services = [], brackets = [], countries = [], activeVersions = [],
  targetVersion = null,   //   what the initial `.select().eq('id', id)` returns for shipping_rate_versions
  updateHook = null,      //   called with ({table, patch, filters}) on every update
  rangeError = null,      //   throw this from a paginated read (to test guard-fails-safe)
} = {}) {
  const updates = [];
  function pickRows(table, filters) {
    let src;
    if      (table === 'shipping_services')       src = services;
    else if (table === 'shipping_rate_brackets')  src = brackets;
    else if (table === 'shipping_countries')      src = countries;
    else if (table === 'shipping_rate_versions')  src = activeVersions;
    else                                          src = [];
    //   Apply .eq('rate_version_id', N) or .in('rate_version_id', [...]) if the
    //   fixture nests rows by version. Fixtures used below leave the version
    //   field implicit, so this filter is a no-op when the row lacks it.
    for (const [col, val] of filters || []) {
      if (col === 'status') src = src.filter(r => r.status === val);
      if (col === 'id') {
        //   Targeted single-row read used by activateVersion() initial fetch.
        //   Match by scalar id.
        src = src.filter(r => r.id === val);
      }
    }
    return src;
  }
  function makeSelect(table) {
    const state = { filters: [] };
    const chain = {
      eq(c, v) { state.filters.push([c, v]); return chain; },
      in(c, v) { state.filters.push([c, v]); return chain; },
      order() { return chain; }, limit() { return chain; },
      range(from, to) {
        if (rangeError) return Promise.reject(rangeError);
        const rows = pickRows(table, state.filters);
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
      maybeSingle() {
        if (table === 'shipping_rate_versions' && targetVersion) {
          //   activateVersion's initial fetch by id — return the target row.
          const idFilter = state.filters.find(([c]) => c === 'id');
          if (idFilter && targetVersion.id === idFilter[1]) {
            return Promise.resolve({ data: targetVersion, error: null });
          }
        }
        const rows = pickRows(table, state.filters);
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() { return chain.maybeSingle(); },
      then(res, rej) {
        //   Bare `.then` (no range) simulates PostgREST default 1000-row cap.
        const rows = pickRows(table, state.filters).slice(0, POSTGREST_DEFAULT_CAP);
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return chain;
  }
  function makeUpdate(table, patch) {
    const state = { filters: [] };
    const chain = {
      eq(c, v) { state.filters.push([c, v]); return chain; },
      select() {
        const inner = {
          maybeSingle() {
            updates.push({ table, patch, filters: state.filters });
            if (updateHook) updateHook({ table, patch, filters: state.filters });
            return Promise.resolve({ data: {}, error: null });
          },
          then(res, rej) {
            updates.push({ table, patch, filters: state.filters });
            if (updateHook) updateHook({ table, patch, filters: state.filters });
            return Promise.resolve({ data: [], error: null }).then(res, rej);
          },
        };
        return inner;
      },
    };
    return chain;
  }
  return {
    _updates: updates,
    from(table) {
      return {
        select() { return makeSelect(table); },
        update(patch) { return makeUpdate(table, patch); },
      };
    },
  };
}

test('GUARD-1 · zero brackets → throws NO_BRACKETS', async () => {
  const client = _activationClient({
    services: [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }],
    brackets: [],
  });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'NO_BRACKETS' && /zero brackets/i.test(e.message));
});

test('GUARD-2 · no active rate_loaded service → throws NO_ACTIVE_SERVICE', async () => {
  const client = _activationClient({
    services: [{ service_code: 'EGS_STD_US', rate_loaded: false, active: true }],
    brackets: [{ service_code: 'EGS_STD_US' }],
  });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'NO_ACTIVE_SERVICE');
});

test('GUARD-3 · rate_loaded service without brackets → throws SERVICE_WITHOUT_BRACKETS', async () => {
  const client = _activationClient({
    services: [
      { service_code: 'EGS_STD_US',   rate_loaded: true, active: true },
      { service_code: 'EGS_STD_EU_XX', rate_loaded: true, active: true },
    ],
    brackets: [{ service_code: 'EGS_STD_US' }],   //   EGS_STD_EU_XX has none
  });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'SERVICE_WITHOUT_BRACKETS' && /EGS_STD_EU_XX/.test(e.message));
});

test('GUARD-4 · country benchmark service missing → throws BENCHMARK_SERVICE_MISSING', async () => {
  const client = _activationClient({
    services:  [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }],
    brackets:  [{ service_code: 'EGS_STD_US' }],
    countries: [
      { country_code: 'US', benchmark_service_code: 'EGS_STD_US' },
      { country_code: 'ZZ', benchmark_service_code: 'DOES_NOT_EXIST' },
    ],
    activeVersions: [],
  });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'BENCHMARK_SERVICE_MISSING' && /ZZ.*DOES_NOT_EXIST/.test(e.message));
});

test('GUARD-5 · fully-valid version → assertion resolves', async () => {
  const client = _activationClient({
    services:  [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }],
    brackets:  [{ service_code: 'EGS_STD_US' }],
    countries: [{ country_code: 'US', benchmark_service_code: 'EGS_STD_US' }],
    activeVersions: [],
  });
  await assert.doesNotReject(() => importer.assertVersionActivatable(client, 101));
});

//   ═════════════════════════════════════════════════════════════
//   §6 · 1000-row cap regression + concurrency
//   ═════════════════════════════════════════════════════════════

test('CAP-1 · 1,000 brackets fits inside one page → activation passes', async () => {
  //   Exactly at the cap: PostgREST returns the full 1000; pagination
  //   makes a second call that comes back empty; loop terminates.
  const services = Array.from({ length: 5 }, (_, i) => ({
    service_code: `SVC_${i}`, rate_loaded: true, active: true,
  }));
  const brackets = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 200; j++) brackets.push({ service_code: `SVC_${i}` });
  }
  assert.equal(brackets.length, 1000);
  const client = _activationClient({ services, brackets });
  await assert.doesNotReject(() => importer.assertVersionActivatable(client, 101));
});

test('CAP-2 · 1,001 brackets straddles two pages → activation still passes (no false SERVICE_WITHOUT_BRACKETS)', async () => {
  //   The +1 row lives on the 2nd page. A bare .select() would drop it and
  //   flag its service_code as missing brackets. Pagination catches it.
  const services = Array.from({ length: 6 }, (_, i) => ({
    service_code: `SVC_${i}`, rate_loaded: true, active: true,
  }));
  const brackets = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 200; j++) brackets.push({ service_code: `SVC_${i}` });
  }
  //   The 1001st row belongs to SVC_5 — invisible under the old cap.
  brackets.push({ service_code: 'SVC_5' });
  assert.equal(brackets.length, 1001);
  const client = _activationClient({ services, brackets });
  await assert.doesNotReject(() => importer.assertVersionActivatable(client, 101));
});

test('CAP-3 · 3,876-row eGS shape (real v2 scale) → activation passes with 56 services, 4 pages', async () => {
  //   Exact reproduction of the owner-reported production shape:
  //   28 svc_codes fit in the first 1000 rows, 28 more sit past pk 1000.
  //   Under the old bug this test threw SERVICE_WITHOUT_BRACKETS with
  //   exactly those 28 codes; with pagination it must pass.
  const services = [];
  const brackets = [];
  //   First 28 services get 30 brackets each (total 840 rows, all in page 1).
  for (let i = 0; i < 28; i++) {
    services.push({ service_code: `EGS_A_${i}`, rate_loaded: true, active: true });
    for (let j = 0; j < 30; j++) brackets.push({ service_code: `EGS_A_${i}` });
  }
  //   Pad to reach ~pk 1000 with a big block of EGS_EXPRESS-shaped rows.
  for (let j = 0; j < 160; j++) brackets.push({ service_code: 'EGS_A_0' });
  //   Now add 28 MORE services (EGS_B_*) with 100 brackets each — these sit
  //   past pk 1000 and were falsely flagged by the old code.
  for (let i = 0; i < 28; i++) {
    services.push({ service_code: `EGS_B_${i}`, rate_loaded: true, active: true });
    for (let j = 0; j < 100; j++) brackets.push({ service_code: `EGS_B_${i}` });
  }
  assert.equal(services.length, 56, 'must match production eGS shape (56 rate-loaded services)');
  assert.ok(brackets.length >= 3800, `expected ≥3800 brackets — got ${brackets.length}`);
  const client = _activationClient({ services, brackets });
  await assert.doesNotReject(() => importer.assertVersionActivatable(client, 101),
    'v2-scale activation MUST NOT throw SERVICE_WITHOUT_BRACKETS for services past pk 1000');
});

test('CAP-4 · service with actually-zero brackets is STILL caught (fix is not permissive)', async () => {
  //   The fix must widen visibility, not silence the check. A genuine
  //   missing bracket must still throw SERVICE_WITHOUT_BRACKETS even
  //   when 1000+ other rows exist.
  const services = [
    ...Array.from({ length: 5 }, (_, i) => ({ service_code: `HAS_${i}`, rate_loaded: true, active: true })),
    { service_code: 'GENUINELY_EMPTY', rate_loaded: true, active: true },
  ];
  const brackets = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 250; j++) brackets.push({ service_code: `HAS_${i}` });
  }
  //   1,250 rows: comfortably past the 1000 cap, and GENUINELY_EMPTY has zero.
  const client = _activationClient({ services, brackets });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'SERVICE_WITHOUT_BRACKETS' && /GENUINELY_EMPTY/.test(e.message));
});

test('CAP-5 · benchmark BENCHMARK_SERVICE_EMPTY still fires when service present but has 0 brackets past pk 1000', async () => {
  //   The multi-version benchmark check also uses pagination — a benchmark
  //   service whose brackets don't exist must still be caught.
  const services = [
    ...Array.from({ length: 10 }, (_, i) => ({ service_code: `S_${i}`, rate_loaded: true, active: true })),
    { service_code: 'BENCH_ONLY', rate_loaded: false, active: true },   //   present as a service, no brackets
  ];
  const brackets = [];
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 110; j++) brackets.push({ service_code: `S_${i}` });   //   1,100 rows
  }
  const countries = [
    { country_code: 'US', benchmark_service_code: 'S_0' },   //   fine
    { country_code: 'ZZ', benchmark_service_code: 'BENCH_ONLY' },   //   should raise BENCHMARK_SERVICE_EMPTY
  ];
  const client = _activationClient({ services, brackets, countries, activeVersions: [] });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => e.code === 'BENCHMARK_SERVICE_EMPTY' && /BENCH_ONLY/.test(e.message));
});

test('CAP-6 · fetchAllPaginated stops on partial page + throws on runaway (safety cap)', async () => {
  const { fetchAllPaginated } = importer;
  //   Deterministic 1250-row source served in 1000-row pages.
  const source = Array.from({ length: 1250 }, (_, i) => ({ i }));
  function buildQuery() {
    return {
      range: (from, to) => Promise.resolve({ data: source.slice(from, to + 1), error: null }),
    };
  }
  const out = await fetchAllPaginated(buildQuery, 1000);
  assert.equal(out.length, 1250, 'paginator MUST return every row across pages');

  //   Runaway safety: a source that never shrinks below the page size
  //   would loop forever without the hard-stop.
  function neverEnds() {
    return { range: (from, to) => Promise.resolve({ data: new Array(to - from + 1).fill({}), error: null }) };
  }
  await assert.rejects(() => fetchAllPaginated(neverEnds, 100, 3),
    (e) => /hard-stop/.test(e.message));
});

test('CAP-7 · fetchAllPaginated propagates DB errors (guard fails safe on query failure)', async () => {
  const { fetchAllPaginated } = importer;
  function boom() {
    return { range: () => Promise.resolve({ data: null, error: { message: 'db down' } }) };
  }
  await assert.rejects(() => fetchAllPaginated(boom, 100),
    (e) => /db down/.test(e.message));
});

//   ═════════════════════════════════════════════════════════════
//   §5 · concurrency + cross-provider isolation
//   ═════════════════════════════════════════════════════════════

test('CONCURRENCY-1 · activating eGS with KPL already ACTIVE does not touch KPL (provider-scoped supersede)', async () => {
  //   Fixture: KPL v4 already ACTIVE. Activating eGS v3 must:
  //     · run the guard (paginated, passes)
  //     · supersede prior eGS actives only (none here, so no-op)
  //     · promote eGS v3 to active
  //   And MUST NOT emit any UPDATE that filters by provider='KPL'.
  const svcs = [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }];
  const brks = [{ service_code: 'EGS_STD_US' }];
  const client = _activationClient({
    services: svcs,
    brackets: brks,
    countries: [],
    activeVersions: [{ id: 4, status: 'active' }],   //   read by the multi-version benchmark step (no countries so unused)
    targetVersion: { id: 3, provider: 'eGS', effective_from: '2026-09-01', status: 'draft' },
  });
  await importer.activateVersion(client, 3);
  //   Verify no update targeted KPL.
  for (const u of client._updates) {
    for (const [col, val] of u.filters) {
      assert.ok(!(col === 'provider' && val === 'KPL'),
        `activateVersion emitted an update filtered by provider=KPL — cross-provider leak`);
    }
  }
});

test('CONCURRENCY-2 · double-activation of the same draft version converges to ACTIVE', async () => {
  //   Simulate two racing activation clicks. Each sees the version as
  //   'draft' at read time; both pass guards; both run supersede+activate.
  //   Final state MUST be a single ACTIVE — no crash, no wrong-provider
  //   drift.
  const svcs = [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }];
  const brks = [{ service_code: 'EGS_STD_US' }];
  //   Shared state that reflects updates so the second call sees the effect
  //   of the first (in reality PostgreSQL row-level locking would serialize,
  //   but this fake tests that our client-side flow converges either way).
  const version = { id: 3, provider: 'eGS', effective_from: '2026-09-01', status: 'draft' };
  const updateHook = ({ table, patch, filters }) => {
    if (table === 'shipping_rate_versions') {
      const idHit = filters.find(([c]) => c === 'id');
      if (idHit && idHit[1] === version.id && patch.status) version.status = patch.status;
    }
  };
  const clientA = _activationClient({ services: svcs, brackets: brks, targetVersion: version, updateHook });
  const clientB = _activationClient({ services: svcs, brackets: brks, targetVersion: version, updateHook });
  await Promise.all([
    importer.activateVersion(clientA, 3),
    importer.activateVersion(clientB, 3),
  ]);
  assert.equal(version.status, 'active', `final status must converge to 'active' — got ${version.status}`);
});

test('CONCURRENCY-3 · guard failure keeps version in DRAFT — no update fires', async () => {
  //   NO_BRACKETS should throw BEFORE any update is emitted, so version
  //   status stays 'draft'.
  const client = _activationClient({
    services: [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }],
    brackets: [],   //   forces NO_BRACKETS
    targetVersion: { id: 3, provider: 'eGS', effective_from: '2026-09-01', status: 'draft' },
  });
  await assert.rejects(() => importer.activateVersion(client, 3),
    (e) => e.code === 'NO_BRACKETS');
  assert.equal(client._updates.length, 0,
    'no UPDATE should fire when the guard rejects — version stays draft');
});

test('CONCURRENCY-4 · db read error during guard throws, activation refused', async () => {
  //   A PostgREST 5xx during pagination must surface as a thrown error
  //   from the guard — never a silent skip that promotes a broken version.
  const client = _activationClient({
    services: [{ service_code: 'EGS_STD_US', rate_loaded: true, active: true }],
    brackets: [{ service_code: 'EGS_STD_US' }],
    rangeError: new Error('supabase 500'),
  });
  await assert.rejects(() => importer.assertVersionActivatable(client, 101),
    (e) => /supabase 500/.test(e.message));
});

//   ═════════════════════════════════════════════════════════════
//   §7 · real-workbook sanity — confirms the fix does not break
//   the v2 parseAndValidate contract (62/202/3957/8) already tested
//   in shippingRateImporter.test.js. Here we just prove the bracket
//   list still carries the `provider` field IN MEMORY (needed for
//   the per-provider split) even though the payload strips it.
//   ═════════════════════════════════════════════════════════════

test('SANITY-1 · parseAndValidate still produces `provider` on each bracket for the per-provider split', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  const r = await importer.parseAndValidate(buf);
  assert.equal(r.ok, true);
  assert.ok(r.brackets.length > 3000, `expected v2 brackets ≥ 3000 — got ${r.brackets.length}`);
  const withProvider = r.brackets.filter(b => b.provider);
  assert.equal(withProvider.length, r.brackets.length,
    'every parsed bracket must carry a provider tag (in-memory) even though it is stripped from the DB payload');
});

test('SANITY-2 · v2 importWorkbook produces per-provider bracket counts (eGS 3,876 · KPL 81) that sum to 3,957', async () => {
  const buf = _loadV2OrSkip(); if (!buf) return;
  const client = makeCapturingClient();
  const out = await importer.importWorkbook(client, buf);
  //   `created[]` entries carry per-provider rowCounts. eGS + KPL are the
  //   only providers whose services are rate_loaded in v2.
  const created = out.versions.filter(v => !v.skipped);
  const eGS = created.find(v => v.provider === 'eGS');
  const KPL = created.find(v => v.provider === 'KPL');
  assert.ok(eGS, `eGS must be in created[] — got ${JSON.stringify(created.map(v => v.provider))}`);
  assert.ok(KPL, `KPL must be in created[]`);
  assert.equal(eGS.rowCounts.brackets, 3876, `eGS bracket count drifted (was 3876) — got ${eGS.rowCounts.brackets}`);
  assert.equal(KPL.rowCounts.brackets,   81, `KPL bracket count drifted (was 81) — got ${KPL.rowCounts.brackets}`);
  assert.equal(eGS.rowCounts.brackets + KPL.rowCounts.brackets, 3957,
    'sum must equal the workbook total (parseAndValidate reports 3957)');
  //   Skipped providers named exactly.
  const skipped = out.versions.filter(v => v.skipped).map(v => v.provider).sort();
  //   v2 lists SHIPTER, FedEx, KoreaPost as no-rate providers — check the
  //   set matches (order-independent) rather than pinning verbatim names.
  assert.ok(skipped.every(p => /(SHIPTER|FedEx|KoreaPost)/i.test(p)),
    `unexpected skipped providers: ${JSON.stringify(skipped)}`);
});
