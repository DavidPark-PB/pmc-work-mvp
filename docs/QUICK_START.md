# ⚡ 빠른 시작 가이드

## 🎯 5분 안에 설정하기

### 1단계: Google Apps Script 설정 (2분)

```
1. Google Sheets 열기
2. 확장 프로그램 → Apps Script
3. google-apps-script-autosync.gs 내용 복사 붙여넣기
4. 저장 (Ctrl+S)
5. 트리거 아이콘 클릭 → 트리거 추가
   - 함수: autoSyncCheck
   - 시간 간격: 12시간마다
6. 저장 → 권한 허용
```

### 2단계: Windows 작업 스케줄러 (3분)

```
1. 시작 → "작업 스케줄러" 검색
2. 기본 작업 만들기
   - 이름: Auto Sync
   - 트리거: 매일, 12시간마다
   - 프로그램: C:\Program Files\nodejs\node.exe
   - 인수: "C:\Users\tooni\PMC work MVP\auto-sync-all.js"
3. 완료
```

### 3단계: 테스트 (1분)

```bash
# 터미널에서 실행
cd "C:\Users\tooni\PMC work MVP"
node auto-sync-all.js
```

✅ **완료!** 이제 12시간마다 자동으로 동기화됩니다.

---

## 📋 주요 명령어

### 수동 동기화
```bash
node auto-sync-all.js
```

### eBay만 동기화
```bash
node sync-to-ebay.js
```

### Shopify만 동기화
```bash
node sync-to-shopify.js
```

### 상태 확인
```
Google Sheets → 메뉴: 🔄 동기화 → 지금 동기화 상태 확인
```

---

## 🔒 안전 장치

✅ 매입가 수정 차단
✅ 무게(kg) 수정 차단
✅ Pending 상태인 항목만 동기화
✅ 오류 시 자동 재시도

---

## 📧 이메일 알림 켜기

`google-apps-script-autosync.gs` 수정:

```javascript
const CONFIG = {
  ADMIN_EMAIL: 'your-email@example.com',  // ← 이메일 입력
  SEND_EMAIL_ALERTS: true  // ← true로 변경
};
```

---

## 🆘 문제 해결

### 트리거 안 돌아감?
→ Apps Script → 트리거 탭 확인

### 스크립트 오류?
→ `node auto-sync-all.js` 실행해서 오류 확인

### API 오류?
→ `.env` 파일에서 토큰 확인

---

**전체 가이드**: [AUTO_SYNC_SETUP.md](./AUTO_SYNC_SETUP.md)
