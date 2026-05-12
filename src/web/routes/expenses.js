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

// multer 가 multipart 의 filename 을 latin1 로 디코드해서 한글이 깨지는 케이스 보정.
// utf8 로 재해석해서 정상이면 그 결과를 사용. 화면·DB 에 보일 표시용 이름.
function decodeOriginalName(name) {
  if (!name) return 'receipt';
  try {
    const utf8 = Buffer.from(name, 'latin1').toString('utf8');
    if (!utf8.includes('�')) return utf8;
  } catch {}
  return name;
}

function sanitizeFileName(name) {
  return decodeOriginalName(name).replace(/[\\/\x00-\x1f]/g, '_').slice(0, 150);
}

// Supabase Storage key 는 ASCII 안전문자만 허용 (한글·공백·특수문자 X).
// 표시용 이름과 별개로 storage path 용 ASCII slug 를 만든다.
function asciiSafeKey(name) {
  const decoded = decodeOriginalName(name);
  const m = decoded.match(/\.([a-zA-Z0-9]{1,8})$/);
  const ext = m ? '.' + m[1].toLowerCase() : '';
  const base = decoded
    .replace(/\.[a-zA-Z0-9]{1,8}$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return (base || 'file') + ext;
}

// 재무 권한 = admin OR users.can_manage_finance (사장님 요청 2026-05 — admin 도 항상 전체 가능)
function canFinance(req) {
  return !!(req.user?.isAdmin || req.user?.canManageFinance);
}

// 본인 등록분만 필터할지 여부. 재무 권한자(=admin 포함) 는 전체.
function ownershipFilter(req) {
  if (canFinance(req)) return {};
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
    const filter = canFinance(req) ? {} : { createdBy: req.user.id };
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
      hasReceipt: req.query.hasReceipt !== undefined ? req.query.hasReceipt : undefined,
      limit: Math.min(2000, parseInt(req.query.limit, 10) || 500),
      ...ownershipFilter(req),
    });
    res.json({ data, scope: canFinance(req) ? 'all' : 'own' });
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
    res.json({ ...summary, scope: canFinance(req) ? 'all' : 'own' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id — 본인 것 or finance
router.get('/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const data = await repo.getExpense(id);
    if (!data) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!canFinance(req) && data.createdBy !== req.user.id) {
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
        confidence: canFinance(req) ? 100 : 60,
        createdBy: req.user.id,
      });
    }
    // 재무·관리자에게 실시간 SSE — 사무실에서 누가 지출 등록했는지 즉시 인지
    try {
      const sseHub = require('../../services/sseHub');
      const { getAdminIds } = require('../../services/notificationService');
      const adminIds = await getAdminIds();
      const recipients = adminIds.filter(id => id !== req.user.id); // 본인 빼고
      const fmtAmt = `${created.currency || 'KRW'} ${Math.round(Math.abs(created.amount)).toLocaleString()}`;
      sseHub.sendToMany(recipients, {
        type: 'expense_created',
        title: `${req.user.displayName || '직원'} · ${created.category || '미분류'} · ${fmtAmt}`,
        linkUrl: '/?page=expenses',
      });
    } catch (e) { console.warn('[expense SSE]', e.message); }

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
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
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
  if (!canFinance(req)) return res.status(403).json({ error: '재무 권한자만 CSV 업로드 가능합니다' });
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
    if (!canFinance(req)) return res.status(403).json({ error: '재무 권한자만 확정할 수 있습니다' });
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
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인이 등록한 지출에만 영수증을 첨부할 수 있습니다' });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ error: '파일이 없습니다' });

    const storage = getClient().storage.from(RECEIPT_BUCKET);
    // 표시용(DB record) — 원본 한글 보존
    const displayName = sanitizeFileName(f.originalname);
    // Storage key 용 — ASCII 안전 (Supabase 'Invalid key' 회피)
    const keySlug = asciiSafeKey(f.originalname);
    const rand = crypto.randomBytes(6).toString('hex');
    // 지출일(paid_at) 기준으로 YYYY-MM 폴더로 묶음 (월별 정리 편의)
    const paidIso = String(existing.paidAt || new Date().toISOString()).slice(0, 10);
    const monthFolder = paidIso.slice(0, 7); // 'YYYY-MM'
    const newPath = `${monthFolder}/${id}/${Date.now()}-${rand}-${keySlug}`;

    const { error: upErr } = await storage.upload(newPath, f.buffer, {
      contentType: f.mimetype,
      upsert: false,
    });
    if (upErr) {
      console.error('[expense-receipt] Storage 업로드 실패:', { bucket: RECEIPT_BUCKET, path: newPath, mime: f.mimetype, size: f.size, msg: upErr.message, statusCode: upErr.statusCode });
      const isBucketMissing = /bucket not found|not found/i.test(upErr.message);
      const friendly = isBucketMissing
        ? `Supabase Storage 버킷 "${RECEIPT_BUCKET}" 가 없습니다. 관리자에게 문의 (Supabase 콘솔에서 버킷 생성 필요).`
        : `Storage 업로드 실패: ${upErr.message}`;
      return res.status(500).json({ error: friendly });
    }

    // ADD 의미로 변경 — 기존 영수증을 덮어쓰지 않고, 새 row 로 추가.
    // 첫 번째 영수증만 backward-compat 위해 expenses.receipt_path 에도 미러링.
    let receiptRecord = null;
    try {
      receiptRecord = await repo.addReceiptRecord({
        expenseId: id, path: newPath, name: displayName, mime: f.mimetype, size: f.size, userId: req.user.id,
      });
    } catch (e) {
      // expense_receipts 테이블 없으면 (036 마이그레이션 미적용) → 옛 단일 영수증 모드 fallback
      console.warn('[expense-receipt] addReceiptRecord 실패 (마이그레이션 036 미적용?):', e.message);
    }

    // 첫 번째 영수증이면 단일 컬럼도 동기화 (옛 UI fallback 용)
    let updated;
    if (!existing.receiptPath) {
      updated = await repo.setReceipt(id, {
        path: newPath, name: displayName, mime: f.mimetype, size: f.size,
      });
    } else {
      updated = existing;
    }

    res.json({ data: updated, receipt: receiptRecord });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id/receipts — 모든 영수증 목록 (다중)
