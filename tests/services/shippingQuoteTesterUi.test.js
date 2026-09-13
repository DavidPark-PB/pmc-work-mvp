'use strict';

/**
 * tests/services/shippingQuoteTesterUi.test.js
 * PMC-CCOREA-SHIPPING-1B QUOTE TESTER UI (2026-09-13).
 *
 * Owner directive: the calculation is correct; only the admin tester UI
 * needs to become operator-usable. Locks in:
 *   §1  labeled inputs (label[for] ↔ input[id], visible above input)
 *   §2  input validation (Korean sentences · EU-required fields · non-EU tolerance)
 *   §3  result card + line-item table (no raw JSON as the primary display)
 *   §4  EU-only detail block with HS-fee formula
 *   §5  Korean error translation (no raw error JSON)
 *   §6  raw JSON kept behind a collapsed <details>
 *   §8  default values (US · 0.5kg · 20/15/10 · HS 1 · declared 0 · EUR blank · B2C)
 *       AND the "50" browser-autofill mystery (autocomplete="off" everywhere)
 *   §9  API request shape unchanged
 *
 * No jsdom dependency — we use node:vm to sandbox-load the IIFE with a
 * minimal document + window shim so the exposed pure helpers can be
 * unit-tested (window.pmcShippingRateAdmin._test surface). Structural
 * checks against the HTML template use regex on the source.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const vm      = require('node:vm');

const REPO    = path.resolve(__dirname, '../..');
const SPA_JS  = path.join(REPO, 'public/js/shippingRateAdmin.js');
const src     = () => fs.readFileSync(SPA_JS, 'utf8');

//   ─────────────────────────────────────────────────────────────
//   Sandbox: minimal DOM stub. Only the pieces readQuoteInputs()
//   and downstream helpers touch — everything else stays untouched.
//   ─────────────────────────────────────────────────────────────
function loadSpaHelpers() {
  const _els = new Map();
  const makeEl = (id, defaults = {}) => ({
    id,
    value: defaults.value ?? '',
    hidden: false,
    style: {},
    innerHTML: '',
    textContent: '',
    addEventListener: () => {},
    querySelectorAll: () => ({ forEach: () => {} }),
    parentElement: null,
    disabled: false,
    dataset: {},
  });
  //   Only IDs the SPA reads at runtime for the tester + init side effects.
  //   PMC-CCOREA-SHIPPING-1C adds sra-t-purpose · sra-t-branded · sra-t-brand.
  for (const id of [
    'sra-t-country','sra-t-actual','sra-t-l','sra-t-w','sra-t-h',
    'sra-t-hs','sra-t-dv','sra-t-eur','sra-t-sale','sra-t-out',
    'sra-t-purpose','sra-t-branded','sra-t-brand',
    'sra-t-form','sra-t-go','sra-upload','sra-shadow-reload',
    'sra-versions','sra-surcharges','sra-shadow-list','sra-shadow-summary',
    'sra-import-result','page-shipping-rate-admin','sra-c-detail',
  ]) _els.set(id, makeEl(id));

  const sandbox = {
    console,
    setTimeout, clearTimeout,
    Promise, JSON, Math, Number, String, Boolean, Array, Object, Date,
    Set, Map, RegExp, Symbol, Error, TypeError,
    Intl, encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    isNaN, isFinite,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    confirm: () => true,
    alert: () => {},
    document: {
      getElementById: (id) => _els.get(id) || null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
    },
    window: {},
    __pmcUser: { isAdmin: true },
  };
  //   Cross-wire so `window.pmcShippingRateAdmin` is reachable both ways.
  sandbox.window.document = sandbox.document;
  sandbox.window.fetch = sandbox.fetch;
  sandbox.window.confirm = sandbox.confirm;
  sandbox.window.alert = sandbox.alert;
  sandbox.window.__pmcUser = sandbox.__pmcUser;
  vm.createContext(sandbox);
  vm.runInContext(src(), sandbox, { filename: 'shippingRateAdmin.js' });
  return { helpers: sandbox.window.pmcShippingRateAdmin._test, els: _els };
}

//   ═════════════════════════════════════════════════════════════
//   §1 · labeled inputs (structural)
//   ═════════════════════════════════════════════════════════════

test('TESTER-1 · every tester input has a <label for="..."> that matches its id', () => {
  const s = src();
  //   Extract the tester form block once.
  const form = s.match(/id="sra-t-form"[\s\S]+?<\/form>/);
  assert.ok(form, 'sra-t-form block must exist in renderShell');
  const block = form[0];
  //   Every input/select in the block must have a matching label[for].
  const inputs = [...block.matchAll(/<(input|select)\s[^>]*id="(sra-t-[a-z]+)"/gi)].map(m => m[2]);
  const labels = [...block.matchAll(/<label\s+for="(sra-t-[a-z]+)"/gi)].map(m => m[1]);
  const required = ['sra-t-country','sra-t-actual','sra-t-l','sra-t-w','sra-t-h','sra-t-hs','sra-t-dv','sra-t-eur','sra-t-sale'];
  for (const id of required) {
    assert.ok(inputs.includes(id), `tester form must contain input id="${id}"`);
    assert.ok(labels.includes(id), `tester form must contain <label for="${id}"> above input`);
  }
});

test('TESTER-2 · Korean labels present (도착 국가 · 실중량 · 가로 · 세로 · 높이 · 고유 HS코드 수 · 신고가액 · 유로 환율 · 판매방식)', () => {
  const s = src();
  for (const label of ['도착 국가','실중량','가로','세로','높이','고유 HS코드 수','신고가액','유로 환율','판매방식']) {
    const re = new RegExp(`<label\\s+for="sra-t-[a-z]+"[^>]*>${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`);
    assert.ok(re.test(s), `label "${label}" MUST appear in the tester form (regex ${re})`);
  }
});

test('TESTER-3 · every tester input carries autocomplete="off" (fixes browser-autofill "50" on EUR/KRW)', () => {
  const s = src();
  //   Form-level autocomplete="off" is authoritative but per-input matters
  //   too for Chrome's non-form autofill heuristics.
  const form = s.match(/id="sra-t-form"[^>]*/)[0];
  assert.ok(/autocomplete="off"/.test(form),
    '<form id="sra-t-form"> MUST carry autocomplete="off"');
  //   Each numeric input specifically.
  for (const id of ['sra-t-actual','sra-t-l','sra-t-w','sra-t-h','sra-t-hs','sra-t-dv','sra-t-eur']) {
    const re = new RegExp(`id="${id}"[^>]*autocomplete="off"`);
    assert.ok(re.test(s), `input id="${id}" MUST carry autocomplete="off" to block browser autofill`);
  }
});

