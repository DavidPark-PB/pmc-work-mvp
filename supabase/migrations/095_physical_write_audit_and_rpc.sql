-- 095_physical_write_audit_and_rpc.sql — Phase 8P-5.
--
-- Canonical physical writer atomicity + append-only audit.
--
-- SAFETY:
--   • Additive · zero destructive change to existing tables
--   • BP invariant is enforced by RPC (not app-side) — the writer app
--     validates first, but the RPC re-validates as the final gate
--   • Append-only audit table · never UPDATE / DELETE
--   • RPC operations are atomic (single transaction in PL/pgSQL)
--   • This file is COMMITTED but NOT applied to production. Phase 8P-5
--     ships dry-run only. Owner-triggered apply happens in a later phase
--     with explicit approval.
--
-- Runbook to apply (blocked until Owner OK):
--   supabase db push --file supabase/migrations/095_physical_write_audit_and_rpc.sql
--   staging first · verify constraint behavior + reject-on-BP invariant

-- ─── 1) physical_write_audit · append-only ─────────────────

create table if not exists physical_write_audit (
  id                          bigserial primary key,
  written_at                  timestamptz not null default now(),
  operation                   varchar(50) not null,       -- CREATE_NEW_PHYSICAL | LINK_TO_EXISTING_PHYSICAL | MARK_NON_PHYSICAL
  writer_interface_version    varchar(20) not null,       -- e.g. v8p4.plan · v8p5.rpc1
  idempotency_key             varchar(128) not null,      -- SHA-256 hex over deterministic payload
  owner_confirmation_id       varchar(200),               -- Owner-supplied confirmation id (never a token/secret)

  -- Result identifiers (populated after successful op)
  physical_product_id         integer,
  sku_master_ids              jsonb not null default '[]'::jsonb,

  -- Provenance (populated from Owner decision payload)
  source_review_candidate_id  varchar(200),                -- e.g. 'pcc-3'
  source_review_generated_at  timestamptz,
  evidence_reference          jsonb not null default '{}'::jsonb,     -- listing_ids / product_ids / cohort_bridge

  -- Owner-supplied fields (verbatim · never re-derived)
  proposed_display_name       text,
  owner_note                  text,

  -- Idempotency (payload_fingerprint per operation type)
  constraint uq_physical_write_audit_idem unique (idempotency_key)
);

comment on table physical_write_audit is
  'Phase 8P-5 · append-only canonical writer audit log · UPDATE/DELETE forbidden by trigger below';

create index if not exists idx_physical_write_audit_written_at
  on physical_write_audit(written_at desc);
create index if not exists idx_physical_write_audit_operation
  on physical_write_audit(operation);
create index if not exists idx_physical_write_audit_physical
  on physical_write_audit(physical_product_id)
  where physical_product_id is not null;

-- ─── 2) Append-only enforcement · Phase 8P-6 activated ─────
--
-- Function + triggers ship ENABLED (Phase 8P-6). Owner review completed
-- on migration file · staging apply → production apply.
--
-- If your operations team needs to run a data-fix UPDATE/DELETE on this
-- table (accepted only via a documented maintenance workflow), they
-- must DROP the trigger explicitly and DROP it back afterwards. The
-- table is append-only by policy.

create or replace function physical_write_audit_reject_mutation()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_catalog
as $$
begin
  raise exception 'physical_write_audit is append-only · UPDATE/DELETE not permitted (Phase 8P-6)';
end $$;

drop trigger if exists t_physical_write_audit_no_update on physical_write_audit;
create trigger t_physical_write_audit_no_update
  before update on physical_write_audit
  for each row execute function physical_write_audit_reject_mutation();

drop trigger if exists t_physical_write_audit_no_delete on physical_write_audit;
create trigger t_physical_write_audit_no_delete
  before delete on physical_write_audit
  for each row execute function physical_write_audit_reject_mutation();

