/**
 * 카드 매입 API (/api/inventory-purchases)
 *
 * 권한: 지출과 동일 — 모든 로그인 직원 본인 등록·편집, finance 권한자 전체 조회·삭제.
 * 매입 등록 시 자동으로 expenses 테이블에 '재료비' 지출 row가 생성됨 (expense_id FK로 연결).
 * 삭제/수정 시에도 연동 expense 동기화.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const repo = require('../../db/inventoryPurchaseRepository');
const { getClient } = require('../../db/supabaseClient');

const router = express.Router();

// 영수증 업로드는 expense-receipts 버킷을 재사용 (purchase-{id}/ 경로 접두)
const RECEIPT_BUCKET = 'expense-receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`));
  },
});

function sanitizeFileName(name) {
  return (name || 'receipt').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
}

function ownershipFilter(req) {
  if (req.user?.canManageFinance) return {};
  return { createdBy: req.user.id };
}

function canAccess(req, purchase) {
  if (!req.user) return false;
  if (req.user.canManageFinance) return true;
  return purchase.createdBy === req.user.id;
}

// GET /api/inventory-purchases — 목록
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.list({
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      seller: req.query.seller || undefined,
      paymentMethod: req.query.paymentMethod || undefined,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
      ...ownershipFilter(req),
    });
    res.json({ data, scope: req.user.canManageFinance ? 'all' : 'own' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory-purchases/sellers — 판매자 자동완성
router.get('/sellers', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.distinctSellers({ limit: 100 });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory-purchases/summary?month=YYYY-MM
router.get('/summary', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const now = new Date();
    const defMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : defMonth;
    const summary = await repo.summaryByMonth(month, ownershipFilter(req));
    res.json({ ...summary, scope: req.user.canManageFinance ? 'all' : 'own' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory-purchases/:id
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const data = await repo.getById(id);
    if (!data) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, data)) return res.status(403).json({ error: '권한이 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/inventory-purchases — 등록 (자동 expense 생성)
router.post('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const created = await repo.create({ ...req.body, createdBy: req.user.id });
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/inventory-purchases/:id — 본인 or finance
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, existing)) return res.status(403).json({ error: '권한이 없습니다' });
    const updated = await repo.update(id, req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/inventory-purchases/:id — 본인 or finance
router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, existing)) return res.status(403).json({ error: '권한이 없습니다' });
    // Storage 영수증 제거
    if (existing.receiptPath) {
      try { await getClient().storage.from(RECEIPT_BUCKET).remove([existing.receiptPath]); } catch {}
    }
    await repo.remove(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/inventory-purchases/:id/receipt — 영수증 업로드
router.post('/:id/receipt', (req, res, next) => {
  receiptUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `파일이 너무 큽니다 (최대 ${MAX_RECEIPT_BYTES / 1024 / 1024}MB)`
        : err.message || '업로드 오류';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, existing)) return res.status(403).json({ error: '권한이 없습니다' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: '파일이 없습니다' });

    const storage = getClient().storage.from(RECEIPT_BUCKET);
    const clean = sanitizeFileName(f.originalname);
    const rand = crypto.randomBytes(6).toString('hex');
    const newPath = `purchase-${id}/${Date.now()}-${rand}-${clean}`;

    const { error: upErr } = await storage.upload(newPath, f.buffer, {
      contentType: f.mimetype, upsert: false,
    });
    if (upErr) return res.status(500).json({ error: `Storage 업로드 실패: ${upErr.message}` });

    if (existing.receiptPath) {
      try { await storage.remove([existing.receiptPath]); } catch {}
    }

    const updated = await repo.setReceipt(id, { path: newPath, name: clean, mime: f.mimetype, size: f.size });
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/inventory-purchases/:id/receipt/url
router.get('/:id/receipt/url', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, existing)) return res.status(403).json({ error: '권한이 없습니다' });
    if (!existing.receiptPath) return res.status(404).json({ error: '영수증이 없습니다' });

    const { data, error } = await getClient().storage.from(RECEIPT_BUCKET)
      .createSignedUrl(existing.receiptPath, 300, { download: existing.receiptName || 'receipt' });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: existing.receiptName, mime: existing.receiptMime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/inventory-purchases/:id/receipt
router.delete('/:id/receipt', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getById(id);
    if (!existing) return res.status(404).json({ error: '매입을 찾을 수 없습니다' });
    if (!canAccess(req, existing)) return res.status(403).json({ error: '권한이 없습니다' });
    if (existing.receiptPath) {
      try { await getClient().storage.from(RECEIPT_BUCKET).remove([existing.receiptPath]); } catch {}
    }
    await repo.clearReceipt(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
