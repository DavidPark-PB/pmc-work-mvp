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
const {
  getKstDateContext,
  countTodayNew,
  countPendingAction,
} = require('./oms/omsBriefingCounts');

/**
 * 오늘 (서버 로컬 00:00) 부터 지금까지의 운영 요약.
 *
 * @returns {Promise<Object>} { date, orders, tasks, purchase_requests, safety, recommendations }
 *                            각 섹션은 query 실패 시 null 가능.
 */
async function getTodayBriefing() {
  const supabase = supabaseClient.getClient();

  // OPS-BRIEF-1B · KST 일 경계.
  //   과거 구현: new Date(y,m,d,0,0,0) — 프로세스 로컬 시간 기준. Railway 는 UTC 호스트
  //   (Dockerfile / config / .env 어디에도 TZ 없음) → UTC 자정 = KST 09:00 이 되어
  //   KST 아침 최대 9~15시간 window 가 조용히 누락됨. 09:00 KST 브리핑 잡이 특히 심각.
  //   신규: getKstDateContext 로 Asia/Seoul 고정 (attendanceRepository._koreaParts 와 동일 idiom).
  const { dateStr, todayStartIso } = getKstDateContext();

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
  // OPS-BRIEF-1B · Canonical OMS order counts (2026-09-06).
  //   과거 구현: wms_orders LIMIT 500 → in-memory filter. wms_orders 는 legacy
  //   mock-only sink (production 1 row) 라 값이 항상 사실상 0. 사장님이 보는 지표가
  //   실제 주문 현실을 반영하지 못함.
  //   신규: canonical oms_orders 서버 사이드 exact count.
  //     total_today = ordered_at >= KST midnight (marketplace 주문 시점 · idx_oms_orders_ordered_at)
  //     pending     = order_status IN (new, confirmed, processing, on_hold, ready_to_ship)
  //                   — shipped/completed/cancelled/returned 제외 (owner rule §9)
  //   API 필드 이름 (total_today, pending) 은 그대로 유지 — 프론트엔드 계약 안정.
  //   Response 라벨은 public/js/opsBriefing.js 에서 UI 문구 조정 (contract 는 semantic-only 이관).
  //
  // 독립 UNKNOWN 처리 (owner rule §7): 두 카운트는 서로 다른 관측이므로 하나가 실패해도
  //   다른 하나의 알려진 값을 지우면 안 된다. 각각 try/catch, 각각 null 초기값.
  let total_today = null;
  try {
    total_today = await countTodayNew(supabase, todayStartIso);
  } catch (e) {
    console.error('[opsBriefing] TODAY_NEW count failed:', e.message);
    // null 유지 · UI/notification 은 이를 UNKNOWN 으로 렌더.
  }

  let pending = null;
  try {
    pending = await countPendingAction(supabase);
  } catch (e) {
    console.error('[opsBriefing] PENDING_ACTION count failed:', e.message);
    // null 유지.
  }

  // OPS-BRIEF-1A · 자동 예외 카드 카운트 진실성.
  //   과거 구현: LIMIT 500 후 in-memory .length — open auto card 총량이 500 을 넘으면
  //   조용히 saturation 되어 라벨과 정면 모순. 실측 993 vs 표시 500.
  //   신규 구현: server-side exact count (LIMIT 없음).
  //   UNKNOWN ≠ ZERO: 카운트 쿼리 실패 시 null 로 유지 → UI 는 '-' 렌더.
  //   집계 실패가 0 으로 위장되지 않도록 함.
  let exception_count = null;
  let sku_match_failed = null;
  try {
    const totalRes = await supabase
      .from('team_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('auto_generated', true)
      .neq('status', 'done');
    if (totalRes.error) throw totalRes.error;
    exception_count = totalRes.count == null ? null : totalRes.count;

    const skuRes = await supabase
      .from('team_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('auto_generated', true)
      .neq('status', 'done')
      .eq('exception_type', 'SKU_MATCH_FAILED');
    if (skuRes.error) throw skuRes.error;
    sku_match_failed = skuRes.count == null ? null : skuRes.count;
  } catch (e) {
    console.error('[opsBriefing] auto-exception counts failed:', e.message);
    // 두 metric 을 null 로 유지 — UI 는 '-' 로 렌더, 0 아님.
  }

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
  } else if (out.orders?.sku_match_failed === null || out.orders?.exception_count === null) {
    // OPS-BRIEF-1A-H1 · UNKNOWN ≠ ZERO.
    //   count 쿼리 실패로 두 metric 이 null 인 경우, positive-only 분기가 조용히 통과해
    //   아래의 "정상 운영 중입니다" 문구가 잘못 표시되는 것을 막는다. 확인 실패는 반드시 노출.
    recs.push('자동 예외 카운트 확인 실패 — 서버 로그를 확인하세요.');
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

  // 5) OPS-BRIEF-1B · OMS 주문 카운트 UNKNOWN.
  //   total_today/pending 중 하나라도 null 이면 explicit UNKNOWN 노출 —
  //   아래 "정상 운영 중입니다" 폴백이 잘못 발화하지 못하게 함.
  //   Body 세그먼트에도 동일 UNKNOWN 문구가 있으나 recommendation 은 "sku/exception counts"
  //   와 스코프가 다르므로 분리 유지.
  if (out.orders?.total_today === null || out.orders?.pending === null) {
    recs.push('OMS 주문 카운트 확인 실패 — 서버 로그를 확인하세요.');
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

/**
 * PR O2 — briefing 객체 → notification payload (title / body / linkUrl).
 *
 * 정책:
 *   - 순수 formatting helper (DB write 0, 외부 API 0)
 *   - body 는 ~250자 이내로 컴팩트
 *   - recommendations 상위 2개 포함 (있으면)
 *   - 카운트 0 인 섹션은 body 에서 생략 (잡음 감소)
 *   - OPS-BRIEF-1A-H1 · UNKNOWN ≠ ZERO. count 쿼리가 실패해 값이 null 인 경우
 *     truthy check 만으로는 0 과 구분되지 않는다. null 은 반드시 "확인 실패"
 *     로 명시 렌더 · 사장님이 0 (진짜 평온) 과 UNKNOWN (관측 실패) 를 구분
 *     할 수 있어야 함.
 *
 * @param {Object} briefing — getTodayBriefing() 결과
 * @returns {{ title: string, body: string, linkUrl: string, type: string }}
 */
function buildBriefingNotification(briefing) {
  const o = briefing?.orders || {};
  const t = briefing?.tasks  || {};
  const p = briefing?.purchase_requests || {};
  const s = briefing?.safety || {};

  const segments = [];
  //   OPS-BRIEF-1B · OMS TODAY_NEW (canonical oms_orders.ordered_at ≥ KST midnight).
  //     known positive  → 실제 카운트 렌더 (기존 contract 유지)
  //     known zero      → 생략 (quiet-body)
  //     unknown (null)  → "오늘 신규 주문 확인 실패" 로 명시 (UNKNOWN ≠ ZERO)
  if (typeof o.total_today === 'number' && o.total_today > 0) {
    segments.push(`신규 주문 ${o.total_today}건`);
  } else if (o.total_today === null) {
    segments.push('오늘 신규 주문 확인 실패');
  }
  //   OPS-BRIEF-1B · OMS PENDING (order_status IN PENDING_ACTION_STATUSES).
  //     known positive/zero 는 body 에 노출하지 않음 (기존 contract) — recommendation 이 필요 시 노출.
  //     unknown (null) 만 body 에 명시 → "미처리 주문 확인 실패".
  if (o.pending === null) {
    segments.push('미처리 주문 확인 실패');
  }
  //   OPS-BRIEF-1A-H1 · 자동 예외 exception_count.
  //     known positive  → 실제 카운트 렌더.
  //     known zero      → 기존 contract 유지 (body 에서 생략 · 잡음 감소).
  //     unknown (null)  → "자동 예외 확인 실패" 로 명시. 0 으로 위장하지 않음.
  if (typeof o.exception_count === 'number' && o.exception_count > 0) {
    segments.push(`자동 예외 ${o.exception_count}건`);
  } else if (o.exception_count === null) {
    segments.push('자동 예외 확인 실패');
  }
  //   OPS-BRIEF-1A-H1 · SKU 매칭 실패 sku_match_failed.
  //     known positive/zero 는 기존 contract 유지 (recommendation 이 positive 를 노출).
  //     unknown (null) 만 body 에 명시 노출 → "정상 운영" 오해 방지.
  if (o.sku_match_failed === null) {
    segments.push('SKU 매칭 실패 확인 실패');
  }
  // tasks 핵심 — 미처리 / 긴급 / 마감 지남
  if (t.urgent)           segments.push(`긴급 업무 ${t.urgent}건`);
  if (t.overdue)          segments.push(`마감 지남 ${t.overdue}건`);
  if (!t.urgent && !t.overdue && t.open) segments.push(`미처리 업무 ${t.open}건`);
  // purchase
  if (p.pending)          segments.push(`발주 대기 ${p.pending}건`);
  // safety
  if (s.failed_runs_today) segments.push(`자동화 실패 ${s.failed_runs_today}건`);

  const summaryLine = segments.length > 0
    ? segments.join(' · ')
    : '오늘 처리할 긴급 항목이 없습니다.';

  // recommendations 상위 2개 (partial 안내 라인은 제외 — body 가 너무 길어짐)
  const recs = (Array.isArray(briefing?.recommendations) ? briefing.recommendations : [])
    .filter(r => !r.startsWith('일부 데이터'))
    .slice(0, 2);

  let body = summaryLine;
  if (recs.length > 0) {
    body += '\n\n💡 ' + recs.join('\n💡 ');
  }
  // 250자 cap
  if (body.length > 250) body = body.slice(0, 247) + '...';

  return {
    title:   '오늘 운영 브리핑',
    body,
    linkUrl: '/?page=ops-briefing',
    type:    'ops_briefing',
  };
}

module.exports = { getTodayBriefing, buildBriefingNotification };
