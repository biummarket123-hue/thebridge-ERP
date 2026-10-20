// 포장대 동작 — 스캔 1회 판정(롤 조회까지), 재단 기록, 롤 없이 포장, 포장 취소, 박스 포장완료·취소, 보관 확정, 원단 호출.
// 순수 판정은 lib/packing.js 가 하고, 여기는 DB 호출과 사람이 읽을 메시지만 만든다. React 는 없다.
//
// 재고 차감은 롤을 찍는 순간(packFromRoll → RPC pack_item_from_roll) 일어난다. 출고완료는 여기서 하지 않는다(ShipFlow).
// 포장완료는 사람이 버튼을 눌러 확정한다(2026-10-15 사용자 결정) — markBoxPacked.
import * as db from "../../lib/db.js";
import {
  parseScan, resolveScan, resolveItemScan, resolvePendingRoll, autoCutPlan, allItemsPacked, parseCutLength, productOfItem, rollsForProduct,
} from "../../lib/packing.js";
import { fmtLen, isRollUnit, rollErrorText } from "../../lib/rollStock.js";
import { setStatus } from "./orders.js";
import { missingItemIdx } from "../lib/packBoxes.js";

export const ALL_DONE_HINT = "모두 찍었습니다 — 📦 포장완료 버튼을 눌러 확정하세요";
export const PENDING_MS = 120000;   // 라벨 QR 뒤 롤 QR 을 기다리는 시간

export const itemName = (item) => `${item?.fabric || ""}${item?.color ? ` ${item.color}` : ""}`.trim() || "품목";
export const errText = (e) => rollErrorText(e) || e?.message || String(e);

/** 품목이 정해진 뒤 — 바로 자를지(auto), 확인창인지(confirm), 거부인지. 2026-10-02 결정: 주문 수량대로 바로 기록. */
export function planCut(roll, product, candidate) {
  const plan = autoCutPlan(candidate.item, roll);
  if (plan.reject) return { kind: "reject", message: plan.reason };
  if (plan.auto) return { kind: "auto", roll, product, candidate, len: plan.len, whole: plan.whole };
  return {
    kind: "confirm", roll, product, candidate, reason: plan.reason,
    defaultLen: candidate.item?.qty ? String(candidate.item.qty) : "",
    defaultWhole: isRollUnit(candidate.item?.unit),
  };
}

/**
 * 스캔 한 번의 판정. 기록은 하지 않는다 — 화면이 결과에 따라 바로 기록하거나 창을 띄운다.
 *   raw            스캐너·입력칸의 원문
 *   rows           박스 전부(완료·보관 포함)   visibleRows  지금 탭의 박스들   activeRow  사람이 누른 박스(없으면 null)
 *   pending        라벨 QR 을 먼저 찍어 둔 품목 { candidate, product, rolls, at } 또는 null
 * 반환:
 *   null                                   빈 값
 *   { kind:"reject", message, hint?, revealKey? }
 *   { kind:"pending", pending, message, hint }   라벨 QR — 롤 QR 을 이어서 찍어야 한다
 *   { kind:"auto", roll, product, candidate, len, whole }
 *   { kind:"confirm", roll, product, candidate, reason, defaultLen, defaultWhole }
 *   { kind:"choose", roll, product, candidates }
 */
