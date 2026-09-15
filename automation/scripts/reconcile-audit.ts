/**
 * 실제 플랫폼(eBay/Shopify) 등록 상태 READ-ONLY 감사 — 기본은 dry run (DB 쓰기 없음)
 *   npx tsx scripts/reconcile-audit.ts           # 감사만
 *   npx tsx scripts/reconcile-audit.ts --apply   # 확정 매칭만 내부 DB 연결 보정
 */
import axios from 'axios';
import { reconcileListings, type ProductPlan } from '../src/services/listing-reconcile.js';

//   플랫폼 쓰기 차단: Shopify는 GET만, eBay Trading은 조회(GetMyeBaySelling)도 POST XML이라 URL로 구분
for (const method of ['post', 'put', 'patch', 'delete'] as const) {
  const original = axios[method] as any;
  (axios as any)[method] = async (url: string, ...rest: any[]) => {
    const isEbayTrading = /ebay\.com\/ws\/api\.dll/.test(String(url));
    if (!isEbayTrading || method !== 'post') throw new Error(`플랫폼 쓰기 차단: ${method.toUpperCase()} ${String(url).slice(0, 60)}`);
    return original(url, ...rest);
  };
}

const apply = process.argv.includes('--apply');
const result = await reconcileListings({ dryRun: !apply });
const line = (r: ProductPlan) => [r.productId, r.sku, r.status, r.ebay.action, r.ebay.externalId ?? '-', r.shopify.action, r.shopify.externalId ?? '-', (r.ebay.reason || r.shopify.reason || '').slice(0, 90)].join(' | ');

console.log('MODE', apply ? 'APPLY' : 'DRY_RUN');
console.log('EXTERNAL', JSON.stringify(result.external));
console.log('SUMMARY', JSON.stringify(result.summary));
if (apply) console.log('WRITES', JSON.stringify({ updated: result.updated, inserted: result.inserted }));
for (const status of ['BOTH', 'EBAY_ONLY', 'SHOPIFY_ONLY', 'NONE', 'MATCH_REQUIRED'] as const) {
  const rows = result.rows.filter(r => r.status === status);
  console.log(`--- ${status} (${rows.length})`);
  rows.slice(0, 15).forEach(r => console.log(line(r)));
}
console.log('--- REPAIR TARGET', result.rows.filter(r => r.needsRepair).length);
result.rows.filter(r => r.needsRepair).slice(0, 20).forEach(r => console.log(line(r)));
process.exit(0);
