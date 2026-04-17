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
  let todos = [];

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
        <p style="color:#888;font-size:13px;">메모는 자유 기록용, 오늘의 할 일은 체크리스트로 사용하세요. <strong style="color:#ffb74d;">본인만 볼 수 있습니다.</strong></p>
      </div>

      <div style="display:grid;grid-template-columns:minmax(0, 1fr) minmax(0, 360px);gap:16px;" id="ws-grid">
        <!-- 왼쪽: 메모 -->
        <div>
          <h2 style="font-size:16px;color:#fff;margin:0 0 10px;">📝 메모</h2>

          <!-- 메모 작성 폼 -->
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
        </div>

        <!-- 오른쪽: 오늘의 할 일 -->
        <aside id="ws-todo-wrap">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;">
            <h2 style="font-size:16px;color:#fff;margin:0;">✅ 오늘의 할 일 <span id="ws-todo-count" style="font-size:11px;color:#888;font-weight:400;"></span></h2>
            <button onclick="pmcWorkspace.clearDone()" id="ws-todo-clear" style="display:none;padding:3px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#888;cursor:pointer;font-size:10px;">완료 모두 지우기</button>
          </div>
          <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
            <form id="ws-todo-form" style="display:flex;gap:6px;margin-bottom:10px;">
              <input type="text" id="ws-todo-input" placeholder="+ 할 일을 입력하고 Enter" maxlength="500" style="flex:1;padding:8px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
              <button type="submit" style="padding:8px 14px;background:#4caf50;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">+</button>
            </form>
            <div id="ws-todo-list"></div>
          </div>
        </aside>
      </div>

      <style>
        @media (max-width: 900px) {
          #ws-grid { grid-template-columns: 1fr !important; }
        }
      </style>
    `;
    document.getElementById('ws-form').addEventListener('submit', submit);
    document.getElementById('ws-todo-form').addEventListener('submit', submitTodo);
  }

  async function refresh() {
    const params = new URLSearchParams();
    if (filterTag) params.set('tag', filterTag);
    if (search) params.set('search', search);
    const [noteRes, tagRes, todoRes] = await Promise.all([
      fetch('/api/workspace?' + params),
      fetch('/api/workspace/tags'),
      fetch('/api/workspace/todos'),
    ]);
    const { data } = await noteRes.json();
    const { tags } = await tagRes.json();
    const { data: todoData } = await todoRes.json();
    cached = data || [];
    tagsList = tags || [];
    todos = todoData || [];
    renderTagFilter();
    renderTagDatalist();
    renderList();
    renderTodos();
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

  // ── 할 일 체크리스트 ──
  function renderTodos() {
    const list = document.getElementById('ws-todo-list');
    if (!list) return;
    const active = todos.filter(t => !t.done);
    const done = todos.filter(t => t.done);
    const countEl = document.getElementById('ws-todo-count');
    if (countEl) {
      countEl.textContent = todos.length > 0 ? `· ${active.length}개 남음 / ${todos.length}개 중` : '';
    }
    const clearBtn = document.getElementById('ws-todo-clear');
    if (clearBtn) clearBtn.style.display = done.length > 0 ? 'inline-block' : 'none';

    if (todos.length === 0) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:#666;font-size:12px;">오늘 해야 할 일을 적어보세요.</div>';
      return;
    }

    const row = t => `
      <div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #1a1a2e;">
        <input type="checkbox" ${t.done ? 'checked' : ''} onchange="pmcWorkspace.toggleTodo(${t.id}, this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:#4caf50;flex-shrink:0;">
        <span style="flex:1;min-width:0;word-break:break-word;font-size:13px;color:${t.done ? '#666' : '#e0e0e0'};${t.done ? 'text-decoration:line-through;' : ''}" onclick="pmcWorkspace.editTodo(${t.id})" title="클릭하면 수정">${esc(t.text)}</span>
        <button onclick="pmcWorkspace.delTodo(${t.id})" title="삭제" style="flex-shrink:0;background:transparent;border:0;color:#555;cursor:pointer;font-size:13px;padding:2px 6px;">×</button>
      </div>`;
    list.innerHTML = active.map(row).join('') + done.map(row).join('');
  }

  async function submitTodo(e) {
    e.preventDefault();
    const input = document.getElementById('ws-todo-input');
    const text = input.value.trim();
    if (!text) return;
    const res = await fetch('/api/workspace/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) { alert((await res.json()).error || '추가 실패'); return; }
    input.value = '';
    refresh();
  }

  async function toggleTodo(id, done) {
    const res = await fetch('/api/workspace/todos/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    if (!res.ok) { alert('변경 실패'); return; }
    refresh();
  }

  async function editTodo(id) {
    const t = todos.find(x => x.id === id);
    if (!t) return;
    const next = prompt('할 일 수정', t.text);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    const res = await fetch('/api/workspace/todos/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    });
    if (!res.ok) { alert((await res.json()).error || '수정 실패'); return; }
    refresh();
  }

  async function delTodo(id) {
    const res = await fetch('/api/workspace/todos/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('삭제 실패'); return; }
    refresh();
  }

  async function clearDone() {
    if (!confirm('완료된 할 일을 모두 삭제합니다. 계속할까요?')) return;
    const res = await fetch('/api/workspace/todos/clear-completed', { method: 'POST' });
    if (!res.ok) { alert('삭제 실패'); return; }
    refresh();
  }

  window.pmcWorkspace = {
    load, refresh, editNote, cancelEdit, togglePin, del, onSearchInput, onTagFilterChange,
    toggleTodo, editTodo, delTodo, clearDone,
  };
})();
