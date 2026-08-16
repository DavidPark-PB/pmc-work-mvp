#!/usr/bin/env node
/**
 * scripts/oms-inventory-exceptions-run.js — Phase 8C.
 *
 * Daily orchestrated run of the inventory exception queue.
 *   DEFAULT: dry-run (no audit write · no notification)
 *   --commit : persist automation_runs row + send Telegram alert if state changed
 *
 * Intended production trigger: an OS cron / node-cron entry in scheduler.js:
 *     cron.schedule('0 9 * * *', () =>
 *       runInventoryExceptionsDaily({ commit: true, concurrency: 4 }));
 *   (TZ Asia/Seoul · not enabled by this phase.)
 *
 * Usage:
 *   node scripts/oms-inventory-exceptions-run.js
 *   node scripts/oms-inventory-exceptions-run.js --commit
 *   node scripts/oms-inventory-exceptions-run.js --commit --alert-data-quality
 *   node scripts/oms-inventory-exceptions-run.js --json
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { runInventoryExceptionsDaily } = require('../src/jobs/inventoryExceptionsDailyJob');

function parseArgs(argv) {
  const out = { commit: false, alertDataQuality: false, alertResolved: false, concurrency: 4, limit: null, json: false, forceChannels: [] };
  const ALLOWED_CHANNELS = new Set(['imessage', 'telegram']);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') out.commit = true;
    else if (a === '--alert-data-quality') out.alertDataQuality = true;
    else if (a === '--alert-resolved') out.alertResolved = true;
    else if (a === '--concurrency') out.concurrency = Math.max(1, parseInt(argv[++i], 10) || 4);
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '--force-channel') {
      const raw = argv[++i] || '';
      const parts = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      for (const p of parts) {
        if (!ALLOWED_CHANNELS.has(p)) {
          console.error(`ERROR: --force-channel must be one of ${[...ALLOWED_CHANNELS].join('/')} (got '${p}')`);
          process.exit(2);
        }
        if (!out.forceChannels.includes(p)) out.forceChannels.push(p);
      }
    }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/oms-inventory-exceptions-run.js [--commit] [--alert-data-quality] [--alert-resolved] [--concurrency N] [--limit N] [--force-channel imessage|telegram[,...]] [--json]');
      console.log('  --force-channel   Owner-explicit one-shot: force delivery to listed channel(s) even if fingerprint dedup would suppress.');
      process.exit(0);
    }
  }
  return out;
}

function summarise(r, args) {
  const L = [''];
  L.push('══════════════ Inventory Exceptions Daily Run ══════════════');
  L.push(`  commit             : ${r.commit}   ${r.commit ? '' : '(dry-run · no audit · no notification)'}`);
  L.push(`  request_id         : ${r.request_id}`);
  L.push(`  started_at         : ${r.started_at}`);
  L.push(`  completed_at       : ${r.completed_at}`);
  if (r.queue_error) L.push(`  queue_error        : ${r.queue_error}`);
  L.push('');

  if (r.queue_result?.summary) {
    const s = r.queue_result.summary;
    L.push('  Queue summary:');
    L.push(`    physical_assessed : ${s.physical_products_assessed}   (runtime ${s.runtime_ms != null ? s.runtime_ms.toFixed(0) + ' ms' : 'n/a'} · concurrency=${s.concurrency})`);
    L.push(`    action_exception  : ${s.action_exception_count}   (watch=${s.watch_count} · replenish=${s.replenish_count} · protect_stock=${s.protect_stock_count})`);
    L.push(`    data_quality      : ${s.data_quality_count}`);
    L.push(`    db_cache          : hits=${s.db_cache_hits} misses=${s.db_cache_misses}`);
    L.push('');
  }

  const ap = r.alert_plan;
  L.push('  Alert plan:');
  L.push(`    should_alert       : ${ap.should_alert}`);
  L.push(`    alert_kind         : ${ap.alert_kind}`);
  L.push(`    fingerprint        : ${(ap.fingerprint || 'n/a').slice(0, 16)}…`);
  L.push(`    prior_fingerprint  : ${(ap.prior_fingerprint || 'none').slice(0, 16)}${ap.prior_fingerprint ? '…' : ''}`);
  L.push(`    new_physicals      : ${ap.new_physicals.length}   [${ap.new_physicals.map(x => `#${x.physical_product_id}(${x.decision_status})`).join(', ')}]`);
  L.push(`    escalated          : ${ap.escalated.length}   [${ap.escalated.map(x => `#${x.physical_product_id}:${x.prior_status}→${x.current_status}`).join(', ')}]`);
  L.push(`    resolved           : ${ap.resolved.length}   [${ap.resolved.map(x => `#${x.physical_product_id}`).join(', ')}]`);
  L.push(`    data_quality_new   : ${ap.data_quality_new.length}   [${ap.data_quality_new.join(', ')}]`);
  L.push(`    data_quality_resolv: ${ap.data_quality_resolved.length}`);
  L.push(`    reason_codes       : [${ap.reason_codes.join(', ')}]`);
  L.push('');

  const dp = r.delivery_plan || {};
  L.push('  Delivery plan (8C-2)');
  L.push(`    retry_kind         : ${dp.retry_kind || 'n/a'}`);
  L.push(`    configured         : [${(dp.configured_channels || []).join(', ')}]`);
  L.push(`    prior_satisfied    : [${(dp.satisfied_channels_prior || []).join(', ')}]`);
  L.push(`    unresolved         : [${(dp.unresolved_channels || []).join(', ')}]`);
  L.push(`    should_deliver_to  : [${(dp.should_deliver_to || []).join(', ')}]`);
  if (dp.force_channels_requested && dp.force_channels_requested.length > 0) {
    L.push(`    force_channels     : [${dp.force_channels_requested.join(', ')}]`);
  }
  if (dp.legacy_prior_note) L.push(`    legacy_prior_note  : ${dp.legacy_prior_note}`);
  L.push('');

  L.push('  Notification');
  if (r.notification?.skipped) L.push(`    skipped            : ${r.notification.reason}`);
  else if (r.notification?.attempted) {
    const chans = r.notification.channels || {};
    for (const [name, c] of Object.entries(chans)) {
      if (!c.attempted && !c.error) continue;
      const line = c.attempted
        ? (c.sent ? 'sent' : `FAILED (${c.error || 'unknown'}${c.description ? ' · ' + c.description : ''})`)
        : `skipped (${c.error || 'not attempted'})`;
      L.push(`    ${name.padEnd(19)}: ${line}`);
    }
    L.push(`    all_succeeded      : ${!!r.notification.all_succeeded}`);
    L.push(`    partial_failure    : ${!!r.notification.partial_failure}`);
    L.push(`    total_failure      : ${!!r.notification.total_failure}`);
  } else if (r.notification?.ok === true) L.push('    sent               : yes');
  else if (r.notification?.ok === false) L.push(`    error              : ${r.notification.error}`);
  L.push(`    confirmed_satisfied: [${(r.confirmed_satisfied_channels || []).join(', ')}]`);
  L.push(`    assumed_satisfied  : [${(r.assumed_satisfied_channels || []).join(', ')}]`);
  L.push(`    effective_satisfied: [${(r.effective_satisfied_channels || []).join(', ')}]`);
  L.push(`    unresolved_after   : [${(r.effective_unresolved_channels || []).join(', ')}]`);
  L.push(`    all_required_ok    : ${!!r.all_required_channels_satisfied}`);
  const pdf = r.permanent_delivery_failures || [];
  if (pdf.length > 0) {
    L.push('');
    L.push('  ⚠ PERMANENT DELIVERY FAILURE(S) DETECTED — Owner action required:');
    for (const f of pdf) {
      L.push(`     · [${f.channel}] ${f.error || 'error'} · ${f.description || ''}`);
      L.push(`        hint: ${f.hint}`);
    }
    L.push('     No configuration will be auto-changed. Fix TELEGRAM_CHAT_ID / IMESSAGE_TO manually.');
  }
  L.push('');

  L.push('  Digest (would be sent):');
  L.push(`    title  : ${ap.digest_title}`);
  for (const line of ap.digest_text.split('\n')) L.push(`    body   : ${line}`);
  L.push('');

  if (r.audit_row) L.push(`  Audit row id=${r.audit_row.id} status=${r.audit_row.status}`);
  else if (r.audit_error) L.push(`  Audit ERROR: ${r.audit_error}`);
  else if (!r.commit) L.push('  Audit             : skipped (dry-run)');
  L.push('');

  L.push('  Safety: no auto-purchase · no auto-hold · no marketplace mutation.');
  L.push('          Cron entry (production): src/services/scheduler.js — plug in when Owner opts in.');
  L.push('');
  return L.join('\n');
}

(async () => {
  const args = parseArgs(process.argv);
  const r = await runInventoryExceptionsDaily({
    commit: args.commit,
    concurrency: args.concurrency,
    limit: args.limit,
    alertDataQuality: args.alertDataQuality,
    alertResolved: args.alertResolved,
    forceChannels: args.forceChannels,
  });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else console.log(summarise(r, args));
  process.exit(r.queue_error ? 1 : 0);
})().catch((err) => {
  console.error('[oms-inventory-exceptions-run] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