//   ═════════════════════════════════════════════════════════════
//   §8 · default values
//   ═════════════════════════════════════════════════════════════

test('TESTER-4 · form defaults match owner spec (US · 0.5kg · 20/15/10 · HS 1 · declared 0 · EUR blank · B2C)', () => {
  const s = src();
  const check = [
    [/id="sra-t-country"[^>]*value="US"/,       'country default = US'],
    [/id="sra-t-actual"[^>]*value="0\.5"/,      'actual weight default = 0.5'],
    [/id="sra-t-l"[^>]*value="20"/,             'length default = 20'],
    [/id="sra-t-w"[^>]*value="15"/,             'width default = 15'],
    [/id="sra-t-h"[^>]*value="10"/,             'height default = 10'],
    [/id="sra-t-hs"[^>]*value="1"/,             'HS default = 1 (owner-spec, was 0)'],
    [/id="sra-t-dv"[^>]*value="0"/,             'declared value default = 0'],
  ];
  for (const [re, msg] of check) assert.ok(re.test(s), msg + ` (regex ${re})`);
  //   EUR/KRW MUST be blank (no default like "50"). Match id then confirm
  //   there is NO value attribute up to the closing >.
  const eurMatch = s.match(/<input[^>]*id="sra-t-eur"[^>]*>/);
  assert.ok(eurMatch, 'sra-t-eur input must exist');
  assert.ok(!/value="[^"]+"/.test(eurMatch[0]),
    `EUR/KRW input MUST NOT carry a default value — found ${eurMatch[0]}`);
  //   The B2C option is present and appears first (default select value).
  assert.ok(/<option\s+value="B2C"/.test(s), 'B2C option MUST exist');
});

