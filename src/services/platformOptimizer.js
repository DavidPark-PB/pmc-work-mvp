/**
 * 플랫폼별 상품 데이터 자동 최적화
 * 마스터 상품 → 플랫폼별 최적화된 등록 데이터 변환
 */

const CATEGORY_MAP = {
  '전자기기': { ebay: '11450', naver: '50000803', shopify: 'Electronics' },
  '생활용품': { ebay: '11700', naver: '50000006', shopify: 'Home & Garden' },
  '의류':     { ebay: '11450', naver: '50000000', shopify: 'Clothing' },
  '뷰티':     { ebay: '26395', naver: '50000002', shopify: 'Beauty' },
  '기타':     { ebay: '11450', naver: '50000803', shopify: 'Other' },
};

function getCategoryIds(category) {
  return CATEGORY_MAP[category] || CATEGORY_MAP['기타'];
}

/**
 * eBay용 최적화 데이터 생성
 */
function optimizeForEbay(product, prices) {
  const priceData = prices.ebay;
  if (priceData.error) return null;

  // 카테고리: 사용자 선택 > CATEGORY_MAP fallback
  const categoryId = product.ebayCategoryId || getCategoryIds(product.category).ebay;

  let title = (product.titleEn || product.title || '').substring(0, 80);
  if (product.keywords && product.keywords.length > 0) {
    const remaining = 80 - title.length;
    if (remaining > 5) {
      const kw = product.keywords.filter(k => !title.toLowerCase().includes(k.toLowerCase()));
      for (const k of kw) {
        if (title.length + k.length + 1 <= 80) {
          title += ' ' + k;
        }
      }
    }
  }

  const description = buildEbayDescription(product);

  // condition 매핑: new → 1000, used → 3000, refurbished → 2500
  const conditionMap = { 'new': '1000', 'used': '3000', 'refurbished': '2500' };
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
  };
}

/**
 * Shopify용 최적화 데이터 생성
 */
function optimizeForShopify(product, prices) {
  const priceData = prices.shopify;
  if (priceData.error) return null;

  // 카테고리: 사용자 입력 > CATEGORY_MAP fallback
  const productType = product.shopifyProductType || getCategoryIds(product.category).shopify;

  const title = product.titleEn || product.title || '';
  const bodyHtml = buildShopifyDescription(product);
  const tags = (product.keywords || []).join(', ');

  return {
    title,
    sku: product.sku,
    price: String(priceData.price),
    bodyHtml,
    vendor: 'PMC',
    productType,
    tags,
    quantity: parseInt(product.quantity) || 1,
    imageUrl: product.imageUrls && product.imageUrls[0],
  };
}

/**
 * Naver용 최적화 데이터 생성
 */
function optimizeForNaver(product, prices) {
  const priceData = prices.naver;
  if (priceData.error) return null;

  // 카테고리: 사용자 선택 > CATEGORY_MAP fallback
  const categoryId = product.naverCategoryId || getCategoryIds(product.category).naver;

  let productName = product.title || product.titleEn || '';
  if (product.keywords && product.keywords.length > 0) {
    const kw = product.keywords.filter(k => !productName.includes(k));
    for (const k of kw) {
      if (productName.length + k.length + 1 <= 100) {
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
  };
}

/**
 * 플랫폼별 최적화 통합 함수
 */
function optimize(platform, product, prices) {
  switch (platform) {
    case 'ebay': return optimizeForEbay(product, prices);
    case 'shopify': return optimizeForShopify(product, prices);
    case 'naver': return optimizeForNaver(product, prices);
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

module.exports = { optimize, optimizeForEbay, optimizeForShopify, optimizeForNaver, CATEGORY_MAP };
