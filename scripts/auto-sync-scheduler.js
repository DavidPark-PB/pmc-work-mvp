const path = require('path');
const { PROJECT_ROOT, LOGS_DIR, DATA_DIR } = require('../src/config');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const execPromise = util.promisify(exec);

/**
 * 자동 동기화 스케줄러 (eBay 가격/배송비 포함)
 *
 * 실행 순서:
 * 1. Shopify 상품 동기화 (시트 업데이트)
 * 2. 30% 마진 수식 재적용 (J, K, L, M열)
 * 3. eBay 가격+배송비 동기화 (API 업데이트)
 * 4. 이상 징후 감지
 * 5. 로그 기록
 *
 * 사용법:
 *   node auto-sync-scheduler.js                # 전체 동기화
 *   node auto-sync-scheduler.js --ebay-only    # eBay 동기화만
 *   node auto-sync-scheduler.js --dry-run      # 테스트 모드
 *   node auto-sync-scheduler.js --limit=100    # 100개만 eBay 동기화
 */

const args = process.argv.slice(2);
const options = {
  ebayOnly: args.includes('--ebay-only'),
  dryRun: args.includes('--dry-run'),
  limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')
};

async function runAutoSync() {
  const timestamp = new Date().toISOString();

  // 로그 디렉토리 생성
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const logFile = path.join(LOGS_DIR, `autosync-${timestamp.slice(0, 10)}.log`);

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };

  log('='.repeat(80));
  log('🤖 자동 동기화 시작');
  log('='.repeat(80));

  if (options.dryRun) {
    log('⚠️  DRY RUN 모드 - 실제 업데이트 없음');
  }

  const results = {
    shopify: { status: 'skipped' },
    formula: { status: 'skipped' },
    ebay: { status: 'skipped', success: 0, fail: 0 },
    anomalies: { status: 'skipped' }
  };

  try {
    // 1. Shopify 동기화 (ebayOnly가 아닌 경우)
    if (!options.ebayOnly) {
      log('\n📥 Step 1: Shopify 상품 동기화 중...');
      try {
        const { stdout } = await execPromise('node src/sync/sync-shopify-to-sheets.js', {
          cwd: PROJECT_ROOT,
          timeout: 300000  // 5분 타임아웃
        });
        log(stdout.split('\n').slice(-5).join('\n'));  // 마지막 5줄만
        results.shopify.status = 'success';
      } catch (error) {
        log(`⚠️  Shopify 동기화 실패: ${error.message}`);
        results.shopify.status = 'failed';
      }

      // 2. 30% 마진 수식 재적용
      log('\n📐 Step 2: 30% 마진 수식 적용 중...');
      try {
        const { stdout } = await execPromise('node src/dashboard/fix-profit-formula.js', {
          cwd: PROJECT_ROOT,
          timeout: 600000  // 10분 타임아웃
        });
        log(stdout.split('\n').slice(-10).join('\n'));  // 마지막 10줄만
        results.formula.status = 'success';
      } catch (error) {
        log(`⚠️  수식 적용 실패: ${error.message}`);
        results.formula.status = 'failed';
      }
    }

    // 3. eBay 가격+배송비 동기화
    log('\n📦 Step 3: eBay 가격+배송비 동기화 중...');
    try {
      let cmd = 'node src/sync/sync-ebay-price-shipping.js';
      if (options.dryRun) cmd += ' --dry-run';
      if (options.limit > 0) cmd += ` --limit=${options.limit}`;

      const { stdout } = await execPromise(cmd, {
        cwd: PROJECT_ROOT,
        timeout: 7200000  // 2시간 타임아웃 (2663개 × 0.5초 = 약 22분)
      });

      // 결과 파싱
      const successMatch = stdout.match(/성공: (\d+)/);
      const failMatch = stdout.match(/실패: (\d+)/);

      results.ebay.success = successMatch ? parseInt(successMatch[1]) : 0;
      results.ebay.fail = failMatch ? parseInt(failMatch[1]) : 0;
      results.ebay.status = results.ebay.fail === 0 ? 'success' : 'partial';

      log(stdout.split('\n').slice(-15).join('\n'));  // 마지막 15줄
    } catch (error) {
      log(`⚠️  eBay 동기화 실패: ${error.message}`);
      results.ebay.status = 'failed';
    }

    // 4. 이상 징후 감지 (ebayOnly가 아닌 경우)
    if (!options.ebayOnly) {
      log('\n🔍 Step 4: 이상 징후 감지 중...');
      try {
        const detectAnomalies = require('../src/utils/detect-anomalies');
        const anomalies = await detectAnomalies();

        const criticalCount = anomalies.lowMargin?.length || 0;
        if (criticalCount > 0) {
          log(`🚨 주의 필요: ${criticalCount}개 상품에서 이상 징후 발견!`);
        } else {
          log('✅ 이상 징후 없음');
        }
        results.anomalies.status = 'success';
      } catch (error) {
        log(`⚠️  이상 징후 감지 실패: ${error.message}`);
        results.anomalies.status = 'failed';
      }
    }

    // 5. 결과 요약
    log('\n' + '='.repeat(80));
    log('📊 동기화 결과 요약');
    log('='.repeat(80));
    log(`Shopify 동기화: ${results.shopify.status}`);
    log(`수식 적용: ${results.formula.status}`);
    log(`eBay 동기화: ${results.ebay.status} (성공: ${results.ebay.success}, 실패: ${results.ebay.fail})`);
    log(`이상 징후 감지: ${results.anomalies.status}`);
    log('='.repeat(80));

    // 6. sync-log.json 업데이트
    const logEntry = {
      timestamp,
      status: results.ebay.fail === 0 ? 'completed' : 'partial',
      shopify: results.shopify.status,
      formula: results.formula.status,
      ebay: results.ebay,
      anomalies: results.anomalies.status,
      note: options.dryRun ? 'DRY RUN' : `eBay: ${results.ebay.success}개 성공`
    };

    const jsonLogFile = path.join(DATA_DIR, 'sync-log.json');
    let logs = [];
    if (fs.existsSync(jsonLogFile)) {
      logs = JSON.parse(fs.readFileSync(jsonLogFile, 'utf8'));
    }
    logs.push(logEntry);

    // 최근 100개 로그만 유지
    if (logs.length > 100) {
      logs = logs.slice(-100);
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(jsonLogFile, JSON.stringify(logs, null, 2));

    log(`\n✅ 자동 동기화 완료: ${new Date().toISOString()}`);

  } catch (error) {
    log(`\n❌ 자동 동기화 에러: ${error.message}`);
    log(error.stack);

    // 에러 로그 저장
    const errorLog = {
      timestamp,
      status: 'error',
      error: error.message
    };

    const jsonLogFile = path.join(DATA_DIR, 'sync-log.json');
    let logs = [];
    if (fs.existsSync(jsonLogFile)) {
      logs = JSON.parse(fs.readFileSync(jsonLogFile, 'utf8'));
    }
    logs.push(errorLog);
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(jsonLogFile, JSON.stringify(logs, null, 2));
  }
}

// 도움말
if (args.includes('--help')) {
  console.log(`
🤖 PMC 자동 동기화 스케줄러

사용법:
  node scripts/auto-sync-scheduler.js [옵션]

옵션:
  --ebay-only   eBay 가격/배송비 동기화만 실행
  --dry-run     실제 업데이트 없이 테스트
  --limit=N     최대 N개 상품만 eBay 동기화
  --help        도움말 표시

실행 순서:
  1. Shopify 상품 동기화 (시트 업데이트)
  2. 30% 마진 수식 재적용 (J, K, L, M열)
  3. eBay 가격+배송비 동기화 (ReviseItem API)
  4. 이상 징후 감지

예시:
  node scripts/auto-sync-scheduler.js                 # 전체 동기화
  node scripts/auto-sync-scheduler.js --ebay-only     # eBay만
  node scripts/auto-sync-scheduler.js --dry-run       # 테스트
  node scripts/auto-sync-scheduler.js --limit=100     # 100개만
`);
  process.exit(0);
}

// 실행
runAutoSync();
