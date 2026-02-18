const API = '/api';
let currentPage = 'dashboard';

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEvents();
  setupInlineEditing();
  loadDashboard();
  setInterval(() => { if (currentPage === 'dashboard') loadDashboard(); }, 300000);
});

// ===== 페이지 라우팅 =====

function setupNavigation() {
  document.querySelectorAll('.sidebar .menu-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sidebar .menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      navigateTo(item.dataset.page);
    });
  });
}

function navigateTo(page) {
  currentPage = page;

  // 페이지 전환
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // 플랫폼 필터 페이지들은 products 페이지로 매핑
  if (['shopify', 'ebay', 'naver', 'alibaba', 'shopee'].includes(page)) {
    document.getElementById('page-products').classList.add('active');
    document.getElementById('allPlatformFilter').value = page;
    loadAllProducts(page);
    return;
  }

  const pageEl = document.getElementById('page-' + page);
  if (pageEl) {
    pageEl.classList.add('active');
  } else {
    document.getElementById('page-dashboard').classList.add('active');
  }

  // 페이지별 데이터 로드
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'products': loadAllProducts(); break;
    case 'analysis': loadAnalysis(); break;
    case 'anomalies': loadAnomalies(); break;
    case 'top': loadTopProducts(); break;
    case 'sync': loadSyncPage(); break;
    case 'register': setupRegisterForm(); break;
  }
}

// ===== 대시보드 =====

async function loadDashboard() {
  showLoading(true);
  try {
    const res = await fetch(`${API}/dashboard/summary`);
    const data = await res.json();

    renderPlatformCards(data.platforms || []);
    renderSyncHistory(data.syncHistory || []);
    updateLastUpdated(data.timestamp);
    loadProducts();

    // 매출 요약도 로드
    loadSummaryCards();
  } catch (err) {
    console.error('Dashboard load failed:', err);
  } finally {
    showLoading(false);
  }
}

async function loadSummaryCards() {
  try {
    const res = await fetch(`${API}/analysis/summary`);
    const data = await res.json();
    if (data.error === 'no_data') return;
    renderSummaryCards(data);
  } catch (e) {}
}

