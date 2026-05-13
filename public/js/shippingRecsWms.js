/**
 * 🆕 배송 추천 (자동계산) — Phase 4 of 배송비 계산/배송추천 리디자인
 *
 * SKU 마스터 무게가 자동 매칭되어 배송무게·부피무게·청구무게·추천배송사·예상비
 * 가 미리 계산된 상태로 표시됨. 사용자는 검토 + 예외 수정.
 *
 * UX 원칙 (사장님 spec):
 *   - 자동 계산 결과를 확인하고 예외만 수정하는 화면
 *   - 무게 미입력 SKU 는 빨간 뱃지 + 일괄 입력 모달
 *   - 수정값은 기본 해당 주문에만, 옵션 체크 시 SKU 마스터 반영
 *   - 자동 계산 - 수동 수정 차이 ±50% 이상 → 경고
 *
 * 백엔드:
 *   GET   /api/shipping/recommendations/wms
 *   PATCH /api/shipping/recommendations/wms/:orderId/weight
 *   POST  /api/shipping/recommendations/wms/recalculate
 */
(function() {
  let user = null;
  let state = {
    days: 14,
    status: 'ALL',
    carrier: '',
    weightFilter: '',   // ''|'missing'
    summary: null,
    orders: [],
    loading: false,
    error: null,
  };

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtG(v) { return v == null ? '-' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + 'g'; }
  function fmtKRW(v) { return v == null ? '-' : '₩' + Number(v).toLocaleString('ko-KR'); }
  function fmtDate(s) { return s ? String(s).slice(0, 10) : '-'; }

  // carrier 키 → 표시 라벨/색
  const CARRIER_VIEW = {
    koreapost: { label: '우체국', color: '#1565c0' },
    shipter:   { label: '쉽터',   color: '#7b1fa2' },
    kpl:       { label: 'KPL',    color: '#00897b' },
    fedex:     { label: 'FedEx',  color: '#6a1b9a' },
    yun:       { label: '윤익스프레스', color: '#ef6c00' },
    kpacket:   { label: 'K-Packet', color: '#c2185b' },
    review:    { label: '⚠️ 검토 필요', color: '#c62828' },
    pending:   { label: '미계산',  color: '#616161' },
  };
  function carrierBadge(key) {
    const v = CARRIER_VIEW[key] || { label: key || '?', color: '#616161' };
    return `<span style="display:inline-block;padding:2px 8px;background:${v.color};color:#fff;border-radius:10px;font-size:11px;font-weight:700;">${v.label}</span>`;
  }
  function weightStatusBadge(s) {
    const map = {
      measured:  { color: '#2e7d32', label: '실측' },
      estimated: { color: '#f9a825', label: '추정' },
      unknown:   { color: '#c62828', label: '미입력' },
    };
    const cfg = map[s] || map.unknown;
    return `<span style="display:inline-block;padding:1px 5px;background:${cfg.color};color:#fff;border-radius:7px;font-size:9px;font-weight:700;">${cfg.label}</span>`;
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-shipping-recs-wms');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:14px;">
        <h1 style="font-size:22px;color:#fff;margin:0;">🆕 배송 추천 <span style="color:#ffd54f;font-size:13px;font-weight:400;">· 자동 계산 (Phase 4)</span></h1>
        <p style="color:#888;font-size:13px;margin:4px 0 0;">SKU 마스터 무게로 자동 계산된 결과를 확인하고 예외만 수정. 무게 미입력 SKU 는 빨갛게 표시됨.</p>
      </div>

      <!-- 필터 + 액션 바 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <label style="color:#aaa;font-size:12px;">기간</label>
        <select id="srw-days" onchange="pmcShippingRecsWms.onFilterChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="3">3일</option>
          <option value="7">7일</option>
          <option value="14" selected>14일</option>
          <option value="30">30일</option>
          <option value="60">60일</option>
        </select>

        <label style="color:#aaa;font-size:12px;">상태</label>
        <select id="srw-status" onchange="pmcShippingRecsWms.onFilterChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="ALL">전체</option>
          <option value="pending">pending</option>
          <option value="paid">paid</option>
          <option value="ready_to_ship">ready_to_ship</option>
          <option value="shipped">shipped</option>
        </select>

        <label style="color:#aaa;font-size:12px;">배송사</label>
        <select id="srw-carrier" onchange="pmcShippingRecsWms.onFilterChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="">전체</option>
          <option value="koreapost">우체국</option>
          <option value="shipter">쉽터</option>
          <option value="kpl">KPL</option>
          <option value="fedex">FedEx</option>
          <option value="yun">윤익스프레스</option>
          <option value="kpacket">K-Packet</option>
          <option value="review">⚠️ 검토 필요</option>
        </select>

        <label style="color:#aaa;font-size:12px;">무게</label>
        <select id="srw-weight" onchange="pmcShippingRecsWms.onFilterChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="">전체</option>
          <option value="missing">⚠️ 무게 미입력만</option>
        </select>

        <button type="button" onclick="pmcShippingRecsWms.refresh()" style="padding:6px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🔄 새로고침</button>
        <button type="button" onclick="pmcShippingRecsWms.openBulkWeightModal()" title="무게 미입력 SKU 일괄 입력" style="padding:6px 14px;background:#1565c0;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">⚖️ 무게 일괄 입력</button>
        <button type="button" onclick="pmcShippingRecsWms.recalcAll()" title="현재 필터 결과 주문에 대해 무게·추천을 다시 계산" style="padding:6px 14px;background:#37474f;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;">🔁 재계산</button>
        <span id="srw-status-msg" style="color:#888;font-size:11px;margin-left:auto;"></span>
      </div>

      <div id="srw-summary"></div>
      <div id="srw-table"></div>
    `;
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    const msg = document.getElementById('srw-status-msg');
    if (msg) msg.textContent = '로딩…';
    try {
      state.days = parseInt(document.getElementById('srw-days')?.value || '14', 10);
      state.status = document.getElementById('srw-status')?.value || 'ALL';
      state.carrier = document.getElementById('srw-carrier')?.value || '';
      state.weightFilter = document.getElementById('srw-weight')?.value || '';

      const params = new URLSearchParams();
      params.set('days', String(state.days));
      if (state.status) params.set('status', state.status);
      if (state.carrier) params.set('carrier', state.carrier);
      if (state.weightFilter) params.set('weight_status', state.weightFilter);

      const res = await fetch('/api/shipping/recommendations/wms?' + params);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      state.summary = j.summary || null;
      state.orders = j.orders || [];
      if (msg) msg.textContent = '';
    } catch (e) {
      state.error = e.message;
      if (msg) msg.textContent = '실패: ' + e.message;
    } finally {
      state.loading = false;
      renderSummary();
      renderTable();
    }
  }

  function renderSummary() {
    const host = document.getElementById('srw-summary');
    if (!host) return;
    if (!state.summary) { host.innerHTML = ''; return; }
    const { total, calculated, pending } = state.summary;
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:#ccc;">
        <div>전체 <strong style="color:#fff;font-size:14px;">${total.toLocaleString()}</strong></div>
        <div>계산 완료 <strong style="color:#81c784;font-size:14px;">${calculated.toLocaleString()}</strong></div>
        <div>미계산 <strong style="color:#ff8a80;font-size:14px;">${pending.toLocaleString()}</strong></div>
      </div>
    `;
  }

  function renderTable() {
    const host = document.getElementById('srw-table');
    if (!host) return;
    if (state.error) {
      host.innerHTML = `<div style="padding:30px;color:#ff8a80;text-align:center;">에러: ${esc(state.error)}</div>`;
      return;
    }
    if (state.loading) {
      host.innerHTML = `<div style="padding:30px;color:#888;text-align:center;">로딩 중…</div>`;
      return;
    }
    if (state.orders.length === 0) {
      host.innerHTML = `<div style="padding:40px;color:#888;text-align:center;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;">결과 없음</div>`;
      return;
    }
    const rows = state.orders.map(o => renderRow(o)).join('');
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;color:#e0e0e0;">
          <thead>
            <tr style="background:#0f0f23;border-bottom:2px solid #2a2a4a;">
              <th style="padding:8px;text-align:left;">주문번호</th>
              <th style="padding:8px;text-align:left;">판매처</th>
              <th style="padding:8px;text-align:left;">국가</th>
              <th style="padding:8px;text-align:left;">SKU · 수량</th>
              <th style="padding:8px;text-align:right;" title="단품무게 × 수량 합산">상품무게</th>
              <th style="padding:8px;text-align:right;" title="박스·완충재 등">포장</th>
              <th style="padding:8px;text-align:right;" title="상품 + 포장 (실무게)">최종</th>
              <th style="padding:8px;text-align:right;" title="L×W×H / 5000 × 1000g (universal divisor)">부피</th>
              <th style="padding:8px;text-align:right;" title="실무게와 부피무게 중 큰 값">청구</th>
              <th style="padding:8px;text-align:center;">추천 배송사</th>
              <th style="padding:8px;text-align:right;">예상비</th>
              <th style="padding:8px;text-align:left;">상태/경고</th>
              <th style="padding:8px;text-align:center;">액션</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderRow(o) {
    const sh = o.shipment;
    const overridden = sh?.isWeightOverridden;
    const masterUpdated = sh?.masterWeightUpdated;
    const chargeable = overridden ? sh.overriddenWeightG : sh?.chargeableWeightG;

    // SKU summary — 첫 1~2 줄 + 추가 N개 표시
    const skuSummary = (o.lines || []).slice(0, 2).map(l => {
      const wsBadge = l.weightStatus ? weightStatusBadge(l.weightStatus) : '';
      const name = l.internalSku || l.marketplaceSku || '(매칭X)';
      return `<div style="margin-bottom:2px;">${esc(name)} × ${l.quantity} ${wsBadge}</div>`;
    }).join('');
    const moreLines = (o.lines || []).length > 2 ? `<div style="color:#888;font-size:10px;">+ ${o.lines.length - 2}건</div>` : '';

    // 경고 뱃지
    const warningStrs = (o.warnings || []).map(w => {
      const color = w.code === 'large_weight_deviation' ? '#ff9800' : '#c62828';
      return `<div style="color:${color};font-size:10px;line-height:1.4;">⚠️ ${esc(w.message)}</div>`;
    }).join('');
    const statusStrs = [
      overridden ? `<div style="color:#ffb74d;font-size:10px;">✏️ 수동 수정${masterUpdated ? ' (마스터 반영됨)' : ''}</div>` : '',
      o.needsCalc ? `<div style="color:#888;font-size:10px;">미계산</div>` : '',
    ].filter(Boolean).join('');

    return `
      <tr style="border-bottom:1px solid #2a2a4a;${overridden ? 'background:#1f1810;' : ''}">
        <td style="padding:8px;font-family:monospace;color:#81d4fa;">${esc(o.externalOrderId || '')}</td>
        <td style="padding:8px;">${esc(o.marketplace || '')}</td>
        <td style="padding:8px;">${esc(o.buyerCountry || '-')}</td>
        <td style="padding:8px;">${skuSummary || '<span style="color:#888;">-</span>'}${moreLines}</td>
        <td style="padding:8px;text-align:right;">${fmtG(sh?.productWeightG)}</td>
        <td style="padding:8px;text-align:right;color:#aaa;">${fmtG(sh?.packagingWeightG)}</td>
        <td style="padding:8px;text-align:right;">${fmtG(sh?.finalWeightG)}</td>
        <td style="padding:8px;text-align:right;color:#aaa;">${fmtG(sh?.volumetricWeightG)}</td>
        <td style="padding:8px;text-align:right;font-weight:700;color:#ffd54f;">${fmtG(chargeable)}</td>
        <td style="padding:8px;text-align:center;">${carrierBadge(sh?.recommendedCarrier || (o.needsCalc ? 'pending' : 'review'))}<div style="color:#888;font-size:10px;margin-top:2px;">${esc(sh?.recommendedService || '')}</div></td>
        <td style="padding:8px;text-align:right;">${fmtKRW(sh?.estimatedShippingCost)}</td>
        <td style="padding:8px;">${statusStrs}${warningStrs}</td>
        <td style="padding:8px;text-align:center;white-space:nowrap;">
          <button onclick="pmcShippingRecsWms.openEdit(${o.orderId})" title="무게 수정" style="padding:3px 8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;margin-right:3px;">✏️ 수정</button>
          <button onclick="pmcShippingRecsWms.recalcOne(${o.orderId})" title="이 주문 다시 계산" style="padding:3px 8px;background:#37474f;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🔁</button>
        </td>
      </tr>
    `;
  }

  // ── 인라인 수정 모달 ────────────────────────────────────────
  function openEdit(orderId) {
    const o = state.orders.find(x => x.orderId === orderId);
    if (!o) return;
    const sh = o.shipment || {};
    const currentVal = sh.isWeightOverridden ? sh.overriddenWeightG : sh.chargeableWeightG;
    const matchedSkuCount = (o.lines || []).filter(l => l.internalSku).length;
    const canApplyMaster = matchedSkuCount === 1; // 단일 SKU 주문만 마스터 반영 허용

    document.getElementById('srw-edit-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'srw-edit-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:480px;max-width:95vw;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="color:#fff;font-size:16px;margin:0;">✏️ 무게 수정 <span style="color:#888;font-size:12px;font-weight:400;">${esc(o.externalOrderId || '')}</span></h2>
          <button onclick="document.getElementById('srw-edit-modal').remove()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <div style="font-size:12px;color:#aaa;margin-bottom:12px;">
          자동 계산 청구무게: <strong style="color:#ffd54f;">${fmtG(sh.chargeableWeightG)}</strong>
          (상품 ${fmtG(sh.productWeightG)} + 포장 ${fmtG(sh.packagingWeightG)} = 최종 ${fmtG(sh.finalWeightG)}, 부피 ${fmtG(sh.volumetricWeightG)})
        </div>

        <label style="display:block;font-size:11px;color:#888;margin-bottom:4px;">적용할 청구무게 (g)</label>
        <input id="srw-edit-weight" type="number" min="1" step="0.1" value="${currentVal || ''}"
          style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;margin-bottom:12px;">

        <label style="display:block;font-size:11px;color:#888;margin-bottom:4px;">수정 사유 (선택)</label>
        <input id="srw-edit-reason" type="text" maxlength="500" placeholder="예: 실측 결과 더 가벼움, 자동 계산 오류 등"
          style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;margin-bottom:14px;">

        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:${canApplyMaster ? '#e0e0e0' : '#666'};margin-bottom:14px;cursor:${canApplyMaster ? 'pointer' : 'not-allowed'};">
          <input type="checkbox" id="srw-edit-apply-master" ${canApplyMaster ? '' : 'disabled'}>
          <span>📦 SKU 마스터에도 반영 ${canApplyMaster
            ? '<span style="color:#888;">— 본 주문의 단품 무게를 (수정값-포장)/수량 으로 재계산해서 sku_master.weight_gram 까지 업데이트</span>'
            : '<span style="color:#888;">— 단일 SKU 주문에만 가능 (현재 ' + matchedSkuCount + '개)</span>'}</span>
        </label>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button onclick="document.getElementById('srw-edit-modal').remove()" style="padding:9px 16px;background:#2a2a4a;border:0;border-radius:6px;color:#ccc;cursor:pointer;font-size:13px;">취소</button>
          <button onclick="pmcShippingRecsWms.submitEdit(${o.orderId})" style="padding:9px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;font-size:13px;">저장</button>
        </div>
      </div>
    `;
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    setTimeout(() => document.getElementById('srw-edit-weight')?.focus(), 50);
  }

  async function submitEdit(orderId) {
    const w = Number(document.getElementById('srw-edit-weight')?.value);
    if (!Number.isFinite(w) || w <= 0) { alert('무게(g) 를 입력하세요 (양수)'); return; }
    const reason = document.getElementById('srw-edit-reason')?.value?.trim() || null;
    const applyMaster = document.getElementById('srw-edit-apply-master')?.checked || false;

    try {
      const res = await fetch(`/api/shipping/recommendations/wms/${orderId}/weight`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overriddenWeightG: w, overrideReason: reason, applyToMaster: applyMaster }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      let msg = '저장 완료';
      if (applyMaster) {
        if (j.masterUpdate?.ok) msg += `\n\n✓ SKU 마스터 반영: ${j.masterUpdate.sku?.internal_sku} → 단품무게 ${j.masterUpdate.inferredItemWeight}g`;
        else msg += `\n\n⚠ 마스터 반영 실패: ${j.masterUpdate?.reason || '알 수 없음'}`;
      }
      alert(msg);
      document.getElementById('srw-edit-modal')?.remove();
      await refresh();
    } catch (e) {
      alert('실패: ' + e.message);
    }
  }

  // ── 단일 주문 재계산 ────────────────────────────────────────
  async function recalcOne(orderId) {
    try {
      const res = await fetch('/api/shipping/recommendations/wms/recalculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: [orderId] }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      await refresh();
    } catch (e) { alert('재계산 실패: ' + e.message); }
  }

  // ── 필터 결과 전체 재계산 ───────────────────────────────────
  async function recalcAll() {
    const ids = state.orders.map(o => o.orderId);
    if (ids.length === 0) { alert('대상 주문 없음'); return; }
    if (!confirm(`${ids.length}건의 주문을 다시 계산합니다. 시간이 좀 걸릴 수 있습니다. 진행할까요?`)) return;
    const msg = document.getElementById('srw-status-msg');
    if (msg) msg.textContent = `재계산 중 (${ids.length}건)…`;
    try {
      const res = await fetch('/api/shipping/recommendations/wms/recalculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: ids }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      alert(`재계산 완료: 성공 ${j.ok}, 검토 ${j.review}, 실패 ${j.errors}`);
      await refresh();
    } catch (e) {
      alert('재계산 실패: ' + e.message);
      if (msg) msg.textContent = '';
    }
  }

  // ── 무게 미입력 SKU 일괄 입력 모달 ──────────────────────────
  async function openBulkWeightModal() {
    try {
      const res = await fetch('/api/sku-master?weight_status=unknown');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      const skus = (j.data || []).filter(s => s.status !== 'discontinued');
      if (skus.length === 0) { alert('무게 미입력 SKU 가 없습니다.'); return; }
      renderBulkModal(skus);
    } catch (e) { alert('SKU 로드 실패: ' + e.message); }
  }

  function renderBulkModal(skus) {
    document.getElementById('srw-bulk-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'srw-bulk-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    const rows = skus.map(s => `
      <tr data-id="${s.id}" style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:8px;font-family:monospace;color:#81d4fa;font-size:11px;">${esc(s.internal_sku)}</td>
        <td style="padding:8px;color:#fff;font-size:11px;">${esc(s.title)}</td>
        <td style="padding:8px;">
          <input type="number" class="srw-bw-input" min="1" step="0.1" placeholder="g" style="width:80px;padding:5px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
        </td>
      </tr>
    `).join('');
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:720px;max-width:95vw;max-height:85vh;color:#e0e0e0;display:flex;flex-direction:column;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="color:#fff;font-size:16px;margin:0;">⚖️ 무게 일괄 입력 <span style="color:#888;font-size:12px;font-weight:400;">${skus.length}개 SKU</span></h2>
          <button onclick="document.getElementById('srw-bulk-modal').remove()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <p style="color:#888;font-size:12px;margin-bottom:10px;">단품무게(g)만 입력하면 weight_status=measured 로 저장됩니다. 비워두면 그 SKU 는 건너뜀.</p>
        <div style="flex:1;overflow:auto;background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#1a1a2e;position:sticky;top:0;"><th style="padding:8px;text-align:left;font-size:11px;color:#aaa;">SKU</th><th style="padding:8px;text-align:left;font-size:11px;color:#aaa;">제목</th><th style="padding:8px;font-size:11px;color:#aaa;">무게 (g)</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
          <button onclick="document.getElementById('srw-bulk-modal').remove()" style="padding:9px 16px;background:#2a2a4a;border:0;border-radius:6px;color:#ccc;cursor:pointer;font-size:13px;">취소</button>
          <button onclick="pmcShippingRecsWms.submitBulkWeights()" style="padding:9px 16px;background:#1565c0;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;font-size:13px;">💾 저장</button>
        </div>
        <div id="srw-bulk-status" style="color:#888;font-size:11px;margin-top:8px;"></div>
      </div>
    `;
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  }

  async function submitBulkWeights() {
    const rows = Array.from(document.querySelectorAll('#srw-bulk-modal tbody tr'));
    const updates = [];
    for (const r of rows) {
      const id = parseInt(r.dataset.id, 10);
      const inp = r.querySelector('.srw-bw-input');
      const w = Number(inp?.value);
      if (Number.isFinite(w) && w > 0) updates.push({ id, weight_gram: w });
    }
    if (updates.length === 0) { alert('입력된 무게가 없습니다'); return; }
    const status = document.getElementById('srw-bulk-status');
    if (status) status.textContent = `저장 중 (0/${updates.length})…`;
    let ok = 0, fail = 0;
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      try {
        const res = await fetch(`/api/sku-master/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weight_gram: u.weight_gram }),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
      if (status) status.textContent = `저장 중 (${i + 1}/${updates.length})…`;
    }
    alert(`완료 — 성공 ${ok}, 실패 ${fail}\n\n새로 입력된 무게는 다음 재계산 또는 새 주문 임포트부터 자동 반영됩니다.`);
    document.getElementById('srw-bulk-modal')?.remove();
    await refresh();
  }

  function onFilterChange() { refresh(); }

  window.pmcShippingRecsWms = {
    load, refresh, onFilterChange,
    openEdit, submitEdit, recalcOne, recalcAll,
    openBulkWeightModal, submitBulkWeights,
  };
})();
