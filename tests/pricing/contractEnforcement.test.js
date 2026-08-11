'use strict';

/**
 * contractEnforcement.test.js — Phase 2-2A
 * ---------------------------------------------------------------------------
 * Verifies the VALID / INVALID_DATA / MISSING_DATA / NO_ROW classifier
 * used by engine1DryRunJob to gate per-SKU pricing decisions.
 *
 * Owner directive (2026-08-11):
 *   MISSING_DATA must NEVER be treated as INVALID.
 *   Only real corruption (negative cost, non-integer weight, ambiguous
 *   scale, NaN/Infinity, unsupported currency) is INVALID.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// The classifier lives inside engine1DryRunJob (module-private). We test it
// by reaching into the file's exports through a small proxy: re-require the
// file, then read the exported helpers. If any of them are missing the
// test fails loudly.
const jobModule = require('../../src/jobs/engine1DryRunJob');

// Re-export shape: for testability we access internals via a small hack —
// engine1DryRunJob exports { runEngine1DryRun, CONFIG }. Classifier is
// private; we instead read the source and evaluate the classifier's
// pure behavioural contract using targeted grep + a shim require that
// runs the classifier in a subprocess-safe way.
//
// Cleaner: run static-audit tests + one integration-shape test that pins
// the coverage counters when the run is short-circuited early.

const SRC_PATH = path.join(__dirname, '../../src/jobs/engine1DryRunJob.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/* ─────────────────────────── 1. Enforcement is wired ─────────────────────────── */

test('AUDIT: engine1DryRunJob defines the 4-way CLASS enum', () => {
  assert.match(SRC, /VALID:\s*'VALID'/);
  assert.match(SRC, /INVALID_DATA:\s*'INVALID_DATA'/);
  assert.match(SRC, /MISSING_DATA:\s*'MISSING_DATA'/);
  assert.match(SRC, /NO_ROW:\s*'NO_ROW'/);
});

test('AUDIT: shared-parameter contract check aborts the run on failure', () => {
  assert.match(SRC, /classifySharedParams/);
  assert.match(SRC, /SHARED CONTRACT VIOLATION/);
  assert.match(SRC, /return \{ total_skus: 0, aborted: 'shared_contract_violation'/);
});

test('AUDIT: per-SKU classifier is called BEFORE engine.decideSku', () => {
  // The classifier must precede the decideSku call in the loop body.
  const loopStart = SRC.indexOf('for (const sku of skus) {');
  assert.notEqual(loopStart, -1);
  const rest = SRC.slice(loopStart);
  const classifierPos = rest.indexOf('classifyPricingInputs(sm)');
  const decidePos = rest.indexOf('engine.decideSku(');
  assert.notEqual(classifierPos, -1, 'classifyPricingInputs must be called in the loop');
  assert.notEqual(decidePos, -1);
  assert.ok(classifierPos < decidePos, 'classifier must run before engine.decideSku');
});

test('AUDIT: INVALID_DATA emits BLOCK_CONTRACT_VIOLATION event, NOT a normal decision', () => {
  assert.match(SRC, /REASON\.BLOCK_CONTRACT_VIOLATION/);
  assert.match(SRC, /coverage\.blocked_contract \+= 1/);
});

test('AUDIT: MISSING_DATA and NO_ROW skip WITHOUT emitting price_events', () => {
  assert.match(SRC, /coverage\.skipped_incomplete \+= 1/);
  // The two branches (MISSING_DATA, NO_ROW) both use `continue;` — they
  // never reach engine.decideSku or the push into decisions[].
  const missingBlock = SRC.match(/if \(cls\.status === CLASS\.MISSING_DATA\) \{[\s\S]*?continue;\s*\}/);
  const noRowBlock = SRC.match(/if \(cls\.status === CLASS\.NO_ROW\) \{[\s\S]*?continue;\s*\}/);
  assert.ok(missingBlock, 'MISSING_DATA branch not found');
  assert.ok(noRowBlock, 'NO_ROW branch not found');
  assert.equal(/decisions\.push/.test(missingBlock[0]), false,
    'MISSING_DATA branch must not push to decisions[]');
  assert.equal(/decisions\.push/.test(noRowBlock[0]), false,
    'NO_ROW branch must not push to decisions[]');
});

test('AUDIT: telemetry counter fields cover the owner-mandated set', () => {
  // Owner directive: valid, invalid, missing_data, no_sku_master,
  // decision_produced, blocked_contract, skipped_incomplete.
  const required = [
    'valid:', 'invalid_data:', 'missing_data:', 'no_sku_master:',
    'decision_produced:', 'blocked_contract:', 'skipped_incomplete:',
  ];
  for (const f of required) {
    assert.match(SRC, new RegExp(f.replace(':', ':\\s*0')));
  }
});

test('AUDIT: coverage telemetry is flushed at run end', () => {
  assert.match(SRC, /_flushCoverageTelemetry\(coverage\)/);
  // Old log-only helper is gone
  assert.equal(/_flushContractViolations/.test(SRC), false,
    'legacy _flushContractViolations should be removed in Phase 2-2A');
});

/* ─────────────────────────── 2. Classifier behavioural contract ─────────────────────────── */

const engine = require('../../src/engines/priceEngine');
const { _internal } = require('../../src/jobs/engine1DryRunJob');
const { classifyPricingInputs, classifySharedParams, CLASS } = _internal;

/* ─── VALID ─── */
test('classifier: cost=1000, weight=500 → VALID', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: 500 });
  assert.equal(r.status, CLASS.VALID);
});

