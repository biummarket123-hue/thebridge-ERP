-- 주문 메모에 "고객검색으로 붙인 고객" 참조를 저장한다.
-- 메모의 '주문 등록' 시 이 고객을 AI 분석 없이 그대로 선택하기 위함.
-- customers.id 는 uuid 이므로 customer_id 도 uuid.
--
-- 이미 order_notes 를 만든 환경에서는 이 델타만 실행하세요.
-- (add_order_notes.sql 을 새로 실행하는 신규 환경이면 그쪽에 이미 포함됨)

ALTER TABLE order_notes
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
