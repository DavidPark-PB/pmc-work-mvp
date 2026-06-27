'use strict';

/**
 * Repricing Pipeline Job
 *
 * 4단계 파이프라인:
 *   1. Monitor   — 경쟁사 가격/재고/상태 변화 감지 (eBay Browse API)
 *   2. Analyze   — 마진/플로어 계산 → "따라가도 되는 가격" 판단
 *   3. Propose   — SKU별 추천가 + 행동(raise/drop/hold) 결정
 *   4. Report    — 텔레그램 리포트 + (선택) 자동 적용
 *
 * server.js에서 CompetitorMonitor가 2시간마다 독립 실행중 (가격 감지 + DB 저장).
 * 이 파이프라인은 6시간마다 실행되어 DB의 최근 alerts를 읽어 분석·제안·리포트.
 * → Monitor를 중복 호출하지 않음.
 *
 * 모드:
 *   dryRun=true  (기본) — 실제 eBay 가격 변경 없음, 리포트만
 *   dryRun=false        — 안전장치 통과 후 eBay API 실제 변경
 */

const { runCompetitorMonitor } = require('../services/competitorMonitor');
const { runAutoRepricer } = require('../services/autoRepricer');
const telegram = require('../services/telegramBot');
const { getClient } = require('../db/supabaseClient');
const { calculatePrices } = require('../services/pricingEngine');
const PlatformRepository = require('../db/platformRepository');

// --- 설정 ---
const CONFIG = {
  // true = 실제 eBay 가격 변경 없음 (안전 모드)
  // false = 자동 적용 (충분히 검증 후 전환)
  DRY_RUN: true,

  // true = 경쟁사 인상 시 자동 따라올리기만 허용 (인하는 항상 리포트만)
  // false = 모든 변경 리포트만
  AUTO_APPLY_RAISE_ONLY: false,

  // 마진 플로어 (이 이하로는 절대 내리지 않음)
  MIN_MARGIN_PCT: 15,

  // 리포트에 표시할 최대 SKU 수
  REPORT_TOP_N: 10,
};

/**
 * Step 1 (DB 기반): 최근 N시간 competitor_alerts 조회
 * CompetitorMonitor가 2h마다 이미 감지·저장하므로 여기서는 DB만 읽음.
 */
async function loadRecentAlerts(hoursBack = 6) {
  const db = getClient();
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  let { data, error } = await db
    .from('competitor_alerts')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[RepricingPipeline] competitor_alerts 조회 오류 (fallback: monitor 직접 실행):', error.message);
    // 테이블이 없으면 monitor 직접 실행
    const result = await runCompetitorMonitor();
    return result.alerts || [];
  }

  // DB rows → alert 객체로 변환
  return (data || []).map(row => {
    let parsed = {};
    try { parsed = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); } catch {}
    return {
      type: row.type,
      sku: row.sku,
      seller: row.seller_id,
      competitorId: row.competitor_id,
      message: row.message,
      oldPrice: parsed.oldPrice || 0,
      newPrice: parsed.newPrice || 0,
      changePct: parsed.changePct || '0',
      ...parsed,
    };
  });
}

/**
 * Step 2+3: 경쟁사 알림 리스트를 받아 마진 계산 후 행동 결정
 * @param {Array} alerts - competitorMonitor가 반환한 alerts
 * @returns {Array} proposals - { sku, action, reason, oldPrice, newPrice, compPrice, margin, safe }
 */
