# ccorea-auto (pmc-auto)

Korean wholesale → eBay/Shopify 자동화 시스템

## 프로젝트 구조

```
src/
  index.ts          — Fastify 서버 (포트 3000)
  db/schema.ts      — Drizzle ORM 스키마 (6 tables)
  db/index.ts       — DB 연결 (Supabase PostgreSQL)
  crawler/
    BaseCrawler.ts   — Patchright 기반 크롤러 (launchPersistentContext)
    CoupangCrawler.ts — 쿠팡 검색/상세 크롤링 + DB 저장
    utils/           — parsers, human-behavior
  routes/products.ts — 상품 CRUD API
  lib/config.ts      — 환경변수 로드
scripts/
  test-crawler.ts    — 크롤러 테스트 (search/detail)
  test-patchright.ts — Patchright 단독 테스트
  reset-db.ts        — DB 스키마 리셋
  seed-shipping-rates.ts — 배송비 시딩
```

## DB 테이블 (Supabase PostgreSQL)

crawl_sources → crawl_results → products → product_images
                                        → platform_listings
shipping_rates (독립)

## 핵심 기술 결정

### Patchright 크롤러 (Akamai 우회)
- `patchright` = Playwright CDP 리크 패치 버전
- **반드시 지켜야 할 것:**
  - `chromium.launchPersistentContext()` 사용 (launch() 아님)
  - `channel: 'chrome'` (chromium 아님)
  - `headless: false`
  - `viewport: null`
  - 커스텀 UserAgent 설정 금지
  - `addInitScript` 금지 (navigator.webdriver 등)
  - `page.route()` 광고차단 금지
  - 위 항목들은 Patchright 패치와 충돌하여 오히려 탐지됨

## 셋업 (다른 PC)

```bash
git clone https://github.com/inwon100/ccorea-auto.git
cd ccorea-auto
npm install
npx patchright install chrome

# .env 파일 생성 (.env.example 참고)
# DATABASE_URL은 Supabase 연결 문자열 사용

# DB 스키마 푸시
npm run db:push

# 크롤러 테스트
npx tsx scripts/test-crawler.ts search "포켓몬 카드"
```

## 개발 명령어

- `npm run dev` — Fastify 서버 (watch mode)
- `npm run db:push` — 스키마를 DB에 적용
- `npm run db:studio` — Drizzle Studio (DB GUI)
- `npx tsx scripts/test-crawler.ts search "키워드"` — 크롤러 테스트
