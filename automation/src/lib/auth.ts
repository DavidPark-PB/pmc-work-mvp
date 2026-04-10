/**
 * DB 기반 인증 시스템
 * - bcrypt 해싱
 * - HMAC 쿠키 세션
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { env } from './config.js';

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7일 (초)
const BCRYPT_ROUNDS = 10;

// HMAC 서명 키 (SETTINGS_PASSWORD를 키로 재사용)
const HMAC_KEY = env.SETTINGS_PASSWORD;

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'staff';
  needsName: boolean; // displayName이 비어있으면 true
};

// ── 패스워드 해싱 ──────────────────────────
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── 세션 쿠키 (HMAC 서명) ──────────────────
function createSessionToken(userId: number): string {
  const expires = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = `${userId}:${expires}`;
  const sig = crypto
    .createHmac('sha256', HMAC_KEY)
    .update(payload)
    .digest('hex');
  return `${userId}.${expires}.${sig}`;
}

function verifySessionToken(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userIdStr, expiresStr, sig] = parts;
  const userId = parseInt(userIdStr, 10);
  const expires = parseInt(expiresStr, 10);
  if (isNaN(userId) || isNaN(expires)) return null;
  if (Date.now() > expires) return null;

  const expected = crypto
    .createHmac('sha256', HMAC_KEY)
    .update(`${userId}:${expiresStr}`)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }

  return userId;
}

// ── 로그인/로그아웃 ────────────────────────
export async function login(
  username: string,
  password: string,
): Promise<{ user: AuthUser } | { error: string }> {
  const row = await db.query.users.findFirst({
    where: eq(users.username, username),
  });

  if (!row) return { error: '아이디 또는 비밀번호가 올바르지 않습니다.' };
  if (!row.isActive) return { error: '비활성화된 계정입니다. 관리자에게 문의하세요.' };

  const valid = await verifyPassword(password, row.passwordHash);
  if (!valid) return { error: '아이디 또는 비밀번호가 올바르지 않습니다.' };

  // lastLoginAt 업데이트
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));

  return {
    user: {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role as 'admin' | 'staff',
      needsName: !row.displayName || row.displayName === '' || row.displayName === row.username,
    },
  };
}

export function setSessionCookie(reply: FastifyReply, userId: number): void {
  const token = createSessionToken(userId);
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

// ── 사용자 조회 캐시 (TTL 5분) ────────────────
const USER_CACHE_TTL = 5 * 60 * 1000;
const userDbCache = new Map<number, { user: AuthUser | null; expiresAt: number }>();

/** 캐시 무효화 (로그인/로그아웃/권한 변경 시 호출) */
export function invalidateUserCache(userId?: number): void {
  if (userId) {
    userDbCache.delete(userId);
  } else {
    userDbCache.clear();
  }
}

// ── 현재 로그인 사용자 조회 ─────────────────
export async function getAuthUser(request: FastifyRequest): Promise<AuthUser | null> {
  const token = (request.cookies as Record<string, string>)?.[SESSION_COOKIE];
  if (!token) return null;

  const userId = verifySessionToken(token);
  if (!userId) return null;

  // 캐시 확인
  const cached = userDbCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  const authUser = (!row || !row.isActive) ? null : {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as 'admin' | 'staff',
    needsName: !row.displayName || row.displayName === '' || row.displayName === row.username,
  };

  userDbCache.set(userId, { user: authUser, expiresAt: Date.now() + USER_CACHE_TTL });
  return authUser;
}

// ── Admin 시드 ──────────────────────────────
export async function seedAdminUser(): Promise<void> {
  const adminUsername = env.ADMIN_USERNAME;
  const adminPassword = env.ADMIN_PASSWORD;

  if (!adminUsername || !adminPassword) return;

  const existing = await db.query.users.findFirst({
    where: eq(users.username, adminUsername),
  });

  if (existing) return; // 이미 존재

  const hash = await hashPassword(adminPassword);
  await db.insert(users).values({
    username: adminUsername,
    passwordHash: hash,
    displayName: 'Admin',
    role: 'admin',
  });

  console.log(`[Auth] Admin 계정 생성 완료: ${adminUsername}`);
}
