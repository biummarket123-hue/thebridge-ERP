-- QR 롤 재고 2단계 — 포장대 스캔: 롤 QR 을 찍는 한 동작으로 재고 차감·원단 대조·누락 차단
-- Supabase 대시보드 > SQL Editor 에서 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
-- 여러 번 실행해도 안전합니다(이미 있는 것은 건너뛴다).
-- 전제: 1단계(add_stock_rolls.sql)가 먼저 들어가 있어야 한다.
--
-- 무슨 문제를 푸는가:
--   재단과 포장을 같은 사람이 같은 자리에서 한다 — 롤 자체가 포장대에 온다.
--   포장직원이 롤 QR 을 찍으면 세 가지가 한 번에 된다.
--     1. 재고 차감  — 자른 길이만큼 롤 잔량이 빠진다(지금은 아무것도 안 빠진다)
--     2. 섞임 차단  — 찍은 롤의 품번이 이 주문 품목과 다르면 화면이 거부한다
--     3. 누락 차단  — 모든 품목이 찍히기 전엔 포장완료 버튼이 안 열린다
--
-- 왜 order_item_packing 이 따로 있는가:
--   orders.items(jsonb)에 적으면 포장 태블릿과 셀러 PC 가 같은 주문을 동시에 고칠 때
--   나중 쓴 쪽이 이긴다(jsonb 통째 덮어쓰기). 행 단위 테이블이면 서로 안 밟는다.
--
-- 왜 RPC 로 묶는가:
--   잔량 차감(roll_apply_movement)과 포장 기록 insert 가 따로 가면 하나만 성공하는
--   순간 "빠졌는데 기록 없음" 또는 "기록 있는데 안 빠짐"이 된다. 한 트랜잭션으로 묶는다.

-- ─── 1. roll_apply_movement 에 품목 연결 추가 ────────────────────
-- 어느 주문의 어느 품목 때문에 빠졌는지 원장에 남긴다.
alter table stock_movements add column if not exists item_id text;

-- ⚠️ 인자가 늘어나므로 기존 함수를 먼저 지운다. create or replace 만으로는 6인자 판이
-- 남아 둘이 공존한다(오버로드). 그러면 6인자로 부르는 옛 화면과 7인자로 부르는 새 화면이
-- 서로 다른 함수를 타고, 아래 확인 SELECT 의 rpc_overloads 가 2 가 된다.
drop function if exists roll_apply_movement(uuid, text, numeric, text, text, text);

-- 본문은 1단계(067fb1e) 판 그대로. insert 에 item_id 만 더했다.
create or replace function roll_apply_movement(
  p_roll_id  uuid,
  p_type     text,
  p_qty      numeric,
  p_order_id text default null,
  p_note     text default null,
  p_by       text default null,
  p_item_id  text default null
) returns stock_rolls
language plpgsql security invoker as $$
declare
  r stock_rolls;
begin
  select * into r from stock_rolls
   where id = p_roll_id and user_id = auth.uid()
   for update;
  if not found then
    raise exception 'roll not found: %', p_roll_id;
  end if;

  -- 상태 검사. 롤을 잠근 뒤에 보므로, 같은 요청이 두 번 와도 둘째는 여기서 걸린다.
  -- 검단은 한 번만: 다시 받으면 그 사이 잘라 판 잔량이 실측값으로 덮인다.
  -- scrap 은 어느 상태에서나 된다 — 검단 전 전량 폐기가 이 경로다.
  -- adjust 만은 다 팔린(sold) 롤에도 된다 — 잘못 센 잔량을 바로잡는 길이 이것뿐이다.
  if p_type = 'inspect' and r.status <> 'received' then
    raise exception '이미 검단된 롤: %', r.roll_code;
  end if;
  if p_type in ('cut','sell_whole','adjust','reserve','release')
     and r.status not in ('available','reserved')
     and not (p_type = 'adjust' and r.status = 'sold') then
    raise exception '판매 가능 상태가 아닌 롤: % (%)', r.roll_code, r.status;
  end if;

  insert into stock_movements (user_id, roll_id, type, qty, order_id, item_id, note, created_by)
  values (auth.uid(), p_roll_id, p_type, p_qty, p_order_id, p_item_id, p_note, p_by);

  if p_type = 'inspect' then
    -- 검단: 실측값을 그대로 가용·잔량으로 놓고 판매 가능 상태로
    update stock_rolls
       set length_available = p_qty,
           length_remaining = p_qty,
           status = 'available',
           inspected_at = now(),
           inspected_by = p_by
     where id = p_roll_id
     returning * into r;
  else
    update stock_rolls
       set length_remaining = coalesce(length_remaining, 0) + p_qty,
           status = case
             when coalesce(length_remaining, 0) + p_qty <= 0 and p_type = 'scrap' then 'scrapped'
             when coalesce(length_remaining, 0) + p_qty <= 0 then 'sold'
             when status = 'sold' then 'available'  -- 다 팔린 롤에 잔량이 다시 생겼다
             else status
           end
     where id = p_roll_id
     returning * into r;
    if r.length_remaining < 0 then
      raise exception 'remaining below zero: roll % would be %', r.roll_code, r.length_remaining;
    end if;
  end if;

  return r;
