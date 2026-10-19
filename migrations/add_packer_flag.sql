-- managers 테이블에 is_packer 컬럼 추가
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- is_packer : 포장 담당자 여부
--   허용: 메모/담당자 메모(공유) 편집, 상태 '접수'·'포장완료' 변경만
--   차단: 주문 수정/삭제, 합배송 묶기/해제/운임비, 입금·환불, 배송권, 보관/출고완료, 대량 송장
--
-- 관리자(is_admin=true)는 모든 권한을 가지므로 is_packer 보다 우선합니다.

ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS is_packer boolean NOT NULL DEFAULT false;