//   ═════════════════════════════════════════════════════════════
//   §5 · raw JSON collapsed (structural)
//   ═════════════════════════════════════════════════════════════

test('TESTER-5 · result section renders raw JSON inside a collapsed <details> with "개발자용 JSON 보기" label', () => {
  const s = src();
  //   The renderer emits <details>…<summary>개발자용 JSON 보기</summary><pre>…
  //   The old design streamed the raw JSON into #sra-t-out.textContent —
  //   that pattern MUST be gone.
  assert.ok(/<summary[^>]*>개발자용 JSON 보기<\/summary>/.test(s),
    'raw JSON MUST live inside <summary>개발자용 JSON 보기</summary>');
  assert.ok(!/out\.textContent\s*=\s*JSON\.stringify/.test(s),
    'raw JSON MUST NOT be assigned directly to out.textContent (old primary-display pattern)');
});

//   ═════════════════════════════════════════════════════════════
//   Behavioral tests via the vm sandbox — pure helpers
//   ═════════════════════════════════════════════════════════════

test('BEHAVIOR-fmt · fmtWon adds ko-KR thousand separators and 원 suffix', () => {
  const { helpers } = loadSpaHelpers();
  assert.equal(helpers.fmtWon(17100),      '17,100원');
  assert.equal(helpers.fmtWon(0),          '0원');
  assert.equal(helpers.fmtWon(1000000),    '1,000,000원');
  assert.equal(helpers.fmtWon(null),       '—');
  assert.equal(helpers.fmtWon(undefined),  '—');
  assert.equal(helpers.fmtWon('abc'),      '—');
});

test('BEHAVIOR-fmt · fmtKg trims trailing zeros and drops decimal on integers', () => {
  const { helpers } = loadSpaHelpers();
  assert.equal(helpers.fmtKg(0.5),   '0.5kg');
  assert.equal(helpers.fmtKg(1),     '1kg');
  assert.equal(helpers.fmtKg(1.0),   '1kg');
  assert.equal(helpers.fmtKg(1.234), '1.234kg');
  assert.equal(helpers.fmtKg(null),  '—');
});

test('BEHAVIOR-validate · US default passes (no EUR/KRW required) when brand picked', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'US', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1, declaredValueKrw: 0, eurKrwRate: null,
    saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: false,   //   owner rule 3 (2026-09-13): brand must be picked
  });
  assert.equal(r.ok, true, `expected ok — got ${JSON.stringify(r)}`);
});

test('BEHAVIOR-validate · owner rule 3 · isBranded=null blocks calc with Korean sentence', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'US', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1, declaredValueKrw: 0, eurKrwRate: null,
    saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: null,   //   the "unknown" state must NOT be allowed to compute
  });
  assert.equal(r.ok, false, `unknown brand status MUST block calc — got ${JSON.stringify(r)}`);
  assert.ok(r.messages.some(m => /브랜드 상품 여부를 선택/.test(m)),
    `Korean sentence must surface — got ${JSON.stringify(r.messages)}`);
});

test('BEHAVIOR-validate · EU without EUR/KRW → Korean error, blocks calc', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'DE', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 2, declaredValueKrw: 50000, eurKrwRate: null,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some(m => /유로 환율.*입력/.test(m)),
    `expected Korean "유로 환율" error — got ${JSON.stringify(r.messages)}`);
});

test('BEHAVIOR-validate · EU without 신고가액 → blocked', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'ES', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 2, declaredValueKrw: 0, eurKrwRate: 1600,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some(m => /신고가액이 필요/.test(m)),
    `expected 신고가액 error — got ${JSON.stringify(r.messages)}`);
});

test('BEHAVIOR-validate · EU without HS count → blocked', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'FR', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 0, declaredValueKrw: 30000, eurKrwRate: 1600,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some(m => /HS코드/.test(m)),
    `expected HS코드 error — got ${JSON.stringify(r.messages)}`);
});

