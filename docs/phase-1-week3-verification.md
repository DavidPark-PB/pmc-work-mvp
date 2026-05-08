# Phase 1 Week 3 Verification Guide

> 작성일: 2026-05-08 · 모드: 수동 검증 체크리스트
> 입력 상태: Phase 1 PR 1~5 코드 작성 완료, **commit 전 / 운영 DB 검증 전**.
> 본 문서는 분석 문서가 아니라 **사장님이 직접 손으로 따라가는 체크리스트**.

---

## 1. 검증 목적

- Phase 1 PR 1~5 가 **운영 DB / 운영 환경에서** 의도대로 동작하는지 확인
- 운영 DB 적용 전 (또는 staging) → 적용 후 동작 검증
- Phase 2 진입 가능 여부 판단 (= 시나리오 통과 + 안전 장치 통과)
- commit 전 발견 버그 기록 + 수정 + 재검증
- 재배정 시나리오 후속 PR 시기 결정

---

## 2. 사전 조건

| 항목 | 내용 |
|---|---|
| **현재 브랜치** | 어디서 일하는지 확인 — `git branch --show-current` |
| **git working tree** | M 7건 + ?? 11+ 건 (plan 파일 §"현재 git 상태" 와 일치) |
| **038 migration 적용** | Supabase Studio SQL Editor 에서는 `\dt` 같은 psql 메타 명령이 동작 안 함. §3-B 의 information_schema 쿼리 (사전 확인 3번) 로 `sku_master` / `sku_listing_link` / `jobs` / `automation_runs` 4개 row 가 나오는지 확인 |
| **admin 계정** | `users WHERE role='admin' AND is_active=true` ≥ 1 |
| **staff 계정** | `users WHERE role='staff' AND is_active=true` ≥ 1 (시나리오 C 검증) |
| **브라우저 2개** | Chrome 정상 + Chrome 시크릿 (admin 동시 SSE 검증 또는 admin/staff 동시 로그인) |
| **실행 환경** | local `npm start` 또는 Railway production. **production DB 에 mock trigger 호출 시 실제 row 생성됨** — staging 권장 |

---

## 3. 사전 확인 명령어

### 3-A. git 안전 장치 확인

```bash
cd /Users/parksungmin/pmc-work-mvp

# 1) 변경 파일 목록
git status --short
git diff --name-only

# 2) 037 무변경 — 빈 출력이어야 통과
git diff supabase/migrations/037_orders_fedex_label.sql

# 3) api.js 무변경 — 빈 출력
git diff src/web/routes/api.js

# 4) package.json 무변경 — 빈 출력
git diff package.json automation/package.json

# 5) tasks legacy 마이그레이션 무변경
git diff supabase/migrations/008_executive_team.sql
```

**기대**: 2)~5) 모두 빈 출력. 1) 은 plan §"현재 git 상태" 와 일치.

### 3-B. DB 사전 상태 (psql 또는 Supabase Studio SQL Editor)

```sql
-- 1) team_tasks 기존 행 보호 확인 — auto_generated 가 모두 false 여야 함
select count(*) as total, count(*) filter (where auto_generated = true) as auto_count
from team_tasks;
-- 기대: total = 38 (또는 운영 DB 기존값), auto_count = 0

-- 2) 신규 7컬럼 존재 확인
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name = 'team_tasks'
  and column_name in ('auto_generated','exception_type','context','dedupe_key','severity','related_sku_id','related_order_id')
order by column_name;
-- 기대: 7개 row. auto_generated=boolean default false NOT NULL, severity=character varying default 'medium', 나머지 nullable

-- 3) sku_master / sku_listing_link / jobs / automation_runs 존재 확인
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('sku_master','sku_listing_link','jobs','automation_runs')
order by table_name;
-- 기대: 4 row

-- 4) Partial unique index 존재 확인
select indexname, indexdef
from pg_indexes
where tablename = 'team_tasks'
  and indexname = 'team_tasks_dedupe_key_active';
-- 기대: 1 row, indexdef 에 "WHERE ((status <> 'done'::text) AND (dedupe_key IS NOT NULL))" 포함

-- 5) sku_master 비어있음 확인 (Phase 1 시작 시점 baseline)
select count(*) as sku_count from sku_master;
-- 기대: 0

-- 6) admin 사용자 존재 확인
-- ⚠️ users 실제 컬럼 (Supabase 확인 결과):
--   id, username, password_hash, display_name, role, is_active, created_at,
--   last_login_at, platform, work_type, work_schedule, hourly_rate, shopee_bonus_rate,
--   default_due_time, ui_mode, notes, can_manage_finance
-- ⚠️ users.name 컬럼은 존재하지 않는다 (display_name 만 있음). 다른 쿼리/스크립트 작성 시 주의.
select id, username, display_name, role, is_active from users where role = 'admin' and is_active = true;
-- 기대: ≥ 1 row
```

