# Phase 3 PR S — Safety Foundation 구현 프롬프트

> 작성일: 2026-05-10
> 본 문서는 **별 Claude 세션 (또는 본 세션 후속 턴) 에서 그대로 입력하면 PR S 구현이 시작되도록** 만든 self-contained 지시서.
> 합의된 plan: [`docs/phase-3-safety-foundation-plan.md`](phase-3-safety-foundation-plan.md) (528+ 라인). 본 프롬프트는 그 plan 의 §3~§7 을 코드로 옮기는 작업.

---

## 사전 컨텍스트 (세션 시작 시 한 번만 주입)

당신은 `/Users/parksungmin/pmc-work-mvp` (Express.js + Supabase, K-POP/포켓몬 cross-border 셀러 운영 시스템) 의 Phase 3 PR S — Safety Foundation 을 구현한다.

### 직전 상태 검증

먼저 다음 3 가지를 확인하고 시작:

1. `git log --oneline -3` — 최상단이 `ec2fd4e policy(wms-phase2): allow staff access` 이어야 함
2. `git status --short` — `M` 표시 0건이어야 함 (working tree clean. untracked `automation.bak/`, `public/images/template main.png` 는 무관)
3. [`docs/phase-3-safety-foundation-plan.md`](phase-3-safety-foundation-plan.md) 가 존재 — 이 plan 의 §3~§7 을 코드로 변환하는 게 본 PR

직전 상태가 다르면 **작업 중단** 하고 사장님에게 보고. 합의 외 변경 금지.

### Phase 2 검증 통과 가정

본 PR 은 plan §1 의 전제대로 Phase 2 E2E 손검증 (`docs/phase-2-e2e-verification.md`) 통과 후 진입한다는 가정. 사장님이 명시적으로 "Phase 2 검증 통과 했다 / 보류하고 PR S 먼저 진행하라" 둘 중 하나를 알리지 않았으면 사장님에게 확인부터.

---

## 구현 범위 — 4 파일 (plan §3 그대로)

| # | 파일 | 작업 | 라인 (예상) |
|---|---|---|---|
| 1 | `supabase/migrations/040_safety_foundation.sql` | 신규 — automation_runs 10 컬럼 + 4 인덱스 추가 | ~70 |
| 2 | `src/services/safetyExec.js` | 신규 — `runAction` / `updateRun` / `rollbackAction` / `listRuns` helper | ~180 |
| 3 | `src/web/routes/mockOrderImport.js` | 수정 — pre/post audit wrap | +30, -2 |
| 4 | `automation/src/db/schema.ts` | 수정 — Drizzle 동기화 (10 컬럼) | +14 |

**그 외 파일 무수정.** plan §10 의 무수정 약속 표를 commit 전 `git diff --stat` 으로 검증.

---

## 구현 순서 (반드시 이 순서로)

### Step 1 — `supabase/migrations/040_safety_foundation.sql` 신규

plan §4 의 SQL 을 그대로 사용. 핵심:

- `ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS ...` × 10
- `CREATE INDEX IF NOT EXISTS ...` × 4 (1개는 partial index — `WHERE status = 'rollback_required'`)
- `COMMENT ON COLUMN ...` × 3 (status / action_name / rollback_method)
- 모두 idempotent — 두 번 실행해도 안전

**주의**:
- `executed_by_user_id` / `rolled_back_by` → `users(id) ON DELETE SET NULL`
- `rollback_run_id` → `automation_runs(id) ON DELETE SET NULL` (셀프 FK)
- timestamp 타입은 기존 automation_runs 와 동일하게 `timestamp without time zone` (Phase 1 컨벤션 유지)

### Step 2 — `src/services/safetyExec.js` 신규

plan §5 의 공개 API + 내부 룰 그대로 구현. 4 함수:

#### 2-A. `runAction({ ... status: 'pending' })` — pre-action, strict
- Supabase client (`src/db/supabase.js`) 으로 `automation_runs` INSERT
- legacy admin 매핑: `isLegacyExecutor === true` → `executed_by_user_id = null`, `triggered_by = 'legacy_admin'`. 일반 사용자 → `triggered_by = 'user:' + executedBy`
- `beforeSnapshot` 은 [`src/lib/redact.js`](../src/lib/redact.js) 통과 → `input_snapshot` 컬럼에 저장
- status 검증 (ALLOWED_STATUSES 외 throw `'safetyExec/invalid_status'`)
- rollback_method 검증 (null 또는 ALLOWED_ROLLBACK_METHODS 외 throw)
- **반환**: `{ id: <inserted row id>, status: 'pending' }`
- 실패 시 throw — caller (라우트) 가 500 응답하도록