test('BEHAVIOR-validate · EUR/KRW autofill "50" is rejected with sane-range message', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'DE', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 2, declaredValueKrw: 50000, eurKrwRate: 50,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, false);
  assert.ok(r.messages.some(m => /800.*3000/.test(m)),
    `sane-range message MUST reject EUR/KRW = 50 — got ${JSON.stringify(r.messages)}`);
});

test('BEHAVIOR-validate · country code lowercase 2-letter → accepted after uppercase (structural note)', () => {
  //   readQuoteInputs uppercases; validate only sees the uppercase form.
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'US', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1, declaredValueKrw: 0, eurKrwRate: null,
    saleType: 'B2C', quotePurpose: 'LISTING',
    isBranded: false,   //   owner rule 3 · brand must be picked
  });
  assert.equal(r.ok, true);
});

test('BEHAVIOR-validate · bad country / negative weight / non-integer HS all rejected with Korean sentences', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'ZZZ', actualWeightKg: -1,
    lengthCm: 0, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1.5, declaredValueKrw: -100, eurKrwRate: null,
    saleType: 'CASH', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, false);
  const joined = r.messages.join(' | ');
  assert.ok(/영문 2자리/.test(joined),   '국가 sentence');
  assert.ok(/실중량은 0보다/.test(joined), '실중량 sentence');
  assert.ok(/가로는 0보다/.test(joined),   '가로 sentence');
  assert.ok(/HS코드/.test(joined),          'HS integer sentence');
  assert.ok(/신고가액은 0 이상/.test(joined),'신고가액 sentence');
  assert.ok(/판매방식/.test(joined),        '판매방식 sentence');
});

//   ═════════════════════════════════════════════════════════════
//   §3/§4 · result renderer contract
//   ═════════════════════════════════════════════════════════════

test('RENDER-1 · US 17,100원 result renders formatted total, chargeable weight, provider, service', () => {
  const { helpers } = loadSpaHelpers();
  const j = {
    ok: true, provider: 'eGS', serviceCode: 'EGS_STD_US', destinationCountry: 'US',
    volumetricDivisor: 6000,
    actualWeightKg: 0.5, volumetricWeightKg: 0.5, chargeableWeightKg: 0.5,
    appliedWeightBracketKg: 0.5,
    baseRateKrw: 16100, fuelSurchargeKrw: 0, demandSurchargeKrw: 1000,
    euVatKrw: 0, euHsFeeKrw: 0, otherMandatoryFeeKrw: 0,
    totalShippingCostKrw: 17100,
    rateVersionId: 3, rateEffectiveFrom: '2026-09-01',
    calculationDetails: { isEuDestination: false, isExpressService: false, perKgSurchargeKrw: 2000, countryVatRate: 0, uniqueHsCodeCount: 1 },
    warnings: [],
  };
  const html = helpers.renderQuoteResultHtml(j, {
    destinationCountry: 'US', actualWeightKg: 0.5, saleType: 'B2C', declaredValueKrw: 0,
  });
  //   Big number card and detail row both show 17,100원 with thousand separator.
  assert.ok(/17,100원/.test(html), 'formatted total must contain 17,100원');
  //   Chargeable weight
  assert.ok(/0\.5kg/.test(html), 'chargeable weight rendered as 0.5kg');
  //   Provider and service surface
  assert.ok(/eGS/.test(html));
  assert.ok(/EGS_STD_US/.test(html));
  //   Every money line uses fmtWon (thousand-separator + 원)
  for (const label of ['기본운임','유류할증','수요·긴급할증','EU VAT','EU HS 수수료','기타 필수비용','총 배송비']) {
    assert.ok(html.includes(label), `line item "${label}" MUST appear`);
  }
  //   Raw JSON present but collapsed
  assert.ok(/<details[^>]*>\s*<summary[^>]*>개발자용 JSON 보기<\/summary>/.test(html),
    'raw JSON MUST be inside a collapsed <details>');
  //   No US-only EU block leakage
  assert.ok(!/EU 견적 세부내역/.test(html), 'US result must NOT render the EU block');
});

