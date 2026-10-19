// 같은 고객의 미출고 주문 자동 합배송 — 판정 로직(순수 함수).
//
// 지금까지는 셀러가 수동으로 묶어야 했고, 놓치면 포장직원이 같은 고객 박스를
// 두 번 싸게 됐다. 출고완료 전이고 같은 곳으로 나가는 주문이면 자동으로 묶는다.
//
// 포장완료된 주문도 묶는다 — 이미 싼 박스를 다시 열어야 하지만, 두 박스가 따로
// 나가는 것보다 낫다. 대신 포장 화면이 '재포장 필요'로 크게 경고한다.
//
// 예약(모레 이후 날짜 지정) 건이 끼면 자동으로 묶지 않는다.
// 고객이 일부러 늦게 받겠다고 한 걸 시스템이 당기거나, 급한 주문을 그 날짜까지
// 미루는 건 사람이 판단할 문제다. 셀러에게 물어본다.

import { ymd, addDays } from "./shipDate.js";

const digits = s => String(s || "").replace(/\D/g, "");
const squash = s => String(s || "").replace(/\s+/g, "").toLowerCase();

/** 두 주소가 사실상 같은 곳인가 — 공백 제거 후 완전일치 또는 포함관계 */
function sameAddress(a, b) {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;   // 주소를 모르면 묶지 않는다 (다른 곳으로 나갈 수 있음)
  if (x === y) return true;
  if (x.length >= 6 && y.includes(x)) return true;
  if (y.length >= 6 && x.includes(y)) return true;
  return false;
}

/** 같은 사람인가 — 이름+전화(숫자) 일치. 전화가 없으면 이름만으로는 묶지 않는다. */
function samePerson(a, b) {
  if (squash(a.customer) !== squash(b.customer)) return false;
  const pa = digits(a.phone), pb = digits(b.phone);
  if (!pa || !pb) return false;
  return pa === pb;
}

/** 모레 이후 = 예약. 고객/셀러가 일부러 미뤄둔 건이라 자동 병합 대상에서 뺀다. */
export function isReserved(order, today = new Date()) {
  if (!order?.shipDate || order.isUrgent) return false;
  return order.shipDate > ymd(addDays(today, 1));
}

/**
 * 새 주문과 묶을 후보를 찾는다.
 * 반환: { candidates, needsAsk }
 *   candidates — 같은 사람·같은 주소·미출고인 기존 주문들
 *   needsAsk   — 예약 건이 끼어 있어 셀러 확인이 필요한지
 */
export function findMergeCandidates(newOrder, allOrders, today = new Date()) {
  const candidates = (allOrders || []).filter(o =>
    o.id !== newOrder.id &&
    o.status !== "출고완료" &&
    o.payment !== "환불" &&
    (o._computed?.paymentStatus !== "환불완료") &&
    !o.splitShipping &&                      // 따로 보내기로 지정된 건은 제외
    !newOrder.splitShipping &&
    samePerson(o, newOrder) &&
    sameAddress(o.address, newOrder.address)
  );
  if (candidates.length === 0) return { candidates: [], needsAsk: false };

  const needsAsk = [newOrder, ...candidates].some(o => isReserved(o, today));
  return { candidates, needsAsk };
}

/**
 * 묶었을 때 그룹이 가질 출고예정일 — 가장 늦은 것.
 * 묶는다 = 한 번에 받는다. 먼저 넣은 주문을 나중 주문이 당기는 게 아니라 나중 주문에 맞춘다
 * (2026-09-29 결정. 그전엔 가장 빠른 날로 당겼다).
 * 긴급이 하나라도 있으면 긴급을 유지한다(묶였다고 급한 게 늦어지면 안 된다).
 */
export function groupShipTarget(orders) {
  const urgent = orders.some(o => o.isUrgent);
  const dates = orders.map(o => o.shipDate).filter(Boolean).sort();
  return { shipDate: dates[dates.length - 1] || null, isUrgent: urgent };
}

/** 확인창에 보여줄 선택지 — 그룹 안에 있는 서로 다른 출고예정일들 */
export function shipDateChoices(orders) {
  const seen = new Map();
  for (const o of orders) {
    const key = o.isUrgent ? "urgent" : (o.shipDate || "none");
    if (!seen.has(key)) seen.set(key, { key, shipDate: o.shipDate || null, isUrgent: !!o.isUrgent, orders: [] });
    seen.get(key).orders.push(o);
  }
  // 긴급 먼저, 그다음 날짜 빠른 순
  return [...seen.values()].sort((a, b) =>
    (b.isUrgent ? 1 : 0) - (a.isUrgent ? 1 : 0) || String(a.shipDate).localeCompare(String(b.shipDate)));
}
