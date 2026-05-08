# Phase 2 — Order Import + SKU Matching 계획

> 작성일: 2026-05-08 · 모드: Phase 2 시작 전 계획 문서
> 입력: `docs/wms-migration-analysis.md`, `docs/phase-0-current-system-inventory.md`, `docs/phase-0-wms-mapping.md`, `docs/phase-0-risk-and-tech-debt.md`, `docs/phase-0-recommended-next-steps.md`, `docs/phase-1-week3-verification.md`
> 본 문서는 분석/계획 문서이며 실제 코드/DB/설정 변경은 일체 없음.
> 증거 등급: **CONFIRMED** / **INFERRED** / **UNKNOWN** / **OWNER_CONFIRMED**

---

## 0. 컨텍스트

Phase 1 (SKU 마스터 + 자동 예외 콘솔) 검증 완료 (시나리오 A~H 모두 통과, OWNER_CONFIRMED). 이제 **주문 데이터를 받아들여 SKU 마스터와 연결하고, 매칭 실패 시 자동 예외 카드를 생성하는 흐름**을 만든다. 이것이 Phase 2의 핵심.

Phase 2 는 **mock JSON 입력 → wms_orders / wms_order_lines 저장 → SKU 매칭 → 실패 시 자동 카드** 까지를 다룬다. 실제 마켓 API 연동, 가격 변경, 배송 접수, 라벨 생성 등은 명확히 비목표.

### 0-A. 테이블명 결정 (2026-05-09 update)

기존 `public.orders` 테이블이 001/002/037 시점부터 운영 중인 **eBay 주문 sync 용 별 테이블** 임이 확인됨. 컬럼 충돌 + 의미 분리를 위해 본 Phase 2 의 신규 WMS 주문 테이블은 `wms_` prefix 로 분리한다.

| 기존 (eBay sync 용 — 운영 중, 무수정) | 신규 (Phase 2 WMS) |
|---|---|
| `public.orders` (eBay sync) | `wms_orders` (mock/csv/api 통합 import 입구) |
| `public.order_lines` (있다면) | `wms_order_lines` (line + SKU 매칭 결과) |
| FK constraint name (없음) | `fk_team_tasks_related_wms_order` |

기존 `public.orders` 는 **deprecated 가 아니다** — 별 운영 흐름으로 그대로 유지. 본 Phase 2 작업은 일체 건드리지 않는다.

---

## 1. Phase 2 목표와 비목표

### 1-A. 목표 (OWNER_CONFIRMED)

| # | 항목 | 비고 |
|---|---|---|
| 1 | `wms_orders` 테이블 설계 + 신설 | 039 migration (기존 public.orders 와 별 테이블) |
| 2 | `wms_order_lines` 테이블 설계 + 신설 | 039 migration |
| 3 | mock order import (JSON 폼) | admin UI |
| 4 | SKU 매칭 로직 — link / marketplace_sku / internal_sku 3단계 | `src/services/skuMatcher.js` 신규 |
| 5 | 매칭 실패 line → `SKU_MATCH_FAILED` 자동 카드 | `createExceptionTask` 재사용 |
| 6 | line당 1카드 + import당 50개 상한 + 요약 카드 | dedupe_key + 폭주 방지 |
| 7 | `team_tasks.related_order_id` FK 추가 (target = `wms_orders`) | 사전 확인 SQL 후 결정 |
| 8 | sub-app Drizzle schema sync (PR 1-B) | typed access layer (wms_orders / wms_order_lines) |

### 1-B. 비목표 (OWNER_CONFIRMED)

Phase 2 에서 **하지 않는 것**:
- 실제 마켓 API 연동 (Shopee / Naver / Coupang / eBay / Qoo10 / Alibaba / Shopify)
- title fuzzy 자동 확정
- 가격 자동 변경
- 배송 접수
- 라벨 생성
- 카카오톡 알림
- LLM 에이전트 구현
- worker 본격 구현 (jobs polling 본격 사용은 Phase 4 후보)
- CSV 업로드 (PR 5 또는 Phase 3 후보)

### 1-C. Phase 1 에서 재사용하는 자산 (CONFIRMED)

| 자산 | 위치 | Phase 2 에서의 용도 |
|---|---|---|
| `sku_master` 테이블 | 038 migration | order_line.matched_sku_id 의 FK |
| `sku_listing_link` 테이블 | 038 migration | matching 1·2단계 (link / marketplace_sku) |
| `team_tasks` 자동 예외 7컬럼 | 038 migration | `SKU_MATCH_FAILED` 카드 저장 |
| `team_tasks_dedupe_key_active` partial unique | 038 migration | 동일 key 재실패 시 새 카드 차단 |
| `createExceptionTask()` helper | [src/services/exceptionTask.js](../src/services/exceptionTask.js) | matching 실패 트리거 |
| `redact()` helper | [src/lib/redact.js](../src/lib/redact.js) | raw_payload + buyer_contact 마스킹 |
| `'operators'` scope | [src/db/teamTaskRepository.js](../src/db/teamTaskRepository.js) | 자동 카드 수신자 = 활성 admin |
| `auto_generated=false` default filter | tasks.js GET / scheduler.js | 직원 화면 보호 회귀 차단 |
| 자동 예외 콘솔 UI | [public/js/exceptionFilter.js](../public/js/exceptionFilter.js) | SKU_MATCH_FAILED 카드 노출 + 처리 |
| `jobs` / `automation_runs` schema | 038 migration (foundation only) | Phase 2 PR 5 에서 일부 사용 검토 |

### 1-D. Phase 2 에서 신규로 추가하는 자산

