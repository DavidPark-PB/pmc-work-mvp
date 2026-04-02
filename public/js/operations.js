'use strict';

/**
 * operations.js — Dashboard Operations UI Module
 *
 * Handles: Products, Orders, Inventory, Listings Matrix,
 *          Pricing, Profit, Competitor, Automation Logs, Notifications
 *
 * All API calls go to /api/ops/*
 * Pagination uses server-side LIMIT+OFFSET.
 * Bulk operations process in batches on the server side.
 */

// ─── utility ────────────────────────────────────────────────────────────────

const opsApi = {
  async get(path) {
    const res = await fetch(`/api/ops${path}`);
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async patch(path, body) {
    const res = await fetch(`/api/ops${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async post(path, body) {
    const res = await fetch(`/api/ops${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async put(path, body) {
    const res = await fetch(`/api/ops${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
  async delete(path) {
    const res = await fetch(`/api/ops${path}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  },
};

function opsFmt(val, prefix = '$') {
  if (val == null) return '—';
  return `${prefix}${Number(val).toFixed(2)}`;
}

function opsDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('ko-KR');
}

function opsStatusBadge(status) {
  const map = {
    draft: 'status-draft', ready: 'status-ready', listed: 'status-listed',
    soldout: 'status-soldout', archived: 'status-archived',
  };
  const cls = map[status] || 'status-draft';
  return `<span class="status-badge ${cls}">${status || '—'}</span>`;
}

function opsPlatformBadge(statusMap, platform) {
  const s = statusMap && statusMap[platform];
  if (!s || s === 'draft' || s === 'ended' || s === 'error') {
    return `<span class="listing-no" title="${s || '없음'}">✖</span>`;
  }
  return `<span class="listing-yes" title="${s}">✔</span>`;
}

/**
 * Render a pagination bar into containerEl.
 * onPage(pageNum) called when user clicks a page button.
 */
function opsPagination(containerEl, pagination, onPage) {
  if (!containerEl || !pagination) return;
  const { page, totalPages, total, limit } = pagination;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  let html = `<span class="page-info">${from}–${to} / 총 ${total.toLocaleString()}건</span>`;

  const makeBtn = (label, targetPage, disabled = false, active = false) =>
    `<button onclick="${onPage}(${targetPage})"
       ${disabled ? 'disabled' : ''} class="${active ? 'active' : ''}">${label}</button>`;

  html += makeBtn('◀◀', 1, page <= 1);
  html += makeBtn('◀', page - 1, page <= 1);

  // Show at most 7 page buttons around current page
  const startPage = Math.max(1, page - 3);
  const endPage = Math.min(totalPages, page + 3);
  for (let p = startPage; p <= endPage; p++) {
    html += makeBtn(p, p, false, p === page);
  }

  html += makeBtn('▶', page + 1, page >= totalPages);
  html += makeBtn('▶▶', totalPages, page >= totalPages);

  containerEl.innerHTML = html;
}

// ─── 1. PRODUCTS ────────────────────────────────────────────────────────────

const opsProducts = (() => {
  let _page = 1;
  let _sort = 'created_at';
  let _order = 'desc';
  let _selected = new Set();

  function _buildUrl() {
    const q = document.getElementById('opsProductSearch')?.value || '';
    const status = document.getElementById('opsProductStatus')?.value || '';
    const platform = document.getElementById('opsProductPlatform')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50, sort: _sort, order: _order });
    if (q)        params.set('q', q);
    if (status)   params.set('workflow_status', status);
    if (platform) params.set('platform', platform);
    return `/products?${params}`;
  }

  async function load() {
    const tbody = document.getElementById('opsProductsBody');
    tbody.innerHTML = '<tr><td colspan="9" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="9" class="empty">검색 결과 없음</td></tr>'
        : data.map(p => `
          <tr>
            <td><input type="checkbox" class="ops-prod-cb" data-id="${p.id}"
              ${_selected.has(p.id) ? 'checked' : ''}
              onchange="opsProducts.toggleOne(this, ${p.id})"></td>
            <td style="font-family:monospace;font-size:12px">${p.sku || '—'}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.title || ''}">${p.title || '—'}</td>
            <td>${p.cost_price ? `₩${Number(p.cost_price).toLocaleString()}` : '—'}</td>
            <td>${p.inventory ?? (p.stock ?? '—')}</td>
            <td>${opsStatusBadge(p.workflow_status)}</td>
            <td style="font-size:11px">
              ${['ebay','shopify','naver','shopee'].map(pl =>
                p.platform_status?.[pl] ? `<span style="color:#69f0ae">${pl}</span> ` : ''
              ).join('')}
            </td>
            <td style="font-size:11px;color:#999">${opsDate(p.created_at)}</td>
            <td style="display:flex;gap:4px;align-items:center">
              <select style="padding:2px 4px;font-size:11px;background:#1a1a2e;color:#e0e0e0;border:1px solid #444;border-radius:3px"
                onchange="opsProducts.changeStatus(${p.id}, this.value)">
                ${['draft','ready','listed','soldout','archived'].map(s =>
                  `<option value="${s}" ${p.workflow_status === s ? 'selected' : ''}>${s}</option>`
                ).join('')}
              </select>
              <button onclick="opsProducts.deleteProduct(${p.id}, '${p.sku}')"
                style="padding:2px 6px;font-size:11px;background:#b71c1c;color:#fff;border:none;border-radius:3px;cursor:pointer">삭제</button>
            </td>
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsProductsPagination'),
        pagination,
        'opsProducts.goPage'
      );
      _updateBulkToolbar();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; _selected.clear(); load(); }
  function resetFilters() {
    document.getElementById('opsProductSearch').value = '';
    document.getElementById('opsProductStatus').value = '';
    document.getElementById('opsProductPlatform').value = '';
    search();
  }

  function sort(col) {
    if (_sort === col) _order = _order === 'asc' ? 'desc' : 'asc';
    else { _sort = col; _order = 'asc'; }
    load();
  }

  function toggleAll(cb) {
    document.querySelectorAll('.ops-prod-cb').forEach(el => {
      el.checked = cb.checked;
      const id = parseInt(el.dataset.id);
      cb.checked ? _selected.add(id) : _selected.delete(id);
    });
    _updateBulkToolbar();
  }

  function toggleOne(el, id) {
    el.checked ? _selected.add(id) : _selected.delete(id);
    _updateBulkToolbar();
  }

  function clearSelection() {
    _selected.clear();
    document.querySelectorAll('.ops-prod-cb').forEach(el => el.checked = false);
    document.getElementById('opsProductSelectAll').checked = false;
    _updateBulkToolbar();
  }

  function _updateBulkToolbar() {
    const toolbar = document.getElementById('opsBulkToolbar');
    const count = document.getElementById('opsBulkCount');
    if (_selected.size > 0) {
      toolbar.style.display = 'flex';
      count.textContent = `${_selected.size}개 선택됨`;
    } else {
      toolbar.style.display = 'none';
    }
  }

  async function changeStatus(id, status) {
    try {
      await opsApi.patch(`/products/${id}/workflow-status`, { workflow_status: status });
    } catch (e) {
      alert(`상태 변경 실패: ${e.message}`);
    }
  }

  async function deleteProduct(id, sku) {
    if (!confirm(`"${sku}" 상품을 삭제하시겠습니까?`)) return;
    try {
      await opsApi.delete(`/products/${id}`);
      load();
    } catch (e) {
      alert(`삭제 실패: ${e.message}`);
    }
  }

  async function bulkSetStatus() {
    const status = document.getElementById('opsBulkStatusValue').value;
    const ids = [..._selected];
    if (ids.length === 0) return;
    if (!confirm(`${ids.length}개 상품의 상태를 "${status}"로 변경합니다?`)) return;
    try {
      const result = await opsApi.post('/products/bulk', { action: 'set_workflow_status', ids, value: status });
      alert(`완료: ${result.updated}개 변경됨`);
      clearSelection();
      load();
    } catch (e) {
      alert(`일괄 변경 실패: ${e.message}`);
    }
  }

  async function bulkSetPrice() {
    const price = parseFloat(document.getElementById('opsBulkPriceValue').value);
    const ids = [..._selected];
    if (ids.length === 0) return;
    if (isNaN(price) || price < 0) { alert('올바른 가격을 입력하세요'); return; }
    if (!confirm(`${ids.length}개 상품의 가격을 $${price}로 변경합니다?`)) return;
    try {
      const result = await opsApi.post('/products/bulk', { action: 'set_price', ids, value: price });
      alert(`완료: ${result.updated}개 변경됨 (${result.batches}개 배치 처리)`);
      clearSelection();
      load();
    } catch (e) {
      alert(`일괄 가격 변경 실패: ${e.message}`);
    }
  }

  return { load, search, goPage, resetFilters, sort, toggleAll, toggleOne, clearSelection, changeStatus, deleteProduct, bulkSetStatus, bulkSetPrice };
})();

// ─── 2. ORDERS ──────────────────────────────────────────────────────────────

const opsOrders = (() => {
  let _page = 1;

  function _buildUrl() {
    const q = document.getElementById('opsOrderSearch')?.value || '';
    const platform = document.getElementById('opsOrderPlatform')?.value || '';
    const status = document.getElementById('opsOrderStatus')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50 });
    if (q) params.set('q', q);
    if (platform) params.set('platform', platform);
    if (status) params.set('status', status);
    return `/orders?${params}`;
  }

  const STATUS_LABELS = {
    awaiting_shipment: '발송 대기', shipped: '발송 완료', cancelled: '취소', NEW: 'NEW', PROCESSING: '처리 중',
  };

  async function load() {
    const tbody = document.getElementById('opsOrdersBody');
    tbody.innerHTML = '<tr><td colspan="10" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="10" class="empty">검색 결과 없음</td></tr>'
        : data.map(o => `
          <tr>
            <td style="font-family:monospace;font-size:11px">${o.order_no}</td>
            <td><span style="font-size:11px;padding:2px 6px;background:#1a2a3a;border-radius:3px">${o.platform}</span></td>
            <td style="font-family:monospace;font-size:11px">${o.sku || '—'}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${o.title || ''}">${o.title || '—'}</td>
            <td style="text-align:center">${o.quantity}</td>
            <td>${opsFmt(o.payment_amount)} ${o.currency || ''}</td>
            <td>${o.buyer_name || '—'}</td>
            <td>
              <select style="padding:2px 4px;font-size:11px;background:#1a1a2e;color:#e0e0e0;border:1px solid #444;border-radius:3px"
                onchange="opsOrders.changeStatus('${o.id}', this.value)">
                ${['awaiting_shipment','shipped','cancelled','NEW'].map(s =>
                  `<option value="${s}" ${o.status === s ? 'selected' : ''}>${STATUS_LABELS[s] || s}</option>`
                ).join('')}
              </select>
            </td>
            <td style="font-size:11px;color:#999">${opsDate(o.order_date || o.created_at)}</td>
            <td style="font-size:11px;color:#666">${o.tracking_no || '—'}</td>
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsOrdersPagination'),
        pagination,
        'opsOrders.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }

  async function changeStatus(id, status) {
    try {
      await opsApi.patch(`/orders/${id}/status`, { status });
    } catch (e) {
      alert(`상태 변경 실패: ${e.message}`);
    }
  }

  return { load, search, goPage, changeStatus };
})();

// ─── 3. INVENTORY ───────────────────────────────────────────────────────────

const opsInventory = (() => {
  let _page = 1;

  function _buildUrl() {
    const q = document.getElementById('opsInvSearch')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50 });
    if (q) params.set('q', q);
    return `/inventory?${params}`;
  }

  async function load() {
    const tbody = document.getElementById('opsInventoryBody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="8" class="empty">데이터 없음</td></tr>'
        : data.map(inv => `
          <tr>
            <td style="font-family:monospace;font-size:12px">${inv.products?.sku || '—'}</td>
            <td>
              <input type="text" id="inv-bc-${inv.product_id}" value="${inv.products?.barcode || ''}"
                placeholder="바코드 입력"
                style="width:120px;padding:3px 6px;background:#1a1a2e;border:1px solid #444;color:#e0e0e0;border-radius:3px;font-size:11px"
                onchange="opsInventory.saveBarcode('${inv.products?.sku || ''}', this)">
            </td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${inv.products?.title || '—'}</td>
            <td>
              <input type="number" id="inv-qty-${inv.product_id}" value="${inv.quantity}"
                min="0" style="width:70px;padding:3px 6px;background:#1a1a2e;border:1px solid #444;color:#e0e0e0;border-radius:3px;text-align:center">
            </td>
            <td style="color:#999">${inv.reserved || 0}</td>
            <td>${inv.location}</td>
            <td style="font-size:11px;color:#999">${new Date(inv.updated_at).toLocaleString('ko-KR')}</td>
            <td>
              <button class="refresh-btn" style="font-size:11px;padding:3px 8px"
                onclick="opsInventory.save(${inv.product_id}, '${inv.location}')">저장</button>
            </td>
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsInventoryPagination'),
        pagination,
        'opsInventory.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }

  async function save(productId, location) {
    const input = document.getElementById(`inv-qty-${productId}`);
    const quantity = parseInt(input?.value);
    if (isNaN(quantity) || quantity < 0) { alert('올바른 수량을 입력하세요'); return; }
    try {
      await opsApi.put(`/inventory/${productId}`, { quantity, location });
      input.style.borderColor = '#69f0ae';
      setTimeout(() => { input.style.borderColor = '#444'; }, 1500);
    } catch (e) {
      alert(`저장 실패: ${e.message}`);
    }
  }

  async function saveBarcode(sku, input) {
    var barcode = input.value.trim();
    if (!sku) return;
    input.style.borderColor = '#ff9800';
    try {
      var r = await fetch('/api/inventory/barcode-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: sku, barcode: barcode })
      });
      var d = await r.json();
      input.style.borderColor = d.success ? '#69f0ae' : '#ef9a9a';
      setTimeout(function() { input.style.borderColor = '#444'; }, 2000);
    } catch (e) {
      input.style.borderColor = '#ef9a9a';
    }
  }

  return { load, search, goPage, save, saveBarcode };
})();

// ─── 4. LISTING MATRIX ──────────────────────────────────────────────────────

const opsListings = (() => {
  let _page = 1;

  function _buildUrl() {
    const q = document.getElementById('opsListingSearch')?.value || '';
    const status = document.getElementById('opsListingStatus')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50 });
    if (q) params.set('q', q);
    if (status) params.set('workflow_status', status);
    return `/listing-matrix?${params}`;
  }

  const PLATFORMS = ['ebay', 'shopify', 'naver', 'coupang', 'qoo10', 'shopee', 'alibaba'];

  async function load() {
    const tbody = document.getElementById('opsListingsBody');
    tbody.innerHTML = '<tr><td colspan="11" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="11" class="empty">데이터 없음</td></tr>'
        : data.map(p => `
          <tr>
            <td style="font-family:monospace;font-size:12px">${p.sku}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.title || ''}">${p.title || '—'}</td>
            <td>${opsStatusBadge(p.workflow_status)}</td>
            <td style="text-align:center">${p.inventory_quantity ?? 0}</td>
            ${PLATFORMS.map(pl => {
              const status = p[`${pl}_status`];
              const listed = status && status !== 'draft' && status !== 'ended' && status !== 'error' && status !== 'null';
              return `<td style="text-align:center" title="${status || '없음'}">${listed
                ? '<span class="listing-yes">✔</span>'
                : '<span class="listing-no">✖</span>'}</td>`;
            }).join('')}
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsListingsPagination'),
        pagination,
        'opsListings.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }
  return { load, search, goPage };
})();

// ─── 5. PRICING ─────────────────────────────────────────────────────────────

const opsPricing = (() => {
  let _page = 1;
  let _selected = new Set();
  let _dirty = {};  // { id: newPrice }

  function _buildUrl() {
    const q = document.getElementById('opsPricingSearch')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50, sort: 'sku', order: 'asc' });
    if (q) params.set('q', q);
    return `/pricing?${params}`;
  }

  async function load() {
    const tbody = document.getElementById('opsPricingBody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty">로딩 중...</td></tr>';
    _dirty = {};
    document.getElementById('opsPricingSaveAll').disabled = true;

    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="7" class="empty">데이터 없음</td></tr>'
        : data.map(p => `
          <tr>
            <td><input type="checkbox" class="ops-price-cb" data-id="${p.id}"
              ${_selected.has(p.id) ? 'checked' : ''}
              onchange="opsPricing.toggleOne(this, ${p.id})"></td>
            <td style="font-family:monospace;font-size:12px">${p.sku}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.title || '—'}</td>
            <td>
              <input type="number" step="100" min="0"
                id="cost-${p.id}" value="${p.cost_price || ''}"
                style="width:80px;padding:3px 6px;background:#1a1a2e;border:1px solid #444;color:#e0e0e0;border-radius:3px"
                onchange="opsPricing.saveCost(${p.id}, this)">
            </td>
            <td>
              <input type="number" step="0.01" min="0"
                id="price-${p.id}" value="${p.price_usd || ''}"
                style="width:80px;padding:3px 6px;background:#1a1a2e;border:1px solid #444;color:#e0e0e0;border-radius:3px"
                oninput="opsPricing.markDirty(${p.id}, this.value)">
            </td>
            <td style="${Number(p.margin_pct) >= 20 ? 'color:#69f0ae' : 'color:#ef9a9a'}">
              ${Number(p.margin_pct || 0).toFixed(1)}%
            </td>
            <td>
              <button class="refresh-btn" style="font-size:11px;padding:3px 8px"
                onclick="opsPricing.saveSingle(${p.id})">저장</button>
            </td>
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsPricingPagination'),
        pagination,
        'opsPricing.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; _dirty = {}; load(); }

  function markDirty(id, value) {
    _dirty[id] = parseFloat(value);
    document.getElementById('opsPricingSaveAll').disabled = Object.keys(_dirty).length === 0;
  }

  function toggleAll(cb) {
    document.querySelectorAll('.ops-price-cb').forEach(el => {
      el.checked = cb.checked;
      const id = parseInt(el.dataset.id);
      cb.checked ? _selected.add(id) : _selected.delete(id);
    });
  }

  function toggleOne(el, id) {
    el.checked ? _selected.add(id) : _selected.delete(id);
  }

  async function saveSingle(id) {
    const input = document.getElementById(`price-${id}`);
    const price = parseFloat(input?.value);
    if (isNaN(price) || price < 0) { alert('올바른 가격을 입력하세요'); return; }
    try {
      await opsApi.post('/pricing/bulk-update', { items: [{ id, price_usd: price }] });
      input.style.borderColor = '#69f0ae';
      setTimeout(() => { input.style.borderColor = '#444'; }, 1500);
      delete _dirty[id];
      if (Object.keys(_dirty).length === 0) document.getElementById('opsPricingSaveAll').disabled = true;
    } catch (e) {
      alert(`저장 실패: ${e.message}`);
    }
  }

  async function saveAll() {
    const items = Object.entries(_dirty)
      .map(([id, price_usd]) => ({ id: parseInt(id), price_usd }))
      .filter(i => !isNaN(i.price_usd) && i.price_usd >= 0);

    if (items.length === 0) return;
    if (!confirm(`${items.length}개 상품 가격을 일괄 저장합니다? (50개 단위 배치 처리)`)) return;

    try {
      const result = await opsApi.post('/pricing/bulk-update', { items });
      alert(`완료: ${result.updated}개 저장 (${result.batches}개 배치)`);
      _dirty = {};
      document.getElementById('opsPricingSaveAll').disabled = true;
      load();
    } catch (e) {
      alert(`일괄 저장 실패: ${e.message}`);
    }
  }

  async function saveCost(id, input) {
    var costPrice = parseFloat(input.value);
    if (isNaN(costPrice) || costPrice < 0) { input.style.borderColor = '#c62828'; return; }
    input.style.borderColor = '#ff9800';
    try {
      var r = await fetch('/api/ops/pricing/cost', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, cost_price: costPrice })
      });
      var d = await r.json();
      if (d.success) {
        input.style.borderColor = '#2e7d32';
        setTimeout(function() { input.style.borderColor = '#444'; }, 2000);
        // Update margin display in same row
        if (d.margin !== null) {
          var row = input.closest('tr');
          var marginCell = row.querySelectorAll('td')[5];
          if (marginCell) {
            marginCell.textContent = d.margin.toFixed(1) + '%';
            marginCell.style.color = d.margin >= 20 ? '#69f0ae' : '#ef9a9a';
          }
        }
      } else {
        input.style.borderColor = '#c62828';
      }
    } catch (e) { input.style.borderColor = '#c62828'; }
  }

  return { load, search, goPage, markDirty, toggleAll, toggleOne, saveSingle, saveAll, saveCost };
})();

// ─── 6. PROFIT ──────────────────────────────────────────────────────────────

const opsProfit = (() => {
  let _page = 1;

  function _buildUrl() {
    const q = document.getElementById('opsProfitSearch')?.value || '';
    const platform = document.getElementById('opsProfitPlatform')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50 });
    if (q) params.set('q', q);
    if (platform) params.set('platform', platform);
    return `/profit?${params}`;
  }

  async function load() {
    const tbody = document.getElementById('opsProfitBody');
    tbody.innerHTML = '<tr><td colspan="9" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="9" class="empty">데이터 없음</td></tr>'
        : data.map(p => {
          const profitColor = p.profit >= 0 ? 'profit-pos' : 'profit-neg';
          return `
          <tr>
            <td style="font-family:monospace;font-size:12px">${p.sku}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.title || '—'}</td>
            <td>${opsFmt(p.sale_price)}</td>
            <td>${opsFmt(p.cost_price_usd)} <span style="color:#666;font-size:10px">(₩${Number(p.cost_price_krw || 0).toLocaleString()})</span></td>
            <td>${opsFmt(p.platform_fee)} <span style="color:#666;font-size:10px">(${(p.fee_rate * 100).toFixed(0)}%)</span></td>
            <td>${opsFmt(p.shipping_cost)}</td>
            <td class="${profitColor}" style="font-weight:700">${opsFmt(p.profit)}</td>
            <td style="${Number(p.margin_pct) >= 20 ? 'color:#69f0ae' : 'color:#ef9a9a'}">${Number(p.margin_pct || 0).toFixed(1)}%</td>
            <td style="font-size:11px;color:#999">${p.platform}</td>
          </tr>`;}).join('');

      opsPagination(
        document.getElementById('opsProfitPagination'),
        pagination,
        'opsProfit.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }
  return { load, search, goPage };
})();

// ─── 7. COMPETITOR ──────────────────────────────────────────────────────────

const opsCompetitor = (() => {
  let _page = 1;

  function _buildUrl() {
    const q = document.getElementById('opsCompSearch')?.value || '';
    const platform = document.getElementById('opsCompPlatform')?.value || 'ebay';
    const params = new URLSearchParams({ page: _page, limit: 50, platform });
    if (q) params.set('q', q);
    return `/competitor?${params}`;
  }

  async function load() {
    const tbody = document.getElementById('opsCompBody');
    tbody.innerHTML = '<tr><td colspan="9" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="9" class="empty">데이터 없음</td></tr>'
        : data.map(c => {
          const diffColor = c.difference > 0 ? 'color:#69f0ae' : 'color:#ef9a9a';
          const diffSign = c.difference > 0 ? '+' : '';
          return `
          <tr>
            <td style="font-family:monospace;font-size:12px">${c.sku}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.title || '—'}</td>
            <td style="font-weight:600">${opsFmt(c.our_price)}</td>
            <td style="font-size:11px;color:#999">${c.competitor_id || '—'}</td>
            <td>${opsFmt(c.competitor_price)}</td>
            <td style="color:#999">${opsFmt(c.competitor_shipping)}</td>
            <td>${opsFmt(c.competitor_total)}</td>
            <td style="${diffColor};font-weight:700">${diffSign}${opsFmt(c.difference, '')}</td>
            <td style="font-size:11px;color:#999">${opsDate(c.tracked_at)}</td>
          </tr>`;}).join('');

      opsPagination(
        document.getElementById('opsCompPagination'),
        pagination,
        'opsCompetitor.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }
  return { load, search, goPage };
})();

// ─── 8. AUTOMATION LOGS ──────────────────────────────────────────────────────

const opsLogs = (() => {
  let _page = 1;

  function _buildUrl() {
    const job_type = document.getElementById('opsLogJobType')?.value || '';
    const status = document.getElementById('opsLogStatus')?.value || '';
    const sku = document.getElementById('opsLogSku')?.value || '';
    const params = new URLSearchParams({ page: _page, limit: 50 });
    if (job_type) params.set('job_type', job_type);
    if (status) params.set('status', status);
    if (sku) params.set('sku', sku);
    return `/automation-logs?${params}`;
  }

  const STATUS_COLORS = {
    success: '#69f0ae', failed: '#ef9a9a', running: '#ffb74d', pending: '#90a4ae',
  };

  async function load() {
    const tbody = document.getElementById('opsLogsBody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">로딩 중...</td></tr>';
    try {
      const { data, pagination } = await opsApi.get(_buildUrl());
      tbody.innerHTML = data.length === 0
        ? '<tr><td colspan="5" class="empty">로그 없음</td></tr>'
        : data.map(log => `
          <tr>
            <td><span style="font-family:monospace;font-size:11px;padding:2px 6px;background:#1a2a3a;border-radius:3px">${log.job_type}</span></td>
            <td style="font-family:monospace;font-size:12px">${log.sku || log.products?.sku || '—'}</td>
            <td><span style="color:${STATUS_COLORS[log.status] || '#999'};font-weight:600">${log.status}</span></td>
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#bbb;font-size:12px" title="${log.message || ''}">${log.message || '—'}</td>
            <td style="font-size:11px;color:#666">${new Date(log.created_at).toLocaleString('ko-KR')}</td>
          </tr>`).join('');

      opsPagination(
        document.getElementById('opsLogsPagination'),
        pagination,
        'opsLogs.goPage'
      );
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty" style="color:#ef9a9a">오류: ${e.message}</td></tr>`;
    }
  }

  function goPage(pg) { _page = pg; load(); }
  function search() { _page = 1; load(); }
  return { load, search, goPage };
})();

// ─── 9. NOTIFICATIONS ───────────────────────────────────────────────────────

const opsNotif = (() => {
  let _open = false;
  let _count = 0;
  let _pollInterval = null;

  // Inject notification bell button into header
  function _injectBell() {
    const headerRight = document.querySelector('.header-right');
    if (!headerRight || document.getElementById('opsNotifBtn')) return;

    const btn = document.createElement('div');
    btn.id = 'opsNotifBtn';
    btn.style.cssText = 'position:relative;cursor:pointer;padding:4px 10px;margin-right:8px;display:inline-flex;align-items:center';
    btn.innerHTML = '🔔<span id="opsNotifBadge" class="notif-badge" style="display:none">0</span>';
    btn.onclick = () => _open ? opsNotif.close() : opsNotif.open();
    headerRight.prepend(btn);
  }

  async function refresh() {
    try {
      const { data, unread } = await opsApi.get('/notifications');
      _count = unread;

      const badge = document.getElementById('opsNotifBadge');
      if (badge) {
        badge.textContent = unread > 99 ? '99+' : unread;
        badge.style.display = unread > 0 ? 'block' : 'none';
      }

      const list = document.getElementById('opsNotifList');
      if (!list) return;

      if (data.length === 0) {
        list.innerHTML = '<div style="padding:16px;text-align:center;color:#666;font-size:13px">알림 없음</div>';
        return;
      }

      const TYPE_ICONS = { error: '❌', warning: '⚠️', info: 'ℹ️' };
      list.innerHTML = data.map(n => `
        <div style="padding:8px 10px;border-bottom:1px solid #333;cursor:default">
          <div style="display:flex;gap:6px;align-items:flex-start">
            <span style="font-size:14px">${TYPE_ICONS[n.type] || 'ℹ️'}</span>
            <div>
              <div style="font-size:12px;font-weight:600;color:#e0e0e0;margin-bottom:2px">${n.title}</div>
              <div style="font-size:11px;color:#999;line-height:1.4">${n.message}</div>
              <div style="font-size:10px;color:#555;margin-top:2px">${new Date(n.created_at).toLocaleString('ko-KR')}</div>
            </div>
          </div>
        </div>`).join('');
    } catch (e) {
      // Silent fail for notifications
    }
  }

  function open() {
    _open = true;
    const panel = document.getElementById('opsNotifPanel');
    if (panel) { panel.style.display = 'flex'; refresh(); }
  }

  function close() {
    _open = false;
    const panel = document.getElementById('opsNotifPanel');
    if (panel) panel.style.display = 'none';
  }

  function startPolling(intervalMs = 60000) {
    _injectBell();
    refresh();
    if (_pollInterval) clearInterval(_pollInterval);
    _pollInterval = setInterval(refresh, intervalMs);
  }

  return { open, close, refresh, startPolling };
})();

// ─── GLOBAL EXPORTS ─────────────────────────────────────────────────────────
// Expose modules to window so dashboard.js navigateTo() can call them.
// Navigation is fully handled by dashboard.js — no separate click listeners here.

window.opsProducts   = opsProducts;
window.opsOrders     = opsOrders;
window.opsInventory  = opsInventory;
window.opsListings   = opsListings;
window.opsPricing    = opsPricing;
window.opsProfit     = opsProfit;
window.opsCompetitor = opsCompetitor;
window.opsLogs       = opsLogs;
window.opsNotif      = opsNotif;

// Start notification polling after DOM ready
(function initNotifications() {
  function start() { opsNotif.startPolling(60000); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
