/**
 * 팀 사용자 세션 관리 — DB 로그인 기반
 *
 * 기존 TeamUser 타입/getUser 시그니처 유지 (호환성)
 * 내부적으로 auth.ts의 세션 쿠키를 사용
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAuthUser, type AuthUser } from './auth.js';

export type TeamUser = {
  id: string;
  name: string;
  isAdmin: boolean;
};

/** AuthUser → TeamUser 변환 */
function toTeamUser(authUser: AuthUser): TeamUser {
  return {
    id: String(authUser.id),
    name: authUser.displayName,
    isAdmin: authUser.role === 'admin',
  };
}

// 요청별 캐시 (같은 요청에서 getUser 여러 번 호출 시 DB 중복 조회 방지)
const userCache = new WeakMap<FastifyRequest, TeamUser | null>();

/** 현재 로그인 사용자 조회 (동기 호환용 — 캐시 사용) */
export function getUser(request: FastifyRequest): TeamUser | null {
  if (userCache.has(request)) {
    return userCache.get(request)!;
  }
  // onRequest 훅에서 미리 캐시됨
  return null;
}

/** onRequest 훅에서 호출 — 비동기로 사용자 조회 후 캐시 */
export async function resolveUser(request: FastifyRequest): Promise<TeamUser | null> {
  const authUser = await getAuthUser(request);
  const teamUser = authUser ? toTeamUser(authUser) : null;
  userCache.set(request, teamUser);
  return teamUser;
}

/**
 * @deprecated 로그인 시스템으로 대체. 직접 /login에서 계정 생성 후 로그인하세요.
 */
export function setUser(_request: FastifyRequest, reply: FastifyReply, name: string): TeamUser {
  // 레거시 호환: 더 이상 쿠키 직접 설정 안 함
  return { id: '0', name, isAdmin: false };
}
