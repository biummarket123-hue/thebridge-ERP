-- 메모 리액션 — order_notes 테이블에 reactions 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- reactions : 이모지별 리액션 누른 담당자 이름 목록 (jsonb)
--   예) {"✅": ["민수", "지영"], "👍": ["철수"]}
-- 같은 사람이 같은 이모지를 다시 누르면 토글(제거)됩니다.

ALTER TABLE order_notes
  ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}'::jsonb;
