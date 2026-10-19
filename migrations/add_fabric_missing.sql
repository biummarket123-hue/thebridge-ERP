-- 원단 미도착 호출(fabric_missing) — 포장직원이 자리에서 셀러를 부르는 장치
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무슨 문제를 푸는가:
--   셀러는 주문을 ERP에 넣고, 원단은 손으로 들고 포장팀에 가져다 준다. 바쁘면 후자를
--   깜빡한다. 그러면 포장직원은 카드를 집었다가 원단이 없어서 자리를 뜨고, 셀러를
--   찾아 돌아다닌다.
--
--   진짜 손실은 셀러가 깜빡한 게 아니라 **포장직원이 걸어다니는 시간**이다. 병목인
--   사람이 멈춰 서는 것이라, 셀러가 5분 늦는 것보다 훨씬 비싸다.
--
--   그래서 이건 '알림'이 아니라 '호출'이다. 성공 기준은 하나 —
--     포장직원이 자리에서 버튼만 누르고 계속 일한다. 셀러가 알아서 온다.
--
-- ⚠️ 이 파일은 여러 번 실행해도 안전합니다(전부 if not exists / 조건부 update).
--    앞서 한 번 돌리셨어도 그대로 다시 실행하시면 됩니다.
--
-- 왜 '주문'이 아니라 '품목' 단위인가:
--   한 주문에 원단이 여러 개 들어가는데, 그중 하나만 안 오는 경우가 실제로 있다.
--   주문 단위로 부르면 이미 와 있는 원단까지 "안 왔다"고 부르는 셈이라 셀러가
--   무엇을 가져와야 하는지 모른다. 합배송이면 건마다 담당자가 달라 더 심해진다.
--   그래서 안 온 품목의 자리번호만 따로 담는다.
--
-- 컬럼이 다섯인 이유:
--   fabric_missing_items : 안 온 품목의 자리번호 배열(0부터). 예: [0,2]
--                          자리번호를 쓰는 건 호출이 몇 분~몇 시간짜리라 그 사이에
--                          품목이 편집될 일이 드물기 때문이다. 그래도 어긋날 수 있어
--                          앱에서 items 길이로 범위를 검사한 뒤 쓴다.
--   fabric_missing       : 안 온 품목이 하나라도 있나. orders 는 Realtime 구독 대상이라(ErpApp.jsx)
--                        이 값만 바뀌면 열려 있는 모든 ERP 화면에 1초 안에 퍼진다.
--                        별도 알림 테이블을 두지 않은 이유이기도 하다 — 주문 상태에서
--                        화면을 만들면 '원단 받음' 순간 알림이 저절로 사라진다.
--                        따로 두면 지우는 걸 깜빡한 유령 알림이 남는다.
--   fabric_missing_at  : 호출 시각. '몇 분째'를 세는 값. 당일에 끝나는 일이라
--                        보관·보류의 '며칠째'와 달리 분 단위로 본다.
--
-- 해제하면 셋을 모두 비운다. 같은 주문이 또 막히면 새 호출로 다시 시작한다.
--
-- '확인' 기록을 두지 않는 이유:
--   처음엔 셀러가 "지금 갑니다"를 누르면 포장직원 화면에 뜨게 하려 했다. 그런데
--   원단은 대부분 바로 온다 — 부르고 몇 분이면 실물이 눈앞에 나타난다. 실물이
--   도착하는 것보다 더 확실한 신호가 없는데 그걸 위해 셀러에게 버튼을 하나 더
--   누르게 하는 건 품이 아깝다. 확인은 각자 화면에서 알림을 접는 용도로만 두고
--   DB에는 남기지 않는다.
--   (앞선 버전을 실행해 fabric_ack_at·fabric_ack_by 가 생겼다면 그냥 두셔도 됩니다.
--    앱이 읽지 않으므로 무해합니다.)

alter table orders add column if not exists fabric_missing       boolean not null default false;
alter table orders add column if not exists fabric_missing_items jsonb not null default '[]'::jsonb;
alter table orders add column if not exists fabric_missing_at    timestamptz;

-- 품목 단위로 내리기 전(주문 단위)에 걸어둔 호출이 있으면 '전 품목이 안 왔다'로 옮긴다.
-- 안 옮기면 호출 중인데 안 온 품목이 하나도 없는 상태가 되어 배너에 빈 줄로 뜬다.
update orders
   set fabric_missing_items = (
         select coalesce(jsonb_agg(g.i - 1 order by g.i), '[]'::jsonb)
           from generate_series(1, coalesce(jsonb_array_length(items), 0)) g(i))
 where fabric_missing
   and fabric_missing_items = '[]'::jsonb;

-- 배너는 "호출 중인 것을 오래된 순으로" 훑는다 — 그 경로만 인덱스.
create index if not exists idx_orders_fabric_missing
  on orders (user_id, fabric_missing_at)
  where fabric_missing;
