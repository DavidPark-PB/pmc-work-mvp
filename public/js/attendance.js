/**
 * 출퇴근 (Phase 3)
 */
(function() {
  let user = null;
  let staffList = [];

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
  function money(n) { if (n == null) return '-'; return Number(n).toLocaleString('ko-KR') + '원'; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    if (user.isAdmin) {
      const res = await fetch('/api/users/staff');
      if (res.ok) staffList = (await res.json()).data || [];
    }
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-attendance');
    const staffOptions = (staffList || []).map(s => `<option value="${s.id}" data-rate="${s.hourly_rate || 0}">${esc(s.display_name)}${s.platform ? ' · ' + esc(s.platform) : ''}</option>`).join('');

    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">⏰ 출퇴근 기록</h1>
        <p style="color:#888;font-size:13px;">${user.isAdmin ? '전체 직원 출퇴근 현황 · 본인 기록도 입력 가능' : esc(user.displayName) + '님의 출퇴근 기록'}</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">✏️ 오늘 출퇴근 입력</h3>
        <form id="att-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:10px;">
            <input type="date" id="att-date" required style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="time" id="att-in" placeholder="출근" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="time" id="att-out" placeholder="퇴근" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <input type="text" id="att-note" placeholder="메모 (휴무, 조퇴 등)" maxlength="500" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;">
          <div style="display:flex;gap:8px;">
            <button type="button" onclick="pmcAttendance.fillNow('att-in')" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">▶ 출근 지금</button>
            <button type="button" onclick="pmcAttendance.fillNow('att-out')" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">■ 퇴근 지금</button>
            <button type="submit" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">✓ 기록</button>
          </div>
        </form>
      </div>

      ${user.isAdmin ? `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">👤 직원별 조회 + 시급 관리</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
          <select id="filter-emp" onchange="pmcAttendance.onEmpChange()" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="">전체</option>
            ${staffOptions}
          </select>
          <input type="month" id="filter-month" value="${currentMonth()}" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          <div id="rate-editor" style="display:none;display:flex;gap:6px;">
            <input type="number" id="rate-input" placeholder="시급(원)" min="0" step="100" style="flex:1;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <button type="button" onclick="pmcAttendance.saveRate()" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">💰 시급 저장</button>
          </div>
        </div>
      </div>` : `
      <div style="margin-bottom:16px;">
        <input type="month" id="filter-month" value="${currentMonth()}" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
      </div>`}

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;">
          <div><div style="font-size:11px;color:#888;">근무일수</div><div id="sum-days" style="font-size:18px;font-weight:700;color:#fff;">-</div></div>
          <div><div style="font-size:11px;color:#888;">총 근무시간</div><div id="sum-hours" style="font-size:18px;font-weight:700;color:#fff;">-</div></div>
          <div><div style="font-size:11px;color:#888;">기본급</div><div id="sum-base" style="font-size:18px;font-weight:700;color:#b39ddb;">-</div></div>
          <div><div style="font-size:11px;color:#888;">보너스</div><div id="sum-bonus" style="font-size:18px;font-weight:700;color:#81c784;">-</div></div>
          <div><div style="font-size:11px;color:#888;">총 지급액</div><div id="sum-total" style="font-size:18px;font-weight:700;color:#fff;">-</div></div>
        </div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:13px;">
          <thead>
            <tr style="background:#0f0f23;">
              ${user.isAdmin ? '<th style="padding:10px;text-align:left;">직원</th>' : ''}
              <th style="padding:10px;text-align:left;">날짜</th>
              <th style="padding:10px;">출근</th>
              <th style="padding:10px;">퇴근</th>
              <th style="padding:10px;">근무</th>
              <th style="padding:10px;text-align:right;">일급</th>
              <th style="padding:10px;text-align:left;">메모</th>
              ${user.isAdmin ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody id="att-tbody"></tbody>
        </table>
      </div>
    `;

    document.getElementById('att-date').value = todayStr();
    document.getElementById('att-form').addEventListener('submit', submitAtt);
    document.getElementById('filter-month').addEventListener('change', refresh);
  }

  async function refresh() {
    const month = document.getElementById('filter-month').value;
    const empId = user.isAdmin ? document.getElementById('filter-emp')?.value : user.id;
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (empId) params.set('employeeId', empId);

    const res = await fetch('/api/attendance?' + params);
    const { data } = await res.json();
    renderRows(data);

    if (empId && month) await loadSummary(empId, month);
    else clearSummary();
  }

  function renderRows(items) {
    const tbody = document.getElementById('att-tbody');
    if (!items || items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${user.isAdmin ? 8 : 6}" style="padding:30px;text-align:center;color:#888;">기록이 없습니다.</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(r => `
      <tr style="border-bottom:1px solid #2a2a4a;">
        ${user.isAdmin ? `<td style="padding:10px;">${esc(r.employee?.display_name || '-')}</td>` : ''}
        <td style="padding:10px;"><code>${r.date}</code></td>
        <td style="padding:10px;text-align:center;">${r.clock_in || '-'}</td>
        <td style="padding:10px;text-align:center;">${r.clock_out || '-'}</td>
        <td style="padding:10px;text-align:center;">${r.work_hours ? Number(r.work_hours).toFixed(2) + 'h' : '-'}</td>
        <td style="padding:10px;text-align:right;">${money(r.daily_pay)}</td>
        <td style="padding:10px;color:#aaa;font-size:12px;">${esc(r.note || '')}</td>
        ${user.isAdmin ? `<td style="padding:10px;text-align:center;"><button onclick="pmcAttendance.del(${r.id})" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button></td>` : ''}
      </tr>
    `).join('');
  }

  async function loadSummary(empId, month) {
    const res = await fetch(`/api/payroll/${empId}?month=${month}`);
    if (!res.ok) { clearSummary(); return; }
    const s = await res.json();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('sum-days', s.workDays);
    set('sum-hours', (s.totalHours || 0).toFixed(2) + 'h');
    set('sum-base', money(s.basePay));
    set('sum-bonus', s.shopeeBonus ? money(s.shopeeBonus.bonusAmount) : '-');
    set('sum-total', money(s.totalPay));
  }

  function clearSummary() {
    ['sum-days','sum-hours','sum-base','sum-bonus','sum-total'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '-';
    });
  }

  function fillNow(id) {
    const d = new Date();
    document.getElementById(id).value = pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  async function submitAtt(e) {
    e.preventDefault();
    const payload = {
      date: document.getElementById('att-date').value,
      clockIn: document.getElementById('att-in').value || undefined,
      clockOut: document.getElementById('att-out').value || undefined,
      note: document.getElementById('att-note').value.trim() || undefined,
    };
    const res = await fetch('/api/attendance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '저장 실패'); return; }
    document.getElementById('att-form').reset();
    document.getElementById('att-date').value = todayStr();
    refresh();
  }

  async function del(id) {
    if (!confirm('삭제하시겠습니까?')) return;
    const res = await fetch('/api/attendance/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('삭제 실패'); return; }
    refresh();
  }

  function onEmpChange() {
    const sel = document.getElementById('filter-emp');
    const editor = document.getElementById('rate-editor');
    if (sel.value) {
      const opt = sel.options[sel.selectedIndex];
      document.getElementById('rate-input').value = opt.dataset.rate || '0';
      editor.style.display = 'flex';
    } else {
      editor.style.display = 'none';
    }
    refresh();
  }

  async function saveRate() {
    const sel = document.getElementById('filter-emp');
    const empId = sel.value;
    if (!empId) return;
    const rate = Number(document.getElementById('rate-input').value);
    if (!confirm(`${sel.options[sel.selectedIndex].text} 시급을 ${rate.toLocaleString()}원으로 설정할까요?\n※ 이미 기록된 일급은 재계산되지 않습니다 (스냅샷 보존).`)) return;
    const res = await fetch(`/api/payroll/${empId}/rate`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hourlyRate: rate }),
    });
    if (!res.ok) { alert('저장 실패'); return; }
    sel.options[sel.selectedIndex].dataset.rate = rate;
    alert('시급이 저장되었습니다.');
  }

  window.pmcAttendance = { load, refresh, fillNow, del, onEmpChange, saveRate };
})();
