/**
 * Gemini 기반 CSV 컬럼 매핑 자동 감지
 *
 * 헤더 + 샘플 5행을 Gemini에 보내서 시멘틱하게 컬럼 매핑을 판별.
 * API 실패/타임아웃 시 null 반환 → 호출자가 키워드 폴백 사용.
 */
import { env } from './config.js';

const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAPPING_PROMPT = `You are a CSV column analyzer for an e-commerce product import system.
Given CSV headers and sample data rows, determine which column index (0-based) maps to each field.

Available fields:
- name: Product name/title (상품명)
- price: Sale price / discounted price (판매가/할인가)
- url: Product page URL (상품 URL)
- image: Product image URL (이미지 URL, not logos or icons)
- originalPrice: Original/list price before discount (정가)
- discountRate: Discount percentage (할인율)
- category: Product category (카테고리)
- brand: Brand name (브랜드)
- rating: Star rating (평점)
- reviewCount: Number of reviews (리뷰수)

Rules:
- Only map columns you are confident about. Skip ambiguous or irrelevant columns.
- Do NOT map the same field to multiple columns.
- If a column contains logo/icon URLs (e.g. coupang/rds/logo), do NOT map it as "image".
- Distinguish between sale price (lower, after discount) and original price (higher, before discount).
- Respond with ONLY valid JSON object: {"field": columnIndex, ...}
- No markdown fences, no explanation.`;

/** 매핑 결과 타입 */
type MappingResult = Record<string, number>;

/**
 * Gemini로 CSV 컬럼 매핑 감지
 * @returns 매핑 객체 또는 null (실패 시)
 */
export async function detectMappingWithAI(
  headers: string[],
  sampleRows: string[][],
): Promise<MappingResult | null> {
  if (!env.GEMINI_API_KEY) return null;

  // 프롬프트 구성: 헤더 + 샘플 데이터
  const dataSection = [
    `Headers: ${JSON.stringify(headers)}`,
    ...sampleRows.slice(0, 5).map((row, i) => `Row${i + 1}: ${JSON.stringify(row)}`),
  ].join('\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${MAPPING_PROMPT}\n\n${dataSection}` }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 200,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[csv-mapping-ai] Gemini HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };

    // Gemini 2.5 thinking 모드: thought=true인 파트 건너뛰고 실제 텍스트만 추출
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find(p => !p.thought && p.text);
    const text = textPart?.text?.trim();
    if (!text) return null;

    // JSON 추출 (마크다운 펜스 제거)
    const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const mapping = JSON.parse(jsonStr) as MappingResult;

    // 유효성: 값이 숫자인지, 범위 내인지
    const valid: MappingResult = {};
    const usedIndices = new Set<number>();
    const colCount = headers.length;

    for (const [field, idx] of Object.entries(mapping)) {
      if (typeof idx === 'number' && idx >= 0 && idx < colCount && !usedIndices.has(idx)) {
        valid[field] = idx;
        usedIndices.add(idx);
      }
    }

    console.log(`[csv-mapping-ai] Gemini 감지 결과: ${JSON.stringify(valid)}`);
    return Object.keys(valid).length > 0 ? valid : null;
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? '타임아웃' : (e as Error).message;
    console.log(`[csv-mapping-ai] Gemini 실패: ${msg}`);
    return null;
  }
}
