// 합배송 그룹의 택배비 — 순수 함수. DB 도 React 도 없다.
//
// 그룹 안에서 택배비는 한 건에만 남고 나머지는 0 이어야 한다. 예전에는 사람이 "운임비 조정"을
// 눌러 1건만 남기는 전제였는데, 안 누르면 4,000원이 두 건에 남았다(2026-09-30 김○연 건).
// 이제 그룹 구성이 바뀔 때마다(묶음·해제·분리·출고) 이 함수로 자동 재계산한다.
// 사람이 운임비 조정으로 정한 값은 그 뒤 재계산을 부르지 않으므로 그대로 남는다.
//
// 자동으로 하는 일은 "겹친 택배비를 내려놓고, 다시 따로 나가게 되면 되돌리는 것"뿐이다.
// 택배비를 새로 붙이지는 않는다(2026-10-02 결정).
// 택배비가 0 인 주문은 오류가 아니다 — 무료배송권, 단골 혜택, 셀러 실수로 고객에게 못 받는 경우다.
// 그대로 매출에 잡히면 된다. 처음에는 0원 묶음·혼자 남은 0원 주문에 기본 택배비(4,000)를 붙였는데,
// 보관 주문처럼 일부러 0 으로 둔 건에 청구가 생겨서 걷어냈다.
//
// 돈이 이미 들어온 주문은 건드리지 않는다 — 택배비를 바꾸면 청구액이 달라져 입금 대조가 틀어진다.
// 무료배송권을 쓴 주문도 같다 — 배송권차감 로그가 쓸 때의 배송비 금액으로 payment_logs 에 남는다.
// 여기서 택배비를 0 으로 내리면 로그는 그대로라 받은 돈이 청구액을 넘어 완납으로 잘못 잡힌다(2026-10-07).

/** 이 상태면 돈이 들어온 주문 — shippingFee 를 바꾸지 않는다. */
export const PAID_STATUSES = ["입금완료", "부분환불", "환불완료"];

/** 택배비를 건드리면 안 되는 주문 — 돈이 들어왔거나, 무료배송권으로 배송비를 이미 치른 건. */
export const isFreightFrozen = (o, paymentStatusOf = defaultPaymentStatusOf) =>
  PAID_STATUSES.includes(paymentStatusOf(o)) || !!o?.freeShippingUsed;

/** 기본 결제 상태 판정 — _computed(입금 로그 기준)가 있으면 그것, 없으면 주문의 payment. */
export const defaultPaymentStatusOf = (o) => o?._computed?.paymentStatus || o?.payment || "";

const fee = (o) => Number(o?.shippingFee) || 0;

