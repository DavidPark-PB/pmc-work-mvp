/**
 * 지출 카테고리 자동 분류 — 머천트명 → 카테고리.
 *
 * 전략:
 *  1) expense_category_rules 테이블에서 substring match (학습된 규칙)
 *  2) miss인 머천트들을 한 번에 Gemini에 묶어서 요청 (배치 프롬프트)
 *  3) Gemini 결과를 rules 테이블에 저장 → 다음부터 공짜
 *  4) 모든 fallback 실패 시 '기타'
 */
const axios = require('axios');
const repo = require('../db/expenseRepository');
const { CATEGORY_KEYS, normalize } = require('./expenseCategories');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function classifyWithAI(merchants) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !merchants.length) return {};

  const prompt = `다음은 한국의 카드명세서에서 가져온 가맹점명 목록입니다. 각 가맹점을 아래 카테고리 중 정확히 하나로 분류하세요.

카테고리 선택지:
${CATEGORY_KEYS.map(k => `- ${k}`).join('\n')}

규칙:
- 출력은 오직 JSON 객체 하나: 키=가맹점명 원문, 값=카테고리명.
- 모르겠으면 "기타".
- 설명이나 다른 텍스트 추가 금지.

가맹점명:
${merchants.map((m, i) => `${i + 1}. ${m}`).join('\n')}

JSON 출력:`;

  try {
    const r = await axios.post(`${GEMINI_URL}?key=${key}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }, { timeout: 30000, validateStatus: () => true });

    if (r.status !== 200) {
      console.warn('[categorizer] Gemini status:', r.status, r.data?.error?.message);
      return {};
    }
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 응답에 코드블록이나 프리픽스가 섞이면 JSON 부분만 추출 시도
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return {};
      parsed = JSON.parse(m[0]);
    }
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = normalize(v);
    }
    return out;
  } catch (e) {
    console.warn('[categorizer] AI fail:', e.message);
    return {};
  }
}

/**
 * 입력: [{ merchant, ... }]
 * 출력: 각 행에 `suggestedCategory`와 `categorySource` ('cache'|'ai'|'default') 추가.
 * 캐시에도 AI 결과 저장 (다음 업로드부턴 AI 호출 최소화).
 */
async function suggestCategories(rows, { saveAiToCache = true } = {}) {
  const merchantSet = new Set();
  for (const r of rows) {
    if (r.merchant) merchantSet.add(r.merchant);
  }
  const uniqueMerchants = [...merchantSet];

  // 1) 캐시 조회
  const resolved = {}; // merchant → { category, source }
  for (const m of uniqueMerchants) {
    const cached = await repo.getCachedCategory(m);
    if (cached) resolved[m] = { category: cached, source: 'cache' };
  }

  // 2) 캐시 miss → AI 배치
  const toAsk = uniqueMerchants.filter(m => !resolved[m]);
  if (toAsk.length > 0) {
    const aiMap = await classifyWithAI(toAsk);
    for (const m of toAsk) {
      if (aiMap[m]) {
        resolved[m] = { category: aiMap[m], source: 'ai' };
        if (saveAiToCache) {
          // AI는 confidence 70 (수동 100보다 낮음 → 수동이 덮어쓰면 승리)
          try { await repo.saveCachedCategory({ merchant: m, category: aiMap[m], confidence: 70 }); } catch {}
        }
      }
    }
  }

  // 3) 결과 병합
  return rows.map(r => {
    const hit = r.merchant ? resolved[r.merchant] : null;
    return {
      ...r,
      suggestedCategory: hit ? hit.category : '기타',
      categorySource: hit ? hit.source : 'default',
    };
  });
}

module.exports = { suggestCategories };
