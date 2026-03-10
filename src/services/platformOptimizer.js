/**
 * 플랫폼별 상품 데이터 자동 최적화
 * 마스터 상품 → 플랫폼별 최적화된 등록 데이터 변환
 *
 * DB-driven: optimize(platform, product, prices, options) 형태로
 * platform_mapping.platform_category_id, platforms.config 값을 외부에서 전달 가능.
 * 미전달 시 CATEGORY_MAP 폴백 사용 (하위호환).
 */

const DEFAULT_CATEGORY_MAP = {
  '전자기기': { ebay: '11450', naver: '50000803', shopify: 'Electronics' },
  '생활용품': { ebay: '11700', naver: '50000006', shopify: 'Home & Garden' },
  '의류':     { ebay: '11450', naver: '50000000', shopify: 'Clothing' },
  '뷰티':     { ebay: '26395', naver: '50000002', shopify: 'Beauty' },
  '기타':     { ebay: '11450', naver: '50000803', shopify: 'Other' },
};

// Backward-compatible alias
const CATEGORY_MAP = DEFAULT_CATEGORY_MAP;

function getCategoryIds(category) {
  return DEFAULT_CATEGORY_MAP[category] || DEFAULT_CATEGORY_MAP['기타'];
}

/**
 * eBay용 최적화 데이터 생성
 * @param {object} [options] - { categoryId, customFields, platformConfig }
 */
function optimizeForEbay(product, prices, options = {}) {
  const priceData = prices.ebay;
  if (!priceData || priceData.error) return null;

  const cfg = options.platformConfig || {};
  const titleMaxLen = cfg.title_max_length || 80;

  // Category: options.categoryId (from DB) > product field > CATEGORY_MAP fallback
  const categoryId = options.categoryId || product.ebayCategoryId || getCategoryIds(product.category).ebay;

  let title = (product.titleEn || product.title || '').substring(0, titleMaxLen);
  if (product.keywords && product.keywords.length > 0) {
    const remaining = titleMaxLen - title.length;
    if (remaining > 5) {
      const kw = product.keywords.filter(k => !title.toLowerCase().includes(k.toLowerCase()));
      for (const k of kw) {
        if (title.length + k.length + 1 <= titleMaxLen) {
          title += ' ' + k;
        }
      }
    }
  }

  const description = buildEbayDescription(product);

  // Condition map from DB config or default
  const conditionMap = cfg.condition_map || { 'new': '1000', 'used': '3000', 'refurbished': '2500' };
  const conditionId = conditionMap[product.condition] || '1000';

  return {
    title,
    description,
    price: priceData.price,
    quantity: parseInt(product.quantity) || 1,
    sku: product.sku,
    categoryId,
    conditionId,
    shippingCost: priceData.shipping,
    imageUrl: product.imageUrls && product.imageUrls[0],
    currency: 'USD',
    ...(options.customFields || {}),
  };
}

/**
 * Shopify용 최적화 데이터 생성
 */
function optimizeForShopify(product, prices, options = {}) {
  const priceData = prices.shopify;
  if (!priceData || priceData.error) return null;

  const cfg = options.platformConfig || {};
  const vendor = cfg.vendor || 'PMC';

  // Category: options.categoryId (from DB) > product field > CATEGORY_MAP fallback
  const productType = options.categoryId || product.shopifyProductType || getCategoryIds(product.category).shopify;

  const title = product.titleEn || product.title || '';
  const bodyHtml = buildShopifyDescription(product);
  const tags = (product.keywords || []).join(', ');

  return {
    title,
    sku: product.sku,
    price: String(priceData.price),
    bodyHtml,
    vendor,
    productType,
    tags,
    quantity: parseInt(product.quantity) || 1,
    imageUrl: product.imageUrls && product.imageUrls[0],
    ...(options.customFields || {}),
  };
}

/**
 * Naver용 최적화 데이터 생성
 */
function optimizeForNaver(product, prices, options = {}) {
  const priceData = prices.naver;
  if (!priceData || priceData.error) return null;

  const cfg = options.platformConfig || {};
  const titleMaxLen = cfg.title_max_length || 100;

  // Category: options.categoryId (from DB) > product field > CATEGORY_MAP fallback
  const categoryId = options.categoryId || product.naverCategoryId || getCategoryIds(product.category).naver;

  let productName = product.title || product.titleEn || '';
  if (product.keywords && product.keywords.length > 0) {
    const kw = product.keywords.filter(k => !productName.includes(k));
    for (const k of kw) {
      if (productName.length + k.length + 1 <= titleMaxLen) {
        productName += ' ' + k;
      }
    }
  }

  const detailContent = buildNaverDescription(product);

  return {
    productName,
    salePrice: priceData.price,
    stockQuantity: parseInt(product.quantity) || 1,
    categoryId,
    detailContent,
    imageUrls: product.imageUrls || [],
    ...(options.customFields || {}),
  };
}

/**
 * Qoo10용 최적화 데이터 생성
 */
function optimizeForQoo10(product, prices, options = {}) {
  const priceData = prices.qoo10;
  if (!priceData || priceData.error) return null;

  const title = (product.titleEn || product.title || '').substring(0, 100);

  return {
    itemTitle: title,
    sellingPrice: priceData.price,
    qty: parseInt(product.quantity) || 1,
    sku: product.sku,
    itemDetail: buildEbayDescription(product),
    imageUrl: product.imageUrls && product.imageUrls[0],
    currency: 'JPY',
    ...(options.customFields || {}),
  };
}

