-- 링크 주문 초안 — 적립금 사용액 (2026-10-07)
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 공개 링크(/o/{품번})에서 인증한 고객이 보유 적립금을 이번 주문에 얼마나 쓸지 적는다.
-- 서버가 잔액·주문 금액 안으로 깎아 저장하고, 셀러가 전환하면 직접입력 폼의 적립금 칸에 들어가
-- 등록 때 db.applyOrderCredit 가 실제로 차감한다(초안 단계에서는 적립금을 건드리지 않는다).
-- 칸이 없는 DB 에서는 draft API 가 42703 으로 실패한다.

alter table link_order_drafts add column if not exists credit_use integer not null default 0;

-- 롤 주문은 "몇 롤"이 아니라 "어느 롤"을 고른다(2026-10-07 사용자 결정). 고른 롤 목록 [{ id, rollCode, length }].
-- 초안이라 롤을 예약하지는 않는다 — 셀러가 전환·등록할 때 그 롤이 아직 있는지 포장대 스캔이 가른다.
alter table link_order_drafts add column if not exists rolls jsonb;
