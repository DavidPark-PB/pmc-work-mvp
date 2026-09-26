'use strict';

/**
 * tests/services/ebayCardConditionAspectInjection.test.js  (2026-09-23)
 *
 * Owner-confirmed via GetItemAspectsForCategory dump for category 183454
 * (2026-09-23): "Card Condition" is NOT an item aspect in Pokemon Single
 * Cards — the only required aspect is "Game". The "Card Condition (40001)
 * is a required field" error therefore refers to a ConditionDescriptor,
 * a separate top-level XML block eBay Trading API v1355 requires for
 * Trading Card categories:
 *
 *   <Item>
 *     <ConditionID>4000</ConditionID>
 *     <ConditionDescriptors>
 *       <ConditionDescriptor>
 *         <Name>40001</Name>
 *         <Value>Near Mint</Value>
 *       </ConditionDescriptor>
 *     </ConditionDescriptors>
 *     ...
 *   </Item>
 *
 * Previous item-aspect injection (INJECT-*) is REMOVED — it was harmful
 * (polluted ItemSpecifics with a name eBay's schema doesn't accept for
 * this category) AND ineffective (never satisfied the descriptor
 * requirement). This suite now locks in the descriptor path.
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
  _buildConditionDescriptors,
  _isTradingCardContext,
} = require(EBAYAPI);

//   ═════════════════════════════════════════════════════════════
//   §1 · _deriveCardConditionValue — unchanged from earlier fix
//   ═════════════════════════════════════════════════════════════

test('CC-1 · owner-reported "Ungraded - Near mint or better" → "Near Mint"', () => {
  assert.equal(
    _deriveCardConditionValue('Ungraded - Near mint or better: Not in original packaging or professionally graded', '4000'),
    'Near Mint',
  );
});

test('CC-2 · "Mint" alone → "Mint" (not "Near Mint" — order precedence)', () => {
  assert.equal(_deriveCardConditionValue('Mint condition', '4000'), 'Mint');
  assert.equal(_deriveCardConditionValue('near mint', '4000'),      'Near Mint');
});

test('CC-3 · abbreviations (NM/EX/VG/LP/HP)', () => {
  assert.equal(_deriveCardConditionValue('NM', '4000'), 'Near Mint');
  assert.equal(_deriveCardConditionValue('EX', '4000'), 'Excellent');
  assert.equal(_deriveCardConditionValue('VG', '4000'), 'Very Good');
  assert.equal(_deriveCardConditionValue('LP', '4000'), 'Light Play');
  assert.equal(_deriveCardConditionValue('HP', '4000'), 'Heavily Played');
});

test('CC-5 · no string match → conditionId-based fallback', () => {
  assert.equal(_deriveCardConditionValue('', '2750'), 'Mint');
  assert.equal(_deriveCardConditionValue('', '4000'), 'Near Mint');
  assert.equal(_deriveCardConditionValue(null, null), 'Near Mint');
});

//   ═════════════════════════════════════════════════════════════
//   §2 · _injectRequiredAspects — now a pass-through for Card
//        Condition (removed the item-aspect injection that never
//        satisfied eBay's descriptor requirement)
//   ═════════════════════════════════════════════════════════════

test('INJECT-PASS-1 · Card Condition is NOT injected as an item aspect (owner metadata proved it is not an aspect)', () => {
  //   Even for the canonical trigger case (183454 + conditionId 4000),
  //   the function must NOT add "Card Condition" to itemSpecifics.
  const out = _injectRequiredAspects(
    { Brand: 'Pokemon', Rarity: 'SAR' },
    '183454',
    { conditionString: 'Ungraded - Near mint or better', conditionId: '4000' },
  );
  assert.equal(out['Card Condition'], undefined,
    'Card Condition MUST NOT be injected as an item aspect (belongs in <ConditionDescriptors>)');
  //   Original aspects preserved.
  assert.equal(out.Brand,  'Pokemon');
  assert.equal(out.Rarity, 'SAR');
});

test('INJECT-PASS-2 · operator-supplied item aspect is untouched (never overwritten)', () => {
  const out = _injectRequiredAspects(
    { 'Card Condition': 'Mint', Brand: 'Pokemon' },
    '183454',
    { conditionString: 'Near mint', conditionId: '4000' },
  );
  //   If the operator explicitly put it in the aspect list, keep it there.
  //   (eBay may still reject as invalid-aspect, but that's operator intent.)
  assert.equal(out['Card Condition'], 'Mint');
});

test('INJECT-PASS-3 · non-Trading-Card category is a plain pass-through', () => {
  const out = _injectRequiredAspects(
    { Brand: 'Pokemon' },
    '183456',
    { conditionString: 'New', conditionId: '1000' },
  );
  assert.equal(out['Card Condition'], undefined);
  assert.equal(out.Brand, 'Pokemon');
});

//   ═════════════════════════════════════════════════════════════
//   §3 · _isTradingCardContext — shared detection
//   ═════════════════════════════════════════════════════════════

test('CTX-1 · known Single Card category id (183454) → true', () => {
  assert.equal(_isTradingCardContext({}, '183454', ''), true);
  assert.equal(_isTradingCardContext({}, '2536',   ''), true);
  assert.equal(_isTradingCardContext({}, '261324', ''), true);
});

test('CTX-2 · Trading-Card conditionId (4000/2750) alone → true', () => {
  assert.equal(_isTradingCardContext({}, 'UNKNOWN', '4000'), true);
  assert.equal(_isTradingCardContext({}, 'UNKNOWN', '2750'), true);
});

test('CTX-3 · structural signal alone → true', () => {
  assert.equal(_isTradingCardContext({ 'Card Number': '114/083' }, 'UNKNOWN', ''), true);
  assert.equal(_isTradingCardContext({ Franchise: 'Pokémon' },    'UNKNOWN', ''), true);
  assert.equal(_isTradingCardContext({ Game: 'Pokémon TCG' },     'UNKNOWN', ''), true);
});

test('CTX-4 · no signals → false', () => {
  assert.equal(_isTradingCardContext({ Brand: 'PMC' }, '9355', '1000'), false);
  assert.equal(_isTradingCardContext({}, '183456', '1000'), false);
});

//   ═════════════════════════════════════════════════════════════
//   §4 · _buildConditionDescriptors — the actual fix
//   ═════════════════════════════════════════════════════════════

test('CD-1 · Trading Card context emits <ConditionDescriptors> block with Name=40001', () => {
  const xml = _buildConditionDescriptors(
    { Brand: 'Pokemon', Rarity: 'SAR' },
    '183454',
    { conditionString: 'Ungraded - Near mint or better', conditionId: '4000' },
  );
  assert.ok(/<ConditionDescriptors>/.test(xml),  'block wrapper must be present');
  assert.ok(/<ConditionDescriptor>/.test(xml),   'inner descriptor tag must be present');
  assert.ok(/<Name>40001<\/Name>/.test(xml),     'descriptor Name MUST be 40001 (from owner\'s eBay error)');
  assert.ok(/<Value>Near Mint<\/Value>/.test(xml), 'descriptor Value MUST be "Near Mint" for Ungraded');
});

test('CD-2 · non-Trading-Card context emits empty string (no block)', () => {
  const xml = _buildConditionDescriptors(
    { Brand: 'PMC' }, '9355', { conditionString: 'New', conditionId: '1000' },
  );
  assert.equal(xml, '', 'Booster Box / non-Trading-Card MUST NOT emit a descriptor block');
});

test('CD-3 · operator-supplied Grade aspect is used as descriptor value', () => {
  const xml = _buildConditionDescriptors(
    { Grade: 'PSA 10' },
    '183454',
    { conditionId: '2750' },
  );
  assert.ok(/<Value>PSA 10<\/Value>/.test(xml),
    'operator-supplied Grade MUST flow through to the descriptor Value');
});

test('CD-4 · conditionId-only trigger (unknown category) still emits descriptor', () => {
  //   Owner-repro: preset.categoryId can be stale but conditionId 4000
  //   still identifies this as a Trading Card listing.
  const xml = _buildConditionDescriptors(
    { Brand: 'Pokemon' },
    'UNKNOWN_CAT',
    { conditionId: '4000' },
  );
  assert.ok(/<ConditionDescriptors>/.test(xml), 'conditionId trigger MUST emit descriptor');
  assert.ok(/<Value>Near Mint<\/Value>/.test(xml));
});

test('CD-5 · structural trigger — competitor aspect set alone forces descriptor emit', () => {
  //   Owner exact repro: full competitor aspect set, wrong category, wrong
  //   conditionId. Structural detection (Card Number / Rarity / Franchise
  //   Pokémon) still recognizes Trading Card and emits the descriptor.
  const xml = _buildConditionDescriptors(
    {
      Franchise: 'Pokémon', Rarity: 'SAR', Game: 'Pokémon TCG',
      'Card Number': '114/083', Illustrator: 'Susumu Maeya',
    },
    'WRONG_CAT',
    { conditionId: '1000', conditionString: '' },
  );
  assert.ok(/<ConditionDescriptors>/.test(xml),
    'structural trigger MUST emit descriptor even with wrong category + stale conditionId');
  //   Default value from conditionId (1000 does not match) → falls to
  //   _deriveCardConditionValue default of "Near Mint"
  assert.ok(/<Value>Near Mint<\/Value>/.test(xml));
});

test('CD-6 · XML value is properly escaped', () => {
  //   Ensure special characters in the derived value don't break the XML.
  //   (Standard eBay condition values don't contain special chars, but
  //   an operator-supplied Grade like "PSA 10 & GEM" might.)
  const xml = _buildConditionDescriptors(
    { Grade: 'PSA & BGS' },
    '183454',
    { conditionId: '2750' },
  );
  assert.ok(/<Value>PSA &amp; BGS<\/Value>/.test(xml),
    'ampersand MUST be XML-escaped inside descriptor Value');
});

//   ═════════════════════════════════════════════════════════════
//   §5 · end-to-end XML — full _buildItemXml pipeline
//   ═════════════════════════════════════════════════════════════

test('E2E-1 · full 183454 pipeline emits <ConditionDescriptors> AS A TOP-LEVEL Item child (NOT inside ItemSpecifics)', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'Pikachu ex SAR', description: 'd',
    price: 168.94, quantity: 1, sku: 'SC-1',
    categoryId: '183454', conditionId: '4000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: { Brand: 'Pokemon', Rarity: 'SAR' },
    conditionDescriptorContext: {
      conditionString: 'Ungraded - Near mint or better',
      conditionId: '4000',
    },
  });
  //   Card Condition MUST appear as a ConditionDescriptor, not as an
  //   ItemSpecifics NameValueList.
  assert.ok(/<ConditionDescriptors>\s*<ConditionDescriptor>\s*<Name>40001<\/Name>\s*<Value>Near Mint<\/Value>/.test(xml),
    '<ConditionDescriptors> block MUST carry Name=40001 + Value=Near Mint');
  //   It must NOT appear inside ItemSpecifics.
  const specsBlock = xml.match(/<ItemSpecifics>[\s\S]*?<\/ItemSpecifics>/);
  assert.ok(specsBlock, 'ItemSpecifics block must exist');
  assert.ok(!/Card Condition/.test(specsBlock[0]),
    'Card Condition MUST NOT appear inside <ItemSpecifics> — belongs in <ConditionDescriptors>');
});

test('E2E-2 · 183456 (Booster Box) pipeline emits NEITHER ConditionDescriptors NOR Card Condition aspect', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'BoosterBox', description: 'd',
    price: 200, quantity: 1, sku: 'BB-1',
    categoryId: '183456', conditionId: '1000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: { Brand: 'Pokemon', Type: 'Booster Box' },
    conditionDescriptorContext: { conditionId: '1000' },
  });
  assert.ok(!/<ConditionDescriptors>/.test(xml),
    'Booster Box MUST NOT carry a <ConditionDescriptors> block');
  assert.ok(!/Card Condition/.test(xml),
    'Booster Box MUST NOT carry a Card Condition aspect');
});

test('E2E-3 · ConditionDescriptors sits inside <Item> BEFORE <CategoryMappingAllowed> (canonical location)', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'T', description: 'd', price: 10, quantity: 1, sku: 'S1',
    categoryId: '183454', conditionId: '4000', currency: 'USD', imageUrls: [],
    itemSpecifics: { Rarity: 'Rare' },
    conditionDescriptorContext: { conditionId: '4000' },
  });
  //   Locate positions.
  const idxItem       = xml.indexOf('<Item>');
  const idxCondID     = xml.indexOf('<ConditionID>');
  const idxDescriptors = xml.indexOf('<ConditionDescriptors>');
  const idxSpecifics  = xml.indexOf('<ItemSpecifics>');
  assert.ok(idxItem >= 0 && idxCondID > idxItem);
  assert.ok(idxDescriptors > idxCondID,       'ConditionDescriptors must follow ConditionID');
  assert.ok(idxDescriptors < idxSpecifics,    'ConditionDescriptors must precede ItemSpecifics');
});

//   ═════════════════════════════════════════════════════════════
//   §6 · integration guards
//   ═════════════════════════════════════════════════════════════

test('WIRING-1 · aiWorkflowPublisher._buildEbayParams passes conditionDescriptorContext', () => {
  const src = fs.readFileSync(PUBLISHER, 'utf8');
  assert.ok(/conditionDescriptorContext\s*:/.test(src),
    '_buildEbayParams MUST include conditionDescriptorContext in the returned params');
});

test('WIRING-2 · ebayAPI._buildItemXml destructures and emits conditionDescriptorContext', () => {
  const src = fs.readFileSync(EBAYAPI, 'utf8');
  assert.ok(/_buildItemXml\(\{[\s\S]*?conditionDescriptorContext[\s\S]*?\}\)/.test(src),
    '_buildItemXml MUST accept conditionDescriptorContext in its destructure');
  assert.ok(/_buildConditionDescriptors\s*\(/.test(src),
    '_buildItemXml MUST call _buildConditionDescriptors');
});

test('WIRING-3 · SPA forwards conditionDisplayName in the publish product payload', () => {
  const src = fs.readFileSync(SPA, 'utf8');
  assert.ok(/conditionDisplayName:\s*state\.competitor\?\.conditionDisplayName/.test(src),
    'SPA product payload MUST forward state.competitor.conditionDisplayName');
});

//   ═════════════════════════════════════════════════════════════
//   §7 · numeric descriptor value ID resolution (2026-09-26)
//   ═════════════════════════════════════════════════════════════

test('RESOLVE-1 · when resolvedDescriptorValueId is provided, XML Value uses the numeric id', () => {
  const xml = _buildConditionDescriptors(
    { Brand: 'Pokemon' },
    '183454',
    {
      conditionString: 'Near Mint', conditionId: '4000',
      resolvedDescriptorValueId: '4000000',   //   pretend eBay returned this
    },
  );
  assert.ok(/<Name>40001<\/Name>/.test(xml));
  assert.ok(/<Value>4000000<\/Value>/.test(xml),
    'when the resolver hit succeeds, the numeric ID MUST be emitted (not the string)');
  assert.ok(!/<Value>Near Mint<\/Value>/.test(xml),
    'string value MUST NOT be emitted when the numeric id is known');
});

test('RESOLVE-2 · when resolvedDescriptorValueId is absent, falls back to string name (diagnostic)', () => {
  const xml = _buildConditionDescriptors(
    { Brand: 'Pokemon' },
    '183454',
    { conditionString: 'Near Mint', conditionId: '4000' },   //   no resolvedDescriptorValueId
  );
  assert.ok(/<Value>Near Mint<\/Value>/.test(xml),
    'without a resolved id, fall back to the string name so eBay names accepted values in error');
});

test('WIRING-4 · aiWorkflowPublisher publishToEbay AND verifyEbay both call _resolveTradingCardDescriptor', () => {
  const src = fs.readFileSync(PUBLISHER, 'utf8');
  //   The helper must be defined and referenced in both flows.
  assert.ok(/function\s+_resolveTradingCardDescriptor\s*\(/.test(src),
    '_resolveTradingCardDescriptor helper MUST be defined');
  //   publishToEbay body should call it.
  const publishBody = src.match(/async function publishToEbay[\s\S]+?const result = await ebay\.createProduct/);
  assert.ok(publishBody && /_resolveTradingCardDescriptor\s*\(\s*params\s*,\s*ebay\s*\)/.test(publishBody[0]),
    'publishToEbay MUST await _resolveTradingCardDescriptor before createProduct');
  const verifyBody = src.match(/async function verifyEbay[\s\S]+?const r = await ebay\.verifyProduct/);
  assert.ok(verifyBody && /_resolveTradingCardDescriptor\s*\(\s*params\s*,\s*ebay\s*\)/.test(verifyBody[0]),
    'verifyEbay MUST await _resolveTradingCardDescriptor before verifyProduct');
});

test('WIRING-5 · EbayAPI exposes getItemConditionPolicies + resolveConditionDescriptorValueId', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  assert.equal(typeof ebay.getItemConditionPolicies, 'function');
  assert.equal(typeof ebay.resolveConditionDescriptorValueId, 'function');
});
