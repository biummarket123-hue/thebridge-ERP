# THE BRIDGE ERP (Company) — 4단계 작업 지시서: 밴드 링크 주문 — 초안판 (내부 테스트용)

작성일: 2026-10-01
대상 저장소: `C:\Users\A\thebridge-ERP-company`
전제: 3단계(합배송 규칙·`settings.data.freight.baseFee`)가 master에 있다. 1·2단계 테이블(`products`·`stock_rolls`·`order_item_packing`)이 운영 DB에 있다.
작업자: Claude Code / 검토자: Cowork(읽기 전용)

---

## 0. 무엇을 만드는가 — 그리고 무엇을 안 만드는가

밴드 게시글에 `company.thebridge.ai.kr/o/{품번}` 링크를 넣고, 고객이 열어 수량·주소를 넣고 제출하는 **공개 주문 페이지**의 첫 판이다.

이번 판의 원칙: **읽는 건 전부 진짜, 쓰는 건 초안뿐.**
- 페이지는 실제 `products`·롤 잔량·고객·주문·무료배송권을 읽는다.
- "주문하기"는 `orders`에 쓰지 않는다. `link_order_drafts`(초안)에만 쓴다.
- 셀러가 ERP에서 초안을 보고 **"주문으로 전환"**을 누르면 기존 주문 저장 경로로 정식 주문이 생긴다.
- 내부 테스트 전용: URL에 테스트 키가 없으면 서버 함수가 거부한다. 밴드에 올리지 않는다.

초안 → 전환 구조는 테스트용 임시가 아니다. 자동 등록으로 갈 때는 "전환 버튼이 하는 일을 제출 시점에 서버가 하도록" 바꾸는 한 단계뿐이다.

### 범위에 포함
- 공개 페이지 `/o/:code` (ERP 번들·회사 세션과 분리)
- 서버 함수 3개(service role): 상품 조회, 고객 조회(인증 후), 초안 저장
- 전화번호 인증: 기존 `api/sms-verify.js` 재사용 (Coolsms 키 없으면 개발 모드 — 코드가 서버 로그에 찍힘)
- 고객이 고르는 합배송(3단계 규칙), 보유 무료배송권 사용 체크, 택배비 계산
- `link_order_drafts` 테이블 + ERP의 "링크 주문 초안" 목록 + 전환/거절
- 설정: 테스트 키, 회사 user_id

### 범위에서 제외
- 재고 예약·24시간 미입금 만료 — 초안은 재고를 안 잡는다
- 고객 상태 페이지, 셀러 확정 링크(협의 내용 미리 채움), 입금 안내 문자
- PG·가상계좌, 입금 자동매칭
- 자동 주문 등록
- 디자인 다듬기 — 모바일에서 깨지지 않는 수준이면 된다. 고객 노출 전에 별도로 한다

---

## 1. 반드시 지킬 보안 경계

- 공개 페이지는 `src/lib/supabase.js`의 회사 세션(`getUserId`, `company-session`)을 **절대 쓰지 않는다**. `supabase` 클라이언트도 import하지 않는다. 모든 데이터는 `/api/link/*` 서버 함수를 거친다.
- 서버 함수는 `SUPABASE_SERVICE_ROLE_KEY`로 Company DB(`VITE_SUPABASE_URL`)에 접근한다. `api/sms-verify.js`와 같은 방식. **운영 Vercel에 이 키가 없을 수 있다**(`api/analyze.js` 주석 참고) — 없으면 상민이 Vercel 환경변수에 넣어야 한다. 지시서 7절.
- 서버 함수는 요청마다 `?k=` 테스트 키(`LINK_TEST_KEY` 환경변수)를 검사한다. 불일치면 404. 이 키는 내부 테스트 동안만 쓰고, 고객 공개 때 제거한다.
- 회사 계정 uuid는 `LINK_COMPANY_USER_ID` 환경변수. 서버 함수는 모든 조회·삽입에 `.eq("user_id", ...)`를 건다 — service role은 RLS를 우회하므로 코드가 직접 걸어야 한다.
- 고객 조회는 **인증된 전화번호에 대해서만**. `phone_verifications`에 그 번호의 `verified=true` 행이 30분 이내에 있어야 한다. 아니면 403.
- 응답에 다른 고객의 어떤 정보도 섞이지 않게: 합배송 후보는 그 전화번호의 주문만, 무료배송권은 그 고객 이름만.
- 전화번호·주소를 URL 쿼리에 싣지 않는다. POST body로만.