async function analyzeAndPropose(alerts) {
  if (!alerts || alerts.length === 0) return [];

  const db = getClient();
  const repo = new PlatformRepository();
  const proposals = [];

  // price_change / raise_opportunity / price_crash 알림만 처리 (ended는 별도)
  const priceAlerts = alerts.filter(a =>
    ['price_change', 'raise_opportunity', 'price_crash', 'competitor_undercut'].includes(a.type)
  );

  if (priceAlerts.length === 0) return [];

  // SKU 목록 추출
  const skus = [...new Set(priceAlerts.map(a => a.sku).filter(Boolean))];
  if (skus.length === 0) return [];

  // 내 상품 정보 + 비용 구조 로드
  const { data: products } = await db
    .from('products')
    .select('sku, title, title_ko, cost_price, purchase, weight, target_margin, shipping_usd')
    .in('sku', skus);

  const productMap = {};
  (products || []).forEach(p => { productMap[p.sku] = p; });

  // 현재 eBay 판매가 로드
  const { data: ebayProducts } = await db
    .from('ebay_products')
    .select('sku, item_id, price_usd, shipping_usd, status')
    .in('sku', skus)
    .neq('status', 'ended');

  const ebayMap = {};
  (ebayProducts || []).forEach(p => { ebayMap[p.sku] = p; });

  // SKU별 규칙 사전 로드 (DB 왕복 최소화)
  const ruleMap = {};
  try {
    for (const sku of skus) {
      ruleMap[sku] = await repo.getEffectiveRule(sku, 'ebay');
    }
  } catch (e) {
    // repricing_rules에 신규 컬럼이 없으면 (마이그레이션 미적용) 무시
    console.warn('[Pipeline] repricing_rules 규칙 로드 실패 (마이그레이션 확인):', e.message);
  }

  for (const alert of priceAlerts) {
    const sku = alert.sku;
    const product = productMap[sku];
    const ebay = ebayMap[sku];

    if (!product || !ebay) continue;

    const purchasePrice = parseFloat(product.cost_price || product.purchase) || 0;
    if (purchasePrice <= 0) continue;

    const myPrice = parseFloat(ebay.price_usd) || 0;
    const myShipping = parseFloat(ebay.shipping_usd) || 3.90;
    const myTotal = myPrice + myShipping;

    const compPrice = parseFloat(alert.newPrice) || 0;
    const compTotal = compPrice;

    // === 규칙 적용 ===
    const rule = ruleMap[sku] || null;
    const actionType = rule?.action_type || 'reprice';

    // skip: 파이프라인 완전 제외
    if (actionType === 'skip') {
      console.log(`[Pipeline] SKU ${sku} — 규칙: skip (파이프라인 제외)`);
      continue;
    }

    // blacklist 셀러 필터링
    const blacklist = rule?.competitor_blacklist || [];
    if (blacklist.length > 0 && alert.seller && blacklist.includes(alert.seller)) {
      console.log(`[Pipeline] SKU ${sku} — 셀러 ${alert.seller} blacklist 제외`);
      continue;
    }

    // whitelist 셀러 필터링 (있으면 해당 셀러만 기준)
    const whitelist = rule?.competitor_whitelist || [];
    if (whitelist.length > 0 && alert.seller && !whitelist.includes(alert.seller)) {
      console.log(`[Pipeline] SKU ${sku} — 셀러 ${alert.seller} whitelist 외 제외`);
      continue;
    }

    // price_premium: 경쟁사보다 N달러 비싸도 허용
    const pricePremium = parseFloat(rule?.price_premium) || 0;

    // 마진 계산
    const prices = calculatePrices({
      purchasePrice,
      weight: parseFloat(product.weight) || 0,
      targetMargin: parseFloat(product.target_margin) || 30,
      shippingUSD: parseFloat(product.shipping_usd) || undefined,
    });

    const ebayCalc = prices.ebay || {};
    const targetPrice = ebayCalc.price || 0;
    const currentMargin = ebayCalc.margin || 0;
    const maxDropPct = parseFloat(rule?.max_drop_pct) || CONFIG.MIN_MARGIN_PCT;
    const maxRaisePct = parseFloat(rule?.max_raise_pct) || 30;

    let action = 'hold';
    let safeToFollow = false;
    let proposedPrice = myPrice;
    let reason = '';

    if (alert.type === 'raise_opportunity') {
      // hold: 올리기 금지
      if (actionType === 'hold' || actionType === 'drop_only') {
        action = 'hold';
        reason = `규칙(${actionType}): 가격 인상 금지. 유지.`;
      } else {
        // 경쟁사 인상 → 우리도 올릴 기회
        const raiseTarget = Math.min(
          compTotal - 0.01 + pricePremium,
          targetPrice,
          myPrice * (1 + maxRaisePct / 100)
        );
        if (raiseTarget > myPrice) {
          action = 'raise';
          proposedPrice = +raiseTarget.toFixed(2);
          safeToFollow = true;
          reason = `경쟁사 ${alert.seller} 인상 +${alert.changePct}% ($${alert.oldPrice}→$${alert.newPrice}). 따라올리기 $${myPrice}→$${proposedPrice} 가능.`;
          if (rule?.notes) reason += ` [규칙: ${rule.notes}]`;
        } else {
          action = 'hold';
          reason = `경쟁사 인상이나 우리가 이미 더 비싸거나 목표가 초과 — 유지.`;
        }
      }
    } else if (alert.type === 'price_crash') {
      // 50%+ 급락 — 위험, 항상 hold
      action = 'hold';
      safeToFollow = false;
      reason = `⚠️ 경쟁사 ${alert.seller} 가격 급락 ${alert.changePct}% — 비정상 가격 의심. 유지 권장.`;
    } else if (alert.type === 'price_change' && alert.newPrice < alert.oldPrice) {
      // 경쟁사 가격 인하 → 우리가 지금 비싼지 확인
      if (actionType === 'hold' || actionType === 'raise_only') {
        action = 'hold';
        reason = `규칙(${actionType}): 가격 인하 금지. 유지.`;
      } else if (myTotal > compTotal + pricePremium + 0.5) {
        // 따라가도 마진이 충분한지 확인
        const dropPrice = Math.max(
          compTotal - 0.01 + pricePremium - myShipping,
          targetPrice * 0.80  // 목표마진의 80% 플로어
        );
        const dropPct = myPrice > 0 ? (myPrice - dropPrice) / myPrice * 100 : 0;
        const maxDrop = maxDropPct || 20;

        if (dropPct <= maxDrop && dropPrice > 0) {
          action = 'drop';
          proposedPrice = +dropPrice.toFixed(2);
          safeToFollow = true;
          reason = `경쟁사 ${alert.seller} 인하 -${alert.changePct}% ($${alert.oldPrice}→$${alert.newPrice}). 가격 조정 $${myPrice}→$${proposedPrice}.`;
          if (pricePremium > 0) reason += ` [프리미엄 $${pricePremium} 적용]`;
          if (rule?.notes) reason += ` [규칙: ${rule.notes}]`;
        } else {
          action = 'hold';
          reason = `경쟁사 ${alert.seller} 인하. 마진 플로어 또는 최대인하율 초과 — 유지. (마진 ${currentMargin.toFixed(0)}%, 인하율 ${dropPct.toFixed(0)}%)`;
        }
      } else {
        action = 'hold';
        reason = `경쟁사 인하. 우리 가격이 이미 경쟁력 있음 (프리미엄 $${pricePremium} 허용 범위) — 유지.`;
      }
    }

    proposals.push({
      sku,
      title: product.title_ko || product.title || sku,
      itemId: ebay.item_id,
      seller: alert.seller,
      action,
      reason,
      myPrice,
      myTotal,
      compPrice: alert.newPrice,
      oldCompPrice: alert.oldPrice,
      changePct: alert.changePct,
      proposedPrice,
      currentMargin: +currentMargin.toFixed(1),
      safe: safeToFollow,
      alertType: alert.type,
    });
  }

  return proposals;
}

