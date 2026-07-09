# Commerce OS — Data Contract v1 (확정)

> **Commerce OS v1은 "자동 가격변경 시스템"이 아니라, SKU마다 자동화 권한을 판정하고 그 근거를 이벤트로 남기는 신뢰도 기반 가격 운영체제다.**

이 문서는 기능 명세가 아니라 **데이터 계약**이다. "현재 데이터만으로 엔진이 자동으로 의사결정할 수 있는가"를 규정한다.

---

## Principle 1 — 자동화는 "결정"이 아니라 "권한"이다

```
Data → Confidence → Permission → Automation
```

엔진은 가격을 **결정**하지 않는다. 엔진은 각 SKU에 대해 **권한(AUTO / REVIEW / BLOCK)**을 결정한다.
사람은 가격을 계산하는 사람이 아니라 **예외를 처리하는 사람**이 된다.

- **AUTO** — 추천대로 자동 실행 가능.
- **REVIEW** — 추천은 존재하나 사람 승인 필요(신뢰도/정책).
- **BLOCK** — 데이터 부재로 추천 자체가 불가·위험. 가격 결정이 아니라 **데이터 수정**이 필요.

---

## Confidence Model (다차원)

단일 `product_matches.confidence` 하나가 아니라 4개 축을 둔다.

| 축 | 의미 | 현재 소스 |
|---|---|---|
| Identity Confidence | 이 리스팅이 정말 이 SKU인가 | `product_matches.confidence`, `sku_mappings.match_confidence` |
| Price Confidence | 경쟁가가 최신·정상인가 | 크롤 신선도 + 이상가격 판정 |
| Cost Confidence | 랜딩코스트가 완전한가 | `sku_master.cost_krw` + 배송계산 + fee 완전성 |
| Supplier Confidence | (예약) 공급처 데이터 신뢰 | Engine 5 활성 전까지 `NULL`/1.0 취급 |

**게이팅(안전 판정) = `min(축들)`.** 최약 링크가 지배한다.
**정렬(Review Queue 우선순위) = 가중 점수.** 급한 것부터.

> Supplier 축이 생길수록 Overall이 정교해지고, **데이터 품질이 증명하는 만큼 자동화 범위가 자연히 넓어진다.**

권한 임계값:
- Overall ≥ **0.95** → AUTO
- **0.80 ~ 0.94** → REVIEW
- < **0.80** → BLOCK (또는 정책 BLOCK)

---

## Engine 1 (Price) Data Contract

### 입력
| 데이터 | 필수 | 품질 조건 |
|---|---|---|
| Internal SKU | ✅ | Canonical (`sku_master.internal_sku`) |
| Competitor Price (total) | ✅ | 최신(신선도 임계 내), 이상가격 아님 |
| Landing Cost | ✅ | **Complete** = 도매원가 + 국제배송(무게·부피 존재) + 국내배송 + eBay fee (+결제수수료 버퍼) 전부 산출 가능 |
| Match Confidence | ✅ | Identity ≥ 0.95 |
| Profit Margin | ✅ | 기여마진 계산 완료(`listingProfitabilityCalculator`) |

> **Landing Cost Complete 정의가 핵심 체크포인트다.** `sku_master.weight_gram / 치수`가 비면 국제배송 산출 불가 → Landing Cost Incomplete → `BLOCK_LANDING_COST_UNKNOWN`.

### 출력
```
{ recommended_price, action, reason_code, confidence_snapshot, rule_version }
```
`action` ∈ { AUTO, REVIEW, BLOCK }. 가격을 저장하지 않고 **이벤트를 발행**한다(아래).

### 가격 산출 규칙 (v1)
```
target = min(competitor_total_all_sellers) - UNDERCUT
floor  = landing_cost + min_margin        # repricing_rules.min_margin_pct
recommended_price = max(target, floor)     # 1등 시도, 단 손해 금지
```
- `recommended_price == target` (floor 위) & Identity≥0.95 & 정책위반 없음 → **AUTO**
- floor가 target을 밀어냄(내가 최저가로 못 감) → **REVIEW** (`REVIEW_FLOOR_BINDS`)
- `competitor_total < landing_cost` (네이버 프로모/오소싱) → **REVIEW** (`REVIEW_COMPETITOR_BELOW_COST`)

---

## Reason Codes (enum — 자유텍스트 금지)

Control Tower KPI 집계를 위해 사유는 반드시 코드. **AUTO도 reason 필수** — "자동 적용된 가격 중 어떤 패턴이 돈을 벌었는지" 분석하려면.

**AUTO** (자동 실행 — 어떤 근거로 자동인지)
- `AUTO_UNDERCUT_SAFE` (경쟁최저가−언더컷, floor 위)
- `AUTO_MATCH_CONFIRMED` (Identity 고신뢰 확정 매칭)
- `AUTO_PRICE_MAINTAINED` (이미 최저·적정, 변경 없이 유지)

**BLOCK** (데이터 수정 필요)
- `BLOCK_LANDING_COST_UNKNOWN`
- `BLOCK_NO_MATCH` (Identity confidence 없음/매칭 부재)
- `BLOCK_MAP` (최저광고가 제한 상품)
- `BLOCK_API_ERROR`
- `BLOCK_STALE_COMPETITOR` (경쟁가 신선도 초과)

**REVIEW** (사람 승인)
- `REVIEW_LOW_CONFIDENCE` (0.80~0.94)
- `REVIEW_FLOOR_BINDS` (최저가로 못 가는데 이익은 남음)
- `REVIEW_COMPETITOR_BELOW_COST`
- `REVIEW_MAX_DROP_EXCEEDED`
- `REVIEW_PRICE_ANOMALY` (경쟁가 급락 의심)

