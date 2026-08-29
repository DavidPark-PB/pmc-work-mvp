'use strict';
/**
 * publicationMonitor.test.js — aiPublicationMonitor.runSweep 단위 테스트.
 *
 * 통합 커버:
 *   1) 가격 하락 시 exception task 생성 + min_seen 갱신
 *   2) 하락 없으면 알림 없음 · last_checked_at 만 갱신
 *   3) Browse 404 → ended_at 세팅 · 향후 sweep 제외
 *   4) Browse 에러 → skip 카운트 · 다른 pair 계속 진행
 *   5) currentPrice / prevLow 결측 → skip (알림 없음)
 *
 * 실제 DB / eBay 호출 없이 stub 로 격리.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../../src/services/aiPublicationMonitor');

// ── 최소 DB stub ──
//   from(table).select().is().gt().order().limit()      → { data: pairs, error: null }
//   from(table).update(patch).eq('id', id)              → captured
function makeDb(pairs) {
  const updates = [];
  const chain = {
    select() { return chain; },
    is() { return chain; },
    gt() { return chain; },
    order() { return chain; },
    limit() { return Promise.resolve({ data: pairs, error: null }); },
    update(patch) {
      return {
        eq(_col, id) {
          updates.push({ id, patch });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return {
    _updates: updates,
    from(_t) { return chain; },
  };
}

// ── eBay Browse API stub ──
function makeEbay(priceByItemId) {
  return {
    async _fetchViaBrowseAPI(itemId) {
      const v = priceByItemId[itemId];
      if (v === '__404__') return null;
      if (v === '__throw__') throw new Error('Browse network error');
      return { price: v };
    },
  };
}

// ── exceptionSvc stub · 호출 캡처 ──
function makeExceptionSvc() {
  const calls = [];
  return {
    _calls: calls,
    async createExceptionTask(opts) {
      calls.push(opts);
      return { task: { id: 999 }, deduped: false, recipientCount: 1 };
    },
  };
}

const P0 = {
  id: 1, my_ebay_item_id: 'ME1', competitor_item_id: 'C1',
  my_publish_price: 20, competitor_price_at_publish: 30,
  competitor_min_seen_price: 30,
};

//   ── 1) 하락 · 알림 생성 + min_seen 갱신 ──
test('runSweep — 경쟁사 가격 하락 시 exception task 생성 · min_seen 갱신', async () => {
  const db = makeDb([{ ...P0 }]);
  const ebay = makeEbay({ C1: 25 });   // 30 → 25 하락
  const exc = makeExceptionSvc();

  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });

  assert.equal(r.checked, 1);
  assert.equal(r.alerts, 1);
  assert.equal(r.ended, 0);
  assert.equal(exc._calls.length, 1);
  const call = exc._calls[0];
  assert.equal(call.exceptionType, 'COMPETITOR_PRICE_DROP');
  assert.equal(call.scope, 'operators');
  assert.equal(call.dedupeKey, 'ai_wf_undercut:1');
  assert.match(call.title, /25\.00/);
  assert.match(call.title, /30\.00/);
  assert.equal(call.context.publication_id, 1);
  assert.equal(call.context.competitor_current_price, 25);
  assert.equal(call.context.competitor_prev_low, 30);

  // update 로 min_seen 25 · last_alerted_at · last_competitor_price 25 · last_checked_at 세팅
  assert.equal(db._updates.length, 1);
  const u = db._updates[0].patch;
  assert.equal(u.competitor_min_seen_price, 25);
  assert.equal(u.last_competitor_price, 25);
  assert.ok(u.last_alerted_at);
  assert.ok(u.last_checked_at);
});

//   ── 2) 상승/동가 · 알림 없음 ──
test('runSweep — 상승·동가 시 알림 없음 · last_checked_at 만 갱신', async () => {
  const db = makeDb([{ ...P0 }]);
  const ebay = makeEbay({ C1: 35 });   // 상승
  const exc = makeExceptionSvc();

  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });

  assert.equal(r.checked, 1);
  assert.equal(r.alerts, 0);
  assert.equal(exc._calls.length, 0);
  const u = db._updates[0].patch;
  assert.equal(u.competitor_min_seen_price, undefined);   // 미갱신
  assert.equal(u.last_alerted_at, undefined);
  assert.equal(u.last_competitor_price, 35);
  assert.ok(u.last_checked_at);
});

test('runSweep — 정확히 같은 가격 시 알림 없음 (strictly less-than)', async () => {
  const db = makeDb([{ ...P0 }]);
  const ebay = makeEbay({ C1: 30 });
  const exc = makeExceptionSvc();
  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });
  assert.equal(r.alerts, 0);
});

//   ── 3) Browse 404 → 리스팅 종료 판정 ──
test('runSweep — Browse 404 시 ended_at 세팅 · 알림 없음', async () => {
  const db = makeDb([{ ...P0 }]);
  const ebay = makeEbay({ C1: '__404__' });
  const exc = makeExceptionSvc();
  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });

  assert.equal(r.checked, 1);
  assert.equal(r.ended, 1);
  assert.equal(r.alerts, 0);
  assert.equal(exc._calls.length, 0);
  const u = db._updates[0].patch;
  assert.ok(u.ended_at);
  assert.ok(u.last_checked_at);
});

//   ── 4) Browse 에러 → skip · 다른 pair 계속 ──
test('runSweep — Browse 에러 발생 pair 는 skip · 다른 pair 는 정상 진행', async () => {
  const p1 = { ...P0, id: 1, competitor_item_id: 'C1' };
  const p2 = { ...P0, id: 2, competitor_item_id: 'C2' };
  const db = makeDb([p1, p2]);
  const ebay = makeEbay({ C1: '__throw__', C2: 25 });
  const exc = makeExceptionSvc();
  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });

  assert.equal(r.checked, 2);
  assert.equal(r.skipped, 1);         // C1
  assert.equal(r.alerts, 1);          // C2
  assert.equal(exc._calls.length, 1);
  assert.equal(exc._calls[0].context.competitor_item_id, 'C2');
});

//   ── 5) currentPrice 결측 · 알림 없음 ──
test('runSweep — Browse 응답에 price 없음 시 알림 없음 (강한 파싱)', async () => {
  const db = makeDb([{ ...P0 }]);
  const ebay = {
    async _fetchViaBrowseAPI() { return { price: null }; },
  };
  const exc = makeExceptionSvc();
  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });
  assert.equal(r.alerts, 0);
  const u = db._updates[0].patch;
  assert.equal(u.last_competitor_price, undefined);
  assert.ok(u.last_checked_at);
});

//   ── 6) baseline fallback (min_seen null 이면 price_at_publish 사용) ──
test('runSweep — min_seen NULL 이면 price_at_publish 를 baseline 으로 사용', async () => {
  const pair = { ...P0, competitor_min_seen_price: null };
  const db = makeDb([pair]);
  const ebay = makeEbay({ C1: 25 });   // 30 → 25 하락 (price_at_publish=30 fallback)
  const exc = makeExceptionSvc();
  const r = await monitor.runSweep({ db, ebay, exceptionSvc: exc });
  assert.equal(r.alerts, 1);
  assert.equal(exc._calls[0].context.competitor_prev_low, 30);
});

//   ── 7) 활성 pair 없음 ──
test('runSweep — 활성 pair 0 개 → no-op', async () => {
  const db = makeDb([]);
  const r = await monitor.runSweep({ db, ebay: makeEbay({}), exceptionSvc: makeExceptionSvc() });
  assert.deepEqual(r, { checked: 0, alerts: 0, ended: 0, skipped: 0 });
});

//   ── recordPublication 입력 검증 ──
test('recordPublication — 필수 필드 누락 시 throw', async () => {
  await assert.rejects(() => monitor.recordPublication({}), /required/);
  await assert.rejects(() => monitor.recordPublication({ myEbayItemId: 'X' }), /required/);
  await assert.rejects(() => monitor.recordPublication({ competitorItemId: 'Y' }), /required/);
});
