# Safety Foundation Final QA Report

> 작성일: 2026-05-10
> 작성자: Claude (현 세션)
> 대상 커밋: `f8c3db8 chore(safety-foundation): expose QA guard as npm script (PR U11)` (HEAD)
> 본 문서는 PR S/M/L/U 시리즈 전체의 정적 QA 결과를 기록한다 — 신규 기능 0, 코드/스키마 변경 0.

---

## 1. 목적

PR S 부터 PR U11 까지 누적 도입된 Safety Foundation 의 5 영역이 정상 연결됐는지 최종 점검:

1. **audit foundation** — `automation_runs` 테이블 + `safetyExec` helper (write side)
2. **execution log UI** — `📜 실행 로그` read-side
3. **action audit wiring** — Phase 1 / Phase 2 / 업무관리 / 발주 라우트의 audit row 자동 기록
4. **auto rollback allowlist** — `safetyUndo` service + UI 의 실 fetch 분기
5. **QA guard script** — 정적 정책 가드 (`npm run qa:safety`)

본 문서는 추가 코드 변경 없이 현 시점의 운영 안정성을 한눈에 정리한다.

---

## 2. 포함된 주요 PR / commit 흐름

`git log` 에서 확인된 commit (HEAD 부터 거슬러):

| commit | PR | 의미 |
|---|---|---|
| `06fbfd3` | **PR S** | audit foundation — `automation_runs` 10 컬럼 + 4 인덱스, `safetyExec.runAction/updateRun/rollbackAction` helper |
| `118136e` | **PR M** | execution log UI — `📜 실행 로그` 좌측 목록 + 우측 상세 + 되돌리기 stub modal |
| `8ff34cb` | **PR L** | SKU / exception audit wiring — `sku_master` CRUD + `sku_listing_link` CRUD + `exception_task_mock_create` |
| `551c698` | **PR L-2** | workflow audit wiring — `task_*` 4 액션 + `purchase_request_*` 5 액션 |
| `4330888` | **PR L-3** | execution log filter 확장 — 19 액션 optgroup + ACTION_LABEL + target deep link |
| `a1532c6` | **PR U1** | auto-undo plan — `docs/phase-3-pr-u-auto-undo-plan.md` (535 라인) |
| `7c900f3` | **PR U2** | first auto rollback path — `safetyUndo` service + POST `/api/safety-runs/:id/rollback` route + UI 4분기 |
| `8cb7cda` | **PR U3** | sku_listing_link_create rollbackMethod=auto |
| `9667552` | (PR U-fix) | delegated click handler — button id 충돌/re-render race 회피 |
| `df5b324` | **PR U4** | sku_listing_link_delete auto rollback — input_snapshot 기반 INSERT, PK 재사용 X, UNIQUE 충돌 명시 거절 |
| `1b7bcd3` | **PR U5** | sku_master_update auto rollback — ALLOWED_FIELDS 10개, internal_sku 보호 |
| `6a7d7c7` | **PR U6** | sku_master_soft_delete auto rollback — PR U5 helper 재사용 (코드 중복 0) |
| `baa21fd` | **PR U7** | purchase_request_approve/reject/ordered auto rollback — 단일 통합 handler, 외부 주문/결제는 별도 확인 |
| `051d638` | **PR U8** | rollback UX polish — error code 11종 user-friendly 매핑, in-modal 성공/실패 메시지, rollback metadata 라벨 |
| `7dd1a0b` | **PR U9** | rollback UX hardening — `rollbackStatusBadge` / `rollbackImpactText` / `summarizeUndone` helper, 목록+상세 배지, auto modal 영향 설명 |
| `1403440` | **PR U10** | QA guard script — `scripts/qa-safety-foundation.sh` (267 라인, 10 검증 그룹) |
| `f8c3db8` | **PR U11** | npm qa script — `npm run qa:safety` 1줄 등록 |

본 문서 (`PR U12`) 는 위 흐름 전체에 대한 정적 QA 통과 기록.

