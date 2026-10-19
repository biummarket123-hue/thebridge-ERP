-- 주문 변경 기록(order_events) 자동 정리 — 3개월(90일) 지난 기록을 매일 새벽에 지운다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. 배포와는 무관합니다(화면 코드는 안 바뀝니다).
-- 여러 번 실행해도 안전합니다. migrations/add_order_events.sql 을 먼저 실행한 DB 여야 합니다.
--
-- 무슨 문제를 푸는가:
--   변경 기록은 지우는 규칙 없이 쌓이기만 했다. 하루 300건 안팎이라 1년에 11만 건쯤 —
--   당장 넘칠 양은 아니지만, 끝없이 늘어나는 테이블은 언젠가 조회가 느려지고 용량을 먹는다.
--   그때 가서 한꺼번에 지우는 것보다 처음부터 매일 조금씩 지우는 편이 안전하다.
--
-- 왜 3개월인가 (2026-09-29 결정):
--   3개월 넘은 주문을 다시 들여다보는 일은 드물다. 3개월이면 약 2만 7천 줄, 12MB 안팎에서
--   더 늘지 않는다(기록 한 줄 평균 203바이트, 실측).
--
-- 무엇을 지우고 무엇을 남기는가:
--   지운다   보관 기간(3개월)이 지난 기록 중, 주문이 이미 출고완료됐거나 삭제된 것
--   남긴다   아직 안 나간 주문의 기록 — 기간이 지났어도
--
--   기록을 두는 이유가 미아 주문(물건은 나갔는데 ERP 는 출고완료가 아닌 주문)을 되짚는
--   것이다. 몇 달씩 보관·보류로 묵은 주문이 바로 그 대상이라, 그 주문이 끝나기 전에
--   기록부터 지우면 정작 필요한 순간에 볼 게 없다. 출고완료된 주문은 그 시점부터
--   기록이 더 늘지 않으므로, 출고하고 3개월이 지나면 그 주문의 기록은 통째로 사라진다.
--
-- 왜 화면이 아니라 DB 가 지우는가:
--   화면은 기록을 지울 수 없게 막혀 있다(RLS 에 쓰기 정책이 없다 — 고칠 수 있는 기록은
--   기록이 아니다). 그 원칙을 그대로 둔다. 정리 함수도 화면에서는 부를 수 없다.
--   DB 안의 예약 작업(pg_cron)이 부르므로 ERP 를 아무도 켜 두지 않아도 돈다.
--
-- 보관 기간을 바꾸려면:
--   맨 아래 cron.schedule 줄의 90 을 바꿔 이 파일을 다시 실행한다. 늘리는 것은 언제든 된다
--   (이미 지워진 기록은 돌아오지 않는다). 90 미만으로는 못 줄인다 — 함수가 거부한다.
--   한 번 지운 기록은 되살릴 수 없다.

-- ── 정리 함수 ─────────────────────────────────────────────────
-- 지운 건수를 돌려준다. SQL Editor 에서 직접 불러도 된다:
--   select purge_old_order_events();        -- 3개월 기준으로 지금 정리
--   select purge_old_order_events(365);     -- 이번만 1년 기준으로
--
-- 주문 id 는 글자로 바꿔 견준다. 저장소의 옛 스키마에는 orders.id 가 text 로 적혀 있고
-- 기록 쪽은 uuid 라, 그대로 견주면 DB 에 따라 형이 안 맞아 에러가 난다.
create or replace function purge_old_order_events(p_keep_days int default 90)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  n int;
begin
  -- 실수로 0 이나 작은 수를 넣으면 기록이 통째로 날아간다. 되돌릴 수 없으므로 막는다.
  if p_keep_days is null or p_keep_days < 90 then
    raise exception '보관 기간은 90일 이상이어야 합니다 (받은 값: %)', p_keep_days;
  end if;

  delete from order_events e
   where e.created_at < now() - make_interval(days => p_keep_days)
     and e.order_id::text not in (
       select lower(o.id::text) from orders o
        where o.status is distinct from '출고완료'
     );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 화면(로그인한 사용자·비로그인)에서는 부를 수 없게 한다.
-- 부르더라도 RLS 가 삭제를 막지만(쓰기 정책 없음), 문 자체를 닫아 둔다.
revoke all on function purge_old_order_events(int) from public;
DO $$
BEGIN
  IF exists (select 1 from pg_roles where rolname = 'anon') THEN
    revoke all on function purge_old_order_events(int) from anon;
  END IF;
  IF exists (select 1 from pg_roles where rolname = 'authenticated') THEN
    revoke all on function purge_old_order_events(int) from authenticated;
  END IF;
END $$;

-- 기간으로 지우는 길 — 위 인덱스(idx_order_events_recent)는 user_id 가 앞에 있어
-- "전체에서 오래된 것"을 찾는 데는 못 쓴다.
create index if not exists idx_order_events_created
  on order_events (created_at);

-- ── 예약 ──────────────────────────────────────────────────────
-- 매일 새벽 3시(한국 시간) = 18:00 UTC. 아무도 ERP 를 안 쓰는 시간이다.
-- 같은 이름으로 다시 걸면 덮어쓴다 — 여러 번 실행해도 작업이 하나만 남는다.
--
-- pg_cron 을 켤 수 없는 환경이면 함수만 만들고 예약은 건너뛴다(아래 안내가 뜬다).
-- 그때는 대시보드 > Database > Extensions 에서 pg_cron 을 켠 뒤 이 파일을 다시 실행한다.
DO $$
BEGIN
  BEGIN
    create extension if not exists pg_cron with schema pg_catalog;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'pg_cron 을 켜지 못했습니다: %', sqlerrm;
  END;

  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE '자동 정리가 예약되지 않았습니다 — 대시보드 > Database > Extensions 에서 pg_cron 을 켠 뒤 이 파일을 다시 실행하세요. 그 전까지는 select purge_old_order_events(); 로 직접 정리할 수 있습니다.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'purge-order-events',
    '0 18 * * *',
    'select public.purge_old_order_events(90);'
  );
  RAISE NOTICE '자동 정리 예약 완료 — 매일 03:00(한국 시간), 보관 기간 90일';
END $$;

-- ── 확인 ──────────────────────────────────────────────────────
-- 지금 쌓인 기록과, 오늘 정리가 돈다면 지워질 건수(처음 3개월 동안은 0 이 정상이다).
select count(*)                                   as "전체 기록",
       min(created_at)                            as "가장 오래된 기록",
       count(*) filter (
         where created_at < now() - interval '90 days'
           and order_id::text not in (
             select lower(id::text) from orders where status is distinct from '출고완료')
       )                                          as "지금 정리하면 지워질 건수"
  from order_events;

-- 예약이 걸렸는지는 아래로 본다(pg_cron 이 켜진 뒤):
--   select jobname, schedule, command, active from cron.job where jobname = 'purge-order-events';
-- 실제로 돌았는지, 몇 건 지웠는지:
--   select start_time, status, return_message from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'purge-order-events')
--    order by start_time desc limit 10;
