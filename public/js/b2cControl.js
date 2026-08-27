/**
 * b2cControl.js — B2C · Phase 7 · Control Panel (admin).
 *   · config 상태 (Scheduler / Auto Assignment / DQ Auto — 모두 OFF default)
 *   · Active Tasks 카운트
 *   · Pilot Preview / Activate / Refill preview / Refill execute (API 호출 얇은 UI)
 *   · Scheduler ON 은 disabled + 경고 · Phase 7 에서는 UI 로 못 켬
 */
(function () {
  let state = null;
  let readiness = null;
  let operators = [];
  //   Phase 8P-W1-HOTFIX1 · Active B2C Tasks
  let activeTasks = null;
  let taskFilters = { status: '', assignee_id: '', channel: '', sku_search: '' };

  function esc(s) { if (s==null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const YES = v => v ? '<span style="color:#69f0ae;font-weight:700;">ON</span>' : '<span style="color:#ef9a9a;font-weight:700;">OFF</span>';

  async function load() {
    const page = document.getElementById('page-b2c-control');
    if (!page) return;
    page.innerHTML = '<div style="padding:20px;color:#888;">로딩 중…</div>';
    try {
      const [stateJ, readyJ, opsJ, tasksJ] = await Promise.all([
        fetch('/api/b2c/work/control/state').then(r => r.json()),
        fetch('/api/b2c/work/pilot/readiness').then(r => r.json()),
        fetch('/api/b2c/work/operators').then(r => r.json()),
        loadActiveTasks(),
      ]);
      state = stateJ.data; readiness = readyJ.data; operators = opsJ.data?.users || [];
      activeTasks = tasksJ;
      render();
    } catch (e) {
      page.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  //   Phase 8P-W1-HOTFIX1 · Active B2C Tasks
  async function loadActiveTasks() {
    const params = new URLSearchParams();
    if (taskFilters.status)      params.set('status', taskFilters.status);
    if (taskFilters.assignee_id) params.set('assignee_id', taskFilters.assignee_id);
    if (taskFilters.channel)     params.set('channel', taskFilters.channel);
    if (taskFilters.sku_search)  params.set('sku_search', taskFilters.sku_search);
    const url = '/api/b2c/work/tasks/active' + (params.toString() ? '?' + params : '');
    const r = await fetch(url).then(r => r.json());
    return r.data || null;
  }

  function render() {
    const page = document.getElementById('page-b2c-control');
    if (!page) return;
    const cfg = state.config;
    const cr = state.channel_register;
    const dq = state.data_quality;

    const cfgHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">
        ${cfgCard('Scheduler', cfg.scheduler_enabled, true)}
        ${cfgCard('Auto Assignment', cfg.auto_assignment_enabled, false)}
        ${cfgCard('DQ Auto', cfg.data_quality_auto_enabled, false)}
        ${cfgCard('Default Eligibility Mode', cfg.default_eligibility_mode, false, cfg.default_eligibility_mode === 1 ? 'KOREA_ALL' : 'NONE')}
      </div>
      <div style="margin-top:12px;padding:12px 14px;background:#4a1a1a;border-left:4px solid #c62828;border-radius:4px;color:#ffcdd2;font-size:12px;">
        ⚠ Phase 7 에서는 Scheduler ON 은 UI 로 켤 수 없습니다. Pilot 검증 후 별도 SQL / API 로 Owner 명시 액션.
      </div>`;

    const activeHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px;">
        ${statCard('CHANNEL_REGISTER · Active', cr.active_total, '#0277bd')}
        ${statCard('Pending', cr.pending, '#546e7a')}
        ${statCard('In Progress', cr.in_progress, '#f9a825')}
        ${statCard('QC Pending', cr.qc_pending, '#0288d1')}
        ${statCard('Blocked', cr.blocked, '#4a1a1a')}
        ${statCard('Done Today', cr.done_today, '#2e7d32')}
        ${statCard('DATA_QUALITY · Active', dq.active_total, '#7b1fa2')}
      </div>`;

    const readyHtml = readiness ? `
      <div style="margin-top:20px;padding:14px;background:#0f0f23;border-radius:6px;">
        <div style="display:flex;justify-content:space-between;">
          <h3 style="color:#aaa;margin:0;">🚦 Pilot Readiness</h3>
          <span style="padding:4px 10px;background:${readiness.ready ? '#2e7d32' : '#c62828'};color:#fff;border-radius:12px;font-size:11px;font-weight:700;">
            ${readiness.ready ? 'READY' : 'BLOCKED'}
          </span>
        </div>
        <div style="margin-top:10px;color:#e0e0e0;font-size:13px;">
          <div>Pilot size 요청: ${readiness.pilot_size} · matched SKU ${readiness.pilot_preview_matched} · 예상 Task ${readiness.expected_channel_tasks} / pilot_max ${readiness.pilot_max_tasks}</div>
          <div>b2c_operator=true 직원: ${readiness.b2c_operators}</div>
          <div>현재 활성 CHANNEL_REGISTER task: ${readiness.active_b2c_channel_register_tasks}</div>
        </div>
        ${(readiness.blocking||[]).length ? `<div style="margin-top:10px;color:#ef9a9a;font-size:12px;">🔴 BLOCKING: ${(readiness.blocking||[]).map(b => esc(b.message||b.code)).join(' · ')}</div>` : ''}
        ${(readiness.warnings||[]).length ? `<div style="margin-top:6px;color:#ffcc80;font-size:12px;">⚠ WARNINGS: ${(readiness.warnings||[]).map(w => esc(w.message||w.code)).join(' · ')}</div>` : ''}
      </div>` : '';

    const actionsHtml = `
      <div style="margin-top:20px;padding:14px;background:#0f0f23;border-radius:6px;">
        <h3 style="color:#aaa;margin:0 0 10px 0;">🎬 Pilot Actions</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="b2c-ctl-pilot-preview" style="padding:8px 14px;background:#0277bd;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">Pilot Preview (50)</button>
          <button id="b2c-ctl-pilot-activate" style="padding:8px 14px;background:#4a1a1a;border:none;border-radius:4px;color:#ffcdd2;cursor:pointer;font-size:12px;" title="반드시 Preview 확인 후 실행">Pilot Activate (50) ⚠</button>
          <button id="b2c-ctl-refill-preview" style="padding:8px 14px;background:#0277bd;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">Queue Preview (max 100)</button>
          <button id="b2c-ctl-refill-execute" style="padding:8px 14px;background:#4a1a1a;border:none;border-radius:4px;color:#ffcdd2;cursor:pointer;font-size:12px;">Queue Execute (max 100) ⚠</button>
        </div>
        <div style="margin-top:10px;padding:10px;background:#0a0a1a;border-radius:4px;max-height:400px;overflow:auto;">
          <pre id="b2c-ctl-output" style="margin:0;color:#a0a0a0;font-size:11px;white-space:pre-wrap;">(액션 실행 결과가 여기 표시됩니다)</pre>
        </div>
      </div>`;

    const opsHtml = `
      <div style="margin-top:20px;padding:14px;background:#0f0f23;border-radius:6px;">
        <h3 style="color:#aaa;margin:0 0 10px 0;">👥 B2C Operators (${operators.length}명 · 활성 직원)</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#aaa;background:#1a1a2e;">
            <th style="padding:6px;text-align:left;">id</th>
            <th style="padding:6px;text-align:left;">username</th>
            <th style="padding:6px;text-align:left;">role</th>
            <th style="padding:6px;text-align:center;">b2c_operator</th>
            <th style="padding:6px;text-align:left;">b2c_channels</th>
            <th style="padding:6px;">Toggle</th>
          </tr></thead>
          <tbody>${operators.map(u => `
            <tr style="border-top:1px solid #2a2a4a;">
              <td style="padding:6px;color:#fff;">${u.id}</td>
              <td style="padding:6px;color:#81d4fa;font-family:monospace;">${esc(u.username)}</td>
              <td style="padding:6px;color:#aaa;">${esc(u.role)}</td>
              <td style="padding:6px;text-align:center;">${u.b2c_operator ? '✅' : '—'}</td>
              <td style="padding:6px;color:#ccc;font-family:monospace;font-size:11px;">${esc(JSON.stringify(u.b2c_channels))}</td>
              <td style="padding:6px;text-align:center;">
                <button data-op-uid="${u.id}" data-op-flip="${u.b2c_operator ? 'false' : 'true'}" style="padding:4px 10px;background:${u.b2c_operator ? '#4a1a1a' : '#0277bd'};border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">${u.b2c_operator ? 'OFF' : 'ON'}</button>
                <button data-op-uid="${u.id}" data-op-channels="korea" style="padding:4px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;margin-left:4px;" title="채널 = coupang,naver,11st,gmarket">Korea4</button>
                <button data-op-uid="${u.id}" data-op-channels="null" style="padding:4px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;margin-left:4px;" title="채널 = null (모든 B2C 채널)">All</button>
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

    const tasksHtml = renderActiveTasks();

    page.innerHTML = `
      <div style="padding:20px;">
        <h2 style="color:#fff;margin-bottom:16px;">🎛 B2C Control Panel</h2>
        ${cfgHtml}
        ${activeHtml}
        ${readyHtml}
        ${actionsHtml}
        ${opsHtml}
        ${tasksHtml}
      </div>`;
    attachEvents();
    attachTaskFilterEvents();
  }

  //   Phase 8P-W1-HOTFIX1 · Active B2C Tasks section renderer
  function renderActiveTasks() {
    if (!activeTasks) return '';
    const s = activeTasks.summary || {};
    const items = activeTasks.items || [];
    const dropdowns = activeTasks.dropdowns || { statuses: [], channels: [], assignees: [] };

    const summaryStrip = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px;">
        ${statCard('Pending',      s.pending || 0,      '#546e7a')}
        ${statCard('In Progress',  s.in_progress || 0,  '#f9a825')}
        ${statCard('QC Pending',   s.qc_pending || 0,   '#0277bd')}
        ${statCard('Passed Today', s.passed_today || 0, '#2e7d32')}
        ${statCard('Failed',       s.failed || 0,       '#c62828')}
        ${statCard('Blocked',      s.blocked || 0,      '#4a1a1a')}
      </div>`;

    const optHtml = (arr, cur) => arr.map(v => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const assigneeOpts = (dropdowns.assignees || []).map(a =>
      `<option value="${a.id}" ${String(taskFilters.assignee_id) === String(a.id) ? 'selected' : ''}>${esc(a.username || '#' + a.id)} (${a.id})</option>`
    ).join('');

    const filterHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;align-items:center;">
        <select id="b2c-tf-status" style="padding:6px 10px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
          <option value="">status: 전체</option>
          ${optHtml(dropdowns.statuses || [], taskFilters.status)}
        </select>
        <select id="b2c-tf-channel" style="padding:6px 10px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
          <option value="">channel: 전체</option>
          ${optHtml(dropdowns.channels || [], taskFilters.channel)}
        </select>
        <select id="b2c-tf-assignee" style="padding:6px 10px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
          <option value="">assignee: 전체</option>
          ${assigneeOpts}
        </select>
        <input id="b2c-tf-sku" type="text" placeholder="SKU / title 검색" value="${esc(taskFilters.sku_search || '')}" style="padding:6px 10px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;min-width:180px;">
        <button id="b2c-tf-apply" style="padding:6px 14px;background:#0277bd;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">필터 적용</button>
        <button id="b2c-tf-reset" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">초기화</button>
        <button id="b2c-tf-refresh" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">🔄 새로고침</button>
        <span style="margin-left:auto;color:#888;font-size:11px;">표시: ${items.length}건 · 30일 window B2C 총계: ${activeTasks.total_b2c_30d || 0}</span>
      </div>`;

    const statusBadge = (st) => {
      const c = { pending:'#546e7a', in_progress:'#f9a825', qc_pending:'#0277bd', done:'#2e7d32', blocked:'#4a1a1a', failed:'#4a148c' }[st] || '#333';
      return `<span style="padding:2px 8px;background:${c};color:#fff;border-radius:8px;font-size:10px;font-weight:700;">${esc(st)}</span>`;
    };
    const lvlBadge = (l) => {
      const c = { p0:'#c62828', p1:'#f9a825', p2:'#0277bd', p3:'#546e7a' }[l] || '#333';
      return l ? `<span style="padding:1px 6px;background:${c};color:#fff;border-radius:6px;font-size:10px;font-weight:800;">${esc(l.toUpperCase())}</span>` : '-';
    };
    const fmtTs = (iso) => iso ? new Date(iso).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const fmtAge = (sec) => {
      if (sec == null) return '-';
      if (sec < 60) return sec + '초';
      if (sec < 3600) return Math.round(sec/60) + '분';
      if (sec < 86400) return Math.round(sec/3600) + '시간';
      return Math.round(sec/86400) + '일';
    };

    const rowsHtml = items.length ? items.map(t => `
      <tr style="border-top:1px solid #2a2a4a;">
        <td style="padding:6px;color:#81d4fa;font-family:monospace;">${t.task_id}</td>
        <td style="padding:6px;">${lvlBadge(t.priority_level)}<div style="color:#888;font-size:9px;">${t.priority_score ?? '-'}</div></td>
        <td style="padding:6px;color:#fff;font-family:monospace;font-size:11px;">${esc(t.internal_sku || t.sku_master_id || '-')}</td>
        <td style="padding:6px;color:#e0e0e0;font-size:11px;max-width:220px;">${esc((t.sku_title || t.task_title || '').slice(0, 60))}</td>
        <td style="padding:6px;color:#fff;">${esc(t.channel || '-')}</td>
        <td style="padding:6px;color:#fff;font-size:11px;">${esc(t.assignee_username || (t.assignee_id ? '#' + t.assignee_id : '(unassigned)'))}${t.assignee_scope ? `<div style="color:#666;font-size:9px;">${esc(t.assignee_scope)}</div>` : ''}</td>
        <td style="padding:6px;">${statusBadge(t.status)}</td>
        <td style="padding:6px;color:#fff;font-size:11px;">${t.qc_status ? statusBadge(t.qc_status) : '-'}${t.qc_fail_reason ? `<div style="color:#ef9a9a;font-size:9px;margin-top:2px;">${esc(t.qc_fail_reason)}</div>` : ''}${t.blocked_reason ? `<div style="color:#ffcc80;font-size:9px;margin-top:2px;">${esc(t.blocked_reason)}</div>` : ''}</td>
        <td style="padding:6px;color:#888;font-size:10px;">${fmtTs(t.created_at)}</td>
        <td style="padding:6px;color:#888;font-size:10px;">${fmtTs(t.started_at)}</td>
        <td style="padding:6px;color:#888;font-size:10px;">${fmtTs(t.submitted_at)}</td>
        <td style="padding:6px;color:#ccc;font-size:10px;">age: ${fmtAge(t.age_seconds)}${t.elapsed_seconds != null ? `<div style="color:#888;">work: ${fmtAge(t.elapsed_seconds)}</div>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="12" style="padding:24px;text-align:center;color:#666;">현재 조건에 해당하는 active B2C task 없음</td></tr>`;

    return `
      <div style="margin-top:20px;padding:14px;background:#0f0f23;border-radius:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="color:#aaa;margin:0;">📋 Active B2C Tasks (READ-ONLY)</h3>
          <span style="color:#666;font-size:11px;">${esc(activeTasks.at ? new Date(activeTasks.at).toLocaleTimeString('ko-KR') : '')}</span>
        </div>
        ${summaryStrip}
        ${filterHtml}
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;background:#0a0a1a;">
            <thead><tr style="color:#aaa;background:#1a1a2e;">
              <th style="padding:6px;text-align:left;">task_id</th>
              <th style="padding:6px;text-align:left;">priority</th>
              <th style="padding:6px;text-align:left;">SKU</th>
              <th style="padding:6px;text-align:left;">title</th>
              <th style="padding:6px;text-align:left;">channel</th>
              <th style="padding:6px;text-align:left;">assignee</th>
              <th style="padding:6px;text-align:left;">status</th>
              <th style="padding:6px;text-align:left;">qc</th>
              <th style="padding:6px;text-align:left;">created</th>
              <th style="padding:6px;text-align:left;">started</th>
              <th style="padding:6px;text-align:left;">submitted</th>
              <th style="padding:6px;text-align:left;">age</th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>`;
  }

  function attachTaskFilterEvents() {
    const apply = document.getElementById('b2c-tf-apply');
    const reset = document.getElementById('b2c-tf-reset');
    const refresh = document.getElementById('b2c-tf-refresh');
    if (apply) apply.addEventListener('click', async () => {
      taskFilters = {
        status:      document.getElementById('b2c-tf-status')?.value || '',
        assignee_id: document.getElementById('b2c-tf-assignee')?.value || '',
        channel:     document.getElementById('b2c-tf-channel')?.value || '',
        sku_search:  document.getElementById('b2c-tf-sku')?.value?.trim() || '',
      };
      activeTasks = await loadActiveTasks();
      render();
    });
    if (reset) reset.addEventListener('click', async () => {
      taskFilters = { status: '', assignee_id: '', channel: '', sku_search: '' };
      activeTasks = await loadActiveTasks();
      render();
    });
    if (refresh) refresh.addEventListener('click', async () => {
      activeTasks = await loadActiveTasks();
      render();
    });
  }

  function cfgCard(label, value, isSchedule, valueLabel) {
    const on = Number(value) === 1;
    return `<div style="padding:12px;background:#0f0f23;border-left:3px solid ${on ? '#c62828' : '#2e7d32'};border-radius:4px;">
      <div style="font-size:10px;color:#888;">${esc(label)}</div>
      <div style="margin-top:4px;font-size:14px;">${valueLabel ? esc(valueLabel) : YES(on)}</div>
      ${isSchedule && on ? '<div style="margin-top:4px;color:#ffcdd2;font-size:10px;">⚠ 자동 실행 중</div>' : ''}
    </div>`;
  }
  function statCard(label, value, color) {
    return `<div style="padding:12px;background:#0f0f23;border-left:3px solid ${color};border-radius:4px;">
      <div style="font-size:10px;color:#888;">${esc(label)}</div>
      <div style="font-size:22px;color:${color};font-weight:800;margin-top:2px;">${value}</div>
    </div>`;
  }

  function attachEvents() {
    document.getElementById('b2c-ctl-pilot-preview')?.addEventListener('click', () => callAndShow('/api/b2c/tasks/pilot/preview', { size: 50 }));
    document.getElementById('b2c-ctl-pilot-activate')?.addEventListener('click', () => {
      if (!confirm('실제 sku_master.channel_eligibility 를 UPDATE 합니다. 계속?')) return;
      callAndShow('/api/b2c/tasks/pilot/activate', { size: 50 });
    });
    document.getElementById('b2c-ctl-refill-preview')?.addEventListener('click', () => callAndShow('/api/b2c/tasks/channel-register/refill/preview', { pilot_max_tasks: 100 }));
    document.getElementById('b2c-ctl-refill-execute')?.addEventListener('click', () => {
      if (!confirm('실제 team_tasks INSERT 를 수행합니다. 계속?')) return;
      callAndShow('/api/b2c/tasks/channel-register/refill', { pilot_max_tasks: 100 });
    });
    document.querySelectorAll('button[data-op-uid]').forEach(b => b.addEventListener('click', onOpToggle));
  }

  async function onOpToggle(e) {
    const btn = e.currentTarget;
    const uid = btn.dataset.opUid;
    const body = {};
    if (btn.dataset.opFlip) body.b2c_operator = btn.dataset.opFlip === 'true';
    if (btn.dataset.opChannels === 'korea') body.b2c_channels = ['coupang','naver','11st','gmarket'];
    if (btn.dataset.opChannels === 'null')  body.b2c_channels = null;
    try {
      const r = await fetch(`/api/b2c/work/operators/${uid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      load();
    } catch (err) { alert('실패: ' + err.message); }
  }

  async function callAndShow(url, body) {
    const out = document.getElementById('b2c-ctl-output');
    out.textContent = '⏳ 실행 중...';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      out.textContent = JSON.stringify(j, null, 2);
      load();
    } catch (e) {
      out.textContent = 'ERROR: ' + e.message;
    }
  }

  window.pmcB2cControl = { load };
})();
