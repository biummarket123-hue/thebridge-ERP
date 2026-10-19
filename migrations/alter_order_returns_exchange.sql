-- 반품 → 교환 기능: 교환 출고 주문 연결 컬럼 추가
-- add_order_returns.sql 을 이미 실행한 경우에만 이 파일을 실행하세요.
-- (아직 실행 전이면 add_order_returns.sql 최신본에 이미 포함되어 있어 이 파일은 불필요)

ALTER TABLE order_returns
  ADD COLUMN IF NOT EXISTS exchange_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
