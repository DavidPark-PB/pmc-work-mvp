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

// 카테고리/조건/currency 등 eBay 필수 메타는 default 유지. itemSpecifics 는 경쟁사 fetch
// 결과를 그대로 사용 · 하드코딩 기본값 없음.
const DEFAULT_PRESETS = {
  ebay: {
    // 2026-08-09: 사장님 성공 리스팅 (183454) 은 옛날 리스팅이라 살아있지만, eBay 는 이제
    //   Single Cards 카테고리에 Booster Box 신규 등록을 정책 위반으로 거부함. VerifyAdd 로
    //   183456 (CCG Sealed Booster Boxes) + conditionId=1000 (New) + Set aspect 조합만
    //   통과 확인됨. Card Condition/ConditionDescriptor 는 New 상품엔 불필요.
    //   Booster Pack 이면 183455 (Sealed Booster Packs) / Type='Booster Pack'.
    categoryId: '183456',
    conditionId: '1000',
    currency: 'USD',
    quantity: 1,
    dispatchTimeMax: 3,
    listingDuration: 'GTC',
    // 2026-08-30: Pokemon TCG 하드코딩 (Game/Type/Manufacturer/Language/Age Level/
    //   Country of Origin/Set) 완전 제거. 경쟁사 fetch (localizedAspects) 결과를
    //   그대로 사용. Yu-Gi-Oh / K-Pop 등 비-Pokemon 상품 등록 시 preset 기본값이
    //   Manufacturer='The Pokémon Company' 로 오염되는 사고 방지. 카테고리별
    //   required aspect 부족은 verify-ebay (VerifyAddFixedPriceItem) 가 판정.
    //   사용자가 특정 preset 을 저장하고 싶으면 aiWorkflow.js UI 에서 편집
    //   → localStorage 에 저장됨 · 이 default 는 첫 사용자에게만 적용됨.
    itemSpecifics: {},
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
 *
 * ── 왜 싱글턴이 아닌가 (2026-09-19) ──────────────────────────────────
 *   과거 이 파일은 `_ebayInstance` 를 모듈 스코프 싱글턴으로 유지했다.
 *   `EbayAPI._ensureToken()` 은 인스턴스당 1회만 DB 에서 토큰을 로드하기
 *   때문에 (`ebayAPI.js:99-113`), 서버 프로세스가 한번 뜬 뒤 만들어진
 *   싱글턴은 그 뒤로 `refreshAccessToken()` 을 통해서만 자기 캐시를
 *   갱신했다. 문제는 다른 코드 경로 (competitorMonitor · myListingRefresher ·
 *   기타 스케줄 등) 가 자기만의 EbayAPI 인스턴스로 refresh 를 돌리면서
 *   DB 의 refresh_token 을 rotation 시키면, aiWorkflow 싱글턴이 붙들고
 *   있던 refresh_token 이 무효화되어 다음 AddFixedPriceItem 호출이
 *   `EBAY_MUTATION_TOKEN_INVALID_UNCERTAIN` 로 fail-closed 되는 사고
 *   (owner 신고 · 2026-09-18 · N번째 상품 등록부터 계속 실패).
 *
 *   AddFixedPriceItem 은 mutation-safe 이므로 fail-closed 자체는
 *   유지 (`PMC-EXPORT-SAFETY-2F` · 이중 등록 방지). 대신 그 fail-closed
 *   가 stale singleton 때문에 유발되지 않도록 매 등록마다 새 인스턴스를
 *   만들어 첫 `callTradingAPI` 진입 시 `_ensureToken()` 이 DB 의 최신
 *   토큰을 로드하게 한다. 오버헤드는 인스턴스당 DB SELECT 1회 (~50ms) —
 *   수천 건 등록에도 무시할 수준.
 */
function _getEbay() {
  const EbayAPI = require('../api/ebayAPI');
  return new EbayAPI();
}

function _buildEbayParams(product, preset, thumbnailUrls) {
  const allImages = [...thumbnailUrls, ...(product.imageUrls || [])].slice(0, 12);
  //   2026-09-23: Card Condition for Trading Cards is NOT an item aspect —
  //   it lives in <ConditionDescriptors>, a separate Item child. We pass
  //   the raw condition context (string + id) to _buildItemXml so the
  //   descriptor block is emitted at the correct XML location.
  const { _injectRequiredAspects } = require('../api/ebayAPI');
  const mergedSpecs = {
    ...(preset.itemSpecifics || {}),
    ...(product.itemSpecifics || {}),
  };
  const conditionString = product.conditionDisplayName
                       || product.condition
                       || preset.conditionDisplayName
                       || '';
  const conditionId     = preset.conditionId;
  const finalSpecs = _injectRequiredAspects(mergedSpecs, preset.categoryId, {
    conditionString, conditionId,
  });
  return {
    title: String(product.title || '').slice(0, 80),
    description: product.description || product.title || '',
    price: Number(product.price) || 0,
    quantity: preset.quantity || product.quantity || 1,
    sku: product.sku || _generateSku(product.competitorItemId || product.title),
    categoryId: preset.categoryId,
    conditionId,
    imageUrls: allImages,
    currency: preset.currency || 'USD',
    itemSpecifics: finalSpecs,
    //   Consumed by ebayAPI._buildItemXml → _buildConditionDescriptors to
    //   emit the <ConditionDescriptors> block for Trading Card categories.
    conditionDescriptorContext: { conditionString, conditionId },
  };
}

/**
 * 2026-08-09: eBay 사전 검증 (VerifyAddFixedPriceItem) — 실 등록 X, rate limit 안 소진.
 * verifyOnly=true 면 EPS 업로드도 스킵 (이미지 없이 검증).
 */
async function verifyEbay(product, preset, { skipImageUpload = true } = {}) {
  const ebay = _getEbay();
  const t0 = Date.now();
  const params = _buildEbayParams(product, preset, skipImageUpload ? (product.imageUrls || []).slice(0, 1) : []);
  const r = await ebay.verifyProduct(params);
  return {
    platform: 'ebay',
    verify: true,
    success: r.success,
    ack: r.ack,
    errors: r.errors,
    criticalErrors: r.criticalErrors,
    warnings: r.warnings,
    elapsedMs: Date.now() - t0,
  };
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

  const params = _buildEbayParams(product, preset, thumbnailUrls);
  const result = await ebay.createProduct(params);

  return {
    platform: 'ebay',
    success: !!(result?.success && result?.itemId),
    itemId: result?.itemId,
    listingUrl: result?.itemId ? `https://www.ebay.com/itm/${result.itemId}` : null,
    thumbnailUploaded: thumbnailUrls.length,
    error: result?.success ? null : (result?.error || 'unknown'),
    errors: result?.errors || [],
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
 *
 * 2026-08-30: 성공한 eBay 리스팅은 원본 경쟁사와 pair 로 aiPublicationMonitor 에 등록되어
 *   30일 동안 undercut 감지 대상이 됨. Shopify 는 경쟁사 매칭 개념이 없어 skip.
 *   product.competitorItemId 없거나 (파일 업로드 경로) 훅 실패해도 발행 결과 자체는 반환.
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

  // Undercut 모니터링 등록 — 성공한 eBay 결과가 있고 경쟁사 itemId 를 갖고 있을 때만.
  try {
    const ebayOk = results.find(r => r && r.platform === 'ebay' && r.success && r.itemId);
    if (ebayOk && product.competitorItemId) {
      const monitor = require('./aiPublicationMonitor');
      await monitor.recordPublication({
        myEbayItemId:             String(ebayOk.itemId),
        myPublishPrice:           Number(product.price) || null,
        competitorItemId:         String(product.competitorItemId),
        competitorPriceAtPublish: Number(product.competitorPrice) || null,
        createdBy:                Number.isFinite(Number(userId)) ? Number(userId) : null,
      });
    }
  } catch (e) {
    console.warn('[aiWfPublish] undercut monitor hook 실패 (발행 자체는 성공):', e.message);
  }

  return { results, totalRequested: platforms.length, totalSucceeded: results.filter(r => r.success).length };
}

module.exports = {
  publish,
  publishToEbay,
  publishToShopify,
  verifyEbay,
  DEFAULT_PRESETS,
};
