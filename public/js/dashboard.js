const API = '/api';
var currentPage = 'dashboard';

const CARRIERS = ['윤익스프레스', 'KPL', '다보내', '쉽터', 'KPacket', 'FedEx'];
const CARRIER_COLORS = {
  '윤익스프레스': '#1565c0',
  'KPL': '#e65100',
  '다보내': '#2e7d32',
  '쉽터': '#6a1b9a',
  'KPacket': '#c62828',
  'FedEx': '#4a148c',
};

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
    case 'sku-scores': loadSkuScores(); break;
    case 'top': loadTopProducts(); break;
    case 'sync': loadSyncPage(); break;
    case 'b2b': setupB2BPage(); break;
    case 'register': setupRegisterForm(); break;
    case 'master-products': loadMasterProducts(); break;
    case 'ebay-trends': loadEbayTrends(); break;
    case 'battle': loadBattle(); break;
    case 'remarker': setupRemarker(); break;
    case 'reconstruct': setupReconstructPage(); break;
    case 'shipping': setupShippingPage(); break;
    case 'settings': loadSettingsPage(); break;
    case 'export': loadExportPage(); break;
    case 'automation': loadAutomationPage(); break;
    case 'crawl-results': loadCrawlResultsPage(); break;
    // ── 운영 관리 페이지 (operations.js) ──
    case 'ops-products':  if (window.opsProducts)  opsProducts.load();  break;
    case 'ops-inventory': if (window.opsInventory) opsInventory.load(); break;
    case 'ops-pricing':   if (window.opsPricing)   opsPricing.load();   break;
    case 'ops-profit':    if (window.opsProfit)     opsProfit.load();    break;
    case 'ops-competitor':if (window.opsCompetitor) opsCompetitor.load();break;
    case 'ops-logs':      if (window.opsLogs)       opsLogs.load();      break;
  }
}

// ===== 상품 동기화 =====

async function syncAllProducts() {
  var btn = document.getElementById('syncProductsBtn');
  btn.disabled = true;
  btn.textContent = '동기화 중...';
  try {
    var r = await fetch('/api/sync/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    var msg = Object.entries(d.results).map(function(e) {
      var p = e[0], v = e[1];
      return p + ': ' + (v.synced || 0) + '건' + (v.error ? ' (오류)' : '');
    }).join(', ');
    alert('동기화 완료!\n' + msg);
    loadDashboard();
  } catch (e) {
    alert('동기화 실패: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '상품 동기화';
  }
}

async function syncToMaster() {
  var btn = document.getElementById('syncMasterBtn');
  if (btn) { btn.disabled = true; btn.textContent = '마스터 동기화 중...'; }
  try {
    var r = await fetch('/api/sync/master', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    alert('마스터 동기화 완료!\neBay: ' + (d.results.ebay || 0) + '건, Shopify: ' + (d.results.shopify || 0) + '건');
    loadDashboard();
  } catch (e) {
    alert('마스터 동기화 실패: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '마스터 동기화'; }
  }
}

async function scanInventory(type) {
  var sku = document.getElementById('scanSkuInput').value.trim();
  var qty = parseInt(document.getElementById('scanQtyInput').value) || 1;
  if (!sku) { alert('SKU를 입력하세요'); return; }
  try {
    var r = await fetch('/api/inventory/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: sku, quantity: qty, type: type })
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    var msg = type === 'in' ? '입고' : '출고';
    alert(msg + ' 완료!\nSKU: ' + d.sku + '\n이전: ' + d.previousStock + ' → 현재: ' + d.newStock);
    document.getElementById('scanSkuInput').value = '';
    document.getElementById('scanQtyInput').value = '1';
  } catch (e) {
    alert('실패: ' + e.message);
  }
}

var barcodeStream = null;
function startBarcodeCamera() {
  var container = document.getElementById('barcodeCameraContainer');
  var video = document.getElementById('barcodeVideo');
  container.style.display = 'block';
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(function(stream) {
      barcodeStream = stream;
      video.srcObject = stream;
      // Use BarcodeDetector API if available
      if ('BarcodeDetector' in window) {
        var detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] });
        var scanInterval = setInterval(function() {
          if (!barcodeStream) { clearInterval(scanInterval); return; }
          detector.detect(video).then(function(barcodes) {
            if (barcodes.length > 0) {
              document.getElementById('scanSkuInput').value = barcodes[0].rawValue;
              stopBarcodeCamera();
              clearInterval(scanInterval);
            }
          }).catch(function() {});
        }, 500);
      }
    })
    .catch(function(err) { alert('카메라 접근 실패: ' + err.message); container.style.display = 'none'; });
}
function stopBarcodeCamera() {
  if (barcodeStream) { barcodeStream.getTracks().forEach(function(t) { t.stop(); }); barcodeStream = null; }
  document.getElementById('barcodeCameraContainer').style.display = 'none';
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

    // 매출 요약 + 마스터 상품 로드
    loadSummaryCards();
    loadDashboardMasterProducts();
  } catch (err) {
    console.error('Dashboard load failed:', err);
  } finally {
    showLoading(false);
  }
}

async function loadSummaryCards() {
  try {
    // API 기반 실제 매출 + 시트 기반 분석 병렬 로드
    const [revenueRes, analysisRes] = await Promise.all([
      fetch(`${API}/revenue/summary`).catch(() => null),
      fetch(`${API}/analysis/summary`).catch(() => null),
    ]);

    const revenueData = revenueRes ? await revenueRes.json() : null;
    const analysisData = analysisRes ? await analysisRes.json() : null;

    if (revenueData && !revenueData.error) {
      renderRevenueSummaryCards(revenueData);
      renderDashboardPlatformRevenue(revenueData);
    } else if (analysisData && analysisData.byPlatform) {
      // fallback: 시트 기반
      renderOldSummaryCards(analysisData);
      renderDashboardPlatformRevenueOld(analysisData.byPlatform);
    }

    if (analysisData && !analysisData.error) {
      renderDashboardMarginSummary(analysisData);
    }
  } catch (e) {
    console.error('Summary load error:', e);
  }
}

function renderRevenueSummaryCards(data) {
  const container = document.getElementById('summaryCards');
  const platforms = data.platforms || {};
  const pNames = Object.keys(platforms);
  let successCount = 0;
  let failCount = 0;
  pNames.forEach(p => platforms[p].source === 'api' ? successCount++ : failCount++);

  container.innerHTML = `
    <div class="stat-card summary" style="border-color:#2196f3">
      <div class="label">총 매출 (API 기반)</div>
      <div class="number">${krw(data.totalRevenueKRW)}</div>
      <div class="sub">${data.totalOrders}건 주문 / ${data.period}</div>
    </div>
    ${pNames.map(name => {
      const p = platforms[name];
      const color = PLATFORM_COLORS[name] || '#888';
      const hasError = p.source === 'api_failed';
      return `
    <div class="stat-card summary" style="border-color:${color}">
      <div class="label">${name} 매출</div>
      <div class="number">${hasError ? '<span style="color:#999;font-size:14px">연결 실패</span>' :
        (p.currency === 'KRW' ? krw(p.revenue) : '$' + p.revenue.toLocaleString())}</div>
      <div class="sub">${hasError ? '' : p.orders + '건'}</div>
    </div>`;
    }).join('')}
  `;
}

function renderOldSummaryCards(data) {
  const container = document.getElementById('summaryCards');
  if (!data || data.error) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="stat-card summary" style="border-color:#2196f3">
      <div class="label">총 매출 (시트 기반)</div>
      <div class="number">${krw(data.totalRevenue)}</div>
      <div class="sub">${data.totalProducts}개 상품</div>
    </div>
    <div class="stat-card summary" style="border-color:${data.totalProfit >= 0 ? '#4caf50' : '#f44336'}">
      <div class="label">총 순이익</div>
      <div class="number">${krw(data.totalProfit)}</div>
      <div class="sub">평균 마진율 ${data.avgMargin}%</div>
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

// ===== 전체 상품 (인라인 편집 + 페이지네이션) =====

var _allProductSearchTimeout;
var _allProductPage = 1;

function setupAllProductSearch() {
  var searchEl = document.getElementById('allProductSearch');
  var filterEl = document.getElementById('allPlatformFilter');
  if (searchEl && !searchEl._bound) {
    searchEl._bound = true;
    searchEl.addEventListener('input', function() {
      clearTimeout(_allProductSearchTimeout);
      _allProductSearchTimeout = setTimeout(function() { _allProductPage = 1; loadAllProducts(); }, 300);
    });
  }
  if (filterEl && !filterEl._bound) {
    filterEl._bound = true;
    filterEl.addEventListener('change', function() { _allProductPage = 1; loadAllProducts(); });
  }
}

async function loadAllProducts(platform) {
  setupAllProductSearch();
  try {
    var pf = platform || document.getElementById('allPlatformFilter').value;
    var search = (document.getElementById('allProductSearch') ? document.getElementById('allProductSearch').value : '').trim();
    var sortEl = document.getElementById('allProductSort');
    var sortVal = sortEl ? sortEl.value : '';
    var url = API + '/products?limit=100&page=' + _allProductPage;
    if (pf) url += '&platform=' + pf;
    if (search) url += '&search=' + encodeURIComponent(search);
    if (sortVal) {
      var parts = sortVal.split('-');
      url += '&sort=' + parts[0] + '&dir=' + parts[1];
    }
    var resp = await fetch(url);
    var data = await resp.json();

    // 새 API 형식: { products, total, page, totalPages }
    var products = data.products || data;
    var total = data.total || products.length;
    var totalPages = data.totalPages || 1;

    renderEditableTable(products, 'allProductTable', 'allProductCount');

    // 총 건수 표시
    var countEl = document.getElementById('allProductCount');
    if (countEl) countEl.textContent = total + '개 상품 (페이지 ' + _allProductPage + '/' + totalPages + ')';

    // 페이지네이션 UI
    renderAllProductPagination(totalPages);
  } catch (err) {
    console.error('All products load failed:', err);
  }
}

function renderAllProductPagination(totalPages) {
  var container = document.getElementById('allProductPagination');
  if (!container) {
    var table = document.getElementById('allProductTable');
    if (!table) return;
    container = document.createElement('div');
    container.id = 'allProductPagination';
    container.style.cssText = 'display:flex;justify-content:center;gap:4px;margin-top:12px;flex-wrap:wrap';
    table.parentNode.insertBefore(container, table.nextSibling);
  }
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  var html = '';
  if (_allProductPage > 1) html += '<button onclick="_allProductPage=1;loadAllProducts()" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:11px">«</button>';
  if (_allProductPage > 1) html += '<button onclick="_allProductPage--;loadAllProducts()" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:11px">‹</button>';

  var start = Math.max(1, _allProductPage - 3);
  var end = Math.min(totalPages, _allProductPage + 3);
  for (var i = start; i <= end; i++) {
    var active = i === _allProductPage;
    html += '<button onclick="_allProductPage=' + i + ';loadAllProducts()" style="padding:4px 10px;border:1px solid ' + (active ? '#1565c0' : '#ddd') + ';border-radius:4px;background:' + (active ? '#1565c0' : '#fff') + ';color:' + (active ? '#fff' : '#333') + ';cursor:pointer;font-size:11px;font-weight:' + (active ? '700' : '400') + '">' + i + '</button>';
  }

  if (_allProductPage < totalPages) html += '<button onclick="_allProductPage++;loadAllProducts()" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:11px">›</button>';
  if (_allProductPage < totalPages) html += '<button onclick="_allProductPage=' + totalPages + ';loadAllProducts()" style="padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:11px">»</button>';

  container.innerHTML = html;
}

// ===== 매출/마진 분석 =====

async function loadAnalysis() {
  showLoading(true);
  try {
    const [summaryRes, productsRes, revenueRes] = await Promise.all([
      fetch(`${API}/analysis/summary`),
      fetch(`${API}/analysis/products?sort=${document.getElementById('analysisSortBy')?.value || 'margin'}&limit=50`),
      fetch(`${API}/revenue/summary`).catch(() => null)
    ]);
    const summary = await summaryRes.json();
    const products = await productsRes.json();
    const revenueData = revenueRes ? await revenueRes.json() : null;

    if (summary.error === 'no_data') {
      document.getElementById('analysisCards').innerHTML =
        '<div class="stat-card" style="grid-column:1/-1"><div class="empty">Google Sheets credentials.json이 필요합니다.<br>config/credentials.json에 Service Account 키를 넣어주세요.</div></div>';
      return;
    }

    renderAnalysisCards(summary);
    // 플랫폼별 매출: revenue/summary API 우선, 없으면 sheets byPlatform fallback
    if (revenueData && revenueData.platforms) {
      renderAnalysisPlatformRevenue(revenueData);
    } else {
      renderPlatformRevenue(summary.byPlatform || {});
    }
    renderMarginDistribution(products);
    renderAnalysisTable(products);

    // B2B 도매 매출 로드
    loadB2BAnalysisSection();
  } catch (err) {
    console.error('Analysis load failed:', err);
  } finally {
    showLoading(false);
  }
}

async function loadB2BAnalysisSection() {
  try {
    const [revRes, rankRes] = await Promise.all([
      fetch(`${API}/b2b/revenue`).then(r => r.json()),
      fetch(`${API}/b2b/revenue/ranking`).then(r => r.json()),
    ]);

    if (revRes.success) {
      document.getElementById('b2bAnTotalInvoices').textContent = revRes.totalInvoices || 0;
      document.getElementById('b2bAnTotalBuyers').textContent = revRes.totalBuyers || 0;

      const byCur = revRes.revenueByCurrency || [];
      const usd = byCur.find(c => c.currency === 'USD');
      const krwAmt = byCur.find(c => c.currency === 'KRW');
      document.getElementById('b2bAnUsdRevenue').textContent = usd
        ? '$' + usd.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })
        : '$0';
      document.getElementById('b2bAnKrwRevenue').textContent = krwAmt
        ? '\u20A9' + krwAmt.amount.toLocaleString('ko-KR')
        : '\u20A90';
    }

    if (rankRes.success) {
      const ranking = (rankRes.ranking || []).filter(r => r.totalRevenue > 0);
      const body = document.getElementById('b2bAnRankingBody');
      if (ranking.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="empty">데이터 없음</td></tr>';
      } else {
        body.innerHTML = ranking.map(r => {
          const sym = r.currency === 'KRW' ? '\u20A9' : '$';
          return `<tr>
            <td style="font-weight:700;color:#ff9800">${r.rank}</td>
            <td style="font-weight:600">${r.buyerName}</td>
            <td style="text-align:right">${r.totalOrders}</td>
            <td style="text-align:right;color:#27ae60;font-weight:700">${sym}${r.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td style="text-align:right">${sym}${r.avgOrderValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td style="font-size:11px;color:#666">${r.lastOrderDate || '-'}</td>
          </tr>`;
        }).join('');
      }
    }
  } catch (err) {
    console.error('B2B analysis section load failed:', err);
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

const PLATFORM_COLORS = {
  eBay: '#1565c0', Shopify: '#96bf48', Naver: '#03c75a',
  Alibaba: '#ff6a00', Shopee: '#ee4d2d'
};

function renderPlatformRevenueHTML(byPlatform, containerId) {
  const container = document.getElementById(containerId);
  const entries = Object.entries(byPlatform);
  if (entries.length === 0) {
    container.innerHTML = '<p class="empty">데이터 없음</p>';
    return;
  }

  const maxRevenue = Math.max(...entries.map(([, v]) => v.revenue), 1);
  const totalRevenue = entries.reduce((sum, [, v]) => sum + v.revenue, 0);

  container.innerHTML = entries.map(([name, v]) => {
    const color = PLATFORM_COLORS[name] || '#888';
    if (v.revenue === 0) {
      // 매출 데이터 없는 플랫폼
      return `
        <div class="revenue-bar" style="opacity:0.6">
          <div class="name">
            <span class="platform-dot" style="background:${color}"></span>
            ${esc(name)}
          </div>
          <div class="bar-wrap">
            <div class="bar" style="width:0%;background:${color}"></div>
          </div>
          <div class="amount-col">
            <div class="amount" style="color:#999">${v.count}개 리스팅</div>
            <div class="profit" style="color:#999">매출 데이터 없음</div>
          </div>
        </div>
      `;
    }
    const pct = maxRevenue > 0 ? (v.revenue / maxRevenue * 100) : 0;
    const sharePct = totalRevenue > 0 ? (v.revenue / totalRevenue * 100).toFixed(1) : 0;
    const profitColor = v.profit >= 0 ? '#2e7d32' : '#c62828';
    return `
      <div class="revenue-bar">
        <div class="name">
          <span class="platform-dot" style="background:${color}"></span>
          ${esc(name)}
        </div>
        <div class="bar-wrap">
          <div class="bar" style="width:${pct}%;background:${color}">
            <span>${v.count}개 (${sharePct}%)</span>
          </div>
        </div>
        <div class="amount-col">
          <div class="amount">${krw(v.revenue)}</div>
          <div class="profit" style="color:${profitColor}">${krw(v.profit)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPlatformRevenue(byPlatform) {
  renderPlatformRevenueHTML(byPlatform, 'platformRevenue');
}

function renderAnalysisPlatformRevenue(revenueData) {
  const container = document.getElementById('platformRevenue');
  if (!container) return;
  const platforms = revenueData.platforms || {};
  const entries = Object.entries(platforms);
  if (entries.length === 0) { container.innerHTML = '<p class="empty">데이터 없음</p>'; return; }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7); // "2026-03"

  const totalKRW = revenueData.totalRevenueKRW || 0;

  const cards = entries.map(([name, p]) => {
    const color = PLATFORM_COLORS[name] || '#888';
    const isFx = p.currency !== 'KRW';
    const fx = revenueData.exchangeRate || 1400;

    // 오늘 매출
    const todaySales = p.dailySales?.[today] || p.dailySales?.[yesterday] || null;
    const todayRev = todaySales ? todaySales.revenue : 0;
    const todayOrders = todaySales ? todaySales.orders : 0;
    const todayLabel = p.dailySales?.[today] ? '오늘' : (p.dailySales?.[yesterday] ? '어제' : '오늘');

    // 이번달 매출
    const monthRevenue = Object.entries(p.dailySales || {})
      .filter(([d]) => d.startsWith(thisMonth))
      .reduce((s, [, v]) => s + (v.revenue || 0), 0);
    const monthOrders = Object.entries(p.dailySales || {})
      .filter(([d]) => d.startsWith(thisMonth))
      .reduce((s, [, v]) => s + (v.orders || 0), 0);

    const fmt = (v) => isFx ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '₩' + Math.round(v).toLocaleString();
    const fmtKRW = (v) => { const k = Math.round(v); return k >= 10000 ? Math.round(k/10000) + '만원' : k.toLocaleString() + '원'; };
    const toKRW = (v) => isFx ? v * fx : v;

    const sharePct = totalKRW > 0 && p.revenueKRW > 0 ? (p.revenueKRW / totalKRW * 100).toFixed(1) : 0;

    return `<div class="revenue-bar" style="margin-bottom:12px;padding:10px 0;border-bottom:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
        <span style="font-weight:700;font-size:13px">${esc(name)}</span>
        <span style="font-size:10px;color:#888;margin-left:auto">${p.orders || 0}건 · 30일 점유 ${sharePct}%</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div style="background:#f8f9fa;border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:10px;color:#888;margin-bottom:2px">${todayLabel} 매출</div>
          <div style="font-size:14px;font-weight:700;color:${color}">${fmt(todayRev)}</div>
          <div style="font-size:10px;color:#aaa">${todayOrders}건</div>
        </div>
        <div style="background:#f8f9fa;border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:10px;color:#888;margin-bottom:2px">이번달 매출</div>
          <div style="font-size:14px;font-weight:700;color:${color}">${fmt(monthRevenue)}</div>
          <div style="font-size:10px;color:#aaa">${monthOrders}건 · ≈${fmtKRW(toKRW(monthRevenue))}</div>
        </div>
        <div style="background:#f8f9fa;border-radius:6px;padding:8px;text-align:center">
          <div style="font-size:10px;color:#888;margin-bottom:2px">30일 매출</div>
          <div style="font-size:14px;font-weight:700;color:${color}">${fmt(p.revenue || 0)}</div>
          <div style="font-size:10px;color:#aaa">≈${fmtKRW(p.revenueKRW || toKRW(p.revenue || 0))}</div>
        </div>
      </div>
    </div>`;
  });

  container.innerHTML = cards.join('');
}

// API 기반 매출 도넛 차트
function renderDashboardPlatformRevenue(revenueData) {
  const container = document.getElementById('dashboardPlatformRevenue');
  if (!container) return;

  const platforms = revenueData.platforms || {};
  const entries = Object.entries(platforms);
  if (entries.length === 0) {
    container.innerHTML = '<p class="empty">매출 데이터 없음</p>';
    return;
  }

  const withRevenue = entries.filter(([, v]) => (v.revenueKRW || 0) > 0);
  const withoutRevenue = entries.filter(([, v]) => (v.revenueKRW || 0) === 0);
  const totalKRW = revenueData.totalRevenueKRW || withRevenue.reduce((s, [, v]) => s + (v.revenueKRW || 0), 0);

  let html = '<div class="platform-donut-summary">';

  if (withRevenue.length > 0) {
    html += '<div class="donut-chart">';
    let gradientParts = [];
    let cumPct = 0;
    withRevenue.forEach(([name, v]) => {
      const pct = totalKRW > 0 ? (v.revenueKRW / totalKRW * 100) : 0;
      const color = PLATFORM_COLORS[name] || '#888';
      gradientParts.push(`${color} ${cumPct}% ${cumPct + pct}%`);
      cumPct += pct;
    });
    html += `<div class="donut" style="background:conic-gradient(${gradientParts.join(', ')})">`;
    html += `<div class="donut-hole"><div class="donut-total">${krw(totalKRW)}</div><div class="donut-label">실제 매출</div></div>`;
    html += '</div></div>';
  }

  html += '<div class="donut-legend">';
  withRevenue.forEach(([name, v]) => {
    const pct = totalKRW > 0 ? (v.revenueKRW / totalKRW * 100).toFixed(1) : 0;
    const color = PLATFORM_COLORS[name] || '#888';
    const display = v.currency === 'KRW' ? krw(v.revenue) : ('$' + v.revenue.toLocaleString());
    html += `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${esc(name)}</span>
      <span class="legend-pct">${pct}%</span>
      <span class="legend-amount">${display} (${v.orders}건)</span>
    </div>`;
  });
  withoutRevenue.forEach(([name, v]) => {
    const color = PLATFORM_COLORS[name] || '#888';
    html += `<div class="legend-item" style="opacity:0.6">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${esc(name)}</span>
      <span class="legend-pct">-</span>
      <span class="legend-amount" style="color:#999">${v.error ? 'API 연결 실패' : '데이터 없음'}</span>
    </div>`;
  });
  html += '</div></div>';

  container.innerHTML = html;
}

// 시트 기반 매출 fallback
function renderDashboardPlatformRevenueOld(byPlatform) {
  const container = document.getElementById('dashboardPlatformRevenue');
  if (!container) return;
  const entries = Object.entries(byPlatform);
  if (entries.length === 0) { container.innerHTML = '<p class="empty">데이터 없음</p>'; return; }
  const withRevenue = entries.filter(([, v]) => v.revenue > 0);
  const totalRevenue = withRevenue.reduce((sum, [, v]) => sum + v.revenue, 0);
  let html = '<div class="platform-donut-summary"><div class="donut-legend">';
  entries.forEach(([name, v]) => {
    const color = PLATFORM_COLORS[name] || '#888';
    html += `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      <span class="legend-name">${esc(name)}</span>
      <span class="legend-amount">${v.revenue > 0 ? krw(v.revenue) : v.count + '개'}</span>
    </div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function renderDashboardMarginSummary(data) {
  const container = document.getElementById('dashboardMarginSummary');
  if (!container || !data) return;

  const marginRate = parseFloat(data.avgMargin) || 0;
  const marginColor = marginRate >= 20 ? '#2e7d32' : marginRate >= 10 ? '#1565c0' : marginRate >= 5 ? '#e65100' : '#c62828';

  container.innerHTML = `
    <div class="margin-gauge">
      <div class="gauge-circle">
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="50" fill="none" stroke="#f0f2f5" stroke-width="10"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="${marginColor}" stroke-width="10"
            stroke-dasharray="${Math.min(marginRate, 100) * 3.14} 314"
            stroke-linecap="round" transform="rotate(-90 60 60)"/>
        </svg>
        <div class="gauge-value" style="color:${marginColor}">${marginRate}%</div>
        <div class="gauge-label">평균 마진율</div>
      </div>
      <div class="margin-details">
        <div class="margin-detail-item">
          <span class="detail-label">총 순이익</span>
          <span class="detail-value" style="color:${data.totalProfit >= 0 ? '#2e7d32' : '#c62828'}">${krw(data.totalProfit)}</span>
        </div>
        <div class="margin-detail-item">
          <span class="detail-label">효자상품 (20%+)</span>
          <span class="detail-value" style="color:#2e7d32">${data.highMarginCount || 0}개</span>
        </div>
        <div class="margin-detail-item">
          <span class="detail-label">마진 위험 (10%-)</span>
          <span class="detail-value" style="color:#e65100">${data.lowMarginCount || 0}개</span>
        </div>
        <div class="margin-detail-item">
          <span class="detail-label">역마진</span>
          <span class="detail-value" style="color:#c62828">${data.negativeMarginCount || 0}개</span>
        </div>
      </div>
    </div>
  `;
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
    renderOutOfStockTable(data.outOfStock || []);
    renderCompAnomalyTable(data.compAnomalies || []);
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
    <div class="anomaly-card" style="background:#c62828;color:#fff">
      <div class="number">${summary.outOfStock || 0}</div>
      <div class="label">품절 복구</div>
    </div>
    <div class="anomaly-card" style="background:#e65100;color:#fff">
      <div class="number">${summary.compAnomalies || 0}</div>
      <div class="label">경쟁사 이상</div>
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

function renderOutOfStockTable(items) {
  var tbody = document.getElementById('outOfStockTable');
  var countEl = document.getElementById('outOfStockCount');
  if (!tbody) return;
  if (countEl) countEl.textContent = items.length;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">품절 상품 없음</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(function(item) {
    return '<tr>' +
      '<td>' + esc(item.sku || item.itemId) + '</td>' +
      '<td title="' + esc(item.title) + '">' + esc(item.title) + '</td>' +
      '<td>' + (item.prevStock || 0) + '</td>' +
      '<td style="color:#c62828;font-weight:600">' + esc(item.status) + '</td>' +
      '<td><button onclick="restoreStock(\'' + esc(item.itemId) + '\',this)" style="background:#2e7d32;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">복구 (5개)</button></td>' +
      '</tr>';
  }).join('');
}

function renderCompAnomalyTable(items) {
  var tbody = document.getElementById('compAnomalyTable');
  var countEl = document.getElementById('compAnomalyCount');
  if (!tbody) return;
  if (countEl) countEl.textContent = items.length;
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">경쟁사 이상 없음</td></tr>';
    return;
  }
  var typeLabels = { ended: '리스팅 종료', price_crash: '가격 폭락', price_change: '가격 변동', title_change: '제목 변경' };
  var typeColors = { ended: '#c62828', price_crash: '#d84315', price_change: '#ff8f00', title_change: '#5c6bc0' };
  tbody.innerHTML = items.slice(0, 30).map(function(a) {
    var label = typeLabels[a.type] || a.type;
    var color = typeColors[a.type] || '#666';
    var detail = a.message || '';
    if (a.oldPrice && a.newPrice) detail = '$' + a.oldPrice.toFixed(2) + ' → $' + a.newPrice.toFixed(2);
    return '<tr>' +
      '<td>' + esc(a.sku) + '</td>' +
      '<td>' + esc(a.seller || '') + '</td>' +
      '<td><span style="color:' + color + ';font-weight:600;font-size:11px">' + label + '</span></td>' +
      '<td style="font-size:11px">' + esc(detail) + '</td>' +
      '<td>' + (a.type === 'ended' ? '<button onclick="battleDeleteCompetitor(\'' + esc(a.sku) + '\',\'' + esc(a.competitorId || '') + '\',this)" style="font-size:10px;padding:3px 8px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer">삭제</button>' : '') + '</td>' +
      '</tr>';
  }).join('');
}

async function restoreStock(itemId, btn) {
  if (!confirm('이 상품 재고를 5개로 복구하시겠습니까?')) return;
  btn.disabled = true;
  btn.textContent = '복구 중...';
  try {
    var r = await fetch(API + '/anomalies/restore-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: itemId, quantity: 5 })
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    btn.textContent = '완료';
    btn.style.background = '#666';
    btn.closest('tr').style.opacity = '0.4';
  } catch (e) {
    alert('복구 실패: ' + e.message);
    btn.disabled = false;
    btn.textContent = '복구 (5개)';
  }
}

async function restoreAllOutOfStock(btn) {
  var rows = document.querySelectorAll('#outOfStockTable tr button');
  if (rows.length === 0) { alert('복구할 상품이 없습니다'); return; }
  if (!confirm(rows.length + '개 상품 재고를 5개로 일괄 복구하시겠습니까?')) return;
  btn.disabled = true;
  btn.textContent = '복구 중...';
  var success = 0;
  for (var i = 0; i < rows.length; i++) {
    var itemBtn = rows[i];
    if (itemBtn.disabled) continue;
    var itemId = itemBtn.getAttribute('onclick').match(/'([^']+)'/)?.[1];
    if (!itemId) continue;
    try {
      var r = await fetch(API + '/anomalies/restore-stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: itemId, quantity: 5 })
      });
      var d = await r.json();
      if (d.success) { success++; itemBtn.textContent = '완료'; itemBtn.style.background = '#666'; itemBtn.closest('tr').style.opacity = '0.4'; }
    } catch (e) {}
  }
  alert(success + '개 상품 복구 완료');
  btn.disabled = false;
  btn.textContent = '일괄 복구 (재고 5)';
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
    // Load platform cards dynamically from registry
    const [historyRes, registryRes] = await Promise.all([
      fetch(`${API}/sync/history`),
      fetch(`${API}/platform-registry`).catch(() => null)
    ]);
    const history = await historyRes.json();
    renderSyncHistory(history, 'syncHistoryFull');

    // Render platform sync cards from registry
    const container = document.getElementById('syncPlatformCards');
    if (registryRes && registryRes.ok) {
      const registry = await registryRes.json();
      const platforms = registry.platforms || [];
      container.innerHTML = platforms.map(p => `
        <div class="sync-platform-card">
          <h4 style="color:${p.color || '#666'}">${p.display_name || p.name}</h4>
          <p>${p.name} → Supabase 동기화</p>
          <button class="sync-btn" data-platform="${p.key}">동기화 실행</button>
        </div>
      `).join('');
    } else {
      // Fallback to static platforms
      const fallback = ['eBay', 'Shopify', 'Naver', 'Alibaba', 'Shopee'];
      container.innerHTML = fallback.map(name => `
        <div class="sync-platform-card">
          <h4>${name}</h4>
          <p>${name} → Supabase 동기화</p>
          <button class="sync-btn" data-platform="${name.toLowerCase()}">동기화 실행</button>
        </div>
      `).join('');
    }

    // Re-bind sync buttons
    container.querySelectorAll('.sync-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const platform = btn.dataset.platform;
        btn.disabled = true;
        btn.textContent = '동기화 중...';
        try {
          await fetch(`${API}/sync/trigger/${platform}`, { method: 'POST' });
          btn.textContent = '완료!';
          setTimeout(() => { btn.textContent = '동기화 실행'; btn.disabled = false; }, 2000);
        } catch (e) {
          btn.textContent = '실패';
          setTimeout(() => { btn.textContent = '동기화 실행'; btn.disabled = false; }, 2000);
        }
      });
    });
  } catch (e) {
    console.error('loadSyncPage error:', e);
  }
}