function renderSummaryCards(data) {
  const container = document.getElementById('summaryCards');
  if (!data || data.error) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="stat-card summary" style="border-color:#2196f3">
      <div class="label">총 매출 (정산액)</div>
      <div class="number">${krw(data.totalRevenue)}</div>
      <div class="sub">${data.totalProducts}개 상품</div>
    </div>
    <div class="stat-card summary" style="border-color:${data.totalProfit >= 0 ? '#4caf50' : '#f44336'}">
      <div class="label">총 순이익</div>
      <div class="number">${krw(data.totalProfit)}</div>
      <div class="sub">평균 마진율 ${data.avgMargin}%</div>
    </div>
    <div class="stat-card summary" style="border-color:#ff9800">
      <div class="label">마진 위험</div>
      <div class="number" style="color:#e65100">${data.lowMarginCount + data.negativeMarginCount}</div>
      <div class="sub">역마진 ${data.negativeMarginCount}개</div>
    </div>
    <div class="stat-card summary" style="border-color:#96bf48">
      <div class="label">효자상품</div>
      <div class="number" style="color:#2e7d32">${data.highMarginCount}</div>
      <div class="sub">마진 20% 이상</div>
    </div>
  `;
}

async function loadProducts(platform) {
  try {
    const url = platform
      ? `${API}/products?platform=${platform}&limit=30`
      : `${API}/products?limit=30`;
    const res = await fetch(url);
    const products = await res.json();
    renderProductTable(products, 'productTable', 'productCount');
  } catch (err) {
    console.error('Products load failed:', err);
  }
}

// ===== 전체 상품 (인라인 편집) =====

async function loadAllProducts(platform) {
  try {
    const pf = platform || document.getElementById('allPlatformFilter').value;
    const url = pf
      ? `${API}/products?platform=${pf}&limit=50`
      : `${API}/products?limit=50`;
    const res = await fetch(url);
    const products = await res.json();
    renderEditableTable(products, 'allProductTable', 'allProductCount');
  } catch (err) {
    console.error('All products load failed:', err);
  }
}

// ===== 매출/마진 분석 =====

async function loadAnalysis() {
  showLoading(true);
  try {
    const [summaryRes, productsRes] = await Promise.all([
      fetch(`${API}/analysis/summary`),
      fetch(`${API}/analysis/products?sort=${document.getElementById('analysisSortBy')?.value || 'margin'}&limit=50`)
    ]);
    const summary = await summaryRes.json();
    const products = await productsRes.json();

    if (summary.error === 'no_data') {
      document.getElementById('analysisCards').innerHTML =
        '<div class="stat-card" style="grid-column:1/-1"><div class="empty">Google Sheets credentials.json이 필요합니다.<br>config/credentials.json에 Service Account 키를 넣어주세요.</div></div>';
      return;
    }

    renderAnalysisCards(summary);
    renderPlatformRevenue(summary.byPlatform || {});
    renderMarginDistribution(products);
    renderAnalysisTable(products);
  } catch (err) {
    console.error('Analysis load failed:', err);
  } finally {
    showLoading(false);
  }
}

function renderAnalysisCards(data) {
  const container = document.getElementById('analysisCards');
  container.innerHTML = `
    <div class="stat-card summary" style="border-color:#2196f3">
      <div class="label">총 매출 (정산액)</div>
      <div class="number">${krw(data.totalRevenue)}</div>
    </div>
    <div class="stat-card summary" style="border-color:#4caf50">
      <div class="label">총 순이익</div>
      <div class="number">${krw(data.totalProfit)}</div>
    </div>
    <div class="stat-card summary" style="border-color:#ff9800">
      <div class="label">총 매입가</div>
      <div class="number">${krw(data.totalPurchase)}</div>
    </div>
    <div class="stat-card summary" style="border-color:#9c27b0">
      <div class="label">평균 마진율</div>
      <div class="number">${data.avgMargin}%</div>
    </div>
    <div class="stat-card summary" style="border-color:#f44336">
      <div class="label">마진 위험</div>
      <div class="number" style="color:#c62828">${data.lowMarginCount}</div>
    </div>
  `;
  container.style.gridTemplateColumns = 'repeat(5, 1fr)';
}

function renderPlatformRevenue(byPlatform) {
  const container = document.getElementById('platformRevenue');
  const entries = Object.entries(byPlatform);
  if (entries.length === 0) {
    container.innerHTML = '<p class="empty">데이터 없음</p>';
    return;
  }

  const maxRevenue = Math.max(...entries.map(([, v]) => v.revenue));
  const colors = { eBay: '#1565c0', Shopify: '#96bf48', Naver: '#03c75a', Alibaba: '#ff6a00' };

  container.innerHTML = entries.map(([name, v]) => {
    const pct = maxRevenue > 0 ? (v.revenue / maxRevenue * 100) : 0;
    const color = colors[name] || '#888';
    return `
      <div class="revenue-bar">
        <div class="name">${esc(name)}</div>
        <div class="bar-wrap">
          <div class="bar" style="width:${pct}%;background:${color}">
            <span>${v.count}개</span>
          </div>
        </div>
        <div class="amount">${krw(v.revenue)}</div>
      </div>
    `;
  }).join('');
}

function renderMarginDistribution(products) {
  const container = document.getElementById('marginDistribution');
  if (!products || products.length === 0) {
    container.innerHTML = '<p class="empty">데이터 없음</p>';
    return;
  }

  const ranges = [
    { label: '역마진 (< 0%)', min: -999, max: 0, color: '#f44336' },
    { label: '0~5%', min: 0, max: 5, color: '#ff9800' },
    { label: '5~10%', min: 5, max: 10, color: '#ffc107' },
    { label: '10~20%', min: 10, max: 20, color: '#8bc34a' },
    { label: '20~30%', min: 20, max: 30, color: '#4caf50' },
    { label: '30%+', min: 30, max: 999, color: '#2196f3' },
  ];

  const counts = ranges.map(r => ({
    ...r,
    count: products.filter(p => {
      const m = parseFloat(p.margin);
      return !isNaN(m) && m >= r.min && m < r.max;
    }).length
  }));

  const maxCount = Math.max(...counts.map(c => c.count), 1);

  container.innerHTML = counts.map(c => `
    <div class="margin-dist-item">
      <div class="range">${c.label}</div>
      <div class="bar-wrap">
        <div class="bar" style="width:${c.count/maxCount*100}%;background:${c.color}"></div>
      </div>
      <div class="cnt">${c.count}</div>
    </div>
  `).join('');
}

function renderAnalysisTable(products) {
  const tbody = document.getElementById('analysisTable');
  const countEl = document.getElementById('analysisProductCount');
  countEl.textContent = `(${products.length}개)`;

  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">데이터 없음</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const margin = parseFloat(p.margin);
    const marginClass = isNaN(margin) ? '' : margin >= 20 ? 'high' : margin >= 10 ? 'good' : margin >= 5 ? 'low' : 'danger';
    return `
      <tr>
        <td>${esc(p.sku)}</td>
        <td title="${esc(p.title)}">${esc(p.title)}</td>
        <td>${p.purchase ? krw(p.purchase) : '-'}</td>
        <td>${p.priceUSD ? '$' + parseFloat(p.priceUSD).toFixed(2) : '-'}</td>
        <td>${p.settlement ? krw(p.settlement) : '-'}</td>
        <td style="color:${parseFloat(p.profit) < 0 ? '#c62828' : '#2e7d32'}">${p.profit ? krw(p.profit) : '-'}</td>
        <td><span class="margin-badge ${marginClass}">${!isNaN(margin) ? margin.toFixed(1) + '%' : '-'}</span></td>
      </tr>
    `;
  }).join('');
}

// ===== 이상 탐지 =====

async function loadAnomalies() {
  showLoading(true);
  try {
    const res = await fetch(`${API}/anomalies`);
    const data = await res.json();

    renderAnomalySummary(data.summary || {});
    renderAnomalyTable(data.lowMargin || [], 'lowMarginTable', 'lowMarginCount', renderLowMarginRow);
    renderAnomalyTable(data.lowStock || [], 'lowStockTable', 'lowStockCount', renderLowStockRow);
    renderAnomalyTable(data.salesDrop || [], 'salesDropTable', 'salesDropCount', renderSalesDropRow);
  } catch (err) {
    console.error('Anomalies load failed:', err);
  } finally {
    showLoading(false);
  }
}

function renderAnomalySummary(summary) {
  const container = document.getElementById('anomalySummary');
  container.innerHTML = `
    <div class="anomaly-card red">
      <div class="number">${summary.lowMargin || 0}</div>
      <div class="label">마진 위험</div>
    </div>
    <div class="anomaly-card orange">
      <div class="number">${summary.lowStock || 0}</div>
      <div class="label">재고 부족</div>
    </div>
    <div class="anomaly-card yellow">
      <div class="number">${summary.salesDrop || 0}</div>
      <div class="label">판매 급감</div>
    </div>
    <div class="anomaly-card blue">
      <div class="number">${summary.total || 0}</div>
      <div class="label">총 이상 징후</div>
    </div>
  `;
}

function renderAnomalyTable(items, tableId, countId, rowRenderer) {
  const tbody = document.getElementById(tableId);
  const countEl = document.getElementById(countId);
  countEl.textContent = items.length;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${tbody.closest('table').querySelectorAll('th').length}" class="empty">이상 없음</td></tr>`;
    return;
  }

  tbody.innerHTML = items.slice(0, 20).map(rowRenderer).join('');
}

