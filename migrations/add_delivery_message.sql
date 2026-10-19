-- 배송 메시지 — orders 테이블에 delivery_message 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- delivery_message : 배송 시 전달할 메모 (예: "집 앞에 두고 문자해주세요")
-- 주문 메시지 주소 옆/아래 () 안에 적힌 내용을 분리 저장.
-- CJ대한통운 송장 엑셀 출력 시 "배송메세지1" 컬럼에 채워짐.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_message text;