**모든 결과가 기대와 일치해야 검증 진행 가능.** 어긋나면 plan §"무수정 확인" 와 PR 1 보고서를 다시 보고 원인 파악.

---

## 4. 시나리오별 검증 절차

각 시나리오는 **순서대로** 진행. 앞 시나리오의 결과가 다음 시나리오의 사전 상태가 됨.

---

### ✅ 시나리오 A — Mock SKU 매칭 실패 → 자동 카드 → 운영자 SSE

**목적**: 자동 예외 카드 생성 흐름 + 운영자에게만 알림 발송 검증.

**사전 상태**:
- DB 사전 확인 통과
- admin 계정으로 브라우저 1 로그인
- 동일 admin 또는 다른 admin 계정으로 브라우저 2 로그인 (SSE 동시 수신 검증)
- 양쪽 다 사이드바 `⚠️ 자동 예외` 클릭하여 페이지 진입 (SSE 연결 활성화)

**실행 단계**:
1. 브라우저 1 우상단 `🧪 Mock trigger` 클릭 → 모달
2. 입력:
   - exception_type: `SKU_MATCH_FAILED`
   - severity: `high`
   - dedupe_key: `sku_match_failed:ebay:ORD-TEST-001:line1`
   - memo: `포켓몬 부스터 박스 매칭 실패`
   - context (JSON):
     ```json
     {
       "marketplace": "ebay",
       "external_order_id": "ORD-TEST-001",
       "line_text": "Charizard Booster Box",
       "buyer_email": "test@example.com",
       "phone": "010-1234-5678",
       "api_token": "sk_should_be_redacted",
       "service_role_key": "leak_test"
     }
     ```
3. 생성 클릭

**기대 결과**:
- [ ] 브라우저 1 모달 닫힘, 좌측 카드 목록에 `SKU_MATCH_FAILED · high` 카드 1건 등장 (자동 선택 → 우측 상세 표시)
- [ ] 브라우저 1 의 응답 alert 없음 (deduped=false 이므로)
- [ ] 브라우저 2 의 자동 예외 콘솔 좌측 카드 목록에도 자동으로 동일 카드 등장 (SSE 실시간 반영)
- [ ] DB 검증:
  ```sql
  select id, title, auto_generated, exception_type, severity, dedupe_key, status,
         related_sku_id, related_order_id, created_by
  from team_tasks
  where dedupe_key = 'sku_match_failed:ebay:ORD-TEST-001:line1';
  -- 기대: 1 row, auto_generated=true, exception_type='SKU_MATCH_FAILED', severity='high', status='pending', created_by IS NULL
  ```
