/**
 * SKU 마스터 관리 — WMS Phase 1
 *
 * admin 전용. 운영 메뉴의 "SKU 마스터" 진입점.
 *
 * 동작:
 *   - 목록 + 검색 + status/automation 필터
 *   - 신규 SKU 생성 (인라인 폼)
 *   - status 변경, automation_enabled 토글, 비활성화(soft delete)
 *   - listing link 추가/삭제 (펼친 행 안에서)
 *
 * 정책:
 *   - 모든 호출은 /api/sku-master/* (server.js 에서 requireAdmin 보호)
 *   - 가격/배송/라벨 등 외부 실행은 절대 호출하지 않는다.
 */
(function () {
  let user = null;
  let cache = [];
  let openLinkIds = new Set();

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtMoney(v) { return v == null || v === '' ? '-' : '₩' + Number(v).toLocaleString(); }
  function fmtGram(v)  { return v == null || v === '' ? '-' : Number(v).toLocaleString() + 'g'; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('ko-KR') : '-'; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    const el = document.getElementById('page-sku-master');
    if (!user || !user.isAdmin) {
      el.innerHTML = '<div style="padding:40px;color:#888;">관리자 전용 페이지입니다.</div>';
      return;
    }
    renderShell(el);
    await refresh();
  }

  function renderShell(el) {
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">📦 SKU 마스터</h1>
        <p style="color:#888;font-size:13px;">WMS 내부 SKU 의 단일 기준. 자동화 ON/OFF 게이트와 마켓 listing 연결을 관리.</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <h3 style="color:#fff;margin:0 0 12px;">➕ 신규 SKU</h3>
        <form id="sm-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:8px;">
            <input id="sm-internal_sku" placeholder="internal_sku (필수, 변경 불가)" required maxlength="100" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-title" placeholder="제목 (필수)" required maxlength="255" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-brand" placeholder="브랜드" maxlength="100" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-category" placeholder="카테고리" maxlength="100" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:8px;">
            <input id="sm-product_type" placeholder="유형 (예: tcg-box)" maxlength="50" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-cost_krw" type="number" min="0" step="100" placeholder="원가 (KRW)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-weight_gram" type="number" min="0" step="10" placeholder="무게 (g)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-hs_code" placeholder="HS Code" maxlength="50" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <button type="submit" style="padding:9px 18px;background:#1565c0;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">생성</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
          <input id="sm-search" placeholder="internal_sku / 제목 검색" style="flex:1;min-width:200px;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          <select id="sm-status-filter" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="">전체 상태</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="discontinued">discontinued</option>
          </select>
          <select id="sm-auto-filter" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="">자동화 전체</option>
            <option value="true">자동화 ON</option>
            <option value="false">자동화 OFF</option>
          </select>
          <button id="sm-refresh" style="padding:8px 14px;background:#37474f;border:none;border-radius:6px;color:#fff;cursor:pointer;">새로고침</button>
        </div>
        <div id="sm-list" style="overflow-x:auto;"></div>
      </div>
    `;

    document.getElementById('sm-form').addEventListener('submit', onCreate);
    document.getElementById('sm-refresh').addEventListener('click', refresh);
    document.getElementById('sm-search').addEventListener('input', debounce(refresh, 300));
    document.getElementById('sm-status-filter').addEventListener('change', refresh);
    document.getElementById('sm-auto-filter').addEventListener('change', refresh);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function refresh() {
    const q = document.getElementById('sm-search')?.value?.trim() || '';
    const status = document.getElementById('sm-status-filter')?.value || '';
    const auto = document.getElementById('sm-auto-filter')?.value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (auto) params.set('automation_enabled', auto);

    try {
      const res = await fetch('/api/sku-master?' + params.toString());
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'load failed');
      cache = json.data || [];
      renderList();
    } catch (e) {
      document.getElementById('sm-list').innerHTML =
        `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderList() {
    const el = document.getElementById('sm-list');
    if (cache.length === 0) {
      el.innerHTML = '<div style="padding:20px;color:#888;">SKU 가 없습니다. 위의 폼에서 신규 SKU 를 등록해 보세요.</div>';
      return;
    }
    const rows = cache.map(s => `
      <tr data-id="${s.id}">
        <td style="padding:10px;font-family:monospace;color:#81d4fa;">${esc(s.internal_sku)}</td>
        <td style="padding:10px;color:#fff;">${esc(s.title)}</td>
        <td style="padding:10px;color:#aaa;">${esc(s.brand || '-')}</td>
        <td style="padding:10px;color:#aaa;">${esc(s.product_type || '-')}</td>
        <td style="padding:10px;text-align:right;color:#fff;">${fmtMoney(s.cost_krw)}</td>
        <td style="padding:10px;text-align:right;color:#aaa;">${fmtGram(s.weight_gram)}</td>
        <td style="padding:10px;">
          <select class="sm-status" data-id="${s.id}" style="padding:4px;background:#0f0f23;border:1px solid #444;color:#fff;border-radius:4px;font-size:12px;">
            <option value="active" ${s.status==='active'?'selected':''}>active</option>
            <option value="paused" ${s.status==='paused'?'selected':''}>paused</option>
            <option value="discontinued" ${s.status==='discontinued'?'selected':''}>discontinued</option>
          </select>
        </td>
        <td style="padding:10px;text-align:center;">
          <label style="cursor:pointer;color:${s.automation_enabled?'#69f0ae':'#666'};">
            <input type="checkbox" class="sm-auto" data-id="${s.id}" ${s.automation_enabled?'checked':''} style="margin-right:4px;"> ${s.automation_enabled?'ON':'OFF'}
          </label>
        </td>
        <td style="padding:10px;color:#666;font-size:11px;">${fmtDate(s.updated_at)}</td>
        <td style="padding:10px;text-align:right;white-space:nowrap;">
          <button class="sm-links" data-id="${s.id}" style="padding:4px 8px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;margin-right:4px;">🔗 링크</button>
          <button class="sm-delete" data-id="${s.id}" style="padding:4px 8px;background:#4a1a1a;border:none;border-radius:4px;color:#ef9a9a;cursor:pointer;font-size:12px;" title="비활성화 (status=discontinued)">🗑</button>
        </td>
      </tr>
      <tr id="sm-link-row-${s.id}" style="display:${openLinkIds.has(s.id)?'table-row':'none'};">
        <td colspan="10" style="padding:0;background:#0f0f23;">
          <div id="sm-link-panel-${s.id}" style="padding:12px 16px;border-top:1px solid #333;"></div>
        </td>
      </tr>
    `).join('');

    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:#0f0f23;border-bottom:2px solid #2a2a4a;">
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">internal_sku</th>
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">제목</th>
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">브랜드</th>
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">유형</th>
            <th style="padding:10px;text-align:right;color:#aaa;font-size:12px;">원가</th>
            <th style="padding:10px;text-align:right;color:#aaa;font-size:12px;">무게</th>
            <th style="padding:10px;color:#aaa;font-size:12px;">상태</th>
            <th style="padding:10px;color:#aaa;font-size:12px;">자동화</th>
            <th style="padding:10px;color:#aaa;font-size:12px;">갱신</th>
            <th style="padding:10px;text-align:right;color:#aaa;font-size:12px;">액션</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    el.querySelectorAll('.sm-status').forEach(s => s.addEventListener('change', onStatusChange));
    el.querySelectorAll('.sm-auto').forEach(c => c.addEventListener('change', onAutoToggle));
    el.querySelectorAll('.sm-delete').forEach(b => b.addEventListener('click', onSoftDelete));
    el.querySelectorAll('.sm-links').forEach(b => b.addEventListener('click', onToggleLinks));

    for (const id of openLinkIds) renderLinkPanel(id);
  }

  async function onCreate(e) {
    e.preventDefault();
    const body = {
      internal_sku: document.getElementById('sm-internal_sku').value.trim(),
      title:        document.getElementById('sm-title').value.trim(),
      brand:        document.getElementById('sm-brand').value.trim() || null,
      category:     document.getElementById('sm-category').value.trim() || null,
      product_type: document.getElementById('sm-product_type').value.trim() || null,
      cost_krw:     document.getElementById('sm-cost_krw').value || null,
      weight_gram:  document.getElementById('sm-weight_gram').value || null,
      hs_code:      document.getElementById('sm-hs_code').value.trim() || null,
    };
    try {
      const res = await fetch('/api/sku-master', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'create failed');
      e.target.reset();
      await refresh();
    } catch (err) { alert('생성 실패: ' + err.message); }
  }

  async function onStatusChange(e) {
    const id = parseInt(e.target.dataset.id, 10);
    const status = e.target.value;
    await patchSku(id, { status });
  }

  async function onAutoToggle(e) {
    const id = parseInt(e.target.dataset.id, 10);
    const automation_enabled = e.target.checked;
    await patchSku(id, { automation_enabled });
  }

  async function patchSku(id, body) {
    try {
      const res = await fetch('/api/sku-master/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'update failed');
      // 캐시 부분 갱신
      const idx = cache.findIndex(s => s.id === id);
      if (idx >= 0) cache[idx] = json.data;
      renderList();
    } catch (err) { alert('업데이트 실패: ' + err.message); refresh(); }
  }

  async function onSoftDelete(e) {
    const id = parseInt(e.target.dataset.id, 10);
    const sku = cache.find(s => s.id === id);
    if (!confirm(`${sku?.internal_sku} 을(를) 비활성화 합니다 (status=discontinued).\n진행하시겠습니까?`)) return;
    try {
      const res = await fetch('/api/sku-master/' + id, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'delete failed');
      await refresh();
    } catch (err) { alert('비활성화 실패: ' + err.message); }
  }

  async function onToggleLinks(e) {
    const id = parseInt(e.target.dataset.id, 10);
    const row = document.getElementById('sm-link-row-' + id);
    if (openLinkIds.has(id)) {
      openLinkIds.delete(id);
      if (row) row.style.display = 'none';
    } else {
      openLinkIds.add(id);
      if (row) row.style.display = 'table-row';
      await renderLinkPanel(id);
    }
  }

  async function renderLinkPanel(skuId) {
    const panel = document.getElementById('sm-link-panel-' + skuId);
    if (!panel) return;
    panel.innerHTML = '<div style="color:#888;">로딩 중...</div>';
    try {
      const res = await fetch('/api/sku-master/' + skuId);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'load failed');
      const links = json.data?.links || [];

      const linksHtml = links.length === 0
        ? '<div style="color:#888;font-size:12px;padding:8px 0;">연결된 마켓 listing 이 없습니다.</div>'
        : `<table style="width:100%;border-collapse:collapse;font-size:12px;">
             <thead><tr style="color:#aaa;">
               <th style="padding:6px;text-align:left;">marketplace</th>
               <th style="padding:6px;text-align:left;">listing_id</th>
               <th style="padding:6px;text-align:left;">option_id</th>
               <th style="padding:6px;text-align:left;">marketplace_sku</th>
               <th style="padding:6px;">primary</th>
               <th style="padding:6px;"></th>
             </tr></thead>
             <tbody>${links.map(l => `
               <tr style="border-top:1px solid #2a2a4a;">
                 <td style="padding:6px;color:#81d4fa;font-family:monospace;">${esc(l.marketplace)}</td>
                 <td style="padding:6px;color:#fff;font-family:monospace;">${esc(l.listing_id)}</td>
                 <td style="padding:6px;color:#aaa;font-family:monospace;">${esc(l.option_id || '-')}</td>
                 <td style="padding:6px;color:#aaa;font-family:monospace;">${esc(l.marketplace_sku || '-')}</td>
                 <td style="padding:6px;text-align:center;">${l.is_primary ? '⭐' : ''}</td>
                 <td style="padding:6px;text-align:right;">
                   <button class="sm-link-del" data-sku="${skuId}" data-link="${l.id}" style="padding:3px 8px;background:#4a1a1a;border:none;border-radius:3px;color:#ef9a9a;cursor:pointer;font-size:11px;">삭제</button>
                 </td>
               </tr>
             `).join('')}</tbody>
           </table>`;

      panel.innerHTML = `
        <div style="margin-bottom:10px;">
          <span style="color:#aaa;font-size:12px;font-weight:600;">🔗 마켓 listing 연결</span>
        </div>
        ${linksHtml}
        <form class="sm-link-form" data-sku="${skuId}" style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
          <select class="sm-l-marketplace" required style="padding:6px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;">
            <option value="">marketplace</option>
            <option value="ebay">ebay</option>
            <option value="shopify">shopify</option>
            <option value="naver">naver</option>
            <option value="shopee">shopee</option>
            <option value="alibaba">alibaba</option>
            <option value="coupang">coupang</option>
            <option value="qoo10">qoo10</option>
          </select>
          <input class="sm-l-listing" placeholder="listing_id" required maxlength="200" style="padding:6px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;flex:1;min-width:140px;">
          <input class="sm-l-option" placeholder="option_id (선택)" maxlength="200" style="padding:6px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;flex:1;min-width:120px;">
          <input class="sm-l-msku" placeholder="marketplace_sku (선택)" maxlength="200" style="padding:6px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;flex:1;min-width:120px;">
          <label style="display:flex;align-items:center;gap:4px;color:#aaa;font-size:12px;"><input type="checkbox" class="sm-l-primary"> primary</label>
          <button type="submit" style="padding:6px 14px;background:#1565c0;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">+ 추가</button>
        </form>
      `;

      panel.querySelectorAll('.sm-link-del').forEach(b => b.addEventListener('click', onDeleteLink));
      panel.querySelector('.sm-link-form').addEventListener('submit', onAddLink);
    } catch (err) {
      panel.innerHTML = `<div style="color:#ef9a9a;">로드 실패: ${esc(err.message)}</div>`;
    }
  }

  async function onAddLink(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const skuId = parseInt(form.dataset.sku, 10);
    const body = {
      marketplace:     form.querySelector('.sm-l-marketplace').value,
      listing_id:      form.querySelector('.sm-l-listing').value.trim(),
      option_id:       form.querySelector('.sm-l-option').value.trim() || null,
      marketplace_sku: form.querySelector('.sm-l-msku').value.trim() || null,
      is_primary:      form.querySelector('.sm-l-primary').checked,
    };
    try {
      const res = await fetch('/api/sku-master/' + skuId + '/links', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'add link failed');
      await renderLinkPanel(skuId);
    } catch (err) { alert('링크 추가 실패: ' + err.message); }
  }

  async function onDeleteLink(e) {
    const skuId = parseInt(e.target.dataset.sku, 10);
    const linkId = parseInt(e.target.dataset.link, 10);
    if (!confirm('이 listing 연결을 삭제하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/sku-master/${skuId}/links/${linkId}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'delete link failed');
      await renderLinkPanel(skuId);
    } catch (err) { alert('링크 삭제 실패: ' + err.message); }
  }

  window.pmcSkuMaster = { load };
})();
