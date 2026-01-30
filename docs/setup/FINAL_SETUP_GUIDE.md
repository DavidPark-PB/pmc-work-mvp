# 🎉 최종 설정 완료 가이드

## ✅ 완료된 작업 요약

대표님의 eBay/Shopify 통합 관리 시스템이 모두 완성되었습니다!

---

## 📊 시스템 구성

### 1. Dashboard 업데이트 완료

#### ✅ 칼럼명 변경
- `eBay가격(USD)` → `판매가(USD)`
- `eBay배송비(USD)` → `국제 배송비(USD)`
- `eBay수수료(USD)` → `플랫폼 수수료(USD)`

#### ✅ 데이터 보호
- `🔒 매입가` - 헤더에 보호 표시 추가
- `🔒 무게(kg)` - 헤더에 보호 표시 추가
- Apps Script에서 수정 차단 기능 구현
- Node.js 스크립트에서 접근 금지

#### ✅ 지능형 수식 적용
1. **정산액(KRW)** = (판매가 + 배송비 - 수수료) × 1400 - 세금
2. **최종순이익(KRW)** = 정산액 - 배송비 - 매입가
3. **마진율(%)** = 최종순이익 / 정산액

#### ✅ 플랫폼별 수수료 차별화
- eBay만: 18% 수수료
- Shopify만: 3.3% 수수료
- 양쪽: 18% 수수료 (eBay 기준)

#### ✅ Shopify 데이터 통합
- 3,742개 가격 데이터 통합
- 빈 칸만 채우고 기존 값 보존

#### ✅ 배송비 최적화
- 1,701개 상품 배송비 재계산
- YunExpress vs K-Packet 비교 (최저가 선택)

### 2. 자동 동기화 시스템

#### ✅ Google Apps Script
- 파일: `google-apps-script-autosync.gs`
- 기능:
  - 가격/재고 수정 시 자동 Pending 마킹
  - 12시간마다 자동 체크
  - 매입가/무게 수정 차단
  - A1 셀에 알림 표시
  - 이메일 알림 옵션

#### ✅ Node.js 동기화 스크립트
- 파일: `auto-sync-all.js`
- 기능:
  - Pending 상품 자동 검색
  - eBay API 전송
  - Shopify API 전송
  - 성공/실패 기록

#### ✅ Windows 작업 스케줄러
- 배치 파일: `auto-sync.bat`
- 12시간마다 자동 실행

### 3. Sync_Log 시트

#### ✅ 로그 기록 시스템
- 실행 시각
- 실행 유형 (수동/자동)
- 플랫폼별 성공/실패 수
- 오류 상세
- 실행 시간

---

## 🔧 수동 설정 필요 항목

### 1. 열 보호 설정 (5분)

