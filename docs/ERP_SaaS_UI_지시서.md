# ERP SaaS 새 UI 구현 지시서 (작업 세션용 프롬프트)

작성 2026-10-19. 이 문서는 원단 도매 ERP 를 업계용 SaaS 로 내놓기 위해 **새 UI 를 만드는 작업 세션**에 주는 지시서다.
디자인 요구사항(부록 A)과, 기존 ERP 코드를 분석해 정리한 기능·데이터 계약(본문)을 합쳐 놓았다.
부록 A 와 본문이 충돌하면 **본문의 "지켜야 할 업무 규칙"(6절)이 디자인보다 우선**한다. 그 외에는 부록 A 가 우선한다.

---

## 0. 전제 — 폴더·브랜치·명령어

- 작업 폴더: `C:\Users\A\ERPsaas` (원본 저장소 `thebridge-ERP-company` 의 git clone, 브랜치 `saas-ui`).
- 원본 회사 운영 배포는 원본 폴더의 `master` 에서 나간다. **이 폴더에서는 배포하지 않는다.** `vercel` 명령 금지.
- 개발 서버 `npm run dev` (포트 3600), 빌드 `npm run build`, 테스트 `npm test` (tests/run.mjs, 32개).
- `.env.local` 은 원본에서 복사돼 있다. **개발 서버도 실제 운영 DB 를 쓴다.** 시안의 더미 숫자를 저장 경로로 흘리지 말 것. 새 UI 에서 "저장"이 일어나는 기능은 반드시 사용자에게 먼저 알리고 진행한다.
- 디자인 원본: `design-reference/` 폴더. 파일이 없으면 **작업을 시작하지 말고 사용자에게 파일을 요청**한다.
  - `erp_saas_ui_prototype.html` (최우선), `erp_saas_desktop.png`, `erp_saas_mobile.png`, `erp_saas_inventory_desktop.png`, `erp_saas_inventory_mobile.png`
- 커밋은 작은 단위로 자주. 푸시는 `saas-ui` 브랜치로만.

## 1. 이미 내린 결정 (다시 묻지 말 것)

1. **새 UI 는 새 폴더 `src/saas/` 에 만든다. 기존 `src/ErpApp.jsx`·`src/components/*` 는 수정하지 않는다.** 참고용으로만 읽는다. 재사용하는 것은 `src/lib/db.js`, `src/lib/*.js`, `src/constants.js` 의 판정 함수(isHold·isParked·getPayStatus 등)뿐이다.
2. **진입**: `src/main.jsx` 의 경로 분기에 새 UI 를 추가한다. `/app` 이하 → 새 SaaS UI. 기존 `/`(옛 ERP), `/o`, `/r` 은 그대로 둔다. 옛 ERP 가 당분간 같이 쓰이므로 옛 화면을 깨뜨리면 안 된다.
3. **인증**: 기존 구조를 바꾸지 않는다. 1차에서는 옛 ERP 와 같은 세션(회사 로그인 → 담당자 선택)을 그대로 쓴다. `src/AppEntry.jsx` 의 CompanyRoot 가 로그인을 끝낸 뒤 새 UI 를 그리게 한다. 회원가입·체험·플랜(`src/SaasRoot.jsx`, `companies` 표)은 2차.
4. **회사별 설정(밴드·카톡·매장·도매 차이)**: 1차에서는 모든 기능을 "켜짐"으로 둔다. 설정 화면은 2차. 단, 하드코딩된 회사 값(택배비 마 4,000/롤 7,000, CJ 15:30·경동 17:30 수거, 품번 이니셜)은 새 UI 코드에 다시 박지 말고 `src/saas/config.js` 한 파일로 모아 둔다.
5. **5메뉴 외의 기존 기능**(포장 태블릿 스캔, 화면 키보드, 라벨 PC 출력, 공지, 주문 메모 채팅, 공개 주문 링크 관리)은 이번 범위 밖. 새 UI 에서 "옛 화면에서 처리" 링크로 보낸다.
6. 모바일은 PC 를 줄인 것이 아니라 별도 레이아웃(부록 A 5절). 포장팀 태블릿은 옛 화면을 계속 쓴다.

