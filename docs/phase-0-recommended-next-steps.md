# Phase 0 — 문서 4: Recommended Next Steps

> 작성일: 2026-05-08
> 모드: Phase 0 마지막 실행계획 문서
> 변경 범위: 문서 작성만. 제품 코드, DB 마이그레이션, 설정, API, 프론트, package, 환경변수 변경 없음.
> 목적: Phase 1 코드 작성에 바로 들어갈 수 있도록 작업 순서, PR 분할, 검증 시나리오, 차단 점검표를 확정한다.
> 증거 등급:
> - **CONFIRMED**: 코드/파일/DB 스키마에서 직접 확인
> - **INFERRED**: 문서 1~3과 현재 구조 기반 추론
> - **UNKNOWN**: 현재 문서/코드만으로 확정 불가
> - **OWNER_CONFIRMED**: 사용자가 직접 Supabase/폴더/운영 정보를 확인해 확정

---

## 0. Phase 0 최종 결론

Phase 0의 결론은 다음 한 줄로 정리된다.

> **메인 앱은 WMS 운영 콘솔과 예외관리 콘솔로 살리고, 자동화 sub-app은 worker/scheduler 프로세스로 분리한다. DB schema 권위는 메인 앱 Supabase migration에 둔다.**

### 0.1 살릴 자산

| 자산 | 근거 | Phase 1 의미 | 증거 |
|---|---|---|---|
| `team_tasks` | 업무 카드, 담당자, 상태, 완료 메모, 첨부 구조가 이미 존재 | WMS exception task의 기본 카드로 확장 | OWNER_CONFIRMED |
| `team_task_attachments` | 업무 첨부 테이블 존재 | 도매처 캡처, 라벨 오류 증빙, 주문 증빙 연결 가능 | OWNER_CONFIRMED |
| `notifications` + SSE | 문서 1에서 DB 알림 + SSE + notify 계층 확인 | Phase 1에서는 카톡 없이 기존 알림 재사용 | CONFIRMED |
| 메인 앱 인증/권한 | 문서 1에서 `auth.js`, `users.js` 구조 확인 | 운영자/직원 권한 분리의 기반 | CONFIRMED |
| B2B FedEx 라벨 패턴 | 문서 1에서 B2B 라벨/Storage/signed URL 패턴 확인 | C2C 라벨 자동화는 Phase 4에서 패턴 차용 | CONFIRMED |
| 마켓별 mirror 테이블 | 문서 1에서 `ebay_products`, `shopify_products`, `naver_products`, `alibaba_products` 사용 확인 | 삭제하지 않고 SKU link layer로 연결 | CONFIRMED |

### 0.2 수정해서 재사용할 자산

| 자산 | 수정 방향 | Phase |
|---|---|---|
| `team_tasks` | `auto_generated`, `exception_type`, `context`, `dedupe_key`, `severity`, `related_sku_id`, `related_order_id` 추가 | Phase 1 |
| 업무 목록 read path | 일반 직원 기본 목록은 `auto_generated=false` 보호 | Phase 1 |
| SSE 발송 | `assignee_scope='operators'` 자동 카드는 admin에게만 발송 | Phase 1 |
| 마켓별 mirror | `sku_listing_link`로 `sku_master`와 연결 | Phase 1~2 |
| scheduler/cron | 자동화 계열은 장기적으로 sub-app worker로 이동 | Phase 2~4 |

### 0.3 새로 만들 자산

| 신규 자산 | 목적 | Phase |
|---|---|---|
| `sku_master` | 내부 운영 SKU의 단일 기준 | Phase 1 |
| `sku_listing_link` | 내부 SKU와 마켓 listing/option 연결 | Phase 1 |
| `jobs` | DB jobs polling 기반의 작업 요청 저장소. Phase 1은 schema only | Phase 1 |
| `automation_runs` | 자동화 실행 이력. Phase 1은 schema만 준비 가능 | Phase 1 |
| `src/lib/redact.js` | secret/PII 마스킹 | Phase 1 |
| `src/web/routes/skuMaster.js` | SKU master CRUD API | Phase 1 |
| `src/web/routes/exceptionRouting.js` | exception type별 정적 라우팅 | Phase 1 |
| `public/js/skuMaster.js` | SKU master 관리 화면 | Phase 1 |
| `public/js/exceptionFilter.js` | 자동 예외 필터/탭 | Phase 1 |

### 0.4 Phase 1에서 금지할 작업

- 가격 자동 변경
- 배송 접수 실행
- FedEx/K-Packet 라벨 자동 생성
- Shopee API 실제 주문 수집
- 카카오톡 실제 구현
- LLM 에이전트 구현
- `api.js` 본문 수정
- `dashboard.js` 대규모 본문 수정
- `tasks` legacy 테이블 변경
- `task_recipients` 전제 설계
- 기존 `products`, `platform_listings`, `ebay_products` 등 삭제

### 0.5 Phase 2/3으로 미룰 작업

