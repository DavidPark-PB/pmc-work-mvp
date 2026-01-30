# 🔄 자동 동기화 시스템 설정 가이드

## 개요

12시간마다 자동으로 Pending 상태를 확인하고, 필요시 eBay와 Shopify로 데이터를 동기화하는 시스템입니다.

---

## 📋 시스템 구조

### 1단계: Google Apps Script (자동 감지 & 알림)
- **역할**: Pending 상태 확인, 알림 표시
- **실행 주기**: 12시간마다 자동
- **안전 장치**: 매입가, 무게(kg) 열 수정 차단

### 2단계: Node.js 스크립트 (실제 API 전송)
- **역할**: eBay/Shopify API 호출
- **실행 방법**: 수동 또는 스케줄러

---

## 🚀 설정 방법

### Step 1: Google Apps Script 설정

#### 1-1. 스크립트 복사

1. Google Sheets 열기
   ```
   https://docs.google.com/spreadsheets/d/1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M
   ```

2. 메뉴: **확장 프로그램 → Apps Script**

3. 기존 코드를 모두 삭제하고 `google-apps-script-autosync.gs` 내용 붙여넣기

4. **저장** (Ctrl+S)

#### 1-2. 이메일 알림 설정 (선택사항)

스크립트 상단의 CONFIG 수정:

```javascript
const CONFIG = {
  // ... 기존 설정 ...

  // 이메일 알림 설정
  ADMIN_EMAIL: 'your-email@example.com',  // ← 대표님 이메일로 변경
  SEND_EMAIL_ALERTS: true  // ← true로 변경하면 알림 활성화
};
```

#### 1-3. 트리거 설정

1. Apps Script 편집기에서 **트리거** 아이콘 클릭 (시계 모양)

2. **트리거 추가** 클릭

3. 설정:
   ```
   실행할 함수: autoSyncCheck
   이벤트 소스: 시간 기반
   시간 간격: 12시간마다
   ```

4. **저장**

5. 권한 요청이 나오면 **허용**

#### 1-4. onEdit 트리거 설정

1. 다시 **트리거 추가**

2. 설정:
   ```
   실행할 함수: onEdit
   이벤트 소스: 스프레드시트에서
   이벤트 유형: 수정 시
   ```

3. **저장**

---

### Step 2: Node.js 자동 동기화 스크립트

#### 2-1. 스크립트 확인

터미널에서 확인:
```bash
cd "C:\Users\tooni\PMC work MVP"
ls auto-sync-all.js
```

#### 2-2. 수동 실행 테스트

```bash
node auto-sync-all.js
```

**예상 결과:**
```
======================================================================
🔄 통합 자동 동기화 시작
======================================================================

⏰ 실행 시각: 2026-01-14 오후 3:30:00

📊 1단계: Google Sheets 연결 중...
   ✅ 연결 완료: 최종 Dashboard

🔒 2단계: 안전 장치 확인 중...
   🔒 매입가 열은 읽기 전용으로 보호됩니다.
   🔒 무게(kg) 열은 읽기 전용으로 보호됩니다.

🔍 3단계: Pending 상태 확인 중...
   발견된 Pending 행: 15개
   📦 eBay 동기화: 10개
   🛍️  Shopify 동기화: 5개

======================================================================
📦 eBay 동기화 시작
======================================================================
   1/10 Item ID: 123456789
      ✅ 성공
   ...

📊 동기화 결과 요약
======================================================================
총 처리: 15개

📦 eBay:
   ✅ 성공: 10개
   ❌ 실패: 0개

🛍️  Shopify:
   ✅ 성공: 5개
   ❌ 실패: 0개

🎉 자동 동기화 완료!
```

---

## ⏰ 자동 실행 설정 (Windows)

### 옵션 1: Windows 작업 스케줄러 (권장)

#### 1. 작업 스케줄러 열기

```
시작 → "작업 스케줄러" 검색
```

#### 2. 기본 작업 만들기

1. 오른쪽: **기본 작업 만들기** 클릭

2. 이름: `Auto Sync eBay Shopify`

3. 트리거: **매일**

4. 시작 시간: 오전 9시

5. 되풀이 간격: **12시간**

6. 작업: **프로그램 시작**