- [ ] recipient 행 검증 — **테이블명은 `team_task_recipients`** (팀 업무 + WMS 자동 카드의 수신자 테이블. 별도의 `task_recipients` 테이블은 존재하지 않음):
  ```sql
  -- 정확한 recipient 테이블: team_task_recipients
  -- (team_tasks → team_task_recipients 의 1:N 관계. team_task_attachments 와 같은 prefix)
  select task_id, user_id, status from team_task_recipients
  where task_id = (select id from team_tasks where dedupe_key='sku_match_failed:ebay:ORD-TEST-001:line1');
  -- 기대: 활성 admin 수만큼 row, 모두 status='pending'
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| 모달 자체가 안 뜸 | `/api/exception-routing/mock` 라우트 등록 (server.js:88-89) |
| 401/403 | admin 로그인 + `requireAdmin` 미들웨어 |
| 500 에러 | `src/services/exceptionTask.js` createExceptionTask 흐름 |
| 카드는 생기나 SSE 미수신 | `src/services/sseHub.js` register, `/api/events/stream` 연결, browser console `EventSource` 에러 |
| recipient 0건 | `src/db/teamTaskRepository.js` getActiveAdminIds, `users.role='admin'` 데이터 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 B — 동일 dedupe_key 재실행 → 새 카드 미생성

**목적**: 자동 카드 폭주 방지 (partial unique index 동작 검증).

**사전 상태**:
- 시나리오 A 통과 직후 (동일 dedupe_key 의 활성 카드 1건 존재)

**실행 단계**:
1. 동일한 Mock trigger 모달에 시나리오 A 와 **완전히 동일한 입력**
2. 생성 클릭

**기대 결과**:
- [ ] alert: "동일 dedupe_key 의 활성 카드가 이미 존재 — 신규 생성 안 함 (dedupe 동작 확인)."
- [ ] 좌측 카드 목록의 카드 수 변화 없음 (1건 유지)
- [ ] DB 검증:
  ```sql
  select count(*) from team_tasks
  where dedupe_key = 'sku_match_failed:ebay:ORD-TEST-001:line1' and status != 'done';
  -- 기대: 1
  ```
- [ ] context.last_seen_at 갱신 (또는 아무 변화 없음) 확인:
  ```sql
  select context->>'last_seen_at' as last_seen
  from team_tasks
  where dedupe_key = 'sku_match_failed:ebay:ORD-TEST-001:line1';
  -- 기대: 최근 시각 ISO 문자열 (재실행 시점)
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| 새 카드가 또 생김 | partial unique index `team_tasks_dedupe_key_active`, exceptionTask.js findActiveByDedupeKey |
| alert 대신 500 에러 | exceptionTask.js 의 23505 catch 분기 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 C — 일반 직원 화면에 자동 카드 미노출

**목적**: 직원 화면 보호 (auto_generated=false default filter).

**사전 상태**:
- 시나리오 A 카드 존재
- staff 계정으로 다른 브라우저 (또는 시크릿 창) 로그인

**실행 단계**:
1. staff 계정으로 사이드바 `📋 업무 지시` 클릭
2. 업무 목록 확인
3. (선택) staff 가 사이드바 `⚠️ 자동 예외` 진입 시도

**기대 결과**:
- [ ] staff 일반 업무 목록에 자동 카드 미노출 (= 시나리오 A 의 카드가 안 보임)
- [ ] 사람이 만든 기존 38 행 사람 카드만 표시
- [ ] staff 가 `⚠️ 자동 예외` 진입 시도 시: "관리자 전용 페이지입니다." 표시
- [ ] 모닝 다이제스트 cron (9 AM) 다음 실행 시 staff 에게 자동 카드 알림 안 감 (운영 시 별도 검증 — 즉시 검증 어려우면 통과로 간주하되 다음날 점검):
  ```sql
  -- 다이제스트 알림 발송 후 확인:
  select recipient_id, type, title, body, created_at
  from notifications
  where type = 'daily_digest' and created_at > now() - interval '1 hour'
  order by created_at desc;
  -- 기대: body 에 "오늘 처리해야 할 미완료 업무가 N건" — N 카운트에 자동 카드 미포함
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| staff 화면에 자동 카드 보임 | `src/db/teamTaskRepository.js` listTasks 의 staff path. recipient 가 admin 만이라 자연 차단 — 차단 안 됐다면 잘못된 recipient insert 의심 |
| staff 가 자동 예외 페이지 진입 가능 | `public/js/exceptionFilter.js` 의 isAdmin 체크 |
| 다이제스트에 자동 카드 포함 | `src/services/scheduler.js` morning digest 쿼리의 `.eq('auto_generated', false)` 누락 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 D — context JSONB secret/PII 마스킹

**목적**: 보안 — secret / 이메일 / 전화번호 누설 차단.

**사전 상태**:
- 시나리오 A 카드 존재 (context 에 secret 포함됨)

**실행 단계**:
1. admin 자동 예외 콘솔에서 시나리오 A 의 카드 클릭
2. 우측 상세 패널의 context pretty print 확인

**기대 결과**:
- [ ] `api_token`: `[REDACTED]` (값 누설 안 됨)
- [ ] `service_role_key`: `[REDACTED]`
- [ ] `buyer_email`: `t***@example.com` (도메인은 보존, local part 마스킹)
- [ ] `phone`: `[PHONE]`
- [ ] `marketplace`: `"ebay"` (그대로 — 일반 키)
- [ ] `external_order_id`: `"ORD-TEST-001"` (그대로 — 일반 키)
- [ ] `line_text`: `"Charizard Booster Box"` (그대로)
- [ ] DB 직접 검증:
  ```sql
  select context from team_tasks
  where dedupe_key = 'sku_match_failed:ebay:ORD-TEST-001:line1';
  -- 기대: JSONB 에 api_token='[REDACTED]', buyer_email='t***@...', phone='[PHONE]'
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| api_token 값이 그대로 보임 | `src/lib/redact.js` SECRET_KEY_RE 패턴 |
| email 마스킹 안 됨 | `src/lib/redact.js` EMAIL_RE |
| phone 마스킹 안 됨 | `src/lib/redact.js` KR_MOBILE_RE |
| 일반 키까지 마스킹됨 | SECRET_KEY_RE 너무 광범위 — 검토 필요 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 E — SKU master CRUD

