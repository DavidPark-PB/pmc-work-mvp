/**
 * Unified Notification — Routes alerts to configured channels
 * Priority: iMessage (if configured) → Telegram (if configured) → console only
 */
const telegram = require('./telegramBot');
const imessage = require('./imessage');

/**
 * Send via best available channel
 */
async function send(text) {
  if (imessage.isConfigured()) await imessage.sendMessage(text);
  if (telegram.isConfigured()) await telegram.sendMessage(text);
  if (!imessage.isConfigured() && !telegram.isConfigured()) {
    console.log('[Notify] No channel configured — message:', text.substring(0, 100));
  }
}

async function sendProfitReport(report) {
  if (imessage.isConfigured()) await imessage.sendProfitReport(report);
  if (telegram.isConfigured()) await telegram.sendProfitReport(report);
}

async function sendMorningBriefing(briefing) {
  if (imessage.isConfigured()) await imessage.sendMorningBriefing(briefing);
  if (telegram.isConfigured()) await telegram.sendMorningBriefing(briefing);
}

async function sendAlert(title, message, data) {
  if (imessage.isConfigured()) await imessage.sendAlert(title, message, data);
  if (telegram.isConfigured()) await telegram.sendAlert(title, message, data);
}

function isConfigured() {
  return imessage.isConfigured() || telegram.isConfigured();
}

/**
 * 8C-1 hotfix — plain-text multi-channel notification with explicit
 * per-channel delivery contract. Does NOT mutate legacy send/sendAlert
 * behavior (existing callers unaffected).
 *
 *   returns {
 *     attempted: bool,                        // any channel was configured
 *     channels: {
 *       imessage: { attempted, sent, error, description },
 *       telegram: { attempted, sent, error, description }
 *     },
 *     configured_channels: ['imessage'?, 'telegram'?],
 *     all_succeeded: bool,     // every ATTEMPTED channel sent successfully
 *     any_succeeded: bool,
 *     partial_failure: bool,   // >=1 attempted AND !all_succeeded AND any_succeeded
 *     total_failure: bool      // attempted AND !any_succeeded
 *   }
 *
 * Never logs / returns secrets (BOT_TOKEN / CHAT_ID / IMESSAGE_TO destination).
 */
async function sendPlainMultiChannel(title, body, opts = {}) {
  // 8C-2: opts.onlyChannels — attempt ONLY the listed channels (channel-aware
  // retry). Channels omitted from onlyChannels are marked attempted=false with
  // error='skipped_by_only_channels_filter' so the audit clearly distinguishes
  // "skipped because already delivered" from "attempted and failed".
  const { onlyChannels = null } = opts;
  const wantChannel = ch => !onlyChannels || onlyChannels.includes(ch);
  const text = title ? (String(title).trim() + '\n\n' + String(body || '').trim()).trim() : String(body || '').trim();
  const channels = {
    imessage: { attempted: false, sent: false, error: null, description: null },
    telegram: { attempted: false, sent: false, error: null, description: null },
  };
  const configured = [];
  if (imessage.isConfigured()) {
    configured.push('imessage');
    if (wantChannel('imessage')) {
      channels.imessage.attempted = true;
      const r = await imessage.sendPlain(text);
      channels.imessage.sent = !!r.ok;
      channels.imessage.error = r.error;
      channels.imessage.description = r.description;
    } else {
      channels.imessage.error = 'skipped_by_only_channels_filter';
    }
  }
  if (telegram.isConfigured()) {
    configured.push('telegram');
    if (wantChannel('telegram')) {
      channels.telegram.attempted = true;
      const r = await telegram.sendPlain(text);
      channels.telegram.sent = !!r.ok;
      channels.telegram.error = r.error;
      channels.telegram.description = r.description;
    } else {
      channels.telegram.error = 'skipped_by_only_channels_filter';
    }
  }
  const attemptedList = Object.values(channels).filter(c => c.attempted);
  const attempted = attemptedList.length > 0;
  const anySucceeded = attemptedList.some(c => c.sent);
  const allSucceeded = attempted && attemptedList.every(c => c.sent);
  return {
    attempted,
    channels,
    configured_channels: configured,
    only_channels_filter: onlyChannels,
    all_succeeded: allSucceeded,
    any_succeeded: anySucceeded,
    partial_failure: attempted && !allSucceeded && anySucceeded,
    total_failure: attempted && !anySucceeded,
  };
}

/**
 * 8C-2: report which channels have credentials configured RIGHT NOW.
 * Read-only. Never sends. Used by the delivery-plan layer to compute
 * satisfied/unresolved sets without triggering a send.
 */
function getConfiguredChannels() {
  const out = [];
  if (imessage.isConfigured()) out.push('imessage');
  if (telegram.isConfigured()) out.push('telegram');
  return out;
}

module.exports = {
  send, sendProfitReport, sendMorningBriefing, sendAlert, isConfigured,
  sendPlainMultiChannel,   // 8C-1
  getConfiguredChannels,   // 8C-2
};
