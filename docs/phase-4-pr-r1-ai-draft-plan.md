# Phase 4 PR R1 — AI Draft Generator 계획

> 작성일: 2026-05-11
> 전제: PR R0 (de281bd) 운영 적용 완료. opportunity_inbox 테이블 + 9 인덱스 + 6 FK 운영 DB 존재.
> 본 문서는 **구현 전 합의용 계획서** — 코드 변경 0건.
> 후속 코드 구현은 본 plan 승인 후 별 단계로 진행.

---

## 1. 배경 — R0 → R1 흐름

PR R0 commit 메시지에서 명시:
> This turns sourcing and content intuition into a measurable pipeline for **future AI drafting**, listing automation, price attack workflows, and staff performance.

**R0 까지의 한계**:
- 직원/사장님이 후보 (`opportunity_inbox`) 를 등록해도 그 다음 **사장님이 manual 로 title/description 작성** 해야 함
- 7 platform (ebay/shopify/qoo10 등) 각각의 형식·언어·길이가 달라 manual 작업 부담 큼
- R0 의 `title_ko/en/ja/zh` 컬럼이 비어 있음 (i18n 작성 비용)

**R1 의 목적**:
- `opportunity_inbox.id` 1건 → AI 가 **target_platforms 별 draft (title + description + 부가 메타)** 자동 생성
- staff/admin 이 draft 검토 후 승인 → status = `draft_ready`
- 후속 PR R2 (Listing Publisher) 가 draft → 실 platform 등록

---

## 2. 핵심 결정 사항 (사장님 확인 필요)

### 2-1. AI Provider

| 옵션 | 장점 | 단점 |
|---|---|---|
| **A. Anthropic Claude (claude-sonnet-4-6 권장) ⭐** | 사장님이 이미 Claude Code 사용 중 → API key 확보 용이. 한/영/일/중 다국어 quality 우수. JSON output 안정 | 비용 > GPT-4o-mini |
| B. OpenAI (GPT-4o / GPT-4o-mini) | 저비용 (4o-mini), 빠름 | 다국어 quality A 보다 약간 낮음 |
| C. 둘 다 (provider 선택 가능 — config) | 유연 | 코드 복잡도 ↑, 첫 PR 부담 |

**추천**: **A** (Claude). 첫 PR 단순화 + quality 우선. C 는 후속 PR 검토.

### 2-2. AI 호출 트리거

| 옵션 | 동작 | 비용 |
|---|---|---|
| **A. 수동 트리거 (admin button) ⭐** | UI 의 "AI draft 생성" 버튼 클릭 시 1건씩 | 사장님 통제. 운영 비용 예측 가능 |
| B. 자동 cron (status='new' 모두) | 매일 또는 1시간마다 자동 | 운영 비용 폭발 위험 (스팸 후보 다수 시) |
| C. 등록 직후 자동 (POST /api/opportunity-inbox 시 trigger) | 후보 생성 즉시 draft 생성 | 등록 latency ↑, 비용 통제 어려움 |

**추천**: **A** (수동). 후속 PR 에서 자동 모드 검토.

### 2-3. Draft 저장 위치

| 옵션 | 장점 | 단점 |
|---|---|---|
| **A. 신규 테이블 `opportunity_drafts` ⭐** | 1:N (opportunity_id → draft 다수 — platform/version/regenerate 별). 정규화. SQL 검색 가능 | migration 1건 추가 필요 |
| B. `opportunity_inbox.metadata.drafts[]` 배열 inline | migration 0건. 단순 | metadata 5000자 cap 충돌. 검색/sort 불가. version 관리 어려움 |

**추천**: **A** (신규 테이블). 운영 가치 + 향후 확장성.

`opportunity_drafts` 스키마 (제안):
```
id              serial pk
opportunity_id  integer not null references opportunity_inbox(id) on delete cascade
platform        varchar(50) not null  -- ebay/shopify/qoo10/...
language        varchar(10) not null  -- ko/en/ja/zh/...
title           text
description     text
hashtags        text[]
prompt_version  varchar(20)           -- 'v1.0' 등
ai_provider     varchar(50)           -- 'anthropic' / 'openai'
ai_model        varchar(50)           -- 'claude-sonnet-4-6' / 'gpt-4o-mini'
input_tokens    integer
output_tokens   integer
cost_usd        numeric(10,4)
generated_by    integer references users(id)
generated_at    timestamp default now()
status          varchar(30) default 'generated'  -- generated/approved/rejected/published
approved_by     integer references users(id)
approved_at     timestamp
metadata        jsonb
```

### 2-4. Prompt 정책

- **Platform 별 template** — eBay (영문 listing 형식, HS code/condition 강조) / Shopify (HTML body) / X (280자 카피) / TikTok (15초 후크 카피) / Qoo10 (일본어 keyword 강조)
- **Input** — opportunity_inbox 의 `title_ko/title_en/brand/category/expected_sell_price_usd/notes/source_url`
- **Output** — JSON `{ title, description, hashtags, language }` (model 가 JSON 강제)
- **i18n** — target language 명시 (en/ko/ja/zh). 자동 번역 X — model 이 직접 작성
- **Safety** — 가격/성능 보장 문구 금지, 경쟁사 비방 금지, 저작권 금지 문구 prompt 에 포함