export async function decideScan(raw, { rows, visibleRows, activeRow, packingByOrder, productById, rolls, pending }) {
  const parsed = parseScan(raw);
  if (!parsed) return null;
  if (parsed.kind === "item") {
    const res = resolveItemScan({ key: parsed.key, rows, packingByOrder, products: productById, rolls });
    if (res.kind === "reject") return { kind: "reject", message: res.message, hint: res.hint, revealKey: res.candidate?.row?.key };
    if (res.kind === "pack") return planCut(res.roll, res.product, res.candidate);
    const c = res.candidate;
    return {
      kind: "pending",
      pending: { candidate: c, product: res.product, rolls: res.kind === "pick-roll" ? res.rolls : [], at: Date.now() },
      message: `${c.order.customer} · ${itemName(c.item)} — ${res.kind === "pick-roll" ? `진행 중인 롤이 ${res.rolls.length}개입니다` : "진행 중인 롤이 없습니다"}`,
      hint: res.kind === "pick-roll" ? "자른 롤의 QR 을 이어서 찍어 주세요" : "롤 QR 을 찍거나 '롤 없이 포장'으로 기록해 주세요",
    };
  }
  const code = parsed.code;
  let roll = (rolls || []).find(r => r.rollCode === code) || null;
  if (!roll) {
    try { roll = await db.findRollByCode(code); }
    catch (e) { return { kind: "reject", message: "롤 조회 실패: " + errText(e) }; }
  }
  if (!roll) return { kind: "reject", message: `등록되지 않은 롤 코드: ${code}` };
  const product = productById?.get(roll.productId) || null;
  if (pending) {
    const res = resolvePendingRoll({ pending, roll, product });
    if (res.kind === "reject") return { kind: "reject", message: res.message, hint: res.hint };
    return planCut(roll, product, res.candidate);
  }
  const res = resolveScan({ roll, product, activeRow, visibleRows, allRows: rows, packingByOrder });
  if (res.kind === "reject") return { kind: "reject", message: res.message, hint: res.hint };
  if (res.kind === "confirm") return planCut(roll, product, res.candidate);
  return { kind: "choose", roll, product, candidates: res.candidates };
}

/** 재단 확인창의 입력 검사 — { ok, len } 또는 { ok:false, reason } */
export function validateCut(cutLen, whole, roll) {
  if (whole) return Number(roll?.lengthRemaining) > 0 || roll?.lengthRemaining == null ? { ok: true, len: null } : { ok: false, reason: "롤 잔량이 없습니다" };
  const p = parseCutLength(cutLen);
  if (!p.ok) return { ok: false, reason: p.reason };
  if (roll?.lengthRemaining != null && p.value > Number(roll.lengthRemaining)) return { ok: false, reason: `잔량이 부족합니다 — 남은 ${fmtLen(roll.lengthRemaining)}` };
  return { ok: true, len: p.value };
}

/** 롤 고르기 창의 후보 — 품번이 없으면 null(롤 없이 포장으로 안내). */
export function rollChoices(item, productById, rolls) {
  const product = productOfItem(item, productById);
  if (!product) return null;
  return { product, rolls: rollsForProduct(product, rolls, { forWhole: isRollUnit(item?.unit) }) };
}

/**
 * 롤을 찍어 기록 — RPC(잔량 차감 + 포장 기록, 한 트랜잭션). 원단 호출이 걸려 있던 품목이면 푼다(롤을 찍었다 = 원단이 왔다).
 * 반환 { rec, msg, allDone }
 */
export async function packFromRoll(candidate, roll, len, whole, { activeManager, packingByOrder, reloadOrders }) {
  const { row, order, item, itemIdx } = candidate;
  const rec = await db.packItemFromRoll(order.id, item.itemId, roll.id, len, whole, activeManager);
  if (missingItemIdx(order).includes(itemIdx)) {
    try { await db.clearFabricItem(order, itemIdx); await reloadOrders?.(); }
    catch (e) { console.warn("[포장대] 원단 호출 해제 실패", e); }
  }
  const allDone = allItemsPacked(row, packingByOrder, [{ orderId: order.id, itemId: item.itemId }]);
  const msg = `✅ ${order.customer} · ${itemName(item)} ${fmtLen(rec.length)}${item.unit || "마"} — ${roll.rollCode}${whole ? " (롤 통째)" : ""}${allDone ? ` · ${ALL_DONE_HINT}` : ""}`;
  return { rec, msg, allDone };
}

/** 롤 없이 포장 — 옛 재고·외주·급한 건. 사유 없이는 저장하지 않는다. */
export async function packWithoutRoll(candidate, reason, { activeManager, packingByOrder, reloadOrders }) {
  const { row, order, item, itemIdx } = candidate;
  const why = String(reason || "").trim();
  if (!why) throw new Error("롤 없이 포장한 사유를 적어 주세요");
  const rec = await db.packItemOverride(order.id, item.itemId, why, activeManager);
  if (missingItemIdx(order).includes(itemIdx)) {
    try { await db.clearFabricItem(order, itemIdx); await reloadOrders?.(); }
    catch (e) { console.warn("[포장대] 원단 호출 해제 실패", e); }
  }
  const allDone = allItemsPacked(row, packingByOrder, [{ orderId: order.id, itemId: item.itemId }]);
  return { rec, allDone, msg: `✅ 롤 없이 포장 — ${order.customer} · ${itemName(item)} · ${why}${allDone ? ` · ${ALL_DONE_HINT}` : ""}` };
}

