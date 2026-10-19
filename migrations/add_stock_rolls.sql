-- QR 롤 재고 1단계 — 재고 단위를 "원단 종류"에서 "롤(필) 하나"로 바꾼다
-- Supabase 대시보드 > SQL Editor 에서 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
-- 여러 번 실행해도 안전합니다(이미 있는 것은 건너뛴다).
--
-- 무슨 문제를 푸는가:
--   로하이마켓 원단은 매번 다른 원단이 한 번 입고되고 소진된다. 그런데 inventory 는
--   "원단 종류당 수량 하나"(fabric/color/stock)라서, 품목을 만들고 지우는 일 자체가
--   업무가 되어 아무도 쓰지 않았다. 게다가 입고 원단의 10~20% 는 검단에서 오염·불량으로
--   버려져 명세서 수량과 실물이 다르다 — 명세서대로 적은 재고는 처음부터 틀린 숫자다.
--
--   그래서 롤 하나를 한 줄로 적는다. 검단을 마친 실측 수량으로 QR 라벨을 뽑아 롤에
--   붙이면, 그 롤이 어디 있고 얼마 남았는지가 종이와 DB 에서 같은 값이 된다.
--
-- 왜 테이블이 셋인가:
--   products         이 원단이 무엇인가(품번·이름·색상·사진). 수량은 여기 없다.
--   stock_rolls      롤 하나 = 한 줄 = 라벨 한 장. 재고의 실제 단위.
--   stock_movements  잔량이 바뀐 기록. 잔량이 이상하면 어디서 틀어졌는지 여기서 본다.
--
-- 왜 잔량을 RPC 하나로만 바꾸는가:
--   화면에서 stock_movements insert 와 stock_rolls update 를 따로 보내면, 하나만
--   성공하는 순간 기록과 잔량이 어긋난다. roll_apply_movement 는 둘을 한 트랜잭션으로
--   묶고, 잔량이 음수가 되면 통째로 되돌린다.
--
-- 왜 가용 판정이 "가장 긴 롤"인가:
--   재단 주문은 한 롤에서 끊어 나간다. 8마·6마·5마 롤이 있어도 10마 주문은 못 받는다.
--   합계(19마)는 참고값이고, 실제로 받을 수 있는 양은 가장 긴 롤(8마)이다.
--   (이 판정은 화면에서 한다 — src/lib/rollStock.js)
--
-- 기존 inventory 테이블은 건드리지 않는다. 수량은 믿을 수 없어 롤로 바꾸지 않고,
-- 품번·원단명만 products 로 복사한다(맨 아래).

-- ─── 1. 품번 발급 ───────────────────────────────────────────────
-- 품번은 LH-YYMM-#### 형식. 유일성은 시퀀스가 보장하고 YYMM 은 사람이 읽는 힌트일 뿐이다.
-- 화면에서 번호를 만들지 않는다 — 두 사람이 동시에 등록하면 같은 번호가 나온다.
create sequence if not exists product_code_seq;

-- ⚠️ 2026-10-13: 처음엔 무인자였고 add_product_manager.sql(10-08)이 접두어(p_prefix) 판으로 바꾸며 무인자 판을
-- 지웠다. 이 파일을 그 뒤에 다시 돌리면 무인자 판이 되살아나 둘이 공존하고, 화면의 {} 호출이 "not unique" 로
-- 실패해 품번 발급이 멈춘다. 그래서 여기도 접두어 판으로 두고 무인자 판이 남아 있으면 지운다.
create or replace function next_product_code(p_prefix text default 'LH') returns text language sql as $$
  select (case when p_prefix ~ '^[A-Z][A-Z0-9]{0,5}$' then p_prefix else 'LH' end)
         || '-' || to_char(now() at time zone 'Asia/Seoul', 'YYMM')
         || '-' || lpad(nextval('product_code_seq')::text, 4, '0');
$$;
drop function if exists next_product_code();

