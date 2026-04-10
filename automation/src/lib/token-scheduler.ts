/**
 * OAuth 토큰 주기적 갱신 스케줄러
 *
 * 플랫폼별 토큰 유효기간에 맞춰 자동 갱신:
 *   - eBay:    2시간 → 90분 간격
 *   - Shopee:  4시간 → 3시간 간격
 *   - Alibaba: 24시간 → 20시간 간격
 *   - Shopify: 고정 토큰 → 갱신 불필요
 *
 * 서버 시작 시 즉시 1회 갱신 + 이후 주기적 반복.
 */
import { logger } from './logger.js';
import { env } from './config.js';
import { EbayClient } from '../platforms/ebay/EbayClient.js';
import { ShopeeClient } from '../platforms/shopee/ShopeeClient.js';
import { AlibabaClient } from '../platforms/alibaba/AlibabaClient.js';
import { ShopifyClient } from '../platforms/shopify/ShopifyClient.js';

export interface PlatformTokenStatus {
  name: string;
  platform: string;           // DB key
  enabled: boolean;
  intervalMs: number;
  lastRefreshedAt: Date | null;
  lastStatus: 'ok' | 'fail' | 'pending';
  lastError: string | null;
  tokenExpiresIn: number;     // access_token 유효기간 (초)
}

interface PlatformSchedule {
  name: string;
  platform: string;
  intervalMs: number;
  tokenExpiresIn: number;     // 초
  enabled: () => boolean;
  refresh: () => Promise<void>;
  lastRefreshedAt: Date | null;
  lastStatus: 'ok' | 'fail' | 'pending';
  lastError: string | null;
}

// ─── 플랫폼별 갱신 함수 ─────────────────────────────

let ebayClient: EbayClient | null = null;
async function refreshEbay(): Promise<void> {
  if (!ebayClient) ebayClient = new EbayClient();
  const ok = await ebayClient.testConnection();
  if (!ok) throw new Error('eBay 연결 실패 — 자격증명 확인 필요');
}

let shopeeClient: ShopeeClient | null = null;
async function refreshShopee(): Promise<void> {
  if (!shopeeClient) shopeeClient = new ShopeeClient();
  const ok = await shopeeClient.testConnection();
  if (!ok) throw new Error('Shopee 연결 실패 — 자격증명 확인 필요');
}

let alibabaClient: AlibabaClient | null = null;
async function refreshAlibaba(): Promise<void> {
  if (!alibabaClient) alibabaClient = new AlibabaClient();
  const ok = await alibabaClient.testConnection();
  if (!ok) throw new Error('Alibaba 연결 실패 — 자격증명 확인 필요');
}

async function refreshShopify(): Promise<void> {
  const client = new ShopifyClient();
  const ok = await client.testConnection();
  if (!ok) throw new Error('Shopify 연결 실패 — 자격증명 확인 필요');
}

// ─── 스케줄 정의 ─────────────────────────────────────

const schedules: PlatformSchedule[] = [
  {
    name: 'eBay',
    platform: 'ebay',
    intervalMs: 90 * 60 * 1000,       // 90분
    tokenExpiresIn: 7200,             // 2시간
    enabled: () => !!env.EBAY_REFRESH_TOKEN,
    refresh: refreshEbay,
    lastRefreshedAt: null,
    lastStatus: 'pending',
    lastError: null,
  },
  {
    name: 'Shopee',
    platform: 'shopee',
    intervalMs: 3 * 60 * 60 * 1000,   // 3시간
    tokenExpiresIn: 14400,            // 4시간
    enabled: () => !!(env.SHOPEE_PARTNER_KEY && env.SHOPEE_REFRESH_TOKEN),
    refresh: refreshShopee,
    lastRefreshedAt: null,
    lastStatus: 'pending',
    lastError: null,
  },
  {
    name: 'Alibaba',
    platform: 'alibaba',
    intervalMs: 20 * 60 * 60 * 1000,  // 20시간
    tokenExpiresIn: 86400,            // 24시간
    enabled: () => !!(env.ALIBABA_APP_KEY && env.ALIBABA_REFRESH_TOKEN),
    refresh: refreshAlibaba,
    lastRefreshedAt: null,
    lastStatus: 'pending',
    lastError: null,
  },
  {
    name: 'Shopify',
    platform: 'shopify',
    intervalMs: 0,                    // 갱신 불필요
    tokenExpiresIn: 0,               // 만료 없음
    enabled: () => !!(env.SHOPIFY_STORE_URL && env.SHOPIFY_ACCESS_TOKEN),
    refresh: refreshShopify,
    lastRefreshedAt: null,
    lastStatus: 'pending',
    lastError: null,
  },
];

// ─── 스케줄러 실행 ───────────────────────────────────

async function runRefresh(schedule: PlatformSchedule): Promise<void> {
  try {
    await schedule.refresh();
    schedule.lastRefreshedAt = new Date();
    schedule.lastStatus = 'ok';
    schedule.lastError = null;
    logger.info(`[토큰 스케줄러] ${schedule.name} 갱신 완료`);
  } catch (e) {
    schedule.lastRefreshedAt = new Date();
    schedule.lastStatus = 'fail';
    schedule.lastError = (e as Error).message;
    logger.error(e, `[토큰 스케줄러] ${schedule.name} 갱신 실패`);
  }
}

function scheduleRefresh(schedule: PlatformSchedule): void {
  // 즉시 실행
  runRefresh(schedule);

  // 주기적 반복 (Shopify는 고정 토큰이므로 스케줄 안 함)
  if (schedule.intervalMs > 0) {
    setInterval(() => runRefresh(schedule), schedule.intervalMs);
    logger.info(`[토큰 스케줄러] ${schedule.name} 자동 갱신 활성화 (${Math.round(schedule.intervalMs / 60000)}분 간격)`);
  }
}

export function startTokenRefreshScheduler(): void {
  const active = schedules.filter(s => s.enabled());

  if (active.length === 0) {
    logger.info('[토큰 스케줄러] 갱신 대상 플랫폼 없음 (환경변수 미설정)');
    return;
  }

  for (const schedule of active) {
    scheduleRefresh(schedule);
  }
}

// ─── 외부에서 조회/수동 갱신 ────────────────────────

/** 전체 플랫폼 토큰 상태 조회 */
export function getTokenStatuses(): PlatformTokenStatus[] {
  return schedules.map(s => ({
    name: s.name,
    platform: s.platform,
    enabled: s.enabled(),
    intervalMs: s.intervalMs,
    lastRefreshedAt: s.lastRefreshedAt,
    lastStatus: s.lastStatus,
    lastError: s.lastError,
    tokenExpiresIn: s.tokenExpiresIn,
  }));
}

/** 특정 플랫폼 수동 갱신 */
export async function manualRefresh(platform: string): Promise<{ ok: boolean; error?: string }> {
  const schedule = schedules.find(s => s.platform === platform);
  if (!schedule) return { ok: false, error: `알 수 없는 플랫폼: ${platform}` };
  if (!schedule.enabled()) return { ok: false, error: `${schedule.name}: 환경변수 미설정` };

  await runRefresh(schedule);
  return schedule.lastStatus === 'ok'
    ? { ok: true }
    : { ok: false, error: schedule.lastError || '갱신 실패' };
}
