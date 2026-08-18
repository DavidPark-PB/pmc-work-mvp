'use strict';

/**
 * tests/oms/judgmentHistoryRepository.test.js — Phase 8O.
 *
 * Append-only persistence + safety guards. Uses stub db · zero real DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../src/services/oms/judgmentHistoryRepository');
const { buildJudgmentHistorySnapshot } = require('../../src/services/oms/judgmentHistorySnapshotService');
const { DECISION } = require('../../src/services/oms/inventoryDecisionEngine');

function makeOwnerDecision(id = 1) {
  return {
    physical_product_id: id,
    generated_at: '2026-08-18T00:00:00Z',
    headline: { decision_status: DECISION.WATCH, confidence_level: 'low', priority_score: 170, urgency_label: 'medium' },
    product: { title: 'BP', set_code: 'sv9', language: 'ko', unit_type: 'booster_box' },
    inventory: { on_hand: 45, reserved: 15, available: 30 },
    demand: { trusted: true }, supply: { verdict: 'AT_RISK' },
    cost_context: { historical_typical_supplier_cost_krw_median: 19500, historical_accounting_cost_krw: 45000, observed_secondary_market_ask_min_krw: 40000 },
    reasons: { reason_codes: [], hold_quantity_blockers: [], missing_evidence: [] },
    judgment_confidence: { overall_tier: 'LOW', by_dimension: { demand: { tier: 'MEDIUM' }, supply: { tier: 'LOW' }, cost: { tier: 'MEDIUM' }, identity: { tier: 'HIGH' } } },
    data_provenance: {},
  };
}

// Stub DB mimicking a subset of the Supabase JS client used by the repo.
function makeStubDb(state = { rows: [], errorNext: null }) {
  const client = {
    _state: state,
    from(table) {
      const q = { _table: table, _select: '*', _filters: [], _order: [], _range: null };
      const runInsert = async (row) => {
        //   Enforce (physical_product_id, fingerprint) uniqueness like the real UNIQUE INDEX
        const dup = state.rows.find(r => r.physical_product_id === row.physical_product_id && r.fingerprint === row.fingerprint);
        if (dup) return { data: null, error: { message: 'duplicate uq_judgment_snapshots_physical_fingerprint' } };
        const id = state.rows.length + 1;
        const stored = { id, created_at: new Date().toISOString(), ...row };
        state.rows.push(stored);
        return { data: [stored], error: null };
      };
      return {
        insert(row) { q._row = row; return { select: async () => runInsert(row) }; },
        select() { return this; },
        eq(k, v) { q._filters.push([k, v]); return this; },
        order(col, opts) { q._order.push([col, opts]); return this; },
        async range(from, to) {
          if (state.errorNext) { const e = state.errorNext; state.errorNext = null; return { data: null, error: e }; }
          let out = state.rows.slice();
          for (const [k, v] of q._filters) out = out.filter(r => r[k] === v);
          //   Newest first if ordered desc on snapshot_at
          out.sort((a, b) => (b.snapshot_at > a.snapshot_at ? 1 : b.snapshot_at < a.snapshot_at ? -1 : b.id - a.id));
          return { data: out.slice(from, to + 1), error: null };
        },
      };
    },
  };
  return client;
}

// ─── fingerprint invariants ──────────────────────────────

test('R1. Fingerprint is stable across key-order variations (deterministic serialization)', () => {
  const snap = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const swapped = { key_reasons: snap.key_reasons, physical_product_id: snap.physical_product_id, ...snap };
  assert.equal(repo.fingerprintSnapshot(snap), repo.fingerprintSnapshot(swapped));
});

test('R2. Fingerprint changes when payload content changes', () => {
  const s1 = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const s2 = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  s2.decision = 'REPLENISH';
  assert.notEqual(repo.fingerprintSnapshot(s1), repo.fingerprintSnapshot(s2));
});

test('R3. Fingerprint IGNORES snapshot_at · payload-identity signal is time-independent', () => {
  const s1 = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const s2 = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: 'b' });
  assert.equal(repo.fingerprintSnapshot(s1), repo.fingerprintSnapshot(s2));
});

// ─── toDbRow guards ──────────────────────────────────────

test('R4. toDbRow rejects missing physical_product_id', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  s.physical_product_id = null;
  assert.throws(() => repo.toDbRow(s, { product_identity_key: 'x' }), /physical_product_id/);
});

test('R5. toDbRow rejects missing product_identity_key', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  assert.throws(() => repo.toDbRow(s, {}), /product_identity_key/);
});

test('R6. toDbRow rejects invalid snapshot_at', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  s.snapshot_at = 'not-a-date';
  assert.throws(() => repo.toDbRow(s, { product_identity_key: 'x' }), /snapshot_at/);
});

test('R7. toDbRow rejects payload exceeding byte cap', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  s.padding = 'x'.repeat(50 * 1024);
  assert.throws(() => repo.toDbRow(s, { product_identity_key: 'x' }), /exceeds cap/);
});

test('R8. toDbRow rejects secret-looking written_by (JWT-shaped / sk_ prefix)', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij';
  assert.throws(() => repo.toDbRow(s, { product_identity_key: 'x', written_by: jwt }), /token \/ secret/);
  assert.throws(() => repo.toDbRow(s, { product_identity_key: 'x', written_by: 'sk_test_deadbeefcafebabe' }), /token \/ secret/);
});

test('R9. toDbRow slices product_identity_key + written_by to safe max lengths', () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const row = repo.toDbRow(s, { product_identity_key: 'k'.repeat(500), written_by: 'w'.repeat(200) });
  assert.ok(row.product_identity_key.length <= 200);
  assert.ok(row.written_by.length <= 100);
});

// ─── appendSnapshot append-only semantics ────────────

test('R10. appendSnapshot inserts new snapshot · row echoed with id + created_at', async () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const db = makeStubDb();
  const res = await repo.appendSnapshot({ snapshot: s, db, opts: { product_identity_key: 'BP-sv9-ko-booster_box' } });
  assert.equal(res.status, 'INSERTED');
  assert.ok(res.row.id > 0);
  assert.equal(res.row.physical_product_id, 1);
  assert.equal(res.row.schema_version, 'v8o.1');
});

test('R11. Second write with identical payload → DUPLICATE (fingerprint idempotency · never overwrites)', async () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const db = makeStubDb();
  const r1 = await repo.appendSnapshot({ snapshot: s, db, opts: { product_identity_key: 'BP' } });
  assert.equal(r1.status, 'INSERTED');
  const r2 = await repo.appendSnapshot({ snapshot: s, db, opts: { product_identity_key: 'BP' } });
  assert.equal(r2.status, 'DUPLICATE');
  assert.equal(db._state.rows.length, 1, 'only ONE row persisted · past snapshot untouched');
});

test('R12. Different physical_product_id with same payload → both persist (fingerprint per physical)', async () => {
  const s1 = buildJudgmentHistorySnapshot(makeOwnerDecision(1), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const s2 = buildJudgmentHistorySnapshot(makeOwnerDecision(2), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  const db = makeStubDb();
  const r1 = await repo.appendSnapshot({ snapshot: s1, db, opts: { product_identity_key: 'p1' } });
  const r2 = await repo.appendSnapshot({ snapshot: s2, db, opts: { product_identity_key: 'p2' } });
  assert.equal(r1.status, 'INSERTED');
  assert.equal(r2.status, 'INSERTED');
  assert.equal(db._state.rows.length, 2);
});

test('R13. Malformed snapshot rejected without touching DB', async () => {
  const bad = { /* no physical_product_id */ };
  const db = makeStubDb();
  const res = await repo.appendSnapshot({ snapshot: bad, db, opts: { product_identity_key: 'x' } });
  assert.equal(res.status, 'REJECTED');
  assert.equal(db._state.rows.length, 0);
});

