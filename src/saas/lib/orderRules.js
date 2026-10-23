// 주문 상세 처리의 순수 규칙 — DB 도 React 도 없다. tests/saas/test-order-actions.mjs 가 그대로 돌린다.
//
// 옛 src/components/MergeModal.jsx(후보 점수·정렬·그룹 id 재사용·운임비 조정)와 ErpApp.handleUndoShipOut(출고 취소)의
// 판단 부분만 떼어 둔 것이다. 화면(OrderDetail·MergeModal)은 여기서 계산한 결과를 DB 에 쓰기만 한다.

const normAddr = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const digits = (s) => String(s || "").replace(/\D/g, "");
const hintText = (o) => `${o?.note || ""} ${o?.memo || ""} ${o?.deliveryMessage || ""}`;

/** 메모류에서 합배송 언급 힌트 — "(미송님 합)" 같은 문구가 든 첫 메모 */
export const mergeHintOf = (o) => [o?.note, o?.memo, o?.deliveryMessage].filter(t => t && /합/.test(t))[0] || "";

/**
 * 합배송 후보 점수(옛 MergeModal 그대로):
 *   같은 고객 100 · 같은 배송지 80 · 상대 메모에 내 고객명 70 · 내 메모에 상대 고객명 70 · 같은 연락처 60 · 합배송 표시 30
 */
export function mergeCandidateScore(source, o) {
  let s = 0;
  const srcHint = hintText(source);
  if (source.customer && o.customer === source.customer) s += 100;
  if (normAddr(o.address) && normAddr(o.address) === normAddr(source.address)) s += 80;
  if (source.customer && hintText(o).includes(source.customer)) s += 70;
  if (o.customer && srcHint.includes(o.customer)) s += 70;
  if (digits(o.phone) && digits(o.phone) === digits(source.phone)) s += 60;
  if (o.combinedShipping) s += 30;
  return s;
}

/** 후보가 될 수 있는 주문 — 접수 상태, 출고 안 됨, 자기 자신 제외 */
export const isMergeable = (source, o) => !!o && o.id !== source.id && o.status === "접수";

/** 후보에 붙일 사유 배지 — sameCust · sameAddr · mentioned · combined · inGroup */
export function mergeReasons(source, o) {
  const sameCust = !!source.customer && o.customer === source.customer;
  const sameAddr = !sameCust && !!normAddr(o.address) && normAddr(o.address) === normAddr(source.address);
  const mentioned = !sameCust && ((!!source.customer && hintText(o).includes(source.customer)) || (!!o.customer && hintText(source).includes(o.customer)));
  return { sameCust, sameAddr, mentioned, combined: !!o.combinedShipping, inGroup: !!o.mergeGroupId };
}

/**
 * 후보 목록 — 점수 내림차순, 같은 점수면 날짜 최신순, 최대 limit 건.
 *   q: 검색어(고객·닉네임·연락처·주소·원단·색상). nickOf(name): 닉네임 조회(없으면 "").
 * 반환 [{ o, s }]
 */
export function rankMergeCandidates(source, orders, { q = "", nickOf = () => "", limit = 40 } = {}) {
  const ql = String(q || "").trim().toLowerCase();
  return (orders || [])
    .filter(o => isMergeable(source, o))
    .filter(o => !ql
      || String(o.customer || "").toLowerCase().includes(ql)
      || String(nickOf(o.customer) || "").toLowerCase().includes(ql)
      || String(o.phone || "").includes(ql)
      || String(o.address || "").toLowerCase().includes(ql)
      || (o.items || []).some(i => String(i.fabric || "").toLowerCase().includes(ql) || String(i.color || "").toLowerCase().includes(ql)))
    .map(o => ({ o, s: mergeCandidateScore(source, o) }))
    .sort((a, b) => b.s - a.s || String(b.o.date || "").localeCompare(String(a.o.date || "")))
    .slice(0, limit);
}

/** 선택된 주문 중 기존 그룹 id 가 있으면 그것을 쓴다(첫 번째). 없으면 gen() 으로 새로. */
export function pickGroupId(selectedOrders, gen) {
  const existing = (selectedOrders || []).map(o => o?.mergeGroupId).find(Boolean);
  return existing || gen();
}

export const newGroupId = () => (typeof crypto !== "undefined" && crypto.randomUUID)
  ? crypto.randomUUID()
  : `mg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * 운임비 조정(옛 FreightModal) — 그룹 전체 운임비를 bearer 한 건에만, 나머지는 0.
 * 사람이 정한 값이라 자동으로 내려놓았던 금액(feeHeld)은 전부 지운다 — 남겨 두면 나중에 풀릴 때 옛 금액이 되살아난다.
 * 반환 [{ id, shippingFee, feeHeld: null }] (멤버 전부 — 값이 같아도 feeHeld 를 지우기 위해 쓴다)
 */
export function freightAdjustPlan(groupOrders, bearerId, amount) {
  const n = parseInt(String(amount ?? "").replace(/[^0-9]/g, ""), 10) || 0;
  if (n < 0) throw new Error("운임비는 0 이상이어야 합니다");
  const members = (groupOrders || []).filter(Boolean);
  if (!members.some(o => o.id === bearerId)) throw new Error("운임비를 부담할 주문을 고르세요");
  return members.map(o => ({ id: o.id, shippingFee: o.id === bearerId ? n : 0, feeHeld: null }));
}

/** 출고 취소 — 같이 나간 묶음 멤버(출고완료 상태인 다른 건) */
export function shippedMatesOf(order, orders) {
  if (!order?.mergeGroupId) return [];
  return (orders || []).filter(o => o.id !== order.id && o.mergeGroupId === order.mergeGroupId && o.status === "출고완료");
}

/**
 * 출고 취소로 되돌릴 상태 — 옛 화면은 버튼마다 접수/포장완료를 골랐지만, 출고된 건은 이미 포장이 끝난 것이라
 * 새 화면은 "포장완료"로만 되돌린다. 출고 시각·방법·출고요청 흔적을 지운다.
 */
export function undoShipPatch() {
  return { status: "포장완료", shippedAt: null, shippedVia: null, shipRequestedAt: null, shipRequestedBy: null };
}

/** 출고 취소 가능? — 관리자, 출고완료 상태만 */
export function canUndoShip(order, ctx) {
  if (!ctx?.isAdmin) return "출고 취소는 관리자만 할 수 있습니다";
  if (order?.status !== "출고완료") return "출고완료 상태가 아닙니다";
  return null;
}

/** 입금 취소 가능? — 관리자, 입금완료·부분입금(입금 로그가 있는 상태)만 */
export function canCancelDeposit(order, payStatus, ctx) {
  if (!ctx?.isAdmin) return "입금 취소는 관리자만 할 수 있습니다";
  if (!["입금완료", "부분입금"].includes(payStatus)) return "입금 기록이 있는 주문만 취소할 수 있습니다";
  if (order?.status === "출고완료") return "출고완료된 주문의 입금은 취소할 수 없습니다 — 환불로 처리하세요";
  return null;
}

/** 사진 한 장 빼기 — 배열 복사본 */
export function removeImageAt(images, idx) {
  const list = Array.isArray(images) ? images : [];
  if (idx < 0 || idx >= list.length) return list.slice();
  return list.filter((_, i) => i !== idx);
}

/** 택배사 미리 지정 — null 이면 지정 없음. courier 가 회사 목록에 없으면 null */
export function normalizeCourier(courier, couriers) {
  return (couriers || []).includes(courier) ? courier : null;
}
