/**
 * 리스팅 관리 서비스
 *
 * crawl_results → products → platform_listings + API 호출
 */
import { eq, and, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, products, platformListings, productImages } from '../db/schema.js';
import { getPricingSettings } from './pricing.js';
import { buildProductCsvMetadata, ListingPriceError, readProductCsvMetadata, resolveListingSalePrice, type ResolvedListingSalePrice } from './listing-price.js';
import { getShippingPricingConfig } from '../lib/shipping-config.js';
import { resolveCsvShippingPolicy, type ShippingPolicySnapshot } from './ebay-shipping-policies.js';
import { createEbayDuplicateChecker, EBAY_DUPLICATE_CHECK_FAILED, type EbayDuplicateChecker } from './ebay-duplicate-check.js';
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

/** 신규 USD CSV(toybox) 상품 — metadata.csvImport 가 있는 상품 */
export function isNewCsvProduct(product: { metadata: unknown }): boolean {
  return !!readProductCsvMetadata(product.metadata);
}

export const EBAY_REQUIRED_MESSAGE = '신규 CSV 상품은 eBay 등록 성공 후 Shopify에 등록할 수 있습니다.';

/** Shopify 선행 조건으로 인정하는 eBay 리스팅: Item ID가 저장된 active 리스팅만 (ended/error/draft/pending 제외) */
function isEbayActive(listing: { platformItemId?: string | null; status: string } | undefined | null): boolean {
  return !!listing && !!listing.platformItemId && listing.status === 'active';
}

/**
 * 판매가 결정 (create/retry/relist 공용 — release guard 단일 경로)
 * USD CSV 상품은 원본 crawl_results와 대조 후 판매가 + 저장된 배송 견적 (배송비 플래그 off면 차단), 그 외는 기존 계산
 */
type ResolvedListing = ResolvedListingSalePrice & {
  /** CSV 상품: upload에서 선택한 eBay Shipping Policy (레거시: undefined → 전역 env 정책) */
  shippingProfileId?: string;
  shippingPolicy?: ShippingPolicySnapshot;
  /** CSV 상품 Shopify: 선행 eBay 등록 Item ID */
  ebayItemId?: string;
};

/**
 * 플랫폼 API 등록 — 신규 CSV Shopify는 SKU로 기존 상품을 먼저 찾아 연결 (응답 저장 실패 후 재시도 시 중복 생성 방지)
 */
async function createOrAdoptListing(adapter: PlatformAdapter, platform: string, input: ListingInput, csvProduct: boolean): Promise<{ itemId: string; url: string; adopted: boolean }> {
  if (csvProduct && platform === 'shopify' && adapter instanceof ShopifyClient) {
    let existing: Awaited<ReturnType<ShopifyClient['findProductBySku']>>;
    try {
      existing = await adapter.findProductBySku(input.sku);
    } catch (e) {
      //   조회가 불확실하면 새 상품을 만들지 않는다
      throw new ListingPriceError('SHOPIFY_DUPLICATE_CHECK_FAILED', `Shopify 기존 상품 확인(SKU ${input.sku})에 실패해 등록하지 않았습니다: ${(e as Error).message}`);
    }
    if (existing) {
      console.log(`[리스팅] Shopify 기존 상품 연결 (SKU ${input.sku}): ${existing.itemId}`);
      return { ...existing, adopted: true };
    }
  }
  const result = await adapter.createListing(input);
  return { ...result, adopted: false };
}

