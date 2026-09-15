/**
 * 리스팅 업로드 사전 확인 · 플랫폼별 결과 표시 (브라우저 + vitest 공용 순수 모듈)
 *
 * 신규 USD CSV 상품: eBay 먼저 등록 → eBay 성공 상품만 Shopify 등록 (같은 최종가, eBay 정책 데이터 미전달)
 * 레거시 상품: 기존 플랫폼 선택·등록 그대로
 */

export const PRICING_DISABLED_NOTICE = '국제배송비 계산은 완료됐지만 실제 등록가 반영 기능이 비활성화되어 있습니다.';
export const EBAY_REQUIRED_NOTICE = '신규 CSV 상품은 eBay 등록 성공 후 Shopify에 등록할 수 있습니다.';
export const PLAN_NOTES = {
  ebayPrice: 'eBay 등록가에는 CSV 판매가와 국제배송비가 포함됩니다. eBay 배송정책 배송비는 등록가에 더하지 않습니다.',
  shopifyAfterEbay: 'Shopify는 eBay 등록에 성공한 상품만 등록됩니다.',
  shopifyPrice: 'Shopify 상품가격은 CSV 판매가 그대로이며, 배송비는 Shopify checkout 설정으로 별도 청구됩니다.',
};

const PLATFORM_LABELS = { ebay: 'eBay', shopify: 'Shopify', alibaba: 'Alibaba', shopee: 'Shopee' };
const platformLabel = (p) => PLATFORM_LABELS[p] || String(p || '').toUpperCase();

/** 신규 USD CSV 기본 플랫폼: eBay + Shopify (확인창에서 Shopify 체크 해제 가능) */
export function defaultCsvPlatforms() {
  return ['ebay', 'shopify'];
}

/**
 * 업로드 시작 전 확인 정보 (신규 CSV 상품에 적용되는 플랫폼 기준)
 * @param {{ items: {csv: boolean, ebayReady: boolean, ebayListed: boolean}[], csvPlatforms: string[], pricingEnabled: boolean }} input
 *   ebayListed = DB에 active eBay Item ID가 있음 (ended 제외)
 */
export function buildCsvListingPlan({ items, csvPlatforms, pricingEnabled }) {
  const csvItems = items.filter(i => i.csv);
  const hasEbay = csvPlatforms.includes('ebay');
  const hasShopify = csvPlatforms.includes('shopify');
  const show = csvItems.length > 0;
  const ebayCount = hasEbay ? csvItems.filter(i => i.ebayReady || i.ebayListed).length : 0;
  const shopifyCount = hasShopify && hasEbay ? ebayCount : 0;
  const notes = [PLAN_NOTES.ebayPrice];
  if (hasShopify) notes.push(PLAN_NOTES.shopifyAfterEbay, PLAN_NOTES.shopifyPrice);

  let disabledReason = '';
  if (show) {
    if (!pricingEnabled) disabledReason = PRICING_DISABLED_NOTICE;
    else if (hasShopify && !hasEbay) disabledReason = EBAY_REQUIRED_NOTICE;
    else if (!hasEbay) disabledReason = '신규 CSV 상품에 등록할 플랫폼을 선택하세요.';
  }
  return {
    show,
    selectedCount: items.length,
    csvCount: csvItems.length,
    legacyCount: items.length - csvItems.length,
    csvPlatforms: ['ebay', 'shopify'].filter(p => csvPlatforms.includes(p)),
    ebayCount,
    shopifyCount,
    notes,
    canStart: !disabledReason,
    disabledReason,
  };
}

/** 결과 상태 (이전 job은 status 없음 → success 로 판단) */
export function resultStatus(r) {
  if (r.status) return r.status;
  return r.success ? 'SUCCESS' : 'FAILED';
}