1. [Google Sheets 열기](https://docs.google.com/spreadsheets/d/1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M)

2. **F열 (매입가) 보호**
   ```
   - F열 전체 클릭
   - 마우스 우클릭 → "범위 보호"
   - 설명: "매입가 - 수동 관리 필수"
   - 권한: "나만 수정 가능"
   - 완료
   ```

3. **O열 (무게) 보호**
   ```
   - O열 전체 클릭
   - 마우스 우클릭 → "범위 보호"
   - 설명: "무게(kg) - 수동 관리 필수"
   - 권한: "나만 수정 가능"
   - 완료
   ```

### 2. 조건부 서식 설정 (10분)

#### 📌 역마진 알림 (연한 빨간색)

```
1. 범위 선택: A2:Y10000
2. 서식 → 조건부 서식
3. 맞춤 수식: =M2<0
4. 서식 스타일:
   - 배경색: #F4CCCC (연한 빨간색)
5. 완료
```

**효과**: 최종순이익이 마이너스인 역마진 상품은 빨간색으로 표시됩니다.

#### 📌 효자 상품 (연한 파란색)

```
1. 범위 선택: A2:Y10000
2. 서식 → 조건부 서식
3. 맞춤 수식: =N2>=0.2
4. 서식 스타일:
   - 배경색: #CFE2F3 (연한 파란색)
5. 완료
```

**효과**: 마진율 20% 이상인 효자 상품은 파란색으로 표시됩니다.

#### 📌 Sync_Log 조건부 서식

**성공 상태 (초록색)**
```
1. Sync_Log 시트 열기
2. 범위: J2:J1000 (상태 열)
3. 서식 → 조건부 서식
4. 텍스트에 "완료" 포함
5. 배경색: #D9EAD3 (연한 초록색)
```

**오류 상태 (빨간색)**
```
1. 범위: J2:J1000
2. 서식 → 조건부 서식
3. 텍스트에 "오류" 포함
4. 배경색: #F4CCCC (연한 빨간색)
```

### 3. Google Apps Script 트리거 설정 (5분)

1. [Google Sheets](https://docs.google.com/spreadsheets/d/1ArkhXbz8rRTQP2yO4FQKCJSYx-9Tj8c0opz0cHQXD8M) 열기

2. 메뉴: **확장 프로그램 → Apps Script**

3. 기존 코드 삭제하고 `google-apps-script-autosync.gs` 내용 붙여넣기

4. **저장** (Ctrl+S)

5. **트리거 설정**:
   ```
   트리거 아이콘 클릭 → 트리거 추가

   [트리거 1]
   - 함수: autoSyncCheck
   - 이벤트 소스: 시간 기반
   - 시간 간격: 12시간마다

   [트리거 2]
   - 함수: onEdit
   - 이벤트 소스: 스프레드시트에서
   - 이벤트 유형: 수정 시
   ```

6. **권한 허용**

### 4. Windows 작업 스케줄러 설정 (5분)

1. 시작 → "**작업 스케줄러**" 검색

2. **기본 작업 만들기**
   ```
   이름: Auto Sync eBay Shopify
   트리거: 매일, 되풀이 12시간
   프로그램: C:\Program Files\nodejs\node.exe
   인수: "C:\Users\tooni\PMC work MVP\auto-sync-all.js"
   시작 위치: C:\Users\tooni\PMC work MVP
   ```

3. **완료**

4. 작업 속성 열기:
   ```
   조건 탭:
   - [ ] "컴퓨터의 전원이 AC 전원일 때만" 체크 해제

   설정 탭:
   - [x] "작업이 실패하면 다시 시작" → 1분
   ```

---

## 🚀 사용 방법

### 일상 업무

1. **가격/재고 수정**
   ```
   Google Sheets에서 판매가, eBay재고, Shopify재고 수정
   → 자동으로 Pending 마킹 (노란색)
   ```

2. **매입가/무게 입력**
   ```
   🔒 매입가 열: 상품 구매 가격 입력
   🔒 무게(kg) 열: 상품 무게 입력
   → 다른 수식들이 자동 계산됨
   ```

3. **역마진 확인**
   ```
   빨간색으로 표시된 행 확인
   → 가격 조정 필요
   ```

4. **효자 상품 확인**
   ```
   파란색으로 표시된 행 확인
   → 마진율 20% 이상
   ```

### 동기화

#### 자동 동기화 (권장)
```
12시간마다 자동 실행됨
→ A1 셀에 알림 표시
→ Node.js 스크립트 자동 실행
→ Sync_Log에 기록
```

#### 수동 동기화
```bash
# 터미널에서
cd "C:\Users\tooni\PMC work MVP"
node auto-sync-all.js
```

또는

```
auto-sync.bat 더블클릭
```

#### 시트 메뉴 사용
```
🔄 동기화 메뉴:
- 📊 지금 동기화 상태 확인
- 🔄 선택한 행 Pending 설정
- ⚙️ 자동 동기화 체크 실행
```

---

## 📋 주요 파일 목록

### 실행 스크립트
- ✅ `final-dashboard-update.js` - 최종 수식 업데이트
- ✅ `auto-sync-all.js` - 통합 자동 동기화
- ✅ `sync-to-ebay.js` - eBay 전용 동기화
- ✅ `sync-to-shopify.js` - Shopify 전용 동기화
- ✅ `create-sync-log.js` - Sync_Log 시트 생성
- ✅ `auto-sync.bat` - Windows 배치 파일

### Google Apps Script
- ✅ `google-apps-script-autosync.gs` - 자동 감지 및 보호

### 가이드 문서
- ✅ `AUTO_SYNC_SETUP.md` - 자동 동기화 상세 가이드
- ✅ `QUICK_START.md` - 5분 빠른 시작
- ✅ `SYNC_GUIDE.md` - 동기화 시스템 가이드
- ✅ `FINAL_SETUP_GUIDE.md` - 이 문서

---

## 🔒 안전 장치

### 3중 보호 시스템

**1단계: Google Apps Script (onEdit)**
```javascript
// 매입가(F열), 무게(O열) 수정 시도 시
→ 경고 알림 표시
→ 변경사항 자동 취소
```

**2단계: Google Sheets 범위 보호**
```
F열, O열에 범위 보호 설정
→ 대표님만 수정 가능
```

**3단계: Node.js 스크립트**
```javascript
PROTECTED_COLUMNS: ['매입가', '무게(kg)']
→ 절대 읽거나 수정하지 않음
→ 로그에 보호 상태 기록
```

---

## 🎯 핵심 기능

### 1. 실시간 계산
```
매입가 입력 → 즉시 마진율 계산
무게 입력 → 즉시 배송비 계산
판매가 변경 → 즉시 정산액 계산
```

### 2. 역마진 방지
```
최종순이익 < 0
→ 빨간색 하이라이트
→ 즉시 확인 가능
```

### 3. 효자 상품 발굴
```
마진율 >= 20%
→ 파란색 하이라이트
→ 집중 관리 가능
```

### 4. 플랫폼 최적화
```
eBay: 18% 수수료 자동 계산
Shopify: 3.3% 수수료 자동 계산
→ 정확한 순이익 산출
```

### 5. 배송비 최적화
```
무게 입력 시:
- YunExpress 요율 계산
- K-Packet 요율 계산
- 자동으로 저렴한 것 선택
```

---

## 📊 데이터 흐름

```
[입력 데이터]
↓
매입가, 무게(kg) 입력 (🔒 보호됨)
↓
판매가, 배송비 입력 (또는 Shopify에서 자동)
↓
[자동 계산]
↓
플랫폼 수수료 → 정산액 → 배송비 → 최종순이익 → 마진율
↓
[색상 표시]
↓
역마진: 빨간색 / 효자상품: 파란색
↓
[동기화]
↓
Pending 마킹 → eBay/Shopify API 전송 → Success
```

---

## 🛠️ 문제 해결

### Q: 매입가가 수정이 안돼요
**A**: 정상입니다. 범위 보호를 먼저 확인하세요.
```
1. Google Sheets → 데이터 → 보호된 시트 및 범위
2. F열 보호 확인
3. 본인만 수정 가능하도록 설정되어 있는지 확인
```

### Q: 수식이 작동하지 않아요
**A**: 수식을 다시 적용하세요.
```bash
cd "C:\Users\tooni\PMC work MVP"
node final-dashboard-update.js
```

### Q: 자동 동기화가 안돼요
**A**: 트리거와 작업 스케줄러를 확인하세요.
```
1. Apps Script → 트리거 탭 → autoSyncCheck 확인
2. 작업 스케줄러 → "Auto Sync eBay Shopify" 확인
3. 마지막 실행 결과 확인
```

### Q: API 오류가 나요
**A**: 인증 토큰을 확인하세요.
```
1. .env 파일 확인
2. EBAY_USER_TOKEN 만료 여부 확인 (90일 유효)
3. SHOPIFY_ACCESS_TOKEN 확인
```

---

## 📞 추가 지원

### 로그 확인
```bash
# Sync_Log 시트에서 확인
# 또는 터미널에서
tail -f sync-log.txt
```

### 수동 백업
```bash
node backup-to-json.js
```

### 테스트 실행
```bash
# 소수 상품으로 테스트
node auto-sync-all.js
```

---

## 🎊 완료!

이제 모든 시스템이 준비되었습니다!

### ✅ 체크리스트

- [ ] 열 보호 설정 완료 (F, O열)
- [ ] 조건부 서식 설정 완료 (역마진, 효자상품)
- [ ] Google Apps Script 트리거 설정 완료
- [ ] Windows 작업 스케줄러 설정 완료
- [ ] 테스트 실행으로 동작 확인

### 📧 이메일 알림 설정 (선택사항)

`google-apps-script-autosync.gs` 파일에서:

```javascript
const CONFIG = {
  ADMIN_EMAIL: 'your-email@example.com',  // ← 이메일 입력
  SEND_EMAIL_ALERTS: true  // ← true로 변경
};
```

---

**모든 준비가 완료되었습니다!** 🎉

이제 편하게 상품을 관리하시고, 마진율을 실시간으로 확인하세요!
