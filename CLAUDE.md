# CLAUDE.md — 프로젝트 컨텍스트 (Commerce OS / PMC 글로벌관리시스템)

이베이 셀러 글로벌관리시스템. 목표: 신뢰도 기반 가격 자동화 (Commerce OS v1).
배포: GitHub main 푸시 → **Railway 자동 배포** (fly.toml은 잔재 — fly 안 씀). DB: Supabase.

## 핵심 문서 (먼저 읽을 것)

- `docs/commerce-os-data-contract-v1.md` — 데이터 계약 (AUTO/REVIEW/BLOCK 원칙, reason code enum, 게이팅=min(4축 confidence))
- `docs/engine1-execution-plan.md` — Engine 1 실행 계획 + Dry-run GO 기준 (AUTO 정밀도 ≥98% 등)

## Engine 1 (가격) — 현재 상태 (2026-07-09 기준)

| 구성 | 파일 | 상태 |
|---|---|---|
| 판정 엔진 (순수 함수, I/O 없음) | `src/engines/priceEngine.js` | 완료 |
| 이벤트 발행 + BLOCK→팀 태스크 | `src/services/priceEventService.js` | 완료 |
| Dry-run 잡 (가격 변경 절대 안 함) | `src/jobs/engine1DryRunJob.js` | 완료 |
| 스키마 068 (price_events, enum) + 069 (guardrails, suppliers) | `supabase/migrations/` | **프로덕션 적용됨** |
| SKU 원가/무게 CSV 임포트 | `src/web/routes/skuMasterImport.js` + SKU 마스터 화면 버튼 | 완료 |
| sku_master 시딩 스크립트 | `scripts/seed-sku-master-from-ebay.js` | 작성됨 — **실행 대기** |

### 첫 dry-run 결과 (2026-07-09)
`total 928 · AUTO 0 · BLOCK 928 (landing_cost 397 / no_match 531)` — 원인: eBay SKU가 sku_master에 미등록(매칭 0건).

### 다음 할 일 (순서대로)
1. `node scripts/seed-sku-master-from-ebay.js --apply` — ebay_products → sku_master 시딩
2. `node src/jobs/engine1DryRunJob.js` 재실행 → BLOCK 분해 확인
3. SKU 마스터 화면 "미입력 SKU 템플릿" CSV로 원가/무게/치수 입력 (직원 작업)
4. Dry-run 1~2주 → GO 기준 충족 시 `pricing_guardrails.auto_apply_enabled=true`
5. 첫 실행 때 생긴 team_tasks 개별 BLOCK 카드 ~458장 정리 필요 (이후 reason별 1장 집계로 변경됨)

## 절대 규칙 (Data Contract)

- **가격을 직접 바꾸지 않는다.** 모든 판정은 `price_events`에 이벤트로 기록 (append-only). AUTO 실제 적용은 `pricing_guardrails.auto_apply_enabled=true` + `canAutoApply()` 게이트 통과 후에만.
- reason_code는 enum만 사용 (자유텍스트 금지). AUTO도 reason 필수.
- BLOCK = 가격 문제가 아니라 데이터 태스크 (직원 작업 큐로 하향).
- Kill switch: `UPDATE pricing_guardrails SET kill_switch=true WHERE id=1` — 전체 자동적용 즉시 중단.

## 함정 (이미 밟은 것들 — 반복 금지)

- **eBay Shopping API는 서비스 종료** (`open.api.ebay.com` DNS 소멸). `getCompetitorItems`는 Browse API로 전환됨. Shopping API 코드 재사용 금지.
- **Browse API 일일 쿼터 작음** — CompetitorMonitor(2h 주기)가 이미 소비 중. Engine 1은 `LIVE_LOOKUP=false`(캐시) 기본 유지. 대량 라이브 조회 금지.
- sku_master 키는 `internal_sku` = eBay SKU와 동일 네임스페이스로 시딩됨. `product_matches.our_sku`도 같은 값.
- Supabase 마이그레이션은 Railway 배포와 별개 — SQL Editor 또는 `supabase db push`로 수동 적용.
- 프로젝트에 미커밋 작업물이 자주 남아있음 — 커밋 시 `git add <특정 파일>`만, `git add -A` 금지.

## 주요 테이블

`sku_master`(원가/무게/치수, internal_sku) · `ebay_products`(내 리스팅) · `competitor_listings`/`competitor_sellers`(경쟁, 2h 크롤) · `product_matches`(AI 매칭, confidence 0~1) · `price_events`(판정 이벤트 로그) · `pricing_guardrails`(id=1 싱글톤 안전장치) · `team_tasks`(직원 작업 큐) · `repricing_rules`(undercut, min_margin)

Control Tower 뷰: `v_block_task_queue`, `v_price_auto_applied_today`
