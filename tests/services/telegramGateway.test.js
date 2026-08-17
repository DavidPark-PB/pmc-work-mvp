'use strict';

/**
 * tests/services/telegramGateway.test.js — P0 incident response (2026-08-17).
 *
 * ABSOLUTE RULES for this file:
 *   · NEVER call the real Telegram API (fetch to api.telegram.org forbidden)
 *   · NEVER use a real TELEGRAM_BOT_TOKEN — tests must fabricate a stub token
 *   · rawSendFn is always a mock — the gateway sees only in-process fakes
 *
 * Verifies the P0 safety layer:
 *   env kill switch (TELEGRAM_KILL_SWITCH / DISABLE_TELEGRAM_SEND / TELEGRAM_DRY_RUN)
 *   dev-mode block (NODE_ENV != 'production' unless ALLOW_TELEGRAM_IN_DEV=true)
 *   per-run hard cap (default 5 within a 5-min window per jobName)
 *   per-hour hard cap (default 10 per (jobName, chatShort))
 *   idempotency (identical (chatShort, text) within 15 min)
 *   suppressed audit ring buffer
 *   telegramBot.js DOES NOT bypass the gateway
 *   telegramBot.js exposes _rawSendMessage — but every public sender uses gateway
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Deterministic env baseline for each test scope.
// MUST be async so we hold the env patch until the entire test body finishes;
// otherwise the try/finally restores env before any async assertion runs.
async function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; process.env[k] = patch[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function loadGateway() {
  delete require.cache[require.resolve('../../src/services/telegramGateway')];
  const g = require('../../src/services/telegramGateway');
  g._resetForTest();
  return g;
}

// ─── Kill switch matrix ──────────────────────────────────

test('P0-1. TELEGRAM_KILL_SWITCH=true blocks every send (reason=kill_switch)', async () => {
  await withEnv({ NODE_ENV: 'production', TELEGRAM_KILL_SWITCH: 'true', DISABLE_TELEGRAM_SEND: '', TELEGRAM_DRY_RUN: '', ALLOW_TELEGRAM_IN_DEV: '' }, async () => {
    const g = loadGateway();
    let called = 0;
    const r = await g.guardedSend({ text: 'x', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return { ok: true }; } });
    assert.equal(called, 0, 'rawSendFn must NOT execute when kill switch is on');
    assert.equal(r.suppressed, true);
    assert.equal(r.reason, 'kill_switch');
  });
});

test('P0-2. DISABLE_TELEGRAM_SEND=true is treated identically to kill switch', async () => {
  await withEnv({ NODE_ENV: 'production', TELEGRAM_KILL_SWITCH: '', DISABLE_TELEGRAM_SEND: 'true', TELEGRAM_DRY_RUN: '', ALLOW_TELEGRAM_IN_DEV: '' }, async () => {
    const g = loadGateway();
    let called = 0;
    const r = await g.guardedSend({ text: 'x', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return { ok: true }; } });
    assert.equal(called, 0);
    assert.equal(r.reason, 'kill_switch');
  });
});

test('P0-3. TELEGRAM_DRY_RUN=true blocks + records the intended send (reason=dry_run)', async () => {
  await withEnv({ NODE_ENV: 'production', TELEGRAM_KILL_SWITCH: '', DISABLE_TELEGRAM_SEND: '', TELEGRAM_DRY_RUN: 'true', ALLOW_TELEGRAM_IN_DEV: '' }, async () => {
    const g = loadGateway();
    let called = 0;
    const r = await g.guardedSend({ text: 'x', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return {}; } });
    assert.equal(called, 0);
    assert.equal(r.reason, 'dry_run');
    const s = g.getSuppressed();
    assert.equal(s[s.length - 1].reason, 'dry_run');
  });
});

test('P0-4. NODE_ENV != production (default dev) blocks unless ALLOW_TELEGRAM_IN_DEV=true', async () => {
  await withEnv({ NODE_ENV: 'test', TELEGRAM_KILL_SWITCH: '', DISABLE_TELEGRAM_SEND: '', TELEGRAM_DRY_RUN: '', ALLOW_TELEGRAM_IN_DEV: '' }, async () => {
    const g = loadGateway();
    let called = 0;
    const r = await g.guardedSend({ text: 'x', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return {}; } });
    assert.equal(called, 0, 'must not send in non-production without explicit opt-in');
    assert.equal(r.reason, 'non_production');
  });
});

test('P0-4b. ALLOW_TELEGRAM_IN_DEV=true bypasses the non-production block', async () => {
  await withEnv({ NODE_ENV: 'test', TELEGRAM_KILL_SWITCH: '', DISABLE_TELEGRAM_SEND: '', TELEGRAM_DRY_RUN: '', ALLOW_TELEGRAM_IN_DEV: 'true' }, async () => {
    const g = loadGateway();
    let called = 0;
    const r = await g.guardedSend({ text: 'first', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return { ok: true, message_id: 1 }; } });
    assert.equal(called, 1);
    assert.equal(r.sent, true);
  });
});

// ─── Hard limits (production baseline) ──────────────────

function prodEnv(extra = {}) {
  return { NODE_ENV: 'production', TELEGRAM_KILL_SWITCH: '', DISABLE_TELEGRAM_SEND: '', TELEGRAM_DRY_RUN: '', ALLOW_TELEGRAM_IN_DEV: '', ...extra };
}

test('P0-5. per-run hard cap: after 5 sends within run window, 6th is suppressed (reason=per_run_limit)', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    let called = 0;
    const rawSendFn = async () => { called++; return { ok: true }; };
    for (let i = 0; i < 5; i++) {
      const r = await g.guardedSend({ text: 'msg-' + i, jobName: 'per_run_test', chatIdShort: 'c', rawSendFn });
      assert.equal(r.sent, true, `send ${i + 1} must go through`);
    }
    const overflow = await g.guardedSend({ text: 'msg-6', jobName: 'per_run_test', chatIdShort: 'c', rawSendFn });
    assert.equal(called, 5, 'rawSendFn must NOT be called past the cap');
    assert.equal(overflow.suppressed, true);
    assert.equal(overflow.reason, 'per_run_limit');
  });
});

test('P0-6. per-hour hard cap: 10 successful sends per (job, chat) allowed; 11th suppressed', async () => {
  await withEnv(prodEnv({ TELEGRAM_MAX_PER_RUN: '999' }), async () => {   // raise per-run so we exercise per-hour
    const g = loadGateway();
    let called = 0;
    const rawSendFn = async () => { called++; return { ok: true }; };
    for (let i = 0; i < 10; i++) {
      const r = await g.guardedSend({ text: 'msg-' + i, jobName: 'per_hour_test', chatIdShort: 'c', rawSendFn });
      assert.equal(r.sent, true, `send ${i + 1} within per-hour limit must succeed`);
    }
    const overflow = await g.guardedSend({ text: 'msg-11', jobName: 'per_hour_test', chatIdShort: 'c', rawSendFn });
    assert.equal(called, 10);
    assert.equal(overflow.reason, 'per_hour_limit');
  });
});

test('P0-7. idempotency: identical (chatShort, text) within window suppressed (reason=idempotent)', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    let called = 0;
    const rawSendFn = async () => { called++; return { ok: true }; };
    const r1 = await g.guardedSend({ text: 'same text', jobName: 'idem', chatIdShort: 'c', rawSendFn });
    const r2 = await g.guardedSend({ text: 'same text', jobName: 'idem', chatIdShort: 'c', rawSendFn });
    assert.equal(r1.sent, true);
    assert.equal(r2.sent, false);
    assert.equal(r2.reason, 'idempotent');
    assert.equal(called, 1, 'raw transport called exactly once for identical text');
  });
});

test('P0-8. suppressed ring buffer keeps entries with reason + preview but NEVER token/chat_id full', async () => {
  await withEnv(prodEnv({ TELEGRAM_KILL_SWITCH: 'true' }), async () => {
    const g = loadGateway();
    await g.guardedSend({ text: 'suppressed-1', jobName: 'j', chatIdShort: 'shortH', rawSendFn: async () => ({}) });
    await g.guardedSend({ text: 'suppressed-2', jobName: 'j', chatIdShort: 'shortH', rawSendFn: async () => ({}) });
    const s = g.getSuppressed();
    assert.equal(s.length, 2);
    for (const entry of s) {
      assert.equal(entry.reason, 'kill_switch');
      assert.equal(entry.job_name, 'j');
      assert.equal(entry.chat_short, 'shortH');
      assert.ok(entry.text_preview.length <= 60);
      assert.ok(entry.suppressed_at);
      assert.ok(entry.fingerprint);
    }
    // The buffer must NEVER include a raw chat_id like "-100xxxxxx" or the token.
    const flat = JSON.stringify(s);
    assert.doesNotMatch(flat, /-100\d{6,}/);
    assert.doesNotMatch(flat, /\d{7,}:[A-Za-z0-9_-]{20,}/);   // Telegram bot-token shape
  });
});

test('P0-8b. suppressed ring buffer is bounded (max size cap)', async () => {
  await withEnv(prodEnv({ TELEGRAM_KILL_SWITCH: 'true', TELEGRAM_SUPPRESSED_RING: '10' }), async () => {
    const g = loadGateway();
    for (let i = 0; i < 25; i++) {
      await g.guardedSend({ text: 'msg-' + i, jobName: 'j', chatIdShort: 'c', rawSendFn: async () => ({}) });
    }
    const s = g.getSuppressed();
    assert.ok(s.length <= 10, `expected <=10, got ${s.length}`);
    // The last entry must be the most recent (msg-24)
    assert.match(s[s.length - 1].text_preview, /msg-24/);
  });
});

// ─── Bulk aggregation helper ────────────────────────────

test('P0-9. sendBulkAggregated collapses 5+ items into ONE summary message', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    const items = Array.from({ length: 20 }, (_, i) => ({ sku: 'S' + i }));
    let sends = 0;
    const captured = [];
    const sendFn = async (text) => { sends++; captured.push(text); return { sent: true }; };
    const r = await g.sendBulkAggregated({
      jobName: 'bulk_test', items,
      formatLine: (it, i) => `${i + 1}. ${it.sku}`,
      header: 'Bulk summary',
      maxRendered: 10,
      sendFn,
    });
    assert.equal(sends, 1, 'MUST call sendFn exactly once regardless of item count');
    assert.equal(r.aggregated, true);
    assert.equal(r.itemCount, 20);
    assert.match(captured[0], /Bulk summary/);
    assert.match(captured[0], /1\. S0/);
    assert.match(captured[0], /10\. S9/);
    assert.match(captured[0], /\+10 more suppressed/);
  });
});

test('P0-9b. sendBulkAggregated below threshold does NOT aggregate (caller handles)', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    const r = await g.sendBulkAggregated({
      jobName: 'bulk_test', items: [{ sku: 'A' }, { sku: 'B' }],
      formatLine: it => it.sku, header: '', sendFn: async () => ({ sent: true }),
    });
    assert.equal(r.aggregated, false);
    assert.equal(r.itemCount, 2);
  });
});

// ─── isBlocked() diagnostic ─────────────────────────────

test('P0-10. isBlocked() reports the exact reason without exposing secrets', async () => {
  await withEnv(prodEnv({ TELEGRAM_KILL_SWITCH: 'true' }), async () => {
    const g = loadGateway();
    const b = g.isBlocked();
    assert.equal(b.blocked, true);
    assert.equal(b.reason, 'kill_switch');
    // Absolutely nothing else — no token/chat leak in the diagnostic
    assert.deepEqual(Object.keys(b).sort(), ['blocked', 'reason']);
  });
});

test('P0-10b. isBlocked() in production with all clear → { blocked: false }', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    const b = g.isBlocked();
    assert.equal(b.blocked, false);
    assert.equal(b.reason, null);
  });
});

// ─── telegramBot.js integration + no-bypass audit ──────

test('P0-11. telegramBot.js routes every public sender through the gateway (static source audit)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/telegramBot.js'), 'utf8');
  // Every send must call gateway.guardedSend at least once.
  assert.match(src, /gateway\.guardedSend/);
  assert.match(src, /require\(['"]\.\/telegramGateway['"]\)/);
  // No direct api.telegram.org fetch OUTSIDE the raw transport helper (_rawSendMessage) or webhook-info/setWebhook / answerCallbackQuery.
  const senderFns = ['sendMessage', 'sendPlain', 'sendWithButtons', 'sendAlert', 'sendProfitReport', 'sendMorningBriefing', 'editMessage'];
  for (const fn of senderFns) {
    const fnStart = src.indexOf('async function ' + fn + '(');
    assert.ok(fnStart > 0, `function ${fn} not found`);
    // Extract the function body (crude but sufficient — up to the next 'async function' or module.exports).
    const nextStart = Math.min(
      ...['async function ', '\nmodule.exports'].map(pat => {
        const idx = src.indexOf(pat, fnStart + 1);
        return idx > 0 ? idx : Infinity;
      })
    );
    const body = src.slice(fnStart, nextStart);
    assert.doesNotMatch(body, /fetch\(\s*['"]https:\/\/api\.telegram\.org/i, `${fn}: MUST NOT fetch Telegram API directly — must route via gateway`);
  }
});

test('P0-11b. no scheduler / job / agent / service file bypasses telegramBot.js to hit api.telegram.org directly', () => {
  const globs = ['src/jobs', 'src/agents', 'src/services'];
  const violations = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // Skip telegramBot.js itself and the gateway (those legitimately touch fetch)
      if (p.endsWith('telegramBot.js')) continue;
      if (p.endsWith('telegramGateway.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/fetch\(\s*['"`]https:\/\/api\.telegram\.org/i.test(src)) {
        violations.push(p);
      }
    }
  }
  for (const g of globs) {
    const abs = path.resolve(__dirname, '../../', g);
    if (fs.existsSync(abs)) scan(abs);
  }
  assert.deepEqual(violations, [], 'files calling api.telegram.org directly (must route via telegramBot.js which routes via gateway):\n' + violations.join('\n'));
});

// ─── Webhook auto-registration is opt-in ────────────────

test('P0-12. server.js does NOT auto-register Telegram webhook unless TELEGRAM_ENABLE_WEBHOOK=true', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
  assert.match(src, /TELEGRAM_ENABLE_WEBHOOK/);
  assert.match(src, /P0 안전장치|자동 등록을 하지 않는다|Webhook 자동 등록 SKIP/);
});

// ─── Scheduler kill switch ──────────────────────────────

test('P0-13. scheduler.js honors SCHEDULER_DISABLED=true kill switch', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/services/scheduler.js'), 'utf8');
  assert.match(src, /SCHEDULER_DISABLED/);
  assert.match(src, /P0 안전장치|모든 cron 등록 SKIP/);
});

test('P0-13b. scheduler.js: SCHEDULER_DISABLED=true skips every cron.schedule at runtime', async () => {
  await withEnv({ SCHEDULER_DISABLED: 'true' }, async () => {
    // Mock node-cron to detect any registration.
    const cronPath = require.resolve('node-cron');
    const original = require.cache[cronPath];
    const registrations = [];
    require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { schedule: (expr, fn, opts) => { registrations.push({ expr, opts }); return { stop() {} }; } } };
    delete require.cache[require.resolve('../../src/services/scheduler')];
    const scheduler = require('../../src/services/scheduler');
    try {
      scheduler.start();
      assert.equal(registrations.length, 0, 'no cron should be registered when SCHEDULER_DISABLED=true');
    } finally {
      if (original) require.cache[cronPath] = original; else delete require.cache[cronPath];
      delete require.cache[require.resolve('../../src/services/scheduler')];
    }
  });
});

// ─── Idempotency across job boundaries ─────────────────

test('P0-14. same text sent by DIFFERENT jobName is still deduplicated (fingerprint is (chat, text) only)', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    let called = 0;
    const rawSendFn = async () => { called++; return { ok: true }; };
    const a = await g.guardedSend({ text: 'shared', jobName: 'jobA', chatIdShort: 'c', rawSendFn });
    const b = await g.guardedSend({ text: 'shared', jobName: 'jobB', chatIdShort: 'c', rawSendFn });
    assert.equal(a.sent, true);
    assert.equal(b.sent, false);
    assert.equal(b.reason, 'idempotent');
    assert.equal(called, 1);
  });
});

// ─── Transport error accounting ────────────────────────

test('P0-15. transport error records suppression, does not double-send, does not corrupt counters', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    const failing = async () => { throw new Error('network_down'); };
    const r = await g.guardedSend({ text: 'x', jobName: 'j', chatIdShort: 'c', rawSendFn: failing });
    assert.equal(r.suppressed, true);
    assert.equal(r.reason, 'transport_error');
    assert.match(r.error, /network_down/);
    // Retry with different text should still be allowed (per-run counter NOT incremented on transport error)
    let called = 0;
    const r2 = await g.guardedSend({ text: 'y', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => { called++; return { ok: true }; } });
    assert.equal(called, 1);
    assert.equal(r2.sent, true);
  });
});

// ─── Existing 8C-1 sendPlain contract preserved when unblocked ─

test('P0-16. sendPlain via telegramBot.js goes through gateway (dev-blocked by default)', async () => {
  // Owner P0 재현성 수정 (2026-08-17): 이 테스트는 **non_production 차단
  // 단독** 을 검증한다. Owner가 강제하는 P0 kill switch env (TELEGRAM_KILL_SWITCH,
  // DISABLE_TELEGRAM_SEND, DISABLE_ALL_NOTIFICATIONS, ALLOW_TELEGRAM_IN_DEV) 가
  // 켜져 있으면 gateway가 non_production 검사 이전에 상위 kill로 short-circuit
  // 되어 실패한다. 아래 4개 env 를 테스트 시작 전에 반드시 임시 제거하고
  // finally 블록에서 원래 값을 복원한다.
  const _CLEAR_KEYS = ['TELEGRAM_KILL_SWITCH', 'DISABLE_TELEGRAM_SEND', 'DISABLE_ALL_NOTIFICATIONS', 'ALLOW_TELEGRAM_IN_DEV'];
  const _saved = {};
  for (const k of _CLEAR_KEYS) { _saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await withEnv({ NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'stub-token-not-real', TELEGRAM_CHAT_ID: 'stub-chat-not-real' }, async () => {
      // Force a fresh require so env is re-read.
      delete require.cache[require.resolve('../../src/services/telegramGateway')];
      delete require.cache[require.resolve('../../src/services/telegramBot')];
      require('../../src/services/telegramGateway')._resetForTest();
      const tg = require('../../src/services/telegramBot');
      // Guard against any accidental real fetch.
      const origFetch = global.fetch;
      let fetchCalled = 0;
      global.fetch = async () => { fetchCalled++; throw new Error('DO_NOT_CALL_REAL_TELEGRAM_API'); };
      try {
        const r = await tg.sendPlain('anything', { jobName: 'p0_16' });
        assert.equal(fetchCalled, 0, 'MUST NOT hit any URL when non_production block active');
        assert.equal(r.ok, false);
        assert.match(r.error || '', /suppressed_non_production/);
      } finally { global.fetch = origFetch; }
    });
  } finally {
    // Restore original env values verbatim (delete if originally undefined).
    for (const k of _CLEAR_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  }
});

test('P0-16b. sendMessage via telegramBot.js goes through gateway (dev-blocked)', async () => {
  // Same env-isolation as P0-16 — verifies non_production block alone.
  const _CLEAR_KEYS = ['TELEGRAM_KILL_SWITCH', 'DISABLE_TELEGRAM_SEND', 'DISABLE_ALL_NOTIFICATIONS', 'ALLOW_TELEGRAM_IN_DEV'];
  const _saved = {};
  for (const k of _CLEAR_KEYS) { _saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await withEnv({ NODE_ENV: 'test', TELEGRAM_BOT_TOKEN: 'stub-token-not-real', TELEGRAM_CHAT_ID: 'stub-chat-not-real' }, async () => {
      delete require.cache[require.resolve('../../src/services/telegramGateway')];
      delete require.cache[require.resolve('../../src/services/telegramBot')];
      require('../../src/services/telegramGateway')._resetForTest();
      const tg = require('../../src/services/telegramBot');
      const origFetch = global.fetch;
      let fetchCalled = 0;
      global.fetch = async () => { fetchCalled++; throw new Error('DO_NOT_CALL_REAL_TELEGRAM_API'); };
      try {
        const r = await tg.sendMessage('anything', { jobName: 'p0_16b' });
        assert.equal(fetchCalled, 0);
        assert.equal(r, null, 'suppressed sendMessage returns null (legacy shape)');
      } finally { global.fetch = origFetch; }
    });
  } finally {
    for (const k of _CLEAR_KEYS) {
      if (_saved[k] === undefined) delete process.env[k];
      else process.env[k] = _saved[k];
    }
  }
});

// ─── Stats surface ─────────────────────────────────────

test('P0-17. getStats() reports sent + suppressed counters per reason', async () => {
  await withEnv(prodEnv(), async () => {
    const g = loadGateway();
    await g.guardedSend({ text: 'a', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => ({ ok: true }) });
    await g.guardedSend({ text: 'a', jobName: 'j', chatIdShort: 'c', rawSendFn: async () => ({ ok: true }) });   // idempotent
    const s = g.getStats();
    assert.equal(s.sent, 1);
    assert.equal(s.suppressed_idempotent, 1);
    // Config surface for operator diagnostics — no secrets
    assert.ok(s.cfg);
    assert.equal(typeof s.cfg.maxPerRun, 'number');
  });
});