-- ─── 2. 테이블 ─────────────────────────────────────────────────
-- 원단 종류(품번 마스터). 롤이 아니라 "이 원단이 무엇인가"만 담는다. 수량은 여기 없다.
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code        text not null,                 -- 라벨·밴드 게시글에 쓰는 품번
  name        text not null,                 -- 원단명
  color       text not null default '',
  photo_url   text,
  unit        text not null default '마',
  unit_price  numeric(12,2),                 -- 판매 단가(마당). 없으면 null
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, code)
);

-- 롤(필) 하나 = 한 행 = 라벨 한 장. 재고의 실제 단위.
create table if not exists stock_rolls (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  product_id         uuid not null references products(id) on delete restrict,
  roll_code          text not null,          -- QR에 들어가는 값. {products.code}-R{두 자리}
  length_received    numeric(10,2) not null, -- 거래처 명세서 수량
  length_available   numeric(10,2),          -- 검단 후 실측. 검단 전엔 null
  length_remaining   numeric(10,2),          -- 현재 잔량. stock_movements 합으로 갱신되는 캐시
  status             text not null default 'received'
                       check (status in ('received','available','reserved','sold','scrapped')),
  location           text not null default '',  -- 창고 위치. 예: A-03
  supplier           text not null default '',
  inspected_at       timestamptz,
  inspected_by       text,
  label_requested_at timestamptz,            -- 라벨 뽑아달라는 요청 시각 (orders와 같은 방식)
  label_printed_at   timestamptz,            -- 실제로 뽑힌 시각. 출력권 선점 기준
  created_at         timestamptz not null default now(),
  unique (user_id, roll_code)
);