function renderLowMarginRow(item) {
  return `<tr>
    <td>${esc(item.sku)}</td>
    <td title="${esc(item.title)}">${esc(item.title)}</td>
    <td><span class="margin-badge danger">${item.margin}%</span></td>
    <td style="color:${item.profit < 0 ? '#c62828' : '#333'}">${krw(item.profit)}</td>
  </tr>`;
}

function renderLowStockRow(item) {
  return `<tr>
    <td>${esc(item.sku)}</td>
    <td title="${esc(item.title)}">${esc(item.title)}</td>
    <td style="color:#c62828;font-weight:600">${item.stock}</td>
    <td>${item.safeStock}</td>
  </tr>`;
}

function renderSalesDropRow(item) {
  const change = item.prev3weeks > 0 ? Math.round((1 - item.recent7days / item.prev3weeks) * 100) : 0;
  return `<tr>
    <td>${esc(item.sku)}</td>
    <td title="${esc(item.title)}">${esc(item.title)}</td>
    <td>${item.recent7days}</td>
    <td>${item.prev3weeks}</td>
    <td style="color:#c62828;font-weight:600">-${change}%</td>
  </tr>`;
}

// ===== 효자상품 TOP =====

async function loadTopProducts() {
  showLoading(true);
  try {
    const res = await fetch(`${API}/analysis/top`);
    const products = await res.json();

    const tbody = document.getElementById('topProductsTable');

    if (products.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">데이터 없음 (Google Sheets credentials.json 필요)</td></tr>';
      return;
    }

    tbody.innerHTML = products.map((p, i) => `
      <tr>
        <td style="font-weight:600;color:#1565c0">${i + 1}</td>
        <td>${esc(p.sku)}</td>
        <td title="${esc(p.title)}">${esc(p.title)}</td>
        <td>${p.priceUSD ? '$' + parseFloat(p.priceUSD).toFixed(2) : '-'}</td>
        <td style="color:#2e7d32;font-weight:600">${p.profit ? krw(p.profit) : '-'}</td>
        <td><span class="margin-badge high">${parseFloat(p.margin).toFixed(1)}%</span></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Top products load failed:', err);
  } finally {
    showLoading(false);
  }
}

// ===== 동기화 페이지 =====

async function loadSyncPage() {
  try {
    const res = await fetch(`${API}/sync/history`);
    const history = await res.json();
    renderSyncHistory(history, 'syncHistoryFull');
  } catch (e) {}
}

// ===== 상품 등록 =====

function setupRegisterForm() {
  const form = document.getElementById('registerForm');
  if (form.dataset.initialized) return;
  form.dataset.initialized = 'true';

  // 실시간 마진 미리보기
  ['purchasePrice', 'priceUSD', 'shippingUSD'].forEach(name => {
    form.elements[name].addEventListener('input', updateMarginPreview);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById('registerResult');
    const submitBtn = form.querySelector('.submit-btn');

    submitBtn.disabled = true;
    submitBtn.textContent = '등록 중...';
    resultEl.className = 'register-result';
    resultEl.style.display = 'none';

    const formData = new FormData(form);
    const body = {
      sku: formData.get('sku'),
      title: formData.get('title'),
      purchasePrice: formData.get('purchasePrice'),
      weight: formData.get('weight'),
      priceUSD: formData.get('priceUSD'),
      shippingUSD: formData.get('shippingUSD'),
      targetPlatforms: formData.getAll('targetPlatforms')
    };

    try {
      const res = await fetch(`${API}/products/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await res.json();

      if (result.success) {
        const r = result.results || {};
        let details = [];
        if (r.sheets === true) details.push('Google Sheets');
        if (r.ebay?.success) details.push('eBay' + (r.ebay.itemId ? ` (ID: ${r.ebay.itemId})` : ''));
        if (r.shopify?.success) details.push('Shopify' + (r.shopify.productId ? ` (ID: ${r.shopify.productId})` : ''));
        if (r.naver?.success) details.push('Naver' + (r.naver.productNo ? ` (No: ${r.naver.productNo})` : ''));

        let warnings = [];
        if (r.ebay && !r.ebay.success && r.ebay.error) warnings.push('eBay: ' + r.ebay.error);
        if (r.shopify && !r.shopify.success && r.shopify.error) warnings.push('Shopify: ' + r.shopify.error);
        if (r.naver && !r.naver.success && r.naver.error) warnings.push('Naver: ' + r.naver.error);

        resultEl.className = 'register-result success';
        resultEl.innerHTML = `${esc(result.message)} (SKU: ${esc(body.sku)})` +
          (details.length > 0 ? `<br>성공: ${esc(details.join(', '))}` : '') +
          (warnings.length > 0 ? `<br><span style="color:#ff9800">경고: ${esc(warnings.join('; '))}</span>` : '');
        resultEl.style.display = 'block';
        form.reset();
        form.elements['shippingUSD'].value = '3.9';
        document.getElementById('marginPreview').style.display = 'none';
      } else {
        resultEl.className = 'register-result error';
        resultEl.textContent = result.message || '등록 실패';
        resultEl.style.display = 'block';
      }
    } catch (err) {
      resultEl.className = 'register-result error';
      resultEl.textContent = '서버 오류: ' + err.message;
      resultEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '상품 등록';
    }
  });
}

