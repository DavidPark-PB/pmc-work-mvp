/**
 * Opportunity Inbox UI — PR R-Inbox UI (R0 후속)
 *
 * 책임:
 *   - GET /api/opportunity-inbox 호출 (목록 + 필터)
 *   - GET /api/opportunity-inbox/:id 호출 (상세)
 *   - POST /api/opportunity-inbox (신규 등록 — 직원/admin)
 *   - PATCH /api/opportunity-inbox/:id (notes / target_platforms 등 수정)
 *   - POST /api/opportunity-inbox/:id/approve (admin only)
 *   - POST /api/opportunity-inbox/:id/reject (admin only)
 *
 * 권한: 로그인된 모든 사용자 (R0 정책 §1-A — staff 도 본인 후보 등록/조회)
 *
 * 정책:
 *   - secret/token/raw_payload 표시 0 — service 가 이미 redact 통과
 *   - admin 전용 액션 (approve/reject) 은 user.isAdmin 일 때만 버튼 노출
 *   - validation 에러는 modal/inline 에 명확히 표시
 */
(function () {
  let user = null;
  let cache = [];
  let openId = null;
  let openDetail = null;

  // ── allowlist (R0 service 정합) ────────────────────────────────────────
  const OPPORTUNITY_TYPES = [
    ['product_sourcing',     '상품 소싱'],
    ['content_idea',         '콘텐츠 소재'],
    ['competitor_product',   '경쟁셀러 상품'],
    ['b2b_buyer',            'B2B 바이어'],
    ['qoo10_candidate',      'Qoo10 등록 후보'],
    ['shopee_candidate',     'Shopee 등록 후보'],
    ['shopify_candidate',    'Shopify 등록 후보'],
    ['alibaba_candidate',    'Alibaba 등록 후보'],
    ['proxy_shipping_issue', '대행 배송 이슈'],
    ['price_attack_candidate','가격 공세 후보'],
  ];
  const SOURCE_TYPES = [
    'bunjang','mart','competitor','staff_idea','buyer_request',
    'alibaba_inquiry','qoo10','shopee','shopify',
    'instagram','x','tiktok','youtube_shorts','xiaohongshu',
    'wechat','discord','naver_blog',
  ];
  const INPUT_CHANNELS = ['web','mobile','telegram','kakao_share','api'];
  const PLATFORMS = [
    'shopify','ebay','alibaba','qoo10','shopee',
    'naver_smartstore','coupang',
    'x','instagram','tiktok','youtube_shorts','xiaohongshu',
    'wechat','discord','naver_blog',
  ];
  const STATUSES = [
    'new','reviewing','approved','auto_handled',
    'rejected','draft_ready','assigned','published','archived',
  ];
  const PRIORITIES = ['low','normal','high','urgent'];
  const DEMAND_LEVELS = ['low','medium','high','unknown'];

  // status 색상
  const STATUS_BADGE = {
    new:          { bg:'#1a3a4a', fg:'#64b5f6', label:'new' },
    reviewing:    { bg:'#5d3a00', fg:'#ffb74d', label:'reviewing' },
    approved:     { bg:'#1b5e20', fg:'#69f0ae', label:'approved' },
    auto_handled: { bg:'#1b5e20', fg:'#a5d6a7', label:'auto_handled' },
    rejected:     { bg:'#4a1a1a', fg:'#ef9a9a', label:'rejected' },
    draft_ready:  { bg:'#37474f', fg:'#bbdefb', label:'draft_ready' },
    assigned:     { bg:'#5d3a00', fg:'#ffd54f', label:'assigned' },
    published:    { bg:'#1b5e20', fg:'#69f0ae', label:'published' },
    archived:     { bg:'#37474f', fg:'#bdbdbd', label:'archived' },
  };

  const PRIORITY_COLOR = {
    low: '#90a4ae', normal: '#cfd8dc', high: '#ffb74d', urgent: '#ef5350',
  };

  // ── helpers ────────────────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleString('ko-KR') : '-'; }
  function fmtNum(n)    { return n == null ? '-' : Number(n).toLocaleString(); }

  function badge(status) {
    const sb = STATUS_BADGE[status] || { bg:'#37474f', fg:'#bdbdbd', label:status||'?' };
    return `<span style="background:${sb.bg};color:${sb.fg};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;">${esc(sb.label)}</span>`;
  }

  function priorityBadge(p) {
    const c = PRIORITY_COLOR[p] || '#bdbdbd';
    return `<span style="color:${c};font-size:11px;font-weight:600;">${esc(p || 'normal')}</span>`;
  }

  function actionLabel(t) {
    const found = OPPORTUNITY_TYPES.find(([k]) => k === t);
    return found ? found[1] : (t || '?');
  }

  // ── entry ──────────────────────────────────────────────────────────────
  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json()).catch(()=>({}))).user;
    const root = document.getElementById('opportunity-inbox-section');
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
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">💡 후보 Inbox</h1>
        <p style="color:#888;font-size:13px;margin:0;">
          상품 소싱 / 콘텐츠 소재 / 경쟁셀러 / 발주 후보를 통합 관리. staff 는 본인 후보만, admin 은 전체.
        </p>
      </div>

      <div style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <select id="oi-filter-type"   style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
            <option value="">전체 종류</option>
            ${OPPORTUNITY_TYPES.map(([k,l]) => `<option value="${k}">${esc(l)} (${k})</option>`).join('')}
          </select>
          <select id="oi-filter-status" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
            <option value="">전체 status</option>
            ${STATUSES.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
          <select id="oi-filter-source" style="padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;">
            <option value="">전체 source</option>
            ${SOURCE_TYPES.map(s => `<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="oi-new"     type="button" style="padding:8px 14px;background:#1565c0;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">＋ 후보 등록</button>
          <button id="oi-refresh" type="button" style="padding:8px 14px;background:#37474f;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">새로고침</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1.5fr;gap:16px;align-items:start;">
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <div style="color:#aaa;font-size:11px;margin-bottom:10px;" id="oi-count">로딩 중...</div>
          <div id="oi-list"></div>
        </div>
        <div id="oi-detail" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;color:#888;">
          <div style="text-align:center;padding:40px 0;">왼쪽에서 후보를 선택하세요.</div>
        </div>
      </div>
    `;

    document.getElementById('oi-refresh').addEventListener('click', refresh);
    document.getElementById('oi-filter-type').addEventListener('change', refresh);
    document.getElementById('oi-filter-status').addEventListener('change', refresh);
    document.getElementById('oi-filter-source').addEventListener('change', refresh);
    document.getElementById('oi-new').addEventListener('click', showCreateModal);
  }

  async function refresh() {
    const root = document.getElementById('opportunity-inbox-section');
    if (!root || root.dataset.initialized !== '1') return;

    const t = document.getElementById('oi-filter-type')?.value   || '';
    const s = document.getElementById('oi-filter-status')?.value || '';
    const src = document.getElementById('oi-filter-source')?.value || '';
    const params = new URLSearchParams({ limit: '100' });
    if (t)   params.set('opportunity_type', t);
    if (s)   params.set('status',           s);
    if (src) params.set('source_type',      src);

    try {
      const res = await fetch('/api/opportunity-inbox?' + params.toString(), { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      cache = json.data || [];
      renderList();
      if (openId) {
        const stillExists = cache.find(r => r.id === openId);
        if (stillExists) await openItem(openId);
      }
    } catch (e) {
      const el = document.getElementById('oi-list');
      if (el) el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderList() {
    const el = document.getElementById('oi-list');
    const cntEl = document.getElementById('oi-count');
    if (!el) return;
    cntEl.textContent = `총 ${cache.length}건`;
    if (cache.length === 0) {
      el.innerHTML = '<div style="padding:20px;color:#888;font-size:13px;">후보 없음. 우상단 "＋ 후보 등록" 으로 첫 후보를 만드세요.</div>';
      return;
    }
    el.innerHTML = cache.map(r => {
      const isActive = r.id === openId;
      const titleStr = r.title_ko || r.title || r.title_en || `(제목 없음 #${r.id})`;
      return `
        <div class="oi-row" data-id="${r.id}" style="
          padding:10px 12px;border:1px solid ${isActive ? '#81d4fa' : '#2a2a4a'};
          border-radius:8px;margin-bottom:8px;cursor:pointer;
          background:${isActive ? '#0a1a2e' : '#0f0f23'};
        ">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
            ${badge(r.status)}
            <span style="background:#1a3a4a;color:#bbdefb;padding:1px 6px;border-radius:3px;font-size:10px;">${esc(actionLabel(r.opportunity_type))}</span>
            ${priorityBadge(r.priority)}
            <span style="margin-left:auto;color:#666;font-size:11px;">#${r.id}</span>
          </div>
          <div style="color:#fff;font-size:13px;margin-bottom:4px;line-height:1.3;">${esc(titleStr)}</div>
          <div style="color:#666;font-size:11px;">
            ${r.source_type ? esc(r.source_type) + ' · ' : ''}${fmtDate(r.created_at)}
          </div>
        </div>
      `;
    }).join('');
    el.querySelectorAll('.oi-row').forEach(div => {
      div.addEventListener('click', () => openItem(parseInt(div.dataset.id, 10)));
    });
  }

  // ── detail ─────────────────────────────────────────────────────────────
  async function openItem(id) {
    if (!Number.isFinite(id)) return;
    openId = id;
    renderList();

    const el = document.getElementById('oi-detail');
    if (!el) return;
    el.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">로딩 중...</div>';
    try {
      const res = await fetch('/api/opportunity-inbox/' + id, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `load failed (${res.status})`);
      openDetail = json.data;
      renderDetail();
    } catch (e) {
      el.innerHTML = `<div style="padding:20px;color:#ef9a9a;">상세 로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderDetail() {
    const r = openDetail;
    if (!r) return;
    const el = document.getElementById('oi-detail');
    if (!el) return;

    const isAdmin = user?.isAdmin === true;
    const isFinal = r.status === 'rejected' || r.status === 'archived' || r.status === 'published';

    const titleStr = r.title_ko || r.title || r.title_en || `(제목 없음 #${r.id})`;

    const platformsHtml = Array.isArray(r.target_platforms) && r.target_platforms.length > 0
      ? r.target_platforms.map(p => `<span style="background:#37474f;color:#bbdefb;padding:1px 6px;border-radius:3px;font-size:10px;font-family:monospace;margin-right:4px;">${esc(p)}</span>`).join('')
      : '<span style="color:#666;">-</span>';

    const linkedHtml = (r.linked_sku_id || r.linked_order_id || r.linked_task_id) ? `
      <div style="margin-top:10px;color:#aaa;font-size:11px;">
        ${r.linked_sku_id   ? `🔗 SKU #${r.linked_sku_id} · `   : ''}
        ${r.linked_order_id ? `📦 Order #${r.linked_order_id} · ` : ''}
        ${r.linked_task_id  ? `📋 Task #${r.linked_task_id}`     : ''}
      </div>
    ` : '';

    const actionsHtml = isFinal ? '' : `
      <div style="margin-top:14px;display:flex;gap:6px;flex-wrap:wrap;">
        ${isAdmin && r.status !== 'approved' ? `<button id="oi-approve" type="button" style="padding:6px 14px;background:#1b5e20;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">✓ 승인</button>` : ''}
        ${isAdmin && r.status !== 'rejected' ? `<button id="oi-reject"  type="button" style="padding:6px 14px;background:#4a1a1a;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">✗ 반려</button>` : ''}
        <button id="oi-edit-notes" type="button" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">📝 메모 수정</button>
        ${r.status !== 'archived' ? `<button id="oi-archive" type="button" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#bdbdbd;cursor:pointer;font-size:12px;">📦 보관</button>` : ''}
      </div>
    `;

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
            ${badge(r.status)}
            <span style="background:#1a3a4a;color:#bbdefb;padding:3px 8px;border-radius:3px;font-size:11px;">${esc(actionLabel(r.opportunity_type))}</span>
            ${priorityBadge(r.priority)}
            <span style="color:#666;font-size:11px;">#${r.id}</span>
          </div>
          <h2 style="color:#fff;font-size:16px;margin:0;line-height:1.3;">${esc(titleStr)}</h2>
          <div style="color:#aaa;font-size:11px;margin-top:4px;">
            ${r.source_type ? `source: ${esc(r.source_type)} · ` : ''}
            input: ${esc(r.input_channel || '-')} ·
            submitted_by user#${r.submitted_by ?? '-'}
          </div>
        </div>
        <div style="text-align:right;color:#666;font-size:11px;">
          created: ${fmtDate(r.created_at)}<br>
          updated: ${fmtDate(r.updated_at)}
        </div>
      </div>

      ${r.source_url ? `<div style="margin-bottom:10px;font-size:12px;"><a href="${esc(r.source_url)}" target="_blank" rel="noopener" style="color:#64b5f6;text-decoration:underline;">↗ 원본 링크</a></div>` : ''}

      <div style="margin-top:10px;padding:10px;background:#0f0f23;border-radius:6px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:600;">🌍 다국어 제목</div>
        <div style="color:#fff;font-size:12px;line-height:1.6;">
          ${r.title_ko ? `🇰🇷 ${esc(r.title_ko)}<br>` : ''}
          ${r.title_en ? `🇺🇸 ${esc(r.title_en)}<br>` : ''}
          ${r.title_ja ? `🇯🇵 ${esc(r.title_ja)}<br>` : ''}
          ${r.title_zh ? `🇨🇳 ${esc(r.title_zh)}` : ''}
          ${(!r.title_ko && !r.title_en && !r.title_ja && !r.title_zh) ? '<span style="color:#666;">미입력 — R1 AI Draft 에서 자동 채움 예정</span>' : ''}
        </div>
      </div>

      <div style="margin-top:10px;padding:10px;background:#0f0f23;border-radius:6px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:600;">💰 가격 / 수요</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;color:#cfd8dc;">
          <div>매입 (KRW): <strong>${fmtNum(r.expected_buy_price_krw)}</strong></div>
          <div>판매 (KRW): <strong>${fmtNum(r.expected_sell_price_krw)}</strong></div>
          <div>판매 (USD): <strong>${fmtNum(r.expected_sell_price_usd)}</strong></div>
          <div>마진율: <strong>${r.estimated_margin_rate ?? '-'}</strong></div>
          <div>brand: <strong>${esc(r.brand || '-')}</strong></div>
          <div>category: <strong>${esc(r.category || '-')}</strong></div>
          <div>수요: <strong>${esc(r.estimated_demand || '-')}</strong></div>
          <div>assigned: user#${r.assigned_to ?? '-'}</div>
        </div>
      </div>

      <div style="margin-top:10px;padding:10px;background:#0f0f23;border-radius:6px;">
        <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:600;">🎯 target platforms</div>
        <div>${platformsHtml}</div>
      </div>

      ${linkedHtml}

      ${r.notes ? `
        <div style="margin-top:10px;padding:10px;background:#0f0f23;border-radius:6px;">
          <div style="color:#aaa;font-size:11px;margin-bottom:6px;font-weight:600;">📝 notes</div>
          <div style="color:#cfd8dc;font-size:12px;white-space:pre-wrap;">${esc(r.notes)}</div>
        </div>
      ` : ''}

      ${r.status === 'rejected' && r.rejection_reason ? `
        <div style="margin-top:10px;padding:10px;background:#4a1a1a;border-radius:6px;color:#ffcdd2;font-size:12px;">
          반려 사유: ${esc(r.rejection_reason)}
        </div>
      ` : ''}

      ${r.status === 'approved' && r.approved_at ? `
        <div style="margin-top:10px;padding:10px;background:#1b5e20;border-radius:6px;color:#a5d6a7;font-size:12px;">
          ✓ 승인됨 — by user#${r.approved_by ?? '-'} · ${fmtDate(r.approved_at)}
        </div>
      ` : ''}

      ${actionsHtml}
    `;

    // action handlers
    document.getElementById('oi-approve')?.addEventListener('click', () => doApprove(r.id));
    document.getElementById('oi-reject') ?.addEventListener('click', () => showRejectModal(r.id));
    document.getElementById('oi-archive')?.addEventListener('click', () => doArchive(r.id));
    document.getElementById('oi-edit-notes')?.addEventListener('click', () => showNotesModal(r));
  }

  async function doApprove(id) {
    if (!confirm('이 후보를 승인합니까?')) return;
    try {
      const res = await fetch('/api/opportunity-inbox/' + id + '/approve', {
        method: 'POST', credentials: 'include',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `failed (${res.status})`);
      await refresh();
    } catch (e) {
      alert('승인 실패: ' + e.message);
    }
  }

  function showRejectModal(id) {
    const reason = prompt('반려 사유 (필수, 최대 500자):');
    if (reason == null) return; // 취소
    const r = String(reason).trim().slice(0, 500);
    if (!r) { alert('반려 사유를 입력하세요'); return; }
    doReject(id, r);
  }

  async function doReject(id, reason) {
    try {
      const res = await fetch('/api/opportunity-inbox/' + id + '/reject', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `failed (${res.status})`);
      await refresh();
    } catch (e) {
      alert('반려 실패: ' + e.message);
    }
  }

  async function doArchive(id) {
    if (!confirm('이 후보를 보관 (archived) 합니까?')) return;
    try {
      const res = await fetch('/api/opportunity-inbox/' + id, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `failed (${res.status})`);
      await refresh();
    } catch (e) {
      alert('보관 실패: ' + e.message);
    }
  }

  function showNotesModal(run) {
    const cur = run.notes || '';
    const next = prompt('메모 수정:', cur);
    if (next == null) return;
    doPatch(run.id, { notes: next.trim() || null });
  }

  async function doPatch(id, patch) {
    try {
      const res = await fetch('/api/opportunity-inbox/' + id, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `failed (${res.status})`);
      await refresh();
    } catch (e) {
      alert('수정 실패: ' + e.message);
    }
  }

  // ── 신규 등록 modal ────────────────────────────────────────────────────
  function showCreateModal() {
    const existing = document.getElementById('oi-create-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'oi-create-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
    overlay.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;max-width:560px;width:100%;color:#fff;max-height:90vh;overflow-y:auto;">
        <h3 style="margin:0 0 14px;font-size:16px;color:#64b5f6;">＋ 새 후보 등록</h3>

        <div style="display:grid;gap:10px;font-size:12px;">
          <label>후보 종류 <span style="color:#ef9a9a;">*</span>
            <select id="oc-type" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
              ${OPPORTUNITY_TYPES.map(([k,l]) => `<option value="${k}">${esc(l)} (${k})</option>`).join('')}
            </select>
          </label>

          <label>출처 source
            <select id="oc-source" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
              <option value="">(선택)</option>
              ${SOURCE_TYPES.map(s => `<option value="${s}">${s}</option>`).join('')}
            </select>
          </label>

          <label>입력 채널
            <select id="oc-channel" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
              ${INPUT_CHANNELS.map(c => `<option value="${c}" ${c==='web'?'selected':''}>${c}</option>`).join('')}
            </select>
          </label>

          <label>제목 (한국어)
            <input id="oc-title-ko" type="text" maxlength="255" placeholder="예: 포켓몬 151 부스터박스" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;box-sizing:border-box;">
          </label>

          <label>출처 URL
            <input id="oc-url" type="text" placeholder="https://..." style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;box-sizing:border-box;">
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label>매입가 (KRW)
              <input id="oc-buy-krw" type="number" min="0" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;box-sizing:border-box;">
            </label>
            <label>판매가 (USD)
              <input id="oc-sell-usd" type="number" min="0" step="0.01" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;box-sizing:border-box;">
            </label>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label>수요
              <select id="oc-demand" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
                <option value="">(선택)</option>
                ${DEMAND_LEVELS.map(d => `<option value="${d}">${d}</option>`).join('')}
              </select>
            </label>
            <label>우선순위
              <select id="oc-priority" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
                ${PRIORITIES.map(p => `<option value="${p}" ${p==='normal'?'selected':''}>${p}</option>`).join('')}
              </select>
            </label>
          </div>

          <label>target platforms (Ctrl/Cmd + 클릭 다중)
            <select id="oc-platforms" multiple size="6" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;">
              ${PLATFORMS.map(p => `<option value="${p}">${p}</option>`).join('')}
            </select>
          </label>

          <label>메모
            <textarea id="oc-notes" rows="3" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;color:#fff;border-radius:4px;font-size:12px;margin-top:2px;box-sizing:border-box;"></textarea>
          </label>
        </div>

        <div id="oc-msg" style="margin-top:10px;font-size:12px;min-height:18px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:14px;">
          <button id="oc-cancel" type="button" style="padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          <button id="oc-submit" type="button" style="padding:6px 14px;background:#1565c0;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">등록</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('oc-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    document.getElementById('oc-submit').addEventListener('click', async () => {
      const msgEl = document.getElementById('oc-msg');
      const submitBtn = document.getElementById('oc-submit');
      const cancelBtn = document.getElementById('oc-cancel');

      const targetEl = document.getElementById('oc-platforms');
      const target_platforms = Array.from(targetEl.selectedOptions).map(o => o.value);

      const body = {
        opportunity_type:       document.getElementById('oc-type').value,
        source_type:            document.getElementById('oc-source').value || null,
        input_channel:          document.getElementById('oc-channel').value,
        source_url:             document.getElementById('oc-url').value.trim() || null,
        title_ko:               document.getElementById('oc-title-ko').value.trim() || null,
        expected_buy_price_krw: document.getElementById('oc-buy-krw').value || null,
        expected_sell_price_usd:document.getElementById('oc-sell-usd').value || null,
        estimated_demand:       document.getElementById('oc-demand').value || null,
        priority:               document.getElementById('oc-priority').value,
        target_platforms:       target_platforms.length > 0 ? target_platforms : null,
        notes:                  document.getElementById('oc-notes').value.trim() || null,
      };

      submitBtn.disabled = true; cancelBtn.disabled = true;
      submitBtn.textContent = '등록 중...';
      msgEl.innerHTML = '<span style="color:#aaa;">서버 등록 중...</span>';

      try {
        const res = await fetch('/api/opportunity-inbox', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          msgEl.innerHTML = `<span style="color:#ef9a9a;">등록 실패: ${esc(json.error || 'unknown')}</span>`;
          submitBtn.disabled = false; cancelBtn.disabled = false;
          submitBtn.textContent = '등록';
          return;
        }
        msgEl.innerHTML = `<span style="color:#69f0ae;">✓ 등록 완료 — id #${json.data.id}</span>`;
        setTimeout(async () => {
          close();
          await refresh();
          if (json.data?.id) await openItem(json.data.id);
        }, 600);
      } catch (e) {
        msgEl.innerHTML = `<span style="color:#ef9a9a;">네트워크 오류: ${esc(e.message)}</span>`;
        submitBtn.disabled = false; cancelBtn.disabled = false;
        submitBtn.textContent = '등록';
      }
    });
  }

  window.pmcOpportunityInbox = { init, refresh, openItem };
})();