| 작업 | 이동 Phase | 이유 |
|---|---|---|
| mock/CSV 주문 import + SKU 매칭 | Phase 2 | Phase 1에서는 SKU와 예외 콘솔 기반만 확정 |
| Shopee 주문 API 실제 연동 | Phase 2 이후 | mock/CSV import로 먼저 흐름 검증 |
| 도매처 가격/품절 watcher | Phase 3 | SKU와 주문 매칭 후 공급처 감시 연결 |
| 가격/마진 계산 | Phase 3 | 원가, 수수료, 배송비 source-of-truth 확인 필요 |
| `automation_runs` 적극 사용 | Phase 3~4 | Phase 1은 schema 토대만 가능 |

### 0.6 Phase 4 이후 tech debt

- `api.js` 도메인별 분할
- `dashboard.js` 화면별 분할
- iMessage 제거 또는 macOS 보조 노드화
- KoreaPost `regData` 구현
- 카톡 승인 링크
- 가격변경/배송/라벨 자동 실행
- LLM 에이전트 구현
- SaaS 멀티테넌시

---

## 1. Phase 1 작업 분해 — 3주 계획

Phase 1의 목표는 "실제 자동 실행"이 아니라 **SKU 기준과 예외 카드 기반을 만드는 것**이다.

### Week 1 — DB 토대

#### 목표

- 038 마이그레이션 방향 확정
- `sku_master`, `sku_listing_link`, `team_tasks` 확장, `jobs`, `automation_runs` 토대 설계
- secret/PII 마스킹 헬퍼 위치 확정
- 일반 직원 화면 보호를 위한 read path 변경 후보 확정

#### 주요 작업

1. `supabase/migrations/038_phase1_sku_master_and_exception.sql` 작성
2. `sku_master` 테이블 생성
3. `sku_listing_link` 테이블 생성
4. `team_tasks` 컬럼 7개 추가
5. `team_tasks_dedupe_key_active` partial unique index 추가
6. `jobs` schema 생성
7. `automation_runs` schema 생성
8. `src/lib/redact.js` 추가
9. read path 필터 위치 확인:
   - `src/web/routes/tasks.js`
   - scheduler 모닝 다이제스트
   - stats endpoint
   - SSE 발송 경로

#### 변경할 파일 후보

| 파일 | 변경 이유 |
|---|---|
| `supabase/migrations/038_phase1_sku_master_and_exception.sql` | Phase 1 DB foundation |
| `src/lib/redact.js` | context JSONB, 알림 payload 마스킹 |
| `src/web/routes/tasks.js` | 일반 직원 기본 업무 목록에서 자동 카드 제외 |
| `src/services/scheduler.js` | 모닝 다이제스트에서 자동 카드 제외 |
| stats endpoint 파일 | 자동 카드와 사람 카드 통계 분리 |

#### 변경하지 말아야 할 파일

| 파일 | 이유 |
|---|---|
| `src/web/routes/api.js` | Phase 1 격리 룰. 본문 수정 금지 |
| `public/js/dashboard.js` | Week 1에서는 수정 금지 |
| legacy `tasks` 테이블 관련 로직 | Phase 1 범위 아님 |
| sub-app Drizzle schema | 메인 migration 이후 PR 5에서 동기화 |
| `supabase/migrations/037_orders_fedex_label.sql` | 기존 037 은 절대 수정/삭제 금지 |

#### 완료 기준

- 038 SQL 초안이 비파괴 방식으로 작성됨
- 기존 `team_tasks` row는 `auto_generated=false`로 보호됨
- `dedupe_key` partial unique index 설계 완료
- `jobs`는 schema만 있고 worker 로직 없음
- `redact.js`가 secret/PII 마스킹을 수행
- `api.js`, `dashboard.js` 본문 수정 없음
- 기존 037 파일 무수정

#### 검증 방법

- Supabase local 또는 staging에서 migration dry-run
- 기존 team_tasks row count 변화 없음
- 신규 컬럼 default 확인
- `status != 'done' AND dedupe_key IS NOT NULL` unique index 동작 확인
- `redact()` 테스트 문자열로 secret, token, key, phone, email 마스킹 확인

---

### Week 2 — UI와 라우팅

#### 목표

- SKU master CRUD API 추가
- exception routing 정적 매핑 API 또는 helper 추가
- SKU master 화면 추가
- 자동 예외 필터/탭 추가
- 운영 메뉴에 SKU 마스터 진입점 연결

#### 주요 작업

1. `src/web/routes/skuMaster.js` 신규 작성
2. `src/web/routes/exceptionRouting.js` 신규 작성
3. `public/js/skuMaster.js` 신규 작성
4. `public/js/exceptionFilter.js` 신규 작성
5. 자동 카드 UI 구분:
   - 배지
   - 색상
   - severity 표시
   - exception_type 표시
6. 사이드바 운영 메뉴에 SKU 마스터 진입점 추가
7. 자동 예외 탭 또는 필터 추가

#### 변경할 파일 후보

| 파일 | 변경 이유 |
|---|---|
| `src/web/routes/skuMaster.js` | SKU master CRUD |
| `src/web/routes/exceptionRouting.js` | exception_type → assignee_scope/assignee_id 정적 매핑 |
| `public/js/skuMaster.js` | SKU master 화면 |
| `public/js/exceptionFilter.js` | 자동 예외 필터 |
| route registration 파일 | 신규 route 연결 |
| `public/index.html` 또는 sidebar template | 운영 메뉴 진입점 추가 |
| `public/js/dashboard.js` | 신규 모듈 연결용 최소 1줄 수준만 허용 |

