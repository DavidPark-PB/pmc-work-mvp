'use strict';

/**
 * Competitor Auto-Mapper
 *
 * target_sellers 테이블의 셀러 ID를 기반으로:
 * 1. eBay Browse API로 해당 셀러의 전체 리스팅 수집
 * 2. 내 ebay_products와 타이틀 유사도로 자동 매핑
 * 3. 확실한 건(유사도 80%+) → competitor_prices에 바로 등록
 * 4. 애매한 건(50~80%) → 텔레그램 "같은 상품이야?" 버튼
 * 5. 이미 등록된 건 스킵
 *
 * 실행: 크론(매일 새벽 1시) 또는 수동(POST /api/competitors/auto-map)
 */

const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');
const EbayAPI = require('../api/ebayAPI');

// 유사도 임계값
const AUTO_MAP_THRESHOLD = 0.75;   // 75% 이상 → 자동 등록
const ASK_THRESHOLD = 0.45;        // 45% 이상 → 텔레그램 확인 요청
const MAX_ASK_PER_RUN = 10;        // 한 번에 최대 10개까지 물어봄

/**
 * 타이틀 유사도 계산 (단어 집합 기반 Jaccard similarity)
 * - 양쪽 타이틀의 단어를 토크나이징
 * - 겹치는 단어 수 / 합집합 단어 수
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const tokenize = str => new Set(
    str.toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)  // 1글자 단어 제외
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 상품코드 추출 (OPK-12, sv2a, BT07, MEGA M5, PAC1-KR 등). 카드류에 유효.
 */
function extractCodes(title) {
  if (!title) return new Set();
  const found = new Set();
  const pats = [
    /\b[A-Za-z]{2,5}-?\d{1,4}[A-Za-z]{0,3}(?:-[A-Za-z]{2})?\b/g, // OPK-12, BT07, PAC1-KR
    /\bsv\d+[a-z]?\b/gi,                                          // sv2a
  ];
  for (const p of pats) {
    for (const m of (title.match(p) || [])) {
      const c = m.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (c.length >= 3 && !['2023', '2024', '2025', '2026', '2022'].includes(c)) found.add(c);
    }
  }
  return found;
}

