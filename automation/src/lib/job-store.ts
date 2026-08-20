/**
 * DB 기반 업로드 잡 상태 관리
 * 서버 재시작에도 job 데이터가 유지됨
 */
import { db } from '../db/index.js';
import { uploadJobs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface JobResult {
  crawlResultId: number;
  title: string;
  platform: string;
  success: boolean;
  platformItemId?: string;
  listingUrl?: string;
  error?: string;
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

  async update(jobId: string, partial: Partial<Pick<JobState, 'status' | 'completed' | 'failed' | 'results' | 'finishedAt'>>): Promise<void> {
    const updates: Record<string, any> = {};
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
};
