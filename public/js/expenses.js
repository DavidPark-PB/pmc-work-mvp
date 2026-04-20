/**
 * 지출 관리 (Phase 1 Day 1) — 수동 등록 + 월별 목록 + 카테고리 합계.
 * CSV 업로드와 정기결제 UI는 다음 증분에서 같은 페이지에 탭으로 추가 예정.
 */
(function() {
  let user = null;
  let refreshTimer = null;
  let categories = [];
  let categoryMap = {};
  let currentMonth = '';
  let cached = [];

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(n, ccy) {
    if (n == null || isNaN(n)) return '-';
    const v = Number(n);
    if (ccy === 'KRW') return v.toLocaleString('ko-KR') + '원';
    if (ccy === 'USD') return '$' + v.toFixed(2);
    return v.toLocaleString('ko-KR') + ' ' + (ccy || '');
  }
  function dt(iso) {
    if (!iso) return '';
    return String(iso).slice(0, 10);
  }
  function thisMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user) return;
    if (categories.length === 0) {
      try {
        const res = await fetch('/api/expenses/categories');
        const j = await res.json();
        categories = j.categories || [];
        categoryMap = Object.fromEntries(categories.map(c => [c.key, c]));
      } catch (e) {
        console.warn('categories load fail', e);
      }
    }
    if (!currentMonth) currentMonth = thisMonth();
    renderShell();
    await refresh();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.getElementById('page-expenses').classList.contains('active')) refresh();
    }, 60000);
  }

  function renderShell() {
    const el = document.getElementById('page-expenses');
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">💸 지출 관리 <span style="font-size:13px;color:#888;font-weight:400;">· 재무 기반</span></h1>
        <p style="color:#888;font-size:13px;">카드 결제·정기결제·현금 지출을 한 곳에 기록하세요. 같은 가맹점 다음 지출부턴 카테고리 자동 분류됩니다.</p>
      </div>

      <!-- 등록 폼 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">✏️ 지출 등록</h3>
        <form id="exp-form">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:8px;">
            <div>
              <label style="font-size:11px;color:#888;">결제일</label>
              <input type="date" id="exp-paid-at" required style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            </div>
            <div>
              <label style="font-size:11px;color:#888;">금액</label>
              <input type="number" id="exp-amount" step="0.01" required placeholder="0" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            </div>
            <div>
              <label style="font-size:11px;color:#888;">통화</label>
              <select id="exp-currency" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
                <option value="KRW" selected>KRW</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="JPY">JPY</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;">카테고리</label>
              <select id="exp-category" required style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
                ${categories.map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:#888;">카드 뒷자리</label>
              <input type="text" id="exp-card" maxlength="4" placeholder="1234" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-bottom:8px;">
            <input type="text" id="exp-merchant" placeholder="가맹점/거래처 (선택)" maxlength="200" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
            <input type="text" id="exp-memo" placeholder="메모 (선택)" maxlength="500" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button type="submit" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
            <span style="color:#666;font-size:11px;">같은 가맹점 재등록 시 카테고리 자동 추천 (곧 지원)</span>
          </div>
        </form>
      </div>

      <!-- 월 선택 + 요약 카드 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
          <input type="month" id="exp-month" value="${currentMonth}" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          <div id="exp-totals" style="flex:1;color:#e0e0e0;font-size:13px;"></div>
        </div>
        <div id="exp-category-bars"></div>
      </div>

      <!-- 목록 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:14px 16px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📋 지출 내역</h3>
          <select id="exp-filter-cat" style="padding:6px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
            <option value="">전체 카테고리</option>
            ${categories.map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}
          </select>
        </div>
        <div id="exp-list"></div>
      </div>
    `;

    document.getElementById('exp-paid-at').value = today();
    document.getElementById('exp-form').addEventListener('submit', submit);
    document.getElementById('exp-month').addEventListener('change', (e) => {
      currentMonth = e.target.value || thisMonth();
      refresh();
    });
    document.getElementById('exp-filter-cat').addEventListener('change', refresh);
  }

  async function refresh() {
    const cat = document.getElementById('exp-filter-cat')?.value || '';
    const from = currentMonth + '-01';
    const [y, m] = currentMonth.split('-').map(n => parseInt(n, 10));
    const lastDay = new Date(y, m, 0).getDate();
    const to = currentMonth + '-' + String(lastDay).padStart(2, '0');

    const params = new URLSearchParams();
    params.set('from', from);
    params.set('to', to);
    if (cat) params.set('category', cat);

    const [listRes, sumRes] = await Promise.all([
      fetch('/api/expenses?' + params),
      fetch('/api/expenses/summary?month=' + currentMonth),
    ]);
    const list = await listRes.json();
    const sum = await sumRes.json();
    cached = list.data || [];
    renderTotals(sum);
    renderList();
  }

  function renderTotals(sum) {
    const tot = document.getElementById('exp-totals');
    const bars = document.getElementById('exp-category-bars');
    if (!tot || !bars) return;

    const totals = sum.totals || {};
    if (Object.keys(totals).length === 0) {
      tot.innerHTML = '<span style="color:#666;">이번달 지출 없음</span>';
      bars.innerHTML = '';
      return;
    }

    tot.innerHTML = '이번달 총 지출: ' + Object.entries(totals).map(([ccy, v]) =>
      `<strong style="color:#ff8a80;">${money(v, ccy)}</strong>`
    ).join(' · ');

    // 카테고리별 바 (KRW 기준, 통화 혼용시 KRW 없으면 첫 통화)
    const byCat = sum.byCategory || {};
    const primaryCcy = totals['KRW'] ? 'KRW' : Object.keys(totals)[0];
    const catTotals = Object.entries(byCat).map(([cat, perCcy]) => ({
      category: cat,
      amount: perCcy[primaryCcy] || 0,
    })).filter(x => x.amount > 0).sort((a, b) => b.amount - a.amount);

    if (catTotals.length === 0) { bars.innerHTML = ''; return; }
    const max = catTotals[0].amount;
    bars.innerHTML = catTotals.map(c => {
      const info = categoryMap[c.category] || { label: c.category, color: '#8d6e63' };
      const pct = Math.max(5, Math.round((c.amount / max) * 100));
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12px;">
          <span style="width:90px;color:#ccc;">${esc(info.label)}</span>
          <div style="flex:1;height:10px;background:#0f0f23;border-radius:5px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${info.color};"></div>
          </div>
          <span style="width:120px;text-align:right;color:#ccc;">${money(c.amount, primaryCcy)}</span>
        </div>
      `;
    }).join('');
  }

  function renderList() {
    const c = document.getElementById('exp-list');
    if (!c) return;
    if (cached.length === 0) {
      c.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">이달 등록된 지출이 없습니다.</div>';
      return;
    }
    c.innerHTML = cached.map(e => {
      const info = categoryMap[e.category] || { label: e.category, color: '#8d6e63' };
      const srcLabel = { manual: '수동', csv: 'CSV', recurring: '정기' }[e.source] || e.source;
      const canEdit = user.isAdmin || e.createdBy === user.id;
      const canDelete = user.isAdmin;
      return `
        <div style="padding:12px 16px;border-bottom:1px solid #2a2a4a;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <div style="font-size:11px;color:#888;min-width:80px;">${esc(dt(e.paidAt))}</div>
          <div style="min-width:90px;">
            <span style="padding:2px 8px;background:${info.color};color:#fff;border-radius:10px;font-size:11px;">${esc(info.label)}</span>
          </div>
          <div style="flex:1;min-width:120px;color:#fff;font-size:13px;">
            ${esc(e.merchant || '-')}
            ${e.memo ? `<span style="color:#999;font-size:11px;"> · ${esc(e.memo)}</span>` : ''}
          </div>
          <div style="min-width:120px;text-align:right;color:#ff8a80;font-weight:600;font-size:14px;">${money(e.amount, e.currency)}</div>
          <div style="min-width:50px;font-size:10px;color:#666;">${esc(srcLabel)}${e.cardLast4 ? ' ·' + esc(e.cardLast4) : ''}</div>
          <div style="display:flex;gap:4px;">
            ${canEdit ? `<button onclick="pmcExpenses.edit(${e.id})" style="padding:4px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✏️</button>` : ''}
            ${canDelete ? `<button onclick="pmcExpenses.del(${e.id})" style="padding:4px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  async function submit(e) {
    e.preventDefault();
    const payload = {
      paidAt: document.getElementById('exp-paid-at').value,
      amount: document.getElementById('exp-amount').value,
      currency: document.getElementById('exp-currency').value,
      category: document.getElementById('exp-category').value,
      merchant: document.getElementById('exp-merchant').value.trim(),
      memo: document.getElementById('exp-memo').value.trim(),
      cardLast4: document.getElementById('exp-card').value.trim() || null,
    };
    const res = await fetch('/api/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '저장 실패'); return; }
    document.getElementById('exp-form').reset();
    document.getElementById('exp-paid-at').value = today();
    document.getElementById('exp-currency').value = 'KRW';
    refresh();
  }

  async function edit(id) {
    const exp = cached.find(x => x.id === id);
    if (!exp) return;
    const newAmount = prompt('금액 수정', exp.amount);
    if (newAmount === null) return;
    const num = Number(newAmount);
    if (!Number.isFinite(num)) { alert('숫자를 입력하세요'); return; }
    const res = await fetch('/api/expenses/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: num }),
    });
    if (!res.ok) { alert((await res.json()).error || '수정 실패'); return; }
    refresh();
  }

  async function del(id) {
    if (!confirm('이 지출을 삭제하시겠습니까?')) return;
    const res = await fetch('/api/expenses/' + id, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    refresh();
  }

  window.pmcExpenses = { load, refresh, edit, del };
})();
