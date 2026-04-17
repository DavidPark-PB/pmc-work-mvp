-- Track who actually placed the order (and when) after admin approval.
-- Status transitions: pending → approved → ordered (any staff clicks 주문완료).

alter table purchase_requests
  add column if not exists ordered_by integer,
  add column if not exists ordered_at timestamp;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'purchase_requests_ordered_by_fk'
      and table_name = 'purchase_requests'
  ) then
    alter table purchase_requests
      add constraint purchase_requests_ordered_by_fk
      foreign key (ordered_by) references users(id);
  end if;
end $$;

create index if not exists purchase_requests_ordered_by_idx
  on purchase_requests (ordered_by);
