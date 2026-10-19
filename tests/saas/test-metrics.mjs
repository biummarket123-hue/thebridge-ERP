// 새 UI 지표 계산(src/saas/lib/metrics.js, 지시서 5절). DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const m = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/metrics.js")).href);
const cm = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/customerMatch.js")).href);
const router = await import(pathToFileURL(path.join(ROOT, "src/saas/router.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const now = new Date(2026, 9, 19, 14, 0);   // 2026-10-19(월) 14:00
const iso = (d) => new Date(d).toISOString();
const H = { isHold: (o) => !!o.isHolding || o.status === "보관", isParked: (o) => !!o.isParked, getPayStatus: (o) => o.payment === "환불신청" ? "환불신청" : (o._computed?.paymentStatus || o.payment || "미입금") };

// ── 주문 지표 ──
const orders = [
  { id: "a", status: "접수", payment: "미입금", createdAt: iso(new Date(2026, 9, 19, 9)), items: [{ qty: 3, unit: "마", amount: 15000 }], shippingFee: 4000, _computed: { paymentStatus: "미입금", balanceAmount: 19000, depositAmount: 0 } },
  { id: "b", status: "포장완료", payment: "입금완료", createdAt: iso(new Date(2026, 9, 18, 16)), items: [{ qty: 1, unit: "세트", amount: 30000 }], totalAmount: 34000, _computed: { paymentStatus: "입금완료", balanceAmount: 0, depositAmount: 34000 } },
  { id: "c", status: "접수", payment: "미입금", isHolding: true, createdAt: iso(new Date(2026, 9, 19, 11)), items: [], _computed: { paymentStatus: "부분입금", balanceAmount: 5000, depositAmount: 5000 } },
  { id: "d", status: "접수", payment: "미입금", isParked: true, createdAt: iso(new Date(2026, 9, 1)), items: [] },
  { id: "e", status: "출고완료", payment: "환불신청", createdAt: iso(new Date(2026, 9, 10)), items: [] },
  { id: "f", status: "접수", payment: "환불", createdAt: iso(new Date(2026, 9, 19, 12)), items: [] },
];
const st = m.orderStats(orders, H, now);
check("오늘 들어온 주문: 활성 건만(환불 종결 f 제외) → a, c", st.todayCount === 2, `got ${st.todayCount}`);
check("어제 주문: b", st.yesterdayCount === 1);
check("출고 대기: 보관(c)·보류(d)·출고완료(e)·환불(f) 빼고 → a, b", st.shipWaiting === 2, `got ${st.shipWaiting}`);
check("포장완료 1 · 보관 1 · 보류 1", st.packed === 1 && st.held === 1 && st.parked === 1);
check("미입금 건수(a·c·보류 d)·미수금 합: a(19000)+c(5000)", st.unpaidCount === 3 && st.unpaidSum === 24000, `${st.unpaidCount}/${st.unpaidSum}`);
check("환불 신청 1건(출고완료여도 센다)", st.refundRequested === 1);
check("주문 금액: 전체금액 없으면 품목합+배송비", m.orderTotal(orders[0]) === 19000 && m.orderTotal(orders[1]) === 34000);

// ── 입금 로그 ──
const logs = [
  { type: "입금", amount: 10000, created_at: iso(new Date(2026, 9, 2)) },
  { type: "입금", amount: 5000, created_at: iso(new Date(2026, 9, 19, 13)) },
  { type: "적립금차감", amount: 3000, created_at: iso(new Date(2026, 9, 5)) },   // 돈이 들어온 게 아니다
  { type: "입금", amount: 7000, created_at: iso(new Date(2026, 8, 30)) },         // 지난달
  { type: "현금환불", amount: 2000, created_at: iso(new Date(2026, 9, 6)) },
];
const r = m.monthRange(now);
const dep = m.depositSum(logs, r.start, r.end);
check("이번 달 매출 = '입금' 로그만 합산(적립금차감·환불 제외)", dep.sum === 15000 && dep.count === 2, `${dep.sum}/${dep.count}`);
const months = m.monthlyDeposits(logs, now, 6);
check("월별 6개 막대, 마지막이 이번 달(선택됨)", months.length === 6 && months[5].key === "2026-10" && months[5].selected && months[5].value === 15000);
check("지난달 막대 7000", months[4].value === 7000);

// ── 이번 주 출고 ──
const shipped = [
  { id: "s1", shippedAt: iso(new Date(2026, 9, 19, 10)), items: [{ qty: 5, unit: "마" }] },
  { id: "s2", shippedAt: iso(new Date(2026, 9, 19, 16)), items: [{ qty: 2, unit: "마" }, { qty: 1, unit: "세트" }] },
  { id: "s3", shippedAt: iso(new Date(2026, 9, 12)), items: [{ qty: 10, unit: "마" }] },   // 지난주 월
  { id: "s4", shippedAt: iso(new Date(2026, 8, 28)), items: [{ qty: 99, unit: "마" }] },   // 지난달
];
const wk = m.weeklyShipped(shipped, now);
check("이번 주(월~일) 막대 7개, 월요일 2건, 합 2", wk.bars.length === 7 && wk.bars[0].label === "월" && wk.bars[0].value === 2 && wk.total === 2);
check("오늘 막대가 선택됨", wk.bars[0].selected === true && wk.bars[1].selected === false);
check("지난주 같은 기간(월까지) 1건", m.lastWeekShippedToDate(shipped, now) === 1);
check("이번 달 판매(마): 5+2+10 = 17 (세트 제외, 지난달 제외)", m.monthShippedLength(shipped, now) === 17, `got ${m.monthShippedLength(shipped, now)}`);

// ── 재고 ──
const groups = [
  { product: { id: 1 }, availableCount: 2, totalRemaining: 30, maxRemaining: 20, rolls: [{ lengthReceived: 25, status: "available" }, { lengthReceived: 15, status: "available", location: "A-01" }] },
  { product: { id: 2 }, availableCount: 1, totalRemaining: 6, maxRemaining: 6, rolls: [{ lengthReceived: 30, status: "available", location: "B-02" }] },
  { product: { id: 3 }, availableCount: 0, totalRemaining: 0, maxRemaining: 0, rolls: [{ lengthReceived: 40, status: "sold" }] },
];
const ss = m.stockStats([{}, {}, {}, {}], groups, 10);
check("품번 수 4(롤 없는 품번 포함) · 잔량 합 36 · 부족 1 · 품절 1", ss.productCount === 4 && ss.totalRemaining === 36 && ss.low === 1 && ss.out === 1, JSON.stringify(ss));
check("상태 판정: ok / low / out", m.stockStatus(groups[0], 10) === "ok" && m.stockStatus(groups[1], 10) === "low" && m.stockStatus(groups[2], 10) === "out");
check("재고량 바 = 잔량합 ÷ 입고 총길이 (30/40)", m.stockRatio(groups[0]) === 0.75);
check("보관 위치: 판매 가능 롤의 위치만", m.stockLocations(groups[0]) === "A-01" && m.stockLocations(groups[2]) === "");

// ── 거래처 ──
const customers = [{ id: 1, name: "김영희", phone: "010-1234-5678" }, { id: 2, name: "김영희", phone: "010-9999-5678" }, { id: 3, name: "박철수", phone: "" }];
const cOrders = [
  { id: "o1", customer: "김영희", phone: "01012345678", createdAt: iso(new Date(2026, 9, 3)), status: "접수", payment: "미입금", items: [{ amount: 10000 }], _computed: { balanceAmount: 10000, paymentStatus: "미입금" } },
  { id: "o2", customer: "김영희", phone: "010-9999-5678", createdAt: iso(new Date(2026, 8, 3)), status: "출고완료", payment: "입금완료", items: [{ amount: 20000 }] },
  { id: "o3", customer: "박철수", phone: "", date: "2026. 10. 05.", status: "출고완료", payment: "입금완료" },
];
const cs = m.customerStats(customers, cOrders, now);
check("동명이인은 전화번호로 가른다: 1번 김영희 1건, 2번 김영희 1건", cs.get(1).count === 1 && cs.get(2).count === 1 && cs.get(1).orders[0].id === "o1");
check("이번 달 거래 금액·미수금", cs.get(1).monthSum === 10000 && cs.get(1).unpaid === 10000 && cs.get(2).monthSum === 0);
check("번호 없는 고객은 이름으로 — 날짜만 있는 옛 주문도 센다", cs.get(3).count === 1 && cs.get(3).lastAt === "2026-10-05");
check("지역 = 주소 앞 두 어절", m.regionOf("서울 동대문구 답십리로 100") === "서울 동대문구");
check("접수일 표기: 오늘/어제", m.relativeWhen(iso(new Date(2026, 9, 19, 9, 24)), now) === "오늘 09:24" && m.relativeWhen(iso(new Date(2026, 9, 18, 16, 20)), now) === "어제 16:20");

// ── 고객 매칭(옛 OrderInput 과 같은 규칙) ──
const custs = [{ id: 1, name: "홍길동", phone: "010-3914-5678", nickname: "방방방", address: "서울 중구" }, { id: 2, name: "홍길동", phone: "", nickname: "", address: "" }];
check("이름+중간번호 → 확정", cm.matchCustomer({ customerName: "홍길동", customerMidPhone: "3914" }, custs).type === "confirmed");
check("이름만 → 동명이인 목록", cm.matchCustomer({ customerName: "홍길동" }, custs).type === "name_list");
check("닉네임 충돌이면 그 고객 제외", cm.matchCustomer({ customerName: "홍길동", customerNickname: "다른닉" }, custs).match?.id === 2);
check("풀 번호가 다르면 번호 변경 감지", cm.matchCustomer({ customerName: "홍길동", phone: "010-3914-0000", customerNickname: "방방방" }, custs).type === "phone_changed");
check("아무 단서 없음 → 신규", cm.matchCustomer({}, custs).type === "new");

// ── 라우터 ──
check("경로 분기", router.parsePath("/app").menu === "home" && router.parsePath("/app/orders/abc").id === "abc" && router.parsePath("/app/stock/receive").id === "receive" && router.parsePath("/app/nothing").menu === "home");

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
