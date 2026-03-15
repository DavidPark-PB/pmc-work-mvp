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
import { startScheduler, stopScheduler, getSchedulerStatus } from './jobs/scheduler.js';
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

// ─── 스케줄러 상태 API ───────────────────────────
app.get('/api/scheduler/status', async () => {
  return { jobs: getSchedulerStatus() };
});

// ─── 서버 시작 ──────────────────────────────────
async function start() {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`Server running on http://localhost:${env.PORT}`);
    logger.info(`Dashboard: http://localhost:${env.PORT}/`);

    startScheduler();
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// ─── Graceful Shutdown ───────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM 수신 — graceful shutdown 시작');
  stopScheduler();
  await app.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT 수신 — graceful shutdown 시작');
  stopScheduler();
  await app.close();
  process.exit(0);
});

start();
