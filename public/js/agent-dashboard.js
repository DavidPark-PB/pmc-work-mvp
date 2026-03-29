/**
 * Agent Dashboard — Frontend logic for AI recommendations page
 */

let agentCurrentFilter = '';
let agentCurrentPage = 1;
const AGENT_PAGE_SIZE = 20;

// ===== Load agent summary (for main dashboard banner + agent page) =====
async function loadAgentSummary() {
  try {
    const res = await fetch('/api/agents/summary');
    const json = await res.json();
    if (!json.success) return;

    // Main dashboard banner
    const banner = document.getElementById('agentSummaryBanner');
    if (banner) {
      banner.style.display = (json.pendingCount > 0 || json.criticalAlerts > 0) ? 'flex' : 'none';
      const el = (id) => document.getElementById(id);
      if (el('agentPendingCount')) el('agentPendingCount').textContent = json.pendingCount;
      if (el('agentCriticalCount')) el('agentCriticalCount').textContent = json.criticalAlerts;
      if (el('agentExecutedCount')) el('agentExecutedCount').textContent = json.todayExecuted;
    }

    // Agent dashboard page summary
    const el = (id) => document.getElementById(id);
    if (el('adPending')) el('adPending').textContent = json.pendingCount;
    if (el('adCritical')) el('adCritical').textContent = json.criticalAlerts;
    if (el('adExecuted')) el('adExecuted').textContent = json.todayExecuted;

    // Last run time
    if (el('adLastRun') && json.lastRuns) {
      const marginRun = json.lastRuns['margin-agent'];
      el('adLastRun').textContent = marginRun
        ? new Date(marginRun).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '미실행';
    }
  } catch (e) {
    console.error('[AgentDashboard] summary error:', e);
  }
}