### 2-5. 비용 / Rate Limit

- **Cost 추적** — `opportunity_drafts.cost_usd` 컬럼에 호출당 비용 기록
- **Daily cap** — 사장님 설정 (예: $5/day) 초과 시 새 호출 차단
- **Rate limit** — 1초당 1 호출 (단순 setTimeout). 본 PR 은 단일 호출만 — 동시성 후속 PR
- **Retry** — model API 5xx 시 1회 retry. 그 외 즉시 실패

### 2-6. Safety Foundation 통합

R1 의 모든 draft 생성 = **`safetyExec.runAction` audit row 자동 기록**:
- `action_name = 'ai_draft_generate'`
- `target_table = 'opportunity_drafts'`, `target_id = <draft.id>`
- `executed_by_user_id = req.user.id`
- `before_snapshot = { opportunity_id, platform, language, ai_model }`
- `after_snapshot = { draft_id, input_tokens, output_tokens, cost_usd }`
- `rollback_method = 'manual'` (생성된 draft 삭제 = manual)

→ 운영자가 📜 실행 로그에서 모든 AI 호출 추적 가능.

### 2-7. UI

| 화면 | 기능 |
|---|---|
| **opportunity 상세 화면** (R-Inbox UI 가 별 PR — 본 PR R1 에서는 우선 API+admin 화면만) | "AI draft 생성" 버튼 (target_platforms 각각 / 또는 모두 한 번에) |
| **draft 검토 화면** (신규) | 생성된 draft 보기 + 승인/반려 + 재생성 |

⚠️ R-Inbox UI 가 부재 → R1 본 PR 은 **API 우선 + 기존 dashboard 또는 사이드바에 임시 admin 화면 1개** 권장. 풀 UI 는 후속 PR.

### 2-8. 권한

- **draft 생성 (POST)**: admin 만 (cost 통제). staff 는 후속 PR 검토
- **draft 조회 (GET)**: staff/admin 모두 (자기 후보 / 본인 assigned 만 — R0 정책 정합)
- **draft 승인 (POST :id/approve)**: admin 만

---

## 3. PR 범위 — Option S/M/L

| 옵션 | 범위 | 파일 | 위험 |
|---|---|---|---|
| **S (Slim)** | migration `042_opportunity_drafts.sql` + service `aiDraftGenerator.js` + route 4개 (POST 생성 / GET 목록 / GET :id / POST :id/approve) + Anthropic Claude SDK 통합 + 임시 admin 화면 1개 | 5 | **중간** — AI 외부 호출 + 비용 |
| M | S + i18n bulk 생성 (한 번에 4 언어) + 재생성 (regenerate) + 비용 dashboard 위젯 | 7 | 중간 |
| L | S + M + auto cron mode + R-Inbox 풀 UI 통합 | 12+ | 높음 — 첫 PR 부담 |

**추천**: **S** — 1차 안전 도입. 운영 검증 후 M/L 점진 확대.

### S 의 상세 산출물

| # | 파일 | 작업 | 예상 라인 |
|---|---|---|---|
| 1 | `supabase/migrations/042_opportunity_drafts.sql` | 신규 — opportunity_drafts 테이블 + 4 인덱스 + 2 FK | ~80 |
| 2 | `src/services/aiDraftGenerator.js` | 신규 — Anthropic SDK 호출 + prompt template + cost 추적 | ~250 |
| 3 | `src/web/routes/opportunityDrafts.js` | 신규 — 4 endpoint | ~120 |
| 4 | `server.js` | `/api/opportunity-drafts` 등록 | +2 |
| 5 | `package.json` | `@anthropic-ai/sdk` dependency 추가 | +1 |

**총 5 파일** (3 신규 + 2 수정). UI 0건 (admin 임시 화면은 별도 PR 또는 staff console 활용).

⚠️ **신규 dependency** = 사장님 spec 의 "package.json 무수정" 룰 위반 가능 — sapt's 결정 필요.

---

## 4. 환경 변수 / 설정

```env
# config/.env 추가 (사장님 1회 설정)
ANTHROPIC_API_KEY=sk-ant-...
AI_DRAFT_DAILY_USD_CAP=5.00
AI_DRAFT_DEFAULT_MODEL=claude-sonnet-4-6
```

- `ANTHROPIC_API_KEY` 미설정 시 R1 라우트 503 응답 ("AI 서비스 미구성")
- `AI_DRAFT_DAILY_USD_CAP` 미설정 시 default $5/day
- `AI_DRAFT_DEFAULT_MODEL` 미설정 시 `claude-sonnet-4-6`

---