test('RENDER-2 · EU DE result renders the EU detail block including the HS formula', () => {
  const { helpers } = loadSpaHelpers();
  const j = {
    ok: true, provider: 'eGS', serviceCode: 'EGS_STD_EU_DE', destinationCountry: 'DE',
    volumetricDivisor: 6000,
    actualWeightKg: 0.5, volumetricWeightKg: 0.5, chargeableWeightKg: 0.5,
    appliedWeightBracketKg: 0.5,
    baseRateKrw: 25000, fuelSurchargeKrw: 0, demandSurchargeKrw: 1000,
    euVatKrw: 9500, euHsFeeKrw: 9600, otherMandatoryFeeKrw: 0,
    totalShippingCostKrw: 45100,
    rateVersionId: 3, rateEffectiveFrom: '2026-09-01',
    calculationDetails: { isEuDestination: true, isExpressService: false, perKgSurchargeKrw: 2000, countryVatRate: 0.19, uniqueHsCodeCount: 2 },
    warnings: [],
  };
  const html = helpers.renderQuoteResultHtml(j, {
    destinationCountry: 'DE', actualWeightKg: 0.5, saleType: 'B2C', declaredValueKrw: 50000, eurKrwRate: 1600,
  });
  assert.ok(/EU 견적 세부내역/.test(html), 'EU block header must appear');
  assert.ok(/19\.00%/.test(html),          'VAT rate 19.00% must appear');
  assert.ok(/HS 2개 × €3 × 1,600원/.test(html), 'HS fee formula literal missing');
  assert.ok(/9,600원/.test(html),          'HS fee amount formatted');
  assert.ok(/45,100원/.test(html),         'total formatted');
});

test('RENDER-3 · server ok:false surfaces the Korean translation, NOT raw error string, raw JSON kept in <details>', () => {
  const { helpers } = loadSpaHelpers();
  const j = { ok: false, errorCode: 'RATE_NOT_LOADED', message: 'RATE_NOT_LOADED for provider KPACKET' };
  const html = helpers.renderQuoteResultHtml(j, { destinationCountry: 'US' });
  assert.ok(/운임이 아직 등록되지 않은 배송사/.test(html),
    'Korean translation of RATE_NOT_LOADED must appear');
  assert.ok(/<summary[^>]*>개발자용 JSON 보기<\/summary>/.test(html),
    'raw error JSON stays behind the collapsed <summary>');
  //   Raw text of the server message must be inside the <pre>, NOT in the primary card.
  const summaryCard = html.match(/⚠ 견적 계산 실패[\s\S]*?<\/div>/);
  assert.ok(summaryCard, 'error card must render');
  assert.ok(!/RATE_NOT_LOADED for provider KPACKET/.test(summaryCard[0]),
    'raw provider mention must NOT appear in the user-facing card');
});

test('RENDER-4 · country-not-supported translates to "해당 국가의 운임이 없습니다"', () => {
  const { helpers } = loadSpaHelpers();
  const j = { ok: false, errorCode: 'COUNTRY_NOT_SUPPORTED', message: 'country ZZ not supported' };
  const html = helpers.renderQuoteResultHtml(j, {});
  assert.ok(/해당 국가의 운임이 없습니다/.test(html));
});

test('RENDER-5 · weight-over-max translates to "적용 가능한 중량구간이 없습니다"', () => {
  const { helpers } = loadSpaHelpers();
  const j = { ok: false, errorCode: 'WEIGHT_OVER_MAX_BRACKET', message: 'no bracket ≥ 300kg for EGS_STD_US' };
  const html = helpers.renderQuoteResultHtml(j, {});
  assert.ok(/적용 가능한 중량구간이 없습니다/.test(html));
});

//   ═════════════════════════════════════════════════════════════
//   §9 · API request-shape stability (regression)
//   ═════════════════════════════════════════════════════════════

