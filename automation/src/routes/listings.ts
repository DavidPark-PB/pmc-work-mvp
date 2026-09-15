/**
 * 리스팅 생성 + SSE 진행률 라우트
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { jobStore, type JobState } from '../lib/job-store.js';
import { importFromCrawl, createListing, retryListing, endListing, cancelListing, relistListing, deleteProduct } from '../services/listing-service.js';
import { createEbayDuplicateChecker, type EbayDuplicateChecker } from '../services/ebay-duplicate-check.js';
import { reconcileListings } from '../services/listing-reconcile.js';
import { syncAllInventory } from '../services/inventory-sync.js';
import { db } from '../db/index.js';
import { crawlResults, platformListings, products } from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getUser } from '../lib/user-session.js';
import { assertCrawlResultOwnership, assertProductOwnership, OwnershipError } from '../lib/ownership.js';
import { logBatchAction } from '../lib/audit-log.js';

/** 신규 USD CSV 상품 여부 (metadata.csvImport) */
function isCsvMetadata(metadata: unknown): boolean {
  return !!(metadata && typeof metadata === 'object' && (metadata as Record<string, unknown>).csvImport);
}

interface PlatformStep {
  platform: string;
  run: () => Promise<{ itemId?: string; url?: string; existing?: boolean; adopted?: boolean }>;
}

/** 신규 CSV: eBay를 먼저, 그다음 Shopify (나머지 순서 유지) */
export function orderStepsForCsv<T extends { platform: string }>(steps: T[]): T[] {
  const rank = (p: string) => (p === 'ebay' ? 0 : p === 'shopify' ? 1 : 2);
  return steps.map((step, i) => ({ step, i })).sort((a, b) => rank(a.step.platform) - rank(b.step.platform) || a.i - b.i).map(x => x.step);
}

const SKIPPED_EBAY_REQUIRED_MESSAGE = 'eBay 등록이 성공하지 않아 Shopify를 실행하지 않았습니다.';

