'use strict';

/**
 * priceExecutionGate.test.js — Phase 1 Commit 2 unit tests
 * ---------------------------------------------------------------------------
 * Zero real I/O. In-memory Supabase-shaped mock + in-memory eBay stub.
 * Real marketplace is never contacted, per owner directive.
 *
 * Covered scenarios (owner directive 2026-08-10):
 *   1. kill_switch=true → BLOCK, marketplace 0 calls
 *   2. guardrail read failure → BLOCK (fail-closed)
 *   3. AUTO + auto_apply_enabled=false → BLOCK
 *   4. MANUAL_APPROVED + auto_apply_enabled=false → still allowed
 *   5. MANUAL_DIRECT + kill_switch=true → still BLOCKED
 *   6. Missing request_id / sku / itemId → BLOCK, no run row created
 *   7. Invalid newPrice (NaN, negative, 0, > 1e6) → BLOCK
 *   8. Unsupported currency → BLOCK
 *   9. Invalid context string → BLOCK
 *  10. Happy path AUTO → PriceApplied event + ebay_products UPDATE
 *  11. eBay API throws → PriceFailed event, ebay_products NOT updated
 *  12. eBay API returns success:false → PriceFailed event, ebay_products NOT updated
 *  13. Idempotency: same request_id reissued after success → IDEMPOTENT_REPLAY
 *  14. Idempotency: same request_id reissued after failure → IDEMPOTENT_REPLAY
 *  15. Idempotency: same request_id while prior still pending → BLOCKED (concurrent)
 *  16. State-sync failure (ebay_products.update error) still keeps PriceApplied
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../../src/services/priceExecutionGate');
const { OUTCOME, GATE_REASON, executePriceWrite } = gate;

/* ─────────────────────────── Mock harness ─────────────────────────── */

