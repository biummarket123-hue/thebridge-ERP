-- 주문 메모/피드 — 채팅형 공유 메모판
-- 직원이 주문을 여기에 적으면 실시간으로 서로 공유되고, 말풍선을 클릭하면
-- 주문입력(AI 분석) 흐름으로 넘어가 등록된다. 등록되면 status='등록됨' + order_id 연결.
--
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.

-- 1. 테이블
CREATE TABLE IF NOT EXISTS order_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  author text NOT NULL DEFAULT '',            -- 작성 담당자 이름(activeManager)
  body text NOT NULL DEFAULT '',              -- 메모 본문(주문 원문)
  status text NOT NULL DEFAULT '미등록',       -- '미등록' | '등록됨'
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,  -- 등록된 주문(orders.id 는 uuid)
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,  -- 고객검색으로 붙인 고객(customers.id 는 uuid)
  created_at timestamptz DEFAULT now()
);

-- 2. RLS (기존 패턴과 동일 — 회사 단위 격리. 직원 구분은 클라이언트 author 필터)
ALTER TABLE order_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_order_notes ON order_notes;
CREATE POLICY tenant_order_notes ON order_notes
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 3. Realtime publication 추가
ALTER PUBLICATION supabase_realtime ADD TABLE order_notes;

-- 4. 인덱스
CREATE INDEX IF NOT EXISTS idx_order_notes_user ON order_notes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_notes_order ON order_notes(order_id);
