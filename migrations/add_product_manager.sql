-- 품번 담당자 + 담당자 이니셜 품번 (2026-10-08)
-- Supabase 대시보드 > SQL Editor 에서 실행하세요. 여러 번 실행해도 안전합니다. ⚠️ 배포보다 먼저.
-- 전제: add_stock_rolls.sql 이 먼저 들어가 있어야 한다(products · product_code_seq · next_product_code).
--
-- 무슨 문제를 푸는가:
--   입고한 담당자가 그 원단을 파는 경우가 대부분인데, 품번·롤에는 담당자가 없어 창고의 롤이 누구
--   원단인지 ERP 가 모른다(롤에는 "검단한 사람"만 남는다). 포장팀이 원단이 없을 때 누구를 부를지,
--   셀러가 자기 원단만 보는 필터, 담당자별 재고가 전부 이 칸에서 나온다.
--
--   품번 앞글자도 담당자를 따른다(사용자 지정 2026-10-08): 장향숙 A · 송미송 S · 손희우 W ·
--   고문님 H · 실장님 L · 테스트 TEST · 나머지(유지숙·옥정점·마켓24·방문고객 등) LH 그대로.
--   품번만 보고 누구 원단인지 알자는 것. 한글은 못 쓴다 — 품번은 스캐너가 키보드처럼 치는 값이라
--   영문 대문자·숫자만(rollStock.SCAN_SAFE). 이니셜은 설정 > 담당자에서 바꾼다.
--
--   품번 담당자는 "기본값"이지 "제한"이 아니다 — 다른 셀러가 남의 원단을 팔면 주문 담당자는 그 셀러다.
--   정산은 지금처럼 주문 담당자 기준. 품번의 앞글자는 발급 때 박히고 바뀌지 않는다(라벨이 이미 나갔다) —
--   원단 주인이 바뀌면 products.manager 만 고친다. 화면은 앞글자를 다시 읽어 쓰지 않는다.

-- 1. 품번 담당자 — 이름(orders.manager 와 같은 꼴). 없으면 빈 문자열.
alter table products add column if not exists manager text not null default '';

-- 2. 담당자 이니셜(품번 접두어). 영문으로 시작하는 영문 대문자·숫자 1~6(숫자로 시작하면 전화번호 꼴과 섞인다). 없으면 LH.
--    managers 는 ERP 본체 표라 여기서 만들지 않는다 — 테스트 DB 처럼 없는 곳에서는 건너뛴다.
alter table if exists managers add column if not exists code text;

-- 3. 품번 발급 — 접두어를 받는다. 비우거나 규칙에 안 맞으면 LH.
--    먼저 새 판을 만들고 무인자 판을 지운다(그 사이에도 발급이 끊기지 않게). 무인자 판을 남기면
--    PostgREST 가 {} 호출을 둘 중 어느 것으로 풀지 모호해진다. 배포 전 옛 화면의 {} 호출은 default 로 풀린다.
create or replace function next_product_code(p_prefix text default 'LH') returns text language sql as $$
  select (case when p_prefix ~ '^[A-Z][A-Z0-9]{0,5}$' then p_prefix else 'LH' end)
         || '-' || to_char(now() at time zone 'Asia/Seoul', 'YYMM')
         || '-' || lpad(nextval('product_code_seq')::text, 4, '0');
$$;
drop function if exists next_product_code();

-- 4. 초기 이니셜(사용자 지정 2026-10-08). 이미 적힌 값은 건드리지 않는다.
do $$ begin
  if to_regclass('public.managers') is not null then
    update managers set code = 'A'    where name = '장향숙' and code is null;
    update managers set code = 'S'    where name = '송미송' and code is null;
    update managers set code = 'W'    where name = '손희우' and code is null;
    update managers set code = 'H'    where name = '고문님' and code is null;
    update managers set code = 'L'    where name = '실장님' and code is null;
    update managers set code = 'TEST' where name = '테스트' and code is null;
  end if;
end $$;
