#!/usr/bin/env node
/**
 * 기존 주문 전체를 스캔해서 b2b_buyers.external_ids 기준으로 b2b_buyer_id 채우기.
 * 사용:
 *   node scripts/backfill-b2b-buyer-id.js                # 미매칭만
 *   node scripts/backfill-b2b-buyer-id.js --all          # 전부 재스캔 (이미 매칭된 것도)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', '.env') });

const matcher = require('../src/services/b2bBuyerMatcher');

(async () => {
  const onlyUnmapped = !process.argv.includes('--all');
  console.log(`[backfill] 시작 — ${onlyUnmapped ? '미매칭 주문만' : '전체 주문'} 스캔`);
  const t0 = Date.now();
  const r = await matcher.backfillOrders({ onlyUnmapped, limit: 50000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill] 완료 ${dt}s — 스캔 ${r.scanned}건, 매칭 ${r.matched}건${r.reason ? ` (${r.reason})` : ''}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
