'use strict';

/**
 * tests/web/receiptDownload.test.js — 영수증 다운로드 팝업 차단 회귀 (2026-10-28).
 *
 * 증상: 직원들이 "영수증 다운로드를 눌러도 아무 일도 안 난다" 고 신고.
 *
 * 원인: 서명 URL 은 fetch 로 받아온 뒤(= await 를 한 번 거친 뒤) 열렸다.
 *   그 시점엔 사용자 클릭 콜스택을 이미 벗어나서 브라우저가
 *   window.open 을 팝업으로 간주하고 차단한다. 예외도 안 나고 조용히
 *   아무 일도 안 일어나서 에러 메시지조차 없었다. 팝업을 허용해 둔
 *   계정(사장·관리자)에서는 정상 동작해서 더 늦게 드러났다.
 *
 * 수정: 앵커 생성 + click(). 앵커 클릭은 팝업 차단 대상이 아니고,
 *   서버가 서명 URL 에 Content-Disposition: attachment 를 붙이므로
 *   실제 저장까지 이어진다.
 *
 * 이 테스트는 (1) window.open 이 다시 기어들어오지 않는지 구조로 막고,
 * (2) 헬퍼를 실제로 실행해서 앵커가 클릭되는지 동작으로 확인한다.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const REPO      = path.resolve(__dirname, '../../');
const EXPENSES  = path.join(REPO, 'public/js/expenses.js');
const INDEX     = path.join(REPO, 'public/index.html');

const src = fs.readFileSync(EXPENSES, 'utf8');

// 주석을 제외한 '실행되는' 코드만 남긴다 — 설명 주석에 window.open 이 등장해도
// 구조 검사가 오탐하지 않게.
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const code = stripComments(src);

// ═════════════════════════════════════════════════════════════════════
// 구조 — window.open 재유입 차단
// ═════════════════════════════════════════════════════════════════════

test('RCPT-1 · 실행 코드에 window.open 이 남아있지 않다', () => {
  const hits = code.split('\n')
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter(x => /window\.open\s*\(/.test(x.text));
  assert.equal(
    hits.length, 0,
    `window.open 은 팝업 차단에 걸린다. downloadSignedUrl 을 쓸 것. 발견: ` +
    hits.map(h => `L${h.line}: ${h.text.trim()}`).join(' | ')
  );
});

test('RCPT-2 · 영수증 핸들러 3종이 모두 downloadSignedUrl 을 쓴다', () => {
  for (const fn of ['viewReceipt', 'viewReceiptById', 'purViewReceipt']) {
    const m = code.match(new RegExp(`async function ${fn}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}`));
    assert.ok(m, `${fn} 함수를 찾지 못함`);
    assert.match(
      m[0], /downloadSignedUrl\s*\(/,
      `${fn} 이 downloadSignedUrl 을 쓰지 않는다`
    );
  }
});

// ═════════════════════════════════════════════════════════════════════
// 동작 — 팝업이 차단된 환경에서도 실제로 다운로드가 일어나는가
// ═════════════════════════════════════════════════════════════════════

/** expenses.js 에서 downloadSignedUrl 본문만 떼어내 실행 가능한 함수로 만든다. */
function loadHelper(fakeDocument, fakeWindowOpen) {
  const m = src.match(/function downloadSignedUrl\s*\([\s\S]*?\n  \}/);
  assert.ok(m, 'downloadSignedUrl 정의를 찾지 못함');
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'window', 'setTimeout', `
    ${m[0]}
    return downloadSignedUrl;
  `);
  return factory(fakeDocument, { open: fakeWindowOpen }, () => {});
}

function makeFakeDom() {
  const created = [];
  const appended = [];
  const clicked = [];
  const document = {
    createElement(tag) {
      const el = {
        tagName: tag, href: '', rel: '', download: undefined,
        click() { clicked.push(el); },
        remove() { },
      };
      created.push(el);
      return el;
    },
    body: { appendChild(el) { appended.push(el); } },
  };
  return { document, created, appended, clicked };
}

test('RCPT-3 · 팝업이 차단돼도 앵커 클릭으로 다운로드가 일어난다', () => {
  const dom = makeFakeDom();
  let popupAttempts = 0;
  // 팝업 차단 환경 재현 — window.open 은 null 을 돌려주고 아무 일도 안 한다
  const blockedOpen = () => { popupAttempts++; return null; };

  const downloadSignedUrl = loadHelper(dom.document, blockedOpen);
  downloadSignedUrl('https://example.supabase.co/storage/signed/abc', '영수증.png');

  assert.equal(popupAttempts, 0, 'window.open 을 시도하면 안 된다 (팝업 차단 대상)');
  assert.equal(dom.created.length, 1, '앵커를 하나 만들어야 한다');
  assert.equal(dom.created[0].tagName, 'a');
  assert.equal(dom.created[0].href, 'https://example.supabase.co/storage/signed/abc');
  assert.equal(dom.appended.length, 1, '앵커를 DOM 에 붙여야 click() 이 먹는다');
  assert.equal(dom.clicked.length, 1, '앵커를 클릭해야 실제 다운로드가 시작된다');
});

test('RCPT-4 · 한글 파일명이 download 속성으로 전달된다', () => {
  const dom = makeFakeDom();
  const downloadSignedUrl = loadHelper(dom.document, () => null);
  downloadSignedUrl('https://example.supabase.co/x', '261026 쿠팡17500.png');
  assert.equal(dom.created[0].download, '261026 쿠팡17500.png');
});

test('RCPT-5 · 파일명이 없어도 안전하게 동작한다', () => {
  const dom = makeFakeDom();
  const downloadSignedUrl = loadHelper(dom.document, () => null);
  downloadSignedUrl('https://example.supabase.co/x', undefined);
  assert.equal(dom.clicked.length, 1);
  assert.equal(dom.created[0].download, undefined, '빈 download 속성을 억지로 붙이지 않는다');
});

// ═════════════════════════════════════════════════════════════════════
// 캐시 — 고쳐도 직원 브라우저에 닿지 않으면 의미가 없다
// ═════════════════════════════════════════════════════════════════════

test('RCPT-6 · index.html 의 expenses.js 캐시버전이 수정 이전 값이 아니다', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = html.match(/expenses\.js\?v=([^"']+)/);
  assert.ok(m, 'index.html 에서 expenses.js 캐시버전을 찾지 못함');
  assert.notEqual(
    m[1], '20260808union',
    'expenses.js 를 고쳤으면 ?v= 를 올려야 한다. 안 그러면 브라우저가 옛 파일을 계속 쓴다.'
  );
});
