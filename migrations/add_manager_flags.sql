-- managers 테이블에 is_admin, is_public 컬럼 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- is_admin  : 관리자 여부 (담당자 추가/삭제/수정 권한 + 락 무시)
-- is_public : 공용 담당자 여부 (방문고객/마켓24 등 — 누구나 처리 가능)

ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

-- 기존 데이터 권한 reconcile (이미 등록된 옥정점/방문고객/마켓24)
UPDATE managers SET is_admin  = true WHERE name = '옥정점';
UPDATE managers SET is_public = true WHERE name IN ('방문고객','마켓24');

-- 위 3명이 없는 새 user는 앱 첫 로드 시 ErpApp.jsx 의 ensureDefaultManagers() 가 자동 시드.
