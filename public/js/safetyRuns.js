/**
 * Safety Foundation 실행 로그 UI — Phase 3 PR M
 *
 * 책임:
 *   - GET /api/safety-runs 호출 (목록)
 *   - GET /api/safety-runs/:id 호출 (상세 + rollback chain)
 *   - 좌측 목록 + 우측 상세 + 필터 (action_name / status / 본인만)
 *   - 되돌리기 버튼 = stub modal (PR M §2-1 A) — network request 0, helper invocation 0
 *
 * 권한: 로그인된 모든 사용자 (정책 §1-A + PR M §2-2 X)
 *
 * 정책:
 *   - snapshot 은 redact 통과 후 저장된 상태 — UI 가 추가 마스킹 안 함
 *   - raw JSON 은 기본 접힘 (보강 3) — <details> + max-height + overflow-y:auto
 *   - 되돌리기 stub 클릭은 modal 만 — server endpoint 호출 0건, helper invocation 0건
 *   - total 은 best-effort (보강 1) — null 시에도 prev/next 정상 동작
 */
(function () {
  let user = null;
  let cache = [];
  let openRunId = null;
  let openRunDetail = null;
  let pageOffset = 0;
  let lastTotal = null;
  let lastDataLen = 0;
  const PAGE_LIMIT = 50;

  // ── helpers ─────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(iso)  { return iso ? new Date(iso).toLocaleString('ko-KR') : '-'; }

  // status 배지 (plan §5)
  const STATUS_BADGE = {
    pending:           { bg: '#37474f', fg: '#90a4ae', label: 'pending' },
    started:           { bg: '#37474f', fg: '#90a4ae', label: 'started' },
    succeeded:         { bg: '#1b5e20', fg: '#69f0ae', label: 'succeeded' },
    failed:            { bg: '#4a1a1a', fg: '#ef9a9a', label: 'failed' },
    aborted:           { bg: '#4a1a1a', fg: '#ef9a9a', label: 'aborted' },
    cancelled:         { bg: '#37474f', fg: '#bdbdbd', label: 'cancelled' },
    rollback_required: { bg: '#5d3a00', fg: '#ffb74d', label: 'rollback_required' },
    rolled_back:       { bg: '#1a3a4a', fg: '#64b5f6', label: 'rolled_back' },
  };

  // PR L-3 — action_name → 친화 라벨. 라벨 없는 신규 action_name 은 mono 만 표시.
  const ACTION_LABEL = {
    mock_order_import:           'Mock 주문 가져오기',
    rollback:                    '되돌리기',
    sku_master_create:           'SKU 등록',
    sku_master_update:           'SKU 수정',
    sku_master_soft_delete:      'SKU 보류/폐기',
    sku_listing_link_create:     'SKU 마켓 링크 등록',
    sku_listing_link_delete:     'SKU 마켓 링크 삭제',
    exception_task_mock_create:  '자동 예외 카드 (mock)',
    task_create:                 '업무 등록',
    task_update:                 '업무 수정',
    task_status_update:          '업무 상태 변경',
    task_delete:                 '업무 삭제',
    task_comment_create:         '업무 댓글 등록',
    purchase_request_create:     '발주 요청 등록',
    purchase_request_update:     '발주 요청 수정',
    purchase_request_approve:    '발주 승인',
    purchase_request_reject:     '발주 반려',
    purchase_request_ordered:    '발주 주문완료',
    purchase_request_cancel:     '발주 취소',
  };

  // 친화 라벨 + mono action_name 함께 표시. 라벨 없으면 mono 만.
  function actionLabelHtml(name) {
    if (!name) return '<span style="color:#666;">?</span>';
    const friendly = ACTION_LABEL[name];
    const monoBadge = `<span style="background:#1a3a4a;color:#64b5f6;padding:1px 6px;border-radius:3px;font-size:10px;font-family:monospace;">${esc(name)}</span>`;
    if (!friendly) return monoBadge;
    return `<span style="color:#fff;font-size:11px;font-weight:600;margin-right:6px;">${esc(friendly)}</span>${monoBadge}`;
  }

  // PR U8 — rollback_method → 사용자 친화 라벨
  const ROLLBACK_METHOD_LABEL = {
    auto:         '자동 되돌리기 가능',
    manual:       '수동 처리 필요',
    irreversible: '되돌릴 수 없음',
  };

  // PR L-3 — target_table → dashboard.js case 명 매핑 (deep link 버튼).
  // dashboard.js 의 navigateTo(page) 와 정합. row id 자동 선택은 본 PR 범위 외.
  const TARGET_PAGE = {
    sku_master:        'sku-master',
    team_tasks:        'tasks',
    purchase_requests: 'orders',
    wms_orders:        'wms-orders',
  };

  function targetNavBtn(table) {
    const page = TARGET_PAGE[table];
    if (!page) return '';
    return `<button type="button" class="sr-target-nav" data-target-page="${esc(page)}" style="margin-left:8px;padding:2px 8px;background:#37474f;border:1px solid #555;border-radius:3px;color:#cfd8dc;cursor:pointer;font-size:10px;">→ ${esc(page)} 화면 열기</button>`;
  }

  function navigateToPage(page) {
    if (typeof showPage === 'function') showPage(page);
    else location.href = '/?page=' + encodeURIComponent(page);
  }

  function executorLabel(run) {
    if (run.executor && run.executor.display_name) return esc(run.executor.display_name);
    if (run.triggered_by === 'legacy_admin')       return '<span style="color:#888;">legacy_admin</span>';
    if (run.triggered_by)                          return esc(run.triggered_by);
    return '<span style="color:#666;">-</span>';
  }

  function badge(status) {
    const sb = STATUS_BADGE[status] || { bg: '#37474f', fg: '#bdbdbd', label: status || '?' };
    return `<span style="background:${sb.bg};color:${sb.fg};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;">${esc(sb.label)}</span>`;
  }

  // ── entry ────────────────────────────────────────────────
  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;
    const root = document.getElementById('safety-runs-section');
    if (!root) return;
    if (!user || !user.id) {
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
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">📜 실행 로그</h1>
        <p style="color:#888;font-size:13px;margin:0;">
          모든 audit 실행 기록 조회 (admin / staff 동일 가시성). snapshot 은 redact 통과 후 저장된 상태이며 UI 추가 마스킹 없음.
          타인 실행 row 도 표시됩니다 — 본인 row 만 보려면 좌측 "내가 실행한 것만" 체크.
        </p>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:16px;align-items:start;">
        <!-- 좌측: 필터 + 목록 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
            <strong style="color:#fff;font-size:14px;">📋 audit 목록</strong>
            <button id="sr-refresh" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">새로고침</button>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
            <select id="sr-action" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
              <option value="">전체 action</option>
              <optgroup label="WMS 주문">
                <option value="mock_order_import">Mock 주문 가져오기 (mock_order_import)</option>
              </optgroup>
              <optgroup label="SKU 마스터">
                <option value="sku_master_create">SKU 등록 (sku_master_create)</option>
                <option value="sku_master_update">SKU 수정 (sku_master_update)</option>
                <option value="sku_master_soft_delete">SKU 보류/폐기 (sku_master_soft_delete)</option>
                <option value="sku_listing_link_create">SKU 마켓 링크 등록 (sku_listing_link_create)</option>
                <option value="sku_listing_link_delete">SKU 마켓 링크 삭제 (sku_listing_link_delete)</option>
              </optgroup>
              <optgroup label="자동 예외">
                <option value="exception_task_mock_create">자동 예외 카드 mock (exception_task_mock_create)</option>
              </optgroup>
              <optgroup label="업무">
                <option value="task_create">업무 등록 (task_create)</option>
                <option value="task_update">업무 수정 (task_update)</option>
                <option value="task_status_update">업무 상태 변경 (task_status_update)</option>
                <option value="task_delete">업무 삭제 (task_delete)</option>
                <option value="task_comment_create">업무 댓글 등록 (task_comment_create)</option>
              </optgroup>
              <optgroup label="발주">
                <option value="purchase_request_create">발주 요청 등록 (purchase_request_create)</option>
                <option value="purchase_request_update">발주 요청 수정 (purchase_request_update)</option>
                <option value="purchase_request_approve">발주 승인 (purchase_request_approve)</option>
                <option value="purchase_request_reject">발주 반려 (purchase_request_reject)</option>
                <option value="purchase_request_ordered">발주 주문완료 (purchase_request_ordered)</option>
                <option value="purchase_request_cancel">발주 취소 (purchase_request_cancel)</option>
              </optgroup>
              <optgroup label="시스템">
                <option value="rollback">되돌리기 (rollback)</option>
              </optgroup>
            </select>
            <select id="sr-status" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
              <option value="">전체 status</option>
              <option value="pending">pending</option>
              <option value="started">started</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="aborted">aborted</option>
              <option value="cancelled">cancelled</option>
              <option value="rollback_required">rollback_required</option>
              <option value="rolled_back">rolled_back</option>
            </select>
            <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" id="sr-mine"> 내가 실행한 것만
            </label>
          </div>
          <div id="sr-list" style="margin-bottom:10px;"></div>
          <div id="sr-pager" style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#888;">
            <button id="sr-prev" type="button" style="padding:4px 10px;background:#37474f;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:11px;">← prev</button>
            <span id="sr-pager-info"></span>
            <button id="sr-next" type="button" style="padding:4px 10px;background:#37474f;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:11px;">next →</button>
          </div>
        </div>

        <!-- 우측: 상세 -->
        <div id="sr-detail" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;color:#888;">
          <div style="text-align:center;padding:40px 0;">왼쪽에서 row 를 선택하세요.</div>
        </div>
      </div>
    `;

    document.getElementById('sr-refresh').addEventListener('click', () => { pageOffset = 0; refresh(); });
    document.getElementById('sr-action').addEventListener('change',  () => { pageOffset = 0; refresh(); });
    document.getElementById('sr-status').addEventListener('change',  () => { pageOffset = 0; refresh(); });
    document.getElementById('sr-mine').addEventListener('change',    () => { pageOffset = 0; refresh(); });
    document.getElementById('sr-prev').addEventListener('click',     () => {
      if (pageOffset <= 0) return;
      pageOffset = Math.max(0, pageOffset - PAGE_LIMIT);
      refresh();
    });
    document.getElementById('sr-next').addEventListener('click',     () => {
      // 보강 1 — total null 이어도 마지막 row 수 == limit 이면 next 가능
      if (lastDataLen < PAGE_LIMIT) return;
      if (lastTotal !== null && pageOffset + PAGE_LIMIT >= lastTotal) return;
      pageOffset += PAGE_LIMIT;
      refresh();
    });

    // PR U2-fix — rollback 버튼 click 을 root container 에 delegate.
    // renderShell 은 init() 의 data-initialized='1' 안에서 1회 호출되므로 listener 중복 X.
    // button 은 detail re-render 때마다 재생성되지만 root 는 안정적이라 detached
    // listener / id 충돌 / re-render race 모두 회피.
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rollback-mode]');
      if (!btn) return;
      const id = Number(btn.dataset.runId);
      const mode = btn.dataset.rollbackMode;
      if (!Number.isFinite(id)) {
        alert('실행 로그 ID가 올바르지 않습니다');
        return;
      }
      if (mode === 'auto') {
        showAutoRollbackModal(id);
      } else if (mode === 'manual') {
        showManualRollbackModal(id);
      }
    });
  }

  // ── list ─────────────────────────────────────────────────
  async function refresh() {
    const root = document.getElementById('safety-runs-section');
    if (!root || root.dataset.initialized !== '1') return;

    const action  = document.getElementById('sr-action')?.value  || '';
    const status  = document.getElementById('sr-status')?.value  || '';
    const mine    = document.getElementById('sr-mine')?.checked  || false;

    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(pageOffset) });
    if (action)  params.set('action_name', action);
    if (status)  params.set('status',      status);
    if (mine && user?.id) params.set('executed_by', String(user.id));

    // URL deep-link 자동 적용 (target_table / target_id) — UI 컨트롤은 본 PR 미포함
    const urlParams = new URLSearchParams(location.search);
    const tt = urlParams.get('target_table');
    const ti = urlParams.get('target_id');
    if (tt) params.set('target_table', tt);
    if (ti) params.set('target_id',    ti);

    try {
      const res = await fetch('/api/safety-runs?' + params.toString(), { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      cache       = json.data || [];
      lastTotal   = (typeof json.total === 'number') ? json.total : null;
      lastDataLen = cache.length;
      renderList();
      updatePager();
      if (openRunId) {
        const stillExists = cache.find(r => r.id === openRunId);
        if (stillExists) await openDetail(openRunId);
      }
    } catch (e) {
      const el = document.getElementById('sr-list');
      if (el) el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function updatePager() {
    const info = document.getElementById('sr-pager-info');
    const prev = document.getElementById('sr-prev');
    const next = document.getElementById('sr-next');
    if (!info || !prev || !next) return;

    const start = lastDataLen === 0 ? 0 : pageOffset + 1;
    const end   = pageOffset + lastDataLen;
    const totalStr = lastTotal !== null ? ` / ${lastTotal} 건` : '';
    info.textContent = `${start}–${end}${totalStr}`;

    prev.disabled = pageOffset <= 0;
    prev.style.opacity = prev.disabled ? '0.4' : '1';

    const noMore = (lastDataLen < PAGE_LIMIT) || (lastTotal !== null && pageOffset + PAGE_LIMIT >= lastTotal);
    next.disabled = noMore;
    next.style.opacity = next.disabled ? '0.4' : '1';
  }

  function renderList() {
    const el = document.getElementById('sr-list');
    if (!el) return;
    if (cache.length === 0) {
      el.innerHTML = '<div style="padding:20px;color:#888;font-size:13px;">audit row 없음. mock import 등 액션을 실행하면 여기 표시됩니다.</div>';
      return;
    }
    el.innerHTML = cache.map(r => {
      const isActive = r.id === openRunId;
      const targetStr = r.target_table
        ? `${esc(r.target_table)}${r.target_id != null ? '#' + r.target_id : ''}`
        : '<span style="color:#666;">-</span>';
      return `
        <div class="sr-row" data-id="${r.id}" style="
          padding:10px 12px;border:1px solid ${isActive ? '#81d4fa' : '#2a2a4a'};
          border-radius:8px;margin-bottom:8px;cursor:pointer;
          background:${isActive ? '#0a1a2e' : '#0f0f23'};
        ">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
            ${badge(r.status)}
            ${actionLabelHtml(r.action_name || r.automation_type)}
            <span style="margin-left:auto;color:#666;font-size:11px;">#${r.id}</span>
          </div>
          <div style="color:#fff;font-size:12px;margin-bottom:4px;">
            by ${executorLabel(r)} · target ${targetStr}
          </div>
          <div style="color:#666;font-size:11px;">${fmtDate(r.started_at)}</div>
        </div>
      `;
    }).join('');
    el.querySelectorAll('.sr-row').forEach(div => {
      div.addEventListener('click', async () => {
        const id = parseInt(div.dataset.id, 10);
        await openDetail(id);
      });
    });
  }

  // ── detail (외부에서 호출 가능) ─────────────────────────
  async function openDetail(id) {
    if (!Number.isFinite(id)) return;
    openRunId = id;
    renderList();  // active 표시 갱신

    const el = document.getElementById('sr-detail');
    if (!el) return;
    el.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">로딩 중...</div>';
    try {
      const res = await fetch('/api/safety-runs/' + id, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      openRunDetail = json.data;
      renderDetail();
    } catch (e) {
      el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">상세 로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderDetail() {
    const r = openRunDetail;
    if (!r) return;
    const el = document.getElementById('sr-detail');
    if (!el) return;

    const targetStr = r.target_table
      ? `${esc(r.target_table)}${r.target_id != null ? '#' + r.target_id : ''}`
      : '<span style="color:#666;">-</span>';

    // PR U2 — 4분기 (auto / manual / 이미 되돌려짐 / irreversible / 그 외)
    const alreadyRolledBack = r.status === 'rolled_back' || r.rollback_run_id != null;
    let rollbackBtnMode = 'none';   // 'auto' | 'manual' | 'done' | 'irreversible' | 'none'
    if (alreadyRolledBack) {
      rollbackBtnMode = 'done';
    } else if (r.status !== 'succeeded') {
      rollbackBtnMode = 'none';
    } else if (r.rollback_method === 'auto') {
      rollbackBtnMode = 'auto';
    } else if (r.rollback_method === 'manual') {
      rollbackBtnMode = 'manual';
    } else if (r.rollback_method === 'irreversible') {
      rollbackBtnMode = 'irreversible';
    }
    let rollbackBtnHtml = '';
    if (rollbackBtnMode === 'auto') {
      rollbackBtnHtml = `<button data-rollback-mode="auto" data-run-id="${r.id}" type="button" style="margin-top:8px;padding:6px 14px;background:#1565c0;border:1px solid #64b5f6;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">되돌리기 실행</button>`;
    } else if (rollbackBtnMode === 'manual') {
      rollbackBtnHtml = `<button data-rollback-mode="manual" data-run-id="${r.id}" type="button" style="margin-top:8px;padding:6px 14px;background:#5d3a00;border:1px solid #ffb74d;border-radius:4px;color:#ffb74d;cursor:pointer;font-size:12px;font-weight:600;">수동 되돌리기 안내</button>`;
    } else if (rollbackBtnMode === 'irreversible') {
      rollbackBtnHtml = `<div style="margin-top:8px;padding:6px 10px;background:#37474f;border-radius:4px;color:#bdbdbd;font-size:11px;">되돌릴 수 없음 (irreversible)</div>`;
    } else if (rollbackBtnMode === 'done') {
      rollbackBtnHtml = `<div style="margin-top:8px;padding:6px 10px;background:#1a3a4a;border-radius:4px;color:#64b5f6;font-size:11px;">이미 되돌려진 실행입니다.</div>`;
    }

    // rollback chain
    let chainHtml = '';
    if (r.rollback_run) {
      const rr = r.rollback_run;
      chainHtml = `
        <div style="margin-top:10px;padding:10px;background:#1a3a4a;border-radius:6px;font-size:12px;color:#bbdefb;">
          ↩ 이 액션은 <strong>#${rr.id}</strong> (${esc(rr.action_name)}) 에서 되돌려졌습니다 ·
          by ${executorLabel(rr)} · ${fmtDate(rr.started_at)}
        </div>
      `;
    }
    if (r.original_run) {
      const or = r.original_run;
      chainHtml += `
        <div style="margin-top:10px;padding:10px;background:#1a3a4a;border-radius:6px;font-size:12px;color:#bbdefb;">
          ↪ 원본 액션: <a href="#" data-original-id="${or.id}" id="sr-open-original" style="color:#fff;text-decoration:underline;font-weight:600;">#${or.id} ${esc(or.action_name)}</a>
          · by ${executorLabel(or)} · ${fmtDate(or.started_at)}
        </div>
      `;
    }

    const errHtml = (r.error_code || r.error_message) ? `
      <div style="margin-top:10px;padding:10px;background:#4a1a1a;border-radius:6px;font-size:12px;color:#ffcdd2;">
        ${r.error_code ? `<div><strong>error_code:</strong> ${esc(r.error_code)}</div>` : ''}
        ${r.error_message ? `<div style="margin-top:4px;"><strong>error_message:</strong> ${esc(r.error_message)}</div>` : ''}
      </div>
    ` : '';

    const rolledBackInfo = r.rolled_back_at ? `
      <div style="margin-top:6px;color:#90a4ae;font-size:11px;">
        rolled_back_at: ${fmtDate(r.rolled_back_at)} ·
        rolled_back_by: ${r.rolled_back_executor?.display_name ? esc(r.rolled_back_executor.display_name) : (r.rolled_back_by ?? '-')}
        ${r.rollback_reason ? `<div style="margin-top:2px;">reason: ${esc(r.rollback_reason)}</div>` : ''}
      </div>
    ` : '';

    // 보강 3 — snapshot 기본 접힘 (<details> open 속성 없음, max-height + overflow)
    const snapshotPre = (label, value) => {
      if (value == null) return '';
      const json = JSON.stringify(value, null, 2);
      return `
        <details style="margin-top:10px;">
          <summary style="cursor:pointer;color:#aaa;font-size:11px;">▸ ${esc(label)} (펼치기)</summary>
          <pre style="background:#0f0f23;color:#cfd8dc;padding:10px;border-radius:6px;font-size:11px;max-height:300px;overflow-y:auto;margin:6px 0 0;">${esc(json)}</pre>
        </details>
      `;
    };

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
            ${badge(r.status)}
            ${actionLabelHtml(r.action_name || r.automation_type)}
            <span style="color:#666;font-size:11px;">#${r.id}</span>
          </div>
          <div style="color:#fff;font-size:13px;">by ${executorLabel(r)}</div>
          <div style="color:#aaa;font-size:11px;margin-top:2px;">target: ${targetStr}${targetNavBtn(r.target_table)}</div>
        </div>
        <div style="text-align:right;color:#888;font-size:11px;">
          started: ${fmtDate(r.started_at)}<br>
          completed: ${fmtDate(r.completed_at)}
        </div>
      </div>

      ${errHtml}

      <div style="margin-top:14px;padding:10px;background:#0f0f23;border-radius:6px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:600;">↺ rollback metadata</div>
        <div style="color:#fff;font-size:12px;">
          ${(() => {
            const key = r.rollback_method;
            const label = key ? (ROLLBACK_METHOD_LABEL[key] || key) : '되돌리기 정보 없음';
            return `<strong>${esc(label)}</strong>${key ? ` <span style="color:#888;font-size:10px;font-family:monospace;margin-left:4px;">(${esc(key)})</span>` : ''}`;
          })()}
        </div>
        ${r.rollback_hint ? `
          <div style="margin-top:6px;color:#aaa;font-size:11px;">hint:</div>
          <pre style="background:#1a1a2e;color:#cfd8dc;padding:8px;border-radius:4px;font-size:11px;margin:4px 0 0;white-space:pre-wrap;word-break:break-all;">${esc(r.rollback_hint)}</pre>
        ` : ''}
        ${rolledBackInfo}
        ${rollbackBtnHtml}
      </div>

      ${chainHtml}

      ${snapshotPre('input_snapshot',  r.input_snapshot)}
      ${snapshotPre('output_snapshot', r.output_snapshot)}
    `;

    // PR U2 + fix — rollback button click 은 renderShell 의 root delegation 에서 처리.
    // (이전 querySelector + addEventListener 방식은 button id 충돌 / re-render race
    //  / detached element listener 등 신뢰성 문제로 delegated handler 로 전환)
    // rollback chain 의 원본 링크
    const orLink = document.getElementById('sr-open-original');
    if (orLink) {
      orLink.addEventListener('click', (e) => {
        e.preventDefault();
        const oid = parseInt(orLink.dataset.originalId, 10);
        if (Number.isFinite(oid)) openDetail(oid);
      });
    }
    // PR L-3 — target deep link 버튼. 화면 이동만, row 자동 선택 X.
    el.querySelectorAll('.sr-target-nav').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.targetPage;
        if (page) navigateToPage(page);
      });
    });
  }

  // ── PR U2-fix — id → run 객체 lookup helper ──
  // delegated handler 가 id 만 알기에 cache (목록) + openRunDetail (현재 상세) 에서 검색.
  function getRunById(id) {
    if (openRunDetail && openRunDetail.id === id) return openRunDetail;
    return cache.find(r => r.id === id) || null;
  }

  // ── manual 안내 modal (PR M §2-1 A — manual 액션용 보존) ──
  // 정책: server endpoint 호출 0건, audit helper invocation 0건. 단순 안내 modal.
  function showManualRollbackModal(id) {
    const run = getRunById(id);
    if (!run) {
      alert('실행 로그를 찾을 수 없습니다 (id=' + id + ')');
      return;
    }
    const targetStr = run.target_table
      ? `${run.target_table}${run.target_id != null ? '#' + run.target_id : ''}`
      : '-';
    const infoLines = [
      `대상: ${run.action_name || run.automation_type} #${run.id}`,
      `target: ${targetStr}`,
      `rollback_method: ${run.rollback_method}`,
    ];
    if (run.rollback_hint) infoLines.push(`hint:\n${run.rollback_hint}`);

    showStubModal({
      title: '수동 되돌리기 안내',
      body:  '이 액션은 자동 되돌리기 대상이 아닙니다. 현재는 audit 메타데이터와 수동 처리 힌트만 표시합니다.',
      info:  infoLines,
    });
  }

  // ── PR U2 — 실 auto rollback modal ──
  // 정책: rollback_method='auto' + allowlist 등록 액션만 도달.
  // 클릭 → reason 입력 modal → 추가 confirm → POST /api/safety-runs/:id/rollback
  function showAutoRollbackModal(id) {
    const run = getRunById(id);
    if (!run) {
      alert('실행 로그를 찾을 수 없습니다 (id=' + id + ')');
      return;
    }
    const existing = document.getElementById('sr-auto-modal');
    if (existing) existing.remove();

    const targetStr = run.target_table
      ? `${run.target_table}${run.target_id != null ? '#' + run.target_id : ''}`
      : '-';

    const overlay = document.createElement('div');
    overlay.id = 'sr-auto-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;max-width:520px;width:100%;color:#fff;">
        <h3 style="margin:0 0 10px;font-size:16px;color:#64b5f6;">↺ 되돌리기 실행</h3>
        <div style="color:#ffcdd2;font-size:13px;margin-bottom:14px;line-height:1.5;font-weight:600;">
          ⚠️ 이 작업은 실제 데이터를 변경합니다.
        </div>
        <pre style="background:#0f0f23;color:#cfd8dc;padding:8px;border-radius:4px;font-size:11px;margin:4px 0;white-space:pre-wrap;word-break:break-all;">${esc(run.action_name || run.automation_type || '?')} #${run.id}\ntarget: ${esc(targetStr)}</pre>
        <label style="display:block;margin-top:10px;color:#aaa;font-size:11px;">사유 (선택, 최대 500자):</label>
        <textarea id="sr-auto-reason" maxlength="500" rows="3" style="width:100%;margin-top:4px;padding:6px;background:#0f0f23;border:1px solid #333;color:#cfd8dc;border-radius:4px;font-size:12px;box-sizing:border-box;"></textarea>
        <div id="sr-auto-msg" style="margin-top:10px;font-size:12px;min-height:18px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:14px;">
          <button id="sr-auto-cancel" type="button" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          <button id="sr-auto-exec" type="button" style="padding:6px 14px;background:#1565c0;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">실행</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('sr-auto-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.getElementById('sr-auto-exec').addEventListener('click', async () => {
      const reason = document.getElementById('sr-auto-reason').value.trim().slice(0, 500);
      const msgEl  = document.getElementById('sr-auto-msg');
      const execBtn   = document.getElementById('sr-auto-exec');
      const cancelBtn = document.getElementById('sr-auto-cancel');

      if (!confirm('정말 되돌리기를 실행할까요? 이 작업은 실제 DB 데이터를 변경합니다.')) return;

      execBtn.disabled = true; cancelBtn.disabled = true;
      execBtn.textContent = '실행 중...';
      msgEl.innerHTML = '<span style="color:#aaa;">서버에 되돌리기 요청 중...</span>';

      try {
        const res = await fetch('/api/safety-runs/' + run.id + '/rollback', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || null }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 서버 user-friendly error 우선 + code 표시. modal 닫지 않음 — 사용자 확인 후 취소/재시도.
          const userErr = json.error   || '되돌리기 실패';
          const code    = json.code    || `http_${res.status}`;
          const detail  = json.message || '';
          msgEl.innerHTML = `<span style="color:#ef9a9a;">되돌리기 실패: ${esc(userErr)} <span style="color:#888;font-family:monospace;font-size:10px;">(${esc(code)})</span>${detail ? `<br><span style="color:#aaa;font-size:11px;">${esc(detail)}</span>` : ''}</span>`;
          execBtn.disabled = false; cancelBtn.disabled = false;
          execBtn.textContent = '실행';
          return;
        }
        // 성공 — alert 대신 modal 내부 메시지 → 700ms 후 close + refresh
        msgEl.innerHTML = `<span style="color:#69f0ae;">✓ 되돌리기 완료. 실행 로그를 새로고침했습니다. <span style="color:#aaa;font-size:11px;">(rollback run #${json.rollbackRunId})</span></span>`;
        setTimeout(async () => {
          close();
          await openDetail(run.id);
          await refresh();
        }, 700);
      } catch (e) {
        msgEl.innerHTML = `<span style="color:#ef9a9a;">네트워크 오류: ${esc(e.message)}</span>`;
        execBtn.disabled = false; cancelBtn.disabled = false;
        execBtn.textContent = '실행';
      }
    });
  }

  function showStubModal({ title, body, info }) {
    // 기존 modal 제거 (재 클릭 대비)
    const existing = document.getElementById('sr-stub-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'sr-stub-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';

    const infoHtml = info.map(line => `<pre style="background:#0f0f23;color:#cfd8dc;padding:8px;border-radius:4px;font-size:11px;margin:4px 0;white-space:pre-wrap;word-break:break-all;">${esc(line)}</pre>`).join('');

    overlay.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;max-width:520px;width:100%;color:#fff;">
        <h3 style="margin:0 0 10px;font-size:16px;color:#ffb74d;">↺ ${esc(title)}</h3>
        <div style="color:#cfd8dc;font-size:13px;margin-bottom:14px;line-height:1.5;">${esc(body)}</div>
        ${infoHtml}
        <div style="text-align:right;margin-top:14px;">
          <button id="sr-stub-ok" type="button" style="padding:6px 16px;background:#1565c0;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;">확인</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.getElementById('sr-stub-ok').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  window.pmcSafetyRuns = { init, refresh, openDetail };
})();
