/**
 * src/jobs/operationsBriefingJob.js — Daily Operations Briefing job (PR O2)
 *
 * 역할:
 *   매일 오전 (scheduler.js 가 09:00 KST 호출) 운영 브리핑 생성 +
 *   admin 전체에게 인앱 notification 발송.
 *
 * 정책:
 *   - 외부 API (Telegram / Kakao / WhatsApp / eBay / Shopee 등) 호출 0건
 *   - DB write = notifications insert 만 (notifyAdmins helper 위임)
 *   - schema / migration / Safety Foundation 변경 0
 *   - dryRun=true 면 notification insert 없이 briefing + 생성된 payload 반환
 *   - 로그 룰: title / body / 길이 / recipientHint 정도만. snapshot/payload/secret 출력 금지
 *
 * 흐름:
 *   1) opsBriefing.getTodayBriefing() — 4 섹션 집계 + recommendations
 *   2) opsBriefing.buildBriefingNotification(briefing) — title / body / linkUrl
 *   3) dryRun 이면 즉시 반환
 *   4) notificationService.notifyAdmins(payload) — admin 전체 (role='admin' && is_active=true)
 *   5) 반환 { briefing, notification, recipientCount }
 *
 * 호출처:
 *   - src/services/scheduler.js (cron '0 9 * * *' KST)
 *   - 수동 호출 가능 (node -e dryRun 등)
 */
'use strict';

const opsBriefing = require('../services/operationsBriefing');
const { notifyAdmins, notifyMany, getAdminIds, getStaffIds } = require('../services/notificationService');

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=false] — true 면 DB write 안 함, briefing+payload 만 반환
 * @returns {Promise<{ briefing, notification, recipientCount, dryRun }>}
 */
async function runOperationsBriefingJob({ dryRun = false } = {}) {
  // 1) briefing 생성
  const briefing = await opsBriefing.getTodayBriefing();

  // 2) notification payload
  const notification = opsBriefing.buildBriefingNotification(briefing);

  // 3) dryRun
  if (dryRun) {
    // 로그 — recipient count 만 미리 (DB write 0)
    const [adminIds, staffIds] = await Promise.all([
      getAdminIds().catch(() => []),
      getStaffIds().catch(() => []),
    ]);
    console.log('[OpsBriefingJob] dryRun:', {
      title: notification.title,
      bodyLen: notification.body.length,
      recipientHint: `${adminIds.length} admin(s) + ${staffIds.length} staff`,
    });
    return { briefing, notification, recipientCount: adminIds.length + staffIds.length, dryRun: true };
  }

  // 4) admin + staff 전체 알림 (사장님 결정 2026-07-15: 직원도 아침 브리핑 공유 —
  //    브리핑 body 에 마진/원가 등 민감 정보 없음, 주문 수·업무 건수만)
  const [adminIds, staffIds] = await Promise.all([getAdminIds(), getStaffIds()]);
  const allIds = [...adminIds, ...staffIds];
  if (allIds.length === 0) {
    console.warn('[OpsBriefingJob] no active admin/staff found — skipping notification insert');
    return { briefing, notification, recipientCount: 0, dryRun: false };
  }

  await notifyMany(allIds, {
    type:        notification.type,
    title:       notification.title,
    body:        notification.body,
    linkUrl:     notification.linkUrl,
    relatedType: 'ops_briefing',
    relatedId:   null,  // briefing 자체는 row id 없음 (date 기반)
  });

  console.log('[OpsBriefingJob] sent:', {
    title:          notification.title,
    bodyLen:        notification.body.length,
    recipientCount: allIds.length,
    admins:         adminIds.length,
    staff:          staffIds.length,
  });

  return { briefing, notification, recipientCount: allIds.length, dryRun: false };
}

module.exports = { runOperationsBriefingJob };
