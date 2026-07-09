/**
 * killPricingDailyJob.js — 매일 09:00 (Asia/Seoul) 킬프라이스 + 소싱기회 데일리 잡
 * ---------------------------------------------------------------------------
 * 하는 일:
 *  1) 워치리스트(competitor_prices 중 sku 매핑된 항목)의 경쟁사 가격+배송비를
 *     eBay에서 라이브 조회 → 총액(상품가+배송비) 기준으로 내 총액과 비교
 *  2) 킬프라이스 = 경쟁 총액 − UNDERCUT($1). 조치 판정:
 *       - lower : 내 총액이 킬프라이스보다 비쌈 → 인하 권장
 *       - raise : 내가 경쟁가보다 RAISE_PCT 이상 저가 → 인상 권장(마진 회복)
 *       - hold  : 적정
 *       - review: 가격차가 비상식적(형태 불일치 의심) → 사람이 확인
 *  3) 소싱기회: 미매핑 경쟁사 리스팅 중 판매수 높은 것(내가 안 파는데 잘 팔림)
 *  4) 텔레그램 푸시 — 인하 권장은 승인/거부 버튼(reprice:approve:sku:itemId:newPrice)
 *  5) 소싱기회를 opportunity_inbox에 저장 (WRITE_OPPORTUNITIES 플래그로 제어)
 *
 * 안전장치: 이 잡은 가격을 직접 바꾸지 않는다(추천만). 실제 적용은 텔레그램
 * 승인 버튼 → 기존 reprice:approve 핸들러 경로를 따른다.
 */

const { getClient } = require('../db/supabaseClient');
const telegram = require('../services/telegramBot');
const EbayAPI = require('../api/ebayAPI');

