/**
 * 신규 CSV eBay 중복 등록 방지 — AddItem 전에 같은 SKU(Custom Label)의 활성 eBay 상품을 READ-ONLY로 확인
 *
 * - 조회: EbayClient.getActiveSkuIndex (Trading GetMyeBaySelling ActiveList, 기존 inventory-sync와 같은 호출)
 * - job 단위로 한 번만 조회하고 상품별로 재사용 (N+1 없음). 조회 실패도 job 안에서는 재조회하지 않고 같은 실패로 차단
 * - 불확실(조회 실패, 같은 SKU 활성 상품 2개 이상)하면 EBAY_DUPLICATE_CHECK_FAILED — 호출자는 AddItem을 실행하지 않는다
 */
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ListingPriceError } from './listing-price.js';

export const EBAY_DUPLICATE_CHECK_FAILED = 'EBAY_DUPLICATE_CHECK_FAILED';

export interface EbayDuplicateChecker {
  /** 같은 SKU의 활성 eBay 상품 (없으면 null). 불확실하면 EBAY_DUPLICATE_CHECK_FAILED */
  find(sku: string): Promise<{ itemId: string } | null>;
  /** 이 job에서 새로 등록한 Item ID를 색인에 반영 */
  remember(sku: string, itemId: string): void;
  /** 실제 eBay 조회 횟수 (테스트·로그용) */
  loadCount(): number;
}

export function createEbayDuplicateChecker(load?: () => Promise<Map<string, string[]>>): EbayDuplicateChecker {
  const loader = load ?? (() => new EbayClient().getActiveSkuIndex());
  let pending: Promise<Map<string, string[]>> | null = null;
  let loads = 0;

  const fail = (message: string) => new ListingPriceError(EBAY_DUPLICATE_CHECK_FAILED, message);

  return {
    async find(sku) {
      if (!sku) throw fail('SKU가 없어 eBay 기존 상품을 확인할 수 없어 등록하지 않았습니다.');
      if (!pending) {
        loads++;
        pending = loader();
        pending.catch(() => { /* find에서 처리 */ });
      }
      let index: Map<string, string[]>;
      try {
        index = await pending;
      } catch (e) {
        throw fail(`eBay 기존 상품 확인(중복 등록 방지)에 실패해 등록하지 않았습니다: ${(e as Error).message}`);
      }
      const ids = index.get(sku) ?? [];
      if (ids.length > 1) {
        throw fail(`eBay에 같은 SKU(${sku}) 활성 상품이 ${ids.length}개 있어 자동 연결하지 않았습니다. eBay에서 확인하세요.`);
      }
      return ids.length === 1 ? { itemId: ids[0] } : null;
    },
    remember(sku, itemId) {
      if (!pending || !sku || !itemId) return;
      pending = pending.then(index => {
        const ids = index.get(sku) ?? [];
        if (!ids.includes(itemId)) index.set(sku, [...ids, itemId]);
        return index;
      });
      pending.catch(() => { /* find에서 처리 */ });
    },
    loadCount: () => loads,
  };
}
