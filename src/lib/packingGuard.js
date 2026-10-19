// 주문이 없어지거나 되돌아가기 전에 포장 기록(order_item_packing)을 정리한다.
//
// 포장대에서 롤을 찍어 잘라 둔 원단은 롤 잔량에서 이미 빠져 있다. 그 주문을 그냥 지우거나
// 환불로 끝내면 포장 기록은 없는 주문을 가리키며 남고, 잘라 둔 원단은 장부 어디에도 없다
// (2026-10-13 점검 — 실제 DB 에 그런 고아 기록이 있었다). 주문 쪽 어느 경로도 포장 기록을
// 건드리지 않았기 때문에, 여기 한 곳에서 묻고 정리한다.
//
// 선택지는 둘뿐이다(사용자 결정 2026-10-13):
//   · 조각으로 되돌리기 — 잘라 둔 길이만큼 조각 롤을 만든다(통째면 그 롤이 되살아난다).
//                        롤 없이 포장한 기록은 지우기만 한다. db.unpackItemAsPiece.
//   · 그냥 지우기       — 기록만 지운다. 원단은 장부에서 사라진다(롤 잔량은 이미 빠져 있다).
// window.confirm 은 버튼이 둘뿐이라 두 번 묻는다: 첫 창 [확인]=되돌리기, [취소]→둘째 창
// [확인]=그냥 지우기, [취소]=돌아가기.
import * as db from "./db.js";

const fmt = (v) => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "?"; };

/**
 * @param orderId  주문 id
 * @param what     하려는 일 — 창 문구에 들어간다. 예: "주문 삭제", "환불 처리", "품목 삭제"
 * @param by       작업자 이름(원장에 남는다)
 * @param itemIds  이 품목들만 본다(수정창에서 줄을 지울 때). 없으면 주문 전체.
 * @param confirm  시험용 주입. 기본 window.confirm
 * @returns false = 사용자가 돌아가기를 골랐다. 그 외는 진행해도 된다 — true(정리할 것 없음·기록만 지움)
 *          또는 { ok: true, restored: [조각 롤 코드…] }(조각으로 되돌림).
 */
export async function settlePackingBefore(orderId, { what = "진행", by = "", itemIds = null, confirm = null } = {}) {
  const ask = confirm || ((msg) => window.confirm(msg));
  let recs;
  try { recs = await db.fetchItemPacking([orderId]); }
  catch (e) {
    // 포장 표가 없는 옛 DB 이거나 연결이 끊긴 것. 여기서 막으면 주문 삭제·환불이 통째로 안 된다 —
    // 기록이 있는지 모르는 채로 진행한다(전과 같은 동작).
    console.warn("[포장정리] 포장 기록 조회 실패 — 확인 없이 진행", e);
    return true;
  }
  const want = itemIds ? new Set(itemIds.map(String)) : null;
  recs = recs.filter(r => String(r.orderId) === String(orderId) && (!want || want.has(String(r.itemId))));
  if (recs.length === 0) return true;

  const withRoll = recs.filter(r => r.rollId);
  if (withRoll.length === 0) {
    // 롤 없이 포장한 기록(또는 롤이 지워진 기록)뿐 — 원단 장부와 무관하니 묻지 않고 기록만 지운다.
    await db.deleteItemPacking(orderId, recs.map(r => r.itemId));
    return true;
  }

  const lines = recs.map(r => r.rollId
    ? `  · ${r.rollCode || "롤"} ${r.wholeRoll ? "통째" : fmt(r.length) + "마"}`
    : `  · 롤 없이 포장${r.overrideReason ? ` (${r.overrideReason})` : ""}`).join("\n");
  const restore = ask(
    `${what} 전에 확인해 주세요 — 포장대에서 롤을 잘라 둔 품목이 ${withRoll.length}개 있습니다.\n\n${lines}\n\n` +
    `[확인] 잘라 둔 원단을 조각 롤로 되돌리고 ${what}\n` +
    `[취소] 되돌리지 않음 (다음 창에서 다시 고릅니다)`);
  if (restore) {
    const made = [];
    for (const r of recs) {
      const roll = await db.unpackItemAsPiece(orderId, r.itemId, `${what} — 원단 되돌림`, by);
      if (roll?.rollCode) made.push(roll.rollCode);
    }
    return { ok: true, restored: made };
  }
  const drop = ask(
    `원단을 되돌리지 않고 ${what}할까요?\n\n잘라 둔 원단은 장부에서 사라집니다 — 롤 잔량은 이미 빠져 있고, 조각 롤도 생기지 않습니다.\n\n` +
    `[확인] 기록만 지우고 ${what}\n[취소] 돌아가기`);
  if (!drop) return false;
  await db.deleteItemPacking(orderId, recs.map(r => r.itemId));
  return true;
}

/** settlePackingBefore 의 결과를 토스트 한 줄로. 되돌린 조각이 있을 때만 문구가 있다. */
export function settleMessage(res) {
  if (res && typeof res === "object" && res.restored?.length) return ` · 조각 롤 ${res.restored.join(", ")} 로 되돌림`;
  return "";
}