## 2. 프로젝트 구조 요지

- Vite 4 + React 18. 라우터 없음(옛 ERP 는 숫자 탭 state). 새 UI 는 `history.pushState` 기반의 가벼운 경로 분기를 `src/saas/router.js` 로 직접 만든다. 외부 라우터 추가 금지(부록 A 7절).
- 스타일: 옛 ERP 는 인라인 style + `ThemeCtx`(다크). 전역 `src/index.css` 가 body 배경을 어두운 색으로 고정하므로, 새 UI 루트에서 `data-saas` 같은 속성으로 body 배경·글꼴을 덮어쓴다. **index.css 의 기존 규칙은 지우지 않는다.**
- 디자인 토큰: `src/saas/tokens.css` 에 CSS 변수로. 글꼴 Pretendard 는 `index.html` 에 링크 추가(옛 화면은 Noto 를 그대로 씀).
- 데이터: `src/lib/db.js`(Supabase 호출 전부) + `src/lib/*.js`(판정 로직, 테스트 있음). 모든 표는 `user_id` 로 회사를 가른다(테넌트 = 로그인한 회사 계정 하나).
- 역할: `managers` 표 `is_admin`, `is_packer`. 현재 작업자는 localStorage `erp_manager`(이름). 관리자 판정은 `managers.find(m => m.name === activeManager)?.isAdmin`.
- 실시간: `src/lib/realtime.js` 가 orders 변경을 구독한다. 새 UI 도 같은 구독을 쓰면 여러 기기 간 숫자가 맞는다.

## 3. 기존 기능 분류와 5메뉴 배치

### A. 반드시 들어갈 것 (업계 공통)

| 새 메뉴 | 들어갈 기능 | 옛 코드(참고용) |
|---|---|---|
| 홈 | 요약 지표 4개, 빠른 실행 3개, **지금 처리할 일 = 전체현황 9구역**, 이번 주 출고 차트, 최근 주문 | OverviewTab.jsx, lib/overview.js |
| 주문 관리 | **카톡·밴드 글 붙여넣기 → AI 분석 → 주문 등록**(가장 중요한 차별점, 시안에 없어도 반드시 넣는다), 주문 목록·검색·필터, 주문 상세·수정, 상태(접수→포장완료→출고완료), 보관·보류 표시, 송장 엑셀 출력, 반품·교환 | OrderInput.jsx, ErpApp.jsx 주문현황, InvoicePanel.jsx, ReturnsTab.jsx |
| 재고 관리 | 품번별 롤 목록, 잔량, **최대 재단 가능 길이**, 입고 등록, 조정·폐기 이력 | RollStockTab.jsx, InspectionTab.jsx, lib/rollStock.js |
| 거래처 | 고객 목록·검색, 전화번호 기준 식별, 주소, 주문 이력, 적립금·배송권 잔액 | CustomerTab.jsx |
| 정산 | 미입금 목록, 입금 처리, 적립금 등록·사용, 환불 신청·처리, 거래명세서 출력 | DepositTab.jsx, StatementTab.jsx |

### B. 1차에는 "켜짐" 고정으로 넣되 설정으로 뺄 것 (2차)

합배송 묶음, 공개 주문 링크, QR 롤 라벨·포장대 스캔, 무료배송권, 감사 라벨, 배송 메시지 프리셋, 주문 메모 채팅.

### C. 새 UI 에 넣지 않을 것 (회사 전용)

라벨 담당 PC 출력 요청 구조, 품번 담당자 이니셜(A/S/W/H/L), 비움마켓 소셜 로그인, 공유 4자리 비밀번호 UI(인증 자체는 그대로 씀), 포장팀 화면 키보드.

