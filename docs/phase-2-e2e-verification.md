# Phase 2 E2E Verification Guide

> 작성일: 2026-05-09 · 모드: 수동 손검증 체크리스트
> 입력 상태: Phase 2 PR 1 / 1-B / 2 / 3 + PR 3 patch 모두 commit + push 완료. 040 migration **미생성** (사용자 결정으로 폐기, 039 schema 만으로 진행).
> 본 문서는 분석 문서가 아니라 **사장님이 Railway 배포 후 브라우저 + Supabase Studio 에서 직접 손으로 따라가는 체크리스트**.

---

## 1. 검증 목적

- Phase 2 전체 흐름이 정상 동작하는지 단일 손검증으로 확정
- mock JSON 주문 import 동작 (POST /api/orders/mock-import)
- SKU 매칭 (matched_link / matched_marketplace_sku / matched_internal_sku / failed)
- 매칭 실패 line 의 SKU_MATCH_FAILED 자동 예외 카드 생성
- 중복 주문 방지 (HTTP 409 + DUPLICATE_ORDER + existing_order_id)
- PII / secret 마스킹 (raw_payload / buyer_contact / 자동 카드 context)
- staff 접근 가능 회귀 (메뉴 노출 + 직접 URL 통과 + API 200/201) — **권한 차단 → 실행자 추적으로 정책 전환** (§11 참조)
- **기존 운영 흐름 보호** — public.orders / eBay sync / 037·038·039 migration 무영향
- **040 migration 없이 039 schema 만으로** Phase 2 backend / matching / 자동 카드가 동작

본 검증 통과 = Phase 2 완료 선언 + Phase 3 진입 가능.

---

## 1-A. 권한 정책 (2026-05-10 변경 — 본 PR 기준)

본 PR 기준의 새 정책. 기존 `admin only` 차단 → `staff 도 사용 가능 + 실행자/조회자 추적` 으로 전환.

### 원칙

1. **권한 차단보다 실행자 기록 우선**. WMS 주문 / 자동 예외 / mock import / 향후 자동화 / 가격변경 / 배송접수 / 라벨생성 모두 staff 도 사용할 수 있어야 한다.
2. 모든 변경 액션은 `executed_by = req.user.id` 로 기록한다 (현 PR 의 `wms_orders.imported_by` 가 그 첫 사례).
3. **읽기 차단 ≠ 보안**. 작은 팀에서 staff 의 정상 업무 흐름을 막는 것은 비용이 크고 보안 가치가 거의 없다.
4. 보안은 **차단** 이 아니라 **추적 + 되돌리기 가능성** 으로 확보 — 후속 Safety Foundation PR 에서 보강 (변경 전/후 값 + 성공/실패 + 되돌리기 / 취소 프로세스 + 감사 로그).
5. legacy 공유 비번 계정 (`userId=0`) 의 쓰기 차단 (`blockLegacyWrites`) 은 **유지** — 실 사용자 id 가 없어 추적이 불가능하기 때문이다 (정책 충돌 아님).

### 본 PR 적용 범위

| 영역 | 변경 | 비고 |
|---|---|---|
| `📦 WMS 주문` 메뉴 (사이드바) | `data-admin-only` 제거 → staff 노출 | `index.html:599` |
| GET `/api/orders` | `requireAdmin` → `requireAuth` | `routes/orders.js` |
| GET `/api/orders/:id` | `requireAdmin` → `requireAuth` | `routes/orders.js` |
| POST `/api/orders/mock-import` | `requireAdmin` → `requireAuth` | `routes/mockOrderImport.js`, `imported_by = req.user.id` 그대로 |
| `orderImport.js` UI 가드 | `user.isAdmin` → `user.id` (로그인만) | `public/js/orderImport.js` |
| `orderList.js` UI 가드 | `user.isAdmin` → `user.id` (로그인만) | `public/js/orderList.js` |

### 본 PR 에서 다루지 않는 것 (후속 PR — Safety Foundation)

- 자동 예외 카드 (Phase 1 의 `📦 SKU 마스터` / `⚠️ 자동 예외`) 의 staff 노출
- 변경 전/후 값을 기록하는 `automation_runs` 표준화
- 성공/실패 status + 되돌리기/취소 프로세스
- 가격변경/배송접수/라벨생성 등 향후 자동화 액션 — 본 PR 범위 밖. 본 PR 에서 새로운 액션 기능 추가 금지.

---

## 2. 사전 조건

| 항목 | 체크 |
|---|---|
| Railway 최신 배포 성공 (Railway Dashboard 의 Active deploy commit hash 가 `git log` 최상단과 일치) | ☐ |
| 관리자 계정 1+ 명 로그인 가능 (`role='admin'`, `is_active=true`) | ☐ |
| staff 계정 1+ 명 준비 (회귀 테스트용 — `role='staff'`, `is_active=true`) | ☐ |
| sku_master 에 테스트 SKU 존재 (§4-4 SQL 통과) | ☐ |
| sku_listing_link 에 테스트 link 존재 (§4-5 SQL 통과) | ☐ |
| 040 migration **미생성** 상태 (§3 의 `test ! -f` 통과) | ☐ |
| Supabase Studio SQL Editor 접근 가능 | ☐ |
| 브라우저 DevTools (Network 탭) 사용 가능 | ☐ |