// ===== Load recommendations table =====
async function loadAgentRecommendations(status, page) {
  agentCurrentFilter = status || '';
  agentCurrentPage = page || 1;

  try {
    let url = `/api/agents/recommendations?page=${agentCurrentPage}&limit=${AGENT_PAGE_SIZE}`;
    if (agentCurrentFilter) url += `&status=${agentCurrentFilter}`;

    const res = await fetch(url);
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('agentRecsTable');
    if (!tbody) return;

    if (!json.data || json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:#999">제안이 없습니다</td></tr>';
      return;
    }

    tbody.innerHTML = json.data.map(rec => {
      const priorityColors = { critical: '#f44336', high: '#ff9800', medium: '#2196f3', low: '#9e9e9e' };
      const priorityDot = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${priorityColors[rec.priority] || '#999'}"></span>`;
      const currentPrice = rec.current_value?.price ? `$${rec.current_value.price}` : '-';
      const recPrice = rec.recommended_value?.price ? `$${rec.recommended_value.price}` : '-';
      const margin = rec.current_value?.margin != null ? `${rec.current_value.margin}%` : '-';
      const changePct = rec.recommended_value?.priceChangePct ? `(${rec.recommended_value.priceChangePct > 0 ? '+' : ''}${rec.recommended_value.priceChangePct}%)` : '';
      const category = rec.recommended_value?.category || rec.type;
      const categoryLabels = {
        reverse_margin: '역마진', critical_low_margin: '위험마진',
        competitor_undercut: '경쟁사', below_target: '목표미달',
        overpriced_no_sales: '무판매',
      };

      const statusLabels = {
        pending: '<span style="color:#ff9800">대기</span>',
        approved: '<span style="color:#2196f3">승인됨</span>',
        auto_approved: '<span style="color:#00bcd4">자동승인</span>',
        executed: '<span style="color:#4caf50">실행됨</span>',
        failed: '<span style="color:#f44336">실패</span>',
        dismissed: '<span style="color:#9e9e9e">기각</span>',
      };

      let actions = '';
      if (rec.status === 'pending') {
        actions = `
          <button onclick="agentApprove('${rec.id}')" style="background:#4caf50;color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:12px">승인</button>
          <button onclick="agentDismiss('${rec.id}')" style="background:#9e9e9e;color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:12px;margin-left:4px">기각</button>`;
      } else if (rec.status === 'approved' || rec.status === 'auto_approved') {
        actions = `<button onclick="agentExecute('${rec.id}')" style="background:#2196f3;color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:12px">실행</button>`;
      }

      return `<tr>
        <td>${priorityDot}</td>
        <td style="font-family:monospace;font-size:12px">${rec.sku || '-'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${rec.current_value?.title || '-'}</td>
        <td><span style="font-size:12px;padding:2px 6px;border-radius:3px;background:#333;color:#fff">${categoryLabels[category] || category}</span></td>
        <td>${currentPrice}</td>
        <td style="font-weight:600">${recPrice} <span style="font-size:11px;color:#999">${changePct}</span></td>
        <td>${margin}</td>
        <td style="font-size:12px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(rec.reason || '').replace(/"/g, '&quot;')}">${rec.reason || '-'}</td>
        <td>${statusLabels[rec.status] || rec.status}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
    }).join('');

    // Pagination
    const pag = document.getElementById('agentRecsPagination');
    if (pag) {
      const hasMore = json.data.length === AGENT_PAGE_SIZE;
      pag.innerHTML = `
        ${agentCurrentPage > 1 ? `<button onclick="loadAgentRecommendations('${agentCurrentFilter}', ${agentCurrentPage - 1})" style="margin:0 4px;padding:4px 12px;cursor:pointer">이전</button>` : ''}
        <span style="color:#999;font-size:13px">페이지 ${agentCurrentPage}</span>
        ${hasMore ? `<button onclick="loadAgentRecommendations('${agentCurrentFilter}', ${agentCurrentPage + 1})" style="margin:0 4px;padding:4px 12px;cursor:pointer">다음</button>` : ''}`;
    }
  } catch (e) {
    console.error('[AgentDashboard] recommendations error:', e);
  }
}

// ===== Load alerts banner =====
async function loadAgentAlerts() {
  try {
    const res = await fetch('/api/agents/alerts?is_read=false&limit=5');
    const json = await res.json();
    if (!json.success) return;

    const banner = document.getElementById('agentAlertBanner');
    if (!banner) return;

    if (!json.data || json.data.length === 0) {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'block';
    banner.innerHTML = json.data.map(a => {
      const sevColors = { critical: '#f44336', warning: '#ff9800', info: '#2196f3' };
      const bg = sevColors[a.severity] || '#333';
      return `<div style="background:${bg};color:#fff;padding:10px 16px;border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <strong>${a.title}</strong>
          <span style="opacity:0.85;margin-left:8px;font-size:13px">${a.message}</span>
        </div>
        <button onclick="agentDismissAlert('${a.id}', this)" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:4px 12px;border-radius:3px;cursor:pointer;font-size:12px">확인</button>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('[AgentDashboard] alerts error:', e);
  }
}

// ===== Load audit log =====
async function loadAuditLog() {
  try {
    const res = await fetch('/api/agents/audit?limit=30');
    const json = await res.json();
    if (!json.success) return;

    const tbody = document.getElementById('auditLogTable');
    if (!tbody) return;

    tbody.innerHTML = (json.data || []).map(log => {
      const time = new Date(log.created_at).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const resultColor = log.result === 'success' ? '#4caf50' : log.result === 'error' ? '#f44336' : '#999';
      return `<tr>
        <td style="font-size:12px;color:#999">${time}</td>
        <td>${log.agent_name}</td>
        <td>${log.action_type}</td>
        <td style="font-family:monospace;font-size:12px">${log.sku || '-'}</td>
        <td>${log.decision || '-'}</td>
        <td style="color:${resultColor}">${log.result}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error('[AgentDashboard] audit log error:', e);
  }
}

// ===== Actions =====
async function agentApprove(id) {
  if (!confirm('이 제안을 승인하시겠습니까?')) return;
  try {
    await fetch(`/api/agents/recommendations/${id}/approve`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved_by: 'dashboard_user' }),
    });
    loadAgentDashboard();
  } catch (e) { alert('승인 실패: ' + e.message); }
}

async function agentDismiss(id) {
  const reason = prompt('기각 사유 (선택):') || '';
  try {
    await fetch(`/api/agents/recommendations/${id}/dismiss`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    loadAgentDashboard();
  } catch (e) { alert('기각 실패: ' + e.message); }
}

async function agentExecute(id) {
  if (!confirm('이 제안을 실행하시겠습니까? 가격이 실제로 변경됩니다.')) return;
  try {
    const res = await fetch(`/api/agents/recommendations/${id}/execute`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert(json.data?.execution_result?.applied ? '실행 완료!' : '실행 실패: ' + (json.data?.execution_result?.error || '알 수 없는 오류'));
    } else {
      alert('실행 실패: ' + json.error);
    }
    loadAgentDashboard();
  } catch (e) { alert('실행 오류: ' + e.message); }
}

async function agentDismissAlert(id, btn) {
  try {
    await fetch(`/api/agents/alerts/${id}/read`, { method: 'PUT' });
    if (btn) btn.closest('div[style]').remove();
    loadAgentSummary();
  } catch (e) { console.error(e); }
}

async function agentRunNow(agentName) {
  if (!confirm(`${agentName}을 지금 실행하시겠습니까?`)) return;
  try {
    const res = await fetch(`/api/agents/run/${agentName}`, { method: 'POST' });
    const json = await res.json();
    alert(json.success ? `완료! ${json.recommendations}건 제안 생성` : '실행 실패: ' + json.error);
    loadAgentDashboard();
  } catch (e) { alert('실행 오류: ' + e.message); }
}

// ===== Full page load =====
async function loadAgentDashboard() {
  await Promise.all([
    loadAgentSummary(),
    loadAgentAlerts(),
    loadAgentRecommendations(agentCurrentFilter, agentCurrentPage),
    loadAuditLog(),
  ]);
}

// ===== Filter tab click handlers =====
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.agent-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.agent-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadAgentRecommendations(btn.dataset.filter, 1);
    });
  });
});
