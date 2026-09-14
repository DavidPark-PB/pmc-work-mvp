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

/** 상단 요약 "정상 680개 · 자동복구 8개 · 대체 가능 3개 · 확인 필요 2개" */
export function formatQuoteSummary(summary) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  return `정상 ${n(summary.ok)}개 · 자동복구 ${n(summary.recovered)}개 · 대체 가능 ${n(summary.alternative)}개 · 확인 필요 ${n(summary.review)}개`;
}

/** 행 분류 목록 → 요약 (서버 summarizeQuoteCategories와 같은 규칙) */
export function countQuoteCategories(categories) {
  const summary = { ok: 0, recovered: 0, alternative: 0, review: 0, pending: 0 };
  categories.forEach(c => {
    if (c === 'OK') summary.ok++;
    else if (c === 'RECOVERED') summary.recovered++;
    else if (c === 'ALTERNATIVE') summary.alternative++;
    else if (c === 'REVIEW') summary.review++;
    else summary.pending++;
  });
  return summary;
}

/** 진행상태 { main: "배송비 계산 중 18 / 56", detail: "정상 15 · 재시도 2 · 실패 1" } */
export function formatQuoteProgress(progress) {
  const p = progress || {};
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const main = p.phase === 'alternative'
    ? `대체 배송사 계산 중 ${n(p.done)} / ${n(p.total)}`
    : `배송비 계산 중 ${n(p.done)} / ${n(p.total)}`;
  const detail = `정상 ${n(p.ok)} · 재시도 ${n(p.retried)} · 실패 ${n(p.failed)}` + (p.reused ? ` · 기존 결과 재사용 ${n(p.reused)}` : '');
  return { main, detail };
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

/** "실패 항목 자동 재계산" 대상 — 선택 배송사 견적이 실패한 행 (확인 필요 / 대체 가능) */
export function failedQuoteSelections(rowStates, providers) {
  return rowStates
    .filter(r => (r.quoteCategory === 'REVIEW' || r.quoteCategory === 'ALTERNATIVE') && providers.has(r.index))
    .map(r => ({ index: r.index, provider: providers.get(r.index) }));
}
