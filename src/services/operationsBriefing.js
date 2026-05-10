/**
 * src/services/operationsBriefing.js — Daily Operations Briefing (PR O1)
 *
 * 역할:
 *   1인 셀러 사장님이 매일 아침 한 화면으로 오늘의 운영 상황을 파악할 수 있도록
 *   기존 DB 데이터 (team_tasks / purchase_requests / wms_orders / wms_order_lines /
 *   automation_runs) 를 집계해서 단일 summary 객체로 반환.
 *
 * 정책:
 *   - 읽기 전용. DB 변경 0건. schema/migration 변경 0건.
 *   - Safety Foundation 코드 (safetyExec / safetyUndo) 호출 0건.
 *   - 외부 API (eBay/Shopify/Telegram) 호출 0건.
 *   - 각 섹션별 try/catch — 일부 query 실패해도 다른 섹션은 정상 응답.
 *   - 실패한 섹션은 partial flag + recommendations 에 안내.
 *
 * 호출처:
 *   src/web/routes/operationsBriefing.js — GET /api/ops-briefing/today
 */
'use strict';

const supabaseClient = require('../db/supabaseClient');

/**
 * 오늘 (서버 로컬 00:00) 부터 지금까지의 운영 요약.
 *
 * @returns {Promise<Object>} { date, orders, tasks, purchase_requests, safety, recommendations }
 *                            각 섹션은 query 실패 시 null 가능.
 */
