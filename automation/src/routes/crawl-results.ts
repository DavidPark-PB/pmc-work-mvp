/**
 * 크롤 결과 관리 라우트
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, crawlSources, csvUploads } from '../db/schema.js';
import { getAllPricingSettings } from '../services/pricing.js';
import { crawlDisplayCsv, resolveDisplayPrices } from '../services/listing-price.js';
import { applySalePriceOverride } from '../services/shipping-pricing.js';
import { getShippingPricingConfig, isShippingProvider } from '../lib/shipping-config.js';
import { resolveChargeableWeight } from '../lib/shipping-quote-status.js';
import { importExternalId, selectRowsForImport, buildImportRawData } from '../lib/csv-parser.js';
import { readShippingPolicySnapshot, SHIPPING_POLICY_IMPORT_REQUIRED_MESSAGE } from '../services/ebay-shipping-policies.js';
import { getUser } from '../lib/user-session.js';
import { translateProduct } from '../services/translate.js';
import { getDescriptionTemplate, buildPlatformDescription } from '../services/description.js';
import { logBatchAction } from '../lib/audit-log.js';

async function ensureSourceId(sourceName: string, baseUrl: string): Promise<number> {
  const crawlerType = sourceName.toLowerCase().replace(/\s+/g, '_');

  const existing = await db.query.crawlSources.findFirst({
    where: eq(crawlSources.crawlerType, crawlerType),
  });

  if (existing) return existing.id;

  const [inserted] = await db.insert(crawlSources).values({
    name: sourceName,
    baseUrl,
    crawlerType,
    config: {},
    isActive: true,
  }).returning();

  return inserted.id;
}

export async function crawlResultRoutes(app: FastifyInstance) {
  // POST /api/import/batch — CSV → crawl_results DB 저장 (Admin 전용)
  app.post('/import/batch', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    }
    if (!user.isAdmin) {
      return reply.status(403).send({ error: 'CSV 등록은 관리자만 이용하실 수 있습니다.' });
    }

    const { uploadId, sourceName = '쿠팡', selectedIndices, shippingProviders } = request.body as {
      uploadId: string;
      sourceName?: string;
      selectedIndices?: number[];  // parsedRows 인덱스 — 미전달 시 전체 (하위 호환)
      shippingProviders?: Record<string, string>;  // parsedRows 인덱스 → 'KPL' | 'eGS'
    };

    if (shippingProviders !== undefined) {
      const invalid = typeof shippingProviders !== 'object' || shippingProviders === null
        || Object.values(shippingProviders).some(v => !isShippingProvider(v));
      if (invalid) {
        return reply.status(400).send({ error: '배송사는 KPL 또는 eGS만 선택할 수 있습니다.' });
      }
    }

    // DB에서 파싱된 데이터 조회 (파일 시스템 의존 제거)
    const upload = await db.query.csvUploads.findFirst({
      where: eq(csvUploads.uploadId, uploadId),
    });

    if (!upload) {
      return reply.status(404).send({ error: '업로드 데이터를 찾을 수 없습니다.' });
    }

    const rows = upload.parsedRows;
    if (!rows || rows.length === 0) {
      return reply.status(400).send({ error: 'CSV에 유효한 행이 없습니다.' });
    }

    // 선택된 상품만 등록
    let selected: { index: number; row: (typeof rows)[number] }[];
    try {
      selected = selectRowsForImport(rows, selectedIndices);
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }

    //   신규 USD CSV(toybox)는 upload에서 eBay 배송정책을 선택해야 가져올 수 있다 (레거시 KRW CSV는 제한 없음)
    if (selected.some(({ row }) => row.priceCurrency === 'USD' && !readShippingPolicySnapshot(row.shippingPolicy))) {
      return reply.status(400).send({ error: SHIPPING_POLICY_IMPORT_REQUIRED_MESSAGE, code: 'SHIPPING_POLICY_NOT_SELECTED' });
    }

    const baseUrl = sourceName === '쿠팡' ? 'https://www.coupang.com' : 'https://unknown.com';
    const sourceId = await ensureSourceId(sourceName, baseUrl);

    let imported = 0;
    let updated = 0;
    let errors = 0;
    const crawlResultIds: number[] = [];
    const importedByIndex = new Map<number, number>();

    // 배치 처리: 10개씩 병렬 처리하여 대용량 CSV 속도 개선
    const BATCH_SIZE = 10;
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async ({ row: parsedRow, index }) => {
        // USD CSV: 선택 배송사 보존 (기본 KPL), 견적은 같은 배송사·적용무게일 때만 유지
        let row = parsedRow;
        if (parsedRow.priceCurrency === 'USD') {
          const requested = shippingProviders?.[String(index)];
          const provider = isShippingProvider(requested) ? requested : (parsedRow.selectedShippingProvider ?? 'KPL');
          const quote = parsedRow.shippingQuote;
          //   적용무게가 복구된 행은 복구 무게로 견적되므로 같은 규칙으로 일치 판정
          const quoteMatches = !!quote && quote.provider === provider && quote.chargeableWeightG === resolveChargeableWeight(parsedRow).weightG;
          row = { ...parsedRow, selectedShippingProvider: provider, shippingQuote: quoteMatches ? quote : null };
        }
        const externalId = importExternalId(row);
        // 기존 키 + CSV 원본 전체 컬럼/정규화 값 보존 (rawData.csvImport)
        const rawData = buildImportRawData(row, { uploadId, rowIndex: index });
        // 판매가(USD) 매핑 시 price는 USD 값 그대로, currency로 통화 구분
        const currency = row.priceCurrency === 'USD' ? 'USD' : 'KRW';

        const existing = await db.query.crawlResults.findFirst({
          where: and(
            eq(crawlResults.sourceId, sourceId),
            eq(crawlResults.externalId, externalId),
          ),
        });

        if (existing) {
          await db.update(crawlResults)
            .set({
              title: row.name,
              price: String(row.price),
              currency,
              url: row.url,
              imageUrl: row.image ? row.image.split('|||')[0] : '',
              rawData,
              status: 'new',
              crawledAt: new Date(),
            })
            .where(eq(crawlResults.id, existing.id));
          return { type: 'updated' as const, id: existing.id, index };
        } else {
          const [inserted] = await db.insert(crawlResults).values({
            sourceId,
            externalId,
            title: row.name,
            price: String(row.price),
            currency,
            url: row.url,
            imageUrl: row.image ? row.image.split('|||')[0] : '',
            rawData,
            status: 'new',
            ownerId: user.id,
            ownerName: user.name,
          }).returning();
          return { type: 'imported' as const, id: inserted.id, index };
        }
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.type === 'imported') imported++;
          else updated++;
          crawlResultIds.push(result.value.id);
          importedByIndex.set(result.value.index, result.value.id);
        } else {
          errors++;
        }
      }
    }

    // 업로드 이력 업데이트 + 행별 crawl_results.id 기록 (정책 변경 시 이미 가져온 상품을 찾는 기준)
    try {
      const latest = await db.query.csvUploads.findFirst({ where: eq(csvUploads.uploadId, uploadId) });
      const latestRows = latest?.parsedRows ?? rows;
      const parsedRows = latestRows.map((r, index) => (importedByIndex.has(index) ? { ...r, importedCrawlResultId: importedByIndex.get(index)! } : r));
      await db.update(csvUploads)
        .set({ importedCount: imported + updated, status: 'imported', parsedRows })
        .where(eq(csvUploads.uploadId, uploadId));
    } catch {
      // 이력 업데이트 실패해도 결과는 반환
    }

    logBatchAction(user, 'import.batch', { targetType: 'crawl_result', count: imported + updated, details: { uploadId, importedCount: imported, selectedCount: selected.length, totalCount: rows.length } });
    return { imported, updated, errors, crawlResultIds, selected: selected.length, total: rows.length };
  });

  // GET /api/crawl-results — 크롤 결과 목록
  app.get('/crawl-results', async (request) => {
    const { page = '1', limit = '50', status } = request.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    if (status) {
      conditions.push(eq(crawlResults.status, status));
    }

    const where = conditions.length > 0
      ? sql`${sql.join(conditions, sql` AND `)}`
      : undefined;

    const [items, countResult] = await Promise.all([
      db.select().from(crawlResults).where(where).limit(parseInt(limit)).offset(offset).orderBy(desc(crawlResults.id)),
      db.select({ count: sql<number>`count(*)` }).from(crawlResults).where(where),
    ]);

    return {
      data: items,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: Number(countResult[0].count),
      },
    };
  });

  // PATCH /api/crawl-results/:id — 인라인 수정 (title, titleEn, price, 플랫폼 가격 override)
  app.patch('/crawl-results/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;
    const { title, titleEn, price, ebayPrice, shopifyPrice, alibabaPrice, shopeePrice } = body;

    const isPriceOverride = ebayPrice !== undefined || shopifyPrice !== undefined || alibabaPrice !== undefined || shopeePrice !== undefined;

    if (!title && !titleEn && price === undefined && !isPriceOverride) {
      return reply.status(400).send({ error: '수정할 필드가 없습니다.' });
    }

    // 기존 데이터 조회 (rawData 병합 필요)
    const existing = await db.query.crawlResults.findFirst({
      where: eq(crawlResults.id, parseInt(id)),
    });
    if (!existing) {
      return reply.status(404).send({ error: 'Crawl result not found' });
    }

    const usdCsv = !!crawlDisplayCsv(existing);
    // USD CSV 원본: 원본 판매가(price)와 eBay 외 플랫폼 가격은 수정 불가 — eBay 가격은 수동 판매가로만 저장
    if (usdCsv && (price !== undefined || shopifyPrice !== undefined || alibabaPrice !== undefined || shopeePrice !== undefined)) {
      return reply.status(400).send({ error: '판매가(USD) CSV 상품은 eBay 수동 판매가만 수정할 수 있습니다. 원본 CSV 판매가는 변경되지 않습니다.' });
    }

    const updateData: Record<string, any> = {};
    if (title !== undefined) updateData.title = title;
    if (titleEn !== undefined) updateData.titleEn = titleEn;
    if (price !== undefined) updateData.price = price;

    if (usdCsv && ebayPrice !== undefined) {
      // 원본 salePriceUsd는 유지, salePriceOverrideUsd + 수정 이력만 저장
      const rawData = { ...((existing.rawData as Record<string, any>) || {}) };
      const csvImport = { ...(rawData.csvImport || {}) };
      try {
        csvImport.fields = applySalePriceOverride(csvImport.fields || {}, ebayPrice, { changedBy: getUser(request)?.name ?? null });
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
      rawData.csvImport = csvImport;
      updateData.rawData = rawData;
    } else if (isPriceOverride) {
      // 플랫폼 가격 override → rawData.priceOverrides에 저장
      const rawData = (existing.rawData as Record<string, any>) || {};
      const overrides = rawData.priceOverrides || {};
      if (ebayPrice !== undefined) overrides.ebay = parseFloat(ebayPrice);
      if (shopifyPrice !== undefined) overrides.shopify = parseFloat(shopifyPrice);
      if (alibabaPrice !== undefined) overrides.alibaba = parseFloat(alibabaPrice);
      if (shopeePrice !== undefined) overrides.shopee = parseFloat(shopeePrice);
      rawData.priceOverrides = overrides;
      updateData.rawData = rawData;
    }

    const [updated] = await db.update(crawlResults)
      .set(updateData)
      .where(eq(crawlResults.id, parseInt(id)))
      .returning();

    // 가격 재계산 (override 우선, USD CSV는 환산가 고정)
    const allSettings = await getAllPricingSettings();
    const display = resolveDisplayPrices({
      costKrw: parseFloat(String(updated.price)) || 0,
      csv: crawlDisplayCsv(updated),
      overrides: (updated.rawData as any)?.priceOverrides,
      allSettings,
      shipping: getShippingPricingConfig(),
    });
    const prices = {
      ebayPrice: display.ebayPrice,
      shopifyPrice: display.shopifyPrice,
      alibabaPrice: display.alibabaPrice,
      shopeePrice: display.shopeePrice,
      ebayEditValue: display.ebayEditValue,
      priceNote: display.priceNote,
    };

    return { data: updated, prices };
  });

  // POST /api/crawl-results/:id/generate-description — AI로 description 미리보기 생성
  app.post('/crawl-results/:id/generate-description', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { platform = 'ebay' } = request.query as { platform?: string };

    const cr = await db.query.crawlResults.findFirst({
      where: eq(crawlResults.id, parseInt(id)),
    });
    if (!cr) {
      return reply.status(404).send({ error: 'Crawl result not found' });
    }

    const rawData = (cr.rawData || {}) as Record<string, any>;
    const result = await translateProduct(cr.title, rawData);

    if (result.title === cr.title && !result.description) {
      return reply.status(500).send({ error: 'AI 생성 실패 (API 키 확인 필요)' });
    }

    const productDesc = result.description || `<p>${result.title}</p>`;
    const template = await getDescriptionTemplate(platform);
    const fullDescription = buildPlatformDescription(productDesc, template, platform);

    return { description: result.description, title: result.title, fullDescription, platform };
  });
}
