# Phase 0 — 문서 3: 리스크 및 기술 부채

> 작성일: 2026-05-08 · 모드: read-only 분석 · 코드/DB/설정 변경 없음
> 입력 문서: `docs/wms-migration-analysis.md`, `docs/phase-0-current-system-inventory.md` (문서 1), `docs/phase-0-wms-mapping.md` (문서 2)
> 목적: Phase 1 시작 전 차단 항목, MVP 범위 안에서 감수할 리스크, 장기 tech debt 를 분리하여 의사결정.
> 본 문서는 백과사전이 아니라 **리스크 의사결정 문서**.
> 증거 등급: **CONFIRMED** — 코드/DB 직접 확인 / **INFERRED** — 흐름 추론 / **UNKNOWN** — 코드만으로 확정 불가.

---

## 0. 컨텍스트 (확정 사항 v3)

문서 1·2 의 결정에 더해 본 문서 작성 시점에 확정된 항목:

| # | 결정 | 출처 | 본 문서 영향 |
|---|---|---|---|
| 1 | 자동화 sub-app은 합치지 않음 — DB 통합 + 프로세스 분리 | 문서 1 §0 | 양 schema drift 가 영구 리스크 (§4.4) |
| 2 | 메인 앱 = WMS 운영/예외 콘솔, sub-app = worker | 문서 1 §0 | DB jobs polling 모델이 자연스러움 |
| 3 | LLM-as-Planner / Tool-as-Executor | 문서 1 §0 | LLM 출력 신뢰성/감사 로그가 신규 리스크 (§7.4) |
| 4 | MVP = Phase 0~3, 가격/배송/라벨 실행은 Phase 4 | 문서 1·2 | "MVP 가치 한계" 질문이 핵심 (§3.5) |
| 5 | 카톡 = Phase 1.5 또는 Phase 2 후보, Phase 1 필수 아님 | **사용자 추가 확정** | 카톡 승인 토큰 모델 설계는 Phase 2에 풀어도 됨 (§3.6) |
| 6 | SKU 마스터 = 신규 `sku_master` 테이블 신설 (B 옵션) | **사용자 추가 확정** | 기존 `products` 와의 동거 리스크 핵심 (§3.1) |
| 7 | dashboard.js / api.js 분할은 Phase 4 이후 tech debt | **사용자 추가 확정** (해석) | Phase 1~3 동안 회귀 위험 감수 (§3.7) |
| 8 | shared table schema 권위 = 메인 앱 `supabase/migrations/*.sql` | 문서 2 §0 | sub-app Drizzle 변경 금지 룰 (§4.4) |
| 9 | DB 비밀번호 노출 외부 처리 완료 | 문서 2 §0 (CONFIRMED by owner) | Phase 1 차단 리스크에서 제외 |
| 10 | migration 037 적용된 것으로 가정 | 문서 2 §0 (OWNER_DECIDED) | C2C 라벨 작업 시 lazy-fail 으로 감수 |

---

## 1. 분류 모델

### 1-A. 리스크 등급

| 등급 | 정의 | 처리 |
|---|---|---|
| **BLOCKER** | Phase 1 시작 자체가 막힘 | 시작 전 해소 필수 |
| **HIGH** | Phase 1~3 진행 중에 운영 사고 가능 | Phase 1 안에서 가드 마련 |
| **MEDIUM** | MVP 가치를 직접 깎지는 않으나 누적되면 막힘 | MVP 안에서 backlog 관리 |
| **LOW** | 장기 SaaS 화 단계 부담 | Phase 4 이후 / tech debt |

### 1-B. 기술 부채 우선순위 (문서 2 §1.2 와 동일 기준)

1=Phase 1 핵심 / 2=Phase 2 핵심 / 3=Phase 3 핵심 / 4=Phase 4 이후 / 5=장기 SaaS 화

---

## 2. Phase 1 시작 차단 리스크 (BLOCKER)

문서 1 §11 에 UNKNOWN 으로 남았던 항목 중, 사용자 추가 확정으로 다수가 해소됨. 잔여 BLOCKER 검토.

