import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { products, crawlResults } from '../db/schema.js';
import { eq, like, sql, inArray } from 'drizzle-orm';
import { translateProduct } from '../services/translate.js';
import { logAction } from '../lib/audit-log.js';
import { getUser } from '../lib/user-session.js';
import { calculatePriceSync, getAllPricingSettings } from '../services/pricing.js';
import { getDescriptionTemplate, buildPlatformDescription } from '../services/description.js';

// 진행 중인 번역 세션 abort 플래그 맵 (sessionId → abort signal)
const translateAbortMap = new Map<string, { aborted: boolean }>();
// 동시 실행 방지 락
let translateRunning = false;

export async function productRoutes(app: FastifyInstance) {
  // POST /api/products/translate-stop - 진행 중인 번역 중단
  app.post('/products/translate-stop', async (request) => {
    const { sessionId } = request.body as { sessionId?: string };
    if (sessionId && translateAbortMap.has(sessionId)) {
      translateAbortMap.get(sessionId)!.aborted = true;
      return { ok: true };
    }
    return { ok: false, error: 'session not found' };
  });
  // GET /api/products - List products with pagination
  app.get('/products', async (request) => {
    const { page = '1', limit = '50', search, status } = request.query as Record<string, string>;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = [];
    if (search) {
      conditions.push(like(products.title, `%${search}%`));
    }
    if (status) {
      conditions.push(eq(products.status, status));
    }

    const where = conditions.length > 0
      ? sql`${sql.join(conditions, sql` AND `)}`
      : undefined;

    const [items, countResult] = await Promise.all([
      db.select().from(products).where(where).limit(parseInt(limit)).offset(offset).orderBy(products.id),
      db.select({ count: sql<number>`count(*)` }).from(products).where(where),
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

  // GET /api/products/:id - Get single product
  app.get('/products/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await db.select().from(products).where(eq(products.id, parseInt(id)));

    if (result.length === 0) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    return { data: result[0] };
  });

  // POST /api/products - Create product
  app.post('/products', async (request, reply) => {
    const user = getUser(request);
    const body = request.body as {
      sku: string;
      title: string;
      titleKo?: string;
      description?: string;
      costPrice?: string;
      weight?: number;
      brand?: string;
    };

    const [created] = await db.insert(products).values({
      sku: body.sku,
      title: body.title,
      titleKo: body.titleKo,
      description: body.description,
      costPrice: body.costPrice,
      weight: body.weight,
      brand: body.brand,
    }).returning();

    logAction(user, 'product.create', { targetType: 'product', targetId: created.id, details: { sku: created.sku, title: created.title } });
    return reply.status(201).send({ data: created });
  });

  // PUT /api/products/:id - Update product
  app.put('/products/:id', async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as Partial<typeof products.$inferInsert>;

    const [updated] = await db.update(products)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(products.id, parseInt(id)))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    logAction(user, 'product.update', { targetType: 'product', targetId: id });
    return { data: updated };
  });

  // PATCH /api/products/:id — 인라인 수정 (title, titleKo, costPrice, 플랫폼 가격 override)
  app.patch('/products/:id', async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, any>;
    const { title, titleKo, costPrice, ebayPrice, shopifyPrice, alibabaPrice, shopeePrice } = body;

    const isPriceOverride = ebayPrice !== undefined || shopifyPrice !== undefined || alibabaPrice !== undefined || shopeePrice !== undefined;

    if (!title && !titleKo && costPrice === undefined && !isPriceOverride) {
      return reply.status(400).send({ error: '수정할 필드가 없습니다.' });
    }

    // 기존 데이터 조회 (metadata 병합)
    const existing = await db.query.products.findFirst({
      where: eq(products.id, parseInt(id)),
    });
    if (!existing) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title;
    if (titleKo !== undefined) updateData.titleKo = titleKo;
    if (costPrice !== undefined) updateData.costPrice = costPrice;

    // 플랫폼 가격 override → metadata.priceOverrides에 저장
    if (isPriceOverride) {
      const metadata = (existing.metadata as Record<string, any>) || {};
      const overrides = metadata.priceOverrides || {};
      if (ebayPrice !== undefined) overrides.ebay = parseFloat(ebayPrice);
      if (shopifyPrice !== undefined) overrides.shopify = parseFloat(shopifyPrice);
      if (alibabaPrice !== undefined) overrides.alibaba = parseFloat(alibabaPrice);
      if (shopeePrice !== undefined) overrides.shopee = parseFloat(shopeePrice);
      metadata.priceOverrides = overrides;
      updateData.metadata = metadata;
    }

    const [updated] = await db.update(products)
      .set(updateData)
      .where(eq(products.id, parseInt(id)))
      .returning();

    // 가격 재계산 (override 우선)
    const costKRW = parseFloat(String(updated.costPrice)) || 0;
    const allSettings = await getAllPricingSettings();
    const calculated = costKRW > 0 ? {
      ebayPrice: calculatePriceSync(costKRW, allSettings['ebay']).salePrice,
      shopifyPrice: calculatePriceSync(costKRW, allSettings['shopify']).salePrice,
      alibabaPrice: calculatePriceSync(costKRW, allSettings['alibaba']).salePrice,
      shopeePrice: calculatePriceSync(costKRW, allSettings['shopee']).salePrice,
    } : { ebayPrice: 0, shopifyPrice: 0, alibabaPrice: 0, shopeePrice: 0 };

    const metaOverrides = ((updated.metadata as any)?.priceOverrides) || {};
    const prices = {
      ebayPrice: metaOverrides.ebay || calculated.ebayPrice,
      shopifyPrice: metaOverrides.shopify || calculated.shopifyPrice,
      alibabaPrice: metaOverrides.alibaba || calculated.alibabaPrice,
      shopeePrice: metaOverrides.shopee || calculated.shopeePrice,
    };

    logAction(user, 'product.inline-edit', { targetType: 'product', targetId: id, details: { title, titleKo, costPrice, ...body } });
    return { data: updated, prices };
  });

  // GET /api/products/:id/description-preview — description 미리보기
  app.get('/products/:id/description-preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { platform = 'ebay' } = request.query as { platform?: string };

    const product = await db.select().from(products).where(eq(products.id, parseInt(id)));
    if (product.length === 0) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    const p = product[0];
    const productDesc = p.description || `<p>${p.title}</p>`;
    const template = await getDescriptionTemplate(platform);
    const fullDescription = buildPlatformDescription(productDesc, template, platform);

    return { productDescription: productDesc, template, fullDescription, platform };
  });

  // POST /api/products/:id/generate-description — AI로 description 생성 (DB 미저장, 미리보기용)
  app.post('/products/:id/generate-description', async (request, reply) => {
    const { id } = request.params as { id: string };

    const product = await db.select().from(products).where(eq(products.id, parseInt(id)));
    if (product.length === 0) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    const p = product[0];
    const titleForTranslate = p.titleKo || p.title;
    const result = await translateProduct(titleForTranslate, p.metadata as Record<string, any>);

    if (result.title === titleForTranslate && !result.description) {
      return reply.status(500).send({ error: 'AI 생성 실패 (API 키 확인 필요)' });
    }

    return { description: result.description, title: result.title, productType: result.productType, tags: result.tags };
  });

  // POST /api/products/:id/save-description — 생성된 description을 DB에 저장
  app.post('/products/:id/save-description', async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params as { id: string };
    const { description } = request.body as { description: string };

    if (!description) {
      return reply.status(400).send({ error: 'description이 필요합니다' });
    }

    const [updated] = await db.update(products)
      .set({ description, updatedAt: new Date() })
      .where(eq(products.id, parseInt(id)))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    logAction(user, 'product.description-save', { targetType: 'product', targetId: id });
    return { ok: true, description: updated.description };
  });

  // GET /api/products/generate-descriptions (SSE) — description 일괄 생성
  app.get('/products/generate-descriptions', async (request, reply) => {
    const { mode = 'missing' } = request.query as { mode?: string };
    // mode: 'missing' = description NULL만, 'all' = 전체 재생성

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const send = (event: string, data: Record<string, any>) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const items = mode === 'all'
      ? await db.select().from(products).where(sql`${products.status} != 'trashed'`)
      : await db.select().from(products).where(sql`${products.description} IS NULL AND ${products.status} != 'trashed'`);

    if (items.length === 0) {
      send('done', { generated: 0, failed: 0, total: 0, message: '생성할 상품이 없습니다' });
      reply.raw.end();
      return reply;
    }

    send('start', { total: items.length });

    let generated = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const titleKo = item.titleKo || item.title;

      send('progress', { current: i + 1, total: items.length, titleKo, status: 'generating' });

      try {
        const result = await translateProduct(titleKo, item.metadata as Record<string, any>);

        if (!result.description || result.title === titleKo) {
          failed++;
          send('progress', { current: i + 1, total: items.length, titleKo, status: 'failed', generated, failed });
          continue;
        }

        await db.update(products)
          .set({ description: result.description, updatedAt: new Date() })
          .where(eq(products.id, item.id));

        generated++;
        send('progress', { current: i + 1, total: items.length, titleKo, titleEn: result.title, status: 'ok', generated, failed });
      } catch (err) {
        failed++;
        send('progress', { current: i + 1, total: items.length, titleKo, status: 'error', error: (err as Error).message, generated, failed });
      }

      await new Promise(r => setTimeout(r, 200));
    }

    send('done', { generated, failed, total: items.length });
    reply.raw.end();
    return reply;
  });

  // DELETE /api/products/:id - Delete product
  app.delete('/products/:id', async (request, reply) => {
    const user = getUser(request);
    const { id } = request.params as { id: string };
    const [deleted] = await db.delete(products)
      .where(eq(products.id, parseInt(id)))
      .returning();

    if (!deleted) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    logAction(user, 'product.delete', { targetType: 'product', targetId: id });
    return { data: deleted };
  });

  // GET /api/products/translate-batch (SSE) - 미번역 상품 일괄 번역 (실시간 스트리밍)
  // ?ids=1,2,3 으로 특정 상품만 번역 가능
  app.get('/products/translate-batch', async (request, reply) => {
    // 동시 실행 방지
    if (translateRunning) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ translated: 0, failed: 0, total: 0, message: '이미 번역이 진행 중입니다' })}\n\n`);
      reply.raw.end();
      return reply;
    }
    translateRunning = true;

    const sessionId = crypto.randomUUID();
    const abortSignal = { aborted: false };
    translateAbortMap.set(sessionId, abortSignal);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const cleanup = () => { translateAbortMap.delete(sessionId); translateRunning = false; };
    reply.raw.on('close', cleanup);

    const send = (event: string, data: Record<string, any>) => {
      if (!abortSignal.aborted) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    // 세션 ID를 클라이언트에 먼저 전송
    reply.raw.write(`event: session\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    const { ids } = request.query as { ids?: string };
    const idList = ids ? ids.split(',').map(Number).filter(n => !isNaN(n)) : [];

    // 1) products 미번역 (title === titleKo)
    const untranslatedProducts = idList.length > 0
      ? await db.select().from(products)
          .where(sql`${products.id} IN (${sql.join(idList.map(id => sql`${id}`), sql`, `)}) AND ${products.titleKo} IS NOT NULL AND (${products.title} = ${products.titleKo} OR ${products.title} IS NULL)`)
      : await db.select().from(products)
          .where(sql`${products.title} = ${products.titleKo} AND ${products.titleKo} IS NOT NULL`);

    // 2) crawl_results 미번역 (title_en IS NULL, status != 'imported')
    const untranslatedCrawl = await db.select().from(crawlResults)
      .where(sql`${crawlResults.titleEn} IS NULL AND ${crawlResults.status} != 'imported'`);

    // 통합 작업 목록
    type TranslateItem = { id: number; titleKo: string; rawData: any; source: 'product' | 'crawl' };
    const items: TranslateItem[] = [
      ...untranslatedProducts.map(p => ({ id: p.id, titleKo: p.titleKo!, rawData: p.metadata, source: 'product' as const })),
      ...untranslatedCrawl.map(c => ({ id: c.id, titleKo: c.title, rawData: c.rawData, source: 'crawl' as const })),
    ];

    if (items.length === 0) {
      send('done', { translated: 0, failed: 0, total: 0, message: '번역할 상품이 없습니다' });
      reply.raw.end();
      return reply;
    }

    send('start', { total: items.length });

    let translated = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      if (abortSignal.aborted) break;

      const item = items[i];
      try {
        send('progress', {
          current: i + 1,
          total: items.length,
          titleKo: item.titleKo,
          status: 'translating',
        });

        const result = await translateProduct(item.titleKo, item.rawData as Record<string, any>);

        if (abortSignal.aborted) break;

        // 번역 결과가 원본과 같으면 (API 키 없음 등) 건너뜀
        if (result.title === item.titleKo) {
          failed++;
          send('progress', {
            current: i + 1,
            total: items.length,
            titleKo: item.titleKo,
            titleEn: null,
            status: 'failed',
            translated,
            failed,
          });
          continue;
        }

        if (item.source === 'product') {
          await db.update(products)
            .set({
              title: result.title,
              description: result.description,
              productType: result.productType,
              tags: result.tags.length > 0 ? result.tags : undefined,
              updatedAt: new Date(),
            })
            .where(eq(products.id, item.id));
        } else {
          await db.update(crawlResults)
            .set({ titleEn: result.title })
            .where(eq(crawlResults.id, item.id));
        }

        translated++;
        send('progress', {
          current: i + 1,
          total: items.length,
          titleKo: item.titleKo,
          titleEn: result.title,
          status: 'ok',
          translated,
          failed,
        });
      } catch (err) {
        console.error(`[translate-batch] ${item.source} #${item.id} 실패:`, err);
        failed++;
        send('progress', {
          current: i + 1,
          total: items.length,
          titleKo: item.titleKo,
          titleEn: null,
          status: 'error',
          error: (err as Error).message,
          translated,
          failed,
        });
      }

      // rate limit 방지
      await new Promise(r => setTimeout(r, 200));
    }

    cleanup();
    send(abortSignal.aborted ? 'stopped' : 'done', { translated, failed, total: items.length, stopped: abortSignal.aborted });
    reply.raw.end();
    return reply;
  });
}