7. 프로그램/스크립트:
   ```
   C:\Program Files\nodejs\node.exe
   ```

8. 인수 추가:
   ```
   "C:\Users\tooni\PMC work MVP\auto-sync-all.js"
   ```

9. 시작 위치:
   ```
   C:\Users\tooni\PMC work MVP
   ```

10. **완료**

#### 3. 고급 설정

작업을 만든 후 더블클릭하여 속성 열기:

- **조건** 탭:
  - [ ] "컴퓨터의 전원이 AC 전원일 때만 작업 시작" 체크 해제

- **설정** 탭:
  - [x] "작업이 실패하면 다시 시작 간격" → 1분

### 옵션 2: Batch 파일 + 작업 스케줄러

#### 1. Batch 파일 생성

`auto-sync.bat` 파일 생성:
```batch
@echo off
cd "C:\Users\tooni\PMC work MVP"
node auto-sync-all.js >> sync-log.txt 2>&1
```

#### 2. 작업 스케줄러에서 Batch 파일 실행

프로그램/스크립트:
```
C:\Users\tooni\PMC work MVP\auto-sync.bat
```

---

## 📊 동작 방식

### 시나리오 1: 가격 수정 → 자동 동기화

1. **대표님이 시트에서 가격 수정**
   ```
   Row 5의 판매가(USD)를 $19.99 → $24.99로 변경
   ```

2. **Apps Script가 자동 감지 (onEdit)**
   ```
   ✅ Row 5 → Sync Status: "Pending"
   ✅ Row 5 → Last Updated: 2026-01-14T06:30:00Z
   ✅ Row 5 → 배경색: 노란색
   ```

3. **12시간 후 자동 체크 (autoSyncCheck)**
   ```
   ✅ Pending 발견: 1개
   ✅ A1 셀에 알림 표시: "⚠️ 동기화 필요: 총 1개"
   ✅ (옵션) 이메일 발송
   ```

4. **Node.js 스크립트 자동 실행**
   ```
   ✅ eBay API 호출
   ✅ 가격 업데이트 성공
   ✅ Sync Status: "Success"
   ```

### 시나리오 2: 대량 재고 조정

1. **시트에서 100개 상품 재고 수정**

2. **Apps Script가 100개 행을 Pending으로 마킹**

3. **12시간 후 자동 체크**
   ```
   ⚠️ Pending 100개 발견
   📧 이메일 발송: "100개 상품 동기화 필요"
   ```

4. **Node.js 스크립트 실행**
   ```
   ✅ eBay: 60개 성공
   ✅ Shopify: 40개 성공
   ```

---

## 🔒 안전 장치

### 1. Apps Script 레벨

```javascript
// onEdit 함수에서 보호된 열 감지
if (CONFIG.PROTECTED_COLS.includes(col)) {
  ui.alert('⚠️ 경고', '이 열은 보호되어 있어 수정할 수 없습니다!');
  range.setValue(e.oldValue || '');  // 변경 취소
  return;
}
```

**보호된 열:**
- F열: 매입가
- O열: 무게(kg)

### 2. Node.js 스크립트 레벨

```javascript
const CONFIG = {
  PROTECTED_COLUMNS: ['매입가', '무게(kg)'],  // 절대 접근 금지
};

// 헤더 로드 시 보호된 열 확인
for (const protectedCol of CONFIG.PROTECTED_COLUMNS) {
  console.log(`🔒 ${protectedCol} 열은 읽기 전용으로 보호됩니다.`);
}
```

**보장사항:**
- 스크립트가 매입가와 무게 데이터를 절대 읽거나 수정하지 않음
- 로그에 보호 상태 기록

---

## 🎛️ 커스텀 메뉴

시트 상단 메뉴에 **🔄 동기화** 추가됨:

### 메뉴 항목:

1. **📊 지금 동기화 상태 확인**
   - Pending 상품 수 확인
   - 플랫폼별 분류 표시
   - 동기화 명령어 안내

2. **🔄 선택한 행 Pending 설정**
   - 특정 행들을 수동으로 Pending 마킹
   - 대량 재동기화에 유용

3. **⚙️ 자동 동기화 체크 실행**
   - 트리거를 기다리지 않고 즉시 체크
   - 테스트용

