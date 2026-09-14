/**
 * 업로드 행 배송 견적 (서버 전용)
 *
 * 1. 선택 배송사 저장, 적용무게가 없거나 깨졌으면 실측/부피무게로 복구 (원본 CSV 값은 유지, snapshot에 기록)
 * 2. 이미 같은 배송사·서비스·무게·환율로 정상 견적된 행은 재사용 (재계산 시 정상 결과를 지우지 않음)
 * 3. provider+serviceCode+US+무게 키로 중복 제거 → 동시 최대 5개 큐 (일시적 오류는 client가 자동 재시도)
 * 4. 선택 배송사가 배송사 특정 사유로 실패하면 다른 배송사를 대체 견적 (자동 변경하지 않음 — shippingQuoteAlternative)
 * 차단 사유가 있는 행은 요청하지 않고 BLOCKED snapshot을 남긴다 (fallback 배송비 없음).
 */
import { randomUUID } from 'crypto';
import { isQuoteRowUnfinished, type CsvRow } from '../lib/csv-parser.js';
import { isShippingProvider, SHIPPING_DESTINATION_COUNTRY, type ShippingPricingConfig, type ShippingProvider } from '../lib/shipping-config.js';
import {
  quoteCacheKey,
  requestShippingQuotesDeduped,
  type FetchLike,
  type QuoteQueueProgress,
  type QuoteRequestDeps,
  type QuoteRequestInput,
} from '../lib/shipping-quote-client.js';
import { isAlternativeEligible, normalizeQuoteReason, PERMANENT_PROVIDER_REASONS, resolveChargeableWeight } from '../lib/shipping-quote-status.js';
import { buildShippingQuoteSnapshot, isValidUsdAmount, type ShippingQuoteOutcome, type ShippingQuoteSnapshot } from './shipping-pricing.js';

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

export const otherProvider = (provider: ShippingProvider): ShippingProvider => (provider === 'KPL' ? 'eGS' : 'KPL');

export interface QuoteRunProgress extends QuoteQueueProgress {
  /** 재사용한 기존 정상 견적 행 수 */
  reused: number;
  /** 이번 실행에서 적용무게를 복구해 계산하는 행 수 */
  recoveredRows: number;
  /** 대체 배송사 확인 완료 key 수 */
  alternativeChecked: number;
  phase: 'primary' | 'alternative' | 'done';
}

export interface QuoteUploadDeps extends Omit<QuoteRequestDeps, 'config' | 'onRetry'> {
  config: ShippingPricingConfig;
  fetchImpl?: FetchLike;
  now?: Date;
  concurrency?: number;
  onProgress?: (progress: QuoteRunProgress) => void;
  /** 미완료 계산: 선택 배송사의 영구 실패(최대중량 초과 등) snapshot은 재요청 없이 대체 배송사만 확인 */
  reuseProviderFailures?: boolean;
}

/** 같은 upload의 정상 snapshot → 같은 key 견적 결과 (재요청 방지용 캐시) */
function outcomeFromSnapshot(snapshot: ShippingQuoteSnapshot | null | undefined, config: ShippingPricingConfig): [string, ShippingQuoteOutcome] | null {
  if (!snapshot || snapshot.status !== 'OK' || snapshot.destinationCountry !== SHIPPING_DESTINATION_COUNTRY) return null;
  if (snapshot.exchangeRate !== config.exchangeRate || !snapshot.serviceCode || snapshot.serviceCode !== config.serviceCodes[snapshot.provider]) return null;
  if (!(typeof snapshot.chargeableWeightG === 'number' && typeof snapshot.bracketWeightKg === 'number' && typeof snapshot.shippingKrw === 'number')) return null;
  if (snapshot.rateVersionId === null || snapshot.rateVersionId === undefined) return null;
  const input = { provider: snapshot.provider, serviceCode: snapshot.serviceCode, chargeableWeightG: snapshot.chargeableWeightG };
  return [quoteCacheKey(input), {
    ok: true,
    provider: snapshot.provider,
    serviceCode: snapshot.serviceCode,
    destinationCountry: SHIPPING_DESTINATION_COUNTRY,
    chargeableWeightG: snapshot.chargeableWeightG,
    chargeableWeightKg: snapshot.chargeableWeightG / 1000,
    bracketWeightKg: snapshot.bracketWeightKg,
    shippingKrw: snapshot.shippingKrw,
    rateVersionId: snapshot.rateVersionId,
    rateEffectiveFrom: snapshot.rateEffectiveFrom,
  }];
}

