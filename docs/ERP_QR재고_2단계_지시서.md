# THE BRIDGE ERP (Company) — QR 롤 재고 2단계 작업 지시서: 포장대 스캔

작성일: 2026-09-30
대상 저장소: `C:\Users\A\thebridge-ERP-company` (master ≥ `9afbee8`, 1단계 `067fb1e` 포함)
작업자: Claude Code
검토자: Cowork 세션(읽기 전용)
전제: 1단계(`docs/ERP_QR재고_1단계_지시서.md`)가 배포되어 `products`·`stock_rolls`·`stock_movements`·`roll_apply_movement`가 운영 DB에 있다.

---

## 0. 이 작업이 푸는 문제

로하이마켓의 실제 흐름은 다음과 같다.

> 원단 입고 → 검단·롤 라벨(1단계) → 셀러가 밴드 게시 → 주문 오면 셀러가 ERP 등록 → 셀러가 인계 라벨과 **롤을** 포장팀에 가져다줌 → **포장팀이 태블릿을 보며 주문 수량대로 재단하고 포장** → 택배 수거

재단과 포장을 같은 사람이 같은 자리에서 하므로, 롤 자체가 포장대에 온다. 따라서 포장직원이 **롤 QR을 찍는 한 동작**으로 세 가지가 동시에 해결된다.

1. 재고 차감 — 자른 길이만큼 롤 잔량이 빠진다 (지금은 아무것도 안 빠진다. `inventory`는 0행이라 출고 시 `decrement_stock` 루프는 빈 동작이다)
2. 원단 섞임 차단 — 찍은 롤의 품번이 이 주문 품목과 다르면 즉시 거부
3. 누락 차단 — 모든 품목이 찍히기 전엔 포장완료 버튼이 안 열린다

원래 계획의 2단계(재단 스캔)와 3단계(포장 검증)는 이 흐름에서 같은 것이므로 하나로 합친다. 인계 라벨은 바꾸지 않는다 — 셀러가 어느 롤이 어느 주문 것인지 포장팀에 알려주는 용도로 지금 그대로 쓴다.

### 범위에 포함
- `orders.items[]` 각 원소에 `itemId` 부여 (저장 계층에서)
- 주문 등록 화면의 품번 자동완성을 `inventory` → `products` 기준으로 교체
- 포장 탭에 스캔 입력, 롤↔품목 대조, 재단 길이 확인, 품목별 포장 기록, 포장완료 게이트, 롤 없는 품목 수기 우회
- `order_item_packing` 테이블 + 트랜잭션 RPC
- 출고완료 시 `decrement_stock` 루프 제거
- Realtime 구독 추가

### 범위에서 제외
- 인계 라벨(`labelPrint.js`) 내용·QR — 바꾸지 않는다
- `EditOrderModal`(UI.jsx)의 품목 편집 — 자유 입력 그대로 둔다
- 태블릿 카메라 스캔 — 이번엔 블루투스 HID 스캐너만. 카메라는 별도 작업
- 밴드 링크 주문, 입금 자동매칭 — 별도 지시서
- `inventory` 테이블·`InoutForm.jsx`·`useRealtimeInventory` 삭제 — 남겨둔다(무해)
- 합배송 규칙 변경(마지막 주문 기준 출고일) — 링크 주문 지시서에서

---

## 1. 따라야 할 기존 코드

