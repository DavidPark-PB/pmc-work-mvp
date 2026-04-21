/**
 * 출퇴근 (Phase 3)
 */
(function() {
  let user = null;
  let staffList = [];
  let cachedItems = []; // 최근 refresh 결과 (edit 모드 전환용)
  let editingId = null; // 수정 중인 기록 id (null이면 신규 입력)

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

      <div id="att-quick-card" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:12px;">
        <div style="color:#888;font-size:12px;">로딩…</div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">✏️ 수동 입력 / 수정</h3>
        <form id="att-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:10px;">
            <input type="date" id="att-date" required style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="att-status" onchange="pmcAttendance.onStatusChange()" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="regular">✅ 정상</option>
              <option value="late">⏰ 지각</option>
              <option value="early_leave">🏃 조퇴</option>
              <option value="day_off">🌴 휴무</option>
              <option value="absence">❌ 결근</option>
            </select>
            <input type="time" id="att-in" placeholder="출근" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="time" id="att-out" placeholder="퇴근" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <input type="text" id="att-note" placeholder="메모 / 사유" maxlength="500" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:6px;">
          <div id="att-note-hint" style="font-size:11px;color:#888;margin-bottom:10px;display:none;">지각/조퇴/결근은 사유를 반드시 입력해야 합니다.</div>
          <div id="att-edit-banner" style="display:none;padding:8px 12px;background:#1a3a5a;border:1px solid #2a5a8a;border-radius:6px;color:#81d4fa;font-size:12px;margin-bottom:8px;">
            ✏️ <strong id="att-edit-date"></strong> 기록 수정 모드
          </div>
          <div id="att-time-buttons" style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" onclick="pmcAttendance.fillNow('att-in')" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">▶ 출근 지금</button>
            <button type="button" onclick="pmcAttendance.fillNow('att-out')" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">■ 퇴근 지금</button>
            <button type="submit" id="att-submit-btn" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">✓ 기록</button>
            <button type="button" id="att-cancel-btn" onclick="pmcAttendance.cancelEdit()" style="display:none;padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
            <button type="button" onclick="pmcAttendance.togglePayroll()" style="padding:8px 14px;background:#0a3a2a;border:1px solid #1a6a4a;border-radius:6px;color:#81c784;cursor:pointer;font-size:13px;margin-left:auto;">💰 급여 보기</button>
          </div>
          <div id="att-submit-only" style="display:none;gap:8px;flex-wrap:wrap;">
            <button type="submit" id="att-submit-btn-2" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">✓ 기록</button>
            <button type="button" id="att-cancel-btn-2" onclick="pmcAttendance.cancelEdit()" style="display:none;padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
            <button type="button" onclick="pmcAttendance.togglePayroll()" style="padding:8px 14px;background:#0a3a2a;border:1px solid #1a6a4a;border-radius:6px;color:#81c784;cursor:pointer;font-size:13px;margin-left:auto;">💰 급여 보기</button>
          </div>
        </form>
        ${!user.isAdmin ? `
        <div style="margin-top:12px;padding:10px 12px;background:#2a1e00;border:1px solid #4a3600;border-radius:6px;color:#ffb74d;font-size:11px;line-height:1.5;">
          ⚠️ 출퇴근 기록은 <strong>한 번 입력하면 본인이 수정할 수 없습니다</strong>. 출/퇴근을 잘못 찍었거나 빠뜨린 경우 <strong>사장님께 수정 요청</strong>하세요. (입력 후 피드백 게시판으로 요청 권장)
        </div>` : ''}
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

      <div id="payroll-summary" style="display:none;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:14px;margin:0;">💰 급여 합계</h3>
          <button type="button" onclick="pmcAttendance.togglePayroll()" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">닫기</button>
        </div>
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
              <th style="padding:10px;">근태</th>
              <th style="padding:10px;">출근</th>
              <th style="padding:10px;">퇴근</th>
              <th style="padding:10px;">근무</th>
              <th style="padding:10px;text-align:right;">일급</th>
              <th style="padding:10px;text-align:left;">메모 / 사유</th>
              <th style="padding:10px;text-align:center;">관리</th>
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
    cachedItems = data || [];
    renderRows(cachedItems);
    renderQuickCard();

    // 내가 선택한 날짜에 본인 기록이 있으면 자동으로 수정 모드 진입 (편의)
    autoEnterEditIfExists();

    if (empId && month) await loadSummary(empId, month);
    else clearSummary();
  }

  function renderQuickCard() {
    const host = document.getElementById('att-quick-card');
    if (!host) return;
    const today = todayStr();
    // 내 오늘 기록 찾기 — cachedItems는 월 필터에 따라 오늘이 없을 수도 있으니 보수적으로 동작
    const mine = cachedItems.find(r => r.employee_id === user.id && r.date === today);
    const bigBtn = (label, bg, onclick, disabled) => `
      <button type="button" ${disabled ? 'disabled' : ''} onclick="${onclick}" style="padding:16px 24px;background:${disabled ? '#2a2a4a' : bg};border:0;border-radius:10px;color:#fff;cursor:${disabled ? 'default' : 'pointer'};font-weight:700;font-size:17px;min-width:180px;opacity:${disabled ? 0.5 : 1};">${label}</button>`;

    let body;
    if (!mine) {
      body = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="color:#fff;font-size:15px;font-weight:600;">🕐 오늘 (${today})</div>
            <div style="color:#888;font-size:12px;margin-top:3px;">아직 출근 기록이 없습니다. 클릭 한 번으로 현재 시각이 찍힙니다.</div>
          </div>
          ${bigBtn('▶ 지금 출근 찍기', '#4caf50', 'pmcAttendance.clockIn()')}
        </div>`;
    } else if (!mine.clock_out && !['day_off','absence'].includes(mine.status)) {
      body = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="color:#fff;font-size:15px;font-weight:600;">🕐 오늘 (${today}) <span style="color:#81c784;font-weight:400;font-size:12px;">근무 중</span></div>
            <div style="color:#ccc;font-size:13px;margin-top:4px;">출근 <strong style="color:#81c784;">${mine.clock_in || '-'}</strong> · 퇴근 대기</div>
          </div>
          ${bigBtn('■ 지금 퇴근 찍기', '#1565c0', 'pmcAttendance.clockOut()')}
        </div>`;
    } else {
      const hoursText = mine.work_hours ? Number(mine.work_hours).toFixed(2) + 'h' : '-';
      const payText = mine.daily_pay != null ? money(mine.daily_pay) : '-';
      const noTimesBadge = ['day_off','absence'].includes(mine.status) ? ` <span style="color:#aaa;font-size:11px;">(${mine.status === 'day_off' ? '휴무' : '결근'})</span>` : '';
      body = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="color:#fff;font-size:15px;font-weight:600;">🕐 오늘 (${today}) <span style="color:#81c784;font-weight:400;font-size:12px;">✓ 완료${noTimesBadge}</span></div>
            <div style="color:#ccc;font-size:13px;margin-top:4px;">${mine.clock_in ? `${mine.clock_in} ~ ${mine.clock_out || '-'}` : '시각 없음'} · <strong>${hoursText}</strong> · <strong style="color:#b39ddb;">${payText}</strong></div>
          </div>
          <div style="color:#666;font-size:11px;">수정이 필요하면 사장님께 요청하세요.</div>
        </div>`;
    }
    host.innerHTML = body;
  }

  async function clockIn() {
    try {
      const res = await fetch('/api/attendance/clock-in', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      refresh();
    } catch (e) { alert('출근 실패: ' + e.message); }
  }

  async function clockOut() {
    try {
      const res = await fetch('/api/attendance/clock-out', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      refresh();
    } catch (e) { alert('퇴근 실패: ' + e.message); }
  }

  function autoEnterEditIfExists() {
    if (editingId) return; // 이미 편집 중이면 유지
    if (!user.isAdmin) return; // 직원은 수정 불가 — 자동 편집 모드 진입 안 함
    const selDate = document.getElementById('att-date')?.value;
    if (!selDate) return;
    const myRec = cachedItems.find(r => r.employee_id === user.id && r.date === selDate);
    if (myRec) startEdit(myRec);
  }

  function startEdit(rec) {
    editingId = rec.id;
    document.getElementById('att-date').value = rec.date;
    document.getElementById('att-status').value = rec.status || 'regular';
    document.getElementById('att-in').value = rec.clock_in || '';
    document.getElementById('att-out').value = rec.clock_out || '';
    document.getElementById('att-note').value = rec.note || '';
    onStatusChange();
    // banner / button text
    const b = document.getElementById('att-edit-banner');
    if (b) {
      b.style.display = 'block';
      document.getElementById('att-edit-date').textContent = rec.date + (rec.employee?.display_name ? ' (' + rec.employee.display_name + ')' : '');
    }
    ['att-submit-btn', 'att-submit-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '✓ 수정 저장'; });
    ['att-cancel-btn', 'att-cancel-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
    // 화면 상단으로 스크롤
    document.getElementById('att-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    editingId = null;
    document.getElementById('att-form').reset();
    document.getElementById('att-date').value = todayStr();
    document.getElementById('att-status').value = 'regular';
    onStatusChange();
    const b = document.getElementById('att-edit-banner');
    if (b) b.style.display = 'none';
    ['att-submit-btn', 'att-submit-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '✓ 기록'; });
    ['att-cancel-btn', 'att-cancel-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  }

  function renderRows(items) {
    const tbody = document.getElementById('att-tbody');
    const cols = user.isAdmin ? 9 : 8; // staff도 '관리' 컬럼 추가됨
    if (!items || items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${cols}" style="padding:30px;text-align:center;color:#888;">기록이 없습니다.</td></tr>`;
      return;
    }
    const statusBadge = {
      regular: '<span style="padding:2px 6px;background:#4caf50;color:#fff;border-radius:8px;font-size:10px;">정상</span>',
      late: '<span style="padding:2px 6px;background:#ff9800;color:#fff;border-radius:8px;font-size:10px;">지각</span>',
      early_leave: '<span style="padding:2px 6px;background:#ffa726;color:#fff;border-radius:8px;font-size:10px;">조퇴</span>',
      day_off: '<span style="padding:2px 6px;background:#0288d1;color:#fff;border-radius:8px;font-size:10px;">휴무</span>',
      absence: '<span style="padding:2px 6px;background:#e94560;color:#fff;border-radius:8px;font-size:10px;">결근</span>',
    };
    tbody.innerHTML = items.map(r => {
      // 수정은 admin만. 직원은 실수 시 사장님께 요청.
      const canEdit = user.isAdmin;
      return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        ${user.isAdmin ? `<td style="padding:10px;">${esc(r.employee?.display_name || '-')}</td>` : ''}
        <td style="padding:10px;"><code>${r.date}</code></td>
        <td style="padding:10px;text-align:center;">${statusBadge[r.status] || statusBadge.regular}</td>
        <td style="padding:10px;text-align:center;">${r.clock_in || '-'}</td>
        <td style="padding:10px;text-align:center;">${r.clock_out || '-'}</td>
        <td style="padding:10px;text-align:center;">${r.work_hours ? Number(r.work_hours).toFixed(2) + 'h' : '-'}</td>
        <td style="padding:10px;text-align:right;">${money(r.daily_pay)}</td>
        <td style="padding:10px;color:#aaa;font-size:12px;">${esc(r.note || '')}</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">
          ${canEdit ? `<button onclick="pmcAttendance.editRow(${r.id})" title="수정" style="padding:4px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;margin-right:4px;">✏️ 수정</button>` : ''}
          ${user.isAdmin ? `<button onclick="pmcAttendance.del(${r.id})" title="삭제" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>` : ''}
        </td>
      </tr>
    `;}).join('');
  }

  function editRow(id) {
    const rec = cachedItems.find(r => r.id === id);
    if (!rec) { alert('기록을 찾을 수 없습니다'); return; }
    startEdit(rec);
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
    const status = document.getElementById('att-status').value;
    const noTimes = status === 'day_off' || status === 'absence';
    const payload = {
      status,
      clockIn: noTimes ? '' : (document.getElementById('att-in').value || ''),
      clockOut: noTimes ? '' : (document.getElementById('att-out').value || ''),
      note: document.getElementById('att-note').value.trim(),
    };

    let url, method;
    if (editingId) {
      url = '/api/attendance/' + editingId;
      method = 'PATCH';
      // PATCH는 date 변경 안 함
    } else {
      url = '/api/attendance';
      method = 'POST';
      payload.date = document.getElementById('att-date').value;
    }

    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json();
      // 날짜 중복 에러 → 자동 편집 모드 진입 유도
      if (res.status === 409) {
        alert(err.error || '해당 날짜에 이미 기록이 있습니다.\n수정이 필요하면 사장님께 요청하세요.');
      } else {
        alert(err.error || '저장 실패');
      }
      return;
    }
    editingId = null;
    document.getElementById('att-form').reset();
    document.getElementById('att-date').value = todayStr();
    onStatusChange();
    const b = document.getElementById('att-edit-banner');
    if (b) b.style.display = 'none';
    ['att-submit-btn', 'att-submit-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '✓ 기록'; });
    ['att-cancel-btn', 'att-cancel-btn-2'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    refresh();
  }

  function onStatusChange() {
    const st = document.getElementById('att-status').value;
    const noTimes = st === 'day_off' || st === 'absence';
    const reasonRequired = st === 'late' || st === 'early_leave' || st === 'absence';
    const timeIn = document.getElementById('att-in');
    const timeOut = document.getElementById('att-out');
    const noteHint = document.getElementById('att-note-hint');
    const timeButtons = document.getElementById('att-time-buttons');
    const submitOnly = document.getElementById('att-submit-only');
    if (noTimes) {
      timeIn.style.display = 'none';
      timeOut.style.display = 'none';
      timeIn.value = '';
      timeOut.value = '';
      timeButtons.style.display = 'none';
      submitOnly.style.display = 'block';
    } else {
      timeIn.style.display = '';
      timeOut.style.display = '';
      timeButtons.style.display = 'flex';
      submitOnly.style.display = 'none';
    }
    noteHint.style.display = reasonRequired ? 'block' : 'none';
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

  function togglePayroll() {
    const el = document.getElementById('payroll-summary');
    if (!el) return;
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  // time/date/month picker 아이콘이 어두운 배경에서 안 보이는 문제 해결
  // (페이지 로드 시 한 번만 <style> 주입 — 모든 페이지 커버)
  (function ensureDarkPickerStyle() {
    if (document.getElementById('pmc-dark-picker-style')) return;
    const st = document.createElement('style');
    st.id = 'pmc-dark-picker-style';
    st.textContent = `
      input[type="time"]::-webkit-calendar-picker-indicator,
      input[type="date"]::-webkit-calendar-picker-indicator,
      input[type="month"]::-webkit-calendar-picker-indicator,
      input[type="datetime-local"]::-webkit-calendar-picker-indicator {
        filter: invert(0.9) brightness(1.2);
        cursor: pointer;
        opacity: 0.9;
      }
      input[type="time"],
      input[type="date"],
      input[type="month"],
      input[type="datetime-local"] {
        color-scheme: dark;
      }
    `;
    document.head.appendChild(st);
  })();

  window.pmcAttendance = { load, refresh, fillNow, del, onEmpChange, saveRate, onStatusChange, togglePayroll, editRow, cancelEdit, clockIn, clockOut };
})();
