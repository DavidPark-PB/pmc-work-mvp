/**
 * 1회성 batch: status='ended' 마킹된 competitor_prices row 들을 Browse API
 * 로 재확인. 살아있으면 active 로 복구, 진짜 사라진 것만 ended 유지.
 *
 * 원인: competitorMonitor 가 일시적 API 실패 → ended 마킹 → 이후 영원히
 * 재fetch 안 함. 거짓 ended 가 누적됨.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', '.env') });
const { getClient } = require('../src/db/supabaseClient');
const EbayAPI = require('../src/api/ebayAPI');

const CONCURRENCY = 3;
const DELAY_MS = 250;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const db = getClient();
  const ebay = new EbayAPI();
  const { data: rows } = await db.from('competitor_prices')
    .select('id, sku, competitor_id, competitor_price')
    .eq('status', 'ended')
    .neq('competitor_id', '');
  console.log(`재확인 대상: ${rows.length} 행`);

  const stats = { revived: 0, stillEnded: 0, fail: 0 };
  let cursor = 0;
  const startAt = Date.now();

  const worker = async () => {
    while (cursor < rows.length) {
      const i = cursor++;
      const row = rows[i];
      try {
        const item = await ebay._fetchViaBrowseAPI(row.competitor_id);
        // 살아있음 → active 로 복구
        await db.from('competitor_prices').update({
          status: 'active',
          competitor_price: item.price,
          competitor_shipping: item.shippingCost,
          quantity_available: item.quantityAvailable,
          price_min: item.priceMin, price_max: item.priceMax, variant_count: item.variantCount,
          last_refreshed_at: new Date().toISOString(),
          tracked_at: new Date().toISOString(),
        }).eq('id', row.id);
        stats.revived++;
      } catch (e) {
        const msg = String(e.message || e);
        if (/not\s*found|404/i.test(msg)) {
          // 진짜 ended — 그대로 유지, last_refreshed_at 만 갱신
          await db.from('competitor_prices').update({ last_refreshed_at: new Date().toISOString() }).eq('id', row.id);
          stats.stillEnded++;
        } else {
          stats.fail++;
        }
      }
      if ((i + 1) % 25 === 0 || i === rows.length - 1) {
        const el = (Date.now() - startAt) / 1000;
        console.log(`[${i + 1}/${rows.length}] revived=${stats.revived} stillEnded=${stats.stillEnded} fail=${stats.fail} | ${(el).toFixed(0)}s`);
      }
      await sleep(DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('\n=== 완료 ===');
  console.log(stats);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
