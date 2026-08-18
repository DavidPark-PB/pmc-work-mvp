-- 094_judgment_snapshots.sql — Phase 8O · Judgment History persistence.
--
-- Append-only snapshot store for the Owner Console judgment history.
-- Every write MUST come through judgmentHistoryRepository.appendSnapshot,
-- which:
--   • serializes the pure `buildJudgmentHistorySnapshot()` output verbatim
--   • enforces (physical_product_id, snapshot_at, fingerprint) uniqueness
--   • never UPDATEs, only INSERTs
--
-- SAFETY:
--   • Additive schema · zero destructive changes to existing tables
--   • NO trigger changes elsewhere · NO row-level policy changes
--   • DB is a STORE only — no scoring / decision logic lives here
--   • This file is COMMITTED but MUST NOT be applied to production until
--     Owner explicitly approves (Phase 8O safety envelope · §13)
--
-- Runbook to apply (blocked until Owner OK):
--   supabase db push --file supabase/migrations/094_judgment_snapshots.sql
--   (dev/staging first · verify append-only via a rejected-UPDATE test)

-- ─── 1) judgment_snapshots · append-only history ────────────

create table if not exists judgment_snapshots (
  id                          bigserial primary key,
  physical_product_id         integer not null,
  product_identity_key        varchar(200) not null,               -- canonical: physical_products.canonical_title or set_code+language+unit_type
  snapshot_at                 timestamptz not null,                -- caller-supplied timestamp of the observed state
  created_at                  timestamptz not null default now(),  -- server insert time (append-only proof)
  schema_version              varchar(20)  not null default 'v8o.1',
  source_generated_at         timestamptz,                          -- ownerDecision.generated_at

  -- Decision headline (denormalized for cheap read/list)
  decision                    varchar(50),
  priority                    integer,
  urgency                     varchar(30),
  confidence_level            varchar(20),
  confidence_overall_tier     varchar(20),

  -- Full structured payload (see judgmentHistorySnapshotService.js output)
  confidence_by_dimension     jsonb not null default '{}'::jsonb,
  key_reasons                 jsonb not null default '{}'::jsonb,
  cost_context_snapshot       jsonb not null default '{}'::jsonb,
  financial_metrics_summary   jsonb not null default '{}'::jsonb,
  provenance_summary          jsonb not null default '{}'::jsonb,

  -- Idempotency + audit
  fingerprint                 varchar(128) not null,               -- SHA-256 hex over deterministic serialization
  written_by                  varchar(100),                        -- api/cli/agent identifier · never a token/secret

  -- Payload byte-size safety cap enforced at repo level too (32 KB target)
  payload_bytes               integer

  -- Foreign key intentionally NOT declared here — physical_products can be
  -- rebuilt or renumbered during identity work; the product_identity_key
  -- string is the durable anchor.
);

-- Deterministic list ordering: physical → newest first
create index if not exists idx_judgment_snapshots_physical_created
  on judgment_snapshots(physical_product_id, snapshot_at desc, id desc);

-- Fingerprint idempotency (same physical + same fingerprint = duplicate write)
create unique index if not exists uq_judgment_snapshots_physical_fingerprint
  on judgment_snapshots(physical_product_id, fingerprint);

-- Cross-product time-range queries (Phase 8N future audit)
create index if not exists idx_judgment_snapshots_snapshot_at
  on judgment_snapshots(snapshot_at desc);

comment on table judgment_snapshots is
  'Phase 8O · append-only judgment history · never UPDATE · never DELETE except via approved retention job';

-- ─── 2) Append-only enforcement (no UPDATE / no DELETE) ─────
-- Owner approval required to run this block · the file ships with it
-- disabled behind a NOTE. Uncomment when applying to production.
--
-- create or replace function judgment_snapshots_reject_mutation()
--   returns trigger language plpgsql as $$
-- begin
--   raise exception 'judgment_snapshots is append-only · UPDATE/DELETE not permitted (Phase 8O)';
-- end $$;
--
-- create trigger t_judgment_snapshots_no_update
--   before update on judgment_snapshots
--   for each row execute function judgment_snapshots_reject_mutation();
-- create trigger t_judgment_snapshots_no_delete
--   before delete on judgment_snapshots
--   for each row execute function judgment_snapshots_reject_mutation();