| 자산 | 위치 | 도입 PR |
|---|---|---|
| `wms_orders` 테이블 (기존 public.orders 와 별) | 039 migration | PR 1 |
| `wms_order_lines` 테이블 | 039 migration | PR 1 |
| `team_tasks.related_order_id` FK → `wms_orders(id)` (조건부) | 039 migration (`fk_team_tasks_related_wms_order`) | PR 1 (사전 확인 후) |
| `src/services/skuMatcher.js` (DB target = `wms_orders` / `wms_order_lines`) | 신규 | PR 2 |
| `src/services/orderImporter.js` (DB target = `wms_orders` / `wms_order_lines`) | 신규 | PR 2 |
| `src/db/orderRepository.js` (DB target = `wms_orders` / `wms_order_lines`) | 신규 | PR 2 |
| `src/web/routes/orders.js` (DB target = `wms_orders`) | 신규 | PR 2 |
| `src/web/routes/mockOrderImport.js` | 신규 | PR 2 |
| `public/js/orderImport.js` | 신규 | PR 3 |
| `public/js/orderList.js` | 신규 | PR 3 |
| sub-app Drizzle `wmsOrders` / `wmsOrderLines` typed 정의 | [automation/src/db/schema.ts](../automation/src/db/schema.ts) | PR 1-B |

증거 등급: 위 모두 **OWNER_CONFIRMED** (사용자 outline 명시).

---

## 2. 주문 데이터 모델 제안

### 2-A. `wms_orders` 테이블 (Phase 2 신규 — 기존 `public.orders` 와 별 테이블)

| 컬럼 | 타입 | 제약/기본값 | 의미 |
|---|---|---|---|
| `id` | serial | primary key | |
| `marketplace` | varchar(50) | NOT NULL | 'ebay' / 'shopify' / 'shopee' 등 |
| `external_order_id` | varchar(200) | NOT NULL | 마켓의 주문번호 |
| `order_status` | varchar(50) | NOT NULL default 'pending' | 'pending' / 'paid' / 'ready_to_ship' / 'shipped' / 'cancelled' / 'refunded' (§8 참조) |
| `buyer_name` | varchar(200) | nullable | Phase 2 에서 마스킹/미저장 (§E 보수적 정책) |
| `buyer_country` | varchar(10) | nullable | ISO 2-letter ('US' / 'KR' / 'JP' 등) |
| `buyer_contact` | jsonb | nullable | redact 적용 후 저장 (email/phone 마스킹) |
| `ordered_at` | timestamptz | nullable | 마켓 측 원 주문 시각 |
| `total_amount` | numeric(12,2) | nullable | 마켓 통화 기준 |
| `currency` | varchar(10) | nullable | 'USD' / 'KRW' / 'SGD' 등 |
| `raw_payload` | jsonb | nullable | redact 적용 후 저장 |
| `import_source` | varchar(50) | NOT NULL default 'mock' | 'mock' / 'csv' / 'api:ebay' 등 |
| `imported_by` | integer | nullable | users(id), no FK (loose coupling) |
| `created_at` | timestamptz | NOT NULL default now() | |
| `updated_at` | timestamptz | NOT NULL default now() | |

**제약**:
- `unique (marketplace, external_order_id)` — 같은 마켓의 같은 주문번호 중복 차단

**추천 인덱스**:
- `wms_orders_marketplace_external_order_id_key` on `(marketplace, external_order_id)` (UNIQUE 제약으로 자동 생성)
- `idx_wms_orders_status` on `(order_status)`
- `idx_wms_orders_ordered_at` on `(ordered_at)` (시계열 조회용)
- `idx_wms_orders_import_source` on `(import_source)` (mock/csv 통계용)

**PII 정책 (OWNER_CONFIRMED, §E 보수적)**:
- `buyer_name` 은 Phase 2 에서 nullable + mock/CSV 검증 시 마스킹 또는 미저장
- `buyer_contact` / `raw_payload` 는 저장 전 `redact()` 통과 (token / api_key / email / phone 마스킹)
- 원본 수취인명/주소/전화번호는 Phase 4 배송 단계에서 별도 정책 (Phase 2 범위 밖)
- Phase 2 는 **주문 매칭 검증에 필요한 최소 정보만 저장**

### 2-B. `wms_order_lines` 테이블 (Phase 2 신규)

| 컬럼 | 타입 | 제약/기본값 | 의미 |
|---|---|---|---|
| `id` | serial | primary key | |
| `order_id` | integer | NOT NULL references **wms_orders**(id) on delete cascade | |
| `external_line_id` | varchar(200) | NOT NULL | 마켓의 line 식별자 (eBay TransactionID 등) |
| `marketplace_sku` | varchar(200) | nullable | 마켓 측 SKU 텍스트 |
| `listing_id` | varchar(200) | nullable | eBay ItemID / Shopify ProductID 등 |
| `option_id` | varchar(200) | nullable | Variation / Variant ID |
| `title` | varchar(500) | nullable | 마켓 측 line 제목 |
| `quantity` | integer | NOT NULL default 1 | |
| `unit_price` | numeric(12,2) | nullable | 마켓 통화 기준 |
| `currency` | varchar(10) | nullable | |
| `matched_sku_id` | integer | nullable references sku_master(id) | 매칭된 내부 SKU |
| `match_status` | varchar(50) | NOT NULL default 'pending' | 'pending' / 'matched_link' / 'matched_marketplace_sku' / 'matched_internal_sku' / 'failed' |
| `match_reason` | text | nullable | 실패 사유 또는 매칭 근거 메모 |
| `match_confidence` | varchar(20) | nullable | 'high' / 'medium' / 'low' |
| `raw_payload` | jsonb | nullable | redact 적용 후 저장 |
| `created_at` | timestamptz | NOT NULL default now() | |
| `updated_at` | timestamptz | NOT NULL default now() | |

**제약**:
- `unique (order_id, external_line_id)` — 같은 주문의 같은 line 중복 차단