// ===== 설정 페이지 =====

var settingsData = null;

async function loadSettingsPage() {
  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.settings-tab').forEach(t => { t.style.background = 'transparent'; t.style.color = '#666'; t.style.boxShadow = 'none'; });
      tab.style.background = '#fff'; tab.style.color = '#1a1a2e'; tab.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      document.querySelectorAll('.settings-tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active'); });
      const target = document.getElementById(tab.dataset.tab);
      if (target) { target.style.display = 'block'; target.classList.add('active'); }
    };
  });

  try {
    const res = await fetch(`${API}/platform-registry`);
    if (!res.ok) throw new Error('Failed to load registry');
    settingsData = await res.json();

    // Fill margin settings
    if (settingsData.settings) {
      for (const [key, val] of Object.entries(settingsData.settings)) {
        const input = document.getElementById(`setting-${key}`);
        if (input) input.value = val;
      }
    }

    // Fill platform list
    renderPlatformList(settingsData.platforms || []);
  } catch (e) {
    console.error('loadSettingsPage error:', e);
  }

  // Save button
  document.getElementById('saveMarginSettingsBtn').onclick = saveMarginSettings;

  // Simulation button
  document.getElementById('runSimulationBtn').onclick = runPriceSimulation;
}

function renderPlatformList(platforms) {
  const body = document.getElementById('platformListBody');
  document.getElementById('platformCount').textContent = platforms.length + '개';
  body.innerHTML = platforms.map(p => `
    <tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color || '#666'};margin-right:6px"></span>${p.display_name || p.name}</td>
      <td>${p.market_type === 'domestic' ? '국내' : '글로벌'}</td>
      <td>${((p.fee_rate || 0) * 100).toFixed(1)}%</td>
      <td>${p.currency || 'USD'}</td>
      <td><span class="status ${p.is_active ? 'connected' : 'disconnected'}">${p.is_active ? '활성' : '비활성'}</span></td>
      <td>${p.sort_order || 0}</td>
    </tr>
  `).join('');
}

async function saveMarginSettings() {
  const settingKeys = [
    'exchange_rate_usd', 'exchange_rate_jpy', 'exchange_rate_local',
    'default_margin_pct', 'tax_rate', 'default_shipping_usd', 'domestic_shipping_krw'
  ];

  const btn = document.getElementById('saveMarginSettingsBtn');
  btn.disabled = true;
  btn.textContent = '저장 중...';

  let success = 0;
  for (const key of settingKeys) {
    const input = document.getElementById(`setting-${key}`);
    if (!input) continue;
    try {
      const res = await fetch(`${API}/platform-registry/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parseFloat(input.value) })
      });
      if (res.ok) success++;
    } catch (e) {}
  }

  btn.textContent = `${success}개 저장 완료!`;
  btn.style.background = '#4caf50';
  setTimeout(() => { btn.textContent = '설정 저장'; btn.disabled = false; }, 2000);
}

async function runPriceSimulation() {
  const purchasePrice = parseFloat(document.getElementById('simPurchasePrice').value) || 0;
  const weight = parseFloat(document.getElementById('simWeight').value) || 0;

  if (purchasePrice <= 0) { alert('매입가를 입력하세요'); return; }

  try {
    const res = await fetch(`${API}/analysis/margin-calc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchasePrice, weight, targetMargin: parseFloat(document.getElementById('setting-default_margin_pct').value) || 30 })
    });
    const data = await res.json();
    const prices = data.prices || {};

    document.getElementById('simulationResult').style.display = 'block';
    const body = document.getElementById('simResultBody');
    body.innerHTML = Object.entries(prices).map(([key, p]) => {
      if (p.error) return `<tr><td>${key}</td><td colspan="5" style="color:#c62828">${p.error}</td></tr>`;
      return `<tr>
        <td><strong>${key}</strong></td>
        <td>${p.price?.toLocaleString()}</td>
        <td>${p.currency}</td>
        <td>${p.fee?.toLocaleString()} KRW</td>
        <td>${p.estimatedProfit?.toLocaleString()} KRW</td>
        <td>${p.margin}%</td>
      </tr>`;
    }).join('');
  } catch (e) {
    alert('시뮬레이션 실패: ' + e.message);
  }
}

// ===== 상품 내보내기 페이지 =====

async function loadExportPage() {
  // Tab switching
  document.querySelectorAll('.export-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.export-tab').forEach(t => { t.style.background = 'transparent'; t.style.color = '#666'; t.style.boxShadow = 'none'; });
      tab.style.background = '#fff'; tab.style.color = '#1a1a2e'; tab.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      document.querySelectorAll('.export-tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active'); });
      const target = document.getElementById(tab.dataset.tab);
      if (target) { target.style.display = 'block'; target.classList.add('active'); }
    };
  });

  // Load platform checkboxes
  try {
    const res = await fetch(`${API}/platform-registry`);
    if (res.ok) {
      const data = await res.json();
      const container = document.getElementById('exportPlatformCheckboxes');
      container.innerHTML = (data.platforms || []).map(p => `
        <label class="platform-checkbox" data-key="${p.key}" style="border-color:${p.color || '#ddd'}">
          <input type="checkbox" value="${p.key}">
          <span style="width:6px;height:6px;border-radius:50%;background:${p.color || '#666'}"></span>
          ${p.display_name || p.name}
        </label>
      `).join('');

      container.querySelectorAll('.platform-checkbox').forEach(label => {
        label.onclick = (e) => {
          if (e.target.tagName === 'INPUT') return;
          const cb = label.querySelector('input');
          cb.checked = !cb.checked;
          label.classList.toggle('checked', cb.checked);
        };
      });
    }
  } catch (e) {}

  // Export button
  document.getElementById('runExportBtn').onclick = runExport;

  // Export status
  document.getElementById('refreshExportStatus').onclick = loadExportStatus;

  // Translation search
  document.getElementById('translateSearchBtn').onclick = searchTranslation;
  document.getElementById('translateSkuSearch').onkeydown = (e) => { if (e.key === 'Enter') searchTranslation(); };
  document.getElementById('autoTranslateBtn').onclick = runAutoTranslate;
  document.getElementById('saveTranslateBtn').onclick = saveTranslation;
}

async function runExport() {
  const sku = document.getElementById('exportSku').value.trim();
  if (!sku) { alert('SKU를 입력하세요'); return; }

  const checked = document.querySelectorAll('#exportPlatformCheckboxes input:checked');
  const platforms = Array.from(checked).map(cb => cb.value);
  if (platforms.length === 0) { alert('플랫폼을 선택하세요'); return; }

  const progressDiv = document.getElementById('exportProgress');
  const logDiv = document.getElementById('exportLog');
  const bar = document.getElementById('exportProgressBar');
  const resultDiv = document.getElementById('exportResult');

  progressDiv.style.display = 'block';
  resultDiv.style.display = 'none';
  logDiv.innerHTML = '';
  bar.style.width = '10%';

  addExportLog(logDiv, `${sku} 상품을 ${platforms.join(', ')} 플랫폼에 내보내기 시작...`);
  bar.style.width = '30%';

  try {
    const res = await fetch(`${API}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, platforms })
    });
    const data = await res.json();
    bar.style.width = '100%';

    if (data.error) {
      addExportLog(logDiv, data.error, 'error');
    } else {
      const results = data.results || {};
      for (const [pf, r] of Object.entries(results)) {
        if (r.success) {
          addExportLog(logDiv, `${pf}: 등록 성공 (가격: ${r.price || '-'})`, 'success');
        } else {
          addExportLog(logDiv, `${pf}: 실패 - ${r.error || 'unknown'}`, 'error');
        }
      }
      resultDiv.style.display = 'block';
      const successCount = Object.values(results).filter(r => r.success).length;
      resultDiv.innerHTML = `<div class="card" style="background:#e8f5e9;border:1px solid #81c784">
        <strong>${successCount}/${platforms.length}</strong> 플랫폼 등록 완료
      </div>`;
    }
  } catch (e) {
    bar.style.width = '100%';
    bar.style.background = '#e53935';
    addExportLog(logDiv, '내보내기 오류: ' + e.message, 'error');
  }
}

function addExportLog(container, msg, type = '') {
  const line = document.createElement('div');
  line.className = `log-line ${type ? 'log-' + type : ''}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

async function loadExportStatus() {
  const body = document.getElementById('exportStatusBody');
  try {
    const filter = document.getElementById('exportStatusFilterSelect').value;
    const res = await fetch(`${API}/products/export-status?filter=${filter}`);
    if (!res.ok) { body.innerHTML = '<tr><td colspan="7">데이터 로드 실패</td></tr>'; return; }
    const data = await res.json();
    const items = data.items || [];
    body.innerHTML = items.length === 0
      ? '<tr><td colspan="7" style="text-align:center;color:#888">내보내기 이력 없음</td></tr>'
      : items.map(item => `<tr>
          <td>${item.sku || '-'}</td>
          <td>${item.title || '-'}</td>
          <td>${item.platform || '-'}</td>
          <td><span class="export-badge ${item.status}">${item.status}</span></td>
          <td>${item.price || '-'}</td>
          <td>${item.exported_at ? new Date(item.exported_at).toLocaleString() : '-'}</td>
          <td>${item.status === 'failed' ? `<button class="refresh-btn" style="font-size:10px;padding:2px 8px" onclick="retryExport('${item.sku}','${item.platform}')">재시도</button>` : ''}</td>
        </tr>`).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="7">오류 발생</td></tr>';
  }
}

async function retryExport(sku, platform) {
  try {
    await fetch(`${API}/export/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, platform })
    });
    loadExportStatus();
  } catch (e) {}
}

// ===== 번역 관리 =====

var currentTranslateProductId = null;

async function searchTranslation() {
  const sku = document.getElementById('translateSkuSearch').value.trim();
  if (!sku) return;
  const lang = document.getElementById('translateTargetLang').value;
  document.getElementById('transLangLabel').textContent = lang.toUpperCase();

  try {
    // Find product by SKU
    const productRes = await fetch(`${API}/master-products?sku=${encodeURIComponent(sku)}`);
    if (!productRes.ok) throw new Error('상품을 찾을 수 없습니다');
    const products = await productRes.json();
    const product = Array.isArray(products) ? products[0] : products;
    if (!product) throw new Error('상품을 찾을 수 없습니다');

    currentTranslateProductId = product.id;
    document.getElementById('transOrigTitle').value = product.title || product.productName || '';
    document.getElementById('transOrigDesc').value = product.description || '';

    // Try to load existing translation
    try {
      const transRes = await fetch(`${API}/translate/${product.id}?lang=${lang}`);
      if (transRes.ok) {
        const trans = await transRes.json();
        if (trans.translation) {
          document.getElementById('transTitle').value = trans.translation.title || '';
          document.getElementById('transDesc').value = trans.translation.description || '';
          document.getElementById('transKeywords').value = (trans.translation.keywords || []).join(', ');
        } else {
          document.getElementById('transTitle').value = '';
          document.getElementById('transDesc').value = '';
          document.getElementById('transKeywords').value = '';
        }
      }
    } catch (e) {
      document.getElementById('transTitle').value = '';
      document.getElementById('transDesc').value = '';
      document.getElementById('transKeywords').value = '';
    }

    document.getElementById('translateEditor').style.display = 'block';
  } catch (e) {
    alert(e.message);
  }
}

async function runAutoTranslate() {
  if (!currentTranslateProductId) return;
  const lang = document.getElementById('translateTargetLang').value;
  const btn = document.getElementById('autoTranslateBtn');
  btn.disabled = true;
  btn.textContent = 'AI 번역 중...';

  try {
    const res = await fetch(`${API}/translate/${currentTranslateProductId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLang: lang })
    });
    const data = await res.json();
    if (data.translation) {
      document.getElementById('transTitle').value = data.translation.title || '';
      document.getElementById('transDesc').value = data.translation.description || '';
      document.getElementById('transKeywords').value = (data.translation.keywords || []).join(', ');
    }
    btn.textContent = '번역 완료!';
    btn.style.background = '#4caf50';
    setTimeout(() => { btn.textContent = 'AI 번역'; btn.style.background = '#7c4dff'; btn.disabled = false; }, 2000);
  } catch (e) {
    btn.textContent = '번역 실패';
    setTimeout(() => { btn.textContent = 'AI 번역'; btn.style.background = '#7c4dff'; btn.disabled = false; }, 2000);
  }
}

async function saveTranslation() {
  if (!currentTranslateProductId) return;
  const lang = document.getElementById('translateTargetLang').value;
  const btn = document.getElementById('saveTranslateBtn');

  try {
    const res = await fetch(`${API}/translate/${currentTranslateProductId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLang: lang,
        title: document.getElementById('transTitle').value,
        description: document.getElementById('transDesc').value,
        keywords: document.getElementById('transKeywords').value.split(',').map(k => k.trim()).filter(Boolean)
      })
    });
    if (res.ok) {
      btn.textContent = '저장 완료!';
      setTimeout(() => { btn.textContent = '저장'; }, 2000);
    }
  } catch (e) {
    alert('저장 실패: ' + e.message);
  }
}

// ===== 상품 등록 (멀티마켓 자동 최적화) =====

var pricePreviewTimer = null;
var uploadedImageUrls = [];

function setupRegisterForm() {
  const form = document.getElementById('registerForm');
  if (form.dataset.initialized) return;
  form.dataset.initialized = 'true';

  // CSV 대량 등록 설정
  setupCsvImport();

  // 이미지 업로드 설정
  setupImageUpload();

  // 카테고리 검색 설정
  setupCategorySearch();

  // 실시간 가격 미리보기
  ['purchasePrice', 'weight', 'targetMargin', 'priceUSD'].forEach(name => {
    if (form.elements[name]) {
      form.elements[name].addEventListener('input', () => {
        clearTimeout(pricePreviewTimer);
        pricePreviewTimer = setTimeout(updatePricePreview, 400);
      });
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const resultEl = document.getElementById('registerResult');
    const submitBtn = form.querySelector('.submit-btn');

    submitBtn.disabled = true;
    submitBtn.textContent = '등록 중... (전체 마켓)';
    resultEl.className = 'register-result';
    resultEl.style.display = 'none';

    const formData = new FormData(form);
    const keywordsRaw = formData.get('keywords') || '';
    const keywords = keywordsRaw.split(',').map(k => k.trim()).filter(Boolean);

    const body = {
      sku: formData.get('sku'),
      title: formData.get('title'),
      titleEn: formData.get('titleEn'),
      description: formData.get('description'),
      descriptionEn: formData.get('descriptionEn'),
      keywords,
      condition: formData.get('condition'),
      quantity: formData.get('quantity'),
      purchasePrice: formData.get('purchasePrice'),
      weight: formData.get('weight'),
      targetMargin: formData.get('targetMargin'),
      priceUSD: formData.get('priceUSD') || undefined,
      imageUrls: uploadedImageUrls,
      ebayCategoryId: formData.get('ebayCategoryId') || undefined,
      naverCategoryId: formData.get('naverCategoryId') || undefined,
      shopifyProductType: formData.get('shopifyProductType') || undefined,
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
        if (r.ebay?.success) details.push(`eBay $${r.ebay.price} (ID: ${r.ebay.itemId || '-'})`);
        if (r.shopify?.success) details.push(`Shopify $${r.shopify.price} (ID: ${r.shopify.productId || '-'})`);
        if (r.naver?.success) details.push(`Naver ₩${(r.naver.price || 0).toLocaleString()} (No: ${r.naver.productNo || '-'})`);

        let warnings = [];
        if (r.ebay && !r.ebay.success && r.ebay.error) warnings.push('eBay: ' + r.ebay.error);
        if (r.shopify && !r.shopify.success && r.shopify.error) warnings.push('Shopify: ' + r.shopify.error);
        if (r.naver && !r.naver.success && r.naver.error) warnings.push('Naver: ' + r.naver.error);

        resultEl.className = 'register-result success';
        resultEl.innerHTML = `${esc(result.message)}` +
          (details.length > 0 ? `<br>성공: ${details.map(d => esc(d)).join(', ')}` : '') +
          (warnings.length > 0 ? `<br><span style="color:#ff9800">경고: ${warnings.map(w => esc(w)).join('; ')}</span>` : '');
        resultEl.style.display = 'block';
        form.reset();
        form.elements['targetMargin'].value = '30';
        form.elements['quantity'].value = '10';
        uploadedImageUrls = [];
        document.getElementById('imagePreviewList').innerHTML = '';
        document.getElementById('uploadPlaceholder').style.display = '';
        document.getElementById('marginPreview').style.display = 'none';
        document.getElementById('categoryResults').style.display = 'none';
      } else {
        resultEl.className = 'register-result error';
        resultEl.textContent = result.error || result.message || '등록 실패';
        resultEl.style.display = 'block';
      }
    } catch (err) {
      resultEl.className = 'register-result error';
      resultEl.textContent = '서버 오류: ' + err.message;
      resultEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '상품 등록 (전체 마켓)';
    }
  });
}

// ===== 이미지 업로드 =====

function setupImageUpload() {
  const area = document.getElementById('imageUploadArea');
  const fileInput = document.getElementById('imageFileInput');
  if (!area || !fileInput) return;

  area.addEventListener('click', () => fileInput.click());
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    handleImageFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => handleImageFiles(fileInput.files));
}

async function handleImageFiles(files) {
  if (!files || files.length === 0) return;
  if (uploadedImageUrls.length + files.length > 5) {
    alert('이미지는 최대 5장까지 업로드 가능합니다.');
    return;
  }

  const formData = new FormData();
  for (const file of files) {
    formData.append('images', file);
  }

  try {
    const res = await fetch(`${API}/uploads/images`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.urls) {
      uploadedImageUrls.push(...data.urls);
      renderImagePreviews();
    } else {
      alert(data.error || '업로드 실패');
    }
  } catch (err) {
    alert('이미지 업로드 오류: ' + err.message);
  }
}

function renderImagePreviews() {
  const list = document.getElementById('imagePreviewList');
  const placeholder = document.getElementById('uploadPlaceholder');
  list.innerHTML = uploadedImageUrls.map((url, i) => `
    <div class="image-preview-item">
      <img src="${url}" alt="상품 이미지 ${i + 1}">
      <button type="button" class="remove-img" onclick="removeImage(${i})">x</button>
    </div>
  `).join('');
  placeholder.style.display = uploadedImageUrls.length >= 5 ? 'none' : '';
}

function removeImage(idx) {
  uploadedImageUrls.splice(idx, 1);
  renderImagePreviews();
}

// ===== CSV 대량 등록 =====

var csvParsedRows = [];

function setupCsvImport() {
  // Register tab switching
  document.querySelectorAll('.register-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.register-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const isCSV = tab.dataset.tab === 'csv';
      document.getElementById('csvImportSection').style.display = isCSV ? '' : 'none';
      document.getElementById('registerForm').style.display = isCSV ? 'none' : '';
    });
  });

  // CSV file upload area
  const area = document.getElementById('csvUploadArea');
  const fileInput = document.getElementById('csvFileInput');
  if (!area || !fileInput) return;

  area.addEventListener('click', () => fileInput.click());
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleCsvFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleCsvFile(fileInput.files[0]);
  });

  // Template download
  const templateBtn = document.getElementById('csvTemplateBtn');
  if (templateBtn) {
    templateBtn.addEventListener('click', () => {
      window.location.href = `${API}/products/csv-template`;
    });
  }

  // Confirm button
  const confirmBtn = document.getElementById('csvConfirmBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => executeCsvImport());
  }
}

async function handleCsvFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    alert('CSV 또는 Excel 파일만 업로드 가능합니다 (.csv, .xlsx)');
    return;
  }

  // Show file name
  const placeholder = document.getElementById('csvUploadPlaceholder');
  const fileInfo = document.getElementById('csvFileName');
  placeholder.style.display = 'none';
  fileInfo.style.display = '';
  fileInfo.innerHTML = `<strong>${esc(file.name)}</strong> (${(file.size / 1024).toFixed(1)} KB) <button type="button" class="refresh-btn" style="font-size:11px;padding:3px 10px" onclick="resetCsvUpload()">다른 파일</button>`;

  // Upload and parse
  const formData = new FormData();
  formData.append('file', file);

  try {
    fileInfo.innerHTML += ' <span style="color:#888">파싱 중...</span>';
    const res = await fetch(`${API}/products/import-csv`, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || '파일 파싱 실패');
      resetCsvUpload();
      return;
    }

    csvParsedRows = data.validRows || [];
    renderCsvValidation(data);
  } catch (err) {
    alert('파일 업로드 오류: ' + err.message);
    resetCsvUpload();
  }
}

function renderCsvValidation(data) {
  // Show options
  document.getElementById('csvOptions').style.display = '';

  // Validation summary
  const summaryEl = document.getElementById('csvValidationSummary');
  summaryEl.style.display = '';
  document.getElementById('csvStatTotal').textContent = data.total;
  document.getElementById('csvStatValid').textContent = data.validCount;
  document.getElementById('csvStatError').textContent = data.errorCount;

  // Error list
  if (data.errors && data.errors.length > 0) {
    const errorEl = document.getElementById('csvErrorList');
    errorEl.style.display = '';
    const tbody = document.querySelector('#csvErrorTable tbody');
    tbody.innerHTML = data.errors.map(e =>
      `<tr><td>${e.row}</td><td>${esc(e.sku)}</td><td style="color:#c62828">${e.errors.join(', ')}</td></tr>`
    ).join('');
  }

  // Preview table
  if (data.preview && data.preview.length > 0) {
    const previewEl = document.getElementById('csvPreviewSection');
    previewEl.style.display = '';
    const tbody = document.querySelector('#csvPreviewTable tbody');
    tbody.innerHTML = data.preview.map(r => `
      <tr>
        <td><strong>${esc(r.sku)}</strong></td>
        <td>${esc(r.title)}</td>
        <td style="text-align:right">${(r.purchasePrice || 0).toLocaleString()}원</td>
        <td style="text-align:right">${r.weight || '-'}</td>
        <td>${esc(r.category || '-')}</td>
        <td style="text-align:right">${r.quantity || '-'}</td>
        <td style="text-align:right">${r.targetMargin !== null ? r.targetMargin + '%' : '-'}</td>
      </tr>
    `).join('');
  }

  // Show confirm button if there are valid rows
  if (data.validCount > 0) {
    document.getElementById('csvActionArea').style.display = '';
    document.getElementById('csvConfirmBtn').textContent = `대량 등록 실행 (${data.validCount}건)`;
  }
}

async function executeCsvImport() {
  if (csvParsedRows.length === 0) {
    alert('등록할 데이터가 없습니다.');
    return;
  }

  const confirmBtn = document.getElementById('csvConfirmBtn');
  const progressArea = document.getElementById('csvProgressArea');
  const progressFill = document.getElementById('csvProgressFill');
  const progressText = document.getElementById('csvProgressText');

  confirmBtn.disabled = true;
  confirmBtn.textContent = '등록 중...';
  progressArea.style.display = '';
  progressFill.style.width = '10%';
  progressText.textContent = `${csvParsedRows.length}건 등록 요청 중...`;

  const defaultMargin = parseFloat(document.getElementById('csvDefaultMargin').value) || 30;

  try {
    progressFill.style.width = '40%';
    const res = await fetch(`${API}/products/import-csv/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: csvParsedRows, defaultMargin }),
    });
    const data = await res.json();

    progressFill.style.width = '100%';

    if (!res.ok) {
      progressText.textContent = '오류: ' + (data.error || '등록 실패');
      confirmBtn.disabled = false;
      confirmBtn.textContent = '다시 시도';
      return;
    }

    progressText.textContent = '완료!';
    renderCsvResults(data);
  } catch (err) {
    progressText.textContent = '서버 오류: ' + err.message;
    confirmBtn.disabled = false;
    confirmBtn.textContent = '다시 시도';
  }
}

function renderCsvResults(data) {
  const resultArea = document.getElementById('csvResultArea');
  resultArea.style.display = '';

  const summaryEl = document.getElementById('csvResultSummary');
  const isAllSuccess = data.failed === 0;
  summaryEl.className = 'csv-result-summary ' + (isAllSuccess ? 'success' : 'partial');
  summaryEl.innerHTML = `
    전체 <strong>${data.total}</strong>건 |
    성공 <strong style="color:#2e7d32">${data.success}</strong>건 |
    실패 <strong style="color:#c62828">${data.failed}</strong>건
  `;

  const tbody = document.querySelector('#csvResultTable tbody');
  tbody.innerHTML = (data.results || []).map(r => {
    const statusClass = r.status === 'success' ? 'color:#2e7d32' : 'color:#c62828';
    const statusText = r.status === 'success' ? '성공' : '실패';
    return `<tr>
      <td><strong>${esc(r.sku)}</strong></td>
      <td>${esc(r.title || '-')}</td>
      <td style="${statusClass};font-weight:600">${statusText}${r.error ? ': ' + esc(r.error) : ''}</td>
      <td>${r.prices?.ebay || '-'}</td>
      <td>${r.prices?.shopify || '-'}</td>
      <td>${r.prices?.naver || '-'}</td>
    </tr>`;
  }).join('');
}

function resetCsvUpload() {
  csvParsedRows = [];
  document.getElementById('csvUploadPlaceholder').style.display = '';
  document.getElementById('csvFileName').style.display = 'none';
  document.getElementById('csvFileName').innerHTML = '';
  document.getElementById('csvFileInput').value = '';
  document.getElementById('csvOptions').style.display = 'none';
  document.getElementById('csvValidationSummary').style.display = 'none';
  document.getElementById('csvErrorList').style.display = 'none';
  document.getElementById('csvPreviewSection').style.display = 'none';
  document.getElementById('csvActionArea').style.display = 'none';
  document.getElementById('csvProgressArea').style.display = 'none';
  document.getElementById('csvResultArea').style.display = 'none';
  const confirmBtn = document.getElementById('csvConfirmBtn');
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = '대량 등록 실행'; }
}

// ===== 카테고리 검색 =====

function setupCategorySearch() {
  const btn = document.getElementById('categorySearchBtn');
  const input = document.getElementById('categorySearchInput');
  if (!btn || !input) return;

  btn.addEventListener('click', () => searchCategories());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchCategories(); } });
}

async function searchCategories() {
  const query = document.getElementById('categorySearchInput').value.trim();
  if (!query) return;

  const resultsEl = document.getElementById('categoryResults');
  const ebayEl = document.getElementById('ebayCategoryResults');
  const naverEl = document.getElementById('naverCategoryResults');

  ebayEl.innerHTML = '<span class="empty-cat">검색 중...</span>';
  naverEl.innerHTML = '<span class="empty-cat">검색 중...</span>';
  resultsEl.style.display = 'block';

  try {
    const res = await fetch(`${API}/categories/search?platform=all&query=${encodeURIComponent(query)}`);
    const data = await res.json();
    const cats = data.categories || {};

    // eBay 결과
    if (cats.ebay && cats.ebay.length > 0) {
      ebayEl.innerHTML = cats.ebay.slice(0, 8).map((c, i) => `
        <label>
          <input type="radio" name="ebayCatRadio" value="${esc(c.id)}" ${i === 0 ? 'checked' : ''}
            onchange="document.getElementById('ebayCategoryId').value=this.value">
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-id">(${esc(c.id)})</span>
        </label>
      `).join('');
      document.getElementById('ebayCategoryId').value = cats.ebay[0].id;
    } else {
      ebayEl.innerHTML = '<span class="empty-cat">eBay 카테고리 없음 (영문으로 검색해보세요)</span>';
    }

    // Naver 결과
    if (cats.naver && cats.naver.length > 0) {
      naverEl.innerHTML = cats.naver.slice(0, 8).map((c, i) => `
        <label>
          <input type="radio" name="naverCatRadio" value="${esc(c.id)}" ${i === 0 ? 'checked' : ''}
            onchange="document.getElementById('naverCategoryId').value=this.value">
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-id">(${esc(c.id)})</span>
        </label>
      `).join('');
      document.getElementById('naverCategoryId').value = cats.naver[0].id;
    } else {
      naverEl.innerHTML = '<span class="empty-cat">네이버 카테고리 없음 (한국어로 검색해보세요)</span>';
    }
  } catch (err) {
    ebayEl.innerHTML = `<span class="empty-cat">검색 오류: ${esc(err.message)}</span>`;
    naverEl.innerHTML = `<span class="empty-cat">검색 오류: ${esc(err.message)}</span>`;
  }
}

