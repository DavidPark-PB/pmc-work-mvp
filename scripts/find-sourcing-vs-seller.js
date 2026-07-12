'use strict';

/**
 * find-sourcing-vs-seller.js — 특정 셀러는 팔지만 내가 아직 리스팅 안 한 상품 목록.
 *
 * 배경 (2026-07-12 사장님 지침):
 *   value-goods 대비 지는 상품 91개는 find-losing-vs-seller.js 로 뽑음.
 *   추가 요청: value-goods 는 리스팅 있는데 나는 없는 상품도 뽑아달라.
 *   계약서 §Engine 2 Discovery 개념 = 소싱 후보 발굴.
 *
 * 판정:
 *   competitor_listings (status='active', seller_id=X)
 *   → product_matches (status='approved') 에 이 competitor_item_id 없음
 *   → 내가 매칭한 상품 없음 = 소싱 후보 (아직 없거나 매칭 안 걸림)
 *
 * ⚠️ 한계 (반드시 이해):
 *   AI 매처가 예산 부족 (21,538 리스팅 중 1,000 개만 처리) 로 아직 매칭 안
 *   본 것도 "매칭 없음" 으로 판정됨. 즉 top 리스트에 실제로는 내가 이미
 *   가진 상품이 섞일 수 있음. 최근에 매처 돌린 셀러 (F 티어) 는 정확도 높음.
 *
 * 정렬: quantity_sold DESC (많이 팔리는 것 우선). 매출 임팩트 큰 것부터.
 *
 * 실행:
 *   node scripts/find-sourcing-vs-seller.js --seller value-goods
 *   node scripts/find-sourcing-vs-seller.js --seller value-goods --apply
 *   node scripts/find-sourcing-vs-seller.js --seller value-goods --apply --top 100
 *   node scripts/find-sourcing-vs-seller.js --seller value-goods --apply --min-sold 5
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sellerIdx = args.indexOf('--seller');
const SELLER = sellerIdx >= 0 ? args[sellerIdx + 1] : null;
const topIdx = args.indexOf('--top');
const TOP_N = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 200;
const minSoldIdx = args.indexOf('--min-sold');
const MIN_SOLD = minSoldIdx >= 0 ? parseInt(args[minSoldIdx + 1], 10) : 0;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  if (!SELLER) throw new Error('사용법: node scripts/find-sourcing-vs-seller.js --seller <seller_id> [--apply] [--top 200] [--min-sold 5]');

  const db = getClient();

  // 1. 셀러의 active 리스팅 전체 로드
  const listings = [];
  let from = 0;
  while (true) {
    const { data, error } = await db.from('competitor_listings')
      .select('ebay_item_id, title, price, shipping, quantity_sold, url, image_url, status, last_seen')
      .eq('seller_id', SELLER)
      .eq('status', 'active')
      .range(from, from + 999);
    if (error) throw new Error(`competitor_listings: ${error.message}`);
    if (!data || data.length === 0) break;
    listings.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[sourcing] ${SELLER} active 리스팅: ${listings.length}건`);
  if (!listings.length) { console.log('[sourcing] 리스팅 없음 — 종료'); return; }

  // 2. approved 매칭 있는 competitor_item_id 집합
  const compIds = listings.map((l) => String(l.ebay_item_id));
  const matched = new Set();
  for (let i = 0; i < compIds.length; i += 500) {
    const chunk = compIds.slice(i, i + 500);
    const { data } = await db.from('product_matches')
      .select('competitor_item_id')
      .eq('status', 'approved')
      .in('competitor_item_id', chunk);
    (data || []).forEach((m) => matched.add(String(m.competitor_item_id)));
  }
  console.log(`[sourcing] approved 매칭 있음: ${matched.size}건 → 나머지 = 소싱 후보`);

  // 3. 매칭 없는 것 = 소싱 후보 + min_sold 필터
  const candidates = listings
    .filter((l) => !matched.has(String(l.ebay_item_id)))
    .filter((l) => (Number(l.quantity_sold) || 0) >= MIN_SOLD)
    .map((l) => ({
      competitor_item_id: String(l.ebay_item_id),
      title: (l.title || '').slice(0, 150),
      price: r2(Number(l.price) || 0),
      shipping: r2(Number(l.shipping) || 0),
      total: r2((Number(l.price) || 0) + (Number(l.shipping) || 0)),
      quantity_sold: Number(l.quantity_sold) || 0,
      url: l.url || `https://www.ebay.com/itm/${l.ebay_item_id}`,
      image_url: l.image_url || null,
      last_seen: l.last_seen,
    }));

  candidates.sort((a, b) => b.quantity_sold - a.quantity_sold);
  const top = candidates.slice(0, TOP_N);
  const totalPotential = r2(top.reduce((s, x) => s + x.quantity_sold * x.total, 0));

  console.log(`[sourcing] 소싱 후보: ${candidates.length}건 → top ${top.length}`);
  console.log(`[sourcing] top ${top.length} 예상 매출 규모 (판매수 × 총액): $${totalPotential.toLocaleString()}`);
  console.log('[sourcing] 상위 10개:');
  top.slice(0, 10).forEach((x, i) => {
    console.log(`  ${i + 1}. sold ${String(x.quantity_sold).padStart(4)} · $${x.total.toString().padStart(6)} · ${x.title.slice(0, 60)}`);
  });

  if (!APPLY) {
    console.log(`[sourcing] dry-run — 실제 저장: node scripts/find-sourcing-vs-seller.js --seller ${SELLER} --apply`);
    return;
  }

  if (top.length === 0) { console.log('[sourcing] 후보 없음 — team_task 생성 안 함'); return; }

  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'SKU_MATCH_FAILED', // 매칭 없음 → 신규 SKU 등록 or 매칭 확인 필요
    dedupeKey: `battle:sourcing-vs-${SELLER}:${today}`,
    title: `[소싱] ${SELLER} 는 팔지만 나는 없는 상품 ${top.length}개 (예상 매출 $${totalPotential.toLocaleString()})`,
    memo: [
      `${SELLER} 리스팅 중 우리 product_matches 에 없는 (approved 매칭 없음) 상품.`,
      'quantity_sold 큰 순 정렬. 판매 검증된 아이템 = 소싱 우선순위.',
      '주의: AI 매처 예산 부족으로 아직 매칭 안 본 것도 여기 뜰 수 있음. 상품명 유사한 게 이미 있는지 SKU 마스터에서 확인 필요.',
      '진짜 소싱 대상은 도매매/알리바바 등에서 원가 확인 후 신규 SKU 등록.',
    ].join('\n'),
    severity: 'medium',
    context: {
      source: 'find-sourcing-vs-seller',
      seller_id: SELLER,
      generated_at: new Date().toISOString(),
      total_candidates: candidates.length,
      top_n: top.length,
      total_estimated_revenue_usd: totalPotential, // UI 재사용
      priority_skus: top.map((x) => ({
        sku: x.competitor_item_id,          // UI 표에 competitor item_id 표시
        title: x.title,
        item_id: x.competitor_item_id,
        my_price: null,                      // 없음 (소싱 후보)
        competitor_total: x.total,
        estimated_revenue_usd: r2(x.quantity_sold * x.total),
        sales_count: x.quantity_sold,
        price_usd: x.total,
        missing: '소싱',
      })),
    },
  });

  console.log(`[sourcing] team_task ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
  console.log('[sourcing] 자동 예외 콘솔 → [소싱] 카드 확인 → 상품명 옆 SKU (= competitor item_id) 로 eBay 리스팅 확인');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[sourcing] 실패:', e.message); process.exit(1); });
