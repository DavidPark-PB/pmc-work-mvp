/**
 * public/js/shippingRateAdmin.js — PMC-CCOREA-SHIPPING-1B (2026-09-13).
 *
 * Owner console for the shipping rate master.
 * READ-heavy; the only write surfaces are `/import/commit`,
 * `/versions/:id/activate`, `/surcharges/:id`.
 *
 * V1 tabs:
 *   · 운임 버전    → versions list (import + activate)
 *   · 서비스/국가 → services + countries browse (filter by version)
 *   · 할증료       → surcharges (enable/disable, edit value — weekly FSC)
 *   · 견적 테스터  → single-quote form
 */
(function () {
  'use strict';
  let user = null;
  let activeVersionId = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(v) { return v ? String(v) : '—'; }

  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    const root = document.getElementById('page-shipping-rate-admin');
    if (!root) return;
    if (!user || !user.isAdmin) {
      root.innerHTML = '<div style="padding:40px;color:#888;">관리자 전용 페이지입니다.</div>';
      return;
    }
    renderShell(root);
    await Promise.all([loadVersions(), loadSurcharges(), loadShadowResults()]);
  }

  function renderShell(root) {
    root.innerHTML = `
      <div style="margin-bottom:14px;">
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">🚚 운임 마스터</h1>
        <p style="color:#888;font-size:13px;margin:0;">CCOREA 통합 배송비 운임표 관리 · 견적 테스터 · 주간 할증률 입력</p>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h3 style="color:#fff;margin:0;font-size:14px;">📋 운임 버전</h3>
            <label style="padding:5px 12px;background:#1565c0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">
              📤 xlsx 업로드
              <input id="sra-upload" type="file" accept=".xlsx" style="display:none;">
            </label>
          </div>
          <div id="sra-versions" style="min-height:100px;color:#888;font-size:12px;">불러오는 중…</div>
          <div id="sra-import-result" style="margin-top:10px;font-size:12px;"></div>
        </div>

        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
          <h3 style="color:#fff;margin:0 0 12px;font-size:14px;">💧 할증료 (주간 FSC · EU HS · VAT 등)</h3>
          <div id="sra-surcharges" style="min-height:100px;color:#888;font-size:12px;">불러오는 중…</div>
        </div>
      </div>

      <div style="margin-top:16px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
          <h3 style="color:#fff;margin:0;font-size:14px;">🔍 Shadow 결과 · 신·구 계산 비교</h3>
          <div style="display:flex;gap:8px;align-items:center;">
            <span id="sra-shadow-summary" style="color:#888;font-size:11px;"></span>
            <button id="sra-shadow-reload" type="button" style="padding:5px 12px;background:#37474f;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">새로고침</button>
            <a href="/api/shipping/rate-admin/shadow-results.csv" style="padding:5px 12px;background:#2a4a6a;border-radius:4px;color:#fff;text-decoration:none;font-size:11px;">CSV 다운로드</a>
          </div>
        </div>
        <div id="sra-shadow-list" style="max-height:280px;overflow-y:auto;color:#888;font-size:11px;">불러오는 중…</div>
      </div>

      <div style="margin-top:16px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;">
        <h3 style="color:#fff;margin:0 0 12px;font-size:14px;">🧪 단건 배송비 테스트 계산기</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:10px;">
          <input id="sra-t-country" placeholder="국가 (US)" value="US" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-actual"  placeholder="실중량 kg" value="0.5" type="number" step="0.001" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-l" placeholder="길이 cm" value="20" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-w" placeholder="가로 cm" value="15" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-h" placeholder="높이 cm" value="10" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-hs" placeholder="HS 개수" value="0" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-dv" placeholder="신고가액 KRW" value="0" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <input id="sra-t-eur" placeholder="EUR/KRW" value="" type="number" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <select id="sra-t-sale" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
            <option value="B2C">B2C</option>
            <option value="B2B">B2B</option>
          </select>
          <button id="sra-t-go" type="button" style="padding:8px 14px;background:#1565c0;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">견적 계산</button>
        </div>
        <div id="sra-t-out" style="min-height:60px;background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;font-family:monospace;font-size:11px;color:#e0e0e0;white-space:pre-wrap;">결과가 여기에 표시됩니다.</div>
      </div>
    `;
    document.getElementById('sra-upload').addEventListener('change', onUpload);
    document.getElementById('sra-t-go').addEventListener('click', runSingleQuote);
    document.getElementById('sra-shadow-reload').addEventListener('click', loadShadowResults);
  }

  async function loadShadowResults() {
    const list = document.getElementById('sra-shadow-list');
    const summary = document.getElementById('sra-shadow-summary');
    list.innerHTML = '<div style="color:#888;">불러오는 중…</div>';
    try {
      const [sumRes, listRes] = await Promise.all([
        fetch('/api/shipping/rate-admin/shadow-results/summary', { credentials: 'include' }).then(r => r.json()),
        fetch('/api/shipping/rate-admin/shadow-results?limit=100', { credentials: 'include' }).then(r => r.json()),
      ]);
      if (sumRes && sumRes.ok) {
        summary.textContent = `총 ${sumRes.total.toLocaleString()}건 · 차단 ${sumRes.blocked.toLocaleString()}건`;
      }
      if (!listRes.ok) throw new Error(listRes.error || 'load failed');
      const rows = listRes.results || [];
      if (rows.length === 0) {
        list.innerHTML = '<div style="color:#888;">아직 shadow 결과가 없습니다. automation 서버에서 AUTO_LISTING_SHIPPING_SHADOW_ENABLED=true + SHIPPING_QUOTE_INTERNAL_TOKEN 설정 후 리스팅을 실행하세요.</div>';
        return;
      }
      list.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead style="color:#888;background:#0f0f23;">
            <tr>
              <th style="text-align:left;padding:6px;">시각</th>
              <th style="text-align:left;padding:6px;">Job / Ref</th>
              <th style="text-align:center;padding:6px;">국가</th>
              <th style="text-align:right;padding:6px;">Legacy 판매가</th>
              <th style="text-align:right;padding:6px;">Shadow 판매가</th>
              <th style="text-align:right;padding:6px;">Δ (KRW)</th>
              <th style="text-align:right;padding:6px;">Δ %</th>
              <th style="text-align:left;padding:6px;">상태</th>
            </tr>
          </thead>
          <tbody>${rows.map(r => `
            <tr style="border-bottom:1px solid #23233a;">
              <td style="padding:6px;color:#aaa;">${esc(new Date(r.created_at).toLocaleString('ko-KR'))}</td>
              <td style="padding:6px;color:#fff;font-family:monospace;">${esc(r.listing_job_id)}<br><span style="color:#888;">${esc(r.product_ref)}</span></td>
              <td style="padding:6px;text-align:center;">${esc(r.destination_country || '—')}</td>
              <td style="padding:6px;text-align:right;font-family:monospace;">${r.legacy_listing_price == null ? '—' : Number(r.legacy_listing_price).toLocaleString('ko-KR')}</td>
              <td style="padding:6px;text-align:right;font-family:monospace;">${r.new_listing_price == null ? '—' : Number(r.new_listing_price).toLocaleString('ko-KR')}</td>
              <td style="padding:6px;text-align:right;font-family:monospace;color:${r.difference_amount == null ? '#888' : (Number(r.difference_amount) >= 0 ? '#69f0ae' : '#ef9a9a')};">${r.difference_amount == null ? '—' : (Number(r.difference_amount) >= 0 ? '+' : '') + Number(r.difference_amount).toLocaleString('ko-KR')}</td>
              <td style="padding:6px;text-align:right;font-family:monospace;">${r.difference_pct == null ? '—' : (Number(r.difference_pct) * 100).toFixed(2) + '%'}</td>
              <td style="padding:6px;">${r.status === 'blocked' ? `<span style="color:#ef9a9a;">🚫 ${esc(r.blocked_reason || 'blocked')}</span>` : '<span style="color:#69f0ae;">✓ ok</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      `;
    } catch (e) {
      list.innerHTML = `<div style="color:#ef9a9a;">불러오기 실패: ${esc(e.message)}</div>`;
    }
  }

  async function loadVersions() {
    const el = document.getElementById('sra-versions');
    try {
      const r = await fetch('/api/shipping/rate-admin/versions', { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rows = j.versions || [];
      activeVersionId = (rows.find(v => v.status === 'active') || {}).id || null;
      if (rows.length === 0) {
        el.innerHTML = '<div style="color:#888;">운임 버전이 없습니다. xlsx 를 업로드하세요.</div>';
        return;
      }
      el.innerHTML = rows.map(v => `
        <div style="padding:8px 0;border-bottom:1px solid #23233a;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
          <div>
            <div style="color:#fff;font-size:12px;font-weight:600;">
              ${esc(v.provider)} · ${esc(v.source_name)}
              ${v.status === 'active'
                ? '<span style="margin-left:6px;padding:2px 6px;background:#1b5e20;color:#69f0ae;border-radius:3px;font-size:10px;">ACTIVE</span>'
                : v.status === 'draft'
                  ? '<span style="margin-left:6px;padding:2px 6px;background:#5d3a00;color:#ffb74d;border-radius:3px;font-size:10px;">DRAFT</span>'
                  : `<span style=\"margin-left:6px;padding:2px 6px;background:#37474f;color:#aaa;border-radius:3px;font-size:10px;\">${esc(v.status.toUpperCase())}</span>`}
            </div>
            <div style="color:#888;font-size:11px;">effective ${fmtDate(v.effective_from)}${v.effective_to ? ' → ' + fmtDate(v.effective_to) : ''} · imported ${new Date(v.imported_at).toLocaleString('ko-KR')}</div>
          </div>
          ${v.status === 'draft'
            ? `<button data-vid="${v.id}" class="sra-activate" style="padding:5px 12px;background:#1b5e20;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">활성화</button>`
            : ''}
        </div>
      `).join('');
      el.querySelectorAll('.sra-activate').forEach(btn => btn.addEventListener('click', () => activateVersion(btn.dataset.vid)));
    } catch (e) {
      el.innerHTML = `<div style="color:#ef9a9a;">불러오기 실패: ${esc(e.message)}</div>`;
    }
  }

  async function activateVersion(vid) {
    if (!confirm(`버전 #${vid} 을 활성화합니다. 기존 active 버전은 자동으로 superseded 처리됩니다. 진행할까요?`)) return;
    try {
      const r = await fetch(`/api/shipping/rate-admin/versions/${vid}/activate`, { method: 'POST', credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      alert(`활성화 완료 · 슈퍼시드: ${(j.superseded || []).join(', ') || '없음'}`);
      loadVersions();
    } catch (e) { alert('활성화 실패: ' + e.message); }
  }

  async function onUpload(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    ev.target.value = '';   //   allow re-selecting the same file after edit
    const resultEl = document.getElementById('sra-import-result');
    resultEl.innerHTML = '<span style="color:#888;">미리보기 중…</span>';

    //   Step 1: preview
    const fd = new FormData(); fd.append('workbook', file);
    try {
      const rP = await fetch('/api/shipping/rate-admin/import/preview', { method: 'POST', body: fd, credentials: 'include' });
      const jP = await rP.json();
      if (!rP.ok || !jP.ok) {
        resultEl.innerHTML = `<div style="color:#ef9a9a;">검증 실패:<ul>${(jP.errors || [jP.error]).map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
        return;
      }
      const msg = `검증 통과: services=${jP.counts.services} countries=${jP.counts.countries} brackets=${jP.counts.brackets} surcharges=${jP.counts.surcharges}`;
      const warns = (jP.warnings || []).slice(0, 3).map(w => `⚠ ${esc(w)}`).join('<br>');
      if (!confirm(`${msg}\n\n버전: ${jP.version.provider} / ${jP.version.source_name} / ${jP.version.effective_from}\n\nDB 에 저장할까요?`)) {
        resultEl.innerHTML = `<div style="color:#888;">미리보기 완료 (저장 취소). ${msg}${warns ? '<br>' + warns : ''}</div>`;
        return;
      }
      //   Step 2: commit
      resultEl.innerHTML = '<span style="color:#888;">저장 중…</span>';
      const fd2 = new FormData(); fd2.append('workbook', file);
      const rC = await fetch('/api/shipping/rate-admin/import/commit', { method: 'POST', body: fd2, credentials: 'include' });
      const jC = await rC.json();
      if (!rC.ok || !jC.ok) throw new Error(jC.errors ? jC.errors.join(', ') : jC.error || `HTTP ${rC.status}`);
      if (jC.alreadyImported) {
        resultEl.innerHTML = `<div style="color:#ffb74d;">이미 import 된 버전입니다 (versionId=${jC.versionId}).</div>`;
      } else {
        resultEl.innerHTML = `<div style="color:#69f0ae;">✓ 저장 완료 · versionId=${jC.versionId} · rows: ${JSON.stringify(jC.rowCounts)}</div>`;
      }
      loadVersions();
    } catch (e) {
      resultEl.innerHTML = `<div style="color:#ef9a9a;">실패: ${esc(e.message)}</div>`;
    }
  }

  async function loadSurcharges() {
    const el = document.getElementById('sra-surcharges');
    try {
      const r = await fetch('/api/shipping/rate-admin/surcharges', { credentials: 'include' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const rows = j.surcharges || [];
      if (rows.length === 0) {
        el.innerHTML = '<div style="color:#888;">활성 버전에 등록된 할증이 없습니다.</div>';
        return;
      }
      el.innerHTML = rows.map(s => `
        <div style="padding:8px 0;border-bottom:1px solid #23233a;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="min-width:220px;">
              <span style="color:#fff;font-family:monospace;font-size:12px;font-weight:600;">${esc(s.rule_code)}</span>
              <span style="color:#888;font-size:11px;margin-left:6px;">${esc(s.scope || '')} · ${esc(s.unit || '')}</span>
            </div>
            <input data-sid="${s.id}" class="sra-value" type="number" step="0.0001" value="${esc(s.value)}"
              style="width:100px;padding:5px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:11px;">
            <label style="display:flex;align-items:center;gap:4px;color:#aaa;font-size:11px;">
              <input data-sid="${s.id}" class="sra-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> 활성
            </label>
            <button data-sid="${s.id}" class="sra-save" type="button"
              style="padding:5px 12px;background:#1565c0;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">저장</button>
          </div>
          ${s.note ? `<div style="color:#666;font-size:10px;margin-top:2px;">${esc(s.note)}</div>` : ''}
        </div>
      `).join('');
      el.querySelectorAll('.sra-save').forEach(btn => btn.addEventListener('click', () => saveSurcharge(btn.dataset.sid)));
    } catch (e) {
      el.innerHTML = `<div style="color:#ef9a9a;">불러오기 실패: ${esc(e.message)}</div>`;
    }
  }

  async function saveSurcharge(sid) {
    const val = document.querySelector(`.sra-value[data-sid="${sid}"]`);
    const en  = document.querySelector(`.sra-enabled[data-sid="${sid}"]`);
    try {
      const r = await fetch(`/api/shipping/rate-admin/surcharges/${sid}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ value: Number(val.value), enabled: !!en.checked }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      val.style.borderColor = '#69f0ae';
      setTimeout(() => { val.style.borderColor = '#333'; }, 1500);
    } catch (e) { alert('저장 실패: ' + e.message); }
  }

  async function runSingleQuote() {
    const out = document.getElementById('sra-t-out');
    out.textContent = '계산 중…';
    const body = {
      destinationCountry: document.getElementById('sra-t-country').value.trim().toUpperCase(),
      actualWeightKg:     Number(document.getElementById('sra-t-actual').value),
      lengthCm:           Number(document.getElementById('sra-t-l').value),
      widthCm:            Number(document.getElementById('sra-t-w').value),
      heightCm:           Number(document.getElementById('sra-t-h').value),
      uniqueHsCodeCount:  Number(document.getElementById('sra-t-hs').value),
      declaredValueKrw:   Number(document.getElementById('sra-t-dv').value),
      eurKrwRate:         Number(document.getElementById('sra-t-eur').value) || null,
      saleType:           document.getElementById('sra-t-sale').value,
      quotePurpose:       'LISTING',
    };
    try {
      const r = await fetch('/api/shipping/rate-admin/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      out.textContent = JSON.stringify(j, null, 2);
    } catch (e) {
      out.textContent = 'HTTP 오류: ' + e.message;
    }
  }

  window.pmcShippingRateAdmin = { init };
})();
