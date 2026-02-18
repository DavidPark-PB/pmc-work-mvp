require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

/**
 * 자동 동기화 스케줄러 (전 플랫폼)
 *
 * 실행 순서:
 * 1. Shopify 상품 동기화 (시트 업데이트)
 * 2. Naver 상품 동기화 (시트 업데이트)
 * 3. Alibaba 상품 동기화 (시트 업데이트)
 * 4. 30% 마진 수식 재적용 (J, K, L, M열)
 * 5. eBay 가격+배송비 동기화 (API 업데이트)
 * 6. 이상 징후 감지
 *
 * 사용법:
 *   node auto-sync-scheduler.js                # 전체 동기화
 *   node auto-sync-scheduler.js --ebay-only    # eBay 동기화만
 *   node auto-sync-scheduler.js --naver-only   # Naver 동기화만
 *   node auto-sync-scheduler.js --alibaba-only # Alibaba 동기화만
 *   node auto-sync-scheduler.js --dry-run      # 테스트 모드
 *   node auto-sync-scheduler.js --limit=100    # 100개만 eBay 동기화
 */

const projectRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const options = {
  ebayOnly: args.includes('--ebay-only'),
  naverOnly: args.includes('--naver-only'),
  alibabaOnly: args.includes('--alibaba-only'),
  dryRun: args.includes('--dry-run'),
  limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')
};

const singlePlatform = options.ebayOnly || options.naverOnly || options.alibabaOnly;

async function runAutoSync() {
  const timestamp = new Date().toISOString();
  const logDir = path.join(projectRoot, 'data', 'sync-logs');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, `autosync-${timestamp.slice(0, 10)}.log`);

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };

  log('='.repeat(80));
  log('자동 동기화 시작');
  log('='.repeat(80));

  if (options.dryRun) {
    log('DRY RUN 모드 - 실제 업데이트 없음');
  }

  const results = {
    shopify: { status: 'skipped' },
    naver: { status: 'skipped' },
    alibaba: { status: 'skipped' },
    formula: { status: 'skipped' },
    ebay: { status: 'skipped', success: 0, fail: 0 },
    anomalies: { status: 'skipped' }
  };

  try {
    // 1. Shopify 동기화
    if (!singlePlatform) {
      log('\nStep 1: Shopify 상품 동기화 중...');
      try {
        const { stdout } = await execPromise('node src/sync/sync-shopify-to-sheets.js', {
          cwd: projectRoot,
          timeout: 300000
        });
        log(stdout.split('\n').slice(-5).join('\n'));
        results.shopify.status = 'success';
      } catch (error) {
        log(`Shopify 동기화 실패: ${error.message}`);
        results.shopify.status = 'failed';
      }
    }

    // 2. Naver 동기화
    if (!singlePlatform || options.naverOnly) {
      log('\nStep 2: Naver 상품 동기화 중...');
      try {
        const { stdout } = await execPromise('node src/sync/sync-naver-to-sheets.js', {
          cwd: projectRoot,
          timeout: 600000
        });
        log(stdout.split('\n').slice(-5).join('\n'));
        results.naver.status = 'success';
      } catch (error) {
        log(`Naver 동기화 실패: ${error.message}`);
        results.naver.status = 'failed';
      }
      if (options.naverOnly) {
        logResults(log, results, timestamp);
        return;
      }
    }

    // 3. Alibaba 동기화
    if (!singlePlatform || options.alibabaOnly) {
      log('\nStep 3: Alibaba 상품 동기화 중...');
      try {
        const { stdout } = await execPromise('node src/sync/sync-alibaba-to-sheets.js', {
          cwd: projectRoot,
          timeout: 300000
        });
        log(stdout.split('\n').slice(-5).join('\n'));
        results.alibaba.status = 'success';
      } catch (error) {
        log(`Alibaba 동기화 실패: ${error.message}`);
        results.alibaba.status = 'failed';
      }
      if (options.alibabaOnly) {
        logResults(log, results, timestamp);
        return;
      }
    }

    // 4. 30% 마진 수식 재적용
    if (!singlePlatform) {
      log('\nStep 4: 30% 마진 수식 적용 중...');
      try {
        const { stdout } = await execPromise('node src/dashboard/fix-profit-formula.js', {
          cwd: projectRoot,
          timeout: 600000
        });
        log(stdout.split('\n').slice(-10).join('\n'));
        results.formula.status = 'success';
      } catch (error) {
        log(`수식 적용 실패: ${error.message}`);
        results.formula.status = 'failed';
      }
    }

    // 5. eBay 가격+배송비 동기화
    if (!singlePlatform || options.ebayOnly) {
      log('\nStep 5: eBay 가격+배송비 동기화 중...');
      try {
        let cmd = 'node src/sync/sync-ebay-price-shipping.js';
        if (options.dryRun) cmd += ' --dry-run';
        if (options.limit > 0) cmd += ` --limit=${options.limit}`;

        const { stdout } = await execPromise(cmd, {
          cwd: projectRoot,
          timeout: 7200000
        });

        const successMatch = stdout.match(/성공: (\d+)/);
        const failMatch = stdout.match(/실패: (\d+)/);

        results.ebay.success = successMatch ? parseInt(successMatch[1]) : 0;
        results.ebay.fail = failMatch ? parseInt(failMatch[1]) : 0;
        results.ebay.status = results.ebay.fail === 0 ? 'success' : 'partial';

        log(stdout.split('\n').slice(-15).join('\n'));
      } catch (error) {
        log(`eBay 동기화 실패: ${error.message}`);
        results.ebay.status = 'failed';
      }
    }

    // 6. 이상 징후 감지
    if (!singlePlatform) {
      log('\nStep 6: 이상 징후 감지 중...');
      try {
        const detectAnomalies = require('../src/utils/detect-anomalies');
        const anomalies = await detectAnomalies();

        const criticalCount = anomalies.lowMargin?.length || 0;
        if (criticalCount > 0) {
          log(`주의: ${criticalCount}개 상품에서 이상 징후 발견!`);
        } else {
          log('이상 징후 없음');
        }
        results.anomalies.status = 'success';
      } catch (error) {
        log(`이상 징후 감지 실패: ${error.message}`);
        results.anomalies.status = 'failed';
      }
    }

    logResults(log, results, timestamp);

  } catch (error) {
    log(`\n자동 동기화 에러: ${error.message}`);
    log(error.stack);

    saveSyncLog(timestamp, { status: 'error', error: error.message });
  }
}

