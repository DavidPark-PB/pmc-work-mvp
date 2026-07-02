-- Hermes Phase 11E — Internal eBay listing quality packet confirmation gate.
-- Internal confirmation fields only.
-- No marketplace response fields. No execution result fields.

alter table public.hermes_ebay_listing_quality_packets
  add column if not exists confirmation_status text default 'not_confirmed',
  add column if not exists confirmed_by_actor text,
  add column if not exists confirmation_reason text,
  add column if not exists confirmed_at timestamp,
  add column if not exists confirmation_snapshot jsonb,
  add column if not exists rejected_by_actor text,
  add column if not exists rejection_reason text,
  add column if not exists rejected_at timestamp;

alter table public.hermes_ebay_listing_quality_packets
  drop constraint if exists hermes_ebay_listing_quality_packets_confirmation_status_check;

alter table public.hermes_ebay_listing_quality_packets
  add constraint hermes_ebay_listing_quality_packets_confirmation_status_check
    check (confirmation_status in ('not_confirmed', 'confirmed', 'rejected', 'expired'));

create index if not exists idx_hermes_ebay_listing_quality_packets_confirmation_status
  on public.hermes_ebay_listing_quality_packets(confirmation_status);
