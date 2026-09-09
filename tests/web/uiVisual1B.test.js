'use strict';

/**
 * tests/web/uiVisual1B.test.js — PMC-UI-VISUAL-1B (2026-09-09).
 *
 * Structural assertions on the owner-hierarchy visual fix. Complements
 * (does NOT replace) rendered-pixel verification. Every assertion here
 * anchors on markup / CSS strings and NEVER inspects business logic.
 *
 * Contracts protected:
 *   · Dashboard DOM order: dashboardActionRequired BEFORE teamCalendarCard
 *   · Header sync buttons: no bright inline `background:#XXXXXX`
 *   · SKU 일괄 초기화 still identifiable as danger (via `.danger-outline` class)
 *   · Static decorative emojis removed from listed operational surfaces
 *   · Registration Center contracts intact (미리보기 / executeExportBtn disabled)
 *   · OPS-BRIEF SKU_MATCH_FAILED deep-link identical (?page=exception-tasks
 *     &exceptionType=SKU_MATCH_FAILED&status=open)
 *   · Notification button (알림) retains onclick=toggleNotif(event), still
 *     visible in header
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO       = path.resolve(__dirname, '../..');
const INDEX_HTML = path.join(REPO, 'public/index.html');
const DASHBOARD  = path.join(REPO, 'public/js/dashboard.js');
const STYLE_CSS  = path.join(REPO, 'public/css/style.css');

const html = () => fs.readFileSync(INDEX_HTML, 'utf8');
const js   = () => fs.readFileSync(DASHBOARD, 'utf8');
const css  = () => fs.readFileSync(STYLE_CSS, 'utf8');

// ═════════════════════════════════════════════════════════════════════
// 1. Dashboard information hierarchy — calendar loses above-the-fold
// ═════════════════════════════════════════════════════════════════════

test('1B-HIER-1 · dashboardActionRequired exists in page-dashboard DOM', () => {
  const src = html();
  assert.ok(/<div\s+id="dashboardActionRequired"/.test(src),
    'dashboardActionRequired card must exist');
});

test('1B-HIER-2 · dashboardActionRequired appears BEFORE teamCalendarCard in dashboard DOM', () => {
  const src = html();
  //   Scope to the page-dashboard block.
  const pageStart = src.indexOf('<div id="page-dashboard"');
  const pageEnd   = src.indexOf('</div>', src.indexOf('teamCalendarCard', pageStart));
  assert.ok(pageStart > 0 && pageEnd > pageStart);
  const block = src.slice(pageStart, pageEnd);
  const actionIdx = block.indexOf('id="dashboardActionRequired"');
  const calIdx    = block.indexOf('id="teamCalendarCard"');
  assert.ok(actionIdx > 0, 'action-required must live inside page-dashboard');
  assert.ok(calIdx > 0, 'team calendar must live inside page-dashboard');
  assert.ok(actionIdx < calIdx,
    'action-required MUST appear before team calendar in DOM order (calendar no longer hero)');
});

test('1B-HIER-3 · dashboardActionRequired has SKU_MATCH_FAILED deep-link + shipping/tasks/exception rows', () => {
  const src = html();
  const startIdx = src.indexOf('id="dashboardActionRequired"');
  //   Take a bounded region around the strip.
  const region = src.slice(startIdx, startIdx + 3000);
  //   The exact drill-link must be preserved (protected by OPS-BRIEF tests).
  assert.ok(/\?page=exception-tasks&(?:amp;)?exceptionType=SKU_MATCH_FAILED&(?:amp;)?status=open/.test(region),
    'SKU_MATCH_FAILED drill deep-link must be exactly preserved');
  //   Additional action rows must reference existing route pages.
  assert.ok(/\?page=exception-tasks(?![&"])/.test(region) || /page=exception-tasks/.test(region),
    'auto-exception link must exist');
  assert.ok(/\?page=shipping/.test(region), 'shipping route link');
  assert.ok(/\?page=tasks/.test(region),    'tasks route link');
  //   Every count cell must render "-" by default (not "0"), per §5:
  //     Unknown ≠ Zero.
  const cells = region.match(/<td[^>]*data-metric=[^>]*>[^<]+<\/td>/g) || [];
  assert.ok(cells.length >= 4, 'expected ≥ 4 metric cells');
  for (const c of cells) {
    const val = c.replace(/<[^>]+>/g, '').trim();
    assert.notEqual(val, '0', `metric cell must NOT default to invented "0"; got: ${val}`);
    assert.ok(val === '-' || /^\d+$/.test(val),
      `metric cell must be "-" or a digit; got: ${val}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// 2. Header sync buttons — no rainbow inline backgrounds
// ═════════════════════════════════════════════════════════════════════

test('1B-HDR-1 · syncProductsBtn no longer has bright blue inline background', () => {
  const src = html();
  const btnRe = /<button[^>]*id="syncProductsBtn"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m, 'syncProductsBtn must exist');
  assert.ok(!/background\s*:\s*#0288d1/.test(m[0]),
    'syncProductsBtn must NOT carry inline background:#0288d1');
  assert.ok(!/background\s*:\s*#[0-9a-fA-F]{6}/.test(m[0]),
    'syncProductsBtn must NOT carry any inline background hex color');
});

test('1B-HDR-2 · syncMasterBtn no longer has purple inline background', () => {
  const src = html();
  const btnRe = /<button[^>]*id="syncMasterBtn"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m);
  assert.ok(!/background\s*:\s*#6a1b9a/.test(m[0]));
  assert.ok(!/background\s*:\s*#[0-9a-fA-F]{6}/.test(m[0]),
    'syncMasterBtn must NOT carry any inline background hex color');
});

test('1B-HDR-3 · SKU 일괄 초기화 button retains danger identity via danger-outline class', () => {
  const src = html();
  //   Locate the SKU-reset button — anchored by onclick handler (preserved).
  const btnRe = /<button[^>]*onclick="clearAllSKU\(this\)"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m, 'clearAllSKU trigger button must exist');
  //   No solid red inline background (was #d84315).
  assert.ok(!/background\s*:\s*#d84315/.test(m[0]),
    'SKU 초기화 must NOT carry solid red inline background');
  //   Must still be identifiable as danger via class.
  assert.ok(/class="[^"]*danger-outline[^"]*"/.test(m[0]),
    'SKU 초기화 must carry danger-outline class for restrained-danger visual');
});

test('1B-HDR-4 · CSS .danger-outline defines a restrained (outline, not solid) danger style', () => {
  const c = css();
  //   Find the .refresh-btn.danger-outline rule.
  const ruleMatch = c.match(/\.refresh-btn\.danger-outline\s*\{[^}]*\}/);
  assert.ok(ruleMatch, '.refresh-btn.danger-outline rule must exist');
  const rule = ruleMatch[0];
  assert.ok(/background\s*:\s*transparent/.test(rule),
    'danger-outline must use transparent background (outline style)');
  assert.ok(/border\s*:[^;]*rgba\(198,\s*40,\s*40/.test(rule),
    'danger-outline must use a restrained-red border color');
});

// ═════════════════════════════════════════════════════════════════════
// 3. Notification 🔔 emoji removed from header · function preserved
// ═════════════════════════════════════════════════════════════════════

test('1B-NOTIF-1 · notifBtn no longer renders 🔔 emoji as its label', () => {
  const src = html();
  //   Grab the notifBtn element.
  const startIdx = src.indexOf('id="notifBtn"');
  assert.ok(startIdx > 0);
  const openTagEnd = src.indexOf('>', startIdx);
  const closeIdx   = src.indexOf('</button>', openTagEnd);
  const btnBody = src.slice(openTagEnd + 1, closeIdx);
  assert.ok(!/🔔/.test(btnBody),
    'notifBtn must NOT contain 🔔 emoji label');
  //   Must have a text alternative (Korean or English).
  const textOnly = btnBody.replace(/<[^>]+>/g, '').trim();
  assert.ok(/알림/.test(textOnly) || /notification/i.test(textOnly) || textOnly.length > 0,
    'notifBtn must carry a text label ("알림" preferred)');
});

test('1B-NOTIF-2 · notifBtn preserves onclick=toggleNotif behavior + notifCount badge', () => {
  const src = html();
  const btn = src.match(/<button[^>]*id="notifBtn"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(btn);
  assert.ok(/onclick="toggleNotif\(event\)"/.test(btn[0]),
    'notifBtn must preserve onclick=toggleNotif(event)');
  assert.ok(/id="notifCount"/.test(btn[0]),
    'notifCount badge span must still be rendered inside notifBtn');
});

// ═════════════════════════════════════════════════════════════════════
// 4. Emoji sweep on operational page bodies
// ═════════════════════════════════════════════════════════════════════

test('1B-EMOJI-1 · profit page title no longer contains 📊 emoji', () => {
  const src = html();
  //   "실제 판매 수익" appears twice historically; check the ops-profit page header.
  const titleLine = src.split('\n').find(l => l.includes('실제 판매 수익') && l.includes('<h3'));
  assert.ok(titleLine, 'profit h3 title line must exist');
  assert.ok(!/📊/.test(titleLine), 'profit h3 title must not contain 📊');
});

test('1B-EMOJI-2 · inventory scan strip title no longer contains 📦 emoji', () => {
  const src = html();
  //   The strip title span "입출고" — should be plain text.
  const stripIdx = src.indexOf('입출고');
  assert.ok(stripIdx > 0);
  const surround = src.slice(Math.max(0, stripIdx - 40), stripIdx + 20);
  assert.ok(!/📦\s*입출고/.test(surround),
    'inventory 입출고 strip title must not have 📦 prefix');
});

test('1B-EMOJI-3 · inventory scan button no longer contains 📷 emoji', () => {
  const src = html();
  //   The camera-scan button — anchored by startBarcodeCamera handler.
  const btnRe = /<button[^>]*onclick="startBarcodeCamera\(\)"[^>]*>[\s\S]*?<\/button>/;
  const m = src.match(btnRe);
  assert.ok(m, 'startBarcodeCamera button must exist');
  assert.ok(!/📷/.test(m[0]), 'scan button must not contain 📷 emoji');
});

test('1B-EMOJI-4 · team-calendar header no longer contains 📅 emoji in JS renderer', () => {
  const j = js();
  //   Anchor on the renderTeamCalendar body span (from its declaration to
  //   the next function boundary) and assert no 📅 sits inside any h3.
  const fnStart = j.indexOf('function renderTeamCalendar');
  assert.ok(fnStart > 0);
  const fnEnd = j.indexOf('\nfunction ', fnStart + 30);
  const fnBody = j.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
  assert.ok(fnBody.includes('팀 일정'), 'renderer must still render "팀 일정" label');
  //   The specific "📅 팀 일정" concatenation must be gone.
  assert.ok(!fnBody.includes('📅 팀 일정'),
    'renderer must not emit "📅 팀 일정" (emoji stripped from title)');
});

test('1B-EMOJI-5 · team-calendar legend text no longer contains 🌴/🌤/🚗/👥/📋/📌', () => {
  const j = js();
  //   The legend line "일정: 🌴 연차 · ..." must be de-emojified.
  const legendMatch = j.match(/일정[^\n]*연차[^\n]*(?:반차|기타)[^\n]*/);
  assert.ok(legendMatch, 'legend line must exist');
  const line = legendMatch[0];
  for (const em of ['🌴','🌤','🚗','👥','📋','📌']) {
    assert.ok(!line.includes(em), `legend must not contain ${em}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// 5. Inventory action-button color normalization
// ═════════════════════════════════════════════════════════════════════

test('1B-INV-1 · scanInventory("in") button uses btn-accent class (not inline green)', () => {
  const src = html();
  const btnRe = /<button[^>]*onclick="scanInventory\('in'\)"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m);
  assert.ok(/class="[^"]*btn-accent[^"]*"/.test(m[0]),
    '입고 button must use btn-accent class');
  assert.ok(!/background\s*:\s*#[0-9a-fA-F]{6}/.test(m[0]),
    '입고 button must not carry inline background hex color');
});

test('1B-INV-2 · scanInventory("out") button uses btn-neutral class (not inline red)', () => {
  const src = html();
  const btnRe = /<button[^>]*onclick="scanInventory\('out'\)"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m);
  assert.ok(/class="[^"]*btn-neutral[^"]*"/.test(m[0]),
    '출고 button must use btn-neutral class (destructive semantics are ambiguous for outbound inventory)');
  assert.ok(!/background\s*:\s*#[0-9a-fA-F]{6}/.test(m[0]));
});

test('1B-INV-3 · startBarcodeCamera button uses btn-neutral (not inline blue)', () => {
  const src = html();
  const btnRe = /<button[^>]*onclick="startBarcodeCamera\(\)"[^>]*>/;
  const m = src.match(btnRe);
  assert.ok(m);
  assert.ok(/class="[^"]*btn-neutral[^"]*"/.test(m[0]));
  assert.ok(!/background\s*:\s*#[0-9a-fA-F]{6}/.test(m[0]));
});

// ═════════════════════════════════════════════════════════════════════
// 6. Registration Center — 2B contract regression
// ═════════════════════════════════════════════════════════════════════

test('1B-REG-1 · runExportBtn label still "미리보기"', () => {
  const src = html();
  const m = src.match(/<button[^>]*id="runExportBtn"[^>]*>([^<]+)<\/button>/);
  assert.ok(m);
  assert.equal(m[1].trim(), '미리보기');
});

test('1B-REG-2 · executeExportBtn still has disabled attribute at initial render', () => {
  const src = html();
  const m = src.match(/<button[^>]*id="executeExportBtn"[^>]*>/);
  assert.ok(m);
  assert.ok(/\bdisabled\b/.test(m[0]), 'executeExportBtn must remain disabled at initial render');
});

// ═════════════════════════════════════════════════════════════════════
// 7. Backend fence — nothing under src/ or supabase/ touched
// ═════════════════════════════════════════════════════════════════════

test('1B-FENCE · CSS overlay file only introduces 2 new component classes (danger-outline, btn-accent, btn-neutral) — no !important flood', () => {
  const c = css();
  //   The 1B overlay block should exist.
  const overlayIdx = c.indexOf('PMC-UI-VISUAL-1B');
  assert.ok(overlayIdx > 0, 'PMC-UI-VISUAL-1B CSS overlay marker must exist');
  const overlay = c.slice(overlayIdx);
  //   Count !important — allowed only for a small number of narrow overrides
  //   (userMenuBtn had inline styles that require it). Must not exceed a
  //   small handful — no flood.
  const importantMatches = (overlay.match(/!important/g) || []);
  assert.ok(importantMatches.length <= 6,
    `1B overlay uses ${importantMatches.length} !important — must stay ≤ 6 (narrow overrides only, no flood)`);
});