## 4. 화면별 데이터 연결 계약

새 UI 는 아래 함수만 부른다. 여기 없는 Supabase 직접 호출은 만들지 않는다. 필요한 함수가 없으면 `db.js` 에 **추가만** 하고(기존 함수 수정 금지) 그 사실을 보고한다.

**공통 읽기**
- 주문(활성 건만): `db.fetchOrders()` — 출고완료는 안 들어온다. 출고완료·과거 주문은 `db.fetchShippedOrders`, `db.fetchCompletedOrders`, `db.searchShippedOrders`.
- 고객 `db.fetchCustomers()`, 담당자 `db.fetchManagers()`, 품번 `db.fetchProducts()`, 롤 `db.fetchRolls()`, 설정 `db.fetchSettings()`.
- 주문별 돈 계산: `db.calcOrderMoney(order, paymentLogs, credits)` 또는 `db.fetchOrdersWithMoney()`.
- 결제 상태 판정은 **반드시** `constants.getPayStatus(o)`. 보관 `isHold(o)`, 보류 `isParked(o)`.
- 택배사 판정 `lib/courier.js` `courierOf`, `autoCourier`. 출고예정일 `lib/shipDate.js` `defaultShipDate`, `shipBucket`.

**홈**
- 지금 처리할 일: `buildOverview(orders, shippedMates, { isHold, isParked, getPayStatus, courierOf, isPickup })` (lib/overview.js). `shippedMates` 는 `db.fetchShippedGroupMates(groupIds)`. 옛 코드 OverviewTab.jsx 의 호출을 그대로 따라 한다. "전체 / 내 담당" 범위 토글도 그대로 가져온다(2026-10-19 추가, localStorage `erp_overview_scope`).
- 최근 주문: `fetchOrders()` 를 created_at 내림차순 상위 N.
- 이번 주 출고 차트: `db.fetchShippedOrders` 의 `shippedAt` 을 날짜별로 센다.

**주문 관리**
- AI 분석: `constants.aiParseText(text)` / `aiParseImage` → 서버 `api/analyze.js`. 결과를 폼에 채우고 고객 매칭(`db.findCustomersFresh`, 동명이인·같은 번호 확인창은 옛 OrderInput 의 CustomerMatchPopup 흐름을 따른다).
- 등록: `db.insertOrder(order)`. 품목 id 는 `db.ensureItemIds`. 금액 검증 `lib/validation.validateAndCorrectAmounts`. 품번 연결 `lib/productCodes.attachProductCodes`.
- 수정: `db.updateOrder(id, patch)`. 상태 변경 전 **담당자 잠금** `lib/managerLock.checkOrderLock(order, activeManager, managers, orders)` 을 반드시 거친다(옛 ErpApp 3240행 부근의 버튼 로직 참고).
- 출고완료: `db.claimShipOut` 을 직접 부르지 말고 옛 ErpApp 의 `shipOneOrder` 가 하는 일(입금 확인 → claim → 재고 차감 → 로그)을 **그대로 옮긴 함수**를 `src/saas/actions/ship.js` 에 만든다. 입금 미확인이면 막는다.
- 합배송: 새 묶음·해제는 `db.setMergeGroup` / `db.clearMergeGroup` 뒤에 반드시 `db.afterGroupChange`(settleGroup) 를 부른다. `lib/freight.js` 의 `recomputeGroupFreight`, `previewFreightOverlap` 참고.
- 보류(parked): **묶음 단위**로 넣고 뺀다. 넣을 때 사유 필수. 뺄 때 `shipDate` 를 오늘로, `shipDatePulled: true`. 옛 PackingTab.jsx 의 `park`/`unpark` 를 그대로 옮긴다.
- 송장 엑셀: 옛 InvoicePanel.jsx 의 `onExport` 경로. 출력 후 `db.markInvoicePrinted`.
- 반품: `db.insertReturn`, `db.updateReturn`, 반품 입고 시 `db.restockReturnedItem`.

