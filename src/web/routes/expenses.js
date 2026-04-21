/**
 * 지출 관리 API (/api/expenses)
 *
 * 권한 모델 (C):
 *   - 모든 로그인 직원: 지출 등록 + 본인 등록분 조회/편집
 *   - admin + can_manage_finance=true 직원: 전체 조회/편집/삭제/카테고리 확정
 *   - 삭제는 재무 접근 권한자만 (admin 또는 can_manage_finance)
 *
 * 현재 범위 (Phase 1 Day 1): 수동 지출 CRUD + 월별 합계 + 카테고리 목록.
 */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const repo = require('../../db/expenseRepository');
const { CATEGORIES, normalize } = require('../../services/expenseCategories');
const { getClient } = require('../../db/supabaseClient');
const { parseExpenseCsvBuffer } = require('../../services/expenseCsvParser');
const { suggestCategories } = require('../../services/expenseCategorizer');

const router = express.Router();

// CSV 업로드 memoryStorage (10MB까지)
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

const RECEIPT_BUCKET = 'expense-receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const ALLOWED_RECEIPT_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_RECEIPT_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`));
  },
});

function sanitizeFileName(name) {
  return (name || 'receipt').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
}

// 본인 등록분만 필터할지 여부. finance 권한자는 전체, 아니면 본인 것만.
function ownershipFilter(req) {
  if (req.user?.canManageFinance) return {};
  return { createdBy: req.user.id };
}

// GET /api/expenses/categories — UI 드롭다운 + 색상 (전 사용자)
router.get('/categories', (req, res) => {
  res.json({ categories: CATEGORIES });
});

