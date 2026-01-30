require('dotenv').config({ path: '../../config/.env' });
const GoogleSheetsAPI = require('../api/googleSheetsAPI');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M';

/**
 * 대시보드 필터 로직
 * - 검수 상태별 필터
 * - 플랫폼별 필터
 * - 이상 징후별 필터
 */
class DashboardFilters {
  constructor() {
    this.sheets = new GoogleSheetsAPI('../../config/credentials.json');
    this.data = [];
  }

  async initialize() {
    await this.sheets.authenticate();
    this.data = await this.sheets.readData(SPREADSHEET_ID, '시트1!A2:N');
    console.log(`✅ ${this.data.length}개 상품 로드됨\n`);
  }

  /**
   * 검수 상태별 필터
   */
  filterByStatus(status) {
    return this.data.filter(row => {
      const rowStatus = row[9]; // J열: 검수 상태
      return rowStatus === status;
    }).map((row, index) => this.formatProduct(row, index));
  }

  /**
   * 플랫폼별 필터
   */
  filterByPlatform(platform) {
    return this.data.filter(row => {
      const rowPlatform = row[10]; // K열: 플랫폼
      return rowPlatform === platform;
    }).map((row, index) => this.formatProduct(row, index));
  }

  /**
   * 마진율 기준 필터
   */
  filterByMargin(minMargin = 0, maxMargin = 100) {
    return this.data.filter(row => {
      const margin = parseFloat(row[8]); // I열: 마진율
      return !isNaN(margin) && margin >= minMargin && margin <= maxMargin;
    }).map((row, index) => this.formatProduct(row, index));
  }

  /**
   * 이상 징후만 필터
   */
  filterAnomalies() {
    return this.data.filter(row => {
      const margin = parseFloat(row[8]);
      const stock = parseFloat(row[11]);
      const recent7days = parseFloat(row[12]);
      const prev3weeks = parseFloat(row[13]);

      // 마진 위험
      if (!isNaN(margin) && margin < 5 && margin > 0) return true;

      // 재고 부족
      if (!isNaN(stock) && !isNaN(recent7days)) {
        const dailyAvg = recent7days / 7;
        const safeStock = dailyAvg * 14;
        if (stock < safeStock && stock >= 0) return true;
      }

      // 판매 급감
      if (!isNaN(recent7days) && !isNaN(prev3weeks) && prev3weeks > 0) {
        const threshold = prev3weeks * 0.3;
        if (recent7days < threshold) return true;
      }

      return false;
    }).map((row, index) => this.formatProduct(row, index));
  }

  /**
   * 검수 대기 상품만 (알바생용)
   */
  getPendingReview() {
    return this.filterByStatus('검수대기');
  }

  /**
   * 상품 데이터 포맷팅
   */
  formatProduct(row, index) {
    const [sku, name, purchase, price, rate, fee, shipping, profit, margin, status, platform, stock, recent7days, prev3weeks] = row;

    return {
      index: index + 2, // 시트 행 번호
      sku,
      name,
      platform: platform || 'Shopify',
      price: parseFloat(price) || 0,
      purchase: parseFloat(purchase) || 0,
      shipping: parseFloat(shipping) || 0,
      profit: parseFloat(profit) || 0,
      margin: parseFloat(margin) || 0,
      status: status || '검수대기',
      stock: parseFloat(stock) || 0,
      recent7days: parseFloat(recent7days) || 0,
      prev3weeks: parseFloat(prev3weeks) || 0
    };
  }

  /**
   * 통계 요약
   */
  getStatistics() {
    const stats = {
      total: this.data.length,
      byStatus: {},
      byPlatform: {},
      avgMargin: 0,
      lowMarginCount: 0,
      totalProfit: 0
    };

    let marginSum = 0;
    let marginCount = 0;

    this.data.forEach(row => {
      const status = row[9] || '검수대기';
      const platform = row[10] || 'Shopify';
      const margin = parseFloat(row[8]);
      const profit = parseFloat(row[7]);

      // 상태별 집계
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

      // 플랫폼별 집계
      stats.byPlatform[platform] = (stats.byPlatform[platform] || 0) + 1;

      // 마진 계산
      if (!isNaN(margin)) {
        marginSum += margin;
        marginCount++;
        if (margin < 5 && margin > 0) {
          stats.lowMarginCount++;
        }
      }

      // 총 이익
      if (!isNaN(profit) && profit > 0) {
        stats.totalProfit += profit;
      }
    });

    stats.avgMargin = marginCount > 0 ? marginSum / marginCount : 0;

    return stats;
  }
}

// CLI 테스트
async function testFilters() {
  console.log('=== 대시보드 필터 테스트 ===\n');

  const dashboard = new DashboardFilters();
  await dashboard.initialize();

  // 통계
  console.log('📊 전체 통계:');
  const stats = dashboard.getStatistics();
  console.log(`   총 상품: ${stats.total}개`);
  console.log(`   평균 마진율: ${stats.avgMargin.toFixed(2)}%`);
  console.log(`   마진 위험: ${stats.lowMarginCount}개`);
  console.log(`   총 이익: ${stats.totalProfit.toLocaleString()} KRW\n`);

  console.log('   상태별:');
  Object.entries(stats.byStatus).forEach(([status, count]) => {
    console.log(`     - ${status}: ${count}개`);
  });

  console.log('\n   플랫폼별:');
  Object.entries(stats.byPlatform).forEach(([platform, count]) => {
    console.log(`     - ${platform}: ${count}개`);
  });

  // 필터 테스트
  console.log('\n🔍 필터 테스트:');
  const pending = dashboard.getPendingReview();
  console.log(`   검수대기: ${pending.length}개`);

  const lowMargin = dashboard.filterByMargin(0, 5);
  console.log(`   마진 < 5%: ${lowMargin.length}개`);

  const anomalies = dashboard.filterAnomalies();
  console.log(`   이상 징후: ${anomalies.length}개`);

  if (anomalies.length > 0) {
    console.log('\n   이상 징후 샘플:');
    anomalies.slice(0, 3).forEach((product, i) => {
      console.log(`     ${i + 1}. ${product.sku} - ${product.name}`);
      console.log(`        마진율: ${product.margin.toFixed(2)}%`);
    });
  }
}

if (require.main === module) {
  testFilters();
}

module.exports = DashboardFilters;
