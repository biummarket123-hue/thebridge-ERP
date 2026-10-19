# 시안 분석 — design-reference/erp_saas_ui_prototype.html (2026-10-19)

새 UI(`src/saas/`)를 만들기 전에 시안 HTML 을 통째로 읽고 정리한 것. 구현은 이 표를 따른다.
시안 파일 한 장(48KB)에 CSS·HTML·JS 가 모두 들어 있다. 화면은 JS 가 문자열 템플릿으로 그린다.

## 1. 시연용 요소 (앱에 넣지 않음)

- `.previewbar` (상단 "INTERACTIVE UI CONCEPT · 01", PC/모바일 전환 세그먼트)
- `.stage` 바깥 배경(#eaf0f8), `.app` 의 24px 둥근 모서리·테두리·그림자, 모바일 모드의 기기 테두리(7px #263449)
- `.note` 하단 안내문 "디자인 탐색용 프로토타입 …"
- `state.mode` / `.mobile-mode` 클래스 — 앱에서는 **화면 폭(max-width: 720px)** 으로 모바일 레이아웃을 정한다.

## 2. 디자인 토큰 (`:root`)

| 변수 | 값 | 쓰임 |
|---|---|---|
| --blue | #3678f6 | Primary |
| --blue-dark | #245ed0 | Primary hover 글자 |
| --blue-soft | #eef4ff | Primary 연한 배경 |
| --ink | #202c3d | 본문 글자 |
| --sub | #64748b | 보조 글자 |
| --muted | #8391a4 | 흐린 글자 |
| --line | #e7ecf3 | 테두리 |
| --bg | #f5f7fb | 앱 배경 |
| --white | #fff | 카드 |
| --mint | #e5f8f2 | 성공 배경 |
| --green | #178b68 | 성공 |
| --orange | #f5a440 | 경고 |
| --red | #e56a63 | 오류 |
| --shadow | 0 10px 34px rgba(39,59,90,.045) | 카드 그림자 |
| font-family | 'Pretendard','Noto Sans CJK KR','NanumBarunGothic',system-ui | 글꼴 |

토큰에 없지만 CSS 에 박힌 색(그대로 옮긴다): 사이드 메뉴 글자 #617185, 활성 #eaf2ff/#2e6ee8, 배지 wait #fff4e7/#d88e3b, done #e9f8f1/#23986f, progress #eaf2ff/#3576e2, late #ffece9/#d76964, 미니 아이콘 mint #e8f9f2/#1d9c77, orange #fff3e5/#e69c45, purple #f3eefe/#8a69da, 차트 막대 #e0eafe/선택 #4b86f2, 토스트 #223955.

포커스 링: `outline:3px solid #a1bfff; outline-offset:3px`.

## 3. 레이아웃 (PC)

- `.app` flex. `.sidebar` 246px 고정(흰색, 오른쪽 1px 선, padding 30px 17px 20px). `.main` flex:1.
- `.topbar` 높이 92px, padding 0 38px, 흰색, 아래 1px 선. 왼쪽 breadcrumb("전체 메뉴 › 홈"), 오른쪽 날짜 pill(#f6f8fc) · 알림 아이콘 버튼 44×44(빨간 점) · 아바타 41×41.
- `.content` padding 35px 38px 65px, max-width 1510px, 가운데.
- 사이드바: 브랜드(로고 42px 그라데이션 #5d9dff→#3072ed, 14px 라운드) + "루프ERP"(21px/900) + 캡션 12px; "메뉴" 섹션 라벨 13px; nav 버튼 padding 15px 16px, 17px/750, 라운드 13px, gap 6px, 아이콘 21px; 주문 관리에 count 배지(#fdf0e6/#dc8650). 하단: 도움말 박스(#f5f8ff, 16px 라운드) + 프로필(아바타 + 이름 15px + 소속 12px).
- 반응형: ≤1200px 지표 2열·패널 1열·카드 그리드 2열. ≤720px 모바일(아래 5절).

## 4. 화면별 구성

### 홈 `home()`
1. `.greeting` — hello(13px 파랑 대문자 날짜 "MONDAY, OCTOBER 19") · title 31px/900 "좋은 아침이에요, 관리자님 ☀" · subtitle 17px. 오른쪽 text-link "주문 전체 보기 ›".
2. `.stats` 4열 — 오늘 들어온 주문(orders 아이콘) · 출고 대기(truck, orange) · 총 재고(box, mint) · 이번 달 매출(trend, purple). 카드 min-height 163, padding 22, 라운드 20, 숫자 30px/900 + 단위 16px, delta 13px(초록/alert 주황/muted 회색).
3. `.quick` — 그라데이션 박스(#eaf2ff→#f4f8ff), 캡션 "무엇을 도와드릴까요?" + 버튼 3개(주문 등록 primary, 입고 등록 white, 출고 처리 white). 버튼 min-height 52, padding 14px 19px, 라운드 13, 16px/850.
4. `.panels` 1.12fr/.88fr — 왼쪽 "지금 처리할 일"(task 3줄: 아이콘 46px + 제목 16px + 설명 14px + 건수 15px + 화살표), 오른쪽 "이번 주 출고 현황"(합계 26px + 증감 칩, 막대 7개 높이 168, 요일 라벨, 발 설명).
5. `.panel.full` "최근 주문" — 표(주문번호/거래처/품목/접수일/주문금액/상태) 3행, 모바일은 `.mobile-row` 목록.

### 주문 관리 `orders()`
greeting(ORDERS/주문 관리) → stats 4(오늘 주문·출고 대기·진행 중·완료) → `.searchline` 에 filter 칩(전체 주문/출고 대기/처리 중/완료) + 주문 등록 버튼 → `.panel.full` 주문 목록 표(전체). 행 클릭 → 주문 상세 모달(거래처·품목·금액·상태 + "처리 상태 변경" 버튼).

### 재고 관리 `stock()`
greeting(INVENTORY) → stats 4(총 원단 품목 layers / 총 재고 수량 box mint / 부족한 원단 alert orange / 이번 달 판매 trend purple) → `.searchline`(검색창 375px·53px + 재고 등록 primary) → `.panel`(원단 목록 h2 + "샘플 6개 품목" small, filter 칩 전체/재고 부족/품절, `.inv-grid` 3열).
`.invcard`: swatch 100px(그라데이션+격자 텍스처) · 이름 17px + 배지(판매 중 progress / 재고 부족 late / 품절 done) · 혼용률·색상 14px · 수량 20px/900+"마" · "보관 A-01" · progressbar 7px(잔량/최대, 25% 미만이면 #ec9875).
카드 클릭 → 원단 상세 모달(swatch 130px, 설명, 이름+수량, "샘플 재고 10마 추가" 버튼).

### 거래처 `users()`
greeting(CUSTOMERS) → stats 4(등록된 거래처/이번 달 거래/미수금 확인/신규 거래처) → searchline(h2 "주요 거래처" + 거래처 등록 버튼) → `.customer-grid` 3열 `.customercard`(이니셜 42px, 이름 19px, 지역 15px, 최근 주문, 금액 18px/900 + "이번 달 거래").

### 정산 `finance()`
greeting(SETTLEMENT, 오른쪽 "내역 내려받기" white 버튼) → stats 4(이번 달 매출/입금 확인/미수금/확인 대기) → panels: "월별 매출 현황"(chartmonth 200px, 6개월 막대) + "입금 확인 대기"(task 목록 3줄: 거래처·시각·금액).

## 5. 모바일 (≤720px)

- 사이드바·topbar 숨김. `.mobtop` 72px(로고 33px + 루프ERP 18px, 알림 39px). `.mobile-bottom` 하단 고정 79px(홈/주문/재고/거래처/정산, 아이콘 22px + 13px 글자, 활성 파랑). `.content` padding 22px 16px 110px(하단 메뉴만큼 여백).
- title 27px, subtitle 14px. stats 2열 gap 10, 카드 min-height 135 padding 16, 숫자 25px, 아이콘 35px, 매출 카드 숫자 22px.
- quick: block, 버튼 3열 grid, `.action` 세로(아이콘 위 글자 아래) min-height 62, 13px.
- panels 1열, panel padding 20px 16px, h2 19px, task 글자 14/13px, 아이콘 41px.
- 표(`.dtable`) 숨기고 `.mobile-list` 표시. searchline block(검색 100% + 버튼 100%). inv/customer grid 1열. 필터 13px.
- 모달(`.sheetbg`) 아래 정렬, `.sheet` 위만 둥글게(24px), padding 25px 22px 35px.

## 6. 컴포넌트 ↔ 시안 클래스

| 컴포넌트 | 시안 클래스 |
|---|---|
| AppLayout | .app .main |
| Sidebar | .sidebar .brand .logo .nav .count .support .profile .avatar |
| Header | .topbar .crumb .datepill .iconbtn .dot / .mobtop |
| MobileNavigation | .mobile-bottom .mobile-nav |
| PageHead | .greeting .hello .title .subtitle .text-link |
| StatCard | .stat .stat-top .miniicon(.mint/.orange/.purple) .stat-number .delta(.muted/.alert) |
| QuickAction | .quick .quick-caption .actions .action |
| Button | .btn .btn-primary .btn-white .ripple |
| Panel | .panel .panelhead |
| TaskRow | .task .taskicon(.alert/.mint) .tasktext .taskcount .taskarrow |
| BarChart | .chartsum .chart .baritem .bar(.selected) .chartfoot / .chartmonth |
| FilterChips | .filterline .filter(.active) |
| OrderTable | .tablewrap .dtable / .mobile-list .mobile-row .amount |
| StatusBadge | .badge(.wait/.done/.progress/.late) |
| SearchInput | .search |
| InventoryCard | .invcard .swatch .invrow .invstock .progressbar |
| CustomerCard | .customercard .initial .money |
| Modal | .sheetbg .sheet .sheethead .xbtn .formlabel .forminput .helptext |
| Toast | .toast(.show) |
| Empty | .empty |

## 7. 애니메이션·인터랙션

| 대상 | 효과 | 값 |
|---|---|---|
| 모든 버튼(.btn .nav .action .mobile-nav .pbtn) | :active 눌림 | transform: scale(.97) |
| .btn | hover 상승·그림자 | translateY(-1px), transition transform .16s / box-shadow .17s / background .18s |
| .btn 클릭 | Ripple | 70px 원, `@keyframes ripple { to { transform: scale(4); opacity: 0 } }` .55s linear, 배경 #ffffff6b |
| .stat hover | 상승 | translateY(-3px), 그림자 0 16px 36px #234a7810, .2s |
| .invcard / .customercard hover | 상승 | translateY(-2px), .18s |
| .task hover | 밀림 | translateX(2px), 배경 #f7faff, .2s |
| .nav | 배경·색 전환 | background .2s, color .2s, transform .15s |
| .iconbtn hover | 파란 배경 + 상승 | translateY(-1px), .2s |
| .dtable tr hover | 배경 | #f8fbff, .16s |
| .filter hover | 테두리 | #cdddff, .17s |
| .bar | 높이 전환 | height .55s cubic-bezier(.2,.8,.2,1) |
| 페이지 진입 `.fadein` | 등장 | `@keyframes pop`(opacity 0→1, translateY(17px) scale(.98)→0/1) .32s cubic-bezier(.2,.8,.2,1) |
| 모달 `.sheetbg` | 배경 fade | `@keyframes fade` .18s |
| 모달 `.sheet` | pop | .28s cubic-bezier(.2,.8,.2,1) |
| 모달 닫기 | 바깥 클릭(data-close) · × 버튼 · Escape | `keydown Escape → overlay 비움` |
| 토스트 | 아래서 올라옴 | transform translate(-50%,30px)→0, opacity, .23s; 2.6초 뒤 제거; 체크 아이콘 #76e5b5 |
| 페이지 이동 | 맨 위로 | `scrollTo({top:0, behavior:'smooth'})`, html scroll-behavior smooth |
| 재고 검색 | 입력마다 즉시 필터, 포커스 유지 | input 이벤트 |
| reduced-motion | 전부 끔 | `@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms;animation-duration:.01ms}}` |

시안에 없는 것(지시서 6절로 보강): 버튼 disabled(투명도·커서)·loading(중복 클릭 막기) 상태, 모달 포커스 처리.

## 8. 시안의 더미 ↔ 실데이터 연결 (지시서 4·5절)

| 시안 칸 | 실제 값 |
|---|---|
| 오늘 들어온 주문 24건 | 활성 주문 중 createdAt 이 오늘 |
| 출고 대기 7건 | 활성 주문 중 출고완료·보관·보류 아님 |
| 총 재고 2,480마 / 128개 품목 | 판매 가능 롤 잔량 합 / products 수 |
| 이번 달 매출 6,842만원 | 이번 달 payment_logs "입금" 합 |
| 지금 처리할 일 3줄 | lib/overview.js buildOverview 9구역(건수 있는 것만) + "전체/내 담당" |
| 이번 주 출고 86건 | shipped_at 이 이번 주인 출고완료 건수, 요일별 |
| 최근 주문 OD-1024… | fetchOrders 상위 5 (id 앞 8자리) |
| 원단 카드 | groupRollsByProduct + summarizeRolls (혼용률 "—", 보관 = stock_rolls.location) |
| 거래처 카드 | customers (지역 = 주소 앞 두 어절, 이번 달 거래 = 이번 달 주문 금액 합) |
| 월별 매출 | 최근 6개월 입금 로그 |
| 입금 확인 대기 | 환불 신청(payment=환불신청) + 미입금 주문 |