**재고 관리**
- 목록: `fetchProducts` + `fetchRolls` → `lib/rollStock.groupRollsByProduct`, `summarizeRolls`(롤 수·잔량 합·최대 재단 가능).
- 입고: `db.receiveRolls` (품번 없으면 `db.insertProduct` 먼저). 롤 번호는 `lib/rollStock.nextRollCodes`.
- 조정·폐기: `db.adjustRoll`, `db.scrapRoll` (서버 함수, 이력 자동). 잔량을 `updateRoll` 로 직접 고치지 않는다.
- 이력: `db.fetchRollMovements`.

**거래처**
- `fetchCustomers`, `db.insertCustomer`, `db.updateCustomer`, `db.deleteCustomer`. 적립금 `db.getCustomerCredit`, 배송권 `db.getCustomerFreeShipping`. 전화번호 가운데 4자리 마스킹은 `constants.maskPhone`.

**정산**
- 미입금 목록: `db.fetchUnpaidOrders` 또는 `fetchOrders` 를 `getPayStatus` 로 거른다.
- 입금 처리: `db.addPaymentLog` + `db.updateOrder(payment)`. 옛 DepositTab 의 "입금 처리" 흐름을 그대로 옮긴다.
- 적립금: `db.insertCredit`, `db.applyOrderCredit`, `db.cancelOrderCredit`.
- 환불: `db.archiveRefundRequest` 와 옛 RefundRequestModal 흐름.
- 거래명세서: `lib/statementHwpx.js`.

## 5. 지표 정의 (시안의 숫자 칸에 넣을 실제 값)

| 칸 | 정의 |
|---|---|
| 오늘 들어온 주문 | 활성 주문 중 `createdAt` 이 오늘(로컬 날짜)인 건수 |
| 출고 대기 | 활성 주문 중 `status !== "출고완료"` 이고 보관·보류가 아닌 건수 |
| 총 재고 | 품번 수 와 **판매 가능 롤 잔량 합(마)** 두 줄로. 롤 단위라 "수량"이 아니라 "마"로 표기 |
| 이번 달 매출 | 이번 달 `payment_logs` 의 입금 로그 금액 합(입금 기준, 주문 금액 기준이 아님) |
| 총 원단 품목 | `products` 수 |
| 총 재고 수량 | 판매 가능 롤 잔량 합(마) |
| 부족한 원단 | 품번별 **최대 재단 가능 길이** < `config.LOW_STOCK_M` (기본 10마) |
| 품절 | 판매 가능 롤이 0인 품번 |
| 이번 달 판매 | 이번 달 출고완료 주문의 품목 수량 합(마) |
| 재고량 표시 바 | 품번별 잔량 합 ÷ 그 품번 입고 총 길이 |
| 혼용률 | **데이터 없음.** 칸은 두되 비어 있으면 "—". 임의 값 금지 |
| 보관 위치 | `stock_rolls.location` (입고 때 적은 글자). 없으면 "—" |

## 6. 지켜야 할 업무 규칙 (디자인보다 우선)

1. 입금 확인 전에는 출고완료가 되지 않는다. "출고 처리" 빠른 실행 버튼은 포장완료 → 송장 → 출고완료 3단계를 보여주는 화면으로 간다. 버튼 하나로 출고완료를 찍지 않는다.
2. 다른 담당자의 주문은 잠긴다(관리자 제외). 모든 상태 변경 전에 `checkOrderLock`.
3. 합배송 묶음은 한 박스다. 보류·보관·출고는 묶음 단위. 묶음 변경 뒤 `afterGroupChange`.
4. 롤 잔량은 서버 함수(adjust/scrap/pack)로만 바뀐다.
5. 출고완료·출고취소는 관리자만.
6. 결제 상태는 저장된 `payment` 글자가 아니라 `getPayStatus` 로 계산한다(부분환불·적립금 사용 때문).
7. 활성 주문 목록에는 출고완료가 없다. 출고완료 건이 필요한 화면은 따로 읽는다.

