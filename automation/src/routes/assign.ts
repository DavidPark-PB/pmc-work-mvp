/**
 * 상품 분배 라우트 (Admin 전용)
 */
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults } from '../db/schema.js';
import { getUser } from '../lib/user-session.js';
import { getActiveUsers, transferCrawlResultOwnership } from '../lib/ownership.js';

export async function assignRoutes(app: FastifyInstance) {
  // POST /api/assign — 개별 상품 분배
  app.post('/assign', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '분배는 관리자만 이용하실 수 있습니다.' });
    }

    const { crawlResultIds, targetUserId, targetUserName } = request.body as {
      crawlResultIds: number[];
      targetUserId: string;
      targetUserName: string;
    };

    if (!crawlResultIds?.length || !targetUserId || !targetUserName) {
      return reply.status(400).send({ error: '필수 항목이 누락되었습니다. 다시 확인해 주세요.' });
    }

    const count = await transferCrawlResultOwnership(crawlResultIds, targetUserId, targetUserName);
    return { success: true, assigned: count };
  });

  // POST /api/assign/unassign — 할당 해제 (미할당으로 되돌리기)
  app.post('/assign/unassign', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) {
      return reply.status(403).send({ error: '할당 해제는 관리자만 이용하실 수 있습니다.' });
    }

    const { crawlResultIds } = request.body as { crawlResultIds: number[] };
    if (!crawlResultIds?.length) {
      return reply.status(400).send({ error: '아이템 ID가 필요합니다.' });
    }

    await db
      .update(crawlResults)
      .set({ ownerId: null, ownerName: null })
      .where(inArray(crawlResults.id, crawlResultIds));

    return { success: true, unassigned: crawlResultIds.length };
  });

  // GET /api/assign/users — 활성 팀원 목록
  app.get('/assign/users', async (request, reply) => {
    const user = getUser(request);
    if (!user) {
      return reply.status(401).send({ error: '이름을 먼저 설정해 주세요.' });
    }

    const users = await getActiveUsers();
    return { users };
  });
}
