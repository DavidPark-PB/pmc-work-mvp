# SKU Enrichment Loop V1 · 구현 완료 (2026-08-31 · atomicity 2026-09-01)

**Owner Directive**: 배송관리에서 한 번 입력한 SKU 정보를 다음 주문부터 다시 입력하지 않는 것.

**상태 (2026-09-01)**: 🟢 마이그 105 + 106 apply 완료 · atomicity RPC 로 검증 · 사장님 실 SKU smoke test 대기.

**Atomicity 업그레이드 (2026-09-01)**:
- 초기 구현은 앱단 순차 호출 (INSERT → UPDATE) · partial success window 존재.
- Postgres function 안에서 실행하도록 106 마이그 추가 (`update_sku_cost_atomic` · `update_sku_supplier_atomic`).
- Function = 단일 transaction · 중간 실패 시 전체 rollback · history + master 값 불일치 원천 봉쇄.
- FOR UPDATE row lock 으로 동시성 안전.
- Failure rollback test 2개 (없는 SKU · 없는 supplier_id) 실증 PASS.

---

## 1. 무엇을 만들었는가

### 마이그레이션 (additive)
[`supabase/migrations/105_sku_enrichment_loop.sql`](supabase/migrations/105_sku_enrichment_loop.sql)

- **`sku_master` 신규 컬럼 9개** (모두 NULLABLE · 기본값 없음 · 기존 row 무영향):
  - `weight_source · weight_source_ref · weight_measured_at`
  - `dims_source · dims_source_ref · dims_measured_at`
  - `cost_source · cost_source_ref · cost_updated_at`
- **`sku_cost_history`** (신규 · append-only): 원가 변경 audit · 이전값 보존
- **`sku_supplier_history`** (신규 · append-only): 소싱처 이력 (N:M)
- **`v_sku_enrichment_status`** (뷰): SKU 완성도 스코어 (0~4)
- **Backfill**: 기존 값에 `weight_source='legacy_import'` 태그 (구값 출처 불명)

### Backend
- [`src/web/routes/api.js`](src/web/routes/api.js) `/orders/save-weight` 확장:
  - 기존: `orders.weight_kg` + `sku_master.weight_gram` (qty=1)
  - **확장**: qty=1 시 `sku_master.length/width/height_cm` 도 저장 + source tracking (`weight_source='shipping_measured'` · `weight_source_ref=order_no`)
- [`src/web/routes/skuEnrichment.js`](src/web/routes/skuEnrichment.js) 신규 3 endpoints:
  - `PATCH /api/sku-master/:sku/cost` — 원가 저장 + `sku_cost_history` audit
  - `PATCH /api/sku-master/:sku/supplier` — 소싱처 저장 + `sku_supplier_history` audit
  - `GET /api/sku-master/:sku/enrichment` — 현재 상태 + 최근 이력 조회
- 기존 `/api/suppliers` (routes/suppliers.js) 재사용 · 자동완성은 프론트 client-side filter
- [`src/web/routes/shippingRecommendations.js`](src/web/routes/shippingRecommendations.js) 응답 확장:
  - `sku_master` join 필드 12개 추가 (cost_krw · supplier_id · weight_status · shipping_group 등)
  - `suppliers` join · 소싱처 이름/채널
  - **`profit_estimate` 필드 신규**: `omsProfitService.CHANNEL_FEE_RATE` 재사용 · 매출/원가/배송비/수수료 기반 마진 자동 계산 (기존 공식 그대로)
  - 환율 · `EXCHANGE_RATE_KRW_PER_USD` env (omsProfitService 와 동일 소스 · 기본 1350)

### Frontend
- [`public/js/shippingRecs.js`](public/js/shippingRecs.js) 카드 확장:
  - **자동 표시**: ✅ 무게 / ✅ 크기 / ✅ 원가 / ✅ 소싱처 (있으면 초록) · ⚠️ 미입력 (빨강 강조)
  - **인라인 원가 입력** 폼 (KRW · 사유 선택)
  - **인라인 소싱처 선택** 폼 (검색 자동완성 + 신규 등록 + 매입가 선택)
  - **예상 이익 자동 표시**: 매출 − 원가 − 배송 − 수수료 = 이익 · 마진%
  - 원가 없으면: "💰 예상 이익 계산 불가 — 원가 미입력" 명시 (배송 업무 계속 가능)

