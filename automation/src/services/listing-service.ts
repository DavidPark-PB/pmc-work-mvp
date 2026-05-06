/**
 * 리스팅 관리 서비스
 *
 * crawl_results → products → platform_listings + API 호출
 */
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, products, platformListings, productImages } from '../db/schema.js';
import { calculateListingPrice, calculatePriceSimple, getPricingSettings } from './pricing.js';
import { translateProduct } from './translate.js';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ShopifyClient } from '../platforms/shopify/ShopifyClient.js';
import { AlibabaClient } from '../platforms/alibaba/AlibabaClient.js';
import { ShopeeClient } from '../platforms/shopee/ShopeeClient.js';
import type { PlatformAdapter, ListingInput } from '../platforms/index.js';
import { getDescriptionTemplate, buildPlatformDescription } from './description.js';

function getAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'ebay': return new EbayClient();
    case 'shopify': return new ShopifyClient();
    case 'alibaba': return new AlibabaClient();
    case 'shopee': return new ShopeeClient();
    default: throw new Error(`지원하지 않는 플랫폼: ${platform}`);
  }
}

/** SKU 자동 생성: PMC-00001 형식 */
async function generateSku(): Promise<string> {
  const result = await db.execute(sql`SELECT MAX(id) as max_id FROM products`);
  const maxId = (result.rows[0] as any)?.max_id || 0;
  return `PMC-${String(maxId + 1).padStart(5, '0')}`;
}

/**
 * crawl_results → products 임포트
 * crawl_results.status를 'imported'로 변경하고 products 행 생성
 */
export async function importFromCrawl(crawlResultId: number): Promise<number> {
  const crawlResult = await db.query.crawlResults.findFirst({
    where: eq(crawlResults.id, crawlResultId),
  });

  if (!crawlResult) throw new Error(`crawl_result #${crawlResultId} 없음`);
  if (crawlResult.productId) return crawlResult.productId; // 이미 임포트된 경우 기존 productId 반환

  const sku = await generateSku();
  const rawData = (crawlResult.rawData || {}) as Record<string, any>;

  // Gemini 영문 번역 (이미 번역된 titleEn이 있으면 활용)
  const translated = crawlResult.titleEn
    ? { ...(await translateProduct(crawlResult.title, rawData)), title: crawlResult.titleEn }
    : await translateProduct(crawlResult.title, rawData);

  // products 생성 (소유자 정보 계승)
  const [product] = await db.insert(products).values({
    sku,
    title: translated.title,             // 영문 번역
    titleKo: crawlResult.title,          // 한글 원본 보존
    description: translated.description,  // 영문 상품 설명
    productType: translated.productType,  // 영문 카테고리
    tags: translated.tags.length > 0 ? translated.tags : undefined,
    costPrice: crawlResult.price || '0',
    sourceUrl: crawlResult.url,
    sourcePlatform: 'coupang',           // TODO: source에서 가져오기
    brand: rawData.brand || rawData.vendor || rawData.mallName || '',
    condition: 'new',
    status: 'active',
    metadata: { importedFrom: crawlResultId },
    ownerId: crawlResult.ownerId,
    ownerName: crawlResult.ownerName,
  }).returning();

  // 이미지 저장 (빈 URL 필터링)
  const rawImages = rawData.images || (crawlResult.imageUrl ? [crawlResult.imageUrl] : []);
  const images = rawImages.filter((url: string) => url && url.trim());
  for (let i = 0; i < images.length; i++) {
    await db.insert(productImages).values({
      productId: product.id,
      url: images[i],
      position: i,
    });
  }

  // crawl_results 상태 업데이트
  await db.update(crawlResults)
    .set({ status: 'imported', productId: product.id })
    .where(eq(crawlResults.id, crawlResultId));

  return product.id;
}

/**
 * product → platform_listings + API 호출로 마켓에 리스팅
 */
