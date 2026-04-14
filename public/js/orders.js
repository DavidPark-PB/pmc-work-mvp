/**
 * 발주 관리 (Phase 2) — /api/purchase-requests
 */
(function() {
  let user = null;
  let refreshTimer = null;
  const REJECT_LABELS = { out_of_stock: '품절', discontinued: '단종', budget: '예산 부족', price_review: '가격 검토 필요', other: '기타' };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(n) { if (n == null || n === '') return '-'; return Number(n).toLocaleString('ko-KR') + '원'; }
  function dt(iso) { if (!iso) return ''; const d = new Date(iso); const pad = n => String(n).padStart(2,'0'); return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.getElementById('page-orders').classList.contains('active')) refresh();
    }, 30000);
  }

  function renderShell() {
    const el = document.getElementById('page-orders');
    const statsBar = user.isAdmin ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
        <div style="background:#1a1a2e;border-left:3px solid #e94560;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">긴급 대기</div>
          <div id="po-urgent" style="font-size:24px;font-weight:700;color:#ff8a80;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #ffa726;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">대기중</div>
          <div id="po-pending" style="font-size:24px;font-weight:700;color:#ffb74d;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #4caf50;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">승인됨</div>
          <div id="po-approved" style="font-size:24px;font-weight:700;color:#81c784;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #555;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">반려됨</div>
          <div id="po-rejected" style="font-size:24px;font-weight:700;color:#aaa;">-</div>
        </div>
      </div>` : '';

    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">🛒 발주 관리</h1>
        <p style="color:#888;font-size:13px;">${user.isAdmin ? '발주 요청 승인/반려 관리' : '상품 발주 요청 및 처리 현황'}</p>
      </div>
      ${statsBar}

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">➕ 발주 요청</h3>
        <form id="po-form">
          <input type="text" id="po-product" placeholder="상품명" required maxlength="500" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:10px;">
            <input type="number" id="po-qty" placeholder="수량" min="1" required style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="number" id="po-price" placeholder="예상 금액 (원)" min="0" step="100" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="po-priority" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="normal">일반</option>
              <option value="urgent">🚨 긴급</option>
            </select>
          </div>
          <textarea id="po-reason" placeholder="사유 (재고 부족, 주문 밀림 등)" rows="2" maxlength="2000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">요청</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="color:#fff;">${user.isAdmin ? '전체 발주' : '내 발주 내역'}</h3>
          <select id="po-filter" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="">전체</option>
            <option value="pending">대기중</option>
            <option value="approved">승인됨</option>
            <option value="rejected">반려됨</option>
          </select>
        </div>
        <div id="po-list"></div>
      </div>
    `;

    document.getElementById('po-form').addEventListener('submit', submitOrder);
    document.getElementById('po-filter').addEventListener('change', refresh);
  }

  async function refresh() {
    const status = document.getElementById('po-filter')?.value;
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const res = await fetch('/api/purchase-requests?' + params);
    const { data } = await res.json();
    renderList(data || []);
    if (user.isAdmin) {
      const s = await fetch('/api/purchase-requests/stats').then(r => r.json());
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('po-urgent', s.pendingUrgent);
      set('po-pending', s.pending);
      set('po-approved', s.approved);
      set('po-rejected', s.rejected);
    }
  }

  function renderList(items) {
    const c = document.getElementById('po-list');
    if (items.length === 0) { c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">발주 요청이 없습니다.</div>'; return; }
    const statusBadge = { pending: '<span style="padding:2px 8px;background:#ffa726;color:#fff;border-radius:10px;font-size:11px;">대기중</span>', approved: '<span style="padding:2px 8px;background:#4caf50;color:#fff;border-radius:10px;font-size:11px;">승인</span>', rejected: '<span style="padding:2px 8px;background:#555;color:#fff;border-radius:10px;font-size:11px;">반려</span>' };
    c.innerHTML = items.map(o => {
      const urgent = o.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;margin-right:6px;">🚨 긴급</span>' : '';
      return `
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:600;font-size:15px;color:#fff;margin-bottom:4px;">
              ${urgent}${esc(o.product_name)} <span style="color:#888;font-weight:400;">× ${o.quantity}</span>
              ${statusBadge[o.status]}
            </div>
            <div style="font-size:12px;color:#888;display:flex;gap:10px;flex-wrap:wrap;">
              ${user.isAdmin ? `<span>👤 ${esc(o.requester?.display_name || '-')}</span>` : ''}
              <span>💰 ${money(o.estimated_price)}</span>
              <span>⏰ ${dt(o.requested_at)}</span>
            </div>
            ${o.reason ? `<div style="margin-top:6px;font-size:12px;color:#b0b0b0;white-space:pre-wrap;">${esc(o.reason)}</div>` : ''}
            ${o.status === 'rejected' ? `<div style="margin-top:6px;padding:6px 10px;background:#2a1a1a;border-radius:6px;font-size:12px;"><strong style="color:#ff8a80;">반려:</strong> ${REJECT_LABELS[o.rejection_reason] || o.rejection_reason || '-'}${o.rejection_note ? ' — ' + esc(o.rejection_note) : ''}</div>` : ''}
            ${o.status === 'approved' ? `<div style="margin-top:4px;font-size:12px;color:#81c784;">✓ ${dt(o.decision_at)} 승인</div>` : ''}
          </div>
          ${user.isAdmin && o.status === 'pending' ? `
            <div style="display:flex;flex-direction:column;gap:6px;">
              <button onclick="pmcOrders.approve(${o.id})" style="padding:6px 12px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ 승인</button>
              <button onclick="pmcOrders.openReject(${o.id})" style="padding:6px 12px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">✗ 반려</button>
            </div>` : ''}
        </div>
      `;
    }).join('');
  }

  async function submitOrder(e) {
    e.preventDefault();
    const payload = {
      productName: document.getElementById('po-product').value.trim(),
      quantity: document.getElementById('po-qty').value,
      estimatedPrice: document.getElementById('po-price').value || undefined,
      priority: document.getElementById('po-priority').value,
      reason: document.getElementById('po-reason').value.trim() || undefined,
    };
    const res = await fetch('/api/purchase-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    document.getElementById('po-form').reset();
    refresh();
  }

  async function approve(id) {
    if (!confirm('이 발주를 승인하시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/approve`, { method: 'PATCH' });
    if (!res.ok) { alert('승인 실패'); return; }
    refresh();
  }

  function openReject(id) {
    const reason = prompt('반려 사유를 선택하세요:\n1. 품절\n2. 단종\n3. 예산 부족\n4. 가격 검토 필요\n5. 기타\n\n번호 입력:');
    const map = { '1': 'out_of_stock', '2': 'discontinued', '3': 'budget', '4': 'price_review', '5': 'other' };
    const reasonKey = map[reason];
    if (!reasonKey) return;
    const note = prompt('메모 (선택):') || '';
    submitReject(id, reasonKey, note);
  }

  async function submitReject(id, reason, note) {
    const res = await fetch(`/api/purchase-requests/${id}/reject`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, note }),
    });
    if (!res.ok) { alert((await res.json()).error || '반려 실패'); return; }
    refresh();
  }

  window.pmcOrders = { load, refresh, approve, openReject };
})();
