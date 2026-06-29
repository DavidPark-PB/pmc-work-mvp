'use strict';

/**
 * Hermes v1 Phase 3 — Listing Intelligence
 *
 * Read-only eBay listing quality analysis. This module must not call marketplace write APIs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');
const productIntel = require('./hermesProductIntelligence');

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
function todayKstDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function money(v) { return `$${num(v).toFixed(2)}`; }
function truncate(s, len = 100) {
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
    console.warn(`[ListingIntel] ${table} 조회 실패:`, e.message);
    return [];
  }
}

async function loadEbayListings(limit = 5000) {
  const rows = await safeSelect(
    'ebay_products',
    'sku,item_id,title,price_usd,shipping_usd,sales_count,stock,status,updated_at,image_url',
    q => q.limit(limit)
  );
  return Object.fromEntries(rows.map(r => [r.sku || r.item_id, r]));
}

function scoreValue(value, max, status = 'ok', reason = '') {
  return { value, points: value == null ? null : Math.max(0, Math.min(max, value)), max, status, reason };
}

function meaningfulTitleWords(title) {
  const stop = new Set(['new', 'the', 'and', 'with', 'for', 'set', 'toy', 'korea', 'korean', 'official']);
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stop.has(w));
}

function calcTitleKeywordScore(title) {
  if (!title) return scoreValue(null, 15, 'needs_data', 'title 없음');
  const words = meaningfulTitleWords(title);
  const unique = new Set(words);
  let points = 0;
  if (unique.size >= 8) points += 8;
  else if (unique.size >= 5) points += 5;
  else points += 2;
  if (/pokemon|yugioh|starbucks|sanrio|kakao|bts|cookie run|miffy|pinkfong/i.test(title)) points += 4;
  if (/booster|box|figure|plush|tumbler|photocard|board game|limited|sealed/i.test(title)) points += 3;
  return scoreValue(points, 15, 'ok', `${unique.size}개 주요 키워드`);
}

function calcTitleLengthScore(title) {
  if (!title) return scoreValue(null, 10, 'needs_data', 'title 없음');
  const len = String(title).length;
  let points;
  if (len >= 60 && len <= 80) points = 10;
  else if (len >= 45 && len <= 90) points = 7;
  else if (len >= 30 && len <= 100) points = 4;
  else points = 1;
  return scoreValue(points, 10, 'ok', `${len}자`);
}

function calcImageCountScore(listing) {
  const count = listing.image_url ? 1 : 0;
  if (count === 0) return scoreValue(0, 10, 'needs_data', 'image_url 없음');
  // 현재 ebay_products에는 대표 이미지 1장만 있음. 추가 이미지는 데이터 미연동.
  return scoreValue(4, 10, 'partial', '대표 이미지 1장 확인, 추가 이미지 수 미연동');
}

function calcImageQualityProxyScore(listing) {
  if (!listing.image_url) return scoreValue(null, 10, 'needs_data', 'image_url 없음');
  const url = String(listing.image_url);
  let points = 5;
  if (/https:/.test(url)) points += 2;
  if (!/thumb|small|s-l(64|140|225)/i.test(url)) points += 3;
  return scoreValue(points, 10, 'proxy', 'URL 기반 proxy 점수');
}

function calcItemSpecificsScore() {
  return scoreValue(null, 10, 'needs_data', '내 eBay item specifics 미연동');
}

function calcShippingScore(listing) {
  const shipping = num(listing.shipping_usd, NaN);
  if (!Number.isFinite(shipping)) return scoreValue(null, 10, 'needs_data', 'shipping_usd 없음');
  if (shipping === 0) return scoreValue(10, 10, 'ok', '무료배송');
  if (shipping <= 5) return scoreValue(8, 10, 'ok', `배송비 ${money(shipping)}`);
  if (shipping <= 15) return scoreValue(5, 10, 'watch', `배송비 ${money(shipping)}`);
  return scoreValue(2, 10, 'watch', `배송비 높음 ${money(shipping)}`);
}

function calcReturnPolicyScore() {
  return scoreValue(null, 5, 'needs_data', 'return policy 미연동');
}

function calcPricePositionScore(row) {
  if (row.priceStatus === 'winning') return scoreValue(10, 10, 'ok', '최저가 또는 $0.5 이내');
  if (row.priceStatus === 'competitive') return scoreValue(7, 10, 'ok', '$3 이내 경쟁권');
  if (row.priceStatus === 'losing') return scoreValue(3, 10, 'watch', `경쟁가 대비 ${money(row.priceDiff)} 높음`);
  return scoreValue(null, 10, 'needs_data', '경쟁가 매핑 없음');
}

function calcSalesVelocityScore(row, days) {
  const sales = int(row.sales30d);
  const label = `최근 ${days}일 ${sales}개 판매`;
  if (sales >= 10) return scoreValue(10, 10, 'ok', label);
  if (sales >= 5) return scoreValue(8, 10, 'ok', label);
  if (sales >= 1) return scoreValue(5, 10, 'watch', label);
  return scoreValue(0, 10, 'watch', label);
}

function calcCompetitorGapScore(row) {
  if (row.priceStatus === 'unknown') return scoreValue(null, 10, 'needs_data', '경쟁상품 매핑 없음');
  const diff = num(row.priceDiff);
  if (row.priceStatus === 'winning') return scoreValue(10, 10, 'ok', '경쟁 gap 우위');
  if (row.priceStatus === 'competitive') return scoreValue(7, 10, 'ok', '경쟁 gap 근접');
  if (diff <= 5) return scoreValue(4, 10, 'watch', `gap ${money(diff)}`);
  return scoreValue(1, 10, 'watch', `큰 gap ${money(diff)}`);
}

function buildScores(row, listing, days) {
  const scores = {
    title_keyword_score: calcTitleKeywordScore(row.title),
    title_length_score: calcTitleLengthScore(row.title),
    image_count_score: calcImageCountScore(listing),
    image_quality_proxy_score: calcImageQualityProxyScore(listing),
    item_specifics_score: calcItemSpecificsScore(),
    shipping_score: calcShippingScore(listing),
    return_policy_score: calcReturnPolicyScore(),
    price_position_score: calcPricePositionScore(row),
    sales_velocity_score: calcSalesVelocityScore(row, days),
    competitor_gap_score: calcCompetitorGapScore(row),
  };

  let total = 0;
  let max = 0;
  let needsData = 0;
  for (const s of Object.values(scores)) {
    if (s.points == null) {
      needsData++;
      continue;
    }
    total += s.points;
    max += s.max;
  }
  const normalized = max > 0 ? +(total / max * 100).toFixed(1) : null;
  return { scores, total, max, normalized, needsData };
}

function improvementReasons(row, quality) {
  const reasons = [];
  const s = quality.scores;
  if ((s.title_keyword_score.points ?? 15) < 8 || (s.title_length_score.points ?? 10) < 7) reasons.push('title 개선');
  if ((s.image_count_score.points ?? 10) < 7 || s.image_quality_proxy_score.status === 'needs_data') reasons.push('이미지 보강');
  if (s.item_specifics_score.status === 'needs_data') reasons.push('item specifics 보강');
  if (s.return_policy_score.status === 'needs_data') reasons.push('return policy 확인');
  if ((s.shipping_score.points ?? 10) < 7) reasons.push('배송 조건 점검');
  if (row.priceStatus === 'losing') reasons.push('가격/마진 검토');
  if (row.signal?.type === 'dead_stock_candidate') reasons.push('dead stock 처리');
  if (row.signal?.type === 'data_gap') reasons.push('기본 데이터 보강');
  return reasons;
}

function classifyListing(row, quality) {
  const reasons = improvementReasons(row, quality);
  const score = quality.normalized == null ? 0 : quality.normalized;
  let priority = 'low';
  if (row.signal?.type === 'listing_quality_candidate') priority = 'high';
  else if (row.signal?.type === 'dead_stock_candidate') priority = 'normal';
  else if (row.signal?.type === 'data_gap') priority = 'normal';
  else if (row.signal?.type === 'price_or_margin_review') priority = 'normal';
  if (score < 45 && priority === 'low') priority = 'normal';
  return {
    priority,
    reasons,
    recommendation: reasons.length > 0 ? reasons.join(' + ') : '유지 관찰',
  };
}

async function buildListingRows({ days = 30 } = {}) {
  const [{ rows: productRows }, listingBySku] = await Promise.all([
    productIntel.buildProductIntelligenceReport({ days, save: false }),
    loadEbayListings(),
  ]);

  const rows = productRows.map(row => {
    const listing = listingBySku[row.sku] || listingBySku[row.itemId] || {};
    const quality = buildScores(row, listing, days);
    return {
      ...row,
      listing,
      quality,
      listingSignal: classifyListing(row, quality),
    };
  });

  const productRank = {
    listing_quality_candidate: 0,
    dead_stock_candidate: 1,
    data_gap: 2,
    price_or_margin_review: 3,
  };
  const priorityRank = { high: 0, normal: 1, low: 2 };
  rows.sort((a, b) => {
    const ap = productRank[a.signal?.type] ?? 9;
    const bp = productRank[b.signal?.type] ?? 9;
    if (ap !== bp) return ap - bp;
    const p = priorityRank[a.listingSignal.priority] - priorityRank[b.listingSignal.priority];
    if (p !== 0) return p;
    return (a.quality.normalized ?? 999) - (b.quality.normalized ?? 999);
  });
  return rows;
}

function byProductType(rows, type) { return rows.filter(r => r.signal?.type === type); }
function needsTitle(row) {
  return (row.quality.scores.title_keyword_score.points ?? 15) < 8 || (row.quality.scores.title_length_score.points ?? 10) < 7;
}
function needsSpecifics(row) { return row.quality.scores.item_specifics_score.status === 'needs_data'; }
function needsImages(row) { return (row.quality.scores.image_count_score.points ?? 10) < 7 || row.quality.scores.image_quality_proxy_score.status === 'needs_data'; }
function needsShippingReturns(row) {
  return (row.quality.scores.shipping_score.points ?? 10) < 7 || row.quality.scores.return_policy_score.status === 'needs_data';
}
function cheaperNoSales(row) {
  return row.sales30d === 0 && ['winning', 'competitive'].includes(row.priceStatus);
}
function expensiveButSelling(row) {
  return row.sales30d > 0 && row.priceStatus === 'losing';
}
function dataPoor(row) { return row.signal?.type === 'data_gap' || row.quality.needsData >= 4; }

function addSection(lines, title, rows, formatter, empty = '없음') {
  lines.push('', `## ${title}`);
  if (!rows || rows.length === 0) {
    lines.push(`- ${empty}`);
    return;
  }
  rows.forEach((row, idx) => lines.push(formatter(row, idx)));
}

function scoreLabel(row) {
  return row.quality.normalized == null ? 'needs_data' : `${row.quality.normalized}점`;
}
function formatListing(row) {
  const reasons = row.listingSignal.reasons.slice(0, 4).join(', ') || '관찰';
  return `- ${row.sku}: ${escapeMd(truncate(row.title, 70))} — score ${scoreLabel(row)}, ${reasons}`;
}

async function saveReport(report) {
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
    console.warn('[ListingIntel] daily_reports 저장 실패:', e.message);
  }
  return report;
}

async function buildListingIntelligenceReport({ date = todayKstDate(), days = 30, save = true } = {}) {
  const rows = await buildListingRows({ days });
  const productSummary = {
    listingQualityCandidates: byProductType(rows, 'listing_quality_candidate').length,
    deadStockCandidates: byProductType(rows, 'dead_stock_candidate').length,
    dataGaps: byProductType(rows, 'data_gap').length,
    priceOrMarginReviews: byProductType(rows, 'price_or_margin_review').length,
  };
  const summary = {
    total: rows.length,
    improvementCandidates: rows.filter(r => ['listing_quality_candidate', 'dead_stock_candidate', 'data_gap', 'price_or_margin_review'].includes(r.signal?.type)).length,
    titleNeeds: rows.filter(needsTitle).length,
    itemSpecificsNeeds: rows.filter(needsSpecifics).length,
    imageNeeds: rows.filter(needsImages).length,
    shippingReturnNeeds: rows.filter(needsShippingReturns).length,
    cheaperNoSales: rows.filter(cheaperNoSales).length,
    expensiveButSelling: rows.filter(expensiveButSelling).length,
    deadStockPriority: byProductType(rows, 'dead_stock_candidate').length,
    dataPoor: rows.filter(dataPoor).length,
    productSummary,
  };

  const lines = [
    '# Hermes v1 Listing Intelligence Report',
    `날짜: ${date}`,
    `기간: 최근 ${days}일`,
    '',
    '## 요약',
    `- 분석 listing/SKU: ${summary.total}개`,
    `- 개선 우선 후보: ${summary.improvementCandidates}개`,
    `- Product Intelligence 기반 후보: 리스팅 품질 ${productSummary.listingQualityCandidates}개 / Dead stock ${productSummary.deadStockCandidates}개 / 데이터 보강 ${productSummary.dataGaps}개 / 가격·마진 검토 ${productSummary.priceOrMarginReviews}개`,
    `- 제목 개선 필요: ${summary.titleNeeds}개`,
    `- Item Specific 보강 필요: ${summary.itemSpecificsNeeds}개`,
    `- 이미지 보강 필요: ${summary.imageNeeds}개`,
    `- 배송/반품 점검 필요: ${summary.shippingReturnNeeds}개`,
    '- Hermes v1: 분석/추천 전용, 가격 변경 없음',
    '',
    '## Listing Quality Score 모델',
    '- title_keyword_score, title_length_score, image_count_score, image_quality_proxy_score',
    '- item_specifics_score, shipping_score, return_policy_score',
    '- price_position_score, sales_velocity_score, competitor_gap_score',
    '- 미연동 데이터는 null/needs_data로 처리',
  ];

  addSection(lines, '오늘 개선 우선 SKU TOP 20', rows.filter(r => r.listingSignal.priority !== 'low').slice(0, 20), formatListing);
  addSection(lines, '내가 더 싼데도 안 팔리는 SKU', rows.filter(cheaperNoSales).slice(0, 20), formatListing);
  addSection(lines, '내가 더 비싼데도 팔리는 SKU', rows.filter(expensiveButSelling).slice(0, 20), formatListing);
  addSection(lines, '제목 개선 필요 SKU', rows.filter(needsTitle).slice(0, 20), formatListing);
  addSection(lines, 'Item Specific 보강 필요 SKU', rows.filter(needsSpecifics).slice(0, 20), formatListing);
  addSection(lines, '이미지 보강 필요 SKU', rows.filter(needsImages).slice(0, 20), formatListing);
  addSection(lines, '배송/반품 조건 점검 SKU', rows.filter(needsShippingReturns).slice(0, 20), formatListing);
  addSection(lines, 'Dead stock 우선 처리 SKU', byProductType(rows, 'dead_stock_candidate').slice(0, 20), formatListing);
  addSection(lines, '데이터 부족 SKU', rows.filter(dataPoor).slice(0, 20), formatListing);

  const report = {
    report_date: date,
    report_type: 'listing_intelligence',
    title: `Hermes v1 Listing Intelligence — ${date}`,
    summary: `listings=${summary.total}, improve=${summary.improvementCandidates}, title=${summary.titleNeeds}, images=${summary.imageNeeds}`,
    markdown: lines.join('\n'),
    data: { summary, generatedAt: nowIso(), days },
  };

  if (save) await saveReport(report);
  return { report, rows };
}

async function sendListingIntelligenceToTelegram(report) {
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

async function runListingIntelligence({ days = 30, sendTelegram = false } = {}) {
  const { report, rows } = await buildListingIntelligenceReport({ days, save: true });
  if (sendTelegram) await sendListingIntelligenceToTelegram(report);
  return { report, rows };
}

module.exports = {
  buildListingIntelligenceReport,
  runListingIntelligence,
  sendListingIntelligenceToTelegram,
};