#### 변경하지 말아야 할 파일

| 파일 | 이유 |
|---|---|
| `src/web/routes/api.js` | 신규 API는 별도 route 파일 사용 |
| `public/js/dashboard.js` 대규모 본문 | 화면 로직은 신규 모듈로 격리 |
| `tasks` legacy 관련 파일 | Phase 1 범위 아님 |
| sub-app worker 파일 | Phase 1 범위 아님 |

#### 완료 기준

- SKU master 목록/생성/수정/비활성화 가능
- SKU와 marketplace listing link 생성 가능
- 자동 예외 카드와 일반 업무 카드가 UI에서 구분됨
- 일반 직원 기본 업무 목록에는 자동 카드가 노출되지 않음
- 운영자 자동 예외 탭에서 자동 카드 확인 가능

#### 검증 방법

- admin 계정으로 SKU master CRUD
- staff 계정으로 기본 업무 목록 확인
- 자동 카드가 staff 기본 화면에 보이지 않는지 확인
- admin 계정에서 자동 예외 탭 확인
- sidebar/page 연결 변경이 최소인지 diff 확인

---

### Week 3 — 검증

#### 목표

- mock 자동 카드 트리거로 E2E 흐름 검증
- dedupe_key 동작 확인
- `assignee_scope='operators'` SSE 정책 확인
- 재배정 후 직원 SSE 확인
- secret/PII 마스킹 확인

#### 주요 작업

1. mock SKU matching failed 이벤트 생성
2. 자동 카드 생성 helper 호출
3. 동일 dedupe_key 재발생 테스트
4. 운영자 SSE 수신 확인
5. 일반 직원 자동 카드 미노출 확인
6. 운영자가 직원에게 재배정
7. 재배정 직원 SSE 수신 확인
8. `context` JSONB 마스킹 확인

#### 변경할 파일 후보

| 파일 | 변경 이유 |
|---|---|
| `src/web/routes/exceptionRouting.js` | mock trigger 또는 admin-only helper |
| `src/lib/redact.js` | 마스킹 보강 |
| `public/js/exceptionFilter.js` | 자동 예외 탭 검증 |
| 테스트 스크립트 또는 docs | E2E 검증 절차 문서화 |

#### 변경하지 말아야 할 파일

| 파일 | 이유 |
|---|---|
| `src/web/routes/api.js` | 격리 룰 |
| `public/js/dashboard.js` 본문 | 신규 모듈 연결 외 금지 |
| sub-app worker | Phase 1에서는 worker 미구현 |
| 외부 API 관련 파일 | Phase 1 범위 아님 |

#### 완료 기준

- mock SKU 매칭 실패 → 자동 카드 생성
- 동일 dedupe_key → 새 카드 미생성, 기존 카드 업데이트
- 운영자 SSE 수신
- 일반 직원 기본 화면 미노출
- 운영자 재배정 후 직원 SSE 수신
- secret/PII가 context와 알림 payload에서 마스킹됨

#### 검증 방법

- admin 계정과 staff 계정 브라우저 동시 접속
- mock endpoint 또는 직접 helper 호출
- DB에서 `team_tasks` row 확인
- `completed_at`, `status` 완료 처리 동기화 확인
- `context` JSONB 값 확인

---

## 2. 038 마이그레이션 구체 SQL 초안

> 주의: 아래 SQL은 문서 안의 초안이다. 실제 파일 생성은 Phase 1 PR 1에서 한다.
> shared schema source-of-truth는 메인 앱 `supabase/migrations/*.sql`이다.
> 기존 `037_orders_fedex_label.sql` 은 절대 수정/덮어쓰지 않으며, 본 Phase 1 신규 migration 은 `038_*.sql` 로 추가한다.

