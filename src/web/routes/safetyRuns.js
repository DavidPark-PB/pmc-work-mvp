/**
 * src/web/routes/safetyRuns.js — Safety Foundation execution log read API (Phase 3 PR M)
 *
 * 라우트:
 *   GET /api/safety-runs            목록 (filter + pagination)
 *   GET /api/safety-runs/:id        단건 + rollback chain 1단계
 *
 * 권한: 로그인한 모든 사용자 (admin / staff). 정책 §1-A + PR M §2-2 X.
 *   - staff 도 전체 audit 조회 가능 — 권한 차단보다 추적 우선
 *
 * 출력 안전 룰:
 *   - input_snapshot / output_snapshot 은 PR S 단계에서 redact.js 통과한 상태 — 그대로 전송
 *   - error_message 도 그대로 전송 (orderImporter / wmsRepo 가 토큰을 메시지에 안 넣음)
 *   - executor / rolled_back_executor 는 users.display_name 만 (password_hash 등 일체 미노출)
 *
 * 무수정 약속 (PR M):
 *   - safety helper (write helper) — 본 PR 에서 수정 0
 *   - automation_runs schema (040) — 본 PR 에서 변경 0
 *   - rollbackAction 호출 0 — 되돌리기 stub UI 는 modal 만, 실 호출 X
 *   - POST 라우트 0 — GET 만
 *
 * total count 정책 (보강 1):
 *   - { count: 'exact' } 가 성공하면 그 값 사용
 *   - count 가 비싸거나 실패하면 total=null 로 fallback (라우트는 200 유지)
 *
 * users join (보강 2):
 *   - automation_runs 에 users(id) FK 가 2개 (executed_by_user_id, rolled_back_by) 라
 *     Supabase 의 단순 users(id, display_name) 은 ambiguous reference 로 실패.
 *   - Step 0 의 pg_constraint SQL 로 검증된 실 constraint 이름 사용:
 *       automation_runs_executed_by_user_id_fkey
 *       automation_runs_rolled_back_by_fkey
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const supabaseClient = require('../../db/supabaseClient');

const router = express.Router();

router.use(requireAuth);

const TABLE = 'automation_runs';

// 보강 2 — explicit FK constraint name 사용 (Step 0 SQL 로 정확성 검증됨)
const SELECT_COLUMNS = `
  id, action_name, automation_type, status,
  executed_by_user_id, triggered_by,
  target_table, target_id,
  rollback_method, rollback_hint,
  rolled_back_at, rolled_back_by, rollback_run_id, rollback_reason,
  error_code, error_message,
  input_snapshot, output_snapshot,
  started_at, completed_at, created_at,
  executor:users!automation_runs_executed_by_user_id_fkey ( id, display_name ),
  rolled_back_executor:users!automation_runs_rolled_back_by_fkey ( id, display_name )
`;

// rollback chain 의 1단계 보강 select — 응답 비대화 방지 위해 압축형
const SELECT_COLUMNS_BRIEF = `
  id, action_name, status,
  started_at, completed_at,
  input_snapshot,
  executor:users!automation_runs_executed_by_user_id_fkey ( id, display_name )
`;

// ──────────────────────────────────────────────────────────────────────────
// GET /api/safety-runs — 목록 + filter + pagination
// ──────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const actionName  = (req.query.action_name  || '').toString().trim() || null;
    const status      = (req.query.status       || '').toString().trim() || null;
    const targetTable = (req.query.target_table || '').toString().trim() || null;
    const executedBy  = parseInt(req.query.executed_by, 10);
    const targetId    = parseInt(req.query.target_id,   10);
    const limit       = Math.min(200, Math.max(1, Number(req.query.limit)  || 50));
    const offset      = Math.max(0, Number(req.query.offset) || 0);

    const supabase = supabaseClient.getClient();
    let q = supabase.from(TABLE)
      .select(SELECT_COLUMNS, { count: 'exact' })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (actionName)               q = q.eq('action_name',         actionName);
    if (status)                   q = q.eq('status',              status);
    if (Number.isFinite(executedBy)) q = q.eq('executed_by_user_id', executedBy);
    if (targetTable)              q = q.eq('target_table',        targetTable);
    if (Number.isFinite(targetId))   q = q.eq('target_id',          targetId);

    const { data, count, error } = await q;
    if (error) {
      console.error('[safetyRuns] list error:', error.message);
      return res.status(500).json({ error: '실행 로그 조회 실패' });
    }

    res.json({
      data:   data || [],
      total:  typeof count === 'number' ? count : null,  // 보강 1
      limit,
      offset,
    });
  } catch (e) {
    console.error('[safetyRuns] list unexpected:', e.message);
    res.status(500).json({ error: '실행 로그 조회 실패' });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/safety-runs/:id — 단건 + rollback chain 1단계
// ──────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const supabase = supabaseClient.getClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[safetyRuns] detail error:', error.message);
      return res.status(500).json({ error: '실행 로그 조회 실패' });
    }
    if (!data) return res.status(404).json({ error: 'not found' });

    // rollback chain 1단계 보강 — 단방향 포인터 (PR S plan §2-2)
    let rollbackRun = null;
    let originalRun = null;

    if (Number.isFinite(data.rollback_run_id)) {
      // 원본 row → 자신을 되돌린 rollback row 조회
      const { data: r } = await supabase
        .from(TABLE)
        .select(SELECT_COLUMNS_BRIEF)
        .eq('id', data.rollback_run_id)
        .maybeSingle();
      rollbackRun = r || null;
    }

    if (data.action_name === 'rollback') {
      // rollback row → input_snapshot.original_run_id 로 원본 조회
      const originalId = data.input_snapshot?.original_run_id;
      if (Number.isFinite(originalId)) {
        const { data: o } = await supabase
          .from(TABLE)
          .select(SELECT_COLUMNS_BRIEF)
          .eq('id', originalId)
          .maybeSingle();
        originalRun = o || null;
      }
    }

    res.json({
      data: {
        ...data,
        rollback_run: rollbackRun,
        original_run: originalRun,
      },
    });
  } catch (e) {
    console.error('[safetyRuns] detail unexpected:', e.message);
    res.status(500).json({ error: '실행 로그 조회 실패' });
  }
});

module.exports = router;
