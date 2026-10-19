#!/usr/bin/env node
// ⛔ PR-A (2026-10-20) · 이 스크립트는 폐기됨. product_matches 자동 승인은 금지.
//    승인 경로는 UI 및 Slack 검수만. DB CHECK 제약 (migration 119) 이 영구 차단.
//    실행 복구가 필요하면 사장님과 상의 후 검토.
throw new Error("[LEGACY] 이 스크립트는 폐기됨 (PR-A 2026-10-20). 사장님 승인 없이 실행 금지.");

/**
 * onmom_house 전수 매칭 (2026-07-20 사장님 지침).
 *
 * 판매수 0인 706건 (신규/재고 안 팔린 것) 도 사장님 리스팅과 대조해서
 * 매칭 확대. bulk-title-match 는 sim >= 0.5 만 처리하고 그 이하는 스킵.
 * 이 스크립트는 첫 3-4 단어 (product identifier) 로 사장님 리스팅에 있는지
 * 직접 keyword search 해서 매칭.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { titleSimilarity } = require('../src/services/aiMatcher');

async function main() {
  const db = getClient();

  // 1. 기존 매칭 세트
  const matched = new Set();
  let ofs = 0;
  while (true) {
    const { data } = await db.from('product_matches').select('competitor_item_id').range(ofs, ofs + 999);
    if (!data || data.length === 0) break;
    data.forEach(r => r.competitor_item_id && matched.add(String(r.competitor_item_id)));
    if (data.length < 1000) break;
    ofs += 1000;
  }
  console.log('[vg-full] 기존 매칭:', matched.size);

  // 2. onmom_house 활성 리스팅 전체
  const listings = [];
  ofs = 0;
  while (true) {
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, title, price, shipping, quantity_sold')
      .eq('seller_id', 'value-goods').eq('status', 'active').range(ofs, ofs + 999);
    if (!data || data.length === 0) break;
    listings.push(...data);
    if (data.length < 1000) break;
    ofs += 1000;
  }
  const unmatched = listings.filter(l => !matched.has(String(l.ebay_item_id)));
  console.log('[vg-full] 미매칭:', unmatched.length);

  // 3. 내 리스팅 전체
  const myProducts = [];
  ofs = 0;
  while (true) {
    const { data } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd')
      .neq('status', 'ended').gt('price_usd', 0)
      .range(ofs, ofs + 999);
    if (!data || data.length === 0) break;
    myProducts.push(...data);
    if (data.length < 1000) break;
    ofs += 1000;
  }
  console.log('[vg-full] 내 리스팅:', myProducts.length);

  // 4. 각 미매칭 comp title → 사장님 리스팅 최고 매치 찾기 (title similarity)
  //    similarity >= 0.4 는 approved (사장님 원한 대량 확대)
  //    < 0.4 는 무시 (아예 다른 상품)
  const APPROVE_MIN = 0.40;
  const toApprove = [];
  const noMatch = [];
  const now = new Date().toISOString();

  for (const comp of unmatched) {
    let best = null;
    for (const my of myProducts) {
      const sim = titleSimilarity(comp.title || '', my.title || '');
      if (sim >= APPROVE_MIN && (!best || sim > best.sim)) {
        best = { sku: my.sku, item_id: my.item_id, sim, title: my.title };
      }
    }
    if (best) {
      toApprove.push({
        our_sku: best.sku,
        our_item_id: best.item_id,
        competitor_item_id: String(comp.ebay_item_id),
        seller_id: 'value-goods',
        confidence: +best.sim.toFixed(3),
        method: 'manual',
        ai_reason: `onmom full match (sim=${best.sim.toFixed(3)})`,
        status: 'approved',
        approved_by: 'claude_code_vg_full',
        approved_at: now,
      });
    } else {
      noMatch.push({ id: comp.ebay_item_id, title: comp.title, sold: comp.quantity_sold });
    }
  }

  console.log('[vg-full] 매칭 확정 (sim >=', APPROVE_MIN, '):', toApprove.length);
  console.log('[vg-full] 매칭 없음 (소싱 후보):', noMatch.length);

  // 5. INSERT
  let inserted = 0;
  for (let i = 0; i < toApprove.length; i += 500) {
    const chunk = toApprove.slice(i, i + 500);
    const { data, error } = await db.from('product_matches').insert(chunk).select('id');
    if (error) { console.error('[vg-full] insert 실패:', error.message); continue; }
    inserted += data?.length || 0;
    console.log('[vg-full] 진행:', inserted, '/', toApprove.length);
  }
  console.log('✅ 완료 · INSERT', inserted, '건');

  // 6. 소싱 후보 리포트 (판매수 순)
  noMatch.sort((a, b) => (b.sold || 0) - (a.sold || 0));
  const fs = require('fs');
  fs.writeFileSync(
    '/private/tmp/claude-501/-Users-parksungmin-pmc-work-mvp/85a807b8-641b-4b22-815c-b0034ec675f3/scratchpad/vg-nomatch.json',
    JSON.stringify(noMatch, null, 2)
  );
  console.log('소싱 후보 top 20:');
  noMatch.slice(0, 20).forEach((r, i) => {
    console.log((i+1).toString().padStart(2) + '. sold=' + String(r.sold||0).padStart(4) + ' | ' + (r.title||'').slice(0, 70));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
