#!/usr/bin/env node
// ⛔ PR-A (2026-10-20) · 이 스크립트는 폐기됨. product_matches 자동 승인은 금지.
//    승인 경로는 UI 및 Slack 검수만. DB CHECK 제약 (migration 119) 이 영구 차단.
//    실행 복구가 필요하면 사장님과 상의 후 검토.
throw new Error("[LEGACY] 이 스크립트는 폐기됨 (PR-A 2026-10-20). 사장님 승인 없이 실행 금지.");

/**
 * Bulk title-similarity matching — API $0.
 *
 * 사장님 지적 (2026-07-19): CSV 임포트한 21개 셀러 리스팅 21,000+ 중
 * 매칭 시도조차 안 된 것이 7,000+ 건. aiMatcher hours=25 필터 때문에
 * 예전 데이터는 다 스킵. Claude API 크레딧도 없음.
 *
 * 해결: title similarity 만으로 대량 매칭 (Claude 판정 없이).
 *   >= 0.7 : 자동 approved (완전/거의 매칭 · 매우 안전)
 *   >= 0.5 : pending (부분 매칭 · 사장님 확인)
 *   < 0.5 : 무시
 */
require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { titleSimilarity } = require('../src/services/aiMatcher');

const AUTO_APPROVE = 0.70;   // 이상: 자동 approved
const PENDING_MIN  = 0.50;   // 이상: pending 저장

async function main() {
  const db = getClient();

  // 1. 전체 매칭된 competitor_item_id (approved OR pending — 중복 방지)
  console.log('[bulk] 기존 매칭 로드 중...');
  const existing = new Set();
  let ofs = 0;
  while (true) {
    const { data } = await db.from('product_matches')
      .select('competitor_item_id').range(ofs, ofs + 999);
    if (!data || data.length === 0) break;
    data.forEach(r => r.competitor_item_id && existing.add(String(r.competitor_item_id)));
    if (data.length < 1000) break;
    ofs += 1000;
  }
  console.log('[bulk] 기존 매칭 competitor_item_id:', existing.size);

  // 2. 미매칭 competitor_listings 로드 (active only)
  console.log('[bulk] 미매칭 리스팅 로드 중...');
  const unmatched = [];
  ofs = 0;
  while (true) {
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, seller_id, title, price, shipping')
      .eq('status', 'active').range(ofs, ofs + 999);
    if (!data || data.length === 0) break;
    data.forEach(r => {
      if (!existing.has(String(r.ebay_item_id))) unmatched.push(r);
    });
    if (data.length < 1000) break;
    ofs += 1000;
  }
  console.log('[bulk] 미매칭 활성 리스팅:', unmatched.length);

  // 3. 내 리스팅 로드
  console.log('[bulk] 내 리스팅 로드 중...');
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
  console.log('[bulk] 내 활성 리스팅:', myProducts.length);

  // 4. 각 미매칭 리스팅에 대해 top-1 매칭 계산
  console.log('[bulk] title similarity 계산 시작 (' + (unmatched.length * myProducts.length).toLocaleString() + ' 조합)...');
  const toApprove = [];
  const toPending = [];
  const bySellerApproved = {};
  const bySellerPending = {};
  const now = new Date().toISOString();
  let processed = 0;
  const startTime = Date.now();

  for (const comp of unmatched) {
    processed++;
    if (processed % 500 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log('[bulk] ' + processed + '/' + unmatched.length + ' (elapsed: ' + elapsed.toFixed(0) + 's, ETA: ' + ((unmatched.length - processed) * elapsed / processed).toFixed(0) + 's)');
    }
    let best = null;
    for (const my of myProducts) {
      const sim = titleSimilarity(comp.title || '', my.title || '');
      if (sim >= PENDING_MIN && (!best || sim > best.sim)) {
        best = { sku: my.sku, item_id: my.item_id, sim };
      }
    }
    if (!best) continue;

    const row = {
      our_sku: best.sku,
      our_item_id: best.item_id,
      competitor_item_id: String(comp.ebay_item_id),
      seller_id: comp.seller_id,
      confidence: +best.sim.toFixed(3),
      method: 'manual',
      ai_reason: `Bulk title match (sim=${best.sim.toFixed(3)})`,
      approved_by: 'claude_code_bulk_title',
      approved_at: now,
    };

    if (best.sim >= AUTO_APPROVE) {
      row.status = 'approved';
      toApprove.push(row);
      bySellerApproved[comp.seller_id] = (bySellerApproved[comp.seller_id] || 0) + 1;
    } else {
      row.status = 'pending';
      toPending.push(row);
      bySellerPending[comp.seller_id] = (bySellerPending[comp.seller_id] || 0) + 1;
    }
  }

  console.log('\n[bulk] 판정 완료');
  console.log('[bulk] 자동 승인 대상 (sim >= ' + AUTO_APPROVE + '):', toApprove.length);
  console.log('[bulk] Pending 대상 (0.5 <= sim < 0.7):', toPending.length);

  console.log('\n셀러별 자동 승인:');
  Object.entries(bySellerApproved).sort((a,b)=>b[1]-a[1]).forEach(([s,c])=>console.log('  ', s.padEnd(20), c));
  console.log('\n셀러별 pending:');
  Object.entries(bySellerPending).sort((a,b)=>b[1]-a[1]).forEach(([s,c])=>console.log('  ', s.padEnd(20), c));

  // 5. INSERT (500건씩 배치)
  console.log('\n[bulk] INSERT approved...');
  for (let i = 0; i < toApprove.length; i += 500) {
    const chunk = toApprove.slice(i, i + 500);
    const { error } = await db.from('product_matches').insert(chunk);
    if (error) console.error('[bulk] approved insert 실패:', error.message);
  }
  console.log('[bulk] INSERT pending...');
  for (let i = 0; i < toPending.length; i += 500) {
    const chunk = toPending.slice(i, i + 500);
    const { error } = await db.from('product_matches').insert(chunk);
    if (error) console.error('[bulk] pending insert 실패:', error.message);
  }

  console.log('\n✅ 완료 — approved:', toApprove.length, ', pending:', toPending.length);
}

main().catch(e => { console.error(e); process.exit(1); });
