-- 구독형 SaaS 2단계 — 담당자 권한을 DB 가 판정한다 (담당자 토큰)
-- saas_company_accounts.sql 다음에 실행. 두 번 실행해도 안전.
--
-- 지금까지 "관리자만 가능"은 브라우저 코드가 판정했다. 회사 세션만 있으면 API 로 무엇이든 할 수 있었다.
-- 이제:
--   · verify_manager_pin 이 성공하면 무작위 토큰을 발급해 해시만 manager_sessions 에 둔다(14일).
--   · 브라우저는 그 토큰을 모든 요청의 x-manager-token 헤더로 보낸다(src/lib/db.js setManagerToken).
--   · current_manager_id() 가 헤더의 토큰으로 담당자를 찾고, current_manager_is_admin() 이 관리자 여부를 돌려준다.
--   · 관리자 전용(제한 정책·트리거): 주문 삭제, 담당자 추가/수정/삭제, 회사 정보 수정, 출고완료 전환.
--   · 롤 재고·포장 표에는 구독 만료 트리거 — security definer RPC 도 거친다(saas_readonly_when_expired 의 빈틈).
-- 서버(service role, auth.uid() null)는 제한을 받지 않는다. 사내(company) 모드 DB 에는 이 파일을 쓰지 않는다.

create extension if not exists pgcrypto;

create table if not exists manager_sessions (
  token_hash text primary key,
  manager_id bigint not null references managers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_manager_sessions_user on manager_sessions(user_id, manager_id);
alter table manager_sessions enable row level security;
-- 정책 없음 — 브라우저는 못 읽는다. 아래 definer 함수만 쓴다.

-- ── PIN 검증: 성공하면 토큰 발급 (saas_company_accounts.sql 의 함수를 교체) ──
create or replace function verify_manager_pin(p_manager_id bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  r manager_pins%rowtype;
  own uuid;
  tok text;
begin
  select user_id into own from managers where id = p_manager_id;
  if own is null or own <> auth.uid() then
    return jsonb_build_object('ok', false, 'error', '담당자를 찾을 수 없습니다');
  end if;
  select * into r from manager_pins where manager_id = p_manager_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'no_pin', true);
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked_until', r.locked_until);
  end if;
  if p_pin is not null and p_pin ~ '^\d{4}$' and r.pin_hash = crypt(p_pin, r.pin_hash) then
    update manager_pins set fail_count = 0, locked_until = null where manager_id = p_manager_id;
    -- 토큰: 24바이트 무작위 → hex 48자. DB 에는 sha256 해시만.
    tok := encode(gen_random_bytes(24), 'hex');
    delete from manager_sessions where expires_at < now();
    insert into manager_sessions (token_hash, manager_id, user_id, expires_at)
      values (encode(digest(tok, 'sha256'), 'hex'), p_manager_id, own, now() + interval '14 days');
    return jsonb_build_object('ok', true, 'token', tok);
  end if;
  if r.fail_count + 1 >= 5 then
    update manager_pins set fail_count = 0, locked_until = now() + interval '10 minutes' where manager_id = p_manager_id;
    return jsonb_build_object('ok', false, 'locked_until', now() + interval '10 minutes');
  end if;
  update manager_pins set fail_count = fail_count + 1 where manager_id = p_manager_id;
  return jsonb_build_object('ok', false, 'attempts_left', 5 - (r.fail_count + 1));
end $$;
grant execute on function verify_manager_pin(bigint, text) to authenticated;

-- ── 헤더의 토큰 → 담당자 ──────────────────────────────────────
create or replace function current_manager_id() returns bigint
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  tok text;
  mid bigint;
begin
  begin
    tok := current_setting('request.headers', true)::json->>'x-manager-token';
  exception when others then
    tok := null;
  end;
  if tok is null or tok = '' then return null; end if;
  select s.manager_id into mid
    from manager_sessions s
   where s.token_hash = encode(digest(tok, 'sha256'), 'hex')
     and s.user_id = auth.uid()
     and s.expires_at > now();
  return mid;
end $$;
grant execute on function current_manager_id() to authenticated, anon;

create or replace function current_manager_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select m.is_admin from managers m where m.id = current_manager_id()), false)
$$;
grant execute on function current_manager_is_admin() to authenticated, anon;

-- 토큰 폐기(로그아웃·담당자 바꾸기). 헤더의 토큰 자신을 지운다.
create or replace function revoke_manager_token() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  begin tok := current_setting('request.headers', true)::json->>'x-manager-token'; exception when others then tok := null; end;
  if tok is not null and tok <> '' then
    delete from manager_sessions where token_hash = encode(digest(tok, 'sha256'), 'hex') and user_id = auth.uid();
  end if;
end $$;
grant execute on function revoke_manager_token() to authenticated;

-- ── 관리자 전용: 제한 정책 ───────────────────────────────────
-- 서버(service role)는 RLS 를 거치지 않으므로 영향 없음. 기존 허용 정책과 AND.
drop policy if exists saas_admin_delete on orders;
create policy saas_admin_delete on orders as restrictive for delete using (current_manager_is_admin());

drop policy if exists saas_admin_insert on managers;
drop policy if exists saas_admin_update on managers;
drop policy if exists saas_admin_delete on managers;
create policy saas_admin_insert on managers as restrictive for insert with check (current_manager_is_admin());
create policy saas_admin_update on managers as restrictive for update using (current_manager_is_admin()) with check (current_manager_is_admin());
create policy saas_admin_delete on managers as restrictive for delete using (current_manager_is_admin());

drop policy if exists saas_admin_update on company_accounts;
create policy saas_admin_update on company_accounts as restrictive for update using (current_manager_is_admin()) with check (current_manager_is_admin());

-- ── 출고완료 전환은 관리자만 (업무 규칙 5) — WITH CHECK 는 옛 행을 못 보므로 트리거로 ──
create or replace function orders_ship_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- 서버(service role)
  if new.status = '출고완료' and old.status is distinct from '출고완료' and not current_manager_is_admin() then
    raise exception '출고완료는 관리자 담당자만 할 수 있습니다' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists orders_ship_guard on orders;
create trigger orders_ship_guard before update of status on orders for each row execute function orders_ship_guard();

-- ── 구독 만료 시 롤·포장 표도 쓰기 금지 — definer RPC 도 트리거는 거친다 ──
create or replace function saas_active_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not is_company_active() then
    raise exception '구독이 끝나 읽기 전용입니다' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['products','stock_rolls','stock_movements','order_item_packing'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists saas_active_guard on %I', t);
    execute format('create trigger saas_active_guard before insert or update or delete on %I for each row execute function saas_active_guard()', t);
  end loop;
end $$;
