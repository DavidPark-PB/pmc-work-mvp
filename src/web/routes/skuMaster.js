/**
 * SKU master CRUD + listing link CRUD (Phase 1)
 *
 * 권한: 모두 admin 전용 (requireAdmin).
 *
 * 엔드포인트:
 *   GET    /                          list (filter: q, status, automation_enabled)
 *   GET    /:id                       single + links
 *   POST   /                          create
 *   PATCH  /:id                       partial update
 *   DELETE /:id                       soft delete (status='discontinued', hard delete 안 함)
 *
 *   POST   /:id/links                 add listing link
 *   DELETE /:id/links/:linkId         remove listing link
 *
 * 정책:
 *   - hard delete 미지원 — 운영 데이터는 status 로만 보류/폐기.
 *   - sku_listing_link 의 (marketplace, listing_id, option_id) UNIQUE 위반 시 409 반환.
 *   - 입력 검증은 한도/타입 위주. 도메인 룰은 Phase 2~3 에서.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

// 모든 SKU master 라우트는 admin 전용
router.use(requireAdmin);

const VALID_STATUS = new Set(['active', 'paused', 'discontinued']);
const VALID_MARKETPLACES = new Set(['ebay', 'shopify', 'naver', 'shopee', 'alibaba', 'coupang', 'qoo10']);

// ── helpers ─────────────────────────────────────────────
function trimOrNull(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function parseNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// ── list ────────────────────────────────────────────────
// GET /api/sku-master?q=&status=&automation_enabled=true|false
router.get('/', async (req, res) => {
  try {
    const c = getClient();
    let q = c.from('sku_master').select('*').order('updated_at', { ascending: false });

    const search = trimOrNull(req.query.q, 100);
    if (search) {
      // internal_sku 또는 title 부분일치
      q = q.or(`internal_sku.ilike.%${search}%,title.ilike.%${search}%`);
    }
    const status = trimOrNull(req.query.status, 30);
    if (status && VALID_STATUS.has(status)) q = q.eq('status', status);

    if (req.query.automation_enabled === 'true') q = q.eq('automation_enabled', true);
    else if (req.query.automation_enabled === 'false') q = q.eq('automation_enabled', false);

    const { data, error } = await q.limit(500);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── single + links ──────────────────────────────────────
// GET /api/sku-master/:id
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const c = getClient();
    const [{ data: sku, error: e1 }, { data: links, error: e2 }] = await Promise.all([
      c.from('sku_master').select('*').eq('id', id).maybeSingle(),
      c.from('sku_listing_link').select('*').eq('sku_id', id).order('created_at', { ascending: false }),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    if (!sku) return res.status(404).json({ error: 'not found' });

    res.json({ data: { ...sku, links: links || [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── create ──────────────────────────────────────────────
// POST /api/sku-master
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const internalSku = trimOrNull(body.internal_sku, 100);
    const title = trimOrNull(body.title, 255);
    if (!internalSku) return res.status(400).json({ error: 'internal_sku 필수' });
    if (!title) return res.status(400).json({ error: 'title 필수' });

    const status = body.status && VALID_STATUS.has(body.status) ? body.status : 'active';

    const row = {
      internal_sku: internalSku,
      title,
      product_type: trimOrNull(body.product_type, 50),
      brand:        trimOrNull(body.brand, 100),
      category:     trimOrNull(body.category, 100),
      status,
      automation_enabled: body.automation_enabled === true,
      cost_krw:    parseNumOrNull(body.cost_krw),
      weight_gram: parseIntOrNull(body.weight_gram),
      hs_code:     trimOrNull(body.hs_code, 50),
      notes:       trimOrNull(body.notes),
      created_by:  req.user?.id ?? null,
    };

    const { data, error } = await getClient().from('sku_master').insert(row).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: '동일 internal_sku 가 이미 존재합니다' });
      throw error;
    }
    res.status(201).json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── update ──────────────────────────────────────────────
// PATCH /api/sku-master/:id
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };

    if (body.title !== undefined) {
      const t = trimOrNull(body.title, 255);
      if (!t) return res.status(400).json({ error: 'title 비울 수 없음' });
      updates.title = t;
    }
    if (body.product_type !== undefined) updates.product_type = trimOrNull(body.product_type, 50);
    if (body.brand !== undefined)        updates.brand        = trimOrNull(body.brand, 100);
    if (body.category !== undefined)     updates.category     = trimOrNull(body.category, 100);
    if (body.status !== undefined) {
      if (!VALID_STATUS.has(body.status)) return res.status(400).json({ error: 'status 값 부적합' });
      updates.status = body.status;
    }
    if (body.automation_enabled !== undefined) updates.automation_enabled = body.automation_enabled === true;
    if (body.cost_krw !== undefined)     updates.cost_krw    = parseNumOrNull(body.cost_krw);
    if (body.weight_gram !== undefined)  updates.weight_gram = parseIntOrNull(body.weight_gram);
    if (body.hs_code !== undefined)      updates.hs_code     = trimOrNull(body.hs_code, 50);
    if (body.notes !== undefined)        updates.notes       = trimOrNull(body.notes);

    // internal_sku 변경 금지 (식별자 안정성)
    if (body.internal_sku !== undefined) {
      return res.status(400).json({ error: 'internal_sku 는 변경할 수 없습니다' });
    }

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ error: '변경할 필드가 없습니다' });
    }

    const { data, error } = await getClient()
      .from('sku_master').update(updates).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── soft delete ─────────────────────────────────────────
// DELETE /api/sku-master/:id  → status='discontinued' 로 soft delete
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const { data, error } = await getClient()
      .from('sku_master')
      .update({ status: 'discontinued', automation_enabled: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ data, softDeleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── add link ────────────────────────────────────────────
// POST /api/sku-master/:id/links  body: { marketplace, listing_id, option_id?, marketplace_sku?, is_primary? }
router.post('/:id/links', async (req, res) => {
  try {
    const skuId = parseInt(req.params.id, 10);
    if (!Number.isFinite(skuId)) return res.status(400).json({ error: 'invalid id' });

    const body = req.body || {};
    const marketplace = trimOrNull(body.marketplace, 50);
    const listingId = trimOrNull(body.listing_id, 200);
    if (!marketplace || !VALID_MARKETPLACES.has(marketplace)) {
      return res.status(400).json({ error: `marketplace 부적합 (허용: ${[...VALID_MARKETPLACES].join(',')})` });
    }
    if (!listingId) return res.status(400).json({ error: 'listing_id 필수' });

    const c = getClient();
    // SKU 존재 확인
    const { data: sku, error: e1 } = await c.from('sku_master').select('id').eq('id', skuId).maybeSingle();
    if (e1) throw e1;
    if (!sku) return res.status(404).json({ error: 'sku not found' });

    const row = {
      sku_id: skuId,
      marketplace,
      listing_id: listingId,
      option_id:       trimOrNull(body.option_id, 200),
      marketplace_sku: trimOrNull(body.marketplace_sku, 200),
      is_primary:      body.is_primary === true,
    };

    const { data, error } = await c.from('sku_listing_link').insert(row).select().single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: '동일 (marketplace, listing_id, option_id) 가 이미 다른 SKU 에 연결됨' });
      }
      throw error;
    }
    res.status(201).json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── remove link ─────────────────────────────────────────
// DELETE /api/sku-master/:id/links/:linkId
router.delete('/:id/links/:linkId', async (req, res) => {
  try {
    const skuId = parseInt(req.params.id, 10);
    const linkId = parseInt(req.params.linkId, 10);
    if (!Number.isFinite(skuId) || !Number.isFinite(linkId)) return res.status(400).json({ error: 'invalid id' });

    const c = getClient();
    const { data, error } = await c
      .from('sku_listing_link')
      .delete()
      .eq('id', linkId)
      .eq('sku_id', skuId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'link not found' });
    res.json({ data, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
