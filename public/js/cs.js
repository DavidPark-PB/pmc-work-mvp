/**
 * CS 지원 (PR CS-G1-F) — 반자동 답변 워크플로우.
 *
 * 좌측: 메시지 + 자동 분석 (category + extracted vars + candidates hint)
 * 우측: 추천 템플릿 라디오 + 영업 옵션 체크박스 + 미리보기 + AI 톤 다듬기 + 복사/저장
 *
 * 정책 (사장님 spec + 짚을 점):
 *   - AI 는 마지막 톤 다듬기만 (그룹 3 활성). 그룹 1 = disabled + tooltip
 *   - 추출된 변수 = input 값으로 채움 + 🤖 아이콘 + tooltip "AI 자동 추출 — 수정 가능"
 *   - 미리보기 = read-only → "✏️ 편집" → editable textarea. 편집 후엔 그 텍스트가 final
 *   - candidates 가 2+ 개면 select 옆에 hint
 *   - 진상 매칭 / 위험 신호 영역 = 그룹 2 에서 신설 (그룹 1 미노출)
 *   - 기존 템플릿 관리 탭 보존
 */
(function() {
  let user = null;
  let templates = [];
  let viewMode = 'compose'; // 'compose' | 'manage'

  // 새 state (PR CS-G1-F)
  let currentAnalysis = null;       // POST /api/cs/analyze 결과 캐시
  let recommendedTemplates = [];    // 분석으로 받은 추천 템플릿
  let salesOptionsByCategory = [];  // 분석으로 받은 영업 옵션
  let selectedTemplateId = null;
  let selectedSalesOptionIds = new Set();
  let previewText = '';             // render-template 결과 또는 직원 편집 본문
  let editMode = false;             // 미리보기 편집 모드 여부
  let renderTimer = null;           // debounce 타이머

  // PR CS-G2-F state
  let currentSuspiciousMatch = null;  // analyze 응답의 suspiciousMatch
  let currentFraudSignals = [];       // analyze 응답의 fraudSignals
  let suspiciousList = [];            // 관리 탭 목록 캐시

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function flagOfLang(l) { return { en: '🇬🇧', ko: '🇰🇷', ja: '🇯🇵', zh: '🇨🇳' }[l] || '🏳️'; }
  // spec 7 카테고리 + 기존 cs_templates 의 추가 카테고리 모두 포함
  function catLabel(c) {
    return ({
      // spec 7 (PR CS-G1)
      shipping: '배송', refund: '환불', stock: '재고', thanks: '감사',
      complaint: '클레임', fraud_suspect: '🚩 사기 의심', pre_purchase: '구매 전 질문',
      // 기존 cs_templates 카테고리 (호환 보존)
      order: '주문', product: '상품문의', restock: '재입고', general: '일반',
    })[c] || c;
  }
  function catColor(c) {
    return ({
      shipping: '#1565c0', refund: '#c62828', stock: '#ef6c00', thanks: '#2e7d32',
      complaint: '#d81b60', fraud_suspect: '#b71c1c', pre_purchase: '#6a1b9a',
      order: '#2e7d32', product: '#6a1b9a', restock: '#ef6c00', general: '#616161',
    })[c] || '#8d6e63';
  }
  // analyze 응답에 등장 가능한 7 카테고리 + 기존 호환
  const CATEGORY_OPTIONS = [
    'shipping', 'refund', 'stock', 'thanks', 'complaint', 'fraud_suspect', 'pre_purchase',
    'order', 'product', 'restock', 'general',
  ];

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json())).user;
    if (!user) return;
    renderShell();
    await loadTemplates();
    renderCompose();
  }

  async function loadTemplates() {
    try {
      const res = await fetch('/api/cs/templates');
      const j = await res.json();
      templates = j.data || [];
    } catch (e) { templates = []; }
  }

  function renderShell() {
    const el = document.getElementById('page-cs');
    const manageTab = user.isAdmin ? `<button type="button" id="cs-tab-manage" onclick="pmcCs.switchView('manage')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">⚙️ 템플릿 관리</button>` : '';
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">💬 CS 지원 <span style="color:#888;font-weight:400;font-size:13px;">· 템플릿 + 영업 옵션 + 진상 DB</span></h1>
        <p style="color:#888;font-size:13px;">고객 메시지를 분석하면 카테고리/변수/진상 매칭/위험 신호가 자동 표시됩니다. 답변은 템플릿 + 영업 옵션 체크로 조립.</p>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #2a2a4a;">
        <button type="button" id="cs-tab-compose" onclick="pmcCs.switchView('compose')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">✍️ 답변 작성</button>
        <button type="button" id="cs-tab-suspicious" onclick="pmcCs.switchView('suspicious')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">🚩 진상 바이어 DB</button>
        ${user.isAdmin ? `<button type="button" id="cs-tab-results" onclick="pmcCs.switchView('results')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">📝 결과 입력 대기</button>` : ''}
        ${manageTab}
      </div>

      <div id="cs-compose"></div>
      <div id="cs-suspicious" style="display:none;"></div>
      <div id="cs-results" style="display:none;"></div>
      <div id="cs-manage" style="display:none;"></div>
    `;
  }

  function _setTabActive(id, active) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.color = active ? '#fff' : '#888';
    el.style.fontWeight = active ? '600' : '400';
    el.style.borderBottom = active ? '2px solid #7c4dff' : '2px solid transparent';
  }

  function switchView(v) {
    viewMode = v;
    _setTabActive('cs-tab-compose', v === 'compose');
    _setTabActive('cs-tab-suspicious', v === 'suspicious');
    if (user.isAdmin) {
      _setTabActive('cs-tab-results', v === 'results');
      _setTabActive('cs-tab-manage', v === 'manage');
    }
    document.getElementById('cs-compose').style.display = v === 'compose' ? '' : 'none';
    document.getElementById('cs-suspicious').style.display = v === 'suspicious' ? '' : 'none';
    document.getElementById('cs-results').style.display = v === 'results' ? '' : 'none';
    document.getElementById('cs-manage').style.display = v === 'manage' ? '' : 'none';
    if (v === 'manage') renderManage();
    else if (v === 'suspicious') renderSuspiciousList();
    else if (v === 'results') renderResultsDashboard();
    else renderCompose();
  }

  // ── 답변 작성 (PR CS-G1-F 신규 워크플로우) ──
  function renderCompose() {
    const host = document.getElementById('cs-compose');
    if (!host) return;
    // 상태 초기화 (탭 전환 시 깨끗한 상태)
    currentAnalysis = null;
    recommendedTemplates = [];
    salesOptionsByCategory = [];
    selectedTemplateId = null;
    selectedSalesOptionIds = new Set();
    previewText = '';
    editMode = false;

    const categoryOptionsHtml = CATEGORY_OPTIONS
      .map(c => `<option value="${c}">${esc(catLabel(c))}</option>`).join('');

    host.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <!-- 좌측: 메시지 + 자동 분석 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
          <h3 style="color:#fff;font-size:14px;margin:0 0 8px;">📩 고객 메시지</h3>
          <textarea id="cs-input" rows="7" placeholder="eBay / Alibaba 등에서 받은 고객 메시지를 붙여넣으세요..." style="width:100%;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-family:inherit;font-size:13px;resize:vertical;margin-bottom:8px;"></textarea>

          <button type="button" id="cs-analyze-btn" onclick="pmcCs.analyze()" style="padding:9px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;width:100%;margin-bottom:10px;">🔍 메시지 분석</button>
          <div id="cs-analyze-status" style="color:#666;font-size:11px;margin-bottom:10px;"></div>

          <!-- 자동 분석 결과 영역 (분석 후 노출) -->
          <div id="cs-analysis" style="display:none;">
            <div style="margin-bottom:10px;">
              <label style="font-size:11px;color:#aaa;">감지된 카테고리</label>
              <select id="cs-category-select" onchange="pmcCs.onCategoryChange()" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-top:3px;">
                <option value="">— 선택 —</option>
                ${categoryOptionsHtml}
              </select>
              <div id="cs-candidates-hint" style="color:#888;font-size:10px;margin-top:3px;"></div>
            </div>

            <div style="margin-bottom:10px;">
              <label style="font-size:11px;color:#aaa;">추출 변수 (수정 가능)</label>
              <div id="cs-vars" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px;"></div>
            </div>

            <div style="margin-bottom:10px;">
              <label style="font-size:11px;color:#aaa;">답변 언어</label>
              <select id="cs-lang" style="width:100%;padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-top:3px;">
                <option value="">자동</option>
                <option value="en">English</option>
                <option value="ko">한국어</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
              </select>
            </div>

            <!-- PR CS-G2-F: 진상 매칭 + 위험 신호 (analyze 결과로 채워짐) -->
            <div id="cs-suspicious-match" style="margin-bottom:10px;"></div>
            <div id="cs-fraud-signals" style="margin-bottom:10px;"></div>

            <button type="button" id="cs-quick-register-btn" onclick="pmcCs.openQuickRegisterModal()"
              style="display:none;width:100%;padding:7px;background:#b71c1c;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">
              🚩 이 바이어 진상 등록
            </button>
          </div>
        </div>

        <!-- 우측: 답변 작성 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;">
          <h3 style="color:#fff;font-size:14px;margin:0 0 8px;">✍️ 답변 작성</h3>
          <div id="cs-build" style="color:#666;font-size:12px;padding:30px 10px;text-align:center;">왼쪽에서 메시지 분석을 먼저 진행하세요.</div>
        </div>
      </div>
    `;
  }

  async function analyze() {
    const msg = document.getElementById('cs-input').value.trim();
    if (!msg) { alert('고객 메시지를 입력하세요'); return; }
    const btn = document.getElementById('cs-analyze-btn');
    const status = document.getElementById('cs-analyze-status');
    btn.disabled = true; btn.textContent = '🔍 분석 중...';
    status.style.color = '#666';
    status.textContent = '분류 + 변수 추출 + 템플릿 매칭...';

    try {
      const res = await fetch('/api/cs/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      currentAnalysis = j;
      recommendedTemplates = j.recommendedTemplates || [];
      salesOptionsByCategory = j.salesOptions || [];
      currentSuspiciousMatch = j.suspiciousMatch || null;
      currentFraudSignals = j.fraudSignals || [];
      selectedTemplateId = recommendedTemplates[0]?.id || null;
      selectedSalesOptionIds = new Set();
      editMode = false;
      previewText = '';

      renderAnalysisResult(j);
      renderBuildPanel();
      regeneratePreview(); // 첫 미리보기 자동 생성
      status.style.color = '#81c784';
      status.textContent = `✓ 카테고리=${j.detectedCategory ? esc(catLabel(j.detectedCategory)) : '미감지'} · 추천 템플릿 ${recommendedTemplates.length}개 · 영업 옵션 ${salesOptionsByCategory.length}개`;
    } catch (e) {
      status.style.color = '#ff8a80';
      status.textContent = '실패: ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = '🔍 메시지 분석';
    }
  }

  // 분석 결과 → 좌측 카테고리/변수 채움
  function renderAnalysisResult(j) {
    const wrap = document.getElementById('cs-analysis');
    if (!wrap) return;
    wrap.style.display = '';

    // 카테고리 select
    const sel = document.getElementById('cs-category-select');
    if (sel) sel.value = j.detectedCategory || '';

    // candidates hint (사장님 짚을 점 F)
    const hint = document.getElementById('cs-candidates-hint');
    const candidates = (j.candidates || []).filter(c => c !== j.detectedCategory);
    if (hint) {
      if (candidates.length > 0) {
        hint.innerHTML = `다른 후보: ${candidates.map(c => esc(catLabel(c))).join(', ')}`;
      } else {
        hint.innerHTML = '';
      }
    }

    // 추출 변수 input 4개 + 🤖 아이콘 (사장님 짚을 점 B)
    const vars = j.extractedVars || {};
    const fields = [
      { key: 'buyer_name',      placeholder: 'buyer_name',      value: vars.buyerName || '' },
      { key: 'order_id',        placeholder: 'order_id',        value: vars.orderId || '' },
      { key: 'product_name',    placeholder: 'product_name',    value: vars.productName || '' },
      { key: 'tracking_number', placeholder: 'tracking_number', value: vars.trackingNumber || '' },
    ];
    const varsHost = document.getElementById('cs-vars');
    if (varsHost) {
      varsHost.innerHTML = fields.map(f => {
        const ai = !!f.value;  // 자동 추출 성공한 필드만 🤖 표시
        return `
          <div style="position:relative;">
            <input type="text" id="cs-var-${f.key}" placeholder="${esc(f.placeholder)}" value="${esc(f.value)}"
              oninput="pmcCs.onVarChange()"
              style="width:100%;padding:6px 8px ${ai ? '6px 24px' : ''};background:#0f0f23;border:1px solid ${ai ? '#7c4dff' : '#333'};border-radius:4px;color:#fff;font-size:12px;">
            ${ai ? `<span title="AI 자동 추출 — 수정 가능" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:11px;pointer-events:none;">🤖</span>` : ''}
          </div>
        `;
      }).join('');
    }

    renderSuspiciousMatch();
    renderFraudSignals();

    // 빠른 등록 버튼 노출 조건: buyer_name 추출됐거나, 이미 진상 매칭 있음 (재신고 사건 추가 가능)
    const quickBtn = document.getElementById('cs-quick-register-btn');
    if (quickBtn) {
      const hasIdentifier = !!(vars.buyerName || vars.orderId || (currentSuspiciousMatch?.extractedEmails || []).length > 0);
      quickBtn.style.display = hasIdentifier ? '' : 'none';
    }
  }

  // ── PR CS-G2-F: 진상 매칭 카드 (좌측 상단 빨간 경고) ──
  function renderSuspiciousMatch() {
    const host = document.getElementById('cs-suspicious-match');
    if (!host) return;
    const sm = currentSuspiciousMatch;
    if (!sm || !sm.primary) { host.innerHTML = ''; return; }
    const p = sm.primary;
    const levelColor = ({ '의심': '#ff9800', '주의': '#e94560', '블랙리스트': '#b71c1c' })[p.suspicionLevel] || '#888';
    const blockedPlatforms = [
      ['ebay','eBay'], ['shopify','Shopify'], ['qoo10','Qoo10'],
      ['coupang','쿠팡'], ['smartstore','스마트스토어'], ['alibaba','Alibaba'],
    ].filter(([k]) => p[`isBlockedOn${k.charAt(0).toUpperCase()}${k.slice(1)}`]).map(([_, n]) => n);
    host.innerHTML = `
      <div style="background:#2a1a1a;border:1px solid #b71c1c;border-left:3px solid ${levelColor};border-radius:6px;padding:10px;font-size:11px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="color:#ff8a80;">⚠️ 진상 DB 매칭 — ${esc(p.suspicionLevel)}</strong>
          <button type="button" onclick="pmcCs.openSuspiciousDetail(${p.id})"
            style="padding:2px 8px;background:#3a1a1a;border:0;border-radius:3px;color:#ff8a80;cursor:pointer;font-size:10px;">상세</button>
        </div>
        <div style="color:#ddd;line-height:1.5;">
          ${p.realName ? `<strong>${esc(p.realName)}</strong>` : ''}
          ${p.email ? ` · ${esc(p.email)}` : ''}
          ${p.country ? ` · ${esc(p.country)}` : ''}
        </div>
        ${p.patternDescription ? `<div style="color:#aaa;margin-top:4px;">📝 ${esc(p.patternDescription.slice(0,200))}${p.patternDescription.length>200?'…':''}</div>` : ''}
        ${blockedPlatforms.length > 0 ? `<div style="color:#ffb74d;margin-top:4px;">🚫 차단됨: ${blockedPlatforms.join(', ')}</div>` : ''}
        ${sm.matches.length > 1 ? `<div style="color:#888;margin-top:4px;">+ 다른 매칭 ${sm.matches.length - 1}건</div>` : ''}
      </div>
    `;
  }

  // ── PR CS-G2-F: 위험 신호 chip ──
  function renderFraudSignals() {
    const host = document.getElementById('cs-fraud-signals');
    if (!host) return;
    if (!currentFraudSignals || currentFraudSignals.length === 0) { host.innerHTML = ''; return; }
    const colorOf = s => ({ critical: '#b71c1c', high: '#e94560', medium: '#ff9800' })[s] || '#888';
    host.innerHTML = `
      <div style="background:#2a1a1a;border:1px solid #b71c1c;border-radius:6px;padding:8px 10px;">
        <div style="color:#ff8a80;font-size:11px;font-weight:600;margin-bottom:4px;">🚩 위험 신호 ${currentFraudSignals.length}건</div>
        ${currentFraudSignals.map(f => `
          <div style="font-size:11px;color:#ddd;padding:2px 0;">
            <span style="display:inline-block;padding:1px 6px;background:${colorOf(f.severity)};color:#fff;border-radius:8px;font-size:9px;margin-right:4px;">${esc(f.severity)}</span>
            ${esc(f.description)}
          </div>
        `).join('')}
      </div>
    `;
  }

  function onCategoryChange() {
    // 카테고리 수동 변경 시 영업 옵션 / 템플릿 재로드
    const cat = document.getElementById('cs-category-select').value;
    if (!cat) {
      recommendedTemplates = [];
      salesOptionsByCategory = [];
      selectedTemplateId = null;
      selectedSalesOptionIds = new Set();
      renderBuildPanel();
      return;
    }
    fetch(`/api/cs/sales-options?category=${encodeURIComponent(cat)}`)
      .then(r => r.json()).then(j => { salesOptionsByCategory = j.data || []; renderBuildPanel(); regeneratePreview(); })
      .catch(() => {});
    // 템플릿은 cs_templates 의 카테고리 매칭 (간단 client-side 필터)
    recommendedTemplates = templates.filter(t => t.category === cat).slice(0, 3);
    selectedTemplateId = recommendedTemplates[0]?.id || null;
    renderBuildPanel();
    regeneratePreview();
  }

  function onVarChange() { _scheduleRegeneratePreview(); }

  function renderBuildPanel() {
    const host = document.getElementById('cs-build');
    if (!host) return;
    if (!currentAnalysis) {
      host.innerHTML = '<div style="color:#666;font-size:12px;padding:30px 10px;text-align:center;">왼쪽에서 메시지 분석을 먼저 진행하세요.</div>';
      return;
    }

    const tplHtml = recommendedTemplates.length > 0
      ? recommendedTemplates.map(t => `
        <label style="display:block;padding:8px 10px;background:#0f0f23;border-radius:6px;margin-bottom:5px;cursor:pointer;border-left:3px solid ${catColor(t.category)};">
          <input type="radio" name="cs-tpl-radio" value="${t.id}" ${t.id === selectedTemplateId ? 'checked' : ''}
            onchange="pmcCs.onTemplateChange(${t.id})" style="margin-right:6px;vertical-align:middle;">
          <strong style="color:#fff;font-size:12px;">${esc(t.title)}</strong>
          <span style="margin-left:4px;font-size:10px;">${flagOfLang(t.language)}</span>
          ${t.usageCount > 0 ? `<span style="margin-left:4px;color:#888;font-size:10px;">${t.usageCount}회</span>` : ''}
        </label>
      `).join('')
      : '<div style="padding:8px 10px;color:#888;font-size:11px;background:#0f0f23;border-radius:6px;">이 카테고리에 등록된 템플릿이 없습니다. 템플릿 관리 탭에서 추가하세요.</div>';

    const optsHtml = salesOptionsByCategory.length > 0
      ? salesOptionsByCategory.map(o => `
        <label style="display:flex;align-items:flex-start;gap:6px;padding:6px 10px;background:#0f0f23;border-radius:6px;margin-bottom:4px;cursor:pointer;font-size:11px;color:#ddd;">
          <input type="checkbox" value="${o.id}" ${selectedSalesOptionIds.has(o.id) ? 'checked' : ''}
            onchange="pmcCs.onSalesOptionToggle(${o.id}, this.checked)" style="margin-top:2px;">
          <span><strong style="color:#fff;">${esc(o.label)}</strong><br><span style="color:#888;">${esc(o.contentSnippet.slice(0, 100))}${o.contentSnippet.length > 100 ? '…' : ''}</span></span>
        </label>
      `).join('')
      : '<div style="padding:8px 10px;color:#888;font-size:11px;">이 카테고리에 등록된 영업 옵션이 없습니다.</div>';

    host.innerHTML = `
      <div style="margin-bottom:10px;">
        <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">📄 추천 템플릿</label>
        <div>${tplHtml}</div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:11px;color:#aaa;display:block;margin-bottom:4px;">💰 영업 옵션 (체크해서 본문에 추가)</label>
        <div>${optsHtml}</div>
      </div>

      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <label style="font-size:11px;color:#aaa;">📋 미리보기 ${editMode ? '(편집 모드)' : '(읽기 전용)'}</label>
          <div style="display:flex;gap:4px;">
            <button type="button" onclick="pmcCs.toggleEditMode()" style="padding:3px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#ccc;cursor:pointer;font-size:10px;">${editMode ? '👁 읽기 전용' : '✏️ 편집'}</button>
            <button type="button" id="cs-translate-btn" onclick="pmcCs.translate('en')"
              title="현재 본문을 영어로 번역 (숫자·주문번호 보존)"
              style="padding:3px 8px;background:#4db8ff;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;font-weight:600;">🌐 한→영</button>
            <button type="button" id="cs-translate-ko-btn" onclick="pmcCs.translate('ko')"
              title="현재 본문을 한국어로 번역"
              style="padding:3px 8px;background:#2a4a6a;border:0;border-radius:3px;color:#ccc;cursor:pointer;font-size:10px;">영→한</button>
            <button type="button" id="cs-ai-tone-btn" onclick="pmcCs.aiToneAdjust()"
              title="AI 가 톤만 다듬음 (사실/숫자/언어 변경 X)"
              style="padding:3px 8px;background:#7c4dff;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">🤖 AI 톤 다듬기</button>
          </div>
        </div>
        <textarea id="cs-preview" ${editMode ? '' : 'readonly'} rows="10"
          oninput="pmcCs.onPreviewEdit()"
          style="width:100%;padding:10px;background:${editMode ? '#1a1a2e' : '#0f0f23'};border:1px solid ${editMode ? '#7c4dff' : '#333'};border-radius:6px;color:#e0e0e0;font-family:inherit;font-size:12px;resize:vertical;line-height:1.5;">${esc(previewText)}</textarea>
      </div>

      <div style="display:flex;gap:6px;">
        <button type="button" onclick="pmcCs.copyResponse()" style="flex:1;padding:9px;background:#2e7d32;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">📋 복사</button>
        <button type="button" onclick="pmcCs.saveResponse()" style="flex:1;padding:9px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">💾 답변 저장</button>
      </div>
      <div id="cs-save-status" style="margin-top:6px;color:#666;font-size:11px;"></div>
    `;
  }

  function onTemplateChange(id) {
    selectedTemplateId = id;
    regeneratePreview();
  }

  function onSalesOptionToggle(id, checked) {
    if (checked) selectedSalesOptionIds.add(id);
    else selectedSalesOptionIds.delete(id);
    regeneratePreview();
  }

  function _scheduleRegeneratePreview() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(regeneratePreview, 250);
  }

  // 미리보기 재생성. editMode 일 때는 호출 X (직원 편집 보호)
  async function regeneratePreview() {
    if (editMode) return;  // 편집 중이면 덮어쓰기 X
    if (!selectedTemplateId) {
      previewText = '';
      const ta = document.getElementById('cs-preview');
      if (ta) ta.value = '';
      return;
    }
    const vars = _readVars();
    try {
      const res = await fetch('/api/cs/render-template', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedTemplateId,
          selectedSalesOptionIds: Array.from(selectedSalesOptionIds),
          vars,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '미리보기 실패');
      previewText = j.previewText || '';
      const ta = document.getElementById('cs-preview');
      if (ta) ta.value = previewText;
    } catch (e) {
      const ta = document.getElementById('cs-preview');
      if (ta) ta.value = '미리보기 실패: ' + e.message;
    }
  }

  function toggleEditMode() {
    editMode = !editMode;
    renderBuildPanel();
  }

  function onPreviewEdit() {
    // 편집 모드에서 사용자가 텍스트 변경 시 previewText 캐시 갱신
    const ta = document.getElementById('cs-preview');
    if (ta) previewText = ta.value;
  }

  function _readVars() {
    return {
      buyer_name:      document.getElementById('cs-var-buyer_name')?.value?.trim() || '',
      order_id:        document.getElementById('cs-var-order_id')?.value?.trim() || '',
      product_name:    document.getElementById('cs-var-product_name')?.value?.trim() || '',
      tracking_number: document.getElementById('cs-var-tracking_number')?.value?.trim() || '',
    };
  }

  async function copyResponse() {
    // 복사 시점의 미리보기 텍스트가 final_response_text (사장님 짚을 점 C)
    const text = document.getElementById('cs-preview')?.value || previewText || '';
    if (!text.trim()) { alert('복사할 답변이 없습니다'); return; }
    try {
      await navigator.clipboard.writeText(text);
      const status = document.getElementById('cs-save-status');
      if (status) { status.style.color = '#81c784'; status.textContent = '✓ 복사됨. 붙여넣어 사용하세요.'; }
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      const status = document.getElementById('cs-save-status');
      if (status) { status.style.color = '#81c784'; status.textContent = '✓ 복사됨.'; }
    }
  }

  async function saveResponse() {
    if (!currentAnalysis) { alert('먼저 메시지 분석을 진행하세요'); return; }
    const finalText = document.getElementById('cs-preview')?.value || previewText || '';
    if (!finalText.trim()) { alert('답변 본문이 비어있습니다'); return; }
    const vars = _readVars();
    const cat = document.getElementById('cs-category-select')?.value || null;
    const lang = document.getElementById('cs-lang')?.value || null;

    const payload = {
      customerMessage:        document.getElementById('cs-input').value,
      detectedCategory:       currentAnalysis.detectedCategory || null,
      manualCategory:         (cat && cat !== currentAnalysis.detectedCategory) ? cat : null,
      buyerUsername:          vars.buyer_name || null,
      buyerPlatform:          null,  // 그룹 2 에서 진상 매칭 시 자동 채움
      orderId:                vars.order_id || null,
      productName:            vars.product_name || null,
      trackingNumber:         vars.tracking_number || null,
      selectedTemplateId:     selectedTemplateId,
      selectedSalesOptionIds: Array.from(selectedSalesOptionIds),
      finalResponseText:      finalText,
      aiToneAdjusted:         false,  // 그룹 3 에서 활성
      suspiciousBuyerId:      null,
    };

    const status = document.getElementById('cs-save-status');
    if (status) { status.style.color = '#666'; status.textContent = '저장 중...'; }

    try {
      const res = await fetch('/api/cs/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '저장 실패');
      if (status) {
        status.style.color = '#81c784';
        const flag = j.data?.needsResultEntry ? ' · 의심 케이스 → 결과 입력 대기' : '';
        status.textContent = `✓ 저장됨 (id=${j.data.id})${flag}`;
      }
    } catch (e) {
      if (status) { status.style.color = '#ff8a80'; status.textContent = '실패: ' + e.message; }
    }
  }

  // ── PR CS-G2-F: 빠른 진상 등록 모달 ──
  // CS 화면 좌측 "🚩 이 바이어 진상 등록" 버튼에서 호출.
  function openQuickRegisterModal() {
    const existing = document.getElementById('cs-quick-modal');
    if (existing) existing.remove();
    const buyerName = document.getElementById('cs-var-buyer_name')?.value?.trim() || '';
    const orderId = document.getElementById('cs-var-order_id')?.value?.trim() || '';

    const m = document.createElement('div');
    m.id = 'cs-quick-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:480px;max-width:95vw;color:#e0e0e0;">
        <h3 style="color:#ff8a80;font-size:15px;margin:0 0 14px;">🚩 진상 바이어 빠른 등록</h3>
        <div style="font-size:11px;color:#888;margin-bottom:12px;">최소 식별자 (플랫폼 + 플랫폼ID) + 사건 유형이 필요합니다. 추가 정보는 관리 탭에서 편집 가능.</div>

        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">플랫폼 <span style="color:#ff8a80;">*</span></label>
        <select id="cs-q-platform" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
          <option value="">— 선택 —</option>
          <option value="ebay">eBay</option>
          <option value="shopify">Shopify</option>
          <option value="qoo10">Qoo10</option>
          <option value="coupang">쿠팡</option>
          <option value="smartstore">스마트스토어</option>
          <option value="alibaba">Alibaba</option>
        </select>

        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">플랫폼 ID (username) <span style="color:#ff8a80;">*</span></label>
        <input id="cs-q-platformid" type="text" maxlength="120" value="${esc(buyerName)}"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">

        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">사건 유형 <span style="color:#ff8a80;">*</span></label>
        <select id="cs-q-incident-type" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
          <option value="">— 선택 —</option>
          <option value="사기">사기</option>
          <option value="파손사기">파손사기 (사진 없음)</option>
          <option value="협박">협박 (피드백/디스퓨트)</option>
          <option value="저격feedback">저격 feedback</option>
          <option value="카드도용">카드 도용</option>
          <option value="재포장반품">재포장 반품</option>
          <option value="기타">기타</option>
        </select>

        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">주문번호 (선택)</label>
        <input id="cs-q-order" type="text" maxlength="120" value="${esc(orderId)}"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">

        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">수법 설명 (간단히)</label>
        <textarea id="cs-q-desc" rows="3" maxlength="2000"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;font-family:inherit;resize:vertical;margin-bottom:10px;"></textarea>

        <div id="cs-q-error" style="display:none;margin-bottom:10px;padding:7px 10px;background:#3a1a1a;border-radius:4px;color:#ff8a80;font-size:11px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:6px;">
          <button type="button" id="cs-q-cancel" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">취소</button>
          <button type="button" id="cs-q-submit" style="padding:7px 16px;background:#b71c1c;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🚩 등록</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    m.querySelector('#cs-q-cancel').addEventListener('click', () => m.remove());

    m.querySelector('#cs-q-submit').addEventListener('click', async () => {
      const errEl = m.querySelector('#cs-q-error');
      errEl.style.display = 'none';
      const payload = {
        platform: m.querySelector('#cs-q-platform').value,
        platformId: m.querySelector('#cs-q-platformid').value.trim(),
        incidentType: m.querySelector('#cs-q-incident-type').value,
        orderNumber: m.querySelector('#cs-q-order').value.trim(),
        description: m.querySelector('#cs-q-desc').value.trim(),
      };
      if (!payload.platform || !payload.platformId || !payload.incidentType) {
        errEl.textContent = '플랫폼 + 플랫폼ID + 사건유형은 필수입니다';
        errEl.style.display = 'block';
        return;
      }
      const btn = m.querySelector('#cs-q-submit');
      btn.disabled = true; btn.textContent = '등록 중...';
      try {
        const res = await fetch('/api/cs/suspicious-buyers/quick', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        if (!res.ok) { errEl.textContent = j.error || '등록 실패'; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = '🚩 등록'; return; }
        m.remove();
        alert(`✓ 진상 등록 완료 (id=${j.data.id})`);
        // 분석 다시 (매칭 결과 갱신)
        analyze();
      } catch (e) {
        errEl.textContent = '네트워크 오류: ' + e.message;
        errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = '🚩 등록';
      }
    });
  }

  // ── PR CS-G2-F: 진상 바이어 상세 모달 ──
  async function openSuspiciousDetail(id) {
    const existing = document.getElementById('cs-detail-modal');
    if (existing) existing.remove();
    const m = document.createElement('div');
    m.id = 'cs-detail-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:680px;max-width:95vw;max-height:92vh;overflow-y:auto;color:#e0e0e0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="color:#ff8a80;font-size:15px;margin:0;">🚩 진상 바이어 상세</h3>
          <button type="button" id="cs-d-close" style="padding:4px 10px;background:transparent;border:0;color:#888;cursor:pointer;font-size:14px;">✕</button>
        </div>
        <div id="cs-detail-body" style="font-size:12px;">로딩 중...</div>
      </div>
    `;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    m.querySelector('#cs-d-close').addEventListener('click', () => m.remove());

    try {
      const res = await fetch(`/api/cs/suspicious-buyers/${id}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '로드 실패');
      m.querySelector('#cs-detail-body').innerHTML = renderDetailBody(j.data, j.incidents || []);
      _bindDetailActions(m, j.data);
    } catch (e) {
      m.querySelector('#cs-detail-body').innerHTML = `<div style="color:#ff8a80;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderDetailBody(b, incidents) {
    const platforms = b.platformIds || {};
    const platformList = Object.entries(platforms).map(([k,v]) => v ? `${esc(k)}: ${esc(v)}` : '').filter(Boolean).join(', ');
    const blocked = [
      ['Ebay','eBay'], ['Shopify','Shopify'], ['Qoo10','Qoo10'],
      ['Coupang','쿠팡'], ['Smartstore','스마트스토어'], ['Alibaba','Alibaba'],
    ];
    const isAdmin = !!user?.isAdmin;
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;margin-bottom:12px;">
        <div><strong style="color:#aaa;">실명:</strong> ${esc(b.realName || '—')}</div>
        <div><strong style="color:#aaa;">익명 ID:</strong> ${esc(b.anonymizedId || '—')}</div>
        <div><strong style="color:#aaa;">이메일:</strong> ${esc(b.email || '—')}</div>
        <div><strong style="color:#aaa;">전화:</strong> ${esc(b.phone || '—')}</div>
        <div><strong style="color:#aaa;">국가:</strong> ${esc(b.country || '—')} ${b.region ? `(${esc(b.region)})` : ''}</div>
        <div><strong style="color:#aaa;">의심도:</strong> ${esc(b.suspicionLevel)}</div>
        <div style="grid-column:1/-1;"><strong style="color:#aaa;">플랫폼 ID:</strong> ${platformList ? esc(platformList) : '—'}</div>
        <div style="grid-column:1/-1;"><strong style="color:#aaa;">주소:</strong> ${esc(b.address || '—')}</div>
      </div>
      <div style="margin-bottom:10px;">
        <strong style="color:#aaa;">수법 설명:</strong>
        <div style="margin-top:4px;padding:6px 10px;background:#0f0f23;border-radius:4px;color:#ddd;white-space:pre-wrap;">${esc(b.patternDescription || '—')}</div>
      </div>
      ${b.notes ? `<div style="margin-bottom:10px;"><strong style="color:#aaa;">메모:</strong><div style="margin-top:4px;padding:6px 10px;background:#0f0f23;border-radius:4px;color:#ddd;white-space:pre-wrap;">${esc(b.notes)}</div></div>` : ''}

      <div style="margin-bottom:12px;">
        <strong style="color:#aaa;">차단 플랫폼:</strong>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
          ${blocked.map(([key, label]) => {
            const checked = !!b[`isBlockedOn${key}`];
            return `
              <label style="display:flex;align-items:center;gap:4px;padding:4px 8px;background:${checked ? '#3a1a1a' : '#0f0f23'};border:1px solid ${checked ? '#b71c1c' : '#333'};border-radius:4px;font-size:11px;color:#ddd;${isAdmin ? 'cursor:pointer;' : 'opacity:0.6;'}">
                <input type="checkbox" data-blockfield="isBlockedOn${key}" ${checked ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}>
                ${esc(label)}
              </label>
            `;
          }).join('')}
        </div>
        ${!isAdmin ? '<div style="font-size:10px;color:#888;margin-top:4px;">차단 플래그 토글은 관리자만 가능</div>' : ''}
      </div>

      <div style="margin-bottom:12px;padding-top:10px;border-top:1px solid #2a2a4a;">
        <strong style="color:#aaa;">📋 사건 기록 (${incidents.length}건)</strong>
        <div style="margin-top:6px;">
          ${incidents.length === 0
            ? '<div style="color:#666;font-size:11px;">등록된 사건 없음</div>'
            : incidents.map(i => `
              <div style="background:#0f0f23;border-radius:4px;padding:6px 10px;margin-bottom:4px;font-size:11px;">
                <div><strong style="color:#fff;">${esc(i.incidentType || '미분류')}</strong>
                  ${i.platform ? `<span style="color:#888;"> · ${esc(i.platform)}</span>` : ''}
                  ${i.amount != null ? `<span style="color:#ffb74d;"> · ${i.amount.toLocaleString()}원</span>` : ''}
                  <span style="color:#888;float:right;">${esc(i.date || (i.createdAt || '').slice(0,10))}</span>
                </div>
                ${i.description ? `<div style="color:#aaa;margin-top:3px;white-space:pre-wrap;">${esc(i.description)}</div>` : ''}
                ${i.resolution ? `<div style="color:#81c784;margin-top:2px;">→ ${esc(i.resolution)}</div>` : ''}
              </div>
            `).join('')
          }
        </div>
        <button type="button" id="cs-d-add-incident" style="margin-top:6px;padding:6px 12px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">+ 사건 추가</button>
      </div>

      ${isAdmin ? `
        <div style="padding-top:10px;border-top:1px solid #2a2a4a;display:flex;justify-content:flex-end;gap:6px;">
          <button type="button" id="cs-d-delete" style="padding:6px 12px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">🗑 삭제 (soft)</button>
        </div>
      ` : ''}
    `;
  }

  function _bindDetailActions(m, buyer) {
    // 차단 플래그 토글 (admin)
    if (user?.isAdmin) {
      m.querySelectorAll('input[data-blockfield]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const field = cb.dataset.blockfield;
          try {
            const res = await fetch(`/api/cs/suspicious-buyers/${buyer.id}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [field]: cb.checked }),
            });
            if (!res.ok) { cb.checked = !cb.checked; alert((await res.json()).error || '실패'); }
          } catch (e) { cb.checked = !cb.checked; alert('실패: ' + e.message); }
        });
      });
      const delBtn = m.querySelector('#cs-d-delete');
      if (delBtn) delBtn.addEventListener('click', async () => {
        if (!confirm('정말 삭제하시겠습니까?\n(soft delete — 이력 보존)')) return;
        try {
          const res = await fetch(`/api/cs/suspicious-buyers/${buyer.id}`, { method: 'DELETE' });
          if (!res.ok) { alert((await res.json()).error || '실패'); return; }
          m.remove();
          renderSuspiciousList();
        } catch (e) { alert('실패: ' + e.message); }
      });
    }
    const addBtn = m.querySelector('#cs-d-add-incident');
    if (addBtn) addBtn.addEventListener('click', () => openAddIncidentPrompt(buyer.id));
  }

  async function openAddIncidentPrompt(buyerId) {
    const incidentType = prompt('사건 유형 (예: 사기/파손사기/협박/카드도용/재포장반품/기타)');
    if (!incidentType) return;
    const description = prompt('수법 설명 (간단히)') || '';
    const amount = prompt('피해액 (원, 숫자만 — 비워두면 미기록)') || '';
    const orderNumber = prompt('주문번호 (선택)') || '';
    try {
      const res = await fetch(`/api/cs/suspicious-buyers/${buyerId}/incidents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentType, description, amount: amount || null, orderNumber: orderNumber || null }),
      });
      if (!res.ok) { alert((await res.json()).error || '실패'); return; }
      // 모달 새로고침
      openSuspiciousDetail(buyerId);
    } catch (e) { alert('실패: ' + e.message); }
  }

  // ── PR CS-G2-F: 진상 바이어 관리 탭 ──
  async function renderSuspiciousList() {
    const host = document.getElementById('cs-suspicious');
    if (!host) return;
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" id="cs-susp-search" placeholder="이름/이메일/플랫폼ID/국가 검색..." oninput="pmcCs.searchSuspicious()"
            style="flex:1;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
          <select id="cs-susp-level" onchange="pmcCs.searchSuspicious()" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;">
            <option value="">전체 의심도</option>
            <option value="의심">의심</option>
            <option value="주의">주의</option>
            <option value="블랙리스트">블랙리스트</option>
          </select>
        </div>
      </div>
      <div id="cs-susp-list">로딩 중...</div>
    `;
    await _loadSuspiciousList();
  }

  let _suspSearchTimer = null;
  function searchSuspicious() {
    if (_suspSearchTimer) clearTimeout(_suspSearchTimer);
    _suspSearchTimer = setTimeout(_loadSuspiciousList, 300);
  }

  async function _loadSuspiciousList() {
    const list = document.getElementById('cs-susp-list');
    if (!list) return;
    const q = document.getElementById('cs-susp-search')?.value?.trim() || '';
    const level = document.getElementById('cs-susp-level')?.value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (level) params.set('suspicionLevel', level);
    try {
      const res = await fetch('/api/cs/suspicious-buyers?' + params);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      suspiciousList = j.data || [];
      _renderSuspiciousRows();
    } catch (e) {
      list.innerHTML = `<div style="padding:20px;color:#ff8a80;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function _renderSuspiciousRows() {
    const list = document.getElementById('cs-susp-list');
    if (!list) return;
    if (suspiciousList.length === 0) {
      list.innerHTML = '<div style="padding:30px;color:#666;text-align:center;font-size:12px;">진상 바이어가 없습니다.</div>';
      return;
    }
    const levelColor = l => ({ '의심': '#ff9800', '주의': '#e94560', '블랙리스트': '#b71c1c' })[l] || '#888';
    list.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:hidden;">
        ${suspiciousList.map(b => {
          const platforms = Object.entries(b.platformIds || {}).filter(([_,v]) => v).map(([k]) => k).join(',');
          const blocked = [
            ['isBlockedOnEbay','eBay'], ['isBlockedOnShopify','Shopify'], ['isBlockedOnQoo10','Qoo10'],
            ['isBlockedOnCoupang','쿠팡'], ['isBlockedOnSmartstore','스스'], ['isBlockedOnAlibaba','Alibaba'],
          ].filter(([k]) => b[k]).map(([_,n]) => n).join(',');
          return `
            <div onclick="pmcCs.openSuspiciousDetail(${b.id})"
              style="padding:10px 14px;border-bottom:1px solid #2a2a4a;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;"
              onmouseover="this.style.background='#0f0f23'" onmouseout="this.style.background=''">
              <div style="flex:1;min-width:0;">
                <div>
                  <strong style="color:#fff;">${esc(b.realName || b.anonymizedId || '(이름 없음)')}</strong>
                  <span style="margin-left:6px;padding:1px 6px;background:${levelColor(b.suspicionLevel)};color:#fff;border-radius:8px;font-size:10px;">${esc(b.suspicionLevel)}</span>
                  ${b.country ? `<span style="margin-left:4px;color:#888;font-size:11px;">${esc(b.country)}</span>` : ''}
                </div>
                <div style="color:#888;font-size:11px;margin-top:3px;">
                  ${b.email ? `📧 ${esc(b.email)} ` : ''}
                  ${platforms ? ` · 플랫폼: ${esc(platforms)}` : ''}
                  ${blocked ? ` · 🚫 ${esc(blocked)}` : ''}
                </div>
              </div>
              <span style="color:#888;font-size:11px;">상세 →</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // ── 한국어 ↔ 영어 번역 (저장 안 된 미리보기 기준) ──
  // 직원이 한글로 초안 쓰고 한 번에 영어 CS 답변으로 변환. ChatGPT 외부 사용 대체.
  async function translate(targetLang) {
    const ta = document.getElementById('cs-preview');
    if (!ta) return;
    const text = ta.value || previewText || '';
    if (!text.trim()) { alert('번역할 본문이 비어있습니다'); return; }
    const target = targetLang === 'ko' ? 'ko' : 'en';
    const btn = document.getElementById(target === 'en' ? 'cs-translate-btn' : 'cs-translate-ko-btn');
    const origLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '번역 중...'; }
    try {
      const res = await fetch('/api/cs/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang: target }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      ta.value = j.text || text;
      previewText = ta.value;
      const status = document.getElementById('cs-save-status');
      if (status) {
        status.style.color = j.mock ? '#888' : '#81c784';
        status.textContent = j.mock
          ? `🌐 mock 모드 — 번역 시뮬레이션 (CS_TRANSLATE_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정)`
          : `✓ ${target === 'en' ? '영어' : '한국어'} 번역 완료 (${j.provider} · $${(j.costUsd || 0).toFixed(4)})`;
      }
    } catch (e) {
      const status = document.getElementById('cs-save-status');
      if (status) { status.style.color = '#ff8a80'; status.textContent = '번역 실패: ' + e.message; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    }
  }

  // ── PR CS-G3-F: AI 톤 다듬기 (저장 안 된 미리보기 기준) ──
  async function aiToneAdjust() {
    const ta = document.getElementById('cs-preview');
    if (!ta) return;
    const text = ta.value || previewText || '';
    if (!text.trim()) { alert('다듬을 본문이 비어있습니다'); return; }
    const lang = document.getElementById('cs-lang')?.value || null;
    const btn = document.getElementById('cs-ai-tone-btn');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 다듬는 중...'; }
    try {
      const res = await fetch('/api/cs/ai-tone-adjust-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: lang }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      ta.value = j.text || text;
      previewText = ta.value;
      const status = document.getElementById('cs-save-status');
      if (status) {
        status.style.color = j.mock ? '#888' : '#81c784';
        status.textContent = j.mock
          ? '🤖 mock 모드 — 원본 그대로 (CS_TONE_MOCK_MODE=true 또는 ANTHROPIC_API_KEY 미설정)'
          : `✓ AI 톤 다듬기 완료 (${j.provider} · $${(j.costUsd || 0).toFixed(4)})`;
      }
    } catch (e) {
      const status = document.getElementById('cs-save-status');
      if (status) { status.style.color = '#ff8a80'; status.textContent = '실패: ' + e.message; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 AI 톤 다듬기'; }
    }
  }

  // ── PR CS-G3-F: 결과 입력 대시보드 (admin only) ──
  let pendingResults = [];
  async function renderResultsDashboard() {
    const host = document.getElementById('cs-results');
    if (!host || !user.isAdmin) {
      if (host) host.innerHTML = '<div style="padding:30px;color:#888;text-align:center;">관리자 전용</div>';
      return;
    }
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 4px;">📝 결과 입력 대기 케이스</h3>
        <p style="color:#888;font-size:12px;margin:0;">
          의심 케이스 (사기 의심 / 클레임 / 진상 매칭) 중 결과가 미입력된 응답입니다.
          7가지 결과 중 하나를 선택하세요.
        </p>
      </div>
      <div id="cs-results-list">로딩 중...</div>
    `;
    try {
      const res = await fetch('/api/cs/responses?needsResultOnly=true&limit=100');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '실패');
      pendingResults = j.data || [];
      _renderPendingResults();
    } catch (e) {
      document.getElementById('cs-results-list').innerHTML = `<div style="padding:20px;color:#ff8a80;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  const RESULT_STATUSES = [
    { key: 'converted',       label: '구매 전환',     color: '#2e7d32' },
    { key: 'repurchased',     label: '재구매',        color: '#388e3c' },
    { key: 'positive_review', label: '좋은 리뷰',     color: '#43a047' },
    { key: 'refunded',        label: '환불됨',        color: '#ff9800' },
    { key: 'case_opened',     label: '케이스 오픈',   color: '#e94560' },
    { key: 'confirmed_fraud', label: '🚩 사기 확인',  color: '#b71c1c' },
    { key: 'blocked',         label: '🚫 차단 필요',  color: '#5d1010' },
  ];

  function _renderPendingResults() {
    const host = document.getElementById('cs-results-list');
    if (!host) return;
    if (pendingResults.length === 0) {
      host.innerHTML = '<div style="padding:30px;color:#666;text-align:center;font-size:12px;">결과 입력 대기 케이스가 없습니다.</div>';
      return;
    }
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;overflow:hidden;">
        ${pendingResults.map(r => {
          const cat = r.manualCategory || r.detectedCategory || 'unknown';
          const msgPreview = (r.customerMessage || '').slice(0, 200);
          return `
            <div style="padding:12px 14px;border-bottom:1px solid #2a2a4a;">
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
                <div style="flex:1;min-width:0;">
                  <span style="padding:2px 8px;background:${catColor(cat)};color:#fff;border-radius:8px;font-size:10px;">${esc(catLabel(cat))}</span>
                  ${r.suspiciousBuyerId ? `<span style="margin-left:4px;padding:2px 8px;background:#b71c1c;color:#fff;border-radius:8px;font-size:10px;">🚩 진상 매칭</span>` : ''}
                  ${r.buyerUsername ? `<span style="margin-left:6px;color:#aaa;font-size:11px;">👤 ${esc(r.buyerUsername)}</span>` : ''}
                  ${r.orderId ? `<span style="margin-left:6px;color:#888;font-size:11px;">📦 ${esc(r.orderId)}</span>` : ''}
                </div>
                <span style="color:#888;font-size:11px;">${esc((r.createdAt || '').slice(0,16).replace('T',' '))}</span>
              </div>
              <div style="color:#ddd;font-size:12px;background:#0f0f23;padding:6px 10px;border-radius:4px;margin-bottom:8px;white-space:pre-wrap;">${esc(msgPreview)}${(r.customerMessage || '').length > 200 ? '…' : ''}</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px;">
                ${RESULT_STATUSES.map(s => `
                  <button type="button" onclick="pmcCs.setResultStatus(${r.id}, '${s.key}')"
                    style="padding:5px 10px;background:${s.color};border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">${esc(s.label)}</button>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function setResultStatus(id, resultStatus) {
    if (!confirm(`결과를 "${esc(resultStatus)}" 로 입력하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/cs/responses/${id}/result-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultStatus }),
      });
      const j = await res.json();
      if (!res.ok) { alert(j.error || '실패'); return; }
      // confirmed_fraud / blocked → 진상 등록 유도
      if ((resultStatus === 'confirmed_fraud' || resultStatus === 'blocked') && !j.data?.suspiciousBuyerId) {
        if (confirm('🚩 진상 바이어로 등록하시겠습니까?\n(빠른 등록 모달이 열립니다)')) {
          openQuickRegisterModalForResponse(j.data);
        }
      }
      // 리스트 새로고침
      renderResultsDashboard();
    } catch (e) { alert('실패: ' + e.message); }
  }

  // 결과 입력 후 진상 등록 유도 시 호출 — 응답의 buyerUsername 으로 prefill
  function openQuickRegisterModalForResponse(response) {
    // 임시로 cs-var-* 를 채워 openQuickRegisterModal 이 prefill 되도록
    // 결과 대시보드에선 var input 이 없으므로 직접 모달 열기
    const existing = document.getElementById('cs-quick-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.id = 'cs-quick-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:24px;width:480px;max-width:95vw;color:#e0e0e0;">
        <h3 style="color:#ff8a80;font-size:15px;margin:0 0 14px;">🚩 진상 바이어 등록 (결과: ${esc(response.resultStatus || '')})</h3>
        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">플랫폼 <span style="color:#ff8a80;">*</span></label>
        <select id="cs-q-platform" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
          <option value="">— 선택 —</option>
          <option value="ebay">eBay</option><option value="shopify">Shopify</option>
          <option value="qoo10">Qoo10</option><option value="coupang">쿠팡</option>
          <option value="smartstore">스마트스토어</option><option value="alibaba">Alibaba</option>
        </select>
        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">플랫폼 ID <span style="color:#ff8a80;">*</span></label>
        <input id="cs-q-platformid" type="text" maxlength="120" value="${esc(response.buyerUsername || '')}"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">사건 유형 <span style="color:#ff8a80;">*</span></label>
        <select id="cs-q-incident-type" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
          <option value="">— 선택 —</option>
          <option value="사기">사기</option><option value="파손사기">파손사기</option>
          <option value="협박">협박</option><option value="저격feedback">저격 feedback</option>
          <option value="카드도용">카드 도용</option><option value="재포장반품">재포장 반품</option>
          <option value="기타">기타</option>
        </select>
        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">주문번호 (선택)</label>
        <input id="cs-q-order" type="text" maxlength="120" value="${esc(response.orderId || '')}"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;margin-bottom:8px;">
        <label style="display:block;font-size:11px;color:#aaa;margin-bottom:4px;">수법 설명</label>
        <textarea id="cs-q-desc" rows="3" maxlength="2000"
          style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;font-family:inherit;resize:vertical;margin-bottom:10px;">${esc((response.customerMessage || '').slice(0, 500))}</textarea>
        <div id="cs-q-error" style="display:none;margin-bottom:10px;padding:7px 10px;background:#3a1a1a;border-radius:4px;color:#ff8a80;font-size:11px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:6px;">
          <button type="button" id="cs-q-cancel" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">취소</button>
          <button type="button" id="cs-q-submit" style="padding:7px 16px;background:#b71c1c;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🚩 등록</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    m.querySelector('#cs-q-cancel').addEventListener('click', () => m.remove());
    m.querySelector('#cs-q-submit').addEventListener('click', async () => {
      const errEl = m.querySelector('#cs-q-error');
      errEl.style.display = 'none';
      const payload = {
        platform: m.querySelector('#cs-q-platform').value,
        platformId: m.querySelector('#cs-q-platformid').value.trim(),
        incidentType: m.querySelector('#cs-q-incident-type').value,
        orderNumber: m.querySelector('#cs-q-order').value.trim(),
        description: m.querySelector('#cs-q-desc').value.trim(),
      };
      if (!payload.platform || !payload.platformId || !payload.incidentType) {
        errEl.textContent = '플랫폼 + 플랫폼ID + 사건유형 필수'; errEl.style.display = 'block'; return;
      }
      try {
        const res = await fetch('/api/cs/suspicious-buyers/quick', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        if (!res.ok) { errEl.textContent = j.error || '실패'; errEl.style.display = 'block'; return; }
        m.remove();
        alert(`✓ 진상 등록 완료 (id=${j.data.id})`);
      } catch (e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
    });
  }

  // ── 템플릿 관리 (admin) — 보존 ──
  function renderManage() {
    const host = document.getElementById('cs-manage');
    if (!host || !user.isAdmin) return;
    const catOptions = CATEGORY_OPTIONS.map(c => `<option value="${c}">${esc(catLabel(c))}</option>`).join('');
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:14px;margin-bottom:12px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">➕ 새 템플릿</h3>
        <form id="cs-form">
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:6px;margin-bottom:6px;">
            <input type="text" id="cs-f-title" placeholder="제목 (관리용)" required maxlength="200" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <select id="cs-f-lang" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              <option value="en">English</option>
              <option value="ko">한국어</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
            </select>
            <select id="cs-f-cat" style="padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
              ${catOptions}
            </select>
          </div>
          <textarea id="cs-f-body" required rows="5" placeholder="본문. {buyer_name}, {order_id} 같은 플레이스홀더는 변수 치환됩니다." style="width:100%;padding:8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-family:inherit;font-size:12px;resize:vertical;margin-bottom:6px;"></textarea>
          <button type="submit" style="padding:7px 14px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">추가</button>
        </form>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;">
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📋 템플릿 목록</h3>
          <span style="color:#888;font-size:11px;">${templates.length}개</span>
        </div>
        <div id="cs-tpl-manage-list"></div>
      </div>
    `;
    renderManageList();
    document.getElementById('cs-form').addEventListener('submit', onCreate);
  }

  function renderManageList() {
    const host = document.getElementById('cs-tpl-manage-list');
    if (!host) return;
    if (templates.length === 0) { host.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">템플릿이 없습니다.</div>'; return; }
    host.innerHTML = templates.map(t => `
      <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:6px;">
          <div>
            <strong style="color:#fff;font-size:13px;">${esc(t.title)}</strong>
            <span style="margin-left:6px;font-size:11px;">${flagOfLang(t.language)}</span>
            <span style="margin-left:4px;padding:1px 6px;background:${catColor(t.category)};color:#fff;border-radius:8px;font-size:10px;">${esc(catLabel(t.category))}</span>
            <span style="margin-left:6px;color:#888;font-size:10px;">· ${t.usageCount}회 사용</span>
          </div>
          <div style="display:flex;gap:4px;">
            <button type="button" onclick="pmcCs.editTemplate(${t.id})" style="padding:3px 8px;background:#2a4a6a;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">✏️</button>
            <button type="button" onclick="pmcCs.deleteTemplate(${t.id})" style="padding:3px 8px;background:#e94560;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">🗑</button>
          </div>
        </div>
        <div style="color:#aaa;font-size:11px;white-space:pre-wrap;max-height:60px;overflow:hidden;">${esc((t.body || '').slice(0, 300))}${(t.body || '').length > 300 ? '…' : ''}</div>
      </div>
    `).join('');
  }

  async function onCreate(e) {
    e.preventDefault();
    const payload = {
      title: document.getElementById('cs-f-title').value.trim(),
      language: document.getElementById('cs-f-lang').value,
      category: document.getElementById('cs-f-cat').value,
      body: document.getElementById('cs-f-body').value.trim(),
    };
    const res = await fetch('/api/cs/templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    document.getElementById('cs-form').reset();
    await loadTemplates();
    renderManageList();
  }

  async function editTemplate(id) {
    const t = templates.find(x => x.id === id);
    if (!t) return;
    const newTitle = prompt('제목', t.title);
    if (newTitle === null) return;
    const newBody = prompt('본문', t.body);
    if (newBody === null) return;
    const res = await fetch('/api/cs/templates/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim() }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    await loadTemplates();
    renderManageList();
  }

  async function deleteTemplate(id) {
    if (!confirm('이 템플릿을 삭제하시겠습니까?\n(목록에서 숨김 처리됩니다 — 이력 보존)')) return;
    const res = await fetch('/api/cs/templates/' + id, { method: 'DELETE' });
    if (!res.ok) { alert('실패'); return; }
    await loadTemplates();
    renderManageList();
  }

  window.pmcCs = {
    load, switchView,
    // 신규 워크플로우 (PR CS-G1-F)
    analyze, onCategoryChange, onVarChange,
    onTemplateChange, onSalesOptionToggle,
    toggleEditMode, onPreviewEdit,
    copyResponse, saveResponse,
    // 진상 바이어 (PR CS-G2-F)
    openQuickRegisterModal, openSuspiciousDetail,
    searchSuspicious,
    // 결과 + AI (PR CS-G3-F)
    aiToneAdjust, setResultStatus,
    // 한↔영 번역 (한글 초안 → 영어 CS 답변)
    translate,
    // 관리 (보존)
    editTemplate, deleteTemplate,
  };
})();
