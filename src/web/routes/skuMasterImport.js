/**
 * skuMasterImport.js — SKU 마스터 원가/무게/치수 CSV 일괄 임포트
 *
 * 목적: Engine 1 의 BLOCK_LANDING_COST_UNKNOWN 을 대량으로 해소.
 *       (원가·무게·치수 입력 → Landing Cost Complete → 자동가격 대상 편입)
 *
 * 권한: admin 전용 (requireAdmin).
 *
 * 엔드포인트 (server.js 에서 /api/sku-master/import 로 mount — skuMaster.js 보다 먼저):
 *   GET  /template            CSV 템플릿 다운로드.
 *                             ?fill=missing → 원가/무게 빠진 기존 SKU 로 미리 채움.
 *   POST /                    CSV 본문(text/csv) 업로드 → 일괄 UPDATE.
 *
 * 정책:
 *   - UPDATE only — internal_sku 가 sku_master 에 없으면 skip 후 리포트 (신규 생성 안 함).
 *   - internal_sku 외 컬럼은 값이 있는 것만 갱신 (빈 칸 = 유지, 기존 값 안 지움).
 *   - weight_gram 입력 시 weight_status: 기본 'estimated' (CSV 일괄 입력 컨벤션),
 *     weight_status 컬럼에 'measured' 명시 시 measured.
 *   - audit: 배치당 safetyExec 1건 (sku_master_bulk_import) + 요약 snapshot.
 */
const express = require('express');
const Papa = require('papaparse');
const { requireAdmin } = require('../../middleware/auth');
const { getClient } = require('../../db/supabaseClient');
const safetyExec = require('../../services/safetyExec');

const router = express.Router();
router.use(requireAdmin);
router.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));

const COLUMNS = [
  'internal_sku',              // 필수 — 매칭 키 (변경 불가)
  'cost_krw',                  // 도매원가 (KRW)
  'weight_gram',               // 단품 실무게 (g)
  'default_packaging_weight_g',
  'width_cm', 'height_cm', 'length_cm',
  'shipping_group',            // card|photocard|sticker|album|figure|toy|apparel|general
  'weight_status',             // (선택) measured 명시 시 실측 처리
];

const VALID_WEIGHT_STATUS = new Set(['estimated', 'measured']);
const VALID_SHIPPING_GROUP = new Set(['card', 'photocard', 'sticker', 'album', 'figure', 'toy', 'apparel', 'general']);

const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN; // NaN = 형식 오류
};
const int = (v) => {
  const n = num(v);
  return n === null || Number.isNaN(n) ? n : Math.round(n);
};

