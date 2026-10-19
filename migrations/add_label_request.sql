-- 라벨 출력요청(label_requested_at) — 뽑을 것을 사람이 고른다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무엇이 바뀌는가:
--   지금까지는 주문이 등록되기만 하면 라벨 PC 가 알아서 뽑았다. 앞으로는 사람이
--   주문현황에서 고른 것만 뽑는다. 등록은 등록이고, 뽑을지는 따로 정하는 일이다.
--
-- 왜 '라벨 PC 가 대신 뽑는' 구조는 그대로 두는가:
--   직원들은 각자 PC·모바일에서 주문을 넣는데 PS100 은 한 대에만 물려 있다.
--   인쇄는 브라우저가 하는 일이라, 누른 사람의 기기에서 뽑으려 하면 모바일에서는
--   아예 못 뽑는다. 그래서 고르는 곳과 뽑는 곳을 계속 떼어 둔다 —
--   모바일에서 고르면 요청만 걸리고, 실제 인쇄는 라벨 PC 가 한다.
--
-- 왜 boolean 이 아니라 시각인가:
--   요청한 순서대로 뽑아야 포장대에 쌓이는 순서가 사람이 고른 순서와 같아진다.
--   "왜 아직 안 나왔나" 를 볼 때도 언제 요청했는지가 있어야 답이 나온다.
--   누가 눌렀는지(label_requested_by)도 남긴다 — 잘못 뽑힌 라벨을 되물을 상대다.
--
-- label_printed_at 과의 관계:
--   요청 = "뽑아줘", 출력 = "뽑았다". 요청을 걸 때 label_printed_at 을 비우므로
--   같은 주문을 다시 눌러 재출력할 수 있다. 뽑고 나면 다시 채워져 두 번 안 나온다.
--   (출력권 선점 자체는 add_label_printed.sql 이 이미 처리한다)

alter table orders add column if not exists label_requested_at timestamptz;
alter table orders add column if not exists label_requested_by text;

-- 라벨 PC 가 매번 훑는 경로는 하나뿐이다: "요청은 걸렸는데 아직 안 뽑은 것".
-- 부분 인덱스라 요청이 없는 대다수 주문은 아예 들어오지 않는다.
create index if not exists idx_orders_label_requested
  on orders (user_id, label_requested_at)
  where label_requested_at is not null and label_printed_at is null;
