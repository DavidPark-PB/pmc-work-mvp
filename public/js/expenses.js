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
    const hasFinance = user.canManageFinance;
    const title = hasFinance ? '💸 지출 관리' : '💸 내 지출 등록';
    const desc = hasFinance
      ? '전 직원 지출을 확인·편집·삭제할 수 있습니다. 직원이 등록한 지출을 승인·확정하세요.'
      : '발주/구매한 금액과 영수증을 등록하세요. 재무 담당이 확인 후 승인합니다. 본인이 등록한 내역만 보입니다.';
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;">${title} <span style="font-size:13px;color:${hasFinance ? '#81c784' : '#888'};font-weight:400;">· ${hasFinance ? '재무 권한' : '본인 등록분만'}</span></h1>
        <p style="color:#888;font-size:13px;">${desc}</p>
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
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
            <label style="padding:7px 14px;background:#2a4a6a;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;">
              📎 영수증 첨부 (선택)
              <input type="file" id="exp-receipt" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" style="display:none" onchange="pmcExpenses.onReceiptPick()">
            </label>
            <span id="exp-receipt-name" style="color:#888;font-size:11px;"></span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button type="submit" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
            <span style="color:#666;font-size:11px;">사진/PDF · 최대 10MB · 같은 가맹점 재등록 시 카테고리 자동 추천</span>
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
      const canEdit = user.canManageFinance || e.createdBy === user.id;
      const canDelete = user.canManageFinance || e.createdBy === user.id;
      const canReceipt = user.canManageFinance || e.createdBy === user.id;
      let receiptBtn = '';
      if (e.hasReceipt) {
        receiptBtn = `<button onclick="pmcExpenses.viewReceipt(${e.id})" title="${esc(e.receiptName || '영수증')}" style="padding:4px 8px;background:#0f2a3a;border:1px solid #1565c0;border-radius:4px;color:#64b5f6;cursor:pointer;font-size:11px;">📎 영수증</button>`;
        if (canReceipt) receiptBtn += `<button onclick="pmcExpenses.deleteReceipt(${e.id})" title="영수증 삭제" style="padding:4px 6px;background:transparent;border:0;color:#666;cursor:pointer;font-size:11px;">✕</button>`;
      } else if (canReceipt) {
        receiptBtn = `<button onclick="pmcExpenses.uploadReceiptLater(${e.id})" style="padding:4px 8px;background:#2a2a4a;border:1px dashed #555;border-radius:4px;color:#888;cursor:pointer;font-size:11px;">📎 첨부</button>`;
      }
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
          <div style="display:flex;gap:4px;align-items:center;">
            ${receiptBtn}
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
    const { data: created } = await res.json();

    // 영수증 파일이 있으면 뒤이어 업로드
    const receiptInput = document.getElementById('exp-receipt');
    const file = receiptInput?.files?.[0];
    if (file && created?.id) {
      const fd = new FormData();
      fd.append('file', file);
      const upRes = await fetch('/api/expenses/' + created.id + '/receipt', { method: 'POST', body: fd });
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        alert('지출은 저장됐지만 영수증 업로드 실패: ' + (err.error || ''));
      }
    }

    document.getElementById('exp-form').reset();
    document.getElementById('exp-paid-at').value = today();
    document.getElementById('exp-currency').value = 'KRW';
    document.getElementById('exp-receipt-name').textContent = '';
    refresh();
  }

  function onReceiptPick() {
    const input = document.getElementById('exp-receipt');
    const label = document.getElementById('exp-receipt-name');
    const f = input?.files?.[0];
    if (!f) { label.textContent = ''; return; }
    const sz = f.size < 1024 * 1024 ? (f.size / 1024).toFixed(1) + ' KB' : (f.size / 1024 / 1024).toFixed(1) + ' MB';
    label.innerHTML = '📎 ' + (f.name || '') + ' <span style="color:#666">(' + sz + ')</span>';
  }

  async function viewReceipt(id) {
    try {
      const res = await fetch('/api/expenses/' + id + '/receipt/url');
      const data = await res.json();
      if (!res.ok) { alert(data.error || '영수증 조회 실패'); return; }
      window.open(data.signedUrl, '_blank');
    } catch (e) { alert('실패: ' + e.message); }
  }

  async function deleteReceipt(id) {
    if (!confirm('영수증을 삭제하시겠습니까?')) return;
    const res = await fetch('/api/expenses/' + id + '/receipt', { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    refresh();
  }

  async function uploadReceiptLater(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/expenses/' + id + '/receipt', { method: 'POST', body: fd });
      if (!res.ok) { alert((await res.json()).error || '업로드 실패'); return; }
      refresh();
    };
    input.click();
  }

  function edit(id) {
    const exp = cached.find(x => x.id === id);
    if (!exp) return;
    openEditModal(exp);
  }

  function openEditModal(exp) {
    const prev = document.getElementById('exp-edit-modal');
    if (prev) prev.remove();

    const cardOptions = ['KRW', 'USD', 'EUR', 'JPY'].map(c =>
      `<option value="${c}" ${exp.currency === c ? 'selected' : ''}>${c}</option>`
    ).join('');
    const catOptions = categories.map(c =>
      `<option value="${esc(c.key)}" ${exp.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`
    ).join('');

    const m = document.createElement('div');
    m.id = 'exp-edit-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:22px;width:500px;max-width:95vw;color:#e0e0e0;">
        <h3 style="color:#fff;font-size:15px;margin:0 0 14px;">✏️ 지출 수정</h3>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px;">
          <div>
            <label style="font-size:11px;color:#aaa;">결제일</label>
            <input type="date" id="ee-paid-at" value="${esc(exp.paidAt || '')}" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#aaa;">금액</label>
            <input type="number" id="ee-amount" step="0.01" value="${esc(String(exp.amount))}" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          </div>
          <div>
            <label style="font-size:11px;color:#aaa;">통화</label>
            <select id="ee-currency" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">${cardOptions}</select>
          </div>
          <div>
            <label style="font-size:11px;color:#aaa;">카테고리</label>
            <select id="ee-category" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">${catOptions}</select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 100px;gap:8px;margin-bottom:8px;">
          <input type="text" id="ee-merchant" maxlength="200" placeholder="가맹점/거래처" value="${esc(exp.merchant || '')}" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
          <input type="text" id="ee-card" maxlength="4" placeholder="카드 뒤4자리" value="${esc(exp.cardLast4 || '')}" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;">
        </div>
        <input type="text" id="ee-memo" maxlength="500" placeholder="메모" value="${esc(exp.memo || '')}" style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;margin-bottom:10px;">

        <div style="background:#0f0f23;padding:10px;border-radius:6px;margin-bottom:10px;">
          <div style="font-size:11px;color:#aaa;margin-bottom:6px;">영수증</div>
          ${exp.hasReceipt ? `
            <div style="display:flex;gap:6px;align-items:center;font-size:12px;">
              <span style="color:#64b5f6;">📎 ${esc(exp.receiptName || '영수증')}</span>
              <button type="button" onclick="pmcExpenses.viewReceipt(${exp.id})" style="padding:3px 8px;background:#0f2a3a;border:1px solid #1565c0;border-radius:4px;color:#64b5f6;cursor:pointer;font-size:11px;">보기</button>
              <button type="button" onclick="pmcExpenses.replaceReceiptInModal(${exp.id})" style="padding:3px 8px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">교체</button>
              <button type="button" onclick="pmcExpenses.deleteReceiptInModal(${exp.id})" style="padding:3px 8px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">삭제</button>
            </div>
          ` : `
            <button type="button" onclick="pmcExpenses.replaceReceiptInModal(${exp.id})" style="padding:6px 12px;background:#2a2a4a;border:1px dashed #555;border-radius:4px;color:#888;cursor:pointer;font-size:12px;">📎 영수증 추가</button>
          `}
        </div>

        <div id="ee-error" style="display:none;margin-bottom:10px;padding:8px 10px;background:#3a1a1a;border-radius:6px;color:#ff8a80;font-size:12px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:6px;">
          <button type="button" onclick="pmcExpenses.closeEditModal()" style="padding:8px 14px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;">취소</button>
          <button type="button" id="ee-save" onclick="pmcExpenses.saveEditModal(${exp.id})" style="padding:8px 16px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">저장</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
  }

  function closeEditModal() {
    document.getElementById('exp-edit-modal')?.remove();
  }

  async function saveEditModal(id) {
    const errEl = document.getElementById('ee-error');
    errEl.style.display = 'none';
    const payload = {
      paidAt: document.getElementById('ee-paid-at').value,
      amount: Number(document.getElementById('ee-amount').value),
      currency: document.getElementById('ee-currency').value,
      category: document.getElementById('ee-category').value,
      merchant: document.getElementById('ee-merchant').value.trim() || null,
      memo: document.getElementById('ee-memo').value.trim() || null,
      cardLast4: document.getElementById('ee-card').value.trim() || null,
    };
    if (!payload.paidAt) { errEl.textContent = '결제일을 입력하세요'; errEl.style.display = 'block'; return; }
    if (!Number.isFinite(payload.amount)) { errEl.textContent = '금액을 올바르게 입력하세요'; errEl.style.display = 'block'; return; }
    const btn = document.getElementById('ee-save');
    btn.disabled = true; btn.textContent = '저장 중...';
    try {
      const res = await fetch('/api/expenses/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || '수정 실패'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = '저장'; return; }
      closeEditModal();
      refresh();
    } catch (e) {
      errEl.textContent = e.message || '네트워크 오류';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '저장';
    }
  }

  function replaceReceiptInModal(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('file', f);
      const res = await fetch('/api/expenses/' + id + '/receipt', { method: 'POST', body: fd });
      if (!res.ok) { alert((await res.json()).error || '업로드 실패'); return; }
      const { data } = await res.json();
      // 모달 새로 열어서 최신 상태 반영
      closeEditModal();
      refresh();
      if (data) setTimeout(() => openEditModal(data), 150);
    };
    input.click();
  }

  async function deleteReceiptInModal(id) {
    if (!confirm('영수증을 삭제하시겠습니까?')) return;
    const res = await fetch('/api/expenses/' + id + '/receipt', { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    closeEditModal();
    refresh();
    // 최신 상태 다시 불러와서 모달 재오픈
    try {
      const r = await fetch('/api/expenses/' + id);
      const j = await r.json();
      if (r.ok && j.data) setTimeout(() => openEditModal(j.data), 150);
    } catch {}
  }

  async function del(id) {
    if (!confirm('이 지출을 삭제하시겠습니까?')) return;
    const res = await fetch('/api/expenses/' + id, { method: 'DELETE' });
    if (!res.ok) { alert((await res.json()).error || '삭제 실패'); return; }
    refresh();
  }

  window.pmcExpenses = {
    load, refresh, edit, del,
    onReceiptPick, viewReceipt, deleteReceipt, uploadReceiptLater,
    closeEditModal, saveEditModal, replaceReceiptInModal, deleteReceiptInModal,
  };
})();
