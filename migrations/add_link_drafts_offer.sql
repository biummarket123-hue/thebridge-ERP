-- 4단계-B: 인증 제거 + 셀러 링크 (docs/ERP_4단계B_링크주문_인증제거_셀러링크_지시서.md 1절)
-- add_link_order_drafts.sql 뒤에 실행. 두 번 실행해도 안전하다.

-- add_link_order_drafts.sql 을 초기 판으로 실행한 DB 에는 아래 세 칸이 없다(create table if not exists 는 칸을 더하지 않는다).
-- 여기서 보장한다. 이미 있으면 그대로.
alter table link_order_drafts
  add column if not exists unit              text not null default '마',
  add column if not exists depositor_name    text not null default '',
  add column if not exists privacy_agreed_at timestamptz not null default now();
alter table link_order_drafts drop constraint if exists link_order_drafts_unit_check;
alter table link_order_drafts add constraint link_order_drafts_unit_check check (unit in ('마','롤'));

alter table link_order_drafts
  add column if not exists source           text not null default 'public' check (source in ('public','seller')),
  add column if not exists token            text,                 -- 셀러 링크용 1회 토큰. 공개 링크는 null
  add column if not exists expires_at       timestamptz,          -- 셀러 링크 만료. 24시간
  add column if not exists confirmed_at     timestamptz,          -- 고객이 "이대로 주문" 누른 시각
  add column if not exists use_last_address boolean not null default false,  -- 공개 링크: "지난번 배송지로"
  add column if not exists wants_merge      boolean not null default false,  -- 공개 링크: "이전 주문과 함께"
  add column if not exists created_by       text,                 -- 셀러 링크 만든 담당자
  add column if not exists items            jsonb;                -- 셀러 링크: 품목 전부. product_id·qty 에는 첫 품목

-- status 에 'offered'(고객 확인 대기)·'expired' 추가
alter table link_order_drafts drop constraint if exists link_order_drafts_status_check;
alter table link_order_drafts add constraint link_order_drafts_status_check
  check (status in ('offered','new','converted','rejected','expired'));

-- 공개 링크는 주소를 안 받을 수 있다("지난번 배송지로")
alter table link_order_drafts alter column address set default '';

create unique index if not exists idx_link_drafts_token on link_order_drafts(token) where token is not null;

select count(*) filter (where source='seller') as seller_drafts, count(*) as drafts from link_order_drafts;
