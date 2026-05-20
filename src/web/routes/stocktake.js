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
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (!req.user.isAdmin) return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}
router.use(requireAuth);

// PR S-1: sku_master read 헬퍼 (read only — sku_master 무수정).
//   products.sku 와 sku_master.internal_sku 가 일치하는 row 가 있으면 매칭.
async function fetchMasterMap(skus) {
  if (!skus || skus.length === 0) return {};
  const db = getClient();
  const unique = [...new Set(skus.filter(Boolean))];
  if (unique.length === 0) return {};
  try {
    const { data } = await db.from('sku_master')
      .select('internal_sku, title')
      .in('internal_sku', unique);
    const map = {};
    (data || []).forEach(r => { map[r.internal_sku] = r; });
    return map;
  } catch {
    // sku_master 미존재 / 권한 없음 등 → 빈 map
    return {};
  }
}

// PR S-1: aliases / keywords (text[]) 안전 escape — supabase or() 의 inline value 보호.
//   배열 element ilike 매칭은 PostgREST 가 직접 지원 X → ilike 패턴 안에 포함되는지 array_to_string 으로 우회 불가.
//   대안: 별 query 로 cs(contains)/ov(overlaps) 사용. 본 PR 은 단순화: aliases/keywords 의 element 가 q 와 정확/부분 일치하면 hit.
//   배열에서 element ilike 검색은 PostgREST 의 cs 연산자만 정확 동작 (정확 일치). 부분 일치는 SQL 함수 필요.
//   → 본 PR: 정확 일치만 (대소문자 구분 없이 lowercase 비교). 직원이 별칭을 그대로 입력하는 것 전제.
//   더 정교한 부분 일치는 후속 PR 에서 RPC 또는 trgm 인덱스로.
function _safeIlike(s) {
  return String(s || '').replace(/[%_\\]/g, '\\$&');
}

const REASON_WHITELIST = new Set(['실사', '파손', '분실', '이벤트', '반품', '기타']);