**추천 인덱스**:
- `idx_wms_order_lines_order_id` on `(order_id)`
- `idx_wms_order_lines_matched_sku_id` on `(matched_sku_id) WHERE matched_sku_id IS NOT NULL` (partial)
- `idx_wms_order_lines_match_status` on `(match_status)`
- `idx_wms_order_lines_marketplace_sku` on `(marketplace_sku)` (매칭 우선순위 2단계 lookup)
- `idx_wms_order_lines_listing_option` on `(listing_id, option_id)` (매칭 우선순위 1단계 lookup)

증거 등급: 위 컬럼/제약/인덱스는 **OWNER_CONFIRMED** (사용자 outline).

### 2-C. `team_tasks.related_order_id` FK 추가 (target = `wms_orders`)

Phase 1 의 038 migration 에서 `related_order_id integer` (nullable, FK 없음) 로 도입됨 (CONFIRMED — [038 migration](../supabase/migrations/038_phase1_sku_master_and_exception.sql)). Phase 2 의 `wms_orders` 테이블 생성 후 FK 를 추가한다. **컬럼명은 그대로 `related_order_id` 유지**, FK target 만 `wms_orders(id)` 로 명시. constraint name = `fk_team_tasks_related_wms_order`.

**FK 추가 전 사전 확인 SQL**:
```sql
select count(*) from team_tasks where related_order_id is not null;
-- 기대 = 0 (Phase 1 의 자동 카드는 related_order_id 를 채우지 않음)
```

**판단**:
- 결과 **0** → FK 안전하게 추가 가능 (PR 1 안의 DO block 이 자동 처리)
- 결과 **>0** → 기존 값이 `wms_orders.id` 와 매칭되는지 먼저 검증. 매칭 안 되면 FK 추가 보류 또는 cleanup 후 추가 (DO block 이 자동 skip + raise notice)

**rollback 계획**:
```sql
-- FK 추가 후 문제 발생 시
alter table team_tasks drop constraint if exists fk_team_tasks_related_wms_order;
```

증거 등급: **INFERRED** — Phase 1 코드 흐름상 `related_order_id` 를 set 하는 path 가 현재 0개 (CONFIRMED) 이지만 운영 DB 의 실제 값은 검증 시점에 확인 필요 (UNKNOWN until SQL run).

### 2-D. sub-app Drizzle 동기화

**원칙** (Phase 1 PR 5 와 정합):
- shared schema source-of-truth = 메인 앱 `supabase/migrations/*.sql`
- `automation/src/db/schema.ts` 는 typed access layer 일 뿐
- shared 테이블 변경은 메인 migration 으로만 진행

**Phase 2 처리**:
- `wms_orders` / `wms_order_lines` 정의는 039 migration 이 권위
- sub-app Drizzle sync 는 **PR 1-B** 또는 PR 1 후반부에서 별도 처리
- **본 계획 문서 작성 단계에서는 `automation/src/db/schema.ts` 를 수정하지 않는다**

**PR 1-B 가 추가할 typed 정의**:
- `wmsOrders` (camelCase 변수명 → DB table `wms_orders`, Drizzle pgTable)
- `wmsOrderLines` (DB table `wms_order_lines`, sku_master FK 명시)
- relations: `wmsOrdersRelations` (lines many), `wmsOrderLinesRelations` (order one, sku one)

증거 등급: **CONFIRMED** (Phase 1 PR 5 패턴 그대로).

---

## 3. SKU 매칭 우선순위

매칭은 보수적으로 진행한다. fuzzy 자동 확정 금지. 4단계 시도 + 모두 실패 시 SKU_MATCH_FAILED.

### 3-A. 매칭 흐름

```
order_line 입력
    │
    ▼
┌── 1. sku_listing_link exact match ──┐
│   marketplace == line.marketplace    │
│   listing_id == line.listing_id      │
│   option_id IS NOT DISTINCT FROM     │
│       line.option_id                 │
│   ──────                             │
│   match → matched_link / high        │
└──────────────────────────────────────┘
    │ 실패
    ▼
┌── 2. sku_listing_link marketplace_sku match ──┐
│   marketplace == line.marketplace              │
│   marketplace_sku == line.marketplace_sku      │
│   ──────                                       │
│   match → matched_marketplace_sku / medium     │
└────────────────────────────────────────────────┘
    │ 실패
    ▼
┌── 3. sku_master.internal_sku direct match ──┐
│   sku_master.internal_sku == line.marketplace_sku │
│   ──────                                          │
│   match → matched_internal_sku / medium           │
└───────────────────────────────────────────────────┘
    │ 실패
    ▼
[4. title fuzzy] — Phase 2 에서 미구현 (자동 확정 금지)
    │
    ▼
[5. failed] → SKU_MATCH_FAILED 자동 카드
```

### 3-B. 단계별 설계

| 단계 | 조건 | match_status | confidence |
|---|---|---|---|
| 1. link exact | `marketplace + listing_id + option_id` 매칭 (option_id NULL 일치 포함) | `matched_link` | `high` |
| 2. marketplace_sku | `marketplace + marketplace_sku` 매칭 | `matched_marketplace_sku` | `medium` |
| 3. internal_sku | `line.marketplace_sku == sku_master.internal_sku` | `matched_internal_sku` | `medium` |
| 4. title fuzzy | **Phase 2 미구현** — 설계 문서에만 future work 로 명시 | (적용 안 함) | (적용 안 함) |
| 5. failed | 1·2·3 모두 실패 | `failed` | `null` |

**option_id NULL 처리 (1단계)**:
- `IS NOT DISTINCT FROM` 사용 — `NULL = NULL` 이 NULL 이 아닌 TRUE 로 평가됨
- 옵션 없는 상품 (예: 부스터 박스 단일 SKU) 안전하게 매칭

