/**
 * 발주 요청 API (/api/purchase-requests)
 * 주의: 레거시 /api/orders/*는 주문(판매) 관리용이라 이름 충돌을 피하기 위해 purchase-requests 경로 사용.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/purchaseRequestRepository');
const attRepo = require('../../db/purchaseRequestAttachmentRepository');
const { notify, notifyAdmins } = require('../../services/notificationService');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

const REJECT_LABELS = {
  out_of_stock: '품절',
  discontinued: '단종',
  budget: '예산 부족',
  price_review: '가격 검토 필요',
  other: '기타',
};

const ATT_BUCKET = 'task-attachments';
const MAX_ATT_BYTES = 5 * 1024 * 1024;           // 압축 전 원본 기준 5MB
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
  return request.requested_by === user.id && request.status === 'pending';
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

// GET /api/purchase-requests/insights — 재고 추천 (전 직원 열람)
router.get('/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 90;
    const data = await repo.getRecommendations({ days });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/purchase-requests
router.post('/', async (req, res) => {
  try {
    const { productName, quantity, estimatedPrice, priority, reason } = req.body || {};
    if (!productName || !productName.trim()) return res.status(400).json({ error: '상품명을 입력하세요' });
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: '수량은 1 이상이어야 합니다' });

    const created = await repo.createRequest({
      product_name: productName.trim(),
      quantity: qty,
      estimated_price: estimatedPrice != null && estimatedPrice !== '' ? String(estimatedPrice) : null,
      priority: priority === 'urgent' ? 'urgent' : 'normal',
      reason: reason?.trim() || null,
      requested_by: req.user.id,
    });

    if (!req.user.isAdmin) {
      await notifyAdmins({
        type: 'purchase_requested',
        title: created.priority === 'urgent' ? '[긴급] 새 발주 요청' : '새 발주 요청',
        body: `${req.user.displayName} · ${created.product_name} × ${created.quantity}`,
        linkUrl: '/?page=orders',
        relatedType: 'purchase_request',
        relatedId: created.id,
      });
    }

    res.json({ data: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/purchase-requests/:id — 요청 내용 수정
//  - 사장: 언제든 수정 가능
//  - 요청자 본인: status=pending 일 때만
//  - 그 외 직원: 금지
router.patch('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });

    const isOwner = existing.requested_by === req.user.id;
    if (!req.user.isAdmin && !isOwner) {
      return res.status(403).json({ error: '본인 요청만 수정할 수 있습니다' });
    }
    if (!req.user.isAdmin && existing.status !== 'pending') {
      return res.status(400).json({ error: '이미 처리된 요청은 수정할 수 없습니다 (관리자 문의)' });
    }

    const { productName, quantity, estimatedPrice, priority, reason } = req.body || {};
    const updates = {};
    if (productName !== undefined) {
      const trimmed = String(productName).trim();
      if (!trimmed) return res.status(400).json({ error: '상품명을 입력하세요' });
      updates.product_name = trimmed;
    }
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

    const updated = await repo.updateRequest(id, updates);
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/purchase-requests/:id/approve
router.patch('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (existing.status !== 'pending') return res.status(400).json({ error: '이미 처리된 요청입니다' });

    const updated = await repo.updateRequest(id, {
      status: 'approved',
      decision_by: req.user.id,
      decision_at: new Date().toISOString(),
      rejection_reason: null,
      rejection_note: null,
    });

    await notify({
      recipientId: existing.requested_by,
      type: 'purchase_approved',
      title: '발주 승인됨',
      body: `${existing.product_name} × ${existing.quantity} — 구매 승인`,
      linkUrl: '/?page=orders',
      relatedType: 'purchase_request',
      relatedId: id,
    });

    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/purchase-requests/:id/reject
router.patch('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason, note } = req.body || {};
    if (!reason || !REJECT_LABELS[reason]) return res.status(400).json({ error: '반려 사유를 선택하세요' });

    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (existing.status !== 'pending') return res.status(400).json({ error: '이미 처리된 요청입니다' });

    const updated = await repo.updateRequest(id, {
      status: 'rejected',
      decision_by: req.user.id,
      decision_at: new Date().toISOString(),
      rejection_reason: reason,
      rejection_note: note?.trim() || null,
    });

    await notify({
      recipientId: existing.requested_by,
      type: 'purchase_rejected',
      title: '발주 반려됨',
      body: `${existing.product_name} — ${REJECT_LABELS[reason]}${note ? ': ' + note : ''}`,
      linkUrl: '/?page=orders',
      relatedType: 'purchase_request',
      relatedId: id,
    });

    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/purchase-requests/:id/order — 주문 완료 체크 (전 직원)
// approved → ordered 만 허용. ordered_by/ordered_at 기록.
router.patch('/:id/order', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });
    if (existing.status !== 'approved') {
      return res.status(400).json({ error: '승인된 요청만 주문완료 처리할 수 있습니다' });
    }

    const updated = await repo.updateRequest(id, {
      status: 'ordered',
      ordered_by: req.user.id,
      ordered_at: new Date().toISOString(),
    });

    // 요청자에게 알림 (주문자 본인이면 생략)
    if (existing.requested_by && existing.requested_by !== req.user.id) {
      await notify({
        recipientId: existing.requested_by,
        type: 'purchase_ordered',
        title: '발주 주문완료',
        body: `${existing.product_name} × ${existing.quantity} — ${req.user.displayName} 주문`,
        linkUrl: '/?page=orders',
        relatedType: 'purchase_request',
        relatedId: id,
      });
    }

    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/purchase-requests/:id — admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getRequest(id);
    if (!existing) return res.status(404).json({ error: '발주 요청을 찾을 수 없습니다' });

    // 스토리지 파일 정리 (CASCADE는 DB row만 삭제)
    try {
      const atts = await attRepo.list(id);
      if (atts.length > 0) {
        await getClient().storage.from(ATT_BUCKET).remove(atts.map(a => a.filePath));
      }
    } catch (e) {
      // 정리 실패해도 DB 삭제는 진행 (파일이 이미 없을 수도 있음)
      console.warn('[purchase-requests] attachment cleanup failed:', e.message);
    }

    await repo.deleteRequest(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
