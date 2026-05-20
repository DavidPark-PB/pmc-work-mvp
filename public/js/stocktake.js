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
  // PR S-2: 신규 state
  let lastQuery = '';            // 마지막 검색어 (4 옵션 prefill 용)
  let viewMode = 'count';        // 'count' | 'approve' (승인 대기 탭, admin only)
  let pendingList = [];
  let selectedPendingIds = new Set();

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
    const approveTab = user?.isAdmin
      ? `<button id="st-tab-approve" onclick="pmcStocktake.switchView('approve')" style="padding:8px 16px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">📋 승인 대기</button>`
      : '';
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">📦 재고 실사 <span style="color:#888;font-weight:400;font-size:13px;">· 운영관리 마스터 기준 실물 카운트</span></h1>
        <p style="color:#888;font-size:13px;">검색·바코드 스캔으로 상품 찾고 실제 수량 입력 → 별도 감사 기록만 저장.</p>
        <div style="margin-top:8px;padding:10px 12px;background:#1a2a1a;border:1px solid #2d4a2d;border-radius:6px;font-size:12px;color:#a5d6a7;line-height:1.5;">
          💡 <strong>실사 카운트는 별도 감사 기록으로만 저장됩니다.</strong> 운영관리 마스터 재고는 자동으로 변경되지 않으며, ${user?.isAdmin ? '<strong>승인 대기 탭에서 일괄 승인</strong>' : '사장님이 검토 후'} 후 반영됩니다.
        </div>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid #2a2a4a;">
        <button id="st-tab-count" onclick="pmcStocktake.switchView('count')" style="padding:8px 16px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">📦 실사 카운트</button>
        ${approveTab}
      </div>

      <div id="st-view-count">

      <!-- 진행 배너 — 입력 중에도 항상 보이는 큰 카운트 -->
      <div id="st-progress-banner" style="position:sticky;top:0;z-index:10;background:linear-gradient(90deg,#0a3a2a,#0a4a3a);border:1px solid #1a6a4a;border-radius:10px;padding:14px 18px;margin-bottom:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;align-items:center;">
        <div>
          <div style="color:#a5d6a7;font-size:11px;margin-bottom:2px;">등록 건수</div>
          <div style="color:#fff;font-size:28px;font-weight:800;line-height:1;"><span id="st-prog-count">0</span><span style="color:#a5d6a7;font-size:13px;font-weight:400;margin-left:4px;">건</span></div>
        </div>
        <div>
          <div style="color:#a5d6a7;font-size:11px;margin-bottom:2px;">고유 SKU</div>
          <div style="color:#fff;font-size:20px;font-weight:700;line-height:1;"><span id="st-prog-unique">0</span></div>
        </div>
        <div>
          <div style="color:#a5d6a7;font-size:11px;margin-bottom:2px;">증감 합계</div>
          <div style="font-size:20px;font-weight:700;line-height:1;"><span id="st-prog-delta" style="color:#fff;">0</span></div>
        </div>
        <div>
          <div style="color:#a5d6a7;font-size:11px;margin-bottom:2px;">검토 필요</div>
          <div style="color:#fff;font-size:20px;font-weight:700;line-height:1;"><span id="st-prog-review" style="color:#ffb74d;">0</span></div>
        </div>
        <div style="text-align:right;">
          <div style="color:#a5d6a7;font-size:11px;margin-bottom:2px;">세션</div>
          <code id="st-prog-session" style="color:#81d4fa;font-size:11px;background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">...</code>
        </div>
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

      </div><!-- /st-view-count -->
      <div id="st-view-approve" style="display:none;"></div>
    `;
  }

  function switchView(v) {
    viewMode = v;
    const setActive = (id, on) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.color = on ? '#fff' : '#888';
      el.style.fontWeight = on ? '600' : '400';
      el.style.borderBottom = on ? '2px solid #7c4dff' : '2px solid transparent';
    };
    setActive('st-tab-count', v === 'count');
    if (user?.isAdmin) setActive('st-tab-approve', v === 'approve');
    document.getElementById('st-view-count').style.display = v === 'count' ? '' : 'none';
    document.getElementById('st-view-approve').style.display = v === 'approve' ? '' : 'none';
    if (v === 'approve') loadPending();
  }

  // ─── 검색 ───
  let searchTimer = null;
  function onSearch(q) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(q), 200);
  }
  async function doSearch(q) {
    const query = (q || '').trim();
    lastQuery = query;
    const host = document.getElementById('st-results');
    if (!query) { host.innerHTML = ''; return; }
    host.innerHTML = '<div style="padding:16px;color:#888;text-align:center;">검색 중…</div>';
    try {
      const r = await fetch('/api/stocktake/search?q=' + encodeURIComponent(query));
      const j = await r.json();
      const items = j.items || [];
      if (items.length === 0) {
        host.innerHTML = renderEmptyOptions(query);
        return;
      }
      host.innerHTML = items.map(it => {
        const aliases = Array.isArray(it.aliases) && it.aliases.length > 0 ? ` · 별칭: ${it.aliases.slice(0,3).map(esc).join(', ')}` : '';
        const masterTag = it.internalSku ? ` <span title="sku_master 매칭" style="color:#81c784;font-size:9px;">✓ master</span>` : '';
        return `
        <div onclick='pmcStocktake.selectItem(${JSON.stringify(it).replace(/'/g, "&apos;")})' style="padding:8px 10px;border-bottom:1px solid #2a2a4a;cursor:pointer;display:flex;gap:8px;align-items:center;">
          ${it.imageUrl ? `<img src="/api/img-proxy?url=${encodeURIComponent(it.imageUrl)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;background:#fff;">` : '<div style="width:40px;height:40px;background:#0f0f23;border-radius:4px;"></div>'}
          <div style="flex:1;min-width:0;">
            <div style="color:#fff;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(it.title || '(제목 없음)')}${masterTag}</div>
            <div style="color:#888;font-size:10px;margin-top:2px;">
              SKU <code style="color:#81d4fa;">${esc(it.sku)}</code>
              ${it.barcode ? ` · 📷 <code>${esc(it.barcode)}</code>` : ' · <span style="color:#666;">(바코드 없음)</span>'}
              · 재고 <strong style="color:#ffb74d;">${it.currentStock}개</strong>${aliases}
            </div>
          </div>
        </div>
      `;}).join('');
    } catch (e) {
      host.innerHTML = `<div style="padding:16px;color:#ff8a80;">검색 실패: ${esc(e.message)}</div>`;
    }
  }

  // PR S-2: 검색 실패 4 옵션 카드 (사장님 spec)
  function renderEmptyOptions(q) {
    const safe = esc(q);
    return `
      <div style="padding:16px;">
        <div style="color:#888;text-align:center;font-size:12px;margin-bottom:12px;">"${safe}" 검색 결과 없음 — 4가지 옵션:</div>
        <div style="display:grid;gap:6px;">
          <button onclick="pmcStocktake.openAddBarcodeModal('${safe.replace(/'/g, "\\'")}')"
            style="text-align:left;padding:10px 12px;background:#0f1f2a;border:1px solid #1565c0;border-radius:6px;color:#64b5f6;cursor:pointer;font-size:12px;">
            🏷️ <strong>기존 SKU 에 바코드 추가</strong><br>
            <span style="color:#888;font-size:10px;">SKU 검색해서 이 바코드 ("${safe}") 를 그 상품에 등록</span>
          </button>
          <button onclick="pmcStocktake.openTemporaryModal('${safe.replace(/'/g, "\\'")}')"
            style="text-align:left;padding:10px 12px;background:#1f1a0f;border:1px solid #ff9800;border-radius:6px;color:#ffb74d;cursor:pointer;font-size:12px;">
            ⚡ <strong>임시 실사 기록</strong><br>
            <span style="color:#888;font-size:10px;">SKU 모르는 채로 카운트만 기록 (관리자 검토 후 매칭)</span>
          </button>
          <button onclick="pmcStocktake.openReviewModal('${safe.replace(/'/g, "\\'")}')"
            style="text-align:left;padding:10px 12px;background:#1f0f0f;border:1px solid #e94560;border-radius:6px;color:#ff8a80;cursor:pointer;font-size:12px;">
            ⚠️ <strong>관리자 검토 필요로 저장</strong><br>
            <span style="color:#888;font-size:10px;">사유 명시. 관리자가 별도 처리</span>
          </button>
          <button onclick="pmcStocktake.gotoNewProduct('${safe.replace(/'/g, "\\'")}')"
            style="text-align:left;padding:10px 12px;background:#0f1f0f;border:1px solid #4caf50;border-radius:6px;color:#a5d6a7;cursor:pointer;font-size:12px;">
            ➕ <strong>신규 상품 등록으로 이동</strong><br>
            <span style="color:#888;font-size:10px;">상품 관리 페이지 (prefill 자동) 로 이동</span>
          </button>
        </div>
      </div>
    `;
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
            운영관리 마스터 재고 <strong style="color:#ffb74d;font-size:14px;">${selected.currentStock}개</strong>
            ${selected.itemId ? ` <span style="color:#666;font-size:10px;">· eBay ${esc(selected.itemId)}</span>` : ''}
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

    // 진행 배너 갱신 — cancelled 제외하고 의미 있는 항목만 카운트
    const active = sessionLog.filter(a => a.status !== 'cancelled');
    const uniqueSkus = new Set(active.map(a => a.sku).filter(Boolean)).size;
    const deltaSum = active.reduce((s, a) => s + (Number(a.delta) || 0), 0);
    const reviewCount = active.filter(a => a.status === 'review_required').length;
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('st-prog-count', active.length);
    setText('st-prog-unique', uniqueSkus);
    const deltaEl = document.getElementById('st-prog-delta');
    if (deltaEl) {
      const sign = deltaSum > 0 ? '+' : '';
      deltaEl.textContent = `${sign}${deltaSum}`;
      deltaEl.style.color = deltaSum > 0 ? '#81c784' : deltaSum < 0 ? '#ff8a80' : '#fff';
    }
    setText('st-prog-review', reviewCount);
    const sessionShort = (sessionId || '').slice(0, 16) + (sessionId && sessionId.length > 16 ? '…' : '');
    setText('st-prog-session', sessionShort || '...');

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
          ${user?.isAdmin ? '<th style="padding:6px 8px;text-align:center;">관리</th>' : ''}
        </tr></thead>
        <tbody>
          ${sessionLog.map(a => {
            const color = a.delta > 0 ? '#81c784' : a.delta < 0 ? '#ff8a80' : '#888';
            const sign = a.delta > 0 ? '+' : '';
            const statusBadge = a.status === 'review_required'
              ? '<span style="margin-left:4px;padding:1px 5px;background:#e94560;color:#fff;border-radius:6px;font-size:9px;">검토</span>'
              : a.status === 'cancelled'
              ? '<span style="margin-left:4px;padding:1px 5px;background:#555;color:#fff;border-radius:6px;font-size:9px;">취소</span>'
              : '';
            return `<tr style="border-bottom:1px solid #2a2a4a;${a.status === 'cancelled' ? 'opacity:0.4;' : ''}">
              <td style="padding:5px 8px;color:#888;">${fmtTime(a.createdAt)}</td>
              <td style="padding:5px 8px;">${a.sku ? `<code style="color:#81d4fa;">${esc(a.sku)}</code>` : '<span style="color:#888;">-</span>'}</td>
              <td style="padding:5px 8px;color:#ccc;overflow:hidden;text-overflow:ellipsis;max-width:280px;white-space:nowrap;">${esc(a.title || '-')}${statusBadge}</td>
              <td style="padding:5px 8px;text-align:right;color:#aaa;">${a.previousStock}</td>
              <td style="padding:5px 8px;text-align:right;font-weight:600;">${a.newStock}</td>
              <td style="padding:5px 8px;text-align:right;color:${color};font-weight:700;">${sign}${a.delta}</td>
              <td style="padding:5px 8px;color:#888;font-size:11px;">${esc(a.reason || '')}</td>
              ${user?.isAdmin ? `<td style="padding:5px 8px;text-align:center;"><button onclick="pmcStocktake.cancelLog(${a.id})" title="취소" style="padding:2px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;">✕</button></td>` : ''}
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

  // ── PR S-2: 검색 실패 4 옵션 모달 ──

  function _modal(html) {
    const existing = document.getElementById('st-opt-modal');
    if (existing) existing.remove();
    const m = document.createElement('div');
    m.id = 'st-opt-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:480px;max-width:95vw;color:#e0e0e0;">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    return m;
  }

  // 옵션 1) 기존 SKU 에 바코드 추가
  function openAddBarcodeModal(barcode) {
    const m = _modal(`
      <h3 style="color:#64b5f6;font-size:15px;margin:0 0 12px;">🏷️ 기존 SKU 에 바코드 추가</h3>
      <div style="font-size:12px;color:#888;margin-bottom:8px;">바코드 <code style="color:#fff;background:#0f0f23;padding:2px 6px;border-radius:3px;">${esc(barcode)}</code> 를 등록할 SKU 를 검색하세요.</div>
      <input id="st-ab-q" type="search" placeholder="SKU / 상품명 검색"
        oninput="pmcStocktake._abSearch(this.value)"
        style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;margin-bottom:8px;">
      <div id="st-ab-results" style="max-height:300px;overflow:auto;margin-bottom:10px;"></div>
      <div id="st-ab-error" style="display:none;padding:6px 10px;background:#3a1a1a;border-radius:4px;color:#ff8a80;font-size:11px;margin-bottom:8px;"></div>
      <div style="display:flex;justify-content:flex-end;">
        <button onclick="document.getElementById('st-opt-modal').remove()"
          style="padding:6px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">닫기</button>
      </div>
    `);
    m.dataset.barcode = barcode;
    setTimeout(() => m.querySelector('#st-ab-q')?.focus(), 50);
  }
  let _abTimer = null;
  function _abSearch(q) {
    if (_abTimer) clearTimeout(_abTimer);
    _abTimer = setTimeout(async () => {
      const host = document.getElementById('st-ab-results');
      if (!host) return;
      const query = (q || '').trim();
      if (!query) { host.innerHTML = ''; return; }
      try {
        const r = await fetch('/api/stocktake/search?q=' + encodeURIComponent(query));
        const j = await r.json();
        const items = (j.items || []).slice(0, 10);
        if (items.length === 0) { host.innerHTML = '<div style="padding:10px;color:#888;font-size:12px;">결과 없음</div>'; return; }
        host.innerHTML = items.map(it => `
          <div onclick="pmcStocktake._abPick(${it.productId}, '${esc(it.sku).replace(/'/g, "\\'")}')"
            style="padding:6px 10px;border-bottom:1px solid #2a2a4a;cursor:pointer;font-size:12px;color:#ccc;">
            <code style="color:#81d4fa;">${esc(it.sku)}</code> · ${esc(it.title)}
            ${it.barcode ? ` <span style="color:#ffb74d;font-size:10px;">(이미 바코드: ${esc(it.barcode)})</span>` : ''}
          </div>
        `).join('');
      } catch (e) {
        host.innerHTML = `<div style="padding:10px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
      }
    }, 200);
  }
  async function _abPick(productId, sku) {
    const m = document.getElementById('st-opt-modal');
    if (!m) return;
    const barcode = m.dataset.barcode;
    const errEl = m.querySelector('#st-ab-error');
    try {
      const r = await fetch(`/api/stocktake/products/${productId}/add-barcode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      m.remove();
      const conflictMsg = j.conflictWith ? `\n⚠️ 다른 상품 (sku=${j.conflictWith.sku}) 도 같은 바코드를 가지고 있습니다.` : '';
      alert(`✓ 바코드 ${barcode} 가 SKU ${sku} 에 등록되었습니다.${conflictMsg}`);
      // 검색창에 바코드 다시 넣고 onSearchEnter 호출 → 매칭 성공해서 자동 선택됨
      const search = document.getElementById('st-search');
      if (search) { search.value = barcode; onSearchEnter(); }
    } catch (e) {
      if (errEl) { errEl.textContent = '실패: ' + e.message; errEl.style.display = 'block'; }
    }
  }

  // 옵션 2) 임시 실사 기록
  function openTemporaryModal(input) {
    const isBarcode = /^[\dA-Z]+$/i.test(input) && input.length >= 6;
    _modal(`
      <h3 style="color:#ffb74d;font-size:15px;margin:0 0 12px;">⚡ 임시 실사 기록</h3>
      <div style="font-size:11px;color:#888;margin-bottom:10px;">SKU 미정 — 카운트만 기록. 관리자가 검토 후 SKU 매칭 처리.</div>
      <label style="font-size:11px;color:#aaa;">${isBarcode ? '바코드' : '상품명/메모'}</label>
      <input id="st-tmp-id" type="text" value="${esc(input)}" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
      <label style="font-size:11px;color:#aaa;">실제 카운트 *</label>
      <input id="st-tmp-count" type="number" min="0" value="1" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
      <label style="font-size:11px;color:#aaa;">메모 (선택)</label>
      <input id="st-tmp-note" type="text" maxlength="500" placeholder="박스 위치 등" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:10px;">
      <div id="st-tmp-error" style="display:none;padding:6px 10px;background:#3a1a1a;border-radius:4px;color:#ff8a80;font-size:11px;margin-bottom:8px;"></div>
      <div style="display:flex;justify-content:flex-end;gap:6px;">
        <button onclick="document.getElementById('st-opt-modal').remove()" style="padding:6px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">취소</button>
        <button onclick="pmcStocktake._tmpSave(${isBarcode})" style="padding:6px 16px;background:#ff9800;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">⚡ 저장</button>
      </div>
    `);
    setTimeout(() => document.getElementById('st-tmp-count')?.focus(), 50);
  }
  async function _tmpSave(isBarcode) {
    const m = document.getElementById('st-opt-modal');
    if (!m) return;
    const idVal = document.getElementById('st-tmp-id').value.trim();
    const count = Number(document.getElementById('st-tmp-count').value);
    const note = document.getElementById('st-tmp-note').value.trim();
    const errEl = m.querySelector('#st-tmp-error');
    if (!Number.isFinite(count) || count < 0) { errEl.textContent = '카운트는 0 이상'; errEl.style.display = 'block'; return; }
    try {
      const body = isBarcode
        ? { barcode: idVal, actualCount: count, note, sessionId }
        : { title: idVal, actualCount: count, note, sessionId };
      const r = await fetch('/api/stocktake/temporary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      m.remove();
      sessionLog.unshift({ ...j.log, title: j.log.title || idVal });
      renderSessionLog();
      const search = document.getElementById('st-search');
      if (search) { search.value = ''; document.getElementById('st-results').innerHTML = ''; search.focus(); }
    } catch (e) {
      if (errEl) { errEl.textContent = '실패: ' + e.message; errEl.style.display = 'block'; }
    }
  }

  // 옵션 3) 검토 필요
  function openReviewModal(input) {
    _modal(`
      <h3 style="color:#ff8a80;font-size:15px;margin:0 0 12px;">⚠️ 관리자 검토 필요</h3>
      <div style="font-size:11px;color:#888;margin-bottom:10px;">관리자가 별도 처리. note 는 필수.</div>
      <label style="font-size:11px;color:#aaa;">바코드 또는 키워드</label>
      <input id="st-rv-id" type="text" value="${esc(input)}" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
      <label style="font-size:11px;color:#aaa;">실제 카운트 (선택)</label>
      <input id="st-rv-count" type="number" min="0" placeholder="없으면 0" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
      <label style="font-size:11px;color:#aaa;">검토 사유 *</label>
      <textarea id="st-rv-note" rows="3" maxlength="500" placeholder="예: 새 입고인데 마스터에 SKU 없음 / 다른 상품과 헷갈림 등"
        style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;font-family:inherit;resize:vertical;margin-bottom:10px;"></textarea>
      <div id="st-rv-error" style="display:none;padding:6px 10px;background:#3a1a1a;border-radius:4px;color:#ff8a80;font-size:11px;margin-bottom:8px;"></div>
      <div style="display:flex;justify-content:flex-end;gap:6px;">
        <button onclick="document.getElementById('st-opt-modal').remove()" style="padding:6px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">취소</button>
        <button onclick="pmcStocktake._rvSave()" style="padding:6px 16px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">⚠️ 저장</button>
      </div>
    `);
    setTimeout(() => document.getElementById('st-rv-note')?.focus(), 50);
  }
  async function _rvSave() {
    const m = document.getElementById('st-opt-modal');
    if (!m) return;
    const idVal = document.getElementById('st-rv-id').value.trim();
    const countRaw = document.getElementById('st-rv-count').value;
    const note = document.getElementById('st-rv-note').value.trim();
    const errEl = m.querySelector('#st-rv-error');
    if (!note) { errEl.textContent = '검토 사유 필수'; errEl.style.display = 'block'; return; }
    try {
      const r = await fetch('/api/stocktake/review-required', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: idVal, actualCount: countRaw, note, sessionId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      m.remove();
      sessionLog.unshift({ ...j.log, title: '⚠️ 검토 필요: ' + idVal });
      renderSessionLog();
      const search = document.getElementById('st-search');
      if (search) { search.value = ''; document.getElementById('st-results').innerHTML = ''; search.focus(); }
    } catch (e) {
      if (errEl) { errEl.textContent = '실패: ' + e.message; errEl.style.display = 'block'; }
    }
  }

  // 옵션 4) 신규 상품 등록 redirect
  async function gotoNewProduct(input) {
    const isBarcode = /^[\dA-Z]+$/i.test(input) && input.length >= 6;
    const params = new URLSearchParams();
    if (isBarcode) params.set('barcode', input);
    else params.set('keyword', input);
    try {
      const r = await fetch('/api/stocktake/new-product-redirect?' + params);
      const j = await r.json();
      if (j.redirectUrl) { location.href = j.redirectUrl; return; }
    } catch {}
    alert('상품 관리 페이지로 이동해 신규 상품을 등록하세요.');
  }

  // 즉시 취소 (세션 이력 행) — admin 만
  async function cancelLog(id) {
    if (!user?.isAdmin) { alert('관리자만 취소 가능'); return; }
    if (!confirm('이 실사 기록을 취소하시겠습니까? (status=cancelled)')) return;
    try {
      const r = await fetch(`/api/stocktake/${id}/cancel`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      sessionLog = sessionLog.filter(l => l.id !== id);
      renderSessionLog();
    } catch (e) { alert('실패: ' + e.message); }
  }

  // ── PR S-2: 승인 대기 화면 (admin only) ──
  async function loadPending() {
    const host = document.getElementById('st-view-approve');
    if (!host) return;
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <label style="color:#aaa;font-size:12px;">상태</label>
          <select id="st-pend-status" onchange="pmcStocktake.loadPending()" style="padding:6px 10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
            <option value="pending">pending (승인 대기)</option>
            <option value="review_required">review_required (검토 필요)</option>
            <option value="cancelled">cancelled (취소됨)</option>
          </select>
          <button onclick="pmcStocktake.loadPending()" style="padding:6px 12px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🔄 새로고침</button>
          <span id="st-pend-msg" style="color:#888;font-size:11px;margin-left:auto;"></span>
        </div>
      </div>
      <div id="st-pend-list">로딩 중...</div>
    `;
    await _refreshPending();
  }

  async function _refreshPending() {
    const status = document.getElementById('st-pend-status')?.value || 'pending';
    const list = document.getElementById('st-pend-list');
    const msg = document.getElementById('st-pend-msg');
    try {
      const r = await fetch('/api/stocktake/pending?status=' + status);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      pendingList = j.data || [];
      selectedPendingIds.clear();
      _renderPendingTable(status);
      if (msg) msg.textContent = `${pendingList.length}건`;
    } catch (e) {
      list.innerHTML = `<div style="padding:20px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
    }
  }

  function _renderPendingTable(status) {
    const list = document.getElementById('st-pend-list');
    if (!list) return;
    if (pendingList.length === 0) {
      list.innerHTML = '<div style="padding:30px;color:#666;text-align:center;font-size:12px;">대기 건 없음</div>';
      return;
    }
    const canBatch = status === 'pending';
    list.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:hidden;">
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;">
          <div style="color:#fff;font-size:13px;">선택: <strong id="st-pend-count">0</strong> / ${pendingList.length}</div>
          <div style="display:flex;gap:6px;">
            <button onclick="pmcStocktake._togglePendAll(true)" style="padding:5px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">전체 선택</button>
            <button onclick="pmcStocktake._togglePendAll(false)" style="padding:5px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">선택 해제</button>
            ${canBatch ? `<button id="st-apply-btn" onclick="pmcStocktake.applyPending()" disabled style="padding:5px 14px;background:#555;border:0;border-radius:4px;color:#fff;cursor:not-allowed;font-size:11px;font-weight:600;">✓ 일괄 승인 (0)</button>` : ''}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="background:#0f0f23;">
            ${canBatch ? '<th style="padding:6px;width:30px;"></th>' : ''}
            <th style="padding:6px 8px;text-align:left;">시각</th>
            <th style="padding:6px 8px;text-align:left;">SKU</th>
            <th style="padding:6px 8px;text-align:left;">상품명</th>
            <th style="padding:6px 8px;text-align:right;">이전</th>
            <th style="padding:6px 8px;text-align:right;">실제</th>
            <th style="padding:6px 8px;text-align:right;">차이</th>
            <th style="padding:6px 8px;">사유/메모</th>
            <th style="padding:6px 8px;text-align:center;">관리</th>
          </tr></thead>
          <tbody>
            ${pendingList.map(a => {
              const color = a.delta > 0 ? '#81c784' : a.delta < 0 ? '#ff8a80' : '#888';
              const sign = a.delta > 0 ? '+' : '';
              const noSku = !a.sku;
              return `<tr style="border-bottom:1px solid #2a2a4a;${noSku ? 'background:#2a1a0f;' : ''}">
                ${canBatch ? `<td style="padding:5px 8px;text-align:center;"><input type="checkbox" data-id="${a.id}" ${noSku ? 'disabled title="sku NULL — 일괄 승인 불가"' : ''} onchange="pmcStocktake._togglePend(${a.id}, this.checked)"></td>` : ''}
                <td style="padding:5px 8px;color:#888;">${fmtTime(a.createdAt)}</td>
                <td style="padding:5px 8px;">${a.sku ? `<code style="color:#81d4fa;">${esc(a.sku)}</code>` : '<span style="color:#888;">(NULL)</span>'}</td>
                <td style="padding:5px 8px;color:#ccc;overflow:hidden;text-overflow:ellipsis;max-width:240px;white-space:nowrap;">${esc(a.title || '-')}</td>
                <td style="padding:5px 8px;text-align:right;color:#aaa;">${a.previousStock}</td>
                <td style="padding:5px 8px;text-align:right;font-weight:600;">${a.newStock}</td>
                <td style="padding:5px 8px;text-align:right;color:${color};font-weight:700;">${sign}${a.delta}</td>
                <td style="padding:5px 8px;color:#888;font-size:11px;">${esc(a.reason || '')}${a.note ? ' · ' + esc(a.note.slice(0, 40)) : ''}</td>
                <td style="padding:5px 8px;text-align:center;">
                  <button onclick="pmcStocktake._cancelPend(${a.id})" style="padding:3px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;">취소</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function _togglePend(id, checked) {
    if (checked) selectedPendingIds.add(id);
    else selectedPendingIds.delete(id);
    _updateApplyBtn();
  }
  function _togglePendAll(on) {
    pendingList.forEach(a => {
      if (a.sku) {
        if (on) selectedPendingIds.add(a.id);
        else selectedPendingIds.delete(a.id);
      }
    });
    document.querySelectorAll('#st-pend-list input[type="checkbox"][data-id]').forEach(cb => {
      if (!cb.disabled) cb.checked = on;
    });
    _updateApplyBtn();
  }
  function _updateApplyBtn() {
    const btn = document.getElementById('st-apply-btn');
    const cnt = document.getElementById('st-pend-count');
    if (cnt) cnt.textContent = String(selectedPendingIds.size);
    if (!btn) return;
    if (selectedPendingIds.size > 0) {
      btn.disabled = false;
      btn.style.background = '#4caf50';
      btn.style.cursor = 'pointer';
      btn.textContent = `✓ 일괄 승인 (${selectedPendingIds.size})`;
    } else {
      btn.disabled = true;
      btn.style.background = '#555';
      btn.style.cursor = 'not-allowed';
      btn.textContent = '✓ 일괄 승인 (0)';
    }
  }

  async function applyPending() {
    if (selectedPendingIds.size === 0) return;
    if (!confirm(`${selectedPendingIds.size}건을 승인합니다. 운영 재고 (products.stock) 가 즉시 변경됩니다. 계속할까요?`)) return;
    try {
      const r = await fetch('/api/stocktake/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedPendingIds) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      const failMsg = j.skipped > 0
        ? `\n\n실패 ${j.skipped}건:\n` + j.results.filter(r => !r.ok).map(r => `  • id=${r.id}: ${r.error}`).join('\n')
        : '';
      alert(`✓ ${j.applied}건 승인 완료${failMsg}`);
      await _refreshPending();
    } catch (e) {
      alert('승인 실패: ' + e.message);
    }
  }

  async function _cancelPend(id) {
    if (!confirm('이 row 를 cancelled 로 변경하시겠습니까?')) return;
    try {
      const r = await fetch(`/api/stocktake/${id}/cancel`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error || '실패');
      await _refreshPending();
    } catch (e) { alert('실패: ' + e.message); }
  }

  window.pmcStocktake = {
    load, onSearch, onSearchEnter, selectItem, bump, cancel, toggleScanInc,
    save, newSession, openScanner, closeScanner,
    // PR S-2 신규
    switchView,
    openAddBarcodeModal, openTemporaryModal, openReviewModal, gotoNewProduct,
    cancelLog,
    loadPending, applyPending,
    _abSearch, _abPick, _tmpSave, _rvSave,
    _togglePend, _togglePendAll, _cancelPend,
  };
})();
