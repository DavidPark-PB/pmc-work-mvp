'use strict';

/**
 * Hermes v1 Market Intelligence
 *
 * eBay monitoring / analysis / report-only service.
 * IMPORTANT: this module must never call marketplace write APIs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');
const { getDashboard } = require('./competitorDashboard');
const { notifyMany, getAdminIds, getStaffIds } = require('./notificationService');

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
function pct(v) { return `${num(v).toFixed(1)}%`; }
function todayKstDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function truncate(s, len = 120) {
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
    console.warn(`[MarketIntel] ${table} 조회 실패:`, e.message);
    return [];
  }
}

async function tryInsert(table, rowOrRows, opts = {}) {
  const db = getClient();
  try {
    let q = db.from(table).insert(rowOrRows);
    if (opts.select) q = q.select(opts.select);
    if (opts.single) q = q.single();
    const { data, error } = await q;
    if (error) throw error;
    return { data, error: null };
  } catch (e) {
    console.warn(`[MarketIntel] ${table} insert 실패:`, e.message);
    return { data: null, error: e };
  }
}

async function tryUpsert(table, rows, options = {}) {
  const db = getClient();
  try {
    const { data, error } = await db.from(table).upsert(rows, options).select();
    if (error) throw error;
    return { data, error: null };
  } catch (e) {
    console.warn(`[MarketIntel] ${table} upsert 실패:`, e.message);
    return { data: null, error: e };
  }
}

/** Sync read-only eBay DB rows into explicit Hermes v1 my_listings table. */
async function syncMyListingsSnapshot({ limit = 5000 } = {}) {
  const rows = await safeSelect(
    'ebay_products',
    'sku,item_id,title,price_usd,shipping_usd,stock,status,updated_at',
    q => q.neq('status', 'ended').limit(limit)
  );

  if (rows.length === 0) return { synced: 0, skipped: true };

  const payload = rows
    .filter(r => r.item_id)
    .map(r => ({
      platform: 'ebay',
      sku: r.sku || r.item_id,
      item_id: r.item_id,
      title: r.title || '',
      price: num(r.price_usd),
      shipping: num(r.shipping_usd),
      quantity: int(r.stock),
      status: r.status || 'active',
      last_synced_at: r.updated_at || nowIso(),
      updated_at: nowIso(),
    }));

  if (payload.length === 0) return { synced: 0, skipped: true };
  await tryUpsert('my_listings', payload, { onConflict: 'platform,item_id' });
  return { synced: payload.length, skipped: false };
}

/** Backfill explicit sku_mappings from legacy product_matches. */
async function syncSkuMappingsFromProductMatches({ limit = 5000 } = {}) {
  const matches = await safeSelect(
    'product_matches',
    'our_sku,our_item_id,competitor_item_id,seller_id,confidence,method,ai_reason,status,created_at,updated_at',
    q => q.limit(limit)
  );
  if (matches.length === 0) return { synced: 0, skipped: true };

  const compIds = [...new Set(matches.map(m => m.competitor_item_id).filter(Boolean))];
  const listings = compIds.length > 0
    ? await safeSelect('competitor_listings', 'ebay_item_id,title', q => q.in('ebay_item_id', compIds))
    : [];
  const titleById = Object.fromEntries(listings.map(l => [l.ebay_item_id, l.title || '']));

  const rows = matches
    .filter(m => m.our_sku && m.competitor_item_id)
    .map(m => ({
      our_sku: m.our_sku,
      our_item_id: m.our_item_id || null,
      competitor_seller_id: m.seller_id || '',
      competitor_item_id: m.competitor_item_id,
      competitor_title: titleById[m.competitor_item_id] || '',
      auto_change_allowed: false,
      target_margin_pct: 30,
      minimum_margin_pct: 15,
      match_confidence: num(m.confidence),
      match_method: m.method || 'manual',
      status: m.status || 'pending',
      notes: m.ai_reason || '',
      created_at: m.created_at || nowIso(),
      updated_at: m.updated_at || nowIso(),
    }));

  if (rows.length === 0) return { synced: 0, skipped: true };
  await tryUpsert('sku_mappings', rows, { onConflict: 'our_sku,competitor_item_id' });
  return { synced: rows.length, skipped: false };
}

