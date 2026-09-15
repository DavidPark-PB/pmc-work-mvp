/**
 * CSV 업로드 검수 화면 선택 상태 (브라우저 + vitest 공용 순수 모듈)
 *
 * 인덱스는 csv_uploads.parsed_rows 배열 인덱스와 동일하다.
 */

/**
 * @param {number[]} allIndices 화면에 있는 전체 행 인덱스
 * @param {number[]} initiallySelected 첫 로딩 시 선택할 인덱스 (정상 상품)
 */
export function createSelection(allIndices, initiallySelected = []) {
  const all = [...new Set(allIndices)];
  const allowed = new Set(all);
  const selected = new Set(initiallySelected.filter(i => allowed.has(i)));

  return {
    isSelected: (index) => selected.has(index),
    set(index, checked) {
      if (!allowed.has(index)) return;
      if (checked) selected.add(index);
      else selected.delete(index);
    },
    toggle(index) {
      this.set(index, !selected.has(index));
    },
    selectAll() {
      all.forEach(i => selected.add(i));
    },
    clearAll() {
      selected.clear();
    },
    count: () => selected.size,
    total: () => all.length,
    selectedIndices: () => [...selected].sort((a, b) => a - b),
  };
}

/** 첫 로딩 기본 선택: 오류(error) 없는 행 */
export function defaultSelectedIndices(rows) {
  return rows.filter(r => r.defaultSelected).map(r => r.index);
}

export const SHIPPING_PROVIDERS = ['KPL', 'eGS'];

/**
 * 행별 배송사 상태 (USD CSV 업로드) — 인덱스 → 'KPL' | 'eGS'
 * @param {{index:number, provider:string|null}[]} rows
 */
export function createProviderState(rows) {
  const providers = new Map();
  rows.forEach(r => { if (SHIPPING_PROVIDERS.includes(r.provider)) providers.set(r.index, r.provider); });
  return {
    get: (index) => providers.get(index) ?? null,
    set(index, provider) {
      if (!SHIPPING_PROVIDERS.includes(provider) || !providers.has(index)) return false;
      providers.set(index, provider);
      return true;
    },
    /** 여러 행 일괄 변경 — 변경된 인덱스 반환 */
    setMany(indices, provider) {
      return indices.filter(i => this.set(i, provider));
    },
    has: (index) => providers.has(index),
  };
}

/** POST /api/import/batch 요청 본문 — 선택된 상품만 전달 (배송사는 선택 행만) */
export function buildImportPayload(uploadId, selection, providers) {
  const payload = { uploadId, selectedIndices: selection.selectedIndices() };
  if (providers) {
    const shippingProviders = {};
    payload.selectedIndices.forEach(i => { if (providers.has(i)) shippingProviders[i] = providers.get(i); });
    payload.shippingProviders = shippingProviders;
  }
  return payload;
}

/** POST /api/upload/shipping-quotes 요청 본문 — 선택 상품 중 배송사가 있는 행 */
export function buildQuoteRequest(uploadId, selection, providers) {
  return {
    uploadId,
    selections: selection.selectedIndices()
      .filter(i => providers.has(i))
      .map(i => ({ index: i, provider: providers.get(i) })),
  };
}

/** "선택 N / 전체 M개" */
export function formatSelectionSummary(selection) {
  return `선택 ${selection.count().toLocaleString('en-US')} / 전체 ${selection.total().toLocaleString('en-US')}개`;
}

// ── 배송비 계산 결과 요약 · 진행상태 (Phase 2.2) ─────────────

const n = (v) => Number(v || 0).toLocaleString('en-US');

/** 상단 요약 "정상 388개 · 자동복구 0개 · 대체 가능 0개 · 확인 필요 303개 · 미계산 2개 · 전체 693개" (합계 = 전체) */
export function formatQuoteSummary(summary) {
  return `정상 ${n(summary.ok)}개 · 자동복구 ${n(summary.recovered)}개 · 대체 가능 ${n(summary.alternative)}개 · 확인 필요 ${n(summary.review)}개 · 미계산 ${n(summary.pending)}개 · 전체 ${n(summary.total)}개`;
}

/** 행 분류 목록 → 요약 (서버 summarizeQuoteRows와 같은 분류, 합계 = 목록 길이) */
export function countQuoteCategories(categories) {
  const summary = { ok: 0, recovered: 0, alternative: 0, review: 0, pending: 0, total: 0 };
  categories.forEach(c => {
    summary.total++;
    if (c === 'OK') summary.ok++;
    else if (c === 'RECOVERED') summary.recovered++;
    else if (c === 'ALTERNATIVE') summary.alternative++;
    else if (c === 'REVIEW') summary.review++;
    else summary.pending++;
  });
  return summary;
}

