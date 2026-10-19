-- 감사 라벨(thank-you label) 출력 요청 — 주문현황 "💌 감사 라벨"
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무엇을 하는 기능인가:
--   선물 상자에 붙여 보내는 감사 라벨(public/thankyou-label.png, 80×60mm 감열지 한 장).
--   원단 인계 라벨과 같은 PS100 에서 나온다. 그래서 같은 길을 탄다 — 누른 기기에서
--   인쇄창을 띄우지 않고 요청만 걸어 두면 라벨 출력 담당 PC 가 대신 뽑는다
--   (migrations/add_label_printed.sql · add_label_request.sql 과 같은 모양).
--
-- 왜 주문이 아니라 "장수"인가 (2026-10-07 사용자 결정):
--   라벨 내용은 매번 같다. 주문을 고르게 하면 고르는 손만 들고 붙일 상자는 어차피
--   포장대에서 정한다. 그래서 요청 한 줄 = "N 장".
--
-- 왜 요청마다 한 줄인가:
--   장수만 어딘가에 더해 두면 두 대가 켜졌을 때 둘 다 "N 장 남았네" 하고 둘 다 뽑는다.
--   줄마다 printed_at 을 두고 UPDATE 조건에 printed_at is null 을 넣으면 DB 가 한 대만
--   통과시킨다 — 감열지는 되돌릴 수 없으니 그 창을 아예 없앤다.

create table if not exists thanks_label_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  count         integer not null check (count > 0 and count <= 200),
  requested_by  text,
  requested_at  timestamptz not null default now(),
  printed_at    timestamptz
);

alter table thanks_label_requests enable row level security;
drop policy if exists tenant_thanks_label_requests on thanks_label_requests;
create policy tenant_thanks_label_requests on thanks_label_requests for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 출력 PC 가 훑는 경로: "아직 안 뽑은 것을 요청순으로". 부분 인덱스라 뽑은 줄은 안 들어온다.
create index if not exists idx_thanks_label_unprinted
  on thanks_label_requests (user_id, requested_at)
  where printed_at is null;

-- 라벨 PC 가 요청을 실시간으로 받는다(원단 라벨·롤 라벨과 같다).
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE thanks_label_requests; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
