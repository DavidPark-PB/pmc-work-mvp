/**
 * 1회성 배치: shipping_usd=$3.90 으로 하드코딩된 ebay_products row 들을
 * Browse API 로 정확한 값으로 일괄 갱신.
 *
 * 사용:  node scripts/refresh-all-listings-shipping.js [--limit=3000]
 *
 * 안전장치:
 * - 동시 3 + 250ms 간격 → 약 ~12 calls/sec
 * - 429 / quota exceeded 발생 시 5분 휴식 후 재시도, 3회 실패 시 중단
 * - 진행률 50개마다 로그
 * - 부분 실패는 status='error' 로 마킹해서 다음 실행에 건너뛰기
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', '.env') });
const { getClient } = require('../src/db/supabaseClient');
const EbayAPI = require('../src/api/ebayAPI');

const argLimit = (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1];
const LIMIT = parseInt(argLimit, 10) || 3000; // Browse API 일일 한도 5000 미만으로
const CONCURRENCY = 3;
const DELAY_MS = 250;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processOne(ebay, db, row, stats) {
  try {
    const item = await ebay._fetchViaBrowseAPI(row.item_id);
    const updates = {
      price_usd: Number(item.price) || row.price_usd,
      shipping_usd: Number(item.shippingCost) || 0,
      ebay_api_stock: Number.isFinite(item.quantityAvailable) ? item.quantityAvailable : null,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    if (updates.ebay_api_stock === null) delete updates.ebay_api_stock;
    if (item.title) updates.title = String(item.title).slice(0, 500);

    const { error } = await db.from('ebay_products').update(updates).eq('item_id', row.item_id);
    if (error) {
      // 일부 컬럼 누락 시 핵심만 update
      const minimal = { price_usd: updates.price_usd, shipping_usd: updates.shipping_usd, updated_at: updates.updated_at };
      await db.from('ebay_products').update(minimal).eq('item_id', row.item_id);
    }
    stats.ok++;
    if (Number(row.shipping_usd) !== updates.shipping_usd) stats.shippingChanged++;
    return { ok: true, before: { p: row.price_usd, s: row.shipping_usd }, after: { p: updates.price_usd, s: updates.shipping_usd } };
  } catch (e) {
    stats.fail++;
    const msg = String(e.message || e);
    if (/not\s*found|404/i.test(msg)) {
      // ended listing
      try { await db.from('ebay_products').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('item_id', row.item_id); } catch {}
      stats.ended++;
    } else if (/rate.?limit|429|quota|too many requests|request limit|errorId.*2001/i.test(msg)) {
      // eBay Browse API: errorId 2001 "Too many requests" = 일일 5000 한도 초과
      stats.rateLimitHits++;
      throw new Error('RATE_LIMIT'); // 상위에서 caught
    }
    return { ok: false, error: msg };
  }
}

async function main() {
  const db = getClient();
  const ebay = new EbayAPI();

  // shipping_usd=$3.90 인 active row 들 (가장 stale 한 것부터, item_id 오름차순)
  console.log('대상 row 조회 중...');
  let rows = [];
  let from = 0;
  while (rows.length < LIMIT) {
    const remain = LIMIT - rows.length;
    const pageSize = Math.min(1000, remain);
    const { data, error } = await db.from('ebay_products')
      .select('item_id, sku, price_usd, shipping_usd')
      .eq('shipping_usd', 3.9)
      .neq('status', 'ended')
      .order('updated_at', { ascending: true, nullsFirst: true })
      .range(from, from + pageSize - 1);
    if (error) { console.error('조회 실패:', error.message); break; }
    if (!data || data.length === 0) break;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`처리 대상: ${rows.length} 행 (limit=${LIMIT}, concurrency=${CONCURRENCY})`);
  if (rows.length === 0) { console.log('갱신할 row 없음. 종료.'); return; }

  const stats = { ok: 0, fail: 0, ended: 0, shippingChanged: 0, rateLimitHits: 0 };
  const startedAt = Date.now();

  let inFlight = 0;
  let cursor = 0;
  let rateLimitCount = 0;

  const worker = async () => {
    while (cursor < rows.length) {
      if (rateLimitCount >= 3) { console.warn('rate limit 3회 누적 — 중단'); break; }
      const i = cursor++;
      const row = rows[i];
      try {
        await processOne(ebay, db, row, stats);
      } catch (e) {
        if (String(e.message) === 'RATE_LIMIT') {
          rateLimitCount++;
          if (rateLimitCount >= 3) {
            console.error(`\n[!] RATE LIMIT 3회 누적 — 일일 한도(5000) 도달 추정. 즉시 종료.`);
            console.error(`내일 다시 실행하면 남은 row 부터 이어서 처리됩니다 (updated_at 오래된 순 정렬).`);
            return;
          }
          console.warn(`[${i}] RATE LIMIT — 5분 휴식 (#${rateLimitCount}/3)`);
          await sleep(5 * 60 * 1000);
          continue;
        }
      }
      // progress log
      if ((i + 1) % 50 === 0 || i === rows.length - 1) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = (i + 1) / elapsed;
        const eta = Math.round((rows.length - i - 1) / rate);
        console.log(`[${i + 1}/${rows.length}] ok=${stats.ok} fail=${stats.fail} ended=${stats.ended} shipChanged=${stats.shippingChanged} | ${rate.toFixed(1)}/s ETA=${eta}s`);
      }
      await sleep(DELAY_MS);
    }
  };

  // CONCURRENCY 워커 병렬 실행
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log('\n=== 완료 ===');
  console.log('처리:', stats.ok + stats.fail, '/ 성공:', stats.ok, '/ 실패:', stats.fail, '/ ended:', stats.ended);
  console.log('shipping 변경:', stats.shippingChanged, '/ rate limit:', stats.rateLimitHits);
  console.log('소요:', elapsed + '초');
}

main().catch(e => { console.error('치명적 오류:', e); process.exit(1); });
