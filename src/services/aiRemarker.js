require('dotenv').config({ path: require('path').join(__dirname, '../../config/.env') });
const axios = require('axios');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MODEL_FALLBACK = 'claude-haiku-4-5-20251001';

// 영문 리스팅 고정 템플릿 — 간결 버전
const ENGLISH_LISTING_FOOTER = `
<div style="max-width:800px;margin:24px auto 0;font-family:Arial,sans-serif;color:#333;font-size:13px;line-height:1.6">
  <p style="color:#999;font-size:11px">※ Actual color may vary slightly depending on monitor settings.</p>
  <hr style="border:none;border-top:1px solid #e0e0e0;margin:14px 0">
  <p><strong>◆ Shipping</strong> — Ships from South Korea within 2–3 business days.<br>
  Economy: 10–20 days (free, no tracking) | Standard: 7–14 days (tracked, additional fee)</p>
  <p><strong>◆ Duties & Taxes</strong><br>
  US: DDP (no extra fees) | EU: VAT via IOSS at checkout | Others: buyer responsibility (DAP)</p>
  <p><strong>◆ Payment</strong> — PayPal only. Please pay within 3 days.</p>
  <p><strong>◆ Returns</strong> — 30-day money back guarantee. Buyer pays return shipping unless item is defective.</p>
  <p style="margin-top:14px;font-size:11px;color:#888">All items 100% authentic & officially licensed. Questions? Send us a message anytime.</p>
</div>`;

// 빠른 모드용 plain text 버전 — 간결
const ENGLISH_LISTING_FOOTER_TEXT = `

---
※ Actual color may vary slightly depending on monitor settings.

◆ Shipping — Ships from South Korea within 2-3 business days.
Economy: 10-20 days (free, no tracking) | Standard: 7-14 days (tracked, additional fee)

◆ Duties & Taxes
US: DDP (no extra fees) | EU: VAT via IOSS at checkout | Others: buyer responsibility (DAP)

◆ Payment — PayPal only. Please pay within 3 days.

◆ Returns — 30-day money back guarantee. Buyer pays return shipping unless item is defective.

All items 100% authentic & officially licensed. Questions? Send us a message anytime.`;