## 7. 작업 순서

1. `design-reference/` 확인. 없으면 중단하고 요청.
2. 시안 HTML 전체 분석 → 컴포넌트·토큰·애니메이션 목록을 `docs/saas-ui-analysis.md` 로 남긴다.
3. `src/saas/` 골격: tokens.css, router.js, config.js, AppLayout·Sidebar·MobileNavigation·Header·StatCard·QuickAction·Button·Modal·Toast·SearchInput·StatusBadge.
4. main.jsx 에 `/app` 분기 추가. 옛 ERP 가 그대로 뜨는지 먼저 확인.
5. 홈(PC → 모바일) — **더미가 아니라 바로 4절 계약으로 실데이터 연결.** 화면 하나를 끝낼 때마다 연결까지 끝낸다.
6. 재고 관리(PC → 모바일).
7. 주문 관리 → 거래처 → 정산.
8. 애니메이션·인터랙션(부록 A 6절), `prefers-reduced-motion`.
9. 1440 / 768 / 390 / 360 에서 확인. 브라우저 자동화가 있으면 시안 PNG 와 같은 해상도로 비교.
10. `npm run build`, `npm test` 통과. 옛 ERP(`/`)·공개 페이지(`/o`, `/r`)가 그대로인지 확인.

## 8. 하지 말 것

- 옛 ERP 컴포넌트 수정, db.js 기존 함수 수정, 마이그레이션 추가(필요하면 사용자 승인 후).
- 인증·권한·테넌트 구조 변경. 새 Supabase 표 생성.
- 외부 UI 라이브러리·라우터·상태 관리 라이브러리 추가.
- 시안 더미 데이터를 실제 데이터처럼 표시. 연결 못 한 칸은 "—" 와 함께 보고.
- 이 폴더에서 배포.
- 본문 6절의 규칙을 시안에 없다는 이유로 빼기.

## 9. 최종 보고 항목

부록 A 10절 그대로. 추가로 **4절 계약 중 새로 만든 db 함수 목록**과 **5절 지표 중 실데이터로 못 채운 칸**을 따로 적는다.

---

## 부록 A. 디자인 지시서 원문 (사용자 제공, 2026-10-19)

# ERP SaaS UI 리디자인 및 구현 지시서

## 1. 역할과 목표

너는 SaaS 제품을 전문으로 설계하는 Senior UI/UX Designer이자 Senior Frontend Engineer다.

현재 ERP를 토스(Toss)처럼 깔끔하고 직관적이면서도 부드러운 인상의 SaaS ERP로 리디자인하려고 한다.

이미 완성된 UI 프로토타입이 존재하며, 이번 작업의 목표는 새로운 디자인을 창작하는 것이 아니라 **제공된 디자인을 최대한 정확하게 재현하고 실제 프로젝트의 UI로 구현하는 것**이다.

특히 ERP 사용자 중 중장년층이 있으므로 일반 SaaS보다 큰 글씨, 명확한 정보 구조, 넓은 클릭 영역, 편안한 사용 경험을 제공해야 한다.

PC와 모바일 모두 지원하며 각 버튼의 인터랙션과 화면 전환 애니메이션까지 구현한다.

## 2. 디자인 원본 — 최우선 기준

프로젝트 내 `design-reference/` 폴더의 다음 파일을 확인한다.

- `erp_saas_ui_prototype.html` — 최우선 기준. HTML, CSS, JavaScript, UI 인터랙션 포함.
- `erp_saas_desktop.png` — PC 메인 대시보드 기준.
- `erp_saas_mobile.png` — 모바일 메인 대시보드 기준.
- `erp_saas_inventory_desktop.png` — PC 재고 관리 기준.
- `erp_saas_inventory_mobile.png` — 모바일 재고 관리 기준.

