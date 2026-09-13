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
      <!--
        Scoped dark-theme override — the global rule table td { color: var(--text) }
        in css/style.css:669 was painting bare <td> cells near-black on this page's
        dark background, so text like 국가 · Legacy · Shadow · Δ% was only visible
        when the row-hover rule flipped the background to light gray. Scope everything
        under #page-shipping-rate-admin so no other page is affected.
      -->
      <style>
        #page-shipping-rate-admin table td { color: #e0e0e0; }
        #page-shipping-rate-admin table th { color: #cfd8dc; }
        #page-shipping-rate-admin table tbody tr { border-bottom-color: #23233a; }
        #page-shipping-rate-admin table tbody tr:hover { background: #23233a; }
        #page-shipping-rate-admin .menu-item, #page-shipping-rate-admin a { color: inherit; }
      </style>
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
        <h3 style="color:#fff;margin:0 0 4px;font-size:14px;">🧪 단건 배송비 테스트 계산기</h3>
        <p style="color:#888;font-size:11px;margin:0 0 12px;">도착 국가·중량·부피·판매방식을 넣으면 활성 운임 버전으로 견적을 계산합니다. 실제 리스팅에는 영향 없습니다.</p>
        <!--
          autocomplete="off" on the form + name attributes on inputs stop
          the browser from filling numeric fields with stale cached values —
          the previous SPA had a bare unlabeled input that Chrome silently
          populated with "50" for EUR/KRW (owner-reported 2026-09-13).
        -->
        <form id="sra-t-form" autocomplete="off" onsubmit="return false;" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:12px;">
          <div>
            <label for="sra-t-country" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">도착 국가 <span style="color:#888;font-weight:400;">(ISO 2자리)</span></label>
            <input id="sra-t-country" name="destinationCountry" value="US" maxlength="2" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;text-transform:uppercase;">
          </div>
          <div>
            <label for="sra-t-actual" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">실중량 <span style="color:#888;font-weight:400;">(kg)</span></label>
            <input id="sra-t-actual" name="actualWeightKg" value="0.5" type="number" step="0.001" min="0.001" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-l" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">가로 <span style="color:#888;font-weight:400;">(cm)</span></label>
            <input id="sra-t-l" name="lengthCm" value="20" type="number" step="0.1" min="0.1" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-w" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">세로 <span style="color:#888;font-weight:400;">(cm)</span></label>
            <input id="sra-t-w" name="widthCm" value="15" type="number" step="0.1" min="0.1" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-h" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">높이 <span style="color:#888;font-weight:400;">(cm)</span></label>
            <input id="sra-t-h" name="heightCm" value="10" type="number" step="0.1" min="0.1" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-hs" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">고유 HS코드 수 <span style="color:#888;font-weight:400;">(같은 코드는 1개)</span></label>
            <input id="sra-t-hs" name="uniqueHsCodeCount" value="1" type="number" step="1" min="0" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-dv" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">신고가액 <span style="color:#888;font-weight:400;">(KRW · EU VAT 기준)</span></label>
            <input id="sra-t-dv" name="declaredValueKrw" value="0" type="number" step="1" min="0" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-eur" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">유로 환율 <span style="color:#888;font-weight:400;">(KRW/EUR · EU 필수)</span></label>
            <input id="sra-t-eur" name="eurKrwRate" placeholder="예: 1600" type="number" step="1" min="800" max="3000" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label for="sra-t-sale" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">판매방식</label>
            <select id="sra-t-sale" name="saleType" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="B2C">B2C (개인 구매)</option>
              <option value="B2B">B2B (사업자 구매)</option>
            </select>
          </div>
          <div>
            <label for="sra-t-purpose" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">견적 목적</label>
            <select id="sra-t-purpose" name="quotePurpose" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="LISTING">LISTING (판매 등록용)</option>
              <option value="FULFILLMENT">FULFILLMENT (실 배송용)</option>
            </select>
          </div>
          <div>
            <label for="sra-t-branded" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">브랜드 상품 여부</label>
            <select id="sra-t-branded" name="isBranded" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
              <option value="unknown">미확인 (BRAND_STATUS_UNKNOWN)</option>
              <option value="true">브랜드 상품</option>
              <option value="false">일반상품 (Non-Brand)</option>
            </select>
          </div>
          <div>
            <label for="sra-t-brand" style="display:block;color:#cfd8dc;font-size:11px;font-weight:600;margin-bottom:4px;">브랜드명 <span style="color:#888;font-weight:400;">(브랜드 상품일 때)</span></label>
            <input id="sra-t-brand" name="brandName" placeholder="예: Pokemon" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          </div>
          <div style="display:flex;align-items:flex-end;">
            <button id="sra-t-go" type="submit" style="width:100%;padding:10px 14px;background:#1565c0;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">배송사 비교</button>
          </div>
        </form>
        <div id="sra-t-out" style="min-height:40px;color:#888;font-size:12px;">계산 결과가 여기에 표시됩니다.</div>
      </div>
    `;
    document.getElementById('sra-upload').addEventListener('change', onUpload);
    document.getElementById('sra-t-form').addEventListener('submit', function (ev) { ev.preventDefault(); runSingleQuote(); });
    document.getElementById('sra-t-go').addEventListener('click', runSingleQuote);
    document.getElementById('sra-shadow-reload').addEventListener('click', loadShadowResults);
  }

  //   ─── Quote result formatting helpers ──────────────────────────
  //   Centralized so tests can lock in the display contract without
  //   spinning up a real browser.

  function fmtWon(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('ko-KR') + '원';
  }
  function fmtKg(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    //   Trim trailing zeros — 0.5000 → 0.5, 1.0 → 1, 1.234 → 1.234.
    const v = Number(n);
    if (v === Math.round(v)) return v + 'kg';
    return v.toFixed(3).replace(/\.?0+$/, '') + 'kg';
  }
  function fmtInt(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('ko-KR');
  }

  //   ─── Input validation (pre-flight for the quote tester) ───────
  //   Returns { ok: true, body } or { ok: false, messages: [Korean sentences] }.
  //   Never surfaces raw JS errors to the operator — every branch produces
  //   an actionable Korean sentence.

  function readQuoteInputs() {
    const country = String(document.getElementById('sra-t-country').value || '').trim().toUpperCase();
    //   Brand flag: 'unknown' → null (BRAND_STATUS_UNKNOWN), 'true'/'false' → boolean.
    const brandedEl = document.getElementById('sra-t-branded');
    const brandedVal = brandedEl ? brandedEl.value : 'unknown';
    const isBranded = brandedVal === 'true' ? true : brandedVal === 'false' ? false : null;
    const brandName = (document.getElementById('sra-t-brand') || {}).value || '';
    const purposeEl = document.getElementById('sra-t-purpose');
    return {
      destinationCountry: country,
      actualWeightKg:     Number(document.getElementById('sra-t-actual').value),
      lengthCm:           Number(document.getElementById('sra-t-l').value),
      widthCm:            Number(document.getElementById('sra-t-w').value),
      heightCm:           Number(document.getElementById('sra-t-h').value),
      uniqueHsCodeCount:  Math.floor(Number(document.getElementById('sra-t-hs').value) || 0),
      declaredValueKrw:   Number(document.getElementById('sra-t-dv').value),
      eurKrwRate:         document.getElementById('sra-t-eur').value === ''
                            ? null
                            : Number(document.getElementById('sra-t-eur').value),
      saleType:           document.getElementById('sra-t-sale').value,
      quotePurpose:       purposeEl ? purposeEl.value : 'LISTING',
      isBranded,
      brandName:          brandName ? String(brandName).trim() : null,
    };
  }

  //   EU country list — 2-letter ISO codes. Kept in the client only for
  //   the "is EU required-field" check; the server owns the authoritative
  //   flag (shipping_countries.is_eu). Client-side is defensive UX.
  const _EU_ISO = new Set([
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
    'IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  ]);

  function validateQuoteInputs(input) {
    const msgs = [];
    if (!/^[A-Z]{2}$/.test(input.destinationCountry)) {
      msgs.push('도착 국가는 영문 2자리(예: US, JP, DE)로 입력하세요.');
    }
    if (!(input.actualWeightKg > 0)) msgs.push('실중량은 0보다 커야 합니다.');
    if (!(input.lengthCm > 0))       msgs.push('가로는 0보다 커야 합니다.');
    if (!(input.widthCm > 0))        msgs.push('세로는 0보다 커야 합니다.');
    if (!(input.heightCm > 0))       msgs.push('높이는 0보다 커야 합니다.');
    if (!(Number.isInteger(input.uniqueHsCodeCount) && input.uniqueHsCodeCount >= 0)) {
      msgs.push('고유 HS코드 수는 0 이상의 정수로 입력하세요.');
    }
    if (!(input.declaredValueKrw >= 0)) msgs.push('신고가액은 0 이상의 숫자로 입력하세요.');
    if (!(input.saleType === 'B2C' || input.saleType === 'B2B')) msgs.push('판매방식은 B2C 또는 B2B 중 선택하세요.');

    const isEu = _EU_ISO.has(input.destinationCountry);
    if (isEu) {
      if (!(input.eurKrwRate > 0)) {
        msgs.push('유로 환율(KRW/EUR)을 입력해 주세요. EU 견적에 필수입니다.');
      } else if (input.eurKrwRate < 800 || input.eurKrwRate > 3000) {
        msgs.push(`유로 환율이 비정상 범위입니다 (${input.eurKrwRate}). 800~3000 사이의 값을 입력하세요.`);
      }
      if (!(input.declaredValueKrw > 0)) {
        msgs.push('EU 견적에는 신고가액이 필요합니다 (VAT 계산 기준).');
      }
      if (!(input.uniqueHsCodeCount > 0)) {
        msgs.push('EU 견적에는 고유 HS코드 수가 1개 이상이어야 합니다.');
      }
    } else if (input.eurKrwRate != null && input.eurKrwRate > 0
               && (input.eurKrwRate < 800 || input.eurKrwRate > 3000)) {
      //   Non-EU: eurKrwRate is unused by the server, but a wildly-off value
      //   is almost certainly the browser-autofill "50" case — warn softly.
      msgs.push(`유로 환율이 비정상 범위입니다 (${input.eurKrwRate}). 비어 있어도 미국 등 비EU 견적은 계산 가능합니다.`);
    }
    return msgs.length === 0 ? { ok: true } : { ok: false, messages: msgs };
  }

  //   Map server error codes/status to a Korean operator-facing sentence.
  //   The raw JSON is still available in the collapsed panel for devs.
  function _translateServerError(j, httpStatus) {
    if (!j || typeof j !== 'object') return `서버 응답을 해석할 수 없습니다 (HTTP ${httpStatus}).`;
    const code    = String(j.errorCode || j.code || '').toUpperCase();
    const message = String(j.message || j.error || '').trim();
    if (code === 'COUNTRY_NOT_SUPPORTED' || /country.*not.*supported/i.test(message)) {
      return '해당 국가의 운임이 없습니다. 국가 코드를 확인하거나 운임 마스터에 국가를 추가해 주세요.';
    }
    if (code === 'RATE_NOT_LOADED' || /rate.*not.*loaded/i.test(message)) {
      return '운임이 아직 등록되지 않은 배송사입니다. 워크북을 업로드하고 활성화한 뒤 다시 시도해 주세요.';
    }
    if (code === 'WEIGHT_OVER_MAX_BRACKET' || /no bracket|weight.*over/i.test(message)) {
      return '적용 가능한 중량구간이 없습니다. 실중량 또는 부피가 너무 큽니다.';
    }
    if (code === 'NO_ACTIVE_VERSION' || /no active/i.test(message)) {
      return '활성 운임 버전이 없습니다. 운임 버전을 먼저 활성화해 주세요.';
    }
    if (/eurKrwRate/i.test(message) || /HS fee/i.test(message)) {
      return 'EU 견적에 유로 환율(KRW/EUR)이 필요합니다. 환율을 입력하고 다시 시도해 주세요.';
    }
    return message ? `계산에 실패했습니다: ${message}` : `계산에 실패했습니다 (HTTP ${httpStatus}).`;
  }

  //   ─── Result renderer ──────────────────────────────────────────
  //   Produces the full result HTML: summary card + line-item table +
  //   optional EU block + metadata + collapsed raw JSON. Pure function
  //   of the server response object.

  function renderQuoteResultHtml(j, requestBody) {
    if (!j || typeof j !== 'object' || j.ok === false) {
      const httpMsg = _translateServerError(j, 200);
      return `
        <div style="background:#3a1a1a;border:1px solid #7a3030;border-radius:8px;padding:14px;color:#ef9a9a;margin-bottom:10px;">
          <div style="font-weight:600;margin-bottom:4px;">⚠ 견적 계산 실패</div>
          <div style="font-size:12px;">${esc(httpMsg)}</div>
        </div>
        ${_rawJsonBlock(j)}
      `;
    }

    const cd = j.calculationDetails || {};
    const isEu = !!cd.isEuDestination;

    //   Summary card — the "big number" the operator wants first.
    const summary = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:2px;">총 배송비</div>
          <div style="color:#69f0ae;font-size:20px;font-weight:700;">${esc(fmtWon(j.totalShippingCostKrw))}</div>
        </div>
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:2px;">청구중량</div>
          <div style="color:#fff;font-size:16px;font-weight:600;">${esc(fmtKg(j.chargeableWeightKg))}</div>
        </div>
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:2px;">배송사</div>
          <div style="color:#fff;font-size:16px;font-weight:600;">${esc(String(j.provider || '—'))}</div>
        </div>
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:2px;">서비스</div>
          <div style="color:#fff;font-size:13px;font-weight:600;word-break:break-all;">${esc(String(j.serviceCode || '—'))}</div>
        </div>
      </div>
    `;

    //   Line-item table.
    const rows = [
      ['실중량',            fmtKg(j.actualWeightKg)],
      ['부피계수',          fmtInt(j.volumetricDivisor)],
      ['부피중량',          fmtKg(j.volumetricWeightKg)],
      ['청구중량',          fmtKg(j.chargeableWeightKg)],
      ['적용 중량구간',     fmtKg(j.appliedWeightBracketKg)],
      ['기본운임',          fmtWon(j.baseRateKrw)],
      ['유류할증',          fmtWon(j.fuelSurchargeKrw)],
      ['수요·긴급할증',     fmtWon(j.demandSurchargeKrw)],
      ['EU VAT',            fmtWon(j.euVatKrw)],
      ['EU HS 수수료',      fmtWon(j.euHsFeeKrw)],
      ['기타 필수비용',     fmtWon(j.otherMandatoryFeeKrw)],
    ];
    const table = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:0;overflow:hidden;margin-bottom:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;color:#e0e0e0;">
          <tbody>
            ${rows.map(([k, v]) => `
              <tr style="border-bottom:1px solid #1f1f38;">
                <td style="padding:8px 12px;color:#aaa;width:45%;">${esc(k)}</td>
                <td style="padding:8px 12px;text-align:right;font-family:monospace;">${esc(v)}</td>
              </tr>`).join('')}
            <tr style="background:#132435;">
              <td style="padding:10px 12px;color:#69f0ae;font-weight:700;">총 배송비</td>
              <td style="padding:10px 12px;text-align:right;font-family:monospace;color:#69f0ae;font-weight:700;font-size:14px;">${esc(fmtWon(j.totalShippingCostKrw))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    //   EU-specific detail block.
    let euBlock = '';
    if (isEu) {
      const vatPct = (Number(cd.countryVatRate) || 0) * 100;
      const hsCount = Number(cd.uniqueHsCodeCount) || 0;
      const eurRate = Number(requestBody && requestBody.eurKrwRate) || 0;
      const hsFeeKrw = Number(j.euHsFeeKrw) || 0;
      const hsFormula = eurRate > 0
        ? `HS ${hsCount}개 × €3 × ${fmtInt(eurRate)}원 = ${fmtWon(hsCount * 3 * eurRate)}`
        : '(유로 환율 미입력)';
      euBlock = `
        <div style="background:#12233a;border:1px solid #2a4a6a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#81d4fa;font-weight:600;font-size:12px;margin-bottom:8px;">🇪🇺 EU 견적 세부내역</div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;color:#cfd8dc;">
            <tbody>
              <tr><td style="padding:4px 0;width:45%;color:#aaa;">국가 VAT율</td><td style="text-align:right;font-family:monospace;">${vatPct.toFixed(2)}%</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">신고가액</td><td style="text-align:right;font-family:monospace;">${esc(fmtWon(requestBody && requestBody.declaredValueKrw))}</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">VAT 금액</td><td style="text-align:right;font-family:monospace;">${esc(fmtWon(j.euVatKrw))}</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">고유 HS코드 수</td><td style="text-align:right;font-family:monospace;">${hsCount}개</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">EUR/KRW</td><td style="text-align:right;font-family:monospace;">${eurRate > 0 ? fmtInt(eurRate) + '원' : '—'}</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">HS 수수료 계산</td><td style="text-align:right;font-family:monospace;">${esc(hsFormula)}</td></tr>
              <tr><td style="padding:4px 0;color:#aaa;">HS 수수료 (원화)</td><td style="text-align:right;font-family:monospace;">${esc(fmtWon(hsFeeKrw))}</td></tr>
            </tbody>
          </table>
        </div>
      `;
    }

    //   Metadata footer.
    const meta = `
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:10px 12px;font-size:11px;color:#aaa;margin-bottom:10px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 16px;">
          <div><span style="color:#888;">운임 버전:</span> #${esc(String(j.rateVersionId ?? '—'))}</div>
          <div><span style="color:#888;">운임 적용일:</span> ${esc(String(j.rateEffectiveFrom || '—'))}</div>
          <div><span style="color:#888;">도착국가:</span> ${esc(String(j.destinationCountry || (requestBody && requestBody.destinationCountry) || '—'))}</div>
          <div><span style="color:#888;">판매방식:</span> ${esc(String((requestBody && requestBody.saleType) || '—'))}</div>
          <div><span style="color:#888;">계산시각:</span> ${esc(new Date().toLocaleString('ko-KR'))}</div>
        </div>
      </div>
    `;

    //   Warnings block (server-provided).
    const warns = Array.isArray(j.warnings) ? j.warnings : [];
    const warnsHtml = warns.length ? `
      <div style="background:#3a2e00;border:1px solid #7a5a00;border-radius:8px;padding:8px 12px;font-size:11px;color:#ffb74d;margin-bottom:10px;">
        ${warns.map(w => `<div>⚠ ${esc(String(w))}</div>`).join('')}
      </div>
    ` : '';

    return summary + table + euBlock + warnsHtml + meta + _rawJsonBlock(j);
  }

  function _rawJsonBlock(j) {
    //   Collapsed by default; operators never see it unless they open it.
    return `
      <details style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:8px 12px;">
        <summary style="cursor:pointer;color:#888;font-size:11px;user-select:none;">개발자용 JSON 보기</summary>
        <pre style="margin:8px 0 0;font-size:10px;color:#cfd8dc;white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;">${esc(JSON.stringify(j, null, 2))}</pre>
      </details>
    `;
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

  //   Module-scope in-flight guard so a double-click on the file input, or a
  //   drag-and-drop while a request is running, never fires two concurrent
  //   preview/commit rounds against production.
  let _uploadInFlight = false;

  async function onUpload(ev) {
    if (_uploadInFlight) {
      //   Reset the input so the user can re-select the same file after
      //   the current run finishes.
      try { ev.target.value = ''; } catch (_) {}
      return;
    }
    const file = ev.target.files[0];
    if (!file) return;
    ev.target.value = '';   //   allow re-selecting the same file after edit
    const resultEl = document.getElementById('sra-import-result');
    resultEl.innerHTML = '<span style="color:#888;">미리보기 중…</span>';
    _uploadInFlight = true;

    //   The upload trigger is a <label> wrapping <input type=file>. Disable
    //   the input (and gray the label) while a request is in flight.
    const inputEl = document.getElementById('sra-upload');
    if (inputEl) inputEl.disabled = true;
    const labelEl = inputEl && inputEl.parentElement;
    if (labelEl) labelEl.style.opacity = '0.5';

    try {
      //   ─── Step 1: preview ─────────────────────────────────────
      const fd = new FormData(); fd.append('workbook', file);
      const rP = await fetch('/api/shipping/rate-admin/import/preview', { method: 'POST', body: fd, credentials: 'include' });
      let jP = null;
      try { jP = await rP.json(); } catch (_) { /* malformed body handled below */ }
      if (!jP || typeof jP !== 'object') {
        resultEl.innerHTML = `<div style="color:#ef9a9a;">서버가 예상하지 못한 응답을 반환했습니다 (HTTP ${rP.status}).</div>`;
        return;
      }
      if (!rP.ok || !jP.ok) {
        const msgs = Array.isArray(jP.errors) && jP.errors.length ? jP.errors : [jP.error || `HTTP ${rP.status}`];
        resultEl.innerHTML = `<div style="color:#ef9a9a;">검증 실패:<ul>${msgs.map(e => `<li>${esc(String(e))}</li>`).join('')}</ul></div>`;
        return;
      }

      //   Schema fixed 2026-09-13: preview returns `versions[]` (plural,
      //   one entry per provider found in 원본목록). Skipped providers
      //   are discovered at commit time, not preview time.
      const previewVersions = Array.isArray(jP.versions) ? jP.versions : [];
      const counts = jP.counts || {};
      const countsMsg = `검증 통과: services=${counts.services ?? '?'} countries=${counts.countries ?? '?'} brackets=${counts.brackets ?? '?'} surcharges=${counts.surcharges ?? '?'}`;
      const warns = (jP.warnings || []).slice(0, 4).map(w => `⚠ ${esc(String(w))}`).join('\n');
      const versionsLine = previewVersions.length === 0
        ? '(원본목록에 provider 없음)'
        : previewVersions.map(v => `  · ${v && v.provider} — ${v && v.source_name || ''} (${v && v.effective_from || '?'})`).join('\n');
      const confirmMsg = `${countsMsg}\n\n감지된 provider (${previewVersions.length}개):\n${versionsLine}\n\n※ 실제 활성화될 provider는 저장 후 결과로 확인합니다 (운임 미적재 provider는 자동 skip).\n\n${warns}\n\nDB 에 저장할까요?`;
      if (!confirm(confirmMsg)) {
        resultEl.innerHTML = `<div style="color:#888;">미리보기 완료 (저장 취소). ${esc(countsMsg)}</div>`;
        return;
      }

      //   ─── Step 2: commit ──────────────────────────────────────
      resultEl.innerHTML = '<span style="color:#888;">저장 중…</span>';
      const fd2 = new FormData(); fd2.append('workbook', file);
      const rC = await fetch('/api/shipping/rate-admin/import/commit', { method: 'POST', body: fd2, credentials: 'include' });
      let jC = null;
      try { jC = await rC.json(); } catch (_) { /* handled below */ }
      if (!jC || typeof jC !== 'object') {
        resultEl.innerHTML = `<div style="color:#ef9a9a;">저장 실패: 서버가 예상하지 못한 응답을 반환했습니다 (HTTP ${rC.status}).</div>`;
        return;
      }
      if (!rC.ok || !jC.ok) {
        const msgs = Array.isArray(jC.errors) && jC.errors.length ? jC.errors : [jC.error || `HTTP ${rC.status}`];
        resultEl.innerHTML = `<div style="color:#ef9a9a;">저장 실패:<ul>${msgs.map(e => `<li>${esc(String(e))}</li>`).join('')}</ul></div>`;
        return;
      }

      //   Schema fixed 2026-09-13: commit returns { created[], skipped[] }
      //   `created[]` = providers whose rows landed (or were already there).
      //   `skipped[]` = providers whose rates aren't loaded — no version row.
      const created = Array.isArray(jC.created) ? jC.created.filter(x => x && x.provider) : [];
      const skipped = Array.isArray(jC.skipped) ? jC.skipped.filter(x => x && x.provider) : [];
      const createdLines = created.map(c => {
        const label = c.alreadyImported ? '이미 저장됨' : '신규 저장';
        const rc = c.rowCounts || {};
        return `<li><strong>${esc(c.provider)}</strong> — ${label} · versionId=${c.versionId != null ? c.versionId : '—'} · rows: services=${rc.services ?? 0}, countries=${rc.countries ?? 0}, brackets=${rc.brackets ?? 0}, surcharges=${rc.surcharges ?? 0}</li>`;
      }).join('');
      const skippedLines = skipped.map(s =>
        `<li><strong>${esc(s.provider)}</strong> — 운임 미적재로 건너뜀 (${esc(s.reason || 'no rate loaded')})</li>`
      ).join('');
      const warnsHtml = (jC.warnings || []).slice(0, 6).map(w => `<div style="color:#ffb74d;font-size:11px;">⚠ ${esc(String(w))}</div>`).join('');
      resultEl.innerHTML = `
        <div style="color:#69f0ae;font-weight:600;margin-bottom:6px;">✓ Import 완료</div>
        ${created.length ? `<div style="color:#c5e1a5;font-size:12px;margin-bottom:4px;">생성 · 갱신 (${created.length})</div><ul style="margin:0 0 8px 20px;color:#cfd8dc;font-size:11px;">${createdLines}</ul>` : ''}
        ${skipped.length ? `<div style="color:#aaa;font-size:12px;margin-bottom:4px;">건너뜀 (${skipped.length})</div><ul style="margin:0 0 8px 20px;color:#888;font-size:11px;">${skippedLines}</ul>` : ''}
        ${warnsHtml}
      `;
      //   Commit success → auto-refresh versions list.
      await loadVersions();
    } catch (e) {
      //   Network failure / thrown before response. Never let a leaked
      //   stack become a partial-success illusion.
      resultEl.innerHTML = `<div style="color:#ef9a9a;">실패: ${esc(e && e.message ? e.message : String(e))}</div>`;
    } finally {
      _uploadInFlight = false;
      if (inputEl) inputEl.disabled = false;
      if (labelEl) labelEl.style.opacity = '';
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
    //   1. Read + validate. All errors surface as Korean sentences.
    const body = readQuoteInputs();
    const v = validateQuoteInputs(body);
    if (!v.ok) {
      out.innerHTML = `
        <div style="background:#3a1a1a;border:1px solid #7a3030;border-radius:8px;padding:12px;color:#ef9a9a;font-size:12px;">
          <div style="font-weight:600;margin-bottom:6px;">입력값을 확인해 주세요</div>
          <ul style="margin:0 0 0 18px;padding:0;">${v.messages.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
        </div>
      `;
      return;
    }
    //   2. Fire multi-carrier compare (PMC-CCOREA-SHIPPING-1C).
    //   Single-service quote route (/quote) is still available and unchanged;
    //   compare is the new default surface for the operator.
    out.innerHTML = '<div style="color:#888;font-size:12px;">배송사별 견적 계산 중…</div>';
    let j = null; let httpStatus = 0;
    try {
      const r = await fetch('/api/shipping/rate-admin/quotes/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      httpStatus = r.status;
      try { j = await r.json(); } catch (_) { /* handled below */ }
    } catch (e) {
      out.innerHTML = `
        <div style="background:#3a1a1a;border:1px solid #7a3030;border-radius:8px;padding:12px;color:#ef9a9a;font-size:12px;">
          <div style="font-weight:600;margin-bottom:6px;">⚠ 네트워크 오류</div>
          <div>${esc(e && e.message ? e.message : String(e))}</div>
        </div>
      `;
      return;
    }
    //   3. Render compare table (success or translated error).
    if (!j || typeof j !== 'object' || j.ok === false || !Array.isArray(j.candidates)) {
      out.innerHTML = renderQuoteResultHtml(j, body);   //   fallback to error card
      return;
    }
    out.innerHTML = renderCompareTableHtml(j, body);
    _wireCompareSelection(j, body);
  }

  //   ─── Multi-carrier compare table renderer ─────────────────────
  //   Kept as a pure function so tests can lock in the display contract
  //   (owner directive §6 · §7 · §14).

  function _statusBadge(status) {
    const map = {
      ELIGIBLE:                { bg: '#1b5e20', fg: '#69f0ae', label: '선택 가능' },
      RATE_NOT_LOADED:         { bg: '#37474f', fg: '#aaa',    label: '운임 미등록' },
      COUNTRY_NOT_SUPPORTED:   { bg: '#37474f', fg: '#aaa',    label: '해당국가 미지원' },
      WEIGHT_NOT_SUPPORTED:    { bg: '#5d3a00', fg: '#ffb74d', label: '중량구간 없음' },
      SALE_TYPE_NOT_SUPPORTED: { bg: '#5d3a00', fg: '#ffb74d', label: '판매방식 미지원' },
      BRAND_RESTRICTED:        { bg: '#5d1a1a', fg: '#ef9a9a', label: '브랜드 제한' },
      INELIGIBLE:              { bg: '#5d1a1a', fg: '#ef9a9a', label: '이용 불가' },
    };
    const m = map[status] || map.INELIGIBLE;
    return `<span style="padding:2px 8px;background:${m.bg};color:${m.fg};border-radius:10px;font-size:10px;font-weight:600;">${esc(m.label)}</span>`;
  }

  function _incotermBadge(incoterm) {
    if (!incoterm) return '<span style="color:#666;">—</span>';
    const isDdp = /DDP/i.test(incoterm);
    const bg = isDdp ? '#0d3a5a' : '#3a2d0d';
    const fg = isDdp ? '#81d4fa' : '#ffcc80';
    const title = isDdp ? '판매자 관부가세 부담' : '구매자 관부가세 부담';
    return `<span title="${esc(title)}" style="padding:2px 6px;background:${bg};color:${fg};border-radius:4px;font-size:10px;font-weight:600;">${esc(String(incoterm))}</span>`;
  }

  function renderCompareTableHtml(j, requestBody) {
    const candidates = Array.isArray(j.candidates) ? [...j.candidates] : [];
    //   Sort: ELIGIBLE first (ascending by total), then everything else grouped.
    candidates.sort((a, b) => {
      if (a.eligible && !b.eligible) return -1;
      if (!a.eligible && b.eligible) return 1;
      if (a.eligible && b.eligible) return (a.totalShippingCostKrw || 0) - (b.totalShippingCostKrw || 0);
      return String(a.provider).localeCompare(String(b.provider));
    });
    const recommended = j.recommendedServiceCode || null;
    const warnsHtml = (j.warnings || []).map(w => `<div style="color:#ffb74d;font-size:11px;">⚠ ${esc(String(w))}</div>`).join('');
    const brandUnknownBanner = j.brandStatusUnknown ? `
      <div style="background:#3a2d0d;border:1px solid #7a5a00;border-radius:8px;padding:10px 12px;color:#ffcc80;font-size:12px;margin-bottom:10px;">
        ⚠ 이 상품의 브랜드 여부가 미확인 상태입니다. 자동 리스팅 전에 운영자가 확인해 주세요 (BRAND_STATUS_UNKNOWN).
      </div>
    ` : '';
    const rowsHtml = candidates.map(c => {
      const isRec = recommended && c.serviceCode === recommended;
      const canPick = c.eligible;
      const rowBg = canPick ? (isRec ? '#132a12' : 'transparent') : '#1a1319';
      return `
        <tr style="border-bottom:1px solid #23233a;background:${rowBg};">
          <td style="padding:8px;text-align:center;">
            <input type="radio" name="sra-c-pick" value="${esc(c.serviceCode)}" ${canPick ? '' : 'disabled'}
                   ${isRec && canPick ? 'checked' : ''} style="cursor:${canPick ? 'pointer' : 'not-allowed'};">
          </td>
          <td style="padding:8px;color:#fff;font-weight:600;font-size:11px;">${esc(c.provider)}${isRec ? ' <span style="color:#69f0ae;font-size:10px;">🏆 최저가 추천</span>' : ''}</td>
          <td style="padding:8px;color:#cfd8dc;font-size:11px;">${esc(c.serviceName || c.serviceCode)}</td>
          <td style="padding:8px;text-align:center;">${_incotermBadge(c.incoterm)}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;font-size:11px;">${esc(c.chargeableWeightKg == null ? '—' : fmtKg(c.chargeableWeightKg))}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;font-size:11px;">${esc(c.baseRateKrw == null ? '—' : fmtWon(c.baseRateKrw))}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;font-size:11px;">${esc(c.surchargeKrw == null && c.dutyVatKrw == null && c.euHsFeeKrw == null ? '—' : fmtWon((c.surchargeKrw || 0) + (c.dutyVatKrw || 0) + (c.euHsFeeKrw || 0)))}</td>
          <td style="padding:8px;text-align:right;font-family:monospace;font-size:12px;font-weight:${canPick ? '700' : '400'};color:${canPick ? '#69f0ae' : '#888'};">${esc(c.totalShippingCostKrw == null ? '—' : fmtWon(c.totalShippingCostKrw))}</td>
          <td style="padding:8px;text-align:center;">${_statusBadge(c.status)}${c.unavailableReason ? `<div style="color:#888;font-size:10px;margin-top:2px;">${esc(c.unavailableReason)}</div>` : ''}</td>
        </tr>
      `;
    }).join('');
    return `
      ${brandUnknownBanner}
      ${warnsHtml ? `<div style="margin-bottom:10px;">${warnsHtml}</div>` : ''}
      <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:0;overflow-x:auto;margin-bottom:12px;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;color:#e0e0e0;min-width:780px;">
          <thead>
            <tr style="background:#132435;">
              <th style="padding:8px;text-align:center;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">선택</th>
              <th style="padding:8px;text-align:left;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">배송사</th>
              <th style="padding:8px;text-align:left;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">서비스</th>
              <th style="padding:8px;text-align:center;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">조건</th>
              <th style="padding:8px;text-align:right;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">청구중량</th>
              <th style="padding:8px;text-align:right;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">기본운임</th>
              <th style="padding:8px;text-align:right;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">세금·할증</th>
              <th style="padding:8px;text-align:right;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">총비용</th>
              <th style="padding:8px;text-align:center;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">상태</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div id="sra-c-detail" style="min-height:20px;"></div>
      ${_rawJsonBlock(j)}
    `;
  }

  function _wireCompareSelection(j, requestBody) {
    const detail = document.getElementById('sra-c-detail');
    if (!detail) return;
    const pick = (serviceCode) => {
      const cand = (j.candidates || []).find(c => c.serviceCode === serviceCode && c.eligible);
      if (!cand) { detail.innerHTML = ''; return; }
      //   Rebuild a quote-shaped object so the existing single-quote renderer
      //   can format the detailed breakdown card. Keeps one renderer for the
      //   detail view, and the compare table for the top summary.
      const asQuote = {
        ok: true,
        provider: cand.provider, serviceCode: cand.serviceCode,
        destinationCountry: requestBody.destinationCountry,
        volumetricDivisor: null,
        actualWeightKg: cand.actualWeightKg,
        volumetricWeightKg: cand.volumetricWeightKg,
        chargeableWeightKg: cand.chargeableWeightKg,
        appliedWeightBracketKg: cand.appliedWeightBracketKg,
        baseRateKrw: cand.baseRateKrw,
        fuelSurchargeKrw: 0,
        demandSurchargeKrw: cand.surchargeKrw || 0,
        euVatKrw: cand.dutyVatKrw || 0,
        euHsFeeKrw: cand.euHsFeeKrw || 0,
        otherMandatoryFeeKrw: 0,
        totalShippingCostKrw: cand.totalShippingCostKrw,
        rateVersionId: cand.rateVersionId,
        rateEffectiveFrom: cand.rateEffectiveFrom,
        calculationDetails: { isEuDestination: !!requestBody.declaredValueKrw && cand.dutyVatKrw > 0, uniqueHsCodeCount: requestBody.uniqueHsCodeCount, countryVatRate: 0 },
        warnings: cand.warnings || [],
      };
      detail.innerHTML = `
        <div style="color:#888;font-size:11px;margin:6px 0;">선택한 서비스 상세 (${esc(cand.provider)} · ${esc(cand.serviceCode)})</div>
        ${renderQuoteResultHtml(asQuote, requestBody)}
      `;
    };
    document.querySelectorAll('input[name="sra-c-pick"]').forEach(el => {
      el.addEventListener('change', () => { if (el.checked) pick(el.value); });
      if (el.checked) pick(el.value);
    });
  }

  window.pmcShippingRateAdmin = {
    init,
    //   Test-only surface: pure helpers so the tester UI contract can be
    //   locked in without a real browser. Never call these from product code.
    _test: {
      fmtWon, fmtKg, fmtInt,
      validateQuoteInputs, readQuoteInputs,
      renderQuoteResultHtml, _translateServerError,
      renderCompareTableHtml, _statusBadge, _incotermBadge,
    },
  };
})();
