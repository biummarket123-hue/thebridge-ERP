-- ============================================================
-- SaaS Supabase 프로젝트 초기화 — public 스키마의 표·함수·정책을 전부 지운다
-- ⚠️ 되돌릴 수 없다. 4월 체험판 때 만든 옛 표(companies·users·orders 2건 등)를 버리고
--    migrations/_saas_fresh_db_all.sql 로 새로 만들 때만 쓴다. 로하이마켓 운영 DB 에서는 절대 실행 금지.
-- 실행 전 확인: select count(*) from orders;  -- 체험판 데이터 몇 건인지 눈으로 본다
-- ============================================================

-- 1) auth.users 에 걸린 트리거(옛 handle_new_user·handle_new_thebridge_user) 제거
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_thebridge_user_created on auth.users;

-- 2) public 의 모든 표·뷰·함수를 지운다 (의존 관계는 cascade 로)
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;
  for r in select viewname from pg_views where schemaname = 'public' loop
    execute format('drop view if exists public.%I cascade', r.viewname);
  end loop;
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- 3) 옛 체험판 로그인 계정 정리(선택) — 새 가입은 새 계정으로 다시 만든다.
--    남겨 둘 계정이 있으면 이 줄은 실행하지 말 것.
-- delete from auth.users;

-- 4) 주문 이미지 버킷은 그대로 둔다(있으면 init 가 on conflict 로 넘어간다). 객체까지 비우려면:
-- delete from storage.objects where bucket_id = 'order-images';
