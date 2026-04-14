/**
 * 직원관리 (Phase 2) — admin 전용
 * 계정 생성, 정보 수정, 비번 초기화, 활성/비활성
 */
(function() {
  let user = null;

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dt(iso) { if (!iso) return '-'; return new Date(iso).toLocaleDateString('ko-KR'); }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user || !user.isAdmin) {
      document.getElementById('page-staff-admin').innerHTML = '<div style="padding:40px;color:#888;">관리자 전용 페이지입니다.</div>';
      return;
    }
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-staff-admin');
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">👥 직원 관리</h1>
        <p style="color:#888;font-size:13px;">직원 계정 생성, 비밀번호 초기화, 활성/비활성 관리</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">➕ 새 직원 추가</h3>
        <form id="user-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:10px;">
            <input type="text" id="u-username" placeholder="아이디 (영문/숫자)" required minlength="2" maxlength="50" autocomplete="off" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="text" id="u-displayName" placeholder="이름" required maxlength="100" autocomplete="off" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="password" id="u-password" placeholder="초기 비밀번호 (6자+)" required minlength="6" autocomplete="new-password" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="u-role" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="staff">직원 (Staff)</option>
              <option value="admin">관리자 (Admin)</option>
            </select>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:10px;">
            <input type="text" id="u-platform" placeholder="담당 (예: shopee)" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="number" id="u-hourlyRate" placeholder="시급 (원)" min="0" step="100" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="time" id="u-defaultDue" placeholder="기본 마감" title="기본 마감 시간 (예: 12:30)" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="u-workType" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="">근무형태</option>
              <option value="fulltime">풀타임</option>
              <option value="parttime">파트타임</option>
              <option value="hourly">시간제</option>
            </select>
          </div>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">계정 생성</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:13px;">
          <thead>
            <tr style="background:#0f0f23;">
              <th style="padding:10px;text-align:left;">아이디</th>
              <th style="padding:10px;text-align:left;">이름</th>
              <th style="padding:10px;text-align:center;">권한</th>
              <th style="padding:10px;text-align:center;">상태</th>
              <th style="padding:10px;text-align:left;">담당</th>
              <th style="padding:10px;text-align:right;">시급</th>
              <th style="padding:10px;text-align:center;">마지막 로그인</th>
              <th style="padding:10px;text-align:center;">관리</th>
            </tr>
          </thead>
          <tbody id="user-tbody"></tbody>
        </table>
      </div>
    `;
    document.getElementById('user-form').addEventListener('submit', submitCreate);
  }

  async function refresh() {
    const res = await fetch('/api/users/all');
    const { data } = await res.json();
    const tbody = document.getElementById('user-tbody');
    if (!data || data.length === 0) { tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;text-align:center;color:#888;">직원이 없습니다.</td></tr>'; return; }

    tbody.innerHTML = data.map(u => `
      <tr style="border-bottom:1px solid #2a2a4a;${u.is_active ? '' : 'opacity:0.5;'}">
        <td style="padding:10px;"><code style="color:#81d4fa;">${esc(u.username)}</code></td>
        <td style="padding:10px;"><strong>${esc(u.display_name)}</strong></td>
        <td style="padding:10px;text-align:center;">${u.role === 'admin' ? '<span style="padding:2px 8px;background:#7c4dff;color:#fff;border-radius:8px;font-size:11px;">Admin</span>' : '<span style="padding:2px 8px;background:#0288d1;color:#fff;border-radius:8px;font-size:11px;">Staff</span>'}</td>
        <td style="padding:10px;text-align:center;">${u.is_active ? '<span style="color:#81c784;">● 활성</span>' : '<span style="color:#888;">○ 비활성</span>'}</td>
        <td style="padding:10px;color:#aaa;font-size:12px;">${esc(u.platform || '-')}</td>
        <td style="padding:10px;text-align:right;font-family:monospace;">${u.hourly_rate ? Number(u.hourly_rate).toLocaleString() + '원' : '-'}</td>
        <td style="padding:10px;text-align:center;font-size:11px;color:#888;">${dt(u.last_login_at)}</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">
          <button onclick="pmcStaffAdmin.resetPw(${u.id}, '${esc(u.display_name)}')" style="padding:4px 10px;background:#ffa726;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;margin-right:4px;">비번 초기화</button>
          <button onclick="pmcStaffAdmin.toggleActive(${u.id}, ${u.is_active})" style="padding:4px 10px;background:${u.is_active ? '#e94560' : '#4caf50'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">${u.is_active ? '비활성' : '활성'}</button>
        </td>
      </tr>
    `).join('');
  }

  async function submitCreate(e) {
    e.preventDefault();
    const payload = {
      username: document.getElementById('u-username').value.trim(),
      displayName: document.getElementById('u-displayName').value.trim(),
      password: document.getElementById('u-password').value,
      role: document.getElementById('u-role').value,
      platform: document.getElementById('u-platform').value.trim() || undefined,
      hourlyRate: document.getElementById('u-hourlyRate').value || undefined,
      defaultDueTime: document.getElementById('u-defaultDue').value || undefined,
      workType: document.getElementById('u-workType').value || undefined,
    };
    const res = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '생성 실패'); return; }
    document.getElementById('user-form').reset();
    alert('계정이 생성되었습니다.\n직원에게 초기 비밀번호를 전달하고 첫 로그인 시 변경하도록 안내하세요.');
    refresh();
  }

  async function resetPw(userId, name) {
    if (!confirm(`${name}의 비밀번호를 초기화하시겠습니까?\n\n임시 비밀번호가 발급됩니다.`)) return;
    const res = await fetch(`/api/admin/reset-password/${userId}`, { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '실패'); return; }
    prompt(`임시 비밀번호 (${name}):\n\n이 비밀번호를 직원에게 전달하세요. 첫 로그인 후 반드시 변경하도록 안내하세요.`, data.tempPassword);
  }

  async function toggleActive(userId, currentActive) {
    const nextActive = !currentActive;
    if (!confirm(`계정을 ${nextActive ? '활성화' : '비활성화'}하시겠습니까?`)) return;
    const res = await fetch(`/api/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: nextActive }),
    });
    if (!res.ok) { alert('실패'); return; }
    refresh();
  }

  window.pmcStaffAdmin = { load, refresh, resetPw, toggleActive };
})();
