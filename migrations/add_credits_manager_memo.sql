-- 적립금 내역에 담당자·메모를 남긴다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무슨 문제를 푸는가:
--   적립금 카드는 "적립/사용 · 고객 · 사유 · 금액"만 보여줬다. 사유가 "직접 적립" 한 줄이면
--   나중에 누가 왜 넣었는지 되짚을 길이 없다. 카드를 누르면 언제·누가·무슨 메모를 남겼는지
--   펼쳐 보이도록 두 칸을 더한다.
--
--   manager: 등록·회수·주문차감 등 그 기록을 만든 담당자 (activeManager). 자동 기록에도 남긴다.
--   memo:    담당자가 직접 적는 자유 메모. 사유는 한 줄 요약, 메모는 뒷이야기.

alter table credits add column if not exists manager text;
alter table credits add column if not exists memo text;
