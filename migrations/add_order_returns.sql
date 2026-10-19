-- 반품 관리 — 부분 반품 지원
-- 흐름: 반품신청 → 수거중 → 반품입고(재고 복구 + logs '반품입고' 기록) → 완료
-- 한 주문에 여러 번 부분 반품 가능. 주문 원본은 건드리지 않고 반품 이력만 쌓임.
--
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.

-- 1. 테이블
CREATE TABLE IF NOT EXISTS order_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,  -- 원 주문 (삭제돼도 반품 이력 유지)
  customer text NOT NULL DEFAULT '',           -- 표시용 고객명 (주문 삭제 대비)
  items jsonb NOT NULL DEFAULT '[]',           -- [{itemNo,fabric,color,qty,unit,amount}] 반품 품목·수량 (부분 반품)
  reason text NOT NULL DEFAULT '',             -- 반품 사유
  status text NOT NULL DEFAULT '반품신청'
    CHECK (status IN ('반품신청','수거중','반품입고','완료')),
  manager text NOT NULL DEFAULT '',            -- 등록 담당자
  restocked boolean NOT NULL DEFAULT false,    -- 재고 복구 완료 여부 (반품입고 시 true — 중복 복구 방지)
  exchange_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,  -- (구버전) 교환 출고 주문 — 현재는 미사용
  exchange_items jsonb NOT NULL DEFAULT '[]',  -- 교환으로 보낸 품목 — 별도 주문 없이 원 주문에 기록
  exchange_diff integer,                       -- 차액(교환액-반품액). 양수=추가 결제(원 주문 금액에 가산), 음수=환불
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- 2. RLS (기존 패턴과 동일 — 회사 단위 격리)
ALTER TABLE order_returns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_order_returns ON order_returns;
CREATE POLICY tenant_order_returns ON order_returns
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 3. 인덱스
CREATE INDEX IF NOT EXISTS idx_order_returns_user ON order_returns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_returns_order ON order_returns(order_id);