| 목적 | 파일 | 확인할 것 |
|---|---|---|
| 포장 화면 구조 | `src/components/PackingTab.jsx` | `buildRows`가 합배송을 한 행(`row.orders[]`)으로 묶음, `allPacked`·`needsRepack` 판정(138~183행), `setPacked(row, packed)` 액션(444행 근처), 품목 줄 렌더(`perOrder`, 585행 근처, 728행), 원단 미도착 호출 `callForFabric` |
| 주문 등록 품번 자동완성 | `src/components/OrderInput.jsx` | 수기 입력 970행 근처와 AI 파싱 결과 2390행 근처 두 곳이 `inv.find(iv => iv.item_no...)`로 매칭. 저장 전 "재고에 없는 아이템" 확인창 1593행 근처 |
| 품목 배열이 만들어지는 곳 | `OrderInput.jsx` 826행(수기), 1482행(메모), AI 파싱 경로 | 세 곳 모두 `{itemNo, fabric, color, qty, unit, amount, unitPrice}` 형태. **`itemId`는 여기서 넣지 말고 db.js에서 넣는다** |
| 주문 저장 | `src/lib/db.js` `insertOrder`(428행), `insertOrderBatch`(301행), `updateOrder`(805행) | `items: order.items || []` 그대로 넘김 |
| 출고 처리 | `src/ErpApp.jsx` 652~676행 | `stockUpdates` 배열, `db.decrementStock` 루프, `setInv` 갱신 |
| 롤 RPC | `migrations/add_stock_rolls.sql` `roll_apply_movement` | 상태 검사·잔량 음수 거부. **인자 목록을 바꾸면 `create or replace`가 덮어쓰지 않고 오버로드를 만든다** — 반드시 `drop function`을 먼저 |
| 롤 요약 | `src/lib/rollStock.js` | `maxRemaining`(가장 긴 롤) 계산 함수 재사용 |
| 스캔 입력 선례 | 1단계 지시서 8절 | HID 스캐너 = 키보드 입력 + Enter |
| Realtime | `src/lib/realtime.js` `useRealtimeStockRolls` | 같은 형태로 하나 추가 |
| 담당자 역할 | `src/lib/managerLock.js` `isPacker`, `ErpApp.jsx` 189행 | 포장 기록의 `packed_by`는 `activeManager` |

---

## 2. DB 마이그레이션 — `migrations/add_item_packing.sql`

Supabase SQL Editor(Company DB)에서 실행. 배포보다 먼저. 파일 상단 주석은 1단계 파일과 같은 톤으로.

### 2-1. `roll_apply_movement`에 품목 연결 추가

```sql
-- 어느 주문의 어느 품목 때문에 빠졌는지 원장에 남긴다.
alter table stock_movements add column if not exists item_id text;

-- ⚠️ 인자가 늘어나므로 기존 함수를 먼저 지운다. create or replace 만으로는 6인자 판이 남아 둘이 공존한다.
drop function if exists roll_apply_movement(uuid, text, numeric, text, text, text);

create or replace function roll_apply_movement(
  p_roll_id  uuid,
  p_type     text,
  p_qty      numeric,
  p_order_id text default null,
  p_note     text default null,
  p_by       text default null,
  p_item_id  text default null
) returns stock_rolls
language plpgsql security invoker as $$
-- 본문은 1단계(067fb1e) 판 그대로. insert 에 item_id 컬럼만 추가:
--   insert into stock_movements (user_id, roll_id, type, qty, order_id, item_id, note, created_by)
--   values (auth.uid(), p_roll_id, p_type, p_qty, p_order_id, p_item_id, p_note, p_by);
$$;
```

### 2-2. 품목별 포장 기록

```sql
-- 주문 품목 하나가 어느 롤에서 얼마만큼 잘려 박스에 들어갔는가.
-- orders.items jsonb 에 쓰지 않는 이유: 포장 태블릿과 셀러 PC 가 같은 주문을 동시에 고칠 수 있다.
-- jsonb 통째 덮어쓰기는 나중 쓴 쪽이 이긴다. 행 단위 테이블이면 서로 안 밟는다.
create table if not exists order_item_packing (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  order_id        text not null,                   -- orders.id 는 text
  item_id         text not null,                   -- orders.items[].itemId
  roll_id         uuid references stock_rolls(id) on delete set null,  -- 수기 우회면 null
  length          numeric(10,2),                   -- 실제 자른 길이. 롤 통째면 그 롤의 잔량 전체
  whole_roll      boolean not null default false,
  override_reason text,                            -- 롤 없이 포장한 사유. 롤 스캔이면 null
  packed_by       text not null default '',
  packed_at       timestamptz not null default now(),
  unique (user_id, order_id, item_id)              -- 한 품목은 한 번만
);
create index if not exists idx_item_packing_order on order_item_packing(user_id, order_id);

alter table order_item_packing enable row level security;
drop policy if exists tenant_order_item_packing on order_item_packing;
create policy tenant_order_item_packing on order_item_packing for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE order_item_packing; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

### 2-3. 포장 RPC — 롤 차감과 포장 기록을 한 트랜잭션으로

```sql
-- 롤을 찍어 품목을 포장한다. 잔량 차감(roll_apply_movement)과 포장 기록 insert 가 한 트랜잭션.
-- 둘 중 하나만 성공하면 "빠졌는데 기록 없음" 또는 "기록 있는데 안 빠짐"이 된다.
-- 품번 대조(이 롤이 이 품목의 원단인가)는 화면이 한다 — 서버는 롤 상태와 잔량만 본다.
create or replace function pack_item_from_roll(
  p_order_id text,
  p_item_id  text,
  p_roll_id  uuid,
  p_length   numeric,          -- 자른 길이. p_whole 이면 무시하고 잔량 전체
  p_whole    boolean default false,
  p_by       text default null
) returns order_item_packing
language plpgsql security invoker as $$
declare
  r   stock_rolls;
  qty numeric;
  rec order_item_packing;