### 2-A. 테스트 SKU (사전 등록 필수)

`📦 SKU 마스터` 화면에서 입력:
| 필드 | 값 |
|---|---|
| internal_sku | `PMC-151-BOX` |
| title | `포켓몬 151 부스터 박스` |
| status | `active` |
| automation_enabled | OFF (Phase 2 검증에 무관) |

### 2-B. 테스트 sku_listing_link (위 SKU 의 행에서 🔗 버튼)

| 필드 | 값 |
|---|---|
| marketplace | `ebay` |
| listing_id | `123456789012` |
| option_id | (비움 — null) |
| marketplace_sku | `PMC-151-BOX` (선택) |
| is_primary | ✓ (선택) |

### 2-C. 메모용 (시나리오 진행 중 채워야 할 값)

검증 진행 중 발견되는 값을 메모하면 나머지 시나리오에서 재사용 (시나리오 B → C/D/F):

```
시나리오 B (Unique import):
  external_order_id: ___________________________ (예: EBAY-TEST-20260509-150000)
  wms_orders.id:    ___________________________
  matched_count:    _____
  failed_count:     _____
  cards_created:    _____

시나리오 E (Fixed import):
  external_order_id: EBAY-2026-001
  1차 wms_orders.id: ___________________________
  2차 응답 status:    _____ (기대: 409)
  existing_order_id: ___________________________ (= 1차 wms_orders.id)
```

---

## 3. 배포 전 git 안전 확인

local terminal 에서 실행:

```bash
cd /Users/parksungmin/pmc-work-mvp

# 1) git 상태 + 최근 commit
git status --short
git log --oneline -8

# 2) 금지 파일 무수정 (모두 빈 출력 = 통과)
git diff src/web/routes/api.js
git diff public/js/dashboard.js
git diff supabase/migrations/037_orders_fedex_label.sql
git diff supabase/migrations/038_phase1_sku_master_and_exception.sql
git diff supabase/migrations/039_phase2_orders.sql
git diff package.json automation/package.json

# 3) 040 migration 부재 확인
test ! -f supabase/migrations/040_phase2_wms_order_matching_fields.sql && echo "040 migration not created"

# 4) Railway URL 접속 확인 (HTTP 200 또는 302 redirect)
curl -sI https://pmc-work-mvp-production.up.railway.app/ | head -1
```

### 기대 결과

| # | 검증 | 통과 기준 |
|---|---|---|
| 1 | `git log` 최상단 또는 근처 | Phase 2 PR 3 commit (예: `frontend: add WMS order import and list UI`) + PR 3 patch (예: `frontend(wms-orders): split example JSON button (fixed + Unique)`) 표시 |
| 2 | 모든 `git diff` 출력 | **0 줄** (working tree 깨끗 / 금지 파일 무수정) |
| 3 | `test ! -f` 결과 | `040 migration not created` 출력 |
| 4 | `curl -sI` 결과 | `HTTP/2 200` 또는 `HTTP/2 302` |

남아도 되는 untracked (Phase 2 와 무관):
- `automation.bak/`
- `public/images/template main.png`

**§3 통과 여부**: ☐ 통과 / ☐ 실패

---

## 4. DB 사전 확인 SQL (Supabase Studio SQL Editor)

### 4-1. WMS 테이블 존재 확인

```sql
select to_regclass('public.wms_orders')      as wms_orders;
select to_regclass('public.wms_order_lines') as wms_order_lines;
```

**기대**: 둘 다 NULL 이 아니라 `public.wms_orders` / `public.wms_order_lines` 반환.

### 4-2. team_tasks → wms_orders FK 확인

```sql
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'fk_team_tasks_related_wms_order';
```

**기대**:
- `conname = fk_team_tasks_related_wms_order`
- `pg_get_constraintdef = FOREIGN KEY (related_order_id) REFERENCES wms_orders(id) ON DELETE SET NULL`

만약 0 행 = 039 의 DO block 이 orphan row 등으로 skip 됐을 수 있음. §3 SQL 의 raise notice 결과 재확인 + cleanup 후 FK 수동 추가 (039 본문 주석 참조).

### 4-3. 039 에 포함된 matching 필드 확인 (040 추가가 아니라 039 자체)

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'wms_order_lines'
  and column_name in ('listing_id','option_id','match_confidence','match_reason')
order by column_name;
```

**기대 — 4 행 모두 표시**:
| column_name | data_type |
|---|---|
| `listing_id` | `character varying` |
| `match_confidence` | `character varying` |
| `match_reason` | `text` |
| `option_id` | `character varying` |

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'wms_orders'
  and column_name = 'buyer_country';
```

**기대 — 1 행**: `buyer_country` / `character varying`.

→ 040 미생성 상태에서 PR 2 / PR 3 가 정상 동작하는 schema 가 이미 039 에 다 들어있음을 확인.

### 4-4. 테스트 SKU 확인

```sql
select id, internal_sku, title, status
from sku_master
where internal_sku = 'PMC-151-BOX';
```

**기대**: 1+ 행, status = `active`.

누락 시: §2-A 따라 사이드바 `📦 SKU 마스터` 에서 등록 후 재실행.

