require('dotenv').config({ path: '../../config/.env' });
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const execPromise = util.promisify(exec);

/**
 * 야간 이미지 자동 동기화 스크립트
 *
 * 매일 밤 12시에 실행되어 이미지 없는 상품 1,000개씩 동기화
 *
 * Windows 작업 스케줄러 등록:
 *   schtasks /create /tn "PMC NightlyImageSync" /tr "node \"C:\Users\tooni\PMC work MVP\nightly-image-sync.js\"" /sc daily /st 00:00
 *
 * 삭제:
 *   schtasks /delete /tn "PMC NightlyImageSync" /f
 */

const DAILY_LIMIT = 1000;  // 하루 처리량
const LOG_DIR = 'C:\\Users\\tooni\\PMC work MVP\\sync-logs';

async function runNightlySync() {
  const timestamp = new Date().toISOString();
  const dateStr = timestamp.slice(0, 10);

  // 로그 디렉토리 생성
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const logFile = `${LOG_DIR}\\image-sync-${dateStr}.log`;

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };

  log('='.repeat(70));
  log('🌙 야간 이미지 자동 동기화 시작');
  log('='.repeat(70));
  log(`일일 처리량: ${DAILY_LIMIT}개`);

  try {
    // sync-images-priority.js 실행 (전체 상품, 1000개 제한)
    const cmd = `node sync-images-priority.js --all --limit=${DAILY_LIMIT}`;

    log(`\n실행: ${cmd}\n`);

    const { stdout, stderr } = await execPromise(cmd, {
      cwd: 'C:\\Users\\tooni\\PMC work MVP',
      timeout: 3600000,  // 1시간 타임아웃
      maxBuffer: 10 * 1024 * 1024,  // 10MB 버퍼
    });

    // 결과 로그
    log('\n--- 실행 결과 ---');
    log(stdout);

    if (stderr) {
      log('\n--- 경고/오류 ---');
      log(stderr);
    }

    // 결과 파싱
    const successMatch = stdout.match(/성공: (\d+)개/);
    const failMatch = stdout.match(/실패: (\d+)개/);

    const result = {
      timestamp,
      success: successMatch ? parseInt(successMatch[1]) : 0,
      fail: failMatch ? parseInt(failMatch[1]) : 0,
      status: 'completed',
    };

    // JSON 로그 저장
    const jsonLogFile = 'C:\\Users\\tooni\\PMC work MVP\\image-sync-log.json';
    let logs = [];
    if (fs.existsSync(jsonLogFile)) {
      logs = JSON.parse(fs.readFileSync(jsonLogFile, 'utf8'));
    }
    logs.push(result);

    // 최근 30일 로그만 유지
    if (logs.length > 30) {
      logs = logs.slice(-30);
    }
    fs.writeFileSync(jsonLogFile, JSON.stringify(logs, null, 2));

    log(`\n✅ 야간 동기화 완료: 성공 ${result.success}개, 실패 ${result.fail}개`);

  } catch (error) {
    log(`\n❌ 오류 발생: ${error.message}`);
    log(error.stack);

    // 에러 로그 저장
    const jsonLogFile = 'C:\\Users\\tooni\\PMC work MVP\\image-sync-log.json';
    let logs = [];
    if (fs.existsSync(jsonLogFile)) {
      logs = JSON.parse(fs.readFileSync(jsonLogFile, 'utf8'));
    }
    logs.push({
      timestamp,
      status: 'error',
      error: error.message,
    });
    fs.writeFileSync(jsonLogFile, JSON.stringify(logs, null, 2));
  }

  log('\n' + '='.repeat(70));
  log('🌙 야간 동기화 종료');
  log('='.repeat(70));
}

// 도움말
if (process.argv.includes('--help')) {
  console.log(`
🌙 야간 이미지 자동 동기화 스크립트

매일 밤 12시에 실행되어 이미지 없는 상품 ${DAILY_LIMIT}개씩 동기화합니다.

Windows 작업 스케줄러 등록 (관리자 권한 필요):
  schtasks /create /tn "PMC NightlyImageSync" /tr "node \\"C:\\Users\\tooni\\PMC work MVP\\nightly-image-sync.js\\"" /sc daily /st 00:00

삭제:
  schtasks /delete /tn "PMC NightlyImageSync" /f

수동 실행:
  node nightly-image-sync.js

로그 확인:
  - 텍스트: sync-logs/image-sync-YYYY-MM-DD.log
  - JSON: image-sync-log.json
`);
  process.exit(0);
}

// 실행
runNightlySync();