async function recordPriceSnapshot({ snapshotType, sku, sellerId, itemId, title, price, shipping, quantity, status, rawData }) {
  return tryInsert('price_snapshots', {
    snapshot_type: snapshotType,
    platform: 'ebay',
    sku: sku || null,
    seller_id: sellerId || null,
    item_id: itemId,
    title: title || '',
    price: num(price),
    shipping: num(shipping),
    quantity: quantity == null ? null : int(quantity),
    status: status || 'active',
    raw_data: rawData || {},
    captured_at: nowIso(),
  });
}

async function recordMarketAlert(alert, { sendTelegram = false } = {}) {
  const row = {
    event_key: alert.eventKey || null,
    alert_type: alert.alertType,
    severity: alert.severity || 'info',
    platform: 'ebay',
    sku: alert.sku || null,
    our_item_id: alert.ourItemId || null,
    competitor_seller_id: alert.competitorSellerId || null,
    competitor_item_id: alert.competitorItemId || null,
    title: alert.title || '',
    message: alert.message,
    recommendation: alert.recommendation || '',
    old_price: alert.oldPrice == null ? null : num(alert.oldPrice),
    new_price: alert.newPrice == null ? null : num(alert.newPrice),
    old_shipping: alert.oldShipping == null ? null : num(alert.oldShipping),
    new_shipping: alert.newShipping == null ? null : num(alert.newShipping),
    old_status: alert.oldStatus || null,
    new_status: alert.newStatus || null,
    margin_pct: alert.marginPct == null ? null : num(alert.marginPct),
    data: alert.data || {},
    created_at: alert.createdAt || nowIso(),
  };

  const db = getClient();
  let inserted = null;
  try {
    const { data, error } = await db
      .from('market_alerts')
      .upsert(row, { onConflict: 'event_key', ignoreDuplicates: true })
      .select('id,event_key,alert_type,severity,sku,message,recommendation,created_at')
      .maybeSingle();
    if (error) throw error;
    inserted = data;
  } catch (e) {
    console.warn('[MarketIntel] market_alerts upsert 실패:', e.message);
  }

  if (sendTelegram && inserted) {
    await sendMarketAlertToTelegram(inserted);
  }
  return inserted;
}

async function sendMarketAlertToTelegram(alert) {
  const icon = {
    price_drop: '📉', price_rise: '📈', out_of_stock: '⚫', restocked: '🟢',
    new_listing: '🆕', undercut: '⚠️', margin_risk: '🔴', ended: '⚫',
  }[alert.alert_type] || '🔔';
  const text = [
    `${icon} Hermes Market Alert`,
    alert.sku ? `SKU: ${alert.sku}` : '',
    alert.message,
    alert.recommendation ? `추천: ${alert.recommendation}` : '',
  ].filter(Boolean).join('\n');

  // 인앱 알림 미러링 (사장님 결정 2026-07-15): 경쟁사 가격/재고 변동을 직원에게도 공유.
  // margin_risk 는 원가/마진 노출 소지 있어 admin 만. 나머지 (price/stock/new_listing) 는 admin+staff.
  await _mirrorMarketAlertInApp(alert, icon).catch(e => console.warn('[MarketIntel] in-app mirror 실패:', e.message));

  if (!telegram.isConfigured()) return null;
  const shortId = String(alert.id || '').slice(0, 8);
  const keyboard = shortId ? [[{ text: '상세보기', callback_data: `market:detail:${shortId}` }]] : [];
  return telegram.sendWithButtons(text, keyboard, { parseMode: null });
}

