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

## 라이선스

ISC