async function updatePricePreview() {
  const form = document.getElementById('registerForm');
  const purchase = parseFloat(form.elements['purchasePrice'].value) || 0;
  const weight = parseFloat(form.elements['weight'].value) || 0;
  const margin = parseFloat(form.elements['targetMargin'].value) || 30;
  const manualPrice = parseFloat(form.elements['priceUSD'].value) || 0;
  const previewEl = document.getElementById('marginPreview');
  const grid = document.getElementById('pricePreviewGrid');

  if (purchase <= 0) {
    previewEl.style.display = 'none';
    return;
  }

  // 수동 가격 입력 시 단순 마진 계산
  if (manualPrice > 0) {
    const shipping = 3.9;
    const settlement = (manualPrice + shipping) * 0.82 * 1400;
    const tax = purchase * 0.15;
    const profit = settlement - purchase - tax;
    const actualMargin = settlement > 0 ? (profit / settlement * 100) : 0;
    grid.innerHTML = `
      <div class="price-preview-card">
        <div class="platform-name">eBay (수동 가격)</div>
        <div class="platform-price">$${manualPrice.toFixed(2)}</div>
        <div class="platform-detail">+ $${shipping} 배송비</div>
        <div class="platform-profit ${profit >= 0 ? 'positive' : 'negative'}">
          이익 ${krw(Math.round(profit))} (${actualMargin.toFixed(1)}%)
        </div>
      </div>
      <div class="price-preview-card">
        <div class="platform-name">Shopify (수동 가격)</div>
        <div class="platform-price">$${manualPrice.toFixed(2)}</div>
        <div class="platform-detail">+ $${shipping} 배송비</div>
      </div>
      <div class="price-preview-card">
        <div class="platform-name">Naver (자동 변환)</div>
        <div class="platform-price">₩${Math.round(manualPrice * 1400).toLocaleString()}</div>
        <div class="platform-detail">무료배송</div>
      </div>`;
    previewEl.style.display = 'block';
    return;
  }

  // API로 자동 가격 계산
  try {
    const params = new URLSearchParams({ purchasePrice: purchase, weight, targetMargin: margin });
    const res = await fetch(`${API}/products/preview-prices?${params}`);
    const data = await res.json();
    const p = data.prices;

    grid.innerHTML = ['ebay', 'shopify', 'naver'].map(platform => {
      const d = p[platform];
      if (!d || d.error) {
        return `<div class="price-preview-card error">
          <div class="platform-name">${platform.charAt(0).toUpperCase() + platform.slice(1)}</div>
          <div class="platform-price" style="color:#ff4d4f">-</div>
          <div class="platform-detail">${d?.error || '계산 불가'}</div>
        </div>`;
      }
      const symbol = d.currency === 'KRW' ? '₩' : '$';
      const priceStr = d.currency === 'KRW' ? d.price.toLocaleString() : d.price.toFixed(2);
      const shippingStr = d.shipping > 0
        ? `+ ${symbol}${d.currency === 'KRW' ? d.shipping.toLocaleString() : d.shipping.toFixed(2)} 배송비`
        : '무료배송';
      return `<div class="price-preview-card">
        <div class="platform-name">${platform.charAt(0).toUpperCase() + platform.slice(1)}</div>
        <div class="platform-price">${symbol}${priceStr}</div>
        <div class="platform-detail">${shippingStr}</div>
        <div class="platform-profit ${d.estimatedProfit >= 0 ? 'positive' : 'negative'}">
          이익 ${krw(d.estimatedProfit)} (${d.margin}%)
        </div>
      </div>`;
    }).join('');
    previewEl.style.display = 'block';
  } catch (err) {
    console.error('Price preview failed:', err);
  }
}

// ===== 마스터 상품 =====

async function loadMasterProducts(page = 1) {
  const search = document.getElementById('masterSearch')?.value || '';
  try {
    const params = new URLSearchParams({ page, limit: 30, search });
    const res = await fetch(`${API}/master-products?${params}`);
    const data = await res.json();
    renderMasterProducts(data.products || [], data);

    // 검색 이벤트 (최초 1회)
    const searchEl = document.getElementById('masterSearch');
    if (searchEl && !searchEl.dataset.initialized) {
      searchEl.dataset.initialized = 'true';
      let timer;
      searchEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => loadMasterProducts(1), 300);
      });
    }
    const refreshBtn = document.getElementById('masterRefreshBtn');
    if (refreshBtn && !refreshBtn.dataset.initialized) {
      refreshBtn.dataset.initialized = 'true';
      refreshBtn.addEventListener('click', () => loadMasterProducts(1));
    }
  } catch (err) {
    console.error('Master products load failed:', err);
  }
}

function renderMasterProducts(products, meta) {
  const tbody = document.getElementById('masterProductsBody');
  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:#999">등록된 마스터 상품이 없습니다</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const ebay = p.platforms?.ebay;
    const shopify = p.platforms?.shopify;
    const naver = p.platforms?.naver;
    return `<tr>
      <td><strong>${esc(p.sku)}</strong></td>
      <td title="${esc(p.titleEn || '')}">${esc(p.title)}</td>
      <td>${krw(p.purchasePrice)}</td>
      <td>${p.targetMargin}%</td>
      <td>${ebay?.status === 'active'
        ? `<span class="platform-badge active">$${ebay.price}</span>`
        : '<span class="platform-badge none">-</span>'}</td>
      <td>${shopify?.status === 'active'
        ? `<span class="platform-badge active">$${shopify.price}</span>`
        : '<span class="platform-badge none">-</span>'}</td>
      <td>${naver?.status === 'active'
        ? `<span class="platform-badge active">₩${(naver.price || 0).toLocaleString()}</span>`
        : '<span class="platform-badge none">-</span>'}</td>
      <td style="font-size:11px;color:#888">${p.createdAt ? new Date(p.createdAt).toLocaleDateString('ko') : '-'}</td>
    </tr>`;
  }).join('');

  // 페이지네이션
  const pagEl = document.getElementById('masterProductsPagination');
  if (meta && meta.totalPages > 1) {
    let html = '';
    for (let i = 1; i <= meta.totalPages; i++) {
      html += `<button onclick="loadMasterProducts(${i})" style="margin:2px;padding:4px 10px;border:1px solid #ddd;border-radius:4px;cursor:pointer;${i === meta.page ? 'background:#1a1a2e;color:#fff' : ''}">${i}</button>`;
    }
    pagEl.innerHTML = html;
  } else {
    pagEl.innerHTML = '';
  }
}

// ===== 대시보드 마스터 상품 요약 =====

async function loadDashboardMasterProducts() {
  try {
    const res = await fetch(`${API}/master-products?limit=10`);
    const data = await res.json();
    const products = data.products || [];
    const total = data.total || 0;

    // 요약 카드
    const statsEl = document.getElementById('masterStatsCards');
    const registered = products.filter(p => Object.keys(p.platforms || {}).length > 0).length;
    const avgMargin = total > 0
      ? (products.reduce((s, p) => s + (p.targetMargin || 0), 0) / products.length).toFixed(1)
      : 0;
    const platformCount = products.reduce((s, p) => s + Object.keys(p.platforms || {}).length, 0);

    statsEl.innerHTML = `
      <div class="stat-card"><div class="platform">전체 상품</div><div class="number">${total}</div></div>
      <div class="stat-card"><div class="platform">마켓 등록</div><div class="number">${platformCount}</div></div>
      <div class="stat-card"><div class="platform">평균 마진</div><div class="number">${avgMargin}%</div></div>
    `;

    // 테이블
    const tbody = document.getElementById('dashboardMasterBody');
    if (products.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">등록된 마스터 상품이 없습니다. 상품 등록에서 추가하세요.</td></tr>';
      return;
    }

    tbody.innerHTML = products.map(p => {
      const eb = p.platforms?.ebay;
      const sh = p.platforms?.shopify;
      const nv = p.platforms?.naver;
      return `<tr>
        <td><strong>${esc(p.sku)}</strong></td>
        <td title="${esc(p.titleEn || '')}">${esc((p.title || '').substring(0, 25))}</td>
        <td>${krw(p.purchasePrice)}</td>
        <td>${eb?.status === 'active' ? `<span class="platform-badge active">$${eb.price}</span>` : '<span class="platform-badge none">-</span>'}</td>
        <td>${sh?.status === 'active' ? `<span class="platform-badge active">$${sh.price}</span>` : '<span class="platform-badge none">-</span>'}</td>
        <td>${nv?.status === 'active' ? `<span class="platform-badge active">₩${(nv.price||0).toLocaleString()}</span>` : '<span class="platform-badge none">-</span>'}</td>
        <td>${p.targetMargin}%</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('Dashboard master products load failed:', err);
    const tbody = document.getElementById('dashboardMasterBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty">로드 실패</td></tr>';
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
async function endEbayListing(itemId, btn) {
  if (!confirm('이 eBay 리스팅을 종료(End)하시겠습니까?\nItem ID: ' + itemId + '\n\n종료하면 eBay에서 더 이상 판매되지 않습니다.')) return;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    var r = await fetch(API + '/products/ebay/' + itemId, { method: 'DELETE' });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    btn.textContent = '종료됨';
    btn.style.background = '#666';
    btn.closest('tr').style.opacity = '0.4';
  } catch (e) {
    alert('End Listing 실패: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'End';
  }
}

function renderEditableTable(products, tableId, countId) {
  const tbody = document.getElementById(tableId || 'allProductTable');
  const countEl = document.getElementById(countId || 'allProductCount');
  countEl.textContent = `(${products.length}개)`;

  if (products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">상품 없음</td></tr>';
    return;
  }

  tbody.innerHTML = products.map(p => {
    const pf = p.platform || '';
    const pfLower = pf.toLowerCase();
    const priceVal = p.price || '';
    const shipVal = p.shipping || '';
    const qtyVal = p.quantity !== undefined && p.quantity !== '' ? p.quantity : '';
    const step = pf === 'Naver' ? '1' : '0.01';

    var titleHtml = p.itemId ? '<a href="https://www.ebay.com/itm/' + esc(p.itemId) + '" target="_blank" style="color:#1565c0;text-decoration:none">' + esc(p.title) + ' ↗</a>' : esc(p.title);
    return `
    <tr data-platform="${esc(pf)}" data-edit-id="${esc(p.editId || '')}" data-sku="${esc(p.sku || '')}">
      <td>${esc(p.sku)}</td>
      <td title="${esc(p.title)}">${titleHtml}</td>
      <td><span class="badge ${pfLower}">${pf}</span></td>
      <td><input type="number" class="inline-input" data-field="price" value="${esc(String(priceVal))}" data-original="${esc(String(priceVal))}" step="${step}" placeholder="가격"></td>
      <td style="text-align:center;font-size:12px;color:#666">${shipVal ? (pf === 'Naver' ? '₩' + Number(shipVal).toLocaleString() : '$' + shipVal) : '-'}</td>
      <td><input type="number" class="inline-input" data-field="quantity" value="${esc(String(qtyVal))}" data-original="${esc(String(qtyVal))}" step="1" placeholder="재고"></td>
      <td class="save-cell"><span class="save-status"></span></td>
      <td>${pfLower === 'ebay' && p.editId ? '<button onclick="endEbayListing(\'' + esc(p.editId) + '\', this)" style="font-size:10px;padding:2px 8px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer" title="eBay 리스팅 종료">End</button>' : ''}</td>
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

// ===== eBay 트렌드 =====

async function loadEbayTrends() {
  const statsEl = document.getElementById('ebayTrendStats');
  const chartEl = document.getElementById('ebayDailyChart');
  const weeklyEl = document.getElementById('ebayWeeklyCompare');
  const topEl = document.getElementById('ebayTopItemsTable');
  const trendingEl = document.getElementById('ebayTrendingTable');

  if (statsEl) statsEl.innerHTML = '<div class="stat-card"><div class="label">로딩 중...</div></div>';

  try {
    const res = await fetch(`${API}/ebay/trends?days=30`);
    const data = await res.json();

    if (data.error) {
      if (statsEl) statsEl.innerHTML = `<div class="stat-card"><div class="label">eBay API 오류</div><div class="sub">${esc(data.error)}</div></div>`;
      return;
    }

    // 요약 카드
    if (statsEl) {
      const recent = data.recentStats?.last7days || {};
      const prev = data.recentStats?.prev7days || {};
      const change = prev.revenue > 0 ? ((recent.revenue - prev.revenue) / prev.revenue * 100).toFixed(1) : '-';
      const changeColor = parseFloat(change) >= 0 ? '#2e7d32' : '#c62828';
      const changeSign = parseFloat(change) >= 0 ? '+' : '';

      statsEl.innerHTML = `
        <div class="stat-card summary" style="border-color:#e53935">
          <div class="label">30일 총 매출</div>
          <div class="number">$${data.totalRevenue?.toLocaleString() || 0}</div>
          <div class="sub">${data.totalOrders || 0}건</div>
        </div>
        <div class="stat-card summary" style="border-color:#1565c0">
          <div class="label">최근 7일</div>
          <div class="number">$${recent.revenue?.toFixed(0) || 0}</div>
          <div class="sub">${recent.orders || 0}건</div>
        </div>
        <div class="stat-card summary" style="border-color:#ff8f00">
          <div class="label">이전 7일</div>
          <div class="number">$${prev.revenue?.toFixed(0) || 0}</div>
          <div class="sub">${prev.orders || 0}건</div>
        </div>
        <div class="stat-card summary" style="border-color:${changeColor}">
          <div class="label">주간 변동</div>
          <div class="number" style="color:${changeColor}">${change !== '-' ? changeSign + change + '%' : '-'}</div>
          <div class="sub">매출 기준</div>
        </div>
      `;
    }

    // 일별 차트 (CSS 바 차트)
    if (chartEl) {
      const days = data.dailySales || [];
      if (days.length === 0) {
        chartEl.innerHTML = '<p class="empty">판매 데이터 없음</p>';
      } else {
        const maxRev = Math.max(...days.map(d => d.revenue), 1);
        chartEl.innerHTML = `<div class="bar-chart">
          ${days.map(d => {
            const pct = (d.revenue / maxRev * 100).toFixed(1);
            const dateLabel = d.date.slice(5); // MM-DD
            return `<div class="bar-col">
              <div class="bar-value">$${d.revenue.toFixed(0)}</div>
              <div class="bar-fill" style="height:${pct}%;background:#e53935"></div>
              <div class="bar-label">${dateLabel}</div>
              <div class="bar-orders">${d.orders}건</div>
            </div>`;
          }).join('')}
        </div>`;
      }
    }

    // 주간 비교
    if (weeklyEl) {
      const recent = data.recentStats?.last7days || {};
      const prev = data.recentStats?.prev7days || {};
      weeklyEl.innerHTML = `
        <div class="weekly-compare">
          <div class="week-block">
            <div class="week-title">최근 7일</div>
            <div class="week-revenue">$${(recent.revenue || 0).toFixed(0)}</div>
            <div class="week-orders">${recent.orders || 0}건 주문</div>
          </div>
          <div class="week-arrow">${recent.revenue >= prev.revenue ? '&#9650;' : '&#9660;'}</div>
          <div class="week-block">
            <div class="week-title">이전 7일</div>
            <div class="week-revenue">$${(prev.revenue || 0).toFixed(0)}</div>
            <div class="week-orders">${prev.orders || 0}건 주문</div>
          </div>
        </div>
      `;
    }

    // 인기 상품 TOP 20
    if (topEl) {
      const items = data.topItems || [];
      topEl.innerHTML = items.length === 0
        ? '<tr><td colspan="5" class="empty">판매 데이터 없음</td></tr>'
        : items.map((item, i) => `<tr>
            <td>${i + 1}</td>
            <td title="${esc(item.title)}">${esc(item.title?.slice(0, 50))}${item.title?.length > 50 ? '...' : ''}</td>
            <td>${esc(item.sku || '-')}</td>
            <td><strong>${item.totalSold}</strong></td>
            <td>$${item.totalRevenue?.toFixed(2)}</td>
          </tr>`).join('');
    }

    // 최근 7일 트렌딩
    if (trendingEl) {
      const items = data.trending || [];
      trendingEl.innerHTML = items.length === 0
        ? '<tr><td colspan="4" class="empty">최근 판매 없음</td></tr>'
        : items.map((item, i) => `<tr>
            <td>${i + 1}</td>
            <td title="${esc(item.title)}">${esc(item.title?.slice(0, 50))}${item.title?.length > 50 ? '...' : ''}</td>
            <td><strong>${item.sold}</strong></td>
            <td>$${item.revenue?.toFixed(2)}</td>
          </tr>`).join('');
    }

  } catch (err) {
    console.error('eBay trends error:', err);
    if (statsEl) statsEl.innerHTML = '<div class="stat-card"><div class="label">로드 실패</div></div>';
  }
}

// 모달 외부 클릭시 닫기 (모달은 남겨둠)
function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
}
var _editModal = document.getElementById('editModal');
if (_editModal) _editModal.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeEditModal();
});

// ===== SKU 점수 관리 =====

var skuScoreEventsInit = false;

async function loadSkuScores() {
  showLoading(true);
  try {
    const classFilter = document.getElementById('skuClassFilter')?.value || '';
    const search = document.getElementById('skuScoreSearch')?.value || '';
    const params = new URLSearchParams();
    if (classFilter) params.set('classification', classFilter);
    if (search) params.set('search', search);
    params.set('limit', '200');

    const res = await fetch(`${API}/sku-scores?${params}`);
    const data = await res.json();

    renderSkuScoreStats(data.summary);
    renderSkuScoreTable(data.scores || []);
    renderClassDistribution(data.summary?.byClassification || {});
    loadRetirementCandidates();

    if (data.lastUpdated) {
      updateLastUpdated(data.lastUpdated);
    }

    if (!skuScoreEventsInit) {
      setupSkuScoreEvents();
      skuScoreEventsInit = true;
    }
  } catch (err) {
    console.error('SKU scores load failed:', err);
  } finally {
    showLoading(false);
  }
}

function renderSkuScoreStats(summary) {
  const el = document.getElementById('skuScoreStats');
  if (!summary) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="stat-card summary" style="border-left:4px solid #2196f3">
      <div class="label">전체 SKU</div>
      <div class="number">${summary.total || 0}</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #4caf50">
      <div class="label">평균 점수</div>
      <div class="number">${(summary.avgScore || 0).toFixed(1)}</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #1565c0">
      <div class="label">A등급 (공격확장)</div>
      <div class="number" style="color:#1565c0">${summary.byClassification?.A || 0}</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #f44336">
      <div class="label">D등급 (매입금지)</div>
      <div class="number" style="color:#c62828">${summary.byClassification?.D || 0}</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #ff9800">
      <div class="label">퇴출 대상</div>
      <div class="number" style="color:#e65100">${summary.retirementCandidates || 0}</div>
    </div>
  `;
}

function renderSkuScoreTable(scores) {
  const tbody = document.getElementById('skuScoreTable');
  const countEl = document.getElementById('skuScoreCount');
  countEl.textContent = `(${scores.length}개)`;

  if (scores.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty">데이터 없음 — 재계산 버튼을 클릭하세요</td></tr>';
    return;
  }

  const classColors = { A: '#1565c0', B: '#4caf50', C: '#ff9800', D: '#f44336' };
  const classLabels = { A: '공격확장', B: '마진관리', C: '관찰', D: '매입금지' };

  tbody.innerHTML = scores.map(s => {
    const cls = s.classification || '-';
    const color = classColors[cls] || '#999';

    const scoreCell = (cat) => {
      if (!cat || cat.points === null || cat.points === undefined) return '<span style="color:#ccc">-</span>';
      const pct = cat.max > 0 ? cat.points / cat.max : 0;
      const cellColor = pct >= 0.7 ? '#2e7d32' : pct >= 0.4 ? '#e65100' : '#c62828';
      return `<span style="color:${cellColor};font-weight:600">${cat.points}</span>`;
    };

    const purchaseBadge = s.purchaseDecision?.allowed
      ? '<span class="margin-badge good">매입OK</span>'
      : '<span class="margin-badge danger">NO</span>';

    const hasRetirement = s.autoRetirement?.actions?.length > 0;
    const retirement = hasRetirement
      ? '<span class="margin-badge danger">퇴출대상</span>'
      : '<span style="color:#ccc;font-size:11px">정상</span>';

    const sku = s.sku || '';
    const title = (s.title || '').substring(0, 25);

    return `<tr onclick="openSkuScoreDetail('${sku.replace(/'/g, "\\'")}')" style="cursor:pointer">
      <td><strong style="font-size:11px">${sku}</strong></td>
      <td style="font-size:11px" title="${s.title || ''}">${title}</td>
      <td style="font-weight:700;font-size:15px;color:${color}">${s.normalizedScore?.toFixed(0) || '-'}</td>
      <td><span class="class-badge ${cls}" style="background:${color}18;color:${color}">${cls} ${classLabels[cls] || ''}</span></td>
      <td>${scoreCell(s.scores?.netMargin)}</td>
      <td>${scoreCell(s.scores?.turnover)}</td>
      <td>${scoreCell(s.scores?.competition)}</td>
      <td>${scoreCell(s.scores?.shippingEfficiency)}</td>
      <td>${scoreCell(s.scores?.priceStability)}</td>
      <td>${purchaseBadge}</td>
      <td>${retirement}</td>
    </tr>`;
  }).join('');
}

function renderClassDistribution(byClass) {
  const container = document.getElementById('skuClassDistribution');
  const classConfig = [
    { key: 'A', label: 'A — 공격 확장 (80+)', color: '#1565c0' },
    { key: 'B', label: 'B — 마진 관리 (65-79)', color: '#4caf50' },
    { key: 'C', label: 'C — 관찰 (50-64)', color: '#ff9800' },
    { key: 'D', label: 'D — 매입금지 (<50)', color: '#f44336' },
  ];
  const total = Object.values(byClass).reduce((s, v) => s + v, 0) || 1;
  const maxCount = Math.max(...Object.values(byClass), 1);

  container.innerHTML = classConfig.map(c => {
    const count = byClass[c.key] || 0;
    const pct = (count / total * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5">
      <div style="width:180px;font-size:12px;font-weight:600;color:${c.color}">${c.label}</div>
      <div style="flex:1;height:20px;background:#f0f2f5;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${count/maxCount*100}%;background:${c.color};border-radius:4px;transition:width 0.3s"></div>
      </div>
      <div style="width:70px;text-align:right;font-size:12px;font-weight:600">${count} (${pct}%)</div>
    </div>`;
  }).join('');
}

async function loadRetirementCandidates() {
  try {
    const res = await fetch(`${API}/sku-scores/retirement`);
    const data = await res.json();
    const countEl = document.getElementById('retirementCount');
    countEl.textContent = data.actions?.length || 0;

    const tbody = document.getElementById('retirementTable');
    const actions = data.actions || [];

    if (actions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">퇴출 대상 없음</td></tr>';
      return;
    }

    const actionLabels = { price_increase_5pct: '가격 +5%', deactivate: '비활성화', margin_review: '마진 검토' };
    const actionColors = { price_increase_5pct: '#ff9800', deactivate: '#f44336', margin_review: '#2196f3' };

    tbody.innerHTML = actions.map(a => `<tr>
      <td><strong style="font-size:11px">${a.sku}</strong></td>
      <td><span class="margin-badge" style="background:${actionColors[a.action]}18;color:${actionColors[a.action]}">${actionLabels[a.action] || a.action}</span></td>
      <td style="font-size:11px">${a.reason || ''}</td>
      <td><button class="sync-btn" onclick="event.stopPropagation();executeRetirement('${a.sku}','${a.action}')">실행</button></td>
    </tr>`).join('');
  } catch (err) {
    console.error('Retirement load failed:', err);
  }
}

