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
        <h1 style="font-size:22px;color:#fff;">💬 CS 지원 <span style="color:#888;font-weight:400;font-size:13px;">· 템플릿 + 영업 옵션 + AI 톤 다듬기</span></h1>
        <p style="color:#888;font-size:13px;">고객 메시지를 분석하면 카테고리/변수가 자동 추출되고, 답변은 템플릿 + 영업 옵션 체크로 조립합니다. AI 는 마지막 톤 다듬기만 담당합니다.</p>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #2a2a4a;">
        <button type="button" id="cs-tab-compose" onclick="pmcCs.switchView('compose')" style="padding:10px 18px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">✍️ 답변 작성</button>
        ${manageTab}
      </div>

      <div id="cs-compose"></div>
      <div id="cs-manage" style="display:none;"></div>
    `;
  }

  function switchView(v) {
    viewMode = v;
    document.getElementById('cs-tab-compose').style.color = v === 'compose' ? '#fff' : '#888';
    document.getElementById('cs-tab-compose').style.fontWeight = v === 'compose' ? '600' : '400';
    document.getElementById('cs-tab-compose').style.borderBottom = v === 'compose' ? '2px solid #7c4dff' : '2px solid transparent';
    if (user.isAdmin) {
      const mt = document.getElementById('cs-tab-manage');
      if (mt) {
        mt.style.color = v === 'manage' ? '#fff' : '#888';
        mt.style.fontWeight = v === 'manage' ? '600' : '400';
        mt.style.borderBottom = v === 'manage' ? '2px solid #7c4dff' : '2px solid transparent';
      }
    }
    document.getElementById('cs-compose').style.display = v === 'compose' ? '' : 'none';
    document.getElementById('cs-manage').style.display = v === 'manage' ? '' : 'none';
    if (v === 'manage') renderManage();
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

            <!-- 그룹 2: 진상 매칭 / 위험 신호 영역 신설 예정 (그룹 1 미노출 — 사장님 짚을 점 H) -->
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
            <button type="button" disabled title="그룹 3 (PR CS-G3) 에서 활성됨"
              style="padding:3px 8px;background:#444;border:0;border-radius:3px;color:#888;cursor:not-allowed;font-size:10px;">🤖 AI 톤 다듬기</button>
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
    // 관리 (보존)
    editTemplate, deleteTemplate,
  };
})();