```sql
-- 038_phase1_sku_master_and_exception.sql
-- Phase 1 DB foundation:
-- - sku_master
-- - sku_listing_link
-- - team_tasks exception columns
-- - jobs schema only
-- - automation_runs schema

-- 1) SKU master
create table if not exists sku_master (
  id serial primary key,
  internal_sku varchar(100) not null unique,
  title varchar(255) not null,
  product_type varchar(50),
  brand varchar(100),
  category varchar(100),
  status varchar(30) not null default 'active',
  automation_enabled boolean not null default false,
  cost_krw numeric(12,2),
  weight_gram integer,
  hs_code varchar(50),
  notes text,
  created_by integer,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

create index if not exists idx_sku_master_status
  on sku_master(status);

create index if not exists idx_sku_master_automation_enabled
  on sku_master(automation_enabled);

-- 2) SKU to marketplace listing link
create table if not exists sku_listing_link (
  id serial primary key,
  sku_id integer not null references sku_master(id) on delete cascade,
  marketplace varchar(50) not null,
  listing_id varchar(200) not null,
  option_id varchar(200),
  marketplace_sku varchar(200),
  is_primary boolean not null default false,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now(),
  unique (marketplace, listing_id, option_id)
);

create index if not exists idx_sku_listing_link_sku_id
  on sku_listing_link(sku_id);

create index if not exists idx_sku_listing_link_marketplace
  on sku_listing_link(marketplace);

-- 3) Extend team_tasks for WMS exception cards
alter table team_tasks
  add column if not exists auto_generated boolean not null default false,
  add column if not exists exception_type varchar(50),
  add column if not exists context jsonb,
  add column if not exists dedupe_key varchar(200),
  add column if not exists severity varchar(20) default 'medium',
  add column if not exists related_sku_id integer references sku_master(id),
  add column if not exists related_order_id integer;

-- related_order_id FK is deferred to Phase 2 because orders/order_lines scope is not fixed yet.

create index if not exists idx_team_tasks_auto_generated
  on team_tasks(auto_generated);

create index if not exists idx_team_tasks_exception_type
  on team_tasks(exception_type);

create index if not exists idx_team_tasks_related_sku_id
  on team_tasks(related_sku_id);

create unique index if not exists team_tasks_dedupe_key_active
  on team_tasks(dedupe_key)
  where status != 'done' and dedupe_key is not null;

-- 4) jobs schema foundation
create table if not exists jobs (
  id serial primary key,
  job_type varchar(100) not null,
  status varchar(30) not null default 'pending',
  payload jsonb,
  priority integer not null default 100,
  idempotency_key varchar(200) unique,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamp without time zone not null default now(),
  locked_at timestamp without time zone,
  locked_by varchar(100),
  started_at timestamp without time zone,
  completed_at timestamp without time zone,
  failed_at timestamp without time zone,
  error_message text,
  created_by integer,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

create index if not exists idx_jobs_status_available
  on jobs(status, available_at);

create index if not exists idx_jobs_locked_at
  on jobs(locked_at);

create index if not exists idx_jobs_job_type
  on jobs(job_type);

-- 5) automation_runs schema foundation
create table if not exists automation_runs (
  id serial primary key,
  job_id integer references jobs(id) on delete set null,
  automation_type varchar(100) not null,
  triggered_by varchar(100),
  status varchar(30) not null default 'started',
  input_snapshot jsonb,
  output_snapshot jsonb,
  started_at timestamp without time zone not null default now(),
  completed_at timestamp without time zone,
  error_code varchar(100),
  error_message text,
  retry_count integer not null default 0,
  related_sku_id integer references sku_master(id),
  related_task_id integer references team_tasks(id),
  created_at timestamp without time zone not null default now()
);

create index if not exists idx_automation_runs_job_id
  on automation_runs(job_id);

create index if not exists idx_automation_runs_type_status
  on automation_runs(automation_type, status);

create index if not exists idx_automation_runs_related_sku_id
  on automation_runs(related_sku_id);
```

### 2.1 SQL 검토 포인트

| 항목 | 확인 |
|---|---|
| 기존 row 영향 | `team_tasks` 신규 컬럼은 nullable 또는 default가 있어 기존 row 안전 |
| `related_order_id` | Phase 2에서 orders/order_lines 설계 후 FK 추가 |
| `assignee_scope='operators'` | check constraint가 있는지 확인 필요. 없으면 컬럼값만 사용 가능 |
| dedupe 기준 | 사용자 확정안: `status != 'done' AND dedupe_key IS NOT NULL` |
| 완료 동기화 | 자동 카드 완료 시 `status='done'`과 `completed_at`이 함께 세팅되어야 함 |
| jobs | Phase 1은 schema only. worker 없음 |
| automation_runs | Phase 1은 schema foundation. 본격 사용은 Phase 3~4 |
| 기존 037 보호 | `037_orders_fedex_label.sql` 은 본 PR 에서 일체 변경 금지 |

---

## 3. 사장님 + Claude Code 협업 룰

### 3.1 사장님 작성 → Claude Code review

Claude Code는 아래를 첫 체크리스트로 본다.

| 체크 | 질문 |
|---|---|
| 격리 룰 | 이 PR에 `api.js` 본문 수정이 있는가? 있으면 reject |
| 대시보드 룰 | `dashboard.js` 변경이 신규 모듈 연결 1줄 수준을 넘는가? 넘으면 reject |
| 기존 037 보호 | `supabase/migrations/037_orders_fedex_label.sql` 에 변경이 있는가? 있으면 reject |
| DB 안전성 | 신규 컬럼에 `NOT NULL DEFAULT` 또는 nullable 정책이 있는가? 기존 row 영향 없는가? |
| 기존 업무 보호 | 일반 직원 기본 read path에 `auto_generated=false` 보호가 적용됐는가? |
| 다이제스트 보호 | scheduler 모닝 다이제스트에서 자동 카드 제외됐는가? |
| SSE 보호 | `assignee_scope='operators'` 자동 카드가 admin에게만 발송되는가? |
| dedupe | `dedupe_key` 패턴이 명확한가? 충돌 가능성은 없는가? |
| 완료 상태 | 자동 카드 완료 시 `status='done'`과 `completed_at`이 같이 세팅되는가? |
| 보안 | `context JSONB`에 secret/PII가 들어가는 경로가 있는가? |
| 레거시 보호 | `tasks` 테이블을 변경하지 않았는가? |
| Drift | sub-app Drizzle schema가 shared schema 권위를 침범하지 않았는가? |

### 3.2 Claude Code 작성 → 사장님 review

사장님은 아래를 본다.

