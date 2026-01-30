# PMC Work MVP - Google Sheets API 연동

Node.js에서 구글 스프레드시트 API를 사용하여 데이터를 읽고 쓰는 프로젝트입니다.

## 설치 및 설정

### 1. 의존성 설치

```bash
npm install
```

### 2. Google Service Account 설정

#### 2-1. Google Cloud Console에서 Service Account 생성 (이미 완료하신 경우 건너뛰기)

1. [Google Cloud Console](https://console.cloud.google.com/) 접속
2. 프로젝트 선택 또는 새 프로젝트 생성
3. **API 및 서비스 > 사용자 인증 정보** 메뉴로 이동
4. **사용자 인증 정보 만들기 > 서비스 계정** 선택
5. 서비스 계정 생성 후, **키 > 키 추가 > 새 키 만들기 > JSON** 선택
6. JSON 키 파일 다운로드

#### 2-2. Google Sheets API 활성화

1. Google Cloud Console에서 **API 및 서비스 > 라이브러리** 메뉴로 이동
2. "Google Sheets API" 검색
3. **사용 설정** 클릭

#### 2-3. credentials.json 파일 설정

다운로드한 JSON 키 파일을 이 프로젝트 폴더에 `credentials.json` 이름으로 복사하세요.

```bash
# 예시: Downloads 폴더에서 복사
cp ~/Downloads/pmc-work-mvp-xxxxx.json ./credentials.json
```

### 3. 스프레드시트 공유 설정

Service Account가 스프레드시트에 접근할 수 있도록 **공유 설정**이 필요합니다.

1. `credentials.json` 파일을 열어서 `client_email` 값을 복사
   - 예: `your-service-account@your-project.iam.gserviceaccount.com`
2. 접근하려는 Google 스프레드시트를 열기
3. **공유** 버튼 클릭
4. 복사한 service account 이메일 주소를 입력하고 **편집자** 권한 부여
5. **완료** 클릭

## 사용 방법

### 스프레드시트 ID 확인

구글 스프레드시트 URL에서 ID를 확인할 수 있습니다:

```
https://docs.google.com/spreadsheets/d/[여기가_스프레드시트_ID]/edit
```

### 빠른 시작

`quickStart.js` 파일을 수정하여 바로 사용할 수 있습니다:

```javascript
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE'; // 스프레드시트 ID 입력

// 파일 수정 후 실행
node quickStart.js
```

### 주요 기능 예제

#### 1. 데이터 읽기

```javascript
const GoogleSheetsAPI = require('./googleSheetsAPI');
const sheetsAPI = new GoogleSheetsAPI('./credentials.json');

await sheetsAPI.authenticate();
const data = await sheetsAPI.readData(SPREADSHEET_ID, 'Sheet1!A1:D10');
console.log(data);
```

#### 2. 데이터 쓰기 (덮어쓰기)

```javascript
const writeData = [
  ['이름', '나이', '직책'],
  ['홍길동', 30, '개발자'],
  ['김철수', 25, '디자이너'],
];

await sheetsAPI.writeData(SPREADSHEET_ID, 'Sheet1!A1', writeData);
```

#### 3. 데이터 추가 (기존 데이터 뒤에 추가)

```javascript
const appendData = [
  ['이영희', 28, '마케터'],
];

await sheetsAPI.appendData(SPREADSHEET_ID, 'Sheet1!A:C', appendData);
```

#### 4. 새 시트 생성

```javascript
const newSheetId = await sheetsAPI.createSheet(SPREADSHEET_ID, '새_시트_이름');
```

#### 5. 데이터 삭제

```javascript
await sheetsAPI.clearData(SPREADSHEET_ID, 'Sheet1!A1:D10');
```

#### 6. 시트 정보 조회

```javascript
const info = await sheetsAPI.getSpreadsheetInfo(SPREADSHEET_ID);
```

### 전체 예제 실행

`example.js` 파일에 모든 기능의 예제가 포함되어 있습니다:

1. 파일을 열어서 `SPREADSHEET_ID` 수정
2. 실행:

```bash
node example.js
```

## API 메서드

### GoogleSheetsAPI 클래스

| 메서드 | 설명 | 파라미터 |
|--------|------|----------|
| `authenticate()` | API 인증 초기화 | - |
| `readData(spreadsheetId, range)` | 데이터 읽기 | spreadsheetId, range (예: 'Sheet1!A1:D10') |
| `writeData(spreadsheetId, range, values)` | 데이터 쓰기 (덮어쓰기) | spreadsheetId, range, values (2D 배열) |
| `appendData(spreadsheetId, range, values)` | 데이터 추가 | spreadsheetId, range, values (2D 배열) |
| `createSheet(spreadsheetId, sheetTitle)` | 새 시트 생성 | spreadsheetId, sheetTitle |
| `deleteSheet(spreadsheetId, sheetId)` | 시트 삭제 | spreadsheetId, sheetId |
| `clearData(spreadsheetId, range)` | 데이터 삭제 | spreadsheetId, range |
| `getSpreadsheetInfo(spreadsheetId)` | 스프레드시트 정보 조회 | spreadsheetId |

## 파일 구조

```
PMC work MVP/
├── node_modules/          # 의존성 패키지
├── .gitignore            # Git 제외 파일 목록
├── credentials.json      # Service Account 키 파일 (절대 커밋하지 마세요!)
├── credentials.example.json  # credentials.json 예제 파일
├── googleSheetsAPI.js    # Google Sheets API 클래스
├── example.js            # 전체 기능 예제
├── quickStart.js         # 빠른 시작 스크립트
├── package.json          # 프로젝트 설정
└── README.md             # 이 파일
```

## 주의사항

- `credentials.json` 파일은 **절대로 Git에 커밋하지 마세요!** (이미 .gitignore에 추가되어 있음)
- Service Account 이메일을 스프레드시트에 공유해야만 접근 가능합니다
- 스프레드시트 범위는 A1 표기법을 사용합니다 (예: 'Sheet1!A1:D10')
- 시트 삭제는 되돌릴 수 없으니 주의하세요

## 문제 해결

### "The caller does not have permission" 에러

→ Service Account 이메일을 스프레드시트에 공유했는지 확인하세요.

### "Unable to parse range" 에러

→ 범위 형식을 확인하세요. 올바른 형식: 'Sheet1!A1:D10'

### "invalid_grant" 에러

→ credentials.json 파일이 올바른지 확인하세요.

## 라이선스

MIT
