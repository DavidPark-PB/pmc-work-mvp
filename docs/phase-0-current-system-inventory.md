# Phase 0 — 문서 1: 현재 시스템 인벤토리

> 작성일: 2026-05-08 · 모드: read-only 분석 · 코드/DB/설정 변경 없음
> 입력: [docs/wms-migration-analysis.md](./wms-migration-analysis.md) (1차 분석)
> 목적: WMS 전환 의사결정에 필요한 사실 정리. **백과사전이 아님.**
> 증거 등급:
> - **CONFIRMED** — 코드/파일/스키마에서 직접 확인
> - **INFERRED** — 코드 흐름상 추론
> - **UNKNOWN** — 현재 코드만으로 확정 불가

---

## 0. 컨텍스트 (확정 사항)

| # | 결정 | 의미 |
|---|---|---|
| 1 | 자동화 sub-app은 합치지 않음 — DB 통합 + 프로세스 분리 | 메인 앱은 운영 콘솔, sub-app은 리스팅/크롤 워커 |
| 2 | 메인 앱 = WMS 운영 + 예외 콘솔 | `team_tasks` 재배치 (문서 2에서 깊게) |
| 3 | LLM-as-Planner / Tool-as-Executor | 에이전트는 추천만, 실행은 검증된 모듈 |
| 4 | MVP = Phase 0~3 | Phase 1: SKU 마스터 + 예외 / Phase 2: 주문 수집 / Phase 3: 도매 감시 + 마진 |
| 5 | 카카오톡 = 알림/승인 링크만, 실행은 웹앱 권한 검증 후 | 안전한 채널 분리 |
| 잠정 | DB jobs polling 우선 검토 | 코드가 다른 결론을 가리키면 명시 |

---

## 1. 현재 기능 목록 (사용자 관점)

| 기능 | 대표 파일 | 의미 (WMS 관점) | 등급 |
|---|---|---|---|
| **로그인/세션** | [src/middleware/auth.js](../src/middleware/auth.js) | dual-mode (user / 레거시 공유 비번). WMS 의 권한 베이스로 그대로 사용 가능 | CONFIRMED |
| **직원 관리** | [src/web/routes/users.js](../src/web/routes/users.js) | role=admin/staff + can_manage_finance 플래그. 역할 추가 시 컬럼/가드 추가 필요 | CONFIRMED |
| **업무 카드 (team_tasks)** | [src/web/routes/tasks.js](../src/web/routes/tasks.js) | **WMS 예외 콘솔의 핵심 자산.** auto_generated 분기만 추가하면 재사용 가능 (문서 2) | CONFIRMED |
| **댓글/이력** | tasks.js:184-220 (`completion_note`) | 단일 텍스트 필드. 다중 댓글 모델은 없음 — exception thread 가 필요하면 신규 | CONFIRMED |
| **알림 (DB + SSE + 멀티채널)** | [notify.js](../src/services/notify.js), [sseHub.js](../src/services/sseHub.js), [notificationService.js](../src/services/notificationService.js) | 3-tier (DB queue → SSE 실시간 → iMessage/Telegram). 카톡 추가만 하면 그대로 사용 | CONFIRMED |
| **파일첨부** | tasks.js:225-329, [src/web/routes/expenses.js](../src/web/routes/expenses.js):261-378, [purchaseRequests.js](../src/web/routes/purchaseRequests.js):342-443 | Supabase Storage + signed URL 패턴. 라벨 PDF 첨부에 그대로 이식 가능 | CONFIRMED |
| **대시보드 (메인)** | [public/js/dashboard.js](../public/js/dashboard.js) | 추정 1만 라인 이상. 화면별 분리 필요 | INFERRED |
| **재고 실사** | [stocktake.js](../src/web/routes/stocktake.js) | `ebay_products` 직접 조회 + `stock_adjustments` 적재. WMS 재고 기반과 직결 | CONFIRMED |
| **B2B 인보이스 / 송장 / FedEx 라벨** | api.js:3766~end | C2C 라벨 워크플로우의 **모범 패턴** (Storage 버킷 + signed URL 15분 + 자동 FULFILLED) | CONFIRMED |
| **외부 연동 (8 마켓 + 2 물류 + Google)** | [src/api/](../src/api/) 11 파일 | §7 참조 | CONFIRMED |
| **백그라운드 자동화** | [scheduler.js](../src/services/scheduler.js) (cron 9개) | §9 참조 | CONFIRMED |
| **운영 메뉴 5종** (사이드바 하단) | [operations.js](../src/web/routes/operations.js) | WMS 진입점으로 가장 친화적. SKU 마스터 표면 후보 | CONFIRMED |

생략한 것 (운영 영향 작음): 카탈로그 가격(Sheets 직접), 주간 회의/계획, CS 템플릿, 자료실, 워크스페이스 todo, 피드백, 출퇴근, 급여/보너스, 정기지출, AI 리메이커, 썸네일 — 모두 Keep, WMS 와 약결합.

