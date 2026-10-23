// 출고완료 — 옛 ErpApp.shipOneOrder / handleShipOut 이 하는 일을 그대로 옮긴 것(지시서 4절 "주문 관리 · 출고완료").
// 순서: 입금 확인 → claimShipOut(먼저 표시를 잡는다 — 두 번 눌러도 로그가 두 번 안 남는다) → 품목별 출고 로그 → 묶음 재계산.
// 재고는 여기서 깎지 않는다 — 포장대에서 롤을 찍는 순간 이미 빠졌다(pack_item_from_roll). 옛 코드와 같다.
import * as db from "../../lib/db.js";
import { nowT, isHold, isParked } from "../../constants.js";
import { deleteOrderImages } from "../../lib/storage.js";

export const SHIPPABLE = ["입금완료", "부분환불", "환불완료"];
export const payStatusOf = (o) => o?._computed?.paymentStatus || o?.payment;
// 외상 거래처(customers.allow_credit, 2026-10-23) — 입금 전에도 출고한다. 미수금은 정산의 미입금 목록에 남아 나중에 받는다.
// SaasData 가 거래처 목록에서 이름을 넣는다(setCreditCustomers). 이름 기준인 건 주문이 거래처를 이름으로 가리키기 때문.
const creditCustomers = new Set();
export function setCreditCustomers(names) { creditCustomers.clear(); for (const n of names || []) if (n) creditCustomers.add(String(n).trim()); }
export const isCreditCustomer = (o) => creditCustomers.has(String(o?.customer || "").trim());
/** 출고해도 되나 — 입금이 끝났거나 외상 거래처 */
export const canShipByPayment = (o) => SHIPPABLE.includes(payStatusOf(o)) || isCreditCustomer(o);
/** 외상으로 나가는 주문인가(입금 전인데 외상 거래처라 출고 가능) — 화면 배지용 */
export const isCreditShip = (o) => !SHIPPABLE.includes(payStatusOf(o)) && isCreditCustomer(o);

/** 같은 박스로 나가는 묶음(아직 안 나간 건만, 분리 건 제외, 자기 자신 포함) */
export function shipGroupOf(order, orders) {
  return (order.mergeGroupId && !order.splitShipping)
    ? [order, ...(orders || []).filter(o => o.mergeGroupId === order.mergeGroupId && o.id !== order.id && !o.splitShipping && o.status !== "출고완료")]
    : [order];
}

/**
 * 주문 한 건 출고완료. 반환 { ok, reason?, already? }.
 * onShipped(order, patch) 는 화면 목록을 고치는 콜백.
 */
export async function shipOneOrder(order, { shippedAt, route, extra = {}, onShipped, toast } = {}) {
  if (!canShipByPayment(order)) return { ok: false, reason: "입금확인 후 출고해주세요" };
  const ts = shippedAt || new Date().toISOString();
  let claim;
  try {
    claim = await db.claimShipOut(order.id, {
      isHolding: false, heldAt: null, images: [], shipped_at: ts,
      isParked: false, parkedAt: null, parkReason: null,
      shipRequestedAt: null, shipRequestedBy: null,
      fabricMissing: false, fabricMissingItems: [], fabricMissingAt: null,
      ...extra,
    }, { route });
  } catch (e) {
    console.error("[saas] 출고 표시 실패:", e);
    return { ok: false, reason: e.message };
  }
  const patch = { status: "출고완료", isHolding: false, heldAt: null, images: [], shippedAt: ts, isParked: false, parkedAt: null, parkReason: "",
    shipRequestedAt: null, shipRequestedBy: "", fabricMissing: false, fabricMissingItems: [], fabricMissingAt: null };
  if (claim === "already") { onShipped?.(order, patch); return { ok: true, already: true }; }
  const t = nowT();
  try {
    for (const item of (order.items || [])) {
      await db.insertLog({ ...t, type: "출고", fabric: item.fabric, color: item.color || "", qty: item.qty, itemNo: item.itemNo || "", ref: order.id, note: `판매출고 — ${order.customer}` });
    }
  } catch (e) {
    console.error("[saas] 출고 이력 기록 실패:", e);
    toast?.(`출고는 처리됐지만 입출고 이력 기록에 실패했습니다: ${e.message}`, "error");
  }
  deleteOrderImages(order.id).catch(() => {});
  onShipped?.(order, patch);
  return { ok: true };
}