/** 진행상태 { main: "미완료 배송비 계산 중 18 / 58", detail: "정상 15 · 자동복구 1 · 재시도 2 · 대체 확인 0 · 실패 0" } */
export function formatQuoteProgress(progress, options = {}) {
  const p = progress || {};
  const title = options.mode === 'unfinished' ? '미완료 배송비 계산 중' : '배송비 계산 중';
  return {
    main: `${title} ${n(p.done)} / ${n(p.total)}`,
    detail: `정상 ${n(p.ok)} · 자동복구 ${n(p.recoveredRows)} · 재시도 ${n(p.retried)} · 대체 확인 ${n(p.alternativeChecked)} · 실패 ${n(p.failed)}`,
  };
}

/** 완료 { main: "배송비 계산 완료", detail: "정상 688 · 자동복구 2 · 대체 가능 1 · 확인 필요 2" } */
export function formatQuoteCompletion(summary) {
  const s = summary || {};
  return {
    main: '배송비 계산 완료',
    detail: `정상 ${n(s.ok)} · 자동복구 ${n(s.recovered)} · 대체 가능 ${n(s.alternative)} · 확인 필요 ${n(s.review)}` + (s.pending ? ` · 미계산 ${n(s.pending)}` : ''),
  };
}

/** "미완료 배송비 자동 계산" 버튼 — 미완료 0이면 비활성 + "모든 배송비 계산 완료" */
export function unfinishedButtonState(unfinished) {
  const count = Number(unfinished || 0);
  return count > 0
    ? { disabled: false, label: `미완료 배송비 자동 계산 (${n(count)}개)` }
    : { disabled: true, label: '모든 배송비 계산 완료' };
}

/** 화면에서 바꿨지만 아직 서버에 저장되지 않은 배송사 { index: provider } */
export function providerOverrides(providers, savedProviders) {
  const out = {};
  savedProviders.forEach((saved, index) => {
    const current = providers.get(index);
    if (current && current !== saved) out[index] = current;
  });
  return out;
}

/** 계산 버튼 연타 방지 — 실행 중이면 새 실행을 무시(null 반환) */
export function createSingleFlight() {
  let running = null;
  return {
    isRunning: () => running !== null,
    run(fn) {
      if (running) return null;
      running = Promise.resolve().then(fn).finally(() => { running = null; });
      return running;
    },
  };
}

// ── eBay 배송정책 (CSV upload별 선택) ─────────────────────────

const usd = (v) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 구매자 배송비 표시 — 0이면 "무료" */
export function formatBuyerShipping(buyerShippingUsd) {
  if (typeof buyerShippingUsd !== 'number' || !Number.isFinite(buyerShippingUsd)) return '';
  return buyerShippingUsd === 0 ? '무료' : usd(buyerShippingUsd);
}

/** 드롭다운 문구 — 무료: "추천 · 정책명 — 무료배송" / 고정: "정책명 — $7.90" / 선택 불가: "정책명 — 선택 불가: 사유" */
export function policyOptionLabel(policy) {
  if (!policy.supported) return `${policy.name} — 선택 불가: ${policy.unsupportedMessage || '자동 리스팅에서 사용할 수 없습니다.'}`;
  if (policy.buyerShippingUsd === 0) return `추천 · ${policy.name} — 무료배송`;
  return `${policy.name} — ${usd(policy.buyerShippingUsd)}`;
}

/**
 * 정책명 검색 + 그룹: 무료배송(추천) → 유료배송(고정 금액, 오름차순) → 선택 불가
 * 선택된 정책은 검색어와 무관하게 항상 포함 (선택값이 사라지지 않게)
 */
export function groupShippingPolicies(policies, query = '', selectedPolicyId = null) {
  const q = String(query || '').trim().toLowerCase();
  const match = (p) => !q || p.name.toLowerCase().includes(q) || p.policyId === selectedPolicyId;
  const visible = policies.filter(match);
  const byCost = (a, b) => (a.buyerShippingUsd ?? 0) - (b.buyerShippingUsd ?? 0) || a.name.localeCompare(b.name);
  return [
    { key: 'free', label: '무료배송', policies: visible.filter(p => p.supported && p.buyerShippingUsd === 0).sort((a, b) => a.name.localeCompare(b.name)) },
    { key: 'fixed', label: '유료배송 (고정 배송비)', policies: visible.filter(p => p.supported && p.buyerShippingUsd > 0).sort(byCost) },
    { key: 'unsupported', label: '선택 불가', policies: visible.filter(p => !p.supported).sort((a, b) => a.name.localeCompare(b.name)) },
  ];
}

