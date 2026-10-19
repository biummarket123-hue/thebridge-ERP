-- 영수증 종류 — 'cash'(현금영수증) / 'business'(지출증빙) / 'tax_invoice'(계산서) / NULL(발행 안 함)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_type TEXT;