test('API-SHAPE · readQuoteInputs() body still matches the server contract keys', () => {
  const { helpers, els } = loadSpaHelpers();
  //   Seed the sandboxed DOM stubs with defaults.
  els.get('sra-t-country').value = 'US';
  els.get('sra-t-actual').value  = '0.5';
  els.get('sra-t-l').value       = '20';
  els.get('sra-t-w').value       = '15';
  els.get('sra-t-h').value       = '10';
  els.get('sra-t-hs').value      = '1';
  els.get('sra-t-dv').value      = '0';
  els.get('sra-t-eur').value     = '';
  els.get('sra-t-sale').value    = 'B2C';
  els.get('sra-t-purpose').value = 'LISTING';
  els.get('sra-t-branded').value = 'unknown';
  els.get('sra-t-brand').value   = '';
  const body = helpers.readQuoteInputs();
  //   Server route accepts the same core keys PLUS optional brand context
  //   (PMC-CCOREA-SHIPPING-1C compare surface). Every core key must still be
  //   present; brand keys default safely when the operator hasn't picked.
  const CORE_KEYS = ['actualWeightKg','declaredValueKrw','destinationCountry','eurKrwRate',
     'heightCm','lengthCm','quotePurpose','saleType','uniqueHsCodeCount','widthCm'];
  for (const k of CORE_KEYS) {
    assert.ok(k in body, `readQuoteInputs must include core key ${k}`);
  }
  //   Extended keys for the compare surface.
  assert.ok('isBranded' in body, 'readQuoteInputs must surface isBranded (null when unknown)');
  assert.ok('brandName' in body, 'readQuoteInputs must surface brandName (null when blank)');
  assert.equal(body.destinationCountry, 'US');
  assert.equal(body.actualWeightKg,     0.5);
  assert.equal(body.uniqueHsCodeCount,  1);
  assert.equal(body.eurKrwRate,         null,  'empty EUR/KRW MUST send null, never NaN or 0');
  assert.equal(body.saleType,           'B2C');
  assert.equal(body.quotePurpose,       'LISTING');
});

//   ═════════════════════════════════════════════════════════════
//   §7 · responsive layout (structural)
//   ═════════════════════════════════════════════════════════════

test('RESPONSIVE · tester form uses auto-fit grid so 9 inputs wrap on narrow screens', () => {
  const s = src();
  //   The form container carries `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`
  //   — that's what makes the 9 inputs collapse to fewer columns on mobile.
  const form = s.match(/id="sra-t-form"[\s\S]+?<\/form>/)[0];
  assert.ok(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(1\d{2}px,\s*1fr\)\)/.test(form),
    'tester form must use auto-fit grid with a minmax breakpoint');
  //   Result-card row also uses auto-fit so summary cards stack on mobile.
  //   (Match anywhere in file — it's inside the render function template.)
  assert.ok(/repeat\(auto-fit,\s*minmax\(140px,\s*1fr\)\)/.test(s),
    'summary card row must use auto-fit grid');
});

//   ═════════════════════════════════════════════════════════════
//   PMC-CCOREA-SHIPPING-1C · multi-carrier compare table UI
//   ═════════════════════════════════════════════════════════════

test('COMPARE-UI-1 · tester form has 브랜드 상품 여부 · 브랜드명 · 견적 목적 inputs with labels', () => {
  const s = src();
  const form = s.match(/id="sra-t-form"[\s\S]+?<\/form>/)[0];
  for (const [id, label] of [
    ['sra-t-branded', '브랜드 상품 여부'],
    ['sra-t-brand',   '브랜드명'],
    ['sra-t-purpose', '견적 목적'],
  ]) {
    assert.ok(new RegExp(`for="${id}"[^>]*>${label}`).test(form),
      `tester form must carry a <label for="${id}">${label}`);
  }
  //   Owner rule 3 (2026-09-13): the isBranded select MUST force a pick —
  //   no unusable "unknown" default. Placeholder disabled option + two
  //   real options (true/false). The old "unknown" enum value is gone.
  assert.ok(/<option\s+value=""\s+selected\s+disabled/.test(form),
    'a placeholder disabled option must be selected by default so the user must pick');
  assert.ok(!/<option\s+value="unknown"/.test(form),
    'the "unknown" option MUST be removed (owner rule 3: user must pick brand or non-brand)');
  assert.ok(/<option\s+value="true"/.test(form),    '브랜드 상품 option must exist');
  assert.ok(/<option\s+value="false"/.test(form),   '일반상품 option must exist');
  assert.ok(/LISTING/.test(form) && /FULFILLMENT/.test(form),
    '견적 목적 must offer LISTING and FULFILLMENT');
});

