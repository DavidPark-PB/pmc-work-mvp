/**
 * 토큰 관리 라우트 — 상태 조회 + 수동 갱신
 */
import type { FastifyInstance } from 'fastify';
import { getUser } from '../lib/user-session.js';
import { getTokenStatuses, manualRefresh } from '../lib/token-scheduler.js';

export async function tokenRoutes(app: FastifyInstance) {
  // 토큰 관리 페이지
  app.get('/tokens', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.redirect('/');
    }
    return reply.viewAsync('tokens.eta', { step: 9 }, { layout: 'layout.eta' });
  });

  // 토큰 상태 API
  app.get('/api/tokens/status', async (request, reply) => {
    if (!getUser(request)?.isAdmin) {
      return reply.status(401).send({ error: '인증 필요' });
    }
    return getTokenStatuses();
  });

  // 수동 갱신 API
  app.post('/api/tokens/refresh', async (request, reply) => {
    if (!getUser(request)?.isAdmin) {
      return reply.status(401).send({ error: '인증 필요' });
    }

    const { platform } = request.body as { platform?: string };
    if (!platform) {
      return reply.status(400).send({ error: 'platform 필수' });
    }

    const result = await manualRefresh(platform);
    return result;
  });
}