/** 저장된 정상 snapshot이 현재 선택·무게·설정 그대로 유효한지 */
function reusableSnapshot(
  snapshot: ShippingQuoteSnapshot | null | undefined,
  ctx: { provider: ShippingProvider; serviceCode: string; weightG: number; exchangeRate: number; salePriceUsd: number },
): boolean {
  return !!snapshot
    && snapshot.status === 'OK'
    && snapshot.provider === ctx.provider
    && snapshot.serviceCode === ctx.serviceCode
    && snapshot.destinationCountry === SHIPPING_DESTINATION_COUNTRY
    && snapshot.chargeableWeightG === ctx.weightG
    && snapshot.exchangeRate === ctx.exchangeRate
    && snapshot.csvSalePriceUsd === ctx.salePriceUsd
    && typeof snapshot.shippingUsd === 'number';
}

export async function quoteUploadRows(
  rows: CsvRow[],
  selections: ShippingQuoteSelection[],
  deps: QuoteUploadDeps,
): Promise<{
  rows: CsvRow[];
  snapshots: Map<number, ShippingQuoteSnapshot>;
  alternatives: Map<number, ShippingQuoteSnapshot | null>;
  uniqueRequests: number;
  progress: QuoteRunProgress;
}> {
  const { config } = deps;
  const now = deps.now ?? new Date();
  const nextRows = [...rows];
  const snapshots = new Map<number, ShippingQuoteSnapshot>();
  const alternatives = new Map<number, ShippingQuoteSnapshot | null>();
  const pending: { index: number; input: QuoteRequestInput }[] = [];
  const weights = new Map<number, ReturnType<typeof resolveChargeableWeight>>();

  const progress: QuoteRunProgress = { total: 0, done: 0, ok: 0, failed: 0, retried: 0, reused: 0, recoveredRows: 0, alternativeChecked: 0, phase: 'primary' };
  const emit = () => deps.onProgress?.({ ...progress });

  const snapshotFor = (index: number, provider: ShippingProvider, serviceCode: string | null, outcome: ShippingQuoteOutcome) => {
    const row = nextRows[index];
    const weight = weights.get(index) ?? resolveChargeableWeight(row);
    return buildShippingQuoteSnapshot({
      provider,
      serviceCode,
      chargeableWeightG: weight.weightG,
      csvSalePriceUsd: typeof row.salePriceUsd === 'number' ? row.salePriceUsd : null,
      exchangeRate: config.exchangeRate,
      buyerShippingUsd: config.buyerShippingUsd,
      outcome,
      now,
      recovery: weight.recovered && weight.weightG !== null && weight.source !== null && weight.source !== 'CSV'
        ? { originalChargeableWeightG: weight.originalChargeableWeightG, recoveredChargeableWeightG: weight.weightG, recoverySource: weight.source }
        : undefined,
    });
  };

  // 1) 선택 배송사
  for (const { index, provider } of selections) {
    const row: CsvRow = { ...rows[index], selectedShippingProvider: provider };
    nextRows[index] = row;
    const weight = resolveChargeableWeight(row);
    weights.set(index, weight);
    const serviceCode = config.serviceCodes[provider];
    const block = (reason: string) => snapshots.set(index, snapshotFor(index, provider, serviceCode, { ok: false, blockedReason: reason }));

    if (row.priceCurrency !== 'USD') { block('NOT_USD_CSV'); continue; }
    if (weight.weightG === null) { block('INVALID_WEIGHT'); continue; }
    if (!isValidUsdAmount(row.salePriceUsd)) { block('SALE_PRICE_INVALID'); continue; }
    if (config.exchangeRate === null) { block('EXCHANGE_RATE_MISSING'); continue; }
    if (!serviceCode) { block('SERVICE_CODE_MISSING'); continue; }

    if (reusableSnapshot(row.shippingQuote, { provider, serviceCode, weightG: weight.weightG, exchangeRate: config.exchangeRate, salePriceUsd: row.salePriceUsd })) {
      snapshots.set(index, row.shippingQuote!);
      progress.reused++;
      continue;
    }
    const previous = row.shippingQuote;
    if (deps.reuseProviderFailures && previous && previous.status === 'BLOCKED' && PERMANENT_PROVIDER_REASONS.has(normalizeQuoteReason(previous.blockedReason))
      && previous.provider === provider && previous.serviceCode === serviceCode && previous.chargeableWeightG === weight.weightG
      && previous.exchangeRate === config.exchangeRate) {
      snapshots.set(index, previous);
      continue;
    }
    if (weight.recovered) progress.recoveredRows++;
    pending.push({ index, input: { provider, serviceCode, chargeableWeightG: weight.weightG } });
  }

  //   같은 upload에 이미 정상 견적된 key는 다시 요청하지 않는다 (예: 복구 200g 행 ↔ 기존 200g 정상 행)
  const results = new Map<string, ShippingQuoteOutcome>();
  for (const row of rows) {
    for (const snap of [row?.shippingQuote, row?.shippingQuoteAlternative]) {
      const entry = outcomeFromSnapshot(snap, config);
      if (entry && !results.has(entry[0])) results.set(entry[0], entry[1]);
    }
  }
  let base = { total: 0, done: 0, ok: 0, failed: 0, retried: 0 };
  const runQueue = async (inputs: QuoteRequestInput[], phase: 'primary' | 'alternative') => {
    const fresh = inputs.filter(i => !results.has(quoteCacheKey(i)));
    const got = await requestShippingQuotesDeduped(fresh, {
      ...deps,
      onProgress: (p) => {
        Object.assign(progress, { total: base.total + p.total, done: base.done + p.done, ok: base.ok + p.ok, failed: base.failed + p.failed, retried: base.retried + p.retried });
        if (phase === 'alternative') progress.alternativeChecked = p.done;
        emit();
      },
    });
    for (const [k, v] of got) results.set(k, v);
    base = { total: progress.total, done: progress.done, ok: progress.ok, failed: progress.failed, retried: progress.retried };
  };

  emit();
  await runQueue(pending.map(p => p.input), 'primary');

  for (const { index, input } of pending) {
    const outcome = results.get(quoteCacheKey(input)) ?? { ok: false as const, blockedReason: 'QUOTE_REQUEST_FAILED' };
    snapshots.set(index, snapshotFor(index, input.provider, input.serviceCode, outcome));
  }

  // 2) 대체 배송사 — 선택 배송사가 배송사 특정 사유로 최종 실패한 행만 (자동 변경 없음)
  progress.phase = 'alternative';
  const altPending: { index: number; input: QuoteRequestInput }[] = [];
  for (const { index, provider } of selections) {
    const primary = snapshots.get(index)!;
    const row = nextRows[index];
    const weight = weights.get(index)!;
    if (primary.status === 'OK') { alternatives.set(index, null); continue; }
    const eligible = isAlternativeEligible(primary.blockedReason)
      && row.priceCurrency === 'USD' && weight.weightG !== null && isValidUsdAmount(row.salePriceUsd) && config.exchangeRate !== null;
    if (!eligible) { alternatives.set(index, null); continue; }
    const alt = otherProvider(provider);
    const altService = config.serviceCodes[alt];
    if (!altService) {
      alternatives.set(index, snapshotFor(index, alt, null, { ok: false, blockedReason: 'SERVICE_CODE_MISSING' }));
      continue;
    }
    altPending.push({ index, input: { provider: alt, serviceCode: altService, chargeableWeightG: weight.weightG! } });
  }
  if (altPending.length > 0) await runQueue(altPending.map(p => p.input), 'alternative');
  for (const { index, input } of altPending) {
    const outcome = results.get(quoteCacheKey(input)) ?? { ok: false as const, blockedReason: 'QUOTE_REQUEST_FAILED' };
    alternatives.set(index, snapshotFor(index, input.provider, input.serviceCode, outcome));
  }

  for (const [index, snapshot] of snapshots) {
    nextRows[index] = { ...nextRows[index], shippingQuote: snapshot, shippingQuoteAlternative: alternatives.get(index) ?? null };
  }
  progress.phase = 'done';
  emit();

  return { rows: nextRows, snapshots, alternatives, uniqueRequests: progress.total, progress: { ...progress } };
}

