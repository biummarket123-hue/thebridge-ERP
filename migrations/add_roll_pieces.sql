-- QR 롤 재고 — 재단한 뒤 취소·환불된 원단을 "조각 롤"로 다시 들인다
-- Supabase 대시보드 > SQL Editor 에서 실행하세요. 여러 번 실행해도 안전합니다.
-- 전제: add_stock_rolls.sql · add_item_packing.sql 이 먼저 들어가 있어야 한다.
--
-- 무슨 문제를 푸는가:
--   잘라 낸 원단은 원래 롤로 돌아가지 못한다 — 3마를 잘랐다가 주문이 취소되면 창고에는
--   "27마 남은 롤"과 "3마 조각"이 따로 있다. 지금까지는 포장을 취소하면 원래 롤 잔량에
--   3마를 더했는데, 그러면 장부는 30마 롤 하나이고 실물은 둘이라 다음 30마 주문을 받게 된다.
--   이제 잘라 낸 뒤의 취소·반품은 같은 품번의 롤을 하나 더 만든다(조각 롤). 사유를 같이 적는다.
--
--   · 출고 전 취소(이미 잘랐음)  → unpack_item_cut  : 포장 기록을 지우고 조각 롤을 만든다
--   · 출고 후 반품(반품입고)      → roll_add_piece   : 돌아온 길이만큼 조각 롤을 만든다
--   · 롤 통째로 나간 것이 돌아옴  → 조각이 아니라 그 롤 자체다. 원래 롤을 되살린다(잔량 되돌림)
--   · 아직 안 잘랐음(잘못 찍음)   → 예전 그대로 unpack_item : 원래 롤에 길이를 되돌린다
--
-- 조각 롤은 검단을 거치지 않고 바로 판매 가능이다(2026-10-02 결정). 라벨은 자동으로 요청된다.

-- ─── 1. 조각 롤의 출처·사유 ──────────────────────────────────────
alter table stock_rolls add column if not exists origin          text;   -- null = 입고한 롤 · 'cancel' = 재단 후 취소 · 'return' = 출고 후 반품
alter table stock_rolls add column if not exists origin_roll_id  uuid;   -- 어느 롤에서 잘려 나갔던 것인가(모르면 null)
alter table stock_rolls add column if not exists origin_order_id text;   -- 어느 주문에서 돌아왔는가
alter table stock_rolls add column if not exists note            text;   -- 사유
alter table stock_rolls drop constraint if exists stock_rolls_origin_check;
alter table stock_rolls add constraint stock_rolls_origin_check check (origin is null or origin in ('cancel','return'));

-- ─── 2. 조각 롤 만들기 ───────────────────────────────────────────
-- 같은 품번의 다음 번호(R03 …)로 롤을 하나 만들고, 돌아온 길이를 실측값으로 놓아 바로 판매 가능으로 한다.
-- 번호는 그 품번의 롤 수와 가장 큰 번호 중 큰 쪽 + 1 — 화면(nextRollCodes)과 같은 규칙. 겹치면 다음 번호로.
create or replace function roll_add_piece(
  p_product_id     uuid,
  p_length         numeric,
  p_origin         text,
  p_origin_roll_id uuid default null,
  p_order_id       text default null,
  p_item_id        text default null,
  p_note           text default null,
  p_by             text default null
) returns stock_rolls
language plpgsql security invoker as $$
declare
  v_pcode text;
  v_n     int;
  v_max   int;
  v_seq   int;
  v_try   int := 0;
  r       stock_rolls;
begin
  if p_length is null or p_length <= 0 then raise exception '길이가 0 이하: %', p_length; end if;
  if p_origin is null or p_origin not in ('cancel','return') then raise exception '출처는 cancel·return: %', p_origin; end if;
  select p.code into v_pcode from products p where p.id = p_product_id and p.user_id = auth.uid();
  if not found then raise exception 'product not found'; end if;

  loop
    select count(*)::int, coalesce(max((substring(s.roll_code from '-R([0-9]+)$'))::int), 0)
      into v_n, v_max
      from stock_rolls s where s.user_id = auth.uid() and s.product_id = p_product_id;
    v_seq := greatest(v_n, v_max) + 1 + v_try;
    begin
      insert into stock_rolls (user_id, product_id, roll_code, length_received, status,
                               origin, origin_roll_id, origin_order_id, note, label_requested_at)
      values (auth.uid(), p_product_id,
              v_pcode || '-R' || case when v_seq < 10 then '0' else '' end || v_seq::text,
              p_length, 'received', p_origin, p_origin_roll_id, p_order_id, p_note, now())
      returning * into r;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;

  -- 돌아온 길이를 그대로 실측값으로 — 검단 없이 판매 가능. 원장에 사유가 남는다.
  r := roll_apply_movement(r.id, 'inspect', p_length, p_order_id, p_note, p_by, p_item_id);
  return r;
end $$;

-- ─── 3. 재단한 뒤의 포장 취소 ────────────────────────────────────
-- 포장 기록을 지우고, 잘려 나간 길이만큼 조각 롤을 만든다(원래 롤의 잔량은 그대로 — 이미 잘렸다).
-- 롤 통째로 나갔던 품목이면 조각이 아니라 그 롤이 돌아온 것이라 원래 롤을 되살린다.
-- 롤 없이 포장한 기록이면 기록만 지운다. 돌려주는 값: 생기거나 되살아난 롤(없으면 null).
create or replace function unpack_item_cut(
  p_order_id text,
  p_item_id  text,
  p_note     text,
  p_by       text default null
) returns stock_rolls
language plpgsql security invoker as $$
declare
  rec order_item_packing;
  src stock_rolls;
begin
  if coalesce(btrim(p_note), '') = '' then raise exception '사유가 필요합니다'; end if;
  delete from order_item_packing
   where user_id = auth.uid() and order_id = p_order_id and item_id = p_item_id
  returning * into rec;
  if not found then return null; end if;
  if rec.roll_id is null then return null; end if;

  if rec.whole_roll then
    return roll_apply_movement(rec.roll_id, 'adjust', rec.length, p_order_id, p_note, p_by, p_item_id);
  end if;

  select * into src from stock_rolls where id = rec.roll_id and user_id = auth.uid();
  if not found then raise exception 'roll not found'; end if;
  return roll_add_piece(src.product_id, rec.length, 'cancel', rec.roll_id, p_order_id, p_item_id, p_note, p_by);
end $$;

-- ─── 4. 확인 ───────────────────────────────────────────────────
select
  (select count(*) from information_schema.columns where table_name = 'stock_rolls' and column_name in ('origin','origin_roll_id','origin_order_id','note')) as new_columns,  -- 4
  (select count(*) from pg_proc where proname in ('roll_add_piece','unpack_item_cut')) as new_functions;                                                                    -- 2
