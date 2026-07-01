/**
 * Hermes Phase 5G — Execution Request Read-Only UI.
 *
 * Operator-facing visibility panel backed only by Phase 5F GET endpoints.
 * No approve/reject/cancel controls, no execution controls, no DB writes, no marketplace writes.
 */
(function () {
  let user = null;
  let summary = null;
  let approvedList = [];
  let selectedId = null;
  let selectedDetail = null;
  let selectedEvents = null;

  function esc(value) {
    if (value == null) return '';
    return String(value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtDate(value) {
    return value ? new Date(value).toLocaleString('ko-KR') : '-';
  }

  function pretty(value) {
    return esc(JSON.stringify(value == null ? null : value, null, 2));
  }

  function badge(status) {
    const colors = {
      pending_approval: ['#5d3a00', '#ffb74d'],
      approved: ['#1b5e20', '#69f0ae'],
      dry_run_ready: ['#0d47a1', '#90caf9'],
      rejected: ['#4a1a1a', '#ef9a9a'],
      cancelled: ['#37474f', '#bdbdbd'],
      executed: ['#4a1a1a', '#ff8a80'],
      failed: ['#4a1a1a', '#ef5350'],
    };
    const [bg, fg] = colors[status] || ['#263238', '#bbdefb'];
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;font-family:monospace;">${esc(status || '?')}</span>`;
  }

  function boolPill(value) {
    const isTrue = value === true;
    return `<span style="background:${isTrue ? '#4a1a1a' : '#1b5e20'};color:${isTrue ? '#ef9a9a' : '#69f0ae'};padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;">${isTrue ? 'true' : 'false'}</span>`;
  }

  function metricCard(label, value, color) {
    return `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:10px;padding:12px;min-width:120px;">
        <div style="color:#90a4ae;font-size:10px;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
        <div style="color:${color || '#fff'};font-size:20px;font-weight:800;">${esc(value)}</div>
      </div>
    `;
  }

  function countCards(title, counts) {
    const entries = Object.entries(counts || {});
    if (entries.length === 0) return `<div style="color:#666;font-size:12px;">${esc(title)} 없음</div>`;
    return `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:12px;">
        <div style="color:#fff;font-size:13px;font-weight:700;margin-bottom:8px;">${esc(title)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${entries.map(([k, v]) => metricCard(k, v, k === 'approved' ? '#69f0ae' : '#fff')).join('')}
        </div>
      </div>
    `;
  }

  function rowSummary(row) {
    const external = row.external_action_executed === true || row.metadata?.external_action_executed === true;
    const marketplaceApproved = row.marketplace_execution_approved === true || row.metadata?.marketplace_execution_approved === true;
    return `
      <div class="her-row" data-id="${row.id}" style="padding:10px 12px;border:1px solid ${row.id === selectedId ? '#81d4fa' : '#2a2a4a'};border-radius:8px;margin-bottom:8px;background:${row.id === selectedId ? '#0a1a2e' : '#0f0f23'};cursor:pointer;">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
          ${badge(row.status)}
          <span style="background:#263238;color:#ce93d8;padding:2px 6px;border-radius:4px;font-size:10px;font-family:monospace;">${esc(row.execution_type || '-')}</span>
          <span style="color:#ffcc80;font-size:10px;font-family:monospace;">risk ${esc(row.risk_level || '-')}</span>
          <span style="margin-left:auto;color:#666;font-size:11px;">#${esc(row.id)}</span>
        </div>
        <div style="color:#fff;font-size:13px;line-height:1.35;margin-bottom:5px;">SKU ${esc(row.sku || '-')} · opportunity #${esc(row.opportunity_id || '-')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;color:#90a4ae;font-size:11px;">
          <span>actor: ${esc(row.final_approval_actor || row.approved_actor || row.rejected_actor || row.cancelled_actor || '-')}</span>
          <span>final approval: ${esc(row.final_approval_status || 'not_requested')}</span>
          <span>executed_at: ${esc(row.executed_at || 'null')}</span>
          <span>external: ${external ? 'true' : 'false'}</span>
          <span>marketplace approved: ${marketplaceApproved ? 'true' : 'false'}</span>
        </div>
      </div>
    `;
  }

  function sectionRows(title, rows, emptyText) {
    const list = Array.isArray(rows) ? rows : [];
    return `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div style="color:#fff;font-size:13px;font-weight:700;">${esc(title)}</div>
          <span style="color:#666;font-size:11px;">${list.length}건</span>
        </div>
        ${list.length ? list.map(rowSummary).join('') : `<div style="color:#666;font-size:12px;padding:12px;text-align:center;">${esc(emptyText || '없음')}</div>`}
      </div>
    `;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'include' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data || json;
  }

  async function init() {
    user = window.__pmcUser || user;
    if (!user && window.__pmcUserReady) user = await window.__pmcUserReady;
    if (!user) user = (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;

    const root = document.getElementById('hermes-execution-requests-section');
    if (!root) return;
    if (!user || user.id == null) {
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
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">🛡️ Hermes Execution Requests</h1>
        <p style="color:#aaa;font-size:13px;margin:0;line-height:1.5;">
          Read-only execution request review visibility. Approved execution request is not marketplace execution.
        </p>
      </div>

      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:12px;padding:14px;color:#ffcc80;font-size:13px;line-height:1.55;margin-bottom:14px;">
        <strong>Safety boundary:</strong>
        Approved execution request is not marketplace execution. No external action has been executed. Execution is disabled in this phase.<br>
        Readiness is not execution approval. Ready for final approval is not marketplace execution.<br>
        Final approval checklist is not final approval. Internal final approval is not marketplace execution. Execution remains disabled.<br>
        Internal task record is not marketplace execution. Execution remains disabled for marketplace actions. Only manual_review_task can be internally recorded.<br>
        Marketplace preflight is not marketplace execution. No marketplace API call is made in this phase. Listing changes remain disabled.
      </div>

      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
        <div style="color:#90a4ae;font-size:12px;">Phase 5G read-only UI backed by Phase 5F GET API only.</div>
        <button id="her-refresh" type="button" style="padding:8px 14px;background:#1565c0;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">새로고침</button>
      </div>

      <div id="her-summary" style="margin-bottom:14px;"></div>
      <div style="display:grid;grid-template-columns:minmax(360px,1fr) minmax(420px,1.15fr);gap:14px;align-items:start;">
        <div id="her-lists"></div>
        <div id="her-detail" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;color:#888;">
          <div style="text-align:center;padding:40px 0;">왼쪽에서 execution request를 선택하세요.</div>
        </div>
      </div>
    `;
    document.getElementById('her-refresh').addEventListener('click', refresh);
  }

  async function refresh() {
    const summaryEl = document.getElementById('her-summary');
    const listEl = document.getElementById('her-lists');
    if (summaryEl) summaryEl.innerHTML = '<div style="color:#888;padding:12px;">요약 로딩 중...</div>';
    if (listEl) listEl.innerHTML = '<div style="color:#888;padding:12px;">목록 로딩 중...</div>';
    try {
      [summary, approvedList] = await Promise.all([
        fetchJson('/api/hermes-execution/summary?limit=50'),
        fetchJson('/api/hermes-execution/requests?status=approved&limit=20'),
      ]);
      approvedList = Array.isArray(approvedList?.data) ? approvedList.data : [];
      renderSummary();
      renderLists();
      if (selectedId) await loadDetail(selectedId, { preserveList: true });
    } catch (e) {
      if (summaryEl) summaryEl.innerHTML = `<div style="padding:14px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
      if (listEl) listEl.innerHTML = '';
    }
  }

  function renderSummary() {
    const el = document.getElementById('her-summary');
    if (!el) return;
    const safety = summary?.safety_summary || {};
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
        ${countCards('counts by status', summary?.counts_by_status)}
        ${countCards('counts by final approval', summary?.counts_by_final_approval_status)}
        ${countCards('counts by execution_type', summary?.counts_by_execution_type)}
        ${countCards('counts by risk_level', summary?.counts_by_risk_level)}
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:12px;">
          <div style="color:#fff;font-size:13px;font-weight:700;margin-bottom:8px;">Safety summary</div>
          <div style="display:grid;gap:6px;color:#cfd8dc;font-size:12px;">
            <div>external actions detected: <strong style="color:#69f0ae;">${esc(safety.external_actions_detected || 0)}</strong></div>
            <div>marketplace execution approved: <strong style="color:#69f0ae;">${esc(safety.marketplace_execution_approved_count || 0)}</strong></div>
            <div>executed requests: <strong style="color:#69f0ae;">${esc(safety.executed_request_count || 0)}</strong></div>
            <div>internal task records: <strong style="color:#69f0ae;">${esc(summary?.internal_task_recorded_count || safety.internal_task_recorded_count || 0)}</strong></div>
            <div>marketplace preflight passed: <strong style="color:#69f0ae;">${esc(summary?.marketplace_preflight_passed_count || safety.marketplace_preflight_passed_count || 0)}</strong></div>
            <div>marketplace preflight failed: <strong style="color:#69f0ae;">${esc(summary?.marketplace_preflight_failed_count || safety.marketplace_preflight_failed_count || 0)}</strong></div>
            <div>marketplace preflight migration required: <strong style="color:#69f0ae;">${esc(summary?.marketplace_preflight_migration_required === true ? 'true' : 'false')}</strong></div>
            <div>execution events count: <strong style="color:#69f0ae;">${esc(summary?.execution_events_count || 0)}</strong></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderLists() {
    const el = document.getElementById('her-lists');
    if (!el) return;
    const pending = summary?.recent_pending_requests || [];
    const dryRunReady = summary?.recent_dry_run_ready_requests || [];
    const rejectedCancelled = summary?.recent_rejected_cancelled_requests || [];
    el.innerHTML = `
      ${sectionRows('recent approved requests', approvedList, 'approved request 없음')}
      ${sectionRows('dry-run ready requests', dryRunReady, 'dry-run ready request 없음')}
      ${sectionRows('recent pending requests', pending, 'pending request 없음')}
      ${sectionRows('rejected / cancelled requests', rejectedCancelled, 'rejected/cancelled request 없음')}
    `;
    el.querySelectorAll('.her-row').forEach(row => {
      row.addEventListener('click', () => loadDetail(parseInt(row.dataset.id, 10)));
    });
  }

  async function loadDetail(id, options = {}) {
    if (!Number.isFinite(id)) return;
    selectedId = id;
    if (!options.preserveList) renderLists();
    const detailEl = document.getElementById('her-detail');
    if (detailEl) detailEl.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">상세 로딩 중...</div>';
    try {
      [selectedDetail, selectedEvents] = await Promise.all([
        fetchJson('/api/hermes-execution/requests/' + encodeURIComponent(id)),
        fetchJson('/api/hermes-execution/requests/' + encodeURIComponent(id) + '/events?limit=20'),
      ]);
      renderDetail();
    } catch (e) {
      if (detailEl) detailEl.innerHTML = `<div style="padding:20px;color:#ef9a9a;">상세 로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function safetyRows(safety) {
    const s = safety || {};
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:#cfd8dc;">
        <div>external_action_executed<br>${boolPill(s.external_action_executed === true)}</div>
        <div>marketplace_execution_approved<br>${boolPill(s.marketplace_execution_approved === true)}</div>
        <div>executed_at<br><code style="color:#fff;">${esc(s.executed_at || 'null')}</code></div>
        <div>execution_result<br><code style="color:#fff;">${esc(s.execution_result ? 'present' : 'null')}</code></div>
        <div>approved_actor<br><code style="color:#fff;">${esc(s.approved_actor || 'null')}</code></div>
        <div>rejected_actor<br><code style="color:#fff;">${esc(s.rejected_actor || 'null')}</code></div>
        <div>cancelled_actor<br><code style="color:#fff;">${esc(s.cancelled_actor || 'null')}</code></div>
        <div>requires_approval<br>${boolPill(s.requires_approval === true)}</div>
      </div>
    `;
  }

  function renderEvents(events) {
    const rows = Array.isArray(events?.data) ? events.data : [];
    if (!rows.length) return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">event 없음</div>';
    return rows.map(ev => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-bottom:8px;">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:5px;">
          <span style="color:#80deea;font-size:11px;font-family:monospace;font-weight:700;">${esc(ev.event_type)}</span>
          <span style="color:#aaa;font-size:11px;">actor ${esc(ev.actor || '-')}</span>
          <span style="margin-left:auto;color:#666;font-size:10px;">#${esc(ev.id)} · ${fmtDate(ev.created_at)}</span>
        </div>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:0;max-height:160px;overflow:auto;">${pretty(ev.payload || {})}</pre>
      </div>
    `).join('');
  }

  function renderDryRunResult(result) {
    if (!result) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">dry_run_result 없음</div>';
    }
    const steps = Array.isArray(result.planned_steps) ? result.planned_steps : [];
    const blocked = Array.isArray(result.blocked_operations) ? result.blocked_operations : [];
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;margin-bottom:8px;">
        <div>dry_run<br>${boolPill(result.dry_run === true)}</div>
        <div>execution_performed<br>${boolPill(result.execution_performed === true)}</div>
        <div>external_action_executed<br>${boolPill(result.external_action_executed === true)}</div>
        <div>marketplace_api_calls<br>${boolPill(result.marketplace_api_calls === true)}</div>
        <div>marketplace_execution_approved<br>${boolPill(result.marketplace_execution_approved === true)}</div>
        <div>required_final_approval<br>${boolPill(result.required_final_approval === true)}</div>
      </div>
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-bottom:8px;">
        <div style="color:#90a4ae;font-size:10px;margin-bottom:4px;font-weight:700;">planned_steps</div>
        ${steps.length ? `<ol style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : '<div style="color:#666;font-size:12px;">-</div>'}
      </div>
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;">
        <div style="color:#90a4ae;font-size:10px;margin-bottom:4px;font-weight:700;">blocked_operations</div>
        ${blocked.length ? blocked.map(b => `<span style="display:inline-block;background:#4a1a1a;color:#ef9a9a;padding:2px 6px;border-radius:4px;font-size:10px;margin:1px 3px 1px 0;font-family:monospace;">${esc(b)}</span>`).join('') : '<div style="color:#666;font-size:12px;">-</div>'}
      </div>
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw dry_run_result JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(result)}</pre>
      </details>
    `;
  }

  function renderReadiness(readiness) {
    if (!readiness) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">readiness 없음</div>';
    }
    const list = (title, rows, color) => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="color:${color || '#90a4ae'};font-size:10px;margin-bottom:4px;font-weight:700;">${esc(title)}</div>
        ${Array.isArray(rows) && rows.length ? `<ul style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul>` : '<div style="color:#666;font-size:12px;">none</div>'}
      </div>
    `;
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        Readiness is not execution approval.<br>
        Ready for final approval is not marketplace execution.<br>
        Final approval checklist is not final approval.<br>
        Internal final approval is not marketplace execution.<br>
        Execution remains disabled.<br>
        Marketplace preflight is not marketplace execution. No marketplace API call is made in this phase. Listing changes remain disabled.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>ready_for_final_approval<br>${boolPill(readiness.ready_for_final_approval === true)}</div>
        <div>ready_for_execution<br>${boolPill(readiness.ready_for_execution === true)}</div>
        <div>source<br><code style="color:#fff;">${esc(readiness.source || '-')}</code></div>
        <div>status<br><code style="color:#fff;">${esc(readiness.status || '-')}</code></div>
      </div>
      ${list('blockers', readiness.blockers || [], '#ef9a9a')}
      ${list('warnings', readiness.warnings || [], '#ffcc80')}
      ${list('required confirmations', readiness.required_confirmations || [], '#90caf9')}
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw readiness JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(readiness)}</pre>
      </details>
    `;
  }

  function renderFinalApprovalChecklist(checklist) {
    if (!checklist) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">final approval checklist 없음</div>';
    }
    const list = (title, rows, color) => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="color:${color || '#90a4ae'};font-size:10px;margin-bottom:4px;font-weight:700;">${esc(title)}</div>
        ${Array.isArray(rows) && rows.length ? `<ul style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul>` : '<div style="color:#666;font-size:12px;">none</div>'}
      </div>
    `;
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        Final approval checklist is not final approval.<br>
        Internal final approval is not marketplace execution.<br>
        Execution remains disabled.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>policy_version<br><code style="color:#fff;">${esc(checklist.policy_version || '-')}</code></div>
        <div>final_approval_available<br>${boolPill(checklist.final_approval_available === true)}</div>
        <div>execution_available<br>${boolPill(checklist.execution_available === true)}</div>
        <div>read_only<br>${boolPill(checklist.safety?.read_only === true)}</div>
      </div>
      ${list('operator checklist', checklist.operator_checklist || [], '#90caf9')}
      ${list('required confirmations', checklist.required_confirmations || [], '#90caf9')}
      ${list('blocking conditions', checklist.blocking_conditions || [], '#ef9a9a')}
      ${list('risk notes', checklist.risk_notes || [], '#ffcc80')}
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw final approval checklist JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(checklist)}</pre>
      </details>
    `;
  }

  function renderFinalApprovalSummary(finalApproval) {
    const fa = finalApproval || {};
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        Internal final approval is not marketplace execution.<br>
        Final approval does not call marketplace APIs.<br>
        Execution remains disabled.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>final_approval_status<br><code style="color:#fff;">${esc(fa.status || 'not_requested')}</code></div>
        <div>actor<br><code style="color:#fff;">${esc(fa.actor || 'null')}</code></div>
        <div>approved_at<br><code style="color:#fff;">${esc(fa.approved_at || 'null')}</code></div>
        <div>policy_version<br><code style="color:#fff;">${esc(fa.policy_version || 'null')}</code></div>
        <div style="grid-column:1 / -1;">dry_run_hash<br><code style="color:#fff;word-break:break-all;">${esc(fa.dry_run_hash || 'null')}</code></div>
        <div style="grid-column:1 / -1;">reason<br><code style="color:#fff;white-space:pre-wrap;">${esc(fa.reason || 'null')}</code></div>
        <div>external_action_executed<br>${boolPill(fa.external_action_executed === true)}</div>
        <div>marketplace_execution_approved<br>${boolPill(fa.marketplace_execution_approved === true)}</div>
      </div>
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw final approval snapshot JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(fa.snapshot || null)}</pre>
      </details>
    `;
  }

  function renderExecutorPreflight(preflight) {
    if (!preflight) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">executor preflight 없음</div>';
    }
    const list = (title, rows, color) => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="color:${color || '#90a4ae'};font-size:10px;margin-bottom:4px;font-weight:700;">${esc(title)}</div>
        ${Array.isArray(rows) && rows.length ? `<ul style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul>` : '<div style="color:#666;font-size:12px;">none</div>'}
      </div>
    `;
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        Internal task record is not marketplace execution.<br>
        Execution remains disabled for marketplace actions.<br>
        Only manual_review_task can be internally recorded.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>allowed<br>${boolPill(preflight.allowed === true)}</div>
        <div>execution_available<br>${boolPill(preflight.execution_available === true)}</div>
        <div>internal_record_available<br>${boolPill(preflight.internal_record_available === true)}</div>
        <div>source<br><code style="color:#fff;">${esc(preflight.source || '-')}</code></div>
        <div style="grid-column:1 / -1;">current dry-run hash<br><code style="color:#fff;word-break:break-all;">${esc(preflight.hashes?.current_dry_run_hash || 'null')}</code></div>
        <div style="grid-column:1 / -1;">final approval hash<br><code style="color:#fff;word-break:break-all;">${esc(preflight.hashes?.final_approval_dry_run_hash || 'null')}</code></div>
      </div>
      ${list('blockers', preflight.blockers || [], '#ef9a9a')}
      ${list('warnings', preflight.warnings || [], '#ffcc80')}
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw executor preflight JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(preflight)}</pre>
      </details>
    `;
  }

  function renderInternalExecutionRecords(records) {
    const rows = Array.isArray(records?.data) ? records.data : [];
    if (!rows.length) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">internal execution record 없음</div>';
    }
    return rows.map(row => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-bottom:8px;">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:5px;">
          <span style="color:#80deea;font-size:11px;font-family:monospace;font-weight:700;">${esc(row.status)}</span>
          <span style="color:#aaa;font-size:11px;">actor ${esc(row.actor || '-')}</span>
          <span style="margin-left:auto;color:#666;font-size:10px;">#${esc(row.id)} · ${fmtDate(row.created_at)}</span>
        </div>
        <div style="color:#cfd8dc;font-size:12px;margin-bottom:6px;">type <code style="color:#ce93d8;">${esc(row.execution_type || '-')}</code> · reason ${esc(row.reason || '-')}</div>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:0;max-height:180px;overflow:auto;">${pretty(row.internal_task_result || {})}</pre>
      </div>
    `).join('');
  }


  function renderMarketplacePreflight(preflight) {
    if (!preflight) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">marketplace preflight 없음</div>';
    }
    const list = (title, rows, color) => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="color:${color || '#90a4ae'};font-size:10px;margin-bottom:4px;font-weight:700;">${esc(title)}</div>
        ${Array.isArray(rows) && rows.length ? `<ul style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul>` : '<div style="color:#666;font-size:12px;">none</div>'}
      </div>
    `;
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        Marketplace preflight is not marketplace execution.<br>
        No marketplace API call is made in this phase.<br>
        Listing changes remain disabled.<br>
        Cached/internal data only.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>marketplace<br><code style="color:#fff;">${esc(preflight.marketplace || '-')}</code></div>
        <div>operation<br><code style="color:#fff;">${esc(preflight.operation || '-')}</code></div>
        <div>allowed<br>${boolPill(preflight.allowed === true)}</div>
        <div>marketplace_execution_available<br>${boolPill(preflight.marketplace_execution_available === true)}</div>
        <div>preflight_record_available<br>${boolPill(preflight.preflight_record_available === true)}</div>
        <div>source<br><code style="color:#fff;">${esc(preflight.source || '-')}</code></div>
        <div style="grid-column:1 / -1;">cached listing snapshot hash<br><code style="color:#fff;word-break:break-all;">${esc(preflight.hashes?.cached_listing_snapshot_hash || 'null')}</code></div>
        <div style="grid-column:1 / -1;">planned mutation hash<br><code style="color:#fff;word-break:break-all;">${esc(preflight.hashes?.planned_mutation_hash || 'null')}</code></div>
      </div>
      ${list('blockers', preflight.blockers || [], '#ef9a9a')}
      ${list('warnings', preflight.warnings || [], '#ffcc80')}
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw marketplace preflight JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(preflight)}</pre>
      </details>
    `;
  }

  function renderMarketplacePreflightRecords(records) {
    const rows = Array.isArray(records?.data) ? records.data : [];
    if (!rows.length) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">marketplace preflight record 없음</div>';
    }
    return rows.map(row => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-bottom:8px;">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:5px;">
          <span style="color:#80deea;font-size:11px;font-family:monospace;font-weight:700;">${esc(row.status)}</span>
          <span style="color:#aaa;font-size:11px;">${esc(row.marketplace || '-')} / ${esc(row.operation || '-')}</span>
          <span style="color:#aaa;font-size:11px;">actor ${esc(row.actor || '-')}</span>
          <span style="margin-left:auto;color:#666;font-size:10px;">#${esc(row.id)} · ${fmtDate(row.created_at)}</span>
        </div>
        <div style="color:#cfd8dc;font-size:12px;margin-bottom:6px;">reason ${esc(row.reason || '-')}</div>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:0;max-height:180px;overflow:auto;">${pretty(row.preflight_result || {})}</pre>
      </div>
    `).join('');
  }


  function renderEbayListingQualityDryRun(dryRun) {
    if (!dryRun) {
      return '<div style="color:#666;font-size:12px;padding:12px;text-align:center;">eBay listing quality dry-run 없음</div>';
    }
    const list = (title, rows, color) => `
      <div style="background:#0f0f23;border:1px solid #263238;border-radius:6px;padding:8px;margin-top:8px;">
        <div style="color:${color || '#90a4ae'};font-size:10px;margin-bottom:4px;font-weight:700;">${esc(title)}</div>
        ${Array.isArray(rows) && rows.length ? `<ul style="margin:0;padding-left:18px;color:#cfd8dc;font-size:12px;line-height:1.45;">${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul>` : '<div style="color:#666;font-size:12px;">none</div>'}
      </div>
    `;
    return `
      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:8px;">
        eBay listing quality dry-run is not listing revision.<br>
        No eBay API call is made.<br>
        Price and inventory fields are blocked.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;color:#cfd8dc;font-size:12px;">
        <div>marketplace<br><code style="color:#fff;">${esc(dryRun.marketplace || '-')}</code></div>
        <div>operation<br><code style="color:#fff;">${esc(dryRun.operation || '-')}</code></div>
        <div>dry_run<br>${boolPill(dryRun.dry_run === true)}</div>
        <div>allowed<br>${boolPill(dryRun.allowed === true)}</div>
        <div>marketplace_api_calls<br>${boolPill(dryRun.marketplace_api_calls === true)}</div>
        <div>execution_performed<br>${boolPill(dryRun.execution_performed === true)}</div>
        <div>target sku<br><code style="color:#fff;">${esc(dryRun.target?.sku || 'null')}</code></div>
        <div>target item_id<br><code style="color:#fff;">${esc(dryRun.target?.item_id || 'null')}</code></div>
      </div>
      ${list('blockers', dryRun.blockers || [], '#ef9a9a')}
      ${list('warnings', dryRun.warnings || [], '#ffcc80')}
      ${list('blocked fields', dryRun.blocked_fields || [], '#ef9a9a')}
      <details style="margin-top:8px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw eBay listing quality dry-run JSON</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:220px;overflow:auto;">${pretty(dryRun)}</pre>
      </details>
    `;
  }

  function renderDetail() {
    const el = document.getElementById('her-detail');
    if (!el || !selectedDetail) return;
    const req = selectedDetail.request || {};
    const opp = selectedDetail.opportunity_snapshot || null;
    const safety = selectedDetail.safety_summary || {};
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">${badge(req.status)}<span style="color:#666;font-size:11px;">#${esc(req.id)}</span></div>
          <h2 style="color:#fff;font-size:16px;margin:0;line-height:1.35;">Execution Request · SKU ${esc(req.sku || '-')}</h2>
          <div style="color:#aaa;font-size:12px;margin-top:6px;">type <code style="color:#ce93d8;">${esc(req.execution_type || '-')}</code> · risk <strong style="color:#ffcc80;">${esc(req.risk_level || '-')}</strong></div>
        </div>
        <div style="color:#666;font-size:11px;text-align:right;">created<br>${fmtDate(req.created_at)}</div>
      </div>

      <div style="background:#261f12;border:1px solid #5d3a00;border-radius:6px;padding:10px;color:#ffcc80;font-size:12px;line-height:1.5;margin-bottom:10px;">
        Approved execution request is not marketplace execution.<br>
        No external action has been executed.<br>
        Readiness is not execution approval.<br>
        Ready for final approval is not marketplace execution.<br>
        Final approval checklist is not final approval.<br>
        Internal final approval is not marketplace execution.<br>
        Execution remains disabled.
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Safety summary</div>
        ${safetyRows(safety)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Readiness summary</div>
        ${renderReadiness(selectedDetail.readiness_summary)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Final approval status</div>
        ${renderFinalApprovalSummary(selectedDetail.final_approval_summary)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Final approval checklist</div>
        ${renderFinalApprovalChecklist(selectedDetail.final_approval_checklist)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Executor preflight</div>
        ${renderExecutorPreflight(selectedDetail.executor_preflight)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Internal execution records</div>
        ${renderInternalExecutionRecords(selectedDetail.internal_execution_records)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Marketplace preflight</div>
        ${renderMarketplacePreflight(selectedDetail.marketplace_preflight)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">Marketplace preflight records</div>
        ${renderMarketplacePreflightRecords(selectedDetail.marketplace_preflight_records)}
      </div>


      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:8px;font-weight:700;">eBay listing quality dry-run</div>
        ${renderEbayListingQualityDryRun(selectedDetail.ebay_listing_quality_dry_run)}
      </div>

      ${opp ? `
        <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
          <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:700;">Related opportunity snapshot</div>
          <div style="color:#cfd8dc;font-size:12px;line-height:1.5;">
            opportunity #${esc(opp.id)} · ${badge(opp.status)} · type <code style="color:#ce93d8;">${esc(opp.type || '-')}</code><br>
            title: ${esc(opp.title || '-')}<br>
            SKU: ${esc(opp.sku || '-')}
          </div>
        </div>
      ` : ''}

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:700;">Dry-run result</div>
        ${renderDryRunResult(req.dry_run_result)}
      </div>

      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:10px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:700;">Event history</div>
        ${renderEvents(selectedEvents)}
      </div>

      <details style="background:#0f0f23;border-radius:6px;padding:10px;">
        <summary style="color:#aaa;font-size:11px;font-weight:700;cursor:pointer;">Raw request JSON (read-only)</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;color:#cfd8dc;font-size:11px;line-height:1.35;margin:8px 0 0;max-height:260px;overflow:auto;">${pretty(req)}</pre>
      </details>
    `;
  }

  window.pmcHermesExecutionRequests = { init, load: init, refresh };
})();
