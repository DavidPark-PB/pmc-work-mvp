/**
 * 업무관리 페이지 (Phase 1)
 * - 사장: 통계 + 직원별 카드 + 업무 등록 + 전체 목록
 * - 직원: 내 할 일 + 전체 공지 목록
 */
(function() {
  let user = null;
  let staffList = [];
  let refreshTimer = null;

  function html(strings, ...vals) {
    return strings.reduce((acc, s, i) => acc + s + (vals[i] != null ? vals[i] : ''), '');
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
    const pad = n => String(n).padStart(2, '0');
    const timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (sameDay) return '오늘 ' + timeStr;
    if (d.toDateString() === tmr.toDateString()) return '내일 ' + timeStr;
    return pad(d.getMonth()+1) + '/' + pad(d.getDate()) + ' ' + timeStr;
  }
  function isOverdue(iso, status) {
    if (!iso || status === 'done') return false;
    return new Date(iso).getTime() < Date.now();
  }

  async function load() {
    if (!user) user = window.__pmcUser;
    if (!user) { user = (await fetch('/api/auth/me').then(r=>r.json())).user; }
    if (!user) return;

    if (user.isAdmin) {
      const res = await fetch('/api/users/staff').catch(()=>null);
      if (res && res.ok) staffList = (await res.json()).data || [];
    }

    renderShell();
    await refresh();

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.getElementById('page-tasks').classList.contains('active')) refresh();
    }, 30000);
  }

  function renderShell() {
    const el = document.getElementById('page-tasks');
    if (!user.isAdmin) {
      el.innerHTML = html`
        <div class="page-header" style="margin-bottom:16px;">
          <h1 style="font-size:22px;color:#fff;">📋 내 할 일</h1>
          <p style="color:#888;font-size:13px;">${escapeHtml(user.displayName)}님의 업무 목록</p>
        </div>
        <div class="card" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
          <div id="task-list"></div>
        </div>
      `;
      return;
    }

    const staffOptions = staffList.map(s => `<option value="${s.id}" data-duetime="${s.default_due_time || ''}">${escapeHtml(s.display_name)}${s.platform ? ' · ' + escapeHtml(s.platform) : ''}</option>`).join('');

    el.innerHTML = html`
      <div class="page-header" style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">📋 업무 관리</h1>
        <p style="color:#888;font-size:13px;">전체 직원 업무 현황 · 업무 지시 · 본인 할 일</p>
      </div>

      <!-- 오늘 통계 4분할 -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
        <div class="stat-card" style="background:#1a1a2e;border:1px solid #2a2a4a;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">오늘 전체</div>
          <div id="stat-total" style="font-size:24px;font-weight:700;color:#fff;">-</div>
        </div>
        <div class="stat-card" style="background:#1a1a2e;border-left:3px solid #4caf50;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">완료</div>
          <div id="stat-done" style="font-size:24px;font-weight:700;color:#81c784;">-</div>
        </div>
        <div class="stat-card" style="background:#1a1a2e;border-left:3px solid #7c4dff;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">진행중</div>
          <div id="stat-inprogress" style="font-size:24px;font-weight:700;color:#b39ddb;">-</div>
        </div>
        <div class="stat-card" style="background:#1a1a2e;border-left:3px solid #e94560;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">미완료</div>
          <div id="stat-pending" style="font-size:24px;font-weight:700;color:#ff8a80;">-</div>
        </div>
      </div>

      <!-- 업무 등록 -->
      <div class="card" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">➕ 업무 지시</h3>
        <form id="task-form">
          <input type="text" id="task-title" placeholder="업무 내용" required maxlength="500" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;margin-bottom:10px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:10px;">
            <select id="task-assignee" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="all">🔔 전체 공지</option>
              ${staffOptions}
              <option value="__me__">★ 본인 (사장)</option>
            </select>
            <input type="datetime-local" id="task-due" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="task-priority" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="normal">일반</option>
              <option value="urgent">🚨 긴급</option>
            </select>
          </div>
          <textarea id="task-memo" placeholder="메모 (선택)" rows="2" maxlength="2000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">지시하기</button>
        </form>
      </div>

      <!-- 직원별 카드 -->
      <div class="card" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">👥 직원별 오늘 현황</h3>
        <div id="staff-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;"></div>
      </div>

      <!-- 필터 + 목록 -->
      <div class="card" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <h3 style="color:#fff;">📋 전체 업무</h3>
          <div style="display:flex;gap:8px;">
            <select id="filter-status" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="">전체 상태</option>
              <option value="pending">대기중</option>
              <option value="in_progress">진행중</option>
              <option value="done">완료</option>
            </select>
            <select id="filter-assignee" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="">전체 담당자</option>
              <option value="mine">★ 본인</option>
              ${staffList.map(s => `<option value="${s.id}">${escapeHtml(s.display_name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="task-list"></div>
      </div>
    `;

    if (user.isAdmin) {
      document.getElementById('task-form').addEventListener('submit', submitTask);
      document.getElementById('task-assignee').addEventListener('change', onAssigneeChange);
      document.getElementById('filter-status').addEventListener('change', refresh);
      document.getElementById('filter-assignee').addEventListener('change', refresh);
    }
  }

  async function refresh() {
    const params = new URLSearchParams();
    if (user.isAdmin) {
      const status = document.getElementById('filter-status')?.value;
      const assignee = document.getElementById('filter-assignee')?.value;
      if (status) params.set('status', status);
      if (assignee === 'mine') params.set('scope', 'mine');
      else if (assignee) params.set('assigneeId', assignee);
    }
    const tasksRes = await fetch('/api/tasks?' + params);
    const { data } = await tasksRes.json();
    renderList(data || []);

    if (user.isAdmin) {
      const statsRes = await fetch('/api/tasks/stats');
      if (statsRes.ok) renderStats(await statsRes.json());
    }
  }

  function renderList(items) {
    const c = document.getElementById('task-list');
    if (!c) return;
    if (items.length === 0) {
      c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">업무가 없습니다.</div>';
      return;
    }
    const statusLabels = { pending: '대기중', in_progress: '진행중', done: '완료' };
    const statusColors = { pending: '#888', in_progress: '#7c4dff', done: '#4caf50' };
    c.innerHTML = items.map(t => {
      const overdue = isOverdue(t.due_date, t.status);
      const canToggle = user.isAdmin || t.assignee_id === user.id || t.assignee_scope === 'all';
      const assigneeLabel = t.assignee_scope === 'all' ? '🔔 전체 공지' : (t.assignee?.display_name || '-');
      return html`
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;gap:12px;align-items:flex-start;${t.status === 'done' ? 'opacity:0.55;' : ''}">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
              ${t.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;">🚨 긴급</span>' : ''}
              <span style="font-weight:600;font-size:15px;color:#fff;${t.status === 'done' ? 'text-decoration:line-through;' : ''}">${escapeHtml(t.title)}</span>
              <span style="padding:2px 8px;background:${statusColors[t.status]};color:#fff;border-radius:10px;font-size:11px;">${statusLabels[t.status]}</span>
              ${overdue ? '<span style="padding:2px 8px;background:#e94560;color:#fff;border-radius:10px;font-size:11px;">마감 초과</span>' : ''}
            </div>
            <div style="font-size:12px;color:#888;display:flex;gap:10px;flex-wrap:wrap;">
              ${user.isAdmin ? `<span>👤 ${escapeHtml(assigneeLabel)}</span>` : ''}
              ${t.due_date ? `<span style="${overdue ? 'color:#ff8a80;font-weight:600;' : ''}">⏰ ${formatDate(t.due_date)}</span>` : ''}
            </div>
            ${t.memo ? `<div style="margin-top:6px;font-size:12px;color:#b0b0b0;white-space:pre-wrap;">${escapeHtml(t.memo)}</div>` : ''}
            ${t.completion_note ? `<div style="margin-top:6px;padding:6px 10px;background:#1a3a2e;border-radius:6px;font-size:12px;color:#81c784;"><strong>완료:</strong> ${escapeHtml(t.completion_note)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            ${canToggle && t.status !== 'done' ? `
              ${t.status === 'pending' ? `<button onclick="pmcTasks.setStatus(${t.id}, 'in_progress')" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">▶ 시작</button>` : ''}
              <button onclick="pmcTasks.markDone(${t.id})" style="padding:4px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">✓ 완료</button>
            ` : ''}
            ${canToggle && t.status === 'done' ? `<button onclick="pmcTasks.setStatus(${t.id}, 'pending')" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">↶ 재개</button>` : ''}
            ${user.isAdmin ? `<button onclick="pmcTasks.deleteTask(${t.id})" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderStats(stats) {
    const { today, perStaff } = stats;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-total', today.total);
    set('stat-done', today.done);
    set('stat-inprogress', today.in_progress);
    set('stat-pending', today.pending);

    const c = document.getElementById('staff-cards');
    if (!c) return;
    if (perStaff.length === 0) { c.innerHTML = '<div style="color:#888;">직원이 없습니다.</div>'; return; }
    c.innerHTML = perStaff.map(s => {
      const barColor = s.completionRate >= 80 ? '#4caf50' : (s.completionRate >= 50 ? '#7c4dff' : '#e94560');
      const badge = s.total === 0 ? '<span style="padding:2px 8px;background:#555;color:#fff;border-radius:8px;font-size:10px;">업무 없음</span>'
        : s.pending + s.in_progress === 0 ? '<span style="padding:2px 8px;background:#4caf50;color:#fff;border-radius:8px;font-size:10px;">완료</span>'
        : s.in_progress > 0 ? '<span style="padding:2px 8px;background:#7c4dff;color:#fff;border-radius:8px;font-size:10px;">진행중</span>'
        : '<span style="padding:2px 8px;background:#ff9800;color:#fff;border-radius:8px;font-size:10px;">미완료</span>';
      return `
        <div style="background:#0f0f23;padding:14px;border-radius:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <div>
              <div style="font-weight:600;color:#fff;">${escapeHtml(s.displayName)}</div>
              <div style="font-size:11px;color:#888;">${escapeHtml(s.platform || '-')}</div>
            </div>
            ${badge}
          </div>
          <div style="font-size:12px;color:#888;margin-bottom:6px;">${s.done}/${s.total}건 · ${s.completionRate}%</div>
          <div style="height:6px;background:#2a2a4a;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${s.completionRate}%;background:${barColor};"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  async function submitTask(e) {
    e.preventDefault();
    const title = document.getElementById('task-title').value.trim();
    const assigneeSel = document.getElementById('task-assignee').value;
    const dueStr = document.getElementById('task-due').value;
    const priority = document.getElementById('task-priority').value;
    const memo = document.getElementById('task-memo').value.trim();
    if (!title) return;

    const payload = { title, priority, memo: memo || undefined, dueDate: dueStr ? new Date(dueStr).toISOString() : undefined };
    if (assigneeSel === 'all') { payload.assigneeScope = 'all'; payload.assigneeId = null; }
    else if (assigneeSel === '__me__') { payload.assigneeScope = 'specific'; payload.assigneeId = user.id; }
    else { payload.assigneeScope = 'specific'; payload.assigneeId = Number(assigneeSel); }

    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '등록 실패'); return; }
    document.getElementById('task-form').reset();
    refresh();
  }

  function onAssigneeChange() {
    const sel = document.getElementById('task-assignee');
    const opt = sel.options[sel.selectedIndex];
    const defaultDue = opt.dataset.duetime;
    if (defaultDue) {
      const today = new Date();
      const [h, m] = defaultDue.split(':');
      today.setHours(Number(h), Number(m), 0, 0);
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('task-due').value =
        `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}T${pad(today.getHours())}:${pad(today.getMinutes())}`;
    }
  }

  async function setStatus(id, status) {
    const res = await fetch('/api/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refresh();
  }

  async function markDone(id) {
    const note = user.isAdmin ? (prompt('완료 코멘트 (선택):') || '') : (prompt('완료 코멘트를 입력하세요:') || '');
    if (!user.isAdmin && !note.trim()) { alert('완료 코멘트는 필수입니다.'); return; }
    const res = await fetch('/api/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done', completionNote: note }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refresh();
  }

  async function deleteTask(id) {
    if (!confirm('이 업무를 삭제하시겠습니까?')) return;
    const res = await fetch('/api/tasks/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('삭제 실패'); return; }
    refresh();
  }

  window.pmcTasks = { load, refresh, setStatus, markDone, deleteTask };
})();
