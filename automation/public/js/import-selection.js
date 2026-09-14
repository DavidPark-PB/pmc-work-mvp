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
