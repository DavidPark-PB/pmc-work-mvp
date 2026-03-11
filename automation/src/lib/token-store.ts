/**
 * 플랫폼 OAuth 토큰 DB 저장/로드
 *
 * 갱신된 토큰을 DB에 persist하여 서버 재시작에도 유지.
 * env 토큰은 초기 시드 값으로만 사용하고, 이후 갱신분은 DB 우선.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { platformTokens } from '../db/schema.js';

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