**복수 매칭 처리**:
- 1단계 매칭에서 동일 (marketplace, listing_id, option_id) 가 여러 sku_master 에 link 되면 — 038 의 UNIQUE 제약으로 차단됨 (CONFIRMED, [038 migration line 64](../supabase/migrations/038_phase1_sku_master_and_exception.sql#L64))
- 2단계 marketplace_sku 매칭은 UNIQUE 제약 없음 → **여러 sku_master 가 매칭되면 실패 처리** (`match_reason: 'ambiguous_marketplace_sku'`)
- 3단계 internal_sku 는 UNIQUE 라 1대1 (CONFIRMED, [038 line 28](../supabase/migrations/038_phase1_sku_master_and_exception.sql#L28))

### 3-C. fuzzy match 의 future work 명시 (구현 금지)

- title 유사도 (Levenshtein, embedding 등) 는 **Phase 2.5 또는 Phase 3 후보**
- 자동 확정은 **절대 금지** — fuzzy 결과는 후보 추천만 (사람 확인 후 수동 확정)
- 본 Phase 2 PR 1~4 에서 fuzzy 코드 / API / DB schema 일체 추가 금지

### 3-D. 추천 신규 파일

- `src/services/skuMatcher.js` — `matchOrderLine(line)` 함수 export
  - 입력: `{ marketplace, marketplace_sku, listing_id, option_id }`
  - 출력: `{ matched_sku_id, match_status, match_reason, match_confidence }`
- `src/db/orderRepository.js` — `orders` / `order_lines` CRUD wrapper

증거 등급: **OWNER_CONFIRMED** (사용자 outline) + **INFERRED** (option_id NULL / 복수 매칭 디테일).

---

## 4. 자동 예외 카드 생성 규칙

### 4-A. exception_type

Phase 2 에서 핵심 추가:
- `SKU_MATCH_FAILED` (line 단위)
- `SKU_MATCH_FAILED_BATCH_OVERFLOW` (요약 카드, 50 건 초과 시)

### 4-B. dedupe_key 형식 (OWNER_CONFIRMED)

**line 단위**:
```
sku_match_failed:{marketplace}:{external_order_id}:{external_line_id}
```

예: `sku_match_failed:ebay:ORD-2026-001:LINE-A`

**같은 (marketplace, external_order_id, external_line_id) 의 활성 카드가 이미 있으면 신규 생성 안 함** (Phase 1 의 partial unique index `team_tasks_dedupe_key_active` 가 자동 보장 — [038 line 101-103](../supabase/migrations/038_phase1_sku_master_and_exception.sql#L101)).

### 4-C. line당 1카드 + 50개 상한 + 요약 카드 (OWNER_CONFIRMED)

**기본**: 매칭 실패 order_line 1개당 자동 예외 카드 1개.

**상한**: import 1회당 자동 카드 생성 상한 = **50개**.

**초과 시**: 51번째 이후 실패 line 들은 단일 요약 카드 1개로 묶음.

**요약 카드 스펙**:
```
exception_type:    SKU_MATCH_FAILED_BATCH_OVERFLOW
title:             import #N 처리 불가 (잔여 K건)
memo:              잔여 line K건 수동 확인 필요
severity:          high
assignee_scope:    'operators'
assignee_id:       null
auto_generated:    true
dedupe_key:        sku_match_failed_overflow:{marketplace}:{external_order_id}:{import_run_id}
context:           { line_count_total, line_count_capped, import_run_id, sample_line_ids[5] }
```

**구현 규칙**:
- import 시작 시 `failedCount = 0` 카운터
- 각 실패 line 처리 시 `failedCount++`
- `failedCount <= 50` → 정상 line 카드 생성
- `failedCount > 50` → 카드 생성 skip, `cappedLines[]` 에 push
- import 종료 후 `cappedLines.length > 0` 이면 요약 카드 1개 생성

### 4-D. context 포함 항목

자동 카드의 `team_tasks.context` JSONB 에 저장할 정보 (redact 통과 후):

**포함**:
- `marketplace`
- `external_order_id`
- `external_line_id`
- `title` (line 제목, 마스킹 불필요)
- `marketplace_sku`
- `listing_id`
- `option_id`
- `quantity`
- `buyer_country` (단순 ISO 코드 — PII 아님)

**제외 (저장 금지)**:
- `buyer_email` 원본 (마스킹 형태도 line 카드에는 부적절)
- `buyer_phone` 원본
- `buyer_address` 원본
- `buyer_name` 원본
- `access_token` / `api_key` / `service_role_key` 류 일체

→ `redact()` 가 1차 차단하지만, exceptionTask 호출 시 명시적으로 위 "포함" 필드만 추려 넘기는 것이 안전.

### 4-E. created_by 정책 (Phase 1 fix 정합)

| import 경로 | created_by |
|---|---|
| mock import (admin UI) | 실행 admin 의 `req.user.id` |
| CSV import (Phase 3 후보) | 업로드 admin 의 id |
| API import (Phase 4) | system user 정책 — Phase 4 에서 결정 (현재 UNKNOWN) |

`exceptionTask.createExceptionTask()` 가 `opts.createdBy` 받아서 처리 (Phase 1 fix CONFIRMED).

### 4-F. assignee 정책

- `assignee_scope = 'operators'` (활성 admin 전원 recipient)
- `assignee_id = null`
- 자동 카드 생성 후 직원 재배정은 **후속 PR** (Phase 1 미해결 시나리오 3 — tasks.js:164 메타 PATCH 비활성)

증거 등급: **OWNER_CONFIRMED** (요약 카드 포함 사용자 명시).

---

## 5. Phase 2 PR 분할

5~6개 PR. 각 PR은 1~3일 안에 리뷰 가능한 크기 유지.

### PR 1 — DB foundation (039 migration)

**목표**:
- `wms_orders` 테이블 신설 (기존 `public.orders` 와 별 테이블)
- `wms_order_lines` 테이블 신설
- 인덱스 + UNIQUE 제약
- `team_tasks.related_order_id` FK → `wms_orders(id)` 추가 (사전 확인 SQL 통과 시, constraint name `fk_team_tasks_related_wms_order`)

**파일 후보**:
- `supabase/migrations/039_phase2_orders.sql`

**주의**:
- 본 계획 문서 작성 단계에서는 SQL 파일 만들지 않음 (이번 실행 룰)
- 037, 038 무수정
- legacy `tasks` 테이블 무수정
- 기존 `products` / `platform_listings` / `ebay_products` 등 마켓 mirror 무수정

**검증**:
- `wms_orders` / `wms_order_lines` 컬럼 + 제약 정상 — information_schema.columns 쿼리 (Supabase Studio 호환)
- `select conname from pg_constraint where conname = 'fk_team_tasks_related_wms_order';` → 1 row (Path A) 또는 0 row + raise notice (Path B/C)
- `select count(*) from team_tasks where related_order_id is not null;` → FK 추가 안전 여부 판단
- 기존 `public.orders` 무수정 확인 — `select count(*) from orders;` 결과 변화 없음

### PR 1-B — sub-app Drizzle sync

**목표**:
- `automation/src/db/schema.ts` 에 `wmsOrders` / `wmsOrderLines` typed 정의 추가
- relations 추가
- 메인 SQL (039 의 wms_orders / wms_order_lines) 과 100% 정합 (Phase 1 PR 5 패턴)

**파일 후보**:
- `automation/src/db/schema.ts`

**주의**:
- PR 1과 분리하거나 PR 1 후반부로 묶을 수 있음
- 순서: 메인 migration (PR 1) → Drizzle sync (PR 1-B). 역순 금지.
- `drizzle-kit pull` diff 0 검증 (Phase 0 문서 3 §3-4)

### PR 2 — backend matching service

**목표**:
- mock order JSON import 흐름 (입력 → orders/order_lines 저장 → 매칭 → 자동 카드)

**파일 후보**:
- `src/services/skuMatcher.js` (신규) — 3단계 매칭 로직
- `src/services/orderImporter.js` (신규) — JSON 입력 → 저장 + 매칭 + 카드 생성 orchestration
- `src/db/orderRepository.js` (신규) — orders/order_lines CRUD
- `src/web/routes/orders.js` (신규) — 주문 목록/상세 GET API
- `src/web/routes/mockOrderImport.js` (신규) — admin only POST `/api/orders/mock-import`
- `server.js` — 신규 라우트 2개 등록 (Phase 1 패턴: 2~3 줄 추가만)

**기능** (DB target 은 모두 `wms_orders` / `wms_order_lines` — 기존 `public.orders` 무관):
1. mock order JSON 받기 (admin only)
2. `wms_orders` + `wms_order_lines` 트랜잭션 저장
3. 각 `wms_order_lines` row 에 대해 `skuMatcher.matchOrderLine()` 실행
4. matched / failed 결과를 `wms_order_lines` 에 update
5. failed line 별 `SKU_MATCH_FAILED` 자동 카드 (50개 상한 + 요약 카드)
6. import 결과 응답 (order_id = `wms_orders.id`, total, matched_count, failed_count, cards_created)

**주의**:
- `api.js` 본문 수정 금지 (Phase 1 격리 룰)
- redact 적용 — `wms_orders.raw_payload`, `wms_orders.buyer_contact`, `wms_order_lines.raw_payload` 모두
- 파일/서비스명은 `orderImporter.js`, `orderRepository.js`, `orders.js` 등 그대로 유지 — 단 내부 DB target 만 `wms_*`

### PR 3 — admin UI

**파일 후보**:
- `public/js/orderImport.js` (신규) — mock JSON 입력 폼
- `public/js/orderList.js` (신규) — 주문 목록 + 라인 매칭 상태 표시
- `public/index.html` — 사이드바 메뉴 + page div + script tag (Phase 1 PR 4 패턴)
- `public/js/dashboard.js` — case 분기 2~3 줄만 추가

**기능**:
- 운영 메뉴 그룹에 신규 진입점 추가 (예: `📥 주문 가져오기`, `📋 주문 목록`)
- mock JSON 입력 textarea + 검증 + 제출
- import 결과 alert + 자동 예외 카드 링크 (`/?page=exception-tasks&filter=...`)
- 주문 목록: order_id, marketplace, status, line 수, matched/failed count
- 주문 상세: order_lines 표 (matched_sku_id, match_status, 실패 시 SKU_MATCH_FAILED 카드 링크)

**주의** (Phase 1 격리 룰 유지):
- dashboard.js 본문 수정 금지 (case 분기 + 주석만)
- api.js 본문 수정 금지 (신규 API 는 별 라우트 파일)

### PR 4 — E2E validation

**목표**: PR 1~3 합쳐 mock 주문 1건 import 흐름 끝까지 검증.

**시나리오**:
1. order 1건 + line 2개 (1개 매칭 성공, 1개 매칭 실패) mock JSON 입력
2. `wms_orders` 1 row, `wms_order_lines` 2 row 생성
3. 1개 line `match_status='matched_link'`, 1개 `match_status='failed'`
4. failed line 에 대응하는 `SKU_MATCH_FAILED` 자동 카드 1개 생성
5. dedupe 동작 확인 — 같은 mock 재실행 시 카드 안 늘어남
6. PII 마스킹 확인 — buyer_contact / raw_payload 의 token/email/phone 마스킹

산출물: `docs/phase-2-week-N-verification.md` (Phase 1 검증 가이드 형식 그대로).

### PR 5 — CSV import 또는 jobs polling 결정 (선택)

**선택지**:
| 옵션 | 내용 | Phase |
|---|---|---|
| A | CSV import 추가 (multer + 매핑 모듈) | PR 5 또는 Phase 3 |
| B | jobs polling 일부 사용 (mock import 를 jobs 큐에 넣기) | PR 5 또는 Phase 4 |

**추천**:
- PR 1~4 검증 후 결정
- Phase 2 초반은 JSON mock import 만으로 충분 (OWNER_CONFIRMED — §A)
- CSV: Phase 3 후보 기본
- jobs polling 본격: Phase 4 후보 기본

증거 등급: **OWNER_CONFIRMED** (사용자 outline).

---

## 6. 검증 시나리오

PR 4 의 E2E 검증 단계에서 사용. Phase 1 검증 가이드 (`docs/phase-1-week3-verification.md`) 와 동일 형식.

### 시나리오 A — mock 주문 1건 import (성공 + 실패 혼합)

**조건**:
- order 1건
- order_line 2개
  - line 1: `marketplace=ebay, listing_id=L1, option_id=O1` → 사전에 sku_listing_link 등록된 케이스
  - line 2: `marketplace=ebay, listing_id=Lx, marketplace_sku=UNKNOWN-SKU` → 매칭 실패

**기대**:
- `wms_orders` 1 row (marketplace=ebay, external_order_id=...)
- `wms_order_lines` 2 rows
- line 1: `match_status='matched_link'`, `match_confidence='high'`, `matched_sku_id=N`
- line 2: `match_status='failed'`, `match_reason` 에 실패 사유
- 기존 `public.orders` 변화 0 row (별 테이블 — 본 import 와 무관)

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 B — 매칭 실패 line 의 자동 예외 카드 생성

**기대**:
- `team_tasks` 에 1 row 추가
- `auto_generated=true`
- `exception_type='SKU_MATCH_FAILED'`
- `assignee_scope='operators'`
- `related_order_id` = 시나리오 A 의 `wms_orders.id` (FK `fk_team_tasks_related_wms_order` 적용된 경우)
- `context` 에 marketplace / external_order_id / external_line_id / marketplace_sku / listing_id / quantity / buyer_country 포함
- `dedupe_key='sku_match_failed:ebay:ORD-...:LINE-...'`

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 C — 같은 주문 재 import (idempotency)

**기대**:
- `wms_orders` 의 `unique (marketplace, external_order_id)` 제약으로 중복 차단 (23505 에러 또는 명시적 idempotent skip)
- `wms_order_lines` 중복 생성 안 됨
- 자동 예외 카드 새로 생성 안 됨 (dedupe_key 동작)

**구현 결정 필요**: 중복 시 (a) 409 에러 / (b) idempotent update / (c) 새 import_run_id 로 진행 — PR 2 에서 결정.

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 D — PII 마스킹

**확인 위치**:
- `wms_orders.buyer_contact` (jsonb)
- `wms_orders.raw_payload` (jsonb)
- `wms_order_lines.raw_payload` (jsonb)
- `team_tasks.context` (자동 카드 jsonb)

**기대**:
- `buyer_email` 원본 부재 (마스킹된 형태 또는 미저장)
- `buyer_phone` 원본 부재
- `api_token` / `service_role_key` 등 키 패턴 → `[REDACTED]`
- email 패턴 → `t***@example.com`
- 한국 휴대전화 패턴 → `[PHONE]`

**검증 SQL**:
```sql
select buyer_contact, raw_payload from wms_orders where id = <테스트 wms_orders.id>;
-- 위 결과의 모든 secret/PII 가 마스킹됨
```

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 E — staff 화면 보호 회귀

**기대** (Phase 1 의 staff 화면 보호 정책 유지):
- staff 계정으로 일반 업무 화면 (`/?page=tasks`) 진입 시
- SKU_MATCH_FAILED 자동 카드 미노출
- staff 가 자동 예외 콘솔 (`/?page=exception-tasks`) 진입 시 "관리자 전용" 표시

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 F — 매칭 우선순위 검증

**케이스별 input + 기대 output**:

| 케이스 | line.marketplace_sku | line.listing_id | line.option_id | sku_listing_link 사전 등록 | 기대 match_status |
|---|---|---|---|---|---|
| F-1 | `MS-A` | `L1` | `O1` | (ebay, L1, O1) → SKU#1 | `matched_link` |
| F-2 | `MS-A` | `L9` | null | (ebay, marketplace_sku=MS-A) → SKU#2 | `matched_marketplace_sku` |
| F-3 | `INTERNAL-A` | `L9` | null | (없음) | `matched_internal_sku` (sku_master.internal_sku=INTERNAL-A) |
| F-4 | `UNKNOWN` | `Lx` | null | (없음) | `failed` |

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 G — fuzzy match 미구현 확인

**기대**:
- title 만으로 자동 확정되는 case 없음
- title 유사도 알고리즘 (Levenshtein 등) 코드 부재
- fuzzy 후보를 자동으로 matched_sku_id 에 채우는 path 없음

**검증** — 반례 케이스:
- line.title = "Pokemon 151 Booster Box", line.marketplace_sku = `WRONG`
- sku_master 에 `internal_sku='PMC-151-BOX'`, `title='포켓몬 151 부스터 박스'` 존재
- 기대: `match_status='failed'` (title 으로 자동 매칭 안 함)

**통과 여부**: [ ] 통과 / [ ] 실패

### 시나리오 H — 기존 037 / 038 / legacy tasks 무변경

**기대**:
- `git diff supabase/migrations/037_orders_fedex_label.sql` 빈 출력
- `git diff supabase/migrations/038_phase1_sku_master_and_exception.sql` 빈 출력
- `git diff supabase/migrations/008_executive_team.sql` 빈 출력

**통과 여부**: [ ] 통과 / [ ] 실패

---

## 7. 리스크와 완화책

| # | 리스크 | 등급 | 완화책 |
|---|---|---|---|
| 1 | 주문 중복 import (같은 external_order_id 두 번) | **HIGH** | `unique (marketplace, external_order_id)` + idempotency 정책 PR 2에서 결정 (시나리오 C) |
| 2 | SKU 오매칭 (잘못된 SKU 에 line 연결) | **HIGH** | fuzzy 자동 확정 금지, exact 우선, 복수 매칭 시 fail 처리 (§3-B) |
| 3 | PII (buyer_email/phone/token) 저장 | **HIGH** | redact 적용 후 저장 (Phase 1 helper 재사용), 원본 배송정보는 Phase 4 분리 |
| 4 | option_id 없는 상품 매칭 실패 | MEDIUM | option_id nullable + `IS NOT DISTINCT FROM` 비교 (§3-B 1단계) |
| 5 | CSV 컬럼 불일치 / 마켓별 형식 차이 | MEDIUM | CSV 는 PR 5 또는 Phase 3 로 미룸 (§5 PR 5) |
| 6 | 자동 예외 카드 폭주 (1 import 에 100+ 실패) | **HIGH** | line당 1카드 + 50개 상한 + 요약 카드 (§4-C) |
| 7 | `related_order_id` FK 추가 시 기존 데이터 충돌 | MEDIUM | FK 추가 전 사전 확인 SQL (§2-C) |
| 8 | worker 범위 확대 (jobs polling 본격 시도) | MEDIUM | Phase 2 에서는 worker 본격 구현 금지 (§1-B), PR 5 에서 결정 |
| 9 | fuzzy match 욕심 → 자동 확정 | **HIGH** | 코드/스펙 모두에서 fuzzy 자동 확정 명시 금지 (§3-C) |
| 10 | mock import 가 production DB 에 직접 row 생성 | MEDIUM | admin only + import_source='mock' 으로 식별, staging 권장 |
| 11 | 동시 import 두 건이 같은 dedupe_key 카드 생성 시도 | LOW | partial unique index 가 23505 로 차단 (Phase 1 의 createExceptionTask 가 race catch) |

증거 등급: **OWNER_CONFIRMED** (사용자 outline 의 표) + **INFERRED** (등급 8/10/11 추가).

---

## 8. Phase 2 시작 전 차단 점검표

사용자가 결정해야 할 항목 7개:

| # | 결정 항목 | 추천 초기값 | 결정 시점 |
|---|---|---|---|
| 1 | mock order JSON 기본 샘플 1건 (eBay 형식) | §8-A 의 샘플 사용 | PR 1 시작 직전 |
| 2 | `order_status` 초기값 enum | §8-B 의 6개 | PR 1 |
| 3 | sku_master 테스트 SKU 5~10개 | (사장님이 운영 데이터에서 선정) | PR 4 시작 전 |
| 4 | sku_listing_link 테스트 link 2~3개 | (위 SKU 와 1대1) | PR 4 시작 전 |
| 5 | 자동 카드 직원 재배정 PR 시기 | Phase 2 이후 (자동 카드 양 적으면) | PR 4 직후 |
| 6 | CSV import 시기 | Phase 3 후보 | PR 4 직후 |
| 7 | jobs polling 본격 사용 시기 | Phase 4 후보 | PR 4 직후 |

### 8-A. mock order JSON 샘플 (eBay 형식, 권장)

```json
{
  "marketplace": "ebay",
  "external_order_id": "EBAY-2026-001",
  "order_status": "paid",
  "buyer_country": "US",
  "ordered_at": "2026-05-08T14:30:00Z",
  "total_amount": 89.99,
  "currency": "USD",
  "lines": [
    {
      "external_line_id": "TXN-A",
      "marketplace_sku": "PMC-151-BOX",
      "listing_id": "123456789012",
      "option_id": null,
      "title": "Pokemon 151 Booster Box",
      "quantity": 1,
      "unit_price": 89.99,
      "currency": "USD"
    }
  ]
}
```

eBay 마켓 속성 매핑 (OWNER_CONFIRMED):
- `ItemID` → `listing_id`
- `Variation` → `option_id`
- `Buyer Country` → `buyer_country`
- `OrderID` (eBay) → `external_order_id`
- `TransactionID` (eBay) → `external_line_id`

### 8-B. order_status enum (추천)

| 값 | 의미 |
|---|---|
| `pending` | 주문 도착, 매칭/처리 전 |
| `paid` | 결제 완료 |
| `ready_to_ship` | 매칭 완료 + 출고 준비 |
| `shipped` | 출고 완료 (Phase 4 에서 사용) |
| `cancelled` | 마켓 취소 |
| `refunded` | 환불 |

증거 등급: **OWNER_CONFIRMED** (사용자 outline) + **INFERRED** (eBay 매핑).

---

## 9. Phase 2 PR 1용 Claude Code 프롬프트 (실 적용본 — 2026-05-09 update)

PR 1 (DB foundation) 적용 시 사용한 프롬프트. **테이블명은 `wms_orders` / `wms_order_lines`** (기존 `public.orders` 와 별 테이블).

```text
Phase 2 PR 1 — Order DB foundation 작업을 시작하라.

목표:
WMS Phase 2 의 주문 DB 토대를 만든다.
이번 PR 은 DB migration 중심이며, 제품 코드 변경은 최소화한다.

변경 허용 파일:
- supabase/migrations/039_phase2_orders.sql

수정 금지:
- supabase/migrations/037_orders_fedex_label.sql
- supabase/migrations/038_phase1_sku_master_and_exception.sql
- 기존 migration 파일 전체
- src/web/routes/api.js
- public/js/dashboard.js
- legacy tasks 관련 코드 (008 마이그레이션의 tasks UUID PK 테이블)
- package.json / automation/package.json
- automation/src/db/schema.ts

중요:
- automation/src/db/schema.ts sync 는 PR 1-B 또는 후속 PR로 분리한다.
- shared schema source-of-truth 는 메인 앱 Supabase migration 이다.

사전 확인:
- team_tasks.related_order_id 에 기존 값이 있는지 확인하라.
- 확인 SQL:
  select count(*) from team_tasks where related_order_id is not null;
- 0이면 FK 추가 가능성이 높다.
- 0이 아니면 FK 추가 전 값 정합성을 먼저 검토하라 (orders.id 와 매칭되는지).

중요 — 기존 public.orders 는 eBay 주문 sync 용 별 테이블이다 (001/002/037 시점부터 운영 중).
신규 WMS 주문 테이블은 wms_ prefix 로 분리한다. 기존 public.orders 는 일체 건드리지 않는다.

039 migration 에 포함할 것:
1. wms_orders 테이블 (기존 public.orders 와 별 테이블)
   - id serial primary key
   - marketplace varchar(50) not null
   - external_order_id varchar(200) not null
   - order_status varchar(50) not null default 'pending'
   - buyer_name varchar(200)
   - buyer_country varchar(10)
   - buyer_contact jsonb
   - ordered_at timestamptz
   - total_amount numeric(12,2)
   - currency varchar(10)
   - raw_payload jsonb
   - import_source varchar(50) not null default 'mock'
   - imported_by integer
   - created_at timestamptz not null default now()
   - updated_at timestamptz not null default now()
   - unique (marketplace, external_order_id)
2. wms_order_lines 테이블
   - id serial primary key
   - order_id integer not null references wms_orders(id) on delete cascade
   - external_line_id varchar(200) not null
   - marketplace_sku varchar(200)
   - listing_id varchar(200)
   - option_id varchar(200)
   - title varchar(500)
   - quantity integer not null default 1
   - unit_price numeric(12,2)
   - currency varchar(10)
   - matched_sku_id integer references sku_master(id) on delete set null
   - match_status varchar(50) not null default 'pending'
   - match_reason text
   - match_confidence varchar(20)
   - raw_payload jsonb
   - created_at timestamptz not null default now()
   - updated_at timestamptz not null default now()
   - unique (order_id, external_line_id)
3. 인덱스:
   - wms_orders(order_status), wms_orders(ordered_at), wms_orders(import_source)
   - wms_order_lines(order_id)
   - wms_order_lines(matched_sku_id) WHERE matched_sku_id IS NOT NULL  (partial)
   - wms_order_lines(match_status)
   - wms_order_lines(marketplace_sku)
   - wms_order_lines(listing_id, option_id)
4. team_tasks.related_order_id FK 추가 (target = wms_orders):
   - DO block 으로 conditional add (Postgres 가 ADD CONSTRAINT IF NOT EXISTS 미지원)
   - constraint name = fk_team_tasks_related_wms_order
   - 같은 이름 constraint 있으면 skip
   - orphan row (related_order_id 가 wms_orders.id 에 매칭 안 됨) 있으면 skip + raise notice
   - 그 외 안전 추가:
     alter table team_tasks add constraint fk_team_tasks_related_wms_order
       foreign key (related_order_id) references wms_orders(id) on delete set null;

비파괴 설계:
- 모든 CREATE TABLE 에 IF NOT EXISTS
- 모든 인덱스에 IF NOT EXISTS
- ALTER TABLE 의 FK 추가는 IF EXISTS / IF NOT EXISTS 활용 어려우므로 사전 확인 + 명시적 주석

Phase 2 PR 1 에서 하지 말 것:
- 실제 마켓 API 연동
- mock import backend
- frontend UI
- CSV import
- worker 본격 구현
- 가격 변경 / 배송 / 라벨
- LLM 에이전트
- automation/src/db/schema.ts 수정

안전 조건:
- 기존 037, 038 무수정
- legacy tasks 무변경
- package.json 무변경
- secret 값 출력 금지
- 기존 데이터 삭제 금지
- DROP / TRUNCATE / DELETE 기존 테이블 금지
- 기존 products / platform_listings / ebay_products 등 마켓 mirror 무수정

완료 후 보고:
1. 생성/수정한 파일 목록
2. orders / order_lines 의 각 컬럼 목적
3. 기존 데이터 영향 없는 근거 (38 행 team_tasks 보호 등)
4. related_order_id FK 처리 방식 (사전 확인 결과 + 적용/보류 결정)
5. rollback 방법 (drop constraint + drop table 순서)
6. PR 1-B 또는 PR 2 에서 할 일
```

---

## 10. 본 문서 결론 + 다음 액션

### 결론 한 줄

Phase 2 = **mock JSON 주문 → orders/order_lines 저장 → exact-only SKU 매칭 → 실패 시 line당 1카드 (50개 상한 + 요약)**. fuzzy 자동 확정 / 가격 / 배송 / 외부 API 일체 비목표.

### 사장님 다음 액션

1. **본 문서 검토** — §8 의 7개 결정 항목 review
2. **결정 7개 확정** (특히 mock JSON 샘플 + order_status enum)
3. **PR 1 시작 신호** → §9 의 프롬프트 사용
4. **PR 1 완료 후 PR 1-B (Drizzle sync) 또는 바로 PR 2 (backend) 진행**

### 후속 문서 (Phase 2 진행 중 작성 예정)

- Phase 2 검증 가이드 (`docs/phase-2-week-N-verification.md`) — Phase 1 검증 가이드 형식 그대로
- Phase 2 진행 로그 (필요 시 plan 파일 갱신)

---

*본 문서는 분석/계획 문서입니다. 코드/DB/설정/배포 변경 일체 없음. 변경된 파일: `docs/phase-2-order-import-and-sku-matching-plan.md` 1개.*
