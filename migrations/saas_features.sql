-- 구독형 SaaS 5단계 — 채널 주문 번호 · AI 사용량 · 결제(빌링) 칸 (2026-10-20)
-- saas_demo.sql 다음에 실행. 두 번 실행해도 안전.
--
-- 1. orders.channel_order_id : 쿠팡·스마트스토어 등 판매 채널의 주문번호. 채널 주문 엑셀을 다시 올려도 같은 주문이 두 번 들어가지 않게
--    (user_id, sales_channel, channel_order_id) 로 유일. 비어 있으면(손으로 등록한 주문) 제약 밖.
-- 2. saas_ai_usage : 회사별 월간 AI 호출 수. 서버(service role)만 쓴다 — 체험 회사에 소량만 허용할 때(SAAS_TRIAL_AI_CALLS) 센다.
--    유료 구독 회사는 세지만 제한하지 않는다. 브라우저는 자기 회사 행을 읽을 수만 있다.
-- 3. saas_billing : 토스페이먼츠 빌링키. 브라우저 정책이 없다 — 서버 함수(api/billing.js)만 service role 로 읽고 쓴다.
--    company_accounts 에 넣지 않는 이유: 그 표는 브라우저가 select 할 수 있어 빌링키가 화면 쪽으로 흘러간다.

alter table orders add column if not exists channel_order_id text;
create unique index if not exists orders_channel_order_uq
  on orders (user_id, sales_channel, channel_order_id)
  where channel_order_id is not null and channel_order_id <> '';

create table if not exists saas_ai_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  month text not null,                     -- 'YYYY-MM'
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (owner_id, month)
);
alter table saas_ai_usage enable row level security;
drop policy if exists saas_ai_usage_select on saas_ai_usage;
create policy saas_ai_usage_select on saas_ai_usage for select using (owner_id = auth.uid());

-- 서버 전용: 이번 달 호출 수를 1 올리고 올린 뒤의 값을 돌려준다. 브라우저에서는 부를 수 없다(authenticated 에 실행 권한 없음).
create or replace function service_bump_ai_usage(p_owner uuid, p_month text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into saas_ai_usage (owner_id, month, count) values (p_owner, p_month, 1)
    on conflict (owner_id, month) do update set count = saas_ai_usage.count + 1, updated_at = now()
    returning count into n;
  return n;
end $$;
revoke all on function service_bump_ai_usage(uuid, text) from public, anon, authenticated;

create table if not exists saas_billing (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  customer_key text not null,              -- 토스 customerKey(회사마다 하나, 서버가 만든다)
  billing_key text,                        -- 토스가 발급한 빌링키. 없으면 결제 수단 미등록
  card_label text not null default '',     -- 화면에 보여줄 카드 이름·끝 4자리("신한 ****1234")
  plan text,                               -- 자동 결제할 요금제(basic|pro). null 이면 자동 결제 안 함
  last_paid_at timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table saas_billing enable row level security;
-- 정책 없음 = 브라우저(anon·authenticated)는 읽기도 쓰기도 못 한다. service role 만.

-- 결제 이력 종류에 'billing' 추가(카드 자동 결제). 기존 제약을 새 목록으로 바꾼다.
alter table subscription_events drop constraint if exists subscription_events_kind_check;
alter table subscription_events add constraint subscription_events_kind_check
  check (kind in ('trial_start','payment','extend','cancel','plan_change','note','billing'));