#### 2-B. `updateRun(runId, { status, targetId, afterSnapshot, errorCode, errorMessage })` — post-action, best-effort
- `automation_runs` UPDATE (id = runId)
- `afterSnapshot` redact → `output_snapshot`
- `completed_at = now()` 자동 채움 (status 가 pending/started 이외로 전환될 때)
- status 검증 (위와 동일)
- 실패 시 `console.error` 로그만 (caller 응답 가로막지 않음)
- **로그 룰** — actionName / executedBy / message 만. `req.body`, payload 원본, snapshot 내용 로그 출력 금지

#### 2-C. `rollbackAction({ runId, executedBy, reason })`
- 원본 run 로드 (id 검증, 없으면 throw `'safetyExec/run_not_found'`)
- `rollback_method === 'irreversible'` 면 throw `'safetyExec/irreversible'`
- 새 row 삽입 (rollback run):
  - `action_name = 'rollback'`
  - `target_table` / `target_id` = 원본과 동일
  - `input_snapshot = { original_run_id: <원본.id>, original_after: <원본.output_snapshot> }`
  - `status = 'succeeded'`
  - `rollback_run_id = NULL` ← **plan 의 단방향 포인터 정책**
  - `executed_by_user_id = executedBy`
  - `triggered_by = 'user:' + executedBy` (또는 legacy 매핑)
- 원본 run UPDATE:
  - `status = 'rolled_back'`
  - `rolled_back_at = now()`
  - `rolled_back_by = executedBy`
  - `rollback_run_id = <새 rollback row.id>` ← **여기에만 채움**
  - `rollback_reason = reason`
- **반환**: `{ rollbackRunId: <새 row.id> }`

#### 2-D. `listRuns({ executedBy, actionName, status, targetTable, targetId, limit, offset })`
- PR S 에서 사용처 없음 — 함수 시그니처만 정의 + 빈 구현 (Supabase SELECT 기본형)
- PR M 의 UI 가 호출 예정

#### 2-E. exports
```js
module.exports = {
  ALLOWED_STATUSES, ALLOWED_ROLLBACK_METHODS,
  runAction, updateRun, rollbackAction, listRuns,
};
```

### Step 3 — `src/web/routes/mockOrderImport.js` 수정

plan §6 의 변경 형태 그대로. 핵심:

- `const safetyExec = require('../../services/safetyExec');` 추가
- 기존 `try { ... } catch` 블록 안의 `orderImporter.importMockOrder(...)` 호출을 pre-audit + post-audit 로 감쌈
- 응답 JSON shape 무변화 (201/400/409/500 의 `error`, `code`, `existing_order_id`, `order_id`, `totals`, `lines` 모두 그대로)
- pre-audit 실패 시 500 (`'audit 시스템 일시 장애 — 잠시 후 재시도'`)
- 4 종 응답 분기 각각의 status 매핑:
  - 201 → `status: 'succeeded'` + afterSnapshot
  - 400 (ValidationError) → `status: 'failed'`, `errorCode: 'validation'`
  - 409 (DuplicateOrderError) → `status: 'cancelled'` (failed 아님), `errorCode: 'duplicate'`, `targetId: e.existing?.id`
  - 500 (unknown) → `status: 'failed'`, `errorCode: 'unknown'`
- `rollbackHint` SQL 의 FK 컬럼명 `wms_order_lines.order_id` (NOT `wms_order_id` — plan 보정 3 적용)
- 헤더 주석 보강: 권한 = 로그인만 (Phase 2 정책 §1-A) + audit = safetyExec.runAction (PR S 정책)

### Step 4 — `automation/src/db/schema.ts` 수정

plan §7 의 패턴. `automationRuns` typed 정의에 10 컬럼 추가. 인덱스 4개도 mirror (가능한 범위에서 — Drizzle 의 partial index 지원 한계 시 일반 index 로 두고 plan §7 룰대로 주석으로 차이 명시).

FK 는 plan 룰대로 plain integer (sub-app schema 외부 참조).

---

## 구현 후 자체 검증 (commit 전)

다음 7가지를 실행 + 각 결과를 사장님에게 보고:

