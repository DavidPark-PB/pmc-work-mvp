'use strict';

/**
 * generate-topseller-priority-tasks.js
 *
 * 매출 상위 SKU 중 원가/무게 미입력분을 우선순위 team_task 로 등록.
 *
 * 배경 (2026-07-10 → 2026-07-11 개선):
 *   Engine 4 조기 실행으로 active SKU 가 9,464 → 2,771 로 축소.
 *   이 2,771 개 중에도 사장님이 원가/무게를 다 채우는 건 물리적으로 어려움.
 *   파레토 원칙 — 매출 상위 20% 가 사업 매출 80%.
 *
 * ⚠️ 2026-07-11 사장님 지적으로 로직 재설계:
 *   ebay_products.sales_count 는 리스팅 전체 기간 누적 판매수. BTS V Boston
 *   Bag (2년 전 팔림 8개, 최근 판매 0) 같은 상품이 sales_count × price 로
 *   top 200 에 잘못 진입.
 *
 *   재설계: orders 테이블의 최근 90 일 실제 판매 데이터로 정렬.
 *     recent_qty_90d = orders.quantity (order_date ≥ 오늘-90일)
 *     recent_revenue_usd = recent_qty_90d × price_usd
 *   실질 판매 중인 SKU 만 남음. 오래된 상품은 자동 제외.
 *
 * 기존 generate-priority-cost-tasks.js 와 차이:
 *   - 그 스크립트: losing SKU + 격차 큰 순 (경쟁 대응 관점)
 *   - 이 스크립트: 최근 90 일 실제 판매수 큰 순 (매출 규모 관점)
 *   두 스크립트를 병행하면 "지금 지고있는 것 + 앞으로 크게 벌 것" 커버.
 *
 * 실행:
 *   node scripts/generate-topseller-priority-tasks.js          (dry-run)
 *   node scripts/generate-topseller-priority-tasks.js --apply  (team_task 저장)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');
const { createExceptionTask } = require('../src/services/exceptionTask');

const APPLY = process.argv.includes('--apply');
const TOP_N = 200;
const RECENT_DAYS = 90;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const db = getClient();

  // 1. active sku_master 로드 (Engine 4 이후 2,771 예상)
  const activeSkus = new Set();
  const smBySku = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await db.from('sku_master')
      .select('internal_sku, cost_krw, weight_gram, width_cm, height_cm, length_cm, supplier_id')
      .eq('status', 'active')
      .range(from, from + 999);
    if (error) throw new Error(`sku_master: ${error.message}`);
    if (!data || data.length === 0) break;
    data.forEach((s) => { activeSkus.add(s.internal_sku); smBySku.set(s.internal_sku, s); });
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`[topseller] active SKU: ${activeSkus.size}개`);

  // 2. 최근 90 일 orders 로 SKU 별 실제 판매수 집계 (2026-07-11 재설계).
  //    ebay_products.sales_count 는 전체 기간 누적이라 오래된 판매도 포함됨.
  //    사장님 지적: BTS V Boston Bag (2 년 전 판매 8, 최근 0) 이 top 200
  //    에 잘못 들어감. orders.order_date 기준으로 진짜 최근 판매만 사용.
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const recentSales = new Map(); // sku → { qty, avg_price }
  {
    let ofs = 0;
    while (true) {
      const { data, error } = await db.from('orders')
        .select('sku, quantity, payment_amount, currency')
        .gte('order_date', since)
        .range(ofs, ofs + 999);
      if (error) throw new Error(`orders: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const o of data) {
        const sku = (o.sku || '').trim();
        if (!sku) continue;
        const qty = Number(o.quantity) || 1;
        const acc = recentSales.get(sku) || { qty: 0, revenue_usd: 0 };
        acc.qty += qty;
        // USD 로만 매출 집계 (KRW/기타 통화는 무시 — 매출 규모 근사)
        if (String(o.currency || '').toUpperCase() === 'USD') {
          acc.revenue_usd += Number(o.payment_amount) || 0;
        }
        recentSales.set(sku, acc);
      }
      if (data.length < 1000) break;
      ofs += 1000;
    }
  }
  console.log(`[topseller] 최근 ${RECENT_DAYS}일 실제 판매 SKU: ${recentSales.size}개`);

  // 3. 최근 판매 있는 SKU 대상으로 ebay_products 정보 로드
  const recentSkuList = [...recentSales.keys()];
  const listings = [];
  for (let i = 0; i < recentSkuList.length; i += 500) {
    const chunk = recentSkuList.slice(i, i + 500);
    const { data, error } = await db.from('ebay_products')
      .select('sku, item_id, title, price_usd, sales_count, stock, status')
      .in('sku', chunk);
    if (error) throw new Error(`ebay_products: ${error.message}`);
    (data || []).forEach((l) => listings.push(l));
  }
  console.log(`[topseller] 매칭된 eBay 리스팅: ${listings.length}개`);

  // 4. active SKU 이면서 원가/무게/치수 부족한 것 필터
  const candidates = [];
  for (const l of listings) {
    if (l.status === 'ended') continue;
    if (!activeSkus.has(l.sku)) continue; // Engine 4 로 paused 처리된 것 제외
    const rec = recentSales.get(l.sku);
    if (!rec || rec.qty <= 0) continue;

    const sm = smBySku.get(l.sku);
    const costMissing = !sm || sm.cost_krw == null;
    const weightMissing = !sm || sm.weight_gram == null || sm.weight_gram === 0;
    const dimMissing = !sm || !sm.width_cm || !sm.height_cm || !sm.length_cm;
    const supplierMissing = !sm || sm.supplier_id == null;
    if (!(costMissing || weightMissing || dimMissing)) continue; // 이미 다 채워짐

    const missing = [];
    if (costMissing) missing.push('원가');
    if (weightMissing) missing.push('무게');
    if (dimMissing) missing.push('치수');
    if (supplierMissing) missing.push('소싱처');

    // 최근 판매 기준 매출 임팩트 (2026-07-11):
    //   1순위: orders.payment_amount USD 합계 (실측 매출)
    //   2순위: recent_qty × price_usd (payment_amount 누락/비-USD 케이스)
    const priceUsd = Number(l.price_usd) || 0;
    const est_revenue = rec.revenue_usd > 0 ? rec.revenue_usd : (rec.qty * priceUsd);

    candidates.push({
      sku: l.sku,
      item_id: l.item_id,
      title: (l.title || '').slice(0, 100),
      recent_qty_90d: rec.qty,
      sales_count_lifetime: Number(l.sales_count) || 0,
      price_usd: r2(priceUsd),
      stock: Number(l.stock) || 0,
      estimated_revenue_usd: r2(est_revenue),
      missing: missing.join('+'),
    });
  }

  candidates.sort((a, b) => b.estimated_revenue_usd - a.estimated_revenue_usd);
  const top = candidates.slice(0, TOP_N);
  const totalRevenue = r2(top.reduce((s, c) => s + c.estimated_revenue_usd, 0));

  console.log(`[topseller] 최근 판매 있음 + 데이터 미입력 SKU: ${candidates.length}개 → top ${TOP_N}`);
  console.log(`[topseller] top ${top.length} 최근 ${RECENT_DAYS}일 매출 규모: $${totalRevenue.toLocaleString()}`);
  console.log('[topseller] 상위 5개 미리보기:');
  top.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.sku.padEnd(20)} 최근판매 ${String(c.recent_qty_90d).padStart(4)} (누적 ${c.sales_count_lifetime}) · $${c.price_usd} · 매출 $${c.estimated_revenue_usd.toLocaleString()} · 미입력 ${c.missing} | ${c.title.slice(0, 55)}`);
  });

  if (!APPLY) {
    console.log('[topseller] dry-run — 실제 저장: node scripts/generate-topseller-priority-tasks.js --apply');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'LANDING_COST_DATA_MISSING',
    // 2026-07-11: dedupe key 에 v2 추가 (재설계된 최근 90일 로직).
    // 이전 sales_count 누적 기반 태스크와 병존 X — 새 카드 갱신.
    dedupeKey: `engine1:topseller-priority-v2:${today}`,
    title: `[매출 우선순위] top ${top.length} SKU — 원가·무게 입력 (최근 ${RECENT_DAYS}일 매출 $${totalRevenue.toLocaleString()})`,
    memo: [
      `최근 ${RECENT_DAYS}일 실제 판매 있는 SKU 중 원가·무게·치수 미입력분을 매출 규모 순 정렬.`,
      '2026-07-11 재설계: 이전엔 sales_count(전체 기간 누적) 기준이라 2 년 전 팔린 상품도 진입.',
      '이제 orders 테이블 order_date 기준 실측 판매만 사용 → 진짜 판매 중인 SKU 만 남음.',
      'SKU 마스터 화면에서 이 순서대로 원가/무게 인라인 입력 → Engine 1 즉시 자동가격 편입.',
    ].join('\n'),
    severity: 'high',
    context: {
      source: 'engine4-topseller',
      version: 'v2-recent-orders',
      recent_days: RECENT_DAYS,
      generated_at: new Date().toISOString(),
      total_active_missing: candidates.length,
      top_n: top.length,
      total_estimated_revenue_usd: totalRevenue,
      priority_skus: top,
    },
  });

  console.log(`[topseller] team_task ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[topseller] 실패:', e.message); process.exit(1); });
