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
    const yday = new Date(now); yday.setDate(now.getDate() - 1);
    const pad = n => String(n).padStart(2, '0');
    const timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (sameDay) return '오늘 ' + timeStr;
    if (d.toDateString() === tmr.toDateString()) return '내일 ' + timeStr;
    if (d.toDateString() === yday.toDateString()) return '어제 ' + timeStr;
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
      try {
        const res = await fetch('/api/users/staff');
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          console.error('[tasks] /api/users/staff 응답 실패:', res.status, errBody);
        } else {
          const all = (await res.json()).data || [];
          // 본인은 ★ 본인 (사장) 옵션이 따로 있으니 staff 목록에서 제외
          staffList = all.filter(s => s.id !== user.id);
        }
      } catch (e) {
        console.error('[tasks] /api/users/staff 호출 실패:', e);
      }
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

    const staffOptions = staffList.length > 0
      ? staffList.map(s => `<option value="${s.id}" data-duetime="${s.default_due_time || ''}">${escapeHtml(s.display_name)}${s.platform ? ' · ' + escapeHtml(s.platform) : ''}</option>`).join('')
      : `<option value="" disabled>— 직원이 없습니다 (좌측 '직원 관리'에서 추가하세요) —</option>`;

    el.innerHTML = html`
      <div class="page-header" style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">📋 업무 관리</h1>
        <p style="color:#888;font-size:13px;">전체 직원 업무 현황 · 업무 지시 · 본인 할 일</p>
      </div>

      <!-- AI 오늘 브리핑 (PR T-2) -->
      <div id="ob-mini" style="display:none;background:#1a1a2e;border:1px solid #2a2a4a;border-left:3px solid #64b5f6;border-radius:12px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:12px;color:#64b5f6;font-weight:600;margin-bottom:6px;">🤖 AI 오늘 브리핑</div>
        <ul id="ob-mini-list" style="margin:0;padding-left:18px;color:#ccc;font-size:13px;line-height:1.7;"></ul>
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
              <option value="pending">대기</option>
              <option value="in_progress">진행중</option>
              <option value="blocked">막힘</option>
              <option value="done">완료</option>
            </select>
            <select id="filter-assignee" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="">전체 담당자</option>
              <option value="mine">★ 본인</option>
              ${staffList.map(s => `<option value="${s.id}">${escapeHtml(s.display_name)}</option>`).join('')}
            </select>
            <button type="button" id="filter-clear" title="필터 해제" style="display:none;padding:6px 10px;background:#2a2a4a;border:0;border-radius:6px;color:#ccc;cursor:pointer;font-size:12px;">× 전체보기</button>
          </div>
        </div>
        <div id="task-list"></div>
      </div>
    `;

    if (user.isAdmin) {
      document.getElementById('task-form').addEventListener('submit', submitTask);
      document.getElementById('task-assignee').addEventListener('change', onAssigneeChange);
      document.getElementById('filter-status').addEventListener('change', () => { refresh(); syncFilterClear(); });
      document.getElementById('filter-assignee').addEventListener('change', () => { refresh(); syncFilterClear(); });
      document.getElementById('filter-clear').addEventListener('click', clearFilters);
      loadAiBriefing();
    }
  }

  function syncFilterClear() {
    const btn = document.getElementById('filter-clear');
    if (!btn) return;
    const status = document.getElementById('filter-status')?.value;
    const assignee = document.getElementById('filter-assignee')?.value;
    btn.style.display = (status || assignee) ? '' : 'none';
  }

  function clearFilters() {
    const s = document.getElementById('filter-status'); if (s) s.value = '';
    const a = document.getElementById('filter-assignee'); if (a) a.value = '';
    syncFilterClear();
    refresh();
  }

  function filterByAssignee(userId) {
    const a = document.getElementById('filter-assignee');
    if (!a) return;
    a.value = String(userId);
    syncFilterClear();
    refresh();
  }

  async function loadAiBriefing() {
    try {
      const res = await fetch('/api/ops-briefing/today');
      if (!res.ok) return;
      const b = await res.json();
      const recs = (b?.recommendations || []).filter(Boolean);
      const box = document.getElementById('ob-mini');
      const list = document.getElementById('ob-mini-list');
      if (!box || !list) return;
      if (recs.length === 0) { box.style.display = 'none'; return; }
      list.innerHTML = recs.map(r => `<li>${escapeHtml(r)}</li>`).join('');
      box.style.display = '';
    } catch {}
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

  const STATUS_LABELS = { pending: '대기', in_progress: '진행중', done: '완료', blocked: '막힘' };
  const STATUS_COLORS = { pending: '#888', in_progress: '#7c4dff', done: '#4caf50', blocked: '#ff9800' };

  function renderList(items) {
    const c = document.getElementById('task-list');
    if (!c) return;
    if (items.length === 0) {
      c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">업무가 없습니다.</div>';
      return;
    }
    c.innerHTML = items.map(t => user.isAdmin ? renderOwnerRow(t) : renderStaffRow(t)).join('');
    loadCommentsForVisibleTasks();
  }

  // 직원용: 본인 recipient 상태만 보여줌
  function renderStaffRow(t) {
    const myStatus = t.myStatus || 'pending';
    const overdue = isOverdue(t.due_date, myStatus);
    const isDone = myStatus === 'done';
    const isBlocked = myStatus === 'blocked';
    // 막힘 일 때 completion_note 는 '막힘 사유' 의미 (단일 컬럼 재사용)
    const noteLabel = isBlocked ? '막힘' : '완료';
    const noteBg = isBlocked ? '#3a2a1a' : '#1a3a2e';
    const noteFg = isBlocked ? '#ffb74d' : '#81c784';
    const urgentBar = t.priority === 'urgent' ? 'border-left:3px solid #e94560;' : '';
    return `
      <div style="padding:16px;border-bottom:1px solid #2a2a4a;${urgentBar}${isDone ? 'opacity:0.55;' : ''}">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
              ${t.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;">🚨 긴급</span>' : ''}
              <span style="font-weight:600;font-size:15px;color:#fff;${isDone ? 'text-decoration:line-through;' : ''}">${escapeHtml(t.title)}</span>
              <span style="padding:2px 8px;background:${STATUS_COLORS[myStatus]};color:#fff;border-radius:10px;font-size:11px;">${STATUS_LABELS[myStatus]}</span>
              ${t.assignee_scope === 'all' ? '<span style="padding:2px 8px;background:#0288d1;color:#fff;border-radius:10px;font-size:11px;">🔔 전체 공지</span>' : ''}
              ${overdue ? '<span style="padding:2px 8px;background:#e94560;color:#fff;border-radius:10px;font-size:11px;">마감 초과</span>' : ''}
            </div>
            <div style="font-size:12px;color:#888;display:flex;gap:10px;flex-wrap:wrap;">
              ${t.created_at ? `<span title="지시 받은 시각">📬 ${formatDate(t.created_at)} 지시</span>` : ''}
              ${t.due_date ? `<span style="${overdue ? 'color:#ff8a80;font-weight:600;' : ''}">⏰ ${formatDate(t.due_date)}</span>` : ''}
            </div>
            ${t.memo ? `<div style="margin-top:6px;font-size:12px;color:#b0b0b0;white-space:pre-wrap;">${escapeHtml(t.memo)}</div>` : ''}
            ${t.myCompletionNote ? `<div style="margin-top:6px;padding:6px 10px;background:${noteBg};border-radius:6px;font-size:12px;color:${noteFg};"><strong>${noteLabel}:</strong> ${escapeHtml(t.myCompletionNote)}</div>` : ''}
            ${renderAttachmentBadges(t.id, t.myAttachments)}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            ${renderQuickActions(t.id, myStatus)}
          </div>
        </div>
        ${renderCommentsArea(t.id)}
      </div>
    `;
  }

  // 빠른 액션 버튼 — 진행중 / 완료 / 막힘 (PR T-2)
  function renderQuickActions(id, status) {
    if (status === 'done') {
      return `<button onclick="pmcTasks.setStatus(${id}, 'pending')" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">↶ 재개</button>`;
    }
    if (status === 'blocked') {
      return `
        <button onclick="pmcTasks.setStatus(${id}, 'in_progress')" style="padding:4px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">▶ 재개</button>
        <button onclick="pmcTasks.markDone(${id})" style="padding:4px 10px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✓ 완료</button>
      `;
    }
    // pending / in_progress
    return `
      ${status !== 'in_progress' ? `<button onclick="pmcTasks.setStatus(${id}, 'in_progress')" style="padding:4px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">▶ 진행중</button>` : ''}
      <button onclick="pmcTasks.markDone(${id})" style="padding:4px 10px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">✓ 완료</button>
      <button onclick="pmcTasks.openBlockedModal(${id})" style="padding:4px 10px;background:#ff9800;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">⚠ 막힘</button>
    `;
  }

  // 사장용: 집계 + 수신자 진행률. 브로드캐스트는 펼쳐보기.
  function renderOwnerRow(t) {
    const overdue = isOverdue(t.due_date, t.status);
    const agg = t.aggregate || { total: 0, pending: 0, in_progress: 0, done: 0 };
    const isBroadcast = t.assignee_scope === 'all';
    const progressPct = agg.total > 0 ? Math.round((agg.done / agg.total) * 100) : 0;
    const progressColor = progressPct === 100 ? '#4caf50' : progressPct >= 50 ? '#7c4dff' : '#ff9800';
    const titleStyle = t.status === 'done' ? 'text-decoration:line-through;opacity:0.7;' : '';
    const urgentBar = t.priority === 'urgent' ? 'border-left:3px solid #e94560;' : '';

    const assigneeLabel = isBroadcast
      ? `🔔 전체 공지 · ${agg.done}/${agg.total} 완료`
      : (t.recipients?.[0]?.userName || '-');

    // 첨부 요약 — 사장이 펼치기 없이도 바로 보게 함
    const totalAttachments = (t.recipients || []).reduce((n, r) => n + ((r.attachments && r.attachments.length) || 0), 0);
    const soleRecipient = !isBroadcast ? (t.recipients || [])[0] : null;
    const soleCompletionNote = soleRecipient?.completionNote;
    const soleAttachments = soleRecipient?.attachments || [];
    const soleStatus = soleRecipient?.status;
    const soleNoteLabel = soleStatus === 'blocked' ? '막힘' : '완료';
    const soleNoteBg = soleStatus === 'blocked' ? '#3a2a1a' : '#1a3a2e';
    const soleNoteFg = soleStatus === 'blocked' ? '#ffb74d' : '#81c784';

    return `
      <div style="border-bottom:1px solid #2a2a4a;${urgentBar}">
        <div style="padding:16px;display:flex;gap:12px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
              ${t.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;">🚨 긴급</span>' : ''}
              <span style="font-weight:600;font-size:15px;color:#fff;${titleStyle}">${escapeHtml(t.title)}</span>
              <span style="padding:2px 8px;background:${STATUS_COLORS[t.status]};color:#fff;border-radius:10px;font-size:11px;">${STATUS_LABELS[t.status]}</span>
              ${overdue ? '<span style="padding:2px 8px;background:#e94560;color:#fff;border-radius:10px;font-size:11px;">마감 초과</span>' : ''}
            </div>
            <div style="font-size:12px;color:#888;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
              <span>👤 ${escapeHtml(assigneeLabel)}</span>
              ${t.created_at ? `<span title="등록 시각">📬 ${formatDate(t.created_at)}</span>` : ''}
              ${t.due_date ? `<span style="${overdue ? 'color:#ff8a80;font-weight:600;' : ''}">⏰ ${formatDate(t.due_date)}</span>` : ''}
              ${!isBroadcast && soleRecipient
                ? `<span style="padding:1px 6px;background:${STATUS_COLORS[soleStatus]};color:#fff;border-radius:8px;font-size:10px;">${STATUS_LABELS[soleStatus]}</span>`
                : ''}
            </div>
            ${!isBroadcast && soleCompletionNote
              ? `<div style="margin-top:6px;padding:6px 10px;background:${soleNoteBg};border-radius:6px;font-size:12px;color:${soleNoteFg};"><strong>${soleNoteLabel}:</strong> ${escapeHtml(soleCompletionNote)}</div>`
              : ''}
            ${!isBroadcast && soleAttachments.length > 0
              ? renderAttachmentBadges(t.id, soleAttachments)
              : ''}
            ${isBroadcast ? `
              <div style="margin-top:8px;height:6px;background:#2a2a4a;border-radius:3px;overflow:hidden;">
                <div style="height:100%;width:${progressPct}%;background:${progressColor};transition:width 0.3s;"></div>
              </div>
              <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
                <button onclick="pmcTasks.toggleExpand(${t.id}, event)" id="expand-btn-${t.id}" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:11px;padding:0;">▼ 수신자 상세 (${agg.total}명)</button>
                ${totalAttachments > 0
                  ? `<span style="color:#64b5f6;font-size:11px;">📎 첨부 ${totalAttachments}건</span>`
                  : ''}
              </div>
            ` : ''}
            ${t.memo ? `<div style="margin-top:6px;font-size:12px;color:#b0b0b0;white-space:pre-wrap;">${escapeHtml(t.memo)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            <button onclick="pmcTasks.setStatusFor(${t.id}, ${soleRecipient?.userId || 'null'}, '${soleStatus === 'done' ? 'pending' : 'done'}')"
                    style="padding:4px 8px;background:${soleStatus === 'done' ? '#2a2a4a' : '#7c4dff'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;${isBroadcast || !soleRecipient ? 'display:none;' : ''}">
              ${soleStatus === 'done' ? '↶ 재개' : '✓ 완료처리'}
            </button>
            <button onclick="pmcTasks.deleteTask(${t.id})" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>
          </div>
        </div>
        <div id="recipients-${t.id}" style="display:none;padding:0 16px 12px 16px;">
          ${(t.recipients || []).map(r => `
            <div style="padding:6px 10px;background:#0f0f23;border-radius:6px;margin-bottom:4px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0;">
                  <span style="color:#fff;font-size:13px;">${escapeHtml(r.userName)}</span>
                  <span style="padding:1px 6px;background:${STATUS_COLORS[r.status]};color:#fff;border-radius:8px;font-size:10px;">${STATUS_LABELS[r.status]}</span>
                  ${r.completionNote ? `<span style="color:${r.status === 'blocked' ? '#ffb74d' : '#81c784'};font-size:11px;">— ${escapeHtml(r.completionNote)}</span>` : ''}
                </div>
                <div style="display:flex;gap:4px;flex-shrink:0;">
                  ${r.status !== 'done'
                    ? `<button onclick="pmcTasks.setStatusFor(${t.id}, ${r.userId}, 'done')" style="padding:2px 8px;background:#7c4dff;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">✓ 완료처리</button>`
                    : `<button onclick="pmcTasks.setStatusFor(${t.id}, ${r.userId}, 'pending')" style="padding:2px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">↶ 재개</button>`
                  }
                </div>
              </div>
              ${renderAttachmentBadges(t.id, r.attachments)}
            </div>
          `).join('')}
        </div>
        ${renderCommentsArea(t.id)}
      </div>
    `;
  }

  function toggleExpand(taskId, e) {
    if (e) e.stopPropagation();
    const el = document.getElementById('recipients-' + taskId);
    const btn = document.getElementById('expand-btn-' + taskId);
    if (!el) return;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.innerHTML = '▲ 접기';
    } else {
      el.style.display = 'none';
      if (btn) {
        const count = (el.children || []).length;
        btn.innerHTML = `▼ 수신자 상세 (${count}명)`;
      }
    }
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
        <div onclick="pmcTasks.filterByAssignee(${s.userId})" title="${escapeHtml(s.displayName)} 업무만 보기"
             style="background:#0f0f23;padding:14px;border-radius:10px;cursor:pointer;transition:background 0.15s;"
             onmouseover="this.style.background='#161630'" onmouseout="this.style.background='#0f0f23'">
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

  // 본인 상태 변경
  async function setStatus(id, status) {
    const res = await fetch('/api/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refresh();
  }

  // 본인 완료 처리 — 모달: 코멘트 + 파일 첨부 (최대 5개, 10MB/개)
  const ALLOWED_EXT = '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.docx,.doc,.zip';
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  function formatSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function openCompleteModal(id) {
    const requireNote = !user.isAdmin;
    const existing = document.getElementById('task-complete-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.id = 'task-complete-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:460px;max-width:92vw;color:#e0e0e0;">
        <div style="font-size:16px;font-weight:700;margin-bottom:14px;">✓ 업무 완료 처리</div>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:6px;">완료 코멘트${requireNote ? ' <span style="color:#e94560;">*</span>' : ' (선택)'}</label>
        <textarea id="tc-note" rows="3" placeholder="어떻게 처리했는지 간단히 남겨주세요" style="width:100%;padding:10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#fff;font-size:13px;resize:vertical;font-family:inherit;"></textarea>

        <label style="display:block;font-size:12px;color:#aaa;margin:14px 0 6px;">첨부 파일 (PDF/이미지/엑셀/워드/ZIP · 개당 10MB · 최대 ${MAX_FILES}개)</label>
        <input id="tc-files" type="file" multiple accept="${ALLOWED_EXT}" style="display:block;color:#ccc;font-size:12px;">
        <div id="tc-filelist" style="margin-top:8px;display:flex;flex-direction:column;gap:4px;"></div>

        <div id="tc-error" style="display:none;margin-top:10px;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">
          <button type="button" id="tc-cancel" style="padding:8px 16px;background:#2a2a4a;color:#ccc;border:0;border-radius:6px;cursor:pointer;">취소</button>
          <button type="button" id="tc-submit" style="padding:8px 18px;background:#7c4dff;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600;">완료 제출</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);

    const fileInput = m.querySelector('#tc-files');
    const fileListEl = m.querySelector('#tc-filelist');
    const errorEl = m.querySelector('#tc-error');
    let selectedFiles = [];

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }
    function clearError() { errorEl.style.display = 'none'; }

    function renderFiles() {
      fileListEl.innerHTML = selectedFiles.map((f, i) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#0f0f23;border-radius:4px;font-size:12px;">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📎 ${escapeHtml(f.name)}</span>
          <span style="color:#888;margin:0 10px;">${formatSize(f.size)}</span>
          <button type="button" data-idx="${i}" class="tc-rm" style="background:transparent;border:0;color:#e94560;cursor:pointer;font-size:14px;">×</button>
        </div>
      `).join('');
      fileListEl.querySelectorAll('.tc-rm').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedFiles.splice(Number(btn.dataset.idx), 1);
          renderFiles();
        });
      });
    }

    fileInput.addEventListener('change', () => {
      clearError();
      const incoming = Array.from(fileInput.files || []);
      for (const f of incoming) {
        if (f.size > MAX_FILE_BYTES) { showError(`"${f.name}" 파일이 10MB를 초과합니다`); continue; }
        if (selectedFiles.length >= MAX_FILES) { showError(`최대 ${MAX_FILES}개까지만 첨부 가능합니다`); break; }
        if (selectedFiles.some(x => x.name === f.name && x.size === f.size)) continue;
        selectedFiles.push(f);
      }
      fileInput.value = '';
      renderFiles();
    });

    m.querySelector('#tc-cancel').addEventListener('click', () => m.remove());
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });

    m.querySelector('#tc-submit').addEventListener('click', async () => {
      clearError();
      const note = m.querySelector('#tc-note').value.trim();
      if (requireNote && !note) { showError('완료 코멘트를 입력하세요'); return; }

      const btn = m.querySelector('#tc-submit');
      btn.disabled = true;
      btn.textContent = '제출 중...';

      try {
        const fd = new FormData();
        fd.append('completionNote', note);
        for (const f of selectedFiles) fd.append('files', f);

        const res = await fetch('/api/tasks/' + id + '/complete', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showError(data.error || '제출 실패'); btn.disabled = false; btn.textContent = '완료 제출'; return; }
        m.remove();
        refresh();
      } catch (err) {
        showError(err.message || '네트워크 오류');
        btn.disabled = false;
        btn.textContent = '완료 제출';
      }
    });
  }

  async function markDone(id) {
    openCompleteModal(id);
  }

  // 막힘 모달 — 한줄 사유만 (PR T-2)
  function openBlockedModal(id) {
    const existing = document.getElementById('task-blocked-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.id = 'task-blocked-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:420px;max-width:92vw;color:#e0e0e0;">
        <div style="font-size:16px;font-weight:700;margin-bottom:14px;color:#ffb74d;">⚠ 업무 막힘 보고</div>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:6px;">막힘 사유 <span style="color:#e94560;">*</span></label>
        <input id="bm-reason" type="text" maxlength="200" placeholder="예: 경쟁셀러 가격 너무 낮음 / 재고 부족 / 권한 없음"
          style="width:100%;padding:10px;border:1px solid #333;border-radius:6px;background:#0f0f23;color:#fff;font-size:13px;">
        <div id="bm-error" style="display:none;margin-top:10px;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">
          <button type="button" id="bm-cancel" style="padding:8px 16px;background:#2a2a4a;color:#ccc;border:0;border-radius:6px;cursor:pointer;">취소</button>
          <button type="button" id="bm-submit" style="padding:8px 18px;background:#ff9800;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600;">막힘 보고</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);

    const errorEl = m.querySelector('#bm-error');
    const showError = msg => { errorEl.textContent = msg; errorEl.style.display = 'block'; };

    m.querySelector('#bm-cancel').addEventListener('click', () => m.remove());
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    setTimeout(() => m.querySelector('#bm-reason')?.focus(), 50);

    m.querySelector('#bm-submit').addEventListener('click', async () => {
      const reason = m.querySelector('#bm-reason').value.trim();
      if (!reason) { showError('막힘 사유를 한줄로 입력하세요'); return; }

      const btn = m.querySelector('#bm-submit');
      btn.disabled = true;
      btn.textContent = '제출 중...';

      try {
        const res = await fetch('/api/tasks/' + id + '/blocked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showError(data.error || '제출 실패'); btn.disabled = false; btn.textContent = '막힘 보고'; return; }
        m.remove();
        refresh();
      } catch (err) {
        showError(err.message || '네트워크 오류');
        btn.disabled = false;
        btn.textContent = '막힘 보고';
      }
    });
  }

  async function downloadAttachment(taskId, attId) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/attachments/${attId}/url`);
      const data = await res.json();
      if (!res.ok) { alert(data.error || '다운로드 URL 발급 실패'); return; }
      window.open(data.signedUrl, '_blank');
    } catch (e) {
      alert('다운로드 실패: ' + e.message);
    }
  }

  function renderAttachmentBadges(taskId, atts) {
    if (!atts || atts.length === 0) return '';
    return `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">` +
      atts.map(a => `<button onclick="pmcTasks.downloadAttachment(${taskId}, ${a.id})" style="padding:3px 10px;background:#0f2a3a;border:1px solid #1565c0;border-radius:14px;color:#64b5f6;font-size:11px;cursor:pointer;">📎 ${escapeHtml(a.fileName)}</button>`).join('') +
      `</div>`;
  }

  // 사장이 특정 직원 대신 상태 변경 (강제)
  async function setStatusFor(taskId, userId, status) {
    const payload = { status, userId };
    if (status === 'done') {
      const note = prompt('완료 코멘트 (선택, 강제 완료 처리):') || '';
      if (note) payload.completionNote = note;
    }
    const res = await fetch('/api/tasks/' + taskId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

  // ── 한줄 댓글 영역 (PR T-2) ──
  // 카드별 댓글 영역 shell. 첫 렌더 시 최근 1개만 lazy 로드.
  function renderCommentsArea(taskId) {
    return `
      <div id="cmts-${taskId}" data-task-id="${taskId}" style="border-top:1px solid #2a2a4a;padding:10px 16px;background:#0d0d1f;">
        <div id="cmts-list-${taskId}" style="font-size:12px;color:#888;">댓글 로딩 중…</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <input id="cmt-input-${taskId}" type="text" maxlength="500" placeholder="한줄 댓글…"
            style="flex:1;padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="cmt-files-${taskId}" type="file" multiple accept="${ALLOWED_EXT}" style="display:none;">
          <button type="button" onclick="document.getElementById('cmt-files-${taskId}').click()" title="파일 첨부 (최대 3개 · 5MB)"
            style="padding:6px 8px;background:#2a2a4a;border:0;border-radius:6px;color:#aaa;cursor:pointer;font-size:12px;">📎</button>
          <button type="button" onclick="pmcTasks.submitComment(${taskId})"
            style="padding:6px 12px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">전송</button>
        </div>
        <div id="cmt-files-list-${taskId}" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;"></div>
      </div>
    `;
  }

  // task-list 렌더 후 호출 — 모든 카드에 최근 1개 댓글 로드
  async function loadCommentsForVisibleTasks() {
    const nodes = document.querySelectorAll('[id^="cmts-list-"]');
    for (const n of nodes) {
      const taskId = parseInt(n.id.replace('cmts-list-', ''), 10);
      if (!Number.isFinite(taskId)) continue;
      loadCommentPreview(taskId);
      attachCommentFileInput(taskId);
    }
  }

  function attachCommentFileInput(taskId) {
    const input = document.getElementById('cmt-files-' + taskId);
    const list = document.getElementById('cmt-files-list-' + taskId);
    if (!input || !list) return;
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []).slice(0, 3);
      list.innerHTML = files.map(f => `<span style="padding:2px 8px;background:#1f3a4a;border-radius:10px;color:#80d8ff;font-size:11px;">📎 ${escapeHtml(f.name)}</span>`).join('');
    });
  }

  async function loadCommentPreview(taskId) {
    const list = document.getElementById('cmts-list-' + taskId);
    if (!list) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments?limit=1`);
      if (!res.ok) { list.innerHTML = ''; return; }
      const { data, total } = await res.json();
      if (!data || data.length === 0) { list.innerHTML = '<span style="color:#666;">댓글 없음</span>'; return; }
      list.innerHTML = renderCommentRow(taskId, data[0]) +
        (total > 1 ? `<button type="button" onclick="pmcTasks.expandComments(${taskId})" style="margin-top:4px;background:transparent;border:0;color:#888;cursor:pointer;font-size:11px;padding:0;">더보기 (${total - 1}) ▼</button>` : '');
    } catch {
      list.innerHTML = '';
    }
  }

  async function expandComments(taskId) {
    const list = document.getElementById('cmts-list-' + taskId);
    if (!list) return;
    list.innerHTML = '<span style="color:#666;">불러오는 중…</span>';
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`);
      if (!res.ok) { list.innerHTML = '<span style="color:#e94560;">불러오기 실패</span>'; return; }
      const { data } = await res.json();
      if (!data || data.length === 0) { list.innerHTML = '<span style="color:#666;">댓글 없음</span>'; return; }
      list.innerHTML = data.map(c => renderCommentRow(taskId, c)).join('');
    } catch (e) {
      list.innerHTML = '<span style="color:#e94560;">' + escapeHtml(e.message) + '</span>';
    }
  }

  function renderCommentRow(taskId, c) {
    const author = c.author_id === user?.id ? '나' : ('#' + c.author_id);
    const when = formatDate(c.created_at);
    const atts = Array.isArray(c.attachments) ? c.attachments : [];
    const attsHtml = atts.length === 0 ? '' :
      `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px;">` +
      atts.map((a, i) => `<button type="button" onclick="pmcTasks.downloadCommentFile(${taskId}, ${c.id}, ${i})" style="padding:2px 8px;background:#0f2a3a;border:1px solid #1565c0;border-radius:10px;color:#64b5f6;font-size:10px;cursor:pointer;">📎 ${escapeHtml(a.file_name)}</button>`).join('') +
      `</div>`;
    return `
      <div style="padding:4px 0;">
        <span style="color:#aaa;">${escapeHtml(author)}</span>
        <span style="color:#666;font-size:11px;"> · ${when}</span>
        <span style="color:#ddd;"> · ${escapeHtml(c.content)}</span>
        ${attsHtml}
      </div>
    `;
  }

  async function submitComment(taskId) {
    const input = document.getElementById('cmt-input-' + taskId);
    const fileInput = document.getElementById('cmt-files-' + taskId);
    const filesListEl = document.getElementById('cmt-files-list-' + taskId);
    if (!input) return;
    const content = input.value.trim();
    const files = Array.from(fileInput?.files || []).slice(0, 3);
    if (!content) { input.focus(); return; }

    try {
      const fd = new FormData();
      fd.append('content', content);
      for (const f of files) fd.append('files', f);
      const res = await fetch(`/api/tasks/${taskId}/comments`, { method: 'POST', body: fd });
      if (!res.ok) { alert((await res.json()).error || '댓글 등록 실패'); return; }
      input.value = '';
      if (fileInput) fileInput.value = '';
      if (filesListEl) filesListEl.innerHTML = '';
      loadCommentPreview(taskId);
    } catch (e) {
      alert('네트워크 오류: ' + e.message);
    }
  }

  async function downloadCommentFile(taskId, commentId, idx) {
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments/${commentId}/attachments/${idx}/url`);
      if (!res.ok) { alert((await res.json()).error || '다운로드 실패'); return; }
      const { signedUrl } = await res.json();
      window.open(signedUrl, '_blank');
    } catch (e) {
      alert('다운로드 실패: ' + e.message);
    }
  }

  window.pmcTasks = {
    load, refresh, setStatus, markDone, openBlockedModal, setStatusFor, deleteTask,
    toggleExpand, downloadAttachment,
    filterByAssignee,
    submitComment, expandComments, downloadCommentFile,
  };
})();
