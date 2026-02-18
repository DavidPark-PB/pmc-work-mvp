const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const projectRoot = path.join(__dirname, '..', '..', '..');
const credentialsPath = path.join(projectRoot, 'config', 'credentials.json');

// 플랫폼별 API 모듈 lazy load
function getShopifyAPI() {
  const ShopifyAPI = require('../../api/shopifyAPI');
  return new ShopifyAPI();
}
function getEbayAPI() {
  const EbayAPI = require('../../api/ebayAPI');
  return new EbayAPI();
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

// GET /api/products?platform=&limit=
router.get('/products', async (req, res) => {
  try {
    const { platform, limit = 30 } = req.query;
    const products = await getProducts(platform, parseInt(limit));
    res.json(products);
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
// 분석 엔드포인트 (NEW)
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
      const platform = row.platform || 'eBay';

      totalRevenue += settlement;
      totalProfit += profit;
      totalPurchase += purchase;

      if (!isNaN(margin)) {
        marginSum += margin;
        marginCount++;
        if (margin < 0) negativeMarginCount++;
        else if (margin < 5) lowMarginCount++;
        if (margin >= 20) highMarginCount++;
      }

      if (!byPlatform[platform]) {
        byPlatform[platform] = { count: 0, revenue: 0, profit: 0 };
      }
      byPlatform[platform].count++;
      byPlatform[platform].revenue += settlement;
      byPlatform[platform].profit += profit;
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
// 상품 등록 엔드포인트 (NEW)
// ===========================

// POST /api/products/register — 상품 등록
router.post('/products/register', async (req, res) => {
  try {
    const { sku, title, purchasePrice, weight, priceUSD, shippingUSD, platform, targetPlatforms } = req.body;

    if (!sku || !title) {
      return res.status(400).json({ error: 'SKU와 상품명은 필수입니다' });
    }

    const results = { sheets: false, ebay: null, shopify: null, naver: null };

    // 1. Google Sheets에 추가
    if (fs.existsSync(credentialsPath)) {
      try {
        const sheets = getGoogleSheets();
        await sheets.authenticate();

        const p = parseFloat(priceUSD) || 0;
        const s = parseFloat(shippingUSD) || 3.9;
        const pp = parseFloat(purchasePrice) || 0;
        const fee = Math.round((p + s) * 0.18 * 1400); // KRW
        const tax = Math.round(pp * 0.15); // KRW
        const totalCost = pp + fee + tax;

        const newRow = [
          '',  // Image
          sku,
          title,
          weight || '',
          purchasePrice || '',
          '',  // 실제 배송비(KRW)
          fee || '',
          tax || '',
          totalCost || '',
          priceUSD || '',
          shippingUSD || '3.9',
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
    } else {
      results.sheets = 'credentials.json 없음';
    }

    // 2. eBay 등록
    if (targetPlatforms && targetPlatforms.includes('ebay') && priceUSD) {
      try {
        const ebay = getEbayAPI();
        const ebayResult = await ebay.createProduct({
          title,
          description: title,
          price: parseFloat(priceUSD),
          quantity: 1,
          sku,
          shippingCost: parseFloat(shippingUSD) || 3.9,
        });
        results.ebay = ebayResult.success
          ? { success: true, itemId: ebayResult.itemId }
          : { success: false, error: ebayResult.error };

        // 성공 시 시트에 eBay Item ID 기록
        if (ebayResult.success && ebayResult.itemId && fs.existsSync(credentialsPath)) {
          try {
            const sheets = getGoogleSheets();
            await sheets.authenticate();
            const rows = await sheets.readData(SPREADSHEET_ID, '최종 Dashboard!B2:B');
            if (rows) {
              for (let i = 0; i < rows.length; i++) {
                if (rows[i][0] === sku) {
                  const sheetRow = i + 2;
                  await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!N${sheetRow}`, [[ebayResult.itemId]]);
                  await sheets.writeData(SPREADSHEET_ID, `최종 Dashboard!Q${sheetRow}`, [['등록완료']]);
                  break;
                }
              }
            }
          } catch (sheetErr) {
            console.error('eBay Item ID 시트 업데이트 실패:', sheetErr.message);
          }
        }
      } catch (e) {
        results.ebay = { success: false, error: e.message };
      }
    }

    // 3. Shopify 등록
    if (targetPlatforms && targetPlatforms.includes('shopify') && priceUSD) {
      try {
        const shopify = getShopifyAPI();
        const shopifyResult = await shopify.createProduct({
          title,
          sku,
          price: priceUSD,
        });
        results.shopify = shopifyResult.success
          ? { success: true, productId: shopifyResult.productId }
          : { success: false, error: shopifyResult.error };

        // 성공 시 시트에 Shopify 등록 상태 기록
        if (shopifyResult.success && fs.existsSync(credentialsPath)) {
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
      } catch (e) {
        results.shopify = { success: false, error: e.message };
      }
    }

    // 4. Naver 등록
    if (targetPlatforms && targetPlatforms.includes('naver')) {
      try {
        const naver = getNaverAPI();
        await naver.getToken();
        // KRW 가격 결정: 매입가가 있으면 1.5배, USD만 있으면 환율 적용
        const naverPrice = purchasePrice
          ? Math.round(parseFloat(purchasePrice) * 1.5)
          : Math.round((parseFloat(priceUSD) || 10) * 1400);

        const naverResult = await naver.createProduct({
          productName: title,
          salePrice: naverPrice,
          stockQuantity: 1,
        });
        results.naver = naverResult.success
          ? { success: true, productNo: naverResult.originProductNo }
          : { success: false, error: naverResult.error };
      } catch (e) {
        results.naver = { success: false, error: e.message };
      }
    }

    // 결과 집계
    const platformSuccesses = [];
    if (results.sheets === true) platformSuccesses.push('Google Sheets');
    if (results.ebay?.success) platformSuccesses.push('eBay');
    if (results.shopify?.success) platformSuccesses.push('Shopify');
    if (results.naver?.success) platformSuccesses.push('Naver');

    platformCache = null;

    res.json({
      success: results.sheets === true || platformSuccesses.length > 0,
      message: platformSuccesses.length > 0
        ? `상품이 등록되었습니다 (${platformSuccesses.join(', ')})`
        : '등록 실패',
      results
    });
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
          const api = getEbayAPI();
          const result = await api.getActiveListings(1, 1);
          productCount = result.totalEntries || 0;
          status = productCount > 0 ? 'connected' : (result.totalPages >= 0 ? 'connected' : 'error');
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
        platform: row[18] || 'eBay',
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

  // 플랫폼 시트별 SKU Set 생성 (판매 플랫폼 식별용)
  const platformNames = ['_dashboard', 'eBay', 'Shopify', 'Naver', 'Alibaba'];
  const platformSkuSets = {};
  for (let i = 1; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const skuSet = new Set();
    results[i].value.forEach(item => { if (item.sku) skuSet.add(item.sku); });
    platformSkuSets[platformNames[i]] = skuSet;
  }

  // Dashboard 데이터를 기준으로 플랫폼 태깅
  const skuMap = new Map();
  const dashboardData = results[0].status === 'fulfilled' ? results[0].value : [];
  dashboardData.forEach(item => {
    if (!item.sku) return;
    // SKU가 어느 플랫폼 시트에 있는지 확인하여 판매 플랫폼 결정
    const sellingPlatforms = [];
    for (const [pName, pSet] of Object.entries(platformSkuSets)) {
      if (pSet.has(item.sku)) sellingPlatforms.push(pName);
    }
    if (sellingPlatforms.length > 0) {
      item.platform = sellingPlatforms.join(', ');
    }
    // platform이 여전히 기본 'eBay'이면 Dashboard S열 원본값 유지
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

// getDashboardData — 멀티 플랫폼 통합 데이터
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

    const data = await getAllPlatformData(sheets);
    if (!data || data.length === 0) return [];

    analysisCache = data;
    analysisCacheTime = Date.now();
    return data;
  } catch (error) {
    console.error('Dashboard 데이터 읽기 실패:', error.message);
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
        const result = await api.getActiveListings(1, Math.min(limit, 50));
        return (result.items || []).map(item => ({
          sku: item.sku || item.itemId || '',
          title: item.title || '',
          price: item.price || '',
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

async function getSyncHistory() {
  const logPath = path.join(projectRoot, 'data', 'sync-log.json');
  try {
    if (fs.existsSync(logPath)) {
      return JSON.parse(fs.readFileSync(logPath, 'utf8'));
    }
  } catch (e) {}
  return [];
}

module.exports = router;
