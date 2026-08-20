# PMC 프로젝트 에이전트 오케스트레이션 전략

## 개요
Claude Code의 Task(Sub-Agent) 시스템을 활용하여 3계층 구조로 프로젝트를 진행한다.
메인 Claude Code 세션이 Orchestrator 역할을 하며, 필요시 전문 에이전트를 소환한다.

---

## 계층 1: Orchestrator (메인 세션 = 나)

**역할**: 전체 프로젝트 지휘, 진행상황 관리, 품질 게이트 운영

**책임**:
- TodoWrite로 전체 Phase 진행 추적
- Phase 간 의존성 관리 (Phase N 완료 → Phase N+1 시작)
- 각 Phase Agent에 작업 위임 + 결과 검증
- 블로커 발생 시 사용자 에스컬레이션
- PLAN.md 기반 진행률 업데이트

**의사결정 기준**:
| 상황 | 행동 |
|------|------|
| Phase 산출물 테스트 통과 | 다음 Phase로 진행 |
| 테스트 실패 | Phase Agent 재소환하여 수정 |
| 아키텍처 판단 필요 | Architect Agent 소환 |
| 사용자 결정 필요 | AskUserQuestion |

---

## 계층 2: Architect Agent (전체 감시)

**소환 조건**: Phase 간 인터페이스 변경, 스키마 수정, 패턴 일관성 검증 필요 시

**구현**:
```
Task(subagent_type="Plan", model="opus")
```

**책임**:
- 프로젝트 전반의 아키텍처 일관성 감시
- Platform Adapter 패턴 준수 여부 리뷰
- DB 스키마 변경 시 영향도 분석
- Phase 간 인터페이스(타입, API 계약) 호환성 검증
- 기존 zipzip_mvp 코드에서 로직 이전 시 정확성 확인

**소환 시점**:
- Phase 0 완료 후 (스키마 리뷰)
- Phase 2 완료 후 (어댑터 패턴 리뷰)
- Phase 4 완료 후 (Job Queue + 서비스 통합 리뷰)
- 예상 못한 구조 변경 발생 시

---

## 계층 3: Phase Agents (실행자)

### Phase 0 Agent - 프로젝트 초기화
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: PLAN.md의 기술 스택 + 프로젝트 구조
- **작업**: 보일러플레이트 생성, docker-compose, Drizzle 스키마, 환경설정
- **완료 조건**: `npm run dev` 서버 기동 + DB 테이블 생성 확인
- **예상 파일 수**: ~15개

### Phase 1 Agent - 마스터 DB + 상품 CRUD
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: Phase 0 산출물 + 기존 Google Sheets 데이터 구조
- **작업**: Product Service, REST API, 마이그레이션 스크립트
- **완료 조건**: `GET /api/products` 정상 응답 + 3,800+ 상품 적재
- **참조 파일**: `zipzip_mvp/src/api/googleSheetsAPI.js`

### Phase 2 Agent - 플랫폼 어댑터
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: PlatformAdapter 인터페이스 명세 + 기존 API 코드
- **작업**: eBay/Shopify 어댑터, PlatformRegistry, Listings API
- **완료 조건**: eBay/Shopify 리스팅 조회 동작
- **참조 파일**: `zipzip_mvp/src/api/ebayAPI.js`, `zipzip_mvp/src/api/shopifyAPI.js`

### Phase 3 Agent - 가격 엔진
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: 마진 계산 공식 + 배송비 테이블 + 플랫폼 수수료 구조
- **작업**: Pricing Service, 배송비 계산, 가격 규칙 CRUD
- **완료 조건**: 원가 입력 → 플랫폼별 판매가 정확 계산
- **참조 파일**: `zipzip_mvp/src/sync/sync-ebay-price-shipping.js`, `zipzip_mvp/src/dashboard/fix-profit-formula.js`

### Phase 4 Agent - Job Queue
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: BullMQ 큐 설계 + 스케줄 요구사항
- **작업**: 큐 정의, 워커, 스케줄러, Jobs API
- **완료 조건**: 워커 프로세스 시작 + 스케줄 작업 실행
- **참조 파일**: `zipzip_mvp/scripts/auto-sync-scheduler.js`

