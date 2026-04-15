/**
 * 개인 워크스페이스 — 본인 전용 노트/링크 아카이브
 * 다른 직원 것은 보이지 않음 (서버 강제)
 */
(function() {
  let user = null;
  let cached = [];
  let tagsList = [];
  let filterTag = '';
  let search = '';
  let editingId = null;

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d) / 60000);
    if (diff < 1) return '방금';
    if (diff < 60) return diff + '분 전';
    if (diff < 60 * 24) return Math.floor(diff / 60) + '시간 전';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // URL 감지 → 링크로
  function linkify(text) {
    if (!text) return '';
    return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#81d4fa;text-decoration:underline;">$1</a>');
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-workspace');
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">📝 내 워크스페이스 <span style="font-size:13px;color:#81d4fa;font-weight:400;">· ${esc(user.displayName)}님 전용</span></h1>
        <p style="color:#888;font-size:13px;">번장 링크·아이디, 경쟁사 URL, 메모 등을 자유롭게 기록하세요. <strong style="color:#ffb74d;">본인만 볼 수 있습니다.</strong></p>
      </div>

      <!-- 작성 폼 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <h3 id="form-title" style="color:#fff;font-size:14px;margin:0 0 10px;">✏️ 새 노트</h3>
        <form id="ws-form">
          <div style="display:grid;grid-template-columns:1fr 200px;gap:8px;margin-bottom:8px;">
            <input type="text" id="ws-title" placeholder="제목 (선택)" maxlength="300" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            <input type="text" id="ws-tag" placeholder="태그 (예: 번장, 경쟁사)" maxlength="50" list="ws-tag-list" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            <datalist id="ws-tag-list"></datalist>
          </div>
          <textarea id="ws-content" placeholder="내용 / URL / 아이디 / 메모 — 여러 줄 가능. http://로 시작하면 자동 링크됨" rows="4" maxlength="20000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-family:inherit;font-size:13px;resize:vertical;margin-bottom:8px;"></textarea>
          <div style="display:flex;gap:8px;align-items:center;">
            <label style="display:flex;gap:6px;align-items:center;color:#aaa;font-size:12px;cursor:pointer;">
              <input type="checkbox" id="ws-pinned"> 📌 상단 고정
            </label>
            <button type="submit" id="ws-submit" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
            <button type="button" id="ws-cancel" onclick="pmcWorkspace.cancelEdit()" style="display:none;padding:8px 16px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          </div>
        </form>
      </div>

      <!-- 필터/검색 -->
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <input type="text" id="ws-search" placeholder="🔎 제목·내용 검색" oninput="pmcWorkspace.onSearchInput()" style="flex:1;min-width:200px;padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;color:#fff;font-size:13px;">
        <select id="ws-tag-filter" onchange="pmcWorkspace.onTagFilterChange()" style="padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;color:#fff;font-size:13px;">
          <option value="">모든 태그</option>
        </select>
      </div>

      <div id="ws-list"></div>
    `;
    document.getElementById('ws-form').addEventListener('submit', submit);
  }

  async function refresh() {
    const params = new URLSearchParams();
    if (filterTag) params.set('tag', filterTag);
    if (search) params.set('search', search);
    const [noteRes, tagRes] = await Promise.all([
      fetch('/api/workspace?' + params),
      fetch('/api/workspace/tags'),
    ]);
    const { data } = await noteRes.json();
    const { tags } = await tagRes.json();
    cached = data || [];
    tagsList = tags || [];
    renderTagFilter();
    renderTagDatalist();
    renderList();
  }

  function renderTagFilter() {
    const sel = document.getElementById('ws-tag-filter');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">모든 태그</option>' +
      tagsList.map(t => `<option value="${esc(t)}" ${t === filterTag ? 'selected' : ''}>${esc(t)}</option>`).join('');
  }

  function renderTagDatalist() {
    const dl = document.getElementById('ws-tag-list');
    if (!dl) return;
    dl.innerHTML = tagsList.map(t => `<option value="${esc(t)}">`).join('');
  }

  function renderList() {
    const c = document.getElementById('ws-list');
    if (!c) return;
    if (cached.length === 0) {
      c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;background:#1a1a2e;border:1px dashed #333;border-radius:12px;">저장된 노트가 없습니다. 위에서 첫 노트를 만들어 보세요.</div>';
      return;
    }
    c.innerHTML = cached.map(n => `
      <div style="background:#1a1a2e;border:1px solid ${n.pinned ? '#7c4dff' : '#2a2a4a'};border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
              ${n.pinned ? '<span title="고정됨">📌</span>' : ''}
              ${n.title ? `<span style="font-weight:600;color:#fff;font-size:14px;">${esc(n.title)}</span>` : '<span style="color:#666;font-size:12px;font-style:italic;">(제목 없음)</span>'}
              ${n.tag ? `<span style="padding:1px 7px;background:#0288d1;color:#fff;border-radius:8px;font-size:10px;">#${esc(n.tag)}</span>` : ''}
              <span style="font-size:10px;color:#666;margin-left:auto;">${dt(n.updated_at)}</span>
            </div>
            ${n.content ? `<div style="white-space:pre-wrap;color:#e0e0e0;font-size:13px;line-height:1.5;word-break:break-all;">${linkify(n.content)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
            <button onclick="pmcWorkspace.togglePin(${n.id})" title="${n.pinned ? '고정 해제' : '고정'}" style="padding:4px 8px;background:${n.pinned ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;">📌</button>
            <button onclick="pmcWorkspace.editNote(${n.id})" title="수정" style="padding:4px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️</button>
            <button onclick="pmcWorkspace.del(${n.id})" title="삭제" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  async function submit(e) {
    e.preventDefault();
    const payload = {
      title: document.getElementById('ws-title').value,
      content: document.getElementById('ws-content').value,
      tag: document.getElementById('ws-tag').value,
      pinned: document.getElementById('ws-pinned').checked,
    };
    const url = editingId ? '/api/workspace/' + editingId : '/api/workspace';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '저장 실패'); return; }
    cancelEdit();
    refresh();
  }

  function editNote(id) {
    const n = cached.find(x => x.id === id);
    if (!n) return;
    editingId = id;
    document.getElementById('form-title').textContent = '✏️ 노트 수정';
    document.getElementById('ws-title').value = n.title || '';
    document.getElementById('ws-content').value = n.content || '';
    document.getElementById('ws-tag').value = n.tag || '';
    document.getElementById('ws-pinned').checked = !!n.pinned;
    document.getElementById('ws-submit').textContent = '수정 저장';
    document.getElementById('ws-cancel').style.display = 'inline-block';
    document.getElementById('ws-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    editingId = null;
    document.getElementById('form-title').textContent = '✏️ 새 노트';
    document.getElementById('ws-form').reset();
    document.getElementById('ws-submit').textContent = '저장';
    document.getElementById('ws-cancel').style.display = 'none';
  }

  async function togglePin(id) {
    const n = cached.find(x => x.id === id);
    if (!n) return;
    const res = await fetch('/api/workspace/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !n.pinned }),
    });
    if (!res.ok) { alert('실패'); return; }
    refresh();
  }

  async function del(id) {
    if (!confirm('이 노트를 삭제하시겠습니까?')) return;
    const res = await fetch('/api/workspace/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('삭제 실패'); return; }
    refresh();
  }

  let searchTimer = null;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = document.getElementById('ws-search').value.trim();
      refresh();
    }, 250);
  }

  function onTagFilterChange() {
    filterTag = document.getElementById('ws-tag-filter').value;
    refresh();
  }

  window.pmcWorkspace = { load, refresh, editNote, cancelEdit, togglePin, del, onSearchInput, onTagFilterChange };
})();
