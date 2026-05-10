/**
 * SKU master CRUD + listing link CRUD (Phase 1 + Phase 3 PR L audit wiring)
 *
 * 권한: 모두 admin 전용 (requireAdmin).
 *
 * 엔드포인트:
 *   GET    /                          list (filter: q, status, automation_enabled)
 *   GET    /:id                       single + links
 *   POST   /                          create                    [audit: sku_master_create]
 *   PATCH  /:id                       partial update            [audit: sku_master_update]
 *   DELETE /:id                       soft delete               [audit: sku_master_soft_delete]
 *
 *   POST   /:id/links                 add listing link          [audit: sku_listing_link_create]
 *   DELETE /:id/links/:linkId         remove listing link       [audit: sku_listing_link_delete]
 *
 * 정책:
 *   - hard delete 미지원 — 운영 데이터는 status 로만 보류/폐기.
 *   - sku_listing_link 의 (marketplace, listing_id, option_id) UNIQUE 위반 시 409 반환.
 *   - 입력 검증은 한도/타입 위주. 도메인 룰은 Phase 2~3 에서.
 *
 * PR L audit 정책:
 *   - pre-action audit (runAction) 은 strict — 실패 시 실 작업 안 하고 500.
 *   - post-action updateRun 은 best-effort.
 *   - validation 등 audit 생성 전 실패는 audit 기록 X.
 *   - duplicate (23505) 등 부수효과 없는 거부 = status='cancelled' + errorCode='duplicate'.
 *   - 기타 실패 = status='failed'.
 *   - rollback_method='manual' + 짧은 hint.
 *   - snapshot 에 raw body / token / secret 일체 포함 금지 — 명시 컬럼만.
 *   - audit helper 호출 외 helper / rollback API 호출 금지.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');
const safetyExec = require('../../services/safetyExec');

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
// POST /api/sku-master                                          [audit: sku_master_create]
router.post('/', async (req, res) => {
  // pre-validation (audit row 생성 전 단계 — 실패 시 audit 기록 X)
  const body = req.body || {};
  const internalSku = trimOrNull(body.internal_sku, 100);
  const title = trimOrNull(body.title, 255);
  if (!internalSku) return res.status(400).json({ error: 'internal_sku 필수' });
  if (!title) return res.status(400).json({ error: 'title 필수' });

  const createdBy = req.user?.id;
  if (!Number.isFinite(createdBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  const statusVal = body.status && VALID_STATUS.has(body.status) ? body.status : 'active';

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'sku_master_create',
      executedBy:       createdBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'sku_master',
      targetId:         null,                 // post 에 채움
      beforeSnapshot:   null,                 // CREATE — before 없음
      rollbackMethod:   'manual',
      rollbackHint:
        'UPDATE sku_master SET status=\'discontinued\', automation_enabled=false WHERE id=<target_id>;',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[skuMaster] runAction failed (sku_master_create):', {
      actionName: 'sku_master_create', executedBy: createdBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const row = {
      internal_sku: internalSku,
      title,
      product_type: trimOrNull(body.product_type, 50),
      brand:        trimOrNull(body.brand, 100),
      category:     trimOrNull(body.category, 100),
      status:       statusVal,
      automation_enabled: body.automation_enabled === true,
      cost_krw:    parseNumOrNull(body.cost_krw),
      weight_gram: parseIntOrNull(body.weight_gram),
      hs_code:     trimOrNull(body.hs_code, 50),
      notes:       trimOrNull(body.notes),
      created_by:  createdBy,
    };

    const { data, error } = await getClient().from('sku_master').insert(row).select().single();
    if (error) {
      if (error.code === '23505') {
        safetyExec.updateRun(run.id, {
          status: 'cancelled', errorCode: 'duplicate', errorMessage: '동일 internal_sku 가 이미 존재합니다',
        });
        return res.status(409).json({ error: '동일 internal_sku 가 이미 존재합니다' });
      }
      throw error;
    }

    // post-action audit (best-effort) — 명시 컬럼만 snapshot, raw body/secret 금지
    safetyExec.updateRun(run.id, {
      status:   'succeeded',
      targetId: data.id,
      afterSnapshot: {
        id:                 data.id,
        internal_sku:       data.internal_sku,
        title:              data.title,
        status:             data.status,
        automation_enabled: data.automation_enabled,
        cost_krw:           data.cost_krw,
        weight_gram:        data.weight_gram,
        hs_code:            data.hs_code,
      },
    });
    res.status(201).json({ data });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── update ──────────────────────────────────────────────
// PATCH /api/sku-master/:id                                     [audit: sku_master_update]
router.patch('/:id', async (req, res) => {
  // pre-validation (audit row 생성 전)
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

  const executedBy = req.user?.id;
  if (!Number.isFinite(executedBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // before snapshot 확보 (작업 전 row select). 없으면 404 — audit 기록 X.
  const c = getClient();
  let beforeRow;
  try {
    const { data, error } = await c.from('sku_master').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    beforeRow = data;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!beforeRow) return res.status(404).json({ error: 'not found' });

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'sku_master_update',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'sku_master',
      targetId:         id,
      beforeSnapshot:   beforeRow,
      relatedSkuId:     id,
      rollbackMethod:   'manual',
      rollbackHint:
        'UPDATE sku_master SET <컬럼>=<before 값> WHERE id=<target_id>; -- before snapshot 의 모든 변경 컬럼 복원.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[skuMaster] runAction failed (sku_master_update):', {
      actionName: 'sku_master_update', executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const { data, error } = await c
      .from('sku_master').update(updates).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) {
      // race: select 통과 후 update 직전 누군가 삭제. audit 기록 후 404.
      safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'race_or_not_found', errorMessage: 'row vanished between select and update' });
      return res.status(404).json({ error: 'not found' });
    }
    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: data });
    res.json({ data });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── soft delete ─────────────────────────────────────────
// DELETE /api/sku-master/:id  → status='discontinued' 로 soft delete   [audit: sku_master_soft_delete]
router.delete('/:id', async (req, res) => {
  // pre-validation
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const executedBy = req.user?.id;
  if (!Number.isFinite(executedBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // before snapshot — 없으면 404 + audit 기록 X
  const c = getClient();
  let beforeRow;
  try {
    const { data, error } = await c.from('sku_master').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    beforeRow = data;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!beforeRow) return res.status(404).json({ error: 'not found' });

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'sku_master_soft_delete',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'sku_master',
      targetId:         id,
      beforeSnapshot:   beforeRow,
      relatedSkuId:     id,
      rollbackMethod:   'manual',
      rollbackHint:
        `UPDATE sku_master SET status='${beforeRow.status}', automation_enabled=${beforeRow.automation_enabled} WHERE id=<target_id>;`,
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[skuMaster] runAction failed (sku_master_soft_delete):', {
      actionName: 'sku_master_soft_delete', executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const { data, error } = await c
      .from('sku_master')
      .update({ status: 'discontinued', automation_enabled: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'race_or_not_found', errorMessage: 'row vanished between select and update' });
      return res.status(404).json({ error: 'not found' });
    }
    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: data });
    res.json({ data, softDeleted: true });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── add link ────────────────────────────────────────────
// POST /api/sku-master/:id/links  body: { marketplace, listing_id, option_id?, marketplace_sku?, is_primary? }
//                                                                 [audit: sku_listing_link_create]
router.post('/:id/links', async (req, res) => {
  // pre-validation
  const skuId = parseInt(req.params.id, 10);
  if (!Number.isFinite(skuId)) return res.status(400).json({ error: 'invalid id' });

  const body = req.body || {};
  const marketplace = trimOrNull(body.marketplace, 50);
  const listingId = trimOrNull(body.listing_id, 200);
  if (!marketplace || !VALID_MARKETPLACES.has(marketplace)) {
    return res.status(400).json({ error: `marketplace 부적합 (허용: ${[...VALID_MARKETPLACES].join(',')})` });
  }
  if (!listingId) return res.status(400).json({ error: 'listing_id 필수' });

  const executedBy = req.user?.id;
  if (!Number.isFinite(executedBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  const c = getClient();

  // SKU 존재 확인 (audit row 생성 전 — 실패 시 audit 기록 X)
  let skuExists;
  try {
    const { data, error } = await c.from('sku_master').select('id').eq('id', skuId).maybeSingle();
    if (error) throw error;
    skuExists = !!data;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!skuExists) return res.status(404).json({ error: 'sku not found' });

  const optionId       = trimOrNull(body.option_id, 200);
  const marketplaceSku = trimOrNull(body.marketplace_sku, 200);
  const isPrimary      = body.is_primary === true;

  // pre-action audit (strict). beforeSnapshot = intent (생성 의도).
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'sku_listing_link_create',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'sku_listing_link',
      targetId:         null,                 // post 에 채움
      beforeSnapshot: {
        sku_id:          skuId,
        marketplace,
        listing_id:      listingId,
        option_id:       optionId,
        marketplace_sku: marketplaceSku,
        is_primary:      isPrimary,
      },
      relatedSkuId:     skuId,
      rollbackMethod:   'auto',
      rollbackHint:     '자동 되돌리기: 생성된 sku_listing_link row 를 삭제합니다. 실패 시 링크 상태를 확인하고 수동 삭제하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[skuMaster] runAction failed (sku_listing_link_create):', {
      actionName: 'sku_listing_link_create', executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const row = {
      sku_id: skuId,
      marketplace,
      listing_id: listingId,
      option_id:       optionId,
      marketplace_sku: marketplaceSku,
      is_primary:      isPrimary,
    };

    const { data, error } = await c.from('sku_listing_link').insert(row).select().single();
    if (error) {
      if (error.code === '23505') {
        safetyExec.updateRun(run.id, {
          status: 'cancelled', errorCode: 'duplicate',
          errorMessage: '동일 (marketplace, listing_id, option_id) 가 이미 다른 SKU 에 연결됨',
        });
        return res.status(409).json({ error: '동일 (marketplace, listing_id, option_id) 가 이미 다른 SKU 에 연결됨' });
      }
      throw error;
    }

    safetyExec.updateRun(run.id, {
      status: 'succeeded', targetId: data.id, afterSnapshot: data,
    });
    res.status(201).json({ data });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── remove link ─────────────────────────────────────────
// DELETE /api/sku-master/:id/links/:linkId                      [audit: sku_listing_link_delete]
router.delete('/:id/links/:linkId', async (req, res) => {
  // pre-validation
  const skuId  = parseInt(req.params.id, 10);
  const linkId = parseInt(req.params.linkId, 10);
  if (!Number.isFinite(skuId) || !Number.isFinite(linkId)) return res.status(400).json({ error: 'invalid id' });

  const executedBy = req.user?.id;
  if (!Number.isFinite(executedBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // before snapshot — 없으면 404 + audit 기록 X
  const c = getClient();
  let beforeRow;
  try {
    const { data, error } = await c
      .from('sku_listing_link').select('*')
      .eq('id', linkId).eq('sku_id', skuId).maybeSingle();
    if (error) throw error;
    beforeRow = data;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!beforeRow) return res.status(404).json({ error: 'link not found' });

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'sku_listing_link_delete',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'sku_listing_link',
      targetId:         linkId,
      beforeSnapshot:   beforeRow,
      relatedSkuId:     skuId,
      rollbackMethod:   'manual',
      rollbackHint:
        'INSERT INTO sku_listing_link (sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary) VALUES (<before 값>); -- before snapshot 으로 재삽입.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[skuMaster] runAction failed (sku_listing_link_delete):', {
      actionName: 'sku_listing_link_delete', executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const { data, error } = await c
      .from('sku_listing_link')
      .delete()
      .eq('id', linkId)
      .eq('sku_id', skuId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      // race: select 통과 후 delete 직전 누군가 삭제. audit 기록 후 404.
      safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'race_or_not_found', errorMessage: 'row vanished between select and delete' });
      return res.status(404).json({ error: 'link not found' });
    }
    safetyExec.updateRun(run.id, {
      status: 'succeeded',
      afterSnapshot: { deleted: true, id: linkId, sku_id: skuId },
    });
    res.json({ data, deleted: true });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
