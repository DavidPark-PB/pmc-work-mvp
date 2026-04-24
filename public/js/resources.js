/**
 * 자료실 (Phase 5) — Drive 폴더를 등록하면 주기적으로 파일 동기화.
 * 전 직원이 파일명·태그로 검색하고 Drive 링크로 열람.
 */
(function() {
  let user = null;
  let folders = [];
  let resources = [];
  let uploads = [];
  let allTags = [];
  let folderFilter = '';
  let tagFilter = '';
  let searchQ = '';
  let searchTimer = null;

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dt(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtSize(n) {
    if (!n) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
  function iconForMime(mime) {
    if (!mime) return '📄';
    if (mime.startsWith('image/')) return '🖼️';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime === 'application/pdf') return '📕';
    if (mime.includes('spreadsheet') || mime.includes('excel')) return '📊';
    if (mime.includes('document') || mime.includes('word')) return '📝';
    if (mime.includes('presentation') || mime.includes('powerpoint')) return '📽️';
    if (mime.includes('folder')) return '📁';
    if (mime.includes('zip') || mime.includes('compressed')) return '🗜️';
    return '📄';
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await Promise.all([loadFolders(), loadTags(), refreshResources(), refreshUploads()]);
    renderFolders();
    renderTagChips();
  }

  async function refreshUploads() {
    try {
      const res = await fetch('/api/resources/uploads');
      const j = await res.json();
      uploads = j.data || [];
      renderUploads();
    } catch (e) {
      const host = document.getElementById('res-uploads-list');
      if (host) host.innerHTML = `<div style="padding:14px;color:#ff8a80;font-size:12px;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  async function loadFolders() {
    try {
      const res = await fetch('/api/resources/folders');
      const j = await res.json();
      folders = j.data || [];
    } catch { folders = []; }
  }

  async function loadTags() {
    try {
      const res = await fetch('/api/resources/tags');
      const j = await res.json();
      allTags = j.tags || [];
    } catch { allTags = []; }
  }

  async function refreshResources() {
    try {
      const params = new URLSearchParams();
      if (folderFilter) params.set('folderId', folderFilter);
      if (searchQ) params.set('search', searchQ);
      if (tagFilter) params.set('tag', tagFilter);
      const res = await fetch('/api/resources?' + params);
      const j = await res.json();
      resources = j.data || [];
      renderResources();
    } catch (e) {
      document.getElementById('res-list').innerHTML = `<div style="padding:20px;color:#ff8a80;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderShell() {
    const el = document.getElementById('page-resources');
    const adminSection = user.isAdmin ? `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📂 Drive 폴더 등록</h3>
          <button type="button" onclick="pmcResources.syncAll()" style="padding:5px 12px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">🔄 전체 동기화</button>
        </div>
        <form id="res-folder-form">
          <div style="display:grid;grid-template-columns:2fr 1.5fr 1fr 100px;gap:6px;margin-bottom:6px;">
            <input type="text" id="res-f-name" placeholder="화면용 이름 (예: 공용 이미지 라이브러리)" required maxlength="200" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <input type="text" id="res-f-drive-id" placeholder="Drive 폴더 ID (URL에서 /folders/ 뒤)" required style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;font-family:monospace;">
            <input type="text" id="res-f-tags" placeholder="태그, 콤마, 분리" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <button type="submit" style="padding:7px 12px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">등록</button>
          </div>
          <input type="text" id="res-f-desc" placeholder="설명 (선택)" maxlength="500" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
        </form>
        <div style="color:#666;font-size:10px;margin-top:6px;">Drive 폴더 서비스 계정(config/credentials.json의 client_email)에 공유해야 파일이 동기화됩니다.</div>
      </div>

      <div id="res-folders-admin" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;margin-bottom:12px;"></div>
    ` : '';

    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">📁 자료실 <span style="color:#888;font-weight:400;font-size:13px;">· 구글 드라이브 동기화 + 직접 업로드</span></h1>
        <p style="color:#888;font-size:13px;">Drive 는 대용량·영구 보관용. 직접 업로드는 일반 공지·양식용 (자동 만료).</p>
      </div>

      <!-- 직접 업로드 영역 (전 직원) -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📎 직접 업로드 <span style="color:#888;font-weight:400;font-size:11px;">· 10MB↓ 30일 / 10MB↑ 7일 자동 만료</span></h3>
        </div>
        <form id="res-upload-form" enctype="multipart/form-data">
          <div style="display:grid;grid-template-columns:2fr 1.5fr 120px 100px;gap:6px;margin-bottom:6px;">
            <input type="file" id="res-up-files" multiple required style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <input type="text" id="res-up-tags" placeholder="태그, 콤마, 분리 (선택)" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <select id="res-up-days" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <option value="">자동 (용량 기준)</option>
              <option value="7">7일</option>
              <option value="14">14일</option>
              <option value="30">30일</option>
              <option value="60">60일</option>
            </select>
            <button type="submit" id="res-up-btn" style="padding:7px 12px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">업로드</button>
          </div>
          <input type="text" id="res-up-desc" placeholder="설명 (선택, 공지 내용 등)" maxlength="1000" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
        </form>
        <div style="color:#666;font-size:10px;margin-top:6px;">※ 최대 50MB · 최대 10개 · 중요 자료는 Drive 에 올리세요 (자동 삭제됨).</div>
        <div id="res-up-status" style="margin-top:6px;font-size:12px;"></div>
        <div id="res-uploads-list" style="margin-top:12px;"></div>
      </div>

      ${adminSection}

      <!-- 검색 + 필터 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:12px;margin-bottom:12px;">
        <div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">
          <input type="text" id="res-search" placeholder="🔎 파일명 검색..." oninput="pmcResources.onSearchInput()" style="flex:1;min-width:200px;padding:8px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          <select id="res-folder-filter" onchange="pmcResources.onFolderFilter()" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
            <option value="">전체 폴더</option>
          </select>
        </div>
        <div id="res-tag-chips"></div>
      </div>

      <!-- 파일 리스트 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div id="res-list"></div>
      </div>
    `;

    document.getElementById('res-search').addEventListener('keyup', onSearchInput);
    if (user.isAdmin) {
      document.getElementById('res-folder-form').addEventListener('submit', submitFolder);
    }
    document.getElementById('res-upload-form').addEventListener('submit', submitUpload);
  }

  async function submitUpload(e) {
    e.preventDefault();
    const btn = document.getElementById('res-up-btn');
    const status = document.getElementById('res-up-status');
    const filesInput = document.getElementById('res-up-files');
    const tagsInput = document.getElementById('res-up-tags');
    const daysInput = document.getElementById('res-up-days');
    const descInput = document.getElementById('res-up-desc');

    const files = filesInput.files;
    if (!files || !files.length) { status.innerHTML = '<span style="color:#ff8a80;">파일을 선택하세요</span>'; return; }

    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (tagsInput.value.trim()) fd.append('tags', tagsInput.value.trim());
    if (daysInput.value) fd.append('days', daysInput.value);
    if (descInput.value.trim()) fd.append('description', descInput.value.trim());

    btn.disabled = true; btn.textContent = '업로드 중...';
    status.innerHTML = '<span style="color:#888;">⏳ 업로드 중…</span>';
    try {
      const r = await fetch('/api/resources/uploads', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '업로드 실패');
      status.innerHTML = `<span style="color:#4caf50;">✓ ${j.data.length}개 업로드 완료</span>`;
      filesInput.value = ''; tagsInput.value = ''; daysInput.value = ''; descInput.value = '';
      await refreshUploads();
      setTimeout(() => { status.innerHTML = ''; }, 3000);
    } catch (e) {
      status.innerHTML = `<span style="color:#ff8a80;">❌ ${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = '업로드';
    }
  }

  function renderUploads() {
    const host = document.getElementById('res-uploads-list');
    if (!host) return;
    if (!uploads.length) {
      host.innerHTML = '<div style="padding:14px;color:#666;font-size:11px;text-align:center;border-top:1px dashed #2a2a4a;">업로드된 파일 없음</div>';
      return;
    }
    host.innerHTML = `
      <div style="border-top:1px solid #2a2a4a;padding-top:10px;">
        <div style="color:#fff;font-size:12px;font-weight:600;margin-bottom:6px;">업로드된 파일 ${uploads.length}개</div>
        ${uploads.map(u => {
          const canDelete = u.uploadedBy === user.id || user.isAdmin;
          const tagsHtml = (u.tags || []).map(t => `<span style="color:#81d4fa;">#${esc(t)}</span>`).join(' ');
          const expiryColor = u.daysLeft <= 3 ? '#ff8a80' : (u.daysLeft <= 7 ? '#ffd54f' : '#81c784');
          return `
            <div style="padding:8px 10px;border-bottom:1px solid #2a2a4a;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <div style="font-size:22px;min-width:28px;text-align:center;">${iconForMime(u.mimeType)}</div>
              <div style="flex:1;min-width:180px;">
                <div style="color:#fff;font-size:13px;"><strong>${esc(u.originalName)}</strong></div>
                <div style="color:#888;font-size:11px;margin-top:2px;">
                  ${fmtSize(u.sizeBytes)} · ${esc(u.uploaderName || '?')} · ${dt(u.uploadedAt)}
                  · <span style="color:${expiryColor};">${u.daysLeft}일 후 만료</span>
                  ${tagsHtml ? ' · ' + tagsHtml : ''}
                </div>
                ${u.description ? `<div style="color:#ccc;font-size:11px;margin-top:2px;">${esc(u.description)}</div>` : ''}
              </div>
              <div style="display:flex;gap:4px;">
                <a href="/api/resources/uploads/${u.id}/download" style="padding:5px 12px;background:#2a4a6a;border-radius:4px;color:#fff;text-decoration:none;font-size:11px;">⬇ 다운로드</a>
                ${canDelete ? `<button type="button" onclick="pmcResources.deleteUpload(${u.id}, '${esc(u.originalName).replace(/'/g,"\\'")}')" style="padding:5px 10px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>`;
  }

  async function deleteUpload(id, name) {
    if (!confirm(`"${name}" 삭제?`)) return;
    try {
      const r = await fetch(`/api/resources/uploads/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error || '삭제 실패');
      await refreshUploads();
    } catch (e) { alert('삭제 실패: ' + e.message); }
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQ = document.getElementById('res-search').value.trim();
      refreshResources();
    }, 250);
  }

  function onFolderFilter() {
    folderFilter = document.getElementById('res-folder-filter').value;
    refreshResources();
  }

  function setTagFilter(tag) {
    tagFilter = tag === tagFilter ? '' : tag;
    renderTagChips();
    refreshResources();
  }

  function renderTagChips() {
    const host = document.getElementById('res-tag-chips');
    if (!host) return;
    if (allTags.length === 0) { host.innerHTML = ''; return; }
    host.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:4px;">' +
      allTags.map(t => `<button type="button" onclick="pmcResources.setTagFilter('${esc(t)}')" style="padding:3px 10px;background:${t === tagFilter ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:12px;color:#fff;cursor:pointer;font-size:11px;">#${esc(t)}</button>`).join('') + '</div>';
  }

  function renderFolders() {
    const sel = document.getElementById('res-folder-filter');
    if (!sel) return;
    sel.innerHTML = '<option value="">전체 폴더</option>' +
      folders.map(f => `<option value="${f.id}" ${String(f.id) === folderFilter ? 'selected' : ''}>${esc(f.name)} (${f.lastSyncFileCount ?? '?'})</option>`).join('');

    if (user.isAdmin) renderFoldersAdmin();
  }

  function renderFoldersAdmin() {
    const host = document.getElementById('res-folders-admin');
    if (!host) return;
    if (folders.length === 0) {
      host.innerHTML = '<div style="padding:20px;color:#666;font-size:12px;text-align:center;">등록된 폴더 없음</div>';
      return;
    }
    host.innerHTML = `
      <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;color:#fff;font-size:13px;font-weight:600;">등록된 폴더 ${folders.length}개</div>
      ${folders.map(f => `
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <div style="color:#fff;font-size:13px;"><strong>${esc(f.name)}</strong>${!f.active ? ' <span style="color:#888;font-size:10px;">(비활성)</span>' : ''}</div>
            <div style="color:#888;font-size:10px;font-family:monospace;">${esc(f.driveFolderId)}</div>
            <div style="color:#aaa;font-size:11px;margin-top:2px;">
              ${f.description || ''}
              ${(f.tags || []).length > 0 ? ' · 태그: ' + f.tags.map(t => `#${esc(t)}`).join(' ') : ''}
              ${f.lastSyncedAt ? ` · 마지막 동기화 ${dt(f.lastSyncedAt)} (${f.lastSyncFileCount}개)` : ' · 동기화 안됨'}
            </div>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" onclick="pmcResources.syncFolder(${f.id})" style="padding:4px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🔄 동기화</button>
            <button type="button" onclick="pmcResources.toggleFolderActive(${f.id}, ${f.active})" style="padding:4px 10px;background:${f.active ? '#2a2a4a' : '#4caf50'};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">${f.active ? '비활성' : '활성'}</button>
            <button type="button" onclick="pmcResources.deleteFolder(${f.id}, '${esc(f.name)}')" style="padding:4px 10px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>
          </div>
        </div>
      `).join('')}
    `;
  }

  function renderResources() {
    const host = document.getElementById('res-list');
    if (!host) return;
    if (resources.length === 0) {
      host.innerHTML = `<div style="padding:40px;color:#666;text-align:center;font-size:12px;">${folders.length === 0 ? 'Drive 폴더를 등록하면 파일이 동기화됩니다.' : '일치하는 파일이 없습니다.'}</div>`;
      return;
    }
    host.innerHTML = resources.map(r => {
      const tags = [...new Set([...(r.folderTags || []), ...(r.tags || [])])];
      return `
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <div style="font-size:22px;min-width:28px;text-align:center;">${iconForMime(r.mimeType)}</div>
          <div style="flex:1;min-width:200px;">
            <div style="color:#fff;font-size:13px;"><strong>${esc(r.fileName)}</strong></div>
            <div style="color:#888;font-size:11px;margin-top:2px;">
              ${esc(r.folderName || '-')} · ${dt(r.modifiedAt)} · ${fmtSize(r.sizeBytes)}
            </div>
            ${tags.length > 0 ? `<div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap;">${tags.slice(0, 6).map(t => `<span style="padding:1px 7px;background:#2a2a4a;color:#aaa;border-radius:8px;font-size:10px;">#${esc(t)}</span>`).join('')}</div>` : ''}
          </div>
          <div style="display:flex;gap:4px;">
            ${user.isAdmin ? `<button type="button" onclick="pmcResources.editTags(${r.id})" style="padding:4px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🏷 태그</button>` : ''}
            ${r.webViewLink ? `<a href="${r.webViewLink}" target="_blank" rel="noopener" style="padding:4px 12px;background:#4285f4;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;text-decoration:none;">📂 열기</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  async function submitFolder(e) {
    e.preventDefault();
    const payload = {
      name: document.getElementById('res-f-name').value.trim(),
      driveFolderId: document.getElementById('res-f-drive-id').value.trim(),
      description: document.getElementById('res-f-desc').value.trim() || null,
      tags: document.getElementById('res-f-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    };
    const res = await fetch('/api/resources/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '실패'); return; }
    document.getElementById('res-folder-form').reset();
    await Promise.all([loadFolders(), loadTags(), refreshResources()]);
    renderFolders();
    renderTagChips();
    alert(`✓ 등록 완료${data.data?.lastSyncFileCount != null ? ` · ${data.data.lastSyncFileCount}개 파일 동기화됨` : ''}`);
  }

  async function syncFolder(id) {
    const res = await fetch('/api/resources/folders/' + id + '/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '실패'); return; }
    await Promise.all([loadFolders(), loadTags(), refreshResources()]);
    renderFolders();
    renderTagChips();
    alert(`✓ 동기화 완료 · ${data.fileCount}개 파일`);
  }

  async function syncAll() {
    const res = await fetch('/api/resources/sync-all', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '실패'); return; }
    await Promise.all([loadFolders(), loadTags(), refreshResources()]);
    renderFolders();
    renderTagChips();
    const ok = (data.results || []).filter(r => r.ok).length;
    alert(`✓ 전체 동기화 완료 · ${ok}/${(data.results || []).length} 폴더 성공`);
  }

  async function toggleFolderActive(id, currentActive) {
    const res = await fetch('/api/resources/folders/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !currentActive }),
    });
    if (!res.ok) { alert('실패'); return; }
    await loadFolders();
    renderFolders();
  }

  async function deleteFolder(id, name) {
    if (!confirm(`"${name}" 폴더 등록을 삭제합니까?\n(Drive 원본 파일은 그대로이지만 연결된 자료실 인덱스는 전부 사라집니다)`)) return;
    const res = await fetch('/api/resources/folders/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('실패'); return; }
    await Promise.all([loadFolders(), loadTags(), refreshResources()]);
    renderFolders();
    renderTagChips();
  }

  async function editTags(id) {
    const r = resources.find(x => x.id === id);
    if (!r) return;
    const current = (r.tags || []).join(', ');
    const next = prompt('태그 (콤마로 구분)', current);
    if (next === null) return;
    const tags = next.split(',').map(s => s.trim()).filter(Boolean);
    const res = await fetch('/api/resources/' + id + '/tags', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    await Promise.all([loadTags(), refreshResources()]);
    renderTagChips();
  }

  window.pmcResources = {
    load, onSearchInput, onFolderFilter, setTagFilter,
    syncFolder, syncAll, toggleFolderActive, deleteFolder, editTags,
    deleteUpload,
  };
})();
