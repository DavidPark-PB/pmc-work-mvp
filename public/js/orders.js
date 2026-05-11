/**
 * 발주 관리 (Phase 2) — /api/purchase-requests
 */
(function() {
  let user = null;
  let refreshTimer = null;
  let cachedOrders = [];
  const REJECT_LABELS = { out_of_stock: '품절', discontinued: '단종', budget: '예산 부족', price_review: '가격 검토 필요', other: '기타' };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(n) { if (n == null || n === '') return '-'; return Number(n).toLocaleString('ko-KR') + '원'; }
  function dt(iso) { if (!iso) return ''; const d = new Date(iso); const pad = n => String(n).padStart(2,'0'); return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    renderShell();
    await refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.getElementById('page-orders').classList.contains('active')) refresh();
    }, 30000);
  }

  function renderShell() {
    const el = document.getElementById('page-orders');
    const statsBar = user.isAdmin ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;">
        <div style="background:#1a1a2e;border-left:3px solid #e94560;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">긴급 대기</div>
          <div id="po-urgent" style="font-size:24px;font-weight:700;color:#ff8a80;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #ffa726;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">대기중</div>
          <div id="po-pending" style="font-size:24px;font-weight:700;color:#ffb74d;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #4caf50;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">승인됨</div>
          <div id="po-approved" style="font-size:24px;font-weight:700;color:#81c784;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #1565c0;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">주문완료</div>
          <div id="po-ordered" style="font-size:24px;font-weight:700;color:#64b5f6;">-</div>
        </div>
        <div style="background:#1a1a2e;border-left:3px solid #555;padding:16px;border-radius:12px;">
          <div style="font-size:12px;color:#888;">반려됨</div>
          <div id="po-rejected" style="font-size:24px;font-weight:700;color:#aaa;">-</div>
        </div>
      </div>` : '';

    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">🛒 발주 관리</h1>
        <p style="color:#888;font-size:13px;">${user.isAdmin ? '발주 요청 승인/반려 관리' : '상품 발주 요청 및 처리 현황'}</p>
      </div>
      ${statsBar}

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;margin-bottom:16px;">
        <h3 style="color:#fff;margin-bottom:12px;">➕ 발주 요청</h3>
        <form id="po-form" autocomplete="off">
          <!-- 상품명 -->
          <div style="position:relative;margin-bottom:10px;">
            <input type="text" id="po-product" placeholder="상품명 (필수)" required maxlength="500"
              style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <!-- SKU autocomplete (선택) -->
          <div style="position:relative;margin-bottom:10px;">
            <input type="text" id="po-sku" placeholder="SKU 코드 또는 상품명 일부 (선택 — 마스터에 없어도 입력 가능)"
              maxlength="100" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            <div id="po-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:10;background:#0f0f23;border:1px solid #2a2a4a;border-top:0;border-radius:0 0 6px 6px;max-height:240px;overflow-y:auto;"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:10px;">
            <input type="number" id="po-qty" placeholder="수량 (필수)" min="1" required style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="po-unit" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="개">개</option>
              <option value="박스">박스</option>
              <option value="세트">세트</option>
            </select>
            <input type="number" id="po-stock" placeholder="현재 재고 (선택)" min="0" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <input type="number" id="po-price" placeholder="예상 금액 (원)" min="0" step="100" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <select id="po-priority" style="padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="normal">일반</option>
              <option value="urgent">🚨 긴급</option>
            </select>
          </div>
          <textarea id="po-reason" placeholder="사유 (필수 — 재고 부족, 신상 입고 등)" rows="2" maxlength="2000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>
          <textarea id="po-memo" placeholder="메모 (선택 — 참고 URL, 보조 메모)" rows="2" maxlength="2000" style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;"></textarea>

          <!-- 중복 발주 경고 (실시간) -->
          <div id="po-dup-warn" style="display:none;margin-bottom:10px;padding:10px 12px;background:#3a2a1a;border-left:3px solid #ff9800;border-radius:6px;color:#ffb74d;font-size:12px;"></div>

          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
            <label style="padding:7px 12px;background:#2a2a4a;border-radius:6px;color:#aaa;cursor:pointer;font-size:12px;">
              📷 참고 이미지 (최대 5장)
              <input type="file" id="po-images" multiple accept="image/*" style="display:none;" onchange="pmcOrders.previewNewImages()">
            </label>
            <span id="po-images-count" style="color:#888;font-size:11px;"></span>
          </div>
          <div id="po-images-preview" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;"></div>
          <button type="submit" style="padding:10px 20px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">요청</button>
        </form>
      </div>

      <!-- 📊 재고 추천 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;margin-bottom:16px;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <h3 style="color:#fff;">📊 발주 이력 기반 재고 추천 <span style="color:#888;font-size:11px;font-weight:400;">· 최근 90일</span></h3>
          <button onclick="pmcOrders.toggleInsights()" id="po-insights-toggle" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">▼ 펼치기</button>
        </div>
        <div id="po-insights" style="display:none;"></div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <h3 style="color:#fff;">📋 발주 내역 <span style="color:#888;font-size:11px;font-weight:400;">· 전 직원 공유</span></h3>
          <div style="display:flex;gap:6px;">
            <select id="po-scope" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="">전 직원</option>
              <option value="mine">내 요청만</option>
            </select>
            <select id="po-filter" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="active" selected>🔄 진행 중 (기본)</option>
              <option value="pending">대기중</option>
              <option value="approved">승인됨</option>
              <option value="completed">✅ 주문완료</option>
              <option value="rejected">🚫 반려</option>
              <option value="">🗃 전체</option>
            </select>
          </div>
        </div>
        <div id="po-list"></div>
      </div>
    `;

    document.getElementById('po-form').addEventListener('submit', submitOrder);
    document.getElementById('po-filter').addEventListener('change', refresh);
    document.getElementById('po-scope').addEventListener('change', refresh);

    // PR P-1A-F: SKU autocomplete + 중복 발주 경고 (실시간)
    setupSkuAutocomplete('po-sku', 'po-product', 'po-sku-suggest');
    setupDuplicateWarning({
      productInputId: 'po-product',
      skuInputId:     'po-sku',
      warnElId:       'po-dup-warn',
      excludeId:      undefined, // 신규 폼은 본인 row 없음
    });
  }

  // ── debounce ──
  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ── SKU autocomplete ──
  // sku_master 미존재 / 0건 매칭 → "일치 SKU 없음" 안내 + 그래도 직접 입력 허용 (사장님 짚은점 2)
  function setupSkuAutocomplete(skuInputId, productInputId, suggestId) {
    const skuInput = document.getElementById(skuInputId);
    const productInput = document.getElementById(productInputId);
    const suggest = document.getElementById(suggestId);
    if (!skuInput || !suggest) return;

    const fetchAndRender = debounce(async (q) => {
      if (!q || q.trim().length < 1) { suggest.style.display = 'none'; return; }
      try {
        const res = await fetch('/api/sku-master/search?q=' + encodeURIComponent(q));
        if (!res.ok) { suggest.style.display = 'none'; return; }
        const { data } = await res.json();
        if (!data || data.length === 0) {
          suggest.innerHTML = '<div style="padding:10px 12px;color:#888;font-size:12px;">일치하는 SKU 없음 — 그래도 직접 입력 가능 (마스터 미연결로 저장됨)</div>';
          suggest.style.display = 'block';
          return;
        }
        suggest.innerHTML = data.map(r => {
          const boostBadge = r.recent_purchase_count > 0
            ? `<span style="margin-left:6px;padding:1px 6px;background:#1a3a2e;color:#81c784;border-radius:8px;font-size:10px;">최근 ${r.recent_purchase_count}회</span>`
            : '';
          return `
            <div data-sku="${esc(r.internal_sku)}" data-title="${esc(r.title)}" class="po-sku-opt"
                 style="padding:8px 12px;border-bottom:1px solid #1a1a2e;cursor:pointer;font-size:12px;"
                 onmouseover="this.style.background='#1a1a2e'" onmouseout="this.style.background='transparent'">
              <div style="color:#fff;font-weight:600;">${esc(r.internal_sku)}${boostBadge}</div>
              <div style="color:#aaa;font-size:11px;">${esc(r.title)}${r.brand ? ' · ' + esc(r.brand) : ''}</div>
            </div>
          `;
        }).join('');
        suggest.style.display = 'block';
      } catch {
        suggest.style.display = 'none';
      }
    }, 250);

    // SKU 직접 입력 시 검색
    skuInput.addEventListener('input', () => fetchAndRender(skuInput.value));
    // 상품명 입력 시에도 SKU 후보 fetch (단, SKU 칸이 비어있을 때만 — 사용자가 SKU 직접 입력했으면 방해 X)
    if (productInput) {
      productInput.addEventListener('input', () => {
        if (!skuInput.value.trim()) fetchAndRender(productInput.value);
      });
    }
    // 항목 클릭 → SKU 칸 채움 + 상품명 비어있으면 같이 채움
    suggest.addEventListener('click', (e) => {
      const opt = e.target.closest('.po-sku-opt');
      if (!opt) return;
      skuInput.value = opt.dataset.sku || '';
      if (productInput && !productInput.value.trim()) productInput.value = opt.dataset.title || '';
      suggest.style.display = 'none';
      // 중복 검사 즉시 트리거
      productInput?.dispatchEvent(new Event('input'));
      skuInput.dispatchEvent(new Event('input'));
    });
    // 외부 클릭 시 닫기
    document.addEventListener('click', (e) => {
      if (e.target !== skuInput && !suggest.contains(e.target)) suggest.style.display = 'none';
    });
  }

  // ── 중복 발주 경고 ──
  // soft-deleted 발주는 결과에 절대 미포함 (server-side dupDetector 가 deleted_at IS NULL 필터)
  function setupDuplicateWarning({ productInputId, skuInputId, warnElId, excludeId } = {}) {
    const product = document.getElementById(productInputId);
    const sku = document.getElementById(skuInputId);
    const warn = document.getElementById(warnElId);
    if (!warn) return;

    const check = debounce(async () => {
      const productName = product?.value?.trim() || '';
      const skuVal = sku?.value?.trim() || '';
      if (productName.length < 2 && !skuVal) { warn.style.display = 'none'; return; }
      try {
        const params = new URLSearchParams();
        if (productName) params.set('productName', productName);
        if (skuVal) params.set('sku', skuVal);
        if (Number.isFinite(excludeId)) params.set('excludeId', String(excludeId));
        params.set('days', '7');
        const res = await fetch('/api/purchase-requests/duplicate-check?' + params);
        if (!res.ok) { warn.style.display = 'none'; return; }
        const { data, windowDays } = await res.json();
        if (!data || data.length === 0) { warn.style.display = 'none'; return; }
        warn.innerHTML = `
          <div style="font-weight:600;margin-bottom:6px;">⚠ 최근 ${windowDays}일 이내 비슷한 발주 ${data.length}건</div>
          ${data.slice(0, 5).map(d => `
            <div style="padding:4px 0;color:#ccc;font-size:11px;">
              · <strong>${esc(d.product_name)}</strong>
              ${d.sku ? `<span style="color:#888;"> [${esc(d.sku)}]</span>` : ''}
              <span style="color:#888;"> × ${d.quantity} ·</span>
              <span style="color:${statusFg(d.status)};">${statusLabel(d.status)}</span>
              <span style="color:#888;"> · ${esc(d.requester?.display_name || '-')} · ${dt(d.requested_at)}</span>
            </div>
          `).join('')}
        `;
        warn.style.display = 'block';
      } catch {
        warn.style.display = 'none';
      }
    }, 500);

    product?.addEventListener('input', check);
    sku?.addEventListener('input', check);
  }

  // 빈 값 일관 표시 (em dash) — 사장님 짚은점 5
  function emptyOrDash(v) { return (v == null || v === '' || (Array.isArray(v) && v.length === 0)) ? '—' : v; }
  function statusLabel(s) {
    return ({ pending:'대기', reviewed:'검토중', approved:'승인', ordered:'주문완료', arrived:'도착완료', rejected:'반려' })[s] || s;
  }
  function statusFg(s) {
    return ({ pending:'#ffb74d', reviewed:'#b39ddb', approved:'#81c784', ordered:'#64b5f6', arrived:'#80cbc4', rejected:'#aaa' })[s] || '#aaa';
  }
  function statusBg(s) {
    return ({ pending:'#ffa726', reviewed:'#7c4dff', approved:'#4caf50', ordered:'#1565c0', arrived:'#26a69a', rejected:'#555' })[s] || '#555';
  }

  async function refresh() {
    const filterVal = document.getElementById('po-filter')?.value;
    const scope = document.getElementById('po-scope')?.value;
    const params = new URLSearchParams();
    // active/completed/rejected = statusGroup (서버 IN 쿼리) / pending·approved = 기존 status 그대로
    if (filterVal === 'active' || filterVal === 'completed' || filterVal === 'rejected') {
      params.set('statusGroup', filterVal);
    } else if (filterVal) {
      params.set('status', filterVal);
    }
    if (scope) params.set('scope', scope);
    const res = await fetch('/api/purchase-requests?' + params);
    const { data } = await res.json();
    renderList(data || []);
    if (user.isAdmin) {
      const s = await fetch('/api/purchase-requests/stats').then(r => r.json());
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('po-urgent', s.pendingUrgent);
      set('po-pending', s.pending);
      set('po-approved', s.approved);
      set('po-ordered', s.ordered ?? 0);
      set('po-rejected', s.rejected);
    }
    // insights 패널 열려 있으면 갱신
    const insightsPanel = document.getElementById('po-insights');
    if (insightsPanel && insightsPanel.style.display !== 'none') loadInsights();
  }

  async function toggleInsights() {
    const panel = document.getElementById('po-insights');
    const btn = document.getElementById('po-insights-toggle');
    if (panel.style.display === 'none') {
      panel.style.display = 'block';
      btn.textContent = '▲ 접기';
      await loadInsights();
    } else {
      panel.style.display = 'none';
      btn.textContent = '▼ 펼치기';
    }
  }

  async function loadInsights() {
    const panel = document.getElementById('po-insights');
    panel.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">분석 중…</div>';
    try {
      const { products } = await fetch('/api/purchase-requests/insights').then(r => r.json());
      if (!products || products.length === 0) {
        panel.innerHTML = '<div style="padding:30px;text-align:center;color:#888;">최근 90일 발주 이력이 부족합니다. 발주가 쌓이면 자동으로 추천이 표시됩니다.</div>';
        return;
      }
      panel.innerHTML = `
        <table style="width:100%;border-collapse:collapse;color:#fff;font-size:12px;">
          <thead>
            <tr style="background:#0f0f23;">
              <th style="padding:8px;text-align:left;">상품명</th>
              <th style="padding:8px;text-align:center;">요청 횟수</th>
              <th style="padding:8px;text-align:center;">총 수량</th>
              <th style="padding:8px;text-align:center;">평균 수량</th>
              <th style="padding:8px;text-align:center;">평균 간격</th>
              <th style="padding:8px;text-align:center;">최근 요청</th>
              <th style="padding:8px;text-align:center;">평균 단가</th>
              <th style="padding:8px;text-align:right;background:#1a2a3a;">🎯 권장 재고</th>
            </tr>
          </thead>
          <tbody>
            ${products.slice(0, 30).map(p => `
              <tr style="border-bottom:1px solid #2a2a4a;">
                <td style="padding:8px;"><strong>${esc(p.name)}</strong></td>
                <td style="padding:8px;text-align:center;">${p.requestCount}회 ${p.urgentCount > 0 ? `<span style="color:#e94560;">(🚨${p.urgentCount})</span>` : ''}</td>
                <td style="padding:8px;text-align:center;">${p.totalQty}</td>
                <td style="padding:8px;text-align:center;">${p.avgQty}</td>
                <td style="padding:8px;text-align:center;">${p.avgIntervalDays != null ? p.avgIntervalDays + '일' : '-'}</td>
                <td style="padding:8px;text-align:center;color:#aaa;">${dt(p.lastRequestedAt)}</td>
                <td style="padding:8px;text-align:center;">${p.avgPrice != null ? money(p.avgPrice) : '-'}</td>
                <td style="padding:8px;text-align:right;background:#1a2a3a;color:#81d4fa;font-weight:700;font-size:14px;">${p.suggestedStock}개</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="padding:10px 16px;color:#888;font-size:11px;border-top:1px solid #2a2a4a;">
          권장 재고 = 최근 60일 월평균 수량 × 1.5 (안전재고 버퍼). 최소 3개.
        </div>
      `;
    } catch (e) {
      panel.innerHTML = '<div style="padding:20px;color:#ff8a80;">분석 실패: ' + (e.message || '') + '</div>';
    }
  }

  function renderList(items) {
    const c = document.getElementById('po-list');
    if (items.length === 0) { c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">발주 요청이 없습니다.</div>'; return; }
    cachedOrders = items;
    c.innerHTML = items.map(o => renderOrderRow(o)).join('');
  }

  // PR P-1A-F: 카드 = 요약 7개 + 상세 펼침
  // 요약 7개: 상품명 / 상태 / 우선순위 / 수량+단위 / 현재재고 / 예상품절일(빈) / 추천소싱처1개(빈)
  // 상세 펼침: SKU / 요청자 / 사유 / 판매량(빈) / 추천수량(빈) / 마진율(빈) / 메모 / 첨부 / status별 메시지 / 액션
  // 빈 값은 em dash 일관 표시 (사장님 짚은점 5)
  function renderOrderRow(o) {
    const urgent = o.priority === 'urgent' ? '<span style="color:#e94560;font-weight:700;margin-right:6px;">🚨 긴급</span>' : '';
    const urgentBar = o.priority === 'urgent' ? 'border-left:3px solid #e94560;' : '';
    const status = o.status || 'pending';
    const stBadge = `<span style="padding:2px 8px;background:${statusBg(status)};color:#fff;border-radius:10px;font-size:11px;">${statusLabel(status)}</span>`;
    const skuMissing = !o.sku;
    const skuBadge = skuMissing
      ? '<span style="margin-left:6px;padding:1px 6px;background:#3a3a3a;color:#ccc;border-radius:8px;font-size:10px;" title="sku_master 미연결">SKU 미연결</span>'
      : '';

    // 요약 칩 7개
    const unit = o.unit || '개';
    const summaryChips = [
      { label: '수량', value: `${o.quantity} ${unit}` },
      { label: '현재 재고', value: o.current_stock != null ? `${o.current_stock}` : '—' },
      { label: '예상 품절일', value: '—' },           // 1-A 미구현 (2단계)
      { label: '추천 소싱처', value: '—' },           // 1-A 미구현 (1-C)
    ];

    return `
      <div style="border-bottom:1px solid #2a2a4a;${urgentBar}">
        <div style="padding:14px 16px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:240px;">
            <div style="font-weight:600;font-size:15px;color:#fff;margin-bottom:6px;">
              ${urgent}${esc(o.product_name)}${skuBadge} ${stBadge}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;">
              ${summaryChips.map(c => `
                <span style="padding:2px 8px;background:#0f0f23;border:1px solid #2a2a4a;border-radius:10px;color:#bbb;">
                  <span style="color:#888;">${c.label}:</span> <strong style="color:#fff;">${esc(c.value)}</strong>
                </span>
              `).join('')}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
            <button onclick="pmcOrders.toggleDetail(${o.id})" id="po-detail-toggle-${o.id}"
              style="padding:4px 10px;background:transparent;border:1px solid #2a4a6a;border-radius:4px;color:#81d4fa;cursor:pointer;font-size:11px;">▼ 상세</button>
            ${renderActionButtons(o)}
          </div>
        </div>
        <div id="po-detail-${o.id}" style="display:none;padding:0 16px 14px 16px;background:#0d0d1f;">
          ${renderOrderDetail(o)}
        </div>
        <div id="po-images-${o.id}" style="display:none;padding:0 16px 14px;"></div>
      </div>
    `;
  }

  function renderActionButtons(o) {
    const canUnorder = o.status === 'ordered' && (user.isAdmin || o.ordered_by === user.id);
    // PR P-1A-F: 모든 직원이 발주 삭제 가능 (sec spec — soft delete). 단, status pending 만 (요청자) / admin 은 모든 status.
    const canEdit = user.isAdmin || (o.requested_by === user.id && o.status === 'pending');
    const canDelete = user.isAdmin || o.requested_by === user.id;
    const buttons = [];
    if (canEdit) {
      buttons.push(`<button onclick="pmcOrders.openEdit(${o.id})" style="padding:4px 10px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️ 수정</button>`);
    }
    if (o.status === 'approved') {
      buttons.push(`<button onclick="pmcOrders.markOrdered(${o.id})" style="padding:6px 12px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">📦 주문완료</button>`);
    }
    if (canUnorder) {
      buttons.push(`<button onclick="pmcOrders.unorder(${o.id})" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#aaa;cursor:pointer;font-size:11px;">↶ 되돌리기</button>`);
    }
    if (user.isAdmin && o.status === 'pending') {
      buttons.push(`<button onclick="pmcOrders.approve(${o.id})" style="padding:6px 12px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">✓ 승인</button>`);
      buttons.push(`<button onclick="pmcOrders.openReject(${o.id})" style="padding:6px 12px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">✗ 반려</button>`);
    }
    if (canDelete) {
      buttons.push(`<button onclick="pmcOrders.del(${o.id})" title="삭제 (이력은 보존)" style="padding:4px 10px;background:#2a2a4a;border:0;border-radius:4px;color:#aaa;cursor:pointer;font-size:11px;">🗑</button>`);
    }
    return `<div style="display:flex;flex-direction:column;gap:6px;">${buttons.join('')}</div>`;
  }

  function renderOrderDetail(o) {
    const attCount = o.attachment_count || 0;
    const attBtn = attCount > 0
      ? `<button onclick="pmcOrders.toggleImages(${o.id})" style="padding:3px 10px;background:#2a4a6a;border:0;border-radius:10px;color:#fff;cursor:pointer;font-size:11px;">📷 ${attCount}장 보기</button>`
      : '<span style="color:#888;font-size:11px;">— 첨부 없음</span>';

    // 1-A 시점에 미구현인 항목은 모두 — (em dash). 구현 단계 라벨링 위해 (2~4단계) 주석.
    const detailRows = [
      ['SKU',           o.sku ? esc(o.sku) : '<span style="color:#888;">— (미연결)</span>'],
      ['요청자',         esc(o.requester?.display_name || '—') + (o.requester?.platform ? ` · ${esc(o.requester.platform)}` : '')],
      ['요청일',         dt(o.requested_at)],
      ['예상 금액',      money(o.estimated_price)],
      ['최근 7일 판매',  '<span style="color:#666;">— (2단계)</span>'],
      ['최근 30일 판매', '<span style="color:#666;">— (2단계)</span>'],
      ['일평균 판매',    '<span style="color:#666;">— (2단계)</span>'],
      ['진행중 발주',    '<span style="color:#666;">— (2단계)</span>'],
      ['추천 발주 수량', '<span style="color:#666;">— (2단계)</span>'],
      ['예상 판매가',    '<span style="color:#666;">— (3단계)</span>'],
      ['예상 마진율',    '<span style="color:#666;">— (3단계)</span>'],
      ['추천 소싱처',    '<span style="color:#666;">— (1-C)</span>'],
    ];

    const statusMsg = o.status === 'rejected'
      ? `<div style="margin-top:8px;padding:6px 10px;background:#2a1a1a;border-radius:6px;font-size:12px;"><strong style="color:#ff8a80;">반려:</strong> ${REJECT_LABELS[o.rejection_reason] || o.rejection_reason || '-'}${o.rejection_note ? ' — ' + esc(o.rejection_note) : ''}</div>`
      : o.status === 'approved'
      ? `<div style="margin-top:6px;font-size:12px;color:#81c784;">✓ ${dt(o.decision_at)} 승인</div>`
      : o.status === 'ordered'
      ? `<div style="margin-top:6px;font-size:12px;color:#64b5f6;">📦 ${dt(o.ordered_at)} · ${esc(o.orderer?.display_name || '-')} 주문</div>`
      : '';

    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px 16px;font-size:12px;">
        ${detailRows.map(([k, v]) => `
          <div style="padding:4px 0;border-bottom:1px solid #1a1a2e;">
            <span style="color:#888;">${esc(k)}:</span>
            <span style="color:#fff;margin-left:6px;">${v}</span>
          </div>
        `).join('')}
      </div>
      ${o.reason ? `<div style="margin-top:10px;padding:8px 10px;background:#1a1a2e;border-radius:6px;font-size:12px;color:#ccc;white-space:pre-wrap;"><strong style="color:#aaa;">사유:</strong> ${esc(o.reason)}</div>` : ''}
      ${o.memo ? `<div style="margin-top:6px;padding:8px 10px;background:#1a1a2e;border-radius:6px;font-size:12px;color:#ccc;white-space:pre-wrap;"><strong style="color:#aaa;">메모:</strong> ${esc(o.memo)}</div>` : ''}
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
        <span style="color:#888;font-size:11px;">📷 첨부:</span> ${attBtn}
      </div>
      ${statusMsg}
    `;
  }

  function toggleDetail(id) {
    const el = document.getElementById('po-detail-' + id);
    const btn = document.getElementById('po-detail-toggle-' + id);
    if (!el) return;
    if (el.style.display === 'none' || !el.style.display) {
      el.style.display = 'block';
      if (btn) btn.textContent = '▲ 접기';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▼ 상세';
    }
  }

  async function submitOrder(e) {
    e.preventDefault();
    const productName = document.getElementById('po-product').value.trim();
    const reason = document.getElementById('po-reason').value.trim();
    if (!productName) { alert('상품명을 입력하세요'); return; }
    if (!reason) { alert('사유를 입력하세요 (필수)'); return; }
    const payload = {
      productName,
      quantity: document.getElementById('po-qty').value,
      unit: document.getElementById('po-unit').value || '개',
      sku: document.getElementById('po-sku').value.trim() || undefined,
      currentStock: document.getElementById('po-stock').value || undefined,
      estimatedPrice: document.getElementById('po-price').value || undefined,
      priority: document.getElementById('po-priority').value,
      reason,
      memo: document.getElementById('po-memo').value.trim() || undefined,
    };
    const res = await fetch('/api/purchase-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    const { data: created } = await res.json();

    // 이미지가 선택되었다면 업로드 (실패해도 발주 자체는 생성된 상태)
    const fileInput = document.getElementById('po-images');
    const files = fileInput?.files;
    if (files && files.length > 0 && created?.id) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      try {
        const upRes = await fetch(`/api/purchase-requests/${created.id}/attachments`, {
          method: 'POST', body: fd,
        });
        if (!upRes.ok) {
          const err = await upRes.json().catch(() => ({}));
          alert('발주는 저장되었지만 이미지 업로드 실패: ' + (err.error || upRes.statusText) + '\n수정 화면에서 다시 시도할 수 있습니다.');
        }
      } catch (e) {
        alert('발주는 저장되었지만 이미지 업로드 실패: ' + e.message);
      }
    }

    document.getElementById('po-form').reset();
    document.getElementById('po-images-preview').innerHTML = '';
    document.getElementById('po-images-count').textContent = '';
    document.getElementById('po-dup-warn').style.display = 'none';
    document.getElementById('po-sku-suggest').style.display = 'none';
    refresh();
  }

  function previewNewImages() {
    const input = document.getElementById('po-images');
    const files = Array.from(input?.files || []);
    const host = document.getElementById('po-images-preview');
    const count = document.getElementById('po-images-count');

    if (files.length > 5) {
      alert('이미지는 최대 5장까지 선택 가능합니다. 앞 5장만 사용됩니다.');
    }
    const picked = files.slice(0, 5);
    count.textContent = picked.length > 0 ? `${picked.length}장 선택됨` : '';
    host.innerHTML = picked.map((f, i) => {
      const url = URL.createObjectURL(f);
      return `<img src="${url}" alt="preview ${i+1}" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #333;">`;
    }).join('');
  }

  async function toggleImages(id) {
    const host = document.getElementById(`po-images-${id}`);
    if (!host) return;
    if (host.style.display !== 'none') {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    host.innerHTML = '<div style="color:#888;font-size:11px;">로딩…</div>';
    try {
      const { data } = await fetch(`/api/purchase-requests/${id}/attachments`).then(r => r.json());
      if (!data || data.length === 0) {
        host.innerHTML = '<div style="color:#666;font-size:11px;">첨부 이미지 없음</div>';
        return;
      }
      // 각 이미지마다 서명 URL 요청 → 썸네일 표시
      const urls = await Promise.all(data.map(att =>
        fetch(`/api/purchase-requests/${id}/attachments/${att.id}/url`).then(r => r.json()).then(j => ({ ...att, signedUrl: j.signedUrl }))
      ));
      host.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;">${urls.map(a => `
        <a href="${a.signedUrl}" target="_blank" rel="noopener" title="${esc(a.fileName)}">
          <img src="${a.signedUrl}" loading="lazy" alt="${esc(a.fileName)}" style="width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid #333;cursor:zoom-in;">
        </a>
      `).join('')}</div>`;
    } catch (e) {
      host.innerHTML = `<div style="color:#ff8a80;font-size:11px;">이미지 로드 실패: ${esc(e.message)}</div>`;
    }
  }

  async function approve(id) {
    if (!confirm('이 발주를 승인하시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/approve`, { method: 'PATCH' });
    if (!res.ok) { alert('승인 실패'); return; }
    refresh();
  }

  function openReject(id) {
    const reason = prompt('반려 사유를 선택하세요:\n1. 품절\n2. 단종\n3. 예산 부족\n4. 가격 검토 필요\n5. 기타\n\n번호 입력:');
    const map = { '1': 'out_of_stock', '2': 'discontinued', '3': 'budget', '4': 'price_review', '5': 'other' };
    const reasonKey = map[reason];
    if (!reasonKey) return;
    const note = prompt('메모 (선택):') || '';
    submitReject(id, reasonKey, note);
  }

  async function submitReject(id, reason, note) {
    const res = await fetch(`/api/purchase-requests/${id}/reject`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, note }),
    });
    if (!res.ok) { alert((await res.json()).error || '반려 실패'); return; }
    refresh();
  }

  async function del(id) {
    // PR P-1A-F: hard → soft delete. 화면에선 사라지지만 신뢰도/이력 분석에는 보존됨.
    if (!confirm('이 발주 내역을 삭제하시겠습니까?\n(목록에서 숨김 처리됩니다. 이력은 보존됩니다.)')) return;
    const res = await fetch(`/api/purchase-requests/${id}`, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    refresh();
  }

  async function markOrdered(id) {
    if (!confirm('이 항목을 주문완료 처리하시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/order`, { method: 'PATCH' });
    if (!res.ok) { alert((await res.json()).error || '처리 실패'); return; }
    refresh();
  }

  async function unorder(id) {
    if (!confirm('주문완료 체크를 되돌리시겠습니까?')) return;
    const res = await fetch(`/api/purchase-requests/${id}/unorder`, { method: 'PATCH' });
    if (!res.ok) { alert((await res.json()).error || '되돌리기 실패'); return; }
    refresh();
  }

  // ── 요청 내용 수정 ──
  function openEdit(id) {
    const o = cachedOrders.find(x => x.id === id);
    if (!o) return;
    const existing = document.getElementById('po-edit-modal');
    if (existing) existing.remove();

    const urgentOpt = o.priority === 'urgent' ? 'selected' : '';
    const normalOpt = o.priority !== 'urgent' ? 'selected' : '';

    const m = document.createElement('div');
    m.id = 'po-edit-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:520px;max-width:95vw;max-height:92vh;overflow-y:auto;color:#e0e0e0;">
        <h3 style="color:#fff;font-size:15px;margin:0 0 14px;">✏️ 발주 요청 수정</h3>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">상품명</label>
        <input id="po-edit-product" type="text" maxlength="500" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;margin-bottom:10px;font-size:13px;">
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">SKU (선택)</label>
        <div style="position:relative;margin-bottom:10px;">
          <input id="po-edit-sku" type="text" maxlength="100" placeholder="마스터에 없어도 입력 가능"
            style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          <div id="po-edit-sku-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:10;background:#0f0f23;border:1px solid #2a2a4a;border-top:0;border-radius:0 0 6px 6px;max-height:240px;overflow-y:auto;"></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px;">
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">수량</label>
            <input id="po-edit-qty" type="number" min="1" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">단위</label>
            <select id="po-edit-unit" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
              <option value="개">개</option>
              <option value="박스">박스</option>
              <option value="세트">세트</option>
            </select>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">현재 재고</label>
            <input id="po-edit-stock" type="number" min="0" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">예상 금액 (원)</label>
            <input id="po-edit-price" type="number" min="0" step="100" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">우선순위</label>
            <select id="po-edit-priority" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
              <option value="normal" ${normalOpt}>일반</option>
              <option value="urgent" ${urgentOpt}>🚨 긴급</option>
            </select>
          </div>
        </div>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">사유</label>
        <textarea id="po-edit-reason" rows="3" maxlength="2000" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;resize:vertical;font-family:inherit;margin-bottom:10px;"></textarea>
        <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">메모</label>
        <textarea id="po-edit-memo" rows="2" maxlength="2000" style="width:100%;padding:9px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;resize:vertical;font-family:inherit;"></textarea>
        <!-- 중복 발주 경고 (excludeId = 본인 row 제외) -->
        <div id="po-edit-dup-warn" style="display:none;margin-top:10px;padding:10px 12px;background:#3a2a1a;border-left:3px solid #ff9800;border-radius:6px;color:#ffb74d;font-size:12px;"></div>

        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a4a;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <label style="font-size:12px;color:#aaa;">📷 참고 이미지</label>
            <label style="padding:5px 10px;background:#2a2a4a;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">
              + 이미지 추가
              <input type="file" id="po-edit-add-images" multiple accept="image/*" style="display:none;" onchange="pmcOrders.uploadMoreImages(${id})">
            </label>
          </div>
          <div id="po-edit-images" style="display:flex;gap:6px;flex-wrap:wrap;"><div style="color:#666;font-size:11px;">로딩…</div></div>
        </div>

        <div id="po-edit-error" style="display:none;margin-top:10px;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;"></div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px;">
          <button onclick="pmcOrders.closeEdit()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          <button id="po-edit-save" onclick="pmcOrders.saveEdit(${id})" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById('po-edit-product').value = o.product_name || '';
    document.getElementById('po-edit-sku').value = o.sku || '';
    document.getElementById('po-edit-unit').value = o.unit || '개';
    document.getElementById('po-edit-stock').value = o.current_stock != null ? o.current_stock : '';
    document.getElementById('po-edit-qty').value = o.quantity || 1;
    document.getElementById('po-edit-price').value = o.estimated_price || '';
    document.getElementById('po-edit-reason').value = o.reason || '';
    document.getElementById('po-edit-memo').value = o.memo || '';
    document.getElementById('po-edit-product').focus();
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    loadEditImages(id);
    // PR P-1A-F: 모달 안에서도 autocomplete + 중복 검사 활성. 본인 row 제외 (excludeId=id).
    setupSkuAutocomplete('po-edit-sku', 'po-edit-product', 'po-edit-sku-suggest');
    setupDuplicateWarning({
      productInputId: 'po-edit-product',
      skuInputId:     'po-edit-sku',
      warnElId:       'po-edit-dup-warn',
      excludeId:      id,
    });
  }

  async function loadEditImages(id) {
    const host = document.getElementById('po-edit-images');
    if (!host) return;
    try {
      const { data } = await fetch(`/api/purchase-requests/${id}/attachments`).then(r => r.json());
      if (!data || data.length === 0) {
        host.innerHTML = '<div style="color:#666;font-size:11px;">첨부된 이미지 없음 (최대 5장)</div>';
        return;
      }
      const withUrls = await Promise.all(data.map(att =>
        fetch(`/api/purchase-requests/${id}/attachments/${att.id}/url`).then(r => r.json()).then(j => ({ ...att, signedUrl: j.signedUrl }))
      ));
      host.innerHTML = withUrls.map(a => `
        <div style="position:relative;width:80px;height:80px;">
          <a href="${a.signedUrl}" target="_blank" rel="noopener">
            <img src="${a.signedUrl}" alt="${esc(a.fileName)}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #333;cursor:zoom-in;">
          </a>
          <button onclick="pmcOrders.removeEditImage(${id}, ${a.id})" title="삭제" style="position:absolute;top:-6px;right:-6px;width:22px;height:22px;background:#e94560;border:0;border-radius:11px;color:#fff;cursor:pointer;font-size:12px;line-height:1;padding:0;">×</button>
        </div>
      `).join('') + `<div style="color:#888;font-size:10px;align-self:center;margin-left:6px;">${withUrls.length}/5</div>`;
    } catch (e) {
      host.innerHTML = `<div style="color:#ff8a80;font-size:11px;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  async function uploadMoreImages(id) {
    const input = document.getElementById('po-edit-add-images');
    const files = Array.from(input?.files || []);
    if (files.length === 0) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const host = document.getElementById('po-edit-images');
    if (host) host.innerHTML = '<div style="color:#888;font-size:11px;">업로드 중…</div>';
    try {
      const res = await fetch(`/api/purchase-requests/${id}/attachments`, { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('업로드 실패: ' + (err.error || res.statusText));
      }
    } catch (e) {
      alert('업로드 실패: ' + e.message);
    }
    input.value = '';
    loadEditImages(id);
    refresh();
  }

  async function removeEditImage(requestId, attId) {
    if (!confirm('이 이미지를 삭제하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/purchase-requests/${requestId}/attachments/${attId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('삭제 실패: ' + (err.error || res.statusText));
        return;
      }
      loadEditImages(requestId);
      refresh();
    } catch (e) {
      alert('삭제 실패: ' + e.message);
    }
  }

  function closeEdit() {
    document.getElementById('po-edit-modal')?.remove();
  }

  async function saveEdit(id) {
    const errEl = document.getElementById('po-edit-error');
    errEl.style.display = 'none';
    const payload = {
      productName: document.getElementById('po-edit-product').value.trim(),
      sku: document.getElementById('po-edit-sku').value.trim(),
      unit: document.getElementById('po-edit-unit').value || '개',
      currentStock: document.getElementById('po-edit-stock').value || null,
      quantity: document.getElementById('po-edit-qty').value,
      estimatedPrice: document.getElementById('po-edit-price').value || null,
      priority: document.getElementById('po-edit-priority').value,
      reason: document.getElementById('po-edit-reason').value.trim(),
      memo: document.getElementById('po-edit-memo').value.trim(),
    };
    if (!payload.productName) { errEl.textContent = '상품명을 입력하세요'; errEl.style.display = 'block'; return; }
    const btn = document.getElementById('po-edit-save');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const res = await fetch(`/api/purchase-requests/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || '수정 실패'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = '저장'; return; }
      closeEdit();
      refresh();
    } catch (e) {
      errEl.textContent = e.message || '네트워크 오류';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '저장';
    }
  }

  window.pmcOrders = {
    load, refresh, approve, openReject, del, toggleInsights, markOrdered, unorder,
    openEdit, closeEdit, saveEdit,
    previewNewImages, toggleImages, uploadMoreImages, removeEditImage,
    toggleDetail,
  };
})();