function updateMarginPreview() {
  const form = document.getElementById('registerForm');
  const purchase = parseFloat(form.elements['purchasePrice'].value) || 0;
  const price = parseFloat(form.elements['priceUSD'].value) || 0;
  const shipping = parseFloat(form.elements['shippingUSD'].value) || 3.9;
  const previewEl = document.getElementById('marginPreview');

  if (purchase > 0 && price > 0) {
    const settlement = (price + shipping) * 0.82 * 1400;
    const tax = purchase * 0.15;
    const profit = settlement - purchase - tax;
    const margin = settlement > 0 ? (profit / settlement * 100) : 0;

    document.getElementById('previewMargin').textContent = margin.toFixed(1) + '%';
    document.getElementById('previewMargin').style.color = margin >= 20 ? '#2e7d32' : margin >= 5 ? '#333' : '#c62828';
    document.getElementById('previewProfit').textContent = krw(Math.round(profit));
    document.getElementById('previewProfit').style.color = profit >= 0 ? '#2e7d32' : '#c62828';
    previewEl.style.display = 'block';
  } else {
    previewEl.style.display = 'none';
  }
}

// ===== 공통 렌더링 =====

function renderPlatformCards(platforms) {
  const container = document.getElementById('platformCards');
  const labels = {
    connected: '연결됨', disconnected: '미연결',
    pending: '심사 중', error: '오류'
  };

  container.innerHTML = platforms.map(p => `
    <div class="stat-card">
      <div class="platform">
        <span class="dot" style="background:${p.color}"></span>
        ${p.name}
      </div>
      <div class="number">${p.productCount.toLocaleString()}</div>
      <div class="label">상품</div>
      <div class="status ${p.status}">${labels[p.status] || p.status}</div>
    </div>
  `).join('');
}

