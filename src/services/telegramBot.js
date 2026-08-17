/**
 * Telegram Bot — Push notifications for agent alerts & reports
 *
 * P0 INCIDENT RESPONSE (2026-08-17):
 *   Every send in this file now routes through `telegramGateway.guardedSend()`.
 *   That gateway enforces:
 *     · env kill switch (TELEGRAM_KILL_SWITCH / DISABLE_TELEGRAM_SEND)
 *     · dev-mode block (NODE_ENV != 'production' unless ALLOW_TELEGRAM_IN_DEV)
 *     · TELEGRAM_DRY_RUN
 *     · per-run hard cap (default 5 / 5-min window per jobName)
 *     · per-hour hard cap (default 10 / rolling hour per (jobName, chatShort))
 *     · idempotency (identical text within 15 min → suppressed)
 *
 *   DO NOT bypass — callers must use one of the functions exported here.
 *   Direct `fetch('https://api.telegram.org/...')` from other modules is
 *   forbidden.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const gateway = require('./telegramGateway');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function isConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * Opaque, non-secret handle identifying the destination chat.
 * NEVER exposes the real chat_id. Used only as a bucketing key for
 * per-(job, chat) rate limits.
 */
function _chatShort() {
  if (!CHAT_ID) return 'no_chat';
  return String(CHAT_ID).slice(-4) + ':' + String(CHAT_ID).length;
}

/**
 * Raw Telegram sendMessage transport. Never called directly — always routed
 * through gateway.guardedSend().
 */
async function _rawSendMessage(text, options = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text: String(text || '').substring(0, 4096),
    disable_web_page_preview: true,
  };
  const pm = options.parseMode !== undefined ? options.parseMode : 'Markdown';
  if (pm) body.parse_mode = pm;
  if (options.reply_markup) body.reply_markup = options.reply_markup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('[Telegram] Send failed:', data.description);
    return { ok: false, error: `bot_api_${data.error_code || 'unknown'}`, description: String(data.description || 'unknown_error') };
  }
  return { ok: true, error: null, description: null, result: data.result };
}

/**
 * Send a text message to the configured Telegram chat.
 * @param {string} text
 * @param {Object} [options]
 * @param {string|null} [options.parseMode='Markdown']
 * @param {string} [options.jobName='unknown']   caller-supplied job identity (rate-limit bucket)
 */
async function sendMessage(text, options = {}) {
  if (!isConfigured()) {
    console.log('[Telegram] Not configured — skipping message');
    return null;
  }
  const jobName = options.jobName || 'unknown';
  const guarded = await gateway.guardedSend({
    text, jobName, chatIdShort: _chatShort(),
    rawSendFn: () => _rawSendMessage(text, options),
  });
  if (guarded.suppressed) {
    console.log(`[Telegram] suppressed (${guarded.reason}) · job=${jobName}`);
    return null;
  }
  return guarded.transport?.result || null;
}

/**
 * Plain-text send with structured delivery result. Never uses parse_mode →
 * immune to Markdown/HTML entity errors. Returns { ok, error, description }.
 * NEVER exposes token / chat_id.
 * @param {string} text
 * @param {Object} [opts]
 * @param {string} [opts.jobName='unknown']
 */
async function sendPlain(text, opts = {}) {
  if (!isConfigured()) return { ok: false, error: 'not_configured', description: null };
  const jobName = opts.jobName || 'unknown';
  const guarded = await gateway.guardedSend({
    text, jobName, chatIdShort: _chatShort(),
    rawSendFn: () => _rawSendMessage(text, { parseMode: null }),
  });
  if (guarded.suppressed) {
    return { ok: false, error: `suppressed_${guarded.reason}`, description: null, suppressed: true };
  }
  return guarded.transport || { ok: false, error: 'unknown_transport_state', description: null };
}

/**
 * Send a critical alert.
 */
async function sendAlert(title, message, data = {}) {
  const text = [
    `🚨 *${title}*`,
    '',
    message,
    data.sku ? `SKU: \`${data.sku}\`` : '',
    data.margin != null ? `마진: ${data.margin}%` : '',
    data.price ? `가격: $${data.price}` : '',
  ].filter(Boolean).join('\n');
  return sendMessage(text, { jobName: 'sendAlert' });
}

