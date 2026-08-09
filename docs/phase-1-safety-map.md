# Phase 1 안전화 지도 (Price Mutation + Kill Switch + SoT)

> 2026-08-10 · TASK 1~3 결과. **STOP: 코드 수정 없음. 승인 대기.**
> 근거: 2개 병렬 서브에이전트 조사 (`Explore` — read-only).

---

## A. PRICE MUTATION MAP — 마켓플레이스 가격 변경 가능 모든 코드

**총 17개 경로 (세부 세면 21+, MCP 서버 6종 각각 세면 26+).**

### 자동 (Cron / Job / Pipeline) — 4개

| # | 경로 | 파일 | 실행 조건 | 실제 라이브? |
|---|---|---|---|---|
| 3 | `autoRepricer` | [src/services/autoRepricer.js:16](src/services/autoRepricer.js#L16) | `dryRun` 강제 true (라인 17-20) | 해당 라인만 지우면 즉시 라이브 |
| 4 | `repricingPipelineJob` (05:00 KST cron) | [src/jobs/repricingPipelineJob.js:396](src/jobs/repricingPipelineJob.js#L396) | `PRICE_WRITES_ENABLED=false` 상수 | 상수만 바꾸면 즉시 라이브 |
| 6 | `killPricingDailyJob` (09:00 KST cron) | [src/jobs/killPricingDailyJob.js](src/jobs/killPricingDailyJob.js) | 텔레그램 리포트만, 승인 대기 | 경로 5 활성 시 라이브 |
| 14 | `automation syncListing` (fastify) | [automation/src/services/listing-service.ts:500](automation/src/services/listing-service.ts#L500) | API 호출 | **현재 라이브** |

### 수동 UI / API — 13개

| # | 경로 | 파일 | 검증 | 라이브? |
|---|---|---|---|---|
| 1 | `POST /api/battle/kill-price` (전투 상황판) | [src/web/routes/api.js:2181](src/web/routes/api.js#L2181) | -50% 폭락만 차단 | ✅ **활성** |
| 2 | `POST /api/repricing/execute/:sku` | [src/web/routes/api.js:5655](src/web/routes/api.js#L5655) → [src/services/repricingService.js:124](src/services/repricingService.js#L124) | repricing_rules.min_margin 만 | ✅ 활성 |
| 5 | Telegram `reprice:approve` 콜백 | [src/web/routes/telegramWebhook.js:64](src/web/routes/telegramWebhook.js#L64) | 현재 UI 메시지 교체로 무력화 | 몇 줄만 되돌리면 부활 |
| 7 | `PUT /api/products/ebay/:itemId` | [src/web/routes/api.js:1319](src/web/routes/api.js#L1319) | 없음 (auth 만) | ✅ 활성 |
| 8 | `PUT /api/products/shopify/:variantId` | [src/web/routes/api.js:1387](src/web/routes/api.js#L1387) | 없음 | ✅ 활성 |
| 9 | `PUT /api/products/naver/:productNo` | [src/web/routes/api.js:1425](src/web/routes/api.js#L1425) | 없음 | ✅ 활성 |
| 10 | `PUT /api/products/alibaba/:productId` | [src/web/routes/api.js:1475](src/web/routes/api.js#L1475) | 없음 | DB만 (마켓 미호출) |
| 11 | `PUT /api/products/shopee/:itemId` | [src/web/routes/api.js:1502](src/web/routes/api.js#L1502) | 없음 | ✅ 활성 |
| 12 | `POST /api/sku-scores/retirement/execute` (+5% 인상) | [src/web/routes/api.js:1972](src/web/routes/api.js#L1972) | 없음 | ✅ 활성 |
| 13 | `sync-ebay-price-shipping.js` (CLI 벌크 8k행) | [src/sync/sync-ebay-price-shipping.js:29](src/sync/sync-ebay-price-shipping.js#L29) | dryRun 옵션 지원, 500ms rate limit | ✅ 활성 |
| 15 | `POST /api/ai-workflow/publish` (최초 발행가) | [src/services/aiWorkflowPublisher.js:124](src/services/aiWorkflowPublisher.js#L124) | 없음 | ✅ (재가격 아닌 신규 등록) |
| 16 | MCP 서버 6종 `update_price` | [mcp-servers/](mcp-servers/) (ebay/shopify/coupang/qoo10/shopee/naver) | 없음 | ✅ 외부 MCP 클라이언트가 곧바로 |
| 17 | `engine1DryRunJob` (Commerce OS v1) | [src/jobs/engine1DryRunJob.js](src/jobs/engine1DryRunJob.js) | ✅ **guardrails.kill_switch + confidence + landing cost** | 추천만 (마켓 미호출) |

### 감사 로그 통계

- kill_switch 실제 게이트 통과 경로: **1개** (engine1DryRunJob, 그것도 추천만)
- `price_events` 발행 경로: **1개** (engine1DryRunJob, `PriceRecommendationCreated`)
- **`PriceApplied` 이벤트 발행: 0건 (전 경로)**
- 감사 로그 완전 부재: **12개 경로**

---

## B. KILL SWITCH BYPASS MAP — kill_switch=true 로도 안 막히는 것

### `pricing_guardrails` 실제 read 지점 (전체)

- 정의: [supabase/migrations/069_engine1_guardrails_suppliers.sql:7](supabase/migrations/069_engine1_guardrails_suppliers.sql#L7)
- `getGuardrails()` 정의: [src/services/priceEventService.js:126](src/services/priceEventService.js#L126)
- `getGuardrails()` 유일한 호출자: [src/jobs/engine1DryRunJob.js:145](src/jobs/engine1DryRunJob.js#L145) — **dry-run 잡, 실제 가격 변경 없음**
- `canAutoApply()` 정의: [src/engines/priceEngine.js:273](src/engines/priceEngine.js#L273) — **정의만 있고 호출 0건** (`grep canAutoApply` 결과 export 만)

### Bypass 표 — kill_switch=true 인데 계속 도는 경로

| 경로 | kill_switch 조회? | 실제 마켓 가격 변경 |
|---|---|---|
| `/api/battle/kill-price` | ❌ | ✅ `ebay.updateItem` |
| `/api/ops/products/bulk-price` | ❌ | products.price_usd |
| `PUT /api/products/ebay/:itemId` | ❌ | ✅ `ebay.updateItem` |
| `autoRepricer` | ❌ | ✅ (forced dryRun 만 방벽) |
| `RepricingService.executeRepricing` | ❌ | ✅ platform API |
| `/api/sku-scores/retirement/execute` | ❌ | ✅ `ebay.updateItem` |
| `sync-ebay-price-shipping.js` | ❌ | ✅ ReviseItem 대량 |
| MCP 서버 6종 | ❌ | ✅ 각 플랫폼 API |

**결론: kill_switch 는 지금 무의미. dry-run 잡만 읽고, dry-run 잡은 어차피 가격 안 바꿈.**

### 자체 상수 가드만 있는 곳

- `autoRepricer`: `MAX_DAILY_CHANGES=50`, `DEFAULT_FLOOR_PCT=60`, `COMPETITOR_CRASH_THRESHOLD=50%` — DB 스위치 아닌 코드 상수
- `repricingPipelineJob`: `PRICE_WRITES_ENABLED=false` — 코드 상수 (재배포 필요)

---

## C. SOURCE OF TRUTH DECISION — 코드 증거 기반 확정

| 도메인 | Canonical SoT | 증거 | Legacy / Mirror | 조치 방향 |
|---|---|---|---|---|
| **SKU** | `sku_master.internal_sku` | 038 마이그레이션 명시 "internal source-of-truth for WMS SKUs", UNIQUE 제약 | products.sku, ebay_products.sku 병존 | FK 검증 (TASK 8) 후 정렬 |
| **Listing state (marketplace 관측)** | `ebay_products` (`price_usd`, `stock`, `shipping_usd`, `updated_at`) | productSync/myListingRefresher/battle view 등 모든 read 경로가 이 테이블 | products.price_usd (repricingService 만 씀), master_products (dead) | ebay_products 를 marketplace snapshot 으로 확정 |
| **Cost (원가/무게/치수)** | `sku_master.{cost_krw, weight_gram, w/h/l_cm}` | 038+051 마이그레이션, engine1 · listingProfitabilityCalculator 소비 | products.purchase_price, master_products.total_cost, platform_listings.purchase_price_krw | 신규 pricing path 는 sku_master 만 |
| **Competitor listing** | `competitor_listings` (크롤) | aiMatcher/competitorMonitor/dashboard view read | competitor_prices (레거시 수동 등록, 부분 사용) | competitor_listings 로 통일 (Phase 2) |
| **Product match** | `product_matches` | engine1 · aiMatcher · telegramWebhook · battle view · 10+ scripts 사용 | `sku_mappings` (hermesMarketIntelligence 만 read) — 마이그레이션 backfill 방향 = product_matches → sku_mappings | sku_mappings 를 view 로 대체 후 hermes 를 product_matches 로 전환 |
| **Pricing decision / audit** | `price_events` | 068 마이그레이션 의도 명시, engine1 이 유일 발행자 | price_change_log (repricingService 만 씀), price_history (002 legacy) | **PriceApplied 이벤트 발행 강제** (전 write 경로) |

### 핵심 architecture rule 확정

**Marketplace Reality ≠ Decision History**

- `ebay_products.price_usd` = **eBay 에서 마지막에 관측한 값** (marketplace reality snapshot)
- `price_events` = **우리 시스템이 내린 결정 + 실행 결과 감사** (decision + audit)

두 값이 다를 수 있음이 정상:
- 사장님이 eBay 웹에서 직접 변경 → `ebay_products` 는 크론 sync 전까지 stale, `price_events` 에는 우리 결정 없음 → **`ebay_products.updated_at` 이 진실 시각**
- 우리가 API 변경 → `price_events(PriceApplied)` 먼저, 그 다음 `ebay_products` sync

**현재 상태**: `PriceApplied` 발행 0건이라 두 번째 케이스가 감사 불가.

---

## D. P0 EXECUTION PLAN — 가장 안전한 수정 순서

### Commit 1 — Pricing Safety Characterization Tests (write 없음)

- 현재 동작을 고정하는 테스트만 먼저 추가 (아무 것도 안 바꿈)
- TASK 11 CASE A~G (attack / hold / block missing cost / block ambiguous fee / kill switch on / retry idempotent / marketplace failure → DB 안 씀)
- 테스트 대상: `priceEngine.decideSku`, `killPriceCalculator` (신설 예정 없음, 기존 위치에서), `canAutoApply` (미호출이라 그린으로 시작)
- 목적: 이후 커밋이 기존 계산 결과를 바꾸지 않았음을 보장

### Commit 2 — Kill Switch 를 실제 마켓 write 직전으로 이동

- `src/services/priceExecutionGate.js` **신설** — 유일한 marketplace write boundary
- signature: `async function executePriceWrite({ sku, itemId, oldPrice, newPrice, reason, source, requestId })`
- 내부 순서:
  1. `getGuardrails()` → `kill_switch` true 면 BLOCK (마켓 미호출)
  2. `PRICE_WRITES_ENABLED` env 검사
  3. `price_events(PricePending)` INSERT with `requestId` (idempotency)
  4. 이미 같은 `requestId` 로 `PriceApplied` 있으면 skip
  5. `ebay.updateItem` 실제 호출
  6. 결과에 따라 `PriceApplied` 또는 `PriceFailed` INSERT
  7. 성공 시에만 `ebay_products.price_usd` UPDATE
- **아직 caller 변경 X** — gate 만 만들고 테스트

### Commit 3 — Battle Kill Price 를 Gate 로 (경로 1)

- `/api/battle/kill-price` 만 gate 사용
- 회귀 확인 (기존 UI 동작 유지)

### Commit 4 — 수동 UI 편집 5개 (경로 7-11) 를 Gate 로

- ebay/shopify/naver/alibaba/shopee 각 라우트
- 각 어댑터의 `updatePrice` 를 gate 로 감싼 wrapper 로 대체

### Commit 5 — 자동 경로 (경로 3, 4, 5, 12) 를 Gate 로

- autoRepricer, repricingPipelineJob, telegramWebhook approve, SKU 은퇴
- forced dryRun / PRICE_WRITES_ENABLED 상수 제거하고 **gate 가 kill_switch DB 값으로 판단**

### Commit 6 — Legacy repricingService.executeRepricing 을 Gate 로 (경로 2)

- 기존 `products.price_usd` UPDATE 로직은 유지
- 마켓 API 호출과 감사만 gate 로 대체

### Commit 7 — 대량 벌크 (경로 13, 14) 를 Gate 로

- `sync-ebay-price-shipping.js` CLI 도 gate 통과 (dry-run 옵션 유지)
- `automation/` 의 syncListing 도 gate 사용 (Phase 3 통합 전까지 wrapper 라도)

### Commit 8 — MCP 서버 6종 (경로 16) 서버 측 flag

- 각 MCP 툴의 `update_price` 가 백엔드로 위임하도록 (gate 통과)

### Commit 9 — `ebay_api_stock` 스키마 정합화

- `supabase/migrations/075_add_ebay_api_stock.sql` 신설 (`IF NOT EXISTS` idempotent)
- 마이그레이션 없어도 코드 방어적 fallback 은 유지

### Commit 10 — Unit / Currency Contract 문서화 + validation

- `src/pricing/contract.js` 신설: `normalizeFeeRate`, `normalizeCurrency`, `normalizeWeight`
- pricing boundary 진입 시 검증. 애매하면 BLOCK.

### Commit 11 — SKU FK 조사 SQL (TASK 8)

- 실행만 하는 진단 스크립트: `scripts/audit-sku-orphans.js`
- 결과에 따라 별도 커밋에서 FK 또는 application validation

### Commit 12 — sku_mappings 를 read-only view 로 (TASK 7)

- hermes 를 product_matches 로 전환
- sku_mappings 는 DROP 안 하고 VIEW 로 대체

---

## E. FILES TO CHANGE — 실제 수정 대상 + 이유

### 신규 파일

| 파일 | 이유 |
|---|---|
| `src/services/priceExecutionGate.js` | 유일한 마켓 write boundary (Commit 2) |
| `src/pricing/contract.js` | Unit/Currency 정규화 (Commit 10) |
| `tests/pricing/safety.test.js` | Characterization + case A~G (Commit 1) |
| `supabase/migrations/075_add_ebay_api_stock.sql` | schema drift 정합화 (Commit 9) |
| `scripts/audit-sku-orphans.js` | SKU FK 조사 (Commit 11) |

### 수정 대상 (기존 파일)

| 파일 | 이유 |
|---|---|
| `src/services/priceEventService.js` | `PriceApplied`/`PriceFailed`/`PricePending` publish 함수 신설 |
| `src/services/repricingService.js:149-157` | executeRepricing → gate 위임 (Commit 6) |
| `src/services/autoRepricer.js:158,238` | forced dryRun 제거 + gate 사용 (Commit 5) |
| `src/jobs/repricingPipelineJob.js:400` | PRICE_WRITES_ENABLED 상수 제거 (Commit 5) |
| `src/web/routes/api.js:2181` (battle/kill-price) | gate 위임 (Commit 3) |
| `src/web/routes/api.js:1319,1387,1425,1475,1502` | 5 endpoint → gate 위임 (Commit 4) |
| `src/web/routes/api.js:1972` (retirement) | gate 위임 (Commit 5) |
| `src/web/routes/telegramWebhook.js:64-146` | approve 콜백 → gate (Commit 5) |
| `src/sync/sync-ebay-price-shipping.js` | gate 사용 (Commit 7) |
| `automation/src/services/listing-service.ts:500` | gate 로 위임하는 wrapper (Commit 7) |
| `mcp-servers/{ebay,shopify,coupang,qoo10,shopee,naver}-server.js` | update_price → 백엔드 위임 (Commit 8) |
| `src/services/hermesMarketIntelligence.js:309` | sku_mappings → product_matches (Commit 12) |

---

## F. FILES NOT TO TOUCH — 이번 Phase 절대 손대지 말 것

### 사장님 명시 제외

- **`/api/cs/suggest` 및 CS 전체** — [src/web/routes/cs.js](src/web/routes/cs.js), [src/services/cs/*](src/services/cs/) 전부. Anthropic/Gemini 상태 그대로 유지.
- **`automation/` 폴더 전체** — Phase 3 로 이월. 단 예외: 경로 14 (syncListing) 에 gate wrapper 는 넣어야 함. wrapper 만 최소로.

### 이번 Phase 목표와 무관

- UI 리디자인 / 사이드바 변경 / 대시보드 개편
- Engine 2 (Discovery) / Engine 3 (Growth) / Engine 4 (Pruning) — Commerce OS 신규 기능
- 카탈로그 / 배송 / CS / 재고 / 주문 / 구매지출 관리 화면
- AI 상품 제작 (통합) 4단계 — 최근 작업물
- 전투 상황판 UI 자체 (킬프라이스 버튼의 라우트만 gate 통해서 라우팅되게, UI 는 그대로)
- 옛 페이지 (AI 리메이커 / 상세페이지 재구성 / 썸네일 만들기) — 이미 사이드바 숨김, 코드 삭제 X

### DROP 금지

- 어떤 테이블도 DROP 금지
- 어떤 컬럼도 DROP 금지 (rename + deprecate 코멘트만)
- `sku_mappings` 는 VIEW 로 대체하되 원 테이블 DROP 금지
- `products` / `master_products` / `my_listings` 등 dead 후보도 이번엔 안 지움

### schema 대량 변경 금지

- `075_add_ebay_api_stock.sql` 하나만. IF NOT EXISTS + 방어 코드 유지.
- UNIQUE constraint 신규 추가는 duplicate 조사 결과 (Commit 11) 이후 별도 Phase

---

## STOP — 승인 대기

이 문서까지가 TASK 1~3. 사장님 승인 필요:

1. **A~F 지도가 맞는지** (특히 F 의 "안 건드리는 목록" 이 실제 의도와 일치하는가)
2. **Commit 1 부터 시작해도 되는가** (Characterization test — 코드 로직 변경 없음, 기존 동작 고정만)
3. **STOP CONDITIONS 발생 시 사장님한테 알리는 조건 준수 확인**:
   - 프로덕션 DB 상태 확인 필요 → STOP
   - destructive migration 필요 → STOP
   - 마켓 API semantics 불명 → STOP
   - 대량 backfill 필요 → STOP
   - 가격 계산 결과가 기존과 크게 달라짐 → STOP

승인 주시면 Commit 1 (테스트만) 부터 진행.
