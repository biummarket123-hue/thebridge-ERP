-- 보관 처리 시각(held_at) — '보관해 달라는 지시'와 '실제로 보관함'을 가른다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 왜 필요한가:
--   is_holding 하나가 두 가지 뜻을 겸하고 있었다.
--     · 셀러가 누를 때  = "이 원단 보관해 주세요"  (작업 지시)
--     · 시스템이 읽을 때 = "보관돼 있다"            (완료 상태)
--   그래서 셀러가 누르는 순간 포장 화면에서 사라졌다. 포장직원은 지시를 받은 적도
--   없는데 이미 보관된 걸로 처리되고, 원단은 작업대에 그대로 남았다.
--
--   포장완료와 같은 구조로 가른다:
--     is_holding=true, held_at=null  → 보관 요청 (포장직원 할 일. 출고 큐에 남는다)
--     is_holding=true, held_at=시각  → 보관 중   (📦 보관 탭)
--     is_holding=false               → 보관 아님
--
--   해제하면 둘 다 지운다 — 요청도 완료도 없던 일이 된다.

alter table orders add column if not exists held_at timestamptz;

-- 이미 보관 중인 주문은 실물이 벌써 보관 장소에 들어가 있다.
-- 백필하지 않으면 배포 순간 전부 '보관 요청'으로 되살아나, 이미 끝난 일이
-- 포장직원 큐에 수십 건 쌓인다.
--
-- ⚠️ 조건은 앱의 isHold() 와 정확히 같아야 한다 — is_holding 만 보면 안 된다.
--    보관을 is_holding 토글로 분리하기 전(2026-08-07, ba44506) 주문들은
--    is_holding=false 인 채 status="보관" 으로만 표시돼 있다. 실제로 이 표기만
--    가진 건이 50건 중 34건이었고, 처음엔 이들이 통째로 '보관 요청'으로 되살아났다.
update orders
   set held_at = coalesce(held_at, now())
 where (is_holding = true or status = '보관')
   and held_at is null;

-- 보관 탭은 "보관 중인 것을 처리 순서대로" 훑는다 — 그 경로만 인덱스.
create index if not exists idx_orders_held
  on orders (user_id, held_at)
  where is_holding;
