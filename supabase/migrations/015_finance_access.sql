-- Phase 1: 재무 접근 권한.
-- 지출 관리는 사장님 + 지정된 소수만 보고 편집하도록 제한.
-- isAdmin이 자동으로 포함되므로 이 컬럼은 비-admin 중에서 권한 부여할 사람을 표시.

alter table users
  add column if not exists can_manage_finance boolean not null default false;

create index if not exists users_finance_access_idx
  on users (can_manage_finance)
  where can_manage_finance = true;