async function openSkuScoreDetail(sku) {
  try {
    const res = await fetch(`${API}/sku-scores/${encodeURIComponent(sku)}`);
    const data = await res.json();
    if (!data.scores) return;

    const s = data.scores;
    const detail = document.getElementById('skuScoreDetail');
    const classColors = { A: '#1565c0', B: '#4caf50', C: '#ff9800', D: '#f44336' };
    const color = classColors[s.classification] || '#999';

    // 점수 막대 그래프
    const categories = [
      { key: 'netMargin', label: '순마진', max: 30, color: '#2196f3' },
      { key: 'turnover', label: '회전율', max: 25, color: '#4caf50' },
      { key: 'competition', label: '경쟁강도', max: 15, color: '#ff9800' },
      { key: 'shippingEfficiency', label: '배송효율', max: 15, color: '#9c27b0' },
      { key: 'priceStability', label: '가격안정', max: 15, color: '#00bcd4' },
    ];

    const barsHtml = categories.map(cat => {
      const sc = s.scores?.[cat.key] || {};
      const points = sc.points ?? '-';
      const pct = (sc.points !== null && sc.points !== undefined) ? (sc.points / cat.max * 100) : 0;
      const tier = sc.tier || '-';
      return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">
        <div style="width:70px;font-size:12px;font-weight:500">${cat.label}</div>
        <div style="flex:1;height:18px;background:#f0f2f5;border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${cat.color};border-radius:4px"></div>
        </div>
        <div style="width:50px;text-align:right;font-size:12px;font-weight:600">${points}/${cat.max}</div>
        <div style="width:80px;font-size:10px;color:#999">${tier}</div>
      </div>`;
    }).join('');

    detail.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <span class="class-badge" style="background:${color}18;color:${color};padding:4px 12px;border-radius:8px;font-size:14px;font-weight:700">${s.classification}등급</span>
          <span style="font-size:22px;font-weight:700;color:${color};margin-left:10px">${s.normalizedScore?.toFixed(1)}점</span>
        </div>
        <div style="font-size:11px;color:#999">${s.purchaseDecision?.allowed ? '✅ 매입 가능' : '❌ ' + (s.purchaseDecision?.reason || '매입 불가')}</div>
      </div>
      ${barsHtml}
      <div style="margin-top:12px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:11px;color:#666">
        <strong>원본 점수:</strong> ${s.totalScore}/${s.maxPossibleScore} (정규화: ${s.normalizedScore?.toFixed(1)}/100)
        <br><strong>계산일:</strong> ${s.calculatedAt ? new Date(s.calculatedAt).toLocaleString('ko-KR') : '-'}
        ${s.rawData?.sales30d !== null ? `<br><strong>30일 판매:</strong> ${s.rawData.sales30d}개` : ''}
        ${s.rawData?.netMarginPct !== null ? `<br><strong>순마진:</strong> ${s.rawData.netMarginPct?.toFixed(1)}%` : ''}
      </div>
    `;

    // 수동 입력 필드 채우기
    const overrides = s.manualOverrides || {};
    document.getElementById('overrideCompetitorCount').value = overrides.competitorCount ?? '';
    document.getElementById('overrideBundleItemCount').value = overrides.bundleItemCount ?? '';
    document.getElementById('overrideNotes').value = overrides.notes || '';
    document.getElementById('skuScoreOverrideResult').innerHTML = '';

    document.getElementById('skuScoreModalTitle').textContent = `${sku} 점수 상세`;
    const modal = document.getElementById('skuScoreModal');
    modal.dataset.sku = sku;
    modal.style.display = 'flex';
  } catch (err) {
    console.error('Score detail load failed:', err);
  }
}

function closeSkuScoreModal() {
  document.getElementById('skuScoreModal').style.display = 'none';
}

async function saveSkuOverride() {
  const modal = document.getElementById('skuScoreModal');
  const sku = modal.dataset.sku;
  const body = {};
  const cc = document.getElementById('overrideCompetitorCount').value;
  const bi = document.getElementById('overrideBundleItemCount').value;
  const notes = document.getElementById('overrideNotes').value;
  if (cc !== '') body.competitorCount = parseInt(cc);
  if (bi !== '') body.bundleItemCount = parseInt(bi);
  if (notes) body.notes = notes;

  const resultEl = document.getElementById('skuScoreOverrideResult');
  try {
    const res = await fetch(`${API}/sku-scores/${encodeURIComponent(sku)}/override`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.success) {
      resultEl.innerHTML = '<div style="color:#2e7d32;padding:8px;background:#e8f5e9;border-radius:6px;font-size:12px">저장 완료! 점수 재계산됨</div>';
      setTimeout(() => { closeSkuScoreModal(); loadSkuScores(); }, 800);
    } else {
      resultEl.innerHTML = `<div style="color:#c62828;padding:8px;background:#ffebee;border-radius:6px;font-size:12px">실패: ${result.error || ''}</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div style="color:#c62828;padding:8px;background:#ffebee;border-radius:6px;font-size:12px">오류: ${err.message}</div>`;
  }
}

async function executeRetirement(sku, action) {
  if (!confirm(`${sku}에 대해 "${action}" 조치를 실행하시겠습니까?`)) return;
  try {
    const res = await fetch(`${API}/sku-scores/retirement/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, action, confirm: true }),
    });
    const result = await res.json();
    alert(result.success ? '실행 완료' : '실패: ' + (result.error || result.note || ''));
    loadSkuScores();
  } catch (err) {
    alert('오류: ' + err.message);
  }
}

function setupSkuScoreEvents() {
  const classFilter = document.getElementById('skuClassFilter');
  const searchInput = document.getElementById('skuScoreSearch');
  const recalcBtn = document.getElementById('skuRecalcBtn');
  const execAllBtn = document.getElementById('executeAllRetirementBtn');
  const saveBtn = document.getElementById('saveOverrideBtn');

  if (classFilter) classFilter.addEventListener('change', () => loadSkuScores());
  if (searchInput) {
    let timer;
    searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => loadSkuScores(), 300); });
  }
  if (recalcBtn) {
    recalcBtn.addEventListener('click', async () => {
      recalcBtn.disabled = true;
      recalcBtn.textContent = '계산 중...';
      try {
        const res = await fetch(`${API}/sku-scores/recalculate`, { method: 'POST' });
        const result = await res.json();
        alert(result.message || '재계산 완료');
        await loadSkuScores();
      } catch (err) {
        alert('재계산 실패: ' + err.message);
      } finally {
        recalcBtn.disabled = false;
        recalcBtn.textContent = '재계산';
      }
    });
  }
  if (execAllBtn) {
    execAllBtn.addEventListener('click', async () => {
      if (!confirm('모든 퇴출 조치를 일괄 실행하시겠습니까?')) return;
      try {
        await fetch(`${API}/sku-scores/retirement/execute-all`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        });
        alert('일괄 실행 완료');
        loadSkuScores();
      } catch (err) {
        alert('실패: ' + err.message);
      }
    });
  }
  if (saveBtn) saveBtn.addEventListener('click', saveSkuOverride);

  // 모달 외부 클릭 닫기
  const modal = document.getElementById('skuScoreModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeSkuScoreModal(); });
}

// ===== 전투 상황판 (Battle Dashboard) =====

var battleData = null;
var battleEventsInit = false;
var battlePage = 1;
var BATTLE_PAGE_SIZE = 50;

async function battleImportCompetitors(btn) {
  if (!confirm('Google Sheets에서 경쟁사 데이터를 가져옵니다. 계속하시겠습니까?')) return;
  const origText = btn.textContent;
  btn.textContent = '⏳ 가져오는 중...';
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/battle/import-competitors`, { method: 'POST' });
    if (!res.ok && res.status === 404) throw new Error('서버를 재시작해주세요 (라우트 미등록)');
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('서버 응답 파싱 실패: ' + text.slice(0, 100)); }
    if (!data.success) throw new Error(data.error);
    alert(`✅ ${data.inserted}건 경쟁사 데이터 임포트 완료`);
    loadBattle();
  } catch (err) {
    alert('오류: ' + err.message);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function loadBattleSalesStats() {
  const el = document.getElementById('battleSalesStats');
  if (!el) return;
  try {
    var r = await fetch(`${API}/revenue/summary`);
    var data = JSON.parse(await r.text());
    var platforms = data.platforms || {};
    const PLATFORM_COLORS = { eBay:'#e53935', Shopify:'#2e7d32', Naver:'#1565c0', Shopee:'#f57c00', Qoo10:'#6a1b9a' };
    const cards = Object.entries(platforms).map(([name, p]) => {
      const color = PLATFORM_COLORS[name] || '#555';
      const rev = p.currency === 'KRW'
        ? Math.round(p.revenue || 0).toLocaleString() + '원'
        : '$' + (p.revenue || 0).toLocaleString();
      const revKRW = (p.revenueKRW || 0) >= 10000
        ? Math.round((p.revenueKRW||0)/10000) + '만원'
        : Math.round(p.revenueKRW||0).toLocaleString() + '원';
      return `<div class="stat-card" style="border-left:3px solid ${color}">
        <div class="label" style="color:${color};font-weight:600">${name}</div>
        <div class="number" style="font-size:18px">${rev}</div>
        <div style="font-size:10px;color:#888;margin-top:2px">≈ ${revKRW} · ${p.orders||0}건 · 30일</div>
      </div>`;
    });
    if (cards.length === 0) {
      el.innerHTML = '<div class="stat-card"><div class="label" style="color:#aaa">매출 데이터 없음</div></div>';
    } else {
      el.innerHTML = cards.join('');
    }
  } catch (e) {
    el.innerHTML = '<div class="stat-card"><div class="label" style="color:#aaa">매출 로드 실패</div></div>';
  }
}

async function loadBattleAlerts() {
  try {
    var r = await fetch(API + '/battle/alerts');
    var d = await r.json();
    var el = document.getElementById('battleAlerts');
    if (!el || !d.alerts || d.alerts.length === 0) { if (el) el.style.display = 'none'; return; }
    var recent = d.alerts.slice(0, 10);
    var icons = { ended: '⚠️', price_crash: '🔴', price_change: '📊', title_change: '⚡' };
    el.innerHTML = '<strong>최근 알림:</strong><br>' + recent.map(function(a) {
      var parsed = {};
      try { parsed = JSON.parse(a.data); } catch(e) {}
      return (icons[a.type] || '📌') + ' ' + a.message;
    }).join('<br>');
    el.style.display = 'block';
  } catch (e) {}
}

async function runCompetitorMonitor(btn) {
  btn.disabled = true;
  btn.textContent = '체크 중...';
  try {
    var r = await fetch(API + '/battle/monitor', { method: 'POST' });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    var alertCount = d.alerts ? d.alerts.length : 0;
    alert('경쟁사 변동 체크 완료!\n확인: ' + (d.checked || 0) + '개\n알림: ' + alertCount + '개');
    loadBattleAlerts();
    loadBattle();
  } catch (e) {
    alert('실패: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 경쟁사 변동 체크';
  }
}

async function loadBattle() {
  loadBattleAlerts();
  showLoading(true);
  var _battleRes, _battleText;
  try {
    _battleRes = await fetch(`${API}/battle/data?refresh=true`);
    if (!_battleRes.ok) throw new Error('HTTP ' + _battleRes.status);
    _battleText = await _battleRes.text();
    battleData = JSON.parse(_battleText);

    renderBattleStats(battleData.summary);
    renderBattleTable(battleData.items);
    populateBattleSellerFilter(battleData.summary.uniqueSellers || []);
    setupMarginCalculator();

    if (!battleEventsInit) {
      setupBattleEvents();
      setupRepricingEvents();
      battleEventsInit = true;
    }

    // 플랫폼별 매출 — 비동기 별도 로드 (느려도 전투 데이터 표시 막지 않음)
    loadBattleSalesStats();
  } catch (err) {
    console.error('Battle dashboard error:', err);
    document.getElementById('battleStats').innerHTML =
      `<div class="stat-card"><div class="label">데이터 로드 실패</div><div style="font-size:10px;color:#e53935;margin-top:4px;word-break:break-all">${esc(err.message || String(err))}</div></div>`;
    document.getElementById('battleTable').innerHTML =
      `<tr><td colspan="6" style="color:#e53935;padding:12px">${esc(err.stack || err.message || String(err))}</td></tr>`;
  } finally {
    showLoading(false);
  }
}

function setupRepricingEvents() {
  const evalBtn = document.getElementById('repricingEvalBtn');
  const execBtn = document.getElementById('repricingExecBtn');

  if (evalBtn) evalBtn.onclick = async () => {
    evalBtn.disabled = true;
    evalBtn.textContent = '평가 중...';
    try {
      // Evaluate repricing for all items with competitors
      const items = (battleData?.items || []).filter(i => i.competitors && i.competitors.length > 0);
      const results = [];
      for (const item of items.slice(0, 20)) { // limit 20
        try {
          const res = await fetch(`${API}/repricing/evaluate/${encodeURIComponent(item.sku)}`);
          if (res.ok) {
            const data = await res.json();
            if (data.recommendation) results.push({ ...data.recommendation, sku: item.sku, title: item.productName || item.sku });
          }
        } catch (e) {}
      }

      const body = document.getElementById('repricingBody');
      const container = document.getElementById('repricingResult');
      container.style.display = 'block';

      if (results.length === 0) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888">리프라이싱 대상 없음</td></tr>';
      } else {
        body.innerHTML = results.map(r => `<tr>
          <td title="${r.title}">${r.sku}</td>
          <td>$${(r.currentPrice || 0).toFixed(2)}</td>
          <td>$${(r.competitorPrice || 0).toFixed(2)}</td>
          <td style="font-weight:700;color:${r.newPrice < r.currentPrice ? '#c62828' : '#2e7d32'}">$${(r.newPrice || 0).toFixed(2)}</td>
          <td>${r.strategy || '-'}</td>
          <td>${r.estimatedMargin || '-'}%</td>
          <td><button class="refresh-btn" style="font-size:10px;padding:2px 8px;background:#e53935" onclick="executeRepricing('${r.sku}')">실행</button></td>
        </tr>`).join('');
      }
    } catch (e) {
      console.error('Repricing eval error:', e);
    } finally {
      evalBtn.textContent = '가격 평가';
      evalBtn.disabled = false;
    }
  };

  if (execBtn) execBtn.onclick = async () => {
    if (!confirm('모든 추천 가격을 일괄 적용하시겠습니까?')) return;
    execBtn.disabled = true;
    execBtn.textContent = '실행 중...';

    const rows = document.querySelectorAll('#repricingBody tr');
    let done = 0;
    for (const row of rows) {
      const sku = row.querySelector('td')?.textContent;
      if (sku) {
        try {
          await fetch(`${API}/repricing/execute/${encodeURIComponent(sku)}`, { method: 'POST' });
          done++;
        } catch (e) {}
      }
    }

    execBtn.textContent = `${done}건 완료!`;
    setTimeout(() => { execBtn.textContent = '일괄 실행'; execBtn.disabled = false; }, 3000);
    loadBattle(); // Refresh
  };
}

async function executeRepricing(sku) {
  try {
    const res = await fetch(`${API}/repricing/execute/${encodeURIComponent(sku)}`, { method: 'POST' });
    if (res.ok) {
      alert(`${sku} 리프라이싱 실행 완료`);
      loadBattle();
    }
  } catch (e) {
    alert('실행 실패: ' + e.message);
  }
}

function renderBattleStats(summary) {
  const el = document.getElementById('battleStats');
  if (!el || !summary) return;

  const losingPct = summary.withCompetitor > 0
    ? (summary.losing / summary.withCompetitor * 100).toFixed(0) : 0;

  el.innerHTML = `
    <div class="stat-card summary" style="border-left:4px solid #1a1a2e;cursor:pointer" onclick="document.getElementById('battleFilter').value='all';battlePage=1;renderBattleTable(battleData.items)">
      <div class="label">전체 상품</div>
      <div class="number">${summary.totalItems || 0}</div>
      <div style="font-size:10px;color:#888;margin-top:4px">eBay 활성 리스팅</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #e53935;cursor:pointer" onclick="document.getElementById('battleFilter').value='all';battlePage=1;renderBattleTable(battleData.items)">
      <div class="label">경쟁사 추적</div>
      <div class="number">${summary.withCompetitor || 0}</div>
      <div style="font-size:10px;color:#888;margin-top:4px">${summary.uniqueSellers?.length || 0}개 셀러</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #c62828;cursor:pointer" onclick="document.getElementById('battleFilter').value='losing';battlePage=1;renderBattleTable(battleData.items)">
      <div class="label">지고 있는 상품</div>
      <div class="number" style="color:#c62828">${summary.losing || 0}</div>
      <div style="font-size:10px;color:#c62828;margin-top:4px">${losingPct}% 패배율</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #2e7d32;cursor:pointer" onclick="document.getElementById('battleFilter').value='winning';battlePage=1;renderBattleTable(battleData.items)">
      <div class="label">이기고 있는 상품</div>
      <div class="number" style="color:#2e7d32">${summary.winning || 0}</div>
      <div style="font-size:10px;color:#888;margin-top:4px">가격 우위</div>
    </div>
    <div class="stat-card summary" style="border-left:4px solid #ff8f00">
      <div class="label">평균 가격 차이</div>
      <div class="number" style="color:${summary.avgDiff >= 0 ? '#c62828' : '#2e7d32'}">
        ${summary.avgDiff >= 0 ? '+' : ''}$${(summary.avgDiff || 0).toFixed(2)}
      </div>
      <div style="font-size:10px;color:#888;margin-top:4px">경쟁사 대비</div>
    </div>
  `;
}

function renderBattleTable(items) {
  const el = document.getElementById('battleTable');
  const countEl = document.getElementById('battleCount');
  if (!el) return;

  const filter = document.getElementById('battleFilter')?.value || 'all';
  const sellerFilter = document.getElementById('battleSellerFilter')?.value || '';
  const search = (document.getElementById('battleSearch')?.value || '').toLowerCase();
  const sortBy = document.getElementById('battleSort')?.value || 'diff-desc';

  let filtered = [...items];

  // 상태 필터
  if (filter === 'losing') filtered = filtered.filter(i => i.losing);
  else if (filter === 'winning') filtered = filtered.filter(i => i.competitors.length > 0 && !i.losing);
  else if (filter === 'no-comp') filtered = filtered.filter(i => i.competitors.length === 0);

  // 셀러 필터 (경쟁사 seller 이름 기준)
  if (sellerFilter) filtered = filtered.filter(i => i.competitors.some(c => c.seller === sellerFilter));

  // 검색 (SKU, itemId, 상품명 모두)
  if (search) {
    filtered = filtered.filter(i =>
      (i.sku || '').toLowerCase().includes(search) ||
      (i.itemId || '').toLowerCase().includes(search) ||
      (i.title || '').toLowerCase().includes(search)
    );
  }

  // 정렬
  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'diff-desc': return (Math.abs(b.diff) || 0) - (Math.abs(a.diff) || 0);
      case 'diff-asc': return (Math.abs(a.diff) || 0) - (Math.abs(b.diff) || 0);
      case 'comp-price': return (b.competitors[0]?.total || 0) - (a.competitors[0]?.total || 0);
      case 'my-price': return (b.myTotal || 0) - (a.myTotal || 0);
      case 'comp-sold': return 0;
      default: return 0;
    }
  });

  const totalFiltered = filtered.length;
  if (countEl) countEl.textContent = `(${totalFiltered}/${items.length})`;

  // 일괄 킬프라이스 버튼
  const killAllBtn = document.getElementById('battleKillAllBtn');
  const losingCount = filtered.filter(i => i.losing).length;
  if (killAllBtn) {
    killAllBtn.style.display = losingCount > 0 ? 'inline-block' : 'none';
    killAllBtn.textContent = `일괄 킬프라이스 (${losingCount})`;
  }

  if (totalFiltered === 0) {
    el.innerHTML = '<tr><td colspan="6" class="empty">해당 조건의 상품 없음</td></tr>';
    renderBattlePagination(1, 0, 0);
    return;
  }

  // 페이지네이션 (50개씩) — NaN 방지: 정수 강제 변환
  var _ps = 50;
  var _tp = Math.ceil(totalFiltered / _ps) || 1;
  var _curPage = (battlePage === battlePage && battlePage > 0) ? battlePage : 1; // NaN guard
  _curPage = Math.max(1, Math.min(_curPage, _tp));
  battlePage = _curPage;
  var _start = (_curPage - 1) * _ps;
  var pageItems = filtered.slice(_start, _start + _ps);
  renderBattlePagination(_curPage, _tp, totalFiltered);

  el.innerHTML = pageItems.map(item => {
    const hasComp = item.competitors.length > 0;
    const rowClass = item.losing ? 'battle-row-losing' : (hasComp ? 'battle-row-winning' : '');

    const diffClass = item.diff > 0 ? 'positive' : (item.diff < 0 ? 'negative' : 'neutral');
    const diffText = item.diff !== null ? `${item.diff > 0 ? '+' : ''}$${item.diff.toFixed(2)}` : '-';

    const statusBadge = item.losing
      ? '<span class="battle-status losing">패배</span>'
      : (hasComp ? '<span class="battle-status winning">승리</span>' : '<span class="battle-status neutral">-</span>');

    // 경쟁사 셀: 최대 3명 세로 나열
    const compCell = hasComp
      ? item.competitors.map((c, idx) => {
          const iLose = item.myTotal > c.total;
          const badge = iLose
            ? '<span style="color:#c62828;font-size:9px;font-weight:700">▼</span>'
            : '<span style="color:#2e7d32;font-size:9px;font-weight:700">▲</span>';
          const link = c.url
            ? `<a href="${esc(c.url)}" target="_blank" style="font-size:10px;color:#1565c0;margin-left:3px;text-decoration:none" title="경쟁사 리스팅 열기">🔗</a>`
            : '';
          const sellerTag = c.seller ? `<span style="font-size:8px;color:#5c6bc0;background:#e8eaf6;padding:0 3px;border-radius:2px;margin-left:2px">${esc(c.seller.slice(0,15))}</span>` : '';
          const label = c.itemId ? `<span style="font-size:9px;color:#999;margin-left:2px">${esc(c.itemId.slice(0, 13))}</span>` : '';
          const delBtn = `<button onclick="battleDeleteCompetitor('${esc(item.sku)}','${esc(c.itemId || '')}',this)" style="font-size:8px;padding:0 3px;background:none;border:1px solid #c62828;color:#c62828;border-radius:2px;cursor:pointer;margin-left:2px" title="경쟁사 삭제">✕</button>`;
          return `<div style="padding:1px 0;${idx > 0 ? 'opacity:0.75;' : ''}">
            ${badge} <span style="font-size:11px;font-weight:${idx===0?'700':'400'}">\$${c.price.toFixed(2)}+\$${c.shipping.toFixed(2)}=<b>\$${c.total.toFixed(2)}</b></span>${sellerTag}${label}${link}${delBtn}
          </div>`;
        }).join('')
      : '<span style="color:#ccc;font-size:11px">없음</span>';

    // 경쟁사 추가 버튼 (3명 미만일 때)
    const addCompBtn = item.competitors.length < 3
      ? `<div style="margin-top:2px"><button onclick="battleAddCompetitor('${esc(item.sku)}')" style="font-size:9px;padding:1px 6px;border:1px dashed #999;border-radius:4px;background:none;color:#666;cursor:pointer">+ 경쟁사 추가</button></div>`
      : '';

    // 내 리스팅 링크
    const myLink = item.itemId
      ? `<a href="https://www.ebay.com/itm/${esc(item.itemId)}" target="_blank" style="font-size:11px;color:#2e7d32;font-weight:600;white-space:nowrap">내 리스팅 🔗</a>`
      : '';

    return `<tr class="${rowClass}">
      <td>${statusBadge}</td>
      <td>
        <div class="battle-product-info">
          <div>
            <div class="sku">${esc(item.sku)}</div>
            <div class="title" title="${esc(item.title)}" style="white-space:normal;word-break:break-word;max-width:300px;font-size:11px;line-height:1.3">${esc(item.title || '')}</div>
          </div>
        </div>
      </td>
      <td class="battle-price-cell">
        <div class="price-main">$${(item.myPrice || 0).toFixed(2)}</div>
        <div class="price-ship">+$${(item.myShipping || 0).toFixed(2)} 배송</div>
        <div class="price-total">합계 $${(item.myTotal || 0).toFixed(2)}</div>
        <div style="margin-top:4px">${myLink}</div>
      </td>
      <td class="battle-price-cell" style="min-width:160px">${compCell}${addCompBtn}</td>
      <td style="text-align:center">
        <div class="battle-diff ${diffClass}">${diffText}</div>
      </td>
      <td style="text-align:center">
        ${item.losing && item.killPrice > 0
          ? `<div style="font-weight:700;color:#c62828">$${item.killPrice.toFixed(2)}</div>
             <button class="kill-price-btn" onclick="applyKillPrice('${esc(item.itemId)}', ${item.killPrice}, '${esc(item.sku)}')"
                     id="kill-${esc(item.itemId || item.sku)}">적용</button>`
          : (hasComp ? '<span style="color:#2e7d32;font-size:11px">불필요</span>' : '-')
        }
      </td>
    </tr>`;
  }).join('');
}

async function battleRefreshSellers() {
  var btn = document.getElementById('battleRefreshSellersBtn');
  btn.disabled = true;
  btn.textContent = '업데이트 중...';
  try {
    var r = await fetch(API + '/battle/refresh-sellers', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    var sellers = d.sellers || [];
    alert('셀러 정보 업데이트 완료!\n' + d.updated + '/' + d.total + '건 업데이트\n셀러: ' + (sellers.length > 0 ? sellers.join(', ') : '없음'));
    loadBattle();
  } catch (e) {
    alert('실패: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '셀러 정보 업데이트';
  }
}

function showSellerScanModal() {
  var modal = document.getElementById('sellerScanModal');
  modal.style.display = 'flex';
  document.getElementById('sellerScanInput').value = '';
  document.getElementById('sellerScanResult').style.display = 'none';
  document.getElementById('sellerScanInput').focus();
}
function closeSellerScanModal() {
  document.getElementById('sellerScanModal').style.display = 'none';
}
async function runSellerScan() {
  var sellerName = document.getElementById('sellerScanInput').value.trim();
  if (!sellerName) { alert('셀러 username을 입력하세요'); return; }
  var btn = document.getElementById('sellerScanBtn');
  var resultDiv = document.getElementById('sellerScanResult');
  btn.disabled = true;
  btn.textContent = '스캔 중... (1~2분 소요)';
  resultDiv.style.display = 'block';
  resultDiv.innerHTML = '🔍 ' + sellerName + ' 리스팅을 검색하고 내 상품과 매칭 중...';
  try {
    var r = await fetch('/api/battle/scan-seller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sellerName: sellerName })
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    resultDiv.innerHTML = '✅ 스캔 완료!<br>' +
      '셀러 리스팅: ' + d.totalListings + '개<br>' +
      '겹치는 상품: <strong>' + d.matched + '개</strong> 등록됨';
    if (d.pairs && d.pairs.length > 0) {
      resultDiv.innerHTML += '<br><br><strong>매칭 예시:</strong><br>' +
        d.pairs.slice(0, 5).map(function(p) {
          return '• ' + p.mySku + ' ↔ $' + p.competitorPrice.toFixed(2);
        }).join('<br>');
    }
    loadBattle(); // Refresh table
  } catch (e) {
    resultDiv.innerHTML = '❌ 실패: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '스캔 시작';
  }
}

async function battleDeleteCompetitor(sku, competitorId, btn) {
  if (!confirm('이 경쟁사를 삭제하시겠습니까?')) return;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    var r = await fetch(API + '/battle/delete-competitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: sku, competitorId: competitorId })
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    // Update local data and re-render
    if (battleData && battleData.items) {
      var found = battleData.items.find(function(i) { return i.sku === sku || i.itemId === sku; });
      if (found) {
        found.competitors = found.competitors.filter(function(c) { return c.itemId !== competitorId; });
        if (found.competitors.length > 0) {
          var cheapest = found.competitors.reduce(function(a, b) { return a.total < b.total ? a : b; });
          found.cheapestTotal = cheapest.total;
          found.diff = found.myTotal - found.cheapestTotal;
          found.losing = found.diff > 0;
        } else {
          found.cheapestTotal = null;
          found.diff = null;
          found.losing = false;
        }
        renderBattleTable(battleData.items);
      }
    }
  } catch (e) {
    alert('삭제 실패: ' + e.message);
    btn.disabled = false;
    btn.textContent = '✕';
  }
}

async function battleAddCompetitor(mySku) {
  var itemId = prompt('경쟁사 eBay Item ID를 입력하세요:');
  if (!itemId || !/^\d{9,15}$/.test(itemId.trim())) {
    if (itemId !== null) alert('유효한 eBay Item ID를 입력하세요 (9~15자리 숫자)');
    return;
  }
  try {
    var r = await fetch('/api/battle/add-competitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mySku: mySku, competitorItemId: itemId.trim() })
    });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);
    alert('경쟁사 추가 완료: $' + d.competitor.price.toFixed(2) + ' + $' + d.competitor.shipping.toFixed(2) + ' = $' + d.competitor.total.toFixed(2) + ' (' + (d.competitor.seller || '') + ')');
    // Update local data instead of full reload
    if (battleData && battleData.items) {
      var found = battleData.items.find(function(i) { return i.sku === mySku; });
      if (found) {
        found.competitors.push({
          itemId: d.competitor.itemId || '',
          price: d.competitor.price || 0,
          shipping: d.competitor.shipping || 0,
          total: d.competitor.total || 0,
          url: 'https://www.ebay.com/itm/' + (d.competitor.itemId || ''),
          seller: d.competitor.seller || ''
        });
        found.cheapestTotal = Math.min.apply(null, found.competitors.map(function(c) { return c.total; }));
        found.diff = found.myTotal - found.cheapestTotal;
        found.losing = found.diff > 0;
        renderBattleTable(battleData.items);
      }
    }
  } catch (e) {
    alert('경쟁사 추가 실패: ' + e.message);
  }
}

function renderBattlePagination(page, totalPages, totalItems) {
  var el = document.getElementById('battlePagination');
  if (!el) return;
  if (!totalPages || totalPages <= 1) { el.innerHTML = ''; return; }
  var ps = 50;
  var p = (page > 0 && page === page) ? page : 1;
  var from = (p - 1) * ps + 1;
  var to = Math.min(p * ps, totalItems);
  var btnStyle = 'padding:4px 10px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:12px';
  el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 0;font-size:12px;color:#666">'
    + '<button style="' + btnStyle + '" onclick="battleGoPage(' + (p-1) + ')" ' + (p===1?'disabled':'') + '>◀ 이전</button>'
    + '<span>' + from + '–' + to + ' / 전체 ' + totalItems + '개 (' + p + '/' + totalPages + '페이지)</span>'
    + '<button style="' + btnStyle + '" onclick="battleGoPage(' + (p+1) + ')" ' + (p===totalPages?'disabled':'') + '>다음 ▶</button>'
    + '</div>';
}

function battleGoPage(p) {
  battlePage = p;
  if (battleData) renderBattleTable(battleData.items);
}

function populateBattleSellerFilter(sellers) {
  const el = document.getElementById('battleSellerFilter');
  if (!el) return;
  const current = el.value;
  el.innerHTML = '<option value="">전체 셀러</option>' +
    sellers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  el.value = current;
}

function setupBattleEvents() {
  // 필터 변경 시 재렌더링
  ['battleFilter', 'battleSellerFilter', 'battleSort'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      battlePage = 1;
      if (battleData) renderBattleTable(battleData.items);
    });
  });

  // 검색 디바운스
  let searchTimeout;
  const searchEl = document.getElementById('battleSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        battlePage = 1;
        if (battleData) renderBattleTable(battleData.items);
      }, 300);
    });
  }

  // 실시간 새로고침
  const refreshBtn = document.getElementById('battleRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '갱신 중...';
      try {
        await fetch(`${API}/battle/refresh`, { method: 'POST' });
        await loadBattle();
      } catch (err) {
        console.error('Refresh failed:', err);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '실시간 새로고침';
      }
    });
  }

  // 일괄 킬프라이스
  const killAllBtn = document.getElementById('battleKillAllBtn');
  if (killAllBtn) {
    killAllBtn.addEventListener('click', async () => {
      var sellerFilter = document.getElementById('battleSellerFilter')?.value || '';
      var losingItems = (battleData?.items || []).filter(i => i.losing && i.killPrice > 0);
      if (sellerFilter) losingItems = losingItems.filter(i => i.competitors.some(c => c.seller === sellerFilter));
      if (losingItems.length === 0) { alert('적용할 상품이 없습니다'); return; }
      var msg = sellerFilter
        ? `셀러 "${sellerFilter}" 상대 ${losingItems.length}개 상품에 킬프라이스를 적용하시겠습니까?\n이 작업은 eBay 실제 가격을 변경합니다.`
        : `${losingItems.length}개 상품에 킬프라이스를 적용하시겠습니까?\n이 작업은 eBay 실제 가격을 변경합니다.`;
      if (!confirm(msg)) return;

      killAllBtn.disabled = true;
      killAllBtn.textContent = '적용 중...';
      let success = 0;

      for (const item of losingItems) {
        try {
          const res = await fetch(`${API}/battle/kill-price`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: item.itemId, newPrice: item.killPrice, sku: item.sku })
          });
          const result = await res.json();
          if (result.success) {
            success++;
            const btn = document.getElementById(`kill-${item.itemId}`);
            if (btn) { btn.textContent = '완료'; btn.className = 'kill-price-btn applied'; btn.disabled = true; }
          }
        } catch (e) { /* continue */ }
      }

      killAllBtn.textContent = `${success}/${losingItems.length} 완료`;
      setTimeout(() => loadBattle(), 2000);
    });
  }
}

// 킬프라이스 단일 적용
async function applyKillPrice(itemId, price, sku) {
  const btn = document.getElementById(`kill-${itemId}`);
  if (!btn) return;
  // Find item data for detailed confirm
  var item = battleData && battleData.items ? battleData.items.find(function(i) { return i.itemId === itemId; }) : null;
  var msg = '$' + price.toFixed(2) + '로 가격을 변경하시겠습니까?';
  if (item) {
    var myNewTotal = price + (item.myShipping || 0);
    var compTotal = item.cheapestTotal || 0;
    msg = '킬프라이스 적용\n\n' +
      '내 새 가격: $' + price.toFixed(2) + ' + 배송 $' + (item.myShipping || 0).toFixed(2) + ' = $' + myNewTotal.toFixed(2) + '\n' +
      '경쟁사 합계: $' + compTotal.toFixed(2) + '\n' +
      '차이: -$' + (compTotal - myNewTotal).toFixed(2) + ' (내가 더 쌈)\n\n' +
      '적용하시겠습니까?';
  }
  if (!confirm(msg)) return;

  btn.disabled = true;
  btn.textContent = '적용 중...';

  try {
    const res = await fetch(`${API}/battle/kill-price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, newPrice: price, sku })
    });
    const result = await res.json();

    if (result.success) {
      btn.textContent = '✓ $' + price.toFixed(2);
      btn.style.background = '#2e7d32';
      btn.style.color = '#fff';
      // Update local data immediately
      if (battleData && battleData.items) {
        var found = battleData.items.find(function(i) { return i.itemId === itemId; });
        if (found) {
          found.myPrice = price;
          found.myTotal = price + (found.myShipping || 0);
          found.diff = found.myTotal - (found.cheapestTotal || 0);
          found.losing = found.diff > 0;
          found.killPrice = 0; // Already applied
          renderBattleTable(battleData.items);
        }
      }
    } else {
      alert('킬프라이스 실패: ' + (result.error || '알 수 없는 오류'));
      btn.textContent = '적용';
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = '오류';
    btn.disabled = false;
  }
}

// ===== AI 리메이커 (Remarker) =====

var remarkerCompData = null;
var remarkerRemakeData = null;
var remarkerEventsInit = false;
var sellerBattleMapping = {};
var batchQueue = [];
var batchIndex = -1;
var batchRunning = false;

function setupRemarker() {
  if (remarkerEventsInit) return;
  remarkerEventsInit = true;

  const fetchBtn = document.getElementById('remarkerFetchBtn');
  const itemIdInput = document.getElementById('remarkerItemId');
  const form = document.getElementById('remarkerRegisterForm');
  const previewBtn = document.getElementById('rmPreviewBtn');
  const resetBtn = document.getElementById('rmResetBtn');
  const titleInput = document.getElementById('rmTitle');

  if (fetchBtn) fetchBtn.addEventListener('click', remarkerFetch);
  if (itemIdInput) itemIdInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') remarkerFetch(); });
  if (form) form.addEventListener('submit', remarkerRegister);
  if (previewBtn) previewBtn.addEventListener('click', () => {
    const preview = document.getElementById('rmDescPreview');
    if (preview.style.display === 'none') {
      preview.style.display = 'block';
      loadHtmlToIframe('rmDescPreviewFrame', buildPreviewHtml());
      previewBtn.textContent = '닫기';
    } else {
      preview.style.display = 'none';
      previewBtn.textContent = '미리보기';
    }
  });
  const fullBtn = document.getElementById('rmPreviewFullBtn');
  if (fullBtn) fullBtn.addEventListener('click', () => {
    const desc = document.getElementById('rmDescription').value;
    if (!desc.trim()) { alert('상세 설명이 비어있습니다'); return; }
    openPreviewModal(buildPreviewHtml());
  });
  if (resetBtn) resetBtn.addEventListener('click', remarkerReset);
  if (titleInput) titleInput.addEventListener('input', () => {
    document.getElementById('rmTitleCount').textContent = `${titleInput.value.length}/80`;
  });
  const brandBtn = document.getElementById('rmBrandImagesBtn');
  if (brandBtn) brandBtn.addEventListener('click', remarkerBrandImages);

  // 배치 모드 이벤트
  const batchStartBtn = document.getElementById('remarkerBatchStartBtn');
  if (batchStartBtn) batchStartBtn.addEventListener('click', startBatch);
  const batchIdsTextarea = document.getElementById('remarkerBatchIds');
  if (batchIdsTextarea) batchIdsTextarea.addEventListener('input', updateBatchIdCount);

  // 템플릿 목록 로드
  loadTemplates();
}

async function remarkerFetch() {
  const itemId = document.getElementById('remarkerItemId').value.trim();
  const resultEl = document.getElementById('remarkerFetchResult');
  const fetchBtn = document.getElementById('remarkerFetchBtn');

  if (!itemId) { resultEl.innerHTML = '<div style="color:#c62828;font-size:12px">Item ID를 입력하세요</div>'; return; }

  fetchBtn.disabled = true;
  fetchBtn.textContent = '조회 중...';
  resultEl.innerHTML = '<div style="color:#888;font-size:12px">eBay에서 상품 정보 가져오는 중...</div>';
  document.getElementById('remarkerStep2').style.display = 'none';
  document.getElementById('remarkerStep3').style.display = 'none';

  try {
    const res = await fetch(`${API}/remarker/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId })
    });
    const data = await res.json();

    if (!data.success || !data.item) {
      resultEl.innerHTML = `<div style="color:#c62828;font-size:12px">${esc(data.error || '상품을 찾을 수 없습니다')}</div>`;
      return;
    }

    remarkerCompData = data.item;
    document.getElementById('step2Dot').className = 'step-dot';
    document.getElementById('step3Dot').className = 'step-dot';
    renderCompetitorPreview(data.item, resultEl);
  } catch (err) {
    console.error('remarkerFetch error:', err);
    resultEl.innerHTML = `<div style="color:#c62828;font-size:12px">조회 실패: ${esc(err.message)}<br><span style="font-size:10px;color:#999">${esc(err.stack || '')}</span></div>`;
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = '조회';
  }
}

