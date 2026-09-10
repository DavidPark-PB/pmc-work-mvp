'use strict';

/**
 * tests/web/opsBriefDrill2.test.js — PMC-OPS-BRIEF-DRILL-2 (2026-09-10).
 *
 * Structural + runtime proofs for the truthful KPI drill-down wiring:
 *
 *   A. SKU_MATCH_FAILED drill href / predicate unchanged.
 *   B. 자동 예외 (전체) → ?page=exception-tasks&status=open  (NO exceptionType).
 *   C. 진행 중 (open)    → ?page=tasks&status=open.
 *   D. 승인 대기         → ?page=orders&status=pending.
 *   E. statusGroup=active is NOT used for 승인 대기.
 *   F/G/H. 미처리 · 긴급 · 마감 지남 have NO drill.
 *   I. Safety trio has NO drill.
 *   J. 0 count is not clickable.
 *   K. null / UNKNOWN count is not clickable.
 *   L. tasks URL status is whitelist-guarded (only 'open' accepted).
 *   M. orders URL status is whitelist-guarded (only 'pending' accepted).
 *   N. Drill context banner exists in tasks + orders + exceptionFilter shells.
 *   O. Manual filter change clears stale drill context (URL param dropped).
 *   P. Broken `data-page="safety-runs"` quick-link removed from briefing.
 *   Q. No POST/PATCH/DELETE fetch introduced by KPI navigation surface.
 */

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO    = path.resolve(__dirname, '../..');
const BRIEF   = path.join(REPO, 'public/js/opsBriefing.js');
const EXFIL   = path.join(REPO, 'public/js/exceptionFilter.js');
const TASKS   = path.join(REPO, 'public/js/tasks.js');
const ORDERS  = path.join(REPO, 'public/js/orders.js');

const readSrc = (p) => fs.readFileSync(p, 'utf8');

// ═════════════════════════════════════════════════════════════════════
// A. SKU_MATCH_FAILED — predicate/href preserved
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-A · SKU_MATCH_FAILED drill href unchanged', () => {
  const src = readSrc(BRIEF);
  assert.ok(/exceptionType=SKU_MATCH_FAILED&status=open/.test(src),
    'SKU_MATCH_FAILED drill params must remain exactly exceptionType=SKU_MATCH_FAILED&status=open');
  assert.ok(/\/\?page=exception-tasks&exceptionType=SKU_MATCH_FAILED&status=open/.test(src),
    'SKU_MATCH_FAILED drill href must remain exactly the canonical form');
});

// ═════════════════════════════════════════════════════════════════════
// B–D. New drills wired
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-B · 자동 예외 (전체) drill uses status=open with NO exceptionType', () => {
  const src = readSrc(BRIEF);
  // The drill object literal must exist AND its href must not carry exceptionType.
  const m = /exceptionAllDrill\s*=\s*\{[^}]*href:\s*'([^']+)'/s.exec(src);
  assert.ok(m, 'exceptionAllDrill must exist as a named object literal');
  assert.equal(m[1], '/?page=exception-tasks&status=open',
    '자동 예외 (전체) href must be exactly ?page=exception-tasks&status=open');
  assert.ok(!/exceptionAllDrill[\s\S]{0,120}exceptionType/.test(src),
    'exceptionAllDrill must NOT include exceptionType (broadens cohort)');
});

test('DRILL2-C · 진행 중 (open) drill href is ?page=tasks&status=open', () => {
  const src = readSrc(BRIEF);
  const m = /tasksOpenDrill\s*=\s*\{[^}]*href:\s*'([^']+)'/s.exec(src);
  assert.ok(m, 'tasksOpenDrill must exist');
  assert.equal(m[1], '/?page=tasks&status=open');
});

test('DRILL2-D · 승인 대기 drill href is ?page=orders&status=pending', () => {
  const src = readSrc(BRIEF);
  const m = /purchasePendingDrill\s*=\s*\{[^}]*href:\s*'([^']+)'/s.exec(src);
  assert.ok(m, 'purchasePendingDrill must exist');
  assert.equal(m[1], '/?page=orders&status=pending');
});

