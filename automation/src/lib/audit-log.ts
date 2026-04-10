/**
 * 감사 로그 유틸리티
 *
 * 모든 함수는 fire-and-forget — await 없이 호출하며, 실패해도 원래 작업에 영향 없음
 */
import { db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';
import { logger } from './logger.js';

/** logAction/logError 공통 user 타입 (TeamUser, AuthUser 모두 호환) */
export interface AuditUser {
  id: string | number;
  name: string;
}

interface LogOptions {
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, any>;
}

/** 성공 작업 로그 — fire-and-forget */
export function logAction(
  user: AuditUser | null,
  action: string,
  opts: LogOptions = {},
): void {
  const category = action.split('.')[0];

  db.insert(auditLogs).values({
    userId: user ? Number(user.id) : null,
    userName: user?.name ?? null,
    action,
    category,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId != null ? String(opts.targetId) : null,
    success: true,
    details: opts.details ?? null,
  }).catch(err => {
    logger.error(err, `[audit] 로그 저장 실패: ${action}`);
  });
}

/** 에러 로그 — fire-and-forget */
export function logError(
  user: AuditUser | null,
  action: string,
  error: unknown,
  opts: LogOptions = {},
): void {
  const category = action.split('.')[0];
  const errMsg = error instanceof Error ? error.message : String(error);
  const errStack = error instanceof Error ? error.stack : undefined;

  db.insert(auditLogs).values({
    userId: user ? Number(user.id) : null,
    userName: user?.name ?? null,
    action,
    category,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId != null ? String(opts.targetId) : null,
    success: false,
    details: { ...opts.details, error: errMsg, stack: errStack },
  }).catch(err => {
    logger.error(err, `[audit] 에러 로그 저장 실패: ${action}`);
  });
}

/** 배치 작업 요약 로그 — fire-and-forget */
export function logBatchAction(
  user: AuditUser | null,
  action: string,
  opts: LogOptions & { count: number; succeeded?: number; failed?: number },
): void {
  const category = action.split('.')[0];

  db.insert(auditLogs).values({
    userId: user ? Number(user.id) : null,
    userName: user?.name ?? null,
    action,
    category,
    targetType: opts.targetType ?? null,
    targetId: null,
    success: (opts.failed ?? 0) === 0,
    details: {
      ...opts.details,
      count: opts.count,
      succeeded: opts.succeeded,
      failed: opts.failed,
    },
  }).catch(err => {
    logger.error(err, `[audit] 배치 로그 저장 실패: ${action}`);
  });
}
