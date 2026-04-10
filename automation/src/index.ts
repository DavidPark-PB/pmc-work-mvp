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
import { tokenRoutes } from './routes/tokens.js';
import { backupRoutes } from './routes/backups.js';
import { authRoutes } from './routes/auth.js';

import { syncAllInventory } from './services/inventory-sync.js';
import { db } from './db/index.js';
import { platformListings } from './db/schema.js';
import { sql } from 'drizzle-orm';
import { resolveUser, type TeamUser } from './lib/user-session.js';
import { seedAdminUser } from './lib/auth.js';
import { startTokenRefreshScheduler } from './lib/token-scheduler.js';

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

// 로그인 불필요 경로
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/health', '/style.css'];

app.addHook('onRequest', async (request, reply) => {
  // 비동기로 사용자 조회 + 캐시
  const user = await resolveUser(request);
  if (user) {
    request.user = user;
  }

  // 로그인 체크: 공개 경로 + 정적 파일 제외
  const urlPath = request.url.split('?')[0];
  const isPublic = PUBLIC_PATHS.some(p => urlPath === p)
    || urlPath.startsWith('/style.css')
    || urlPath.endsWith('.js')
    || urlPath.endsWith('.css')
    || urlPath.endsWith('.ico')
    || urlPath.endsWith('.png')
    || urlPath.endsWith('.jpg')
    || urlPath.endsWith('.svg');

  if (!isPublic && !user) {
    // API 요청은 401, 페이지 요청은 /login 리다이렉트
    if (urlPath.startsWith('/api/')) {
      return reply.status(401).send({ error: '로그인이 필요합니다.' });
    }
    return reply.redirect('/login');
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

// 인증
app.register(authRoutes);

// API
app.register(productRoutes, { prefix: '/api' });
app.register(uploadRoutes, { prefix: '/api' });
app.register(crawlResultRoutes, { prefix: '/api' });
app.register(listingRoutes, { prefix: '/api' });
app.register(assignRoutes, { prefix: '/api' });


// 페이지
app.register(pageRoutes);
app.register(settingsRoutes);
app.register(tokenRoutes);
app.register(backupRoutes);

// ─── 서버 시작 ──────────────────────────────────
async function start() {
  try {
    // Admin 시드
    await seedAdminUser();

    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`Server running on http://localhost:${env.PORT}`);
    logger.info(`Dashboard: http://localhost:${env.PORT}/`);

    // eBay 토큰 자동 갱신: 시작 즉시 + 90분 간격
    startTokenRefreshScheduler();

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

    // 멈춘 리스팅 자동 정리: 1시간 이상 draft/pending → error
    setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - 5 * 60 * 1000);
        const fixed = await db.update(platformListings)
          .set({ status: 'error' })
          .where(sql`${platformListings.status} IN ('draft', 'pending') AND ${platformListings.createdAt} < ${cutoff}`)
          .returning({ id: platformListings.id });
        if (fixed.length > 0) {
          logger.info(`[리스팅 정리] ${fixed.length}개 stuck 리스팅 → error`);
        }
      } catch (e) {
        logger.error(e, '[리스팅 정리] 실패');
      }
    }, SYNC_INTERVAL);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

start();