### Phase 5 Agent - 재고 동기화
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: 재고 서비스 요구사항 + 어댑터 인터페이스
- **작업**: Inventory Service, 크로스플랫폼 동기화, 품절 처리
- **완료 조건**: 한 플랫폼 재고 변경 → 다른 플랫폼 자동 반영
- **참조 파일**: `zipzip_mvp/src/sync/update-ebay-soldout.js`

### Phase 6 Agent - 크롤링 시스템
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: 크롤링 대상 사이트 목록 + BaseCrawler 설계
- **작업**: 사이트별 크롤러 (롯데, 이마트, 스마트스토어, 쿠팡, 토이팝, 해피메이트)
- **완료 조건**: 크롤링 실행 → DB 저장 동작
- **필요 도구**: Puppeteer MCP 서버

### Phase 7 Agent - 쿠팡 + Qoo10 어댑터
```
Task(subagent_type="general-purpose", model="opus")
```
- **입력**: PlatformAdapter 인터페이스 + 쿠팡 Wing API / Qoo10 API 문서
- **작업**: 쿠팡/Qoo10 어댑터 구현 + 리스팅 서비스 연동
- **완료 조건**: 4개 플랫폼 리스팅 CRUD 동작

### Phase 8 Agent - Next.js 대시보드
```
Task(subagent_type="frontend-dev" + "general-purpose", model="opus")
```
- **입력**: 백엔드 API 명세 + UI 요구사항
- **작업**: Next.js App Router, 페이지/컴포넌트, Tailwind 스타일링
- **완료 조건**: 브라우저에서 전체 기능 관리 가능

---

## 병렬 처리 전략

### 가능한 병렬 작업
```
Phase 0 → Phase 1 → Phase 2 ─┬─→ Phase 3 → Phase 4
                               └─→ Phase 5

Phase 6 (크롤링)은 Phase 1 이후 독립 진행 가능
Phase 7 (쿠팡/Qoo10)은 Phase 2 이후 독립 진행 가능
Phase 8 (대시보드)은 Phase 4 이후 시작
```

### 의존성 그래프
```
Phase 0 (인프라)
  └→ Phase 1 (DB + 상품)
       ├→ Phase 2 (eBay/Shopify 어댑터)
       │    ├→ Phase 3 (가격 엔진)
       │    │    └→ Phase 4 (Job Queue)
       │    │         └→ Phase 8 (대시보드)
       │    ├→ Phase 5 (재고 동기화)
       │    └→ Phase 7 (쿠팡/Qoo10)
       └→ Phase 6 (크롤링)
```

---

## 품질 게이트

각 Phase 완료 시 아래 체크리스트 통과 필수:

1. **빌드 통과**: `npm run build` 에러 없음
2. **타입 체크**: `npx tsc --noEmit` 에러 없음
3. **산출물 검증**: Phase별 정의된 산출물 테스트
4. **Architect 리뷰** (Phase 0, 2, 4 완료 후): 아키텍처 일관성 확인

---

## 에러 처리 프로토콜

| 에러 유형 | 대응 |
|-----------|------|
| 빌드 실패 | Phase Agent 재소환, 에러 컨텍스트 전달 |
| API 인증 실패 | 사용자에게 .env 확인 요청 |
| Docker 기동 실패 | Docker Desktop 상태 확인 → 사용자 안내 |
| 외부 API 제한 | Rate limit 대기 로직 구현 or 재시도 |
| 스키마 충돌 | Architect Agent 소환하여 마이그레이션 검토 |

---

## 진행 상황 추적

TodoWrite를 활용하여 실시간 추적:
```
[ ] Phase 0: 프로젝트 초기화
[ ] Phase 1: 마스터 DB + 상품 CRUD
[ ] Phase 2: 플랫폼 어댑터 (eBay + Shopify)
[ ] Phase 3: 가격 엔진
[ ] Phase 4: Job Queue
[ ] Phase 5: 재고 동기화
[ ] Phase 6: 크롤링 시스템
[ ] Phase 7: 쿠팡 + Qoo10
[ ] Phase 8: 대시보드
```

각 Phase 내부도 세부 태스크로 분해하여 추적.
