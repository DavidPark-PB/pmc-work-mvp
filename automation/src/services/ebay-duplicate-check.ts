/**
 * 신규 CSV eBay 중복 등록 방지 — AddItem 전에 같은 SKU(Custom Label)의 활성 eBay 상품을 READ-ONLY로 확인
 *
 * - 조회: EbayClient.getActiveSkuIndex (Trading GetMyeBaySelling ActiveList, 기존 inventory-sync와 같은 호출)
 * - job 단위로 한 번만 조회하고 상품별로 재사용 (N+1 없음)
 * - 조회는 ItemID·SKU만 받아(OutputSelector) 가볍게 한다. 결과를 job 밖으로 캐시하지는 않는다 —
 *   다른 작업이 방금 올린 상품을 놓치면 중복 등록이 되기 때문
 * - 판정:
 *     · 같은 SKU 상품을 찾음        → 그 Item ID 연결 (AddItem 안 함)
 *     · 같은 SKU 상품이 2개 이상    → EBAY_DUPLICATE_CHECK_FAILED (사람이 확인)
 *     · 없음 + 조회가 완전함        → 신규 등록 진행
 *     · 없음 + 조회가 불완전(stale) → 한 번 더 조회하고, 그때도 없으면 신규로 보고 진행
 *   수천 개 활성 리스팅을 여러 페이지로 읽는 동안 판매 종료·신규 노출로 목록 수가 바뀌는 것은 정상이라
 *   그것만으로 신규 등록을 막지 않는다 (이전: 무조건 차단 → 정상 신규 상품이 등록되지 않음).
 */
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ListingPriceError } from './listing-price.js';

export const EBAY_DUPLICATE_CHECK_FAILED = 'EBAY_DUPLICATE_CHECK_FAILED';

/** 테스트 호환용 (교차 job 캐시는 사용하지 않는다) */
export function resetActiveSkuCache(): void { /* no-op */ }

export interface ActiveSkuSnapshot {
  index: Map<string, string[]>;
  /** 읽는 중 목록이 바뀌어 일부가 빠졌을 수 있음 */
  stale: boolean;
}

export interface EbayDuplicateChecker {
  /** 같은 SKU의 활성 eBay 상품 (없으면 null). 불확실하면 EBAY_DUPLICATE_CHECK_FAILED */
  find(sku: string): Promise<{ itemId: string } | null>;
  /** 이 job에서 새로 등록한 Item ID를 색인에 반영 */
  remember(sku: string, itemId: string): void;
  /** 실제 eBay 조회 횟수 (테스트·로그용) */
  loadCount(): number;
}

export function createEbayDuplicateChecker(load?: () => Promise<ActiveSkuSnapshot>): EbayDuplicateChecker {
  const baseLoader = load ?? (() => new EbayClient().getActiveSkuIndex());
  const loader = baseLoader;
  let pending: Promise<ActiveSkuSnapshot> | null = null;
  let loads = 0;
  /** stale 조회 뒤 한 번 더 확인한 결과 */
  let recheck: Promise<ActiveSkuSnapshot> | null = null;

  const fail = (message: string) => new ListingPriceError(EBAY_DUPLICATE_CHECK_FAILED, message);

  async function snapshot(again = false): Promise<ActiveSkuSnapshot> {
    if (again) {
      if (!recheck) {
        loads++;
        recheck = baseLoader();
        recheck.catch(() => { /* find에서 처리 */ });
      }
      return recheck;
    }
    if (!pending) {
      loads++;
      pending = loader();
      pending.catch(() => { /* find에서 처리 */ });
    }
    return pending;
  }

  function lookup(index: Map<string, string[]>, sku: string): string[] {
    return index.get(sku) ?? [];
  }

  return {
    async find(sku) {
      if (!sku) throw fail('SKU가 없어 eBay 기존 상품을 확인할 수 없어 등록하지 않았습니다.');

      let first: ActiveSkuSnapshot;
      try {
        first = await snapshot();
      } catch (e) {
        throw fail(`eBay 기존 상품 확인(중복 등록 방지)에 실패해 등록하지 않았습니다: ${(e as Error).message}`);
      }

      const ids = lookup(first.index, sku);
      if (ids.length > 1) {
        throw fail(`eBay에 같은 SKU(${sku}) 활성 상품이 ${ids.length}개 있어 자동 연결하지 않았습니다. eBay에서 확인하세요.`);
      }
      if (ids.length === 1) return { itemId: ids[0] };
      if (!first.stale) return null;   // 완전한 목록에 없음 → 신규 등록

      //   목록이 조회 도중 바뀌었다 → 한 번 더 확인 (그때도 없으면 신규로 본다)
      let second: ActiveSkuSnapshot;
      try {
        second = await snapshot(true);
      } catch (e) {
        throw fail(`eBay 기존 상품 확인(중복 등록 방지)에 실패해 등록하지 않았습니다: ${(e as Error).message}`);
      }
      const retryIds = lookup(second.index, sku);
      if (retryIds.length > 1) {
        throw fail(`eBay에 같은 SKU(${sku}) 활성 상품이 ${retryIds.length}개 있어 자동 연결하지 않았습니다. eBay에서 확인하세요.`);
      }
      if (retryIds.length === 1) return { itemId: retryIds[0] };
      return null;
    },
    remember(sku, itemId) {
      if (!sku || !itemId) return;
      for (const key of ['first', 'second'] as const) {
        const target = key === 'first' ? pending : recheck;
        if (!target) continue;
        const updated = target.then(snap => {
          const ids = snap.index.get(sku) ?? [];
          if (!ids.includes(itemId)) snap.index.set(sku, [...ids, itemId]);
          return snap;
        });
        updated.catch(() => { /* find에서 처리 */ });
        if (key === 'first') pending = updated; else recheck = updated;
      }
    },
    loadCount: () => loads,
  };
}