async function getTodayBriefing() {
  const supabase = supabaseClient.getClient();

  // 서버 로컬 00:00 → ISO (timestamptz 비교용)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayStartIso = todayStart.toISOString();
  const dateStr = todayStart.toISOString().slice(0, 10);

  const failedSections = [];
  const out = {
    date: dateStr,
    orders: null,
    tasks: null,
    purchase_requests: null,
    safety: null,
    recommendations: [],
  };

  // ── orders ─────────────────────────────────────────────────────────────
  try {
    out.orders = await summarizeOrders(supabase, todayStartIso);
  } catch (e) {
    console.error('[opsBriefing] orders failed:', e.message);
    failedSections.push('orders');
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  try {
    out.tasks = await summarizeTasks(supabase, todayStartIso, dateStr);
  } catch (e) {
    console.error('[opsBriefing] tasks failed:', e.message);
    failedSections.push('tasks');
  }

  // ── purchase_requests ──────────────────────────────────────────────────
  try {
    out.purchase_requests = await summarizePurchaseRequests(supabase, todayStartIso);
  } catch (e) {
    console.error('[opsBriefing] purchase_requests failed:', e.message);
    failedSections.push('purchase_requests');
  }

  // ── safety (automation_runs) ───────────────────────────────────────────
  try {
    out.safety = await summarizeSafety(supabase, todayStartIso);
  } catch (e) {
    console.error('[opsBriefing] safety failed:', e.message);
    failedSections.push('safety');
  }

  // ── recommendations ────────────────────────────────────────────────────
  out.recommendations = buildRecommendations(out, failedSections);

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 섹션별 helper
// ──────────────────────────────────────────────────────────────────────────

async function summarizeOrders(supabase, todayStartIso) {
  // wms_orders 의 핵심 4개 필드만 (snapshot 미조회)
  const { data: rows, error } = await supabase
    .from('wms_orders')
    .select('id, order_status, created_at')
    .order('id', { ascending: false })
    .limit(500);
  if (error) throw error;
  const all = rows || [];

  const total_today = all.filter(r => r.created_at >= todayStartIso).length;
  const pending     = all.filter(r => r.order_status === 'pending').length;

  // 자동 예외 카드 (auto_generated=true) 로 매칭 실패가 추적됨 — team_tasks 에서 별도 집계
  let exception_count = 0;
  let sku_match_failed = 0;
  try {
    const { data: excRows } = await supabase
      .from('team_tasks')
      .select('id, exception_type, status, created_at')
      .eq('auto_generated', true)
      .neq('status', 'done')
      .limit(500);
    exception_count  = (excRows || []).length;
    sku_match_failed = (excRows || []).filter(r => r.exception_type === 'SKU_MATCH_FAILED').length;
  } catch (_) { /* exception_count / sku_match_failed 만 집계 실패 — orders 의 다른 값은 보존 */ }

  return {
    total_today,
    pending,
    exception_count,
    sku_match_failed,
  };
}

async function summarizeTasks(supabase, todayStartIso, dateStr) {
  // 사람 카드 (auto_generated=false) 만 — 자동 예외 카드는 orders 섹션에서 별도 집계
  const { data: rows, error } = await supabase
    .from('team_tasks')
    .select('id, status, priority, due_date, completed_at')
    .eq('auto_generated', false)
    .order('id', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const all = rows || [];

  const open      = all.filter(r => r.status !== 'done').length;
  const urgent    = all.filter(r => r.priority === 'urgent' && r.status !== 'done').length;
  // due_date 는 DATE 형 (YYYY-MM-DD). 오늘 날짜 미만이면 overdue.
  const overdue   = all.filter(r => r.due_date && r.due_date < dateStr && r.status !== 'done').length;
  const completed_today = all.filter(r => r.status === 'done' && r.completed_at && r.completed_at >= todayStartIso).length;

  return { open, urgent, overdue, completed_today };
}

async function summarizePurchaseRequests(supabase, todayStartIso) {
  const { data: rows, error } = await supabase
    .from('purchase_requests')
    .select('id, status, decision_at, ordered_at')
    .order('id', { ascending: false })
    .limit(500);
  if (error) throw error;
  const all = rows || [];

  const pending         = all.filter(r => r.status === 'pending').length;
  const approved_today  = all.filter(r => r.status === 'approved' && r.decision_at && r.decision_at >= todayStartIso).length;
  const ordered_today   = all.filter(r => r.status === 'ordered'  && r.ordered_at  && r.ordered_at  >= todayStartIso).length;

  return { pending, approved_today, ordered_today };
}

async function summarizeSafety(supabase, todayStartIso) {
  const { data: rows, error } = await supabase
    .from('automation_runs')
    .select('id, status, rollback_method, rollback_run_id, started_at, rolled_back_at')
    .order('id', { ascending: false })
    .limit(500);
  if (error) throw error;
  const all = rows || [];

  const failed_runs_today = all.filter(r => r.status === 'failed' && r.started_at >= todayStartIso).length;
  const rollbackable_runs = all.filter(r => r.status === 'succeeded' && r.rollback_method === 'auto' && r.rollback_run_id == null).length;
  const rolled_back_today = all.filter(r => r.status === 'rolled_back' && r.rolled_back_at && r.rolled_back_at >= todayStartIso).length;

  return { failed_runs_today, rollbackable_runs, rolled_back_today };
}

// ──────────────────────────────────────────────────────────────────────────
// recommendations — 우선순위 높은 항목 최대 4개
// ──────────────────────────────────────────────────────────────────────────
function buildRecommendations(out, failedSections) {
  const recs = [];

  // 1) 자동 예외 카드 — SKU 매칭 실패가 우선순위 1
  if (out.orders?.sku_match_failed > 0) {
    recs.push(`SKU 매칭 실패 ${out.orders.sku_match_failed}건을 먼저 확인하세요.`);
  } else if (out.orders?.exception_count > 0) {
    recs.push(`자동 예외 카드 ${out.orders.exception_count}건이 대기 중입니다.`);
  }

  // 2) 긴급/지연 업무
  if (out.tasks?.urgent > 0) {
    recs.push(`긴급 업무 ${out.tasks.urgent}건이 있습니다.`);
  }
  if (out.tasks?.overdue > 0) {
    recs.push(`마감 지난 업무 ${out.tasks.overdue}건을 확인하세요.`);
  }

  // 3) 발주 승인 대기
  if (out.purchase_requests?.pending > 0) {
    recs.push(`발주 승인 대기 ${out.purchase_requests.pending}건이 있습니다.`);
  }

  // 4) 자동화 실패
  if (out.safety?.failed_runs_today > 0) {
    recs.push(`오늘 자동화 실패 ${out.safety.failed_runs_today}건 — 실행 로그를 확인하세요.`);
  }

  // partial 안내
  if (failedSections.length > 0) {
    recs.push(`일부 데이터 조회 실패: ${failedSections.join(', ')} (전체 응답에는 영향 없음)`);
  }

  // 모두 평온 시 친절 메시지
  if (recs.length === 0) {
    recs.push('처리할 긴급 항목이 없습니다. 정상 운영 중입니다.');
  }

  return recs;
}

module.exports = { getTodayBriefing };
