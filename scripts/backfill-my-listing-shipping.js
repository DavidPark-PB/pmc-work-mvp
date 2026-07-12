'use strict';

/**
 * backfill-my-listing-shipping.js — 내 eBay 리스팅 shipping_usd 백필
 *
 * 배경 (2026-07-12):
 *   사장님 지적: 전투 상황판에서 경쟁사는 배송비 잘 뜨는데 내 리스팅은
 *   $0.00 만 뜬다. 실제 eBay 리스팅에는 기본 $4.90 설정돼 있음.
 *
 *   원인 (CLAUDE.md 함정): GetMyeBaySelling (Trading API) 이 shipping 을
 *   트랜잭션 기준으로 부정확하게 반환 → productSync 가 shipping_usd 를
 *   skip → 새 리스팅은 DB 에 0 저장.
 *
 *   실제 현황: 활성 9,591개 중 9,447개 (98.5%) shipping = 0/null.
 *   그나마 있는 144개는 3개월 전 (2026-04-26) 데이터.
 *
 * 정책 (사장님 승인 필요):
 *   shipping_usd 가 0 or NULL 인 활성 리스팅을 default $4.90 로 세팅.
 *   나중에 Browse API (myListingRefresher.js) 로 실제 값 갱신되면 덮어씀.
 *   이미 값이 있는 것 (0 초과) 은 건드리지 않음.
 *
 * 안전:
 *   eBay API 호출 ZERO. DB 만 UPDATE.
 *   status='ended' 리스팅은 제외.
 *
 * 실행:
 *   node scripts/backfill-my-listing-shipping.js               (dry-run)
 *   node scripts/backfill-my-listing-shipping.js --apply       (실제 반영)
 *   node scripts/backfill-my-listing-shipping.js --apply --shipping 5.90  (기본값 override)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { getClient } = require('../src/db/supabaseClient');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const shipIdx = args.indexOf('--shipping');
const DEFAULT_SHIPPING = shipIdx >= 0 ? parseFloat(args[shipIdx + 1]) : 4.90;

async function main() {
  if (!Number.isFinite(DEFAULT_SHIPPING) || DEFAULT_SHIPPING < 0) {
    throw new Error(`--shipping 값이 유효하지 않음: ${DEFAULT_SHIPPING}`);
  }
  const db = getClient();

  // 1. 대상 조회 (shipping = 0 or null · status != 'ended')
  const { count } = await db.from('ebay_products')
    .select('*', { count: 'exact', head: true })
    .neq('status', 'ended')
    .or('shipping_usd.is.null,shipping_usd.eq.0');
  console.log(`[backfill] 대상 리스팅: ${count}개 (shipping 0/null · status != ended)`);
  console.log(`[backfill] 백필 값: $${DEFAULT_SHIPPING.toFixed(2)}`);

  if (!APPLY) {
    console.log('[backfill] dry-run — 실제 반영: node scripts/backfill-my-listing-shipping.js --apply');
    return;
  }

  // 2. UPDATE (Supabase 는 .update() 한 번에 대량 처리 지원)
  //    updated_at 은 그대로 두어 sync 상태 오염 안 함.
  const { data, error } = await db.from('ebay_products')
    .update({ shipping_usd: DEFAULT_SHIPPING })
    .neq('status', 'ended')
    .or('shipping_usd.is.null,shipping_usd.eq.0')
    .select('id');
  if (error) throw new Error(`UPDATE 실패: ${error.message}`);
  console.log(`[backfill] 완료 — ${(data || []).length}개 리스팅 shipping_usd = $${DEFAULT_SHIPPING.toFixed(2)}`);
  console.log('[backfill] 나중에 myListingRefresher (매일 3시 크론) 가 Browse API 로 실제 값 덮어씀');
}

main().then(() => process.exit(0)).catch((e) => { console.error('[backfill] 실패:', e.message); process.exit(1); });
