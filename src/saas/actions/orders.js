// 주문 상태 변경·보관·보류·입금 확인·환불 신청 — 옛 ErpApp 주문현황 버튼(3240행 부근)·PackingTab.park/unpark·DepositTab 의 흐름을 옮긴 것.
// 모든 상태 변경 전에 checkOrderLock(업무 규칙 2). 보류는 묶음 단위(규칙 3).
import * as db from "../../lib/db.js";
import { checkOrderLock } from "../../lib/managerLock.js";
import { todayYmd } from "../../lib/shipDate.js";
import { itemsSummary } from "../lib/metrics.js";

/** 담당자 잠금 — 막히면 사유 문자열, 아니면 null */
export const lockOf = (order, ctx) => checkOrderLock(order, ctx.activeManager, ctx.managers, ctx.orders);

/** 묶음(함께 나갈 건, 출고완료 제외) */
export const groupOf = (order, orders) => order.mergeGroupId
  ? (orders || []).filter(x => x.mergeGroupId === order.mergeGroupId && x.status !== "출고완료")
  : [order];

/** 접수 ↔ 포장완료. 포장 시각·품목 지문을 같이 쓴다(옛 코드와 같다). */
export async function setStatus(order, status, ctx) {
  if (ctx.isPacker && !["접수", "포장완료"].includes(status)) throw new Error("포장 담당자는 이 상태로 바꿀 수 없습니다");
  if (!ctx.isPacker) { const lock = lockOf(order, ctx); if (lock) throw new Error(lock); }
  if (order.heldAt && (status === "접수" || status === "포장완료")) throw new Error("보관중입니다 — 보관을 해제한 뒤 변경해 주세요");
  const promote = order.status === "보관";
  const packFields = status === "포장완료"
    ? { packedAt: new Date().toISOString(), packedSig: db.itemsSig(order.items) }
    : (order.status === "포장완료" ? { packedAt: null, packedSig: null } : {});
  await db.updateOrder(order.id, { status, ...(promote ? { is_holding: true } : {}), ...packFields }, { route: "상태 변경 · 새 UI" });
  return { status, ...(promote ? { isHolding: true } : {}), ...packFields };
}

/** 보관 토글 — 켜는 건 '보관 요청'까지. 창고에 넣는 건 포장직원(옛 화면)이 held_at 을 찍는다. */
export async function toggleHold(order, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const held = !!order.isHolding || order.status === "보관";
  if (!held && order.shipRequestedAt) {
    await db.cancelShipOutRequest(groupOf(order, ctx.orders));
    return { msg: "출고요청을 취소했습니다 — 보관중으로 되돌림" };
  }
  const next = !held;
  const demote = !next && order.status === "보관";
  await db.updateOrder(order.id, { isHolding: next, ...(next ? {} : { heldAt: null }), ...(demote ? { status: "접수" } : {}) }, { route: "보관 · 새 UI" });
  return { msg: next ? "📦 보관 요청 — 포장직원이 창고에 넣으면 보관중이 됩니다" : "보관 해제" };
}

/** 출고요청 — 보관분을 포장팀에. 묶음째. */
export async function requestShipOut(order, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const group = groupOf(order, ctx.orders);
  await db.requestShipOut(group, ctx.activeManager || "");
  return { msg: group.length > 1 ? `🚚 출고요청 — ${order.customer} 외 합배송 ${group.length}건이 포장 당일 칸으로 갑니다` : `🚚 출고요청 — ${order.customer} · 포장 당일 칸으로 갑니다` };
}

/** 보류 — 묶음 단위, 사유 필수(옛 PackingTab.park). */
export async function park(order, reason, ctx) {
  const why = String(reason || "").trim();
  if (!why) throw new Error("보류 사유를 적어주세요 — 몇 달 뒤 꺼낼 때 이 한 줄이 유일한 단서입니다");
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const at = new Date().toISOString();
  const group = groupOf(order, ctx.orders);
  for (const o of group) await db.updateOrder(o.id, { isParked: true, parkedAt: at, parkReason: why }, { route: "보류 · 새 UI" });
  return { msg: `🗄️ 보류함으로 — ${order.customer}${group.length > 1 ? ` 외 ${group.length - 1}건` : ""}` };
}

/** 보류 해제 — 출고예정일을 오늘로(옛 PackingTab.unpark). */
export async function unpark(order, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const group = groupOf(order, ctx.orders);
  for (const o of group) await db.updateOrder(o.id, { isParked: false, parkedAt: null, parkReason: null, shipDate: todayYmd(), shipDatePulled: true }, { route: "보류 해제 · 새 UI" });
  return { msg: `보류 해제 — ${order.customer} · 출고예정일을 오늘로 맞췄습니다` };
}