**Not present** (계획상 없거나 미진입):
- PR U-RPC (mock_order_import cascade undo) — manual 영구 유지로 결정
- PR U-staff-scope (staff scope 제한) — 정책 §1-A "차단보다 추적" 하에 보류
- PR U-pending-sweeper — 30분+ pending → aborted 자동 마킹 cron — 미진입

---

## 3. `npm run qa:safety` 결과

실행 시각: HEAD = `f8c3db8` 시점.

### 3-1. 요약

```
PASS: 51
WARN: 5
FAIL: 0

PASS: all checks passed.   (exit 0)
```

### 3-2. 그룹별 결과

| 그룹 | 항목 | PASS | WARN | FAIL |
|---|---|---|---|---|
| A | 핵심 7 파일 존재 | 7 | 0 | 0 |
| B | safetyUndo allowlist 7 액션 | 7 | 0 | 0 |
| C | rollbackAction 사용 위치 (safetyUndo only, 외부 4 파일 부재) | 5 | 0 | 0 |
| D | safetyRuns route (GET / + GET /:id + POST /:id/rollback + requireAuth + safetyUndo 위임) | 5 | 0 | 0 |
| E | safetyRuns UI (ACTION_LABEL / rollbackStatusBadge / rollbackImpactText / showAutoRollbackModal / API path / POST method / `<details>` / no `<details open>`) | 8 | 0 | 0 |
| F | skuMaster 5 액션 rollbackMethod | 5 | 0 | 0 |
| G | purchaseRequests 5 액션 rollbackMethod | 5 | 0 | 0 |
| H | node syntax check 7 파일 | 7 | 0 | 0 |
| I | console + sensitive keyword guard | 1 | 5 | 0 |
| J | 040 migration truncation guard (≥50 라인) | 1 | 0 | 0 |
| **합계** | — | **51** | **5** | **0** |

### 3-3. WARN 5건 분석

모두 그룹 I 의 "정책 명시 주석에 `token`/`secret`/`password`/`raw_payload` 단어 출현" — `console.*` 와 동시 출현이 아니라 fail 처리 안 됨 (이미 사장님 spec 의 "정책 주석은 허용" 정합). 파일별:

| 파일 | 출현 위치 | 의도 |
|---|---|---|
| `src/services/safetyUndo.js` | `* 로그 룰: ... snapshot/payload/secret 출력 금지` | 정책 명시 |
| `src/web/routes/safetyRuns.js` | `* executor / rolled_back_executor 는 users.display_name 만 (password_hash 등 일체 미노출)` | 정책 명시 |
| `src/web/routes/skuMaster.js` | `* snapshot 에 raw body / token / secret 일체 포함 금지`, `// raw body/secret 금지` | 정책 명시 |
| `src/web/routes/tasks.js` | `* req.body 전체 / token / secret 일체 포함 금지` | 정책 명시 |
| `src/web/routes/purchaseRequests.js` | `// 핵심 필드만 (raw body / token / secret 부재)` | 정책 명시 |

→ 운영 위험 0. 향후 PR 마다 출력이 늘어도 정책 주석으로 식별 가능.

### 3-4. 핵심 검증 항목 요약

- ✅ **핵심 7 파일 존재** (safetyExec / safetyUndo / safetyRuns route+UI / skuMaster / tasks / purchaseRequests)
- ✅ **allowlist 7 액션** 모두 등록됨 (§4 참조)
- ✅ **rollbackAction 호출 위치 제한** — safetyUndo 내부만, 외부 4 파일 (route/UI/skuMaster/purchaseRequests) 0건
- ✅ **route GET/POST hook + requireAuth + safetyUndo 위임**
- ✅ **UI helper / `/api/safety-runs/` fetch / POST method / collapsed `<details>`** 정상
- ✅ **rollbackMethod 매핑 정합** — SKU master 5건 + purchase request 5건 모두 spec 일치
- ✅ **node syntax 7 파일** 모두 통과
- ✅ **040 migration 87 라인 보존** (과거 87→1 사고 재발 방지)

---

