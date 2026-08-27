'use strict';
/**
 * explicitAssignment.js — B2C · Phase 7.6 · EXPLICIT_CHANNEL_OWNER assignment.
 *
 * Owner directive (2026-08-26):
 *   · Wave Pilot 전용 명시 배정. Global auto_assignment_enabled 유지 OFF.
 *   · channel_owners = { coupang: userId, naver: userId, ... }
 *   · 각 owner 는 반드시 is_active=true AND b2c_operator=true.
 *   · user.b2c_channels 가 명시된 경우 해당 channel 포함해야 함.
 *   · 부분 생성 금지 · 조건 불충족 시 전체 요청 실패.
 *
 * Pure functions · testable · no I/O.
 */

const AUTO_CHANNELS = ['coupang', 'naver', '11st', 'gmarket'];

//   ── Pure validation ──────────────────────────────────
//   channelOwners: { [channel]: userId }
//   channelsInPlan: 이 refill 에 포함된 채널 unique list (예: ['coupang', 'naver', '11st', 'gmarket'])
//   users: [{ id, username, is_active, b2c_operator, b2c_channels }]
//   returns: { ok, errors: [{ channel, code, ... }] }
function validateExplicitChannelOwners({ channelOwners, channelsInPlan, users }) {
  const errors = [];
  if (!channelOwners || typeof channelOwners !== 'object') {
    return { ok: false, errors: [{ code: 'CHANNEL_OWNERS_REQUIRED', message: 'channel_owners 객체 필요' }] };
  }
  const byId = new Map((users || []).map(u => [Number(u.id), u]));
  const uniqueChannels = Array.from(new Set(channelsInPlan || []));

  for (const ch of uniqueChannels) {
    const uid = channelOwners[ch];
    if (uid == null) {
      errors.push({ channel: ch, code: 'MISSING_CHANNEL_OWNER', message: `channel ${ch} 에 owner 지정 안 됨` });
      continue;
    }
    const u = byId.get(Number(uid));
    if (!u) {
      errors.push({ channel: ch, user_id: uid, code: 'INVALID_CHANNEL_OWNER', message: `user_id=${uid} 없음` });
      continue;
    }
    if (u.is_active !== true) {
      errors.push({ channel: ch, user_id: uid, code: 'INVALID_CHANNEL_OWNER', message: `user_id=${uid} is_active=false` });
      continue;
    }
    if (u.b2c_operator !== true) {
      errors.push({ channel: ch, user_id: uid, code: 'INVALID_CHANNEL_OWNER', message: `user_id=${uid} b2c_operator=false` });
      continue;
    }
    //   capability check: b2c_channels null 은 모두 허용 · array 이면 channel 포함해야
    const caps = u.b2c_channels;
    if (caps !== null && caps !== undefined) {
      if (!Array.isArray(caps)) {
        errors.push({ channel: ch, user_id: uid, code: 'CHANNEL_CAPABILITY_MISMATCH', message: `user_id=${uid} b2c_channels 타입 이상` });
        continue;
      }
      if (!caps.includes(ch)) {
        errors.push({
          channel: ch, user_id: uid, code: 'CHANNEL_CAPABILITY_MISMATCH',
          message: `user_id=${uid} b2c_channels=[${caps.join(',')}] · channel=${ch} 미포함`,
          user_channels: caps,
        });
      }
    }
  }

  //   추가 채널 (plan 에 없는 채널을 owner 지정한 경우) 은 warning 아니라 무시 (허용)
  return { ok: errors.length === 0, errors };
}

//   ── Pure applier ─────────────────────────────────────
//   plan: [task rows]
//   channelOwners: { [channel]: userId }
//   returns plan with assignee_id/assignee_scope 설정
function applyExplicitAssignment({ plan, channelOwners }) {
  return plan.map(t => {
    const uid = channelOwners && channelOwners[t.channel];
    if (uid == null) {
      //   validation 을 이미 통과했다면 여기 도달 안 함 · 방어적 fallback
      return { ...t, assignee_id: null, assignee_scope: 'operators' };
    }
    return { ...t, assignee_id: Number(uid), assignee_scope: 'specific' };
  });
}

//   ── DB layer · 해당 owner user 들 로드 ───────────
async function loadOwnerUsers({ db, userIds }) {
  const uniqueIds = Array.from(new Set((userIds || []).map(Number).filter(Number.isFinite)));
  if (uniqueIds.length === 0) return [];
  const { data, error } = await db.from('users')
    .select('id, username, display_name, is_active, b2c_operator, b2c_channels')
    .in('id', uniqueIds);
  if (error) throw new Error('owner users load: ' + error.message);
  return data || [];
}

//   ── Assignment summary for preview ────────────────
//   returns: { total_tasks, unassigned_count, by_channel: { [ch]: { count, assignee_id, assignee_username } } }
function summarizeAssignment({ plan, users }) {
  const byChannel = {};
  const byId = new Map((users || []).map(u => [Number(u.id), u]));
  let unassigned = 0;
  for (const t of plan) {
    const ch = t.channel;
    if (!byChannel[ch]) byChannel[ch] = { channel: ch, task_count: 0, assignee_id: t.assignee_id, assignee_username: null };
    byChannel[ch].task_count++;
    if (t.assignee_id == null) unassigned++;
    if (t.assignee_id != null && !byChannel[ch].assignee_username) {
      const u = byId.get(Number(t.assignee_id));
      byChannel[ch].assignee_username = u ? u.username : null;
    }
  }
  return {
    total_tasks: plan.length,
    unassigned_count: unassigned,
    all_assigned: unassigned === 0,
    by_channel: byChannel,
  };
}

module.exports = {
  AUTO_CHANNELS,
  validateExplicitChannelOwners,
  applyExplicitAssignment,
  loadOwnerUsers,
  summarizeAssignment,
};