## 5. 검증 시나리오 (R1 통과 기준)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| 1 | migration 042 idempotent | 두 번 실행 → already exists skip |
| 2 | 신규 컬럼/FK/인덱스 정합 | 컬럼 ~17 / FK 2 (opportunity_id, generated_by) / 인덱스 4 |
| 3 | admin 이 opportunity 1건 생성 → AI draft 생성 (eBay 영문) | 200 + draft row 1건 + cost_usd ≤ $0.05 |
| 4 | 동일 opportunity → 다른 platform (Shopify) 재호출 | 200 + draft row 추가 1건 (1:N 정상) |
| 5 | i18n 검증 — 일본 platform (Qoo10) → language='ja' draft | 일본어 title 생성 |
| 6 | daily cap 초과 시도 | 429 + "오늘의 AI 호출 한도 초과" |
| 7 | safetyExec audit chain | automation_runs 에 'ai_draft_generate' row 1건 / cost / token 기록 |
| 8 | staff 권한 | POST 403, GET 본인 후보만 |
| 9 | qa:safety regression | 51+ PASS / 0 FAIL |
| 10 | 응답 안전 | API key / response token 등 절대 응답에 포함 X |

---

## 6. 위험 / 트레이드오프

| 위험 | 영향 | 완화 |
|---|---|---|
| AI cost 폭발 (잘못된 cron / 무한 재생성) | $/day 초과 | daily cap + 수동 트리거 only (S 정책). Daily $5 = 약 100 draft (sonnet 기준) |
| AI 응답 hallucination (가격/성능 거짓) | 사용자 불신 | prompt 의 안전 구문 + admin 검토 필수 (status='generated' → 'approved' gating) |
| API key 누설 | 운영 위험 | env 만 사용. 응답/로그/error message 에 키 0건 |
| 외부 API latency (8~15초) | UI block | 비동기 + 진행 상태 표시. 단 본 PR 단순화 위해 동기 호출 + 명확한 loading |
| platform별 약관 위반 (자동 생성 콘텐츠 금지 platform) | 규정 위반 | platform 별 prompt 에 약관 준수 문구 + admin 최종 검토 필수 |
| prompt template 의 변화 = 결과 비교 어려움 | 회귀 추적 | `prompt_version` 컬럼 + diff 가능 |

---

## 7. 무수정 약속

| 영역 | 무수정 |
|---|---|
| `supabase/migrations/037_*.sql` ~ `041_*.sql` | ✅ |
| `src/services/safetyExec.js` / `safetyUndo.js` | ✅ |
| `src/web/routes/safetyRuns.js` / `public/js/safetyRuns.js` | ✅ |
| `src/services/operationsBriefing.js` / `src/web/routes/operationsBriefing.js` | ✅ |
| `src/services/opportunityInbox.js` / `src/web/routes/opportunityInbox.js` | ✅ — R0 무수정. R1 은 별 service/route |
| `automation/src/db/schema.ts` | ✅ |

**예외**: `package.json` — `@anthropic-ai/sdk` dependency 추가 필요 (사장님 결정 사항).

---

## 8. 수용 기준 (사장님 체크리스트)

- [ ] §2 의 8 핵심 결정 모두 사장님 승인 (특히 AI provider / 트리거 / 저장 위치)
- [ ] §3 의 PR 옵션 S 선택 또는 M/L 변경
- [ ] §4 의 env 3종 운영 설정 가능
- [ ] §5 의 시나리오 1~10 검증 가능
- [ ] AI cost 한도 정책 (default $5/day) 동의
- [ ] package.json dependency 추가 허용
- [ ] R1 본 PR 후 R-Inbox UI 별 PR 진행 동의 (R1 은 API + 임시 admin 화면만)

---

## 9. 후속 PR 로드맵

| PR | 범위 | 의존 |
|---|---|---|
| **R-Inbox UI** | R0 + R1 통합 화면 (사이드바 신규 메뉴 / 후보 카드 / draft 검토 modal) | R1 통과 |
| **R2 Listing Publisher** | draft `approved` → 실 platform API 등록 (ebay 우선) | R1 + R-UI |
| **R3 Price Attack Watcher** | competitor_product 후보 → 정기 가격 모니터 + auto repricing | R0 데이터 + 별 cron |
| **R1-cron** | 자동 트리거 모드 (사장님이 수동 모드 운영 후 안전 확인되면 cron 도입) | R1 + 비용 추적 |
| **R1-multi-provider** | OpenAI 등 추가 provider 선택 가능 | R1 통과 |

---

## 10. 본 PR R1 의 외부 무수정 약속 (Plan 단계)

- 본 plan = docs 1 파일 신규. 코드/스키마/migration 변경 0
- 사장님 승인 후 별 implementation prompt 작성 → 그 후 코드 진입

---

## 11. 본 문서 메타

- 작성: 2026-05-11
- 작성자: Claude (현 세션)
- 대상: PR R0 (de281bd) 운영 적용 완료 후
- 코드 변경: 0건 (본 문서가 유일 산출물)
- 다음 작업: 사장님 §2 결정 + §3 옵션 선택 + §8 수용 기준 체크 → R1 implementation prompt 작성 → 구현 진입
