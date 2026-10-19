-- 보류(is_parked) — 몇 달씩 이러지도 저러지도 못하는 주문을 출고 큐에서 빼둔다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 보관과 뭐가 다른가:
--   · 보관(is_holding/held_at) — 물건은 다 됐고 창고에 잡아둔 것. 곧 나간다.
--     고객이 "모아서 받을게요" 하는 경우라 며칠~몇 주 단위다.
--   · 보류(is_parked)          — 나갈 수 없는 것. 연락 두절, 원단 단종, 결제 분쟁 등.
--     몇 달이 걸리고, 언제 풀릴지 아무도 모른다.
--
--   둘을 한 칸에 섞으면 "곧 나갈 것" 사이에 "언제 나갈지 모르는 것"이 끼어
--   보관 탭을 훑을 때마다 죽은 건을 매번 지나쳐야 한다. 그래서 칸을 나눈다.
--
-- 왜 사유(park_reason)가 필수인가:
--   서랍에 넣고 3개월 뒤에 꺼내는 기능이다. 그때 "이건 왜 여기 있지"를 답할 수
--   있는 건 넣을 때 적어둔 한 줄뿐이다. 안 적으면 꺼낼 수도 버릴 수도 없는 건이 된다.
--
-- 왜 parked_at 이 따로 있는가:
--   보류는 잊히는 게 진짜 위험이다. 넣은 날짜가 있어야 "87일째"를 셀 수 있고,
--   오래된 것부터 위로 올려 썩는 걸 막을 수 있다.
--
--   보관과 달리 '요청'과 '완료'를 가르지 않는다 — 포장직원이 카드에서 직접 넣고
--   직접 꺼낸다. 중간에 지시를 전달할 사람이 없다.

alter table orders add column if not exists is_parked   boolean not null default false;
alter table orders add column if not exists parked_at   timestamptz;
alter table orders add column if not exists park_reason text;

-- 보류 탭은 "보류 중인 것을 오래된 순으로" 훑는다 — 그 경로만 인덱스.
create index if not exists idx_orders_parked
  on orders (user_id, parked_at)
  where is_parked;
