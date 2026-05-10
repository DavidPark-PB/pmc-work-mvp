# Phase 3 PR U — Safety Foundation auto-undo 계획

> 작성일: 2026-05-10
> 전제: PR S / PR M / PR L / PR L-2 / PR L-3 모두 origin/main 에 push + 운영 DB 적용 완료. PR L-3 commit `4330888 feat(safety-foundation): expand execution log filters (PR L-3)` 가 HEAD.
> 본 문서는 **구현 전 합의용 계획서** — 실 코드 변경 0건.
> 후속 코드 구현은 본 plan 승인 후 별 단계 (PR U2 / U3 / U4) 로 진행.

---

## 1. 배경

| commit | PR | 의미 |
|---|---|---|
| `06fbfd3` | PR S | `automation_runs` audit foundation — 10 컬럼 + 4 인덱스, helper `safetyExec.runAction/updateRun/rollbackAction` |
| `118136e` | PR M | 실행 로그 UI (`📜 실행 로그`) — 좌측 목록 + 우측 상세 + 되돌리기 stub modal (실 호출 0) |
| `8ff34cb` | PR L | Phase 1 액션 audit wiring — sku_master CRUD + sku_listing_link CRUD + exception_task_mock_create |
| `551c698` | PR L-2 | 업무관리 액션 audit wiring — task / purchase_request 9 액션 |
| `4330888` | PR L-3 | UI action filter 확장 + target deep link 버튼 |

**현 상태 한계**: `📜 실행 로그` 의 되돌리기 버튼은 **stub** — 클릭 시 modal 안내만 나오고 실 undo 없음. 운영자가 hint SQL 을 직접 Supabase Studio 에서 실행해야 함.

**PR U 목표**: 일부 안전한 `action_name` 에 한해 **버튼 → 실 undo + audit chain 자동 기록** 까지 활성화. 모든 액션 자동화 X — allowlist 기반.

---

## 2. auto-undo 원칙

### 2-1. 기본값 = manual-only

신규 액션을 `safetyExec.runAction` 으로 wrap 할 때 기본 정책 = `rollback_method = 'manual'`. auto-undo 는 **명시 allowlist 등록 후에만** 가능. 안전 우선.

### 2-2. allowlist 기반

`src/services/safetyUndo.js` 의 `AUTO_UNDO_REGISTRY` 객체에 등록된 `action_name` 만 자동 처리. 등록 안 된 action 은 라우트 단에서 **400 에러** ("이 액션은 자동 되돌리기를 지원하지 않습니다 — manual hint 참고") 반환.

### 2-3. destructive undo 금지 또는 2단계 확인

| 종류 | 정책 |
|---|---|
| **Soft (status flip)** | 1단계 — 버튼 클릭 → modal 확인 → 실행 |
| **Idempotent restore** (예: link 재생성, sku update 복구) | 1단계 |
| **Destructive** (DELETE, hard cleanup) | **2단계** — modal 1차 ("정말 되돌립니까?") → modal 2차 (input 으로 `UNDO` 직접 타이핑) → 실행 |
| **Cascade impact** (mock_order_import 처럼 wms_orders + lines + auto cards 등 연쇄) | **PR U 범위 외** — manual 영구 유지 |

본 PR U 1차 후보 (§3) 는 모두 1단계로 시작. destructive 케이스 (sku_listing_link_delete 의 재생성은 사실상 INSERT 라 idempotent restore — 1단계) 는 후속 검토.

### 2-4. rollbackAction 책임 분리 (PR S 정책 보존)

[`safetyExec.rollbackAction`](../src/services/safetyExec.js) 는 **audit row 만 생성/갱신**. 실 DB undo 는 caller (라우트 또는 서비스) 가 먼저 수행. 호출 순서:

```
1. validate allowlist (safetyUndo)
2. load original run (safetyUndo)
3. perform actual DB undo (safetyUndo's per-action handler)
4. on success → safetyExec.rollbackAction({ runId, executedBy, reason }) 호출
                → 새 rollback row 생성 + 원본 row.status='rolled_back' 갱신
5. on failure → 원본 row 무변경 (또는 status='rollback_required' 상승)
```

### 2-5. 성공/실패 시 원본 row 처리

