/**
 * 알림 스케줄러 (Phase 5)
 *
 * cron 스펙:
 *   매일 오전 9:00  — 전 직원+사장에게 "오늘 할 일" 일일 다이제스트
 *   매일 오후 5:00  — 사장에게 미완료 업무 요약
 *
 * 서버 시작 시 start() 호출하면 등록됨.
 * 개별 함수는 외부에서 수동 실행도 가능 (테스트/수동 트리거용).
 */
const cron = require('node-cron');
const { getClient } = require('../db/supabaseClient');
const { notify, notifyMany, getAdminIds, getStaffIds } = require('./notificationService');

const TZ = 'Asia/Seoul';

/**
 * 매일 오전 9시 — 각 직원에게 오늘의 업무 리스트
 * - 오늘 마감 또는 오늘 생성된 미완료 업무
 * - 전체 공지 포함
 */
async function sendMorningDigest() {
  const c = getClient();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const { data: tasks, error } = await c
    .from('team_tasks')
    .select('id, title, assignee_id, assignee_scope, due_date, priority, status, created_at')
    .neq('status', 'done')
    .or(`and(due_date.gte.${start},due_date.lt.${end}),and(created_at.gte.${start},created_at.lt.${end}),assignee_scope.eq.all`);
  if (error) { console.error('[scheduler] morning digest query:', error.message); return; }

  const [adminIds, staffIds] = await Promise.all([getAdminIds(), getStaffIds()]);
  const allUserIds = [...adminIds, ...staffIds];

  // 수신자별 업무 수 집계
  const countsByUser = new Map();
  for (const t of tasks || []) {
    if (t.assignee_scope === 'all') {
      for (const uid of staffIds) {
        countsByUser.set(uid, (countsByUser.get(uid) || 0) + 1);
      }
    }
    if (t.assignee_id) {
      countsByUser.set(t.assignee_id, (countsByUser.get(t.assignee_id) || 0) + 1);
    }
  }

  let created = 0;
  const recipients = allUserIds.filter(uid => (countsByUser.get(uid) || 0) > 0);

  // 수신자별로 개별 알림 생성 (본인 업무 수 포함)
  for (const uid of recipients) {
    const n = countsByUser.get(uid);
    await notify({
      recipientId: uid,
      type: 'daily_digest',
      title: `오늘 할 일 ${n}건`,
      body: `오늘 처리해야 할 미완료 업무가 ${n}건 있습니다.`,
      linkUrl: '/?page=tasks',
      relatedType: 'task',
      relatedId: null,
    });
    created++;
  }
  console.log(`[scheduler] morning digest — ${created}명에게 알림 전송`);
  return { recipients: created, totalTasks: tasks?.length || 0 };
}

/**
 * 매일 오후 5시 — 사장에게 미완료 업무 요약
 */
async function sendEveningOwnerSummary() {
  const c = getClient();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const { data: tasks, error } = await c
    .from('team_tasks')
    .select('id, status, assignee_id, due_date, priority')
    .neq('status', 'done')
    .or(`and(due_date.gte.${start},due_date.lt.${end}),and(created_at.gte.${start},created_at.lt.${end})`);
  if (error) { console.error('[scheduler] evening summary query:', error.message); return; }

  const pendingCount = (tasks || []).filter(t => t.status === 'pending').length;
  const inProgressCount = (tasks || []).filter(t => t.status === 'in_progress').length;
  const urgentCount = (tasks || []).filter(t => t.priority === 'urgent').length;
  const total = pendingCount + inProgressCount;

  if (total === 0) { console.log('[scheduler] evening summary — 모든 업무 완료'); return; }

  const adminIds = await getAdminIds();
  await notifyMany(adminIds, {
    type: 'daily_digest',
    title: `📊 오늘 미완료 ${total}건`,
    body: `대기 ${pendingCount} · 진행중 ${inProgressCount}${urgentCount > 0 ? ` · 🚨 긴급 ${urgentCount}` : ''}`,
    linkUrl: '/?page=tasks',
    relatedType: 'task',
    relatedId: null,
  });
  console.log(`[scheduler] evening summary — ${adminIds.length}명 사장에게 전송`);
  return { recipients: adminIds.length, total };
}

