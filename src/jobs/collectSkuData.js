/**
 * SKU 데이터 수집 + 점수 재계산 Job
 * 실행: node src/jobs/collectSkuData.js (CLI)
 *       POST /api/sku-scores/recalculate (API)
 *       매일 02:00 자동 (서버 스케줄러)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const path = require('path');
const fs = require('fs');

const SkuScorer = require('../services/skuScorer');

const projectRoot = path.join(__dirname, '../..');
const credentialsPath = path.join(projectRoot, 'config', 'credentials.json');
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

/**
 * 전체 SKU 데이터 수집 + 점수 재계산
 */
async function collectAllSkuData() {
  const startTime = Date.now();
  console.log('[SKU Scorer] 데이터 수집 시작...');

  const salesBySku = {};
  const listings = [];
  let dashboardData = [];

  // 1. eBay 30일 판매 트랜잭션 → SKU별 집계
  try {
    const EbayAPI = require('../api/ebayAPI');
    const ebay = new EbayAPI();
    const transactions = await ebay.getSellerTransactions(30);

    if (transactions._apiError) {
      console.warn('[SKU Scorer] eBay 트랜잭션 조회 실패:', transactions._apiError);
    } else {
      (Array.isArray(transactions) ? transactions : []).forEach(txn => {
        const sku = txn.sku || txn.itemId || '';
        if (!sku) return;
        if (!salesBySku[sku]) salesBySku[sku] = { units: 0, revenue: 0 };
        salesBySku[sku].units += txn.quantity || 1;
        salesBySku[sku].revenue += (txn.price || 0) * (txn.quantity || 1);
      });
      console.log(`[SKU Scorer] eBay 트랜잭션: ${Object.keys(salesBySku).length}개 SKU`);
    }

    // 2. eBay 활성 리스팅 → 가격 스냅샷
    try {
      const activeResult = await ebay.getActiveListings(1, 200);
      const items = activeResult.items || [];
      items.forEach(item => listings.push(item));

      // 추가 페이지
      if (activeResult.hasMore && activeResult.totalPages > 1) {
        const maxPages = Math.min(activeResult.totalPages, 5); // 최대 5페이지
        for (let p = 2; p <= maxPages; p++) {
          try {
            const pageResult = await ebay.getActiveListings(p, 200);
            (pageResult.items || []).forEach(item => listings.push(item));
          } catch (e) { break; }
        }
      }
      console.log(`[SKU Scorer] eBay 리스팅: ${listings.length}개`);
    } catch (e) {
      console.warn('[SKU Scorer] eBay 리스팅 조회 실패:', e.message);
    }
  } catch (e) {
    console.warn('[SKU Scorer] eBay API 초기화 실패:', e.message);
  }

  // 3. Google Sheets 대시보드 데이터 (마진/원가)
  if (fs.existsSync(credentialsPath) && SPREADSHEET_ID) {
    try {
      const GoogleSheetsAPI = require('../api/googleSheetsAPI');
      const sheets = new GoogleSheetsAPI(credentialsPath);
      await sheets.authenticate();

      const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:S');
      if (rows && rows.length > 0) {
        dashboardData = rows.map(row => {
          const priceUSD = parseFloat(row[9]) || 0;
          const shipUSD = parseFloat(row[10]) || 0;
          const settlement = (priceUSD + shipUSD) * 0.82 * 1400;
          return {
            sku: row[1] || '', title: row[2] || '',
            purchase: row[4] || '', fee: row[6] || '', totalCost: row[8] || '',
            priceUSD: row[9] || '', shippingUSD: row[10] || '',
            profit: row[11] || '', margin: row[12] || '',
            itemId: row[13] || '',  // eBay Item ID (교차 매칭용)
            settlement: Math.round(settlement),
          };
        }).filter(r => r.sku);
        console.log(`[SKU Scorer] Google Sheets: ${dashboardData.length}개 상품`);
      }
    } catch (e) {
      console.warn('[SKU Scorer] Google Sheets 조회 실패:', e.message);
    }
  }

  // 4. 가격 스냅샷 기록
  const scorer = new SkuScorer();
  listings.forEach(item => {
    const sku = item.sku || item.itemId || '';
    const price = parseFloat(item.price) || 0;
    if (sku && price > 0) {
      scorer.addPriceSnapshot(sku, price, 'ebay');
    }
  });
  scorer.savePriceSnapshots();
  console.log(`[SKU Scorer] 가격 스냅샷: ${listings.length}개 기록`);

  // 5. 전체 점수 재계산
  const result = scorer.recalculateAll({
    salesBySku,
    dashboardData,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[SKU Scorer] 재계산 완료: ${result.calculated}개 SKU (${elapsed}초)`);
  console.log(`[SKU Scorer] 등급 분포:`, JSON.stringify(result.summary.byClassification));
  console.log(`[SKU Scorer] 평균 점수: ${result.summary.avgScore}, 퇴출 대상: ${result.summary.retirementCandidates}`);

  return result;
}

/**
 * 서버 스케줄러용 export
 */
function scheduleSkuScoreUpdate() {
  console.log(`[SKU Scorer] 스케줄 실행: ${new Date().toLocaleString('ko-KR')}`);
  collectAllSkuData().catch(e => console.error('[SKU Scorer] 스케줄 실행 실패:', e.message));
}

module.exports = { collectAllSkuData, scheduleSkuScoreUpdate };

// CLI 직접 실행
if (require.main === module) {
  collectAllSkuData()
    .then(result => {
      console.log('\n결과:', JSON.stringify(result.summary, null, 2));
      process.exit(0);
    })
    .catch(e => {
      console.error('실패:', e);
      process.exit(1);
    });
}