| 결과 | 원본 run 의 변화 |
|---|---|
| 성공 | `status='rolled_back'`, `rolled_back_at/by`, `rollback_run_id` 채움 (rollbackAction 내부 처리) |
| **DB undo 실패 (rollbackAction 호출 전)** | 원본 무변경 — 사용자에게 500/400 에러. status 그대로 (succeeded) |
| **rollbackAction 자체 실패 (DB undo 후)** | 원본 status `rollback_required` 로 마킹 (운영 모순 알림) — caller 가 수동 정리 필요. PR U2 에서 케이스별 결정 |

### 2-6. snapshot = PR S redact 결과만 신뢰

undo 시 `input_snapshot` (= PR S 의 beforeSnapshot) 을 read-only 데이터로 사용. 절대 raw payload / req.body / token / secret 을 새로 받아 처리하지 않음.

### 2-7. 로그 출력 룰

- 허용: `actionName / runId / executedBy / error.message`
- 금지: `payload`, `req.body`, `input_snapshot` / `output_snapshot` 본문, token / secret / password / API key 류

PR S/L 의 로그 룰 그대로 계승.

### 2-8. idempotency

- 원본 run 의 `status === 'rolled_back'` 이면 **재실행 금지** — 400 (`'safetyUndo/already_rolled_back'`)
- 원본 run 의 `rollback_method === 'irreversible'` 이면 400 (`'safetyUndo/irreversible'`)
- allowlist 미등록 action 이면 400 (`'safetyUndo/not_in_allowlist'`)
- 원본 row not found (=PR M 때 deep delete 등) 면 404

---

## 3. 1차 auto 허용 후보 (PR U2~U4 점진 도입)

| # | action_name | undo 동작 | 조건 | 위험도 | PR |
|---|---|---|---|---|---|
| 1 | **`sku_listing_link_create`** | `DELETE FROM sku_listing_link WHERE id = <target_id>` | `target_table='sku_listing_link'`, `target_id` 존재 | **낮음** — 단일 row, FK cascade 없음 | **U2** (1차) |
| 2 | `sku_listing_link_delete` | `INSERT INTO sku_listing_link (sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary) VALUES (<input_snapshot 값>)` | `input_snapshot` 에 `sku_id`/`marketplace`/`listing_id` 충분 | **중간** — UNIQUE `(marketplace, listing_id, option_id)` 충돌 가능 (그 사이 다른 SKU 가 같은 link 차지). 충돌 시 409, 원본 무변경 | U3 |
| 3 | `sku_master_update` | `UPDATE sku_master SET <허용 필드>=<input_snapshot 값> WHERE id = <target_id>` | `target_id` 존재, `beforeSnapshot` 의 `title/status/automation_enabled/cost_krw/weight_gram/hs_code/notes/product_type/brand/category` 충분 | **중간** — 그 사이 누군가 또 update 했으면 그 변경 덮어씀. **2단계 확인** 검토 | U4 |
| 4 | `task_status_update` | recipient row 의 `status` 복구 (input_snapshot.recipient_status / recipient_user_id 사용) | recipients 구조 정확 검토 필요 — 본 PR S 의 snapshot 에 recipient_user_id 가 들어있음 (PR L-2 wrap 확인) | **중간~높음** — completionNote, attachments 같이 영향 받을 가능성. 첨부 파일 storage 는 자동 복구 X (수동) | U4 (조건부) |
| 5 | `purchase_request_approve` | `UPDATE purchase_requests SET status='pending', decision_by=null, decision_at=null, rejection_reason=null, rejection_note=null WHERE id = <target_id>` | input_snapshot 의 `status='pending'` 확인 | **중간** — 알림 (notify) 은 되돌릴 수 없음 (사용자에게 이미 도착) | U3 |
| 6 | `purchase_request_reject` | 위와 동일 (status='pending' 으로 복원) | 동일 | **중간** — 동일 (알림 비가역) | U3 |
| 7 | `purchase_request_ordered` | `UPDATE purchase_requests SET status='approved', ordered_by=null, ordered_at=null WHERE id = <target_id>` | input_snapshot 의 `status='approved'` 확인 | **낮음~중간** — 기존 `unorder` 라우트와 동작 동일. 알림 비가역 | U3 |

### 3-1. 후보별 사전 검증 SQL (PR U2 진입 전)

