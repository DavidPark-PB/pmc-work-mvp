/**
 * 피드백 게시판 (Phase 4) — 스레드 + 고정
 */
(function() {
  let user = null;
  let viewMode = 'list'; // 'list' | 'detail'
  let detailId = null;

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diff < 1) return '방금 전';
    if (diff < 60) return diff + '분 전';
    if (diff < 60 * 24) return Math.floor(diff / 60) + '시간 전';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function roleBadge(r) {
    return r === 'admin'
      ? '<span style="padding:2px 8px;background:#7c4dff;color:#fff;border-radius:8px;font-size:11px;">사장</span>'
      : '<span style="padding:2px 8px;background:#0288d1;color:#fff;border-radius:8px;font-size:11px;">직원</span>';
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    viewMode = 'list';
    detailId = null;
    await renderList();
  }

  async function renderList() {
    const el = document.getElementById('page-feedback');
    const res = await fetch('/api/feedback');
    const { data } = await res.json();
    const items = data || [];

    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">💬 피드백 게시판</h1>
        <p style="color:#888;font-size:13px;">업무 피드백, 불만, 건의를 자유롭게 올려주세요</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">✏️ 새 글 작성</h3>
        <form id="fb-form">
          <input type="text" id="fb-title" placeholder="제목" required maxlength="200" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;">
          <textarea id="fb-content" placeholder="내용" required rows="3" maxlength="5000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">등록</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;"><h3 style="color:#fff;">📋 전체 글 (${items.length})</h3></div>
        <div id="fb-list">
          ${items.length === 0 ? '<div style="padding:40px;text-align:center;color:#888;">첫 글을 남겨보세요.</div>' :
            items.map(p => {
              const isOwner = p.authorId === user.id;
              const canEdit = isOwner || user.isAdmin;
              const canDelete = isOwner || user.isAdmin;
              return `
              <div onclick="pmcFeedback.showDetail(${p.id})" style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;gap:12px;align-items:flex-start;cursor:pointer;${p.isPinned ? 'background:rgba(124,77,255,0.08);' : ''}">
                <div style="flex:1;min-width:0;">
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
                    ${p.isPinned ? '<span title="고정글" style="font-size:1.1em;">📌</span>' : ''}
                    <span style="font-weight:600;font-size:15px;color:#fff;">${esc(p.title || '(제목 없음)')}</span>
                    ${p.replyCount > 0 ? `<span style="padding:2px 8px;background:#555;color:#fff;border-radius:10px;font-size:11px;">답글 ${p.replyCount}</span>` : ''}
                  </div>
                  <div style="font-size:12px;color:#888;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    ${roleBadge(p.authorRole)}
                    <span>👤 ${esc(p.authorName)}</span>
                    <span>⏰ ${dt(p.createdAt)}</span>
                  </div>
                </div>
                <div onclick="event.stopPropagation();" style="display:flex;gap:4px;flex-shrink:0;">
                  ${user.isAdmin ? `<button onclick="pmcFeedback.togglePin(${p.id})" title="${p.isPinned ? '고정 해제' : '고정'}" style="padding:4px 8px;background:${p.isPinned ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:13px;">📌</button>` : ''}
                  ${canEdit ? `<button onclick="pmcFeedback.editPost(${p.id})" title="수정" style="padding:4px 8px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️</button>` : ''}
                  ${canDelete ? `<button onclick="pmcFeedback.del(${p.id})" title="삭제" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>` : ''}
                </div>
              </div>
            `;}).join('')
          }
        </div>
      </div>
    `;

    document.getElementById('fb-form').addEventListener('submit', submitPost);
  }

  async function showDetail(id) {
    viewMode = 'detail';
    detailId = id;
    const el = document.getElementById('page-feedback');
    const res = await fetch('/api/feedback/' + id);
    if (!res.ok) { alert('조회 실패'); return; }
    const { post, replies } = await res.json();

    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <button onclick="pmcFeedback.load()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;">← 목록</button>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:24px;margin-bottom:16px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
          ${post.isPinned ? '<span style="font-size:1.2em;">📌</span>' : ''}
          <h2 style="color:#fff;font-size:18px;margin:0;">${esc(post.title)}</h2>
        </div>
        <div style="font-size:12px;color:#888;display:flex;gap:10px;margin-bottom:16px;align-items:center;flex-wrap:wrap;">
          ${roleBadge(post.authorRole)}
          <span>👤 ${esc(post.authorName)}</span>
          <span>⏰ ${dt(post.createdAt)}</span>
          <span style="margin-left:auto;display:flex;gap:4px;">
            ${user.isAdmin ? `<button onclick="pmcFeedback.togglePin(${post.id})" style="padding:4px 10px;background:${post.isPinned ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">📌 ${post.isPinned ? '고정 해제' : '고정'}</button>` : ''}
            ${(post.authorId === user.id || user.isAdmin) ? `<button onclick="pmcFeedback.editPost(${post.id})" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">✏️ 수정</button>` : ''}
            ${(post.authorId === user.id || user.isAdmin) ? `<button onclick="pmcFeedback.del(${post.id})" style="padding:4px 10px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">🗑 삭제</button>` : ''}
          </span>
        </div>
        <div style="white-space:pre-wrap;line-height:1.7;color:#e0e0e0;">${esc(post.content)}</div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;margin-bottom:16px;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;"><h3 style="color:#fff;">💬 답글 ${replies.length}</h3></div>
        ${replies.length === 0
          ? '<div style="padding:30px;text-align:center;color:#888;">아직 답글이 없습니다.</div>'
          : replies.map(r => {
            const canMod = r.authorId === user.id || user.isAdmin;
            return `
              <div style="padding:16px;border-bottom:1px solid #2a2a4a;">
                <div style="font-size:12px;color:#888;display:flex;gap:10px;margin-bottom:6px;align-items:center;flex-wrap:wrap;">
                  ${roleBadge(r.authorRole)}
                  <span>👤 ${esc(r.authorName)}</span>
                  <span>⏰ ${dt(r.createdAt)}</span>
                  ${canMod ? `<span style="margin-left:auto;display:flex;gap:4px;">
                    <button onclick="pmcFeedback.editReply(${r.id}, ${post.id})" style="padding:4px 8px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️</button>
                    <button onclick="pmcFeedback.del(${r.id})" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>
                  </span>` : ''}
                </div>
                <div style="white-space:pre-wrap;line-height:1.6;color:#e0e0e0;">${esc(r.content)}</div>
              </div>
          `;}).join('')}
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin-bottom:12px;">✏️ 답글 달기</h3>
        <form id="reply-form">
          <textarea id="reply-content" required rows="3" maxlength="5000" placeholder="답글을 입력하세요" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">등록</button>
        </form>
      </div>
    `;
    document.getElementById('reply-form').addEventListener('submit', (e) => submitReply(e, id));
  }

  async function submitPost(e) {
    e.preventDefault();
    const title = document.getElementById('fb-title').value.trim();
    const content = document.getElementById('fb-content').value.trim();
    if (!title || !content) return;
    const res = await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) { alert((await res.json()).error || '등록 실패'); return; }
    document.getElementById('fb-form').reset();
    renderList();
  }

  async function submitReply(e, parentId) {
    e.preventDefault();
    const content = document.getElementById('reply-content').value.trim();
    if (!content) return;
    const res = await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, parentId }),
    });
    if (!res.ok) { alert((await res.json()).error || '등록 실패'); return; }
    showDetail(parentId);
  }

  async function togglePin(id) {
    const res = await fetch(`/api/feedback/${id}/pin`, { method: 'PATCH' });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    if (viewMode === 'detail' && detailId === id) showDetail(id);
    else renderList();
  }

  async function del(id) {
    if (!confirm('이 글을 삭제하시겠습니까? (답글이 있으면 함께 삭제됩니다)')) return;
    const res = await fetch(`/api/feedback/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    if (viewMode === 'detail') load();
    else renderList();
  }

  // ── 수정 모달 ──
  async function editPost(id) {
    // 제목 + 내용 모두 수정 (원글)
    const res = await fetch('/api/feedback/' + id);
    if (!res.ok) { alert('조회 실패'); return; }
    const { post } = await res.json();
    openEditModal({ id, type: 'post', title: post.title, content: post.content });
  }

  async function editReply(id, parentId) {
    // 답글: content만 수정
    const res = await fetch('/api/feedback/' + parentId);
    if (!res.ok) { alert('조회 실패'); return; }
    const { replies } = await res.json();
    const r = (replies || []).find(x => x.id === id);
    if (!r) { alert('답글을 찾을 수 없습니다'); return; }
    openEditModal({ id, type: 'reply', title: null, content: r.content, parentId });
  }

  function openEditModal({ id, type, title, content, parentId }) {
    const titleField = type === 'post' ? `
      <div style="margin-bottom:10px;">
        <label style="display:block;color:#888;font-size:12px;margin-bottom:4px;">제목</label>
        <input id="edit-fb-title" type="text" maxlength="200" value="${esc(title || '')}" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
      </div>` : '';

    const html = `
      <div id="edit-fb-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;">
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:520px;max-width:95vw;">
          <h2 style="color:#fff;font-size:17px;margin:0 0 16px;">${type === 'post' ? '글 수정' : '답글 수정'}</h2>
          ${titleField}
          <div style="margin-bottom:12px;">
            <label style="display:block;color:#888;font-size:12px;margin-bottom:4px;">내용</label>
            <textarea id="edit-fb-content" rows="6" maxlength="5000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">${esc(content || '')}</textarea>
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button onclick="pmcFeedback.closeEditModal()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
            <button onclick="pmcFeedback.saveEdit(${id}, '${type}', ${parentId || 'null'})" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">저장</button>
          </div>
        </div>
      </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    setTimeout(() => {
      const first = document.getElementById('edit-fb-title') || document.getElementById('edit-fb-content');
      if (first) first.focus();
    }, 50);
  }

  function closeEditModal() {
    document.getElementById('edit-fb-modal')?.remove();
  }

  async function saveEdit(id, type, parentId) {
    const body = {};
    const content = document.getElementById('edit-fb-content').value.trim();
    if (!content) { alert('내용을 입력하세요'); return; }
    body.content = content;
    if (type === 'post') {
      const title = document.getElementById('edit-fb-title').value.trim();
      if (!title) { alert('제목을 입력하세요'); return; }
      body.title = title;
    }
    const res = await fetch('/api/feedback/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { alert('수정 실패: ' + (await res.json()).error); return; }
    closeEditModal();
    // 새로고침
    if (viewMode === 'detail' && detailId) showDetail(detailId);
    else if (viewMode === 'detail' && parentId) showDetail(parentId);
    else renderList();
  }

  window.pmcFeedback = { load, renderList, showDetail, togglePin, del, editPost, editReply, openEditModal, closeEditModal, saveEdit };
})();
