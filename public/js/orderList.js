/**
 * WMS 주문 목록 + 상세 UI — Phase 2 PR 3 (orderList)
 *
 * 책임:
 *   - GET /api/orders 호출 (목록)
 *   - GET /api/orders/:id 호출 (상세 + lines + stats)
 *   - 목록 컬럼: id / marketplace / external_order_id / order_status / import_source / imported_by / created_at
 *   - 상세 패널: order info + stats + lines table + 자동 예외 콘솔 안내
 *
 * 외부 노출:
 *   window.pmcOrderList = { init, refresh, openDetail }
 *     - init():            화면 첫 진입 시 (또는 메뉴 재진입 시)
 *     - refresh():         orderImport 가 import 성공 후 호출
 *     - openDetail(id):    orderImport 의 409 응답에서 기존 주문 열기, 또는 import 후 신규 주문 자동 선택
 *
 * 정책:
 *   - DB target = wms_orders / wms_order_lines (backend 가 보장)
 *   - 기존 public.orders 일체 미참조
 *   - line stats 는 GET /:id 응답의 stats 또는 lines 배열로 계산 (목록 응답에는 없음 — 결정 4-b)
 *   - failed line 이 있으면 ⚠️ 자동 예외 콘솔 링크만 제공 (team_tasks 직접 조회 안 함 — backend 무수정 룰)
 *   - secret/token 원본 강조 표시 금지 — raw_payload 는 펼침으로만, 응답 그대로
 */
