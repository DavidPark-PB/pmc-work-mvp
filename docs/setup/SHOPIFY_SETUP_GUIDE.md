# Shopify API 설정 가이드

## 1. Shopify Admin API 액세스 토큰 생성하기

### Step 1: Shopify Admin 패널 접속
1. Shopify 스토어 관리자 페이지에 로그인
   - URL: `https://YOUR_STORE_NAME.myshopify.com/admin`

### Step 2: Custom App 생성
1. 왼쪽 메뉴에서 **Settings** (설정) 클릭
2. **Apps and sales channels** (앱 및 판매 채널) 클릭
3. **Develop apps** (앱 개발) 클릭
4. **Allow custom app development** (맞춤 앱 개발 허용) 클릭 (처음인 경우)
5. **Create an app** (앱 만들기) 클릭
6. 앱 이름 입력 (예: "PMC Inventory Manager")

### Step 3: API 권한 설정
1. 생성한 앱을 클릭
2. **Configure Admin API scopes** (Admin API 범위 구성) 클릭
3. 다음 권한을 선택:
   - ✅ `read_products` - 상품 정보 읽기
   - ✅ `write_products` - 상품 정보 쓰기 (필요시)
   - ✅ `read_inventory` - 재고 정보 읽기 (필요시)
4. **Save** 클릭

### Step 4: Admin API 액세스 토큰 생성
1. **API credentials** 탭 클릭
2. **Install app** 클릭
3. **Admin API access token** 생성됨
4. ⚠️ **중요: 토큰을 복사하여 안전한 곳에 보관하세요!** (한 번만 표시됩니다)

### Step 5: API 정보 확인
필요한 정보:
- **Store URL**: `your-store-name.myshopify.com`
- **Access Token**: `shpat_xxxxxxxxxxxxxxxxxxxxxxxxxx`
- **API Version**: `2024-01` (최신 버전 사용)

## 2. 환경 변수 파일 생성

프로젝트 폴더에 `.env` 파일을 생성하고 다음 내용을 입력하세요:

```env
# Shopify API Credentials
SHOPIFY_STORE_URL=your-store-name.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01

# Google Sheets
GOOGLE_SPREADSHEET_ID=1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M
```

⚠️ **주의사항:**
- `.env` 파일은 절대로 Git에 커밋하지 마세요!
- 이미 `.gitignore`에 추가되어 있습니다.

## 3. 테스트

설정이 완료되면 다음 명령어로 테스트:

```bash
node test-shopify-connection.js
```

## 참고 자료
- [Shopify Admin API 문서](https://shopify.dev/docs/api/admin-rest)
- [Custom Apps 가이드](https://help.shopify.com/en/manual/apps/app-types/custom-apps)