class AIRemarker {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
  }

  /**
   * 경쟁사 데이터를 AI로 리메이크
   * @param {Object} data - getCompetitorItemFull() 결과
   * @returns {Object} 리메이크된 상품 데이터
   */
  async remake(data) {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY가 config/.env에 설정되지 않았습니다');
    }

    const prompt = this._buildPrompt(data);

    const callAPI = async (model) => {
      return axios.post(ANTHROPIC_API_URL, {
        model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 60000
      });
    };

    let response;
    try {
      response = await callAPI(MODEL);
    } catch (err) {
      const apiErr = err.response?.data?.error?.message || err.message;
      console.error('Claude API 1차 실패:', apiErr);
      console.log('Fallback 모델로 재시도:', MODEL_FALLBACK);
      try {
        response = await callAPI(MODEL_FALLBACK);
      } catch (err2) {
        const apiErr2 = err2.response?.data?.error?.message || err2.message;
        console.error('Claude API 2차 실패:', apiErr2);
        throw new Error(`AI API 호출 실패: ${apiErr2}`);
      }
    }

    const text = response.data?.content?.[0]?.text || '';
    return this._parseResponse(text, data);
  }

  _buildPrompt(data) {
    const totalCompPrice = (data.price + data.shippingCost).toFixed(2);
    const ourShipping = 3.90;
    const killPrice = Math.max(1.00, data.price + data.shippingCost - 2.00 - ourShipping);

    const specificsText = Object.entries(data.itemSpecifics || {})
      .map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';

    const imagesText = (data.pictureURLs || [])
      .map((url, i) => `  Image ${i + 1}: ${url}`).join('\n') || '  (none)';

    // description에서 HTML 태그 제거한 텍스트 (프롬프트 크기 절약)
    const descPlain = (data.description || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 2000);

    const imageCount = (data.pictureURLs || []).length;

    return `You are an eBay listing SEO expert. Create a clean, professional listing — images prominent, text concise but informative.

COMPETITOR DATA:
- Title: "${data.title}"
- Price: $${data.price.toFixed(2)} + $${data.shippingCost.toFixed(2)} shipping = $${totalCompPrice} total
- Category: ${data.categoryName || 'Unknown'} (ID: ${data.categoryId || 'N/A'})
- Condition: ${data.conditionDisplayName || 'New'}
- Sold: ${data.quantitySold} units
- Images: ${imageCount} images
${imagesText}
- Item Specifics:
${specificsText}
- Description extract:
${descPlain}

1. **SEO Title** (75-80 chars):
   - Brand + Product + Key Spec + Condition
   - Natural English, high-search-volume keywords

2. **HTML Description** (eBay inline CSS only, NO external CSS/JS):
   Layout order:
   a) ALL ${imageCount} product images displayed large at the top
      - Each: style="width:100%;max-width:800px;display:block;margin:0 auto 8px"
   b) Product name heading (bold, styled)
   c) Product description — 1 short paragraph (3-4 sentences). Factual, confident tone.
      Mention what it is, key features, who it's for. No fluff.
   d) Specs table — clean 2-column table with inline styles (max 8 rows)
      Include: Brand, Origin, Material, Condition, Quantity/Contents, etc.
   e) Shipping & Policy section — compact but complete:
      - Ships from Korea
      - Economy: 10-20 business days (free) | Standard: 7-14 days (+$3, tracked)
      - US: DDP (no extra fees) | EU: VAT collected via IOSS | Other: buyer pays duties
      - 30-day money back guarantee
      - PayPal only, pay within 3 days
   f) Footer: "PMC Corporation — Premium Quality Verified" (1 line, styled)

   Style: colors #1a1a2e (dark), #e94560 (accent), #f8f9fa (light bg)
   Max-width: 800px, centered, mobile-friendly.
   Balance: ~50% images, ~50% text. NOT an essay, NOT a summary. Just right.

3. **Kill Price**: $${killPrice.toFixed(2)}

4. **SEO Keywords**: 5-8 search keywords.

RESPOND IN PURE JSON ONLY (no markdown, no explanation):
{
  "title": "...",
  "description": "<div style=\\"max-width:800px;margin:0 auto;font-family:Arial,sans-serif\\">...</div>",
  "killPrice": ${killPrice.toFixed(2)},
  "suggestedShipping": ${ourShipping.toFixed(2)},
  "imageCaptions": ["caption1", "caption2"],
  "extractedBrand": "...",
  "extractedPartNumber": "...",
  "extractedCompatibility": "...",
  "seoKeywords": ["keyword1", "keyword2", "keyword3"]
}`;
  }

  /**
   * 업로드된 썸네일+상세페이지 HTML에서 핵심 추출 → 재구성
   * @param {Object} data - { htmlContent, imageCount }
   * @returns {Object} { title, description, extractedSpecs, brand, seoKeywords }
   */
  async reconstruct(data) {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY가 config/.env에 설정되지 않았습니다');
    }

    const isFast = data.mode === 'fast';
    const prompt = isFast ? this._buildFastPrompt(data) : this._buildReconstructPrompt(data);

    // Vision API: 이미지 블록 + 텍스트 프롬프트
    const content = [];
    const imagesToSend = isFast ? (data.images || []).slice(0, 1) : (data.images || []);
    imagesToSend.forEach(img => {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      });
    });
    content.push({ type: 'text', text: prompt });

    const model = isFast ? MODEL_FALLBACK : MODEL;
    const maxTokens = isFast ? 1500 : 4000;
    const timeout = isFast ? 30000 : 120000;

    const callAPI = async (m) => {
      return axios.post(ANTHROPIC_API_URL, {
        model: m,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }]
      }, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout
      });
    };

    let response;
    try {
      response = await callAPI(model);
    } catch (err) {
      const apiErr = err.response?.data?.error?.message || err.message;
      console.error('Reconstruct 1차 실패:', apiErr);
      if (!isFast) {
        console.log('Reconstruct Fallback:', MODEL_FALLBACK);
        try {
          response = await callAPI(MODEL_FALLBACK);
        } catch (err2) {
          const apiErr2 = err2.response?.data?.error?.message || err2.message;
          console.error('Reconstruct 2차 실패:', apiErr2);
          throw new Error(`AI API 호출 실패: ${apiErr2}`);
        }
      } else {
        throw new Error(`AI API 호출 실패: ${apiErr}`);
      }
    }

    const text = response.data?.content?.[0]?.text || '';
    return this._parseReconstructResponse(text, data);
  }

  _buildFastPrompt(data) {
    const lang = data.lang || 'en';
    const htmlPlain = (data.htmlContent || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1500);

    let langNote = '';
    let schema = '';

    if (lang === 'ko') {
      langNote = 'Write title and description in Korean (한국어).';
      schema = '{"title":"한글 제목","description":"간결한 한글 설명 2-3문장","extractedBrand":"","extractedSpecs":{},"seoKeywords":["키워드"]}';
    } else if (lang === 'both') {
      langNote = 'Write in BOTH English AND Korean.';
      schema = '{"titleEn":"English title","titleKo":"한글 제목","descriptionEn":"English 2-3 sentences","descriptionKo":"한글 2-3문장","extractedBrand":"","extractedSpecs":{},"seoKeywordsEn":["kw"],"seoKeywordsKo":["키워드"]}';
    } else {
      langNote = 'Write in English.';
      schema = '{"title":"SEO title 75-80 chars","description":"2-3 sentence description","extractedBrand":"","extractedSpecs":{},"seoKeywords":["keyword"]}';
    }

    return `Analyze the product image${htmlPlain ? ' and text' : ''} and extract key info. ${langNote}
${htmlPlain ? `\nText: ${htmlPlain}` : ''}

Return PURE JSON (no markdown): ${schema}

Rules: title=SEO optimized, description=plain text 2-3 sentences (NO HTML), specs=key product specs object, keywords=5-8 search terms.`;
  }

  _buildReconstructPrompt(data) {
    const htmlPlain = (data.htmlContent || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000);

    const imageCount = data.imageCount || 0;
    const hasImages = (data.images || []).length > 0;
    const hasHtml = htmlPlain.length > 0;
    const lang = data.lang || 'en';

    let sourceSection = '';
    if (hasImages) {
      sourceSection += `\nI've attached ${imageCount} product images above. Analyze them carefully to identify: product name, brand, material, color, size, key features, and any text visible on packaging.\n`;
    }
    if (hasHtml) {
      sourceSection += `\nSOURCE DETAIL PAGE TEXT:\n${htmlPlain}\n`;
    }

    // 언어별 지시
    let langInstruction = '';
    let jsonSchema = '';

    if (lang === 'ko') {
      langInstruction = `
LANGUAGE: Write ALL content in Korean (한국어).
- Title: 한글 SEO 최적화 제목 (40-60자)
- Description: 한글로 작성. 배송/정책 섹션은 포함하지 마세요.
- Keywords: 한글 검색 키워드`;
      jsonSchema = `{
  "title": "한글 SEO 제목",
  "description": "<div style=\\"max-width:800px;margin:0 auto;font-family:Arial,sans-serif\\">한글 상세페이지 HTML</div>",
  "extractedBrand": "브랜드명",
  "extractedSpecs": { "소재": "값", "색상": "값" },
  "extractedFeatures": ["특징1", "특징2"],
  "seoKeywords": ["키워드1", "키워드2"]
}`;
    } else if (lang === 'both') {
      langInstruction = `
LANGUAGE: Generate content in BOTH English AND Korean.
- English title: 75-80 chars, SEO optimized for eBay/Shopify
- Korean title: 40-60자, 쿠팡/네이버 SEO 최적화
- English description: product info + specs only (shipping/policy added automatically)
- Korean description: 제품 설명+스펙만
- Keywords in both languages`;
      jsonSchema = `{
  "titleEn": "English SEO title 75-80 chars",
  "titleKo": "한글 SEO 제목 40-60자",
  "descriptionEn": "<div style=\\"max-width:800px;margin:0 auto;font-family:Arial,sans-serif\\">English HTML</div>",
  "descriptionKo": "<div style=\\"max-width:800px;margin:0 auto;font-family:Arial,sans-serif\\">한글 HTML</div>",
  "extractedBrand": "brand",
  "extractedSpecs": { "key": "value" },
  "extractedFeatures": ["feature1", "feature2"],
  "seoKeywordsEn": ["keyword1", "keyword2"],
  "seoKeywordsKo": ["키워드1", "키워드2"]
}`;
    } else {
      langInstruction = `
LANGUAGE: Write ALL content in English.
- Title: 75-80 chars, SEO optimized
- Keywords: English search keywords`;
      jsonSchema = `{
  "title": "English SEO title 75-80 chars",
  "description": "<div style=\\"max-width:800px;margin:0 auto;font-family:Arial,sans-serif\\">English HTML</div>",
  "extractedBrand": "brand or empty",
  "extractedSpecs": { "key": "value" },
  "extractedFeatures": ["feature1", "feature2"],
  "seoKeywords": ["keyword1", "keyword2"]
}`;
    }

    const layoutKo = `a) 상품명 헤딩 (bold, styled)
b) 상품 설명 — 짧은 단락 (3-4문장). 사실적이고 자신감 있는 톤.
c) 스펙 테이블 — 2열 테이블, 인라인 스타일 (최대 8행)
d) 푸터: "PMC Corporation — Premium Quality Verified"`;

    const layoutEn = `a) Product name heading (bold, styled)
b) Product description — 1 short paragraph (3-4 sentences). Factual, confident tone.
c) Specs table — clean 2-column table with inline styles (max 8 rows)
d) Footer: "PMC Corporation — Premium Quality Verified"
IMPORTANT: Do NOT include any shipping, payment, return policy, or about us sections. These will be added automatically by the system.`;

    const layoutBoth = `
For English description:
${layoutEn}

For Korean description (한글):
${layoutKo}`;

    let layoutSection = '';
    if (lang === 'ko') layoutSection = layoutKo;
    else if (lang === 'both') layoutSection = layoutBoth;
    else layoutSection = layoutEn;

    return `You are a product listing SEO expert. Analyze the provided product data and create a professional NEW listing.
${sourceSection}
${langInstruction}

YOUR TASK:
1. **Extract** key product info from images/text: product name, brand, specs, features, condition
2. **Create** SEO-optimized title(s)
3. **Create** HTML description(s) — NO image tags in the HTML (images are handled separately)

HTML Description rules (inline CSS only, NO external CSS/JS):
Layout:
${layoutSection}

Style: colors #1a1a2e (dark), #e94560 (accent), #f8f9fa (light bg)
Max-width: 800px, centered, mobile-friendly.

RESPOND IN PURE JSON ONLY (no markdown fences, no explanation):
${jsonSchema}`;
  }

  _parseReconstructResponse(text, data) {
    console.log('AI reconstruct 응답 길이:', text.length);

    // 마크다운 코드펜스 제거
    let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); }
        catch { throw new Error('AI 응답 JSON 파싱 실패'); }
      } else {
        throw new Error('AI 응답에서 JSON을 찾을 수 없음: ' + cleaned.substring(0, 100));
      }
    }

    const lang = data.lang || 'en';
    const isFast = data.mode === 'fast';

    // 영문 description에 고정 템플릿 자동 붙이기
    const enFooter = isFast ? ENGLISH_LISTING_FOOTER_TEXT : ENGLISH_LISTING_FOOTER;

    if (lang === 'both') {
      let descEn = parsed.descriptionEn || parsed.description || '';
      if (descEn) descEn += enFooter;
      return {
        lang: 'both',
        titleEn: parsed.titleEn || parsed.title || '',
        titleKo: parsed.titleKo || '',
        descriptionEn: descEn,
        descriptionKo: parsed.descriptionKo || '',
        extractedBrand: parsed.extractedBrand || '',
        extractedSpecs: parsed.extractedSpecs || {},
        extractedFeatures: Array.isArray(parsed.extractedFeatures) ? parsed.extractedFeatures : [],
        seoKeywordsEn: Array.isArray(parsed.seoKeywordsEn) ? parsed.seoKeywordsEn : (Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords : []),
        seoKeywordsKo: Array.isArray(parsed.seoKeywordsKo) ? parsed.seoKeywordsKo : [],
      };
    }

    let desc = parsed.description || parsed.descriptionEn || parsed.descriptionKo || '';
    // 영문 모드일 때만 고정 템플릿 추가 (한글 모드는 제외)
    if (lang === 'en' && desc) desc += enFooter;

    return {
      lang,
      title: parsed.title || parsed.titleEn || parsed.titleKo || '',
      description: desc,
      extractedBrand: parsed.extractedBrand || '',
      extractedSpecs: parsed.extractedSpecs || {},
      extractedFeatures: Array.isArray(parsed.extractedFeatures) ? parsed.extractedFeatures : [],
      seoKeywords: Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords : [],
    };
  }

  _parseResponse(text, original) {
    let parsed;

    // JSON 파싱 시도
    try {
      parsed = JSON.parse(text);
    } catch {
      // 마크다운 코드 펜스 제거 후 재시도
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          throw new Error('AI 응답 JSON 파싱 실패');
        }
      } else {
        throw new Error('AI 응답에서 JSON을 찾을 수 없음');
      }
    }

    // 필수 필드 검증 + 기본값
    return {
      title: parsed.title || original.title,
      description: parsed.description || '',
      killPrice: parseFloat(parsed.killPrice) || Math.max(1, original.price - 2),
      suggestedShipping: parseFloat(parsed.suggestedShipping) || 3.90,
      imageCaptions: Array.isArray(parsed.imageCaptions) ? parsed.imageCaptions : [],
      extractedBrand: parsed.extractedBrand || '',
      extractedPartNumber: parsed.extractedPartNumber || '',
      extractedCompatibility: parsed.extractedCompatibility || '',
      seoKeywords: Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords : [],
      // 원본 이미지 유지
      pictureURLs: original.pictureURLs || [],
      categoryId: original.categoryId || '',
      categoryName: original.categoryName || '',
      conditionId: original.conditionId || '',
      conditionDisplayName: original.conditionDisplayName || '',
      originalPrice: original.price,
      originalShipping: original.shippingCost,
      competitorSeller: original.seller,
    };
  }
}

module.exports = AIRemarker;
