// 주문 상태 변경·보관·보류·입금 확인·환불 신청·합배송·출고 취소·택배사·사진·삭제 — 옛 ErpApp 주문현황 버튼(3240행 부근)·
// PackingTab.park/unpark/setHold·DepositTab·MergeModal 의 흐름을 옮긴 것.
// 모든 상태 변경 전에 checkOrderLock(업무 규칙 2). 보류는 묶음 단위(규칙 3). 관리자 전용은 ctx.isAdmin 으로 막는다.
import * as db from "../../lib/db.js";
import { checkOrderLock } from "../../lib/managerLock.js";
import { todayYmd } from "../../lib/shipDate.js";
import { settlePackingBefore, settleMessage } from "../../lib/packingGuard.js";
import { uploadOrderImages, deleteOrderImages } from "../../lib/storage.js";
import { COURIERS } from "../../lib/courier.js";
import { itemsSummary } from "../lib/metrics.js";
import { pickGroupId, newGroupId, freightAdjustPlan, shippedMatesOf, undoShipPatch, canUndoShip, canCancelDeposit, removeImageAt, normalizeCourier } from "../lib/orderRules.js";
import { settleGroupId, payStatusOf, shipGroupOf } from "./ship.js";

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

/** 보관 토글 — 켜는 건 '보관 요청'까지. 창고에 넣는 건 포장대(또는 주문 상세의 "창고에 넣음")가 confirmHold 로 held_at 을 찍는다. */
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
  return { msg: next ? "📦 보관 요청 — 창고에 넣으면 보관중이 됩니다" : "보관 해제" };
}

/**
 * 창고에 넣음(보관 확정) — 보관 요청(isHolding && !heldAt)인 건에 held_at 을 찍는다(옛 PackingTab.setHold "done").
 * 물건을 실제로 선반에 올리는 사람이 누르는 버튼이라 포장 담당자도 된다(잠금 예외는 setStatus 와 같다).
 */
