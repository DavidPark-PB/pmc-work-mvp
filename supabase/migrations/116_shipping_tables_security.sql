-- 116_shipping_tables_security.sql
-- PMC-CCOREA-SHIPPING-1B SECURITY HARDENING (2026-09-13).
-- Owner directive: shipping tables live in the `public` schema which is
-- exposed via Supabase Data API. Even though grants to anon/authenticated
-- are currently absent, defense-in-depth requires:
--   (1) Row-Level Security enabled on every new shipping table
--   (2) Explicit REVOKE ALL from anon + authenticated (belt-and-suspenders
--       against future ALTER DEFAULT PRIVILEGES / GRANT accidents)
--   (3) Same REVOKE for the tables' backing sequences
--
-- Access model after this migration:
--   · service_role       — kept exactly as before (backend uses it)
--   · postgres/owner     — unchanged (migrations + admin console)
--   · anon               — no privileges, no policies → PostgREST returns 401/403
--   · authenticated      — no privileges, no policies → same
--
-- Admin UI still works because the main service uses service_role via the
-- backend, then applies application-layer requireAdmin to the /rate-admin
-- routes. Automation uses /api/internal/shipping which is guarded by the
-- SHIPPING_QUOTE_INTERNAL_TOKEN bearer middleware.
--
-- Rollback (manual, if needed):
--   alter table public.shipping_quote_shadow_results disable row level security;
--   alter table public.shipping_policy_bands         disable row level security;
--   alter table public.shipping_surcharges           disable row level security;
--   alter table public.shipping_rate_brackets        disable row level security;
--   alter table public.shipping_countries            disable row level security;
--   alter table public.shipping_services             disable row level security;
--   alter table public.shipping_rate_versions        disable row level security;
--   -- explicit re-grants below only if the caller needs to undo the REVOKE.

-- 1. RLS ON — protects against any GRANT that might arrive later.
alter table public.shipping_rate_versions        enable row level security;
alter table public.shipping_services             enable row level security;
alter table public.shipping_countries            enable row level security;
alter table public.shipping_rate_brackets        enable row level security;
alter table public.shipping_surcharges           enable row level security;
alter table public.shipping_policy_bands         enable row level security;
alter table public.shipping_quote_shadow_results enable row level security;

-- 2. Table-level REVOKE for the two Data-API roles.
--    Idempotent — REVOKE on a role that has no privileges is a no-op.
revoke all privileges on table public.shipping_rate_versions        from anon, authenticated;
revoke all privileges on table public.shipping_services             from anon, authenticated;
revoke all privileges on table public.shipping_countries            from anon, authenticated;
revoke all privileges on table public.shipping_rate_brackets        from anon, authenticated;
revoke all privileges on table public.shipping_surcharges           from anon, authenticated;
revoke all privileges on table public.shipping_policy_bands         from anon, authenticated;
revoke all privileges on table public.shipping_quote_shadow_results from anon, authenticated;

-- 3. Sequence-level REVOKE — a client that could USAGE/SELECT the sequence
--    could probe row counts even without table access. Lock them down.
revoke all privileges on sequence public.shipping_rate_versions_id_seq        from anon, authenticated;
revoke all privileges on sequence public.shipping_services_id_seq             from anon, authenticated;
revoke all privileges on sequence public.shipping_countries_id_seq            from anon, authenticated;
revoke all privileges on sequence public.shipping_rate_brackets_id_seq        from anon, authenticated;
revoke all privileges on sequence public.shipping_surcharges_id_seq           from anon, authenticated;
revoke all privileges on sequence public.shipping_policy_bands_id_seq         from anon, authenticated;
revoke all privileges on sequence public.shipping_quote_shadow_results_id_seq from anon, authenticated;

-- NO client-facing RLS policies are created here — this migration deliberately
-- makes the tables INACCESSIBLE to anon / authenticated at both the grant
-- level AND the RLS level. All application access flows through service_role
-- (backend main service + internal-token route) — no browser client should
-- ever touch these tables directly.