async function _mirrorMarketAlertInApp(alert, icon) {
  const isMarginSensitive = alert.alert_type === 'margin_risk';
  // 사장님에게만 갈 종류 vs 전 직원 공유 종류 구분
  const [adminIds, staffIds] = await Promise.all([getAdminIds(), getStaffIds()]);
  const recipients = isMarginSensitive ? adminIds : [...adminIds, ...staffIds];
  if (recipients.length === 0) return;

  const titleMap = {
    price_drop: '경쟁사 가격 하락',
    price_rise: '경쟁사 가격 상승',
    out_of_stock: '경쟁사 품절',
    restocked: '경쟁사 재입고',
    new_listing: '경쟁사 신규 리스팅',
    undercut: '경쟁사 언더컷',
    margin_risk: '마진 위험',
    ended: '경쟁사 리스팅 종료',
  };
  const title = `${icon} ${titleMap[alert.alert_type] || 'Market Alert'}`;
  const bodyParts = [];
  if (alert.sku) bodyParts.push(`SKU ${alert.sku}`);
  if (alert.message) bodyParts.push(alert.message);
  const body = bodyParts.join(' · ').slice(0, 250);

  await notifyMany(recipients, {
    type: 'market_alert',
    title,
    body,
    linkUrl: '/?page=hermes-market',
    relatedType: 'market_alert',
    relatedId: alert.id || null,
  });
}

function buildAlertFromPriceHistory(row, mappingByComp, listingByComp) {
  const oldTotal = row.old_total != null ? num(row.old_total) : num(row.old_price) + num(row.old_shipping);
  const newTotal = row.new_total != null ? num(row.new_total) : num(row.new_price) + num(row.new_shipping);
  const compId = row.competitor_item_id || row.ebay_item_id;
  const mapping = mappingByComp[compId] || {};
  const listing = listingByComp[compId] || {};
  const isDrop = newTotal < oldTotal;
  const changePct = oldTotal > 0 ? Math.abs((newTotal - oldTotal) / oldTotal * 100) : num(row.change_pct);
  const type = isDrop ? 'price_drop' : 'price_rise';
  const severity = isDrop && changePct >= 10 ? 'warning' : 'watch';
  return {
    eventKey: `${type}:${compId}:${row.changed_at || row.created_at}:${oldTotal}:${newTotal}`,
    alertType: type,
    severity,
    sku: mapping.our_sku || row.sku || null,
    ourItemId: mapping.our_item_id || null,
    competitorSellerId: row.seller_id || mapping.competitor_seller_id || listing.seller_id || '',
    competitorItemId: compId,
    title: listing.title || mapping.competitor_title || '',
    oldPrice: row.old_price,
    newPrice: row.new_price,
    oldShipping: row.old_shipping,
    newShipping: row.new_shipping,
    message: `${row.seller_id || listing.seller_id || 'competitor'} ${isDrop ? '가격 하락' : '가격 상승'}: ${money(oldTotal)} → ${money(newTotal)} (${pct(changePct)})`,
    recommendation: isDrop
      ? '단일 경쟁사 인하를 즉시 따라가지 말고 마진/다른 경쟁사 움직임 확인'
      : '경쟁사 인상 신호 — 가격 유지 또는 인상 후보 검토',
    createdAt: row.changed_at || row.created_at || nowIso(),
    data: { oldTotal, newTotal, changePct },
  };
}

