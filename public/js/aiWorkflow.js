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
    step: 1,            // 1 / 2 / 3
    competitor: null,   // step 1 fetch 결과: { title, images:[url...], description, ... }
    remake: null,       // step 1 AI 리메이크 결과: { seoTitle, htmlDescription, killPrice, ... }
    reconstruct: null,  // step 2 결과: { htmlDescription, originalImages, lang, mode }
    thumbnails: [],     // step 3 결과: [{ platform, url }]
  };

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
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">1단계 · 경쟁사 상품 가져오기</h3>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
          <input type="text" id="wf-item-id" placeholder="eBay Item ID (9~15자리)" value="${esc(c?.itemId || '')}"
            style="flex:1;min-width:240px;padding:10px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          <button type="button" onclick="pmcAIWorkflow.fetchCompetitor()" id="wf-fetch-btn"
            style="padding:10px 18px;background:#7c4dff;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">가져오기</button>
        </div>
        <div id="wf-step1-status" style="color:#888;font-size:12px;margin-bottom:12px;"></div>

        ${c ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
          <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
            <div style="color:#888;font-size:11px;margin-bottom:4px;">경쟁사 원본 제목</div>
            <div style="color:#fff;font-size:13px;line-height:1.5;">${esc(c.title || '-')}</div>
            <div style="color:#888;font-size:11px;margin-top:8px;">가격: <span style="color:#ffd54f;">$${esc(c.price || '-')}</span></div>
            <div style="color:#888;font-size:11px;">이미지: ${(c.images || []).length}장</div>
          </div>
          <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;">
            <div style="color:#888;font-size:11px;margin-bottom:4px;">이미지 미리보기</div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              ${(c.images || []).slice(0, 6).map(u => `<img src="${esc(u)}" style="width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #333;">`).join('')}
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

  async function fetchCompetitor() {
    const itemId = (document.getElementById('wf-item-id')?.value || '').trim();
    if (!/^\d{9,15}$/.test(itemId)) { alert('eBay Item ID는 9~15자리 숫자여야 합니다'); return; }
    const btn = document.getElementById('wf-fetch-btn');
    const status = document.getElementById('wf-step1-status');
    if (btn) { btn.disabled = true; btn.textContent = '가져오는 중…'; }
    if (status) status.textContent = '경쟁사 페이지 호출 중…';
    try {
      const res = await fetch('/api/remarker/fetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '실패');
      state.competitor = { ...data.item, itemId };
      state.remake = null;
      renderStep1();
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '가져오기'; }
    }
  }

  async function runRemake() {
    if (!state.competitor) return;
    const btn = document.getElementById('wf-remake-btn');
    const status = document.getElementById('wf-step1-status');
    if (btn) { btn.disabled = true; btn.textContent = 'AI 리메이크 중…'; }
    if (status) status.textContent = '제목·설명·킬가 생성 중 (10~30초)…';
    try {
      const res = await fetch('/api/remarker/remake', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitorData: state.competitor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '실패');
      state.remake = data.remake;
      if (status) status.textContent = '';
      renderStep1();
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
    } finally {
      if (btn) { btn.disabled = false; }
    }
  }

  // ───────────────────────────────────────────────
  // STEP 2 — 상세페이지 재구성
  // ───────────────────────────────────────────────
  function renderStep2() {
    const host = document.getElementById('wf-body');
    const r = state.reconstruct;
    const imgs = (state.competitor?.images || []).slice(0, 5);
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:20px;">
        <h3 style="color:#fff;margin:0 0 12px;">2단계 · PMC 브랜드 상세페이지 생성</h3>

        <div style="background:#0f0f23;border:1px solid #2a2a4a;border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="color:#888;font-size:11px;margin-bottom:6px;">1단계에서 인계된 이미지 (자동 사용)</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            ${imgs.map(u => `<img src="${esc(u)}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid #333;">`).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
          <label style="color:#888;font-size:12px;">언어:</label>
          <select id="wf-lang" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="en">English</option>
            <option value="ko">한국어</option>
            <option value="both">English + 한국어</option>
          </select>
          <label style="color:#888;font-size:12px;margin-left:12px;">모드:</label>
          <select id="wf-mode" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
            <option value="standard">표준 (이미지 5장)</option>
            <option value="fast">빠름 (이미지 1장)</option>
          </select>
          <button type="button" onclick="pmcAIWorkflow.runReconstruct()" id="wf-reconstruct-btn"
            style="padding:10px 18px;background:#e94560;border:0;border-radius:6px;color:#fff;cursor:pointer;font-weight:600;">${r ? '🔄 재구성 다시' : '🤖 상세페이지 재구성'}</button>
        </div>
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

  async function runReconstruct() {
    const imgs = (state.competitor?.images || []).slice(0, 5);
    if (imgs.length === 0) { alert('1단계에서 이미지가 없습니다.'); return; }
    const lang = document.getElementById('wf-lang')?.value || 'en';
    const mode = document.getElementById('wf-mode')?.value || 'standard';
    const btn = document.getElementById('wf-reconstruct-btn');
    const status = document.getElementById('wf-step2-status');
    if (btn) { btn.disabled = true; btn.textContent = '재구성 중…'; }
    if (status) status.textContent = '이미지 분석 + 상세페이지 생성 중 (15~60초)…';

    try {
      // 1단계 이미지를 fetch → blob → FormData 로 업로드 (백엔드 multipart 라우트 재사용)
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
      fd.append('htmlContent', state.competitor?.description || '');
      fd.append('lang', lang);
      fd.append('mode', mode);

      const res = await fetch('/api/remarker/reconstruct', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '재구성 실패');
      // 응답 필드: lang='en'/'ko' → description; lang='both' → descriptionEn + descriptionKo
      const htmlDescription = data.lang === 'both'
        ? `${data.descriptionEn || ''}<hr style="margin:32px 0;border:0;border-top:2px dashed #ccc;">${data.descriptionKo || ''}`
        : (data.description || data.descriptionEn || data.descriptionKo || '');
      state.reconstruct = { htmlDescription, raw: data, originalImages: data.originalImages || imgs, lang, mode };
      if (status) status.textContent = '';
      renderStep2();
    } catch (e) {
      if (status) status.textContent = '에러: ' + e.message;
      if (btn) { btn.disabled = false; btn.textContent = '🤖 상세페이지 재구성'; }
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
    const imgs = (state.competitor?.images || []).slice(0, 6);
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
        </div>
      </div>
    `;
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
  window.pmcAIWorkflow = { load, gotoStep, fetchCompetitor, runRemake, runReconstruct, copyHtml, runThumbnails };
})();
