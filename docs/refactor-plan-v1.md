# Commerce OS 리팩토링 계획 v1 (2026-08-10)

> **STEP 0 결과물**: 코드 수정 없이 조사만. 승인 후 Phase 1 착수.
> **원칙**: 기존 정상 동작 유지 · 데이터 정확성 최우선 · 중복 제거 · 사람 판단 시스템화 · 확장 가능한 구조 · 불필요한 복잡성 배격.
> **비즈니스 룰**: "무조건 싸게" 가 아니라 "**이익 나는 전장만 골라 공격**". 가격은 감정 아니라 데이터.

---

## 1. Executive Summary (3줄)

- **가격 결정은 5개 파일이 서로 다른 상수·단위로 각자 계산 중.** 킬프라이스 공식 5+곳, eBay 수수료율 4종(0.13/0.16/0.18/13/15/5.5), 환율 3종(1350/1400/1450), undercut 3종($0.01/$1/$2). Data Contract v1 (price_events append-only + guardrail 게이팅) 은 **문서만 존재**하고 실제 4개 파이프라인은 우회.
- **매칭 SoT 가 3개로 갈라짐** (`product_matches` / `competitor_prices` / `sku_mappings`). Engine 1 은 첫 번째만 인식 → 자동으로 등록된 경쟁사는 전부 BLOCK. Evidence (왜 매칭됐는지) 미저장 → 오매칭 사후 감사 불가.
- **eBay Browse API 이론적 하루 소모량 5.6k > 한도 5k.** 어제 CompetitorMonitor 2h→24h 완화가 유일한 조치. 잡별 quota budget 없음, race protection 없음, 실패 통지는 1개 잡만.

**총 P0: 8건, P1: 15건.** 코드 대규모 재작성 없이 **재배선 + 게이트 + 상수 통합**으로 대부분 해결 가능.

---

## 2. SYSTEM MAP — 현재 데이터 흐름

### 2.1 Pricing Domain

```
[SoT 후보]                        [실제 사용처]
priceEngine.js (Data Contract)  ← 유일하게 engine1DryRunJob 만 사용
    ↑                              (dry-run, PRICE_WRITES_ENABLED=false)
    │
    ├── killPricingDailyJob (자체 UNDERCUT=1.0)
    ├── autoRepricer (자체 tier undercut + MY_SHIPPING=3.90)
    ├── repricingService (자체 exchange=1400, fee=0.18, tax=0.15)
    ├── /api/battle/kill-price (자체 계산, guardrail 완전 우회 ⚠️ P0)
    ├── dashboard.js (프론트 재계산, MIN_BUFFER=1.00)
    └── repricingPipelineJob (undercut=0.01, 별도 배송비 엔진)
```

### 2.2 Matching Domain

```
경쟁사 리스팅 크롤 → competitor_listings (SoT for 크롤)
              ↓
   ┌──────────┴──────────┐
   │                      │
aiMatcher.js         competitorAutoMapper.js  (⚠️ 두 서비스가 같은 문제를 다르게)
(Gemini)             (규칙 스코어)
   ↓                      ↓
product_matches       competitor_prices     (⚠️ SoT 스플릿 P0)
(SoT for AI)          (레거시)
   ↓
sku_mappings (하이머스 그림자 사본)

Engine 1은 product_matches 만 인식 → competitor_prices 매칭은 자동 BLOCK
```

### 2.3 Automation Domain (24개 잡)

| 시간 | 잡 | 소모 |
|---|---|---|
| 01:00 | CompetitorCrawler (LOCKED 기본) | Finding + Browse |
| 01:30 | AIMatcher | Gemini |
| 02:00 | AlibabaMonitor + SkuScore | Alibaba web + Trading |
| 03:00 | **MyListingRefresher (3k Browse)** + SourcingAgent + recurring expenses | 03:00 최다 소모 |
| 04:00 | platformSync (4-plat) + CompListingRefresher (583 Browse) | 04:00 폭주 |
| 05:00 | RepricingPipeline (dryRun 강제) | Trading (25 pages) |
| 08:00-08:20 | Hermes Daily/Product/Listing Intel | DB만 |
| 09:00 | morningDigest + opsBriefing + **killPricingDaily** + b2b | 09:00 최다 |
| 10:00 | eBay productSync + naver enrich | Trading + Naver |
| 22:00 | eBay productSync | Trading |
| 24h | CompetitorMonitor (~1k Browse) | 완화 완료 (2h→24h) |
| 4h | MarginAgent | DB만 |

**단일 EbayAPI 싱글턴을 24개 잡이 shared, mutex 없음.**

### 2.4 DB SoT 병존 표

