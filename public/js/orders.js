/**
 * 발주 관리 (Phase 2) — /api/purchase-requests
 */
(function() {
  let user = null;
  let refreshTimer = null;
  let cachedOrders = [];
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
        <div style="background:#1a1a2e;border-left:3px solid #1565c0;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">주문완료</div>
          <div id="po-ordered" style="font-size:24px;font-weight:700;color:#64b5f6;">-</div>
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
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
            <label style="padding:7px 12px;background:#2a2a4a;border-radius:6px;color:#aaa;cursor:pointer;font-size:12px;">
              📷 참고 이미지 (최대 5장)
              <input type="file" id="po-images" multiple accept="image/*" style="display:none;" onchange="pmcOrders.previewNewImages()">
            </label>
            <span id="po-images-count" style="color:#888;font-size:11px;"></span>
          </div>
          <div id="po-images-preview" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;"></div>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">요청</button>
        </form>
      </div>

      <!-- 📊 재고 추천 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;margin-bottom:16px;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <h3 style="color:#fff;">📊 발주 이력 기반 재고 추천 <span style="color:#888;font-size:11px;font-weight:400;">· 최근 90일</span></h3>
          <button onclick="pmcOrders.toggleInsights()" id="po-insights-toggle" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">▼ 펼치기</button>
        </div>
        <div id="po-insights" style="display:none;"></div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <h3 style="color:#fff;">📋 발주 내역 <span style="color:#888;font-size:11px;font-weight:400;">· 전 직원 공유</span></h3>
          <div style="display:flex;gap:6px;">
            <select id="po-scope" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="">전 직원</option>
              <option value="mine">내 요청만</option>
            </select>
            <select id="po-filter" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="">전체 상태</option>
              <option value="pending">대기중</option>
              <option value="approved">승인됨</option>
              <option value="ordered">주문완료</option>
              <option value="rejected">반려됨</option>
            </select>
          </div>
        </div>
        <div id="po-list"></div>
      </div>
    `;

    document.getElementById('po-form').addEventListener('submit', submitOrder);
    document.getElementById('po-filter').addEventListener('change', refresh);
    document.getElementById('po-scope').addEventListener('change', refresh);
  }

  async function refresh() {
    const status = document.getElementById('po-filter')?.value;
    const scope = document.getElementById('po-scope')?.value;
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (scope) params.set('scope', scope);
    const res = await fetch('/api/purchase-requests?' + params);
    const { data } = await res.json();
    renderList(data || []);
    if (user.isAdmin) {
      const s = await fetch('/api/purchase-requests/stats').then(r => r.json());
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('po-urgent', s.pendingUrgent);
      set('po-pending', s.pending);
      set('po-approved', s.approved);
      set('po-ordered', s.ordered ?? 0);
      set('po-rejected', s.rejected);
    }
    // insights 패널 열려 있으면 갱신
    const insightsPanel = document.getElementById('po-insights');
    if (insightsPanel && insightsPanel.style.display !== 'none') loadInsights();
  }

  async function toggleInsights() {
    const panel = document.getElementById('po-insights');
    const btn = document.getElementById('po-insights-toggle');
    if (panel.style.display === 'none') {
      panel.style.display = 'block';
      btn.textContent = '▲ 접기';
      await loadInsights();
    } else {
      panel.style.display = 'none';
      btn.textContent = '▼ 펼치기';
    }
  }

  async function loadInsights() {
    const panel = document.getElementById('po-insights');
    panel.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">분석 중…</div>';
    try {
      const { products } = await fetch('/api/purchase-requests/insights').then(r => r.json());
      if (!products || products.length === 0) {
        panel.innerHTML = '<div style="padding:30px;text-align:center;color:#888;">최근 90일 발주 이력이 부족합니다. 발주가 쌓이면 자동으로 추천이 표시됩니다.</div>';
        return;
      }
      panel.innerHTML = `
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:12px;">
          <thead>
            <tr style="background:#0f0f23;">
              <th style="padding:8px;text-align:left;">상품명</th>
              <th style="padding:8px;text-align:center;">요청 횟수</th>
              <th style="padding:8px;text-align:center;">총 수량</th>
              <th style="padding:8px;text-align:center;">평균 수량</th>
              <th style="padding:8px;text-align:center;">평균 간격</th>
              <th style="padding:8px;text-align:center;">최근 요청</th>
              <th style="padding:8px;text-align:center;">평균 단가</th>
              <th style="padding:8px;text-align:right;background:#1a2a3a;">🎯 권장 재고</th>
            </tr>
          </thead>
          <tbody>
            ${products.slice(0, 30).map(p => `
              <tr style="border-bottom:1px solid #2a2a4a;">
                <td style="padding:8px;"><strong>${esc(p.name)}</strong></td>
                <td style="padding:8px;text-align:center;">${p.requestCount}회 ${p.urgentCount > 0 ? `<span style="color:#e94560;">(🚨${p.urgentCount})</span>` : ''}</td>
                <td style="padding:8px;text-align:center;">${p.totalQty}</td>
                <td style="padding:8px;text-align:center;">${p.avgQty}</td>
                <td style="padding:8px;text-align:center;">${p.avgIntervalDays != null ? p.avgIntervalDays + '일' : '-'}</td>
                <td style="padding:8px;text-align:center;color:#aaa;">${dt(p.lastRequestedAt)}</td>
                <td style="padding:8px;text-align:center;">${p.avgPrice != null ? money(p.avgPrice) : '-'}</td>
                <td style="padding:8px;text-align:right;background:#1a2a3a;color:#81d4fa;font-weight:700;font-size:14px;">${p.suggestedStock}개</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="padding:10px 16px;color:#888;font-size:11px;border-top:1px solid #2a2a4a;">
          권장 재고 = 최근 60일 월평균 수량 × 1.5 (안전재고 버퍼). 최소 3개.
        </div>
      `;
    } catch (e) {
      panel.innerHTML = '<div style="padding:20px;color:#ff8a80;">분석 실패: ' + (e.message || '') + '</div>';
    }
  }

  function renderList(items) {
    const c = document.getElementById('po-list');
    if (items.length === 0) { c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">발주 요청이 없습니다.</div>'; return; }
    const statusBadge = {
      pending: '<span style="padding:2px 8px;background:#ffa726;color:#fff;border-radius:10px;font-size:11px;">대기중</span>',
      approved: '<span style="padding:2px 8px;background:#4caf50;color:#fff;border-radius:10px;font-size:11px;">승인</span>',
      ordered: '<span style="padding:2px 8px;background:#1565c0;color:#fff;border-radius:10px;font-size:11px;">주문완료</span>',
      rejected: '<span style="padding:2px 8px;background:#555;color:#fff;border-radius:10px;font-size:11px;">반려</span>',
    };
    cachedOrders = items;
    c.innerHTML = items.map(o => {
      const urgent = o.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;margin-right:6px;">🚨 긴급</span>' : '';
      const canUnorder = o.status === 'ordered' && (user.isAdmin || o.ordered_by === user.id);
      const canEdit = user.isAdmin || (o.requested_by === user.id && o.status === 'pending');
      const attCount = o.attachment_count || 0;
      const attBadge = attCount > 0
        ? `<button onclick="pmcOrders.toggleImages(${o.id})" style="margin-left:6px;padding:2px 8px;background:#2a4a6a;border:0;border-radius:10px;color:#fff;cursor:pointer;font-size:11px;">📷 ${attCount}</button>`
        : '';
      return `
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:600;font-size:15px;color:#fff;margin-bottom:4px;">
              ${urgent}${esc(o.product_name)} <span style="color:#888;font-weight:400;">× ${o.quantity}</span>
              ${statusBadge[o.status] || ''}${attBadge}
            </div>
            <div style="font-size:12px;color:#888;display:flex;gap:10px;flex-wrap:wrap;">
              <span style="color:#81d4fa;">👤 ${esc(o.requester?.display_name || '-')}${o.requester?.platform ? ' · ' + esc(o.requester.platform) : ''}</span>
              <span>💰 ${money(o.estimated_price)}</span>
              <span>⏰ ${dt(o.requested_at)}</span>
            </div>
            ${o.reason ? `<div style="margin-top:6px;font-size:12px;color:#b0b0b0;white-space:pre-wrap;">${esc(o.reason)}</div>` : ''}
            ${o.status === 'rejected' ? `<div style="margin-top:6px;padding:6px 10px;background:#2a1a1a;border-radius:6px;font-size:12px;"><strong style="color:#ff8a80;">반려:</strong> ${REJECT_LABELS[o.rejection_reason] || o.rejection_reason || '-'}${o.rejection_note ? ' — ' + esc(o.rejection_note) : ''}</div>` : ''}
            ${o.status === 'approved' ? `<div style="margin-top:4px;font-size:12px;color:#81c784;">✓ ${dt(o.decision_at)} 승인</div>` : ''}
            ${o.status === 'ordered' ? `<div style="margin-top:4px;font-size:12px;color:#64b5f6;">📦 ${dt(o.ordered_at)} · ${esc(o.orderer?.display_name || '-')} 주문</div>` : ''}
            <div id="po-images-${o.id}" style="display:none;margin-top:8px;"></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${canEdit ? `
              <button onclick="pmcOrders.openEdit(${o.id})" style="padding:4px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️ 수정</button>
            ` : ''}
            ${o.status === 'approved' ? `
              <button onclick="pmcOrders.markOrdered(${o.id})" style="padding:6px 12px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">📦 주문완료</button>
            ` : ''}
            ${canUnorder ? `
              <button onclick="pmcOrders.unorder(${o.id})" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#aaa;cursor:pointer;font-size:11px;">↶ 되돌리기</button>
            ` : ''}
            ${user.isAdmin && o.status === 'pending' ? `
              <button onclick="pmcOrders.approve(${o.id})" style="padding:6px 12px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ 승인</button>
              <button onclick="pmcOrders.openReject(${o.id})" style="padding:6px 12px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">✗ 반려</button>
            ` : ''}
            ${user.isAdmin ? `
              <button onclick="pmcOrders.del(${o.id})" title="삭제" style="padding:6px 12px;background:#2a2a4a;border:0;border-radius:4px;color:#aaa;cursor:pointer;font-size:12px;">🗑 삭제</button>
            ` : ''}
          </div>
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
    const { data: created } = await res.json();

    // 이미지가 선택되었다면 업로드 (실패해도 발주 자체는 생성된 상태)
    const fileInput = document.getElementById('po-images');
    const files = fileInput?.files;
    if (files && files.length > 0 && created?.id) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      try {
        const upRes = await fetch(`/api/purchase-requests/${created.id}/attachments`, {
          method: 'POST', body: fd,
        });
        if (!upRes.ok) {
          const err = await upRes.json().catch(() => ({}));
          alert('발주는 저장되었지만 이미지 업로드 실패: ' + (err.error || upRes.statusText) + '\n수정 화면에서 다시 시도할 수 있습니다.');
        }
      } catch (e) {
        alert('발주는 저장되었지만 이미지 업로드 실패: ' + e.message);
      }
    }

    document.getElementById('po-form').reset();
    document.getElementById('po-images-preview').innerHTML = '';
    document.getElementById('po-images-count').textContent = '';
    refresh();
  }

  function previewNewImages() {
    const input = document.getElementById('po-images');
    const files = Array.from(input?.files || []);
    const host = document.getElementById('po-images-preview');
    const count = document.getElementById('po-images-count');

    if (files.length > 5) {
      alert('이미지는 최대 5장까지 선택 가능합니다. 앞 5장만 사용됩니다.');
    }
    const picked = files.slice(0, 5);
    count.textContent = picked.length > 0 ? `${picked.length}장 선택됨` : '';
    host.innerHTML = picked.map((f, i) => {
      const url = URL.createObjectURL(f);
      return `<img src="${url}" alt="preview ${i+1}" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #333;">`;
    }).join('');
  }

  async function toggleImages(id) {
    const host = document.getElementById(`po-images-${id}`);
    if (!host) return;
    if (host.style.display !== 'none') {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    host.innerHTML = '<div style="color:#888;font-size:11px;">로딩…</div>';
    try {
      const { data } = await fetch(`/api/purchase-requests/${id}/attachments`).then(r => r.json());
      if (!data || data.length === 0) {
        host.innerHTML = '<div style="color:#666;font-size:11px;">첨부 이미지 없음</div>';
        return;
      }
      // 각 이미지마다 서명 URL 요청 → 썸네일 표시
      const urls = await Promise.all(data.map(att =>
        fetch(`/api/purchase-requests/${id}/attachments/${att.id}/url`).then(r => r.json()).then(j => ({ ...att, signedUrl: j.signedUrl }))
      ));
      host.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;">${urls.map(a => `
        <a href="${a.signedUrl}" target="_blank" rel="noopener" title="${esc(a.fileName)}">
          <img src="${a.signedUrl}" loading="lazy" alt="${esc(a.fileName)}" style="width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid #333;cursor:zoom-in;">
        </a>
      `).join('')}</div>`;
    } catch (e) {
      host.innerHTML = `<div style="color:#ff8a80;font-size:11px;">이미지 로드 실패: ${esc(e.message)}</div>`;
    }
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

  async function del(id) {
    if (!confirm('이 발주 내역을 삭제하시겠습니까? 되돌릴 수 없습니다.')) return;
    const res = await fetch(`/api/purchase-requests/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    refresh();
  }

  async function markOrdered(id) {
    if (!confirm('이 항목을 주문완료 처리하시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/order`, { method: 'PATCH' });
    if (!res.ok) { alert((await res.json()).error || '처리 실패'); return; }
    refresh();
  }

  async function unorder(id) {
    if (!confirm('주문완료 체크를 되돌리시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/unorder`, { method: 'PATCH' });
    if (!res.ok) { alert((await res.json()).error || '되돌리기 실패'); return; }
    refresh();
  }

  // ── 요청 내용 수정 ──
  function openEdit(id) {
    const o = cachedOrders.find(x => x.id === id);
    if (!o) return;
    const existing = document.getElementById('po-edit-modal');
    if (existing) existing.remove();

    const urgentOpt = o.priority === 'urgent' ? 'selected' : '';
    const normalOpt = o.priority !== 'urgent' ? 'selected' : '';

    const m = document.createElement('div');
    m.id = 'po-edit-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:460px;max-width:95vw;color:#e0e0e0;">
        <h3 style="color:#fff;font-size:15px;margin:0 0 14px;">✏️ 발주 요청 수정</h3>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">상품명</label>
        <input id="po-edit-product" type="text" maxlength="500" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;font-size:13px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px;">
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">수량</label>
            <input id="po-edit-qty" type="number" min="1" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">예상 금액 (원)</label>
            <input id="po-edit-price" type="number" min="0" step="100" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">우선순위</label>
            <select id="po-edit-priority" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
              <option value="normal" ${normalOpt}>일반</option>
              <option value="urgent" ${urgentOpt}>🚨 긴급</option>
            </select>
          </div>
        </div>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">사유</label>
        <textarea id="po-edit-reason" rows="3" maxlength="2000" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;resize:vertical;font-family:inherit;"></textarea>

        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a4a;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <label style="font-size:12px;color:#aaa;">📷 참고 이미지</label>
            <label style="padding:5px 10px;background:#2a2a4a;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">
              + 이미지 추가
              <input type="file" id="po-edit-add-images" multiple accept="image/*" style="display:none;" onchange="pmcOrders.uploadMoreImages(${id})">
            </label>
          </div>
          <div id="po-edit-images" style="display:flex;gap:6px;flex-wrap:wrap;"><div style="color:#666;font-size:11px;">로딩…</div></div>
        </div>

        <div id="po-edit-error" style="display:none;margin-top:10px;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px;">
          <button onclick="pmcOrders.closeEdit()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          <button id="po-edit-save" onclick="pmcOrders.saveEdit(${id})" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById('po-edit-product').value = o.product_name || '';
    document.getElementById('po-edit-qty').value = o.quantity || 1;
    document.getElementById('po-edit-price').value = o.estimated_price || '';
    document.getElementById('po-edit-reason').value = o.reason || '';
    document.getElementById('po-edit-product').focus();
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    loadEditImages(id);
  }

  async function loadEditImages(id) {
    const host = document.getElementById('po-edit-images');
    if (!host) return;
    try {
      const { data } = await fetch(`/api/purchase-requests/${id}/attachments`).then(r => r.json());
      if (!data || data.length === 0) {
        host.innerHTML = '<div style="color:#666;font-size:11px;">첨부된 이미지 없음 (최대 5장)</div>';
        return;
      }
      const withUrls = await Promise.all(data.map(att =>
        fetch(`/api/purchase-requests/${id}/attachments/${att.id}/url`).then(r => r.json()).then(j => ({ ...att, signedUrl: j.signedUrl }))
      ));
      host.innerHTML = withUrls.map(a => `
        <div style="position:relative;width:80px;height:80px;">
          <a href="${a.signedUrl}" target="_blank" rel="noopener">
            <img src="${a.signedUrl}" alt="${esc(a.fileName)}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #333;cursor:zoom-in;">
          </a>
          <button onclick="pmcOrders.removeEditImage(${id}, ${a.id})" title="삭제" style="position:absolute;top:-6px;right:-6px;width:22px;height:22px;background:#e94560;border:0;border-radius:11px;color:#fff;cursor:pointer;font-size:12px;line-height:1;padding:0;">×</button>
        </div>
      `).join('') + `<div style="color:#888;font-size:10px;align-self:center;margin-left:6px;">${withUrls.length}/5</div>`;
    } catch (e) {
      host.innerHTML = `<div style="color:#ff8a80;font-size:11px;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  async function uploadMoreImages(id) {
    const input = document.getElementById('po-edit-add-images');
    const files = Array.from(input?.files || []);
    if (files.length === 0) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const host = document.getElementById('po-edit-images');
    if (host) host.innerHTML = '<div style="color:#888;font-size:11px;">업로드 중…</div>';
    try {
      const res = await fetch(`/api/purchase-requests/${id}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('업로드 실패: ' + (err.error || res.statusText));
      }
    } catch (e) {
      alert('업로드 실패: ' + e.message);
    }
    input.value = '';
    loadEditImages(id);
    refresh();
  }

  async function removeEditImage(requestId, attId) {
    if (!confirm('이 이미지를 삭제하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/purchase-requests/${requestId}/attachments/${attId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('삭제 실패: ' + (err.error || res.statusText));
        return;
      }
      loadEditImages(requestId);
      refresh();
    } catch (e) {
      alert('삭제 실패: ' + e.message);
    }
  }

  function closeEdit() {
    document.getElementById('po-edit-modal')?.remove();
  }

  async function saveEdit(id) {
    const errEl = document.getElementById('po-edit-error');
    errEl.style.display = 'none';
    const payload = {
      productName: document.getElementById('po-edit-product').value.trim(),
      quantity: document.getElementById('po-edit-qty').value,
      estimatedPrice: document.getElementById('po-edit-price').value || null,
      priority: document.getElementById('po-edit-priority').value,
      reason: document.getElementById('po-edit-reason').value.trim(),
    };
    if (!payload.productName) { errEl.textContent = '상품명을 입력하세요'; errEl.style.display = 'block'; return; }
    const btn = document.getElementById('po-edit-save');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const res = await fetch(`/api/purchase-requests/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || '수정 실패'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = '저장'; return; }
      closeEdit();
      refresh();
    } catch (e) {
      errEl.textContent = e.message || '네트워크 오류';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '저장';
    }
  }

  window.pmcOrders = {
    load, refresh, approve, openReject, del, toggleInsights, markOrdered, unorder,
    openEdit, closeEdit, saveEdit,
    previewNewImages, toggleImages, uploadMoreImages, removeEditImage,
  };
})();
