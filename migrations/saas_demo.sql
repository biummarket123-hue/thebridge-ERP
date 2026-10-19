-- 구독형 SaaS — 1시간 체험(데모) 회사
-- saas_order_lock.sql 다음에 실행. 두 번 실행해도 안전.
--
-- 홈 화면의 "체험해 보기"는 방문자마다 임시 회사(auth 유저)를 하나 만들고 샘플 데이터를 채운다(demo_seed).
--   · company_accounts.is_demo = true, trial_end = 1시간 뒤 → 1시간 지나면 is_company_active() 가 거짓 = 읽기 전용
--   · 브라우저는 1시간 뒤 자동 로그아웃(SaasApp 의 체험 타이머)
--   · 서버 크론(api/demo-cleanup.js, 매시간)이 demo_expired_owners() 로 지난 체험 회사를 통째로 지운다(auth.users 삭제 → 전부 cascade)
-- 그래서 체험 중 입력한 것은 실제로 남지 않고, 체험자끼리 섞이지도 않는다.

alter table company_accounts add column if not exists is_demo boolean not null default false;
create index if not exists idx_company_accounts_demo on company_accounts(is_demo, created_at);

-- 체험 회사 한 곳의 샘플 데이터. 서버(service role)만 부른다.
create or replace function demo_seed(p_owner_id uuid, p_login_id text, p_admin_pin text default '1234') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  mid bigint;
  p1 uuid; p2 uuid; p3 uuid;
  o1 uuid; o2 uuid; o3 uuid; o4 uuid; o5 uuid; o6 uuid;
  d text := to_char(now(), 'YYYY. MM. DD.');
  t text := to_char(now(), 'HH24:MI');