const REASON_LABELS = {
  SHIPPING_PRICING_DISABLED: '배송비 가격 반영 기능 비활성',
  SHIPPING_POLICY_NOT_SELECTED: 'eBay 배송정책 미선택',
  SHIPPING_POLICY_NOT_AVAILABLE: 'eBay 배송정책 확인 불가',
  SHIPPING_POLICY_UNSUPPORTED: 'eBay 배송정책 사용 불가',
  SHIPPING_POLICY_CHANGED: 'eBay 배송정책 변경됨',
  SHIPPING_QUOTE_MISSING: '국제배송비 견적 없음',
  SHIPPING_QUOTE_MISMATCH: '국제배송비 견적 불일치',
  EXCHANGE_RATE_MISMATCH: '배송비 환율 변경됨',
  EXCHANGE_RATE_INVALID: '배송비 환율 없음',
  CHARGEABLE_WEIGHT_INVALID: '적용무게 오류',
  SALE_PRICE_INVALID: '판매가(USD) 오류',
  EBAY_REQUIRED: 'eBay 등록 성공 필요',
  EBAY_DUPLICATE_CHECK_FAILED: 'eBay 기존 상품 확인 실패 (중복 방지)',
  EBAY_ADDITEM_UNCONFIRMED: 'eBay 등록 응답 확인 불가',
  EBAY_ITEM_SAVE_FAILED: 'eBay Item ID 저장 실패',
  SHOPIFY_DUPLICATE_CHECK_FAILED: 'Shopify 기존 상품 확인 실패',
  CSV_DUPLICATE_SKU: 'CSV 안 SKU 중복',
  PLATFORM_UNSUPPORTED: '지원하지 않는 플랫폼',
};

export function failureReason(r) {
  if (r.code && REASON_LABELS[r.code]) return REASON_LABELS[r.code];
  if (!r.code && (r.platform === 'shopify' || r.platform === 'ebay')) return `${platformLabel(r.platform)} API 오류`;
  return r.error || '오류';
}

/** 결과 행 상태 문구 */
export function resultLabel(r) {
  const status = resultStatus(r);
  if (status === 'SUCCESS') return r.code === 'ADOPTED_EXISTING' ? '성공 (기존 상품 연결)' : '성공';
  if (status === 'ALREADY_LISTED') return '기존 등록 확인';
  if (status === 'SKIPPED_EBAY_REQUIRED') return '미실행 · eBay 등록 필요';
  return '실패: ' + failureReason(r);
}

export function countResults(results) {
  const out = { success: 0, alreadyListed: 0, failed: 0, skipped: 0 };
  for (const r of results) {
    const s = resultStatus(r);
    if (s === 'SUCCESS') out.success++;
    else if (s === 'ALREADY_LISTED') out.alreadyListed++;
    else if (s === 'SKIPPED_EBAY_REQUIRED') out.skipped++;
    else out.failed++;
  }
  return out;
}

/** 상품별 한 줄 요약: "eBay 성공 · Shopify 성공" / "eBay 실패: 배송비 가격 반영 기능 비활성 · Shopify 미실행" */
export function summarizeProductResults(results) {
  const byProduct = new Map();
  for (const r of results) {
    const key = r.productId ?? r.crawlResultId;
    if (!byProduct.has(key)) byProduct.set(key, { key, title: r.title, rows: [] });
    byProduct.get(key).rows.push(r);
  }
  const rank = (p) => (p === 'ebay' ? 0 : p === 'shopify' ? 1 : 2);
  return [...byProduct.values()].map(group => ({
    key: group.key,
    title: group.title,
    text: group.rows
      .slice()
      .sort((a, b) => rank(a.platform) - rank(b.platform))
      .map(r => {
        const status = resultStatus(r);
        const name = platformLabel(r.platform);
        if (status === 'SUCCESS') return `${name} 성공` + (r.code === 'ADOPTED_EXISTING' ? ' (기존 상품 연결)' : '');
        if (status === 'ALREADY_LISTED') return `${name} 기존 등록 확인`;
        if (status === 'SKIPPED_EBAY_REQUIRED') return `${name} 미실행 · eBay 등록 필요`;
        return `${name} 실패: ${failureReason(r)}`;
      })
      .join(' · '),
  }));
}
