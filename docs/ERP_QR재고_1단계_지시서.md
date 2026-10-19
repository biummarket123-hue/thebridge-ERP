# THE BRIDGE ERP (Company) — QR 롤 재고 시스템 1단계 작업 지시서

작성일: 2026-09-29
대상 저장소: `C:\Users\A\thebridge-ERP-company` (Vite/React + Supabase, JS/JSX)
작업자: Claude Code
검토자: Cowork 세션(읽기 전용)

---

## 0. 이 작업이 푸는 문제

로하이마켓 원단은 매번 다른 원단이 한 번 입고되고 소진된다. 현재 `inventory` 테이블은 "원단 종류당 수량 하나"(fabric/color/stock) 구조라 품목을 만들고 지우는 일 자체가 업무가 되어 실사용되지 않는다. 입고 원단의 10~20%는 검단에서 오염·불량으로 폐기되어 명세서 수량과 실물이 다르다. 판매는 롤 통째와 몇 마 단위 재단이 둘 다 주력이다.

1단계는 **재고 단위를 "원단 종류"에서 "롤(필) 하나"로 바꾸고**, 검단 완료 시 실측 수량으로 QR 라벨을 발급해 롤에 붙이는 것까지다. 이 단계만으로 재고 데이터화와 창고 위치 확인이 된다.

### 1단계 범위에 포함
- 새 테이블 `products`, `stock_rolls`, `stock_movements` + 트랜잭션 RPC
- 입고·검단 화면(롤 생성 → 실측 입력 → 라벨 출력 요청)
- 롤 라벨 인쇄(기존 PS100 라벨 PC 출력 루프에 편입)
- 롤 단위 재고 화면(품번별 그룹, 가용 판정은 "가장 긴 롤" 기준)
- Realtime 구독 추가
- 죽은 코드 `BarcodeTab.jsx` 삭제

### 1단계 범위에서 제외 (건드리지 말 것)
- `orders.items` 구조, 주문 등록 화면(`OrderInput.jsx`)의 품번 매칭 로직
- 출고완료 시 `decrement_stock` 호출 루프 (`ErpApp.jsx` 출고 함수) — 2단계에서 교체
- 포장 화면(`PackingTab.jsx`), `packed_sig`
- 기존 `inventory` 테이블 — 삭제하지 않고 그대로 둔다. 기존 재고 수량은 신뢰할 수 없어 롤로 변환하지 않는다. 품번·원단명만 `products`로 복사한다.
- 인계 라벨(`labelPrint.js`) 내용 변경 — 2단계에서 QR 추가

---

## 1. 저장소에서 따라야 할 기존 패턴

작업 전에 아래 파일을 읽고 같은 방식으로 작성한다.

| 목적 | 참고 파일 | 따라야 할 점 |
|---|---|---|
| 마이그레이션 형식 | `migrations/add_label_station.sql` | 파일 상단에 "무슨 문제를 푸는가 / 왜 이렇게 설계했는가" 주석, `if not exists`로 재실행 안전, RLS는 `tenant_<table>` 정책(`user_id = auth.uid()`), Realtime publication 추가는 `DO $$ ... EXCEPTION WHEN duplicate_object` 블록 |
| DB 접근 함수 | `src/lib/db.js` | `getUserId()`로 user_id 확보 후 `.eq("user_id", ...)`, snake_case↔camelCase 변환 함수를 테이블마다 둠, 1000행 초과 가능 테이블은 while-loop range 페이지네이션 |
| Realtime 구독 | `src/lib/realtime.js` | `subscribeTable(tableName, userId, onChange)` 헬퍼 위에 `useRealtimeXxx` 훅 하나씩 |
| 라벨 인쇄 | `src/lib/labelPrint.js` | 숨긴 iframe에 별도 문서 생성, `@page` 크기는 드라이버 종이 칸과 동일(80×60mm), `PAGE_W/PAGE_H/ROTATE` 상수 구조 그대로 |
| 라벨 출력권 선점 | `src/lib/db.js` `requestLabelPrint` / `claimLabelPrint`, `src/ErpApp.jsx` 1230행 근처 출력 루프 | 요청 시각(`label_requested_at`)과 출력 시각(`label_printed_at`) 분리, `.is("label_printed_at", null)`을 UPDATE 조건에 넣어 한 대만 통과 |
| 이미지 업로드 | `src/lib/db.js` `compressImage`/`uploadOrderImage`, `supabase-storage-order-images-policy.sql` | webp 800px 압축, 버킷 정책은 authenticated로 제한 |
| 탭 UI 스타일 | `src/components/InoutForm.jsx`, `src/components/UI.jsx`, `src/constants.js` | `useTheme()`의 `G` 색상, `baseInp`, `Card`/`SecTitle`/`PrimaryBtn` 재사용 |

