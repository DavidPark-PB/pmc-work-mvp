/**
 * 활성 TCG 리드 관리 (Phase 7) — contacted/replied/negotiating 상태.
 * 팔로업 오버듀 하이라이트 + 연락 기록 · B2B 바이어 전환.
 */
(function() {
  let user = null;
  let cached = [];
  let stats = { byStatus: {}, today: 0, overdue: 0, total: 0 };
  let filterStatus = '';
  let filterPlatform = '';
  let searchQuery = '';

  const PLATFORMS = [
    { key: 'tcgplayer', label: 'TCGPlayer' },
    { key: 'cardmarket', label: 'Cardmarket' },
    { key: 'ebay', label: 'eBay' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'twitter', label: 'X/Twitter' },
    { key: 'discord', label: 'Discord' },
    { key: 'shopify', label: 'Shopify' },
    { key: 'youtube', label: 'YouTube' },
    { key: 'reddit', label: 'Reddit' },
    { key: 'other', label: '기타' },
  ];

  const STATUS_META = {
    contacted:   { label: '📤 연락함',   bg: '#f39c12' },
    replied:     { label: '📬 답장받음',  bg: '#1565c0' },
    negotiating: { label: '💼 협상중',   bg: '#27ae60' },
  };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function platformLabel(k) { return PLATFORMS.find(p => p.key === k)?.label || k; }
  function today() { return new Date().toISOString().slice(0, 10); }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-prospects-active');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">💬 활성 리드 관리 <span style="color:#888;font-weight:400;font-size:13px;">· 주고받는 중인 TCG 셀러</span></h1>
        <p style="color:#888;font-size:13px;">콜드 → 연락 시작한 리드들. 팔로업 · 상태 전환 · 메시지 요약 관리. B2B 바이어 전환 버튼으로 실제 거래처 등록.</p>
      </div>

      <div id="pa-summary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;"></div>

      <div id="pa-followup-banner" style="display:none;background:#3a2a00;border:1px solid #aa6600;border-radius:8px;padding:10px 14px;margin-bottom:12px;color:#ffcc66;font-size:13px;"></div>

      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap;">
        <select id="pa-status" onchange="pmcProspectsActive.onStatusChange(this.value)" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="">전체 상태</option>
          <option value="contacted">📤 연락함</option>
          <option value="replied">📬 답장받음</option>
          <option value="negotiating">💼 협상중</option>
        </select>
        <select id="pa-platform" onchange="pmcProspectsActive.onPlatformChange(this.value)" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="">전체 출처</option>
          ${PLATFORMS.map(p => `<option value="${p.key}">${p.label}</option>`).join('')}
        </select>
        <input type="search" id="pa-search" placeholder="🔍 이름·회사·요약·메모" oninput="pmcProspectsActive.onSearch(this.value)" style="flex:1;min-width:200px;padding:7px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
      </div>

      <div id="pa-list" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:auto;"></div>
    `;
  }

  async function refresh() {
    try {
      const params = new URLSearchParams({ statusGroup: 'active' });
      if (filterStatus) { params.delete('statusGroup'); params.set('status', filterStatus); }
      if (filterPlatform) params.set('platform', filterPlatform);
      if (searchQuery) params.set('search', searchQuery);
      const [listRes, statsRes] = await Promise.all([
        fetch('/api/prospects?' + params),
        fetch('/api/prospects/stats'),
      ]);
      const j = await listRes.json();
      if (!listRes.ok) throw new Error(j.error || '실패');
      cached = j.data || [];
      stats = await statsRes.json();
      renderSummary();
      renderBanner();
      renderList();
    } catch (e) {
      document.getElementById('pa-list').innerHTML = `<div style="padding:30px;color:#ff8a80;text-align:center;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderSummary() {
    const host = document.getElementById('pa-summary');
    if (!host) return;
    const cards = [
      { label: '📤 연락함', value: stats.byStatus?.contacted || 0, color: '#f39c12' },
      { label: '📬 답장받음', value: stats.byStatus?.replied || 0, color: '#1565c0' },
      { label: '💼 협상중', value: stats.byStatus?.negotiating || 0, color: '#27ae60' },
      { label: '⏰ 오늘 팔로업', value: stats.today || 0, color: '#ffa726' },
      { label: '🔴 지연', value: stats.overdue || 0, color: '#e94560' },
      { label: '💰 전환 완료', value: stats.byStatus?.converted || 0, color: '#81c784' },
    ];
    host.innerHTML = cards.map(c => `
      <div style="background:#1a1a2e;border-left:3px solid ${c.color};padding:12px;border-radius:8px;">
        <div style="font-size:11px;color:#888;">${c.label}</div>
        <div style="font-size:22px;font-weight:700;color:#fff;">${c.value}</div>
      </div>
    `).join('');
  }

  function renderBanner() {
    const host = document.getElementById('pa-followup-banner');
    if (!host) return;
    const overdue = stats.overdue || 0;
    const todayCount = stats.today || 0;
    if (overdue === 0 && todayCount === 0) { host.style.display = 'none'; return; }
    host.style.display = 'block';
    host.innerHTML = `⚠️ <strong>오늘 팔로업 ${todayCount}건${overdue > 0 ? ` · 🔴 지연 ${overdue}건` : ''}</strong> — 팔로업 날짜 오름차순으로 정렬되어 있습니다.`;
  }

  function renderList() {
    const host = document.getElementById('pa-list');
    if (!host) return;
    if (cached.length === 0) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">활성 리드가 없습니다. 📋 리스트업 페이지에서 "🚀 연락 시작"을 눌러 여기로 옮길 수 있습니다.</div>';
      return;
    }
    const t = today();
    host.innerHTML = `
      <table style="width:100%;border-collapse:collapse;color:#fff;font-size:12px;">
        <thead>
          <tr style="background:#0f0f23;">
            <th style="padding:10px;text-align:left;">이름</th>
            <th style="padding:10px;text-align:left;">회사</th>
            <th style="padding:10px;text-align:left;">출처</th>
            <th style="padding:10px;text-align:center;">상태</th>
            <th style="padding:10px;text-align:center;">마지막 연락</th>
            <th style="padding:10px;text-align:center;">다음 팔로업</th>
            <th style="padding:10px;text-align:left;">마지막 대화</th>
            <th style="padding:10px;text-align:center;">연락</th>
            <th style="padding:10px;text-align:center;">액션</th>
          </tr>
        </thead>
        <tbody>
          ${cached.map(p => renderRow(p, t)).join('')}
        </tbody>
      </table>
    `;
  }

  function contactIcons(p) {
    const arr = [];
    if (p.email)     arr.push(`<a href="mailto:${esc(p.email)}" title="${esc(p.email)}" style="text-decoration:none;">📧</a>`);
    if (p.whatsapp)  arr.push(`<a href="https://wa.me/${esc(p.whatsapp.replace(/[^0-9+]/g, ''))}" target="_blank" rel="noopener" title="${esc(p.whatsapp)}" style="text-decoration:none;">💬</a>`);
    if (p.dmHandle)  arr.push(`<span title="${esc(p.dmHandle)}">📱</span>`);
    if (p.sourceUrl) arr.push(`<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener" title="출처 URL" style="text-decoration:none;">🔗</a>`);
    return arr.length ? arr.join(' ') : '<span style="color:#666;">-</span>';
  }

  function renderRow(p, t) {
    const st = STATUS_META[p.status] || { label: p.status, bg: '#666' };
    let rowBg = '';
    let nextCol = '#aaa';
    let nextIcon = '';
    if (p.nextFollowUpAt) {
      if (p.nextFollowUpAt < t) { rowBg = 'background:#3a2a00;'; nextCol = '#ff8a80'; nextIcon = '🔴 '; }
      else if (p.nextFollowUpAt === t) { rowBg = 'background:#2a1a00;'; nextCol = '#ffa726'; nextIcon = '⏰ '; }
    }
    return `
      <tr style="border-bottom:1px solid #2a2a4a;${rowBg}">
        <td style="padding:10px;"><strong>${esc(p.name)}</strong></td>
        <td style="padding:10px;color:#ccc;">${esc(p.company || '-')}</td>
        <td style="padding:10px;"><span style="padding:2px 8px;background:#2a2a4a;border-radius:8px;font-size:10px;">${esc(platformLabel(p.sourcePlatform))}</span></td>
        <td style="padding:10px;text-align:center;"><span style="padding:2px 8px;background:${st.bg};color:#fff;border-radius:10px;font-size:10px;font-weight:600;">${st.label}</span></td>
        <td style="padding:10px;text-align:center;font-size:11px;color:#aaa;">${p.lastContactedAt || '-'}</td>
        <td style="padding:10px;text-align:center;font-size:11px;color:${nextCol};font-weight:600;">${nextIcon}${p.nextFollowUpAt || '-'}</td>
        <td style="padding:10px;color:#ccc;font-size:11px;max-width:200px;">${esc((p.lastMessageSummary || '').slice(0, 100))}${(p.lastMessageSummary || '').length > 100 ? '…' : ''}</td>
        <td style="padding:10px;text-align:center;">${contactIcons(p)}</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">
          <button onclick="pmcProspectsActive.openLog(${p.id})" title="연락 기록" style="padding:3px 8px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">💬</button>
          <button onclick="pmcProspectsActive.openConvert(${p.id})" title="B2B 바이어 전환" style="padding:3px 8px;background:#27ae60;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">💼</button>
          <button onclick="pmcProspectsActive.openEdit(${p.id})" title="수정" style="padding:3px 8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">✏️</button>
          <button onclick="pmcProspectsActive.markDead(${p.id})" title="중단" style="padding:3px 8px;background:#555;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">❌</button>
        </td>
      </tr>
    `;
  }

  function onStatusChange(v)   { filterStatus = v; refresh(); }
  function onPlatformChange(v) { filterPlatform = v; refresh(); }
  let searchTimer = null;
  function onSearch(v) {
    searchQuery = v || '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 200);
  }

  function closeModal() {
    document.getElementById('pa-modal')?.remove();
  }

  // ─── 연락 기록 모달 ───
  function openLog(id) {
    const p = cached.find(x => x.id === id);
    if (!p) return;
    closeModal();
    const t = today();
    const defaultNext = new Date(); defaultNext.setDate(defaultNext.getDate() + 7);
    const defaultNextIso = defaultNext.toISOString().slice(0, 10);

    const m = document.createElement('div');
    m.id = 'pa-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:500px;width:100%;padding:18px;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:16px;margin:0;">💬 연락 기록 · ${esc(p.name)}</h3>
          <button onclick="pmcProspectsActive.closeModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>

        <div style="margin-bottom:8px;">
          <label style="font-size:11px;color:#888;">상태 전환</label>
          <select id="pa-log-status" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
            <option value="replied" ${p.status === 'replied' ? 'selected' : ''}>📬 답장받음</option>
            <option value="negotiating" ${p.status === 'negotiating' ? 'selected' : ''}>💼 협상중</option>
            <option value="contacted" ${p.status === 'contacted' ? 'selected' : ''}>📤 연락함 (재전송)</option>
          </select>
        </div>

        <div style="margin-bottom:8px;">
          <label style="font-size:11px;color:#888;">대화 요약 (한 줄)</label>
          <input type="text" id="pa-log-summary" value="${esc(p.lastMessageSummary || '')}" maxlength="1000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="답장 왔음 - 관심 있다고. 샘플 요청">
        </div>

        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:#888;">다음 팔로업 날짜</label>
          <input type="date" id="pa-log-next" value="${defaultNextIso}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
        </div>

        <div id="pa-log-error" style="display:none;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcProspectsActive.closeModal()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
          <button id="pa-log-save" onclick="pmcProspectsActive.saveLog(${id})" style="padding:7px 14px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">저장</button>
        </div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    document.getElementById('pa-log-summary').focus();
  }

  async function saveLog(id) {
    const btn = document.getElementById('pa-log-save');
    const err = document.getElementById('pa-log-error');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const res = await fetch(`/api/prospects/${id}/contact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: document.getElementById('pa-log-status').value,
          summary: document.getElementById('pa-log-summary').value,
          nextFollowUp: document.getElementById('pa-log-next').value,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      closeModal();
      refresh();
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block';
      btn.disabled = false; btn.textContent = '저장';
    }
  }

  // ─── B2B 전환 모달 ───
  function openConvert(id) {
    const p = cached.find(x => x.id === id);
    if (!p) return;
    closeModal();
    const m = document.createElement('div');
    m.id = 'pa-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:560px;width:100%;padding:18px;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:16px;margin:0;">💼 B2B 바이어로 전환</h3>
          <button onclick="pmcProspectsActive.closeModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <div style="padding:10px;background:#0f2a3a;border-radius:6px;font-size:12px;color:#81d4fa;margin-bottom:10px;">
          이 리드를 정식 B2B 바이어로 등록합니다. Buyer ID는 자동 채번(B00x). 전환 후 이 활성 리드에서 사라지고 B2B → 구매자 관리 탭에서 조회됩니다.
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">회사/이름 *</label>
            <input type="text" id="pa-c-name" value="${esc(p.company || p.name || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">담당자</label>
            <input type="text" id="pa-c-contact" value="${esc(p.name || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">📧 Email</label>
            <input type="email" id="pa-c-email" value="${esc(p.email || '')}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">💬 WhatsApp</label>
            <input type="text" id="pa-c-wa" value="${esc(p.whatsapp || '')}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">국가</label>
            <input type="text" id="pa-c-country" value="${esc(p.country || '')}" maxlength="40" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">통화</label>
            <select id="pa-c-currency" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
              <option value="USD" selected>USD</option>
              <option value="EUR">EUR</option>
              <option value="JPY">JPY</option>
              <option value="KRW">KRW</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#888;">결제 조건</label>
            <select id="pa-c-terms" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
              <option value="Net 30" selected>Net 30</option>
              <option value="Net 15">Net 15</option>
              <option value="Net 60">Net 60</option>
              <option value="선결제">선결제</option>
            </select>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:#888;">주소</label>
          <input type="text" id="pa-c-address" value="" maxlength="500" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
        </div>

        <div id="pa-c-error" style="display:none;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcProspectsActive.closeModal()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
          <button id="pa-c-save" onclick="pmcProspectsActive.saveConvert(${id})" style="padding:7px 14px;background:#27ae60;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ B2B 바이어 생성</button>
        </div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
  }

  async function saveConvert(id) {
    const btn = document.getElementById('pa-c-save');
    const err = document.getElementById('pa-c-error');
    btn.disabled = true; btn.textContent = '전환 중...';
    try {
      const res = await fetch(`/api/prospects/${id}/convert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('pa-c-name').value.trim(),
          contact: document.getElementById('pa-c-contact').value.trim(),
          email: document.getElementById('pa-c-email').value.trim(),
          whatsapp: document.getElementById('pa-c-wa').value.trim(),
          country: document.getElementById('pa-c-country').value.trim(),
          currency: document.getElementById('pa-c-currency').value,
          paymentTerms: document.getElementById('pa-c-terms').value,
          address: document.getElementById('pa-c-address').value.trim(),
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      closeModal();
      alert(`✓ B2B 바이어 ${j.buyerId} 로 전환되었습니다.`);
      refresh();
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block';
      btn.disabled = false; btn.textContent = '✓ B2B 바이어 생성';
    }
  }

  async function markDead(id) {
    const reason = prompt('이 리드를 중단합니다. 사유 (선택):');
    if (reason === null) return;   // 취소
    try {
      const res = await fetch(`/api/prospects/${id}/dead`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || '실패');
      refresh();
    } catch (e) { alert('실패: ' + e.message); }
  }

  function openEdit(id) {
    const p = cached.find(x => x.id === id);
    if (!p) return;
    closeModal();
    const m = document.createElement('div');
    m.id = 'pa-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:640px;width:100%;max-height:92vh;overflow:auto;padding:18px;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:16px;margin:0;">✏️ 리드 수정 · ${esc(p.name)}</h3>
          <button onclick="pmcProspectsActive.closeModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><label style="font-size:11px;color:#888;">이름</label><input type="text" id="pa-e-name" value="${esc(p.name)}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
          <div><label style="font-size:11px;color:#888;">회사</label><input type="text" id="pa-e-company" value="${esc(p.company || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
          <div><label style="font-size:11px;color:#888;">국가</label><input type="text" id="pa-e-country" value="${esc(p.country || '')}" maxlength="40" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><label style="font-size:11px;color:#888;">📧 Email</label><input type="email" id="pa-e-email" value="${esc(p.email || '')}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
          <div><label style="font-size:11px;color:#888;">💬 WhatsApp</label><input type="text" id="pa-e-wa" value="${esc(p.whatsapp || '')}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
          <div><label style="font-size:11px;color:#888;">📱 DM</label><input type="text" id="pa-e-dm" value="${esc(p.dmHandle || '')}" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
        </div>
        <div style="margin-bottom:8px;"><label style="font-size:11px;color:#888;">제품 포커스</label><input type="text" id="pa-e-focus" value="${esc(p.productFocus || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;"></div>
        <div style="margin-bottom:10px;"><label style="font-size:11px;color:#888;">메모</label><textarea id="pa-e-notes" rows="3" maxlength="4000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;">${esc(p.notes || '')}</textarea></div>
        <div id="pa-e-error" style="display:none;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcProspectsActive.closeModal()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
          <button id="pa-e-save" onclick="pmcProspectsActive.saveEdit(${id})" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">저장</button>
        </div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
  }

  async function saveEdit(id) {
    const btn = document.getElementById('pa-e-save');
    const err = document.getElementById('pa-e-error');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const res = await fetch(`/api/prospects/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('pa-e-name').value.trim(),
          company: document.getElementById('pa-e-company').value.trim() || null,
          country: document.getElementById('pa-e-country').value.trim() || null,
          email: document.getElementById('pa-e-email').value.trim() || null,
          whatsapp: document.getElementById('pa-e-wa').value.trim() || null,
          dmHandle: document.getElementById('pa-e-dm').value.trim() || null,
          productFocus: document.getElementById('pa-e-focus').value.trim() || null,
          notes: document.getElementById('pa-e-notes').value.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      closeModal();
      refresh();
    } catch (e) {
      err.textContent = e.message; err.style.display = 'block';
      btn.disabled = false; btn.textContent = '저장';
    }
  }

  window.pmcProspectsActive = {
    load, refresh,
    onStatusChange, onPlatformChange, onSearch,
    openLog, saveLog,
    openConvert, saveConvert,
    markDead, openEdit, saveEdit, closeModal,
  };
})();