function makeMocks({
  guardrails = { kill_switch: false, auto_apply_enabled: true },
  guardrailsError = null,
  ebayResponse = { success: true },
  ebayThrow = null,
  updateEbayProductsError = null,
} = {}) {
  const automationRuns = [];       // in-memory table
  const priceEvents = [];
  const ebayProductsUpdates = [];  // capture UPDATE calls
  const ebayCalls = [];

  let nextRunId = 1;
  let nextEventId = 1;

  // Supabase-shaped fluent mock. Only the surface the gate actually uses.
  const db = {
    from(table) {
      return {
        // insert(...).select(...).single()
        insert(row) {
          if (table === 'automation_runs') {
            // enforce UNIQUE(request_id)
            if (row.request_id && automationRuns.some(r => r.request_id === row.request_id)) {
              return {
                select() { return { single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint uq_automation_runs_request_id' },
                }) }; },
              };
            }
            const id = nextRunId++;
            automationRuns.push({ id, ...row });
            return {
              select() { return { single: async () => ({ data: { id }, error: null }) }; },
            };
          }
          if (table === 'price_events') {
            const id = nextEventId++;
            priceEvents.push({ id, ...row });
            return {
              select() { return { single: async () => ({ data: { id }, error: null }) }; },
            };
          }
          throw new Error(`unexpected insert into ${table}`);
        },
        // update(patch).eq(col, val)
        update(patch) {
          return {
            eq(col, val) {
              if (table === 'automation_runs') {
                const target = automationRuns.find(r => r[col] === val);
                if (target) Object.assign(target, patch);
                return Promise.resolve({ error: null });
              }
              if (table === 'ebay_products') {
                ebayProductsUpdates.push({ col, val, patch });
                return Promise.resolve({ error: updateEbayProductsError });
              }
              throw new Error(`unexpected update on ${table}`);
            },
          };
        },
        // select(...).eq(col, val).maybeSingle()
        select() {
          return {
            eq(col, val) {
              return {
                maybeSingle: async () => {
                  if (table === 'automation_runs') {
                    const row = automationRuns.find(r => r[col] === val) || null;
                    return { data: row, error: null };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  const ebay = {
    updateItem: async (itemId, opts) => {
      ebayCalls.push({ itemId, opts });
      if (ebayThrow) throw ebayThrow;
      return ebayResponse;
    },
  };

  const getGuardrails = async () => {
    if (guardrailsError) throw guardrailsError;
    return guardrails;
  };

  const publishPriceEvent = async (ev) => {
    const id = nextEventId++;
    priceEvents.push({ id, ...ev });
    return id;
  };

  return {
    deps: { db, ebay, getGuardrails, publishPriceEvent, now: () => new Date('2026-08-10T00:00:00Z') },
    automationRuns, priceEvents, ebayProductsUpdates, ebayCalls,
  };
}

const HEALTHY_REQ = () => ({
  sku: 'PMC-TEST-001', itemId: '236000000001',
  oldPrice: 62, newPrice: 59, reasonCode: 'AUTO_UNDERCUT_SAFE',
  requestId: 'test-req-' + Math.random().toString(36).slice(2, 10),
  context: 'AUTO', actor: 'system',
});

/* ─────────────────────────── 1-9: BLOCK scenarios ─────────────────────────── */

test('1. kill_switch=true → BLOCK, marketplace 0 calls, PriceBlocked event', async () => {
  const m = makeMocks({ guardrails: { kill_switch: true, auto_apply_enabled: true } });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.KILL_SWITCH);
  assert.equal(m.ebayCalls.length, 0);
  assert.equal(m.ebayProductsUpdates.length, 0);
  const blocked = m.priceEvents.filter(e => e.event_type === 'PriceBlocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].confidence_snapshot.gate_reason, GATE_REASON.KILL_SWITCH);
});

test('2. guardrail read failure → BLOCK (fail-closed), marketplace 0 calls', async () => {
  const m = makeMocks({ guardrailsError: new Error('supabase timeout') });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.GUARDRAIL_READ_FAILED);
  assert.equal(m.ebayCalls.length, 0);
  assert.equal(m.ebayProductsUpdates.length, 0);
});

test('3. AUTO + auto_apply_enabled=false → BLOCK', async () => {
  const m = makeMocks({ guardrails: { kill_switch: false, auto_apply_enabled: false } });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.AUTO_APPLY_DISABLED);
  assert.equal(m.ebayCalls.length, 0);
});

test('3b. SYSTEM + auto_apply_enabled=false → BLOCK (same policy as AUTO)', async () => {
  const m = makeMocks({ guardrails: { kill_switch: false, auto_apply_enabled: false } });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'SYSTEM' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.AUTO_APPLY_DISABLED);
});

test('4. MANUAL_APPROVED + auto_apply_enabled=false → still allowed (human decided)', async () => {
  const m = makeMocks({ guardrails: { kill_switch: false, auto_apply_enabled: false } });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'MANUAL_APPROVED', actor: 'user:1' }, m.deps);
  assert.equal(r.outcome, OUTCOME.APPLIED);
  assert.equal(m.ebayCalls.length, 1);
});

test('4b. MANUAL_DIRECT + auto_apply_enabled=false → still allowed (owner override)', async () => {
  const m = makeMocks({ guardrails: { kill_switch: false, auto_apply_enabled: false } });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'MANUAL_DIRECT', actor: 'user:1' }, m.deps);
  assert.equal(r.outcome, OUTCOME.APPLIED);
});

test('5. MANUAL_DIRECT + kill_switch=true → still BLOCKED (kill switch is absolute)', async () => {
  const m = makeMocks({ guardrails: { kill_switch: true, auto_apply_enabled: false } });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'MANUAL_DIRECT', actor: 'user:1' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.KILL_SWITCH);
  assert.equal(m.ebayCalls.length, 0);
});

test('5b. MANUAL_APPROVED + kill_switch=true → BLOCKED', async () => {
  const m = makeMocks({ guardrails: { kill_switch: true, auto_apply_enabled: true } });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'MANUAL_APPROVED' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.KILL_SWITCH);
});

test('6a. Missing requestId → BLOCK, no automation_runs row', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), requestId: undefined }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.MISSING_REQUEST_ID);
  assert.equal(m.automationRuns.length, 0);
  assert.equal(m.ebayCalls.length, 0);
});

test('6b. Missing sku → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), sku: '' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.MISSING_IDENTIFIERS);
});

test('6c. Missing itemId → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), itemId: '' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.MISSING_IDENTIFIERS);
});

test('7a. newPrice NaN → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), newPrice: NaN }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.INVALID_PRICE);
});