/**
 * Shopee용 최적화 데이터 생성
 */
function optimizeForShopee(product, prices, options = {}) {
  const priceData = prices.shopee;
  if (!priceData || priceData.error) return null;

  const title = (product.titleEn || product.title || '').substring(0, 120);
  const description = product.descriptionEn || product.description || '';

  return {
    name: title,
    description,
    price: priceData.price,
    stock: parseInt(product.quantity) || 1,
    sku: product.sku,
    images: (product.imageUrls || []).map(url => ({ url })),
    currency: 'LOCAL',
    ...(options.customFields || {}),
  };
}

/**
 * Coupang용 최적화 데이터 생성
 */
function optimizeForCoupang(product, prices, options = {}) {
  const priceData = prices.coupang;
  if (!priceData || priceData.error) return null;

  const title = (product.title || product.titleEn || '').substring(0, 100);
  const description = product.description || product.descriptionEn || '';

  return {
    displayProductName: title,
    salePrice: priceData.price,
    maximumBuyCount: 100,
    maximumBuyForPerson: 0,
    outboundShippingTimeDay: 2,
    returnCenterCode: '',
    deliveryChargeType: 'FREE',
    deliveryCharge: 0,
    content: description,
    images: (product.imageUrls || []).map((url, i) => ({
      imageOrder: i, imageType: i === 0 ? 'REPRESENTATIVE' : 'DETAIL', cdnPath: url,
    })),
    sku: product.sku,
    currency: 'KRW',
    ...(options.customFields || {}),
  };
}

/**
 * Alibaba용 최적화 데이터 생성
 */
function optimizeForAlibaba(product, prices, options = {}) {
  const priceData = prices.alibaba;
  if (!priceData || priceData.error) return null;

  const title = (product.titleEn || product.title || '').substring(0, 128);
  const description = product.descriptionEn || product.description || '';

  return {
    subject: title,
    description,
    price: priceData.price,
    quantity: parseInt(product.quantity) || 1,
    sku: product.sku,
    imageUrls: product.imageUrls || [],
    currency: 'USD',
    ...(options.customFields || {}),
  };
}

/**
 * 플랫폼별 최적화 통합 함수
 * @param {string} platform - Platform key ('ebay', 'shopify', 'naver', 'qoo10', 'shopee', 'coupang', 'alibaba')
 * @param {object} product - Enriched product data
 * @param {object} prices - Price calculation results from pricingEngine
 * @param {object} [options] - { categoryId, customFields, platformConfig }
 */
function optimize(platform, product, prices, options = {}) {
  switch (platform) {
    case 'ebay': return optimizeForEbay(product, prices, options);
    case 'shopify': return optimizeForShopify(product, prices, options);
    case 'naver': return optimizeForNaver(product, prices, options);
    case 'qoo10': return optimizeForQoo10(product, prices, options);
    case 'shopee': return optimizeForShopee(product, prices, options);
    case 'coupang': return optimizeForCoupang(product, prices, options);
    case 'alibaba': return optimizeForAlibaba(product, prices, options);
    default: return null;
  }
}

// --- Description Builders ---

function buildEbayDescription(product) {
  const title = product.titleEn || product.title || '';
  const desc = product.descriptionEn || product.description || title;
  const images = (product.imageUrls || [])
    .map(url => `<img src="${escapeHtml(url)}" style="max-width:600px;" />`)
    .join('<br>');

  return `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">
<h2>${escapeHtml(title)}</h2>
${images ? `<div style="text-align:center;margin:20px 0;">${images}</div>` : ''}
<div style="padding:15px;background:#f9f9f9;border-radius:8px;">
<p>${escapeHtml(desc)}</p>
</div>
<div style="margin-top:20px;padding:10px;background:#e8f5e9;border-radius:4px;">
<p><strong>SKU:</strong> ${escapeHtml(product.sku)}</p>
${product.weight ? `<p><strong>Weight:</strong> ${product.weight}kg</p>` : ''}
</div>
</div>`;
}

function buildShopifyDescription(product) {
  const desc = product.descriptionEn || product.description || '';
  const specs = [];
  if (product.weight) specs.push(`<li>Weight: ${product.weight}kg</li>`);
  if (product.sku) specs.push(`<li>SKU: ${escapeHtml(product.sku)}</li>`);

  return `<div>
<p>${escapeHtml(desc)}</p>
${specs.length > 0 ? `<ul>${specs.join('')}</ul>` : ''}
</div>`;
}

function buildNaverDescription(product) {
  const desc = product.description || product.descriptionEn || '';
  const images = (product.imageUrls || [])
    .map(url => `<img src="${escapeHtml(url)}" style="max-width:100%;" />`)
    .join('<br>');

  return `<div style="text-align:center;padding:20px;">
${images ? `<div style="margin-bottom:20px;">${images}</div>` : ''}
<h3>${escapeHtml(product.title || '')}</h3>
<p>${escapeHtml(desc)}</p>
${product.weight ? `<p>무게: ${product.weight}kg</p>` : ''}
</div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  optimize,
  optimizeForEbay, optimizeForShopify, optimizeForNaver,
  optimizeForQoo10, optimizeForShopee, optimizeForCoupang, optimizeForAlibaba,
  CATEGORY_MAP,
};