end $$;

-- ─── 2. 품목별 포장 기록 ─────────────────────────────────────────
-- 주문 품목 하나가 어느 롤에서 얼마만큼 잘려 박스에 들어갔는가.
create table if not exists order_item_packing (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  order_id        text not null,                   -- orders.id (text 로 비교한다)
  item_id         text not null,                   -- orders.items[].itemId
  roll_id         uuid references stock_rolls(id) on delete set null,  -- 수기 우회면 null
  length          numeric(10,2),                   -- 실제 자른 길이. 롤 통째면 그 롤의 잔량 전체
  whole_roll      boolean not null default false,
  override_reason text,                            -- 롤 없이 포장한 사유. 롤 스캔이면 null
  packed_by       text not null default '',
  packed_at       timestamptz not null default now(),
  unique (user_id, order_id, item_id)              -- 한 품목은 한 번만
);
create index if not exists idx_item_packing_order on order_item_packing(user_id, order_id);

alter table order_item_packing enable row level security;
drop policy if exists tenant_order_item_packing on order_item_packing;
create policy tenant_order_item_packing on order_item_packing for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 포장 태블릿이 두 대 이상일 수 있고, 셀러 화면도 진행률을 봐야 한다.
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE order_item_packing; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 3. 포장 RPC — 롤 차감과 포장 기록을 한 트랜잭션으로 ──────────
-- 롤을 찍어 품목을 포장한다. 잔량 차감(roll_apply_movement)과 포장 기록 insert 가 한 트랜잭션.
-- 품번 대조(이 롤이 이 품목의 원단인가)는 화면이 한다 — 서버는 롤 상태와 잔량만 본다.
create or replace function pack_item_from_roll(
  p_order_id text,
  p_item_id  text,
  p_roll_id  uuid,
  p_length   numeric,          -- 자른 길이. p_whole 이면 무시하고 잔량 전체
  p_whole    boolean default false,
  p_by       text default null
) returns order_item_packing
language plpgsql security invoker as $$
declare
  r   stock_rolls;
  qty numeric;
  rec order_item_packing;
begin
  select * into r from stock_rolls where id = p_roll_id and user_id = auth.uid() for update;
  if not found then raise exception 'roll not found'; end if;

  qty := case when p_whole then coalesce(r.length_remaining, 0) else p_length end;
  if qty is null or qty <= 0 then raise exception '길이가 0 이하: %', qty; end if;

  -- 이미 포장된 품목이면 unique 가 막는다. 먼저 넣어서 잔량이 빠지기 전에 걸리게 한다.
  insert into order_item_packing (user_id, order_id, item_id, roll_id, length, whole_roll, packed_by)
  values (auth.uid(), p_order_id, p_item_id, p_roll_id, qty, p_whole, coalesce(p_by, ''))
  returning * into rec;

  perform roll_apply_movement(
    p_roll_id,
    case when p_whole then 'sell_whole' else 'cut' end,
    -qty, p_order_id, null, p_by, p_item_id);

  return rec;
end $$;

-- 포장 취소: 기록을 지우고 잔량을 되돌린다. 롤 없이(수기) 포장한 건은 기록만 지운다.
-- adjust 를 쓰는 이유: 1단계 RPC 가 adjust 만 sold 롤에도 허용하고, 잔량이 생기면
-- available 로 되돌린다. 통째 판매를 취소해도 롤이 살아난다.
create or replace function unpack_item(p_order_id text, p_item_id text, p_by text default null)
returns void language plpgsql security invoker as $$
declare rec order_item_packing;
begin
  delete from order_item_packing
   where user_id = auth.uid() and order_id = p_order_id and item_id = p_item_id
  returning * into rec;
  if not found then return; end if;
  if rec.roll_id is not null then
    perform roll_apply_movement(rec.roll_id, 'adjust', rec.length, p_order_id,
                                '포장 취소로 되돌림', p_by, p_item_id);
  end if;
end $$;

-- ─── 4. 확인 ───────────────────────────────────────────────────
-- rpc_overloads 가 2 면 1절의 drop 이 안 된 것이다. 멈추고 알려라.
select
  (select count(*) from pg_proc where proname = 'roll_apply_movement') as rpc_overloads,  -- 반드시 1
  (select count(*) from order_item_packing) as packing_rows;                              -- 0
