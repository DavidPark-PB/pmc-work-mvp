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

// POST /api/cs/suggest — 고객 메시지 → AI 템플릿 추천 + 플레이스홀더 채움
// body: { message: string, context?: {...}, language?: 'en'|'ko'|'auto' }
router.post('/suggest', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: '고객 메시지를 입력하세요' });
    const lang = req.body?.language || 'auto';
    const ctx = req.body?.context || {};

    const key = process.env.GEMINI_API_KEY;
    const templates = await repo.list({ activeOnly: true, language: lang === 'auto' ? undefined : lang });
    if (templates.length === 0) {
      return res.json({ ok: true, suggestions: [], reason: 'no_templates' });
    }

    if (!key) {
      // Gemini 없으면 첫 3개를 랜덤 추천 (degraded)
      return res.json({ ok: true, suggestions: templates.slice(0, 3).map(t => ({
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
      res.json({ ok: true, suggestions: withMeta });
    } catch (e) {
      console.warn('[cs/suggest] AI fail:', e.message);
      res.status(502).json({ error: 'AI 호출 실패: ' + e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