**목적**: 기본 SKU 마스터 모델 동작 + UNIQUE 위반 + soft delete 검증.

**사전 상태**:
- admin 로그인
- 사이드바 `📦 SKU 마스터` 진입

**실행 단계**:
1. **생성**: 폼 입력
   - internal_sku: `PMC-CHARI-001`
   - title: `포켓몬 151 부스터 박스`
   - brand: `Pokémon`
   - product_type: `tcg-box`
   - cost_krw: `35000`
   - weight_gram: `280`
   - hs_code: `9504.40`
   → 생성 클릭

2. **UNIQUE 위반**: 동일 internal_sku=`PMC-CHARI-001` 로 다시 생성 시도

3. **인라인 편집**: 생성된 행에서
   - status select 를 `paused` 로 변경
   - automation 체크박스 토글 (OFF → ON)

4. **검색**: 검색박스에 `chari` 입력 → 디바운스 후 필터링

5. **soft delete**: 🗑 버튼 → confirm

**기대 결과**:
- [ ] 1) 201 응답, 행 등장
- [ ] 2) alert: "동일 internal_sku 가 이미 존재합니다" (409)
- [ ] 3) 변경 즉시 반영, DB 에서 status='paused', automation_enabled=true
- [ ] 4) 검색 결과 1건만 표시
- [ ] 5) confirm → 행은 사라지지 않음 (soft delete) → status=`discontinued` 로 변경 + automation_enabled=false 강제 비활성
- [ ] DB 검증:
  ```sql
  select id, internal_sku, title, status, automation_enabled, cost_krw, weight_gram
  from sku_master
  where internal_sku = 'PMC-CHARI-001';
  -- 기대: 1 row, status='discontinued', automation_enabled=false
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| 라우트 404 | server.js:88-89 의 라우트 등록 |
| 401/403 | requireAdmin 적용 + admin 로그인 |
| UNIQUE 위반 시 500 | `src/web/routes/skuMaster.js` 의 23505 분기 |
| soft delete 시 hard delete 됨 | skuMaster.js DELETE 의 `update({ status: 'discontinued' })` 동작 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 F — 마켓 listing link 생성 + UNIQUE 위반

**목적**: SKU ↔ 마켓 연결 모델 + 중복 차단.

**사전 상태**:
- 시나리오 E 의 SKU `PMC-CHARI-001` 존재 (status 가 active 또는 paused 인 row 사용 — 시나리오 E 의 5)에서 discontinued 됐으므로 신규 SKU 생성 권장)

**실행 단계**:
1. 신규 SKU `PMC-CHARI-002` 생성 (시나리오 E 5단계 후 새로 만든 row 사용)
2. 행의 🔗 버튼 클릭 → 펼침 패널 등장
3. 입력:
   - marketplace: `ebay`
   - listing_id: `123456789012`
   - option_id: (비움)
   - marketplace_sku: `EBAY-CHARI-001`
   - is_primary: 체크
   → "+ 추가" 클릭
4. 동일 입력으로 재추가 시도
5. 다른 marketplace=`shopify`, listing_id=`gid://shopify/Product/9999` 추가
6. ebay link 의 "삭제" 버튼

