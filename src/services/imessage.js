/**
 * iMessage Push — Detailed agent reports via macOS Messages app
 *
 * Setup: IMESSAGE_TO=+82-10-xxxx-xxxx in config/.env
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const { execFile } = require('child_process');

const IMESSAGE_TO = process.env.IMESSAGE_TO;

function isConfigured() {
  return !!(IMESSAGE_TO && process.platform === 'darwin');
}

function sendMessage(text) {
  return new Promise((resolve) => {
    if (!isConfigured()) { console.log('[iMessage] Not configured'); return resolve(null); }
    const msg = text.substring(0, 3000);
    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${IMESSAGE_TO}" of targetService
        send "${msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}" to targetBuddy
      end tell
    `;
    execFile('osascript', ['-e', script], { timeout: 10000 }, (err) => {
      if (err) { console.error('[iMessage] Send failed:', err.message); resolve(null); }
      else { console.log('[iMessage] Sent to', IMESSAGE_TO); resolve(true); }
    });
  });
}

// ===== Detailed Reports =====

async function sendProfitReport(report) {
  if (!report?.summary) return null;
  const s = report.summary;
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `📊 PROFIT BRAIN 리포트`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📦 분석 상품: ${s.totalProducts.toLocaleString()}개`,
    `📈 평균 마진: ${s.avgMargin}%`,
    ``,
    `┌─ 상품 등급 ─────────┐`,
    `│ ⭐ 스타(40%+): ${String(s.starCount).padStart(5)}개 │`,
    `│ ✅ 정상:       ${String(s.totalProducts - s.starCount - s.warningCount - s.dangerCount).padStart(5)}개 │`,
    `│ ⚠️ 경고(<15%): ${String(s.warningCount).padStart(5)}건 │`,
    `│ 🔴 위험(<0%):  ${String(s.dangerCount).padStart(5)}건 │`,
    `└────────────────────┘`,
  ];

  if (report.alerts.length > 0) {
    lines.push('', '🚨 즉시 조치 필요:');
    report.alerts.slice(0, 5).forEach((a, i) => {
      lines.push(`${i + 1}. ${a.sku}`);
      lines.push(`   마진 ${a.margin}% | 현재 $${a.currentPrice} → 제안 $${a.targetPrice || '?'}`);
      lines.push(`   매출 ${a.salesCount}건 | ${a.category === 'danger_margin' ? '❗ 손실 발생 중' : '⚠️ 마진 부족'}`);
    });
  }

  if (report.recommendations.length > 0) {
    lines.push('', '💡 추천 가격 조정:');
    report.recommendations.slice(0, 5).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.sku} — ${r.message.substring(0, 80)}`);
    });
  }

  lines.push('', `🔗 대시보드에서 승인/실행하세요`);
  return sendMessage(lines.join('\n'));
}

async function sendMorningBriefing(briefing) {
  if (!briefing) return null;
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `☀️ PMC 아침 브리핑`,
    `${briefing.date}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 매출 (최근 7일)`,
    `   총 매출: $${(briefing.revenue?.last7days || 0).toLocaleString()}`,
    `   주문 수: ${briefing.revenue?.orderCount || 0}건`,
    `   TOP 플랫폼: ${briefing.revenue?.topPlatform || 'N/A'}`,
  ];

  if (briefing.revenue?.platformBreakdown) {
    const platforms = Object.entries(briefing.revenue.platformBreakdown)
      .sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (platforms.length > 0) {
      lines.push('');
      platforms.forEach(([p, count]) => {
        lines.push(`   ${p}: ${count}건`);
      });
    }
  }

  lines.push(
    ``,
    `📦 상품 현황`,
    `   총 상품: ${briefing.products?.total?.toLocaleString() || 0}개`,
    `   활성(재고): ${briefing.products?.active || 0}개`,
    `   품절: ${briefing.products?.outOfStock || 0}개`,
    `   평균 마진: ${briefing.products?.avgMargin || 0}%`,
  );

  lines.push(
    ``,
    `🤖 에이전트 팀 현황`,
    `   대기중 제안: ${briefing.agentTeam?.totalPending || 0}건`,
    `   미읽음 알림: ${briefing.agentTeam?.unreadAlerts || 0}건`,
    `   어제 실행: ${briefing.agentTeam?.executedYesterday || 0}건`,
  );

  // Agent last run times
  if (briefing.agentTeam?.status && Object.keys(briefing.agentTeam.status).length > 0) {
    lines.push('');
    for (const [name, info] of Object.entries(briefing.agentTeam.status)) {
      const time = new Date(info.lastRun).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      const icon = info.result === 'success' ? '✅' : '❌';
      lines.push(`   ${icon} ${name}: ${time}`);
    }
  }

  const ai = briefing.actionItems;
  if (ai && (ai.critical > 0 || ai.high > 0 || ai.medium > 0)) {
    lines.push(
      ``,
      `🎯 오늘 할 일`,
      `   🔴 긴급: ${ai.critical}건`,
      `   🟡 중요: ${ai.high}건`,
      `   🔵 보통: ${ai.medium}건`,
    );
    if (ai.topActions?.length > 0) {
      lines.push('');
      ai.topActions.slice(0, 5).forEach(a => lines.push(`   → ${a}`));
    }
  }

  if (briefing.competitors?.alertsToday > 0) {
    lines.push(
      ``,
      `🔍 경쟁사 동향`,
      `   가격 변동: ${briefing.competitors.alertsToday}건`,
    );
    if (briefing.competitors.highlights?.length > 0) {
      briefing.competitors.highlights.slice(0, 3).forEach(h => {
        lines.push(`   → ${h}`);
      });
    }
  }

  lines.push('', `━━━━━━━━━━━━━━━━━━━━`);
  return sendMessage(lines.join('\n'));
}

async function sendBattleReport(report) {
  // report = { losing, winning, competitive, suspicious, topLosing, topWinning }
  const losing = typeof report === 'number' ? report : (report.losing || 0);
  const winning = typeof report === 'number' ? arguments[1] : (report.winning || 0);
  const competitive = report.competitive || 0;
  const suspicious = report.suspicious || 0;

  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚔️ 경쟁사 가격 전투 리포트`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📊 전체 현황`,
    `   🔴 패배 (우리가 비쌈): ${losing}건`,
    `   🟢 승리 (인상 가능):   ${winning}건`,
    `   ⚖️ 경쟁적 (비슷):     ${competitive}건`,
    `   ⚠️ 의심 (폭락):       ${suspicious}건`,
  ];

  if (report.topLosing?.length > 0) {
    lines.push('', '🔴 가장 많이 지고 있는 상품:');
    report.topLosing.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title?.substring(0, 40) || item.sku}`);
      lines.push(`   우리 $${item.ourTotal} vs 경쟁 $${item.cheapestTotal} (${item.cheapestSeller})`);
      lines.push(`   → $${item.diff} 비쌈 | 매출 ${item.salesCount}건`);
    });
  }

  if (report.topWinning?.length > 0) {
    lines.push('', '🟢 가격 인상 기회:');
    report.topWinning.slice(0, 3).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title?.substring(0, 40) || item.sku}`);
      lines.push(`   우리 $${item.ourTotal} vs 경쟁 $${item.cheapestTotal}`);
      lines.push(`   → $${Math.abs(item.diff)} 여유 | 매출 ${item.salesCount}건`);
    });
  }

  if (report.suspicious?.length > 0) {
    lines.push('', '⚠️ 가격 폭락 의심:');
    report.suspicious.slice(0, 3).forEach(s => {
      lines.push(`   ${s.sku} (${s.seller}): $${s.oldPrice} → $${s.newPrice} (-${s.dropPct}%)`);
    });
  }

  lines.push('', `🔗 대시보드에서 상세 확인`);
  return sendMessage(lines.join('\n'));
}

async function sendOpsReport(data) {
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚙️ OPERATIONS 리포트`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📦 재고 현황`,
    `   품절 임박 (14일내): ${data.reorderCount || 0}건`,
    `   데드 스탁 (무판매): ${data.deadStockCount || 0}건`,
    ``,
    `🔑 키워드 분석`,
    `   추적 키워드: ${data.keywordCount || 0}개`,
  ];

  if (data.topKeywords?.length > 0) {
    lines.push('   TOP 키워드:');
    data.topKeywords.slice(0, 5).forEach(kw => {
      lines.push(`   → ${kw.keyword} (${kw.count}개 상품)`);
    });
  }

  if (data.reorderItems?.length > 0) {
    lines.push('', '🚨 긴급 재주문:');
    data.reorderItems.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title?.substring(0, 35) || item.sku}`);
      lines.push(`   재고 ${item.stock}개 | ${item.daysLeft}일 후 소진 | 일 판매 ${item.dailyRate}개`);
    });
  }

  lines.push(
    ``,
    `📋 직원 업무`,
    `   생성된 업무: ${data.taskCount || 0}건`,
    ``,
    `🔗 대시보드에서 상세 확인`,
  );
  return sendMessage(lines.join('\n'));
}

async function sendMarketingReport(data) {
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `📢 MARKETING 주간 리포트`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🏷️ 제목 최적화: ${data.titleCount || 0}건`,
    `📣 광고 추천: ${data.promoCount || 0}건`,
    `🌐 크로스플랫폼 갭: ${data.gapCount || 0}건`,
  ];

  if (data.categories?.length > 0) {
    lines.push('', '📊 카테고리별 성과:');
    data.categories.slice(0, 6).forEach(c => {
      lines.push(`   ${c.name}: ${c.productCount}개 상품, ${c.totalSales}건 판매, 평균 $${c.avgPrice}`);
    });
  }

  if (data.topTitleFixes?.length > 0) {
    lines.push('', '🏷️ 제목 최적화 예시:');
    data.topTitleFixes.slice(0, 3).forEach((fix, i) => {
      lines.push(`${i + 1}. Before: ${fix.before?.substring(0, 50)}`);
      lines.push(`   After:  ${fix.after?.substring(0, 50)}`);
    });
  }

  if (data.topPromos?.length > 0) {
    lines.push('', '📣 광고 추천:');
    data.topPromos.slice(0, 3).forEach((p, i) => {
      lines.push(`${i + 1}. ${p.title?.substring(0, 40)} — $${p.price}, 재고 ${p.stock}`);
    });
  }

  lines.push('', `🔗 대시보드에서 승인/실행`);
  return sendMessage(lines.join('\n'));
}

async function sendAlert(title, message, data = {}) {
  const lines = [
    `🚨 긴급 알림`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `${title}`,
    ``,
    message,
  ];
  if (data.sku) lines.push(``, `SKU: ${data.sku}`);
  if (data.margin != null) lines.push(`마진: ${data.margin}%`);
  if (data.price) lines.push(`가격: $${data.price}`);
  lines.push('', `🔗 대시보드에서 조치하세요`);
  return sendMessage(lines.join('\n'));
}

async function sendSalesReport(data) {
  const lines = [
    `━━━━━━━━━━━━━━━━━━━━`,
    `📈 SALES AGENT 리포트`,
    `━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🆕 신규 B2B 리드: ${data.newLeads || 0}건`,
    `📧 후속 필요: ${data.followUps || 0}건`,
    `😴 휴면 바이어: ${data.dormant || 0}건`,
    `💰 미결제 인보이스: ${data.unpaidInvoices || 0}건`,
  ];

  if (data.topLeads?.length > 0) {
    lines.push('', '🆕 유망 리드:');
    data.topLeads.slice(0, 3).forEach((lead, i) => {
      lines.push(`${i + 1}. ${lead.email}`);
      lines.push(`   ${lead.country || '?'} | ${lead.orderCount}건 주문 | $${Math.round(lead.totalSpent)} 구매 | 점수 ${lead.score}`);
    });
  }

  lines.push('', `📧 이메일 초안 ${data.emailDrafts || 0}건 준비됨`, `🔗 대시보드에서 승인 후 발송`);
  return sendMessage(lines.join('\n'));
}

module.exports = {
  sendMessage, sendAlert,
  sendProfitReport, sendMorningBriefing,
  sendBattleReport, sendOpsReport,
  sendMarketingReport, sendSalesReport,
  isConfigured,
};
