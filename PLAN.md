# PMC 멀티플랫폼 이커머스 자동화 시스템

## Context
기존 zipzip_mvp는 Google Sheets를 DB로 쓰는 구조로 전체 비전의 ~5-10%만 구현됨.
멀티플랫폼(eBay, Shopify, Naver, Alibaba, 쿠팡, Qoo10) 상품 관리, 가격 자동화, 재고 동기화,
한국 도매사이트 크롤링을 포괄하는 시스템을 `pmc-auto`로 새로 구축한다.

**절대 규칙: 이미 구동 중인 쇼핑몰은 READ-ONLY. API로 데이터를 읽기만 하고, DB만 보정한다.**

---

## 현재 상품/리스팅 현황 (2026-03-02 기준, API 비교대조 후)

| 플랫폼 | active | ended | draft | 비고 |
|--------|--------|-------|-------|------|
| eBay | 4,880 | 105 | - | API active 11,453개 (DB 누락 1,656개) |
| Shopify | 3,721 | 66 | - | API variants 3,825개 (DB 누락 11개) |
| Naver | 9,837 | 305 | - | xlsx 기반 (API 미검증) |
| Alibaba | 330 | - | 41 | xlsx 기반 (API 미검증) |

| products 상태 | 수량 |
|--------------|------|
| active | 18,545 |
| soldout | 206 |
| discontinued | 305 |
| ended | 156 |
| pending | 45 |
| **총계** | **19,257** |

---

## 완료된 Phase

### Phase 0: 프로젝트 초기화 [완료]
- [x] TypeScript + Fastify 보일러플레이트
- [x] Drizzle ORM 설정 + 스키마 정의 (15개 테이블)
- [x] Supabase 연결 + 스키마 push
- [x] 서버 기동 확인
- [x] MCP 서버 설정 (PostgreSQL, Puppeteer)

### Phase 1: 데이터 마이그레이션 [완료]
- [x] xlsx(최종 Dashboard) → Supabase 마이그레이션 (`scripts/migrate-xlsx-to-db.ts`)
  - products: 19,257개 (PMC-NNNNN SKU 체계)
  - platform_listings: eBay, Shopify, Naver, Alibaba
- [x] Phase 1.5: Active/Draft 상태 교정 (xlsx 기준)
  - eBay: 4,002개 draft→active 교정 (Item ID 존재 = eBay 등록됨)
  - Shopify: 3,787개 리스팅 신규 생성 (Shopify xlsx 시트에서)
  - products.status: 7,824개 active 연쇄 교정
- [x] Phase 1.6: API 비교대조로 실제 쇼핑몰 vs DB 검증
  - eBay: 토큰 만료 해결 (refresh token으로 갱신), API 11,453개 확인
    - 928개 ended→active 복원, 103개 active→ended 교정
  - Shopify: API 3,825개, 일치 3,814개, 가격차이 67개
  - 안전장치 추가: API 0개 + DB 다수 시 자동 중단

