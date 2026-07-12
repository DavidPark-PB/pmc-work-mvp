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
const INCLUDE_STALE = args.includes('--include-stale'); // 기본 false — 오래된 것 제외
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
  //   2026-07-12: 데이터 신선도 태그 추가 — 사장님 지적 (내 가격 3~4개월 전
  //   이라 오판정). productSync 크론 문제 해결 전까지 신선도 표시로 사장님이
  //   직접 판단.
  const now = Date.now();
  const STALE_DAYS = 14;
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
    const myUpdatedMs = my.updated_at ? new Date(my.updated_at).getTime() : 0;
    const myAgeDays = myUpdatedMs > 0 ? Math.floor((now - myUpdatedMs) / 86400000) : null;
    const isStale = myAgeDays != null && myAgeDays >= STALE_DAYS;
    losing.push({
      sku: my.sku,
      my_item_id: my.item_id,
      title: (my.title || '').slice(0, 120),
      my_price: r2(myPrice),
      my_shipping: r2(myShipping),
      my_total: r2(myTotal),
      my_updated_at: my.updated_at,
      my_age_days: myAgeDays,
      is_stale: isStale,
      my_url: my.item_id ? `https://www.ebay.com/itm/${my.item_id}` : null,
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
  const staleCount = losing.filter((x) => x.is_stale).length;
  const freshCount = losing.length - staleCount;

  // 2026-07-12 사장님 지침 (기본): 오래된 판정은 자동 예외 콘솔 카드에서 제외.
  //   Browse API 쿼터 회복 후 matched-only refresh 돌면 신선한 것만 남음.
  //   --include-stale 로 이전 동작 복원 가능.
  const filteredForTask = INCLUDE_STALE ? losing : losing.filter((x) => !x.is_stale);

  losing.sort((a, b) => b.diff - a.diff);
  const totalDiff = r2(losing.reduce((s, x) => s + x.diff, 0));

  console.log(`[find-losing] ${SELLER} 대비 지는 상품: 총 ${losing.length}건 = 신선 ${freshCount} + 오래됨 ${staleCount} · 조정폭 $${totalDiff.toLocaleString()}`);
  console.log(`[find-losing] 자동 예외 카드에는 ${INCLUDE_STALE ? '전부' : `신선한 ${freshCount}건만`} 표시 (${INCLUDE_STALE ? '--include-stale 활성' : '--include-stale 로 오래된 것도 포함 가능'})`);
  console.log('[find-losing] 상위 10개:');
  losing.slice(0, 10).forEach((x, i) => {
    const stale = x.is_stale ? ` ⚠️ ${x.my_age_days}일전` : '';
    console.log(`  ${i + 1}. ${x.sku.padEnd(20)} diff=$${x.diff.toString().padStart(6)} · 내 $${x.my_total}${stale} vs 경쟁 $${x.competitor_total} · ${x.title.slice(0, 45)}`);
  });

  if (!APPLY) {
    console.log('[find-losing] dry-run — 실제 저장: node scripts/find-losing-vs-seller.js --seller ' + SELLER + ' --apply');
    return;
  }

  const filteredTotalDiff = r2(filteredForTask.reduce((s, x) => s + x.diff, 0));

  // 신선 없음 + stale 있음 → 이전 오판정 카드 done 처리 + 판정 유예 카드로 교체.
  if (filteredForTask.length === 0 && staleCount > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const { getClient } = require('../src/db/supabaseClient');
    const db = getClient();
    const { error: doneErr } = await db.from('team_tasks')
      .update({ status: 'done', completion_note: '오판정 (오래된 데이터) — 판정 유예 카드로 교체' })
      .eq('dedupe_key', `battle:losing-vs-${SELLER}:${today}`)
      .neq('status', 'done');
    if (doneErr) console.warn('[find-losing] 기존 카드 done 처리 실패:', doneErr.message);
    else console.log('[find-losing] 오늘 자 이전 카드 done 처리 완료');

    const res = await createExceptionTask({
      exceptionType: 'AUTOMATION_FAILED',
      dedupeKey: `battle:losing-vs-${SELLER}:pending:${today}`,
      title: `[전투] ${SELLER} 판정 유예 — 데이터 오래됨 (${staleCount}건 refresh 대기)`,
      memo: [
        `${SELLER} 매칭된 내 리스팅 ${staleCount}건 모두 ${STALE_DAYS}일 이상 오래된 데이터.`,
        '실제 이베이 가격은 대부분 이미 갱신됐지만 우리 DB 는 예전 값 → 정확 판정 불가.',
        '조치 (2026-07-12 배포):',
        '  1. myListingRefresher matched-only 모드 활성 — 매일 새벽 3시 매칭 SKU 만 refresh.',
        '  2. 매칭 approved SKU 약 1,078개 → 하루에 전량 신선화 예상.',
        '내일 오전 이후 재실행 시 신선한 판정만 남음.',
        `수동 확인 원하면: node scripts/find-losing-vs-seller.js --seller ${SELLER} --apply --include-stale`,
      ].join('\n'),
      severity: 'medium',
      context: {
        source: 'find-losing-vs-seller',
        seller_id: SELLER,
        pending: true,
        stale_count: staleCount,
        generated_at: new Date().toISOString(),
      },
    });
    console.log(`[find-losing] 판정 유예 카드 ${res.deduped ? 'dedup' : '생성'} id=${res.id ?? '?'}`);
    return;
  }

  if (filteredForTask.length === 0) {
    console.log('[find-losing] 지는 상품 없음 (신선/오래됨 모두 0) — team_task 생성 안 함');
    return;
  }

  // 4. team_task 저장 (하루 셀러별 1장 dedupe). context.priority_skus 로
  //    자동 예외 콘솔이 오늘 만든 우선순위 카드 UI 재사용.
  const today = new Date().toISOString().slice(0, 10);
  const res = await createExceptionTask({
    exceptionType: 'LANDING_COST_DATA_MISSING',
    dedupeKey: `battle:losing-vs-${SELLER}:${today}`,
    title: INCLUDE_STALE
      ? `[전투] ${SELLER} 대비 지는 상품 ${losing.length}개 (⚠️ 신선도 ${STALE_DAYS}일↑ ${staleCount}건 · 조정폭 $${totalDiff.toLocaleString()})`
      : `[전투] ${SELLER} 대비 지는 상품 ${filteredForTask.length}개 (신선한 판정만 · 조정폭 $${filteredTotalDiff.toLocaleString()}, 오래된 ${staleCount}건 제외)`,
    memo: [
      `경쟁 셀러 ${SELLER} 리스팅 중 승인 매칭 + active + 내 total > 경쟁 total 인 상품.`,
      'diff 큰 순 정렬. 각 SKU 옆 my_url / competitor_url 로 실제 이베이 페이지 확인.',
      INCLUDE_STALE
        ? `⚠️ 신선도 ${STALE_DAYS}일↑ 항목 포함 — 오래된 데이터는 판정 신뢰 낮음.`
        : `이 카드는 최근 ${STALE_DAYS}일 이내 갱신된 SKU 만 표시. 오래된 ${staleCount}건은 제외됨.`,
      'productSync 크론 미가동으로 대량 SKU 가 stale — 매일 새벽 3시 matched-only refresh 로 순차 신선화 중.',
    ].join('\n'),
    severity: 'high',
    context: {
      source: 'find-losing-vs-seller',
      seller_id: SELLER,
      generated_at: new Date().toISOString(),
      include_stale: INCLUDE_STALE,
      stale_days: STALE_DAYS,
      total_losing_all: losing.length,
      fresh_count: freshCount,
      stale_count: staleCount,
      total_losing: filteredForTask.length,
      total_estimated_revenue_usd: INCLUDE_STALE ? totalDiff : filteredTotalDiff,
      top_n: filteredForTask.length,
      priority_skus: filteredForTask.map((x) => ({
        sku: x.sku,
        title: x.title,
        item_id: x.my_item_id,
        my_price: x.my_total,
        my_url: x.my_url,
        competitor_total: x.competitor_total,
        competitor_url: x.competitor_url,
        diff: x.diff,
        competitor_sold: x.competitor_sold,
        my_age_days: x.my_age_days,
        // 신선도 태그 (UI missing 컬럼에 표시)
        missing: x.is_stale ? `⚠️ ${x.my_age_days}일전` : `✓ 최근`,
        // UI 우선순위 표에 표시되는 필드
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
