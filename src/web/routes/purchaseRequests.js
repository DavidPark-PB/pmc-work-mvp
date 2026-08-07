/**
 * 발주 요청 API (/api/purchase-requests)
 * 주의: 레거시 /api/orders/*는 주문(판매) 관리용이라 이름 충돌을 피하기 위해 purchase-requests 경로 사용.
 *
 * Phase 3 PR L-2 audit wiring:
 *   POST   /                      purchase_request_create
 *   PATCH  /:id                   purchase_request_update
 *   PATCH  /:id/approve           purchase_request_approve
 *   PATCH  /:id/reject            purchase_request_reject
 *   PATCH  /:id/order             purchase_request_ordered
 *
 *   - audit 정책: pre-runAction strict (실패 시 500), post-updateRun best-effort.
 *   - validation 등 audit 생성 전 실패는 audit 기록 X.
 *   - duplicate / 부수효과 없는 거부 = status='cancelled', 그 외 실패 = 'failed'.
 *   - snapshot 에는 핵심 필드만 — req.body 전체 / token / secret 일체 포함 금지.
 *   - rollback_method='manual' + 짧은 hint.
 *   - PATCH /:id/unorder 는 spec 의 cancel 과 의미 다름 (ordered→approved 되돌리기) — audit 추가 안 함, 후속 PR 결정.
 *   - DELETE / 첨부 라우트는 spec 부재 — audit 추가 안 함.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/purchaseRequestRepository');
const attRepo = require('../../db/purchaseRequestAttachmentRepository');
const { notify, notifyAdmins, getAdminIds } = require('../../services/notificationService');
const sseHub = require('../../services/sseHub');
const { getClient } = require('../../db/supabaseClient');
const safetyExec = require('../../services/safetyExec');
const dupDetector = require('../../services/duplicatePurchaseDetector');
const expenseRepo = require('../../db/expenseRepository');

// ─── 발주-지출 통합 (2026-08-08 사장님 지침) ─────────────────────────────
//
//   ordered 상태 시 expenses 자동 생성. 사장님 지침:
//     1) 실제 구매금액(actual_price)만 지출 amount 로 사용 (estimated_price 절대 금지)
//     2) source_type='purchase_order', source_id=purchase_request.id 필수
//     3) UNIQUE(source_type, source_id) 인덱스 + 앱 레벨 방어 (이미 있으면 skip)
//     4) 자동 생성 지출은 지출관리에서 배지 표시 (source_type 으로 구분)
//     5) 취소 시 삭제 X → status='cancelled' 로 마킹
//
async function autoCreateExpense(pr, executedBy) {
  // 필수: actual_price
  const amount = Number(pr.actual_price);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('actual_price 가 없어 지출 자동생성 불가 (구매완료 시 실제 구매금액 필수)');
  }

  // 앱 레벨 중복 방어 (UNIQUE 인덱스 + 앱 레벨 이중 방어)
  const { data: existing } = await getClient()
    .from('expenses')
    .select('id, status')
    .eq('source_type', 'purchase_order')
    .eq('source_id', pr.id)
    .maybeSingle();
  if (existing) {
    // 취소된 것이면 다시 활성화 (드문 재실행 케이스)
    if (existing.status === 'cancelled') {
      await expenseRepo.updateExpense(existing.id, { status: null });
    }
    return existing.id;
  }

  const paidAt = pr.purchased_at || pr.ordered_at || new Date().toISOString();
  const memo = `${pr.product_name} × ${pr.quantity}${pr.unit || '개'}`
    + (pr.memo ? ` — ${pr.memo}` : '');

  const created = await expenseRepo.createExpense({
    paidAt,
    amount,                                     // 실제 구매금액만
    currency: 'KRW',
    category: '재료비',                          // 발주는 재고 매입 → 재료비 카테고리 (수정 가능)
    merchant: null,                              // 거래처는 supplier_id 기반. 지금은 null.
    memo,
    source: 'manual',                            // legacy 필드
    cardLast4: pr.card_last4 || null,
    createdBy: pr.requested_by || executedBy,
    // 발주-지출 링크
    sourceType: 'purchase_order',
    sourceId: pr.id,
    paidBy: executedBy,
    status: null,                                // 기본 (활성)
  });
  return created.id;
}

async function cancelLinkedExpense(pr) {
  const { data: exp } = await getClient()
    .from('expenses')
    .select('id, status')
    .eq('source_type', 'purchase_order')
    .eq('source_id', pr.id)
    .maybeSingle();
  if (exp && exp.status !== 'cancelled') {
    await expenseRepo.updateExpense(exp.id, { status: 'cancelled' });
    return exp.id;
  }
  return null;
}

// PR P-1A-B: status 도메인 화이트리스트.
//   1-A 시점 활성: pending / approved / ordered / rejected
//   1-A 시점 미활성 (코드만 등록 — 1-D 에서 UI 활성, 마이그레이션 재실행 불필요): reviewed / arrived
const ALLOWED_STATUSES = ['pending', 'reviewed', 'approved', 'ordered', 'arrived', 'rejected'];
const ALLOWED_UNITS = ['개', '박스', '세트'];

// snapshot 표준화 — purchase_requests row → 핵심 필드만 (raw body / token / secret 부재)
function prSnapshot(r) {
  if (!r) return null;
  return {
    id:               r.id,
    status:           r.status,
    product_name:     r.product_name,
    sku:              r.sku,
    unit:             r.unit,
    quantity:         r.quantity,
    estimated_price:  r.estimated_price,
    priority:         r.priority,
    requested_by:     r.requested_by,
    decision_by:      r.decision_by,
    decision_at:      r.decision_at,
    rejection_reason: r.rejection_reason,
    ordered_by:       r.ordered_by,
    ordered_at:       r.ordered_at,
    deleted_at:       r.deleted_at,
    deleted_by:       r.deleted_by,
    updated_at:       r.updated_at,
  };
}

// PR P-1A-B 도우미: req.body 의 spec 필드를 DB 컬럼으로 정규화.
//   - normalize 결과 비어있으면 normalized_product_name=null (검색 인덱스 보호)
//   - unit 화이트리스트 외 → '개' 폴백 (사장님 짚은점 5: 빈 값 일관성)
function normalizePurchaseInput(body, { isCreate } = {}) {
  const out = {};
  if (body.productName !== undefined || isCreate) {
    const trimmed = String(body.productName || '').trim();
    out.product_name = trimmed;
    const norm = dupDetector.normalize(trimmed);
    out.normalized_product_name = norm || null;
  }
  if (body.sku !== undefined) {
    const t = String(body.sku || '').trim();
    out.sku = t || null;
  }
  if (body.unit !== undefined) {
    const u = String(body.unit || '').trim();
    out.unit = ALLOWED_UNITS.includes(u) ? u : '개';
  }
  if (body.currentStock !== undefined) {
    const n = Number(body.currentStock);
    out.current_stock = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  if (body.memo !== undefined) {
    const m = String(body.memo || '').trim();
    out.memo = m || null;
  }
  return out;
}

const router = express.Router();

const REJECT_LABELS = {
  out_of_stock: '품절',
  discontinued: '단종',
  budget: '예산 부족',
  price_review: '가격 검토 필요',
  other: '기타',
};

const ATT_BUCKET = 'task-attachments';
const MAX_ATT_BYTES = 15 * 1024 * 1024;          // 압축 전 원본 기준 15MB (iPhone HEIC·고화질 JPEG 수용)
const MAX_ATT_PER_REQUEST = 5;
const ALLOWED_IMAGE_MIME = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;

const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATT_BYTES, files: MAX_ATT_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.test(file.mimetype)) return cb(null, true);
    cb(new Error(`이미지만 업로드 가능합니다 (현재: ${file.mimetype})`));
  },
});

function sanitizeFileName(name) {
  return (name || 'image')
    .replace(/[\\/\x00-\x1f]/g, '_')
    .slice(0, 150);
}

/** 이미지를 1600px 이내 + JPEG q=85로 압축. HEIC 실패 시 원본 fallback. */
async function compressImage(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      sizeBytes: info.size,
      width: info.width,
      height: info.height,
    };
  } catch (e) {
    // HEIC 등 Sharp 미지원 형식 → 원본 그대로 업로드
    return { buffer, mimeType: null, extension: null, sizeBytes: buffer.length, width: null, height: null };
  }
}