| 도메인 | 정답 | 병존하는 곳 |
|---|---|---|
| 내 판매가 (USD) | `ebay_products.price_usd` | products, master_products, my_listings, platform_export_status, platform_mapping, shopify_products, listing_details, price_events, price_change_log, price_history |
| 원가 (KRW) | `sku_master.cost_krw` | products.purchase_price, master_products.total_cost, platform_listings.purchase_price_krw, shopify_products.purchase_price_krw |
| 무게 | `sku_master.weight_gram` (g) | master_products.weight_kg (kg), b2b_shipments.weight_kg, order_shipments.*_weight_g |
| 경쟁가 | `competitor_listings` (크롤) | competitor_prices (레거시 수동) |
| 매칭 | `product_matches` | competitor_prices, sku_mappings |
| 환율 | `margin_settings.exchange_rate_usd` | platform_listings.exchange_rate 컬럼별 |
| 수수료 | `platforms.fee_rate` (0.180) | ebay_products.fee_rate (13), platform_listings.fee_rate (0) |
| 가격 이벤트 | `price_events` (068 신규) | price_change_log (004), competitor_price_history (057), price_history (002) |

---

## 3. P0 / P1 목록 (TOP 10)

### P0 (데이터 손실 · 잘못된 가격 · 서비스 장애)