4. **📖 도움말**
   - 시스템 사용 방법 안내

---

## 📧 이메일 알림 예시

### 동기화 필요 알림

```
제목: [자동 알림] 15개 상품 동기화 필요

안녕하세요,

Google Sheets에서 동기화가 필요한 상품이 발견되었습니다.

📊 상세 정보:
- 총 15개 상품
- eBay: 10개
- Shopify: 5개

다음 명령어로 동기화를 실행하세요:
- eBay: node sync-to-ebay.js
- Shopify: node sync-to-shopify.js

시트 링크: https://docs.google.com/spreadsheets/d/...

자동 알림 시스템
```

### 오류 알림

```
제목: [오류 알림] 자동 동기화 체크 실패

자동 동기화 체크 중 오류가 발생했습니다.

오류 메시지:
This cell has not been loaded yet

스택 트레이스:
...

시트 링크: https://docs.google.com/spreadsheets/d/...
```

---

## 🧪 테스트 방법

### 1. 수동 Pending 설정 테스트

1. 시트에서 임의의 행 1개 선택

2. 메뉴: **🔄 동기화 → 선택한 행 Pending 설정**

3. Sync Status가 "Pending"으로 변경되는지 확인

### 2. 자동 체크 테스트

1. 메뉴: **🔄 동기화 → 자동 동기화 체크 실행**

2. A1 셀에 알림이 표시되는지 확인

### 3. Node.js 동기화 테스트

```bash
node auto-sync-all.js
```

결과 확인:
- Pending → Success로 변경
- Last Updated 타임스탬프 업데이트

---

## ⚠️ 주의사항

### 1. API Rate Limits

- **eBay**: 초당 5,000 calls (충분함)
- **Shopify**: 초당 2 calls (스크립트에 500ms 딜레이 포함)

### 2. 스크립트 실행 시간

- Apps Script: 최대 6분 실행 제한
- 대량 동기화 시 Node.js 스크립트 사용 권장

### 3. 트리거 제한

- 트리거당 일일 실행 횟수: 제한 없음
- 하지만 과도한 실행은 할당량 소모

---

## 🔧 문제 해결

### Q: 트리거가 실행되지 않아요

**A**: Apps Script 트리거 확인
```
1. Apps Script 편집기 → 트리거 탭
2. autoSyncCheck 트리거가 있는지 확인
3. 없으면 다시 추가
```

### Q: 보호된 열을 수정했는데 막히지 않아요

**A**: onEdit 트리거 확인
```
1. Apps Script 편집기 → 트리거 탭
2. onEdit 트리거가 있는지 확인
3. 없으면 다시 추가
```

### Q: Node.js 스크립트가 자동 실행 안돼요

**A**: 작업 스케줄러 확인
```
1. 작업 스케줄러 열기
2. "Auto Sync eBay Shopify" 작업 확인
3. 마지막 실행 결과 확인
4. 실패 시 로그 확인
```

### Q: eBay API 오류가 나요

**A**: 인증 토큰 확인
```
1. .env 파일에서 EBAY_USER_TOKEN 확인
2. 토큰 만료 여부 확인 (90일 유효)
3. 필요시 새 토큰 발급
```

---

## 📊 로그 확인

### Apps Script 로그

```
1. Apps Script 편집기 열기
2. 실행 → autoSyncCheck 선택 → 실행
3. 하단 "실행 로그" 확인
```

### Node.js 로그

```bash
# 실시간 로그 확인
tail -f sync-log.txt

# 마지막 50줄 확인
tail -50 sync-log.txt
```

---

## 🎉 완료!

이제 다음과 같은 기능이 자동으로 작동합니다:

✅ 가격/재고 수정 시 자동 Pending 마킹
✅ 12시간마다 Pending 상태 확인
✅ 시트 상단에 알림 표시
✅ (옵션) 이메일 알림
✅ 매입가/무게 열 수정 차단
✅ Node.js로 eBay/Shopify API 자동 전송

**다음 단계:**
1. Google Apps Script 트리거 설정 완료
2. Windows 작업 스케줄러 설정 완료
3. 테스트 실행으로 동작 확인
4. 실전 사용!
