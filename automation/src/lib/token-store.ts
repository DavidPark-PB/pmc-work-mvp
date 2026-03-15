/**
 * 플랫폼 OAuth 토큰 DB 저장/로드
 *
 * 갱신된 토큰을 DB에 persist하여 서버 재시작에도 유지.
 * env 토큰은 초기 시드 값으로만 사용하고, 이후 갱신분은 DB 우선.
 *
 * Shopee처럼 refresh token이 rotate되는 플랫폼은
 * main server(config/.env)와 MCP 서버가 동일 토큰을 읽으므로
 * DB 저장과 동시에 config/.env도 업데이트해야 한다.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { platformTokens } from '../db/schema.js';

// automation/ 기준으로 ../config/.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_ENV_PATH = path.resolve(__dirname, '../../../config/.env');

/**
 * config/.env에서 특정 키 값을 교체한다.
 * 키가 없으면 아무것도 하지 않는다 (추가는 하지 않음 — 의도치 않은 항목 생성 방지).
 */
export function syncEnvFile(updates: Record<string, string>): void {
  try {
    if (!fs.existsSync(MAIN_ENV_PATH)) return;
    let content = fs.readFileSync(MAIN_ENV_PATH, 'utf-8');
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^(${key}=).*`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `$1${value}`);
      }
    }
    fs.writeFileSync(MAIN_ENV_PATH, content, 'utf-8');
    console.log(`[token-store] config/.env 동기화 완료: ${Object.keys(updates).join(', ')}`);
  } catch (e) {
    console.warn('[token-store] config/.env 동기화 실패:', (e as Error).message);
  }
}

export interface TokenRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  metadata: Record<string, any> | null;
}

/** DB에서 플랫폼 토큰 로드 (없으면 null) */
export async function loadToken(platform: string): Promise<TokenRecord | null> {
  try {
    const row = await db.query.platformTokens.findFirst({
      where: eq(platformTokens.platform, platform),
    });
    if (!row) return null;
    return {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
      metadata: row.metadata as Record<string, any> | null,
    };
  } catch (e) {
    // 테이블 미생성 등 — env 폴백
    console.warn(`[token-store] ${platform} 토큰 로드 실패:`, (e as Error).message);
    return null;
  }
}

/** 갱신된 토큰을 DB에 저장 (upsert) */
export async function saveToken(
  platform: string,
  data: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    metadata?: Record<string, any> | null;
  },
): Promise<void> {
  try {
    await db.insert(platformTokens)
      .values({
        platform,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        metadata: data.metadata ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: platformTokens.platform,
        set: {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken ?? undefined,
          expiresAt: data.expiresAt ?? undefined,
          metadata: data.metadata ?? undefined,
          updatedAt: new Date(),
        },
      });
    console.log(`[token-store] ${platform} 토큰 DB 저장 완료`);
  } catch (e) {
    console.error(`[token-store] ${platform} 토큰 저장 실패:`, (e as Error).message);
  }
}
