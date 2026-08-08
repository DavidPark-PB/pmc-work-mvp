/**
 * Google Sheets 카탈로그 가격 관리 API
 *   GET  /api/catalog/prices?tab=<tab>   — 상품 목록 + 현재 환율 + 계산값
 *   PUT  /api/catalog/prices             — { tab, rowIndex, side, usdPrice } → 3시트 동시 업데이트
 *   GET  /api/catalog/tabs               — 사용 가능한 시트 탭 목록
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const service = require('../../services/catalogService');

const router = express.Router();

// Google Sheets 실패 원인 힌트 — 프론트가 "왜 안 되는지" 명확히 보여주게.
function _hintFor(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('gaxios') || msg.includes('invalid_grant') || msg.includes('no key or keyfile')) {
    return 'Google Sheets 인증 실패 — 서버에 GOOGLE_CREDENTIALS_JSON 환경변수가 설정됐는지 확인 필요 (Railway → Variables).';
  }
  if (msg.includes('unable to parse') || msg.includes('json.parse')) {
    return 'GOOGLE_CREDENTIALS_JSON 값이 유효한 JSON 이 아닙니다 (따옴표/줄바꿈 확인).';
  }
  if (msg.includes('permission') || msg.includes('403') || msg.includes('does not have permission')) {
    return '서비스 계정이 해당 시트에 공유되지 않았습니다 (시트 공유 설정에서 서비스 계정 이메일 추가 필요).';
  }
  if (msg.includes('not found') || msg.includes('404')) {
    return '시트 ID (SHEET_ID_USD/KRW/EURO) 가 잘못됐거나 삭제됐을 수 있습니다.';
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return 'Google Sheets API 응답 지연 — 잠시 후 재시도.';
  }
  return null;
}

router.get('/prices', async (req, res) => {
  try {
    const data = await service.getCatalog(req.query.tab);
    res.json(data);
  } catch (e) {
    console.error('[catalog/prices] error:', e.message);
    res.status(500).json({ error: e.message, hint: _hintFor(e) });
  }
});

router.get('/tabs', async (req, res) => {
  try {
    const tabs = await service.listTabs();
    res.json({ tabs });
  } catch (e) {
    console.error('[catalog/tabs] error:', e.message);
    res.status(500).json({ error: e.message, hint: _hintFor(e) });
  }
});

router.put('/prices', requireAdmin, async (req, res) => {
  try {
    const { tab, rowIndex, side, usdPrice } = req.body || {};
    const result = await service.updatePrice({
      tab,
      rowIndex: parseInt(rowIndex, 10),
      side,
      usdPrice: Number(usdPrice),
    });
    res.json({ ok: true, result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PR catalog-fix 2026-05: 다건 일괄 저장 (사장님 spec — batch + retry).
//   PUT /api/catalog/prices/batch
//   body: { tab, items: [{rowIndex, side, usdPrice}, ...] }
//   response: { ok, totalRequested, totalSucceeded, totalFailed, rates, results: [...] }
router.put('/prices/batch', requireAdmin, async (req, res) => {
  try {
    const { tab, items } = req.body || {};
    if (!tab) return res.status(400).json({ error: 'tab 필수' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items 배열 필수' });
    }
    if (items.length > 200) {
      return res.status(400).json({ error: '한 번에 최대 200행까지 저장 가능합니다' });
    }
    const result = await service.updatePricesBatch({ tab, items });
    // 모두 실패면 502, 부분 실패면 200 + results 안에 표시
    const status = result.totalSucceeded === 0 ? 502 : 200;
    res.status(status).json({ ok: result.totalSucceeded > 0, ...result });
  } catch (e) {
    console.error('[catalog/prices/batch] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 수동 환율 편집 ──
// PUT /api/catalog/rates  body: { usdToKrw?, usdToEur? }  (null 보내면 자동 모드로 복원)
router.put('/rates', requireAdmin, async (req, res) => {
  try {
    const { usdToKrw, usdToEur } = req.body || {};
    const payload = { userId: req.user.id };
    if (usdToKrw !== undefined) payload.usdToKrw = usdToKrw;
    if (usdToEur !== undefined) payload.usdToEur = usdToEur;
    await service.setManualRates(payload);
    const rates = await service.getRates();
    res.json({ ok: true, rates });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 이미지 수동 지정 ──
// PUT /api/catalog/image  body: { tab, rowIndex, side, imageUrl }
// imageUrl이 빈 문자열/null이면 override 삭제 (자동 매칭으로 복원)
router.put('/image', requireAdmin, async (req, res) => {
  try {
    const { tab, rowIndex, side, imageUrl } = req.body || {};
    if (!tab || !rowIndex || !['left', 'right'].includes(side)) {
      return res.status(400).json({ error: 'tab, rowIndex, side 필수' });
    }
    const result = await service.setImageOverride({
      tab,
      rowIndex: parseInt(rowIndex, 10),
      side,
      imageUrl: imageUrl ? String(imageUrl).trim() : null,
      userId: req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
