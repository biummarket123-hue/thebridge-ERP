# THE BRIDGE ERP (Company) — 4단계-B 작업 지시서: 인증 제거 + 셀러 링크 (초안판 보충)

작성일: 2026-10-01
대상 저장소: `C:\Users\A\thebridge-ERP-company` (master ≥ `64f388d`, 4단계 초안판 위에)
작업자: Claude Code / 검토자: Cowork(읽기 전용)
목적: 로컬 개발 서버에서 두 흐름의 느낌을 본다. 배포 아님.

---

## 0. 왜 바꾸는가

4단계 초안판은 고객이 전화번호 인증을 해야 본인 주소·지난 주문·배송권을 볼 수 있게 했다. 그런데 어르신 고객 비중이 높아 **인증 자체가 장벽**이다. 다시 보니 고객 화면에 그 정보를 보여줄 필요가 없다 — 초안을 셀러가 전환할 때 ERP가 이름·전화로 기존 고객을 찾고, 3단계 규칙이 합배송을 묶고, 배송권도 거기서 적용된다. 고객이 고르던 걸 셀러 전환으로 넘기면 인증이 통째로 빠진다.

흐름을 둘로 나눈다. 같은 페이지, 같은 초안 테이블, "셀러가 미리 채웠는가"만 다르다.

| | 공개 링크 (게시글) | 셀러 링크 (쪽지) |
|---|---|---|
| 대상 | 신규·직접 주문 가능한 고객 | 단골·어르신 |
| URL | `/o/{품번}` | `/o/t/{토큰}` |
| 고객이 치는 것 | 이름·전화·수량 (+주소, 체크 안 하면) | 없음 — "이대로 주문" 버튼 |
| 본인 확인 | 없음(초안이라 셀러가 거른다) | 링크 자체(쪽지로 그 사람에게만 갔다) |
| 결과 | 초안 `new` → 셀러 전환 | 초안 `offered` → 고객 확인 → `new` → 셀러 전환 |

셀러 링크도 이번엔 고객 확인 후 **셀러가 전환**한다. 자동 주문 생성은 `insertOrder` 경로(고객 중복 방어·합배송·배송권·라벨 요청)를 서버에서 재현해야 하는 큰 일이라 다음에 한다. 지금은 "고객이 확인했다" 표시가 초안에 붙고 셀러가 1클릭 전환하는 것까지.

### 범위에서 제외
- 자동 주문 생성, 재고 예약, 입금 안내 문자
- `api/sms-verify.js`·`api/link/customer.js` 삭제 — 남겨두되 페이지에서 호출하지 않는다
- 디자인

---

## 1. DB — `migrations/add_link_drafts_offer.sql`

```sql
alter table link_order_drafts
  add column if not exists source           text not null default 'public' check (source in ('public','seller')),
  add column if not exists token            text,                 -- 셀러 링크용 1회 토큰. 공개 링크는 null
  add column if not exists expires_at       timestamptz,          -- 셀러 링크 만료. 24시간
  add column if not exists confirmed_at     timestamptz,          -- 고객이 "이대로 주문" 누른 시각
  add column if not exists use_last_address boolean not null default false,  -- 공개 링크: "지난번 배송지로"
  add column if not exists wants_merge      boolean not null default false,  -- 공개 링크: "이전 주문과 함께"
  add column if not exists created_by       text;                 -- 셀러 링크 만든 담당자
-- status 에 'offered' 추가 (고객 확인 대기)
alter table link_order_drafts drop constraint if exists link_order_drafts_status_check;
alter table link_order_drafts add constraint link_order_drafts_status_check
  check (status in ('offered','new','converted','rejected','expired'));
-- 공개 링크는 주소를 안 받을 수 있다
alter table link_order_drafts alter column address set default '';
create unique index if not exists idx_link_drafts_token on link_order_drafts(token) where token is not null;

select count(*) filter (where source='seller') as seller_drafts, count(*) as drafts from link_order_drafts;
```

`merge_with_order_id`는 셀러 링크에서 셀러가 고른 값으로 계속 쓴다. 공개 링크에서는 null이고 `wants_merge`만 남는다.

---

## 2. 공개 링크 — `/o/{품번}` 바꿀 것

### 2-1. 화면 (`src/public/OrderLink.jsx`)
전화번호 인증 섹션(3번)과 고객 조회(4·5·6번 — 주소 자동 채움, 합배송 후보 목록, 배송권)를 **제거**. 남는 화면:

1. 상품 (그대로)
2. 수량 (그대로)
3. **이름 · 전화번호** 입력
4. **체크 두 개**
   - ☐ 지난번 배송지로 보내주세요 (전에 주문한 적 있는 분) → 체크하면 주소 입력칸이 접힌다
   - ☐ 아직 안 받은 이전 주문과 함께 보내주세요 (택배비 없음)
5. **주소** — 4-1 체크 안 했을 때만. `postcode.js` 그대로
6. 합계 — 원단 금액 + 택배비. 택배비는 "함께 보내기" 체크면 0, 아니면 baseFee. **안내 문구**: "택배비와 합배송은 셀러가 확인 후 최종 안내드립니다"
7. 주문하기 → 완료 화면 "주문이 접수되었습니다. 셀러가 확인 후 입금 안내를 드립니다."

글자 크게, 입력칸 높게(어르신 기준 최소 48px). 이름·전화 칸은 `autocomplete="name"`, `"tel"`.

### 2-2. 서버 (`api/link/draft.js`)
- `isPhoneVerified` 호출 제거.
- body에 `useLastAddress`, `wantsMerge` 추가. `useLastAddress`면 `address` 비어 있어도 통과.
- `mergeWithOrderId`·`useFreeShipping`은 공개 링크에서 받지 않는다(무시).
- 택배비: `wantsMerge ? 0 : baseFee`. 배송권 계산 제거.
- `customer_id`는 전화번호로 찾아지면 넣고(있으면 편하다), 못 찾아도 통과.
- 저장: `source='public'`, `use_last_address`, `wants_merge`.
- 요청 제한은 그대로(1분 3건).

### 2-3. ERP 전환 (`OrderInput.jsx` `applyDraftPrefill`)
- `use_last_address`면: 전화번호(없으면 이름)로 `customers`에서 찾아 주소·상세주소를 채운다. 못 찾으면 폼 상단에 빨간 안내 "지난번 배송지 요청 — 고객 카드가 없어 주소를 못 채웠습니다. 쪽지로 확인하세요".
- `wants_merge`면: 폼 상단에 안내 "고객이 합배송을 원함" — 묶기는 등록 시 기존 자동 합배송(`findMergeCandidates`)이 한다. 후보가 없으면 그냥 단독 등록되고 택배비는 3단계 규칙(baseFee)이 붙는다. 초안의 택배비 0은 희망값일 뿐 등록값이 아니다.
- 초안 카드에 `source` 배지("게시글" / "쪽지")와 `wants_merge`·`use_last_address` 아이콘.

---

## 3. 셀러 링크 — 새로 만드는 것

### 3-1. ERP: "주문 링크 만들기" (`OrderInput.jsx` 직접입력 폼)
등록 버튼 옆에 **"📨 주문 링크 만들기"** 버튼. 누르면:
- 검사: 고객이 골라져 있거나 이름+전화가 있을 것, 품목 1개 이상이고 각 품목에 `productId`가 있을 것(품번 없는 품목은 링크 불가 — 재고 수량을 보여줘야 하므로), 수량 ≤ 최대 재단 가능.
- 택배비·합배송은 폼에 있는 값 그대로(셀러가 정한 것). 무료배송권 체크(`wantFreeShipping`)도 그대로.
- `db.createSellerLinkDraft({...})` → `link_order_drafts`에 `source='seller'`, `status='offered'`, `token`(32자 랜덤, `crypto.randomUUID()` 두 개 이어붙여 `-` 제거), `expires_at = now()+24h`, `created_by = activeManager`, 고객·품목·주소·택배비·합배송 대상·합계 저장. **orders에는 아무것도 안 쓴다.**
- 모달: 링크 전체 표시 + "복사" 버튼 + "24시간 안에 확인하지 않으면 만료됩니다". 링크는 `${location.origin}/o/t/${token}?k=${테스트키}` — 테스트 키는 `VITE_LINK_TEST_KEY`로 번들에 넣는다(내부 테스트 동안만. 고객 공개 때 제거).
- 폼은 비우지 않는다(같은 고객에게 한 번 더 만들 수 있게).

품목이 여러 개면 초안 한 행에 `items` jsonb로 담아야 한다. 현재 테이블은 품목 1개 구조(`product_id`·`qty`)라 **`items jsonb` 컬럼을 추가**하고(1절 SQL에 `add column if not exists items jsonb`), 셀러 링크는 `items`에 전부 넣고 `product_id`·`qty`에는 첫 품목을 넣는다. 공개 링크는 지금처럼 1품목.

