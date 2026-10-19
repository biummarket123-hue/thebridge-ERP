-- 교환 방식 변경: 별도 교환 주문 생성 대신 원 주문의 반품 레코드에 교환 내용 기록
-- add_order_returns.sql 을 이미 실행한 경우 이 파일을 실행하세요.
-- (아직 실행 전이면 add_order_returns.sql 최신본에 이미 포함되어 있어 이 파일은 불필요)

ALTER TABLE order_returns
  ADD COLUMN IF NOT EXISTS exchange_items jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS exchange_diff integer;