test('R14. appendSnapshot throws when db is missing (production DB never auto-selected in tests)', async () => {
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  await assert.rejects(() => repo.appendSnapshot({ snapshot: s, opts: { product_identity_key: 'x' } }), /db.*required/);
});

// ─── listSnapshots ─────────────────────────────────

test('R15. listSnapshots returns newest first, respects limit + offset', async () => {
  const db = makeStubDb();
  for (const t of ['2026-08-18T09:00:00Z', '2026-08-18T10:00:00Z', '2026-08-18T11:00:00Z']) {
    const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: t });
    s.decision = 'WATCH_' + t;
    await repo.appendSnapshot({ snapshot: s, db, opts: { product_identity_key: 'BP' } });
  }
  const page1 = await repo.listSnapshots({ physicalProductId: 1, db, limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.items[0].snapshot_at > page1.items[1].snapshot_at, 'newest first ordering');

  const page2 = await repo.listSnapshots({ physicalProductId: 1, db, limit: 2, offset: 2 });
  assert.equal(page2.items.length, 1);
});

test('R16. listSnapshots caps limit at MAX_LIST_LIMIT (100)', async () => {
  const db = makeStubDb();
  const s = buildJudgmentHistorySnapshot(makeOwnerDecision(), null, { snapshotAt: '2026-08-18T09:00:00Z' });
  await repo.appendSnapshot({ snapshot: s, db, opts: { product_identity_key: 'BP' } });
  const res = await repo.listSnapshots({ physicalProductId: 1, db, limit: 99999 });
  assert.equal(res.limit, repo.MAX_LIST_LIMIT);
});

test('R17. listSnapshots rejects invalid physicalProductId', async () => {
  const db = makeStubDb();
  await assert.rejects(() => repo.listSnapshots({ physicalProductId: 0, db }), /positive integer/);
  await assert.rejects(() => repo.listSnapshots({ physicalProductId: -1, db }), /positive integer/);
  await assert.rejects(() => repo.listSnapshots({ physicalProductId: 'x', db }), /positive integer/);
});

test('R18. No UPDATE / DELETE / UPSERT path exists in the repo · only insert + select (Supabase query-builder shape)', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/services/oms/judgmentHistoryRepository.js'), 'utf8');
  //   Guard against future accidental additions. Match the Supabase
  //   query-builder shape `.from(...).update(` / `.delete(` / `.upsert(`
  //   so we don't false-match unrelated APIs (crypto.update, etc.).
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.update\s*\(/, 'repo must never call .from(...).update(...) · UPDATE forbidden');
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.delete\s*\(/, 'repo must never call .from(...).delete(...) · DELETE forbidden');
  assert.doesNotMatch(src, /\.from\s*\([^)]*\)\s*\.upsert\s*\(/, 'repo must never call .from(...).upsert(...) · UPSERT forbidden (append-only)');
});
