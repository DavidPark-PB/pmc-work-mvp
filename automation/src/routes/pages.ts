/**
 * 웹 페이지 라우트 (서버 렌더링)
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { crawlResults, crawlSources, csvUploads, platformListings, productImages, products } from '../db/schema.js';
import { eq, ne, inArray, sql, desc, asc, ilike, and, isNotNull } from 'drizzle-orm';
import { calculatePriceSync, getAllPricingSettings } from '../services/pricing.js';
import { jobStore } from '../lib/job-store.js';
import { getUser } from '../lib/user-session.js';

export async function pageRoutes(app: FastifyInstance) {
  // 대시보드 홈
  app.get('/', async (request, reply) => {
    const [
      productCount,
      productsByStatus,
      listingCount,
      listingsByPlatform,
      listingsByStatus,
      crawlByStatus,
      recentProductsWithListings,
      recentCrawlResults,
      completedCountResult,
      endedCountResult,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(products),
      db.select({ status: products.status, count: sql<number>`count(*)` })
        .from(products).groupBy(products.status),
      db.select({ count: sql<number>`count(*)` }).from(platformListings),
      db.select({ platform: platformListings.platform, count: sql<number>`count(*)` })
        .from(platformListings).groupBy(platformListings.platform),
      db.select({ status: platformListings.status, count: sql<number>`count(*)` })
        .from(platformListings).groupBy(platformListings.status),
      db.select({ status: crawlResults.status, count: sql<number>`count(*)` })
        .from(crawlResults).groupBy(crawlResults.status),
      // 상품 + 리스팅 통합 쿼리 (json_agg로 리스팅 배열 집계)
      db.select({
        id: products.id,
        sku: products.sku,
        titleKo: products.titleKo,
        title: products.title,
        status: products.status,
        costPrice: products.costPrice,
        sourceUrl: products.sourceUrl,
        sourcePlatform: products.sourcePlatform,
        createdAt: products.createdAt,
        imageUrl: sql<string>`COALESCE(
          NULLIF((SELECT url FROM product_images WHERE product_id = ${products.id} AND url IS NOT NULL AND url != '' ORDER BY position LIMIT 1), ''),
          (SELECT image_url FROM crawl_results WHERE product_id = ${products.id} AND image_url IS NOT NULL AND image_url != '' LIMIT 1)
        )`,
        listings: sql<string>`COALESCE(
          json_agg(
            json_build_object(
              'id', ${platformListings.id},
              'platform', ${platformListings.platform},
              'price', ${platformListings.price},
              'status', ${platformListings.status},
              'listingUrl', ${platformListings.listingUrl},
              'quantity', ${platformListings.quantity}
            )
          ) FILTER (WHERE ${platformListings.id} IS NOT NULL),
          '[]'
        )`,
      })
        .from(products)
        .leftJoin(platformListings, eq(products.id, platformListings.productId))
        .where(ne(products.status, 'trashed'))
        .groupBy(products.id, products.sku, products.titleKo, products.title, products.status, products.costPrice, products.sourceUrl, products.sourcePlatform, products.createdAt)
        .orderBy(desc(products.createdAt))
        .limit(200),
      // 크롤 대기 데이터 (아직 상품으로 안 만든 것)
      db.select({
        id: crawlResults.id,
        title: crawlResults.title,
        price: crawlResults.price,
        url: crawlResults.url,
        imageUrl: crawlResults.imageUrl,
        status: crawlResults.status,
        crawledAt: crawlResults.crawledAt,
        sourceName: crawlSources.name,
        ownerId: crawlResults.ownerId,
        ownerName: crawlResults.ownerName,
      })
        .from(crawlResults)
        .leftJoin(crawlSources, eq(crawlResults.sourceId, crawlSources.id))
        .where(eq(crawlResults.status, 'new'))
        .orderBy(desc(crawlResults.crawledAt))
        .limit(200),
      // 완료 내역 count (리스팅이 있는 고유 상품 수)
      db.select({ count: sql<number>`count(DISTINCT ${products.id})` })
        .from(products)
        .innerJoin(platformListings, eq(products.id, platformListings.productId)),
      // 판매 취소 count (ended 리스팅 수)
      db.select({ count: sql<number>`count(*)` })
        .from(platformListings)
        .where(eq(platformListings.status, 'ended')),
    ]);

    // 진행중인 잡
    const allJobs = await jobStore.entries();
    const activeJobs = allJobs
      .map(([id, job]) => ({ id, ...job }))
      .filter(j => j.status === 'running');

    // 헬퍼: status 맵 만들기
    const toMap = (rows: { status: string | null; count: number }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.status || 'unknown'] = Number(r.count);
      return m;
    };
    const platformMap = (rows: { platform: string; count: number }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.platform] = Number(r.count);
      return m;
    };

    // 가격 설정 1회 조회 (N+1 방지)
    const allSettings = await getAllPricingSettings();

    // 예상 판매가 계산 헬퍼 (동기 — DB 호출 없음)
    const calcPrices = (costKRW: number) => ({
      ebayPrice: calculatePriceSync(costKRW, allSettings['ebay']).salePrice,
      shopifyPrice: calculatePriceSync(costKRW, allSettings['shopify']).salePrice,
      alibabaPrice: calculatePriceSync(costKRW, allSettings['alibaba']).salePrice,
      shopeePrice: calculatePriceSync(costKRW, allSettings['shopee']).salePrice,
    });

    // 두 소스를 allItems로 통합
    const sourceLabels: Record<string, string> = { coupang: '쿠팡', lotte: '롯데온', emart: '이마트', naver: '네이버' };

    const productItemsWithPrice = recentProductsWithListings.map((p) => {
      const costKRW = parseFloat(String(p.costPrice)) || 0;
      const prices = costKRW > 0 ? calcPrices(costKRW) : { ebayPrice: 0, shopifyPrice: 0, alibabaPrice: 0, shopeePrice: 0 };
      return {
        type: 'product' as const,
        id: p.id,
        sku: p.sku,
        title: p.titleKo || p.title,
        imageUrl: p.imageUrl,
        sourceUrl: p.sourceUrl,
        sourceLabel: sourceLabels[p.sourcePlatform || ''] || p.sourcePlatform || '—',
        listings: p.listings,
        status: p.status,
        createdAt: p.createdAt,
        ...prices,
      };
    });

    const crawlItemsWithPrice = recentCrawlResults.map((c) => {
      const costKRW = parseFloat(String(c.price)) || 0;
      const prices = calcPrices(costKRW);
      return {
        type: 'crawl' as const,
        id: c.id,
        sku: null as string | null,
        title: c.title,
        imageUrl: c.imageUrl,
        sourceUrl: c.url,
        sourceLabel: c.sourceName || '—',
        costKrw: costKRW,
        listings: '[]',
        status: c.status,
        createdAt: c.crawledAt,
        ownerId: c.ownerId,
        ownerName: c.ownerName,
        ...prices,
      };
    });

    // productItems 먼저, crawlItems 뒤에 (기존 순서 유지)
    const allItems = [...productItemsWithPrice, ...crawlItemsWithPrice];

    const user = getUser(request);

    return reply.viewAsync('dashboard.eta', {
      step: 0,
      user,
      stats: {
        totalProducts: Number(productCount[0].count),
        productsByStatus: toMap(productsByStatus),
        totalListings: Number(listingCount[0].count),
        listingsByPlatform: platformMap(listingsByPlatform),
        listingsByStatus: toMap(listingsByStatus),
        crawlByStatus: toMap(crawlByStatus),
        completedCount: Number(completedCountResult[0].count),
        endedCount: Number(endedCountResult[0].count),
      },
      allItems,
      // 하위 호환: 업로드 대기 탭에서 crawlItems 직접 사용
      recentCrawlResults: crawlItemsWithPrice,
      activeJobs,
    });
  });

  // Step 1: CSV 업로드
  app.get('/upload-csv', async (request, reply) => {
    return reply.viewAsync('step1-upload.eta', { step: 1 });
  });

  // Step 2: DB 등록 미리보기
  app.get('/import', async (request, reply) => {
    const { uploadId } = request.query as { uploadId?: string };

    if (!uploadId) {
      return reply.redirect('/upload-csv');
    }

    const path = await import('path');
    const { parseCsvFile } = await import('../lib/csv-parser.js');
    const filePath = path.join(process.cwd(), 'data', 'uploads', `${uploadId}.csv`);

    let rows: any[] = [];
    try {
      rows = parseCsvFile(filePath);
    } catch {
      return reply.redirect('/upload-csv');
    }

    return reply.viewAsync('step2-import.eta', {
      step: 2,
      uploadId,
      rows,
      rowCount: rows.length,
    });
  });

  // Step 3: 쇼핑몰 선택 + 아이템 리스트
  app.get('/select', async (request, reply) => {
    const { ids } = request.query as { ids?: string };

    let items: any[] = [];

    if (ids) {
      const idArray = ids.split(',').map(Number).filter(Boolean);
      if (idArray.length > 0) {
        items = await db.select().from(crawlResults)
          .where(inArray(crawlResults.id, idArray))
          .orderBy(desc(crawlResults.id));
      }
    } else {
      items = await db.select().from(crawlResults)
        .where(eq(crawlResults.status, 'new'))
        .orderBy(desc(crawlResults.id))
        .limit(100);
    }

    // 가격 설정 1회 조회 (N+1 방지)
    const allSettings = await getAllPricingSettings();

    const user = getUser(request);

    const itemsWithPrice = items.map(item => {
      const costKRW = parseFloat(String(item.price)) || 0;
      return {
        ...item,
        ebayPrice: calculatePriceSync(costKRW, allSettings['ebay']).salePrice,
        shopifyPrice: calculatePriceSync(costKRW, allSettings['shopify']).salePrice,
        alibabaPrice: calculatePriceSync(costKRW, allSettings['alibaba']).salePrice,
        shopeePrice: calculatePriceSync(costKRW, allSettings['shopee']).salePrice,
      };
    });

    return reply.viewAsync('step3-select.eta', {
      step: 3,
      user,
      items: itemsWithPrice,
    });
  });

  // Step 4: 업로드 진행
  app.get('/upload', async (request, reply) => {
    const { jobId } = request.query as { jobId?: string };
    if (!jobId) return reply.redirect('/');

    return reply.viewAsync('step4-progress.eta', {
      step: 4,
      jobId,
    });
  });

  // Step 5: 결과
  app.get('/results', async (request, reply) => {
    const { jobId } = request.query as { jobId?: string };
    if (!jobId) return reply.redirect('/');

    const job = await jobStore.get(jobId);
    if (!job) return reply.redirect('/');

    return reply.viewAsync('step5-results.eta', {
      step: 5,
      job,
      jobId,
    });
  });

  // 완료 내역 JSON API (검색/소팅/필터/페이징)
  app.get('/api/completed', async (request) => {
    const {
      page = '1',
      limit = '50',
      sort = 'createdAt',
      order = 'desc',
      q = '',
      status = '',
      platform = '',
    } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    // WHERE 조건 빌드: platform_listings가 있는 상품만 (INNER JOIN 효과)
    const conditions: ReturnType<typeof eq>[] = [];

    // 상품명 검색
    if (q.trim()) {
      conditions.push(
        sql`(${products.titleKo} ILIKE ${'%' + q.trim() + '%'} OR ${products.title} ILIKE ${'%' + q.trim() + '%'} OR ${products.sku} ILIKE ${'%' + q.trim() + '%'})` as any
      );
    }

    // 상태 필터 (리스팅 상태 기준)
    if (status) {
      conditions.push(eq(platformListings.status, status));
    }

    // 판매처 필터
    if (platform) {
      conditions.push(eq(platformListings.platform, platform));
    }

    // 소팅 컬럼 매핑
    const sortColumns: Record<string, any> = {
      sku: products.sku,
      title: products.titleKo,
      createdAt: products.createdAt,
      sourcePlatform: products.sourcePlatform,
    };
    const sortCol = sortColumns[sort] || products.createdAt;
    const orderFn = order === 'asc' ? asc : desc;

    // 메인 쿼리: products INNER JOIN platform_listings (리스팅 있는 것만)
    const baseQuery = db
      .select({
        id: products.id,
        sku: products.sku,
        titleKo: products.titleKo,
        title: products.title,
        status: products.status,
        sourceUrl: products.sourceUrl,
        sourcePlatform: products.sourcePlatform,
        createdAt: products.createdAt,
        imageUrl: sql<string>`COALESCE(
          NULLIF((SELECT url FROM product_images WHERE product_id = ${products.id} AND url IS NOT NULL AND url != '' ORDER BY position LIMIT 1), ''),
          (SELECT image_url FROM crawl_results WHERE product_id = ${products.id} AND image_url IS NOT NULL AND image_url != '' LIMIT 1)
        )`,
        listings: sql<string>`COALESCE(
          json_agg(
            json_build_object(
              'id', ${platformListings.id},
              'platform', ${platformListings.platform},
              'price', ${platformListings.price},
              'status', ${platformListings.status},
              'listingUrl', ${platformListings.listingUrl},
              'quantity', ${platformListings.quantity}
            )
          ) FILTER (WHERE ${platformListings.id} IS NOT NULL),
          '[]'
        )`,
      })
      .from(products)
      .innerJoin(platformListings, eq(products.id, platformListings.productId));

    const whereClause = conditions.length > 0
      ? and(...conditions)
      : undefined;

    const [items, countResult] = await Promise.all([
      baseQuery
        .where(whereClause)
        .groupBy(products.id, products.sku, products.titleKo, products.title, products.status, products.sourceUrl, products.sourcePlatform, products.createdAt)
        .orderBy(orderFn(sortCol))
        .limit(limitNum)
        .offset(offset),
      db.select({ count: sql<number>`count(DISTINCT ${products.id})` })
        .from(products)
        .innerJoin(platformListings, eq(products.id, platformListings.productId))
        .where(whereClause),
    ]);

    const total = Number(countResult[0].count);

    return {
      data: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  });

  // 판매 취소 내역 JSON API (ended 리스팅)
  app.get('/api/ended', async (request) => {
    const {
      page = '1',
      limit = '50',
      sort = 'createdAt',
      order = 'desc',
      q = '',
      platform = '',
    } = request.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    // WHERE: ended 상태만
    const conditions: ReturnType<typeof eq>[] = [
      eq(platformListings.status, 'ended'),
    ];

    if (q.trim()) {
      conditions.push(
        sql`(${products.titleKo} ILIKE ${'%' + q.trim() + '%'} OR ${products.title} ILIKE ${'%' + q.trim() + '%'} OR ${products.sku} ILIKE ${'%' + q.trim() + '%'})` as any
      );
    }

    if (platform) {
      conditions.push(eq(platformListings.platform, platform));
    }

    const sortColumns: Record<string, any> = {
      sku: products.sku,
      title: products.titleKo,
      createdAt: products.createdAt,
      sourcePlatform: products.sourcePlatform,
    };
    const sortCol = sortColumns[sort] || products.createdAt;
    const orderFn = order === 'asc' ? asc : desc;

    const whereClause = and(...conditions);

    const [items, countResult] = await Promise.all([
      db.select({
        id: products.id,
        sku: products.sku,
        titleKo: products.titleKo,
        title: products.title,
        status: products.status,
        sourceUrl: products.sourceUrl,
        sourcePlatform: products.sourcePlatform,
        createdAt: products.createdAt,
        imageUrl: sql<string>`COALESCE(
          NULLIF((SELECT url FROM product_images WHERE product_id = ${products.id} AND url IS NOT NULL AND url != '' ORDER BY position LIMIT 1), ''),
          (SELECT image_url FROM crawl_results WHERE product_id = ${products.id} AND image_url IS NOT NULL AND image_url != '' LIMIT 1)
        )`,
        listingId: platformListings.id,
        listingPlatform: platformListings.platform,
        listingPrice: platformListings.price,
        listingUrl: platformListings.listingUrl,
      })
        .from(products)
        .innerJoin(platformListings, eq(products.id, platformListings.productId))
        .where(whereClause)
        .orderBy(orderFn(sortCol))
        .limit(limitNum)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` })
        .from(products)
        .innerJoin(platformListings, eq(products.id, platformListings.productId))
        .where(whereClause),
    ]);

    const total = Number(countResult[0].count);

    return {
      data: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  });

  // 휴지통
  app.get('/trash', async (request, reply) => {
    const allSettings = await getAllPricingSettings();
    const calcPricesTrash = (costKRW: number) => ({
      ebayPrice: calculatePriceSync(costKRW, allSettings['ebay']).salePrice,
      shopifyPrice: calculatePriceSync(costKRW, allSettings['shopify']).salePrice,
      alibabaPrice: calculatePriceSync(costKRW, allSettings['alibaba']).salePrice,
      shopeePrice: calculatePriceSync(costKRW, allSettings['shopee']).salePrice,
    });

    const sourceLabelsTrash: Record<string, string> = { coupang: '쿠팡', lotte: '롯데온', emart: '이마트', naver: '네이버' };

    const [trashedProducts, trashedCrawls] = await Promise.all([
      db.select({
        id: products.id,
        sku: products.sku,
        titleKo: products.titleKo,
        title: products.title,
        costPrice: products.costPrice,
        sourceUrl: products.sourceUrl,
        sourcePlatform: products.sourcePlatform,
        createdAt: products.createdAt,
        imageUrl: sql<string>`COALESCE(
          NULLIF((SELECT url FROM product_images WHERE product_id = ${products.id} AND url IS NOT NULL AND url != '' ORDER BY position LIMIT 1), ''),
          (SELECT image_url FROM crawl_results WHERE product_id = ${products.id} AND image_url IS NOT NULL AND image_url != '' LIMIT 1)
        )`,
      })
        .from(products)
        .where(eq(products.status, 'trashed'))
        .orderBy(desc(products.createdAt))
        .limit(200),
      db.select({
        id: crawlResults.id,
        title: crawlResults.title,
        price: crawlResults.price,
        url: crawlResults.url,
        imageUrl: crawlResults.imageUrl,
        crawledAt: crawlResults.crawledAt,
        sourceName: crawlSources.name,
      })
        .from(crawlResults)
        .leftJoin(crawlSources, eq(crawlResults.sourceId, crawlSources.id))
        .where(eq(crawlResults.status, 'trashed'))
        .orderBy(desc(crawlResults.crawledAt))
        .limit(200),
    ]);

    const trashItems = [
      ...trashedProducts.map(p => {
        const costKRW = parseFloat(String(p.costPrice)) || 0;
        const prices = costKRW > 0 ? calcPricesTrash(costKRW) : { ebayPrice: 0, shopifyPrice: 0, alibabaPrice: 0, shopeePrice: 0 };
        return {
          type: 'product' as const,
          id: p.id,
          sku: p.sku,
          title: p.titleKo || p.title,
          imageUrl: p.imageUrl,
          sourceUrl: p.sourceUrl,
          sourceLabel: sourceLabelsTrash[p.sourcePlatform || ''] || p.sourcePlatform || '—',
          createdAt: p.createdAt,
          ...prices,
        };
      }),
      ...trashedCrawls.map(c => {
        const costKRW = parseFloat(String(c.price)) || 0;
        const prices = calcPricesTrash(costKRW);
        return {
          type: 'crawl' as const,
          id: c.id,
          sku: null as string | null,
          title: c.title,
          imageUrl: c.imageUrl,
          sourceUrl: c.url,
          sourceLabel: c.sourceName || '—',
          createdAt: c.crawledAt,
          ...prices,
        };
      }),
    ];

    return reply.viewAsync('trash.eta', {
      step: 8,
      trashItems,
    });
  });

  // 히스토리
  app.get('/history', async (request, reply) => {
    const { page = '1' } = request.query as { page?: string };
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const [listings, countResult, uploads] = await Promise.all([
      db.select({
        id: platformListings.id,
        platform: platformListings.platform,
        title: platformListings.title,
        status: platformListings.status,
        price: platformListings.price,
        currency: platformListings.currency,
        platformItemId: platformListings.platformItemId,
        listingUrl: platformListings.listingUrl,
        createdAt: platformListings.createdAt,
        productSku: products.sku,
        productTitleKo: products.titleKo,
      })
        .from(platformListings)
        .leftJoin(products, eq(platformListings.productId, products.id))
        .orderBy(desc(platformListings.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(platformListings),
      db.select().from(csvUploads).orderBy(desc(csvUploads.createdAt)).limit(50),
    ]);

    const total = Number(countResult[0].count);

    const jobEntries = await jobStore.entries();
    const jobs = jobEntries
      .map(([id, job]) => ({ id, ...job }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return reply.viewAsync('history.eta', {
      step: 6,
      listings,
      jobs,
      uploads,
      pagination: {
        page: parseInt(page),
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });
}
