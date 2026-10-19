-- 포장 시각(packed_at) + 포장 시점 품목 지문(packed_sig)
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 왜 필요한가:
--   · packed_at — 완료 탭을 '방금 포장한 것부터' 보여주기 위한 정렬 기준.
--     주문 등록 시각(created_at)으로는 되돌릴 대상을 찾을 수 없다.
--   · packed_sig — 포장한 뒤에 품목·수량이 바뀌었는지 판단하는 지문.
--     "원단|색|수량|단위" 를 이어붙인 문자열로, 포장 순간의 내용물을 박제한다.
--     지금 품목과 다르면 박스 안과 카드가 어긋난 것이므로 재포장 경고를 띄운다.
--
--     updated_at 같은 범용 타임스탬프로는 안 된다 — 입금확인·출고예정일 변경처럼
--     박스와 무관한 수정에도 값이 바뀌어 거짓 경고가 뜬다. 품목만 봐야 한다.
--
-- 기존 포장완료 주문은 두 값이 모두 NULL이다. 앱은 NULL을 이렇게 다룬다:
--   · 정렬 — 맨 뒤(등록 역순 유지). 옛 건이라 되돌릴 일이 적다.
--   · 지문 없음 — 수정 감지를 하지 않는다. 언제 포장했는지 모르는 건에
--     "포장 후 수정됐다"고 단정할 수 없기 때문.

alter table orders add column if not exists packed_at timestamptz;
alter table orders add column if not exists packed_sig text;
