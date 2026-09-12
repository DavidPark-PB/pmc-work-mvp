/**
 * public/js/omsOrders.js — PMC-OMS-CONSOLE-1B (2026-09-12).
 *
 * Canonical READ-ONLY pending-action orders console.
 *
 *   Source: GET /api/oms/orders/pending-action
 *   Data:   oms_orders where order_status IN PENDING_ACTION_STATUSES
 *           (SoT: src/services/oms/omsBriefingCounts.js — same array the
 *           briefing count consumes; count and this list are the same cohort
 *           by construction).
 *
 * V1 responsibilities:
 *   - render header + subtitle + total from API (not from briefing aggregate)
 *   - table of 8 owner-first columns (no PII, no SKU/tracking/profit fanout)
 *   - server-side pagination (limit=50, prev/next only)
 *   - three distinct states: LOADING · KNOWN_EMPTY · UNKNOWN_FAILURE
 *
 * Explicit fences:
 *   - no reference to wms_orders / /api/orders / wmsOrderRepository
 *   - no mutation controls, no bulk selection, no CSV
 *   - no secondary API fetch (single primary request per page mount / paginate)
 *   - no dashboard-count coalescing on failure (Unknown ≠ Zero)
 */
(function () {
  'use strict';

  //   URL whitelist — only 'pending-action' scope is honored in V1.
  //   Everything else is silently ignored (never trust arbitrary URL input).
  const URL_ALLOWED_SCOPES = ['pending-action'];
  const PAGE_LIMIT = 50;

  //   Owner-facing labels mapped from canonical status values (078 CHECK constraint).
  //   Unknown status → raw-safe fallback (never silently reinterpret as a known value).
  const STATUS_LABEL = Object.freeze({
    new:           '신규',
    confirmed:     '확인',
    processing:    '처리 중',
    on_hold:       '보류',
    ready_to_ship: '배송 준비',
  });
  const STATUS_COLOR = Object.freeze({
    new:           '#64b5f6',
    confirmed:     '#4dd0e1',
    processing:    '#ffb74d',
    on_hold:       '#ef9a9a',
    ready_to_ship: '#69f0ae',
  });
  //   hold_reason canonical allowlist (078:119-122). Unknown → raw fallback.
  const HOLD_REASON_LABEL = Object.freeze({
    out_of_stock:       '재고 부족',
    insufficient_stock: '재고 일부 부족',
    address_issue:      '주소 문제',
    payment_issue:      '결제 문제',
    customs_issue:      '세관 문제',
    fraud_risk:         '사기 의심',
    damaged_item:       '상품 파손',
    supplier_issue:     '공급사 문제',
    manual_review:      '수동 검토',
    other:              '기타',
  });

  //   Module-scope pagination state.
  let _scope   = null;
  let _offset  = 0;
  let _total   = null;   // null = UNKNOWN (never render as 0)
  //   Operational-truth queue — no data cache (matches PERF-2B opsInventory
  //   pattern). Only in-flight dedup to collapse rapid double-clicks.
  let _inflight = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function money(v, currency) {
    if (v == null || v === '') return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ' ' + esc(currency) : '');
  }
  function fmtAgo(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diffMs = Date.now() - t;
    if (diffMs < 0) return new Date(iso).toLocaleString('ko-KR');
    const mins  = Math.floor(diffMs / 60000);
    const hours = Math.floor(mins / 60);
    const days  = Math.floor(hours / 24);
    if (mins   < 1)   return '방금';
    if (mins   < 60)  return `${mins}분 전`;
    if (hours  < 24)  return `${hours}시간 전`;
    if (days   < 30)  return `${days}일 전`;
    return new Date(iso).toLocaleDateString('ko-KR');
  }
  function agoColor(iso) {
    if (!iso) return '#888';
    const diffMs = Date.now() - new Date(iso).getTime();
    const hours  = diffMs / 3600000;
    if (hours > 48) return '#ef9a9a';   // >48h idle · red
    if (hours > 24) return '#ffb74d';   // >24h · amber
    return '#aaa';
  }
  function readScopeFromUrl() {
    try {
      const s = new URLSearchParams(location.search).get('scope');
      if (s && URL_ALLOWED_SCOPES.includes(s)) return s;
    } catch (_) { /* silent */ }
    return null;
  }

  function renderShell(root) {
    root.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">📋 미처리 주문</h1>
        <p style="color:#888;font-size:13px;margin:0;">
          처리가 필요한 주문 (신규 · 확인 · 처리 중 · 보류 · 배송 준비)
        </p>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        <div id="oms-total" style="color:#e0e0e0;font-size:14px;font-weight:600;">
          <span id="oms-total-num">—</span>
          <span id="oms-total-range" style="color:#888;font-weight:400;margin-left:8px;font-size:12px;"></span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button id="oms-prev" type="button"
            style="padding:6px 12px;background:#37474f;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;"
            disabled>← 이전</button>
          <button id="oms-next" type="button"
            style="padding:6px 12px;background:#37474f;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;"
            disabled>다음 →</button>
          <button id="oms-refresh" type="button"
            style="padding:6px 12px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">
            새로고침
          </button>
        </div>
      </div>

      <div id="oms-body"
        style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:hidden;">
      </div>
    `;
    document.getElementById('oms-prev').addEventListener('click', gotoPrev);
    document.getElementById('oms-next').addEventListener('click', gotoNext);
    document.getElementById('oms-refresh').addEventListener('click', () => refresh());
  }

  function renderLoading() {
    const body = document.getElementById('oms-body');
    if (!body) return;
    body.innerHTML = `
      <div style="padding:40px;text-align:center;color:#888;font-size:13px;">
        <div style="margin-bottom:8px;">주문 정보를 불러오는 중…</div>
        <div style="width:60%;max-width:280px;height:4px;background:#0f0f23;border-radius:2px;margin:0 auto;overflow:hidden;">
          <div style="height:100%;width:40%;background:linear-gradient(90deg,#37474f,#64b5f6,#37474f);animation:oms-shimmer 1.4s infinite ease-in-out;"></div>
        </div>
      </div>
      <style>@keyframes oms-shimmer{0%{transform:translateX(-60%)}100%{transform:translateX(220%)}}</style>
    `;
  }
  function renderKnownEmpty() {
    const body = document.getElementById('oms-body');
    if (!body) return;
    body.innerHTML = `
      <div style="padding:60px 20px;text-align:center;color:#69f0ae;font-size:14px;">
        ✓ 현재 미처리 주문이 없습니다.
      </div>`;
  }
  function renderUnknownFailure(msg) {
    const body = document.getElementById('oms-body');
    if (!body) return;
    body.innerHTML = `
      <div style="padding:40px 20px;text-align:center;">
        <div style="color:#ef9a9a;font-size:14px;font-weight:600;margin-bottom:8px;">⚠ 주문 정보를 확인하지 못했습니다.</div>
        <div style="color:#888;font-size:12px;margin-bottom:14px;">${esc(msg || '네트워크 또는 서버 오류')}</div>
        <button id="oms-retry" type="button"
          style="padding:8px 16px;background:#37474f;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">
          다시 시도
        </button>
      </div>`;
    const btn = document.getElementById('oms-retry');
    if (btn) btn.addEventListener('click', () => refresh());
  }

  function renderTable(rows) {
    const body = document.getElementById('oms-body');
    if (!body) return;
    const TH = 'padding:10px 12px;text-align:left;background:#0f0f23;border-bottom:1px solid #2a2a4a;color:#888;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;';
    const TD = 'padding:10px 12px;border-bottom:1px solid #23233a;color:#e0e0e0;font-size:12px;vertical-align:top;';
    const head = `
      <thead>
        <tr>
          <th style="${TH}">채널</th>
          <th style="${TH}">주문번호</th>
          <th style="${TH}">주문일</th>
          <th style="${TH}">상태</th>
          <th style="${TH}">보류 사유</th>
          <th style="${TH}">국가</th>
          <th style="${TH};text-align:right;">총액</th>
          <th style="${TH};text-align:right;">경과</th>
        </tr>
      </thead>`;
    const html = rows.map(o => {
      const statusLabel = STATUS_LABEL[o.order_status] || esc(o.order_status || '—');
      const statusColor = STATUS_COLOR[o.order_status] || '#888';
      const holdLabel   = o.order_status === 'on_hold'
        ? (HOLD_REASON_LABEL[o.hold_reason] || esc(o.hold_reason || '—'))
        : '—';
      const orderNo = esc(o.external_order_number || o.external_order_id || '');
      const orderNoShort = orderNo.length > 14 ? '…' + orderNo.slice(-12) : orderNo;
      return `
        <tr>
          <td style="${TD}"><span style="background:#1a3a4a;color:#64b5f6;padding:2px 6px;border-radius:3px;font-size:11px;font-family:monospace;">${esc(o.channel || '?')}</span></td>
          <td style="${TD};font-family:monospace;color:#fff;" title="${orderNo}">${orderNoShort}</td>
          <td style="${TD};color:#aaa;">${o.ordered_at ? esc(new Date(o.ordered_at).toLocaleString('ko-KR')) : '—'}</td>
          <td style="${TD}"><span style="color:${statusColor};font-weight:600;">${esc(statusLabel)}</span></td>
          <td style="${TD};color:${o.order_status === 'on_hold' ? '#ef9a9a' : '#666'};">${holdLabel}</td>
          <td style="${TD};font-family:monospace;color:#aaa;">${esc(o.ship_country_code || '—')}</td>
          <td style="${TD};text-align:right;font-family:monospace;">${money(o.total, o.currency)}</td>
          <td style="${TD};text-align:right;color:${agoColor(o.ordered_at)};">${fmtAgo(o.ordered_at)}</td>
        </tr>`;
    }).join('');
    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        ${head}
        <tbody>${html}</tbody>
      </table>`;
  }

  function updateHeader(total, offset, count) {
    const numEl   = document.getElementById('oms-total-num');
    const rangeEl = document.getElementById('oms-total-range');
    if (numEl) {
      //   UNKNOWN ≠ ZERO — never render `0건` for a null/unknown total.
      if (typeof total !== 'number') {
        numEl.textContent = '미처리 주문 확인 실패';
        numEl.style.color = '#ef9a9a';
      } else {
        numEl.textContent = `미처리 주문 ${total.toLocaleString('ko-KR')}건`;
        numEl.style.color = '#e0e0e0';
      }
    }
    if (rangeEl) {
      if (typeof total === 'number' && count > 0) {
        rangeEl.textContent = `· ${offset + 1}–${offset + count} 표시`;
      } else {
        rangeEl.textContent = '';
      }
    }
    //   Pagination button state — only when total is known.
    const prev = document.getElementById('oms-prev');
    const next = document.getElementById('oms-next');
    if (prev) prev.disabled = !(offset > 0);
    if (next) next.disabled = !(typeof total === 'number' && offset + count < total);
  }

  async function _fetchAndRender() {
    renderLoading();
    updateHeader(_total, _offset, 0);
    try {
      const res  = await fetch(`/api/oms/orders/pending-action?limit=${PAGE_LIMIT}&offset=${_offset}`, {
        credentials: 'include',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok !== true) {
        //   Unknown / failure branch — do NOT silently fall back to 0.
        _total = null;
        renderUnknownFailure(json.error || json.message || `HTTP ${res.status}`);
        updateHeader(null, _offset, 0);
        return;
      }
      _total = Number.isFinite(json.total) ? json.total : null;
      const rows = Array.isArray(json.rows) ? json.rows : [];
      if (_total === 0 && rows.length === 0) {
        renderKnownEmpty();
      } else {
        renderTable(rows);
      }
      updateHeader(_total, _offset, rows.length);
    } catch (e) {
      _total = null;
      renderUnknownFailure(e && e.message ? e.message : String(e));
      updateHeader(null, _offset, 0);
    }
  }

  //   In-flight dedup only — rapid double-click cannot fire two concurrent
  //   requests. No TTL cache (operational truth, matches PERF-2B opsInventory).
  function refresh() {
    if (_inflight) return _inflight;
    _inflight = _fetchAndRender().finally(() => { _inflight = null; });
    return _inflight;
  }

  function gotoPrev() {
    if (_offset <= 0) return;
    _offset = Math.max(0, _offset - PAGE_LIMIT);
    refresh();
  }
  function gotoNext() {
    if (typeof _total !== 'number') return;
    if (_offset + PAGE_LIMIT >= _total) return;
    _offset += PAGE_LIMIT;
    refresh();
  }

  async function init() {
    const root = document.getElementById('oms-orders-section');
    if (!root) return;
    _scope  = readScopeFromUrl() || 'pending-action';
    _offset = 0;
    _total  = null;
    if (root.dataset.initialized !== '1') {
      root.dataset.initialized = '1';
      renderShell(root);
    }
    await refresh();
  }

  window.pmcOmsOrders = { init, refresh };
})();
