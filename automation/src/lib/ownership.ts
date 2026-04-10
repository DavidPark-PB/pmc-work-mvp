/**
 * 소유권 검증 유틸
 */
import { eq, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { crawlResults, products, users } from '../db/schema.js';
import type { TeamUser } from './user-session.js';

/** crawlResult가 요청자 소유인지 확인 (Admin은 항상 통과) */
export async function assertCrawlResultOwnership(
  crawlResultIds: number[],
  user: TeamUser,
): Promise<void> {
  if (user.isAdmin) return;
  if (crawlResultIds.length === 0) return;

  const rows = await db
    .select({ id: crawlResults.id, ownerId: crawlResults.ownerId })
    .from(crawlResults)
    .where(inArray(crawlResults.id, crawlResultIds));

  const forbidden = rows.filter(r => r.ownerId !== null && r.ownerId !== user.id);
  if (forbidden.length > 0) {
    const ids = forbidden.map(r => r.id).join(', ');
    throw new OwnershipError(`아이템 [${ids}]은(는) 다른 팀원에게 할당되어 있어 접근하실 수 없습니다.`);
  }

  const unassigned = rows.filter(r => r.ownerId === null);
  if (unassigned.length > 0) {
    const ids = unassigned.map(r => r.id).join(', ');
    throw new OwnershipError(`아이템 [${ids}]은(는) 아직 할당되지 않았습니다. 관리자에게 분배를 요청해 주세요.`);
  }
}

/** product가 요청자 소유인지 확인 (Admin은 항상 통과) */
export async function assertProductOwnership(
  productIds: number[],
  user: TeamUser,
): Promise<void> {
  if (user.isAdmin) return;
  if (productIds.length === 0) return;

  const rows = await db
    .select({ id: products.id, ownerId: products.ownerId })
    .from(products)
    .where(inArray(products.id, productIds));

  const forbidden = rows.filter(r => r.ownerId !== null && r.ownerId !== user.id);
  if (forbidden.length > 0) {
    const ids = forbidden.map(r => r.id).join(', ');
    throw new OwnershipError(`상품 [${ids}]은(는) 다른 팀원에게 할당되어 있어 접근하실 수 없습니다.`);
  }
}

/** 소유권 이전 (Admin 전용) */
export async function transferCrawlResultOwnership(
  crawlResultIds: number[],
  targetUserId: string,
  targetUserName: string,
): Promise<number> {
  if (crawlResultIds.length === 0) return 0;

  const result = await db
    .update(crawlResults)
    .set({ ownerId: targetUserId, ownerName: targetUserName })
    .where(inArray(crawlResults.id, crawlResultIds))
    .returning({ id: crawlResults.id });

  return result.length;
}

/** 활성 팀원 목록 조회 (분배 대상 선택용 — users 테이블 기반) */
export async function getActiveUsers(): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.isActive, true));

  return rows.map(r => ({ id: String(r.id), name: r.displayName }));
}

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}
