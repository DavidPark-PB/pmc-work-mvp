import path from 'path';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { Eta } from 'eta';
import { env } from './lib/config.js';
import { logger } from './lib/logger.js';
import { productRoutes } from './routes/products.js';
import { uploadRoutes } from './routes/upload.js';
import { crawlResultRoutes } from './routes/crawl-results.js';
import { listingRoutes } from './routes/listings.js';
import { pageRoutes } from './routes/pages.js';
import { settingsRoutes } from './routes/settings.js';
import { assignRoutes } from './routes/assign.js';
import { syncAllInventory } from './services/inventory-sync.js';
import { getUser, type TeamUser } from './lib/user-session.js';

const app = Fastify({
  logger: false,
});

// ─── 플러그인 ───────────────────────────────────
await app.register(fastifyCookie);

await app.register(fastifyMultipart, {
  limits: { fileSize: 50_000_000 },
});

const eta = new Eta({ views: path.join(process.cwd(), 'views') });
await app.register(fastifyView, {
  engine: { eta },
  root: path.join(process.cwd(), 'views'),
  layout: 'layout.eta',
  viewExt: 'eta',
});

await app.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
});

// ─── 사용자 정보를 request에 주입 ────────────────
declare module 'fastify' {
  interface FastifyRequest {
    user?: TeamUser;
  }
}

app.addHook('onRequest', async (request) => {
  const user = getUser(request);
  if (user) {
    request.user = user;
  }
});

// ─── 라우트 ─────────────────────────────────────
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// 이미지 프록시 (쿠팡 등 핫링크 차단 우회)
app.get('/api/img-proxy', async (request, reply) => {
  const { url } = request.query as { url?: string };
  if (!url) return reply.status(400).send('url required');

  try {
    const res = await fetch(url, {
      headers: { 'Referer': new URL(url).origin + '/' },
    });
    if (!res.ok) return reply.status(res.status).send('upstream error');

    const contentType = res.headers.get('content-type') || 'image/jpeg';
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await res.arrayBuffer());
    return reply.send(buffer);
  } catch {
    return reply.status(502).send('fetch failed');
  }
});

// API
app.register(productRoutes, { prefix: '/api' });
app.register(uploadRoutes, { prefix: '/api' });
app.register(crawlResultRoutes, { prefix: '/api' });
app.register(listingRoutes, { prefix: '/api' });
app.register(assignRoutes, { prefix: '/api' });

// 페이지
app.register(pageRoutes);
app.register(settingsRoutes);

// ─── 서버 시작 ──────────────────────────────────
async function start() {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`Server running on http://localhost:${env.PORT}`);
    logger.info(`Dashboard: http://localhost:${env.PORT}/`);

    // 재고 자동추적: 30분마다 동기화
    const SYNC_INTERVAL = 30 * 60 * 1000;
    setInterval(async () => {
      try {
        logger.info('[인벤토리] 자동 동기화 시작...');
        const results = await syncAllInventory();
        const changed = results.filter(r => r.changed).length;
        logger.info(`[인벤토리] 자동 동기화 완료: ${results.length}개 확인, ${changed}개 변경`);
      } catch (e) {
        logger.error(e, '[인벤토리] 자동 동기화 실패');
      }
    }, SYNC_INTERVAL);
    logger.info('[인벤토리] 자동추적 활성화 (30분 간격)');
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

start();
