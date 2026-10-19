-- 라벨 출력 담당 기기(label_station) — 회사 전체에서 딱 한 대만 라벨을 뽑는다
-- Supabase 대시보드 > SQL Editor 에서 한 번 실행하세요. ⚠️ 배포보다 먼저 실행해야 합니다.
--
-- 무슨 문제를 푸는가:
--   자동 출력 스위치를 기기 안(localStorage)에만 두면 ERP 는 어느 PC 가 켜져 있는지
--   모른다. 그래서 세 가지를 못 한다:
--     1) 엉뚱한 PC 에서 켜진 걸 알아채지 못한다 — A4 프린터로 라벨이 나가도 조용하다
--     2) 관리자가 원격으로 끌 수 없다. 그 PC 앞까지 걸어가야 한다
--     3) 지금 담당이 어느 기기인지 아무도 모른다
--
--   이 테이블은 담당 기기를 서버에 한 줄로 못 박는다. user_id 가 PRIMARY KEY 라
--   회사당 한 줄뿐이고, 곧 담당 기기가 언제나 한 대라는 뜻이다. 다른 PC 가 켜면
--   이 줄을 덮어쓰고, 덮인 PC 는 Realtime 으로 그 사실을 받아 스스로 멈춘다.
--
-- 왜 기기 이름을 사람이 적게 하는가:
--   브라우저는 "이 컴퓨터가 어느 컴퓨터인지"를 알려주지 않는다. 기기 ID 는 무작위
--   문자열이라 관리자가 봐야 아무 의미가 없다. '포장대 PC' 같은 이름이 붙어야
--   설정 화면에서 "지금 담당은 어디"를 읽고 해제 여부를 판단할 수 있다.
--
-- 왜 armed_at 이 여기 있는가:
--   담당을 넘겨받은 시각이 곧 "여기서부터 뽑는다"의 기준이다. 기기마다 따로 들고
--   있으면 담당을 넘길 때 기준이 어긋나 이미 뽑은 라벨이 다시 나오거나 빠진다.
--   실제로 뽑았는지는 orders.label_printed_at 이 최종 판정을 하지만(중복 인쇄 차단),
--   기준 시각이 한 곳에 있어야 "언제부터"를 사람이 읽고 납득할 수 있다.

CREATE TABLE IF NOT EXISTS label_station (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id   text NOT NULL,                    -- 브라우저가 처음 켤 때 만든 무작위 ID
  device_name text NOT NULL DEFAULT '',         -- 사람이 붙인 이름 ('포장대 PC')
  armed_at    timestamptz NOT NULL DEFAULT now(),  -- 이 시각 이후 등록분만 뽑는다
  armed_by    text NOT NULL DEFAULT '',         -- 켠 담당자 이름
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS — 기존 테이블과 같은 패턴(회사 단위 격리, 직원 구분은 클라이언트에서)
ALTER TABLE label_station ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_label_station ON label_station;
CREATE POLICY tenant_label_station ON label_station
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Realtime — 담당이 넘어가는 순간 이전 기기가 즉시 멈춰야 한다.
-- 이게 없으면 "관리자가 껐는데 그 PC 는 계속 뽑는" 상태가 새로고침 전까지 남는다.
-- 이미 추가돼 있으면 에러가 나므로 감싸서 무시한다(여러 번 실행해도 안전하게).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE label_station;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