작업을 시작하기 전에 HTML 원본을 전체 분석하고, 화면 구성, 레이아웃, 스타일, 컴포넌트, 애니메이션, 인터랙션을 파악한다.

**우선순위: 원본 HTML/CSS/JS → 스크린샷 → 아래 세부 지시사항**

원본에 이미 존재하는 스타일을 임의로 바꾸거나 새롭게 해석하지 않는다.

스크린샷과 구현 결과를 비교해 시각적 차이를 최소화한다.

단, 원본의 상단 PC/모바일 전환 도구, 외부 미리보기 배경, 디바이스 테두리와 안내 문구는 디자인 시연용 요소이므로 실제 ERP 애플리케이션에는 포함하지 않는다.

## 3. 핵심 디자인 시스템

### 색상

원본 CSS의 컬러 시스템을 우선 사용한다.

- Primary Blue: `#3678F6`
- Primary Dark: `#245ED0`
- Primary Soft: `#EEF4FF`
- Background: `#F5F7FB`
- Surface: `#FFFFFF`
- Text Primary: `#202C3D`
- Text Secondary: `#64748B`
- Border: `#E7ECF3`
- Success: `#178B68`
- Warning: `#F5A440`
- Error: `#E56A63`

과도하게 채도가 높은 색상이나 강한 그림자를 사용하지 않는다.

### 형태

- 둥근 카드와 버튼
- 넉넉한 내부 여백
- 부드럽고 약한 그림자
- 얇고 은은한 테두리
- 정보 사이의 명확한 간격
- 단정한 아이콘
- 딱딱한 기업용 ERP 인상이 아닌 친근한 금융 SaaS 디자인

카드 모서리는 원본 기준 약 20~21px, 버튼은 약 13px을 사용한다.

### 타이포그래피

Pretendard를 우선 사용한다.

- 페이지 제목: 30~32px / Bold
- 주요 수치: 28~32px / Bold
- 카드 제목: 18~20px / Semibold 또는 Bold
- 일반 본문: 16~18px
- 사이드 메뉴: 17px
- 보조 설명: 14~15px

중장년층의 가독성을 중요하게 취급한다.

의미 있는 본문을 12px 이하로 줄이지 않는다.

글씨 크기를 확보하면서 정보 밀도가 지나치게 낮아지지 않도록 균형을 유지한다.

브라우저 125~150% 확대에서도 주요 기능을 사용할 수 있어야 한다.

## 4. PC 화면 구성

원본과 동일한 정보 구조를 구현한다.

### 전체 레이아웃

왼쪽 고정 사이드바 + 상단 헤더 + 메인 콘텐츠 영역.

사이드바는 원본 기준 약 246px.

사이드바 메뉴:
1. 홈
2. 주문 관리
3. 재고 관리
4. 거래처
5. 정산

선택된 메뉴는 연한 파란색 배경과 진한 파란색 아이콘/글씨로 표시한다.

호버할 때 배경이 부드럽게 변화하고, 선택 시 시각적인 피드백을 제공한다.

### 홈 대시보드

상단에 인사말과 설명을 배치한다.

요약 지표 카드 4개:
- 오늘 들어온 주문
- 출고 대기
- 총 재고
- 이번 달 매출

빠른 실행 영역:
- 주문 등록
- 입고 등록
- 출고 처리

하단:
- 지금 처리할 일
- 이번 주 출고 현황 차트
- 최근 주문 테이블

각 구성요소의 크기, 여백, 위치는 제공된 HTML 및 스크린샷을 기준으로 한다.

### 재고 관리

상단 지표 카드 4개:
- 총 원단 품목
- 총 재고 수량
- 부족한 원단
- 이번 달 판매

재고 검색 입력창 및 재고 등록 버튼.