### Apply 스크립트
- [`scripts/apply-105-sku-enrichment.js`](scripts/apply-105-sku-enrichment.js) — dry-run + verify 포함

---

## 2. 자동학습 루프 (Owner 지시 핵심)

```
첫 주문 (SKU=ABC · 매칭 성공)
  ↓
직원이 배송관리 카드에서:
  · ✏️ 무게 82g · 15×10×2cm 입력 · [저장] → save-weight
  · 💰 원가 5000원 입력 · [저장]           → sku-master/:sku/cost
  · 🏭 소싱처 "일본 A" 선택 · [저장]        → sku-master/:sku/supplier
  ↓
sku_master 자동 반영 (qty=1 만) + 이력 저장
  ↓
동일 SKU=ABC 다음 주문 (다른 order_no)
  ↓
shippingRecommendations.js 가 sku_master JOIN
  ↓
카드 자동 표시:
  ✅ 무게 82g  ✅ 크기 15×10×2cm  ✅ 원가 5000원  ✅ 소싱처 일본 A
  💰 예상 이익 6,700원 (마진 37.2%)
  ↓
직원 재입력 없음
```

---

## 3. Source Tracking (Owner 지시 매우 중요)

모든 enrichment 필드에 3개 짝 저장:
- `xxx_source` — 어디서 왔는지 (enum · loose)
  - `shipping_measured` · 배송 실측
  - `shipping_manual` · 배송 수기 입력
  - `purchase_import` · 매입 데이터 (미래 · 지금은 미사용)
  - `owner_correction` · 사장님 직접 수정 (미래 UI 예약)
  - `legacy_import` · 기존값 (마이그 backfill · 출처 불명)
- `xxx_source_ref` — 참조 (order_no · purchase_id 등)
- `xxx_measured_at` / `xxx_updated_at` — 언제

이 구조로 나중에 AI 가 "이 데이터는 실측인가 · 추정인가" 판단 가능.

---

## 4. 안전 원칙 준수

| Owner 규칙 | 준수 |
|---|---|
| 기존 배송/주문 흐름 무손상 | ✅ save-weight 는 add-only 필드만 · 실패 fallback 유지 |
| DROP 금지 | ✅ 마이그 additive only |
| 기존 데이터 삭제 금지 | ✅ backfill 은 `WHERE ... IS NULL` 조건만 |
| 새 migration additive | ✅ ADD COLUMN IF NOT EXISTS · CREATE TABLE IF NOT EXISTS |
| 기존 값 자동 덮어쓰기 금지 | ✅ save-weight 는 qty=1 만 (multi-qty skip · 사유 반환) |
| SKU 매칭 confidence 낮으면 자동수정 금지 | ✅ orders.sku ↔ sku_master.internal_sku 정확 매칭만 |
| 여러 SKU 주문 단품무게 저장 금지 | ✅ qty>1 skip (기존 로직 유지) |
| 원가 AI 추정 금지 | ✅ 사용자 입력만 · 서버 파싱 없음 |
| 예상/실제 구분 | ✅ "예상 이익 · 예상 마진" 라벨 명시 · profit_estimate.reason='ok' or 미충족 사유 |
| 기존 production automation 유지 | ✅ Engine 1 · CompetitorMonitor · autoRepricer 무영향 |
| Bearer token · git 미커밋 | ✅ Accio 관련 변경 없음 (스코프 밖) |

---

## 5. UI 표시 예시 (사장님 요청 그대로)

