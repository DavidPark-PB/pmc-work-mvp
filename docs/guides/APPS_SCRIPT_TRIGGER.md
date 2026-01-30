# Google Apps Script 자동 트리거 설정 가이드

## 📋 개요

Google Sheets에서 자동으로 Node.js 스크립트를 실행할 수는 없지만, Apps Script로 동일한 기능을 구현하거나 외부 서버를 통해 트리거할 수 있습니다.

## 방법 1: 외부 서버에서 정기 실행 (추천)

### Windows Task Scheduler 사용

1. **작업 스케줄러 열기**
   - Windows 검색에서 "작업 스케줄러" 입력
   - 또는 `taskschd.msc` 실행

2. **새 작업 만들기**
   - 우측 패널 → "기본 작업 만들기" 클릭
   - 이름: `PMC Auto Sync`
   - 설명: `Shopify 자동 동기화 및 이상 징후 감지`

3. **트리거 설정**
   - 트리거: "매일" 또는 "매주"
   - 시간: 원하는 시간 선택 (예: 새벽 3시)
   - 반복 간격: 4시간마다 (선택사항)

4. **작업 설정**
   - 동작: "프로그램 시작"
   - 프로그램/스크립트:
     ```
     C:\Program Files\nodejs\node.exe
     ```
   - 인수 추가:
     ```
     "C:\Users\tooni\PMC work MVP\auto-sync-scheduler.js"
     ```
   - 시작 위치:
     ```
     C:\Users\tooni\PMC work MVP
     ```

5. **완료**
   - 설정 확인 후 완료

### 배치 파일 생성 (더 쉬운 방법)

프로젝트 폴더에 `auto-sync.bat` 파일 생성:

\`\`\`batch
@echo off
cd /d "C:\Users\tooni\PMC work MVP"
node auto-sync-scheduler.js
pause
\`\`\`

이 배치 파일을 Task Scheduler에 등록하면 됩니다.

## 방법 2: Google Apps Script로 웹훅 트리거

### 1. Node.js 서버를 계속 실행

프로젝트 폴더에서:

\`\`\`bash
npm install express
\`\`\`

### 2. 웹훅 서버 생성 (webhook-server.js)

\`\`\`javascript
const express = require('express');
const { exec } = require('child_process');
const app = express();
const PORT = 3000;

app.get('/trigger-sync', (req, res) => {
  console.log('🔔 동기화 트리거 받음:', new Date().toISOString());

  exec('node auto-sync-scheduler.js', (error, stdout, stderr) => {
    if (error) {
      console.error('Error:', error);
      res.status(500).send('Sync failed');
      return;
    }
    console.log(stdout);
    res.send('Sync triggered successfully');
  });
});

app.listen(PORT, () => {
  console.log(\`✅ 웹훅 서버 실행 중: http://localhost:\${PORT}\`);
  console.log(\`   트리거 URL: http://localhost:\${PORT}/trigger-sync\`);
});
\`\`\`

### 3. Google Apps Script 코드

스프레드시트에서 **확장 프로그램 > Apps Script** 클릭:

\`\`\`javascript
function triggerAutoSync() {
  const webhookUrl = 'http://YOUR_SERVER_IP:3000/trigger-sync';

  try {
    const response = UrlFetchApp.fetch(webhookUrl);
    Logger.log('Sync triggered: ' + response.getContentText());
  } catch (error) {
    Logger.log('Error: ' + error.toString());
  }
}

// 트리거 설정 함수
function setupTrigger() {
  // 기존 트리거 삭제
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // 매일 새벽 3시에 실행
  ScriptApp.newTrigger('triggerAutoSync')
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .create();

  // 4시간마다 실행
  ScriptApp.newTrigger('triggerAutoSync')
    .timeBased()
    .everyHours(4)
    .create();
}
\`\`\`

### 4. 트리거 활성화

Apps Script 에디터에서:
1. `setupTrigger` 함수 선택
2. 실행 버튼 클릭
3. 권한 승인

## 방법 3: 클라우드 서비스 사용 (가장 권장)

### GitHub Actions (무료)

프로젝트를 GitHub에 올리고 `.github/workflows/auto-sync.yml` 생성:

\`\`\`yaml
name: Auto Sync PMC

on:
  schedule:
    # 매일 UTC 18:00 (한국시간 새벽 3시)
    - cron: '0 18 * * *'
  workflow_dispatch: # 수동 실행 가능

jobs:
  sync:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v3

    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'

    - name: Install dependencies
      run: npm install

    - name: Run auto sync
      env:
        SHOPIFY_STORE_URL: \${{ secrets.SHOPIFY_STORE_URL }}
        SHOPIFY_ACCESS_TOKEN: \${{ secrets.SHOPIFY_ACCESS_TOKEN }}
        GOOGLE_SPREADSHEET_ID: \${{ secrets.GOOGLE_SPREADSHEET_ID }}
      run: node auto-sync-scheduler.js
\`\`\`

GitHub Secrets에 환경 변수 추가:
- `SHOPIFY_STORE_URL`
- `SHOPIFY_ACCESS_TOKEN`
- `GOOGLE_SPREADSHEET_ID`

## 📊 모니터링

동기화 로그 확인:

\`\`\`bash
node -e "console.log(JSON.stringify(require('./sync-log.json'), null, 2))"
\`\`\`

## 🔔 알림 설정 (선택사항)

Slack, Discord, 이메일 등으로 알림을 받으려면 webhook URL을 설정:

\`\`\`javascript
// auto-sync-scheduler.js에 추가
async function sendNotification(message) {
  const webhookUrl = 'YOUR_SLACK_WEBHOOK_URL';

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message })
  });
}
\`\`\`

## ⚠️ 주의사항

- PC가 꺼져있으면 Task Scheduler는 작동하지 않습니다
- 24/7 실행이 필요하다면 클라우드 서비스 사용을 권장합니다
- API 할당량을 고려하여 너무 자주 실행하지 마세요

## 추천 실행 주기

- **Shopify 동기화**: 4시간마다 또는 하루 2회
- **이상 징후 감지**: 하루 1회 (새벽)
- **재고 확인**: 하루 3-4회