export async function confirmHold(order, ctx) {
  if (!ctx.isPacker) { const lock = lockOf(order, ctx); if (lock) throw new Error(lock); }
  const held = !!order.isHolding || order.status === "보관";
  if (!held) throw new Error("보관 요청이 없는 주문입니다 — 먼저 보관을 켜 주세요");
  if (order.heldAt) throw new Error("이미 보관중입니다");
  const at = new Date().toISOString();
  await db.updateOrder(order.id, { isHolding: true, heldAt: at }, { route: "창고에 넣음 · 새 UI" });
  return { heldAt: at, msg: `📦 보관 완료 — ${order.customer} · 창고에 들어갔습니다` };
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

/**
 * 입금 취소 — 관리자만(옛 주문현황의 결제 배지 클릭). 이 주문의 "입금" 로그를 전부 지우고 payment 를 미입금으로.
 * 적립금차감·배송권차감 로그는 건드리지 않는다 — 돈이 아니라 잔액 원장이라, 지우면 고객 적립금이 틀어진다.
 */
export async function cancelDeposit(order, payStatus, ctx) {
  const why = canCancelDeposit(order, payStatus, ctx); if (why) throw new Error(why);
  await db.deletePaymentLogsByType(order.id, "입금");
  await db.updateOrder(order.id, { payment: "미입금" }, { route: "입금 취소 · 새 UI" });
  return { msg: `입금 취소 — ${order.customer} · 미입금으로 되돌림` };
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

// ── 합배송 ────────────────────────────────────────────────────

/**
 * 합배송 묶기(옛 MergeModal.onConfirmClick) — ids 전부에 그룹 id(기존 것 재사용, 없으면 새로) → 출고일·택배비 재계산.
 * 반환 { groupId, ids, res, conflict, msg }. res 는 patchOrdersWithGroupResult 로 화면에 반영한다.
 * 재계산이 실패해도 묶음 자체는 됐다 — res 가 null 이고 warn 에 사유.
 */
export async function mergeOrders(order, ids, ctx) {
  // 포장 담당자는 담당자 잠금 예외(setStatus 와 같다) — 대신 같은 고객끼리만 묶는다(managerLock.js 머리말).
  if (!ctx.isPacker) { const lock = lockOf(order, ctx); if (lock) throw new Error(lock); }
  const allIds = [...new Set([order.id, ...(ids || [])])];
  if (allIds.length < 2) throw new Error("합배송하려면 2건 이상 선택");
  const members = allIds.map(id => (ctx.orders || []).find(o => o.id === id)).filter(Boolean);
  if (ctx.isPacker && members.some(o => o.customer !== order.customer)) throw new Error("포장 담당자는 같은 고객끼리만 묶을 수 있습니다");
  const groupId = pickGroupId(members, newGroupId);
  await db.setMergeGroup(allIds, groupId);
  let res = null, warn = "";
  try {
    res = await db.afterGroupChange(members.map(o => ({ ...o, mergeGroupId: groupId })), { paymentStatusOf: payStatusOf, route: "합배송 묶기 · 새 UI" });
  } catch (e) {
    console.error("[saas] 합배송 출고일·택배비 조정 실패:", e);
    warn = "묶였지만 출고일·택배비 자동 조정에 실패했습니다: " + e.message;
  }
  const conflict = !!res?.freight?.conflict;
  return { groupId, ids: allIds, res, conflict, warn,
    msg: conflict ? `${allIds.length}건 합배송 묶음 — 입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다` : `${allIds.length}건 합배송 묶음` };
}

/**
 * 묶음 해제 — 이 주문만 그룹에서 뺀다(옛 주문현황 "🔗 해제").
 * 빠진 건은 1건 그룹(묶일 때 내려놓은 택배비가 있으면 되돌린다), 남은 멤버는 settleGroupId 로 다시 계산.
 * onPatched(res) 로 화면 반영, toast 는 택배비 충돌 안내용.
 */
export async function leaveGroup(order, ctx, { onPatched, toast } = {}) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  if (ctx.isPacker) throw new Error("포장 담당자는 합배송을 풀 수 없습니다");
  const gid = order.mergeGroupId;
  if (!gid) throw new Error("합배송 묶음이 아닙니다");
  await db.clearMergeGroup(order.id);
  try {
    const res = await db.afterGroupChange([{ ...order, mergeGroupId: null }], { paymentStatusOf: payStatusOf, route: "합배송 해제 · 새 UI" });
    if (res) onPatched?.(res);
  } catch (e) { console.error("[saas] 해제된 건 택배비 되돌림 실패", e); toast?.("택배비 되돌림 실패: " + e.message, "error"); }
  await settleGroupId(gid, (ctx.orders || []).filter(x => x.id !== order.id), "합배송 해제 · 새 UI", { onPatched, toast });
  return { msg: `합배송 그룹에서 제외 — ${order.customer}` };
}

/** 분리 배송 토글(옛 주문현황 묶음 펼침의 "분리" 버튼) — 분리된 건은 1건 그룹, 남은 그룹은 다시 계산. */
export async function toggleSplit(order, ctx, { onPatched, toast } = {}) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  if (!order.mergeGroupId) throw new Error("합배송 묶음이 아닙니다");
  if (order.status === "출고완료") throw new Error("출고완료된 주문은 바꿀 수 없습니다");
  const next = !order.splitShipping;
  await db.updateOrder(order.id, { splitShipping: next }, { route: (next ? "분리 배송" : "분리 해제") + " · 새 UI" });
  const snapshot = (ctx.orders || []).map(x => x.id === order.id ? { ...x, splitShipping: next } : x);
  await settleGroupId(order.mergeGroupId, snapshot, (next ? "분리 배송" : "분리 해제") + " · 새 UI", { onPatched, toast });
  return { splitShipping: next, msg: next ? "분리 배송으로 설정 — 이 주문은 따로 나갑니다" : "합배송으로 변경 — 묶음과 함께 나갑니다" };
}