function canModifyAttachment(user, request) {
  if (user.isAdmin) return true;
  // 본인 요청이면 status 무관 첨부 허용 (pending 외 ordered·approved 단계에서도 영수증·증빙 추가 가능)
  return request.requested_by === user.id;
}

// GET /api/purchase-requests — 전 직원 조회 (scope=mine 시 본인 요청만)
router.get('/', async (req, res) => {
  try {
    const data = await repo.listRequests({
      user: req.user,
      status: req.query.status,
      scope: req.query.scope,
      statusGroup: req.query.statusGroup,
    });
    // attachmentCount 주입 (N+1 방지)
    const ids = (data || []).map(r => r.id);
    const countMap = await attRepo.listByRequests(ids);
    for (const row of data || []) row.attachment_count = countMap[row.id] || 0;
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/purchase-requests/stats (admin)
router.get('/stats', requireAdmin, async (req, res) => {
  try { res.json(await repo.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/purchase-requests/duplicate-check?productName=&sku=&excludeId=&days=
// PR P-1A-B: 폼 입력 중 실시간 중복 검사. 본인 row 는 excludeId 로 제외 (사장님 짚은점 3).
//   응답: { data: [...], windowDays }. soft-deleted 는 결과에 절대 포함 X (사장님 짚은점 4).
//   rate limit: 상위 미들웨어 (server.js /api/ 300/15min) 적용. 별도 추가 X.
router.get('/duplicate-check', async (req, res) => {
  try {
    const productName = req.query.productName ? String(req.query.productName) : null;
    const sku = req.query.sku ? String(req.query.sku) : null;
    const excludeId = req.query.excludeId ? parseInt(req.query.excludeId, 10) : undefined;
    const days = req.query.days ? Math.min(parseInt(req.query.days, 10) || 7, 90) : 7;
    const data = await dupDetector.findDuplicates({ productName, sku, excludeId, days });
    res.json({ data, windowDays: days });
  } catch (e) {
    console.error('[purchase-requests] duplicate-check error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/purchase-requests/insights — 재고 추천 (전 직원 열람)
router.get('/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 90;
    const data = await repo.getRecommendations({ days });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/purchase-requests                                   [audit: purchase_request_create]
router.post('/', async (req, res) => {
  // pre-validation (audit row 생성 전)
  const { productName, quantity, estimatedPrice, priority, reason } = req.body || {};
  if (!productName || !productName.trim()) return res.status(400).json({ error: '상품명을 입력하세요' });
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: '수량은 1 이상이어야 합니다' });

  const executedBy = req.user.id;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_create',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         null,             // post 에 채움
      beforeSnapshot:   null,             // CREATE
      rollbackMethod:   'manual',
      rollbackHint:     '생성된 purchase_requests row 를 확인 후 취소/삭제 정책에 따라 수동 처리하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_create):', {
      actionName: 'purchase_request_create', executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const norm = normalizePurchaseInput(req.body || {}, { isCreate: true });
    const created = await repo.createRequest({
      ...norm,
      quantity: qty,
      estimated_price: estimatedPrice != null && estimatedPrice !== '' ? String(estimatedPrice) : null,
      priority: priority === 'urgent' ? 'urgent' : 'normal',
      reason: reason?.trim() || null,
      requested_by: executedBy,
    });

    if (!req.user.isAdmin) {
      const body = `${req.user.displayName} · ${created.product_name} × ${created.quantity}`;
      await notifyAdmins({
        type: 'purchase_requested',
        title: created.priority === 'urgent' ? '[긴급] 새 발주 요청' : '새 발주 요청',
        body,
        linkUrl: '/?page=orders',
        relatedType: 'purchase_request',
        relatedId: created.id,
      });
      const adminIds = await getAdminIds();
      sseHub.sendToMany(adminIds, { type: 'purchase_requested', title: body, linkUrl: '/?page=orders' });
    }

    safetyExec.updateRun(run.id, {
      status:        'succeeded',
      targetId:      created.id,
      afterSnapshot: prSnapshot(created),
    });
    res.json({ data: created });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/purchase-requests/completed — 사후 구매 원클릭 기록 (2026-08-08 사장님 지침)
//   이미 결제한 소액/일상 구매를 발주 요청/승인 절차 없이 바로 완료 상태로 등록.
//   자동으로 status='ordered' + expense 자동생성. 전 직원 사용 가능.
//
//   필수: productName, quantity, actualPrice, paymentMethod
//   선택: purchasedAt(기본 now), cardLast4, sku, memo, currentStock
router.post('/completed', async (req, res) => {
  const b = req.body || {};
  if (!b.productName || !String(b.productName).trim()) return res.status(400).json({ error: '상품명을 입력하세요' });
  const qty = Number(b.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: '수량은 1 이상이어야 합니다' });
  const actualPrice = Number(b.actualPrice);
  if (!Number.isFinite(actualPrice) || actualPrice <= 0) return res.status(400).json({ error: '실제 구매금액은 0 이상 숫자여야 합니다' });
  if (!b.paymentMethod || !String(b.paymentMethod).trim()) return res.status(400).json({ error: '결제수단을 선택하세요' });

  const executedBy = req.user.id;

  // pre-action audit
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_completed_directly',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         null,
      beforeSnapshot:   null,
      rollbackMethod:   'manual',
      rollbackHint:     '사후 기록한 발주 row 를 확인 후 취소/삭제 정책에 따라 수동 처리하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] audit failed (completed_directly):', auditErr.message);
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const norm = normalizePurchaseInput(b, { isCreate: true });
    const now = new Date().toISOString();
    const purchasedAt = b.purchasedAt ? new Date(b.purchasedAt).toISOString() : now;

    const created = await repo.createRequest({
      ...norm,
      quantity: qty,
      estimated_price: null,
      priority: 'normal',
      reason: b.memo?.trim() || '사후 구매 기록',
      requested_by: executedBy,
      // 승인 스킵 — 바로 ordered 로 저장
      status: 'ordered',
      decision_by: executedBy,
      decision_at: now,
      ordered_by: executedBy,
      ordered_at: now,
      // 실제 구매 정보 (사장님 지침 필수)
      actual_price: actualPrice,
      purchased_at: purchasedAt,
      payment_method: String(b.paymentMethod).slice(0, 50),
      card_last4: b.cardLast4 ? String(b.cardLast4).replace(/\D/g, '').slice(-4) : null,
    });

    // 지출 자동생성
    let expenseId = null;
    try {
      expenseId = await autoCreateExpense(created, executedBy);
      if (expenseId) await repo.updateRequest(created.id, { expense_id: expenseId });
    } catch (expErr) {
      console.error('[purchase-requests] 사후구매 지출 자동생성 실패:', expErr.message);
    }

    safetyExec.updateRun(run.id, {
      status: 'succeeded',
      targetId: created.id,
      afterSnapshot: prSnapshot({ ...created, expense_id: expenseId }),
    });
    res.json({ data: { ...created, expense_id: expenseId }, expenseId });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/purchase-requests/:id — 요청 내용 수정                  [audit: purchase_request_update]
//  - 사장: 언제든 수정 가능
//  - 요청자 본인: status=pending 일 때만
//  - 그 외 직원: 금지
router.patch('/:id', async (req, res) => {
  // pre-validation (audit row 생성 전)
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  let existing;
  try {
    existing = await repo.getRequest(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });

  const isOwner = existing.requested_by === req.user.id;
  if (!req.user.isAdmin && !isOwner) {
    return res.status(403).json({ error: '본인 요청만 수정할 수 있습니다' });
  }
  if (!req.user.isAdmin && existing.status !== 'pending') {
    return res.status(400).json({ error: '이미 처리된 요청은 수정할 수 없습니다 (관리자 문의)' });
  }

  const { productName, quantity, estimatedPrice, priority, reason } = req.body || {};
  // 빈 productName → 400 으로 거부 (normalizePurchaseInput 는 productName 검증 없이 normalize 만 함)
  if (productName !== undefined && !String(productName).trim()) {
    return res.status(400).json({ error: '상품명을 입력하세요' });
  }
  const updates = normalizePurchaseInput(req.body || {}, { isCreate: false });
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: '수량은 1 이상이어야 합니다' });
    updates.quantity = qty;
  }
  if (estimatedPrice !== undefined) {
    updates.estimated_price = estimatedPrice !== null && estimatedPrice !== '' ? String(estimatedPrice) : null;
  }
  if (priority !== undefined) {
    updates.priority = priority === 'urgent' ? 'urgent' : 'normal';
  }
  if (reason !== undefined) {
    updates.reason = String(reason).trim() || null;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '변경할 내용이 없습니다' });
  }

  const executedBy = req.user.id;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_update',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         id,
      beforeSnapshot:   prSnapshot(existing),
      rollbackMethod:   'manual',
      rollbackHint:     'input_snapshot 을 참고해 purchase_requests row 를 수동 복구하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_update):', {
      actionName: 'purchase_request_update', id, executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const updated = await repo.updateRequest(id, updates);
    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: prSnapshot(updated) });
    res.json({ data: updated });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/purchase-requests/:id/approve                      [audit: purchase_request_approve]
router.patch('/:id/approve', requireAdmin, async (req, res) => {
  // pre-validation (audit row 생성 전)
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  let existing;
  try {
    existing = await repo.getRequest(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
  if (existing.status !== 'pending') return res.status(400).json({ error: '이미 처리된 요청입니다' });

  const executedBy = req.user.id;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_approve',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         id,
      beforeSnapshot:   prSnapshot(existing),
      rollbackMethod:   'auto',
      rollbackHint:     '자동 되돌리기: 상태 변경 전 snapshot 의 허용 필드로 purchase_requests row 를 복구합니다. 실제 외부 주문/결제는 별도 확인하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_approve):', {
      actionName: 'purchase_request_approve', id, executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const updated = await repo.updateRequest(id, {
      status: 'approved',
      decision_by: executedBy,
      decision_at: new Date().toISOString(),
      rejection_reason: null,
      rejection_note: null,
    });

    const aBody = `${existing.product_name} × ${existing.quantity} — 구매 승인`;
    await notify({
      recipientId: existing.requested_by,
      type: 'purchase_approved',
      title: '발주 승인됨',
      body: aBody,
      linkUrl: '/?page=orders',
      relatedType: 'purchase_request',
      relatedId: id,
    });
    sseHub.sendTo(existing.requested_by, { type: 'purchase_approved', title: aBody, linkUrl: '/?page=orders' });

    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: prSnapshot(updated) });
    res.json({ data: updated });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/purchase-requests/:id/reject                       [audit: purchase_request_reject]
router.patch('/:id/reject', requireAdmin, async (req, res) => {
  // pre-validation (audit row 생성 전)
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  const { reason, note } = req.body || {};
  if (!reason || !REJECT_LABELS[reason]) return res.status(400).json({ error: '반려 사유를 선택하세요' });

  let existing;
  try {
    existing = await repo.getRequest(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
  if (existing.status !== 'pending') return res.status(400).json({ error: '이미 처리된 요청입니다' });

  const executedBy = req.user.id;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_reject',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         id,
      beforeSnapshot:   prSnapshot(existing),
      rollbackMethod:   'auto',
      rollbackHint:     '자동 되돌리기: 상태 변경 전 snapshot 의 허용 필드로 purchase_requests row 를 복구합니다. 실제 외부 주문/결제는 별도 확인하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_reject):', {
      actionName: 'purchase_request_reject', id, executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    const updated = await repo.updateRequest(id, {
      status: 'rejected',
      decision_by: executedBy,
      decision_at: new Date().toISOString(),
      rejection_reason: reason,
      rejection_note: note?.trim() || null,
    });

    const rBody = `${existing.product_name} — ${REJECT_LABELS[reason]}${note ? ': ' + note : ''}`;
    await notify({
      recipientId: existing.requested_by,
      type: 'purchase_rejected',
      title: '발주 반려됨',
      body: rBody,
      linkUrl: '/?page=orders',
      relatedType: 'purchase_request',
      relatedId: id,
    });
    sseHub.sendTo(existing.requested_by, { type: 'purchase_rejected', title: rBody, linkUrl: '/?page=orders' });

    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: prSnapshot(updated) });
    res.json({ data: updated });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/purchase-requests/:id/order — 주문 완료 체크 (전 직원)   [audit: purchase_request_ordered]
// approved → ordered 만 허용. ordered_by/ordered_at 기록.
router.patch('/:id/order', async (req, res) => {
  // pre-validation (audit row 생성 전)
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  let existing;
  try {
    existing = await repo.getRequest(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
  if (existing.status !== 'approved') {
    return res.status(400).json({ error: '승인된 요청만 주문완료 처리할 수 있습니다' });
  }

  const executedBy = req.user.id;

  // pre-action audit (strict)
  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_ordered',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         id,
      beforeSnapshot:   prSnapshot(existing),
      rollbackMethod:   'auto',
      rollbackHint:     '자동 되돌리기: 상태 변경 전 snapshot 의 허용 필드로 purchase_requests row 를 복구합니다. 실제 외부 주문/결제는 별도 확인하세요.',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_ordered):', {
      actionName: 'purchase_request_ordered', id, executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  // 2026-08-08 사장님 지침: 구매완료 시 필수 필드 (actual_price / purchased_at / payment_method)
  //   card_last4 는 선택. body 없으면 기존 값 유지 (호환성).
  const b = req.body || {};
  const actualPrice = b.actualPrice != null && b.actualPrice !== ''
    ? Number(b.actualPrice) : null;
  if (actualPrice != null && (!Number.isFinite(actualPrice) || actualPrice <= 0)) {
    safetyExec.updateRun(run.id, { status: 'cancelled', errorCode: 'invalid_actual_price', errorMessage: 'actual_price must be > 0' });
    return res.status(400).json({ error: '실제 구매금액은 0 이상 숫자여야 합니다' });
  }

  try {
    const patch = {
      status: 'ordered',
      ordered_by: executedBy,
      ordered_at: new Date().toISOString(),
    };
    if (actualPrice != null) patch.actual_price = actualPrice;
    if (b.purchasedAt) patch.purchased_at = new Date(b.purchasedAt).toISOString();
    else patch.purchased_at = new Date().toISOString();
    if (b.paymentMethod) patch.payment_method = String(b.paymentMethod).slice(0, 50);
    if (b.cardLast4) patch.card_last4 = String(b.cardLast4).replace(/\D/g, '').slice(-4);

    const updated = await repo.updateRequest(id, patch);

    // 지출 자동생성 (actual_price 있을 때만)
    let expenseId = null;
    if (Number.isFinite(Number(updated.actual_price))) {
      try {
        expenseId = await autoCreateExpense(updated, executedBy);
        if (expenseId) {
          await repo.updateRequest(id, { expense_id: expenseId });
        }
      } catch (expErr) {
        // 지출 생성 실패해도 발주 상태는 유지 (사용자 명확 알림)
        console.error('[purchase-requests] 지출 자동생성 실패:', expErr.message);
      }
    }

    // 요청자에게 알림 (주문자 본인이면 생략)
    if (existing.requested_by && existing.requested_by !== executedBy) {
      const oBody = `${existing.product_name} × ${existing.quantity} — ${req.user.displayName} 주문`;
      await notify({
        recipientId: existing.requested_by,
        type: 'purchase_ordered',
        title: '발주 주문완료',
        body: oBody,
        linkUrl: '/?page=orders',
        relatedType: 'purchase_request',
        relatedId: id,
      });
      sseHub.sendTo(existing.requested_by, { type: 'purchase_ordered', title: oBody, linkUrl: '/?page=orders' });
    }

    safetyExec.updateRun(run.id, { status: 'succeeded', afterSnapshot: prSnapshot({ ...updated, expense_id: expenseId }) });
    res.json({ data: { ...updated, expense_id: expenseId }, expenseId });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/purchase-requests/:id/unorder — 주문완료 되돌리기
// ordered → approved. 본인(=ordered_by) 또는 admin만.
router.patch('/:id/unorder', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (existing.status !== 'ordered') {
      return res.status(400).json({ error: '주문완료 상태만 되돌릴 수 있습니다' });
    }
    if (!req.user.isAdmin && existing.ordered_by !== req.user.id) {
      return res.status(403).json({ error: '본인이 체크한 항목만 되돌릴 수 있습니다' });
    }

    const updated = await repo.updateRequest(id, {
      status: 'approved',
      ordered_by: null,
      ordered_at: null,
    });

    // 2026-08-08 사장님 지침 5: 취소 시 expense 삭제 X → status='cancelled' 마킹
    let cancelledExpenseId = null;
    try {
      cancelledExpenseId = await cancelLinkedExpense(existing);
    } catch (expErr) {
      console.error('[purchase-requests] unorder 지출 취소 실패:', expErr.message);
    }

    res.json({ data: updated, cancelledExpenseId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/purchase-requests/:id  — PR P-1A-B: hard → soft delete   [audit: purchase_request_delete]
//  - 사장: 언제든 삭제 가능 (모든 status)
//  - 요청자 본인: 모든 status (spec 변경 — 모든 직원 발주 삭제 권한)
//  - 그 외: 금지
//  - soft delete: deleted_at + deleted_by set. 신뢰도/이력 분석용으로 row 보존.
//  - 첨부 파일 storage 는 정리 X (이력 추적). cleanup 은 후속 단계 (정기 재주기 작업 또는 수동).
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

  let existing;
  try {
    existing = await repo.getRequest(id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
  if (existing.deleted_at) return res.status(400).json({ error: '이미 삭제된 요청입니다' });

  const isOwner = existing.requested_by === req.user.id;
  if (!req.user.isAdmin && !isOwner) {
    return res.status(403).json({ error: '본인 요청만 삭제할 수 있습니다' });
  }

  const executedBy = req.user.id;

  let run;
  try {
    run = await safetyExec.runAction({
      actionName:       'purchase_request_delete',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable:      'purchase_requests',
      targetId:         id,
      beforeSnapshot:   prSnapshot(existing),
      rollbackMethod:   'manual',
      rollbackHint:     'soft delete 복구: UPDATE purchase_requests SET deleted_at=NULL, deleted_by=NULL WHERE id=...',
      status: 'pending',
    });
  } catch (auditErr) {
    console.error('[purchase-requests] runAction failed (purchase_request_delete):', {
      actionName: 'purchase_request_delete', id, executedBy, message: auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  try {
    await repo.softDeleteRequest(id, executedBy);
    safetyExec.updateRun(run.id, {
      status: 'succeeded',
      afterSnapshot: { id, deleted_at: new Date().toISOString(), deleted_by: executedBy },
    });
    res.json({ ok: true });
  } catch (e) {
    safetyExec.updateRun(run.id, { status: 'failed', errorCode: 'unknown', errorMessage: e.message });
    res.status(500).json({ error: e.message });
  }
});


// ─── 이미지 첨부 엔드포인트 ───

// POST /api/purchase-requests/:id/attachments — 이미지 업로드 (multipart, files[])
router.post('/:id/attachments', (req, res, next) => {
  uploadAttachments.array('files', MAX_ATT_PER_REQUEST)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `이미지가 너무 큽니다 (최대 ${MAX_ATT_BYTES / 1024 / 1024}MB)`
        : err.code === 'LIMIT_FILE_COUNT'
        ? `이미지가 너무 많습니다 (최대 ${MAX_ATT_PER_REQUEST}개)`
        : err.message || '업로드 오류';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const files = req.files || [];
  const uploadedPaths = [];

  try {
    if (files.length === 0) return res.status(400).json({ error: '업로드할 이미지가 없습니다' });

    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (!canModifyAttachment(req.user, existing)) {
      return res.status(403).json({ error: '이미지 첨부 권한이 없습니다 (본인 대기중 요청 또는 관리자)' });
    }

    const currentCount = await attRepo.countByRequest(id);
    if (currentCount + files.length > MAX_ATT_PER_REQUEST) {
      return res.status(400).json({
        error: `이미지는 최대 ${MAX_ATT_PER_REQUEST}장까지 (현재 ${currentCount}장)`,
      });
    }

    const storage = getClient().storage.from(ATT_BUCKET);
    const created = [];

    for (const f of files) {
      const processed = await compressImage(f.buffer);
      const rand = crypto.randomBytes(6).toString('hex');
      const originalBase = sanitizeFileName(f.originalname).replace(/\.[^./]+$/, '');
      const ext = processed.extension || (f.originalname.match(/\.([^.]+)$/) || [, 'bin'])[1];
      const path = `purchase-request-${id}/${req.user.id}/${Date.now()}-${rand}-${originalBase}.${ext}`;

      const { error: upErr } = await storage.upload(path, processed.buffer, {
        contentType: processed.mimeType || f.mimetype,
        upsert: false,
      });
      if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message}`);
      uploadedPaths.push(path);

      const att = await attRepo.create({
        requestId: id,
        uploadedBy: req.user.id,
        filePath: path,
        fileName: f.originalname,
        mimeType: processed.mimeType || f.mimetype,
        sizeBytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
      });
      created.push(att);
    }

    res.json({ data: created, uploaded: created.length });
  } catch (e) {
    // rollback: 이번 요청에서 업로드한 파일들 제거
    if (uploadedPaths.length > 0) {
      try { await getClient().storage.from(ATT_BUCKET).remove(uploadedPaths); } catch {}
    }
    res.status(500).json({ error: e.message });
  }
});

// GET /api/purchase-requests/:id/attachments — 첨부 목록
router.get('/:id/attachments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    const data = await attRepo.list(id);
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/purchase-requests/:id/attachments/:attId/url — 서명 URL (300s)
router.get('/:id/attachments/:attId/url', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);
    const att = await attRepo.getById(attId);
    if (!att || att.requestId !== id) return res.status(404).json({ error: '첨부를 찾을 수 없습니다' });

    const { data, error } = await getClient().storage
      .from(ATT_BUCKET)
      .createSignedUrl(att.filePath, 300, { download: att.fileName });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: att.fileName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/purchase-requests/:id/attachments/:attId — 첨부 개별 삭제
router.delete('/:id/attachments/:attId', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const attId = parseInt(req.params.attId, 10);

    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (!canModifyAttachment(req.user, existing)) {
      return res.status(403).json({ error: '삭제 권한이 없습니다' });
    }

    const att = await attRepo.getById(attId);
    if (!att || att.requestId !== id) return res.status(404).json({ error: '첨부를 찾을 수 없습니다' });

    try {
      await getClient().storage.from(ATT_BUCKET).remove([att.filePath]);
    } catch (e) {
      console.warn('[purchase-requests] storage remove failed:', e.message);
    }
    await attRepo.remove(attId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
