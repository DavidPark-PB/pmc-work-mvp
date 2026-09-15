/**
 * 웹 페이지 라우트 (서버 렌더링)
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { auditLogs, crawlResults, crawlSources, csvUploads, platformListings, productImages, products, users } from '../db/schema.js';
import { eq, ne, inArray, sql, desc, asc, ilike, and, isNull, isNotNull, gte, lte } from 'drizzle-orm';
import { calculatePriceSync, getAllPricingSettings } from '../services/pricing.js';
import { buildImportPreview, detectFixedHeaderMapping } from '../lib/csv-parser.js';
import { crawlDisplayCsv, readProductCsvMetadata, resolveDisplayPrices } from '../services/listing-price.js';
import { getShippingPricingConfig, publicShippingPricingConfig } from '../lib/shipping-config.js';
import { readShippingPolicySnapshot } from '../services/ebay-shipping-policies.js';
import { jobStore } from '../lib/job-store.js';
import { getUser } from '../lib/user-session.js';
import fs from 'fs';
import path from 'path';

export async function pageRoutes(app: FastifyInstance) {
  // 대시보드 홈
  app.get('/', async (request, reply) => {
    const [
      productsByStatus,
      listingsByPlatform,
      listingsByStatus,
      crawlByStatus,
      recentProductsWithListings,
      recentCrawlResults,
      activeJobRows,
      allSettings,
    ] = await Promise.all([
      db.select({ status: products.status, count: sql<number>`count(*)` })
        .from(products).groupBy(products.status),
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
        metadata: products.metadata,
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
        .groupBy(products.id, products.sku, products.titleKo, products.title, products.status, products.costPrice, products.metadata, products.sourceUrl, products.sourcePlatform, products.createdAt)
        .orderBy(desc(products.createdAt))
        .limit(200),
      // 크롤 대기 데이터 (아직 상품으로 안 만든 것)
      db.select({
        id: crawlResults.id,
        title: crawlResults.title,
        titleEn: crawlResults.titleEn,
        price: crawlResults.price,
        currency: crawlResults.currency,
        url: crawlResults.url,
        imageUrl: crawlResults.imageUrl,
        rawData: crawlResults.rawData,
        status: crawlResults.status,
        crawledAt: crawlResults.crawledAt,
        sourceName: crawlSources.name,
        ownerId: crawlResults.ownerId,
        ownerName: crawlResults.ownerName,
      })
        .from(crawlResults)
        .leftJoin(crawlSources, eq(crawlResults.sourceId, crawlSources.id))
        //   이미 상품으로 가져온 행은 업로드 대기가 아니다 (재가져오기로 status가 'new'로 남은 행 제외)
        .where(and(eq(crawlResults.status, 'new'), isNull(crawlResults.productId)))
        .orderBy(desc(crawlResults.crawledAt))
        .limit(200),
      // running job만 조회 (전체 로드 방지)
      jobStore.getRunning(),
      // 가격 설정 1회 조회 (N+1 방지)
      getAllPricingSettings(),
    ]);

    //   고유 상품 기준 집계: 판매중(active 1개 이상) / 판매 취소(전부 ended) / 업로드 대기(플랫폼 등록 없음 + 미가져온 crawl 행)
    const [pipelineRows] = await db.execute(sql`
      WITH product_state AS (
        SELECT p.id,
               COUNT(pl.id) FILTER (WHERE pl.status = 'active') AS active_count,
               COUNT(pl.id) FILTER (WHERE pl.status = 'ended') AS ended_count,
               COUNT(pl.id) AS listing_count
        FROM products p
        LEFT JOIN platform_listings pl ON pl.product_id = p.id
        WHERE p.status <> 'trashed'
        GROUP BY p.id
      )
      SELECT
        (SELECT COUNT(*) FROM product_state) AS products,
        (SELECT COUNT(*) FROM product_state WHERE active_count > 0) AS listed,
        (SELECT COUNT(*) FROM product_state WHERE active_count = 0 AND ended_count > 0) AS ended,
        (SELECT COUNT(*) FROM product_state WHERE listing_count = 0) AS unlisted,
        (SELECT COUNT(*) FROM crawl_results WHERE status = 'new' AND product_id IS NULL) AS pending_crawl
    `).then(r => r.rows as any[]);
    const pipelineCounts = {
      total: Number(pipelineRows?.products ?? 0) + Number(pipelineRows?.pending_crawl ?? 0),
      listed: Number(pipelineRows?.listed ?? 0),
      ended: Number(pipelineRows?.ended ?? 0),
      waiting: Number(pipelineRows?.unlisted ?? 0) + Number(pipelineRows?.pending_crawl ?? 0),
    };

    // running job → activeJobs 변환
    const activeJobs = activeJobRows.map(r => ({ id: r.id, ...r.job }));

    // 헬퍼: status 맵 만들기
    const toMap = (rows: { status: string | null; count: number }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.status || 'unknown'] = Number(r.count);
      return m;
    };
    const sumMap = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    const platformMap = (rows: { platform: string; count: number }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.platform] = Number(r.count);
      return m;
    };

    // 배송비 반영 등록가 설정 (서버 전용 — 뷰에 토큰/URL 전달 금지)
    const shippingConfig = getShippingPricingConfig();

    // 두 소스를 allItems로 통합
    const sourceLabels: Record<string, string> = { coupang: '쿠팡', lotte: '롯데온', emart: '이마트', naver: '네이버' };

    const productItemsWithPrice = recentProductsWithListings.map((p) => {
      // USD CSV 상품: eBay = 환산가(USD), 원가 칸 = 매입원가 KRW / 그 외: 기존 계산
      const { costKrw: costKRW, priceSource, ...prices } = resolveDisplayPrices({
        costKrw: parseFloat(String(p.costPrice)) || 0,
        csv: readProductCsvMetadata(p.metadata),
        overrides: (p.metadata as any)?.priceOverrides,
        allSettings,
        shipping: shippingConfig,
      });
      return {
        type: 'product' as const,
        id: p.id,
        sku: p.sku,
        title: p.titleKo || p.title,
        titleEn: p.title,
        titleKo: p.titleKo,
        imageUrl: p.imageUrl,
        sourceUrl: p.sourceUrl,
        sourceLabel: sourceLabels[p.sourcePlatform || ''] || p.sourcePlatform || '—',
        listings: p.listings,
        status: p.status,
        costKrw: costKRW,
        priceSource,
        createdAt: p.createdAt,
        ...prices,
      };
    });

    const crawlItemsWithPrice = recentCrawlResults.map((c) => {
      // USD CSV 원본: crawl price는 판매가(USD)이므로 원가(KRW)로 계산하지 않음
      const { costKrw: costKRW, priceSource, ...prices } = resolveDisplayPrices({
        costKrw: parseFloat(String(c.price)) || 0,
        csv: crawlDisplayCsv(c),
        overrides: (c.rawData as any)?.priceOverrides,
        allSettings,
        shipping: shippingConfig,
      });
      return {
        type: 'crawl' as const,
        id: c.id,
        sku: null as string | null,
        title: c.title,
        titleEn: c.titleEn || null,
        titleKo: c.title,
        imageUrl: c.imageUrl,
        sourceUrl: c.url,
        sourceLabel: c.sourceName || '—',
        costKrw: costKRW,
        priceSource,
        listings: '[]',
        status: c.status,
        createdAt: c.crawledAt,
        ownerId: c.ownerId,
        ownerName: c.ownerName,
        ...prices,
      };
    });

    // 전체 탭 = products + crawl_results (업로드 대기 포함)
    const allItems = [...productItemsWithPrice, ...crawlItemsWithPrice]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Release guard: USD CSV(toybox) 상품은 배송비 반영 기능이 꺼져 있으면 eBay 등록 차단 (서버 guard와 같은 평가)
    const releaseGuard = {
      shippingPricingEnabled: shippingConfig.enabled,
      pricingDisabledCount: allItems.filter(i => i.ebayBlockCode === 'SHIPPING_PRICING_DISABLED').length,
    };

    const user = getUser(request);

    const productStatusMap = toMap(productsByStatus);
    const listingStatusMap = toMap(listingsByStatus);

    return reply.viewAsync('dashboard.eta', {
      step: 0,
      user,
      stats: {
        totalProducts: sumMap(productStatusMap),
        productsByStatus: productStatusMap,
        totalListings: sumMap(listingStatusMap),
        listingsByPlatform: platformMap(listingsByPlatform),
        listingsByStatus: listingStatusMap,
        crawlByStatus: toMap(crawlByStatus),
        completedCount: (listingStatusMap['active'] || 0) + (listingStatusMap['ended'] || 0),
        endedCount: listingStatusMap['ended'] || 0,
        //   고유 상품 기준 파이프라인 수 (listing 행 수·과거 job과 섞지 않음)
        pipeline: pipelineCounts,
      },
      allItems,
      // 하위 호환: 업로드 대기 탭에서 crawlItems 직접 사용
      recentCrawlResults: crawlItemsWithPrice,
      activeJobs,
      releaseGuard,
    }, { layout: 'layout.eta' });
  });


  // /select → / 리다이렉트 (삭제된 페이지)
  app.get('/select', async (_request, reply) => {
    return reply.redirect('/');
  });

  // Step 1: CSV 업로드
  app.get('/upload-csv', async (request, reply) => {
    return reply.viewAsync('step1-upload.eta', { step: 1 }, { layout: 'layout.eta' });
  });

  // Step 1.5: 컬럼 매핑 확인
  app.get('/mapping', async (request, reply) => {
    const { uploadId } = request.query as { uploadId?: string };
    if (!uploadId) return reply.redirect('/upload-csv');

    const upload = await db.query.csvUploads.findFirst({
      where: eq(csvUploads.uploadId, uploadId),
    });

    if (!upload?.rawFields || upload.rawFields.length < 2) {
      // 이미 매핑 확정됨 → 미리보기로
      if (upload?.parsedRows) return reply.redirect(`/import?uploadId=${uploadId}`);
      return reply.redirect('/upload-csv');
    }

    const headerRow = upload.rawFields[0];
    const sampleRows = upload.rawFields.slice(1, 4);
    const autoMapping = upload.columnMapping || {};

    return reply.viewAsync('step1b-mapping.eta', {
      step: 1,
      uploadId,
      headerRow,
      sampleRows,
      autoMapping,
      fixedHeaderMapping: !!detectFixedHeaderMapping(headerRow),
      totalRows: upload.rawFields.length - 1,
      filename: upload.filename,
    }, { layout: 'layout.eta' });
  });

  // Step 2: DB 등록 미리보기
  app.get('/import', async (request, reply) => {
    const { uploadId } = request.query as { uploadId?: string };

    if (!uploadId) {
      return reply.redirect('/upload-csv');
    }

    const upload = await db.query.csvUploads.findFirst({
      where: eq(csvUploads.uploadId, uploadId),
    });

    // 매핑 미확정 → 매핑 페이지로
    if (upload?.rawFields && !upload?.parsedRows) {
      return reply.redirect(`/mapping?uploadId=${uploadId}`);
    }

    if (!upload?.parsedRows || upload.parsedRows.length === 0) {
      return reply.redirect('/upload-csv');
    }

    const preview = buildImportPreview(upload.parsedRows);
    return reply.viewAsync('step2-import.eta', {
      step: 2,
      uploadId,
      rows: preview.rows,
      rowCount: preview.rows.length,
      priceHeader: preview.priceHeader,
      defaultSelectedCount: preview.defaultSelectedCount,
      errorRowCount: preview.errorRowCount,
      showShipping: preview.showShipping,
      shipping: publicShippingPricingConfig(getShippingPricingConfig()),
      //   upload 단위 선택 배송정책 (USD 행 전체에 같은 snapshot 저장)
      shippingPolicy: readShippingPolicySnapshot(upload.parsedRows.find(r => r.priceCurrency === 'USD')?.shippingPolicy),
      //   이미 DB로 가져온 행이 있으면 정책 선택/변경 시 확인창 표시
      hasImportedRows: (upload.importedCount ?? 0) > 0 || upload.parsedRows.some(r => typeof r.importedCrawlResultId === 'number'),
    }, { layout: 'layout.eta' });
  });

  // Step 4: 업로드 진행
  app.get('/upload', async (request, reply) => {
    const { jobId } = request.query as { jobId?: string };
    if (!jobId) return reply.redirect('/');

    return reply.viewAsync('step4-progress.eta', {
      step: 4,
      jobId,
    }, { layout: 'layout.eta' });
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
    }, { layout: 'layout.eta' });
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
    const trashShippingConfig = getShippingPricingConfig();
    const usdDisplayPrices = (csv: Record<string, any>) => {
      const { ebayPrice, shopifyPrice, alibabaPrice, shopeePrice } = resolveDisplayPrices({ costKrw: 0, csv, allSettings, shipping: trashShippingConfig });
      return { ebayPrice, shopifyPrice, alibabaPrice, shopeePrice };
    };

    const sourceLabelsTrash: Record<string, string> = { coupang: '쿠팡', lotte: '롯데온', emart: '이마트', naver: '네이버' };

    const [trashedProducts, trashedCrawls] = await Promise.all([
      db.select({
        id: products.id,
        sku: products.sku,
        titleKo: products.titleKo,
        title: products.title,
        costPrice: products.costPrice,
        metadata: products.metadata,
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
        currency: crawlResults.currency,
        rawData: crawlResults.rawData,
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
        const productCsv = readProductCsvMetadata(p.metadata);
        const prices = productCsv
          ? usdDisplayPrices(productCsv)
          : costKRW > 0 ? calcPricesTrash(costKRW) : { ebayPrice: 0, shopifyPrice: 0, alibabaPrice: 0, shopeePrice: 0 };
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
        const trashCrawlCsv = crawlDisplayCsv(c);
        const prices = trashCrawlCsv ? usdDisplayPrices(trashCrawlCsv) : calcPricesTrash(costKRW);
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
    }, { layout: 'layout.eta' });
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
      db.select().from(csvUploads).orderBy(desc(csvUploads.createdAt)).limit(200),
    ]);

    const total = Number(countResult[0].count);

    const jobEntries = await jobStore.recent(50);
    const jobs = jobEntries
      .map(r => ({ id: r.id, ...r.job }));

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
    }, { layout: 'layout.eta' });
  });

  // 작업 로그 (Admin 전용)
  app.get('/audit', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.redirect('/');
    }

    const { page = '1', userId, category, success, from, to } = request.query as Record<string, string>;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    const conditions = [];
    if (userId) conditions.push(eq(auditLogs.userId, parseInt(userId)));
    if (category) conditions.push(eq(auditLogs.category, category));
    if (success === 'true') conditions.push(eq(auditLogs.success, true));
    if (success === 'false') conditions.push(eq(auditLogs.success, false));
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to + 'T23:59:59')));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [logs, countResult, allUsers] = await Promise.all([
      db.select().from(auditLogs).where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(auditLogs).where(where),
      db.select({ id: users.id, displayName: users.displayName }).from(users).orderBy(asc(users.displayName)),
    ]);

    const total = Number(countResult[0].count);

    return reply.viewAsync('audit.eta', {
      step: 12,
      logs,
      users: allUsers,
      filters: { userId: userId || '', category: category || '', success: success || '', from: from || '', to: to || '' },
      pagination: {
        page: parseInt(page),
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }, { layout: 'layout.eta' });
  });

  // 사용설명서
  app.get('/manual', async (request, reply) => {
    const user = getUser(request);
    const isAdmin = user?.isAdmin ?? false;
    const { type } = request.query as { type?: string };

    // Admin이 admin 매뉴얼을 요청하거나, 기본 Staff 매뉴얼
    const showAdmin = isAdmin && type === 'admin';
    const filename = showAdmin ? 'manual-admin.html' : 'manual-staff.html';
    const filePath = path.join(process.cwd(), filename);

    if (!fs.existsSync(filePath)) {
      return reply.status(404).send('매뉴얼 파일을 찾을 수 없습니다.');
    }

    let html = fs.readFileSync(filePath, 'utf-8');

    // 매뉴얼 전환 탭 삽입 (Admin에게만)
    if (isAdmin) {
      const tabHtml = `
<div style="position:sticky;top:0;z-index:100;background:#4f46e5;padding:10px 32px;display:flex;gap:12px;align-items:center;margin:-40px -32px 24px;box-shadow:0 2px 8px rgba(0,0,0,0.15);">
  <a href="/manual" style="color:${!showAdmin ? '#fff' : 'rgba(255,255,255,0.6)'};text-decoration:none;font-weight:${!showAdmin ? '700' : '400'};font-size:14px;padding:6px 16px;border-radius:6px;${!showAdmin ? 'background:rgba(255,255,255,0.15);' : ''}">직원용 매뉴얼</a>
  <a href="/manual?type=admin" style="color:${showAdmin ? '#fff' : 'rgba(255,255,255,0.6)'};text-decoration:none;font-weight:${showAdmin ? '700' : '400'};font-size:14px;padding:6px 16px;border-radius:6px;${showAdmin ? 'background:rgba(255,255,255,0.15);' : ''}">관리자용 매뉴얼</a>
  <a href="/" style="margin-left:auto;color:rgba(255,255,255,0.7);text-decoration:none;font-size:13px;">← 돌아가기</a>
</div>`;
      html = html.replace('<body>', `<body>${tabHtml}`);
    } else {
      // Staff용: 돌아가기 버튼만
      const backHtml = `
<div style="position:sticky;top:0;z-index:100;background:#4f46e5;padding:10px 32px;display:flex;align-items:center;margin:-40px -32px 24px;box-shadow:0 2px 8px rgba(0,0,0,0.15);">
  <span style="color:#fff;font-weight:700;font-size:14px;">직원용 사용설명서</span>
  <a href="/" style="margin-left:auto;color:rgba(255,255,255,0.7);text-decoration:none;font-size:13px;">← 돌아가기</a>
</div>`;
      html = html.replace('<body>', `<body>${backHtml}`);
    }

    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(html);
  });
}