function renderCompetitorPreview(item, container) {
  const total = (item.price + item.shippingCost).toFixed(2);
  const specs = Object.entries(item.itemSpecifics || {}).slice(0, 6)
    .map(([k, v]) => `<tr><td style="font-weight:500;color:#555;padding:3px 8px;font-size:11px">${esc(k)}</td><td style="padding:3px 8px;font-size:11px">${esc(v)}</td></tr>`).join('');
  const imgs = (item.pictureURLs || []).slice(0, 6)
    .map(url => `<img src="${esc(url)}" style="width:70px;height:70px;object-fit:cover;border-radius:4px;border:1px solid #e0e0e0">`).join('');

  container.innerHTML = `
    <div style="background:#f8f9fa;border-radius:8px;padding:16px;border-left:4px solid #1565c0;margin-top:8px">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(item.title)}</div>
          <div style="font-size:11px;color:#888">
            ${esc(item.seller)} (${item.sellerFeedbackScore}) | Sold: ${item.quantitySold} | ${esc(item.conditionDisplayName || 'New')} | ${esc(item.categoryName || '')}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;margin-left:16px">
          <div style="font-size:20px;font-weight:700;color:#1565c0">$${total}</div>
          <div style="font-size:10px;color:#888">$${item.price.toFixed(2)} + $${item.shippingCost.toFixed(2)}</div>
        </div>
      </div>
      ${imgs ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${imgs}</div>` : ''}
      ${specs ? `<table style="font-size:11px;border-collapse:collapse;margin-bottom:10px">${specs}</table>` : ''}
      ${item.description ? `<details style="font-size:11px;color:#666"><summary style="cursor:pointer;font-weight:500">원본 상세페이지 보기</summary><iframe id="rmDescFrame" style="width:100%;height:300px;border:1px solid #e0e0e0;border-radius:4px;margin-top:6px" sandbox></iframe></details>` : ''}
      <div style="margin-top:12px">
        <button type="button" id="remarkerRemakeBtn" onclick="remarkerRemake()"
                style="background:#7c4dff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">
          AI 리메이크 시작
        </button>
        <span style="font-size:10px;color:#888;margin-left:8px">Claude AI가 제목과 상세페이지를 최적화합니다 (10~20초)</span>
      </div>
    </div>
  `;

  // iframe에 경쟁사 description 안전하게 삽입
  if (item.description) {
    const frame = document.getElementById('rmDescFrame');
    if (frame) {
      frame.onload = () => {};
      const blob = new Blob([item.description.substring(0, 8000)], { type: 'text/html' });
      frame.src = URL.createObjectURL(blob);
    }
  }
}

async function remarkerRemake() {
  if (!remarkerCompData) return;
  const btn = document.getElementById('remarkerRemakeBtn');
  btn.disabled = true;
  btn.textContent = 'AI 분석 중...';

  try {
    const res = await fetch(`${API}/remarker/remake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competitorData: remarkerCompData })
    });
    const data = await res.json();

    if (!data.success) {
      alert('AI Remake 실패: ' + (data.error || 'Unknown'));
      return;
    }

    remarkerRemakeData = data.remake;
    document.getElementById('step2Dot').className = 'step-dot done';
    document.getElementById('step3Dot').className = 'step-dot active';

    // Step 2: BEFORE/AFTER 비교
    renderRemarkerComparison(remarkerCompData, data.remake);
    document.getElementById('remarkerStep2').style.display = 'block';

    // Step 3: 등록 폼 채우기
    populateRemarkerForm(data.remake, remarkerCompData);
    document.getElementById('remarkerStep3').style.display = 'block';

    document.getElementById('remarkerStep2').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert('AI Remake 오류: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 리메이크 시작';
  }
}

function renderRemarkerComparison(original, remade) {
  const container = document.getElementById('remarkerComparison');
  const origTotal = (original.price + original.shippingCost).toFixed(2);
  const remadeTotal = (remade.killPrice + remade.suggestedShipping).toFixed(2);
  const origImgs = (original.pictureURLs || []).slice(0, 4)
    .map(url => `<img src="${esc(url)}" style="width:50px;height:50px;object-fit:cover;border-radius:3px">`).join('');

  container.innerHTML = `
    <div class="remarker-column before">
      <h4><span class="remarker-label before">BEFORE</span> 경쟁사 원본</h4>
      <div class="remarker-field">
        <div class="field-label">제목</div>
        <div class="field-value" style="font-weight:500">${esc(original.title)}</div>
      </div>
      <div class="remarker-field">
        <div class="field-label">가격 (합계)</div>
        <div class="field-value price" style="color:#1565c0">$${origTotal}</div>
        <div style="font-size:10px;color:#888">$${original.price.toFixed(2)} + $${original.shippingCost.toFixed(2)} 배송</div>
      </div>
      <div class="remarker-field">
        <div class="field-label">이미지</div>
        <div class="remarker-images">${origImgs || '<span style="color:#ccc;font-size:11px">없음</span>'}</div>
      </div>
      <div class="remarker-field">
        <div class="field-label">판매량</div>
        <div class="field-value">${original.quantitySold}개 판매</div>
      </div>
    </div>
    <div class="remarker-column after">
      <h4><span class="remarker-label after">AFTER</span> AI 리메이크</h4>
      <div class="remarker-field">
        <div class="field-label">SEO 제목 (${remade.title.length}자)</div>
        <div class="field-value" style="font-weight:600;color:#7c4dff">${esc(remade.title)}</div>
      </div>
      <div class="remarker-field">
        <div class="field-label">킬 프라이스 (합계)</div>
        <div class="field-value price" style="color:#c62828">$${remadeTotal}</div>
        <div style="font-size:10px;color:#888">$${remade.killPrice.toFixed(2)} + $${remade.suggestedShipping.toFixed(2)} 배송</div>
        <div style="font-size:10px;color:#2e7d32;font-weight:600;margin-top:2px">경쟁사 대비 -$${(origTotal - remadeTotal).toFixed(2)} 저렴</div>
      </div>
      ${remade.extractedBrand ? `<div class="remarker-field"><div class="field-label">브랜드</div><div class="field-value">${esc(remade.extractedBrand)}</div></div>` : ''}
      ${remade.extractedPartNumber ? `<div class="remarker-field"><div class="field-label">부품번호</div><div class="field-value">${esc(remade.extractedPartNumber)}</div></div>` : ''}
      ${remade.seoKeywords.length ? `<div class="remarker-field"><div class="field-label">SEO 키워드</div><div class="field-value" style="font-size:11px">${remade.seoKeywords.map(k => `<span style="background:#ede7f6;color:#7c4dff;padding:2px 6px;border-radius:3px;font-size:10px;margin-right:4px">${esc(k)}</span>`).join('')}</div></div>` : ''}
    </div>
  `;
}

function populateRemarkerForm(remade, original) {
  document.getElementById('rmSku').value = 'PMC-' + Date.now().toString(36).toUpperCase();
  document.getElementById('rmTitle').value = remade.title || '';
  document.getElementById('rmTitleCount').textContent = `${(remade.title || '').length}/80`;
  document.getElementById('rmDescription').value = remade.description || '';
  document.getElementById('rmPrice').value = remade.killPrice?.toFixed(2) || '';
  document.getElementById('rmShipping').value = remade.suggestedShipping?.toFixed(2) || '3.90';
  document.getElementById('rmQuantity').value = 10;
  document.getElementById('rmCategoryId').value = original.categoryId || '';
  document.getElementById('rmImages').value = (remade.pictureURLs || []).join('\n');
  document.getElementById('rmKeywords').value = (remade.seoKeywords || []).join(', ');
  document.getElementById('rmCondition').value = (original.conditionDisplayName || '').toLowerCase().includes('used') ? 'used' : 'new';
}

async function remarkerRegister(e) {
  e.preventDefault();
  const resultEl = document.getElementById('remarkerResult');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  const sku = document.getElementById('rmSku').value.trim();
  const title = document.getElementById('rmTitle').value.trim();
  if (!sku || !title) {
    resultEl.innerHTML = '<div style="color:#c62828;font-size:12px">SKU와 제목을 입력하세요</div>';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '등록 중...';
  resultEl.innerHTML = '';

  const platforms = [];
  if (document.getElementById('rmPlatEbay').checked) platforms.push('ebay');

  const imageUrls = document.getElementById('rmImages').value.split('\n').map(u => u.trim()).filter(Boolean);

  try {
    const res = await fetch(`${API}/remarker/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku,
        titleEn: title,
        description: document.getElementById('rmDescription').value,
        priceUSD: document.getElementById('rmPrice').value,
        shippingUSD: document.getElementById('rmShipping').value,
        quantity: document.getElementById('rmQuantity').value,
        condition: document.getElementById('rmCondition').value,
        imageUrls,
        ebayCategoryId: document.getElementById('rmCategoryId').value,
        targetPlatforms: platforms,
        itemSpecifics: remarkerCompData ? remarkerCompData.itemSpecifics || {} : {},
        // 셀러 전투 모드: 경쟁사 매핑
        competitorSeller: (sellerBattleMapping && remarkerCompData && sellerBattleMapping[remarkerCompData.itemId]) ? sellerBattleMapping[remarkerCompData.itemId].seller || '' : '',
        competitorItemId: (sellerBattleMapping && remarkerCompData && sellerBattleMapping[remarkerCompData.itemId]) ? sellerBattleMapping[remarkerCompData.itemId].competitorItemId || '' : '',
        competitorPrice: (sellerBattleMapping && remarkerCompData && sellerBattleMapping[remarkerCompData.itemId]) ? sellerBattleMapping[remarkerCompData.itemId].competitorPrice || '' : '',
        competitorShipping: (sellerBattleMapping && remarkerCompData && sellerBattleMapping[remarkerCompData.itemId]) ? sellerBattleMapping[remarkerCompData.itemId].competitorShipping || '' : '',
      })
    });
    const data = await res.json();

    if (data.success) {
      let msg = '<div style="background:#e8f5e9;border:1px solid #4caf50;border-radius:6px;padding:12px;font-size:12px">';
      msg += '<div style="font-weight:600;color:#2e7d32;margin-bottom:4px">등록 성공!</div>';
      msg += `<div>SKU: ${esc(sku)}</div>`;
      if (data.results?.sheets) msg += '<div>Google Sheets: 등록 완료</div>';
      if (data.results?.ebay?.success) msg += `<div>eBay: 등록 완료 (Item ID: ${esc(data.results.ebay.itemId)})</div>`;
      else if (data.results?.ebay) msg += `<div style="color:#e65100">eBay: ${esc(data.results.ebay.error || '실패')}</div>`;
      msg += '</div>';
      resultEl.innerHTML = msg;

      // 배치 모드: 등록 성공 후 다음 상품으로 자동 진행
      if (batchRunning && batchIndex >= 0 && batchIndex < batchQueue.length) {
        batchQueue[batchIndex].status = 'done';
        batchQueue[batchIndex].result = {
          sku,
          ebayItemId: data.results?.ebay?.itemId || null,
        };
        renderBatchProgress();
        setTimeout(() => processNextBatch(), 1200);
      }
    } else {
      resultEl.innerHTML = `<div style="color:#c62828;font-size:12px">등록 실패: ${esc(data.error)}</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div style="color:#c62828;font-size:12px">오류: ${esc(err.message)}</div>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '등록하기';
  }
}

function remarkerReset() {
  remarkerCompData = null;
  remarkerRemakeData = null;
  document.getElementById('remarkerItemId').value = '';
  document.getElementById('remarkerFetchResult').innerHTML = '';
  document.getElementById('remarkerStep2').style.display = 'none';
  document.getElementById('remarkerStep3').style.display = 'none';
  document.getElementById('remarkerComparison').innerHTML = '';
  document.getElementById('remarkerResult').innerHTML = '';
  document.getElementById('rmDescPreview').style.display = 'none';
  document.getElementById('rmPreviewBtn').textContent = '미리보기';
  document.getElementById('step2Dot').className = 'step-dot';
  document.getElementById('step3Dot').className = 'step-dot';
  // 배치 상태 초기화
  batchRunning = false;
  sellerBattleMapping = {};
  document.getElementById('rmSkipBtn').style.display = 'none';
}

// === 이미지 브랜딩 ===
async function remarkerBrandImages() {
  const imagesText = document.getElementById('rmImages').value.trim();
  const imageUrls = imagesText.split('\n').map(u => u.trim()).filter(Boolean);
  if (imageUrls.length === 0) { alert('이미지 URL이 없습니다'); return; }

  const btn = document.getElementById('rmBrandImagesBtn');
  const status = document.getElementById('rmBrandStatus');
  const preview = document.getElementById('rmImagePreview');
  const sku = document.getElementById('rmSku').value || 'PMC';

  btn.disabled = true;
  btn.textContent = '브랜딩 처리 중...';
  status.textContent = `${imageUrls.length}장 처리 중...`;
  preview.style.display = 'none';

  try {
    const res = await fetch(`${API}/remarker/brand-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrls, sku,
        template: document.getElementById('rmTemplateSelect')?.value || null,
        topText: document.getElementById('rmTopText')?.value || '',
        showShippingLogos: document.getElementById('rmShowLogos')?.checked !== false,
      })
    });
    const data = await res.json();

    if (!data.success) {
      status.textContent = '브랜딩 실패: ' + (data.error || 'Unknown');
      status.style.color = '#c62828';
      return;
    }

    status.textContent = `${data.branded}/${data.total}장 브랜딩 완료`;
    status.style.color = '#2e7d32';

    // 원본 vs 브랜딩 비교 프리뷰
    preview.style.display = 'grid';
    preview.innerHTML = data.images.map(img => `
      <div style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;background:#fafafa">
        <div style="display:flex;gap:2px">
          <div style="flex:1;text-align:center">
            <div style="font-size:9px;color:#888;padding:4px;background:#f0f2f5">원본</div>
            <img src="${esc(img.original)}" style="width:100%;height:120px;object-fit:contain">
          </div>
          <div style="flex:1;text-align:center">
            <div style="font-size:9px;color:#e94560;font-weight:600;padding:4px;background:#fce4ec">브랜딩</div>
            <img src="${esc(img.branded)}" style="width:100%;height:120px;object-fit:contain">
          </div>
        </div>
        ${img.error ? `<div style="font-size:9px;color:#c62828;padding:4px">실패: ${esc(img.error)}</div>` : ''}
      </div>
    `).join('');

    // 브랜딩된 이미지 URL로 textarea 업데이트
    const brandedUrls = data.images.map(img => img.branded);
    document.getElementById('rmImages').value = brandedUrls.join('\n');

  } catch (err) {
    status.textContent = '오류: ' + err.message;
    status.style.color = '#c62828';
  } finally {
    btn.disabled = false;
    btn.textContent = '이미지 브랜딩 적용';
  }
}

// ===== 템플릿 관리 =====

function toggleAutoTemplateOpts() {
  const sel = document.getElementById('rmTemplateSelect');
  const opts = document.getElementById('rmAutoTemplateOpts');
  if (sel && opts) {
    opts.style.display = sel.value === 'auto' ? 'flex' : 'none';
  }
}

async function loadTemplates() {
  try {
    const res = await fetch(`${API}/templates`);
    const data = await res.json();
    const sel = document.getElementById('rmTemplateSelect');
    if (!sel || !data.templates) return;
    // 기존 커스텀 옵션 제거
    while (sel.options.length > 2) sel.remove(2);
    data.templates.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.filename;
      opt.textContent = t.filename;
      sel.appendChild(opt);
    });
  } catch (e) {
    console.error('템플릿 로드 실패:', e);
  }
}

async function uploadTemplate() {
  const fileInput = document.getElementById('rmTemplateFile');
  if (!fileInput.files || fileInput.files.length === 0) return;

  const formData = new FormData();
  formData.append('template', fileInput.files[0]);

  try {
    const res = await fetch(`${API}/templates/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      await loadTemplates();
      const sel = document.getElementById('rmTemplateSelect');
      if (sel) sel.value = data.filename;
      toggleAutoTemplateOpts();
      alert('템플릿 업로드 완료: ' + data.filename);
    } else {
      alert('업로드 실패: ' + (data.error || 'Unknown'));
    }
  } catch (e) {
    alert('업로드 오류: ' + e.message);
  }
  fileInput.value = '';
}

// ===== 배치 리메이커 =====

// (variables moved to top, near remarkerCompData)

function toggleRemarkerMode() {
  const mode = document.querySelector('input[name="remarkerMode"]:checked')?.value || 'single';
  document.getElementById('remarkerSingleMode').style.display = mode === 'single' ? 'flex' : 'none';
  document.getElementById('remarkerBatchMode').style.display = mode === 'batch' ? 'block' : 'none';
  document.getElementById('remarkerReconstructMode').style.display = mode === 'reconstruct' ? 'block' : 'none';
  document.getElementById('remarkerBatchProgress').style.display = 'none';
  document.getElementById('remarkerBatchSummary').style.display = 'none';
  document.getElementById('rmSkipBtn').style.display = 'none';
  // 재구성 모드 시 Step 표시 초기화
  if (mode === 'reconstruct') {
    document.getElementById('remarkerStep2').style.display = 'none';
    document.getElementById('remarkerStep3').style.display = 'none';
  }
}

function updateBatchIdCount() {
  const text = document.getElementById('remarkerBatchIds').value.trim();
  const ids = text ? text.split('\n').map(s => s.trim()).filter(s => /^\d{9,15}$/.test(s)) : [];
  document.getElementById('batchIdCount').textContent = `${ids.length}개 입력`;
}

function startBatch() {
  const text = document.getElementById('remarkerBatchIds').value.trim();
  const ids = text.split('\n').map(s => s.trim()).filter(s => /^\d{9,15}$/.test(s));
  if (ids.length === 0) {
    alert('유효한 Item ID가 없습니다 (9~15자리 숫자)');
    return;
  }

  batchQueue = ids.map(id => ({ itemId: id, status: 'pending', result: null }));
  batchIndex = -1;
  batchRunning = true;

  document.getElementById('remarkerBatchMode').style.display = 'none';
  document.getElementById('remarkerBatchProgress').style.display = 'block';
  document.getElementById('remarkerBatchSummary').style.display = 'none';
  document.getElementById('rmSkipBtn').style.display = 'inline-block';

  renderBatchProgress();
  processNextBatch();
}

function renderBatchProgress() {
  const dotsEl = document.getElementById('batchProgressDots');
  const textEl = document.getElementById('batchProgressText');

  const done = batchQueue.filter(q => q.status === 'done').length;
  const skipped = batchQueue.filter(q => q.status === 'skipped').length;
  const errored = batchQueue.filter(q => q.status === 'error').length;
  const current = batchIndex >= 0 && batchIndex < batchQueue.length && batchQueue[batchIndex].status === 'processing' ? 1 : 0;
  textEl.textContent = `${done + skipped + errored}/${batchQueue.length} 처리 (등록 ${done}, 건너뜀 ${skipped}, 실패 ${errored})`;

  dotsEl.innerHTML = batchQueue.map((q, i) => {
    let bg = '#e0e0e0'; let border = '#ccc'; let color = '#999'; let label = i + 1;
    if (q.status === 'done') { bg = '#4caf50'; border = '#388e3c'; color = '#fff'; }
    else if (q.status === 'skipped') { bg = '#ff9800'; border = '#e65100'; color = '#fff'; }
    else if (q.status === 'error') { bg = '#e94560'; border = '#c62828'; color = '#fff'; }
    else if (q.status === 'processing') { bg = '#7c4dff'; border = '#5e35b1'; color = '#fff'; }
    return `<span title="${q.itemId}" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${bg};border:2px solid ${border};color:${color};font-size:10px;font-weight:600">${label}</span>`;
  }).join('');
}

async function processNextBatch() {
  batchIndex++;
  if (!batchRunning || batchIndex >= batchQueue.length) {
    batchRunning = false;
    document.getElementById('rmSkipBtn').style.display = 'none';
    renderBatchProgress();
    renderBatchSummary();
    return;
  }

  batchQueue[batchIndex].status = 'processing';
  renderBatchProgress();

  // Step 2, 3 초기화
  document.getElementById('remarkerStep2').style.display = 'none';
  document.getElementById('remarkerStep3').style.display = 'none';
  document.getElementById('remarkerComparison').innerHTML = '';
  document.getElementById('remarkerResult').innerHTML = '';
  document.getElementById('step2Dot').className = 'step-dot';
  document.getElementById('step3Dot').className = 'step-dot';

  const item = batchQueue[batchIndex];
  const resultEl = document.getElementById('remarkerFetchResult');
  resultEl.innerHTML = `<div style="color:#7c4dff;font-size:12px;font-weight:600">배치 ${batchIndex + 1}/${batchQueue.length}: ${item.itemId} 처리 중...</div>`;

  try {
    await batchAutoProcess(item.itemId);
    // 사용자가 등록 또는 건너뛰기를 클릭할 때까지 대기 (이벤트 기반)
  } catch (err) {
    item.status = 'error';
    item.result = { error: err.message };
    resultEl.innerHTML = `<div style="color:#c62828;font-size:12px">실패: ${err.message} — 다음으로 넘어갑니다...</div>`;
    renderBatchProgress();
    setTimeout(() => processNextBatch(), 1500);
  }
}

async function batchAutoProcess(itemId) {
  const resultEl = document.getElementById('remarkerFetchResult');

  // 1. Fetch
  resultEl.innerHTML = `<div style="color:#888;font-size:12px">eBay에서 상품 정보 가져오는 중... (${batchIndex + 1}/${batchQueue.length})</div>`;
  const fetchRes = await fetch(`${API}/remarker/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId })
  });
  const fetchData = await fetchRes.json();
  if (!fetchData.success || !fetchData.item) throw new Error(fetchData.error || '상품을 찾을 수 없습니다');

  remarkerCompData = fetchData.item;
  renderCompetitorPreview(fetchData.item, resultEl);

  // 2. AI Remake (자동 실행)
  const remakeBtn = document.getElementById('remarkerRemakeBtn');
  if (remakeBtn) { remakeBtn.disabled = true; remakeBtn.textContent = 'AI 분석 중...'; }

  const remakeRes = await fetch(`${API}/remarker/remake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ competitorData: remarkerCompData })
  });
  const remakeData = await remakeRes.json();
  if (remakeBtn) { remakeBtn.disabled = false; remakeBtn.textContent = 'AI 리메이크 시작'; }

  if (!remakeData.success) throw new Error(remakeData.error || 'AI Remake 실패');

  remarkerRemakeData = remakeData.remake;
  document.getElementById('step2Dot').className = 'step-dot done';
  document.getElementById('step3Dot').className = 'step-dot active';

  // 3. Before/After + 폼 채우기 (기존 함수 재사용)
  renderRemarkerComparison(remarkerCompData, remakeData.remake);
  populateRemarkerForm(remakeData.remake, remarkerCompData);

  document.getElementById('remarkerStep2').style.display = 'block';
  document.getElementById('remarkerStep3').style.display = 'block';
  document.getElementById('remarkerStep2').scrollIntoView({ behavior: 'smooth' });
}

function batchSkipCurrent() {
  if (!batchRunning || batchIndex < 0) return;
  batchQueue[batchIndex].status = 'skipped';
  renderBatchProgress();
  processNextBatch();
}

function stopBatch() {
  batchRunning = false;
  document.getElementById('rmSkipBtn').style.display = 'none';
  renderBatchProgress();
  renderBatchSummary();
}

function renderBatchSummary() {
  const summary = document.getElementById('remarkerBatchSummary');
  const content = document.getElementById('batchSummaryContent');

  const done = batchQueue.filter(q => q.status === 'done');
  const skipped = batchQueue.filter(q => q.status === 'skipped');
  const errored = batchQueue.filter(q => q.status === 'error');
  const pending = batchQueue.filter(q => q.status === 'pending');

  let html = `
    <div style="display:flex;gap:16px;margin-bottom:16px">
      <div style="background:#e8f5e9;border-radius:8px;padding:12px 20px;text-align:center;flex:1">
        <div style="font-size:24px;font-weight:700;color:#2e7d32">${done.length}</div>
        <div style="font-size:11px;color:#666">등록 완료</div>
      </div>
      <div style="background:#fff3e0;border-radius:8px;padding:12px 20px;text-align:center;flex:1">
        <div style="font-size:24px;font-weight:700;color:#e65100">${skipped.length}</div>
        <div style="font-size:11px;color:#666">건너뜀</div>
      </div>
      <div style="background:#ffebee;border-radius:8px;padding:12px 20px;text-align:center;flex:1">
        <div style="font-size:24px;font-weight:700;color:#c62828">${errored.length}</div>
        <div style="font-size:11px;color:#666">실패</div>
      </div>
      ${pending.length > 0 ? `<div style="background:#f0f2f5;border-radius:8px;padding:12px 20px;text-align:center;flex:1">
        <div style="font-size:24px;font-weight:700;color:#888">${pending.length}</div>
        <div style="font-size:11px;color:#666">미처리</div>
      </div>` : ''}
    </div>
  `;

  if (done.length > 0) {
    html += '<div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#2e7d32">등록 완료:</div>';
    html += '<div style="font-size:11px;color:#555;margin-bottom:12px">' + done.map(q => {
      const r = q.result || {};
      return `<div style="padding:3px 0">${q.itemId} → SKU: ${r.sku || '-'} ${r.ebayItemId ? '(eBay: ' + r.ebayItemId + ')' : ''}</div>`;
    }).join('') + '</div>';
  }

  if (errored.length > 0) {
    html += '<div style="font-size:12px;font-weight:600;margin-bottom:6px;color:#c62828">실패:</div>';
    html += '<div style="font-size:11px;color:#555;margin-bottom:12px">' + errored.map(q =>
      `<div style="padding:3px 0">${q.itemId}: ${q.result?.error || '알 수 없는 오류'}</div>`
    ).join('') + '</div>';
  }

  html += `<button onclick="batchRestart()" style="background:#7c4dff;color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;margin-top:8px">새 배치 시작</button>`;

  content.innerHTML = html;
  summary.style.display = 'block';
  summary.scrollIntoView({ behavior: 'smooth' });
}

function batchRestart() {
  batchQueue = [];
  batchIndex = -1;
  batchRunning = false;
  remarkerReset();
  document.getElementById('remarkerBatchMode').style.display = 'block';
  document.getElementById('remarkerBatchProgress').style.display = 'none';
  document.getElementById('remarkerBatchSummary').style.display = 'none';
  document.getElementById('remarkerBatchIds').value = '';
  updateBatchIdCount();
}

// === 미리보기 헬퍼 ===
function buildPreviewHtml() {
  const title = document.getElementById('rmTitle').value || '';
  const desc = document.getElementById('rmDescription').value || '';
  const price = document.getElementById('rmPrice').value || '0';
  const shipping = document.getElementById('rmShipping').value || '0';
  const images = document.getElementById('rmImages').value.split('\n').map(u => u.trim()).filter(Boolean);

  const imgHtml = images.length > 0
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:20px">${images.map(url =>
        `<img src="${url}" style="max-width:300px;max-height:300px;object-fit:contain;border:1px solid #e0e0e0;border-radius:6px">`
      ).join('')}</div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#fff">
  <div style="max-width:800px;margin:0 auto">
    <h1 style="font-size:18px;color:#1a1a2e;margin-bottom:4px">${title}</h1>
    <div style="font-size:22px;font-weight:700;color:#c62828;margin-bottom:16px">$${price} <span style="font-size:13px;color:#888;font-weight:400">+ $${shipping} shipping</span></div>
    ${imgHtml}
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">
    ${desc}
  </div>
</body></html>`;
}

function loadHtmlToIframe(frameId, html) {
  const frame = document.getElementById(frameId);
  if (!frame) return;
  const blob = new Blob([html], { type: 'text/html' });
  frame.src = URL.createObjectURL(blob);
}

function openPreviewModal(html) {
  const modal = document.getElementById('previewModal');
  modal.style.display = 'flex';
  loadHtmlToIframe('previewModalFrame', html);
  document.addEventListener('keydown', previewModalEsc);
}

function closePreviewModal() {
  document.getElementById('previewModal').style.display = 'none';
  document.removeEventListener('keydown', previewModalEsc);
}

function previewModalEsc(e) {
  if (e.key === 'Escape') closePreviewModal();
}

function setPreviewWidth(w) {
  document.getElementById('previewModalFrame').style.width = w;
}

// ===== 마진 계산기 =====

var _mcTimeout;
function setupMarginCalculator() {
  const ids = ['mcPurchasePrice', 'mcWeight', 'mcTargetMargin', 'mcCompPrice', 'mcCompShipping'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el._mcBound) {
      el._mcBound = true;
      el.addEventListener('input', () => {
        clearTimeout(_mcTimeout);
        _mcTimeout = setTimeout(calculateMargins, 300);
      });
    }
  });
}

async function calculateMargins() {
  const container = document.getElementById('mcResult');
  const purchasePrice = document.getElementById('mcPurchasePrice').value;
  if (!purchasePrice || parseFloat(purchasePrice) <= 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = '<div style="text-align:center;padding:20px;color:#888;font-size:12px">계산 중...</div>';

  try {
    const body = {
      purchasePrice,
      weight: document.getElementById('mcWeight').value || 0,
      targetMargin: document.getElementById('mcTargetMargin').value || 30,
      competitorPrice: document.getElementById('mcCompPrice').value || 0,
      competitorShipping: document.getElementById('mcCompShipping').value || 0,
    };

    const res = await fetch(`${API}/analysis/margin-calc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderMarginResult(data);
  } catch (err) {
    console.error('Margin calc failed:', err);
    container.innerHTML = `<div style="text-align:center;padding:12px;color:#c62828;font-size:12px">계산 실패: ${esc(err.message)}</div>`;
  }
}