// GET /api/expenses/cards — 과거 사용한 카드 뒷자리 목록 (드롭다운용, 본인 스코프)
router.get('/cards', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    // 재무 권한자는 전체, 아니면 본인 것만
    const filter = req.user.canManageFinance ? {} : { createdBy: req.user.id };
    const cards = await repo.listDistinctCards(filter);
    res.json({ cards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses — 목록 (본인 것 or 전체)
router.get('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.listExpenses({
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      category: req.query.category || undefined,
      source: req.query.source || undefined,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
      ...ownershipFilter(req),
    });
    res.json({ data, scope: req.user.canManageFinance ? 'all' : 'own' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/summary?month=YYYY-MM — 동일한 권한 범위
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

// GET /api/expenses/:id — 본인 것 or finance
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const data = await repo.getExpense(id);
    if (!data) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && data.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출만 조회할 수 있습니다' });
    }
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expenses — 전 직원 등록 가능. 발주한 본인이 영수증 정보 입력, 재무가 확인.
router.post('/', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const {
      paidAt, amount, currency, category, merchant, memo, cardLast4, taskId,
    } = req.body || {};
    if (!paidAt) return res.status(400).json({ error: '결제일(paidAt)을 입력하세요' });
    const num = Number(amount);
    if (!Number.isFinite(num) || num === 0) return res.status(400).json({ error: '금액을 입력하세요' });
    const created = await repo.createExpense({
      paidAt, amount: num, currency, category, merchant, memo, cardLast4, taskId,
      source: 'manual',
      createdBy: req.user.id,
    });
    // 머천트-카테고리 학습 캐시 (재무 권한자가 선택한 값만 confidence 100으로 신뢰)
    if (created.merchant) {
      await repo.saveCachedCategory({
        merchant: created.merchant,
        category: created.category,
        confidence: req.user.canManageFinance ? 100 : 60,
        createdBy: req.user.id,
      });
    }
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/expenses/:id — 본인 등록분은 본인 편집 가능, 전체는 finance 권한자
router.patch('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출만 수정할 수 있습니다' });
    }
    const updated = await repo.updateExpense(id, req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/expenses/csv — 카드명세서 파일 업로드 → 파싱 + AI 카테고리 제안 반환
// 실제 DB insert는 /csv/confirm에서. 재무 권한자만.
router.post('/csv', (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 권한자만 CSV 업로드 가능합니다' });
  csvUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? '파일이 너무 큽니다 (최대 10MB)' : err.message || '업로드 오류';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });
    const parsed = parseExpenseCsvBuffer(req.file.buffer);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const suggested = await suggestCategories(parsed.rows);

    // 중복 체크 — 같은 (paidAt + amount + merchant)가 이미 있으면 duplicate 표시
    const existing = await repo.listExpenses({
      from: suggested.reduce((min, r) => !min || r.paidAt < min ? r.paidAt : min, null),
      to: suggested.reduce((max, r) => !max || r.paidAt > max ? r.paidAt : max, null),
      limit: 2000,
    });
    const seen = new Set(existing.map(e => `${e.paidAt}|${e.amount}|${(e.merchant || '').toLowerCase()}`));
    const rows = suggested.map((r, idx) => ({
      tempId: idx,
      paidAt: r.paidAt,
      amount: r.amount,
      currency: r.currency,
      merchant: r.merchant,
      memo: r.memo,
      cardLast4: r.cardLast4,
      suggestedCategory: r.suggestedCategory,
      categorySource: r.categorySource,
      duplicate: seen.has(`${r.paidAt}|${r.amount}|${(r.merchant || '').toLowerCase()}`),
    }));

    res.json({
      ok: true,
      filename: req.file.originalname,
      totalRows: rows.length,
      duplicates: rows.filter(r => r.duplicate).length,
      headerRow: parsed.headerRow,
      mapping: parsed.mapping,
      rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expenses/csv/confirm — 미리보기에서 사용자가 편집한 행들을 bulk insert.
// 재무 권한자만. body: { rows: [{ paidAt, amount, currency, category, merchant, memo, cardLast4 }] }
router.post('/csv/confirm', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 권한자만 확정할 수 있습니다' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ error: '저장할 행이 없습니다' });

    const prepared = rows.map(r => ({
      paidAt: r.paidAt,
      amount: Number(r.amount),
      currency: (r.currency || 'KRW').toUpperCase(),
      category: normalize(r.category || '기타'),
      merchant: r.merchant || null,
      memo: r.memo || null,
      cardLast4: r.cardLast4 || null,
      source: 'csv',
      createdBy: req.user.id,
    })).filter(r => r.paidAt && Number.isFinite(r.amount) && r.amount > 0);

    if (prepared.length === 0) return res.status(400).json({ error: '유효한 행이 없습니다' });

    const inserted = await repo.bulkCreate(prepared);

    // 사용자가 확정한 merchant→category 매핑은 confidence 100으로 캐시 갱신
    const uniqueMap = new Map();
    for (const r of prepared) {
      if (r.merchant) uniqueMap.set(r.merchant, r.category);
    }
    for (const [merchant, category] of uniqueMap) {
      try { await repo.saveCachedCategory({ merchant, category, confidence: 100, createdBy: req.user.id }); } catch {}
    }

    res.json({ ok: true, insertedCount: inserted.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/expenses/:id/receipt — 영수증 업로드 (본인 것 or 재무)
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
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출에만 영수증을 첨부할 수 있습니다' });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ error: '파일이 없습니다' });

    const storage = getClient().storage.from(RECEIPT_BUCKET);
    const clean = sanitizeFileName(f.originalname);
    const rand = crypto.randomBytes(6).toString('hex');
    const newPath = `${id}/${Date.now()}-${rand}-${clean}`;

    const { error: upErr } = await storage.upload(newPath, f.buffer, {
      contentType: f.mimetype,
      upsert: false,
    });
    if (upErr) return res.status(500).json({ error: `Storage 업로드 실패: ${upErr.message}` });

    // 기존 영수증 있으면 제거
    if (existing.receiptPath) {
      try { await storage.remove([existing.receiptPath]); } catch {}
    }

    const updated = await repo.setReceipt(id, {
      path: newPath, name: clean, mime: f.mimetype, size: f.size,
    });
    res.json({ data: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id/receipt/url — signed URL (본인 or 재무)
router.get('/:id/receipt/url', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    if (!existing.receiptPath) return res.status(404).json({ error: '영수증이 없습니다' });

    const { data, error } = await getClient().storage.from(RECEIPT_BUCKET)
      .createSignedUrl(existing.receiptPath, 300, { download: existing.receiptName || 'receipt' });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: existing.receiptName, mime: existing.receiptMime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/expenses/:id/receipt — 영수증만 삭제 (본인 or 재무)
router.delete('/:id/receipt', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    if (existing.receiptPath) {
      try { await getClient().storage.from(RECEIPT_BUCKET).remove([existing.receiptPath]); } catch {}
    }
    await repo.clearReceipt(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/expenses/:id — 본인 등록분은 본인이 삭제 가능, 타인 것은 재무만.
router.delete('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!req.user.canManageFinance && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출만 삭제할 수 있습니다' });
    }
    // Storage 영수증도 함께 제거 (실패 무시)
    if (existing.receiptPath) {
      try { await getClient().storage.from(RECEIPT_BUCKET).remove([existing.receiptPath]); } catch {}
    }
    await repo.deleteExpense(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
