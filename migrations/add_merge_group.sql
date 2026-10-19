-- 합배송 기능 — orders 테이블에 merge_group_id 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- merge_group_id : 합배송 그룹 식별자 (UUID v4, NULL = 단독 배송)
-- 같은 merge_group_id 를 가진 주문들은 동일 박스로 묶음 처리됨.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS merge_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_orders_merge_group_id ON orders(merge_group_id);