test('7b. newPrice ≤ 0 → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), newPrice: 0 }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.INVALID_PRICE);
});

test('7c. newPrice > 1e6 → BLOCK (impossible price)', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), newPrice: 5_000_000 }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.INVALID_PRICE);
});

test('7d. newPrice Infinity → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), newPrice: Infinity }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.INVALID_PRICE);
});

test('8. Unsupported currency → BLOCK (v1 = USD only)', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), currency: 'KRW' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.UNSUPPORTED_CURRENCY);
});

test('9. Invalid context → BLOCK', async () => {
  const m = makeMocks();
  const r = await executePriceWrite({ ...HEALTHY_REQ(), context: 'ROOT' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.equal(r.reasonCode, GATE_REASON.INVALID_CONTEXT);
});

/* ─────────────────────────── 10-12: Marketplace outcome ─────────────────────────── */

test('10. Happy AUTO → PriceApplied + ebay_products.update, no PriceBlocked/Failed', async () => {
  const m = makeMocks();
  const req = HEALTHY_REQ();
  const r = await executePriceWrite(req, m.deps);
  assert.equal(r.outcome, OUTCOME.APPLIED);
  assert.equal(m.ebayCalls.length, 1);
  assert.equal(m.ebayCalls[0].itemId, req.itemId);
  assert.equal(m.ebayCalls[0].opts.price, req.newPrice);
  assert.equal(m.ebayProductsUpdates.length, 1);
  assert.equal(m.ebayProductsUpdates[0].col, 'item_id');
  assert.equal(m.ebayProductsUpdates[0].val, req.itemId);
  assert.equal(m.ebayProductsUpdates[0].patch.price_usd, req.newPrice);
  const applied = m.priceEvents.filter(e => e.event_type === 'PriceApplied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].new_price, req.newPrice);
  const failed = m.priceEvents.filter(e => e.event_type === 'PriceFailed');
  const blocked = m.priceEvents.filter(e => e.event_type === 'PriceBlocked');
  assert.equal(failed.length, 0);
  assert.equal(blocked.length, 0);
  // automation_runs row is succeeded
  const run = m.automationRuns[0];
  assert.equal(run.status, 'succeeded');
});

test('11. eBay API throws → PriceFailed, ebay_products NOT updated', async () => {
  const m = makeMocks({ ebayThrow: new Error('eBay 500') });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.equal(r.reasonCode, GATE_REASON.MARKETPLACE_FAILED);
  assert.equal(m.ebayCalls.length, 1);
  assert.equal(m.ebayProductsUpdates.length, 0);   // 결정적: DB에 새 가격 안 씀
  const failed = m.priceEvents.filter(e => e.event_type === 'PriceFailed');
  assert.equal(failed.length, 1);
  const applied = m.priceEvents.filter(e => e.event_type === 'PriceApplied');
  assert.equal(applied.length, 0);
  const run = m.automationRuns[0];
  assert.equal(run.status, 'failed');
});

test('12. eBay returns {success:false} → PriceFailed, ebay_products NOT updated', async () => {
  const m = makeMocks({ ebayResponse: { success: false, error: 'InvalidItem' } });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.FAILED);
  assert.equal(m.ebayProductsUpdates.length, 0);
  const failed = m.priceEvents.filter(e => e.event_type === 'PriceFailed');
  assert.equal(failed.length, 1);
});

/* ─────────────────────────── 13-15: Idempotency ─────────────────────────── */

test('13. Same request_id after prior SUCCESS → IDEMPOTENT_REPLAY, no re-execution', async () => {
  const m = makeMocks();
  const req = HEALTHY_REQ();
  const first = await executePriceWrite(req, m.deps);
  assert.equal(first.outcome, OUTCOME.APPLIED);
  assert.equal(m.ebayCalls.length, 1);

  const second = await executePriceWrite(req, m.deps);
  assert.equal(second.outcome, OUTCOME.IDEMPOTENT_REPLAY);
  assert.equal(second.reasonCode, 'PRIOR_SUCCESS');
  assert.equal(m.ebayCalls.length, 1);                    // 마켓 재호출 없음
  assert.equal(m.ebayProductsUpdates.length, 1);          // DB 재갱신 없음
  const applied = m.priceEvents.filter(e => e.event_type === 'PriceApplied');
  assert.equal(applied.length, 1);                        // 이벤트 중복 발행 없음
});

test('14. Same request_id after prior FAILURE → IDEMPOTENT_REPLAY (PRIOR_FAILURE)', async () => {
  const m = makeMocks({ ebayThrow: new Error('eBay 500') });
  const req = HEALTHY_REQ();
  const first = await executePriceWrite(req, m.deps);
  assert.equal(first.outcome, OUTCOME.FAILED);

  const second = await executePriceWrite(req, m.deps);
  assert.equal(second.outcome, OUTCOME.IDEMPOTENT_REPLAY);
  assert.equal(second.reasonCode, 'PRIOR_FAILURE');
  assert.equal(m.ebayCalls.length, 1);                    // 실패건도 재시도 안 함 (요청자가 새 request_id 로 재시도해야)
});

test('15. Concurrent execution: pending row exists → BLOCKED', async () => {
  // Simulate that a run with this request_id already exists in pending state
  // (another gate is mid-flight). Insert one manually then try to reuse.
  const m = makeMocks();
  m.automationRuns.push({
    id: 999, request_id: 'concurrent-key', status: 'pending',
  });
  const r = await executePriceWrite({ ...HEALTHY_REQ(), requestId: 'concurrent-key' }, m.deps);
  assert.equal(r.outcome, OUTCOME.BLOCKED);
  assert.match(r.error || '', /concurrent execution/);
  assert.equal(m.ebayCalls.length, 0);
});

test('15b. Same request_id after prior CANCELLED (blocked) → IDEMPOTENT_REPLAY (PRIOR_BLOCKED)', async () => {
  const m = makeMocks({ guardrails: { kill_switch: true, auto_apply_enabled: true } });
  const req = HEALTHY_REQ();
  const first = await executePriceWrite(req, m.deps);
  assert.equal(first.outcome, OUTCOME.BLOCKED);
  // The automation_runs row is now status='cancelled'
  const second = await executePriceWrite(req, m.deps);
  assert.equal(second.outcome, OUTCOME.IDEMPOTENT_REPLAY);
  assert.equal(second.reasonCode, 'PRIOR_BLOCKED');
});

/* ─────────────────────────── 16: Partial failure ─────────────────────────── */

test('16. State-sync error (ebay_products.update fails) still keeps PriceApplied', async () => {
  const m = makeMocks({ updateEbayProductsError: { message: 'connection reset' } });
  const r = await executePriceWrite(HEALTHY_REQ(), m.deps);
  assert.equal(r.outcome, OUTCOME.APPLIED);
  assert.equal(r.stateSyncError, 'connection reset');
  const applied = m.priceEvents.filter(e => e.event_type === 'PriceApplied');
  assert.equal(applied.length, 1);                  // 이벤트는 남음 (진실 근거)
  const run = m.automationRuns[0];
  assert.equal(run.status, 'succeeded');            // 마켓 성공은 succeeded
  assert.equal(run.output_snapshot.state_sync_error, 'connection reset');
});

/* ─────────────────────────── 17: PriceApplied event content ─────────────────────────── */

test('17. PriceApplied event carries reason_code / actor / competitor_ref / landing_cost', async () => {
  const m = makeMocks();
  const req = {
    ...HEALTHY_REQ(),
    actor: 'user:42',
    competitorRef: { seller_id: 'raon-kr', competitor_item_id: '111', competitor_total: 60 },
    confidenceSnapshot: { identity: 0.99, price: 1, cost: 1, supplier: 1, overall: 0.99 },
    landingCost: 44.78,
    ruleVersion: 'engine1-v1.0.0',
  };
  const r = await executePriceWrite(req, m.deps);
  assert.equal(r.outcome, OUTCOME.APPLIED);
  const ev = m.priceEvents.find(e => e.event_type === 'PriceApplied');
  assert.equal(ev.reason_code, 'AUTO_UNDERCUT_SAFE');
  assert.equal(ev.actor, 'user:42');
  assert.deepEqual(ev.competitor_ref, req.competitorRef);
  assert.deepEqual(ev.confidence_snapshot, req.confidenceSnapshot);
  assert.equal(ev.landing_cost, 44.78);
  assert.equal(ev.rule_version, 'engine1-v1.0.0');
});