function logResults(log, results, timestamp) {
  log('\n' + '='.repeat(80));
  log('동기화 결과 요약');
  log('='.repeat(80));
  log(`Shopify: ${results.shopify.status}`);
  log(`Naver: ${results.naver.status}`);
  log(`Alibaba: ${results.alibaba.status}`);
  log(`수식 적용: ${results.formula.status}`);
  log(`eBay: ${results.ebay.status} (성공: ${results.ebay.success}, 실패: ${results.ebay.fail})`);
  log(`이상 징후: ${results.anomalies.status}`);
  log('='.repeat(80));

  const logEntry = {
    timestamp,
    status: Object.values(results).some(r => r.status === 'failed') ? 'partial' : 'completed',
    shopify: results.shopify.status,
    naver: results.naver.status,
    alibaba: results.alibaba.status,
    formula: results.formula.status,
    ebay: results.ebay,
    anomalies: results.anomalies.status,
    note: options.dryRun ? 'DRY RUN' : `Shopify+Naver+Alibaba+eBay 동기화`
  };

  saveSyncLog(timestamp, logEntry);
  log(`\n자동 동기화 완료: ${new Date().toISOString()}`);
}

function saveSyncLog(timestamp, entry) {
  const jsonLogFile = path.join(projectRoot, 'data', 'sync-log.json');
  const dataDir = path.join(projectRoot, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  let logs = [];
  if (fs.existsSync(jsonLogFile)) {
    try { logs = JSON.parse(fs.readFileSync(jsonLogFile, 'utf8')); } catch (e) { logs = []; }
  }
  logs.push(entry);

  if (logs.length > 100) {
    logs = logs.slice(-100);
  }

  fs.writeFileSync(jsonLogFile, JSON.stringify(logs, null, 2));
}

// 도움말
if (args.includes('--help')) {
  console.log(`
PMC 자동 동기화 스케줄러

사용법:
  node auto-sync-scheduler.js [옵션]

옵션:
  --ebay-only     eBay 가격/배송비 동기화만 실행
  --naver-only    Naver 상품 동기화만 실행
  --alibaba-only  Alibaba 상품 동기화만 실행
  --dry-run       실제 업데이트 없이 테스트
  --limit=N       최대 N개 상품만 eBay 동기화
  --help          도움말 표시

실행 순서:
  1. Shopify 상품 동기화
  2. Naver 상품 동기화
  3. Alibaba 상품 동기화
  4. 30% 마진 수식 재적용
  5. eBay 가격+배송비 동기화
  6. 이상 징후 감지
`);
  process.exit(0);
}

// 실행
runAutoSync();
