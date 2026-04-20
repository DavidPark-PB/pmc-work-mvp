/**
 * 주간 업무 관리 (Phase 3) — 직원이 주간 계획·회고, admin은 월별 KPI.
 */
(function() {
  let user = null;
  let current = null;     // { id, userId, weekStart, items[], reflection*, status, agg }
  let viewMode = 'self';  // 'self' | 'admin' | 'meetings'
  let adminMonth = null;
  let kpiData = null;
  let meetingsList = [];
  let activeMeeting = null;   // 편집 중 회의 (모달)
  let staffCache = null;      // [{id, displayName, platform}]

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function isoToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function thisMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function weekStartOf(dateStr) {
    const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
    const dow = d.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function weekEndOf(weekStartStr) {
    const d = new Date(weekStartStr + 'T00:00:00');
    d.setDate(d.getDate() + 6);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function weekLabel(ws) {
    if (!ws) return '';
    const we = weekEndOf(ws);
    const [, m1, d1] = ws.split('-');
    const [, m2, d2] = we.split('-');
    return `${m1}/${d1} ~ ${m2}/${d2}`;
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await refreshSelf();
  }

  function renderShell() {
    const el = document.getElementById('page-weekly');
    const adminTabs = user.isAdmin ? `
      <button type="button" id="wp-tab-admin" onclick="pmcWeekly.switchView('admin')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">📊 월별 KPI (admin)</button>
      <button type="button" id="wp-tab-meetings" onclick="pmcWeekly.switchView('meetings')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">📅 회의 (admin)</button>
    ` : '';
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">🗓️ 주간 업무 <span style="color:#888;font-weight:400;font-size:13px;">· 계획·실적 관리</span></h1>
        <p style="color:#888;font-size:13px;">월요일마다 한 주 계획을 세우고, 주중 상태 업데이트, 금요일·주말에 회고를 남기세요. 월별로 KPI가 자동 집계됩니다.</p>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #2a2a4a;flex-wrap:wrap;">
        <button type="button" id="wp-tab-self" onclick="pmcWeekly.switchView('self')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">📝 내 주간 플랜</button>
        ${adminTabs}
      </div>

      <div id="wp-self-view"></div>
      <div id="wp-admin-view" style="display:none;"></div>
      <div id="wp-meetings-view" style="display:none;"></div>
      <div id="wp-meeting-modal"></div>
    `;
  }

  function setTabStyle(id, active) {
    const e = document.getElementById(id);
    if (!e) return;
    e.style.color = active ? '#fff' : '#888';
    e.style.fontWeight = active ? '600' : '400';
    e.style.borderBottom = active ? '2px solid #7c4dff' : '2px solid transparent';
  }

  function switchView(v) {
    viewMode = v;
    setTabStyle('wp-tab-self', v === 'self');
    if (user.isAdmin) {
      setTabStyle('wp-tab-admin', v === 'admin');
      setTabStyle('wp-tab-meetings', v === 'meetings');
    }
    document.getElementById('wp-self-view').style.display = v === 'self' ? '' : 'none';
    document.getElementById('wp-admin-view').style.display = v === 'admin' ? '' : 'none';
    document.getElementById('wp-meetings-view').style.display = v === 'meetings' ? '' : 'none';
    if (v === 'admin' && !kpiData) refreshAdmin();
    if (v === 'meetings') refreshMeetings();
  }

  // ─── SELF: 이번주 플랜 + 히스토리 ───
  async function refreshSelf(weekStart) {
    const params = new URLSearchParams();
    if (weekStart) params.set('weekStart', weekStart);
    try {
      const [curRes, histRes] = await Promise.all([
        fetch('/api/weekly-plans/current?' + params),
        fetch('/api/weekly-plans?limit=8'),
      ]);
      const cur = await curRes.json();
      const hist = await histRes.json();
      if (!curRes.ok) throw new Error(cur.error || 'current 로드 실패');
      current = cur.data;
      renderSelf(hist.data || []);
    } catch (e) {
      document.getElementById('wp-self-view').innerHTML = `<div style="padding:20px;color:#ff8a80;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderSelf(history) {
    const host = document.getElementById('wp-self-view');
    if (!host || !current) return;
    const ws = current.weekStart;
    const agg = current.agg || { total: 0, done: 0, inProgress: 0, dropped: 0, completionPct: 0 };
    const submittedBadge = current.status === 'submitted'
      ? '<span style="padding:2px 10px;background:#4caf50;color:#fff;border-radius:10px;font-size:11px;margin-left:8px;">✓ 제출됨</span>'
      : '<span style="padding:2px 10px;background:#ffa726;color:#fff;border-radius:10px;font-size:11px;margin-left:8px;">작성중</span>';

    host.innerHTML = `
      <!-- 이번주 헤더 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div>
            <div style="color:#fff;font-size:16px;font-weight:600;">${weekLabel(ws)} <span style="font-weight:400;color:#888;font-size:12px;">(${ws})</span>${submittedBadge}</div>
            <div style="color:#888;font-size:12px;margin-top:2px;">
              ${agg.total}개 계획 · 완료 <span style="color:#81c784;">${agg.done}</span> · 진행 <span style="color:#64b5f6;">${agg.inProgress}</span> · 포기 <span style="color:#aaa;">${agg.dropped}</span> · 달성률 <strong style="color:#ffb74d;">${agg.completionPct}%</strong>
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <input type="date" id="wp-week-picker" value="${ws}" onchange="pmcWeekly.jumpWeek()" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            ${current.status === 'submitted'
              ? `<button type="button" onclick="pmcWeekly.setStatus('draft')" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">✏️ 수정 재개</button>`
              : `<button type="button" onclick="pmcWeekly.setStatus('submitted')" style="padding:7px 14px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ 제출</button>`
            }
          </div>
        </div>
      </div>

      <!-- 계획 항목 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📋 이번주 계획</h3>
          <button type="button" onclick="pmcWeekly.addItem()" style="padding:5px 12px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">+ 계획 추가</button>
        </div>
        <div id="wp-items-host">${renderItemsHtml(current.items)}</div>
      </div>

      <!-- 회고 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">💭 회고</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;">
          <div>
            <label style="font-size:11px;color:#81c784;">잘한 일 (Wins)</label>
            <textarea id="wp-wins" rows="3" placeholder="이번주 잘한 점, 달성한 것..." style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" onblur="pmcWeekly.saveReflection()">${esc(current.reflectionWins || '')}</textarea>
          </div>
          <div>
            <label style="font-size:11px;color:#ff8a80;">막힘 (Blockers)</label>
            <textarea id="wp-blockers" rows="3" placeholder="이번주 힘들었던 것, 해결 못한 것..." style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" onblur="pmcWeekly.saveReflection()">${esc(current.reflectionBlockers || '')}</textarea>
          </div>
          <div>
            <label style="font-size:11px;color:#64b5f6;">다음주 계획 (Next)</label>
            <textarea id="wp-next" rows="3" placeholder="다음주 예정, 이어갈 것..." style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" onblur="pmcWeekly.saveReflection()">${esc(current.reflectionNextWeek || '')}</textarea>
          </div>
        </div>
        <div style="color:#666;font-size:10px;margin-top:6px;">입력 후 칸 밖 클릭 시 자동 저장됩니다.</div>
      </div>

      <!-- 히스토리 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:12px 14px;border-bottom:1px solid #2a2a4a;"><h3 style="color:#fff;font-size:14px;margin:0;">📚 지난 주간 기록</h3></div>
        <div>
          ${(history || []).filter(h => h.weekStart !== ws).slice(0, 8).map(h => {
            const a = h.agg || { completionPct: 0, done: 0, total: 0 };
            const submitted = h.status === 'submitted';
            return `<div onclick="pmcWeekly.jumpWeekTo('${h.weekStart}')" style="padding:10px 14px;border-bottom:1px solid #2a2a4a;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:12px;">
              <div>
                <strong style="color:#fff;">${weekLabel(h.weekStart)}</strong>
                <span style="color:#888;font-size:11px;margin-left:6px;">${h.weekStart}</span>
                ${submitted ? '<span style="color:#81c784;font-size:10px;margin-left:6px;">✓</span>' : '<span style="color:#ffa726;font-size:10px;margin-left:6px;">draft</span>'}
              </div>
              <div style="color:#aaa;">${a.done}/${a.total} 완료 · <strong style="color:#ffb74d;">${a.completionPct}%</strong></div>
            </div>`;
          }).join('') || '<div style="padding:20px;color:#666;text-align:center;font-size:12px;">아직 지난 기록이 없습니다.</div>'}
        </div>
      </div>
    `;
  }

  function renderItemsHtml(items) {
    if (!items || items.length === 0) {
      return '<div style="padding:16px;color:#666;text-align:center;font-size:12px;">계획 항목이 없습니다. "+ 계획 추가"로 시작하세요.</div>';
    }
    const statusColors = { pending: '#888', in_progress: '#64b5f6', done: '#81c784', dropped: '#e94560' };
    const priorityColors = { high: '#e94560', normal: '#888', low: '#555' };
    return items.map((it, idx) => `
      <div style="padding:8px 10px;background:#0f0f23;border-radius:6px;margin-bottom:5px;${it.status === 'done' ? 'opacity:0.6;' : ''}">
        <div style="display:grid;grid-template-columns:2fr 80px 100px 40px;gap:6px;align-items:center;">
          <div>
            <input type="text" value="${esc(it.title || '')}" placeholder="무엇을 할 것인지..." oninput="pmcWeekly.updateItem(${idx}, 'title', this.value)" onblur="pmcWeekly.saveItems()" style="width:100%;padding:5px 8px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#fff;font-size:12px;${it.status === 'done' ? 'text-decoration:line-through;' : ''}">
            ${it.sourceMeetingId ? `<span title="회의에서 배포된 항목" style="display:inline-block;margin-top:3px;padding:1px 6px;background:#2a3a5a;color:#aac;border-radius:8px;font-size:10px;">📅 회의</span>` : ''}
            ${it.notes ? `<div style="color:#888;font-size:10px;margin-top:2px;white-space:pre-wrap;">${esc(it.notes)}</div>` : ''}
          </div>
          <select onchange="pmcWeekly.updateItem(${idx}, 'priority', this.value); pmcWeekly.saveItems();" style="padding:5px;background:#1a1a2e;border:1px solid ${priorityColors[it.priority]};border-radius:3px;color:#fff;font-size:11px;">
            <option value="high" ${it.priority === 'high' ? 'selected' : ''}>🔥 높음</option>
            <option value="normal" ${it.priority === 'normal' ? 'selected' : ''}>보통</option>
            <option value="low" ${it.priority === 'low' ? 'selected' : ''}>낮음</option>
          </select>
          <select onchange="pmcWeekly.updateItem(${idx}, 'status', this.value); pmcWeekly.saveItems();" style="padding:5px;background:#1a1a2e;border:1px solid ${statusColors[it.status]};border-radius:3px;color:#fff;font-size:11px;">
            <option value="pending" ${it.status === 'pending' ? 'selected' : ''}>⏳ 대기</option>
            <option value="in_progress" ${it.status === 'in_progress' ? 'selected' : ''}>▶ 진행중</option>
            <option value="done" ${it.status === 'done' ? 'selected' : ''}>✓ 완료</option>
            <option value="dropped" ${it.status === 'dropped' ? 'selected' : ''}>✕ 포기</option>
          </select>
          <button type="button" onclick="pmcWeekly.removeItem(${idx})" style="background:transparent;border:0;color:#e94560;cursor:pointer;font-size:14px;">🗑</button>
        </div>
        ${(it.status === 'done' || it.status === 'dropped') ? `
          <input type="text" value="${esc(it.result || '')}" placeholder="결과/노트 (선택)" oninput="pmcWeekly.updateItem(${idx}, 'result', this.value)" onblur="pmcWeekly.saveItems()" style="margin-top:4px;width:100%;padding:5px 8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:3px;color:#ccc;font-size:11px;">
        ` : ''}
      </div>
    `).join('');
  }

  function addItem() {
    current.items = current.items || [];
    current.items.push({
      id: Math.random().toString(36).slice(2, 10),
      title: '', priority: 'normal', status: 'pending',
      createdAt: new Date().toISOString(),
    });
    document.getElementById('wp-items-host').innerHTML = renderItemsHtml(current.items);
  }

  function removeItem(idx) {
    current.items.splice(idx, 1);
    document.getElementById('wp-items-host').innerHTML = renderItemsHtml(current.items);
    saveItems();
  }

  function updateItem(idx, field, value) {
    if (!current.items[idx]) return;
    current.items[idx][field] = value;
    // status 바꾸면 rerender (result 입력창 조건부 표시)
    if (field === 'status') {
      document.getElementById('wp-items-host').innerHTML = renderItemsHtml(current.items);
    }
  }

  let saveItemsTimer = null;
  async function saveItems() {
    if (saveItemsTimer) clearTimeout(saveItemsTimer);
    saveItemsTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/weekly-plans/' + current.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: current.items }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || '저장 실패');
        current = j.data;
      } catch (e) {
        console.warn('items save fail:', e.message);
      }
    }, 400);
  }

  async function saveReflection() {
    try {
      const payload = {
        reflectionWins: document.getElementById('wp-wins').value,
        reflectionBlockers: document.getElementById('wp-blockers').value,
        reflectionNextWeek: document.getElementById('wp-next').value,
      };
      const res = await fetch('/api/weekly-plans/' + current.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (res.ok) current = j.data;
    } catch {}
  }

  async function setStatus(s) {
    if (s === 'submitted' && !confirm('이번주 계획을 제출합니다. 계속할까요? (이후 수정 재개 가능)')) return;
    const res = await fetch('/api/weekly-plans/' + current.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: s }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refreshSelf(current.weekStart);
  }

  function jumpWeek() {
    const picked = document.getElementById('wp-week-picker').value;
    const ws = weekStartOf(picked);
    refreshSelf(ws);
  }

  function jumpWeekTo(ws) {
    refreshSelf(ws);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─── ADMIN: 월별 KPI ───
  async function refreshAdmin(month) {
    if (!user.isAdmin) return;
    adminMonth = month || adminMonth || thisMonth();
    const host = document.getElementById('wp-admin-view');
    host.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">로딩…</div>';
    try {
      const res = await fetch('/api/weekly-plans/kpi?month=' + adminMonth);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '로드 실패');
      kpiData = j.data;
      renderAdmin();
    } catch (e) {
      host.innerHTML = `<div style="padding:20px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
    }
  }

  function renderAdmin() {
    const host = document.getElementById('wp-admin-view');
    const d = kpiData;
    if (!d) return;
    const perStaff = d.perStaff || [];
    const maxDone = perStaff.reduce((m, s) => Math.max(m, s.itemsDone), 0) || 1;

    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div>
            <h3 style="color:#fff;font-size:14px;margin:0;">📊 ${adminMonth} 월별 주간업무 KPI</h3>
            <div style="color:#888;font-size:12px;margin-top:2px;">전 직원 주간 플랜 집계 · ${perStaff.reduce((s, x) => s + x.weekCount, 0)}주 · 총 ${perStaff.reduce((s, x) => s + x.itemsTotal, 0)}건</div>
          </div>
          <input type="month" value="${adminMonth}" onchange="pmcWeekly.refreshAdmin(this.value)" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
        </div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        ${perStaff.length === 0 ? `
          <div style="padding:30px;text-align:center;color:#666;font-size:12px;">이 월에 등록된 주간 플랜이 없습니다.</div>
        ` : `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead style="background:#0f0f23;">
              <tr>
                <th style="padding:10px;text-align:left;">직원</th>
                <th style="padding:10px;text-align:center;">담당</th>
                <th style="padding:10px;text-align:right;">주 수</th>
                <th style="padding:10px;text-align:right;">제출</th>
                <th style="padding:10px;text-align:right;">총 계획</th>
                <th style="padding:10px;text-align:right;">완료</th>
                <th style="padding:10px;text-align:right;">진행중</th>
                <th style="padding:10px;text-align:right;">포기</th>
                <th style="padding:10px;text-align:left;">달성률</th>
                <th style="padding:10px;"></th>
              </tr>
            </thead>
            <tbody>
              ${perStaff.map(s => {
                const pct = s.completionPct;
                const color = pct >= 80 ? '#4caf50' : pct >= 50 ? '#ffb74d' : pct >= 25 ? '#ff9800' : '#e94560';
                return `<tr style="border-bottom:1px solid #2a2a4a;">
                  <td style="padding:8px 10px;color:#fff;"><strong>${esc(s.displayName)}</strong></td>
                  <td style="padding:8px 10px;text-align:center;color:#aaa;">${esc(s.platform || '-')}</td>
                  <td style="padding:8px 10px;text-align:right;">${s.weekCount}</td>
                  <td style="padding:8px 10px;text-align:right;color:${s.submittedCount === s.weekCount && s.weekCount > 0 ? '#81c784' : '#aaa'};">${s.submittedCount}/${s.weekCount}</td>
                  <td style="padding:8px 10px;text-align:right;">${s.itemsTotal}</td>
                  <td style="padding:8px 10px;text-align:right;color:#81c784;">${s.itemsDone}</td>
                  <td style="padding:8px 10px;text-align:right;color:#64b5f6;">${s.itemsInProgress}</td>
                  <td style="padding:8px 10px;text-align:right;color:#aaa;">${s.itemsDropped}</td>
                  <td style="padding:8px 10px;min-width:140px;">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="flex:1;height:8px;background:#0f0f23;border-radius:4px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:${color};"></div>
                      </div>
                      <span style="color:${color};font-weight:600;min-width:36px;text-align:right;">${pct}%</span>
                    </div>
                  </td>
                  <td style="padding:8px 10px;text-align:right;">
                    <button type="button" onclick="pmcWeekly.viewStaff(${s.userId}, '${esc(s.displayName)}')" style="padding:4px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">주간 보기</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>

      <div id="wp-staff-weeks" style="margin-top:12px;"></div>
    `;
  }

  async function viewStaff(userId, displayName) {
    const host = document.getElementById('wp-staff-weeks');
    host.innerHTML = '<div style="padding:20px;color:#888;">로딩…</div>';
    try {
      const res = await fetch(`/api/weekly-plans?userId=${userId}&limit=12`);
      const j = await res.json();
      const rows = j.data || [];
      if (rows.length === 0) {
        host.innerHTML = `<div style="padding:20px;color:#666;text-align:center;">${esc(displayName)} 기록이 없습니다.</div>`;
        return;
      }
      host.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
          <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;color:#fff;font-size:13px;">${esc(displayName)} 의 주간 기록</div>
          ${rows.map(r => {
            const a = r.agg || { completionPct: 0, done: 0, total: 0 };
            return `<div style="padding:8px 14px;border-bottom:1px solid #2a2a4a;">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                <strong style="color:#fff;">${weekLabel(r.weekStart)}</strong>
                <span style="color:${r.status === 'submitted' ? '#81c784' : '#ffa726'};font-size:10px;">${r.status === 'submitted' ? '✓ 제출' : 'draft'}</span>
              </div>
              <div style="color:#aaa;font-size:11px;">${a.done}/${a.total} 완료 · ${a.completionPct}%${r.reflectionWins ? ' · 회고 있음' : ''}</div>
            </div>`;
          }).join('')}
        </div>
      `;
    } catch (e) {
      host.innerHTML = `<div style="padding:20px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
    }
  }

  // ─── MEETINGS (admin): 2주 주기 회의 + AI 액션아이템 → 주간 플랜 자동 배포 ───
  async function loadStaff() {
    if (staffCache) return staffCache;
    try {
      const r = await fetch('/api/users/staff');
      const j = await r.json();
      staffCache = (j.data || []).map(u => ({
        id: u.id,
        displayName: u.displayName || u.display_name,
        platform: u.platform || null,
      }));
    } catch {
      staffCache = [];
    }
    return staffCache;
  }

  async function refreshMeetings() {
    const host = document.getElementById('wp-meetings-view');
    host.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">로딩…</div>';
    try {
      const [mRes] = await Promise.all([fetch('/api/weekly-meetings?limit=30'), loadStaff()]);
      const j = await mRes.json();
      if (!mRes.ok) throw new Error(j.error || '로드 실패');
      meetingsList = j.data || [];
      renderMeetings();
    } catch (e) {
      host.innerHTML = `<div style="padding:20px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
    }
  }

  function statusBadge(s) {
    const map = {
      draft: { bg: '#555', txt: 'draft' },
      extracted: { bg: '#64b5f6', txt: 'AI 분석됨' },
      distributed: { bg: '#4caf50', txt: '✓ 배포됨' },
    };
    const m = map[s] || map.draft;
    return `<span style="padding:2px 8px;background:${m.bg};color:#fff;border-radius:10px;font-size:10px;">${m.txt}</span>`;
  }

  function renderMeetings() {
    const host = document.getElementById('wp-meetings-view');
    const todayMonday = weekStartOf();
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px;">
          <div>
            <h3 style="color:#fff;font-size:14px;margin:0;">📅 주간 회의 (2주 주기)</h3>
            <div style="color:#888;font-size:12px;margin-top:2px;">회의록 요약 → AI가 직원별 액션아이템 추출 → 주간 플랜에 자동 배포.</div>
          </div>
          <button type="button" onclick="pmcWeekly.newMeeting('${todayMonday}')" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">+ 새 회의</button>
        </div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:hidden;">
        ${meetingsList.length === 0 ? `
          <div style="padding:30px;text-align:center;color:#666;font-size:12px;">등록된 회의가 없습니다. "+ 새 회의"로 시작하세요.</div>
        ` : meetingsList.map(m => {
          const ai = (m.actionItems || []).length;
          return `<div style="padding:12px 14px;border-bottom:1px solid #2a2a4a;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
              <div style="flex:1;min-width:200px;">
                <div style="color:#fff;font-size:13px;font-weight:600;">
                  ${esc(m.title || '(제목 없음)')} ${statusBadge(m.status)}
                  <span style="color:#888;font-weight:400;font-size:11px;margin-left:6px;">${m.meetingDate} · 주기 ${m.cycleWeeks}주 · 액션 ${ai}건</span>
                </div>
                ${m.summary ? `<div style="color:#aaa;font-size:11px;margin-top:3px;white-space:pre-wrap;max-height:50px;overflow:hidden;">${esc(m.summary.slice(0, 200))}${m.summary.length > 200 ? '…' : ''}</div>` : ''}
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;">
                <button type="button" onclick="pmcWeekly.openMeeting(${m.id})" style="padding:5px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">편집</button>
                ${m.status === 'distributed' ? '' : `<button type="button" onclick="pmcWeekly.distributeMeeting(${m.id})" style="padding:5px 10px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✓ 배포</button>`}
                <button type="button" onclick="pmcWeekly.deleteMeeting(${m.id})" style="padding:5px 10px;background:transparent;border:1px solid #e94560;border-radius:4px;color:#e94560;cursor:pointer;font-size:11px;">🗑</button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  function newMeeting(defaultDate) {
    activeMeeting = {
      id: null,
      meetingDate: defaultDate || weekStartOf(),
      cycleWeeks: 2,
      title: '',
      summary: '',
      rawNotes: '',
      actionItems: [],
      status: 'draft',
    };
    renderMeetingModal();
  }

  async function openMeeting(id) {
    try {
      const r = await fetch('/api/weekly-meetings/' + id);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '로드 실패');
      activeMeeting = j.data;
      renderMeetingModal();
    } catch (e) {
      alert('실패: ' + e.message);
    }
  }

  function closeMeetingModal() {
    activeMeeting = null;
    document.getElementById('wp-meeting-modal').innerHTML = '';
  }

  function renderMeetingModal() {
    const host = document.getElementById('wp-meeting-modal');
    if (!activeMeeting) { host.innerHTML = ''; return; }
    const m = activeMeeting;
    const staff = staffCache || [];
    const aiItems = m.actionItems || [];
    host.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;" onclick="if(event.target===this)pmcWeekly.closeMeetingModal()">
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:1100px;width:100%;max-height:92vh;overflow:auto;padding:18px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h3 style="color:#fff;font-size:16px;margin:0;">📅 ${m.id ? '회의 편집' : '새 회의'}</h3>
            <button type="button" onclick="pmcWeekly.closeMeetingModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:10px;">
            <div>
              <label style="font-size:11px;color:#888;">회의 날짜</label>
              <input type="date" id="mm-date" value="${m.meetingDate}" style="width:100%;padding:6px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            </div>
            <div>
              <label style="font-size:11px;color:#888;">주기</label>
              <select id="mm-cycle" style="width:100%;padding:6px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
                <option value="2" ${m.cycleWeeks === 2 ? 'selected' : ''}>2주 (이번주 + 다음주)</option>
                <option value="1" ${m.cycleWeeks === 1 ? 'selected' : ''}>1주 (이번주만)</option>
              </select>
            </div>
            <div style="grid-column:1/-1;">
              <label style="font-size:11px;color:#888;">제목</label>
              <input type="text" id="mm-title" value="${esc(m.title || '')}" placeholder="예: 4월 2주차 회의" style="width:100%;padding:6px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <div>
              <label style="font-size:11px;color:#888;">회의 요약</label>
              <textarea id="mm-summary" rows="6" placeholder="관리자가 정리한 요약 (AI가 읽음)" style="width:100%;padding:8px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;">${esc(m.summary || '')}</textarea>
            </div>
            <div>
              <label style="font-size:11px;color:#888;">원본 메모 (선택)</label>
              <textarea id="mm-raw" rows="6" placeholder="회의 중 기록한 원본 (AI가 읽음)" style="width:100%;padding:8px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;">${esc(m.rawNotes || '')}</textarea>
            </div>
          </div>

          <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">
            <button type="button" onclick="pmcWeekly.saveMeeting(false)" style="padding:7px 14px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">💾 저장</button>
            ${m.id ? `<button type="button" onclick="pmcWeekly.extractMeeting()" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">🤖 AI 액션아이템 추출</button>` : `<span style="padding:7px 0;color:#888;font-size:11px;">먼저 저장하면 AI 추출 가능</span>`}
            ${m.id && aiItems.length > 0 ? `<button type="button" onclick="pmcWeekly.distributeMeeting(${m.id}, true)" style="padding:7px 14px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ 주간 플랜에 배포</button>` : ''}
          </div>

          <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <h4 style="color:#fff;font-size:13px;margin:0;">📋 액션아이템 (${aiItems.length}건)</h4>
              <button type="button" onclick="pmcWeekly.addActionItem()" style="padding:4px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">+ 수동 추가</button>
            </div>
            <div id="mm-items-host">${renderActionItems(aiItems, staff)}</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderActionItems(items, staff) {
    if (!items || items.length === 0) {
      return '<div style="padding:16px;color:#666;text-align:center;font-size:12px;">아직 없습니다. "🤖 AI 추출" 또는 "수동 추가"로 시작하세요.</div>';
    }
    const pOpts = ['high', 'normal', 'low'].map(p => `<option value="${p}">${p === 'high' ? '🔥 높음' : p === 'normal' ? '보통' : '낮음'}</option>`).join('');
    const sOpts = staff.map(s => `<option value="${s.id}">${esc(s.displayName)}${s.platform ? ' (' + esc(s.platform) + ')' : ''}</option>`).join('');
    return items.map((it, idx) => {
      const pSel = pOpts.replace(`value="${it.priority || 'normal'}"`, `value="${it.priority || 'normal'}" selected`);
      const sSel = it.userId ? sOpts.replace(`value="${it.userId}"`, `value="${it.userId}" selected`) : sOpts;
      return `
        <div style="display:grid;grid-template-columns:150px 1fr 90px 40px;gap:6px;align-items:start;padding:6px 0;border-bottom:1px solid #2a2a4a;">
          <select onchange="pmcWeekly.updateActionItem(${idx}, 'userId', parseInt(this.value,10))" style="padding:5px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
            <option value="">— 담당자 —</option>${sSel}
          </select>
          <div>
            <input type="text" value="${esc(it.title || '')}" placeholder="할 일 제목" oninput="pmcWeekly.updateActionItem(${idx}, 'title', this.value)" style="width:100%;padding:5px 8px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:12px;">
            ${it.notes !== undefined && it.notes !== null ? `<input type="text" value="${esc(it.notes || '')}" placeholder="메모 (선택)" oninput="pmcWeekly.updateActionItem(${idx}, 'notes', this.value)" style="width:100%;margin-top:3px;padding:4px 8px;background:#0f0f23;border:1px solid #2a2a4a;border-radius:3px;color:#ccc;font-size:11px;">` : `<button type="button" onclick="pmcWeekly.updateActionItem(${idx}, 'notes', ''); pmcWeekly.rerenderActionItems();" style="margin-top:3px;background:transparent;border:0;color:#888;font-size:10px;cursor:pointer;">+ 메모 추가</button>`}
          </div>
          <select onchange="pmcWeekly.updateActionItem(${idx}, 'priority', this.value)" style="padding:5px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">${pSel}</select>
          <button type="button" onclick="pmcWeekly.removeActionItem(${idx})" style="background:transparent;border:0;color:#e94560;cursor:pointer;font-size:14px;">🗑</button>
        </div>
      `;
    }).join('');
  }

  function addActionItem() {
    activeMeeting.actionItems = activeMeeting.actionItems || [];
    activeMeeting.actionItems.push({
      id: Math.random().toString(36).slice(2, 10),
      userId: null, userName: null, title: '', priority: 'normal', notes: null,
    });
    rerenderActionItems();
  }

  function removeActionItem(idx) {
    activeMeeting.actionItems.splice(idx, 1);
    rerenderActionItems();
  }

  function updateActionItem(idx, field, value) {
    if (!activeMeeting.actionItems[idx]) return;
    activeMeeting.actionItems[idx][field] = value;
    if (field === 'userId') {
      const st = (staffCache || []).find(s => s.id === value);
      activeMeeting.actionItems[idx].userName = st ? st.displayName : null;
    }
  }

  function rerenderActionItems() {
    const host = document.getElementById('mm-items-host');
    if (host) host.innerHTML = renderActionItems(activeMeeting.actionItems || [], staffCache || []);
  }

  function collectFormPatch() {
    return {
      meetingDate: document.getElementById('mm-date').value,
      cycleWeeks: parseInt(document.getElementById('mm-cycle').value, 10),
      title: document.getElementById('mm-title').value,
      summary: document.getElementById('mm-summary').value,
      rawNotes: document.getElementById('mm-raw').value,
      actionItems: activeMeeting.actionItems || [],
    };
  }

  async function saveMeeting(silent) {
    const patch = collectFormPatch();
    Object.assign(activeMeeting, patch);
    try {
      let r, j;
      if (activeMeeting.id) {
        r = await fetch('/api/weekly-meetings/' + activeMeeting.id, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } else {
        r = await fetch('/api/weekly-meetings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      }
      j = await r.json();
      if (!r.ok) throw new Error(j.error || '저장 실패');
      activeMeeting = j.data;
      if (!silent) alert('저장되었습니다.');
      renderMeetingModal();
      refreshMeetings();
      return activeMeeting;
    } catch (e) {
      alert('실패: ' + e.message);
      throw e;
    }
  }

  async function extractMeeting() {
    await saveMeeting(true);
    if (!activeMeeting || !activeMeeting.id) return;
    const host = document.getElementById('mm-items-host');
    if (host) host.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">🤖 AI 분석 중… (10~30초 소요)</div>';
    try {
      const r = await fetch('/api/weekly-meetings/' + activeMeeting.id + '/extract', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'AI 실패');
      activeMeeting = j.data;
      renderMeetingModal();
      refreshMeetings();
    } catch (e) {
      alert('AI 추출 실패: ' + e.message);
      rerenderActionItems();
    }
  }

  async function distributeMeeting(id, fromModal) {
    if (!confirm('이 회의의 액션아이템을 각 직원 주간 플랜에 배포합니다. 계속할까요?')) return;
    if (fromModal) await saveMeeting(true);
    try {
      const r = await fetch('/api/weekly-meetings/' + id + '/distribute', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '배포 실패');
      alert(`✓ 배포 완료: ${j.distributedUsers}명 · ${j.distributedItems}건 · 대상 주 ${j.weeks.join(', ')}`);
      if (fromModal && activeMeeting) activeMeeting = j.meeting;
      if (fromModal) renderMeetingModal();
      refreshMeetings();
    } catch (e) {
      alert('실패: ' + e.message);
    }
  }

  async function deleteMeeting(id) {
    if (!confirm('이 회의를 삭제합니다. (이미 배포된 주간 플랜 항목은 남음)')) return;
    try {
      const r = await fetch('/api/weekly-meetings/' + id, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || '실패');
      refreshMeetings();
    } catch (e) {
      alert('실패: ' + e.message);
    }
  }

  window.pmcWeekly = {
    load, switchView, refreshSelf, refreshAdmin,
    addItem, removeItem, updateItem, saveItems, saveReflection, setStatus,
    jumpWeek, jumpWeekTo, viewStaff,
    refreshMeetings, newMeeting, openMeeting, closeMeetingModal, saveMeeting,
    extractMeeting, distributeMeeting, deleteMeeting,
    addActionItem, removeActionItem, updateActionItem, rerenderActionItems,
  };
})();
