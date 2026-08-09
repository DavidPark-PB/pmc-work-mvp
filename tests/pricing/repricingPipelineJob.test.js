'use strict';

/**
 * repricingPipelineJob.test.js — Phase 1 Commit 5B tests
 * ---------------------------------------------------------------------------
 * The pipeline job does not touch eBay itself — it delegates to
 * runAutoRepricer, which as of Commit 5A goes through PriceExecutionGate.
 * These tests pin two invariants:
 *
 *   1. PRICE_WRITES_ENABLED=false stays wired in the source.
 *   2. The job has no direct ebay.updateItem / ReviseItem / ebay_products
 *      mutation. Reads (select) are allowed.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC_PATH = path.join(__dirname, '../../src/jobs/repricingPipelineJob.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

test('CONFIG.PRICE_WRITES_ENABLED default is false (owner-mandated safety guard)', () => {
  // The CONFIG block must literally contain PRICE_WRITES_ENABLED: false.
  assert.match(SRC, /PRICE_WRITES_ENABLED\s*:\s*false/);
});

test('LIVE-request guard rewrites isDryRun=true when PRICE_WRITES_ENABLED=false', () => {
  // The block that flips !isDryRun && !PRICE_WRITES_ENABLED → isDryRun=true
  // must survive.
  assert.match(SRC, /LIVE 요청 차단/);
  assert.match(SRC, /isDryRun\s*=\s*true;/);
});

test('AUDIT: pipeline job has no direct ebay.updateItem / ReviseItem call', () => {
  assert.equal((SRC.match(/ebay\.updateItem\s*\(/g) || []).length, 0);
  assert.equal((SRC.match(/ReviseFixedPriceItem/g) || []).length, 0);
  assert.equal((SRC.match(/ReviseItem\b/g) || []).length, 0);
});

test('AUDIT: pipeline job has no ebay_products.update / insert mutation (reads OK)', () => {
  // The job reads ebay_products via .select() — allowed.
  // It must NOT contain .from('ebay_products').update(...) or .insert(...).
  const mutationPatterns = [
    /\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*update/,
    /\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*insert/,
    /\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*upsert/,
    /\.from\(\s*['"]ebay_products['"]\s*\)\s*\.\s*delete/,
  ];
  for (const p of mutationPatterns) {
    assert.equal(p.test(SRC), false, `pipeline job must not match ${p}`);
  }
});

test('AUDIT: mutation is delegated to runAutoRepricer (which goes through the gate)', () => {
  assert.match(SRC, /runAutoRepricer\(/);
  assert.match(SRC, /require\(['"]\.\.\/services\/autoRepricer['"]\)/);
});
