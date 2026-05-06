const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { requireAdmin } = require('../../middleware/auth');

const multer = require('multer');

// 뱃지 Gemini 생성 인메모리 캐시 (키: "badge:<text>:<style>", 값: {buf, at}, TTL 24h, 최대 100)
const badgeCache = new Map();

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
let _naverInstance = null;
function getNaverAPI() {
  if (!_naverInstance) {
    const NaverAPI = require('../../api/naverAPI');
    _naverInstance = new NaverAPI();
  }
  return _naverInstance;
}
function getAlibabaAPI() {
  const AlibabaAPI = require('../../api/alibabaAPI');
  return new AlibabaAPI();
}
let _shopeeInstance = null;
function getShopeeAPI() {
  if (!_shopeeInstance) {
    const ShopeeAPI = require('../../api/shopeeAPI');
    _shopeeInstance = new ShopeeAPI();
  }
  return _shopeeInstance;
}

// 캐시
let platformCache = null;
let platformCacheTime = 0;
let analysisCache = null;
let analysisCacheTime = 0;
const CACHE_TTL = 1800000; // 30분 — 플랫폼 상태는 거의 안 바뀜, 서버 부하·429 최소화
const ANALYSIS_CACHE_TTL = 120000; // 2분
let battleCache = null;
let battleCacheTime = 0;
const BATTLE_CACHE_TTL = 300000; // 5분

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
    const { platform, limit = 100, page = 1, search } = req.query;
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const lim = Math.min(parseInt(limit) || 100, 200);
    const pg = parseInt(page) || 1;
    const offset = (pg - 1) * lim;

    // naver/alibaba/shopee → platform_listings 공통 분기
    if (platform === 'naver' || platform === 'alibaba' || platform === 'shopee') {
      const sortBy = req.query.sort || 'updated_at';
      const sortDir = req.query.dir === 'asc' ? true : false;
      const sortCol = { price: 'price', stock: 'quantity', title: 'title', updated: 'updated_at' }[sortBy] || 'updated_at';
      let q = db.from('platform_listings')
        .select('*', { count: 'exact' })
        .eq('platform', platform)
        .order(sortCol, { ascending: sortDir });
      if (search) q = q.or(`sku.ilike.%${search}%,title.ilike.%${search}%,platform_item_id.ilike.%${search}%`);
      q = q.range(offset, offset + lim - 1);
      const { data, count } = await q;
      const platformLabel = { naver: '네이버', alibaba: 'Alibaba', shopee: 'Shopee' }[platform];
      return res.json({
        products: (data || []).map(r => ({
          sku: r.sku || r.platform_sku || '',
          itemId: r.platform_item_id || '',
          title: r.title || '',
          price: String(r.price || ''),
          shipping: String(r.shipping_cost || 0),
          platform: platformLabel,
          imageUrl: r.image_url || '',
          editId: r.platform_item_id || r.sku || '',
          quantity: String(r.quantity || ''),
        })),
        total: count || 0,
        page: pg,
        totalPages: Math.ceil((count || 0) / lim),
      });
    }

    // Platform-specific DB query with pagination
    if (platform === 'ebay') {
      const sortBy = req.query.sort || 'updated_at';
      const sortDir = req.query.dir === 'asc' ? true : false;
      const sortCol = { price: 'price_usd', stock: 'stock', title: 'title', updated: 'updated_at' }[sortBy] || 'updated_at';
      let q = db.from('ebay_products').select('*', { count: 'exact' }).neq('status', 'ended').order(sortCol, { ascending: sortDir });
      if (search) q = q.or(`sku.ilike.%${search}%,title.ilike.%${search}%,item_id.ilike.%${search}%`);
      q = q.range(offset, offset + lim - 1);
      const { data, count } = await q;
      return res.json({ products: (data || []).map(r => ({ sku: r.sku || '', itemId: r.item_id || '', title: r.title || '', price: String(r.price_usd || ''), shipping: String(r.shipping_usd || ''), platform: 'eBay', imageUrl: r.image_url || '', editId: r.item_id || r.sku || '', quantity: String(r.stock || '') })), total: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) });
    }

    if (platform === 'shopify') {
      const sSortBy = req.query.sort || 'updated_at';
      const sSortDir = req.query.dir === 'asc' ? true : false;
      const sSortCol = { price: 'price_usd', title: 'title', updated: 'updated_at' }[sSortBy] || 'updated_at';
      let q = db.from('shopify_products').select('*', { count: 'exact' }).order(sSortCol, { ascending: sSortDir });
      if (search) q = q.or(`sku.ilike.%${search}%,title.ilike.%${search}%`);
      q = q.range(offset, offset + lim - 1);
      const { data, count } = await q;
      return res.json({ products: (data || []).map(r => ({ sku: r.sku || '', itemId: '', title: r.title || '', price: String(r.price_usd || ''), shipping: '0', platform: 'Shopify', imageUrl: '', editId: r.sku || '', quantity: '' })), total: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) });
    }

    // 전체: eBay + Shopify counts, paginate eBay first then Shopify
    const [{ count: ebayCount }, { count: shopifyCount }] = await Promise.all([
      db.from('ebay_products').select('*', { count: 'exact', head: true }),
      db.from('shopify_products').select('*', { count: 'exact', head: true }),
    ]);
    const totalCount = (ebayCount || 0) + (shopifyCount || 0);
    let products = [];

    if (search) {
      // 검색 시: 양쪽 테이블에서 검색 후 합치기
      const [{ data: eRows }, { data: sRows }] = await Promise.all([
        db.from('ebay_products').select('*').or(`sku.ilike.%${search}%,title.ilike.%${search}%,item_id.ilike.%${search}%`).order('updated_at', { ascending: false }).limit(lim),
        db.from('shopify_products').select('*').or(`sku.ilike.%${search}%,title.ilike.%${search}%`).order('updated_at', { ascending: false }).limit(lim),
      ]);
      (eRows || []).forEach(r => products.push({ sku: r.sku || '', itemId: r.item_id || '', title: r.title || '', price: String(r.price_usd || ''), shipping: String(r.shipping_usd || ''), platform: 'eBay', imageUrl: r.image_url || '', editId: r.item_id || r.sku || '', quantity: String(r.stock || '') }));
      (sRows || []).forEach(r => products.push({ sku: r.sku || '', itemId: '', title: r.title || '', price: String(r.price_usd || ''), shipping: '0', platform: 'Shopify', imageUrl: '', editId: r.sku || '', quantity: '' }));
      return res.json({ products: products.slice(0, lim), total: products.length, page: 1, totalPages: 1 });
    }

    // 페이지네이션: eBay 먼저, 넘치면 Shopify
    const ec = ebayCount || 0;
    if (offset < ec) {
      const { data } = await db.from('ebay_products').select('*').order('updated_at', { ascending: false }).range(offset, Math.min(offset + lim - 1, ec - 1));
      (data || []).forEach(r => products.push({ sku: r.sku || '', itemId: r.item_id || '', title: r.title || '', price: String(r.price_usd || ''), shipping: String(r.shipping_usd || ''), platform: 'eBay', imageUrl: r.image_url || '', editId: r.item_id || r.sku || '', quantity: String(r.stock || '') }));
    }
    if (products.length < lim) {
      const shopifyOffset = Math.max(0, offset - ec);
      const shopifyLim = lim - products.length;
      const { data } = await db.from('shopify_products').select('*').order('updated_at', { ascending: false }).range(shopifyOffset, shopifyOffset + shopifyLim - 1);
      (data || []).forEach(r => products.push({ sku: r.sku || '', itemId: '', title: r.title || '', price: String(r.price_usd || ''), shipping: '0', platform: 'Shopify', imageUrl: '', editId: r.sku || '', quantity: '' }));
    }

    res.json({ products, total: totalCount, page: pg, totalPages: Math.ceil(totalCount / lim) });
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

  // DISABLED: Google Sheets → eBay sync scripts (caused unwanted stock/price changes)
  // Use Supabase-based sync only
  const syncScripts = {
    // ebay: 'node src/sync/sync-ebay-price-shipping.js', // DISABLED
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

// 매출 캐시 — period별로 별도 캐싱
const revenueCaches = new Map(); // cacheKey(period:days) → { data, time }
const REVENUE_CACHE_TTL = 300000; // 5분

/**
 * period → days 변환
 *  today   : 오늘 1일
 *  week    : 이번 주 (월요일~오늘)
 *  month   : 이번 달 1일~오늘 (default)  ← 월초 0원으로 리셋
 *  30d     : 최근 30일 (슬라이딩)
 *  60d     : 최근 60일
 *  90d     : 최근 90일
 *  year    : 올해 1월 1일~오늘
 */
function resolvePeriod(period, fallbackDays) {
  const now = new Date();
  const p = String(period || '').toLowerCase();
  if (p === 'today') return { days: 1, label: '오늘', key: 'today' };
  if (p === 'week') {
    const dow = now.getDay(); // 0=일, 1=월...
    const monOffset = dow === 0 ? 6 : dow - 1;
    return { days: monOffset + 1, label: '이번 주', key: 'week' };
  }
  if (p === 'month') {
    return { days: now.getDate(), label: `${now.getMonth() + 1}월 누적`, key: 'month' };
  }
  if (p === '30d') return { days: 30, label: '최근 30일', key: '30d' };
  if (p === '60d') return { days: 60, label: '최근 60일', key: '60d' };
  if (p === '90d') return { days: 90, label: '최근 90일', key: '90d' };
  if (p === 'year') {
    const start = new Date(now.getFullYear(), 0, 1);
    const d = Math.max(1, Math.ceil((now - start) / 86400000) + 1);
    return { days: d, label: `${now.getFullYear()}년 누적`, key: 'year' };
  }
  // fallback: ?days=N
  const n = parseInt(fallbackDays) || 30;
  return { days: n, label: `최근 ${n}일`, key: `d${n}` };
}

// GET /api/revenue/summary — 전체 플랫폼 API 기반 실제 매출
router.get('/revenue/summary', async (req, res) => {
  try {
    // period 우선, 없으면 days fallback, 기본값은 'month'
    const { days, label: periodLabel, key: periodKey } = resolvePeriod(
      req.query.period || (req.query.days ? null : 'month'),
      req.query.days
    );
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `${periodKey}:${days}`;

    const cached = revenueCaches.get(cacheKey);
    if (cached && !forceRefresh && Date.now() - cached.time < REVENUE_CACHE_TTL) {
      return res.json(cached.data);
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
      // Naver — 싱글톤이라 토큰은 내부 캐시됨. getRevenueSummary 내부에서 lazy init
      (async () => {
        try {
          const api = getNaverAPI();
          return await api.getRevenueSummary(days);
        } catch (e) { return { error: e.message }; }
      })(),
      // Shopee
      (async () => {
        try {
          const api = getShopeeAPI();
          return await api.getRevenueSummary(days);
        } catch (e) { return { error: e.message }; }
      })(),
    ]);

    const rates = await platformRegistry.getExchangeRates();
    const exchangeRate = rates.usd || 1400; // USD → KRW from DB
    const platforms = {};
    const platformNames = ['Shopify', 'eBay', 'Naver', 'Shopee'];

    platformNames.forEach((name, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && !r.value.error) {
        const data = r.value;
        const isKRW = name === 'Naver';
        // Shopee uses revenue/orders fields; others use totalRevenue/orderCount
        const revenue = data.revenue !== undefined
          ? data.revenue
          : (data.totalRevenue || data.payAmount || 0);
        const orders = data.orders !== undefined
          ? data.orders
          : (data.orderCount || 0);
        platforms[name] = {
          revenue,
          revenueKRW: isKRW
            ? revenue
            : Math.round(revenue * exchangeRate),
          orders,
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
      periodKey,
      periodLabel,
      timestamp: new Date().toISOString(),
    };

    revenueCaches.set(cacheKey, { data: response, time: Date.now() });

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

    // Load valid platform names from DB (data-driven)
    let validPlatforms;
    try {
      const dbPlatforms = await platformRegistry.getActivePlatforms();
      validPlatforms = dbPlatforms.map(p => p.name);
    } catch (e) {
      validPlatforms = ['eBay', 'Shopify', 'Naver', 'Alibaba', 'Shopee'];
    }

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

    // 품절 복구 필요: ebay_api_stock이 0이고 이전에 재고가 있었던 상품
    const { getClient } = require('../../db/supabaseClient');
    const anomDb = getClient();
    let outOfStock = [];
    try {
      const { data: oosData } = await anomDb.from('ebay_products')
        .select('item_id, sku, title, stock, ebay_api_stock')
        .eq('ebay_api_stock', 0)
        .neq('status', 'ended')
        .gt('stock', 0)
        .limit(50);
      outOfStock = (oosData || []).map(r => ({
        itemId: r.item_id, sku: r.sku, title: (r.title || '').slice(0, 60),
        prevStock: r.stock, status: 'eBay에서 품절'
      }));
    } catch (e) {}

    // ebay_api_stock 컬럼이 없으면 stock=0인 상품으로 대체
    if (outOfStock.length === 0) {
      try {
        const { data: oosData2 } = await anomDb.from('ebay_products')
          .select('item_id, sku, title, stock')
          .eq('stock', 0)
          .neq('status', 'ended')
          .limit(50);
        outOfStock = (oosData2 || []).map(r => ({
          itemId: r.item_id, sku: r.sku, title: (r.title || '').slice(0, 60),
          prevStock: 0, status: '재고 0'
        }));
      } catch (e) {}
    }

    // 경쟁사 이상: competitor_alerts 최근 50개
    let compAnomalies = [];
    try {
      const { data: alertData } = await anomDb.from('competitor_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      compAnomalies = (alertData || []).map(a => {
        let parsed = {};
        try { parsed = JSON.parse(a.data || '{}'); } catch(e) {}
        return {
          sku: a.sku, seller: a.seller_id, type: a.type,
          competitorId: a.competitor_id, message: a.message,
          oldPrice: parsed.oldPrice, newPrice: parsed.newPrice,
          createdAt: a.created_at,
        };
      });
    } catch (e) {}

    res.json({
      ...anomalies,
      outOfStock,
      compAnomalies,
      summary: {
        lowMargin: anomalies.lowMargin.length,
        lowStock: anomalies.lowStock.length,
        salesDrop: anomalies.salesDrop.length,
        outOfStock: outOfStock.length,
        compAnomalies: compAnomalies.length,
        total: anomalies.lowMargin.length + anomalies.lowStock.length + anomalies.salesDrop.length + outOfStock.length + compAnomalies.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/ebay/clear-sku — SKU(Custom Label) 일괄 초기화 (Lister 연결 끊기)
router.post('/products/ebay/clear-sku', async (req, res) => {
  try {
    const ebay = getEbayAPI();
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    let allItems = [];
    let page = 1;
    while (page <= 25) {
      const result = await ebay.getActiveListings(page, 200);
      if (!result.items || result.items.length === 0) break;
      for (const item of result.items) {
        const sku = item.sku || '';
        if (sku && !sku.startsWith('PMC-') && !sku.startsWith('pmc-')) {
          allItems.push({ itemId: item.itemId, sku });
        }
      }
      if (!result.hasMore) break;
      page++;
    }

    console.log(`[clear-sku] Found ${allItems.length} items with non-PMC SKU`);
    let cleared = 0, failed = 0;
    for (const item of allItems) {
      const result = await ebay.clearCustomLabel(item.itemId);
      if (result.success) {
        cleared++;
        await db.from('ebay_products').update({ sku: item.itemId }).eq('item_id', item.itemId);
      } else {
        failed++;
      }
      if (cleared % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    }

    platformCache = null;
    res.json({ success: true, total: allItems.length, cleared, failed });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/anomalies/restore-stock — 품절 상품 재고 복구
router.post('/anomalies/restore-stock', async (req, res) => {
  try {
    const { itemId, quantity } = req.body;
    const qty = parseInt(quantity) || 5;
    const ebay = getEbayAPI();
    const result = await ebay.updateItem(itemId, { quantity: qty });
    if (result.success) {
      const { getClient } = require('../../db/supabaseClient');
      const db = getClient();
      await db.from('ebay_products').update({ stock: qty, ebay_api_stock: qty }).eq('item_id', itemId);
    }
    res.json({ success: result.success, itemId, quantity: qty, error: result.error });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
      .not('sku', 'is', null).neq('sku', '')
      .neq('status', 'trashed')
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(`sku.ilike.%${search}%,title.ilike.%${search}%,title_ko.ilike.%${search}%`);
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;
    query = query.range(start, start + limitNum - 1);

    const { data, count, error } = await query;
    if (error) throw error;

    // Join platform data from ebay_products and shopify_products
    const products = data || [];
    if (products.length > 0) {
      const skus = products.map(p => p.sku).filter(Boolean);
      const ebayItemIds = products.map(p => p.ebay_item_id).filter(Boolean);
      const allKeys = [...new Set([...skus, ...ebayItemIds])];

      // Fetch eBay listings
      let ebayMap = {};
      if (allKeys.length > 0) {
        for (let i = 0; i < allKeys.length; i += 500) {
          const chunk = allKeys.slice(i, i + 500);
          const { data: ebayData } = await db.from('ebay_products')
            .select('item_id, sku, price_usd, shipping_usd, stock, status')
            .in('sku', chunk);
          (ebayData || []).forEach(e => { ebayMap[e.sku] = e; });
        }
        // Also match by item_id for products with ebay_item_id
        if (ebayItemIds.length > 0) {
          const { data: ebayById } = await db.from('ebay_products')
            .select('item_id, sku, price_usd, shipping_usd, stock, status')
            .in('item_id', ebayItemIds);
          (ebayById || []).forEach(e => { ebayMap[e.item_id] = e; });
        }
      }

      // Fetch Shopify listings
      let shopifyMap = {};
      if (skus.length > 0) {
        for (let i = 0; i < skus.length; i += 500) {
          const chunk = skus.slice(i, i + 500);
          const { data: shopData } = await db.from('shopify_products')
            .select('sku, title, price_usd, status')
            .in('sku', chunk);
          (shopData || []).forEach(s => { shopifyMap[s.sku] = s; });
        }
      }

      // Attach platform info to each product
      products.forEach(p => {
        const ebay = ebayMap[p.sku] || ebayMap[p.ebay_item_id] || null;
        const shopify = shopifyMap[p.sku] || null;
        p.platforms = {
          ebay: ebay ? { itemId: ebay.item_id, price: ebay.price_usd, stock: ebay.stock, status: ebay.status, link: `https://www.ebay.com/itm/${ebay.item_id}` } : null,
          shopify: shopify ? { price: shopify.price_usd, status: shopify.status } : null,
        };
      });
    }

    res.json({
      products,
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

// PUT /api/products/ebay/:itemId — eBay 가격/수량 수정 + Supabase 동기화
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

    // Sync to Supabase (products table)
    const dbUpdates = {};
    if (price !== undefined) dbUpdates.priceUSD = price;
    if (quantity !== undefined) dbUpdates.stock = quantity;
    const dbResult = await dataSource.updateProduct('itemId', itemId, dbUpdates, sku);

    // Sync to ebay_products table
    const { getClient } = require('../../db/supabaseClient');
    const ebayDb = getClient();
    const ebayUpdates = {};
    if (price !== undefined) ebayUpdates.price_usd = parseFloat(price);
    if (quantity !== undefined) ebayUpdates.stock = parseInt(quantity);
    ebayUpdates.updated_at = new Date().toISOString();
    await ebayDb.from('ebay_products').update(ebayUpdates).eq('item_id', itemId);

    res.json({
      success: result.success,
      platform: 'eBay',
      itemId,
      updates,
      dbSync: dbResult.success,
      error: result.error
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/ebay/:itemId — eBay 리스팅 종료 (End Listing)
router.delete('/products/ebay/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const api = getEbayAPI();
    const result = await api.endListing(itemId);
    // Update DB regardless (already closed = still ended)
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    await db.from('ebay_products').update({ status: 'ended' }).eq('item_id', itemId);
    platformCache = null;

    // "auction has been closed" means already ended — treat as success
    if (!result.success && result.error && (result.error.includes('closed') || result.error.includes('ended'))) {
      result.success = true;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/products/shopify/:variantId — Shopify 가격 수정 + Supabase 동기화
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

    // Sync to Supabase
    if (sku) {
      const dbUpdates = {};
      if (price !== undefined) dbUpdates.priceUSD = price;
      if (inventory_quantity !== undefined) dbUpdates.stock = inventory_quantity;
      await dataSource.updateProduct('sku', sku, dbUpdates, null);
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

// PUT /api/products/naver/:productNo — 네이버 가격/재고 수정 + Supabase 동기화
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

    // Sync to Supabase
    if (sku) {
      const dbUpdates = {};
      if (price !== undefined) dbUpdates.priceUSD = price;
      if (stock !== undefined) dbUpdates.stock = stock;
      await dataSource.updateProduct('sku', sku, dbUpdates, null);
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

// PUT /api/products/alibaba/:productId — Alibaba price/stock update (Supabase)
router.put('/products/alibaba/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { price, quantity, sku } = req.body;

    // Alibaba ICBU API has limited update support — sync to Supabase only
    const dbUpdates = {};
    if (price !== undefined) dbUpdates.priceUSD = price;
    if (quantity !== undefined) dbUpdates.stock = quantity;
    const dbResult = await dataSource.updateProduct('sku', sku || productId, dbUpdates, null);

    platformCache = null;
    analysisCache = null;

    res.json({
      success: dbResult.success,
      platform: 'Alibaba',
      productId,
      note: 'Supabase에 반영됨 (Alibaba는 Seller Center에서 직접 수정)',
      error: dbResult.error
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/products/shopee/:itemId — Shopee price/stock update
router.put('/products/shopee/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { price, quantity, shopId } = req.body;
    const api = getShopeeAPI();
    const sid = shopId || null;

    if (price !== undefined) {
      await api.updatePrice(parseInt(itemId), parseFloat(price), null, sid);
    }
    if (quantity !== undefined) {
      await api.updateStock(parseInt(itemId), parseInt(quantity), null, sid);
    }

    platformCache = null;
    res.json({ success: true, platform: 'Shopee', itemId });
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
    console.error('Failed to load platforms from DB:', e.message);
    platforms = [];
  }

  const results = await Promise.all(platforms.map(async (p) => {
    let productCount = 0;
    let status = 'disconnected';

    try {
      switch (p.key) {
        case 'shopify': {
          // DB (shopify_products)에서 카운트 — 라이브 API 대신 사용해 429 방지.
          // shopify_products는 4am 플랫폼 동기화로 갱신됨.
          try {
            const dbCount = await dataSource.getPlatformProductCount('shopify');
            productCount = dbCount || 0;
            status = dbCount > 0 ? 'connected' : 'disconnected';
          } catch (e) {
            // DB도 실패하면 라이브 한 번 시도 (token/credential 확인 용도)
            const api = getShopifyAPI();
            const count = await api.getProductCount();
            productCount = count || 0;
            status = 'connected';
          }
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
          const api = getShopeeAPI();
          const counts = await api.getAllShopsTotalCount();
          productCount = counts.reduce((s, c) => s + c.total, 0);
          status = 'connected';
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

  if (!platformFilter || platformFilter === 'shopee') {
    fetchTasks.push((async () => {
      try {
        const api = getShopeeAPI();
        const items = await api.getProductsWithDetails(0, Math.min(limit, 50));
        return items.map(p => ({
          sku: String(p.item_id || ''),
          itemId: String(p.item_id || ''),
          title: p.item_name || '',
          price: p.price_info?.[0]?.current_price || '',
          shipping: '',
          platform: 'Shopee',
          imageUrl: p.image?.image_url_list?.[0] || '',
          editId: String(p.item_id || ''),
          quantity: p.stock_info_v2?.seller_stock?.[0]?.stock ?? p.stock_info?.[0]?.current_stock ?? '',
        }));
      } catch (e) {
        console.error('Shopee 상품 조회 실패:', e.message);
        return [];
      }
    })());
  }

  const results = await Promise.all(fetchTasks);
  results.forEach(items => allProducts.push(...items));

  return allProducts.slice(0, limit);
}

// eBay 제외 플랫폼만 조회 (전체 상품 페이지에서 eBay는 Supabase 대시보드 데이터 사용)
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
      const myTotal = +(row.myPrice + (row.myShipping || 0)).toFixed(2);
      const compTotal = row.cheapestTotal || 0;
      const diff = compTotal > 0 ? +(myTotal - compTotal).toFixed(2) : null;
      const losing = diff !== null && diff > 0;
      // 킬 프라이스 = 경쟁사 합계 - $2 - 내 배송비 (내 합계가 경쟁사보다 $2 싸게)
      const myShip = row.myShipping || 0;
      const killPrice = losing ? +Math.max(0.99, compTotal - 2.00 - myShip).toFixed(2) : null;

      return {
        sku: row.sku,
        itemId: row.itemId,
        title: row.title,
        myPrice: row.myPrice,
        myShipping: row.myShipping || 0,
        myLastSyncedAt: row.myLastSyncedAt || null,
        quantity: row.quantity || 0,
        myTotal,
        competitors: row.competitors || [],
        lastTracked: row.lastTracked,
        diff,
        losing,
        killPrice,
        recentChanges: row.recentChanges || [],
      };
    });

    const withComp = battleItems.filter(i => i.competitors.length > 0);
    const losingItems = withComp.filter(i => i.losing);

    // 유니크 셀러 목록 추출
    const sellerSet = new Set();
    battleItems.forEach(i => i.competitors.forEach(c => { if (c.seller) sellerSet.add(c.seller); }));
    const uniqueSellers = [...sellerSet].sort();

    const summary = {
      totalItems: battleItems.length,
      withCompetitor: withComp.length,
      losing: losingItems.length,
      winning: withComp.length - losingItems.length,
      avgDiff: withComp.length > 0
        ? +(withComp.reduce((s, i) => s + (i.diff || 0), 0) / withComp.length).toFixed(2)
        : 0,
      uniqueSellers,
    };

    // 가격 데이터의 신선도 — ebay_products.updated_at 최대값
    let ebayLastSyncedAt = null;
    try {
      const { getClient } = require('../../db/supabaseClient');
      const { data } = await getClient()
        .from('ebay_products')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1);
      ebayLastSyncedAt = data?.[0]?.updated_at || null;
    } catch { /* 조회 실패는 그냥 null */ }

    const response = {
      items: battleItems,
      summary,
      timestamp: new Date().toISOString(),
      ebayLastSyncedAt,
    };

    battleCache = response;
    battleCacheTime = Date.now();

    res.json(response);
  } catch (error) {
    console.error('Battle dashboard error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/battle/refresh — 가격 전투 캐시 무효화 + (옵션) eBay 재동기화
// body: { syncEbay: boolean } — true면 실제 eBay API 호출해서 ebay_products 테이블 갱신
router.post('/battle/refresh', async (req, res) => {
  try {
    const { syncEbay } = req.body || {};
    battleCache = null;
    battleCacheTime = 0;

    if (syncEbay) {
      try {
        const { syncPlatformProducts } = require('../../services/productSync');
        const r = await syncPlatformProducts(['ebay']);
        return res.json({ success: true, synced: r, timestamp: new Date().toISOString() });
      } catch (e) {
        console.error('[battle/refresh] eBay sync 실패:', e.message);
        return res.status(500).json({ success: false, error: 'eBay 동기화 실패: ' + e.message });
      }
    }

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

    const price = parseFloat(newPrice);

    // Check for suspicious competitor (price crash > 50%) — only active competitors with real item IDs
    if (sku) {
      const { getClient } = require('../../db/supabaseClient');
      const cpDb = getClient();
      const { data: comps } = await cpDb.from('competitor_prices')
        .select('competitor_price, prev_price, status, competitor_id')
        .eq('sku', sku)
        .neq('competitor_id', '')
        .order('competitor_price', { ascending: true });

      // Check if ALL active competitors are ended
      const activeComps = (comps || []).filter(c => c.status !== 'ended' && c.competitor_id);
      if (activeComps.length === 0 && comps && comps.length > 0) {
        // All competitors ended — warn but don't block
        console.log('[kill-price] Warning: all competitors ended for', sku);
      }

      // Check for price crash on active competitors only
      const cheapest = activeComps[0];
      if (cheapest && cheapest.prev_price && cheapest.competitor_price) {
        const drop = (cheapest.prev_price - cheapest.competitor_price) / cheapest.prev_price * 100;
        if (drop >= 50) {
          return res.json({ success: false, error: `경쟁사 가격이 ${drop.toFixed(0)}% 폭락 — 비정상 가격, 따라가지 마세요 (이전: $${cheapest.prev_price}, 현재: $${cheapest.competitor_price})` });
        }
      }
    }

    const ebay = getEbayAPI();
    const result = await ebay.updateItem(itemId, { price });

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

// POST /api/battle/import-competitors — Google Sheets에서 경쟁사 데이터 임포트
router.post('/battle/import-competitors', async (req, res) => {
  try {
    const scriptPath = require('path').join(__dirname, '../../../scripts/import-competitor-prices');
    delete require.cache[require.resolve(scriptPath)];
    const { importCompetitorPrices } = require(scriptPath);
    const result = await importCompetitorPrices();
    // Clear battle cache so next load picks up new competitor data
    battleCache = null;
    battleCacheTime = 0;
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[import-competitors]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/battle/add-competitor — 경쟁사 아이템 ID로 가격+배송비 조회 후 저장
router.post('/battle/add-competitor', async (req, res) => {
  try {
    const { mySku, competitorItemId } = req.body;
    if (!mySku || !competitorItemId) {
      return res.status(400).json({ success: false, error: 'mySku와 competitorItemId가 필요합니다' });
    }

    // eBay Shopping API → Browse API fallback으로 경쟁사 가격 조회
    const ebay = getEbayAPI();
    const itemId = String(competitorItemId).trim();
    let item = null;

    // 1차: Shopping API
    try {
      item = await ebay.getCompetitorItemDetail(itemId);
    } catch (e) {
      console.warn('[add-competitor] Shopping API failed:', e.message);
    }

    // 2차: Browse API fallback (Shopping API rate limit 대비)
    if (!item) {
      try {
        console.log('[add-competitor] Trying Browse API for', itemId);
        item = await ebay._fetchViaBrowseAPI(itemId);
      } catch (e) {
        console.warn('[add-competitor] Browse API also failed:', e.message);
      }
    }

    // competitor_prices 테이블에 저장 (API 실패해도 item ID로 직접 저장)
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const row = {
      sku: mySku,
      platform: 'ebay',
      competitor_id: item ? item.itemId : itemId,
      competitor_price: item ? (item.price || 0) : 0,
      competitor_shipping: item ? (item.shippingCost || 0) : 0,
      competitor_url: item ? (item.viewItemURL || `https://www.ebay.com/itm/${itemId}`) : `https://www.ebay.com/itm/${itemId}`,
      seller_id: item ? (item.seller || '') : '',
      seller_feedback: item ? (item.sellerFeedbackScore || 0) : 0,
      title: item ? (item.title || '') : '',
      tracked_at: new Date().toISOString(),
      // 신규: 변형 + 재고 (마이그레이션 034)
      price_min: item?.priceMin ?? null,
      price_max: item?.priceMax ?? null,
      variant_count: item?.variantCount ?? 1,
      quantity_available: item?.quantityAvailable ?? null,
      status: item?.status || 'active',
      last_refreshed_at: new Date().toISOString(),
    };
    const upsertWithFallback = async (payload) => {
      const compId = payload.competitor_id;
      const { data: existing } = await db.from('competitor_prices')
        .select('id').eq('sku', mySku).eq('competitor_id', compId).limit(1);
      const op = existing && existing.length > 0
        ? db.from('competitor_prices').update(payload).eq('id', existing[0].id)
        : db.from('competitor_prices').insert(payload);
      const { error } = await op;
      if (error && error.code === '42703') {
        // 마이그레이션 034 미적용 → 신규 컬럼 빼고 재시도
        const legacy = { ...payload };
        ['price_min','price_max','variant_count','quantity_available','status','last_refreshed_at','title'].forEach(k => delete legacy[k]);
        return upsertWithFallback(legacy);
      }
      if (error) console.error('[add-competitor] DB error:', error.message);
    };
    await upsertWithFallback(row);

    // 캐시 초기화
    battleCache = null;
    battleCacheTime = 0;

    res.json({
      success: true,
      competitor: {
        itemId: item ? item.itemId : itemId,
        title: item ? item.title : '(API 조회 실패 — 나중에 업데이트)',
        price: item ? item.price : 0,
        shipping: item ? item.shippingCost : 0,
        total: item ? (item.price + item.shippingCost) : 0,
        seller: item ? item.seller : '',
      }
    });
  } catch (e) {
    console.error('[add-competitor]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/battle/listing/:itemId/refresh — 내 eBay 리스팅 즉시 Browse API 갱신
router.post('/battle/listing/:itemId/refresh', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const itemId = String(req.params.itemId || '').trim();
    if (!/^\d{9,15}$/.test(itemId)) return res.status(400).json({ success: false, error: 'invalid itemId' });

    const ebay = getEbayAPI();
    let item = null;
    try {
      item = await ebay._fetchViaBrowseAPI(itemId);
    } catch (e) {
      // 404 = ended
      const isGone = /not\s*found|404/i.test(e.message || '');
      const updates = { status: isGone ? 'ended' : 'active', updated_at: new Date().toISOString() };
      await db.from('ebay_products').update(updates).eq('item_id', itemId);
      battleCache = null; battleCacheTime = 0;
      return res.json({ success: true, status: updates.status, error: e.message });
    }

    const updates = {
      price_usd: item.price || 0,
      shipping_usd: item.shippingCost || 0,
      stock: Number.isFinite(item.quantityAvailable) ? item.quantityAvailable : null,
      ebay_api_stock: Number.isFinite(item.quantityAvailable) ? item.quantityAvailable : null,
      title: item.title || null,
      status: item.status === 'out_of_stock' ? 'active' : (item.status || 'active'),
      updated_at: new Date().toISOString(),
    };
    // null stock 처리 (마이그레이션 따라 컬럼 없을 수 있음)
    if (updates.stock === null) delete updates.stock;
    if (updates.ebay_api_stock === null) delete updates.ebay_api_stock;

    const { error: uErr } = await db.from('ebay_products').update(updates).eq('item_id', itemId);
    if (uErr) {
      // 일부 컬럼이 없을 수 있음 (예: title, ebay_api_stock 누락 시 그냥 핵심만)
      const minimal = { price_usd: updates.price_usd, shipping_usd: updates.shipping_usd, updated_at: updates.updated_at };
      await db.from('ebay_products').update(minimal).eq('item_id', itemId);
    }
    battleCache = null; battleCacheTime = 0;

    res.json({
      success: true,
      itemId,
      price: item.price,
      shipping: item.shippingCost,
      stock: item.quantityAvailable,
      status: updates.status,
    });
  } catch (e) {
    console.error('[battle/listing/refresh]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/battle/competitor/:id/refresh — 즉시 Browse API 재조회 + DB 갱신
router.post('/battle/competitor/:id/refresh', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    // competitor_prices.id 는 UUID (문자열). parseInt 하면 안 됨.
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });

    const { data: comp, error: fErr } = await db.from('competitor_prices')
      .select('*').eq('id', id).maybeSingle();
    if (fErr || !comp) return res.status(404).json({ success: false, error: 'competitor 없음' });

    const ebay = getEbayAPI();
    let item = null;
    try { item = await ebay._fetchViaBrowseAPI(comp.competitor_id); }
    catch (e) {
      // 404 = ended listing
      const isGone = /not\s*found|404/i.test(e.message || '');
      const updates = {
        status: isGone ? 'ended' : 'error',
        last_refreshed_at: new Date().toISOString(),
      };
      await db.from('competitor_prices').update(updates).eq('id', id).then(() => {})
        .catch(err => { if (err.code !== '42703') throw err; });
      return res.json({ success: true, status: updates.status, error: e.message });
    }

    const updates = {
      competitor_price: item.price || 0,
      competitor_shipping: item.shippingCost || 0,
      title: item.title || comp.title || '',
      seller_id: comp.seller_id || item.seller || '',
      tracked_at: new Date().toISOString(),
      last_refreshed_at: new Date().toISOString(),
      price_min: item.priceMin ?? null,
      price_max: item.priceMax ?? null,
      variant_count: item.variantCount ?? 1,
      quantity_available: item.quantityAvailable ?? null,
      status: item.status || 'active',
    };
    let { error: uErr } = await db.from('competitor_prices').update(updates).eq('id', id);
    if (uErr && uErr.code === '42703') {
      const legacy = { ...updates };
      ['price_min','price_max','variant_count','quantity_available','status','last_refreshed_at','title'].forEach(k => delete legacy[k]);
      await db.from('competitor_prices').update(legacy).eq('id', id);
    }
    battleCache = null; battleCacheTime = 0;

    res.json({
      success: true,
      itemId: item.itemId,
      price: item.price,
      shipping: item.shippingCost,
      priceMin: item.priceMin,
      priceMax: item.priceMax,
      variantCount: item.variantCount,
      quantityAvailable: item.quantityAvailable,
      status: item.status,
    });
  } catch (e) {
    console.error('[battle/refresh]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/battle/competitor/:id/override — 수동 가격 고정 (변형 리스팅용)
router.patch('/battle/competitor/:id/override', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });
    const { price, shipping } = req.body || {};
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
      return res.status(400).json({ success: false, error: '유효한 가격 필요' });
    }
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const updates = {
      manual_price_override: Number(price),
      manual_shipping_override: shipping != null && shipping !== '' ? Number(shipping) : null,
    };
    const { error } = await db.from('competitor_prices').update(updates).eq('id', id);
    if (error) {
      if (error.code === '42703') return res.status(400).json({ success: false, error: '마이그레이션 034 미적용' });
      throw error;
    }
    battleCache = null; battleCacheTime = 0;
    res.json({ success: true, ...updates });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/battle/competitor/:id/override — 수동 고정 해제
router.delete('/battle/competitor/:id/override', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { error } = await db.from('competitor_prices').update({
      manual_price_override: null,
      manual_shipping_override: null,
    }).eq('id', id);
    if (error && error.code !== '42703') throw error;
    battleCache = null; battleCacheTime = 0;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/battle/competitor/:id/find-similar — ended 경쟁사의 셀러가 새 itemId 로 재등록한 리스팅 후보 검색
// query param 없이도 OK. 같은 셀러의 active 리스팅 전체 → ended row 제목과 fuzzy match → top 10.
router.get('/battle/competitor/:id/find-similar', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });

    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data: comp } = await db.from('competitor_prices')
      .select('id, sku, competitor_id, seller_id, title')
      .eq('id', id).maybeSingle();
    if (!comp) return res.status(404).json({ success: false, error: 'competitor 없음' });
    if (!comp.seller_id) return res.status(400).json({ success: false, error: '셀러 정보 없음 (수동 추가된 row 일 수 있음)' });

    const ebay = getEbayAPI();
    const candidates = await ebay.findSellerListings(comp.seller_id, 2); // 2 pages 만 — 빠르게

    // 이미 추적 중인 itemId 는 제외
    const { data: tracked } = await db.from('competitor_prices')
      .select('competitor_id').eq('sku', comp.sku);
    const trackedSet = new Set((tracked || []).map(r => r.competitor_id));

    // Token 기반 유사도 (Jaccard)
    const tokenize = (s) => String(s || '').toLowerCase()
      .replace(/[\[\](){}\/\\,.;:!?'"]/g, ' ')
      .split(/\s+/).filter(t => t.length >= 2);
    const baseTokens = new Set(tokenize(comp.title));

    const scored = candidates
      .filter(c => !trackedSet.has(c.itemId)) // 이미 추적 중 제외
      .map(c => {
        const ts = new Set(tokenize(c.title));
        const inter = [...baseTokens].filter(t => ts.has(t)).length;
        const union = new Set([...baseTokens, ...ts]).size;
        const similarity = union > 0 ? inter / union : 0;
        return { ...c, similarity };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 15);

    res.json({
      success: true,
      base: { sku: comp.sku, oldItemId: comp.competitor_id, oldTitle: comp.title, seller: comp.seller_id },
      candidates: scored,
      totalSellerListings: candidates.length,
    });
  } catch (e) {
    console.error('[battle/find-similar]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/battle/target-sellers — 타겟 셀러 목록
router.get('/battle/target-sellers', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data } = await db.from('target_sellers').select('*').order('tier', { ascending: true });
    const sellers = data || [];
    for (const s of sellers) {
      const { count } = await db.from('competitor_prices')
        .select('*', { count: 'exact', head: true })
        .eq('seller_id', s.seller_name)
        .neq('competitor_id', '');
      s.matchCount = count || 0;
    }
    res.json({ success: true, sellers });
  } catch (e) {
    res.json({ success: true, sellers: [] });
  }
});

// POST /api/battle/target-sellers — 타겟 셀러 추가/수정
router.post('/battle/target-sellers', async (req, res) => {
  try {
    const { sellerName, tier } = req.body;
    if (!sellerName) return res.status(400).json({ success: false, error: 'sellerName required' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const validTier = ['F', 'D', 'C', 'B', 'A'].includes(tier) ? tier : 'C';
    const undercuts = { F: 3.00, D: 2.00, C: 1.00, B: 0.50, A: 0 };
    const { data: existing } = await db.from('target_sellers').select('id').eq('seller_name', sellerName.trim()).limit(1);
    if (existing && existing.length > 0) {
      await db.from('target_sellers').update({ tier: validTier, undercut: undercuts[validTier] }).eq('id', existing[0].id);
    } else {
      await db.from('target_sellers').insert({ seller_name: sellerName.trim(), tier: validTier, undercut: undercuts[validTier] });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/battle/target-sellers/:sellerName — 타겟 셀러 삭제
router.delete('/battle/target-sellers/:sellerName', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    await db.from('target_sellers').delete().eq('seller_name', req.params.sellerName);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/repricer/run — 자동 리프라이싱 실행
router.post('/repricer/run', async (req, res) => {
  try {
    const { runAutoRepricer } = require('../../services/autoRepricer');
    const dryRun = req.body.dryRun !== false; // default true (dry run)
    const report = await runAutoRepricer(dryRun);
    battleCache = null;
    battleCacheTime = 0;
    res.json({ success: true, ...report });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/repricer/report — 최근 리프라이싱 로그
router.get('/repricer/report', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data } = await db.from('repricer_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    res.json({ success: true, logs: data || [] });
  } catch (e) {
    res.json({ success: true, logs: [] });
  }
});

// POST /api/battle/monitor — 수동으로 경쟁사 모니터링 실행
router.post('/battle/monitor', async (req, res) => {
  try {
    const { runCompetitorMonitor } = require('../../services/competitorMonitor');
    const result = await runCompetitorMonitor();
    battleCache = null;
    battleCacheTime = 0;
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/battle/alerts — 최근 알림 조회
router.get('/battle/alerts', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data } = await db.from('competitor_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json({ success: true, alerts: data || [] });
  } catch (e) {
    // Table might not exist
    res.json({ success: true, alerts: [] });
  }
});

// POST /api/battle/delete-competitor — 경쟁사 삭제
router.post('/battle/delete-competitor', async (req, res) => {
  try {
    const { sku, competitorId } = req.body;
    if (!sku) return res.status(400).json({ success: false, error: 'sku required' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    let q = db.from('competitor_prices').delete().eq('sku', sku);
    if (competitorId) q = q.eq('competitor_id', competitorId);
    else q = q.eq('competitor_id', '');

    const { error } = await q;
    if (error) throw new Error(error.message);

    battleCache = null;
    battleCacheTime = 0;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/battle/refresh-sellers — 기존 경쟁사에 seller 정보 백필
router.post('/battle/refresh-sellers', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const ebay = getEbayAPI();

    // seller_id가 비어있는 경쟁사 조회
    const { data: rows } = await db.from('competitor_prices')
      .select('id, competitor_id')
      .or('seller_id.is.null,seller_id.eq.')
      .limit(500);

    if (!rows || rows.length === 0) {
      return res.json({ success: true, updated: 0, message: '모든 경쟁사에 seller 정보가 있습니다' });
    }

    // GetMultipleItems로 배치 조회 (20개씩) + Browse API fallback
    const itemIds = rows.map(r => r.competitor_id).filter(Boolean);
    let items = [];
    try {
      items = await ebay.getCompetitorItems(itemIds);
    } catch (e) {
      console.warn('[refresh-sellers] Shopping API batch failed:', e.message);
    }

    // Shopping API에서 못 가져온 아이템은 Browse API로 개별 조회
    const fetchedIds = new Set(items.map(i => i.itemId));
    const missingIds = itemIds.filter(id => !fetchedIds.has(id));
    if (missingIds.length > 0) {
      console.log(`[refresh-sellers] ${missingIds.length} items missing, trying Browse API...`);
      for (const mid of missingIds.slice(0, 50)) {
        try {
          const browseItem = await ebay._fetchViaBrowseAPI(mid);
          if (browseItem) items.push(browseItem);
        } catch (e) { /* skip */ }
      }
    }

    // seller 정보 매핑
    const sellerMap = {};
    items.forEach(item => {
      sellerMap[item.itemId] = { seller: item.seller, feedback: item.sellerFeedbackScore, price: item.price, shipping: item.shippingCost };
    });

    // DB 업데이트
    let updated = 0;
    for (const row of rows) {
      const info = sellerMap[row.competitor_id];
      if (info && info.seller) {
        await db.from('competitor_prices').update({
          seller_id: info.seller,
          seller_feedback: info.feedback || 0,
          competitor_price: info.price,
          competitor_shipping: info.shipping,
          tracked_at: new Date().toISOString(),
        }).eq('id', row.id);
        updated++;
      }
    }

    // 캐시 초기화
    battleCache = null;
    battleCacheTime = 0;

    res.json({ success: true, total: rows.length, updated, sellers: [...new Set(items.map(i => i.seller).filter(Boolean))] });
  } catch (e) {
    console.error('[refresh-sellers]', e.message);
    res.status(500).json({ success: false, error: e.message });
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

// POST /api/battle/scan-seller — 경쟁 셀러 전체 리스팅 스캔 + 내 상품과 매칭
router.post('/battle/scan-seller', async (req, res) => {
  try {
    const { sellerName } = req.body;
    if (!sellerName) return res.status(400).json({ success: false, error: 'sellerName required' });

    const ebay = getEbayAPI();
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    console.log(`[scan-seller] Scanning seller: ${sellerName}`);

    // 1. Get seller's listings
    const sellerItems = await ebay.findSellerListings(sellerName, 5);
    console.log(`[scan-seller] Found ${sellerItems.length} listings for ${sellerName}`);

    // 2. Get my active listings
    const myListings = await ebay.getActiveListings(1, 200);
    const myItems = myListings.items || [];
    // Build title keyword index (lowercase, split by space, >3 chars)
    const myByKeywords = {};
    for (const my of myItems) {
      const words = (my.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
      for (const w of words) {
        if (!myByKeywords[w]) myByKeywords[w] = [];
        myByKeywords[w].push(my);
      }
    }

    // Get more pages
    for (let p = 2; p <= 25; p++) {
      const page = await ebay.getActiveListings(p, 200);
      if (!page.items || page.items.length === 0) break;
      for (const my of page.items) {
        const words = (my.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
        for (const w of words) {
          if (!myByKeywords[w]) myByKeywords[w] = [];
          myByKeywords[w].push(my);
        }
      }
    }

    // 3. Match seller items with my items by keyword overlap
    // Exclude common/generic words that cause false matches
    const stopWords = new Set(['korean', 'korea', 'card', 'game', 'board', 'figure', 'edition', 'limited', 'sealed', 'booster', 'pack', 'official', 'with', 'from', 'this', 'that', 'toys', 'doll', 'plush', 'mini', 'cute', 'baby', 'kids', 'animation']);
    let matched = 0;
    const matchedPairs = [];
    for (const si of sellerItems) {
      const siWords = (si.title || '').toLowerCase().split(/\s+/).filter(w => w.length > 4 && !stopWords.has(w));
      const candidateScores = {};

      for (const w of siWords) {
        const matches = myByKeywords[w] || [];
        for (const my of matches) {
          const key = my.sku || my.itemId;
          candidateScores[key] = (candidateScores[key] || { my, score: 0, words: [] });
          candidateScores[key].score++;
          if (!candidateScores[key].words.includes(w)) candidateScores[key].words.push(w);
        }
      }

      // Best match: highest keyword overlap (min 5 unique words)
      const best = Object.values(candidateScores).sort((a, b) => b.score - a.score)[0];
      if (best && best.words.length >= 5) {
        const mySku = best.my.sku || best.my.itemId;
        matchedPairs.push({ mySku, sellerItem: si });

        // Upsert to competitor_prices
        const { data: existing } = await db.from('competitor_prices')
          .select('id')
          .eq('sku', mySku)
          .eq('competitor_id', si.itemId)
          .limit(1);

        if (existing && existing.length > 0) {
          await db.from('competitor_prices').update({
            competitor_price: si.price,
            competitor_shipping: si.shipping,
            seller_id: sellerName,
            tracked_at: new Date().toISOString(),
          }).eq('id', existing[0].id);
        } else {
          await db.from('competitor_prices').insert({
            sku: mySku,
            platform: 'ebay',
            competitor_id: si.itemId,
            competitor_price: si.price,
            competitor_shipping: si.shipping,
            competitor_url: `https://www.ebay.com/itm/${si.itemId}`,
            seller_id: sellerName,
          });
        }
        matched++;
      }
    }

    // Clear cache
    battleCache = null;
    battleCacheTime = 0;

    console.log(`[scan-seller] ${sellerName}: ${sellerItems.length} listings, ${matched} matched`);
    res.json({
      success: true,
      sellerName,
      totalListings: sellerItems.length,
      matched,
      pairs: matchedPairs.slice(0, 20).map(p => ({
        mySku: p.mySku,
        competitorItemId: p.sellerItem.itemId,
        competitorTitle: p.sellerItem.title.slice(0, 60),
        competitorPrice: p.sellerItem.price,
      })),
    });
  } catch (e) {
    console.error('[scan-seller]', e.message);
    res.status(500).json({ success: false, error: e.message });
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

    // Extract image URLs from HTML content
    let htmlImageUrls = [];
    if (htmlContent) {
      const imgMatches = htmlContent.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
      htmlImageUrls = imgMatches.map(m => {
        const srcMatch = m.match(/src=["']([^"']+)["']/i);
        return srcMatch ? srcMatch[1] : null;
      }).filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
      // Deduplicate and limit to 3
      htmlImageUrls = [...new Set(htmlImageUrls)].slice(0, 3);
    }

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
      imageCount: uploadedFiles.length + htmlImageUrls.length,
      images,
      lang,
      mode,
    });

    // 3. 원본 이미지 경로 목록 (업로드 파일 + HTML 추출 + CDN URLs)
    const cdnImageUrls = (req.body.cdnImageUrls || '').split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    const originalImages = [
      ...uploadedFiles.map(f => `/uploads/${path.basename(f.path)}`),
      ...htmlImageUrls,
      ...cdnImageUrls,
    ];

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

// POST /api/images/extract — Extract images from product page URL via Playwright
router.post('/images/extract', async (req, res) => {
  try {
    const { pageUrl } = req.body;
    if (!pageUrl) return res.status(400).json({ success: false, error: 'URL이 필요합니다' });

    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Scroll down to trigger lazy-loaded detail images
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await page.waitForTimeout(1000);

    // Extract all image URLs
    const images = await page.evaluate(() => {
      const imgs = new Set();
      document.querySelectorAll('img').forEach(el => {
        const src = el.src || el.dataset.src || el.getAttribute('data-img-src') || '';
        if (src && src.match(/^https?:\/\//) && !src.includes('logo') && !src.includes('icon') && !src.includes('1x1')) {
          // Clean up quality params for better resolution
          const clean = src.replace(/\/q\/\d+/, '/q/90').replace(/\/c\/\d+x\d+/, '');
          imgs.add(clean);
        }
      });
      return [...imgs];
    });

    await browser.close();

    // Separate thumbnails vs detail images
    const thumbnails = images.filter(u => u.includes('thumbnail') || u.includes('remote/'));
    const detailImgs = images.filter(u => !u.includes('thumbnail') && !u.includes('remote/') && (u.includes('.jpg') || u.includes('.png') || u.includes('.webp')));

    res.json({
      success: true,
      thumbnails: thumbnails.slice(0, 5),
      detailImages: detailImgs.slice(0, 15),
      allImages: images,
      total: images.length,
    });
  } catch (error) {
    console.error('Image extract error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/images/upload-cdn — Upload image URLs to Shopify CDN
router.post('/images/upload-cdn', async (req, res) => {
  try {
    const { imageUrls } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ success: false, error: '이미지 URL이 필요합니다' });
    }
    const ShopifyAPI = require('../../api/shopifyAPI');
    const shopify = new ShopifyAPI();
    const cdnUrls = await shopify.uploadImagesToCDN(imageUrls.slice(0, 10));
    res.json({ success: true, cdnUrls });
  } catch (error) {
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
      targetPlatforms, purchasePrice, weight, targetMargin,
      itemSpecifics
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

    // 2. eBay direct listing (bypass ProductExporter/pricingEngine)
    const platforms = targetPlatforms || [];
    if (platforms.includes('ebay')) {
      try {
        const ebayApi = getEbayAPI();
        const ebayResult = await ebayApi.createProduct({
          title: titleEn,
          description: description || titleEn,
          price: parseFloat(priceUSD) || 0,
          quantity: parseInt(quantity) || 10,
          sku,
          categoryId: ebayCategoryId || '11450',
          conditionId: condition === 'used' ? '3000' : '1000',
          imageUrls: imageUrls || [],
          currency: 'USD',
          itemSpecifics: itemSpecifics || {},
        });
        results.ebay = ebayResult;

        // Update ebay_item_id in DB
        if (ebayResult.success && ebayResult.itemId && productRow?.id) {
          const { getClient } = require('../../db/supabaseClient');
          await getClient().from('products').update({
            ebay_item_id: ebayResult.itemId,
            workflow_status: 'listed',
          }).eq('id', productRow.id);
        }

        // Track competitor if provided
        if (req.body.competitorItemId && ebayResult.success) {
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
    const status = req.query.status || null;
    const result = await dataSource.getRecentOrders(limit, status);
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
    const { rowIndex: orderNo, carrier, sheetTab } = req.body;
    console.log(`\n🔵 set-carrier 요청: orderNo=${orderNo}, carrier=${carrier}, tab=${sheetTab || '자동'}`);

    if (!orderNo || !carrier) {
      return res.status(400).json({ success: false, error: 'rowIndex(orderNo)와 carrier가 필요합니다' });
    }
    const OrderSync = require('../../services/orderSync');
    const CarrierSheets = require('../../services/carrierSheets');
    const sync = new OrderSync();

    // 주문번호로 실제 시트 행 번호 조회
    const sheetRow = await sync.findOrderRow(orderNo);
    if (!sheetRow) {
      return res.status(404).json({ success: false, error: `주문번호 "${orderNo}" 시트에서 찾을 수 없음` });
    }

    // 1. 주문 배송 시트에 배송사 기록
    console.log(`   [1/3] 주문 시트에 배송사 '${carrier}' 기록 (행 ${sheetRow})...`);
    await sync.setCarrier(sheetRow, carrier);
    console.log(`   [1/3] ✅ 완료`);

    // 2. 캐리어 시트에 자동 추가 (윤익스프레스 등 지원 배송사만)
    let carrierResult = null;
    const supported = CarrierSheets.getSupportedCarriers();
    if (supported.includes(carrier)) {
      console.log(`   [2/3] 주문 데이터 읽기 (행 ${sheetRow})...`);
      const order = await sync.getOrderRow(sheetRow);
      if (order) {
        console.log(`   [2/3] ✅ 주문 데이터 로드 완료`);
        // 무게/치수 조회: orders 테이블 우선, products 테이블 fallback
        try {
          const { getClient } = require('../../db/supabaseClient');
          const db = getClient();
          // 1) orders 테이블에서 직접 저장된 무게 확인
          const { data: orderWeight } = await db
            .from('orders').select('weight_kg, box_length, box_width, box_height')
            .eq('order_no', orderNo).single();
          if (orderWeight && parseFloat(orderWeight.weight_kg) > 0) {
            order.weightKg = parseFloat(orderWeight.weight_kg);
            order.dimL = parseFloat(orderWeight.box_length) || 0;
            order.dimW = parseFloat(orderWeight.box_width) || 0;
            order.dimH = parseFloat(orderWeight.box_height) || 0;
          } else if (order.sku) {
            // 2) products 테이블 fallback
            const { data: prod } = await db
              .from('products').select('weight_kg, box_length, box_width, box_height')
              .eq('sku', order.sku).single();
            if (prod && parseFloat(prod.weight_kg) > 0) {
              order.weightKg = parseFloat(prod.weight_kg);
              order.dimL = parseFloat(prod.box_length) || 0;
              order.dimW = parseFloat(prod.box_width) || 0;
              order.dimH = parseFloat(prod.box_height) || 0;
            }
          }
        } catch {}
        console.log(`   [3/3] 캐리어 시트 '${carrier}'에 등록...`);
        const cs = new CarrierSheets();
        const opts = sheetTab ? { sheetTab } : {};
        carrierResult = await cs.addToCarrierSheet(carrier, order, opts);
        console.log(`   [3/3] ✅ 캐리어 시트 등록 완료:`, carrierResult);
      } else {
        console.warn(`   [2/3] ⚠️ 주문 데이터 없음 (행 ${sheetRow})`);
      }
    } else {
      console.log(`   ℹ️ '${carrier}'은 시트 미지원 배송사 (지원: ${supported.join(', ')})`);
    }

    // Supabase: order_no 기준으로 carrier + status 업데이트
    try {
      const { getClient } = require('../../db/supabaseClient');
      await getClient().from('orders').update({ carrier, status: 'READY' }).eq('order_no', orderNo);
      console.log(`✅ Supabase 상태 업데이트: order_no=${orderNo} → READY`);
    } catch (dbErr) {
      console.warn('Supabase 상태 업데이트 실패 (무시):', dbErr.message);
    }

    res.json({ success: true, rowIndex: orderNo, carrier, carrierResult });
  } catch (error) {
    console.error(`❌ set-carrier 에러:`, error.message);
    console.error(error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/orders/cancel-carrier — 배송사 지정 취소
router.post('/orders/cancel-carrier', async (req, res) => {
  try {
    const { rowIndex: orderNo } = req.body;
    if (!orderNo) {
      return res.status(400).json({ success: false, error: 'rowIndex(orderNo)가 필요합니다' });
    }

    const OrderSync = require('../../services/orderSync');
    const { getClient } = require('../../db/supabaseClient');
    const sync = new OrderSync();

    // 주문번호로 실제 시트 행 번호 조회
    const sheetRow = await sync.findOrderRow(orderNo);
    if (!sheetRow) {
      return res.status(404).json({ success: false, error: `주문번호 "${orderNo}" 시트에서 찾을 수 없음` });
    }

    // K~M열 초기화: 배송사='', 운송장번호='', 상태='NEW'
    await sync.sheets.writeData(
      process.env.GOOGLE_SPREADSHEET_ID,
      `주문 배송!K${sheetRow}:M${sheetRow}`,
      [['', '', 'NEW']]
    );

    // Supabase 상태 복원
    try {
      await getClient().from('orders').update({ carrier: null, status: 'NEW' }).eq('order_no', orderNo);
    } catch (dbErr) {
      console.warn('Supabase 상태 복원 실패 (무시):', dbErr.message);
    }

    console.log(`🔴 배송사 취소: orderNo=${orderNo} (행 ${sheetRow})`);
    res.json({ success: true, rowIndex: orderNo });
  } catch (error) {
    console.error('❌ cancel-carrier 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/orders/shipping-estimate/:orderNo — 배송사 요금 추천
router.get('/orders/shipping-estimate/:orderNo', async (req, res) => {
  try {
    const { orderNo } = req.params;
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    const { data: order, error: orderErr } = await db
      .from('orders')
      .select('country_code, sku, quantity')
      .eq('order_no', orderNo)
      .single();
    if (orderErr || !order) {
      return res.status(404).json({ success: false, error: `주문 "${orderNo}" 없음` });
    }

    // 1) 주문 자체에 저장된 무게 확인
    const { data: orderFull } = await db
      .from('orders')
      .select('weight_kg, box_length, box_width, box_height')
      .eq('order_no', orderNo)
      .single();

    // 2) SKU가 있으면 products 테이블도 확인 (fallback)
    let product = null;
    if (order.sku) {
      const { data: p } = await db
        .from('products')
        .select('weight_kg, box_length, box_width, box_height')
        .eq('sku', order.sku)
        .single();
      product = p;
    }

    // 주문에 직접 저장된 무게 우선, 없으면 제품 무게 사용
    const srcWeight = parseFloat(orderFull?.weight_kg) || parseFloat(product?.weight_kg) || 0;
    const srcDimL = parseFloat(orderFull?.box_length) || parseFloat(product?.box_length) || 0;
    const srcDimW = parseFloat(orderFull?.box_width) || parseFloat(product?.box_width) || 0;
    const srcDimH = parseFloat(orderFull?.box_height) || parseFloat(product?.box_height) || 0;

    const weightKg = srcWeight * (order.quantity || 1);
    const dims = (srcDimL && srcDimW && srcDimH)
      ? { l: srcDimL, w: srcDimW, h: srcDimH }
      : null;

    const { getShippingEstimates } = require('../../services/shippingRates');
    const estimates = getShippingEstimates((order.country_code || '').toUpperCase(), weightKg, dims);

    res.json({ success: true, orderNo, sku: order.sku, countryCode: (order.country_code || '').toUpperCase(), weightKg, dims, estimates });
  } catch (e) {
    console.error('❌ shipping-estimate 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/orders/save-weight — 주문 기반 무게/치수 저장 (SKU 없어도 동작)
router.patch('/orders/save-weight', async (req, res) => {
  try {
    const { orderNo, sku, weight_kg, box_length, box_width, box_height } = req.body;
    if (!orderNo) return res.status(400).json({ success: false, error: 'orderNo 필요' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const wt = parseFloat(weight_kg) || 0;
    const bl = parseFloat(box_length) || 0;
    const bw = parseFloat(box_width) || 0;
    const bh = parseFloat(box_height) || 0;

    // SKU가 있으면 products 테이블에도 저장 (다음 주문에 자동 적용)
    if (sku) {
      const { data: existing } = await db.from('products').select('sku').eq('sku', sku).single();
      if (existing) {
        await db.from('products').update({ weight_kg: wt, box_length: bl, box_width: bw, box_height: bh }).eq('sku', sku);
      }
    }

    // orders 테이블에 임시 무게 저장 (메타 데이터로)
    await db.from('orders').update({ weight_kg: wt, box_length: bl, box_width: bw, box_height: bh }).eq('order_no', orderNo);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/products/update-weight — 제품 무게/치수 업데이트 (배송 추천용)
router.patch('/products/update-weight', async (req, res) => {
  try {
    const { sku, weight_kg, box_length, box_width, box_height } = req.body;
    if (!sku) return res.status(400).json({ success: false, error: 'sku 필요' });
    const { getClient } = require('../../db/supabaseClient');
    const updates = {};
    if (weight_kg !== undefined) updates.weight_kg = parseFloat(weight_kg) || 0;
    if (box_length !== undefined) updates.box_length = parseFloat(box_length) || 0;
    if (box_width !== undefined) updates.box_width = parseFloat(box_width) || 0;
    if (box_height !== undefined) updates.box_height = parseFloat(box_height) || 0;
    const { error } = await getClient().from('products').update(updates).eq('sku', sku);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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

// ─── B2B 라우트 가드: 로그인 필수. 쓰기도 직원 허용 (인보이스 생성·발송·입금은 직원 업무)
// 치명적 작업(void/delete)은 해당 엔드포인트에서 개별 requireAdmin 체크.
router.use('/b2b', (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
  next();
});

// ─── 구매자 ───

// GET /api/b2b/buyers — 구매자 목록
router.get('/b2b/buyers', async (req, res) => {
  try {
    const buyers = await getB2BService().getBuyers();
    // FedEx structured 주소는 Supabase b2b_buyers 에 별도 저장 — 머지해서 응답.
    try {
      const { getClient } = require('../../db/supabaseClient');
      const db = getClient();
      const { data: rows } = await db.from('b2b_buyers').select('buyer_id, address_street, address_city, address_state, address_zip, contact_name, contact_phone');
      const map = {};
      (rows || []).forEach(r => { map[r.buyer_id] = r; });
      buyers.forEach(b => {
        const r = map[b.BuyerID];
        if (!r) return;
        b.AddressStreet = r.address_street || '';
        b.AddressCity = r.address_city || '';
        b.AddressState = r.address_state || '';
        b.AddressZip = r.address_zip || '';
        b.ContactName = r.contact_name || '';
        b.ContactPhone = r.contact_phone || '';
      });
    } catch (e) {
      console.warn('[buyers] Supabase 머지 실패:', e.message);
    }
    res.json({ success: true, buyers });
  } catch (error) {
    console.error('❌ B2B buyers 조회 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/b2b/buyers/:id — 구매자 삭제 (?force=1 이면 연결된 인보이스 있어도 진행)
router.delete('/b2b/buyers/:id', async (req, res) => {
  try {
    const force = String(req.query.force || '') === '1';
    const result = await getB2BService().deleteBuyer(req.params.id, { force });
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.code === 'HAS_INVOICES' ? 409 : 500;
    res.status(status).json({ success: false, error: error.message, code: error.code, invoiceCount: error.invoiceCount });
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
    // FedEx structured 주소는 Sheets 스키마에 없어서 별도로 Supabase b2b_buyers 에 직접 upsert.
    // (Sheets 는 기존 컬럼만 유지, Supabase 는 라벨 자동화용 추가 필드 보관.)
    try {
      const bid = result?.BuyerID || buyerId;
      if (bid && (data.addressStreet || data.addressCity || data.addressState || data.addressZip
                  || data.contactName || data.contactPhone)) {
        const { getClient } = require('../../db/supabaseClient');
        const db = getClient();
        const patch = {
          buyer_id: bid,
          address_street: data.addressStreet || null,
          address_city: data.addressCity || null,
          address_state: data.addressState || null,
          address_zip: data.addressZip || null,
          contact_name: data.contactName || null,
          contact_phone: data.contactPhone || null,
          // 핵심 필드도 함께 동기화 (조회는 Supabase 에서 하므로)
          name: data.name || result?.Name || null,
          address: data.address || result?.Address || null,
          country: data.country || result?.Country || null,
        };
        // null 제거 — 빈 컬럼 덮어쓰지 않음
        Object.keys(patch).forEach(k => { if (patch[k] === null && k !== 'buyer_id') delete patch[k]; });
        await db.from('b2b_buyers').upsert(patch, { onConflict: 'buyer_id' });
      }
    } catch (e) {
      console.warn('[buyers] Supabase structured 주소 upsert 실패:', e.message);
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

// GET /api/b2b/invoices — 인보이스 목록 + payment_status 주입 (Phase C)
// statusGroup=active(default) | completed | all — active 는 FULFILLED 만 숨김 (배송완료=완료보관소)
router.get('/b2b/invoices', async (req, res) => {
  try {
    const { buyerId, status, fromDate, toDate } = req.query;
    const statusGroup = req.query.statusGroup || 'all';
    const invoices = await getB2BService().getInvoices({ buyerId, status, fromDate, toDate, statusGroup });

    // Supabase에서 payment 정보 조회해 주입 (마이그레이션 027 적용 시)
    try {
      const B2BRepo = require('../../db/b2bRepository');
      const repo = new B2BRepo();
      const payMap = await repo.getInvoicePaymentInfo((invoices || []).map(i => i.InvoiceNo));
      const today = new Date().toISOString().slice(0, 10);
      for (const inv of invoices || []) {
        const info = payMap[inv.InvoiceNo];
        if (info) {
          inv.PaidAmount = info.paidAmount;
          inv.PaymentStatus = info.paymentStatus;
          inv.IsOverdue = info.paymentStatus !== 'PAID' && info.dueDate && info.dueDate < today;
        } else {
          inv.PaidAmount = inv.Status === 'PAID' ? (inv.Total || 0) : 0;
          inv.PaymentStatus = inv.Status === 'PAID' ? 'PAID' : 'UNPAID';
          inv.IsOverdue = inv.Status !== 'PAID' && inv.DueDate && inv.DueDate < today;
        }
      }
    } catch { /* 마이그레이션 미적용 — payment 정보 스킵 */ }

    res.json({ success: true, invoices });
  } catch (error) {
    console.error('❌ B2B invoices 조회 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/b2b/invoices/:id/void — 인보이스 무효화 (admin)
router.post('/b2b/invoices/:id/void', async (req, res) => {
  try {
    const invoiceNo = req.params.id;
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ success: false, error: '무효화 사유를 입력하세요' });

    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();

    // Supabase에 없으면 Sheets에서 가져와 upsert (old invoice 대응)
    const sheetInvoices = await getB2BService().getInvoices({ includeVoided: true });
    const inv = (sheetInvoices || []).find(i => i.InvoiceNo === invoiceNo);
    if (!inv) return res.status(404).json({ success: false, error: '인보이스를 찾을 수 없습니다' });
    try {
      await repo.createInvoice(inv);  // upsert by invoice_no
    } catch { /* 이미 있으면 무시 */ }

    const voided = await repo.voidInvoice(invoiceNo, { userId: req.user?.id, reason });
    res.json({ success: true, invoice: voided });
  } catch (e) {
    console.error('❌ B2B invoice void 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 발송 추적 (Phase B) ───

async function _ensureInvoiceInSupabase(invoiceNo, repo) {
  // Sheets에 있지만 Supabase에 없을 수 있음 — 한 번 upsert
  try {
    const sheetInvoices = await getB2BService().getInvoices({ includeVoided: true });
    const inv = (sheetInvoices || []).find(i => i.InvoiceNo === invoiceNo);
    if (!inv) return null;
    try { await repo.createInvoice(inv); } catch {}
    return inv;
  } catch { return null; }
}

/** 인보이스별 items에 shippedQty 계산해 주입 */
// SKU 가 없는 품목 (수기 라인·할인·수수료 등) 도 발송 추적되도록 합성 키 생성.
// 같은 인보이스 내에서 동일 (sku||name) 항목은 같은 키 → shipped 누적.
function _itemKey(it) {
  const sku = (it.sku || it.SKU || '').trim();
  if (sku) return sku;
  const name = (it.name || it.Name || '').trim();
  return name ? '@' + name.slice(0, 80) : '@__unnamed__';
}

function _injectShippedQty(invoices, shipments) {
  const byInvoice = new Map();
  for (const s of shipments) {
    if (!byInvoice.has(s.invoiceNo)) byInvoice.set(s.invoiceNo, new Map());
    const skuMap = byInvoice.get(s.invoiceNo);
    for (const it of s.items || []) {
      // shipment items 의 sku 도 동일 합성 키 적용 (이전엔 raw it.sku)
      skuMap.set(_itemKey(it), (skuMap.get(_itemKey(it)) || 0) + Number(it.qty || 0));
    }
  }
  return invoices.map(inv => {
    const skuMap = byInvoice.get(inv.InvoiceNo) || new Map();
    const items = (inv.ItemsParsed || (typeof inv.Items === 'string' ? (() => { try { return JSON.parse(inv.Items); } catch { return []; } })() : inv.Items) || []);
    const enriched = items.map(it => {
      const key = _itemKey(it);
      const shipped = skuMap.get(key) || 0;
      // 프론트에서 sku 필드를 그대로 사용하므로 합성 키를 sku 로 채움 (없을 때만)
      return { ...it, sku: it.sku || it.SKU || key, shippedQty: shipped, remainingQty: Math.max(0, (Number(it.qty || 0)) - shipped) };
    });
    const totalOrdered = enriched.reduce((s, it) => s + (Number(it.qty || 0)), 0);
    const totalShipped = enriched.reduce((s, it) => s + (Number(it.shippedQty || 0)), 0);
    return { ...inv, ItemsEnriched: enriched, OrderedTotalQty: totalOrdered, ShippedTotalQty: totalShipped };
  });
}

// POST /api/b2b/invoices/:id/shipments — 발송 기록 추가
router.post('/b2b/invoices/:id/shipments', async (req, res) => {
  try {
    const invoiceNo = req.params.id;
    const { carrier, trackingNumber, items, notes, shippedAt } = req.body || {};
    if (!trackingNumber || !String(trackingNumber).trim()) {
      return res.status(400).json({ success: false, error: '송장번호를 입력하세요' });
    }
    // SKU 빈 항목도 합성 키로 처리 (할인·수수료·수기 라인 등) — _itemKey 와 동일 로직.
    const cleanItems = (Array.isArray(items) ? items : [])
      .map(i => ({
        sku: String(i.sku || '').trim() || _itemKey(i),
        name: String(i.name || '').trim() || undefined,
        qty: Math.max(0, Number(i.qty) || 0),
      }))
      .filter(i => i.sku && i.qty > 0);
    if (cleanItems.length === 0) {
      return res.status(400).json({ success: false, error: '발송할 수량을 입력하세요 (모든 품목이 0)' });
    }

    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();

    const inv = await _ensureInvoiceInSupabase(invoiceNo, repo);
    if (!inv) return res.status(404).json({ success: false, error: '인보이스를 찾을 수 없습니다' });

    // 검증: 각 항목의 요청 qty ≤ (주문 qty − 기존 shipped qty). 합성 키 사용.
    const existingShipments = await repo.listShipmentsByInvoice(invoiceNo);
    const shippedMap = new Map();
    for (const s of existingShipments) {
      for (const it of s.items || []) shippedMap.set(_itemKey(it), (shippedMap.get(_itemKey(it)) || 0) + Number(it.qty || 0));
    }
    const orderedItems = (() => {
      try { return typeof inv.Items === 'string' ? JSON.parse(inv.Items || '[]') : (inv.Items || inv.ItemsParsed || []); }
      catch { return inv.ItemsParsed || []; }
    })();
    // 비물리 라인 (수수료·할인) 제외 — 자동 인보이스가 추가하는 fee/discount 가 발송 추적을 막아
    // FULFILLED 자동 전이가 안 되는 버그 fix. 휴리스틱: 음수가격 (할인) 또는 sku 비어있는 qty=1 (수수료).
    const _isPhysicalLine = (it) => {
      const price = Number(it.price || 0);
      const qty = Number(it.qty || 0);
      if (price <= 0) return false;                            // 할인 라인
      if (!String(it.sku || '').trim() && qty === 1) return false; // 수수료 라인 (자동 인보이스 패턴)
      return true;
    };
    const physicalOrdered = orderedItems.filter(_isPhysicalLine);
    const orderedMap = new Map(physicalOrdered.map(it => [_itemKey(it), Number(it.qty || 0)]));

    for (const it of cleanItems) {
      const ordered = orderedMap.get(it.sku) || 0;
      const already = shippedMap.get(it.sku) || 0;
      const remaining = ordered - already;
      if (it.qty > remaining) {
        return res.status(400).json({ success: false, error: `${it.name || it.sku}: 남은 수량 ${remaining}개 초과 (요청 ${it.qty}개)` });
      }
    }

    const created = await repo.createShipment({
      invoiceNo,
      shippedAt,
      carrier: (carrier || 'FedEx').slice(0, 40),
      trackingNumber: String(trackingNumber).trim().slice(0, 100),
      items: cleanItems,
      notes: notes ? String(notes).trim().slice(0, 500) : null,
      userId: req.user?.id,
    });

    // 인보이스 status 자동 전이 — 모두 발송됐으면 FULFILLED, 일부면 PARTIALLY_SHIPPED
    const allShipments = [...existingShipments, created];
    const newShippedMap = new Map();
    for (const s of allShipments) {
      for (const it of s.items || []) newShippedMap.set(_itemKey(it), (newShippedMap.get(_itemKey(it)) || 0) + Number(it.qty || 0));
    }
    let allDone = true;
    for (const [key, ordered] of orderedMap) {
      if (ordered <= 0) continue; // qty=0 항목 (혹시 있다면) 스킵
      if ((newShippedMap.get(key) || 0) < ordered) { allDone = false; break; }
    }
    const nextStatus = allDone ? 'FULFILLED' : 'PARTIALLY_SHIPPED';
    try { await getB2BService().updateInvoiceStatus(invoiceNo, nextStatus); } catch (err) { console.warn('[shipment] status 전이 실패:', err.message); }
    console.log(`[shipment] ${invoiceNo} → ${nextStatus} (배송 ${cleanItems.length}건, allDone=${allDone})`);

    res.json({ success: true, shipment: created, invoiceStatus: nextStatus });
  } catch (e) {
    console.error('❌ B2B shipment 생성 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/invoices/:id/shipments — 인보이스별 발송 이력 + items(shippedQty 포함)
router.get('/b2b/invoices/:id/shipments', async (req, res) => {
  try {
    const invoiceNo = req.params.id;
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const shipments = await repo.listShipmentsByInvoice(invoiceNo);
    // 인보이스 기본 정보 + items shippedQty
    const sheetInvoices = await getB2BService().getInvoices({ includeVoided: true });
    const inv = (sheetInvoices || []).find(i => i.InvoiceNo === invoiceNo);
    if (!inv) return res.status(404).json({ success: false, error: '인보이스를 찾을 수 없습니다' });
    const [enriched] = _injectShippedQty([inv], shipments);
    res.json({ success: true, invoice: enriched, shipments });
  } catch (e) {
    console.error('❌ B2B shipments 조회 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/b2b/shipments/:shipmentId — carrier·tracking·notes·date 수정
router.patch('/b2b/shipments/:shipmentId', async (req, res) => {
  try {
    const id = parseInt(req.params.shipmentId, 10);
    const { carrier, trackingNumber, shippedAt, notes } = req.body || {};
    if (trackingNumber !== undefined && !String(trackingNumber).trim()) {
      return res.status(400).json({ success: false, error: '송장번호는 비울 수 없습니다' });
    }
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const updated = await repo.updateShipment(id, { carrier, trackingNumber, shippedAt, notes });
    res.json({ success: true, shipment: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/b2b/shipments/:shipmentId — 실수 정정용
router.delete('/b2b/shipments/:shipmentId', async (req, res) => {
  try {
    const id = parseInt(req.params.shipmentId, 10);
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    await repo.deleteShipment(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── FedEx 자동화 (Phase D — 035 마이그레이션 필요) ───

// 거래처 주소 → FedEx destination 객체. structured 필드 우선, 없으면 fallback.
function _buyerToFedexDestination(buyer) {
  if (!buyer) return null;
  return {
    street: buyer.address_street || buyer.address || '',
    city: buyer.address_city || '',
    state: buyer.address_state || '',
    zip: buyer.address_zip || '',
    country: buyer.country || '',
  };
}

function _validateFedexDestination(dest) {
  if (!dest) return '거래처 주소를 찾을 수 없습니다';
  if (!dest.country) return '거래처 국가가 비어있습니다 (구매자 관리에서 국가 입력 필요)';
  if (!dest.street) return '거래처 주소(street) 가 비어있습니다 (구매자 관리에서 입력 필요)';
  return null;
}

// POST /api/b2b/shipments/estimate-rate — FedEx 견적 (라벨 생성 전 미리보기)
// body: { buyerId, weightKg, dimensions: {length, width, height}, packageCount, customsValue, currency }
router.post('/b2b/shipments/estimate-rate', async (req, res) => {
  try {
    const { getFedexAPI } = require('../../api/fedexAPI');
    const fedex = getFedexAPI();
    if (!fedex.isConfigured()) {
      return res.status(503).json({ success: false, error: 'FedEx 자격증명이 설정되지 않았습니다 (config/.env)' });
    }
    const { buyerId, weightKg, dimensions, packageCount = 1, customsValue, currency = 'USD' } = req.body || {};
    if (!buyerId) return res.status(400).json({ success: false, error: 'buyerId 가 필요합니다' });
    if (!weightKg || Number(weightKg) <= 0) return res.status(400).json({ success: false, error: '무게(kg) 가 필요합니다' });

    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const buyer = await repo.getBuyerById(buyerId);
    if (!buyer) return res.status(404).json({ success: false, error: '거래처를 찾을 수 없습니다' });

    const dest = _buyerToFedexDestination(buyer);
    const valErr = _validateFedexDestination(dest);
    if (valErr) return res.status(400).json({ success: false, error: valErr });

    const N = Math.max(1, parseInt(packageCount, 10) || 1);
    const packages = Array.from({ length: N }, () => ({
      weightKg: Number(weightKg),
      dimensions: dimensions ? {
        length: Number(dimensions.length) || 1,
        width: Number(dimensions.width) || 1,
        height: Number(dimensions.height) || 1,
      } : null,
    }));

    const services = await fedex.getRates({ destination: dest, packages, customsValue, currency });
    res.json({ success: true, services });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/shipments/:shipmentId/create-label — FedEx 라벨 생성 + tracking 갱신
// body: { weightKg, dimensions, packageCount, serviceType, customsValue, currency }
router.post('/b2b/shipments/:shipmentId/create-label', async (req, res) => {
  try {
    const shipmentId = parseInt(req.params.shipmentId);
    if (!shipmentId) return res.status(400).json({ success: false, error: 'invalid shipmentId' });

    const { getFedexAPI } = require('../../api/fedexAPI');
    const fedex = getFedexAPI();
    if (!fedex.isConfigured()) {
      return res.status(503).json({ success: false, error: 'FedEx 자격증명이 설정되지 않았습니다 (config/.env)' });
    }

    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    const { data: ship, error: sErr } = await db.from('b2b_shipments')
      .select('*').eq('id', shipmentId).maybeSingle();
    if (sErr || !ship) return res.status(404).json({ success: false, error: '발송 레코드를 찾을 수 없습니다' });
    if (ship.label_storage_path) return res.status(409).json({ success: false, error: '이미 라벨이 발급된 발송입니다' });

    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    // invoice → buyer 조회
    const invoices = await getB2BService().getInvoices({ includeVoided: false });
    const inv = (invoices || []).find(i => i.InvoiceNo === ship.invoice_no);
    if (!inv) return res.status(404).json({ success: false, error: '인보이스를 찾을 수 없습니다' });
    const buyer = await repo.getBuyerById(inv.BuyerID);
    if (!buyer) return res.status(404).json({ success: false, error: '거래처를 찾을 수 없습니다' });

    const dest = _buyerToFedexDestination(buyer);
    const valErr = _validateFedexDestination(dest);
    if (valErr) return res.status(400).json({ success: false, error: valErr });

    const { weightKg, dimensions, packageCount = 1, serviceType, customsValue, currency = 'USD' } = req.body || {};
    if (!weightKg || Number(weightKg) <= 0) return res.status(400).json({ success: false, error: '무게(kg) 가 필요합니다' });
    if (!serviceType) return res.status(400).json({ success: false, error: 'serviceType 이 필요합니다 (먼저 견적 받기)' });

    const N = Math.max(1, parseInt(packageCount, 10) || 1);
    const packages = Array.from({ length: N }, () => ({
      weightKg: Number(weightKg),
      dimensions: dimensions ? {
        length: Number(dimensions.length) || 1,
        width: Number(dimensions.width) || 1,
        height: Number(dimensions.height) || 1,
      } : null,
    }));

    const recipientContact = {
      name: buyer.contact_name || buyer.Name || buyer.name || 'Recipient',
      phone: buyer.contact_phone || buyer.phone || '0000000000',
      company: buyer.Name || buyer.name || '',
    };

    // customs value: 명시 입력 없으면 인보이스 합계 사용
    const totalCustomsValue = Number(customsValue) || Number(inv.Total) || 1;

    const result = await fedex.createShipment({
      destination: dest,
      packages,
      serviceType,
      customs: {
        totalValue: totalCustomsValue,
        currency: currency || inv.Currency || 'USD',
        countryOfManufacture: 'KR',
      },
      recipientContact,
    });

    if (!result.trackingNumber) {
      return res.status(502).json({ success: false, error: 'FedEx 응답에 운송장 번호가 없습니다' });
    }

    // 라벨 PDF 저장 — base64 면 Supabase Storage 업로드, URL 이면 그대로 fetch + 저장
    let storagePath = null;
    try {
      const bucket = 'b2b-shipping-labels';
      const fname = `${ship.invoice_no}/${result.trackingNumber}.pdf`;
      let pdfBuffer = null;
      if (result.labelBase64) {
        pdfBuffer = Buffer.from(result.labelBase64, 'base64');
      } else if (result.labelUrl) {
        const axios = require('axios');
        const dl = await axios.get(result.labelUrl, { responseType: 'arraybuffer', timeout: 30000 });
        pdfBuffer = Buffer.from(dl.data);
      }
      if (pdfBuffer) {
        const { error: upErr } = await db.storage.from(bucket).upload(fname, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
        });
        if (!upErr) storagePath = fname;
        else console.error('[create-label] Storage 업로드 실패:', upErr.message);
      }
    } catch (e) {
      console.error('[create-label] 라벨 다운로드/업로드 실패:', e.message);
    }

    // shipments 업데이트
    const updates = {
      tracking_number: result.trackingNumber,
      carrier: 'FedEx',
      service_type: serviceType,
      shipping_cost: result.cost || null,
      currency: result.currency || currency || 'USD',
      weight_kg: Number(weightKg),
      dimensions_cm: dimensions ? `${dimensions.length}x${dimensions.width}x${dimensions.height}` : null,
      package_count: N,
      label_storage_path: storagePath,
      fedex_shipment_id: result.shipmentId || null,
    };
    const { error: uErr } = await db.from('b2b_shipments').update(updates).eq('id', shipmentId);
    if (uErr) console.error('[create-label] DB 업데이트 실패:', uErr.message);

    res.json({
      success: true,
      trackingNumber: result.trackingNumber,
      shippingCost: result.cost,
      currency: result.currency,
      labelStored: !!storagePath,
    });
  } catch (e) {
    console.error('[create-label]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/shipments/:shipmentId/label — 라벨 PDF signed URL (15분)
router.get('/b2b/shipments/:shipmentId/label', async (req, res) => {
  try {
    const shipmentId = parseInt(req.params.shipmentId);
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { data: ship } = await db.from('b2b_shipments')
      .select('label_storage_path').eq('id', shipmentId).maybeSingle();
    if (!ship?.label_storage_path) return res.status(404).json({ success: false, error: '라벨이 없습니다' });
    const { data, error } = await db.storage.from('b2b-shipping-labels').createSignedUrl(ship.label_storage_path, 900);
    if (error) throw error;
    res.json({ success: true, url: data.signedUrl, expiresIn: 900 });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/shipments/by-date?date=YYYY-MM-DD — 특정 날짜 발송 목록
router.get('/b2b/shipments/by-date', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const shipments = await repo.listShipmentsByDate(date);
    // 각 shipment에 buyer name 주입
    const sheetInvoices = await getB2BService().getInvoices({ includeVoided: true });
    const invMap = new Map((sheetInvoices || []).map(i => [i.InvoiceNo, i]));
    const enriched = shipments.map(s => ({
      ...s,
      buyerName: invMap.get(s.invoiceNo)?.BuyerName || '-',
      buyerId: invMap.get(s.invoiceNo)?.BuyerID || null,
    }));
    res.json({ success: true, date, shipments: enriched });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 결제 추적 (Phase C) ───

// POST /api/b2b/invoices/:id/payments — 입금 기록 (부분 입금 허용)
router.post('/b2b/invoices/:id/payments', async (req, res) => {
  try {
    const invoiceNo = req.params.id;
    const { amount, paidAt, method, note } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: '입금 금액을 올바르게 입력하세요' });
    }

    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();

    // 인보이스가 Supabase에 없으면 먼저 upsert
    await _ensureInvoiceInSupabase(invoiceNo, repo);

    const result = await repo.recordPayment({
      invoiceNo, paidAt, amount: amt,
      method: method ? String(method).slice(0, 40) : null,
      note: note ? String(note).trim().slice(0, 500) : null,
      userId: req.user?.id,
    });

    // 완납이면 Sheets status도 PAID로 동기화
    if (result.paymentStatus === 'PAID') {
      try { await getB2BService().updateInvoiceStatus(invoiceNo, 'PAID'); } catch {}
    }

    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ B2B payment 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/invoices/:id/payments — 입금 이력
router.get('/b2b/invoices/:id/payments', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const payments = await repo.listPayments(req.params.id);
    res.json({ success: true, payments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/shipments/pending-skus — 미발송 수량을 SKU별로 집계 (구매 필요 수량)
router.get('/b2b/shipments/pending-skus', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const [sheetInvoices, allShipments] = await Promise.all([
      getB2BService().getInvoices({}),  // voided 제외
      repo.listAllShipments(),
    ]);
    // PAID·FULFILLED 제외 — 아직 작업중인 인보이스만
    const active = (sheetInvoices || []).filter(i => !['PAID', 'FULFILLED', 'CANCELLED'].includes(i.Status));
    const enriched = _injectShippedQty(active, allShipments);

    // SKU별 집계
    const skuMap = new Map();
    for (const inv of enriched) {
      for (const it of inv.ItemsEnriched || []) {
        const pending = it.remainingQty || 0;
        if (pending <= 0) continue;
        const sku = it.sku || it.SKU || '';
        if (!sku) continue;
        if (!skuMap.has(sku)) {
          skuMap.set(sku, { sku, name: it.name || '', pendingQty: 0, orderedQty: 0, shippedQty: 0, invoices: [] });
        }
        const row = skuMap.get(sku);
        row.name = row.name || it.name || '';
        row.pendingQty += pending;
        row.orderedQty += Number(it.qty || 0);
        row.shippedQty += Number(it.shippedQty || 0);
        row.invoices.push({ invoiceNo: inv.InvoiceNo, buyerName: inv.BuyerName, pending });
      }
    }
    const rows = [...skuMap.values()].sort((a, b) => b.pendingQty - a.pendingQty);
    const totalSkus = rows.length;
    const totalPending = rows.reduce((s, r) => s + r.pendingQty, 0);
    res.json({ success: true, totalSkus, totalPending, skus: rows });
  } catch (e) {
    console.error('❌ pending-skus 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
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

// ── 수기 인보이스 (업로드 + AI 파싱 + 저장) ──────────────────
const manualUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// POST /api/b2b/invoices/manual/parse — PDF/이미지 → Claude → JSON
router.post('/b2b/invoices/manual/parse', manualUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '파일을 선택하세요' });
    const { parseManualInvoice } = require('../../services/b2bInvoiceParser');
    const parsed = await parseManualInvoice(req.file.buffer, req.file.mimetype);
    res.json({ success: true, parsed, fileMeta: {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    }});
  } catch (e) {
    console.error('❌ manual invoice parse:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/invoices/manual — 편집된 필드 + 원본 파일 저장
router.post('/b2b/invoices/manual', manualUpload.single('file'), async (req, res) => {
  try {
    const body = req.body?.payload ? JSON.parse(req.body.payload) : req.body;
    const data = { ...body };
    if (req.file) {
      data.originalFile = {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      };
    }
    const result = await getB2BService().saveManualInvoice(data);
    res.json({ success: true, invoice: result });
  } catch (e) {
    console.error('❌ manual invoice save:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/invoices/:id/attach — 기존 인보이스에 외부 파일(PDF/이미지/XLSX) 첨부/교체
router.post('/b2b/invoices/:id/attach', manualUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '파일을 선택하세요' });
    const result = await getB2BService().attachFileToInvoice(req.params.id, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
    });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ invoice attach:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/invoices/:id/manual-download — 원본 파일 signed URL 리다이렉트
router.get('/b2b/invoices/:id/manual-download', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const invoices = await repo.getInvoices({ includeVoided: true });
    const inv = invoices.find(i => i.InvoiceNo === req.params.id);
    if (!inv || !inv.OriginalFilePath) return res.status(404).json({ error: '원본 파일 없음' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const filename = inv.OriginalFilePath.split('/').pop() || 'manual-invoice';
    const { data, error } = await db.storage.from('b2b-manual').createSignedUrl(inv.OriginalFilePath, 300, {
      download: filename,
    });
    if (error || !data?.signedUrl) throw error || new Error('signed URL 생성 실패');
    res.redirect(data.signedUrl);
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// PATCH /api/b2b/invoices/:id — 인보이스 메타 편집 (날짜·만기·통화·상태)
router.patch('/b2b/invoices/:id', async (req, res) => {
  try {
    const { invoiceDate, dueDate, currency, status } = req.body || {};
    const result = await getB2BService().updateInvoice(req.params.id, { invoiceDate, dueDate, currency, status });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ B2B invoice 수정 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/b2b/invoices/:id — 인보이스 영구 삭제 (Sheet 행 비우기 + DB 삭제)
router.delete('/b2b/invoices/:id', async (req, res) => {
  try {
    const result = await getB2BService().deleteInvoice(req.params.id);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ B2B invoice 삭제 에러:', e.message);
    res.status(500).json({ success: false, error: e.message });
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

// ─── B2B 거래처 맵핑 (Phase 1 Day 3-C) ───

// PATCH /api/b2b/buyers/:buyerId/external-ids — 플랫폼별 식별자 저장
//   body: { externalIds: { ebay: ["buyer@x.com"], alibaba: ["abc_trade"] } }
router.patch('/b2b/buyers/:buyerId/external-ids', async (req, res) => {
  try {
    const { buyerId } = req.params;
    const ids = req.body?.externalIds || {};
    if (typeof ids !== 'object' || Array.isArray(ids)) {
      return res.status(400).json({ error: 'externalIds는 객체여야 합니다' });
    }
    // 정규화: 모든 값은 배열, 요소는 문자열
    const cleaned = {};
    for (const [k, v] of Object.entries(ids)) {
      const arr = Array.isArray(v) ? v : [v];
      const filtered = arr.map(x => String(x || '').trim()).filter(Boolean);
      if (filtered.length > 0) cleaned[String(k).toLowerCase()] = filtered;
    }
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    await repo.updateBuyer(buyerId, { ExternalIds: cleaned });
    res.json({ success: true, externalIds: cleaned });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/buyers/:buyerId/orders — 실제 플랫폼 주문 (b2b_buyer_id 매칭된 것)
router.get('/b2b/buyers/:buyerId/orders', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const data = await repo.getBuyerOrders(req.params.buyerId, {
      from: req.query.from,
      to: req.query.to,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
    });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/buyers/:buyerId/revenue — 실제 주문 기반 매출 (external_ids 매칭)
router.get('/b2b/buyers/:buyerId/revenue', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const data = await repo.getBuyerRevenue(req.params.buyerId, { from: req.query.from, to: req.query.to });
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/b2b/unmapped-orders — 미매칭 주문 (admin 수동 배정용)
router.get('/b2b/unmapped-orders', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    const data = await repo.getUnmappedOrders({
      from: req.query.from,
      to: req.query.to,
      platform: req.query.platform,
      limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
    });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/orders/:orderNo/assign — 주문을 특정 거래처에 수동 배정
//   body: { buyerId: 'B003' }  — null 보내면 매칭 해제
router.post('/b2b/orders/:orderNo/assign', async (req, res) => {
  try {
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    await repo.assignOrderToBuyer(req.params.orderNo, req.body?.buyerId || null);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/invoices/auto — 자동 인보이스 생성 (catalog / orders 모드)
router.post('/b2b/invoices/auto', async (req, res) => {
  try {
    const result = await getB2BService().generateInvoiceAuto(req.body || {});
    const { xlsxBuffer, ...meta } = result; // xlsx는 응답 제외 (다운로드는 별도)
    res.json({ success: true, invoice: meta });
  } catch (error) {
    console.error('❌ B2B auto invoice 에러:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/b2b/buyers/:buyerId/shipping-rule — 거래처 배송비 규칙 저장
//   body: { perBoxes: 30, rate: 120, currency: 'USD' } (모두 선택)
router.patch('/b2b/buyers/:buyerId/shipping-rule', async (req, res) => {
  try {
    const { buyerId } = req.params;
    const { perBoxes, rate, currency } = req.body || {};
    const rule = {};
    if (perBoxes != null) rule.perBoxes = Math.max(1, parseInt(perBoxes, 10) || 30);
    if (rate != null) rule.rate = Number(rate) || 0;
    if (currency) rule.currency = String(currency).toUpperCase().slice(0, 4);
    const B2BRepo = require('../../db/b2bRepository');
    const repo = new B2BRepo();
    await repo.updateBuyer(buyerId, { ShippingRule: rule });
    res.json({ success: true, shippingRule: rule });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/b2b/match/run — 전체 미매칭 주문에 대해 external_ids 기준 backfill 실행
router.post('/b2b/match/run', async (req, res) => {
  try {
    const matcher = require('../../services/b2bBuyerMatcher');
    const onlyUnmapped = req.body?.rescanAll !== true;
    const r = await matcher.backfillOrders({ onlyUnmapped, limit: 50000 });
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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

// GET /api/translate/:productId — get existing translation
router.get('/translate/:productId', async (req, res) => {
  try {
    const TranslationService = require('../../services/translationService');
    const svc = new TranslationService();
    const lang = req.query.lang || 'en';
    const translation = await svc.getTranslation(req.params.productId, lang);
    res.json({ translation });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/translate/:productId — save manual translation edits
router.put('/translate/:productId', async (req, res) => {
  try {
    const dataSource = require('../../services/dataSource');
    const platformRepo = dataSource.getPlatformRepo();
    const { targetLang, title, description, keywords } = req.body;
    const result = await platformRepo.db
      .from('translations')
      .upsert({
        product_id: req.params.productId,
        target_lang: targetLang || 'en',
        title: title || '',
        description: description || '',
        keywords: keywords || [],
        translated_by: 'manual',
        is_reviewed: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'product_id,target_lang' });
    if (result.error) throw result.error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/products/export-status — list export status for all products
router.get('/products/export-status', async (req, res) => {
  try {
    const dataSource = require('../../services/dataSource');
    const platformRepo = dataSource.getPlatformRepo();
    const filter = req.query.filter || 'all';

    let query = platformRepo.db
      .from('platform_export_status')
      .select('*, products(sku, title), platforms(key, name, display_name)')
      .order('updated_at', { ascending: false })
      .limit(100);

    if (filter !== 'all') {
      query = query.eq('export_status', filter);
    }

    const { data, error } = await query;
    if (error) throw error;

    const items = (data || []).map(row => ({
      sku: row.products?.sku || '-',
      title: row.products?.title || '-',
      platform: row.platforms?.display_name || row.platforms?.name || '-',
      status: row.export_status,
      price: row.exported_price,
      exported_at: row.exported_at,
      error: row.last_error
    }));

    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: error.message, items: [] });
  }
});

// GET /api/alibaba/oauth-callback — Alibaba OAuth 인증 콜백
router.get('/alibaba/oauth-callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing auth code');

  try {
    const axios = require('axios');
    const crypto = require('crypto');

    const appKey = process.env.ALIBABA_APP_KEY;
    const appSecret = process.env.ALIBABA_APP_SECRET;
    const apiPath = '/auth/token/create';
    const timestamp = Date.now().toString();
    const params = { app_key: appKey, timestamp, sign_method: 'sha256', code, state: 'pmc' };

    const sorted = Object.keys(params).sort();
    let baseString = apiPath;
    for (const key of sorted) baseString += key + params[key];
    params.sign = crypto.createHmac('sha256', appSecret).update(baseString).digest('hex').toUpperCase();

    const r = await axios.post('https://openapi-api.alibaba.com/rest' + apiPath, null, { params, timeout: 15000 });
    const data = r.data;

    if (data.code && data.code !== '0') {
      return res.status(400).send(`Alibaba OAuth error: ${data.code} - ${data.message}`);
    }

    const { access_token, refresh_token, expire_time } = data;
    if (!access_token) {
      return res.status(400).send('No access_token in response: ' + JSON.stringify(data));
    }

    // Save to DB
    const { saveToken } = require('../../services/tokenStore');
    await saveToken('alibaba', {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: expire_time ? new Date(expire_time * 1000) : null,
    });
    process.env.ALIBABA_ACCESS_TOKEN = access_token;
    process.env.ALIBABA_REFRESH_TOKEN = refresh_token;

    console.log('✅ Alibaba OAuth 완료. access_token DB에 저장됨. expire_time:', expire_time);
    res.send(`
      <h2>✅ Alibaba 인증 완료!</h2>
      <p>access_token이 DB에 저장되었습니다.</p>
      <p>만료 시간: ${expire_time ? new Date(expire_time * 1000).toLocaleString('ko-KR') : '알 수 없음'}</p>
      <p><a href="/">대시보드로 돌아가기</a></p>
    `);
  } catch (e) {
    console.error('Alibaba OAuth callback error:', e.response?.data || e.message);
    res.status(500).send('OAuth 오류: ' + (e.response?.data?.message || e.message));
  }
});

// GET /api/alibaba/oauth-url — Alibaba OAuth 인증 URL 반환
router.get('/alibaba/oauth-url', (req, res) => {
  const appKey = process.env.ALIBABA_APP_KEY;
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const redirectUri = encodeURIComponent(`${protocol}://${host}/api/alibaba/oauth-callback`);
  const url = `https://auth.alibaba.com/oauth/authorize?response_type=code&client_id=${appKey}&redirect_uri=${redirectUri}&view=web&sp=ICBU`;
  res.json({ url });
});

// ─────────────────────────────────────────────────────────
// Shopee OAuth (shop 단위 재인증 — refresh_token 만료 시 사용)
// ─────────────────────────────────────────────────────────

// GET /api/shopee/oauth-url — Shopee 인증 URL (shop 단위)
// 브라우저에서 이 URL 클릭 → Shopee 로그인 → 권한 동의 → /oauth-callback 으로 자동 이동
router.get('/shopee/oauth-url', (req, res) => {
  const crypto = require('crypto');
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  if (!partnerId || !partnerKey) return res.status(400).json({ error: 'SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY 미설정' });

  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const redirect = `${protocol}://${host}/api/shopee/oauth-callback`;
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac('sha256', partnerKey)
    .update(`${partnerId}${path}${timestamp}`)
    .digest('hex');
  const baseUrl = process.env.SHOPEE_ENV === 'test'
    ? 'https://partner.test-stable.shopeemobile.com'
    : 'https://partner.shopeemobile.com';
  const url = `${baseUrl}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirect)}`;
  res.json({ url, note: 'CB 셀러는 각 shop 마다 별도로 인증 필요. 첫 shop 인증 후 다른 shop 들도 순차 인증하세요.' });
});

// GET /api/shopee/oauth-callback — Shopee 에서 code 받아 access/refresh token 발급
router.get('/shopee/oauth-callback', async (req, res) => {
  const crypto = require('crypto');
  const axios = require('axios');
  try {
    const code = String(req.query.code || '').trim();
    const shopIdRaw = req.query.shop_id || req.query.shopid;
    const mainAccountId = req.query.main_account_id;
    if (!code) return res.status(400).send('Shopee OAuth: code 없음');
    if (!shopIdRaw && !mainAccountId) return res.status(400).send('Shopee OAuth: shop_id 또는 main_account_id 없음');

    const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;
    const baseUrl = process.env.SHOPEE_ENV === 'test'
      ? 'https://partner.test-stable.shopeemobile.com'
      : 'https://partner.shopeemobile.com';
    const path = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', partnerKey).update(`${partnerId}${path}${timestamp}`).digest('hex');

    const body = { code, partner_id: partnerId };
    const isShop = !!shopIdRaw;
    if (isShop) body.shop_id = parseInt(shopIdRaw);
    else body.main_account_id = parseInt(mainAccountId);

    const r = await axios.post(`${baseUrl}${path}`, body, {
      params: { partner_id: partnerId, timestamp, sign },
      timeout: 15000,
    });

    if (r.data?.error || !r.data?.access_token) {
      return res.status(400).send(`Shopee OAuth 실패: ${r.data?.error || 'no access_token'} / ${r.data?.message || ''}`);
    }

    const { saveToken } = require('../../services/tokenStore');
    const platformKey = isShop ? `shopee_shop_${parseInt(shopIdRaw)}` : 'shopee';
    await saveToken(platformKey, {
      accessToken: r.data.access_token,
      refreshToken: r.data.refresh_token,
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      metadata: null, // dead 플래그 자동 clear
    });

    // In-memory env 도 업데이트 (서버 재시작 없이 즉시 반영)
    if (isShop) {
      const sid = parseInt(shopIdRaw);
      process.env[`SHOPEE_SHOP_${sid}_ACCESS_TOKEN`] = r.data.access_token;
      process.env[`SHOPEE_SHOP_${sid}_REFRESH_TOKEN`] = r.data.refresh_token;
    } else {
      process.env.SHOPEE_ACCESS_TOKEN = r.data.access_token;
      process.env.SHOPEE_REFRESH_TOKEN = r.data.refresh_token;
    }

    // Shopee API 싱글톤 재로드 강제 (다음 호출 시 새 토큰 읽게)
    _shopeeInstance = null;

    const targetLabel = isShop ? `Shop ${shopIdRaw}` : `Merchant ${mainAccountId}`;
    res.send(`
      <h2>✅ Shopee ${targetLabel} 인증 완료!</h2>
      <p>새 access_token 이 DB 에 저장되었습니다. dead 플래그가 제거됐고 다음 호출부터 정상 작동합니다.</p>
      <p>다른 shop 도 인증하려면 <a href="/api/shopee/oauth-url">/api/shopee/oauth-url</a> 다시 호출 후 반환 URL 열기.</p>
      <p><a href="/">대시보드로 돌아가기</a></p>
    `);
  } catch (e) {
    console.error('[shopee/oauth-callback]', e.response?.data || e.message);
    res.status(500).send('Shopee OAuth 오류: ' + (e.response?.data?.message || e.message));
  }
});

// GET /api/shopee/token-status — 각 토큰의 dead 상태 확인 (재인증 대상 파악용)
router.get('/shopee/token-status', async (req, res) => {
  try {
    const { loadToken } = require('../../services/tokenStore');
    const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    const shopIds = (process.env.SHOPEE_SHOP_IDS || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const keys = ['shopee', ...shopIds.map(s => `shopee_shop_${s}`)];
    const rows = await Promise.all(keys.map(async k => {
      const t = await loadToken(k);
      const deadUntil = t?.metadata?.deadUntil || null;
      const dead = deadUntil && new Date(deadUntil).getTime() > Date.now();
      return {
        key: k,
        hasAccessToken: !!t?.accessToken,
        hasRefreshToken: !!t?.refreshToken,
        expiresAt: t?.expiresAt || null,
        dead: !!dead,
        deadUntil: dead ? deadUntil : null,
        reason: t?.metadata?.reason || null,
      };
    }));
    res.json({ partnerId, shopIds, tokens: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sync/products — 멀티 플랫폼 상품 동기화
router.post('/sync/products', async (req, res) => {
  try {
    const { syncPlatformProducts } = require('../../services/productSync');
    const platforms = req.body.platforms || ['ebay', 'shopify'];
    console.log('[ProductSync] Starting sync for:', platforms.join(', '));
    const results = await syncPlatformProducts(platforms);
    res.json({ success: true, results });
  } catch (e) {
    console.error('[ProductSync] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/sync/master — ebay_products + shopify_products → products 마스터 동기화
// 플랫폼별로 판매가가 다른데 이걸 일괄 마스터에 병합하면 가격이 덮어써질 수 있어 위험.
// admin 전용으로 제한.
router.post('/sync/master', requireAdmin, async (req, res) => {
  try {
    const { syncToMaster } = require('../../services/productSync');
    console.log(`[MasterSync] 시작 by ${req.user?.displayName || 'unknown'}`);
    const results = await syncToMaster();
    console.log('[MasterSync] Done:', JSON.stringify(results));
    res.json({ success: true, results });
  } catch (e) {
    console.error('[MasterSync] error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/inventory/barcode-match — 바코드 ↔ SKU 매칭 등록
router.post('/inventory/barcode-match', async (req, res) => {
  try {
    const { sku, barcode } = req.body;
    if (!sku || !barcode) return res.status(400).json({ success: false, error: 'sku and barcode required' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    // Update ebay_products barcode
    await db.from('ebay_products').update({ barcode: barcode.trim() }).eq('sku', sku);
    // Also update products table
    await db.from('products').update({ barcode: barcode.trim() }).eq('sku', sku);

    res.json({ success: true, sku, barcode: barcode.trim() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/inventory/scan — 바코드 스캔 입출고
router.post('/inventory/scan', async (req, res) => {
  try {
    const { sku, quantity, type } = req.body;
    if (!sku || !quantity || !type) return res.status(400).json({ success: false, error: 'sku, quantity, type required' });
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();

    // Find product by barcode → SKU → eBay item ID
    const scanCode = sku.trim();
    let product = null;
    let matchedSku = scanCode;

    // 1. Try barcode in ebay_products
    const { data: byBarcode } = await db.from('ebay_products').select('item_id, sku, stock, barcode').eq('barcode', scanCode).limit(1);
    if (byBarcode && byBarcode.length > 0) {
      matchedSku = byBarcode[0].sku || byBarcode[0].item_id;
      const { data: p } = await db.from('products').select('id, stock, sku').eq('sku', matchedSku).limit(1).single();
      product = p;
    }

    // 2. Try SKU in products
    if (!product) {
      const { data: p } = await db.from('products').select('id, stock, sku').eq('sku', scanCode).limit(1).single();
      product = p;
    }

    // 3. Try eBay item_id
    if (!product) {
      const { data: byItemId } = await db.from('ebay_products').select('item_id, sku').eq('item_id', scanCode).limit(1);
      if (byItemId && byItemId.length > 0) {
        matchedSku = byItemId[0].sku || byItemId[0].item_id;
        const { data: p } = await db.from('products').select('id, stock, sku').eq('sku', matchedSku).limit(1).single();
        product = p;
      }
    }

    // 4. Try barcode in products table
    if (!product) {
      const { data: p } = await db.from('products').select('id, stock, sku').eq('barcode', scanCode).limit(1).single();
      product = p;
      if (p) matchedSku = p.sku;
    }

    if (!product) return res.status(404).json({ success: false, error: `"${scanCode}" 매칭 상품 없음 (바코드/SKU/Item ID)` });

    const change = type === 'in' ? Math.abs(quantity) : -Math.abs(quantity);
    const newStock = Math.max(0, (product.stock || 0) + change);

    // Update products.stock
    await db.from('products').update({ stock: newStock, updated_at: new Date().toISOString() }).eq('id', product.id);

    // Log to inventory_log
    await db.from('inventory_log').insert({
      product_id: product.id,
      sku: matchedSku,
      change_qty: change,
      type,
      reason: type === 'in' ? 'scan' : 'scan-out',
    }).then(() => {}).catch(() => {});

    res.json({ success: true, sku: matchedSku, scanned: scanCode, previousStock: product.stock || 0, newStock, change });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== CS Message API =====
const { MessageRepository } = require('../../db/messageRepository');
const csMessageRepo = new MessageRepository();

// GET /api/cs/messages — pending messages with drafts
router.get('/cs/messages', async (req, res) => {
  try {
    const messages = await csMessageRepo.getPendingMessages({
      platform: req.query.platform,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json({ success: true, data: messages });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/cs/approve/:id — approve draft and send reply
router.post('/cs/approve/:id', async (req, res) => {
  try {
    const msg = await csMessageRepo.getById(req.params.id);
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found' });

    const replyText = req.body.reply || msg.approved_reply || msg.draft_reply;
    if (!replyText) return res.status(400).json({ success: false, error: 'No reply text' });

    let sendResult = { success: false, error: 'Unknown platform' };

    if (msg.platform === 'ebay' && msg.item_id) {
      const EbayAPI = require('../../api/ebayAPI');
      const ebay = new EbayAPI();
      sendResult = await ebay.replyToMessage(msg.item_id, msg.sender, replyText, msg.subject);
    } else if (msg.platform === 'alibaba') {
      const AlibabaAPI = require('../../api/alibabaAPI');
      const alibaba = new AlibabaAPI();
      sendResult = await alibaba.replyInquiry(msg.message_id, replyText);
    }

    const updated = await csMessageRepo.updateMessage(msg.id, {
      approved_reply: replyText,
      status: sendResult.success ? 'sent' : 'failed',
      replied_at: sendResult.success ? new Date().toISOString() : null,
    });

    res.json({ success: sendResult.success, data: updated, sendResult });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// POST /api/cs/edit/:id — edit draft before sending
router.post('/cs/edit/:id', async (req, res) => {
  try {
    const updated = await csMessageRepo.updateMessage(req.params.id, {
      draft_reply: req.body.draft_reply,
      status: 'draft_ready',
    });
    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ===== Bulk Purchase Price Update =====

// POST /api/master-products/bulk-cost — CSV 매입가 일괄 업데이트
router.post('/master-products/bulk-cost', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const { items } = req.body; // [{ sku, cost_price }, ...]
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items array required' });
    }

    let updated = 0, failed = 0, errors = [];
    for (const item of items) {
      if (!item.sku || item.cost_price == null) { failed++; continue; }
      const cost = parseFloat(item.cost_price);
      if (isNaN(cost) || cost < 0) { failed++; errors.push(`${item.sku}: invalid cost`); continue; }

      const { error } = await db.from('products')
        .update({ cost_price: cost, purchase_price: cost, updated_at: new Date().toISOString() })
        .eq('sku', item.sku);
      if (error) { failed++; errors.push(`${item.sku}: ${error.message}`); }
      else updated++;
    }

    res.json({ success: true, updated, failed, total: items.length, errors: errors.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PUT /api/master-products/:sku/cost — 단일 매입가 인라인 수정
router.put('/master-products/:sku/cost', async (req, res) => {
  try {
    const { getClient } = require('../../db/supabaseClient');
    const db = getClient();
    const cost = parseFloat(req.body.cost_price);
    if (isNaN(cost) || cost < 0) return res.status(400).json({ success: false, error: 'Invalid cost_price' });

    const { data, error } = await db.from('products')
      .update({ cost_price: cost, purchase_price: cost, updated_at: new Date().toISOString() })
      .eq('sku', req.params.sku).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// GET /api/thumbnail/badge/options — UI용 키워드/스타일 목록
router.get('/thumbnail/badge/options', (req, res) => {
  const badgeLib = require('../../services/badgeTemplates');
  res.json({
    keywords: badgeLib.listKeywords(),
    styles: badgeLib.listStyles(),
  });
});

// GET /api/thumbnail/badge/preview?keyword=신제품&style=redCircle[&custom=FREE]
// 뱃지 PNG data URL을 즉석 반환 (UI 프리뷰용)
router.get('/thumbnail/badge/preview', async (req, res) => {
  try {
    const sharp = require('sharp');
    const axios = require('axios');
    const badgeLib = require('../../services/badgeTemplates');

    const keyword = (req.query.keyword || '').trim();
    const custom = (req.query.custom || '').trim();
    const style = req.query.style || 'redCircle';
    // useGemini 명시적 false 가 아니면 Gemini 사용 (기본 활성). 키 없으면 자연스럽게 fallback.
    const useGemini = req.query.useGemini !== 'false';

    if (!keyword && !custom) return res.status(400).json({ error: '키워드 또는 자유 텍스트를 입력하세요' });

    const svg = badgeLib.getBadgeSvg({ keyword, customText: custom, style });
    if (svg) {
      const png = await sharp(Buffer.from(svg)).resize(384, 384, { fit: 'inside' }).png().toBuffer();
      return res.json({ source: 'svg', data: `data:image/png;base64,${png.toString('base64')}` });
    }

    // SVG 템플릿에 없는 키워드 → Gemini 시도 (자유 텍스트 케이스 자동 처리)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.status(400).json({ error: 'GEMINI_API_KEY 미설정 — 관리자에게 문의 (프리셋 키워드: ' + (badgeLib.listKeywords() || []).join(', ') + ')' });
    }
    if (!useGemini) {
      return res.status(400).json({ error: '프리셋에 없는 키워드. Gemini 생성을 체크하세요.' });
    }

    const cacheKey = `badge:${custom.toLowerCase()}:${style}`;
    const cached = badgeCache.get(cacheKey);
    let buf;
    if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
      buf = cached.buf;
    } else {
      const styleHints = {
        redCircle:    'bold red circular badge with white text, flat design, playful',
        yellowRibbon: 'yellow ribbon banner shape with dark text, retro sale vibe',
        blackTag:     'minimalist black rectangular price-tag style with white text, modern',
        starburst:    'pink starburst explosion shape with white text, attention-grabbing',
      };
      const prompt = `Design a square commerce badge icon that says "${custom}". Style: ${styleHints[style] || styleHints.redCircle}. Transparent PNG background, centered composition, high contrast, no photo, bold typography, no extra objects. Output: single 512x512 PNG with transparency.`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`;
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }, { timeout: 60000, validateStatus: () => true });
      if (r.status !== 200) {
        let msg = r.data?.error?.message || `Gemini error ${r.status}`;
        if (r.status === 429 && /free_tier/i.test(msg)) {
          msg = 'Gemini Billing 미연결 — Google Cloud 콘솔에서 결제 계정 연결 필요';
        }
        return res.status(502).json({ error: msg });
      }
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData?.data);
      if (!img) return res.status(502).json({ error: 'Gemini가 이미지를 반환하지 않음' });
      buf = Buffer.from(img.inlineData.data, 'base64');
      badgeCache.set(cacheKey, { buf, at: Date.now() });
      if (badgeCache.size > 100) {
        const oldest = [...badgeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) badgeCache.delete(oldest[0]);
      }
    }

    const preview = await sharp(buf).resize(384, 384, { fit: 'inside' }).png().toBuffer();
    res.json({ source: 'gemini', cached: !!cached, data: `data:image/png;base64,${preview.toString('base64')}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/thumbnail/generate — 썸네일 만들기 (로고 합성)
const thumbnailUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/thumbnail/generate', thumbnailUpload.array('images', 20), async (req, res) => {
  try {
    const sharp = require('sharp');
    const path = require('path');
    const fs = require('fs');
    const axios = require('axios');

    const platform = req.body.platform || 'ebay';
    const files = req.files;
    if (!files || files.length === 0) return res.status(400).json({ success: false, error: 'No images uploaded' });

    // Load logo (PNG with transparency)
    const logoPath = path.join(__dirname, '../../..', 'public/images/pmc_logo.png');
    if (!fs.existsSync(logoPath)) return res.status(400).json({ success: false, error: 'Logo file not found. Upload pmc_logo.png to public/images/' });

    // 각 플랫폼 썸네일 최적 사이즈(정사각) + 여백(%) + 로고 위치/크기
    //   canvas: 출력 캔버스 변 길이 (null이면 원본 유지)
    //   marginPct: 제품 이미지 주변 여백 (%) — 캔바처럼 일정한 여백 유지용
    //   size/padding: 로고 크기(%)와 로고 가장자리 패딩(px, 캔버스의 ~3%)
    const platformPresets = {
      alibaba: { canvas: 1000, marginPct: 8, position: 'top-left', size: 45, padding: 30 },
      ebay:    { canvas: 1600, marginPct: 8, position: 'top-left', size: 45, padding: 48 },
      shopify: { canvas: 2048, marginPct: 8, position: 'top-left', size: 40, padding: 60 },
      shopee:  { canvas: 1080, marginPct: 8, position: 'top-left', size: 45, padding: 32 },
      qoo10:   { canvas: 1200, marginPct: 8, position: 'top-left', size: 45, padding: 36 },
      custom:  { canvas: null, marginPct: 0,  position: 'top-left', size: 45, padding: 20 },
    };
    const preset = platformPresets[platform] || platformPresets.ebay;
    const position = req.body.position || preset.position;
    const size = Math.max(10, Math.min(80, parseInt(req.body.size) || preset.size));
    const padding = parseInt(req.body.padding) || preset.padding;
    const userMargin = parseInt(req.body.marginPct);
    const marginPct = Number.isFinite(userMargin) ? Math.max(0, Math.min(20, userMargin)) : preset.marginPct;
    const targetCanvas = preset.canvas || null;
    const removeBg = req.body.removeBg === 'true' || req.body.removeBg === true;
    const outputBg = req.body.outputBg || 'transparent'; // 'transparent' | 'white'
    // 'local' | 'gemini' | 'removebg' | 'auto'
    // auto: local 우선 → gemini → removebg
    const provider = req.body.provider || 'local';

    // 뱃지 파라미터 (선택)
    const badgeKeyword = (req.body.badgeKeyword || '').trim();   // 프리셋 키워드
    const badgeCustom = (req.body.badgeCustom || '').trim();     // 자유 텍스트
    const badgeStyle = req.body.badgeStyle || 'redCircle';
    const badgePosition = req.body.badgePosition || 'top-right';
    const badgeSize = Math.max(10, Math.min(40, parseInt(req.body.badgeSize) || 22));
    const badgeUseGemini = req.body.badgeUseGemini === 'true' || req.body.badgeUseGemini === true;
    const hasBadge = !!(badgeKeyword || badgeCustom);

    const geminiKey = process.env.GEMINI_API_KEY;
    const rembgKey = process.env.REMOVE_BG_API_KEY;

    // 로컬 누끼 (@imgly/background-removal-node — rembg U2Net 모델)
    // 첫 호출 시 모델 로드 (~50MB), 이후 빠름. Fly 머신에서 실행.
    async function callLocalBgRemove(buffer, mimeType) {
      const imgly = require('@imgly/background-removal-node');
      // Blob 생성 → removeBackground → Blob → Buffer
      const blob = new Blob([buffer], { type: mimeType || 'image/png' });
      const resultBlob = await imgly.removeBackground(blob, {
        output: { format: 'image/png', quality: 0.9 },
      });
      const arr = new Uint8Array(await resultBlob.arrayBuffer());
      return Buffer.from(arr);
    }

    // Gemini 2.5 Flash Image ("Nano Banana") — 이미지 편집 API
    async function callGeminiBgRemove(buffer, mimeType) {
      const base64 = buffer.toString('base64');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`;
      const r = await axios.post(url, {
        contents: [{
          parts: [
            { text: 'Remove the background from this image completely. Return the subject with a fully transparent background. Do not alter, recolor, or add anything to the subject itself — keep it pixel-perfect. Output format: PNG with transparency.' },
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
          ],
        }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }, {
        timeout: 90000,
        validateStatus: () => true,
      });
      if (r.status !== 200) {
        let msg = r.data?.error?.message || `Gemini error ${r.status}`;
        if (r.status === 429 && /free_tier_requests/i.test(msg)) {
          msg = 'Gemini 이미지 API는 Google Cloud 결제 계정 연결이 필요합니다 (무료 한도 0). Billing 연결 후 다시 시도하거나 remove.bg를 사용하세요.';
        }
        throw new Error(msg);
      }
      // 응답 parts에서 이미지 추출
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData?.data);
      if (!img) {
        const textPart = parts.find(p => p.text)?.text || '';
        throw new Error('Gemini가 이미지를 반환하지 않음' + (textPart ? ': ' + textPart.slice(0, 120) : ''));
      }
      return Buffer.from(img.inlineData.data, 'base64');
    }

    async function callRemoveBg(buffer, filename) {
      const FormData = require('form-data');
      const fd = new FormData();
      fd.append('image_file', buffer, { filename });
      fd.append('size', 'auto');
      const r = await axios.post('https://api.remove.bg/v1.0/removebg', fd, {
        headers: { ...fd.getHeaders(), 'X-Api-Key': rembgKey },
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true,
      });
      if (r.status !== 200) {
        let msg = `remove.bg error ${r.status}`;
        try { const j = JSON.parse(Buffer.from(r.data).toString('utf-8')); msg = j.errors?.[0]?.title || msg; } catch {}
        throw new Error(msg);
      }
      return Buffer.from(r.data);
    }

    // ---------- 뱃지 해석: SVG 라이브러리 우선 → (옵션) Gemini 폴백 ----------
    async function resolveBadgeBuffer({ keyword, customText, style, useGemini, targetSize }) {
      const badgeLib = require('../../services/badgeTemplates');
      const svg = badgeLib.getBadgeSvg({ keyword, customText, style });
      if (svg) {
        return sharp(Buffer.from(svg))
          .resize(targetSize, targetSize, { fit: 'inside' })
          .png()
          .toBuffer();
      }

      // SVG 라이브러리에 없는 자유 키워드 + Gemini 요청 → 생성·캐시
      if (useGemini && geminiKey && customText) {
        const cacheKey = `badge:${customText.trim().toLowerCase()}:${style}`;
        const cached = badgeCache.get(cacheKey);
        if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
          return sharp(cached.buf).resize(targetSize, targetSize, { fit: 'inside' }).png().toBuffer();
        }
        const generated = await callGeminiBadge(customText, style);
        badgeCache.set(cacheKey, { buf: generated, at: Date.now() });
        // 캐시 사이즈 제한 (메모리 폭증 방지)
        if (badgeCache.size > 100) {
          const oldest = [...badgeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) badgeCache.delete(oldest[0]);
        }
        return sharp(generated).resize(targetSize, targetSize, { fit: 'inside' }).png().toBuffer();
      }
      return null;
    }

    async function callGeminiBadge(text, style) {
      const styleHints = {
        redCircle:    'bold red circular badge with white text, flat design, playful',
        yellowRibbon: 'yellow ribbon banner shape with dark text, retro sale vibe',
        blackTag:     'minimalist black rectangular price-tag style with white text, modern',
        starburst:    'pink starburst explosion shape with white text, attention-grabbing',
      };
      const style_hint = styleHints[style] || styleHints.redCircle;
      const prompt = `Design a square commerce badge icon that says "${text}". Style: ${style_hint}. Transparent PNG background, centered composition, high contrast, no photo, bold typography, no extra objects. Output: single 512x512 PNG with transparency.`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`;
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }, { timeout: 60000, validateStatus: () => true });
      if (r.status !== 200) {
        let msg = r.data?.error?.message || `Gemini error ${r.status}`;
        if (r.status === 429 && /free_tier/i.test(msg)) {
          msg = 'Gemini 이미지 API Billing 미연결 — Google Cloud 콘솔에서 결제 계정 연결 필요';
        }
        throw new Error(msg);
      }
      const parts = r.data?.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData?.data);
      if (!img) throw new Error('Gemini가 뱃지 이미지를 반환하지 않음');
      return Buffer.from(img.inlineData.data, 'base64');
    }

    async function doBgRemove(file) {
      // auto 순서: Gemini 우선 (Fly.io 에서 안정적) → local → removebg.
      //   이전: local 우선 → @imgly ONNX 모델 메모리/native binding 이슈로 hang 잦음.
      const order = provider === 'auto'
        ? [...(geminiKey ? ['gemini'] : []), 'local', ...(rembgKey ? ['removebg'] : [])]
        : [provider];
      const errors = [];
      for (const p of order) {
        try {
          if (p === 'local') return { buffer: await callLocalBgRemove(file.buffer, file.mimetype), provider: 'local' };
          if (p === 'gemini') {
            if (!geminiKey) throw new Error('GEMINI_API_KEY 미설정');
            return { buffer: await callGeminiBgRemove(file.buffer, file.mimetype), provider: 'gemini' };
          }
          if (p === 'removebg') {
            if (!rembgKey) throw new Error('REMOVE_BG_API_KEY 미설정');
            return { buffer: await callRemoveBg(file.buffer, file.originalname), provider: 'removebg' };
          }
        } catch (e) {
          errors.push(`${p}: ${e.message}`);
          console.warn(`[thumbnail] ${p} 누끼 실패:`, e.message);
        }
      }
      throw new Error('모든 누끼 제공자 실패 — ' + errors.join(' | '));
    }

    const results = [];
    for (const file of files) {
      try {
        let workingBuffer = file.buffer;

        // 1) 누끼 따기 (Gemini nano banana 우선 / remove.bg 폴백)
        let usedProvider = null;
        if (removeBg) {
          try {
            const out = await doBgRemove(file);
            workingBuffer = out.buffer;
            usedProvider = out.provider;
          } catch (e) {
            results.push({ filename: file.originalname, error: '누끼 실패: ' + e.message });
            continue;
          }
        }

        // 2) 플랫폼 캔버스 정규화 — 정사각 + 일정 여백 (Canva 스타일)
        //    targetCanvas가 null(=custom)이면 원본 크기 유지
        let imgW, imgH;
        if (targetCanvas) {
          const marginPx = Math.round(targetCanvas * marginPct / 100);
          const innerSize = targetCanvas - 2 * marginPx;

          // 제품 이미지를 innerSize × innerSize 안쪽으로 contain 리사이즈
          const resizedProduct = await sharp(workingBuffer)
            .resize(innerSize, innerSize, { fit: 'inside' })
            .png()
            .toBuffer();
          const pMeta = await sharp(resizedProduct).metadata();
          const offsetX = Math.round((targetCanvas - pMeta.width) / 2);
          const offsetY = Math.round((targetCanvas - pMeta.height) / 2);

          // 출력 배경: 누끼+투명이면 투명, 그 외엔 흰색
          const wantTransparent = removeBg && outputBg === 'transparent';
          const canvasBg = wantTransparent
            ? { r: 255, g: 255, b: 255, alpha: 0 }
            : { r: 255, g: 255, b: 255, alpha: 1 };

          workingBuffer = await sharp({
            create: {
              width: targetCanvas,
              height: targetCanvas,
              channels: 4,
              background: canvasBg,
            },
          })
            .composite([{ input: resizedProduct, left: offsetX, top: offsetY }])
            .png()
            .toBuffer();

          imgW = targetCanvas;
          imgH = targetCanvas;
        } else {
          const meta = await sharp(workingBuffer).metadata();
          imgW = meta.width || 800;
          imgH = meta.height || 800;
        }

        // 3) 배경 처리: 누끼+흰배경 출력 시 투명 → 흰 플래튼
        let base = sharp(workingBuffer);
        if (!targetCanvas && removeBg && outputBg === 'white') {
          base = base.flatten({ background: { r: 255, g: 255, b: 255 } });
        }

        // 4) 로고 리사이즈 (캔버스/이미지 너비의 size% 기준)
        const logoW = Math.round(imgW * size / 100);
        const resizedLogo = await sharp(logoPath)
          .resize(logoW, null, { fit: 'inside' })
          .png()
          .toBuffer();
        const logoMeta = await sharp(resizedLogo).metadata();
        const logoH = logoMeta.height || logoW;

        // 5) 위치 계산
        let left, top;
        switch (position) {
          case 'bottom-right': left = imgW - logoW - padding; top = imgH - logoH - padding; break;
          case 'bottom-left':  left = padding;                 top = imgH - logoH - padding; break;
          case 'top-right':    left = imgW - logoW - padding; top = padding;                 break;
          case 'top-left':     left = padding;                 top = padding;                 break;
          default:             left = padding;                 top = padding;
        }

        // 6) 뱃지 합성 (옵션) — 로고와 별도 corner
        const composites = [{
          input: resizedLogo,
          left: Math.max(0, left),
          top: Math.max(0, top),
        }];

        if (hasBadge) {
          try {
            const badgeBuf = await resolveBadgeBuffer({
              keyword: badgeKeyword,
              customText: badgeCustom,
              style: badgeStyle,
              useGemini: badgeUseGemini,
              targetSize: Math.round(imgW * badgeSize / 100),
            });
            if (badgeBuf) {
              const bMeta = await sharp(badgeBuf).metadata();
              const bW = bMeta.width || Math.round(imgW * badgeSize / 100);
              const bH = bMeta.height || bW;
              let bLeft, bTop;
              switch (badgePosition) {
                case 'bottom-right': bLeft = imgW - bW - padding; bTop = imgH - bH - padding; break;
                case 'bottom-left':  bLeft = padding;              bTop = imgH - bH - padding; break;
                case 'top-left':     bLeft = padding;              bTop = padding;              break;
                case 'top-right':
                default:             bLeft = imgW - bW - padding; bTop = padding;              break;
              }
              composites.push({ input: badgeBuf, left: Math.max(0, bLeft), top: Math.max(0, bTop) });
            }
          } catch (badgeErr) {
            console.warn('[thumbnail] badge 합성 실패:', badgeErr.message);
          }
        }

        // 7) 합성 + 출력 포맷 결정
        const composited = base.composite(composites);

        const outputAsPng = removeBg && outputBg === 'transparent';
        const output = outputAsPng
          ? await composited.png({ quality: 90 }).toBuffer()
          : await composited.jpeg({ quality: 92 }).toBuffer();

        const mime = outputAsPng ? 'image/png' : 'image/jpeg';

        results.push({
          filename: file.originalname,
          data: `data:${mime};base64,${output.toString('base64')}`,
          size: output.length,
          bgRemoved: removeBg,
          provider: usedProvider,
        });
      } catch (e) {
        results.push({ filename: file.originalname, error: e.message });
      }
    }

    res.json({
      success: true,
      platform,
      position,
      size,
      canvas: targetCanvas,
      marginPct,
      removeBg,
      images: results,
      count: results.filter(r => !r.error).length,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
