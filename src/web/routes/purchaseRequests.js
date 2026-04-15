/**
 * 발주 요청 API (/api/purchase-requests)
 * 주의: 레거시 /api/orders/*는 주문(판매) 관리용이라 이름 충돌을 피하기 위해 purchase-requests 경로 사용.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/purchaseRequestRepository');
const { notify, notifyAdmins } = require('../../services/notificationService');

const router = express.Router();

const REJECT_LABELS = {
  out_of_stock: '품절',
  discontinued: '단종',
  budget: '예산 부족',
  price_review: '가격 검토 필요',
  other: '기타',
};

// GET /api/purchase-requests — 전 직원 조회 (scope=mine 시 본인 요청만)
router.get('/', async (req, res) => {
  try {
    const data = await repo.listRequests({
      user: req.user,
      status: req.query.status,
      scope: req.query.scope,
    });
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

module.exports = router;