---

## BLOCK = 가격 문제가 아니라 데이터 태스크

BLOCK은 "사람이 가격을 고민할 것"이 아니라 **"직원이 데이터를 채울 것"**이다. 각 BLOCK reason은 작업으로 전환된다.

```
BLOCK_LANDING_COST_UNKNOWN → Task: weight_gram / dimensions / cost_krw 보완
BLOCK_NO_MATCH             → Task: SKU 매핑 확인/등록
BLOCK_MAP                  → Task: MAP 정책 등록/해제
```

Control Tower 표시(대표가 아니라 **직원 작업 큐**로 하향):
```
가격 변경 불가 37개
 - 무게 없음 18  → 무게·치수 입력 큐
 - 원가 없음 11  → 원가 입력 큐
 - 매칭 없음  8  → 매핑 확인 큐
```

즉 BLOCK 카운트가 줄어드는 것 자체가 "자동화 커버리지가 넓어진다"의 지표다.

---

## v1 MVP 범위 고정 (Scope Lock)

첫 배선은 **가격 엔진만**. 광고·공급처·가지치기는 v1에 넣지 않는다(범위 폭주 방지).

```
Input:  internal_sku · ebay_item_id · current_price · competitor_total · landing_cost · product_match_confidence
Output: recommended_price · action · reason_code · confidence_snapshot · price_event
```

Engine 3(광고)/4(가지치기)/5(공급처)는 v1 검증 후 순차 연결.

---

## 계약서 레벨 안전장치 (Global Guardrails)

bad-data 연쇄를 구조적으로 차단.

1. **일일 최대 인하율 캡** — 한 SKU가 하루에 −N% 초과 인하 불가 → 초과 시 REVIEW.
2. **하루 자동변경 비율 상한** — 전체 카탈로그의 최대 M%만 하루 AUTO 적용(폭주 방지).
3. **이상가격 서킷브레이커** — 경쟁가가 직전 대비 −X% 급락 → AUTO 아님, `REVIEW_PRICE_ANOMALY`.
4. **Kill switch** — 전체 자동적용 즉시 중단 플래그.

---

## Event-first 구조 (가격을 저장하지 말고 이벤트를 기록)

가격은 상태가 아니라 **이벤트의 결과**로 남긴다. 100% 추적 가능.

```
PriceRecommendationCreated → PriceApproved → PriceApplied
CompetitorChanged → PriceUpdated → PriceReverted(선택)
```

각 이벤트 payload 필수 필드:
```
{ event_type, sku, item_id, at,
  old_price, new_price, recommended_price,
  action, reason_code,
  confidence_snapshot: { identity, price, cost, supplier, overall },
  rule_version, competitor_ref, actor(system|user_id) }
```

> `confidence_snapshot`과 `rule_version`을 이벤트에 박아 두면, 나중에 "왜 이 가격이 됐나 / 어떤 규칙·데이터가 근거였나"를 재현할 수 있다.

**신설 테이블(제안):** `price_events` (append-only). 현재가는 최신 `PriceApplied` 이벤트에서 파생.

---

## Engine 5 예약 필드 (지금 구현 X, 스키마만 예약)

나중에 스키마를 다시 뜯지 않기 위해 지금 컬럼만 심는다. 값 `NULL` 허용.

`sku_master` (또는 신설 `suppliers` + FK):
```
supplier_id, supplier_sku, supplier_cost,
supplier_lead_time, supplier_reliability, supplier_confidence
```
신설 권장: `suppliers(id, name, ...)` 마스터 + `orders/purchase_requests.supplier_id FK`.
→ 값이 안 채워져도, **주문↔공급처 링크만 지금 걸어두면** 마진·품절률·클레임이 자동 축적되기 시작.

---

## Dry-run 통과 기준 (시작 전 사전 등록 — 골대 고정)

Engine 1은 1~2주 **추천만 생성, 실제 가격 변경 없음.** 다음을 사전 확정하고, 충족 시에만 AUTO 활성:

- **AUTO 정밀도 ≥ 98%** — AUTO 판정 표본을 사람이 검수, 오추천(단위 오매칭·손해가) 비율 ≤ 2%.
- **False-BLOCK 허용 범위** — BLOCK 중 실제로는 처리 가능했던 비율 모니터(과잉 차단 점검).
- **예상 마진영향 ≥ 0** — 추천대로 적용 시 총기여마진이 감소하지 않음.
- **커버리지** — AUTO 가능 SKU 비율(= Landing Cost Complete & Identity≥0.95) 측정 → 자동화 실질 범위 확인.

---

## 실행 순서

1. **Data Contract v1 확정** (본 문서 — 필드·상태·이벤트·Reason Code)
2. **Engine 1 배선** — killPrice(경쟁최저가) + listingProfitabilityCalculator(랜딩코스트·마진) + product_matches.confidence → 추천가 + AUTO/REVIEW/BLOCK + `price_events` 발행
3. **Dry Run 1~2주** — 추천만, 가격 변경 없음
4. **정확도 검증** — 위 GO 기준
5. **Confidence ≥ 0.95 SKU부터 자동 적용**
6. **Engine 4 → 2 → 3** 순 연결
7. **Engine 5** — 공급처 데이터 축적 후 활성

> 처음부터 "완전 자동"을 목표하지 않는다. **데이터 품질이 증명하는 만큼만 자동화를 넓힌다.**

---
*v1 · 감사 근거: `docs`(Commerce OS Readiness Audit) · 소스: `killPricingDailyJob.js`, `listingProfitabilityCalculator.js`, `product_matches`, `sku_master`*