test('classifier: cost=1000, weight=500 + default_packaging=10 → VALID', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: 500, default_packaging_weight_g: 10 });
  assert.equal(r.status, CLASS.VALID);
});

/* ─── NO_ROW ─── */
test('classifier: null sm → NO_ROW', () => {
  const r = classifyPricingInputs(null);
  assert.equal(r.status, CLASS.NO_ROW);
  assert.deepEqual(r.missing, ['sku_master']);
});

/* ─── MISSING_DATA ─── */
test('classifier: cost null → MISSING_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: null, weight_gram: 500 });
  assert.equal(r.status, CLASS.MISSING_DATA);
  assert.ok(r.missing.includes('cost_krw'));
});

test('classifier: weight null → MISSING_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: null });
  assert.equal(r.status, CLASS.MISSING_DATA);
  assert.ok(r.missing.includes('weight_gram'));
});

test('classifier: cost 0 → MISSING_DATA (not invalid)', () => {
  const r = classifyPricingInputs({ cost_krw: 0, weight_gram: 500 });
  assert.equal(r.status, CLASS.MISSING_DATA);
});

test('classifier: weight 0 with no packaging → MISSING_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: 0 });
  assert.equal(r.status, CLASS.MISSING_DATA);
});

test('classifier: both missing → MISSING_DATA (owner: NEVER conflate with INVALID)', () => {
  const r = classifyPricingInputs({ cost_krw: null, weight_gram: null });
  assert.equal(r.status, CLASS.MISSING_DATA);
});

/* ─── INVALID_DATA ─── */
test('classifier: cost negative → INVALID_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: -100, weight_gram: 500 });
  assert.equal(r.status, CLASS.INVALID_DATA);
  assert.ok(r.errors.some(e => e.field === 'costKrw'));
});

test('classifier: cost non-integer → INVALID_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: 1000.5, weight_gram: 500 });
  assert.equal(r.status, CLASS.INVALID_DATA);
});

test('classifier: weight non-integer → INVALID_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: 500.5 });
  assert.equal(r.status, CLASS.INVALID_DATA);
});

test('classifier: default_packaging negative → INVALID_DATA', () => {
  const r = classifyPricingInputs({ cost_krw: 1000, weight_gram: 500, default_packaging_weight_g: -5 });
  assert.equal(r.status, CLASS.INVALID_DATA);
});

/* ─────────────────────────── 3. Shared-parameter classifier ─────────────────────────── */

test('classifySharedParams: usdKrw=1300, fee=0.18 → ok:true', () => {
  const r = classifySharedParams({ usdKrw: 1300, ebayFeePct: 0.18 });
  assert.equal(r.ok, true);
});

test('classifySharedParams: usdKrw=0 → ok:false (silent default danger)', () => {
  const r = classifySharedParams({ usdKrw: 0, ebayFeePct: 0.18 });
  assert.equal(r.ok, false);
});

test('classifySharedParams: fee=13 (percent in decimal slot) → ok:false', () => {
  const r = classifySharedParams({ usdKrw: 1300, ebayFeePct: 13 });
  assert.equal(r.ok, false);
});

/* ─────────────────────────── 4. priceEngine enum extension ─────────────────────────── */

test('priceEngine.REASON exposes BLOCK_CONTRACT_VIOLATION', () => {
  assert.equal(engine.REASON.BLOCK_CONTRACT_VIOLATION, 'BLOCK_CONTRACT_VIOLATION');
});

test('priceEngine.BLOCK_TASK_TYPE routes BLOCK_CONTRACT_VIOLATION → DATA_CORRUPTION_REVIEW', () => {
  assert.equal(engine.BLOCK_TASK_TYPE.BLOCK_CONTRACT_VIOLATION, 'DATA_CORRUPTION_REVIEW');
});

/* ─────────────────────────── 5. Marketplace safety pin ─────────────────────────── */

test('AUDIT: PriceExecutionGate is untouched — BLOCK/SKIP SKUs never call the gate', () => {
  const gateSrc = fs.readFileSync(path.join(__dirname, '../../src/services/priceExecutionGate.js'), 'utf8');
  // The gate has no knowledge of Engine 1 telemetry; it only sees explicit
  // executePriceWrite() calls. The audit here is that engine1DryRunJob
  // does NOT call the gate at all — it only writes price_events.
  const engine1Src = fs.readFileSync(SRC_PATH, 'utf8');
  assert.equal(/priceExecutionGate/.test(engine1Src), false,
    'engine1DryRunJob is dry-run only — must not import priceExecutionGate');
  assert.equal(/executePriceWrite/.test(engine1Src), false,
    'engine1DryRunJob must not call executePriceWrite');
  // Gate itself must still exist untouched
  assert.match(gateSrc, /async function executePriceWrite/);
});
