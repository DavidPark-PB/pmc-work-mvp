'use strict';

/**
 * tests/services/shippingInternalToken.test.js — PMC-CCOREA-SHIPPING-1B correction (2026-09-13).
 *
 * Owner directive §3 · §7 test coverage:
 *   · timing-safe token comparison
 *   · missing env → 503 (INTERNAL_TOKEN_NOT_CONFIGURED)
 *   · short env → 503 (INTERNAL_TOKEN_TOO_SHORT)
 *   · missing/invalid bearer → 401
 *   · valid bearer → next() called + req.isInternalCall=true
 *   · admin cookies never accepted
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO     = path.resolve(__dirname, '../..');
const MW_PATH  = path.join(REPO, 'src/middleware/internalToken.js');

const OK_TOKEN = 'a'.repeat(32);   //   32 chars — well over MIN_TOKEN_LENGTH

function makeCtx({ authorization, cookie } = {}) {
  const req = {
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(cookie ? { cookie } : {}),
    },
  };
  let nextCalled = false;
  let statusCode = null;
  let body = null;
  const res = {
    status(code) { statusCode = code; return res; },
    json(payload) { body = payload; return res; },
  };
  const next = () => { nextCalled = true; };
  return { req, res, next, get: () => ({ nextCalled, statusCode, body }) };
}

function loadFreshMiddleware() {
  delete require.cache[require.resolve(MW_PATH)];
  return require(MW_PATH);
}

test('TOKEN-A · env unset → 503 INTERNAL_TOKEN_NOT_CONFIGURED', () => {
  delete process.env.SHIPPING_QUOTE_INTERNAL_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ authorization: `Bearer ${OK_TOKEN}` });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, 'INTERNAL_TOKEN_NOT_CONFIGURED');
  assert.equal(r.nextCalled, false);
});

test('TOKEN-B · env too short → 503 INTERNAL_TOKEN_TOO_SHORT', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = 'short';
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ authorization: `Bearer short` });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, 'INTERNAL_TOKEN_TOO_SHORT');
  assert.equal(r.nextCalled, false);
});

test('TOKEN-C · missing Authorization header → 401', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({});
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'INVALID_INTERNAL_TOKEN');
  assert.equal(r.nextCalled, false);
});

test('TOKEN-D · wrong bearer token → 401 (no token echo)', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ authorization: `Bearer ${'b'.repeat(32)}` });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'INVALID_INTERNAL_TOKEN');
  assert.ok(!('message' in (r.body || {})) || !/[a-zA-Z0-9]{32}/.test(String(r.body.message || '')),
    'error body MUST NOT echo the received or expected token');
});

test('TOKEN-E · admin browser cookie IGNORED — cookie is not a substitute for bearer', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ cookie: 'pmc_session=admin-session-value' });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, 401, 'cookie MUST NOT authenticate this endpoint');
  assert.equal(r.nextCalled, false);
});

test('TOKEN-F · valid bearer → next() + req.isInternalCall=true', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ authorization: `Bearer ${OK_TOKEN}` });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  assert.equal(r.statusCode, null, 'no error status');
  assert.equal(r.nextCalled, true);
  assert.equal(c.req.isInternalCall, true);
});

test('TOKEN-G · timing-safe compare returns false on length mismatch (never throws)', () => {
  const { _safeEqual } = loadFreshMiddleware();
  assert.equal(_safeEqual('abc', 'abcdef'), false);
  assert.equal(_safeEqual('abcdef', 'abc'),  false);
  assert.equal(_safeEqual('same-length', 'same-length'), true);
  assert.equal(_safeEqual('same-length', 'same_length'), false);
});

test('TOKEN-H · token never appears in error response body', () => {
  process.env.SHIPPING_QUOTE_INTERNAL_TOKEN = OK_TOKEN;
  const { requireInternalToken } = loadFreshMiddleware();
  const c = makeCtx({ authorization: `Bearer wrong-value-of-sufficient-length-1234` });
  requireInternalToken(c.req, c.res, c.next);
  const r = c.get();
  const bodyStr = JSON.stringify(r.body || {});
  assert.ok(!bodyStr.includes(OK_TOKEN), 'expected token MUST NOT leak into response');
  assert.ok(!bodyStr.includes('wrong-value-of-sufficient-length-1234'),
    'received token MUST NOT leak into response');
});
