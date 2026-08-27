/**
 * b2cQc.js — B2C · Phase 7 · QC UI (admin/reviewer).
 * QC pending 큐 · PASS/FAIL · fail reason 필수.
 */
(function () {
  let cache = [];
  const FAIL_REASONS = ['WRONG_PRODUCT','WRONG_PRICE','BROKEN_URL','WRONG_CHANNEL','MISSING_REQUIRED_DATA','LISTING_NOT_LIVE','OTHER'];

  function esc(s) { if (s==null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function load() {
    const page = document.getElementById('page-b2c-qc');
    if (!page) return;
    page.innerHTML = '<div style="padding:20px;color:#888;">로딩 중…</div>';
    try {
      const j = await fetch('/api/b2c/work/qc/queue').then(r => r.json());
      if (j.error) throw new Error(j.error);
      cache = j.data.tasks || [];
      render();
    } catch (e) {
      page.innerHTML = `<div style="padding:20px;color:#ef9a9a;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function render() {
    const page = document.getElementById('page-b2c-qc');
    if (!page) return;
    const items = cache.length ? cache.map(t => {
      const ctx = t.context || {};
      return `
        <tr style="border-top:1px solid #2a2a4a;">
          <td style="padding:10px;font-family:monospace;color:#81d4fa;">${esc(ctx.internal_sku || t.related_sku_id)}</td>
          <td style="padding:10px;color:#fff;font-size:12px;max-width:280px;">${esc((ctx.title || t.title || '').slice(0, 60))}</td>
          <td style="padding:10px;color:#fff;">${esc(t.channel || '-')}</td>
          <td style="padding:10px;font-family:monospace;color:#fff;">${esc(t.listing_id || '-')}</td>
          <td style="padding:10px;"><a href="${esc(t.listing_url || '#')}" target="_blank" rel="noopener" style="color:#81d4fa;font-size:11px;">열기 ↗</a></td>
          <td style="padding:10px;text-align:right;color:#fff;">${t.selling_price != null ? '₩' + Number(t.selling_price).toLocaleString() : '-'}</td>
          <td style="padding:10px;color:#888;font-size:11px;">${t.submitted_at ? new Date(t.submitted_at).toLocaleString('ko-KR') : '-'}</td>
          <td style="padding:10px;">
            <button data-action="pass" data-id="${t.id}" style="padding:6px 12px;background:#2e7d32;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:700;">✅ PASS</button>
            <button data-action="fail" data-id="${t.id}" style="padding:6px 12px;background:#c62828;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;font-weight:700;margin-left:4px;">❌ FAIL</button>
          </td>
        </tr>`;
    }).join('') : `<tr><td colspan="8" style="padding:40px;text-align:center;color:#666;">QC 대기 업무 없음</td></tr>`;

    page.innerHTML = `
      <div style="padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="color:#fff;margin:0;">🔍 QC 검수 큐 · ${cache.length}건</h2>
          <button id="b2c-qc-refresh" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;">🔄 새로고침</button>
        </div>
        <div style="padding:10px 14px;background:#0d2818;border-left:4px solid #2e7d32;border-radius:4px;color:#c5e1a5;font-size:12px;margin-bottom:12px;">
          검수 항목: Listing URL 존재 · 실제 URL 형식 정상 · Listing ID 존재 · 판매가 &gt; 0 · SKU/Channel 일치 · Marketplace 링크 열어서 확인
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:#0f0f23;">
          <thead><tr style="background:#1a1a2e;color:#aaa;">
            <th style="padding:10px;text-align:left;">SKU</th>
            <th style="padding:10px;text-align:left;">제목</th>
            <th style="padding:10px;text-align:left;">Channel</th>
            <th style="padding:10px;text-align:left;">Listing ID</th>
            <th style="padding:10px;text-align:left;">URL</th>
            <th style="padding:10px;text-align:right;">판매가</th>
            <th style="padding:10px;text-align:left;">제출 시각</th>
            <th style="padding:10px;text-align:left;">Action</th>
          </tr></thead>
          <tbody>${items}</tbody>
        </table>
      </div>`;
    document.getElementById('b2c-qc-refresh')?.addEventListener('click', load);
    document.querySelectorAll('#page-b2c-qc button[data-action]').forEach(b => b.addEventListener('click', onAction));
  }

  async function onAction(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    btn.disabled = true; btn.textContent = '⏳';
    try {
      if (action === 'pass') {
        if (!confirm('QC PASS 처리 하시겠습니까? SoT (sku_listing_link + platform_listings) 에 반영됩니다.')) { btn.disabled = false; return load(); }
        await callApi(`/api/b2c/work/${id}/qc-pass`);
      } else {
        const reason = prompt(`QC FAIL 사유 (${FAIL_REASONS.join(' / ')}):`);
        if (!reason) { btn.disabled = false; return load(); }
        const memo = prompt('세부 사유 (직원에게 표시됨):') || '';
        await callApi(`/api/b2c/work/${id}/qc-fail`, { reason, memo });
      }
      await load();
    } catch (err) {
      alert('실패: ' + err.message);
      btn.disabled = false;
      load();
    }
  }

  async function callApi(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  window.pmcB2cQc = { load };
})();