**핵심 교훈**:
- `.env`에서 `#` 포함된 값은 반드시 쌍따옴표로 감싸기 (dotenv가 # 이후를 주석 처리)
- eBay User Token은 2시간 만료 → refresh token으로 자동 갱신 필요
- API 대량 교정 전 반드시 안전장치 (0개 반환 시 중단)

---

## 다음 Phase: 미해결 과제

### Phase 1.7: 누락 데이터 보완 (미착수)
- [ ] eBay DB 누락 1,656개 리스팅 → API에서 가져와 DB INSERT
- [ ] Shopify DB 누락 11개 variants → DB INSERT
- [ ] Shopify 가격 차이 67개 → API 기준으로 DB UPDATE
- [ ] Naver/Alibaba API 비교대조 (현재 xlsx 기준만)

### Phase 2: 플랫폼 어댑터 (eBay + Shopify)
- [ ] PlatformAdapter 인터페이스 + BasePlatformAdapter
- [ ] eBay 어댑터 (Trading API, OAuth 자동 갱신)
- [ ] Shopify 어댑터 (Admin REST API)
- [ ] PlatformRegistry + `/api/listings`

### Phase 3: 가격 엔진
- [ ] 30% 마진, 배송비(YunExpress/K-Packet), 플랫폼 수수료
- [ ] 가격 규칙 CRUD + 일괄 업데이트

### Phase 4: Job Queue (pg-boss)
- [ ] 큐 설정 + 워커 + 반복 스케줄
- [ ] eBay 토큰 자동 갱신 (2시간마다)
- [ ] `/api/jobs` 엔드포인트

### Phase 5: 재고 동기화
- [ ] 크로스플랫폼 재고 동기화 + 품절 자동화

### Phase 6: 크롤링 시스템
- [ ] 도매사이트 크롤러 (롯데, 이마트, 스마트스토어, 쿠팡, 토이팝, 해피메이트)
- [ ] `src/crawler/` 이미 폴더 존재, 구현 시작 가능

### Phase 7: 쿠팡 + Qoo10 어댑터

### Phase 8: Next.js 대시보드

---

## 기술 스택 (최종)
- **Runtime**: Node.js + TypeScript (strict mode, ESM)
- **API 서버**: Fastify
- **DB**: Supabase (PostgreSQL) + Drizzle ORM
- **Job Queue**: pg-boss (PostgreSQL 기반)
- **크롤링**: Puppeteer + Cheerio
- **프론트엔드**: Next.js (App Router) + Tailwind CSS
- **테스트**: Vitest
- **기타**: Zod, Pino, fast-xml-parser, axios

---

## 인프라 결정

### Docker → Supabase 전환
- **이유**: Docker Desktop 의존성 제거, 인프라 관리 간소화
- **DB**: Supabase 호스팅 PostgreSQL
- **Job Queue**: BullMQ + Redis → **pg-boss** (PostgreSQL 기반, Redis 불필요)

---

## 프로젝트 구조
```
pmc-auto/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env                        # DB, eBay, Shopify API 키
├── .mcp.json                   # MCP 서버 설정
├── src/
│   ├── index.ts                # Fastify 서버 엔트리
│   ├── db/
│   │   ├── schema.ts           # Drizzle 스키마 (15개 테이블)
│   │   ├── index.ts            # DB 커넥션
│   │   └── migrate.ts          # 마이그레이션 실행기
│   ├── platforms/
│   │   ├── types.ts            # PlatformAdapter 인터페이스
│   │   ├── ebay/               # eBay Trading API
│   │   └── shopify/            # Shopify Admin API
│   ├── services/
│   ├── crawlers/
│   ├── jobs/
│   ├── routes/
│   │   └── products.ts         # 상품 CRUD API
│   └── lib/
│       ├── config.ts           # Zod 환경변수 검증
│       └── logger.ts           # Pino 로거
├── scripts/
│   ├── migrate-xlsx-to-db.ts   # xlsx → DB 마이그레이션
│   ├── fix-listing-status.ts   # Phase 1.5 상태 교정
│   ├── verify-listings-via-api.ts  # Phase 1.6 API 비교대조
│   └── rollback-ebay.ts        # eBay 긴급 롤백
└── web/                        # Next.js 대시보드 (Phase 8)
```

## DB 스키마 핵심 테이블
```
products              - 마스터 상품 (PMC-NNNNN SKU, Single Source of Truth)
platform_listings     - 플랫폼별 리스팅 (unique: productId + platform)
  ├── ebay            - platformItemId = eBay ItemID
  ├── shopify         - platformSku = variant SKU
  ├── naver           - platformItemId = Naver 상품번호
  └── alibaba         - platformItemId = Alibaba 상품번호
```

## 의존성 그래프
```
Phase 0 (인프라) ✅
  └→ Phase 1 (데이터 마이그레이션) ✅
       ├→ Phase 1.7 (누락 보완) ← 다음 작업
       ├→ Phase 2 (eBay/Shopify 어댑터)
       │    ├→ Phase 3 (가격 엔진)
       │    │    └→ Phase 4 (Job Queue)
       │    │         └→ Phase 8 (대시보드)
       │    ├→ Phase 5 (재고 동기화)
       │    └→ Phase 7 (쿠팡/Qoo10)
       └→ Phase 6 (크롤링) — Phase 1 이후 독립 가능
```

## 기존 코드 재활용 (zipzip_mvp)
- `src/api/ebayAPI.js` → eBay XML 빌더/파서, OAuth IAF 토큰
- `src/api/shopifyAPI.js` → Shopify API 호출 패턴
- `src/sync/sync-ebay-price-shipping.js` → 마진/배송비 계산
- `src/utils/detect-anomalies.js` → 이상 징후 감지
- `.env` → API 키 원본 (eBay, Shopify, Alibaba, Naver)