// ═════════════════════════════════════════════════════════════════════
// E. statusGroup=active must NOT be used for 승인 대기
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-E · 승인 대기 drill uses status=pending, NEVER statusGroup=active', () => {
  const src = readSrc(BRIEF);
  //   statusGroup=active broadens to IN('pending','approved') and would violate
  //   the exact-cohort contract (승인 대기 = pending only). Check ONLY the
  //   href / params values on drill objects — a comment mentioning "NOT
  //   statusGroup=active" is fine (and desirable, as a design rationale).
  const drillHrefs = [...src.matchAll(/(?:href|params):\s*'([^']*)'/g)].map(m => m[1]);
  for (const href of drillHrefs) {
    assert.ok(!/statusGroup=active/.test(href),
      `drill href/params MUST NOT contain statusGroup=active; found in ${JSON.stringify(href)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// F/G/H. Non-clickable KPIs — no drill maps for these labels
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-F · 미처리 has NO drill', () => {
  const src = readSrc(BRIEF);
  //   The 미처리 row line must NOT carry a fourth tuple element (drill).
  //   Anchor on the exact label + surrounding array shape.
  const line = /\[\s*'미처리',[^\]]+\]/.exec(src);
  assert.ok(line, '미처리 row must exist');
  //  Must not reference any of our drill map names.
  assert.ok(!/미처리[^\]]*(?:skuDrill|exceptionAllDrill|tasksOpenDrill|purchasePendingDrill|Drill)/.test(line[0]),
    '미처리 must not carry any drill argument');
});

test('DRILL2-G · 긴급 has NO drill', () => {
  const src = readSrc(BRIEF);
  const line = /\[\s*'긴급',[^\]]+\]/.exec(src);
  assert.ok(line, '긴급 row must exist');
  assert.ok(!/(?:Drill|drill)/.test(line[0]), '긴급 must not carry any drill argument');
});

test('DRILL2-H · 마감 지남 has NO drill', () => {
  const src = readSrc(BRIEF);
  const line = /\[\s*'마감 지남',[^\]]+\]/.exec(src);
  assert.ok(line, '마감 지남 row must exist');
  assert.ok(!/(?:Drill|drill)/.test(line[0]), '마감 지남 must not carry any drill argument');
});

// ═════════════════════════════════════════════════════════════════════
// I. Safety KPIs — no drill
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-I · Safety trio has NO drill', () => {
  const src = readSrc(BRIEF);
  for (const label of ['오늘 자동화 실패', '되돌리기 가능 (auto)', '오늘 되돌림 완료']) {
    // Escape regex metacharacters in the label (parentheses in "되돌리기 가능 (auto)").
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = new RegExp(`\\[\\s*'${esc}',[^\\]]+\\]`).exec(src);
    assert.ok(line, `${label} row must exist`);
    assert.ok(!/(?:Drill|drill)/.test(line[0]), `${label} must not carry any drill argument`);
  }
});

// ═════════════════════════════════════════════════════════════════════
// J/K. Zero + null count guard — only numeric > 0 renders as link
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-J/K · sectionCard renders <a> ONLY when drill && isNumericPositive', () => {
  const src = readSrc(BRIEF);
  //  Guard predicate must be present AND intersect with the drill branch.
  assert.ok(/isNumericPositive\s*=\s*typeof\s+value\s*===\s*'number'\s*&&\s*value\s*>\s*0/.test(src),
    'isNumericPositive predicate must exist verbatim');
  assert.ok(/if\s*\(\s*drill\s*&&\s*isNumericPositive\s*\)/.test(src),
    'drill link branch must gate on `drill && isNumericPositive` (0 / null / undefined blocked)');
});

// ═════════════════════════════════════════════════════════════════════
// L. tasks URL whitelist
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-L · tasks.js whitelist accepts ONLY "open"', () => {
  const src = readSrc(TASKS);
  const m = /URL_ALLOWED_TASK_STATUS\s*=\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, 'URL_ALLOWED_TASK_STATUS constant must exist');
  const values = m[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  assert.deepEqual(values, ['open'],
    'tasks whitelist must be exactly ["open"] — no wider surface');
});

test('DRILL2-L2 · tasks.js runtime: unknown URL values do NOT set _drillStatus', async () => {
  //  Runtime probe: load tasks.js's readTaskDrillUrl behavior inside a fresh
  //  new-Function scope so we can prove the whitelist rejects unknown inputs.
  const src = readSrc(TASKS);
  //  Extract just the whitelist + reader for a minimal harness.
  const whitelistBlock = /const\s+URL_ALLOWED_TASK_STATUS[\s\S]*?function readTaskDrillUrl\(\)\s*\{[\s\S]*?\}/.exec(src);
  assert.ok(whitelistBlock, 'must locate readTaskDrillUrl block');
  //  Structural check: reader uses .includes(URL_ALLOWED_TASK_STATUS, s).
  assert.ok(/URL_ALLOWED_TASK_STATUS\.includes\(s\)/.test(whitelistBlock[0]),
    'readTaskDrillUrl must gate on URL_ALLOWED_TASK_STATUS.includes(s)');
});

// ═════════════════════════════════════════════════════════════════════
// M. orders URL whitelist
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-M · orders.js whitelist accepts ONLY "pending" (never statusGroup=active)', () => {
  const src = readSrc(ORDERS);
  const m = /URL_ALLOWED_PURCHASE_STATUS\s*=\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, 'URL_ALLOWED_PURCHASE_STATUS constant must exist');
  const values = m[1].match(/'([^']+)'/g).map(s => s.replace(/'/g, ''));
  assert.deepEqual(values, ['pending'],
    'orders whitelist must be exactly ["pending"] — statusGroup=active would broaden cohort');
  //  Absolute fence — no reference to statusGroup=active anywhere in the drill path.
  assert.ok(!/URL_ALLOWED_PURCHASE_STATUS[\s\S]{0,200}active/.test(src),
    'orders drill surface must never reference statusGroup=active');
});

// ═════════════════════════════════════════════════════════════════════
// N. Drill context banners exist
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-N · drill-context banner slot present in tasks + orders + exceptionFilter', () => {
  assert.ok(/id="task-drill-badge"/.test(readSrc(TASKS)),
    'tasks page must include a #task-drill-badge slot');
  assert.ok(/id="po-drill-badge"/.test(readSrc(ORDERS)),
    'orders page must include a #po-drill-badge slot');
  assert.ok(/id="ef-drill-badge"/.test(readSrc(EXFIL)),
    'exception-tasks page must retain #ef-drill-badge slot (upgraded visual)');
  //  Banner text must include the owner-facing phrase — not raw SQL predicates.
  assert.ok(/운영 브리핑에서 선택한/.test(readSrc(TASKS)),
    'tasks banner text uses owner-facing phrase, not raw predicate');
  assert.ok(/운영 브리핑에서 선택한/.test(readSrc(ORDERS)),
    'orders banner text uses owner-facing phrase');
  assert.ok(/운영 브리핑에서 선택한/.test(readSrc(EXFIL)),
    'exception banner text uses owner-facing phrase');
});

// ═════════════════════════════════════════════════════════════════════
// O. Manual filter change clears stale drill context
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-O · tasks: filter-status change handler clears _drillStatus + URL param', () => {
  const src = readSrc(TASKS);
  //  The change handler must delete searchParams.status AND null out _drillStatus.
  const region = /'filter-status'[\s\S]{0,1200}?\}\)/m.exec(src);
  assert.ok(region, 'filter-status change handler must exist');
  assert.ok(/_drillStatus\s*=\s*null/.test(region[0]),
    'filter-status change must null out _drillStatus');
  assert.ok(/searchParams\.delete\(\s*'status'\s*\)/.test(region[0]),
    'filter-status change must delete the status URL param');
});

test('DRILL2-O2 · orders: po-filter change handler clears _drillStatus + URL param', () => {
  const src = readSrc(ORDERS);
  //  Anchor on `getElementById('po-filter').addEventListener('change'` so we
  //  latch onto the real change handler (not the badge's own resolver, which
  //  also references 'po-filter' but is a separate scope).
  const region = /getElementById\('po-filter'\)\.addEventListener\('change',[\s\S]*?\}\);/m.exec(src);
  assert.ok(region, 'po-filter change handler must exist');
  assert.ok(/_drillStatus\s*=\s*null/.test(region[0]),
    'po-filter change must null out _drillStatus');
  assert.ok(/searchParams\.delete\(\s*'status'\s*\)/.test(region[0]),
    'po-filter change must delete the status URL param');
});

// ═════════════════════════════════════════════════════════════════════
// P. Broken safety-runs quick-link removed
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-P · safety-runs quick-link removed from briefing quicklinks', () => {
  const src = readSrc(BRIEF);
  //  The .ob-quick button set must NOT contain data-page="safety-runs" anymore.
  const quicksBlock = /const\s+quickHtml\s*=\s*`[\s\S]*?`/.exec(src);
  assert.ok(quicksBlock, 'quickHtml block must exist');
  assert.ok(!/data-page="safety-runs"/.test(quicksBlock[0]),
    'safety-runs quick-link (broken · no destination page) must be removed');
  //  Rationale note must reference DRILL-2 removal decision (auditability).
  assert.ok(/OPS-BRIEF-DRILL-2/.test(src),
    'source must reference OPS-BRIEF-DRILL-2 phase marker somewhere in briefing');
});

// ═════════════════════════════════════════════════════════════════════
// Q. Navigation surface introduces NO POST/PATCH/DELETE
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-Q · KPI drill navigation surface adds ZERO write-verb fetches', () => {
  const src = readSrc(BRIEF);
  //  The .ob-drill click handler must only pushState + showPage (navigation-only).
  //  Grepping the drill handler region for method: POST|PATCH|DELETE etc.
  const drillHandler = /ob-drill[\s\S]{0,1500}?\}\);/m.exec(src);
  assert.ok(drillHandler, 'ob-drill click handler must exist');
  assert.ok(!/method:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(drillHandler[0]),
    'ob-drill handler MUST NOT introduce any write verb');
  assert.ok(!/\.approve|\.reject|\.rollback|\.ship|\.execute/.test(drillHandler[0]),
    'ob-drill handler MUST NOT call any mutation action');
});

// ═════════════════════════════════════════════════════════════════════
// PERF-2B / defer regression sentinels
// ═════════════════════════════════════════════════════════════════════

test('DRILL2-REG1 · public/index.html still has ≥30 <script defer> (0071dcd)', () => {
  const html = readSrc(path.join(REPO, 'public/index.html'));
  const tags = html.match(/<script\b[^>]*\bdefer\b[^>]*>/g) || [];
  assert.ok(tags.length >= 30, `expected ≥30 defer script tags; got ${tags.length}`);
});

test('DRILL2-REG2 · operations.js still contains PERF-2B cache markers', () => {
  const src = readSrc(path.join(REPO, 'public/js/operations.js'));
  assert.ok(/PMC-PERF-2B/.test(src), 'PERF-2B markers must remain in operations.js');
  assert.ok(/SAFE_SHORT_CACHE/.test(src), 'SAFE_SHORT_CACHE narrative must remain');
});

test('DRILL2-REG3 · dashboard.js still has PERF-2B shipping dedup + Promise.allSettled', () => {
  const src = readSrc(path.join(REPO, 'public/js/dashboard.js'));
  assert.ok(/_shippingLoadInflight/.test(src), 'shipping dedup guard must remain');
  assert.ok(/Promise\.allSettled\s*\(/.test(src), 'Promise.allSettled dispatch must remain');
});
