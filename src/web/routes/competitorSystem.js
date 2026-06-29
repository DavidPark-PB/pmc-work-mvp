'use strict';

/**
 * Competitor System Routes  (/api/competitor-system 또는 서버에서 마운트된 경로)
 *
 * 인증: server.js에서 authGuard 이후에 마운트되므로 별도 미들웨어 불필요.
 *
 * 엔드포인트:
 *   셀러 관리
 *     GET    /sellers
 *     POST   /sellers
 *     PATCH  /sellers/:sellerId
 *     DELETE /sellers/:sellerId
 *
 *   리스팅 조회
 *     GET    /listings
 *     GET    /listings/:ebayItemId
 *
 *   매핑 관리
 *     GET    /matches
 *     PATCH  /matches/:id/approve
 *     PATCH  /matches/:id/reject
 *     PATCH  /matches/:id/ignore
 *
 *   대시보드
 *     GET    /dashboard
 *
 *   수동 실행
 *     POST   /crawl/run
 *     POST   /match/run
 *
 *   가격 이력
 *     GET    /price-history/:ebayItemId
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../config/.env') });

const express = require('express');
const { getClient } = require('../../db/supabaseClient');
const { getDashboard, getPriceHistory } = require('../../services/competitorDashboard');
const marketIntel = require('../../services/hermesMarketIntelligence');
const productIntel = require('../../services/hermesProductIntelligence');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────────

/** Supabase 에러를 Express 응답으로 변환 */
function dbError(res, error, defaultStatus = 500) {
  const status = error?.code === '23505' ? 409 : defaultStatus;
  return res.status(status).json({ error: error.message || String(error) });
}

// ─────────────────────────────────────────────────────────────
// 셀러 관리
// ─────────────────────────────────────────────────────────────