/** 공유 토큰 수 (2글자 초과 단어 기준) */
function sharedTokenCount(a, b) {
  const tok = s => new Set(
    (s || '').toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );
  const A = tok(a), B = tok(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n;
}

const MIN_SHARED_TOKENS = 4;   // 제목에서 4개 이상 단어 일치 → 후보(카드 외 상품용)
const PRICE_RATIO_LOW = 0.4;   // 이중잠금: 내총액/경쟁총액 이 밴드를 벗어나면
const PRICE_RATIO_HIGH = 2.5;  //   같은 상품이라도 형태(단품 vs 박스) 의심 → 자동 대신 확인

/**
 * 셀러 리스팅과 내 상품 매핑 (이중잠금: 코드/제목 1차 + 가격 2차 확인)
 * @param {Array} sellerItems - [{itemId, title, price, shipping, seller}]
 * @param {Array} myProducts  - [{sku, item_id, title, price_usd, shipping_usd}]
 * @returns {Array} matches   - [{sellerItem, myProduct, score, action, basis}]
 */
function matchListings(sellerItems, myProducts) {
  const matches = [];

  for (const sellerItem of sellerItems) {
    const compCodes = extractCodes(sellerItem.title);
    let best = null; // { mine, score, shared, codeHit }

    for (const mine of myProducts) {
      const jac = titleSimilarity(sellerItem.title, mine.title);
      const shared = sharedTokenCount(sellerItem.title, mine.title);
      const codeHit = [...compCodes].some(c => extractCodes(mine.title).has(c) && c.length >= 4);
      // 1차 락: 코드 일치 OR (제목 4단어+ 일치) OR 높은 Jaccard
      const passes1 = codeHit || shared >= MIN_SHARED_TOKENS || jac >= AUTO_MAP_THRESHOLD;
      if (!passes1) continue;
      const score = (codeHit ? 0.5 : 0) + jac + shared * 0.02;
      if (!best || score > best.score) best = { mine, score, shared, jac, codeHit };
    }

    if (!best) continue;

    // 2차 락(가격 확인): 총액 비율이 상식 범위를 벗어나면 자동 매핑 금지 → 사람 확인
    const compTotal = (sellerItem.price || 0) + (sellerItem.shipping || 0);
    const myTotal = (best.mine.price_usd || 0) + (best.mine.shipping_usd || 0);
    const ratio = compTotal > 0 && myTotal > 0 ? myTotal / compTotal : 1;
    const priceOk = ratio >= PRICE_RATIO_LOW && ratio <= PRICE_RATIO_HIGH;

    // 자동 등록 조건: (코드 일치 또는 제목 강일치) AND 가격 이중잠금 통과
    const strong = best.codeHit || best.shared >= 5 || best.jac >= AUTO_MAP_THRESHOLD;
    const action = (strong && priceOk) ? 'auto' : 'ask';

    matches.push({
      sellerItem,
      myProduct: best.mine,
      score: +best.score.toFixed(3),
      action,
      basis: best.codeHit ? 'code' : `title:${best.shared}단어`,
      priceOk,
    });
  }

  return matches;
}

/**
 * competitor_prices에 이미 등록된 (sku, competitor_id) 쌍 조회
 */
async function loadExistingMappings() {
  const db = getClient();
  const { data } = await db
    .from('competitor_prices')
    .select('sku, competitor_id');
  const set = new Set();
  (data || []).forEach(r => set.add(`${r.sku}::${r.competitor_id}`));
  return set;
}

/**
 * competitor_prices에 매핑 등록
 */
async function registerMapping(myProduct, sellerItem, score) {
  const db = getClient();
  const { error } = await db.from('competitor_prices').insert({
    sku: myProduct.sku || myProduct.item_id,
    platform: 'ebay',
    competitor_id: sellerItem.itemId,
    competitor_price: sellerItem.price,
    competitor_shipping: sellerItem.shipping,
    competitor_url: `https://www.ebay.com/itm/${sellerItem.itemId}`,
    seller_id: sellerItem.seller,
    title: sellerItem.title,
    status: 'active',
  });
  if (error) {
    // 중복 키 에러면 무시
    if (!error.message?.includes('duplicate') && !error.message?.includes('unique')) {
      console.warn('[AutoMapper] insert error:', error.message);
    }
    return false;
  }
  return true;
}

/**
 * 텔레그램으로 매핑 확인 요청
 * callback_data: "map:yes:myItemId:compItemId:seller" / "map:no:myItemId:compItemId"
 */
async function askTelegram(match) {
  if (!telegram.isConfigured()) return;

  const { sellerItem, myProduct, score } = match;
  const myId = myProduct.sku || myProduct.item_id;
  const compId = sellerItem.itemId;

  const text = [
    `❓ 같은 상품인가요? (유사도 ${(score * 100).toFixed(0)}%)`,
    ``,
    `[내 상품] ${myProduct.title?.slice(0, 80)}`,
    `$${myProduct.price_usd}`,
    ``,
    `[경쟁사 ${sellerItem.seller}] ${sellerItem.title?.slice(0, 80)}`,
    `$${sellerItem.price} + 배송 $${sellerItem.shipping}`,
    `https://www.ebay.com/itm/${compId}`,
  ].join('\n');

  const myIdShort = String(myId).slice(0, 15);
  const compIdShort = String(compId).slice(0, 15);
  const sellerShort = String(sellerItem.seller).slice(0, 10);

  await telegram.sendWithButtons(text, [[
    { text: '✅ 같은 상품', callback_data: `map:yes:${myIdShort}:${compIdShort}:${sellerShort}` },
    { text: '❌ 다른 상품', callback_data: `map:no:${myIdShort}:${compIdShort}` },
  ]], { parseMode: null });
}

/**
 * 메인 실행 함수
 * @param {object} opts
 * @param {string[]} opts.sellerIds - 특정 셀러만 처리 (없으면 target_sellers 전체)
 * @param {boolean}  opts.silent    - 텔레그램 알림 없음
 */
async function runAutoMapper({ sellerIds, silent = false } = {}) {
  const db = getClient();
  console.log('[AutoMapper] Starting...');

  // 1. 대상 셀러 로드
  let sellers = [];
  if (sellerIds && sellerIds.length > 0) {
    sellers = sellerIds.map(id => ({ seller_name: id }));
  } else {
    const { data } = await db.from('target_sellers').select('seller_name, tier').order('created_at');
    sellers = data || [];
  }

  if (sellers.length === 0) {
    console.log('[AutoMapper] target_sellers 없음');
    return { mapped: 0, asked: 0, skipped: 0 };
  }

  // 2. 내 eBay 상품 전체 로드
  let myProducts = [];
  let from = 0;
  while (true) {
    const { data } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd')
      .neq('status', 'ended')
      .gt('price_usd', 0)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    myProducts = myProducts.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[AutoMapper] 내 상품: ${myProducts.length}개`);

  // 3. 기존 매핑 로드 (중복 방지)
  const existing = await loadExistingMappings();
  console.log(`[AutoMapper] 기존 매핑: ${existing.size}개`);

  const ebay = new EbayAPI();
  let totalMapped = 0;
  let totalAsked = 0;
  let totalSkipped = 0;
  const toAsk = [];

  // 4. 셀러별 처리
  for (const seller of sellers) {
    const sellerName = seller.seller_name;
    console.log(`[AutoMapper] 셀러 처리: ${sellerName}`);

    let sellerItems = [];
    try {
      sellerItems = await ebay.findSellerListings(sellerName, 5);
    } catch (e) {
      console.error(`[AutoMapper] ${sellerName} 리스팅 수집 실패:`, e.message);
      continue;
    }

    if (sellerItems.length === 0) {
      console.log(`[AutoMapper] ${sellerName}: 리스팅 없음`);
      continue;
    }

    // 이미 등록된 건 제외
    const newItems = sellerItems.filter(item =>
      !existing.has(`${item.itemId}::${item.itemId}`) // competitor_id 기준
    );

    // 매핑 계산
    const matches = matchListings(newItems, myProducts);
    console.log(`[AutoMapper] ${sellerName}: ${sellerItems.length}개 수집, ${matches.length}개 매핑 후보`);

    for (const match of matches) {
      const myId = match.myProduct.sku || match.myProduct.item_id;
      const key = `${myId}::${match.sellerItem.itemId}`;

      if (existing.has(key)) { totalSkipped++; continue; }

      if (match.action === 'auto') {
        const ok = await registerMapping(match.myProduct, match.sellerItem, match.score);
        if (ok) {
          existing.add(key);
          totalMapped++;
          console.log(`[AutoMapper] 자동 매핑: ${myId} ↔ ${match.sellerItem.itemId} (${(match.score*100).toFixed(0)}%)`);
        }
      } else {
        toAsk.push(match);
      }
    }

    // eBay rate limit
    await new Promise(r => setTimeout(r, 1500));
  }

  // 5. 텔레그램 확인 요청 (최대 MAX_ASK_PER_RUN개)
  if (!silent && toAsk.length > 0) {
    const batch = toAsk.slice(0, MAX_ASK_PER_RUN);
    console.log(`[AutoMapper] 텔레그램 확인 요청: ${batch.length}개`);

    if (telegram.isConfigured()) {
      await telegram.sendMessage(
        `🔍 경쟁셀러 매핑 확인 요청 ${batch.length}건\n자동 매핑 완료: ${totalMapped}건`
      );
      for (const match of batch) {
        await askTelegram(match);
        totalAsked++;
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }

  const result = { mapped: totalMapped, asked: totalAsked, skipped: totalSkipped, sellers: sellers.length };
  console.log('[AutoMapper] Done:', JSON.stringify(result));
  return result;
}

module.exports = { runAutoMapper, titleSimilarity, matchListings };
