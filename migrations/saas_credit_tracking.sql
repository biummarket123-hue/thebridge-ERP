-- 구독형 SaaS — 외상 거래처 · 송장번호 (2026-10-23 사용자 결정: 전체 점검 뒤 1순위 보완)
-- saas_plans_v2.sql 다음에 실행. 두 번 실행해도 안전.
--
--   customers.allow_credit  외상 거래처 — 입금 전에도 출고할 수 있다(미수금은 정산의 미입금 목록에 남는다). 회사 설정이 아니라 거래처마다.
--   orders.tracking_no      송장번호 — 출고완료 때 넣는다. 출고 안내 문자 {송장번호}, 주문 상세의 배송 조회 링크가 쓴다.

alter table customers add column if not exists allow_credit boolean not null default false;
alter table orders add column if not exists tracking_no text not null default '';