---

## 2. DB — `migrations/add_link_order_drafts.sql`

```sql
-- 전화번호 인증 (api/sms-verify.js 가 쓴다). 저장소 SQL 에 없어서 여기서 보장한다.
create table if not exists phone_verifications (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null,
  code        text not null,
  verified    boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_phone_verif_phone on phone_verifications(phone, verified, created_at);
alter table phone_verifications enable row level security;
-- 정책 없음 = anon/authenticated 접근 불가. service role 만 쓴다.

-- 링크 주문 초안. orders 가 아니다. 셀러가 전환해야 주문이 된다.
create table if not exists link_order_drafts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  status              text not null default 'new' check (status in ('new','converted','rejected')),
  -- 상품
  product_id          uuid not null references products(id),
  product_code        text not null,
  product_name        text not null,
  unit_price          numeric(12,2),            -- 제출 시점 단가 스냅샷
  qty                 numeric(10,2) not null,
  -- 고객
  phone               text not null,
  customer_name       text not null,
  customer_id         bigint,                   -- customers.id, 기존 고객이면
  address             text not null default '',
  address_detail      text not null default '',
  delivery_message    text not null default '',
  -- 배송
  merge_with_order_id text,                     -- 고객이 고른 합배송 대상 orders.id. null = 단독
  use_free_shipping   boolean not null default false,
  shipping_fee        integer not null default 0,  -- 제출 시점 계산값
  total_amount        integer not null default 0,
  -- 처리
  converted_order_id  text,
  rejected_reason     text,
  handled_by          text,
  handled_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_link_drafts_user_status on link_order_drafts(user_id, status, created_at);
alter table link_order_drafts enable row level security;
drop policy if exists tenant_link_order_drafts on link_order_drafts;
create policy tenant_link_order_drafts on link_order_drafts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE link_order_drafts; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

select (select count(*) from link_order_drafts) as drafts,
       (select count(*) from phone_verifications) as verifications;
```

---

## 3. 서버 함수 — `api/link/`

공통(`api/link/_common.js`): service role 클라이언트, `requireTestKey(req)`, `COMPANY_USER_ID`, `normPhone`, `assertVerifiedPhone(phone)`(30분 이내 verified 행), JSON 에러 응답 헬퍼. `api/analyze.js`의 구조를 참고.

### `GET /api/link/product?code=LH-2609-0142&k=...`
반환: `{ code, name, color, photoUrl, unit, unitPrice, maxRemaining, availableCount, baseFee }`
- `products`에서 code(대소문자 무시)로 1건. 없으면 404.
- `stock_rolls`에서 `status='available'`인 롤의 `length_remaining` 최대값 = `maxRemaining`(`rollStock.js`와 같은 정의 — 재단 주문은 한 롤에서 끊어 나간다). 롤 수도 같이.
- `baseFee`는 `settings.data.freight.baseFee`(없으면 4000).
- `unitPrice`가 null이면 페이지는 "가격은 셀러가 안내" 문구를 띄우고 합계를 비운다.

### `POST /api/link/customer`  body `{ phone }`
- `assertVerifiedPhone` 통과 후:
- `customers`에서 전화번호(숫자만 비교) 일치 → `{ customerId, name, nickname, address, addressDetail }`. 없으면 `{ customerId: null }`.
- 합배송 후보: `orders`에서 같은 전화번호, `status <> '출고완료'`, 환불 아님, `split_shipping` 아님. 각 `{ id, date, items 요약(원단명 수량), shipDate, isUrgent, status, address }`. 3단계 `findMergeCandidates`의 조건과 같아야 한다 — 서버에서 그 조건을 그대로 옮긴다(함수 자체는 브라우저용이라 import 불가면 조건을 복제하고 주석으로 출처를 적는다).
- 무료배송권: `free_shipping_coupons`에서 `customer = name`인 행의 `count`. **같은 이름의 고객이 둘 이상이면 0으로 주고 `nameAmbiguous: true`** — 남의 배송권이 보이면 안 된다.

