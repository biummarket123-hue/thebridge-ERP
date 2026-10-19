-- ============================================================
-- 멀티테넌트 격리 마이그레이션 (TOP 5 버그 #1, #2, #3, #6 수정)
-- Supabase SQL Editor에서 이 파일 전체를 실행하세요.
--
-- ⚠️ 이 마이그레이션은 다음을 수행합니다:
--  1) 모든 테이블에 user_id uuid 컬럼 추가
--  2) settings 테이블을 per-user로 재설계
--  3) deposits 테이블 신규 생성 (계약금/잔금)
--  4) RLS 정책을 "anon 전체 허용" → "auth.uid() 본인 데이터만"으로 교체
--
-- ⚠️ 기존 데이터는 user_id가 NULL이 되어 조회 불가가 됩니다.
--    운영 중인 실데이터가 있다면 (가)실행 전에 백업, (나)아래 "백필" 섹션에서
--    해당 레코드에 올바른 user_id를 수동 UPDATE 하세요.
-- ============================================================

-- ── 1. user_id 컬럼 추가 ─────────────────────────────────────
alter table orders     add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table inventory  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table customers  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table logs       add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table managers   add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- address_detail 컬럼 (db.js에서 사용 중인데 기존 스키마에 없을 수 있음)
alter table orders     add column if not exists address_detail text;

-- 인덱스
create index if not exists idx_orders_user      on orders(user_id);
create index if not exists idx_inventory_user   on inventory(user_id);
create index if not exists idx_customers_user   on customers(user_id);
create index if not exists idx_logs_user        on logs(user_id);
create index if not exists idx_managers_user    on managers(user_id);

-- managers.name 기존 전역 unique 제거 → (user_id, name) 복합 unique
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'managers'::regclass and contype = 'u'
  loop
    execute format('alter table managers drop constraint %I', c.conname);
  end loop;
end $$;
create unique index if not exists idx_managers_user_name on managers(user_id, name);

-- ── 2. settings 테이블 재설계 (per-user) ─────────────────────
create table if not exists settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- 기존에 id='main' 단일 row로 운영하던 스키마라면 여기서 컬럼 구조 정리
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'settings' and column_name = 'id'
  ) then
    -- id 컬럼이 있으면 user_id를 primary key로 승격
    alter table settings drop constraint if exists settings_pkey;
    alter table settings add column if not exists user_id uuid references auth.users(id) on delete cascade;
    -- user_id가 not null인 row만 PK로 쓸 수 있으므로 일단 unique index로 대체
    create unique index if not exists settings_user_id_unique on settings(user_id) where user_id is not null;
  end if;
end $$;

-- ── 3. deposits 테이블 (계약금/잔금) 신규 생성 ───────────────
create table if not exists deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  customer text not null,
  phone text default '',
  content text default '',
  total bigint not null default 0,
  deposit bigint not null default 0,
  deposit_date text default '',
  balance_paid boolean not null default false,
  balance_date text default '',
  reg_date text default '',
  note text default '',
  created_at timestamptz default now()
);
create index if not exists idx_deposits_user on deposits(user_id);

-- ── 4. RLS: 기존 "anon 전체 허용" 정책 제거 → 본인 데이터만 ──
drop policy if exists "Allow all for anon" on orders;
drop policy if exists "Allow all for anon" on inventory;
drop policy if exists "Allow all for anon" on customers;
drop policy if exists "Allow all for anon" on logs;
drop policy if exists "Allow all for anon" on managers;

alter table orders     enable row level security;
alter table inventory  enable row level security;
alter table customers  enable row level security;
alter table logs       enable row level security;
alter table managers   enable row level security;
alter table settings   enable row level security;
alter table deposits   enable row level security;

create policy tenant_orders    on orders    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_inventory on inventory for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_customers on customers for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_logs      on logs      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_managers  on managers  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_settings  on settings  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tenant_deposits  on deposits  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- (선택) 백필: 기존 레코드를 특정 사용자 소유로 귀속
-- ------------------------------------------------------------
-- 1) Supabase > Authentication > Users 에서 소유자 auth user의 UUID 복사
-- 2) 아래 UPDATE의 '<USER_UUID>' 를 실제 UUID로 치환 후 실행
-- ============================================================
-- update orders     set user_id = '<USER_UUID>' where user_id is null;
-- update inventory  set user_id = '<USER_UUID>' where user_id is null;
-- update customers  set user_id = '<USER_UUID>' where user_id is null;
-- update logs       set user_id = '<USER_UUID>' where user_id is null;
-- update managers   set user_id = '<USER_UUID>' where user_id is null;
