-- 기타비용 — 배송비 외 추가 비용(부자재/수선/할증 등). 합산 총액에 포함.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS other_cost INTEGER NOT NULL DEFAULT 0;