function renderMarginResult(data) {
  const container = document.getElementById('mcResult');
  container.style.display = 'block';

  const { prices, competitorAnalysis, input } = data;

  // 경쟁셀러 비교 영역
  let compHtml = '';
  if (competitorAnalysis) {
    const ca = competitorAnalysis;
    const myEbay = prices.ebay || {};
    const diffColor = ca.priceDiff < 0 ? '#2e7d32' : ca.priceDiff > 0 ? '#c62828' : '#666';
    const diffLabel = ca.priceDiff < 0
      ? `내가 $${Math.abs(ca.priceDiff).toFixed(2)} 더 저렴`
      : ca.priceDiff > 0
        ? `경쟁사가 $${Math.abs(ca.priceDiff).toFixed(2)} 더 저렴`
        : '동일 가격';
    const myMarginColor = (myEbay.margin || 0) >= ca.margin ? '#2e7d32' : '#c62828';
    const compMarginColor = ca.margin >= 20 ? '#2e7d32' : ca.margin >= 10 ? '#ff9800' : '#c62828';

    compHtml = `
      <div style="background:#f8f9fa;border-radius:8px;padding:14px;margin-bottom:14px;border:1px solid #e0e0e0">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#1a1a2e">경쟁셀러 vs 나 비교 (eBay)</div>
        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center">
          <div style="text-align:center;padding:10px;background:#fff;border-radius:6px;border:1px solid #e0e0e0">
            <div style="font-size:11px;color:#888;margin-bottom:4px">경쟁셀러</div>
            <div style="font-size:18px;font-weight:700">$${ca.price.toFixed(2)} <span style="font-size:12px;color:#888">+ $${ca.shipping.toFixed(2)}</span></div>
            <div style="font-size:13px;color:${compMarginColor};font-weight:600">마진 ${ca.margin}%</div>
            <div style="font-size:11px;color:#888">순이익 ${ca.profitKRW > 0 ? '+' : ''}${ca.profitKRW.toLocaleString()}원</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${diffColor}">VS</div>
            <div style="font-size:11px;color:${diffColor};font-weight:600">${diffLabel}</div>
          </div>
          <div style="text-align:center;padding:10px;background:#fff;border-radius:6px;border:2px solid #7c4dff">
            <div style="font-size:11px;color:#7c4dff;margin-bottom:4px;font-weight:600">나 (eBay)</div>
            <div style="font-size:18px;font-weight:700">$${(myEbay.price || 0).toFixed(2)} <span style="font-size:12px;color:#888">+ $${(myEbay.shipping || 0).toFixed(2)}</span></div>
            <div style="font-size:13px;color:${myMarginColor};font-weight:600">마진 ${myEbay.margin || 0}%</div>
            <div style="font-size:11px;color:#888">순이익 ${(myEbay.estimatedProfit || 0) > 0 ? '+' : ''}${(myEbay.estimatedProfit || 0).toLocaleString()}원</div>
          </div>
        </div>
      </div>`;
  }

  // 플랫폼별 가격 카드
  const platformConfigs = [
    { key: 'ebay', name: 'eBay', color: '#1565c0', icon: 'e', feeLabel: '18%' },
    { key: 'shopify', name: 'Shopify', color: '#96bf48', icon: 'S', feeLabel: '3.3%' },
    { key: 'naver', name: 'Naver', color: '#03c75a', icon: 'N', feeLabel: '5.5%' },
    { key: 'qoo10', name: 'Qoo10', color: '#e53935', icon: 'Q', feeLabel: '12%' },
    { key: 'shopee', name: 'Shopee', color: '#ee4d2d', icon: 'Sh', feeLabel: '15%' },
  ];

  const currencySymbols = { USD: '$', KRW: '₩', JPY: '¥', LOCAL: '₫' };

  let cardsHtml = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">';
  platformConfigs.forEach(pf => {
    const p = prices[pf.key];
    if (!p || p.error) {
      cardsHtml += `
        <div style="background:#fff;border-radius:8px;padding:12px;border:1px solid #e0e0e0;border-top:3px solid ${pf.color};text-align:center;opacity:0.5">
          <div style="font-size:12px;font-weight:600;color:${pf.color}">${pf.name}</div>
          <div style="font-size:11px;color:#c62828;margin-top:8px">${p?.error || '계산 불가'}</div>
        </div>`;
      return;
    }

    const sym = currencySymbols[p.currency] || '';
    const priceDisplay = p.currency === 'KRW'
      ? `${sym}${p.price.toLocaleString()}`
      : p.currency === 'JPY'
        ? `${sym}${p.price.toLocaleString()}`
        : `${sym}${p.price.toFixed(2)}`;
    const shippingDisplay = p.shipping > 0
      ? ` + ${sym}${p.shipping.toFixed(2)} 배송`
      : '';
    const marginColor = p.margin >= 25 ? '#2e7d32' : p.margin >= 15 ? '#ff9800' : '#c62828';

    cardsHtml += `
      <div style="background:#fff;border-radius:8px;padding:12px;border:1px solid #e0e0e0;border-top:3px solid ${pf.color};text-align:center">
        <div style="font-size:12px;font-weight:600;color:${pf.color};margin-bottom:6px">${pf.name} <span style="font-size:10px;color:#999">(수수료 ${pf.feeLabel})</span></div>
        <div style="font-size:20px;font-weight:700;color:#1a1a2e">${priceDisplay}</div>
        <div style="font-size:11px;color:#888">${shippingDisplay || '배송비 포함'}</div>
        <div style="margin-top:6px;font-size:13px;color:${marginColor};font-weight:600">마진 ${p.margin}%</div>
        <div style="font-size:11px;color:#666">이익 ${p.estimatedProfit > 0 ? '+' : ''}${p.estimatedProfit.toLocaleString()}원</div>
        <div style="font-size:10px;color:#999;margin-top:2px">수수료 ${p.fee.toLocaleString()}원</div>
      </div>`;
  });
  cardsHtml += '</div>';

  // 원가 구조 요약
  const ebayData = prices.ebay || {};
  const costHtml = `
    <div style="margin-top:10px;font-size:11px;color:#888;text-align:right">
      원가: ${input.purchasePrice.toLocaleString()}원 | 배송비: 무게 기반 자동계산 | 세금(15%): ${Math.round(input.purchasePrice * 0.15).toLocaleString()}원
    </div>`;

  container.innerHTML = compHtml + cardsHtml + costHtml;
}

// ==================== 재구성 (Reconstruct) ====================
var reconstructFiles = [];

function handleReconstructDrop(e) {
  e.preventDefault();
  e.currentTarget.style.background = '#f8f6ff';
  e.currentTarget.style.borderColor = '#7c4dff';
  const files = e.dataTransfer.files;
  handleReconstructFiles(files);
}

function handleReconstructFiles(fileList) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  const newFiles = Array.from(fileList).filter(f => allowed.includes(f.type) && f.size <= 5 * 1024 * 1024);
  reconstructFiles = reconstructFiles.concat(newFiles).slice(0, 10);
  renderReconstructImagePreview();
}

function renderReconstructImagePreview() {
  const container = document.getElementById('reconstructImagePreview');
  const countEl = document.getElementById('reconstructFileCount');
  countEl.textContent = `이미지 ${reconstructFiles.length}장 선택`;

  if (reconstructFiles.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'grid';
  container.innerHTML = reconstructFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div style="position:relative;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fafafa">
      <img src="${url}" style="width:100%;height:80px;object-fit:cover">
      <div style="font-size:9px;color:#666;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
      <button onclick="removeReconstructFile(${i})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:10px;line-height:18px;text-align:center">×</button>
    </div>`;
  }).join('');
}

function removeReconstructFile(idx) {
  reconstructFiles.splice(idx, 1);
  renderReconstructImagePreview();
}

function toggleReconstructInput(mode) {
  const pasteBtn = document.getElementById('reconstructHtmlPasteBtn');
  const fileBtn = document.getElementById('reconstructHtmlFileBtn');
  const textarea = document.getElementById('reconstructHtmlText');
  const fileInput = document.getElementById('reconstructHtmlFile');

  if (mode === 'paste') {
    pasteBtn.style.background = '#7c4dff'; pasteBtn.style.color = '#fff'; pasteBtn.style.border = 'none';
    fileBtn.style.background = '#f0f2f5'; fileBtn.style.color = '#333'; fileBtn.style.border = '1px solid #ddd';
    textarea.style.display = 'block';
  } else {
    fileBtn.style.background = '#7c4dff'; fileBtn.style.color = '#fff'; fileBtn.style.border = 'none';
    pasteBtn.style.background = '#f0f2f5'; pasteBtn.style.color = '#333'; pasteBtn.style.border = '1px solid #ddd';
    textarea.style.display = 'none';
    fileInput.click();
  }
}

function handleReconstructHtmlFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('reconstructHtmlText').value = e.target.result;
    document.getElementById('reconstructHtmlText').style.display = 'block';
    // 버튼 스타일 복원
    const pasteBtn = document.getElementById('reconstructHtmlPasteBtn');
    const fileBtn = document.getElementById('reconstructHtmlFileBtn');
    pasteBtn.style.background = '#7c4dff'; pasteBtn.style.color = '#fff'; pasteBtn.style.border = 'none';
    fileBtn.style.background = '#f0f2f5'; fileBtn.style.color = '#333'; fileBtn.style.border = '1px solid #ddd';
  };
  reader.readAsText(file);
}

async function reconstructUpload() {
  const htmlContent = document.getElementById('reconstructHtmlText').value.trim();
  if (!htmlContent && reconstructFiles.length === 0) {
    alert('이미지 또는 HTML 내용을 입력해주세요.');
    return;
  }

  const progressEl = document.getElementById('reconstructProgress');
  const progressText = document.getElementById('reconstructProgressText');
  const startBtn = document.getElementById('reconstructStartBtn');
  progressEl.style.display = 'block';
  startBtn.disabled = true;
  startBtn.style.opacity = '0.6';
  progressText.textContent = 'AI가 분석 중입니다... (30~60초 소요)';

  try {
    const formData = new FormData();
    if (htmlContent) formData.append('htmlContent', htmlContent);
    reconstructFiles.forEach(f => formData.append('images', f));

    const resp = await fetch('/api/remarker/reconstruct', {
      method: 'POST',
      body: formData
    });
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || '재구성 실패');

    progressText.textContent = '재구성 완료! 결과를 표시합니다.';
    renderReconstructResult(data);
  } catch (err) {
    progressText.textContent = '실패: ' + err.message;
    progressEl.style.background = '#fce4ec';
  } finally {
    startBtn.disabled = false;
    startBtn.style.opacity = '1';
  }
}

function renderReconstructResult(data) {
  // Step 2에 추출된 정보 + Before/After 표시
  const step2 = document.getElementById('remarkerStep2');
  const comparison = document.getElementById('remarkerComparison');
  step2.style.display = 'block';

  let imagesHtml = '';
  if (data.brandedImages && data.brandedImages.length > 0) {
    imagesHtml = `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">브랜딩된 이미지 (${data.brandedImages.length}장)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
        ${data.brandedImages.map(img => `
          <div style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fafafa">
            <div style="display:flex;gap:1px">
              <div style="flex:1;text-align:center">
                <div style="font-size:9px;color:#888;padding:3px;background:#f0f2f5">원본</div>
                <img src="${esc(img.original)}" style="width:100%;height:90px;object-fit:contain">
              </div>
              <div style="flex:1;text-align:center">
                <div style="font-size:9px;color:#e94560;font-weight:600;padding:3px;background:#fce4ec">브랜딩</div>
                <img src="${esc(img.branded)}" style="width:100%;height:90px;object-fit:contain">
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  let specsHtml = '';
  if (data.extractedSpecs && Object.keys(data.extractedSpecs).length > 0) {
    specsHtml = `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
      ${Object.entries(data.extractedSpecs).map(([k, v]) =>
        `<tr><td style="padding:4px 8px;border:1px solid #e0e0e0;background:#f8f9fa;font-weight:600;width:30%">${esc(k)}</td>
         <td style="padding:4px 8px;border:1px solid #e0e0e0">${esc(String(v))}</td></tr>`
      ).join('')}
    </table>`;
  }

  let keywordsHtml = '';
  if (data.seoKeywords && data.seoKeywords.length > 0) {
    keywordsHtml = `<div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap">
      ${data.seoKeywords.map(kw => `<span style="background:#ede7f6;color:#7c4dff;padding:2px 8px;border-radius:10px;font-size:10px">${esc(kw)}</span>`).join('')}
    </div>`;
  }

  comparison.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:12px;font-weight:600;color:#e94560;margin-bottom:8px">AI 추출 정보</div>
        <div style="background:#f8f9fa;border-radius:8px;padding:12px;font-size:12px">
          <div><strong>제목:</strong> ${esc(data.title || '')}</div>
          <div style="margin-top:6px"><strong>브랜드:</strong> ${esc(data.extractedBrand || '미확인')}</div>
          ${data.extractedFeatures && data.extractedFeatures.length > 0 ? `
            <div style="margin-top:6px"><strong>특징:</strong></div>
            <ul style="margin:4px 0;padding-left:16px;font-size:11px">
              ${data.extractedFeatures.map(f => `<li>${esc(f)}</li>`).join('')}
            </ul>` : ''}
          ${specsHtml}
          ${keywordsHtml}
        </div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:#7c4dff;margin-bottom:8px">재구성된 상세페이지 미리보기</div>
        <div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;max-height:400px;overflow-y:auto">
          <iframe id="reconstructPreviewFrame" style="width:100%;height:380px;border:none" sandbox></iframe>
        </div>
      </div>
    </div>
    ${imagesHtml}
  `;

  // iframe에 재구성된 HTML 삽입
  setTimeout(() => {
    const frame = document.getElementById('reconstructPreviewFrame');
    if (frame) {
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      doc.write(data.description || '<p>내용 없음</p>');
      doc.close();
    }
  }, 100);

  // Step 3 폼에 자동 입력
  populateReconstructForm(data);
}

function populateReconstructForm(data) {
  const step3 = document.getElementById('remarkerStep3');
  step3.style.display = 'block';

  document.getElementById('rmTitle').value = data.title || '';
  document.getElementById('rmTitleCount').textContent = `${(data.title || '').length}/80`;
  document.getElementById('rmDescription').value = data.description || '';
  document.getElementById('rmKeywords').value = (data.seoKeywords || []).join(', ');

  // 브랜딩된 이미지 URL 입력
  if (data.brandedImages && data.brandedImages.length > 0) {
    document.getElementById('rmImages').value = data.brandedImages.map(img => img.branded).join('\n');
  }

  // Step 3 스크롤
  step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ==================== 재구성 독립 페이지 (rc*) ====================
var rcFiles = [];
var rcData = null; // 현재 결과 데이터
var rcCurrentTab = 'en'; // 현재 언어 탭
var rcEditMode = false; // 편집 모드 상태

function setupReconstructPage() {
  // 페이지 진입 시 초기화만
}

// 미리보기 ↔ 편집 모드 토글
function rcToggleEditMode() {
  rcEditMode = !rcEditMode;
  const btn = document.getElementById('rcViewModeBtn');
  const previewWrap = document.getElementById('rcPreviewWrap');
  const editWrap = document.getElementById('rcEditWrap');
  const editArea = document.getElementById('rcEditArea');

  if (rcEditMode) {
    // 편집 모드로 전환 — 현재 description을 textarea에 넣기
    btn.textContent = '미리보기';
    btn.style.background = '#e94560';
    btn.style.color = '#fff';
    previewWrap.style.display = 'none';
    editWrap.style.display = 'block';
    editArea.value = rcGetCurrentDescription();
  } else {
    // 미리보기로 복귀 — textarea 내용을 rcData에 반영
    btn.textContent = '편집 모드';
    btn.style.background = '#fff';
    btn.style.color = '#e94560';
    rcSetCurrentDescription(editArea.value);
    previewWrap.style.display = 'block';
    editWrap.style.display = 'none';
    if (rcData) rcRenderContent(rcData, rcCurrentTab);
  }
}

// 현재 탭 기준 description 가져오기
function rcGetCurrentDescription() {
  if (!rcData) return '';
  const isBoth = rcData.lang === 'both';
  if (isBoth) {
    return rcCurrentTab === 'ko' ? (rcData.descriptionKo || '') : (rcData.descriptionEn || '');
  }
  return rcData.description || '';
}

// 수정된 description을 rcData에 저장
function rcSetCurrentDescription(val) {
  if (!rcData) return;
  const isBoth = rcData.lang === 'both';
  if (isBoth) {
    if (rcCurrentTab === 'ko') rcData.descriptionKo = val;
    else rcData.descriptionEn = val;
  } else {
    rcData.description = val;
  }
}

function rcHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.style.background = '#fff5f5';
  e.currentTarget.style.borderColor = '#e94560';
  rcHandleFiles(e.dataTransfer.files);
}

function rcHandleFiles(fileList) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  const newFiles = Array.from(fileList).filter(f => allowed.includes(f.type) && f.size <= 5 * 1024 * 1024);
  rcFiles = rcFiles.concat(newFiles).slice(0, 10);
  rcRenderPreview();
}

function rcRenderPreview() {
  const container = document.getElementById('rcImagePreview');
  const countEl = document.getElementById('rcFileCount');
  countEl.textContent = `이미지 ${rcFiles.length}장 선택`;
  if (rcFiles.length === 0) { container.style.display = 'none'; return; }
  container.style.display = 'grid';
  container.innerHTML = rcFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div style="position:relative;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fafafa">
      <img src="${url}" style="width:100%;height:80px;object-fit:cover">
      <div style="font-size:9px;color:#666;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
      <button onclick="rcRemoveFile(${i})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:10px;line-height:18px;text-align:center">&times;</button>
    </div>`;
  }).join('');
}

function rcRemoveFile(idx) {
  rcFiles.splice(idx, 1);
  rcRenderPreview();
}

function rcToggleInput(mode) {
  const pasteBtn = document.getElementById('rcHtmlPasteBtn');
  const fileBtn = document.getElementById('rcHtmlFileBtn');
  const textarea = document.getElementById('rcHtmlText');
  const fileInput = document.getElementById('rcHtmlFile');
  if (mode === 'paste') {
    pasteBtn.style.background = '#e94560'; pasteBtn.style.color = '#fff'; pasteBtn.style.border = 'none';
    fileBtn.style.background = '#f0f2f5'; fileBtn.style.color = '#333'; fileBtn.style.border = '1px solid #ddd';
    textarea.style.display = 'block';
  } else {
    fileBtn.style.background = '#e94560'; fileBtn.style.color = '#fff'; fileBtn.style.border = 'none';
    pasteBtn.style.background = '#f0f2f5'; pasteBtn.style.color = '#333'; pasteBtn.style.border = '1px solid #ddd';
    textarea.style.display = 'none';
    fileInput.click();
  }
}

function rcHandleHtmlFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById('rcHtmlText').value = e.target.result;
    document.getElementById('rcHtmlText').style.display = 'block';
    const pasteBtn = document.getElementById('rcHtmlPasteBtn');
    const fileBtn = document.getElementById('rcHtmlFileBtn');
    pasteBtn.style.background = '#e94560'; pasteBtn.style.color = '#fff'; pasteBtn.style.border = 'none';
    fileBtn.style.background = '#f0f2f5'; fileBtn.style.color = '#333'; fileBtn.style.border = '1px solid #ddd';
  };
  reader.readAsText(file);
}

async function rcUpload() {
  const htmlContent = document.getElementById('rcHtmlText').value.trim();
  if (!rcFiles) rcFiles = [];
  if (!htmlContent && rcFiles.length === 0) {
    alert('이미지 또는 HTML 내용을 입력해주세요.');
    return;
  }

  const lang = document.querySelector('input[name="rcLang"]:checked')?.value || 'en';
  const mode = document.querySelector('input[name="rcMode"]:checked')?.value || 'standard';

  const progressEl = document.getElementById('rcProgress');
  const progressText = document.getElementById('rcProgressText');
  const startBtn = document.getElementById('rcStartBtn');
  progressEl.style.display = 'block';
  progressEl.style.background = '#f8f9fa';
  startBtn.disabled = true;
  startBtn.style.opacity = '0.6';

  if (mode === 'fast') {
    progressText.textContent = 'AI 빠른 분석 중... (5~15초 소요)';
  } else {
    progressText.textContent = lang === 'both'
      ? 'AI가 영어+한글 분석 중입니다... (60~90초 소요)'
      : 'AI가 분석 중입니다... (30~60초 소요)';
  }

  try {
    const formData = new FormData();
    if (htmlContent) formData.append('htmlContent', htmlContent);
    formData.append('lang', lang);
    formData.append('mode', mode);
    (rcFiles || []).forEach(f => formData.append('images', f));
    // Include CDN URLs from URL input
    var urlInput = document.getElementById('rcImageUrls');
    if (urlInput && urlInput.value.trim()) {
      formData.append('cdnImageUrls', urlInput.value.trim());
    }

    const resp = await fetch('/api/remarker/reconstruct', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || '재구성 실패');

    progressText.textContent = '재구성 완료!';
    rcData = data;
    rcRenderResult(data);
  } catch (err) {
    progressText.textContent = '실패: ' + err.message;
    progressEl.style.background = '#fce4ec';
  } finally {
    startBtn.disabled = false;
    startBtn.style.opacity = '1';
  }
}

function rcRenderResult(data) {
  const step2 = document.getElementById('rcStep2');
  step2.style.display = 'block';
  document.getElementById('rcStep2Dot').className = 'step-dot active';

  const isBoth = data.lang === 'both';
  const langTabs = document.getElementById('rcLangTabs');
  langTabs.style.display = isBoth ? 'flex' : 'none';

  // 추출 정보 렌더링
  rcRenderExtractedInfo(data);

  // 탭 초기화
  rcCurrentTab = isBoth ? 'en' : (data.lang || 'en');
  rcRenderContent(data, rcCurrentTab);

  // 썸네일 이미지 (원본 누끼)
  const thumbGrid = document.getElementById('rcThumbGrid');
  const images = data.originalImages || [];
  if (images.length > 0) {
    thumbGrid.innerHTML = images.map((src, i) => `
      <div style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;background:#fff;text-align:center">
        <img src="${esc(src)}" style="width:100%;height:140px;object-fit:contain;padding:8px">
        <div style="font-size:10px;color:#888;padding:4px;background:#f8f9fa">이미지 ${i + 1}</div>
      </div>
    `).join('');
  } else {
    thumbGrid.innerHTML = '<div style="font-size:12px;color:#999">업로드된 이미지 없음</div>';
  }

  step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function rcRenderExtractedInfo(data) {
  const el = document.getElementById('rcExtractedInfo');
  const isBoth = data.lang === 'both';

  const title = isBoth ? (data.titleEn || data.titleKo) : (data.title || '');
  const titleKo = isBoth ? (data.titleKo || '') : '';
  const brand = data.extractedBrand || '미확인';
  const features = data.extractedFeatures || [];
  const specs = data.extractedSpecs || {};
  const kwEn = isBoth ? (data.seoKeywordsEn || []) : (data.seoKeywords || []);
  const kwKo = isBoth ? (data.seoKeywordsKo || []) : [];

  let specsHtml = '';
  if (Object.keys(specs).length > 0) {
    specsHtml = `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
      ${Object.entries(specs).map(([k, v]) =>
        `<tr><td style="padding:4px 8px;border:1px solid #e0e0e0;background:#fff;font-weight:600;width:30%">${esc(k)}</td>
         <td style="padding:4px 8px;border:1px solid #e0e0e0">${esc(String(v))}</td></tr>`
      ).join('')}</table>`;
  }

  const kwHtml = (kws, label) => kws.length > 0 ? `
    <div style="margin-top:6px"><strong>${label}:</strong></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      ${kws.map(kw => `<span style="background:#fce4ec;color:#e94560;padding:2px 8px;border-radius:10px;font-size:10px">${esc(kw)}</span>`).join('')}
    </div>` : '';

  el.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:#e94560;margin-bottom:8px">AI 추출 정보</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px">
      <div>
        <div><strong>제목 (EN):</strong> ${esc(title)}</div>
        ${titleKo ? `<div style="margin-top:4px"><strong>제목 (KO):</strong> ${esc(titleKo)}</div>` : ''}
        <div style="margin-top:4px"><strong>브랜드:</strong> ${esc(brand)}</div>
        ${features.length > 0 ? `
          <div style="margin-top:6px"><strong>특징:</strong></div>
          <ul style="margin:4px 0;padding-left:16px;font-size:11px">
            ${features.map(f => `<li>${esc(f)}</li>`).join('')}
          </ul>` : ''}
      </div>
      <div>
        ${specsHtml}
        ${kwHtml(kwEn, 'Keywords (EN)')}
        ${kwHtml(kwKo, '키워드 (KO)')}
      </div>
    </div>`;
}

function rcRenderContent(data, lang) {
  const isBoth = data.lang === 'both';
  let desc = '';
  if (isBoth) {
    desc = lang === 'ko' ? (data.descriptionKo || '') : (data.descriptionEn || '');
  } else {
    desc = data.description || '';
  }

  const isFast = data.mode === 'fast';
  const frame = document.getElementById('rcPreviewFrame');
  if (frame) {
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    if (!desc) {
      doc.write('<p style="color:#999;text-align:center;padding:40px">내용 없음</p>');
    } else if (isFast) {
      // 빠른 모드: plain text → pre 태그로 표시
      const escaped = desc.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      doc.write(`<html><body style="margin:16px;font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#333">
        <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;margin:0">${escaped}</pre>
      </body></html>`);
    } else {
      doc.write(desc);
    }
    doc.close();
  }
}

function rcSwitchTab(lang) {
  // 편집 모드면 먼저 현재 수정사항 저장
  if (rcEditMode) {
    const editArea = document.getElementById('rcEditArea');
    rcSetCurrentDescription(editArea.value);
  }
  rcCurrentTab = lang;
  const enBtn = document.getElementById('rcTabEn');
  const koBtn = document.getElementById('rcTabKo');
  if (lang === 'en') {
    enBtn.style.background = '#e94560'; enBtn.style.color = '#fff';
    koBtn.style.background = '#fff'; koBtn.style.color = '#e94560';
  } else {
    koBtn.style.background = '#e94560'; koBtn.style.color = '#fff';
    enBtn.style.background = '#fff'; enBtn.style.color = '#e94560';
  }
  if (rcData) {
    if (rcEditMode) {
      document.getElementById('rcEditArea').value = rcGetCurrentDescription();
    } else {
      rcRenderContent(rcData, lang);
    }
  }
}

function rcCopyHtml() {
  if (!rcData) return;
  // 편집 모드면 먼저 저장
  if (rcEditMode) rcSetCurrentDescription(document.getElementById('rcEditArea').value);
  const isBoth = rcData.lang === 'both';
  let html = '';
  if (isBoth) {
    html = rcCurrentTab === 'ko' ? (rcData.descriptionKo || '') : (rcData.descriptionEn || '');
  } else {
    html = rcData.description || '';
  }
  navigator.clipboard.writeText(html).then(() => {
    const msg = document.getElementById('rcActionMsg');
    const isFast = rcData.mode === 'fast';
    msg.textContent = `상세페이지 ${isFast ? '텍스트' : 'HTML'} 복사 완료 (${rcCurrentTab === 'ko' ? '한글' : '영어'})`;
    setTimeout(() => msg.textContent = '', 3000);
  });
}

function rcCopyTitle() {
  if (!rcData) return;
  const isBoth = rcData.lang === 'both';
  let title = '';
  if (isBoth) {
    title = rcCurrentTab === 'ko' ? (rcData.titleKo || '') : (rcData.titleEn || '');
  } else {
    title = rcData.title || '';
  }
  navigator.clipboard.writeText(title).then(() => {
    const msg = document.getElementById('rcActionMsg');
    msg.textContent = `제목 복사 완료: ${title}`;
    setTimeout(() => msg.textContent = '', 3000);
  });
}

async function rcDownload() {
  // 편집 모드면 먼저 저장
  if (rcEditMode && rcData) rcSetCurrentDescription(document.getElementById('rcEditArea').value);
  if (!rcData || typeof JSZip === 'undefined') {
    alert('다운로드 준비 중... 잠시 후 다시 시도하세요.');
    return;
  }

  const msg = document.getElementById('rcActionMsg');
  msg.textContent = 'ZIP 파일 생성 중...';

  try {
    const zip = new JSZip();
    const isBoth = rcData.lang === 'both';

    // 이미지 다운로드 → ZIP에 추가
    const images = rcData.originalImages || [];
    for (let i = 0; i < images.length; i++) {
      try {
        const resp = await fetch(images[i]);
        const blob = await resp.blob();
        const ext = images[i].match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[0] || '.jpg';
        zip.file(`images/image_${i + 1}${ext}`, blob);
      } catch { /* skip failed */ }
    }

    // 상세페이지 파일 (빠른 모드: .txt / 표준 모드: .html)
    const isFast = rcData.mode === 'fast';
    const ext = isFast ? '.txt' : '.html';
    if (isBoth) {
      if (rcData.descriptionEn) zip.file('description_en' + ext, rcData.descriptionEn);
      if (rcData.descriptionKo) zip.file('description_ko' + ext, rcData.descriptionKo);
    } else {
      if (rcData.description) zip.file('description' + ext, rcData.description);
    }

    // 정보 텍스트
    let info = '=== PMC 재구성 결과 ===\n\n';
    if (isBoth) {
      info += `Title (EN): ${rcData.titleEn || ''}\n`;
      info += `Title (KO): ${rcData.titleKo || ''}\n`;
      info += `Keywords (EN): ${(rcData.seoKeywordsEn || []).join(', ')}\n`;
      info += `Keywords (KO): ${(rcData.seoKeywordsKo || []).join(', ')}\n`;
    } else {
      info += `Title: ${rcData.title || ''}\n`;
      info += `Keywords: ${(rcData.seoKeywords || []).join(', ')}\n`;
    }
    info += `Brand: ${rcData.extractedBrand || ''}\n`;
    info += `Images: ${images.length}장\n`;
    zip.file('info.txt', info);

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pmc-reconstruct-${Date.now().toString(36)}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    msg.textContent = 'ZIP 다운로드 완료!';
    msg.style.color = '#4caf50';
    setTimeout(() => { msg.textContent = ''; msg.style.color = '#4caf50'; }, 3000);
  } catch (err) {
    msg.textContent = '다운로드 실패: ' + err.message;
    msg.style.color = '#c62828';
  }
}

function rcReset() {
  rcFiles = [];
  rcData = null;
  rcEditMode = false;
  document.getElementById('rcHtmlText').value = '';
  document.getElementById('rcImagePreview').style.display = 'none';
  document.getElementById('rcFileCount').textContent = '이미지 0장 선택';
  document.getElementById('rcProgress').style.display = 'none';
  document.getElementById('rcStep2').style.display = 'none';
  document.getElementById('rcStep2Dot').className = 'step-dot';
  document.getElementById('rcLangTabs').style.display = 'none';
  document.getElementById('rcActionMsg').textContent = '';
  // 편집 모드 UI 초기화
  const previewWrap = document.getElementById('rcPreviewWrap');
  const editWrap = document.getElementById('rcEditWrap');
  const btn = document.getElementById('rcViewModeBtn');
  if (previewWrap) previewWrap.style.display = 'block';
  if (editWrap) editWrap.style.display = 'none';
  if (btn) { btn.textContent = '편집 모드'; btn.style.background = '#fff'; btn.style.color = '#e94560'; }
}

// ===== Shopify CDN 이미지 업로드 =====

var rcCdnUrls = [];

async function rcUploadToCDN() {
  var urlText = document.getElementById('rcImageUrls').value.trim();
  var statusEl = document.getElementById('rcCdnStatus');
  var btn = document.getElementById('rcCdnUploadBtn');
  var previewEl = document.getElementById('rcCdnPreview');

  if (!urlText) { statusEl.textContent = 'URL을 입력하세요'; statusEl.style.color = '#c62828'; return; }

  var urls = urlText.split('\n').map(function(u) { return u.trim(); }).filter(function(u) { return u.startsWith('http'); });
  if (urls.length === 0) { statusEl.textContent = '유효한 URL이 없습니다'; statusEl.style.color = '#c62828'; return; }

  btn.disabled = true;
  btn.textContent = '업로드 중...';
  statusEl.textContent = urls.length + '장 업로드 중...';
  statusEl.style.color = '#888';

  try {
    var res = await fetch(API + '/images/upload-cdn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrls: urls.slice(0, 10) })
    });
    var data = await res.json();
    if (!data.success) throw new Error(data.error);

    rcCdnUrls = data.cdnUrls || [];
    statusEl.textContent = rcCdnUrls.length + '장 CDN 업로드 완료';
    statusEl.style.color = '#2e7d32';

    // Replace textarea with CDN URLs
    document.getElementById('rcImageUrls').value = rcCdnUrls.join('\n');

    // Show preview
    if (rcCdnUrls.length > 0) {
      previewEl.style.display = 'grid';
      previewEl.innerHTML = rcCdnUrls.map(function(u, i) {
        return '<div style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fff;text-align:center">' +
          '<img src="' + esc(u) + '" style="width:100%;height:80px;object-fit:contain;padding:4px">' +
          '<div style="font-size:9px;color:#96bf48;padding:2px;background:#f8f9fa">CDN ' + (i+1) + '</div></div>';
      }).join('');
    }
  } catch (err) {
    statusEl.textContent = '실패: ' + err.message;
    statusEl.style.color = '#c62828';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Shopify CDN 업로드';
  }
}

// ===== 상품 페이지 URL → 이미지 추출 + CDN 업로드 (원스텝) =====

async function rcExtractAndUpload() {
  var urlText = document.getElementById('rcImageUrls').value.trim();
  var statusEl = document.getElementById('rcCdnStatus');
  var btn = document.getElementById('rcExtractBtn');
  var previewEl = document.getElementById('rcCdnPreview');

  if (!urlText) { statusEl.textContent = 'URL을 입력하세요'; statusEl.style.color = '#c62828'; return; }

  var lines = urlText.split('\n').map(function(u) { return u.trim(); }).filter(function(u) { return u.startsWith('http'); });
  if (lines.length === 0) { statusEl.textContent = '유효한 URL이 없습니다'; statusEl.style.color = '#c62828'; return; }

  // Separate: page URLs vs direct image URLs
  var pageUrls = [];
  var directImages = [];
  lines.forEach(function(u) {
    if (u.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i) || u.includes('coupangcdn') || u.includes('cdn.shopify')) {
      directImages.push(u);
    } else {
      pageUrls.push(u);
    }
  });

  btn.disabled = true;
  btn.textContent = '추출 중...';
  statusEl.textContent = '페이지에서 이미지 추출 중... (10~20초)';
  statusEl.style.color = '#7c4dff';

  try {
    // Step 1: Extract images from page URLs
    var extractedImages = [];
    for (var i = 0; i < pageUrls.length; i++) {
      statusEl.textContent = '페이지 ' + (i + 1) + '/' + pageUrls.length + ' 추출 중...';
      var res = await fetch(API + '/images/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl: pageUrls[i] })
      });
      var data = await res.json();
      if (data.success) {
        extractedImages = extractedImages.concat(data.thumbnails || []).concat(data.detailImages || []);
      }
    }

    // Combine: extracted + direct image URLs, deduplicate
    var allImages = [];
    var seen = {};
    directImages.concat(extractedImages).forEach(function(u) {
      if (!seen[u]) { seen[u] = true; allImages.push(u); }
    });

    if (allImages.length === 0) {
      statusEl.textContent = '이미지를 찾을 수 없습니다';
      statusEl.style.color = '#c62828';
      return;
    }

    // Step 2: Upload to Shopify CDN
    statusEl.textContent = allImages.length + '장 CDN 업로드 중...';
    statusEl.style.color = '#96bf48';
    var cdnRes = await fetch(API + '/images/upload-cdn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrls: allImages.slice(0, 10) })
    });
    var cdnData = await cdnRes.json();
    if (!cdnData.success) throw new Error(cdnData.error);

    rcCdnUrls = cdnData.cdnUrls || [];
    statusEl.textContent = rcCdnUrls.length + '장 CDN 업로드 완료!';
    statusEl.style.color = '#2e7d32';

    // Update textarea with CDN URLs
    document.getElementById('rcImageUrls').value = rcCdnUrls.join('\n');

    // Show preview
    if (rcCdnUrls.length > 0) {
      previewEl.style.display = 'grid';
      previewEl.innerHTML = rcCdnUrls.map(function(u, i) {
        return '<div style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;background:#fff;text-align:center">' +
          '<img src="' + esc(u) + '" style="width:100%;height:80px;object-fit:contain;padding:4px">' +
          '<div style="font-size:9px;color:#96bf48;padding:2px;background:#f8f9fa">CDN ' + (i+1) + '</div></div>';
      }).join('');
    }
  } catch (err) {
    statusEl.textContent = '실패: ' + err.message;
    statusEl.style.color = '#c62828';
  } finally {
    btn.disabled = false;
    btn.textContent = '이미지 추출 + CDN 업로드';
  }
}