```sql
-- target_table 분포 확인 — 각 후보가 실 운영에서 얼마나 발생하는지
SELECT action_name, target_table, count(*)
FROM automation_runs
WHERE action_name IN ('sku_listing_link_create','sku_listing_link_delete',
                      'sku_master_update','task_status_update',
                      'purchase_request_approve','purchase_request_reject',
                      'purchase_request_ordered')
GROUP BY action_name, target_table
ORDER BY action_name;
```

PR U2 진입 시 1순위 = `sku_listing_link_create` 만 (가장 안전 + 단순 + cascade 없음). 검증 후 점진 확대.

---

## 4. 1차 manual-only 유지

| action_name | 이유 |
|---|---|
| `mock_order_import` | wms_orders + wms_order_lines + SKU_MATCH_FAILED auto cards (50개 cap + overflow card) 의 **연쇄 부수효과**. 자동 cleanup 시 dedupe / SSE 영향. 별 PR `mock_order_undo` 또는 manual 영구 유지 |
| `sku_master_create` | 이미 `sku_listing_link` 가 붙었거나 wms_order_lines 가 매칭됐을 가능성. orphan link/match cleanup 자동화 위험 |
| `sku_master_soft_delete` | 복구 자체 (status 복원) 는 가능하지만 `automation_enabled` / `notes` 등 비즈니스 정책 재확인 필요. PR U4 후 별도 검토 |
| `exception_task_mock_create` | `team_tasks` row 1건 + recipient 1+건 + DB notification + SSE broadcast. recipient 는 cascade 로 처리되지만 SSE / notification 은 비가역 |
| `task_create` | recipients (assignee_scope='all' 시 다수) + attachments 가 붙기 시작했을 수 있음. CASCADE 는 DB 만, storage 파일은 별도 |
| `task_update` | 메타 변경은 복구 단순하지만 PR L-2 의 `task_update` 는 메타 PATCH 만. PR U4 검토 후보 (auto 후보 #3) |
| `task_delete` | hard delete + CASCADE — 복구 = INSERT + recipients + attachments 재구성. 비현실적 |
| `purchase_request_create` | 외부 발주 흐름 영향 (이미 ordered 됐을 가능성, 비용 의사결정) |
| `purchase_request_update` | 일반적으로 추적용. 복구 가치 낮음 + 단순 PATCH 라 manual 도 부담 적음 |

### 4-1. manual 유지 강제 표시

PR U2 의 `safetyUndo` 라우트는 위 action_name 호출 시 **400** 반환 + 명확한 에러 메시지: `"action '<name>' 은 자동 되돌리기 미지원. 우측 hint 의 SQL 을 Supabase Studio 에서 직접 실행하세요."`

UI (PR U3) 도 allowlist 외 action 의 되돌리기 버튼은 **disabled** + tooltip "manual only" 표시.

---

## 5. API 설계

### 5-1. 신규 라우트

```
POST /api/safety-runs/:id/rollback
```

**위치**: [`src/web/routes/safetyRuns.js`](../src/web/routes/safetyRuns.js) — PR M 의 read-only GET 라우트와 동일 파일에 추가.

### 5-2. 권한

**`requireAuth`** (admin / staff 둘 다) — 정책 §1-A 정합. 단 staff 의 undo 가능 범위는 향후 검토:
- 본인이 실행한 action (executed_by_user_id = req.user.id) 만 허용? 또는
- 모두 허용 + audit row 가 누가 undo 했는지 기록?

권장: **모두 허용** — 정책 §1-A "차단보다 추적". staff 가 admin 행위를 undo 하는 것도 허용. audit chain 으로 추적 가능.

### 5-3. body / 응답

```jsonc
// Request
POST /api/safety-runs/123/rollback
Content-Type: application/json
{
  "reason": "잘못 등록한 link"  // 선택 — 없으면 null 저장
}

// Response (성공) — 200
{
  "success": true,
  "rollback_run_id": 456,
  "original_run_id": 123,
  "action_name": "sku_listing_link_create",
  "undo_summary": {                              // 액션별 자유 형태
    "deleted_link_id": 789
  }
}

// 400 — allowlist 외
{ "error": "action 'task_delete' 은 자동 되돌리기 미지원", "code": "not_in_allowlist" }

// 400 — 이미 rolled_back
{ "error": "이미 되돌려진 run 입니다", "code": "already_rolled_back" }

// 400 — irreversible
{ "error": "되돌릴 수 없는 액션입니다", "code": "irreversible" }

// 404
{ "error": "run not found" }

// 409 — undo 중 충돌 (예: link 재생성 시 unique 위반)
{ "error": "되돌리기 중 데이터 충돌이 발생했습니다", "code": "conflict", "detail": "동일 link 가 다른 SKU 에 이미 존재" }

// 500
{ "error": "되돌리기 처리 중 오류" }
```

### 5-4. PR M UI stub → 실 호출 전환 방식

UI 변경 (§8 상세). 현재 `safetyRuns.js:onRollbackClick` 의 `showStubModal(...)` 호출을 다음 분기로 교체:

```js
function onRollbackClick(run) {
  if (run.rollback_method === 'auto' && AUTO_UNDO_ALLOWLIST.has(run.action_name)) {
    showConfirmModal(run);  // 1단계 확인 → POST /api/safety-runs/:id/rollback
  } else {
    showStubModal(run);     // 기존 stub (PR M §2-1 그대로)
  }
}
```

`AUTO_UNDO_ALLOWLIST` 는 client-side 상수 (server response 에 의존하지 않음 — UI 응답성 우선). server 가 진실 — 클라이언트 allowlist 가 잘못돼도 server 가 400 으로 거부.

---

## 6. 서비스 설계

### 6-1. 새 파일: `src/services/safetyUndo.js`

**역할**:

1. allowlist registry 보유 (`AUTO_UNDO_REGISTRY`)
2. `undoRun({ runId, executedBy, reason })` 진입점
3. action 별 handler 함수 (`undoSkuListingLinkCreate`, `undoPurchaseRequestApprove` 등)
4. 성공 시 `safetyExec.rollbackAction` 호출
5. 실패 시 caller 에 throw + 에러 코드

**API 스케치**:

```js
'use strict';
const supabaseClient = require('../db/supabaseClient');
const safetyExec = require('./safetyExec');

const AUTO_UNDO_REGISTRY = {
  // PR U2 — 1차
  sku_listing_link_create: undoSkuListingLinkCreate,
  // PR U3 — 추가 후보
  // sku_listing_link_delete:   undoSkuListingLinkDelete,
  // purchase_request_approve:  undoPurchaseRequestApprove,
  // purchase_request_reject:   undoPurchaseRequestReject,
  // purchase_request_ordered:  undoPurchaseRequestOrdered,
  // PR U4 — 더 까다로운 후보
  // sku_master_update:         undoSkuMasterUpdate,
  // task_status_update:        undoTaskStatusUpdate,
};

class UndoError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * undo 진입점.
 * 1) load run, 2) validate, 3) action 별 handler 실행, 4) rollbackAction.
 * @returns {Promise<{rollbackRunId:number, original_run_id:number, action_name:string, undo_summary:object}>}
 */
async function undoRun({ runId, executedBy, reason = null }) {
  const supabase = supabaseClient.getClient();
  const { data: run, error } = await supabase
    .from('automation_runs')
    .select('id, action_name, target_table, target_id, status, rollback_method, input_snapshot, output_snapshot')
    .eq('id', runId)
    .maybeSingle();
  if (error) throw new UndoError('load_failed', error.message);
  if (!run)  throw new UndoError('run_not_found', `run ${runId} not found`, 404);
  if (run.status === 'rolled_back')         throw new UndoError('already_rolled_back', '이미 되돌려진 run 입니다', 400);
  if (run.rollback_method === 'irreversible') throw new UndoError('irreversible', '되돌릴 수 없는 액션입니다', 400);

  const handler = AUTO_UNDO_REGISTRY[run.action_name];
  if (!handler) throw new UndoError('not_in_allowlist', `action '${run.action_name}' 은 자동 되돌리기 미지원`, 400);

  const undo_summary = await handler(run);   // throw 시 caller 가 잡음 — 원본 run 무변경
  const { rollbackRunId } = await safetyExec.rollbackAction({ runId: run.id, executedBy, reason });

  return {
    rollbackRunId,
    original_run_id: run.id,
    action_name: run.action_name,
    undo_summary,
  };
}

// ── 액션별 handler ──

// 예: PR U2 의 1차 — sku_listing_link_create
async function undoSkuListingLinkCreate(run) {
  if (run.target_table !== 'sku_listing_link' || !Number.isFinite(run.target_id)) {
    throw new UndoError('invalid_target', 'target_table/id 가 sku_listing_link 가 아님');
  }
  const supabase = supabaseClient.getClient();
  const { data, error } = await supabase
    .from('sku_listing_link')
    .delete()
    .eq('id', run.target_id)
    .select('id, sku_id')
    .maybeSingle();
  if (error) throw new UndoError('db_failed', error.message);
  // 이미 누군가 삭제했으면 data=null. idempotent — 성공 처리.
  return { deleted_link_id: data?.id ?? null, already_absent: !data };
}

module.exports = {
  AUTO_UNDO_REGISTRY,
  UndoError,
  undoRun,
};
```

### 6-2. transaction 한계

Supabase JS client 는 표준 `BEGIN ... COMMIT` 미지원. 단일 row update/delete 는 row-level atomic 보장 (PostgreSQL native) 이라 PR U2 의 1차 후보 (`sku_listing_link_create` undo = 단일 DELETE) 는 안전.

**복수 row atomic 이 필요한 undo** (예: mock_order_import 의 wms_orders + wms_order_lines + team_tasks 동시 cleanup) 는:
- Option A: `supabase.rpc()` + PostgreSQL function 도입 → 신규 migration 필요
- Option B: 순서 보상 — 첫 단계 성공 후 두 번째 실패 시 첫 단계 manual 정리 hint 반환 → 운영 위험
- Option C: PR U 범위 외 — manual 영구 유지

**1차 PR U2 결정**: 단일 row 액션만 (`sku_listing_link_create`). 복수 row 는 PR U4 이후 RPC 도입 검토.

### 6-3. handler 설계 룰

각 handler 는:
- 한 가지 액션만 책임
- input_snapshot 만 읽음 (raw body 안 받음)
- supabase 호출 1회 또는 작은 단위
- 실패 시 throw `UndoError` (HTTP status 매핑용 `.status` 포함)
- 성공 시 `undo_summary` 객체 반환 (응답에 그대로 포함)

---

## 7. DB / RPC 필요 여부

### 7-1. 1차 PR U2 — migration 0 목표

| 액션 | undo 형태 | migration 필요? |
|---|---|---|
| `sku_listing_link_create` | 단일 DELETE | **불필요** |
| `purchase_request_approve/reject/ordered` | 단일 UPDATE | 불필요 |
| `sku_master_update` | 단일 UPDATE | 불필요 |
| `sku_listing_link_delete` | 단일 INSERT | 불필요 |
| `task_status_update` | recipient UPDATE 1+건 | 불필요 (1건씩 순차 OK) |

→ PR U2 는 **migration 0**, code only.

### 7-2. 후속 RPC 검토

복수 row atomic 이 필요한 액션 (`mock_order_import` 의 cleanup 등) 은 PR U-RPC 단계에서:

```sql
CREATE FUNCTION undo_mock_order_import(p_target_id integer)
RETURNS jsonb
LANGUAGE plpgsql AS $$
BEGIN
  -- BEGIN/COMMIT 자동 (function 단위 transaction)
  DELETE FROM wms_order_lines WHERE order_id = p_target_id;
  DELETE FROM wms_orders WHERE id = p_target_id;
  -- 자동 카드 close (status='done') 검토
  RETURN jsonb_build_object('deleted_order_id', p_target_id);
END;
$$;
```

별 migration `041_undo_rpc.sql` 신설. 본 PR U 범위 외.

### 7-3. 1차 PR U2 검증 시 SQL

```sql
-- handler 가 작동했는지 확인 (sku_listing_link_create undo 후)
SELECT id, status, rolled_back_at, rolled_back_by, rollback_run_id, rollback_reason
FROM automation_runs WHERE id = <원본 runId>;
-- 기대: status='rolled_back', rollback_run_id 채움

SELECT id, action_name, status, target_table, target_id, input_snapshot
FROM automation_runs WHERE id = <rollback_run_id>;
-- 기대: action_name='rollback', input_snapshot.original_run_id=<원본>

-- 실 데이터 확인
SELECT count(*) FROM sku_listing_link WHERE id = <삭제된 link id>;
-- 기대: 0 (삭제됨)
```

---

## 8. UI 변경 계획 (PR U3)

### 8-1. 분기 표시

상세 패널의 되돌리기 버튼 영역:

| `rollback_method` × `action_name` allowlist | 버튼 표시 | 클릭 동작 |
|---|---|---|
| `auto` + allowlist 등록 | **활성** "되돌리기" (#1565c0 파란색) | 1단계 confirm modal → POST /api/safety-runs/:id/rollback |
| `auto` + allowlist 미등록 | **활성** "되돌리기" (#5d3a00 주황색) — manual 매핑 | 기존 stub modal (PR M §2-1) |
| `manual` | **활성** "되돌리기" (#5d3a00 주황색) | 기존 stub modal |
| `irreversible` | **숨김** | — |
| `status` ≠ `'succeeded'` | **숨김** | — |

### 8-2. 2단계 confirm (destructive 일 때만)

PR U2 의 1차 (sku_listing_link_create = 단순 DELETE) 는 1단계로 진행. 후속에서 destructive 액션 도입 시 2단계 :

```
modal 1: "정말 #N 을 되돌립니까? (실 DB 변경)"
        [취소] [확인]
↓ 확인 클릭 시
modal 2: "되돌리기를 확정하려면 'UNDO' 를 입력하세요"
        [입력 박스] [실행] (입력 정확 시만 활성)
```

### 8-3. 성공 후 detail refresh

POST 성공 응답 → 우측 detail 자동 새로고침 (`openDetail(runId)` 재호출) → status 가 `rolled_back` 으로 바뀌고 rollback chain 표시 (PR M 의 chainHtml 이 자동으로 표시).

### 8-4. 실패 메시지

| 응답 | UI |
|---|---|
| 400 (allowlist 미등록 / already_rolled_back / irreversible) | error toast + modal 닫기 |
| 404 | "run 을 찾을 수 없습니다 (이미 삭제?)" + refresh() 호출 |
| 409 (undo 중 충돌) | "되돌리기 중 데이터 충돌 — manual 정리 필요" + manual hint 표시 |
| 500 | "처리 중 오류" + refresh 권유 |

### 8-5. PR M 정책 보존

- snapshot `<details>` 기본 접힘 — 보강 3 정합
- 본인 필터 / 페이지네이션 / executor 표시 / target deep link 모두 무변경
- 새 fetch POST 호출 추가는 **rollback 1건만**

---

## 9. 검증 계획

### 9-1. PR U2 자체 검증 (구현 후)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 1 | sku_listing_link_create 1건 audit 생성 후 undo | rollback run 생성 + 원본 status='rolled_back' + sku_listing_link row 삭제 |
| 2 | 동일 run 두 번 undo | 2번째 호출 → 400 `already_rolled_back` |
| 3 | irreversible action undo 시도 | 400 `irreversible` (단 1차 후보에는 irreversible 없음 — synthetic 시도) |
| 4 | allowlist 미등록 action undo 시도 (`task_delete` 등) | 400 `not_in_allowlist` |
| 5 | not found run | 404 |
| 6 | undo 중 race (이미 누군가 link 삭제) | handler 의 idempotent 처리 — `already_absent: true` 응답 + rollbackAction 정상 진행 |
| 7 | undo 권한 (staff 가 admin 의 run undo) | 200 (정책 §1-A 정합 — 모두 허용) |
| 8 | UI 의 stub vs 실 호출 분기 | allowlist 등록 action 만 confirm modal, 그 외 기존 stub |

### 9-2. staging DB 사전 검증

PR U2 push **전** staging 환경에서:

```sql
-- 1. 테스트용 link 생성 (PR L 의 라우트 호출 또는 SQL INSERT)
INSERT INTO sku_listing_link (sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary)
VALUES (1, 'ebay', 'TEST-LINK-1', null, 'PMC-TEST', false);
-- run id 확보 — automation_runs 의 최신 row

-- 2. 본 PR U2 undo 라우트 호출 (curl 또는 UI)
-- POST /api/safety-runs/<id>/rollback { reason: "test" }

-- 3. 검증 SQL (위 7-3 참고)
```

### 9-3. 권한 / 회귀 테스트

| 항목 | 결과 |
|---|---|
| GET 라우트 (PR M 통과) | 무영향 — 기존 read 그대로 |
| 다른 액션 (mock_order_import 등) 의 stub modal | 무영향 — UI 분기로 분리 |
| safetyExec.rollbackAction 직접 호출 | 무영향 — 시그니처 무변경 |
| Phase 1/2 라우트 동작 | 무영향 — wrap 무수정 |

### 9-4. 실행 로그 chain 표시

PR M 의 `rollback_run` / `original_run` chain 표시가 PR U2 후 정상 작동하는지:
- 원본 run 상세 → "이 액션은 #<rollback_run_id> 에서 되돌려졌습니다" 표시
- rollback run 상세 → "원본 액션 #<original_run_id>" 링크 → 클릭 시 openDetail(원본)

---

## 10. PR 분할 제안

| PR | 범위 | 파일 수 | 위험 |
|---|---|---|---|
| **PR U1** ⭐ 본 문서 | plan only — `docs/phase-3-pr-u-auto-undo-plan.md` | 1 (docs) | 0 |
| **PR U2** | `src/services/safetyUndo.js` 신규 + `src/web/routes/safetyRuns.js` 에 POST `/:id/rollback` 1건 추가. allowlist = `sku_listing_link_create` 1개만 | 2 | **낮음** — 단일 row DELETE, FK cascade 없음 |
| **PR U3** | UI — `public/js/safetyRuns.js` 의 `onRollbackClick` 분기 + confirm modal + POST 호출 + detail refresh | 1 | 낮음 |
| **PR U4** | allowlist 확장 — `purchase_request_approve/reject/ordered` 추가. 각 handler + 검증 시나리오 추가 | 1 (`safetyUndo.js` 만) | 중간 |
| **PR U5** (조건부) | `sku_master_update` / `sku_listing_link_delete` 추가 (UNIQUE 충돌 방어 필요) | 1 | 중간 |
| **PR U-RPC** (별 PR) | RPC migration 도입 (`mock_order_import` 등 cascade undo) | migration + safetyUndo handler | 높음 |
| **PR U-staff-scope** (조건부) | staff 가 본인 실행만 undo 하도록 제한 검토 (정책 §1-A 와 충돌 — 사장님 결정) | 1 | 정책 |

본 문서 = **PR U1**. 다음 작업은 PR U2 의 implementation prompt 작성 (사장님 승인 후).

---

## 11. 본 PR U1 의 외부 무수정 약속

| 영역 | 무수정 |
|---|---|
| `src/services/safetyExec.js` | ✅ — PR U 시리즈 전체에서 무수정 (helper 책임 분리 정책 §2-4) |
| `src/services/safetyUndo.js` | ✅ — 본 PR U1 에서 신규 생성 0 (PR U2 작업) |
| `src/web/routes/safetyRuns.js` | ✅ — 본 PR U1 에서 무수정 (PR U2 작업) |
| `public/js/safetyRuns.js` | ✅ — 본 PR U1 에서 무수정 (PR U3 작업) |
| `supabase/migrations/*.sql` | ✅ — PR U2~U4 모두 0건 목표 (PR U-RPC 만 신규) |
| `src/web/routes/{tasks,purchaseRequests,skuMaster,exceptionRouting,mockOrderImport,orders}.js` | ✅ — wrap 무수정 |
| `automation/src/db/schema.ts` | ✅ |
| `package.json` / `automation/package.json` | ✅ |
| `server.js` / `public/index.html` / `public/js/dashboard.js` | ✅ |

본 PR U1 = docs 1 파일 신규. 코드 변경 0.

---

## 12. PR U1 수용 기준

- [ ] §3 1차 후보 7개 + §4 manual-only 9개 명단 사장님 승인
- [ ] §5 의 API shape (URL / body / 응답 / 에러 코드) 사장님 승인
- [ ] §6 의 `safetyUndo.js` 책임 분리 (helper 무수정 + handler 패턴) 동의
- [ ] §8 의 UI 분기 (allowlist 등록 → confirm, 그 외 → stub) 동의
- [ ] §10 의 PR 분할 (U2 → U3 → U4 → 조건부 U5) 동의
- [ ] migration 0 목표 (RPC 는 별 PR) 동의
- [ ] 본 plan 자체에 2026-05-10 작성 메타 + git status clean 확인

---

## 13. 본 문서 메타

- 작성: 2026-05-10
- 작성자: Claude (현 세션)
- 목적: PR U2 진입 전 합의용 계획서 (auto-undo 1차 도입 범위 / 책임 분리 / API / UI / PR 분할)
- 코드 변경: 0건 (본 문서가 유일 산출물)
- 다음 작업: 사장님 검토 → 승인 시 PR U2 구현 프롬프트 (`docs/phase-3-pr-u2-implementation-prompt.md`) 작성 → 그 다음 코드 구현 진입