router.get('/:id/receipts', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    const list = await repo.listReceiptsByExpense(id);
    // 마이그레이션 036 미적용으로 list 가 비어있으면 옛 단일 영수증으로 fallback
    if (list.length === 0 && existing.receiptPath) {
      list.push({
        id: 0,                                  // legacy marker
        expenseId: id,
        path: existing.receiptPath,
        name: existing.receiptName,
        mime: existing.receiptMime,
        size: existing.receiptSize,
        uploadedAt: existing.createdAt,
        legacy: true,
      });
    }
    res.json({ data: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expense-receipts/:receiptId/url — signed URL (개별)
router.get('/receipts/:receiptId/url', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const receiptId = parseInt(req.params.receiptId, 10);
    const r = await repo.getReceiptById(receiptId);
    if (!r) return res.status(404).json({ error: '영수증이 없습니다' });
    const exp = await repo.getExpense(r.expenseId);
    if (!exp) return res.status(404).json({ error: '연결된 지출이 없습니다' });
    if (!canFinance(req) && exp.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    const { data, error } = await getClient().storage.from(RECEIPT_BUCKET)
      .createSignedUrl(r.path, 300, { download: r.name || 'receipt' });
    if (error) throw error;
    res.json({ signedUrl: data.signedUrl, fileName: r.name, mime: r.mime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/expense-receipts/:receiptId — 개별 영수증 삭제
router.delete('/receipts/:receiptId', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const receiptId = parseInt(req.params.receiptId, 10);
    const r = await repo.getReceiptById(receiptId);
    if (!r) return res.status(404).json({ error: '영수증이 없습니다' });
    const exp = await repo.getExpense(r.expenseId);
    if (!exp) return res.status(404).json({ error: '연결된 지출이 없습니다' });
    if (!canFinance(req) && exp.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    // Storage 도 정리
    try { await getClient().storage.from(RECEIPT_BUCKET).remove([r.path]); } catch {}
    await repo.deleteReceiptById(receiptId);
    // 옛 단일 컬럼 미러였다면 함께 정리
    if (exp.receiptPath === r.path) await repo.clearReceipt(exp.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/expenses/:id/receipt/url — signed URL (본인 or 재무)
router.get('/:id/receipt/url', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await repo.getExpense(id);
    if (!existing) return res.status(404).json({ error: '지출을 찾을 수 없습니다' });
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
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
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
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
    if (!canFinance(req) && existing.createdBy !== req.user.id) {
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

// POST /api/expenses/reorganize-receipts — 기존 영수증을 paid_at 기반 YYYY-MM 폴더로 이동 (재무만)
// 새 업로드는 이미 YYYY-MM 폴더로 저장되므로 최초 1회만 실행하면 됨.
router.post('/reorganize-receipts', async (req, res) => {
  try {
    if (!canFinance(req)) return res.status(403).json({ error: '재무 권한 필요' });
    const list = await repo.listExpenses({ limit: 5000 });
    const storage = getClient().storage.from(RECEIPT_BUCKET);
    const withReceipt = list.filter(e => e.receiptPath);

    let moved = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const exp of withReceipt) {
      const oldPath = exp.receiptPath;
      const paidIso = String(exp.paidAt || '').slice(0, 10);
      const monthFolder = paidIso.slice(0, 7);
      if (!monthFolder || monthFolder.length !== 7) { skipped++; continue; }

      // 이미 YYYY-MM/ 로 시작하면 스킵
      if (oldPath.startsWith(`${monthFolder}/`)) { skipped++; continue; }

      // 파일명 부분만 추출 (기존은 `${id}/${Date.now()}-${rand}-${clean}`)
      const leaf = oldPath.split('/').pop();
      const newPath = `${monthFolder}/${exp.id}/${leaf}`;

      try {
        const { error: mvErr } = await storage.move(oldPath, newPath);
        if (mvErr) throw mvErr;
        await repo.setReceipt(exp.id, {
          path: newPath,
          name: exp.receiptName,
          mime: exp.receiptMime,
          size: exp.receiptSize,
        });
        moved++;
      } catch (e) {
        failed++;
        errors.push({ id: exp.id, from: oldPath, error: e.message });
      }
    }

    res.json({ total: withReceipt.length, moved, skipped, failed, errors: errors.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────
// 세무자료 일괄 다운로드 — 재무 권한자 전용
// ────────────────────────────────────────────────────────────────────

function _monthBounds(month) {
  // month: YYYY-MM
  const [y, m] = month.split('-').map(n => parseInt(n, 10));
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

// GET /api/expenses/export?month=YYYY-MM&format=xlsx
//   해당 월 지출 내역을 Excel 한 파일로 다운로드 (세무사 제출용).
router.get('/export', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    if (!canFinance(req)) return res.status(403).json({ error: '재무 권한이 필요합니다' });
    const month = req.query.month;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM 형식이 필요합니다' });

    const { from, to } = _monthBounds(month);
    const list = await repo.listExpenses({ from, to, limit: 5000 });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PMC';
    const ws = wb.addWorksheet(`${month} 지출`);
    ws.columns = [
      { header: '결제일',     key: 'paidAt',     width: 12 },
      { header: '가맹점/거래처', key: 'merchant',  width: 28 },
      { header: '카테고리',   key: 'categoryLabel', width: 16 },
      { header: '금액',       key: 'amount',     width: 14, style: { numFmt: '#,##0' } },
      { header: '통화',       key: 'currency',   width: 6 },
      { header: '카드',       key: 'cardLast4',  width: 8 },
      { header: '메모',       key: 'memo',       width: 30 },
      { header: '영수증',     key: 'hasReceipt', width: 8 },
      { header: '등록자',     key: 'createdByName', width: 14 },
      { header: '등록일시',   key: 'createdAt',  width: 18 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };

    let total = 0;
    for (const e of list) {
      ws.addRow({
        paidAt: e.paidAt || '',
        merchant: e.merchant || '',
        categoryLabel: (CATEGORIES.find(c => c.key === e.category)?.label) || e.category || '',
        amount: Number(e.amount) || 0,
        currency: e.currency || 'KRW',
        cardLast4: e.cardLast4 || '',
        memo: e.memo || '',
        hasReceipt: e.hasReceipt ? '○' : '',
        createdByName: e.createdByName || e.createdBy || '',
        createdAt: e.createdAt ? String(e.createdAt).replace('T', ' ').slice(0, 16) : '',
      });
      total += Number(e.amount) || 0;
    }

    // 합계행
    const totalRow = ws.addRow({ paidAt: '', merchant: '합계', categoryLabel: '', amount: total });
    totalRow.font = { bold: true };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } };

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[expenses/export] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/expenses/receipts/zip?month=YYYY-MM
//   해당 월의 모든 영수증을 ZIP 한 파일로. 파일명: {paidAt}_{merchant}_{expenseId}_{원본}.
router.get('/receipts/zip', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    if (!canFinance(req)) return res.status(403).json({ error: '재무 권한이 필요합니다' });
    const month = req.query.month;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM 형식이 필요합니다' });

    const { from, to } = _monthBounds(month);
    const list = await repo.listExpenses({ from, to, limit: 5000 });
    const storage = getClient().storage.from(RECEIPT_BUCKET);

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="receipts-${month}.zip"`);
    archive.on('warning', (e) => console.warn('[expenses/zip] warning:', e.message));
    archive.on('error', (e) => { console.error('[expenses/zip] error:', e.message); res.status(500).end(e.message); });
    archive.pipe(res);

    // 메니페스트 (어느 영수증이 어느 지출 건인지 — ZIP 안에 함께 동봉)
    const manifest = [];
    let added = 0;
    let missing = 0;

    for (const exp of list) {
      const merchantSlug = String(exp.merchant || 'unknown').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      const paths = [];
      // 멀티 영수증 (036+)
      let multi = [];
      try { multi = await repo.listReceiptsByExpense(exp.id); } catch {}
      for (const r of multi) if (r.path) paths.push({ path: r.path, name: r.name || 'receipt' });
      // legacy 단일 영수증 (멀티가 없으면)
      if (paths.length === 0 && exp.receiptPath) {
        paths.push({ path: exp.receiptPath, name: exp.receiptName || 'receipt' });
      }
      if (paths.length === 0) {
        manifest.push({ id: exp.id, paidAt: exp.paidAt, merchant: exp.merchant, amount: exp.amount, files: [], note: '영수증 없음' });
        missing++;
        continue;
      }
      const expFiles = [];
      for (const p of paths) {
        try {
          const { data: blob, error } = await storage.download(p.path);
          if (error) throw new Error(error.message || 'storage download failed');
          const buf = Buffer.from(await blob.arrayBuffer());
          // 파일 이름: 결제일_가맹점_id_원본
          const safeOrig = String(p.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
          const fname = `${exp.paidAt || 'unknown'}_${merchantSlug}_${exp.id}_${safeOrig}`;
          archive.append(buf, { name: fname });
          expFiles.push(fname);
          added++;
        } catch (e) {
          console.warn('[expenses/zip] receipt download fail', exp.id, p.path, e.message);
        }
      }
      manifest.push({ id: exp.id, paidAt: exp.paidAt, merchant: exp.merchant, amount: exp.amount, files: expFiles });
    }

    // 메니페스트 CSV 추가 — 한국어 헤더 + Excel 호환 UTF-8 BOM
    const csvLines = ['﻿id,결제일,가맹점,금액,영수증파일,비고'];
    for (const m of manifest) {
      const files = (m.files || []).join(' | ');
      const note = m.note || '';
      const merchant = String(m.merchant || '').replace(/"/g, '""');
      csvLines.push(`${m.id},"${m.paidAt || ''}","${merchant}",${m.amount || 0},"${files}","${note}"`);
    }
    csvLines.push('');
    csvLines.push(`,요약,총 지출 ${list.length}건,영수증 ${added}건 첨부,영수증 없음 ${missing}건,`);
    archive.append(csvLines.join('\n'), { name: `_INDEX_${month}.csv` });

    await archive.finalize();
  } catch (e) {
    console.error('[expenses/zip] error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