// ==================== 배송 관리 페이지 ====================

function setupShippingPage() {
  // Google Sheets 링크 설정
  shippingLoadRecent();
}

async function shippingSyncOrders() {
  const days = document.getElementById('shippingSyncDays')?.value || 7;
  const btn = document.getElementById('shippingSyncBtn');
  const resultEl = document.getElementById('shippingSyncResult');
  const msgEl = document.getElementById('shippingSyncMsg');

  btn.disabled = true;
  btn.textContent = '수집 중...';
  btn.style.opacity = '0.6';
  resultEl.style.display = 'block';
  msgEl.innerHTML = '<span style="color:#0288d1">eBay + Shopify 주문을 수집 중입니다...</span>';

  try {
    const resp = await fetch(`/api/orders/sync?days=${days}`);
    const data = await resp.json();

    if (!data.success) throw new Error(data.error || '동기화 실패');

    // 시트 링크 업데이트
    if (data.sheetUrl) {
      const link = document.getElementById('shippingSheetLink');
      link.href = data.sheetUrl;
    }

    let msg = `<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">`;
    msg += `<span style="font-size:20px;font-weight:700;color:#0288d1">${data.synced}건</span>`;
    msg += `<span style="color:#666">수집 완료</span>`;
    if (data.shipped > 0) {
      msg += `<span style="color:#4caf50;font-size:11px">(${data.shipped}건 배송완료 처리)</span>`;
    }
    if (data.newOrders > 0) {
      msg += `<span style="color:#4caf50;font-size:11px">(신규 ${data.newOrders}건 추가)</span>`;
    }
    if (data.supabaseUpserted > 0) {
      msg += `<span style="color:#0288d1;font-size:11px">(미배송 ${data.supabaseUpserted}건 갱신)</span>`;
    }
    if (data.errors && data.errors.length > 0) {
      msg += `<div style="color:#c62828;font-size:11px;margin-top:4px">${data.errors.join(', ')}</div>`;
    }
    msg += `</div>`;
    msgEl.innerHTML = msg;

    // 최근 주문 새로고침
    await shippingLoadRecent();
  } catch (err) {
    msgEl.innerHTML = `<span style="color:#c62828">실패: ${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '주문 가져오기';
    btn.style.opacity = '1';
  }
}

// 주문 데이터 캐시 (검색 필터용) — must be declared before any function that reads it
var _shippingOrders = [];

async function shippingLoadRecent() {
  const tableEl = document.getElementById('shippingOrderTable');
  const countEl = document.getElementById('shippingOrderCount');

  try {
    const resp = await fetch('/api/orders/recent?limit=200&status=NEW');
    const data = await resp.json();

    if (!data.success || !data.orders || data.orders.length === 0) {
      tableEl.innerHTML = '<p style="color:#999;text-align:center;padding:30px">주문 데이터가 없습니다. "주문 가져오기"를 눌러주세요.</p>';
      countEl.textContent = '';
      return;
    }

    // 시트 링크 설정
    const link = document.getElementById('shippingSheetLink');
    if (link.href === '#' || link.href.endsWith('#')) {
      link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(data.sheetUrl || '')}`;
    }

    _shippingOrders = data.orders;
    const total = data.total || data.orders.length;

    // 검색바 + 테이블
    let html = `<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
      <input id="shippingSearch" type="text" placeholder="주문번호, 구매자, 국가 검색..." oninput="shippingFilter()"
        style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;max-width:320px">
      <span style="font-size:11px;color:#888" id="shippingFilterCount"></span>
    </div>`;

    html += shippingRenderTable(_shippingOrders);
    tableEl.innerHTML = html;
    countEl.textContent = `배송 대기 주문 ${data.orders.length}건`;
  } catch (err) {
    tableEl.innerHTML = `<p style="color:#c62828;text-align:center;padding:20px">로딩 실패: ${esc(err.message)}</p>`;
  }
}

function shippingRenderTable(orders) {
  const TH = 'padding:7px 8px;border-bottom:2px solid #0288d1;text-align:left;background:#f8f9fa;white-space:nowrap;color:#333;font-size:11px';
  const cols = ['일자', '플랫폼', '주문번호', '상품명', '수량', '구매자 / 배송지', '배송사', '상태'];

  let html = '<table style="width:100%;border-collapse:collapse;font-size:11px">';
  html += '<thead><tr>';
  cols.forEach(c => { html += `<th style="${TH}">${c}</th>`; });
  html += '</tr></thead><tbody id="shippingTbody">';

  orders.forEach(order => {
    html += shippingRenderRow(order);
  });

  html += '</tbody></table>';
  return html;
}

function shippingRenderRow(order) {
  const rowIdx = order.orderNo || order.orderId;
  const status = order.status || order['상태'] || '';
  const carrier = order.carrier || order['배송사'] || '';
  const platform = order.platform || order['플랫폼'] || '';
  const TD = 'padding:5px 8px;border-bottom:1px solid #f0f0f0;';

  // 주문일자 (MM-DD만)
  const dateRaw = order.orderDate || order['주문일자'] || '';
  const dateShort = dateRaw.length >= 10 ? dateRaw.substring(5) : dateRaw;

  // 플랫폼 색상
  const platformColor = platform === 'eBay' ? '#e53935' : platform === 'Shopify' ? '#96bf48' : '#333';

  // 주문번호 요약 (끝 8자리)
  const orderNo = order.orderNo || order['주문번호'] || '';
  const orderShort = orderNo.length > 10 ? '...' + orderNo.slice(-8) : orderNo;

  // 상품명 (30자 제한)
  const title = order.title || order['상품명'] || '';
  const titleShort = title.length > 30 ? title.substring(0, 30) + '...' : title;

  // 수량
  const qty = order.quantity || order['수량'] || '1';

  // 구매자 / 배송지
  const buyer = order.buyerName || order['구매자명'] || '';
  const country = order.countryCode || order.CountryCode || order.country || order['국가'] || '';
  const city = order.city || order.City || '';
  const zip = order.zipCode || order.ZipCode || '';
  const street = order.street || order.Street || '';
  const province = order.province || order.Province || '';
  const phone = order.phone || order.Phone || '';
  const email = order.email || order.Email || '';
  const addrSummary = [country, city, zip].filter(Boolean).join(', ');
  const hasAddr = street || city || country;

  // 상태 색상
  const statusColor = status === 'NEW' ? '#0288d1' : status === 'READY' ? '#ff8f00' : status === 'SHIPPED' ? '#4caf50' : '#888';

  let html = `<tr id="ship-row-${rowIdx}" data-search="${esc((orderNo + ' ' + buyer + ' ' + country + ' ' + city + ' ' + title + ' ' + street).toLowerCase())}">`;

  // 일자
  html += `<td style="${TD}white-space:nowrap;color:#555">${esc(dateShort)}</td>`;
  // 플랫폼
  html += `<td style="${TD}white-space:nowrap;color:${platformColor};font-weight:600">${esc(platform)}</td>`;
  // 주문번호
  html += `<td style="${TD}white-space:nowrap;font-family:monospace;font-size:10px" title="${esc(orderNo)}">${esc(orderShort)}</td>`;
  // 상품명
  html += `<td style="${TD}max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(title)}">${esc(titleShort)}</td>`;
  // 수량
  html += `<td style="${TD}text-align:center">${esc(String(qty))}</td>`;
  // 구매자 / 배송지 (클릭 시 주소 상세)
  html += `<td style="${TD}max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">`;
  if (hasAddr) {
    html += `<span onclick="shippingToggleAddr('${rowIdx}')" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;font-weight:600">${esc(buyer)}</span>`;
    html += ` <span onclick="shippingToggleAddr('${rowIdx}')" style="cursor:pointer;color:#888;font-size:10px">/ ${esc(addrSummary)}</span>`;
  } else {
    html += `<span style="font-weight:600">${esc(buyer)}</span>`;
    if (addrSummary) html += ` <span style="color:#888;font-size:10px">/ ${esc(addrSummary)}</span>`;
  }
  html += '</td>';
  // 배송사
  html += `<td style="${TD}white-space:normal;">`;
  if (carrier) {
    const clr = CARRIER_COLORS[carrier] || '#333';
    html += `<span onclick="shippingCancelCarrier('${rowIdx}')" style="display:inline-block;padding:3px 10px;border-radius:12px;background:${clr};color:#fff;font-size:10px;font-weight:600;cursor:pointer" title="클릭하면 취소">${esc(carrier)}</span>`;
  } else {
    html += `<div>`;
    html += `<button id="est-btn-${rowIdx}" onclick="shippingShowEstimate('${rowIdx}','${rowIdx}')" style="padding:2px 8px;border:1px solid #1565c0;border-radius:10px;background:#fff;color:#1565c0;font-size:9px;cursor:pointer;font-weight:600">배송사 추천 ▼</button>`;
    html += `<div id="est-panel-${rowIdx}" style="display:none;margin-top:4px"></div>`;
    html += `</div>`;
  }
  html += '</td>';
  // 상태
  html += `<td style="${TD}white-space:nowrap;color:${statusColor};font-weight:600">${esc(status)}</td>`;

  html += '</tr>';

  // 주소 상세 행 (숨김)
  html += `<tr id="addr-row-${rowIdx}" style="display:none"><td colspan="8" style="padding:0">`;
  html += `<div style="background:#f8f9fa;padding:10px 16px;border-bottom:2px solid #e0e0e0;font-size:11px;line-height:1.6">`;
  if (hasAddr) {
    html += `<div style="display:flex;gap:24px;flex-wrap:wrap">`;
    html += `<div><b>${esc(buyer)}</b></div>`;
    if (street) html += `<div>${esc(street)}</div>`;
    html += `<div>${[city, province, zip].filter(Boolean).map(v => esc(v)).join(', ')}</div>`;
    if (country) html += `<div>${esc(country)}</div>`;
    if (phone) html += `<div>Tel: ${esc(phone)}</div>`;
    if (email) html += `<div>Email: ${esc(email)}</div>`;
    html += `</div>`;
  } else {
    html += `<span style="color:#999">주소 정보 없음</span>`;
  }
  html += '</div></td></tr>';

  return html;
}

function shippingToggleAddr(rowIdx) {
  const el = document.getElementById(`addr-row-${rowIdx}`);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

function shippingFilter() {
  const q = (document.getElementById('shippingSearch').value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#shippingTbody tr');
  let shown = 0;
  rows.forEach(row => {
    const searchData = row.getAttribute('data-search') || '';
    if (!q || searchData.includes(q)) {
      row.style.display = '';
      shown++;
    } else {
      row.style.display = 'none';
    }
  });
  const el = document.getElementById('shippingFilterCount');
  if (el) {
    el.textContent = q ? `${shown}건 검색됨` : '';
  }
}

async function shippingBackfillAddresses() {
  const btn = document.getElementById('shippingBackfillBtn');
  btn.disabled = true;
  btn.textContent = '주소 보완 중...';
  btn.style.opacity = '0.6';

  try {
    const resp = await fetch('/api/orders/backfill-addresses', { method: 'POST' });
    const data = await resp.json();
    if (data.success) {
      alert(`주소 보완 완료: ${data.updated}건 업데이트, ${data.skipped}건 스킵`);
      shippingLoadRecent();
    } else {
      alert('주소 보완 실패: ' + (data.error || ''));
    }
  } catch (err) {
    alert('주소 보완 에러: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '주소 보완';
    btn.style.opacity = '1';
  }
}

async function shippingCancelCarrier(rowIndex) {
  if (!confirm('배송사 지정을 취소하시겠습니까?')) return;

  try {
    const resp = await fetch('/api/orders/cancel-carrier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowIndex }),
    });
    const data = await resp.json();
    if (data.success) {
      // 목록 새로고침으로 버튼 복원
      shippingLoadRecent();
    } else {
      alert('취소 실패: ' + data.error);
    }
  } catch (err) {
    alert('취소 에러: ' + err.message);
  }
}

async function shippingSaveWeight(rowIdx, sku, orderNo) {
  const weightKg = parseFloat(document.getElementById(`wgt-${rowIdx}`)?.value) || 0;
  const boxL = parseFloat(document.getElementById(`diml-${rowIdx}`)?.value) || 0;
  const boxW = parseFloat(document.getElementById(`dimw-${rowIdx}`)?.value) || 0;
  const boxH = parseFloat(document.getElementById(`dimh-${rowIdx}`)?.value) || 0;
  if (!weightKg) { alert('무게를 입력하세요'); return; }
  try {
    const r = await fetch('/api/orders/save-weight', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNo, sku: sku || '', weight_kg: weightKg, box_length: boxL, box_width: boxW, box_height: boxH })
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error);
    // 패널 닫고 다시 열어서 새 견적 표시
    var panel = document.getElementById(`est-panel-${rowIdx}`);
    panel.style.display = 'none';
    await shippingShowEstimate(rowIdx, orderNo);
  } catch (e) {
    alert('저장 실패: ' + e.message);
  }
}

async function shippingShowEstimate(rowIdx, orderNo) {
  const panel = document.getElementById(`est-panel-${rowIdx}`);
  const btn = document.getElementById(`est-btn-${rowIdx}`);

  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    btn.textContent = '배송사 추천 ▼';
    return;
  }

  btn.textContent = '로딩 중...';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/orders/shipping-estimate/${encodeURIComponent(orderNo)}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    let html = `<div style="border:1px solid #e0e0e0;border-radius:6px;padding:6px;background:#fafafa;font-size:10px;min-width:300px">`;
    if (!data.weightKg) {
      html += `<div style="background:#fff3e0;border:1px solid #ffb74d;border-radius:4px;padding:5px 6px;margin-bottom:6px;font-size:9px">
        <div style="color:#e65100;font-weight:600;margin-bottom:4px">⚠️ 무게 미설정 — 제품 정보를 입력하세요</div>
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
          <label style="font-size:9px;color:#555">무게(kg)</label>
          <input id="wgt-${rowIdx}" type="number" step="0.01" placeholder="0.00" style="width:55px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:9px">
          <label style="font-size:9px;color:#555">가로</label>
          <input id="diml-${rowIdx}" type="number" step="0.1" placeholder="cm" style="width:40px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:9px">
          <label style="font-size:9px;color:#555">세로</label>
          <input id="dimw-${rowIdx}" type="number" step="0.1" placeholder="cm" style="width:40px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:9px">
          <label style="font-size:9px;color:#555">높이</label>
          <input id="dimh-${rowIdx}" type="number" step="0.1" placeholder="cm" style="width:40px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:9px">
          <button onclick="shippingSaveWeight('${rowIdx}','${data.sku}','${orderNo}')"
                  style="padding:2px 8px;border:none;border-radius:4px;background:#e65100;color:#fff;font-size:9px;cursor:pointer;white-space:nowrap">저장 후 계산</button>
        </div>
      </div>`;
    }
    if (data.estimates && data.estimates.length > 0) {
      data.estimates.forEach(e => {
        const star = e.isRecommended ? '⭐' : '　';
        const bg = e.isRecommended ? '#e3f2fd' : '#fff';
        html += `<div style="display:flex;align-items:center;gap:5px;padding:3px 4px;border-radius:4px;background:${bg};margin-bottom:2px">
          <span style="width:16px;font-size:10px">${star}</span>
          <span style="font-weight:600;min-width:110px;font-size:9px">${esc(e.carrier)} <span style="color:#666;font-weight:400">${esc(e.service)}</span></span>
          <span style="color:${e.priceKRW ? '#c62828' : '#f57c00'};font-weight:700;min-width:55px;font-size:10px">${e.priceKRW ? '₩' + e.priceKRW.toLocaleString() : '무게 필요'}</span>
          <span style="color:#666;min-width:40px;font-size:9px">${esc(e.days)}</span>
          <button onclick="shippingSetCarrier('${rowIdx}','${e.carrier.replace(/'/g,"\\'")}');document.getElementById('est-panel-${rowIdx}').style.display='none';document.getElementById('est-btn-${rowIdx}').textContent='배송사 추천 ▼';"
                  style="padding:1px 8px;border:1px solid #1565c0;border-radius:8px;background:#1565c0;color:#fff;font-size:9px;cursor:pointer;white-space:nowrap">선택</button>
        </div>`;
      });
    } else {
      html += `<div style="color:#666;font-size:9px">해당 국가 배송 가능한 배송사 없음</div>`;
    }
    html += `</div>`;
    panel.innerHTML = html;
    panel.style.display = 'block';
    btn.textContent = '배송사 추천 ▲';
  } catch (err) {
    panel.innerHTML = `<div style="color:red;font-size:10px;padding:4px">오류: ${err.message}</div>`;
    panel.style.display = 'block';
    btn.textContent = '배송사 추천 ▼';
  }
  btn.disabled = false;
}

async function shippingSetCarrier(rowIndex, carrier, sheetTab) {
  // 버튼 즉시 교체 (UI 반응성)
  const btnsEl = document.getElementById(`carrier-btns-${rowIndex}`);
  if (btnsEl) {
    const clr = CARRIER_COLORS[carrier] || '#333';
    btnsEl.outerHTML = `<span id="carrier-badge-${rowIndex}" onclick="shippingCancelCarrier(${rowIndex})" style="display:inline-block;padding:3px 10px;border-radius:12px;background:${clr};color:#fff;font-size:10px;font-weight:600;cursor:pointer" title="클릭하면 취소">${carrier}</span><span id="carrier-tab-${rowIndex}" style="margin-left:4px;font-size:9px;color:#999">등록중...</span>`;
  }

  // 상태 칸도 즉시 READY로
  const row = document.getElementById(`ship-row-${rowIndex}`);
  if (row) {
    const cells = row.querySelectorAll('td');
    const lastCell = cells[cells.length - 1];
    if (lastCell) {
      lastCell.textContent = 'READY';
      lastCell.style.color = '#ff8f00';
    }
  }

  // API 호출
  try {
    const body = { rowIndex, carrier };
    if (sheetTab) body.sheetTab = sheetTab;

    const resp = await fetch('/api/orders/set-carrier', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    const tabEl = document.getElementById(`carrier-tab-${rowIndex}`);

    if (!data.success) {
      console.error('배송사 설정 실패:', data.error);
      if (tabEl) { tabEl.textContent = '(실패)'; tabEl.style.color = '#c62828'; }
      alert('배송사 설정 실패: ' + data.error);
    } else if (data.carrierResult) {
      const tab = data.carrierResult.sheetTab || '';
      const sheetId = data.carrierResult.spreadsheetId || '';
      if (tabEl) {
        if (sheetId) {
          const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
          tabEl.innerHTML = `<a href="${sheetUrl}" target="_blank" style="color:#4caf50;font-size:9px;text-decoration:none" title="${carrier} 시트 ${tab} 탭에 등록됨">(${tab} 등록 &#8599;)</a>`;
        } else {
          tabEl.innerHTML = `<span style="color:#4caf50;font-size:9px">(${tab} 등록)</span>`;
        }
      }
    } else {
      // 시트 미지원 배송사
      if (tabEl) tabEl.remove();
    }
  } catch (err) {
    console.error('배송사 설정 에러:', err.message);
    const tabEl = document.getElementById(`carrier-tab-${rowIndex}`);
    if (tabEl) { tabEl.textContent = '(에러)'; tabEl.style.color = '#c62828'; }
  }
}

// ══════════════════════════════════════════════════════════
// B2B 인보이스 관리
// ══════════════════════════════════════════════════════════

var b2bInit = false;
var b2bBuyersCache = [];
var b2bInvoiceItems = [];

function setupB2BPage() {
  if (!b2bInit) {
    b2bInit = true;

    // 탭 전환
    document.querySelectorAll('.b2b-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.b2b-tab').forEach(t => {
          t.classList.remove('active');
          t.style.background = 'transparent'; t.style.color = '#666'; t.style.boxShadow = 'none';
        });
        btn.classList.add('active');
        btn.style.background = '#fff'; btn.style.color = '#1a1a2e'; btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';

        document.querySelectorAll('.b2b-tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active'); });
        const target = document.getElementById(btn.dataset.tab);
        if (target) { target.style.display = 'block'; target.classList.add('active'); }

        // 탭별 데이터 로드
        switch (btn.dataset.tab) {
          case 'b2b-list': loadB2BInvoiceList(); break;
          case 'b2b-buyers': loadB2BBuyers(); break;
          case 'b2b-revenue': loadB2BRevenue(); break;
        }
      });
    });

    // 상품 추가 버튼
    document.getElementById('b2bAddItemBtn').addEventListener('click', b2bAddItemRow);

    // Tax/Shipping 변경 시 합계 재계산
    ['b2bTax', 'b2bShipping'].forEach(id => {
      document.getElementById(id).addEventListener('input', b2bRecalcTotal);
    });

    // 인보이스 생성 버튼
    document.getElementById('b2bCreateBtn').addEventListener('click', b2bCreateInvoice);

    // 인보이스 목록 필터/새로고침
    document.getElementById('b2bListRefresh').addEventListener('click', loadB2BInvoiceList);
    document.getElementById('b2bListFilterBuyer').addEventListener('change', loadB2BInvoiceList);
    document.getElementById('b2bListFilterStatus').addEventListener('change', loadB2BInvoiceList);

    // 구매자 추가/취소/저장
    document.getElementById('b2bAddBuyerBtn').addEventListener('click', () => {
      document.getElementById('b2bBuyerForm').style.display = 'block';
      document.getElementById('b2bBuyerForm').dataset.editId = '';
    });
    document.getElementById('b2bBuyerCancelBtn').addEventListener('click', () => {
      document.getElementById('b2bBuyerForm').style.display = 'none';
    });
    document.getElementById('b2bBuyerSaveBtn').addEventListener('click', b2bSaveBuyer);
  }

  // 구매자 목록 로드 (셀렉트박스용)
  loadB2BBuyerSelect();
}

// ─── 구매자 셀렉트 로드 ───
async function loadB2BBuyerSelect() {
  try {
    const res = await fetch(`${API}/b2b/buyers`);
    const data = await res.json();
    b2bBuyersCache = data.buyers || [];

    const sel = document.getElementById('b2bBuyerSelect');
    sel.innerHTML = '<option value="">구매자 선택...</option>';
    b2bBuyersCache.forEach(b => {
      sel.innerHTML += `<option value="${b.BuyerID}">${b.Name} (${b.BuyerID})</option>`;
    });

    // 목록 필터 셀렉트도 업데이트
    const filterSel = document.getElementById('b2bListFilterBuyer');
    filterSel.innerHTML = '<option value="">전체 구매자</option>';
    b2bBuyersCache.forEach(b => {
      filterSel.innerHTML += `<option value="${b.BuyerID}">${b.Name}</option>`;
    });
  } catch (err) {
    console.error('B2B 구매자 로드 실패:', err);
  }
}

// ─── 상품 행 추가 ───
function b2bAddItemRow() {
  const emptyRow = document.querySelector('.b2b-empty-row');
  if (emptyRow) emptyRow.remove();

  const idx = b2bInvoiceItems.length;
  b2bInvoiceItems.push({ sku: '', name: '', qty: 1, price: 0 });

  const tbody = document.getElementById('b2bItemsBody');
  const tr = document.createElement('tr');
  tr.id = `b2b-item-${idx}`;
  tr.innerHTML = `
    <td><input type="text" data-idx="${idx}" data-field="sku" value="" placeholder="SKU" style="width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px"></td>
    <td><input type="text" data-idx="${idx}" data-field="name" value="" placeholder="상품명" style="width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px"></td>
    <td><input type="number" data-idx="${idx}" data-field="qty" value="1" min="1" style="width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;text-align:right"></td>
    <td><input type="number" data-idx="${idx}" data-field="price" value="0" min="0" step="0.01" style="width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;text-align:right"></td>
    <td style="text-align:right;font-weight:600" id="b2b-item-total-${idx}">0.00</td>
    <td><button onclick="b2bRemoveItem(${idx})" style="background:#e94560;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer">X</button></td>
  `;
  tbody.appendChild(tr);

  // 입력 이벤트
  tr.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.idx);
      const field = inp.dataset.field;
      if (field === 'qty') b2bInvoiceItems[i].qty = parseInt(inp.value) || 0;
      else if (field === 'price') b2bInvoiceItems[i].price = parseFloat(inp.value) || 0;
      else b2bInvoiceItems[i][field] = inp.value;
      b2bRecalcTotal();
    });
  });
}