async function generateMarketAlerts({ hours = 24, sendTelegram = false, limit = 200 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const [history, newListings, mappings] = await Promise.all([
    safeSelect('competitor_price_history', '*', q => q.gte('changed_at', since).order('changed_at', { ascending: false }).limit(limit)),
    safeSelect('competitor_listings', '*', q => q.gte('first_seen', since).order('first_seen', { ascending: false }).limit(limit)),
    safeSelect('sku_mappings', '*', q => q.eq('status', 'approved').limit(5000)),
  ]);

  const compIds = [...new Set([
    ...history.map(h => h.competitor_item_id || h.ebay_item_id),
    ...newListings.map(l => l.ebay_item_id),
  ].filter(Boolean))];
  const listings = compIds.length > 0
    ? await safeSelect('competitor_listings', '*', q => q.in('ebay_item_id', compIds))
    : [];
  const listingByComp = Object.fromEntries(listings.map(l => [l.ebay_item_id, l]));
  const mappingByComp = Object.fromEntries((mappings || []).map(m => [m.competitor_item_id, m]));

  const alerts = [];
  for (const h of history) alerts.push(buildAlertFromPriceHistory(h, mappingByComp, listingByComp));

  for (const l of newListings) {
    const mapping = mappingByComp[l.ebay_item_id] || {};
    alerts.push({
      eventKey: `new_listing:${l.ebay_item_id}:${l.first_seen}`,
      alertType: 'new_listing',
      severity: 'info',
      sku: mapping.our_sku || null,
      ourItemId: mapping.our_item_id || null,
      competitorSellerId: l.seller_id,
      competitorItemId: l.ebay_item_id,
      title: l.title || '',
      newPrice: l.price,
      newShipping: l.shipping,
      message: `${l.seller_id} 신규 경쟁상품: ${truncate(l.title, 80)} (${money(num(l.price) + num(l.shipping))})`,
      recommendation: mapping.our_sku ? '매핑된 SKU 경쟁상황 확인' : 'SKU 매핑 후보 검토',
      createdAt: l.first_seen || nowIso(),
      data: { url: l.url || '' },
    });
  }

  const inserted = [];
  for (const a of alerts.slice(0, limit)) {
    const row = await recordMarketAlert(a, { sendTelegram });
    if (row) inserted.push(row);
    if (sendTelegram) await new Promise(r => setTimeout(r, 300));
  }

  return { generated: alerts.length, inserted: inserted.length, since };
}

function section(lines, title, rows, formatter, empty = '없음') {
  lines.push('', `## ${title}`);
  if (!rows || rows.length === 0) {
    lines.push(`- ${empty}`);
    return;
  }
  rows.forEach((row, idx) => lines.push(formatter(row, idx)));
}

async function buildDailyReport({ date = todayKstDate(), hours = 24, save = true } = {}) {
  await syncMyListingsSnapshot().catch(() => {});
  await syncSkuMappingsFromProductMatches().catch(() => {});

  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const [alerts, dashboardResult] = await Promise.all([
    safeSelect('market_alerts', '*', q => q.gte('created_at', since).order('created_at', { ascending: false }).limit(500)),
    getDashboard({ limit: 500, onlyCompeted: true }).catch(e => {
      console.warn('[MarketIntel] dashboard 생성 실패:', e.message);
      return { items: [], summary: { total: 0, winning: 0, competitive: 0, losing: 0 } };
    }),
  ]);

  const byType = type => alerts.filter(a => a.alert_type === type);
  const priceDrops = byType('price_drop').sort((a, b) => num(b.old_price) - num(b.new_price) - (num(a.old_price) - num(a.new_price))).slice(0, 10);
  const priceRises = byType('price_rise').sort((a, b) => num(b.new_price) - num(b.old_price) - (num(a.new_price) - num(a.old_price))).slice(0, 10);
  const stockAlerts = alerts.filter(a => ['out_of_stock','restocked','ended'].includes(a.alert_type)).slice(0, 20);
  const newComp = byType('new_listing').slice(0, 10);
  const losing = (dashboardResult.items || []).filter(i => i.priceStatus === 'losing').slice(0, 20);
  const winning = (dashboardResult.items || []).filter(i => i.priceStatus === 'winning').slice(0, 20);
  const keep = (dashboardResult.items || []).filter(i => i.priceStatus === 'competitive' || i.priceStatus === 'winning').slice(0, 20);
  const doNotChange = alerts.filter(a => ['margin_risk','price_drop'].includes(a.alert_type) && /따라가지|마진|금지|위험/.test(a.recommendation || a.message)).slice(0, 20);

  const summary = dashboardResult.summary || {};
  const lines = [
    `# Hermes v1 eBay Market Intelligence Daily Report`,
    `날짜: ${date}`,
    '',
    '## 오늘 시장 요약',
    `- 경쟁 SKU: ${summary.total || 0}개`,
    `- 우리가 경쟁력 있음: ${summary.winning || 0}개`,
    `- 근접 경쟁: ${summary.competitive || 0}개`,
    `- 우리가 더 비쌈: ${summary.losing || 0}개`,
    `- 최근 ${hours}시간 market alerts: ${alerts.length}건`,
    '- Hermes v1: 가격 변경 없음, 추천/분석만 제공',
  ];

  section(lines, '가격 하락 TOP 10', priceDrops, a => `- ${a.sku || '-'} ${a.competitor_seller_id || '-'} ${money(a.old_price)} → ${money(a.new_price)}: ${escapeMd(a.recommendation || a.message)}`);
  section(lines, '가격 상승 TOP 10', priceRises, a => `- ${a.sku || '-'} ${a.competitor_seller_id || '-'} ${money(a.old_price)} → ${money(a.new_price)}: ${escapeMd(a.recommendation || a.message)}`);
  section(lines, '품절/재입고 상품', stockAlerts, a => `- ${a.alert_type} ${a.sku || '-'} ${a.competitor_seller_id || '-'}: ${escapeMd(a.message)}`);
  section(lines, '신규 경쟁상품', newComp, a => `- ${a.sku || '미매핑'} ${a.competitor_seller_id || '-'}: ${escapeMd(truncate(a.title || a.message, 100))}`);
  section(lines, '내가 더 비싼 SKU', losing.slice(0, 10), i => `- ${i.sku}: 내 ${money(i.ourTotal)} / 최저경쟁 ${money(i.lowestTotal)} / 차이 ${money(i.priceDiff)} — 즉시 인하 금지, 마진 확인`);
  section(lines, '내가 더 싼데도 안 팔리는 SKU', winning.slice(0, 10), i => `- ${i.sku}: 내 ${money(i.ourTotal)} / 최저경쟁 ${money(i.lowestTotal)} — 가격보다 리스팅 품질/이미지/타이틀 점검 후보`, '판매 데이터 미연동 또는 후보 없음');
  section(lines, '가격 유지 추천 SKU', keep.slice(0, 10), i => `- ${i.sku}: ${i.priceStatus}, 내 ${money(i.ourTotal)} / 최저경쟁 ${money(i.lowestTotal)} — 유지 권장`);
  section(lines, '가격 변경 금지 SKU', doNotChange.slice(0, 10), a => `- ${a.sku || '-'}: ${escapeMd(a.recommendation || a.message)}`);

  const markdown = lines.join('\n');
  const report = {
    report_date: date,
    report_type: 'ebay_market_intelligence',
    title: `Hermes v1 eBay Market Intelligence — ${date}`,
    summary: `alerts=${alerts.length}, losing=${summary.losing || 0}, winning=${summary.winning || 0}`,
    markdown,
    data: {
      summary,
      alertCount: alerts.length,
      priceDrops: priceDrops.length,
      priceRises: priceRises.length,
      stockAlerts: stockAlerts.length,
      newListings: newComp.length,
      generatedAt: nowIso(),
    },
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
      console.warn('[MarketIntel] daily_reports 저장 실패:', e.message);
    }
  }

  return report;
}