| 체크 | 질문 |
|---|---|
| 운영 흐름 | 실제 직원 8명 업무 흐름에 방해가 없는가? |
| 자동 카드 | 자동 카드가 너무 많이 생성될 가능성은 없는가? |
| 화면 위치 | SKU 마스터 진입점이 자연스러운가? |
| 담당자 라우팅 | 자동 카드 기본 수신자를 사장님/운영자에게 보내는 구조가 맞는가? |
| 추상화 과다 | Phase 2~4를 위해 미리 깔아둔 것이 과하지 않은가? |
| 수동 복구 | 잘못 생성된 자동 카드를 사람이 닫거나 재배정할 수 있는가? |

### 3.3 단독 개발 운영 룰

- 한 PR은 1~2일 안에 리뷰 가능한 크기로 유지한다.
- Claude Code에게 "전체 WMS 구현"을 시키지 않는다.
- Phase 1에서는 **문서 4의 PR 범위 밖 작업은 거절**한다.
- DB migration과 UI 변경을 한 PR에 과하게 섞지 않는다.
- 실제 운영 DB 적용 전에는 Supabase SQL Editor에서 dry-run 또는 staging 확인을 우선한다.
- secret 값은 Claude Code 출력, 문서, 로그에 쓰지 않는다.

---

## 4. Phase 1 검증 시나리오

### 시나리오 1 — Mock SKU 매칭 실패 → 자동 카드 → 운영자 SSE → 처리

| 항목 | 내용 |
|---|---|
| 목적 | 자동 예외 카드 생성 흐름 검증 |
| 사전 조건 | `sku_master` 존재, admin 로그인, SSE 연결 |
| 실행 | mock SKU_MATCH_FAILED 이벤트 생성 |
| 기대 결과 | `team_tasks.auto_generated=true`, `exception_type='SKU_MATCH_FAILED'`, `assignee_scope='operators'` 카드 생성 |
| 실패 시 점검 | exception helper, routing map, notifications, SSE 발송 조건 |

### 시나리오 2 — 동일 SKU 재실패 → dedupe_key 동작

| 항목 | 내용 |
|---|---|
| 목적 | 자동 카드 폭주 방지 |
| 사전 조건 | 같은 `dedupe_key`의 미완료 자동 카드 존재 |
| 실행 | 동일 mock 이벤트 재실행 |
| 기대 결과 | 새 카드가 생성되지 않고 기존 카드의 `last_seen_at` 또는 context가 갱신됨 |
| 실패 시 점검 | partial unique index, helper의 upsert/update 로직 |

### 시나리오 3 — 자동 카드 운영자 → 직원 재배정 → 직원 SSE → 처리

| 항목 | 내용 |
|---|---|
| 목적 | 자동 카드 재배정 흐름 검증 |
| 사전 조건 | admin 자동 카드 존재 |
| 실행 | `assignee_scope='specific'`, `assignee_id=직원ID`로 재배정 |
| 기대 결과 | 해당 직원에게 SSE/알림 발송, `auto_generated=true` 유지 |
| 실패 시 점검 | 재배정 API, SSE sendTo, 알림 대상 계산 |

### 시나리오 4 — 일반 직원 화면 자동 카드 미노출 확인

| 항목 | 내용 |
|---|---|
| 목적 | 기존 업무 화면 보호 |
| 사전 조건 | 자동 카드와 사람 카드가 둘 다 존재 |
| 실행 | staff 계정으로 기본 업무 목록 접속 |
| 기대 결과 | `auto_generated=false` 사람 카드만 표시 |
| 실패 시 점검 | tasks GET default filter, frontend filter, stats endpoint |

### 시나리오 5 — context JSONB secret 마스킹 확인

| 항목 | 내용 |
|---|---|
| 목적 | 보안 리스크 차단 |
| 사전 조건 | mock event payload에 token, key, phone, email 포함 |
| 실행 | 자동 카드 생성 |
| 기대 결과 | `context`와 알림 payload에 민감값이 마스킹되어 저장/표시 |
| 실패 시 점검 | `src/lib/redact.js`, helper 호출 위치 |

### 시나리오 6 — SKU master CRUD

| 항목 | 내용 |
|---|---|
| 목적 | SKU master 최소 모델 검증 |
| 사전 조건 | admin 로그인 |
| 실행 | SKU 생성, 수정, 비활성화 |
| 기대 결과 | `sku_master` row 생성/수정, status 변경 |
| 실패 시 점검 | route registration, validation, DB 권한 |

### 시나리오 7 — 마켓 listing link 생성

| 항목 | 내용 |
|---|---|
| 목적 | SKU와 외부 listing 연결 검증 |
| 사전 조건 | SKU master row 존재 |
| 실행 | marketplace, listing_id, option_id로 link 생성 |
| 기대 결과 | `sku_listing_link` row 생성, 중복 link 방지 |
| 실패 시 점검 | unique constraint, CRUD validation |

### 시나리오 8 — 기존 `tasks` 테이블 무변경 확인

| 항목 | 내용 |
|---|---|
| 목적 | legacy 테이블 보호 |
| 사전 조건 | migration diff 확인 |
| 실행 | Phase 1 PR diff 확인 |
| 기대 결과 | `tasks` 테이블에 ALTER/DELETE 없음 |
| 실패 시 점검 | migration 파일, ORM schema, route 파일 |

### 시나리오 9 — 기존 037 무변경 확인