export async function createListing(
  productId: number,
  platform: string,
  options: { dryRun?: boolean; weightG?: number } = {},
): Promise<{ listingId: number; itemId?: string; url?: string }> {
  const { dryRun = false, weightG = 500 } = options;

  const product = await db.query.products.findFirst({
    where: eq(products.id, productId),
    with: { images: true },
  });

  if (!product) throw new Error(`product #${productId} 없음`);

  // 가격 계산 (DB 설정 기반)
  const costKRW = parseFloat(String(product.costPrice)) || 0;
  const pricing = await calculatePriceSimple(costKRW, { platform });

  // 기존 리스팅 확인 (unique 제약: productId + platform)
  const existingListing = await db.query.platformListings.findFirst({
    where: and(
      eq(platformListings.productId, productId),
      eq(platformListings.platform, platform),
    ),
  });

  if (existingListing) {
    if (existingListing.status === 'active' && existingListing.platformItemId) {
      // 실제 활성 리스팅 (ItemID 있음) — 건너뜀
      console.log(`[리스팅] 이미 active 리스팅 존재: #${existingListing.id} — 건너뜀`);
      return { listingId: existingListing.id, itemId: existingListing.platformItemId || undefined, url: existingListing.listingUrl || undefined };
    }
    // active인데 platformItemId 없음 = 유령 리스팅 → 삭제
    // 또는 ended/error/draft/pending → 삭제 후 새로 생성
    console.log(`[리스팅] 기존 리스팅 삭제: #${existingListing.id} (status=${existingListing.status}, itemId=${existingListing.platformItemId || 'none'})`);
    await db.delete(platformListings)
      .where(eq(platformListings.id, existingListing.id));
  }

  // platform_listings 행 생성 (draft 상태) — 기본 재고 설정값 사용
  const defaultQty = (pricing as any).defaultQuantity || (await getPricingSettings(platform)).defaultQuantity || 5;
  const [listing] = await db.insert(platformListings).values({
    productId,
    platform,
    platformSku: product.sku,
    title: product.title,
    status: 'draft',
    price: String(pricing.salePrice),
    currency: 'USD',
    shippingCost: String(pricing.shippingCost),
    quantity: defaultQty,
  }).returning();

  console.log(`[리스팅] draft 생성: #${listing.id} (${platform}, $${pricing.salePrice})`);

  if (dryRun) {
    console.log(`[리스팅] DRY RUN — API 호출 생략`);
    return { listingId: listing.id };
  }

  // API 호출
  const adapter = getAdapter(platform);

  // 상품 description + 공통 템플릿 결합
  const template = await getDescriptionTemplate(platform);
  const productDesc = product.description || `<p>${product.title}</p>`;
  const fullDescription = buildPlatformDescription(productDesc, template, platform);

  // Load item specifics from product-level (if set)
  // Category-based template loading is now handled inside EbayClient.createListing()
  let itemSpecifics: Record<string, string> = {};
  const productSpecs = (product as any).itemSpecifics || (product as any).item_specifics;
  if (productSpecs && typeof productSpecs === 'object' && Object.keys(productSpecs).length > 0) {
    itemSpecifics = productSpecs;
  }

  const input: ListingInput = {
    title: product.title,
    description: fullDescription,
    price: pricing.salePrice,
    shippingCost: pricing.shippingCost,
    quantity: defaultQty,
    sku: product.sku,
    condition: product.condition || 'ungraded',
    imageUrls: product.images.map((img: any) => img.url),
    productType: product.productType || '',
    brand: product.brand || '',
    weight: weightG,
    itemSpecifics,
  };

  try {
    // pending 상태로 변경
    await db.update(platformListings)
      .set({ status: 'pending' })
      .where(eq(platformListings.id, listing.id));

    const result = await adapter.createListing(input);

    // active 상태로 변경 + 플랫폼 ID 저장
    await db.update(platformListings)
      .set({
        status: 'active',
        platformItemId: result.itemId,
        listingUrl: result.url,
        lastSyncedAt: new Date(),
      })
      .where(eq(platformListings.id, listing.id));

    console.log(`[리스팅] active: ${result.url}`);
    return { listingId: listing.id, itemId: result.itemId, url: result.url };

  } catch (e) {
    console.error(`[리스팅] 에러 (product #${productId}, ${platform}):`, (e as Error).message, (e as Error).stack);
    // error 상태로 변경
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { error: (e as Error).message },
      })
      .where(eq(platformListings.id, listing.id));

    throw e;
  }
}

/**
 * 기존 draft/pending/error 리스팅 재시도
 * platform_listings 레코드를 리셋하고 API 재호출
 */