function b2bRemoveItem(idx) {
  const tr = document.getElementById(`b2b-item-${idx}`);
  if (tr) tr.remove();
  b2bInvoiceItems[idx] = null;
  b2bRecalcTotal();
  // 모두 삭제되면 빈 행 표시
  if (b2bInvoiceItems.every(i => i === null)) {
    document.getElementById('b2bItemsBody').innerHTML = '<tr class="b2b-empty-row"><td colspan="6" class="empty">상품을 추가하세요</td></tr>';
    b2bInvoiceItems = [];
  }
}

function b2bRecalcTotal() {
  let subtotal = 0;
  b2bInvoiceItems.forEach((item, idx) => {
    if (!item) return;
    const t = (item.qty || 0) * (item.price || 0);
    subtotal += t;
    const el = document.getElementById(`b2b-item-total-${idx}`);
    if (el) el.textContent = t.toFixed(2);
  });

  const tax = parseFloat(document.getElementById('b2bTax').value) || 0;
  const shipping = parseFloat(document.getElementById('b2bShipping').value) || 0;

  document.getElementById('b2bSubtotal').textContent = subtotal.toFixed(2);
  document.getElementById('b2bTotal').textContent = (subtotal + tax + shipping).toFixed(2);
}

// ─── 인보이스 생성 ───
async function b2bCreateInvoice() {
  const buyerId = document.getElementById('b2bBuyerSelect').value;
  if (!buyerId) { alert('구매자를 선택하세요'); return; }

  const items = b2bInvoiceItems.filter(i => i && i.sku);
  if (items.length === 0) { alert('상품을 1개 이상 추가하세요'); return; }

  const btn = document.getElementById('b2bCreateBtn');
  btn.disabled = true; btn.textContent = '생성 중...';

  try {
    const body = {
      buyerId,
      items,
      tax: parseFloat(document.getElementById('b2bTax').value) || 0,
      shipping: parseFloat(document.getElementById('b2bShipping').value) || 0,
      currency: document.getElementById('b2bCurrency').value,
      dueDate: document.getElementById('b2bDueDate').value || undefined,
      notes: document.getElementById('b2bNotes').value,
    };

    const res = await fetch(`${API}/b2b/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.success) {
      const inv = data.invoice;
      document.getElementById('b2bCreateResult').innerHTML =
        `<div style="padding:10px;background:#e8f5e9;border-radius:6px;font-size:12px;color:#2e7d32">
          <strong>${inv.invoiceNo}</strong> 생성 완료! (${inv.currency} ${inv.total.toFixed(2)})
          ${inv.driveUrl ? `<a href="${inv.driveUrl}" target="_blank" style="margin-left:8px">Drive에서 보기</a>` : ''}
          <a href="${API}/b2b/invoices/${inv.invoiceNo}/download" style="margin-left:8px">다운로드</a>
        </div>`;

      // 폼 리셋
      b2bInvoiceItems = [];
      document.getElementById('b2bItemsBody').innerHTML = '<tr class="b2b-empty-row"><td colspan="6" class="empty">상품을 추가하세요</td></tr>';
      document.getElementById('b2bTax').value = '0';
      document.getElementById('b2bShipping').value = '0';
      document.getElementById('b2bNotes').value = '';
      b2bRecalcTotal();
    } else {
      document.getElementById('b2bCreateResult').innerHTML =
        `<div style="padding:10px;background:#ffebee;border-radius:6px;font-size:12px;color:#c62828">${data.error}</div>`;
    }
  } catch (err) {
    document.getElementById('b2bCreateResult').innerHTML =
      `<div style="padding:10px;background:#ffebee;border-radius:6px;font-size:12px;color:#c62828">${err.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '인보이스 생성';
  }
}

// ─── 인보이스 목록 ───
async function loadB2BInvoiceList() {
  const tbody = document.getElementById('b2bInvoiceListBody');
  tbody.innerHTML = '<tr><td colspan="7" class="empty">로딩 중...</td></tr>';

  try {
    const buyerId = document.getElementById('b2bListFilterBuyer').value;
    const status = document.getElementById('b2bListFilterStatus').value;
    let url = `${API}/b2b/invoices?`;
    if (buyerId) url += `buyerId=${buyerId}&`;
    if (status) url += `status=${status}&`;

    const res = await fetch(url);
    const data = await res.json();
    const invoices = data.invoices || [];

    if (invoices.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">인보이스 없음</td></tr>';
      return;
    }

    tbody.innerHTML = invoices.map(inv => {
      const statusColor = inv.Status === 'PAID' ? '#27ae60' : inv.Status === 'SENT' ? '#f39c12' : '#888';
      return `<tr>
        <td style="font-weight:600">${inv.InvoiceNo}</td>
        <td>${inv.BuyerName}</td>
        <td>${inv.Date}</td>
        <td>${inv.DueDate}</td>
        <td style="text-align:right;font-weight:600">${inv.Currency} ${inv.Total.toFixed(2)}</td>
        <td><span style="background:${statusColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600">${inv.Status}</span></td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <a href="${API}/b2b/invoices/${inv.InvoiceNo}/download" style="background:#0288d1;color:#fff;padding:3px 8px;border-radius:4px;font-size:10px;text-decoration:none;font-weight:600">XLSX</a>
            ${inv.Status !== 'PAID' ? `<button onclick="b2bMarkPaid('${inv.InvoiceNo}')" style="background:#27ae60;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:600">PAID</button>` : ''}
            <button onclick="b2bSendWhatsApp('${inv.InvoiceNo}')" style="background:#25d366;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;font-weight:600">WA</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty" style="color:#c62828">${err.message}</td></tr>`;
  }
}

async function b2bMarkPaid(invoiceNo) {
  try {
    await fetch(`${API}/b2b/invoices/${invoiceNo}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'PAID' }),
    });
    loadB2BInvoiceList();
  } catch (err) {
    alert('상태 변경 실패: ' + err.message);
  }
}

async function b2bSendWhatsApp(invoiceNo) {
  try {
    const res = await fetch(`${API}/b2b/invoices/${invoiceNo}/whatsapp`);
    const data = await res.json();
    if (data.success && data.link) {
      window.open(data.link, '_blank');
    } else {
      alert('WhatsApp 링크 생성 실패');
    }
  } catch (err) {
    alert('WhatsApp 에러: ' + err.message);
  }
}

// ─── 구매자 관리 ───
async function loadB2BBuyers() {
  const tbody = document.getElementById('b2bBuyerListBody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty">로딩 중...</td></tr>';

  try {
    const res = await fetch(`${API}/b2b/buyers`);
    const data = await res.json();
    const buyers = data.buyers || [];

    if (buyers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">등록된 구매자 없음</td></tr>';
      return;
    }

    tbody.innerHTML = buyers.map(b => `<tr>
      <td style="font-weight:600">${b.BuyerID}</td>
      <td>${b.Name}</td>
      <td style="font-size:11px">${b.Email}</td>
      <td style="font-size:11px">${b.WhatsApp}</td>
      <td>${b.Country}</td>
      <td>${b.PaymentTerms}</td>
      <td style="text-align:right">${b.TotalOrders}</td>
      <td style="text-align:right;font-weight:600">${Number(b.TotalRevenue).toFixed(2)}</td>
    </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty" style="color:#c62828">${err.message}</td></tr>`;
  }
}

async function b2bSaveBuyer() {
  const btn = document.getElementById('b2bBuyerSaveBtn');
  btn.disabled = true; btn.textContent = '저장 중...';

  try {
    const body = {
      name: document.getElementById('b2bBuyerName').value,
      email: document.getElementById('b2bBuyerEmail').value,
      whatsapp: document.getElementById('b2bBuyerWhatsapp').value,
      country: document.getElementById('b2bBuyerCountry').value,
      address: document.getElementById('b2bBuyerAddress').value,
      currency: document.getElementById('b2bBuyerCurrency').value,
      paymentTerms: document.getElementById('b2bBuyerTerms').value,
      notes: document.getElementById('b2bBuyerNotes').value,
    };

    const editId = document.getElementById('b2bBuyerForm').dataset.editId;
    if (editId) body.buyerId = editId;

    const res = await fetch(`${API}/b2b/buyers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('b2bBuyerForm').style.display = 'none';
      // 폼 리셋
      ['b2bBuyerName', 'b2bBuyerEmail', 'b2bBuyerWhatsapp', 'b2bBuyerCountry', 'b2bBuyerAddress', 'b2bBuyerNotes'].forEach(id => {
        document.getElementById(id).value = '';
      });
      loadB2BBuyers();
      loadB2BBuyerSelect();
    } else {
      alert('저장 실패: ' + data.error);
    }
  } catch (err) {
    alert('저장 에러: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '저장';
  }
}

// ─── 매출 분석 ───
async function loadB2BRevenue() {
  try {
    // 3개 API 병렬 호출
    const [revRes, rankRes, prodRes] = await Promise.all([
      fetch(`${API}/b2b/revenue`).then(r => r.json()),
      fetch(`${API}/b2b/revenue/ranking`).then(r => r.json()),
      fetch(`${API}/b2b/revenue/products`).then(r => r.json()),
    ]);

    // ── 요약 카드 ──
    if (revRes.success) {
      document.getElementById('b2bRevTotalInvoices').textContent = revRes.totalInvoices || 0;
      document.getElementById('b2bRevTotalRevenue').textContent = `$${(revRes.totalRevenue || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      document.getElementById('b2bRevOutstanding').textContent = revRes.totalOutstanding > 0
        ? `$${revRes.totalOutstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
        : '-';
      document.getElementById('b2bRevTotalBuyers').textContent = revRes.totalBuyers || 0;

      // 통화별 매출 표시
      const byCur = revRes.revenueByCurrency || [];
      document.getElementById('b2bRevByCurrency').innerHTML = byCur.map(c =>
        `${c.currency}: ${c.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      ).join(' | ');

      // 월별 매출
      const byMonth = revRes.byMonth || [];
      const monthBody = document.getElementById('b2bRevByMonthBody');
      if (byMonth.length === 0) {
        monthBody.innerHTML = '<tr><td colspan="4" class="empty">데이터 없음</td></tr>';
      } else {
        monthBody.innerHTML = byMonth.map(m => {
          const growthText = m.growth != null
            ? `<span style="color:${m.growth >= 0 ? '#27ae60' : '#e94560'}">${m.growth >= 0 ? '+' : ''}${m.growth}%</span>`
            : '-';
          return `<tr>
            <td style="font-weight:600">${m.month}</td>
            <td style="text-align:right">${m.count}</td>
            <td style="text-align:right;font-weight:600">$${m.total.toFixed(2)}</td>
            <td style="text-align:right">${growthText}</td>
          </tr>`;
        }).join('');
      }
    }

    // ── 바이어 순위 ──
    if (rankRes.success) {
      const ranking = rankRes.ranking || [];
      const rankBody = document.getElementById('b2bRankingBody');
      if (ranking.length === 0) {
        rankBody.innerHTML = '<tr><td colspan="7" class="empty">데이터 없음</td></tr>';
      } else {
        rankBody.innerHTML = ranking.filter(r => r.totalRevenue > 0).map(r => `<tr>
          <td style="font-weight:700;color:#0288d1">${r.rank}</td>
          <td style="font-weight:600">${r.buyerName}</td>
          <td style="text-align:right">${r.totalOrders}</td>
          <td style="text-align:right;color:#27ae60;font-weight:700">${r.currency === 'KRW' ? '\u20A9' : '$'}${r.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td style="text-align:right">${r.currency === 'KRW' ? '\u20A9' : '$'}${r.avgOrderValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td style="font-size:11px;color:#666">${r.lastOrderDate || '-'}</td>
          <td><button onclick="loadBuyerProducts('${r.buyerId}','${r.buyerName}')" style="padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;font-size:11px;cursor:pointer">상품</button></td>
        </tr>`).join('');
      }
    }

    // ── 상품 판매 순위 ──
    if (prodRes.success) {
      const products = (prodRes.products || []).slice(0, 30);
      const prodBody = document.getElementById('b2bProductStatsBody');
      if (products.length === 0) {
        prodBody.innerHTML = '<tr><td colspan="6" class="empty">데이터 없음</td></tr>';
      } else {
        prodBody.innerHTML = products.map((p, i) => `<tr>
          <td style="font-weight:700;color:#0288d1">${i + 1}</td>
          <td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.name}">${p.name}</td>
          <td style="text-align:right">${p.totalQty}</td>
          <td style="text-align:right;color:#27ae60;font-weight:600">$${p.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
          <td style="text-align:right">${p.orderCount}</td>
          <td style="font-size:11px;color:#666;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.buyers.join(', ')}">${p.buyers.slice(0, 3).join(', ')}${p.buyers.length > 3 ? ' ...' : ''}</td>
        </tr>`).join('');
      }
    }
  } catch (err) {
    console.error('B2B revenue load failed:', err);
  }
}

// 바이어별 구매 상품 조회
async function loadBuyerProducts(buyerId, buyerName) {
  try {
    const res = await fetch(`${API}/b2b/revenue/products?buyerId=${buyerId}`);
    const data = await res.json();
    if (!data.success) return;

    const card = document.getElementById('b2bBuyerProductsCard');
    card.style.display = 'block';
    document.getElementById('b2bBuyerProductsTitle').textContent = `${buyerName} - 구매 상품`;

    const products = data.products || [];
    const body = document.getElementById('b2bBuyerProductsBody');
    if (products.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="empty">상품 데이터 없음</td></tr>';
    } else {
      body.innerHTML = products.map(p => `<tr>
        <td style="font-weight:600">${p.name}</td>
        <td style="text-align:right">${p.totalQty}</td>
        <td style="text-align:right;color:#27ae60;font-weight:600">$${p.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
      </tr>`).join('');
    }

    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('Buyer products load failed:', err);
  }
}

// ===== 자동화 (ccorea-auto 연동) =====

const AUTO_API = `${API}/auto`;
var autoSelectedProductIds = [];

async function loadAutomationPage() {
  setupAutoTabs();
  await checkAutoServerStatus();
  await loadAutoListings();
  setupAutoEvents();
}

function setupAutoTabs() {
  document.querySelectorAll('.auto-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auto-tab').forEach(t => {
        t.classList.remove('active');
        t.style.background = 'transparent';
        t.style.color = '#666';
        t.style.boxShadow = 'none';
      });
      tab.classList.add('active');
      tab.style.background = '#fff';
      tab.style.color = '#1a1a2e';
      tab.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
      document.querySelectorAll('.auto-tab-content').forEach(c => {
        c.style.display = 'none';
        c.classList.remove('active');
      });
      const target = document.getElementById(tab.dataset.tab);
      if (target) { target.style.display = 'block'; target.classList.add('active'); }
    });
  });
}

async function checkAutoServerStatus() {
  const el = document.getElementById('autoServerStatus');
  try {
    const res = await fetch(`${AUTO_API}/products?limit=1`);
    if (res.ok) {
      el.textContent = '정상';
      el.style.color = '#27ae60';
    } else {
      el.textContent = '오류';
      el.style.color = '#e94560';
    }
  } catch {
    el.textContent = '오프라인';
    el.style.color = '#e94560';
  }
}

async function loadAutoListings(filter = 'all', page = 1) {
  const body = document.getElementById('autoListingsBody');
  try {
    const params = new URLSearchParams({ limit: '50', offset: String((page - 1) * 50) });
    if (filter !== 'all') params.set('status', filter);
    const res = await fetch(`${AUTO_API}/listings?${params}`);
    if (!res.ok) throw new Error('Failed to load listings');
    const data = await res.json();
    const listings = data.listings || data || [];

    // Update summary counts
    updateAutoSummary(listings);

    if (!listings.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">리스팅 데이터 없음</td></tr>';
      return;
    }

    body.innerHTML = listings.map(l => {
      const statusColors = { active: '#27ae60', pending: '#ff9800', error: '#e94560', ended: '#888', draft: '#666' };
      const statusLabels = { active: '활성', pending: '대기', error: '실패', ended: '종료', draft: '초안' };
      const color = statusColors[l.status] || '#888';
      const label = statusLabels[l.status] || l.status;
      return `<tr>
        <td><input type="checkbox" class="auto-listing-check" data-id="${l.id}" data-product-id="${l.productId}"></td>
        <td style="font-weight:600">${l.sku || l.platformSku || '-'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.title || '-'}</td>
        <td><span class="badge" style="background:${l.platform === 'ebay' ? '#1565c0' : l.platform === 'shopify' ? '#96bf48' : '#666'};color:#fff;padding:2px 8px;border-radius:4px;font-size:10px">${l.platform}</span></td>
        <td style="text-align:right;font-weight:600">$${(l.price || 0).toFixed(2)}</td>
        <td><span style="color:${color};font-weight:600;font-size:11px">${label}</span></td>
        <td style="font-size:11px;color:#888">${l.createdAt ? new Date(l.createdAt).toLocaleDateString('ko-KR') : '-'}</td>
        <td>
          ${l.status === 'error' ? `<button onclick="retryAutoListing('${l.id}')" style="background:#e94560;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer">재시도</button>` : ''}
          ${l.status === 'active' ? `<button onclick="endAutoListing('${l.id}')" style="background:#888;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer">종료</button>` : ''}
          ${l.listingUrl ? `<a href="${l.listingUrl}" target="_blank" style="color:#0288d1;font-size:10px;text-decoration:none">보기</a>` : ''}
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty" style="color:#e94560">${err.message}</td></tr>`;
  }
}

function updateAutoSummary(listings) {
  if (!Array.isArray(listings)) return;
  const counts = { total: listings.length, active: 0, pending: 0, error: 0 };
  listings.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
  const el = (id) => document.getElementById(id);
  if (el('autoTotalListings')) el('autoTotalListings').textContent = counts.total.toLocaleString();
  if (el('autoActiveListings')) el('autoActiveListings').textContent = counts.active.toLocaleString();
  if (el('autoPendingListings')) el('autoPendingListings').textContent = counts.pending.toLocaleString();
  if (el('autoErrorListings')) el('autoErrorListings').textContent = counts.error.toLocaleString();
}

function setupAutoEvents() {
  // Listing filter
  const filterEl = document.getElementById('autoListingFilter');
  if (filterEl) filterEl.addEventListener('change', () => loadAutoListings(filterEl.value));

  // Create listings button
  const createBtn = document.getElementById('autoCreateListingsBtn');
  if (createBtn) createBtn.addEventListener('click', () => createAutoListings(false));

  // Dry run button
  const dryBtn = document.getElementById('autoDryRunBtn');
  if (dryBtn) dryBtn.addEventListener('click', () => createAutoListings(true));

  // Retry all failed
  const retryBtn = document.getElementById('autoRetryAllBtn');
  if (retryBtn) retryBtn.addEventListener('click', retryAllAutoListings);

  // Inventory sync
  const syncBtn = document.getElementById('autoSyncInventoryBtn');
  if (syncBtn) syncBtn.addEventListener('click', syncAutoInventory);

  // Platform checkboxes
  loadAutoPlatformCheckboxes();

  // CSV upload
  setupAutoCsvUpload();

  // Product search
  const searchEl = document.getElementById('autoProductSearch');
  if (searchEl) {
    let searchTimeout;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => searchAutoProducts(searchEl.value), 400);
    });
  }

  // Select all checkbox
  const selectAll = document.getElementById('autoSelectAll');
  if (selectAll) selectAll.addEventListener('change', (e) => {
    document.querySelectorAll('.auto-listing-check').forEach(cb => cb.checked = e.target.checked);
  });
}

async function loadAutoPlatformCheckboxes() {
  const container = document.getElementById('autoPlatformCheckboxes');
  if (!container) return;
  try {
    const res = await fetch(`${API}/platform-registry`);
    const data = await res.json();
    const platforms = data.platforms || [];
    container.innerHTML = platforms
      .filter(p => ['ebay', 'shopify', 'alibaba', 'shopee'].includes(p.key))
      .map(p => `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:4px 8px;border:1px solid #ddd;border-radius:6px">
        <input type="checkbox" class="auto-platform-check" value="${p.key}" checked> ${p.display_name}
      </label>`).join('');
  } catch { container.innerHTML = '<span style="color:#e94560;font-size:11px">플랫폼 로드 실패</span>'; }
}

async function searchAutoProducts(query) {
  if (!query || query.length < 2) { document.getElementById('autoSelectedProducts').innerHTML = ''; return; }
  try {
    const res = await fetch(`${AUTO_API}/products?search=${encodeURIComponent(query)}&limit=10`);
    const data = await res.json();
    const products = data.products || data || [];
    const container = document.getElementById('autoSelectedProducts');
    container.innerHTML = products.map(p =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin:2px 4px;padding:4px 8px;background:#f0f2f5;border-radius:4px;cursor:pointer">
        <input type="checkbox" class="auto-product-check" value="${p.id}" data-sku="${p.sku}"> ${p.sku} - ${(p.title || '').slice(0, 30)}
      </label>`
    ).join('');
  } catch (err) { console.error('Product search error:', err); }
}

async function createAutoListings(dryRun = false) {
  const checkedProducts = document.querySelectorAll('.auto-product-check:checked');
  const checkedPlatforms = document.querySelectorAll('.auto-platform-check:checked');

  if (!checkedProducts.length) return alert('상품을 선택해주세요');
  if (!checkedPlatforms.length) return alert('플랫폼을 선택해주세요');

  const productIds = Array.from(checkedProducts).map(cb => Number(cb.value));
  const platforms = Array.from(checkedPlatforms).map(cb => cb.value);

  const progressContainer = document.getElementById('autoProgressContainer');
  progressContainer.style.display = 'block';

  try {
    const res = await fetch(`${AUTO_API}/listings/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds, platforms, dryRun })
    });
    const data = await res.json();

    if (data.jobId) {
      streamAutoJobProgress(data.jobId);
    } else {
      document.getElementById('autoProgressText').textContent = dryRun ? '테스트 완료' : '등록 완료';
      document.getElementById('autoProgressBar').style.width = '100%';
      setTimeout(() => loadAutoListings(), 1000);
    }
  } catch (err) {
    document.getElementById('autoProgressText').textContent = `오류: ${err.message}`;
    document.getElementById('autoProgressBar').style.width = '100%';
    document.getElementById('autoProgressBar').style.background = '#e94560';
  }
}

function streamAutoJobProgress(jobId) {
  const es = new EventSource(`${AUTO_API}/listings/stream/${jobId}`);
  const progressText = document.getElementById('autoProgressText');
  const progressCount = document.getElementById('autoProgressCount');
  const progressBar = document.getElementById('autoProgressBar');

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const { completed = 0, failed = 0, total = 1, status } = data;
      const done = completed + failed;
      const pct = Math.round((done / total) * 100);

      progressText.textContent = status === 'running' ? `등록 진행 중... (성공: ${completed}, 실패: ${failed})` : '완료!';
      progressCount.textContent = `${done}/${total}`;
      progressBar.style.width = `${pct}%`;

      if (status !== 'running') {
        es.close();
        setTimeout(() => loadAutoListings(), 1000);
      }
    } catch {}
  };

  es.onerror = () => {
    es.close();
    progressText.textContent = '스트림 연결 끊김 — 새로고침 해주세요';
  };
}

async function retryAutoListing(listingId) {
  try {
    await fetch(`${AUTO_API}/listings/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingIds: [listingId] })
    });
    loadAutoListings();
  } catch (err) { alert('재시도 실패: ' + err.message); }
}

async function endAutoListing(listingId) {
  if (!confirm('이 리스팅을 종료하시겠습니까?')) return;
  try {
    await fetch(`${AUTO_API}/listings/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingIds: [listingId] })
    });
    loadAutoListings();
  } catch (err) { alert('종료 실패: ' + err.message); }
}

async function retryAllAutoListings() {
  const checked = document.querySelectorAll('.auto-listing-check:checked');
  const ids = Array.from(checked).map(cb => cb.dataset.id);
  if (!ids.length) return alert('재시도할 리스팅을 선택해주세요');
  try {
    await fetch(`${AUTO_API}/listings/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingIds: ids })
    });
    loadAutoListings();
  } catch (err) { alert('일괄 재시도 실패: ' + err.message); }
}

async function syncAutoInventory() {
  const resultEl = document.getElementById('autoSyncResult');
  const btn = document.getElementById('autoSyncInventoryBtn');
  btn.disabled = true;
  btn.textContent = '동기화 중...';
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="color:#0288d1;font-size:12px">재고 동기화 진행 중...</div>';

  try {
    const res = await fetch(`${AUTO_API}/listings/sync-inventory`, { method: 'POST' });
    const data = await res.json();
    const results = data.results || [];
    resultEl.innerHTML = results.map(r =>
      `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid #f0f2f5">
        <strong>${r.platform}</strong>: ${r.updated || 0}개 업데이트, ${r.unchanged || 0}개 변동없음
      </div>`
    ).join('') || '<div style="color:#27ae60;font-size:12px">동기화 완료</div>';
  } catch (err) {
    resultEl.innerHTML = `<div style="color:#e94560;font-size:12px">오류: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '수동 동기화';
  }
}

function setupAutoCsvUpload() {
  const dropzone = document.getElementById('autoCsvDropzone');
  const fileInput = document.getElementById('autoCsvFileInput');
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = '#ff5722'; });
  dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#ddd'; });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = '#ddd';
    if (e.dataTransfer.files.length) handleAutoCsvFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files.length) handleAutoCsvFile(fileInput.files[0]); });

  const importBtn = document.getElementById('autoCsvImportBtn');
  if (importBtn) importBtn.addEventListener('click', importAutoCsv);
  const cancelBtn = document.getElementById('autoCsvCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    document.getElementById('autoCsvPreview').style.display = 'none';
  });
}

var autoCsvData = null;

function handleAutoCsvFile(file) {
  if (!file.name.endsWith('.csv')) return alert('CSV 파일만 업로드 가능합니다');
  document.getElementById('autoCsvFileName').textContent = file.name;
  autoCsvData = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    const lines = e.target.result.split('\n').filter(l => l.trim());
    document.getElementById('autoCsvRowCount').textContent = `${lines.length - 1}개 행`;
    const headers = lines[0].split(',').map(h => h.trim());
    const preview = lines.slice(1, 6);

    const table = document.getElementById('autoCsvPreviewTable');
    table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${preview.map(row => `<tr>${row.split(',').map(c => `<td>${c.trim()}</td>`).join('')}</tr>`).join('')}</tbody>`;
    document.getElementById('autoCsvPreview').style.display = 'block';
  };
  reader.readAsText(file);
}

async function importAutoCsv() {
  if (!autoCsvData) return;
  const formData = new FormData();
  formData.append('file', autoCsvData);

  const btn = document.getElementById('autoCsvImportBtn');
  btn.disabled = true;
  btn.textContent = '업로드 중...';

  try {
    const res = await fetch(`${AUTO_API}/upload/csv`, { method: 'POST', body: formData });
    const data = await res.json();
    alert(`업로드 완료: ${data.imported || data.rowCount || 0}개 등록`);
    document.getElementById('autoCsvPreview').style.display = 'none';
    autoCsvData = null;
  } catch (err) {
    alert('업로드 실패: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'DB에 등록';
  }
}

// ===== 크롤링 결과 =====

async function loadCrawlResultsPage() {
  setupCrawlEvents();
  await loadCrawlResults();
}

function setupCrawlEvents() {
  const filterEl = document.getElementById('crawlStatusFilter');
  if (filterEl) filterEl.addEventListener('change', () => loadCrawlResults(filterEl.value));

  const importBtn = document.getElementById('crawlImportSelectedBtn');
  if (importBtn) importBtn.addEventListener('click', importSelectedCrawlResults);

  const selectAll = document.getElementById('crawlSelectAll');
  if (selectAll) selectAll.addEventListener('change', (e) => {
    document.querySelectorAll('.crawl-result-check').forEach(cb => cb.checked = e.target.checked);
  });
}

async function loadCrawlResults(status = 'all', page = 1) {
  const body = document.getElementById('crawlResultsBody');
  try {
    const params = new URLSearchParams({ limit: '50', offset: String((page - 1) * 50) });
    if (status !== 'all') params.set('status', status);
    const res = await fetch(`${AUTO_API}/crawl-results?${params}`);
    if (!res.ok) throw new Error('Failed to load crawl results');
    const data = await res.json();
    const results = data.results || data || [];

    if (!results.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">크롤링 결과 없음</td></tr>';
      return;
    }

    body.innerHTML = results.map(r => {
      const statusColors = { 'new': '#0288d1', reviewed: '#ff9800', imported: '#27ae60', ignored: '#888' };
      const statusLabels = { 'new': '신규', reviewed: '검토됨', imported: '등록됨', ignored: '무시됨' };
      const img = r.imageUrl || r.image_url || '';
      return `<tr>
        <td><input type="checkbox" class="crawl-result-check" value="${r.id}"></td>
        <td>${img ? `<img src="${img}" style="width:40px;height:40px;object-fit:cover;border-radius:4px" onerror="this.style.display='none'">` : '-'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.title || r.name || '-'}</td>
        <td style="font-size:11px">${r.sourceName || r.source_platform || '-'}</td>
        <td style="text-align:right;font-weight:600">${(r.price || 0).toLocaleString()}</td>
        <td><span style="color:${statusColors[r.status] || '#888'};font-weight:600;font-size:11px">${statusLabels[r.status] || r.status}</span></td>
        <td style="font-size:11px;color:#888">${r.createdAt ? new Date(r.createdAt).toLocaleDateString('ko-KR') : '-'}</td>
        <td>
          ${r.status === 'new' || r.status === 'reviewed' ? `<button onclick="importCrawlResult('${r.id}')" style="background:#ff5722;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer">가져오기</button>` : ''}
          ${r.url || r.sourceUrl ? `<a href="${r.url || r.sourceUrl}" target="_blank" style="color:#0288d1;font-size:10px;text-decoration:none;margin-left:4px">원본</a>` : ''}
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty" style="color:#e94560">자동화 서버 연결 실패: ${err.message}</td></tr>`;
  }
}

async function importCrawlResult(crawlResultId) {
  try {
    const res = await fetch(`${AUTO_API}/listings/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawlResultIds: [crawlResultId] })
    });
    if (!res.ok) throw new Error('Import failed');
    alert('상품 가져오기 완료');
    loadCrawlResults(document.getElementById('crawlStatusFilter')?.value || 'all');
  } catch (err) { alert('가져오기 실패: ' + err.message); }
}

async function importSelectedCrawlResults() {
  const checked = document.querySelectorAll('.crawl-result-check:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (!ids.length) return alert('가져올 항목을 선택해주세요');

  try {
    const res = await fetch(`${AUTO_API}/listings/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawlResultIds: ids })
    });
    if (!res.ok) throw new Error('Import failed');
    alert(`${ids.length}개 상품 가져오기 완료`);
    loadCrawlResults(document.getElementById('crawlStatusFilter')?.value || 'all');
  } catch (err) { alert('일괄 가져오기 실패: ' + err.message); }
}