async function resolveProductSalePrice(
  product: { id?: number; costPrice: unknown; metadata: unknown; sku: string },
  platform: string,
  action: 'create' | 'retry',
): Promise<ResolvedListing> {
  const settings = await getPricingSettings(platform);
  const importedFrom = (product.metadata as Record<string, any> | null)?.importedFrom;
  const sourceCrawl = typeof importedFrom === 'number'
    ? await db.query.crawlResults.findFirst({ where: eq(crawlResults.id, importedFrom) })
    : undefined;
  const pricing = resolveListingSalePrice(product, settings, {
    platform,
    sourceCrawl: sourceCrawl ?? null,
    shipping: getShippingPricingConfig(),
  });
  // 레거시(KRW 매입가) 상품: 매입가 0 이면 등록 차단 — 잘못된 $1 리스팅 발생 방지 (기존 동작 유지).
  // CSV 업로드 시 가격 컬럼 매핑 안 하거나 크롤이 가격 추출 실패한 경우.
  if (pricing.source === 'LEGACY_CALCULATED' && !((parseFloat(String(product.costPrice)) || 0) > 0)) {
    throw new Error(action === 'create'
      ? `매입가 (cost price) 가 설정되지 않았습니다. 상품 관리에서 가격을 입력 후 재등록하세요. (SKU: ${product.sku})`
      : `매입가 (cost price) 가 설정되지 않았습니다. 상품 관리에서 가격을 입력 후 재시도하세요. (SKU: ${product.sku})`);
  }
  if (pricing.source === 'CSV_USD_PLUS_SHIPPING' && platform === 'ebay') {
    //   CSV 상품은 선택한 배송정책을 eBay 현재 목록으로 재검증 — 전역 EBAY_SHIPPING_PROFILE_ID fallback 없음
    const policy = await resolveCsvShippingPolicy((product.metadata as Record<string, any>).csvImport);
    return { ...pricing, shippingProfileId: policy.shippingProfileId, shippingPolicy: policy.snapshot };
  }
  if (pricing.source === 'CSV_USD_SALE_PRICE' && platform === 'shopify') {
    //   신규 CSV의 Shopify는 eBay 등록 성공(active + Item ID 저장) 후에만, CSV 판매가 그대로 (eBay 정책 데이터는 전달하지 않음)
    const ebayListing = typeof product.id === 'number'
      ? await db.query.platformListings.findFirst({ where: and(eq(platformListings.productId, product.id), eq(platformListings.platform, 'ebay')) })
      : undefined;
    if (!isEbayActive(ebayListing)) throw new ListingPriceError('EBAY_REQUIRED', EBAY_REQUIRED_MESSAGE);
    return { ...pricing, ebayItemId: ebayListing!.platformItemId ?? undefined };
  }
  return pricing;
}

/** platform_listings.platform_data에 남기는 가격 결정 기록 */
function pricingAudit(pricing: ResolvedListing) {
  const audit: Record<string, unknown> = { source: pricing.source, salePrice: pricing.salePrice, ...(pricing.breakdown ?? {}) };
  if (pricing.ebayItemId) audit.ebayItemId = pricing.ebayItemId;
  if (pricing.shippingPolicy) {
    audit.shippingPolicy = pricing.shippingPolicy;
    audit.buyerTotalUsd = (Math.round(pricing.salePrice * 100) + Math.round(pricing.shippingPolicy.buyerShippingUsd * 100)) / 100;
  }
  return { pricing: audit };
}

/** 신규 CSV eBay 등록 시도 기록 (platform_listings.platform_data.ebaySubmission) */
type EbaySubmissionState = 'SUBMITTING' | 'UNCONFIRMED' | 'SAVE_FAILED' | 'FAILED' | 'LISTED' | 'ADOPTED';
interface EbaySubmission {
  state: EbaySubmissionState;
  sku: string;
  startedAt: string;
  attempt: number;
  itemId?: string;
  finishedAt?: string;
}

/** AddItem 결과를 알 수 없는 이전 시도가 활성 목록에 나타날 때까지 기다리는 시간 */
export const EBAY_SUBMISSION_SETTLE_MS = 30 * 60 * 1000;

function readEbaySubmission(platformData: unknown): EbaySubmission | null {
  const value = (platformData as Record<string, any> | null)?.ebaySubmission;
  return value && typeof value === 'object' && typeof value.state === 'string' ? value as EbaySubmission : null;
}

/** 이전 시도가 eBay에 상품을 만들었을 수 있는 상태 */
function isUnresolvedSubmission(submission: EbaySubmission | null): submission is EbaySubmission {
  return !!submission && (submission.state === 'SUBMITTING' || submission.state === 'UNCONFIRMED' || submission.state === 'SAVE_FAILED');
}

function csvChargeableWeightG(product: { metadata: unknown }, fallback: number): number {
  const csv = readProductCsvMetadata(product.metadata);
  const weight = Number(csv?.shippingQuote?.chargeableWeightG ?? csv?.chargeableWeightG);
  return Number.isFinite(weight) && weight > 0 ? Math.round(weight) : fallback;
}

type ListingRow = typeof platformListings.$inferSelect;