-- ─── 3) BP invariant constant (immutable in DB · reject-triggers below) ─
--
-- Owner directive: physical_product_id = 1 (Battle Partners) with
-- sku_master_link authoritative sku_master_ids [2194, 3120] MUST NOT be
-- mutated by the canonical writer path. Any INSERT into sku_master_link
-- referencing sellable_units belonging to physical_product_id=1 that
-- adds a sku_master_id not in [2194, 3120] · OR any DELETE removing
-- [2194, 3120] · is rejected.
--
-- Enforced in the RPC below by a pre-INSERT check that references the
-- following constants. Trigger-based enforcement is deferred to a future
-- migration once Owner reviews the exact enforcement scope.

-- ─── 4) RPC · atomic CREATE_NEW_PHYSICAL ──────────────────
--
-- Ships DISABLED (function definition present but never called by dry-run).
-- The app-side writer only produces plans in Phase 8P-5.

create or replace function apply_canonical_create_physical(
  p_payload jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_catalog
as $$
declare
  v_display_name        text := p_payload->>'proposed_display_name';
  v_sku_master_ids      integer[] := array(select jsonb_array_elements_text(p_payload->'confirmed_sku_master_ids'))::integer[];
  v_writer_version      text := p_payload->>'writer_interface_version';
  v_idempotency_key     text := p_payload->>'idempotency_key';
  v_owner_confirmed     boolean := coalesce((p_payload->>'owner_confirmed')::boolean, false);
  v_source_candidate_id text := p_payload->>'source_review_candidate_id';
  v_source_generated_at timestamptz := (p_payload->>'source_review_generated_at')::timestamptz;
  v_evidence            jsonb := coalesce(p_payload->'evidence_reference', '{}'::jsonb);
  v_new_physical_id     integer;
  v_new_sellable_id     integer;
  v_existing_audit      record;
  v_bp_id               integer := 1;
  v_bp_locked           integer[] := array[2194, 3120]::integer[];
  v_sku_id              integer;
begin
  -- 1) Owner confirmation gate
  if not v_owner_confirmed then
    raise exception 'apply_canonical_create_physical: owner_confirmed must be true';
  end if;
  if v_display_name is null or length(trim(v_display_name)) = 0 then
    raise exception 'apply_canonical_create_physical: proposed_display_name required';
  end if;
  --  Phase 8P-6 · bound Owner-supplied display name length to prevent
  --  unbounded storage / index bloat / DoS-shape input.
  if length(trim(v_display_name)) > 500 then
    raise exception 'apply_canonical_create_physical: proposed_display_name exceeds 500 chars';
  end if;
  if v_sku_master_ids is null or array_length(v_sku_master_ids, 1) is null then
    raise exception 'apply_canonical_create_physical: confirmed_sku_master_ids required (non-empty array)';
  end if;
  if v_idempotency_key is null or length(v_idempotency_key) < 32 then
    raise exception 'apply_canonical_create_physical: idempotency_key required (>=32 chars)';
  end if;

  -- 2) BP invariant · none of the incoming SKU IDs may collide with
  --    BP's locked mapping unless the caller is a maintenance workflow
  --    (this RPC never allows it).
  foreach v_sku_id in array v_sku_master_ids loop
    if v_sku_id = any (v_bp_locked) then
      raise exception 'apply_canonical_create_physical: BP invariant violated · sku_master_id % is locked to physical_product_id=%', v_sku_id, v_bp_id;
    end if;
  end loop;

  -- 3) Idempotency · re-executing the same idempotency_key returns the
  --    previous result instead of creating a duplicate.
  select * into v_existing_audit
    from physical_write_audit
   where idempotency_key = v_idempotency_key
   limit 1;
  if found then
    return jsonb_build_object(
      'status', 'DUPLICATE',
      'audit_id', v_existing_audit.id,
      'physical_product_id', v_existing_audit.physical_product_id,
      'operation', v_existing_audit.operation,
      'note', 'idempotent · previous write returned'
    );
  end if;

  -- 4) Reject linking to sku_master rows already mapped elsewhere.
  --    The writer path only handles NEW mappings.
  if exists (
    select 1 from sku_master_link where sku_master_id = any(v_sku_master_ids)
  ) then
    raise exception 'apply_canonical_create_physical: one or more sku_master_ids already have sku_master_link · use LINK_TO_EXISTING or unmap first';
  end if;

  -- 5) Atomic transaction (all-or-nothing · PL/pgSQL block ensures rollback on failure)
  insert into physical_products (canonical_title)
    values (v_display_name)
    returning id into v_new_physical_id;

  insert into sellable_units (display_name, variant_kind, status)
    values (v_display_name || ' (auto-created 1-unit sellable)', 'base', 'active')
    returning id into v_new_sellable_id;

  insert into sellable_unit_components (sellable_unit_id, physical_product_id, quantity_per_unit, role)
    values (v_new_sellable_id, v_new_physical_id, 1, 'primary');

  -- Attach every confirmed SKU
  foreach v_sku_id in array v_sku_master_ids loop
    insert into sku_master_link (sku_master_id, sellable_unit_id, mapping_confidence, notes)
      values (v_sku_id, v_new_sellable_id, 'manual', 'phase_8p5_owner_confirmed_create · ' || v_source_candidate_id);
  end loop;

  -- 6) Append-only audit
  insert into physical_write_audit (
    operation, writer_interface_version, idempotency_key, owner_confirmation_id,
    physical_product_id, sku_master_ids,
    source_review_candidate_id, source_review_generated_at, evidence_reference,
    proposed_display_name, owner_note
  ) values (
    'CREATE_NEW_PHYSICAL', v_writer_version, v_idempotency_key, p_payload->>'owner_confirmation_id',
    v_new_physical_id, to_jsonb(v_sku_master_ids),
    v_source_candidate_id, v_source_generated_at, v_evidence,
    v_display_name, p_payload->>'owner_note'
  );

  return jsonb_build_object(
    'status', 'INSERTED',
    'physical_product_id', v_new_physical_id,
    'sellable_unit_id', v_new_sellable_id,
    'sku_master_ids', v_sku_master_ids
  );