## 4. 현재 auto rollback allowlist

`src/services/safetyUndo.js` 의 `AUTO_ROLLBACK_ACTIONS` 기준 (= 7 액션):

| # | action_name | 도입 PR | undo 동작 | 위험도 |
|---|---|---|---|---|
| 1 | `sku_listing_link_create` | PR U2/U3 | `sku_listing_link` 단일 row DELETE | 낮음 |
| 2 | `sku_listing_link_delete` | PR U4 | input_snapshot 기반 단일 row INSERT (PK 재사용 X) | 중간 (UNIQUE 충돌 가능) |
| 3 | `sku_master_update` | PR U5 | input_snapshot 의 ALLOWED_FIELDS 10개만 patch (internal_sku 보호) | 중간 |
| 4 | `sku_master_soft_delete` | PR U6 | PR U5 helper 재사용 (status flip 만 하는 update 와 본질 동일) | 중간 |
| 5 | `purchase_request_approve` | PR U7 | status / decision_* / ordered_* 필드 patch | 중간 (알림 비가역) |
| 6 | `purchase_request_reject` | PR U7 | 동일 (단일 통합 handler) | 중간 (알림 비가역) |
| 7 | `purchase_request_ordered` | PR U7 | 동일 (단일 통합 handler) | 낮음~중간 (외부 주문/결제 별도 확인 필요) |

---

## 5. manual-only 영역

현재 allowlist 외 — UI 에서 "수동 처리 필요" 배지 표시. 사용자가 hint SQL 을 직접 실행하거나 audit row 만 참고용으로 봄.

| action_name | 액션 | 이유 |
|---|---|---|
| `mock_order_import` | wms_orders + wms_order_lines + auto cards 생성 | 연쇄 부수효과 (cascade) — RPC 도입 후 검토. 본 PR 시리즈에서는 PR U-RPC 로 분리 (미진입) |
| `sku_master_create` | 신규 SKU 생성 | 이미 link / order 가 붙었을 가능성 — orphan cleanup 위험 |
| `exception_task_mock_create` | 자동 예외 카드 생성 | 알림 / SSE / recipient 부수효과 비가역 |
| `task_create` | 업무 등록 | recipients 다수 + attachments 가능 |
| `task_update` | 업무 메타 수정 | 단순 PATCH 라 manual hint 로 충분 (PR U1 plan §3 차순위 후보) |
| `task_status_update` | 업무 상태 변경 | recipients 구조 + completionNote / 첨부 영향. 후속 검토 |
| `task_delete` | 업무 hard delete | CASCADE — 복구 비현실적 |
| `purchase_request_create` | 발주 요청 생성 | 외부 발주 흐름 영향 |
| `purchase_request_update` | 발주 요청 본문 수정 | 단순 PATCH — 신중 검토 권장 |

---

## 6. 운영 smoke test 권장 순서

본 PR U12 통과 후 사장님이 운영 (Railway) 에서 짧게 직접 검증할 순서:

1. **Railway 최신 배포 확인** — Railway Dashboard 의 active commit hash 가 origin/main 의 HEAD 와 일치
2. **Cmd+Shift+R** — 브라우저 강제 새로고침 (UI 코드 캐시 무효화)
3. **새 link create rollback** — SKU 마스터 → 임의 SKU → 🔗 → 새 link 1개 → 📜 실행 로그 → 최상단 row 의 "되돌리기 실행" → 확인. SKU 마스터 새로고침 시 link 사라짐
4. **새 link delete rollback** — 위에서 만든 link 삭제 → 최상단 sku_listing_link_delete row 의 auto rollback 실행 → link 가 새 id 로 다시 생김
5. **SKU update rollback** — SKU 인라인 편집 (예: title 변경) → audit row 의 auto rollback 실행 → 원래 title 복구. internal_sku 무변경 확인
6. **SKU soft delete rollback** — SKU 삭제 (소프트) → audit row 의 auto rollback → status='active' 등 원상태 복원
7. **purchase approve/reject/ordered rollback** — 발주 요청 → 승인 → audit row 의 auto rollback → status='pending' 복원. 동일 패턴으로 reject/ordered 검증
8. **already rolled_back 재실행 방지** — 같은 audit row 의 되돌리기 버튼 두 번째 클릭 → "이미 되돌려진 실행입니다." 표시 + 버튼 숨김