**기대 결과**:
- [ ] 3) 201 응답, 패널의 link 표에 1건 등장 (⭐ primary)
- [ ] 4) alert: "동일 (marketplace, listing_id, option_id) 가 이미 다른 SKU 에 연결됨" (409)
- [ ] 5) 201 응답, 패널 link 2건
- [ ] 6) 삭제 후 link 1건 (shopify 만)
- [ ] DB 검증:
  ```sql
  select sku_id, marketplace, listing_id, option_id, marketplace_sku, is_primary
  from sku_listing_link
  where sku_id = (select id from sku_master where internal_sku='PMC-CHARI-002');
  -- 기대: 1 row, marketplace='shopify'
  ```

**실패 시 점검 위치**:
| 증상 | 확인 |
|---|---|
| UNIQUE 위반 시 500 | skuMaster.js POST /:id/links 의 23505 분기 |
| 다른 SKU 의 link 가 보임 | skuMaster.js GET /:id 의 sku_id 필터 |

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 G — 기존 `tasks` legacy/agent 테이블 무변경

**목적**: legacy/agent 계열의 `tasks` 테이블 (008 도입, AI 추천/agent 흐름용) 이 본 작업으로 변경 안 됨. **team_tasks (사람 업무 + WMS 자동 카드) 와는 완전히 별개의 테이블**.

**`tasks` 테이블 정체** (Supabase 확인 결과 — 운영 DB 의 실제 컬럼):
| 컬럼 | 타입 | 의미 |
|---|---|---|
| `id` | uuid | PK |
| `title` | text | NOT NULL |
| `description` | text | |
| `assigned_to` | text | (텍스트 — users.id integer FK 가 아님) |
| `created_by` | text | |
| `category` | text | |
| `priority` | text | |
| `status` | text | |
| `due_date` | date | |
| `related_sku` | text | |
| `related_order` | text | |
| `agent_recommendation_id` | uuid | agent_recommendations 연결 |
| `completed_at` | timestamptz | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

→ team_tasks (integer PK, 사람 + WMS 자동 카드) 와 데이터 모델이 다름. PR 1~5 는 team_tasks 만 다루고 본 legacy/agent `tasks` 는 일체 무수정.

**실행 단계**:
1. git 검증:
   ```bash
   git diff supabase/migrations/008_executive_team.sql
   git log --all -- "supabase/migrations/*tasks*"
   ```

2. DB schema 검증 (Supabase Studio SQL Editor 에서 `\d` 메타 명령은 동작 안 함 — information_schema 사용):
   ```sql
   -- legacy/agent 계열 tasks 테이블 컬럼 확인.
   -- 기대 컬럼이 위 표 그대로 존재 + 추가/변경 없음.
   select column_name, data_type, is_nullable, column_default
   from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
   order by ordinal_position;
   -- 기대: 위 15개 컬럼만 나오고, 새 컬럼 (auto_generated, exception_type, dedupe_key 등) 부재.
   --       (그 컬럼들은 team_tasks 에만 있음 — §3-B 사전 확인 2번 참조)
   ```

3. 코드 grep — PR 1~5 가 legacy `tasks` 를 건드리지 않는지 확인:
   ```bash
   # 'team_tasks' 가 아닌 단독 'tasks' 만 매칭 (단어 경계 + 부정 lookbehind 대신 grep -v 사용)
   grep -rnE "(\.from\(.tasks.\)|UPDATE tasks|INSERT INTO tasks|DELETE FROM tasks)" \
     src/ public/js/ 2>/dev/null \
     | grep -v "team_tasks"
   ```

