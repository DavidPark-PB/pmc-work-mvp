/**
 * 급여 요약 (Phase 3) — admin 전용
 */
(function() {
  let user = null;

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
  function money(n) { if (n == null) return '-'; return Number(n).toLocaleString('ko-KR') + '원'; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user || !user.isAdmin) {
      document.getElementById('page-payroll').innerHTML = '<div style="padding:40px;color:#888;">관리자 전용 페이지입니다.</div>';
      return;
    }
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-payroll');
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">💰 급여 요약</h1>
        <p style="color:#888;font-size:13px;">직원별 월 급여 집계 · Shopee 보너스 관리</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
        <div>
          <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">월</label>
          <input type="month" id="pay-month" value="${currentMonth()}" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
        </div>
        <div style="flex:1;text-align:right;">
          <div style="font-size:12px;color:#888;">이 달 총 지급액</div>
          <div id="grand-total" style="font-size:24px;font-weight:700;color:#fff;">-</div>
        </div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:13px;">
          <thead>
            <tr style="background:#0f0f23;">
              <th style="padding:10px;text-align:left;">이름</th>
              <th style="padding:10px;text-align:left;">담당</th>
              <th style="padding:10px;text-align:right;">시급</th>
              <th style="padding:10px;text-align:center;">근무일</th>
              <th style="padding:10px;text-align:center;">총시간</th>
              <th style="padding:10px;text-align:right;">기본급</th>
              <th style="padding:10px;text-align:center;">Shopee 매출</th>
              <th style="padding:10px;text-align:right;">보너스</th>
              <th style="padding:10px;text-align:right;">총 지급액</th>
            </tr>
          </thead>
          <tbody id="pay-tbody"></tbody>
        </table>
      </div>
    `;
    document.getElementById('pay-month').addEventListener('change', refresh);
  }

  async function refresh() {
    const month = document.getElementById('pay-month').value;
    if (!month) return;
    const res = await fetch(`/api/payroll/summary?month=${month}`);
    if (!res.ok) { alert((await res.json()).error || '조회 실패'); return; }
    const { summary, grandTotal } = await res.json();

    document.getElementById('grand-total').textContent = money(grandTotal);
    const tbody = document.getElementById('pay-tbody');

    // Shopee 매출 입력 UI는 platform에 'shopee' 포함된 직원만
    const enriched = await Promise.all(summary.map(async s => {
      const isShopee = s.platform && s.platform.includes('shopee');
      let revenue = null;
      if (isShopee) {
        const r = await fetch(`/api/bonuses/${s.id}`);
        if (r.ok) {
          const { data } = await r.json();
          const cur = (data || []).find(b => b.month === month);
          if (cur) revenue = Number(cur.monthly_revenue);
        }
      }
      return { ...s, isShopee, revenue };
    }));

    tbody.innerHTML = enriched.map(s => `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:10px;"><strong>${esc(s.displayName)}</strong></td>
        <td style="padding:10px;color:#aaa;font-size:12px;">${esc(s.platform || '-')}</td>
        <td style="padding:10px;text-align:right;">${money(s.hourlyRate)}</td>
        <td style="padding:10px;text-align:center;">${s.workDays}일</td>
        <td style="padding:10px;text-align:center;">${s.totalHours.toFixed(2)}h</td>
        <td style="padding:10px;text-align:right;">${money(s.basePay)}</td>
        <td style="padding:10px;text-align:center;">
          ${s.isShopee ? `
            <div style="display:flex;gap:4px;align-items:center;justify-content:center;">
              <input type="number" value="${s.revenue || ''}" placeholder="매출액" id="rev-${s.id}" style="width:110px;padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <button onclick="pmcPayroll.saveBonus(${s.id})" style="padding:6px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✓</button>
            </div>
          ` : '<span style="color:#555;">-</span>'}
        </td>
        <td style="padding:10px;text-align:right;color:#81c784;font-weight:600;">${s.shopeeBonus > 0 ? money(s.shopeeBonus) : '-'}</td>
        <td style="padding:10px;text-align:right;font-weight:700;">${money(s.totalPay)}</td>
      </tr>
    `).join('');
  }

  async function saveBonus(employeeId) {
    const month = document.getElementById('pay-month').value;
    const input = document.getElementById('rev-' + employeeId);
    const revenue = Number(input.value);
    if (!Number.isFinite(revenue) || revenue < 0) { alert('매출 금액을 입력하세요.'); return; }
    const res = await fetch('/api/bonuses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, month, monthlyRevenue: revenue }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refresh();
  }

  window.pmcPayroll = { load, refresh, saveBonus };
})();
