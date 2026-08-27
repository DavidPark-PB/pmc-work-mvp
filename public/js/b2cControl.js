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

  function esc(s) { if (s==null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const YES = v => v ? '<span style="color:#69f0ae;font-weight:700;">ON</span>' : '<span style="color:#ef9a9a;font-weight:700;">OFF</span>';

  async function load() {
    const page = document.getElementById('page-b2c-control');
    if (!page) return;
    page.innerHTML = '<div style="padding:20px;color:#888;">로딩 중…</div>';
    try {
      const [stateJ, readyJ, opsJ] = await Promise.all([
        fetch('/api/b2c/work/control/state').then(r => r.json()),
        fetch('/api/b2c/work/pilot/readiness').then(r => r.json()),
        fetch('/api/b2c/work/operators').then(r => r.json()),
      ]);
      state = stateJ.data; readiness = readyJ.data; operators = opsJ.data?.users || [];
      render();
    } catch (e) {
      page.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
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

    page.innerHTML = `
      <div style="padding:20px;">
        <h2 style="color:#fff;margin-bottom:16px;">🎛 B2C Control Panel</h2>
        ${cfgHtml}
        ${activeHtml}
        ${readyHtml}
        ${actionsHtml}
        ${opsHtml}
      </div>`;
    attachEvents();
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
