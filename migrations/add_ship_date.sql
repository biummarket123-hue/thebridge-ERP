-- 출고예정일(ship_date) + 긴급 플래그 — 포장직원 전용 화면의 칸 배치 기준
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- 설계:
--   · ship_date 는 "날짜"로 저장한다. 긴급/당일/익일 같은 라벨로 저장하면
--     오늘 익일로 등록한 주문이 내일도 계속 '익일' 칸에 남아버린다.
--     칸은 매일 오늘 기준으로 계산한다:
--        긴급 = is_urgent
--        당일 = ship_date <= 오늘  (NULL 포함 — 아래 참고)
--        익일 = ship_date = 내일
--        예약 = ship_date > 내일
--   · 기본값은 주문 등록일의 다음 영업일 (마감시간 없음, 토·일·공휴일 이월).
--     영업일 계산은 앱에서 수행한다 — 공휴일이 음력(설날·추석) 때문에 SQL로 계산 불가.
--   · 기존 주문은 ship_date 를 NULL 로 둔다. 앱은 NULL 을 '당일'로 취급하므로
--     이미 밀린 주문들이 당일 칸에 모여 유실되지 않는다. (백필로 날짜를 넣으면
--     orders.date 가 "2026. 08. 11." 형태의 text 라 파싱 사고 위험이 큼)
--   · ship_date_pulled 는 포장직원이 익일→당일로 당긴 건 표시용 (⏫당김 배지).

alter table orders add column if not exists ship_date date;
alter table orders add column if not exists is_urgent boolean not null default false;
alter table orders add column if not exists ship_date_pulled boolean not null default false;

-- 포장 화면은 "미출고 주문을 출고예정일 순으로" 훑는다 — 그 경로만 인덱스.
create index if not exists idx_orders_ship_queue
  on orders (user_id, ship_date)
  where status <> '출고완료';

create index if not exists idx_orders_urgent
  on orders (user_id)
  where is_urgent and status <> '출고완료';