/** 입금 처리 — 금액만큼 입금 로그, 완납이면 payment 를 입금완료로(옛 DepositTab.handlePay). amount 없으면 남은 미수금 전액. */
export async function addDeposit(order, amount, ctx) {
  if (ctx.isPacker) throw new Error("포장 담당자는 입금을 처리할 수 없습니다");
  const total = order.totalAmount > 0 ? order.totalAmount : (order.items || []).reduce((s, i) => s + (i.amount || 0), 0);
  const before = await db.fetchOrderLogs(order.id);
  const cur = db.calcOrderMoney(before, total, order.payment);
  const remaining = cur.balanceAmount;
  if (remaining <= 0) throw new Error("이미 완납된 주문입니다");
  const amt = amount ? parseInt(String(amount).replace(/[^0-9]/g, "")) || 0 : remaining;
  if (amt <= 0) throw new Error("금액을 입력해주세요");
  if (amt > remaining) throw new Error(`미수금(${remaining.toLocaleString()}원)을 초과할 수 없습니다`);
  await db.addPaymentLog(order.id, "입금", amt, `입금 ${amt.toLocaleString()}원`, order.customer);
  const logs = await db.fetchOrderLogs(order.id);
  const computed = db.calcOrderMoney(logs, total, order.payment);
  if (computed.paymentStatus === "입금완료") await db.updateOrder(order.id, { payment: "입금완료" }, { route: "입금 확인 · 새 UI" });
  return { amt, computed, msg: computed.paymentStatus === "입금완료" ? `${amt.toLocaleString()}원 입금 — 완납 처리됨` : `${amt.toLocaleString()}원 입금 처리` };
}

/** 적립금 차감 — db.applyOrderCredit 하나로(한도는 함수 안에서 깎는다). */
export async function useCredit(order, amount, ctx) {
  if (ctx.isPacker) throw new Error("포장 담당자는 입금을 처리할 수 없습니다");
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const total = order.totalAmount > 0 ? order.totalAmount : (order.items || []).reduce((s, i) => s + (i.amount || 0), 0);
  const want = parseInt(String(amount).replace(/[^0-9]/g, "")) || 0;
  if (want <= 0) throw new Error("금액을 입력해주세요");
  const r = await db.applyOrderCredit({ customer: order.customer, orderId: order.id, requested: want, orderTotal: total, manager: ctx.activeManager, fallbackPayment: order.payment });
  if (r.useAmt <= 0) throw new Error(`적립금을 적용하지 않았습니다 — ${r.skipped}`);
  return { ...r, msg: `적립금 ${r.useAmt.toLocaleString()}원 차감${r.computed?.paymentStatus === "입금완료" ? " — 완납 처리됨" : ""}` };
}

/** 환불 신청 — 직원이 올리고 대표가 정산에서 승인한다(옛 RefundRequestModal → ErpApp.onSubmit). */
export async function requestRefund(order, req, ctx) {
  if (ctx.isPacker) throw new Error("포장 담당자는 환불을 처리할 수 없습니다");
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  await db.updateOrder(order.id, { payment: "환불신청", payment_status: "refund_requested", refund_request: { ...req, requestedBy: ctx.activeManager || "", requestedAt: new Date().toISOString() } }, { route: "환불 신청 · 새 UI" });
  return { msg: "환불 신청 완료 — 정산에서 승인 후 처리됩니다" };
}

export async function cancelRefundRequest(order, ctx) {
  if (ctx.isPacker) throw new Error("포장 담당자는 환불을 처리할 수 없습니다");
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  await db.updateOrder(order.id, { payment: "입금완료", payment_status: "paid", refund_request: null, ...db.archiveRefundRequest(order, "취소") }, { route: "환불 신청 취소 · 새 UI" });
  return { msg: "환불 신청 취소 — 입금완료로 복원" };
}

/** 주문 기본 정보 수정 — 품목·금액·배송지·메모. 담당자 잠금. */
export async function editOrder(order, patch, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  if (ctx.isPacker) throw new Error("포장 담당자는 주문을 수정할 수 없습니다");
  await db.updateOrder(order.id, patch, { route: "주문 수정 · 새 UI" });
  return { msg: `수정 저장 — ${order.customer} · ${itemsSummary({ items: patch.items || order.items }, 1)}` };
}

/** 주문 삭제 — 관리자만. 포장대에서 잘라 둔 원단은 옛 화면에서 정리한다(여기서는 포장 기록이 있으면 막는다). */
export async function deleteOrder(order, ctx) {
  if (!ctx.isAdmin) throw new Error("주문 삭제는 관리자만 할 수 있습니다");
  let packed = [];
  try { packed = await db.fetchItemPacking([order.id]); } catch { packed = []; }
  if (packed.length) throw new Error("포장대에서 롤을 찍어 둔 주문입니다 — 잘라 둔 원단 정리가 필요해 옛 화면에서 삭제해 주세요");
  await db.deleteOrder(order.id, { route: "주문 삭제 · 새 UI" });
  return { msg: `주문 삭제 — ${order.customer}` };
}