// ── GET /template ────────────────────────────────────────
router.get('/template', async (req, res) => {
  try {
    let rows = [];
    if (req.query.fill === 'missing') {
      // 원가 또는 무게가 빠진 active SKU 를 미리 채워서 내려줌 — 직원은 빈 칸만 채우면 됨
      const c = getClient();
      const { data, error } = await c.from('sku_master')
        .select('internal_sku, title, cost_krw, weight_gram, default_packaging_weight_g, width_cm, height_cm, length_cm, shipping_group')
        .eq('status', 'active')
        .or('cost_krw.is.null,weight_gram.is.null,width_cm.is.null')
        .order('internal_sku')
        .limit(5000);
      if (error) throw error;
      rows = (data || []).map((s) => ({
        internal_sku: s.internal_sku,
        cost_krw: s.cost_krw ?? '',
        weight_gram: s.weight_gram ?? '',
        default_packaging_weight_g: s.default_packaging_weight_g ?? '',
        width_cm: s.width_cm ?? '',
        height_cm: s.height_cm ?? '',
        length_cm: s.length_cm ?? '',
        shipping_group: s.shipping_group ?? '',
        weight_status: '',
        title_참고용_저장안됨: s.title || '',
      }));
    }
    const csv = rows.length
      ? Papa.unparse(rows)
      : Papa.unparse([Object.fromEntries(COLUMNS.map((k) => [k, '']))]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sku_master_import_template.csv"');
    res.send('\uFEFF' + csv); // BOM — 엑셀 한글 호환
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  const executedBy = req.user?.id;
  if (!Number.isFinite(executedBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다' });
  }
  const csvText = typeof req.body === 'string' ? req.body.replace(/^\uFEFF/, '') : '';
  if (!csvText.trim()) return res.status(400).json({ error: 'CSV 본문이 비어 있습니다 (Content-Type: text/csv 로 전송)' });

  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const rows = (parsed.data || []).filter((r) => r.internal_sku && String(r.internal_sku).trim());
  if (!rows.length) return res.status(400).json({ error: '처리할 행이 없습니다 (internal_sku 컬럼 확인)' });
  if (rows.length > 5000) return res.status(400).json({ error: '한 번에 최대 5000행까지 가능합니다' });

  // pre-action audit (strict) — 배치 단위 1건
  let run;
  try {
    run = await safetyExec.runAction({
      actionName: 'sku_master_bulk_import',
      executedBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable: 'sku_master',
      rollbackMethod: 'manual',
      rollbackHint: 'CSV 임포트 이전 값은 각 행 audit snapshot 미보관 — 백업 CSV 로 복원',
      beforeSnapshot: { row_count: rows.length, columns: parsed.meta?.fields || [] },
    });
  } catch (e) {
    return res.status(500).json({ error: `audit 기록 실패 — 임포트 중단: ${e.message}` });
  }

  const c = getClient();
  const result = { total: rows.length, updated: 0, not_found: [], invalid: [], unchanged: 0 };

  // 존재하는 SKU 만 갱신 (UPDATE only)
  const skuList = rows.map((r) => String(r.internal_sku).trim());
  const existing = new Map();
  for (let i = 0; i < skuList.length; i += 500) {
    const { data, error } = await c.from('sku_master')
      .select('id, internal_sku, weight_status')
      .in('internal_sku', skuList.slice(i, i + 500));
    if (error) {
      safetyExec.updateRun(run.id, { status: 'failed', errorMessage: error.message });
      return res.status(500).json({ error: error.message });
    }
    for (const s of data || []) existing.set(s.internal_sku, s);
  }

  for (const [idx, row] of rows.entries()) {
    const sku = String(row.internal_sku).trim();
    const found = existing.get(sku);
    if (!found) { result.not_found.push(sku); continue; }

    const updates = {};
    const costKrw = num(row.cost_krw);
    const weightGram = int(row.weight_gram);
    const packG = int(row.default_packaging_weight_g);
    const w = num(row.width_cm), h = num(row.height_cm), l = num(row.length_cm);

    if ([costKrw, weightGram, packG, w, h, l].some(Number.isNaN)) {
      result.invalid.push({ row: idx + 2, sku, error: '숫자 형식 오류' });
      continue;
    }
    if (costKrw !== null) updates.cost_krw = costKrw;
    if (weightGram !== null) updates.weight_gram = weightGram;
    if (packG !== null) updates.default_packaging_weight_g = packG;
    if (w !== null) updates.width_cm = w;
    if (h !== null) updates.height_cm = h;
    if (l !== null) updates.length_cm = l;

    const sg = row.shipping_group && String(row.shipping_group).trim().toLowerCase();
    if (sg) {
      if (!VALID_SHIPPING_GROUP.has(sg)) {
        result.invalid.push({ row: idx + 2, sku, error: `shipping_group 부적합: ${sg}` });
        continue;
      }
      updates.shipping_group = sg;
    }

    // weight_status — CSV 일괄 입력 기본 'estimated', 'measured' 명시 시 실측
    if (weightGram !== null && weightGram > 0) {
      const ws = row.weight_status && String(row.weight_status).trim().toLowerCase();
      updates.weight_status = VALID_WEIGHT_STATUS.has(ws) ? ws : 'estimated';
    }

    if (!Object.keys(updates).length) { result.unchanged += 1; continue; }
    updates.updated_at = new Date().toISOString();

    const { error } = await c.from('sku_master').update(updates).eq('id', found.id);
    if (error) result.invalid.push({ row: idx + 2, sku, error: error.message });
    else result.updated += 1;
  }

  // post-action audit (best-effort)
  safetyExec.updateRun(run.id, {
    status: result.invalid.length && !result.updated ? 'failed' : 'succeeded',
    afterSnapshot: {
      updated: result.updated,
      unchanged: result.unchanged,
      not_found_count: result.not_found.length,
      invalid_count: result.invalid.length,
    },
  });

  res.json({ data: result });
});

module.exports = router;