### `POST /api/link/draft`  body `{ code, qty, phone, customerName, address, addressDetail, deliveryMessage, mergeWithOrderId, useFreeShipping }`
- `assertVerifiedPhone`.
- 상품 다시 조회(가격·재고 스냅샷은 서버가 찍는다. 클라이언트 값 안 믿음). `qty > maxRemaining`이면 400 "최대 재단 가능 N마" — 초안이라도 재고 넘는 주문은 안 받는다.
- `mergeWithOrderId`가 있으면 그 주문이 위 후보 조건을 만족하는지 재검증. 아니면 400.
- 택배비: `useFreeShipping`이고 배송권 count > 0 → 0. 아니면 `mergeWithOrderId` 있으면 0(그룹 부담자가 이미 있다), 없으면 `baseFee`.
- `total_amount = round(unitPrice * qty) + shipping_fee` (unitPrice null이면 0).
- `link_order_drafts` insert, `status='new'`. 반환 `{ draftId }`.
- 같은 전화번호로 1분 안에 3건 넘으면 429.

---

## 4. 공개 페이지 — `src/public/OrderLink.jsx`

### 라우팅
`src/App.jsx`가 랜딩↔ERP를 고르는 자리에서, `location.pathname`이 `/o/`로 시작하면 `OrderLink`만 렌더한다. **ERP·Auth·supabase 모듈이 이 경로에서 import되지 않게** 동적 import(`React.lazy`)로 분리한다. `vercel.json`의 rewrite는 이미 `/((?!api|assets|admin).*)` → `index.html`이라 추가 설정 없음.

### 화면 흐름 (모바일 세로 기준, 한 페이지 스크롤)
1. **상품**: 사진, 품번, 원단명·색상, 단가(마당), "지금 주문 가능 최대 N마"(=maxRemaining). 0이면 "품절" 표시와 주문 버튼 비활성.
2. **수량**: 숫자 입력(0.5 단위 허용 여부는 unit이 '마'일 때 소수 1자리). maxRemaining 넘으면 빨간 안내.
3. **전화번호 인증**: 번호 입력 → "인증번호 받기"(`/api/sms-verify` action=send) → 코드 입력 → 확인(action=verify). 통과하면 4번이 열린다.
4. **고객 정보**(`/api/link/customer`): 기존 고객이면 이름·주소 자동 채움(수정 가능). 신규면 이름·주소 입력. 주소는 `src/lib/postcode.js`(이미 있음) 재사용.
5. **합배송**: 후보가 있으면 목록 — "함께 보내기(택배비 0원)" 라디오 + "따로 보내기(택배비 N원)". 후보를 고르면 **주소가 그 주문의 주소로 고정**되고 입력칸이 잠긴다(같은 박스에 넣으려면 같은 곳). 포장완료 상태 후보에는 "포장 완료된 주문 — 다시 포장됩니다" 작은 안내. 후보가 없으면 이 섹션 없음.
6. **무료배송권**: count > 0이면 "보유 N장 · 사용하기" 체크. `nameAmbiguous`면 "배송권 확인은 셀러에게 문의" 문구.
7. **합계**: 원단 금액 + 택배비. 단가 없으면 "금액은 셀러가 안내드립니다".
8. **주문하기** → `/api/link/draft` → 완료 화면: "주문이 접수되었습니다. 셀러가 확인 후 입금 안내를 드립니다." + 초안 번호 앞 8자리. (내부 테스트용 문구. 고객 공개 전 수정)

에러는 서버 메시지를 그대로 보여준다(최대 재단 가능 초과, 인증 만료 등).

### 테스트 키
페이지는 URL의 `?k=`를 읽어 모든 API 호출에 붙인다. 없으면 첫 화면에서 "준비 중인 페이지입니다"만 보여준다.

---

## 5. ERP 쪽 — 초안 목록과 전환

### 데이터
`db.js`: `fetchLinkDrafts({ status })`, `rejectLinkDraft(id, reason, by)`, `markDraftConverted(id, orderId, by)`. `realtime.js`: `useRealtimeLinkDrafts`.

### 화면
주문입력 탭 상단(메모 등록 영역과 같은 자리)에 **"링크 주문 초안 N건"** 카드. 펼치면 초안 목록: 고객명·전화 뒷4자리·품번·수량·합배송 여부·택배비·합계·제출 시각. 각 행에 "주문으로 전환"·"거절".