test('COMPARE-UI-2 · button label is "배송사 비교" (not the old 견적 계산)', () => {
  const s = src();
  const form = s.match(/id="sra-t-form"[\s\S]+?<\/form>/)[0];
  assert.ok(/배송사 비교/.test(form),
    'submit button label must be 배송사 비교 (compare) — was 견적 계산');
});

test('COMPARE-UI-3 · runSingleQuote hits /quotes/compare (not the single /quote route)', () => {
  const s = src();
  //   The compare endpoint is the new primary surface.
  assert.ok(/\/api\/shipping\/rate-admin\/quotes\/compare/.test(s),
    'SPA must POST to /api/shipping/rate-admin/quotes/compare');
});

test('COMPARE-UI-4 · renderCompareTableHtml renders eligible+ineligible rows, marks recommended, disables restricted', () => {
  const { helpers } = loadSpaHelpers();
  const j = {
    ok: true,
    recommendedServiceCode: 'KPL_STD_US',
    brandStatusUnknown: false,
    warnings: [],
    candidates: [
      { provider: 'eGS', serviceCode: 'EGS_STD_US', serviceName: 'eGS Standard US', incoterm: 'DDP',
        status: 'BRAND_RESTRICTED', eligible: false, unavailableReason: '브랜드 제품 이용 불가 정책 (운영자 설정)',
        chargeableWeightKg: null, baseRateKrw: null, surchargeKrw: null, dutyVatKrw: null, euHsFeeKrw: null,
        totalShippingCostKrw: null, rateVersionId: 3, rateEffectiveFrom: '2026-09-01' },
      { provider: 'KPL', serviceCode: 'KPL_STD_US', serviceName: 'KPL SF US', incoterm: 'DAP',
        status: 'ELIGIBLE', eligible: true, unavailableReason: null,
        chargeableWeightKg: 0.5, baseRateKrw: 13900, surchargeKrw: 0, dutyVatKrw: 0, euHsFeeKrw: 0,
        totalShippingCostKrw: 13900, rateVersionId: 4, rateEffectiveFrom: '2026-09-13' },
      { provider: 'FedEx', serviceCode: 'FedEx_NOT_LOADED', serviceName: 'FedEx (운임 미등록)', incoterm: null,
        status: 'RATE_NOT_LOADED', eligible: false, unavailableReason: 'FedEx 운임이 아직 등록되지 않았습니다',
        chargeableWeightKg: null, baseRateKrw: null, surchargeKrw: null, dutyVatKrw: null, euHsFeeKrw: null,
        totalShippingCostKrw: null, rateVersionId: null, rateEffectiveFrom: null },
    ],
  };
  const html = helpers.renderCompareTableHtml(j, {
    destinationCountry: 'US', actualWeightKg: 0.5, saleType: 'B2C', isBranded: true, brandName: 'Pokemon',
  });
  //   Recommended chip on KPL row
  assert.ok(/KPL[\s\S]*?최저가 추천/.test(html), 'KPL row must show 최저가 추천 badge');
  //   eGS restricted row shows the reason and price columns as —
  assert.ok(/브랜드 제한|BRAND/i.test(html), 'restricted status badge must appear');
  assert.ok(/브랜드 제품 이용 불가/.test(html), 'restricted reason must appear');
  //   Restricted rows must NOT show a fabricated price
  const eGSrowMatch = html.match(/eGS[\s\S]*?<\/tr>/);
  assert.ok(eGSrowMatch, 'eGS row must be rendered');
  assert.ok(!/16,100원|17,100원/.test(eGSrowMatch[0]),
    'restricted eGS row must NOT carry any KRW price');
  //   FedEx row shows 운임 미등록
  assert.ok(/FedEx[\s\S]*?운임 미등록/.test(html), 'FedEx row must show 운임 미등록');
  //   Only ELIGIBLE row (KPL) has an enabled radio; restricted+missing rows are disabled
  const radios = [...html.matchAll(/<input\s+type="radio"[^>]*name="sra-c-pick"[^>]*>/g)].map(m => m[0]);
  assert.equal(radios.length, 3, `expected 3 radios (one per candidate) — got ${radios.length}`);
  const eligibleRadio   = radios.find(r => /KPL_STD_US/.test(r));
  const restrictedRadio = radios.find(r => /EGS_STD_US/.test(r));
  const notLoadedRadio  = radios.find(r => /FedEx_NOT_LOADED/.test(r));
  assert.ok(eligibleRadio && !/disabled/.test(eligibleRadio),   'eligible radio must be enabled');
  assert.ok(restrictedRadio && /disabled/.test(restrictedRadio), 'restricted radio must be disabled');
  assert.ok(notLoadedRadio  && /disabled/.test(notLoadedRadio),  'not-loaded radio must be disabled');
});

