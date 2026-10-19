-- ========================================
-- 무료배송권 시스템 롤백 SQL
-- 긴급 시에만 사용
-- 주의: 데이터 손실 발생
-- ========================================

-- 1. Realtime publication에서 제거
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS free_shipping_logs;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS free_shipping_coupons;

-- 2. 테이블 삭제 (데이터 손실 주의)
DROP TABLE IF EXISTS free_shipping_logs;
DROP TABLE IF EXISTS free_shipping_coupons;

-- 3. orders 컬럼은 안전 위해 남겨둠
-- 필요 시 수동 실행:
-- ALTER TABLE orders DROP COLUMN IF EXISTS free_shipping_used;
