/**
 * 카탈로그 가격 관리 — Google Sheets 3시트 (USD/KRW/EURO) 동시 관리
 */
(function() {
  let state = { tab: '', tabs: [], rates: null, items: [], category: '', loading: false };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtMoney(n, sym) {
    if (n == null) return '-';
    const str = sym === '₩' ? Math.round(n).toLocaleString('en-US') : (sym === '€' ? n.toFixed(2) : n.toFixed(2));
    return sym + str;
  }

  async function load() {
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-catalog');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
        <div>
          <h1 style="font-size:22px;color:#fff;margin:0;">📗 카탈로그 가격 관리</h1>
          <p style="color:#888;font-size:13px;margin:4px 0 0;">USD 편집 시 KRW/EURO 시트 자동 동기화</p>
        </div>
        <div style="background:#1a1a2e;padding:10px 14px;border-radius:8px;border:1px solid #2a2a4a;">
          <div style="font-size:11px;color:#888;">실시간 환율 (frankfurter.app)</div>
          <div id="cat-rates" style="font-size:13px;color:#fff;font-weight:600;">로딩…</div>
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
        <label style="color:#888;font-size:13px;">게임 탭:</label>
        <select id="cat-tab" onchange="pmcCatalog.onTabChange()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;"></select>
        <button onclick="pmcCatalog.refresh()" style="padding:6px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">🔄 새로고침</button>
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
    if (!el || !r) return;
    el.textContent = `1 USD = ₩${Math.round(r.usdToKrw).toLocaleString()} · €${r.usdToEur.toFixed(3)}`;
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
    const items = state.items.filter(it => it.category === state.category);
    if (items.length === 0) {
      el.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">이 카테고리에 상품이 없습니다.</div>';
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
    const imgCell = it.image
      ? `<img src="/api/img-proxy?url=${encodeURIComponent(it.image)}" onerror="this.src='${esc(it.image)}';this.onerror=null;" style="width:52px;height:52px;object-fit:contain;background:#fff;border-radius:4px;">`
      : '<div style="width:52px;height:52px;background:#0f0f23;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#555;font-size:10px;">없음</div>';
    return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:8px;text-align:center;color:#888;font-size:12px;">${esc(it.num)}</td>
        <td style="padding:8px;text-align:center;">${imgCell}</td>
        <td style="padding:8px;white-space:pre-wrap;">${esc(it.name)}</td>
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
    showSaveToast(`${result.formatted.USD} / ${result.formatted.KRW} / ${result.formatted.EURO} 저장됨`);
  }

  function showSaveToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:20px;right:20px;background:#4caf50;color:#fff;padding:12px 20px;border-radius:8px;z-index:2000;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  window.pmcCatalog = { load, refresh, onTabChange, setCategory, savePrice };
})();
