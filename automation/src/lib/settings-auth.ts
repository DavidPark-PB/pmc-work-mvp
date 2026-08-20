import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from './config.js';

const COOKIE_NAME = 'settings_auth';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24시간 (초)

function createToken(): string {
  const expires = Date.now() + COOKIE_MAX_AGE * 1000;
  const payload = `settings:${expires}`;
  const sig = crypto
    .createHmac('sha256', env.SETTINGS_PASSWORD)
    .update(payload)
    .digest('hex');
  return `${expires}.${sig}`;
}

function verifyToken(token: string): boolean {
  const [expiresStr, sig] = token.split('.');
  if (!expiresStr || !sig) return false;

  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || Date.now() > expires) return false;

  const expected = crypto
    .createHmac('sha256', env.SETTINGS_PASSWORD)
    .update(`settings:${expiresStr}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function isSettingsAuthed(request: FastifyRequest): boolean {
  const token = (request.cookies as Record<string, string>)?.[COOKIE_NAME];
  if (!token) return false;
  return verifyToken(token);
}

export function setSettingsAuthCookie(reply: FastifyReply): void {
  const token = createToken();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
  });
}

export function clearSettingsAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}
