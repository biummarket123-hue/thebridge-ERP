-- ============================================================
-- 더브릿지 ERP SaaS Schema
-- Supabase SQL Editor에서 실행하세요
-- ============================================================

-- ■■■ 1. companies 테이블 ■■■
create table if not exists companies (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  owner_email text not null unique,
  plan text default 'trial' check (plan in ('trial','basic','pro','enterprise')),
  trial_start timestamptz default now(),
  trial_end timestamptz default (now() + interval '14 days'),
  created_at timestamptz default now()
);

-- ■■■ 2. subscriptions 테이블 ■■■
create table if not exists subscriptions (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references companies(id) on delete cascade,
  status text default 'trial' check (status in ('trial','active','cancelled','expired')),
  amount numeric default 0,
  started_at timestamptz default now(),
  next_billing timestamptz
);

-- ■■■ 3. 기존 테이블에 company_id 추가 ■■■

-- orders
alter table orders add column if not exists company_id uuid references companies(id) on delete cascade;

-- inventory
alter table inventory add column if not exists company_id uuid references companies(id) on delete cascade;

-- customers
alter table customers add column if not exists company_id uuid references companies(id) on delete cascade;

-- logs
alter table logs add column if not exists company_id uuid references companies(id) on delete cascade;

-- managers
alter table managers add column if not exists company_id uuid references companies(id) on delete cascade;

-- settings (id가 text인 기존 테이블)
alter table settings add column if not exists company_id uuid references companies(id) on delete cascade;

-- ■■■ 4. RLS 정책 재설정 (company_id 기준) ■■■

-- 기존 정책 삭제
drop policy if exists "Allow all for anon" on orders;
drop policy if exists "Allow all for anon" on inventory;
drop policy if exists "Allow all for anon" on customers;
drop policy if exists "Allow all for anon" on logs;
drop policy if exists "Allow all for anon" on managers;

-- companies: RLS
alter table companies enable row level security;
alter table subscriptions enable row level security;

-- auth.uid()로 로그인한 사용자의 이메일 → companies.owner_email 매칭
create or replace function get_my_company_id()
returns uuid
language sql
security definer
stable
as $$
  select id from companies where owner_email = auth.email()
$$;

-- companies 정책: 본인 회사만
create policy "Users can view own company"
  on companies for select
  using (owner_email = auth.email());

create policy "Users can update own company"
  on companies for update
  using (owner_email = auth.email());

-- subscriptions 정책
create policy "Users can view own subscriptions"
  on subscriptions for select
  using (company_id = get_my_company_id());

-- orders 정책
create policy "Company orders select" on orders for select using (company_id = get_my_company_id());
create policy "Company orders insert" on orders for insert with check (company_id = get_my_company_id());
create policy "Company orders update" on orders for update using (company_id = get_my_company_id());
create policy "Company orders delete" on orders for delete using (company_id = get_my_company_id());

-- inventory 정책
create policy "Company inventory select" on inventory for select using (company_id = get_my_company_id());
create policy "Company inventory insert" on inventory for insert with check (company_id = get_my_company_id());
create policy "Company inventory update" on inventory for update using (company_id = get_my_company_id());
create policy "Company inventory delete" on inventory for delete using (company_id = get_my_company_id());

-- customers 정책
create policy "Company customers select" on customers for select using (company_id = get_my_company_id());
create policy "Company customers insert" on customers for insert with check (company_id = get_my_company_id());
create policy "Company customers update" on customers for update using (company_id = get_my_company_id());
create policy "Company customers delete" on customers for delete using (company_id = get_my_company_id());

-- logs 정책
create policy "Company logs select" on logs for select using (company_id = get_my_company_id());
create policy "Company logs insert" on logs for insert with check (company_id = get_my_company_id());
create policy "Company logs update" on logs for update using (company_id = get_my_company_id());
create policy "Company logs delete" on logs for delete using (company_id = get_my_company_id());

-- managers 정책
create policy "Company managers select" on managers for select using (company_id = get_my_company_id());
create policy "Company managers insert" on managers for insert with check (company_id = get_my_company_id());
create policy "Company managers update" on managers for update using (company_id = get_my_company_id());
create policy "Company managers delete" on managers for delete using (company_id = get_my_company_id());

-- settings 정책 (기존에 RLS 없었다면)
alter table settings enable row level security;
create policy "Company settings select" on settings for select using (company_id = get_my_company_id());
create policy "Company settings insert" on settings for insert with check (company_id = get_my_company_id());
create policy "Company settings update" on settings for update using (company_id = get_my_company_id());
create policy "Company settings delete" on settings for delete using (company_id = get_my_company_id());

-- ■■■ 5. 회원가입 시 자동으로 company 생성하는 트리거 ■■■
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  company_name text;
begin
  company_name := coalesce(new.raw_user_meta_data->>'company_name', '내 회사');
  insert into companies (name, owner_email)
  values (company_name, new.email);
  return new;
end;
$$;

-- 기존 트리거가 있으면 삭제 후 재생성
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ■■■ 6. 인덱스 ■■■
create index if not exists idx_orders_company on orders(company_id);
create index if not exists idx_inventory_company on inventory(company_id);
create index if not exists idx_customers_company on customers(company_id);
create index if not exists idx_logs_company on logs(company_id);
create index if not exists idx_managers_company on managers(company_id);
