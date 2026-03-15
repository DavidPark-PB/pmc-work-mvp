/**
 * 이상 마진 감지
 *
 * platform_listings를 products와 조인하여
 * 현재 판매가 기준으로 마진이 음수이거나 임계값 미만인 리스팅을 감지.
 */
import { eq, and, isNotNull, gt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { platformListings, products, pricingSettings } from '../db/schema.js';
import { logger } from '../lib/logger.js';

export interface AnomalyItem {
  listingId: number;
  platform: string;
  sku: string;
  title: string;
  salePriceUsd: number;
  costKrw: number;
  breakEvenUsd: number;
  actualMargin: number;
  reason: 'negative_margin' | 'low_margin';
}

export interface AnomalyReport {
  checkedAt: Date;
  totalChecked: number;
  anomalies: AnomalyItem[];
  negativeMarginCount: number;
  lowMarginCount: number;
}

const LOW_MARGIN_THRESHOLD = 0.05; // 5% 미만이면 경고

/**
 * 플랫폼별 수수료율 폴백
 */
const PLATFORM_FEE_FALLBACK: Record<string, number> = {
  ebay: 0.13,
  shopify: 0.05,
  alibaba: 0.05,
  shopee: 0.06,
  naver: 0.055,
  coupang: 0.10,
  qoo10: 0.12,
};

/**
 * 전체 활성 리스팅의 마진 이상 감지
 */
export async function detectAnomalies(): Promise<AnomalyReport> {
  const checkedAt = new Date();

  // 플랫폼별 가격 설정 조회
  const settingsRows = await db.query.pricingSettings.findMany();
  const settingsMap = new Map(settingsRows.map(r => [r.platform, {
    exchangeRate: parseFloat(String(r.exchangeRate)),
    platformFeeRate: parseFloat(String(r.platformFeeRate)),
    defaultShippingKrw: parseFloat(String(r.defaultShippingKrw)),
  }]));

  // 활성 리스팅 + 상품 원가 조회
  const listings = await db.select({
    listingId: platformListings.id,
    platform: platformListings.platform,
    platformItemId: platformListings.platformItemId,
    salePriceUsd: platformListings.price,
    status: platformListings.status,
    sku: products.sku,
    title: products.title,
    costKrw: products.costPrice,
  })
    .from(platformListings)
    .leftJoin(products, eq(platformListings.productId, products.id))
    .where(
      and(
        eq(platformListings.status, 'active'),
        isNotNull(products.costPrice),
        gt(sql`CAST(${platformListings.price} AS numeric)`, sql`0`),
      ),
    );

  const anomalies: AnomalyItem[] = [];

  for (const listing of listings) {
    const costKrw = parseFloat(String(listing.costKrw ?? '0'));
    const salePriceUsd = parseFloat(String(listing.salePriceUsd ?? '0'));
    if (!costKrw || !salePriceUsd) continue;

    const platform = listing.platform;
    const settings = settingsMap.get(platform);
    const exchangeRate = settings?.exchangeRate ?? 1400;
    const platformFeeRate = settings?.platformFeeRate ?? (PLATFORM_FEE_FALLBACK[platform] ?? 0.13);
    const shippingKrw = settings?.defaultShippingKrw ?? 5500;

    // 손익분기 판매가 = (원가 + 배송비) / 환율 / (1 - 수수료율)
    const totalCostUsd = (costKrw + shippingKrw) / exchangeRate;
    const breakEvenUsd = totalCostUsd / (1 - platformFeeRate);

    // 실제 마진율 = (판매가 × (1 - 수수료율) - 총비용) / 총비용
    const netRevenue = salePriceUsd * (1 - platformFeeRate);
    const actualMargin = (netRevenue - totalCostUsd) / totalCostUsd;

    if (actualMargin < 0) {
      anomalies.push({
        listingId: listing.listingId,
        platform,
        sku: listing.sku ?? '',
        title: listing.title ?? '',
        salePriceUsd,
        costKrw,
        breakEvenUsd: Math.round(breakEvenUsd * 100) / 100,
        actualMargin: Math.round(actualMargin * 1000) / 10, // %
        reason: 'negative_margin',
      });
    } else if (actualMargin < LOW_MARGIN_THRESHOLD) {
      anomalies.push({
        listingId: listing.listingId,
        platform,
        sku: listing.sku ?? '',
        title: listing.title ?? '',
        salePriceUsd,
        costKrw,
        breakEvenUsd: Math.round(breakEvenUsd * 100) / 100,
        actualMargin: Math.round(actualMargin * 1000) / 10,
        reason: 'low_margin',
      });
    }
  }

  const negativeMarginCount = anomalies.filter(a => a.reason === 'negative_margin').length;
  const lowMarginCount = anomalies.filter(a => a.reason === 'low_margin').length;

  const report: AnomalyReport = {
    checkedAt,
    totalChecked: listings.length,
    anomalies,
    negativeMarginCount,
    lowMarginCount,
  };

  if (negativeMarginCount > 0) {
    logger.warn({ negativeMarginCount, samples: anomalies.filter(a => a.reason === 'negative_margin').slice(0, 5) },
      `[이상감지] 역마진 리스팅 ${negativeMarginCount}개 발견`);
  }
  if (lowMarginCount > 0) {
    logger.warn({ lowMarginCount },
      `[이상감지] 저마진(${LOW_MARGIN_THRESHOLD * 100}% 미만) 리스팅 ${lowMarginCount}개 발견`);
  }
  if (anomalies.length === 0) {
    logger.info(`[이상감지] 이상 없음 (${listings.length}개 리스팅 검사)`);
  }

  return report;
}
