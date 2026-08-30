'use strict';
/**
 * browseCache.test.js — _fetchViaBrowseAPI in-memory 캐시 검증.
 *
 * 배경 (2026-08-30 · Approach 1 #3): 같은 legacy itemId 를 CompetitorMonitor +
 *   MyListingRefresher + CompListingRefresher + killPricingDailyJob + battle UI
 *   가 각기 호출 → Browse quota 낭비. 5분 TTL module-level Map 캐시 도입.
 *
 * 검증:
 *   1) 같은 itemId 재호출 → 캐시 hit · axios 안 부름
 *   2) 다른 itemId → miss · axios 부름
 *   3) TTL 만료 후 → 다시 miss
 *   4) 실패 (throw) 는 캐시 안 됨 (다음 호출은 재시도)
 *   5) max-size 초과 시 가장 오래된 entry 축출
 *   6) module-level 이므로 여러 EbayAPI 인스턴스 간 공유
 */

// TTL 짧게 · 테스트 격리
process.env.EBAY_BROWSE_CACHE_TTL_MS = '200';
process.env.EBAY_BROWSE_CACHE_MAX = '3';
process.env.EBAY_APP_ID = 'x';
process.env.EBAY_CERT_ID = 'x';
process.env.EBAY_DEV_ID = 'x';
process.env.EBAY_USER_TOKEN = 'x';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const EbayAPI = require('../../src/api/ebayAPI');
const { clearBrowseCache, getBrowseCacheStats } = EbayAPI;

// axios.get 스텁 · 호출 카운트 캡처
const originalGet = axios.get;
let getCalls = [];
let responseByItemId = {};
function stubAxios() {
  getCalls = [];
  axios.get = async (url) => {
    getCalls.push(url);
    const m = url.match(/legacy_item_id=(\d+)/);
    const id = m ? m[1] : 'unknown';
    if (responseByItemId[id] === '__throw__') {
      const err = new Error('simulated 500');
      err.response = { data: { errors: [{ errorId: 500, longMessage: 'boom' }] } };
      throw err;
    }
    const r = responseByItemId[id] || { legacyItemId: id, title: `T${id}`, price: { value: '10', currency: 'USD' } };
    return { data: r };
  };
}
function restoreAxios() { axios.get = originalGet; }

function makeApi() {
  const api = new EbayAPI();
  // token 조회 skip
  api.getApplicationToken = async () => 'stub-token';
  return api;
}

test.beforeEach(() => { clearBrowseCache(); stubAxios(); });
test.afterEach(() => { restoreAxios(); });

//   ── 1) 같은 itemId 재호출 → hit · axios 1회만 ──
test('같은 itemId 재호출 → 캐시 hit · Browse API 1회만 호출', async () => {
  const api = makeApi();
  responseByItemId['111'] = { legacyItemId: '111', title: 'A', price: { value: '20', currency: 'USD' } };
  const r1 = await api._fetchViaBrowseAPI('111');
  const r2 = await api._fetchViaBrowseAPI('111');
  const r3 = await api._fetchViaBrowseAPI('111');
  assert.equal(getCalls.length, 1);
  assert.equal(r1.title, 'A');
  assert.equal(r2.title, 'A');
  assert.equal(r3.title, 'A');
  const s = getBrowseCacheStats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
});

//   ── 2) 다른 itemId → 각각 miss ──
test('다른 itemId → 각각 miss · 각 1회씩 호출', async () => {
  const api = makeApi();
  await api._fetchViaBrowseAPI('111');
  await api._fetchViaBrowseAPI('222');
  await api._fetchViaBrowseAPI('333');
  assert.equal(getCalls.length, 3);
  assert.equal(getBrowseCacheStats().misses, 3);
});

//   ── 3) TTL 만료 후 다시 miss ──
test('TTL 만료 (200ms) 이후 다시 miss → axios 재호출', async () => {
  const api = makeApi();
  await api._fetchViaBrowseAPI('111');
  await new Promise(r => setTimeout(r, 260));
  await api._fetchViaBrowseAPI('111');
  assert.equal(getCalls.length, 2);
  const s = getBrowseCacheStats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 2);
});

//   ── 4) 실패는 캐시 안 됨 (재시도 가능) ──
test('axios throw → 캐시 저장 안 됨 · 다음 호출은 재시도', async () => {
  const api = makeApi();
  responseByItemId['999'] = '__throw__';
  await assert.rejects(() => api._fetchViaBrowseAPI('999'));
  responseByItemId['999'] = { legacyItemId: '999', title: 'ok', price: { value: '5', currency: 'USD' } };
  const r = await api._fetchViaBrowseAPI('999');
  assert.equal(r.title, 'ok');
  assert.equal(getCalls.length, 2);
});

//   ── 5) max-size 초과 시 가장 오래된 축출 ──
test('BROWSE_CACHE_MAX(3) 초과 시 가장 오래된 entry 부터 축출', async () => {
  const api = makeApi();
  await api._fetchViaBrowseAPI('1');
  await api._fetchViaBrowseAPI('2');
  await api._fetchViaBrowseAPI('3');
  assert.equal(getBrowseCacheStats().size, 3);
  await api._fetchViaBrowseAPI('4');   // 4 추가 · 1 축출
  assert.equal(getBrowseCacheStats().size, 3);
  // 1 은 축출됐으므로 재호출 시 miss (axios 재호출)
  const before = getCalls.length;
  await api._fetchViaBrowseAPI('1');
  assert.equal(getCalls.length, before + 1);
  // 4 는 캐시에 있으므로 hit
  const before2 = getCalls.length;
  await api._fetchViaBrowseAPI('4');
  assert.equal(getCalls.length, before2);
});

//   ── 6) 여러 인스턴스 간 공유 ──
test('module-level 캐시 · 여러 EbayAPI 인스턴스가 공유', async () => {
  const a1 = makeApi();
  const a2 = makeApi();
  await a1._fetchViaBrowseAPI('111');
  await a2._fetchViaBrowseAPI('111');   // hit — 인스턴스 다르지만 캐시 공유
  assert.equal(getCalls.length, 1);
});
