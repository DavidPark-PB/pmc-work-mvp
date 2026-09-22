'use strict';

/**
 * tests/services/ebayCardConditionAspectInjection.test.js  (2026-09-19)
 *
 * Owner-reported bug: Single Cards (Pokemon category 183454) registration
 * failed with
 *   "Card Condition (40001) is a required field."
 * even after the previous fix set the top-level Trading API conditionId
 * correctly to 4000 (Ungraded).
 *
 * Root cause: 183454 requires TWO condition-related fields:
 *   1. top-level `conditionId` in the ItemXml   (already handled)
 *   2. `Card Condition` ITEM ASPECT (aspect id 40001) inside
 *      <ItemSpecifics>                          (was MISSING)
 * Browse API's competitor listings often don't surface this aspect, so
 * our merged itemSpecifics went out without it and eBay rejected.
 *
 * Fix: `_injectRequiredAspects(itemSpecifics, categoryId, ctx)` in
 * ebayAPI.js adds "Card Condition" for category 183454 when missing,
 * with value derived from the competitor's condition string
 * ("Near mint or better" → "Near Mint") or from the top-level
 * conditionId (2750 Graded → "Mint" · 4000 Ungraded → "Near Mint" ·
 * default → "Near Mint"). aiWorkflowPublisher.js calls it inside
 * `_buildEbayParams` so every AI 상품제작 publish + verify carries the
 * required aspect. The SPA now forwards `product.conditionDisplayName`
 * so the derivation has the competitor's original string to parse.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const EBAYAPI = path.join(REPO, 'src/api/ebayAPI.js');
const PUBLISHER = path.join(REPO, 'src/services/aiWorkflowPublisher.js');
const SPA     = path.join(REPO, 'public/js/aiWorkflow.js');
const {
  _deriveCardConditionValue,
  _injectRequiredAspects,
} = require(EBAYAPI);

//   ═════════════════════════════════════════════════════════════
//   §1 · _deriveCardConditionValue — string keyword mapping
//   ═════════════════════════════════════════════════════════════

test('CC-1 · owner-reported "Ungraded - Near mint or better" → "Near Mint"', () => {
  assert.equal(
    _deriveCardConditionValue('Ungraded - Near mint or better: Not in original packaging or professionally graded', '4000'),
    'Near Mint',
  );
});

test('CC-2 · "Mint" alone → "Mint" (not "Near Mint" — order precedence)', () => {
  assert.equal(_deriveCardConditionValue('Mint condition', '4000'),          'Mint');
  assert.equal(_deriveCardConditionValue('Perfect Mint state', '4000'),      'Mint');
  assert.equal(_deriveCardConditionValue('near mint', '4000'),               'Near Mint');
});

test('CC-3 · abbreviations (NM/EX/VG/LP/HP)', () => {
  assert.equal(_deriveCardConditionValue('NM', '4000'), 'Near Mint');
  assert.equal(_deriveCardConditionValue('EX', '4000'), 'Excellent');
  assert.equal(_deriveCardConditionValue('VG', '4000'), 'Very Good');
  assert.equal(_deriveCardConditionValue('LP', '4000'), 'Light Play');
  assert.equal(_deriveCardConditionValue('HP', '4000'), 'Heavily Played');
});

test('CC-4 · Damaged / Poor / Good / Played tiers', () => {
  assert.equal(_deriveCardConditionValue('Damaged',   '4000'), 'Damaged');
  assert.equal(_deriveCardConditionValue('Poor',      '4000'), 'Poor');
  assert.equal(_deriveCardConditionValue('Good',      '4000'), 'Good');
  assert.equal(_deriveCardConditionValue('Played',    '4000'), 'Played');
});

test('CC-5 · no string match → conditionId-based fallback', () => {
  //   2750 Graded → "Mint" (typical PSA/BGS slab)
  assert.equal(_deriveCardConditionValue('',           '2750'), 'Mint');
  assert.equal(_deriveCardConditionValue('some noise', '2750'), 'Mint');
  //   4000 Ungraded or missing → "Near Mint"
  assert.equal(_deriveCardConditionValue('',           '4000'), 'Near Mint');
  assert.equal(_deriveCardConditionValue('',           ''),      'Near Mint');
  assert.equal(_deriveCardConditionValue(null,         null),    'Near Mint');
});

//   ═════════════════════════════════════════════════════════════
//   §2 · _injectRequiredAspects — Single Cards 183454
//   ═════════════════════════════════════════════════════════════

test('INJECT-1 · Single Cards (183454) with NO Card Condition → injects derived value', () => {
  const out = _injectRequiredAspects(
    { Brand: 'Pokemon', Rarity: 'SAR' },
    '183454',
    { conditionString: 'Ungraded - Near mint or better', conditionId: '4000' },
  );
  assert.equal(out['Card Condition'], 'Near Mint',
    `Card Condition must be injected as "Near Mint" — got ${JSON.stringify(out)}`);
  //   Other aspects preserved unchanged.
  assert.equal(out.Brand,  'Pokemon');
  assert.equal(out.Rarity, 'SAR');
});

test('INJECT-2 · operator-supplied Card Condition is NEVER overwritten (idempotent)', () => {
  const out = _injectRequiredAspects(
    { 'Card Condition': 'Mint', Brand: 'Pokemon' },
    '183454',
    { conditionString: 'Near mint', conditionId: '4000' },
  );
  assert.equal(out['Card Condition'], 'Mint',
    'must NOT overwrite an operator-supplied Card Condition');
});

test('INJECT-3 · non-Single-Cards category → does NOT inject Card Condition', () => {
  //   Booster Box (183456) doesn't require this aspect.
  const out = _injectRequiredAspects(
    { Brand: 'Pokemon' },
    '183456',
    { conditionString: 'New', conditionId: '1000' },
  );
  assert.equal(out['Card Condition'], undefined,
    'Booster Box category MUST NOT get a Card Condition aspect');
  assert.equal(out.Brand, 'Pokemon');
});

test('INJECT-4 · empty/undefined itemSpecifics → still injects on 183454', () => {
  const outA = _injectRequiredAspects(undefined, '183454', { conditionId: '4000' });
  const outB = _injectRequiredAspects({},        '183454', { conditionId: '4000' });
  assert.equal(outA['Card Condition'], 'Near Mint');
  assert.equal(outB['Card Condition'], 'Near Mint');
});

test('INJECT-5 · Graded (2750) → "Mint" by default when no string hint', () => {
  const out = _injectRequiredAspects({}, '183454', { conditionString: '', conditionId: '2750' });
  assert.equal(out['Card Condition'], 'Mint');
});

//   ─────────────────────────────────────────────────────────────
//   §2b · widened trigger (2026-09-22)
//   ─────────────────────────────────────────────────────────────

test('INJECT-6 · newer Pokemon Single Cards categories (2536, 261324) also inject', () => {
  for (const cat of ['2536', '261324']) {
    const out = _injectRequiredAspects({}, cat, { conditionId: '4000' });
    assert.equal(out['Card Condition'], 'Near Mint',
      `category ${cat} MUST trigger Card Condition injection`);
  }
});

test('INJECT-7 · conditionId=4000 (Ungraded) triggers injection on ANY category (Trading-Card signal)', () => {
  //   Owner-reported repro: even when preset.categoryId drifted, conditionId
  //   stayed at 4000 (correctly inferred). The widened trigger must catch it.
  const out = _injectRequiredAspects({ Brand: 'Pokemon' }, 'UNKNOWN_CAT', {
    conditionString: 'Ungraded - Near mint or better', conditionId: '4000',
  });
  assert.equal(out['Card Condition'], 'Near Mint',
    'conditionId=4000 alone MUST trigger injection regardless of categoryId');
});

test('INJECT-8 · conditionId=2750 (Graded) also triggers injection on ANY category', () => {
  const out = _injectRequiredAspects({}, 'UNKNOWN_CAT', {
    conditionString: 'PSA Graded', conditionId: '2750',
  });
  assert.equal(out['Card Condition'], 'Mint',
    'conditionId=2750 alone MUST trigger injection with default "Mint"');
});

test('INJECT-9 · "Grade" or "Card Grade" alias is recognized as already-set (no double-emit)', () => {
  const withGrade = _injectRequiredAspects(
    { Grade: 'PSA 10' },
    '183454',
    { conditionId: '2750' },
  );
  //   Do not overwrite the explicit Grade — but also don't add Card Condition
  //   since operator's Grade covers the required condition signal.
  assert.equal(withGrade['Card Condition'], undefined,
    'operator-supplied Grade aspect must count as Card Condition already set');
  assert.equal(withGrade.Grade, 'PSA 10');

  const withCardGrade = _injectRequiredAspects(
    { 'Card Grade': 'BGS 9.5' },
    '183454',
    { conditionId: '2750' },
  );
  assert.equal(withCardGrade['Card Condition'], undefined);
  assert.equal(withCardGrade['Card Grade'], 'BGS 9.5');
});

test('INJECT-10 · New (conditionId=1000) on non-Trading-Card category → no injection (correct no-op)', () => {
  //   Regression guard: Booster Box (183456) + conditionId 1000 must NOT
  //   grow a spurious Card Condition aspect.
  const out = _injectRequiredAspects({ Brand: 'Pokemon' }, '183456', {
    conditionString: 'New', conditionId: '1000',
  });
  assert.equal(out['Card Condition'], undefined);
});

//   ─────────────────────────────────────────────────────────────
//   §2c · third-tier STRUCTURAL trigger (owner's third repro, 2026-09-22)
//   ─────────────────────────────────────────────────────────────

test('INJECT-11 · itemSpecifics with "Card Number" aspect alone → inject (even w/ wrong category + stale conditionId)', () => {
  //   Worst-case: preset drift left categoryId at Booster Box AND conditionId
  //   at 1000 (New). Neither trigger (a) nor (b) fires. Structural trigger
  //   (c) catches it because a Trading Card listing carries "Card Number".
  const out = _injectRequiredAspects(
    { 'Card Number': '114/083', Brand: 'Pokemon' },
    '183456',   //   stale wrong category
    { conditionId: '1000' },   //   stale wrong condition
  );
  assert.equal(out['Card Condition'], 'Near Mint',
    'structural trigger MUST catch the case where all other signals are stale');
});

test('INJECT-12 · itemSpecifics with "Rarity"/"Card Type"/"Illustrator" aspect triggers injection', () => {
  //   Each of these aspects on its own is enough — Trading Card listings
  //   always carry at least one of them.
  for (const aspect of ['Rarity', 'Card Type', 'Illustrator']) {
    const out = _injectRequiredAspects(
      { [aspect]: 'X' },
      'UNKNOWN',
      { conditionId: '' },
    );
    assert.equal(out['Card Condition'], 'Near Mint',
      `structural trigger MUST fire on "${aspect}" aspect alone`);
  }
});

test('INJECT-13 · Game containing "TCG" or "Trading Card" triggers injection', () => {
  const outTCG = _injectRequiredAspects({ Game: 'Pokémon TCG' }, 'UNKNOWN', {});
  assert.equal(outTCG['Card Condition'], 'Near Mint');
  const outTC  = _injectRequiredAspects({ Game: 'Trading Card Game' }, 'UNKNOWN', {});
  assert.equal(outTC['Card Condition'], 'Near Mint');
  //   Non-TCG Game value MUST NOT trigger.
  const outFPS = _injectRequiredAspects({ Game: 'First Person Shooter' }, 'UNKNOWN', {});
  assert.equal(outFPS['Card Condition'], undefined,
    'non-Trading-Card Game value MUST NOT trigger structural injection');
});

test('INJECT-14 · Franchise = "Pokémon" or "Pokemon" triggers injection', () => {
  for (const franchise of ['Pokémon', 'Pokemon', 'POKEMON', 'pokemon']) {
    const out = _injectRequiredAspects({ Franchise: franchise }, 'UNKNOWN', {});
    assert.equal(out['Card Condition'], 'Near Mint',
      `Franchise="${franchise}" MUST trigger`);
  }
  //   Unrelated Franchise MUST NOT trigger.
  const outLego = _injectRequiredAspects({ Franchise: 'LEGO' }, 'UNKNOWN', {});
  assert.equal(outLego['Card Condition'], undefined);
});

test('INJECT-15 · Owner exact repro: full competitor aspect set with stale categoryId → still injects', () => {
  //   The exact aspect set visible in owner's screenshot for the Pikachu Ex
  //   SAR competitor listing. Even if preset.categoryId ended up wrong AND
  //   conditionId stayed stale at '1000', structural trigger catches it.
  const out = _injectRequiredAspects(
    {
      Franchise: 'Pokémon',
      Rarity:    'SAR',
      Game:      'Pokémon TCG',
      Illustrator: 'Susumu Maeya',
      Customized: 'No',
      'Card Number': '114/083',
      'Country of Origin': 'South Korea (Republic of Korea)',
    },
    'WRONG_CAT',
    { conditionId: '1000', conditionString: '' },
  );
  assert.equal(out['Card Condition'], 'Near Mint',
    "owner's Pikachu Ex SAR competitor aspect set MUST inject Card Condition regardless of stale ctx");
});

//   ═════════════════════════════════════════════════════════════
//   §3 · source-level integration guards
//   ═════════════════════════════════════════════════════════════

test('WIRING-1 · aiWorkflowPublisher._buildEbayParams calls _injectRequiredAspects', () => {
  const src = fs.readFileSync(PUBLISHER, 'utf8');
  assert.ok(/_injectRequiredAspects\s*\(/.test(src),
    '_buildEbayParams MUST call _injectRequiredAspects on merged item specifics');
  //   And it must pass the categoryId so 183454 detection works.
  assert.ok(/_injectRequiredAspects\([\s\S]*?preset\.categoryId/.test(src),
    'MUST pass preset.categoryId to _injectRequiredAspects');
});

test('WIRING-2 · SPA forwards conditionDisplayName in the publish product payload', () => {
  const src = fs.readFileSync(SPA, 'utf8');
  //   The product object built for /api/ai-workflow/publish must include
  //   conditionDisplayName so the server-side derivation has the competitor
  //   condition string to parse.
  assert.ok(/conditionDisplayName:\s*state\.competitor\?\.conditionDisplayName/.test(src),
    'SPA product payload MUST forward state.competitor.conditionDisplayName');
});

//   ═════════════════════════════════════════════════════════════
//   §4 · end-to-end XML shape
//   ═════════════════════════════════════════════════════════════

test('E2E-1 · full pipeline emits <Value>Near Mint</Value> under a <Name>Card Condition</Name> NameValueList for 183454', () => {
  //   Instantiate the API directly and build XML with the merged specs
  //   after injection. Not going through the publisher module because
  //   that requires more mocks; but wiring is tested by WIRING-1 above.
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const merged = _injectRequiredAspects(
    { Brand: 'Pokemon', Rarity: 'SAR' },
    '183454',
    { conditionString: 'Ungraded - Near mint or better', conditionId: '4000' },
  );
  const xml = ebay._buildItemXml({
    title: 'Pikachu ex SAR', description: 'd',
    price: 168.94, quantity: 1, sku: 'SC-1',
    categoryId: '183454', conditionId: '4000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: merged,
  });
  const block = xml.match(/<NameValueList><Name>Card Condition<\/Name>[\s\S]*?<\/NameValueList>/);
  assert.ok(block, 'Card Condition NameValueList must be emitted');
  assert.ok(/<Value>Near Mint<\/Value>/.test(block[0]),
    `Card Condition value must be "Near Mint" — got ${block[0]}`);
});

test('E2E-2 · 183456 (Booster Box) pipeline does NOT inject Card Condition', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const merged = _injectRequiredAspects(
    { Brand: 'Pokemon', Type: 'Booster Box' },
    '183456',
    { conditionId: '1000' },
  );
  const xml = ebay._buildItemXml({
    title: 'BoosterBox', description: 'd',
    price: 200, quantity: 1, sku: 'BB-1',
    categoryId: '183456', conditionId: '1000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: merged,
  });
  assert.ok(!/<Name>Card Condition<\/Name>/.test(xml),
    'Booster Box XML MUST NOT carry a Card Condition NameValueList');
});