/** 리스팅 job 단계 사이 대기 (API rate limit 여유) — 테스트는 sleep을 교체해 실제 시간을 기다리지 않는다 */
export const listingJobTimers = {
  stepDelayMs: 500,
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

const KNOWN_PLATFORMS = new Set(['ebay', 'shopify', 'alibaba', 'shopee']);

/** 상품별 실행 플랫폼 — 신규 CSV는 csvPlatforms(업로드 전 확인창 선택), 레거시는 기존 platforms */
function stepPlatformsFor(csvProduct: boolean, platforms: string[], csvPlatforms: string[] | undefined): string[] {
  return csvProduct && csvPlatforms ? csvPlatforms : platforms;
}

/**
 * 상품 1개의 플랫폼별 등록/재시도/재개 — create·retry·relist job 공용
 * - 레거시: 선택 순서 그대로, 플랫폼끼리 독립 (기존 동작)
 * - 신규 CSV: eBay → Shopify. 같은 실행에서 eBay 등록 + Item ID 저장이 성공(또는 DB에 active eBay Item ID)해야 Shopify 실행.
 *   아니면 Shopify는 호출하지 않고 job 결과에만 SKIPPED_EBAY_REQUIRED (platform_listings 행 생성 없음)
 * - 한 플랫폼 실패는 다른 플랫폼·다른 상품 결과에 영향 없음
 * 반환 false = job 사라짐
 */
async function processProductSteps(
  jobId: string,
  ctx: { crawlResultId: number; productId: number; title: string; csvProduct: boolean; dryRun: boolean; plannedSteps?: number },
  steps: PlatformStep[],
): Promise<boolean> {
  const ordered = ctx.csvProduct ? orderStepsForCsv(steps) : steps;
  const hasEbayStep = ordered.some(s => s.platform === 'ebay');
  let ebayListed: boolean | null = null;

  if (ctx.plannedSteps !== undefined && ctx.plannedSteps !== ordered.length) {
    const job = await jobStore.get(jobId);
    if (!job) return false;
    await jobStore.update(jobId, { total: job.total + ordered.length - ctx.plannedSteps });
  }

  for (const step of ordered) {
    const job = await jobStore.get(jobId);
    if (!job) return false;
    const base = { crawlResultId: ctx.crawlResultId, productId: ctx.productId, title: ctx.title, platform: step.platform };
    const skip = () => {
      job.results.push({ ...base, success: false, status: 'SKIPPED_EBAY_REQUIRED', code: 'SKIPPED_EBAY_REQUIRED', error: SKIPPED_EBAY_REQUIRED_MESSAGE });
    };

    if (ctx.csvProduct && step.platform === 'shopify' && hasEbayStep && ebayListed !== true) {
      skip();
      await jobStore.update(jobId, { results: job.results });
      continue;
    }

    try {
      const result = await step.run();
      job.completed++;
      job.results.push({
        ...base,
        success: true,
        status: result.existing ? 'ALREADY_LISTED' : 'SUCCESS',
        code: result.adopted ? 'ADOPTED_EXISTING' : null,
        platformItemId: result.itemId,
        listingUrl: result.url,
      });
      if (step.platform === 'ebay') ebayListed = !!result.itemId;
    } catch (e) {
      const code = (e as { code?: string }).code ?? null;
      if (ctx.csvProduct && step.platform === 'shopify' && code === 'EBAY_REQUIRED') {
        //   Shopify 단독 실행인데 DB에 active eBay Item ID가 없음 — API 호출 없이 미실행
        skip();
      } else {
        job.failed++;
        job.results.push({ ...base, success: false, status: 'FAILED', code, error: (e as Error).message });
      }
      if (step.platform === 'ebay') ebayListed = false;
    }

    await jobStore.update(jobId, { completed: job.completed, failed: job.failed, results: job.results });
    if (!ctx.dryRun) await listingJobTimers.sleep(listingJobTimers.stepDelayMs);
  }
  return true;
}

/** 이미 import된 product에 대해 리스팅만 생성 */
async function runProductListingJob(
  jobId: string,
  productIds: number[],
  platforms: string[],
  dryRun: boolean,
  options: { csvPlatforms?: string[]; ebayDuplicateChecker: EbayDuplicateChecker },
) {
  for (const productId of productIds) {
    const product = await db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    const title = product?.titleKo || product?.title || `#${productId}`;
    const csvProduct = isCsvMetadata(product?.metadata);
    const alive = await processProductSteps(
      jobId,
      { crawlResultId: productId, productId, title, csvProduct, dryRun, plannedSteps: platforms.length },
      stepPlatformsFor(csvProduct, platforms, options.csvPlatforms)
        .map(platform => ({ platform, run: () => createListing(productId, platform, { dryRun, ebayDuplicateChecker: options.ebayDuplicateChecker }) })),
    );
    if (!alive) return;
  }

  await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
}

async function runListingJob(
  jobId: string,
  crawlResultIds: number[],
  platforms: string[],
  dryRun: boolean,
  markDone: boolean = true,
  options: { csvPlatforms?: string[]; ebayDuplicateChecker: EbayDuplicateChecker } = { ebayDuplicateChecker: createEbayDuplicateChecker() },
) {
  for (const crId of crawlResultIds) {
    // 크롤 결과 제목 조회
    const cr = await db.query.crawlResults.findFirst({
      where: eq(crawlResults.id, crId),
    });
    const title = cr?.title || `#${crId}`;

    let productId: number;
    try {
      productId = await importFromCrawl(crId);
    } catch (e) {
      // import 실패 시 모든 플랫폼에 대해 실패 처리
      const job = await jobStore.get(jobId);
      if (!job) return;
      for (const platform of platforms) {
        job.failed++;
        job.results.push({
          crawlResultId: crId,
          title,
          platform,
          success: false,
          status: 'FAILED',
          code: (e as { code?: string }).code ?? null,
          error: (e as Error).message,
        });
      }
      await jobStore.update(jobId, { failed: job.failed, results: job.results });
      continue;
    }

    const product = await db.query.products.findFirst({ where: eq(products.id, productId) });
    const csvProduct = isCsvMetadata(product?.metadata);
    const alive = await processProductSteps(
      jobId,
      { crawlResultId: crId, productId, title, csvProduct, dryRun, plannedSteps: platforms.length },
      stepPlatformsFor(csvProduct, platforms, options.csvPlatforms)
        .map(platform => ({ platform, run: () => createListing(productId, platform, { dryRun, ebayDuplicateChecker: options.ebayDuplicateChecker }) })),
    );
    if (!alive) return;
  }

  if (markDone) {
    await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
  }
}

type ListingAction = (listingId: number, options: { ebayDuplicateChecker: EbayDuplicateChecker }) => Promise<{ itemId?: string; url?: string; adopted?: boolean }>;

/** retry / relist job — 같은 상품의 리스팅을 묶어 신규 CSV는 eBay → Shopify 순서로 처리 (eBay 중복 확인은 job 단위 1회) */
async function runListingActionJob(jobId: string, listings: any[], action: ListingAction) {
  const ebayDuplicateChecker = createEbayDuplicateChecker();
  const groups = new Map<number, any[]>();
  for (const listing of listings) {
    const key = listing.productId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(listing);
  }
  for (const [productId, group] of groups) {
    const first = group[0];
    const title = first.product?.titleKo || first.product?.title || first.title || `#${first.id}`;
    const alive = await processProductSteps(
      jobId,
      { crawlResultId: productId, productId, title, csvProduct: isCsvMetadata(first.product?.metadata), dryRun: false },
      group.map(listing => ({ platform: listing.platform, run: () => action(listing.id, { ebayDuplicateChecker }) })),
    );
    if (!alive) return;
  }

  await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
}

async function runRetryJob(jobId: string, listings: any[]) {
  await runListingActionJob(jobId, listings, (id, options) => retryListing(id, options));
}

async function runRelistJob(jobId: string, listings: any[]) {
  await runListingActionJob(jobId, listings, (id, options) => relistListing(id, options));
}

export async function listingRoutes(app: FastifyInstance) {
  // POST /api/listings/create — 리스팅 생성 시작 (복수 플랫폼 지원)
  app.post('/listings/create', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    }

    const { crawlResultIds, productIds, platforms, platform, csvPlatforms, dryRun = false } = request.body as {
      crawlResultIds?: number[];
      productIds?: number[];
      platforms?: string[];
      platform?: string;       // 하위 호환
      /** 신규 USD CSV 상품에 적용할 플랫폼 (업로드 전 확인창 선택). 미전달 시 platforms */
      csvPlatforms?: string[];
      dryRun?: boolean;
    };
    if (csvPlatforms !== undefined && (!Array.isArray(csvPlatforms) || csvPlatforms.some(p => typeof p !== 'string' || !KNOWN_PLATFORMS.has(p)))) {
      return reply.status(400).send({ error: 'csvPlatforms 형식이 올바르지 않습니다.' });
    }

    const platformList = platforms || (platform ? [platform] : []);
    const hasCrawl = crawlResultIds && crawlResultIds.length > 0;
    const hasProduct = productIds && productIds.length > 0;

    if ((!hasCrawl && !hasProduct) || !platformList.length) {
      return { error: 'crawlResultIds 또는 productIds와 platforms가 필요합니다' };
    }

    // 소유권 검증
    try {
      if (hasCrawl) await assertCrawlResultOwnership(crawlResultIds, user);
      if (hasProduct) await assertProductOwnership(productIds, user);
    } catch (e) {
      if (e instanceof OwnershipError) {
        return reply.status(403).send({ error: e.message });
      }
      throw e;
    }

    const totalItems = (hasCrawl ? crawlResultIds.length : 0) + (hasProduct ? productIds.length : 0);
    const jobId = randomUUID();
    const job: JobState = {
      status: 'running',
      platforms: platformList,
      total: totalItems * platformList.length,
      completed: 0,
      failed: 0,
      results: [],
      createdAt: new Date(),
      dryRun,
    };
    await jobStore.set(jobId, job);

    logBatchAction(user, 'listing.create', {
      targetType: 'listing',
      count: totalItems * platformList.length,
      details: { crawlResultIds, productIds, platforms: platformList, csvPlatforms, dryRun, jobId },
    });

    // 비동기 실행 (await 하지 않음)
    //   eBay 중복 확인(활성 SKU 조회)은 job 단위로 한 번만
    const jobOptions = { csvPlatforms: csvPlatforms ? [...new Set(csvPlatforms)] : undefined, ebayDuplicateChecker: createEbayDuplicateChecker() };
    (async () => {
      if (hasCrawl) await runListingJob(jobId, crawlResultIds, platformList, dryRun, !hasProduct, jobOptions);
      if (hasProduct) await runProductListingJob(jobId, productIds, platformList, dryRun, jobOptions);
    })();

    return { jobId };
  });

  // GET /api/listings/stream/:jobId — SSE 진행률
  app.get('/listings/stream/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await jobStore.get(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 클라이언트 재연결 간격 권고 (ms). 화면보호기 해제 직후 빠르게 재연결.
    reply.raw.write('retry: 3000\n\n');
    // 즉시 한 번 현재 상태 push — 재연결한 클라이언트가 1초를 더 기다리지 않게.
    reply.raw.write(`data: ${JSON.stringify(job)}\n\n`);

    const interval = setInterval(async () => {
      const current = await jobStore.get(jobId);
      if (!current) {
        clearInterval(interval);
        reply.raw.end();
        return;
      }

      reply.raw.write(`data: ${JSON.stringify(current)}\n\n`);

      if (current.status !== 'running') {
        clearInterval(interval);
        // 마지막 이벤트 보낸 후 종료
        setTimeout(() => reply.raw.end(), 500);
      }
    }, 1000);

    request.raw.on('close', () => {
      clearInterval(interval);
    });

    // Fastify가 자동 응답하지 않도록
    return reply;
  });

  //   POST /api/listings/reconcile — 실제 eBay/Shopify 등록 상태 조회 후 내부 연결만 보정
  //   dryRun(기본 true): 조회·계획만. dryRun=false: 확정 매칭만 platform_listings 갱신 (플랫폼 쓰기·신규 등록 없음)
  app.post('/listings/reconcile', async (request, reply) => {
    const user = getUser(request);
    if (!user) return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    if (!user.isAdmin) return reply.status(403).send({ error: '실제 플랫폼 상태 동기화는 관리자만 이용할 수 있습니다.' });

    const { dryRun = true, productIds } = (request.body ?? {}) as { dryRun?: boolean; productIds?: number[] };
    if (productIds !== undefined && (!Array.isArray(productIds) || productIds.some(id => !Number.isInteger(id)))) {
      return reply.status(400).send({ error: 'productIds 형식이 올바르지 않습니다.' });
    }

    const result = await reconcileListings({ dryRun, productIds });
    if (!dryRun) {
      logBatchAction(user, 'listing.reconcile', {
        targetType: 'listing',
        count: result.updated + result.inserted,
        details: { summary: result.summary, updated: result.updated, inserted: result.inserted },
      });
    }
    return {
      applied: result.applied,
      updated: result.updated,
      inserted: result.inserted,
      summary: result.summary,
      external: result.external,
      //   확인 필요 항목만 화면에 전달 (플랫폼 원본 응답·토큰은 전달하지 않음)
      matchRequired: result.rows.filter(r => r.status === 'MATCH_REQUIRED').slice(0, 50).map(r => ({
        productId: r.productId, sku: r.sku, title: r.title, reason: r.ebay.reason || r.shopify.reason || '',
      })),
    };
  });

  // POST /api/listings/sync-inventory — 재고 동기화
  app.post('/listings/sync-inventory', async () => {
    const results = await syncAllInventory();
    const changed = results.filter(r => r.changed);
    return {
      total: results.length,
      changed: changed.length,
      errors: results.filter(r => r.error).length,
      details: results,
    };
  });

  // POST /api/listings/retry — 실패/대기 리스팅 재시도
  app.post('/listings/retry', async (request) => {
    const user = getUser(request);
    const { listingIds } = request.body as {
      listingIds: number[];
    };

    if (!listingIds?.length) {
      return { error: 'listingIds가 필요합니다' };
    }

    // 리스팅 정보 조회 (플랫폼, 제목 확인)
    const listings = await db.query.platformListings.findMany({
      where: inArray(platformListings.id, listingIds),
      with: { product: true },
    });

    if (listings.length === 0) {
      return { error: '해당 리스팅을 찾을 수 없습니다' };
    }

    const uniquePlatforms = [...new Set(listings.map(l => l.platform))];
    const jobId = randomUUID();
    const job: JobState = {
      status: 'running',
      platforms: uniquePlatforms,
      total: listings.length,
      completed: 0,
      failed: 0,
      results: [],
      createdAt: new Date(),
      dryRun: false,
    };
    await jobStore.set(jobId, job);

    logBatchAction(user, 'listing.retry', {
      targetType: 'listing',
      count: listings.length,
      details: { listingIds, platforms: uniquePlatforms, jobId },
    });

    // 비동기 실행
    runRetryJob(jobId, listings);

    return { jobId };
  });

  // POST /api/listings/end — 판매 내리기 (active → ended)
  app.post('/listings/end', async (request) => {
    const user = getUser(request);
    const { listingIds } = request.body as { listingIds: number[] };

    if (!listingIds?.length) {
      return { error: 'listingIds가 필요합니다' };
    }

    const results: { id: number; success: boolean; error?: string }[] = [];
    for (const id of listingIds) {
      try {
        await endListing(id);
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: (e as Error).message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    logBatchAction(user, 'listing.end', {
      targetType: 'listing',
      count: listingIds.length,
      succeeded,
      failed: failedCount,
      details: { listingIds },
    });

    return { total: results.length, succeeded, failed: failedCount, results };
  });

  // POST /api/listings/cancel — 업로드 취소 (pending/error → draft)
  app.post('/listings/cancel', async (request) => {
    const user = getUser(request);
    const { listingIds } = request.body as { listingIds: number[] };

    if (!listingIds?.length) {
      return { error: 'listingIds가 필요합니다' };
    }

    const results: { id: number; success: boolean; error?: string }[] = [];
    for (const id of listingIds) {
      try {
        await cancelListing(id);
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: (e as Error).message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    logBatchAction(user, 'listing.cancel', {
      targetType: 'listing',
      count: listingIds.length,
      succeeded,
      failed: failedCount,
      details: { listingIds },
    });

    return { total: results.length, succeeded, failed: failedCount, results };
  });

  // POST /api/listings/relist — 판매 재개 (ended → re-upload)
  app.post('/listings/relist', async (request) => {
    const user = getUser(request);
    const { listingIds } = request.body as { listingIds: number[] };

    if (!listingIds?.length) {
      return { error: 'listingIds가 필요합니다' };
    }

    // 리스팅 정보 조회
    const listings = await db.query.platformListings.findMany({
      where: inArray(platformListings.id, listingIds),
      with: { product: true },
    });

    if (listings.length === 0) {
      return { error: '해당 리스팅을 찾을 수 없습니다' };
    }

    const uniquePlatforms = [...new Set(listings.map(l => l.platform))];
    const jobId = randomUUID();
    const job: JobState = {
      status: 'running',
      platforms: uniquePlatforms,
      total: listings.length,
      completed: 0,
      failed: 0,
      results: [],
      createdAt: new Date(),
      dryRun: false,
    };
    await jobStore.set(jobId, job);

    logBatchAction(user, 'listing.relist', {
      targetType: 'listing',
      count: listings.length,
      details: { listingIds, platforms: uniquePlatforms, jobId },
    });

    // 비동기 실행
    runRelistJob(jobId, listings);

    return { jobId };
  });

  // POST /api/listings/delete — 상품 + 리스팅 삭제
  app.post('/listings/delete', async (request) => {
    const user = getUser(request);
    const { productIds } = request.body as { productIds: number[] };

    if (!productIds?.length) {
      return { error: 'productIds가 필요합니다' };
    }

    const results: { id: number; success: boolean; error?: string }[] = [];
    for (const id of productIds) {
      try {
        await deleteProduct(id);
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: (e as Error).message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    logBatchAction(user, 'listing.delete', {
      targetType: 'product',
      count: productIds.length,
      succeeded,
      failed: failedCount,
      details: { productIds },
    });

    return { total: results.length, succeeded, failed: failedCount, results };
  });

  // GET /api/listings/job/:jobId — 잡 상태 조회 (폴링용)
  app.get('/listings/job/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await jobStore.get(jobId);

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    return job;
  });

  // POST /api/trash — 선택된 상품/크롤결과를 휴지통으로 이동
  app.post('/trash', async (request) => {
    const user = getUser(request);
    const { ids, types } = request.body as { ids: number[]; types: string[] };

    if (!ids?.length || !types?.length || ids.length !== types.length) {
      return { error: 'ids와 types 배열이 필요합니다 (같은 길이)' };
    }

    const productIds: number[] = [];
    const crawlIds: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (types[i] === 'product') productIds.push(ids[i]);
      else if (types[i] === 'crawl') crawlIds.push(ids[i]);
    }

    // 활성 리스팅(active/pending/draft) 있는 상품은 거부
    if (productIds.length > 0) {
      const activeListingProducts = await db.select({ productId: platformListings.productId })
        .from(platformListings)
        .where(and(
          inArray(platformListings.productId, productIds),
          inArray(platformListings.status, ['active', 'pending', 'draft']),
        ));

      const blockedIds = new Set(activeListingProducts.map(r => r.productId));
      if (blockedIds.size > 0) {
        return {
          error: '활성 리스팅이 있는 상품은 삭제할 수 없습니다',
          blockedIds: Array.from(blockedIds),
        };
      }
    }

    let trashedProducts = 0;
    let trashedCrawls = 0;

    if (productIds.length > 0) {
      const result = await db.update(products)
        .set({ status: 'trashed' })
        .where(inArray(products.id, productIds));
      trashedProducts = productIds.length;
    }

    if (crawlIds.length > 0) {
      await db.update(crawlResults)
        .set({ status: 'trashed' })
        .where(inArray(crawlResults.id, crawlIds));
      trashedCrawls = crawlIds.length;
    }

    logBatchAction(user, 'product.trash', {
      targetType: 'product',
      count: ids.length,
      details: { productIds, crawlIds },
    });

    return { success: true, trashedProducts, trashedCrawls };
  });

  // POST /api/restore — 휴지통에서 복원
  app.post('/restore', async (request) => {
    const user = getUser(request);
    const { ids, types } = request.body as { ids: number[]; types: string[] };

    if (!ids?.length || !types?.length || ids.length !== types.length) {
      return { error: 'ids와 types 배열이 필요합니다 (같은 길이)' };
    }

    const productIds: number[] = [];
    const crawlIds: number[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (types[i] === 'product') productIds.push(ids[i]);
      else if (types[i] === 'crawl') crawlIds.push(ids[i]);
    }

    let restoredProducts = 0;
    let restoredCrawls = 0;

    if (productIds.length > 0) {
      await db.update(products)
        .set({ status: 'active' })
        .where(inArray(products.id, productIds));
      restoredProducts = productIds.length;
    }

    if (crawlIds.length > 0) {
      await db.update(crawlResults)
        .set({ status: 'new' })
        .where(inArray(crawlResults.id, crawlIds));
      restoredCrawls = crawlIds.length;
    }

    logBatchAction(user, 'product.restore', {
      targetType: 'product',
      count: ids.length,
      details: { productIds, crawlIds },
    });

    return { success: true, restoredProducts, restoredCrawls };
  });

  // POST /api/permanently-delete — 완전 삭제
  app.post('/permanently-delete', async (request) => {
    const user = getUser(request);
    const { ids, types } = request.body as { ids: number[]; types: string[] };

    if (!ids?.length || !types?.length || ids.length !== types.length) {
      return { error: 'ids와 types 배열이 필요합니다 (같은 길이)' };
    }

    const results: { id: number; type: string; success: boolean; error?: string }[] = [];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const type = types[i];
      try {
        if (type === 'product') {
          await deleteProduct(id);
        } else if (type === 'crawl') {
          await db.delete(crawlResults).where(eq(crawlResults.id, id));
        }
        results.push({ id, type, success: true });
      } catch (e) {
        results.push({ id, type, success: false, error: (e as Error).message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    logBatchAction(user, 'product.permanentDelete', {
      targetType: 'product',
      count: ids.length,
      succeeded,
      failed: failedCount,
      details: { ids, types },
    });

    return { total: results.length, succeeded, failed: failedCount, results };
  });
}
