/**
 * Owner Inventory Decisions — Phase 8I
 *
 * READ-ONLY dashboard consuming existing SoT via Phase 8I API:
 *   GET /api/oms/owner/inventory-exceptions       — batch queue (Phase 8B)
 *   GET /api/oms/owner/inventory-decision/:id     — Phase 8E projection
 *   GET /api/oms/owner/inventory-actions/:id      — Phase 8F workflow
 *   POST /api/oms/owner/evidence/preview          — Phase 8G preview (no writes)
 *   POST /api/oms/owner/evidence/record           — Phase 8G record (gated by {confirm:true})
 *   POST /api/oms/owner/evidence/reassess-after-record  — Phase 8G reassessment
 *
 * NO buttons for: purchase / hold / marketplace / listing / inventory adjust.
 * NO parallel decision logic. Detail is loaded lazily per-item.
 */
(function () {
  let currentSelected = null;
  let lastListResult = null;

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function pct(v) { return v == null ? '—' : (Math.round(Number(v) * 1000) / 10) + '%'; }
  function krw(v) { return v == null ? 'UNKNOWN' : Number(v).toLocaleString('en-US') + ' KRW'; }
  function num(v) { return v == null ? '—' : String(v); }

  async function load() {
    const root = document.getElementById('page-owner-inventory');
    if (!root) return;
    if (root.dataset.initialized !== '1') {
      root.dataset.initialized = '1';
      renderShell(root);
    }
    await refreshList();
  }

  function renderShell(root) {
    root.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:22px;color:#fff;margin:0 0 4px;">📋 인벤토리 결정 · Owner Console</h1>
        <p style="color:#888;font-size:13px;margin:0;">오늘 검토해야 할 예외만 표시합니다. 결정 · 이유 · 필요한 증거 · 액션.</p>
      </div>

      <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div id="oi-generated" style="color:#aaa;font-size:12px;"></div>
        <button id="oi-refresh" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">새로고침</button>
      </div>

      <div id="oi-summary" style="margin-bottom:14px;"></div>
      <div id="oi-list" style="margin-bottom:14px;"></div>

      <!-- Phase 8J · Data Quality drill-down (INSUFFICIENT_DATA) -->
      <div id="oi-dq-list" style="margin-bottom:14px;"></div>

      <!-- Detail panel · lazy loaded on click -->
      <div id="oi-detail" style="display:none;margin-top:16px;padding:16px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;"></div>

      <div style="margin-top:20px;padding:10px;background:#0e0e1e;border:1px dashed #2a2a4a;border-radius:6px;color:#78909c;font-size:11px;line-height:1.6;">
        <b>정책:</b> 자동 구매 없음 · 자동 전략 보류 없음 · 마켓플레이스 변경 없음 · 재고 조정 없음 · 알림 발송 없음.
        UNKNOWN은 UNKNOWN으로 유지 · 결정은 Owner가 · 시스템은 추천만.
      </div>
    `;
    document.getElementById('oi-refresh').addEventListener('click', refreshList);
  }

  async function refreshList() {
    const summaryEl = document.getElementById('oi-summary');
    const listEl = document.getElementById('oi-list');
    summaryEl.innerHTML = '<div style="padding:14px;color:#aaa;text-align:center;">로딩 중...</div>';
    listEl.innerHTML = '';
    try {
      const res = await fetch('/api/oms/owner/inventory-exceptions', { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'load failed (' + res.status + ')');
      lastListResult = json;
      renderSummary(json);
      renderList(json);
      renderDqList(json);
    } catch (e) {
      summaryEl.innerHTML = '<div style="padding:14px;color:#ef9a9a;">로드 실패: ' + esc(e.message) + '</div>';
    }
  }

  function renderSummary(r) {
    const s = r.summary || {};
    const gen = r.generated_at ? ('생성 ' + new Date(r.generated_at).toLocaleString('ko-KR')) : '';
    document.getElementById('oi-generated').textContent = gen + (s.runtime_ms != null ? ('  · runtime ' + Math.round(s.runtime_ms) + 'ms') : '');

    const cell = (label, value, color) => (
      '<div style="flex:1;min-width:120px;padding:10px 14px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;">' +
      '<div style="color:#aaa;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">' + esc(label) + '</div>' +
      '<div style="color:' + color + ';font-size:22px;font-weight:600;margin-top:4px;">' + num(value) + '</div>' +
      '</div>'
    );
    document.getElementById('oi-summary').innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      cell('WATCH', s.watch_count, '#ffb74d') +
      cell('REPLENISH', s.replenish_count, '#64b5f6') +
      cell('PROTECT STOCK', s.protect_stock_count, '#ef9a9a') +
      cell('DATA QUALITY', s.data_quality_count, '#ce93d8') +
      cell('sell_normally', s.sell_normally_count, '#69f0ae') +
      '</div>';
  }

  function statusColor(status) {
    if (status === 'WATCH') return '#ffb74d';
    if (status === 'REPLENISH') return '#64b5f6';
    if (status === 'PROTECT_STOCK') return '#ef9a9a';
    if (status === 'INSUFFICIENT_DATA') return '#ce93d8';
    return '#78909c';
  }

  function renderList(r) {
    const rows = r.action_queue || [];
    const listEl = document.getElementById('oi-list');
    if (rows.length === 0) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#69f0ae;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;">오늘 처리할 예외가 없습니다. ✓</div>';
      return;
    }
    listEl.innerHTML = rows.map(row => renderCard(row)).join('');
    // Wire "View decision" buttons — lazy per-item detail fetch (Owner §Part 10).
    listEl.querySelectorAll('[data-oi-view]').forEach(btn => {
      btn.addEventListener('click', () => openDetail(parseInt(btn.getAttribute('data-oi-view'), 10)));
    });
  }

  function renderCard(row) {
    const color = statusColor(row.decision_status);
    return (
      '<div style="margin-bottom:10px;padding:12px 14px;background:#1a1a2e;border:1px solid #2a2a4a;border-left:3px solid ' + color + ';border-radius:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
      '<div>' +
      '<span style="display:inline-block;padding:2px 8px;background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;border-radius:4px;font-size:11px;font-weight:600;">' + esc(row.decision_status) + '</span>' +
      '<span style="color:#fff;font-weight:600;margin-left:10px;">' + esc(row.title || ('phys#' + row.physical_product_id)) + '</span>' +
      '<span style="color:#78909c;font-size:11px;margin-left:8px;">#' + esc(row.physical_product_id) + '</span>' +
      '</div>' +
      '<div style="color:#aaa;font-size:12px;">우선순위 <b style="color:#fff;">' + esc(row.priority_score) + '</b> · confidence ' + esc(row.confidence_level || '?') + '</div>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;color:#cfd8dc;font-size:12px;">' +
      '<div>재고 <b style="color:#fff;">' + num(row.available_units) + '</b></div>' +
      '<div>수요 <b style="color:#fff;">' + esc(row.demand_pattern || '?') + '</b></div>' +
      '<div>교체 <b style="color:#fff;">' + esc(row.replacement_difficulty || '?') + '</b></div>' +
      '<div>증거 depth <b style="color:#fff;">' + num(row.evidenced_replacement_depth) + '</b></div>' +
      '<div>depth gap <b style="color:#fff;">' + num(row.depth_gap) + '</b></div>' +
      '</div>' +
      '<div style="margin-top:8px;">' +
      '<button data-oi-view="' + esc(row.physical_product_id) + '" type="button" style="padding:5px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">결정 보기</button>' +
      '</div>' +
      '</div>'
    );
  }

  // Phase 8J · DATA QUALITY drill-down. Renders INSUFFICIENT_DATA physicals
  // that the list endpoint already returned in `data_quality_queue[]` but the
  // Phase 8I UI ignored beyond the counter.
  function renderDqList(r) {
    const dq = r.data_quality_queue || [];
    const el = document.getElementById('oi-dq-list');
    if (!el) return;
    if (dq.length === 0) { el.innerHTML = ''; return; }
    const color = '#ce93d8';
    const rows = dq.map(row => (
      '<div style="margin-bottom:8px;padding:10px 12px;background:#1a1a2e;border:1px solid #2a2a4a;border-left:3px solid ' + color + ';border-radius:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
      '<div>' +
      '<span style="display:inline-block;padding:2px 8px;background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;border-radius:4px;font-size:11px;font-weight:600;">DATA QUALITY</span>' +
      '<span style="color:#fff;font-weight:600;margin-left:10px;">' + esc(row.title || ('phys#' + row.physical_product_id)) + '</span>' +
      '<span style="color:#78909c;font-size:11px;margin-left:8px;">#' + esc(row.physical_product_id) + '</span>' +
      '</div>' +
      '<div style="color:#aaa;font-size:12px;">' + esc(row.classification || 'insufficient_data') + '</div>' +
      '</div>' +
      ((row.missing_evidence || []).length ? '<div style="margin-top:6px;color:#ffb74d;font-size:11px;">missing: ' + esc(row.missing_evidence.join(', ')) + '</div>' : '') +
      ((row.reason_codes || []).length ? '<div style="color:#78909c;font-size:11px;">' + esc(row.reason_codes.join(' · ')) + '</div>' : '') +
      (row.error_message ? '<div style="color:#ef9a9a;font-size:11px;">error: ' + esc(row.error_message) + '</div>' : '') +
      '<div style="margin-top:8px;">' +
      '<button data-oi-view="' + esc(row.physical_product_id) + '" type="button" style="padding:5px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">결정 보기</button>' +
      '</div>' +
      '</div>'
    )).join('');
    el.innerHTML =
      '<div style="color:' + color + ';font-size:12px;font-weight:600;margin:12px 0 6px;">📊 DATA QUALITY (' + dq.length + ')</div>' +
      rows;
    el.querySelectorAll('[data-oi-view]').forEach(btn => {
      btn.addEventListener('click', () => openDetail(parseInt(btn.getAttribute('data-oi-view'), 10)));
    });
  }

  async function openDetail(physicalId) {
    currentSelected = physicalId;
    const el = document.getElementById('oi-detail');
    el.style.display = 'block';
    el.innerHTML = '<div style="color:#aaa;">로딩 중... (physical#' + physicalId + ')</div>';
    try {
      const res = await fetch('/api/oms/owner/inventory-actions/' + physicalId, { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'detail failed (' + res.status + ')');
      renderDetail(json.owner_decision, json.workflow);
    } catch (e) {
      el.innerHTML = '<div style="color:#ef9a9a;">상세 로드 실패: ' + esc(e.message) + '</div>';
    }
  }

  function renderDetail(od, wf) {
    const el = document.getElementById('oi-detail');
    if (!od) { el.innerHTML = '<div style="color:#ef9a9a;">데이터 없음</div>'; return; }
    const color = statusColor(od.headline.decision_status);
    const inv = od.inventory || {}, dm = od.demand || {}, sp = od.supply || {}, cc = od.cost_context || {}, rs = od.reasons || {};

    const kv = (label, value) => (
      '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1f1f3a;">' +
      '<span style="color:#aaa;font-size:12px;">' + esc(label) + '</span>' +
      '<span style="color:#fff;font-size:12px;">' + esc(value) + '</span></div>'
    );

    const openActions = (wf?.workflow_actions || []).filter(a => a.action_code !== 'WATCH_ONLY' && (a.status === 'OPEN' || a.status === 'EVIDENCE_PARTIAL' || a.status === 'OWNER_REVIEW_REQUIRED' || a.status === 'EVIDENCE_READY'));
    const observations = (wf?.workflow_actions || []).filter(a => a.action_code === 'WATCH_ONLY');

    const actionBlock = (a) => (
      '<div style="margin-bottom:8px;padding:8px 10px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<div style="color:#fff;font-weight:600;font-size:12px;">' + esc(a.action_code) + ' <span style="color:#aaa;font-weight:400;margin-left:8px;">[' + esc(a.status) + ']</span></div>' +
      (a.why_now ? '<div style="color:#cfd8dc;font-size:11px;margin-top:3px;">' + esc(a.why_now) + '</div>' : '') +
      (a.current_evidence?.length ? '<div style="color:#78909c;font-size:11px;margin-top:4px;">현재 증거: ' + esc(a.current_evidence.join(', ')) + '</div>' : '') +
      (a.missing_evidence?.length ? '<div style="color:#ffb74d;font-size:11px;margin-top:2px;">누락: ' + esc(a.missing_evidence.join(', ')) + '</div>' : '') +
      (a.not_accepted_as_closure?.length ? '<div style="color:#ef9a9a;font-size:11px;margin-top:2px;">CLOSURE 불인정: ' + esc(a.not_accepted_as_closure.join(', ')) + '</div>' : '') +
      '</div>'
    );

    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
      '<div>' +
      '<span style="display:inline-block;padding:2px 10px;background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;border-radius:4px;font-weight:600;">' + esc(od.headline.decision_status) + '</span>' +
      '<span style="color:#fff;font-weight:600;margin-left:10px;font-size:15px;">' + esc(od.product?.title || '(no title)') + '</span>' +
      '<span style="color:#78909c;font-size:11px;margin-left:8px;">physical#' + esc(od.physical_product_id) + ' · ' + esc(od.product?.set_code || '?') + ' · ' + esc(od.product?.language || '?') + '</span>' +
      '</div>' +
      '<div style="color:#aaa;font-size:12px;">priority <b style="color:#fff;">' + esc(od.headline.priority_score) + '</b> · confidence ' + esc(od.headline.confidence_level || '?') + ' · urgency ' + esc(od.headline.urgency_label || '?') + '</div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">' +

      '<div>' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">WHY</div>' +
      (rs.reason_codes?.length ? rs.reason_codes.map(r => '<div style="color:#cfd8dc;font-size:12px;">· ' + esc(r) + '</div>').join('') : '<div style="color:#78909c;font-size:12px;">(reason codes 없음)</div>') +
      (rs.hold_quantity_blockers?.length ? '<div style="color:#aaa;font-size:11px;margin-top:4px;">hold blockers: ' + esc(rs.hold_quantity_blockers.join(', ')) + '</div>' : '') +
      (rs.missing_evidence?.length ? '<div style="color:#ffb74d;font-size:11px;margin-top:4px;">missing evidence: ' + esc(rs.missing_evidence.join(', ')) + '</div>' : '') +
      '</div>' +

      '<div>' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">INVENTORY</div>' +
      kv('on_hand', num(inv.on_hand)) + kv('reserved', num(inv.reserved)) + kv('available', num(inv.available)) +
      '</div>' +

      '<div>' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">DEMAND</div>' +
      kv('7d', num(dm.units_7d)) + kv('30d', num(dm.units_30d)) + kv('velocity_30d', dm.velocity_30d != null ? Number(dm.velocity_30d).toFixed(2) + '/day' : '—') + kv('raw_days_of_supply', dm.raw_days_of_supply != null ? Number(dm.raw_days_of_supply).toFixed(2) : '—') + kv('pattern', dm.demand_pattern || '?') + kv('largest_shipment', num(dm.largest_shipment_units_30d) + (dm.largest_shipment_share_30d != null ? ' (' + pct(dm.largest_shipment_share_30d) + ')' : '')) +
      '</div>' +

      '<div>' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">SUPPLY</div>' +
      kv('current_supply_quality', sp.current_supply_quality || '?') + kv('replacement_difficulty', sp.replacement_difficulty || '?') + kv('evidenced_depth', num(sp.evidenced_replacement_depth)) + kv('depth_gap', num(sp.depth_gap)) + kv('uncovered_at_60', num(sp.uncovered_at_60)) + kv('uncovered_at_100', num(sp.uncovered_at_100)) + kv('secondary_dep_60', pct(sp.secondary_market_dependency_at_60)) + kv('has_current_supplier_or_executable', String(sp.has_current_supplier_or_executable)) + kv('supplier_diversity', num(sp.supplier_diversity)) +
      '</div>' +

      '<div style="grid-column:1/-1;">' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">COST CONTEXT <span style="color:#78909c;font-size:10px;font-weight:400;">(카테고리 분리 · 자동 합산 없음)</span></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:12px;">' +
      '<div style="flex:1;min-width:200px;padding:8px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;"><div style="color:#aaa;font-size:11px;">historical typical supplier</div><div style="color:#fff;font-size:14px;font-weight:600;">' + esc(krw(cc.historical_typical_supplier_cost_krw_median)) + '</div></div>' +
      '<div style="flex:1;min-width:200px;padding:8px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;"><div style="color:#aaa;font-size:11px;">historical accounting cost</div><div style="color:#fff;font-size:14px;font-weight:600;">' + esc(krw(cc.historical_accounting_cost_krw)) + '</div></div>' +
      '<div style="flex:1;min-width:200px;padding:8px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;"><div style="color:#aaa;font-size:11px;">observed secondary ask</div><div style="color:#fff;font-size:14px;font-weight:600;">' + esc(krw(cc.observed_secondary_market_ask_min_krw)) + '</div></div>' +
      '</div>' +
      '</div>' +

      '<div style="grid-column:1/-1;">' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">OPEN ACTIONS</div>' +
      (openActions.length ? openActions.map(actionBlock).join('') : '<div style="color:#78909c;font-size:12px;">(open action 없음)</div>') +
      '</div>' +

      (observations.length ? (
      '<div style="grid-column:1/-1;">' +
      '<div style="color:#fff;font-weight:600;margin-bottom:6px;font-size:13px;">OBSERVATION</div>' +
      observations.map(a => '<div style="color:#cfd8dc;font-size:12px;">· ' + esc(a.action_code) + '</div>').join('') +
      '</div>') : '') +

      '</div>' +   // grid end

      renderEvidencePanel(od) +

      // Phase 8K · 판단 신뢰도 + 숫자의 출처 (기존 8I/8J UI 위에 additive)
      renderJudgmentConfidencePanel(od) +
      renderDataProvenancePanel(od) +

      // Phase 8L · 수익성 / 재고가치 (lazy loaded · collapsible · category-independent scenarios)
      '<div id="oi-financial" style="margin-top:16px;padding:12px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<div style="color:#fff;font-weight:600;font-size:13px;">💰 수익성 / 재고가치 <span style="color:#78909c;font-weight:400;font-size:11px;">(카테고리 분리 · 자동 합산 없음)</span></div>' +
      '<button id="oi-financial-toggle" type="button" style="padding:4px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">계산 열기</button>' +
      '</div>' +
      '<div id="oi-financial-body" style="display:none;color:#aaa;font-size:12px;"></div>' +
      '</div>' +

      // Phase 8J · Evidence history timeline (lazy loaded)
      '<div id="oi-history" style="margin-top:16px;padding:12px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<div style="color:#fff;font-weight:600;font-size:13px;">📜 EVIDENCE HISTORY <span style="color:#78909c;font-weight:400;font-size:11px;">(newest first · fresh vs stale)</span></div>' +
      '<button id="oi-history-refresh" type="button" style="padding:4px 10px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">새로고침</button>' +
      '</div>' +
      '<div id="oi-history-body" style="color:#aaa;font-size:12px;">로딩 중...</div>' +
      '</div>' +

      '<div style="margin-top:14px;padding:10px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;color:#78909c;font-size:11px;">' +
      '자동 실행 금지: 구매 · 전략 보류 · 마켓플레이스 변경 · 리스팅 변경 · 재고 조정 · 알림 발송.' +
      '</div>';

    wireEvidencePanel(od);
    document.getElementById('oi-history-refresh').addEventListener('click', () => loadEvidenceHistory(od.physical_product_id));
    loadEvidenceHistory(od.physical_product_id);
    wireFinancialPanel(od);
  }

  // ─── Phase 8L · 수익성 / 재고가치 (collapsible · category-independent · UNKNOWN never 0) ──

  function wireFinancialPanel(od) {
    const btn = document.getElementById('oi-financial-toggle');
    const body = document.getElementById('oi-financial-body');
    if (!btn || !body) return;
    let loaded = false;
    btn.addEventListener('click', async () => {
      if (body.style.display === 'none') {
        body.style.display = 'block';
        btn.textContent = '접기';
        if (!loaded) {
          body.innerHTML = renderFinancialInputForm(od);
          wireFinancialInputForm(od);
          loaded = true;
        }
      } else {
        body.style.display = 'none';
        btn.textContent = '계산 열기';
      }
    });
  }

  function renderFinancialInputForm(od) {
    return (
      '<div style="padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:8px;">' +
      '<div style="color:#cfd8dc;font-size:11px;margin-bottom:6px;">판매가/배송비를 확인된 값으로 입력하세요. 비워두면 해당 metric은 "확인되지 않음"으로 표시됩니다. 자동 추정하지 않습니다.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">예상 판매가 (KRW)' +
      '<input type="number" id="oi-fm-price" min="0" step="1" placeholder="예: 100000" style="margin-top:2px;padding:6px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:4px;color:#fff;font-size:12px;"/></label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">판매가 출처 (선택)' +
      '<input type="text" id="oi-fm-price-src" maxlength="200" placeholder="예: ebay_listing:205376020693" style="margin-top:2px;padding:6px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:4px;color:#fff;font-size:12px;"/></label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">판매자 부담 배송비 (KRW)' +
      '<input type="number" id="oi-fm-ship" min="0" step="1" placeholder="예: 8000" style="margin-top:2px;padding:6px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:4px;color:#fff;font-size:12px;"/></label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">배송 출처 (선택)' +
      '<input type="text" id="oi-fm-ship-src" maxlength="200" placeholder="예: kpacket_us" style="margin-top:2px;padding:6px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:4px;color:#fff;font-size:12px;"/></label>' +
      '</div>' +
      '<button type="button" id="oi-fm-calc" style="margin-top:8px;padding:6px 14px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">계산</button>' +
      '</div>' +
      '<div id="oi-fm-result"></div>'
    );
  }

  function wireFinancialInputForm(od) {
    const btn = document.getElementById('oi-fm-calc');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const price = document.getElementById('oi-fm-price').value;
      const priceSrc = document.getElementById('oi-fm-price-src').value;
      const ship = document.getElementById('oi-fm-ship').value;
      const shipSrc = document.getElementById('oi-fm-ship-src').value;
      const q = new URLSearchParams();
      if (price) q.set('expected_sale_price_krw', price);
      if (priceSrc) q.set('expected_sale_price_source', priceSrc);
      if (ship) q.set('seller_borne_shipping_krw', ship);
      if (shipSrc) q.set('shipping_source', shipSrc);
      const resultEl = document.getElementById('oi-fm-result');
      resultEl.innerHTML = '<div style="color:#78909c;padding:8px;">계산 중...</div>';
      try {
        const res = await fetch('/api/oms/owner/financial-metrics/' + encodeURIComponent(od.physical_product_id) + '?' + q.toString(), { credentials: 'same-origin' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'financial metrics failed (' + res.status + ')');
        resultEl.innerHTML = renderFinancialMetricsResult(json.financial_metrics);
      } catch (e) {
        resultEl.innerHTML = '<div style="color:#ef9a9a;padding:8px;">계산 실패: ' + esc(e.message) + '</div>';
      }
    });
  }

  function renderFinancialMetricsResult(fm) {
    if (!fm || !fm.scenarios) return '<div style="color:#78909c;">결과 없음</div>';
    const missing = (fm.missing_inputs || []).length
      ? '<div style="color:#ffb74d;font-size:11px;margin-bottom:6px;">누락 입력: ' + esc(fm.missing_inputs.join(', ')) + '</div>'
      : '';
    const caveats = (fm.caveats || []).length
      ? '<div style="color:#cfd8dc;font-size:11px;margin-bottom:6px;">' + fm.caveats.map(c => '· ' + esc(c)).join('<br/>') + '</div>'
      : '';
    const scenarioBlocks = ['accounting', 'replacement', 'secondary_market_ask']
      .map(k => renderScenarioBlock(k, fm.scenarios[k]))
      .join('');
    return missing + caveats + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;">' + scenarioBlocks + '</div>';
  }

  function renderScenarioBlock(key, s) {
    if (!s) return '';
    const title = key === 'accounting' ? '회계 원가 기준' : key === 'replacement' ? '대체 원가 기준 (historical supplier)' : '시장 참고가 기준 (secondary market ask)';
    const badge = key === 'secondary_market_ask' ? '<span style="color:#ffb74d;font-size:10px;margin-left:6px;">REFERENCE ONLY</span>' : '';
    const kvNum = (label, statusObj, key2 = 'amount_krw') => {
      if (!statusObj || statusObj.status !== 'AVAILABLE') {
        const reason = statusObj && Array.isArray(statusObj.missing) && statusObj.missing.length ? ' (' + esc(statusObj.missing.join(', ')) + ')' : '';
        return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1f1f3a;"><span style="color:#aaa;font-size:11px;">' + esc(label) + '</span><span style="color:#78909c;font-size:11px;">확인되지 않음' + reason + '</span></div>';
      }
      const v = statusObj[key2];
      const disp = key2 === 'pct' ? (Number(v).toFixed(2) + '%') : krw(v);
      return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1f1f3a;"><span style="color:#aaa;font-size:11px;">' + esc(label) + '</span><span style="color:#fff;font-size:11px;">' + esc(disp) + '</span></div>';
    };
    const costLabel = s.cost_basis_krw != null ? krw(s.cost_basis_krw) : '확인되지 않음';
    return (
      '<div style="padding:10px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<div style="color:#fff;font-weight:600;font-size:12px;margin-bottom:2px;">' + esc(title) + badge + '</div>' +
      '<div style="color:#78909c;font-size:10px;margin-bottom:6px;">원가 근거: <code style="color:#cfd8dc;">' + esc(s.cost_basis_source) + '</code> · ' + esc(costLabel) + '</div>' +
      kvNum('예상 판매대금', s.expected_sale_proceeds) +
      kvNum('예상 총이익', s.gross_profit) +
      kvNum('예상 마진 %', s.gross_margin, 'pct') +
      kvNum('손익분기 판매가', s.break_even_price) +
      kvNum('재고가치', s.inventory_value) +
      (s.cost_basis_note ? '<div style="color:#78909c;font-size:10px;margin-top:4px;font-style:italic;">' + esc(s.cost_basis_note) + '</div>' : '') +
      '</div>'
    );
  }

  // ─── Phase 8K · 판단 신뢰도 & 숫자의 출처 (UNKNOWN/null은 숨기지 않고 "확인되지 않음"으로 표시) ───

  function fmtOrUnknown(v) {
    if (v === null || v === undefined) return '<span style="color:#78909c;">확인되지 않음</span>';
    if (v === 'UNKNOWN') return '<span style="color:#78909c;">확인되지 않음 (UNKNOWN)</span>';
    return esc(String(v));
  }
  function tierBadge(tier) {
    const t = tier || 'UNKNOWN';
    const color = t === 'HIGH' ? '#69f0ae' : t === 'MEDIUM' ? '#64b5f6' : t === 'LOW' ? '#ffb74d' : '#78909c';
    return '<span style="padding:2px 8px;background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;border-radius:4px;font-size:11px;font-weight:600;">' + esc(t) + '</span>';
  }

  function renderJudgmentConfidencePanel(od) {
    const jc = od.judgment_confidence;
    if (!jc) return '';
    const dim = jc.by_dimension || {};
    const actionLine = (arr) => (Array.isArray(arr) && arr.length > 0)
      ? '<div style="color:#cfd8dc;font-size:11px;margin-top:2px;">권장 evidence action: ' + arr.map(a => '<code style="color:#fff;">' + esc(a) + '</code>').join(' · ') + '</div>'
      : '<div style="color:#78909c;font-size:11px;margin-top:2px;">권장 evidence action 없음</div>';
    const dimBlock = (label, d, extra) => (
      '<div style="padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<div style="color:#fff;font-weight:600;font-size:12px;">' + esc(label) + '</div>' +
      '<div>' + tierBadge(d?.tier) + '</div>' +
      '</div>' +
      (extra ? '<div style="color:#aaa;font-size:11px;margin-top:3px;">' + extra + '</div>' : '') +
      actionLine(d?.recommended_evidence_actions) +
      '</div>'
    );
    const demandExtra = dim.demand
      ? 'trusted=' + fmtOrUnknown(dim.demand.trusted) + (dim.demand.trust_reason ? ' · trust_reason=' + esc(dim.demand.trust_reason) : '')
      : null;
    const supplyExtra = dim.supply
      ? 'quality=' + fmtOrUnknown(dim.supply.current_supply_quality)
        + ' · layers=' + fmtOrUnknown(dim.supply.current_supply_layers)
        + ' · has_primary=' + fmtOrUnknown(dim.supply.has_current_supplier_or_executable)
        + ' · dep60=' + (dim.supply.secondary_market_dependency_at_60 == null ? '확인되지 않음' : (Math.round(dim.supply.secondary_market_dependency_at_60 * 1000) / 10) + '%')
        + ' · evidence_confidence_upstream=' + fmtOrUnknown(dim.supply.evidence_confidence_upstream)
      : null;
    const costCatTiers = dim.cost?.category_tiers;
    const costCatLine = costCatTiers
      ? ' · category_tiers: supplier=' + tierBadge(costCatTiers.supplier)
        + ' accounting=' + tierBadge(costCatTiers.accounting)
        + ' secondary_market=' + tierBadge(costCatTiers.secondary_market)
      : '';
    const costExtra = dim.cost
      ? 'typical_supplier_observations=' + fmtOrUnknown(dim.cost.typical_supplier_observation_count)
        + ' · secondary_fresh_observations=' + fmtOrUnknown(dim.cost.secondary_market_fresh_observations_count)
        + ' · freshness_verified=' + fmtOrUnknown(dim.cost.freshness_verified)
        + costCatLine
      : null;
    const identityExtra = dim.identity
      ? 'identity_verified=' + fmtOrUnknown(dim.identity.identity_verified)
        + ' · blockers=' + (dim.identity.hold_quantity_blockers?.length ? esc(dim.identity.hold_quantity_blockers.join(', ')) : '없음')
      : null;

    const overallLine =
      '<div style="margin-bottom:8px;">' +
      '전체 신뢰도: ' + tierBadge(jc.overall_tier) +
      ' · headline (Phase 8E verbatim): ' + fmtOrUnknown(jc.headline_confidence_level) +
      (jc.derived_matches_headline === false
        ? ' <span style="color:#ffb74d;font-size:11px;">⚠ headline과 derived overall 불일치 (둘 다 노출)</span>'
        : '') +
      '</div>';

    return (
      '<details style="margin-top:14px;padding:10px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;" open>' +
      '<summary style="cursor:pointer;color:#fff;font-weight:600;font-size:13px;">📊 판단 신뢰도 <span style="color:#78909c;font-weight:400;font-size:11px;">(deterministic derived · Phase 8K)</span></summary>' +
      '<div style="margin-top:10px;">' +
      overallLine +
      dimBlock('수요 (demand)', dim.demand, demandExtra) +
      dimBlock('공급 (supply)', dim.supply, supplyExtra) +
      dimBlock('원가 (cost)', dim.cost, costExtra) +
      dimBlock('정체성 (identity)', dim.identity, identityExtra) +
      '<div style="color:#78909c;font-size:11px;margin-top:6px;">tier 순서: UNKNOWN &lt; LOW &lt; MEDIUM &lt; HIGH · 상승 보장 아님 · Owner가 evidence 검토용으로 참고.</div>' +
      (jc.note ? '<div style="color:#78909c;font-size:11px;margin-top:2px;">' + esc(jc.note) + '</div>' : '') +
      '</div></details>'
    );
  }

  function renderDataProvenancePanel(od) {
    const dp = od.data_provenance;
    if (!dp) return '';
    const row = (label, value) => '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #1f1f3a;"><span style="color:#aaa;font-size:11px;">' + esc(label) + '</span><span style="color:#fff;font-size:11px;">' + fmtOrUnknown(value) + '</span></div>';
    const block = (title, obj) => {
      if (!obj) return '';
      return (
        '<div style="padding:8px;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:6px;">' +
        '<div style="color:#fff;font-weight:600;font-size:12px;margin-bottom:4px;">' + esc(title) + '</div>' +
        Object.keys(obj).filter(k => k !== 'note').map(k => row(k, obj[k])).join('') +
        (obj.note ? '<div style="color:#78909c;font-size:10px;margin-top:3px;">note: ' + esc(obj.note) + '</div>' : '') +
        '</div>'
      );
    };
    return (
      '<details style="margin-top:12px;padding:10px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<summary style="cursor:pointer;color:#fff;font-weight:600;font-size:13px;">🔍 숫자의 출처 <span style="color:#78909c;font-weight:400;font-size:11px;">(upstream metadata projection · Phase 8K)</span></summary>' +
      '<div style="margin-top:10px;">' +
      block('inventory', dp.inventory) +
      block('demand', dp.demand) +
      block('supply', dp.supply) +
      (dp.cost_context ? '<div style="color:#fff;font-weight:600;font-size:12px;margin:6px 0 4px;">cost_context</div>' + block('typical_supplier', dp.cost_context.historical_typical_supplier_cost_krw_median) + block('accounting_cost', dp.cost_context.historical_accounting_cost_krw) + block('observed_secondary_ask', dp.cost_context.observed_secondary_market_ask_min_krw) : '') +
      '<div style="color:#78909c;font-size:11px;margin-top:4px;">upstream이 필드를 제공하지 않으면 "확인되지 않음"으로 표시 · UNKNOWN을 숨기지 않음.</div>' +
      (dp.note ? '<div style="color:#78909c;font-size:11px;margin-top:2px;">' + esc(dp.note) + '</div>' : '') +
      '</div></details>'
    );
  }

  // Phase 8J · Evidence history timeline · reads /api/oms/owner/evidence-history/:id
  async function loadEvidenceHistory(physicalId) {
    const body = document.getElementById('oi-history-body');
    if (!body) return;
    body.innerHTML = '<span style="color:#aaa;">로딩 중...</span>';
    try {
      const res = await fetch('/api/oms/owner/evidence-history/' + physicalId + '?limit=50', { credentials: 'include' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'history failed (' + res.status + ')');
      renderEvidenceHistory(body, json);
    } catch (e) {
      body.innerHTML = '<span style="color:#ef9a9a;">history 로드 실패: ' + esc(e.message) + '</span>';
    }
  }

  function evidenceTypeColor(t) {
    if (t === 'EXECUTABLE_QUOTE') return '#69f0ae';
    if (t === 'SUPPLIER_QUOTE') return '#64b5f6';
    if (t === 'SECONDARY_MARKET_ASK') return '#ffb74d';
    if (t === 'TYPICAL_SUPPLIER_REFERENCE') return '#ce93d8';
    if (t === 'ACTUAL_PURCHASE') return '#b0bec5';
    return '#78909c';
  }

  function renderEvidenceHistory(body, r) {
    const obs = r.observations || [];
    if (obs.length === 0) {
      body.innerHTML = '<div style="color:#78909c;padding:6px;">(관측 이력 없음)</div>';
      return;
    }
    const policyDays = r.policy_reference?.replacement_price_freshness_days;
    const header = '<div style="color:#78909c;font-size:11px;margin-bottom:6px;">총 ' + r.total_observations + ' · 표시 ' + r.returned_observations + ' · freshness 정책 ' + (policyDays != null ? policyDays + 'd' : '?') + ' (' + esc(r.policy_reference?.policy_source || '?') + ')</div>';

    const rows = obs.map(o => {
      const color = evidenceTypeColor(o.evidence_type);
      const freshBadge = o.fresh
        ? '<span style="color:#69f0ae;font-size:10px;font-weight:600;">FRESH</span>'
        : '<span style="color:#78909c;font-size:10px;">STALE</span>';
      const classColor = o.classification === 'strong' ? '#69f0ae' : o.classification === 'historical_reference' ? '#ce93d8' : o.classification === 'ambiguous' ? '#ffb74d' : '#ef9a9a';
      const priceStr = o.product_cost_krw_per_physical != null ? Number(o.product_cost_krw_per_physical).toLocaleString('en-US') + ' KRW/unit' : 'UNKNOWN';
      const landedTag = o.landed_cost_status && o.landed_cost_status !== 'UNKNOWN' ? ' · landed ' + esc(o.landed_cost_status) : '';
      return (
        '<div style="padding:6px 8px;margin-bottom:5px;background:#1a1a2e;border:1px solid #2a2a4a;border-left:3px solid ' + color + ';border-radius:4px;">' +
        '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
        '<div>' +
        '<span style="color:' + color + ';font-weight:600;font-size:11px;">' + esc(o.evidence_type || '(no type)') + '</span>' +
        '<span style="color:#cfd8dc;font-size:11px;margin-left:8px;">' + esc(o.source || '?') + (o.supplier_name ? ' · ' + esc(o.supplier_name) : '') + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:#aaa;">' + esc(o.observed_at || '?') + ' · ' + (o.age_days != null ? o.age_days + 'd ago' : '?') + ' · ' + freshBadge + '</div>' +
        '</div>' +
        '<div style="color:#cfd8dc;font-size:11px;margin-top:3px;">' +
        priceStr + ' · <span style="color:' + classColor + ';">' + esc(o.classification) + '</span>' +
        (o.identity_match_status ? ' · identity=' + esc(o.identity_match_status) : '') +
        landedTag +
        (o.moq_physical_units != null ? ' · MOQ ' + o.moq_physical_units : '') +
        (o.lead_time_days != null ? ' · lead ' + o.lead_time_days + 'd' : '') +
        '</div>' +
        (o.reject_reason ? '<div style="color:#78909c;font-size:10px;margin-top:2px;">reason: ' + esc(o.reject_reason) + '</div>' : '') +
        '</div>'
      );
    }).join('');
    body.innerHTML = header + rows;
  }

  // ─── Evidence capture panel ─────────────────────────────
  function renderEvidencePanel(od) {
    const disabled = !!(window.__pmcUser && window.__pmcUser.isLegacy);
    return (
      '<div id="oi-evidence" style="margin-top:16px;padding:12px;background:#0e0e1e;border:1px solid #2a2a4a;border-radius:6px;">' +
      '<div style="color:#fff;font-weight:600;font-size:13px;margin-bottom:8px;">📝 증거 입력 (기본 = PREVIEW ONLY)</div>' +
      (disabled ? '<div style="color:#ffb74d;font-size:11px;margin-bottom:8px;">⚠ 레거시 공유 비밀번호 계정은 증거를 기록할 수 없습니다 — 실제 Owner 계정으로 로그인하세요.</div>' : '') +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:8px;">' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">유형' +
      '<select id="oi-ev-type" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '<option value="SUPPLIER_QUOTE">SUPPLIER_QUOTE</option>' +
      '<option value="EXECUTABLE_QUOTE">EXECUTABLE_QUOTE</option>' +
      '<option value="SECONDARY_MARKET_ASK">SECONDARY_MARKET_ASK</option>' +
      '</select></label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">공급처/셀러/마켓' +
      '<input id="oi-ev-source" type="text" placeholder="예: 드림토이 · kream" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">가격 (KRW)' +
      '<input id="oi-ev-price" type="number" min="1" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">수량 exact' +
      '<input id="oi-ev-qty" type="number" min="0" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">수량 min' +
      '<input id="oi-ev-qty-min" type="number" min="0" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">수량 max' +
      '<input id="oi-ev-qty-max" type="number" min="0" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;color:#aaa;font-size:11px;">observed_at' +
      '<input id="oi-ev-observed" type="datetime-local" style="margin-top:2px;padding:4px;background:#1a1a2e;color:#fff;border:1px solid #2a2a4a;border-radius:4px;">' +
      '</label>' +
      '</div>' +
      '<div style="display:flex;gap:12px;margin:6px 0;color:#cfd8dc;font-size:12px;">' +
      '<label><input id="oi-ev-identity" type="checkbox"> identity_confirmed</label>' +
      '<label><input id="oi-ev-cq" type="checkbox"> current_quote_confirmed</label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
      '<button id="oi-ev-preview" type="button" style="padding:6px 12px;background:#37474f;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">Preview</button>' +
      '<button id="oi-ev-record" type="button" ' + (disabled ? 'disabled ' : '') + 'style="padding:6px 12px;background:#455a64;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;' + (disabled ? 'opacity:0.5;cursor:not-allowed;' : '') + '">Record Evidence</button>' +
      '</div>' +
      '<div id="oi-ev-result" style="margin-top:10px;color:#cfd8dc;font-size:12px;"></div>' +
      '</div>'
    );
  }

  function collectEvidenceInput(od) {
    const type = document.getElementById('oi-ev-type').value;
    const source = document.getElementById('oi-ev-source').value.trim();
    const priceStr = document.getElementById('oi-ev-price').value;
    const qtyStr = document.getElementById('oi-ev-qty').value;
    const qtyMinStr = document.getElementById('oi-ev-qty-min').value;
    const qtyMaxStr = document.getElementById('oi-ev-qty-max').value;
    const observedStr = document.getElementById('oi-ev-observed').value;
    const identityConfirmed = document.getElementById('oi-ev-identity').checked;
    const currentQuoteConfirmed = document.getElementById('oi-ev-cq').checked;
    return {
      physicalId: od.physical_product_id,
      evidenceType: type,
      source: source || (type === 'SECONDARY_MARKET_ASK' ? 'secondary_market' : null),
      supplierName: type === 'SECONDARY_MARKET_ASK' ? null : source,
      currency: 'KRW',
      price: priceStr ? Number(priceStr) : null,
      priceBasis: 'per_physical_unit',
      physicalUnitsPerOffer: 1,
      availableQuantityExact: qtyStr ? parseInt(qtyStr, 10) : null,
      availableQuantityMin: qtyMinStr ? parseInt(qtyMinStr, 10) : null,
      availableQuantityMax: qtyMaxStr ? parseInt(qtyMaxStr, 10) : null,
      observedAt: observedStr ? new Date(observedStr).toISOString() : null,
      sourceClass: type === 'SECONDARY_MARKET_ASK' ? 'secondary_market' : 'primary_distributor',
      identityConfirmed,
      currentQuoteConfirmed,
    };
  }

  function wireEvidencePanel(od) {
    document.getElementById('oi-ev-preview').addEventListener('click', () => evidencePreview(od));
    document.getElementById('oi-ev-record').addEventListener('click', () => evidenceRecord(od));
  }

  async function evidencePreview(od) {
    const resEl = document.getElementById('oi-ev-result');
    resEl.innerHTML = '<span style="color:#aaa;">preview 요청 중...</span>';
    try {
      const body = collectEvidenceInput(od);
      const res = await fetch('/api/oms/owner/evidence/preview', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'preview failed (' + res.status + ')');
      resEl.innerHTML = renderEvidenceResult(json, /*isRecord*/ false, /*reassessment*/ null);
    } catch (e) {
      resEl.innerHTML = '<span style="color:#ef9a9a;">preview 실패: ' + esc(e.message) + '</span>';
    }
  }

  async function evidenceRecord(od) {
    const body = collectEvidenceInput(od);
    if (!body.identityConfirmed) { alert('identity_confirmed 를 반드시 체크해야 기록할 수 있습니다.'); return; }
    if ((body.evidenceType === 'SUPPLIER_QUOTE' || body.evidenceType === 'EXECUTABLE_QUOTE') && !body.currentQuoteConfirmed) {
      alert(body.evidenceType + ' 는 current_quote_confirmed 를 반드시 체크해야 기록할 수 있습니다.'); return;
    }
    // Explicit two-step Owner confirmation (idiomatic per repo · double-confirm for high-risk).
    const qtyLabel = body.availableQuantityExact != null ? ('exact ' + body.availableQuantityExact)
      : (body.availableQuantityMin != null || body.availableQuantityMax != null)
        ? ((body.availableQuantityMin ?? '?') + '–' + (body.availableQuantityMax ?? '?'))
        : 'UNKNOWN';
    const confirmMsg = [
      'YOU ARE ABOUT TO RECORD EVIDENCE',
      '',
      'Product: ' + (od.product?.title || '(no title)') + ' (physical#' + od.physical_product_id + ')',
      'Type:    ' + body.evidenceType,
      'Source:  ' + (body.source || '(secondary marketplace)') + (body.supplierName ? ' · supplier=' + body.supplierName : ''),
      'Price:   ' + (body.price != null ? Number(body.price).toLocaleString('en-US') : '?') + ' KRW / physical',
      'Qty:     ' + qtyLabel,
      'Observed: ' + (body.observedAt || '?'),
      '',
      'This WILL: write 1 canonical evidence observation',
      'This WILL NOT: purchase / reserve / hold / change inventory / change marketplace / send notification',
      '',
      '기록하시겠습니까?',
    ].join('\n');
    if (!window.confirm(confirmMsg)) return;
    if (!window.confirm('정말 기록하시겠습니까? (한 번 더 확인)')) return;

    const resEl = document.getElementById('oi-ev-result');
    resEl.innerHTML = '<span style="color:#aaa;">record 요청 중...</span>';

    // Capture the BEFORE snapshot from what the UI already has (Owner decision + workflow).
    let beforeSnapshot = null;
    try {
      const wfRes = await fetch('/api/oms/owner/inventory-actions/' + od.physical_product_id, { credentials: 'include' });
      const wfJson = await wfRes.json().catch(() => ({}));
      if (wfRes.ok) beforeSnapshot = { owner_decision: wfJson.owner_decision, workflow: wfJson.workflow };
    } catch (_) { /* non-fatal */ }

    try {
      const res = await fetch('/api/oms/owner/evidence/record', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, confirm: true }),
      });
      const json = await res.json().catch(() => ({}));
      const recordOk = res.ok && (json?.plan?.status === 'ingested' || json?.plan?.status === 'partial');
      let reassessment = null;
      if (recordOk && beforeSnapshot) {
        const rRes = await fetch('/api/oms/owner/evidence/reassess-after-record', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ physicalId: od.physical_product_id, beforeSnapshot }),
        });
        const rJson = await rRes.json().catch(() => ({}));
        if (rRes.ok) reassessment = rJson;
      }
      resEl.innerHTML = renderEvidenceResult(json, /*isRecord*/ true, reassessment);
      if (recordOk) {
        // Refresh detail panel so Owner can see updated decision state.
        // Phase 8J · openDetail re-renders history via loadEvidenceHistory,
        //   so the just-recorded observation appears immediately.
        openDetail(od.physical_product_id);
      }
    } catch (e) {
      resEl.innerHTML = '<span style="color:#ef9a9a;">record 실패: ' + esc(e.message) + '</span>';
    }
  }

  function renderEvidenceResult(result, isRecord, reassessment) {
    const v = result.validation || {};
    const p = result.plan || {};
    const gp = v.action_gap_projection || {};
    const lines = [];
    lines.push('<div style="color:#fff;font-weight:600;">' + (isRecord ? 'RECORD 결과' : 'PREVIEW 결과') + '</div>');
    lines.push('<div>validation: ok=' + esc(String(v.ok)) + '</div>');
    if ((v.errors || []).length) lines.push('<div style="color:#ef9a9a;">ERROR: ' + esc(v.errors.join(' · ')) + '</div>');
    if ((v.warnings || []).length) lines.push('<div style="color:#ffb74d;">warn: ' + esc(v.warnings.join(' · ')) + '</div>');
    if ((result.gate_errors || []).length) lines.push('<div style="color:#ef9a9a;">gate: ' + esc(result.gate_errors.join(' · ')) + '</div>');
    lines.push('<div style="margin-top:4px;">would close · CHECK_PRIMARY_SUPPLIER: ' + (gp.would_close_CHECK_PRIMARY_SUPPLIER ? 'yes' : 'no') +
               ' · CONFIRM_EXECUTABLE_QUOTE: ' + (gp.would_close_CONFIRM_EXECUTABLE_QUOTE ? 'yes' : 'no') +
               ' · CHECK_SECONDARY_MARKET: ' + (gp.would_close_CHECK_SECONDARY_MARKET ? 'yes' : 'no') + '</div>');
    if ((gp.forbidden_promotion || []).length) lines.push('<div style="color:#ef9a9a;">✗ ' + esc(gp.forbidden_promotion.join(' · ')) + '</div>');
    lines.push('<div>persistence: <b>' + esc(result.persistence || '?') + '</b>' + (p.status ? ' · ingestor_status=' + esc(p.status) : '') + '</div>');
    if (p.inserted?.length) lines.push('<div>inserted=' + p.inserted.length + '</div>');
    if (p.skipped_idempotent?.length) lines.push('<div>skipped_idempotent=' + p.skipped_idempotent.length + '</div>');
    if (p.failed?.length) lines.push('<div style="color:#ef9a9a;">failed=' + p.failed.length + '</div>');
    if (reassessment) {
      lines.push('<div style="margin-top:6px;color:#fff;font-weight:600;">REASSESSMENT</div>');
      const b = reassessment.before || {}, a = reassessment.after || {};
      if (a && a.decision_status) {
        lines.push('<div>BEFORE: ' + esc(b.decision_status) + ' · priority ' + esc(b.priority_score) + ' · quality ' + esc(b.supply_current_quality || '?') + '</div>');
        lines.push('<div>AFTER : ' + esc(a.decision_status) + ' · priority ' + esc(a.priority_score) + ' · quality ' + esc(a.supply_current_quality || '?') + '</div>');
        const changedKeys = Object.keys(reassessment.changed || {});
        if (changedKeys.length === 0) lines.push('<div style="color:#78909c;">Decision unchanged.</div>');
        else lines.push('<div>CHANGED: ' + esc(changedKeys.join(', ')) + '</div>');
      } else {
        lines.push('<div>' + esc(reassessment.note || reassessment.status || '') + '</div>');
      }
    }
    return lines.join('');
  }

  window.pmcOwnerInventory = { init: load, load, refresh: refreshList };
})();