**기대 결과**:
- [ ] 1) `git diff` 빈 출력 (008 무수정).
- [ ] 1) `git log` 결과 008 의 마지막 commit 이 ff2cb00 이전.
- [ ] 2) information_schema 결과 = 위 15개 컬럼만. 신규 컬럼 부재.
- [ ] 3) grep 결과 0건. PR 1~5 변경 파일은 모두 `team_tasks` / `team_task_recipients` / `team_task_attachments` 만 사용.

**실패 시 점검**: PR 1~5 의 어느 파일이 legacy `tasks` 를 건드렸다면 즉시 revert. 본 PR 들의 책임 범위는 `team_tasks` 계열만. legacy/agent `tasks` 는 후속 작업에서도 별도 결정 후 변경.

**통과 여부**: [ ] 통과 / [ ] 실패

---

### ✅ 시나리오 H — 기존 037 migration 무변경

**목적**: `037_orders_fedex_label.sql` 이 본 작업으로 일체 변경 안 됨.

**실행 단계**:
1. git 검증:
   ```bash
   git diff supabase/migrations/037_orders_fedex_label.sql
   git log --oneline -- supabase/migrations/037_orders_fedex_label.sql
   ```

2. 파일 hash 비교 (선택):
   ```bash
   git show HEAD:supabase/migrations/037_orders_fedex_label.sql | shasum -a 256
   shasum -a 256 supabase/migrations/037_orders_fedex_label.sql
   ```

3. 누적 변경 파일 목록에 037 없음 확인:
   ```bash
   git status --short | grep 037
   git diff --name-only HEAD | grep 037
   ```

**기대 결과**:
- [ ] 1) `git diff` 빈 출력 (037 무변경)
- [ ] 1) `git log` 037 의 마지막 커밋이 ff2cb00 ("우체국 소포신청 API 매뉴얼 …") 이전
- [ ] 2) 두 hash 동일
- [ ] 3) grep 결과 0건

**실패 시 점검**: 037 이 변경됐다면 즉시 `git checkout HEAD -- supabase/migrations/037_orders_fedex_label.sql` 로 복원.

**통과 여부**: [ ] 통과 / [ ] 실패

---

## 5. 후속 PR 필요 시나리오

### 자동 카드 운영자 → 직원 재배정 → 직원 SSE (현재 미검증)

**왜 지금 못 하는지**:
- `src/web/routes/tasks.js:164` 의 메타 PATCH 가 `assignee` 재배정을 명시 비활성 (line 164 주석: "assignee 재배정은 지금은 비활성 (recipient 재구성 필요 — 추후)")
- recipient 재구성 로직 미구현 (기존 recipient 행 삭제 + 신규 insert + status 재계산 흐름)

**후속 PR 변경 후보 파일**:
- `src/web/routes/tasks.js` — PATCH 메타 분기에 `assignee_id` / `assignee_scope` 처리 추가
- `src/db/teamTaskRepository.js` — `reassignRecipients(taskId, newScope, newAssigneeId)` 함수 추가 (delete 기존 + insert 신규 + recomputeTaskStatus)
- `public/js/exceptionFilter.js` — 재배정 모달 + 직원 선택 dropdown
- (선택) 새 SSE 이벤트 타입 `task_reassigned`

**Phase 2 전 vs 중 판단 기준**:
| 신호 | 판단 |
|---|---|
| 자동 카드 폭주 위험 / admin 1인이 모든 카드 처리 부담 | Phase 2 전에 처리 |
| 자동 카드 빈도 낮음 / admin 이 직접 처리 가능 | Phase 2 mock 주문 import 와 함께 처리 |
| Shopee 등 신규 마켓 주문 도입 일정 임박 | Phase 2 우선, 재배정은 Phase 2 후 |

---

## 6. 버그 기록 템플릿

검증 중 발견된 모든 이슈를 아래 표에 기록.

| # | 발견 시각 | 시나리오 | 증상 | 재현 단계 | 의심 파일 | 심각도 | 수정 여부 | 재검증 결과 |
|---|---|---|---|---|---|---|---|---|
| 1 | YYYY-MM-DD HH:MM | A~H 또는 사전 | 한 줄 | 짧게 | 파일경로:라인 | LOW/MID/HIGH | [ ] | [ ] |
| 2 |   |   |   |   |   |   |   |   |
| 3 |   |   |   |   |   |   |   |   |