### 3-2. 서버
- `GET /api/link/offer?t={토큰}&k=` → 토큰으로 `offered` 행 1건. 없으면 404, `expires_at` 지났으면 410 + status를 `expired`로. 반환: 고객명, 전화 뒷4자리, 품목들(이름·색상·수량·단가·금액), 주소·상세, 택배비, 합배송 여부(대상 주문 날짜·품목 요약), 합계, 만료 시각. **토큰이 곧 인증**이라 주소를 그대로 준다.
- `POST /api/link/confirm` body `{ token, qty?, address?, addressDetail?, deliveryMessage? }` → 행이 `offered`이고 안 지났으면 `status='new'`, `confirmed_at=now()`, 고객이 고친 값 반영(수량은 최대 재단 가능 재검증, 늘리면 400). 반환 `{ ok, draftId }`. 두 번 누르면 409.

### 3-3. 화면 `/o/t/{토큰}`
`OrderLink.jsx`가 경로를 보고 모드를 가른다(`/o/t/`면 offer 모드). 상품 조회 대신 `offer`를 부른다.

- 상단: "{고객명}님, 셀러가 보낸 주문서입니다"
- 품목 카드(사진 있으면), 수량, 금액
- 배송지(주소 그대로 표시) + "주소 바꾸기" 작은 버튼 → 누르면 입력칸
- 합배송이면 "이전 주문({날짜} {품목})과 함께 보냅니다 · 택배비 0원"
- 합계 크게
- **"네, 이대로 주문할게요"** 큰 버튼 하나 → `confirm` → 완료 화면 "주문이 접수되었습니다. 입금 안내는 셀러가 쪽지로 드립니다."
- 만료(410): "링크가 만료되었습니다. 셀러에게 다시 요청해 주세요."
- 이미 확인(409): "이미 주문하셨습니다."

### 3-4. ERP 초안 카드
- `offered` 행: "고객 확인 대기" 회색, 만료까지 남은 시간, 링크 다시 복사 버튼. 전환 불가.
- `new`(확인됨) 행: 초록 "고객 확인 ✓ {시각}" + 전환·거절. 전환은 기존 `applyDraftPrefill` — 셀러 링크면 `items` 전부, 셀러가 정한 택배비·합배송 대상·배송권 체크까지 그대로 폼에.
- 만료 처리: `fetchLinkDrafts`가 읽을 때 `offered` 중 `expires_at < now()`인 것은 화면에서 "만료"로 표시(DB 갱신은 `offer` API가 열릴 때, 또는 전환 시).

---

## 4. 완료 기준

공개 링크
1. 인증 없이 이름·전화·수량만 넣고 제출 → 초안 `source='public'`, `use_last_address`·`wants_merge` 저장. `orders` 변화 없음.
2. "지난번 배송지" 체크 → 주소칸 접힘, 주소 없이 제출됨. 전환 시 고객 카드 주소가 폼에 채워짐. 카드 없으면 빨간 안내.
3. "함께 보내기" 체크 → 초안 택배비 0. 전환 등록 시 후보 있으면 묶이고(3단계), 없으면 baseFee.
4. `/api/link/customer`·`sms-verify`가 페이지에서 호출되지 않음(네트워크 탭).

셀러 링크
5. ERP 직접입력 폼에서 고객·품목(품번 있음) 채우고 "주문 링크 만들기" → `offered` 행, 토큰, 24h 만료, 모달에 링크. `orders` 변화 없음.
6. 품번 없는 품목이 있으면 버튼이 막히고 이유 표시.
7. `/o/t/{토큰}` → 고객명·품목·주소·택배비·합계가 채워진 화면. 토큰 틀리면 404.
8. "이대로 주문" → `status='new'`, `confirmed_at`. ERP 초안 카드가 Realtime으로 "고객 확인 ✓"로 바뀜.
9. 같은 링크 다시 열어 누르면 409 "이미 주문하셨습니다".
10. `expires_at`을 SQL로 과거로 바꾸고 열면 410 + status `expired`.
11. 전환 → 폼에 품목 전부·택배비·합배송 대상·배송권 체크가 그대로 → 등록 → `converted`.
12. 빌드·테스트 통과. `OrderLink` 청크에 여전히 ERP·supabase 없음.

## 5. 로컬 검증 순서(상민)
1. SQL 실행 → `seller_drafts | drafts`
2. 개발 서버 재시작
3. 공개 링크: `/o/{품번}?k=…` 열어 이름·전화·수량만으로 제출
4. 셀러 링크: ERP 주문입력에서 본인 고객 골라 "주문 링크 만들기" → 링크를 새 탭(기기 모드)에 붙여넣기 → "이대로 주문" → ERP 카드 변화 → 전환
