# eBay User Token 수동 발급 가이드

## 문제 상황

OAuth 자동화 스크립트가 "invalid_request" 에러를 반환하고 있습니다.
이는 eBay Developer Portal에서 RuName (Redirect URL Name) 설정이 필요하기 때문입니다.

## 해결 방법 1: eBay Developer Portal에서 직접 토큰 발급

### 단계 1: eBay Developer Portal 접속

1. https://developer.ebay.com/ 접속
2. 로그인 (판매자 계정)

### 단계 2: User Token 페이지 이동

1. 상단 메뉴에서 **"My Account"** 클릭
2. 왼쪽 메뉴에서 **"Application Keys"** 선택
3. Production 애플리케이션 찾기: **YOUR_EBAY_APP_ID**

### 단계 3: User Token 발급

1. "User Tokens" 섹션 찾기
2. **"Get a Token from eBay via Your Application"** 버튼 클릭
3. 권한 승인 페이지에서 다음 권한 선택:
   - View and manage your orders
   - View your eBay data
   - Manage your inventory and offers
   - View and manage your ads and campaigns
4. **"Agree"** 버튼 클릭
5. 생성된 토큰 복사

### 단계 4: .env 파일 업데이트

발급받은 토큰을 `.env` 파일에 붙여넣기:

```env
EBAY_USER_TOKEN=v^1.1#i^1#...여기에_토큰_붙여넣기...
EBAY_REFRESH_TOKEN=v^1.1#i^1#...여기에_refresh_토큰_붙여넣기...
```

**중요:** User Token과 Refresh Token 모두 복사해야 합니다!

## 해결 방법 2: RuName 설정 후 자동화 (고급)

### RuName이란?

eBay OAuth에서 사용하는 Redirect URL의 별칭입니다.

### RuName 설정 방법

1. Developer Portal → "User Tokens" → "Get RuName"
2. RuName 생성:
   - Name: `PMC_OAuth`
   - Your privacy policy URL: `https://your-domain.com/privacy` (없으면 임시로 아무 URL)
   - Your auth accepted URL: `http://localhost:3000/callback`
3. 생성된 RuName 복사

### get-ebay-token.js 수정

RuName을 코드에 추가:

```javascript
const authorizationUrl = `${AUTH_URL}?client_id=${EBAY_APP_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&runame=${RUNAME}`;
```

## 간단한 대안: Trading API 토큰 사용

현재 상황에서는 **방법 1 (Developer Portal에서 직접 발급)**이 가장 빠릅니다.

## 토큰 유효기간

- **User Token (Access Token)**: 2시간
- **Refresh Token**: 18개월

만료되면 다시 발급받아야 합니다.

## 발급 후 테스트

토큰을 .env에 추가한 후:

```bash
# eBay 연결 테스트
node ebayAPI.js

# eBay 상품 동기화
node sync-ebay-to-sheets.js
```

## 참고 문서

- [eBay OAuth Documentation](https://developer.ebay.com/api-docs/static/oauth-tokens.html)
- [Getting User Tokens](https://developer.ebay.com/api-docs/static/oauth-user-token-request.html)
