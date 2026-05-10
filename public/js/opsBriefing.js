/**
 * Daily Operations Briefing UI — PR O1
 *
 * 책임:
 *   - GET /api/ops-briefing/today 호출 (read-only)
 *   - 4 섹션 카드 (orders / tasks / purchase_requests / safety) + recommendations + quick links
 *
 * 권한: 로그인된 모든 사용자 (정책 §1-A)
 *
 * 정책:
 *   - read-only. fetch POST 0건.
 *   - 각 섹션 query 가 service 단에서 실패하면 null — UI 가 "데이터 없음" 표시
 *   - 외부 API (eBay/텔레그램) 호출 0건
 */
(function () {
  let user = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;
    const root = document.getElementById('ops-briefing-section');
    if (!root) return;
    if (!user || !user.id) {
      root.innerHTML = '<div style="padding:20px;color:#888;">로그인이 필요합니다.</div>';
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
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">📅 오늘 운영 브리핑</h1>
        <p style="color:#888;font-size:13px;margin:0;">
          오늘 처리해야 할 주문 / 업무 / 발주 / 자동화 상황을 한눈에 확인하세요.
        </p>
      </div>
      <div style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div id="ob-date" style="color:#aaa;font-size:13px;"></div>
        <button id="ob-refresh" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">새로고침</button>
      </div>

      <div id="ob-summary" style="margin-bottom:14px;"></div>
      <div id="ob-recommendations" style="margin-bottom:14px;"></div>
      <div id="ob-quicklinks" style="margin-bottom:14px;"></div>
    `;
    document.getElementById('ob-refresh').addEventListener('click', refresh);
  }

  async function refresh() {
    const root = document.getElementById('ops-briefing-section');
    if (!root || root.dataset.initialized !== '1') return;

    const summaryEl = document.getElementById('ob-summary');
    summaryEl.innerHTML = '<div style="padding:20px;color:#aaa;text-align:center;">로딩 중...</div>';

    try {
      const res = await fetch('/api/ops-briefing/today', { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      render(json);
    } catch (e) {
      summaryEl.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function render(b) {
    document.getElementById('ob-date').textContent = `📆 ${b.date || '-'} 기준`;

    const sectionCard = (title, color, items) => {
      const rows = items.map(([label, value, valueColor]) => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1f1f3a;">
          <span style="color:#aaa;font-size:12px;">${esc(label)}</span>
          <strong style="color:${valueColor || '#fff'};font-size:14px;">${value == null ? '-' : value}</strong>
        </div>
      `).join('');
      return `
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <div style="color:${color};font-size:14px;font-weight:600;margin-bottom:10px;">${esc(title)}</div>
          ${rows}
        </div>
      `;
    };

    const sumHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;">
        ${sectionCard('📦 주문 (WMS)', '#64b5f6', [
          ['오늘 신규 주문', b.orders?.total_today ?? null],
          ['미처리 (pending)', b.orders?.pending ?? null, b.orders?.pending > 0 ? '#ffb74d' : '#fff'],
          ['자동 예외 (전체)', b.orders?.exception_count ?? null, b.orders?.exception_count > 0 ? '#ef9a9a' : '#fff'],
          ['SKU 매칭 실패', b.orders?.sku_match_failed ?? null, b.orders?.sku_match_failed > 0 ? '#ef9a9a' : '#fff'],
        ])}
        ${sectionCard('📋 업무 (사람 카드)', '#69f0ae', [
          ['진행 중 (open)', b.tasks?.open ?? null],
          ['긴급', b.tasks?.urgent ?? null, b.tasks?.urgent > 0 ? '#ef9a9a' : '#fff'],
          ['마감 지남', b.tasks?.overdue ?? null, b.tasks?.overdue > 0 ? '#ef9a9a' : '#fff'],
          ['오늘 완료', b.tasks?.completed_today ?? null, '#69f0ae'],
        ])}
        ${sectionCard('💰 발주', '#ffb74d', [
          ['승인 대기', b.purchase_requests?.pending ?? null, b.purchase_requests?.pending > 0 ? '#ffb74d' : '#fff'],
          ['오늘 승인', b.purchase_requests?.approved_today ?? null, '#69f0ae'],
          ['오늘 주문 완료', b.purchase_requests?.ordered_today ?? null, '#64b5f6'],
        ])}
        ${sectionCard('↺ 자동화 (Safety)', '#ce93d8', [
          ['오늘 자동화 실패', b.safety?.failed_runs_today ?? null, b.safety?.failed_runs_today > 0 ? '#ef9a9a' : '#fff'],
          ['되돌리기 가능 (auto)', b.safety?.rollbackable_runs ?? null, '#69f0ae'],
          ['오늘 되돌림 완료', b.safety?.rolled_back_today ?? null, '#64b5f6'],
        ])}
      </div>
    `;
    document.getElementById('ob-summary').innerHTML = sumHtml;

    const recs = Array.isArray(b.recommendations) ? b.recommendations : [];
    const recsHtml = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
        <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:10px;">💡 추천 행동</div>
        ${recs.length === 0
          ? '<div style="color:#888;font-size:12px;">추천 항목 없음</div>'
          : recs.map(r => `<div style="color:#cfd8dc;font-size:13px;padding:4px 0;line-height:1.5;">• ${esc(r)}</div>`).join('')}
      </div>
    `;
    document.getElementById('ob-recommendations').innerHTML = recsHtml;

    // quick links — dashboard.js 의 navigateTo 활용 (없으면 location.href)
    const quickHtml = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button data-page="tasks"        type="button" class="ob-quick" style="padding:8px 14px;background:#1565c0;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">📋 업무 보기</button>
        <button data-page="wms-orders"   type="button" class="ob-quick" style="padding:8px 14px;background:#1565c0;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">📦 WMS 주문 보기</button>
        <button data-page="orders"       type="button" class="ob-quick" style="padding:8px 14px;background:#5d3a00;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">💰 발주 보기</button>
        <button data-page="safety-runs"  type="button" class="ob-quick" style="padding:8px 14px;background:#37474f;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">📜 실행 로그 보기</button>
        <button data-page="exception-tasks" type="button" class="ob-quick" style="padding:8px 14px;background:#4a1a1a;border:none;border-radius:6px;color:#ffcdd2;cursor:pointer;font-size:13px;">⚠️ 자동 예외 콘솔</button>
      </div>
    `;
    document.getElementById('ob-quicklinks').innerHTML = quickHtml;
    document.querySelectorAll('.ob-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        if (typeof showPage === 'function') showPage(page);
        else location.href = '/?page=' + encodeURIComponent(page);
      });
    });
  }

  window.pmcOpsBriefing = { init, refresh };
})();
