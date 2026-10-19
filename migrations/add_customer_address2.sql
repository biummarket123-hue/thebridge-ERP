-- 고객 배송지 2 — 배송지를 두 개 쓰는 소수 고객용 (예: 집 + 매장)
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- 정책:
--   · address(기본 배송지)는 지금처럼 주문 등록 시 자동 업데이트됨
--   · address2(배송지 2)는 고객관리 > 고객수정에서만 수동 입력/수정 — 자동으로 절대 안 건드림
--   · 주문 주소가 배송지2와 일치하면 기본 배송지 자동 업데이트를 건너뜀 (덮어쓰기 사고 방지)
--   · address2_label: 직원이 알아보기 쉬운 표시명 (예: "매장", "회사") — 선택 입력

alter table customers add column if not exists address2 text;
alter table customers add column if not exists address2_detail text;
alter table customers add column if not exists address2_label text;
