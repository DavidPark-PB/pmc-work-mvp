/**
 * team_task_recipients 테이블 — 수신자별 완료 상태 추적
 *
 * 백필:
 *  - specific task: 기존 assignee_id로 recipient 1개 생성 (status, completed_at, note 승계)
 *  - broadcast task: 활성 staff 전원으로 recipient 생성 (모두 pending으로 리셋)
 */
const path = require('path');
require('dotenv').config({ path: path.join('automation', '.env') });
const { Client } = require('pg');

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  console.log('[migrate] connected');

  const statements = [
    `CREATE TABLE IF NOT EXISTS team_task_recipients (
      id serial PRIMARY KEY,
      task_id integer NOT NULL REFERENCES team_tasks(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id),
      status varchar(20) DEFAULT 'pending' NOT NULL,
      completed_at timestamp,
      completion_note text,
      created_at timestamp DEFAULT now() NOT NULL,
      UNIQUE (task_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS team_task_recipients_user_status_idx ON team_task_recipients (user_id, status)`,
    `CREATE INDEX IF NOT EXISTS team_task_recipients_task_idx ON team_task_recipients (task_id)`,
  ];

  for (const stmt of statements) {
    try {
      await client.query(stmt);
      console.log('  ✓', stmt.trim().split('\n')[0].slice(0, 80));
    } catch (e) {
      console.error('  ✗', stmt.trim().split('\n')[0].slice(0, 80), '→', e.message);
    }
  }

  // 백필 1: specific task → 1 recipient (기존 상태 승계)
  const r1 = await client.query(`
    INSERT INTO team_task_recipients (task_id, user_id, status, completed_at, completion_note)
    SELECT id, assignee_id, status, completed_at, completion_note
    FROM team_tasks
    WHERE assignee_scope = 'specific' AND assignee_id IS NOT NULL
    ON CONFLICT (task_id, user_id) DO NOTHING
    RETURNING id
  `);
  console.log(`[backfill] specific tasks → ${r1.rowCount} recipients`);

  // 백필 2: broadcast task → 활성 staff 전원 (pending)
  const r2 = await client.query(`
    INSERT INTO team_task_recipients (task_id, user_id, status)
    SELECT t.id, u.id, 'pending'
    FROM team_tasks t
    CROSS JOIN users u
    WHERE t.assignee_scope = 'all'
      AND u.role = 'staff'
      AND u.is_active = true
    ON CONFLICT (task_id, user_id) DO NOTHING
    RETURNING id
  `);
  console.log(`[backfill] broadcast tasks × staff → ${r2.rowCount} recipients`);

  // 확인
  const total = await client.query('SELECT COUNT(*)::int AS n FROM team_task_recipients');
  const distByStatus = await client.query('SELECT status, COUNT(*)::int AS n FROM team_task_recipients GROUP BY status');
  console.log(`[migrate] 총 recipient: ${total.rows[0].n}`);
  console.log('[migrate] status 분포:', distByStatus.rows);

  await client.end();
  console.log('[migrate] done');
}

run().catch(e => { console.error(e); process.exit(1); });
