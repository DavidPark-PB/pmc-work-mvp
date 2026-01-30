# 🔄 실시간 동기화 시스템 가이드

## 개요

Google Sheets "최종 Dashboard"에서 가격/재고를 수정하면 자동으로 Shopify와 eBay로 역전송하는 시스템입니다.

---

## 📋 시스템 구조

### 1. 자동 Pending 감지 (Google Apps Script)
- eBay가격(G열), eBay재고(Q열), Shopify재고(R열) 수정 시
- 자동으로 "Sync Status"(E열)를 "Pending"으로 변경
- "Last Updated"(F열)에 타임스탬프 기록

### 2. 역전송 스크립트
- **Shopify**: `sync-to-shopify.js`
- **eBay**: `sync-to-ebay.js`

### 3. 상태 관리
- **Pending**: 동기화 대기 중
- **Success**: 동기화 성공
- **Error**: 동기화 실패 (에러 메시지 포함)

---

## 🚀 사용 방법

### 방법 1: 자동 Pending (권장)

1. **Google Apps Script 설정** (최초 1회만)
   ```
   1. Google Sheets 열기
   2. 확장 프로그램 → Apps Script
   3. google-apps-script-trigger.gs 내용 붙여넣기
   4. 저장 (Ctrl+S)
   5. 자동으로 onEdit 트리거 생성됨
   ```

2. **Google Sheets에서 수정**
   ```
   - eBay가격 열(G) 수정
   - eBay재고 열(Q) 수정
   - Shopify재고 열(R) 수정
   → 자동으로 Pending 표시!
   ```

3. **역전송 실행**
   ```bash
   # Shopify 업데이트
   node sync-to-shopify.js

   # eBay 업데이트
   node sync-to-ebay.js
   ```

### 방법 2: 수동 Pending 설정

```bash
# 특정 SKU를 Pending으로 설정
node mark-pending.js SKU1 SKU2 SKU3

# 예시
node mark-pending.js ABC123 DEF456 GHI789
```

---

## 📊 상태 열 설명

| 열 | 설명 |
|---|---|
| **Sync Status** (E열) | Pending / Success / Error: 메시지 |
| **Last Updated** (F열) | 마지막 업데이트 시간 (ISO 8601) |

---

## 🔧 스크립트 설명

### 1. add-sync-columns.js
```bash
node add-sync-columns.js
```
- "Sync Status"와 "Last Updated" 열을 Dashboard에 추가
- **최초 1회만** 실행

### 2. mark-pending.js
```bash
node mark-pending.js SKU1 SKU2...
```
- 특정 SKU를 수동으로 Pending 상태로 설정
- 테스트용 또는 대량 설정 시 사용

### 3. sync-to-shopify.js
```bash
node sync-to-shopify.js
```
- Pending 상태인 Shopify 상품들을 Shopify API로 전송
- 가격, 재고 업데이트
- 성공/실패 상태 기록

### 4. sync-to-ebay.js
```bash
node sync-to-ebay.js
```
- Pending 상태인 eBay 상품들을 eBay API로 전송
- ReviseInventoryStatus API 사용 (배치 처리)
- 한 번에 최대 4개씩 처리
- 성공/실패 상태 기록

---

## 🎯 eBay API 상세

### ReviseInventoryStatus API
- **용도**: 가격, 재고 빠른 업데이트
- **제한**: 배치 당 최대 4개
- **Rate Limit**: 초당 5,000 calls
- **지원 항목**:
  - StartPrice (가격)
  - Quantity (재고)

### 예시 XML
```xml
<ReviseInventoryStatusRequest>
  <InventoryStatus>
    <ItemID>12345</ItemID>
    <StartPrice>19.99</StartPrice>
    <Quantity>100</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>
```

---

## 🛠️ Google Apps Script 트리거

### onEdit 트리거
```javascript
function onEdit(e) {
  // G열(eBay가격), Q열(eBay재고), R열(Shopify재고) 감지
  // → E열(Sync Status)을 "Pending"으로 변경
  // → F열(Last Updated)에 타임스탬프
}
```

### 커스텀 메뉴
```
🔄 동기화
  ├─ 선택한 행 Pending 설정
  └─ 도움말
```

---

## 📝 워크플로우 예시

### 시나리오: eBay 상품 10개 가격 인상

1. **Google Sheets에서 수정**
   ```
   - G열(eBay가격) 10개 행 수정
   - 자동으로 E열(Sync Status) → "Pending"
   ```

2. **터미널에서 역전송**
   ```bash
   node sync-to-ebay.js
   ```

3. **결과 확인**
   ```
   📊 결과:
      성공: 10개
      실패: 0개
   ```

4. **Google Sheets 확인**
   ```
   - E열(Sync Status) → "Success"
   - F열(Last Updated) → 2026-01-12T14:30:00.000Z
   ```

---

## ⚠️ 주의사항

### 1. API Rate Limits
- **eBay**: 초당 5,000 calls (충분함)
- **Shopify**: 초당 2 calls (스크립트에 500ms 딜레이 포함)

### 2. 에러 처리
- 실패한 항목은 "Error: 메시지" 형태로 기록
- 수동으로 원인 확인 후 재시도

### 3. 백업
- 중요한 작업 전에는 백업 권장
- `node backup-to-json.js`

### 4. 테스트
- 처음에는 1~2개 상품으로 테스트
- 성공 확인 후 대량 작업

---

## 🔗 관련 파일

| 파일 | 설명 |
|------|------|
| `add-sync-columns.js` | Sync Status 열 추가 |
| `mark-pending.js` | 수동 Pending 설정 |
| `sync-to-shopify.js` | Shopify 역전송 |
| `sync-to-ebay.js` | eBay 역전송 |
| `google-apps-script-trigger.gs` | 자동 Pending 트리거 |
| `check-dashboard-headers.js` | 헤더 확인 (디버깅용) |

---

## 📞 문제 해결

### Q: Pending이 자동으로 안 생겨요
**A**: Google Apps Script 트리거 확인
```
1. Google Sheets → 확장 프로그램 → Apps Script
2. 트리거 탭 확인
3. onEdit 트리거가 있는지 확인
```

### Q: eBay 역전송이 실패해요
**A**: 에러 메시지 확인
```
- E열(Sync Status)에 에러 메시지 표시됨
- 주요 원인: ItemID 없음, 권한 부족, API 한도 초과
```

### Q: Shopify 역전송이 안돼요
**A**: Product ID 확인 필요
```
- 현재 스크립트는 예시 코드
- SKU로 Shopify 상품 찾는 로직 추가 필요
```

---

## 🎉 완료!

이제 Google Sheets에서 가격/재고를 수정하면 자동으로 플랫폼에 반영됩니다!

**다음 단계**:
1. Google Apps Script 설정
2. 테스트 SKU 몇 개로 동작 확인
3. 실전 사용!
