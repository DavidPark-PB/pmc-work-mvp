# Phase 3 PR S — Safety Foundation 계획

> 작성일: 2026-05-10
> 전제: Phase 2 commit `ec2fd4e` (정책 변경) 이 origin/main 에 push 됨 + Railway 배포 완료 + Phase 2 E2E 손검증 (`docs/phase-2-e2e-verification.md`) 통과 후 진입.
> 본 문서는 **구현 전 합의용 계획서** — 실 코드 변경 0건.

---

## 1. 배경 — 왜 필요한가

Phase 2 정책 §1-A 에서 권한 차단 대신 실행자 추적으로 전환했다. 그러나 **현재는 실행자 흔적이 `wms_orders.imported_by` 1 컬럼뿐**이고, 다음이 모두 없다:

- 실패한 import 시도의 흔적 (현재는 200/400/409/500 응답으로 사라짐)
- 변경 전/후 값 비교 (만들기/수정/삭제 모두 동일하게 추적할 표준 위치가 없음)
- 상태 라이프사이클 (pending → succeeded → rolled_back 의 명시적 표현)
- 되돌리기 가능 여부 메타데이터 (이 액션을 되돌릴 수 있는가? 어떻게?)

이 빈자리를 메우는 게 Safety Foundation. 향후 가격변경 / 배송접수 / 라벨생성 / 수동 SKU 보정 등 모든 staff 액션이 동일한 audit 패턴 위에서 동작하도록 한다.

---

## 2. 핵심 결정

### 2-1. 신규 4 테이블 ❌  →  `automation_runs` 1 테이블 확장 ✅