function toItemDto(row, ebay, masterRow) {
  return {
    productId: row.id,
    sku: row.sku || '',
    itemId: ebay?.item_id || null,
    title: row.title_ko || row.title || '',
    imageUrl: ebay?.image_url || '',
    currentStock: Number(row.stock || 0),
    barcode: row.barcode || '',
    // PR S-1 (049) — 신규 검색 컬럼 + sku_master read join
    aliases: row.aliases || [],
    keywords: row.keywords || [],
    internalSku: masterRow?.internal_sku || null,
    masterTitle: masterRow?.title || null,
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

// GET /api/stocktake/search?q=... — 검색 확대 (PR S-1)
//   대상 컬럼:
//     products: sku, title, title_ko, barcode (ilike 부분 일치)
//                aliases, keywords (배열 contains — 정확 일치 element)
//     sku_master.internal_sku (정확 일치 read join)
//   결과: products row 기준 + sku_master.internal_sku 매칭 (있으면 internalSku/masterTitle 포함)
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const db = getClient();
    const safe = _safeIlike(q);
    const pattern = `%${safe}%`;

    // 1) products 의 ilike 4 컬럼 검색
    const ilikeQ = db.from('products')
      .select('id, sku, title, title_ko, stock, barcode, status, aliases, keywords')
      .neq('status', 'trashed')
      .or(`sku.ilike.${pattern},title.ilike.${pattern},title_ko.ilike.${pattern},barcode.ilike.${pattern}`)
      .limit(20);

    // 2) products 의 aliases / keywords 배열 contains (정확 일치)
    //    PostgREST: cs (contains). 배열 안에 q 가 포함되어 있는 row.
    const aliasesQ = db.from('products')
      .select('id, sku, title, title_ko, stock, barcode, status, aliases, keywords')
      .neq('status', 'trashed')
      .contains('aliases', [q])
      .limit(20);
    const keywordsQ = db.from('products')
      .select('id, sku, title, title_ko, stock, barcode, status, aliases, keywords')
      .neq('status', 'trashed')
      .contains('keywords', [q])
      .limit(20);

    const [ilikeRes, aliasesRes, keywordsRes] = await Promise.all([ilikeQ, aliasesQ, keywordsQ]);
    if (ilikeRes.error) throw ilikeRes.error;

    const merged = new Map();
    for (const r of ilikeRes.data || []) merged.set(r.id, r);
    for (const r of (aliasesRes.error ? [] : aliasesRes.data || [])) if (!merged.has(r.id)) merged.set(r.id, r);
    for (const r of (keywordsRes.error ? [] : keywordsRes.data || [])) if (!merged.has(r.id)) merged.set(r.id, r);

    // 3) sku_master.internal_sku 정확 일치 → products.sku 와 매칭 시도
    try {
      const { data: masterRows } = await db.from('sku_master')
        .select('internal_sku, title').eq('internal_sku', q).limit(1);
      const m = (masterRows || [])[0];
      if (m) {
        const { data: byMaster } = await db.from('products')
          .select('id, sku, title, title_ko, stock, barcode, status, aliases, keywords')
          .neq('status', 'trashed').eq('sku', m.internal_sku).limit(5);
        for (const r of byMaster || []) if (!merged.has(r.id)) merged.set(r.id, r);
      }
    } catch { /* sku_master read 실패는 silent */ }

    const rows = Array.from(merged.values()).slice(0, 30);
    const skus = rows.map(r => r.sku).filter(Boolean);
    const [ebayMap, masterMap] = await Promise.all([fetchEbayMap(skus), fetchMasterMap(skus)]);
    res.json({
      items: rows.map(r => toItemDto(r, ebayMap[r.sku], masterMap[r.sku])),
      query: q,
      total: rows.length,
    });
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

// GET /api/stocktake/session/:sessionId/adjustments — 세션 이력 전체
// 사장님이 다른 메뉴 갔다가 실사 재고로 돌아왔을 때 프론트가 sessionLog 복원용.
router.get('/session/:sessionId/adjustments', async (req, res) => {
  try {
    const adjustments = await adjRepo.listBySession(req.params.sessionId);
    res.json({ adjustments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// PR S-1: 검색 실패 4 옵션 + 승인 endpoints
// ──────────────────────────────────────────────────────────────────────────

// 옵션 1) 기존 SKU 에 바코드 추가 — 모든 직원
//   POST /api/stocktake/products/:productId/add-barcode  body: { barcode }
router.post('/products/:productId/add-barcode', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId, 10);
    const barcode = String(req.body?.barcode || '').trim();
    if (!Number.isFinite(productId)) return res.status(400).json({ error: 'invalid productId' });
    if (!barcode) return res.status(400).json({ error: 'barcode 필수' });
    if (barcode.length > 100) return res.status(400).json({ error: 'barcode 가 너무 깁니다 (max 100)' });

    const db = getClient();
    const { data: existing, error: e1 } = await db.from('products')
      .select('id, sku, barcode').eq('id', productId).maybeSingle();
    if (e1) throw e1;
    if (!existing) return res.status(404).json({ error: '상품을 찾을 수 없습니다' });

    // 다른 상품에 같은 바코드 있으면 충돌 경고 (강제 막진 않음)
    const { data: dup } = await db.from('products')
      .select('id, sku').eq('barcode', barcode).neq('id', productId).limit(1);
    const conflict = (dup || [])[0];

    const { error: upErr } = await db.from('products')
      .update({ barcode }).eq('id', productId);
    if (upErr) throw upErr;

    // ebay_products 도 같은 sku 면 동기화 (best-effort)
    if (existing.sku) {
      try { await db.from('ebay_products').update({ barcode }).eq('sku', existing.sku); } catch {}
    }

    res.json({
      ok: true,
      productId,
      barcode,
      previousBarcode: existing.barcode || null,
      conflictWith: conflict ? { id: conflict.id, sku: conflict.sku } : null,
    });
  } catch (e) {
    console.error('[stocktake/add-barcode]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 옵션 2) 임시 실사 기록 저장 (sku NULL 허용 + status='pending')
//   POST /api/stocktake/temporary  body: { barcode?, title?, actualCount, note?, sessionId? }
router.post('/temporary', async (req, res) => {
  try {
    const { barcode, title, actualCount, note, sessionId } = req.body || {};
    const actual = Number(actualCount);
    if (!Number.isFinite(actual) || actual < 0) {
      return res.status(400).json({ error: '실사 수량은 0 이상의 숫자' });
    }
    if (!barcode && !title) {
      return res.status(400).json({ error: 'barcode 또는 title 중 1개 이상 필요' });
    }
    const logged = await adjRepo.create({
      sku: null,                     // 임시 실사 — sku 미정
      barcode: barcode || null,
      title: title || '(임시 실사 — SKU 미정)',
      previousStock: 0,
      newStock: actual,
      reason: '실사',
      note: (note || '') + ' [임시 — SKU 미매칭]',
      sessionId,
      userId: req.user?.id,
      status: 'pending',
    });
    res.status(201).json({ ok: true, log: logged });
  } catch (e) {
    console.error('[stocktake/temporary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 옵션 3) 검토 필요 저장 — note 필수
//   POST /api/stocktake/review-required  body: { barcode?, sku?, title?, actualCount?, note }
router.post('/review-required', async (req, res) => {
  try {
    const { barcode, sku, title, actualCount, note, sessionId } = req.body || {};
    const noteStr = String(note || '').trim();
    if (!noteStr) return res.status(400).json({ error: '검토 사유 (note) 필수' });
    const actual = actualCount != null && actualCount !== '' ? Number(actualCount) : 0;
    const logged = await adjRepo.create({
      sku: sku || null,
      barcode: barcode || null,
      title: title || '(검토 필요)',
      previousStock: 0,
      newStock: Number.isFinite(actual) && actual >= 0 ? actual : 0,
      reason: '실사',
      note: noteStr,
      sessionId,
      userId: req.user?.id,
      status: 'review_required',
    });
    res.status(201).json({ ok: true, log: logged });
  } catch (e) {
    console.error('[stocktake/review-required]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 옵션 4) 신규 상품 등록 redirect 정보 응답 (실 등록은 기존 상품 관리 페이지에서)
//   GET /api/stocktake/new-product-redirect?barcode=...&keyword=...
router.get('/new-product-redirect', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.barcode) params.set('prefillBarcode', String(req.query.barcode));
  if (req.query.keyword) params.set('prefillTitle', String(req.query.keyword));
  res.json({
    redirectUrl: '/?page=products' + (params.toString() ? '#' + params.toString() : ''),
    hint: '상품 관리 페이지로 이동해 신규 상품을 등록하세요. 등록 후 재고 실사로 돌아오면 검색됩니다.',
  });
});

// 승인 워크플로우 — admin only (PR S-1)
//   GET /api/stocktake/pending?status=pending&limit=200
router.get('/pending', requireAdmin, async (req, res) => {
  try {
    const status = ['pending', 'review_required', 'cancelled'].includes(req.query.status)
      ? req.query.status : 'pending';
    const limit = parseInt(req.query.limit, 10) || 200;
    const data = await adjRepo.listByStatus({ status, limit });
    res.json({ status, data });
  } catch (e) {
    console.error('[stocktake/pending]', e.message);
    res.status(500).json({ error: e.message });
  }
});

//   POST /api/stocktake/apply  body: { ids: [n, n, ...] }
//   일괄 승인 — sku 가 있는 row 만. 임시/검토 row 는 skip + result 에 사유.
router.post('/apply', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids 배열 필수' });
    if (ids.length > 200) return res.status(400).json({ error: '한 번에 최대 200건' });
    const result = await adjRepo.applyBatch(ids, req.user.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[stocktake/apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

//   POST /api/stocktake/:id/cancel  — 단건 취소 (admin)
router.post('/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const updated = await adjRepo.setStatus(id, 'cancelled', { byUser: req.user.id });
    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/stocktake/:id — 실사 항목 수정 (newStock / reason / note).
// 본인 등록분 또는 admin 만. applied 또는 cancelled 상태는 수정 금지.
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const existing = await adjRepo.getById(id);
    if (!existing) return res.status(404).json({ error: '항목을 찾을 수 없습니다' });

    // 권한: admin OR 본인 등록분
    if (!req.user.isAdmin && existing.adjustedBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 실사만 수정할 수 있습니다' });
    }

    // 상태 가드 — 이미 마스터에 반영됐거나 취소된 항목은 수정 불가
    if (existing.status === 'applied') {
      return res.status(400).json({ error: '이미 마스터에 반영된 항목은 수정할 수 없습니다 (관리자에게 문의)' });
    }
    if (existing.status === 'cancelled') {
      return res.status(400).json({ error: '취소된 항목은 수정할 수 없습니다' });
    }

    const { newStock, reason, note } = req.body || {};
    const updated = await adjRepo.update(id, { newStock, reason, note });
    res.json({ ok: true, data: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
