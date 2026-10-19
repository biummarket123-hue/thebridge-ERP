-- 합배송으로 묶이면서 내려놓은 택배비 — 다시 따로 나가게 되면 되돌릴 금액
-- Supabase 대시보드 > SQL Editor 에서 실행하세요. 여러 번 실행해도 안전합니다.
--
-- 무슨 문제를 푸는가:
--   묶음 안에서 택배비는 한 건에만 남는다. 두 건에 있으면 나중 주문의 택배비가 자동으로 0 이 된다.
--   그 주문이 묶음에서 빠지거나 분리되거나, 택배비를 든 주문만 먼저 출고되면 원래 금액을 되돌려야 하는데
--   0 이 되기 전 금액을 적어 둘 곳이 없었다. 이 칸이 그 자리다.
--   원래 택배비가 없던 주문은 여기가 비어 있어 되돌릴 것도 없다(없는 대로 나간다).
--
-- 이 SQL 을 안 돌려도 화면은 그대로 돈다 — 저장할 때 이 칸만 빼고 쓴다. 다만 되돌리기가 안 된다.
alter table orders add column if not exists shipping_fee_held numeric;

select count(*) filter (where shipping_fee_held is not null) as held_orders from orders;   -- 0
