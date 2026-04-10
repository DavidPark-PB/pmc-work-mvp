/**
 * Gemini 2.5 Flash 기반 상품 번역 서비스
 *
 * 한글 상품명 → 영문 title, description, productType, tags 생성
 */
import { env } from '../lib/config.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export interface TranslateResult {
  title: string;
  description: string | null;
  productType: string | null;
  tags: string[];
}

const TRANSLATE_PROMPT = `You are a product listing translator for eBay and Shopify.
Given a Korean product title, generate an English listing with:

1. title: English product title optimized for eBay search (max 80 characters). Include brand/IP, product name, and key attributes.
2. description: Product description in structured HTML format. Include:
   - A short intro sentence about the product in a <p> tag
   - A specification list with key details like Brand, Origin, Condition, Material, Color etc. using this format:
     <ul><li><strong>Brand:</strong> value</li>...</ul>
   - Always include "100% Official Licensed Genuine Item" and "Condition: New"
   - For Origin: use "Korea, South" ONLY for Korean products/brands (K-Pop, Korean cosmetics, Korean food, Korean card games with 한글판/한국판). For imported/international products (e.g. Japanese anime OST, imported CDs, foreign brand items), use the actual country of origin (e.g. "Japan", "USA") or omit Origin if unknown
   - Infer appropriate specs (Material, Color, etc.) from the product title when possible
3. productType: English product category for marketplace taxonomy (e.g. "Trading Card", "Collectible Card Game", "Music Recording", "Toy", "Electronics", "Beauty", "Food")
4. tags: Array of 3-5 English search keywords/tags

IMPORTANT:
- Do NOT include pricing or shipping info in the description.
- Keep the title concise but keyword-rich for search visibility.
- Recognize well-known IPs and franchises — keep their proper English names:
  원피스→One Piece, 포켓몬→Pokemon, 유희왕→Yu-Gi-Oh, 디지몬→Digimon, 건담→Gundam,
  방탄소년단→BTS, 블랙핑크→BLACKPINK, 에스파→aespa, 스트레이키즈→Stray Kids,
  드래곤볼→Dragon Ball, 나루토→Naruto, 귀멸의 칼날→Demon Slayer, 주술회전→Jujutsu Kaisen
- For card game products (카드게임, 부스터박스, 부스터팩), use productType "Collectible Card Game".
- For K-Pop albums/merchandise, use productType "Music Recording".
- For figures/model kits, use productType "Toy".
- Respond with valid JSON only, no markdown fences.

Example input: "포켓몬 카드 151 박스 한글판"
Example output: {"title":"Pokemon Card 151 Booster Box Korean Ver","description":"<p>Pokemon Card Game 151 Booster Box, Korean version. Factory sealed with 20 booster packs per box.</p><ul><li><strong>Brand:</strong> Pokemon</li><li><strong>Origin:</strong> Korea, South</li><li><strong>Condition:</strong> New</li><li><strong>Material:</strong> PP, Paper</li><li><strong>Color:</strong> Multiple Color</li><li>100% Official Licensed Genuine Item</li><li>All cards are randoms</li></ul>","productType":"Collectible Card Game","tags":["Pokemon","TCG","151","Booster Box","Korean"]}

Example input: "방탄소년단 BTS 앨범 프루프"
Example output: {"title":"BTS Album Proof Anthology 3CD Set","description":"<p>BTS Proof anthology album. 3-CD set featuring greatest hits and unreleased tracks.</p><ul><li><strong>Brand:</strong> BTS / HYBE</li><li><strong>Origin:</strong> Korea, South</li><li><strong>Condition:</strong> New</li><li><strong>Format:</strong> 3CD Set</li><li>100% Official Licensed Genuine Item</li></ul>","productType":"Music Recording","tags":["BTS","K-Pop","Proof","Album","Anthology"]}`;

function fallback(titleKo: string): TranslateResult {
  return { title: titleKo, description: null, productType: null, tags: [] };
}

/**
 * 단건 상품 번역 (Gemini 2.5 Flash)
 * API 키 미설정 또는 실패 시 한글 원본 반환
 */
export async function translateProduct(
  titleKo: string,
  rawData?: Record<string, any>,
): Promise<TranslateResult> {
  if (!env.GEMINI_API_KEY) {
    console.warn('[translate] GEMINI_API_KEY 미설정 — 번역 건너뜀');
    return fallback(titleKo);
  }

  // 카테고리/브랜드 힌트 구성
  const hints: string[] = [];
  if (rawData?.category) hints.push(`원본 카테고리 (참고용): ${rawData.category}`);
  if (rawData?.brand) hints.push(`브랜드: ${rawData.brand}`);
  const hintText = hints.length > 0 ? `\n${hints.join('\n')}\n` : '';

  try {
    const res = await fetch(`${GEMINI_URL}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${TRANSLATE_PROMPT}\n${hintText}\nInput: "${titleKo}"`,
          }],
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 512,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[translate] Gemini API 에러 (${res.status}):`, errText);
      return fallback(titleKo);
    }

    const data = await res.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[translate] Gemini 응답에 텍스트 없음:', JSON.stringify(data));
      return fallback(titleKo);
    }

    // JSON 파싱 (마크다운 코드 블록 제거)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 500) : titleKo,
      description: typeof parsed.description === 'string' ? parsed.description : null,
      productType: typeof parsed.productType === 'string' ? parsed.productType : null,
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: any) => typeof t === 'string') : [],
    };
  } catch (err) {
    console.error('[translate] 번역 실패:', err);
    return fallback(titleKo);
  }
}

/**
 * 배치 상품 번역
 * 순차 처리 (Gemini rate limit 고려, 각 요청 사이 200ms 딜레이)
 */
export async function translateProductBatch(
  items: { id: number; titleKo: string; rawData?: Record<string, any> }[],
): Promise<Map<number, TranslateResult>> {
  const results = new Map<number, TranslateResult>();

  for (const item of items) {
    const result = await translateProduct(item.titleKo, item.rawData);
    results.set(item.id, result);

    // rate limit 방지 딜레이
    if (items.indexOf(item) < items.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}
