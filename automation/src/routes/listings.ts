/**
 * 리스팅 생성 + SSE 진행률 라우트
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { jobStore, type JobState, type JobResult } from '../lib/job-store.js';
import { importFromCrawl, createListing, retryListing, endListing, cancelListing, relistListing, deleteProduct } from '../services/listing-service.js';
import { syncAllInventory } from '../services/inventory-sync.js';
import { db } from '../db/index.js';
import { crawlResults, platformListings, products } from '../db/schema.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getUser } from '../lib/user-session.js';
import { assertCrawlResultOwnership, OwnershipError } from '../lib/ownership.js';

async function runListingJob(
  jobId: string,
  crawlResultIds: number[],
  platforms: string[],
  dryRun: boolean,
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
          error: (e as Error).message,
        });
      }
      await jobStore.update(jobId, { failed: job.failed, results: job.results });
      continue;
    }

    // 각 플랫폼에 리스팅 생성
    for (const platform of platforms) {
      const job = await jobStore.get(jobId);
      if (!job) return;

      try {
        const result = await createListing(productId, platform, { dryRun });

        job.completed++;
        job.results.push({
          crawlResultId: crId,
          title,
          platform,
          success: true,
          platformItemId: result.itemId,
          listingUrl: result.url,
        });
      } catch (e) {
        job.failed++;
        job.results.push({
          crawlResultId: crId,
          title,
          platform,
          success: false,
          error: (e as Error).message,
        });
      }

      await jobStore.update(jobId, {
        completed: job.completed,
        failed: job.failed,
        results: job.results,
      });

      // 아이템 간 딜레이 (레이트 리밋 방지)
      if (!dryRun) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
}

async function runRetryJob(jobId: string, listings: any[]) {
  for (const listing of listings) {
    const title = listing.product?.titleKo || listing.product?.title || listing.title || `#${listing.id}`;
    const job = await jobStore.get(jobId);
    if (!job) return;

    try {
      const result = await retryListing(listing.id);

      job.completed++;
      job.results.push({
        crawlResultId: listing.productId,
        title,
        platform: listing.platform,
        success: true,
        platformItemId: result.itemId,
        listingUrl: result.url,
      });
    } catch (e) {
      job.failed++;
      job.results.push({
        crawlResultId: listing.productId,
        title,
        platform: listing.platform,
        success: false,
        error: (e as Error).message,
      });
    }

    await jobStore.update(jobId, {
      completed: job.completed,
      failed: job.failed,
      results: job.results,
    });

    // 레이트 리밋 방지
    await new Promise(r => setTimeout(r, 500));
  }

  await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
}

async function runRelistJob(jobId: string, listings: any[]) {
  for (const listing of listings) {
    const title = listing.product?.titleKo || listing.product?.title || listing.title || `#${listing.id}`;
    const job = await jobStore.get(jobId);
    if (!job) return;

    try {
      const result = await relistListing(listing.id);

      job.completed++;
      job.results.push({
        crawlResultId: listing.productId,
        title,
        platform: listing.platform,
        success: true,
        platformItemId: result.itemId,
        listingUrl: result.url,
      });
    } catch (e) {
      job.failed++;
      job.results.push({
        crawlResultId: listing.productId,
        title,
        platform: listing.platform,
        success: false,
        error: (e as Error).message,
      });
    }

    await jobStore.update(jobId, {
      completed: job.completed,
      failed: job.failed,
      results: job.results,
    });

    // 레이트 리밋 방지
    await new Promise(r => setTimeout(r, 500));
  }

  await jobStore.update(jobId, { status: 'done', finishedAt: new Date() });
}

export async function listingRoutes(app: FastifyInstance) {
  // POST /api/listings/create — 리스팅 생성 시작 (복수 플랫폼 지원)
  app.post('/listings/create', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    }

    const { crawlResultIds, platforms, platform, dryRun = false } = request.body as {
      crawlResultIds: number[];
      platforms?: string[];
      platform?: string;       // 하위 호환
      dryRun?: boolean;
    };

    const platformList = platforms || (platform ? [platform] : []);

    if (!crawlResultIds?.length || !platformList.length) {
      return { error: 'crawlResultIds와 platforms(또는 platform)이 필요합니다' };
    }

    // 소유권 검증
    try {
      await assertCrawlResultOwnership(crawlResultIds, user);
    } catch (e) {
      if (e instanceof OwnershipError) {
        return reply.status(403).send({ error: e.message });
      }
      throw e;
    }

    const jobId = randomUUID();
    const job: JobState = {
      status: 'running',
      platforms: platformList,
      total: crawlResultIds.length * platformList.length,
      completed: 0,
      failed: 0,
      results: [],
      createdAt: new Date(),
      dryRun,
    };
    await jobStore.set(jobId, job);

    // 비동기 실행 (await 하지 않음)
    runListingJob(jobId, crawlResultIds, platformList, dryRun);

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
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

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

    // 비동기 실행
    runRetryJob(jobId, listings);

    return { jobId };
  });

  // POST /api/listings/end — 판매 내리기 (active → ended)
  app.post('/listings/end', async (request) => {
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

    return {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  });

  // POST /api/listings/cancel — 업로드 취소 (pending/error → draft)
  app.post('/listings/cancel', async (request) => {
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

    return {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  });

  // POST /api/listings/relist — 판매 재개 (ended → re-upload)
  app.post('/listings/relist', async (request) => {
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

    // 비동기 실행
    runRelistJob(jobId, listings);

    return { jobId };
  });

  // POST /api/listings/delete — 상품 + 리스팅 삭제
  app.post('/listings/delete', async (request) => {
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

    return {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
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

    return { success: true, trashedProducts, trashedCrawls };
  });

  // POST /api/restore — 휴지통에서 복원
  app.post('/restore', async (request) => {
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

    return { success: true, restoredProducts, restoredCrawls };
  });

  // POST /api/permanently-delete — 완전 삭제
  app.post('/permanently-delete', async (request) => {
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

    return {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  });
}
