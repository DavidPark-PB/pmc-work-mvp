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
    .eq('auto_generated', false)  // 자동 예외 카드는 모닝 다이제스트에서 제외 — 직원 화면 보호
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
    .eq('auto_generated', false)  // 자동 예외 카드는 사장 저녁 요약에서 제외 — 자동 카드 전용 통계는 별 채널
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

  // Kill switch (2026-07-15): EBAY_API_LOCKED=true 면 eBay Browse API 를 소비하는
  // 크론 3종 (RepricingPipeline, CompetitorCrawler, MyListingRefresher) 등록 스킵.
  //   배경: Buy > Browse API 쿼터가 며칠간 회복 안 됨. 크론이 계속 두들겨서
  //   회복 자체를 방해 중. env 로 즉시 정지 → tier 회복/승인 후 env 삭제 재개.
  const EBAY_API_LOCKED = process.env.EBAY_API_LOCKED === 'true';
  if (EBAY_API_LOCKED) console.log('[scheduler] ⚠️ EBAY_API_LOCKED=true — Browse API 소비 크론 3종 정지');

  // 매일 오전 9시 정각 — 오늘 할 일 다이제스트
  cron.schedule('0 9 * * *', () => {
    sendMorningDigest().catch(e => console.error('[scheduler] morning error:', e));
  }, { timezone: TZ });

  // 매일 오전 9시 정각 — 운영 브리핑 (PR O2). admin 전체에 인앱 notification 발송.
  // morning digest 와 동시 실행 (별 함수, 충돌 없음).
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runOperationsBriefingJob } = require('../jobs/operationsBriefingJob');
      await runOperationsBriefingJob();
    } catch (e) {
      console.error('[OpsBriefingJob] error:', e.message);
    }
  }, { timezone: TZ });

  // 매일 오전 9시 정각 — 킬프라이스 데일리 (경쟁사 총액 대비 킬프라이스 추천 + 소싱기회, 텔레그램 푸시)
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runKillPricingDaily } = require('../jobs/killPricingDailyJob');
      await runKillPricingDaily();
    } catch (e) {
      console.error('[KillPricingDailyJob] error:', e.message);
    }
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

  // 경쟁사 가격 모니터 + 리프라이싱 파이프라인 — 6시간마다 (0시·6시·12시·18시 KST)
  // DRY_RUN=true (기본): 실제 가격 변경 없음, 텔레그램 리포트만
  // 변동 없으면 텔레그램 알림 안 보냄 (노이즈 방지)
  if (!EBAY_API_LOCKED) cron.schedule('0 0,6,12,18 * * *', async () => {
    try {
      const { runRepricingPipeline } = require('../jobs/repricingPipelineJob');
      const r = await runRepricingPipeline();
      if (r.priceAlerts > 0) {
        console.log(`[scheduler] RepricingPipeline: ${r.priceAlerts} price changes, ${r.proposals} proposals, ${r.changed} applied`);
      }
    } catch (e) {
      console.error('[scheduler] RepricingPipeline error:', e.message);
    }
  }, { timezone: TZ });

  // Alibaba 공급가 모니터 — 하루 2회 (오전 2시, 오후 2시 KST)
  // 키워드 크롤링 → MOQ/단가 변동 감지 → 텔레그램 알림
  cron.schedule('0 2,14 * * *', async () => {
    try {
      const { runAlibabaMonitor } = require('./alibabaMonitor');
      const r = await runAlibabaMonitor({ limit: 20 });
      if (r.alerts.length > 0) {
        console.log(`[scheduler] AlibabaMonitor: ${r.alerts.length} alerts, ${r.checked} checked`);
      }
    } catch (e) {
      console.error('[scheduler] AlibabaMonitor error:', e.message);
    }
  }, { timezone: TZ });

  // 경쟁셀러 크롤러 — 매일 새벽 1시 (전체 리스팅 수집)
  if (!EBAY_API_LOCKED) cron.schedule('0 1 * * *', async () => {
    try {
      const { runCrawler } = require('./competitorCrawler');
      const r = await runCrawler();
      console.log(`[scheduler] CompetitorCrawler: sellers=${r.sellers}, new=${r.newItems}, updated=${r.updatedItems}, priceChanges=${r.priceChanges}`);
    } catch (e) {
      console.error('[scheduler] CompetitorCrawler error:', e.message);
    }
  }, { timezone: TZ });

  // 내 리스팅 배송비/가격 갱신 — 매일 새벽 3시
  // 사장님 지침 (2026-07-12): 매칭된 SKU 만 대상 (product_matches approved).
  //   이유: 매칭 없는 SKU 는 Engine 1 판정 안 됨. 매칭된 것만 매일 refresh 하면
  //   전체 9,591 → ~1,000-2,000 개로 축소 → 하루에 전량 refresh → 항상 신선.
  //   MY_LISTING_MATCHED_ONLY=false 로 override 가능.
  if (!EBAY_API_LOCKED) cron.schedule('0 3 * * *', async () => {
    try {
      const { runRefreshMyListingsChunk } = require('./myListingRefresher');
      const r = await runRefreshMyListingsChunk({ matchedOnly: true, maxItems: 3000 });
      console.log(`[scheduler] MyListingRefresher (matched-only): processed=${r.processed}, updated=${r.updated}, failed=${r.failed}`);
    } catch (e) {
      console.error('[scheduler] MyListingRefresher error:', e.message);
    }
  }, { timezone: TZ });

  // Hermes v1 Daily Market Report — 매일 오전 8시 KST, Telegram 리포트 전송
  // 읽기/분석/리포트 전용. eBay 가격 변경 API 호출 없음.
  cron.schedule('0 8 * * *', async () => {
    try {
      const { runDailyReport } = require('./hermesMarketIntelligence');
      const r = await runDailyReport({ hours: 24, sendTelegram: true });
      console.log(`[scheduler] HermesDailyReport: ${r.report?.summary || 'generated'}`);
    } catch (e) {
      console.error('[scheduler] HermesDailyReport error:', e.message);
    }
  }, { timezone: TZ });

  // Hermes v1 Product Intelligence — 매일 오전 8시 10분 KST, SKU 포트폴리오 리포트 전송
  // 읽기/분석/리포트 전용. marketplace write API 호출 없음.
  cron.schedule('10 8 * * *', async () => {
    try {
      const { runProductIntelligence } = require('./hermesProductIntelligence');
      const r = await runProductIntelligence({ days: 30, sendTelegram: true });
      console.log(`[scheduler] HermesProductIntel: ${r.report?.summary || 'generated'}`);
    } catch (e) {
      console.error('[scheduler] HermesProductIntel error:', e.message);
    }
  }, { timezone: TZ });

  // Hermes v1 Listing Intelligence — 매일 오전 8시 20분 KST, 리스팅 개선 리포트 전송
  // 읽기/분석/리포트 전용. 가격 변경/승인 버튼 없음.
  cron.schedule('20 8 * * *', async () => {
    try {
      const { runListingIntelligence } = require('./hermesListingIntelligence');
      const r = await runListingIntelligence({ days: 30, sendTelegram: true });
      console.log(`[scheduler] HermesListingIntel: ${r.report?.summary || 'generated'}`);
    } catch (e) {
      console.error('[scheduler] HermesListingIntel error:', e.message);
    }
  }, { timezone: TZ });

  // AI 매처 — 매일 새벽 1시 30분 (크롤러 완료 후 매핑)
  cron.schedule('30 1 * * *', async () => {
    try {
      const { runMatcher } = require('./aiMatcher');
      const r = await runMatcher({ hours: 25 });
      console.log(`[scheduler] AIMatcher: processed=${r.processed}, autoApproved=${r.autoApproved}, pending=${r.pending}`);
    } catch (e) {
      console.error('[scheduler] AIMatcher error:', e.message);
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
  console.log('[scheduler] 활성화 — 9시(digest)·17시(summary)·4시(platform sync)·10/22시(eBay sync)·0/6/12/18시(경쟁사 모니터+리프라이싱)·3시(recurring)·3:30(uploads cleanup)');
}

module.exports = { start, sendMorningDigest, sendEveningOwnerSummary };
