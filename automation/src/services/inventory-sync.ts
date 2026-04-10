/**
 * 재고 자동추적 (인벤토리 동기화)
 *
 * 활성 리스팅의 실제 재고를 플랫폼에서 가져와 DB를 업데이트.
 * eBay: GetMyeBaySelling → Quantity - QuantitySold
 * Shopify: GET /products/{id}.json → variants[0].inventory_quantity
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { platformListings, products } from '../db/schema.js';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../platforms/shopify/ShopifyClient.js';

export interface SyncResult {
  listingId: number;
  platform: string;
  sku: string;
  oldQuantity: number;
  newQuantity: number;
  changed: boolean;
  error?: string;
}

/**
 * 전체 활성 리스팅의 재고를 플랫폼에서 가져와 DB 동기화
 */
export async function syncAllInventory(): Promise<SyncResult[]> {
  const activeListings = await db.select({
    id: platformListings.id,
    platform: platformListings.platform,
    platformItemId: platformListings.platformItemId,
    quantity: platformListings.quantity,
    productSku: products.sku,
  })
    .from(platformListings)
    .leftJoin(products, eq(platformListings.productId, products.id))
    .where(eq(platformListings.status, 'active'));

  if (activeListings.length === 0) {
    console.log('[인벤토리] 동기화할 활성 리스팅 없음');
    return [];
  }

  // 플랫폼별로 그룹핑
  const ebayListings = activeListings.filter(l => l.platform === 'ebay');
  const shopifyListings = activeListings.filter(l => l.platform === 'shopify');

  const results: SyncResult[] = [];

  // eBay 재고 동기화
  if (ebayListings.length > 0) {
    const ebayResults = await syncEbayInventory(ebayListings);
    results.push(...ebayResults);
  }

  // Shopify 재고 동기화
  if (shopifyListings.length > 0) {
    const shopifyResults = await syncShopifyInventory(shopifyListings);
    results.push(...shopifyResults);
  }

  const changed = results.filter(r => r.changed).length;
  console.log(`[인벤토리] 동기화 완료: ${results.length}개 리스팅 확인, ${changed}개 변경`);

  return results;
}

async function syncEbayInventory(
  listings: { id: number; platformItemId: string | null; quantity: number | null; productSku: string | null }[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  try {
    const ebay = new EbayClient();
    const activeItems = await ebay.getActiveListings();

    // SKU → 실제 재고 맵핑
    const ebayQuantityMap = new Map<string, number>();
    for (const item of activeItems) {
      if (item.itemId) {
        const qty = parseInt(item.quantity) || 0;
        ebayQuantityMap.set(item.itemId, qty);
      }
    }

    for (const listing of listings) {
      const oldQty = listing.quantity ?? 0;
      const newQty = listing.platformItemId
        ? (ebayQuantityMap.get(listing.platformItemId) ?? oldQty)
        : oldQty;
      const changed = newQty !== oldQty;

      if (changed) {
        await db.update(platformListings)
          .set({ quantity: newQty, lastSyncedAt: new Date() })
          .where(eq(platformListings.id, listing.id));
      } else {
        await db.update(platformListings)
          .set({ lastSyncedAt: new Date() })
          .where(eq(platformListings.id, listing.id));
      }

      results.push({
        listingId: listing.id,
        platform: 'ebay',
        sku: listing.productSku || '',
        oldQuantity: oldQty,
        newQuantity: newQty,
        changed,
      });
    }
  } catch (e) {
    console.error('[인벤토리] eBay 동기화 실패:', (e as Error).message);
    for (const listing of listings) {
      results.push({
        listingId: listing.id,
        platform: 'ebay',
        sku: listing.productSku || '',
        oldQuantity: listing.quantity ?? 0,
        newQuantity: listing.quantity ?? 0,
        changed: false,
        error: (e as Error).message,
      });
    }
  }

  return results;
}

async function syncShopifyInventory(
  listings: { id: number; platformItemId: string | null; quantity: number | null; productSku: string | null }[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  try {
    const shopify = new ShopifyClient();

    for (const listing of listings) {
      try {
        if (!listing.platformItemId) {
          results.push({
            listingId: listing.id,
            platform: 'shopify',
            sku: listing.productSku || '',
            oldQuantity: listing.quantity ?? 0,
            newQuantity: listing.quantity ?? 0,
            changed: false,
            error: 'platformItemId 없음',
          });
          continue;
        }

        const product = await shopify.getProduct(listing.platformItemId);
        const newQty = product?.variants?.[0]?.inventory_quantity ?? (listing.quantity ?? 0);
        const oldQty = listing.quantity ?? 0;
        const changed = newQty !== oldQty;

        if (changed) {
          await db.update(platformListings)
            .set({ quantity: newQty, lastSyncedAt: new Date() })
            .where(eq(platformListings.id, listing.id));
        } else {
          await db.update(platformListings)
            .set({ lastSyncedAt: new Date() })
            .where(eq(platformListings.id, listing.id));
        }

        results.push({
          listingId: listing.id,
          platform: 'shopify',
          sku: listing.productSku || '',
          oldQuantity: oldQty,
          newQuantity: newQty,
          changed,
        });

        // 레이트 리밋 방지
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        results.push({
          listingId: listing.id,
          platform: 'shopify',
          sku: listing.productSku || '',
          oldQuantity: listing.quantity ?? 0,
          newQuantity: listing.quantity ?? 0,
          changed: false,
          error: (e as Error).message,
        });
      }
    }
  } catch (e) {
    console.error('[인벤토리] Shopify 동기화 실패:', (e as Error).message);
  }

  return results;
}