```bash
# 1. 변경 파일 정확히 4건인지
git status --short
# 기대: M src/web/routes/mockOrderImport.js
#       M automation/src/db/schema.ts
#       ?? supabase/migrations/040_safety_foundation.sql
#       ?? src/services/safetyExec.js
#       (+ 무관한 untracked: automation.bak/, public/images/template main.png)

# 2. 라인 수 plan 예상과 정합
git diff --stat
wc -l supabase/migrations/040_safety_foundation.sql src/services/safetyExec.js

# 3. 무수정 약속 검증 (모두 빈 출력)
git diff -- supabase/migrations/037_orders_fedex_label.sql
git diff -- supabase/migrations/038_phase1_sku_master_and_exception.sql
git diff -- supabase/migrations/039_phase2_orders.sql
git diff -- src/web/routes/api.js
git diff -- src/web/routes/orders.js
git diff -- src/services/orderImporter.js src/services/skuMatcher.js
git diff -- src/db/wmsOrderRepository.js src/db/teamTaskRepository.js
git diff -- src/services/exceptionTask.js
git diff -- public/
git diff -- package.json automation/package.json

# 4. 신규 SQL 의 컬럼 / 인덱스 정확성
grep -c "ADD COLUMN IF NOT EXISTS" supabase/migrations/040_safety_foundation.sql
# 기대: 10
grep -c "CREATE INDEX IF NOT EXISTS" supabase/migrations/040_safety_foundation.sql
# 기대: 4

# 5. helper 의 redact 호출 존재 (snapshot 마스킹)
grep -n "redact" src/services/safetyExec.js
# 기대: input_snapshot / output_snapshot 둘 다 redact 통과

# 6. helper 의 로그 룰 준수 — payload / raw_payload / req.body 직접 출력 0건
grep -nE "console\.(log|error|warn).*(payload|req\.body|input_snapshot|output_snapshot|raw_payload)" \
  src/services/safetyExec.js src/web/routes/mockOrderImport.js
# 기대: 0 줄

# 7. mockOrderImport 응답 shape 무변화 — 200/400/409 의 JSON 키 보존
grep -nE "order_id|totals|lines|code|existing_order_id|error" src/web/routes/mockOrderImport.js
# 기대: PR S 직전 commit (ec2fd4e) 의 동일 grep 과 일치 (응답 키 추가 / 삭제 0)
```

검증 통과 시에만 사장님에게 commit 가능 보고. 통과 못 하면 어디서 어떻게 어긋났는지 보고하고 멈춤 — 임의로 plan 변경 / 추가 파일 수정 금지.

---

## Commit 메시지 (사장님 승인 후)

```
feat(safety-foundation): extend automation_runs as canonical execution audit log

- db: 040 migration adds 10 nullable cols + 4 indexes to automation_runs
      (executed_by_user_id, action_name, target_table, target_id,
       rollback_method, rollback_hint, rolled_back_at, rolled_back_by,
       rollback_run_id self-FK, rollback_reason)
- service: src/services/safetyExec.js — runAction (pre, strict),
           updateRun (post, best-effort), rollbackAction, listRuns stub
- route: mockOrderImport.js wrap — pre/post audit, status mapping
         (201→succeeded, 400→failed, 409→cancelled, 500→failed)
- automation: Drizzle schema mirror (typed cols only, FK as plain int)

Response shape unchanged. PII/secret redaction enforced inside helper.
Server log rule: actionName / executedBy / message only — never payload.

Plan: docs/phase-3-safety-foundation-plan.md (Phase 3 PR S, 4 files).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## 금지 사항 (반드시 준수)

| # | 금지 | 위반 시 영향 |
|---|---|---|
| 1 | plan §3 의 4 파일 외 추가 수정 | Phase 1 / Phase 2 회귀 |
| 2 | mockOrderImport 응답 JSON shape 변경 | UI / Phase 2 검증 가이드 회귀 |
| 3 | snapshot 내용 / payload / raw_payload / token 의 console 출력 | secret 누설 |
| 4 | rollback_run_id 를 rollback row 에도 채우기 | plan 정책 위반 — 단방향 포인터 |
| 5 | wms_order_lines FK 컬럼명을 `wms_order_id` 로 잘못 표기 | hint SQL 무용지물 (실 컬럼명 = `order_id`) |
| 6 | 040 migration 을 idempotent 하지 않게 (CREATE TABLE 대신 ALTER + ADD COLUMN, IF NOT EXISTS 누락) | 재실행 실패 → 운영 적용 차단 |
| 7 | 신규 npm 의존성 추가 | package.json 무수정 룰 위반 |
| 8 | UI 파일 추가 / 수정 | UI 0건 룰 위반 (PR M 으로 미룸) |
| 9 | createExceptionTask 등 Phase 1 코드 audit wiring | PR L 로 미룸 |
| 10 | 본 PR 에서 자동 undo 기능 (실 DELETE / API 취소 호출) 구현 | rollback_method='auto' 구현은 액션별 별 PR |

위반 시 사장님 합의 없이 진행 금지.

---

## 본 프롬프트 사용법

다른 세션에서 본 PR 을 시작하려면, 본 문서 + plan (`docs/phase-3-safety-foundation-plan.md`) 두 파일만 읽히고:

> "docs/phase-3-pr-s-implementation-prompt.md 의 지시대로 PR S 를 구현하라."

라고만 하면 self-contained.
