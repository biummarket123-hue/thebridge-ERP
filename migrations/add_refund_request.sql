-- 환불 신청 정보 — 직원이 환불 신청 시 방식/범위/금액/사유를 담아 대표 승인까지 전달
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요.
--
-- refund_request (jsonb) 구조:
--   {
--     "method": "cash" | "credit",     -- 현금환불 / 적립금환불
--     "kind":   "full" | "partial",    -- 전액 / 부분
--     "amount": 10000,                  -- 환불 요청 금액
--     "reason": "단순변심",             -- 사유 (선택)
--     "requestedBy": "옥정점",          -- 신청 담당자
--     "requestedAt": "2026-07-01T..."   -- 신청 시각(ISO)
--   }
-- 대표가 승인(환불 처리) 또는 반려하면 이 값은 null로 비워짐.

alter table orders add column if not exists refund_request jsonb;
