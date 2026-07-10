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
  let suppliersCache = [];  // {id, name, channel, is_active} — 소싱처 드롭다운 소스
  // 사장님 지정 플랫폼 뱃지 (2026-07-10). marketplace 값과 매칭.
  const PLATFORMS = [
    { key: 'ebay',     label: 'eBay',    color: '#e53238' },
    { key: 'shopify',  label: 'Shopify', color: '#95bf47' },
    { key: 'naver',    label: 'Naver',   color: '#03c75a' },
    { key: 'shopee',   label: 'Shopee',  color: '#ee4d2d' },
    { key: 'qoo10',    label: 'Qoo10',   color: '#ff7f00' },
  ];

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtMoney(v) { return v == null || v === '' ? '-' : '₩' + Number(v).toLocaleString(); }
  function fmtGram(v)  { return v == null || v === '' ? '-' : Number(v).toLocaleString() + 'g'; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('ko-KR') : '-'; }

  // weight_status 뱃지 — 한 눈에 입력 필요 SKU 식별
  function weightStatusBadge(s) {
    const map = {
      measured:  { color: '#2e7d32', label: '실측' },
      estimated: { color: '#f9a825', label: '추정' },
      unknown:   { color: '#c62828', label: '미입력' },
    };
    const cfg = map[s] || map.unknown;
    return `<span style="display:inline-block;padding:1px 6px;background:${cfg.color};color:#fff;border-radius:8px;font-size:9px;font-weight:700;vertical-align:middle;">${cfg.label}</span>`;
  }
  // 치수 요약 — '10×8×3' 형태. 하나라도 비면 '-'
  function fmtDims(w, h, l) {
    if (w == null && h == null && l == null) return '';
    return `${w ?? '?'}×${h ?? '?'}×${l ?? '?'}cm`;
  }

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
            <input id="sm-weight_gram" type="number" min="0" step="1" placeholder="단품무게 (g)" title="단품 실무게. 입력 시 weight_status 가 measured 로 자동 표시" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-hs_code" placeholder="HS Code" maxlength="50" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <!-- Phase 1: 배송비 계산용 필드 — 미입력 OK, 나중에 배송추천에서 보완 가능 -->
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:8px;">
            <input id="sm-default_packaging_weight_g" type="number" min="0" step="1" placeholder="포장재 무게 (g)" title="배송그룹 기본값 대신 사용할 SKU별 포장재 무게" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-width_cm" type="number" min="0" step="0.1" placeholder="가로 (cm)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-height_cm" type="number" min="0" step="0.1" placeholder="세로 (cm)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input id="sm-length_cm" type="number" min="0" step="0.1" placeholder="높이 (cm)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="sm-shipping_group" title="배송그룹 — 그룹별 기본 포장무게·배송사 룰 적용 (Phase 3)" style="padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="">배송 그룹 (선택)</option>
              <option value="card">카드 (포켓몬·유희왕)</option>
              <option value="photocard">포토카드 (K-pop)</option>
              <option value="sticker">스티커</option>
              <option value="album">앨범</option>
              <option value="figure">피규어</option>
              <option value="toy">장난감</option>
              <option value="apparel">의류</option>
              <option value="general">일반</option>
            </select>
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
          <select id="sm-weight-filter" title="무게 데이터 신뢰도 필터" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="">무게 전체</option>
            <option value="unknown">⚠️ 무게 미입력</option>
            <option value="estimated">추정치</option>
            <option value="measured">실측</option>
          </select>
          <button id="sm-refresh" style="padding:8px 14px;background:#37474f;border:none;border-radius:6px;color:#fff;cursor:pointer;">새로고침</button>
        </div>
        <!-- 원가/무게/치수 CSV 일괄 입력 — Engine 1 BLOCK(랜딩코스트 미완성) 대량 해소용 -->
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;padding:10px;background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;">
          <span style="color:#81d4fa;font-size:13px;font-weight:600;">📥 원가·무게 CSV 일괄 입력</span>
          <a href="/api/sku-master/import/template?fill=missing" style="padding:6px 12px;background:#37474f;border-radius:6px;color:#fff;font-size:12px;text-decoration:none;" title="원가/무게/치수가 빠진 SKU 목록이 미리 채워진 템플릿">⬇ 미입력 SKU 템플릿</a>
          <a href="/api/sku-master/import/template" style="padding:6px 12px;background:#37474f;border-radius:6px;color:#fff;font-size:12px;text-decoration:none;">⬇ 빈 템플릿</a>
          <label style="padding:6px 12px;background:#1565c0;border-radius:6px;color:#fff;font-size:12px;cursor:pointer;font-weight:600;">
            ⬆ CSV 업로드<input id="sm-import-file" type="file" accept=".csv,text/csv" style="display:none;">
          </label>
          <span id="sm-import-result" style="color:#888;font-size:12px;"></span>
        </div>
        <div id="sm-list" style="overflow-x:auto;"></div>
      </div>
    `;

    document.getElementById('sm-form').addEventListener('submit', onCreate);
    document.getElementById('sm-refresh').addEventListener('click', refresh);
    document.getElementById('sm-search').addEventListener('input', debounce(refresh, 300));
    document.getElementById('sm-status-filter').addEventListener('change', refresh);
    document.getElementById('sm-auto-filter').addEventListener('change', refresh);
    document.getElementById('sm-weight-filter').addEventListener('change', refresh);
    document.getElementById('sm-import-file').addEventListener('change', onImportCsv);
  }

  // CSV 일괄 임포트 — 파일 텍스트를 그대로 POST (text/csv)
  async function onImportCsv(e) {
    const file = e.target.files && e.target.files[0];
    const out = document.getElementById('sm-import-result');
    if (!file) return;
    e.target.value = ''; // 같은 파일 재선택 허용
    out.style.color = '#888';
    out.textContent = `업로드 중... (${file.name})`;
    try {
      const text = await file.text();
      const res = await fetch('/api/sku-master/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'import failed');
      const r = json.data;
      const parts = [`✅ ${r.updated}건 갱신`];
      if (r.unchanged) parts.push(`변경없음 ${r.unchanged}`);
      if (r.not_found.length) parts.push(`❓ 미존재 SKU ${r.not_found.length} (${r.not_found.slice(0, 3).join(', ')}${r.not_found.length > 3 ? '…' : ''})`);
      if (r.invalid.length) parts.push(`⚠️ 오류 ${r.invalid.length}행 (${r.invalid.slice(0, 2).map((x) => `${x.row}행:${x.error}`).join(' / ')}${r.invalid.length > 2 ? '…' : ''})`);
      out.style.color = r.invalid.length || r.not_found.length ? '#ffcc80' : '#a5d6a7';
      out.textContent = parts.join(' · ');
      refresh();
    } catch (err) {
      out.style.color = '#ef9a9a';
      out.textContent = `❌ 실패: ${err.message}`;
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function refresh() {
    const q = document.getElementById('sm-search')?.value?.trim() || '';
    const status = document.getElementById('sm-status-filter')?.value || '';
    const auto = document.getElementById('sm-auto-filter')?.value || '';
    const weightStatus = document.getElementById('sm-weight-filter')?.value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    if (auto) params.set('automation_enabled', auto);
    if (weightStatus) params.set('weight_status', weightStatus);

    try {
      // suppliers 는 첫 로드 시 or 명시적 재조회에서만
      const promises = [fetch('/api/sku-master?' + params.toString()).then(r => r.json())];
      if (suppliersCache.length === 0) {
        promises.push(fetch('/api/suppliers?active=true').then(r => r.json()));
      }
      const [json, supJson] = await Promise.all(promises);
      if (json.error) throw new Error(json.error);
      cache = json.data || [];
      if (supJson) suppliersCache = supJson.data || [];
      renderList();
    } catch (e) {
      document.getElementById('sm-list').innerHTML =
        `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  // 플랫폼 뱃지 렌더 (등록 있음=색상, 없음=회색)
  function renderPlatformBadges(listings) {
    const has = new Set((listings || []).map(l => String(l.marketplace || '').toLowerCase()));
    return PLATFORMS.map(p => {
      const on = has.has(p.key);
      const bg = on ? p.color : '#333';
      const color = on ? '#fff' : '#666';
      const mark = on ? '✓' : '';
      return `<span style="display:inline-block;padding:2px 6px;margin-right:3px;background:${bg};color:${color};border-radius:4px;font-size:10px;font-weight:600;" title="${p.label} ${on?'등록됨':'미등록'}">${p.label}${mark}</span>`;
    }).join('');
  }

  // 소싱처 드롭다운 (suppliersCache 에서)
  function renderSupplierSelect(skuId, currentSupplierId) {
    const opts = suppliersCache.map(s =>
      `<option value="${s.id}" ${currentSupplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`
    ).join('');
    return `<select class="sm-supplier" data-id="${skuId}" style="width:110px;padding:4px;background:#0f0f23;border:1px solid #444;color:#fff;border-radius:4px;font-size:11px;">
      <option value="">— 선택 —</option>
      ${opts}
      <option value="__new__" style="color:#81c784;">+ 새 소싱처</option>
    </select>`;
  }

  function renderList() {
    const el = document.getElementById('sm-list');
    if (cache.length === 0) {
      el.innerHTML = '<div style="padding:20px;color:#888;">SKU 가 없습니다. 위의 폼에서 신규 SKU 를 등록해 보세요.</div>';
      return;
    }
    // 2026-07-10 사장님 지침: 브랜드/유형 컬럼 제거 · 원가·무게 인라인 편집
    //   · 소싱처 드롭다운 · 플랫폼 뱃지 (eBay/Shopify/Naver/Shopee/Qoo10)
    const rows = cache.map(s => `
      <tr data-id="${s.id}">
        <td style="padding:10px;font-family:monospace;color:#81d4fa;">${esc(s.internal_sku)}</td>
        <td style="padding:10px;color:#fff;">${esc(s.title)}</td>
        <td style="padding:10px;text-align:right;">
          <input type="number" class="sm-cost" data-id="${s.id}" data-orig="${s.cost_krw ?? ''}" value="${s.cost_krw ?? ''}" placeholder="원가" style="width:90px;padding:4px 6px;background:#0f0f23;border:1px solid #444;color:#fff;border-radius:4px;font-size:12px;text-align:right;">
          <div style="font-size:9px;color:#666;">KRW</div>
        </td>
        <td style="padding:10px;text-align:right;white-space:nowrap;">
          <input type="number" class="sm-weight" data-id="${s.id}" data-orig="${s.weight_gram ?? ''}" value="${s.weight_gram ?? ''}" placeholder="무게" style="width:80px;padding:4px 6px;background:#0f0f23;border:1px solid #444;color:#fff;border-radius:4px;font-size:12px;text-align:right;">
          <div style="font-size:9px;color:#666;">g ${weightStatusBadge(s.weight_status)}</div>
        </td>
        <td style="padding:10px;">${renderSupplierSelect(s.id, s.supplier_id)}</td>
        <td style="padding:10px;white-space:nowrap;">${renderPlatformBadges(s.listings)}</td>
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
            <th style="padding:10px;text-align:right;color:#aaa;font-size:12px;">원가 ✏️</th>
            <th style="padding:10px;text-align:right;color:#aaa;font-size:12px;">무게 ✏️</th>
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">소싱처</th>
            <th style="padding:10px;text-align:left;color:#aaa;font-size:12px;">등록 플랫폼</th>
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
    // 2026-07-10 인라인 편집
    el.querySelectorAll('.sm-cost').forEach(inp => inp.addEventListener('blur', onCostBlur));
    el.querySelectorAll('.sm-weight').forEach(inp => inp.addEventListener('blur', onWeightBlur));
    el.querySelectorAll('.sm-supplier').forEach(sel => sel.addEventListener('change', onSupplierChange));

    for (const id of openLinkIds) renderLinkPanel(id);
  }

  // 인라인 편집 핸들러 — 사장님/직원이 즉시 값 입력해 landing_cost BLOCK 해소.
  async function onCostBlur(e) {
    const el = e.target;
    const id = parseInt(el.dataset.id, 10);
    const orig = el.dataset.orig || '';
    const cur = el.value.trim();
    if (cur === orig) return; // 변경 없음
    await patchInline(el, id, { cost_krw: cur === '' ? null : Number(cur) });
    el.dataset.orig = cur;
  }

  async function onWeightBlur(e) {
    const el = e.target;
    const id = parseInt(el.dataset.id, 10);
    const orig = el.dataset.orig || '';
    const cur = el.value.trim();
    if (cur === orig) return;
    await patchInline(el, id, { weight_gram: cur === '' ? null : parseInt(cur, 10) });
    el.dataset.orig = cur;
  }

  async function onSupplierChange(e) {
    const el = e.target;
    const id = parseInt(el.dataset.id, 10);
    const val = el.value;
    if (val === '__new__') {
      // 새 소싱처 추가
      const name = prompt('새 소싱처 이름을 입력하세요:');
      if (!name || !name.trim()) { el.value = ''; return; }
      try {
        const res = await fetch('/api/suppliers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'create failed');
        suppliersCache.push(json.data);
        suppliersCache.sort((a, b) => a.name.localeCompare(b.name));
        // 새 소싱처로 이 SKU 도 매핑
        await patchInline(el, id, { supplier_id: json.data.id });
        renderList();
      } catch (err) {
        alert('소싱처 추가 실패: ' + err.message);
        el.value = '';
      }
      return;
    }
    const supplier_id = val === '' ? null : parseInt(val, 10);
    await patchInline(el, id, { supplier_id });
  }

  async function patchInline(el, id, body) {
    const origBg = el.style.borderColor;
    el.style.borderColor = '#ff9800';
    try {
      const res = await fetch('/api/sku-master/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'update failed');
      el.style.borderColor = '#2e7d32';
      const idx = cache.findIndex(s => s.id === id);
      if (idx >= 0) Object.assign(cache[idx], json.data);
      setTimeout(() => { el.style.borderColor = origBg || '#444'; }, 1500);
    } catch (err) {
      el.style.borderColor = '#c62828';
      alert('저장 실패: ' + err.message);
    }
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
      // Phase 1 — 배송 컬럼
      default_packaging_weight_g: document.getElementById('sm-default_packaging_weight_g').value || null,
      width_cm:  document.getElementById('sm-width_cm').value || null,
      height_cm: document.getElementById('sm-height_cm').value || null,
      length_cm: document.getElementById('sm-length_cm').value || null,
      shipping_group: document.getElementById('sm-shipping_group').value || null,
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
