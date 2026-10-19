-- 주문 변경 기록(order_events) + 송장 출력 시각 + 택배사 + 출고 방법
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
-- 여러 번 실행해도 안전합니다.
--
-- 무슨 문제를 푸는가:
--   물건은 나갔는데 ERP 는 출고완료가 아닌 주문(미아)이 생긴다. 찾아내도 "왜 빠졌는지"를
--   되짚을 수 없었다 — 출고완료를 누가 언제 어느 화면에서 눌렀는지, 그 전에 보관이었는지
--   합배송이었는지가 어디에도 남지 않았기 때문이다. 합배송 탓인지 보관 탓인지 사람 실수인지
--   가를 근거가 없어서, 매번 일일이 찾아 하나씩 처리하는 수밖에 없었다.
--
-- 왜 화면(클라이언트)이 아니라 DB 트리거가 기록하는가:
--   주문 상태를 바꾸는 길이 스무 군데가 넘는다(주문현황 버튼·송장 모달·포장탭·정산관리·
--   주문수정·방문고객 등록·입출고 …). 화면마다 "기록 남기기"를 끼워 넣으면 한 군데만
--   빠뜨려도 그 길로 바뀐 건은 기록이 없다 — 그리고 미아는 늘 그런 길에서 생긴다.
--   트리거는 orders 가 바뀌는 순간 DB 가 직접 적으므로 빠지는 길이 없다. 나중에 새 화면이
--   생겨도, SQL Editor 에서 손으로 고쳐도 남는다. 바뀌기 전 값(from)도 DB 만 정확히 안다.
--
-- 누가 했는지는 어떻게 아는가:
--   직원 구분은 DB 계정이 아니라 화면의 '현재 작업자'다(회사 계정 하나를 같이 쓴다).
--   그래서 화면이 주문을 고칠 때마다 orders 에 도장 세 칸을 같이 쓴다:
--     last_actor(작업자) · last_route(어느 화면/버튼) · last_actor_at(찍은 시각)
--   트리거는 last_actor_at 이 이번에 바뀌었을 때만 그 도장을 믿는다. 도장 없이 바뀐 건은
--   작업자를 비워 둔다 — 지난번 사람 이름이 엉뚱하게 붙는 것보다 '모름'이 정직하다.
--
-- 왜 송장 출력 시각이 필요한가:
--   "송장만" 출력은 아무 흔적도 남기지 않았다. 송장이 나갔다는 건 물건이 곧 나간다는
--   가장 강한 신호인데, 그걸 몰라서 '송장은 나갔는데 출고완료가 아닌 주문'을 찾을 수 없었다.

-- ── orders 에 붙는 칸 ─────────────────────────────────────────
alter table orders add column if not exists last_actor text;
alter table orders add column if not exists last_route text;
alter table orders add column if not exists last_actor_at timestamptz;
alter table orders add column if not exists invoice_printed_at timestamptz;

-- 택배사 — 사람이 직접 고른 경우에만 채운다. 비어 있으면 배송비로 자동 판정한다
-- (7,000원 이상 경동, 미만 CJ — src/lib/courier.js). 자동 판정 결과를 저장하지 않는 이유:
-- 저장해 두면 나중에 배송비나 합배송 묶음이 바뀌어도 옛 값이 남는다.
-- 배송비 0원인데 경동인 주문(보상·서비스)처럼 규칙이 안 맞는 건만 여기에 적힌다.
alter table orders add column if not exists courier text;

-- 실제로 어떻게 나갔는가 — 출고되는 순간 적힌다.
-- 'CJ대한통운' / '경동화물' / '퀵' / '직접 배달' / '방문 수령'
alter table orders add column if not exists shipped_via text;

-- ── 기록 테이블 ───────────────────────────────────────────────
-- order_id 에 외래키를 걸지 않는다. 주문이 삭제돼도 기록은 남아야 한다 —
-- "주문이 사라졌다"를 추적할 때 필요한 게 바로 그 삭제 기록이다.
create table if not exists order_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid not null,
  customer text not null default '',      -- 그 순간의 고객명. 주문이 지워진 뒤에도 찾을 수 있게
  op text not null,                       -- INSERT(등록) / UPDATE(변경) / DELETE(삭제)
  status_from text,
  status_to text,
  changes jsonb not null default '{}'::jsonb,   -- {"칸": {"from": 이전값, "to": 새값}}
  actor text not null default '',         -- 작업자. 비어 있으면 도장 없이 바뀐 것
  route text not null default '',         -- 어느 화면/버튼에서
  created_at timestamptz not null default now()
);

-- RLS — 읽기만 연다. 쓰기 정책이 없으므로 화면에서는 기록을 넣지도 고치지도 지우지도 못한다.
-- 기록은 아래 트리거만 쓴다(security definer). 고칠 수 있는 기록은 기록이 아니다.
alter table order_events enable row level security;

drop policy if exists tenant_order_events_read on order_events;
create policy tenant_order_events_read on order_events
  for select
  using (user_id = auth.uid());

-- 읽는 길은 둘이다: 주문 하나의 이력, 그리고 최근 기록 훑기.
create index if not exists idx_order_events_order
  on order_events (user_id, order_id, created_at);
create index if not exists idx_order_events_recent
  on order_events (user_id, created_at desc);

