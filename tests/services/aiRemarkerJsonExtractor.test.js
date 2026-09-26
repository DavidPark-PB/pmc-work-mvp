'use strict';

/**
 * tests/services/aiRemarkerJsonExtractor.test.js  (2026-09-26)
 *
 * Owner-reported: "AI 응답에서 JSON을 찾을 수 없음" — Gemini responses that
 * were nearly-parseable (wrapped in a preamble, split into markdown
 * fences, or truncated mid-JSON) blew up because the previous parser
 * tried only two extraction patterns AND threw with no diagnostic
 * context. The rewrite tries FIVE patterns and, on total miss, logs
 * the full AI response body so the next repro is fixable at a glance.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const path    = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const { _extractJsonFromAiResponse } = require(path.join(REPO, 'src/services/aiRemarker'));

test('EXT-1 · pure JSON text is parsed on the first pass', () => {
  const out = _extractJsonFromAiResponse('{"title":"Pikachu","price":10}', 'test');
  assert.deepEqual(out, { title: 'Pikachu', price: 10 });
});

test('EXT-2 · ```json fenced markdown is unwrapped', () => {
  const text = '```json\n{"a":1,"b":[2,3]}\n```';
  const out = _extractJsonFromAiResponse(text, 'test');
  assert.deepEqual(out, { a: 1, b: [2, 3] });
});

test('EXT-3 · bare ``` fenced markdown is unwrapped', () => {
  const text = '```\n{"x":true}\n```';
  const out = _extractJsonFromAiResponse(text, 'test');
  assert.deepEqual(out, { x: true });
});

test('EXT-4 · preamble text before JSON is tolerated (greedy brace slice)', () => {
  const text = 'Sure! Here is the JSON you asked for:\n{"title":"T","price":9.99}\nHope that helps!';
  const out = _extractJsonFromAiResponse(text, 'test');
  assert.deepEqual(out, { title: 'T', price: 9.99 });
});

test('EXT-5 · JSON array response is handled', () => {
  const text = 'The results:\n[1, 2, 3]';
  const out = _extractJsonFromAiResponse(text, 'test');
  assert.deepEqual(out, [1, 2, 3]);
});

test('EXT-6 · trailing garbage after JSON is trimmed by last-balanced-brace rescue', () => {
  //   Some AIs re-emit text after the JSON. Greedy `{…}` grabs too much
  //   if there's a `{` in the trailing text; the balanced-brace rescue
  //   walks back from the last `}` to find the smallest complete object.
  const text = '{"a":1,"b":{"c":2}} extra { unclosed';
  const out = _extractJsonFromAiResponse(text, 'test');
  //   Greedy brace slice would grab '{"a":1,"b":{"c":2}} extra { unclosed'
  //   which fails to parse. Rescue finds '{"a":1,"b":{"c":2}}'.
  assert.deepEqual(out, { a: 1, b: { c: 2 } });
});

test('EXT-7 · totally empty response throws with a label + preview', () => {
  assert.throws(() => _extractJsonFromAiResponse('', 'remake'),
    (e) => /AI 응답에서 JSON을 찾을 수 없음.*remake/.test(e.message));
});

test('EXT-8 · safety-refusal text throws with the refusal preview', () => {
  //   Gemini sometimes returns "I cannot help with that request." when
  //   the safety filter trips. The error message must include a preview
  //   so the operator sees what the AI said.
  const refusal = 'I cannot help with that request as it may violate the acceptable use policy.';
  assert.throws(() => _extractJsonFromAiResponse(refusal, 'reconstruct'),
    (e) => e.message.includes('reconstruct') && e.message.includes('I cannot help with that'));
});

test('EXT-9 · truncated JSON (cut off mid-object) throws with a preview', () => {
  //   Common when the AI hits its maxTokens limit.
  const truncated = '{"title":"Pikachu","description":"very long text that got cut off';
  assert.throws(() => _extractJsonFromAiResponse(truncated, 'remake'),
    (e) => /AI 응답에서 JSON을 찾을 수 없음/.test(e.message));
});

test('EXT-10 · nested JSON inside code fence with ```json language tag', () => {
  const text = `Here is my response:

\`\`\`json
{
  "titleEn": "Pokemon Card",
  "titleKo": "포켓몬 카드",
  "descriptionEn": "<p>An amazing card</p>",
  "extractedSpecs": {"Rarity": "SAR", "Card Number": "114/083"}
}
\`\`\`

Let me know if you need anything else.`;
  const out = _extractJsonFromAiResponse(text, 'reconstruct');
  assert.equal(out.titleEn, 'Pokemon Card');
  assert.equal(out.titleKo, '포켓몬 카드');
  assert.equal(out.extractedSpecs.Rarity, 'SAR');
});

test('EXT-11 · minified JSON with no whitespace is parsed', () => {
  const out = _extractJsonFromAiResponse('{"a":1,"b":2,"c":[1,2,3]}', 'test');
  assert.deepEqual(out, { a: 1, b: 2, c: [1, 2, 3] });
});

test('EXT-12 · non-string input is coerced safely (no crash)', () => {
  //   Guard against caller passing null/undefined/number by mistake.
  assert.throws(() => _extractJsonFromAiResponse(null, 'test'),
    (e) => /AI 응답에서 JSON을 찾을 수 없음/.test(e.message));
  assert.throws(() => _extractJsonFromAiResponse(undefined, 'test'),
    (e) => /AI 응답에서 JSON을 찾을 수 없음/.test(e.message));
});
