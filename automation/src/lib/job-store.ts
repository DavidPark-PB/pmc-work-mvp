/**
 * DB 기반 업로드 잡 상태 관리
 * 서버 재시작에도 job 데이터가 유지됨
 */
import { db } from '../db/index.js';
import { uploadJobs } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

export type JobResultStatus = 'SUCCESS' | 'ALREADY_LISTED' | 'FAILED' | 'SKIPPED_EBAY_REQUIRED';

export interface JobResult {
  crawlResultId: number;
  title: string;
  platform: string;
  success: boolean;
  platformItemId?: string;
  listingUrl?: string;
  error?: string;
  /** 플랫폼별 결과 — 실패(FAILED)와 선행조건 미충족 미실행(SKIPPED_EBAY_REQUIRED)을 구분. 이전 job은 없음 */
  status?: JobResultStatus;
  /** 차단/오류 코드 (SHIPPING_PRICING_DISABLED, EBAY_REQUIRED 등) 또는 ADOPTED_EXISTING */
  code?: string | null;
  productId?: number;
}

export interface JobState {
  status: 'running' | 'done' | 'error';
  platforms: string[];
  total: number;
  completed: number;
  failed: number;
  results: JobResult[];
  createdAt: Date;
  finishedAt?: Date;
  dryRun: boolean;
}

function rowToJobState(row: typeof uploadJobs.$inferSelect): JobState {
  return {
    status: row.status as JobState['status'],
    platforms: row.platforms,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    results: row.results,
    dryRun: row.dryRun,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

/**
 * DB 기반 jobStore — 기존 Map 인터페이스와 호환
 */
export const jobStore = {
  async get(jobId: string): Promise<JobState | undefined> {
    const row = await db.query.uploadJobs.findFirst({
      where: eq(uploadJobs.id, jobId),
    });
    return row ? rowToJobState(row) : undefined;
  },

  async set(jobId: string, job: JobState): Promise<void> {
    await db.insert(uploadJobs).values({
      id: jobId,
      status: job.status,
      platforms: job.platforms,
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      results: job.results,
      dryRun: job.dryRun,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt ?? null,
    }).onConflictDoUpdate({
      target: uploadJobs.id,
      set: {
        status: job.status,
        completed: job.completed,
        failed: job.failed,
        results: job.results,
        finishedAt: job.finishedAt ?? null,
      },
    });
  },

  async update(jobId: string, partial: Partial<Pick<JobState, 'status' | 'total' | 'completed' | 'failed' | 'results' | 'finishedAt'>>): Promise<void> {
    const updates: Record<string, any> = {};
    if (partial.total !== undefined) updates.total = partial.total;
    if (partial.status !== undefined) updates.status = partial.status;
    if (partial.completed !== undefined) updates.completed = partial.completed;
    if (partial.failed !== undefined) updates.failed = partial.failed;
    if (partial.results !== undefined) updates.results = partial.results;
    if (partial.finishedAt !== undefined) updates.finishedAt = partial.finishedAt;

    if (Object.keys(updates).length > 0) {
      await db.update(uploadJobs).set(updates).where(eq(uploadJobs.id, jobId));
    }
  },

  async entries(): Promise<[string, JobState][]> {
    const rows = await db.select().from(uploadJobs);
    return rows.map(row => [row.id, rowToJobState(row)]);
  },

  /** running 상태인 job만 조회 (대시보드용 — 전체 로드 방지) */
  async getRunning(): Promise<{ id: string; job: JobState }[]> {
    const rows = await db.select().from(uploadJobs).where(eq(uploadJobs.status, 'running'));
    return rows.map(row => ({ id: row.id, job: rowToJobState(row) }));
  },

  /** 최근 N개 job 조회 (히스토리용 — 정렬 + 제한) */
  async recent(limit: number = 50): Promise<{ id: string; job: JobState }[]> {
    const rows = await db.select().from(uploadJobs).orderBy(desc(uploadJobs.createdAt)).limit(limit);
    return rows.map(row => ({ id: row.id, job: rowToJobState(row) }));
  },
};
