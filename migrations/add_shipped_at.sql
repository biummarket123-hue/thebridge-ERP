-- 출고일 — orders 테이블에 shipped_at 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- shipped_at : 출고완료 처리 시점의 타임스탬프 (timestamptz, UTC)
-- 출고완료 → 다른 상태로 되돌릴 때 NULL 로 초기화.
-- 합배송 그룹 동시 출고 시 그룹 전체에 동일한 값 부여.
-- 기존 데이터(과거 출고완료 주문)는 NULL 유지.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipped_at timestamptz;
