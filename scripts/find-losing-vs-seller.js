'use strict';

/**
 * find-losing-vs-seller.js — 특정 경쟁 셀러 대비 지고 있는 내 상품 목록 추출.
 *
 * 배경 (2026-07-12):
 *   사장님 요청 — value-goods 랑만 비교해서 지고 있는 상품 다 보여줘.
 *   기존 전투 상황판이 매칭 판정/신선도 표시에 이상 있어 우선 신뢰할 수 있는
 *   스크립트로 정확히 뽑아 team_task 로 등록. 사장님이 자동 예외 콘솔에서
 *   확인 → 필요 시 SKU 마스터 일괄 편집 (오늘 만든 우선순위 카드 UX 재사용).
 *
 * 판정:
 *   product_matches (status='approved', seller_id=X)
 *   → competitor_listings (status='active') JOIN
 *   → ebay_products JOIN
 *   diff = (my_price + my_shipping) - (comp_price + comp_shipping)
 *   diff > 0 → 지고 있음 (losing)
 *
 * 정렬: diff DESC (가장 크게 지는 것부터).
 *
 * 실행:
 *   node scripts/find-losing-vs-seller.js --seller value-goods
 *   node scripts/find-losing-vs-seller.js --seller value-goods --apply
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sellerIdx = args.indexOf('--seller');
const SELLER = sellerIdx >= 0 ? args[sellerIdx + 1] : null;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  if (!SELLER) throw new Error('사용법: node scripts/find-losing-vs-seller.js --seller <seller_id> [--apply]');

  const db = getClient();

  // 1. 승인 매칭 로드
  const { data: matches, error: mErr } = await db.from('product_matches')
    .select('our_sku, competitor_item_id, confidence')
    .eq('status', 'approved')
    .eq('seller_id', SELLER);
  if (mErr) throw new Error(`product_matches: ${mErr.message}`);
  console.log(`[find-losing] ${SELLER} 승인 매칭: ${matches.length}건`);

  if (!matches.length) {
    console.log('[find-losing] 매칭 없음 — 종료');
    return;
  }

  const skus = [...new Set(matches.map((m) => m.our_sku))];
  const compIds = [...new Set(matches.map((m) => m.competitor_item_id))];

  // 2. 내 리스팅 + 경쟁 리스팅 로드
  const myBySku = new Map();
  for (let i = 0; i < skus.length; i += 500) {
    const chunk = skus.slice(i, i + 500);
    const { data } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd, shipping_usd, stock, image_url, updated_at, status')
      .in('sku', chunk);
    (data || []).forEach((r) => myBySku.set(r.sku, r));
  }

  const compById = new Map();
  for (let i = 0; i < compIds.length; i += 500) {
    const chunk = compIds.slice(i, i + 500);
    const { data } = await db.from('competitor_listings')
      .select('ebay_item_id, title, price, shipping, status, url, image_url, last_seen, quantity_sold')
      .in('ebay_item_id', chunk);
    (data || []).forEach((r) => compById.set(String(r.ebay_item_id), r));
  }

  // 3. losing 판정 + 정렬
  const losing = [];
  for (const m of matches) {
    const my = myBySku.get(m.our_sku);
    const c = compById.get(String(m.competitor_item_id));
    if (!my || !c) continue;
    if (my.status === 'ended') continue;
    if (c.status !== 'active') continue;
    const myPrice = Number(my.price_usd) || 0;
    const myShipping = Number(my.shipping_usd) || 0;
    const myTotal = myPrice + myShipping;
    const cPrice = Number(c.price) || 0;
    const cShipping = Number(c.shipping) || 0;
    const cTotal = cPrice + cShipping;
    if (!(myTotal > 0 && cTotal > 0)) continue;
    if (myTotal <= cTotal) continue; // 이기고 있거나 동률
    losing.push({
      sku: my.sku,
      my_item_id: my.item_id,
      title: (my.title || '').slice(0, 120),
      my_price: r2(myPrice),
      my_shipping: r2(myShipping),
      my_total: r2(myTotal),
      competitor_item_id: String(c.ebay_item_id),
      competitor_price: r2(cPrice),
      competitor_shipping: r2(cShipping),
      competitor_total: r2(cTotal),
      diff: r2(myTotal - cTotal),
      competitor_sold: c.quantity_sold ?? null,
      competitor_url: c.url || `https://www.ebay.com/itm/${c.ebay_item_id}`,
      match_confidence: Number(m.confidence) || null,
    });
  }

  losing.sort((a, b) => b.diff - a.diff);
  const totalDiff = r2(losing.reduce((s, x) => s + x.diff, 0));

  console.log(`[find-losing] ${SELLER} 대비 지는 상품: ${losing.length}건 · 잠재 조정폭 합계 $${totalDiff.toLocaleString()}`);
  console.log('[find-losing] 상위 10개:');
  losing.slice(0, 10).forEach((x, i) => {
    console.log(`  ${i + 1}. ${x.sku.padEnd(20)} diff=$${x.diff.toString().padStart(6)} · 내 $${x.my_total} vs 경쟁 $${x.competitor_total} · ${x.title.slice(0, 50)}`);
  });

  if (!APPLY) {
    console.log('[find-losing] dry-run — 실제 저장: node scripts/find-losing-vs-seller.js --seller ' + SELLER + ' --apply');
    return;
  }

  if (losing.length === 0) {
    console.log('[find-losing] 지는 상품 없음 — team_task 생성 안 함');
    return;
  }

  // 4. team_task 저장 (하루 셀러별 1장 dedupe). context.priority_skus 로
  //    자동 예외 콘솔이 오늘 만든 우선순위 카드 UI 재사용.
  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'LANDING_COST_DATA_MISSING',
    dedupeKey: `battle:losing-vs-${SELLER}:${today}`,
    title: `[전투] ${SELLER} 대비 지는 상품 ${losing.length}개 (조정폭 합계 $${totalDiff.toLocaleString()})`,
    memo: [
      `경쟁 셀러 ${SELLER} 리스팅 중 승인 매칭 + active + 내 total > 경쟁 total 인 상품.`,
      'diff (내 total - 경쟁 total) 큰 순 정렬.',
      'SKU 마스터에서 원가/무게/치수/소싱처 채우면 Engine 1 이 자동 대응.',
      '즉시 킬프라이스 필요하면 전투 상황판에서 개별 처리.',
    ].join('\n'),
    severity: 'high',
    context: {
      source: 'find-losing-vs-seller',
      seller_id: SELLER,
      generated_at: new Date().toISOString(),
      total_losing: losing.length,
      total_estimated_revenue_usd: totalDiff, // 이름 재사용 (UI 가 이 필드 렌더)
      top_n: losing.length,
      priority_skus: losing.map((x) => ({
        sku: x.sku,
        title: x.title,
        item_id: x.my_item_id,
        my_price: x.my_total,
        competitor_total: x.competitor_total,
        diff: x.diff,
        competitor_sold: x.competitor_sold,
        missing: 'diff-vs-' + SELLER,
        // 아래 필드는 UI 우선순위 표에 표시되는 이름
        estimated_revenue_usd: x.diff,
        sales_count: x.competitor_sold,
        price_usd: x.my_total,
      })),
    },
  });

  console.log(`[find-losing] team_task ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
  console.log('[find-losing] 자동 예외 콘솔에서 카드 클릭 → SKU 마스터에서 일괄 열기');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[find-losing] 실패:', e.message); process.exit(1); });
