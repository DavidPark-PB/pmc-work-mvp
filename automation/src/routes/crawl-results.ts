/**
 * 크롤 결과 관리 라우트
 */
import type { FastifyInstance } from 'fastify';
import path from 'path';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, crawlSources, csvUploads } from '../db/schema.js';
import { parseCsvFile, extractProductId } from '../lib/csv-parser.js';
import { getUser } from '../lib/user-session.js';

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

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

    const filePath = path.join(UPLOAD_DIR, `${uploadId}.csv`);
    const rows = parseCsvFile(filePath);

    const baseUrl = sourceName === '쿠팡' ? 'https://www.coupang.com' : 'https://unknown.com';
    const sourceId = await ensureSourceId(sourceName, baseUrl);

    let imported = 0;
    let updated = 0;
    let errors = 0;
    const crawlResultIds: number[] = [];

    for (const row of rows) {
      const externalId = extractProductId(row.url);
      const rawData = {
        rating: row.rating,
        reviewCount: row.reviewCount,
        discountRate: row.discountRate,
        originalPrice: row.originalPrice,
        images: [row.image],
      };

      try {
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
              imageUrl: row.image,
              rawData,
              crawledAt: new Date(),
            })
            .where(eq(crawlResults.id, existing.id));
          updated++;
          crawlResultIds.push(existing.id);
        } else {
          const [inserted] = await db.insert(crawlResults).values({
            sourceId,
            externalId,
            title: row.name,
            price: String(row.price),
            currency: 'KRW',
            url: row.url,
            imageUrl: row.image,
            rawData,
            status: 'new',
          }).returning();
          imported++;
          crawlResultIds.push(inserted.id);
        }
      } catch (e) {
        errors++;
      }
    }

    // 업로드 이력 업데이트
    await db.update(csvUploads)
      .set({ importedCount: imported + updated, status: 'imported' })
      .where(eq(csvUploads.uploadId, uploadId));

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
}