let scheduled = false;
function start() {
  if (scheduled) { console.log('[scheduler] 이미 시작됨'); return; }

  // 매일 오전 9시 정각 — 오늘 할 일 다이제스트
  cron.schedule('0 9 * * *', () => {
    sendMorningDigest().catch(e => console.error('[scheduler] morning error:', e));
  }, { timezone: TZ });

  // 매일 오전 9시 5분 — B2B 미발송 수량 admin 알림
  cron.schedule('5 9 * * *', async () => {
    try {
      const reminder = require('./b2bShippingReminder');
      await reminder.run();
    } catch (e) {
      console.error('[scheduler] b2b shipping reminder error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 오후 5시 정각 — 사장 미완료 요약
  cron.schedule('0 17 * * *', () => {
    sendEveningOwnerSummary().catch(e => console.error('[scheduler] evening error:', e));
  }, { timezone: TZ });

  // 매일 새벽 4시 — 네이버/쇼피/알리바바/Shopify 상품 동기화 (eBay는 별도 스케줄)
  cron.schedule('0 4 * * *', async () => {
    const sync = require('./platformSync');
    const productSync = require('./productSync');
    const results = {};
    try { results.naver = await sync.syncNaverList(); }
    catch (e) { results.naver = { error: e.message }; }
    try { results.shopee = await sync.syncShopeeAll(); }
    catch (e) { results.shopee = { error: e.message }; }
    try { results.alibaba = await sync.syncAlibabaAll(); }
    catch (e) { results.alibaba = { error: e.message }; }
    try { results.shopify = await productSync.syncPlatformProducts(['shopify']); }
    catch (e) { results.shopify = { error: e.message }; }
    console.log('[scheduler] 4am platform sync done:', JSON.stringify(results));
  }, { timezone: TZ });

  // eBay 전용 — 매일 오전 10시 · 오후 10시 KST (하루 2회)
  // 전투 상황판이 DB 스냅샷을 읽으므로 자동 동기화 필수.
  cron.schedule('0 10,22 * * *', async () => {
    try {
      const productSync = require('./productSync');
      const r = await productSync.syncPlatformProducts(['ebay']);
      console.log('[scheduler] eBay sync (10/22시):', JSON.stringify(r));
    } catch (e) {
      console.error('[scheduler] eBay sync error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 10시·18시 KST — 네이버 detail 보강 (배치 200) · 하루 2회로 축소
  cron.schedule('0 10,18 * * *', async () => {
    try {
      const sync = require('./platformSync');
      const r = await sync.enrichNaverDetails(200);
      if (r.synced > 0 || r.remaining > 0) {
        console.log(`[scheduler] naver enrich: ${r.synced} synced, ${r.remaining} remaining`);
      }
    } catch (e) {
      console.error('[scheduler] naver enrich error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 새벽 2시 30분 — 자료실 폴더 Drive 동기화
  cron.schedule('30 2 * * *', async () => {
    try {
      const resourceSync = require('./resourceSync');
      const results = await resourceSync.syncAll();
      const ok = results.filter(r => r.ok).length;
      if (results.length > 0) console.log(`[scheduler] resources sync: ${ok}/${results.length} folders`);
    } catch (e) {
      console.error('[scheduler] resources sync error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 새벽 3시 — 도래한 정기결제를 expenses로 발행
  cron.schedule('0 3 * * *', async () => {
    try {
      const recurringRepo = require('../db/recurringRepository');
      const expenseRepo = require('../db/expenseRepository');
      const due = await recurringRepo.listDue();
      // 병렬 실행 — 각 fire는 독립적
      const results = await Promise.allSettled(
        due.map(r => recurringRepo.fire(r, { expenseRepo }))
      );
      const fired = results.filter(x => x.status === 'fulfilled').length;
      results.forEach((x, i) => {
        if (x.status === 'rejected') console.warn(`[scheduler] recurring fire fail id=${due[i].id}:`, x.reason?.message || x.reason);
      });
      if (due.length > 0) console.log(`[scheduler] recurring: ${fired}/${due.length}건 발행`);
    } catch (e) {
      console.error('[scheduler] recurring error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 새벽 3:30 — 만료된 shared_uploads 정리 (DB + Supabase Storage)
  cron.schedule('30 3 * * *', async () => {
    try {
      const uploadRepo = require('../db/sharedUploadRepository');
      const expired = await uploadRepo.deleteExpired();
      if (expired.length > 0) {
        const paths = expired.map(r => r.storage_path).filter(Boolean);
        if (paths.length > 0) {
          try {
            const db = getClient();
            await db.storage.from('shared-uploads').remove(paths);
          } catch (e) { console.warn('[scheduler] shared-uploads storage remove:', e.message); }
        }
        console.log(`[scheduler] shared uploads: ${expired.length}개 만료 정리`);
      }
    } catch (e) {
      console.error('[scheduler] shared uploads cleanup error:', e.message);
    }
  }, { timezone: TZ });

  scheduled = true;
  console.log('[scheduler] 활성화 — 9시(digest)·17시(summary)·4시(platform sync)·매시(naver enrich)·3시(recurring)·3:30(uploads cleanup)');
}

module.exports = { start, sendMorningDigest, sendEveningOwnerSummary };