```
[주문 #12345 · eBay · 08-31]
어반포즈: BTS 뷔 앨범 · × 1
👤 John · 🌍 US · ⚖️ 82g · 📐 15×10×2cm · 🏷️ SKU: BTS-V-001 · ✓ BTS-V-001

┌─ SKU 자동 표시 ─────────────────────────────────────────┐
│ ✅ 무게 82g  ✅ 크기 15×10×2cm                          │
│ ✅ 원가 5,000원 [수정]                                   │
│ ✅ 소싱처 일본공급처A (direct) [변경]                    │
│                                                          │
│ 💰 예상 이익 6,700원 · 마진 37.2%                       │
│    매출 20,250원 − 원가 5,000 − 배송 4,900 − 수수료 3,645 (18%)  │
└──────────────────────────────────────────────────────────┘

[5개 배송사 견적 비교표 ...] (기존)
```

원가 없을 때:
```
⚠️ 원가 미입력 [입력]
💰 예상 이익 계산 불가 — 원가 미입력
   매출 20,250원 · 수수료 3,645원
```

---

## 6. Deployment 절차 (사장님 승인 필요)

### STEP 1 · Dry-run (안전 · DB 무변경)
```bash
cd /Users/parksungmin/pmc-work-mvp
node scripts/apply-105-sku-enrichment.js --dry-run
```
SQL 전문 확인.

### STEP 2 · 실 apply (사장님 승인 후)
```bash
node scripts/apply-105-sku-enrichment.js
```
Verify 결과 자동 출력 · 9개 컬럼 + 2개 테이블 + 1개 뷰 확인.

### STEP 3 · Git commit + push
```bash
git add supabase/migrations/105_sku_enrichment_loop.sql
git add src/web/routes/skuEnrichment.js
git add src/web/routes/shippingRecommendations.js
git add src/web/routes/api.js
git add server.js
git add public/js/shippingRecs.js
git add scripts/apply-105-sku-enrichment.js
git add docs/reviews/sku-enrichment-loop-v1-implementation.md
git commit -m "feat(sku-enrichment): V1 · 배송관리 카드에 SKU 원가/소싱처 자동 표시 + 다음 주문 자동 채움"
```
`git add -A` 금지 (사장님 지시).

Railway 자동 배포 (main push 시).

### STEP 4 · 실 테스트 (사장님 지시 V1 성공 테스트)
Owner 지시 명시:
1. 배송관리 열기
2. 실 테스트 SKU 하나 선택 (매칭 성공한 것)
3. ✏️ 무게 · 크기 입력 · 저장
4. 💰 원가 입력 · 저장
5. 🏭 소싱처 선택 · 저장 (필요 시 신규 등록)
6. 배송비 자동 계산 확인
7. 예상 마진 자동 계산 확인
8. 페이지 새로고침 · 값 유지 확인
9. **동일 SKU 다른 주문 열기 · 기존 정보 자동 표시 확인**

---

## 7. 알려진 제한 · 미포함 (Owner 지시 스코프)

**의도적으로 안 만든 것** (Owner 지시 STOP · V1 스코프 밖):
- ❌ Accio 연동 (Owner 지시 중단)
- ❌ Business Event 발행
- ❌ 자동발주
- ❌ AI 원가 추정
- ❌ 대규모 SKU 일괄 업데이트 UI

**제한 (설계상 안전 경계)**:
- SKU 매칭 실패 주문 (`matched: false`) 은 enrichment 패널 표시 안 함
- multi-qty (`quantity > 1`) 주문의 무게/치수 는 `sku_master` 자동 반영 안 함 · orders 만 저장 (사장님 확인 후 SKU 마스터 별도 수정)
- 원가는 free-text 사유만 · 통화는 KRW 하드코드 (v1)
- 소싱처 free-text 등록은 history 만 남고 `sku_master.supplier_id` 갱신 안 함 (신규 등록 → suppliers 테이블 insert → id 획득 → 그 다음 저장 flow)

---

## 8. 파일 목록 (git status 로 확인 가능)

