/**
 * CS 지원 (2026-08-08 전면 단순화 리팩토링).
 *
 * 사장님 spec:
 *   한 화면 · 큰 textarea · [AI 분석] 버튼 하나.
 *   결과 = 한국어 뜻 / 바이어 의도 / 추천 대응 / 영어 답장 4블록.
 *   답장 아래 톤 조정 버튼 5개 + 대화형 지시 input.
 *   [처리 완료] 로 cs_responses INSERT (KPI 데이터 축적).
 *
 * 고급 기능 (진상 DB / 결과 입력 / 템플릿 관리 / legacy 답변 작성) 은
 * 우측 상단 [⚙️ 관리] 버튼 → 모달로 접근. 기존 데이터/API/DB 유지.
 * legacy 상세 UI 는 public/js/cs.legacy.js 로 백업, 프론트에선 링크 없음.
 */
(function() {
  let user = null;
  let state = {
    message: '',
    platform: '',
    tone: '',
    memo: '',
    analysis: null,          // csMessageAnalyzer 결과
    suspiciousMatch: null,   // /analyze-message 응답 진상 매칭
    policyHits: [],
    reply: null,             // { reply_text, safety_flags, ... }
    replyLoading: false,
    analyzeLoading: false,
    savedResponseId: null,   // 처리 완료 후 저장된 cs_responses.id
    error: null,             // 최상단 에러 메시지
  };

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  const PLATFORMS = ['eBay', 'Coupang', 'Shopee', 'Alibaba', 'Shopify', 'Naver', '기타'];
  const TONE_OPTIONS = [
    { key: '', label: '자동' },
    { key: 'friendly', label: '친근' },
    { key: 'professional', label: '전문적' },
    { key: 'firm', label: '단호' },
  ];
  const RISK_COLOR = { critical: '#c62828', high: '#e65100', medium: '#f9a825', low: '#2e7d32' };
  const RISK_LABEL = { critical: '심각', high: '높음', medium: '주의', low: '낮음' };

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}))).user;
    if (!user) {
      const el = document.getElementById('page-cs');
      if (el) el.innerHTML = '<div style="padding:24px;color:#ef5350;">로그인이 필요합니다</div>';
      return;
    }
    render();
  }

  function render() {
    const el = document.getElementById('page-cs');
    if (!el) return;
    const manageBtn = user.isAdmin
      ? `<button type="button" onclick="pmcCs.openManageModal()" title="진상 DB / 결과 입력 / 템플릿 관리" style="padding:8px 14px;background:#2a2a4a;border:1px solid #444;border-radius:6px;color:#ccc;cursor:pointer;font-size:12px;">⚙️ 관리</button>`
      : '';
    el.innerHTML = `
      <div style="max-width:900px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <div>
            <h1 style="font-size:22px;color:#fff;margin:0;">💬 CS 지원</h1>
            <p style="color:#888;font-size:12px;margin:4px 0 0 0;">바이어 메시지를 붙여넣으면 AI가 뜻·의도·대응·영어답장을 알려줍니다.</p>
          </div>
          ${manageBtn}
        </div>

        ${state.error ? `<div id="cs-error" style="padding:12px 16px;background:#3a1a1a;border-left:3px solid #ef5350;color:#ffab91;margin-bottom:16px;border-radius:4px;">⚠️ ${esc(state.error)}</div>` : ''}

        <!-- 입력창 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:20px;margin-bottom:14px;">
          <label style="display:block;color:#fff;font-size:14px;font-weight:600;margin-bottom:10px;">
            바이어 메시지를 붙여넣으세요
          </label>
          <textarea id="cs-message" placeholder="예: Hi, I still haven't received my order after 3 weeks. Can you check the tracking? Order #12345"
            style="width:100%;min-height:140px;padding:12px;background:#0f0f1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box;">${esc(state.message)}</textarea>

          <!-- 옵션 (접힘) -->
          <details style="margin-top:10px;">
            <summary style="cursor:pointer;color:#888;font-size:12px;padding:4px 0;user-select:none;">▶ 옵션 (플랫폼/톤/메모)</summary>
            <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:10px;margin-top:10px;">
              <div>
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">플랫폼</label>
                <select id="cs-platform" style="width:100%;padding:6px 8px;background:#0f0f1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
                  <option value="">-</option>
                  ${PLATFORMS.map(p => `<option value="${p}" ${state.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select>
              </div>
              <div>
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">답변 톤</label>
                <select id="cs-tone" style="width:100%;padding:6px 8px;background:#0f0f1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
                  ${TONE_OPTIONS.map(t => `<option value="${t.key}" ${state.tone === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}
                </select>
              </div>
              <div>
                <label style="display:block;color:#aaa;font-size:11px;margin-bottom:4px;">상황 메모 (한국어)</label>
                <input type="text" id="cs-memo" value="${esc(state.memo)}" placeholder="예: 재고 없음, 배송 중 파손"
                  style="width:100%;padding:6px 8px;background:#0f0f1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;box-sizing:border-box;">
              </div>
            </div>
          </details>

          <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;">
            <button type="button" onclick="pmcCs.reset()" style="padding:10px 16px;background:transparent;border:1px solid #444;border-radius:6px;color:#888;cursor:pointer;font-size:13px;">초기화</button>
            <button type="button" id="cs-analyze-btn" onclick="pmcCs.analyze()"
              style="padding:10px 24px;background:${state.analyzeLoading ? '#555' : '#4caf50'};border:0;border-radius:6px;color:#fff;cursor:${state.analyzeLoading ? 'wait' : 'pointer'};font-size:14px;font-weight:700;">
              ${state.analyzeLoading ? '⏳ 분석 중...' : '🔍 AI 분석'}
            </button>
          </div>
        </div>

        <!-- 결과 영역 -->
        <div id="cs-result">${state.analysis ? renderResult() : ''}</div>
      </div>
    `;
    // input 이벤트 바인딩 (state 실시간 반영)
    const msgEl = document.getElementById('cs-message');
    if (msgEl) msgEl.addEventListener('input', e => { state.message = e.target.value; });
    const pfEl = document.getElementById('cs-platform');
    if (pfEl) pfEl.addEventListener('change', e => { state.platform = e.target.value; });
    const toneEl = document.getElementById('cs-tone');
    if (toneEl) toneEl.addEventListener('change', e => { state.tone = e.target.value; });
    const memoEl = document.getElementById('cs-memo');
    if (memoEl) memoEl.addEventListener('input', e => { state.memo = e.target.value; });
  }

  function renderResult() {
    const a = state.analysis;
    if (!a) return '';
    const risk = a.risk_level || 'low';
    const suspicious = state.suspiciousMatch?.primary;
    const suspiciousMatches = state.suspiciousMatch?.matches || [];

    // 진상 경고
    const warningBlock = suspicious ? `
      <div style="padding:12px 16px;background:#3a1a1a;border-left:4px solid #ef5350;border-radius:4px;margin-bottom:14px;">
        <div style="color:#ff8a80;font-weight:700;font-size:13px;">🚨 주의: 진상 바이어 DB 매칭 (${suspiciousMatches.length}건)</div>
        <div style="color:#ffab91;font-size:12px;margin-top:4px;">
          의심도 <b>${esc(suspicious.suspicionLevel || '의심')}</b>
          ${suspicious.patternDescription ? ' · ' + esc(suspicious.patternDescription) : ''}
        </div>
      </div>` : '';

    return `
      ${warningBlock}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
        <!-- A. 한국어 뜻 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:16px;">
          <div style="color:#64b5f6;font-size:11px;font-weight:700;margin-bottom:8px;letter-spacing:0.5px;">A · 한국어 뜻</div>
          <div style="color:#e0e0e0;font-size:14px;line-height:1.6;white-space:pre-wrap;">${esc(a.translated_message_ko || '(번역 결과 없음)')}</div>
        </div>

        <!-- B. 바이어 의도 -->
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:16px;">
          <div style="color:#ba68c8;font-size:11px;font-weight:700;margin-bottom:8px;letter-spacing:0.5px;">B · 바이어 의도</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="padding:3px 10px;background:${RISK_COLOR[risk]};color:#fff;border-radius:10px;font-size:11px;font-weight:700;">위험 ${RISK_LABEL[risk]}</span>
            <span style="color:#fff;font-size:14px;font-weight:600;">${esc(a.customer_intent || '-')}</span>
          </div>
          ${(a.risk_tags || []).length > 0 ? `<div style="margin-top:6px;">${a.risk_tags.map(t => `<span style="display:inline-block;padding:2px 8px;background:#2a2a4a;color:#ffab91;border-radius:8px;font-size:10px;margin-right:4px;margin-bottom:4px;">${esc(t)}</span>`).join('')}</div>` : ''}
          <div style="color:#aaa;font-size:12px;margin-top:8px;font-style:italic;">${esc(a.staff_summary || '')}</div>
        </div>
      </div>

      <!-- C. 추천 대응 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:16px;margin-bottom:14px;">
        <div style="color:#ffa726;font-size:11px;font-weight:700;margin-bottom:8px;letter-spacing:0.5px;">C · 추천 대응</div>
        <div style="color:#e0e0e0;font-size:14px;line-height:1.6;margin-bottom:10px;">${esc(a.recommended_action || '-')}</div>
        ${(a.required_reply_points || []).length > 0 ? `
          <div style="margin-top:8px;">
            <div style="color:#81c784;font-size:11px;font-weight:600;margin-bottom:4px;">✅ 반드시 포함할 점</div>
            <ul style="margin:0;padding-left:20px;color:#c8e6c9;font-size:12px;line-height:1.6;">
              ${a.required_reply_points.map(p => `<li>${esc(p)}</li>`).join('')}
            </ul>
          </div>` : ''}
        ${(a.forbidden_reply_points || []).length > 0 ? `
          <div style="margin-top:8px;">
            <div style="color:#ef9a9a;font-size:11px;font-weight:600;margin-bottom:4px;">🚫 피할 점</div>
            <ul style="margin:0;padding-left:20px;color:#ffcdd2;font-size:12px;line-height:1.6;">
              ${a.forbidden_reply_points.map(p => `<li>${esc(p)}</li>`).join('')}
            </ul>
          </div>` : ''}
      </div>

      <!-- D. 영어 답장 -->
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:8px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="color:#4dd0e1;font-size:11px;font-weight:700;letter-spacing:0.5px;">D · 영어 답장</div>
          ${state.reply?.tone ? `<span style="color:#888;font-size:10px;">tone: ${esc(state.reply.tone)}${state.reply.mock ? ' · mock' : ''}</span>` : ''}
        </div>
        <div id="cs-reply-area">${renderReplyArea()}</div>
      </div>

      <!-- 처리 완료 -->
      ${state.reply?.reply_text ? renderFooter() : ''}
    `;
  }

  function renderReplyArea() {
    if (!state.analysis) return '';
    if (state.replyLoading) {
      return `<div style="padding:24px;text-align:center;color:#888;">⏳ 영어 답장 생성 중...</div>`;
    }
    if (!state.reply?.reply_text) {
      // 자동 생성 트리거는 analyze 완료 시 이미 걸림 — 이 상태는 실패 케이스
      return `<div style="padding:16px;background:#0f0f1e;border:1px solid #333;border-radius:6px;color:#888;font-size:12px;">영어 답장이 아직 생성되지 않았습니다. <button type="button" onclick="pmcCs.generateReply()" style="margin-left:6px;padding:4px 10px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">지금 생성</button></div>`;
    }
    return `
      <textarea id="cs-reply-text" style="width:100%;min-height:180px;padding:12px;background:#0f0f1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;font-family:'SF Mono',Menlo,monospace;line-height:1.6;resize:vertical;box-sizing:border-box;">${esc(state.reply.reply_text)}</textarea>

      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
        <button type="button" onclick="pmcCs.copyReply()" style="padding:7px 14px;background:#1976d2;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">📋 복사</button>
        <button type="button" onclick="pmcCs.refineReply('polite')" style="padding:7px 12px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#e0e0e0;cursor:pointer;font-size:12px;">🎩 더 정중하게</button>
        <button type="button" onclick="pmcCs.refineReply('firm')" style="padding:7px 12px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#e0e0e0;cursor:pointer;font-size:12px;">🔥 더 단호하게</button>
        <button type="button" onclick="pmcCs.refineReply('shorter')" style="padding:7px 12px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#e0e0e0;cursor:pointer;font-size:12px;">✂️ 더 짧게</button>
        <button type="button" onclick="pmcCs.refineReply('friendly')" style="padding:7px 12px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#e0e0e0;cursor:pointer;font-size:12px;">😊 더 친근하게</button>
        <button type="button" onclick="pmcCs.refineReply('regenerate')" style="padding:7px 12px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#e0e0e0;cursor:pointer;font-size:12px;">🔄 다시 생성</button>
      </div>

      <!-- 대화형 지시 -->
      <div style="margin-top:12px;padding:10px 12px;background:#0f0f1e;border:1px dashed #444;border-radius:6px;">
        <div style="color:#888;font-size:11px;margin-bottom:6px;">💬 추가 지시 (예: "환불은 안된다고 해줘", "배송조회번호 넣어서")</div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="cs-refine-input" placeholder="원하는 방향을 짧게 입력하고 엔터"
            onkeydown="if(event.key==='Enter'){pmcCs.refineReply('custom')}"
            style="flex:1;padding:8px 10px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
          <button type="button" onclick="pmcCs.refineReply('custom')" style="padding:8px 14px;background:#7e57c2;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">지시 반영</button>
        </div>
      </div>
    `;
  }

  function renderFooter() {
    if (state.savedResponseId) {
      return `
        <div style="text-align:center;padding:12px;background:#0f2a1a;border-left:3px solid #4caf50;border-radius:4px;color:#81c784;font-size:13px;">
          ✅ 처리 완료 저장됨 · cs_responses #${state.savedResponseId}
        </div>`;
    }
    return `
      <div style="display:flex;justify-content:center;">
        <button type="button" onclick="pmcCs.markComplete()" style="padding:12px 32px;background:#43a047;border:0;border-radius:6px;color:#fff;cursor:pointer;font-size:14px;font-weight:700;">
          ✅ 처리 완료 (KPI 저장)
        </button>
      </div>
    `;
  }

  function updateReplyArea() {
    const el = document.getElementById('cs-reply-area');
    if (el) el.innerHTML = renderReplyArea();
  }

  function updateResult() {
    const el = document.getElementById('cs-result');
    if (el) el.innerHTML = state.analysis ? renderResult() : '';
  }

  function updateError() {
    render(); // 간단히 전체 재렌더링 (state 만 유지)
  }

  // ═══════════════════════════════════════════════════════════════
  // 액션
  // ═══════════════════════════════════════════════════════════════

  async function analyze() {
    const msgEl = document.getElementById('cs-message');
    const text = (msgEl?.value || '').trim();
    if (!text) { alert('바이어 메시지를 입력하세요'); return; }

    state.message = text;
    state.analysis = null;
    state.reply = null;
    state.savedResponseId = null;
    state.error = null;
    state.analyzeLoading = true;
    render();

    try {
      const res = await fetch('/api/cs/analyze-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `분석 실패 (HTTP ${res.status})`);
      state.analysis = j.analysis;
      state.policyHits = j.policyHits || [];
      state.suspiciousMatch = j.suspiciousMatch || null;
      state.analyzeLoading = false;
      render();
      // 자동으로 영어 답장 생성 시작
      await generateReply();
    } catch (e) {
      state.error = 'AI 분석 실패: ' + (e.message || 'unknown error') + ' — 다시 시도해주세요.';
      state.analyzeLoading = false;
      render();
    }
  }

  async function generateReply({ previousReply, refinementInstruction } = {}) {
    if (!state.analysis) return;
    state.replyLoading = true;
    updateReplyArea();

    const body = {
      analysis: state.analysis,
      koreanDraft: state.memo || '',
      tone: state.tone || undefined,
      force: true,
    };
    if (previousReply) body.previousReply = previousReply;
    if (refinementInstruction) body.refinementInstruction = refinementInstruction;

    try {
      const res = await fetch('/api/cs/generate-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `답장 생성 실패 (HTTP ${res.status})`);
      state.reply = j;
      state.replyLoading = false;
      updateResult();
    } catch (e) {
      state.reply = null;
      state.replyLoading = false;
      state.error = 'AI 답장 생성 실패: ' + (e.message || 'unknown error');
      render();
    }
  }

  async function refineReply(kind) {
    const currentEl = document.getElementById('cs-reply-text');
    const currentText = currentEl?.value || state.reply?.reply_text || '';
    if (!currentText && kind !== 'regenerate') { alert('먼저 답장을 생성하세요'); return; }

    if (kind === 'regenerate') {
      // 이전 답변 무시하고 처음부터 다시
      await generateReply();
      return;
    }
    if (kind === 'custom') {
      const input = document.getElementById('cs-refine-input');
      const instr = (input?.value || '').trim();
      if (!instr) { alert('추가 지시를 입력하세요'); return; }
      await generateReply({ previousReply: currentText, refinementInstruction: instr });
      if (input) input.value = '';
      return;
    }
    // 프리셋 5종 → tone/지시 매핑
    const map = {
      polite:   { tone: 'friendly',     instr: '더 정중하고 공손한 어조로 다시 작성해주세요.' },
      firm:     { tone: 'firm',         instr: '더 단호하고 확실한 어조로 다시 작성해주세요. 저자세 표현 제거.' },
      shorter:  { tone: state.reply?.tone || undefined, instr: '핵심만 남기고 30~50% 더 짧게 요약해주세요.' },
      friendly: { tone: 'friendly',     instr: '더 친근하고 따뜻한 어조로 다시 작성해주세요.' },
    };
    const preset = map[kind];
    if (!preset) return;
    if (preset.tone) state.tone = preset.tone;
    await generateReply({ previousReply: currentText, refinementInstruction: preset.instr });
  }

  async function copyReply() {
    const el = document.getElementById('cs-reply-text');
    const text = el?.value || state.reply?.reply_text || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = event.target;
      const orig = btn.textContent;
      btn.textContent = '✓ 복사됨';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch { alert('복사 실패'); }
  }

  async function markComplete() {
    if (!state.analysis || !state.reply?.reply_text) return;
    const finalText = document.getElementById('cs-reply-text')?.value || state.reply.reply_text;

    try {
      const res = await fetch('/api/cs/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerMessage:  state.message,
          detectedCategory: state.analysis.customer_intent || null,
          buyerPlatform:    state.platform || null,
          finalResponseText: finalText,
          aiToneAdjusted:   true, // 워크스페이스 답장은 항상 AI 생성
          suspiciousBuyerId: state.suspiciousMatch?.primary?.id || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `저장 실패 (HTTP ${res.status})`);
      state.savedResponseId = j.data?.id;
      updateResult();
    } catch (e) {
      alert('처리 완료 저장 실패: ' + e.message);
    }
  }

  function reset() {
    state = { message: '', platform: '', tone: '', memo: '', analysis: null, suspiciousMatch: null, policyHits: [], reply: null, replyLoading: false, analyzeLoading: false, savedResponseId: null, error: null };
    render();
  }

  // ═══════════════════════════════════════════════════════════════
  // 관리 모달 (admin only) — 진상 DB / 결과 입력 / 템플릿 관리 링크
  // 각 기능은 별도 route (/api/cs/suspicious-buyers, /api/cs/responses,
  // /api/cs/templates) 로 그대로 존재. 여기선 얇은 shell 만 제공.
  // ═══════════════════════════════════════════════════════════════

  let manageState = { tab: 'suspicious', suspicious: [], responses: [], templates: [] };

  async function openManageModal() {
    // 오버레이 생성
    let overlay = document.getElementById('cs-manage-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cs-manage-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto;';
      overlay.addEventListener('click', e => { if (e.target === overlay) closeManageModal(); });
      document.body.appendChild(overlay);
    }
    renderManageModal();
    await loadManageTab(manageState.tab);
  }

  function closeManageModal() {
    const o = document.getElementById('cs-manage-overlay');
    if (o) o.remove();
  }

  function renderManageModal() {
    const overlay = document.getElementById('cs-manage-overlay');
    if (!overlay) return;
    const tabs = [
      { key: 'suspicious', label: '🚩 진상 바이어 DB' },
      { key: 'results',    label: '📝 결과 입력 대기' },
      { key: 'templates',  label: '⚙️ 템플릿 관리' },
    ];
    overlay.innerHTML = `
      <div style="width:100%;max-width:1000px;background:#1a1a2e;border:1px solid #333;border-radius:10px;padding:20px;color:#fff;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="margin:0;font-size:18px;color:#fff;">⚙️ CS 관리</h2>
          <button type="button" onclick="pmcCs.closeManageModal()" style="padding:6px 12px;background:transparent;border:1px solid #444;border-radius:4px;color:#aaa;cursor:pointer;font-size:12px;">✕ 닫기</button>
        </div>
        <div style="display:flex;gap:4px;border-bottom:1px solid #2a2a4a;margin-bottom:14px;">
          ${tabs.map(t => `
            <button type="button" onclick="pmcCs.switchManageTab('${t.key}')"
              style="padding:8px 14px;background:transparent;border:0;border-bottom:2px solid ${manageState.tab === t.key ? '#ffd54f' : 'transparent'};color:${manageState.tab === t.key ? '#ffd54f' : '#888'};cursor:pointer;font-size:12px;font-weight:${manageState.tab === t.key ? '700' : '400'};">
              ${t.label}
            </button>
          `).join('')}
        </div>
        <div id="cs-manage-body" style="min-height:400px;">로딩...</div>
      </div>
    `;
  }

  async function switchManageTab(key) {
    manageState.tab = key;
    renderManageModal();
    await loadManageTab(key);
  }

  async function loadManageTab(key) {
    const body = document.getElementById('cs-manage-body');
    if (!body) return;
    try {
      if (key === 'suspicious') {
        const r = await fetch('/api/cs/suspicious-buyers?limit=100');
        const j = await r.json();
        manageState.suspicious = j.data || [];
        body.innerHTML = renderSuspiciousList();
      } else if (key === 'results') {
        const r = await fetch('/api/cs/responses?needsResultOnly=true&limit=100');
        const j = await r.json();
        manageState.responses = j.data || [];
        body.innerHTML = renderResponsesList();
      } else if (key === 'templates') {
        const r = await fetch('/api/cs/templates');
        const j = await r.json();
        manageState.templates = j.data || [];
        body.innerHTML = renderTemplatesList();
      }
    } catch (e) {
      body.innerHTML = `<div style="color:#ef5350;padding:20px;">로드 실패: ${esc(e.message)}</div>`;
    }
  }

  function renderSuspiciousList() {
    const list = manageState.suspicious;
    if (!list.length) return `<div style="color:#888;padding:20px;text-align:center;">진상 바이어 없음</div>`;
    return `
      <div style="max-height:60vh;overflow-y:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:1px solid #333;color:#888;">
              <th style="text-align:left;padding:8px;">이름</th>
              <th style="text-align:left;padding:8px;">이메일</th>
              <th style="text-align:left;padding:8px;">의심도</th>
              <th style="text-align:left;padding:8px;">패턴</th>
              <th style="text-align:left;padding:8px;">등록</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(b => `
              <tr style="border-bottom:1px solid #222;">
                <td style="padding:8px;">${esc(b.realName || '-')}</td>
                <td style="padding:8px;color:#aaa;">${esc(b.email || '-')}</td>
                <td style="padding:8px;"><span style="padding:2px 8px;background:#3a1a1a;color:#ff8a80;border-radius:8px;font-size:10px;">${esc(b.suspicionLevel || '의심')}</span></td>
                <td style="padding:8px;color:#ccc;font-size:11px;">${esc((b.patternDescription || '').slice(0, 60))}</td>
                <td style="padding:8px;color:#666;font-size:10px;">${esc((b.createdAt || '').slice(0, 10))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p style="color:#666;font-size:11px;margin-top:10px;">진상 등록은 워크스페이스 분석 결과 화면에서 처리 완료 후 유도됩니다. 이곳은 조회 전용입니다.</p>
    `;
  }

  function renderResponsesList() {
    const list = manageState.responses;
    if (!list.length) return `<div style="color:#888;padding:20px;text-align:center;">결과 입력 대기 응답 없음</div>`;
    const opts = ['converted','repurchased','positive_review','refunded','case_opened','confirmed_fraud','blocked'];
    return `
      <div style="max-height:60vh;overflow-y:auto;">
        ${list.map(r => `
          <div style="padding:12px;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:10px;">
            <div style="color:#888;font-size:11px;margin-bottom:4px;">#${r.id} · ${esc((r.createdAt || '').slice(0, 16))} · ${esc(r.detectedCategory || '-')}</div>
            <div style="color:#ccc;font-size:12px;margin-bottom:6px;">${esc((r.customerMessage || '').slice(0, 200))}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
              ${opts.map(o => `<button type="button" onclick="pmcCs.setResult(${r.id}, '${o}')" style="padding:4px 10px;background:#2a2a4a;border:1px solid #444;border-radius:4px;color:#ccc;cursor:pointer;font-size:11px;">${o}</button>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function setResult(id, resultStatus) {
    try {
      const r = await fetch(`/api/cs/responses/${id}/result-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resultStatus }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      await loadManageTab('results');
    } catch (e) { alert('결과 설정 실패: ' + e.message); }
  }

  function renderTemplatesList() {
    const list = manageState.templates;
    return `
      <div style="margin-bottom:12px;">
        <button type="button" onclick="pmcCs.createTemplate()" style="padding:8px 14px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">+ 템플릿 추가</button>
      </div>
      <div style="max-height:60vh;overflow-y:auto;">
        ${list.length === 0 ? '<div style="color:#888;padding:20px;text-align:center;">템플릿 없음</div>' : list.map(t => `
          <div style="padding:12px;border:1px solid #2a2a4a;border-radius:6px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;">
              <div style="color:#fff;font-weight:600;">${esc(t.title)} <span style="color:#666;font-size:11px;font-weight:400;">· ${esc(t.language)} / ${esc(t.category)} · 사용 ${t.usageCount || 0}회</span></div>
              <div>
                <button type="button" onclick="pmcCs.editTemplate(${t.id})" style="padding:3px 8px;background:transparent;border:1px solid #444;border-radius:3px;color:#aaa;cursor:pointer;font-size:10px;">수정</button>
                <button type="button" onclick="pmcCs.deleteTemplate(${t.id})" style="padding:3px 8px;background:transparent;border:1px solid #a44;border-radius:3px;color:#ef5350;cursor:pointer;font-size:10px;margin-left:4px;">삭제</button>
              </div>
            </div>
            <div style="color:#aaa;font-size:11px;margin-top:6px;white-space:pre-wrap;">${esc((t.body || '').slice(0, 200))}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  async function createTemplate() {
    const title = prompt('제목?');
    if (!title) return;
    const language = prompt('언어? (en/ko/ja/zh)', 'en') || 'en';
    const category = prompt('카테고리? (shipping/refund/stock/thanks/complaint/pre_purchase/general)', 'general') || 'general';
    const body = prompt('본문? ({placeholder} 사용 가능)') || '';
    try {
      const r = await fetch('/api/cs/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, language, category, body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      await loadManageTab('templates');
    } catch (e) { alert('추가 실패: ' + e.message); }
  }

  async function editTemplate(id) {
    const t = manageState.templates.find(x => x.id === id);
    if (!t) return;
    const title = prompt('제목?', t.title);
    if (title == null) return;
    const body = prompt('본문?', t.body || '');
    if (body == null) return;
    try {
      const r = await fetch(`/api/cs/templates/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      await loadManageTab('templates');
    } catch (e) { alert('수정 실패: ' + e.message); }
  }

  async function deleteTemplate(id) {
    if (!confirm('삭제할까요?')) return;
    try {
      const r = await fetch(`/api/cs/templates/${id}`, { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
      await loadManageTab('templates');
    } catch (e) { alert('삭제 실패: ' + e.message); }
  }

  window.pmcCs = {
    load,
    analyze,
    generateReply,
    refineReply,
    copyReply,
    markComplete,
    reset,
    openManageModal,
    closeManageModal,
    switchManageTab,
    setResult,
    createTemplate,
    editTemplate,
    deleteTemplate,
  };
})();
