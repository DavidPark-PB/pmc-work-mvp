/**
 * 플랫폼 어댑터 인터페이스
 *
 * eBay, Shopify 등 각 마켓플레이스 클라이언트가 구현해야 할 공통 인터페이스
 */

export interface ListingInput {
  title: string;
  description: string;
  price: number;          // USD
  shippingCost: number;   // USD
  quantity: number;
  sku: string;
  condition: string;      // 'new', 'used' 등
  imageUrls: string[];
  productType?: string;
  brand?: string;
  weight?: number;        // grams
  itemSpecifics?: Record<string, string>;  // eBay Item Specifics (카테고리별 템플릿)
}

export interface ListingResult {
  itemId: string;
  url: string;
}

export interface PlatformAdapter {
  /** 플랫폼 이름 */
  readonly platform: string;

  /** 연결 테스트 */
  testConnection(): Promise<boolean>;

  /** 새 리스팅 생성 */
  createListing(input: ListingInput): Promise<ListingResult>;

  /** 기존 리스팅 수정 */
  updateListing(itemId: string, updates: Partial<ListingInput>): Promise<void>;

  /** 리스팅 삭제 */
  deleteListing(itemId: string): Promise<void>;

  /** 가격/재고 업데이트 */
  updateInventory(itemId: string, price: number, quantity: number): Promise<void>;
}
