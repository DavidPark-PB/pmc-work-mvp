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
const { notifyAdmins, getAdminIds } = require('../services/notificationService');

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
    const adminIds = await getAdminIds().catch(() => []);
    console.log('[OpsBriefingJob] dryRun:', {
      title: notification.title,
      bodyLen: notification.body.length,
      recipientHint: `${adminIds.length} admin(s)`,
    });
    return { briefing, notification, recipientCount: adminIds.length, dryRun: true };
  }

  // 4) admin 전체 알림
  const adminIds = await getAdminIds();
  if (adminIds.length === 0) {
    console.warn('[OpsBriefingJob] no active admin found — skipping notification insert');
    return { briefing, notification, recipientCount: 0, dryRun: false };
  }

  await notifyAdmins({
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
    recipientCount: adminIds.length,
  });

  return { briefing, notification, recipientCount: adminIds.length, dryRun: false };
}

module.exports = { runOperationsBriefingJob };
