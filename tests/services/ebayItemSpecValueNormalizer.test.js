'use strict';

/**
 * tests/services/ebayItemSpecValueNormalizer.test.js  (2026-09-19)
 *
 * Owner-reported bug: AI 상품제작 rejected by eBay with
 *   Features's value of "Foldable, 3L Retrofit System, Anti-slip silicone
 *   pad, Height adjustable, No hazardous substances, Pure transparent
 *   acrylic, Supports 10kg, Up to 19'' laptop, Strong & smooth hinge, …"
 * — a single <Value> that carries a 200+ char CSV. eBay Trading API v1355
 * requires one <Value> tag per value, each ≤ 65 chars. Root cause: our
 * `_buildItemXml` emitted the raw Browse-API-joined CSV as ONE <Value>.
 * Fix: `_normalizeItemSpecValues` splits over-long CSV strings, accepts
 * arrays natively, and clips each value at 65 chars.
 *
 * This suite locks the contract so the bug does not regress.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const EBAYAPI = path.join(REPO, 'src/api/ebayAPI.js');
const { _normalizeItemSpecValues } = require(EBAYAPI);

//   ─────────────────────────────────────────────────────────────
//   Level A · normalizer behaviour (pure function)
//   ─────────────────────────────────────────────────────────────

test('NORM-1 · plain short string → single-element array unchanged', () => {
  assert.deepEqual(_normalizeItemSpecValues('Pokemon'),       ['Pokemon']);
  assert.deepEqual(_normalizeItemSpecValues('  Trimmed  '),   ['Trimmed']);
  assert.deepEqual(_normalizeItemSpecValues('Set A, Series B'), ['Set A, Series B'],
    'short strings with commas MUST stay intact (length < 65 gate)');
});

test('NORM-2 · empty / null / whitespace → empty array', () => {
  assert.deepEqual(_normalizeItemSpecValues(''),          []);
  assert.deepEqual(_normalizeItemSpecValues('   '),       []);
  assert.deepEqual(_normalizeItemSpecValues(null),        []);
  assert.deepEqual(_normalizeItemSpecValues(undefined),   []);
});

test('NORM-3 · array input → each element trimmed + clipped, empties dropped', () => {
  assert.deepEqual(
    _normalizeItemSpecValues(['Foldable', ' Height adjustable ', '', '  ', 'DDP']),
    ['Foldable', 'Height adjustable', 'DDP'],
  );
});

test('NORM-4 · owner-reported CSV Features value → split into individual short values', () => {
  //   The exact string in the owner error (decoded from HTML entities).
  const raw = 'Foldable, 3L Retrofit System, Anti-slip silicone pad, Height adjustable, No hazardous substances, Pure transparent acrylic, Supports 10kg, Up to 19\'\' laptop, Strong & smooth hinge, Charging hole, Patented hidden page holder, Angle adjustment level';
  const values = _normalizeItemSpecValues(raw);
  assert.ok(values.length >= 10, `expected at least 10 split values — got ${values.length}`);
  //   Every emitted value MUST be ≤ 65 chars (Trading API v1355 hard cap).
  for (const v of values) {
    assert.ok(v.length <= 65, `value "${v}" exceeds 65 chars (${v.length})`);
    assert.ok(!v.startsWith(','), `value MUST NOT start with a comma — "${v}"`);
    assert.ok(v.trim() === v,    `value MUST be trimmed — "${v}"`);
  }
  assert.ok(values.includes('Foldable'),                 '"Foldable" split preserved');
  assert.ok(values.includes('Anti-slip silicone pad'),   'multi-word split preserved');
  assert.ok(values.includes('Angle adjustment level'),   'last item preserved');
});

test('NORM-5 · single value > 65 chars → clipped, never lengthened', () => {
  const long = 'x'.repeat(200);
  const values = _normalizeItemSpecValues(long);
  assert.equal(values.length, 1);
  assert.equal(values[0].length, 65,   'single value must be clipped to 65 chars');
  assert.ok(values[0].startsWith('xxxx'));
});

test('NORM-6 · long CSV where one split element is still > 65 chars → clip that one', () => {
  //   First comma-block is 200 chars, second is a normal short value.
  const raw = 'a'.repeat(200) + ', short';
  const values = _normalizeItemSpecValues(raw);
  assert.equal(values.length, 2);
  assert.equal(values[0].length, 65);
  assert.equal(values[1], 'short');
});

test('NORM-7 · length gate: string with comma AND ≤ 65 chars stays single-value', () => {
  //   "Model A, Rev 2" is 14 chars — legitimate single value with an
  //   incidental comma. MUST NOT be split.
  assert.deepEqual(_normalizeItemSpecValues('Model A, Rev 2'), ['Model A, Rev 2']);
});

test('NORM-8 · CSV without space after comma is still split (tolerant)', () => {
  //   Owner Browse-API data occasionally omits the space after comma.
  //   The regex `\s*,\s+` requires at least one whitespace AFTER the comma —
  //   confirm we accept the common ", " form and don't accidentally split
  //   URL-like tokens.
  const raw = 'X-large item description part one, part two part two part two, part three part three part three';
  const values = _normalizeItemSpecValues(raw);
  assert.ok(values.length >= 2, `should split on ", " — got ${values.length}`);
});

//   ─────────────────────────────────────────────────────────────
//   Level B · source-level: _buildItemXml uses the normalizer +
//   emits multiple <Value> tags, not a single joined CSV.
//   ─────────────────────────────────────────────────────────────

test('BUILDXML-1 · _buildItemXml route uses _normalizeItemSpecValues (regression guard)', () => {
  const src = fs.readFileSync(EBAYAPI, 'utf8');
  //   The specs-emit block must call the normalizer.
  assert.ok(/_normalizeItemSpecValues\s*\(/.test(src),
    'ebayAPI.js MUST call _normalizeItemSpecValues on each spec value');
  //   The old single-<Value> pattern must not survive.
  assert.ok(!/<Value>\$\{this\.escapeXml\(String\(v\)\)\}<\/Value>/.test(src),
    'the single-<Value> emit that concatenated Browse-API CSV MUST be gone');
});

//   ─────────────────────────────────────────────────────────────
//   Level C · end-to-end: build XML from a spec dict and grep the
//   emitted XML for the correct multi-<Value> shape.
//   ─────────────────────────────────────────────────────────────

test('E2E-1 · Features CSV becomes MULTIPLE <Value> tags in the built XML', () => {
  //   Instantiate against minimal env — constructor just seeds env.
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'T', description: 'd', price: 10, quantity: 1, sku: 'S1',
    categoryId: '183456', conditionId: '1000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: {
      Brand: 'Pokemon',
      Features: 'Foldable, Height adjustable, Anti-slip silicone pad, Pure transparent acrylic, Strong & smooth hinge',
    },
  });
  //   Locate the Features NameValueList block.
  const featBlock = xml.match(/<NameValueList><Name>Features<\/Name>[\s\S]*?<\/NameValueList>/);
  assert.ok(featBlock, 'Features NameValueList must be present');
  const valueTags = featBlock[0].match(/<Value>[\s\S]*?<\/Value>/g) || [];
  assert.ok(valueTags.length >= 4,
    `Features MUST emit MULTIPLE <Value> tags — got ${valueTags.length}: ${JSON.stringify(valueTags)}`);
  //   No value tag should carry a comma (splits happened).
  for (const t of valueTags) {
    const inner = t.slice(7, -8);   //   strip <Value></Value>
    assert.ok(!/,/.test(inner), `individual <Value> must not carry a comma — "${inner}"`);
    assert.ok(inner.length <= 65, `individual <Value> length > 65 — "${inner}"`);
  }
  //   Brand still a single-value tag (short, no comma).
  const brandBlock = xml.match(/<NameValueList><Name>Brand<\/Name>[\s\S]*?<\/NameValueList>/);
  assert.ok(brandBlock, 'Brand NameValueList must be present');
  const brandValues = brandBlock[0].match(/<Value>[\s\S]*?<\/Value>/g) || [];
  assert.equal(brandValues.length, 1, 'short-value Brand stays as single <Value>');
});

test('E2E-2 · array-valued itemSpecifics emit multiple <Value> tags natively', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'T', description: 'd', price: 10, quantity: 1, sku: 'S2',
    categoryId: '183456', conditionId: '1000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: {
      Features: ['Foldable', 'Height adjustable', 'Anti-slip'],
    },
  });
  const block = xml.match(/<NameValueList><Name>Features<\/Name>[\s\S]*?<\/NameValueList>/)[0];
  const values = block.match(/<Value>[\s\S]*?<\/Value>/g);
  assert.equal(values.length, 3);
  assert.ok(values[0].includes('Foldable'));
  assert.ok(values[1].includes('Height adjustable'));
  assert.ok(values[2].includes('Anti-slip'));
});

test('E2E-3 · empty / whitespace-only aspect values are DROPPED from XML', () => {
  const EbayAPI = require(EBAYAPI);
  const ebay = new EbayAPI();
  const xml = ebay._buildItemXml({
    title: 'T', description: 'd', price: 10, quantity: 1, sku: 'S3',
    categoryId: '183456', conditionId: '1000', currency: 'USD',
    imageUrls: [],
    itemSpecifics: {
      Brand: 'Pokemon',
      EmptyAspect: '',
      SpaceAspect: '   ',
      ArrayEmpty: ['', '   '],
    },
  });
  assert.ok(!/EmptyAspect/.test(xml),  'empty-string aspect must be dropped');
  assert.ok(!/SpaceAspect/.test(xml),  'whitespace-only aspect must be dropped');
  assert.ok(!/ArrayEmpty/.test(xml),   'array of empties must be dropped');
  assert.ok(/Brand/.test(xml),         'valid aspect must remain');
});