const CONFIG = {
  UNDERCUT: 1.0,          // 킬프라이스 = 경쟁 총액 - 이 값
  RAISE_PCT: 0.05,        // 경쟁가보다 5% 이상 싸면 인상 권장
  RATIO_LOW: 0.4,         // 내총액/경쟁총액 이 미만 → 형태 불일치 의심(검토)
  RATIO_HIGH: 2.5,        // 이 초과 → 검토
  SOURCING_MIN_SOLD: 50,  // 소싱기회로 볼 최소 판매수
  SOURCING_SCAN_CAP: 400, // 소싱 라이브조회 일일 상한(API 절약)
  REPORT_TOP: 12,         // 텔레그램에 버튼으로 띄울 인하 상위 건수
  WRITE_OPPORTUNITIES: true, // opportunity_inbox에 소싱기회 저장(전투상황판 소싱 섹션에서 사용)
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function decide(myTotal, compTotal, myShip) {
  const kill = r2(compTotal - CONFIG.UNDERCUT);
  const newPrice = r2(kill - myShip); // 배송비 제외하고 실제 걸 상품가
  const ratio = compTotal ? myTotal / compTotal : 1;
  if (ratio < CONFIG.RATIO_LOW || ratio > CONFIG.RATIO_HIGH) return { action: 'review', kill, newPrice };
  if (myTotal > kill) return { action: 'lower', kill, newPrice };
  if (myTotal < compTotal * (1 - CONFIG.RAISE_PCT)) return { action: 'raise', kill, newPrice };
  return { action: 'hold', kill, newPrice };
}

/** 내 eBay 현재가/배송비 (shipping_usd 없으면 0으로 폴백) */
async function fetchMyPrices(db, skus) {
  const map = new Map();
  if (!skus.length) return map;
  let res = await db.from('ebay_products')
    .select('sku, item_id, price_usd, shipping_usd').in('sku', skus);
  if (res.error) {
    res = await db.from('ebay_products').select('sku, item_id, price_usd').in('sku', skus);
  }
  (res.data || []).forEach((m) => {
    map.set(m.sku, {
      itemId: m.item_id,
      price: Number(m.price_usd) || 0,
      ship: Number(m.shipping_usd) || 0,
    });
  });
  return map;
}

/** 워치리스트 킬프라이스 계산 */
async function computeKillPrices(db, ebay) {
  const { data: watch, error } = await db.from('competitor_prices')
    .select('id, sku, competitor_id, competitor_price, competitor_shipping, seller_id, title, status')
    .not('competitor_id', 'is', null)
    .not('sku', 'is', null);
  if (error) { console.error('[killPricing] competitor_prices 로드 실패:', error.message); return []; }
  if (!watch || !watch.length) return [];

  const watchIds = [...new Set(watch.map((w) => String(w.competitor_id)))];
  let live = new Map();
  try {
    const arr = await ebay.getCompetitorItems(watchIds);
    live = new Map(arr.map((l) => [String(l.itemId), l]));
  } catch (e) {
    console.warn('[killPricing] 라이브 조회 실패, DB 캐시가로 대체:', e.message);
  }

  const skus = [...new Set(watch.map((w) => w.sku))];
  const myMap = await fetchMyPrices(db, skus);

  const recs = [];
  for (const w of watch) {
    const l = live.get(String(w.competitor_id));
    const compPrice = l ? l.price : Number(w.competitor_price) || 0;
    const compShip = l ? (l.shippingCost || 0) : Number(w.competitor_shipping) || 0;
    if (compPrice <= 0) continue;
    const my = myMap.get(w.sku);
    if (!my || my.price <= 0) continue;

    const compTotal = r2(compPrice + compShip);
    const myTotal = r2(my.price + my.ship);
    const { action, kill, newPrice } = decide(myTotal, compTotal, my.ship);
    recs.push({
      sku: w.sku,
      myItemId: my.itemId,
      compItemId: String(w.competitor_id),
      title: (w.title || (l && l.title) || w.sku).slice(0, 80),
      compTotal, myTotal, kill, newPrice, action,
      sold: l ? (l.quantitySold || 0) : 0,
      url: (l && l.viewItemURL) || '',
    });
  }
  return recs;
}

/** 소싱기회: 미매핑 경쟁사 리스팅 중 판매수 높은 것 */
async function detectSourcing(db, ebay) {
  const { data: mapped } = await db.from('competitor_prices')
    .select('competitor_id').not('sku', 'is', null);
  const mappedSet = new Set((mapped || []).map((m) => String(m.competitor_id)));

  const { data: listings } = await db.from('competitor_listings')
    .select('ebay_item_id, title, price, shipping, url, status')
    .eq('status', 'active')
    .limit(CONFIG.SOURCING_SCAN_CAP);

  const ids = [...new Set((listings || [])
    .map((l) => String(l.ebay_item_id))
    .filter((id) => !mappedSet.has(id)))].slice(0, CONFIG.SOURCING_SCAN_CAP);
  if (!ids.length) return [];

  let liveArr = [];
  try { liveArr = await ebay.getCompetitorItems(ids); }
  catch (e) { console.warn('[killPricing] 소싱 라이브 조회 실패:', e.message); return []; }

  const out = [];
  for (const l of liveArr) {
    if ((l.quantitySold || 0) >= CONFIG.SOURCING_MIN_SOLD) {
      out.push({
        compItemId: String(l.itemId),
        title: (l.title || '').slice(0, 120),
        sold: l.quantitySold || 0,
        price: r2(l.price),
        ship: r2(l.shippingCost || 0),
        total: r2(l.price + (l.shippingCost || 0)),
        seller: l.seller || '',
        url: l.viewItemURL || '',
      });
    }
  }
  out.sort((a, b) => b.sold - a.sold);
  return out.slice(0, CONFIG.REPORT_TOP);
}

/** 소싱기회를 opportunity_inbox에 저장 (중복 방지) */
async function saveSourcingOpportunities(db, sourcing) {
  if (!CONFIG.WRITE_OPPORTUNITIES) {
    console.log(`[killPricing] (dry) 소싱기회 ${sourcing.length}건 — 저장 생략(WRITE_OPPORTUNITIES=false)`);
    return 0;
  }
  const oppInbox = require('../services/opportunityInbox');
  const { getAdminIds } = require('../services/notificationService');
  const adminIds = await getAdminIds();
  const user = { id: (adminIds && adminIds[0]) || 1, role: 'admin' };

  let saved = 0;
  for (const s of sourcing) {
    try {
      // 중복 방지: 같은 경쟁사 아이템으로 최근 생성된 기회가 있으면 skip
      const { data: dup } = await db.from('opportunity_inbox')
        .select('id').contains('metadata', { comp_item_id: s.compItemId }).limit(1);
      if (dup && dup.length) continue;

      await oppInbox.createOpportunity({
        user,
        body: {
          opportunity_type: 'product_sourcing',
          source_type: 'competitor',
          input_channel: 'api',
          priority: s.sold >= 200 ? 'high' : 'normal',
          title: `[소싱] ${s.title} — ${s.sold} sold @ $${s.total}`,
          notes: `경쟁사(${s.seller}) 판매 ${s.sold}개, 총액 $${s.total}. 내가 미판매 상품. ${s.url}`,
          metadata: {
            comp_item_id: s.compItemId,
            sold: s.sold,
            price: s.price,
            shipping: s.ship,
            total: s.total,
            seller: s.seller,
            url: s.url,
            source: 'killPricingDailyJob',
          },
        },
      });
      saved += 1;
    } catch (e) {
      console.warn(`[killPricing] 소싱기회 저장 실패(${s.compItemId}):`, e.message);
    }
  }
  return saved;
}

/** 텔레그램 푸시 (인하=승인버튼, 인상/소싱=요약) */
async function pushTelegram(recs, sourcing) {
  const lowers = recs.filter((r) => r.action === 'lower').sort((a, b) => b.compTotal - a.compTotal);
  const raises = recs.filter((r) => r.action === 'raise').sort((a, b) => (b.kill - b.myTotal) - (a.kill - a.myTotal));
  const reviews = recs.filter((r) => r.action === 'review');

  const header = [
    '🎯 *킬프라이스 데일리* (총액=상품가+배송비 기준)',
    `매칭 ${recs.length} · 🔴인하 ${lowers.length} · 🔵인상 ${raises.length} · ⚪검토 ${reviews.length} · 🟡소싱 ${sourcing.length}`,
    '',
  ];
  if (raises.length) {
    header.push('*🔵 인상 여지 TOP*');
    raises.slice(0, 8).forEach((r) => {
      header.push(`• ${r.title} — 내 $${r.myTotal} → $${r.newPrice} (경쟁 $${r.compTotal})`);
    });
    header.push('');
  }
  if (sourcing.length) {
    header.push('*🟡 소싱기회(내가 없는데 잘 팔림)*');
    sourcing.slice(0, 8).forEach((s) => {
      header.push(`• ${s.sold} sold · $${s.total} — ${s.title}`);
    });
    header.push('');
  }
  header.push(lowers.length ? '아래 인하 권장 건을 승인/거부로 처리하세요 ↓' : '오늘 인하 권장 없음.');
  await telegram.sendMessage(header.join('\n'));

  // 인하 권장: 개별 메시지 + 승인/거부 버튼 (기존 reprice 콜백 재사용)
  for (const r of lowers.slice(0, CONFIG.REPORT_TOP)) {
    const text = [
      `🔴 *인하 권장* — ${r.title}`,
      `내 총액 $${r.myTotal}  vs  경쟁 총액 $${r.compTotal}`,
      `👉 상품가를 *$${r.newPrice}* 로 (킬프라이스, 경쟁−$${CONFIG.UNDERCUT})`,
      r.sold ? `경쟁사 판매 ${r.sold}개` : '',
    ].filter(Boolean).join('\n');
    const keyboard = [[
      { text: `✅ $${r.newPrice}로 적용`, callback_data: `reprice:approve:${r.sku}:${r.myItemId}:${r.newPrice}` },
      { text: '❌ 거부', callback_data: `reprice:reject:${r.sku}:${r.myItemId}:${r.newPrice}` },
    ]];
    await telegram.sendWithButtons(text, keyboard);
  }
}

async function runKillPricingDaily(opts = {}) {
  const started = Date.now();
  try {
    const db = getClient();
    const ebay = new EbayAPI();

    const recs = await computeKillPrices(db, ebay);
    const sourcing = await detectSourcing(db, ebay);

    await pushTelegram(recs, sourcing);
    const saved = await saveSourcingOpportunities(db, sourcing);

    const summary = {
      matched: recs.length,
      lower: recs.filter((r) => r.action === 'lower').length,
      raise: recs.filter((r) => r.action === 'raise').length,
      review: recs.filter((r) => r.action === 'review').length,
      sourcing: sourcing.length,
      sourcingSaved: saved,
      ms: Date.now() - started,
    };
    console.log('[killPricing] 완료:', JSON.stringify(summary));
    return summary;
  } catch (e) {
    console.error('[killPricing] 잡 실패:', e.message);
    try { await telegram.sendMessage(`⚠️ 킬프라이스 데일리 잡 실패: ${e.message}`); } catch (_) {}
    return { error: e.message };
  }
}

/** 소싱기회만 즉시 스캔 + 저장 (UI '소싱 새로고침' 버튼용). 저장된 건수 반환. */
async function runSourcingScan() {
  const db = getClient();
  const ebay = new EbayAPI();
  const sourcing = await detectSourcing(db, ebay);
  const prev = CONFIG.WRITE_OPPORTUNITIES;
  CONFIG.WRITE_OPPORTUNITIES = true; // 수동 스캔은 항상 저장
  let saved = 0;
  try { saved = await saveSourcingOpportunities(db, sourcing); }
  finally { CONFIG.WRITE_OPPORTUNITIES = prev; }
  return { found: sourcing.length, saved, items: sourcing };
}

module.exports = {
  runKillPricingDaily, decide, CONFIG,
  computeKillPrices, detectSourcing, saveSourcingOpportunities, runSourcingScan,
};

// 단독 실행 지원: node src/jobs/killPricingDailyJob.js
if (require.main === module) {
  runKillPricingDaily().then(() => process.exit(0)).catch(() => process.exit(1));
}