export async function retryListing(
  listingId: number,
  options: { weightG?: number } = {},
): Promise<{ listingId: number; itemId?: string; url?: string }> {
  const { weightG = 500 } = options;

  const listing = await db.query.platformListings.findFirst({
    where: eq(platformListings.id, listingId),
    with: { product: { with: { images: true } } },
  });

  if (!listing) throw new Error(`listing #${listingId} 없음`);

  const retryableStatuses = ['draft', 'pending', 'error'];
  if (!retryableStatuses.includes(listing.status)) {
    throw new Error(`listing #${listingId}는 '${listing.status}' 상태라 재시도 불가 (${retryableStatuses.join('/')}만 가능)`);
  }

  const product = listing.product as any;
  if (!product) throw new Error(`listing #${listingId}의 product 없음`);

  // 가격 재계산 (DB 설정 기반)
  const costKRW = parseFloat(String(product.costPrice)) || 0;
  const pricing = await calculatePriceSimple(costKRW, { platform: listing.platform });

  // 상태 리셋 + 가격 업데이트
  await db.update(platformListings)
    .set({
      status: 'pending',
      platformItemId: null,
      listingUrl: null,
      platformData: null,
      price: String(pricing.salePrice),
      shippingCost: String(pricing.shippingCost),
    })
    .where(eq(platformListings.id, listingId));

  console.log(`[리스팅] 재시도: #${listingId} (${listing.platform})`);

  const adapter = getAdapter(listing.platform);

  // 상품 description + 공통 템플릿 결합
  const retryTemplate = await getDescriptionTemplate(listing.platform);
  const retryProductDesc = product.description || `<p>${product.title}</p>`;
  const retryFullDescription = buildPlatformDescription(retryProductDesc, retryTemplate, listing.platform);

  const input: ListingInput = {
    title: product.title,
    description: retryFullDescription,
    price: pricing.salePrice,
    shippingCost: pricing.shippingCost,
    quantity: listing.quantity || 5,
    sku: product.sku,
    condition: product.condition || 'ungraded',
    imageUrls: product.images.map((img: any) => img.url),
    productType: product.productType || '',
    brand: product.brand || '',
    weight: weightG,
  };

  try {
    const result = await adapter.createListing(input);

    await db.update(platformListings)
      .set({
        status: 'active',
        platformItemId: result.itemId,
        listingUrl: result.url,
        lastSyncedAt: new Date(),
      })
      .where(eq(platformListings.id, listingId));

    console.log(`[리스팅] 재시도 성공: ${result.url}`);
    return { listingId, itemId: result.itemId, url: result.url };

  } catch (e) {
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { error: (e as Error).message },
      })
      .where(eq(platformListings.id, listingId));

    throw e;
  }
}

/**
 * 판매 내리기: 플랫폼 API로 리스팅 종료 + DB status → 'ended'
 */
export async function endListing(listingId: number): Promise<void> {
  const listing = await db.query.platformListings.findFirst({
    where: eq(platformListings.id, listingId),
  });

  if (!listing) throw new Error(`listing #${listingId} 없음`);
  if (listing.status !== 'active') {
    throw new Error(`listing #${listingId}는 '${listing.status}' 상태라 내리기 불가 (active만 가능)`);
  }
  if (!listing.platformItemId) {
    throw new Error(`listing #${listingId}에 platformItemId 없음`);
  }

  const adapter = getAdapter(listing.platform);
  await adapter.deleteListing(listing.platformItemId);

  await db.update(platformListings)
    .set({ status: 'ended' })
    .where(eq(platformListings.id, listingId));

  console.log(`[리스팅] 판매 내림: #${listingId} (${listing.platform})`);
}

/**
 * 업로드 취소 (플랫폼 API 호출 없음)
 * - draft: 리스팅 레코드 삭제 (플랫폼에 올라간 적 없음)
 * - pending/error: status → 'draft'로 되돌림
 */
export async function cancelListing(listingId: number): Promise<void> {
  const listing = await db.query.platformListings.findFirst({
    where: eq(platformListings.id, listingId),
  });

  if (!listing) throw new Error(`listing #${listingId} 없음`);

  const cancellableStatuses = ['draft', 'pending', 'error'];
  if (!cancellableStatuses.includes(listing.status)) {
    throw new Error(`listing #${listingId}는 '${listing.status}' 상태라 취소 불가 (${cancellableStatuses.join('/')}만 가능)`);
  }

  if (listing.status === 'draft') {
    // 플랫폼에 올라간 적 없으므로 레코드 삭제
    await db.delete(platformListings)
      .where(eq(platformListings.id, listingId));
  } else {
    await db.update(platformListings)
      .set({
        status: 'draft',
        platformItemId: null,
        listingUrl: null,
        platformData: null,
      })
      .where(eq(platformListings.id, listingId));
  }

  console.log(`[리스팅] 업로드 취소: #${listingId} (${listing.platform})`);
}