/**
 * Step 4a: 텔레그램 리포트 생성 (인라인 버튼 포함)
 * - raise/drop proposal 각각에 ✅승인 ❌거부 버튼
 * - 5개 초과 시 "전체 승인" 버튼 추가
 */
async function sendTelegramReport({ monitorResult, proposals, repricerReport, dryRun }) {
  if (!telegram.isConfigured()) return;

  const { alerts = [], checked = 0 } = monitorResult;
  const raises = proposals.filter(p => p.action === 'raise');
  const drops = proposals.filter(p => p.action === 'drop');
  const holds = proposals.filter(p => p.action === 'hold');
  const endedAlerts = alerts.filter(a => a.type === 'ended');

  // === 요약 메시지 (버튼 없음) ===
  const summaryLines = [
    `⚔️ *경쟁사 가격 모니터 ${dryRun ? '[시뮬레이션]' : '[실적용]'}*`,
    `${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
    '',
    `📡 체크: ${checked}개 | 변동: ${alerts.length}건`,
  ];

  if (alerts.length > 0) {
    const crashCount = alerts.filter(a => a.type === 'price_crash').length;
    const raiseOppCount = alerts.filter(a => a.type === 'raise_opportunity').length;
    const changeCount = alerts.filter(a => a.type === 'price_change').length;
    summaryLines.push('');
    summaryLines.push('*[감지]*');
    if (crashCount > 0) summaryLines.push(`🔴 급락(의심): ${crashCount}건`);
    if (raiseOppCount > 0) summaryLines.push(`🟢 경쟁사 인상: ${raiseOppCount}건`);
    if (changeCount > 0) summaryLines.push(`🟡 가격 변동: ${changeCount}건`);
    if (endedAlerts.length > 0) summaryLines.push(`⚫ 리스팅 종료: ${endedAlerts.length}건`);
  }

  if (proposals.length > 0) {
    summaryLines.push('');
    summaryLines.push('*[분석 결과]*');
    if (raises.length > 0) summaryLines.push(`📈 인상 가능: ${raises.length}건`);
    if (drops.length > 0) summaryLines.push(`📉 조정 가능: ${drops.length}건`);
    if (holds.length > 0) summaryLines.push(`🔒 유지: ${holds.length}건`);
  }

  // 자동 적용 결과 (live 모드)
  if (repricerReport && !dryRun) {
    summaryLines.push('');
    summaryLines.push('*[자동 적용 결과]*');
    summaryLines.push(`✅ 적용: ${repricerReport.changed}건 | 스킵: ${repricerReport.skipped?.length || 0}건 | 오류: ${repricerReport.errors?.length || 0}건`);
  }

  summaryLines.push('');
  summaryLines.push(dryRun ? '_[시뮬레이션 — 버튼으로 개별 승인]_' : '_[가격 변경 적용 완료]_');

  await telegram.sendMessage(summaryLines.join('\n'));

  // dryRun=true일 때만 승인 버튼 발송 (실적용 모드는 이미 변경됨)
  if (!dryRun) return;

  // === proposal별 인라인 버튼 메시지 ===
  const actionProposals = [...raises, ...drops].slice(0, CONFIG.REPORT_TOP_N);

  for (const p of actionProposals) {
    const icon = p.action === 'raise' ? '📈' : '📉';
    const actionLabel = p.action === 'raise' ? '인상' : '인하';
    const itemId = p.itemId || 'null';

    const skuShort = (p.sku || '').slice(0, 20);
    const priceStr = String(p.proposedPrice);

    // Markdown 특수문자 없이 plain text로 구성 (parse_mode 없음)
    const text = [
      `${icon} ${actionLabel} 제안`,
      `SKU: ${p.sku}`,
      `현재: $${p.myPrice} → 제안: $${p.proposedPrice}`,
      `경쟁사: $${p.compPrice} (${p.seller || '-'})`,
      `사유: ${p.reason.slice(0, 120)}`,
    ].join('\n');

    const approveData = `reprice:approve:${skuShort}:${itemId}:${priceStr}`;
    const rejectData = `reprice:reject:${skuShort}`;

    if (approveData.length <= 64) {
      await telegram.sendWithButtons(text, [[
        { text: '✅ 승인 (가격 변경)', callback_data: approveData },
        { text: '❌ 거부', callback_data: rejectData },
      ]], { parseMode: null });
    } else {
      await telegram.sendMessage(text + '\n\n⚠️ SKU가 너무 길어 버튼 없음. 수동으로 처리하세요.');
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // 급락 경고
  const crashes = proposals.filter(p => p.alertType === 'price_crash');
  if (crashes.length > 0) {
    const crashLines = ['*⚠️ 비정상 가격 급락 (무시 권장)*'];
    crashes.slice(0, 5).forEach(p => {
      crashLines.push(`• \`${p.sku}\` ${p.seller}: $${p.oldCompPrice}→$${p.compPrice} (-${p.changePct}%)`);
    });
    await telegram.sendMessage(crashLines.join('\n'));
  }
}


