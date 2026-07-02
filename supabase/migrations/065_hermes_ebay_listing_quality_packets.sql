-- Hermes Phase 11C — Internal eBay listing quality packet records.
-- Internal immutable review artifacts only.
-- No marketplace response fields. No execution result fields.

create table if not exists public.hermes_ebay_listing_quality_packets (
  id serial primary key,
  request_id integer not null references public.hermes_execution_requests(id),
  item_id text not null,
  actor text,
  reason text,
  packet_hash text not null,
  planned_mutation jsonb not null,
  before_snapshot jsonb not null,
  rollback_snapshot jsonb not null,
  safety_flags jsonb not null,
  status text not null default 'packet_recorded',
  created_at timestamp default now(),
  constraint hermes_ebay_listing_quality_packets_status_check
    check (status in ('packet_recorded', 'packet_rejected', 'packet_expired'))
);

create index if not exists idx_hermes_ebay_listing_quality_packets_request_id
  on public.hermes_ebay_listing_quality_packets(request_id);

create index if not exists idx_hermes_ebay_listing_quality_packets_item_id
  on public.hermes_ebay_listing_quality_packets(item_id);

create index if not exists idx_hermes_ebay_listing_quality_packets_status
  on public.hermes_ebay_listing_quality_packets(status);

create index if not exists idx_hermes_ebay_listing_quality_packets_hash
  on public.hermes_ebay_listing_quality_packets(packet_hash);
