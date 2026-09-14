/**
 * 배송 견적 상태 공용 규칙 (의존성 없음 — csv-parser / quote client / pricing guard 공용)
 *
 * - 적용무게 자동 복구: 적용무게가 없거나 깨졌으면 MAX(실측, 부피) → 하나만 있으면 그 값
 * - 사유 코드 → 한국어 화면 문구
 * - 일시적 오류(자동 재시도) / 대체 배송사 견적 대상 분류
 */

export type WeightRecoverySource = 'CSV' | 'MAX_ACTUAL_VOLUMETRIC' | 'ACTUAL_WEIGHT' | 'VOLUMETRIC_WEIGHT';

export interface ResolvedChargeableWeight {
  /** 견적·등록에 쓰는 무게(g). 계산 불가면 null */
  weightG: number | null;
  source: WeightRecoverySource | null;
  recovered: boolean;
  /** CSV 원본 적용무게(g) — 없거나 깨졌으면 null (원본 값은 덮어쓰지 않음) */
  originalChargeableWeightG: number | null;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function resolveChargeableWeight(src: { chargeableWeightG?: unknown; actualWeightG?: unknown; volumetricWeightG?: unknown }): ResolvedChargeableWeight {
  const original = positive(src.chargeableWeightG) ? src.chargeableWeightG : null;
  if (original !== null) return { weightG: original, source: 'CSV', recovered: false, originalChargeableWeightG: original };
  const actual = positive(src.actualWeightG) ? src.actualWeightG : null;
  const volumetric = positive(src.volumetricWeightG) ? src.volumetricWeightG : null;
  if (actual !== null && volumetric !== null) {
    return { weightG: Math.max(actual, volumetric), source: 'MAX_ACTUAL_VOLUMETRIC', recovered: true, originalChargeableWeightG: null };
  }
  if (actual !== null) return { weightG: actual, source: 'ACTUAL_WEIGHT', recovered: true, originalChargeableWeightG: null };
  if (volumetric !== null) return { weightG: volumetric, source: 'VOLUMETRIC_WEIGHT', recovered: true, originalChargeableWeightG: null };
  return { weightG: null, source: null, recovered: false, originalChargeableWeightG: null };
}

// ── 사유 코드 ─────────────────────────────────────────────

/** 이전 버전 snapshot 코드 → 현재 코드 */
const REASON_ALIASES: Record<string, string> = {
  CHARGEABLE_WEIGHT_INVALID: 'INVALID_WEIGHT',
  EXCHANGE_RATE_INVALID: 'EXCHANGE_RATE_MISSING',
  SERVICE_CODE_NOT_CONFIGURED: 'SERVICE_CODE_MISSING',
};

const CONTRACT_REASONS = new Set([
  'QUOTE_CONTRACT_MISMATCH', 'QUOTE_INVALID_JSON', 'QUOTE_INVALID_RESPONSE', 'QUOTE_PROVIDER_MISMATCH', 'QUOTE_SERVICE_MISMATCH',
  'QUOTE_COUNTRY_MISMATCH', 'QUOTE_WEIGHT_BELOW_CHARGEABLE', 'QUOTE_BRACKET_BELOW_CHARGEABLE', 'QUOTE_AMOUNT_INVALID',
  'QUOTE_UNEXPECTED_EU_FEES', 'QUOTE_RATE_VERSION_MISSING',
]);

export const QUOTE_REASON_LABELS: Record<string, string> = {
  QUOTE_TIMEOUT: '배송비 서버 응답 지연 · 자동 재시도 실패',
  QUOTE_NETWORK_ERROR: '배송비 서버 연결 실패',
  RATE_NOT_LOADED: '선택 배송사의 운임이 등록되지 않음',
  COUNTRY_NOT_IN_MASTER: '선택 배송사가 미국 배송을 지원하지 않음',
  WEIGHT_OVER_MAX_BRACKET: '선택 배송사의 최대 허용중량 초과',
  INVALID_WEIGHT: '계산 가능한 무게가 없음',
  AUTH_ERROR: '배송비 서버 인증 설정 오류',
  QUOTE_CONTRACT_MISMATCH: '배송비 응답 형식 오류',
  EXCHANGE_RATE_MISSING: '적용 환율이 설정되지 않음',
  SERVICE_CODE_MISSING: '배송 서비스 설정이 없음',
  SHIPPING_QUOTE_NOT_CONFIGURED: '배송비 서버 연결 설정이 없음',
  SALE_PRICE_INVALID: '판매가(USD)가 없거나 올바르지 않음',
  NOT_USD_CSV: '판매가(USD) CSV 상품이 아님',
  QUOTE_HTTP_429: '배송비 서버 요청 과다 · 자동 재시도 실패',
  QUOTE_REQUEST_FAILED: '배송비 계산 요청 실패',
};

export function normalizeQuoteReason(code: string | null | undefined): string {
  const c = String(code || 'QUOTE_REQUEST_FAILED');
  if (REASON_ALIASES[c]) return REASON_ALIASES[c];
  if (CONTRACT_REASONS.has(c)) return 'QUOTE_CONTRACT_MISMATCH';
  return c;
}

export function describeQuoteReason(code: string | null | undefined): string {
  const c = normalizeQuoteReason(code);
  if (QUOTE_REASON_LABELS[c]) return QUOTE_REASON_LABELS[c];
  const http = /^QUOTE_HTTP_(\d{3})$/.exec(c);
  if (http) {
    return TRANSIENT_QUOTE_REASONS.has(c)
      ? `배송비 서버 일시 오류 (HTTP ${http[1]}) · 자동 재시도 실패`
      : `배송비 서버 오류 (HTTP ${http[1]})`;
  }
  return `배송비 계산 실패 (${c})`;
}

/** 자동 재시도 대상 (client에서 판정한 최종 사유 기준) */
export const TRANSIENT_QUOTE_REASONS = new Set(['QUOTE_TIMEOUT', 'QUOTE_NETWORK_ERROR', 'QUOTE_HTTP_429', 'QUOTE_HTTP_502', 'QUOTE_HTTP_503', 'QUOTE_HTTP_504']);

/** 배송사와 무관한 오류 — 대체 배송사로도 해결되지 않으므로 대체 견적하지 않음 */
const NOT_PROVIDER_SPECIFIC = new Set([
  'AUTH_ERROR', 'SHIPPING_QUOTE_NOT_CONFIGURED', 'EXCHANGE_RATE_MISSING', 'INVALID_WEIGHT', 'SALE_PRICE_INVALID', 'NOT_USD_CSV', 'QUOTE_CONTRACT_MISMATCH',
]);

/** 선택 배송사 실패 후 대체 배송사 견적을 시도할지 */
export function isAlternativeEligible(code: string | null | undefined): boolean {
  return !NOT_PROVIDER_SPECIFIC.has(normalizeQuoteReason(code));
}

/** 선택 배송사로 다시 요청해도 결과가 같은 영구 실패 — 미완료 계산에서는 재요청 없이 대체 배송사만 확인 */
export const PERMANENT_PROVIDER_REASONS = new Set(['WEIGHT_OVER_MAX_BRACKET', 'RATE_NOT_LOADED', 'COUNTRY_NOT_IN_MASTER']);

/**
 * 다시 계산하면 해결될 수 있는 실패 (미완료로 분류)
 * 일시적 서버 오류 + 설정/연결 오류(설정 수정 후 재계산 대상). 입력·계약 오류는 제외.
 */
export function isRecoverableQuoteFailure(code: string | null | undefined): boolean {
  const c = normalizeQuoteReason(code);
  return TRANSIENT_QUOTE_REASONS.has(c)
    || ['QUOTE_HTTP_500', 'QUOTE_REQUEST_FAILED', 'AUTH_ERROR', 'SHIPPING_QUOTE_NOT_CONFIGURED', 'EXCHANGE_RATE_MISSING'].includes(c);
}