async function sendDailyReportToTelegram(report) {
  if (!telegram.isConfigured()) return null;
  const chunks = [];
  const text = report.markdown || '';
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  let first = null;
  for (let i = 0; i < chunks.length; i++) {
    const sent = await telegram.sendMessage(chunks[i], { parseMode: null });
    if (i === 0) first = sent;
    await new Promise(r => setTimeout(r, 300));
  }

  if (report.id) {
    const db = getClient();
    await db.from('daily_reports').update({ sent_to_telegram: true }).eq('id', report.id).catch(() => {});
  }
  return first;
}

async function getMarketAlertDetail(shortId) {
  const rows = await safeSelect('market_alerts', '*', q => q.ilike('id', `${shortId}%`).limit(1));
  return rows[0] || null;
}

async function runDailyReport({ sendTelegram = false, hours = 24 } = {}) {
  const alertResult = await generateMarketAlerts({ hours, sendTelegram: false });
  const report = await buildDailyReport({ hours, save: true });
  if (sendTelegram) await sendDailyReportToTelegram(report);
  return { alertResult, report };
}

module.exports = {
  syncMyListingsSnapshot,
  syncSkuMappingsFromProductMatches,
  recordPriceSnapshot,
  recordMarketAlert,
  sendMarketAlertToTelegram,
  generateMarketAlerts,
  buildDailyReport,
  sendDailyReportToTelegram,
  getMarketAlertDetail,
  runDailyReport,
};