Phase 1 의 [`automation_runs`](../supabase/migrations/038_phase1_sku_master_and_exception.sql#L141-L169) 가 이미 사용자 4 요구사항의 ~60% 를 커버:

| 요구사항 | 기존 컬럼 | 신규 컬럼 |
|---|---|---|
| 1. execution_logs | `triggered_by varchar` (예: `'user:42'`, `'cron'`) | `executed_by_user_id integer → users(id)` (쿼리/FK 용 정형화), `action_name varchar(100)`, `target_table varchar(100)`, `target_id integer` |
| 2. change_snapshots | `input_snapshot jsonb`, `output_snapshot jsonb` | (schema 변경 없음 — 입력=before, 출력=after 의미 명확화 + redact 강제) |
| 3. execution_status | `status varchar(30)` | (varchar 라 enum 추가 불필요 — 허용값 확장: `+pending`, `+cancelled`, `+rollback_required`, `+rolled_back`) |
| 4. rollback_actions | 없음 | `rollback_method varchar(20)`, `rollback_hint text`, `rolled_back_at timestamp`, `rolled_back_by integer → users(id)`, `rollback_run_id integer → automation_runs(id)` (셀프 FK), `rollback_reason text` |

**근거**: cron 자동화와 staff 액션 두 audit 경로를 분리하면 실행자 분석을 두 곳에서 join 해야 한다. 동일 테이블 = 동일 인덱스 = 동일 dashboard.

### 2-2. helper 는 **기록 전담**, 실 undo 동작은 호출자 책임

`safetyExec.rollbackAction()` 는 **새 audit row 를 만들고 원본 row 의 status 를 갱신** 하기만 한다. 실제 undo SQL (예: `DELETE FROM wms_orders WHERE id = N`) 은 호출자 (라우트 / 별 helper) 가 작성한다. 이유:

- 액션마다 undo 절차가 다름 (단순 DELETE / soft delete / 외부 API 취소 호출 / cascade 처리 등) — helper 안에 모든 케이스를 넣으면 비대해진다
- 호출자는 트랜잭션 경계와 권한을 이미 안다 — helper 가 가로챌 이유 없음
- 첫 PR (S) 에서는 **되돌리기 기록만**, 실 undo 실행 UI 는 PR M

### 2-3. 두 단계 (pre / post) 호출 패턴

```js
const run = await safetyExec.runAction({ ... status: 'pending' });   // pre  — strict (실패 시 요청 차단)
try {
  const result = await actuallyDo();
  await safetyExec.updateRun(run.id, { status: 'succeeded', ... });    // post — best-effort (실패 시 로그만)
} catch (e) {
  await safetyExec.updateRun(run.id, { status: 'failed', ... });       // post — best-effort
  throw e;
}
```

이유: pre 단계는 **아직 부작용이 없으므로** 실패 시 요청 차단이 안전. post 단계는 **이미 실 작업이 끝났으므로** audit 실패가 응답을 가로막으면 사용자에게 거짓 정보를 주게 된다 (서버 500 인데 DB 에는 주문이 들어감).

### 2-4. 레거시 admin (`userId=0`) 처리

기존 `triggered_by` 는 `'user:0'` / `'legacy_admin'` 등 varchar 라 호환. 신규 `executed_by_user_id` 는 **`users(id)` 에 FK** 라 id=0 을 넣을 수 없다. 결정:

- `executed_by_user_id` 는 **NULLABLE** — legacy admin 실행 시 NULL
- 호출자 (helper) 가 `req.user.isLegacy === true` 면 자동으로 NULL 매핑
- 동시에 기존 `triggered_by` 컬럼에 `'legacy_admin'` 문자열 기록 (audit 흔적 보존)
- 정책 정합성 — Phase 2 §1-A 가 "실 사용자 id 로 추적" 을 요구하지만 legacy admin 은 [`auth.js:218-238`](../src/middleware/auth.js#L218-L238) 의 `blockLegacyWrites` 가 이미 쓰기를 차단하므로 mock import 는 legacy 로 도달 불가. 안전.

---

## 3. PR 범위 — Option S (Slim)

| 파일 | 변경 | 예상 라인 |
|---|---|---|
| `supabase/migrations/040_safety_foundation.sql` | 신규 | ~70 |
| `src/services/safetyExec.js` | 신규 | ~180 |
| `src/web/routes/mockOrderImport.js` | 수정 (wrap) | +30, -2 |
| `automation/src/db/schema.ts` | 수정 (Drizzle 동기화) | +14 |

**총 4 파일**. 신규 2건 + 수정 2건. UI 0건. 다른 Phase 1 / Phase 2 코드 무수정.

### 명시적 미포함 (다음 PR 로)

- `📜 실행 로그` admin/staff UI — **PR M**
- Phase 1 `createExceptionTask` 의 audit wiring — **PR L**
- 실 undo 실행 (DELETE / API 취소 호출) UI — 액션별 별 PR
- jobs / cron worker 와 automation_runs 통합 — Phase 1 plan 의 "schema only" 약속 유지, 별 PR

---

## 4. 산출물 1 — `supabase/migrations/040_safety_foundation.sql`

### 설계 SQL (제안)

```sql
-- 040_safety_foundation.sql
--
-- Safety Foundation — extend automation_runs to be the canonical execution
-- audit log for ALL user-initiated actions (mock import, future price change,
-- shipping, label, manual SKU link) AND existing automated workflows.
--
-- Strategy: extend (NOT new tables). Phase 1 's automation_runs already
-- covers ~60% of the audit requirement. This migration adds query-able
-- executor / target / rollback metadata.
--
-- Pre-state: 039 applied (wms_orders / wms_order_lines + FK).
-- Post-state: automation_runs has 10 new nullable columns + 4 new indexes.
--             All existing rows (likely 0 — Phase 1 schema only) keep NULLs.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS throughout.

-- ──────────────────────────────────────────────────────────────────────────
-- 1) Extend automation_runs
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE automation_runs
  -- 1a. Query-able executor (denormalized from triggered_by 'user:{id}')
  --     NULLABLE: legacy admin (userId=0) and cron-only runs leave this NULL.
  --     For legacy admin, helper writes 'legacy_admin' to existing triggered_by.
  ADD COLUMN IF NOT EXISTS executed_by_user_id integer
    REFERENCES users(id) ON DELETE SET NULL,

  -- 1b. Specific action name (more granular than automation_type).
  --     Examples: 'mock_order_import', 'price_change', 'shipping_create',
  --               'label_create', 'sku_link_manual', 'rollback'
  ADD COLUMN IF NOT EXISTS action_name varchar(100),

  -- 1c. Target row pointer (table_name + integer id; flexible across tables).
  --     For 'mock_order_import' this is ('wms_orders', N).
  --     For 'rollback' this is the same as the original run's target.
  ADD COLUMN IF NOT EXISTS target_table varchar(100),
  ADD COLUMN IF NOT EXISTS target_id integer,

  -- 1d. Rollback metadata (set at runAction time, BEFORE the action runs)
  --     'auto'         — rollback can be performed by a known SQL/API call
  --     'manual'       — admin must inspect rollback_hint and act manually
  --     'irreversible' — cannot be undone (e.g., external email sent)
  ADD COLUMN IF NOT EXISTS rollback_method varchar(20),
  ADD COLUMN IF NOT EXISTS rollback_hint   text,

  -- 1e. Rollback execution record (set when rollbackAction is called)
  --
  --     rollback_run_id 의미 (단방향 포인터):
  --       - 원본 run row     → 이 컬럼 = 자신을 되돌린 rollback run 의 id
  --       - rollback run row → 이 컬럼 = NULL
  --                            input_snapshot.original_run_id 에 원본 id 저장
  --     즉 "원본 → rollback" 방향만 가리키며, 역방향 추적은 input_snapshot 으로.
  ADD COLUMN IF NOT EXISTS rolled_back_at  timestamp without time zone,
  ADD COLUMN IF NOT EXISTS rolled_back_by  integer
    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rollback_run_id integer
    REFERENCES automation_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rollback_reason text;

-- ──────────────────────────────────────────────────────────────────────────
-- 2) Indexes for canonical query paths
-- ──────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_automation_runs_executed_by
  ON automation_runs(executed_by_user_id);

CREATE INDEX IF NOT EXISTS idx_automation_runs_action_status
  ON automation_runs(action_name, status);

CREATE INDEX IF NOT EXISTS idx_automation_runs_target
  ON automation_runs(target_table, target_id);

-- Partial index — only rows that need attention
CREATE INDEX IF NOT EXISTS idx_automation_runs_rollback_required
  ON automation_runs(action_name) WHERE status = 'rollback_required';

-- ──────────────────────────────────────────────────────────────────────────
-- 3) Status enum extension (varchar — no DB constraint change, doc only)
-- ──────────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN automation_runs.status IS
  'pending | started | succeeded | failed | aborted | cancelled | rollback_required | rolled_back';

COMMENT ON COLUMN automation_runs.action_name IS
  'mock_order_import | price_change | shipping_create | label_create | sku_link_manual | rollback | ...';

COMMENT ON COLUMN automation_runs.rollback_method IS
  'auto | manual | irreversible';
```

### 검증 SQL (post-migration)

```sql
-- 컬럼 존재 확인 (10건)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'automation_runs'
  AND column_name IN (
    'executed_by_user_id','action_name','target_table','target_id',
    'rollback_method','rollback_hint',
    'rolled_back_at','rolled_back_by','rollback_run_id','rollback_reason'
  )
ORDER BY column_name;
-- 기대: 10 행 (FK 는 별도 검증 — executed_by_user_id, rolled_back_by → users(id);
--             rollback_run_id → automation_runs(id) 셀프 FK)

-- 인덱스 존재 확인 (4건)
SELECT indexname FROM pg_indexes WHERE tablename = 'automation_runs'
  AND indexname IN (
    'idx_automation_runs_executed_by',
    'idx_automation_runs_action_status',
    'idx_automation_runs_target',
    'idx_automation_runs_rollback_required'
  );
-- 기대: 4 행

-- 기존 컬럼 무변화 (Phase 1 schema 보존)
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='automation_runs'
  AND column_name IN ('id','job_id','automation_type','triggered_by','status',
                      'input_snapshot','output_snapshot','started_at','completed_at',
                      'error_code','error_message','retry_count','related_sku_id','related_task_id','created_at');
-- 기대: 15 행 (전부 살아있음)
```

---

## 5. 산출물 2 — `src/services/safetyExec.js`

### 공개 API

```js
'use strict';

/**
 * Safety Foundation execution helper.
 *
 * Patterns:
 *   const run = await safetyExec.runAction({ status: 'pending', ... });
 *   try {
 *     const r = await actuallyDo();
 *     await safetyExec.updateRun(run.id, { status: 'succeeded', targetId: r.id, afterSnapshot: {...} });
 *   } catch (e) {
 *     await safetyExec.updateRun(run.id, { status: 'failed', errorMessage: e.message });
 *     throw e;
 *   }
 *
 *   // separate undo path:
 *   await actuallyUndo(targetId);
 *   await safetyExec.rollbackAction({ runId: run.id, executedBy, reason: '...' });
 */

// 허용 status 값 (varchar 라 DB enum 강제 X — 코드 가드만)
const ALLOWED_STATUSES = [
  'pending',          // pre-action insert — strict
  'started',          // (legacy — Phase 1 cron 호환)
  'succeeded',
  'failed',
  'aborted',          // (legacy — Phase 1 cron 호환)
  'cancelled',        // 사용자 취소 또는 무해한 거부 (예: 409 duplicate)
  'rollback_required',
  'rolled_back',
];

const ALLOWED_ROLLBACK_METHODS = ['auto', 'manual', 'irreversible'];

/**
 * pre-action audit row 생성. 실제 작업 전에 호출.
 * 실패 시 throw → 라우트가 500 응답하도록 (strict mode).
 *
 * @returns {Promise<{id:number, status:'pending'}>}
 */
async function runAction({
  actionName,        // required — 'mock_order_import' 등
  executedBy,        // required — req.user.id (legacy admin → null 자동 변환)
  isLegacyExecutor,  // optional — req.user.isLegacy
  targetTable,       // optional — null 가능 (post 에 알 수 있음)
  targetId,          // optional — null 가능
  beforeSnapshot,    // optional jsonb (CREATE 액션은 null)
  rollbackMethod,    // optional — 'auto' | 'manual' | 'irreversible' | null
  rollbackHint,      // optional text
  relatedTaskId,     // optional — team_tasks(id)
  relatedSkuId,      // optional — sku_master(id)
  status = 'pending',
}) { /* ... */ }

/**
 * post-action 갱신. 실패해도 throw 하지 않음 (best-effort).
 * 응답을 가로막아 거짓 정보를 주지 않기 위함.
 *
 * @returns {Promise<void>}
 */
async function updateRun(runId, {
  status,            // 'succeeded' | 'failed' | 'cancelled' | 'rollback_required'
  targetId,          // post 에 알게 된 경우
  targetTable,       // 거의 안 씀 (pre 에 결정)
  afterSnapshot,     // jsonb — redact 통과 후 저장 (helper 내부에서 redact 호출)
  errorCode,
  errorMessage,
}) { /* ... */ }

/**
 * 되돌리기 audit row 생성 + 원본 갱신. 실 undo 동작은 caller 책임.
 *
 * rollback_run_id 의미 (단방향 포인터):
 *   - 원본 run row     → rollback_run_id = 새 rollback run 의 id
 *   - rollback run row → rollback_run_id = NULL
 *                        역방향 (rollback → 원본) 추적은
 *                        input_snapshot.original_run_id 로.
 *
 * 동작:
 *   1. 원본 run 로드 — id 검증, rollback_method='irreversible' 면 throw
 *   2. 새 automation_runs row 삽입 (= rollback run):
 *      - action_name      = 'rollback'
 *      - target_table/id  = 원본과 동일
 *      - input_snapshot   = { original_run_id: <원본.id>, original_after: <원본.output_snapshot> }
 *      - status           = 'succeeded'
 *      - rollback_run_id  = NULL  (자신은 rollback 의 결과물이므로 비워둠)
 *      - executed_by_user_id = executedBy
 *   3. 원본 run 갱신:
 *      - status           = 'rolled_back'
 *      - rolled_back_at   = now()
 *      - rolled_back_by   = executedBy
 *      - rollback_run_id  = (방금 만든 새 rollback row.id)
 *      - rollback_reason  = reason
 *
 * @returns {Promise<{rollbackRunId:number}>}
 */
async function rollbackAction({ runId, executedBy, reason }) { /* ... */ }

/**
 * 조회 (PR S 에서는 사용처 없음 — PR M 의 UI 가 호출. 함수 시그니처만 정의).
 */
async function listRuns({ executedBy, actionName, status, targetTable, targetId, limit = 100, offset = 0 }) { /* ... */ }

module.exports = {
  ALLOWED_STATUSES,
  ALLOWED_ROLLBACK_METHODS,
  runAction,
  updateRun,
  rollbackAction,
  listRuns,
};
```

### 내부 룰

- **redact 강제** — `beforeSnapshot` / `afterSnapshot` 은 [`src/lib/redact.js`](../src/lib/redact.js) 통과 후 저장. helper 가 caller 가 잊지 않도록 자동 적용.
- **legacy admin 매핑** — `isLegacyExecutor === true` 면 `executed_by_user_id = null` 로 기록. 동시에 기존 `triggered_by` 컬럼에 `'legacy_admin'` 문자열 입력.
- **status 검증** — `ALLOWED_STATUSES` 에 없으면 throw (`safetyExec/invalid_status`).
- **rollback_method 검증** — null 또는 `ALLOWED_ROLLBACK_METHODS` 중 하나가 아니면 throw.
- **DB 호출 실패 정책** — `runAction` (pre) 은 throw, `updateRun` (post) 은 `console.error` 로그 후 silent return.
- **로그 출력 룰 (PII / secret 방지)** — helper 내부 `console.error` 는 **`actionName` / `executedBy` / `error.message`** 만 출력. 절대 출력 금지: `payload` 원본, `beforeSnapshot` / `afterSnapshot`, `input_snapshot` / `output_snapshot`, `raw_payload`, `req.body`, token / API key / secret 류. (예: `console.error('[safetyExec] runAction failed:', { actionName, executedBy, message: e.message });` 형태로 객체 분해 금지.)

---

## 6. 산출물 3 — `src/web/routes/mockOrderImport.js` 수정

### 변경 형태 (diff 개념)

```js
const safetyExec = require('../../services/safetyExec');

router.post('/', async (req, res) => {
  const createdBy = req.user?.id;
  if (!Number.isFinite(createdBy)) {
    return res.status(401).json({ error: '인증된 사용자가 아닙니다 (req.user.id 부재)' });
  }

  // ── pre-action audit (strict — 실패 시 500) ──
  let run;
  try {
    run = await safetyExec.runAction({
      actionName: 'mock_order_import',
      executedBy: createdBy,
      isLegacyExecutor: req.user?.isLegacy === true,
      targetTable: 'wms_orders',
      targetId: null,             // post 에 채움
      beforeSnapshot: null,       // CREATE — before 없음
      rollbackMethod: 'manual',
      rollbackHint:
        'DELETE FROM wms_order_lines WHERE order_id = <target_id>; ' +
        'DELETE FROM wms_orders WHERE id = <target_id>; ' +
        '-- 부수효과로 생성된 SKU_MATCH_FAILED auto cards 도 함께 close 검토.',
      status: 'pending',
    });
  } catch (auditErr) {
    // 로그 룰: actionName / executedBy / error.message 만. payload / req.body / secret 금지.
    console.error('[mockOrderImport] safetyExec.runAction failed:', {
      actionName: 'mock_order_import',
      executedBy: createdBy,
      message:    auditErr.message,
    });
    return res.status(500).json({ error: 'audit 시스템 일시 장애 — 잠시 후 재시도' });
  }

  // ── 실 작업 ──
  try {
    const result = await orderImporter.importMockOrder(req.body || {}, { createdBy });

    // post-action audit (best-effort)
    safetyExec.updateRun(run.id, {
      status: 'succeeded',
      targetId: result.order.id,
      afterSnapshot: {
        id:                result.order.id,
        marketplace:       result.order.marketplace,
        external_order_id: result.order.external_order_id,
        line_count:        result.totals.line_count,
        matched_count:     result.totals.matched_count,
        failed_count:      result.totals.failed_count,
        cards_created:     result.totals.cards_created,
        capped_line_count: result.totals.capped_line_count,
      },
    }).catch(() => {});  // best-effort

    return res.status(201).json({ /* 기존 응답 그대로 */ });
  } catch (e) {
    if (e instanceof orderImporter.ValidationError) {
      safetyExec.updateRun(run.id, {
        status: 'failed', errorCode: 'validation', errorMessage: e.message,
      }).catch(() => {});
      return res.status(400).json({ error: e.message });
    }
    if (e instanceof wmsRepo.DuplicateOrderError) {
      // 중복 = 사용자 의도 외 거부. 부수효과 없음 → 'cancelled' (failed 아님)
      safetyExec.updateRun(run.id, {
        status: 'cancelled', errorCode: 'duplicate', errorMessage: e.message,
        targetId: e.existing?.id ?? null,
      }).catch(() => {});
      return res.status(409).json({ error: e.message, code: 'DUPLICATE_ORDER', existing_order_id: e.existing?.id ?? null });
    }
    safetyExec.updateRun(run.id, {
      status: 'failed', errorCode: 'unknown', errorMessage: e.message,
    }).catch(() => {});
    console.error('[mockOrderImport] unexpected error:', e.message);
    return res.status(500).json({ error: 'mock import 처리 중 오류' });
  }
});
```

### 핵심 약속

- 응답 포맷 (201/400/409/500) 무변화 — UI / 검증 가이드 영향 0
- `wms_orders.imported_by` 도 그대로 — 비정규화 편의 컬럼 (목록 화면에서 빠른 표시 용도)
- 실패 케이스도 audit row 가 생김 — 향후 `📜 실행 로그` 에서 "왜 거부됐는지" 분석 가능
- **서버 로그 출력 룰** — audit 실패 시 `actionName` / `executedBy` / `error.message` 만 기록. `payload`, `req.body`, `raw_payload`, token / API key / secret 류는 절대 로그 출력 금지 (helper 와 라우트 양쪽 동일 룰)

---

## 7. 산출물 4 — `automation/src/db/schema.ts` Drizzle 동기화

Phase 1 PR 5 (`1fcea9b`) 와 동일 패턴. `automationRuns` typed 정의에 10 컬럼 추가.

```ts
export const automationRuns = pgTable('automation_runs', {
  // ... 기존 14 컬럼 (Phase 1) ...

  // Phase 3 — Safety Foundation
  executedByUserId: integer('executed_by_user_id'),    // FK users(id) — Drizzle 에선 plain int (sub-app schema 외부 참조)
  actionName:       varchar('action_name', { length: 100 }),
  targetTable:      varchar('target_table', { length: 100 }),
  targetId:         integer('target_id'),
  rollbackMethod:   varchar('rollback_method', { length: 20 }),
  rollbackHint:     text('rollback_hint'),
  rolledBackAt:     timestamp('rolled_back_at'),
  rolledBackBy:     integer('rolled_back_by'),
  rollbackRunId:    integer('rollback_run_id'),
  rollbackReason:   text('rollback_reason'),
}, (t) => ({
  // 기존 + 신규 인덱스 정의
}));
```

룰: Phase 1 PR 5 와 같이 **typed 컬럼만 mirror**, FK 는 sub-app schema 밖 테이블 (`users`, `sku_master`, `team_tasks`) 참조 시 plain integer 로 둠.

---

## 8. 검증 시나리오 (PR S 통과 기준)

별 문서 `docs/phase-3-safety-foundation-verification.md` 로 PR 직후 작성 예정. 본 plan 에서는 시나리오 골자만:

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 1 | migration 040 idempotent | 두 번 실행 → 두 번째도 성공, 컬럼 / 인덱스 중복 생성 0 |
| 2 | 새 컬럼 10건 + 인덱스 4건 존재 | §4 의 검증 SQL 통과 |
| 3 | mock import 성공 → audit row 1건, status `pending → succeeded` | `SELECT id, action_name, executed_by_user_id, target_table, target_id, status FROM automation_runs ORDER BY id DESC LIMIT 1;` 가 `mock_order_import / <staff id> / wms_orders / <order id> / succeeded` |
| 4 | mock import 실패 (잘못된 JSON) → audit row 1건, status `failed` + errorMessage | 동일 SELECT, status=`failed` |
| 5 | mock import 중복 (409) → audit row 1건, status `cancelled` (failed 아님) | 동일 SELECT, status=`cancelled`, error_code=`duplicate` |
| 6 | redact 작동 | mock JSON 의 `raw_payload.ebay_internal_token` 이 audit `output_snapshot` 에 원본 미노출. **추가**: Railway 서버 로그에 `payload` / `raw_payload` / token 문자열 0건 (audit 실패 시뮬레이션 로그도 `actionName` / `executedBy` / `message` 만 보임) |
| 7 | rollback 시 새 row + 원본 갱신 | (수동 SQL 또는 임시 테스트 라우트) `safetyExec.rollbackAction` 호출 → 새 row action_name=`rollback`, 원본 status=`rolled_back`, rollback_run_id 셀프 FK |
| 8 | legacy admin (userId=0) 으로 실행 차단 | `blockLegacyWrites` 가 mock-import POST 를 400 으로 거부 → audit row 0 건 (pre-runAction 이 아예 도달 못 함) |
| 9 | 응답 포맷 무변화 | Phase 2 검증 시나리오 B (201), E (409), F (PII redact) 재실행 → 응답 JSON shape 동일 |
| 10 | 기존 코드 무영향 | `git diff main..HEAD -- src/` 가 `mockOrderImport.js` + `services/safetyExec.js` (신규) + `migrations/040_*.sql` (신규) + `automation/src/db/schema.ts` 4건만 |

---

## 9. 위험 / 트레이드오프

| 위험 | 영향 | 완화 |
|---|---|---|
| `executed_by_user_id` FK 위반 (legacy admin id=0) | INSERT 실패 | helper 가 `isLegacyExecutor=true` → null 자동 매핑. 실 운영에서는 `blockLegacyWrites` 가 먼저 차단 |
| audit row 가 본 작업의 latency 증가 | mock import 가 +1 INSERT (~5ms) | admin/staff 트리거 액션 → hot path 아님. acceptable |
| post-update 누락 시 `pending` 영구 잔존 | 통계 왜곡 | PR M 에서 `pending` 30분+ → `aborted` 자동 마킹 cron 추가 (현 PR 범위 밖, 문서화만) |
| `rollback_method='manual'` 으로 모두 표기 → 자동 undo 부재 | UI 에서 되돌리기 버튼이 hint 만 보여줌 | PR S 의 의도 — 첫 PR 은 메타데이터 도입, 실 undo 는 PR M+ |
| Drizzle sync 누락 | sub-app worker 가 신규 컬럼 모름 | PR S 가 동시 sync — Phase 1 PR 5 와 같은 commit 단위 |
| 동시 mock import 두 건 → audit row 두 건 | 정상 동작 (각 요청 독립) | 의도된 동작. dedupe 는 비즈니스 레벨 (DUPLICATE_ORDER 409) 가 처리 |

---

## 10. PR S 의 외부 무수정 약속 (Phase 1 / Phase 2 보호)

| 영역 | 무수정 |
|---|---|
| `supabase/migrations/037_*.sql` ~ `039_*.sql` | ✅ |
| `src/services/orderImporter.js` / `skuMatcher.js` | ✅ |
| `src/db/wmsOrderRepository.js` | ✅ |
| `src/services/exceptionTask.js` (Phase 1) | ✅ — PR L 로 미룸 |
| `src/db/teamTaskRepository.js` | ✅ |
| `src/web/routes/api.js` | ✅ — 151 endpoints 격리 유지 |
| `src/web/routes/orders.js` (Phase 2 GET) | ✅ — 조회는 audit 대상 아님 (변경 부재) |
| `public/` 모든 JS / HTML | ✅ — UI 0건 |
| `package.json` / `automation/package.json` | ✅ |

`mockOrderImport.js` 만 wrap 추가. 그 외는 Drizzle 1 파일 + 신규 2 파일.

---

## 11. PR S 수용 기준 (사장님 체크리스트)

- [ ] §3 의 4 파일 외 변경 0건 — `git diff --stat` 확인
- [ ] §4 의 040 SQL 이 Supabase 에서 idempotent 통과
- [ ] §8 의 시나리오 1~10 전부 통과
- [ ] Phase 2 검증 가이드 §11 (staff 접근) 회귀 통과 — 응답 포맷 무변화
- [ ] 신규 코드의 secret/PII 누설 0건 (§8 시나리오 6)
- [ ] Drizzle schema (sub-app) 와 SQL (메인) 컬럼 정의 1:1 일치

---

## 12. 후속 PR 로드맵 (참고 — 본 PR 미포함)

| PR | 범위 | 의존 |
|---|---|---|
| **PR M (Medium)** | `📜 실행 로그` admin/staff UI (read-only 목록 + 상세 + 되돌리기 버튼 stub) — `safetyExec.listRuns` 사용 | PR S 통과 |
| **PR L (Large)** | Phase 1 `createExceptionTask` audit wiring (자동 카드 생성도 audit row 남김) | PR M 통과 |
| **PR auto-undo** | mock import 의 자동 undo 라우트 (`POST /api/orders/:id/rollback` — wms_orders + lines DELETE + 자동 카드 close) | PR M 의 UI 완성 후 |
| **PR pending-sweeper** | 30분+ pending → aborted 자동 마킹 cron | PR M 통과 |
| **PR price-change-foundation** | 가격변경 라우트 + safetyExec 통합. before=현재가, after=새가, rollback_method='auto' | PR S + PR M 통과 |

---

## 본 문서 메타

- 작성: 2026-05-10
- 작성자: Claude (현 세션)
- 목적: PR S 구현 전 합의용 계획서
- 코드 변경: 0건 (본 문서가 유일 산출물)
- 다음 작업: 사장님 검토 → 승인 시 PR S 구현 진입
