# eBay Auth'n'Auth 토큰 발급 가이드

## 문제 상황
- OAuth 토큰은 scope 제한이 있어 일부 Trading API 메서드만 지원
- GetMyeBaySelling은 작동하지만 GetSellerList는 실패
- 4,700개 상품이 있는데 API에서 0개로 표시됨

## 해결책: Auth'n'Auth 토큰 사용

Auth'n'Auth 토큰은 **모든 Trading API 메서드**를 지원합니다.

## 발급 방법

### 1. Developer Portal 접속
```
https://developer.ebay.com/my/auth/?env=production&index=0
```

### 2. "Auth'n'Auth" 탭 선택
- OAuth 탭이 아닌 **"Auth'n'Auth"** 탭을 클릭하세요

### 3. "Get a Token from eBay via Your Application" 섹션
- "Sign in to Production" 버튼 클릭
- 또는 직접 URL 접속:
```
https://signin.ebay.com/ws/eBayISAPI.dll?SignIn&runame=PMC_Corporation-PMCCorpo-Produc-kqprbe&SessID=<SESSION_ID>
```

### 4. eBay 로그인 및 승인
- eBay 계정으로 로그인
- 애플리케이션 권한 승인

### 5. 토큰 확인
- 승인 후 Developer Portal로 돌아오면 토큰이 표시됩니다
- 토큰 형식: `v^1.1#i^1#...` (약 100자, 끝에 `==`)

### 6. .env 파일 업데이트
```env
EBAY_USER_TOKEN=v^1.1#i^1#...여기에_Auth'n'Auth_토큰_붙여넣기...==
```

## Auth'n'Auth vs OAuth 비교

| 특징 | Auth'n'Auth | OAuth |
|------|-------------|-------|
| 지원 API | 모든 Trading API | Scope에 따라 제한 |
| 토큰 길이 | 짧음 (~100자) | 길음 (1000자+) |
| 유효기간 | 18개월 | 2시간 (갱신 가능) |
| 갱신 | 수동 | Refresh Token으로 자동 |
| 권장 사용 | Trading API | RESTful API |

## 현재 상황에서는?

**Auth'n'Auth 토큰 사용을 강력히 권장합니다!**

이유:
1. ✅ 모든 Trading API 메서드 지원
2. ✅ GetMyeBaySelling으로 4,700개 상품 모두 조회 가능
3. ✅ 18개월 유효기간으로 자주 갱신 불필요
4. ✅ 설정 간단, 바로 사용 가능

## 다음 단계

1. Auth'n'Auth 토큰 발급
2. `.env` 파일에 `EBAY_USER_TOKEN` 업데이트
3. `node ebayAPI.js` 실행하여 테스트
4. 4,700개 상품이 정상 조회되는지 확인
