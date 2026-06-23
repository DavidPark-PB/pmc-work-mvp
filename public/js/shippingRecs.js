/**
 * 배송 추천 화면 (PR Phase 2B) — 사장님 spec 그대로.
 *
 * 직원이 색깔별 묶음 보고 송장 인쇄 → 같은 색 박스 일괄 포장.
 * 판단 = 0, 검색 = 0. 검토 필요 그룹만 사장님이 따로 본다.
 *
 * 상태 필터 확장 가능 구조 (사장님 추가 조건 1):
 *   기본 NEW. select 옵션이 backend allowedStatuses 에서 채워짐. 추후 READY/SHIPPED/ALL 자동 노출.
 *
 * SKU 매칭 실패 상세 표기 (사장님 추가 조건 2):
 *   item.match_attempt / item.match_reason / item.recommendation.review.message 모두 화면에 노출.
 */
(function() {
  let user = null;
  let state = {
    status: 'NEW',
    days: 7,
    allowedStatuses: ['NEW'],
    groups: [],
    counts: {},
    totalOrders: 0,
    loading: false,
    error: null,
    expanded: new Set(),  // 펼쳐진 carrier_key 집합
  };

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(s) { return s ? String(s).slice(0, 10) : '-'; }

  async function load() {
    if (!user) {
      user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    }
    if (!user) return;
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-shipping-recs');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:14px;">
        <h1 style="font-size:22px;color:#fff;margin:0;">📦 배송 추천 <span style="color:#888;font-weight:400;font-size:13px;">· Phase 2B · 무게+국가 단순 룰</span></h1>
        <p style="color:#888;font-size:13px;margin:4px 0 0;">직원이 배송사를 판단하지 않아도 되게 — 색깔별 묶음 송장 인쇄용. 송장 자동 출력은 다음 단계.</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <label style="color:#aaa;font-size:12px;">상태</label>
        <select id="rec-status" onchange="pmcShippingRecs.onStatusChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="NEW">NEW (대기)</option>
        </select>

        <label style="color:#aaa;font-size:12px;margin-left:8px;">기간</label>
        <select id="rec-days" onchange="pmcShippingRecs.onDaysChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="1">오늘 (1일)</option>
          <option value="3">최근 3일</option>
          <option value="7" selected>최근 7일</option>
          <option value="14">최근 14일</option>
          <option value="30">최근 30일</option>
        </select>

        <button type="button" onclick="pmcShippingRecs.refresh()" style="padding:6px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🔄 새로고침</button>
        <span id="rec-status-msg" style="color:#888;font-size:11px;margin-left:auto;"></span>
      </div>

      <div id="rec-summary"></div>
      <div id="rec-groups"></div>
    `;
  }

  async function refresh() {
    state.loading = true;
    const msg = document.getElementById('rec-status-msg');
    if (msg) { msg.style.color = '#888'; msg.textContent = '로딩 중...'; }
    try {
      const params = new URLSearchParams();
      params.set('status', state.status);
      params.set('days', String(state.days));
      const res = await fetch('/api/shipping/recommendations?' + params);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      state.groups = j.groups || [];
      state.counts = j.counts || {};
      state.totalOrders = j.totalOrders || 0;
      state.allowedStatuses = j.filter?.allowedStatuses || ['NEW'];
      _syncStatusOptions();
      renderSummary(j);
      renderGroups();
      if (msg) {
        msg.style.color = '#81c784';
        msg.textContent = `✓ ${j.filter?.from} ~ ${j.filter?.to} · 총 ${state.totalOrders}건`;
      }
    } catch (e) {
      if (msg) { msg.style.color = '#ff8a80'; msg.textContent = '실패: ' + e.message; }
    } finally {
      state.loading = false;
    }
  }

  // backend 가 보내준 allowedStatuses 로 select 옵션을 sync — 신규 상태 추가 시 자동 노출
  function _syncStatusOptions() {
    const sel = document.getElementById('rec-status');
    if (!sel) return;
    const current = sel.value || 'NEW';
    const labels = { NEW: 'NEW (대기)', READY: 'READY (포장 준비)', SHIPPED: 'SHIPPED (발송됨)', ALL: 'ALL (전체)' };
    sel.innerHTML = (state.allowedStatuses || ['NEW']).map(s => {
      const lbl = labels[s] || s;
      return `<option value="${esc(s)}" ${s === current ? 'selected' : ''}>${esc(lbl)}</option>`;
    }).join('');
  }

  function onStatusChange() {
    state.status = document.getElementById('rec-status').value || 'NEW';
    refresh();
  }
  function onDaysChange() {
    state.days = parseInt(document.getElementById('rec-days').value, 10) || 7;
    refresh();
  }

  function renderSummary(j) {
    const host = document.getElementById('rec-summary');
    if (!host) return;
    if (state.totalOrders === 0) {
      host.innerHTML = `<div style="padding:30px;text-align:center;color:#888;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;margin-bottom:14px;">처리할 주문이 없습니다.</div>`;
      return;
    }
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;padding:14px;margin-bottom:14px;">
        <div style="color:#fff;font-size:14px;margin-bottom:8px;">오늘 처리할 주문: <strong style="color:#81c784;">${state.totalOrders}건</strong></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${(state.groups || []).filter(g => g.count > 0).map(g => `
            <span style="padding:4px 10px;background:${g.carrier.color};color:#fff;border-radius:14px;font-size:12px;font-weight:600;">
              ${g.carrier.emoji} ${esc(g.carrier.label)} ${g.count}
            </span>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderGroups() {
    const host = document.getElementById('rec-groups');
    if (!host) return;
    const visible = (state.groups || []).filter(g => g.count > 0);
    if (visible.length === 0) {
      host.innerHTML = '';
      return;
    }
    host.innerHTML = visible.map(g => renderGroupCard(g)).join('');
  }

  // 구글시트 자동입력 지원 배송사 (backend CARRIER_KEY_TO_SHEET_NAME 와 일치)
  const SHEET_SUPPORTED_KEYS = new Set(['shipter', 'kpl', 'yun']);

  function renderGroupCard(g) {
    const isReview = g.carrier.key === 'review';
    const expanded = state.expanded.has(g.carrier.key);
    const sheetSupported = SHEET_SUPPORTED_KEYS.has(g.carrier.key);
    return `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-left:4px solid ${g.carrier.color};border-radius:10px;margin-bottom:10px;overflow:hidden;">
        <div onclick="pmcShippingRecs.toggle('${esc(g.carrier.key)}')"
             style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;background:${isReview ? '#2a1a1a' : 'transparent'};">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:18px;">${g.carrier.emoji}</span>
            <strong style="color:${g.carrier.color};font-size:15px;">${esc(g.carrier.label)}</strong>
            <span style="padding:2px 10px;background:${g.carrier.color};color:#fff;border-radius:12px;font-size:12px;font-weight:600;">${g.count}건</span>
            ${isReview ? '<span style="color:#ff8a80;font-size:11px;margin-left:6px;">⚠️ 사장님 검토 필요</span>' : ''}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            ${sheetSupported && g.count > 0 ? `<button type="button" onclick="event.stopPropagation();pmcShippingRecs.exportGroup('${esc(g.carrier.key)}')"
              id="rec-export-btn-${esc(g.carrier.key)}"
              style="padding:5px 12px;background:${g.carrier.color};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">📊 구글시트 자동입력</button>` : ''}
            ${!isReview && g.count > 0 ? `<button type="button" onclick="event.stopPropagation();pmcShippingRecs.printGroup('${esc(g.carrier.key)}')"
              style="padding:5px 12px;background:#0f0f23;border:1px solid ${g.carrier.color};border-radius:4px;color:${g.carrier.color};cursor:pointer;font-size:11px;font-weight:600;">📋 묶음 출력</button>` : ''}
            <span style="color:#888;font-size:14px;">${expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        ${expanded ? `<div style="border-top:1px solid #2a2a4a;background:#0d0d1f;">${g.items.map(it => renderItem(it, isReview)).join('')}</div>` : ''}
      </div>
    `;
  }

  // 구글시트 자동입력 — 그룹 단위 일괄 처리
  async function exportGroup(carrierKey) {
    const g = (state.groups || []).find(x => x.carrier.key === carrierKey);
    if (!g || g.count === 0) return;
    const orderIds = g.items.map(it => it.order_id).filter(id => id != null);
    if (orderIds.length === 0) { alert('입력할 주문이 없습니다'); return; }

    const ok = confirm(`${g.carrier.label} 배송사 시트에 ${orderIds.length}건 일괄 입력하시겠습니까?\n\n오늘 날짜 탭 (MM/DD) 에 추가됩니다.`);
    if (!ok) return;

    const btn = document.getElementById('rec-export-btn-' + carrierKey);
    const origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 입력 중...'; }

    try {
      const res = await fetch('/api/shipping/recommendations/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds, carrierKey }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');

      const msg = `✅ 입력 완료: ${j.ok}건${j.fail ? ` / ❌ 실패: ${j.fail}건` : ''}${j.skipped ? ` / ⏭️ 건너뜀: ${j.skipped}건` : ''}`;
      alert(msg + (j.fail || j.skipped ? '\n\n' + (j.results || []).filter(r => r.status !== 'ok').slice(0, 10).map(r => `${r.order_no}: ${r.error || r.reason || r.status}`).join('\n') : ''));

      // 성공 시 새로고침 — status='READY' 로 바뀌어 NEW 필터에서 빠짐
      await refresh();
    } catch (e) {
      alert('구글시트 입력 실패: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  }

  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '-';
    return Number(n).toLocaleString('ko-KR') + '원';
  }

  // 페덱스 견적을 5개 quotes 배열에 통합 후 가격 재정렬. isCheapest 갱신.
  function mergeFedexQuotes(quotes, fedexResult) {
    if (!Array.isArray(quotes)) return [];
    if (!fedexResult || !fedexResult.cheapest) return quotes;
    const fedexQuote = {
      carrier: 'fedex',
      carrierLabel: 'FedEx',
      service: fedexResult.cheapest.serviceName || fedexResult.cheapest.serviceType,
      chargeKg: fedexResult.weightKg,
      volKg: 0,
      base: Math.round(fedexResult.cheapest.cost),
      fuel: 0,
      total: Math.round(fedexResult.cheapest.cost),
      note: `라이브 견적 · ETA ${fedexResult.cheapest.etaDays || '?'}일 · ${fedexResult.cheapest.currency || ''}`,
      isFedex: true,
    };
    const merged = [...quotes.map(q => ({ ...q, isCheapest: false })), fedexQuote];
    merged.sort((a, b) => a.total - b.total);
    merged[0].isCheapest = true;
    return merged;
  }

  // 5개 배송사 + (선택) FedEx 견적 비교표. 최저가 ✅ 강조.
  // hasFedex=true 이고 페덱스가 행이면 라벨 발급 버튼 노출.
  function renderQuotesTable(quotes, hasFedex, orderId) {
    if (!Array.isArray(quotes) || quotes.length === 0) return '';
    const rows = quotes.map(q => {
      const fuelTxt = q.fuel ? fmtMoney(q.fuel) : '포함';
      const isFedex = q.isFedex === true;
      const labelBtn = isFedex
        ? ` <button onclick="pmcShippingRecs.labelFedex(${orderId}, '${esc(q.service)}')" style="margin-left:6px;padding:2px 8px;background:#e94560;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;font-weight:600;">🖨 라벨</button>`
        : '';
      return `
        <tr style="${q.isCheapest ? 'background:#1a3a2a;' : ''}${isFedex && !q.isCheapest ? 'background:#2a1a1a;' : ''}">
          <td style="padding:5px 8px;color:${q.isCheapest ? '#81c784' : (isFedex ? '#ff8a80' : '#ccc')};white-space:nowrap;">
            ${q.isCheapest ? '✅ ' : ''}<strong>${esc(q.carrierLabel)}</strong>${labelBtn}
          </td>
          <td style="padding:5px 8px;color:#888;font-size:10px;">${esc(q.service || '')}</td>
          <td style="padding:5px 8px;color:#aaa;text-align:right;white-space:nowrap;">${Number(q.chargeKg).toFixed(2)}kg</td>
          <td style="padding:5px 8px;color:#aaa;text-align:right;white-space:nowrap;">${fmtMoney(q.base)}</td>
          <td style="padding:5px 8px;color:#aaa;text-align:right;white-space:nowrap;">${fuelTxt}</td>
          <td style="padding:5px 8px;color:${q.isCheapest ? '#81c784' : (isFedex ? '#ff8a80' : '#fff')};text-align:right;white-space:nowrap;font-weight:600;">${fmtMoney(q.total)}</td>
        </tr>
        ${q.note ? `<tr><td colspan="6" style="padding:0 8px 5px;color:#888;font-size:10px;font-style:italic;">${isFedex ? '🔴' : '⚠️'} ${esc(q.note)}</td></tr>` : ''}
      `;
    }).join('');

    const title = hasFedex
      ? '📊 6개 배송사 견적 비교 (FedEx 라이브 포함)'
      : '📊 5개 배송사 견적 비교 (부피중량 + 유류할증 포함)';

    return `
      <div style="margin-top:8px;border:1px solid #2a2a4a;border-radius:6px;overflow:hidden;">
        <div style="padding:5px 10px;background:#16213e;color:#81d4fa;font-size:10px;font-weight:600;">${title}</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:#0d1326;color:#888;">
              <th style="padding:5px 8px;text-align:left;font-weight:600;">배송사</th>
              <th style="padding:5px 8px;text-align:left;font-weight:600;">서비스</th>
              <th style="padding:5px 8px;text-align:right;font-weight:600;">적용중량</th>
              <th style="padding:5px 8px;text-align:right;font-weight:600;">기본운임</th>
              <th style="padding:5px 8px;text-align:right;font-weight:600;">유류</th>
              <th style="padding:5px 8px;text-align:right;font-weight:600;">합계</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderItem(it, isReview) {
    const review = it.recommendation?.review;
    const reasonColor = isReview ? '#ff8a80' : '#81c784';
    const dim = it.dimensions_cm;
    // FedEx 견적/라벨 버튼 — review 아니고 매칭+무게 있을 때만 (FedEx API 호출 가능 조건)
    const fedexEligible = !isReview && it.matched && it.weight_gram;
    // 페덱스 견적 캐시 — 이미 있으면 quotes 표에 통합
    const fedexCache = fedexQuoteCache.get(it.order_id);
    const mergedQuotes = mergeFedexQuotes(it.quotes, fedexCache);
    return `
      <div style="padding:10px 16px;border-bottom:1px solid #1f1f3a;font-size:12px;" id="rec-item-${it.order_id}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;">
          <div style="color:#fff;">
            <strong>${esc(it.order_no || '#' + it.order_id)}</strong>
            <span style="color:#888;margin-left:6px;">${esc(it.platform || '')}</span>
            <span style="color:#888;margin-left:6px;">${esc(fmtDate(it.order_date))}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="color:${reasonColor};font-size:11px;font-weight:600;">${esc(it.recommendation?.reason || '')}</span>
            <button type="button" onclick="pmcShippingRecs.toggleWeightEdit(${it.order_id})"
              style="padding:3px 8px;background:#0f0f23;border:1px solid #555;border-radius:4px;color:#aaa;cursor:pointer;font-size:10px;white-space:nowrap;" title="무게/치수 수정">✏️ 무게</button>
            ${fedexEligible && !fedexCache ? `<button type="button" onclick="pmcShippingRecs.quoteFedex(${it.order_id})"
              id="rec-fedex-btn-${it.order_id}"
              style="padding:3px 8px;background:#0f0f23;border:1px solid #e94560;border-radius:4px;color:#e94560;cursor:pointer;font-size:10px;font-weight:600;white-space:nowrap;">🔴 FedEx 견적</button>` : ''}
          </div>
        </div>
        <div style="color:#ccc;line-height:1.5;">
          ${esc(it.title || '-')} <span style="color:#888;">× ${it.quantity || 1}</span>
        </div>
        <div style="color:#888;font-size:11px;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap;">
          ${it.buyer_name ? `<span>👤 ${esc(it.buyer_name)}</span>` : ''}
          ${it.country_code ? `<span>🌍 ${esc(it.country_code)}</span>` : (it.country ? `<span>🌍 ${esc(it.country)}</span>` : '')}
          ${it.weight_gram ? `<span>⚖️ ${esc(it.weight_gram)}g</span>` : ''}
          ${dim ? `<span>📐 ${esc(dim.l)}×${esc(dim.w)}×${esc(dim.h)}cm</span>` : ''}
          <span>🏷️ SKU: <code style="color:#81d4fa;">${esc(it.sku || '(빈 값)')}</code></span>
          ${it.matched ? `<span style="color:#81c784;">✓ ${esc(it.internal_sku)}</span>` : ''}
        </div>
        ${renderWeightEditPanel(it)}
        ${renderQuotesTable(mergedQuotes, !!fedexCache, it.order_id)}
        <div id="rec-fedex-result-${it.order_id}"></div>
        ${review ? `
          <div style="margin-top:6px;padding:6px 10px;background:#2a1a1a;border-left:3px solid #e94560;border-radius:4px;font-size:11px;color:#ff8a80;">
            <strong>⚠️ ${esc(review.code)}:</strong> ${esc(review.message)}
            ${it.match_attempt ? `<br><span style="color:#888;">시도한 SKU: <code>${esc(it.match_attempt)}</code></span>` : ''}
            ${(!it.matched && it.match_reason && !review.message.includes(it.match_reason || '_NEVER_')) ? `<br><span style="color:#888;">${esc(it.match_reason)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  function toggle(carrierKey) {
    const wasExpanded = state.expanded.has(carrierKey);
    if (wasExpanded) state.expanded.delete(carrierKey);
    else state.expanded.add(carrierKey);
    renderGroups();
    // 펼친 순간 → 그 그룹의 매칭+무게 있는 주문에 페덱스 자동 견적 (캐시 미스만).
    // review 그룹은 견적 호출 X (매칭 안된 주문만 있음).
    if (!wasExpanded && carrierKey !== 'review') {
      autoQuoteFedexForGroup(carrierKey);
    }
  }

  // 묶음 출력 — Phase 2B 는 송장 API 연동 X. 직원이 어떤 주문번호를 인쇄해야 하는지 list 보여줌.
  function printGroup(carrierKey) {
    const g = (state.groups || []).find(x => x.carrier.key === carrierKey);
    if (!g) return;
    const orderNos = g.items.map(it => it.order_no).filter(Boolean);
    const text = `${g.carrier.label} 묶음 (${g.count}건)\n\n` + orderNos.join('\n');
    // 새 창에 텍스트 표시 (직원이 복사해서 송장 사이트 일괄 입력)
    const w = window.open('', '_blank', 'width=520,height=600');
    if (!w) { alert(text); return; }
    w.document.write(`
      <html><head><title>${g.carrier.label} 묶음</title>
      <style>body{font-family:monospace;padding:20px;background:#fff;color:#000;}
      h2{color:${g.carrier.color};}pre{font-size:14px;line-height:1.6;}</style>
      </head><body>
      <h2>${g.carrier.emoji} ${g.carrier.label} 묶음 (${g.count}건)</h2>
      <p style="color:#666;font-size:11px;">송장 API 미연동 — 주문번호 list 만 표시. 복사해서 각 배송사 사이트에 일괄 입력.</p>
      <pre>${orderNos.join('\n')}</pre>
      <button onclick="navigator.clipboard.writeText(document.querySelector('pre').textContent);this.textContent='✓ 복사됨'">📋 클립보드 복사</button>
      <button onclick="window.print()">🖨️ 인쇄</button>
      </body></html>
    `);
    w.document.close();
  }

  // ════════════════════════════════════════════════════════════
  // 무게/치수 수정 (사장님 요청 2026-06-23 — 잘못 입력해도 다시 수정 가능)
  // 각 주문 카드의 '✏️ 무게' 버튼 → 입력 폼 토글. 저장 시 PATCH /api/orders/save-weight.
  // ════════════════════════════════════════════════════════════
  function renderWeightEditPanel(it) {
    const dim = it.dimensions_cm || { l: '', w: '', h: '' };
    const wKg = it.weight_gram ? (Number(it.weight_gram) / 1000).toFixed(3) : '';
    return `
      <div id="rec-wedit-${it.order_id}" style="display:none;margin-top:8px;padding:10px;background:#16213e;border:1px solid #2a4a6a;border-radius:6px;">
        <div style="color:#81d4fa;font-size:10px;font-weight:600;margin-bottom:6px;">✏️ 무게/치수 수정 (저장하면 견적 자동 재계산)</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <label style="color:#aaa;font-size:11px;">무게(kg)</label>
          <input id="rec-w-${it.order_id}" type="number" step="0.01" min="0" value="${wKg}" style="width:70px;padding:4px 6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;">
          <label style="color:#aaa;font-size:11px;">가로(cm)</label>
          <input id="rec-l-${it.order_id}" type="number" step="0.1" min="0" value="${dim.l || ''}" style="width:60px;padding:4px 6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;">
          <label style="color:#aaa;font-size:11px;">세로(cm)</label>
          <input id="rec-ww-${it.order_id}" type="number" step="0.1" min="0" value="${dim.w || ''}" style="width:60px;padding:4px 6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;">
          <label style="color:#aaa;font-size:11px;">높이(cm)</label>
          <input id="rec-h-${it.order_id}" type="number" step="0.1" min="0" value="${dim.h || ''}" style="width:60px;padding:4px 6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;">
          <button type="button" onclick="pmcShippingRecs.saveWeight(${it.order_id}, '${esc(it.order_no || '')}', '${esc(it.sku || '')}')"
            style="padding:4px 12px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">💾 저장 후 재계산</button>
          <span id="rec-wstatus-${it.order_id}" style="color:#888;font-size:10px;"></span>
        </div>
      </div>
    `;
  }

  function toggleWeightEdit(orderId) {
    const el = document.getElementById('rec-wedit-' + orderId);
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  async function saveWeight(orderId, orderNo, sku) {
    const wKg = parseFloat(document.getElementById('rec-w-' + orderId)?.value) || 0;
    const l   = parseFloat(document.getElementById('rec-l-' + orderId)?.value) || 0;
    const w   = parseFloat(document.getElementById('rec-ww-' + orderId)?.value) || 0;
    const h   = parseFloat(document.getElementById('rec-h-' + orderId)?.value) || 0;
    const status = document.getElementById('rec-wstatus-' + orderId);
    if (!orderNo) { if (status) { status.textContent = '❌ 주문번호 누락'; status.style.color = '#ff8a80'; } return; }
    if (wKg <= 0) { if (status) { status.textContent = '⚠️ 무게는 0보다 커야 함'; status.style.color = '#ffb74d'; } return; }

    if (status) { status.textContent = '⏳ 저장 중...'; status.style.color = '#81d4fa'; }
    try {
      const res = await fetch('/api/orders/save-weight', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNo, sku,
          weight_kg: wKg,
          box_length: l, box_width: w, box_height: h,
        }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || '실패');
      if (status) { status.textContent = '✅ 저장됨 — 견적 재계산 중...'; status.style.color = '#81c784'; }
      // 페덱스 캐시 무효화 — 무게 바뀌었으니 재호출 필요
      fedexQuoteCache.delete(orderId);
      // 전체 새로고침 — 5개 견적 + dimensions_cm 다시 그려짐
      setTimeout(() => refresh(), 600);
    } catch (e) {
      if (status) { status.textContent = '❌ 저장 실패: ' + e.message; status.style.color = '#ff8a80'; }
    }
  }

  // ════════════════════════════════════════════════════════════
  // FedEx 견적 + 라벨 발급 (사장님 spec 2026-06-23)
  // 그룹 펼침 시 그 그룹의 매칭+무게 있는 주문에 자동 호출 (병렬).
  // 사용자가 카드별 'FedEx 견적' 버튼 클릭으로 개별 호출도 가능 (재호출).
  // 견적 받으면 5개 견적과 통합 표시 + 'FedEx 라벨' 발급 버튼.
  // ════════════════════════════════════════════════════════════

  // 견적 결과 캐시 (재호출 방지) — 주문ID → { weightKg, dims, cheapest, services, customsValue, currency }
  const fedexQuoteCache = new Map();

  // 그룹 펼침 시 자동 페덱스 호출 — 그 그룹의 매칭+무게 있는 주문에 일괄.
  // 최대 5개 동시 호출 (FedEx API 부담 + 브라우저 한도).
  async function autoQuoteFedexForGroup(carrierKey) {
    const g = (state.groups || []).find(x => x.carrier.key === carrierKey);
    if (!g) return;
    const eligible = g.items.filter(it =>
      it.matched && it.weight_gram && !fedexQuoteCache.has(it.order_id)
    );
    if (eligible.length === 0) return;

    const CONCURRENCY = 5;
    let idx = 0;
    async function worker() {
      while (idx < eligible.length) {
        const it = eligible[idx++];
        try {
          const res = await fetch('/api/shipping/recommendations/fedex-quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: it.order_id }),
          });
          const j = await res.json();
          if (res.ok && j.ok) {
            fedexQuoteCache.set(it.order_id, j);
          } else {
            // 실패한 주문은 캐시에 'failed' 마커 저장해서 재호출 방지
            fedexQuoteCache.set(it.order_id, { failed: true, error: j.error });
          }
        } catch (e) {
          fedexQuoteCache.set(it.order_id, { failed: true, error: e.message });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, () => worker()));
    // 끝나면 해당 그룹만 다시 그리기 (전체 refresh X)
    renderGroups();
  }

  // 단일 주문 페덱스 견적 — 자동 호출 실패 후 수동 재시도 / 캐시 무효화 후 재호출 용도
  async function quoteFedex(orderId) {
    const btn = document.getElementById('rec-fedex-btn-' + orderId);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 호출 중...'; }
    try {
      const res = await fetch('/api/shipping/recommendations/fedex-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || '실패');
      fedexQuoteCache.set(orderId, j);
      renderGroups();  // 통합 표에 페덱스 행 추가됨
    } catch (e) {
      fedexQuoteCache.set(orderId, { failed: true, error: e.message });
      renderGroups();
    }
  }

  async function labelFedex(orderId, serviceType) {
    const cache = fedexQuoteCache.get(orderId);
    if (!cache || cache.failed) { alert('견적 정보가 없습니다. 먼저 FedEx 견적을 받으세요.'); return; }

    // 주문번호 = cache.orderNo. /api/orders/:orderNo/fedex-label 호출.
    const ok = confirm(`주문 ${cache.orderNo} 의 FedEx 라벨을 발급하시겠습니까?\n\n서비스: ${serviceType}\n요금: ${cache.cheapest?.cost || '?'} ${cache.currency || ''}\n\n발급 후 취소 불가.`);
    if (!ok) return;

    const result = document.getElementById('rec-fedex-result-' + orderId);
    if (result) {
      const status = document.createElement('div');
      status.id = 'rec-fedex-label-status-' + orderId;
      status.style.cssText = 'margin-top:6px;padding:6px 10px;background:#1a3a5a;border-radius:4px;font-size:11px;color:#81d4fa;';
      status.textContent = '⏳ FedEx 라벨 발급 중... (10~30초)';
      result.appendChild(status);
    }

    try {
      const dims = cache.dims ? {
        length: cache.dims.length || cache.dims.l,
        width: cache.dims.width || cache.dims.w,
        height: cache.dims.height || cache.dims.h,
      } : null;
      const res = await fetch(`/api/orders/${encodeURIComponent(cache.orderNo)}/fedex-label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weightKg: cache.weightKg,
          dimensions: dims,
          serviceType,
          customsValue: cache.customsValue,
          currency: cache.currency,
        }),
      });
      const j = await res.json();
      const status = document.getElementById('rec-fedex-label-status-' + orderId);
      if (!res.ok || !j.success) {
        if (status) {
          status.style.background = '#2a1a1a';
          status.style.color = '#ff8a80';
          status.textContent = '❌ 라벨 발급 실패: ' + (j.error || '실패');
        }
        return;
      }
      if (status) {
        status.style.background = '#1a3a2a';
        status.style.color = '#81c784';
        status.innerHTML = `✅ FedEx 라벨 발급 완료 — 운송장: <strong>${esc(j.trackingNumber || '')}</strong>` +
          (j.labelStored ? ` · <a href="javascript:void(0)" onclick="pmcShippingRecs.viewLabel('${esc(cache.orderNo)}')" style="color:#81c784;">📄 라벨 PDF 열기</a>` : '');
      }
      // 라벨 발급 → status='SHIPPED' 자동. 새로고침으로 NEW 필터에서 빠짐.
      setTimeout(() => refresh(), 1500);
    } catch (e) {
      const status = document.getElementById('rec-fedex-label-status-' + orderId);
      if (status) {
        status.style.background = '#2a1a1a';
        status.style.color = '#ff8a80';
        status.textContent = '❌ 라벨 발급 에러: ' + e.message;
      }
    }
  }

  async function viewLabel(orderNo) {
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderNo)}/fedex-label`);
      const j = await res.json();
      if (!j.success || !j.url) throw new Error(j.error || '라벨 URL 없음');
      window.open(j.url, '_blank');
    } catch (e) {
      alert('라벨 다운로드 실패: ' + e.message);
    }
  }

  window.pmcShippingRecs = {
    load, refresh, onStatusChange, onDaysChange, toggle, printGroup, exportGroup,
    quoteFedex, labelFedex, viewLabel,
    toggleWeightEdit, saveWeight,
  };
})();
