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

module.exports = { send, sendProfitReport, sendMorningBriefing, sendAlert, isConfigured };
