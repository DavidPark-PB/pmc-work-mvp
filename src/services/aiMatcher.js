'use strict';

/**
 * AI Matcher
 *
 * 최근 수집된 competitor_listings를 우리 ebay_products와 Claude AI로 매핑한다.
 *
 * 매핑 흐름:
 *   1. title_similarity(Jaccard) 로 상위 5개 후보 1차 필터 (>0.25)
 *   2. Claude claude-sonnet-4-5 에 JSON으로 최종 판단 요청
 *   3. confidence ≥ 0.95 → product_matches에 status='approved' 자동 저장
 *      confidence 0.45~0.95 → status='pending' + 텔레그램 승인 요청
 *      confidence < 0.45 → 스킵
 *
 * 실행: 크론(크롤러 직후) 또는 수동(POST /api/competitors/match)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });

const Anthropic = require('@anthropic-ai/sdk');
const { getClient } = require('../db/supabaseClient');
const telegram = require('./telegramBot');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_APPROVE_THRESHOLD = 0.95;  // 이상이면 자동 승인
const PENDING_THRESHOLD      = 0.45;  // 이상이면 pending (텔레그램 확인)
const SIM_FILTER_THRESHOLD   = 0.25;  // 1차 유사도 필터 컷오프
const TOP_CANDIDATES         = 5;     // AI에 넘길 최대 후보 수
const MAX_TELEGRAM_PER_RUN   = 10;    // 한 번에 텔레그램 요청 최대 건수
const CLAUDE_MODEL           = 'claude-sonnet-4-5';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// titleSimilarity — Jaccard similarity on word sets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 두 상품 제목의 단어 집합 기반 Jaccard 유사도를 계산한다.
 * 토크나이징: 소문자화, 특수문자 제거, 2글자 이상 단어만
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0;

  const tokenize = str => new Set(
    str.toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2)
  );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// matchWithAI — Claude API 매핑
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 경쟁 리스팅과 우리 상품 목록을 Claude에게 매핑 요청한다.
 *
 * @param {object} compListing  - competitor_listings 행
 *   { id, ebay_item_id, title, price, shipping, item_specifics, ... }
 * @param {object[]} ourProducts - ebay_products 행 배열
 *   [{ sku, item_id, title, price_usd }, ...]
 * @returns {object|null}
 *   { sku, is_same_product, confidence, reason, method } 또는 null
 */
