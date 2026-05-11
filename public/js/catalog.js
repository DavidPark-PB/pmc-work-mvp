/**
 * 카탈로그 가격 관리 — Google Sheets 3시트 (USD/KRW/EURO) 동시 관리
 */
(function() {
  // PR catalog-fix 2026-05: pendingChanges = rowKey('rowIndex-side') → 임시 USD 값 (저장 전)
  // failedRows = rowKey → error message (마지막 batch 저장 실패한 행)
  let state = {
    tab: '', tabs: [], rates: null, items: [], category: '', search: '',
    loading: false, accioEnabled: false,
    pendingChanges: new Map(),
    failedRows: new Map(),
    saving: false,
  };

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
    // PR catalog-fix 2026-05: dirty / failed 표시
    const pending = state.pendingChanges.has(rowKey);
    const failed = state.failedRows.has(rowKey);
    const inputValue = pending ? state.pendingChanges.get(rowKey) : (it.usdPrice != null ? it.usdPrice : '');
    let inputBorder = '#333';
    let bg = '#0f0f23';
    let badge = '';
    if (failed) {
      inputBorder = '#e94560'; bg = '#2a1a1a';
      badge = `<span title="${esc(state.failedRows.get(rowKey))}" style="color:#ff8a80;font-size:10px;margin-left:4px;">❌</span>`;
    } else if (pending) {
      inputBorder = '#ff9800'; bg = '#2a1a0f';
      badge = `<span title="저장 안 됨 — 헤더 '일괄 저장' 클릭" style="color:#ffb74d;font-size:10px;margin-left:4px;">●</span>`;
    }
    return `
      <tr style="border-bottom:1px solid #2a2a4a;${failed ? 'background:#1a0a0a;' : (pending ? 'background:#1a120a;' : '')}">
        <td style="padding:8px;text-align:center;color:#888;font-size:12px;">${esc(it.num)}</td>
        <td style="padding:8px;text-align:center;">${imgCell}</td>
        <td style="padding:8px;white-space:pre-wrap;">${esc(it.name)}${state.search ? ` <span style="color:#7c4dff;font-size:10px;margin-left:4px;">· ${esc(it.category)}</span>` : ''}</td>
        <td style="padding:8px;color:#81d4fa;"><code>${esc(it.setCode)}</code></td>
        <td style="padding:8px;text-align:right;white-space:nowrap;">
          <div style="display:flex;gap:4px;align-items:center;justify-content:flex-end;">
            <span style="color:#888;">$</span>
            <input type="number" value="${inputValue}" step="0.01" min="0"
              data-row="${it.rowIndex}" data-side="${it.side}" data-rowkey="${rowKey}"
              data-original="${it.usdPrice != null ? it.usdPrice : ''}"
              oninput="pmcCatalog.markDirty('${rowKey}', this.value)"
              style="width:80px;padding:4px 6px;background:${bg};border:1px solid ${inputBorder};border-radius:4px;color:#fff;font-size:13px;text-align:right;">
            ${badge}
          </div>
        </td>
        <td style="padding:8px;text-align:right;color:${pending ? '#666' : '#b0b0b0'};">${fmtMoney(it.krwPrice, '₩')}${pending ? ' <span style="font-size:9px;color:#ffb74d;">(저장 후 갱신)</span>' : ''}</td>
        <td style="padding:8px;text-align:right;color:${pending ? '#666' : '#b0b0b0'};">${fmtMoney(it.euroPrice, '€')}</td>
        <td style="padding:8px;text-align:center;color:#555;font-size:11px;">${it.side === 'left' ? 'F' : 'M'}${it.rowIndex}</td>
      </tr>
    `;
  }

  function onTabChange() {
    // PR catalog-fix 2026-05: 미저장 변경 있으면 경고
    if (state.pendingChanges.size > 0) {
      if (!confirm(`저장 안 된 변경 ${state.pendingChanges.size}건이 있습니다. 탭을 바꾸면 사라집니다. 계속할까요?`)) {
        const sel = document.getElementById('cat-tab');
        if (sel) sel.value = state.tab;
        return;
      }
      state.pendingChanges.clear();
      state.failedRows.clear();
    }
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

  // ── PR catalog-fix 2026-05: 임시 변경 + 일괄 저장 ──

  function markDirty(rowKey, usdValue) {
    if (state.saving) return;
    const num = Number(usdValue);
    const [rowIndexStr, side] = rowKey.split('-');
    const rowIndex = Number(rowIndexStr);
    const it = state.items.find(x => x.rowIndex === rowIndex && x.side === side);
    const original = it?.usdPrice != null ? Number(it.usdPrice) : null;

    // 원래 값과 같으면 dirty 해제. 다르거나 입력 비어있으면 dirty.
    if (Number.isFinite(num) && original != null && num === original) {
      state.pendingChanges.delete(rowKey);
    } else if (usdValue === '' || !Number.isFinite(num) || num < 0) {
      // 빈 값 / invalid → dirty 표시 안 함 (저장 시 invalid 행은 backend 가 거부)
      state.pendingChanges.delete(rowKey);
    } else {
      state.pendingChanges.set(rowKey, num);
    }
    // 실패 표시는 사용자가 다시 수정하면 해제
    state.failedRows.delete(rowKey);
    _refreshSaveBar();
  }

  // 헤더 sticky 바: 변경된 N건 표시 + "💾 일괄 저장" 버튼
  function _refreshSaveBar() {
    let bar = document.getElementById('cat-save-bar');
    const n = state.pendingChanges.size;
    if (n === 0 && !state.saving) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cat-save-bar';
      bar.style.cssText = 'position:sticky;top:0;z-index:50;background:#1a1a2e;border:1px solid #ff9800;border-radius:8px;padding:10px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;box-shadow:0 4px 8px rgba(0,0,0,0.4);';
      const content = document.getElementById('cat-content');
      if (content) content.parentNode.insertBefore(bar, content);
      else return;
    }
    const failedCount = state.failedRows.size;
    bar.innerHTML = `
      <div style="color:#ffb74d;font-size:13px;">
        ●  변경됨 <strong style="color:#fff;">${n}건</strong>
        ${failedCount > 0 ? `· <span style="color:#ff8a80;">실패 ${failedCount}건</span>` : ''}
        <span style="color:#888;font-size:11px;margin-left:6px;">저장하기 전엔 시트에 반영 안 됨</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button onclick="pmcCatalog.discardChanges()" ${state.saving ? 'disabled' : ''}
          style="padding:6px 12px;background:#2a2a4a;border:0;border-radius:4px;color:#aaa;cursor:${state.saving ? 'not-allowed' : 'pointer'};font-size:12px;">
          ↶ 취소
        </button>
        <button onclick="pmcCatalog.saveAll()" ${state.saving || n === 0 ? 'disabled' : ''}
          style="padding:6px 16px;background:${state.saving ? '#555' : '#7c4dff'};border:0;border-radius:4px;color:#fff;cursor:${state.saving ? 'not-allowed' : 'pointer'};font-size:12px;font-weight:600;">
          ${state.saving ? '⏳ 저장 중...' : `💾 일괄 저장 (${n}건)`}
        </button>
      </div>
    `;
  }

  function discardChanges() {
    if (state.saving) return;
    state.pendingChanges.clear();
    state.failedRows.clear();
    renderTable();
    _refreshSaveBar();
  }

  async function saveAll() {
    if (state.saving) return;
    if (state.pendingChanges.size === 0) return;

    state.saving = true;
    state.failedRows.clear();
    _refreshSaveBar();
    renderTable();

    const items = [];
    for (const [rowKey, usdPrice] of state.pendingChanges.entries()) {
      const [rowIndex, side] = rowKey.split('-');
      items.push({ rowIndex: Number(rowIndex), side, usdPrice });
    }

    try {
      const res = await fetch('/api/catalog/prices/batch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: state.tab, items }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 502 || data.totalSucceeded === 0) {
        // 전체 실패
        for (const [rowKey] of state.pendingChanges.entries()) {
          state.failedRows.set(rowKey, data.error || '시트 업데이트 실패');
        }
        alert(`❌ 저장 실패: ${data.error || '시트 업데이트 실패'}`);
      } else {
        // 성공 행은 pendingChanges 에서 제거, 실패 행은 failedRows 에 보관
        for (const r of data.results || []) {
          const rk = `${r.rowIndex}-${r.side}`;
          if (r.ok) {
            state.pendingChanges.delete(rk);
          } else {
            state.failedRows.set(rk, r.error || '실패');
          }
        }
        if (data.totalFailed > 0) {
          alert(`⚠️ ${data.totalSucceeded}건 저장 성공 / ${data.totalFailed}건 실패\n실패한 행은 빨간색으로 표시됩니다. 수정 후 다시 저장하세요.`);
        } else {
          showSaveToast(`✓ ${data.totalSucceeded}건 일괄 저장 완료`);
        }

        // 사장님 spec 4: 저장 완료 후 시트에서 최신 KRW/EUR 재조회
        if (data.totalSucceeded > 0) {
          await refresh();
        }
      }
    } catch (e) {
      // network / 5xx — 모두 실패 처리
      for (const [rowKey] of state.pendingChanges.entries()) {
        state.failedRows.set(rowKey, e.message);
      }
      alert(`❌ 네트워크 오류: ${e.message}\n다시 시도하세요.`);
    } finally {
      state.saving = false;
      _refreshSaveBar();
      renderTable();
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
    load, refresh, onTabChange, setCategory,
    // PR catalog-fix 2026-05: 일괄 저장 (savePrice 는 보존 — 호출처 없으면 dead code)
    markDirty, saveAll, discardChanges, savePrice,
    openFxModal, closeFxModal, saveFx, resetFxAuto, editImage,
    onSearch, clearSearch,
    openAiImage, closeAiImage, runAiImage, copyAiUrl,
  };
})();
