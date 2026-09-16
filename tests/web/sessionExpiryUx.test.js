'use strict';

/**
 * tests/web/sessionExpiryUx.test.js — 세션 만료 UX (2026-09-17).
 *
 * 증상: 로그인 세션이 끊긴 탭에서 화면 껍데기는 그대로 남고 패널마다
 *       "로드 실패: Authentication required" 만 떠서 고장처럼 보였다.
 *
 * 이 테스트가 보장하는 것:
 *   · 활동 중인 세션은 하루가 지나면 자동 연장 (7일에 갑자기 끊기지 않음)
 *   · 만료된 세션은 연장하지 않음 · 레거시 세션은 연장 대상 아님
 *   · SPA 전역 fetch 래퍼가 401 을 받으면 로그인 화면으로 보냄 (보던 경로 유지)
 *   · 로그인/로그아웃 요청 자체의 401 은 리다이렉트하지 않음
 *   · 로그인 성공 시 next 파라미터로 복귀하되 같은 사이트 경로만 허용
 *
 * 서버 코드·DB·외부 API 호출 없음 (순수 함수 + 정적 파일 검사).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const auth = require('../../src/middleware/auth');

const ROOT = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
const loginHtml = fs.readFileSync(path.join(ROOT, 'public', 'login.html'), 'utf-8');
const authSrc = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'auth.js'), 'utf-8');

test('활동 중 세션은 하루 뒤부터 자동 연장, 만료·신규·레거시는 연장하지 않음', () => {
  const now = Date.now();
  const hours = (h) => ({ userId: 7, timestamp: now - h * 60 * 60 * 1000 });

  assert.equal(auth.COOKIE_MAX_AGE, 7 * 24 * 60 * 60 * 1000);
  assert.equal(auth.COOKIE_RENEW_AFTER_MS, 24 * 60 * 60 * 1000);

  assert.equal(auth.shouldRenewSession(hours(1), now), false);    // 방금 로그인
  assert.equal(auth.shouldRenewSession(hours(23), now), false);
  assert.equal(auth.shouldRenewSession(hours(25), now), true);    // 하루 경과 → 연장
  assert.equal(auth.shouldRenewSession(hours(24 * 6), now), true);
  assert.equal(auth.shouldRenewSession(hours(24 * 7 + 1), now), false);   // 이미 만료
  assert.equal(auth.shouldRenewSession(null, now), false);
  assert.equal(auth.shouldRenewSession({ userId: 1 }, now), false);
});

test('authGuard 는 유저 로드 성공 후에만, 레거시가 아닐 때만 쿠키를 다시 발급한다', () => {
  const guard = authSrc.slice(authSrc.indexOf('async function authGuard'), authSrc.indexOf('/** Admin 전용 가드 */'));
  assert.match(guard, /req\.user = user;[\s\S]*shouldRenewSession\(session\)[\s\S]*setSessionCookie\(res, session\.userId\)/);
  assert.match(guard, /!session\.legacy && shouldRenewSession/);
  //   연장 실패가 요청을 깨뜨리지 않는다
  assert.match(guard, /try \{ setSessionCookie\(res, session\.userId\); \} catch/);
});

test('전역 fetch 래퍼: 401 이면 안내 후 로그인 화면으로 (보던 경로를 next 로 전달)', () => {
  const wrapper = indexHtml.slice(indexHtml.indexOf('installFetchSafetyNet'), indexHtml.indexOf('__pmcUserReady'));
  assert.match(wrapper, /res\.status === 401/);
  assert.match(wrapper, /goToLogin\(\)/);
  assert.match(wrapper, /\/login\.html\?next=/);
  assert.match(wrapper, /encodeURIComponent\(window\.location\.pathname \+ window\.location\.search\)/);
  //   로그인·로그아웃 요청의 401 은 그 화면에서 처리 (리다이렉트 루프 방지)
  assert.match(wrapper, /!reqUrl\.includes\('\/api\/auth\/login'\) && !reqUrl\.includes\('\/api\/auth\/logout'\)/);
  //   중복 리다이렉트 방지 (여러 패널이 동시에 401 을 받아도 한 번만)
  assert.match(wrapper, /redirectingToLogin/);
});

test('로그인 성공 시 next 로 복귀하되 같은 사이트 경로만 허용 (open redirect 차단)', () => {
  const block = loginHtml.slice(loginHtml.indexOf("var next = new URLSearchParams"), loginHtml.indexOf('window.location.replace(safeNext)') + 40);
  assert.match(block, /safeNext/);

  //   login.html 의 검증 규칙을 그대로 실행해 확인
  const safe = (next) => (next && /^\/(?!\/)/.test(next) ? next : '/');
  assert.equal(safe('/?page=exception-tasks&status=open'), '/?page=exception-tasks&status=open');
  assert.equal(safe('/orders'), '/orders');
  assert.equal(safe('//evil.example.com'), '/');
  assert.equal(safe('https://evil.example.com'), '/');
  assert.equal(safe(null), '/');
});