---

## 2. DB 마이그레이션

파일: `migrations/add_stock_rolls.sql`
실행 위치: Supabase 대시보드 > SQL Editor (Company DB `ggvnumjfallaarceciin`). **배포보다 먼저 실행.**

### 2-1. 테이블

```sql
-- 품번 시퀀스: 품번은 LH-YYMM-#### 형식. 유일성은 시퀀스가 보장하고 YYMM은 사람이 읽는 힌트일 뿐이다.
create sequence if not exists product_code_seq;

create or replace function next_product_code() returns text language sql as $$
  select 'LH-' || to_char(now() at time zone 'Asia/Seoul', 'YYMM') || '-' || lpad(nextval('product_code_seq')::text, 4, '0');
$$;

-- 원단 종류(품번 마스터). 롤이 아니라 "이 원단이 무엇인가"만 담는다. 수량은 여기 없다.
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code        text not null,                 -- 라벨·밴드 게시글에 쓰는 품번
  name        text not null,                 -- 원단명
  color       text not null default '',
  photo_url   text,
  unit        text not null default '마',
  unit_price  numeric(12,2),                 -- 판매 단가(마당). 없으면 null
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, code)
);

-- 롤(필) 하나 = 한 행 = 라벨 한 장. 재고의 실제 단위.
create table if not exists stock_rolls (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  product_id         uuid not null references products(id) on delete restrict,
  roll_code          text not null,          -- QR에 들어가는 값. {products.code}-R{두 자리}
  length_received    numeric(10,2) not null, -- 거래처 명세서 수량
  length_available   numeric(10,2),          -- 검단 후 실측. 검단 전엔 null
  length_remaining   numeric(10,2),          -- 현재 잔량. stock_movements 합으로 갱신되는 캐시
  status             text not null default 'received'
                       check (status in ('received','available','reserved','sold','scrapped')),
  location           text not null default '',  -- 창고 위치. 예: A-03
  supplier           text not null default '',
  inspected_at       timestamptz,
  inspected_by       text,
  label_requested_at timestamptz,            -- 라벨 뽑아달라는 요청 시각 (orders와 같은 방식)
  label_printed_at   timestamptz,            -- 실제로 뽑힌 시각. 출력권 선점 기준
  created_at         timestamptz not null default now(),
  unique (user_id, roll_code)
);

-- 잔량 변동 원장. 잔량이 이상하면 여기서 어디서 틀어졌는지 본다. 감시 에이전트 검사 대상.
create table if not exists stock_movements (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  roll_id     uuid not null references stock_rolls(id) on delete cascade,
  type        text not null check (type in ('inspect','cut','sell_whole','adjust','scrap','reserve','release')),
  qty         numeric(10,2) not null,        -- inspect는 실측 절대값, 그 외는 부호 있는 변화량(차감은 음수)
  order_id    text,                          -- orders.id 는 text('#L...')다. uuid 아님
  note        text,
  created_by  text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_products_user_code      on products(user_id, code);
create index if not exists idx_rolls_user_product      on stock_rolls(user_id, product_id, status);
create index if not exists idx_rolls_label_requested   on stock_rolls(user_id, label_requested_at)
  where label_requested_at is not null and label_printed_at is null;
create index if not exists idx_movements_roll          on stock_movements(roll_id, created_at);
```