begin
  if auth.uid() is not null then
    return jsonb_build_object('ok', false, 'error', '서버 전용 함수입니다');
  end if;

  insert into company_accounts (owner_id, login_id, name, contact, plan, status, trial_end, max_managers, is_demo)
  values (p_owner_id, p_login_id, '체험 원단', '', 'trial', 'active', now() + interval '1 hour', 3, true)
  on conflict (owner_id) do nothing;
  insert into subscription_events (owner_id, kind, plan, period_start, period_end, memo)
  values (p_owner_id, 'trial_start', 'trial', now(), now() + interval '1 hour', '체험 1시간');

  insert into managers (user_id, name, is_admin, is_public) values (p_owner_id, '체험 관리자', true, false) returning id into mid;
  insert into managers (user_id, name, is_admin, is_public) values (p_owner_id, '방문고객', false, true);
  perform service_reset_manager_pin(p_owner_id, mid, p_admin_pin);

  insert into settings (user_id, data) values (p_owner_id, jsonb_build_object('senderName', '체험 원단', 'saas', jsonb_build_object('companyName', '체험 원단', 'productPrefix', 'DM')))
  on conflict (user_id) do nothing;

  insert into customers (user_id, name, phone, address) values
    (p_owner_id, '김영희', '010-1234-5678', '서울 중구 을지로 123'),
    (p_owner_id, '박철수', '010-2345-6789', '경기 성남시 분당구 판교로 45'),
    (p_owner_id, '이수진', '010-3456-7890', '부산 해운대구 센텀로 7'),
    (p_owner_id, '최민호', '010-4567-8901', '대구 중구 동성로 12');

  insert into products (user_id, code, name, color, unit_price) values (p_owner_id, 'DM-2610-0001', '린넨코튼', '베이지', 5500) returning id into p1;
  insert into products (user_id, code, name, color, unit_price) values (p_owner_id, 'DM-2610-0002', '워싱 옥스포드', '네이비', 7000) returning id into p2;
  insert into products (user_id, code, name, color, unit_price) values (p_owner_id, 'DM-2610-0003', '쉬폰', '아이보리', 4200) returning id into p3;
  insert into stock_rolls (user_id, product_id, roll_code, length_received, length_available, length_remaining, status, location, inspected_at) values
    (p_owner_id, p1, 'DM-2610-0001-R01', 50, 49.5, 32, 'available', 'A-01', now() - interval '20 days'),
    (p_owner_id, p1, 'DM-2610-0001-R02', 50, 50, 50, 'available', 'A-01', now() - interval '20 days'),
    (p_owner_id, p2, 'DM-2610-0002-R01', 40, 40, 6, 'available', 'B-03', now() - interval '12 days'),
    (p_owner_id, p3, 'DM-2610-0003-R01', 60, 60, 60, 'available', 'C-02', now() - interval '3 days');

  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at)
  values (p_owner_id, '김영희', '010-1234-5678', '서울 중구 을지로 123',
    jsonb_build_array(jsonb_build_object('itemId','d1','fabric','린넨코튼','color','베이지','qty',3,'unit','마','unitPrice',5500,'amount',16500)),
    '미입금', '접수', '체험 관리자', 20500, 4000, to_char(now() + interval '1 day', 'YYYY-MM-DD'), d, t, now() - interval '2 hours') returning id into o1;
  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at, packed_at)
  values (p_owner_id, '박철수', '010-2345-6789', '경기 성남시 분당구 판교로 45',
    jsonb_build_array(jsonb_build_object('itemId','d2','fabric','워싱 옥스포드','color','네이비','qty',10,'unit','마','unitPrice',7000,'amount',70000)),
    '입금완료', '포장완료', '체험 관리자', 74000, 4000, to_char(now(), 'YYYY-MM-DD'), d, t, now() - interval '5 hours', now() - interval '1 hour') returning id into o2;
  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at)
  values (p_owner_id, '이수진', '010-3456-7890', '부산 해운대구 센텀로 7',
    jsonb_build_array(jsonb_build_object('itemId','d3','fabric','쉬폰','color','아이보리','qty',5,'unit','마','unitPrice',4200,'amount',21000)),
    '입금완료', '접수', '체험 관리자', 25000, 4000, to_char(now() + interval '1 day', 'YYYY-MM-DD'), d, t, now() - interval '1 day') returning id into o3;
  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at, packed_at, shipped_at, shipped_via)
  values (p_owner_id, '최민호', '010-4567-8901', '대구 중구 동성로 12',
    jsonb_build_array(jsonb_build_object('itemId','d4','fabric','린넨코튼','color','베이지','qty',15,'unit','마','unitPrice',5500,'amount',82500)),
    '입금완료', '출고완료', '체험 관리자', 86500, 4000, to_char(now() - interval '2 days', 'YYYY-MM-DD'), d, t, now() - interval '3 days', now() - interval '2 days', now() - interval '2 days', 'CJ') returning id into o4;
  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at, packed_at, shipped_at, shipped_via)
  values (p_owner_id, '김영희', '010-1234-5678', '서울 중구 을지로 123',
    jsonb_build_array(jsonb_build_object('itemId','d5','fabric','워싱 옥스포드','color','네이비','qty',24,'unit','마','unitPrice',7000,'amount',168000)),
    '입금완료', '출고완료', '체험 관리자', 175000, 7000, to_char(now() - interval '9 days', 'YYYY-MM-DD'), d, t, now() - interval '10 days', now() - interval '9 days', now() - interval '9 days', 'KD') returning id into o5;
  insert into orders (user_id, customer, phone, address, items, payment, status, manager, total_amount, shipping_fee, ship_date, date, time, created_at)
  values (p_owner_id, '박철수', '010-2345-6789', '경기 성남시 분당구 판교로 45',
    jsonb_build_array(jsonb_build_object('itemId','d6','fabric','쉬폰','color','아이보리','qty',8,'unit','마','unitPrice',4200,'amount',33600)),
    '미입금', '접수', '', 37600, 4000, to_char(now() + interval '2 days', 'YYYY-MM-DD'), d, t, now() - interval '30 minutes') returning id into o6;

  insert into payment_logs (user_id, order_id, customer, type, amount, created_at) values
    (p_owner_id, o2::text, '박철수', '입금', 74000, now() - interval '4 hours'),
    (p_owner_id, o3::text, '이수진', '입금', 25000, now() - interval '20 hours'),
    (p_owner_id, o4::text, '최민호', '입금', 86500, now() - interval '3 days'),
    (p_owner_id, o5::text, '김영희', '입금', 175000, now() - interval '10 days');

  return jsonb_build_object('ok', true, 'manager_id', mid, 'manager_name', '체험 관리자', 'expires_at', now() + interval '1 hour');
end $$;
revoke execute on function demo_seed(uuid, text, text) from public, anon, authenticated;
grant execute on function demo_seed(uuid, text, text) to service_role;

-- 지난 체험 회사(1시간 + 5분 유예) — 서버가 이 목록의 auth 유저를 지운다
create or replace function demo_expired_owners() returns setof uuid
language sql security definer set search_path = public as $$
  select owner_id from company_accounts where is_demo and created_at < now() - interval '65 minutes'
$$;
revoke execute on function demo_expired_owners() from public, anon, authenticated;
grant execute on function demo_expired_owners() to service_role;