### 4-5. 테스트 sku_listing_link 확인

```sql
select id, sku_id, marketplace, listing_id, option_id, marketplace_sku
from sku_listing_link
where marketplace = 'ebay'
  and listing_id = '123456789012';
```

**기대**: 1+ 행, `sku_id` 가 §4-4 의 SKU id 와 일치.

누락 시: §2-B 따라 SKU 마스터 화면의 🔗 버튼에서 추가 후 재실행.

### 4-6. 진입 차단

위 5 SQL 중 어느 하나라도 실패 → **시나리오 A 진입 금지**. 사전 조건 갖춘 후 재진입.

**§4 통과 여부**: ☐ 통과 / ☐ 실패

---

## 5. 시나리오 A — WMS 주문 화면 접근

### 절차

1. https://pmc-work-mvp-production.up.railway.app 접속
2. **로그인** (admin 또는 staff — 정책 §1-A 에 따라 둘 다 접근 가능)
3. 사이드바 운영 관리 그룹에서 `📦 WMS 주문` 메뉴 확인
4. 클릭 → wms-orders 화면 진입

### 기대

- [ ] 사이드바에 **📦 WMS 주문** 표시 (ops-menu, `#81d4fa` 색)
- [ ] 클릭 시 화면 전환 성공
- [ ] 상단 영역: "📦 WMS 주문 Import / 매칭" 헤더
- [ ] mock JSON 입력 영역 표시 (textarea + 버튼들)
- [ ] **`예시 JSON 채우기`** 버튼 (회색) 표시
- [ ] **`예시 JSON 채우기 (Unique)`** 버튼 (파란색) 표시
- [ ] **`Import 실행`** 버튼 표시
- [ ] **`비우기`** 버튼 표시
- [ ] 하단 영역: 좌측 주문 목록 + 우측 상세 패널
- [ ] 우측 상세 패널 초기 메시지: "왼쪽에서 주문을 선택하세요."

### 실패 시 점검

- 메뉴 미노출 → `index.html:599` 의 `data-admin-only` 잔존 여부 (제거되어야 함). 비로그인 상태인지도 확인
- 화면 빈 채로 진입 → `dashboard.js:105` case 'wms-orders' 분기 / `pmcOrderImport.init` / `pmcOrderList.init` 함수 등록 확인
- 버튼 부재 → orderImport.js patch (PR 3 patch) 가 deploy 됐는지 commit 확인

**§5 통과 여부**: ☐ 통과 / ☐ 실패

---

## 6. 시나리오 B — Unique 예시 주문 import

### 절차

1. **`예시 JSON 채우기 (Unique)`** 클릭
2. textarea 의 `external_order_id` 값이 `EBAY-TEST-{YYYYMMDD-HHmmss}` 형식인지 확인
   - 예: `EBAY-TEST-20260509-150000`
3. 이 값을 §2-C 의 메모란에 기록
4. (선택) DevTools 의 Network 탭 열기
5. **`Import 실행`** 클릭
6. 응답 JSON 캡처 (Network 탭 또는 화면 결과 영역)
7. 응답의 `order_id` 메모

### 기대

- [ ] HTTP 응답 **201 Created**
- [ ] 응답 JSON 의 `success: true`
- [ ] 응답의 `marketplace = "ebay"`, `external_order_id = <메모 값>`
- [ ] 응답 `totals`:
  - [ ] `line_count = 2`
  - [ ] `matched_count = 1`
  - [ ] `failed_count = 1`
  - [ ] `cards_created = 1`
  - [ ] `overflow_card_created = false`
  - [ ] `capped_line_count = 0`
- [ ] 화면 결과 영역에 **`✓ Import 성공 — order #N`** 표시
- [ ] **자동 예외 콘솔 링크** (`→ ⚠️ 자동 예외 콘솔 열기`) 표시
- [ ] 좌측 주문 목록 자동 refresh — 신규 주문 row 등장
- [ ] 신규 주문이 자동 선택됨 (좌측 카드에 파란 테두리 + 우측 상세 패널 채워짐)

### 실패 시 점검

| 증상 | 확인 |
|---|---|
| 401 | 로그인 안 됨 (세션 쿠키 없음 / 만료) — 재로그인 후 재시도. `requireAuth` 미들웨어가 적용됐는지 |
| 403 | 정책 §1-A 적용 후에는 발생하면 안 됨 — `routes/orders.js` / `routes/mockOrderImport.js` 가 `requireAdmin` 으로 잔존하는지 |
| 400 validation | textarea JSON 손상 / `marketplace` enum 부적합 / lines 비어있음 |
| 500 | server log 의 `[mockOrderImport] unexpected error` |
| matched_count = 0 (예상 1) | 사전 조건 §4-5 의 sku_listing_link 가 실제로 등록됐는지 |
| cards_created = 0 (예상 1) | createExceptionTask helper 동작 / `createdBy` 전달 |

**§6 통과 여부**: ☐ 통과 / ☐ 실패

---

## 7. 시나리오 C — 주문 상세 / line 매칭 확인

### 절차

1. 시나리오 B 에서 자동 선택된 주문의 우측 상세 패널 확인 (또는 좌측 카드 다시 클릭)
2. lines table 2 행 확인

