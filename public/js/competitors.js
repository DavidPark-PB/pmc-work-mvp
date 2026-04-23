/**
 * 경쟁업체 관리 (Phase 7) — 수동 리스트. 플랫폼별 필터 · 위협도 배지 · last_checked.
 */
(function() {
  let user = null;
  let cached = [];
  let stats = { byPlatform: {}, byThreat: {}, total: 0 };
  let filterPlatform = '';
  let filterThreat = '';
  let searchQuery = '';
  let accioEnabled = false;

  const PLATFORMS = [
    { key: 'ebay', label: 'eBay' },
    { key: 'shopify', label: 'Shopify' },
    { key: 'naver', label: 'Naver' },
    { key: 'alibaba', label: 'Alibaba' },
    { key: 'shopee', label: 'Shopee' },
    { key: 'tcgplayer', label: 'TCGPlayer' },
    { key: 'cardmarket', label: 'Cardmarket' },
    { key: 'amazon', label: 'Amazon' },
    { key: 'other', label: '기타' },
  ];

  const THREAT_META = {
    high:   { label: '🔴 높음',   bg: '#c62828', text: '#fff' },
    medium: { label: '🟠 보통',   bg: '#f39c12', text: '#fff' },
    low:    { label: '⚪ 낮음',   bg: '#555',    text: '#fff' },
  };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    checkAccio();
    await refresh();
  }

  async function checkAccio() {
    try {
      const r = await fetch('/api/accio/health');
      const j = await r.json();
      accioEnabled = !!(j.enabled && j.healthy);
    } catch { accioEnabled = false; }
  }

  function extractAsinFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  }

  function renderShell() {
    const el = document.getElementById('page-competitors');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">🎯 경쟁업체 관리 <span style="color:#888;font-weight:400;font-size:13px;">· 수동 리스트 · 플랫폼별</span></h1>
        <p style="color:#888;font-size:13px;">경쟁 스토어 명단. 가격 추적은 따로 안 하고, 누가 어디서 뭘 파는지 · 강·약점 메모용.</p>
      </div>

      <div id="cmp-platform-tabs" style="display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap;border-bottom:1px solid #2a2a4a;padding-bottom:6px;"></div>

      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
        <input type="search" id="cmp-search" placeholder="🔍 이름·상품 포커스·메모 검색…" oninput="pmcCompetitors.onSearch(this.value)" style="flex:1;min-width:200px;padding:7px 12px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
        <select id="cmp-threat" onchange="pmcCompetitors.onThreatChange(this.value)" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <option value="">위협도 전체</option>
          <option value="high">🔴 높음만</option>
          <option value="medium">🟠 보통</option>
          <option value="low">⚪ 낮음</option>
        </select>
        <button onclick="pmcCompetitors.openAdd()" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">+ 추가</button>
      </div>

      <div id="cmp-list" style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:auto;"></div>
    `;
  }

  async function refresh() {
    try {
      const params = new URLSearchParams();
      if (filterPlatform) params.set('platform', filterPlatform);
      if (filterThreat) params.set('threatLevel', filterThreat);
      if (searchQuery) params.set('search', searchQuery);
      const [listRes, statsRes] = await Promise.all([
        fetch('/api/competitors?' + params),
        fetch('/api/competitors/stats'),
      ]);
      const listJson = await listRes.json();
      if (!listRes.ok) throw new Error(listJson.error || '로드 실패');
      cached = listJson.data || [];
      stats = await statsRes.json();
      renderTabs();
      renderList();
    } catch (e) {
      document.getElementById('cmp-list').innerHTML = `<div style="padding:30px;color:#ff8a80;text-align:center;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderTabs() {
    const host = document.getElementById('cmp-platform-tabs');
    if (!host) return;
    const total = stats.total || 0;
    const allTab = `<button onclick="pmcCompetitors.onPlatformChange('')" style="padding:7px 14px;background:${filterPlatform === '' ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:${filterPlatform === '' ? 600 : 400};">전체 <span style="opacity:0.7;">${total}</span></button>`;
    const tabs = PLATFORMS.map(p => {
      const c = stats.byPlatform?.[p.key] || 0;
      return `<button onclick="pmcCompetitors.onPlatformChange('${p.key}')" style="padding:7px 14px;background:${filterPlatform === p.key ? '#7c4dff' : '#2a2a4a'};border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:${filterPlatform === p.key ? 600 : 400};">${p.label} <span style="opacity:0.7;">${c}</span></button>`;
    }).join('');
    host.innerHTML = allTab + tabs;
  }

  function renderList() {
    const host = document.getElementById('cmp-list');
    if (!host) return;
    if (cached.length === 0) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">등록된 경쟁업체가 없습니다. 우측 상단 "+ 추가"로 시작하세요.</div>';
      return;
    }
    host.innerHTML = `
      <table style="width:100%;border-collapse:collapse;color:#fff;font-size:12px;">
        <thead>
          <tr style="background:#0f0f23;">
            <th style="padding:10px;text-align:left;">이름</th>
            <th style="padding:10px;">플랫폼</th>
            <th style="padding:10px;text-align:center;">위협도</th>
            <th style="padding:10px;text-align:left;">국가</th>
            <th style="padding:10px;text-align:left;">상품 포커스</th>
            <th style="padding:10px;text-align:left;">강점 / 약점</th>
            <th style="padding:10px;text-align:center;">스토어</th>
            <th style="padding:10px;text-align:center;">마지막 확인</th>
            <th style="padding:10px;text-align:center;">액션</th>
          </tr>
        </thead>
        <tbody>
          ${cached.map(renderRow).join('')}
        </tbody>
      </table>
    `;
  }

  function platformLabel(key) { return PLATFORMS.find(p => p.key === key)?.label || key; }

  function renderRow(c) {
    const th = THREAT_META[c.threatLevel] || THREAT_META.medium;
    const strongsAndWeak = `
      ${c.strengths ? `<div style="color:#81c784;font-size:11px;"><strong>강:</strong> ${esc(c.strengths.slice(0, 80))}${c.strengths.length > 80 ? '…' : ''}</div>` : ''}
      ${c.weaknesses ? `<div style="color:#ff8a80;font-size:11px;margin-top:2px;"><strong>약:</strong> ${esc(c.weaknesses.slice(0, 80))}${c.weaknesses.length > 80 ? '…' : ''}</div>` : ''}
    `.trim() || '<span style="color:#666;">-</span>';
    return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:10px;"><strong>${esc(c.name)}</strong></td>
        <td style="padding:10px;text-align:center;"><span style="padding:2px 8px;background:#2a2a4a;border-radius:8px;font-size:10px;">${esc(platformLabel(c.platform))}</span></td>
        <td style="padding:10px;text-align:center;"><span style="padding:2px 8px;background:${th.bg};color:${th.text};border-radius:10px;font-size:10px;font-weight:600;">${th.label}</span></td>
        <td style="padding:10px;color:#aaa;">${esc(c.country || '-')}</td>
        <td style="padding:10px;color:#ccc;">${esc(c.productFocus || '-')}</td>
        <td style="padding:10px;">${strongsAndWeak}</td>
        <td style="padding:10px;text-align:center;">${c.storeUrl ? `<a href="${esc(c.storeUrl)}" target="_blank" rel="noopener" style="color:#81d4fa;text-decoration:none;">🔗 열기</a>` : '<span style="color:#666;">-</span>'}</td>
        <td style="padding:10px;text-align:center;font-size:11px;color:#aaa;">${c.lastCheckedAt || '-'}</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">
          ${(accioEnabled && c.platform === 'amazon') ? `<button onclick="pmcCompetitors.openJs(${c.id})" title="Junglescout 리서치" style="padding:3px 8px;background:#ff9800;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">🔍 JS</button>` : ''}
          <button onclick="pmcCompetitors.touchChecked(${c.id})" title="지금 확인함" style="padding:3px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">⏱</button>
          <button onclick="pmcCompetitors.openEdit(${c.id})" title="수정" style="padding:3px 8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;margin-right:3px;">✏️</button>
          <button onclick="pmcCompetitors.del(${c.id})" title="삭제" style="padding:3px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:10px;">🗑</button>
        </td>
      </tr>
    `;
  }

  function onPlatformChange(p) { filterPlatform = p; refresh(); }
  function onThreatChange(t)   { filterThreat = t; refresh(); }
  let searchTimer = null;
  function onSearch(v) {
    searchQuery = v || '';
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(refresh, 200);
  }

  // ─── 추가/수정 모달 ───
  function openAdd() { openModal(null); }
  function openEdit(id) {
    const c = cached.find(x => x.id === id);
    if (!c) return;
    openModal(c);
  }

  function openModal(c) {
    const existing = document.getElementById('cmp-modal');
    if (existing) existing.remove();
    const isEdit = !!c;

    const platformOpts = PLATFORMS.map(p => `<option value="${p.key}" ${c && c.platform === p.key ? 'selected' : ''}>${p.label}</option>`).join('');
    const threatOpts = ['medium', 'high', 'low'].map(t => `<option value="${t}" ${c && c.threatLevel === t ? 'selected' : ''}>${THREAT_META[t].label}</option>`).join('');

    const m = document.createElement('div');
    m.id = 'cmp-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9998;display:flex;justify-content:center;align-items:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:12px;max-width:640px;width:100%;max-height:92vh;overflow:auto;padding:18px;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#fff;font-size:16px;margin:0;">🎯 ${isEdit ? '경쟁업체 수정' : '경쟁업체 추가'}</h3>
          <button onclick="pmcCompetitors.closeModal()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>

        <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">이름 *</label>
            <input type="text" id="cmp-f-name" value="${esc(c?.name || '')}" required maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">플랫폼 *</label>
            <select id="cmp-f-platform" required style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">${platformOpts}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#888;">위협도</label>
            <select id="cmp-f-threat" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;">${threatOpts}</select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#888;">국가</label>
            <input type="text" id="cmp-f-country" value="${esc(c?.country || '')}" maxlength="40" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="US, JP, DE …">
          </div>
          <div>
            <label style="font-size:11px;color:#888;">상품 포커스</label>
            <input type="text" id="cmp-f-focus" value="${esc(c?.productFocus || '')}" maxlength="200" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="Pokemon Japanese sealed">
          </div>
        </div>

        <div style="margin-bottom:8px;">
          <label style="font-size:11px;color:#888;">스토어 URL</label>
          <input type="url" id="cmp-f-url" value="${esc(c?.storeUrl || '')}" maxlength="2000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:13px;" placeholder="https://...">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#81c784;">강점</label>
            <textarea id="cmp-f-strengths" rows="3" maxlength="2000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" placeholder="배송 빠름, 가격 싸다, 상품 폭 넓음…">${esc(c?.strengths || '')}</textarea>
          </div>
          <div>
            <label style="font-size:11px;color:#ff8a80;">약점</label>
            <textarea id="cmp-f-weaknesses" rows="3" maxlength="2000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" placeholder="CS 느림, 재고 빈약, 사진 허접…">${esc(c?.weaknesses || '')}</textarea>
          </div>
        </div>

        <div style="margin-bottom:10px;">
          <label style="font-size:11px;color:#888;">메모</label>
          <textarea id="cmp-f-notes" rows="3" maxlength="4000" style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;" placeholder="기타 관찰사항, 가격대, 타깃 고객 등">${esc(c?.notes || '')}</textarea>
        </div>

        <div id="cmp-f-error" style="display:none;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;margin-bottom:8px;"></div>

        <div style="display:flex;gap:6px;justify-content:flex-end;">
          <button onclick="pmcCompetitors.closeModal()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">취소</button>
          <button id="cmp-f-save" onclick="pmcCompetitors.save(${isEdit ? c.id : 'null'})" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">${isEdit ? '저장' : '추가'}</button>
        </div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    document.getElementById('cmp-f-name').focus();
  }

  function closeModal() {
    document.getElementById('cmp-modal')?.remove();
  }

  async function save(id) {
    const err = document.getElementById('cmp-f-error');
    const btn = document.getElementById('cmp-f-save');
    err.style.display = 'none';
    const payload = {
      name: document.getElementById('cmp-f-name').value.trim(),
      platform: document.getElementById('cmp-f-platform').value,
      threatLevel: document.getElementById('cmp-f-threat').value,
      country: document.getElementById('cmp-f-country').value.trim() || null,
      productFocus: document.getElementById('cmp-f-focus').value.trim() || null,
      storeUrl: document.getElementById('cmp-f-url').value.trim() || null,
      strengths: document.getElementById('cmp-f-strengths').value.trim() || null,
      weaknesses: document.getElementById('cmp-f-weaknesses').value.trim() || null,
      notes: document.getElementById('cmp-f-notes').value.trim() || null,
    };
    if (!payload.name) { err.textContent = '이름을 입력하세요'; err.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const url = id ? `/api/competitors/${id}` : '/api/competitors';
      const method = id ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '저장 실패');
      closeModal();
      refresh();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = id ? '저장' : '추가';
    }
  }

  async function touchChecked(id) {
    try {
      const res = await fetch(`/api/competitors/${id}/checked`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || '실패');
      refresh();
    } catch (e) { alert('실패: ' + e.message); }
  }

  async function del(id) {
    if (!confirm('이 경쟁업체를 삭제합니다. 되돌릴 수 없습니다.')) return;
    try {
      const res = await fetch(`/api/competitors/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || '실패');
      refresh();
    } catch (e) { alert('삭제 실패: ' + e.message); }
  }

  // ── Junglescout Amazon 리서치 (Accio) ──
  async function openJs(id) {
    const c = cached.find(x => x.id === id);
    if (!c) return;
    let asin = extractAsinFromUrl(c.storeUrl) || '';
    if (!asin) {
      asin = prompt(`"${c.name}" 의 Amazon ASIN 을 입력하세요 (10자, 예: B00I26U9WS):`, '') || '';
      asin = asin.trim().toUpperCase();
    }
    if (!/^[A-Z0-9]{10}$/.test(asin)) { alert('ASIN 형식이 올바르지 않습니다 (10자 영숫자)'); return; }

    document.getElementById('js-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'js-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:820px;max-width:95vw;max-height:92vh;overflow:auto;color:#e0e0e0;" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="color:#fff;font-size:16px;margin:0;">🔍 Junglescout 리서치 <span style="color:#888;font-size:12px;font-weight:400;">ASIN ${esc(asin)} · ${esc(c.name)}</span></h2>
          <button onclick="pmcCompetitors.closeJs()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:20px;">✕</button>
        </div>
        <div id="js-body" style="min-height:160px;">
          <div style="padding:40px;text-align:center;color:#888;">⏳ 로딩 중 (Junglescout 호출, 10~20초)…</div>
        </div>
      </div>`;
    m.addEventListener('click', (e) => { if (e.target === m) closeJs(); });
    document.body.appendChild(m);

    try {
      const r = await fetch('/api/accio/js/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asin }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '리서치 실패');
      renderJsResult(j);
    } catch (e) {
      const body = document.getElementById('js-body');
      if (body) body.innerHTML = `<div style="padding:20px;color:#ff8a80;">❌ ${esc(e.message)}</div>`;
    }
  }

  function closeJs() { document.getElementById('js-modal')?.remove(); }

  function renderJsResult(j) {
    const body = document.getElementById('js-body');
    if (!body) return;
    const sales = j.sales;
    const keywordsRaw = j.keywords;

    // Jungle Scout sales estimates shape (best-effort extraction)
    let salesSummary = '<div style="color:#666;">판매량 데이터 없음</div>';
    if (sales && !sales.error) {
      const daily = sales.daily_sales || sales.daily || sales.data?.daily || [];
      const total = sales.total_units || sales.total || (Array.isArray(daily) ? daily.reduce((s, d) => s + (d.units || d.estimated_units || 0), 0) : 0);
      const days = Array.isArray(daily) ? daily.length : 0;
      const avg = days > 0 ? Math.round(total / days) : 0;
      salesSummary = `
        <div style="display:flex;gap:20px;">
          <div><div style="font-size:11px;color:#888;">최근 ${j.range.start} ~ ${j.range.end}</div><div style="font-size:20px;color:#81c784;font-weight:600;">${total.toLocaleString()} 개</div><div style="font-size:11px;color:#888;">총 추정 판매량</div></div>
          <div><div style="font-size:11px;color:#888;">일평균</div><div style="font-size:20px;color:#fff;font-weight:600;">${avg.toLocaleString()}</div><div style="font-size:11px;color:#888;">개/일</div></div>
        </div>`;
    } else if (sales?.error) {
      salesSummary = `<div style="color:#ff8a80;font-size:12px;">판매량 조회 실패: ${esc(sales.error)}</div>`;
    }

    // Keywords shape (best-effort extraction)
    let kwRows = '';
    let kwList = [];
    if (keywordsRaw && !keywordsRaw.error) {
      kwList = keywordsRaw.keywords || keywordsRaw.data?.keywords || keywordsRaw.data || (Array.isArray(keywordsRaw) ? keywordsRaw : []);
      if (!Array.isArray(kwList)) kwList = [];
      const top = kwList.slice(0, 15);
      kwRows = top.map(k => {
        const name = k.name || k.keyword || k.phrase || '-';
        const volume = k.monthly_search_volume || k.search_volume || k.volume || '-';
        const organic = k.organic_rank || k.rank || '-';
        const sponsored = k.sponsored_rank || k.ppc_rank || '-';
        return `<tr style="border-bottom:1px solid #2a2a4a;">
          <td style="padding:6px 8px;color:#fff;">${esc(String(name))}</td>
          <td style="padding:6px 8px;text-align:right;color:#81d4fa;">${typeof volume === 'number' ? volume.toLocaleString() : esc(String(volume))}</td>
          <td style="padding:6px 8px;text-align:center;color:#aaa;">${esc(String(organic))}</td>
          <td style="padding:6px 8px;text-align:center;color:#aaa;">${esc(String(sponsored))}</td>
        </tr>`;
      }).join('');
    }

    body.innerHTML = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:14px;margin-bottom:14px;">
        <div style="font-size:12px;color:#888;margin-bottom:8px;">판매량 추정 (Jungle Scout)</div>
        ${salesSummary}
      </div>
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;overflow:hidden;">
        <div style="padding:10px 14px;font-size:12px;color:#888;border-bottom:1px solid #2a2a4a;">키워드 (${kwList.length}개 중 상위 ${Math.min(15, kwList.length)})</div>
        ${kwList.length > 0 ? `
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="background:#1a1a2e;">
              <th style="padding:8px;text-align:left;color:#888;">키워드</th>
              <th style="padding:8px;text-align:right;color:#888;">검색량/월</th>
              <th style="padding:8px;text-align:center;color:#888;">Organic</th>
              <th style="padding:8px;text-align:center;color:#888;">Sponsored</th>
            </tr></thead>
            <tbody>${kwRows}</tbody>
          </table>` : (keywordsRaw?.error
            ? `<div style="padding:14px;color:#ff8a80;font-size:12px;">키워드 조회 실패: ${esc(keywordsRaw.error)}</div>`
            : '<div style="padding:14px;color:#666;">키워드 데이터 없음</div>')}
      </div>
      <div style="margin-top:12px;text-align:right;">
        <details style="display:inline-block;text-align:left;">
          <summary style="cursor:pointer;color:#888;font-size:11px;">원본 응답 보기</summary>
          <pre style="margin-top:6px;padding:10px;background:#0f0f23;border-radius:4px;color:#aaa;font-size:10px;max-height:240px;overflow:auto;white-space:pre-wrap;">${esc(JSON.stringify(j, null, 2))}</pre>
        </details>
      </div>`;
  }

  window.pmcCompetitors = {
    load, refresh,
    onPlatformChange, onThreatChange, onSearch,
    openAdd, openEdit, closeModal, save,
    touchChecked, del,
    openJs, closeJs,
  };
})();
