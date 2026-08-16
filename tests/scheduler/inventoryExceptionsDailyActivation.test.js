'use strict';

/**
 * tests/scheduler/inventoryExceptionsDailyActivation.test.js — Phase 8D.
 *
 * Verifies that src/services/scheduler.js registers the Inventory Exceptions
 * Daily cron at 09:15 Asia/Seoul WITHOUT touching the real cron scheduler,
 * the real inventory job, the real Supabase client, or any real notification
 * channel.
 *
 * Owner rules (Phase 8D):
 *   S1  '15 9 * * *' registered
 *   S2  timezone='Asia/Seoul'
 *   S3  callback invokes runInventoryExceptionsDaily({commit:true,concurrency:4})
 *   S4  unexpected throw inside callback does not kill scheduler
 *   S5  start() twice → no duplicate registration
 *   S6  requiring the scheduler module does NOT execute the job
 *   S7  existing cron schedules preserved (09:00 digest + ops briefing + kill
 *       pricing, 09:05 B2B reminder, 17:00 evening summary, etc.)
 *   S8  scheduler adds zero inventory/marketplace/purchase/hold writes
 *   S9  BP WATCH · priority 170 regression preserved (via full regression)
 *   S10 full regression green (run separately by CI / owner)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SCHEDULER_PATH = path.resolve(__dirname, '../../src/services/scheduler.js');
const JOB_PATH = path.resolve(__dirname, '../../src/jobs/inventoryExceptionsDailyJob.js');
const CRON_PATH = require.resolve('node-cron');

// ─── Test harness: fake node-cron + fake job ────────────

function installFakeCron() {
  const registrations = [];
  const fake = {
    schedule(expression, callback, options) {
      const entry = {
        expression,
        callback,
        options: options || {},
        stop() { entry.stopped = true; },
        stopped: false,
      };
      registrations.push(entry);
      return entry;
    },
    _registrations: registrations,
  };
  require.cache[CRON_PATH] = { id: CRON_PATH, filename: CRON_PATH, loaded: true, exports: fake };
  return fake;
}

function installFakeJob() {
  const calls = [];
  const fake = {
    runInventoryExceptionsDaily: async (opts) => {
      calls.push(opts);
      return { run_status: 'succeeded', alert_plan: { alert_kind: 'no_change' } };
    },
    _calls: calls,
  };
  require.cache[JOB_PATH] = { id: JOB_PATH, filename: JOB_PATH, loaded: true, exports: fake };
  return fake;
}

function freshRequire(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}

function resetAll() {
  delete require.cache[CRON_PATH];
  delete require.cache[JOB_PATH];
  delete require.cache[require.resolve(SCHEDULER_PATH)];
}

// ─── Tests ──────────────────────────────────────────────

test('S6. requiring scheduler module does NOT execute the inventory job', () => {
  resetAll();
  const cron = installFakeCron();
  const job = installFakeJob();
  // load module — must not schedule anything
  require(SCHEDULER_PATH);
  assert.equal(cron._registrations.length, 0, 'no cron.schedule calls on module load');
  assert.equal(job._calls.length, 0, 'inventory job never called on module load');
});

test('S1 + S2. start() registers "15 9 * * *" with timezone Asia/Seoul', () => {
  resetAll();
  const cron = installFakeCron();
  installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const inv = cron._registrations.find(r => r.expression === '15 9 * * *');
  assert.ok(inv, `expected a cron registration with '15 9 * * *' — got: ${cron._registrations.map(r => r.expression).join(', ')}`);
  assert.equal(inv.options.timezone, 'Asia/Seoul');
});

test('S3. callback invokes runInventoryExceptionsDaily({commit:true, concurrency:4}) exactly once per fire', async () => {
  resetAll();
  const cron = installFakeCron();
  const job = installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const inv = cron._registrations.find(r => r.expression === '15 9 * * *');
  assert.ok(inv);
  // Fire the callback as if cron woke it up
  await inv.callback();
  assert.equal(job._calls.length, 1);
  assert.deepEqual(job._calls[0], { commit: true, concurrency: 4 });
});

test('S3b. multiple fires each call the job exactly once (no accidental accumulation/dedup in scheduler)', async () => {
  resetAll();
  const cron = installFakeCron();
  const job = installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const inv = cron._registrations.find(r => r.expression === '15 9 * * *');
  await inv.callback();
  await inv.callback();
  await inv.callback();
  assert.equal(job._calls.length, 3);
  for (const c of job._calls) {
    assert.deepEqual(c, { commit: true, concurrency: 4 });
  }
});

test('S4. unexpected throw inside callback does NOT propagate (scheduler survives)', async () => {
  resetAll();
  const cron = installFakeCron();
  // Fake job that throws
  require.cache[JOB_PATH] = {
    id: JOB_PATH, filename: JOB_PATH, loaded: true,
    exports: {
      runInventoryExceptionsDaily: async () => { throw new Error('boom'); },
    },
  };
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const inv = cron._registrations.find(r => r.expression === '15 9 * * *');
  // Suppress the intended error log
  const origError = console.error;
  const errs = [];
  console.error = (...args) => { errs.push(args.join(' ')); };
  try {
    await assert.doesNotReject(() => inv.callback(), 'callback must swallow errors');
  } finally {
    console.error = origError;
  }
  assert.ok(errs.some(l => /InventoryExceptionsDaily error/.test(l) && /boom/.test(l)), 'error surfaced via console.error');
});

test('S5. start() called twice does NOT re-register the inventory cron', () => {
  resetAll();
  const cron = installFakeCron();
  installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  const origLog = console.log;
  console.log = () => {};
  try {
    scheduler.start();
    const firstCount = cron._registrations.filter(r => r.expression === '15 9 * * *').length;
    scheduler.start();
    const secondCount = cron._registrations.filter(r => r.expression === '15 9 * * *').length;
    assert.equal(firstCount, 1);
    assert.equal(secondCount, 1, 'second start() must not add another 15 9 * * * entry');
  } finally {
    console.log = origLog;
  }
});

test('S7. existing cron schedules are preserved (09:00 digest, 09:05 b2b, 17:00 summary, 04:00 platform sync)', () => {
  resetAll();
  const cron = installFakeCron();
  installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const expressions = cron._registrations.map(r => r.expression);
  // Sanity: the sentinel expressions must be present (proves no cron was accidentally removed)
  assert.ok(expressions.includes('0 9 * * *'), '09:00 daily digest / ops briefing / kill pricing preserved');
  assert.ok(expressions.includes('5 9 * * *'), '09:05 B2B reminder preserved');
  assert.ok(expressions.includes('0 17 * * *'), '17:00 evening summary preserved');
  assert.ok(expressions.includes('0 4 * * *'), '04:00 platform sync preserved');
  assert.ok(expressions.includes('15 9 * * *'), '09:15 inventory exceptions added');
  // 09:00 slot must remain a multi-registration (digest + ops briefing + kill pricing)
  const nineCount = expressions.filter(e => e === '0 9 * * *').length;
  assert.ok(nineCount >= 3, `09:00 slot should have 3+ registrations, got ${nineCount}`);
});

test('S7b. Inventory Exceptions cron is REGISTERED AFTER the existing 09:05 B2B slot (safe insertion point)', () => {
  resetAll();
  const cron = installFakeCron();
  installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const expressions = cron._registrations.map(r => r.expression);
  const idxB2b = expressions.indexOf('5 9 * * *');
  const idxInv = expressions.indexOf('15 9 * * *');
  assert.ok(idxB2b >= 0 && idxInv >= 0);
  assert.ok(idxInv > idxB2b, 'inventory cron registered after b2b — signals safe insertion, not replacement');
});

test('S8. scheduler does NOT synchronously call any inventory / marketplace / purchase / hold API on start()', () => {
  resetAll();
  const cron = installFakeCron();
  const job = installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  // job must not fire until cron does
  assert.equal(job._calls.length, 0, 'start() alone must not invoke the inventory job');
  // Sanity: no side effect on the fake job counter
});

test('S8b. Only cron.schedule is used for the 09:15 slot (no direct notify/telegram/imessage/db calls in the registration)', () => {
  // Static-string check on the scheduler source for the 09:15 block. Ensures
  // scheduler never bypasses the audited job path.
  const src = require('fs').readFileSync(SCHEDULER_PATH, 'utf8');
  const startTok = "cron.schedule('15 9 * * *'";
  const startIdx = src.indexOf(startTok);
  assert.ok(startIdx >= 0, 'could not find 09:15 registration');
  const endIdx = src.indexOf('}, { timezone: TZ });', startIdx);
  assert.ok(endIdx > startIdx, 'could not find end of 09:15 block');
  const block = src.slice(startIdx, endIdx);
  // The block must NOT reach past the audited orchestrator
  assert.doesNotMatch(block, /telegram|imessage|sendPlain|sendAlert|sendMessage/i, '09:15 block must not call notification services directly');
  assert.doesNotMatch(block, /supabase|getClient\(|from\(\s*'/i, '09:15 block must not touch the DB directly');
  assert.doesNotMatch(block, /updateItem|ReviseItem|updatePrice|marketplace/i, '09:15 block must not call marketplace APIs');
  assert.doesNotMatch(block, /physical_products|inventory_movements|purchase_requests|strategic_hold/i, '09:15 block must not touch business tables');
  // MUST reach the audited orchestrator entry point
  assert.match(block, /runInventoryExceptionsDaily/);
});

test('S3-args. callback passes {commit: true, concurrency: 4} verbatim — no extra opts that could change semantics', async () => {
  resetAll();
  const cron = installFakeCron();
  const job = installFakeJob();
  const scheduler = freshRequire(SCHEDULER_PATH);
  scheduler.start();
  const inv = cron._registrations.find(r => r.expression === '15 9 * * *');
  await inv.callback();
  assert.equal(job._calls.length, 1);
  const opts = job._calls[0];
  // Exactly the two owner-mandated keys, nothing more
  assert.deepEqual(Object.keys(opts).sort(), ['commit', 'concurrency']);
  assert.equal(opts.commit, true);
  assert.equal(opts.concurrency, 4);
});

// Cleanup so other tests that require node-cron / scheduler see clean state
test.after(() => { resetAll(); });
