// 반품·교환 규칙(src/saas/lib/returnRules.js). DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const R = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/returnRules.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ── 반품액 ──
const retItems = [{ fabric: "린넨", color: "베이지", qty: 2, unit: "마", amount: 12000 }, { fabric: "면", qty: 1, unit: "세트", amount: "8000" }];
check("반품액 = 품목 amount 합(문자열도 숫자로)", R.returnSum(retItems) === 20000, `got ${R.returnSum(retItems)}`);
check("빈 반품 품목 → 0", R.returnSum([]) === 0 && R.returnSum(null) === 0);

// ── 교환 품목 정리 ──
const rows = [
  { fabric: " 옥스포드 ", color: "네이비", qty: "3", unit: "마", unitPrice: "5000" },
  { fabric: "", color: "x", qty: 5, unit: "마", unitPrice: 1000 },          // 원단명 없음 → 버림
  { fabric: "데님", color: "", qty: 0, unit: "마", unitPrice: 9000 },        // 수량 0 → 버림
  { fabric: "캔버스", color: "", qty: 1.5, unit: "마", unitPrice: 3000 },    // 1.5 × 3000 = 4500
];
const ex = R.normalizeExchangeRows(rows);
check("원단명 없는 줄·수량 0 줄은 버리고 2줄만", ex.length === 2, `got ${ex.length}`);
check("공백 다듬고 금액 = 단가×수량", ex[0].fabric === "옥스포드" && ex[0].amount === 15000 && ex[1].amount === 4500, JSON.stringify(ex));
check("itemNo 빈 값·단위 보존", ex[0].itemNo === "" && ex[0].unit === "마");

// ── 차액 ──
const c1 = R.calcExchange(retItems, rows);
check("차액 = 교환액 − 반품액 (19500 − 20000 = −500)", c1.retSum === 20000 && c1.exSum === 19500 && c1.diff === -500, JSON.stringify({ r: c1.retSum, e: c1.exSum, d: c1.diff }));
const c2 = R.calcExchange(retItems, [{ fabric: "A", qty: 5, unit: "마", unitPrice: 5000 }]);
check("교환액이 크면 양수 차액 (25000 − 20000 = +5000)", c2.diff === 5000);
const c3 = R.calcExchange(retItems, [{ fabric: "A", qty: 2, unit: "마", unitPrice: 10000 }]);
check("같으면 차액 0", c3.diff === 0);

// ── 적립금 ──
const credits = [
  { customer: "김영희", type: "적립", amount: 10000 },
  { customer: "김영희", type: "사용", amount: 3000 },
  { customer: "박철수", type: "적립", amount: 99999 },
];
check("적립금 잔액 = 적립 − 사용, 고객별", R.creditBalanceOf(credits, "김영희") === 7000 && R.creditBalanceOf(credits, "없는사람") === 0);
check("차액 ≤ 잔액이면 적립금 차감 가능", R.canUseCredit(5000, 7000) === true && R.canUseCredit(7000, 7000) === true);
check("잔액 부족·차액 0 이하면 불가", R.canUseCredit(8000, 7000) === false && R.canUseCredit(0, 7000) === false && R.canUseCredit(-500, 7000) === false);

// ── 원 주문 금액 ──
const orderA = { id: "a", totalAmount: 50000, items: [{ amount: 10000 }] };
const orderB = { id: "b", totalAmount: 0, items: [{ amount: 10000 }, { amount: 2500 }] };
check("주문 금액: total_amount 우선, 없으면 품목합", R.orderBaseTotal(orderA) === 50000 && R.orderBaseTotal(orderB) === 12500);
check("교환 저장: 차액 > 0 이면 가산, 아니면 null", R.totalAfterExchange(orderA, 5000) === 55000 && R.totalAfterExchange(orderA, -500) === null && R.totalAfterExchange(orderA, 0) === null);
check("되돌리기: 가산분 차감, 0 아래로 안 내려감", R.totalAfterUndo(orderA, 5000) === 45000 && R.totalAfterUndo(orderB, 20000) === 0);
check("되돌리기: 차액 없음·주문 없음 → null(건드리지 않음)", R.totalAfterUndo(orderA, -500) === null && R.totalAfterUndo(orderA, null) === null && R.totalAfterUndo(null, 5000) === null);

// ── 문구 ──
const retEx = { exchangeItems: [{ fabric: "A", qty: 1 }], exchangeDiff: 5000 };
check("되돌리기 문구: 교환 + 가산분 + 주문 있음", R.undoMessage(retEx, orderA).includes("교환 기록을 취소") && R.undoMessage(retEx, orderA).includes("5,000원도 차감"));
check("되돌리기 문구: 주문 못 찾음 → 수동 확인", R.undoMessage(retEx, null).includes("수동 확인"));
check("되돌리기 문구: 음수 차액 → 환불 취소 안내, 교환 없음 → 단순", R.undoMessage({ exchangeItems: [{}], exchangeDiff: -500 }, orderA).includes("정산에서 별도로 취소") && !R.undoMessage({ exchangeItems: [] }, orderA).includes("교환"));
check("차액 표기 +/−/없음", R.diffText(5000) === "+5,000원" && R.diffText(-500) === "-500원" && R.diffText(0) === "차액 없음");
check("교환 품목 표기", R.exchangeLabel([{ fabric: "A", color: "빨강", qty: 2, unit: "마" }, { fabric: "B", qty: 1, unit: "세트" }]) === "A 빨강 2마, B 1세트");

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