/** 묶음 변경 뒤 출고일·택배비 재계산 — 옛 ErpApp.settleGroupId */
export async function settleGroupId(gid, snapshot, route, { onPatched, toast } = {}) {
  if (!gid) return;
  const live = snapshot.filter(o => o.mergeGroupId === gid && o.status !== "출고완료");
  const settle = async (members) => {
    try {
      const res = await db.afterGroupChange(members, { paymentStatusOf: payStatusOf, route });
      if (res) {
        onPatched?.(res);
        if (res.freight?.conflict) toast?.("입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다", "error");
      }
    } catch (e) { console.error("[saas] 묶음 재계산 실패", e); toast?.("출고일·택배비 자동 조정 실패: " + e.message, "error"); }
  };
  const together = live.filter(o => !o.splitShipping);
  if (together.length) await settle(together);
  for (const o of live.filter(o => o.splitShipping)) await settle([o]);
}

/**
 * 출고완료 버튼 — 묶음은 통째로 나가거나 통째로 안 나간다. 관리자만(업무 규칙 5). 입금 확인 전이면 막는다(규칙 1).
 * confirm(msg) 은 묶음 출고를 한 번 묻는 자리 — 화면이 자기 확인창을 넣는다.
 * 반환 { ok, shipped: [id…], reason? }
 */
export async function shipOut(order, { orders, isAdmin, confirm, onShipped, onPatched, toast }) {
  if (!isAdmin) return { ok: false, reason: "출고완료는 관리자만 할 수 있습니다" };
  if (order.status === "출고완료") return { ok: false, reason: "이미 출고완료된 주문입니다" };
  if (!canShipByPayment(order)) return { ok: false, reason: "입금확인 후 출고해주세요" };
  const toShip = shipGroupOf(order, orders);
  if (toShip.length > 1) {
    const unpaid = toShip.filter(o => !canShipByPayment(o));
    if (unpaid.length) return { ok: false, reason: `합배송 묶음에 입금확인이 안 된 주문이 있습니다: ${unpaid.map(o => o.customer).join(", ")} — 입금확인을 먼저 하거나 주문 상세에서 분리 배송으로 지정해 주세요` };
    const stuck = toShip.some(o => isHold(o) || isParked(o));
    const ok = await confirm?.(`합배송 묶음 ${toShip.length}건을 함께 출고합니다.\n\n${toShip.map(o => `· ${o.customer}${isHold(o) ? " [보관]" : ""}${isParked(o) ? " [보류]" : ""}`).join("\n")}${stuck ? "\n\n⚠ 보관·보류 중인 주문이 들어 있습니다. 같이 나가는 게 맞는지 확인해 주세요." : ""}`);
    if (!ok) return { ok: false, reason: "취소했습니다" };
  }
  const done = [];
  const at = new Date().toISOString();
  for (const o of toShip) {
    const r = await shipOneOrder(o, { shippedAt: at, route: toShip.length > 1 ? "출고완료 버튼 (합배송 묶음) · 새 UI" : "출고완료 버튼 · 새 UI", onShipped, toast });
    if (!r.ok) {
      if (done.length) return { ok: false, shipped: done, reason: `합배송 ${toShip.length}건 중 ${done.length}건만 출고완료 처리됐습니다. 오류: ${r.reason}` };
      return { ok: false, shipped: [], reason: r.reason };
    }
    done.push(o.id);
  }
  if (order.mergeGroupId) await settleGroupId(order.mergeGroupId, (orders || []).map(o => done.includes(o.id) ? { ...o, status: "출고완료" } : o), "출고 뒤 재계산", { onPatched, toast });
  return { ok: true, shipped: done };
}
