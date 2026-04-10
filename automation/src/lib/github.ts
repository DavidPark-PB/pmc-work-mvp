/**
 * GitHub API 클라이언트 — 백업 관리용
 */
import { env } from './config.js';
import { logger } from './logger.js';

const [OWNER, REPO] = env.GITHUB_REPO.split('/');
const API = 'https://api.github.com';

function headers() {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN 미설정');
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...init?.headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Types ──

export interface BackupInfo {
  id: number;
  name: string;
  date: string;
  sizeBytes: number;
  sizeFormatted: string;
  type: 'scheduled' | 'manual' | 'pre-restore';
  expiresAt: string;
  workflowRunId: number;
}

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  html_url: string;
}

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseBackupDate(name: string): string {
  // db-backup-2026-03-16_1900 (UTC) → KST로 변환
  const match = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  if (!match) return '';
  const utc = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]));
  return utc.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function classifyType(name: string, event: string): BackupInfo['type'] {
  if (name.includes('pre-restore')) return 'pre-restore';
  if (event === 'schedule') return 'scheduled';
  return 'manual';
}

// ── Public API ──

export async function listBackups(): Promise<BackupInfo[]> {
  // Fetch artifacts (paginated, max 100)
  const data = await ghFetch(`/repos/${OWNER}/${REPO}/actions/artifacts?per_page=100`);
  const artifacts: any[] = data.artifacts ?? [];

  // Filter to db-backup- artifacts only
  const backupArtifacts = artifacts.filter((a: any) => a.name.startsWith('db-backup-'));

  // Build run ID → event map for type classification
  const runIds = [...new Set(backupArtifacts.map((a: any) => a.workflow_run?.id).filter(Boolean))];
  const runEventMap = new Map<number, string>();

  // Fetch run details in batches
  const batchSize = 10;
  for (let i = 0; i < runIds.length; i += batchSize) {
    const batch = runIds.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(id =>
        ghFetch(`/repos/${OWNER}/${REPO}/actions/runs/${id}`)
          .then((r: any) => ({ id, event: r.event }))
          .catch(() => ({ id, event: 'unknown' }))
      )
    );
    for (const r of results) {
      runEventMap.set(r.id, r.event);
    }
  }

  return backupArtifacts
    .map((a: any) => {
      const runId = a.workflow_run?.id ?? 0;
      const event = runEventMap.get(runId) ?? 'unknown';
      return {
        id: a.id,
        name: a.name,
        date: parseBackupDate(a.name),
        sizeBytes: a.size_in_bytes,
        sizeFormatted: formatBytes(a.size_in_bytes),
        type: classifyType(a.name, event),
        expiresAt: a.expires_at,
        workflowRunId: runId,
      };
    })
    .sort((a, b) => (a.name > b.name ? -1 : 1)); // newest first
}

export async function triggerBackup(): Promise<{ success: boolean; error?: string }> {
  try {
    await ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows/db-backup.yml/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    return { success: true };
  } catch (e) {
    logger.error(e, '[github] triggerBackup failed');
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function triggerRestore(artifactName: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ghFetch(`/repos/${OWNER}/${REPO}/actions/workflows/db-restore.yml/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { artifact_name: artifactName } }),
    });
    return { success: true };
  } catch (e) {
    logger.error(e, '[github] triggerRestore failed');
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getRecentRuns(workflowFile: string, limit = 5): Promise<WorkflowRun[]> {
  try {
    const data = await ghFetch(
      `/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/runs?per_page=${limit}`
    );
    return (data.workflow_runs ?? []).map((r: any) => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      event: r.event,
      created_at: r.created_at,
      html_url: r.html_url,
    }));
  } catch {
    return [];
  }
}

export function isGitHubConfigured(): boolean {
  return !!env.GITHUB_TOKEN;
}
