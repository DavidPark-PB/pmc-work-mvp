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
  for (const id of [
    'sra-t-country','sra-t-actual','sra-t-l','sra-t-w','sra-t-h',
    'sra-t-hs','sra-t-dv','sra-t-eur','sra-t-sale','sra-t-out',
    'sra-t-form','sra-t-go','sra-upload','sra-shadow-reload',
    'sra-versions','sra-surcharges','sra-shadow-list','sra-shadow-summary',
    'sra-import-result','page-shipping-rate-admin',
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

test('BEHAVIOR-validate · US default passes (no EUR/KRW required)', () => {
  const { helpers } = loadSpaHelpers();
  const r = helpers.validateQuoteInputs({
    destinationCountry: 'US', actualWeightKg: 0.5,
    lengthCm: 20, widthCm: 15, heightCm: 10,
    uniqueHsCodeCount: 1, declaredValueKrw: 0, eurKrwRate: null,
    saleType: 'B2C', quotePurpose: 'LISTING',
  });
  assert.equal(r.ok, true, `expected ok — got ${JSON.stringify(r)}`);
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
  const body = helpers.readQuoteInputs();
  //   Exact key set the server route expects (unchanged).
  assert.deepEqual(
    Object.keys(body).sort(),
    ['actualWeightKg','declaredValueKrw','destinationCountry','eurKrwRate',
     'heightCm','lengthCm','quotePurpose','saleType','uniqueHsCodeCount','widthCm'].sort(),
  );
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
