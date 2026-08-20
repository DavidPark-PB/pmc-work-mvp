/**
 * 팀 사용자 세션 관리 (쿠키 기반)
 */
import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSettingsAuthed } from './settings-auth.js';

const COOKIE_NAME = 'team_user';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30일 (초)

export type TeamUser = {
  id: string;
  name: string;
  isAdmin: boolean;
};

/** 쿠키에서 사용자 정보 읽기 */
export function getUser(request: FastifyRequest): TeamUser | null {
  const raw = (request.cookies as Record<string, string>)?.[COOKIE_NAME];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { id?: string; name?: string };
    if (!parsed.id || !parsed.name) return null;

    return {
      id: parsed.id,
      name: parsed.name,
      isAdmin: isSettingsAuthed(request),
    };
  } catch {
    return null;
  }
}

/** 닉네임 설정 + 쿠키 저장 (기존 UUID 유지 or 신규 생성) */
export function setUser(request: FastifyRequest, reply: FastifyReply, name: string): TeamUser {
  const existing = getUser(request);
  const id = existing?.id ?? randomUUID();

  const cookieValue = JSON.stringify({ id, name });
  reply.setCookie(COOKIE_NAME, cookieValue, {
    path: '/',
    httpOnly: false, // JS에서 닉네임 읽기 위해
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
  });

  return {
    id,
    name,
    isAdmin: isSettingsAuthed(request),
  };
}
