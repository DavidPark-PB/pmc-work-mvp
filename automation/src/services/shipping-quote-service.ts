/**
 * 업로드 행 배송 견적 (서버 전용)
 *
 * 선택된 행의 배송사를 저장하고, 견적 가능한 행만 main service에 요청한다.
 * provider+serviceCode+US+적용무게 키로 중복 제거 — 같은 배송사·무게는 1회만 호출.
 * 차단 사유가 있는 행은 요청하지 않고 BLOCKED snapshot을 남긴다 (fallback 배송비 없음).
 */
import type { CsvRow } from '../lib/csv-parser.js';
import { isShippingProvider, type ShippingPricingConfig, type ShippingProvider } from '../lib/shipping-config.js';
import { quoteCacheKey, requestShippingQuotesDeduped, type FetchLike, type QuoteRequestInput } from '../lib/shipping-quote-client.js';
import { buildShippingQuoteSnapshot, isValidUsdAmount, type ShippingQuoteSnapshot } from './shipping-pricing.js';

export interface ShippingQuoteSelection {
  index: number;
  provider: ShippingProvider;
}

/** 요청 본문 검증 — 잘못되면 Error */
export function parseQuoteSelections(value: unknown, rowCount: number): ShippingQuoteSelection[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('견적할 상품을 선택하세요.');
  const byIndex = new Map<number, ShippingQuoteSelection>();
  for (const item of value) {
    const index = (item as any)?.index;
    const provider = (item as any)?.provider;
    if (!Number.isInteger(index) || index < 0 || index >= rowCount) throw new Error(`잘못된 상품 인덱스: ${index}`);
    if (!isShippingProvider(provider)) throw new Error(`잘못된 배송사: ${provider}`);
    byIndex.set(index, { index, provider });
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export async function quoteUploadRows(
  rows: CsvRow[],
  selections: ShippingQuoteSelection[],
  deps: { config: ShippingPricingConfig; fetchImpl?: FetchLike; now?: Date; logger?: Pick<Console, 'warn'> },
): Promise<{ rows: CsvRow[]; snapshots: Map<number, ShippingQuoteSnapshot>; uniqueRequests: number }> {
  const { config } = deps;
  const now = deps.now ?? new Date();
  const nextRows = [...rows];
  const pending: { index: number; input: QuoteRequestInput }[] = [];
  const snapshots = new Map<number, ShippingQuoteSnapshot>();

  const snapshotFor = (row: CsvRow, provider: ShippingProvider, serviceCode: string | null, outcome: Parameters<typeof buildShippingQuoteSnapshot>[0]['outcome']) =>
    buildShippingQuoteSnapshot({
      provider,
      serviceCode,
      chargeableWeightG: typeof row.chargeableWeightG === 'number' ? row.chargeableWeightG : null,
      csvSalePriceUsd: typeof row.salePriceUsd === 'number' ? row.salePriceUsd : null,
      exchangeRate: config.exchangeRate,
      buyerShippingUsd: config.buyerShippingUsd,
      outcome,
      now,
    });

  for (const { index, provider } of selections) {
    const row = { ...rows[index], selectedShippingProvider: provider };
    nextRows[index] = row;
    const serviceCode = config.serviceCodes[provider];
    const block = (reason: string) => snapshots.set(index, snapshotFor(row, provider, serviceCode, { ok: false, blockedReason: reason }));

    if (row.priceCurrency !== 'USD') { block('NOT_USD_CSV'); continue; }
    if (!(typeof row.chargeableWeightG === 'number' && row.chargeableWeightG > 0)) { block('CHARGEABLE_WEIGHT_INVALID'); continue; }
    if (!isValidUsdAmount(row.salePriceUsd)) { block('SALE_PRICE_INVALID'); continue; }
    if (config.exchangeRate === null) { block('EXCHANGE_RATE_INVALID'); continue; }
    if (!serviceCode) { block('SERVICE_CODE_NOT_CONFIGURED'); continue; }

    pending.push({ index, input: { provider, serviceCode, chargeableWeightG: row.chargeableWeightG } });
  }

  const results = await requestShippingQuotesDeduped(pending.map(p => p.input), {
    config,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  });

  for (const { index, input } of pending) {
    const outcome = results.get(quoteCacheKey(input)) ?? { ok: false as const, blockedReason: 'QUOTE_REQUEST_FAILED' };
    snapshots.set(index, snapshotFor(nextRows[index], input.provider, input.serviceCode, outcome));
  }
  for (const [index, snapshot] of snapshots) {
    nextRows[index] = { ...nextRows[index], shippingQuote: snapshot };
  }

  return { rows: nextRows, snapshots, uniqueRequests: results.size };
}