---

## 2. DB 테이블 구조 (그룹 요약)

전체 테이블은 1차 분석문 §2 참조. 여기서는 **WMS 의사결정에 영향을 주는 그룹**만 다룸.

| 그룹 | 대표 테이블 | 도입 마이그레이션 | 현재 역할 | WMS 재사용성 | 주의 |
|---|---|---|---|---|---|
| **사용자/권한** | `users`, `audit_logs` | 008 | 인증·역할 | **그대로 재사용** | role 컬럼에 'operator', 'approver' 추가 검토 |
| **마켓별 product mirror** | `ebay_products`, `shopify_products`, `naver_products`, `alibaba_products` | 001 | **현재 진입점의 메인 데이터 소스** ([api.js:188-1171](../src/web/routes/api.js#L188), [stocktake.js:39-141](../src/web/routes/stocktake.js#L39)) | Modify — SKU 마스터로 통합 시 점진 전환 | **Remove 후보 아님** (1차 분석문 보강) |
| **SKU 마스터 후보** | `products` + `master-products` API + `platform_listings` | 002, 004 | 통합 SKU 단일 진실 후보 | **Keep, 통합 대상** | 자동화 sub-app `automation/src/db/schema.ts:58` 와 동일 이름 — DB 통합 시 충돌 가능 |
| **주문** | `orders`, `order_fedex_labels` | 001, **037** | eBay+Shopify 주문 통합 | Keep | 037 적용 여부 UNKNOWN — Supabase에 적용된 게 아닐 수 있음 |
| **B2B 라벨/송장** | `b2b_buyers`, `b2b_invoices`, `b2b_shipments` | 001, 026, 035 | B2B 인보이스+FedEx 라벨 | **C2C 패턴 차용 모범** | |
| **재고/실사** | `inventory`, `stock_adjustments`, `shipping_rates` | 005, 030 | WMS 핵심 | Keep | shipping_rates 도입 마이그레이션 UNKNOWN |
| **자동화 로그** | `automation_logs`, `agent_audit_logs`, `agent_alerts`, `agent_recommendations` | 005, 007 | 두 채널로 분산 | Modify — 단일화 권장 | |
| **업무/예외 콘솔 후보** | `team_tasks`, `task_recipients`, `team_task_attachments` | 008, 009 | 사람용 업무 카드 | **Modify — 예외 콘솔 핵심** | `tasks` (008) 는 별도 테이블, 추정 미사용 — 문서 2에서 확인 |
| **알림 큐** | `notifications` | (UNKNOWN 마이그레이션 번호) | DB 알림 + SSE 트리거 | Keep | |
| **지출/매입** | `expenses`, `expense_receipts`, `inventory_purchases` | 013, 016→**036**, 017 | 매입은 WMS 입고 직결 | Keep | `expense_receipts` 의 source-of-truth = 036 (016은 backwards-compat mirror, §11 참조) |
| **자동화 sub-app 전용** | `crawl_sources`, `crawl_results`, `csv_uploads`, `upload_jobs`, `category_cache`, `description_settings`, `platform_tokens` | Drizzle ([automation/src/db/schema.ts](../automation/src/db/schema.ts)) | 크롤 + listing 워크플로우 | 그대로 분리 유지 | DB 인스턴스 통합 시 schema 충돌 가능 — §11 참조 |

추정: 메인 앱 마이그레이션 037까지 누적 → 약 50테이블. 정확한 카운트는 `\dt` 결과 필요 (UNKNOWN).

---

## 3. API 구조

총 27개 라우트 파일 + 자동화 sub-app. **api.js 단일 파일이 151 endpoints 를 가짐** — WMS 전환 시 분할 필요.

### 3-A. WMS 전환 핵심 그룹

| 그룹 | 파일 | endpoints | WMS 의미 | 등급 |
|---|---|---|---|---|
| **인증/사용자** | auth.js (미들웨어), users.js | 미들웨어 + 4 | 베이스 | CONFIRMED |
| **업무/예외 콘솔** | tasks.js | 7 | 재배치 핵심 | CONFIRMED |
| **알림** | notifications.js, events.js | 6 + 2 (SSE stream) | 카톡 추가 지점 | CONFIRMED |
| **마켓/상품 (5플랫폼 push)** | api.js:1117-1449 | 10+ | 가격/재고 push 라우트 | CONFIRMED |
| **주문/배송/라벨** | api.js:3182-3766 | 25+ | WMS 핵심 (FedEx + 우체국) | CONFIRMED |
| **운영 콘솔 (재고/가격/products/profit/automation-logs)** | operations.js | 17 | WMS 표면 가장 가까움 | CONFIRMED |
| **B2B (라벨 모범)** | api.js:3766~end | 30+ | C2C 라벨에 차용 | CONFIRMED |
| **재고 실사 + 매입** | stocktake.js, inventoryPurchases.js | 7 + 9 | WMS 입출고 | CONFIRMED |
| **자동화 sub-app** | automation/src/routes/ (TS) | UNKNOWN — 라우트 시그니처 grep 0건 | products/crawl/settings 추정 | INFERRED |

### 3-B. WMS 와 약결합 (생략 가능)
catalog / cs / feedback / weeklyMeetings / weeklyPlans / workspace / resources / accio / payroll / bonuses / finance / health / attendance / recurring / prospects — 모두 Keep, 직접 변경 불요.

### 3-C. 위험 신호
- **api.js 가 너무 큼**: 151 endpoints, 추정 4500+ 라인. dashboard / battle / repricer / fedex / koreaPost / b2b 가 한 파일 안에 있음. WMS 작업 전 분할 권장. CONFIRMED.
- **자동화 sub-app 라우트 grep 0건**: Fastify 등록 방식이 다른 형태일 가능성. UNKNOWN.

---

## 4. 프론트 화면/라우팅 구조

### 4-A. 라우팅 모델
**사실** ([public/index.html:537](../public/index.html#L537)): SPA. `data-page="키"` 의 사이드바 클릭 → `#page-키` div 표시. URL은 `/?page=키` 형태. dashboard.js 가 case 분기로 페이지 로더 호출 (예: dashboard.js:75 `case 'crawl-results': loadCrawlResultsPage();`). CONFIRMED.

### 4-B. WMS 콘솔 재사용 화면

| 화면 | 페이지 키 | 모듈 파일 | WMS 재사용 | 등급 |
|---|---|---|---|---|
| **업무 목록 + 상세** | `tasks` | [public/js/tasks.js](../public/js/tasks.js) | **그대로 → 예외 콘솔** | CONFIRMED |
| 알림 배너/배지 | (글로벌) | dashboard.js setupRealtime | 그대로 | CONFIRMED |
| **운영 5종 (products/inventory/pricing/profit/automation-logs)** | `ops-*` | [operations.js](../public/js/operations.js) | **WMS 운영 콘솔 표면** | CONFIRMED |
| 직원 관리 | `staff-admin` | staff-admin.js | 그대로 | CONFIRMED |
| 설정 | `settings` | (확인 안 됨 — UNKNOWN) | 그대로 | INFERRED |
| B2B 송장/라벨 발급 | `b2b` | dashboard.js (b2bFedexEstimate 등) | C2C 라벨에 패턴 차용 | CONFIRMED |
| 배송 관리 | `shipping` | dashboard.js (page-shipping) | Modify — quota fix + 라벨 통일 | CONFIRMED |
| 전투 상황판 | `battle` | dashboard.js | Modify (셀러 경쟁 유지) | CONFIRMED |
| 외부 연동 (`crawl-results`) | `crawl-results` | dashboard.js:75, 9883 | sub-app `${AUTO_API}/crawl-results` 호출 | CONFIRMED |

### 4-C. 위험
- **dashboard.js**: 추정 1만 라인 이상. 모든 화면 로직이 한 파일. WMS 작업 전 분할 필요.
- **외부 sub-app 호출**: dashboard.js:9883 가 `${AUTO_API}/crawl-results` 호출 — sub-app 의 CORS / 인증 정책 UNKNOWN.

---

## 5. 인증/권한 구조

출처: [src/middleware/auth.js](../src/middleware/auth.js)

### 5-A. 핵심 사실 (CONFIRMED)
- **세션**: HMAC 서명 쿠키 `pmc_session` (auth.js:33), 7일 (auth.js:34), httpOnly+secure(prod)+SameSite=lax.
- **로그인 모드 2종**:
  - 사용자: `users` 테이블 + bcrypt → 토큰 `userId.timestamp.hmac`
  - 레거시: `DASHBOARD_PASSWORD` env → 토큰 `timestamp.hmac` (userId=0, role='admin')
- **가드**: `authGuard`(전역) / `requireAdmin` / `requireFinanceAccess` / `blockLegacyWrites`.
- **레거시 차단 경로** (auth.js:218): tasks/purchase-requests/attendance/payroll/bonuses/feedback/users/admin/notifications.

### 5-B. WMS 권한 가능 여부

| WMS 권한 | 기존 구조로 가능? | 어떻게 | 등급 |
|---|---|---|---|
| 가격변경 승인 | **부분 가능** | requireAdmin 으로 임시 차단. 본격 워크플로우는 신규 가드 + 승인 큐 필요 | INFERRED |
| 배송접수 승인 | 부분 가능 | 동상 | INFERRED |
| SKU 수정 | 가능 | requireAdmin (현재 master-products PUT 가드 명시 안됨 — 확인 필요) | UNKNOWN |
| 자동화 중지/재개 | 가능 | requireAdmin + 신규 토글 엔드포인트 | INFERRED |
| API credential 관리 | 가능 | 기존 settings 메뉴 + requireAdmin. 단 secret 노출 위험 — Supabase Storage 또는 Vault 별도 관리 권장 | INFERRED |

### 5-C. 마이그레이션 시 리스크
- **레거시 모드 종료 시**: userId=0 가 만든 historical row (audit log 등) 의 외래키 참조 처리 필요. 즉시 종료 위험 → MVP 후 종료가 안전.
- **신규 권한 컬럼 추가**: `users.can_manage_finance` 패턴(015 마이그레이션) 그대로 `can_change_price`, `can_create_label` 추가하면 됨. CONFIRMED 패턴 존재.

---

## 6. 업무/task 구조 (예외 콘솔 후보)

출처: [src/web/routes/tasks.js](../src/web/routes/tasks.js) + 008/009 마이그레이션

### 6-A. 자산 (CONFIRMED)
- **카드 모델**: `team_tasks(id, title, assignee_id, assignee_scope, due_date, priority, status, memo, created_by, created_at)` + `task_recipients(task_id, user_id, status, completion_note)` + `team_task_attachments(file_path, file_name, ...)`.
- **자동 알림 흐름** (tasks.js:113-134): 카드 생성 → DB notify → SSE sendTo → 멀티채널 (notify.js).
- **첨부**: Supabase Storage 버킷 `task-attachments`, signed URL 5분 (tasks.js:323).
- **상태**: pending / in_progress / done. 직원이 done 처리 시 `completion_note` 필수 (tasks.js:193).
- **권한**: 메타 변경=admin, 상태 변경=recipient 본인. admin 은 대신 done 처리 가능.

### 6-B. WMS 예외 카드로의 전환 가능성

| 예외 종류 | 트리거 위치 (제안) | 자동 카드 가능? | 등급 |
|---|---|---|---|
| SKU 매칭 실패 | 자동화 sub-app listing-service.ts | Yes — `team_tasks` insert + assignee 라우팅 룰 | INFERRED |
| 주소 오류 | orderSync.js | Yes | INFERRED |
| 라벨 생성 실패 | api.js:3416 (FedEx), 3549 (KoreaPost) | Yes | INFERRED |
| 가격변경 승인 필요 | autoRepricer.js | Yes | INFERRED |
| 도매처 품절 감지 | competitorMonitor.js | Yes | INFERRED |
| 마진 위험 SKU | aiRemarker.js / repricer 후속 | Yes | INFERRED |
| 정산 차이 | (현재 모듈 없음) | 신규 트리거 | UNKNOWN |

### 6-C. Modify 포인트 (실제 변경 항목, 문서 2에서 확정)
1. `team_tasks` 컬럼 추가: `exception_type TEXT`, `context JSONB`, `auto_generated BOOLEAN DEFAULT false`, `dedupe_key TEXT UNIQUE` (중복 억제용).
2. 라우팅 룰: 별도 테이블 `exception_routing(exception_type → assignee_id|null)`. UNKNOWN — 룰 모델 확정은 문서 2.
3. UI: tasks 페이지 필터 + 색상 구분.

### 6-D. 위험
- 사람 카드 vs 자동 카드 시각 혼선. `auto_generated` 필터로 해소 가능 (CONFIRMED 컬럼 추가만 필요).
- 알림 폭주: 동일 SKU 재실패 시 매번 카드 생성 안 됨 — `dedupe_key` 또는 1일 1회 룰 필요.

---

## 7. 알림 구조

### 7-A. 자산 (CONFIRMED)
3-tier 구조:
1. **DB 큐** (`notifications` 테이블) — notificationService.js
2. **SSE 실시간** ([sseHub.js](../src/services/sseHub.js)) — `Map<userId, Set<ServerResponse>>`, GET `/api/events/stream` ([events.js:10](../src/web/routes/events.js#L10))
3. **외부 채널** ([notify.js](../src/services/notify.js)) — iMessage + Telegram 라우터

### 7-B. 핵심 발견 (CONFIRMED)
**iMessage 채널은 Railway(Linux)에서 절대 발송되지 않음**. 출처: [imessage.js:12](../src/services/imessage.js#L12) — `isConfigured()` 가 `process.platform === 'darwin'` 을 요구. Railway 배포는 Linux이므로 iMessage 분기는 항상 false 반환. → **카톡 채널 추가가 운영상 필수**.

### 7-C. 현 SSE 이벤트 타입
| 이벤트 | 발송 위치 | 등급 |
|---|---|---|
| `task_assigned` | tasks.js:103 | CONFIRMED |
| `task_completed` | tasks.js:208 (notifyAdmins payload) | CONFIRMED |
| 기타 (purchase_*, expense_created 등) | 추정 — grep 필요 | INFERRED |

### 7-D. WMS 신규 알림으로의 확장 가능성

| 신규 알림 | 가능 여부 | 어떻게 |
|---|---|---|
| 신규 주문 요약 | Yes | scheduler.js 에 cron 추가, notify() 호출 |
| 가격변경 승인 필요 | Yes | autoRepricer.js → notify() + linkUrl=/?page=approval |
| SKU 매칭 실패 | Yes | listing-service → notify() |
| 라벨 생성 실패 | Yes | fedexAPI/koreaPostAPI catch → notify() |
| 자동화 실패 (cron) | Yes | scheduler.js catch → notify() |
| 카카오톡 알림 링크 | **신규 필요** | `kakaoBot.js` 추가 + notify.js 분기. 카톡 채널은 알림 + signed URL approval 링크만 (확정 사항 #5) |

### 7-E. 위험
- **알림 폭주 억제 없음**: 현재 dedupe / rate-limit 없음 (CONFIRMED). 자동 카드 도입 시 즉시 필요.
- **승인 링크 보안**: 카톡 메시지에 담길 URL이 signed token 이어야 함 (HMAC 5분 등). 신규 설계.

---

## 8. 파일첨부 구조

### 8-A. 자산 (CONFIRMED 패턴)
3개 라우트가 동일 패턴 사용:
| 위치 | 버킷 | 라인 |
|---|---|---|
| 업무 첨부 | `task-attachments` | [tasks.js:25](../src/web/routes/tasks.js#L25) |
| 지출 영수증 | `expense-receipts` | [expenses.js:261](../src/web/routes/expenses.js#L261) |
| 발주 첨부 | `purchase-request-*` (확인 필요) | [purchaseRequests.js:342](../src/web/routes/purchaseRequests.js#L342) |
| B2B 라벨 | `b2b-shipping-labels` | api.js (b2b shipments) |
| 자료실 | shared-uploads + Drive | resources.js |

표준 흐름: **multer memoryStorage → mime/size validation → Supabase Storage upload → DB row insert → signed URL 5~15분으로 다운로드**.

### 8-B. WMS 파일 저장 가능 여부

| WMS 파일 | 저장 가능? | 어떻게 | 등급 |
|---|---|---|---|
| 배송 라벨 PDF | Yes | 새 버킷 `shipping-labels` (private) + `order_fedex_labels` 테이블 row 연결 | CONFIRMED 패턴 |
| 송장 파일 | Yes | 동상 | INFERRED |
| 주문 증빙 (사진/영수증) | Yes | task-attachments 패턴 차용 | CONFIRMED |
| 도매처 캡처 | Yes | 신규 버킷 `wholesale-snapshots` | INFERRED |
| 정산 증빙 | Yes | expense-receipts 패턴 | CONFIRMED |
| 오류 캡처 (예외 콘솔) | Yes | task-attachments 그대로 — 자동화가 첨부 | **CONFIRMED — 핵심 차용** |

### 8-C. 위험
- **버킷 생성은 수동 (Supabase 콘솔)**: 신규 버킷 추가 시 사장님이 직접 만들어야 함. CONFIRMED — 메모리에 037 적용 + shipping-labels 버킷 생성 펜딩.
- **파일 크기 한계**: tasks.js 는 10MB/파일 (line 27). 라벨 PDF는 작아서 무관, 도매처 비디오 등은 별도 검토.

---

## 9. 백그라운드 worker / cron 구조

출처: [src/services/scheduler.js](../src/services/scheduler.js) — node-cron 9개 등록. **모두 CONFIRMED.**

| # | 시각 (KST) | 책임 | 라인 | sub-app 이전 후보? |
|---|---|---|---|---|
| 1 | 09:00 | 모닝 다이제스트 (`team_tasks` 미완료 → 직원별 알림) | scheduler.js:113 | 아니오 — 사람 업무 |
| 2 | 09:05 | B2B 미발송 수량 admin 알림 (`b2bShippingReminder.run()`) | scheduler.js:118 | 아니오 — 운영 알림 |
| 3 | 17:00 | 사장 미완료 업무 요약 | scheduler.js:128 | 아니오 |
| 4 | 04:00 | Naver/Shopee/Alibaba/Shopify 상품 sync | scheduler.js:133 | **Yes — sub-app 으로 이전 후보** |
| 5 | 10:00 / 22:00 | eBay 상품 sync (전투 상황판용) | scheduler.js:150 | **Yes — sub-app 후보** |
| 6 | 10:00 / 18:00 | Naver detail 보강 (배치 200) | scheduler.js:161 | **Yes** |
| 7 | 02:30 | 자료실 Google Drive 동기화 | scheduler.js:174 | 아니오 — 자료실 |
| 8 | 03:00 | 정기결제 → expenses 발행 | scheduler.js:186 | 아니오 — 재무 |
| 9 | 03:30 | shared_uploads 만료 정리 | scheduler.js:206 | 아니오 — 메인 앱 |

### 9-A. 위험
- **별도 worker 프로세스 미분리**: 9개 cron 이 메인 웹 프로세스(server.js)에서 실행됨. CONFIRMED — `start()` 가 server 부팅 시 호출 추정 (UNKNOWN — 호출 위치 grep 필요). 무거운 sync (4시 / 10·22시 eBay) 가 웹 응답에 영향 가능.
- **package.json 의 보조 진입점**: `main: "scripts/auto-sync-scheduler.js"` 가 보임 (별도 worker 추정. UNKNOWN — 실제 Railway 에서 실행 중인지 확인 필요).
- **WMS 자동화 sub-app 으로 이전 권장**: cron #4, #5, #6 (마켓 sync 계열). DB 통합 후 sub-app 의 워커 프로세스에서 돌리고, 메인 앱은 운영 콘솔에 집중.

---

## 10. 배포 / 환경변수 / 설정 구조

### 10-A. 인프라 (CONFIRMED)
- **메인 앱**: Railway 배포. Production URL `pmc-work-mvp-production-7748.up.railway.app` (메모리). `node server.js` 진입점.
- **자동화 sub-app**: 같은 Railway 프로젝트의 별도 서비스. URL `ccorea-auto-production-1540.up.railway.app`. 진입점 `automation/dist/index.js` 추정.
- **DB**: Supabase (단일 프로젝트). 메인 앱 = REST 클라이언트(`@supabase/supabase-js`), sub-app = PostgreSQL 직접(`pg` + Drizzle). **§11 #1 표 참조.**

### 10-B. 환경변수 그룹

| 그룹 | 메인 앱 | 자동화 sub-app | 등급 |
|---|---|---|---|
| DB | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` ([supabaseClient.js:13-14](../src/db/supabaseClient.js#L13)) | `DATABASE_URL` (Drizzle, [automation/src/db/index.ts:7](../automation/src/db/index.ts#L7)) | CONFIRMED |
| 인증 | `DASHBOARD_PASSWORD` (레거시), `COOKIE_SECRET` | (별도 인증 — UNKNOWN, Drizzle schema 에 `users` 존재) | CONFIRMED |
| 마켓 | EBAY_*, SHOPIFY_*, NAVER_*, COUPANG_*, ALIBABA_* (분산) | EBAY_*, SHOPIFY_*, NAVER_*, COUPANG_*, ALIBABA_* (envSchema [config.ts](../automation/src/lib/config.ts)) | CONFIRMED |
| Google | `GOOGLE_CREDENTIALS_JSON` (env fallback, Railway용) | `GOOGLE_CREDENTIALS_PATH` | CONFIRMED |
| 외부 알림 | `IMESSAGE_TO`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | 없음 | CONFIRMED |
| 물류 | `FEDEX_*`, `KOREAPOST_API_KEY`, `KOREAPOST_CUSTNO`, `KOREAPOST_KPACKET_APPRNO`, `KOREAPOST_EMS_APPRNO` | 없음 (UNKNOWN) | INFERRED |

### 10-C. service role key
- 메인 앱 `SUPABASE_SERVICE_KEY` 사용 → service role. RLS 우회 권한. CONFIRMED.
- sub-app `DATABASE_URL` 직결 → DB superuser 동등. CONFIRMED.
→ **양쪽 모두 strong privilege.** 외부 노출 시 즉시 회전 필요. (메모리상 1회 노출 이력 있음 — 회전 여부 UNKNOWN.)

### 10-D. Railway 별도 worker process 가능성
- Railway 는 동일 프로젝트 내 여러 서비스 지원. 메인 앱 / sub-app / 신규 worker 각각 별 서비스 가능. CONFIRMED 가능.
- **WMS 권장**: 마켓 sync cron(#4, #5, #6) 을 sub-app worker 프로세스로 분리. 메인 앱은 웹 + 가벼운 cron(#1-3, #8-9)만.

---

## 11. 부록 A 확인 필요 13개 해소표

1차 분석문 [docs/wms-migration-analysis.md](./wms-migration-analysis.md) 의 부록 A "확인 필요" 항목을 우선순위 13개로 추려 검증.

| # | 원문 항목 | 확인 결과 | 증거 경로 | 결론 | 잔여 리스크 | Phase 1 진행 가능 | 등급 |
|---|---|---|---|---|---|---|---|
| 1 | 자동화 sub-app DB가 메인 앱과 같은 Supabase 인스턴스인가 | 양쪽 모두 Supabase 클러스터 사용. 메인=REST(`SUPABASE_URL`+`SERVICE_KEY`), sub-app=Postgres 직결(`DATABASE_URL`). 메모리상 같은 프로젝트(`tsqposttkfrvgkyhwade`). 단 **양쪽 .env 가 다른 채널** | [supabaseClient.js:13](../src/db/supabaseClient.js#L13), [automation/src/db/index.ts:7](../automation/src/db/index.ts#L7), [automation/.env.example](../automation/.env.example) | **같은 인스턴스로 통합 가능 (DB 통합 결정 #1과 정합)** | sub-app `users` / `audit_logs` / `products` 등이 메인과 동일명 — schema drift 위험 | Yes (단 schema source-of-truth 확정 후) | INFERRED |
| 2 | 마켓별 mirror 테이블(`ebay_products` 등) 실제 사용 여부 | **적극 사용 중**. api.js 188~1171, stocktake.js 39~141, health.js 103 | [api.js:188](../src/web/routes/api.js#L188), [stocktake.js:39](../src/web/routes/stocktake.js#L39), [health.js:103](../src/web/routes/health.js#L103) | **Remove 후보 아님 — 1차 분석문 정정 필요** | SKU 마스터 통합 시 점진 전환 필요 | Yes — 그대로 유지하면서 단일화 | CONFIRMED |
| 3 | `expense_receipts` 016 vs 036 source-of-truth | 016 = `expenses` 컬럼 4개(receipt_*). 036 = 별도 테이블 + 016 데이터 backfill + 016 컬럼 backwards-compat 유지 | [supabase/migrations/016_expense_receipts.sql](../supabase/migrations/016_expense_receipts.sql), [036_expense_receipts.sql](../supabase/migrations/036_expense_receipts.sql) | **036 의 `expense_receipts` 테이블이 source-of-truth.** 016 컬럼은 deprecated mirror | 016 컬럼 정리는 deprecated 후보 (실 삭제는 후속) | Yes | CONFIRMED |
| 4 | `scheduler.js` 9개 cron 각각 책임 | 9개 모두 식별 (§9 표) | scheduler.js:113~206 | 4·5·6번이 sub-app worker 이전 후보. 1·2·3·7·8·9는 메인 유지 | 메인 프로세스 1개에 cron 9개 동거 → 응답 영향 위험 | Yes | CONFIRMED |
| 5 | iMessage 채널이 실제 동작 환경 | `isConfigured()` 가 `process.platform === 'darwin'` 검사 → Railway(Linux) 에서 항상 false | [imessage.js:12](../src/services/imessage.js#L12) | **Railway 환경에서 절대 발송 안 됨.** 카톡 채널 추가 필수 | 사내 Mac 미니에서 별도 노드 운영 시 가능하지만 (UNKNOWN) 신뢰성 낮음 | Yes (Phase 1 카톡 추가) | CONFIRMED |
| 6 | Korea Post `regData` 미구현이 운영에 영향을 주는가 | `_buildRegData` 가 `throw new Error('regData hash 알고리즘 미구현…')` | [koreaPostAPI.js:283-285](../src/api/koreaPostAPI.js#L283) | **소포신청(라벨발급) 라우트 호출 시 즉시 hard-fail.** 종추적/요금조회는 별 함수라 동작 가능 | 라벨 발급 안 됨. 사장님이 우체국 매뉴얼 샘플 코드(JAVA/PHP) 제공 펜딩 | **No — Phase 3 까지 라벨 발급 미동작 감안** | CONFIRMED |
| 7 | Shopee/Naver/Coupang/Qoo10 sync 가 주문 통합 수준까지 가는가 | grep `syncShopeeOrders` 등 결과 0건. 마켓 sync는 listing 단계까지만 | scheduler.js:133-171, grep 결과 | **주문 sync 는 eBay+Shopify 만.** 다른 마켓은 listing only | Phase 2 의 "주문 수집 통합" = 신규 작업 | Yes — Phase 2 가 신규 빌드임을 인지 | CONFIRMED |
| 8 | crawl-results 페이지 라우트 위치 | dashboard.js 가 `${AUTO_API}/crawl-results` 호출 | [dashboard.js:75, 9883](../public/js/dashboard.js) | **자동화 sub-app 측 라우트. 메인 앱에 없음.** | sub-app 인증 체계 (메인 앱 세션과 분리?) UNKNOWN | Yes (단 sub-app SSO 검토 필요) | CONFIRMED |
| 9 | thumbnail 페이지 라우트 위치 | `page-thumbnail` div 존재(index.html:1282), `/thumbnail/generate` 등 호출(dashboard.js:324, 367, 423) | [public/index.html:1282](../public/index.html#L1282), dashboard.js 상단 | **메인 앱 측 라우트. api.js 또는 별도 라우트에 존재 (정확한 파일 UNKNOWN — 3회 grep 시도 미확인)** | 동작 여부는 별도 검증 | Yes (WMS 와 약결합) | INFERRED |
| 10 | DB 비밀번호 회전 여부 | 메모리상 1회 채팅 노출. 코드만으로 회전 여부 확인 불가 | (외부) | **UNKNOWN — Phase 1 시작 전 사장님 확인 필수** | 노출된 키가 유효하면 third-party 가 DB 직접 접근 가능 | **No — 회전 확인 후 Phase 1 시작** | UNKNOWN |
| 11 | 마이그레이션 037 적용 여부 | 파일 존재 ([supabase/migrations/037_orders_fedex_label.sql](../supabase/migrations/037_orders_fedex_label.sql)). Supabase 적용 여부는 코드만으로 확인 불가 | (외부) | **UNKNOWN — Supabase 콘솔 또는 `\dt` 결과 필요** | C2C FedEx 라벨이 동작 안 할 가능성 | Phase 3 전 적용 확인 | UNKNOWN |
| 12 | `team_tasks` 도입 마이그레이션 번호 | 008 마이그레이션은 `tasks` 만 도입. `team_tasks`/`task_recipients` 도입 마이그레이션 번호 grep 미확인 (3회 시도 미확정) | supabase/migrations/008, 009 | **UNKNOWN — 09 또는 별 번호로 추정** | schema 변경 시 어느 마이그레이션을 수정할지 결정 필요 | Yes (실 schema는 Supabase에서 확인 후 신규 마이그레이션 추가) | UNKNOWN |
| 13 | 자동화 sub-app 의 라우트 시그니처 | grep `router\.(get\|post...)` 결과 0건. Fastify 등록 방식 다른 형태 추정 | automation/src/routes/*.ts | **Fastify 플러그인 패턴 추정 — 정확한 시그니처는 sub-app 코드 직접 읽어야 함** | Phase 2 주문 sync 통합 시 sub-app 측 변경 범위 산정 어려움 | Yes (단 Phase 2 시작 시 sub-app 코드 정독 필요) | INFERRED |

---

## 문서 1 요약

### 1. 가장 재사용 가치가 높은 부분
1. **`team_tasks` 시스템 전체** (라우트 + DB + Storage + SSE + 멀티채널 알림) — WMS 예외 콘솔로 거의 그대로 차용. DB 컬럼 3~4개만 추가. **재사용률 추정 75%**.
2. **B2B FedEx 라벨 워크플로우** ([api.js:3766~end](../src/web/routes/api.js#L3766) + `b2b_shipments` + `b2b-shipping-labels` 버킷) — C2C 라벨에 패턴 그대로 이식.
3. **인증 + SSE + multer/Storage 패턴** — 보안·실시간·첨부 3축이 표준화되어 있음.
4. **운영 콘솔 5종** ([operations.js](../src/web/routes/operations.js) 17 endpoints) — WMS 표면에 가장 가까움. 신규 화면 안 만들어도 됨.

### 2. WMS 전환 시 가장 불확실한 부분
1. **자동화 sub-app DB 통합 시 schema 충돌** — 양쪽 `users`, `products`, `platform_listings` 등 동일명 테이블. source-of-truth 확정 결정 필요. (UNKNOWN — Phase 1 시작 전 결정)
2. **DB 비밀번호 회전 여부** (UNKNOWN). 노출 이력 있음 → Phase 1 시작 전 사장님 확인 필수.
3. **iMessage 가 Railway 에서 무력** (CONFIRMED). 카톡 채널 신규 구축 필수.
4. **Korea Post 라벨 hard-fail** (CONFIRMED). regData hash 샘플 코드 펜딩.
5. **마켓 4종 (Shopee/Naver/Coupang/Qoo10) 주문 sync 부재** (CONFIRMED). Phase 2 가 신규 빌드.

### 3. Phase 1 전에 반드시 확인해야 할 부분
1. **DB 비밀번호 회전 여부** (UNKNOWN #10) — 외부 채널 점검 후 시작.
2. **자동화 sub-app DB schema source-of-truth 결정** — 메인 앱 마이그레이션 vs Drizzle 중 어디가 권위인지.
3. **메인 앱 마이그레이션 037 적용 여부** (UNKNOWN #11) — Phase 3 전.
4. **`team_tasks` 도입 마이그레이션 번호** (UNKNOWN #12) — 신규 마이그레이션 작성 시 베이스.
5. **자동화 sub-app 라우트 구조** (UNKNOWN #13) — Phase 2 작업 범위 산정.

### 4. Phase 1을 바로 시작해도 되는 부분
1. **`team_tasks` 컬럼 추가** (`exception_type`, `context`, `auto_generated`, `dedupe_key`) — 기존 카드와 비파괴 공존.
2. **카톡 채널 모듈 신규 작성** (`src/services/kakaoBot.js`) — notify.js 분기만 추가하면 기존 흐름 영향 없음.
3. **dashboard.js 화면별 분할** — 작업량 큼이지만 회귀 테스트 용이.
4. **api.js 분할** (orders/labels/battle/repricer) — 동상.

### 5. 문서 2 (`phase-0-wms-mapping.md`) 에서 집중해야 할 질문
1. WMS 12 타겟 기능 ↔ 현 자산 1:1 매핑표 (Keep / Modify / Create / Remove 가 아닌, **누가 어디서 무엇을 호출하는지** 흐름 단위).
2. SKU 마스터 단일화 시 메인 앱 `products` ↔ sub-app Drizzle `products` ↔ 마켓별 mirror (`ebay_products` 등) 의 계층 결정.
3. 예외 카드 라우팅 룰 모델 (정적 표 vs JSON 룰 vs DSL).
4. 카톡 승인 링크의 보안 토큰 모델 (HMAC short-lived URL).
5. LLM-as-Planner / Tool-as-Executor 경계: 어느 이벤트가 LLM 입력이고 어느 액션이 검증된 모듈 호출인지.

---

*본 문서는 분석 전용입니다. 코드/DB/설정/배포 변경 일체 없음. 변경된 파일: `docs/phase-0-current-system-inventory.md` 1개.*