**심각도 기준**:
- LOW: 운영 영향 없음, UI 디테일 또는 메시지 오타
- MID: 기능 일부 미동작, 우회 가능
- HIGH: 핵심 시나리오 차단, commit/배포 차단

---

## 7. Phase 1 통과 기준

아래 모두 통과해야 Phase 1 완료 선언.

### 7-A. 시나리오 통과 (8개 중 필수 6개 이상)
- [ ] 시나리오 A — Mock 자동 카드
- [ ] 시나리오 B — dedupe 동작
- [ ] 시나리오 C — staff 화면 보호
- [ ] 시나리오 D — secret/PII 마스킹
- [ ] 시나리오 E — SKU master CRUD
- [ ] 시나리오 F — listing link UNIQUE
- [ ] 시나리오 G — tasks legacy 무변경
- [ ] 시나리오 H — 037 무변경

### 7-B. 안전 장치 (필수 전부)
- [ ] `git diff supabase/migrations/037_orders_fedex_label.sql` 빈 출력
- [ ] `git diff src/web/routes/api.js` 빈 출력
- [ ] `git diff package.json automation/package.json` 빈 출력
- [ ] team_tasks 기존 38 행 모두 `auto_generated=false`
- [ ] staff 화면에 자동 카드 미노출 (시나리오 C)
- [ ] context 의 secret 키가 `[REDACTED]` 로 마스킹 (시나리오 D)
- [ ] SKU CRUD 4 동작 (생성/조회/수정/soft delete) 통과
- [ ] partial unique index `team_tasks_dedupe_key_active` 동작 (시나리오 B)

### 7-C. 후속 작업 명시
- [ ] 시나리오 3 (재배정) 후속 PR 일정 결정 (Phase 2 전 또는 중)
- [ ] 발견된 HIGH 버그는 모두 fix + 재검증 통과
- [ ] 발견된 MID 버그는 commit 전에 fix 또는 backlog 등재

---

## 8. 검증 후 다음 행동

### 시나리오 A — 버그 없음 / Phase 1 통과 확정

```bash
cd /Users/parksungmin/pmc-work-mvp
git checkout -b phase1-wms-foundation
```

→ §9 의 5 commit 분할 진행 → push → Phase 2 진입.

### 시나리오 B — 경미한 버그 (LOW/MID)

- 같은 working tree 에서 fix
- 영향받은 시나리오만 재검증 (전체 재실행 불필요)
- fix 가 끝나면 §8-A 의 commit 분할 진행

### 시나리오 C — 심각한 버그 (HIGH)

```bash
# 옵션 1: 해당 PR 단위 revert (working tree 정리)
git checkout HEAD -- <파일경로>

# 옵션 2: PR 단위 분리 후 부분 commit
# 예: PR 1·2·5 만 정상이면 PR 3·4 변경 stash 후 PR 1·2·5 commit
git stash push -m "PR3-4 hold" <PR3·4 파일들>
# → §9 의 commit 1·2·5 만 진행
# → 후속에서 PR 3·4 fix 후 별 commit
```

→ HIGH 버그 fix 후 본 가이드 처음부터 재검증.

---

## 9. commit 분할 추천

5 의미 단위 commit. 각 commit 메시지 + 포함 파일.

### Commit 1 — docs (Phase 0 분석)

```
docs: add Phase 0 WMS migration analysis (4 documents)

- wms-migration-analysis.md: 1차 인벤토리 + WMS 매핑
- phase-0-current-system-inventory.md: 현재 시스템 사실 정리
- phase-0-risk-and-tech-debt.md: 리스크 + tech debt
- phase-0-recommended-next-steps.md: Phase 1 PR 1 프롬프트 + 5 PR 계획
```

포함 파일:
- `docs/wms-migration-analysis.md`
- `docs/phase-0-current-system-inventory.md`
- `docs/phase-0-risk-and-tech-debt.md`
- `docs/phase-0-recommended-next-steps.md`
- (사장님 작성한 `docs/phase-0-wms-mapping.md` 가 untracked 라면 함께)

