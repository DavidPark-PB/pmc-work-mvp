/**
 * Telegram Bot — Push notifications for agent alerts & reports
 *
 * Setup:
 * 1. Message @BotFather on Telegram → /newbot → get BOT_TOKEN
 * 2. Create a group chat, add the bot
 * 3. Get CHAT_ID: https://api.telegram.org/bot<TOKEN>/getUpdates (after sending a message in group)
 * 4. Set in config/.env:
 *    TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
 *    TELEGRAM_CHAT_ID=-100123456789
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function isConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * Send a text message to the configured Telegram chat
 * Supports Markdown formatting
 */
async function sendMessage(text, options = {}) {
  if (!isConfigured()) {
    console.log('[Telegram] Not configured — skipping message');
    return null;
  }

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text.substring(0, 4096), // Telegram limit
        parse_mode: options.parseMode || 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] Send failed:', data.description);
      return null;
    }
    return data.result;
  } catch (e) {
    console.error('[Telegram] Error:', e.message);
    return null;
  }
}

/**
 * Send a critical alert
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

  return sendMessage(text);
}

/**
 * Send Profit Brain report
 */
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

  return sendMessage(lines.join('\n'));
}

/**
 * Send morning briefing from Strategy Agent
 */
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

  return sendMessage(lines.join('\n'));
}

module.exports = { sendMessage, sendAlert, sendProfitReport, sendMorningBriefing, isConfigured };
