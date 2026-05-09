/**
 * WMS 주문 import UI — Phase 2 PR 3 (orderImport)
 *
 * 책임:
 *   - mock JSON 입력 (textarea)
 *   - 기본 예시 채우기 + 테스트용 external_order_id 자동 timestamp suffix 옵션
 *   - POST /api/orders/mock-import 호출 (credentials: include)
 *   - 결과 summary 표시 (200/400/401/403/409/500 분기)
 *   - import 성공 후 orderList refresh + 신규 주문 자동 선택
 *   - 409 응답의 existing_order_id 가 있으면 해당 주문 상세 열기
 *
 * 정책:
 *   - DB target = wms_orders / wms_order_lines (backend 가 보장. UI 는 API 만 호출)
 *   - 기존 public.orders 일체 미참조
 *   - secret/token 원본 강조 표시 금지 — API 응답만 표시
 *   - raw_payload 무분별 dump 금지
 */
(function () {
  let user = null;

  // ── helpers ─────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // 기본 예시 JSON (사장님 spec 그대로)
  const DEFAULT_EXAMPLE = {
    marketplace: 'ebay',
    external_order_id: 'EBAY-2026-001',
    order_status: 'paid',
    buyer_name: 'Test Buyer',
    buyer_country: 'US',
    buyer_contact: {
      email: 'buyer@example.com',
      phone: '010-1234-5678',
    },
    ordered_at: '2026-05-09T03:00:00Z',
    total_amount: 89.99,
    currency: 'USD',
    lines: [
      {
        external_line_id: 'TXN-A',
        marketplace_sku: 'PMC-151-BOX',
        listing_id: '123456789012',
        option_id: null,
        title: 'Pokemon 151 Booster Box',
        quantity: 1,
        unit_price: 89.99,
        currency: 'USD',
        raw_payload: {
          ebay_internal_token: 'sk_should_be_redacted',
        },
      },
      {
        external_line_id: 'TXN-B',
        marketplace_sku: 'UNKNOWN-WRONG-SKU',
        listing_id: '999999999999',
        title: 'Unknown Item',
        quantity: 2,
        unit_price: 0.99,
      },
    ],
  };

  function timestampSuffix() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function buildExampleJson({ uniqueOrderId } = {}) {
    const ex = JSON.parse(JSON.stringify(DEFAULT_EXAMPLE));
    if (uniqueOrderId) ex.external_order_id = `EBAY-TEST-${timestampSuffix()}`;
    return JSON.stringify(ex, null, 2);
  }

  // ── entry ────────────────────────────────────────────────
  async function init() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;
    const root = document.getElementById('wms-import-section');
    if (!root) return;
    if (!user || !user.isAdmin) {
      root.innerHTML = '<div style="padding:20px;color:#888;">관리자 전용 영역입니다.</div>';
      return;
    }
    if (root.dataset.initialized === '1') return;  // 중복 init 방지 (ops-menu 클릭 반복)
    root.dataset.initialized = '1';
    renderShell(root);
  }

  function renderShell(root) {
    root.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">📦 WMS 주문 Import / 매칭</h1>
        <p style="color:#888;font-size:13px;margin:0;">mock JSON 으로 wms_orders / wms_order_lines 에 주문을 import 하고 SKU 매칭 결과를 확인합니다. (기존 public.orders eBay sync 와 별 흐름)</p>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
          <strong style="color:#fff;font-size:14px;">📥 Mock JSON 입력</strong>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button id="oi-fill" type="button" title="external_order_id = EBAY-2026-001 (고정 — 중복 import 테스트용)" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">예시 JSON 채우기</button>
            <button id="oi-fill-unique" type="button" title="external_order_id = EBAY-TEST-{YYYYMMDD-HHmmss} (매번 신규 — KST 로컬 시간)" style="padding:6px 12px;background:#1565c0;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">예시 JSON 채우기 (Unique)</button>
            <button id="oi-clear" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#aaa;cursor:pointer;font-size:12px;">비우기</button>
          </div>
        </div>

        <textarea id="oi-json" rows="14" placeholder='{ "marketplace": "ebay", "external_order_id": "...", "lines": [ ... ] }' style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;color:#cfd8dc;border-radius:6px;font-family:monospace;font-size:12px;box-sizing:border-box;"></textarea>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;flex-wrap:wrap;gap:8px;">
          <div id="oi-result" style="font-size:12px;color:#aaa;flex:1;min-width:200px;"></div>
          <button id="oi-submit" type="button" style="padding:8px 16px;background:#1565c0;border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">Import 실행</button>
        </div>
      </div>
    `;

    // 버튼 A — 항상 EBAY-2026-001 고정 (중복 import 테스트용)
    document.getElementById('oi-fill').addEventListener('click', () => {
      document.getElementById('oi-json').value = buildExampleJson({ uniqueOrderId: false });
      document.getElementById('oi-result').textContent = '';
    });
    // 버튼 B — 누를 때마다 새 EBAY-TEST-{YYYYMMDD-HHmmss} (신규 주문 테스트용)
    document.getElementById('oi-fill-unique').addEventListener('click', () => {
      document.getElementById('oi-json').value = buildExampleJson({ uniqueOrderId: true });
      document.getElementById('oi-result').textContent = '';
    });
    document.getElementById('oi-clear').addEventListener('click', () => {
      document.getElementById('oi-json').value = '';
      document.getElementById('oi-result').textContent = '';
    });
    document.getElementById('oi-submit').addEventListener('click', onSubmit);
  }

  async function onSubmit() {
    const ta = document.getElementById('oi-json');
    const resultDiv = document.getElementById('oi-result');
    const submitBtn = document.getElementById('oi-submit');
    const raw = ta.value.trim();

    if (!raw) {
      resultDiv.innerHTML = '<span style="color:#ef9a9a;">JSON 을 입력하세요. ("예시 JSON 채우기" 가능)</span>';
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#ef9a9a;">JSON parse 실패: ${esc(e.message)}</span>`;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '실행 중...';
    resultDiv.innerHTML = '<span style="color:#aaa;">서버에 import 요청 중...</span>';

    try {
      const res = await fetch('/api/orders/mock-import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 409 && json.code === 'DUPLICATE_ORDER') {
        const existingId = json.existing_order_id ?? null;
        const linkBtn = existingId
          ? ` <button id="oi-open-existing" type="button" style="padding:3px 10px;background:#1565c0;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:11px;margin-left:6px;">기존 주문 #${existingId} 열기</button>`
          : '';
        resultDiv.innerHTML = `<span style="color:#ffb74d;">⚠️ 이미 import 된 주문입니다 (${esc(payload.marketplace)} / ${esc(payload.external_order_id)})${linkBtn}</span>`;
        if (existingId) {
          document.getElementById('oi-open-existing').addEventListener('click', () => {
            if (window.pmcOrderList && typeof pmcOrderList.openDetail === 'function') {
              pmcOrderList.openDetail(existingId);
            }
          });
        }
        return;
      }
      if (res.status === 401 || res.status === 403) {
        resultDiv.innerHTML = `<span style="color:#ef9a9a;">권한 오류 (${res.status}): ${esc(json.error || 'admin 권한 필요')}</span>`;
        return;
      }
      if (res.status === 400) {
        resultDiv.innerHTML = `<span style="color:#ef9a9a;">입력 검증 실패 (400): ${esc(json.error || 'unknown')}</span>`;
        return;
      }
      if (!res.ok) {
        resultDiv.innerHTML = `<span style="color:#ef9a9a;">생성 실패 (${res.status}): ${esc(json.error || 'unknown')}</span>`;
        return;
      }

      // 성공 (201)
      const t = json.totals || {};
      const cardLink = (t.cards_created > 0 || t.overflow_card_created)
        ? ` <a href="/?page=exception-tasks" style="color:#ef9a9a;text-decoration:underline;">→ ⚠️ 자동 예외 콘솔 열기</a>`
        : '';
      resultDiv.innerHTML = `
        <div style="color:#69f0ae;font-weight:600;">✓ Import 성공 — order #${json.order_id}</div>
        <div style="margin-top:4px;color:#aaa;font-size:11px;">
          ${esc(json.marketplace)} / ${esc(json.external_order_id)} ·
          line ${t.line_count} · matched ${t.matched_count} · failed ${t.failed_count} ·
          cards ${t.cards_created}${t.overflow_card_created ? ' (+overflow)' : ''}${t.capped_line_count ? ` (capped ${t.capped_line_count})` : ''}${cardLink}
        </div>
      `;

      // 목록 refresh + 신규 주문 자동 선택 (orderList 모듈에 위임)
      if (window.pmcOrderList && typeof pmcOrderList.refresh === 'function') {
        await pmcOrderList.refresh();
        if (typeof pmcOrderList.openDetail === 'function' && json.order_id) {
          pmcOrderList.openDetail(json.order_id);
        }
      }
    } catch (err) {
      resultDiv.innerHTML = `<span style="color:#ef9a9a;">네트워크 오류: ${esc(err.message)}</span>`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Import 실행';
    }
  }

  window.pmcOrderImport = { init };
})();