| # | 리스크 | 현 상태 | 해소 조건 | 등급 | 등급 |
|---|---|---|---|---|---|
| 2-1 | DB 비밀번호 노출 회전 | 외부 처리 완료 (문서 2 §0) | 해소됨 — 단, secret 로깅 금지 룰은 §6 으로 | 해소 | CONFIRMED by owner |
| 2-2 | shared table schema source-of-truth | 메인 앱 migration 권위 (문서 2 §0) | 해소됨 — 단, drift 모니터링 룰 필요 (§4.4) | 해소 | CONFIRMED by owner |
| 2-3 | `team_tasks` 도입 마이그레이션 번호 | grep 미확인 (문서 1 #12). 008 은 `tasks`(별 테이블), 009 는 `team_task_attachments` 만 추가하면서 `team_tasks(id)` 를 reference | Supabase 콘솔에서 `\d team_tasks` 또는 `pg_dump -s -t team_tasks` 1회 실행 | **HIGH (해소 권장)** | UNKNOWN |
| 2-4 | migration 037 (orders FedEx 라벨) 적용 여부 | 적용 가정 (문서 2 §0) | Phase 3 시작 직전에 `\dt orders` + `\d order_fedex_labels` 확인 | LOW (Phase 3 직전 차단) | UNKNOWN |
| 2-5 | sub-app 라우트 시그니처 (Fastify 등록 패턴) | grep 0건 (문서 1 #13) | Phase 2 시작 직전 sub-app `automation/src/index.ts` + `automation/src/routes/*.ts` 정독 | LOW (Phase 2 직전 차단) | INFERRED |

### 결론
**Phase 1 즉시 차단 항목은 2-3 한 개**. 나머지는 Phase 2/3 직전 가드. 2-3 도 schema 확인 1회면 끝나므로 시작 자체는 막지 않으나, 신규 마이그레이션 번호 결정과 `team_tasks` 컬럼 추가 작업의 기반이 되므로 첫 작업 직전 처리 권장.

---

## 3. 7 핵심 질문 답변 (문서 2 §8.7)

### 3-1. `sku_master` 신규 생성 vs 기존 `products` 확장의 실제 리스크

**확정 사항**: 신규 `sku_master` (옵션 B). 본 문서는 그 결정의 잔여 리스크를 정리.

| 리스크 | 영향 | 등급 | 완화책 |
|---|---|---|---|
| 기존 `products` 와 의미 중첩 | 운영 직원이 두 테이블 중 어디를 봐야 하는지 혼동 | HIGH | UI 에서 `products` 화면을 "마켓 미러 통합 보기" 로 라벨링. SKU 마스터 화면은 별도 진입점 (예: 운영 메뉴 `ops-products` 활용 — 문서 1 §1-G) |
| sub-app Drizzle 의 `products` 와 동일 이름 충돌 | 자동화 워커가 `products` 가 아닌 `sku_master` 를 봐야 하는 흐름 혼동 | HIGH | sub-app Drizzle 에 `sku_master` 정의 추가 (문서 2 §0 의 "shared table 동기화 대상" 룰 적용). `products` 는 마켓 미러 layer 로 격하 |
| 마켓 미러 (`ebay_products` 등) 와 `sku_master` 를 잇는 link table 부재 | Phase 2 의 SKU 매칭 모듈이 referent 가 없어 막힘 | HIGH | Phase 1 안에 `sku_listing_link(sku_id, marketplace, listing_id)` 동시 신설. 단순 join table 1개로 충분 |
| 기존 `master-products` API ([api.js:1117-1266](../src/web/routes/api.js#L1117)) 와 의미 충돌 | "master-products" 단어가 `sku_master` 와 같은 것인지 다른 것인지 모호 | MEDIUM | Phase 1 에서 신규 SKU 마스터 화면은 `/api/sku-master/*` 경로로 분리. 기존 `/api/master-products/*` 는 마켓 미러 통합 보기로 명명 변경 (UI 레이블만, 라우트는 유지) |
| 데이터 backfill 누락 SKU | 일부 마켓 미러 row 가 sku_master 에 매핑 안 됨 | MEDIUM | Phase 1 끝 무렵 "미매핑 SKU" 리포트 화면 + 수동 매핑 UI |

**핵심 판단**: 옵션 B 의 잔여 리스크는 **명명 혼동 4건** 으로 압축됨. 데이터 손실/회귀 리스크는 신규 테이블이라 낮음. 옵션 A (기존 products 확장) 보다 **운영 안전도가 높음** — products 가 이미 마켓 미러 통합 보기로 활성 사용 중이므로, 거기에 SKU 마스터 의미를 덧씌우면 회귀 위험이 큼.

증거 등급: INFERRED (테이블 미생성 상태이므로 코드로 직접 확인 불가).

### 3-2. `team_tasks` 컬럼 확장 시 기존 업무 데이터/화면 영향

**확정 사항** (문서 2 §5): `team_tasks` 에 `auto_generated`, `exception_type`, `context`, `dedupe_key`, `severity`, `related_sku_id`, `related_order_id` 컬럼 추가.

| 리스크 | 영향 | 등급 | 완화책 |
|---|---|---|---|
| 기존 사람 업무 카드의 default 값이 잘못 매핑 | 모든 기존 카드가 `auto_generated=true` 로 표시 | LOW | `DEFAULT false` 명시 — 기존 row 는 자동으로 false |
| 기존 tasks.js GET (filter 없음) 가 자동 카드까지 함께 반환 | 직원이 평소 보던 화면에 자동 카드가 섞여 노출 | **HIGH** | 1단계: `repo.listTasks()` 의 default 가 `auto_generated=false` 만 반환하도록 변경. 2단계: 운영자 권한자에게 별도 "자동 예외" 탭 표시. 코드 변경 위치 = [src/web/routes/tasks.js:54-65](../src/web/routes/tasks.js#L54) + repo 1곳 |
| 자동 카드의 `assignee_id` 가 사라진 직원 (퇴사) 을 가리킴 | FK 위반 또는 orphan 카드 | MEDIUM | 라우팅 룰 적용 시점에 `users.is_active=true` 검증. 비활성이면 admin 폴백 |
| `dedupe_key` UNIQUE 제약이 폐기된 카드 와 충돌 | 동일 SKU 가 한번 처리된 후 다시 발생하면 카드 생성 안 됨 | **HIGH** | UNIQUE 가 아닌 partial index `WHERE status != 'done'` 또는 `dedupe_key + status` 복합. cool-down 룰 (문서 2 §5.4) |
| `context JSONB` 에 secret/PII 가 들어감 | DB dump 시 노출 | HIGH | 자동 생성 트리거 코드에서 secret/카드번호/주소 마스킹 룰. 본 문서 §6 와 연동 |
| 기존 모닝 다이제스트 cron ([scheduler.js:113](../src/services/scheduler.js#L113)) 가 자동 카드까지 직원에게 발송 | 직원이 운영자 영역 카드 받아 알림 폭주 | **HIGH** | 다이제스트 쿼리에 `auto_generated=false` 필터 추가. 자동 카드용 다이제스트는 별도 cron (admin/operator 만) |

**핵심 판단**: 컬럼 추가 자체는 비파괴이지만, **기존 GET / 다이제스트 cron 의 default 동작이 자동 카드까지 노출하면 직원 화면이 망가짐**. 컬럼 추가와 동시에 read 경로 4곳 (tasks.js GET, scheduler.js 다이제스트, 모바일 미사용시 SSE 구독 필터, stats endpoint) 의 default filter 를 동시에 변경해야 함.

증거 등급: CONFIRMED (코드 위치 직접 확인 — tasks.js, scheduler.js).

### 3-3. DB jobs polling 의 중복 실행 / lock / 재시도 / idempotency 리스크

**확정 사항** (문서 2 §6): Phase 1~3 통신 = DB jobs polling 우선.

**현 상태**: 메인 앱에 job/queue/lock 테이블 없음 (CONFIRMED — grep 결과 0건). idempotency 패턴도 없음. **완전 신규 설계**.

| 리스크 | 영향 | 등급 | 설계 권장 |
|---|---|---|---|
| 동일 job 을 여러 worker 가 동시에 처리 | 가격 변경/라벨 발급 중복 실행 → 재무 사고 | **CRITICAL (Phase 4 시작 전)** | `SELECT … FOR UPDATE SKIP LOCKED` 또는 `locked_at + locked_by` 컬럼 + 짧은 TTL. PostgreSQL 표준 패턴이라 신규 라이브러리 불요 |
| worker crash 후 job 영구 lock | job 이 멈춤 | HIGH | `locked_at` 이 stale (예: 5분 초과) 이면 자동 unlock 하는 cron. scheduler.js 에 1줄 추가 |
| 재시도 폭주 | 동일 실패가 무한 재시도 → API rate limit / 카드 폭주 | HIGH | `attempts INT`, `max_attempts` (예: 3), `available_at TIMESTAMPTZ` (지수 백오프). 재시도 한계 도달 시 자동 exception task 생성 (문서 2 §5) |
| idempotency key 누락 | 동일 가격변경/라벨발급 가 두 번 실행 | **CRITICAL** | job 생성 시점에 `idempotency_key TEXT UNIQUE`. Phase 4 가격변경/라벨 작업의 전제 조건. Phase 1 jobs 테이블에 컬럼만 미리 만들어 두는 것이 안전 |
| polling interval 너무 짧으면 DB 부하 / 너무 길면 응답 지연 | UX 저하 또는 비용 증가 | MEDIUM | Phase 1 기본 5초. 우선순위 큐 분리 (긴급/일반) 시 우선순위별 다른 interval |
| polling 대신 LISTEN/NOTIFY 또는 Supabase Realtime 도 가능 | 설계 분기 | LOW | Phase 1 은 polling 으로 단순화. 큐 깊이 늘면 Phase 4 에서 LISTEN/NOTIFY 추가 검토 |

**핵심 판단**: jobs 테이블에 **`idempotency_key`, `attempts`, `max_attempts`, `available_at`, `locked_at`, `locked_by`** 6 컬럼이 Phase 1 부터 존재해야 Phase 4 에서 사고 없이 실행 가능. Phase 1 안에서 실제 worker 로직은 안 짜더라도 schema 만은 설계해 둘 것.

증거 등급: CONFIRMED (없음을 확인).

### 3-4. sub-app Drizzle schema 와 메인 migration 간 drift 방지 방법

**확정 사항** (문서 2 §0): 권위 = 메인 앱 migration. sub-app Drizzle 은 동기화 대상.

| 리스크 | 영향 | 등급 | 완화책 |
|---|---|---|---|
| 메인 migration 추가 후 sub-app Drizzle 갱신 누락 | sub-app worker 가 신규 컬럼 모르고 NULL/오류 | **HIGH** | PR 체크리스트 + `npm run db:introspect` (Drizzle) 또는 `drizzle-kit pull` 로 정합성 확인 룰 |
| sub-app Drizzle 변경이 먼저 들어감 (역방향 drift) | 메인 migration 누락 → 운영에 schema 없음 | **HIGH** | 룰: shared table 변경은 메인 migration 만 인정. sub-app PR 에서 shared table 컬럼 추가/변경 패치 발견 시 즉시 reject |
| sub-app `users`, `audit_logs`, `products`, `platform_listings`, `pricing_settings`, `shipping_rates` (Drizzle 내 이름) 가 메인 schema 와 어긋남 | 동일 데이터에 대해 두 모델이 다른 가정 | **HIGH** | 사용자 확정 (문서 2 §0): "sub-app Drizzle 정의는 메인 schema 따라간다". CI 단계에서 `drizzle-kit pull` 결과를 메인 schema 와 diff 검증 |
| `pricing_settings` (006/automation 양쪽) 의 row 의미 차이 | 가격 계산 결과 불일치 | MEDIUM | Phase 1 안에서 어느 쪽 row 가 source-of-truth 인지 1회 검증. 메인 앱 [src/services/pricingEngine.js](../src/services/pricingEngine.js) 와 sub-app `automation/src/services/pricing.ts` 의 입력/출력 비교 |
| sub-app 단독 테이블 (`crawl_*`, `csv_uploads`, `upload_jobs`, `category_cache`, `description_settings`, `platform_tokens`) 가 메인 migration 에 누락 | sub-app 단독 운영 시 무관, 다만 운영자가 메인 콘솔에서 조회 시 missing | LOW | 장기적으로 메인 migration 에 동일 정의 추가. Phase 1 에서는 사용자 결정대로 Drizzle 관리 유지 |

**핵심 판단**: drift 방지의 90% 는 **PR 체크리스트 + drizzle-kit pull 의 diff 가 0** 이어야 한다는 룰 1개로 해소 가능. 자동화 도구가 아닌 사람 룰 + CI 가드.

증거 등급: INFERRED.

### 3-5. 가격/배송/라벨 실행을 Phase 4까지 미룰 때 MVP 가치의 한계

**확정 사항** (문서 1·2): Phase 1~3 = SKU 마스터 + 예외 콘솔 + 주문 수집 + 도매 감시 + 마진 계산. 실제 가격 변경/배송 접수/라벨 발급은 Phase 4.

| 차이 | Phase 1~3 만 켰을 때 | Phase 4 까지 켰을 때 |
|---|---|---|
| 사장님이 즉시 얻는 가치 | "어디에 무슨 문제가 있는지 한 화면에서 본다" + "예외가 카드로 자동 도착한다" | "문제를 본 즉시 한 클릭으로 해결 실행" |
| 직원 작업 부하 | 카드를 읽고 **수동으로** 마켓 화면 또는 sub-app 에 가서 처리 | 카드에서 승인만 누르면 자동 실행 |
| 사고 위험 | 0 (실제 변경 안 함) | 가드 부족 시 가격 0원/이중 환불 등 |
| ROI 시점 | 짧음 (Phase 0~3, 약 4~7주) | 김 (Phase 4 추가 4~6주) |

**MVP 가치 한계**:
1. **"본다" → "한다" 의 거리가 여전히 1 클릭이 아닌 N 클릭**. 직원이 카드 → 마켓 콘솔 → 수동 변경 → 카드 close 의 4단계.
2. **마진 위험 SKU 알림이 떴는데 실제로 가격을 바꾸려면 사장님이 마켓 콘솔 직접 진입 필요**. WMS 라기보단 OMS+예외관리 콘솔에 가깝다.
3. **단** Phase 4 의 "가격/배송/라벨 자동 실행" 은 가드 부족 시 가장 큰 사고 위험 영역이므로, Phase 1~3 의 무사고 운영이 Phase 4 의 신뢰성 baseline 을 확보. 즉 MVP 의 경계가 보수적인 것은 **의도된 설계**.

**핵심 판단**: Phase 1~3 의 가치는 "**가시성 + 자동 분류**". 자동 실행은 의도적으로 Phase 4. 사장님 사업의 사고 비용이 자동화의 ROI 보다 크므로 정합. 단 사장님이 매일 여전히 N 클릭으로 처리해야 한다는 사실을 Phase 1 첫 데모에서 명시 — 기대치 mismatch 방지.

증거 등급: INFERRED.

### 3-6. 카톡 승인 링크의 보안 토큰 모델 (Phase 2~)

**확정 사항** (사용자 추가): 카톡은 Phase 1.5 또는 Phase 2 후보. Phase 1 필수 아님.

본 문서는 Phase 2 시점에 다시 본격 설계할 항목으로 남기되, 설계 방향만 미리 정리.

| 모델 | 설명 | 장점 | 단점 | 추천 |
|---|---|---|---|---|
| (a) HMAC short-lived URL | `?token=hmac(userId, taskId, expiresAt)`, TTL 5분 | 기존 [auth.js:65-67](../src/middleware/auth.js#L65) 의 HMAC 패턴과 동일. 라이브러리 불요 | 카톡 메시지 캡처 시 5분 내 도용 가능 | **Phase 2 추천** |
| (b) one-time token | DB 에 `approval_tokens(token, used_at)` row, 사용 즉시 무효 | 도용 1회 차단 | 추가 테이블, polling 시 race | Phase 4 이후 |
| (c) 카톡 webhook + 사용자 확인 | 카톡에서 직접 응답, 메인 앱 webhook 수신 | 보안 가장 강함 | 카카오 인증 정책/심사 변수 | 보류 |

**기존 자산 매핑**:
- HMAC 키: 기존 `COOKIE_SECRET` 재사용 가능 (auth.js:56-62) 또는 별도 `APPROVAL_SECRET` 권장 (separation of concerns).
- TTL 5분: signed URL 표준값 ([api.js:4522](../src/web/routes/api.js#L4522), [expenses.js:371](../src/web/routes/expenses.js#L371) 등에서 이미 300초 사용) 와 일관.
- 권한 체크: 토큰 검증 후 web 콘솔 진입 시 `requireAdmin` 또는 `requireOperator` 가드 적용. 카톡 메시지에 노출되는 것은 **링크만**, 실 실행은 웹 권한 체크 후 (확정 사항 #5 와 정합).

**핵심 판단**: 모델 (a) 가 Phase 2 합리. Phase 1 에서는 SSE+DB 알림으로 충분 — 사용자 확정.

증거 등급: INFERRED.

### 3-7. `api.js` / `dashboard.js` 분할을 Phase 1 에서 제외했을 때의 단기 리스크

**확정 사항** (문서 2 §8.6 + 사용자 추가 해석): 분할은 우선순위 5 (Phase 4 이후 / 장기 SaaS 화).

| 단기 리스크 | 영향 | 등급 | 완화책 |
|---|---|---|---|
| Phase 1 작업이 api.js 의 다른 영역 (battle / repricer / b2b) 에 의도치 않은 회귀 | "Phase 1 카드 수정했는데 전투 상황판이 깨짐" 류 | **HIGH** | 신규 SKU 마스터 / 예외 컬럼 / 라우팅 룰 = 모두 신규 라우트 파일 (예: `src/web/routes/skuMaster.js`, `exceptionRouting.js`) 로 추가. **api.js 자체는 손대지 않는다** 룰 |
| dashboard.js 에 SKU 마스터 화면 코드를 추가하면 1만+ 라인이 더 커짐 | 향후 분할 비용 가중 | MEDIUM | 신규 화면은 별 모듈 (`public/js/skuMaster.js`) 로 추가 후 `dashboard.js` 에서 case 분기 1줄로 import. 기존 dashboard.js 본문 수정 금지 룰 |
| 운영자가 신규 화면을 찾을 메뉴가 어디인지 혼란 | UX | LOW | 운영 메뉴 그룹 (사이드바 하단 `── 운영 관리 ──`) 에 추가 — 문서 1 §1-G |
| api.js / dashboard.js 가 너무 커서 Claude Code/IDE 가 한 번에 읽기 어려움 | 본 작업 자체의 효율 저하 | MEDIUM | 본 분석에서 이미 직접 grep + 라인 인용 방식으로 우회 중 |

**핵심 판단**: 분할을 미루는 비용 = "신규 코드를 신규 파일에 격리한다는 룰" 1개로 90% 해소 가능. 단 **이 룰을 어기면 즉시 회귀 다발**. Phase 1 PR review 의 첫 체크 항목 = "api.js 또는 dashboard.js 본문에 변경이 있는가? 있으면 reject". 단순한 가드.

증거 등급: CONFIRMED (현재 파일 크기 + 의존성 그래프).

---

## 4. 데이터 일관성 / 스키마 리스크

### 4-1. 마켓 미러 (`ebay_products` 등) 와 SKU 마스터 동거

| 리스크 | 영향 | 등급 |
|---|---|---|
| 마켓 미러 row 에 `sku_id` 가 NULL 인 채로 운영 | 미매핑 SKU 가 누적되어 자동화 진입 불가 | HIGH |
| sku_id 매핑 이후 마켓 미러 의 SKU 텍스트 컬럼 (`ebay_products.sku`) 와 마스터 의 `internal_sku` 가 어긋남 | 자동 매칭 실패 | MEDIUM |
| 마켓 sync 가 `sku_id` 컬럼 모르고 새 row insert | sku_id NULL 다발 | HIGH |

**완화**: link table `sku_listing_link(sku_id, marketplace, listing_id)` 단일화. 마켓 미러 자체에는 `sku_id` 컬럼 추가하지 말고 link 만 외래키. 미매핑은 link 의 부재로 식별 가능.

### 4-2. `products` (메인) ↔ `products` (sub-app Drizzle) ↔ `sku_master` (신규)

3 중 schema. 시간이 가면서 의미가 더 어긋날 수 있음.

| 리스크 | 등급 |
|---|---|
| sub-app worker 가 `products` 만 보고 `sku_master` 를 읽지 않음 → SKU 마스터의 자동화 ON/OFF 가 sub-app 에 반영 안 됨 | **HIGH** |
| `products` 가 마켓 미러 통합 보기로만 쓰이는데 일부 화면이 마스터처럼 사용 | MEDIUM |

**완화**: Phase 1 안에서 sub-app Drizzle 에 `sku_master` 정의 추가 + sub-app worker 의 listing/매칭 흐름이 `sku_master.automation_enabled` 를 체크하도록 룰 명시.

### 4-3. `expense_receipts` 016 vs 036 (이미 §11 에서 해소)

CONFIRMED: 036 = source-of-truth, 016 = backwards-compat mirror. WMS 와 무관. tech debt 우선순위 5.

### 4-4. drift 모니터링 룰 (확정 사항 #8 의 운영 이행)

| 룰 | 위치 | 등급 |
|---|---|---|
| shared table 변경 = 메인 migration 만 인정 | PR 체크리스트 (수동) | HIGH |
| sub-app PR 에 shared table 컬럼 추가/변경 patch 발견 시 reject | PR 가드 | HIGH |
| `drizzle-kit pull` 결과 = 메인 schema 와 diff 0 | CI step (UNKNOWN — 현재 CI 존재 여부) | MEDIUM |

**리스크**: 사람 룰만으로는 1~2주만 지켜진다. CI 가드가 없으면 drift 가 누적됨. 따라서 Phase 1 안에 drizzle-kit pull diff 검증 1줄을 어딘가에 추가하는 것이 안전 — 단 이는 tech debt 우선순위 1 항목으로 backlog.

증거 등급: UNKNOWN (CI 존재 여부 미확인).

---

## 5. 알림 / 자동 카드 폭주 리스크

### 5-1. dedupe 미설정 시 카드 폭주

| 시나리오 | 영향 |
|---|---|
| eBay sync (10시/22시 cron) 마다 동일 SKU 매칭 실패 카드 200개 생성 | 직원 카드 화면 잠김 |
| 동일 라벨 발급 실패가 매분 호출 시도 → 카드 다발 | DB notify 폭주 |

**완화 (문서 2 §5.4 와 정합)**:
- `dedupe_key` 패턴 (예: `sku_match_failed:{marketplace}:{external_order_id}:{line_id}`) 을 자동 카드 생성 트리거에서 **반드시** 계산.
- partial unique index `WHERE status != 'done'` 으로 DB 차원에서 중복 차단.
- cool-down: 같은 dedupe_key 가 done 후 24시간 이내 재발생 시 새 카드 대신 기존 카드의 `last_seen_at` + memo append.

등급: HIGH. dedupe 없는 자동 카드는 운영 도입 즉시 사고.

### 5-2. SSE 폭주 / 채널 분리

| 리스크 | 등급 | 완화책 |
|---|---|---|
| 자동 카드의 SSE 가 일반 직원 화면에 계속 떠서 작업 방해 | HIGH | tasks.js:122 의 `sseHub.sendTo(assignee, ssePayload)` 를 운영자 ID 만 받도록 분기. 일반 직원에게는 자동 카드 SSE 미발송 |
| iMessage 분기가 macOS 만 → 운영 사고 알림 누락 | **HIGH** | 카톡 도입 (Phase 1.5/2) 까지는 Telegram 채널 의존. Telegram 미설정이면 운영자가 알림 못 받음 |
| Telegram 토큰 만료/봇 차단 | MEDIUM | 헬스체크 cron 으로 24시간 1회 자기 메시지 발송 |

증거 등급: CONFIRMED (imessage.js:12 + notify.js).

### 5-3. 모닝 다이제스트 cron 의 자동 카드 누락 (§3-2 와 동일)

CONFIRMED HIGH. scheduler.js:113 의 default 쿼리에 `auto_generated=false` 필터 추가가 동시 작업.

---

## 6. 보안 리스크

| # | 리스크 | 현 상태 | 등급 | 완화책 |
|---|---|---|---|---|
| 6-1 | DB 비밀번호 노출 → 회전 완료 | CONFIRMED by owner | 해소 | 향후 Claude Code 출력/문서/로그에 secret 인쇄 금지 룰 |
| 6-2 | `COOKIE_SECRET` 미설정 시 랜덤 → 재시작 시 세션 무효 | CONFIRMED ([auth.js:58-60](../src/middleware/auth.js#L58)) | MEDIUM | Railway env 에 명시적 설정 — 이미 메모리상 적용 추정. 1회 확인 |
| 6-3 | service role key (`SUPABASE_SERVICE_KEY`) + DATABASE_URL = strong privilege | CONFIRMED | HIGH | 외부 노출 시 즉시 회전. 코드/로그에 인쇄 금지 룰 |
| 6-4 | 자동 카드 `context JSONB` 에 secret/PII 침입 | INFERRED | HIGH | 자동 생성 트리거에 마스킹 헬퍼. 신규 모듈 `src/lib/redact.js` 후보 (Phase 1) |
| 6-5 | 카톡 메시지에 secret 인쇄 | INFERRED | HIGH (Phase 2) | notify.js 에 카톡 분기 추가 시 redact 헬퍼 통과 |
| 6-6 | 레거시 admin (userId=0) 모드의 광범위 권한 | CONFIRMED ([auth.js:100-104](../src/middleware/auth.js#L100)) | MEDIUM | MVP 후 종료. blockLegacyWrites 가 일부 차단 중이지만 read 는 무제한 |
| 6-7 | signed URL TTL 5분 / 라벨 15분 표준 | CONFIRMED (§증거 수집) | LOW | 카톡 승인 토큰도 5분 표준 채택 |
| 6-8 | API credential 관리 (마켓별 토큰) | INFERRED | MEDIUM | settings 메뉴 + requireAdmin 으로 임시. 장기적으로 secret manager 분리 |

**핵심 판단**: 6-1 해소됨. 6-3, 6-4, 6-5 가 잠재 사고 영역. **redact 헬퍼 1개 + 마스킹 룰** 이 Phase 1 의 최소 보안 작업.

---

## 7. WMS 전환으로 새로 생기는 리스크

### 7-1. LLM 출력의 신뢰성 / 감사

| 리스크 | 등급 | 완화 |
|---|---|---|
| LLM 추천이 잘못된 SKU 매핑을 제안 | HIGH | rule-based exact matching 우선, LLM 은 보조. 문서 2 §3.2 의 흐름 |
| LLM 호출이 카드 본문/추천 description 에 들어감 → 비용/속도 | MEDIUM | 카드 생성 시점이 아닌 사용자가 카드를 열 때 lazy 호출 |
| LLM 출력에 환각 (가짜 SKU/주소) | HIGH | 검증 모듈 (rule check) 통과한 결과만 UI 노출 |
| LLM 호출 감사 로그 부재 | HIGH | `agent_audit_logs` (이미 007 마이그레이션 존재) 활용. Phase 1 안에 LLM 호출 1건 = 1 row 룰 |

증거 등급: CONFIRMED (007 존재). INFERRED (실제 활용 여부).

### 7-2. job 모델 부재 → 신규 도입 리스크

§3-3 와 동일. 6 컬럼 (`idempotency_key`, `attempts`, `max_attempts`, `available_at`, `locked_at`, `locked_by`) 이 Phase 1 schema 에 들어가야 Phase 4 사고 방지.

### 7-3. exception routing 룰 충돌

| 리스크 | 등급 | 완화 |
|---|---|---|
| `exception_type → assignee_id` 정적 매핑이 사장님/팀 변동에 못 따라감 | MEDIUM | 룰 자체를 DB 테이블 `exception_routing` 으로 → admin UI 에서 수정 가능 |
| 라우팅 룰 변경 후 신규 카드만 적용 vs 기존 미처리 카드 재배정 | MEDIUM | 변경 시점에 미처리 카드 일괄 reroute 옵션 (admin 명시 액션) |

### 7-4. 사람 카드 vs 자동 카드 시각 혼선 (§3-2 의 §1 항목)

CONFIRMED HIGH. UI 색/배지/필터 동시 작업.

### 7-5. 카톡 전환 시 알림 채널 이중화 비용

Phase 1.5/2 시작 시 SSE+DB+Telegram+iMessage(무력)+카톡 = 5 채널. 메시지 중복 발송 / 우선순위 / 폴백 모델 필요.

| 룰 | 의미 |
|---|---|
| 채널 우선순위 | 카톡 → Telegram → SSE → DB. 위 채널 성공 시 아래 미발송 (또는 SSE 는 항상 병행) |
| 중복 억제 | 카드 1개 = 채널 1개씩 (총 N 회 미만). 동일 카드의 동일 이벤트는 channel 별 1회 |
| 폴백 | 카톡 실패 시 Telegram. 모두 실패 시 DB 만 |

증거 등급: INFERRED.

---

## 8. 운영 리스크 (단기/중기)

| # | 항목 | 현 상태 | 등급 | 처리 시점 |
|---|---|---|---|---|
| 8-1 | iMessage Railway 무력 | CONFIRMED ([imessage.js:12](../src/services/imessage.js#L12)) | HIGH | Phase 1: Telegram 의존, Phase 1.5/2: 카톡 추가 |
| 8-2 | Korea Post `regData` hard-fail | CONFIRMED ([koreaPostAPI.js:283-285](../src/api/koreaPostAPI.js#L283)) | LOW (Phase 4 라벨 작업까지는 무관) | Phase 4 시작 전 사장님이 샘플코드 제공 |
| 8-3 | scheduler.js 9개 cron 메인 프로세스 동거 | CONFIRMED | MEDIUM | Phase 2 이후 sub-app 으로 #4·#5·#6 이전 (문서 1 §9) |
| 8-4 | `package.json main: scripts/auto-sync-scheduler.js` 별 진입점 | UNKNOWN (실 실행 중인지) | MEDIUM | Phase 1 첫 주 1회 확인. 미사용이면 deprecated 후보 |
| 8-5 | migration 037 적용 여부 | OWNER_DECIDED 적용 가정 | LOW (lazy-fail) | Phase 3 시작 직전 1회 확인 |
| 8-6 | Shopee/Naver/Coupang/Qoo10 주문 sync 부재 | CONFIRMED (문서 1 §11 #7) | Phase 2 핵심 신규 작업 | Phase 2 |
| 8-7 | sub-app 라우트 구조 미파악 | UNKNOWN | LOW | Phase 2 시작 직전 |
| 8-8 | dashboard.js 1만+ 라인 | INFERRED | MEDIUM | tech debt 우선순위 5. Phase 1~3 중 신규 모듈 격리 룰 (§3-7) |

---

## 9. 기술 부채 백로그

문서 2 §8.6 의 표를 **본 문서 기준으로 재정렬**하여 우선순위 / 영향 / 완화 시점 명시.

| # | 항목 | 우선순위 | 영향 | 완화 시점 | 등급 |
|---|---|---|---|---|---|
| 9-1 | sub-app Drizzle ↔ 메인 migration drift 점검 룰 | 1 | HIGH (drift 누적 시 Phase 4 사고) | Phase 1 | INFERRED |
| 9-2 | `team_tasks` 도입 마이그레이션 번호 확정 | 1 | MEDIUM | Phase 1 첫 작업 직전 | UNKNOWN |
| 9-3 | jobs 테이블 6 컬럼 (idempotency 등) 사전 schema | 1 | CRITICAL (Phase 4 사고 방지) | Phase 1 | CONFIRMED (없음 확인) |
| 9-4 | redact 헬퍼 + secret 마스킹 룰 | 1 | HIGH (보안) | Phase 1 | INFERRED |
| 9-5 | 자동화 로그 단일화 (`automation_logs` + `agent_*` 통합 view 또는 schema) | 3 | MEDIUM | Phase 3 | CONFIRMED |
| 9-6 | iMessage 제거 또는 macOS 보조 노드화 | 4 | MEDIUM | Phase 4 | CONFIRMED |
| 9-7 | KoreaPost `regData` 구현 | 4 | MEDIUM (라벨 자동화 가능) | Phase 4 (사장님 샘플 후) | CONFIRMED |
| 9-8 | dashboard.js 화면별 분할 | 5 | MEDIUM (회귀 위험) | 장기 SaaS 화 | CONFIRMED |
| 9-9 | api.js 도메인별 분할 | 5 | MEDIUM | 장기 SaaS 화 | CONFIRMED |
| 9-10 | 레거시 admin (userId=0) 모드 종료 | 5 | LOW (현재 안전) | MVP 후 | CONFIRMED |
| 9-11 | `expenses.receipt_*` 컬럼 deprecated 정리 | 5 | LOW | 장기 SaaS 화 | CONFIRMED |
| 9-12 | 마켓별 mirror schema 단순화 (예: `ebay_products` 와 `platform_listings` 통합 검토) | 5 | LOW | 장기 SaaS 화 | INFERRED |

**우선순위 1 (Phase 1 내) 4 건**: drift 룰, team_tasks 마이그레이션 번호 확정, jobs 6 컬럼, redact 헬퍼.
이 4 건이 누락되면 Phase 4 사고 또는 운영 보안 사고 직결.

---

## 10. Phase 1 시작 직전 체크리스트

| # | 항목 | 책임 | 차단? |
|---|---|---|---|
| 10-1 | `team_tasks` schema 확인 (`\d team_tasks`) | 사용자 | Yes (HIGH 권장) |
| 10-2 | shared table drift 점검 룰 PR 체크리스트화 | 작업자 | No (Phase 1 안에서 도입) |
| 10-3 | jobs 6 컬럼 schema 초안 작성 | 작업자 | No (Phase 1 첫 PR) |
| 10-4 | 자동 카드 dedupe_key 룰 명세 1페이지 | 작업자 | No |
| 10-5 | `auto_generated=false` 필터 추가 위치 (tasks.js GET, scheduler.js 다이제스트, stats endpoint) 확인 | 작업자 | Yes (HIGH — 컬럼 추가와 동시 작업) |
| 10-6 | sub-app `automation/src/db/schema.ts` 에 `sku_master` 정의 추가 계획 | 작업자 | No |
| 10-7 | redact 헬퍼 위치 결정 (`src/lib/redact.js`) | 작업자 | No |
| 10-8 | LLM 호출 감사 로그 룰 (호출 1건 = `agent_audit_logs` 1 row) | 작업자 | No |

---

## 문서 3 요약

### 1. Phase 1 시작 차단 항목
- **즉시 차단**: 1건 (`team_tasks` 실제 schema 확인 — 마이그레이션 번호 UNKNOWN, §2-3).
- **Phase 1 첫 PR 직전 차단**: `auto_generated=false` filter 가 tasks.js GET / scheduler.js 다이제스트 / stats 에 동시 적용되어야 함 (§3-2).
- **나머지 잠재 BLOCKER 는 Phase 2/3 직전**: 037 적용, sub-app 라우트 구조.

### 2. MVP 안에서 감수할 리스크 (의도적)
- 가격/배송/라벨 자동 실행 부재 → 사용자가 카드 보고 N 클릭 수동 처리 (§3-5). Phase 4 신뢰성 baseline 확보를 위한 의도된 보수.
- iMessage Railway 무력 → Telegram 의존 (Phase 1.5/2 카톡 추가).
- dashboard.js / api.js 분할 미룸 → 신규 코드 격리 룰로 회귀 차단 (§3-7).

### 3. Phase 1 안에서 반드시 해야 하는 부채 4 건
1. sub-app Drizzle drift 점검 룰 (§4-4).
2. `team_tasks` 마이그레이션 번호 확정 (§2-3).
3. jobs 6 컬럼 사전 schema (`idempotency_key` 등 §3-3).
4. redact 헬퍼 + secret 마스킹 (§6-4).

### 4. 보안 핵심
- DB 비밀번호 회전 완료 (해소).
- service role key + DATABASE_URL strong privilege → 출력/로그 인쇄 금지 룰.
- 자동 카드 `context JSONB` redact 필수.
- 카톡 승인 토큰 = HMAC short-lived 5분 (Phase 2).

### 5. 사용자 결정 / 후속 확인 사항
- `team_tasks` 실제 schema 1회 dump (§2-3).
- Phase 4 시작 전 KoreaPost `regData` 샘플 코드 제공.
- Phase 2 시작 시 카톡 봇 토큰/체널 ID.
- (선택) `package.json main: auto-sync-scheduler.js` 가 Railway 에서 실행 중인지 확인 (§8-4).

### 6. 다음 문서 (`phase-0-recommended-next-steps.md`) 에서 다룰 것
1. Phase 1 첫 주 / 둘째 주 / 셋째 주 작업 분해 (sku_master 신설 + team_tasks 컬럼 + jobs schema + drift 룰).
2. Phase 1 PR 분할 전략 (회귀 위험 최소화 — §3-7 룰 적용).
3. Phase 1 검증 시나리오 (예: 가짜 SKU 매칭 실패 트리거 → 자동 카드 → 운영자 처리).
4. Phase 2/3 시작 직전 마지막 차단 항목 점검표.
5. tech debt backlog 의 우선순위 1 항목 4 건의 작업 순서.

---

*본 문서는 분석 전용입니다. 코드/DB/설정/배포 변경 일체 없음. 변경된 파일: `docs/phase-0-risk-and-tech-debt.md` 1개.*