end $$;

-- ─── 5) RPC · atomic LINK_TO_EXISTING_PHYSICAL ────────────
create or replace function apply_canonical_link_physical(
  p_payload jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_catalog
as $$
declare
  v_target              integer := (p_payload->>'target_physical_product_id')::integer;
  v_sku_master_ids      integer[] := array(select jsonb_array_elements_text(p_payload->'confirmed_sku_master_ids'))::integer[];
  v_writer_version      text := p_payload->>'writer_interface_version';
  v_idempotency_key     text := p_payload->>'idempotency_key';
  v_owner_confirmed     boolean := coalesce((p_payload->>'owner_confirmed')::boolean, false);
  v_bridge              text := p_payload->>'owner_authoritative_bridge';
  v_bp_id               integer := 1;
  v_bp_locked           integer[] := array[2194, 3120]::integer[];
  v_sellable_id         integer;
  v_existing_audit      record;
  v_sku_id              integer;
begin
  if not v_owner_confirmed then
    raise exception 'apply_canonical_link_physical: owner_confirmed must be true';
  end if;
  if v_target is null then
    raise exception 'apply_canonical_link_physical: target_physical_product_id required';
  end if;
  if v_sku_master_ids is null or array_length(v_sku_master_ids, 1) is null then
    raise exception 'apply_canonical_link_physical: confirmed_sku_master_ids required';
  end if;
  if v_bridge is null or length(trim(v_bridge)) < 3 then
    raise exception 'apply_canonical_link_physical: owner_authoritative_bridge required (Owner-supplied evidence · not fuzzy title match)';
  end if;
  if v_idempotency_key is null or length(v_idempotency_key) < 32 then
    raise exception 'apply_canonical_link_physical: idempotency_key required';
  end if;

  -- BP invariant · reject any LINK that touches physical_product_id=1
  if v_target = v_bp_id then
    raise exception 'apply_canonical_link_physical: BP invariant · physical_product_id=1 mapping is locked · maintenance workflow required (not this writer)';
  end if;

  -- Idempotency
  select * into v_existing_audit from physical_write_audit where idempotency_key = v_idempotency_key limit 1;
  if found then
    return jsonb_build_object('status', 'DUPLICATE', 'audit_id', v_existing_audit.id, 'operation', v_existing_audit.operation);
  end if;

  -- Target physical must exist
  if not exists (select 1 from physical_products where id = v_target) then
    raise exception 'apply_canonical_link_physical: target physical_product_id=% does not exist', v_target;
  end if;

  -- Resolve target sellable_unit_id (qty=1 primary component for the target physical)
  select suc.sellable_unit_id into v_sellable_id
    from sellable_unit_components suc
   where suc.physical_product_id = v_target
     and suc.quantity_per_unit = 1
   order by suc.sellable_unit_id
   limit 1;
  if v_sellable_id is null then
    raise exception 'apply_canonical_link_physical: target physical_product_id=% has no qty=1 sellable_unit_component · cannot LINK', v_target;
  end if;

  -- Reject SKUs that already have sku_master_link
  if exists (select 1 from sku_master_link where sku_master_id = any(v_sku_master_ids)) then
    raise exception 'apply_canonical_link_physical: one or more sku_master_ids already have sku_master_link';
  end if;

  foreach v_sku_id in array v_sku_master_ids loop
    insert into sku_master_link (sku_master_id, sellable_unit_id, mapping_confidence, notes)
      values (v_sku_id, v_sellable_id, 'manual', 'phase_8p5_owner_confirmed_link · bridge=' || left(v_bridge, 100));
  end loop;

  insert into physical_write_audit (
    operation, writer_interface_version, idempotency_key, owner_confirmation_id,
    physical_product_id, sku_master_ids,
    source_review_candidate_id, evidence_reference,
    proposed_display_name, owner_note
  ) values (
    'LINK_TO_EXISTING_PHYSICAL', v_writer_version, v_idempotency_key, p_payload->>'owner_confirmation_id',
    v_target, to_jsonb(v_sku_master_ids),
    p_payload->>'source_review_candidate_id',
    jsonb_build_object('authoritative_bridge', v_bridge),
    null, p_payload->>'owner_note'
  );

  return jsonb_build_object('status', 'INSERTED', 'physical_product_id', v_target, 'sku_master_ids', v_sku_master_ids);
end $$;

-- ─── 6) Permission minimization (Phase 8P-6) ──────────────
--
-- Postgres default GRANTs EXECUTE on functions to PUBLIC. In Supabase
-- that includes the `anon` role. This block revokes that default and
-- grants execution only to `service_role` — the backend role that the
-- canonical writer path uses. `anon` / `authenticated` cannot invoke
-- these RPCs directly.
--
-- The physical_write_audit table itself is table-guard-only (append-only
-- triggers above · plus service_role INSERT via RPC). No direct grants
-- required beyond default schema privileges.

revoke execute on function apply_canonical_create_physical(jsonb) from public;
revoke execute on function apply_canonical_link_physical(jsonb)   from public;
-- Explicit revoke for Supabase's anon + authenticated (idempotent · safe if role missing)
do $revoke$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function apply_canonical_create_physical(jsonb) from anon';
    execute 'revoke execute on function apply_canonical_link_physical(jsonb)   from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function apply_canonical_create_physical(jsonb) from authenticated';
    execute 'revoke execute on function apply_canonical_link_physical(jsonb)   from authenticated';
  end if;
end $revoke$;

-- Grant EXECUTE to service_role only (Supabase backend role · the canonical writer path uses this)
do $grant$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function apply_canonical_create_physical(jsonb) to service_role';
    execute 'grant execute on function apply_canonical_link_physical(jsonb)   to service_role';
  end if;
end $grant$;

-- Rollback (manual · after Owner approval):
--   drop function if exists apply_canonical_link_physical(jsonb);
--   drop function if exists apply_canonical_create_physical(jsonb);
--   drop index if exists idx_physical_write_audit_physical;
--   drop index if exists idx_physical_write_audit_operation;
--   drop index if exists idx_physical_write_audit_written_at;
--   drop table if exists physical_write_audit;
