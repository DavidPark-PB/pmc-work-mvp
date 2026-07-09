# 킬프라이스 데일리 잡 (killPricingDailyJob)

매일 오전 9시(Asia/Seoul) 실행 · 경쟁사 **총액(상품가+배송비)** 대비 킬프라이스 추천 + 소싱기회 탐지 → 텔레그램 푸시.

## 파일
- `src/jobs/killPricingDailyJob.js` — 잡 본체
- `src/services/scheduler.js` — `cron.schedule('0 9 * * *', ...)` 로 등록됨 (KillPricingDailyJob)

## 동작
1. **워치리스트 로드** — `competitor_prices` 중 `sku`가 매핑된 항목(기존 competitorAutoMapper/crawler 결과).
2. **라이브 조회** — `ebayAPI.getCompetitorItems()` 로 경쟁사 현재 상품가+배송비+판매수.
3. **킬프라이스 계산** — 총액 기준.
   - `킬프라이스 = 경쟁 총액 − UNDERCUT($1)`, 권장 상품가 = 킬프라이스 − 내 배송비.
   - 판정: `lower`(내가 비쌈→인하) / `raise`(내가 5%+ 저가→인상) / `hold`(적정) / `review`(가격차 비상식적, 형태 불일치 의심).
4. **소싱기회** — `competitor_listings` 중 내 SKU에 미매핑 + 판매수 ≥ 50 인 상품(내가 안 파는데 잘 팔림).
5. **텔레그램 푸시** — 인상/소싱은 요약, **인하 권장은 승인/거부 버튼**.
6. **opportunity_inbox 저장** — 소싱기회를 `product_sourcing` 타입으로 (플래그로 제어).

## 설정 (`CONFIG` in killPricingDailyJob.js)
| 키 | 기본 | 의미 |
|---|---|---|
| `UNDERCUT` | 1.0 | 킬프라이스 = 경쟁 총액 − 이 값 |
| `RAISE_PCT` | 0.05 | 경쟁가보다 5%+ 저가면 인상 권장 |
| `RATIO_LOW/HIGH` | 0.4 / 2.5 | 내총액/경쟁총액 벗어나면 검토(형태 불일치) |
| `SOURCING_MIN_SOLD` | 50 | 소싱기회 최소 판매수 |
| `SOURCING_SCAN_CAP` | 400 | 소싱 라이브조회 일일 상한(API 절약) |
| `REPORT_TOP` | 12 | 텔레그램 인하 버튼 상위 건수 |
| `WRITE_OPPORTUNITIES` | **false** | true면 opportunity_inbox에 실제 저장 |

## 안전장치 / 운영 주의
- 이 잡은 **가격을 직접 바꾸지 않음**(추천만). 인하 승인 버튼은 기존 `reprice:approve:sku:itemId:newPrice` 콜백을 재사용.
- 현재 `telegramWebhook.processApprove`는 "Hermes v1: 가격변경 비활성화" 안내만 표시함 → **버튼은 뜨지만 실제 적용은 v2 가격쓰기 활성화 후 동작**. 이는 기존 시스템의 의도된 보수적 설정.
- `WRITE_OPPORTUNITIES=false`가 기본 — 첫 운영에서 텔레그램 결과만 확인 후, 이상 없으면 `true`로 켜서 opportunity_inbox 저장 활성화.

## 수동 테스트
```bash
node src/jobs/killPricingDailyJob.js
```
⚠ 실행 시 **실제 텔레그램으로 발송**됨. 테스트 시 `TELEGRAM_CHAT_ID`를 테스트 채널로 바꾸거나, 코드 상단에서 `pushTelegram` 호출을 임시로 주석 처리해 콘솔 로그만 확인 권장.

## 워치리스트 늘리기
감시 대상은 `competitor_prices`(sku 매핑된 행)에 의존. 새 경쟁사 상품을 감시하려면 기존 competitor 크롤러/오토매퍼로 `competitor_prices`에 매핑을 추가하면 이 잡이 자동으로 포함.