-- 잔량 변동 원장. 잔량이 이상하면 여기서 어디서 틀어졌는지 본다. 감시 에이전트 검사 대상.
create table if not exists stock_movements (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  roll_id     uuid not null references stock_rolls(id) on delete cascade,
  type        text not null check (type in ('inspect','cut','sell_whole','adjust','scrap','reserve','release')),
  qty         numeric(10,2) not null,        -- inspect는 실측 절대값, 그 외는 부호 있는 변화량(차감은 음수)
  order_id    text,                          -- orders.id 는 text('#L...')다. uuid 아님
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_products_user_code      on products(user_id, code);
create index if not exists idx_rolls_user_product      on stock_rolls(user_id, product_id, status);
create index if not exists idx_rolls_label_requested   on stock_rolls(user_id, label_requested_at)
  where label_requested_at is not null and label_printed_at is null;
create index if not exists idx_movements_roll          on stock_movements(roll_id, created_at);

-- ─── 3. RLS — 기존 테이블과 같은 패턴(회사 단위 격리, 직원 구분은 클라이언트에서) ───
alter table products        enable row level security;
alter table stock_rolls     enable row level security;
alter table stock_movements enable row level security;

drop policy if exists tenant_products on products;
create policy tenant_products on products for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists tenant_stock_rolls on stock_rolls;
create policy tenant_stock_rolls on stock_rolls for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists tenant_stock_movements on stock_movements;
create policy tenant_stock_movements on stock_movements for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 4. 잔량 변동 RPC — 잔량을 바꾸는 모든 경로는 이 함수 하나를 부른다 ───────
-- security invoker 인 이유: 호출자의 RLS 가 그대로 적용되어 다른 user_id 의 롤을
-- 건드릴 수 없다.
-- 기록(insert)을 먼저 하고 잔량을 고친 뒤 음수인지 본다. 음수면 예외를 던지는데,
-- 함수 전체가 한 트랜잭션이라 방금 넣은 기록까지 함께 사라진다.
-- ⚠️ 2026-10-13: 이 파일은 처음(067fb1e) 6인자로 함수를 만들었고, 2단계(add_item_packing.sql)가
-- 7인자(p_item_id)로 바꾸면서 6인자를 지웠다. 그 뒤 이 파일을 다시 돌리면 6인자가 되살아나 둘이
-- 공존하고(오버로드), 화면이 item_id 없이 부르는 검단·조정·폐기·입고가 PGRST203 으로 전부 실패한다.
-- 그래서 여기도 7인자판으로 두고, 6인자가 남아 있으면 지운다. item_id 칸도 여기서 미리 만든다 —
-- 2단계 없이 이 파일만 돌린 DB 에서도 함수가 돌아야 한다.
alter table stock_movements add column if not exists item_id text;
drop function if exists roll_apply_movement(uuid, text, numeric, text, text, text);

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

-- ─── 5. Realtime ───────────────────────────────────────────────
-- 다른 PC 에서 검단을 마치면 라벨 PC 가 곧바로 알아야 한다 — stock_rolls 구독이
-- 없으면 라벨이 새로고침할 때까지 안 나온다.
-- stock_movements 는 구독하지 않는다(원장은 화면에 실시간으로 뿌릴 필요가 없다).
-- 이미 추가돼 있으면 에러가 나므로 감싸서 무시한다(여러 번 실행해도 안전하게).
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE products;        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE stock_rolls;     EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 6. 기존 inventory 에서 품번만 이식 ─────────────────────────
-- item_no 가 있는 것만. 수량(stock)은 신뢰할 수 없으므로 롤로 만들지 않는다.
-- 같은 품번이 이미 있으면 건너뛴다 — 두 번 실행해도 늘어나지 않는다.
--
-- item_no·unit_price 칸은 이 저장소의 SQL 파일에 없다(대시보드에서 나중에 붙인 칸이다).
-- 칸이 없는 DB 에서 그냥 실행하면 여기서 에러가 나 위의 테이블 생성까지 함께 되돌아간다.
-- 그래서 칸이 있는지 먼저 보고, 없으면 이식만 건너뛴다.
-- 원단명이 빈 품목은 품번을 이름으로 쓴다(products.name 은 비울 수 없다).
DO $$
DECLARE
  has_item_no boolean;
  has_price   boolean;
BEGIN
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'inventory' and column_name = 'item_no')
    into has_item_no;
  select exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'inventory' and column_name = 'unit_price')
    into has_price;

  IF NOT has_item_no THEN
    RAISE NOTICE 'inventory.item_no 칸이 없어 품번 이식을 건너뜁니다';
    RETURN;
  END IF;

  EXECUTE format($q$
    insert into products (user_id, code, name, color, unit_price)
    select user_id, upper(trim(item_no)),
           coalesce(nullif(trim(fabric), ''), upper(trim(item_no))),
           coalesce(color, ''),
           %s
      from inventory
     where coalesce(trim(item_no), '') <> ''
       and user_id is not null
    on conflict (user_id, code) do nothing
  $q$, CASE WHEN has_price THEN 'nullif(unit_price, 0)' ELSE 'null' END);
END $$;

-- ─── 7. 상품 사진 버킷 (product-images) ─────────────────────────
-- order-images 와 같은 방식이다(supabase-storage-order-images-policy.sql 참고).
--   · 목록 조회·업로드·삭제는 로그인 세션(authenticated)에만 허용
--   · 버킷은 public — 개별 사진을 URL 로 여는 것은 된다. products.photo_url 에 저장한
--     주소로 화면이 사진을 보여주므로, 이걸 막으면 사진이 전부 깨진다.
-- 경로 규칙: {product_id}/{timestamp}.webp
--
-- 이 Supabase 프로젝트는 다른 앱(HR)과 공유된다. 정책은 버킷 조건
-- (bucket_id = 'product-images')으로 범위를 한정해야 다른 버킷에 영향이 없다.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product-images authenticated select" on storage.objects;
create policy "product-images authenticated select" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images');

drop policy if exists "product-images authenticated insert" on storage.objects;
create policy "product-images authenticated insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images');

drop policy if exists "product-images authenticated delete" on storage.objects;
create policy "product-images authenticated delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images');

-- ─── 8. 확인 ───────────────────────────────────────────────────
-- 테이블 셋과 옮겨온 품번 수. 롤·기록은 0 이어야 한다(수량은 옮기지 않았다).
select (select count(*) from products)        as products,
       (select count(*) from stock_rolls)     as stock_rolls,
       (select count(*) from stock_movements) as stock_movements;