test('COMPARE-UI-5 · brand-status-unknown banner appears when j.brandStatusUnknown=true', () => {
  const { helpers } = loadSpaHelpers();
  const html = helpers.renderCompareTableHtml({
    ok: true, brandStatusUnknown: true, warnings: [], candidates: [], recommendedServiceCode: null,
  }, {});
  assert.ok(/BRAND_STATUS_UNKNOWN|브랜드 여부가 미확인/.test(html),
    'brand-status-unknown banner must appear');
});

test('COMPARE-UI-6 · DDP/DAP incoterm badges render with the correct label', () => {
  const { helpers } = loadSpaHelpers();
  assert.ok(/DDP/.test(helpers._incotermBadge('DDP')), 'DDP badge must render');
  assert.ok(/DAP/.test(helpers._incotermBadge('DAP')), 'DAP badge must render');
  //   Titles carry the Korean explanation
  assert.ok(/판매자 관부가세 부담/.test(helpers._incotermBadge('DDP')));
  assert.ok(/구매자 관부가세 부담/.test(helpers._incotermBadge('DAP')));
});

test('COMPARE-UI-7 · status badges cover every enum value with Korean labels', () => {
  const { helpers } = loadSpaHelpers();
  for (const [status, expectLabel] of [
    ['ELIGIBLE',               '선택 가능'],
    ['RATE_NOT_LOADED',        '운임 미등록'],
    ['COUNTRY_NOT_SUPPORTED',  '해당국가 미지원'],
    ['WEIGHT_NOT_SUPPORTED',   '중량구간 없음'],
    ['SALE_TYPE_NOT_SUPPORTED','판매방식 미지원'],
    ['BRAND_RESTRICTED',       '브랜드 제한'],
    ['INELIGIBLE',             '이용 불가'],
  ]) {
    const html = helpers._statusBadge(status);
    assert.ok(html.includes(expectLabel),
      `status ${status} must map to Korean "${expectLabel}" — got ${html}`);
  }
});

test('COMPARE-UI-8 · readQuoteInputs surfaces isBranded (null when unknown) + brandName + quotePurpose', () => {
  const { helpers, els } = loadSpaHelpers();
  els.get('sra-t-country').value = 'US';
  els.get('sra-t-actual').value  = '0.5';
  els.get('sra-t-l').value       = '20';
  els.get('sra-t-w').value       = '15';
  els.get('sra-t-h').value       = '10';
  els.get('sra-t-hs').value      = '1';
  els.get('sra-t-dv').value      = '0';
  els.get('sra-t-eur').value     = '';
  els.get('sra-t-sale').value    = 'B2C';
  els.get('sra-t-purpose').value = 'LISTING';
  els.get('sra-t-branded').value = '';   //   placeholder / not picked yet
  els.get('sra-t-brand').value   = '';
  let body = helpers.readQuoteInputs();
  assert.equal(body.isBranded, null,      'empty select → isBranded:null (validate blocks calc per owner rule 3)');
  assert.equal(body.brandName, null);
  assert.equal(body.quotePurpose, 'LISTING');
  els.get('sra-t-branded').value = 'true';
  els.get('sra-t-brand').value   = 'Pokemon';
  body = helpers.readQuoteInputs();
  assert.equal(body.isBranded, true);
  assert.equal(body.brandName, 'Pokemon');
  els.get('sra-t-branded').value = 'false';
  body = helpers.readQuoteInputs();
  assert.equal(body.isBranded, false);
});