/** 등록 순. createdAt → date+time → id. "가장 먼저 등록된 건"은 이 순서의 첫 번째다. */
export function sortByCreated(orders) {
  const key = (o) => `${o.createdAt || ""}\u0000${o.date || ""} ${o.time || ""}\u0000${o.id || ""}`;
  return [...orders].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * 그룹의 택배비 부담 주문을 정한다.
 *
 * 반환 { changes: [{ id, shippingFee, feeHeld, totalAmount? }], bearerId, conflict, heldBack }
 *   changes   값이 실제로 바뀌는 주문만. 비어 있으면 아무 요청도 보낼 필요가 없다.
 *             totalAmount 는 전체금액이 적혀 있는 주문에만 붙는다 — 택배비가 바뀐 만큼 같이 움직인 값.
 *             feeHeld 는 묶이면서 내려놓은 택배비(되돌릴 금액). 되돌리면 null.
 *   bearerId  택배비를 드는 주문(아무도 안 들면 null).
 *   conflict  입금완료 건이 둘 이상 택배비를 들고 있어 자동으로 못 고친 경우 true — 변경 없음.
 *   heldBack  되돌릴 택배비가 있는데 돈이 이미 들어와 못 되돌린 주문 [{ id, fee }] — 화면이 알린다.
 *
 * 규칙:
 *  - 멤버 여럿: 드는 건(shippingFee > 0)이 둘 이상이면 그중 가장 먼저 등록된 건을 유지하고
 *    나머지를 0 으로. 0 이 되는 주문은 원래 금액을 feeHeld 에 적어 둔다.
 *  - 그 주문이 다시 따로 나가게 되면(해제·분리·부담 주문만 먼저 출고) 적어 둔 금액을 되돌린다.
 *    원래 택배비가 있던 주문은 있게, 없던 주문은 없게 — 새로 붙이지는 않는다.
 *    남은 멤버가 여럿인데 아무도 안 들면, 내려놓은 적이 있는 가장 먼저 등록된 건 하나만 되돌린다.
 *  - 입금완료·부분환불·환불완료 주문의 shippingFee 는 절대 바꾸지 않는다(내리지도 되돌리지도 않는다).
 *    되돌리면 미수금이 생겨 출고가 막힌다. 그런 건이 이미 >0 으로 들고 있으면 그 건이 부담자다.
 *    둘 이상이면 conflict.
 *  - 택배비가 바뀌면 전체금액(totalAmount)도 같은 차액만큼 바꾼다. 입금 대조는 전체금액으로 한다 —
 *    택배비 칸만 0 이 되고 전체금액에 4,000원이 남으면 고객이 원단값만 넣어도 미수금이 남는다.
 *    전체금액이 비어 있는(0) 옛 주문은 화면이 품목합+택배비로 계산해 보여주므로 건드리지 않는다.
 */
export function recomputeGroupFreight(groupOrders, { paymentStatusOf = defaultPaymentStatusOf } = {}) {
  const members = sortByCreated((groupOrders || []).filter(Boolean));
  const frozen = (o) => isFreightFrozen(o, paymentStatusOf);
  const held = (o) => Number(o?.feeHeld) || 0;
  const out = { changes: [], bearerId: null, conflict: false, heldBack: [] };
  if (members.length === 0) return out;

  const change = (o, v, feeHeld) => {
    const c = { id: o.id, shippingFee: v, feeHeld };
    const total = Number(o.totalAmount) || 0;
    if (total > 0) c.totalAmount = Math.max(0, total + (v - fee(o)));
    out.changes.push(c);
  };
  // 내려놓기 — 원래 금액을 적어 둔다. 되돌리기 — 적어 둔 금액을 다시 든다.
  const drop = (o) => { if (fee(o) > 0 && !frozen(o)) change(o, 0, fee(o)); };
  const canRestore = (o) => fee(o) === 0 && held(o) > 0 && !frozen(o);
  const restore = (o) => { change(o, held(o), null); out.bearerId = o.id; };
  const noteHeldBack = (list) => { for (const o of list) if (fee(o) === 0 && held(o) > 0 && frozen(o)) out.heldBack.push({ id: o.id, fee: held(o) }); };

  if (members.length === 1) {                                  // 혼자 남은 건 — 내려놓은 게 있으면 되돌린다
    const o = members[0];
    if (fee(o) > 0) out.bearerId = o.id;
    else if (canRestore(o)) restore(o);
    else noteHeldBack([o]);
    return out;
  }

  const holders = members.filter(o => fee(o) > 0);
  const frozenHolders = holders.filter(frozen);
  if (frozenHolders.length >= 2) { out.conflict = true; return out; }

  const bearer = frozenHolders[0] || holders[0] || null;
  if (!bearer) {
    // 아무도 안 든다 — 부담 주문이 먼저 나갔거나 빠졌다. 내려놓은 적 있는 가장 먼저 등록된 건을 되돌린다.
    // 그런 건이 없으면 택배비 없는 묶음이다. 그대로 둔다.
    const back = members.find(canRestore);
    if (back) restore(back); else noteHeldBack(members);
    return out;
  }
  out.bearerId = bearer.id;
  for (const o of members) if (o !== bearer) drop(o);
  return out;
}

/**
 * 주문 등록 전 안내 — 새 주문이 묶일 주문들과 택배비가 겹치는가, 겹치면 등록 뒤 무엇이 바뀌는가.
 * 등록 뒤에는 자동으로 한 건만 남는다. 셀러가 모르는 채 금액이 바뀌면 고객에게 틀린 금액을 안내하게 되므로
 * 등록 버튼을 누를 때 한 번 알린다.
 *   fresh  아직 저장 전인 새 주문 { id, createdAt, shippingFee, totalAmount, payment }
 *   group  묶일 기존 주문들(미출고·분리 아님)
 * 반환: null(겹치지 않음) 또는 { holders: [주문…], changes: [{ order, from, totalFrom, totalTo }], conflict }
 */
export function previewFreightOverlap(fresh, group, opts = {}) {
  const all = [fresh, ...(group || [])].filter(Boolean);
  const holders = sortByCreated(all.filter(o => fee(o) > 0));
  if (!(group || []).length || holders.length < 2) return null;
  const res = recomputeGroupFreight(all, opts);
  const byId = new Map(all.map(o => [String(o.id), o]));
  const changes = res.changes.map(c => {
    const o = byId.get(String(c.id));
    return { order: o, from: fee(o), totalFrom: Number(o.totalAmount) || 0, totalTo: c.totalAmount };
  });
  return { holders, changes, conflict: res.conflict };
}

/**
 * 그룹 변경 결과를 화면의 주문 목록에 반영한다(순수). ErpApp·OrderInput·MergeModal 이 같은 모양으로 쓴다.
 * res: afterGroupChange 가 돌려주는 { ids, shipDate, isUrgent, dateChanged, freight: { changes } }
 */
export function patchOrdersWithGroupResult(orders, res) {
  if (!res) return orders;
  const feeById = new Map((res.freight?.changes || []).map(c => [String(c.id), c]));
  const dateIds = res.dateChanged ? new Set((res.ids || []).map(String)) : new Set();
  if (feeById.size === 0 && dateIds.size === 0) return orders;
  return orders.map(o => {
    const id = String(o.id);
    let next = o;
    if (dateIds.has(id)) next = { ...next, shipDate: res.shipDate, isUrgent: res.isUrgent };
    if (feeById.has(id)) {
      const c = feeById.get(id);
      next = { ...next, shippingFee: c.shippingFee, ...(c.totalAmount !== undefined ? { totalAmount: c.totalAmount } : {}), ...(c.feeHeld !== undefined ? { feeHeld: c.feeHeld } : {}) };
    }
    return next;
  });
}