/** 신규 USD CSV는 배송정책 선택 전 DB 가져오기 불가 (레거시 KRW CSV는 policyRequired=false) */
export function importButtonState({ selectedCount, policyRequired, hasPolicy, saving = false }) {
  if (policyRequired && saving) return { disabled: true, reason: '배송정책 저장 중...' };
  if (policyRequired && !hasPolicy) return { disabled: true, reason: 'eBay 배송정책을 선택하면 상품을 가져올 수 있습니다.' };
  if (!selectedCount) return { disabled: true, reason: '' };
  return { disabled: false, reason: '' };
}

/** 구매자 총 결제 = eBay 등록가 + 선택 정책 구매자 배송비 (등록가에는 더하지 않음) */
export function buyerTotalLabel(listingPriceUsd, policy) {
  const price = Number(listingPriceUsd);
  if (!policy || typeof policy.buyerShippingUsd !== 'number' || listingPriceUsd === '' || listingPriceUsd === null || listingPriceUsd === undefined || !Number.isFinite(price)) return '';
  return usd((Math.round(price * 100) + Math.round(policy.buyerShippingUsd * 100)) / 100);
}

// ── 배송정책 저장 상태 (화면 select 값이 아니라 서버가 반환한 persisted snapshot 기준) ──

export const POLICY_PLACEHOLDER_LABEL = '배송정책을 선택하세요';
export const POLICY_SAVING_LABEL = '배송정책 저장 중...';
export const POLICY_SAVE_TIMEOUT_MS = 60000;

/** 서버가 저장 후 반환한 snapshot인지 (요청한 policyId와 일치 + 필수 필드) */
export function isPersistedPolicy(policy, requestedPolicyId) {
  return !!policy && typeof policy === 'object'
    && typeof policy.policyId === 'string' && policy.policyId !== ''
    && (requestedPolicyId === undefined || policy.policyId === requestedPolicyId)
    && (policy.shippingType === 'FREE' || policy.shippingType === 'FIXED')
    && typeof policy.buyerShippingUsd === 'number' && Number.isFinite(policy.buyerShippingUsd) && policy.buyerShippingUsd >= 0
    && typeof policy.policyName === 'string';
}

/**
 * upload 배송정책 선택 컨트롤러
 * - saved: 서버에 저장된 정책 (없으면 null → select 값 '')
 * - select(policyId): POST /api/upload/shipping-policy 1회. 저장 중에는 다른 선택을 무시
 * - 실패 시 saved 유지 (이전 저장값 또는 미선택)
 */
export function createPolicySelection({ uploadId, initialPolicy = null, fetchImpl, timeoutMs = POLICY_SAVE_TIMEOUT_MS }) {
  let saved = isPersistedPolicy(initialPolicy) ? initialPolicy : null;
  let savingPolicyId = null;
  return {
    get policy() { return saved; },
    get policySelected() { return saved !== null; },
    get saving() { return savingPolicyId !== null; },
    /** select에 보여야 할 값: 저장 중이면 저장 중인 값, 아니면 저장된 값 또는 '' */
    get selectValue() { return savingPolicyId ?? (saved ? saved.policyId : ''); },
    async select(policyId) {
      if (savingPolicyId !== null) return { status: 'ignored', reason: 'SAVING' };
      if (!policyId) return { status: 'ignored', reason: 'EMPTY' };
      if (saved && saved.policyId === policyId) return { status: 'ignored', reason: 'UNCHANGED' };
      savingPolicyId = policyId;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetchImpl('/api/upload/shipping-policy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId, policyId }),
          signal: controller ? controller.signal : undefined,
        });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (!res.ok) {
          return { status: 'error', message: (data && data.error) || '배송정책을 저장하지 못했습니다.', httpStatus: res.status, code: (data && data.code) || null };
        }
        if (!data || !isPersistedPolicy(data.policy, policyId)) {
          return { status: 'error', message: '서버가 저장된 배송정책을 반환하지 않아 선택을 완료하지 못했습니다.', httpStatus: res.status, code: 'POLICY_NOT_PERSISTED' };
        }
        saved = data.policy;
        return { status: 'saved', policy: saved, applied: data.applied || null };
      } catch (e) {
        const timeout = e && e.name === 'AbortError';
        return {
          status: 'error',
          message: timeout ? '배송정책 저장 응답이 지연되고 있습니다. 새로고침해 저장 여부를 확인하세요.' : '배송정책 저장 요청에 실패했습니다.',
          httpStatus: null,
          code: timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        };
      } finally {
        if (timer) clearTimeout(timer);
        savingPolicyId = null;
      }
    },
  };
}
