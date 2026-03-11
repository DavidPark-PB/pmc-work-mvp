import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { products } from '../db/schema.js';
import { eq, like, sql } from 'drizzle-orm';

export async function productRoutes(app: FastifyInstance) {
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

    return reply.status(201).send({ data: created });
  });

  // PUT /api/products/:id - Update product
  app.put('/products/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<typeof products.$inferInsert>;

    const [updated] = await db.update(products)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(products.id, parseInt(id)))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    return { data: updated };
  });

  // DELETE /api/products/:id - Delete product
  app.delete('/products/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deleted] = await db.delete(products)
      .where(eq(products.id, parseInt(id)))
      .returning();

    if (!deleted) {
      return reply.status(404).send({ error: 'Product not found' });
    }

    return { data: deleted };
  });
}
