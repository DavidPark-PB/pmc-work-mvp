/**
 * 재고 실사 (Stocktake) — 직원용 창고 실재고 카운트 페이지.
 * 검색 + 바코드 스캐너 + 실사 입력 + 세션 이력.
 */
(function() {
  let user = null;
  let sessionId = null;
  let selected = null;     // 현재 선택된 아이템
  let sessionLog = [];     // 이번 세션에서 저장한 조정 이력 (UI용)
  let scanToIncrement = false;
  let scannerInstance = null;

  const REASONS = ['실사', '파손', '분실', '이벤트', '반품', '기타'];

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await startSession();
  }

  async function startSession() {
    try {
      const r = await fetch('/api/stocktake/session/start', { method: 'POST' });
      const j = await r.json();
      sessionId = j.sessionId;
      sessionLog = [];
      document.getElementById('st-session-id').textContent = sessionId;
      renderSessionLog();
    } catch (e) {
      console.warn('세션 시작 실패', e);
    }
  }

  function renderShell() {
    const el = document.getElementById('page-stocktake');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">📦 재고 실사 <span style="color:#888;font-weight:400;font-size:13px;">· 실물 카운트 → 시스템 재고 업데이트</span></h1>
        <p style="color:#888;font-size:13px;">검색·바코드 스캔으로 상품 찾고 실제 수량 입력하면 DB에 즉시 반영 + 조정 로그 저장.</p>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        <!-- 좌: 검색 & 결과 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <input id="st-search" type="search" placeholder="🔍 SKU · 바코드 · 상품명 (Enter로 확정)"
              oninput="pmcStocktake.onSearch(this.value)"
              onkeydown="if(event.key==='Enter'){pmcStocktake.onSearchEnter();}"
              style="flex:1;padding:8px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            <button onclick="pmcStocktake.openScanner()" style="padding:8px 12px;background:#1565c0;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🎥 스캐너</button>
          </div>
          <div id="st-search-hint" style="font-size:11px;color:#666;margin-bottom:6px;">USB 바코드 스캐너: 검색창 포커스 후 스캔 (자동 Enter 입력)</div>
          <div id="st-results" style="max-height:420px;overflow:auto;"></div>
        </div>

        <!-- 우: 선택된 아이템 & 실사 입력 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
          <div id="st-selected">
            <div style="padding:40px;text-align:center;color:#888;font-size:13px;">← 왼쪽에서 상품 검색 후 선택하세요</div>
          </div>
        </div>
      </div>

      <!-- 세션 이력 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h3 style="color:#fff;font-size:14px;margin:0;">🗂 이번 세션 실사 이력 <span id="st-session-count" style="color:#888;font-weight:400;font-size:11px;"></span></h3>
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="color:#666;font-size:10px;">세션</span>
            <code id="st-session-id" style="color:#81d4fa;font-size:11px;background:#0f0f23;padding:2px 8px;border-radius:4px;">...</code>
            <button onclick="pmcStocktake.newSession()" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">새 세션</button>
          </div>
        </div>
        <div id="st-session-log" style="font-size:12px;"></div>
      </div>
    `;
  }

  // ─── 검색 ───
  let searchTimer = null;
  function onSearch(q) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(q), 200);
  }
  async function doSearch(q) {
    const query = (q || '').trim();
    const host = document.getElementById('st-results');
    if (!query) { host.innerHTML = ''; return; }
    host.innerHTML = '<div style="padding:16px;color:#888;text-align:center;">검색 중…</div>';
    try {
      const r = await fetch('/api/stocktake/search?q=' + encodeURIComponent(query));
      const j = await r.json();
      const items = j.items || [];
      if (items.length === 0) {
        host.innerHTML = `<div style="padding:16px;color:#888;text-align:center;font-size:12px;">"${esc(query)}" 검색 결과 없음</div>`;
        return;
      }
      host.innerHTML = items.map(it => `
        <div onclick='pmcStocktake.selectItem(${JSON.stringify(it).replace(/'/g, "&apos;")})' style="padding:8px 10px;border-bottom:1px solid #2a2a4a;cursor:pointer;display:flex;gap:8px;align-items:center;">
          ${it.imageUrl ? `<img src="/api/img-proxy?url=${encodeURIComponent(it.imageUrl)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;background:#fff;">` : '<div style="width:40px;height:40px;background:#0f0f23;border-radius:4px;"></div>'}
          <div style="flex:1;min-width:0;">
            <div style="color:#fff;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(it.title || '(제목 없음)')}</div>
            <div style="color:#888;font-size:10px;margin-top:2px;">
              SKU <code style="color:#81d4fa;">${esc(it.sku)}</code>
              ${it.barcode ? ` · 📷 <code>${esc(it.barcode)}</code>` : ' · <span style="color:#666;">(바코드 없음)</span>'}
              · 재고 <strong style="color:#ffb74d;">${it.currentStock}개</strong>
            </div>
          </div>
        </div>
      `).join('');
    } catch (e) {
      host.innerHTML = `<div style="padding:16px;color:#ff8a80;">검색 실패: ${esc(e.message)}</div>`;
    }
  }

  async function onSearchEnter() {
    const q = document.getElementById('st-search').value.trim();
    if (!q) return;
    // USB 스캐너 지원 — 바코드 정확 일치 시 자동 선택
    try {
      const r = await fetch('/api/stocktake/item?barcode=' + encodeURIComponent(q));
      if (r.ok) {
        const j = await r.json();
        if (j.item) {
          selectItem(j.item);
          document.getElementById('st-search').value = '';
          document.getElementById('st-results').innerHTML = '';
          return;
        }
      }
    } catch {}
    // 바코드 매칭 실패 시 일반 검색으로
    doSearch(q);
  }

  // ─── 선택 ───
  function selectItem(item) {
    // scan to +1 모드: 같은 아이템이면 actualCount++
    if (scanToIncrement && selected && selected.sku === item.sku) {
      const input = document.getElementById('st-actual');
      if (input) {
        input.value = (Number(input.value) || selected.currentStock) + 1;
      }
      return;
    }
    selected = item;
    renderSelected();
  }

  function renderSelected() {
    const host = document.getElementById('st-selected');
    if (!host) return;
    if (!selected) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:#888;font-size:13px;">← 왼쪽에서 상품 검색 후 선택하세요</div>';
      return;
    }
    const initial = scanToIncrement ? selected.currentStock + 1 : selected.currentStock;
    const reasonOpts = REASONS.map(r => `<option value="${r}">${r}</option>`).join('');
    host.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        ${selected.imageUrl ? `<img src="/api/img-proxy?url=${encodeURIComponent(selected.imageUrl)}" style="width:72px;height:72px;object-fit:cover;border-radius:6px;background:#fff;">` : ''}
        <div style="flex:1;min-width:0;">
          <div style="color:#fff;font-size:13px;font-weight:600;">${esc(selected.title || '')}</div>
          <div style="color:#888;font-size:11px;margin-top:3px;">
            SKU <code style="color:#81d4fa;">${esc(selected.sku)}</code>
            ${selected.barcode ? ` · 📷 <code>${esc(selected.barcode)}</code>` : ' · <span style="color:#666;">바코드 미지정</span>'}
          </div>
          <div style="color:#ccc;font-size:12px;margin-top:4px;">
            현재 시스템 재고 <strong style="color:#ffb74d;font-size:14px;">${selected.currentStock}개</strong>
            ${selected.ebayApiStock !== selected.currentStock ? ` <span style="color:#666;font-size:10px;">· eBay API: ${selected.ebayApiStock}개</span>` : ''}
          </div>
        </div>
      </div>

      <label style="font-size:11px;color:#aaa;">실제 카운트</label>
      <div style="display:flex;gap:4px;margin-bottom:8px;">
        <button onclick="pmcStocktake.bump(-1)" style="padding:7px 12px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;">−</button>
        <input id="st-actual" type="number" min="0" value="${initial}" style="flex:1;padding:7px 10px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:15px;text-align:center;font-weight:700;">
        <button onclick="pmcStocktake.bump(1)" style="padding:7px 12px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;">+</button>
      </div>

      <div id="st-delta-preview" style="font-size:12px;color:#888;margin-bottom:8px;"></div>

      <div style="display:grid;grid-template-columns:110px 1fr;gap:6px;margin-bottom:8px;">
        <select id="st-reason" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">${reasonOpts}</select>
        <input id="st-note" type="text" placeholder="메모 (선택)" maxlength="500" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
      </div>

      <label style="display:flex;gap:6px;align-items:center;color:#ccc;font-size:11px;margin-bottom:10px;cursor:pointer;">
        <input type="checkbox" id="st-scan-inc" ${scanToIncrement ? 'checked' : ''} onchange="pmcStocktake.toggleScanInc(this.checked)">
        <span>스캔마다 +1 (연속 카운트 모드)</span>
      </label>

      <div style="display:flex;gap:6px;">
        <button onclick="pmcStocktake.save()" style="flex:1;padding:10px;background:#4caf50;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;font-size:13px;">✓ 저장</button>
        <button onclick="pmcStocktake.cancel()" style="padding:10px 16px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
      </div>
    `;
    // delta preview live update
    const input = document.getElementById('st-actual');
    input.addEventListener('input', updateDeltaPreview);
    updateDeltaPreview();
  }

  function updateDeltaPreview() {
    const input = document.getElementById('st-actual');
    const preview = document.getElementById('st-delta-preview');
    if (!input || !preview || !selected) return;
    const actual = Number(input.value) || 0;
    const delta = actual - selected.currentStock;
    const sign = delta > 0 ? '+' : '';
    const color = delta > 0 ? '#81c784' : delta < 0 ? '#ff8a80' : '#888';
    preview.innerHTML = delta === 0
      ? `<span style="color:#888;">차이 없음</span>`
      : `<span style="color:${color};font-weight:600;">${selected.currentStock} → ${actual} (${sign}${delta}개)</span>`;
  }

  function bump(delta) {
    const input = document.getElementById('st-actual');
    if (!input) return;
    const v = Math.max(0, (Number(input.value) || 0) + delta);
    input.value = v;
    updateDeltaPreview();
  }

  function cancel() {
    selected = null;
    renderSelected();
  }

  function toggleScanInc(checked) {
    scanToIncrement = checked;
  }

  // ─── 저장 ───
  async function save() {
    if (!selected) return;
    const actualCount = Number(document.getElementById('st-actual').value);
    if (!Number.isFinite(actualCount) || actualCount < 0) { alert('올바른 수량을 입력하세요'); return; }
    const reason = document.getElementById('st-reason').value;
    const note = document.getElementById('st-note').value.trim() || null;
    try {
      const r = await fetch('/api/stocktake/adjust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: selected.sku, actualCount, reason, note,
          sessionId, barcode: selected.barcode || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '저장 실패');
      // 세션 이력에 추가
      sessionLog.unshift({
        ...j.log,
        title: selected.title, sku: selected.sku,
      });
      renderSessionLog();
      // 선택된 아이템의 currentStock 업데이트 (이후 재선택 시 정확히 반영)
      selected.currentStock = j.new;
      // 저장 후 다음 검색 대비 — 선택 초기화 + 검색창 포커스
      selected = null;
      renderSelected();
      document.getElementById('st-search').value = '';
      document.getElementById('st-results').innerHTML = '';
      document.getElementById('st-search').focus();
    } catch (e) {
      alert('저장 실패: ' + e.message);
    }
  }

  function renderSessionLog() {
    const host = document.getElementById('st-session-log');
    const countEl = document.getElementById('st-session-count');
    if (!host) return;
    if (countEl) countEl.textContent = sessionLog.length > 0 ? `· ${sessionLog.length}건` : '';
    if (sessionLog.length === 0) {
      host.innerHTML = '<div style="padding:16px;color:#666;text-align:center;font-size:12px;">아직 실사 기록이 없습니다.</div>';
      return;
    }
    host.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#0f0f23;">
          <th style="padding:6px 8px;text-align:left;">시각</th>
          <th style="padding:6px 8px;text-align:left;">SKU</th>
          <th style="padding:6px 8px;text-align:left;">상품명</th>
          <th style="padding:6px 8px;text-align:right;">이전</th>
          <th style="padding:6px 8px;text-align:right;">실제</th>
          <th style="padding:6px 8px;text-align:right;">차이</th>
          <th style="padding:6px 8px;">사유</th>
        </tr></thead>
        <tbody>
          ${sessionLog.map(a => {
            const color = a.delta > 0 ? '#81c784' : a.delta < 0 ? '#ff8a80' : '#888';
            const sign = a.delta > 0 ? '+' : '';
            return `<tr style="border-bottom:1px solid #2a2a4a;">
              <td style="padding:5px 8px;color:#888;">${fmtTime(a.createdAt)}</td>
              <td style="padding:5px 8px;"><code style="color:#81d4fa;">${esc(a.sku)}</code></td>
              <td style="padding:5px 8px;color:#ccc;overflow:hidden;text-overflow:ellipsis;max-width:280px;white-space:nowrap;">${esc(a.title || '-')}</td>
              <td style="padding:5px 8px;text-align:right;color:#aaa;">${a.previousStock}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;">${a.newStock}</td>
              <td style="padding:5px 8px;text-align:right;color:${color};font-weight:700;">${sign}${a.delta}</td>
              <td style="padding:5px 8px;color:#888;font-size:11px;">${esc(a.reason || '')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function newSession() {
    if (sessionLog.length > 0 && !confirm('현재 세션을 종료하고 새 세션을 시작합니다. 계속할까요?')) return;
    startSession();
  }

  // ─── 스캐너 (html5-qrcode) ───
  function openScanner() {
    if (typeof Html5Qrcode === 'undefined') {
      alert('스캐너 라이브러리 로드 중… 잠시 후 다시 시도하세요.');
      return;
    }
    const existing = document.getElementById('st-scanner-modal');
    if (existing) existing.remove();
    const m = document.createElement('div');
    m.id = 'st-scanner-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border-radius:12px;padding:16px;max-width:480px;width:100%;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="color:#fff;font-size:15px;margin:0;">🎥 바코드 스캔</h3>
          <button onclick="pmcStocktake.closeScanner()" style="background:#2a2a4a;color:#fff;border:0;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:12px;">닫기</button>
        </div>
        <div id="st-scanner-view" style="width:100%;background:#000;border-radius:8px;overflow:hidden;"></div>
        <div id="st-scanner-msg" style="color:#888;font-size:11px;margin-top:8px;text-align:center;">카메라 권한을 허용해주세요</div>
      </div>
    `;
    document.body.appendChild(m);
    // 시작
    try {
      scannerInstance = new Html5Qrcode('st-scanner-view');
      const config = { fps: 10, qrbox: { width: 260, height: 140 } };
      scannerInstance.start(
        { facingMode: 'environment' },
        config,
        async (decodedText) => {
          // 스캔 성공
          document.getElementById('st-scanner-msg').innerHTML = `<span style="color:#81c784;">✓ 스캔됨: ${esc(decodedText)}</span>`;
          try {
            const r = await fetch('/api/stocktake/item?barcode=' + encodeURIComponent(decodedText));
            if (r.ok) {
              const j = await r.json();
              if (j.item) {
                selectItem(j.item);
                if (!scanToIncrement) closeScanner();
                else document.getElementById('st-scanner-msg').innerHTML += ' · 스캔마다 +1 모드';
                return;
              }
            }
            document.getElementById('st-scanner-msg').innerHTML = `<span style="color:#ffa726;">⚠ 바코드 "${esc(decodedText)}" — 매칭된 상품 없음. 검색창에 수동 입력 후 바코드 등록 필요</span>`;
          } catch (e) {
            document.getElementById('st-scanner-msg').innerHTML = `<span style="color:#ff8a80;">조회 실패: ${esc(e.message)}</span>`;
          }
        },
        () => { /* 프레임별 실패는 무시 (연속 시도) */ }
      ).catch(err => {
        document.getElementById('st-scanner-msg').innerHTML = `<span style="color:#ff8a80;">카메라 시작 실패: ${esc(err.message || err)}</span>`;
      });
    } catch (e) {
      document.getElementById('st-scanner-msg').innerHTML = `<span style="color:#ff8a80;">스캐너 초기화 실패: ${esc(e.message)}</span>`;
    }
  }

  async function closeScanner() {
    try {
      if (scannerInstance) {
        await scannerInstance.stop();
        scannerInstance.clear();
      }
    } catch {}
    scannerInstance = null;
    document.getElementById('st-scanner-modal')?.remove();
  }

  window.pmcStocktake = {
    load, onSearch, onSearchEnter, selectItem, bump, cancel, toggleScanInc,
    save, newSession, openScanner, closeScanner,
  };
})();