### 기대 (UI)

- [ ] **TXN-A**:
  - match badge = **`matched_link`** (녹색 #69f0ae)
  - match_confidence = **`high`**
  - match_reason = **`link_exact`**
  - matched_sku_id = §4-4 의 SKU id (예: `#7`)
- [ ] **TXN-B**:
  - match badge = **`FAILED`** (빨간 #ef9a9a)
  - match_confidence = `(없음)` 또는 표시 없음
  - match_reason = **`no_match`**
  - matched_sku_id = `-`
- [ ] 상단 stats 4 박스:
  - 총 line = `2`
  - matched = `1`
  - failed = `1`
  - pending = `0`
- [ ] 하단에 빨간 배너 표시: **"⚠️ 매칭 실패 line 1건. 자동 예외 카드가 생성됐는지 ⚠️ 자동 예외 콘솔 에서 확인하세요."**
- [ ] 배너의 `⚠️ 자동 예외 콘솔` 링크가 클릭 가능 (`/?page=exception-tasks`)

### DB 검증 SQL

```sql
select id, external_line_id, marketplace_sku, listing_id, option_id,
       match_status, match_confidence, match_reason, matched_sku_id
from wms_order_lines
where order_id = <시나리오 B 의 wms_orders.id>
order by id;
```

**기대 — 2 행**:
| external_line_id | match_status | match_confidence | match_reason | matched_sku_id |
|---|---|---|---|---|
| TXN-A | `matched_link` | `high` | `link_exact` | (SKU id) |
| TXN-B | `failed` | NULL | `no_match` | NULL |

### 실패 시 점검

- TXN-A 가 matched_link 가 아님 → sku_listing_link 의 (marketplace, listing_id, option_id) 가 정확히 (`ebay`, `123456789012`, `null`) 인지
- TXN-A 가 matched_marketplace_sku 로만 잡힘 → option_id NULL 비교 (IS NOT DISTINCT FROM) 동작 점검 → skuMatcher.js:matchByLink 의 `.is('option_id', null)` 분기
- TXN-B 가 matched_internal_sku 로 잡힘 → sku_master.internal_sku 에 `UNKNOWN-WRONG-SKU` 가 잘못 등록됐는지

**§7 통과 여부**: ☐ 통과 / ☐ 실패

---

## 8. 시나리오 D — 자동 예외 카드 확인

### 절차

1. 시나리오 C 의 빨간 배너에서 `⚠️ 자동 예외 콘솔` 링크 클릭 (또는 사이드바 `⚠️ 자동 예외` 직접 진입)
2. 좌측 카드 목록에서 시나리오 B 시점 이후 생성된 SKU_MATCH_FAILED 카드 확인
3. 카드 클릭 → 우측 상세 패널 확인

### DB 검증 SQL

```sql
select id, exception_type, severity, dedupe_key, related_order_id,
       assignee_scope, created_by, auto_generated, context
from team_tasks
where related_order_id = <시나리오 B 의 wms_orders.id>
  and auto_generated = true;
```

### 기대 — 정확히 1 행

| 필드 | 값 |
|---|---|
| `auto_generated` | `true` |
| `exception_type` | `SKU_MATCH_FAILED` |
| `severity` | `medium` (또는 high) |
| `assignee_scope` | `operators` |
| `related_order_id` | 시나리오 B 의 `wms_orders.id` |
| `dedupe_key` | `sku_match_failed:ebay:<시나리오 B external_order_id>:TXN-B` |
| `created_by` | mock 실행한 사용자 id (admin / staff 모두 가능, NOT NULL) — 정책 §1-A |
| `context` | JSON, 아래 필드 포함 |

### context 필수 포함 필드

- [ ] `marketplace = "ebay"`
- [ ] `external_order_id = <시나리오 B 값>`
- [ ] `external_line_id = "TXN-B"`
- [ ] `marketplace_sku = "UNKNOWN-WRONG-SKU"` (또는 마스킹)
- [ ] `listing_id = "999999999999"`
- [ ] `quantity = 2`
- [ ] `match_reason = "no_match"`

### context 절대 미포함

- [ ] `buyer_email` 원본 `"buyer@example.com"` 부재 (또는 마스킹된 형태)
- [ ] `buyer_phone` 원본 `"010-1234-5678"` 부재
- [ ] `ebay_internal_token` 원본 `"sk_should_be_redacted"` 부재
- [ ] 그 외 token / api_key / secret 류 일체 0건

### 추가 — TXN-A 카드 미생성 확인

```sql
select count(*) as failed_card_count
from team_tasks
where related_order_id = <시나리오 B 의 wms_orders.id>
  and auto_generated = true
  and exception_type = 'SKU_MATCH_FAILED';
```

**기대**: **정확히 `1`** (TXN-B 만).
- `2` 이상 = TXN-A 도 잘못 카드 생성됨 → skuMatcher 또는 orderImporter 흐름 점검 필요.
- `0` = createExceptionTask 호출 실패 → exceptionTask.js / req.user.id 전달 / FAILED_CARD_CAP 점검.

### UI 검증

- [ ] 좌측 카드에 `AUTO` + `SKU_MATCH_FAILED` + `medium` 배지
- [ ] 우측 상세에 위 context JSON pretty print
- [ ] dedupe_key 표시
- [ ] `related_order_id = <시나리오 B 의 wms_orders.id>` 확인 가능

**§8 통과 여부**: ☐ 통과 / ☐ 실패

---

## 9. 시나리오 E — 중복 주문 방지 (DUPLICATE_ORDER 409)

### 사전 정리 (선택)

DB 에 `EBAY-2026-001` 주문이 이미 있는지 확인:

```sql
select id from wms_orders
where marketplace = 'ebay' and external_order_id = 'EBAY-2026-001';
```

**있으면** 시나리오 E 시작 전 cleanup (cascade 순서 주의):

```sql
-- 1) 자동 카드 먼저 (FK 의존)
delete from team_tasks
where dedupe_key like 'sku_match_failed:ebay:EBAY-2026-001:%'
   or dedupe_key = 'sku_match_failed_overflow:ebay:EBAY-2026-001';

-- 2) order_lines (orders FK ON DELETE CASCADE 라 자동이지만 명시)
delete from wms_order_lines
where order_id = <위 id>;

-- 3) wms_orders 본체
delete from wms_orders
where id = <위 id>;
```

**없으면** cleanup 불필요.

### 절차

1. WMS 주문 화면 → **`예시 JSON 채우기`** (fixed) 클릭
2. textarea 의 `external_order_id = "EBAY-2026-001"` 확인
3. **1차 Import 실행**
   - 기대: HTTP 201 + `matched_count=1`, `failed_count=1`, `cards_created=1`
4. (textarea 변경 없이) **2차 Import 실행** 같은 JSON 그대로
5. 응답 / 화면 메시지 확인

### 기대

- [ ] 1차: HTTP **201** + 신규 wms_orders 1행 + 자동 카드 1행
- [ ] 2차: HTTP **409**
- [ ] 2차 응답 body: `{"code":"DUPLICATE_ORDER", "existing_order_id": <1차 wms_orders.id>}`
- [ ] 화면 결과 영역에 `⚠️ 이미 import 된 주문입니다 (ebay / EBAY-2026-001) [기존 주문 #N 열기]` 표시
- [ ] `[기존 주문 #N 열기]` 버튼 클릭 → 우측 상세에 1차 주문 표시
- [ ] **화면 깨짐 없음** (modal 또는 inline 결과 영역 정상 동작)

### DB 검증 SQL

```sql
-- (a) wms_orders 에 같은 external_order_id 가 1행만 (UNIQUE 제약 동작)
select count(*) as order_count
from wms_orders
where marketplace = 'ebay' and external_order_id = 'EBAY-2026-001';
-- 기대: 1
```

```sql
-- (b) 자동 카드도 1행만 (dedupe_key partial unique 동작)
select count(*) as auto_card_count
from team_tasks
where dedupe_key = 'sku_match_failed:ebay:EBAY-2026-001:TXN-B'
  and auto_generated = true;
-- 기대: 1
```

### 실패 시 점검

| 증상 | 확인 |
|---|---|
| 2차도 201 (중복 차단 안 됨) | wms_orders 의 UNIQUE (marketplace, external_order_id) 제약 / wmsOrderRepository.createWmsOrder 의 23505 catch |
| 2차 500 | DuplicateOrderError 처리 분기 (mockOrderImport.js) |
| 자동 카드 2 행 (중복 생성) | partial unique index `team_tasks_dedupe_key_active` / exceptionTask 의 race catch |

**§9 통과 여부**: ☐ 통과 / ☐ 실패

---

## 10. 시나리오 F — PII / secret 마스킹

### 입력값 (시나리오 B 또는 E 의 mock JSON 그대로)

- `raw_payload.ebay_internal_token = "sk_should_be_redacted"`
- `buyer_contact.email = "buyer@example.com"`
- `buyer_contact.phone = "010-1234-5678"`

### DB 검증 SQL — wms_orders 저장값

```sql
select
  raw_payload->>'ebay_internal_token' as token_in_root,
  buyer_contact->>'email'              as email_stored,
  buyer_contact->>'phone'              as phone_stored,
  raw_payload                           as raw_full,
  buyer_contact                         as contact_full
from wms_orders
where external_order_id = '<시나리오 B 또는 E 의 external_order_id>'
  and marketplace = 'ebay';
```

### 기대 (저장값 ≠ 원본)

- [ ] `email_stored != 'buyer@example.com'`
  - 마스킹 형태 (예: `b***@example.com`) 또는 키 자체 부재
- [ ] `phone_stored != '010-1234-5678'`
  - `[PHONE]` 또는 마스킹 형태 또는 키 자체 부재
- [ ] `token_in_root` (위 SQL 결과의 첫 컬럼)
  - 원본 `sk_should_be_redacted` 와 다름
  - `[REDACTED]` 또는 키 자체 부재 (raw_payload 가 line 단위라 root 에는 없을 수도 있음 — 그 경우도 통과)

### 추가 SQL — raw_payload 전체 텍스트에 token 누설 0건

```sql
select count(*) as leaked_token_count
from wms_orders
where external_order_id = '<시나리오 B 또는 E 의 external_order_id>'
  and raw_payload::text like '%sk_should_be_redacted%';
```

**기대**: **`0`**.

### 추가 SQL — 자동 카드 context 도 검증

```sql
select context::text as context_text
from team_tasks
where related_order_id = <시나리오 B 또는 E 의 wms_orders.id>
  and auto_generated = true;
```

**기대 — context_text 안에**:
- [ ] `'sk_should_be_redacted'` 0건
- [ ] `'buyer@example.com'` 0건
- [ ] `'010-1234-5678'` 0건

위 3 패턴 중 어느 하나라도 발견되면 → secret/PII 누설. redact 적용 흐름 (orderImporter / exceptionTask) 즉시 점검.

### UI 검증

상세 패널 하단 `▸ raw_payload / buyer_contact (redact 통과 후 저장값)` 펼침:
- buyer_contact.email = `b***@example.com` 또는 마스킹 형태
- buyer_contact.phone = `[PHONE]`
- raw_payload 안의 token = `[REDACTED]` (또는 키 부재)

**§10 통과 여부**: ☐ 통과 / ☐ 실패

---

## 11. 시나리오 G — staff 접근 회귀 (정책 변경 — 차단 → 추적)

> **§1-A 정책에 따라 본 시나리오는 "staff 차단 검증" 에서 "staff 정상 사용 + 실행자 기록 검증" 으로 변경됨.**

### 절차

1. **로그아웃** (admin 세션 종료)
2. **staff 계정** 로그인 (`role='staff'`, `is_active=true`)
3. 사이드바 확인 — `📦 WMS 주문` 메뉴가 **보여야 함**
4. `📦 WMS 주문` 클릭 → import 패널 + 목록/상세 패널 정상 빌드
5. 상단 import 패널: `예시 JSON 채우기 (Unique)` → `Import 실행` 클릭
6. (DevTools Console) API 직접 호출:

```javascript
// (1) 목록 GET
fetch('/api/orders', { credentials: 'include' })
  .then(r => r.status).then(console.log);

// (2) 상세 GET (위에서 import 한 order_id 로 교체)
fetch('/api/orders/<NEW_ORDER_ID>', { credentials: 'include' })
  .then(r => r.status).then(console.log);

// (3) mock import POST (스킵 — 위 5번에서 이미 실행)
```

7. (Supabase Studio) 실행자 기록 확인:

```sql
select id, marketplace, external_order_id, imported_by, import_source, created_at
from wms_orders
order by id desc
limit 1;
```

### 기대

- [ ] 사이드바에 `📦 WMS 주문` 메뉴 **노출** (`data-admin-only` 부재)
- [ ] `/?page=wms-orders` 진입 시 화면 정상 빌드 (`로그인이 필요합니다` 메시지 없음)
- [ ] import 5번 — `✓ Import 성공 — order #N` 정상 표시 (admin 과 동일)
- [ ] (1) GET /api/orders → **200**
- [ ] (2) GET /api/orders/:id → **200**
- [ ] (3) POST /api/orders/mock-import → **201** (위 5번에서 이미 검증)
- [ ] `wms_orders.imported_by` = 로그인한 staff 의 user id (admin 의 id 가 아님!) — 실행자 기록 작동
- [ ] `wms_orders.import_source` = `'mock'`

### 실패 시 점검

| 증상 | 확인 |
|---|---|
| 메뉴 안 보임 | `index.html:599` 에서 `data-admin-only` 가 잔존하는지 (제거되어야 함) |
| `로그인이 필요합니다` 메시지 | `orderImport.init` / `orderList.init` 의 user 가드가 여전히 `isAdmin` 체크하는지 |
| API 403 | `mockOrderImport.js` / `orders.js` 의 `router.use()` 가 `requireAdmin` 인지 (`requireAuth` 여야 함) |
| `imported_by` = null | `mockOrderImport.js` 의 `req.user?.id` 추출 실패 — 세션 / authGuard 점검 |
| `imported_by` = 0 (legacy) | staff 가 본인 계정 으로 로그인했는지 — userId=0 은 legacy 공유 비번. blockLegacyWrites 와 정책 정합성 검토 |

**§11 통과 여부**: ☐ 통과 / ☐ 실패

### 본 시나리오에서 다루지 않는 것

- staff 의 자동 예외 카드 (`⚠️ 자동 예외`) 노출 여부 — Phase 1 의 `auto_generated=false` 필터 + `assignee_scope='operators'` 라우팅이 staff UI 에서 어떻게 동작해야 하는지는 후속 Safety Foundation PR 에서 별도 결정.
- 변경 전/후 값 기록 / 되돌리기 / 취소 프로세스 — 후속 Safety Foundation PR.

---

## 12. 시나리오 H — 기존 운영 흐름 보호

### 12-1. Phase 2 신규 코드의 public.orders 참조 0건

local terminal:

```bash
cd /Users/parksungmin/pmc-work-mvp
git grep -nE "from public\.orders|FROM public\.orders|JOIN public\.orders" \
  src/web/routes/orders.js src/web/routes/mockOrderImport.js \
  src/services/skuMatcher.js src/services/orderImporter.js \
  src/db/wmsOrderRepository.js \
  public/js/orderImport.js public/js/orderList.js
```

**기대**: **출력 0 줄**.

추가 — `from('orders')` 패턴 (Supabase REST 호출 형태) 도 확인:

```bash
git grep -nE "from\(['\"]orders['\"]\)" \
  src/web/routes/orders.js src/web/routes/mockOrderImport.js \
  src/services/skuMatcher.js src/services/orderImporter.js \
  src/db/wmsOrderRepository.js \
  public/js/orderImport.js public/js/orderList.js
```

**기대**: **출력 0 줄**.

### 12-2. eBay sync 영향 없음 (운영 관찰)

- [ ] 기존 발주관리 / 배송관리 화면에서 eBay 주문 sync 가 정상 동작
- [ ] Railway log 에 `[orderSync]` 류 에러 없음
- [ ] 정기 sync cron (있다면) 정상 실행

### 12-3. wms_orders 와 public.orders 분리 확인

```sql
select
  (select count(*) from wms_orders) as wms_count,
  (select count(*) from orders)     as legacy_count;
```

**시나리오 B 와 E 진행 후 다시 실행해서 비교**:

| 시점 | wms_count | legacy_count |
|---|---|---|
| 시나리오 B 직전 | __________ | __________ |
| 시나리오 B 직후 | **__________** (+1) | **그대로** (변화 0) |
| 시나리오 E 직후 | **__________** (+1 더) | **그대로** (변화 0) |

**기대**:
- `wms_count` 만 시나리오 B / E 에서 +1 씩 증가
- `legacy_count` 는 Phase 2 import 와 무관 — 변화 없음 (또는 별도 eBay sync 로 인한 자연 증가만)

### 12-4. git diff 재확인

```bash
cd /Users/parksungmin/pmc-work-mvp
git diff src/web/routes/api.js
git diff public/js/dashboard.js
git diff supabase/migrations/037_orders_fedex_label.sql
git diff supabase/migrations/038_phase1_sku_master_and_exception.sql
git diff supabase/migrations/039_phase2_orders.sql
git diff package.json automation/package.json
git diff automation/src/db/schema.ts
test ! -f supabase/migrations/040_phase2_wms_order_matching_fields.sql && echo "040 migration not created"
```

**기대**:
- 모든 `git diff` 출력 **0 줄**
- `040 migration not created` 출력

**§12 통과 여부**: ☐ 통과 / ☐ 실패

---

## 13. 실패 시 기록 템플릿

검증 중 발견된 모든 이슈를 아래 표에 기록.

| 항목 | 내용 |
|---|---|
| 발견 시각 | YYYY-MM-DD HH:mm KST |
| 시나리오 | A / B / C / D / E / F / G / H |
| 증상 | UI 에러 메시지 / API 응답 / DB 상태 (한 줄) |
| 재현 단계 | 1. ... 2. ... 3. ... |
| 예상 원인 | UI / backend / DB / migration / 기타 |
| 의심 파일 | 파일경로:라인 |
| 심각도 | low / medium / high / **blocker** |
| 분류 | UI 버그 / backend 버그 / DB 버그 / 회귀 |
| 수정 여부 | 미수정 / 수정 중 / 완료 |
| 재검증 결과 | 미실시 / 통과 / 실패 |

**심각도 기준**:
- **low**: UI 디테일 / 메시지 오타 / 운영 영향 없음
- **medium**: 기능 일부 미동작, 우회 가능
- **high**: 핵심 시나리오 차단, 재시도로 극복 불가
- **blocker**: Phase 3 진입 차단 (PII 누설, public.orders 회귀, 자동 카드 폭주 등)

---

## 14. Phase 2 통과 기준 (채점표)

| # | 항목 | 통과 기준 | 결과 |
|---|---|---|---|
| 1 | WMS 주문 메뉴 표시 (admin / staff 둘 다) | 시나리오 A 통과 | ☐ |
| 2 | Unique import 성공 | 시나리오 B HTTP 201 + totals 일치 | ☐ |
| 3 | matched / failed 라인 매칭 정확 | 시나리오 C TXN-A=matched_link/high, TXN-B=failed/no_match | ☐ |
| 4 | 자동 카드 1개 생성 + dedupe_key 정확 | 시나리오 D 카드 1개 (TXN-B 만), TXN-A 카드 0 | ☐ |
| 5 | 중복 import 409 + DB 중복 0 | 시나리오 E (1차 201, 2차 409, DB count = 1) | ☐ |
| 6 | PII / token 마스킹 | 시나리오 F SQL leaked_token_count = 0, 카드 context 누설 0 | ☐ |
| 7 | staff 메뉴 노출 + API 200/201 + imported_by = staff id | 시나리오 G (메뉴 O, GET 200, POST 201, imported_by 정합) | ☐ |
| 8 | 기존 public.orders 영향 0 | 시나리오 H (참조 0건, legacy_count 변화 0) | ☐ |
| 9 | git log 에 PR 3 + patch 커밋 push 됨 | §3 통과 (commit 메시지 확인 + Railway active 일치) | ☐ |
| 10 | 037/038/039 무변경 + **040 미생성** + api.js 무변경 + automation schema 무변경 | §3 / §12 git diff 통과 + 040 부재 | ☐ |

### 채점 분기

| 점수 | 다음 액션 |
|---|---|
| **10/10** | Phase 2 완료 선언 → Phase 3 진입 (§17 후보 중 결정) |
| 9/10 | 미통과 항목 분류 (UI / backend / DB / 회귀) → §15 분기 적용 |
| 8 이하 | **Phase 3 보류**. 미통과 항목 일괄 정리 PR 후 재검증 |

---

## 15. 통과 후 다음 행동

### A. 모두 통과 (10/10)

- Phase 2 완료 선언 (commit/문서/메모리 갱신)
- Phase 3 계획 시작 (§17 후보 중 결정)
- 본 문서의 통과 결과 캡처 보관 (§16)

### B. 경미한 UI 버그 (low / medium)

- PR 3 patch 또는 신규 UI patch 로 수정
- 영향받은 시나리오만 재검증
- 통과 후 Phase 3 진입

### C. backend / DB 버그 (high / blocker)

- **Phase 3 진입 금지**
- 분류:
  - backend (SKU matcher / orderImporter / repository) → PR 2 보정 PR
  - DB schema → 신규 보정 migration (041~)
- 보정 PR 후 본 가이드 처음부터 재검증

### D. 회귀 (public.orders / eBay sync 영향)

- **즉시 작업 중단**
- git revert 또는 hotfix 검토
- 회귀 원인 파일 확정 후 patch
- §12 시나리오 H 재검증 통과 후만 재진입

---

## 16. 캡처 / 증거 보관 (수동 — 본 PR 4 에서는 폴더 미생성)

각 시나리오 통과 후 다음 캡처 권장:
- 브라우저 화면 (UI 결과)
- 응답 JSON (DevTools Network 탭 응답 body)
- DB 검증 SQL 결과 (Supabase SQL Editor 캡처)

### 권장 보관 위치

```
docs/phase-2-e2e-evidence/
├── scenario-a-menu.png
├── scenario-b-import-201.png
├── scenario-b-import-response.json
├── scenario-c-detail.png
├── scenario-d-card.png
├── scenario-d-card.sql.txt
├── scenario-e-409.png
├── scenario-f-pii.sql.txt
├── scenario-g-staff-access.png    # staff 가 메뉴 접근 + import 성공 + imported_by 정합
└── scenario-h-legacy-isolation.sql.txt
```

**본 PR 4 에서는 evidence 폴더 / 이미지 / 더미 파일을 일체 만들지 않는다**. 검증자가 수동으로 보관할 위치만 안내. Phase 2 완료 보고 시 일부 캡처를 git 에 commit 할지는 별도 결정.

---

## 17. 다음 Phase 후보 (Phase 3 결정용 메모)

본 검증 통과 후 Phase 3 의 우선 후보:

| 후보 | 설명 | 의존성 |
|---|---|---|
| **Safety Foundation (정책 §1-A 후속)** | 모든 자동화/액션 라우트의 표준화: `executed_by` + 변경 전/후 값 + 성공/실패 status + 되돌리기/취소 + 감사 로그. 가격변경/배송접수/라벨생성 등 staff 가 쓸 액션의 전제 조건 | `automation_runs` 표준화 + 신규 `action_audit` 또는 동등 컬럼군 |
| CSV import | 마켓별 export 형식 mapping (eBay / Shopee / Naver 등) | PR 2 의 orderImporter 확장 |
| 도매처 가격 / 품절 감시 | 외부 sourcing site 의 SKU 가격·재고 모니터링 → 자동 카드 | 신규 service + cron |
| 마진 계산 | wms_orders.total_amount + sku_master 원가 / 배송비로 마진 추출 | sku_master 에 cost 컬럼 추가 검토 |
| SKU 매칭 보정 UI | failed line 을 사용자 (admin / staff) 가 수동으로 sku_master 와 link → 자동 카드 close + executed_by 기록 | 신규 UI + skuMatcher 의 manual link 분기 |
| 자동 예외 처리 완료 플로우 | operators 가 카드 close 시 dedupe_key cool-down 처리 | Phase 1 의 team_tasks 흐름 확장 |
| sub-app 자동화에서 wms_orders 활용 | PR 1-B Drizzle sync 가 완료된 sub-app worker 가 wms 데이터 직접 read | automation/src/db/schema.ts (이미 sync 완료) 활용 |

### 결정 기준 (사장님)

- 운영 부하가 가장 큰 영역 (수동 매칭 시간 ↑) → SKU 매칭 보정 UI 우선
- 사장님이 가장 자주 보는 화면 → 마진 계산 우선
- 외부 의존이 적고 빠른 가치 → CSV import 우선
- 자동화 sub-app 의 활용 즉시 시작 원하면 → sub-app 측 worker 작업 우선

Phase 2 검증 완료 후 별도 plan 문서 (`docs/phase-3-...-plan.md`) 작성 권장.

---

## 본 문서 메타

- 작성: 2026-05-09
- 모드: 수동 손검증 가이드
- 변경 파일: `docs/phase-2-e2e-verification.md` 1 개
- 코드 / DB / migration / package / config 변경 일체 없음
- evidence 폴더 / 이미지 / 더미 파일 미생성 (사장님 수동 보관)

검증 시작 전 **§3 git 안전 + §4 DB 사전 확인 SQL** 부터 순서대로 진행. 막히면 시나리오 번호 + 증상 알려주세요.
