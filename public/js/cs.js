/**
 * CS 지원 (Phase 4) — 고객 메시지 붙여넣고 AI가 템플릿 추천 + 플레이스홀더 채움 +
 * 템플릿 라이브러리 CRUD (admin).
 */
(function() {
  let user = null;
  let templates = [];
  let viewMode = 'compose'; // 'compose' | 'manage'
  let lastSuggestions = [];

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function flagOfLang(l) { return { en: '🇬🇧', ko: '🇰🇷', ja: '🇯🇵', zh: '🇨🇳' }[l] || '🏳️'; }
  function catLabel(c) {
    return { shipping: '배송', order: '주문', refund: '반품/환불', product: '상품문의', restock: '재입고', general: '일반' }[c] || c;
  }
  function catColor(c) {
    return { shipping: '#1565c0', order: '#2e7d32', refund: '#c62828', product: '#6a1b9a', restock: '#ef6c00', general: '#616161' }[c] || '#8d6e63';
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await loadTemplates();
    renderCompose();
  }

  async function loadTemplates() {
    try {
      const res = await fetch('/api/cs/templates');
      const j = await res.json();
      templates = j.data || [];
    } catch (e) { templates = []; }
  }

  function renderShell() {
    const el = document.getElementById('page-cs');
    const manageTab = user.isAdmin ? `<button type="button" id="cs-tab-manage" onclick="pmcCs.switchView('manage')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">⚙️ 템플릿 관리</button>` : '';
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">💬 CS 지원 <span style="color:#888;font-weight:400;font-size:13px;">· 고객 메시지 붙여넣고 AI 답변 추천</span></h1>
        <p style="color:#888;font-size:13px;">eBay/Alibaba 등에서 받은 고객 메시지를 붙여넣으면 적합한 답변 템플릿을 AI가 추천하고 플레이스홀더를 자동으로 채워줍니다.</p>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #2a2a4a;">
        <button type="button" id="cs-tab-compose" onclick="pmcCs.switchView('compose')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">✍️ 답변 작성</button>
        ${manageTab}
      </div>

      <div id="cs-compose"></div>
      <div id="cs-manage" style="display:none;"></div>
    `;
  }

  function switchView(v) {
    viewMode = v;
    document.getElementById('cs-tab-compose').style.color = v === 'compose' ? '#fff' : '#888';
    document.getElementById('cs-tab-compose').style.fontWeight = v === 'compose' ? '600' : '400';
    document.getElementById('cs-tab-compose').style.borderBottom = v === 'compose' ? '2px solid #7c4dff' : '2px solid transparent';
    if (user.isAdmin) {
      const mt = document.getElementById('cs-tab-manage');
      if (mt) {
        mt.style.color = v === 'manage' ? '#fff' : '#888';
        mt.style.fontWeight = v === 'manage' ? '600' : '400';
        mt.style.borderBottom = v === 'manage' ? '2px solid #7c4dff' : '2px solid transparent';
      }
    }
    document.getElementById('cs-compose').style.display = v === 'compose' ? '' : 'none';
    document.getElementById('cs-manage').style.display = v === 'manage' ? '' : 'none';
    if (v === 'manage') renderManage();
    else renderCompose();
  }

  // ── 답변 작성 ──
  function renderCompose() {
    const host = document.getElementById('cs-compose');
    if (!host) return;
    host.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <!-- 왼쪽: 고객 메시지 + 컨텍스트 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
          <h3 style="color:#fff;font-size:14px;margin:0 0 8px;">📩 고객 메시지</h3>
          <textarea id="cs-input" rows="8" placeholder="eBay / Alibaba 등에서 받은 고객 메시지를 붙여넣으세요..." style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-family:inherit;font-size:13px;resize:vertical;margin-bottom:10px;"></textarea>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
            <div>
              <label style="font-size:11px;color:#aaa;">답변 언어</label>
              <select id="cs-lang" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
                <option value="auto">자동 (고객 메시지와 같게)</option>
                <option value="en">English</option>
                <option value="ko">한국어</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#aaa;">카테고리 힌트 (선택)</label>
              <select id="cs-category-hint" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
                <option value="">자동 추론</option>
                <option value="order">주문</option>
                <option value="shipping">배송</option>
                <option value="refund">반품/환불</option>
                <option value="product">상품문의</option>
                <option value="restock">재입고</option>
                <option value="general">일반</option>
              </select>
            </div>
          </div>

          <div style="margin-bottom:10px;">
            <label style="font-size:11px;color:#aaa;">컨텍스트 (선택 — 바이어 이름·주문번호 등)</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:4px;">
              <input type="text" id="cs-ctx-buyer" placeholder="buyer_name" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <input type="text" id="cs-ctx-order" placeholder="order_id" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <input type="text" id="cs-ctx-product" placeholder="product_name" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <input type="text" id="cs-ctx-tracking" placeholder="tracking_number" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            </div>
          </div>

          <button type="button" id="cs-suggest-btn" onclick="pmcCs.suggest()" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;width:100%;">🤖 AI 답변 추천</button>
          <div id="cs-suggest-status" style="margin-top:6px;color:#666;font-size:11px;"></div>
        </div>

        <!-- 오른쪽: 추천 결과 + 템플릿 검색 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <h3 style="color:#fff;font-size:14px;margin:0;">💡 추천 답변</h3>
            <button type="button" onclick="pmcCs.showAllTemplates()" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:11px;">📚 전체 템플릿</button>
          </div>
          <div id="cs-results" style="flex:1;overflow:auto;"></div>
        </div>
      </div>
    `;

    renderResultsEmpty();
  }

  function renderResultsEmpty() {
    const host = document.getElementById('cs-results');
    if (!host) return;
    host.innerHTML = `<div style="padding:30px;text-align:center;color:#666;font-size:12px;">왼쪽에 메시지 붙여넣고 "🤖 AI 답변 추천"을 눌러주세요.</div>`;
  }

  async function suggest() {
    const msg = document.getElementById('cs-input').value.trim();
    if (!msg) { alert('고객 메시지를 입력하세요'); return; }
    const lang = document.getElementById('cs-lang').value;
    const categoryHint = document.getElementById('cs-category-hint').value;
    const context = {
      buyer_name: document.getElementById('cs-ctx-buyer').value.trim() || undefined,
      order_id: document.getElementById('cs-ctx-order').value.trim() || undefined,
      product_name: document.getElementById('cs-ctx-product').value.trim() || undefined,
      tracking_number: document.getElementById('cs-ctx-tracking').value.trim() || undefined,
      categoryHint: categoryHint || undefined,
    };

    const btn = document.getElementById('cs-suggest-btn');
    const status = document.getElementById('cs-suggest-status');
    const host = document.getElementById('cs-results');
    btn.disabled = true; btn.textContent = '🤖 AI 분석 중…';
    status.textContent = 'Gemini에 요청 중...';
    host.innerHTML = '<div style="padding:30px;text-align:center;color:#888;font-size:12px;">⏳ 분석 중…</div>';

    try {
      const res = await fetch('/api/cs/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, language: lang, context }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      lastSuggestions = j.suggestions || [];
      status.textContent = lastSuggestions.length > 0 ? `✓ ${lastSuggestions.length}개 추천` : '추천 결과 없음';
      renderSuggestions();
    } catch (e) {
      status.style.color = '#ff8a80';
      status.textContent = '실패: ' + e.message;
      host.innerHTML = `<div style="padding:20px;color:#ff8a80;font-size:12px;">실패: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = '🤖 AI 답변 추천';
    }
  }

  function renderSuggestions() {
    const host = document.getElementById('cs-results');
    if (!host) return;
    if (lastSuggestions.length === 0) {
      host.innerHTML = '<div style="padding:20px;text-align:center;color:#666;font-size:12px;">적합한 템플릿을 찾지 못했습니다. 전체 템플릿에서 직접 찾아보세요.</div>';
      return;
    }
    host.innerHTML = lastSuggestions.map((s, idx) => {
      const conf = s.confidence || 0;
      const confColor = conf >= 70 ? '#81c784' : conf >= 40 ? '#ffb74d' : '#ff8a80';
      return `
        <div style="background:#0f0f23;border-radius:8px;padding:12px;margin-bottom:8px;border-left:3px solid ${catColor(s.category)};">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">
            <div>
              <strong style="color:#fff;font-size:13px;">${esc(s.title)}</strong>
              <span style="margin-left:8px;color:${confColor};font-size:11px;font-weight:600;">${conf}% 매칭</span>
              <span style="margin-left:6px;padding:1px 7px;background:${catColor(s.category)};color:#fff;border-radius:8px;font-size:10px;">${catLabel(s.category)}</span>
              <span style="margin-left:4px;font-size:11px;">${flagOfLang(s.language)}</span>
            </div>
            <div style="display:flex;gap:4px;">
              <button type="button" onclick="pmcCs.copyAndMark(${s.templateId}, ${idx})" style="padding:4px 10px;background:#2e7d32;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">📋 복사</button>
            </div>
          </div>
          ${s.reason ? `<div style="color:#888;font-size:10px;margin-bottom:6px;">💭 ${esc(s.reason)}</div>` : ''}
          <textarea readonly rows="6" style="width:100%;padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-family:inherit;font-size:12px;resize:vertical;line-height:1.5;">${esc(s.filledBody || s.body)}</textarea>
        </div>
      `;
    }).join('');
  }

  async function copyAndMark(templateId, idx) {
    const s = lastSuggestions[idx];
    if (!s) return;
    const text = s.filledBody || s.body;
    try {
      await navigator.clipboard.writeText(text);
      // 사용 카운트 증가
      fetch('/api/cs/templates/' + templateId + '/use', { method: 'POST' });
      alert('✓ 복사됨. 붙여넣어 사용하세요.');
    } catch (e) {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      alert('✓ 복사됨.');
    }
  }

  function showAllTemplates() {
    const host = document.getElementById('cs-results');
    if (!host) return;
    if (templates.length === 0) {
      host.innerHTML = '<div style="padding:20px;color:#666;font-size:12px;">템플릿이 없습니다.</div>';
      return;
    }
    host.innerHTML = `
      <div style="margin-bottom:10px;">
        <input type="text" id="cs-tpl-search" placeholder="제목 검색..." oninput="pmcCs.filterTemplates()" style="width:100%;padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
      </div>
      <div id="cs-tpl-list">${renderTemplateList(templates)}</div>
    `;
  }

  function renderTemplateList(list) {
    if (list.length === 0) return '<div style="padding:20px;color:#666;text-align:center;font-size:12px;">일치하는 템플릿 없음</div>';
    return list.map(t => `
      <div style="background:#0f0f23;border-radius:6px;padding:8px 10px;margin-bottom:6px;border-left:3px solid ${catColor(t.category)};">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div>
            <strong style="color:#fff;font-size:12px;">${esc(t.title)}</strong>
            <span style="margin-left:4px;font-size:11px;">${flagOfLang(t.language)}</span>
            <span style="margin-left:4px;padding:1px 6px;background:${catColor(t.category)};color:#fff;border-radius:8px;font-size:9px;">${catLabel(t.category)}</span>
            ${t.usageCount > 0 ? `<span style="margin-left:4px;color:#888;font-size:10px;">· ${t.usageCount}회 사용</span>` : ''}
          </div>
          <button type="button" onclick="pmcCs.copyTemplate(${t.id})" style="padding:3px 8px;background:#2e7d32;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">복사</button>
        </div>
        <div style="color:#aaa;font-size:11px;margin-top:4px;white-space:pre-wrap;max-height:60px;overflow:hidden;text-overflow:ellipsis;">${esc((t.body || '').slice(0, 200))}${(t.body || '').length > 200 ? '…' : ''}</div>
      </div>
    `).join('');
  }

  function filterTemplates() {
    const q = document.getElementById('cs-tpl-search').value.toLowerCase().trim();
    const list = q ? templates.filter(t =>
      t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)
    ) : templates;
    const host = document.getElementById('cs-tpl-list');
    if (host) host.innerHTML = renderTemplateList(list);
  }

  async function copyTemplate(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t.body);
      fetch('/api/cs/templates/' + id + '/use', { method: 'POST' });
      alert('✓ 복사됨.');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = t.body; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      alert('✓ 복사됨.');
    }
  }

  // ── 템플릿 관리 (admin) ──
  function renderManage() {
    const host = document.getElementById('cs-manage');
    if (!host || !user.isAdmin) return;
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">➕ 새 템플릿</h3>
        <form id="cs-form">
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:6px;margin-bottom:6px;">
            <input type="text" id="cs-f-title" placeholder="제목 (관리용)" required maxlength="200" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <select id="cs-f-lang" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <option value="en">English</option>
              <option value="ko">한국어</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
            </select>
            <select id="cs-f-cat" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <option value="order">주문</option>
              <option value="shipping">배송</option>
              <option value="refund">반품/환불</option>
              <option value="product">상품문의</option>
              <option value="restock">재입고</option>
              <option value="general">일반</option>
            </select>
          </div>
          <textarea id="cs-f-body" required rows="5" placeholder="본문. {buyer_name}, {order_id} 같은 플레이스홀더는 AI가 자동으로 채웁니다." style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;margin-bottom:6px;"></textarea>
          <button type="submit" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">추가</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📋 템플릿 목록</h3>
          <span style="color:#888;font-size:11px;">${templates.length}개</span>
        </div>
        <div id="cs-tpl-manage-list"></div>
      </div>
    `;
    renderManageList();
    document.getElementById('cs-form').addEventListener('submit', onCreate);
  }

  function renderManageList() {
    const host = document.getElementById('cs-tpl-manage-list');
    if (!host) return;
    if (templates.length === 0) { host.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">템플릿이 없습니다.</div>'; return; }
    host.innerHTML = templates.map(t => `
      <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:6px;">
          <div>
            <strong style="color:#fff;font-size:13px;">${esc(t.title)}</strong>
            <span style="margin-left:6px;font-size:11px;">${flagOfLang(t.language)}</span>
            <span style="margin-left:4px;padding:1px 6px;background:${catColor(t.category)};color:#fff;border-radius:8px;font-size:10px;">${catLabel(t.category)}</span>
            <span style="margin-left:6px;color:#888;font-size:10px;">· ${t.usageCount}회 사용</span>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" onclick="pmcCs.editTemplate(${t.id})" style="padding:3px 8px;background:#2a4a6a;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">✏️</button>
            <button type="button" onclick="pmcCs.deleteTemplate(${t.id})" style="padding:3px 8px;background:#e94560;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">🗑</button>
          </div>
        </div>
        <div style="color:#aaa;font-size:11px;white-space:pre-wrap;max-height:60px;overflow:hidden;">${esc((t.body || '').slice(0, 300))}${(t.body || '').length > 300 ? '…' : ''}</div>
      </div>
    `).join('');
  }

  async function onCreate(e) {
    e.preventDefault();
    const payload = {
      title: document.getElementById('cs-f-title').value.trim(),
      language: document.getElementById('cs-f-lang').value,
      category: document.getElementById('cs-f-cat').value,
      body: document.getElementById('cs-f-body').value.trim(),
    };
    const res = await fetch('/api/cs/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    document.getElementById('cs-form').reset();
    await loadTemplates();
    renderManageList();
  }

  async function editTemplate(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    const newTitle = prompt('제목', t.title);
    if (newTitle === null) return;
    const newBody = prompt('본문', t.body);
    if (newBody === null) return;
    const res = await fetch('/api/cs/templates/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim() }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    await loadTemplates();
    renderManageList();
  }

  async function deleteTemplate(id) {
    if (!confirm('이 템플릿을 삭제하시겠습니까?')) return;
    const res = await fetch('/api/cs/templates/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('실패'); return; }
    await loadTemplates();
    renderManageList();
  }

  window.pmcCs = {
    load, switchView, suggest, copyAndMark, copyTemplate,
    showAllTemplates, filterTemplates,
    editTemplate, deleteTemplate,
  };
})();
