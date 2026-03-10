require('dotenv').config({ path: require('path').join(__dirname, '../config/.env') });
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const execPromise = util.promisify(exec);

/**
 * Auto-sync scheduler (Supabase-based)
 *
 * Steps:
 * 1. eBay price+shipping sync (API update)
 * 2. Anomaly detection
 * 3. Record sync history to Supabase
 *
 * Usage:
 *   node auto-sync-scheduler.js                # Full sync
 *   node auto-sync-scheduler.js --ebay-only    # eBay sync only
 *   node auto-sync-scheduler.js --dry-run      # Test mode
 *   node auto-sync-scheduler.js --limit=100    # eBay sync limit
 */

const projectRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const options = {
  ebayOnly: args.includes('--ebay-only'),
  dryRun: args.includes('--dry-run'),
  limit: parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0')
};

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
  log('자동 동기화 시작 (Supabase-based)');
  log('='.repeat(80));

  if (options.dryRun) {
    log('DRY RUN 모드 - 실제 업데이트 없음');
  }

  const results = {
    ebay: { status: 'skipped', success: 0, fail: 0 },
    anomalies: { status: 'skipped' },
    syncLog: { status: 'skipped' }
  };

  try {
    // 1. eBay price+shipping sync
    if (!options.ebayOnly || options.ebayOnly) {
      log('\nStep 1: eBay 가격+배송비 동기화 중...');
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

    // 2. Anomaly detection
    if (!options.ebayOnly) {
      log('\nStep 2: 이상 징후 감지 중...');
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

    // 3. Record sync history to Supabase
    log('\nStep 3: Supabase sync_history에 결과 기록 중...');
    try {
      const dataSource = require('../src/services/dataSource');
      const syncRepo = dataSource.getSyncRepo();
      await syncRepo.recordSync('all', 'auto_sync',
        Object.values(results).some(r => r.status === 'failed') ? 'partial' : 'success',
        results.ebay.success,
        null,
        { ebay: results.ebay, anomalies: results.anomalies.status, dryRun: options.dryRun }
      );
      results.syncLog.status = 'success';
      log('Supabase sync_history 기록 완료');
    } catch (error) {
      log(`Supabase 기록 실패: ${error.message}`);
      results.syncLog.status = 'failed';
    }

    logResults(log, results, timestamp);

  } catch (error) {
    log(`\n자동 동기화 에러: ${error.message}`);
    log(error.stack);
  }
}

function logResults(log, results, timestamp) {
  log('\n' + '='.repeat(80));
  log('동기화 결과 요약');
  log('='.repeat(80));
  log(`eBay: ${results.ebay.status} (성공: ${results.ebay.success}, 실패: ${results.ebay.fail})`);
  log(`이상 징후: ${results.anomalies.status}`);
  log(`Supabase 기록: ${results.syncLog.status}`);
  log('='.repeat(80));
  log(`\n자동 동기화 완료: ${new Date().toISOString()}`);
}

// Help
if (args.includes('--help')) {
  console.log(`
PMC 자동 동기화 스케줄러 (Supabase-based)

사용법:
  node auto-sync-scheduler.js [옵션]

옵션:
  --ebay-only     eBay 가격/배송비 동기화만 실행
  --dry-run       실제 업데이트 없이 테스트
  --limit=N       최대 N개 상품만 eBay 동기화
  --help          도움말 표시

실행 순서:
  1. eBay 가격+배송비 동기화
  2. 이상 징후 감지
  3. Supabase sync_history 기록
`);
  process.exit(0);
}

// Run
runAutoSync();