---

## 7. Known Limitations

| 제약 | 영향 | 완화 |
|---|---|---|
| Supabase JS 기반 — 복수 row atomic transaction 어려움 | 단일 row 액션만 자동 가능 | mock_order_import 등 cascade 액션은 manual 영구 유지 또는 PR U-RPC 도입 |
| `audit_rollback_failed` 발생 시 운영 모순 | DB 는 변경됐지만 audit row 는 status='succeeded' 그대로 | 사용자에게 "관리자 확인 필요" 메시지 표시 (PR U8). 운영자가 수동 정리 |
| 기존 manual rollback_method 로 만들어진 audit row 는 자동으로 auto 되지 않음 | PR U3 이전에 만들어진 sku_listing_link_create row 는 manual stub modal 로만 처리 | 새 audit row 부터 auto 적용 (의도된 동작) |
| auto rollback 은 allowlist 기반 | 신규 액션은 명시 등록 전까지 manual | PR U-시리즈로 점진 확대. 사장님 운영 검증 후 추가 |
| 운영 테스트 시 실제 데이터 변경 위험 | 잘못 실행 시 운영 row 영향 | TEST prefix (예: `EBAY-TEST-*`, `TEST-LINK-*`) 사용 권장 |
| 알림 / SSE / 외부 API 호출은 비가역 | undo 후에도 사용자에게 도착한 알림은 되돌릴 수 없음 | UI 의 영향 설명 박스에 명시 ("실제 외부 주문/결제는 별도 확인하세요" 등) |

---

## 8. Next Recommended Work

우선순위 순:

1. **운영 smoke test 결과 반영** — 본 PR U12 의 §6 시나리오를 사장님이 실 운영에서 진행 → 발견된 이슈 별 PR 생성
2. **rollback 실패 알림 / notification** — `audit_rollback_failed` / `unique_conflict` 발생 시 admin SSE 또는 notification 으로 즉시 알림 (현재 사용자 modal 표시만)
3. **audit dashboard metrics** — `📊 실행 통계` 위젯 — 일/주별 액션 실행 수, 실패율, 자동 vs 수동 rollback 비율, action 별 분포
4. **`task_status_update` auto rollback 검토** — recipients 구조 + completionNote 영향 분석 후 PR U-task-status 진입 (low priority)
5. **`purchase_request_update` auto rollback 신중 검토** — 단순 PATCH 지만 본문 변경이라 운영 위험. before snapshot full row 보존 필요. 결정은 staging 검증 후
6. **PR U-pending-sweeper** — 30분+ pending status row 를 aborted 로 자동 마킹하는 cron — `automation_runs` 통계 정확성 보장
7. **PR U-RPC** — `mock_order_import` 등 cascade undo 의 RPC 도입 검토 — 별 migration + supabase function 필요

---

## 9. 본 PR U12 의 외부 무수정 약속

| 영역 | 무수정 |
|---|---|
| `src/**` | ✅ |
| `public/**` | ✅ |
| `supabase/**` | ✅ |
| `automation/**` | ✅ |
| `scripts/**` | ✅ |
| `server.js` | ✅ |
| `package.json` / `automation/package.json` | ✅ |

본 PR U12 = docs 1 파일 신규. 코드/스키마 변경 0.

---

## 10. 본 문서 메타

- 작성: 2026-05-10
- 작성자: Claude (현 세션)
- 대상: HEAD = `f8c3db8 chore(safety-foundation): expose QA guard as npm script (PR U11)`
- QA 결과: 51 PASS / 5 WARN / 0 FAIL → exit 0
- 다음 작업: 사장님 운영 smoke test (§6) 또는 §8 의 우선순위 항목 진입