/** 운임비 조정(옛 FreightModal) — 그룹 안 한 건에만 금액, 나머지 0, feeHeld 는 전부 지운다. */
export async function adjustFreight(order, groupOrders, bearerId, amount, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  if (ctx.isPacker) throw new Error("포장 담당자는 운임비를 바꿀 수 없습니다");
  const plan = freightAdjustPlan(groupOrders, bearerId, amount);
  for (const c of plan) await db.updateOrder(c.id, { shippingFee: c.shippingFee, feeHeld: null }, { route: "운임비 조정 · 새 UI" });
  const n = plan.find(c => c.id === bearerId)?.shippingFee || 0;
  return { plan, msg: `그룹 운임비 ${n.toLocaleString()}원 부여 완료` };
}

// ── 출고 취소 ───────────────────────────────────────────────

/**
 * 출고 취소 — 관리자 전용(옛 ErpApp.handleUndoShipOut). 상태를 포장완료로, 출고 시각·방법 지우고 출고 이력(logs.ref = 주문 id) 삭제.
 * 재고는 되돌리지 않는다 — 새 UI 의 출고완료는 재고를 깎지 않는다(포장대에서 롤을 찍는 순간 이미 빠졌다. ship.js 머리말).
 * withGroup 이면 같이 나간 묶음 멤버도 함께 되돌린다.
 */
export async function undoShipOut(order, ctx, { withGroup = false } = {}) {
  const why = canUndoShip(order, ctx); if (why) throw new Error(why);
  const targets = withGroup ? [order, ...shippedMatesOf(order, ctx.orders)] : [order];
  const patch = undoShipPatch();
  const done = [];
  for (const o of targets) {
    await db.updateOrder(o.id, patch, { route: "출고 취소 · 새 UI" });
    try { await db.deleteLogsByRef(o.id); }
    catch (e) { console.error("[saas] 출고 이력 삭제 실패:", e); throw new Error(`${o.customer} 출고는 취소됐지만 입출고 이력 삭제에 실패했습니다: ${e.message}`); }
    done.push(o.id);
  }
  return { ids: done, patch, msg: done.length > 1 ? `출고 취소 → 포장완료 (묶음 ${done.length}건)` : `출고 취소 → 포장완료 · ${order.customer}` };
}

// ── 택배사 ─────────────────────────────────────────────────

/** 택배사 직접 지정 — null 이면 자동(메모의 롤로 판정). 같은 박스(묶음, 분리 제외)에 함께 쓴다. */
export async function setCourier(order, courier, ctx) {
  const lock = lockOf(order, ctx); if (lock) throw new Error(lock);
  const c = normalizeCourier(courier, COURIERS);
  const box = shipGroupOf(order, ctx.orders);
  await db.setCourier(box.map(o => o.id), c, "택배사 지정 · 새 UI");
  return { courier: c, ids: box.map(o => o.id), msg: c ? `택배사 ${c} 로 지정${box.length > 1 ? ` (묶음 ${box.length}건)` : ""}` : "택배사 자동 판정으로 되돌림" };
}

// ── 사진 ───────────────────────────────────────────────────

