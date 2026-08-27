/**
 * b2cMyTasks.js — B2C · Phase 7 · Employee Work OS · NEXT TASK 중심 UI.
 *
 * Owner directive:
 *   · 직원 로그인 → NEXT TASK 하나 크게 표시.
 *   · Start / Submit / Blocked 버튼.
 *   · CHANNEL_REGISTER 는 listing_id/url/price 필수 입력.
 *   · QC FAIL 시 상단에 반려 사유 강하게 표시 → 수정 후 재제출.
 *   · 숫자만 X · reasons (Task context) 을 사람 언어로 표시.
 */
(function () {
  let user = null;
  let cache = null;   //   { summary, next_task, tasks, pool_size }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtMoney(v) { return v == null ? '-' : '₩' + Number(v).toLocaleString(); }
  const LEVEL_COLOR = { p0: '#c62828', p1: '#f9a825', p2: '#0277bd', p3: '#546e7a' };

  function badgeLevel(lvl) {
    return `<span style="display:inline-block;padding:3px 10px;background:${LEVEL_COLOR[lvl]||'#37474f'};color:#fff;border-radius:12px;font-size:12px;font-weight:800;letter-spacing:.5px;">${esc((lvl||'').toUpperCase())}</span>`;
  }
  function badgeStatus(s) {
    const c = { pending:'#546e7a', in_progress:'#f9a825', qc_pending:'#0277bd', done:'#2e7d32', blocked:'#4a1a1a', failed:'#4a148c' }[s] || '#333';
    return `<span style="display:inline-block;padding:2px 8px;background:${c};color:#fff;border-radius:8px;font-size:10px;">${esc(s)}</span>`;
  }

  async function load() {
    const page = document.getElementById('page-b2c-my-tasks');
    if (!page) return;
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json()).catch(()=>({})))?.user;
    page.innerHTML = '<div style="color:#888;padding:20px;">로딩 중…</div>';
    try {
      const j = await fetch('/api/b2c/work/my-tasks').then(r=>r.json());
      if (j.error) throw new Error(j.error);
      cache = j.data;
      render();
    } catch (e) {
      page.innerHTML = `<div style="color:#ef9a9a;padding:20px;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function render() {
    const page = document.getElementById('page-b2c-my-tasks');
    if (!page || !cache) return;
    const s = cache.summary;
    const nt = cache.next_task;
    const summaryHtml = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px;">
        ${statCard('오늘 완료', s.completed_today, '#2e7d32')}
        ${statCard('진행중', s.in_progress, '#f9a825')}
        ${statCard('QC 대기', s.qc_pending, '#0277bd')}
        ${statCard('남은 업무', s.remaining, '#37474f')}
        ${statCard('QC 반려', s.qc_failed_active, '#c62828')}
        ${statCard('Blocked', s.blocked, '#4a1a1a')}
      </div>`;

    const nextHtml = nt ? renderNextTaskCard(nt) : `
      <div style="padding:40px 20px;background:#0f0f23;border-radius:8px;text-align:center;color:#888;">
        <div style="font-size:32px;margin-bottom:8px;">🎉</div>
        <div style="font-size:16px;">할당된 업무가 없습니다.</div>
        <div style="font-size:12px;margin-top:4px;">공용 큐 ${cache.pool_size}건 · 관리자 배정 대기</div>
      </div>`;

    //   전체 tasks 목록 (아래에 · 참고용)
    const listHtml = cache.tasks.length ? `
      <div style="margin-top:24px;">
        <h3 style="color:#aaa;font-size:14px;">전체 할당 업무 (${cache.tasks.length}건)</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;">
          <thead><tr style="color:#aaa;background:#0f0f23;">
            <th style="padding:6px;text-align:left;">Priority</th>
            <th style="padding:6px;text-align:left;">Status</th>
            <th style="padding:6px;text-align:left;">SKU</th>
            <th style="padding:6px;text-align:left;">Channel</th>
            <th style="padding:6px;text-align:left;">제목</th>
            <th style="padding:6px;text-align:right;">Score</th>
          </tr></thead>
          <tbody>${cache.tasks.map(t => `
            <tr style="border-top:1px solid #2a2a4a;">
              <td style="padding:6px;">${badgeLevel(t.priority_level)}</td>
              <td style="padding:6px;">${badgeStatus(t.status)}</td>
              <td style="padding:6px;font-family:monospace;color:#81d4fa;">${esc(t.context?.internal_sku || t.related_sku_id)}</td>
              <td style="padding:6px;">${esc(t.channel || '-')}</td>
              <td style="padding:6px;color:#ccc;">${esc((t.context?.title || t.title || '').slice(0, 60))}</td>
              <td style="padding:6px;text-align:right;color:#fff;">${t.priority_score ?? '-'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : '';

    page.innerHTML = `
      <div style="padding:20px;max-width:960px;margin:0 auto;">
        <h2 style="color:#fff;font-size:18px;margin-bottom:12px;">📋 My Tasks · ${esc(user?.display_name || user?.username || '')}</h2>
        ${summaryHtml}
        <h3 style="color:#aaa;font-size:14px;margin-bottom:8px;">🎯 NEXT TASK</h3>
        ${nextHtml}
        ${listHtml}
      </div>`;
    attachEvents();
  }

  function statCard(label, value, color) {
    return `<div style="padding:12px;background:#0f0f23;border-left:3px solid ${color};border-radius:4px;">
      <div style="font-size:10px;color:#888;">${esc(label)}</div>
      <div style="font-size:22px;color:${color};font-weight:800;margin-top:2px;">${value}</div>
    </div>`;
  }

  function renderNextTaskCard(t) {
    const ctx = t.context || {};
    const isCr = (t.exception_type || '').startsWith('channel_register.');
    const isDq = (t.exception_type || '').startsWith('data_quality.');
    const isQcFailed = t.qc_status === 'fail';

    const qcFailBanner = isQcFailed ? `
      <div style="margin-bottom:12px;padding:12px 14px;background:#4a1a1a;border-left:4px solid #c62828;border-radius:4px;color:#ffcdd2;">
        <strong>🔴 QC 반려</strong> · 사유: <strong>${esc(t.qc_fail_reason || 'OTHER')}</strong>
        <div style="margin-top:4px;font-size:12px;">${esc((t.memo||'').split('[QC FAIL]').slice(-1)[0].trim() || '수정 후 재제출하세요.')}</div>
      </div>` : '';

    const reasonsHtml = (ctx.reasons || []).length ? `
      <div style="margin-top:12px;padding:10px 12px;background:rgba(3,155,229,0.1);border-left:3px solid #0288d1;border-radius:4px;">
        <div style="font-size:11px;color:#81d4fa;font-weight:700;margin-bottom:6px;">왜 이 상품을 먼저 해야 하나?</div>
        <ul style="margin:0;padding-left:20px;color:#e0e0e0;font-size:13px;line-height:1.6;">
          ${ctx.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
        </ul>
      </div>` : '';

    const dataRow = (label, val) => `<tr><td style="padding:4px 8px;color:#888;font-size:12px;">${esc(label)}</td><td style="padding:4px 8px;color:#fff;font-family:monospace;">${esc(val)}</td></tr>`;

    let submitForm = '';
    if (isCr && (t.status === 'in_progress' || (isQcFailed && t.status === 'in_progress'))) {
      submitForm = `
        <div style="margin-top:16px;padding:14px;background:#0f0f23;border-radius:6px;">
          <div style="color:#81d4fa;font-size:12px;font-weight:700;margin-bottom:8px;">등록 완료 정보 입력</div>
          <div style="display:grid;gap:8px;">
            <input id="b2c-listing-id" placeholder="listing_id (필수)" value="${esc(t.listing_id||'')}" style="padding:8px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;">
            <input id="b2c-listing-url" placeholder="listing_url (https://...)" value="${esc(t.listing_url||'')}" style="padding:8px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;">
            <input id="b2c-selling-price" type="number" step="0.01" placeholder="판매가 (필수 · > 0)" value="${t.selling_price ?? ''}" style="padding:8px;background:#1a1a2e;border:1px solid #333;color:#fff;border-radius:4px;">
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;">
            <button data-action="submit" data-id="${t.id}" style="flex:1;padding:10px;background:#2e7d32;border:none;border-radius:4px;color:#fff;cursor:pointer;font-weight:700;">✅ 제출 (QC로 이동)</button>
            <button data-action="blocked" data-id="${t.id}" style="padding:10px 14px;background:#4a1a1a;border:none;border-radius:4px;color:#ffcdd2;cursor:pointer;">⛔ Blocked</button>
          </div>
        </div>`;
    } else if (isDq && t.status === 'in_progress') {
      submitForm = `
        <div style="margin-top:16px;padding:14px;background:#0f0f23;border-radius:6px;color:#ffcc80;font-size:13px;">
          원가(<strong>cost_krw</strong>)를 SKU Master 화면에서 입력 후 아래 완료 버튼을 누르세요. 원가 미입력 시 완료가 거부됩니다.
          <div style="margin-top:10px;">
            <button data-action="dq-complete" data-id="${t.id}" style="padding:10px 16px;background:#f9a825;border:none;border-radius:4px;color:#000;cursor:pointer;font-weight:700;">✅ 원가 입력 완료 확인</button>
            <button data-action="blocked" data-id="${t.id}" style="margin-left:8px;padding:10px 14px;background:#4a1a1a;border:none;border-radius:4px;color:#ffcdd2;cursor:pointer;">⛔ Blocked</button>
          </div>
        </div>`;
    }

    const startBtn = t.status === 'pending' ? `
      <div style="margin-top:16px;text-align:center;">
        <button data-action="start" data-id="${t.id}" style="padding:14px 40px;background:linear-gradient(90deg,#1565c0,#0277bd);border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:800;font-size:16px;">▶ START</button>
      </div>` : '';

    return `
      <div style="padding:18px 20px;background:#1a1a2e;border-radius:8px;border:2px solid ${LEVEL_COLOR[t.priority_level]||'#333'};">
        ${qcFailBanner}
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">
          <div style="flex:1;">
            <div style="font-size:18px;color:#fff;font-weight:700;line-height:1.35;">${esc(ctx.title || t.title || '')}</div>
            <div style="margin-top:4px;font-size:12px;color:#888;">SKU: <span style="color:#81d4fa;font-family:monospace;">${esc(ctx.internal_sku || t.related_sku_id)}</span> · Channel: <strong style="color:#fff;">${esc(t.channel || '-')}</strong></div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${badgeLevel(t.priority_level)}
            ${badgeStatus(t.status)}
          </div>
        </div>
        <table style="width:100%;margin-top:8px;">
          ${isCr ? dataRow('재고수량', ctx.stock_qty ?? '-') : ''}
          ${isCr ? dataRow('원가', fmtMoney(ctx.cost_krw)) : ''}
          ${isCr ? dataRow('재고금액', fmtMoney(ctx.inventory_value_krw)) : ''}
          ${isCr ? dataRow('eBay 90일 판매', ctx.ebay_sales_90d ?? '-') : ''}
          ${isCr ? dataRow('Shopify 90일 판매', ctx.shopify_sales_90d ?? '-') : ''}
          ${isCr ? dataRow('현재 채널 상태', ctx.channel_status || 'NONE') : ''}
          ${isDq ? dataRow('필요 조치', ctx.required_action || 'cost_krw 입력') : ''}
          ${isDq ? dataRow('최근 판매', ctx.sales_90d ?? '-') : ''}
          ${dataRow('Priority Score', t.priority_score ?? '-')}
        </table>
        ${reasonsHtml}
        ${startBtn}
        ${submitForm}
      </div>`;
  }

  function attachEvents() {
    document.querySelectorAll('#page-b2c-my-tasks button[data-action]').forEach(b => {
      b.addEventListener('click', onAction);
    });
  }

  async function onAction(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    btn.disabled = true; btn.textContent = '⏳ ...';
    try {
      if (action === 'start') {
        await callApi(`/api/b2c/work/${id}/start`);
      } else if (action === 'submit') {
        const body = {
          listing_id: document.getElementById('b2c-listing-id')?.value.trim(),
          listing_url: document.getElementById('b2c-listing-url')?.value.trim(),
          selling_price: Number(document.getElementById('b2c-selling-price')?.value),
        };
        await callApi(`/api/b2c/work/${id}/submit`, body);
      } else if (action === 'blocked') {
        const reason = prompt('BLOCKED 사유 (BRAND_RESTRICTION / CATEGORY_UNKNOWN / MISSING_CERTIFICATION / MISSING_PRODUCT_INFO / PLATFORM_ERROR / ACCOUNT_PERMISSION / PRICE_PROBLEM / OTHER):');
        if (!reason) { btn.disabled = false; return load(); }
        const memo = prompt('메모 (선택):') || '';
        await callApi(`/api/b2c/work/${id}/blocked`, { reason, memo });
      } else if (action === 'dq-complete') {
        await fetch(`/api/b2c/tasks/${id}/data-quality-complete`, { method: 'POST' })
          .then(r => r.json())
          .then(j => { if (j.error) throw new Error(j.error); });
      }
      await load();
    } catch (err) {
      alert('실패: ' + err.message);
      btn.disabled = false;
      load();
    }
  }

  async function callApi(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  window.pmcB2cMyTasks = { load };
})();