### 2-2. RLS

세 테이블 모두 기존 패턴 그대로:

```sql
alter table products        enable row level security;
alter table stock_rolls     enable row level security;
alter table stock_movements enable row level security;

drop policy if exists tenant_products on products;
create policy tenant_products on products for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- stock_rolls, stock_movements 동일하게
```

### 2-3. 트랜잭션 RPC — 잔량 변동은 반드시 이 함수로만

프론트에서 `stock_movements` insert와 `stock_rolls.length_remaining` update를 따로 보내면 하나만 성공하는 순간 재고가 틀어진다. 잔량을 바꾸는 모든 경로는 이 RPC 하나를 부른다.

```sql
create or replace function roll_apply_movement(
  p_roll_id  uuid,
  p_type     text,
  p_qty      numeric,
  p_order_id text default null,
  p_note     text default null,
  p_by       text default null
) returns stock_rolls
language plpgsql security invoker as $$
declare
  r stock_rolls;
begin
  select * into r from stock_rolls
   where id = p_roll_id and user_id = auth.uid()
   for update;
  if not found then
    raise exception 'roll not found: %', p_roll_id;
  end if;

  insert into stock_movements (user_id, roll_id, type, qty, order_id, note, created_by)
  values (auth.uid(), p_roll_id, p_type, p_qty, p_order_id, p_note, p_by);

  if p_type = 'inspect' then
    -- 검단: 실측값을 그대로 가용·잔량으로 놓고 판매 가능 상태로
    update stock_rolls
       set length_available = p_qty,
           length_remaining = p_qty,
           status = 'available',
           inspected_at = now(),
           inspected_by = p_by
     where id = p_roll_id
     returning * into r;
  else
    update stock_rolls
       set length_remaining = coalesce(length_remaining, 0) + p_qty,
           status = case
             when coalesce(length_remaining, 0) + p_qty <= 0 and p_type = 'scrap' then 'scrapped'
             when coalesce(length_remaining, 0) + p_qty <= 0 then 'sold'
             else status
           end
     where id = p_roll_id
     returning * into r;
    if r.length_remaining < 0 then
      raise exception 'remaining below zero: roll % would be %', r.roll_code, r.length_remaining;
    end if;
  end if;

  return r;
end $$;
```

`security invoker`인 이유: 호출자의 RLS가 그대로 적용되어 다른 user_id의 롤을 건드릴 수 없다.

### 2-4. Realtime

```sql
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE products;        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE stock_rolls;     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

`stock_movements`는 구독하지 않는다(원장은 화면에 실시간으로 뿌릴 필요 없음).

### 2-5. 기존 inventory에서 품번만 이식

```sql
-- item_no가 있는 것만. 수량(stock)은 신뢰할 수 없으므로 롤로 만들지 않는다.
insert into products (user_id, code, name, color, unit_price)
select user_id, upper(trim(item_no)), fabric, coalesce(color,''), nullif(unit_price,0)
  from inventory
 where coalesce(trim(item_no),'') <> ''
on conflict (user_id, code) do nothing;
```

### 2-6. 상품 사진 버킷

`supabase-storage-order-images-policy.sql`을 그대로 복제해 `product-images` 버킷을 만들고 정책도 동일하게(authenticated 읽기/쓰기). 경로 규칙: `{product_id}/{timestamp}.webp`.

---

## 3. `src/lib/db.js` 추가 함수

기존 스타일(getUserId, snake↔camel 변환)에 맞춘다. 함수 목록과 계약:

```js
// ── 변환 ──
const productFromRow = (r) => ({ id, code, name, color, photoUrl, unit, unitPrice, note, createdAt });
const rollFromRow = (r) => ({ id, productId, rollCode, lengthReceived, lengthAvailable, lengthRemaining,
                              status, location, supplier, inspectedAt, inspectedBy,
                              labelRequestedAt, labelPrintedAt, createdAt });