/** GET /sellers — competitor_sellers 전체 목록 */
router.get('/sellers', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db
      .from('competitor_sellers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return dbError(res, error);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /sellers — 신규 셀러 등록 */
router.post('/sellers', async (req, res) => {
  try {
    const db = getClient();
    const { seller_id, seller_name, platform, memo, crawl_interval } = req.body || {};

    if (!seller_id) return res.status(400).json({ error: 'seller_id 는 필수입니다.' });

    const payload = { seller_id, seller_name, platform, memo, crawl_interval };
    // undefined 값 제거
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const { data, error } = await db
      .from('competitor_sellers')
      .insert(payload)
      .select()
      .single();

    if (error) return dbError(res, error, 400);
    res.status(201).json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /sellers/:sellerId — 셀러 정보 수정 */
router.patch('/sellers/:sellerId', async (req, res) => {
  try {
    const db = getClient();
    const { sellerId } = req.params;
    const allowed = ['active', 'memo', 'crawl_interval', 'seller_name'];
    const updates = {};
    for (const key of allowed) {
      if (req.body && key in req.body) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '수정할 필드가 없습니다.' });
    }

    const { data, error } = await db
      .from('competitor_sellers')
      .update(updates)
      .eq('seller_id', sellerId)
      .select()
      .single();

    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: '셀러를 찾을 수 없습니다.' });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /sellers/:sellerId — 실제 삭제 (cascade) */
router.delete('/sellers/:sellerId', async (req, res) => {
  try {
    const db = getClient();
    const { sellerId } = req.params;

    const { error } = await db
      .from('competitor_sellers')
      .delete()
      .eq('seller_id', sellerId);

    if (error) return dbError(res, error);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 리스팅 조회
// ─────────────────────────────────────────────────────────────

/**
 * GET /listings
 * query: sellerId, status, search, limit(기본50), offset
 */
router.get('/listings', async (req, res) => {
  try {
    const db = getClient();
    const {
      sellerId,
      status,
      search,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = req.query;

    const limit = Math.min(500, Math.max(1, parseInt(rawLimit, 10) || 50));
    const offset = Math.max(0, parseInt(rawOffset, 10) || 0);

    let query = db
      .from('competitor_listings')
      .select('*', { count: 'exact' })
      .order('last_seen_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (sellerId) query = query.eq('seller_id', sellerId);
    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('title', `%${search}%`);

    const { data, error, count } = await query;
    if (error) return dbError(res, error);
    res.json({ data, total: count, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /listings/:ebayItemId — 단일 리스팅 상세 + 가격 이력 */
router.get('/listings/:ebayItemId', async (req, res) => {
  try {
    const db = getClient();
    const { ebayItemId } = req.params;

    const [listingResult, historyResult] = await Promise.all([
      db.from('competitor_listings')
        .select('*')
        .eq('ebay_item_id', ebayItemId)
        .single(),
      db.from('competitor_price_history')
        .select('*')
        .eq('ebay_item_id', ebayItemId)
        .order('changed_at', { ascending: false })
        .limit(100),
    ]);

    if (listingResult.error) {
      if (listingResult.error.code === 'PGRST116') {
        return res.status(404).json({ error: '리스팅을 찾을 수 없습니다.' });
      }
      return dbError(res, listingResult.error);
    }

    res.json({
      data: listingResult.data,
      priceHistory: historyResult.data || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 매핑 관리
// ─────────────────────────────────────────────────────────────

/**
 * GET /matches
 * query: status(pending/approved/rejected), ourSku, limit, offset
 */
router.get('/matches', async (req, res) => {
  try {
    const db = getClient();
    const {
      status,
      ourSku,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = req.query;

    const limit = Math.min(500, Math.max(1, parseInt(rawLimit, 10) || 50));
    const offset = Math.max(0, parseInt(rawOffset, 10) || 0);

    let query = db
      .from('product_matches')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (ourSku) query = query.eq('our_sku', ourSku);

    const { data, error, count } = await query;
    if (error) return dbError(res, error);
    res.json({ data, total: count, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /matches/:id/approve — 승인 */
router.patch('/matches/:id/approve', async (req, res) => {
  try {
    const db = getClient();
    const id = req.params.id;

    const { data, error } = await db
      .from('product_matches')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: req.user?.username || 'admin',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: '매핑을 찾을 수 없습니다.' });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /matches/:id/reject — 거부 */
router.patch('/matches/:id/reject', async (req, res) => {
  try {
    const db = getClient();
    const id = req.params.id;

    const { data, error } = await db
      .from('product_matches')
      .update({ status: 'rejected' })
      .eq('id', id)
      .select()
      .single();

    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: '매핑을 찾을 수 없습니다.' });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /matches/:id/ignore — 무시 */
router.patch('/matches/:id/ignore', async (req, res) => {
  try {
    const db = getClient();
    const id = req.params.id;

    const { data, error } = await db
      .from('product_matches')
      .update({ status: 'ignored' })
      .eq('id', id)
      .select()
      .single();

    if (error) return dbError(res, error);
    if (!data) return res.status(404).json({ error: '매핑을 찾을 수 없습니다.' });
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 대시보드
// ─────────────────────────────────────────────────────────────

/** GET /dashboard — 경쟁가 대시보드 */
router.get('/dashboard', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const onlyCompeted = req.query.onlyCompeted !== 'false';

    const result = await getDashboard({ limit, onlyCompeted });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Hermes v1 Market Intelligence (read/report only)
// ─────────────────────────────────────────────────────────────

/** POST /market/alerts/generate — 최근 변동으로 market_alerts 생성 */
router.post('/market/alerts/generate', async (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, parseInt(req.body?.hours, 10) || 24));
    const sendTelegram = req.body?.sendTelegram === true;
    const result = await marketIntel.generateMarketAlerts({ hours, sendTelegram });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /market/alerts — 최근 market_alerts 조회 */
router.get('/market/alerts', async (req, res) => {
  try {
    const db = getClient();
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { data, error } = await db
      .from('market_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return dbError(res, error);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /market/daily-report/run — Daily Report 생성/전송 */
router.post('/market/daily-report/run', async (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, parseInt(req.body?.hours, 10) || 24));
    const sendTelegram = req.body?.sendTelegram === true;
    const result = await marketIntel.runDailyReport({ hours, sendTelegram });
    res.json({ ok: true, reportId: result.report.id || null, summary: result.report.summary, alertResult: result.alertResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /market/daily-report/latest — 최근 Daily Report */
router.get('/market/daily-report/latest', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db
      .from('daily_reports')
      .select('*')
      .eq('report_type', 'ebay_market_intelligence')
      .order('report_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return dbError(res, error);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /product-intelligence/run — SKU 포트폴리오 분석 report 생성/전송 */
router.post('/product-intelligence/run', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.body?.days, 10) || 30));
    const sendTelegram = req.body?.sendTelegram === true;
    const result = await productIntel.runProductIntelligence({ days, sendTelegram });
    res.json({
      ok: true,
      reportId: result.report.id || null,
      summary: result.report.summary,
      data: result.report.data,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /product-intelligence/latest — 최근 Product Intelligence report */
router.get('/product-intelligence/latest', async (req, res) => {
  try {
    const db = getClient();
    const { data, error } = await db
      .from('daily_reports')
      .select('*')
      .eq('report_type', 'product_intelligence')
      .order('report_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return dbError(res, error);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /product-intelligence/preview — 저장 없이 Product Intelligence preview */
router.get('/product-intelligence/preview', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const result = await productIntel.buildProductIntelligenceReport({ days, save: false });
    res.json({
      report: result.report,
      rows: result.rows.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 수동 실행
// ─────────────────────────────────────────────────────────────

/**
 * POST /crawl/run — 크롤러 수동 실행
 * body: { sellerIds: [], silent: false }
 */
router.post('/crawl/run', async (req, res) => {
  try {
    const { sellerIds = [], silent = false } = req.body || {};

    // runCrawler 는 향후 src/services/competitorCrawler.js (또는 유사 경로)에 위치 예정
    // 현재 파일이 없을 경우를 대비해 동적 require + 없으면 501 반환
    let runCrawler;
    try {
      ({ runCrawler } = require('../../services/competitorCrawler'));
    } catch (_) {
      return res.status(501).json({
        error: 'competitorCrawler 모듈이 아직 구현되지 않았습니다.',
        hint: 'src/services/competitorCrawler.js 에 runCrawler() 를 구현하세요.',
      });
    }

    // 백그라운드로 실행 (응답을 먼저 반환)
    res.json({ ok: true, message: '크롤러를 시작합니다.', sellerIds, silent });

    runCrawler({ sellerIds, silent }).catch(err => {
      console.error('[competitorSystem] runCrawler error:', err.message);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /match/run — AI 매처 수동 실행
 * body: { hours: 25, silent: false, dryRun: false }
 */
router.post('/match/run', async (req, res) => {
  try {
    const { hours = 25, silent = false, dryRun = false } = req.body || {};

    let runMatcher;
    try {
      ({ runMatcher } = require('../../services/competitorMatcher'));
    } catch (_) {
      return res.status(501).json({
        error: 'competitorMatcher 모듈이 아직 구현되지 않았습니다.',
        hint: 'src/services/competitorMatcher.js 에 runMatcher() 를 구현하세요.',
      });
    }

    res.json({ ok: true, message: 'AI 매처를 시작합니다.', hours, silent, dryRun });

    runMatcher({ hours, silent, dryRun }).catch(err => {
      console.error('[competitorSystem] runMatcher error:', err.message);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 가격 이력
// ─────────────────────────────────────────────────────────────

/** GET /price-history/:ebayItemId — 특정 상품 가격 이력 (최근 100건) */
router.get('/price-history/:ebayItemId', async (req, res) => {
  try {
    const { ebayItemId } = req.params;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));

    const data = await getPriceHistory(ebayItemId, limit);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
