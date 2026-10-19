-- 구독형 SaaS 2단계(2) — 담당자 잠금·포장 담당 규칙을 DB 가 판정한다
-- saas_manager_sessions.sql 다음에 실행. 두 번 실행해도 안전.
--
-- 지금까지 lib/managerLock.js(checkOrderLock·isPacker)가 브라우저에서만 막던 규칙을 주문(orders) UPDATE 트리거로 옮긴다.
-- "지금 누구인가"는 담당자 토큰(current_manager_id) — 토큰이 없으면 이름 없는 비관리자로 본다.
--
-- 규칙(앞에서부터):
--   1. 서버(service role, auth.uid() null) · 관리자 토큰 → 전부 허용
--   2. "포장 작업"만 바꾸는 갱신은 누구나 허용 — 상태(접수↔포장완료)·포장 도장·품목 포장 표시·원단 없음·메모·출고/라벨 요청·변경 기록 도장
--      (포장 패드는 남의 주문도 포장한다. 옛 화면과 같은 동작)
--   3. 그 밖의 갱신(주소·금액·합배송·보관·보류·입금 칸 등)은
--        · 포장 담당(is_packer, 비관리자) → 거부
--        · 주문 담당자가 비어 있거나 공용(is_public) → 허용
--        · 주문 담당자 = 나(토큰의 담당자) → 허용
--        · 같은 합배송 묶음에 내 담당 주문이 있으면 → 허용
--        · 그 외 → "이 주문은 ○○ 담당입니다" 거부
-- 삭제는 saas_manager_sessions.sql 의 saas_admin_delete 정책이 이미 관리자만 허용한다.

create or replace function orders_lock_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pack_cols text[] := array['status','packed_at','packed_sig','items','fabric_missing','fabric_missing_items','fabric_missing_at',
                            'note','memo','last_actor','last_route','last_actor_at','ship_requested_at','ship_requested_by',
                            'label_requested_at','label_requested_by','label_printed_at','invoice_printed_at'];
  oldj jsonb; newj jsonb;
  mid bigint; me managers%rowtype;
  pack_only boolean;
begin
  if auth.uid() is null then return new; end if;
  mid := current_manager_id();
  if mid is not null then
    select * into me from managers where id = mid;
    if coalesce(me.is_admin, false) then return new; end if;
  end if;

  -- 포장 작업만 바뀌었나: 포장 칸을 뺀 나머지가 같고, 상태는 접수/포장완료 안에서만 움직였나
  oldj := to_jsonb(old) - pack_cols;
  newj := to_jsonb(new) - pack_cols;
  pack_only := (oldj = newj)
    and (new.status is not distinct from old.status or new.status in ('접수','포장완료'));
  if pack_only then return new; end if;

  if mid is not null and coalesce(me.is_packer, false) then
    raise exception '포장 담당은 상태(접수·포장완료)와 메모만 바꿀 수 있습니다' using errcode = '42501';
  end if;

  if old.manager is null or old.manager = '' then return new; end if;
  if mid is not null and old.manager = me.name then return new; end if;
  if exists (select 1 from managers m where m.user_id = auth.uid() and m.name = old.manager and m.is_public) then return new; end if;
  if old.merge_group_id is not null and mid is not null and exists (
    select 1 from orders o2 where o2.user_id = auth.uid() and o2.merge_group_id = old.merge_group_id and o2.manager = me.name
  ) then return new; end if;

  raise exception '이 주문은 % 담당입니다. 담당자에게 문의해주세요', old.manager using errcode = '42501';
end $$;

drop trigger if exists orders_lock_guard on orders;
create trigger orders_lock_guard before update on orders for each row execute function orders_lock_guard();
