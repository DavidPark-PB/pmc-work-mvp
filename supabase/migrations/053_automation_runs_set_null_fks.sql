-- automation_runs 의 related_task_id / related_sku_id FK 를 ON DELETE SET NULL 로 변경.
--
-- 문제 (사장님 보고 2026-05-22):
--   업무 지시(team_tasks) 를 삭제하려고 하면 실패. 원인은 audit 시스템이 만든
--   automation_runs row 가 related_task_id 로 task 를 참조하는데, 기존 FK 가
--   ON DELETE NO ACTION (default) 이라 Postgres 가 parent 삭제를 거부.
--   결과적으로 admin 도 자기가 만든 task 를 삭제 못 함.
--
-- 해결:
--   ON DELETE SET NULL — task 가 삭제되면 audit row 의 related_task_id 는 NULL
--   로 정리되고 audit 행 자체는 보존됨 (역사 손실 X, 단지 링크만 끊김).
--   CASCADE 는 audit 까지 함께 지워버려서 부적절.
--
-- 같은 패턴인 related_sku_id 도 함께 정합. sku_master 는 soft-delete (status=discontinued)
-- 가 표준이라 hard delete 가 잘 안 일어나지만, 안전 정합화 차원에서 함께 변경.

alter table automation_runs
  drop constraint if exists automation_runs_related_task_id_fkey,
  add  constraint automation_runs_related_task_id_fkey
       foreign key (related_task_id) references team_tasks(id) on delete set null;

alter table automation_runs
  drop constraint if exists automation_runs_related_sku_id_fkey,
  add  constraint automation_runs_related_sku_id_fkey
       foreign key (related_sku_id) references sku_master(id) on delete set null;
