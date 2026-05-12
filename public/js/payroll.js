/**
 * 급여 요약 + 2주 급여 확정 (W-G2-F) — admin 전용
 */
(function() {
  let user = null;
  let viewMode = 'summary';   // 'summary' | 'periods'
  let periodsList = [];
  let nextSuggestedStart = null;
  let currentPreview = null;  // POST /preview 결과 캐시

  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}`; }
  function money(n) { if (n == null) return '-'; return Number(n).toLocaleString('ko-KR') + '원'; }
  function fmtDate(s) { return s ? String(s).slice(0, 10) : '-'; }
  function fmtDt(s) { if (!s) return '-'; const d = new Date(s); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  async function load() {
    if (!user) user = window.__pmcUser || (await fetch('/api/auth/me').then(r=>r.json())).user;
    if (!user || !user.isAdmin) {
      document.getElementById('page-payroll').innerHTML = '<div style="padding:40px;color:#888;">관리자 전용 페이지입니다.</div>';
      return;
    }
    renderShell();
    await refresh();
  }

  function renderShell() {
    const el = document.getElementById('page-payroll');
    el.innerHTML = `
      <div style="margin-bottom:12px;">
        <h1 style="font-size:22px;color:#fff;">💰 급여 관리</h1>
        <p style="color:#888;font-size:13px;">월별 요약 · 2주 단위 확정 · 주휴수당 · 지출 자동 연동</p>
      </div>

      <div style="display:flex;gap:4px;margin-bottom:14px;border-bottom:1px solid #2a2a4a;">
        <button id="pay-tab-summary" onclick="pmcPayroll.switchView('summary')" style="padding:8px 16px;background:transparent;border:0;border-bottom:2px solid #7c4dff;color:#fff;cursor:pointer;font-weight:600;font-size:13px;">📊 월별 요약</button>
        <button id="pay-tab-periods" onclick="pmcPayroll.switchView('periods')" style="padding:8px 16px;background:transparent;border:0;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:13px;">📅 2주 급여 확정</button>
      </div>

      <div id="pay-view-summary">
        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
          <div>
            <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">월</label>
            <input type="month" id="pay-month" value="${currentMonth()}" style="padding:8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#fff;">
          </div>
          <div style="flex:1;text-align:right;">
            <div style="font-size:12px;color:#888;">이 달 총 지급액</div>
            <div id="grand-total" style="font-size:24px;font-weight:700;color:#fff;">-</div>
          </div>
        </div>

        <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:auto;">
          <table style="width:100%;border-collapse:collapse;color:#fff;font-size:13px;">
            <thead>
              <tr style="background:#0f0f23;">
                <th style="padding:10px;text-align:left;">이름</th>
                <th style="padding:10px;text-align:left;">담당</th>
                <th style="padding:10px;text-align:right;">시급</th>
                <th style="padding:10px;text-align:center;">근무일</th>
                <th style="padding:10px;text-align:center;">총시간</th>
                <th style="padding:10px;text-align:center;" title="지각/조퇴/결근/휴무">근태</th>
                <th style="padding:10px;text-align:right;">기본급</th>
                <th style="padding:10px;text-align:center;">상여/인센티브</th>
                <th style="padding:10px;text-align:right;">총 지급액</th>
              </tr>
            </thead>
            <tbody id="pay-tbody"></tbody>
          </table>
        </div>
      </div>

      <div id="pay-view-periods" style="display:none;"></div>
    `;
    document.getElementById('pay-month').addEventListener('change', refresh);
  }

  function switchView(v) {
    viewMode = v;
    const setActive = (id, on) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.color = on ? '#fff' : '#888';
      el.style.fontWeight = on ? '600' : '400';
      el.style.borderBottom = on ? '2px solid #7c4dff' : '2px solid transparent';
    };
    setActive('pay-tab-summary', v === 'summary');
    setActive('pay-tab-periods', v === 'periods');
    document.getElementById('pay-view-summary').style.display = v === 'summary' ? '' : 'none';
    document.getElementById('pay-view-periods').style.display = v === 'periods' ? '' : 'none';
    if (v === 'periods') loadPeriods();
  }

  async function refresh() {
    const month = document.getElementById('pay-month').value;
    if (!month) return;
    const res = await fetch(`/api/payroll/summary?month=${month}`);
    if (!res.ok) { alert((await res.json()).error || '조회 실패'); return; }
    const { summary, grandTotal } = await res.json();

    document.getElementById('grand-total').textContent = money(grandTotal);
    const tbody = document.getElementById('pay-tbody');

    // 모든 직원에게 상여/인센티브 입력 UI 제공 (bonus_amount 직접 입력)
    const enriched = await Promise.all(summary.map(async s => {
      let bonusInput = null;
      const r = await fetch(`/api/bonuses/${s.id}`);
      if (r.ok) {
        const { data } = await r.json();
        const cur = (data || []).find(b => b.month === month);
        if (cur) bonusInput = Number(cur.bonus_amount);
      }
      return { ...s, bonusInput };
    }));

    tbody.innerHTML = enriched.map(s => {
      const badges = [];
      if (s.late > 0) badges.push(`<span title="지각" style="padding:1px 5px;background:#ff9800;color:#fff;border-radius:6px;font-size:10px;">⏰${s.late}</span>`);
      if (s.earlyLeave > 0) badges.push(`<span title="조퇴" style="padding:1px 5px;background:#ffa726;color:#fff;border-radius:6px;font-size:10px;">🏃${s.earlyLeave}</span>`);
      if (s.absence > 0) badges.push(`<span title="결근" style="padding:1px 5px;background:#e94560;color:#fff;border-radius:6px;font-size:10px;">❌${s.absence}</span>`);
      if (s.dayOff > 0) badges.push(`<span title="휴무" style="padding:1px 5px;background:#0288d1;color:#fff;border-radius:6px;font-size:10px;">🌴${s.dayOff}</span>`);
      const attCell = badges.length ? badges.join(' ') : '<span style="color:#555;">-</span>';
      return `
      <tr style="border-bottom:1px solid #2a2a4a;">
        <td style="padding:10px;"><strong>${esc(s.displayName)}</strong></td>
        <td style="padding:10px;color:#aaa;font-size:12px;">${esc(s.platform || '-')}</td>
        <td style="padding:10px;text-align:right;">${money(s.hourlyRate)}</td>
        <td style="padding:10px;text-align:center;">${s.workDays}일</td>
        <td style="padding:10px;text-align:center;">${s.totalHours.toFixed(2)}h</td>
        <td style="padding:10px;text-align:center;white-space:nowrap;">${attCell}</td>
        <td style="padding:10px;text-align:right;">${money(s.basePay)}</td>
        <td style="padding:10px;text-align:center;">
          <div style="display:flex;gap:4px;align-items:center;justify-content:center;">
            <input type="number" value="${s.bonusInput || ''}" placeholder="금액" id="bonus-${s.id}" style="width:120px;padding:6px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
            <button onclick="pmcPayroll.saveBonus(${s.id})" style="padding:6px 10px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">✓</button>
          </div>
        </td>
        <td style="padding:10px;text-align:right;font-weight:700;">${money(s.totalPay)}</td>
      </tr>
    `;
    }).join('');
  }

  async function saveBonus(employeeId) {
    const month = document.getElementById('pay-month').value;
    const input = document.getElementById('bonus-' + employeeId);
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount < 0) { alert('상여 금액을 입력하세요.'); return; }
    const res = await fetch('/api/bonuses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, month, bonusAmount: amount }),
    });
    if (!res.ok) { alert((await res.json()).error || '실패'); return; }
    refresh();
  }

  // ── PR W-G2-F: 2주 급여 확정 ──

  async function loadPeriods() {
    const host = document.getElementById('pay-view-periods');
    if (!host) return;
    host.innerHTML = '<div style="padding:20px;color:#888;text-align:center;">로딩 중...</div>';
    try {
      const r = await fetch('/api/payroll/periods?limit=20');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      periodsList = j.data || [];
      nextSuggestedStart = j.nextSuggestedStart || _suggestNextMonday();
      _renderPeriodsView();
    } catch (e) {
      host.innerHTML = `<div style="padding:20px;color:#ff8a80;">실패: ${esc(e.message)}</div>`;
    }
  }

  function _suggestNextMonday() {
    const d = new Date();
    const dow = d.getDay();   // 0=Sun, 1=Mon
    const offset = dow === 0 ? 1 : (8 - dow);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  function _addDays(yyyymmdd, days) {
    const d = new Date(yyyymmdd + 'T12:00:00+09:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function _renderPeriodsView() {
    const host = document.getElementById('pay-view-periods');
    if (!host) return;
    const start = nextSuggestedStart;
    const end = start ? _addDays(start, 13) : '';
    const pay = end ? _addDays(end, 5) : '';   // 지급일 기본값 = 종료 + 5일
    host.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:16px;margin-bottom:14px;">
        <h3 style="color:#fff;font-size:14px;margin:0 0 10px;">📅 새 2주 기간 확정</h3>
        <p style="color:#888;font-size:11px;margin:0 0 10px;">시작일은 <strong style="color:#ffb74d;">월요일</strong> 만 가능 (KST 기준). 13일 후가 종료일 (일요일).</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;align-items:end;">
          <div>
            <label style="font-size:11px;color:#aaa;display:block;margin-bottom:3px;">시작일 (월요일)</label>
            <input type="date" id="pp-start" value="${esc(start)}" oninput="pmcPayroll._onStartChange()" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
          </div>
          <div>
            <label style="font-size:11px;color:#aaa;display:block;margin-bottom:3px;">종료일 (자동)</label>
            <input type="date" id="pp-end" value="${esc(end)}" readonly style="width:100%;padding:7px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#aaa;font-size:12px;">
          </div>
          <div>
            <label style="font-size:11px;color:#aaa;display:block;margin-bottom:3px;">지급일</label>
            <input type="date" id="pp-pay" value="${esc(pay)}" style="width:100%;padding:7px;background:#0f0f23;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;">
          </div>
          <div style="display:flex;gap:6px;">
            <button onclick="pmcPayroll.previewPeriod()" style="flex:1;padding:8px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🔍 미리보기</button>
          </div>
        </div>
        <div id="pp-msg" style="margin-top:6px;color:#888;font-size:11px;"></div>
      </div>

      <div style="background:#1a1a2e;border:1px solid #2a2a4a;border-radius:12px;padding:0;overflow:hidden;">
        <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;">
          <h3 style="color:#fff;font-size:14px;margin:0;">📋 기간 목록 (${periodsList.length}건)</h3>
        </div>
        <div id="pp-list">
          ${periodsList.length === 0
            ? '<div style="padding:30px;color:#666;text-align:center;font-size:12px;">아직 확정된 기간이 없습니다.</div>'
            : periodsList.map(_renderPeriodRow).join('')}
        </div>
      </div>
    `;
  }

  function _onStartChange() {
    const start = document.getElementById('pp-start').value;
    const end = document.getElementById('pp-end');
    const pay = document.getElementById('pp-pay');
    if (start && end) {
      const e = _addDays(start, 13);
      end.value = e;
      if (pay) pay.value = _addDays(e, 5);
    }
  }

  function _renderPeriodRow(p) {
    const statusColor = p.status === '확정됨' ? '#1565c0' : p.status === '지급완료' ? '#4caf50' : '#888';
    return `
      <div style="padding:10px 14px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:240px;">
          <div style="color:#fff;font-size:13px;font-weight:600;">
            ${esc(fmtDate(p.startDate))} ~ ${esc(fmtDate(p.endDate))}
            <span style="margin-left:6px;padding:2px 8px;background:${statusColor};color:#fff;border-radius:8px;font-size:10px;">${esc(p.status)}</span>
          </div>
          <div style="color:#888;font-size:11px;margin-top:3px;">
            지급일 ${esc(fmtDate(p.paymentDate))} · 총액 <strong style="color:#81c784;">${money(p.totalAmount)}</strong>
            ${p.confirmedAt ? ` · 확정 ${fmtDt(p.confirmedAt)}` : ''}
            ${p.paidAt ? ` · 지급 ${fmtDt(p.paidAt)}` : ''}
            ${p.expenseItemId ? ` · 💸 expense#${p.expenseItemId}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="pmcPayroll.viewPeriod(${p.id})" style="padding:5px 12px;background:#2a4a6a;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">상세</button>
          ${p.status === '확정됨' ? `<button onclick="pmcPayroll.markPaid(${p.id})" style="padding:5px 12px;background:#4caf50;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">💰 지급완료</button>` : ''}
          ${p.status !== '계산중' ? `<button onclick="pmcPayroll.cancelPeriod(${p.id})" style="padding:5px 12px;background:#e94560;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;">↶ 취소</button>` : ''}
        </div>
      </div>
    `;
  }

  // ── 미리보기 + 확정 ──
  async function previewPeriod() {
    const startDate = document.getElementById('pp-start').value;
    const endDate = document.getElementById('pp-end').value;
    const paymentDate = document.getElementById('pp-pay').value;
    const msg = document.getElementById('pp-msg');
    if (!startDate || !endDate || !paymentDate) {
      msg.style.color = '#ff8a80'; msg.textContent = '시작일/종료일/지급일 모두 입력';
      return;
    }
    msg.style.color = '#888'; msg.textContent = '미리보기 계산 중...';
    try {
      const r = await fetch('/api/payroll/periods/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate }),
      });
      const j = await r.json();
      if (!r.ok) {
        msg.style.color = '#ff8a80'; msg.textContent = '실패: ' + (j.error || r.status);
        return;
      }
      currentPreview = { ...j, paymentDate };
      _openPreviewModal();
    } catch (e) {
      msg.style.color = '#ff8a80'; msg.textContent = '실패: ' + e.message;
    }
  }

  function _openPreviewModal() {
    const p = currentPreview;
    if (!p) return;
    const m = _modal('payroll-preview-modal', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h3 style="color:#fff;font-size:16px;margin:0;">🔍 ${esc(p.startDate)} ~ ${esc(p.endDate)} 미리보기</h3>
        <button onclick="document.getElementById('payroll-preview-modal').remove()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:14px;">✕</button>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px;">
        <div style="padding:8px 10px;background:#0f0f23;border-radius:6px;text-align:center;">
          <div style="color:#888;font-size:10px;">기록 수</div>
          <div style="color:#fff;font-size:16px;font-weight:700;">${p.recordCount}</div>
        </div>
        <div style="padding:8px 10px;background:${p.anomalies.length > 0 ? '#3a2a1a' : '#0f0f23'};border-radius:6px;text-align:center;">
          <div style="color:#888;font-size:10px;">이상 데이터</div>
          <div style="color:${p.anomalies.length > 0 ? '#ffb74d' : '#fff'};font-size:16px;font-weight:700;">${p.anomalies.length}</div>
        </div>
        <div style="padding:8px 10px;background:${p.nullSnapshots.length > 0 ? '#3a1a1a' : '#0f0f23'};border-radius:6px;text-align:center;">
          <div style="color:#888;font-size:10px;">시급 미등록</div>
          <div style="color:${p.nullSnapshots.length > 0 ? '#ff8a80' : '#fff'};font-size:16px;font-weight:700;">${p.nullSnapshots.length}</div>
        </div>
        <div style="padding:8px 10px;background:#0f0f23;border-radius:6px;text-align:center;">
          <div style="color:#888;font-size:10px;">예상 총액</div>
          <div style="color:#81c784;font-size:16px;font-weight:700;">${money(p.totalAmount)}</div>
        </div>
      </div>

      ${p.nullSnapshots.length > 0 ? `
        <div style="padding:8px 10px;background:#3a1a1a;border-left:3px solid #e94560;border-radius:4px;color:#ff8a80;font-size:12px;margin-bottom:10px;">
          ⚠️ <strong>시급 NULL 기록 ${p.nullSnapshots.length}건</strong> — 확정 차단됨. 출퇴근 화면 → "🔄 시급 없는 기록 재계산" 먼저 실행 필요.
        </div>
      ` : ''}

      ${p.anomalies.length > 0 ? `
        <div style="padding:8px 10px;background:#3a2a1a;border-left:3px solid #ff9800;border-radius:4px;color:#ffb74d;font-size:12px;margin-bottom:10px;">
          ⚠️ <strong>이상 데이터 ${p.anomalies.length}건</strong> — 확정 시 "무시하고 진행" 옵션. 출퇴근 화면에서 먼저 검토 권장.
          <details style="margin-top:6px;"><summary style="cursor:pointer;color:#ffb74d;">상세 보기</summary>
            <div style="max-height:120px;overflow:auto;margin-top:4px;font-size:11px;color:#ddd;">
              ${p.anomalies.map(a => `<div>${esc(a.type)} · emp#${a.employeeId} · ${esc(a.date)}${a.value != null ? ' · ' + a.value + 'h' : ''}</div>`).join('')}
            </div>
          </details>
        </div>
      ` : ''}

      <h4 style="color:#fff;font-size:13px;margin:10px 0 6px;">직원별 정산 (${p.perEmployee.length}명)</h4>
      <div style="background:#0f0f23;border-radius:6px;overflow:auto;max-height:280px;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;color:#fff;">
          <thead><tr style="background:#1a1a2e;"><th style="padding:6px 8px;text-align:left;">직원</th><th style="padding:6px;text-align:right;">시간</th><th style="padding:6px;text-align:right;">일수</th><th style="padding:6px;text-align:right;">기본급</th><th style="padding:6px;text-align:right;">주휴</th><th style="padding:6px;text-align:right;">합계</th></tr></thead>
          <tbody>
            ${p.perEmployee.map(ep => `
              <tr style="border-bottom:1px solid #1a1a2e;">
                <td style="padding:5px 8px;">${esc(ep.employee_name)}</td>
                <td style="padding:5px;text-align:right;color:#aaa;">${ep.total_work_hours}h</td>
                <td style="padding:5px;text-align:right;color:#aaa;">${ep.work_days}일</td>
                <td style="padding:5px;text-align:right;">${money(ep.wage_total)}</td>
                <td style="padding:5px;text-align:right;color:#81c784;">${money(ep.holiday_allowance_total)}</td>
                <td style="padding:5px;text-align:right;font-weight:700;">${money(ep.total_wage)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:14px;">
        <button onclick="document.getElementById('payroll-preview-modal').remove()" style="padding:7px 14px;background:#2a2a4a;border:0;border-radius:4px;color:#ccc;cursor:pointer;font-size:12px;">취소</button>
        ${p.nullSnapshots.length > 0
          ? '<button disabled style="padding:7px 16px;background:#555;border:0;border-radius:4px;color:#aaa;cursor:not-allowed;font-size:12px;">시급 NULL → 확정 불가</button>'
          : `<button onclick="pmcPayroll._doConfirm(${p.anomalies.length > 0 ? 'true' : 'false'})" style="padding:7px 16px;background:#7c4dff;border:0;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">${p.anomalies.length > 0 ? '⚠️ 이상 무시하고 확정' : '✓ 확정'}</button>`
        }
      </div>
    `, '720px');
  }

  async function _doConfirm(ignoreAnomalies) {
    const p = currentPreview;
    if (!p) return;
    try {
      const r = await fetch('/api/payroll/periods/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: p.startDate, endDate: p.endDate, paymentDate: p.paymentDate,
          ignoreAnomalies,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        if (j.code === 'payroll/anomalies') {
          alert('⚠️ 이상 데이터 검출 — 확정 차단. ignoreAnomalies=true 필요');
        } else {
          alert('실패: ' + (j.error || r.status));
        }
        return;
      }
      document.getElementById('payroll-preview-modal')?.remove();
      alert(`✓ 확정 완료 (period_id=${j.periodId}, 총 ${money(j.totalAmount)})\n자동 expense 1건 생성됨.`);
      await loadPeriods();
    } catch (e) {
      alert('실패: ' + e.message);
    }
  }

  // ── 상세 모달 (employee_payrolls + weekly_holiday_allowances) ──
  async function viewPeriod(id) {
    try {
      const r = await fetch('/api/payroll/periods/' + id);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      _openPeriodDetailModal(j);
    } catch (e) { alert('실패: ' + e.message); }
  }

  function _openPeriodDetailModal({ data, employeePayrolls, weeklyAllowances }) {
    const byEmp = new Map();
    for (const e of employeePayrolls) byEmp.set(e.employeeId, { ep: e, weeks: [] });
    for (const w of weeklyAllowances) {
      if (byEmp.has(w.employeeId)) byEmp.get(w.employeeId).weeks.push(w);
    }
    const sections = Array.from(byEmp.values()).map(({ ep, weeks }) => `
      <div style="background:#0f0f23;border-radius:6px;padding:10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <strong style="color:#fff;font-size:13px;">${esc(ep.employeeName || '#' + ep.employeeId)}${ep.employeePlatform ? ' <span style="color:#888;font-size:11px;">· ' + esc(ep.employeePlatform) + '</span>' : ''}</strong>
          <span style="color:#81c784;font-weight:700;">${money(ep.totalWage)}</span>
        </div>
        <div style="color:#888;font-size:11px;margin-bottom:6px;">
          ${ep.totalWorkHours}h · ${ep.workDays}일 · 기본 ${money(ep.wageTotal)} + 주휴 ${money(ep.holidayAllowanceTotal)}
        </div>
        ${weeks.length > 0 ? `
          <details><summary style="cursor:pointer;color:#aaa;font-size:11px;">주별 주휴수당 ${weeks.length}주 ▼</summary>
            <table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:11px;">
              <thead><tr style="background:#1a1a2e;"><th style="padding:4px 6px;text-align:left;">주</th><th style="padding:4px;text-align:right;">시간</th><th style="padding:4px;text-align:right;">일수</th><th style="padding:4px;text-align:right;">1일평균</th><th style="padding:4px;text-align:right;">시급</th><th style="padding:4px;text-align:right;">금액</th><th style="padding:4px;text-align:center;">조작</th></tr></thead>
              <tbody>
                ${weeks.map(w => {
                  const excluded = w.isExcluded;
                  return `<tr style="border-bottom:1px solid #1a1a2e;${excluded ? 'opacity:0.5;' : ''}">
                    <td style="padding:4px 6px;color:#ccc;">${esc(fmtDate(w.weekStartDate))}~${esc(fmtDate(w.weekEndDate)).slice(5)}</td>
                    <td style="padding:4px;text-align:right;color:#aaa;">${w.totalWorkHours}h</td>
                    <td style="padding:4px;text-align:right;color:#aaa;">${w.workDays}</td>
                    <td style="padding:4px;text-align:right;color:#aaa;">${w.averageDailyHours}h</td>
                    <td style="padding:4px;text-align:right;color:#aaa;">${money(w.hourlyWageUsed)}</td>
                    <td style="padding:4px;text-align:right;color:${excluded ? '#888' : '#81c784'};font-weight:600;">${money(w.amount)}${excluded ? ' <span style="color:#ff8a80;font-size:9px;">OFF</span>' : ''}</td>
                    <td style="padding:4px;text-align:center;">
                      ${!excluded && data.status !== '지급완료' ? `<button onclick="pmcPayroll._excludeWeek(${data.id}, ${w.id})" title="주휴수당 수동 OFF" style="padding:2px 6px;background:#2a2a4a;border:0;border-radius:3px;color:#aaa;cursor:pointer;font-size:9px;">OFF</button>` : ''}
                      ${excluded ? `<span title="${esc(w.excludeReason || '')}" style="color:#888;font-size:9px;">${esc(w.excludeReason || '제외').slice(0, 12)}</span>` : ''}
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </details>
        ` : '<div style="color:#666;font-size:11px;">주휴수당 발생 없음</div>'}
      </div>
    `).join('');

    _modal('payroll-detail-modal', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div>
          <h3 style="color:#fff;font-size:15px;margin:0;">📅 ${esc(fmtDate(data.startDate))} ~ ${esc(fmtDate(data.endDate))}</h3>
          <div style="color:#888;font-size:11px;margin-top:3px;">상태 ${esc(data.status)} · 지급일 ${esc(fmtDate(data.paymentDate))} · 총 <strong style="color:#81c784;">${money(data.totalAmount)}</strong></div>
        </div>
        <button onclick="document.getElementById('payroll-detail-modal').remove()" style="background:transparent;border:0;color:#888;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <div style="max-height:520px;overflow:auto;">
        ${sections || '<div style="color:#666;text-align:center;padding:20px;">직원 정산 데이터 없음</div>'}
      </div>
    `, '780px');
  }

  async function _excludeWeek(periodId, weeklyId) {
    const reason = prompt('주휴수당 OFF 사유 (감사 보존됨)');
    if (!reason || !reason.trim()) return;
    try {
      const r = await fetch(`/api/payroll/periods/${periodId}/holiday-allowances/${weeklyId}/exclude`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      // 모달 닫고 다시 열기
      document.getElementById('payroll-detail-modal')?.remove();
      await viewPeriod(periodId);
    } catch (e) { alert('실패: ' + e.message); }
  }

  async function markPaid(id) {
    if (!confirm(`이 기간을 지급완료로 처리합니다. 인건비 expense 도 자동 '지급완료' 로 변경됩니다. 계속할까요?`)) return;
    try {
      const r = await fetch(`/api/payroll/periods/${id}/paid`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      await loadPeriods();
    } catch (e) { alert('실패: ' + e.message); }
  }

  async function cancelPeriod(id) {
    if (!confirm(`이 기간을 취소합니다.\n• attendance 잠금 해제\n• 인건비 expense status='취소됨' (삭제 X — 감사)\n계속할까요?`)) return;
    try {
      const r = await fetch(`/api/payroll/periods/${id}/cancel`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '실패');
      await loadPeriods();
    } catch (e) { alert('실패: ' + e.message); }
  }

  // ── 모달 helper ──
  function _modal(id, html, width) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const m = document.createElement('div');
    m.id = id;
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:20px;width:${width || '480px'};max-width:95vw;max-height:92vh;overflow-y:auto;color:#e0e0e0;">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    return m;
  }

  window.pmcPayroll = {
    load, refresh, saveBonus,
    // PR W-G2-F
    switchView, loadPeriods, previewPeriod, viewPeriod, markPaid, cancelPeriod,
    _onStartChange, _doConfirm, _excludeWeek,
  };
})();