(function () {
  let user = null;
  let cache = [];
  let openOrderId = null;
  let openOrderDetail = null;

  // ── helpers ─────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(iso)  { return iso ? new Date(iso).toLocaleString('ko-KR') : '-'; }
  function fmtMoney(v, currency) {
    if (v == null || v === '') return '-';
    return Number(v).toLocaleString() + (currency ? ' ' + currency : '');
  }

  const STATUS_COLORS = {
    pending:        { bg: '#37474f', fg: '#90a4ae' },
    paid:           { bg: '#1a3a4a', fg: '#64b5f6' },
    ready_to_ship:  { bg: '#5d3a00', fg: '#ffb74d' },
    shipped:        { bg: '#1b5e20', fg: '#69f0ae' },
    cancelled:      { bg: '#4a1a1a', fg: '#ef9a9a' },
    refunded:       { bg: '#2a2a2a', fg: '#9e9e9e' },
  };

  const MATCH_BADGE = {
    matched_link:            { fg: '#69f0ae', label: 'matched_link',            confidence: 'high' },
    matched_marketplace_sku: { fg: '#64b5f6', label: 'matched_marketplace_sku', confidence: 'medium' },
    matched_internal_sku:    { fg: '#64b5f6', label: 'matched_internal_sku',    confidence: 'medium' },
    pending:                 { fg: '#90a4ae', label: 'pending',                 confidence: '' },
    failed:                  { fg: '#ef9a9a', label: 'FAILED',                  confidence: '' },
  };

  // ── entry ────────────────────────────────────────────────
  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;
    const root = document.getElementById('wms-list-section');
    if (!root) return;
    if (!user || !user.isAdmin) {
      root.innerHTML = '<div style="padding:20px;color:#888;">관리자 전용 영역입니다.</div>';
      return;
    }
    if (root.dataset.initialized !== '1') {
      root.dataset.initialized = '1';
      renderShell(root);
    }
    await refresh();
  }

  function renderShell(root) {
    root.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:16px;align-items:start;">
        <!-- 좌측: 목록 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
            <strong style="color:#fff;font-size:14px;">📋 주문 목록</strong>
            <button id="ol-refresh" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">새로고침</button>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <select id="ol-marketplace" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
              <option value="">전체 마켓</option>
              <option value="ebay">ebay</option>
              <option value="shopify">shopify</option>
              <option value="naver">naver</option>
              <option value="shopee">shopee</option>
              <option value="alibaba">alibaba</option>
              <option value="coupang">coupang</option>
              <option value="qoo10">qoo10</option>
            </select>
            <select id="ol-status" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
              <option value="">전체 상태</option>
              <option value="pending">pending</option>
              <option value="paid">paid</option>
              <option value="ready_to_ship">ready_to_ship</option>
              <option value="shipped">shipped</option>
              <option value="cancelled">cancelled</option>
              <option value="refunded">refunded</option>
            </select>
          </div>
          <div id="ol-list"></div>
        </div>

        <!-- 우측: 상세 -->
        <div id="ol-detail" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;color:#888;">
          <div style="text-align:center;padding:40px 0;">왼쪽에서 주문을 선택하세요.</div>
        </div>
      </div>
    `;

    document.getElementById('ol-refresh').addEventListener('click', refresh);
    document.getElementById('ol-marketplace').addEventListener('change', refresh);
    document.getElementById('ol-status').addEventListener('change', refresh);
  }

  // ── list ─────────────────────────────────────────────────
  async function refresh() {
    const root = document.getElementById('wms-list-section');
    if (!root || root.dataset.initialized !== '1') return;

    const marketplace = document.getElementById('ol-marketplace')?.value || '';
    const status      = document.getElementById('ol-status')?.value || '';
    const params = new URLSearchParams({ limit: '100' });
    if (marketplace) params.set('marketplace', marketplace);
    if (status) params.set('status', status);

    try {
      const res = await fetch('/api/orders?' + params.toString(), { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      cache = json.data || [];
      renderList();
      if (openOrderId) {
        const stillExists = cache.find(o => o.id === openOrderId);
        if (stillExists) await openDetail(openOrderId);
        else { openOrderId = null; openOrderDetail = null; renderDetailEmpty(); }
      }
    } catch (e) {
      const el = document.getElementById('ol-list');
      if (el) el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderList() {
    const el = document.getElementById('ol-list');
    if (!el) return;
    if (cache.length === 0) {
      el.innerHTML = '<div style="padding:20px;color:#888;font-size:13px;">주문이 없습니다. 위의 "Import 실행" 으로 첫 주문 생성.</div>';
      return;
    }
    el.innerHTML = cache.map(o => {
      const sc = STATUS_COLORS[o.order_status] || STATUS_COLORS.pending;
      const isActive = o.id === openOrderId;
      const importBadge = o.import_source === 'mock'
        ? '<span style="background:#5d3a00;color:#ffb74d;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;">MOCK</span>'
        : `<span style="background:#37474f;color:#aaa;padding:1px 6px;border-radius:3px;font-size:10px;">${esc(o.import_source)}</span>`;
      return `
        <div class="ol-row" data-id="${o.id}" style="
          padding:10px 12px;border:1px solid ${isActive ? '#81d4fa' : '#2a2a4a'};
          border-radius:8px;margin-bottom:8px;cursor:pointer;
          background:${isActive ? '#0a1a2e' : '#0f0f23'};
        ">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
            ${importBadge}
            <span style="background:#1a3a4a;color:#64b5f6;padding:2px 6px;border-radius:3px;font-size:10px;font-family:monospace;">${esc(o.marketplace)}</span>
            <span style="background:${sc.bg};color:${sc.fg};padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;">${esc(o.order_status)}</span>
            <span style="margin-left:auto;color:#666;font-size:11px;">#${o.id}</span>
          </div>
          <div style="color:#fff;font-size:13px;margin-bottom:4px;font-family:monospace;">${esc(o.external_order_id)}</div>
          <div style="color:#666;font-size:11px;">
            ${o.imported_by != null ? `by user#${o.imported_by} · ` : ''}
            ${fmtDate(o.created_at)}
          </div>
        </div>
      `;
    }).join('');
    el.querySelectorAll('.ol-row').forEach(div => {
      div.addEventListener('click', async () => {
        const id = parseInt(div.dataset.id, 10);
        await openDetail(id);
      });
    });
  }

  // ── detail (외부에서 호출 가능) ─────────────────────────
  async function openDetail(id) {
    if (!Number.isFinite(id)) return;
    openOrderId = id;
    renderList();  // 좌측 active 표시 갱신

    const el = document.getElementById('ol-detail');
    if (!el) return;
    el.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">로딩 중...</div>';
    try {
      const res = await fetch('/api/orders/' + id, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      openOrderDetail = json.data;
      renderDetail();
    } catch (e) {
      el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">상세 로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderDetailEmpty() {
    const el = document.getElementById('ol-detail');
    if (el) el.innerHTML = '<div style="text-align:center;padding:40px 0;color:#888;">왼쪽에서 주문을 선택하세요.</div>';
  }

  function renderDetail() {
    const o = openOrderDetail;
    if (!o) return renderDetailEmpty();
    const el = document.getElementById('ol-detail');
    if (!el) return;
    const sc = STATUS_COLORS[o.order_status] || STATUS_COLORS.pending;
    const lines = o.lines || [];

    // stats — 백엔드 응답의 stats 우선 사용. 없으면 lines 배열로 계산 (방어).
    const stats = o.stats || {
      line_count:    lines.length,
      matched_count: lines.filter(l => l.match_status && l.match_status.startsWith('matched_')).length,
      failed_count:  lines.filter(l => l.match_status === 'failed').length,
      pending_count: lines.filter(l => l.match_status === 'pending').length,
    };

    const failedNotice = stats.failed_count > 0
      ? `<div style="margin-bottom:12px;padding:10px;background:#4a1a1a;border-radius:6px;color:#ffcdd2;font-size:12px;">
           ⚠️ 매칭 실패 line ${stats.failed_count}건. 자동 예외 카드가 생성됐는지
           <a href="/?page=exception-tasks" style="color:#fff;text-decoration:underline;font-weight:600;">⚠️ 자동 예외 콘솔</a>
           에서 확인하세요.
         </div>`
      : '';

    const linesHtml = lines.map(l => {
      const mb = MATCH_BADGE[l.match_status] || MATCH_BADGE.pending;
      return `
        <tr style="border-top:1px solid #2a2a4a;">
          <td style="padding:6px;font-family:monospace;color:#aaa;font-size:11px;">${esc(l.external_line_id)}</td>
          <td style="padding:6px;font-family:monospace;color:#aaa;font-size:11px;">${esc(l.marketplace_sku || '-')}</td>
          <td style="padding:6px;font-family:monospace;color:#aaa;font-size:11px;">${esc(l.listing_id || '-')}</td>
          <td style="padding:6px;font-family:monospace;color:#aaa;font-size:11px;">${esc(l.option_id || '-')}</td>
          <td style="padding:6px;color:#fff;font-size:12px;">${esc(l.title || '-')}</td>
          <td style="padding:6px;text-align:right;color:#fff;font-size:12px;">${l.quantity}</td>
          <td style="padding:6px;">
            <span style="color:${mb.fg};font-size:11px;font-weight:600;">${esc(mb.label)}</span>
            ${l.match_confidence ? `<div style="color:#666;font-size:10px;margin-top:2px;">${esc(l.match_confidence)}</div>` : ''}
            ${l.match_reason ? `<div style="color:#666;font-size:10px;font-family:monospace;">${esc(l.match_reason)}</div>` : ''}
          </td>
          <td style="padding:6px;text-align:right;color:#aaa;font-size:11px;">${l.matched_sku_id != null ? '#' + l.matched_sku_id : '-'}</td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px;">
        <div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
            <span style="background:#1a3a4a;color:#64b5f6;padding:3px 8px;border-radius:3px;font-size:11px;font-family:monospace;">${esc(o.marketplace)}</span>
            <span style="background:${sc.bg};color:${sc.fg};padding:3px 8px;border-radius:3px;font-size:11px;font-weight:600;">${esc(o.order_status)}</span>
            ${o.import_source === 'mock' ? '<span style="background:#5d3a00;color:#ffb74d;padding:3px 8px;border-radius:3px;font-size:11px;font-weight:600;">MOCK</span>' : ''}
          </div>
          <h2 style="color:#fff;font-size:16px;margin:0;font-family:monospace;">${esc(o.external_order_id)}</h2>
          <div style="color:#666;font-size:11px;margin-top:4px;">
            order #${o.id} ·
            ${o.buyer_country ? `country: ${esc(o.buyer_country)} · ` : ''}
            ${o.imported_by != null ? `imported_by user#${o.imported_by} · ` : ''}
            created ${fmtDate(o.created_at)}
          </div>
        </div>
      </div>

      <!-- stats (백엔드 응답 그대로) -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;">
        ${statBox('총 line', stats.line_count, '#fff')}
        ${statBox('matched', stats.matched_count, '#69f0ae')}
        ${statBox('failed', stats.failed_count, '#ef9a9a')}
        ${statBox('pending', stats.pending_count, '#90a4ae')}
      </div>

      ${failedNotice}

      <!-- order info -->
      <div style="margin-bottom:14px;font-size:12px;color:#aaa;">
        ${o.total_amount != null ? `total: <span style="color:#fff;">${fmtMoney(o.total_amount, o.currency)}</span> · ` : ''}
        ${o.ordered_at ? `ordered_at: <span style="color:#fff;">${fmtDate(o.ordered_at)}</span>` : ''}
      </div>

      <!-- lines table -->
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#0f0f23;color:#aaa;">
              <th style="padding:8px;text-align:left;">external_line_id</th>
              <th style="padding:8px;text-align:left;">marketplace_sku</th>
              <th style="padding:8px;text-align:left;">listing_id</th>
              <th style="padding:8px;text-align:left;">option_id</th>
              <th style="padding:8px;text-align:left;">title</th>
              <th style="padding:8px;text-align:right;">qty</th>
              <th style="padding:8px;">match</th>
              <th style="padding:8px;text-align:right;">sku_id</th>
            </tr>
          </thead>
          <tbody>${linesHtml || `<tr><td colspan="8" style="padding:20px;text-align:center;color:#888;">line 없음</td></tr>`}</tbody>
        </table>
      </div>

      <!-- raw_payload / buyer_contact (펼침. 응답 그대로 표시 — 강조 X) -->
      ${(o.raw_payload || o.buyer_contact) ? `
        <details style="margin-top:14px;">
          <summary style="color:#aaa;font-size:11px;cursor:pointer;">▸ raw_payload / buyer_contact (redact 통과 후 저장값)</summary>
          ${o.buyer_contact ? `
            <div style="margin-top:6px;color:#aaa;font-size:11px;">buyer_contact:</div>
            <pre style="background:#0f0f23;color:#cfd8dc;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;max-height:160px;margin:4px 0;">${esc(JSON.stringify(o.buyer_contact, null, 2))}</pre>
          ` : ''}
          ${o.raw_payload ? `
            <div style="margin-top:6px;color:#aaa;font-size:11px;">raw_payload:</div>
            <pre style="background:#0f0f23;color:#cfd8dc;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;max-height:200px;margin:4px 0;">${esc(JSON.stringify(o.raw_payload, null, 2))}</pre>
          ` : ''}
        </details>
      ` : ''}
    `;
  }

  function statBox(label, value, color) {
    return `
      <div style="background:#0f0f23;padding:10px;border-radius:6px;text-align:center;">
        <div style="color:#666;font-size:10px;margin-bottom:2px;">${esc(label)}</div>
        <div style="color:${color};font-size:18px;font-weight:600;">${value}</div>
      </div>
    `;
  }

  window.pmcOrderList = { init, refresh, openDetail };
})();
