-- 구독형 SaaS 4단계 — 구독이 끝난 회사는 읽기 전용
-- saas_company_accounts.sql 을 먼저 실행한 뒤 Supabase SQL Editor 에서 실행하세요. 두 번 실행해도 안전합니다.
--
-- 방식: 기존 정책(user_id = auth.uid())은 그대로 두고, 그 위에 제한(restrictive) 정책을 얹는다.
--   제한 정책은 기존 허용 정책과 AND 로 묶이므로 "자기 회사 행이고 && 구독이 살아 있어야" 쓸 수 있다.
--   읽기(select)는 건드리지 않는다 → 해지해도 데이터는 보인다. 쓰기(insert/update/delete)만 막힌다.
-- is_company_active() 는 company_accounts 행이 없는 회사(사내 계정)에 참을 돌려주므로 기존 운영에는 영향이 없다.
-- 없는 표는 건너뛴다(마이그레이션을 다 돌리지 않은 DB).
--
-- 한계: security definer RPC(roll_apply_movement·pack_item_from_roll 등)는 RLS 를 거치지 않는다.
--   화면은 만료 시 그 버튼을 숨기지만, API 를 직접 부르면 롤 수량은 바뀔 수 있다. 다음 단계에서 함수 안에 검사를 넣는다.

do $$
declare
  t text;
begin
  foreach t in array array[
    'orders','inventory','customers','logs','managers','settings','deposits','credits',
    'free_shipping_coupons','free_shipping_logs','payment_logs',
    'order_notes','order_returns','order_item_packing','order_events','notices','label_station',
    'delivery_message_presets','products','stock_rolls','stock_movements','thanks_label_requests','link_order_drafts'
  ] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists saas_active_insert on %I', t);
    execute format('drop policy if exists saas_active_update on %I', t);
    execute format('drop policy if exists saas_active_delete on %I', t);
    execute format('create policy saas_active_insert on %I as restrictive for insert with check (is_company_active())', t);
    execute format('create policy saas_active_update on %I as restrictive for update using (is_company_active()) with check (is_company_active())', t);
    execute format('create policy saas_active_delete on %I as restrictive for delete using (is_company_active())', t);
  end loop;
end $$;