// 대시보드용 심플 테이블 (읽기전용, 4열)
function renderProductTable(products, tableId, countId) {
  const tbody = document.getElementById(tableId || 'productTable');
  const countEl = document.getElementById(countId || 'productCount');
  countEl.textContent = `(${products.length}개)`;

  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">상품 없음</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => `
    <tr>
      <td>${esc(p.sku)}</td>
      <td title="${esc(p.title)}">${esc(p.title)}</td>
      <td><span class="badge ${p.platform.toLowerCase()}">${p.platform}</span></td>
      <td>${p.price ? formatPrice(p.price, p.platform) : '-'}</td>
    </tr>
  `).join('');
}

// 플랫폼 페이지용 인라인 편집 테이블 (6열: SKU, 상품명, 플랫폼, 가격, 재고, 상태)
function renderEditableTable(products, tableId, countId) {
  const tbody = document.getElementById(tableId || 'allProductTable');
  const countEl = document.getElementById(countId || 'allProductCount');
  countEl.textContent = `(${products.length}개)`;

  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">상품 없음</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const pf = p.platform || '';
    const pfLower = pf.toLowerCase();
    const priceVal = p.price || '';
    const qtyVal = p.quantity !== undefined && p.quantity !== '' ? p.quantity : '';
    const step = pf === 'Naver' ? '1' : '0.01';

    return `
    <tr data-platform="${esc(pf)}" data-edit-id="${esc(p.editId || '')}" data-sku="${esc(p.sku || '')}">
      <td>${esc(p.sku)}</td>
      <td title="${esc(p.title)}">${esc(p.title)}</td>
      <td><span class="badge ${pfLower}">${pf}</span></td>
      <td><input type="number" class="inline-input" data-field="price" value="${esc(String(priceVal))}" data-original="${esc(String(priceVal))}" step="${step}" placeholder="가격"></td>
      <td><input type="number" class="inline-input" data-field="quantity" value="${esc(String(qtyVal))}" data-original="${esc(String(qtyVal))}" step="1" placeholder="재고"></td>
      <td class="save-cell"><span class="save-status"></span></td>
    </tr>`;
  }).join('');
}

function renderSyncHistory(history, containerId) {
  const container = document.getElementById(containerId || 'syncHistory');
  const recent = Array.isArray(history) ? history.slice(-10).reverse() : [];

  if (recent.length === 0) {
    container.innerHTML = '<p class="empty">동기화 이력 없음</p>';
    return;
  }

  container.innerHTML = recent.map(entry => {
    const color = entry.status === 'completed' ? '#4caf50' :
                  entry.status === 'error' ? '#f44336' : '#ff9800';
    return `
      <div class="sync-item">
        <div class="info">
          <span class="status-dot" style="background:${color}"></span>
          ${esc(entry.note || entry.status)}
        </div>
        <div class="time">${timeAgo(entry.timestamp)}</div>
      </div>
    `;
  }).join('');
}

function setupEvents() {
  document.getElementById('refreshBtn').addEventListener('click', () => {
    navigateTo(currentPage);
  });

  document.getElementById('platformFilter').addEventListener('change', (e) => {
    loadProducts(e.target.value || null);
  });

  document.getElementById('allPlatformFilter').addEventListener('change', (e) => {
    loadAllProducts(e.target.value || null);
  });

  // 분석 정렬
  const sortEl = document.getElementById('analysisSortBy');
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      if (currentPage === 'analysis') loadAnalysis();
    });
  }

  // 동기화 버튼들
  document.querySelectorAll('.sync-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const platform = btn.dataset.platform;
      const original = btn.textContent;
      btn.disabled = true;
      btn.classList.add('running');
      btn.textContent = '동기화 중...';

      try {
        await fetch(`${API}/sync/trigger/${platform}`, { method: 'POST' });
        btn.textContent = '시작됨';
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove('running');
          btn.textContent = original;
          if (currentPage === 'dashboard') loadDashboard();
        }, 60000);
      } catch (err) {
        btn.textContent = '실패';
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove('running');
          btn.textContent = original;
        }, 5000);
      }
    });
  });
}

// ===== 인라인 편집 =====

function setupInlineEditing() {
  const table = document.getElementById('allProductTable');

  // Enter키로 저장
  table.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('inline-input')) {
      e.preventDefault();
      e.target.blur();
    }
  });

  // 값 변경 감지 (입력 중 하이라이트)
  table.addEventListener('input', (e) => {
    if (e.target.classList.contains('inline-input')) {
      const changed = e.target.value !== e.target.dataset.original;
      e.target.classList.toggle('changed', changed);
    }
  });

  // blur시 자동 저장
  table.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('inline-input')) {
      const original = e.target.dataset.original;
      if (e.target.value !== original && e.target.value !== '') {
        saveInline(e.target);
      }
    }
  });
}

async function saveInline(input) {
  const row = input.closest('tr');
  if (!row) return;

  const platform = row.dataset.platform;
  const editId = row.dataset.editId;
  const sku = row.dataset.sku;
  const statusEl = row.querySelector('.save-status');

  if (!editId) {
    statusEl.textContent = 'ID없음';
    statusEl.className = 'save-status error';
    return;
  }

  // 같은 행의 변경된 값 수집
  const inputs = row.querySelectorAll('.inline-input');
  const changes = {};
  inputs.forEach(inp => {
    if (inp.value !== inp.dataset.original && inp.value !== '') {
      changes[inp.dataset.field] = inp.value;
    }
  });

  if (Object.keys(changes).length === 0) return;

  statusEl.textContent = '저장 중...';
  statusEl.className = 'save-status saving';

  try {
    let url, body;

    if (platform === 'eBay') {
      url = `${API}/products/ebay/${editId}`;
      body = { sku };
      if (changes.price) body.price = parseFloat(changes.price);
      if (changes.quantity) body.quantity = parseInt(changes.quantity);
    } else if (platform === 'Shopify') {
      url = `${API}/products/shopify/${editId}`;
      body = { sku };
      if (changes.price) body.price = changes.price;
      if (changes.quantity) body.inventory_quantity = parseInt(changes.quantity);
    } else if (platform === 'Naver') {
      url = `${API}/products/naver/${editId}`;
      body = { sku };
      if (changes.price) body.price = parseInt(changes.price);
      if (changes.quantity) body.stock = parseInt(changes.quantity);
    } else if (platform === 'Alibaba') {
      url = `${API}/products/alibaba/${editId}`;
      body = { sku };
      if (changes.price) body.price = changes.price;
      if (changes.quantity) body.quantity = changes.quantity;
    } else {
      statusEl.textContent = '미지원';
      statusEl.className = 'save-status error';
      return;
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res.json();

    if (result.success) {
      statusEl.textContent = '저장됨';
      statusEl.className = 'save-status saved';
      // original 값 업데이트
      inputs.forEach(inp => {
        if (changes[inp.dataset.field]) {
          inp.dataset.original = inp.value;
          inp.classList.remove('changed');
        }
      });
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'save-status';
      }, 3000);
    } else {
      statusEl.textContent = '실패';
      statusEl.className = 'save-status error';
      setTimeout(() => {
        statusEl.textContent = result.error || '';
        statusEl.className = 'save-status error';
      }, 1000);
    }
  } catch (err) {
    statusEl.textContent = '오류';
    statusEl.className = 'save-status error';
  }
}

// ===== 유틸리티 =====

function updateLastUpdated(ts) {
  document.getElementById('lastUpdated').textContent =
    `업데이트: ${new Date(ts).toLocaleString('ko-KR')}`;
}

function showLoading(show) {
  const el = document.getElementById('loading');
  el.classList.toggle('show', show);
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function formatPrice(price, platform) {
  const num = parseFloat(price);
  if (isNaN(num)) return price;
  if (platform === 'Naver') return `${num.toLocaleString()}원`;
  return `$${num.toFixed(2)}`;
}

function krw(val) {
  const num = parseFloat(val);
  if (isNaN(num)) return '-';
  if (Math.abs(num) >= 100000000) return (num / 100000000).toFixed(1) + '억';
  if (Math.abs(num) >= 10000) return (num / 10000).toFixed(0) + '만';
  return num.toLocaleString() + '원';
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 모달 외부 클릭시 닫기 (모달은 남겨둠)
function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
}
document.getElementById('editModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeEditModal();
});