```
M   server.js                                                # 1 mount 추가
M   src/web/routes/api.js                                    # save-weight 확장
M   src/web/routes/shippingRecommendations.js                # sku_master join + profit_estimate
M   public/js/shippingRecs.js                                # 배지/입력폼/마진 표시
??  supabase/migrations/105_sku_enrichment_loop.sql          # 스키마 (컬럼 + history 2개 + 뷰)
??  supabase/migrations/106_sku_enrichment_atomic_rpc.sql    # atomicity RPC 2개 (2026-09-01)
??  src/web/routes/skuEnrichment.js                          # 3개 endpoint · rpc 호출
??  scripts/apply-105-sku-enrichment.js                      # 105 apply
??  scripts/apply-106-sku-enrichment-rpc.js                  # 106 apply
??  scripts/test-105-sku-enrichment.js                       # regression test (격리 SKU · cleanup)
??  docs/reviews/sku-enrichment-loop-v1-implementation.md    # 이 문서
```

**10개 파일 · syntax + 10/10 test PASS · atomicity 검증 완료** (rollback 실증 포함).

---

## 9. Technical Review Pack · ChatGPT 검토용 (24 항목)

1. **아키텍처**: sku_master 는 canonical · history 는 audit · UI 는 dumb display
2. **Additive migration**: DROP/RENAME/TYPE 변경 없음 · 마이그 100% idempotent
3. **Backfill 안전**: `WHERE ... IS NULL` 로 이미 값 있는 row 건너뜀
4. **Source tracking**: 3-쌍 (source · source_ref · timestamp) · 미래 AI 판단 근거
5. **History append-only**: INSERT 만 · UPDATE/DELETE 앱단 규율 (트리거는 phase 2)
6. **Multi-qty 안전**: qty>1 시 sku_master 반영 skip · 이유 반환
7. **Match confidence**: 정확 매칭만 (기존 recommender.buildMatchInfo 재사용)
8. **Route order**: `skuMaster.js` 의 `/:id` 와 새 `/:internalSku/cost` 는 segment 수 다름 (충돌 없음)
9. **Suppliers reuse**: 기존 `/api/suppliers` 재사용 · 중복 route 없음
10. **CHANNEL_FEE_RATE reuse**: `omsProfitService` export 재사용 · 별 공식 안 만듬
11. **환율 소스**: `EXCHANGE_RATE_KRW_PER_USD` env · omsProfitService 와 동일
12. **Profit `reason` field**: `ok · no_cost · no_shipping · no_payment_amount · unknown_platform` — 프론트 명확 표시
13. **UI · 배송 업무 중단 안 함**: 원가 없어도 배송비 계산/견적/라벨 정상 동작
14. **Data mask**: 프론트에 KRW만 · USD 원본은 그대로 사용
15. **Auth**: skuEnrichment router · `requireAdmin` (기존 pattern)
16. **Rate limit**: 별도 없음 · save 는 사용자 click 1회 · 부하 낮음
17. **Concurrent write**: 마지막 저장이 이김 (last-write-wins) · history 는 시간순 보존
18. **Rollback**: 마이그 rollback SQL 파일 하단 comment · additive 라 사실상 rollback 불필요
19. **Feature flag**: 없음 · UI 표시 확장은 default on · 사장님 지시 "간단하게"
20. **Test**: unit test 미포함 (V1 · 실 테스트 위주) · phase 2 에서 추가
21. **Legacy code path**: WMS 기반 `/wms/*` route 무영향 · legacy 만 확장
22. **Kill switch**: 별도 없음 · 원한다면 shippingRecommendations.js 응답에서 `sku_enrichment/profit_estimate` 필드 제거하면 화면 원복
23. **Log**: 서버 콘솔 · `[skuEnrichment/cost] error` prefix 통일
24. **Metric**: `v_sku_enrichment_status` 뷰로 완성도 스코어 대시보드 가능 (미래 · V1 안 만듬)

---

## 10. 사장님 결정 필요

1. **마이그 105 apply 진행?** (dry-run 후 실행 · 예상 <10초)
2. Git commit + push 진행? (Railway 자동 배포 · 4~5분)
3. 실 테스트 SKU 하나 선택 후 위 `STEP 4` 시나리오 검증 · 성공 확인 후 완료 보고
