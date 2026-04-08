-- ============================================================
-- 더브릿지 ERP - users 테이블 (이중 로그인 지원)
-- 더브릿지 Supabase (dcitethfhwqdautonnmo)에서 실행하세요
-- ============================================================

-- users 테이블: 로그인 소스 추적
create table if not exists users (
  id uuid primary key,
  email text not null,
  source text not null default 'thebridge' check (source in ('thebridge', 'biummarket')),
  company_name text,
  last_login timestamptz default now(),
  created_at timestamptz default now()
);

-- 이메일 유니크 인덱스
create unique index if not exists idx_users_email on users(email);

-- RLS 활성화
alter table users enable row level security;

-- 본인 데이터만 접근
create policy "Users can view own data"
  on users for select
  using (id = auth.uid());

create policy "Users can insert own data"
  on users for insert
  with check (id = auth.uid());

create policy "Users can update own data"
  on users for update
  using (id = auth.uid());

-- 회원가입 시 자동 users 레코드 생성 트리거
create or replace function handle_new_thebridge_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into users (id, email, source, company_name)
  values (
    new.id,
    new.email,
    'thebridge',
    coalesce(new.raw_user_meta_data->>'company_name', '')
  )
  on conflict (id) do update set last_login = now();
  return new;
end;
$$;

drop trigger if exists on_thebridge_user_created on auth.users;
create trigger on_thebridge_user_created
  after insert on auth.users
  for each row execute function handle_new_thebridge_user();