// ── products ──
export async function fetchProducts()                     // 전체. 1000행 페이지네이션 적용
export async function findProductByCode(code)             // 대소문자 무시
export async function insertProduct({ name, color, unitPrice, note, photoFile })
  // code는 클라이언트가 만들지 않는다. supabase.rpc("next_product_code") 결과를 쓴다.
  // photoFile이 있으면 compressImage → product-images 버킷 업로드 → photo_url 저장
export async function updateProduct(id, patch)

// ── stock_rolls ──
export async function fetchRolls({ status } = {})         // 기본: scrapped/sold 제외. 1000행 페이지네이션
export async function insertRolls(productId, { count, lengthReceived, supplier, location })
  // count개의 롤을 status='received'로 생성. roll_code = `${product.code}-R${nn}`
  // nn = 해당 product의 기존 롤 수 + 1부터. unique 충돌 시 nn+1로 1회 재시도.
  // 반환: 생성된 롤 배열
export async function inspectRoll(rollId, measuredLength, by)
  // supabase.rpc("roll_apply_movement", { p_roll_id, p_type:'inspect', p_qty: measuredLength, p_by: by })
  // 성공 후 requestRollLabelPrint([rollId], by) 까지 이어서 호출 (검단 완료 = 라벨 출력 요청)
export async function adjustRoll(rollId, delta, note, by)   // type 'adjust', qty = delta(±)
export async function scrapRoll(rollId, reason, by)         // type 'scrap', qty = -length_remaining
export async function updateRollLocation(rollId, location)
export async function fetchRollMovements(rollId)

// ── 롤 라벨 출력권 (orders의 requestLabelPrint/claimLabelPrint와 동일 구조) ──
export async function requestRollLabelPrint(rollIds, requestedBy)
  // label_requested_at = now(), label_printed_at = null  (재출력 허용)
export async function claimRollLabelPrint(rollId)
  // update ... set label_printed_at = now() where id = rollId and label_printed_at is null → 1행 갱신되면 true
