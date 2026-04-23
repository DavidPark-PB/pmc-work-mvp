/**
 * 재고 실사 API — /api/stocktake
 * 직원(로그인한 모든 유저) 사용. admin 전용 제한 없음.
 */
const express = require('express');
const crypto = require('crypto');
const { getClient } = require('../../db/supabaseClient');
const adjRepo = require('../../db/stockAdjustmentRepository');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  next();
}
router.use(requireAuth);

const REASON_WHITELIST = new Set(['실사', '파손', '분실', '이벤트', '반품', '기타']);

function toItemDto(row) {
  return {
    itemId: row.item_id,
    sku: row.sku || row.item_id,
    title: row.title || '',
    imageUrl: row.image_url || '',
    currentStock: Number(row.stock != null ? row.stock : (row.ebay_api_stock || 0)),
    ebayApiStock: Number(row.ebay_api_stock || 0),
    barcode: row.barcode || '',
    priceUsd: Number(row.price_usd || 0),
  };
}

// GET /api/stocktake/search?q=... — SKU/바코드/상품명 검색 (상위 20)
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const db = getClient();
    // ebay_products에서 SKU·itemId·title·barcode 매칭
    const pattern = `%${q.replace(/%/g, '')}%`;
    const { data, error } = await db.from('ebay_products')
      .select('item_id, sku, title, image_url, stock, ebay_api_stock, barcode, price_usd')
      .or(`sku.ilike.${pattern},item_id.ilike.${pattern},title.ilike.${pattern},barcode.ilike.${pattern}`)
      .limit(20);
    if (error) throw error;
    res.json({ items: (data || []).map(toItemDto) });
  } catch (e) {
    console.error('[stocktake/search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stocktake/item?sku=... or ?barcode=... — 단건 조회 (스캐너용)
router.get('/item', async (req, res) => {
  try {
    const { sku, barcode, itemId } = req.query;
    if (!sku && !barcode && !itemId) return res.status(400).json({ error: 'sku 또는 barcode 또는 itemId 필요' });
    const db = getClient();
    let query = db.from('ebay_products')
      .select('item_id, sku, title, image_url, stock, ebay_api_stock, barcode, price_usd')
      .limit(1);
    if (barcode) query = query.eq('barcode', String(barcode).trim());
    else if (sku) query = query.eq('sku', String(sku).trim());
    else if (itemId) query = query.eq('item_id', String(itemId).trim());
    const { data, error } = await query.maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });
    res.json({ item: toItemDto(data) });
  } catch (e) {
    console.error('[stocktake/item]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stocktake/session/start — 새 세션 ID 발급
router.post('/session/start', (req, res) => {
  const sessionId = `ST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  res.json({ sessionId, startedAt: new Date().toISOString() });
});

// POST /api/stocktake/adjust — 실사 조정 (시스템 재고 교체 + 로그)
router.post('/adjust', async (req, res) => {
  try {
    const { sku, actualCount, reason, note, sessionId, barcode } = req.body || {};
    if (!sku) return res.status(400).json({ error: 'sku가 필요합니다' });
    const actual = Number(actualCount);
    if (!Number.isFinite(actual) || actual < 0) {
      return res.status(400).json({ error: '실제 카운트는 0 이상의 숫자여야 합니다' });
    }
    const cleanReason = reason && REASON_WHITELIST.has(String(reason)) ? String(reason) : '실사';

    const db = getClient();
    // 현재 stock 조회
    const { data: cur, error: curErr } = await db.from('ebay_products')
      .select('item_id, sku, title, barcode, stock, ebay_api_stock')
      .eq('sku', sku).limit(1).maybeSingle();
    if (curErr) throw curErr;
    if (!cur) return res.status(404).json({ error: '해당 SKU 상품을 찾을 수 없습니다' });

    const previousStock = Number(cur.stock != null ? cur.stock : (cur.ebay_api_stock || 0));
    // stock 업데이트 (수동 편집이라 ebay_api_stock은 건드리지 않음)
    const { error: updErr } = await db.from('ebay_products')
      .update({ stock: actual })
      .eq('sku', sku);
    if (updErr) throw updErr;

    // 바코드 업데이트 (처음 스캔 시)
    if (barcode && !cur.barcode) {
      try {
        await db.from('ebay_products').update({ barcode: String(barcode).trim() }).eq('sku', sku);
      } catch {}
    }

    // 로그 insert
    const logged = await adjRepo.create({
      sku,
      itemId: cur.item_id,
      barcode: barcode || cur.barcode || null,
      title: cur.title,
      previousStock,
      newStock: actual,
      reason: cleanReason,
      note,
      sessionId,
      userId: req.user?.id,
    });

    res.json({
      ok: true,
      previous: previousStock,
      new: actual,
      delta: actual - previousStock,
      log: logged,
    });
  } catch (e) {
    console.error('[stocktake/adjust]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stocktake/adjustments?sku=...&limit=50 — SKU별 이력
router.get('/adjustments', async (req, res) => {
  try {
    const sku = String(req.query.sku || '').trim();
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    if (!sku) return res.json({ adjustments: [] });
    const adjustments = await adjRepo.listBySku(sku, limit);
    res.json({ adjustments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocktake/recent?days=7 — 최근 전체 조정
router.get('/recent', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 7);
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const adjustments = await adjRepo.listRecent({ days, limit });
    res.json({ adjustments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stocktake/session/:sessionId/summary — 세션 집계
router.get('/session/:sessionId/summary', async (req, res) => {
  try {
    const summary = await adjRepo.getSessionSummary(req.params.sessionId);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