/** 사진 올리기 — 여러 장. 압축·업로드(storage.js) 뒤 images 배열에 덧붙인다. */
export async function addImages(order, files, ctx) {
  if (!ctx.isPacker) { const lock = lockOf(order, ctx); if (lock) throw new Error(lock); }
  const list = Array.from(files || []).filter(f => f && /^image\//.test(f.type || ""));
  if (!list.length) throw new Error("이미지 파일을 골라 주세요");
  const urls = await uploadOrderImages(list, order.id);
  const images = [...(order.images || []), ...urls];
  await db.updateOrder(order.id, { images }, { route: "사진 첨부 · 새 UI" });
  return { images, msg: `사진 ${urls.length}장 첨부` };
}

/**
 * 사진 한 장 빼기 — images 배열에서만 제거한다.
 * 스토리지 파일은 그대로 둔다: storage.js 에는 주문 폴더 전체 삭제(deleteOrderImages)뿐이라 한 장만 지울 수 없고,
 * 출고완료 때 폴더째 지워지므로 그때 정리된다.
 */
export async function removeImage(order, idx, ctx) {
  if (!ctx.isPacker) { const lock = lockOf(order, ctx); if (lock) throw new Error(lock); }
  const images = removeImageAt(order.images, idx);
  await db.updateOrder(order.id, { images }, { route: "사진 삭제 · 새 UI" });
  return { images, msg: "사진을 뺐습니다" };
}

// ── 삭제 ───────────────────────────────────────────────────

/**
 * 주문 삭제 — 관리자만. 포장대에서 잘라 둔 원단이 있으면 settlePackingBefore 로 먼저 정리한다(조각 롤로 되돌리기 / 기록만 지우기 / 돌아가기).
 *
 * settlePackingBefore 는 confirm 을 동기(window.confirm 식)로 부른다 — 새 UI 의 confirm(useAsk)은 Promise 라 그대로 넘기면
 * 항상 참이 되어 묻지도 않고 되돌린다. 그래서 여기서 같은 두 질문을 ctx.confirm 으로 먼저 묻고, 그 답을 순서대로 돌려주는
 * 동기 confirm 을 넘긴다. ctx.confirm 이 없으면 settlePackingBefore 기본값(window.confirm)이 쓰인다.
 * 반환 { cancelled: true } 면 사용자가 돌아가기를 골랐다.
 */
export async function deleteOrder(order, ctx) {
  if (!ctx.isAdmin) throw new Error("주문 삭제는 관리자만 할 수 있습니다");
  const what = "주문 삭제";
  let answers = null;
  if (typeof ctx.confirm === "function") {
    let recs = [];
    try { recs = (await db.fetchItemPacking([order.id])).filter(r => String(r.orderId) === String(order.id)); } catch { recs = []; }
    const withRoll = recs.filter(r => r.rollId);
    if (withRoll.length) {
      const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "?"; };
      const lines = recs.map(r => r.rollId ? `· ${r.rollCode || "롤"} ${r.wholeRoll ? "통째" : fmt(r.length) + "마"}` : `· 롤 없이 포장${r.overrideReason ? ` (${r.overrideReason})` : ""}`).join("\n");
      const restore = await ctx.confirm(`포장대에서 롤을 잘라 둔 품목이 ${withRoll.length}개 있습니다.\n\n${lines}\n\n잘라 둔 원단을 조각 롤로 되돌리고 삭제할까요?`, { title: "잘라 둔 원단", confirmLabel: "조각 롤로 되돌리고 삭제", cancelLabel: "되돌리지 않음" });
      if (restore) answers = [true];
      else {
        const drop = await ctx.confirm("원단을 되돌리지 않고 삭제할까요?\n\n잘라 둔 원단은 장부에서 사라집니다 — 롤 잔량은 이미 빠져 있고, 조각 롤도 생기지 않습니다.", { title: "기록만 지우기", danger: true, confirmLabel: "기록만 지우고 삭제", cancelLabel: "돌아가기" });
        if (!drop) return { cancelled: true, msg: "삭제를 중단했습니다" };
        answers = [false, true];
      }
    } else answers = [];
  }
  const settled = await settlePackingBefore(order.id, { what, by: ctx.activeManager || "", confirm: answers ? () => answers.shift() : null });
  if (!settled) return { cancelled: true, msg: "삭제를 중단했습니다" };
  await db.deleteOrder(order.id, { route: "주문 삭제 · 새 UI" });
  deleteOrderImages(order.id).catch(() => {});   // 사진 폴더도 정리(옛 ErpApp.deleteItem 과 같다). 실패해도 삭제는 끝났다.
  return { msg: `주문 삭제 — ${order.customer}${settleMessage(settled)}` };
}