async function matchWithAI(compListing, ourProducts) {
  // ── 1차 필터: title_similarity 상위 5개 (score > 0.25) ──────────────────
  const scored = ourProducts
    .map(p => ({
      ...p,
      _score: titleSimilarity(compListing.title, p.title),
    }))
    .filter(p => p._score > SIM_FILTER_THRESHOLD)
    .sort((a, b) => b._score - a._score)
    .slice(0, TOP_CANDIDATES);

  if (scored.length === 0) return null;

  // ── Claude API 호출 ────────────────────────────────────────────────────────
  const candidates = scored.map((p, i) => ({
    sku:   p.sku || p.item_id,
    title: p.title,
    price: p.price_usd,
    rank:  i + 1,
  }));

  const userContent = JSON.stringify({
    competitor: {
      title:         compListing.title,
      price:         compListing.price,
      shipping:      compListing.shipping,
      itemSpecifics: compListing.item_specifics ?? {},
    },
    candidates,
  }, null, 2);

  const userPrompt =
    'Compare the competitor listing with our product candidates and determine which (if any) is the same product.\n\n' +
    userContent +
    '\n\nReturn a JSON array (one object per candidate):\n' +
    '[{"sku":"...","is_same_product":true/false,"confidence":0.0-1.0,"reason":"..."}]';

  try {
    const response = await client.messages.create({
      model:      CLAUDE_MODEL,
      max_tokens: 500,
      temperature: 0,
      system: 'You are a product matching expert for Korean goods sold on eBay. ' +
              'Compare competitor listings with our products and determine if they are the same product.',
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content?.[0]?.text ?? '';

    // JSON 파싱 — Claude 가 마크다운 코드블록으로 감쌀 수도 있으니 strip
    const jsonStr = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(jsonStr);

    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // 가장 confidence 높은 항목 반환
    const best = parsed
      .filter(r => r.is_same_product === true)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!best) return null;

    return { ...best, method: 'ai' };

  } catch (e) {
    console.warn('[Matcher] Claude API 실패, title_similarity fallback:', e.message);

    // fallback: 최고 유사도 항목
    const top = scored[0];
    if (!top) return null;
    return {
      sku:             top.sku || top.item_id,
      is_same_product: top._score >= PENDING_THRESHOLD,
      confidence:      +top._score.toFixed(4),
      reason:          `title_similarity fallback (score=${top._score.toFixed(3)})`,
      method:          'title_sim',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runMatcher — 전체 매처 실행
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 최근 수집된 competitor_listings를 ebay_products와 AI로 매핑한다.
 *
 * @param {object} opts
 * @param {number}  [opts.hours=25]   - 최근 N시간 이내 수집된 리스팅만 처리
 * @param {boolean} [opts.silent]     - 텔레그램 알림 억제
 * @param {boolean} [opts.dryRun]     - DB 쓰기 없이 결과만 확인
 * @returns {{ processed, autoApproved, pending, skipped, errors }}
 */
async function runMatcher({ hours = 25, silent = false, dryRun = false } = {}) {
  const db = getClient();
  console.log(`[Matcher] ===== AI 매처 시작 (hours=${hours}, dryRun=${dryRun}) =====`);

  // ── 1. 최근 N시간 competitor_listings 로드 (미매핑 건만) ─────────────────
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data: listings, error: listErr } = await db
    .from('competitor_listings')
    .select('id, seller_id, ebay_item_id, title, price, shipping, item_specifics')
    .gte('last_seen', since)
    // product_matches에 already 처리된 건 제외
    .not('ebay_item_id', 'in', `(
      SELECT comp_item_id FROM product_matches WHERE our_sku IS NOT NULL
    )`);

  // 위 서브쿼리가 지원 안 되면 아래 fallback 사용
  // .not('id', 'in', subquery...)
  // — Supabase PostgREST 는 서브쿼리를 지원하지 않으므로, 두 단계 쿼리 사용

  let unmatched = listings || [];

  if (listErr) {
    // 서브쿼리 지원 안 되는 경우 두 단계로 fallback
    console.warn('[Matcher] 복합 쿼리 실패, 두 단계 쿼리 사용:', listErr.message);

    const { data: allListings } = await db
      .from('competitor_listings')
      .select('id, seller_id, ebay_item_id, title, price, shipping, item_specifics')
      .gte('last_seen', since);

    const { data: matchedRows } = await db
      .from('product_matches')
      .select('comp_item_id')
      .not('our_sku', 'is', null);

    const matchedSet = new Set((matchedRows || []).map(r => r.comp_item_id));
    unmatched = (allListings || []).filter(l => !matchedSet.has(l.ebay_item_id));
  }

  console.log(`[Matcher] 처리 대상 리스팅: ${unmatched.length}개`);

  if (unmatched.length === 0) {
    return { processed: 0, autoApproved: 0, pending: 0, skipped: 0, errors: 0 };
  }

  // ── 2. 우리 ebay_products 전체 로드 ───────────────────────────────────────
  let ourProducts = [];
  let from = 0;
  while (true) {
    const { data } = await db
      .from('ebay_products')
      .select('sku, item_id, title, price_usd')
      .neq('status', 'ended')
      .gt('price_usd', 0)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    ourProducts = ourProducts.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[Matcher] 우리 상품: ${ourProducts.length}개`);

  if (ourProducts.length === 0) {
    console.warn('[Matcher] ebay_products 없음 — 종료');
    return { processed: 0, autoApproved: 0, pending: 0, skipped: 0, errors: 0 };
  }

  // ── 3. 리스팅별 matchWithAI ───────────────────────────────────────────────
  let autoApproved = 0;
  let pending      = 0;
  let skipped      = 0;
  let errors       = 0;
  const pendingRows = [];   // 텔레그램 승인 요청 대기 목록

  for (const listing of unmatched) {
    let matchResult;
    try {
      matchResult = await matchWithAI(listing, ourProducts);
    } catch (e) {
      console.error(`[Matcher] matchWithAI 예외 (id=${listing.id}):`, e.message);
      errors++;
      continue;
    }

    if (!matchResult || !matchResult.is_same_product) {
      skipped++;
      continue;
    }

    const { sku, confidence, reason, method } = matchResult;

    if (confidence < PENDING_THRESHOLD) {
      skipped++;
      continue;
    }

    // ── 4. product_matches 저장 ─────────────────────────────────────────────
    const status = confidence >= AUTO_APPROVE_THRESHOLD ? 'approved' : 'pending';
    const matchRow = {
      our_sku:      sku,
      comp_item_id: listing.ebay_item_id,
      seller_id:    listing.seller_id,
      confidence:   +confidence.toFixed(4),
      reason:       reason ?? '',
      match_method: method ?? 'ai',
      status,
      created_at:   new Date().toISOString(),
    };

    if (!dryRun) {
      const { data: inserted, error: insErr } = await db
        .from('product_matches')
        .insert(matchRow)
        .select('id')
        .maybeSingle();

      if (insErr) {
        // 중복이면 무시, 그 외는 기록
        if (!insErr.message?.includes('duplicate') && !insErr.message?.includes('unique')) {
          console.warn(`[Matcher] insert 실패 (id=${listing.id}):`, insErr.message);
          errors++;
        } else {
          skipped++;
        }
        continue;
      }

      if (status === 'approved') {
        autoApproved++;
        console.log(`[Matcher] 자동 승인: ${sku} ↔ ${listing.ebay_item_id} (${(confidence * 100).toFixed(0)}%)`);
      } else {
        // pending 행 기록 (텔레그램 발송용)
        pendingRows.push({ ...listing, matchRow, matchId: inserted?.id });
        pending++;
      }
    } else {
      // dryRun: 카운트만
      if (status === 'approved') autoApproved++;
      else { pending++; pendingRows.push({ ...listing, matchRow, matchId: `dry-${listing.id}` }); }
      console.log(`[Matcher][dryRun] ${status}: ${sku} ↔ ${listing.ebay_item_id} (${(confidence * 100).toFixed(0)}%)`);
    }

    // Claude rate limit 방어 (0.5초)
    await sleep(500);
  }

  // ── 5. Pending 건 텔레그램 승인 요청 ──────────────────────────────────────
  if (!silent && pendingRows.length > 0 && telegram.isConfigured()) {
    const batch = pendingRows.slice(0, MAX_TELEGRAM_PER_RUN);
    console.log(`[Matcher] 텔레그램 승인 요청: ${batch.length}건`);

    await telegram.sendMessage(
      `🔍 *경쟁상품 매핑 승인 요청* ${batch.length}건\n자동 승인 완료: ${autoApproved}건`
    );

    for (const row of batch) {
      const { matchId, matchRow } = row;
      // UUID 앞 8자만 callback_data에 사용
      const shortId = matchId ? String(matchId).slice(0, 8) : 'unknown';

      const ourProd = ourProducts.find(p => (p.sku || p.item_id) === matchRow.our_sku);
      const ourTitle = ourProd?.title ?? matchRow.our_sku;

      const text = [
        `❓ *같은 상품인가요?* (신뢰도 ${(matchRow.confidence * 100).toFixed(0)}%)`,
        ``,
        `📦 *경쟁상품*`,
        `  제목: ${row.title?.slice(0, 80)}`,
        `  가격: $${row.price} + 배송 $${row.shipping}`,
        ``,
        `🏷 *우리 상품*`,
        `  제목: ${ourTitle?.slice(0, 80)}`,
        `  매핑 방법: ${matchRow.match_method}`,
      ].join('\n');

      await telegram.sendWithButtons(text, [[
        { text: '✅ 같은 상품', callback_data: `map:yes:${shortId}` },
        { text: '❌ 다른 상품', callback_data: `map:no:${shortId}` },
      ]], { parseMode: 'Markdown' });

      await sleep(400);
    }
  }

  const summary = {
    processed:    unmatched.length,
    autoApproved,
    pending,
    skipped,
    errors,
  };

  console.log('[Matcher] ===== 완료 =====', JSON.stringify(summary));
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { runMatcher, matchWithAI, titleSimilarity };
