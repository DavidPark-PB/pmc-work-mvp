# pmc-work-mvp → 크로스보더 OMS/WMS 마이그레이션 분석

> 작성일: 2026-05-07 · 분석 모드: 코드 read-only · 코드 수정 없음
> 핵심 가설: **"업무관리 모듈 → 자동화 예외처리 콘솔"**
> 표기 약속:
> - **사실** — 코드/파일 직접 확인 (파일경로:라인 인용).
> - **추정** — 행간 해석/구조 추론. 접두사 "추정:".
> - **확인 필요** — 코드만으로 단정 못 함. 실제 사용 여부·운영 데이터 필요.

---

## 0. 요약 (Executive Summary)

### 한 줄 결론
**Keep/Modify 자산이 OMS/WMS 핵심 기능의 약 65~75%** 를 이미 커버한다 (추정). 신규 구축은 주로 "예외 콘솔 트리거 / SKU 마스터 단일화 / 마켓 가격·재고 일괄 변경 표면화 / 라벨 워크플로우 표준화" 4축에 집중된다.

### WMS 12개 타겟 기능 vs 현 자산 매핑 (한눈)

| # | WMS 타겟 기능 | 현 자산 위치 | 분류 | 비고 |
|---|---|---|---|---|
| 1 | SKU 마스터 (단일 진실) | `products` 테이블 ([001_create_tables.sql](../supabase/migrations/001_create_tables.sql)) + `master-products` API ([api.js:1117](../src/web/routes/api.js#L1117)) | **Modify** | 자동화 sub-app 의 `automation/src/db/schema.ts:58` 와 이중 정의 → 통합 필요 |
| 2 | 주문 수집 (멀티 마켓) | `orders` 테이블 + eBay/Shopify sync ([orderSync.js](../src/services/orderSync.js)) | **Modify** | 현재 eBay+Shopify 만. Shopee/Naver/Coupang/Qoo10 미통합 (확인 필요) |
| 3 | 도매 감시 (가격·재고) | `crawl_results` (automation), `competitors` + `competitor_prices` ([api.js:2008+](../src/web/routes/api.js)) | **Modify** | 전투 상황판은 셀러간 경쟁 모니터링. "도매 감시 = 매입처 가격·품절 추적" 으로 재해석 필요 |
| 4 | 가격 계산 (마진/환율/수수료) | `pricingEngine.js` + `pricing_settings` + `margin_settings` | **Keep** | 자동화 sub-app `pricing.ts` 와 동일 로직 분산 → 통합 권장 |
| 5 | 마켓 가격 변경 (Push) | `PUT /api/products/{platform}/:id` ([api.js:1266~1449](../src/web/routes/api.js#L1266)) + `autoRepricer.js` | **Keep** | 5개 플랫폼 (eBay/Shopify/Naver/Alibaba/Shopee) 개별 라우트 존재 |
| 6 | 마켓 재고 변경 (Push) | (미확인) — `operations/inventory` GET 만 명확 | **확인 필요** | 재고 push 엔드포인트 검색 필요. MCP 도구 (`naver_update_stock` 등) 와 별개로 Express 측 push 경로 모호 |
| 7 | 배송 접수 / 캐리어 분기 | `orderSync.js` + `shippingRates.js` + `carrierSheets.js` | **Modify** | 시트 의존 + EU 자동배정 룰 하드코딩. Sheets quota 이슈 별건 |
| 8 | 라벨 생성 (FedEx / 우체국) | `fedexAPI.js` + `koreaPostAPI.js` + [api.js:3416 (FedEx)](../src/web/routes/api.js#L3416) + [api.js:3549 (KoreaPost)](../src/web/routes/api.js#L3549) | **Modify** | FedEx 동작 가능. 우체국 `regData` 해시 미구현 (스켈레톤) |
| 9 | 송장/추적 | `b2b_shipments` + `order_fedex_labels` ([035, 037 마이그레이션](../supabase/migrations)) | **Keep** | B2B 측 패턴이 우수. C2C 주문에 그대로 이식 가능 |
| 10 | 자동화 로그 | `automation_logs` (005), `agent_audit_logs` (007) + `operations/automation-logs` ([operations.js:504](../src/web/routes/operations.js#L504)) | **Modify** | 로그 채널 둘로 분산. 단일화 + 표준 스키마 권장 |
| 11 | 예외 업무 관리 | `team_tasks` + `task_recipients` + `team_task_attachments` ([008, 009 마이그레이션](../supabase/migrations)) + [tasks.js](../src/web/routes/tasks.js) | **Modify** | **재배치 핵심**. 사람 → 자동화 예외 트리거. §8 참조 |
| 12 | 카톡/텔레 알림 | `notify.js` (iMessage + Telegram) + `sseHub.js` | **Modify** | 카톡 채널 신규 추가. iMessage 는 macOS 전용이라 Railway 환경에서 실효성 (확인 필요) |

### MVP 권장 (4~6주)
- **Phase 0**: SKU 마스터 단일화 + 가격 계산 라이브러리 통합 + 자동화 로그 표준화 (2주).
- **Phase 1**: 자동화 예외 콘솔 (team_tasks 재배치) + 알림 채널 카톡 추가 (1.5주).
- **Phase 2**: FedEx + 우체국 라벨 워크플로우 표준화 + 마켓 재고 push 라우트 정리 (2주).
- **범위 밖 (MVP 후)**: 도매 감시 재정의, AI 추천 표면화, 관리자 승인 워크플로우.

---

## 1. 사용자 기능 인벤토리 (사이드바 기준)

출처: [public/index.html:537-598](../public/index.html#L537). 7개 그룹 × 약 36개 메뉴 항목.

### 1-A. 업무 관리 (16개 항목)

| 메뉴 | 페이지 키 | 핵심 파일 | WMS 분류 | 메모 |
|---|---|---|---|---|
| 📋 업무 지시 | `tasks` | [public/js/tasks.js](../public/js/tasks.js) + [tasks.js](../src/web/routes/tasks.js) | **Modify** | 예외 콘솔 핵심 자산 (§8) |
| 🛒 발주 관리 | `orders` | [public/js/orders.js](../public/js/orders.js) + [purchaseRequests.js](../src/web/routes/purchaseRequests.js) | Keep | 사내 발주 신청/승인 흐름. 매입 자동화와 결합 가능 |
| ⏰ 출퇴근 | `attendance` | [attendance.js](../src/web/routes/attendance.js) | Keep | WMS 와 직접 관련 없으나 업무 시스템 유지 |
| 💰 급여 요약 | `payroll` (admin only) | [payroll.js](../src/web/routes/payroll.js) | Keep | WMS 외 |
| 🗓️ 주간 업무 | `weekly` | [weeklyPlans.js](../src/web/routes/weeklyPlans.js) + [weeklyMeetings.js](../src/web/routes/weeklyMeetings.js) | Keep | WMS 외 |
| 💬 CS 지원 | `cs` | [cs.js](../src/web/routes/cs.js) | Keep | 템플릿 기반 응대. 마켓 메시징과 분리됨 |
| 📁 자료실 | `resources` | [resources.js](../src/web/routes/resources.js) | Keep | 사내 파일/Google Drive 동기화 |
| 📦 재고 실사 | `stocktake` | [stocktake.js](../src/web/routes/stocktake.js) + [public/js/stocktake.js](../public/js/stocktake.js) | **Keep** | WMS 의 핵심. 운영 재고 데이터와 통합 (이미 진행) |
| 💸 지출 관리 | `expenses` | [expenses.js](../src/web/routes/expenses.js) (16 endpoints) | Keep | 추정: WMS 와 약결합 (재무) |
| 📄 B2B 인보이스 | `b2b` | [api.js:3766+](../src/web/routes/api.js#L3766) | **Keep** | 라벨/송장 패턴 우수 → C2C 에 이식 |
| 🎯 경쟁업체 | `competitors` | [competitors.js](../src/web/routes/competitors.js) | Modify | "도매 감시"로 재해석 가능 (§7) |
| 📋 리드 리스트업 | `prospects-list` | [prospects.js](../src/web/routes/prospects.js) | Keep | B2B 영업 |
| 💬 활성 리드 | `prospects-active` | 동상 | Keep | 동상 |
| 💬 피드백 | `feedback` | [feedback.js](../src/web/routes/feedback.js) | Keep | 사내 의견 수렴 |
| 📝 내 워크스페이스 | `workspace` | [workspace.js](../src/web/routes/workspace.js) | Keep | 개인 todo |
| 👥 직원 관리 | `staff-admin` (admin only) | [users.js](../src/web/routes/users.js) | Keep | 권한·계정 |

### 1-B. 상품 관리 (5개)
| 메뉴 | 페이지 키 | 파일 | WMS 분류 |
|---|---|---|---|
| 대시보드 | `dashboard` | [dashboard.js](../public/js/dashboard.js) | Modify |
| 📗 카탈로그 가격 | `catalog` | [catalog.js](../src/web/routes/catalog.js) | Keep — Google Sheets 기반 |
| 전체 상품 | `products` | api.js GET /products | Modify — SKU 마스터 통합 대상 |
| AI 리메이커 | `remarker` | [api.js:2854+](../src/web/routes/api.js#L2854) | Keep |
| 상세페이지 재구성 | `reconstruct` | api.js (extract/upload) | Keep |
| 썸네일 만들기 | `thumbnail` | (확인 필요) | Keep |

### 1-C. 배송 (1개)
| 배송 관리 | `shipping` | dashboard.js (shipping page) + [orderSync.js](../src/services/orderSync.js) + [shippingRates.js](../src/services/shippingRates.js) | **Modify** | OMS/WMS 핵심 |

### 1-D. 분석 (6개)
| 메뉴 | 분류 | 비고 |
|---|---|---|
| 전투 상황판 (`battle`) | Modify | 셀러 경쟁 모니터링. "도매 감시" 와 다름 |
| 매출/마진 분석 (`analysis`) | Keep | api.js:521-648 |
| eBay 트렌드 (`ebay-trends`) | Keep | |
| 이상 탐지 (`anomalies`) | Keep | |
| SKU 점수 관리 (`sku-scores`) | **Keep** | api.js:1765-2008. WMS 의 SKU 라이프사이클과 정합 |
| 효자상품 TOP (`top`) | Keep | |

### 1-E. 플랫폼 (5개) — 마켓 단위 진입점
| Shopify / eBay / 네이버 / Alibaba / Shopee | Keep | 각 마켓별 데이터 페이지 |

### 1-F. 자동화 (2개)
| 메뉴 | 위치 | 분류 |
|---|---|---|
| 리스팅 자동화 ↗ (외부 링크) | `https://ccorea-auto-production-1540.up.railway.app` | **Modify** — 별도 Railway 서비스. 통합 또는 인증 SSO 필요 (확인 필요) |
| 크롤링 결과 (`crawl-results`) | (확인 필요 — 라우트 명시적으로 못 찾음) | Modify |

### 1-G. 운영 관리 (5개) — 가장 WMS 친화적인 그룹
출처: [operations.js](../src/web/routes/operations.js) (17 endpoints)

| 메뉴 | endpoint | WMS 매핑 |
|---|---|---|
| 상품 검색/관리 (`ops-products`) | GET/PATCH/DELETE/POST `/operations/products` | **Keep** — SKU 마스터 표면화 |
| 재고 관리 (`ops-inventory`) | GET `/inventory`, PUT `/inventory/:productId` | **Keep** — WMS 재고 표면 |
| 가격 관리 (`ops-pricing`) | GET `/pricing`, POST `/pricing/bulk-update`, PUT `/pricing/cost` | **Keep** — 가격 일괄 조정 |
| 수익 분석 (`ops-profit`) | GET `/profit` | Keep |
| 자동화 로그 (`ops-logs`) | GET/POST `/automation-logs` | **Keep** — 예외 콘솔 입력원 |

추정: 사장님이 신규 운영 메뉴를 사이드바 하단에 별도 그룹으로 분리한 것은 "기존 메뉴 ↔ 신 운영 자동화"의 점진적 마이그레이션 의도로 보임. WMS 의 출발점이 이 그룹.

### 1-H. 시스템 (3개)
| 동기화 (`sync`) / 설정 (`settings`) / 상품 내보내기 (`export`) | Keep | |

---

## 2. DB 스키마 인벤토리

### 2-A. 메인 앱 (Supabase, 37개 마이그레이션)
출처: [supabase/migrations/001~037](../supabase/migrations/).

#### 사용자/감사 (2)
| 테이블 | 도입 마이그레이션 | 용도 | WMS |
|---|---|---|---|
| `users` | 008 | 직원/사장 계정. role + can_manage_finance | Keep |
| `audit_logs` | (확인 필요 — 마이그레이션 명 직접 검색 필요) | 감사 로그 | Keep |

#### 상품/SKU (8~9)
| products | 001 | 마스터 상품 (SKU 단일 진실 후보) | **Keep — 핵심** |
| product_images | (002 시리즈) | 이미지 메타 | Keep |
| platform_listings | (002 시리즈) | 마켓별 리스팅 (item_id, sku, 가격, sales_count) | Keep |
| platform_mapping | 004 | 플랫폼 카테고리 매핑 | Keep |
| platform_export_status | 004 | 내보내기 상태 | Keep |
| translations | 004 | 번역 결과 | Keep |
| sku_scores | 001 | SKU 점수 | Keep |
| sku_score_history | 001 | 점수 변동 이력 | Keep |
| `ebay_products`, `shopify_products`, `naver_products`, `alibaba_products` | 001 | 추정: 초기 단순 미러 테이블. 사용 안 됨 가능 (확인 필요) | **Remove 후보** |

#### 플랫폼/가격 (6)
| platforms | 004 | 마켓 메타 | Keep |
| margin_settings | 004 | 마진 룰 | Keep |
| pricing_settings | (확인 필요) | 가격 설정 | Keep |
| price_history | 002_part3 | 가격 변경 이력 | Keep |
| price_change_log | (확인 필요) | 가격 변경 audit | Keep |
| repricing_rules | (확인 필요) | 자동 재가격 룰 | Keep |

#### 주문 (2)
| orders | 001 | 주문 단일 테이블 (eBay/Shopify) | **Keep — 핵심** |
| order_fedex_labels | 037 | FedEx 라벨 메타 (최신) | Keep |

#### B2B (5)
| b2b_buyers | 001 | 거래처 | Keep |
| b2b_invoices | 001 | 인보이스 (void 컬럼 025, manual 033) | Keep |
| b2b_shipments | 026 | B2B 송장 + FedEx 라벨 | **Keep — C2C 라벨 패턴 모범** |
| b2b_leads | 008 | 리드 | Keep |
| email_outreach | 008 | 이메일 발송 이력 | Keep |

#### 지출 (5)
| expenses | 013 | | Keep |
| recurring_payments | (확인 필요) | | Keep |
| expense_category_rules | (확인 필요) | | Keep |
| inventory_purchases | 017 | 매입 입고 | **Keep — WMS 입고와 직결** |
| expense_receipts | 016 → 036 (재정의) | 영수증 첨부 | Keep |

#### 재고/배송 (3)
| inventory | 005 | 재고 수량 | **Keep — WMS 핵심** |
| stock_adjustments | 030 | 재고 실사 차이 | **Keep — WMS 핵심** |
| shipping_rates | (확인 필요) | 캐리어/무게별 단가 | Keep |
| automation_logs | 005 | 자동화 실행 로그 | **Modify** — agent_audit_logs 와 통합 |

#### 업무관리/협업 (5+)
| tasks (legacy) | 008 | 초기 업무 테이블. 추정: 미사용. team_tasks 로 대체 | **Remove 후보** |
| team_tasks + task_recipients | (확인 필요 — 008/009?) | 사람용 업무 카드 | **Modify — 예외 콘솔로 재배치 (§8)** |
| team_task_attachments | 009 | 첨부 | Modify |
| notifications | (확인 필요) | DB 알림 큐 | Keep |
| feedback | 011 | 사내 피드백 | Keep |
| workspace_todos | 012 | 개인 todo | Keep |
| weekly_plans | 020 | 주간 계획 | Keep |
| cs_templates | 021 | CS 응대 템플릿 | Keep |
| resources | 022 | 자료실 | Keep |
| weekly_meetings | 023 | 주간회의 | Keep |
| purchase_requests + purchase_request_attachments | (010, 024) | 사내 발주 | Keep |

#### Agent / AI (4)
| agent_recommendations | 007 | AI 추천 | Modify — 예외 콘솔 입력원 |
| agent_alerts | 007 | AI 경고 | Modify — 예외 콘솔 입력원 |
| agent_audit_logs | 007 | AI 액션 감사 | Modify |
| platform_messages | 008 | 마켓 메시지 | Keep |

#### 경쟁사 / 트렌드 / 시스템 (5+)
| competitors | 028 | 경쟁사 (전투 상황판) | Modify — "도매 감시"로 재해석 |
| competitor_prices | (확인 필요) | 경쟁가 시계열 | Modify |
| keyword_trends | 008 | 검색 트렌드 | Keep |
| sync_history | 002_part3 | 동기화 이력 | Keep |
| prospects | 029 | 영업 리드 | Keep |
| shared_uploads | 031 | 공용 업로드 | Keep |

추정: 마이그레이션 037 까지 누적 → 약 50~55 테이블. 정확한 카운트는 `\dt` 결과 필요 (확인 필요).

### 2-B. 자동화 sub-app (별도 Drizzle ORM)
출처: [automation/src/db/schema.ts](../automation/src/db/schema.ts).

| 테이블 (line) | 용도 | 메인 앱 중복 여부 |
|---|---|---|
| `crawl_sources` (19) | 크롤 대상 사이트 | 신규 |
| `crawl_results` (33) | 크롤 결과 (raw) | 신규 |
| `products` (58) | 상품 마스터 | **메인 앱 `products` 와 중복** |
| `product_images` (87) | 이미지 | **중복** |
| `platform_listings` (101) | 마켓 리스팅 | **중복** |
| `shipping_rates` (127) | 배송비 | **중복** |
| `pricing_settings` (140) | 가격 설정 | **중복** |
| `csv_uploads` (154) | CSV 업로드 잡 | 신규 |
| `upload_jobs` (177) | 업로드 작업 | 신규 |
| `platform_tokens` (201) | OAuth 토큰 | (확인 필요) |
| `category_cache` (214) | 카테고리 캐시 | 신규 |
| `description_settings` (228) | 상세설명 템플릿 | 신규 |
| `users` (238) | 별도 인증? | **중복 — 통합 필요** |
| `audit_logs` (252) | 별도 감사 | **중복** |

**핵심 위험 (확인 필요)**: 메인 앱과 자동화 sub-app 이 같은 Supabase DB 의 동일 이름 테이블을 공유하는지, 아니면 별도 DB 인지. 같은 DB 라면 schema 가 동기 어긋남(drift) 위험.

---

## 3. 백엔드 API 인벤토리

총 27개 라우트 파일 + 자동화 sub-app 라우트.

### 3-A. 메인 라우트 (27개 파일)
출처: `src/web/routes/*.js`. 엔드포인트 수치는 `grep router.(get|post|...)` 카운트.

| 파일 | endpoints | 핵심 책임 | WMS 분류 |
|---|---|---|---|
| **api.js** | **151개 (가장 큼)** | dashboard / sync / products / sku-scores / battle / repricer / remarker / orders / fedex / koreaPost / b2b | **Modify — 분리 필요** |
| operations.js | 17 | ops-products, ops-inventory, ops-pricing, ops-profit, automation-logs | **Keep — WMS 진입점** |
| expenses.js | 16 | 지출, 영수증 (multi) | Keep |
| tasks.js | 7 | team_tasks CRUD + 첨부 | **Modify — 예외 콘솔로 재배치** |
| purchaseRequests.js | 12 | 사내 발주 + 첨부 | Keep |
| resources.js | 12 | 자료실 + Google Drive | Keep |
| workspace.js | 11 | 개인 todo + workspace | Keep |
| prospects.js | 11 | 영업 리드 | Keep |
| stocktake.js | 7 | 재고 실사 | **Keep — WMS 핵심** |
| inventoryPurchases.js | 9 | 매입 입고 | **Keep — WMS 핵심** |
| feedback.js | 7 | 사내 피드백 | Keep |
| competitors.js | 7 | 경쟁사 CRUD | Modify |
| weeklyMeetings.js | 7 | 주간회의 | Keep |
| weeklyPlans.js | 6 | 주간계획 + KPI | Keep |
| recurring.js | 7 | 정기지출 | Keep |
| cs.js | 7 | CS 템플릿 | Keep |
| catalog.js | 5 | 카탈로그 가격 (Sheets) | Keep |
| notifications.js | 6 | 알림 트리거/조회 | Keep |
| attendance.js | 6 | 출퇴근 | Keep |
| accio.js | 4 | accio API (이미지 생성) | Keep |
| users.js | 4 | 직원 CRUD | Keep |
| platformSync.js | 4 | naver/shopee/alibaba sync 트리거 | Keep |
| events.js | 2 | SSE stream | **Keep — 핵심** |
| payroll.js | 3 | 급여 | Keep |
| bonuses.js | 2 | 보너스 | Keep |
| finance.js | 1 | 재무 요약 | Keep |
| health.js | 1 | 헬스체크 | Keep |

### 3-B. api.js 내부 그룹 (151 endpoints)
큰 파일이므로 그룹화 (라인 인용):

| 그룹 | 라인 범위 | 분류 |
|---|---|---|
| Dashboard / sync / products | 115~245 | Keep |
| Sync trigger | 245~347 | Keep |
| Revenue / analysis | 347~648 | Keep |
| ebay trends / anomalies | 456~841 | Keep |
| Image upload / product register | 863~1052 | Keep |
| CSV import / preview | 992~1117 | Keep |
| Master products CRUD | 1117~1266 | **Modify — SKU 마스터 통합 진입점** |
| Per-platform price update (eBay/Shopify/Naver/Alibaba/Shopee) | 1266~1449 | **Keep — 마켓 가격 push** |
| SKU scores | 1765~2008 | Keep |
| Battle (전투 상황판) | 2008~2854 | **Modify — 도매 감시 재해석** |
| Repricer | 2564~2593 | Keep |
| Remarker / images / templates | 2854~3083 | Keep |
| Remarker register | 3083~3182 | Keep |
| Orders sync / carrier / shipping estimate | 3182~3416 | **Modify — WMS 핵심** |
| **FedEx label (POST/GET)** | 3416~3549 | **Keep** |
| **Korea Post label / track** | 3549~3652 | **Modify — regData hash 미구현** |
| Orders backfill / weight | 3652~3766 | Keep |
| **B2B (buyers / invoices / shipments / labels)** | 3766~end | **Keep — 라벨 패턴 모범** |

### 3-C. 자동화 sub-app 라우트
출처: `automation/src/routes/*.ts`. (확인 필요 — 라우트 시그니처 grep 결과 없음. Fastify 등록 방식 확인 필요)

추정: products / settings / crawl 으로 구성.

---

## 4. 프론트엔드 인벤토리

### 4-A. 모듈 분리된 페이지 (18개)
출처: `public/js/*.js`.

| 파일 | 책임 | 분류 |
|---|---|---|
| **dashboard.js** | 메인 대시보드 + 다수 페이지 (10000+ 라인 추정) | **Modify — 분할 필요** |
| tasks.js | 업무 카드 UI | Modify |
| orders.js | 발주 관리 UI | Keep |
| attendance.js | 출퇴근 UI | Keep |
| catalog.js | 카탈로그 가격 UI | Keep |
| competitors.js | 경쟁사 UI | Modify |
| cs.js | CS 템플릿 UI | Keep |
| expenses.js | 지출 UI | Keep |
| feedback.js | 피드백 UI | Keep |
| operations.js | 운영 관리 5개 메뉴 | **Keep — WMS 표면** |
| payroll.js | 급여 UI | Keep |
| prospectsActive.js / prospectsList.js | 영업 리드 | Keep |
| resources.js | 자료실 | Keep |
| staff-admin.js | 직원 관리 | Keep |
| stocktake.js | 재고 실사 UI | Keep |
| weekly.js | 주간 업무 UI | Keep |
| workspace.js | 개인 워크스페이스 UI | Keep |

### 4-B. WMS 신규 화면 후보
- 자동화 예외 콘솔 (team_tasks UI 확장. §8)
- 라벨 일괄 발급 인터페이스 (b2b 의 fedex 모달 패턴 차용)
- SKU 마스터 단일 페이지 (현재 `products` + `master-products` + `ops-products` 3중 분산 → 통합)

### 4-C. dashboard.js 분할 필요
**사실**: dashboard.js 가 다수 화면 로직을 단일 파일에 담고 있음 (battle, shipping, ebay-trends 등). 추정: 1만 라인 이상. 마이그레이션 시 화면별 모듈 분리가 사이드 이펙트 위험을 줄임.

---

## 5. 인증/권한 구조

출처: [src/middleware/auth.js](../src/middleware/auth.js)

### 5-A. 로그인 모드 (Dual)
1. **유저 로그인**: `users` 테이블 + bcrypt. role = `admin` | `staff`. 세션 토큰 = `userId.timestamp.hmac`.
2. **레거시 로그인**: `DASHBOARD_PASSWORD` 환경변수. userId=0 의사 admin (`__legacy_admin__`). 토큰 = `timestamp.hmac` (2파트).

### 5-B. 권한 가드
| 가드 | 의미 | 적용 |
|---|---|---|
| `authGuard` (auth.js:158) | 로그인 필수, req.user 주입 | 글로벌 |
| `requireAdmin` (auth.js:199) | role=admin | payroll/users/admin/notifications trigger 등 |
| `requireFinanceAccess` (auth.js:206) | admin 또는 can_manage_finance | 지출/매입 라우트 |
| `blockLegacyWrites` (auth.js:229) | userId=0 은 GET 만 허용 | tasks/purchase-requests/attendance/payroll/bonuses/feedback/users/admin/notifications |

### 5-C. WMS 에서 필요한 추가 권한 (제안)
- `requireOperator` — 라벨 발급 / 가격 push 권한 (현재 명시적 가드 없음. 확인 필요)
- `requireApprover` — 가격 변경 임계치 초과 시 승인 (없음. 신규)
- `requireAccount` — 마켓별 계정 단위 권한 (현 user.platform 필드는 존재하지만 가드는 미구현 추정)

### 5-D. 보안 항목
- COOKIE_SECRET 미설정 시 랜덤 생성 + 재시작 시 세션 무효 (auth.js:58-60).
- 세션 만료 7일 (auth.js:34).
- httpOnly + secure(prod) + sameSite=lax (auth.js:108-115).
- **확인 필요**: 메모리에 따르면 과거 DB 비밀번호가 채팅에 노출된 이력. 회전 여부 확인 필요.

---

## 6. 알림/실시간 구조

### 6-A. SSE 허브
출처: [src/services/sseHub.js](../src/services/sseHub.js)

- 자료구조: `Map<userId, Set<ServerResponse>>` — 동일 유저 다중 탭 지원.
- 메서드: `register / unregister / sendTo / sendToMany / stats`.
- 페이로드 포맷: `data: ${JSON}\n\n` (SSE 표준).
- 라우트: `GET /api/events/stream` ([events.js:10](../src/web/routes/events.js#L10)).

### 6-B. 알림 채널 라우터
출처: [src/services/notify.js](../src/services/notify.js)

```
notify.send(text)
  ├─ if imessage.isConfigured() → imessage.sendMessage   (macOS only)
  └─ if telegram.isConfigured() → telegram.sendMessage
```
**확인 필요**: Railway (Linux) 배포에서 iMessage 채널은 동작 불가. 사용자는 사내 Mac 미니 등에서 별도 노드를 돌리지 않는 한 무력. → 카톡 채널 추가가 WMS 알림 신뢰도를 위해 필수.

### 6-C. 통합 NotificationService
출처: `src/services/notificationService.js` (메서드: `notify`, `notifyMany`, `notifyAdmins`, `getStaffIds`, `getAdminIds`).

- DB 알림 (`notifications` 테이블) + SSE + 멀티채널 발송을 단일 함수에 묶음.
- tasks.js:122-133 가 모범 예: 카드 생성 → DB 알림 → SSE 이벤트 → 멀티채널.

### 6-D. SSE 이벤트 타입 (현 사용 중)
**사실** (코드 직접 확인):
- `task_assigned` (tasks.js:103)
- `task_completed` (tasks.js:208 — notifyAdmins 페이로드.type)

**추정**: `purchase_*`, `expense_created` 등 — 메모리 요약에 등장. 실제 로드 시 grep 필요.

### 6-E. 스케줄 알림
출처: [src/services/scheduler.js](../src/services/scheduler.js). **9개 cron 등록 (확인됨)**:

| 시각 (Asia/Seoul) | 작업 | 라인 |
|---|---|---|
| 09:00 | 모닝 다이제스트 | scheduler.js:113 |
| 09:05 | (확인 필요 — B2B 리마인더?) | scheduler.js:118 |
| 17:00 | 사장 미완료 요약 | scheduler.js:128 |
| 04:00 | (확인 필요) | scheduler.js:133 |
| 10:00 / 22:00 | (확인 필요) | scheduler.js:150 |
| 10:00 / 18:00 | (확인 필요) | scheduler.js:161 |
| 02:30 | (확인 필요) | scheduler.js:174 |
| 03:00 | (확인 필요) | scheduler.js:186 |
| 03:30 | (확인 필요) | scheduler.js:206 |

추정: 9개 모두 적극 동작 중. 정확한 라벨은 함수명 grep 으로 식별 가능.

### 6-F. WMS 신규 이벤트 타입 (제안)
- `sku_mapping_failed` (자동 listing 시도 실패)
- `price_drift_detected` (도매 가격 변동)
- `label_failed` (캐리어 API 응답 실패)
- `inventory_low` (재고 임계치)
- `stock_adjusted` (재고 실사 차이)

---

## 7. 외부 통합

### 7-A. 마켓 API (10개 파일)
출처: `src/api/`.

| 파일 | 마켓 | 동작 (확인 필요한 항목 포함) |
|---|---|---|
| ebayAPI.js | eBay | Trading + Browse + Shopping |
| shopifyAPI.js | Shopify | Admin GraphQL |
| naverAPI.js | 네이버 스마트스토어 | OAuth |
| coupangAPI.js | 쿠팡 | (확인 필요) |
| qoo10API.js | Qoo10 | (확인 필요) |
| alibabaAPI.js | Alibaba ICBU | (확인 필요) |
| shopeeAPI.js | Shopee | (확인 필요) |

**확인 필요**: 11번가 / G마켓 / Cafe24 미존재. 사장님이 필요하다면 Phase 4.

### 7-B. 물류 API
| 파일 | 상태 |
|---|---|
| fedexAPI.js | OAuth client_credentials. B2B 에서 동작 중. C2C 에 신규 라우트 추가됨 ([api.js:3416](../src/web/routes/api.js#L3416)) |
| koreaPostAPI.js | 종추적/요금조회는 매뉴얼 반영 (`biz.epost.go.kr`). 소포신청 = `regData` 해시 미구현 (스텁) |

### 7-C. Google
| 모듈 | 용도 | 메모 |
|---|---|---|
| googleSheetsAPI.js | 카탈로그 가격 + 배송 시트 + EU 자동배정 | Railway 배포 후 `GOOGLE_CREDENTIALS_JSON` env fallback 적용됨 (확인 필요 — 메모리 기록) |
| googleDriveAPI.js | 자료실 동기화 | 동상 env fallback |

### 7-D. 자동화 sub-app
- 위치: `/automation/` (Fastify + Drizzle).
- 별도 Railway 서비스: `ccorea-auto-production-1540.up.railway.app`.
- 크롤러: Patchright (Playwright fork) — `automation/CLAUDE.md` 에 운영 룰 명시.

### 7-E. MCP 도구 (별 트랙)
사장님 환경에 MCP 서버 다수 등록되어 있음 (alibaba/coupang/dashboard/ebay/naver/qoo10/shopee/shopify). **Express 라우트 ↔ MCP 도구는 별 채널** — WMS 자동화의 어느 측에서 마켓 push 를 호출할지 결정 필요. 추정: 사람이 Claude 와 작업하는 컨텍스트는 MCP, 시스템 백그라운드는 Express 라우트.

---

## 8. 가설 검증: "업무관리 → 자동화 예외처리 콘솔"

### 8-A. 현 team_tasks 시스템의 자산
출처: [tasks.js](../src/web/routes/tasks.js) + 관련 마이그레이션.

| 자산 | 현 사용 | 예외 콘솔 매핑 |
|---|---|---|
| `team_tasks` 테이블 | 사람이 만든 업무 카드 | 자동화 예외 카드 (트리거가 자동) |
| `task_recipients` | 다대일 배정 (specific / all) | 자동 라우팅 (예외 종류 → 담당 직원 매트릭스) |
| `team_task_attachments` | 직원이 완료 시 PDF/이미지 업로드 | **증빙** (라벨 PDF, 송장, 마켓 거절 응답 캡처) |
| `priority` (normal/urgent) | 사장 수동 지정 | 자동 (예외 종류별 SLA) |
| `status` (pending/in_progress/done) | 사람 운영 | 동일 사용 가능 |
| `completion_note` (필수 코멘트) | 직원 완료 시 입력 | **처리 이력** (어떻게 해결했는지) |
| `notify` 함수 (DB + SSE + 멀티채널) | 카드 생성/완료 알림 | **그대로 사용** |
| `due_date` | 사장 수동 | 자동 (SLA 기반) |

### 8-B. 매핑표 (1:1)
| WMS 예외 콘솔 개념 | team_tasks 필드 | 행위자 |
|---|---|---|
| 예외 종류 (enum) | `priority` 또는 신규 `exception_type` 컬럼 | 자동화 |
| 발생 컨텍스트 | `memo` (JSON 추정) 또는 `relatedType/relatedId` (notifications 테이블 참조) | 자동화 |
| 담당자 | `assignee_id` | 라우팅 룰 |
| 처리 상태 | `status` | 직원 |
| 처리 이력 | `completion_note` | 직원 |
| 증빙 | `team_task_attachments` | 직원 |
| 알림 | `notify()` + `sseHub.sendTo()` | 자동 |

### 8-C. Modify 포인트 (실제 변경 항목)
1. **신규 컬럼** `team_tasks.exception_type TEXT`, `team_tasks.context JSONB`, `team_tasks.auto_generated BOOLEAN DEFAULT false`. (기존 사람 카드와 공존)
2. **자동 생성 트리거** 위치 (Modify 가 아닌 Create — 신규 호출):
   - `listing-service.ts` 등록 실패 시 → `createTask({ exception_type: 'listing_failed', ... })`
   - `autoRepricer.js` 가격 룰 충돌 시
   - `fedexAPI.js` / `koreaPostAPI.js` 라벨 실패 시
   - `competitorMonitor.js` 임계치 초과 시
   - `orderSync.js` 캐리어 매핑 실패 시
3. **라우팅 룰** 신규 (예: `exception_type → assignee_id` 매트릭스). 추정: 단순 표 + admin UI 1개.
4. **UI 변경**: tasks 페이지에 "예외 카드" 필터 (auto_generated=true). 기존 사람 카드와 동일 카드 형태 유지.
5. **알림 채널 카톡 추가**: notify.js 에 `kakao` 분기 추가. iMessage 가 macOS 전용이므로 Railway 환경 신뢰도 보강.

### 8-D. 재사용 가능 비율 (추정)
- DB: 약 **70%** (team_tasks/task_recipients/attachments 그대로 + 컬럼 3개 추가).
- 백엔드: 약 **60%** (tasks.js 라우트는 거의 그대로. 자동 생성 트리거 코드는 신규).
- 프론트: 약 **80%** (UI 컴포넌트 재사용. 필터/뱃지만 추가).
- 알림: 약 **90%** (notify + SSE + 스케줄러). 카톡 추가가 가장 큰 작업.

**전체 재사용 평균 75%** (추정). 이 가설을 가장 강하게 지지하는 사실:
- tasks.js 가 이미 SSE+DB알림+멀티채널 발송을 한 함수에서 처리 (tasks.js:113-133).
- attachments 가 이미 Supabase Storage 시그니처 URL 패턴으로 구현됨 (tasks.js:310-329) → 라벨 PDF 그대로 첨부 가능.
- recipient 분기 로직 (specific/all) 이 그대로 자동 라우팅 룰에 1:1 매핑됨.

### 8-E. 위험
- **사장님이 직접 만든 사람 업무 카드와 자동 카드의 시각적 혼선**: `auto_generated` 필터 + 색상 구분 필요.
- **블랙홀 위험**: 자동 카드가 늘어나면 사람이 수동으로 닫아야 함. SLA 초과 시 자동 escalate (admin 에게 재알림) 룰 필요.
- **알림 폭주**: 동일 SKU 의 listing 실패가 매 sync 마다 카드 생성되면 안 됨. 중복 억제 (1일 1회 등) 룰 필요.

---

## 9. 기술 부채 / 위험

### 9-A. 사이드 이펙트 위험 영역

| 영역 | 위험 | 마이그레이션 시 |
|---|---|---|
| **dashboard.js (10000+ 라인 추정)** | 모든 화면 로직 한 파일. 수정 시 다른 화면 깨질 수 있음 | 화면별 모듈 분리부터 |
| **api.js (151 endpoints, 4500+ 라인 추정)** | 단일 파일이 dashboard / battle / repricer / fedex / koreaPost / b2b 까지 다 가짐 | 파일 분할 (예: `routes/orders.js`, `routes/labels.js`, `routes/battle.js`) |
| **Sheets ↔ Supabase 이중 저장** | 카탈로그 가격은 Sheets, 주문은 Supabase + Sheets. 동기 어긋남 | Sheets 의 권위(authority) 영역 명확화. Quota 이슈 (확인 필요) |
| **Dual-mode 인증** | `userId=0` 레거시 admin 코드 분기가 곳곳 | WMS 출시 전 레거시 종료 (DASHBOARD_PASSWORD 제거) |
| **자동화 sub-app 별도 DB 스키마** | `automation/src/db/schema.ts` 와 메인 앱 `products` 가 동시에 존재 | 같은 DB 인지 확인. 다르면 동기 메커니즘 필요. 같다면 schema source-of-truth 결정 |
| **plain-table-mirror (ebay_products 등)** | 001 마이그레이션의 마켓별 테이블이 platform_listings 와 중복. 사용 여부 미상 | 정리 또는 Remove |

### 9-B. 보안 / 운영
- **DB 비밀번호 채팅 노출 이력** (메모리 기록). 회전 필요. (확인 필요 — 회전했는지)
- **iMessage 채널** Railway (Linux) 에서 무력. 카톡으로 대체.
- **COOKIE_SECRET 미설정 시 랜덤** — 재시작 시 모든 세션 무효 (운영 영향). 명시적 설정 필수.
- **Korea Post `regData` 해시 미구현** — 소포신청 API 호출 시 401 또는 해시 검증 실패 가능 (확인 필요. 메모리 기록).

### 9-C. 마이그레이션 우선 청산 대상
1. 자동화 sub-app DB 스키마 일치성 (메인 앱과 같은 DB 라면 즉시).
2. dashboard.js 의 page-shipping / page-battle / page-orders 분할 (라벨/예외 콘솔 작업 전제).
3. legacy admin 모드 종료 (사장님 본인 user 계정 안정화 후).
4. 마켓별 mirror 테이블 (ebay_products 등) 사용 여부 확인 + Remove 결정.
5. expense_receipts 마이그레이션 016 vs 036 — 어느 것이 source-of-truth 인지 (확인 필요).

---

## 10. 단계별 마이그레이션 플랜

### Phase 0 — 정리 (1~2주)
**목표**: 이중성 제거. WMS 작업 전 사이드 이펙트 위험 최소화.

| 작업 | 파일 | 노력 | 위험 |
|---|---|---|---|
| 자동화 sub-app DB 스키마 source-of-truth 결정 | automation/src/db/schema.ts vs supabase/migrations/ | M | 데이터 손실 위험 (백업 필수) |
| 마켓별 mirror 테이블 사용 여부 분석 | 001_create_tables.sql | S | 없음 (read-only 분석) |
| dashboard.js 화면별 분할 | public/js/dashboard.js → 화면별 *.js | L | 회귀 다발 |
| api.js 분할 (orders, labels, battle, repricer) | src/web/routes/api.js | L | 회귀 다발 |
| 환경변수 통합 (GOOGLE_CREDENTIALS_JSON, COOKIE_SECRET, DATABASE_URL) | Railway settings | S | 없음 |
| 마이그레이션 037 적용 + Supabase shipping-labels 버킷 생성 | supabase | S | 없음 |

### Phase 1 — SKU 마스터 + 가격 라이브러리 통합 (2~3주)
**목표**: 단일 진실. 모든 가격 계산 한 곳에서.

| 작업 | 파일 | 노력 |
|---|---|---|
| products 테이블 단일화 (메인 앱 vs sub-app) | DB | M |
| pricing 라이브러리 통합 (`pricingEngine.js` ↔ `automation/src/services/pricing.ts`) | src/services + automation/src/services | M |
| operations.js 의 `/products` `/pricing` `/inventory` 를 SKU 마스터 표면으로 재배치 | operations.js | M |
| 마켓 가격 push 일괄 변경 UI (5개 플랫폼 동시) | dashboard.js + api.js | M |

### Phase 2 — 자동화 예외 콘솔 (team_tasks 재배치) (2주)
**목표**: 가설 검증. 시스템이 만든 카드를 직원이 처리.

| 작업 | 파일 | 노력 |
|---|---|---|
| `team_tasks.exception_type / context / auto_generated` 컬럼 추가 마이그레이션 | supabase/migrations/038 | S |
| 자동 생성 트리거 5곳 (listing/repricing/fedex/koreaPost/orderSync) | 각 service 파일 | M |
| 라우팅 룰 표 + admin UI | DB 신규 테이블 + admin 페이지 | M |
| tasks.js UI 필터 (자동/수동) + 색상 구분 | public/js/tasks.js | S |
| **카톡 채널 추가** | src/services/notify.js + 신규 kakaoBot.js | M |
| 중복 억제 / SLA escalate 룰 | scheduler.js | S |

### Phase 3 — 라벨 + 송장 표준화 (2주)
**목표**: 라벨 발급이 사장님 손이 안 가도 도는 상태.

| 작업 | 파일 | 노력 |
|---|---|---|
| FedEx 라이브 견적 + UI 표시 | shippingRates.js + dashboard.js | M |
| Korea Post `regData` 해시 구현 | koreaPostAPI.js | S (샘플 코드 제공받은 후) |
| 라벨 발급 워크플로우 통일 (FedEx + 우체국 동일 모달) | dashboard.js | M |
| 라벨 PDF → team_task_attachments (예외 발생 시 자동 첨부) | tasks.js + label routes | S |
| Sheets quota 이슈 batch write 적용 | orderSync.js + googleSheetsAPI.js | S |
| Shipped 자동 제거 + Supabase status='SHIPPED' | orderSync.js | S |

### Phase 4 — 도매 감시 + 관리자 승인 (선택, 2주+)
**목표**: 매입 가격 자동 추적. 임계 가격 변경 승인.

| 작업 | 노력 |
|---|---|
| 전투 상황판 → 도매 감시 재해석 (셀러/매입처 분리) | M |
| 관리자 승인 워크플로우 (`requireApprover` 가드 + 승인 큐 UI) | M |
| competitorMonitor.js 의 도매 모드 분기 | S |

### MVP 범위 (4~6주, Phase 0+1+2)
- Phase 0 정리 (사이드 이펙트 차단)
- Phase 1 SKU 마스터 단일화
- Phase 2 자동화 예외 콘솔 + 카톡 알림

이 셋만 완료하면 **"WMS 가 자동으로 돌고, 막힐 때만 사람이 본다"** 의 90% 가 가능 (추정).

### 검증 방법
1. **SKU 마스터**: 동일 SKU 의 가격/재고를 어느 진입점에서 보든 동일 값 (`/products`, `/master-products`, `/operations/products`).
2. **예외 콘솔**: listing 자동화 강제 실패 → 카드 자동 생성 → 카톡 알림 → 직원이 완료 표시 → 사장 알림.
3. **라벨**: 새 주문 → FedEx/우체국 라벨 발급 모달 → PDF 출력 → orders.tracking_number 채워짐.
4. **회귀**: 기존 사람 업무 카드 / B2B 인보이스 / 출퇴근 / 지출 흐름 정상 동작.

---

## 부록 A. 사실 vs 추정 마커 모음

### 가장 확실한 사실 (코드/마이그레이션 직접 확인)
- src/web/routes/ 27개 파일, api.js 151 endpoints (grep 결과).
- 인증 dual-mode (auth.js:80-104).
- SSE Map<userId, Set> (sseHub.js:7).
- team_tasks 의 자동 알림 흐름 (tasks.js:113-134).
- 마이그레이션 037 까지 누적 ([supabase/migrations/](../supabase/migrations/)).
- automation sub-app Drizzle 14 테이블 (schema.ts:19-273).
- scheduler.js 9 cron jobs (line 113~206).

### 주요 추정
- Keep/Modify 자산 65~75% 커버.
- team_tasks 재배치 재사용률 75%.
- dashboard.js 10000+ 라인.
- iMessage 가 Railway 에서 무력.

### 확인 필요 (실제 사용/운영 데이터 필요)
- 마켓별 mirror 테이블 (`ebay_products` 등) 실 사용 여부.
- 자동화 sub-app 과 메인 앱 DB 가 같은 인스턴스인지.
- expense_receipts 016 vs 036 source-of-truth.
- 9개 cron 각각의 책임 (scheduler.js 함수명 grep 필요).
- DB 비밀번호 회전 여부.
- Korea Post `regData` 미구현 영향 범위 (호출되는 흐름이 운영 중인지).
- iMessage 채널이 실제로 동작하는 환경이 있는지 (사내 Mac 미니 등).
- crawl-results 페이지가 가는 라우트.
- Shopee/Naver/Coupang/Qoo10 sync 가 주문 통합 수준까지 가는지.
- thumbnail 페이지 라우트 위치.

---

## 부록 B. 다음 액션 후보 (사장님 결정 사항)

| 결정 항목 | 옵션 |
|---|---|
| 자동화 sub-app 통합 여부 | (a) 메인 앱에 합침 (b) 별도 유지 + DB 만 통합 (c) 현 분리 유지 |
| 카톡 채널 도입 시기 | (a) Phase 2 와 함께 (b) Phase 1 부터 (c) MVP 후 |
| 레거시 admin 종료 시점 | (a) Phase 0 에서 (b) MVP 후 (c) 무기한 유지 |
| dashboard.js 분할 우선순위 | (a) 가장 먼저 (b) Phase 1 과 병행 (c) 마지막 |
| 도매 감시 정의 | (a) 셀러 경쟁 그대로 (b) 매입처 가격 추적 신규 (c) 둘 다 분리 운영 |

---

*본 보고서는 분석 전용입니다. 코드/마이그레이션/배포 변경은 일체 수행되지 않았습니다.*
