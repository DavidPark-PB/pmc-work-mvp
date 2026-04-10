/**
 * 인증 + 직원 관리 라우트
 */
import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  login,
  setSessionCookie,
  clearSessionCookie,
  getAuthUser,
  hashPassword,
  invalidateUserCache,
  type AuthUser,
} from '../lib/auth.js';
import { logAction } from '../lib/audit-log.js';

export async function authRoutes(app: FastifyInstance) {
  // ── 로그인 페이지 ──────────────────────────
  app.get('/login', async (request, reply) => {
    const user = await getAuthUser(request);
    if (user) return reply.redirect('/');
    return reply.viewAsync('login.eta', { step: -1 });
  });

  // ── 로그인 API ─────────────────────────────
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body as { username?: string; password?: string };

    if (!username || !password) {
      return reply.status(400).send({ error: '아이디와 비밀번호를 입력해 주세요.' });
    }

    const result = await login(username.trim(), password);
    if ('error' in result) {
      return reply.status(401).send({ error: result.error });
    }

    invalidateUserCache(result.user.id);
    setSessionCookie(reply, result.user.id);
    return { success: true, user: result.user };
  });

  // ── 로그아웃 ───────────────────────────────
  app.post('/api/auth/logout', async (request, reply) => {
    const user = await getAuthUser(request);
    if (user) invalidateUserCache(user.id);
    clearSessionCookie(reply);
    return { success: true };
  });

  // ── 현재 사용자 조회 ───────────────────────
  app.get('/api/auth/me', async (request) => {
    const user = await getAuthUser(request);
    return { user };
  });

  // ── 직원 관리 페이지 (Admin 전용) ──────────
  app.get('/staff', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user) return reply.redirect('/login');
    if (user.role !== 'admin') return reply.redirect('/');

    const allUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));

    return reply.viewAsync('staff.eta', { step: 11, user, staffList: allUsers }, { layout: 'layout.eta' });
  });

  // ── 이름 설정 API (첫 로그인 시) ────────────
  app.post('/api/auth/set-name', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user) return reply.status(401).send({ error: '로그인이 필요합니다.' });

    const { displayName } = request.body as { displayName?: string };
    if (!displayName || displayName.trim().length === 0) {
      return reply.status(400).send({ error: '이름을 입력해 주세요.' });
    }
    if (displayName.trim().length > 100) {
      return reply.status(400).send({ error: '이름은 100자 이내로 입력해 주세요.' });
    }

    await db.update(users).set({ displayName: displayName.trim() }).where(eq(users.id, user.id));
    invalidateUserCache(user.id);
    return { success: true, displayName: displayName.trim() };
  });

  // ── 비밀번호 초기화 API (Admin 전용) ────────
  app.post('/api/staff/:id/reset-password', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: '관리자만 비밀번호를 초기화할 수 있습니다.' });
    }

    const staffId = parseInt((request.params as { id: string }).id, 10);
    const { newPassword } = request.body as { newPassword?: string };

    if (!newPassword || newPassword.length < 4) {
      return reply.status(400).send({ error: '새 비밀번호는 4자 이상이어야 합니다.' });
    }

    const target = await db.query.users.findFirst({ where: eq(users.id, staffId) });
    if (!target) return reply.status(404).send({ error: '해당 직원을 찾을 수 없습니다.' });

    const passwordHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash }).where(eq(users.id, staffId));

    const auditUser = { id: user.id, name: user.displayName };
    logAction(auditUser, 'staff.resetPassword', { targetType: 'user', targetId: staffId });
    return { success: true, username: target.username };
  });

  // ── 직원 생성 API (Admin 전용) ─────────────
  app.post('/api/staff', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: '관리자만 직원을 추가할 수 있습니다.' });
    }

    const { username, password, displayName, role } = request.body as {
      username?: string;
      password?: string;
      displayName?: string;
      role?: string;
    };

    if (!username || !password) {
      return reply.status(400).send({ error: '아이디와 비밀번호는 필수입니다.' });
    }

    if (username.trim().length < 2 || username.trim().length > 50) {
      return reply.status(400).send({ error: '아이디는 2~50자여야 합니다.' });
    }

    if (password.length < 4) {
      return reply.status(400).send({ error: '비밀번호는 4자 이상이어야 합니다.' });
    }

    // 중복 확인
    const existing = await db.query.users.findFirst({
      where: eq(users.username, username.trim()),
    });
    if (existing) {
      return reply.status(409).send({ error: '이미 사용 중인 아이디입니다.' });
    }

    const passwordHash = await hashPassword(password);
    const validRole = role === 'admin' ? 'admin' : 'staff';

    const [created] = await db.insert(users).values({
      username: username.trim(),
      passwordHash,
      displayName: displayName?.trim() || username.trim(),
      role: validRole,
    }).returning({ id: users.id });

    const auditUser = { id: user.id, name: user.displayName };
    logAction(auditUser, 'staff.create', { targetType: 'user', targetId: created.id, details: { username: username.trim(), role: validRole } });
    return { success: true, id: created.id };
  });

  // ── 직원 수정 API (Admin 전용) ─────────────
  app.put('/api/staff/:id', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: '관리자만 직원 정보를 수정할 수 있습니다.' });
    }

    const staffId = parseInt((request.params as { id: string }).id, 10);
    const { displayName, role, isActive, password } = request.body as {
      displayName?: string;
      role?: string;
      isActive?: boolean;
      password?: string;
    };

    const updates: Record<string, any> = {};
    if (displayName !== undefined) updates.displayName = displayName.trim();
    if (role !== undefined) updates.role = role === 'admin' ? 'admin' : 'staff';
    if (isActive !== undefined) updates.isActive = isActive;
    if (password && password.length >= 4) {
      updates.passwordHash = await hashPassword(password);
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: '변경할 항목이 없습니다.' });
    }

    await db.update(users).set(updates).where(eq(users.id, staffId));
    invalidateUserCache(staffId);

    const auditUser = { id: user.id, name: user.displayName };
    logAction(auditUser, 'staff.update', { targetType: 'user', targetId: staffId, details: updates });
    return { success: true };
  });

  // ── 직원 삭제 API (Admin 전용) ─────────────
  app.delete('/api/staff/:id', async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user || user.role !== 'admin') {
      return reply.status(403).send({ error: '관리자만 직원을 삭제할 수 있습니다.' });
    }

    const staffId = parseInt((request.params as { id: string }).id, 10);

    // 자기 자신 삭제 방지
    if (staffId === user.id) {
      return reply.status(400).send({ error: '자기 자신은 삭제할 수 없습니다.' });
    }

    await db.delete(users).where(eq(users.id, staffId));
    invalidateUserCache(staffId);

    const auditUser = { id: user.id, name: user.displayName };
    logAction(auditUser, 'staff.delete', { targetType: 'user', targetId: staffId });
    return { success: true };
  });
}
