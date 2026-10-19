-- 영수증 발급 완료 여부 — 대시보드에서 영수증 칩 클릭으로 토글(발급함 표시).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_issued BOOLEAN NOT NULL DEFAULT false;