/**
 * 품목 포장 취소. 잘라 낸 원단은 원래 롤로 못 돌아가므로 사람이 고른다:
 *   asPiece=false  아직 안 잘랐음 → 롤에 길이를 되돌린다(unpack_item). 롤 없이 포장한 기록도 이 길로 지운다.
 *   asPiece=true   이미 잘랐음    → 조각 롤을 만든다(unpack_item_cut) + 사유 필수
 */
export async function unpackItem(order, item, { asPiece = false, reason = "" } = {}, { activeManager }) {
  const name = itemName(item);
  if (asPiece) {
    const why = String(reason || "").trim();
    if (!why) throw new Error("사유를 적어 주세요 — 조각 롤에 남습니다");
    const piece = await db.unpackItemAsPiece(order.id, item.itemId, why, activeManager);
    return { piece, msg: piece ? `포장 취소 — ${name} · 조각 롤 ${piece.rollCode} ${fmtLen(piece.lengthRemaining)}${item.unit || "마"} 입고` : `포장 취소 — ${name}` };
  }
  await db.unpackItem(order.id, item.itemId, activeManager);
  return { piece: null, msg: `포장 취소 — ${name}` };
}

/**
 * 박스 포장완료 — 묶음 전부(합배송) act.setStatus("포장완료"). 중간에 실패하면 이미 바뀐 건을 되돌린다
 * (반만 바뀌면 '일부만 포장됨' = 재포장으로 잘못 뜬다). ctx = { orders, managers, activeManager, isAdmin, isPacker }.
 */
export async function markBoxPacked(row, ctx) { return setBoxStatus(row, "포장완료", ctx); }
/** 포장완료 취소 — 접수로. */
export async function unmarkBoxPacked(row, ctx) { return setBoxStatus(row, "접수", ctx); }

async function setBoxStatus(row, status, ctx) {
  const changed = [];
  try {
    for (const o of row.orders) {
      if (o.status === status) continue;
      await setStatus(o, status, ctx);
      changed.push(o);
    }
    const who = `${row.orders[0]?.customer || ""}${row.orders.length > 1 ? ` 외 ${row.orders.length - 1}건` : ""}`;
    return { ok: true, msg: status === "포장완료" ? `📦 포장완료 — ${who}` : `포장완료 취소 — ${who} · 접수로 돌렸습니다` };
  } catch (e) {
    let rollbackFailed = false;
    for (const o of changed) {
      try { await db.updateOrder(o.id, { status: o.status, packedAt: o.packedAt, packedSig: o.packedSig }, { route: "포장 상태 되돌림 · 포장대" }); }
      catch { rollbackFailed = true; }
    }
    throw new Error(rollbackFailed
      ? `처리 실패 — 일부 주문이 중간 상태로 남았습니다. 관리자에게 알려주세요 (${e.message})`
      : `처리 실패 — 변경 없이 되돌렸습니다. 다시 눌러주세요 (${e.message})`);
  }
}

/** 보관 확정 — 포장직원이 원단을 창고에 넣으면서 held_at 을 찍는다(옛 PackingTab.setHold "done"). 묶음 전부. */
export async function confirmHold(row) {
  const at = new Date().toISOString();
  for (const o of row.orders) await db.updateOrder(o.id, { isHolding: true, heldAt: at }, { route: "보관 확정 · 포장대" });
  return { msg: `📦 보관 확정 — ${row.orders[0]?.customer || ""}${row.orders.length > 1 ? ` 외 ${row.orders.length - 1}건` : ""} · 보관중` };
}

/** 원단 없음 표시 토글 — 품목 한 줄 단위(옛 PackingTab.toggleFabric). 반환 { on, msg }. */
export async function toggleFabric(order, itemIdx, { productById }) {
  const on = missingItemIdx(order).includes(itemIdx);
  if (on) await db.clearFabricItem(order, itemIdx);
  else await db.callForFabric(order, itemIdx);
  const it = (order.items || [])[itemIdx];
  const who = productOfItem(it, productById)?.manager || order.manager || "담당자 없음";
  return { on: !on, msg: on ? `원단 받음 — ${itemName(it)}` : `🧶 원단 없음 — ${itemName(it)} · ${who}님에게 호출` };
}
