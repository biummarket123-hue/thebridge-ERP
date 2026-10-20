// 반품·교환 규칙 — 순수 계산만(DB·React 없음). Returns.jsx 가 쓰고 tests/saas/test-return-rules.mjs 가 검증한다.
//
// 돈 흐름(옛 ReturnsTab.ExchangeModal 과 같다):
//   차액 = 교환액 − 반품액
//   차액 > 0 → 원 주문 total_amount 에 가산(미수금으로 드러남). 적립금 잔액이 차액 이상이면 적립금으로 바로 차감 가능.
//   차액 < 0 → 고객에게 돌려줄 돈. 주문 상세의 환불 신청으로 잇는다.
//   완료 되돌리기 → 교환 기록을 지우고, 가산했던 차액(> 0)만큼 원 주문 금액을 다시 뺀다(0 아래로는 안 내려간다).

export const EXCHANGE_UNITS = ["마", "세트", "필", "롤", "kg"];

const int = (v) => parseInt(v) || 0;
const num = (v) => parseFloat(v) || 0;

/** 반품 품목 금액 합(반품액). items[].amount 는 등록 때 주문 금액을 수량 비율로 나눈 값. */
export function returnSum(items) {
  return (items || []).reduce((s, it) => s + int(it.amount), 0);
}

/** 모달 입력 줄 → 저장할 교환 품목. 원단명이 없거나 수량이 0 이하인 줄은 버린다. 금액 = 단가 × 수량(반올림). */
export function normalizeExchangeRows(rows) {
  return (rows || [])
    .map(rw => ({ fabric: String(rw.fabric || "").trim(), color: String(rw.color || "").trim(), qty: num(rw.qty), unit: rw.unit || "마", unitPrice: int(rw.unitPrice) }))
    .filter(rw => rw.fabric && rw.qty > 0)
    .map(rw => ({ itemNo: "", ...rw, amount: Math.round(rw.unitPrice * rw.qty) }));
}

/** 교환 품목 금액 합(교환액). */
export function exchangeSum(items) {
  return (items || []).reduce((s, it) => s + int(it.amount), 0);
}

/** 반품 품목 + 모달 입력 줄 → { items, retSum, exSum, diff }. 화면 표시와 저장이 같은 숫자를 쓰도록 한 곳에서 계산. */
export function calcExchange(returnItems, rows) {
  const items = normalizeExchangeRows(rows);
  const retSum = returnSum(returnItems);
  const exSum = exchangeSum(items);
  return { items, retSum, exSum, diff: exSum - retSum };
}

/** 고객 적립금 잔액 — 적립은 더하고 나머지(사용 등)는 뺀다. 다른 화면(OrderDetail·Settlement)과 같은 식. */
export function creditBalanceOf(credits, customer) {
  return (credits || []).filter(c => c.customer === customer).reduce((s, c) => s + (c.type === "적립" ? int(c.amount) : -int(c.amount)), 0);
}

/** 차액(> 0)을 적립금으로 바로 차감할 수 있나 — 잔액이 차액 이상일 때만. 차액이 0 이하면 차감할 것이 없다. */
export function canUseCredit(diff, creditBalance) {
  return diff > 0 && int(creditBalance) >= diff;
}

/** 주문의 현재 금액 — total_amount 가 없으면 품목 금액 합(옛 로직 그대로). */
export function orderBaseTotal(order) {
  if (!order) return 0;
  const t = Number(order.totalAmount) || 0;
  if (t > 0) return t;
  return (order.items || []).reduce((s, it) => s + int(it.amount), 0);
}

/** 교환 저장 때 원 주문의 새 금액. 차액이 0 이하면 바꿀 것이 없어 null. */
export function totalAfterExchange(order, diff) {
  if (!order || !(diff > 0)) return null;
  return orderBaseTotal(order) + diff;
}

/** 완료 되돌리기 때 원 주문의 새 금액 — 가산했던 차액을 뺀다. 차액이 없었거나(≤ 0) 주문이 없으면 null(건드리지 않음). */
export function totalAfterUndo(order, diff) {
  if (!order || !(diff > 0)) return null;
  return Math.max(0, orderBaseTotal(order) - diff);
}

/** 완료 되돌리기 확인 문구 — 교환 기록·가산분·환불 안내를 상황에 맞게. */
export function undoMessage(ret, order) {
  const hasEx = (ret?.exchangeItems || []).length > 0;
  const diff = ret?.exchangeDiff ?? 0;
  let msg = hasEx ? "교환 기록을 취소하고 '반품입고' 상태로 되돌릴까요?" : "이 반품 건을 '반품입고' 상태로 되돌릴까요?";
  if (hasEx && diff > 0) msg += order ? `\n(원 주문 금액에 가산됐던 ${diff.toLocaleString("ko-KR")}원도 차감됩니다)` : `\n(원 주문을 찾지 못해 가산됐던 ${diff.toLocaleString("ko-KR")}원은 수동 확인이 필요합니다)`;
  if (hasEx && diff < 0) msg += "\n(차액 환불 신청을 이미 했다면 정산에서 별도로 취소하세요)";
  return msg;
}

/** 차액 표기: "+3,000원" / "-2,000원" / "차액 없음". */
export function diffText(diff) {
  const d = Number(diff) || 0;
  if (d === 0) return "차액 없음";
  return `${d > 0 ? "+" : "-"}${Math.abs(d).toLocaleString("ko-KR")}원`;
}

/** 품목 한 줄 표기: "원단 색상 3마". */
export function itemLabel(it) {
  return `${it?.fabric || "?"}${it?.color ? ` ${it.color}` : ""} ${it?.qty ?? 0}${it?.unit || "마"}`;
}

/** 교환 품목 목록 표기: "A 빨강 2마, B 파랑 1세트". */
export function exchangeLabel(items) {
  return (items || []).map(itemLabel).join(", ");
}
