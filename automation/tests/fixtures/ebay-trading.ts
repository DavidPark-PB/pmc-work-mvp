/**
 * eBay Trading API 응답 fixture (mock 전용 — 실호출 없음)
 * GetMyeBaySelling ActiveList: 신규 CSV eBay 등록 전 READ-ONLY 중복 확인이 읽는 응답
 */
export function activeListResponse(items: { itemId: string; sku?: string }[], options: { page?: number; totalPages?: number; totalEntries?: number } = {}): string {
  const itemXml = items.map(i => `<Item><ItemID>${i.itemId}</ItemID>${i.sku !== undefined ? `<SKU>${i.sku}</SKU>` : ''}<Title>mock</Title></Item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>`
    + `<ActiveList><ItemArray>${itemXml}</ItemArray><PaginationResult><TotalNumberOfPages>${options.totalPages ?? 1}</TotalNumberOfPages>`
    + `<TotalNumberOfEntries>${options.totalEntries ?? items.length}</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;
}

/** 같은 SKU 활성 상품이 없는 eBay 스토어 */
export const EMPTY_ACTIVE_LIST = activeListResponse([]);

export const FAILED_ACTIVE_LIST = '<GetMyeBaySellingResponse><Ack>Failure</Ack><Errors><ShortMessage>mock failure</ShortMessage></Errors></GetMyeBaySellingResponse>';
