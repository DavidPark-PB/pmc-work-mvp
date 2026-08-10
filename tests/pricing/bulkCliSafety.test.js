'use strict';

/**
 * bulkCliSafety.test.js — Phase 1 Commit 7
 * ---------------------------------------------------------------------------
 * Owner decision (2026-08-10): full gate wiring for the bulk price+shipping
 * CLI is DEFERRED until the shipping domain is folded in (Phase 2). Reason:
 * the CLI uses ReviseItem which atomically writes StartPrice AND
 * ShippingServiceCost in one XML request, and PriceExecutionGate + price_events
 * only model price. Splitting the write would break atomicity; extending
 * the gate is a larger change than this phase allows.
 *
 * This commit ships the minimum safety guards that must not regress:
 *
 *   1. dryRun defaults to TRUE. Only an explicit --live (or {live:true})
 *      opts triggers a real marketplace write. --dry-run stays supported.
 *   2. --live prints a warning and waits 5s (deterrent + Ctrl+C window).
 *   3. Requiring the file no longer auto-runs the CLI. Only
 *      `require.main === module` triggers execution.
 *   4. Help text warns that this CLI bypasses the gate and lists Phase 2
 *      as the target for gate wiring.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC_PATH = path.join(__dirname, '../../src/sync/sync-ebay-price-shipping.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/* ─────────────────────────── 1. dryRun default flipped ─────────────────────────── */

test('dryRun defaults to TRUE unless opts.live is explicitly true', () => {
  // The relevant block is inside syncEbayPriceShipping(). Grep for the
  // safety comment and the explicit derivation.
  assert.match(SRC, /dryRun default is TRUE/);
  assert.match(SRC, /live \? false :/);
});

test('CLI parsing forces dryRun=true unless --live is present', () => {
  // The CLI options block: dryRun: args.includes('--dry-run') ? true : !args.includes('--live')
  assert.match(SRC, /!args\.includes\(['"]--live['"]\)/);
});

test('LIVE mode prints a warning and waits 5s before running', () => {
  assert.match(SRC, /LIVE MODE/);
  assert.match(SRC, /Ctrl\+C/);
  // The 5s wait guard
  assert.match(SRC, /await new Promise\(r => setTimeout\(r, 5000\)\);/);
});

/* ─────────────────────────── 2. require-time auto-run removed ─────────────────────────── */

test('require() no longer auto-runs the CLI (module.exports guarded)', () => {
  assert.match(SRC, /require\.main === module/);
  assert.match(SRC, /module\.exports\s*=\s*\{[\s\S]*syncEbayPriceShipping[\s\S]*EbayPriceShippingSync/);
});

test('AUDIT: no top-level unconditional syncEbayPriceShipping(options) call', () => {
  // Ensure the previous "syncEbayPriceShipping(options);" at file-scope is
  // gone — it must be inside the require.main guard.
  const lines = SRC.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*syncEbayPriceShipping\(options\);/.test(line)) {
      // Any occurrence must be within the require.main block.
      const preceding = lines.slice(Math.max(0, i - 5), i).join('\n');
      assert.match(preceding, /require\.main === module/,
        `syncEbayPriceShipping(options) call at line ${i + 1} not guarded by require.main`);
    }
  }
});

/* ─────────────────────────── 3. Help text carries the gate-bypass warning ─────────────────────────── */

test('help text warns that CLI bypasses the gate', () => {
  assert.match(SRC, /PriceExecutionGate 를 아직 통과하지 않습니다/);
  assert.match(SRC, /Phase 2/);
});

test('help text lists --live with a warning', () => {
  assert.match(SRC, /--live/);
  assert.match(SRC, /\[위험\]/);
});

/* ─────────────────────────── 4. Behavioural check by requiring the module ─────────────────────────── */

test('requiring the module does NOT trigger syncEbayPriceShipping', () => {
  // If require() ran the CLI, this test itself would throw or hang trying
  // to read Google credentials. Simply requiring should return a plain
  // exports object.
  const mod = require('../../src/sync/sync-ebay-price-shipping.js');
  assert.equal(typeof mod.syncEbayPriceShipping, 'function');
  assert.equal(typeof mod.EbayPriceShippingSync, 'function');
});

test('EbayPriceShippingSync class is exported (needed for future gate integration)', () => {
  const mod = require('../../src/sync/sync-ebay-price-shipping.js');
  const inst = new mod.EbayPriceShippingSync();
  assert.equal(typeof inst.updatePriceAndShipping, 'function');
});

/* ─────────────────────────── 5. Direct-mode invocation still bypasses gate ─────────────────────────── */

test('AUDIT: syncEbayPriceShipping still uses its own updatePriceAndShipping (gate deferred)', () => {
  // This is intentionally green today. When Commit N adds shipping-aware
  // gate wiring, this assertion should be flipped to require gate use.
  assert.match(SRC, /new EbayPriceShippingSync\(\)/);
  assert.match(SRC, /ebay\.updatePriceAndShipping\(/);
  // priceExecutionGate is NOT imported here yet — that's the deferred state
  assert.equal(/require\(['"].*priceExecutionGate['"]\)/.test(SRC), false,
    'gate import unexpectedly present — Commit 7 was supposed to defer this');
});