| 항목 | 내용 |
|---|---|
| 목적 | 기존 037_orders_fedex_label.sql 보호 |
| 사전 조건 | Phase 1 PR diff 확인 |
| 실행 | `git diff supabase/migrations/037_orders_fedex_label.sql` |
| 기대 결과 | 변경 없음 |
| 실패 시 점검 | 037 파일을 잘못 수정한 경우 즉시 rollback |

---

## 5. Phase 2 시작 직전 차단 점검표

Phase 2의 목표는 **주문 수집/mock import + SKU 매칭**이다.

| 체크 | 설명 | 책임 | 차단 여부 |
|---|---|---|---|
| sub-app route 구조 정독 | Fastify 등록 패턴, 인증, route layout 확인 | Claude Code + 사장님 | Yes |
| Shopee 첫 마켓 여부 결정 | Shopee를 첫 실제 마켓으로 할지, CSV/mock만 할지 결정 | 사장님 | Yes |
| mock/CSV order import 방식 결정 | CSV 컬럼, sample order 구조, 업로드 방식 | 사장님 | Yes |
| `orders`, `order_lines` 스키마 초안 | Phase 2 신규 migration 범위 | Claude Code | Yes |
| `related_order_id` FK 적용 여부 | Phase 1에서는 FK 미적용. Phase 2에서 연결 | Claude Code | Yes |
| SKU 매칭 룰 초안 | exact SKU, marketplace_sku, option_id, manual mapping 우선순위 | 사장님 + Claude Code | Yes |
| jobs polling 일부 사용 여부 | mock import를 jobs로 넣을지 직접 helper로 처리할지 결정 | Claude Code | No |

Phase 2에서 금지할 것:

- 가격 자동 변경
- 배송 접수
- 라벨 생성
- LLM 에이전트 자동 판단 실행
- 카톡 승인 실행

---

## 6. Phase 3 시작 직전 차단 점검표

Phase 3의 목표는 **도매처 가격/품절 감시 + 수익/마진 계산**이다.

| 체크 | 설명 | 책임 | 차단 여부 |
|---|---|---|---|
| 첫 도매처 1곳 결정 | API 가능 여부, 크롤링 가능 여부, 약관 확인 | 사장님 | Yes |
| `supplier_products` 스키마 초안 | 공급처 상품, 가격, 품절, 이미지 hash | Claude Code | Yes |
| watcher 위치 결정 | sub-app worker에 둘지, 별도 service로 둘지 | Claude Code | Yes |
| pricing source-of-truth | 원가, 배송비, 수수료, 환율 기준 | 사장님 | Yes |
| automation_runs 사용 확정 | supplier watcher 실행 로그 저장 방식 | Claude Code | Yes |
| C2C FedEx 라벨 DB 신설 시점 | Phase 4 권장. Phase 3에서는 만들지 않음 | 사장님 | No |
| 038 + 기존 037 migration 적용 상태 | Phase 1 적용 038 + C2C 라벨용 037 동시 확인 | 사장님 | Yes |

Phase 3에서 금지할 것:

- 실제 마켓 가격 자동 변경
- 실제 배송 접수
- K-Packet 라벨 자동화
- AI가 임의로 가격 실행

---

## 7. Tech Debt Backlog 우선순위 1 처리 순서

문서 3의 우선순위 1 항목 4건은 Phase 1 안에서 다음 순서로 처리한다.

### 7.1 team_tasks 마이그레이션 번호 확정 — 해소됨

- 실제 repo 확인 결과 `037_orders_fedex_label.sql` 은 실제 존재하는 migration 이다 (C2C 주문에 FedEx 라벨 storage 메타 컬럼 추가).
- Phase 1 신규 migration 은 `038_phase1_sku_master_and_exception.sql` 로 한다.
- 기존 037 은 삭제/수정/덮어쓰지 않는다.
- Phase 1 은 038 에서 `sku_master`, `sku_listing_link`, `team_tasks` 예외 컬럼, `jobs`, `automation_runs` 를 추가한다.
- 037 의 Supabase 실제 적용 여부는 별건이며, Phase 3 시작 직전 `\dt order_fedex_labels` 로 1회 확인 (문서 3 §2-4 와 정합).

상태: **OWNER_CONFIRMED / 해소**

### 7.2 jobs 6 컬럼 사전 schema

- `idempotency_key`
- `attempts`
- `max_attempts`
- `available_at`
- `locked_at`
- `locked_by`

처리: Week 1 / 038 migration에 포함
주의: worker 처리 로직은 만들지 않음.

### 7.3 redact 헬퍼 + secret 마스킹

처리: Week 1 / `src/lib/redact.js`
대상:

- 자동 카드 `context`
- notification payload
- 향후 카톡 메시지
- automation run snapshot

### 7.4 sub-app Drizzle drift 점검 룰

처리: PR review checklist부터 시작
Phase 1 PR 5에서 Drizzle sync 검토
원칙:

- shared table 변경은 메인 migration이 권위
- sub-app Drizzle은 따라가는 typed access layer
- sub-app이 shared table migration을 주도하지 않음

---

## 8. 사장님이 Phase 1 시작 전 미리 결정/준비할 것

### 8.1 exception_type 초기 값

추천 초기 enum:

| exception_type | 설명 | Phase |
|---|---|---|
| `SKU_MATCH_FAILED` | 주문 또는 listing의 SKU 매칭 실패 | Phase 1 mock / Phase 2 실제 |
| `ADDRESS_INVALID` | 배송지 오류 | Phase 2 |
| `MARGIN_RISK` | 최소 마진 이하 | Phase 3 |
| `SUPPLIER_OUT_OF_STOCK` | 도매처 품절 감지 | Phase 3 |
| `PRICE_CHANGE_APPROVAL_REQUIRED` | 가격변경 승인 필요 | Phase 3~4 |
| `LABEL_FAILED` | 라벨 생성 실패 | Phase 4 |
| `AUTOMATION_FAILED` | worker/job 실패 | Phase 1~4 |

Phase 1에서는 `SKU_MATCH_FAILED`, `AUTOMATION_FAILED` 정도만 실제 mock에 사용하면 충분하다.

### 8.2 기본 exception_routing 매핑표 초안

Phase 1 기본값:

| exception_type | assignee_scope | assignee_id |
|---|---|---|
| `SKU_MATCH_FAILED` | `operators` | null |
| `AUTOMATION_FAILED` | `operators` | null |
| `MARGIN_RISK` | `operators` | null |
| `SUPPLIER_OUT_OF_STOCK` | `operators` | null |
| `ADDRESS_INVALID` | `operators` | null |
| `LABEL_FAILED` | `operators` | null |

이유: 현재 `operators`는 `role='admin'`, 즉 사장님 본인으로 정의됨. 직원에게 바로 뿌리지 않고 사장님이 검토 후 재배정한다.

### 8.3 SKU 마스터 화면 진입점 위치

추천:

- 사이드바 하단 `운영 관리` 그룹
- 메뉴명: `SKU 마스터`
- 관련 메뉴: `자동 예외`, `운영 로그`

### 8.4 자동 카드 UI 배지/색상 정책

추천:

| severity | UI |
|---|---|
| low | 회색 배지 |
| medium | 파란색 또는 기본 배지 |
| high | 주황색 배지 |
| critical | 빨간색 배지 |

자동 카드 공통 배지:

- `AUTO`
- `exception_type`
- `severity`

---

## 9. Phase 1 완료 정의 — Definition of Done

Phase 1은 아래 조건을 모두 만족해야 완료로 선언한다.

| 조건 | 완료 기준 |
|---|---|
| 038 migration | 적용 완료 |
| 기존 037 migration | 변경 없음 |
| `sku_master` | CRUD 동작 |
| `sku_listing_link` | SKU ↔ marketplace listing 연결 가능 |
| `team_tasks` 확장 | 7개 컬럼 추가 |
| dedupe index | 동일 활성 `dedupe_key` 중복 방지 |
| 자동 카드 | mock SKU 매칭 실패로 생성 |
| 운영자 SSE | `assignee_scope='operators'` 카드가 admin에게만 발송 |
| 직원 화면 보호 | 일반 직원 기본 화면에 자동 카드 미노출 |
| 재배정 | 직원에게 재배정하면 직원에게 알림/SSE |
| redact helper | secret/PII 마스킹 |
| jobs | schema 존재, worker 미구현 OK |
| automation_runs | schema 존재, 적극 사용은 후속 OK |
| `api.js` | 본문 수정 0건 |
| `dashboard.js` | 신규 모듈 연결용 최소 변경만 |
| `tasks` legacy | 변경 없음 |
| 외부 API | 실제 Shopee/FedEx/KoreaPost 연동 없음 |

---

## 10. Phase 1 첫 작업 — Week 1 Day 1 액션

첫 작업은 코드 작성이 아니라 **PR 1 범위 잠금 + 038 migration 작성**이다.

### 정확한 액션

1. 새 브랜치 생성
   예: `phase1-db-foundation`

2. Supabase migration 파일 생성
   `supabase/migrations/038_phase1_sku_master_and_exception.sql`

3. 038 SQL에는 아래만 포함:
   - `sku_master`
   - `sku_listing_link`
   - `team_tasks` 7개 컬럼
   - `team_tasks_dedupe_key_active` partial unique index
   - `jobs`
   - `automation_runs`

4. SQL 적용 전 확인:
   - `assignee_scope` check constraint 존재 여부
   - `team_tasks.status` check constraint 존재 여부
   - 기존 `team_tasks` row count
   - 기존 `tasks` 테이블은 건드리지 않는지
   - 기존 `037_orders_fedex_label.sql` 이 변경되지 않는지

5. SQL 적용 후 확인:
   - 기존 row가 `auto_generated=false`
   - 신규 index 생성됨
   - `sku_master` CRUD 전 table 접근 가능
   - `jobs` worker 로직 없음

---

## 11. 사장님이 Phase 1 시작 전 1회 확인할 것

| 확인 | 이유 |
|---|---|
| `team_tasks.assignee_scope`에 check constraint가 있는지 | `operators` 값 추가 가능 여부 확인 |
| `team_tasks.status`에 check constraint가 있는지 | `status != 'done'` index와 완료 처리 일관성 확인 |
| `users.role='admin'`인 사용자 존재 확인 | `operators` SSE 대상 계산 |
| Supabase 백업 또는 migration rollback 계획 | 운영 DB 변경 전 안전장치 |
| 실제 직원 업무 화면에서 현재 task 사용 중인지 | `auto_generated=false` default filter 적용 시 회귀 확인 |
| Railway env에 secret 출력 로그 없는지 | 보안 확인 |