### Commit 2 — db (PR 1: 038 foundation + redact)

```
db: add Phase 1 WMS foundation schema (sku_master, jobs, exception columns)

- 038 migration: sku_master, sku_listing_link, team_tasks 7 columns,
  team_tasks_dedupe_key_active partial unique, jobs schema, automation_runs schema
- src/lib/redact.js: secret/PII masking helper for context JSONB

기존 037 무수정. team_tasks 38 행 비파괴 (auto_generated=false default).
```

포함 파일:
- `supabase/migrations/038_phase1_sku_master_and_exception.sql`
- `src/lib/redact.js`

### Commit 3 — backend (PR 2 + PR 3)

```
backend: exception task helper + SKU master/routing APIs

- src/services/exceptionTask.js: createExceptionTask helper
  (dedupe + redact + operators routing + SSE/notify)
- src/db/teamTaskRepository.js: autoGenerated filter (default false),
  findActiveByDedupeKey, getActiveAdminIds, 'operators' scope
- src/web/routes/tasks.js: GET autoGenerated query passthrough
- src/services/scheduler.js: morning digest + evening summary
  exclude auto cards (auto_generated=false filter)
- src/web/routes/skuMaster.js: SKU master + listing link CRUD (admin only)
- src/web/routes/exceptionRouting.js: routing table GET + admin mock trigger
- server.js: register /api/sku-master, /api/exception-routing
```

포함 파일:
- `src/services/exceptionTask.js`
- `src/db/teamTaskRepository.js`
- `src/web/routes/tasks.js`
- `src/services/scheduler.js`
- `src/web/routes/skuMaster.js`
- `src/web/routes/exceptionRouting.js`
- `server.js`

### Commit 4 — frontend (PR 4: SKU master + 자동 예외 콘솔 UI)

```
frontend: add SKU master and exception console UI

- public/js/skuMaster.js: SKU CRUD UI + inline edit + listing link panel
- public/js/exceptionFilter.js: auto card list + detail + done + Mock trigger
- public/index.html: sidebar 2 menu items + 2 page divs + 2 script tags
- public/js/dashboard.js: 2 case branches for new pages

dashboard.js 본문 무수정 (case 분기 2 줄 + 주석만 추가).
api.js 무수정.
```

포함 파일:
- `public/js/skuMaster.js`
- `public/js/exceptionFilter.js`
- `public/index.html`
- `public/js/dashboard.js`

### Commit 5 — automation (PR 5: sub-app Drizzle sync)

```
automation: sync WMS foundation schema to sub-app Drizzle

- automation/src/db/schema.ts: typed definitions for sku_master,
  sku_listing_link, jobs, automation_runs + 4 relations

메인 SQL 권위. sub-app Drizzle 은 typed access layer.
related_task_id 는 plain integer (team_tasks 가 sub-app schema 밖).
```

포함 파일:
- `automation/src/db/schema.ts`

### Commit 6 (선택) — verification (이 문서)

```
docs: add Phase 1 Week 3 verification guide
```

포함 파일:
- `docs/phase-1-week3-verification.md`

---

## 10. 운영 적용 결정 체크리스트

검증 후 운영 환경에 적용할지 최종 판단.

- [ ] 모든 안전 장치 (§7-B) 통과
- [ ] HIGH 버그 0건
- [ ] commit 5~6 건 정리 완료
- [ ] 사장님 본인이 직접 시나리오 A → B → C → D → E → F 6개 손으로 통과
- [ ] 사장님 본인이 자동 예외 콘솔 UI 가 자연스러움 확인
- [ ] DB 백업 완료 (운영 적용 전 Supabase Studio 에서 backup snapshot)
- [ ] Railway 배포 후 즉시 다음 cron (모닝 다이제스트 9 AM 또는 저녁 5 PM) 의 동작 모니터링 — 자동 카드 미포함 알림 확인

위 모두 체크되면 운영 진입 가능.

---

*본 문서는 검증 가이드입니다. 코드/DB/설정/배포 변경 일체 없음. 변경된 파일: `docs/phase-1-week3-verification.md` 1개.*
