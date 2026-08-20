/**
 * shopify-transformer - 크롤링 데이터 → Shopify CSV 변환
 * 원본: MrCrawler/mr-crawler/lib/shopify-transformer.ts
 *
 * 기능: 크롤링한 상품 데이터를 Shopify 상품 임포트 CSV 형식으로 변환
 */
const Papa = require('papaparse');

/**
 * 크롤링 상품 → Shopify CSV 문자열 생성
 * @param {Array} products - [{name, price, vendor, images, options, bodyHtml, url}]
 * @param {number} marginMultiplier - 마진 배수 (기본 1.5배)
 * @returns {string} Shopify CSV 문자열
 */
function generateShopifyCSV(products, marginMultiplier = 1.5) {
  const rows = [];

  for (const product of products) {
    const handle = slugify(product.name);
    const price = Math.ceil(product.price * marginMultiplier);

    const baseRow = {
      Handle: handle,
      Title: product.name,
      'Body (HTML)': product.bodyHtml || '',
      Vendor: product.vendor || '',
      Type: 'Coupang Import',
      Tags: 'Coupang, Imported',
      Published: 'TRUE',
      'Variant Grams': 0,
      'Variant Inventory Tracker': 'shopify',
      'Variant Inventory Qty': 100,
      'Variant Price': price,
      'Variant Compare At Price': '',
    };

    const variants = generateVariants(product.options);

    if (variants.length === 0) {
      // 단일 상품 (옵션 없음)
      rows.push({
        ...baseRow,
        'Option1 Name': 'Title',
        'Option1 Value': 'Default Title',
        'Image Src': (product.images && product.images[0]) || '',
        'Image Position': 1,
      });

      // 추가 이미지
      if (product.images) {
        for (let i = 1; i < product.images.length; i++) {
          rows.push({
            Handle: handle,
            'Image Src': product.images[i],
            'Image Position': i + 1,
          });
        }
      }
    } else {
      // 멀티 옵션 상품 (사이즈, 색상 등)
      let firstVariant = true;
      for (const variant of variants) {
        rows.push({
          ...baseRow,
          'Option1 Name': variant.option1?.name || '',
          'Option1 Value': variant.option1?.value || '',
          'Option2 Name': variant.option2?.name || '',
          'Option2 Value': variant.option2?.value || '',
          'Option3 Name': variant.option3?.name || '',
          'Option3 Value': variant.option3?.value || '',
          'Image Src': firstVariant ? ((product.images && product.images[0]) || '') : '',
          'Image Position': firstVariant ? 1 : '',
        });
        firstVariant = false;
      }

      // 추가 이미지
      if (product.images) {
        for (let i = 1; i < product.images.length; i++) {
          rows.push({
            Handle: handle,
            'Image Src': product.images[i],
            'Image Position': i + 1,
          });
        }
      }
    }
  }

  return Papa.unparse(rows);
}

/** 텍스트 → URL-safe slug */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/** 옵션 조합 생성 (데카르트 곱) */
function generateVariants(options) {
  if (!options || options.length === 0) return [];

  const cartesian = (sets) => {
    return sets.reduce((acc, set) => {
      return acc.flatMap((x) => set.map((y) => [...x, y]));
    }, [[]]);
  };

  const optionValues = options.map((o) => o.values.map((v) => ({ name: o.name, value: v })));
  const combinations = cartesian(optionValues);

  return combinations.map((combo) => ({
    option1: combo[0],
    option2: combo[1],
    option3: combo[2],
  }));
}

module.exports = { generateShopifyCSV, slugify, generateVariants };
