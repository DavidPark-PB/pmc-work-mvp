/**
 * AI Workflow Publisher (2026-08-09) — 워크플로우 4단계 배포 오케스트레이션.
 *
 * 사장님 승인: eBay + Shopify 먼저 지원.
 *
 * 입력:
 *   product = {
 *     title, description (HTML), price, quantity,
 *     imageUrls: [url...],           // 원본 (외부 URL — eBay/Shopify 모두 그대로 전달 가능)
 *     thumbnailsBase64: [{platform, base64}],  // 3단계 결과 (base64 dataURL)
 *     itemSpecifics: {Brand, ...},
 *     sku (optional — 없으면 자동생성),
 *     currency, competitorItemId, seoKeywords,
 *   }
 *   platforms = ['ebay', 'shopify']
 *   presets   = { ebay: {...override}, shopify: {...override} }
 *   userId    = req.user.id (감사 로그)
 *
 * 각 플랫폼 병렬 시도. 하나 실패해도 나머지 계속. 결과 배열 반환.
 */
'use strict';

// 사장님 대부분 상품이 TCG 카드라 아래가 안전한 default. 필요시 preset 으로 override.
const DEFAULT_PRESETS = {
  ebay: {
    // 2026-08-09: 사장님 실제 성공 리스팅 206202404025 값 그대로 복사.
    //   category 183454 (CCG Individual Cards), condition 4000 (Ungraded),
    //   itemSpecifics: Game/Type/Manufacturer/Language/Age Level/Country of Origin.
    //   Brand/Grade 는 실제 리스팅에 없어서 제외 (있으면 오히려 required 검증 실패).
    categoryId: '183454',
    conditionId: '4000',
    currency: 'USD',
    quantity: 1,
    dispatchTimeMax: 3,
    listingDuration: 'GTC',
    itemSpecifics: {
      Game: 'Pokémon TCG',
      Type: 'Booster Box',
      Manufacturer: 'The Pokémon Company',
      Language: 'Korean',
      'Age Level': '6+',
      'Country of Origin': 'Korea, Republic of',
      'Card Condition': 'Near mint or better',   // aspect 40001 필수
    },
  },
  shopify: {
    vendor: 'PMC',
    productType: 'Trading Card',
    status: 'active',
    inventoryPolicy: 'deny',
    quantity: 1,
    tags: 'Pokemon,TCG,Trading Card,Korea',
  },
};

function _generateSku(base) {
  const t = Date.now().toString(36);
  const clean = String(base || 'PMC').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return `PMC-${clean}-${t}`;
}

function _mergePreset(platform, override = {}) {
  const base = DEFAULT_PRESETS[platform] || {};
  return {
    ...base,
    ...override,
    itemSpecifics: { ...(base.itemSpecifics || {}), ...(override.itemSpecifics || {}) },
  };
}

/**
 * eBay 등록. base64 썸네일 있으면 EPS 업로드 후 URL 획득해서 함께 전달.
 */
let _ebayInstance = null;
function _getEbay() {
  if (!_ebayInstance) {
    const EbayAPI = require('../api/ebayAPI');
    _ebayInstance = new EbayAPI();
  }
  return _ebayInstance;
}

async function publishToEbay(product, preset) {
  const ebay = _getEbay();
  const t0 = Date.now();

  // 1) base64 썸네일 → EPS FullURL
  const thumbnailUrls = [];
  const ebayThumbs = (product.thumbnailsBase64 || []).filter(t => t.platform === 'ebay' || !t.platform);
  for (const thumb of ebayThumbs) {
    try {
      const r = await ebay.uploadBase64Picture({ base64: thumb.base64, pictureName: `ai-wf-${Date.now()}` });
      if (r.success && r.picture_url) thumbnailUrls.push(r.picture_url);
    } catch (e) {
      console.warn('[aiWfPublish] eBay EPS 업로드 실패:', e.message);
    }
  }

  // 2) 등록. imageUrls 순서: 썸네일 먼저 (썸네일이 갤러리 첫 이미지가 됨) + 원본 이미지
  const allImages = [...thumbnailUrls, ...(product.imageUrls || [])].slice(0, 12);  // eBay 12장 제한

  const result = await ebay.createProduct({
    title: String(product.title || '').slice(0, 80),
    description: product.description || product.title || '',
    price: Number(product.price) || 0,
    quantity: preset.quantity || product.quantity || 1,
    sku: product.sku || _generateSku(product.competitorItemId || product.title),
    categoryId: preset.categoryId,
    conditionId: preset.conditionId,
    imageUrls: allImages,
    currency: preset.currency || 'USD',
    itemSpecifics: {
      ...(preset.itemSpecifics || {}),
      ...(product.itemSpecifics || {}),
    },
  });

  return {
    platform: 'ebay',
    success: !!(result?.success && result?.itemId),
    itemId: result?.itemId,
    listingUrl: result?.itemId ? `https://www.ebay.com/itm/${result.itemId}` : null,
    thumbnailUploaded: thumbnailUrls.length,
    error: result?.success ? null : (result?.error || 'unknown'),
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Shopify 등록. base64 썸네일은 REST attachment 지원, URL 은 src 로.
 */
async function publishToShopify(product, preset) {
  const ShopifyAPI = require('../api/shopifyAPI');
  const shopify = new ShopifyAPI();
  const t0 = Date.now();

  // Shopify: base64 는 {attachment, filename} 형태, URL 은 {src}
  const shopifyThumbs = (product.thumbnailsBase64 || [])
    .filter(t => t.platform === 'shopify' || !t.platform)
    .map((t, i) => {
      const raw = String(t.base64).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      return { attachment: raw, filename: `ai-wf-${i}.png` };
    });
  const urlImages = (product.imageUrls || []).map(u => ({ src: u }));
  const allImages = [...shopifyThumbs, ...urlImages].slice(0, 20);   // Shopify 20장

  const result = await shopify.createProduct({
    title: product.title,
    sku: product.sku || _generateSku(product.competitorItemId || product.title),
    price: product.price,
    bodyHtml: product.description || '',
    vendor: preset.vendor,
    productType: preset.productType,
    images: allImages,
    tags: preset.tags,
    status: preset.status,
    quantity: preset.quantity || product.quantity || 1,
    inventoryPolicy: preset.inventoryPolicy,
  });

  return {
    platform: 'shopify',
    success: !!result?.success,
    productId: result?.productId,
    variantId: result?.variantId,
    listingUrl: result?.publicUrl || result?.adminUrl,
    adminUrl: result?.adminUrl,
    thumbnailUploaded: shopifyThumbs.length,
    error: result?.success ? null : (result?.error ? JSON.stringify(result.error) : 'unknown'),
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 여러 플랫폼 병렬 배포. 하나 실패해도 나머지 계속.
 */
async function publish({ product, platforms = ['ebay', 'shopify'], presets = {}, userId } = {}) {
  if (!product || !product.title) throw new Error('product.title 필수');
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error('platforms 필수');

  const tasks = platforms.map(async (p) => {
    const preset = _mergePreset(p, presets[p] || {});
    try {
      if (p === 'ebay') return await publishToEbay(product, preset);
      if (p === 'shopify') return await publishToShopify(product, preset);
      return { platform: p, success: false, error: `unsupported platform: ${p}` };
    } catch (e) {
      return { platform: p, success: false, error: e.message };
    }
  });

  const results = await Promise.all(tasks);
  return { results, totalRequested: platforms.length, totalSucceeded: results.filter(r => r.success).length };
}

module.exports = {
  publish,
  publishToEbay,
  publishToShopify,
  DEFAULT_PRESETS,
};