### 전환
"주문으로 전환"은 초안을 **주문입력 폼에 채워 넣는다**(새 orders insert 코드를 따로 쓰지 않는다). 메모 등록 경로(`applyNotePrefill`, OrderInput 1482행 근처)가 이미 "외부 데이터 → 폼 채우기 → 셀러가 확인 후 등록"을 하므로 같은 방식으로 `applyDraftPrefill(draft)`를 만든다:
- items = `[{ itemNo: product_code, fabric, color, qty, unit, unitPrice, amount, productId }]`
- customer/phone/address/addressDetail/deliveryMessage, shippingFee, totalAmount, payment '미입금'
- `mergeWithOrderId`가 있으면 기존 수동 합배송 선택(`mergeIds`)에 넣는다 → 등록 시 3단계 규칙으로 묶이고 택배비 재계산
- `useFreeShipping`이면 기존 `wantFreeShipping` 플래그
- 셀러가 등록 버튼을 누르면 기존 흐름(고객 중복 방어, 합배송, 배송권 차감, 라벨 요청)이 전부 그대로 돈다. 등록 성공 콜백에서 `markDraftConverted`.

이렇게 하면 전환 로직이 따로 생기지 않고, 초안이 "셀러가 손으로 치던 쪽지"를 대체하는 자리에 정확히 들어간다.

---

## 6. 완료 기준

1. 마이그레이션 2회 실행 OK. `drafts`=0.
2. `/o/{존재하는 품번}?k={키}` → 사진·이름·단가·최대 N마 표시. 키 없으면 "준비 중". 없는 품번이면 "상품을 찾을 수 없습니다".
3. 인증 전엔 고객 조회 API가 403. 인증 후 기존 고객 → 이름·주소 채워짐.
4. 같은 전화번호로 접수 상태 주문이 있는 고객 → 합배송 후보 표시. 고르면 주소 잠김, 택배비 0. 안 고르면 baseFee.
5. 무료배송권 있는 고객 → "보유 N장" 표시, 사용 체크 시 택배비 0. 동명이인이면 0장 + 안내.
6. qty > maxRemaining → 서버 400, 초안 안 생김.
7. 제출 → `link_order_drafts` 1행, `orders` 변화 **없음**, 롤 잔량 변화 **없음**.
8. ERP 주문입력 탭에 초안 1건 표시(Realtime으로 새로고침 없이).
9. "주문으로 전환" → 폼이 채워지고, 등록 누르면 기존 경로로 주문 생성, 초안 status=converted, converted_order_id 채워짐. 합배송 고른 초안이면 그룹으로 묶이고 택배비 한 건만.
10. "거절" → status=rejected, 사유 저장.
11. 공개 페이지 번들에 `supabase.js`·`ErpApp` 코드가 포함되지 않음 (`vite build` 후 `/o/` 진입 시 로드되는 청크로 확인).
12. 전화번호·주소가 어떤 GET 쿼리에도 없음 (네트워크 탭 확인).
13. 빌드·테스트 통과. 서버 함수는 PGlite로 못 돌리니 핸들러 로직을 순수 함수로 떼어 테스트(택배비 계산, 후보 조건, 배송권 동명이인 판정).

---

## 7. 배포 전 상민이 할 것

1. Vercel 환경변수: `SUPABASE_SERVICE_ROLE_KEY`(Company DB), `LINK_COMPANY_USER_ID`(회사 계정 auth uuid — Supabase Authentication 화면에서 복사), `LINK_TEST_KEY`(아무 긴 문자열). Coolsms 키는 내부 테스트 동안 넣지 않는다(개발 모드 — 인증번호는 Vercel 함수 로그에서 본다).
2. SQL 실행 → 결과 확인.
3. 배포.
4. 테스트: 본인 전화번호로 1단계 테스트 품번 링크를 열어 완료 기준 2~10을 순서대로.

## 8. 고객 공개로 가기 전에 해야 할 것 (이번엔 하지 말 것)
- 테스트 키 제거 + 요청 제한 강화(IP 기준)
- Coolsms 실키 + 문자 문구
- 재고 예약·24시간 만료, 상태 페이지, 셀러 확정 링크
- 페이지 디자인·문구, 주문 완료 화면의 입금 안내
- 자동 등록 전환(= 전환 버튼의 일을 서버가 제출 시점에)
