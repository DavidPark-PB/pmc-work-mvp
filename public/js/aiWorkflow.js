/**
 * 🪄 AI 상품 제작 (통합 워크플로우)
 *
 * 기존 3개 메뉴를 순서형으로 묶음:
 *   1) 리메이커  → eBay Item ID → 경쟁사 정보 fetch + AI 리메이크
 *   2) 재구성    → 1단계 이미지/HTML 자동 인계 → PMC 브랜드 상세페이지 생성
 *   3) 썸네일    → 1단계 이미지 자동 선택 → 플랫폼별 썸네일 생성·다운로드
 *
 * 백엔드는 기존 라우트 그대로 재사용:
 *   POST /api/remarker/fetch
 *   POST /api/remarker/remake
 *   POST /api/remarker/reconstruct   (multipart)
 *   POST /api/thumbnail/generate     (multipart)
 *
 * 기존 단일 메뉴(리메이커/재구성/썸네일)는 그대로 유지 — 마이그레이션 안전망.
 */
(function() {
  const state = {
    step: 1,
    competitor: null,
    remake: null,
    reconstruct: null,
    thumbnails: [],
    // 2026-08-08: 사장님 요청 — 원하는 이미지만 선택해서 후속 단계 사용.
    selectedImageUrls: new Set(),
    // 2026-08-09: 4단계 배포 상태
    publish: null,   // { platforms:[], presets:{}, results:[], running:false }
  };

  // 프리셋 (localStorage 로 사장님 커스터마이즈 저장. GET /presets 로 default 조회 가능)
  // 2026-08-09 v5: VerifyAdd 로 실 통과 조합 확정 —
  //   183456 (CCG Sealed Booster Boxes) + conditionId=1000 (New) + Set aspect.
  //   기존 183454 (Single Cards) 는 eBay 정책 위반 (Booster Box 를 Single 카테고리에 못 올림).
  const PRESET_STORAGE_KEY = 'pmcAIWorkflow.presets.v5';
  function loadPresets() {
    try {
      // 옛 버전 자동 제거 (모든 v1~v4 폐기 — 이전 값이 신규 등록 시 튕겨서)
      ['v1', 'v2', 'v3', 'v4'].forEach(v => localStorage.removeItem('pmcAIWorkflow.presets.' + v));
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      ebay: {
        // 2026-08-09 VerifyAdd 통과 확정 조합.
        // 다른 카테고리 참고: 183455 = Sealed Booster Packs / 183454 = Single Cards (구 리스팅)
        categoryId: '183456', conditionId: '1000', currency: 'USD', quantity: 1,
        // 2026-08-30: Pokemon TCG 하드코딩 (Game/Type/Manufacturer/Language/Age Level/
        //   Country of Origin/Set) 완전 제거. 경쟁사 fetch (state.competitor.itemSpecifics)
        //   결과를 그대로 publish 에 전달 · preset 은 사용자가 UI 에서 명시적으로 채운
        //   값만 반영됨. 이미 localStorage 에 저장된 사용자 preset 은 그대로 유지됨.
        itemSpecifics: {},
      },
      shopify: {
        vendor: 'PMC', productType: 'Trading Card', status: 'active',
        inventoryPolicy: 'deny', quantity: 1, tags: 'Pokemon,TCG,Trading Card,Korea',
      },
    };
  }
  function savePresets(p) {
    try { localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(p)); } catch {}
  }

  // 선택된 이미지만 반환 (없으면 빈 배열 — 후속 함수가 알아서 처리)
  function selectedImages() {
    const all = state.competitor?.images || [];
    if (state.selectedImageUrls.size === 0) return [];
    return all.filter(u => state.selectedImageUrls.has(u));
  }

  function toggleImage(url) {
    if (state.selectedImageUrls.has(url)) state.selectedImageUrls.delete(url);
    else state.selectedImageUrls.add(url);
    renderStep1();
  }
  function selectAllImages() {
    state.selectedImageUrls = new Set(state.competitor?.images || []);
    renderStep1();
  }
  function clearImageSelection() {
    state.selectedImageUrls = new Set();
    renderStep1();
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ───────────────────────────────────────────────
  // 진입점
  // ───────────────────────────────────────────────
  function load() {
    renderShell();
  }

  function renderShell() {
    const el = document.getElementById('page-ai-workflow');
    if (!el) return;
    el.innerHTML = `
      <div style="margin-bottom:16px;">
        <h1 style="font-size:24px;color:#fff;">🪄 AI 상품 제작</h1>
        <p style="color:#888;font-size:13px;">경쟁사 정보 → 상세페이지 → 썸네일까지 한 번에. 각 단계 결과는 다음 단계로 자동 인계됩니다.</p>
      </div>
      <div id="wf-stepper"></div>
      <div id="wf-body" style="margin-top:16px;"></div>
    `;
    renderStepper();
    renderBody();
  }

  function renderStepper() {
    const host = document.getElementById('wf-stepper');
    if (!host) return;
    const steps = [
      { n: 1, label: '리메이커', icon: '🔮' },
      { n: 2, label: '상세페이지', icon: '📄' },
      { n: 3, label: '썸네일', icon: '🖼️' },
      { n: 4, label: '배포', icon: '🚀' },
    ];
    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        ${steps.map((s, i) => {
          const isActive = s.n === state.step;
          const isDone = s.n < state.step;
          const dotBg = isDone ? '#4caf50' : isActive ? '#ffd54f' : '#333';
          const dotColor = isDone || isActive ? '#0f0f23' : '#888';
          const labelColor = isDone || isActive ? '#fff' : '#666';
          return `
            <div style="display:flex;align-items:center;gap:6px;">
              <button type="button" onclick="pmcAIWorkflow.gotoStep(${s.n})"
                title="${s.n}단계로 이동"
                style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:transparent;border:0;cursor:pointer;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:14px;background:${dotBg};color:${dotColor};font-weight:700;font-size:13px;">${isDone ? '✓' : s.n}</span>
                <span style="color:${labelColor};font-weight:600;font-size:13px;">${s.icon} ${s.label}</span>
              </button>
              ${i < steps.length - 1 ? '<div style="width:24px;height:2px;background:#333;"></div>' : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderBody() {
    if (state.step === 1) renderStep1();
    else if (state.step === 2) renderStep2();
    else if (state.step === 3) renderStep3();
    else if (state.step === 4) renderStep4();
  }

  function gotoStep(n) {
    // 앞 단계 결과가 없으면 이동 불가 (사용자 혼동 방지)
    if (n === 2 && !state.remake) { alert('1단계 리메이크를 먼저 완료하세요.'); return; }
    if (n === 3 && !state.competitor) { alert('1단계를 먼저 진행하세요.'); return; }
    state.step = n;
    renderStepper();
    renderBody();
  }

  // ───────────────────────────────────────────────
  // STEP 1 — 리메이커 (eBay Item ID → fetch → AI 리메이크)
  // ───────────────────────────────────────────────
  function renderStep1() {
    const host = document.getElementById('wf-body');
    const c = state.competitor;
    const r = state.remake;
    const mode = state.sourceMode || 'ebay';   // 'ebay' | 'files'
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">1단계 · 상품 정보 가져오기</h3>

        <!-- 소스 모드 토글 -->
        <div style="display:flex;gap:0;margin-bottom:12px;border:1px solid #2a2a4a;border-radius:6px;overflow:hidden;width:fit-content;">
          <button type="button" onclick="pmcAIWorkflow.setSourceMode('ebay')"
            style="padding:8px 16px;background:${mode === 'ebay' ? '#7c4dff' : 'transparent'};border:0;color:${mode === 'ebay' ? '#fff' : '#888'};cursor:pointer;font-size:12px;font-weight:${mode === 'ebay' ? '700' : '400'};">🔗 eBay Item ID</button>
          <button type="button" onclick="pmcAIWorkflow.setSourceMode('files')"
            style="padding:8px 16px;background:${mode === 'files' ? '#7c4dff' : 'transparent'};border:0;color:${mode === 'files' ? '#fff' : '#888'};cursor:pointer;font-size:12px;font-weight:${mode === 'files' ? '700' : '400'};">📁 이미지 파일 업로드</button>
        </div>

        ${mode === 'ebay' ? `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
          <input type="text" id="wf-item-id" placeholder="eBay Item ID (9~15자리)" value="${esc(c?.itemId || '')}"
            style="flex:1;min-width:240px;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          <button type="button" onclick="pmcAIWorkflow.fetchCompetitor()" id="wf-fetch-btn"
            style="padding:10px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">가져오기</button>
        </div>
        ` : `
        <div style="background:#0f0f23;border:2px dashed #444;border-radius:8px;padding:20px;text-align:center;margin-bottom:12px;">
          <input type="file" id="wf-file-input" accept="image/*" multiple style="display:none;" onchange="pmcAIWorkflow.onFilesPicked(this.files)">
          <button type="button" onclick="document.getElementById('wf-file-input').click()"
            style="padding:12px 24px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">📁 이미지 파일 선택 (최대 5장)</button>
          <div style="color:#666;font-size:11px;margin-top:8px;">JPG / PNG. AI 가 이미지에서 상품명·설명·특징을 자동 추출합니다.</div>
          <div id="wf-file-list" style="margin-top:10px;font-size:11px;color:#aaa;text-align:left;"></div>
          <div style="margin-top:10px;">
            <input type="text" id="wf-file-title" placeholder="(선택) 상품명 힌트를 알고 있다면 입력" style="width:100%;padding:8px 10px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
          </div>
          <button type="button" id="wf-file-submit" onclick="pmcAIWorkflow.submitFiles()" disabled
            style="margin-top:10px;padding:10px 20px;background:#43a047;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;opacity:0.5;">🤖 AI 분석 시작</button>
        </div>
        `}
        <div id="wf-step1-status" style="color:#888;font-size:12px;margin-bottom:12px;"></div>

        ${c ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
            <div style="color:#888;font-size:11px;margin-bottom:4px;">경쟁사 원본 제목</div>
            <div style="color:#fff;font-size:13px;line-height:1.5;">${esc(c.title || '-')}</div>
            <div style="color:#888;font-size:11px;margin-top:8px;">가격: <span style="color:#ffd54f;">$${esc(c.price || '-')}</span></div>
            <div style="color:#888;font-size:11px;">이미지: ${(c.images || []).length}장 · 선택 <span id="wf-sel-count" style="color:#81c784;">${state.selectedImageUrls.size}</span>장</div>
          </div>
          <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div style="color:#888;font-size:11px;">이미지 선택 (클릭하여 선택/해제)</div>
              <div style="display:flex;gap:4px;">
                <button type="button" onclick="pmcAIWorkflow.selectAllImages()" style="padding:2px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;">전체선택</button>
                <button type="button" onclick="pmcAIWorkflow.clearImageSelection()" style="padding:2px 8px;background:#2a2a4a;border:0;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;">전체해제</button>
              </div>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${(c.images || []).map(u => {
                const selected = state.selectedImageUrls.has(u);
                return `<div onclick="pmcAIWorkflow.toggleImage('${esc(u).replace(/'/g, "\\'")}')" title="${selected ? '선택됨 — 클릭하여 해제' : '해제됨 — 클릭하여 선택'}"
                  style="position:relative;width:56px;height:56px;cursor:pointer;border:2px solid ${selected ? '#81c784' : '#333'};border-radius:4px;overflow:hidden;${selected ? '' : 'opacity:0.4;'}">
                  <img src="${esc(u)}" style="width:100%;height:100%;object-fit:cover;pointer-events:none;">
                  ${selected ? '<div style="position:absolute;top:1px;right:2px;background:#81c784;color:#000;font-size:9px;font-weight:700;padding:0 3px;border-radius:2px;">✓</div>' : ''}
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <button type="button" onclick="pmcAIWorkflow.runRemake()" id="wf-remake-btn"
            style="padding:10px 18px;background:#4caf50;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">${r ? '🔄 AI 리메이크 다시' : '🤖 AI 리메이크 실행'}</button>
        </div>
        ` : ''}

        ${r ? `
        <div style="background:#0a3a2a;border:1px solid #1a6a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#81c784;font-size:11px;margin-bottom:6px;">✅ AI 리메이크 결과</div>
          <div style="color:#fff;font-size:14px;font-weight:600;margin-bottom:4px;">${esc(r.seoTitle || r.title || '-')}</div>
          ${r.killPrice ? `<div style="color:#ffd54f;font-size:12px;">권장 킬가: $${esc(r.killPrice)}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" onclick="pmcAIWorkflow.gotoStep(2)"
            style="padding:10px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;">다음 (상세페이지 만들기) →</button>
        </div>
        ` : ''}
      </div>
    `;
  }

  // 2026-08-09: 파일 업로드 모드 (AI 리메이커 흡수)
  const _uploadedFiles = [];  // File[] — 사장님 로컬 이미지
  function setSourceMode(m) {
    state.sourceMode = m;
    renderStep1();
  }
  function onFilesPicked(fileList) {
    _uploadedFiles.length = 0;
    for (const f of fileList) if (f && f.size > 0) _uploadedFiles.push(f);
    _uploadedFiles.splice(5);  // 최대 5장
    const list = document.getElementById('wf-file-list');
    if (list) list.innerHTML = _uploadedFiles.map(f => `📷 ${esc(f.name)} <span style="color:#666;">(${(f.size/1024).toFixed(0)}KB)</span>`).join('<br>');
    const btn = document.getElementById('wf-file-submit');
    if (btn) { btn.disabled = _uploadedFiles.length === 0; btn.style.opacity = _uploadedFiles.length ? '1' : '0.5'; }
  }
  async function submitFiles() {
    if (_uploadedFiles.length === 0) { alert('이미지 파일을 최소 1장 선택하세요'); return; }
    const btn = document.getElementById('wf-file-submit');
    const status = document.getElementById('wf-step1-status');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 분석 중 (30~60초)...'; }
    if (status) status.textContent = '이미지에서 상품 정보 추출 중...';

    const titleHint = document.getElementById('wf-file-title')?.value?.trim() || '';

    try {
      // /api/remarker/reconstruct 를 호출 (AI 리메이커와 같은 백엔드).
      //   images multipart + htmlContent (제목 힌트만) → Gemini Vision 이 상품 정보 추출.
      const fd = new FormData();
      _uploadedFiles.forEach(f => fd.append('images', f, f.name));
      fd.append('htmlContent', titleHint ? '상품명 힌트: ' + titleHint : '');
      fd.append('lang', 'en');
      fd.append('mode', 'standard');
      const res = await fetch('/api/remarker/reconstruct', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

      // reconstruct 응답을 competitor + remake 형태로 매핑
      //   originalImages 는 서버가 CDN 업로드하거나 URL 유지한 결과 반환
      const imgs = data.originalImages || [];
      state.competitor = {
        itemId: null,
        title: data.title || titleHint || '(파일 업로드)',
        description: data.description || '',
        price: 0,
        currency: 'USD',
        images: imgs,
        itemSpecifics: data.extractedSpecs || {},
        categoryId: '',
        categoryName: '',
        conditionId: '',
        conditionDisplayName: '',
      };
      state.remake = {
        title: data.title || titleHint || '',
        description: data.description || '',
        killPrice: 0,
        seoKeywords: data.seoKeywords || [],
      };
      state.reconstruct = {
        htmlDescription: data.description || '',
        raw: data,
        originalImages: imgs,
        lang: 'en',
        mode: 'standard',
      };
      state.selectedImageUrls = new Set(imgs);
      if (status) status.innerHTML = '<span style="color:#81c784;">✅ AI 분석 완료 — 판매가는 4단계에서 직접 입력하세요.</span>';
      renderStep1();
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
      if (btn) { btn.disabled = false; btn.textContent = '🤖 AI 분석 시작'; btn.style.opacity = '1'; }
    }
  }

  async function fetchCompetitor() {
    const itemId = (document.getElementById('wf-item-id')?.value || '').trim();
    if (!/^\d{9,15}$/.test(itemId)) { alert('eBay Item ID는 9~15자리 숫자여야 합니다'); return; }
    const btn = document.getElementById('wf-fetch-btn');
    const status = document.getElementById('wf-step1-status');
    if (btn) { btn.disabled = true; btn.textContent = '가져오는 중…'; }
    if (status) status.textContent = '경쟁사 페이지 호출 중…';
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch('/api/remarker/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
        signal: ctrl.signal,
      });
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
        throw new Error(`서버 오류 (${res.status}): ${m ? m[1].trim() : text.slice(0, 200)}`);
      }
      if (!res.ok) {
        // 2026-08-09: quota 초과 시 파일 업로드 모드로 자동 전환 안내
        if (data && data.errorId === 2001) {
          if (status) {
            status.innerHTML = '<span style="color:#ff8a80;">' + (data.error || 'eBay 조회 한도 초과') + '</span>'
              + ' <button id="wf-switch-files" style="margin-left:8px;padding:4px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;">→ 파일 업로드 모드</button>';
            const sw = document.getElementById('wf-switch-files');
            if (sw) sw.onclick = () => setSourceMode('files');
          }
          return;
        }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // 2026-08-08: 서버는 pictureURLs 필드로 반환, 프론트는 images 참조 → alias 로 정리.
      const item = data.item || {};
      state.competitor = {
        ...item,
        itemId,
        images: item.images || item.pictureURLs || [],
      };
      state.remake = null;
      // 신규 fetch — 모든 이미지 기본 선택
      state.selectedImageUrls = new Set(state.competitor.images);
      renderStep1();
    } catch (e) {
      const msg = e.name === 'AbortError' ? '30초 timeout' : e.message;
      if (status) status.textContent = '에러: ' + msg;
    } finally {
      clearTimeout(to);
      if (btn) { btn.disabled = false; btn.textContent = '가져오기'; }
    }
  }

  async function runRemake() {
    if (!state.competitor) return;
    const btn = document.getElementById('wf-remake-btn');
    const status = document.getElementById('wf-step1-status');
    if (btn) { btn.disabled = true; btn.textContent = 'AI 리메이크 중…'; }
    if (status) status.textContent = '제목·설명·킬가 생성 중 (10~60초)…';
    // 60초 client-side timeout — Gemini fallback 리스트 순회 대비.
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch('/api/remarker/remake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitorData: state.competitor }),
        signal: ctrl.signal,
      });
      // 응답이 JSON 이 아닌 케이스 (413 HTML, 502 gateway HTML 등) 방어.
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        // HTML 에러 페이지에서 pre 태그 내용만 추출 (fallback 은 앞 200자)
        const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
        const msg = m ? m[1].trim() : text.slice(0, 200);
        throw new Error(`서버 오류 (${res.status}): ${msg}`);
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.remake = data.remake;
      if (status) status.textContent = '';
      renderStep1();
    } catch (e) {
      const msg = e.name === 'AbortError' ? '60초 timeout — 서버 응답 없음. 다시 시도.' : e.message;
      if (status) status.textContent = '에러: ' + msg;
    } finally {
      clearTimeout(to);
      if (btn) { btn.disabled = false; btn.textContent = '🪄 AI 리메이크'; }
    }
  }

  // ───────────────────────────────────────────────
  // STEP 2 — 상세페이지 재구성
  // ───────────────────────────────────────────────
  function renderStep2() {
    const host = document.getElementById('wf-body');
    const r = state.reconstruct;
    const imgs = selectedImages().slice(0, 5);
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">2단계 · PMC 브랜드 상세페이지 생성</h3>

        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:6px;">1단계에서 인계된 이미지 (자동 사용)</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            ${imgs.map(u => `<img src="${esc(u)}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid #333;">`).join('')}
          </div>
        </div>

        <!-- 방식 1: PMC 표준 템플릿 (사장님 실제 흐름) — AI 호출 없이 즉시 -->
        <div style="background:#0f2a1a;border:1px solid #1a6a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#81c784;font-size:12px;font-weight:600;margin-bottom:8px;">⚡ PMC 표준 템플릿 <span style="font-weight:400;color:#666;">— eBay/Shopee/Qoo10 용. 제목만 갈아끼움, 즉시 생성</span></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:8px;">
            <label style="color:#aaa;font-size:11px;">Brand<br><input type="text" id="wf-t-brand" value="Pokemon" style="width:100%;margin-top:2px;padding:6px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;"></label>
            <label style="color:#aaa;font-size:11px;">Origin<br><input type="text" id="wf-t-origin" value="Korea, South" style="width:100%;margin-top:2px;padding:6px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;"></label>
            <label style="color:#aaa;font-size:11px;">Color<br><input type="text" id="wf-t-color" value="Multiple Color" style="width:100%;margin-top:2px;padding:6px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;"></label>
            <label style="color:#aaa;font-size:11px;">Material<br><input type="text" id="wf-t-material" value="PP, Paper" style="width:100%;margin-top:2px;padding:6px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;"></label>
            <label style="color:#aaa;font-size:11px;">Condition<br><input type="text" id="wf-t-condition" value="New" style="width:100%;margin-top:2px;padding:6px 8px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;"></label>
          </div>
          <button type="button" onclick="pmcAIWorkflow.runTemplate()"
            style="padding:9px 20px;background:#43a047;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">⚡ 표준 템플릿으로 즉시 생성</button>
        </div>

        <!-- 방식 2: AI 재구성 (Vision 이미지 or 텍스트) — 국내 상품용 -->
        <details style="margin-bottom:12px;">
          <summary style="color:#888;font-size:12px;cursor:pointer;padding:6px 0;">▶ AI 재구성 (선택) — 국내 (쿠팡/네이버) 상품 이미지 리치 상세페이지</summary>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;padding:10px;background:#0f0f23;border:1px solid #2a2a4a;border-radius:6px;">
            <label style="color:#888;font-size:12px;">언어:</label>
            <select id="wf-lang" style="padding:8px;background:#1a1a2e;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="en">English</option>
              <option value="ko">한국어</option>
              <option value="both">English + 한국어</option>
            </select>
            <label style="color:#888;font-size:12px;margin-left:12px;">모드:</label>
            <select id="wf-mode" style="padding:8px;background:#1a1a2e;border:1px solid #333;border-radius:6px;color:#fff;">
              <option value="standard">표준 (이미지 5장)</option>
              <option value="fast">빠름 (이미지 1장)</option>
            </select>
            <button type="button" onclick="pmcAIWorkflow.runReconstruct()" id="wf-reconstruct-btn"
              style="padding:9px 16px;background:#e94560;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:12px;">${r ? '🔄 재구성 다시' : '🤖 AI 재구성'}</button>
          </div>
        </details>
        <div id="wf-step2-status" style="color:#888;font-size:12px;margin-bottom:12px;"></div>

        ${r ? `
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="color:#81c784;font-size:12px;font-weight:600;">✅ 생성된 상세페이지</div>
            <button type="button" onclick="pmcAIWorkflow.copyHtml()" style="padding:6px 12px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">📋 HTML 복사</button>
          </div>
          <iframe id="wf-recon-preview" style="width:100%;height:480px;background:#fff;border:0;border-radius:6px;"></iframe>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" onclick="pmcAIWorkflow.gotoStep(1)"
            style="padding:10px 18px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;">← 이전</button>
          <button type="button" onclick="pmcAIWorkflow.gotoStep(3)"
            style="padding:10px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;">다음 (썸네일 만들기) →</button>
        </div>
        ` : `
        <div style="display:flex;gap:8px;">
          <button type="button" onclick="pmcAIWorkflow.gotoStep(1)"
            style="padding:10px 18px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;">← 이전</button>
        </div>
        `}
      </div>
    `;
    if (r) {
      const iframe = document.getElementById('wf-recon-preview');
      if (iframe) iframe.srcdoc = r.htmlDescription || '';
    }
  }

  // ⚡ PMC 표준 템플릿 — 사장님 실제 eBay 상세페이지 (2026-08-08 사장님 보내준 원본 그대로).
  //   AI 호출 없이 즉시. 제목/브랜드/원산지/컬러/재질/컨디션 6개 필드만 갈아끼움.
  //   나머지 (배송·결제·반품·about) 는 boilerplate 고정.
  const PMC_TEMPLATE = ({ title, brand, origin, color, material, condition }) => `
<div style="max-width:800px;margin:0 auto;font-family:Arial,sans-serif;color:#333;font-size:13px;line-height:1.6;">
  <div style="border-bottom:2px solid #1a1a2e;padding-bottom:12px;margin-bottom:16px;">
    <div style="font-size:11px;color:#888;letter-spacing:1px;">DESCRIPTION</div>
    <h2 style="margin:6px 0 0;color:#1a1a2e;font-size:18px;">${_esc(title)}</h2>
    <div style="margin-top:6px;color:#e94560;font-size:12px;font-weight:600;">100% Official Licensed Genuine Item</div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tbody>
      <tr><td style="padding:6px 0;color:#666;width:120px;">Brand</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${_esc(brand)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Origin</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${_esc(origin)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Color</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${_esc(color)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Material</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${_esc(material)}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Condition</td><td style="padding:6px 0;color:#1a1a2e;font-weight:600;">${_esc(condition)}</td></tr>
    </tbody>
  </table>

  <p style="color:#999;font-size:11px;font-style:italic;margin:16px 0;">
    * Colour in the picture might be slightly different due to the lighting when picture is taken.
  </p>

  <hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;">

  <h3 style="color:#1a1a2e;font-size:14px;margin:16px 0 8px;">◆ Shipping</h3>
  <p style="margin:0 0 10px;">
    All items will be shipped from Korea, South.<br>
    Basically, We provide Free Economy Shipping (Tracking Not Available).<br>
    If you want to use Registered mail, please add <b>$3 more for Standard Shipping</b>.<br>
    At least items will arrive around <b>10~15 days</b> with economic shipping.<br>
    We do very careful packing. Your item will be shipped out within <b>2 business days</b>.
  </p>

  <h3 style="color:#1a1a2e;font-size:14px;margin:16px 0 8px;">◆ Payment</h3>
  <p style="margin:0 0 10px;">
    We only accept <b>PayPal</b> payments.<br>
    Please pay within <b>3 days</b> after auction is finished.
  </p>

  <h3 style="color:#1a1a2e;font-size:14px;margin:16px 0 8px;">◆ Import Duties & Taxes</h3>
  <p style="margin:0 0 10px;">
    Import duties, taxes and charges are <b>not included</b> in the item price or shipping charges.
    These charges are the <b>buyer's responsibility</b>. Please check with your country's customs office
    to determine what these additional costs will be prior to bidding/buying.
  </p>

  <h3 style="color:#1a1a2e;font-size:14px;margin:16px 0 8px;">◆ Returns</h3>
  <p style="margin:0 0 10px;">
    <b>Money back guarantee within 30 days</b> if returned by customer.
  </p>

  <hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;">

  <h3 style="color:#1a1a2e;font-size:14px;margin:16px 0 8px;">◆ About Us</h3>
  <p style="margin:0 0 10px;">
    Thank you for looking.<br>
    I'll send your goods quickly with care.<br>
    All items are <b>"AUTHENTIC"</b>.<br>
    If you have any questions, please e-mail or message me. I will do my best to help you!
  </p>

  <div style="margin-top:20px;padding-top:12px;border-top:2px solid #1a1a2e;text-align:center;font-size:11px;color:#888;">
    <b style="color:#1a1a2e;">PMC Corporation</b> — Premium Quality Verified
  </div>
</div>`.trim();

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ⚡ 즉시 템플릿 생성 — AI 호출 없음
  function runTemplate() {
    const title = state.remake?.seoTitle || state.remake?.title || state.competitor?.title || '';
    if (!title) { alert('1단계에서 상품 정보를 먼저 가져오세요'); return; }
    const fields = {
      title,
      brand:     document.getElementById('wf-t-brand')?.value?.trim()     || 'Pokemon',
      origin:    document.getElementById('wf-t-origin')?.value?.trim()    || 'Korea, South',
      color:     document.getElementById('wf-t-color')?.value?.trim()     || 'Multiple Color',
      material:  document.getElementById('wf-t-material')?.value?.trim()  || 'PP, Paper',
      condition: document.getElementById('wf-t-condition')?.value?.trim() || 'New',
    };
    const html = PMC_TEMPLATE(fields);
    state.reconstruct = {
      htmlDescription: html,
      raw: { source: 'template', fields },
      originalImages: selectedImages().slice(0, 5),
      lang: 'en',
      mode: 'template',
    };
    renderStep2();
  }

  async function runReconstruct() {
    // 사장님이 선택한 이미지만 사용. 없으면 텍스트 모드 (해외 3사 OK).
    const imgs = selectedImages().slice(0, 5);
    const lang = document.getElementById('wf-lang')?.value || 'en';
    const mode = document.getElementById('wf-mode')?.value || 'standard';
    const btn = document.getElementById('wf-reconstruct-btn');
    const status = document.getElementById('wf-step2-status');
    if (btn) { btn.disabled = true; btn.textContent = '재구성 중…'; }
    if (status) status.textContent = imgs.length > 0
      ? `이미지 ${imgs.length}장 분석 + 상세페이지 생성 중 (15~60초)…`
      : '텍스트 기반 상세페이지 생성 중 (10~30초)…';

    // client-side timeout 90초 (Vision 은 오래 걸림)
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90000);
    try {
      // 1단계 이미지를 fetch → blob → FormData 로 업로드 (백엔드 multipart 라우트 재사용).
      // 이미지 없어도 htmlContent + remake 결과로 텍스트 상세페이지 생성 가능.
      const fd = new FormData();
      let imgIndex = 0;
      for (const url of imgs) {
        try {
          const r = await fetch(url);
          const blob = await r.blob();
          const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          fd.append('images', blob, `wf-${imgIndex++}.${ext}`);
        } catch (_) { /* 한 장 실패해도 계속 진행 */ }
      }
      // 텍스트 소스: competitor.description + 1단계 remake 결과 (title/description) 합침
      const textParts = [];
      if (state.competitor?.title) textParts.push('제품: ' + state.competitor.title);
      if (state.remake?.title || state.remake?.seoTitle) textParts.push('SEO 제목: ' + (state.remake.seoTitle || state.remake.title));
      if (state.remake?.description) textParts.push('설명 초안: ' + state.remake.description.replace(/<[^>]+>/g, ' '));
      if (state.competitor?.description) textParts.push('원본 상세: ' + state.competitor.description);
      const htmlContent = textParts.join('\n\n');
      fd.append('htmlContent', htmlContent);
      fd.append('lang', lang);
      fd.append('mode', mode);

      const res = await fetch('/api/remarker/reconstruct', { method: 'POST', body: fd, signal: ctrl.signal });
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
        throw new Error(`서버 오류 (${res.status}): ${m ? m[1].trim() : text.slice(0, 200)}`);
      }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      // 응답 필드: lang='en'/'ko' → description; lang='both' → descriptionEn + descriptionKo
      const htmlDescription = data.lang === 'both'
        ? `${data.descriptionEn || ''}<hr style="margin:32px 0;border:0;border-top:2px dashed #ccc;">${data.descriptionKo || ''}`
        : (data.description || data.descriptionEn || data.descriptionKo || '');
      state.reconstruct = { htmlDescription, raw: data, originalImages: data.originalImages || imgs, lang, mode };
      if (status) status.textContent = '';
      renderStep2();
    } catch (e) {
      const msg = e.name === 'AbortError' ? '90초 timeout' : e.message;
      if (status) status.textContent = '에러: ' + msg;
      if (btn) { btn.disabled = false; btn.textContent = '🤖 상세페이지 재구성'; }
    } finally {
      clearTimeout(to);
    }
  }

  function copyHtml() {
    if (!state.reconstruct?.htmlDescription) return;
    navigator.clipboard.writeText(state.reconstruct.htmlDescription)
      .then(() => alert('HTML 복사 완료'))
      .catch(() => alert('복사 실패 — 브라우저 권한 확인'));
  }

  // ───────────────────────────────────────────────
  // STEP 3 — 썸네일 만들기
  // ───────────────────────────────────────────────
  function renderStep3() {
    const host = document.getElementById('wf-body');
    const imgs = selectedImages().slice(0, 6);
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">3단계 · 플랫폼별 썸네일 생성</h3>

        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:6px;">1단계에서 인계된 이미지 (썸네일 소스로 사용)</div>
          <div id="wf-thumb-sources" style="display:flex;gap:4px;flex-wrap:wrap;">
            ${imgs.map((u, i) => `
              <label style="cursor:pointer;position:relative;">
                <input type="checkbox" class="wf-img-check" data-url="${esc(u)}" ${i === 0 ? 'checked' : ''} style="position:absolute;top:4px;left:4px;z-index:2;">
                <img src="${esc(u)}" style="width:72px;height:72px;object-fit:cover;border-radius:4px;border:2px solid #333;">
              </label>
            `).join('')}
          </div>
          <div style="color:#666;font-size:11px;margin-top:6px;">체크한 이미지마다 썸네일을 생성합니다. (체크 안 하면 첫 번째 자동 선택)</div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
          <label style="color:#888;font-size:12px;">플랫폼:</label>
          <select id="wf-thumb-platform" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="alibaba">Alibaba</option>
            <option value="ebay">eBay</option>
            <option value="shopify">Shopify</option>
            <option value="shopee">Shopee</option>
            <option value="qoo10">Qoo10</option>
            <option value="custom">Custom</option>
          </select>
          <label style="color:#888;font-size:12px;margin-left:12px;">배경 제거:</label>
          <select id="wf-thumb-bg" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="local">Local (@imgly, 빠름)</option>
            <option value="gemini">Gemini (정밀)</option>
            <option value="removebg">removebg.com</option>
            <option value="none">사용 안 함</option>
          </select>
          <button type="button" onclick="pmcAIWorkflow.runThumbnails()" id="wf-thumb-btn"
            style="padding:10px 18px;background:#ff9800;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">${state.thumbnails.length ? '🔄 다시 생성' : '🖼️ 썸네일 생성'}</button>
        </div>
        <div id="wf-step3-status" style="color:#888;font-size:12px;margin-bottom:12px;"></div>

        ${state.thumbnails.length ? `
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#81c784;font-size:12px;font-weight:600;margin-bottom:8px;">✅ 생성된 썸네일 ${state.thumbnails.length}장</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${state.thumbnails.map((t, i) => `
              <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:6px;padding:8px;">
                <img src="${esc(t.url)}" style="width:160px;height:160px;object-fit:contain;background:#fff;border-radius:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
                  <span style="color:#aaa;font-size:11px;">#${i+1} · ${esc(t.platform)}</span>
                  <a href="${esc(t.url)}" download="thumbnail-${i+1}-${esc(t.platform)}.png" style="color:#81d4fa;font-size:11px;text-decoration:none;">⬇ 다운로드</a>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <div style="display:flex;gap:8px;">
          <button type="button" onclick="pmcAIWorkflow.gotoStep(2)"
            style="padding:10px 18px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;">← 이전</button>
          <button type="button" onclick="pmcAIWorkflow.gotoStep(4)"
            style="padding:10px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:700;">다음 (플랫폼 배포) 🚀 →</button>
        </div>
      </div>
    `;
  }

  // ───────────────────────────────────────────────
  // STEP 4 — 멀티플랫폼 배포 (eBay + Shopify)
  // ───────────────────────────────────────────────
  function renderStep4() {
    const host = document.getElementById('wf-body');
    const presets = loadPresets();
    const pub = state.publish;
    const canPublish = !!(state.remake && (state.reconstruct?.htmlDescription || state.remake.description));

    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">4단계 · 멀티플랫폼 배포</h3>
        <p style="color:#888;font-size:12px;margin:0 0 16px;">1~3단계 결과를 선택한 플랫폼에 자동 등록합니다. 프리셋은 브라우저에 저장되어 다음번에도 유지됩니다.</p>

        ${!canPublish ? `<div style="padding:16px;background:#3a1a1a;color:#ff8a80;border-radius:6px;margin-bottom:12px;">
          ⚠️ 1단계 리메이커 + 2단계 상세페이지가 완료되어야 배포 가능합니다.
        </div>` : ''}

        <!-- 플랫폼 선택 + 프리셋 -->
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:14px;margin-bottom:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:10px;">배포할 플랫폼 (체크 선택)</div>

          <!-- eBay -->
          <div style="padding:10px;background:#1a1a2e;border-radius:6px;margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="wf-pub-ebay" checked>
              <span style="color:#fff;font-weight:600;">🛒 eBay</span>
              <span style="color:#888;font-size:11px;">— Trading API (경매/고정가)</span>
            </label>
            <details style="margin-top:6px;" open>
              <summary style="color:#7c4dff;font-size:11px;cursor:pointer;">▶ eBay 프리셋 편집</summary>
              <!-- 성공한 리스팅에서 프리셋 자동 복사 -->
              <div style="margin-top:6px;padding:8px;background:#0a1f3a;border:1px dashed #1976d2;border-radius:4px;">
                <div style="font-size:11px;color:#90caf9;margin-bottom:4px;">💡 이미 잘 팔리는 이베이 리스팅에서 프리셋 자동 복사</div>
                <div style="display:flex;gap:4px;">
                  <input type="text" id="wf-preset-source-item" placeholder="이베이 Item ID (예: 206202404025)" style="flex:1;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                  <button type="button" onclick="pmcAIWorkflow.importPresetFromListing()" style="padding:4px 10px;background:#1976d2;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:11px;">📥 프리셋 복사</button>
                </div>
                <div id="wf-preset-source-status" style="font-size:10px;color:#888;margin-top:4px;"></div>
              </div>
              <!-- 카테고리 필수 aspect 사전 조회 (rate limit 낭비 방지) -->
              <div style="margin-top:6px;padding:8px;background:#2a1a3a;border:1px dashed #7c4dff;border-radius:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                  <div style="font-size:11px;color:#b39ddb;">🔎 카테고리 필수 aspect 미리 확인 (등록 실패 낭비 방지)</div>
                  <button type="button" onclick="pmcAIWorkflow.checkEbayAspects()" style="padding:3px 10px;background:#7c4dff;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">🔎 조회</button>
                </div>
                <div id="wf-aspect-list" style="font-size:10px;color:#888;"></div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;font-size:11px;">
                <label style="color:#aaa;grid-column:span 2;">Category ID
                  <div style="display:flex;gap:4px;margin-top:2px;">
                    <input type="text" id="wf-preset-ebay-category" value="${esc(presets.ebay.categoryId || '')}" style="flex:1;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                    <button type="button" onclick="pmcAIWorkflow.suggestEbayCategory()" style="padding:4px 10px;background:#7c4dff;border:0;border-radius:3px;color:#fff;cursor:pointer;font-size:10px;">🔍 자동 추천</button>
                  </div>
                  <div id="wf-cat-suggest" style="margin-top:4px;font-size:10px;color:#888;"></div>
                </label>
                <label style="color:#aaa;">Condition ID
                  <select id="wf-preset-ebay-condition" style="width:100%;margin-top:2px;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                    ${_ebayConditionOptions(presets.ebay.conditionId)}
                  </select>
                </label>
                <label style="color:#aaa;">Currency<br><input type="text" id="wf-preset-ebay-currency" value="${esc(presets.ebay.currency || 'USD')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Game (필수)<br><input type="text" id="wf-preset-ebay-game" value="${esc(presets.ebay.itemSpecifics?.Game || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Type (필수)<br><input type="text" id="wf-preset-ebay-type" value="${esc(presets.ebay.itemSpecifics?.Type || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Manufacturer (필수)<br><input type="text" id="wf-preset-ebay-mfr" value="${esc(presets.ebay.itemSpecifics?.Manufacturer || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Age Level (필수)<br><input type="text" id="wf-preset-ebay-age" value="${esc(presets.ebay.itemSpecifics?.['Age Level'] || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Language<br><input type="text" id="wf-preset-ebay-lang" value="${esc(presets.ebay.itemSpecifics?.Language || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Country of Origin<br><input type="text" id="wf-preset-ebay-country" value="${esc(presets.ebay.itemSpecifics?.['Country of Origin'] || presets.ebay.itemSpecifics?.['Country/Region of Manufacture'] || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;grid-column:span 2;">Set (필수 — 상품마다 다름)
                  <input type="text" id="wf-preset-ebay-set" value="${esc(presets.ebay.itemSpecifics?.Set || '')}" placeholder="예: Scarlet & Violet, Legends, Mega Festa 2026" style="width:100%;margin-top:2px;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                </label>
                <div style="grid-column:span 2;color:#666;font-size:10px;">💡 Booster Box=183456 / Booster Pack=183455 / Single Card=183454</div>
              </div>
            </details>
          </div>

          <!-- Shopify -->
          <div style="padding:10px;background:#1a1a2e;border-radius:6px;margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="wf-pub-shopify" checked>
              <span style="color:#fff;font-weight:600;">🛍 Shopify</span>
              <span style="color:#888;font-size:11px;">— Admin REST</span>
            </label>
            <details style="margin-top:6px;">
              <summary style="color:#7c4dff;font-size:11px;cursor:pointer;">▶ Shopify 프리셋 편집</summary>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;font-size:11px;">
                <label style="color:#aaa;">Vendor<br><input type="text" id="wf-preset-shopify-vendor" value="${esc(presets.shopify.vendor || 'PMC')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Product Type<br><input type="text" id="wf-preset-shopify-type" value="${esc(presets.shopify.productType || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
                <label style="color:#aaa;">Status<br><select id="wf-preset-shopify-status" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                  <option value="active" ${presets.shopify.status === 'active' ? 'selected' : ''}>active (즉시 게시)</option>
                  <option value="draft" ${presets.shopify.status === 'draft' ? 'selected' : ''}>draft (초안)</option>
                </select></label>
                <label style="color:#aaa;">재고 정책<br><select id="wf-preset-shopify-invpolicy" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;">
                  <option value="deny" ${presets.shopify.inventoryPolicy === 'deny' ? 'selected' : ''}>deny (재고 없으면 판매중단)</option>
                  <option value="continue" ${presets.shopify.inventoryPolicy === 'continue' ? 'selected' : ''}>continue (계속 판매)</option>
                </select></label>
                <label style="color:#aaa;grid-column:span 2;">Tags (콤마)<br><input type="text" id="wf-preset-shopify-tags" value="${esc(presets.shopify.tags || '')}" style="width:100%;padding:5px 7px;background:#0f0f23;border:1px solid #333;border-radius:3px;color:#fff;font-size:11px;"></label>
              </div>
            </details>
          </div>

          <!-- 공통 -->
          <div style="display:flex;gap:8px;align-items:center;padding:10px;background:#0f0f23;border:1px dashed #333;border-radius:6px;margin-top:8px;">
            <label style="color:#aaa;font-size:11px;">판매가:</label>
            <input type="number" id="wf-pub-price" value="${state.remake?.killPrice || 0}" step="0.01" style="width:100px;padding:5px 7px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#fff;font-size:12px;">
            <span style="color:#666;font-size:10px;">권장 킬가 자동 세팅</span>
            <label style="color:#aaa;font-size:11px;margin-left:12px;">재고:</label>
            <input type="number" id="wf-pub-qty" value="1" min="1" style="width:70px;padding:5px 7px;background:#1a1a2e;border:1px solid #333;border-radius:3px;color:#fff;font-size:12px;">
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
          <button type="button" id="wf-verify-btn" onclick="pmcAIWorkflow.runVerify()" ${!canPublish || pub?.running ? 'disabled' : ''}
            style="padding:10px 18px;background:#1976d2;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;font-size:13px;" title="실제 등록 없이 payload 검증만. rate limit 소진 X — 무제한 시행착오 가능">
            🔍 사전 검증 (실 등록 X)
          </button>
          <button type="button" id="wf-publish-btn" onclick="pmcAIWorkflow.runPublish()" ${!canPublish || pub?.running ? 'disabled' : ''}
            style="padding:12px 24px;background:${pub?.running ? '#555' : '#43a047'};border:0;border-radius:6px;color:#fff;cursor:${pub?.running ? 'wait' : 'pointer'};font-weight:700;font-size:14px;">
            ${pub?.running ? '⏳ 배포 중...' : '🚀 선택된 플랫폼에 등록'}
          </button>
          <button type="button" onclick="pmcAIWorkflow.savePresetsFromUI()"
            style="padding:8px 14px;background:#2a2a4a;border:1px solid #444;border-radius:6px;color:#aaa;cursor:pointer;font-size:11px;">💾 프리셋 저장</button>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:8px;">💡 <b>[🔍 사전 검증]</b> 먼저 눌러서 에러 없는지 확인 → 통과되면 <b>[🚀 등록]</b>. 검증은 rate limit 안 씀.</div>

        <div id="wf-step4-status" style="color:#888;font-size:12px;margin-bottom:12px;"></div>

        ${pub?.results ? `
        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:8px;">배포 결과 ${pub.results.filter(r => r.success).length}/${pub.results.length} 성공</div>
          ${pub.results.map(r => `
            <div style="padding:10px;background:#1a1a2e;border-left:3px solid ${r.success ? '#4caf50' : '#e94560'};border-radius:4px;margin-bottom:6px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="color:#fff;font-size:13px;font-weight:600;">
                  ${r.success ? '✅' : '❌'} ${esc(r.platform)}
                  ${r.elapsedMs ? ` <span style="color:#666;font-size:10px;font-weight:400;">(${(r.elapsedMs/1000).toFixed(1)}s)</span>` : ''}
                </div>
                ${r.listingUrl ? `<a href="${esc(r.listingUrl)}" target="_blank" rel="noopener" style="color:#81d4fa;font-size:11px;">🔗 열기</a>` : ''}
              </div>
              ${r.itemId || r.productId ? `<div style="color:#aaa;font-size:11px;margin-top:4px;">ID: ${esc(r.itemId || r.productId)}</div>` : ''}
              ${r.thumbnailUploaded ? `<div style="color:#666;font-size:10px;margin-top:2px;">썸네일 ${r.thumbnailUploaded}장 업로드</div>` : ''}
              ${r.error ? `<div style="color:#ff8a80;font-size:11px;margin-top:4px;white-space:pre-wrap;">${esc(String(r.error).slice(0, 300))}</div>` : ''}
            </div>
          `).join('')}
        </div>
        ` : ''}

        <div style="display:flex;gap:8px;">
          <button type="button" onclick="pmcAIWorkflow.gotoStep(3)"
            style="padding:10px 18px;background:#2a2a4a;border:0;border-radius:6px;color:#fff;cursor:pointer;">← 이전</button>
        </div>
      </div>
    `;
  }

  // eBay condition ID — 카테고리별로 유효값 다름.
  //   일반 상품:      1000 (New) / 1500 (New other) / 3000-7000 (Used tiers)
  //   Trading Cards: 4000 (Ungraded) / 2750 (Graded) ← Pokemon Individual Cards 등 대부분
  //   Booster Box:   1000 (New)
  function _ebayConditionOptions(selected) {
    const opts = [
      { id: '4000',  label: 'Ungraded — Trading Cards 낱장 (기본)' },
      { id: '2750',  label: 'Graded — 등급 매김 카드 (PSA/BGS 등)' },
      { id: '1000',  label: 'New — 신품 (박스/팩)' },
      { id: '1500',  label: 'New other — 개봉 미사용' },
      { id: '1750',  label: 'New with defects' },
      { id: '2000',  label: 'Manufacturer refurbished' },
      { id: '2500',  label: 'Seller refurbished' },
      { id: '3000',  label: 'Used' },
      { id: '5000',  label: 'Good' },
      { id: '6000',  label: 'Acceptable' },
      { id: '7000',  label: 'For parts or not working' },
    ];
    return opts.map(o => `<option value="${o.id}" ${String(selected) === o.id ? 'selected' : ''}>${o.label}</option>`).join('');
  }

  // Trading Cards 는 Grade aspect 로 상태 표시 (Item Specifics)
  const CARD_GRADES = ['Mint', 'Near Mint', 'Excellent', 'Very Good', 'Good', 'Light Play', 'Played', 'Damaged'];
  function _gradeOptions(selected) {
    return CARD_GRADES.map(g => `<option value="${g}" ${selected === g ? 'selected' : ''}>${g}</option>`).join('');
  }

  async function suggestEbayCategory() {
    const title = state.remake?.title || state.competitor?.title || '';
    if (!title) { alert('상품 제목이 필요합니다 (1단계 결과)'); return; }
    const box = document.getElementById('wf-cat-suggest');
    if (box) box.innerHTML = '<span style="color:#888;">검색 중...</span>';
    try {
      const r = await fetch('/api/categories/search?platform=ebay&query=' + encodeURIComponent(title.slice(0, 100)));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      const cats = j.categories || [];
      if (cats.length === 0) { if (box) box.innerHTML = '<span style="color:#ff8a80;">추천 카테고리 없음</span>'; return; }
      if (box) box.innerHTML = '추천: ' + cats.slice(0, 5).map(c => {
        const cid = c.categoryId || c.id || c.CategoryID || '';
        const cname = c.categoryName || c.name || c.CategoryName || '(no name)';
        return `<a onclick="pmcAIWorkflow.pickEbayCategory('${cid}');return false;" style="color:#81d4fa;cursor:pointer;text-decoration:underline;margin-right:8px;">[${cid}] ${cname.slice(0, 30)}</a>`;
      }).join('');
    } catch (e) {
      if (box) box.innerHTML = '<span style="color:#ff8a80;">에러: ' + esc(e.message) + '</span>';
    }
  }

  function pickEbayCategory(cid) {
    const inp = document.getElementById('wf-preset-ebay-category');
    if (inp) inp.value = cid;
    const box = document.getElementById('wf-cat-suggest');
    if (box) box.innerHTML = '<span style="color:#81c784;">✓ 카테고리 ' + esc(cid) + ' 로 세팅됨. 프리셋 저장 후 재시도.</span>';
  }

  // 카테고리별 필수 aspect 사전 조회 → 어떤 필드가 반드시 필요한지 미리 확인.
  //   Trading Cards 는 여기에 안 뜨는 필드도 필수인 경우 있음 (Card Condition aspect 40001)
  //   → 알려진 특수 케이스 추가로 표시.
  async function checkEbayAspects() {
    const cid = document.getElementById('wf-preset-ebay-category')?.value?.trim() || '183456';
    const box = document.getElementById('wf-aspect-list');
    if (box) box.innerHTML = '<span style="color:#888;">조회 중...</span>';
    try {
      const r = await fetch('/api/ai-workflow/ebay-aspects?categoryId=' + encodeURIComponent(cid));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      const asp = j.aspects || [];
      const required = asp.filter(a => a.required);
      const recommended = asp.filter(a => !a.required).slice(0, 8);
      const html = `
        <div style="color:#81c784;font-weight:600;margin-bottom:2px;">필수 (${required.length}):</div>
        ${required.length > 0 ? `<ul style="margin:0 0 4px 16px;padding:0;color:#c8e6c9;">${required.map(a => `<li>${esc(a.name)} <span style="color:#888;">(${a.mode})</span></li>`).join('')}</ul>` : '<div style="color:#666;margin-bottom:4px;">(공식 API 상 없음)</div>'}
        <div style="color:#90caf9;font-weight:600;margin-top:6px;margin-bottom:2px;">추천 (권장):</div>
        <div style="color:#aaa;">${recommended.map(a => esc(a.name)).join(' · ') || '(없음)'}</div>
      `;
      if (box) box.innerHTML = html;
    } catch (e) {
      if (box) box.innerHTML = '<span style="color:#ff8a80;">에러: ' + esc(e.message) + '</span>';
    }
  }

  // 성공한 이베이 리스팅에서 프리셋 자동 복사 (실수 없이 검증된 값 사용).
  async function importPresetFromListing() {
    const itemId = (document.getElementById('wf-preset-source-item')?.value || '').trim();
    if (!/^\d{9,15}$/.test(itemId)) { alert('이베이 Item ID 9~15자리 숫자 입력'); return; }
    const status = document.getElementById('wf-preset-source-status');
    if (status) status.textContent = '조회 중...';
    try {
      const r = await fetch('/api/ai-workflow/preset-from-listing?itemId=' + encodeURIComponent(itemId));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      const p = j.preset?.ebay || {};
      // 프리셋 편집 필드에 자동 채움
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      set('wf-preset-ebay-category', p.categoryId);
      set('wf-preset-ebay-condition', p.conditionId);
      set('wf-preset-ebay-currency', p.currency);
      set('wf-preset-ebay-game', p.itemSpecifics?.Game || j.raw?.specifics?.Game);
      set('wf-preset-ebay-type', p.itemSpecifics?.Type || j.raw?.specifics?.Type);
      set('wf-preset-ebay-mfr', p.itemSpecifics?.Manufacturer || j.raw?.specifics?.Manufacturer);
      set('wf-preset-ebay-age', p.itemSpecifics?.['Age Level'] || j.raw?.specifics?.['Age Level']);
      set('wf-preset-ebay-lang', p.itemSpecifics?.Language);
      set('wf-preset-ebay-country', p.itemSpecifics?.['Country of Origin'] || j.raw?.specifics?.['Country of Origin']);
      // 자동 저장
      savePresetsFromUI();
      if (status) {
        const cat = j.raw?.categoryName || p.categoryId;
        const cond = j.raw?.conditionDisplayName || p.conditionId;
        status.innerHTML = `<span style="color:#81c784;">✓ 복사됨 — 카테고리: ${esc(cat)} · 컨디션: ${esc(cond)} · 저장됨</span>`;
      }
    } catch (e) {
      if (status) status.innerHTML = '<span style="color:#ff8a80;">에러: ' + esc(e.message) + '</span>';
    }
  }

  function savePresetsFromUI() {
    const presets = {
      ebay: {
        categoryId:  document.getElementById('wf-preset-ebay-category')?.value?.trim() || '183456',
        conditionId: document.getElementById('wf-preset-ebay-condition')?.value?.trim() || '1000',
        currency:    document.getElementById('wf-preset-ebay-currency')?.value?.trim() || 'USD',
        quantity:    1,
        itemSpecifics: {
          Game:                document.getElementById('wf-preset-ebay-game')?.value?.trim() || '',
          Type:                document.getElementById('wf-preset-ebay-type')?.value?.trim() || '',
          Manufacturer:        document.getElementById('wf-preset-ebay-mfr')?.value?.trim() || '',
          'Age Level':         document.getElementById('wf-preset-ebay-age')?.value?.trim() || '',
          Language:            document.getElementById('wf-preset-ebay-lang')?.value?.trim() || '',
          'Country of Origin': document.getElementById('wf-preset-ebay-country')?.value?.trim() || '',
          Set:                 document.getElementById('wf-preset-ebay-set')?.value?.trim() || '',
        },
      },
      shopify: {
        vendor:          document.getElementById('wf-preset-shopify-vendor')?.value?.trim() || 'PMC',
        productType:     document.getElementById('wf-preset-shopify-type')?.value?.trim() || '',
        status:          document.getElementById('wf-preset-shopify-status')?.value || 'active',
        inventoryPolicy: document.getElementById('wf-preset-shopify-invpolicy')?.value || 'deny',
        tags:            document.getElementById('wf-preset-shopify-tags')?.value?.trim() || '',
        quantity:        1,
      },
    };
    savePresets(presets);
    const status = document.getElementById('wf-step4-status');
    if (status) { status.textContent = '✓ 프리셋 저장됨 (브라우저)'; setTimeout(() => { status.textContent = ''; }, 2000); }
  }

  // 2026-08-09: 실 등록 없이 사전 검증. VerifyAddFixedPriceItem — rate limit 안 소진.
  async function runVerify() {
    savePresetsFromUI();
    const presets = loadPresets();
    const price = Number(document.getElementById('wf-pub-price')?.value) || state.remake?.killPrice || 0;
    const qty = Number(document.getElementById('wf-pub-qty')?.value) || 1;
    const status = document.getElementById('wf-step4-status');
    if (status) status.textContent = '🔍 eBay 검증 중 (5~10초)...';

    const product = {
      title: state.remake?.title || state.competitor?.title || '',
      description: state.reconstruct?.htmlDescription || state.remake?.description || '',
      price, quantity: qty,
      imageUrls: Array.from(state.selectedImageUrls || []),
      itemSpecifics: state.competitor?.itemSpecifics || {},
      competitorItemId: state.competitor?.itemId,
    };

    try {
      const r = await fetch('/api/ai-workflow/verify-ebay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, preset: { ...presets.ebay, quantity: qty } }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);

      // 결과 표시 — publish 결과 영역 재사용
      const fmtErr = e => {
        const msg = e.longMessage || e.shortMessage || 'unknown';
        const codeStr = e.code ? ` [code=${e.code}]` : '';
        const paramStr = (e.params && e.params.length) ? ` [param: ${e.params.join(', ')}]` : '';
        return esc(msg) + codeStr + paramStr;
      };
      const errList = (j.criticalErrors || []).map(e => '❌ ' + fmtErr(e));
      const warnList = (j.warnings || []).map(e => '⚠️ ' + fmtErr(e));
      state.publish = {
        platforms: ['ebay'], presets, running: false,
        results: [{
          platform: 'ebay',
          verify: true,
          success: j.success,
          error: errList.length ? errList.concat(warnList).join('\n') : null,
          elapsedMs: j.elapsedMs,
        }],
      };
      renderStep4();
      if (status) {
        if (j.success) status.innerHTML = '<span style="color:#81c784;">✅ 검증 통과 — 이제 [🚀 등록] 클릭</span>';
        else status.innerHTML = `<span style="color:#ff8a80;">❌ 검증 실패 ${errList.length}건 — 프리셋 수정 후 다시 검증 (실 등록 안 됐음)</span>`;
      }
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
    }
  }

  async function runPublish() {
    savePresetsFromUI();
    const presets = loadPresets();
    const platforms = [];
    if (document.getElementById('wf-pub-ebay')?.checked) platforms.push('ebay');
    if (document.getElementById('wf-pub-shopify')?.checked) platforms.push('shopify');
    if (platforms.length === 0) { alert('플랫폼을 1개 이상 선택하세요'); return; }

    const price = Number(document.getElementById('wf-pub-price')?.value) || state.remake?.killPrice || 0;
    const qty = Number(document.getElementById('wf-pub-qty')?.value) || 1;
    if (price <= 0) { alert('판매가는 0보다 커야 합니다'); return; }

    state.publish = { platforms, presets, results: null, running: true };
    renderStep4();
    const status = document.getElementById('wf-step4-status');
    if (status) status.textContent = `${platforms.join(', ')} 배포 중 (30~60초 각각)...`;

    // 각 플랫폼 프리셋에 quantity 세팅
    platforms.forEach(p => { presets[p] = { ...(presets[p] || {}), quantity: qty }; });

    const product = {
      title: state.remake?.title || state.competitor?.title || '',
      description: state.reconstruct?.htmlDescription || state.remake?.description || '',
      price,
      quantity: qty,
      imageUrls: Array.from(state.selectedImageUrls || []),
      thumbnailsBase64: (state.thumbnails || []).map(t => ({ platform: t.platform, base64: t.url })),
      itemSpecifics: state.competitor?.itemSpecifics || {},
      competitorItemId: state.competitor?.itemId,
      seoKeywords: state.remake?.seoKeywords || [],
    };

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 180000);   // 3분 timeout (플랫폼 여러 개 병렬)
    try {
      const res = await fetch('/api/ai-workflow/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, platforms, presets }),
        signal: ctrl.signal,
      });
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) data = await res.json();
      else {
        const text = await res.text();
        const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
        throw new Error(`서버 오류 (${res.status}): ${m ? m[1].trim() : text.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.publish = { ...state.publish, results: data.results || [], running: false };
      renderStep4();
    } catch (e) {
      const msg = e.name === 'AbortError' ? '3분 timeout — 서버 응답 없음' : e.message;
      state.publish = { ...state.publish, results: null, running: false };
      renderStep4();
      const st = document.getElementById('wf-step4-status');
      if (st) st.textContent = '에러: ' + msg;
    } finally {
      clearTimeout(to);
    }
  }

  async function runThumbnails() {
    const checks = Array.from(document.querySelectorAll('.wf-img-check')).filter(c => c.checked);
    const urls = (checks.length > 0 ? checks : [document.querySelector('.wf-img-check')].filter(Boolean))
      .map(c => c.dataset.url).filter(Boolean);
    if (urls.length === 0) { alert('이미지를 1장 이상 선택하세요.'); return; }

    const platform = document.getElementById('wf-thumb-platform')?.value || 'alibaba';
    const bgChoice = document.getElementById('wf-thumb-bg')?.value || 'local'; // local/gemini/removebg/none
    const removeBg = bgChoice !== 'none';
    const provider = removeBg ? bgChoice : 'local';
    const btn = document.getElementById('wf-thumb-btn');
    const status = document.getElementById('wf-step3-status');
    if (btn) { btn.disabled = true; btn.textContent = '썸네일 생성 중…'; }
    if (status) status.textContent = `${urls.length}장 ${platform} 썸네일 생성 중 (장당 5~15초)…`;

    try {
      // 1) 선택 URL → blob 다운로드 (한 번에 모음)
      const fd = new FormData();
      let idx = 0;
      for (const url of urls) {
        try {
          const r = await fetch(url);
          const blob = await r.blob();
          const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          fd.append('images', blob, `wf-thumb-${idx++}.${ext}`);
        } catch (_) { /* 한 장 실패해도 계속 */ }
      }
      fd.append('platform', platform);
      fd.append('removeBg', removeBg ? 'true' : 'false');
      fd.append('provider', provider);
      fd.append('outputBg', removeBg ? 'transparent' : 'white');

      // 2) 백엔드 호출 — 한 번에 모든 이미지 처리 (multipart array)
      const res = await fetch('/api/thumbnail/generate', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '썸네일 실패');

      // 3) 응답 파싱 — images:[{ filename, data: 'data:image/...;base64,...', error? }]
      const results = (data.images || [])
        .filter(it => !it.error && it.data)
        .map(it => ({ platform, url: it.data }));
      const failedCount = (data.images || []).filter(it => it.error).length;

      state.thumbnails = results;
      if (status) {
        if (failedCount > 0) {
          status.textContent = `⚠️ ${results.length}/${urls.length} 성공 (${failedCount}건 실패)`;
        } else {
          status.textContent = `✅ ${results.length}장 완료`;
        }
      }
      renderStep3();
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
      if (btn) { btn.disabled = false; btn.textContent = '🖼️ 썸네일 생성'; }
    }
  }

  // ───────────────────────────────────────────────
  window.pmcAIWorkflow = { load, gotoStep, fetchCompetitor, runRemake, runReconstruct, runTemplate, copyHtml, runThumbnails,
    toggleImage, selectAllImages, clearImageSelection,
    runPublish, savePresetsFromUI, suggestEbayCategory, pickEbayCategory,
    importPresetFromListing, checkEbayAspects, runVerify,
    setSourceMode, onFilesPicked, submitFiles };
})();
