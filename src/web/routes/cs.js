/**
 * CS 지원 API (/api/cs)
 *
 * - 모든 로그인 직원: 템플릿 조회·사용, AI 추천
 * - 템플릿 생성/수정/삭제는 admin만
 *
 * AI 추천: 고객 메시지 + 후보 템플릿 목록 → Gemini가 best match + 플레이스홀더 채움값 제안.
 */
const express = require('express');
const axios = require('axios');
const { requireAdmin } = require('../../middleware/auth');
const repo = require('../../db/csTemplateRepository');
const salesOptionRepo = require('../../db/csSalesOptionRepository');
const responseRepo = require('../../db/csResponseRepository');
const csClassifier = require('../../services/cs/csCategoryClassifier');
const buyerExtractor = require('../../services/cs/buyerExtractor');
const templateRecommender = require('../../services/cs/templateRecommender');
const variableSubstitutor = require('../../services/cs/variableSubstitutor');

const router = express.Router();

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// GET /api/cs/templates
router.get('/templates', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.list({
      activeOnly: req.query.activeOnly !== 'false',
      language: req.query.language || undefined,
      category: req.query.category || undefined,
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cs/templates/:id
router.get('/templates/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다' });
    res.json({ data, placeholders: repo.extractPlaceholders(data.body) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cs/templates — 로그인한 직원 누구나 (CS는 직원 업무)
router.post('/templates', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const created = await repo.create({ ...req.body, createdBy: req.user.id });
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PATCH /api/cs/templates/:id — 직원 허용
router.patch('/templates/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const updated = await repo.update(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /api/cs/templates/:id — 직원 허용
router.delete('/templates/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cs/templates/:id/use — 사용 카운트 증가
router.post('/templates/:id/use', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    await repo.bumpUsage(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// PR CS-G1-B: 신규 endpoints (analyze / render-template / sales-options / responses CRUD)
// ──────────────────────────────────────────────────────────────────────────

// POST /api/cs/analyze — 메시지 자동 분석 (모든 직원)
// body: { message }
// response: { detectedCategory, candidates[], extractedVars{}, recommendedTemplates[], salesOptions[] }
router.post('/analyze', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const message = String(req.body?.message || '');
    if (!message.trim()) return res.status(400).json({ error: '메시지를 입력하세요' });

    const { detectedCategory, candidates } = csClassifier.classify(message);
    const extracted = buyerExtractor.extract(message);

    // 추천 템플릿 + 영업 옵션 (카테고리 매칭 시만)
    const [recommendedTemplates, salesOptions] = detectedCategory
      ? await Promise.all([
          templateRecommender.recommend(detectedCategory, { limit: 3 }),
          salesOptionRepo.listByCategory(detectedCategory, { activeOnly: true }),
        ])
      : [[], []];

    res.json({
      detectedCategory,
      candidates,
      extractedVars: extracted,
      recommendedTemplates,
      salesOptions,
    });
  } catch (e) {
    console.error('[cs/analyze] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cs/render-template — 미리보기용 본문 조립 (모든 직원)
// body: { templateId, selectedSalesOptionIds[], vars{} }
// response: { previewText }
router.post('/render-template', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const templateId = parseInt(req.body?.templateId, 10);
    const ids = Array.isArray(req.body?.selectedSalesOptionIds) ? req.body.selectedSalesOptionIds : [];
    const vars = req.body?.vars || {};

    if (!Number.isFinite(templateId)) return res.status(400).json({ error: 'templateId required' });

    const template = await repo.getById(templateId);
    if (!template) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다' });

    const salesOptions = ids.length > 0
      ? await salesOptionRepo.getByIds(ids.map(n => parseInt(n, 10)).filter(Number.isFinite))
      : [];
    const snippets = salesOptions.map(s => s.contentSnippet).filter(Boolean);

    const previewText = variableSubstitutor.combine(template.body, snippets, vars);
    res.json({ previewText });
  } catch (e) {
    console.error('[cs/render-template] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cs/sales-options?category=&all=true
router.get('/sales-options', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const category = req.query.category;
    if (req.query.all === 'true') {
      const data = await salesOptionRepo.listAll({ activeOnly: false });
      return res.json({ data });
    }
    if (!category) return res.status(400).json({ error: 'category required (또는 all=true)' });
    const data = await salesOptionRepo.listByCategory(category, { activeOnly: true });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cs/responses — 답변 저장 (모든 직원)
router.post('/responses', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const b = req.body || {};
    if (!b.customerMessage || !String(b.customerMessage).trim()) {
      return res.status(400).json({ error: '메시지가 비어있습니다' });
    }
    const created = await responseRepo.create({
      customerMessage:        b.customerMessage,
      detectedCategory:       b.detectedCategory || null,
      manualCategory:         b.manualCategory || null,
      buyerUsername:          b.buyerUsername || null,
      buyerPlatform:          b.buyerPlatform || null,
      orderId:                b.orderId || null,
      productName:            b.productName || null,
      trackingNumber:         b.trackingNumber || null,
      selectedTemplateId:     b.selectedTemplateId || null,
      selectedSalesOptionIds: b.selectedSalesOptionIds || [],
      finalResponseText:      b.finalResponseText || null,
      aiToneAdjusted:         !!b.aiToneAdjusted,
      suspiciousBuyerId:      b.suspiciousBuyerId || null,  // 그룹 2 활성
      createdBy:              req.user.id,
    });
    // 선택된 템플릿이 있으면 사용 카운트 + last_used_at 갱신 (best-effort)
    if (created.selectedTemplateId) {
      repo.bumpUsage(created.selectedTemplateId).catch(() => {});
    }
    res.status(201).json({ data: created });
  } catch (e) {
    console.error('[cs/responses] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cs/responses?needsResultOnly=true
router.get('/responses', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const data = await responseRepo.list({
      user: req.user,
      needsResultOnly: req.query.needsResultOnly === 'true',
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
    });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cs/responses/:id
router.get('/responses/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const data = await responseRepo.getById(id);
    if (!data || data.deletedAt) return res.status(404).json({ error: '응답을 찾을 수 없습니다' });
    if (!req.user.isAdmin && data.createdBy !== req.user.id) {
      return res.status(403).json({ error: '권한이 없습니다' });
    }
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/cs/responses/:id — soft delete (작성자 본인 또는 admin)
router.delete('/responses/:id', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const id = parseInt(req.params.id, 10);
    const existing = await responseRepo.getById(id);
    if (!existing || existing.deletedAt) return res.status(404).json({ error: '응답을 찾을 수 없습니다' });
    if (!req.user.isAdmin && existing.createdBy !== req.user.id) {
      return res.status(403).json({ error: '본인 답변만 삭제할 수 있습니다' });
    }
    // deleted_by = 삭제 실행자 user id (NOT 원 작성자 — 사장님 짚을 점 E)
    await responseRepo.softDelete(id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────────────────────
// DEPRECATED: 2026-05-11 (PR CS-G1-B). Replaced by /api/cs/analyze + /api/cs/render-template.
// 사장님 짚을 점 D — 사용량 추적 후 Q3 운영 데이터로 폐기 시점 결정.
// 헤더 + 로그 + body 의 _deprecated 필드로 표시. 즉시 폐기 X.
// ──────────────────────────────────────────────────────────────────────────
router.post('/suggest', async (req, res) => {
  // 사장님 짚을 점 D — deprecate 4 단계
  res.set('X-Deprecated', 'true');
  res.set('X-Deprecated-Replaced-By', '/api/cs/analyze,/api/cs/render-template');
  console.warn('[cs] deprecated /api/cs/suggest called by user=', req.user?.id);
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: '고객 메시지를 입력하세요' });
    const lang = req.body?.language || 'auto';
    const ctx = req.body?.context || {};

    const key = process.env.GEMINI_API_KEY;
    const templates = await repo.list({ activeOnly: true, language: lang === 'auto' ? undefined : lang });
    if (templates.length === 0) {
      return res.json({ ok: true, _deprecated: true, suggestions: [], reason: 'no_templates' });
    }

    if (!key) {
      // Gemini 없으면 첫 3개를 랜덤 추천 (degraded)
      return res.json({ ok: true, _deprecated: true, suggestions: templates.slice(0, 3).map(t => ({
        templateId: t.id, title: t.title, body: t.body, filledBody: t.body, reason: 'AI 미사용 (GEMINI_API_KEY 없음)',
        confidence: 30,
      })) });
    }

    // 프롬프트: 후보 템플릿 목록 + 고객 메시지 + context → best 3 + 플레이스홀더 채움
    const lightTemplates = templates.map(t => ({
      id: t.id,
      title: t.title,
      language: t.language,
      category: t.category,
      body: t.body.slice(0, 800),
    }));

    const prompt = `You are a customer service assistant for PMC, a Korean global e-commerce seller.

Context (optional info about this message): ${JSON.stringify(ctx)}
Target reply language: ${lang === 'auto' ? 'same as customer message' : lang}

Customer message:
"""
${message.slice(0, 2000)}
"""

Available reply templates:
${JSON.stringify(lightTemplates)}

Task:
1. Pick up to 3 most suitable templates (by id) for this message.
2. For each, fill in {placeholder} values using the customer message and context. If a value is unknown, leave it as the literal {placeholder} so the user can fill it.
3. Return a JSON object ONLY, no extra text, shape:
{
  "suggestions": [
    { "templateId": number, "confidence": 0-100, "reason": "short why", "filledBody": "template body with placeholders resolved" }
  ]
}
Order suggestions by best fit. If nothing fits well, return an empty array.`;

    try {
      const r = await axios.post(`${GEMINI_URL}?key=${key}`, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }, { timeout: 25000, validateStatus: () => true });

      if (r.status !== 200) {
        const msg = r.data?.error?.message || `Gemini error ${r.status}`;
        return res.status(502).json({ error: msg });
      }
      const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { suggestions: [] };
      }
      const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      // 템플릿 원본과 merge (title 등)
      const withMeta = suggestions.map(s => {
        const t = templates.find(x => x.id === s.templateId);
        if (!t) return null;
        return {
          templateId: t.id,
          title: t.title,
          language: t.language,
          category: t.category,
          body: t.body,
          filledBody: s.filledBody || t.body,
          confidence: Math.max(0, Math.min(100, Number(s.confidence) || 0)),
          reason: s.reason || '',
        };
      }).filter(Boolean);
      res.json({ ok: true, _deprecated: true, suggestions: withMeta });
    } catch (e) {
      console.warn('[cs/suggest] AI fail:', e.message);
      res.status(502).json({ error: 'AI 호출 실패: ' + e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