1. **`/api/battle/kill-price` 가 guardrail 완전 우회** — `pricing_guardrails` 조회 없음, `canAutoApply` 미호출, kill_switch 무시. 프론트 클릭 → 바로 eBay + DB write. `price_events` 발행 없음. 📁 [src/web/routes/api.js:2181](src/web/routes/api.js#L2181)
2. **`price_events` append-only 미준수** — 실제 가격 변경 3경로 (autoRepricer, repricingService, /battle/kill-price) 모두 이벤트 미발행 → `getCurrentAppliedPrice` 항상 null → event-first 아키텍처가 문서상만 존재.
3. **매칭 SoT 스플릿** — `product_matches` vs `competitor_prices` vs `sku_mappings`. Engine 1 은 첫 번째만 인식.
4. **`internal_sku = eBay SKU` 정책 위반 위험** — `aiMatcher.js:103/163/295` 이 `sku || item_id` fallback. eBay 리스팅에 SKU 빈값이면 item_id 가 our_sku 로 저장 → sku_master join 깨짐 (CLAUDE.md "no_match 531" 사고의 원인).
5. **Evidence 재현 불가** — 매칭 LLM 프롬프트/응답/후보목록 미저장. 오매칭 사후 감사 불가능.
6. **`ebay_api_stock` 컬럼이 마이그레이션 정의 없이 코드 사용** — productSync/api/skuContextBuilder/hermesExecutionApproval 이 read/write. 배포 환경마다 존재 여부 다름. 📁 [src/api/productSync.js:78](src/api/productSync.js#L78)
7. **eBay Browse API quota 초과 위험** — 이론치 5.6k/day > 한도 5k, 잡별 budget 없음, race protection 없음, 유일 방어는 `RATE_LIMIT_ABORT=3` streak.
8. **CS 라우트 지시 위반** — CLAUDE.md 에 "`/api/cs/suggest` Anthropic 유지" 명시되어 있으나 실제로는 이미 Gemini 로 전환. 📁 [src/web/routes/cs.js:833](src/web/routes/cs.js#L833) — 사장님 지시 확인 필요.

### P1 (매출·이익 직접 영향)

9. **하드코딩 상수 대혼돈** — 수수료율 4종, 환율 3종, undercut 3종이 여러 파일에 흩어짐. 룰 변경 시 한 곳만 바꾸면 drift 사고.
10. **매칭 confidence 이진 게이팅** — engine1DryRunJob/myListingRefresher/battle 등은 `status='approved'` 이진 필터만. priceEngine 만 4축 min-of gating 실사용. 대부분 파이프라인이 confidence 자체를 무시.
11. **잡 실패 알림 통일성 부재** — 24개 잡 중 killPricingDaily 만 실패 시 텔레그램. 나머지는 로그만 남고 조용히 죽음.
12. **09:00 알림 폭탄** — morning digest + opsBriefing + killPricingDaily + b2b + Hermes 3종 = 오전 30분간 6-7개 메시지.
13. **같은 SKU 에 대한 4개 소스 추천 충돌** — MarginAgent (4h) / SourcingAgent (03:00) / RepricingPipeline (05:00) / killPricingDaily (09:00) 이 상반된 가격 추천 발행, 잡간 dedup 없음.
14. **eBay OAuth refresh 경합** — 4개 refresh 경로 (ebayAPI / automation/EbayClient / tokenRefresh.js / token-scheduler.ts) 가 같은 refresh_token 을 각자 rotate → permanent 401 위험.
15. **자동화 라인 (`automation/`) 이 메인 코드와 중복 API 클라이언트** — eBay/Shopify/번역 각 2벌씩. `automation/translate.ts` 는 캐시조차 없음.

**나머지 8건은 문서 본문 (P0 8건 + P1 15건 = 23건).**

---

## 4. Source of Truth 정의 (Phase 2 목표)

| 도메인 | 정답 (SoT) | 파생/캐시 |
|---|---|---|
| Product identity | `sku_master.internal_sku` | 나머지 all 참조 FK |
| My listing (price/stock) | `ebay_products` + **`price_events` (append-only 판정 로그)** | 화면은 `v_current_price` VIEW |
| Competitor listing | `competitor_listings` (크롤) | `competitor_prices` 는 레거시 → deprecated 후 통합 |
| Cost / weight / dims | `sku_master.{cost_krw, weight_gram, w/h/l_cm}` | 다른 테이블은 read-only 미러 |
| Match | `product_matches` (evidence 컬럼 추가) | `sku_mappings` deprecated |
| Match evidence | `match_evidence` **신설** (LLM 프롬프트/응답/후보/기여토큰 저장) | — |
| Pricing decision | `price_events` | `v_current_applied_price`, `v_recent_recommendations` VIEW |
| Fee rate | `platforms.fee_rate` (0~1 소수) | 코드에서 하드코딩 전부 이 테이블 참조로 |
| Exchange rate | `margin_settings.exchange_rate_usd` | 동일 |
| Guardrail | `pricing_guardrails` id=1 | **모든** 가격 write 경로가 이 게이트 통과 강제 |

---

## 5. 실행 계획 (Phase 1-7)

각 Phase 는 **작고 검증 가능한 커밋 여러 개**로 나눔. 각 커밋 = "왜 → 영향 파일 → 변경 → 확인" 사이클.

### Phase 1 — P0 지혈 (1-2일, 코드 write 최소)

목표: **기존 동작을 절대 바꾸지 않고**, 위험한 우회 경로만 차단.

- **1.1 `/api/battle/kill-price` 에 guardrail 게이트 삽입** — pricing_guardrails 조회, kill_switch 검사, canAutoApply 통과 시에만 실행. 실패 시 사용자에게 명확한 에러.
- **1.2 3경로 가격 write 에 `price_events(PriceApplied)` 발행 추가** — autoRepricer / repricingService / /battle/kill-price. 스키마는 이미 존재.
- **1.3 매칭 SoT 통합 리스트 문서화** — sku_mappings 는 read-only 미러로 격리 (write 는 product_matches 만). 코드 삭제는 Phase 3.
- **1.4 `ebay_api_stock` 컬럼 정식 마이그레이션 추가** — schema 를 코드 사용에 맞춤 (drop 아니라 add).
- **1.5 aiMatcher `sku || item_id` fallback 제거** — SKU 없으면 skip + team_task 생성 (사장님이 SKU 입력 필요).
- **1.6 CS 라우트 Anthropic vs Gemini 문제 사장님 재확인** — 지시서 vs 코드 불일치 명시적 결정.

**Phase 1 완료 조건**: 자동/수동 가격 write 경로에 guardrail + 이벤트 로깅 100% 커버. 기존 화면·잡 동작 변함 없음.

### Phase 2 — SoT 정리 (3-5일, DB 마이그레이션)

- **2.1 상수 통합 모듈 신설** — `src/config/pricingConstants.js`: 수수료율/환율/undercut/MIN_MARGIN 을 **DB (platforms, margin_settings, pricing_guardrails) 에서 로드**. 하드코딩 전부 이 모듈 참조로 대체 (파일 단위 순차).
- **2.2 킬프라이스 공식 통합** — priceEngine.js 의 `target = compTotal - undercut` 을 SoT 로 하고, 4개 파일 (killPricingDaily, autoRepricer, /battle/kill-price, dashboard.js) 이 이 함수 호출.
- **2.3 `v_current_applied_price` VIEW 생성** — price_events append-only 에서 SKU 별 최신 PriceApplied 파생. 화면·다른 서비스는 이 뷰만 조회.
- **2.4 `match_evidence` 테이블 신설** — 매칭 시 프롬프트/응답/candidate list/score breakdown 저장. Phase 4 감사 기반.
- **2.5 dead 테이블/컬럼 문서화** — my_listings, master_products, translations, platform_mapping, platform_export_status 등 usage 재확인 후 삭제 대상 리스트.

### Phase 3 — 도메인 배선 정리 (5-7일)

- **3.1 `src/pricing/` 도메인 폴더 신설** — priceEngine + killPriceCalculator + floorCalculator + guardrailChecker. 4개 pipeline 이 이 도메인만 import.
- **3.2 `src/matching/` 도메인 폴더 신설** — aiMatcher + ruleMatcher(=competitorAutoMapper) 를 통합, 공통 후보 축소 → 규칙 hit → AI fallback 파이프라인.
- **3.3 자동화 라인 (`automation/`) 통합 전략 결정** — 사장님 확인: 유지? 흡수? OAuth refresh 는 반드시 1경로로.

### Phase 4 — 자동화 안전 계층 (3-5일)

- **4.1 잡 실행 이력 테이블 신설** — job_runs (name, started_at, finished_at, status, quota_used, error). 24개 잡 모두 통일된 wrapper.
- **4.2 잡 실패 → 텔레그램 통일** — killPricingDaily 패턴 확산.
- **4.3 eBay Browse quota 공유 카운터** — 하루 총 5000 예산을 잡별로 나누고 (MyListingRefresher 40% / CompListingRefresher 15% / CompetitorMonitor 20% / killPricing 15% / Engine1 10%), 초과 시 잡 자체 skip + 알림.
- **4.4 09:00 알림 배치 통합** — 6-7개 → 1개 요약 (또는 시간 offset).
- **4.5 `EBAY_PRICE_WRITE_LOCKED` 전역 스위치** — 실수로 dryRun 해제 방지.

### Phase 5 — Dead Code 제거 (2-3일)

usage 확인 후 안전한 것만 삭제:
- `@anthropic-ai/sdk` (grep clean 확인)
- my_listings, master_products, translations, platform_mapping, platform_export_status (2.5 결과)
- 옛 상세페이지 재구성/썸네일 만들기/AI 리메이커 (사이드바 이미 숨김 → 코드 완전 제거)
- listingProfitabilityCalculator 의 원가/마진 계산 3중 복붙

### Phase 6 — Performance & Reliability (측정 기반)

우선 측정. 그 후:
- competitor_prices `(sku, competitor_id)` UNIQUE 추가 → race 방지
- price_events 중복 발행 방지 idempotency key
- 프론트 재계산 제거 (backend 값만 표시)

### Phase 7 — Commerce OS 확장 boundary (계약만)

Engine 2 (Discovery), Engine 3 (Growth), Engine 4 (Pruning), Engine 5 (Supplier) 를 나중에 붙일 수 있게 도메인 경계만 확보. **이번엔 구현 X.**

---

## 6. 각 Phase 산출물

각 Phase 완료 시:
1. 완료된 P0/P1 항목 체크
2. 변경 파일 diff summary
3. 신규/변경 마이그레이션 목록
4. 회귀 테스트 결과 (핵심 돈 계산 로직)
5. 남은 위험 갱신

---

## 7. 절대 금지 (변경 규칙)

1. **v1 완료까지 가격 자동 write 활성화 금지** — Guardrail 게이트 완성 + 1주 dry-run 후 사장님 승인.
2. **DB destructive migration 금지** — 컬럼 삭제 대신 rename + deprecate.
3. **API contract 변경은 backward compatible 만** — 신규 필드 추가 O, 필드 삭제/이름 변경 X.
4. **환경변수/secret 코드 노출 금지.**
5. **한 번에 대규모 rewrite 금지** — 각 커밋 검증 가능한 크기.

---

# CEO ACTION LIST (사장님이 지금 결정할 것 5개)

1. **가격 자동 write 활성화 정책 확인**
   현재 다중 하드 스위치로 자동 write 는 차단됨. Phase 1 (guardrail 게이트) 완료 후에도 계속 dry-run 유지할지, 아니면 특정 SKU 그룹만 auto_apply 시작할지 결정.

2. **CS 라우트 Anthropic vs Gemini**
   지시서엔 "`/api/cs/suggest` Anthropic 유지" 였는데 코드는 이미 Gemini 로 전환됨. 어느 게 진짜 원함인지 확인 → 되돌릴지 아니면 지시서 갱신할지.

3. **`automation/` 폴더 (별도 자동화 라인) 처리 방향**
   메인 코드와 eBay/Shopify/번역 API 클라이언트 중복. 완전 흡수할지, 별개 서비스로 유지할지. **유지하면 OAuth refresh 는 반드시 1경로로 강제 필요**.

4. **Phase 1-5 진행 순서 승인**
   위 계획 그대로 갈지, 우선순위 재조정할지. (특히 Phase 2 의 하드코딩 상수 통합은 파일 수십 개 건드림 — 리스크 있음.)

5. **09:00 텔레그램 알림 폭탄 감축**
   지금 오전 30분간 6-7개 메시지. 배치 통합해서 1개로 만들지, 아니면 유지할지. (일부 사장님이 개별 알림을 선호할 수도 있음.)

---

**다음 단계**: 이 계획서 승인 → Phase 1 착수 → 각 커밋마다 diff + 확인 → Phase 1 완료 리포트 → Phase 2 승인 사이클.

*근거: 5개 서브에이전트 병렬 조사 (Pricing / Matching / Automation / DB / AI) · CLAUDE.md · commerce-os-data-contract-v1.md · PLAN-competitor-kill-to-no1-seller.md.*
