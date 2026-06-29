# PMC Work MVP - Multi-Platform Product Management System

Shopify/eBay 상품을 Google Sheets로 통합 관리하는 자동화 시스템입니다.

## 폴더 구조

```
PMC work MVP/
├── src/                          # 소스 코드
│   ├── api/                      # API 클래스
│   │   ├── googleSheetsAPI.js
│   │   ├── shopifyAPI.js
│   │   └── ebayAPI.js
│   ├── sync/                     # 동기화 스크립트
│   ├── dashboard/                # 대시보드 관련
│   ├── shipping/                 # 배송비 계산
│   └── utils/                    # 유틸리티
│
├── scripts/                      # 실행 스크립트 (진입점)
│   ├── auto-sync-scheduler.js    # 메인 스케줄러
│   └── auto-sync.bat
│
├── config/                       # 설정 파일
│   ├── .env                      # 환경변수 (비밀)
│   └── credentials.json          # Google 인증 (비밀)
│
├── docs/                         # 문서
│   ├── setup/                    # 설정 가이드
│   └── guides/                   # 사용 가이드
│
├── google-apps-script/           # Apps Script 파일
├── tests/                        # 테스트 파일
├── tools/                        # 디버그/체크 도구
├── archive/                      # 구버전 파일
├── data/                         # 데이터 파일
├── backups/                      # 백업
│
├── pmc-nextjs/                   # Next.js 웹앱
└── webapp/                       # Python 웹앱
```

## 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 설정 파일 준비

```bash
# config 폴더에 설정 파일 필요
config/.env              # API 키 설정
config/credentials.json  # Google 서비스 계정 키
```

### 3. 실행

```bash
# 전체 자동 동기화
npm start

# Shopify만 동기화
npm run sync-shopify

# eBay만 동기화
npm run sync-ebay

# 이상 징후 감지
npm run detect

# 대시보드 업데이트
npm run dashboard
```

## 주요 기능

- **Shopify 연동**: 3,800+ 상품 자동 동기화
- **eBay 연동**: Trading API를 통한 리스팅 관리
- **마진 계산**: 30% 마진 수식 자동 적용
- **이상 징후 감지**: 역마진 상품 자동 탐지
- **자동 스케줄링**: Windows 작업 스케줄러 연동

## 문서

- [빠른 시작](docs/QUICK_START.md)
- [설정 가이드](docs/setup/)
- [사용 가이드](docs/guides/)
- [Hermes v1 Market Intelligence Runbook](docs/hermes-v1-market-intelligence-runbook.md)

## Hermes v1 — eBay Market Intelligence

Hermes v1은 자동 가격 변경 도구가 아니라 eBay Market Intelligence 리포트봇입니다.
경쟁셀러 모니터링, 가격/배송/재고 변화 분석, Telegram 알림, Daily Report만 수행합니다.

가격 변경/승인 버튼/자동 repricing은 v1에서 비활성화되어 있습니다.

### 실행 절차

1. Supabase에 `supabase/migrations/058_hermes_v1_market_intelligence.sql` 적용
2. snapshot/mapping 동기화

```bash
npm run hermes:market -- sync
```

3. 최근 market alert 생성

```bash
npm run hermes:market -- alerts --hours=24
```

4. Daily Report 생성

```bash
npm run hermes:market -- daily --hours=24
```

5. Telegram 전송 테스트

```bash
npm run hermes:market -- daily --hours=24 --telegram
```

### Phase 2: Product Intelligence

SKU 포트폴리오를 최근 판매, eBay 리스팅, 경쟁가 상태 기준으로 분석합니다.
역시 read-only 리포트이며 가격 변경 API를 호출하지 않습니다.

```bash
# 최근 30일 기준 Product Intelligence report
npm run hermes:market -- product --days=30

# Telegram 전송 포함
npm run hermes:market -- product --days=30 --telegram
```

상세 계획: [Phase 2 Product Intelligence Plan](docs/phase-2-product-intelligence-plan.md)

Migration 058 적용 전에도 Daily Report markdown 생성은 fallback으로 동작하지만,
`market_alerts`/`daily_reports` 영구 저장은 migration 적용 후에만 정상 동작합니다.

## 라이선스

ISC
