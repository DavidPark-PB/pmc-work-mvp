# Phase 8P-6 · Staging Environment Identification Checklist

**This document is READ-ONLY guidance for Owner. Claude did NOT apply migration 095 in this phase.**

Migration 095 (`supabase/migrations/095_physical_write_audit_and_rpc.sql`) is production-ready:
- append-only triggers activated
- REVOKE EXECUTE from PUBLIC/anon/authenticated
- GRANT EXECUTE to service_role only
- SET search_path on every SECURITY DEFINER function
- display_name length bound (500 chars)

Before ANY apply attempt (staging or production), Owner MUST verify the environment identification below.

---

## Owner-completable verification checklist

Fill in each `<REQUIRED>` before executing any `supabase db push` or equivalent.

### 1. Environment identification

| Check | Value | Verified |
|---|---|---|
| Supabase project ref | `<REQUIRED · e.g. abcdefghijklmno>` | ☐ |
| Supabase URL host | `<REQUIRED · e.g. staging-abc.supabase.co>` | ☐ |
| DB name | `<REQUIRED>` | ☐ |
| Environment marker (env var / config flag) | `<REQUIRED · e.g. STAGE=staging>` | ☐ |
| Production URL (for comparison · MUST DIFFER) | `<REQUIRED · e.g. prod-xyz.supabase.co>` | ☐ |
| Production project ref (for comparison · MUST DIFFER) | `<REQUIRED>` | ☐ |
| Confirm staging URL ≠ production URL | ☐ YES / ☐ NO | ☐ |
| Confirm staging project ref ≠ production project ref | ☐ YES / ☐ NO | ☐ |

**If any of the above shows overlap or ambiguity → STOP. Do NOT apply.**

### 2. Credential separation

| Check | Verified |
|---|---|
| `SUPABASE_SERVICE_KEY` for staging is DIFFERENT from production | ☐ |
| Local `.env` file used for staging apply is NOT the production `.env` | ☐ |
| `SUPABASE_URL` env var used for staging apply points to staging host | ☐ |
| Backup of production DB confirmed within last 24h (defense-in-depth) | ☐ |

### 3. Migration 095 pre-apply diff

| Check | Verified |
|---|---|
| Diff of `supabase/migrations/095_physical_write_audit_and_rpc.sql` against staging schema shows only ADDITIVE changes (new table + 2 RPC functions + 2 triggers + REVOKE/GRANT) | ☐ |
| No existing `physical_write_audit` table (should be additive) | ☐ |
| No existing `apply_canonical_create_physical` / `apply_canonical_link_physical` functions | ☐ |
| `physical_products` / `sellable_units` / `sellable_unit_components` / `sku_master_link` tables exist with expected schema (mig 085-088 already applied on staging) | ☐ |

### 4. Post-apply verification (before touching production)

Run these READ-ONLY checks on staging AFTER apply:

```sql
-- Confirm append-only triggers exist
select tgname from pg_trigger
 where tgrelid = 'physical_write_audit'::regclass
   and tgname in ('t_physical_write_audit_no_update','t_physical_write_audit_no_delete');
-- Expect 2 rows

-- Confirm REVOKE succeeded (public should have no EXECUTE)
select grantee, privilege_type from information_schema.routine_privileges
 where routine_name in ('apply_canonical_create_physical','apply_canonical_link_physical');
-- Expect service_role only

-- Confirm SET search_path was applied
select proname, proconfig from pg_proc
 where proname in ('apply_canonical_create_physical','apply_canonical_link_physical',
                   'physical_write_audit_reject_mutation');
-- Expect proconfig containing 'search_path=public,pg_catalog'

-- Confirm unique constraint
select indexname from pg_indexes
 where tablename = 'physical_write_audit' and indexname = 'uq_physical_write_audit_idem';
-- Expect 1 row
```

### 5. Synthetic RPC canary on staging

After apply · run a SYNTHETIC test (never against real production SKUs):

1. Insert a test physical_product manually
2. Insert a test sku_master row
3. Invoke `apply_canonical_create_physical` with a synthetic payload
4. Verify:
   - `physical_write_audit` row inserted
   - `sku_master_link` inserted
   - Attempting UPDATE on `physical_write_audit` → REJECTED
   - Attempting DELETE on `physical_write_audit` → REJECTED
   - Re-running same idempotency_key → returns `{status: 'DUPLICATE'}`
   - Payload with BP-locked sku → REJECTED
   - Payload with target=1 (BP) via LINK RPC → REJECTED
   - Payload with `owner_confirmed=false` → REJECTED

### 6. Owner approval sign-off

Before production apply:

| Sign-off | Signed by | Date |
|---|---|---|
| Owner reviewed migration 095 SQL end-to-end | `<REQUIRED>` | `<REQUIRED>` |
| Owner completed staging apply + all verifications | `<REQUIRED>` | `<REQUIRED>` |
| Owner reviewed SKU 2944 preflight and confirmed READY | `<REQUIRED>` | `<REQUIRED>` |
| Owner approves production migration 095 apply | `<REQUIRED>` | `<REQUIRED>` |

---

## What Phase 8P-6 did NOT do

- ❌ Did NOT apply migration 095 to any environment
- ❌ Did NOT execute any RPC
- ❌ Did NOT create any physical_products row
- ❌ Did NOT insert any sku_master_link row
- ❌ Did NOT write to physical_write_audit
- ❌ Did NOT contact marketplace / notification / scheduler
- ❌ Did NOT push git commits

## Owner's ONE READ-ONLY next command

```bash
cd /Users/parksungmin/pmc-work-mvp && \
TELEGRAM_KILL_SWITCH=true \
DISABLE_ALL_NOTIFICATIONS=true \
SCHEDULER_DISABLED=true \
AGENTS_DISABLED=true \
node scripts/oms-canary-preflight-sku-2944.js \
  --input docs/phase-8p6-sku-2944-owner-review-packet.json
```

Expected output: **BLOCKED** with `block_reasons` including `owner_confirmed_must_be_true` and multiple `<REQUIRED>` field notes.

Owner then fills in the `<REQUIRED>` fields in a private copy (outside repo), re-runs the CLI with the private path, expects **READY**. This is the last automated step in Phase 8P-6. Anything further requires a separate Owner-approved phase.
