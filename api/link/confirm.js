// POST /api/link/confirm?k=...   body { token, qty?, address?, addressDetail?, deliveryMessage? }
// 고객이 "네, 이대로 주문할게요"를 눌렀다 — offered → new, confirmed_at. 고객이 고친 값(주소·메모·수량 줄이기)만 반영.
//   200 { ok, draftId } · 404 없는 토큰 · 410 만료 · 409 이미 확인 · 400 수량 문제
// orders 에는 쓰지 않는다. 셀러가 ERP 에서 전환한다.
import { gate, fail, sb, COMPANY_USER_ID, findAvailableRolls } from "./_common.js";
import { isValidToken, offerState, cleanConfirmInput, confirmQtyCheck, maxRemainingOf, maxFor, computeTotal } from "./_logic.js";
import { findOfferByToken, expireOffer } from "./offer.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  if (!gate(req, res)) return;
  const input = cleanConfirmInput(req.body);
  if (!isValidToken(input.token)) return fail(res, 404, "주문서를 찾을 수 없습니다");
  try {
    const row = await findOfferByToken(input.token);
    const state = offerState(row);
    if (state === "missing") return fail(res, 404, "주문서를 찾을 수 없습니다");
    if (state === "confirmed") return fail(res, 409, "이미 주문하셨습니다.");
    if (state === "expired") { if (row.status === "offered") await expireOffer(row); return fail(res, 410, "링크가 만료되었습니다. 셀러에게 다시 요청해 주세요."); }
    if (state === "closed") return fail(res, 410, "더 이상 쓸 수 없는 주문서입니다. 셀러에게 다시 요청해 주세요.");

    const patch = { status: "new", confirmed_at: new Date().toISOString(), privacy_agreed_at: new Date().toISOString() };
    if (input.address !== null) { patch.address = input.address; patch.address_detail = input.addressDetail ?? ""; }
    if (input.deliveryMessage !== null) patch.delivery_message = input.deliveryMessage;

    // 수량 — 품목이 하나일 때만 고칠 수 있다(여러 품목이면 셀러에게). 줄이는 것만. 최대 재단 가능 재검증.
    if (input.qty !== null) {
      const items = Array.isArray(row.items) ? row.items : [];
      if (items.length > 1) return fail(res, 400, "품목이 여러 개인 주문서는 수량을 바꿀 수 없습니다. 셀러에게 말씀해 주세요.");
      const rolls = await findAvailableRolls(row.product_id);
      const unit = row.unit || "마";
      const q = confirmQtyCheck(input.qty, row.qty, maxFor(unit, maxRemainingOf(rolls)), unit);
      if (!q.ok) return fail(res, 400, q.reason);
      patch.qty = q.value;
      if (items.length === 1) patch.items = [{ ...items[0], qty: q.value, amount: items[0].unitPrice ? Math.round(Number(items[0].unitPrice) * q.value) : items[0].amount }];
      const unitPrice = row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price);
      patch.total_amount = computeTotal(unitPrice, q.value, row.shipping_fee).total;
    }

    // offered 인 행만 바꾼다 — 두 번 누르면(경쟁) 0행 → 409
    const { data, error } = await sb().from("link_order_drafts").update(patch)
      .eq("id", row.id).eq("user_id", COMPANY_USER_ID).eq("status", "offered").select("id");
    if (error) throw error;
    if (!data || data.length === 0) return fail(res, 409, "이미 주문하셨습니다.");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, draftId: row.id });
  } catch (e) {
    console.error("[link/confirm]", e);
    return fail(res, 500, "주문 접수에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
