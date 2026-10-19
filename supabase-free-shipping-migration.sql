-- ========================================
-- 무료배송권 시스템 1단계: DB 스키마
-- 작성일: 2026-05-21
-- 영향: 신규 테이블 추가, orders 컬럼 추가
-- 기존 데이터/기능 영향: 없음
-- 운영 중 실행 가능 (무중단)
-- ========================================

-- 1. 무료배송권 보유 테이블
CREATE TABLE IF NOT EXISTS free_shipping_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(customer, user_id)
);

-- 2. 무료배송권 이력 테이블
--    ⚠️ order_id 는 text 입니다. 운영 orders.id 가 text(예: '#L...') 이므로
--       uuid 로 선언하면 FK 타입 불일치로 마이그레이션이 실패합니다.
CREATE TABLE IF NOT EXISTS free_shipping_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer text NOT NULL,
  type text NOT NULL CHECK (type IN ('issue', 'use', 'restore', 'cancel')),
  count integer NOT NULL,
  order_id text REFERENCES orders(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

-- 3. orders 컬럼 추가 (기존 데이터 무영향)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS free_shipping_used boolean NOT NULL DEFAULT false;

-- 4. RLS 활성화
ALTER TABLE free_shipping_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE free_shipping_logs ENABLE ROW LEVEL SECURITY;

-- 5. RLS 정책 (기존 패턴과 동일 — user_id = auth.uid())
CREATE POLICY tenant_free_shipping_coupons ON free_shipping_coupons
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY tenant_free_shipping_logs ON free_shipping_logs
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- 6. Realtime publication 추가
ALTER PUBLICATION supabase_realtime ADD TABLE free_shipping_coupons;
ALTER PUBLICATION supabase_realtime ADD TABLE free_shipping_logs;

-- 7. 인덱스 (조회 성능)
CREATE INDEX IF NOT EXISTS idx_fs_coupons_customer
  ON free_shipping_coupons(customer, user_id);
CREATE INDEX IF NOT EXISTS idx_fs_logs_customer
  ON free_shipping_logs(customer, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fs_logs_order
  ON free_shipping_logs(order_id) WHERE order_id IS NOT NULL;

-- 8. 검증 쿼리 (실행 후 확인용)
-- SELECT count(*) FROM free_shipping_coupons;
-- SELECT count(*) FROM free_shipping_logs;
-- SELECT free_shipping_used FROM orders LIMIT 1;