begin
  select * into r from stock_rolls where id = p_roll_id and user_id = auth.uid() for update;
  if not found then raise exception 'roll not found'; end if;

  qty := case when p_whole then coalesce(r.length_remaining, 0) else p_length end;
  if qty is null or qty <= 0 then raise exception '길이가 0 이하: %', qty; end if;

  -- 이미 포장된 품목이면 unique 가 막는다. 먼저 넣어서 잔량이 빠지기 전에 걸리게 한다.
  insert into order_item_packing (user_id, order_id, item_id, roll_id, length, whole_roll, packed_by)
  values (auth.uid(), p_order_id, p_item_id, p_roll_id, qty, p_whole, coalesce(p_by, ''))
  returning * into rec;

  perform roll_apply_movement(
    p_roll_id,
    case when p_whole then 'sell_whole' else 'cut' end,
    -qty, p_order_id, null, p_by, p_item_id);

  return rec;
end $$;

-- 포장 취소: 기록을 지우고 잔량을 되돌린다. 롤 없이(수기) 포장한 건은 기록만 지운다.
create or replace function unpack_item(p_order_id text, p_item_id text, p_by text default null)
returns void language plpgsql security invoker as $$
declare rec order_item_packing;
begin
  delete from order_item_packing
   where user_id = auth.uid() and order_id = p_order_id and item_id = p_item_id
  returning * into rec;
  if not found then return; end if;
  if rec.roll_id is not null then
    perform roll_apply_movement(rec.roll_id, 'adjust', rec.length, p_order_id,
                                '포장 취소로 되돌림', p_by, p_item_id);
  end if;
end $$;
```

`unpack_item`이 `adjust`를 쓰는 이유: 1단계 RPC가 `adjust`만 `sold` 롤에도 허용하고 잔량이 생기면 `available`로 되돌리기 때문이다. 통째 판매를 취소해도 롤이 살아난다.

### 2-4. 확인 SELECT

```sql
select
  (select count(*) from pg_proc where proname = 'roll_apply_movement') as rpc_overloads,  -- 반드시 1
  (select count(*) from order_item_packing) as packing_rows;                              -- 0
