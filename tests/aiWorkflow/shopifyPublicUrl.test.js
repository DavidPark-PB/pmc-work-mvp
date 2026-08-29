'use strict';
/**
 * shopifyPublicUrl.test.js — createProduct 응답의 publicUrl 구성 검증.
 *
 * 배경 (2026-08-30): 이전 코드는 `storeUrl.replace('.myshopify.com','')` 로
 *   도메인을 잘라내 `https://ccorea/products/...` 같은 잘못된 URL 을 만들어
 *   DNS_PROBE_FINISHED_NXDOMAIN 을 유발. 사장님이 실제 등록된 상품을 열기 못 함.
 *
 * 우선순위: p.online_store_url > SHOPIFY_PUBLIC_DOMAIN env > storeUrl
 */
const test = require('node:test');
const assert = require('node:assert/strict');

//   axios / config 부작용 회피 — env 만 세팅 후 lazy require.
process.env.SHOPIFY_STORE_URL = 'ccorea.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';

const ShopifyAPI = require('../../src/api/shopifyAPI');

// axios post 를 stub · createProduct 내부 호출 가로챔.
const axios = require('axios');
let stubbedResponse = null;
const originalPost = axios.post;
function stubPost(product) {
  stubbedResponse = { data: { product } };
  axios.post = async () => stubbedResponse;
}
function restorePost() { axios.post = originalPost; }

const baseInput = {
  title: 't', bodyHtml: '', sku: 'S1', price: 10,
  productType: 'X', vendor: 'PMC', tags: '', status: 'active',
  inventoryPolicy: 'deny', quantity: 1,
};

//   ── 1) 응답에 online_store_url 있으면 그대로 반환 ──
test('createProduct — online_store_url 이 최우선 (커스텀 도메인 포함 정확한 URL)', async () => {
  delete process.env.SHOPIFY_PUBLIC_DOMAIN;
  stubPost({
    id: 111, handle: 'my-handle', variants: [{ id: 999 }],
    online_store_url: 'https://ccorea.com/products/my-handle',
  });
  const api = new ShopifyAPI();
  const r = await api.createProduct({ ...baseInput });
  assert.equal(r.publicUrl, 'https://ccorea.com/products/my-handle');
  restorePost();
});

//   ── 2) online_store_url 없고 SHOPIFY_PUBLIC_DOMAIN 있으면 그것 사용 ──
test('createProduct — SHOPIFY_PUBLIC_DOMAIN env 로 override (online_store_url 부재 시)', async () => {
  process.env.SHOPIFY_PUBLIC_DOMAIN = 'shop.ccorea.com';
  stubPost({ id: 222, handle: 'h', variants: [{ id: 888 }] });
  const api = new ShopifyAPI();
  const r = await api.createProduct({ ...baseInput });
  assert.equal(r.publicUrl, 'https://shop.ccorea.com/products/h');
  delete process.env.SHOPIFY_PUBLIC_DOMAIN;
  restorePost();
});

//   ── 3) 둘 다 없으면 storeUrl 그대로 (myshopify.com — storefront 접근 가능) ──
test('createProduct — fallback: storeUrl 그대로 사용 (더 이상 도메인 자름 없음)', async () => {
  delete process.env.SHOPIFY_PUBLIC_DOMAIN;
  stubPost({ id: 333, handle: 'nail-polish', variants: [{ id: 777 }] });
  const api = new ShopifyAPI();
  const r = await api.createProduct({ ...baseInput });
  assert.equal(r.publicUrl, 'https://ccorea.myshopify.com/products/nail-polish');
  //   가장 중요한 회귀 방지: 절대 `https://ccorea/products/...` 같은 broken 형태 안 됨.
  assert.doesNotMatch(r.publicUrl, /^https:\/\/ccorea\//);
  restorePost();
});

//   ── 4) adminUrl 은 항상 storeUrl 사용 (변경 없음) ──
test('createProduct — adminUrl 은 항상 storeUrl 그대로', async () => {
  delete process.env.SHOPIFY_PUBLIC_DOMAIN;
  stubPost({ id: 444, handle: 'x', variants: [{ id: 1 }] });
  const api = new ShopifyAPI();
  const r = await api.createProduct({ ...baseInput });
  assert.equal(r.adminUrl, 'https://ccorea.myshopify.com/admin/products/444');
  restorePost();
});