/**
 * 신규 CSV eBay 등록 (create/retry/relist 공용) — 중복 등록 방지 순서:
 * 1. 같은 SKU 활성 eBay 상품 READ-ONLY 확인 (job 캐시) → 있으면 AddItem 없이 Item ID 연결 (ADOPTED_EXISTING)
 * 2. 결과 불명 이전 시도가 아직 확인되지 않으면 차단
 * 3. AddItem 전에 pending + ebaySubmission(SUBMITTING) 기록 (조건부 갱신으로 동시 실행 차단)
 * 4. AddItem → Item ID 저장. 저장 실패 시 EBAY_ITEM_SAVE_FAILED (다음 시도는 1번에서 연결)
 */
async function submitCsvEbayListing(args: {
  product: { id: number; sku: string; title: string };
  pricing: ResolvedListing;
  listing: ListingRow | undefined;
  input: ListingInput;
  checker?: EbayDuplicateChecker;
}): Promise<{ listingId: number; itemId: string; url: string; adopted: boolean }> {
  const { product, pricing, input } = args;
  const checker = args.checker ?? createEbayDuplicateChecker();
  const sku = product.sku;
  const audit = pricingAudit(pricing);
  const now = () => new Date().toISOString();
  const previous = readEbaySubmission(args.listing?.platformData);

  // 1. READ-ONLY 중복 확인 — 실패/불확실하면 여기서 예외 (DB 변경·AddItem 없음)
  const found = await checker.find(sku);
  if (found) {
    const url = `https://www.ebay.com/itm/${found.itemId}`;
    const submission: EbaySubmission = { ...(previous ?? { sku, startedAt: now(), attempt: 0 }), sku, state: 'ADOPTED', itemId: found.itemId, finishedAt: now() };
    const values = {
      status: 'active', platformItemId: found.itemId, listingUrl: url, lastSyncedAt: new Date(),
      price: String(pricing.salePrice), shippingCost: String(pricing.shippingCost),
      platformData: { ...audit, ebaySubmission: submission },
    };
    let listingId: number;
    if (args.listing) {
      await db.update(platformListings).set(values).where(eq(platformListings.id, args.listing.id));
      listingId = args.listing.id;
    } else {
      const [row] = await db.insert(platformListings).values({ productId: product.id, platform: 'ebay', platformSku: sku, title: product.title, currency: 'USD', quantity: input.quantity, ...values }).returning();
      listingId = row.id;
    }
    console.log(`[리스팅] eBay 기존 상품 연결 (SKU ${sku}): ${found.itemId} — AddItem 생략`);
    return { listingId, itemId: found.itemId, url, adopted: true };
  }

  // 2. 이전 시도 결과를 아직 확인할 수 없으면 재등록하지 않음
  if (isUnresolvedSubmission(previous)) {
    const age = Date.now() - new Date(previous.startedAt).getTime();
    if (previous.itemId) {
      throw new ListingPriceError(EBAY_DUPLICATE_CHECK_FAILED, `이전 시도에서 eBay Item ID ${previous.itemId}가 만들어졌지만 활성 목록에서 확인되지 않아 다시 등록하지 않았습니다. eBay에서 확인하세요.`);
    }
    if (!(age >= EBAY_SUBMISSION_SETTLE_MS)) {
      throw new ListingPriceError(EBAY_DUPLICATE_CHECK_FAILED, '이전 eBay 등록 요청의 결과를 아직 확인할 수 없어 다시 등록하지 않았습니다. 잠시 후 다시 시도하세요.');
    }
  }

  // 3. AddItem 전에 pending + 시도 기록 (다른 작업이 먼저 바꿨으면 차단)
  const submission: EbaySubmission = { state: 'SUBMITTING', sku, startedAt: now(), attempt: (previous?.attempt ?? 0) + 1 };
  const pendingValues = {
    status: 'pending', platformItemId: null, listingUrl: null,
    price: String(pricing.salePrice), shippingCost: String(pricing.shippingCost),
    platformData: { ...audit, ebaySubmission: submission },
  };
  let listingId: number;
  try {
    if (args.listing) {
      const claimed = await db.update(platformListings).set(pendingValues)
        .where(and(eq(platformListings.id, args.listing.id), eq(platformListings.status, args.listing.status)))
        .returning();
      if (claimed.length !== 1) throw new Error('다른 작업이 이 리스팅을 먼저 변경했습니다');
      listingId = args.listing.id;
    } else {
      const [row] = await db.insert(platformListings).values({ productId: product.id, platform: 'ebay', platformSku: sku, title: product.title, currency: 'USD', quantity: input.quantity, ...pendingValues }).returning();
      listingId = row.id;
    }
  } catch (e) {
    throw new ListingPriceError(EBAY_DUPLICATE_CHECK_FAILED, `eBay 등록 시작 기록에 실패해 등록하지 않았습니다: ${(e as Error).message}`);
  }

  // 4. AddItem
  let result: { itemId: string; url: string };
  try {
    result = await getAdapter('ebay').createListing(input);
  } catch (e) {
    const outcome = (e as { ebayAddItemOutcome?: string }).ebayAddItemOutcome;
    const unconfirmed = outcome === 'UNKNOWN';
    try {
      await db.update(platformListings).set({
        status: 'error',
        platformData: { ...audit, error: (e as Error).message, ebaySubmission: { ...submission, state: unconfirmed ? 'UNCONFIRMED' : 'FAILED', finishedAt: now() } },
      }).where(eq(platformListings.id, listingId));
    } catch { /* pending + SUBMITTING 기록이 남아 다음 시도에서 확인 */ }
    if (unconfirmed) {
      throw new ListingPriceError('EBAY_ADDITEM_UNCONFIRMED', `eBay 등록 응답을 확인하지 못했습니다. 다음 시도에서 eBay 기존 상품을 먼저 확인합니다: ${(e as Error).message}`);
    }
    throw e;
  }

  // 5. Item ID 저장
  try {
    await db.update(platformListings).set({
      status: 'active', platformItemId: result.itemId, listingUrl: result.url, lastSyncedAt: new Date(),
      platformData: { ...audit, ebaySubmission: { ...submission, state: 'LISTED', itemId: result.itemId, finishedAt: now() } },
    }).where(eq(platformListings.id, listingId));
  } catch (e) {
    try {
      await db.update(platformListings).set({
        platformData: { ...audit, ebaySubmission: { ...submission, state: 'SAVE_FAILED', itemId: result.itemId, finishedAt: now() } },
      }).where(eq(platformListings.id, listingId));
    } catch { /* SUBMITTING 기록으로 다음 시도에서 확인 */ }
    throw new ListingPriceError('EBAY_ITEM_SAVE_FAILED', `eBay 등록(Item ID ${result.itemId})은 완료됐지만 DB 저장에 실패했습니다. 다시 시도하면 eBay에 재등록하지 않고 기존 상품을 연결합니다: ${(e as Error).message}`);
  }
  checker.remember(sku, result.itemId);
  console.log(`[리스팅] active: ${result.url}`);
  return { listingId, itemId: result.itemId, url: result.url, adopted: false };
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

  // USD CSV 원본: 환산가(USD)/매입원가/무게/치수를 metadata.csvImport에 보존
  const csvMetadata = buildProductCsvMetadata(crawlResult);
  const csvNameKo = rawData.csvImport?.fields?.nameKo;

  // Gemini 영문 번역 (titleEn 또는 CSV 영문 상품명이 있으면 제목은 유지)
  const fixedTitle = crawlResult.titleEn || (csvMetadata ? crawlResult.title : null);
  const translated = fixedTitle
    ? { ...(await translateProduct(crawlResult.title, rawData)), title: fixedTitle }
    : await translateProduct(crawlResult.title, rawData);

  // products 생성 (소유자 정보 계승)
  const [product] = await db.insert(products).values({
    sku,
    title: translated.title,             // 영문 번역
    titleKo: csvMetadata && typeof csvNameKo === 'string' && csvNameKo ? csvNameKo : crawlResult.title, // 한글 원본 보존
    description: translated.description,  // 영문 상품 설명
    productType: translated.productType,  // 영문 카테고리
    tags: translated.tags.length > 0 ? translated.tags : undefined,
    // USD CSV의 crawl price는 판매가(USD)이므로 KRW 매입가로 넣지 않음
    costPrice: csvMetadata
      ? (csvMetadata.purchaseCostKrw !== null ? String(csvMetadata.purchaseCostKrw) : null)
      : (crawlResult.price || '0'),
    sourceUrl: crawlResult.url,
    sourcePlatform: 'coupang',           // TODO: source에서 가져오기
    brand: rawData.brand || rawData.vendor || rawData.mallName || '',
    condition: 'new',
    status: 'active',
    metadata: csvMetadata ? { importedFrom: crawlResultId, csvImport: csvMetadata } : { importedFrom: crawlResultId },
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
  options: { dryRun?: boolean; weightG?: number; ebayDuplicateChecker?: EbayDuplicateChecker } = {},
): Promise<{ listingId: number; itemId?: string; url?: string; existing?: boolean; adopted?: boolean }> {
  const { dryRun = false, weightG = 500 } = options;

  const product = await db.query.products.findFirst({
    where: eq(products.id, productId),
    with: { images: true },
  });

  if (!product) throw new Error(`product #${productId} 없음`);
  const csvProduct = isNewCsvProduct(product);

  if (csvProduct) {
    //   신규 CSV: 이미 플랫폼 ID가 저장된 active 리스팅이면 가격 검증·API 호출 없이 기존 등록으로 처리 (중복 등록 방지)
    const listed = await db.query.platformListings.findFirst({
      where: and(eq(platformListings.productId, productId), eq(platformListings.platform, platform)),
    });
    if (listed && listed.status === 'active' && listed.platformItemId) {
      return { listingId: listed.id, itemId: listed.platformItemId, url: listed.listingUrl || undefined, existing: true };
    }
  }

  // 판매가 결정 (USD CSV 고정가/배송비 반영 또는 기존 계산) — 검증 실패 시 여기서 차단
  const pricing = await resolveProductSalePrice(product, platform, 'create');

  if (csvProduct && platform === 'ebay') {
    //   신규 CSV eBay: 기존 행을 지우지 않고 중복 확인 → pending 기록 → AddItem (dry run은 DB·API 변경 없음)
    const current = await db.query.platformListings.findFirst({
      where: and(eq(platformListings.productId, productId), eq(platformListings.platform, 'ebay')),
    });
    if (dryRun) return { listingId: current?.id ?? 0 };
    const defaultQty = (await getPricingSettings('ebay')).defaultQuantity || 5;
    const template = await getDescriptionTemplate('ebay');
    const input: ListingInput = {
      title: product.title,
      description: buildPlatformDescription(product.description || `<p>${product.title}</p>`, template, 'ebay'),
      price: pricing.salePrice,
      shippingCost: pricing.shippingCost,
      quantity: defaultQty,
      sku: product.sku,
      condition: product.condition || 'ungraded',
      imageUrls: product.images.map((img: any) => img.url),
      productType: product.productType || '',
      brand: product.brand || '',
      weight: weightG,
      itemSpecifics: ((product as any).itemSpecifics && typeof (product as any).itemSpecifics === 'object') ? (product as any).itemSpecifics : {},
      shippingProfileId: pricing.shippingProfileId,
    };
    return submitCsvEbayListing({ product, pricing, listing: current, input, checker: options.ebayDuplicateChecker });
  }

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
      return { listingId: existingListing.id, itemId: existingListing.platformItemId || undefined, url: existingListing.listingUrl || undefined, existing: true };
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
    platformData: pricingAudit(pricing),
  }).returning();

  console.log(`[리스팅] draft 생성: #${listing.id} (${platform}, $${pricing.salePrice}, ${pricing.source})`);

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
    //   신규 CSV Shopify: 견적에 쓴 적용무게
    weight: csvProduct && platform === 'shopify' ? csvChargeableWeightG(product, weightG) : weightG,
    itemSpecifics,
    shippingProfileId: pricing.shippingProfileId,
  };

  try {
    // pending 상태로 변경
    await db.update(platformListings)
      .set({ status: 'pending' })
      .where(eq(platformListings.id, listing.id));

    const result = await createOrAdoptListing(adapter, platform, input, csvProduct);

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
    return { listingId: listing.id, itemId: result.itemId, url: result.url, adopted: result.adopted };

  } catch (e) {
    console.error(`[리스팅] 에러 (product #${productId}, ${platform}):`, (e as Error).message, (e as Error).stack);
    // error 상태로 변경
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { ...pricingAudit(pricing), error: (e as Error).message },
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
  options: { weightG?: number; ebayDuplicateChecker?: EbayDuplicateChecker } = {},
): Promise<{ listingId: number; itemId?: string; url?: string; adopted?: boolean }> {
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

  // 판매가 재결정 (createListing과 동일 규칙)
  const pricing = await resolveProductSalePrice(product, listing.platform, 'retry');
  const csvProduct = isNewCsvProduct(product);

  if (csvProduct && listing.platform === 'ebay') {
    const retryTemplate = await getDescriptionTemplate('ebay');
    return submitCsvEbayListing({
      product, pricing, listing, checker: options.ebayDuplicateChecker,
      input: {
        title: product.title,
        description: buildPlatformDescription(product.description || `<p>${product.title}</p>`, retryTemplate, 'ebay'),
        price: pricing.salePrice, shippingCost: pricing.shippingCost, quantity: listing.quantity || 5, sku: product.sku,
        condition: product.condition || 'ungraded', imageUrls: product.images.map((img: any) => img.url),
        productType: product.productType || '', brand: product.brand || '', weight: weightG, shippingProfileId: pricing.shippingProfileId,
      },
    });
  }

  // 상태 리셋 + 가격 업데이트
  await db.update(platformListings)
    .set({
      status: 'pending',
      platformItemId: null,
      listingUrl: null,
      platformData: pricingAudit(pricing),
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
    weight: csvProduct && listing.platform === 'shopify' ? csvChargeableWeightG(product, weightG) : weightG,
    shippingProfileId: pricing.shippingProfileId,
  };

  try {
    const result = await createOrAdoptListing(adapter, listing.platform, input, csvProduct);

    await db.update(platformListings)
      .set({
        status: 'active',
        platformItemId: result.itemId,
        listingUrl: result.url,
        lastSyncedAt: new Date(),
      })
      .where(eq(platformListings.id, listingId));

    console.log(`[리스팅] 재시도 성공: ${result.url}`);
    return { listingId, itemId: result.itemId, url: result.url, adopted: result.adopted };

  } catch (e) {
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { ...pricingAudit(pricing), error: (e as Error).message },
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

  if (listing.status === 'draft' && !isUnresolvedSubmission(readEbaySubmission(listing.platformData))) {
    // 플랫폼에 올라간 적 없으므로 레코드 삭제
    await db.delete(platformListings)
      .where(eq(platformListings.id, listingId));
  } else {
    //   신규 CSV eBay 등록 시도 기록은 보존 — 결과 불명 AddItem 이후 취소해도 중복 확인이 유지되도록
    const submission = readEbaySubmission(listing.platformData);
    await db.update(platformListings)
      .set({
        status: 'draft',
        platformItemId: null,
        listingUrl: null,
        platformData: submission ? { ebaySubmission: submission } : null,
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
  options: { weightG?: number; ebayDuplicateChecker?: EbayDuplicateChecker } = {},
): Promise<{ listingId: number; itemId?: string; url?: string; adopted?: boolean }> {
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

  // 판매가 재결정 (createListing과 동일 규칙)
  const pricing = await resolveProductSalePrice(product, listing.platform, 'retry');
  const csvProduct = isNewCsvProduct(product);

  if (csvProduct && listing.platform === 'ebay') {
    const relistTemplate = await getDescriptionTemplate('ebay');
    return submitCsvEbayListing({
      product, pricing, listing, checker: options.ebayDuplicateChecker,
      input: {
        title: product.title,
        description: buildPlatformDescription(product.description || `<p>${product.title}</p>`, relistTemplate, 'ebay'),
        price: pricing.salePrice, shippingCost: pricing.shippingCost, quantity: listing.quantity || 5, sku: product.sku,
        condition: product.condition || 'ungraded', imageUrls: product.images.map((img: any) => img.url),
        productType: product.productType || '', brand: product.brand || '', weight: weightG, shippingProfileId: pricing.shippingProfileId,
      },
    });
  }

  // 상태 리셋
  await db.update(platformListings)
    .set({
      status: 'pending',
      platformItemId: null,
      listingUrl: null,
      platformData: pricingAudit(pricing),
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
    weight: csvProduct && listing.platform === 'shopify' ? csvChargeableWeightG(product, weightG) : weightG,
    shippingProfileId: pricing.shippingProfileId,
  };

  try {
    const result = await createOrAdoptListing(adapter, listing.platform, input, csvProduct);

    await db.update(platformListings)
      .set({
        status: 'active',
        platformItemId: result.itemId,
        listingUrl: result.url,
        lastSyncedAt: new Date(),
      })
      .where(eq(platformListings.id, listingId));

    console.log(`[리스팅] 판매 재개 성공: ${result.url}`);
    return { listingId, itemId: result.itemId, url: result.url, adopted: result.adopted };

  } catch (e) {
    await db.update(platformListings)
      .set({
        status: 'error',
        platformData: { ...pricingAudit(pricing), error: (e as Error).message },
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
