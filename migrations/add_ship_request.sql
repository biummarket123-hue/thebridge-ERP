-- 출고요청(ship_requested_at) — 보관중인 건을 "이제 내보내라"고 포장팀에 넘긴다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무슨 문제를 푸는가:
--   보관은 원단만 창고에 넣어둔 상태다(포장 전). 고객이 "이제 보내주세요" 하면
--   그걸 아는 건 담당 셀러인데, 지금은 셀러가 포장팀에 알릴 길이 화면에 없다.
--
--   관리자가 '출고완료'를 누르는 방법뿐이었는데, 그 버튼은 누르는 순간 재고를
--   차감하고 출고 로그를 찍고 주문을 종결한다. 물건은 아직 선반에 있는데 장부만
--   먼저 나가는 것이다. 보관을 '요청'과 '완료'로 나눈 것과 똑같은 구멍이다.
--
-- 그래서 출고도 두 단계로 나눈다:
--   셀러가 출고요청  →  보관이 풀리고 카드가 포장탭 당일 칸으로 올라온다
--   포장직원이 선반에서 꺼내 포장완료  →  관리자가 출고완료(재고·로그·종결)
--
-- 왜 출고예정일(ship_date)을 오늘로 덮지 않는가:
--   보관 건의 예정일은 몇 달 전일 수 있다. 덮으면 원래 값이 사라져 출고요청을
--   취소해도 되돌릴 수 없다. 날짜는 그대로 두고 화면에서만 당일 칸에 놓는다 —
--   취소하면 아무것도 복원할 필요 없이 제자리로 돌아간다.
--
-- 왜 boolean 이 아니라 시각인가:
--   "언제 요청했는데 아직 안 나갔다"를 세야 밀린 걸 찾을 수 있다.
--   누가 눌렀는지(ship_requested_by)도 남긴다 — 보관 건은 담당 셀러가 고객과
--   주고받은 맥락이 있어서, 포장팀이 되물을 상대가 명확해야 한다.

alter table orders add column if not exists ship_requested_at timestamptz;
alter table orders add column if not exists ship_requested_by text;

-- 포장탭이 매번 훑는 경로: "출고요청은 걸렸는데 아직 안 나간 것".
-- 부분 인덱스라 요청이 없는 대다수 주문은 아예 들어오지 않는다.
create index if not exists idx_orders_ship_requested
  on orders (user_id, ship_requested_at)
  where ship_requested_at is not null;
