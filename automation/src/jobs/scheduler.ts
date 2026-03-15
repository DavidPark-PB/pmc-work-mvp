/**
 * 통합 잡 스케줄러
 *
 * 서버 시작 시 자동으로 주기적 작업을 등록하고 실행.
 * 외부 의존성(BullMQ, Redis) 없이 setInterval 기반으로 동작.
 *
 * 등록된 잡:
 *   ebay-token-refresh  — 90분마다 eBay OAuth 토큰 선제 갱신
 *   inventory-sync      — 30분마다 eBay/Shopify 재고 동기화
 *   anomaly-detect      — 6시간마다 역마진/저마진 리스팅 감지
 */
import { logger } from '../lib/logger.js';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { syncAllInventory } from '../services/inventory-sync.js';
import { detectAnomalies } from './anomaly-detector.js';

// ─── 타입 ─────────────────────────────────────────────

interface JobConfig {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  runOnStart?: boolean; // 서버 시작 직후 1회 즉시 실행 여부
}

interface JobStatus {
  name: string;
  intervalMs: number;
  lastRunAt: Date | null;
  lastResult: 'ok' | 'error' | 'pending';
  lastError?: string;
  runCount: number;
}

// ─── 스케줄러 ──────────────────────────────────────────

const jobStatuses = new Map<string, JobStatus>();
const jobTimers = new Map<string, NodeJS.Timeout>();
const jobRunning = new Map<string, boolean>(); // 동시 실행 방지 락

function registerJob(config: JobConfig): void {
  const status: JobStatus = {
    name: config.name,
    intervalMs: config.intervalMs,
    lastRunAt: null,
    lastResult: 'pending',
    runCount: 0,
  };
  jobStatuses.set(config.name, status);
  jobRunning.set(config.name, false);

  const run = async () => {
    // 이전 실행이 아직 진행 중이면 스킵
    if (jobRunning.get(config.name)) {
      logger.warn(`[스케줄러] ${config.name} 이전 실행 진행 중 — 이번 주기 스킵`);
      return;
    }

    jobRunning.set(config.name, true);
    const start = Date.now();
    logger.info(`[스케줄러] ${config.name} 시작`);
    try {
      await config.fn();
      const elapsed = Date.now() - start;
      status.lastRunAt = new Date();
      status.lastResult = 'ok';
      status.runCount++;
      logger.info(`[스케줄러] ${config.name} 완료 (${elapsed}ms)`);
    } catch (e) {
      const elapsed = Date.now() - start;
      status.lastRunAt = new Date();
      status.lastResult = 'error';
      status.lastError = (e as Error).message;
      status.runCount++;
      logger.error(e, `[스케줄러] ${config.name} 실패 (${elapsed}ms)`);
    } finally {
      jobRunning.set(config.name, false);
    }
  };

  // 서버 시작 직후 즉시 실행 (선택)
  if (config.runOnStart) {
    // 다른 초기화가 끝난 후 실행하기 위해 1초 딜레이
    setTimeout(run, 1000);
  }

  const timer = setInterval(run, config.intervalMs);
  jobTimers.set(config.name, timer);
}

// ─── 잡 정의 ──────────────────────────────────────────

const ebayClient = new EbayClient();

/**
 * eBay 토큰 선제 갱신
 * - eBay OAuth Access Token 유효기간: 2시간
 * - 90분마다 실행 → 만료 30분 전 자동 갱신
 */
async function jobEbayTokenRefresh(): Promise<void> {
  await ebayClient.ensureToken();
}

/**
 * 재고 동기화
 * - eBay GetMyeBaySelling + Shopify Products API 호출
 * - DB의 platform_listings.quantity 업데이트
 */
async function jobInventorySync(): Promise<void> {
  const results = await syncAllInventory();
  const changed = results.filter(r => r.changed).length;
  const errors = results.filter(r => r.error).length;
  logger.info(`[재고싱크] ${results.length}개 확인, ${changed}개 변경${errors > 0 ? `, ${errors}개 오류` : ''}`);
}

/**
 * 이상 마진 감지
 * - 역마진(actualMargin < 0) 및 저마진(< 5%) 리스팅 탐지
 * - 결과는 Pino 로거로 출력 (향후 알림 연동 가능)
 */
async function jobAnomalyDetect(): Promise<void> {
  const report = await detectAnomalies();
  logger.info({
    totalChecked: report.totalChecked,
    negativeMargin: report.negativeMarginCount,
    lowMargin: report.lowMarginCount,
  }, '[이상감지] 완료');
}

// ─── 공개 API ─────────────────────────────────────────

/**
 * 모든 잡 등록 및 시작
 * index.ts의 start() 함수에서 1회 호출
 */
export function startScheduler(): void {
  registerJob({
    name: 'ebay-token-refresh',
    intervalMs: 90 * 60 * 1000, // 90분
    fn: jobEbayTokenRefresh,
    runOnStart: false, // main server가 별도로 관리 — 시작 시 즉시 토큰 건드리지 않음
  });

  registerJob({
    name: 'inventory-sync',
    intervalMs: 30 * 60 * 1000, // 30분
    fn: jobInventorySync,
    runOnStart: false, // 서버 시작 직후는 API 준비 대기
  });

  registerJob({
    name: 'anomaly-detect',
    intervalMs: 6 * 60 * 60 * 1000, // 6시간
    fn: jobAnomalyDetect,
    runOnStart: true,
  });

  logger.info('[스케줄러] 시작됨 — 등록된 잡: ' + [...jobStatuses.keys()].join(', '));
}

/**
 * 모든 잡 중지 (graceful shutdown)
 */
export function stopScheduler(): void {
  for (const [name, timer] of jobTimers) {
    clearInterval(timer);
    logger.info(`[스케줄러] ${name} 중지`);
  }
  jobTimers.clear();
}

/**
 * 현재 잡 상태 조회 (API 엔드포인트에서 사용 가능)
 */
export function getSchedulerStatus(): JobStatus[] {
  return [...jobStatuses.values()];
}