재고 필터:
- 전체
- 재고 부족
- 품절

재고 목록은 원본처럼 원단 텍스처, 원단명, 혼용률, 재고 수량, 보관 위치, 상태, 재고량 표시 바가 있는 카드형 UI로 만든다.

### 나머지 화면

원본 HTML에 구현된 주문 관리, 거래처, 정산 화면도 동일한 디자인 언어로 재현한다.

새로운 화면 디자인을 자의적으로 추가하기 전에 원본을 최대한 활용한다.

## 5. 모바일 반응형 디자인

PC 화면을 단순히 줄여서 표시하는 방식은 금지한다.

모바일은 별도로 최적화된 레이아웃을 제공해야 한다.

### 모바일 구성

- 왼쪽 사이드바 제거
- 상단 브랜드 및 알림 영역
- 요약 카드 2열 배치
- 빠른 실행 버튼
- 콘텐츠는 세로 스크롤
- 하단 고정 내비게이션 제공

하단 메뉴:
홈 / 주문 / 재고 / 거래처 / 정산

하단 메뉴는 아이콘과 텍스트를 함께 사용한다.

현재 메뉴는 파란색으로 명확하게 강조한다.

하단 고정 메뉴가 콘텐츠나 주요 버튼을 가리지 않도록 안전 영역과 여백을 처리한다.

재고 관리 페이지는 검색 및 재고 등록 버튼을 보기 쉽게 배치하고, 모바일 화면에 맞는 원단 카드 레이아웃으로 구성한다.

모바일 주요 터치 영역은 최소 44×44px, 가능한 경우 높이 48px 이상으로 만든다.

360px, 390px, 430px 너비 및 태블릿 크기에서 정상 동작해야 한다.

## 6. 애니메이션과 인터랙션

디자인의 중요한 부분이다.

단순히 화면을 정적으로 구현하지 말 것.

원본 HTML에 있는 효과를 우선 재현한다.

### 버튼

- Hover: 배경 변화, 미세한 상승 효과
- Active: 약 0.97배의 자연스러운 눌림 효과
- Click: 원본의 Ripple 효과
- Disabled: 클릭 불가능한 상태가 명확하게 보이도록 표현
- Loading: 중복 클릭 방지와 처리 중 표시

### 화면 이동

- 콘텐츠의 부드러운 등장
- 메뉴 선택 상태 변경
- 자연스러운 스크롤 처리
- 불필요하게 과장된 화면 전환 금지

### 카드

- Hover 시 매우 약한 상승
- 그림자와 배경의 부드러운 변화
- 클릭 가능한 카드에는 명확한 상호작용 표시

### 모달

- 부드러운 등장/종료 애니메이션
- 모달 바깥 클릭 시 닫기
- Escape 키로 닫기
- 모바일에서 화면 너비에 맞게 표시
- 키보드 포커스 처리

### Toast 알림

- 등록, 저장, 상태 변경 등의 작업 결과를 짧고 부드럽게 표시
- 성공/실패 메시지 구분
- 자동으로 사라지는 애니메이션

애니메이션은 대체로 150~250ms 내외를 사용하되 원본 값이 있으면 그것을 우선한다.

`prefers-reduced-motion` 설정도 지원한다.

## 7. 프로젝트 적용 방식

먼저 현재 프로젝트 구조를 확인한다.

- 사용 중인 프레임워크
- 라우팅 방식
- 기존 UI 컴포넌트
- 스타일 시스템
- 인증 및 권한 구조
- 주문/재고/거래처/정산 관련 페이지
- API 및 데이터 연결
- 빌드 및 테스트 명령어

기존 프로젝트의 기술 스택을 최대한 활용하고, 불필요하게 새로운 프레임워크를 도입하지 않는다.

반복되는 UI는 재사용 가능한 컴포넌트로 분리한다.