/**
 * 대체 배송사 적용 — 대체 견적이 정상이고 현재 무게와 일치하는 행만 provider·snapshot 교체
 */
export function applyShippingAlternatives(rows: CsvRow[], indices: number[]): {
  rows: CsvRow[];
  applied: number[];
  skipped: { index: number; reason: string }[];
} {
  const nextRows = [...rows];
  const applied: number[] = [];
  const skipped: { index: number; reason: string }[] = [];
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const row = rows[index];
    if (!row) { skipped.push({ index, reason: 'ROW_NOT_FOUND' }); continue; }
    const alt = row.shippingQuoteAlternative;
    const weightG = resolveChargeableWeight(row).weightG;
    if (!alt || alt.status !== 'OK') { skipped.push({ index, reason: 'NO_ALTERNATIVE' }); continue; }
    if (alt.chargeableWeightG !== weightG || alt.provider === row.selectedShippingProvider) { skipped.push({ index, reason: 'ALTERNATIVE_STALE' }); continue; }
    nextRows[index] = { ...row, selectedShippingProvider: alt.provider, shippingQuote: alt, shippingQuoteAlternative: null };
    applied.push(index);
  }
  return { rows: nextRows, applied, skipped };
}

/**
 * 미완료 배송비 자동 계산 대상 — 최신 parsed_rows 기준으로 서버가 판정
 * providerOverrides: 화면에서 바꿨지만 아직 저장 전인 배송사 (바뀐 행은 기존 snapshot이 무효가 되어 미완료로 분류)
 */
