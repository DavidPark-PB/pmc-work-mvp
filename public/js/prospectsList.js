/**
 * TCG 리드 리스트업 (Phase 7) — cold 상태만. 빠른 입력 + 플랫폼 탭.
 */
(function() {
  let user = null;
  let cached = [];
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

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function platformLabel(k) { return PLATFORMS.find(p => p.key === k)?.label || k; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-prospects-list');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">📋 TCG 리드 리스트업 <span style="color:#888;font-weight:400;font-size:13px;">· 콜드 리스트 · 아직 연락 안 함</span></h1>
        <p style="color:#888;font-size:13px;">해외 TCG 셀러 후보 수집창. 이름·플랫폼·링크 최소 3개만 있으면 저장. Enter로 빠르게 다음 행 추가. 연락 시작하면 <strong>💬 활성 리드</strong> 페이지로 자동 이동.</p>
      </div>

      <div id="pl-tabs" style="display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap;border-bottom:1px solid #2a2a4a;padding-bottom:6px;"></div>

      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap;">
        <input type="search" id="pl-search" placeholder="🔍 이름·회사·메모·제품 포커스" oninput="pmcProspectsList.onSearch(this.value)" style="flex:1;min-width:200px;padding:7px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
        <button onclick="pmcProspectsList.openAdd()" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">+ 상세 추가</button>
      </div>

      <!-- 빠른 추가 바 -->
      <div style="background:#0f2a3a;border:1px solid #1565c0;border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="display:grid;grid-template-columns:2fr 1fr 3fr 1fr 100px;gap:6px;align-items:center;">
          <input type="text" id="pl-q-name" placeholder="이름 *" style="padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;" onkeydown="pmcProspectsList.onQuickKey(event)">
          <select id="pl-q-platform" style="padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            ${PLATFORMS.map(p => `<option value="${p.key}">${p.label}</option>`).join('')}
          </select>
          <input type="text" id="pl-q-url" placeholder="스토어/프로필 URL 또는 제품 포커스" style="padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;" onkeydown="pmcProspectsList.onQuickKey(event)">
          <input type="text" id="pl-q-country" placeholder="국가" style="padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;" onkeydown="pmcProspectsList.onQuickKey(event)">
          <button onclick="pmcProspectsList.quickAdd()" style="padding:7px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">+ 추가</button>
        </div>
        <div style="color:#888;font-size:10px;margin-top:4px;">URL이 http로 시작하지 않으면 제품 포커스로 저장됩니다. Enter → 즉시 저장 후 입력란 초기화.</div>
      </div>

      <div id="pl-list" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:auto;"></div>
    `;
  }

  async function refresh() {
    try {
      const params = new URLSearchParams({ statusGroup: 'cold' });
      if (filterPlatform) params.set('platform', filterPlatform);
      if (searchQuery) params.set('search', searchQuery);
      const res = await fetch('/api/prospects?' + params);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      cached = j.data || [];
      renderTabs();
      renderList();
    } catch (e) {
      document.getElementById('pl-list').innerHTML = `<div style="padding:30px;color:#ff8a80;text-align:center;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderTabs() {
    const host = document.getElementById('pl-tabs');
    if (!host) return;
    const counts = new Map();
    for (const p of cached) counts.set(p.sourcePlatform, (counts.get(p.sourcePlatform) || 0) + 1);
    const mkTab = (key, label, total) => `<button onclick="pmcProspectsList.onPlatformChange('${key}')" style="padding:7px 14px;background:${filterPlatform === key ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:${filterPlatform === key ? 600 : 400};">${label} <span style="opacity:0.7;">${total}</span></button>`;
    host.innerHTML = mkTab('', '전체', cached.length) + PLATFORMS.map(p => mkTab(p.key, p.label, counts.get(p.key) || 0)).join('');
  }

  function renderList() {
    const host = document.getElementById('pl-list');
    if (!host) return;
    if (cached.length === 0) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">아직 리스트업된 리드가 없습니다. 위 빠른 추가 바에 이름·플랫폼·URL 넣고 Enter.</div>';
      return;
    }
    host.innerHTML = `
      <table style="width:100%;border-collapse:collapse;color:#fff;font-size:12px;">
        <thead>
          <tr style="background:#0f0f23;">
            <th style="padding:10px;text-align:left;">이름</th>
            <th style="padding:10px;text-align:left;">회사</th>
            <th style="padding:10px;text-align:left;">출처</th>
            <th style="padding:10px;text-align:left;">국가</th>
            <th style="padding:10px;text-align:left;">제품 포커스</th>
            <th style="padding:10px;text-align:center;">연락처</th>
            <th style="padding:10px;text-align:center;">등록</th>
            <th style="padding:10px;text-align:center;">액션</th>
          </tr>
        </thead>
        <tbody>
          ${cached.map(renderRow).join('')}
        </tbody>
      </table>
    `;
  }

  function contactIcons(p) {
    const arr = [];
    if (p.email)     arr.push(`<a href="mailto:${esc(p.email)}" title="${esc(p.email)}" style="text-decoration:none;">📧</a>`);
    if (p.whatsapp)  arr.push(`<a href="https://wa.me/${esc(p.whatsapp.replace(/[^0-9+]/g, ''))}" target="_blank" rel="noopener" title="${esc(p.whatsapp)}" style="text-decoration:none;">💬</a>`);
    if (p.dmHandle)  arr.push(`<span title="${esc(p.dmHandle)}">📱</span>`);
    return arr.length ? arr.join(' ') : '<span style="color:#666;">-</span>';
  }

  function renderRow(p) {
    const created = (p.createdAt || '').slice(0, 10);
    return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:10px;"><strong>${esc(p.name)}</strong></td>
        <td style="padding:10px;color:#ccc;">${esc(p.company || '-')}</td>
        <td style="padding:10px;"><span style="padding:2px 8px;background:#2a2a4a;border-radius:8px;font-size:10px;">${esc(platformLabel(p.sourcePlatform))}</span>${p.sourceUrl ? ` <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener" style="color:#81d4fa;font-size:11px;margin-left:4px;">🔗</a>` : ''}</td>
        <td style="padding:10px;color:#aaa;">${esc(p.country || '-')}</td>
        <td style="padding:10px;color:#ccc;">${esc(p.productFocus || '-')}</td>
        <td style="padding:10px;text-align:center;">${contactIcons(p)}</td>
        <td style="padding:10px;text-align:center;font-size:11px;color:#888;">${created}</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">
          <button onclick="pmcProspectsList.activate(${p.id})" title="연락 시작 → 활성 리드" style="padding:3px 8px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">🚀</button>
          <button onclick="pmcProspectsList.openEdit(${p.id})" title="수정" style="padding:3px 8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">✏️</button>
          <button onclick="pmcProspectsList.del(${p.id})" title="삭제" style="padding:3px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;">🗑</button>
        </td>
      </tr>
    `;
  }

  function onPlatformChange(p) { filterPlatform = p; refresh(); }
  let searchTimer = null;
  function onSearch(v) {
    searchQuery = v || '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 200);
  }

  function onQuickKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); quickAdd(); }
  }

  async function quickAdd() {
    const name = document.getElementById('pl-q-name').value.trim();
    const platform = document.getElementById('pl-q-platform').value;
    const rawUrl = document.getElementById('pl-q-url').value.trim();
    const country = document.getElementById('pl-q-country').value.trim();
    if (!name) { document.getElementById('pl-q-name').focus(); return; }
    const payload = { name, sourcePlatform: platform, country: country || null };
    if (rawUrl) {
      if (/^https?:\/\//i.test(rawUrl)) payload.sourceUrl = rawUrl;
      else payload.productFocus = rawUrl;
    }
    try {
      const res = await fetch('/api/prospects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      document.getElementById('pl-q-name').value = '';
      document.getElementById('pl-q-url').value = '';
      document.getElementById('pl-q-country').value = '';
      document.getElementById('pl-q-name').focus();
      refresh();
    } catch (e) { alert('추가 실패: ' + e.message); }
  }

  async function activate(id) {
    if (!confirm('이 리드에 연락을 시작합니다. 활성 리드 페이지로 이동합니다.')) return;
    try {
      const res = await fetch(`/api/prospects/${id}/activate`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || '실패');
      refresh();
    } catch (e) { alert('실패: ' + e.message); }
  }

  async function del(id) {
    if (!confirm('이 리드를 삭제합니다. 되돌릴 수 없습니다.')) return;
    try {
      const res = await fetch(`/api/prospects/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || '실패');
      refresh();
    } catch (e) { alert('삭제 실패: ' + e.message); }
  }

  // ─── 상세 모달 (공용 — pmcProspectsList/Active 둘 다 사용) ───
  function openAdd() { openModal(null); }
  function openEdit(id) {
    const p = cached.find(x => x.id === id);
    if (!p) return;
    openModal(p);
  }

  function openModal(p) {
    const existing = document.getElementById('pl-modal');
    if (existing) existing.remove();
    const isEdit = !!p;
    const platformOpts = PLATFORMS.map(x => `<option value="${x.key}" ${p && p.sourcePlatform === x.key ? 'selected' : ''}>${x.label}</option>`).join('');

    const m = document.createElement('div');
    m.id = 'pl-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:680px;width:100%;max-height:92vh;overflow:auto;padding:18px;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:16px;margin:0;">📋 ${isEdit ? '리드 수정' : '리드 상세 추가'}</h3>
          <button onclick="pmcProspectsList.closeModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>

        <div style="display:grid;grid-template-columns:2fr 2fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">이름 *</label>
            <input type="text" id="pl-m-name" value="${esc(p?.name || '')}" required maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">회사</label>
            <input type="text" id="pl-m-company" value="${esc(p?.company || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">국가</label>
            <input type="text" id="pl-m-country" value="${esc(p?.country || '')}" maxlength="40" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="US, JP, DE">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">출처 *</label>
            <select id="pl-m-platform" required style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">${platformOpts}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#888;">출처 URL</label>
            <input type="url" id="pl-m-url" value="${esc(p?.sourceUrl || '')}" maxlength="2000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="https://...">
          </div>
        </div>

        <div style="margin-bottom:8px;">
          <label style="font-size:11px;color:#888;">제품 포커스</label>
          <input type="text" id="pl-m-focus" value="${esc(p?.productFocus || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="Pokemon Japanese sealed">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">📧 Email</label>
            <input type="email" id="pl-m-email" value="${esc(p?.email || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">💬 WhatsApp (+국가코드)</label>
            <input type="text" id="pl-m-wa" value="${esc(p?.whatsapp || '')}" maxlength="50" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="+1234567890">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">📱 DM Handle</label>
            <input type="text" id="pl-m-dm" value="${esc(p?.dmHandle || '')}" maxlength="100" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="@username">
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:#888;">메모</label>
          <textarea id="pl-m-notes" rows="3" maxlength="4000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;">${esc(p?.notes || '')}</textarea>
        </div>

        <div id="pl-m-error" style="display:none;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcProspectsList.closeModal()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
          <button id="pl-m-save" onclick="pmcProspectsList.save(${isEdit ? p.id : 'null'})" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">${isEdit ? '저장' : '추가'}</button>
        </div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    document.getElementById('pl-m-name').focus();
  }

  function closeModal() {
    document.getElementById('pl-modal')?.remove();
  }

  async function save(id) {
    const err = document.getElementById('pl-m-error');
    const btn = document.getElementById('pl-m-save');
    err.style.display = 'none';
    const payload = {
      name: document.getElementById('pl-m-name').value.trim(),
      company: document.getElementById('pl-m-company').value.trim() || null,
      country: document.getElementById('pl-m-country').value.trim() || null,
      sourcePlatform: document.getElementById('pl-m-platform').value,
      sourceUrl: document.getElementById('pl-m-url').value.trim() || null,
      productFocus: document.getElementById('pl-m-focus').value.trim() || null,
      email: document.getElementById('pl-m-email').value.trim() || null,
      whatsapp: document.getElementById('pl-m-wa').value.trim() || null,
      dmHandle: document.getElementById('pl-m-dm').value.trim() || null,
      notes: document.getElementById('pl-m-notes').value.trim() || null,
    };
    if (!payload.name) { err.textContent = '이름을 입력하세요'; err.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const url = id ? `/api/prospects/${id}` : '/api/prospects';
      const method = id ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '저장 실패');
      closeModal();
      refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = id ? '저장' : '추가';
    }
  }

  window.pmcProspectsList = {
    load, refresh,
    onPlatformChange, onSearch, onQuickKey, quickAdd,
    activate, del,
    openAdd, openEdit, closeModal, save,
  };
})();
