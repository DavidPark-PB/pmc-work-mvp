/**
 * DB 백업 관리 라우트 — 목록 조회, 수동 백업, 복원
 */
import type { FastifyInstance } from 'fastify';
import { getUser } from '../lib/user-session.js';
import { logAction, logError } from '../lib/audit-log.js';
import {
  listBackups,
  triggerBackup,
  triggerRestore,
  getRecentRuns,
  isGitHubConfigured,
} from '../lib/github.js';

export async function backupRoutes(app: FastifyInstance) {
  // 백업 관리 페이지
  app.get('/backups', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.redirect('/');
    return reply.viewAsync('backups.eta', { step: 13 }, { layout: 'layout.eta' });
  });

  // 백업 목록 API
  app.get('/api/backups', async (request, reply) => {
    if (!getUser(request)?.isAdmin) {
      return reply.status(401).send({ error: '인증 필요' });
    }
    if (!isGitHubConfigured()) {
      return reply.status(503).send({ error: 'GITHUB_TOKEN 미설정' });
    }
    try {
      const backups = await listBackups();
      return { backups };
    } catch (e) {
      return reply.status(500).send({ error: 'GitHub API 오류' });
    }
  });

  // 즉시 백업 트리거
  app.post('/api/backups/trigger', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.status(401).send({ error: '인증 필요' });
    if (!isGitHubConfigured()) return reply.status(503).send({ error: 'GITHUB_TOKEN 미설정' });

    try {
      const runs = await getRecentRuns('db-backup.yml', 5);
      const running = runs.find(r => r.status === 'in_progress' || r.status === 'queued');
      if (running) {
        return reply.status(409).send({ error: '이미 백업이 진행 중입니다.' });
      }

      const result = await triggerBackup();
      if (result.success) {
        logAction({ id: user.id, name: user.name }, 'backup.manual', {
          targetType: 'backup',
        });
        return { success: true, message: '백업이 시작되었습니다.' };
      }
      return reply.status(500).send({ error: result.error || '백업 시작 실패' });
    } catch (e) {
      logError({ id: user.id, name: user.name }, 'backup.manual', e);
      return reply.status(500).send({ error: '백업 시작 실패' });
    }
  });

  // 워크플로우 상태 확인 (폴링용)
  app.get('/api/backups/status', async (request, reply) => {
    if (!getUser(request)?.isAdmin) return reply.status(401).send({ error: '인증 필요' });
    if (!isGitHubConfigured()) return reply.status(503).send({ error: 'GITHUB_TOKEN 미설정' });

    try {
      const [backupRuns, restoreRuns] = await Promise.all([
        getRecentRuns('db-backup.yml', 3),
        getRecentRuns('db-restore.yml', 3),
      ]);

      return {
        backupRunning: !!backupRuns.find(r => r.status === 'in_progress' || r.status === 'queued'),
        restoreRunning: !!restoreRuns.find(r => r.status === 'in_progress' || r.status === 'queued'),
        lastBackupRun: backupRuns[0] ?? null,
        lastRestoreRun: restoreRuns[0] ?? null,
      };
    } catch {
      return reply.status(500).send({ error: 'GitHub API 오류' });
    }
  });

  // 복원 트리거 (2단계 확인)
  app.post('/api/backups/restore', async (request, reply) => {
    const user = getUser(request);
    if (!user?.isAdmin) return reply.status(401).send({ error: '인증 필요' });
    if (!isGitHubConfigured()) return reply.status(503).send({ error: 'GITHUB_TOKEN 미설정' });

    const { artifactName, confirmText } = request.body as {
      artifactName?: string;
      confirmText?: string;
    };

    if (!artifactName) return reply.status(400).send({ error: 'artifactName 필수' });
    if (confirmText !== artifactName) {
      return reply.status(400).send({ error: '확인 텍스트가 일치하지 않습니다.' });
    }

    try {
      const result = await triggerRestore(artifactName);
      if (result.success) {
        logAction({ id: user.id, name: user.name }, 'backup.restore', {
          targetType: 'backup',
          details: { artifactName },
        });
        return { success: true, message: '복원이 시작되었습니다. 현재 DB가 먼저 자동 백업됩니다.' };
      }
      return reply.status(500).send({ error: result.error || '복원 시작 실패' });
    } catch (e) {
      logError({ id: user.id, name: user.name }, 'backup.restore', e);
      return reply.status(500).send({ error: '복원 시작 실패' });
    }
  });
}