/**
 * 판매 재개: ended → 다시 API 호출 → active
 * retryListing과 유사하지만 ended 상태만 허용
 */
export async function relistListing(
  listingId: number,
  options: { weightG?: number } = {},
): Promise<{ listingId: number; itemId?: string; url?: string }> {
  const { weightG = 500 } = options;

  const listing = await db.query.platformListings.findFirst({
    where: eq(platformListings.id, listingId),
    with: { product: { with: { images: true } } },
  });

  if (!listing) throw new Error(`listing #${listingId} 없음`);
  if (listing.status !== 'ended') {
    throw new Error(`listing #${listingId}는 '${listing.status}' 상태라 재개 불가 (ended만 가능)`);
  }

  const product = listing.product as any;
  if (!product) throw new Error(`listing #${listingId}의 product 없음`);

  // 가격 재계산 (DB 설정 기반)
  const costKRW = parseFloat(String(product.costPrice)) || 0;
  const pricing = await calculatePriceSimple(costKRW, { platform: listing.platform });

  // 상태 리셋
  await db.update(platformListings)
    .set({
      status: 'pending',
      platformItemId: null,
      listingUrl: null,
      platformData: null,
      price: String(pricing.salePrice),
      shippingCost: String(pricing.shippingCost),
    })
    .where(eq(platformListings.id, listingId));

  console.log(`[리스팅] 판매 재개: #${listingId} (${listing.platform})`);

  const adapter = getAdapter(listing.platform);

  // 상품 description + 공통 템플릿 결합
  const relistTemplate = await getDescriptionTemplate(listing.platform);
  const relistProductDesc = product.description || `<p>${product.title}</p>`;
  const relistFullDescription = buildPlatformDescription(relistProductDesc, relistTemplate, listing.platform);

  const input: ListingInput = {
    title: product.title,
    description: relistFullDescription,
    price: pricing.salePrice,
    shippingCost: pricing.shippingCost,
    quantity: listing.quantity || 5,
    sku: product.sku,
    condition: product.condition || 'ungraded',
    imageUrls: product.images.map((img: any) => img.url),
    productType: product.productType || '',
    brand: product.brand || '',
    weight: weightG,
  };

  try {
    const result = await adapter.createListing(input);

    await db.update(platformListings)
      .set({
        status: 'active',
        platformItemId: result.itemId,
        listingUrl: result.url,
        lastSyncedAt: new Date(),
      })
      .where(eq(platformListings.id, listingId));

    console.log(`[리스팅] 판매 재개 성공: ${result.url}`);
    return { listingId, itemId: result.itemId, url: result.url };

  } catch (e) {
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { error: (e as Error).message },
      })
      .where(eq(platformListings.id, listingId));

    throw e;
  }
}

/**
 * 상품 + 관련 데이터 삭제
 * cascade: productImages, platformListings 자동 삭제
 * crawlResults.productId는 cascade 아니므로 수동 null 처리
 */
export async function deleteProduct(productId: number): Promise<void> {
  const product = await db.query.products.findFirst({
    where: eq(products.id, productId),
  });

  if (!product) throw new Error(`product #${productId} 없음`);

  // crawlResults.productId 수동 null + status 리셋
  await db.update(crawlResults)
    .set({ productId: null, status: 'new' })
    .where(eq(crawlResults.productId, productId));

  // products 삭제 (cascade로 productImages, platformListings 자동 삭제)
  await db.delete(products).where(eq(products.id, productId));

  console.log(`[삭제] product #${productId} (${product.sku}) 삭제 완료`);
}

/**
 * 기존 리스팅 가격/재고 동기화
 */
export async function syncListing(listingId: number): Promise<void> {
  const listing = await db.query.platformListings.findFirst({
    where: eq(platformListings.id, listingId),
    with: { product: true },
  });

  if (!listing || !listing.platformItemId) {
    throw new Error(`리스팅 #${listingId} 없음 또는 미발행`);
  }

  const adapter = getAdapter(listing.platform);
  const price = parseFloat(String(listing.price)) || 0;
  const quantity = listing.quantity || 0;

  await adapter.updateInventory(listing.platformItemId, price, quantity);

  await db.update(platformListings)
    .set({ lastSyncedAt: new Date() })
    .where(eq(platformListings.id, listingId));

  console.log(`[동기화] #${listingId} → ${listing.platform} ($${price}, qty=${quantity})`);
}
