-- 공지판(notices) — 입금은 들어왔는데 ERP에 주문이 없는 건을 주인에게 보낸다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무슨 문제를 푸는가:
--   관리자가 은행 입금 알림을 받는데, 그 입금에 맞는 주문이 ERP에 없다. 누구 건인지
--   모르니 직원용 네이버 밴드에 올려 "이거 누구 거예요?"를 묻고 있었다.
--
--   밴드로는 안 되는 것 셋:
--     1) 글이 흘러내린다. 아직 안 끝난 건이 스크롤 위로 사라져 영영 안 보인다.
--     2) 주인을 못 찾는다. 사람이 일일이 기억을 뒤져야 한다.
--     3) 처리됐는지 알 수 없다. 댓글로 흩어진다.
--
--   ERP 안이면 셋 다 해결된다. 특히 2번 — 입금자명으로 과거 주문의 담당자를 조회하면
--   "이 고객은 늘 ○○님 담당"이 나온다. 밴드로는 절대 못 하고 ERP라서 되는 일이다.
--
-- 왜 order_notes 를 안 쓰고 새 테이블인가:
--   order_notes(주문 메모)도 '적어두면 → 주문 등록하면 → 사라진다'는 같은 골격이라
--   확장을 제안했으나, 주문 원문과 입금 건이 한 줄에 섞이는 걸 피하기로 결정했다.
--   대신 성격을 확실히 가른다 — 공지판은 '처리할 일'만, 주문 원문은 계속 주문 메모.
--
-- 상태는 세 단계다. 각각 다른 사람이 움직인다:
--   올림(관리자)  → 주인 찾음(claimed_by)  → 처리 완료(resolved_at)
--   claimed_by 가 따로 있는 이유: "제 건입니다"를 누른 순간과 실제로 주문을 등록한
--   순간 사이에 시간이 걸린다. 그 사이 다른 사람이 중복으로 달라붙지 않게 표시해 둔다.

CREATE TABLE IF NOT EXISTS notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'deposit',   -- 지금은 입금-미등록 하나. 나중 종류 확장 여지
  amount bigint NOT NULL DEFAULT 0,       -- 입금액
  depositor text NOT NULL DEFAULT '',     -- 입금자명 (담당자 추측의 열쇠)
  deposited_at timestamptz,               -- 알림에 찍힌 입금 시각
  raw_text text NOT NULL DEFAULT '',      -- 붙여넣은 원문. 파싱이 틀렸을 때 이것만이 근거다
  memo text NOT NULL DEFAULT '',          -- 관리자 덧말
  claimed_by text NOT NULL DEFAULT '',    -- "제 건입니다" 누른 사람
  claimed_at timestamptz,
  resolved_at timestamptz,                -- 비어 있으면 미해결. 목록은 이걸로 가른다
  resolved_by text NOT NULL DEFAULT '',
  resolved_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_by text NOT NULL DEFAULT '',    -- 올린 관리자
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS — 기존 테이블과 같은 패턴(회사 단위 격리, 직원 구분은 클라이언트에서)
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_notices ON notices;
CREATE POLICY tenant_notices ON notices
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Realtime — 관리자가 올리는 순간 전원 화면에 떠야 한다. 안 그러면 밴드와 다를 게 없다.
-- 이미 추가돼 있으면 에러가 나므로 감싸서 무시한다(여러 번 실행해도 안전하게).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notices;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 목록은 "미해결을 오래된 순으로" 훑는다 — 그 경로만 인덱스.
CREATE INDEX IF NOT EXISTS idx_notices_open
  ON notices (user_id, created_at)
  WHERE resolved_at IS NULL;
