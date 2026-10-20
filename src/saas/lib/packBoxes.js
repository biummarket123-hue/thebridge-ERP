// 포장대 화면의 순수 계산 — 주문 → 박스(합배송 묶음) 만들기, 칸 나누기, 지표, 품목 포장 상태.
// DB 도 React 도 없다. 옛 PackingTab.buildUnits / summarize 의 판정을 그대로 옮겼고, tests/saas/test-pack-rules.mjs 가 돈다.
//
// "박스(row)" 모양은 lib/packing.js 가 기대하는 { key, orders:[...], allPacked, parked, held } 에 칸·진행 정보를 더한 것이다.
import { shipBucket, ymd, parseYmd } from "../../lib/shipDate.js";
import { scanStats, packingOf } from "../../lib/packing.js";

// constants.js 의 isHold·isParked·isFabricMissing·missingItemIdx 와 같은 판정. 여기서 constants.js 를 안 부르는 이유:
// 테스트가 DB·브라우저 없이 node 로 돌아야 해서 import 사슬을 짧게 둔다. 정의가 바뀌면 여기도 맞춘다.
export const isHold = (o) => !!o && (!!o.isHolding || o.status === "보관");
export const isParked = (o) => !!o && !!o.isParked;
export const isFabricMissing = (o) => !!o && !!o.fabricMissing && o.status !== "출고완료";
export const missingItemIdx = (o) => {
  if (!isFabricMissing(o)) return [];
  const n = (o?.items || []).length;
  return (o.fabricMissingItems || []).filter(i => Number.isInteger(i) && i >= 0 && i < n);
};
/** db.itemsSig 와 같은 식 — "원단|색|수량|단위" 지문. 화면은 db.itemsSig 를 sigOf 로 넘기고, 테스트는 이 기본값을 쓴다. */
export const itemsSigLocal = (items) => (items || [])
  .map(i => `${(i.fabric || "").trim()}|${(i.color || "").trim()}|${i.qty || 0}|${i.unit || "마"}`).join("~");

const BLOCKING_PAY = new Set(["미입금", "부분입금", "환불신청"]);
const payOf = (o) => o?._computed?.paymentStatus || o?.payment || "미입금";

/** 주문 → 작업 단위(합배송 묶음은 한 박스). splitShipping 은 같은 묶음이어도 따로. 출고완료는 뺀다. */
export function buildUnits(orders) {
  const units = [];
  const byGroup = new Map();
  for (const o of orders || []) {
    if (!o || o.status === "출고완료") continue;
    if (!o.mergeGroupId || o.splitShipping) { units.push({ key: `o:${o.id}`, orders: [o], merged: false }); continue; }
    let u = byGroup.get(o.mergeGroupId);
    if (!u) { u = { key: `g:${o.mergeGroupId}`, orders: [], merged: true }; byGroup.set(o.mergeGroupId, u); units.push(u); }
    u.orders.push(o);
  }
  return units;
}

/** 박스 하나의 상태 요약 — 칸, 보관·보류, 완료 여부, 포장 후 수정, 밀린 날수. */
function summarize(unit, today, sigOf) {
  const os = unit.orders;
  const buckets = os.map(o => shipBucket(o, today));
  let bucket = buckets.includes("urgent") ? "urgent" : buckets.includes("today") ? "today" : buckets.includes("tomorrow") ? "tomorrow" : "later";

  const unpaid = os.filter(o => BLOCKING_PAY.has(payOf(o)));
  const held = os.some(isHold);
  const heldDone = held && os.some(o => isHold(o) && o.heldAt);   // 창고에 넣었다 — 보관중
  const holdPending = held && !heldDone;                            // 보관 요청만 — 포장직원이 넣어야 한다
  const shipRequested = !held && os.some(o => o.shipRequestedAt);
  const parked = os.some(isParked);
  const parkReason = os.filter(isParked).map(o => (o.parkReason || "").trim()).filter(Boolean)[0] || "";
  const fabricMissing = os.some(isFabricMissing);

  const packed = os.filter(o => o.status === "포장완료");
  const allPacked = packed.length === os.length;
  const mergeRepack = unit.merged && packed.length > 0 && !allPacked;
  const editedAfterPack = packed.some(o => o.packedSig && o.packedSig !== sigOf(o.items));
  const needsRepack = mergeRepack || editedAfterPack;

  const t = ymd(today);
  const earliest = os.map(o => o.shipDate).filter(Boolean).sort()[0] || null;
  const overdueDays = (!held && !parked && !shipRequested && earliest && earliest < t)
    ? Math.round((parseYmd(t) - parseYmd(earliest)) / 86400000) : 0;
  if (overdueDays >= 1) bucket = "urgent";
  if (shipRequested) bucket = "today";

  return {
    bucket, held, heldDone, holdPending, shipRequested, parked, parkReason, fabricMissing,
    allPacked, mergeRepack, editedAfterPack, needsRepack, overdueDays, payBlocked: unpaid.length > 0,
    sortDate: earliest || t,
    createdAt: os.reduce((mn, o) => { const v = o.createdAt || ""; return !mn || (v && v < mn) ? v : mn; }, ""),
    packedAt: os.reduce((mx, o) => ((o.packedAt || "") > mx ? o.packedAt : mx), ""),
    customer: os[0]?.customer || "",
  };
}

