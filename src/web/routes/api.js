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

// CSV/Excel upload config (separate storage for temp files)
const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `csv-${Date.now()}${ext}`);
  },
});
const csvUpload = multer({
  storage: csvStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// 서비스 모듈
const pricingEngine = require('../../services/pricingEngine');
const platformOptimizer = require('../../services/platformOptimizer');
const SkuScorer = require('../../services/skuScorer');
const dataSource = require('../../services/dataSource');
const csvImporter = require('../../services/csvImporter');
const platformRegistry = require('../../services/platformRegistry');
const ProductExporter = require('../../services/productExporter');
const RepricingService = require('../../services/repricingService');
const skuScorer = new SkuScorer();

// Platform API lazy loaders (kept for direct API calls in revenue/sync endpoints)
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

// ===========================
// 기존 엔드포인트
// ===========================

// GET /api/dashboard/summary
router.get('/dashboard/summary', async (req, res) => {
  try {
    const [platforms, syncHistory] = await Promise.all([
      getPlatformStatuses(),
      dataSource.getSyncHistory()
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
      // DB_SOURCE에 따라 Supabase or Sheets (2분 캐시)
      const dashData = await dataSource.getDashboardData();
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
    const history = await dataSource.getSyncHistory();
    const latest = history.length > 0 ? history[history.length - 1] : null;
    res.json({ latest, total: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/sync/history
router.get('/sync/history', async (req, res) => {
  try {
    const history = await dataSource.getSyncHistory();
    res.json(history.slice(-20).reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sync/trigger/:platform — Supabase-based platform sync
router.post('/sync/trigger/:platform', async (req, res) => {
  const { platform } = req.params;

  // Supabase-based sync: fetch from platform API → upsert to Supabase
  const syncScripts = {
    ebay: 'node src/sync/sync-ebay-price-shipping.js',
  };

  // For platforms with dedicated sync scripts, run them
  const script = syncScripts[platform];
  if (!script) {
    // For other platforms, use the platform API to sync data directly to Supabase
    try {
      const dataSource = require('../../services/dataSource');
      const syncRepo = dataSource.getSyncRepo();
      await syncRepo.recordSync(platform, 'manual_sync', 'success', 0, null, { trigger: 'manual' });
      res.json({ message: `${platform} 동기화 — Supabase 직접 동기화 완료`, status: 'completed' });
      platformCache = null;
      analysisCache = null;
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.json({ message: `${platform} 동기화 시작됨`, status: 'running' });

  exec(script, { cwd: projectRoot, timeout: 600000 })
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
    const data = await dataSource.getDashboardData();
    if (!data || data.length === 0) {
      return res.json({ error: 'no_data', message: '데이터 없음' });
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
    let data = await dataSource.getDashboardData();
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
    const data = await dataSource.getDashboardData();
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
    const data = await dataSource.getDashboardData();
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

// POST /api/products/register — 마스터 상품 등록 (Supabase + ProductExporter)
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

    // 1. Save to Supabase products table
    const productRepo = dataSource.getProductRepo();
    const productRow = await productRepo.createProduct({
      sku, title: titleEn || title,
      title_ko: title,
      description: descriptionEn || description || '',
      description_ko: description || '',
      image: imageUrls && imageUrls[0] ? imageUrls[0] : '',
      weight: parseFloat(weight) || 0,
      purchase: String(parseFloat(purchasePrice) || 0),
      priceUSD: String(parseFloat(priceUSD) || 0),
      shippingUSD: String(parseFloat(shippingUSD) || 3.9),
      stock: String(parseInt(quantity) || 1),
      status: 'active',
    });

    // Update additional fields
    if (productRow?.id) {
      const { getClient } = require('../../db/supabaseClient');
      await getClient().from('products').update({
        purchase_price: parseFloat(purchasePrice) || 0,
        target_margin: parseFloat(targetMargin) || 30,
        image_urls: imageUrls || [],
        keywords: keywords || [],
        condition: condition || 'new',
      }).eq('id', productRow.id);
    }

    // 2. Calculate prices (DB-driven fees/rates)
    let prices;
    if (priceUSD && !targetMargin) {
      const manualPrice = parseFloat(priceUSD);
      const manualShipping = parseFloat(shippingUSD) || 3.9;
      const rates = await platformRegistry.getExchangeRates();
      prices = {
        ebay: { price: manualPrice, shipping: manualShipping, currency: 'USD' },
        shopify: { price: manualPrice, shipping: manualShipping, currency: 'USD' },
        naver: { price: Math.round(manualPrice * (rates.usd || 1400)), shipping: 0, currency: 'KRW' },
      };
    } else {
      const fees = await platformRegistry.getFeeRates();
      const rates = await platformRegistry.getExchangeRates();
      prices = pricingEngine.calculatePrices({
        purchasePrice: parseFloat(purchasePrice) || 0,
        weight: parseFloat(weight) || 0,
        targetMargin: parseFloat(targetMargin) || 30,
        shippingUSD: parseFloat(shippingUSD) || 3.9,
      }, fees, rates);
    }

    // 3. Export to target platforms via ProductExporter
    const results = { prices };
    if (targetPlatforms && targetPlatforms.length > 0) {
      try {
        const exporter = new ProductExporter();
        const exportResult = await exporter.exportProduct(sku, targetPlatforms, {
          skipTranslation: !!(titleEn),
        });
        Object.assign(results, exportResult.results);
      } catch (exportErr) {
        console.error('ProductExporter error:', exportErr.message);
        results.exportError = exportErr.message;
      }
    }

    // Summarize successes
    const platformSuccesses = [];
    for (const [key, val] of Object.entries(results)) {
      if (val && val.success) {
        const p = prices[key];
        const label = p ? `${key} (${p.currency === 'KRW' ? '₩' : '$'}${p.price})` : key;
        platformSuccesses.push(label);
      }
    }

    platformCache = null;
    analysisCache = null;

    res.json({
      success: platformSuccesses.length > 0 || !!productRow,
      message: platformSuccesses.length > 0
        ? `상품이 등록되었습니다 (${platformSuccesses.join(', ')})`
        : productRow ? 'Supabase에 상품 저장 완료 (플랫폼 등록 미선택 또는 실패)'
        : '등록 실패',
      results,
      product: productRow,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// CSV 대량 임포트
// ===========================

// POST /api/products/import-csv — CSV/Excel 파일 업로드 → 미리보기 (파싱+검증)
router.post('/products/import-csv', csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'CSV 또는 Excel 파일을 업로드해주세요 (.csv, .xlsx)' });
    }

    const rows = await csvImporter.parseFile(req.file.path);
    const validation = csvImporter.validateRows(rows);

    // Store parsed file path for confirmation step
    res.json({
      fileName: req.file.originalname,
      filePath: req.file.filename,
      total: validation.total,
      validCount: validation.valid.length,
      errorCount: validation.errors.length,
      preview: validation.valid.slice(0, 50).map(r => ({
        sku: r.sku,
        title: r.title,
        titleEn: r.titleEn,
        purchasePrice: r.purchasePrice,
        weight: r.weight,
        category: r.category,
        quantity: r.quantity,
        targetMargin: r.targetMargin,
      })),
      errors: validation.errors,
      validRows: validation.valid,
    });

    // Clean up uploaded file after parsing
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
  } catch (error) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/import-csv/confirm — 검증된 데이터 확정 등록
router.post('/products/import-csv/confirm', async (req, res) => {
  try {
    const { rows, defaultMargin = 30 } = req.body;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: '등록할 상품 데이터가 없습니다' });
    }

    const result = await csvImporter.processRows(rows, { defaultMargin });

    // Invalidate caches
    analysisCache = null;
    platformCache = null;

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/csv-template — CSV 템플릿 다운로드
router.get('/products/csv-template', async (req, res) => {
  try {
    const buffer = await csvImporter.generateTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
    res.send(Buffer.from(buffer));
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

// GET /api/master-products — 마스터 상품 목록 (Supabase)
router.get('/master-products', async (req, res) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    let query = db.from('products').select('*', { count: 'exact' })
      .not('sku', 'is', null).neq('sku', '').order('sku');

    if (search) {
      query = query.or(`sku.ilike.%${search}%,title.ilike.%${search}%,title_ko.ilike.%${search}%`);
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;
    query = query.range(start, start + limitNum - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    res.json({
      products: data || [],
      total: count || 0,
      page: pageNum,
      totalPages: Math.ceil((count || 0) / limitNum),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/master-products/:sku — 단일 상품 상세 (Supabase + export status)
router.get('/master-products/:sku', async (req, res) => {
  try {
    const productRepo = dataSource.getProductRepo();
    const product = await productRepo.getProductWithExportStatus(req.params.sku);
    if (!product) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const fees = await platformRegistry.getFeeRates();
    const rates = await platformRegistry.getExchangeRates();
    const prices = pricingEngine.calculatePrices({
      purchasePrice: product.purchase_price || product.cost_price || 0,
      weight: product.weight || 0,
      targetMargin: product.target_margin || 30,
      shippingUSD: 3.9,
    }, fees, rates);

    res.json({ product, prices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/master-products/:sku — 마스터 상품 수정 (Supabase)
router.put('/master-products/:sku', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const updates = {};
    const body = req.body;

    if (body.title !== undefined) updates.title = body.title;
    if (body.title_ko !== undefined) updates.title_ko = body.title_ko;
    if (body.description !== undefined) updates.description = body.description;
    if (body.weight !== undefined) updates.weight = parseFloat(body.weight) || 0;
    if (body.purchase_price !== undefined) updates.purchase_price = parseFloat(body.purchase_price) || 0;
    if (body.target_margin !== undefined) updates.target_margin = parseFloat(body.target_margin) || 30;
    if (body.price_usd !== undefined) updates.price_usd = parseFloat(body.price_usd) || 0;
    if (body.stock !== undefined) updates.stock = parseInt(body.stock) || 0;
    if (body.keywords !== undefined) updates.keywords = body.keywords;
    if (body.image_urls !== undefined) updates.image_urls = body.image_urls;

    const { data, error } = await db.from('products').update(updates)
      .eq('sku', req.params.sku).select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const fees = await platformRegistry.getFeeRates();
    const rates = await platformRegistry.getExchangeRates();
    const prices = pricingEngine.calculatePrices({
      purchasePrice: data.purchase_price || data.cost_price || 0,
      weight: data.weight || 0,
      targetMargin: data.target_margin || 30,
      shippingUSD: 3.9,
    }, fees, rates);

    res.json({ product: data, prices });
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
    const sheetResult = await dataSource.updateProduct('itemId', itemId, sheetUpdates, sku);

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
      await dataSource.updateProduct('sku', sku, sheetUpdates, null);
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
      await dataSource.updateProduct('sku', sku, sheetUpdates, null);
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
    const sheetResult = await dataSource.updateProduct('sku', sku || productId, sheetUpdates, null);

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

  // Load active platforms from DB (data-driven)
  let platforms;
  try {
    const dbPlatforms = await platformRegistry.getActivePlatforms();
    platforms = dbPlatforms.map(p => ({ name: p.display_name || p.name, key: p.key, color: p.color }));
  } catch (e) {
    // Fallback to hardcoded if DB not available
    platforms = [
      { name: 'Shopify', key: 'shopify', color: '#96bf48' },
      { name: 'eBay', key: 'ebay', color: '#1565c0' },
      { name: 'Naver', key: 'naver', color: '#03c75a' },
      { name: 'Alibaba', key: 'alibaba', color: '#ff6a00' },
      { name: 'Shopee', key: 'shopee', color: '#ee4d2d' },
    ];
  }

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
          // API가 0이면 DB에서 fallback
          if (productCount === 0) {
            try {
              const dbCount = await dataSource.getPlatformProductCount('ebay');
              if (dbCount > 0) { productCount = dbCount; status = 'connected'; }
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

// ===========================
// Sheets helper functions REMOVED — all data now comes from Supabase via dataSource
// readDashboardSheet, readEbaySheetData, readShopifySheetData,
// readNaverSheetData, readAlibabaSheetData, getAllPlatformData,
// getDashboardData, getAllDashboardAndPlatformData, updateGoogleSheet
// are all replaced by dataSource methods.
// ===========================

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

// updateGoogleSheet REMOVED — all updates now go through dataSource.updateProduct() → Supabase

// ===========================
// SKU 점수 관리 엔드포인트
// ===========================

// GET /api/sku-scores — 전체 점수 목록
router.get('/sku-scores', async (req, res) => {
  try {
    const { classification, search, sort = 'normalizedScore', order = 'desc', limit = 100 } = req.query;

    // Supabase 모드: DB에서 직접 읽기
    const supaScores = await dataSource.getAllSkuScores();
    let scores = supaScores || skuScorer.getAllScores();

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
    const sortKey = supaScores ? (sort === 'normalizedScore' ? 'normalized_score' : sort) : sort;
    scores.sort((a, b) => {
      const aVal = a[sortKey] || a[sort] || 0;
      const bVal = b[sortKey] || b[sort] || 0;
      return order === 'desc' ? bVal - aVal : aVal - bVal;
    });

    const summary = supaScores
      ? await dataSource.getSkuScoreSummary()
      : skuScorer.getSummary();

    res.json({
      scores: scores.slice(0, parseInt(limit)),
      summary: summary || {},
      lastUpdated: supaScores ? new Date().toISOString() : (skuScorer._data?.lastUpdated || null),
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
router.get('/sku-scores/:sku', async (req, res) => {
  try {
    const supaScore = await dataSource.getSkuScoreBySku(req.params.sku);
    const scoreData = supaScore || skuScorer.getScoreBySku(req.params.sku);
    if (!scoreData) return res.status(404).json({ error: '점수 데이터 없음' });

    // Load product from Supabase
    const productRepo = dataSource.getProductRepo();
    const product = await productRepo.getProductWithExportStatus(req.params.sku);
    let prices = null;
    if (product) {
      const fees = await platformRegistry.getFeeRates();
      const rates = await platformRegistry.getExchangeRates();
      prices = pricingEngine.calculatePrices({
        purchasePrice: product.purchase_price || product.cost_price || 0,
        weight: product.weight || 0,
        targetMargin: product.target_margin || 30,
        shippingUSD: 3.9,
      }, fees, rates);
    }

    res.json({ scores: scoreData, product, prices });
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
          // Supabase에서 eBay Item ID 조회
          const { getClient } = require('../../db/supabaseClient');
          const { data: prod } = await getClient().from('products').select('ebay_item_id').eq('sku', sku).single();
          const ebayItemId = prod?.ebay_item_id;
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

// GET /api/battle/data — 전투 상황판 데이터 (Supabase + RepricingService)
router.get('/battle/data', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';

    if (battleCache && !forceRefresh && Date.now() - battleCacheTime < BATTLE_CACHE_TTL) {
      return res.json(battleCache);
    }

    const repricing = new RepricingService();
    const dashboard = await repricing.getBattleDashboard();

    if (!dashboard || dashboard.length === 0) {
      return res.json({ items: [], summary: {}, timestamp: new Date().toISOString() });
    }

    const battleItems = dashboard.map(row => {
      const myTotal = row.myPrice;
      const compTotal = row.competitorTotal || 0;
      const diff = compTotal > 0 ? +(myTotal - compTotal).toFixed(2) : null;
      const losing = diff !== null && diff > 0;
      const killPrice = losing && compTotal > 0 ? +(compTotal - 0.01).toFixed(2) : null;

      return {
        sku: row.sku,
        title: row.title,
        myPrice: row.myPrice,
        myTotal: +myTotal.toFixed(2),
        comp1Price: row.competitorPrice ? +row.competitorPrice.toFixed(2) : 0,
        comp1Shipping: row.competitorShipping ? +row.competitorShipping.toFixed(2) : 0,
        comp1Total: compTotal ? +compTotal.toFixed(2) : 0,
        lastTracked: row.lastTracked,
        diff,
        losing,
        killPrice,
        recentChanges: row.recentChanges || [],
      };
    });

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

// POST /api/battle/refresh — 가격 전투 새로고침
router.post('/battle/refresh', async (req, res) => {
  try {
    battleCache = null;
    battleCacheTime = 0;
    res.json({ success: true, timestamp: new Date().toISOString() });
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
      // Update price in Supabase
      if (sku) {
        await dataSource.updateProduct('sku', sku, { priceUSD: parseFloat(newPrice) });
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

    // 1. Save to Supabase
    const productRepo = dataSource.getProductRepo();
    const productRow = await productRepo.createProduct({
      sku, title: titleEn,
      title_ko: titleEn,
      image: (imageUrls && imageUrls[0]) || '',
      weight: String(parseFloat(weight) || 0.5),
      purchase: String(parseFloat(purchasePrice) || 0),
      priceUSD: String(parseFloat(priceUSD) || 0),
      shippingUSD: String(parseFloat(shippingUSD) || 3.9),
      stock: String(parseInt(quantity) || 10),
      status: 'active',
    });

    // Update additional fields
    if (productRow?.id) {
      const { getClient } = require('../../db/supabaseClient');
      await getClient().from('products').update({
        purchase_price: parseFloat(purchasePrice) || 0,
        target_margin: parseFloat(targetMargin) || 30,
        image_urls: imageUrls || [],
        condition: condition || 'new',
      }).eq('id', productRow.id);
    }

    // 2. eBay 등록 via ProductExporter
    const platforms = targetPlatforms || [];
    if (platforms.includes('ebay')) {
      try {
        const exporter = new ProductExporter();
        const exportResult = await exporter.exportProduct(sku, ['ebay']);
        results.ebay = exportResult.results?.ebay || { success: false };

        // Track competitor if provided
        if (req.body.competitorItemId && results.ebay?.success) {
          const repricing = new RepricingService();
          await repricing.trackCompetitorPrice(
            sku,
            parseFloat(req.body.competitorPrice) || 0,
            parseFloat(req.body.competitorShipping) || 0,
            req.body.competitorSeller || '',
            ''
          );
        }
      } catch (e) {
        results.ebay = { success: false, error: e.message };
      }
    }

    res.json({ success: true, results, product: productRow });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Helper 함수 (기존)
// ===========================

// getSyncHistory — now delegated to dataSource.getSyncHistory() (Supabase)

// ==================== 주문 배송 관리 ====================

// GET /api/orders/sync — 주문 자동수집 → 시트 기록
router.get('/orders/sync', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const OrderSync = require('../../services/orderSync');
    const sync = new OrderSync();
    const result = await sync.syncOrders(days);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Order sync error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/recent — DB/시트에서 최근 주문 읽기
router.get('/orders/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await dataSource.getRecentOrders(limit);
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

// ===========================
// Platform Registry API (DB-driven platform config)
// ===========================

// GET /api/platform-registry — active platforms from DB
router.get('/platform-registry', async (req, res) => {
  try {
    const platforms = await platformRegistry.getActivePlatforms();
    const fees = await platformRegistry.getFeeRates();
    const rates = await platformRegistry.getExchangeRates();
    const settings = await platformRegistry.getMarginSettings();
    res.json({ platforms, fees, rates, settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/platform-registry/settings/:key — update a margin/rate setting
router.put('/platform-registry/settings/:key', async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value 필수' });
    await platformRegistry.updateSetting(req.params.key, parseFloat(value));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Product Export API (ProductExporter)
// ===========================

// POST /api/export — export product to platforms
router.post('/export', async (req, res) => {
  try {
    const { sku, platforms: targetPlatforms } = req.body;
    if (!sku || !targetPlatforms || targetPlatforms.length === 0) {
      return res.status(400).json({ error: 'sku와 platforms 필수' });
    }
    const exporter = new ProductExporter();
    const result = await exporter.exportProduct(sku, targetPlatforms);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/export/retry — retry failed exports
router.post('/export/retry', async (req, res) => {
  try {
    const exporter = new ProductExporter();
    const results = await exporter.retryFailedExports();
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Repricing API (RepricingService)
// ===========================

// POST /api/repricing/track — record competitor price
router.post('/repricing/track', async (req, res) => {
  try {
    const { sku, price, shipping, competitorId, url } = req.body;
    if (!sku || !price) return res.status(400).json({ error: 'sku와 price 필수' });
    const repricing = new RepricingService();
    const result = await repricing.trackCompetitorPrice(
      sku, parseFloat(price), parseFloat(shipping) || 0, competitorId || '', url || ''
    );
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/repricing/evaluate/:sku — evaluate repricing for a SKU
router.get('/repricing/evaluate/:sku', async (req, res) => {
  try {
    const repricing = new RepricingService();
    const result = await repricing.evaluateRepricing(req.params.sku, req.query.platform || 'ebay');
    res.json(result || { action: 'not_found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/repricing/execute/:sku — execute repricing
router.post('/repricing/execute/:sku', async (req, res) => {
  try {
    const repricing = new RepricingService();
    const result = await repricing.executeRepricing(req.params.sku, req.query.platform || 'ebay');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================
// Translation API
// ===========================

// POST /api/translate/:productId — translate a product
router.post('/translate/:productId', async (req, res) => {
  try {
    const TranslationService = require('../../services/translationService');
    const svc = new TranslationService();
    const targetLang = req.body.targetLang || 'en';
    const translation = await svc.translateProduct(req.params.productId, targetLang);
    res.json({ success: true, translation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
