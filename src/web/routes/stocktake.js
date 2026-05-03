/**
 * 재고 실사 API — /api/stocktake
 *
 * 마스터: products (운영관리 → 재고관리와 동일 source).
 * 실사 카운트는 stock_adjustments 에만 기록 — 마스터(products.stock) 자동 변경 X.
 * 차이는 사장님이 별도 검토 후 수동 적용.
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

function toItemDto(row, ebay) {
  return {
    productId: row.id,
    sku: row.sku || '',
    itemId: ebay?.item_id || null,
    title: row.title_ko || row.title || '',
    imageUrl: ebay?.image_url || '',
    currentStock: Number(row.stock || 0),
    barcode: row.barcode || '',
  };
}

// products.sku 배열로 ebay_products 보조정보 (item_id, image_url) 한 번에 조회.
async function fetchEbayMap(skus) {
  if (!skus || skus.length === 0) return {};
  const db = getClient();
  const { data } = await db.from('ebay_products')
    .select('sku, item_id, image_url')
    .in('sku', skus);
  const map = {};
  (data || []).forEach(r => { if (r.sku) map[r.sku] = r; });
  return map;
}

// GET /api/stocktake/search?q=... — SKU/바코드/상품명 검색 (상위 20)
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const db = getClient();
    const pattern = `%${q.replace(/%/g, '')}%`;
    const { data, error } = await db.from('products')
      .select('id, sku, title, title_ko, stock, barcode, status')
      .neq('status', 'trashed')
      .or(`sku.ilike.${pattern},title.ilike.${pattern},title_ko.ilike.${pattern},barcode.ilike.${pattern}`)
      .limit(20);
    if (error) throw error;
    const rows = data || [];
    const ebayMap = await fetchEbayMap(rows.map(r => r.sku).filter(Boolean));
    res.json({ items: rows.map(r => toItemDto(r, ebayMap[r.sku])) });
  } catch (e) {
    console.error('[stocktake/search]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stocktake/item?sku=... or ?barcode=... or ?itemId=... — 단건 조회 (스캐너용)
router.get('/item', async (req, res) => {
  try {
    const { sku, barcode, itemId } = req.query;
    if (!sku && !barcode && !itemId) return res.status(400).json({ error: 'sku 또는 barcode 또는 itemId 필요' });
    const db = getClient();

    // 1. itemId 로 조회 시 ebay_products 에서 sku 찾고 그 sku 로 products 조회 (eBay 만 등록된 경우 fallback).
    let resolvedSku = sku ? String(sku).trim() : null;
    if (!resolvedSku && itemId) {
      const { data: ep } = await db.from('ebay_products')
        .select('sku').eq('item_id', String(itemId).trim()).limit(1).maybeSingle();
      if (ep?.sku) resolvedSku = ep.sku;
    }

    let query = db.from('products')
      .select('id, sku, title, title_ko, stock, barcode, status')
      .neq('status', 'trashed')
      .limit(1);
    if (barcode) query = query.eq('barcode', String(barcode).trim());
    else if (resolvedSku) query = query.eq('sku', resolvedSku);
    else return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const { data, error } = await query.maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    const ebayMap = await fetchEbayMap([data.sku]);
    res.json({ item: toItemDto(data, ebayMap[data.sku]) });
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

// POST /api/stocktake/adjust — 실사 카운트 기록 (마스터 자동 업데이트 X, 로그만)
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
    const { data: cur, error: curErr } = await db.from('products')
      .select('id, sku, title, title_ko, barcode, stock')
      .eq('sku', sku).limit(1).maybeSingle();
    if (curErr) throw curErr;
    if (!cur) return res.status(404).json({ error: '해당 SKU 상품을 찾을 수 없습니다' });

    const previousStock = Number(cur.stock || 0);

    // 바코드 처음 스캔 시 마스터 보강 (products + ebay_products 동기화).
    // 이건 "마스터 자동 업데이트 X" 정책 예외 — 식별자 매핑이지 재고 수치 변경이 아님.
    if (barcode && !cur.barcode) {
      const trimmed = String(barcode).trim();
      try { await db.from('products').update({ barcode: trimmed }).eq('id', cur.id); } catch {}
      try { await db.from('ebay_products').update({ barcode: trimmed }).eq('sku', sku); } catch {}
    }

    // ebay_products.item_id 보조 (로그용)
    let itemId = null;
    try {
      const { data: ep } = await db.from('ebay_products')
        .select('item_id').eq('sku', sku).limit(1).maybeSingle();
      itemId = ep?.item_id || null;
    } catch {}

    // 로그 insert — 마스터(products.stock) 는 변경 안 함.
    const logged = await adjRepo.create({
      sku,
      itemId,
      barcode: barcode || cur.barcode || null,
      title: cur.title_ko || cur.title,
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
      masterUpdated: false,
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