-- ── 트리거 ────────────────────────────────────────────────────
-- 통째로 exception 으로 감싼다. 기록이 실패해도 주문 저장은 그대로 되어야 한다 —
-- 기록하려다 출고완료가 안 눌리면 고치려던 문제를 직접 만드는 셈이다.
--
-- 칸을 NEW.컬럼 으로 직접 읽지 않고 to_jsonb 로 바꿔서 읽는다. 아래 목록의 칸이
-- 아직 없는 DB 여도(마이그레이션을 덜 돌린 환경) 에러 없이 '변화 없음'으로 지나간다.
--
-- 엑셀로 올린 과거 주문(time = '00:00')은 적지 않는다. 한 번에 수천 건이 들어오고
-- 전부 이미 끝난 주문이라, 적어봐야 찾을 기록만 묻힌다.
create or replace function log_order_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb;
  n jsonb;
  ch jsonb := '{}'::jsonb;
  k text;
  who text := '';
  how text := '';
  -- 기록할 칸. 메모·이미지·원단호출처럼 자주 바뀌고 출고 추적과 무관한 칸은 뺐다.
  watched constant text[] := array[
    'status', 'payment',
    'is_holding', 'held_at', 'is_parked', 'park_reason',
    'ship_requested_at', 'packed_at', 'shipped_at', 'invoice_printed_at',
    'merge_group_id', 'split_shipping',
    'courier', 'shipped_via',
    'ship_date', 'is_urgent',
    'manager', 'customer', 'total_amount', 'address', 'address_detail', 'items'
  ];
begin
  begin
    if tg_op = 'DELETE' then
      o := to_jsonb(old);
      if o->>'time' = '00:00' then return null; end if;
      -- 삭제에는 NEW 가 없어 도장을 같이 쓸 수 없다. 화면이 삭제 직전에 도장만 먼저
      -- 찍으므로, 방금(15초 안) 찍힌 도장이면 그 사람이 지운 것으로 본다.
      if (o->>'last_actor_at') is not null
         and (o->>'last_actor_at')::timestamptz > now() - interval '15 seconds' then
        who := coalesce(o->>'last_actor', '');
        how := coalesce(o->>'last_route', '');
      end if;
      insert into order_events (user_id, order_id, customer, op, status_from, changes, actor, route)
      values (
        (o->>'user_id')::uuid, (o->>'id')::uuid, coalesce(o->>'customer', ''), 'DELETE', o->>'status',
        jsonb_build_object(
          'payment', o->'payment', 'total_amount', o->'total_amount',
          'manager', o->'manager', 'merge_group_id', o->'merge_group_id', 'items', o->'items'),
        who, how);
      return null;
    end if;

    n := to_jsonb(new);
    if n->>'time' = '00:00' then return null; end if;

    if tg_op = 'INSERT' then
      insert into order_events (user_id, order_id, customer, op, status_to, changes, actor, route)
      values (
        (n->>'user_id')::uuid, (n->>'id')::uuid, coalesce(n->>'customer', ''), 'INSERT', n->>'status',
        jsonb_build_object('payment', n->'payment', 'total_amount', n->'total_amount', 'manager', n->'manager'),
        coalesce(nullif(n->>'last_actor', ''), ''), coalesce(n->>'last_route', ''));
      return null;
    end if;

    -- UPDATE
    o := to_jsonb(old);
    foreach k in array watched loop
      if (o->k) is distinct from (n->k) then
        ch := ch || jsonb_build_object(k, jsonb_build_object('from', o->k, 'to', n->k));
      end if;
    end loop;
    if ch = '{}'::jsonb then return null; end if;

    if (o->'last_actor_at') is distinct from (n->'last_actor_at') then
      who := coalesce(n->>'last_actor', '');
      how := coalesce(n->>'last_route', '');
    end if;

    insert into order_events (user_id, order_id, customer, op, status_from, status_to, changes, actor, route)
    values (
      (n->>'user_id')::uuid, (n->>'id')::uuid, coalesce(n->>'customer', ''), 'UPDATE',
      o->>'status', n->>'status', ch, who, how);
  exception when others then
    raise warning 'order_events 기록 실패: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trg_order_events on orders;
create trigger trg_order_events
  after insert or update or delete on orders
  for each row execute function log_order_event();

-- 전체현황 탭이 훑는 경로: "송장은 나갔는데 아직 출고완료가 아닌 것".
create index if not exists idx_orders_invoice_printed
  on orders (user_id, invoice_printed_at)
  where invoice_printed_at is not null;

-- ── 치우기: 고객 변경 기록 ────────────────────────────────────
-- 이 파일의 앞선 판(2026-09-28 오후)에 고객 변경 기록(customer_events)이 잠깐 들어 있었다.
-- 쓰지 않기로 했다 — 누가 그 고객을 만들었는지는 주문 기록의 '등록한 사람'으로 알 수 있다.
-- 그 판을 이미 실행한 DB 라면 아래가 그때 만든 것을 걷어낸다. 실행한 적이 없으면 아무 일도
-- 일어나지 않는다. 여기서 지우는 것은 전부 그 판이 만든 것뿐이다.
drop trigger if exists trg_customer_events on customers;
drop function if exists log_customer_event();
drop table if exists customer_events;
alter table customers drop column if exists last_actor;
alter table customers drop column if exists last_route;
alter table customers drop column if exists last_actor_at;
