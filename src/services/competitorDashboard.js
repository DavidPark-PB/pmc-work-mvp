'use strict';

/**
 * Competitor Dashboard Service
 *
 * getDashboard  - 경쟁가 대시보드 집계 데이터 반환
 * getPriceHistory - 특정 상품의 가격 이력 반환
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const { getClient } = require('../db/supabaseClient');

/**
 * 경쟁가 대시보드 데이터 생성
 *
 * @param {object} opts
 * @param {number} opts.limit        - 반환할 SKU 최대 개수 (기본 100)
 * @param {boolean} opts.onlyCompeted - 경쟁 상품이 있는 SKU만 반환 (기본 true)
 * @returns {{ items: object[], summary: object }}
 */
async function getDashboard({ limit = 100, onlyCompeted = true } = {}) {
  const db = getClient();

  // 1. product_matches WHERE status='approved' 로드
  const { data: matches, error: matchErr } = await db
    .from('product_matches')
    .select('our_sku, competitor_item_id, seller_id')
    .eq('status', 'approved');

  if (matchErr) throw new Error(`product_matches 조회 실패: ${matchErr.message}`);
  if (!matches || matches.length === 0) {
    return {
      items: [],
      summary: { total: 0, winning: 0, competitive: 0, losing: 0, avgPriceDiff: 0 },
    };
  }

  // 2. 승인된 매핑에서 our_sku 목록 추출
  const skuSet = new Set(matches.map(m => m.our_sku).filter(Boolean));
  const skuList = [...skuSet];

  // 3. ebay_products에서 우리 상품 정보 로드 (price_usd, shipping_usd, title, sku)
  const { data: ourProducts, error: prodErr } = await db
    .from('ebay_products')
    .select('sku, title, price_usd, shipping_usd')
    .in('sku', skuList);

  if (prodErr) throw new Error(`ebay_products 조회 실패: ${prodErr.message}`);

  const ourProductMap = {};
  (ourProducts || []).forEach(p => { ourProductMap[p.sku] = p; });

  // 4. competitor_listings에서 각 competitor_item_id의 최신 가격 로드
  const itemIdList = [...new Set(matches.map(m => m.competitor_item_id).filter(Boolean))];

  let allListings = [];
  // Supabase .in() 은 한 번에 최대 ~1000개 안전하게 처리 가능
  const CHUNK = 500;
  for (let i = 0; i < itemIdList.length; i += CHUNK) {
    const chunk = itemIdList.slice(i, i + CHUNK);
    const { data: rows, error: listErr } = await db
      .from('competitor_listings')
      .select('ebay_item_id, seller_id, price, shipping, status, last_seen_at')
      .in('ebay_item_id', chunk)
      .order('last_seen_at', { ascending: false });

    if (listErr) throw new Error(`competitor_listings 조회 실패: ${listErr.message}`);
    if (rows) allListings = allListings.concat(rows);
  }

  // ebay_item_id → 가장 최근 listing 1개
  const listingMap = {};
  for (const row of allListings) {
    if (!listingMap[row.ebay_item_id]) {
      listingMap[row.ebay_item_id] = row;
    }
  }

  // 5. SKU별로 집계
  const skuMap = {}; // sku → { sku, ourTitle, ourPrice, ourShipping, ourTotal, competitors[] }

  for (const match of matches) {
    const { our_sku, competitor_item_id, seller_id } = match;
    if (!our_sku || !competitor_item_id) continue;

    const listing = listingMap[competitor_item_id];
    if (!listing) continue; // 리스팅 없으면 스킵

    if (!skuMap[our_sku]) {
      const prod = ourProductMap[our_sku] || {};
      const ourPrice = parseFloat(prod.price_usd) || 0;
      const ourShipping = parseFloat(prod.shipping_usd) ?? 3.9;
      skuMap[our_sku] = {
        sku: our_sku,
        ourTitle: prod.title || '',
        ourPrice,
        ourShipping: ourShipping || 3.9,
        ourTotal: +(ourPrice + (ourShipping || 3.9)).toFixed(2),
        competitors: [],
      };
    }

    const compPrice = parseFloat(listing.price) || 0;
    const compShipping = parseFloat(listing.shipping) || 0;
    const compTotal = +(compPrice + compShipping).toFixed(2);

    skuMap[our_sku].competitors.push({
      sellerId: seller_id || listing.seller_id || '',
      itemId: competitor_item_id,
      price: compPrice,
      shipping: compShipping,
      total: compTotal,
      status: listing.status || 'active',
    });
  }

  // 6. 집계 + priceStatus 계산
  const items = [];
  for (const entry of Object.values(skuMap)) {
    const { sku, ourTitle, ourPrice, ourShipping, ourTotal, competitors } = entry;

    if (competitors.length === 0) {
      if (onlyCompeted) continue;
      items.push({
        sku, ourTitle, ourPrice, ourShipping, ourTotal,
        competitors: [],
        lowestTotal: null, avgTotal: null, highestTotal: null,
        competitorCount: 0,
        ourRank: 1,
        priceDiff: 0,
        priceStatus: 'winning',
      });
      continue;
    }

    const totals = competitors.map(c => c.total).filter(t => t > 0);
    const lowestTotal = totals.length > 0 ? Math.min(...totals) : null;
    const highestTotal = totals.length > 0 ? Math.max(...totals) : null;
    const avgTotal = totals.length > 0
      ? +(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(2)
      : null;

    // ourRank: 우리 가격 순위 (1=최저)
    const allTotals = [ourTotal, ...totals].sort((a, b) => a - b);
    const ourRank = allTotals.indexOf(ourTotal) + 1;

    const priceDiff = lowestTotal !== null ? +(ourTotal - lowestTotal).toFixed(2) : 0;

    let priceStatus;
    if (lowestTotal === null || ourTotal <= lowestTotal + 0.50) {
      priceStatus = 'winning';
    } else if (ourTotal <= lowestTotal + 3.00) {
      priceStatus = 'competitive';
    } else {
      priceStatus = 'losing';
    }

    items.push({
      sku, ourTitle, ourPrice, ourShipping, ourTotal,
      competitors,
      lowestTotal,
      avgTotal,
      highestTotal,
      competitorCount: competitors.length,
      ourRank,
      priceDiff,
      priceStatus,
    });
  }

  // 7. losing 먼저, competitive, winning 순 정렬
  const statusOrder = { losing: 0, competitive: 1, winning: 2 };
  items.sort((a, b) => {
    const diff = (statusOrder[a.priceStatus] ?? 3) - (statusOrder[b.priceStatus] ?? 3);
    if (diff !== 0) return diff;
    // 같은 그룹 내 priceDiff 내림차순 (더 비싼 것 먼저)
    return b.priceDiff - a.priceDiff;
  });

  // limit 적용
  const sliced = items.slice(0, limit);

  // 8. summary
  const winning = items.filter(i => i.priceStatus === 'winning').length;
  const competitive = items.filter(i => i.priceStatus === 'competitive').length;
  const losing = items.filter(i => i.priceStatus === 'losing').length;
  const priceDiffs = items.map(i => i.priceDiff).filter(d => !isNaN(d));
  const avgPriceDiff = priceDiffs.length > 0
    ? +(priceDiffs.reduce((a, b) => a + b, 0) / priceDiffs.length).toFixed(2)
    : 0;

  return {
    items: sliced,
    summary: {
      total: items.length,
      winning,
      competitive,
      losing,
      avgPriceDiff,
    },
  };
}

/**
 * 특정 상품의 가격 이력 반환
 *
 * @param {string} ebayItemId
 * @param {number} limit  최대 건수 (기본 100)
 * @returns {object[]}
 */
async function getPriceHistory(ebayItemId, limit = 100) {
  const db = getClient();

  const { data, error } = await db
    .from('competitor_price_history')
    .select('*')
    .eq('ebay_item_id', ebayItemId)
    .order('changed_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`competitor_price_history 조회 실패: ${error.message}`);
  return data || [];
}

module.exports = { getDashboard, getPriceHistory };
