/**
 * 정기결제 관리 (/api/recurring) — 재무 권한자 전용.
 * 정기결제 CRUD + 수동 발행(run-now) 엔드포인트.
 */
const express = require('express');
const repo = require('../../db/recurringRepository');
const expenseRepo = require('../../db/expenseRepository');

const router = express.Router();

function requireFinance(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (!req.user.canManageFinance) return res.status(403).json({ error: '재무 권한이 필요합니다' });
  next();
}

router.use(requireFinance);

router.get('/', async (req, res) => {
  try {
    const data = await repo.list({ activeOnly: req.query.active === 'true' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await repo.getById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: '정기결제를 찾을 수 없습니다' });
    res.json({ data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const created = await repo.create({ ...req.body, createdBy: req.user.id });
    res.json({ data: created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await repo.update(parseInt(req.params.id, 10), req.body || {});
    res.json({ data: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await repo.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recurring/:id/run — 해당 정기결제 1건을 지금 즉시 expense로 발행 + 다음 일자 전진.
//
//   R1-D1-A (2026-09-05) · fire() 는 per-rule 분산 락으로 보호됨. SKIP_LOCKED
//     (다른 인스턴스가 이미 발행 중) 는 HTTP 500 이 아니라 200 응답으로 처리 ·
//     응답 payload 에 `emitted: false, skipped: true` 로 진짜 상태 노출.
//     admin frontend 는 현재 res.ok 만 체크하므로 알림 없이 지나가지만 실제
//     expense 는 중복 생성되지 않음. Lease infra 오류만 503.
router.post('/:id/run', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await repo.getById(id);
    if (!r) return res.status(404).json({ error: '정기결제를 찾을 수 없습니다' });
    const result = await repo.fire(r, { expenseRepo });
    if (result && result.skipped) {
      if (result.skipReason === 'lease_error') {
        //   lease 인프라 오류 · 무성공 · admin 재시도 가능
        return res.status(503).json({
          ok: false,
          emitted: false,
          skipped: true,
          skipReason: 'lease_error',
          error: 'lease_unavailable',
          message: '분산 락 인프라 오류 · 잠시 후 재시도하세요',
        });
      }
      if (result.skipReason === 'stale_occurrence') {
        //   R1-D1-B · schedule 이 다른 인스턴스/run 에 의해 이미 앞당겨진 상태 ·
        //   재시도해도 새 expense 안 생김 · 정상 skip
        return res.json({
          ok: true,
          emitted: false,
          skipped: true,
          skipReason: 'stale_occurrence',
          recurringId: r.id,
          nextDueAt: result.nextDueAt,
          message: '스케줄이 이미 다음 회차로 진행됨 · 재시도 필요 없음',
        });
      }
      //   정상 contention · HTTP 200 · 실제 발행 안 됨
      return res.json({
        ok: true,
        emitted: false,
        skipped: true,
        skipReason: 'locked',
        recurringId: r.id,
        message: '다른 인스턴스가 이미 발행 중입니다 · 잠시 후 재시도하세요',
      });
    }
    if (result && result.recovered === true) {
      //   R1-D1-B · crash-replay recovery · 기존 회차 발견 · 스케줄만 복구 ·
      //   새 expense 생성 X · emitted=false + recovered=true 로 진실 노출
      return res.json({
        ok: true,
        emitted: false,
        recovered: true,
        alreadyExists: true,
        expense: result.expense,
        nextDueAt: result.nextDueAt,
        message: '기존 회차가 발견되어 스케줄만 복구되었습니다 · 중복 발행 없음',
      });
    }
    //   기존 legacy shape 유지: expense · nextDueAt 필드
    res.json({
      ok: true,
      emitted: true,
      expense: result.expense,
      nextDueAt: result.nextDueAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/recurring/fire-due — 도래한 모든 정기결제 즉시 발행 (테스트/수동 트리거용)
//
//   R1-D1-A (2026-09-05) · fired/skipped/leaseErrored/failed 를 정확히 구분.
//     기존 응답 필드 `fired` 는 실 발행 만 · SKIP_LOCKED 는 `skipped` 로 · lease
//     infra 오류는 `leaseErrored` 로 · fire() body throw 는 `failed` 로.
//     추가 필드는 additive · 기존 client 는 `fired` 만 봐도 정확한 값 받음.
router.post('/fire-due', async (req, res) => {
  try {
    const due = await repo.listDue();
    //   R1-D1-B · recovered (RPC ALREADY_EXISTS · crash-replay 복구) 와
    //     stale (RPC STALE_OCCURRENCE · 이미 다음 회차) 를 별도 카운트 ·
    //     fired 는 실 새 expense INSERT 만 · 진실 유지.
    let fired = 0, recovered = 0, skipped = 0, leaseErrored = 0, stale = 0, failed = 0;
    for (const r of due) {
      try {
        const result = await repo.fire(r, { expenseRepo });
        const bucket = repo.classifyFireResult(result);
        if (bucket === 'fired')          fired++;
        else if (bucket === 'recovered') recovered++;
        else if (bucket === 'skipped_locked') skipped++;
        else if (bucket === 'skipped_error')  leaseErrored++;
        else if (bucket === 'stale')     stale++;
        else                             failed++;
      } catch (e) {
        failed++;
        console.warn(`[recurring] fire fail id=${r.id}:`, e.message);
      }
    }
    res.json({ ok: true, due: due.length, fired, recovered, skipped, leaseErrored, stale, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
