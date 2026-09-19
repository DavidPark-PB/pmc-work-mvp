'use strict';

/**
 * tests/services/ebayConditionIdInference.test.js  (2026-09-19)
 *
 * Owner-reported bug: AI 상품제작 for a Pokemon Single Card
 * (competitor listing shown, category 183454, "Ungraded - Near mint or
 * better") failed on eBay side. Root cause: Browse API returns
 * `conditionId` empty for many collectible listings — only `condition`
 * string is present. mirrorCompetitorToPreset therefore kept the stale
 * localStorage value 1000 (New, valid for Booster Box 183456 but NOT
 * for Single Cards 183454). eBay rejected the mismatched combo.
 *
 * Fix: `_inferEbayConditionId(browseConditionId, browseConditionString,
 * categoryId)` on the server returns a Trading-API-valid numeric id
 * derived from Browse metadata. `mirrorCompetitorToPreset` additionally
 * resets the client-side preset conditionId to a category-appropriate
 * default when the category changes AND the competitor provides no
 * explicit conditionId — defense in depth.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const EBAYAPI = path.join(REPO, 'src/api/ebayAPI.js');
const SPA     = path.join(REPO, 'public/js/aiWorkflow.js');
const { _inferEbayConditionId } = require(EBAYAPI);

//   ═════════════════════════════════════════════════════════════
//   §1 · server-side inference: Browse conditionId when present
//   ═════════════════════════════════════════════════════════════

test('COND-1 · numeric Browse conditionId is trusted verbatim', () => {
  assert.equal(_inferEbayConditionId('4000', 'Ungraded', '183454'), '4000');
  assert.equal(_inferEbayConditionId('1000', 'New',     '183456'), '1000');
  assert.equal(_inferEbayConditionId('2750', 'Graded',  '183454'), '2750');
});

//   ═════════════════════════════════════════════════════════════
//   §2 · condition-string keyword inference
//   ═════════════════════════════════════════════════════════════

test('COND-2 · owner-reported "Ungraded - Near mint or better" → 4000', () => {
  assert.equal(_inferEbayConditionId('', 'Ungraded - Near mint or better: Not in original packaging or professionally graded', '183454'),
    '4000');
});

test('COND-3 · "Graded" (PSA/BGS) → 2750, "Ungraded" → 4000 (order matters)', () => {
  assert.equal(_inferEbayConditionId('', 'Graded — PSA 10', '183454'),   '2750');
  assert.equal(_inferEbayConditionId('', 'PSA Graded',      '183454'),   '2750');
  assert.equal(_inferEbayConditionId('', 'Ungraded',        '183454'),   '4000');
  assert.equal(_inferEbayConditionId('', 'Near Mint',       '183454'),   '4000');
});

test('COND-4 · "New"/"Sealed" → 1000; "New other"/"Open box" → 1500', () => {
  assert.equal(_inferEbayConditionId('', 'New',       '183456'), '1000');
  assert.equal(_inferEbayConditionId('', 'Brand New', '183456'), '1000');
  assert.equal(_inferEbayConditionId('', 'Sealed',    '183456'), '1000');
  assert.equal(_inferEbayConditionId('', 'New other (see details)', '183456'), '1500');
  assert.equal(_inferEbayConditionId('', 'Open box',  '183456'), '1500');
});

test('COND-5 · Used tiers', () => {
  assert.equal(_inferEbayConditionId('', 'Used',      '9355'), '3000');
  assert.equal(_inferEbayConditionId('', 'Pre-owned', '9355'), '3000');
  assert.equal(_inferEbayConditionId('', 'Good',      '9355'), '5000');
  assert.equal(_inferEbayConditionId('', 'Acceptable','9355'), '6000');
  assert.equal(_inferEbayConditionId('', 'For parts or not working', '9355'), '7000');
});

//   ═════════════════════════════════════════════════════════════
//   §3 · category-aware defaults (last-resort)
//   ═════════════════════════════════════════════════════════════

test('COND-6 · no conditionId + no condition string + Single Cards category → 4000', () => {
  assert.equal(_inferEbayConditionId('', '', '183454'), '4000');
});

test('COND-7 · no conditionId + no string + Booster Box/Pack → 1000', () => {
  assert.equal(_inferEbayConditionId('', '', '183456'), '1000');
  assert.equal(_inferEbayConditionId('', '', '183455'), '1000');
});

test('COND-8 · no conditionId + no string + unknown category → empty (caller decides)', () => {
  assert.equal(_inferEbayConditionId('', '',    '9999'), '');
  assert.equal(_inferEbayConditionId(null, null, null),   '');
  assert.equal(_inferEbayConditionId(undefined, undefined, undefined), '');
});

//   ═════════════════════════════════════════════════════════════
//   §4 · Browse map integration: inference wired into result
//   ═════════════════════════════════════════════════════════════

test('COND-9 · ebayAPI.js browse-mapping calls _inferEbayConditionId (regression guard)', () => {
  const src = fs.readFileSync(EBAYAPI, 'utf8');
  //   The bug pattern was `conditionId: item.conditionId || ''`. That must be gone.
  assert.ok(!/conditionId:\s*item\.conditionId\s*\|\|\s*''/.test(src),
    'the bare `item.conditionId || \'\'` pattern MUST be replaced by _inferEbayConditionId');
  assert.ok(/conditionId:\s*_inferEbayConditionId\s*\(/.test(src),
    'Browse mapping MUST call _inferEbayConditionId when building the result');
});

//   ═════════════════════════════════════════════════════════════
//   §5 · client-side defense: SPA mirrorCompetitorToPreset uses
//        a category-appropriate default when competitor has no
//        conditionId AND the category just changed.
//   ═════════════════════════════════════════════════════════════

test('COND-10 · aiWorkflow.js mirrorCompetitorToPreset resets stale conditionId on category change', () => {
  const src = fs.readFileSync(SPA, 'utf8');
  //   Look for the CATEGORY_CONDITION_DEFAULTS map added by this fix.
  assert.ok(/CATEGORY_CONDITION_DEFAULTS\s*=\s*\{[\s\S]*?'183454'\s*:\s*'4000'/.test(src),
    'CATEGORY_CONDITION_DEFAULTS must map 183454 → 4000 (Single Cards → Ungraded)');
  assert.ok(/'183456'\s*:\s*'1000'/.test(src),
    'CATEGORY_CONDITION_DEFAULTS must map 183456 → 1000 (Sealed Booster Box → New)');
  //   And the mirror function must use it when the category changes.
  assert.ok(/catChanged/.test(src),
    'mirrorCompetitorToPreset must detect category change');
  assert.ok(/CATEGORY_CONDITION_DEFAULTS\[newCat\]/.test(src),
    'mirrorCompetitorToPreset must consult CATEGORY_CONDITION_DEFAULTS on category change');
});
