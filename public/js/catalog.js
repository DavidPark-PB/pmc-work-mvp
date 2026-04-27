/**
 * 카탈로그 가격 관리 — Google Sheets 3시트 (USD/KRW/EURO) 동시 관리
 */
(function() {
  let state = { tab: '', tabs: [], rates: null, items: [], category: '', search: '', loading: false, accioEnabled: false };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtMoney(n, sym) {
    if (n == null) return '-';
    const str = sym === '₩' ? Math.round(n).toLocaleString('en-US') : (sym === '€' ? n.toFixed(2) : n.toFixed(2));
    return sym + str;
  }

  async function load() {
    renderShell();
    checkAccio();
    await refresh();
  }

  async function checkAccio() {
    try {
      const r = await fetch('/api/accio/health');
      const j = await r.json();
      state.accioEnabled = !!(j.enabled && j.healthy);
    } catch { state.accioEnabled = false; }
  }

  function renderShell() {
    const el = document.getElementById('page-catalog');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <div>
          <h1 style="font-size:22px;color:#fff;margin:0;">📗 카탈로그 가격 관리</h1>
          <p style="color:#888;font-size:13px;margin:4px 0 0;">USD 편집 시 KRW/EURO 시트 자동 동기화</p>
        </div>
        <div style="background:#1a1a2e;padding:10px 14px;border-radius:8px;border:1px solid #2a2a4a;min-width:260px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
            <span style="font-size:11px;color:#888;">적용 환율 <span id="cat-rates-mode" style="color:#81c784;"></span></span>
            <button onclick="pmcCatalog.openFxModal()" style="background:#7c4dff;color:#fff;border:0;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;">편집</button>
          </div>
          <div id="cat-rates" style="font-size:13px;color:#fff;font-weight:600;">로딩…</div>
          <div id="cat-rates-market" style="font-size:10px;color:#666;margin-top:2px;"></div>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        <label style="color:#888;font-size:13px;">게임 탭:</label>
        <select id="cat-tab" onchange="pmcCatalog.onTabChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;"></select>
        <button onclick="pmcCatalog.refresh()" style="padding:6px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">🔄 새로고침</button>
        <div style="flex:1;min-width:200px;position:relative;">
          <input type="search" id="cat-search" placeholder="🔍 상품명 · 세트코드 검색…" oninput="pmcCatalog.onSearch(this.value)" style="width:100%;padding:7px 30px 7px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          <button id="cat-search-clear" onclick="pmcCatalog.clearSearch()" style="display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#888;cursor:pointer;font-size:14px;padding:2px 6px;">✕</button>
        </div>
        <span id="cat-search-count" style="color:#888;font-size:11px;"></span>
      </div>

      <div id="cat-category-tabs" style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;border-bottom:1px solid #2a2a4a;padding-bottom:8px;"></div>

      <div id="cat-content"></div>
    `;
  }

  async function refresh() {
    const content = document.getElementById('cat-content');
    if (!content) return;
    content.innerHTML = '<div style="padding:60px;text-align:center;color:#888;">시트 읽는 중…</div>';

    const tab = state.tab || '';
    const res = await fetch('/api/catalog/prices' + (tab ? ('?tab=' + encodeURIComponent(tab)) : ''));
    if (!res.ok) { content.innerHTML = '<div style="padding:40px;color:#ff8a80;">조회 실패: ' + (await res.json()).error + '</div>'; return; }
    const data = await res.json();
    state.tab = data.tab;
    state.tabs = data.tabs;
    state.rates = data.rates;
    state.items = data.items;
    if (!state.category) {
      const cats = categoryList();
      state.category = cats[0] || '';
    }
    renderRates();
    renderTabSelector();
    renderCategoryTabs();
    renderTable();
  }

  function categoryList() {
    const set = new Set();
    for (const it of state.items) set.add(it.category);
    return [...set];
  }

  function renderRates() {
    const r = state.rates;
    const el = document.getElementById('cat-rates');
    const mkt = document.getElementById('cat-rates-market');
    const mode = document.getElementById('cat-rates-mode');
    if (!el || !r) return;
    el.textContent = `1 USD = ₩${Math.round(r.usdToKrw).toLocaleString()} · €${r.usdToEur.toFixed(3)}`;
    if (mkt && r.marketKrw != null) {
      const manual = r.mode === 'manual';
      mkt.textContent = manual
        ? `시장: ₩${Math.round(r.marketKrw).toLocaleString()} · €${r.marketEur.toFixed(3)}  (수동 입력값 사용 중)`
        : `시장: ₩${Math.round(r.marketKrw).toLocaleString()} · €${r.marketEur.toFixed(3)}  (마진 -${r.marginKrw}원 / -${r.marginEur}€)`;
    }
    if (mode) mode.textContent = r.mode === 'manual' ? '· 수동' : '· 자동';
  }

  function renderTabSelector() {
    const sel = document.getElementById('cat-tab');
    if (!sel) return;
    sel.innerHTML = state.tabs.map(t =>
      `<option value="${esc(t)}" ${t === state.tab ? 'selected' : ''}>${esc(shortTabLabel(t))}</option>`
    ).join('');
  }

  function shortTabLabel(t) {
    // "[POKEMON] TCG LIST_USD" → "POKEMON"
    const m = t.match(/\[([^\]]+)\]/);
    return m ? m[1] : t;
  }

  function renderCategoryTabs() {
    const cats = categoryList();
    const el = document.getElementById('cat-category-tabs');
    if (!el) return;
    el.innerHTML = cats.map(c => `
      <button onclick="pmcCatalog.setCategory('${esc(c)}')" style="padding:8px 14px;background:${c === state.category ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;font-weight:${c === state.category ? '600' : '400'};">
        ${esc(c)}
      </button>
    `).join('');
  }

  function renderTable() {
    const el = document.getElementById('cat-content');
    if (!el) return;
    const q = (state.search || '').trim().toLowerCase();
    // 검색 시 카테고리 필터 무시 (전 탭 대상) / 없으면 카테고리 내
    const base = q ? state.items : state.items.filter(it => it.category === state.category);
    const items = q
      ? base.filter(it =>
          (it.name || '').toLowerCase().includes(q) ||
          (it.setCode || '').toLowerCase().includes(q) ||
          String(it.num || '').toLowerCase().includes(q))
      : base;

    // 검색 카운트 표시
    const cnt = document.getElementById('cat-search-count');
    if (cnt) cnt.textContent = q ? `${items.length}건` : '';
    const clr = document.getElementById('cat-search-clear');
    if (clr) clr.style.display = q ? '' : 'none';

    if (items.length === 0) {
      el.innerHTML = q
        ? `<div style="padding:40px;text-align:center;color:#888;">"${esc(q)}" 검색 결과 없음</div>`
        : '<div style="padding:40px;text-align:center;color:#888;">이 카테고리에 상품이 없습니다.</div>';
      return;
    }
    el.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:auto;">
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:13px;">
          <thead>
            <tr style="background:#0f0f23;">
              <th style="padding:10px;text-align:center;">#</th>
              <th style="padding:10px;text-align:center;">이미지</th>
              <th style="padding:10px;text-align:left;">상품명</th>
              <th style="padding:10px;text-align:left;">세트 코드</th>
              <th style="padding:10px;text-align:right;">USD (편집)</th>
              <th style="padding:10px;text-align:right;">KRW</th>
              <th style="padding:10px;text-align:right;">EURO</th>
              <th style="padding:10px;text-align:center;">위치</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(renderRow).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRow(it) {
    const rowKey = `${it.rowIndex}-${it.side}`;
    const manualBadge = it.imageSource === 'manual' ? '<div style="position:absolute;top:-4px;right:-4px;background:#7c4dff;color:#fff;font-size:9px;padding:1px 4px;border-radius:6px;" title="수동 지정">M</div>' : '';
    const imgInner = it.image
      ? `<img src="/api/img-proxy?url=${encodeURIComponent(it.image)}" onerror="this.src='${esc(it.image)}';this.onerror=null;" style="width:52px;height:52px;object-fit:contain;background:#fff;border-radius:4px;">`
      : '<div style="width:52px;height:52px;background:#0f0f23;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#555;font-size:10px;">없음</div>';
    const aiBtn = (state.accioEnabled && it.image)
      ? `<button onclick="pmcCatalog.openAiImage(${it.rowIndex}, '${it.side}')" title="Accio AI 이미지 생성" style="display:block;margin-top:2px;padding:1px 6px;background:#7c4dff;color:#fff;border:0;border-radius:3px;cursor:pointer;font-size:10px;width:100%;">🎨 AI</button>`
      : '';
    const imgCell = `
      <div style="position:relative;display:inline-block;">
        ${imgInner}
        ${manualBadge}
        <button onclick="pmcCatalog.editImage(${it.rowIndex}, '${it.side}')" title="이미지 URL 수정" style="display:block;margin-top:2px;padding:1px 6px;background:#2a2a4a;color:#aaa;border:0;border-radius:3px;cursor:pointer;font-size:10px;width:100%;">수정</button>
        ${aiBtn}
      </div>`;
    return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:8px;text-align:center;color:#888;font-size:12px;">${esc(it.num)}</td>
        <td style="padding:8px;text-align:center;">${imgCell}</td>
        <td style="padding:8px;white-space:pre-wrap;">${esc(it.name)}${state.search ? ` <span style="color:#7c4dff;font-size:10px;margin-left:4px;">· ${esc(it.category)}</span>` : ''}</td>
        <td style="padding:8px;color:#81d4fa;"><code>${esc(it.setCode)}</code></td>
        <td style="padding:8px;text-align:right;white-space:nowrap;">
          <div style="display:flex;gap:4px;align-items:center;justify-content:flex-end;">
            <span style="color:#888;">$</span>
            <input type="number" value="${it.usdPrice != null ? it.usdPrice : ''}" step="0.01" min="0"
              data-row="${it.rowIndex}" data-side="${it.side}"
              onkeydown="if(event.key==='Enter'){pmcCatalog.savePrice('${rowKey}',event.target.value);event.target.blur();}"
              style="width:80px;padding:4px 6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;text-align:right;">
            <button onclick="pmcCatalog.savePrice('${rowKey}', this.previousElementSibling.value)" style="padding:4px 8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">저장</button>
          </div>
        </td>
        <td style="padding:8px;text-align:right;color:#b0b0b0;">${fmtMoney(it.krwPrice, '₩')}</td>
        <td style="padding:8px;text-align:right;color:#b0b0b0;">${fmtMoney(it.euroPrice, '€')}</td>
        <td style="padding:8px;text-align:center;color:#555;font-size:11px;">${it.side === 'left' ? 'F' : 'M'}${it.rowIndex}</td>
      </tr>
    `;
  }

  function onTabChange() {
    const sel = document.getElementById('cat-tab');
    state.tab = sel.value;
    state.category = '';
    refresh();
  }

  function setCategory(cat) {
    state.category = cat;
    renderCategoryTabs();
    renderTable();
  }

  async function savePrice(rowKey, usdValue) {
    const [rowIndex, side] = rowKey.split('-');
    const usdPrice = Number(usdValue);
    if (!Number.isFinite(usdPrice) || usdPrice < 0) { alert('가격을 올바로 입력하세요'); return; }
    const res = await fetch('/api/catalog/prices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: state.tab, rowIndex: Number(rowIndex), side, usdPrice }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert('저장 실패: ' + (err.error || '오류'));
      return;
    }
    const { result } = await res.json();
    // 로컬 state 업데이트 후 행만 다시 렌더
    const it = state.items.find(x => x.rowIndex === Number(rowIndex) && x.side === side);
    if (it) {
      it.usdPrice = result.updated.usd;
      it.krwPrice = result.updated.krw;
      it.euroPrice = result.updated.eur;
    }
    renderTable();
    if (result.partialFailures && result.partialFailures.length > 0) {
      const fails = result.partialFailures.map(f => `${f.label}: ${f.error}`).join('\n');
      alert(`⚠️ 일부 시트 갱신 실패\n\n${fails}\n\n성공한 시트는 저장됐고 화면도 갱신됐습니다. 실패한 시트는 권한 문제일 수 있어요.`);
    } else {
      showSaveToast(`${result.formatted.USD} / ${result.formatted.KRW} / ${result.formatted.EURO} 저장됨`);
    }
  }

  function showSaveToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:20px;right:20px;background:#4caf50;color:#fff;padding:12px 20px;border-radius:8px;z-index:2000;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ── 환율 편집 모달 ──
  function openFxModal() {
    const r = state.rates || {};
    const curKrw = Math.round(r.usdToKrw || 0);
    const curEur = (r.usdToEur || 0).toFixed(3);
    const html = `
      <div id="fx-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:var(--space-4);">
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:420px;max-width:90vw;">
          <h2 style="color:#fff;font-size:17px;margin:0 0 12px;">환율 편집</h2>
          <p style="color:#888;font-size:12px;margin:0 0 16px;">숫자를 입력하면 수동 모드. 비워두면 자동(시장환율 - 마진)로 복원됩니다.</p>

          <div style="background:#0f0f23;padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:12px;color:#aaa;">
            시장 환율: ₩${Math.round(r.marketKrw||0).toLocaleString()} · €${(r.marketEur||0).toFixed(3)}
          </div>

          <div style="margin-bottom:10px;">
            <label style="display:block;color:#888;font-size:12px;margin-bottom:4px;">USD → KRW (원)</label>
            <input id="fx-krw" type="number" step="0.01" min="0" placeholder="예: 1440" value="${curKrw || ''}" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <div style="margin-bottom:16px;">
            <label style="display:block;color:#888;font-size:12px;margin-bottom:4px;">USD → EUR</label>
            <input id="fx-eur" type="number" step="0.001" min="0" placeholder="예: 0.820" value="${curEur || ''}" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>

          <div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
            <button onclick="pmcCatalog.closeFxModal()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
            <button onclick="pmcCatalog.resetFxAuto()" style="padding:8px 14px;background:#555;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">자동(시장환율)으로 복원</button>
            <button onclick="pmcCatalog.saveFx()" style="padding:8px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">저장</button>
          </div>
        </div>
      </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
  }
  function closeFxModal() { document.getElementById('fx-modal')?.remove(); }

  async function saveFx() {
    const krw = document.getElementById('fx-krw').value.trim();
    const eur = document.getElementById('fx-eur').value.trim();
    const body = {};
    body.usdToKrw = krw === '' ? null : Number(krw);
    body.usdToEur = eur === '' ? null : Number(eur);
    const res = await fetch('/api/catalog/rates', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { alert('저장 실패: ' + (await res.json()).error); return; }
    closeFxModal();
    refresh();
  }

  async function resetFxAuto() {
    const res = await fetch('/api/catalog/rates', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usdToKrw: null, usdToEur: null }),
    });
    if (!res.ok) { alert('복원 실패'); return; }
    closeFxModal();
    refresh();
  }

  // ── 이미지 수동 지정 ──
  async function editImage(rowIndex, side) {
    const current = (state.items.find(it => it.rowIndex === rowIndex && it.side === side) || {}).image || '';
    const url = prompt('이미지 URL을 입력하세요 (빈 값 = 자동 매칭으로 복원):', current);
    if (url === null) return; // cancel
    const res = await fetch('/api/catalog/image', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: state.tab, rowIndex, side, imageUrl: url.trim() }),
    });
    if (!res.ok) { alert('저장 실패: ' + (await res.json()).error); return; }
    refresh();
  }

  let searchTimer = null;
  function onSearch(v) {
    state.search = v || '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTable, 120);
  }

  function clearSearch() {
    state.search = '';
    const inp = document.getElementById('cat-search');
    if (inp) inp.value = '';
    renderTable();
  }

  // ── AI 이미지 생성 (Accio Gateway) ──
  let aiPollTimer = null;
  function openAiImage(rowIndex, side) {
    const it = state.items.find(x => x.rowIndex === rowIndex && x.side === side);
    if (!it || !it.image) { alert('이미지가 있는 상품만 AI 생성 가능합니다'); return; }
    document.getElementById('ai-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'ai-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:560px;max-width:95vw;max-height:92vh;overflow:auto;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="color:#fff;font-size:16px;margin:0;">🎨 AI 이미지 생성 <span style="color:#888;font-size:12px;font-weight:400;">${esc(it.name)}</span></h2>
          <button onclick="pmcCatalog.closeAiImage()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:12px;">
          <div style="flex:0 0 140px;">
            <div style="font-size:11px;color:#888;margin-bottom:4px;">원본</div>
            <img src="/api/img-proxy?url=${encodeURIComponent(it.image)}" onerror="this.src='${esc(it.image)}';this.onerror=null;" style="width:140px;height:140px;object-fit:contain;background:#fff;border-radius:6px;">
          </div>
          <div id="ai-result-pane" style="flex:1;min-height:140px;display:flex;align-items:center;justify-content:center;border:1px dashed #333;border-radius:6px;background:#0f0f23;color:#666;font-size:12px;">
            생성 결과가 여기에 표시됩니다
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">모드</label>
            <select id="ai-mode" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
              <option value="scene" selected>장면/모델 생성</option>
              <option value="color">색상 변형</option>
              <option value="logo">로고 삽입</option>
              <option value="translate">이미지 번역</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#888;">프롬프트 (선택)</label>
            <input id="ai-prompt" type="text" placeholder="예: on a wooden table, natural light" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
        </div>
        <div id="ai-status" style="font-size:12px;color:#888;margin-bottom:8px;min-height:16px;"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcCatalog.closeAiImage()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">닫기</button>
          <button id="ai-gen-btn" onclick="pmcCatalog.runAiImage('${it.image.replace(/'/g,"\\'")}')" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">생성</button>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) closeAiImage(); });
    document.body.appendChild(m);
  }

  function closeAiImage() {
    if (aiPollTimer) { clearTimeout(aiPollTimer); aiPollTimer = null; }
    document.getElementById('ai-modal')?.remove();
  }

  async function runAiImage(imageUrl) {
    const status = document.getElementById('ai-status');
    const btn = document.getElementById('ai-gen-btn');
    const pane = document.getElementById('ai-result-pane');
    const mode = document.getElementById('ai-mode').value;
    const prompt = document.getElementById('ai-prompt').value.trim();
    btn.disabled = true; btn.textContent = '생성 중...';
    status.textContent = '요청 중…';
    pane.innerHTML = '<div style="color:#888;">⏳ 처리 중 (보통 15~45초)</div>';
    try {
      const r = await fetch('/api/accio/image/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, mode, prompt: prompt || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '요청 실패');
      status.textContent = `요청 접수 — key=${j.requestKey.slice(0, 12)}… 폴링 중`;
      pollAiImage(j.requestKey, Date.now() + 90 * 1000);
    } catch (e) {
      status.textContent = '';
      pane.innerHTML = `<div style="color:#ff8a80;padding:12px;">❌ ${esc(e.message)}</div>`;
      btn.disabled = false; btn.textContent = '다시 시도';
    }
  }

  async function pollAiImage(key, deadline) {
    const status = document.getElementById('ai-status');
    const btn = document.getElementById('ai-gen-btn');
    const pane = document.getElementById('ai-result-pane');
    if (!status || !pane) return;
    if (Date.now() > deadline) {
      status.textContent = '';
      pane.innerHTML = '<div style="color:#ff8a80;padding:12px;">⏱ 타임아웃 (90초). 다시 시도하세요.</div>';
      if (btn) { btn.disabled = false; btn.textContent = '다시 시도'; }
      return;
    }
    try {
      const r = await fetch('/api/accio/image/result?key=' + encodeURIComponent(key));
      const j = await r.json();
      if (j.status === 'done' && j.imageUrl) {
        status.textContent = '✓ 완료';
        pane.innerHTML = `
          <div style="width:100%;text-align:center;">
            <img src="${esc(j.imageUrl)}" style="max-width:100%;max-height:320px;background:#fff;border-radius:6px;">
            <div style="margin-top:8px;display:flex;gap:6px;justify-content:center;">
              <button onclick="pmcCatalog.copyAiUrl('${j.imageUrl.replace(/'/g,"\\'")}')" style="padding:6px 14px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">📋 URL 복사</button>
              <a href="${esc(j.imageUrl)}" target="_blank" rel="noopener" style="padding:6px 14px;background:#2a2a4a;border-radius:4px;color:#fff;text-decoration:none;font-size:12px;">새 탭 열기</a>
            </div>
          </div>`;
        if (btn) { btn.disabled = false; btn.textContent = '다시 생성'; }
        return;
      }
      if (j.status === 'failed') {
        status.textContent = '';
        pane.innerHTML = '<div style="color:#ff8a80;padding:12px;">❌ Accio 가 생성 실패를 반환했습니다.</div>';
        if (btn) { btn.disabled = false; btn.textContent = '다시 시도'; }
        return;
      }
      status.textContent = `⏳ 진행 중… ${Math.round((deadline - Date.now()) / 1000)}초 남음`;
      aiPollTimer = setTimeout(() => pollAiImage(key, deadline), 3000);
    } catch (e) {
      status.textContent = '';
      pane.innerHTML = `<div style="color:#ff8a80;padding:12px;">❌ 폴링 실패: ${esc(e.message)}</div>`;
      if (btn) { btn.disabled = false; btn.textContent = '다시 시도'; }
    }
  }

  async function copyAiUrl(url) {
    try { await navigator.clipboard.writeText(url); showSaveToast('URL 복사됨'); }
    catch { prompt('수동 복사:', url); }
  }

  window.pmcCatalog = {
    load, refresh, onTabChange, setCategory, savePrice,
    openFxModal, closeFxModal, saveFx, resetFxAuto, editImage,
    onSearch, clearSearch,
    openAiImage, closeAiImage, runAiImage, copyAiUrl,
  };
})();
