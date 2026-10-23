-- 구독형 SaaS — 요금제 4단계 + 문자 월간 사용량 (2026-10-23 사용자 결정)
-- saas_features.sql 다음에 실행. 두 번 실행해도 안전.
--
--   starter 9,900 / standard 39,000 / pro 89,000 / promax 149,000 (원/월) — 값은 api/_plans.js 가 단일 출처.
--   옛 basic(베이직) 은 standard(스탠다드) 로 옮긴다. 가입 중인 실제 고객은 없다(테스트 회사·데모만).
--   문자(출고 안내)는 원가가 그대로 나가므로 요금제별 월 건수로 막는다 — saas_sms_usage 가 saas_ai_usage 와 같은 꼴로 센다.

-- 1. 옛 이름 → 새 이름 (제약을 바꾸기 전에 값부터)
update company_accounts set plan = 'standard' where plan = 'basic';
update subscription_events set plan = 'standard' where plan = 'basic';
update saas_billing set plan = 'standard' where plan = 'basic';

-- 2. plan 허용값. 칸 정의의 check 는 Postgres 가 <표>_<칸>_check 로 이름 붙인다.
alter table company_accounts drop constraint if exists company_accounts_plan_check;
alter table company_accounts add constraint company_accounts_plan_check
  check (plan in ('trial', 'starter', 'standard', 'pro', 'promax'));

-- 3. 문자 월간 사용량 — 서버(service role)만 올린다. 브라우저는 자기 회사 행을 읽을 수만 있다(설정 화면의 "이번 달 N / 한도").
create table if not exists saas_sms_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  month text not null,                     -- 'YYYY-MM'
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (owner_id, month)
);
alter table saas_sms_usage enable row level security;
drop policy if exists saas_sms_usage_select on saas_sms_usage;
create policy saas_sms_usage_select on saas_sms_usage for select using (owner_id = auth.uid());

-- 서버 전용: 이번 달 발송 건수를 p_n 만큼 올리고 올린 뒤의 값을 돌려준다.
create or replace function service_bump_sms_usage(p_owner uuid, p_month text, p_n int default 1) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into saas_sms_usage (owner_id, month, count) values (p_owner, p_month, greatest(p_n, 0))
    on conflict (owner_id, month) do update set count = saas_sms_usage.count + greatest(p_n, 0), updated_at = now()
    returning count into n;
  return n;
end $$;
revoke all on function service_bump_sms_usage(uuid, text, int) from public, anon, authenticated;
