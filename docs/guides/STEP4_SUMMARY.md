# 🚀 4단계: 실시간 동기화 & 자동 알림 시스템 완료

## ✅ 구현된 기능

### 1. 이상 징후 감지 시스템

**파일**: [detect-anomalies.js](detect-anomalies.js)

**감지 조건:**
- 🔴 **마진 위험**: 마진율 < 5%
- ⚠️  **재고 부족**: 현재고 < 일평균 판매량 × 14일
- 📉 **판매 급감**: 최근 7일 판매량 < 직전 3주 평균의 30%
- 🚨 **복합 문제**: 2개 이상 이슈 동시 발생

**실행 방법:**
\`\`\`bash
node detect-anomalies.js
\`\`\`

**출력:**
- 콘솔에 상세 리포트 출력
- `anomalies-report.json` 파일 생성 (대시보드용)

### 2. 자동 동기화 스케줄러

**파일**: [auto-sync-scheduler.js](auto-sync-scheduler.js)

**동작:**
1. Shopify 상품 데이터 동기화
2. 이상 징후 자동 감지
3. 실행 로그 자동 저장 (`sync-log.json`)

**실행 방법:**
\`\`\`bash
# 명령어로 실행
node auto-sync-scheduler.js

# 또는 배치 파일 더블클릭
auto-sync.bat
\`\`\`

### 3. 대시보드 필터 로직

**파일**: [dashboard-filters.js](dashboard-filters.js)

**필터 기능:**
- `filterByStatus(status)` - 검수 상태별 필터
- `filterByPlatform(platform)` - 플랫폼별 필터
- `filterByMargin(min, max)` - 마진율 범위 필터
- `filterAnomalies()` - 이상 징후만 필터
- `getPendingReview()` - 검수 대기 상품 (알바생용)
- `getStatistics()` - 전체 통계

**사용 예시:**
\`\`\`javascript
const DashboardFilters = require('./dashboard-filters');

const dashboard = new DashboardFilters();
await dashboard.initialize();

// 검수 대기 상품만
const pending = dashboard.getPendingReview();

// 마진 위험 상품만
const risky = dashboard.filterByMargin(0, 5);

// 통계
const stats = dashboard.getStatistics();
\`\`\`

### 4. 자동 실행 트리거 가이드

**파일**: [APPS_SCRIPT_TRIGGER.md](APPS_SCRIPT_TRIGGER.md)

**3가지 방법 제공:**

#### 방법 1: Windows Task Scheduler (로컬 PC)
- 매일 새벽 3시 자동 실행
- 또는 4시간마다 반복 실행
- `auto-sync.bat` 파일 등록

#### 방법 2: Google Apps Script 웹훅
- Google Sheets에서 직접 트리거
- 시간 기반 자동 실행
- 로컬 서버와 연동

#### 방법 3: GitHub Actions (클라우드, 추천)
- 24/7 무중단 실행
- 무료 (월 2000분)
- 가장 안정적

## 📊 필요한 추가 컬럼 (스프레드시트)

현재 구조에 다음 컬럼 추가 필요:

| 컬럼 | 내용 | 설명 |
|------|------|------|
| L | 재고 | 현재 재고 수량 |
| M | 최근 7일 판매량 | 판매 추이 분석용 |
| N | 직전 3주 평균 판매량 | 비교 기준 |

**수동 입력** 또는 **Shopify API로 자동 동기화**

## 🎯 알바생 검수 모드 구현 예시

웹 대시보드에서 사용할 API 엔드포인트:

\`\`\`javascript
// Express.js 예시
const express = require('express');
const DashboardFilters = require('./dashboard-filters');
const GoogleSheetsAPI = require('./googleSheetsAPI');

const app = express();
const dashboard = new DashboardFilters();
const sheets = new GoogleSheetsAPI('./credentials.json');

// 검수 대기 상품 가져오기
app.get('/api/pending-review', async (req, res) => {
  await dashboard.initialize();
  const pending = dashboard.getPendingReview();
  res.json(pending);
});

// 상품 상태 업데이트
app.post('/api/update-status', async (req, res) => {
  const { rowNum, status } = req.body;

  await sheets.authenticate();
  await sheets.writeData(SPREADSHEET_ID, \`시트1!J\${rowNum}\`, [[status]]);

  res.json({ success: true });
});

// 다음 상품으로 이동
app.get('/api/next-product/:currentRow', async (req, res) => {
  await dashboard.initialize();
  const pending = dashboard.getPendingReview();

  const currentIndex = pending.findIndex(p => p.index === parseInt(req.params.currentRow));
  const next = pending[currentIndex + 1];

  res.json(next || { done: true });
});
\`\`\`

## 📱 알바생 UI 예시 (간단한 HTML)

\`\`\`html
<!DOCTYPE html>
<html>
<head>
  <title>PMC 상품 검수</title>
  <style>
    .product-card {
      max-width: 600px;
      margin: 50px auto;
      padding: 30px;
      border: 2px solid #ddd;
      border-radius: 10px;
    }
    .product-image {
      width: 100%;
      max-height: 400px;
      object-fit: contain;
    }
    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    button {
      flex: 1;
      padding: 15px;
      font-size: 18px;
      cursor: pointer;
    }
    .btn-pass { background: #4CAF50; color: white; }
    .btn-adjust { background: #FF9800; color: white; }
    .btn-delete { background: #f44336; color: white; }
  </style>
</head>
<body>
  <div class="product-card" id="product-card">
    <h2 id="product-name">로딩 중...</h2>
    <img id="product-image" class="product-image" src="">
    <p><strong>SKU:</strong> <span id="sku"></span></p>
    <p><strong>판매가:</strong> $<span id="price"></span></p>
    <p><strong>마진율:</strong> <span id="margin"></span>%</p>
    <p><strong>순이익:</strong> <span id="profit"></span> KRW</p>

    <div class="buttons">
      <button class="btn-pass" onclick="updateStatus('검수완료')">✅ 유지</button>
      <button class="btn-adjust" onclick="updateStatus('가격조정필요')">⚠️ 수정</button>
      <button class="btn-delete" onclick="updateStatus('삭제예정')">❌ 삭제</button>
    </div>
  </div>

  <script>
    let currentRow = 0;

    async function loadNextProduct() {
      const response = await fetch(\`/api/next-product/\${currentRow}\`);
      const product = await response.json();

      if (product.done) {
        alert('모든 상품 검수 완료!');
        return;
      }

      currentRow = product.index;
      document.getElementById('product-name').textContent = product.name;
      document.getElementById('sku').textContent = product.sku;
      document.getElementById('price').textContent = product.price;
      document.getElementById('margin').textContent = product.margin.toFixed(2);
      document.getElementById('profit').textContent = product.profit.toLocaleString();
      // 상품 이미지는 Shopify API로 가져와야 함
    }

    async function updateStatus(status) {
      await fetch('/api/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNum: currentRow, status })
      });

      loadNextProduct();
    }

    // 페이지 로드 시 첫 상품 로드
    loadNextProduct();
  </script>
</body>
</html>
\`\`\`

## 🔔 알림 설정 (선택사항)

Slack, Discord, 이메일로 이상 징후 알림:

\`\`\`javascript
// auto-sync-scheduler.js에 추가
async function sendSlackNotification(anomalies) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const criticalCount = anomalies.lowMargin.length + anomalies.multipleIssues.length;

  if (criticalCount > 0) {
    const message = {
      text: \`🚨 PMC 시스템 알림\`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: \`*\${criticalCount}개 상품에서 심각한 이슈 발견!*\n\n• 마진 위험: \${anomalies.lowMargin.length}개\n• 복합 문제: \${anomalies.multipleIssues.length}개\`
          }
        }
      ]
    };

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message)
    });
  }
}
\`\`\`

## 📦 다음 단계: eBay 연동 (5단계)

4단계가 완료되었으므로 이제 eBay 통합 준비:
1. eBay Developer 계정 생성
2. API 키 발급
3. eBay 상품 동기화 스크립트
4. 플랫폼별 분석 대시보드

## 🎉 완료!

4단계 구현이 완료되었습니다. 이제 시스템이 자동으로:
- ✅ 상품 데이터 동기화
- ✅ 이상 징후 감지
- ✅ 검수 대기 상품 필터링
- ✅ 실행 로그 기록

다음은 eBay 연동이나 웹 대시보드 구축으로 넘어갈 수 있습니다!
