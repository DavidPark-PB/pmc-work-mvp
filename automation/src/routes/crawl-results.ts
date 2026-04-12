/**
 * 크롤 결과 관리 라우트
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, crawlSources, csvUploads } from '../db/schema.js';
import { calculatePriceSync, getAllPricingSettings } from '../services/pricing.js';
import { extractProductId } from '../lib/csv-parser.js';
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

    const { uploadId, sourceName = '쿠팡' } = request.body as {
      uploadId: string;
      sourceName?: string;
    };

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

    const baseUrl = sourceName === '쿠팡' ? 'https://www.coupang.com' : 'https://unknown.com';
    const sourceId = await ensureSourceId(sourceName, baseUrl);

    let imported = 0;
    let updated = 0;
    let errors = 0;
    const crawlResultIds: number[] = [];

    // 배치 처리: 10개씩 병렬 처리하여 대용량 CSV 속도 개선
    const BATCH_SIZE = 10;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (row) => {
        const externalId = extractProductId(row.url);
        const rawData: Record<string, any> = {
          rating: row.rating,
          reviewCount: row.reviewCount,
          discountRate: row.discountRate,
          originalPrice: row.originalPrice,
          images: row.image ? row.image.split('|||').filter((u: string) => u.trim()) : [],
        };
        if (row.category) rawData.category = row.category;
        if (row.brand) rawData.brand = row.brand;

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
              url: row.url,
              imageUrl: row.image ? row.image.split('|||')[0] : '',
              rawData,
              status: 'new',
              crawledAt: new Date(),
            })
            .where(eq(crawlResults.id, existing.id));
          return { type: 'updated' as const, id: existing.id };
        } else {
          const [inserted] = await db.insert(crawlResults).values({
            sourceId,
            externalId,
            title: row.name,
            price: String(row.price),
            currency: 'KRW',
            url: row.url,
            imageUrl: row.image ? row.image.split('|||')[0] : '',
            rawData,
            status: 'new',
            ownerId: user.id,
            ownerName: user.name,
          }).returning();
          return { type: 'imported' as const, id: inserted.id };
        }
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.type === 'imported') imported++;
          else updated++;
          crawlResultIds.push(result.value.id);
        } else {
          errors++;
        }
      }
    }

    // 업로드 이력 업데이트
    try {
      await db.update(csvUploads)
        .set({ importedCount: imported + updated, status: 'imported' })
        .where(eq(csvUploads.uploadId, uploadId));
    } catch {
      // 이력 업데이트 실패해도 결과는 반환
    }

    logBatchAction(user, 'import.batch', { targetType: 'crawl_result', count: imported + updated, details: { uploadId, importedCount: imported, totalCount: rows.length } });
    return { imported, updated, errors, crawlResultIds };
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

    const updateData: Record<string, any> = {};
    if (title !== undefined) updateData.title = title;
    if (titleEn !== undefined) updateData.titleEn = titleEn;
    if (price !== undefined) updateData.price = price;

    // 플랫폼 가격 override → rawData.priceOverrides에 저장
    if (isPriceOverride) {
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

    // 가격 재계산 (override 우선)
    const costKRW = parseFloat(String(updated.price)) || 0;
    const allSettings = await getAllPricingSettings();
    const calculated = costKRW > 0 ? {
      ebayPrice: calculatePriceSync(costKRW, allSettings['ebay']).salePrice,
      shopifyPrice: calculatePriceSync(costKRW, allSettings['shopify']).salePrice,
      alibabaPrice: calculatePriceSync(costKRW, allSettings['alibaba']).salePrice,
      shopeePrice: calculatePriceSync(costKRW, allSettings['shopee']).salePrice,
    } : { ebayPrice: 0, shopifyPrice: 0, alibabaPrice: 0, shopeePrice: 0 };

    const rawOverrides = ((updated.rawData as any)?.priceOverrides) || {};
    const prices = {
      ebayPrice: rawOverrides.ebay || calculated.ebayPrice,
      shopifyPrice: rawOverrides.shopify || calculated.shopifyPrice,
      alibabaPrice: rawOverrides.alibaba || calculated.alibabaPrice,
      shopeePrice: rawOverrides.shopee || calculated.shopeePrice,
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
