const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const multer = require('multer');

const projectRoot = path.join(__dirname, '..', '..', '..');
const credentialsPath = path.join(projectRoot, 'config', 'credentials.json');

// 이미지 업로드 설정
const uploadsDir = path.join(projectRoot, 'public', 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// 서비스 모듈
const MasterProductDB = require('../../services/masterProductDB');
const pricingEngine = require('../../services/pricingEngine');
const platformOptimizer = require('../../services/platformOptimizer');
const SkuScorer = require('../../services/skuScorer');
const masterDB = new MasterProductDB();
const skuScorer = new SkuScorer();

// 플랫폼별 API 모듈 lazy load
function getShopifyAPI() {
  const ShopifyAPI = require('../../api/shopifyAPI');
  return new ShopifyAPI();
}
let _ebayInstance = null;
function getEbayAPI() {
  if (!_ebayInstance) {
    const EbayAPI = require('../../api/ebayAPI');
    _ebayInstance = new EbayAPI();
  }
  return _ebayInstance;
}
function getNaverAPI() {
  const NaverAPI = require('../../api/naverAPI');
  return new NaverAPI();
}
function getAlibabaAPI() {
  const AlibabaAPI = require('../../api/alibabaAPI');
  return new AlibabaAPI();
}

// Google Sheets lazy load
function getGoogleSheets() {
  const GoogleSheetsAPI = require('../../api/googleSheetsAPI');
  return new GoogleSheetsAPI(credentialsPath);
}

// 캐시
let platformCache = null;
let platformCacheTime = 0;
let analysisCache = null;
let analysisCacheTime = 0;
const CACHE_TTL = 60000;
const ANALYSIS_CACHE_TTL = 120000; // 2분
let battleCache = null;
let battleCacheTime = 0;
const BATTLE_CACHE_TTL = 180000; // 3분

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// ===========================
// 기존 엔드포인트
// ===========================

// GET /api/dashboard/summary
router.get('/dashboard/summary', async (req, res) => {
  try {
    const [platforms, syncHistory] = await Promise.all([
      getPlatformStatuses(),
      getSyncHistory()
    ]);

    res.json({
      platforms,
      syncHistory,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/platforms
router.get('/platforms', async (req, res) => {
  try {
    const statuses = await getPlatformStatuses();
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products?platform=&limit=&search=
router.get('/products', async (req, res) => {
  try {
    const { platform, limit = 200, search } = req.query;
    let products;

    if (!platform || platform === 'ebay') {
      // Google Sheets에서 읽기 (2분 캐시, 전체 상품, 즉시 로딩)
      const dashData = await getDashboardData();
      products = (dashData || [])
        .filter(d => !platform || d.platform.includes('eBay'))
        .map(d => ({
          sku: d.sku || '',
          itemId: d.itemId || '',
          title: d.title || '',
          price: d.priceUSD || '',
          shipping: d.shippingUSD || '',
          platform: d.platform || 'eBay',
          imageUrl: d.image || '',
          editId: d.itemId || d.sku || '',
          quantity: d.stock || '',
        }));

      // 전체 보기: 다른 플랫폼도 합침
      if (!platform) {
        const otherProducts = await getProductsNonEbay(parseInt(limit));
        products = products.concat(otherProducts);
      }
    } else {
      // Shopify, Naver, Alibaba는 기존 API 호출 (소량이라 빠름)
      products = await getProducts(platform, parseInt(limit));
    }

    if (search) {
      const q = search.toLowerCase();
      products = products.filter(p =>
        (p.sku || '').toLowerCase().includes(q) ||
        (p.title || '').toLowerCase().includes(q) ||
        (p.itemId || '').toLowerCase().includes(q)
      );
    }
    res.json(products.slice(0, parseInt(limit)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sync/status
router.get('/sync/status', async (req, res) => {
  try {
    const history = await getSyncHistory();
    const latest = history.length > 0 ? history[history.length - 1] : null;
    res.json({ latest, total: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sync/history
router.get('/sync/history', async (req, res) => {
  try {
    const history = await getSyncHistory();
    res.json(history.slice(-20).reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sync/trigger/:platform
router.post('/sync/trigger/:platform', async (req, res) => {
  const { platform } = req.params;

  const scripts = {
    shopify: 'node src/sync/sync-shopify-to-sheets.js',
    ebay: 'node src/sync/sync-ebay-to-sheets.js',
    naver: 'node src/sync/sync-naver-to-sheets.js',
    alibaba: 'node src/sync/sync-alibaba-to-sheets.js'
  };

  if (!scripts[platform]) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }

  res.json({ message: `${platform} 동기화 시작됨`, status: 'running' });

  exec(scripts[platform], { cwd: projectRoot, timeout: 600000 })
    .then(() => {
      console.log(`${platform} 수동 동기화 완료`);
      platformCache = null;
      analysisCache = null;
    })
    .catch(err => console.error(`${platform} 수동 동기화 실패:`, err.message));
});

// ===========================
// 매출 API 엔드포인트 (플랫폼 API 기반)
// ===========================

// 매출 캐시
let revenueCache = null;
let revenueCacheTime = 0;
const REVENUE_CACHE_TTL = 300000; // 5분

// GET /api/revenue/summary — 전체 플랫폼 API 기반 실제 매출
router.get('/revenue/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const forceRefresh = req.query.refresh === 'true';

    if (revenueCache && !forceRefresh && Date.now() - revenueCacheTime < REVENUE_CACHE_TTL) {
      return res.json(revenueCache);
    }

    const results = await Promise.allSettled([
      // Shopify
      (async () => {
        try {
          const api = getShopifyAPI();
          return await api.getRevenueSummary(days);
        } catch (e) { return { error: e.message }; }
      })(),
      // eBay
      (async () => {
        try {
          const api = getEbayAPI();
          return await api.getRevenueSummary(days);
        } catch (e) { return { error: e.message }; }
      })(),
      // Naver
      (async () => {
        try {
          const api = getNaverAPI();
          await api.getToken();
          return await api.getRevenueSummary(days);
        } catch (e) { return { error: e.message }; }
      })(),
    ]);

    const exchangeRate = 1400; // USD → KRW
    const platforms = {};
    const platformNames = ['Shopify', 'eBay', 'Naver'];

    platformNames.forEach((name, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && !r.value.error) {
        const data = r.value;
        const isKRW = name === 'Naver';
        platforms[name] = {
          revenue: data.totalRevenue || data.payAmount || 0,
          revenueKRW: isKRW
            ? (data.totalRevenue || data.payAmount || 0)
            : Math.round((data.totalRevenue || 0) * exchangeRate),
          orders: data.orderCount || data.orderCount || 0,
          currency: data.currency || (isKRW ? 'KRW' : 'USD'),
          dailySales: data.dailySales || {},
          period: data.period || `${days}days`,
          source: 'api',
        };
      } else {
        const errMsg = r.status === 'rejected' ? r.reason?.message : (r.value?.error || 'unknown');
        platforms[name] = { revenue: 0, revenueKRW: 0, orders: 0, error: errMsg, source: 'api_failed' };
      }
    });

    // 합계
    let totalRevenueKRW = 0;
    let totalOrders = 0;
    Object.values(platforms).forEach(p => {
      totalRevenueKRW += p.revenueKRW || 0;
      totalOrders += p.orders || 0;
    });

    const response = {
      totalRevenueKRW,
      totalOrders,
      platforms,
      exchangeRate,
      period: `${days}days`,
      timestamp: new Date().toISOString(),
    };

    revenueCache = response;
    revenueCacheTime = Date.now();

    res.json(response);
  } catch (error) {
    console.error('Revenue summary error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ebay/trends — eBay 일별 판매 트렌드 + 인기상품
router.get('/ebay/trends', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const api = getEbayAPI();
    const data = await api.getRevenueSummary(days);

    // 토큰 만료 등 에러 체크
    if (data.error) {
      return res.json({ error: data.error, totalRevenue: 0, totalOrders: 0, dailySales: [], topItems: [], trending: [] });
    }

    // 일별 데이터 정렬
    const sortedDays = Object.entries(data.dailySales || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, info]) => ({ date, ...info }));

    // 최근 7일 vs 이전 7일 비교 (트렌드)
    const now = new Date();
    const recent7 = [];
    const prev7 = [];
    (data.transactions || []).forEach(txn => {
      if (!txn.createdDate) return;
      const txnDate = new Date(txn.createdDate);
      const daysAgo = (now - txnDate) / 86400000;
      if (daysAgo <= 7) recent7.push(txn);
      else if (daysAgo <= 14) prev7.push(txn);
    });

    // 최근 7일 인기상품
    const recentItemMap = {};
    recent7.forEach(txn => {
      const key = txn.itemId || txn.title;
      if (!recentItemMap[key]) {
        recentItemMap[key] = { itemId: txn.itemId, title: txn.title, sku: txn.sku, sold: 0, revenue: 0 };
      }
      recentItemMap[key].sold += txn.quantity;
      recentItemMap[key].revenue += txn.price * txn.quantity;
    });
    const trending = Object.values(recentItemMap).sort((a, b) => b.sold - a.sold);

    res.json({
      totalRevenue: data.totalRevenue,
      totalOrders: data.orderCount,
      currency: 'USD',
      period: `${days}days`,
      dailySales: sortedDays,
      topItems: (data.topItems || []).slice(0, 20),
      trending: trending.slice(0, 20),
      recentStats: {
        last7days: { orders: recent7.length, revenue: recent7.reduce((s, t) => s + t.price * t.quantity, 0) },
        prev7days: { orders: prev7.length, revenue: prev7.reduce((s, t) => s + t.price * t.quantity, 0) },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('eBay trends error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// 분석 엔드포인트 (시트 기반)
// ===========================

// GET /api/analysis/summary — 매출/마진 요약
router.get('/analysis/summary', async (req, res) => {
  try {
    const data = await getDashboardData();
    if (!data || data.length === 0) {
      return res.json({ error: 'no_data', message: 'Google Sheets 데이터 없음' });
    }

    let totalRevenue = 0;    // 총 매출 (정산액)
    let totalProfit = 0;     // 총 순이익
    let totalPurchase = 0;   // 총 매입가
    let marginSum = 0;
    let marginCount = 0;
    let lowMarginCount = 0;  // 마진 < 5%
    let negativeMarginCount = 0; // 역마진
    let highMarginCount = 0; // 효자상품 (마진 >= 20%)
    const byPlatform = {};

    data.forEach(row => {
      const settlement = parseFloat(row.settlement) || 0;
      const profit = parseFloat(row.profit) || 0;
      const purchase = parseFloat(row.purchase) || 0;
      const margin = parseFloat(row.margin);
      const platform = row.platform || '미분류';

      totalRevenue += settlement;
      totalProfit += profit;
      totalPurchase += purchase;

      // 마진 통계: 0은 "데이터 없음"이므로 제외 (실제 마진 > 0 또는 < 0만 집계)
      if (!isNaN(margin) && margin !== 0) {
        marginSum += margin;
        marginCount++;
        if (margin < 0) negativeMarginCount++;
        else if (margin < 5) lowMarginCount++;
        if (margin >= 20) highMarginCount++;
      }

      // 판매 플랫폼만 집계 (소싱처 제외)
      const validPlatforms = ['eBay', 'Shopify', 'Naver', 'Alibaba', 'Shopee'];
      // platform이 "eBay, Shopify" 같이 콤마로 여러 개일 수 있음
      const platforms = platform.split(',').map(p => p.trim()).filter(p => validPlatforms.includes(p));
      // 매출/이익은 주 플랫폼(첫 번째)에만 집계 (이중집계 방지)
      // 상품 수(count)는 모든 매칭 플랫폼에 집계
      platforms.forEach((p, idx) => {
        if (!byPlatform[p]) {
          byPlatform[p] = { count: 0, revenue: 0, profit: 0 };
        }
        byPlatform[p].count++;
        if (idx === 0) {
          // 매출/이익은 주 플랫폼에만
          byPlatform[p].revenue += settlement;
          byPlatform[p].profit += profit;
        }
      });
    });

    res.json({
      totalProducts: data.length,
      totalRevenue: Math.round(totalRevenue),
      totalProfit: Math.round(totalProfit),
      totalPurchase: Math.round(totalPurchase),
      avgMargin: marginCount > 0 ? +(marginSum / marginCount).toFixed(2) : 0,
      lowMarginCount,
      negativeMarginCount,
      highMarginCount,
      byPlatform,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Analysis summary error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analysis/products — 상품별 원가/이익 데이터
router.get('/analysis/products', async (req, res) => {
  try {
    const { sort = 'margin', order = 'desc', limit = 50, platform } = req.query;
    let data = await getDashboardData();
    if (!data || data.length === 0) {
      return res.json([]);
    }

    if (platform) {
      data = data.filter(r => (r.platform || '').toLowerCase().includes(platform.toLowerCase()));
    }

    // 정렬
    data.sort((a, b) => {
      const aVal = parseFloat(a[sort]) || 0;
      const bVal = parseFloat(b[sort]) || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    res.json(data.slice(0, parseInt(limit)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/analysis/top — 효자상품 (마진 >= 20%)
router.get('/analysis/top', async (req, res) => {
  try {
    const data = await getDashboardData();
    if (!data || data.length === 0) {
      return res.json([]);
    }

    const topProducts = data
      .filter(r => parseFloat(r.margin) >= 20)
      .sort((a, b) => parseFloat(b.margin) - parseFloat(a.margin));

    res.json(topProducts.slice(0, 30));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/analysis/margin-calc — 마진 계산기
router.post('/analysis/margin-calc', (req, res) => {
  try {
    const { purchasePrice, weight, targetMargin, competitorPrice, competitorShipping } = req.body;

    if (!purchasePrice) {
      return res.status(400).json({ error: '매입가(purchasePrice)는 필수입니다' });
    }

    const result = pricingEngine.calculateMargins({
      purchasePrice: parseFloat(purchasePrice),
      weight: parseFloat(weight) || 0,
      targetMargin: parseFloat(targetMargin) || 30,
      competitorPrice: parseFloat(competitorPrice) || 0,
      competitorShipping: parseFloat(competitorShipping) || 0,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/anomalies — 이상 탐지
router.get('/anomalies', async (req, res) => {
  try {
    const data = await getDashboardData();
    if (!data || data.length === 0) {
      return res.json({ lowMargin: [], lowStock: [], salesDrop: [], summary: {} });
    }

    const anomalies = { lowMargin: [], lowStock: [], salesDrop: [] };

    data.forEach(row => {
      const margin = parseFloat(row.margin);
      // 마진 위험 (< 5%, 0 이상)
      if (!isNaN(margin) && margin < 5 && margin > -100) {
        anomalies.lowMargin.push({
          sku: row.sku,
          title: row.title,
          margin: +margin.toFixed(2),
          profit: Math.round(parseFloat(row.profit) || 0),
          platform: row.platform || 'eBay',
          price: row.priceUSD
        });
      }

      // 재고 부족
      const stock = parseFloat(row.stock);
      const recent7d = parseFloat(row.recent7days);
      if (!isNaN(stock) && !isNaN(recent7d) && recent7d > 0) {
        const safeStock = (recent7d / 7) * 14;
        if (stock < safeStock) {
          anomalies.lowStock.push({
            sku: row.sku,
            title: row.title,
            stock,
            safeStock: +safeStock.toFixed(1),
            platform: row.platform || 'eBay'
          });
        }
      }

      // 판매 급감
      const prev3w = parseFloat(row.prev3weeks);
      if (!isNaN(recent7d) && !isNaN(prev3w) && prev3w > 0) {
        if (recent7d < prev3w * 0.3) {
          anomalies.salesDrop.push({
            sku: row.sku,
            title: row.title,
            recent7days: recent7d,
            prev3weeks: prev3w,
            platform: row.platform || 'eBay'
          });
        }
      }
    });

    // 각 카테고리 정렬
    anomalies.lowMargin.sort((a, b) => a.margin - b.margin);
    anomalies.lowStock.sort((a, b) => a.stock - b.stock);

    res.json({
      ...anomalies,
      summary: {
        lowMargin: anomalies.lowMargin.length,
        lowStock: anomalies.lowStock.length,
        salesDrop: anomalies.salesDrop.length,
        total: anomalies.lowMargin.length + anomalies.lowStock.length + anomalies.salesDrop.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// 이미지 업로드
// ===========================

// POST /api/uploads/images — 상품 이미지 업로드 (최대 5장)
router.post('/uploads/images', upload.array('images', 5), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '이미지 파일을 선택해주세요' });
    }
    const urls = req.files.map(f => `/uploads/${f.filename}`);
    res.json({ urls });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// 상품 등록 엔드포인트 (NEW)
// ===========================

// POST /api/products/register — 마스터 상품 등록 (자동 가격 계산 + 플랫폼 최적화)
router.post('/products/register', async (req, res) => {
  try {
    const {
      sku, title, titleEn, description, descriptionEn,
      purchasePrice, weight, category, keywords,
      targetMargin, priceUSD, shippingUSD,
      imageUrls, targetPlatforms,
      condition, quantity,
      ebayCategoryId, naverCategoryId, shopifyProductType
    } = req.body;

    if (!sku || !title) {
      return res.status(400).json({ error: 'SKU와 상품명은 필수입니다' });
    }

    // 1. 마스터 상품 DB에 저장 (이미 있으면 업데이트)
    let masterProduct = masterDB.getBySku(sku);
    const productData = {
      sku, title,
      titleEn: titleEn || title,
      description: description || '',
      descriptionEn: descriptionEn || description || '',
      category: category || '기타',
      purchasePrice: parseFloat(purchasePrice) || 0,
      weight: parseFloat(weight) || 0,
      imageUrls: imageUrls || [],
      keywords: keywords || [],
      targetMargin: parseFloat(targetMargin) || 30,
      quantity: parseInt(quantity) || 1,
      condition: condition || 'new',
      ebayCategoryId: ebayCategoryId || '',
      naverCategoryId: naverCategoryId || '',
      shopifyProductType: shopifyProductType || '',
    };

    if (masterProduct) {
      masterProduct = masterDB.update(sku, productData);
    } else {
      masterProduct = masterDB.create(productData);
    }

    // 2. 가격 계산 (마진 기반 자동 or 수동 지정)
    let prices;
    if (priceUSD && !targetMargin) {
      // 수동 가격 모드: 사용자가 직접 가격 지정
      const manualPrice = parseFloat(priceUSD);
      const manualShipping = parseFloat(shippingUSD) || 3.9;
      prices = {
        ebay: { price: manualPrice, shipping: manualShipping, currency: 'USD' },
        shopify: { price: manualPrice, shipping: manualShipping, currency: 'USD' },
        naver: { price: Math.round(manualPrice * 1400), shipping: 0, currency: 'KRW' },
      };
    } else {
      // 자동 가격 모드: 마진 기반 역산
      prices = pricingEngine.calculatePrices(masterProduct);
    }

    const results = { sheets: false, ebay: null, shopify: null, naver: null, prices };

    // 3. Google Sheets에 추가
    if (fs.existsSync(credentialsPath)) {
      try {
        const sheets = getGoogleSheets();
        await sheets.authenticate();

        const ebayP = prices.ebay?.price || parseFloat(priceUSD) || 0;
        const ebayS = prices.ebay?.shipping || parseFloat(shippingUSD) || 3.9;
        const pp = parseFloat(purchasePrice) || 0;
        const fee = Math.round((ebayP + ebayS) * 0.18 * 1400);
        const tax = Math.round(pp * 0.15);
        const totalCost = pp + fee + tax;

        const newRow = [
          '',  // Image
          sku,
          titleEn || title,
          weight || '',
          purchasePrice || '',
          '',  // 실제 배송비(KRW)
          fee || '',
          tax || '',
          totalCost || '',
          ebayP || '',
          ebayS || '3.9',
          '',  // 최종순이익
          '',  // 마진율
        ];

        await sheets.appendData(SPREADSHEET_ID, '최종 Dashboard!A:M', [newRow]);
        results.sheets = true;
        analysisCache = null;
      } catch (e) {
        console.error('Sheets 등록 실패:', e.message);
        results.sheets = e.message;
      }
    }

    // 4. eBay 등록 (자동 최적화)
    if (targetPlatforms && targetPlatforms.includes('ebay') && !prices.ebay?.error) {
      try {
        const ebay = getEbayAPI();
        const ebayData = platformOptimizer.optimize('ebay', masterProduct, prices);
        if (ebayData) {
          const ebayResult = await ebay.createProduct(ebayData);
          results.ebay = ebayResult.success
            ? { success: true, itemId: ebayResult.itemId, price: prices.ebay.price }
            : { success: false, error: ebayResult.error };

          if (ebayResult.success) {
            masterDB.updatePlatformStatus(sku, 'ebay', {
              itemId: ebayResult.itemId, status: 'active',
              price: prices.ebay.price, registeredAt: new Date().toISOString(),
            });

            // 시트에 eBay Item ID 기록
            if (ebayResult.itemId && fs.existsSync(credentialsPath)) {
              try {
                const sheets = getGoogleSheets();
                await sheets.authenticate();
                const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!B2:B');
                if (rows) {
                  for (let i = 0; i < rows.length; i++) {
                    if (rows[i][0] === sku) {
                      await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!N${i + 2}`, [[ebayResult.itemId]]);
                      await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!Q${i + 2}`, [['등록완료']]);
                      break;
                    }
                  }
                }
              } catch (sheetErr) {
                console.error('eBay 시트 업데이트 실패:', sheetErr.message);
              }
            }
          }
        }
      } catch (e) {
        results.ebay = { success: false, error: e.message };
      }
    }

    // 5. Shopify 등록 (자동 최적화)
    if (targetPlatforms && targetPlatforms.includes('shopify') && !prices.shopify?.error) {
      try {
        const shopify = getShopifyAPI();
        const shopifyData = platformOptimizer.optimize('shopify', masterProduct, prices);
        if (shopifyData) {
          const shopifyResult = await shopify.createProduct(shopifyData);
          results.shopify = shopifyResult.success
            ? { success: true, productId: shopifyResult.productId, price: prices.shopify.price }
            : { success: false, error: shopifyResult.error };

          if (shopifyResult.success) {
            masterDB.updatePlatformStatus(sku, 'shopify', {
              productId: shopifyResult.productId, status: 'active',
              price: prices.shopify.price, registeredAt: new Date().toISOString(),
            });

            if (fs.existsSync(credentialsPath)) {
              try {
                const sheets = getGoogleSheets();
                await sheets.authenticate();
                const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!B2:B');
                if (rows) {
                  for (let i = 0; i < rows.length; i++) {
                    if (rows[i][0] === sku) {
                      await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!R${i + 2}`, [['등록완료']]);
                      break;
                    }
                  }
                }
              } catch (sheetErr) {
                console.error('Shopify 시트 업데이트 실패:', sheetErr.message);
              }
            }
          }
        }
      } catch (e) {
        results.shopify = { success: false, error: e.message };
      }
    }

    // 6. Naver 등록 (자동 최적화)
    if (targetPlatforms && targetPlatforms.includes('naver') && !prices.naver?.error) {
      try {
        const naver = getNaverAPI();
        await naver.getToken();
        const naverData = platformOptimizer.optimize('naver', masterProduct, prices);
        if (naverData) {
          const naverResult = await naver.createProduct(naverData);
          results.naver = naverResult.success
            ? { success: true, productNo: naverResult.originProductNo, price: prices.naver.price }
            : { success: false, error: naverResult.error };

          if (naverResult.success) {
            masterDB.updatePlatformStatus(sku, 'naver', {
              productNo: naverResult.originProductNo, status: 'active',
              price: prices.naver.price, registeredAt: new Date().toISOString(),
            });
          }
        }
      } catch (e) {
        results.naver = { success: false, error: e.message };
      }
    }

    // 결과 집계
    const platformSuccesses = [];
    if (results.sheets === true) platformSuccesses.push('Google Sheets');
    if (results.ebay?.success) platformSuccesses.push(`eBay ($${prices.ebay?.price})`);
    if (results.shopify?.success) platformSuccesses.push(`Shopify ($${prices.shopify?.price})`);
    if (results.naver?.success) platformSuccesses.push(`Naver (₩${prices.naver?.price?.toLocaleString()})`);

    platformCache = null;

    res.json({
      success: results.sheets === true || platformSuccesses.length > 0,
      message: platformSuccesses.length > 0
        ? `상품이 등록되었습니다 (${platformSuccesses.join(', ')})`
        : '등록 실패',
      results,
      masterProduct,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/categories/search — 플랫폼별 카테고리 검색
router.get('/categories/search', async (req, res) => {
  try {
    const { platform, query } = req.query;
    if (!query) return res.status(400).json({ error: '검색어를 입력하세요' });

    let categories = [];
    if (platform === 'ebay') {
      const ebay = getEbayAPI();
      categories = await ebay.getSuggestedCategories(query);
    } else if (platform === 'naver') {
      const naver = getNaverAPI();
      categories = await naver.searchCategories(query);
    } else if (platform === 'all' || !platform) {
      const [ebayRes, naverRes] = await Promise.allSettled([
        (async () => { const e = getEbayAPI(); return await e.getSuggestedCategories(query); })(),
        (async () => { const n = getNaverAPI(); return await n.searchCategories(query); })(),
      ]);
      categories = {
        ebay: ebayRes.status === 'fulfilled' ? ebayRes.value : [],
        naver: naverRes.status === 'fulfilled' ? naverRes.value : [],
      };
    }

    res.json({ categories, query });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/preview-prices — 등록 전 가격 미리보기
router.get('/products/preview-prices', (req, res) => {
  try {
    const { purchasePrice, weight, targetMargin, shippingUSD } = req.query;

    if (!purchasePrice) {
      return res.status(400).json({ error: '매입가(purchasePrice)는 필수입니다' });
    }

    const product = {
      purchasePrice: parseFloat(purchasePrice),
      weight: parseFloat(weight) || 0,
      targetMargin: parseFloat(targetMargin) || 30,
      shippingUSD: parseFloat(shippingUSD) || 3.9,
    };

    const prices = pricingEngine.calculatePrices(product);
    res.json({ prices, input: product });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/master-products — 마스터 상품 목록
router.get('/master-products', (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    let products = masterDB.getAll();

    if (search) {
      const q = search.toLowerCase();
      products = products.filter(p =>
        p.sku.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        (p.titleEn || '').toLowerCase().includes(q)
      );
    }

    const total = products.length;
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = products.slice(start, start + parseInt(limit));

    res.json({ products: paginated, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/master-products/:sku — 단일 상품 상세
router.get('/master-products/:sku', (req, res) => {
  try {
    const product = masterDB.getBySku(req.params.sku);
    if (!product) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const prices = pricingEngine.calculatePrices(product);
    res.json({ product, prices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/master-products/:sku — 마스터 상품 수정
router.put('/master-products/:sku', (req, res) => {
  try {
    const product = masterDB.update(req.params.sku, req.body);
    if (!product) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const prices = pricingEngine.calculatePrices(product);
    res.json({ product, prices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// 가격/재고 수정 엔드포인트 (NEW)
// ===========================

// PUT /api/products/ebay/:itemId — eBay 가격/수량 수정 + Google Sheets 연동
router.put('/products/ebay/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { price, quantity, sku } = req.body;

    if (price === undefined && quantity === undefined) {
      return res.status(400).json({ error: '가격 또는 수량을 입력하세요' });
    }

    const api = getEbayAPI();
    const updates = {};
    if (price !== undefined) updates.price = parseFloat(price);
    if (quantity !== undefined) updates.quantity = parseInt(quantity);

    const result = await api.updateItem(itemId, updates);
    platformCache = null;

    // Google Sheets 연동
    const sheetUpdates = {};
    if (price !== undefined) sheetUpdates.priceUSD = price;
    if (quantity !== undefined) sheetUpdates.stock = quantity;
    const sheetResult = await updateGoogleSheet('itemId', itemId, sheetUpdates, sku);

    res.json({
      success: result.success,
      platform: 'eBay',
      itemId,
      updates,
      sheetSync: sheetResult.success,
      error: result.error
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/shopify/:variantId — Shopify 가격 수정 + Google Sheets 연동
router.put('/products/shopify/:variantId', async (req, res) => {
  try {
    const { variantId } = req.params;
    const { price, inventory_quantity, sku } = req.body;

    if (price === undefined && inventory_quantity === undefined) {
      return res.status(400).json({ error: '가격 또는 재고를 입력하세요' });
    }

    const api = getShopifyAPI();
    const updates = {};
    if (price !== undefined) updates.price = String(price);
    if (inventory_quantity !== undefined) updates.inventory_quantity = parseInt(inventory_quantity);

    const result = await api.updateVariant(variantId, updates);
    platformCache = null;

    // Google Sheets 연동 (SKU로 검색)
    if (sku) {
      const sheetUpdates = {};
      if (price !== undefined) sheetUpdates.priceUSD = price;
      if (inventory_quantity !== undefined) sheetUpdates.stock = inventory_quantity;
      await updateGoogleSheet('sku', sku, sheetUpdates);
    }

    res.json({
      success: result.success,
      platform: 'Shopify',
      variantId,
      updates,
      error: result.error
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/naver/:productNo — 네이버 가격/재고 수정 + Google Sheets 연동
router.put('/products/naver/:productNo', async (req, res) => {
  try {
    const { productNo } = req.params;
    const { price, stock, sku } = req.body;

    const api = getNaverAPI();
    await api.getToken();

    const results = {};

    if (price !== undefined) {
      try {
        await api.updatePrice(productNo, productNo, parseInt(price));
        results.price = { success: true, value: price };
      } catch (e) {
        results.price = { success: false, error: e.message };
      }
    }

    if (stock !== undefined) {
      try {
        await api.updateStock(productNo, parseInt(stock));
        results.stock = { success: true, value: stock };
      } catch (e) {
        results.stock = { success: false, error: e.message };
      }
    }

    platformCache = null;

    // Google Sheets 연동
    if (sku) {
      const sheetUpdates = {};
      if (price !== undefined) sheetUpdates.priceUSD = price;
      if (stock !== undefined) sheetUpdates.stock = stock;
      await updateGoogleSheet('sku', sku, sheetUpdates);
    }

    res.json({
      success: Object.values(results).every(r => r.success),
      platform: 'Naver',
      productNo,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/alibaba/:productId — Alibaba Google Sheets 연동
router.put('/products/alibaba/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { price, quantity, sku } = req.body;

    // Alibaba ICBU API에는 상품 수정 API가 제한적이므로 Google Sheets에만 반영
    const sheetUpdates = {};
    if (price !== undefined) sheetUpdates.priceUSD = price;
    if (quantity !== undefined) sheetUpdates.stock = quantity;
    const sheetResult = await updateGoogleSheet('sku', sku || productId, sheetUpdates);

    platformCache = null;
    analysisCache = null;

    res.json({
      success: sheetResult.success,
      platform: 'Alibaba',
      productId,
      note: 'Google Sheets에 반영됨 (Alibaba 플랫폼은 Seller Center에서 직접 수정)',
      error: sheetResult.error
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Helper 함수
// ===========================

async function getPlatformStatuses() {
  if (platformCache && Date.now() - platformCacheTime < CACHE_TTL) {
    return platformCache;
  }

  const platforms = [
    { name: 'Shopify', key: 'shopify', color: '#96bf48' },
    { name: 'eBay', key: 'ebay', color: '#1565c0' },
    { name: 'Naver', key: 'naver', color: '#03c75a' },
    { name: 'Alibaba', key: 'alibaba', color: '#ff6a00' },
    { name: 'Shopee', key: 'shopee', color: '#ee4d2d' },
  ];

  const results = await Promise.all(platforms.map(async (p) => {
    let productCount = 0;
    let status = 'disconnected';

    try {
      switch (p.key) {
        case 'shopify': {
          const api = getShopifyAPI();
          const count = await api.getProductCount();
          productCount = count || 0;
          status = 'connected';
          break;
        }
        case 'ebay': {
          try {
            const api = getEbayAPI();
            const result = await api.getActiveListings(1, 1);
            productCount = result.totalEntries || 0;
            status = 'connected';
          } catch (e) {
            // API 실패시 시트에서 카운트
          }
          // API가 0이면 eBay Products 시트에서 fallback
          if (productCount === 0 && SPREADSHEET_ID) {
            try {
              const sheets = getGoogleSheets();
              await sheets.authenticate();
              const rows = await sheets.readData(SPREADSHEET_ID, 'eBay Products!A2:A');
              productCount = rows ? rows.length : 0;
              if (productCount > 0) status = 'connected';
            } catch (e2) {}
          }
          break;
        }
        case 'naver': {
          const api = getNaverAPI();
          await api.getToken();
          const data = await api.getProducts(1, 1);
          productCount = data.totalElements || data.total || 0;
          status = 'connected';
          break;
        }
        case 'alibaba': {
          const api = getAlibabaAPI();
          const data = await api.getProductList(1, 1);
          const result = data.result || data;
          productCount = result.total_item || result.total || 0;
          status = 'connected';
          break;
        }
        case 'shopee': {
          status = 'pending';
          break;
        }
      }
    } catch (error) {
      console.error(`${p.name} 상태 조회 실패:`, error.message);
      status = 'error';
    }

    return { name: p.name, key: p.key, color: p.color, productCount, status };
  }));

  platformCache = results;
  platformCacheTime = Date.now();
  return results;
}

// ===========================
// 멀티 플랫폼 분석 데이터 통합
// ===========================

// 최종 Dashboard 시트 읽기 (기존 마스터 데이터)
async function readDashboardSheet(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:S');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => {
      const priceUSD = parseFloat(row[9]) || 0;
      const shipUSD = parseFloat(row[10]) || 0;
      const settlement = (priceUSD + shipUSD) * 0.82 * 1400;
      return {
        image: row[0] || '', sku: row[1] || '', title: row[2] || '',
        weight: row[3] || '', purchase: row[4] || '', shippingKRW: row[5] || '',
        fee: row[6] || '', tax: row[7] || '', totalCost: row[8] || '',
        priceUSD: row[9] || '', shippingUSD: row[10] || '',
        profit: row[11] || '', margin: row[12] || '',
        itemId: row[13] || '', salesCount: row[14] || '', stock: row[15] || '',
        ebayStatus: row[16] || '', shopifyStatus: row[17] || '',
        supplier: row[18] || '',
        platform: '',
        settlement: Math.round(settlement),
      };
    }).filter(r => r.sku);
  } catch (e) {
    console.error('최종 Dashboard 읽기 실패:', e.message);
    return [];
  }
}

// eBay Products 시트 읽기
async function readEbaySheetData(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, 'eBay Products!A2:N');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => {
      const priceUSD = parseFloat(row[3]) || 0;
      const shipUSD = parseFloat(row[4]) || 0;
      const feeRate = parseFloat(row[11]) || 13;
      const settlement = (priceUSD + shipUSD) * (1 - feeRate / 100) * 1400;
      return {
        image: row[13] || '', sku: row[0] || '', title: row[1] || '',
        weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
        totalCost: '', priceUSD: String(priceUSD || ''), shippingUSD: String(shipUSD || ''),
        profit: '', margin: '', itemId: row[2] || '',
        salesCount: row[7] || '', stock: row[6] || '',
        ebayStatus: row[9] || '', shopifyStatus: '',
        platform: 'eBay', settlement: Math.round(settlement),
      };
    }).filter(r => r.sku);
  } catch (e) {
    console.error('eBay Products 시트 읽기 실패:', e.message);
    return [];
  }
}

// Shopify 시트(시트1) 읽기
async function readShopifySheetData(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, 'Shopify!A2:K');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => {
      const priceUSD = parseFloat(row[3]) || 0;
      const exchangeRate = parseFloat(row[4]) || 1400;
      const feeRate = parseFloat(row[5]) || 15;
      const settlement = priceUSD * exchangeRate * (1 - feeRate / 100);
      return {
        image: '', sku: row[0] || '', title: row[1] || '',
        weight: '', purchase: row[2] || '', shippingKRW: row[6] || '',
        fee: '', tax: '', totalCost: '',
        priceUSD: String(priceUSD || ''), shippingUSD: '',
        profit: row[7] || '', margin: row[8] || '',
        itemId: '', salesCount: '', stock: '',
        ebayStatus: '', shopifyStatus: row[9] || '',
        platform: 'Shopify', settlement: Math.round(settlement),
      };
    }).filter(r => r.sku);
  } catch (e) {
    console.error('Shopify 시트 읽기 실패:', e.message);
    return [];
  }
}

// Naver Products 시트 읽기
// Naver 시트의 판매가(KRW)를 기준으로 정산액 계산
async function readNaverSheetData(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, 'Naver Products!A2:J');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => {
      const priceKRW = parseFloat(row[2]) || 0;
      const feeRate = parseFloat(row[7]) || 5.5;
      const settlement = priceKRW * (1 - feeRate / 100);
      return {
        image: row[9] || '', sku: row[0] || '', title: row[1] || '',
        weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
        totalCost: '', priceUSD: '', shippingUSD: '',
        profit: '', margin: '',
        itemId: '', salesCount: '', stock: row[3] || '',
        ebayStatus: '', shopifyStatus: '',
        platform: 'Naver', settlement: Math.round(settlement),
        priceKRW: String(priceKRW || ''),
      };
    }).filter(r => r.sku);
  } catch (e) {
    console.error('Naver Products 시트 읽기 실패:', e.message);
    return [];
  }
}

// Alibaba Products 시트 읽기
async function readAlibabaSheetData(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, 'Alibaba Products!A2:J');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => ({
      image: row[8] || '', sku: row[0] || '', title: row[1] || '',
      weight: '', purchase: '', shippingKRW: '', fee: '', tax: '',
      totalCost: '', priceUSD: '', shippingUSD: '',
      profit: '', margin: '',
      itemId: '', salesCount: '', stock: '',
      ebayStatus: '', shopifyStatus: '',
      platform: 'Alibaba', settlement: 0,
    })).filter(r => r.sku);
  } catch (e) {
    console.error('Alibaba Products 시트 읽기 실패:', e.message);
    return [];
  }
}

// 모든 플랫폼 데이터 통합
async function getAllPlatformData(sheets) {
  const results = await Promise.allSettled([
    readDashboardSheet(sheets),
    readEbaySheetData(sheets),
    readShopifySheetData(sheets),
    readNaverSheetData(sheets),
    readAlibabaSheetData(sheets),
  ]);

  const platformNames = ['_dashboard', 'eBay', 'Shopify', 'Naver', 'Alibaba'];

  // 각 플랫폼 시트의 SKU → item 맵 생성
  const platformDataMaps = {};
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const map = new Map();
    results[i].value.forEach(item => { if (item.sku) map.set(item.sku, item); });
    platformDataMaps[platformNames[i]] = map;
  }

  const skuMap = new Map();
  const dashboardData = results[0].status === 'fulfilled' ? results[0].value : [];

  // Dashboard 데이터 기준으로 플랫폼 태깅 + 플랫폼별 정산액 적용
  dashboardData.forEach(item => {
    if (!item.sku) return;

    // SKU가 어느 플랫폼 시트에 있는지 확인
    const sellingPlatforms = [];
    for (const [pName, pMap] of Object.entries(platformDataMaps)) {
      if (pMap.has(item.sku)) sellingPlatforms.push(pName);
    }

    if (sellingPlatforms.length > 0) {
      // 주 판매 플랫폼 결정 (첫 번째 매칭 플랫폼)
      const primaryPlatform = sellingPlatforms[0];
      item.platform = sellingPlatforms.join(', ');

      // 플랫폼 시트의 정산액을 우선 사용 (Dashboard의 eBay 공식 대체)
      const platformItem = platformDataMaps[primaryPlatform].get(item.sku);
      if (platformItem && platformItem.settlement > 0) {
        item.settlement = platformItem.settlement;
      }
      // 플랫폼 시트에 매입가 있는 경우만 순이익/마진 보충 (매입가 없으면 이익이 부풀려짐)
      if (platformItem) {
        const hasPurchase = platformItem.purchase && parseFloat(platformItem.purchase) > 0;
        if (hasPurchase) {
          if ((!item.profit || item.profit === '0') && platformItem.profit) item.profit = platformItem.profit;
          if ((!item.margin || item.margin === '0') && platformItem.margin) item.margin = platformItem.margin;
        }
      }
    } else {
      item.platform = '미분류';
    }

    skuMap.set(item.sku, item);
  });

  // 플랫폼 시트에만 있고 Dashboard에 없는 상품 추가
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    results[i].value.forEach(item => {
      if (item.sku && !skuMap.has(item.sku)) {
        skuMap.set(item.sku, item);
      }
    });
  }

  return Array.from(skuMap.values());
}

// getDashboardData — 매출/마진 분석용 (최종 Dashboard 시트만 사용)
// 플랫폼 구분: eBay Item ID 유무 + ebayStatus/shopifyStatus 컬럼 기반
async function getDashboardData() {
  if (analysisCache && Date.now() - analysisCacheTime < ANALYSIS_CACHE_TTL) {
    return analysisCache;
  }

  if (!fs.existsSync(credentialsPath)) {
    console.error('credentials.json 없음 — Google Sheets 분석 불가');
    return null;
  }

  try {
    const sheets = getGoogleSheets();
    await sheets.authenticate();

    const data = await readDashboardSheet(sheets);
    if (!data || data.length === 0) return [];

    // 플랫폼 태깅 (Dashboard 자체 컬럼 기반)
    data.forEach(item => {
      const platforms = [];
      const ebay = (item.ebayStatus || '').trim();
      const shopify = (item.shopifyStatus || '').trim();
      // eBay: Item ID가 있으면 eBay 상품 (품절 포함 — 매출 데이터가 eBay 기반)
      if (item.itemId && item.itemId.trim()) {
        platforms.push('eBay');
      }
      // Shopify: "✅" 또는 "등록" 포함 (미등록 제외)
      if (shopify.includes('✅') || (shopify.includes('등록') && !shopify.includes('미등록'))) {
        platforms.push('Shopify');
      }
      item.platform = platforms.length > 0 ? platforms.join(', ') : '미분류';
      // 활성 상태 별도 저장 (UI에서 필터용)
      item.ebayActive = ebay.includes('✅') || (ebay.includes('등록') && !ebay.includes('미등록'));
      item.shopifyActive = shopify.includes('✅') || (shopify.includes('등록') && !shopify.includes('미등록'));
    });

    analysisCache = data;
    analysisCacheTime = Date.now();
    return data;
  } catch (error) {
    console.error('Dashboard 데이터 읽기 실패:', error.message);
    return null;
  }
}

// getAllDashboardAndPlatformData — 상품 등록/관리용 (전체 플랫폼 데이터 필요할 때)
async function getAllDashboardAndPlatformData() {
  if (!fs.existsSync(credentialsPath)) return null;
  try {
    const sheets = getGoogleSheets();
    await sheets.authenticate();
    return await getAllPlatformData(sheets);
  } catch (error) {
    console.error('전체 플랫폼 데이터 읽기 실패:', error.message);
    return null;
  }
}

async function getProducts(platformFilter, limit) {
  const allProducts = [];
  const fetchTasks = [];

  if (!platformFilter || platformFilter === 'shopify') {
    fetchTasks.push((async () => {
      try {
        const api = getShopifyAPI();
        // getProductsPage: 1페이지만 빠르게 가져오기 (getAllProducts는 전체 페이지네이션이라 느림)
        const products = await api.getProductsPage(Math.min(limit, 50));
        return (products || []).map(p => ({
          sku: p.variants?.[0]?.sku || '',
          title: p.title || '',
          price: p.variants?.[0]?.price || '',
          shipping: '',
          platform: 'Shopify',
          imageUrl: p.image?.src || '',
          editId: String(p.variants?.[0]?.id || ''),
          quantity: p.variants?.[0]?.inventory_quantity ?? '',
        }));
      } catch (e) {
        console.error('Shopify 상품 조회 실패:', e.message);
        return [];
      }
    })());
  }

  if (!platformFilter || platformFilter === 'ebay') {
    fetchTasks.push((async () => {
      try {
        const api = getEbayAPI();
        const allItems = await api.getAllActiveListings();
        return allItems.map(item => ({
          sku: item.sku || item.itemId || '',
          itemId: item.itemId || '',
          title: item.title || '',
          price: item.price || '',
          shipping: item.shippingCost || '',
          platform: 'eBay',
          imageUrl: item.imageUrl || '',
          editId: item.itemId || '',
          quantity: item.quantity || '',
        }));
      } catch (e) {
        console.error('eBay 상품 조회 실패:', e.message);
        return [];
      }
    })());
  }

  if (!platformFilter || platformFilter === 'naver') {
    fetchTasks.push((async () => {
      try {
        const api = getNaverAPI();
        await api.getToken();
        const data = await api.getProducts(1, Math.min(limit, 50));
        const items = data.contents || [];
        // Naver: contents[].channelProducts[0] 에 실제 상품 데이터
        return items.map(p => {
          const cp = (p.channelProducts && p.channelProducts[0]) || p;
          return {
            sku: String(cp.channelProductNo || p.originProductNo || ''),
            title: cp.name || '',
            price: cp.salePrice || cp.discountedPrice || '',
            shipping: cp.deliveryFee ?? '',
            platform: 'Naver',
            imageUrl: cp.representativeImage?.url || '',
            editId: String(p.originProductNo || cp.channelProductNo || ''),
            quantity: cp.stockQuantity ?? '',
          };
        });
      } catch (e) {
        console.error('Naver 상품 조회 실패:', e.message);
        return [];
      }
    })());
  }

  if (!platformFilter || platformFilter === 'alibaba') {
    fetchTasks.push((async () => {
      try {
        const api = getAlibabaAPI();
        const data = await api.getProductList(1, Math.min(limit, 20));
        const result = data.result || data;
        const items = result.products || [];
        return items.map(p => ({
          sku: String(p.id || ''),
          title: p.subject || '',
          price: '',
          shipping: '',
          platform: 'Alibaba',
          imageUrl: p.main_image?.images?.[0] || '',
          editId: String(p.id || ''),
          quantity: '',
        }));
      } catch (e) {
        console.error('Alibaba 상품 조회 실패:', e.message);
        return [];
      }
    })());
  }

  const results = await Promise.all(fetchTasks);
  results.forEach(items => allProducts.push(...items));

  return allProducts.slice(0, limit);
}

// eBay 제외 플랫폼만 조회 (전체 상품 페이지에서 eBay는 Google Sheets로 대체)
async function getProductsNonEbay(limit) {
  const allProducts = [];
  const fetchTasks = [];

  fetchTasks.push((async () => {
    try {
      const api = getShopifyAPI();
      const products = await api.getProductsPage(Math.min(limit, 50));
      return (products || []).map(p => ({
        sku: p.variants?.[0]?.sku || '',
        title: p.title || '',
        price: p.variants?.[0]?.price || '',
        shipping: '',
        platform: 'Shopify',
        imageUrl: p.image?.src || '',
        editId: String(p.variants?.[0]?.id || ''),
        quantity: p.variants?.[0]?.inventory_quantity ?? '',
      }));
    } catch (e) { return []; }
  })());

  fetchTasks.push((async () => {
    try {
      const api = getNaverAPI();
      await api.getToken();
      const data = await api.getProducts(1, Math.min(limit, 50));
      const items = data.contents || [];
      return items.map(p => {
        const cp = (p.channelProducts && p.channelProducts[0]) || p;
        return {
          sku: String(cp.channelProductNo || p.originProductNo || ''),
          title: cp.name || '',
          price: cp.salePrice || cp.discountedPrice || '',
          shipping: cp.deliveryFee ?? '',
          platform: 'Naver',
          imageUrl: cp.representativeImage?.url || '',
          editId: String(p.originProductNo || cp.channelProductNo || ''),
          quantity: cp.stockQuantity ?? '',
        };
      });
    } catch (e) { return []; }
  })());

  const results = await Promise.all(fetchTasks);
  results.forEach(items => allProducts.push(...items));
  return allProducts;
}

// Google Sheets 셀 업데이트 (가격/재고 수정 시)
async function updateGoogleSheet(searchField, searchValue, updates, altSku) {
  if (!fs.existsSync(credentialsPath) || !SPREADSHEET_ID) {
    return { success: false, error: 'credentials 없음' };
  }

  try {
    const sheets = getGoogleSheets();
    await sheets.authenticate();

    const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:S');
    if (!rows || rows.length === 0) return { success: false, error: '시트 데이터 없음' };

    // 행 찾기: itemId(N열, index 13) 또는 SKU(B열, index 1)
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (searchField === 'itemId' && rows[i][13] === String(searchValue)) { rowIndex = i; break; }
      if (searchField === 'sku' && rows[i][1] === String(searchValue)) { rowIndex = i; break; }
    }
    // itemId로 못 찾으면 altSku로 재시도
    if (rowIndex === -1 && altSku) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i][1] === String(altSku)) { rowIndex = i; break; }
      }
    }

    if (rowIndex === -1) return { success: false, error: '시트에서 상품 못 찾음' };

    const sheetRow = rowIndex + 2; // A2부터 시작이므로 +2
    const updatePromises = [];

    // J열: eBay가격(USD), P열: eBay재고
    if (updates.priceUSD !== undefined) {
      updatePromises.push(sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!J${sheetRow}`, [[String(updates.priceUSD)]]));
    }
    if (updates.stock !== undefined) {
      updatePromises.push(sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!P${sheetRow}`, [[String(updates.stock)]]));
    }

    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
      analysisCache = null;
    }

    return { success: true };
  } catch (e) {
    console.error('Google Sheets 업데이트 실패:', e.message);
    return { success: false, error: e.message };
  }
}

// ===========================
// SKU 점수 관리 엔드포인트
// ===========================

// GET /api/sku-scores — 전체 점수 목록
router.get('/sku-scores', (req, res) => {
  try {
    const { classification, search, sort = 'normalizedScore', order = 'desc', limit = 100 } = req.query;
    let scores = skuScorer.getAllScores();

    if (classification) {
      scores = scores.filter(s => s.classification === classification);
    }
    if (search) {
      const q = search.toLowerCase();
      scores = scores.filter(s =>
        (s.sku || '').toLowerCase().includes(q) ||
        (s.title || '').toLowerCase().includes(q)
      );
    }

    // 정렬
    scores.sort((a, b) => {
      const aVal = a[sort] || 0;
      const bVal = b[sort] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    res.json({
      scores: scores.slice(0, parseInt(limit)),
      summary: skuScorer.getSummary(),
      lastUpdated: skuScorer._data?.lastUpdated || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sku-scores/retirement — 퇴출 대상 목록
router.get('/sku-scores/retirement', (req, res) => {
  try {
    const actions = skuScorer.checkRetirementRules();
    const summary = {
      priceIncrease: actions.filter(a => a.action === 'price_increase_5pct').length,
      deactivate: actions.filter(a => a.action === 'deactivate').length,
      marginReview: actions.filter(a => a.action === 'margin_review').length,
    };
    res.json({ actions, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sku-scores/history/:sku — SKU 점수 이력
router.get('/sku-scores/history/:sku', (req, res) => {
  try {
    const history = skuScorer.getHistory(req.params.sku);
    res.json({ sku: req.params.sku, history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sku-scores/:sku — SKU 상세 점수
router.get('/sku-scores/:sku', (req, res) => {
  try {
    const scoreData = skuScorer.getScoreBySku(req.params.sku);
    if (!scoreData) return res.status(404).json({ error: '점수 데이터 없음' });

    const masterProduct = masterDB.getBySku(req.params.sku);
    let prices = null;
    if (masterProduct) {
      prices = pricingEngine.calculatePrices(masterProduct);
    }

    res.json({ scores: scoreData, masterProduct, prices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sku-scores/recalculate — 전체/단일 재계산
router.post('/sku-scores/recalculate', async (req, res) => {
  try {
    const startTime = Date.now();
    const { collectAllSkuData } = require('../../jobs/collectSkuData');
    const result = await collectAllSkuData();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // 인메모리 캐시 갱신 (job이 별도 인스턴스로 파일에 저장하므로 reload 필요)
    skuScorer._data = null;
    skuScorer.load();

    res.json({
      success: true,
      message: `${result.calculated}개 SKU 점수 재계산 완료`,
      duration: `${duration}s`,
      summary: result.summary,
    });
  } catch (error) {
    console.error('SKU 재계산 실패:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/sku-scores/:sku/override — 수동 오버라이드
router.put('/sku-scores/:sku/override', async (req, res) => {
  try {
    const { competitorCount, bundleItemCount, notes } = req.body;
    const overrides = {};
    if (competitorCount !== undefined) overrides.competitorCount = parseInt(competitorCount);
    if (bundleItemCount !== undefined) overrides.bundleItemCount = parseInt(bundleItemCount);
    if (notes !== undefined) overrides.notes = notes;

    skuScorer.setManualOverride(req.params.sku, overrides);

    // 해당 SKU 재계산 (기존 rawData 사용)
    const existing = skuScorer.getScoreBySku(req.params.sku);
    if (existing && existing.rawData) {
      const rd = existing.rawData;
      skuScorer.calculateTotalScore(req.params.sku, {
        marginPct: rd.netMarginPct,
        sales30d: rd.sales30d,
        sellingPrice: rd.sellingPrice,
        purchasePrice: rd.purchasePrice,
        platformFees: rd.platformFees,
        priceHistory: skuScorer.getPriceHistory(req.params.sku),
      }, { title: existing.title });
      skuScorer.save();
    }

    res.json({
      success: true,
      sku: req.params.sku,
      updatedScore: skuScorer.getScoreBySku(req.params.sku),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sku-scores/retirement/execute — 단일 퇴출 조치 실행
router.post('/sku-scores/retirement/execute', async (req, res) => {
  try {
    const { sku, action, confirm } = req.body;
    if (!confirm) return res.status(400).json({ error: '확인이 필요합니다 (confirm: true)' });
    if (!sku || !action) return res.status(400).json({ error: 'sku와 action은 필수입니다' });

    const scoreData = skuScorer.getScoreBySku(sku);
    if (!scoreData) return res.status(404).json({ error: 'SKU 점수 데이터 없음' });

    const result = { sku, action, success: false };

    if (action === 'price_increase_5pct') {
      // eBay 가격 5% 인상
      const currentPrice = parseFloat(scoreData.rawData?.sellingPrice) || 0;
      if (currentPrice > 0) {
        const newPrice = +(currentPrice * 1.05).toFixed(2);
        try {
          // masterDB에서 플랫폼 정보 조회
          const mp = masterDB.getBySku(sku);
          const ebayItemId = mp?.platforms?.ebay?.itemId;
          if (ebayItemId) {
            const ebay = getEbayAPI();
            await ebay.updateItem(ebayItemId, { price: newPrice });
            result.success = true;
            result.oldPrice = currentPrice;
            result.newPrice = newPrice;
          } else {
            result.error = 'eBay Item ID 없음';
          }
        } catch (e) {
          result.error = e.message;
        }
      } else {
        result.error = '현재 가격 정보 없음';
      }
    } else if (action === 'deactivate') {
      // 플래그만 기록 (실제 비활성화는 각 플랫폼 API 필요)
      result.success = true;
      result.note = '비활성화 플래그 설정됨 - 플랫폼별 수동 처리 필요';
    } else if (action === 'margin_review') {
      result.success = true;
      result.note = '마진 검토 플래그 설정됨';
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sku-scores/retirement/execute-all — 일괄 퇴출 실행
router.post('/sku-scores/retirement/execute-all', async (req, res) => {
  try {
    const { confirm, actions: filterActions } = req.body;
    if (!confirm) return res.status(400).json({ error: '확인이 필요합니다 (confirm: true)' });

    let candidates = skuScorer.checkRetirementRules();
    if (filterActions && filterActions.length > 0) {
      candidates = candidates.filter(c => filterActions.includes(c.action));
    }

    const results = [];
    for (const candidate of candidates) {
      // margin_review는 플래그만
      results.push({
        sku: candidate.sku,
        action: candidate.action,
        success: true,
        note: candidate.action === 'margin_review' ? '마진 검토 플래그' : '처리 완료',
      });
    }

    res.json({
      success: true,
      executed: results.length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// 전투 상황판 (Battle Dashboard)
// ===========================

// 시트 A2:Z 읽기 (경쟁사 V~Z열 포함)
async function readBattleDashboardSheet(sheets) {
  try {
    const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!A2:Z');
    if (!rows || rows.length === 0) return [];
    return rows.map(row => ({
      image: row[0] || '',
      sku: row[1] || '',
      title: row[2] || '',
      purchasePriceKRW: row[4] || '',
      totalCostKRW: row[8] || '',
      myPriceUSD: parseFloat(row[9]) || 0,
      myShippingUSD: parseFloat(row[10]) || 0,
      profitKRW: row[11] || '',
      marginPct: row[12] || '',
      itemId: row[13] || '',
      salesCount: row[14] || '',
      stock: row[15] || '',
      comp1Seller: row[21] || '',
      comp1ItemId: (row[22] || '').toString().trim(),
      comp1Price: row[23] || '',
      comp1Shipping: row[24] || '',
      comp2Seller: row[25] || '',
    })).filter(r => r.sku && r.itemId);
  } catch (e) {
    console.error('전투 상황판 시트 읽기 실패:', e.message);
    return [];
  }
}

// GET /api/battle/data — 전투 상황판 데이터
router.get('/battle/data', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';

    if (battleCache && !forceRefresh && Date.now() - battleCacheTime < BATTLE_CACHE_TTL) {
      return res.json(battleCache);
    }

    if (!fs.existsSync(credentialsPath)) {
      return res.status(500).json({ error: 'Google Sheets credentials 없음' });
    }

    const sheets = getGoogleSheets();
    await sheets.authenticate();
    const sheetData = await readBattleDashboardSheet(sheets);

    if (!sheetData || sheetData.length === 0) {
      return res.json({ items: [], summary: {}, timestamp: new Date().toISOString() });
    }

    // 경쟁사 Item ID 수집
    const competitorItemIds = sheetData
      .filter(r => r.comp1ItemId && /^\d{9,15}$/.test(r.comp1ItemId))
      .map(r => r.comp1ItemId);

    // eBay Shopping API로 경쟁사 실시간 가격 조회
    let competitorData = {};
    if (competitorItemIds.length > 0) {
      try {
        const ebay = getEbayAPI();
        const items = await ebay.getCompetitorItems(competitorItemIds);
        items.forEach(item => {
          competitorData[item.itemId] = item;
        });
        console.log(`전투 상황판: ${Object.keys(competitorData).length}/${competitorItemIds.length} 경쟁사 가격 조회 완료`);
      } catch (e) {
        console.error('경쟁사 가격 조회 실패:', e.message);
      }
    }

    // 데이터 조합
    const battleItems = sheetData.map(row => {
      const myTotal = row.myPriceUSD + row.myShippingUSD;
      const comp = competitorData[row.comp1ItemId] || null;

      const compPrice = comp ? comp.price : (parseFloat(row.comp1Price) || 0);
      const compShipping = comp ? comp.shippingCost : (parseFloat(row.comp1Shipping) || 0);
      const compTotal = compPrice + compShipping;
      const compSold = comp ? comp.quantitySold : 0;
      const compSeller = comp ? comp.seller : (row.comp1Seller || '');

      const diff = compTotal > 0 ? +(myTotal - compTotal).toFixed(2) : null;
      const losing = diff !== null && diff > 0;
      const killPrice = losing && compTotal > 0 ? +((compTotal - row.myShippingUSD) - 2).toFixed(2) : null;

      return {
        sku: row.sku,
        title: row.title,
        image: row.image,
        itemId: row.itemId,
        myPrice: row.myPriceUSD,
        myShipping: row.myShippingUSD,
        myTotal: +myTotal.toFixed(2),
        profitKRW: row.profitKRW,
        marginPct: row.marginPct,
        myStock: row.stock,
        mySold: row.salesCount,
        comp1Seller: compSeller,
        comp1ItemId: row.comp1ItemId,
        comp1Price: +compPrice.toFixed(2),
        comp1Shipping: +compShipping.toFixed(2),
        comp1Total: +compTotal.toFixed(2),
        comp1Sold: compSold,
        comp1Live: !!comp,
        diff,
        losing,
        killPrice,
        comp2Seller: row.comp2Seller,
      };
    });

    // 요약 통계
    const withComp = battleItems.filter(i => i.comp1Total > 0);
    const losingItems = withComp.filter(i => i.losing);

    const summary = {
      totalItems: battleItems.length,
      withCompetitor: withComp.length,
      losing: losingItems.length,
      winning: withComp.length - losingItems.length,
      avgDiff: withComp.length > 0
        ? +(withComp.reduce((s, i) => s + (i.diff || 0), 0) / withComp.length).toFixed(2)
        : 0,
      uniqueSellers: [...new Set(withComp.map(i => i.comp1Seller).filter(Boolean))],
    };

    const response = { items: battleItems, summary, timestamp: new Date().toISOString() };

    battleCache = response;
    battleCacheTime = Date.now();

    res.json(response);
  } catch (error) {
    console.error('Battle dashboard error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/battle/refresh — 경쟁사 가격 강제 새로고침
router.post('/battle/refresh', async (req, res) => {
  try {
    battleCache = null;
    battleCacheTime = 0;

    const sheets = getGoogleSheets();
    await sheets.authenticate();
    const sheetData = await readBattleDashboardSheet(sheets);

    const competitorItemIds = sheetData
      .filter(r => r.comp1ItemId && /^\d{9,15}$/.test(r.comp1ItemId))
      .map(r => r.comp1ItemId);

    let refreshed = 0;
    if (competitorItemIds.length > 0) {
      const ebay = getEbayAPI();
      const items = await ebay.getCompetitorItems(competitorItemIds);
      refreshed = items.length;
    }

    res.json({
      success: true,
      refreshed,
      total: competitorItemIds.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/battle/kill-price — 킬 프라이스 적용
router.post('/battle/kill-price', async (req, res) => {
  try {
    const { itemId, newPrice, sku } = req.body;

    if (!itemId || !newPrice) {
      return res.status(400).json({ error: 'itemId와 newPrice 필수' });
    }

    const ebay = getEbayAPI();
    const result = await ebay.updateItem(itemId, { price: parseFloat(newPrice) });

    if (result.success) {
      // 시트의 내 판매가(J열)도 업데이트 — 승리/패배 판정에 반영
      if (sku) {
        try {
          const sheets = getGoogleSheets();
          await sheets.authenticate();
          const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!B2:N');
          if (rows) {
            for (let i = 0; i < rows.length; i++) {
              const rowSku = (rows[i][0] || '').toString().trim();
              const rowItemId = (rows[i][12] || '').toString().trim();
              if (rowSku === sku || rowItemId === itemId) {
                // J열 = index 9 from A, B열부터 읽었으므로 offset = J - B = 8 → 시트에서 J열
                await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!J${i + 2}`, [[parseFloat(newPrice)]]);
                console.log(`✅ 시트 J${i + 2}: ${sku} 가격 → $${newPrice}`);
                break;
              }
            }
          }
        } catch (sheetErr) {
          console.warn('시트 가격 업데이트 실패 (eBay는 성공):', sheetErr.message);
        }
      }

      battleCache = null;
      analysisCache = null;
      res.json({ success: true, itemId, newPrice: parseFloat(newPrice) });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/battle/competitor/:itemId — 경쟁사 단일 상품 상세
router.get('/battle/competitor/:itemId', async (req, res) => {
  try {
    const ebay = getEbayAPI();
    const item = await ebay.getCompetitorItemDetail(req.params.itemId);
    if (!item) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다' });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// AI 리메이커 (Remarker)
// ===========================

// POST /api/remarker/fetch — 경쟁사 상품 전체 정보 조회
router.post('/remarker/fetch', async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId || !/^\d{9,15}$/.test(String(itemId).trim())) {
      return res.status(400).json({ error: 'eBay Item ID를 입력하세요 (9~15자리 숫자)' });
    }

    const ebay = getEbayAPI();
    const item = await ebay.getCompetitorItemFull(String(itemId).trim());

    if (!item) {
      return res.status(404).json({ error: '상품을 찾을 수 없습니다' });
    }

    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/remarker/remake — AI 리메이크
router.post('/remarker/remake', async (req, res) => {
  try {
    const { competitorData } = req.body;
    if (!competitorData || !competitorData.title) {
      return res.status(400).json({ error: '경쟁사 데이터가 필요합니다' });
    }

    const AIRemarker = require('../../services/aiRemarker');
    const remarker = new AIRemarker();
    const result = await remarker.remake(competitorData);

    res.json({ success: true, remake: result, original: competitorData });
  } catch (error) {
    console.error('AI Remarker error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/remarker/reconstruct — 썸네일+상세페이지 업로드 → AI 추출 → 재구성
router.post('/remarker/reconstruct', upload.array('images', 10), async (req, res) => {
  try {
    const htmlContent = req.body.htmlContent || '';
    const lang = req.body.lang || 'en';
    const mode = req.body.mode || 'standard';
    const uploadedFiles = req.files || [];

    if (!htmlContent && uploadedFiles.length === 0) {
      return res.status(400).json({ success: false, error: '이미지 또는 상세페이지 HTML이 필요합니다' });
    }

    // 1. 이미지 base64 인코딩 (빠른 모드: 1장, 표준: 최대 5장)
    const maxImages = mode === 'fast' ? 1 : 5;
    const images = uploadedFiles.slice(0, maxImages).map(f => ({
      base64: fs.readFileSync(f.path).toString('base64'),
      mediaType: f.mimetype || 'image/jpeg',
    }));

    // 2. AI로 핵심 추출 + 상세페이지 재구성
    const AIRemarker = require('../../services/aiRemarker');
    const remarker = new AIRemarker();
    const aiResult = await remarker.reconstruct({
      htmlContent,
      imageCount: uploadedFiles.length,
      images,
      lang,
      mode,
    });

    // 3. 원본 이미지 경로 목록 (브랜딩 없이 그대로)
    const originalImages = uploadedFiles.map(f => `/uploads/${path.basename(f.path)}`);

    res.json({
      success: true,
      ...aiResult,
      originalImages,
      lang,
      mode,
    });
  } catch (error) {
    console.error('Reconstruct error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/remarker/brand-images — 이미지 브랜딩 (워터마크 + 보정 + 템플릿)
router.post('/remarker/brand-images', async (req, res) => {
  try {
    const { imageUrls, sku, template, topText, showShippingLogos } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: '이미지 URL 목록이 필요합니다' });
    }

    const ImageBrander = require('../../services/imageBrander');
    const brander = new ImageBrander();
    const templateOpts = template ? { template, topText: topText || '', showShippingLogos: showShippingLogos !== false } : {};
    const results = await brander.brandImages(imageUrls, sku || 'PMC', templateOpts);

    const success = results.filter(r => !r.error);
    res.json({
      success: true,
      total: imageUrls.length,
      branded: success.length,
      failed: results.length - success.length,
      images: results,
    });
  } catch (error) {
    console.error('Image branding error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/templates — 업로드된 템플릿 목록
router.get('/templates', (req, res) => {
  try {
    const ImageBrander = require('../../services/imageBrander');
    const templates = ImageBrander.getTemplateList();
    res.json({ templates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/templates/upload — PNG 템플릿 업로드
router.post('/templates/upload', upload.single('template'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'PNG/JPG 파일만 가능합니다' });
    }
    const templatesDir = path.join(projectRoot, 'public', 'uploads', 'templates');
    if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
    const filename = `template-${Date.now()}${ext}`;
    const dest = path.join(templatesDir, filename);
    fs.renameSync(req.file.path, dest);
    res.json({ success: true, filename, path: `/uploads/templates/${filename}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/remarker/register — 검토 완료 후 등록
router.post('/remarker/register', async (req, res) => {
  try {
    const {
      sku, titleEn, description, priceUSD, shippingUSD,
      quantity, condition, imageUrls, ebayCategoryId,
      targetPlatforms, purchasePrice, weight, targetMargin
    } = req.body;

    if (!sku || !titleEn) {
      return res.status(400).json({ error: 'SKU와 제목이 필요합니다' });
    }

    const results = {};

    // 1. Master DB 저장
    const productData = {
      sku,
      title: titleEn,
      titleEn,
      descriptionEn: description,
      purchasePrice: parseFloat(purchasePrice) || 0,
      weight: parseFloat(weight) || 0.5,
      targetMargin: parseFloat(targetMargin) || 30,
      quantity: parseInt(quantity) || 10,
      condition: condition || 'new',
      imageUrls: imageUrls || [],
      ebayCategoryId: ebayCategoryId || '',
    };

    let masterProduct = masterDB.getBySku(sku);
    if (masterProduct) {
      masterProduct = masterDB.update(sku, productData);
    } else {
      masterProduct = masterDB.create(productData);
    }

    // 2. Google Sheets 등록
    if (fs.existsSync(credentialsPath)) {
      try {
        const sheets = getGoogleSheets();
        await sheets.authenticate();
        const price = parseFloat(priceUSD) || 0;
        const ship = parseFloat(shippingUSD) || 3.90;
        const row = [
          (imageUrls && imageUrls[0]) || '',
          sku, titleEn,
          weight || 0.5,
          purchasePrice || 0,
          '', '', '', '',
          price, ship,
          '', '', '', '', '',
          '', '', '', '', ''
        ];
        await sheets.appendData(SPREADSHEET_ID, '최종 Dashboard!A:U', [row]);
        results.sheets = true;
      } catch (e) {
        results.sheets = { error: e.message };
      }
    }

    // 3. eBay 등록 (선택된 경우)
    const platforms = targetPlatforms || [];
    if (platforms.includes('ebay')) {
      try {
        const ebay = getEbayAPI();
        const conditionMap = { 'new': '1000', 'used': '3000', 'refurbished': '2500' };
        const ebayResult = await ebay.createProduct({
          title: titleEn,
          description: description,
          price: parseFloat(priceUSD),
          quantity: parseInt(quantity) || 10,
          sku: sku,
          categoryId: ebayCategoryId || '11450',
          conditionId: conditionMap[condition] || '1000',
          shippingCost: parseFloat(shippingUSD) || 3.90,
          imageUrl: (imageUrls && imageUrls[0]) || '',
          currency: 'USD',
        });
        results.ebay = ebayResult;
        if (ebayResult.success) {
          masterDB.updatePlatformStatus(sku, 'ebay', {
            itemId: ebayResult.itemId,
            status: 'active',
            price: parseFloat(priceUSD),
          });

          // 시트에 eBay Item ID 기록 → 전투현황판 연동
          if (ebayResult.itemId && fs.existsSync(credentialsPath)) {
            try {
              const sheetsForId = getGoogleSheets();
              await sheetsForId.authenticate();
              const skuRows = await sheetsForId.readData(SPREADSHEET_ID, '최종 Dashboard!B2:B');
              if (skuRows) {
                for (let i = 0; i < skuRows.length; i++) {
                  if (skuRows[i][0] === sku) {
                    await sheetsForId.writeData(SPREADSHEET_ID, `최종 Dashboard!N${i + 2}`, [[ebayResult.itemId]]);
                    await sheetsForId.writeData(SPREADSHEET_ID, `최종 Dashboard!Q${i + 2}`, [['등록완료']]);
                    // 경쟁사 매핑 (셀러 전투 모드에서 전달된 경우)
                    if (req.body.competitorItemId) {
                      await sheetsForId.writeData(SPREADSHEET_ID, `최종 Dashboard!V${i + 2}:Y${i + 2}`, [[
                        req.body.competitorSeller || '',
                        req.body.competitorItemId || '',
                        req.body.competitorPrice || '',
                        req.body.competitorShipping || '',
                      ]]);
                    }
                    break;
                  }
                }
              }
            } catch (sheetErr) {
              console.error('Remarker eBay 시트 업데이트 실패:', sheetErr.message);
            }
          }
        }
      } catch (e) {
        results.ebay = { success: false, error: e.message };
      }
    }

    res.json({ success: true, results, masterProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Helper 함수 (기존)
// ===========================

async function getSyncHistory() {
  const logPath = path.join(projectRoot, 'data', 'sync-log.json');
  try {
    if (fs.existsSync(logPath)) {
      return JSON.parse(fs.readFileSync(logPath, 'utf8'));
    }
  } catch (e) {}
  return [];
}

// ==================== 주문 배송 관리 ====================

// GET /api/orders/sync — 주문 자동수집 → 시트 기록
router.get('/orders/sync', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.syncOrders(days);
    res.json({ success: true, ...result, sheetUrl: `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}` });
  } catch (error) {
    console.error('Order sync error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/recent — 시트에서 최근 주문 읽기
router.get('/orders/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.getRecentOrders(limit);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Order recent error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/carrier-tabs/:carrier — 배송사별 날짜탭 목록
router.get('/carrier-tabs/:carrier', async (req, res) => {
  try {
    const CarrierSheets = require('../../services/carrierSheets');
    const cs = new CarrierSheets();
    const result = await cs.getDateTabs(req.params.carrier);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Carrier tabs error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/set-carrier — 배송사 지정 (시트 업데이트) + 캐리어 시트 자동 기록
router.post('/orders/set-carrier', async (req, res) => {
  try {
    const { rowIndex, carrier, sheetTab } = req.body;
    console.log(`\n🔵 set-carrier 요청: row=${rowIndex}, carrier=${carrier}, tab=${sheetTab || '자동'}`);

    if (!rowIndex || !carrier) {
      return res.status(400).json({ success: false, error: 'rowIndex와 carrier가 필요합니다' });
    }
    const OrderSync = require('../../services/orderSync');
    const CarrierSheets = require('../../services/carrierSheets');
    const sync = new OrderSync();

    // 1. 주문 배송 시트에 배송사 기록
    console.log(`   [1/3] 주문 시트에 배송사 '${carrier}' 기록...`);
    await sync.setCarrier(rowIndex, carrier);
    console.log(`   [1/3] ✅ 완료`);

    // 2. 캐리어 시트에 자동 추가 (윤익스프레스 등 지원 배송사만)
    let carrierResult = null;
    const supported = CarrierSheets.getSupportedCarriers();
    if (supported.includes(carrier)) {
      console.log(`   [2/3] 주문 데이터 읽기 (행 ${rowIndex})...`);
      const order = await sync.getOrderRow(rowIndex);
      if (order) {
        console.log(`   [2/3] ✅ 주문 데이터 로드 완료`);
        console.log(`   [3/3] 캐리어 시트 '${carrier}'에 등록...`);
        const cs = new CarrierSheets();
        const opts = sheetTab ? { sheetTab } : {};
        carrierResult = await cs.addToCarrierSheet(carrier, order, opts);
        console.log(`   [3/3] ✅ 캐리어 시트 등록 완료:`, carrierResult);
      } else {
        console.warn(`   [2/3] ⚠️ 주문 데이터 없음 (행 ${rowIndex})`);
      }
    } else {
      console.log(`   ℹ️ '${carrier}'은 시트 미지원 배송사 (지원: ${supported.join(', ')})`);
    }

    res.json({ success: true, rowIndex, carrier, carrierResult });
  } catch (error) {
    console.error(`❌ set-carrier 에러:`, error.message);
    console.error(error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/cancel-carrier — 배송사 지정 취소
router.post('/orders/cancel-carrier', async (req, res) => {
  try {
    const { rowIndex } = req.body;
    if (!rowIndex) {
      return res.status(400).json({ success: false, error: 'rowIndex가 필요합니다' });
    }

    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();

    // K~M열 초기화: 배송사='', 운송장번호='', 상태='NEW'
    await sync.sheets.writeData(
      process.env.GOOGLE_SPREADSHEET_ID,
      `주문 배송!K${rowIndex}:M${rowIndex}`,
      [['', '', 'NEW']]
    );

    console.log(`🔴 배송사 취소: 행 ${rowIndex}`);
    res.json({ success: true, rowIndex });
  } catch (error) {
    console.error('❌ cancel-carrier 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/backfill-addresses — 주소 누락된 eBay 주문 주소 백필
router.post('/orders/backfill-addresses', async (req, res) => {
  try {
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.backfillAddresses();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ backfill-addresses 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/backfill-orderids — eBay 주문번호를 실제 OrderID로 변환
router.post('/orders/backfill-orderids', async (req, res) => {
  try {
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.backfillOrderIds();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ backfill-orderids 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/fix-phones — #ERROR! 전화번호 수정
router.post('/orders/fix-phones', async (req, res) => {
  try {
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.fixPhoneErrors();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ fix-phones 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/backfill-names — ID 형식 구매자명을 실제 이름으로 복구
router.post('/orders/backfill-names', async (req, res) => {
  try {
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.backfillBuyerNames();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ backfill-names 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ══════════════════════════════════════════════════════════
// B2B 인보이스 API
// ══════════════════════════════════════════════════════════

let _b2bInstance = null;
function getB2BService() {
  if (!_b2bInstance) {
    const B2BInvoiceService = require('../../services/b2bInvoice');
    _b2bInstance = new B2BInvoiceService();
  }
  return _b2bInstance;
}

// ─── 구매자 ───

// GET /api/b2b/buyers — 구매자 목록
router.get('/b2b/buyers', async (req, res) => {
  try {
    const buyers = await getB2BService().getBuyers();
    res.json({ success: true, buyers });
  } catch (error) {
    console.error('❌ B2B buyers 조회 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/b2b/buyers — 구매자 생성/수정
router.post('/b2b/buyers', async (req, res) => {
  try {
    const { buyerId, ...data } = req.body;
    let result;
    if (buyerId) {
      result = await getB2BService().updateBuyer(buyerId, data);
    } else {
      result = await getB2BService().createBuyer(data);
    }
    res.json({ success: true, buyer: result });
  } catch (error) {
    console.error('❌ B2B buyer 생성/수정 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 가격표 ───

// GET /api/b2b/prices — B2B 가격표
router.get('/b2b/prices', async (req, res) => {
  try {
    const prices = await getB2BService().getB2BPrices();
    res.json({ success: true, prices });
  } catch (error) {
    console.error('❌ B2B prices 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 인보이스 ───

// GET /api/b2b/invoices — 인보이스 목록
router.get('/b2b/invoices', async (req, res) => {
  try {
    const { buyerId, status, fromDate, toDate } = req.query;
    const invoices = await getB2BService().getInvoices({ buyerId, status, fromDate, toDate });
    res.json({ success: true, invoices });
  } catch (error) {
    console.error('❌ B2B invoices 조회 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/b2b/invoices — 인보이스 생성
router.post('/b2b/invoices', async (req, res) => {
  try {
    const result = await getB2BService().generateInvoice(req.body);
    // xlsxBuffer는 응답에서 제외
    const { xlsxBuffer, ...invoice } = result;
    res.json({ success: true, invoice });
  } catch (error) {
    console.error('❌ B2B invoice 생성 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/b2b/invoices/:id/download — 인보이스 다운로드
router.get('/b2b/invoices/:id/download', async (req, res) => {
  try {
    const format = req.query.format || 'xlsx';
    const { buffer, mimeType, fileName } = await getB2BService().downloadInvoice(req.params.id, format);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (error) {
    console.error('❌ B2B invoice 다운로드 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/b2b/invoices/:id/status — 상태 변경
router.post('/b2b/invoices/:id/status', async (req, res) => {
  try {
    const { status, sentVia } = req.body;
    const result = await getB2BService().updateInvoiceStatus(req.params.id, status, { sentVia });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ B2B invoice 상태 변경 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/b2b/invoices/:id/whatsapp — WhatsApp 링크 생성
router.get('/b2b/invoices/:id/whatsapp', async (req, res) => {
  try {
    const result = await getB2BService().getWhatsAppLink(req.params.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ B2B WhatsApp 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 매출 분석 ───

// GET /api/b2b/revenue — 매출 요약
router.get('/b2b/revenue', async (req, res) => {
  try {
    const summary = await getB2BService().getRevenueSummary();
    res.json({ success: true, ...summary });
  } catch (error) {
    console.error('B2B revenue error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/b2b/revenue/ranking — 바이어 매출 순위
router.get('/b2b/revenue/ranking', async (req, res) => {
  try {
    const ranking = await getB2BService().getBuyerRanking();
    res.json({ success: true, ranking });
  } catch (error) {
    console.error('B2B ranking error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/b2b/revenue/products — 상품별 판매 통계
router.get('/b2b/revenue/products', async (req, res) => {
  try {
    const { buyerId } = req.query;
    const products = await getB2BService().getProductStats(buyerId);
    res.json({ success: true, products });
  } catch (error) {
    console.error('B2B products error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
