'use strict';
/**
 * phase75.test.js — Pilot Hardening · QC atomicity · Idempotency · Verification · Waves.
 *
 * DB stub factory · 실 Supabase hit 없음.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const acts = require('../../src/services/b2cInventory/taskActions');
const waves = require('../../src/services/b2cInventory/pilotWaves');
const { planRefill } = require('../../src/services/b2cInventory/queueRefill');

//   ── DB stub factory ────────────────────────────
function makeStubDb(spec) {
  //   spec: { [table]: { rows: [], select_impl?, update_impl?, insert_impl? } }
  return {
    from(table) {
      const t = spec[table] || { rows: [] };
      const q = {
        _filters: [],
        select(cols) { this._select = cols; return this; },
        eq(k, v) { this._filters.push({ op: 'eq', k, v }); return this; },
        in(k, v) { this._filters.push({ op: 'in', k, v: Array.isArray(v) ? v : [v] }); return this; },
        like(k, v) { this._filters.push({ op: 'like', k, v }); return this; },
        gte(k, v) { this._filters.push({ op: 'gte', k, v }); return this; },
        limit(n) { this._limit = n; return this; },
        range() { return this; },
        order() { return this; },
        _applyFilters(rows) {
          for (const f of this._filters) {
            if (f.op === 'eq') rows = rows.filter(r => r[f.k] === f.v);
            if (f.op === 'in') rows = rows.filter(r => f.v.includes(r[f.k]));
            if (f.op === 'like') rows = rows.filter(r => typeof r[f.k] === 'string' && new RegExp('^' + f.v.replace(/%/g, '.*') + '$').test(r[f.k]));
            if (f.op === 'gte') rows = rows.filter(r => r[f.k] >= f.v);
          }
          return rows;
        },
        maybeSingle() {
          const rows = this._applyFilters(t.rows.slice());
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        async then(res, rej) {
          try {
            const rows = this._applyFilters(t.rows.slice());
            res({ data: rows, error: null });
          } catch (e) { rej({ data: null, error: { message: e.message } }); }
        },
        update(patch) {
          if (t.update_hook) t.update_hook(this._filters, patch);
          if (t.update_impl) return t.update_impl(this._filters, patch);
          //   default: mutate in place
          const rows = this._applyFilters(t.rows);
          for (const r of rows) Object.assign(r, patch);
          return {
            eq(k, v) { return { select() { return { maybeSingle: () => Promise.resolve({ data: rows[0], error: null }) }; }, maybeSingle: () => Promise.resolve({ data: rows[0], error: null }) }; },
            select() { return { maybeSingle: () => Promise.resolve({ data: rows[0], error: null }) }; },
            maybeSingle: () => Promise.resolve({ data: rows[0], error: null }),
          };
        },
        insert(row) {
          if (t.insert_impl) return t.insert_impl(row);
          t.rows.push({ ...row, id: t.rows.length + 100 });
          return {
            select() { return { maybeSingle: () => Promise.resolve({ data: t.rows[t.rows.length - 1], error: null }) }; },
          };
        },
      };
      return q;
    },
  };
}

//   ── §1. QC PASS atomicity · SoT failure → done 금지 ─
test('QC PASS · SoT write 실패 → task done 금지 · LISTING_SOT_WRITE_FAILED', async () => {
  const task = {
    id: 1, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 42,
    listing_id: 'X-1', listing_url: 'https://x.com', selling_price: 1000,
  };
  const db = makeStubDb({
    team_tasks: { rows: [task] },
    sku_master: { rows: [{ id: 42, internal_sku: 'PMC-42', title: 't' }] },
    //   sku_listing_link insert 는 error 로 stub
    sku_listing_link: { rows: [], insert_impl: () => ({
      select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'FK violation', code: '23503' } }) }),
    })},
    platform_listings: { rows: [] },
  });
  const r = await acts.qcPass({ db, taskId: 1, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LISTING_SOT_WRITE_FAILED');
  assert.equal(task.status, 'qc_pending');   //   task 상태 유지
  assert.equal(task.qc_status, 'pending');
});

//   ── §1. QC PASS · SoT success → done 가능 ────
test('QC PASS · SoT + Matrix verify 성공 → done', async () => {
  const task = {
    id: 2, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 43,
    listing_id: 'X-2', listing_url: 'https://x.com', selling_price: 5000,
  };
  const sllRows = [];
  const plRows = [];
  const matrixRow = { sku_master_id: 43, channel: 'coupang', channel_status: 'LIVE', listing_id: 'X-2', raw_status: 'active' };
  const db = makeStubDb({
    team_tasks: { rows: [task] },
    sku_master: { rows: [{ id: 43, internal_sku: 'PMC-43', title: 't' }] },
    sku_listing_link: { rows: sllRows },
    platform_listings: { rows: plRows },
    v_sku_channel_matrix: { rows: [matrixRow] },
  });
  const r = await acts.qcPass({ db, taskId: 2, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'QC_PASSED');
  assert.equal(task.status, 'done');
  assert.equal(task.qc_status, 'pass');
});

//   ── §3. Channel Matrix verification 실패 → done 금지 ─
test('QC PASS · Matrix verification 실패 → CHANNEL_MATRIX_NOT_LIVE', async () => {
  const task = {
    id: 3, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 44,
    listing_id: 'X-3', listing_url: 'https://x.com', selling_price: 3000,
  };
  const db = makeStubDb({
    team_tasks: { rows: [task] },
    sku_master: { rows: [{ id: 44, internal_sku: 'PMC-44', title: 't' }] },
    sku_listing_link: { rows: [] },
    platform_listings: { rows: [] },
    //   matrix 는 READY 로 반환 · LIVE 아님
    v_sku_channel_matrix: { rows: [{ sku_master_id: 44, channel: 'coupang', channel_status: 'READY', listing_id: 'X-3' }] },
  });
  const r = await acts.qcPass({ db, taskId: 3, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CHANNEL_MATRIX_NOT_LIVE');
  assert.equal(task.status, 'qc_pending');
  assert.equal(task.qc_status, 'pending');
});

//   ── §3. Matrix verification · listing_id mismatch → done 금지 ─
test('QC PASS · Matrix LIVE 이지만 listing_id 불일치 → NOT_LIVE 반환', async () => {
  const task = {
    id: 4, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 45,
    listing_id: 'X-EXPECTED', listing_url: 'https://x.com', selling_price: 3000,
  };
  const db = makeStubDb({
    team_tasks: { rows: [task] },
    sku_master: { rows: [{ id: 45, internal_sku: 'PMC-45', title: 't' }] },
    sku_listing_link: { rows: [] },
    platform_listings: { rows: [] },
    //   matrix 는 다른 listing_id · LIVE 이지만 mismatch
    v_sku_channel_matrix: { rows: [{ sku_master_id: 45, channel: 'coupang', channel_status: 'LIVE', listing_id: 'X-DIFFERENT' }] },
  });
  const r = await acts.qcPass({ db, taskId: 4, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CHANNEL_MATRIX_NOT_LIVE');
});

//   ── §2. Idempotency · 이미 done + pass 인 task 재요청 no-op success ─
test('QC PASS · 이미 done+pass 재요청은 idempotent success', async () => {
  const task = {
    id: 5, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'done', qc_status: 'pass', related_sku_id: 46,
    listing_id: 'X-5', listing_url: 'https://x.com', selling_price: 3000,
  };
  const db = makeStubDb({ team_tasks: { rows: [task] } });
  const r = await acts.qcPass({ db, taskId: 5, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'QC_PASSED_IDEMPOTENT');
  //   status 변경 없음
  assert.equal(task.status, 'done');
});

//   ── §2. Double-click 방어 · qc_pending 재요청 = 정상 처리 · 두 번째는 이미 done → idempotent ─
test('QC PASS · 재요청 시 첫번째 done · 두번째 idempotent (double-click 방어)', async () => {
  const task = {
    id: 6, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 47,
    listing_id: 'X-6', listing_url: 'https://x.com', selling_price: 3000,
  };
  const db = makeStubDb({
    team_tasks: { rows: [task] },
    sku_master: { rows: [{ id: 47, internal_sku: 'PMC-47', title: 't' }] },
    sku_listing_link: { rows: [] },
    platform_listings: { rows: [] },
    v_sku_channel_matrix: { rows: [{ sku_master_id: 47, channel: 'coupang', channel_status: 'LIVE', listing_id: 'X-6' }] },
  });
  const r1 = await acts.qcPass({ db, taskId: 6, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r1.ok, true);
  assert.equal(r1.code, 'QC_PASSED');
  //   double-click · 재요청
  const r2 = await acts.qcPass({ db, taskId: 6, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r2.ok, true);
  assert.equal(r2.code, 'QC_PASSED_IDEMPOTENT');
});

//   ── §1. TASK missing required fields → 명확한 오류 ─
test('QC PASS · task listing_id NULL → TASK_MISSING_REQUIRED_FIELDS', async () => {
  const task = {
    id: 7, exception_type: 'channel_register.coupang', channel: 'coupang',
    status: 'qc_pending', qc_status: 'pending', related_sku_id: 48,
    listing_id: null, listing_url: 'https://x.com', selling_price: 1000,
  };
  const db = makeStubDb({ team_tasks: { rows: [task] } });
  const r = await acts.qcPass({ db, taskId: 7, user: { id: 99, isAdmin: true, username: 'admin' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TASK_MISSING_REQUIRED_FIELDS');
});

//   ── §7. Wave planning · pure ────────────────────
test('waves · Wave 1 top 3 · Wave 2 next 5 · Wave 3 remaining 8', () => {
  const preview = Array.from({ length: 16 }, (_, i) => ({ sku_master_id: 100 + i }));
  assert.deepEqual(waves.waveSkuIds(preview, 1), [100,101,102]);
  assert.deepEqual(waves.waveSkuIds(preview, 2), [103,104,105,106,107]);
  assert.deepEqual(waves.waveSkuIds(preview, 3), [108,109,110,111,112,113,114,115]);
});
test('waves · Wave count 부족해도 존재하는 만큼만', () => {
  const preview = Array.from({ length: 5 }, (_, i) => ({ sku_master_id: 100 + i }));
  assert.deepEqual(waves.waveSkuIds(preview, 1), [100,101,102]);
  assert.deepEqual(waves.waveSkuIds(preview, 2), [103,104]);   //   5개 중 남은 2개
  assert.deepEqual(waves.waveSkuIds(preview, 3), []);
});
test('waves · planWaves 전체 미리보기 · 총 sku_count 정확', () => {
  const preview = Array.from({ length: 16 }, (_, i) => ({ sku_master_id: 100 + i }));
  const plan = waves.planWaves(preview);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].actual_sku_count, 3);
  assert.equal(plan[1].actual_sku_count, 5);
  assert.equal(plan[2].actual_sku_count, 8);
  const total = plan.reduce((s, w) => s + w.actual_sku_count, 0);
  assert.equal(total, 16);
});
test('waves · invalid wave id → []', () => {
  const preview = Array.from({ length: 16 }, (_, i) => ({ sku_master_id: 100 + i }));
  assert.deepEqual(waves.waveSkuIds(preview, 99), []);
});

//   ── §7. planRefill · skuIds 밖 task 생성 금지 ────
function cand(o = {}) {
  return Object.assign({
    sku_master_id: 1, internal_sku: 'S1', title: 'T', channel: 'coupang',
    channel_status: 'NONE', eligible: true,
    priority_level: 'p0', priority_score: 80,
    stock_qty: 5, unit_cost: 10000, inventory_value_krw: 50000,
    stock_age_days: 46, stock_age_source: 'sku_created_at', stock_age_confidence: 'low',
    ebay_sales_90d: 3, shopify_sales_90d: 0,
    reasons: [],
  }, o);
}
test('planRefill · skuIds 지정 · 그 SKU 만 · 나머지 excluded_not_in_sku_ids 카운트', () => {
  const items = [
    cand({ sku_master_id: 1, channel: 'coupang' }),
    cand({ sku_master_id: 1, channel: 'naver' }),
    cand({ sku_master_id: 2, channel: 'coupang' }),
    cand({ sku_master_id: 3, channel: 'coupang' }),
  ];
  const r = planRefill({
    activeCount: 0, config: { active_queue_target: 300, active_queue_refill_threshold: 200, max_tasks_per_refill: 150, include_p3: 0 },
    candidates: items, existingActiveKeys: new Set(), nowISO: '2026-08-26T00:00:00Z',
    skuIds: [1],
  });
  //   sku=1 의 2개만 · sku=2/3 제외
  assert.equal(r.plan.length, 2);
  assert.equal(r.filtered.excluded_not_in_sku_ids, 2);
  assert.deepEqual(r.plan.map(p => p.related_sku_id), [1, 1]);
});
test('planRefill · Wave max (pilot_max_tasks) 초과 금지', () => {
  const items = Array.from({ length: 200 }, (_, i) => cand({ sku_master_id: i + 1 }));
  const r = planRefill({
    activeCount: 0, config: { active_queue_target: 300, active_queue_refill_threshold: 200, max_tasks_per_refill: 150, include_p3: 0 },
    candidates: items, existingActiveKeys: new Set(), nowISO: '2026-08-26T00:00:00Z',
    pilotMaxTasks: 12,
  });
  assert.equal(r.plan.length, 12);
});

//   ── §10. 권한 · 다른 직원 START 금지 · staff 가 QC 시도 금지 ─
test('startTask · 다른 직원 task START 시도 → NOT_YOUR_TASK', async () => {
  const task = { id: 8, status: 'pending', assignee_id: 100, exception_type: 'channel_register.coupang' };
  const db = makeStubDb({ team_tasks: { rows: [task] } });
  const r = await acts.startTask({ db, taskId: 8, user: { id: 200, isAdmin: false, username: 'other' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_YOUR_TASK');
  //   task 상태 무변경
  assert.equal(task.status, 'pending');
});
test('qcPass · staff (non-admin) 호출 → QC_ADMIN_ONLY', async () => {
  const db = makeStubDb({ team_tasks: { rows: [{ id: 9, status: 'qc_pending' }] } });
  const r = await acts.qcPass({ db, taskId: 9, user: { id: 100, isAdmin: false, username: 'staff' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'QC_ADMIN_ONLY');
});
