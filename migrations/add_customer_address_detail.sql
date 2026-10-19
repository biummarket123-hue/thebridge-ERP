-- 고객 상세주소 — 주문의 상세주소(동/호 등)를 고객 프로필에도 분리 저장 (자동완성 완성도 ↑).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address_detail TEXT;
