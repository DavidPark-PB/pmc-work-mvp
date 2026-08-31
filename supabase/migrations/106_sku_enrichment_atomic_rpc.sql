-- 106_sku_enrichment_atomic_rpc.sql
-- Owner Directive (2026-09-01) · SKU Enrichment · true atomicity via Postgres functions.
--
-- Rationale:
--   105 마이그로 sku_master/history 테이블은 준비됐지만, Supabase JS client 는 다중 statement
--   transaction 을 직접 제공하지 않는다. 앱단 순차 호출 (INSERT → UPDATE) 은 partial success
--   window 가 존재한다 (예: history 는 저장됐는데 sku_master UPDATE 가 실패하면 이력이 실 값과 다름).
--
--   Postgres function 은 그 자체가 하나의 statement 이자 하나의 transaction 이므로
--   함수 내부에서 여러 SQL 이 실행돼도 중간 실패 시 자동 rollback → true atomicity.
--
-- Contract:
--   두 함수 모두:
--     - security invoker (default) · caller RLS 준수 · service_role 로 호출
--     - FOR UPDATE row lock 으로 동시성 안전 (동일 SKU 동시 저장 방지)
--     - RAISE EXCEPTION 시 트랜잭션 전체 rollback (history + sku_master 둘 다 반영 안 됨)
--     - 반환 json · 앱단 error 판별 용이
--
-- Safety:
--   - Additive · 함수 신설만 · 기존 데이터 무손상
--   - CREATE OR REPLACE FUNCTION · idempotent · 재실행 안전
--   - DROP 없음 · destructive 없음
--   - 기존 105 마이그 컬럼/테이블 그대로 사용

-- ══════════════════════════════════════════════════════════════════════════
-- 1. update_sku_cost_atomic — 원가 변경 · history + master 하나의 tx
-- ══════════════════════════════════════════════════════════════════════════
create or replace function update_sku_cost_atomic(
  p_internal_sku    text,
  p_new_cost_krw    numeric,
  p_source          text default 'shipping_manual',
  p_source_ref      text default null,
  p_reason          text default null,
  p_changed_by      integer default null
) returns json
language plpgsql
security invoker
as $$
declare
  v_sku_id          integer;
  v_previous_cost   numeric;
  v_now             timestamptz := now();
begin
  if p_internal_sku is null or p_internal_sku = '' then
    raise exception 'internal_sku required' using errcode = '22023';
  end if;
  if p_new_cost_krw is null or p_new_cost_krw < 0 then
    raise exception 'cost_krw must be >= 0' using errcode = '22023';
  end if;

  -- row lock (동시 저장 방지 · 짧은 lock)
  select id, cost_krw
    into v_sku_id, v_previous_cost
    from sku_master
   where internal_sku = p_internal_sku
   for update;

  if v_sku_id is null then
    raise exception 'sku_master not found: %', p_internal_sku using errcode = 'P0002';
  end if;

  -- 동일 값 요청은 no-op (audit 노이즈 방지)
  if v_previous_cost is not null and abs(v_previous_cost - p_new_cost_krw) < 0.01 then
    return json_build_object(
      'sku_master_id',    v_sku_id,
      'unchanged',        true,
      'cost_krw',         p_new_cost_krw,
      'previous_cost_krw', v_previous_cost
    );
  end if;

  -- history INSERT 먼저 (append-only audit)
  insert into sku_cost_history (
    sku_master_id, previous_cost_krw, new_cost_krw, currency,
    source, source_ref, reason, changed_by
  ) values (
    v_sku_id, v_previous_cost, p_new_cost_krw, 'KRW',
    p_source, p_source_ref, p_reason, p_changed_by
  );

  -- sku_master 갱신 (INSERT 실패 시 여기 도달 안 함 · UPDATE 실패 시 INSERT 도 rollback)
  update sku_master set
    cost_krw        = p_new_cost_krw,
    cost_source     = p_source,
    cost_source_ref = p_source_ref,
    cost_updated_at = v_now,
    updated_at      = v_now
  where id = v_sku_id;

  return json_build_object(
    'sku_master_id',     v_sku_id,
    'unchanged',         false,
    'cost_krw',          p_new_cost_krw,
    'previous_cost_krw', v_previous_cost,
    'changed_at',        v_now
  );