/**
 * 주문 목록 + 포장 기록 → 박스 목록.
 *   today  기준 날짜(테스트용)   sigOf  품목 지문 함수(화면은 db.itemsSig)
 * 각 박스: { key, orders, merged, bucket, held, heldDone, holdPending, parked, allPacked, editedAfterPack, …, scanTotal, scanDone }
 */
export function buildBoxes(orders, packingByOrder, { today = new Date(), sigOf = itemsSigLocal } = {}) {
  return buildUnits(orders).map(u => ({ ...u, ...summarize(u, today, sigOf), ...scanStats(u.orders, packingByOrder) }));
}

const byDateThenReg = (a, b) => a.sortDate.localeCompare(b.sortDate) || a.createdAt.localeCompare(b.createdAt);

/**
 * 박스들을 탭으로 나눈다.
 *   queue.{urgent,today,tomorrow,later}  아직 포장할 박스(보관 요청·보관중·보류 제외)
 *   done   포장완료(포장 후 수정된 것도 여기 — 경고 배지로 알린다)  · 최근 포장 순
 *   hold   보관 요청만 있고 아직 창고에 안 넣은 박스 — "창고에 넣음"을 기다린다
 *   hidden 보관중(heldAt)·보류 — 포장대 목록에서 뺀다
 */
export function splitBoxes(rows) {
  const queue = { urgent: [], today: [], tomorrow: [], later: [] };
  const done = [], hold = [], hidden = [];
  for (const r of rows || []) {
    if (r.parked || r.heldDone) { hidden.push(r); continue; }
    if (r.holdPending) { hold.push(r); continue; }
    if (r.allPacked) { done.push(r); continue; }
    queue[r.bucket].push(r);
  }
  for (const k of Object.keys(queue)) queue[k].sort(byDateThenReg);
  done.sort((a, b) => (b.packedAt || "").localeCompare(a.packedAt || ""));
  hold.sort(byDateThenReg);
  return { queue, done, hold, hidden, queueAll: [...queue.urgent, ...queue.today, ...queue.tomorrow, ...queue.later] };
}

/** 상단 지표 — 오늘 포장할 박스(긴급+당일), 찍은 품목/전체(대기 전체), 보관 요청, 원단 없음 박스. */
export function packMetrics(split, today = new Date()) {
  const t = ymd(today);
  const q = split.queueAll;
  let itemsDone = 0, itemsTotal = 0;
  for (const r of q) { itemsDone += r.scanDone; itemsTotal += r.scanTotal; }
  return {
    boxesToday: split.queue.urgent.length + split.queue.today.length,
    boxesAll: q.length,
    itemsDone, itemsTotal,
    holdRequests: split.hold.length,
    fabricMissing: q.filter(r => r.fabricMissing).length,
    doneToday: split.done.filter(r => r.packedAt && ymd(new Date(r.packedAt)) === t).length,
    editedAfterPack: split.done.filter(r => r.editedAfterPack).length,
  };
}

/**
 * 품목 한 줄의 포장 상태 배지.
 *   kind: "roll"(롤 찍음) · "override"(롤 없이) · "missing"(원단 없음 호출 중) · "none"(미기록) · "legacy"(품목 id 없는 옛 주문)
 */
export function itemPackState(order, itemIdx, packingByOrder) {
  const item = (order?.items || [])[itemIdx];
  if (!item) return { kind: "none", label: "미기록", tone: "gray" };
  if (!item.itemId) return { kind: "legacy", label: "옛 주문 · 기록 없음", tone: "gray" };
  const rec = packingOf(packingByOrder, order.id, item.itemId);
  if (rec) {
    if (rec.rollId || rec.rollCode) {
      const len = rec.wholeRoll ? "롤 통째" : `${rec.length ?? ""}${item.unit || "마"}`;
      return { kind: "roll", label: `${rec.rollCode || "롤"} · ${len}`, tone: "done", rec };
    }
    return { kind: "override", label: `롤 없이${rec.overrideReason ? ` · ${rec.overrideReason}` : ""}`, tone: "purple", rec };
  }
  if (missingItemIdx(order).includes(itemIdx)) return { kind: "missing", label: "원단 없음", tone: "late" };
  return { kind: "none", label: "미기록", tone: "gray" };
}

/** 검색 — 고객·전화·원단·품번·주문번호. */
export function filterBoxes(rows, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return rows;
  const digits = s.replace(/\D/g, "");
  return rows.filter(r => r.orders.some(o =>
    String(o.customer || "").toLowerCase().includes(s)
    || (digits.length >= 3 && String(o.phone || "").replace(/\D/g, "").includes(digits))
    || String(o.id).toLowerCase().startsWith(s)
    || (o.items || []).some(it => `${it.fabric || ""} ${it.color || ""} ${it.itemNo || ""}`.toLowerCase().includes(s))));
}

/** 박스 제목 — "홍길동 외 2건" */
export const boxTitle = (row) => `${row.orders[0]?.customer || "고객"}${row.orders.length > 1 ? ` 외 ${row.orders.length - 1}건` : ""}`;
