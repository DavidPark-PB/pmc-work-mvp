'use strict';

/**
 * telegramApprove.test.js — Phase 1 Commit 5C
 * ---------------------------------------------------------------------------
 * Owner directive: gate wiring for Telegram approve is DEFERRED because the
 * callback has no verified admin identity. This test file exists solely to
 * make sure nobody re-enables price mutation on this route without also
 * adding admin authentication.
 *
 * Regression guards:
 *   1. processApprove still displays the disabled notice, no marketplace call.
 *   2. No ebay.updateItem / ReviseItem / ebay_products.update anywhere in the
 *      Telegram webhook module.
 *   3. Any future re-enable MUST first add an admin allowlist check
 *      (from.id whitelist), so we grep for the presence of an allowlist var
 *      guard whenever the file starts calling into ebayAPI or the gate.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC_PATH = path.join(__dirname, '../../src/web/routes/telegramWebhook.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

test('processApprove is currently disabled — displays notice, no marketplace call', () => {
  // The block explicitly announces price mutation is disabled in Hermes v1.
  assert.match(SRC, /가격 변경은 비활성화/);
  assert.match(SRC, /Hermes v1/);
});

test('AUDIT: telegramWebhook has no ebay.updateItem / Revise call', () => {
  assert.equal((SRC.match(/ebay\.updateItem\s*\(/g) || []).length, 0);
  assert.equal((SRC.match(/ReviseFixedPriceItem/g) || []).length, 0);
  assert.equal((SRC.match(/ReviseItem\b/g) || []).length, 0);
});

test('AUDIT: telegramWebhook has no ebay_products mutation', () => {
  assert.equal(/\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*(update|insert|upsert|delete)/.test(SRC), false);
});

test('AUDIT: telegramWebhook does NOT (yet) call priceExecutionGate — deferred until admin auth exists', () => {
  // If this test starts failing, the callback route is now wiring the gate.
  // Before that is allowed, an admin-allowlist check MUST be present. See the
  // companion assertion below.
  const hasGateCall = /priceExecutionGate|executePriceWrite\s*\(/.test(SRC);
  const hasAllowlistCheck =
    /TELEGRAM_ADMIN_USER_IDS/.test(SRC) ||
    /adminIds|adminAllowlist|isAdminUser|isTelegramAdmin/.test(SRC);
  if (hasGateCall) {
    assert.equal(hasAllowlistCheck, true,
      'gate wired into telegramWebhook without an admin allowlist check — refuse to ship');
  } else {
    // Still deferred per owner directive — this branch is the currently
    // intended state.
    assert.equal(hasGateCall, false, 'gate deferred: test intentionally green');
  }
});
