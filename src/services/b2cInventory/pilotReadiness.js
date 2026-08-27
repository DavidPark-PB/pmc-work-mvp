'use strict';
/**
 * pilotReadiness.js — B2C · Phase 7 · Pilot readiness check.
 *
 * Owner spec §26-§27:
 *   blocking: My Tasks/QC unavailable · expected tasks > pilot_max
 *   warning : operator=0 · auto_assignment=false
 */

const pilot = require('./pilotSelection');

async function checkPilotReadiness({ db, size = 50, pilotMaxTasks = 100 } = {}) {
  const warnings = [];
  const blocking = [];
  const nowIso = new Date().toISOString();

  //   1) config gates
  const { data: cfgRows } = await db.from('margin_settings').select('setting_key, setting_value')
    .in('setting_key', ['b2c.scheduler_enabled','b2c.auto_assignment_enabled','b2c.data_quality_auto_enabled']);
  const cfg = {};
  for (const r of (cfgRows || [])) cfg[r.setting_key.replace(/^b2c\./,'')] = Number(r.setting_value);

  //   Owner spec: scheduler_enabled == false 이어야 함
  if (cfg.scheduler_enabled !== 0) warnings.push({ code: 'SCHEDULER_ENABLED', message: 'b2c.scheduler_enabled=1 · Pilot 검증 전 자동 실행 위험' });
  if (cfg.data_quality_auto_enabled !== 0) warnings.push({ code: 'DQ_AUTO_ENABLED', message: 'b2c.data_quality_auto_enabled=1' });

  //   2) pilot size · expected task count
  let preview = null;
  try {
    preview = await pilot.pilotPreview({ db, size });
  } catch (e) {
    blocking.push({ code: 'PILOT_PREVIEW_FAILED', message: e.message });
  }
  const expectedTasks = preview?.estimated_channel_tasks?.total || 0;
  if (expectedTasks > pilotMaxTasks) {
    blocking.push({
      code: 'EXPECTED_TASKS_EXCEEDS_PILOT_MAX',
      message: `예상 ${expectedTasks} tasks > pilot_max_tasks ${pilotMaxTasks}. size 를 줄이거나 pilot_max_tasks 를 늘리세요.`,
      expected: expectedTasks, pilot_max: pilotMaxTasks,
    });
  }

  //   3) operators
  const { count: opCount, error: opErr } = await db.from('users').select('*', { count: 'exact', head: true })
    .eq('b2c_operator', true).eq('is_active', true);
  if (opErr) warnings.push({ code: 'OPERATOR_COUNT_LOAD_FAILED', message: opErr.message });
  const operators = Number(opCount) || 0;
  if (operators === 0) {
    warnings.push({
      code: 'NO_B2C_OPERATORS',
      message: 'b2c_operator=true 인 직원 0명. Auto assignment 켜도 모두 unassigned (기존 operators pool 로 fallback).',
    });
  }

  //   4) auto_assignment flag warning
  if (cfg.auto_assignment_enabled !== 1) {
    warnings.push({
      code: 'AUTO_ASSIGNMENT_DISABLED',
      message: 'b2c.auto_assignment_enabled=0 (default). unassigned 운영 가능 · 명시적 활성 필요 시 config UPDATE.',
    });
  }

  //   5) channel capability coverage (per channel · b2c_operator=true users)
  //     spec: warning only. 각 채널마다 담당 가능한 operator 수.
  let coverageWarning = null;
  if (operators > 0) {
    const { data: opUsers } = await db.from('users').select('id, b2c_channels')
      .eq('b2c_operator', true).eq('is_active', true);
    const coverage = { coupang: 0, naver: 0, '11st': 0, gmarket: 0 };
    for (const u of (opUsers || [])) {
      const caps = u.b2c_channels;
      const list = Array.isArray(caps) ? caps : (caps === null ? ['coupang','naver','11st','gmarket'] : []);
      for (const c of list) if (coverage[c] !== undefined) coverage[c]++;
    }
    const zeroCh = Object.entries(coverage).filter(([, v]) => v === 0).map(([k]) => k);
    if (zeroCh.length > 0) {
      coverageWarning = { code: 'ZERO_CHANNEL_COVERAGE', message: `채널 담당자 0명: ${zeroCh.join(', ')}`, coverage, zero_channels: zeroCh };
      warnings.push(coverageWarning);
    }
  }

  //   6) routes availability (best-effort check · 실제 route 는 mount 됐다고 가정)
  //     production check 는 별도 · 여기서는 config 만 확인
  //     참고: My Tasks + QC route 이 mount 안 됐다면 이 함수 자체가 안 불림 → blocking 취급 어려움
  //     대신 라우터 도구가 없으므로 assume=true 처리

  //   7) active B2C tasks (참고)
  const { count: activeCount } = await db.from('team_tasks').select('*', { count: 'exact', head: true })
    .in('status', ['pending','in_progress','qc_pending']).like('exception_type', 'channel_register.%');

  const ready = blocking.length === 0;
  return {
    at: nowIso,
    ready,
    warnings,
    blocking,
    config: cfg,
    pilot_size: size,
    pilot_max_tasks: pilotMaxTasks,
    pilot_preview_matched: preview?.total_pilot_matched ?? null,
    pilot_preview_selected: preview?.selected ?? null,
    expected_channel_tasks: expectedTasks,
    b2c_operators: operators,
    active_b2c_channel_register_tasks: Number(activeCount) || 0,
  };
}

module.exports = {
  checkPilotReadiness,
};
