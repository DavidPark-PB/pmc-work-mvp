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

  function renderItem(it, isReview) {
    const review = it.recommendation?.review;
    const reasonColor = isReview ? '#ff8a80' : '#81d4fa';
    return `
      <div style="padding:10px 16px;border-bottom:1px solid #1f1f3a;font-size:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;">
          <div style="color:#fff;">
            <strong>${esc(it.order_no || '#' + it.order_id)}</strong>
            <span style="color:#888;margin-left:6px;">${esc(it.platform || '')}</span>
            <span style="color:#888;margin-left:6px;">${esc(fmtDate(it.order_date))}</span>
          </div>
          <div style="color:${reasonColor};font-size:11px;">
            ${esc(it.recommendation?.reason || '')}
          </div>
        </div>
        <div style="color:#ccc;line-height:1.5;">
          ${esc(it.title || '-')} <span style="color:#888;">× ${it.quantity || 1}</span>
        </div>
        <div style="color:#888;font-size:11px;margin-top:3px;display:flex;gap:10px;flex-wrap:wrap;">
          ${it.buyer_name ? `<span>👤 ${esc(it.buyer_name)}</span>` : ''}
          ${it.country_code ? `<span>🌍 ${esc(it.country_code)}</span>` : (it.country ? `<span>🌍 ${esc(it.country)}</span>` : '')}
          ${it.weight_gram ? `<span>⚖️ ${esc(it.weight_gram)}g</span>` : ''}
          <span>🏷️ SKU: <code style="color:#81d4fa;">${esc(it.sku || '(빈 값)')}</code></span>
          ${it.matched ? `<span style="color:#81c784;">✓ ${esc(it.internal_sku)}</span>` : ''}
        </div>
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
    if (state.expanded.has(carrierKey)) state.expanded.delete(carrierKey);
    else state.expanded.add(carrierKey);
    renderGroups();
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

  window.pmcShippingRecs = {
    load, refresh, onStatusChange, onDaysChange, toggle, printGroup, exportGroup,
  };
})();