export async function releaseRollLabelPrint(rollId)
```

---

## 4. Realtime 훅

`src/lib/realtime.js`에 추가:

```js
export function useRealtimeProducts(userId, { onAny })   // subscribeTable("products", ...)
export function useRealtimeStockRolls(userId, { onAny }) // subscribeTable("stock_rolls", ...)
```

`ErpApp.jsx`에서 두 훅을 구독하고, 변경 시 `reloadProducts()` / `reloadRolls()`를 부른다. 다른 PC에서 검단을 마치면 라벨 PC가 1초 안에 알아야 하므로 `stock_rolls` 구독은 필수다.

---

## 5. 롤 라벨 인쇄 — `src/lib/rollLabelPrint.js` (신규)

`labelPrint.js`와 같은 구조(PAGE_W=80, PAGE_H=60, ROTATE=0, 숨긴 iframe). 내용물만 다르다.

라벨 한 장 구성(80×60mm):
- 좌측: QR 코드. 값은 `roll_code` 문자열 그대로(URL 아님. 스캐너가 키보드 입력으로 넣을 값이다). 크기 약 28mm.
- 우측 상단: `roll_code` 굵게(사람이 읽을 것). 예 `LH-2609-0142-R03`
- 우측 중단: 원단명 + 색상
- 우측 하단: 실측 수량(`length_available` + 단위), 검단일(YY.MM.DD), 위치
- 하단 여백: 회사명 작게

QR 생성: `npm install qrcode` 후 `QRCode.toString(rollCode, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 })`로 SVG 문자열을 만들어 iframe 문서에 인라인한다. 외부 이미지 로드가 없어야 인쇄 타이밍 문제가 안 생긴다.

`export function printRollLabels(rolls, products)` — 여러 롤을 한 번에(한 장씩 페이지 나눔). 반환값은 뽑은 장수.

---

## 6. 라벨 PC 출력 루프 확장 — `src/ErpApp.jsx` 1230행 근처

현재 루프는 `orders` 중 `labelRequestedAt && !labelPrintedAt`인 것을 요청순으로 훑어 `claimLabelPrint`로 선점한 뒤 `printFabricLabels`를 부른다. 같은 자리에서 **롤도 훑는다**:

1. `rolls.filter(r => r.labelRequestedAt && !r.labelPrintedAt)`를 요청순 정렬
2. 각 롤에 `db.claimRollLabelPrint(r.id)`로 선점, 성공한 것만 모아
3. `printRollLabels(mine, products)` 호출
4. 실패 시 `releaseRollLabelPrint`로 되돌리기 (기존 주문 라벨과 동일한 에러 처리)

주문 라벨과 롤 라벨은 **별도 인쇄 호출**로 나간다(한 문서에 섞지 않는다). 출력 담당 기기 판정(`label_station`)은 그대로 공유한다.

---

## 7. 화면

### 7-1. 탭 노출 변경

`ErpApp.jsx` 111~113행:
```js
const SHOW_IO_ALL_TABS = false;
const IO_VISIBLE_TABS = ... ["holding","returns","statement"];
```
숨겨진 `in`/`stock`/`history`는 그대로 두고, 보관/반품 영역의 하위 탭에 두 개를 새로 추가한다:
- `{id:"inspect", icon:"🏷", label:"입고·검단"}`
- `{id:"rolls",   icon:"🧵", label:"롤 재고"}`

`IO_VISIBLE_TABS`에 `"inspect"`, `"rolls"`를 넣는다. 기존 `InoutForm`(품목 수량 방식 입고)은 렌더 경로에서 빠진 상태를 유지한다.

### 7-2. `src/components/InspectionTab.jsx` (신규) — 입고·검단

두 섹션이 세로로 놓인다.

**섹션 A: 입고 등록**
- 품번 입력칸: 기존 품번 자동완성(`products` 검색, 코드·이름·색상). 선택하면 이름·색상·사진이 채워진다.
- 신규 품번이면: 원단명(필수), 색상, 단가(선택), 사진(선택, 파일 선택 또는 클립보드 붙여넣기 — `OrderInput.jsx`의 paste 핸들러 방식 참고). 등록 버튼을 누르면 `insertProduct`가 품번을 발급하고 결과 품번을 크게 보여준다.
- 롤 수(기본 1), 롤당 명세서 수량, 공급처, 위치(선택)
- "입고 등록" → `insertRolls` → 섹션 B의 검단 대기 목록에 즉시 나타남

**섹션 B: 검단 대기 (status = 'received')**
- 롤별 카드: roll_code, 원단명·색상, 명세서 수량, 입고일
- 카드 안에 실측 수량 입력칸(숫자, 소수 1자리 허용) + "검단 완료" 버튼
  - 실측이 명세서보다 크면 확인창 한 번("명세서보다 많습니다. 맞습니까?")
  - 실측이 0이면 "전량 폐기" 확인 후 `scrapRoll`
  - 실측 입력 후 검단 완료 → `inspectRoll` (RPC + 라벨 요청까지 한 번에)
  - 완료된 롤은 목록에서 사라지고 토스트: "검단 완료 — 라벨 출력 요청됨"
- 현재 라벨 담당 기기 이름과 상태를 섹션 상단에 작게 표시(설정 화면의 `label_station` 정보 재사용). 담당 기기가 없으면 경고 배너: "라벨 출력 PC가 켜져 있지 않습니다."
- 담당자 이름은 `activeManager`를 `inspected_by`로 쓴다.

### 7-3. `src/components/RollStockTab.jsx` (신규) — 롤 재고

- 상단 검색: 품번/원단명/색상/위치
- 품번별 그룹 카드(기본 접힘):
  - 사진 썸네일, 품번, 원단명·색상, 단가
  - **가용 표시 세 개**: 롤 수(available 상태), 합계 잔량, **가장 긴 롤 잔량**. 세 번째가 핵심이다 — 재단 주문은 "주문량 이상 남은 롤이 하나라도 있는가"로 판정하므로 합계는 참고값이고 가장 긴 롤이 실제 가용치다. 라벨을 "최대 재단 가능"으로 붙인다.
  - 검단 대기 롤이 있으면 "검단 대기 N" 배지
- 그룹을 펼치면 롤 목록:
  - roll_code, 상태 배지, 잔량/실측/명세서, 위치(인라인 편집 → `updateRollLocation`), 검단일·담당자
  - 행 액션: "라벨 재출력"(`requestRollLabelPrint`), "수량 조정"(± 입력 + 사유 → `adjustRoll`), "폐기"(사유 → `scrapRoll`), "이력"(`fetchRollMovements` 모달)
- 정렬: 검단 대기 있는 품번 먼저, 그다음 최근 입고순
- 판매 완료(sold)·폐기(scrapped) 롤은 기본 숨김, 토글로 표시

### 7-4. 삭제

`src/components/BarcodeTab.jsx` 삭제. `ErpApp.jsx`의 import(7행)와 `barcodeDB` state(79행), 렌더 부위 제거. 이 컴포넌트는 바코드 매핑을 메모리에만 들고 있어 새로고침하면 사라지는 프로토타입이며 실사용된 적이 없다.

---

## 8. 스캐너·프린터 전제

- 스캐너: USB/블루투스 2D 스캐너, HID(키보드) 모드. 스캔 값 뒤에 Enter가 붙도록 설정. 1단계 화면에는 스캔 입력이 없지만(2단계부터), `roll_code`는 스캐너가 그대로 타이핑할 값이므로 공백·특수문자 없이 `[A-Z0-9-]`만 쓴다.
- 프린터: 기존 Rongta PS100, 80×60 감열지, 드라이버 종이 설정 그대로. 새 라벨도 같은 용지.

---

## 9. 완료 기준 (검토자가 확인할 것)

1. 마이그레이션을 두 번 실행해도 에러 없음
2. 신규 품번 등록 → `LH-YYMM-####` 형식 코드가 발급되고 `products`에 1행
3. 롤 3개 입고 → `stock_rolls` 3행, status='received', roll_code가 `-R01`,`-R02`,`-R03`
4. 롤 하나 실측 42.5 입력 → `stock_movements`에 inspect 1행(qty 42.5), 롤 status='available', length_available=length_remaining=42.5, label_requested_at 채워짐
5. 라벨 담당 PC에서 1초 이내 라벨 1장 출력, label_printed_at 채워짐, 다른 PC에서는 출력 안 됨
6. 같은 롤 "라벨 재출력" → label_printed_at이 null로 돌아가고 다시 1장 출력
7. 수량 조정 -2.5 → 잔량 40, movements에 adjust 1행(qty -2.5)
8. 수량 조정 -50 → RPC 에러("remaining below zero"), 잔량 40 유지, movements에 행 추가 안 됨
9. 폐기 → status='scrapped', 잔량 0, movements에 scrap 1행(qty -40)
10. 롤 재고 화면에서 같은 품번 롤 3개(잔량 8/6/5)일 때 "가장 긴 롤 잔량" = 8
11. `BarcodeTab.jsx` 삭제 후 빌드 성공
12. 기존 주문 등록·포장·출고 흐름에 변화 없음(출고완료 시 `decrement_stock` 루프 그대로 동작)

---

## 10. 다음 단계 예고 (지금 구현하지 말 것, 설계 방향만)

- **2단계**: 재단 스캔. 셀러가 롤 QR을 찍고 자른 길이를 입력 → `roll_apply_movement('cut')` → `stock_pieces` 행 생성 → 인계 라벨에 QR(piece id) 포함 출력. 출고완료 시 `decrement_stock` 루프 제거. `orders.items[]`에 `itemId` 추가.
- **3단계**: 포장대 스캔 검증. 인계 라벨 QR을 찍어 주문 품목과 대조, 전 품목 스캔 전 포장완료 불가, 수기 우회는 사유 필수. 합배송으로 포장완료 건이 다시 열리면 해당 주문의 스캔 기록 무효화.
- 밴드 링크 주문·입금 자동매칭은 별도 지시서.