export function unfinishedQuoteSelections(rows: CsvRow[], providerOverrides: Record<string, unknown> = {}): { rows: CsvRow[]; selections: ShippingQuoteSelection[] } {
  const nextRows = [...rows];
  const selections: ShippingQuoteSelection[] = [];
  rows.forEach((row, index) => {
    if (!row || row.priceCurrency !== 'USD') return;
    const override = providerOverrides[String(index)];
    const provider = isShippingProvider(override) ? override : (row.selectedShippingProvider ?? 'KPL');
    const current = provider === row.selectedShippingProvider ? row : { ...row, selectedShippingProvider: provider };
    nextRows[index] = current;
    if (isQuoteRowUnfinished(current)) selections.push({ index, provider });
  });
  return { rows: nextRows, selections };
}

/** 대체 가능(선택 배송사 실패 + 대체 견적 정상) 행 인덱스 */
export function alternativeReadyIndices(rows: CsvRow[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => {
    if (row.shippingQuote?.status === 'BLOCKED' && row.shippingQuoteAlternative?.status === 'OK') out.push(index);
  });
  return out;
}

/** 견적 결과를 최신 parsed_rows에 행 단위로 반영 (다른 행의 기존 결과는 유지) */
export function mergeRowsByIndex(latest: CsvRow[] | null | undefined, updated: CsvRow[], indices: number[]): CsvRow[] {
  if (!latest || latest.length !== updated.length) return updated;
  const merged = [...latest];
  for (const index of indices) merged[index] = updated[index];
  return merged;
}

// ── 진행상태 job (단일 인스턴스 메모리) ─────────────────────

export interface QuoteJob<T = unknown> {
  id: string;
  uploadId: string;
  status: 'running' | 'done' | 'error';
  progress: QuoteRunProgress;
  result?: T;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const JOB_TTL_MS = 30 * 60 * 1000;
const quoteJobs = new Map<string, QuoteJob>();

function pruneJobs(nowMs: number) {
  for (const [id, job] of quoteJobs) {
    if (job.finishedAt && nowMs - job.finishedAt > JOB_TTL_MS) quoteJobs.delete(id);
  }
}

/** 같은 upload에 실행 중인 job이 있으면 그 job (중복 실행 방지) */
export function findRunningQuoteJob(uploadId: string): QuoteJob | undefined {
  for (const job of quoteJobs.values()) if (job.uploadId === uploadId && job.status === 'running') return job;
  return undefined;
}

export function startQuoteJob<T>(
  uploadId: string,
  run: (onProgress: (p: QuoteRunProgress) => void) => Promise<T>,
): { job: QuoteJob<T>; alreadyRunning: boolean; done: Promise<void> } {
  pruneJobs(Date.now());
  const existing = findRunningQuoteJob(uploadId) as QuoteJob<T> | undefined;
  if (existing) return { job: existing, alreadyRunning: true, done: Promise.resolve() };
  const job: QuoteJob<T> = {
    id: randomUUID(),
    uploadId,
    status: 'running',
    progress: { total: 0, done: 0, ok: 0, failed: 0, retried: 0, reused: 0, recoveredRows: 0, alternativeChecked: 0, phase: 'primary' },
    startedAt: Date.now(),
  };
  quoteJobs.set(job.id, job as QuoteJob);
  const done = Promise.resolve()
    .then(() => run(p => { job.progress = p; }))
    .then(result => { job.result = result; job.status = 'done'; })
    .catch(e => { job.error = (e as Error).message; job.status = 'error'; })
    .finally(() => { job.finishedAt = Date.now(); });
  return { job, alreadyRunning: false, done };
}

export function getQuoteJob(jobId: string): QuoteJob | undefined {
  return quoteJobs.get(jobId);
}
