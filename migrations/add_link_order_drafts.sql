-- 4단계: 밴드 링크 주문 초안판 (docs/ERP_4단계_링크주문_초안판_지시서.md 2절)
-- 두 번 실행해도 안전하다(if not exists / drop policy if exists).

-- 전화번호 인증 (api/sms-verify.js 가 쓴다). 저장소 SQL 에 없어서 여기서 보장한다.
create table if not exists phone_verifications (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  code        text not null,
  verified    boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_phone_verif_phone on phone_verifications(phone, verified, created_at);
alter table phone_verifications enable row level security;
-- 정책 없음 = anon/authenticated 접근 불가. service role 만 쓴다.

-- 링크 주문 초안. orders 가 아니다. 셀러가 전환해야 주문이 된다.
-- customer_id: 지시서는 bigint 라 했지만 실제 customers.id 는 uuid 다 — 맞춘다.
create table if not exists link_order_drafts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  status              text not null default 'new' check (status in ('new','converted','rejected')),
  -- 상품
  product_id          uuid not null references products(id),
  product_code        text not null,
  product_name        text not null,
  unit_price          numeric(12,2),            -- 제출 시점 단가 스냅샷(마당). 롤 주문이면 null
  qty                 numeric(10,2) not null,   -- 정수(마 또는 롤 수)
  unit                text not null default '마' check (unit in ('마','롤')),
  -- 고객
  phone               text not null,            -- 숫자만
  customer_name       text not null,
  customer_id         uuid,                     -- customers.id, 기존 고객이면
  depositor_name      text not null default '', -- 입금자명(주문자와 다를 때)
  address             text not null default '',
  address_detail      text not null default '',
  delivery_message    text not null default '',
  -- 배송
  merge_with_order_id text,                     -- 고객이 고른 합배송 대상 orders.id. null = 단독
  use_free_shipping   boolean not null default false,
  shipping_fee        integer not null default 0,  -- 제출 시점 계산값
  total_amount        integer not null default 0,
  -- 개인정보 수집·이용 동의 — 고객이 체크한 시각. 서버가 동의 없는 제출을 거부하므로 항상 채워진다.
  privacy_agreed_at   timestamptz not null default now(),
  -- 처리
  converted_order_id  text,
  rejected_reason     text,
  handled_by          text,
  handled_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_link_drafts_user_status on link_order_drafts(user_id, status, created_at);
create index if not exists idx_link_drafts_phone_created on link_order_drafts(phone, created_at);
alter table link_order_drafts enable row level security;
drop policy if exists tenant_link_order_drafts on link_order_drafts;
create policy tenant_link_order_drafts on link_order_drafts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE link_order_drafts; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

select (select count(*) from link_order_drafts) as drafts,
       (select count(*) from phone_verifications) as verifications;