async function sendProfitReport(report) {
  if (!report || !report.summary) return null;
  const s = report.summary;
  const lines = [
    `📊 *Profit Brain 리포트*`,
    `${new Date().toLocaleDateString('ko-KR')}`,
    '',
    `분석 상품: ${s.totalProducts}개`,
    `평균 마진: ${s.avgMargin}%`,
    `⭐ 스타: ${s.starCount}개 | ⚠️ 경고: ${s.warningCount}건 | 🔴 위험: ${s.dangerCount}건`,
  ];
  if (report.alerts.length > 0) {
    lines.push('', '*즉시 조치 필요:*');
    report.alerts.slice(0, 5).forEach(a => {
      lines.push(`• \`${a.sku}\` — 마진 ${a.margin}%, $${a.currentPrice}`);
    });
  }
  if (report.recommendations.length > 0) {
    lines.push('', '*권장사항:*');
    report.recommendations.slice(0, 5).forEach(r => {
      lines.push(`• \`${r.sku}\` — ${r.message.substring(0, 60)}`);
    });
  }
  return sendMessage(lines.join('\n'), { jobName: 'sendProfitReport' });
}

async function sendMorningBriefing(briefing) {
  if (!briefing) return null;
  const lines = [
    `☀️ *PMC 아침 브리핑*`,
    `${briefing.date}`,
    '',
    `💰 *매출* (7일): $${briefing.revenue?.last7days || 0} (${briefing.revenue?.orderCount || 0}건)`,
    `📦 *상품*: ${briefing.products?.total || 0}개 (재고 ${briefing.products?.active || 0} / 품절 ${briefing.products?.outOfStock || 0})`,
    `📈 *평균 마진*: ${briefing.products?.avgMargin || 0}%`,
    '',
    `🤖 *에이전트*: 대기 ${briefing.agentTeam?.totalPending || 0}건 | 알림 ${briefing.agentTeam?.unreadAlerts || 0}건`,
  ];
  const ai = briefing.actionItems;
  if (ai && (ai.critical > 0 || ai.high > 0)) {
    lines.push('', `🎯 *오늘 할 일*: 긴급 ${ai.critical}건 / 중요 ${ai.high}건`);
    (ai.topActions || []).slice(0, 5).forEach(a => lines.push(`  → ${a}`));
  }
  if (briefing.competitors?.alertsToday > 0) {
    lines.push('', `🔍 *경쟁사*: ${briefing.competitors.alertsToday}건 가격변동`);
  }
  return sendMessage(lines.join('\n'), { jobName: 'sendMorningBriefing' });
}

/**
 * 인라인 버튼 포함 메시지 전송 — routed through gateway.
 */
async function sendWithButtons(text, keyboard = [], options = {}) {
  if (!isConfigured()) return null;
  const jobName = options.jobName || 'sendWithButtons';
  const guarded = await gateway.guardedSend({
    text, jobName, chatIdShort: _chatShort(),
    rawSendFn: () => _rawSendMessage(text, { ...options, reply_markup: { inline_keyboard: keyboard } }),
  });
  if (guarded.suppressed) {
    console.log(`[Telegram] sendWithButtons suppressed (${guarded.reason}) · job=${jobName}`);
    return null;
  }
  return guarded.transport?.result || null;
}

/**
 * callback_query 응답 — 사용자가 이미 클릭한 상황에 대한 즉시 응답이므로
 * per-run 카운터에 포함되지만, 필수 응답이라 idempotency 검사는 완화.
 */
async function answerCallbackQuery(callbackQueryId, text = '') {
  if (!isConfigured()) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) }),
    });
  } catch (e) { console.error('[Telegram] answerCallbackQuery error:', e.message); }
}

/**
 * 메시지 텍스트 수정 — target chat is already-known Telegram message,
 * still routed through gateway for uniform kill-switch coverage.
 */
async function editMessage(chatId, messageId, text, keyboard = null) {
  if (!isConfigured()) return;
  const jobName = 'editMessage';
  const chatShort = String(chatId || 'chat').slice(-4) + ':editMsg:' + String(messageId);
  await gateway.guardedSend({
    text, jobName, chatIdShort: chatShort,
    rawSendFn: async () => {
      const body = {
        chat_id: chatId,
        message_id: messageId,
        text: text.substring(0, 4096),
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      };
      if (keyboard !== null) body.reply_markup = { inline_keyboard: keyboard };
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true };
    },
  }).catch(e => console.error('[Telegram] editMessage error:', e.message));
}

/**
 * Webhook 등록 — non-message API. NOT gated (no notification volume risk).
 * Left as direct fetch for infrastructure setup / debugging.
 */
async function setWebhook(webhookUrl) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['callback_query', 'message'] }),
    });
    const data = await res.json();
    console.log('[Telegram] setWebhook:', data.ok ? 'OK' : data.description);
    return data;
  } catch (e) {
    console.error('[Telegram] setWebhook error:', e.message);
    return null;
  }
}

async function getWebhookInfo() {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    return await res.json();
  } catch (e) { return null; }
}

module.exports = {
  sendMessage, sendAlert, sendProfitReport, sendMorningBriefing, isConfigured,
  sendWithButtons, answerCallbackQuery, editMessage, setWebhook, getWebhookInfo,
  sendPlain,   // 8C-1
  _rawSendMessage,   // test-only harness
};
