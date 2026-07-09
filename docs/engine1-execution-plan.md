# Engine 1 (Price) 실행 계획 — Commerce OS v1

> Data Contract v1 기준. 목표: "데이터 품질이 증명하는 만큼만 자동화를 넓힌다."

## 구현 현황 (2026-07-08)

| 구성요소 | 파일 | 상태 |
|---|---|---|
| price_events + reason enum + sku_master 예약 컬럼 | `supabase/migrations/068_price_events_and_reason_codes.sql` | ✅ 작성됨 |
| Guardrails + suppliers 마스터 + 집계 뷰 | `supabase/migrations/069_engine1_guardrails_suppliers.sql` | ✅ 작성됨 (신규) |
| Engine 1 판정 엔진 (순수 함수) | `src/engines/priceEngine.js` | ✅ 작성됨 (신규) |
| 이벤트 발행 + BLOCK→직원 태스크 | `src/services/priceEventService.js` | ✅ 작성됨 (신규) |
| Dry-run 배선 잡 | `src/jobs/engine1DryRunJob.js` | ✅ 작성됨 (신규) |
| 기존 소스 (재사용) | `killPricingDailyJob.js`, `listingProfitabilityCalculator.js`, `exceptionTask.js`, `product_matches` | 기존 |

## 실행 순서

### Step 1 — 마이그레이션 적용 (Day 0)
```bash
supabase db push        # 068, 069 적용
```
검증: `price_events`, `pricing_guardrails`(id=1 행 존재), `suppliers`, 뷰 2개.

### Step 2 — Dry-run 단독 실행 (Day 0~1)
```bash
node src/jobs/engine1DryRunJob.js
```
- 가격 변경 없음. `PriceRecommendationCreated` 이벤트만 발행.
- BLOCK은 `team_tasks`에 직원 데이터 태스크로 자동 생성 (dedupe 됨).
- 첫 실행에서 확인할 것: AUTO/REVIEW/BLOCK 분포, BLOCK 사유 분해(무게/원가/매핑).

### Step 3 — 스케줄 등록 (Day 1)
`server.js`의 killPricingDailyJob 스케줄(09:00 KST) 뒤에 연결하거나 별도 크론:
```js
const { runEngine1DryRun } = require('./src/jobs/engine1DryRunJob');
// 매일 09:30 KST — killPrice 크롤 이후
```

### Step 4 — Dry-run 1~2주 + 직원 데이터 보완 병행 (Week 1~2)
- 직원: BLOCK 태스크 큐 소진 (무게·치수·원가 입력, 매핑 승인).
- 대표: REVIEW 큐 승인/거부 — 기존 텔레그램 `reprice:approve` 경로 재사용.
- 매일 커버리지(AUTO 비율) 추이 관찰 — BLOCK 감소 = 자동화 범위 확대.

### Step 5 — GO/NO-GO 판정 (Week 2 말) — 골대 고정, 사전 등록
| 기준 | 목표 | 측정 방법 |
|---|---|---|
| AUTO 정밀도 | ≥ 98% | AUTO 표본 50건+ 사람 검수 — 단위 오매칭·손해가 ≤ 2% |
| False-BLOCK | 모니터 | BLOCK 중 실제 처리 가능했던 비율 |
| 예상 마진영향 | ≥ 0 | 추천 적용 시뮬레이션 — 총기여마진 비감소 |
| 커버리지 | 측정 | AUTO 가능 SKU 비율 (Landing Cost Complete & Identity≥0.95) |

### Step 6 — AUTO 활성 (GO 시)
```sql
UPDATE pricing_guardrails SET auto_apply_enabled = true WHERE id = 1;
```
- Confidence ≥ 0.95 SKU부터. 적용 경로는 `PriceApproved`→`PriceApplied` 이벤트 발행 필수.
- 비상 시: `UPDATE pricing_guardrails SET kill_switch = true WHERE id = 1;` (즉시 전면 중단)

### Step 7 — 후속 (v1 검증 후)
Engine 4(가지치기) → 2 → 3(광고) 순 연결. Engine 5(공급처)는 `suppliers`/`supplier_id` 링크로 데이터 자동 축적 후 활성.

## 안전장치 요약 (pricing_guardrails, id=1)
| 필드 | 기본값 | 의미 |
|---|---|---|
| `kill_switch` | false | true = 전체 자동적용 즉시 중단 |
| `auto_apply_enabled` | **false** | Dry-run GO 전까지 절대 true 금지 |
| `daily_max_drop_pct` | 15% | SKU당 일일 인하 캡 초과 → REVIEW |
| `daily_auto_ratio_cap_pct` | 20% | 하루 AUTO 적용 카탈로그 비율 상한 |
| `anomaly_drop_pct` | 30% | 경쟁가 급락 서킷브레이커 → REVIEW |
| `competitor_fresh_hours` | 48h | 초과 → BLOCK_STALE_COMPETITOR |

## KPI 쿼리 (Control Tower)
```sql
-- 오늘 판정 분포
SELECT action, reason_code, count(*) FROM price_events
WHERE event_type='PriceRecommendationCreated' AND created_at::date = current_date
GROUP BY 1,2 ORDER BY 1,3 DESC;

-- 직원 작업 큐 (BLOCK 하향)
SELECT * FROM v_block_task_queue;

-- 커버리지 추이 (AUTO 비율, 일별)
SELECT created_at::date d,
       round(100.0*count(*) FILTER (WHERE action='AUTO')/count(*),1) AS auto_pct
FROM price_events WHERE event_type='PriceRecommendationCreated'
GROUP BY 1 ORDER BY 1;
```