---

## 12. Phase 1 PR 1용 Claude Code 프롬프트 초안

아래는 Phase 1 첫 코드 작업을 시작할 때 사용할 프롬프트다.

```text
Phase 1 PR 1 — DB foundation 작업을 시작하라.

목표:
WMS Phase 1의 DB 토대를 만든다.
이번 PR은 DB migration 중심이며, 제품 코드 변경은 최소화한다.

반드시 먼저 확인할 것:
1. team_tasks.assignee_scope 에 check constraint 가 있는지 확인하라.
2. team_tasks.status 에 check constraint 가 있는지 확인하라.
3. users.role='admin' 사용자가 존재하는 흐름을 확인하라.
4. 기존 tasks legacy 테이블은 건드리지 마라.
5. 기존 supabase/migrations/037_orders_fedex_label.sql 은 절대 수정/삭제하지 마라.

변경 허용 파일:
- supabase/migrations/038_phase1_sku_master_and_exception.sql

선택적으로 새 파일 허용:
- src/lib/redact.js

수정 금지:
- src/web/routes/api.js
- public/js/dashboard.js
- 기존 migration 파일 전체 (특히 037_orders_fedex_label.sql)
- tasks legacy 테이블 관련 코드
- automation sub-app Drizzle schema
- 외부 API 파일
- package/env/config 파일

DB schema source-of-truth:
- shared schema 권위는 메인 앱 supabase/migrations/*.sql 이다.
- sub-app Drizzle schema 는 이번 PR에서 수정하지 않는다.
- sub-app Drizzle sync 는 후속 PR에서 한다.

038 migration에 포함할 것:
1. sku_master 테이블
2. sku_listing_link 테이블
3. team_tasks 컬럼 7개 추가:
   - auto_generated boolean NOT NULL DEFAULT false
   - exception_type varchar(50)
   - context jsonb
   - dedupe_key varchar(200)
   - severity varchar(20) DEFAULT 'medium'
   - related_sku_id integer FK to sku_master
   - related_order_id integer nullable, FK는 Phase 2에서
4. team_tasks_dedupe_key_active partial unique index:
   - dedupe_key 기준
   - WHERE status != 'done' AND dedupe_key IS NOT NULL
5. jobs 테이블:
   - idempotency_key unique
   - attempts
   - max_attempts
   - available_at
   - locked_at
   - locked_by
   - status, payload, priority, timestamps
6. automation_runs 테이블:
   - job_id
   - automation_type
   - triggered_by
   - input_snapshot
   - output_snapshot
   - status
   - related_sku_id
   - related_task_id
   - error fields

Phase 1에서 하지 말 것:
- worker 구현
- Shopee API 주문 수집
- 가격 자동 변경
- 배송접수
- 라벨 자동 생성
- 카카오톡 구현
- LLM 에이전트 구현

안전 조건:
- 기존 products / platform_listings / ebay_products / shopify_products / naver_products 등 삭제 금지
- 기존 team_tasks row 변경 금지
- 기존 tasks 테이블 변경 금지
- 기존 037_orders_fedex_label.sql 수정/삭제 금지
- 기존 데이터 삭제 금지
- secret 값 출력 금지

완료 후 보고:
1. 생성/수정한 파일 목록
2. migration의 각 테이블/컬럼 목적
3. 기존 데이터에 영향 없는 이유
4. rollback 방법
5. 다음 PR에서 해야 할 일
```

---

## 13. 문서 4 결론

### 13.1 Phase 1 첫 작업

가장 먼저 할 일은 **038 DB foundation migration**이다.

- `sku_master`
- `sku_listing_link`
- `team_tasks` 예외 컬럼
- `jobs`
- `automation_runs`

이것이 없으면 UI나 자동 카드 helper를 만들어도 기준 데이터가 없다.

기존 `037_orders_fedex_label.sql` 은 본 작업과 무관하게 그대로 유지된다.

### 13.2 Phase 1의 핵심 원칙

- 기존 앱을 부수지 않는다.
- 기존 업무 화면을 보호한다.
- 자동 카드는 운영자에게만 먼저 보낸다.
- SKU 기준을 신규 테이블로 명확히 한다.
- jobs는 만들되 worker는 만들지 않는다.
- 외부 API 실행은 아직 하지 않는다.
- Claude Code는 전체 구현자가 아니라 작은 PR 단위 작업자 + 리뷰어로 쓴다.
- 기존 037 등 어떤 기존 migration 파일도 수정하지 않는다.

### 13.3 다음 액션

1. 사장님이 `assignee_scope`와 `status` check constraint 여부를 확인한다.
2. Claude Code에 §12 프롬프트를 붙여넣는다.
3. PR 1 DB foundation만 작성한다.
4. migration 적용 전 diff와 rollback을 다시 검토한다.
5. PR 2 backend foundation으로 넘어간다.

---

*본 문서는 Phase 0 마지막 문서입니다. 코드/DB/설정/배포 변경 일체 없음. 실제 Phase 1 코드는 별도 PR에서 시작합니다. 변경된 파일: `docs/phase-0-recommended-next-steps.md` 1개.*