end;
$$;

comment on function update_sku_cost_atomic is
  'SKU 원가 변경 · history INSERT + sku_master UPDATE 를 하나의 transaction 으로 처리 (2026-09-01).';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. update_sku_supplier_atomic — 소싱처 변경 · history + master 하나의 tx
-- ══════════════════════════════════════════════════════════════════════════
create or replace function update_sku_supplier_atomic(
  p_internal_sku      text,
  p_supplier_id       bigint  default null,
  p_supplier_name     text    default null,
  p_purchase_price    numeric default null,
  p_currency          text    default null,
  p_quantity          integer default null,
  p_purchased_at      date    default null,
  p_source            text    default 'shipping_manual',
  p_source_ref        text    default null,
  p_note              text    default null,
  p_set_as_current    boolean default true,
  p_created_by        integer default null
) returns json
language plpgsql
security invoker
as $$
declare
  v_sku_id           integer;
  v_current_supplier bigint;
  v_resolved_name    text;
  v_history_id       bigint;
  v_did_update       boolean := false;
  v_now              timestamptz := now();
begin
  if p_internal_sku is null or p_internal_sku = '' then
    raise exception 'internal_sku required' using errcode = '22023';
  end if;
  if p_supplier_id is null and (p_supplier_name is null or p_supplier_name = '') then
    raise exception 'supplier_id or supplier_name required' using errcode = '22023';
  end if;

  -- row lock
  select id, supplier_id
    into v_sku_id, v_current_supplier
    from sku_master
   where internal_sku = p_internal_sku
   for update;

  if v_sku_id is null then
    raise exception 'sku_master not found: %', p_internal_sku using errcode = 'P0002';
  end if;

  -- supplier_id 검증 (없는 id 로 sku_master 오염 방지)
  v_resolved_name := p_supplier_name;
  if p_supplier_id is not null then
    select name into v_resolved_name from suppliers where id = p_supplier_id;
    if v_resolved_name is null then
      raise exception 'supplier not found: %', p_supplier_id using errcode = 'P0002';
    end if;
    if p_supplier_name is not null then
      v_resolved_name := p_supplier_name;
    end if;
  end if;

  -- history INSERT
  insert into sku_supplier_history (
    sku_master_id, supplier_id, supplier_name, purchase_price, currency,
    quantity, purchased_at, source, source_ref, note, is_preferred, created_by
  ) values (
    v_sku_id, p_supplier_id, v_resolved_name, p_purchase_price, p_currency,
    p_quantity, p_purchased_at, p_source, p_source_ref, p_note,
    (p_set_as_current and p_supplier_id is not null), p_created_by
  ) returning id into v_history_id;

  -- sku_master.supplier_id 는 supplier_id 있고 set_as_current=true 일 때만
  if p_set_as_current and p_supplier_id is not null then
    update sku_master
       set supplier_id = p_supplier_id, updated_at = v_now
     where id = v_sku_id;
    v_did_update := true;
  end if;

  return json_build_object(
    'sku_master_id',        v_sku_id,
    'history_id',           v_history_id,
    'supplier_id_set',      v_did_update,
    'resolved_supplier_name', v_resolved_name
  );
end;
$$;

comment on function update_sku_supplier_atomic is
  'SKU 소싱처 변경 · history INSERT + sku_master.supplier_id UPDATE 를 하나의 transaction (2026-09-01).';

-- Rollback (참고 · 함수라 사실상 무영향):
--   drop function if exists update_sku_supplier_atomic(text, bigint, text, numeric, text, integer, date, text, text, text, boolean, integer);
--   drop function if exists update_sku_cost_atomic(text, numeric, text, text, text, integer);
