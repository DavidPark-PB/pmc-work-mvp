/**
 * Accio Gateway 통합 — 로컬 dev 에서만 활성 (ACCIO_ENABLED=true).
 * Fly.io 프로덕션에서는 /api/accio/health 가 {enabled:false} 반환해서 프론트에서 자동 숨김.
 */
const express = require('express');
const { requireAdmin } = require('../../middleware/auth');
const accio = require('../../services/accioClient');

const router = express.Router();

router.get('/health', async (req, res) => {
  try { res.json(await accio.health()); }
  catch (e) { res.status(500).json({ enabled: false, error: e.message }); }
});

router.use(requireAdmin);

// ── AI 이미지 생성 ─────────────────────────────────────────────
const IMAGE_MODE_TO_TOOL = {
  scene:     'product_ai_image_model_generate',
  color:     'product_ai_image_color_change',
  logo:      'product_ai_image_custom_logo',
  translate: 'product_ai_image_translate',
  generic:   'product_ai_image_generate', // abilityCode 직접 지정
};

router.post('/image/generate', async (req, res) => {
  try {
    const { imageUrl, mode = 'scene', prompt, abilityCode } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl 필요' });
    const tool = IMAGE_MODE_TO_TOOL[mode];
    if (!tool) return res.status(400).json({ error: `mode 는 ${Object.keys(IMAGE_MODE_TO_TOOL).join(' / ')} 중 하나` });

    const args = { imageUrl };
    if (prompt) args.prompt = prompt;
    if (mode === 'generic' && abilityCode) args.abilityCode = abilityCode;

    const raw = await accio.call(tool, args);
    const parsed = accio.extractJson(raw);
    const requestKey = parsed?.requestKey || parsed?.data?.requestKey || parsed?.request_key;
    if (!requestKey) return res.status(502).json({ error: 'Accio 응답에 requestKey 없음', raw: parsed });
    res.json({ requestKey, tool });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/image/result', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key 필요' });
    const raw = await accio.call('product_ai_image_generate_result', { requestKey: key });
    const parsed = accio.extractJson(raw);
    // 응답 shape 은 Accio/ICBU 에 따라 다양 — 일반적 필드 정규화
    const status = parsed?.status || parsed?.taskStatus || (parsed?.resultImageUrl ? 'done' : 'pending');
    const imageUrl = parsed?.resultImageUrl || parsed?.imageUrl || parsed?.result?.imageUrl;
    const done = imageUrl || ['done', 'success', 'SUCCESS', 'FINISHED', 'completed'].includes(String(status));
    const failed = ['failed', 'error', 'FAILED', 'ERROR'].includes(String(status));
    res.json({
      status: done ? 'done' : (failed ? 'failed' : 'pending'),
      imageUrl: imageUrl || null,
      raw: parsed,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Junglescout 리서치 (키워드 + 판매량) ────────────────────
router.post('/js/research', async (req, res) => {
  try {
    const asinRaw = String(req.body?.asin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asinRaw)) return res.status(400).json({ error: 'ASIN 은 10자 영숫자 (예: B00I26U9WS)' });
    const marketplace = String(req.body?.marketplace || 'us');

    const today = new Date();
    const end = req.body?.endDate || isoDate(new Date(today.getTime() - 24 * 60 * 60 * 1000));
    const start = req.body?.startDate || isoDate(new Date(today.getTime() - 31 * 24 * 60 * 60 * 1000));

    const [kwRaw, salesRaw] = await Promise.allSettled([
      accio.call('js_keywords_by_asin', { asins: [asinRaw], marketplace, page_size: 50 }),
      accio.call('js_sales_estimates', { asin: asinRaw, start_date: start, end_date: end, marketplace }),
    ]);

    const keywords = kwRaw.status === 'fulfilled' ? accio.extractJson(kwRaw.value) : { error: kwRaw.reason?.message };
    const sales = salesRaw.status === 'fulfilled' ? accio.extractJson(salesRaw.value) : { error: salesRaw.reason?.message };

    res.json({ asin: asinRaw, marketplace, range: { start, end }, keywords, sales });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

function isoDate(d) { return d.toISOString().slice(0, 10); }

module.exports = router;