예:
- AppLayout
- Sidebar
- MobileNavigation
- Header
- StatCard
- QuickAction
- OrderTable
- InventoryCard
- StatusBadge
- Modal
- Toast
- Button
- SearchInput

디자인 토큰을 중앙에서 관리하고, PC와 모바일이 동일한 데이터 및 핵심 비즈니스 로직을 공유하게 한다.

### 기존 ERP 기능 보호

현재 ERP의 DB, API, 인증, 권한, 주문 처리, 재고 처리, 정산 로직을 임의로 변경하지 않는다.

UI 리디자인으로 기존 기능이 훼손되지 않도록 한다.

기존 데이터 연동이 있는 경우 실제 데이터를 사용한다.

원본 HTML의 샘플 숫자와 더미 데이터는 디자인 검증용일 뿐 실제 운영 데이터로 대체해서는 안 된다.

실제 데이터 연결이 어려운 부분은 명확하게 구분하고, 임의의 데이터를 운영 정보처럼 표시하지 않는다.

새로운 SaaS 멀티테넌트 인증/DB 구조를 이번 UI 작업에 임의로 추가하지 않는다.

기존에 멀티테넌트 구조가 있다면 조직별 데이터 분리와 권한을 그대로 보존한다.

## 8. 작업 순서

1. 프로젝트와 디자인 원본 분석
2. 변경 범위 및 영향을 받는 파일 파악
3. 기존 Git 작업 상태 확인 및 안전한 작업 브랜치 사용
4. 디자인 토큰과 공통 컴포넌트 구현
5. PC 대시보드 구현
6. 모바일 대시보드 구현
7. 재고 관리 PC/모바일 구현
8. 주문 관리/거래처/정산 구현
9. 애니메이션 및 인터랙션 구현
10. 기존 ERP 기능과 연결
11. 반응형/접근성/오류 상태 검증
12. 최종 빌드 및 테스트

가능하다면 원본 HTML과 구현 화면을 실제 브라우저에서 동일한 해상도로 렌더링해 비교한다.

확인 기준:
- PC: 1440px
- 태블릿: 768px
- 모바일: 390px, 360px

브라우저 스크린샷 비교가 가능하면 레이아웃, 색상, 글씨 크기, 여백, 카드 크기를 원본과 비교하며 수정한다.

자동화 도구가 없다면 도구 없이도 가능한 검증을 수행하고 확인하지 못한 항목은 구분해 보고한다.

## 9. 완료 기준

다음 조건을 만족해야 완료로 판단한다.

- 원본 디자인과 높은 시각적 일치도
- PC/모바일 모두 정상 렌더링
- 5개 메뉴의 화면 이동 정상
- 주요 버튼, 검색, 필터, 모달 정상
- 애니메이션 및 클릭 피드백 구현
- 기존 ERP 데이터와 기능 보존
- 가로 오버플로와 레이아웃 깨짐 없음
- 브라우저 콘솔의 새로운 오류 없음
- 가능한 범위의 테스트와 빌드 통과

## 10. 최종 보고

작업 완료 후 다음 사항을 알려준다.

1. 구현 완료한 페이지와 기능
2. 생성하거나 변경한 파일
3. 원본과 차이가 발생한 부분 및 이유
4. 실제 데이터 연동 여부
5. 테스트/빌드 결과
6. 남은 작업 및 발견한 위험
7. 로컬에서 결과를 확인하는 방법

**중요: 이번 작업은 새로운 ERP 디자인을 제안하는 작업이 아니다. 제공된 UI 시안을 실제 코드로 최대한 충실하게 구현하는 작업이다.**

디자인을 임의로 단순화하거나 기존 원본과 다른 스타일로 재창작하지 않는다.

분석 후 실행 가능한 작업부터 직접 진행한다. 단, 기존 데이터를 파괴하거나 보안·권한 구조를 변경하는 작업, 되돌리기 어려운 변경은 수행 전에 승인받는다.