/**
 * 메인 파이프라인 실행
 * @param {object} opts
 * @param {boolean} opts.dryRun - true=시뮬레이션, false=실적용 (기본: CONFIG.DRY_RUN)
 * @param {boolean} opts.autoApplyRaiseOnly - true=인상만 자동적용, false=리포트만
 * @param {boolean} opts.silent - true=텔레그램 알림 없음 (테스트용)
 */
async function runRepricingPipeline({ dryRun, autoApplyRaiseOnly, silent } = {}) {
  const isDryRun = dryRun !== undefined ? dryRun : CONFIG.DRY_RUN;
  const raiseOnly = autoApplyRaiseOnly !== undefined ? autoApplyRaiseOnly : CONFIG.AUTO_APPLY_RAISE_ONLY;

  console.log(`[RepricingPipeline] Start — mode: ${isDryRun ? 'DRY_RUN' : 'LIVE'}, raiseOnly: ${raiseOnly}`);
  const startAt = Date.now();

  // Step 1: DB에서 최근 6시간 경쟁사 가격 변동 알림 로드
  // (CompetitorMonitor가 2h마다 자동 실행중 — 여기서 중복 실행 안 함)
  let alerts = [];
  try {
    console.log('[RepricingPipeline] Step 1: Loading recent alerts from DB...');
    alerts = await loadRecentAlerts(6);
    console.log(`[RepricingPipeline] Loaded ${alerts.length} alerts from last 6h`);
  } catch (e) {
    console.error('[RepricingPipeline] Alert load error:', e.message);
  }

  // 변동 없으면 조기 종료 (텔레그램 알림도 없음 — 노이즈 방지)
  const priceAlerts = alerts.filter(a =>
    ['price_change', 'raise_opportunity', 'price_crash'].includes(a.type)
  );
  if (priceAlerts.length === 0) {
    console.log('[RepricingPipeline] No price changes detected — skip report');
    return { alerts: 0, proposals: 0, changed: 0, dryRun: isDryRun };
  }

  // Step 2+3: 마진 분석 + 행동 결정
  let proposals = [];
  try {
    console.log('[RepricingPipeline] Step 2+3: Analyzing & proposing...');
    proposals = await analyzeAndPropose(alerts);
    console.log(`[RepricingPipeline] Proposals: ${proposals.length} (raise: ${proposals.filter(p=>p.action==='raise').length}, drop: ${proposals.filter(p=>p.action==='drop').length}, hold: ${proposals.filter(p=>p.action==='hold').length})`);
  } catch (e) {
    console.error('[RepricingPipeline] Analyze error:', e.message);
  }

  // Step 4a: 자동 적용 (설정된 경우)
  let repricerReport = null;
  try {
    if (!isDryRun) {
      console.log('[RepricingPipeline] Step 4: Running auto repricer (live)...');
      repricerReport = await runAutoRepricer(false);
    } else {
      console.log('[RepricingPipeline] Step 4: Running auto repricer (dry run)...');
      repricerReport = await runAutoRepricer(true);
    }
  } catch (e) {
    console.error('[RepricingPipeline] Repricer error:', e.message);
  }

  // Step 4b: 텔레그램 리포트
  if (!silent) {
    try {
      await sendTelegramReport({
        monitorResult: { alerts, checked: alerts.length },
        proposals,
        repricerReport,
        dryRun: isDryRun,
      });
      console.log('[RepricingPipeline] Telegram report sent');
    } catch (e) {
      console.error('[RepricingPipeline] Telegram error:', e.message);
    }
  }

  const duration = Date.now() - startAt;
  const result = {
    dryRun: isDryRun,
    alerts: alerts.length,
    priceAlerts: priceAlerts.length,
    proposals: proposals.length,
    raises: proposals.filter(p => p.action === 'raise').length,
    drops: proposals.filter(p => p.action === 'drop').length,
    holds: proposals.filter(p => p.action === 'hold').length,
    changed: repricerReport?.changed || 0,
    errors: repricerReport?.errors?.length || 0,
    durationMs: duration,
  };

  console.log(`[RepricingPipeline] Done in ${duration}ms:`, JSON.stringify(result));
  return result;
}

module.exports = { runRepricingPipeline, analyzeAndPropose, sendTelegramReport, CONFIG };