```

`rpc_overloads`가 2면 2-1의 drop이 안 된 것이다. 멈추고 알려라.

---

## 3. `items[].itemId` — 저장 계층에서 부여

`src/lib/db.js`에 헬퍼 하나:

```js
// 품목마다 고유 id. 포장 기록·재고 원장이 "이 주문의 몇 번째 품목"이 아니라 이 id 로 가리킨다.
// 자리번호(index)로 가리키면 품목을 지우거나 순서를 바꾸는 순간 기록이 엉뚱한 품목을 가리킨다.
// 이미 id 가 있는 품목은 그대로 둔다 — 수정 저장 때 id 가 바뀌면 포장 기록과 끊어진다.
export function ensureItemIds(items) {
  return (items || []).map(it => it?.itemId ? it : { ...it, itemId: crypto.randomUUID() });
}
```

적용 위치: `insertOrder`, `insertOrderBatch`, `updateOrder`(fields에 `items`가 있을 때만), `updateOrdersBulk`(같은 조건). 화면 코드는 건드리지 않는다. 기존 주문의 품목에는 `itemId`가 없다 — 이런 주문은 5절의 포장완료 게이트에서 제외한다(옛 방식대로 버튼이 바로 눌린다).

`EditOrderModal`(UI.jsx)에서 품목을 추가하면 `itemId` 없는 원소가 생기지만 `updateOrder`를 지나며 부여된다. 품목을 지우면 그 `itemId`의 포장 기록은 고아가 되는데, 화면은 `items[]`에 있는 것만 보므로 무시된다(`packed_sig` 재포장 경고가 그 상황을 이미 잡는다).

---

## 4. 주문 등록 — 품번 자동완성을 `products`로

`src/ErpApp.jsx`가 이미 1단계에서 `products`·`rolls`를 들고 있다. `OrderInput`에 `products`와 `rollSummaryByProduct`(rollStock.js의 요약 함수로 만든 `Map<productId, {availableCount, totalRemaining, maxRemaining}>`)를 prop으로 넘긴다.

`OrderInput.jsx`에서 바꿀 것:

- 970행 근처(수기)와 2390행 근처(AI 결과) 두 곳의 매칭·제안 목록: `inv` 대신 `products`. 코드·원단명·색상 어느 것으로든 검색. 제안 줄에 `코드 · 원단명 색상 · 최대 재단 N마`를 표시(`maxRemaining`이 0이면 "재고 없음"을 빨갛게).
- 제안을 고르면 `{ itemNo: p.code, fabric: p.name, color: p.color, productId: p.id }`를 품목에 넣고, `unitPrice`가 비어 있고 `p.unitPrice`가 있으면 채운다.
- `itemNo`를 직접 타이핑한 경우: 저장 직전에 `products.code`와 대소문자 무시 일치하면 `productId`를 채운다.
- 1593행 근처 "재고에 없는 아이템" 확인창: 판정을 `products` 기준으로 바꾼다. 있는데 `maxRemaining < qty`이면 확인창 문구에 "최대 재단 가능 N마 (주문 M마)"를 넣는다. **막지는 않는다** — 옛 재고·외주·급한 건이 있다.
- `inv` prop은 당장 제거하지 않아도 되지만, 이 화면 안에서 `inv`를 읽는 곳이 남아 있으면 안 된다. 남은 참조 0건을 확인.

`productId`는 `items[]`의 새 필드다. 3절의 `ensureItemIds`와 별개로, 없으면 없는 대로 저장된다.

---

## 5. 포장 탭 — 스캔

### 5-1. 데이터

- `ErpApp.jsx`에서 활성 주문(출고완료 아님)의 `order_item_packing`을 읽어 `packingByOrder: Map<orderId, Map<itemId, row>>`로 만들어 `PackingTab`에 넘긴다. `db.fetchItemPacking(orderIds)` 신규(1000행 페이지네이션).
- `useRealtimeItemPacking` 훅 추가, 변경 시 다시 읽는다. 포장 태블릿이 두 대 이상일 수 있고, 셀러 화면도 진행률을 봐야 한다.
- `rolls`·`products`도 `PackingTab`에 넘긴다(스캔한 코드를 롤로 바꾸고, 롤의 `productId`로 품목과 대조).

### 5-2. 스캔 입력

- 탭 상단에 스캔 입력칸 하나. 항상 보이고, 탭이 열릴 때·확인창이 닫힐 때·처리가 끝날 때 자동 포커스. 칸 옆에 "스캔 대기 중" 표시. 포커스를 잃으면 표시가 회색 "칸을 눌러 스캔 준비"로 바뀐다.
- Enter로 확정. 값은 `trim().toUpperCase()`. 사람이 타이핑해도 동작해야 한다(스캐너 고장 대비).
- 스캔 값 → `rolls.find(r => r.rollCode === v)`. 없으면 빨간 배너 "등록되지 않은 롤 코드: {v}" 3초.
- 롤 상태가 `available`·`reserved`가 아니면 배너 "이 롤은 {상태}입니다 — 잔량 {n}" 후 중단.

### 5-3. 대조

- **활성 행**: 행 카드를 누르면 활성(테두리 강조). 스캔은 활성 행에만 적용. 활성 행이 없으면 화면의 모든 행에서 찾는다.
- 후보 = 활성 행(또는 전체)의 `row.orders[].items[]` 중 (a) 포장 기록이 없고 (b) `itemId`가 있고 (c) `item.productId === roll.productId` 또는 (`productId` 없을 때) `item.itemNo.toUpperCase() === product.code`.
- 후보 1개 → 확인창 열기. 여러 개 → 고르는 목록(주문 고객명·품목·수량). 0개 →
  - 활성 행이 있으면: 빨간 배너 + 짧은 경고음(`AudioContext` 비프면 충분) "**이 주문의 원단이 아닙니다** — {product.code} {product.name}". 이 롤이 다른 행에 맞는 품목이 있으면 그 고객명을 함께 보여준다("→ {고객명} 주문 것입니다").
  - 활성 행이 없으면: "오늘 포장 목록에 이 원단 품목이 없습니다".

### 5-4. 확인창

- 표시: 고객명, 품목(원단명·색상), **주문 수량**, 롤 코드, 롤 잔량, 위치
- 입력: 자른 길이(숫자, 기본값 = 주문 수량), "롤 통째" 체크(체크하면 길이칸 비활성, 잔량 전체)
- 잔량 < 입력 길이면 확인 버튼 비활성 + "잔량 부족" 표시(서버도 막지만 누르기 전에 보여준다)
- 확인 → `db.packItemFromRoll(orderId, itemId, rollId, length, whole, activeManager)` → 성공 토스트 "{품목} {n}마 — {rollCode}" → 스캔칸 포커스. RPC 에러 메시지는 그대로 토스트.

### 5-5. 품목 줄 표시와 우회

- 728행 근처 품목 줄에 상태 추가:
  - 포장 기록 있음(롤): `✅ {rollCode} {length}마` + 작은 "취소" (→ `db.unpackItem`, 확인창 한 번)
  - 포장 기록 있음(수기): `✅ 롤 없이 — {reason}` + "취소"
  - 없음: 작은 버튼 "롤 없이 포장" → 사유 입력(빈 값 불가) → `db.packItemOverride(orderId, itemId, reason, activeManager)` (plain insert, `roll_id` null)
- `itemId` 없는 옛 주문의 품목: 아무 표시도 안 한다(옛 방식).

### 5-6. 포장완료 게이트

- `row`에 `scanTotal`(itemId 있는 품목 수)·`scanDone`(그중 포장 기록 있는 수) 추가.
- `scanTotal > 0 && scanDone < scanTotal`이면 포장완료 버튼 비활성, 라벨 "포장완료 ({scanDone}/{scanTotal})".
- `scanTotal === 0`(전부 옛 주문)이면 지금과 같다.
- **전환 기간(2026-10-01 결정)**: `src/lib/packing.js`의 `PACK_GATE_ENFORCED = false`. 스캐너가 없고 롤 등록에 한 달 넘게 걸리므로 게이트를 잠그지 않는다. 포장완료는 2단계 전과 똑같이 바로 눌리고, 스캔·"롤 없이 포장"은 하면 기록이 남는 선택 사항이다. 하나도 안 찍은 박스는 진행률도 안 붙는다(옛 모습 그대로). 롤이 충분히 등록되고 포장팀이 스캐너로 일하게 되면 `true`로 바꿔 배포한다 — 그때부터 다 찍어야 열린다.
- 포장완료 취소는 포장 기록을 지우지 않는다(원단은 이미 잘렸다). 재단을 무르는 건 품목 줄의 "취소"로만.
- 합배송으로 새 주문이 붙어 `needsRepack`이 되면 새 주문 품목만 스캔하면 된다. 기존 기록은 그대로.

### 5-7. 원단 미도착 호출과의 관계

`callForFabric`은 그대로. 포장 기록이 생기면 그 품목의 호출은 해제되는 게 자연스럽다 — `packItemFromRoll` 성공 후 그 `itemIdx`가 `fabricMissingItems`에 있으면 기존 해제 함수를 부른다.

---

## 6. 출고완료 — 재고 차감 제거

`src/ErpApp.jsx` 652~676행: `stockUpdates` 배열, `inv.find(...)` 매칭, `db.decrementStock` 루프, `setInv(...)` 갱신을 **제거**. `db.insertLog({type:"출고", ...})`는 남긴다(내역 테이블은 별개). `missing` 카운트와 그에 딸린 토스트 문구가 있으면 함께 정리.

이유: 재고는 포장 시점에 롤에서 이미 빠졌다. 출고에서 또 깎을 대상이 없고, `inventory`는 0행이라 이 루프는 지금도 빈 동작이다.

---

## 7. `db.js` 추가 함수

```js
export function ensureItemIds(items)                                  // 3절
export async function fetchItemPacking(orderIds)                      // order_item_packing, in(order_id), 페이지네이션
export async function packItemFromRoll(orderId, itemId, rollId, length, whole, by)  // rpc pack_item_from_roll
export async function packItemOverride(orderId, itemId, reason, by)   // insert roll_id null, override_reason
export async function unpackItem(orderId, itemId, by)                 // rpc unpack_item
```

`applyMovement`(1단계)에 `itemId` 인자 추가해 RPC의 `p_item_id`로 넘긴다. 기존 호출부는 `undefined`로 두면 된다.

---

## 8. 스캐너

- 태블릿에 블루투스 HID 스캐너를 페어링한다. 설정에서 접미사 Enter(CR) 켜기. 이건 코드가 아니라 상민이 준비한다.
- 스캐너가 없을 때도 5-2의 입력칸에 롤 코드를 타이핑하면 같은 흐름이 돈다 — 개발·테스트는 이걸로 한다.
- 태블릿 카메라 스캔은 이번 범위 밖. 필요해지면 `BarcodeDetector`(Android Chrome) 또는 `html5-qrcode`를 스캔칸 옆 버튼으로 붙이면 된다.

---

## 9. 완료 기준

1. 마이그레이션 두 번 실행해도 에러 없음, `rpc_overloads` = 1
2. 새 주문 저장 → `items[]` 각 원소에 `itemId`(uuid). 그 주문을 수정 저장해도 `itemId` 유지
3. 주문 등록에서 품번 입력 시 `products` 제안이 뜨고, 고르면 `itemNo`=code, `productId` 채워짐. "최대 재단 N마" 표시
4. 주문 수량이 최대 재단 가능보다 크면 확인창에 그 수치가 나오되 등록은 됨
5. 포장 탭에서 롤 코드 입력 → 맞는 주문 품목의 확인창 → 확인 → `order_item_packing` 1행, `stock_movements`에 `cut` 1행(qty 음수, order_id·item_id 채워짐), 롤 잔량 차감
6. 같은 롤 코드를 **다른 고객** 행을 활성화한 채 입력 → 거부 배너 + 경고음, DB 변화 없음
7. 같은 품목을 두 번 포장 시도 → unique 에러가 토스트로, 잔량 두 번 안 빠짐
8. "롤 통째" → `sell_whole`, 롤 status `sold`, 잔량 0
9. 품목 "취소" → 기록 삭제, `adjust` +행, 잔량 복구, `sold`였으면 `available`
10. 품목 2개 주문에서 1개만 스캔 → 포장완료 버튼 비활성 "(1/2)". 2개 스캔 → 활성
11. "롤 없이 포장" 사유 입력 → 기록 생성(roll_id null), 게이트 통과. 사유 비면 저장 안 됨
12. `itemId` 없는 기존 주문 → 포장완료 버튼 지금과 동일하게 바로 눌림
13. 출고완료 처리 후 `stock_rolls`·`stock_movements` 변화 없음(차감은 포장 때만)
14. 인계 라벨은 2단계 전과 동일하게 출력됨
15. 빌드 통과. `OrderInput.jsx`에 `inv` 참조 0건

PGlite 테스트(1단계 것이 `tests/`에 있으면 거기, 없으면 만들어서 `tests/stock-rolls/`에 넣고 `npm test`로 돌게): 1, 5~9, 12, 13은 코드 경로로 검증 가능.

---

## 10. 배포 순서

1. SQL 실행(상민) → `rpc_overloads` = 1 확인
2. `vercel --prod`(상민)
3. 포장 태블릿에서: 1단계 테스트 롤로 실제 주문 하나 포장 — 스캔·거부·완료 게이트 확인. 인계 라벨 1장 확인.

## 11. 그다음 (이번엔 하지 말 것)

- 밴드 링크 주문 + 입금 자동매칭 + 24시간 미입금 만료 + 합배송 규칙(출고완료만 제외, 마지막 주문 기준 출고일, 그룹 변경 시 택배비 부담 재계산) — 별도 지시서
- 롤 재고 화면의 "수량 조정" 버튼을 `available`·`reserved`·`sold`에서만 활성화(1단계 잔여)
- `next_product_code()` 익명 실행 차단(`revoke execute ... from anon`) — 공개 페이지 생길 때
