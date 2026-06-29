'use strict';

/**
 * Hermes v1 Phase 2 — Product Intelligence
 *
 * Read-only SKU portfolio analysis. This module must not call marketplace write APIs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');
const { getDashboard } = require('./competitorDashboard');

const TZ = 'Asia/Seoul';

function nowIso() { return new Date().toISOString(); }
function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function int(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function money(v) { return `$${num(v).toFixed(2)}`; }
function todayKstDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function truncate(s, len = 110) {
  s = String(s || '');
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}
function escapeMd(s) {
  return String(s || '').replace(/[`*_\[\]()]/g, '');
}

async function safeSelect(table, select, buildQuery) {
  const db = getClient();
  try {
    let q = db.from(table).select(select);
    q = buildQuery ? buildQuery(q) : q;
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn(`[ProductIntel] ${table} 조회 실패:`, e.message);
    return [];
  }
}

async function loadSalesBySku(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = await safeSelect(
    'orders',
    'sku,title,quantity,payment_amount,currency,order_date,platform,status',
    q => q.gte('order_date', since).limit(10000)
  );

  const bySku = {};
  for (const r of rows) {
    const sku = String(r.sku || '').trim();
    if (!sku) continue;
    if (!bySku[sku]) {
      bySku[sku] = { sku, units: 0, revenue: 0, orders: 0, title: r.title || '', platforms: new Set() };
    }
    bySku[sku].units += int(r.quantity, 1);
    bySku[sku].revenue += num(r.payment_amount);
    bySku[sku].orders += 1;
    if (r.platform) bySku[sku].platforms.add(r.platform);
    if (!bySku[sku].title && r.title) bySku[sku].title = r.title;
  }

  for (const s of Object.values(bySku)) {
    s.platforms = [...s.platforms];
  }
  return bySku;
}

async function loadEbayListings(limit = 5000) {
  const rows = await safeSelect(
    'ebay_products',
    'sku,item_id,title,price_usd,shipping_usd,sales_count,stock,status,updated_at,image_url',
    q => q.limit(limit)
  );
  return rows.filter(r => String(r.sku || r.item_id || '').trim());
}

async function loadSkuScores(limit = 5000) {
  const rows = await safeSelect(
    'sku_scores',
    'sku,normalized_score,classification,purchase_allowed,purchase_reason,auto_retirement,calculated_at',
    q => q.limit(limit)
  );
  return Object.fromEntries(rows.map(r => [r.sku, r]));
}

async function loadCompetitorDashboard() {
  try {
    const result = await getDashboard({ limit: 5000, onlyCompeted: true });
    return result || { items: [], summary: {} };
  } catch (e) {
    console.warn('[ProductIntel] competitorDashboard 실패:', e.message);
    return { items: [], summary: {} };
  }
}

function classifySku(row) {
  const reasons = [];
  const dataGaps = [];
  const sales30d = int(row.sales30d);
  const stock = int(row.stock);
  const priceTotal = num(row.priceTotal);
  const priceStatus = row.priceStatus || 'unknown';
  const hasCompetition = priceStatus !== 'unknown';

  if (!row.sku) dataGaps.push('sku 없음');
  if (!row.title) dataGaps.push('title 없음');
  if (priceTotal <= 0) dataGaps.push('price 없음');
  if (dataGaps.length > 0) {
    return { type: 'data_gap', priority: 'high', reasons: dataGaps, recommendation: '상품/리스팅 기본 데이터 보강' };
  }

  if (sales30d > 0 && stock <= 2) {
    return { type: 'stock_risk', priority: 'urgent', reasons: [`${sales30d}개 판매`, `재고 ${stock}개`], recommendation: '재입고/소싱 우선 검토' };
  }

  if (sales30d > 0 && ['winning', 'competitive'].includes(priceStatus)) {
    reasons.push(`${sales30d}개 판매`, `경쟁상태 ${priceStatus}`);
    if (row.score?.classification) reasons.push(`SKU 등급 ${row.score.classification}`);
    return { type: 'scale_candidate', priority: 'high', reasons, recommendation: '재고/광고/노출 확대 후보' };
  }

  if (priceStatus === 'losing') {
    reasons.push(`내 가격 ${money(row.ourTotal)} / 최저경쟁 ${money(row.lowestTotal)}`);
    if (row.priceDiff) reasons.push(`차이 ${money(row.priceDiff)}`);
    return { type: 'price_or_margin_review', priority: 'high', reasons, recommendation: '자동 인하 금지 — 원가/마진 확인 후 조정 후보 판단' };
  }

  if (sales30d === 0 && ['winning', 'competitive'].includes(priceStatus)) {
    reasons.push('최근 30일 판매 0', `가격 경쟁력 ${priceStatus}`);
    return { type: 'listing_quality_candidate', priority: 'normal', reasons, recommendation: '가격보다 타이틀/이미지/키워드/카테고리 점검' };
  }

  if (stock > 0 && sales30d === 0 && (!hasCompetition || priceStatus === 'unknown')) {
    return { type: 'dead_stock_candidate', priority: 'normal', reasons: ['재고 있음', '최근 30일 판매 0', '경쟁 데이터 부족'], recommendation: 'bundle/콘텐츠/보류 또는 경쟁상품 매핑 검토' };
  }

  return { type: 'watch', priority: 'low', reasons: ['특이 신호 없음'], recommendation: '유지 관찰' };
}

function buildPortfolioRows({ listings, salesBySku, dashboard, scoreBySku }) {
  const dashBySku = Object.fromEntries((dashboard.items || []).map(i => [i.sku, i]));
  const skuSet = new Set();
  listings.forEach(r => skuSet.add(r.sku || r.item_id));
  Object.keys(salesBySku).forEach(sku => skuSet.add(sku));
  Object.keys(scoreBySku).forEach(sku => skuSet.add(sku));

  const listingBySku = {};
  for (const l of listings) {
    const sku = l.sku || l.item_id;
    if (!listingBySku[sku]) listingBySku[sku] = l;
  }

  const rows = [];
  for (const sku of skuSet) {
    const l = listingBySku[sku] || {};
    const sales = salesBySku[sku] || {};
    const d = dashBySku[sku] || {};
    const score = scoreBySku[sku] || null;
    const row = {
      sku,
      itemId: l.item_id || d.itemId || d.ourItemId || '',
      title: l.title || sales.title || d.title || '',
      price: num(l.price_usd),
      shipping: num(l.shipping_usd),
      priceTotal: num(l.price_usd) + num(l.shipping_usd),
      stock: int(l.stock),
      status: l.status || '',
      sales30d: int(sales.units),
      revenue30d: num(sales.revenue),
      orderCount30d: int(sales.orders),
      priceStatus: d.priceStatus || 'unknown',
      ourTotal: d.ourTotal ?? (num(l.price_usd) + num(l.shipping_usd)),
      lowestTotal: d.lowestTotal ?? null,
      priceDiff: d.priceDiff ?? null,
      competitorCount: d.competitorCount ?? null,
      score,
    };
    row.signal = classifySku(row);
    rows.push(row);
  }

  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  rows.sort((a, b) => {
    const p = priorityRank[a.signal.priority] - priorityRank[b.signal.priority];
    if (p !== 0) return p;
    return b.sales30d - a.sales30d || num(b.revenue30d) - num(a.revenue30d);
  });
  return rows;
}

function byType(rows, type) { return rows.filter(r => r.signal.type === type); }

function addSection(lines, title, rows, formatter, empty = '없음') {
  lines.push('', `## ${title}`);
  if (!rows || rows.length === 0) {
    lines.push(`- ${empty}`);
    return;
  }
  rows.forEach((row, idx) => lines.push(formatter(row, idx)));
}

function formatRow(row) {
  const reason = row.signal.reasons.join(', ');
  return `- ${row.sku}: ${escapeMd(truncate(row.title, 70))} — ${reason} → ${row.signal.recommendation}`;
}

async function buildProductIntelligenceReport({ date = todayKstDate(), days = 30, save = true } = {}) {
  const [listings, salesBySku, dashboard, scoreBySku] = await Promise.all([
    loadEbayListings(),
    loadSalesBySku(days),
    loadCompetitorDashboard(),
    loadSkuScores(),
  ]);

  const rows = buildPortfolioRows({ listings, salesBySku, dashboard, scoreBySku });
  const summary = {
    totalSkus: rows.length,
    listedSkus: listings.length,
    soldSkus: Object.keys(salesBySku).length,
    scaleCandidates: byType(rows, 'scale_candidate').length,
    listingQualityCandidates: byType(rows, 'listing_quality_candidate').length,
    priceOrMarginReviews: byType(rows, 'price_or_margin_review').length,
    stockRisks: byType(rows, 'stock_risk').length,
    deadStockCandidates: byType(rows, 'dead_stock_candidate').length,
    dataGaps: byType(rows, 'data_gap').length,
    watch: byType(rows, 'watch').length,
  };

  const lines = [
    '# Hermes v1 Product Intelligence Report',
    `날짜: ${date}`,
    `기간: 최근 ${days}일`,
    '',
    '## 포트폴리오 요약',
    `- 분석 SKU: ${summary.totalSkus}개`,
    `- eBay listing SKU: ${summary.listedSkus}개`,
    `- 최근 ${days}일 판매 SKU: ${summary.soldSkus}개`,
    `- 확장 후보: ${summary.scaleCandidates}개`,
    `- 리스팅 품질 점검 후보: ${summary.listingQualityCandidates}개`,
    `- 가격/마진 검토 후보: ${summary.priceOrMarginReviews}개`,
    `- 재고 리스크: ${summary.stockRisks}개`,
    `- Dead stock 후보: ${summary.deadStockCandidates}개`,
    `- 데이터 보강 필요: ${summary.dataGaps}개`,
    '- Hermes v1: 분석/추천 전용, 가격 변경 없음',
  ];

  addSection(lines, '확장 후보 SKU TOP 15', byType(rows, 'scale_candidate').slice(0, 15), formatRow);
  addSection(lines, '리스팅 품질 점검 후보 TOP 15', byType(rows, 'listing_quality_candidate').slice(0, 15), formatRow);
  addSection(lines, '가격/마진 검토 후보 TOP 15', byType(rows, 'price_or_margin_review').slice(0, 15), formatRow);
  addSection(lines, '재고 리스크 SKU', byType(rows, 'stock_risk').slice(0, 20), formatRow);
  addSection(lines, 'Dead stock / 보류 후보', byType(rows, 'dead_stock_candidate').slice(0, 20), formatRow);
  addSection(lines, '데이터 보강 필요 SKU', byType(rows, 'data_gap').slice(0, 20), formatRow);

  const markdown = lines.join('\n');
  const report = {
    report_date: date,
    report_type: 'product_intelligence',
    title: `Hermes v1 Product Intelligence — ${date}`,
    summary: `skus=${summary.totalSkus}, scale=${summary.scaleCandidates}, listing_quality=${summary.listingQualityCandidates}, review=${summary.priceOrMarginReviews}`,
    markdown,
    data: { summary, generatedAt: nowIso(), days },
  };

  if (save) {
    const db = getClient();
    try {
      const { data, error } = await db
        .from('daily_reports')
        .upsert(report, { onConflict: 'report_date,report_type' })
        .select('id')
        .single();
      if (error) throw error;
      report.id = data?.id;
    } catch (e) {
      console.warn('[ProductIntel] daily_reports 저장 실패:', e.message);
    }
  }

  return { report, rows };
}

async function sendProductIntelligenceToTelegram(report) {
  if (!telegram.isConfigured()) return null;
  const text = report.markdown || '';
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  let first = null;
  for (let i = 0; i < chunks.length; i++) {
    const sent = await telegram.sendMessage(chunks[i], { parseMode: null });
    if (i === 0) first = sent;
    await new Promise(r => setTimeout(r, 300));
  }
  return first;
}

async function runProductIntelligence({ days = 30, sendTelegram = false } = {}) {
  const { report, rows } = await buildProductIntelligenceReport({ days, save: true });
  if (sendTelegram) await sendProductIntelligenceToTelegram(report);
  return { report, rows };
}

module.exports = {
  buildProductIntelligenceReport,
  sendProductIntelligenceToTelegram,
  runProductIntelligence,
};
