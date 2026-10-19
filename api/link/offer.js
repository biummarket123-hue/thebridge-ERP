// GET /api/link/offer?t={토큰}&k=...   셀러 링크(쪽지)의 주문서.
// 토큰이 곧 인증이다 — 쪽지로 그 사람에게만 갔다. 그래서 주소까지 그대로 준다.
//   200 주문서 · 404 없는 토큰 · 410 만료(status 를 expired 로 바꾼다) · 409 이미 확인(new/converted)
import { gate, fail, sb, COMPANY_USER_ID } from "./_common.js";
import { isValidToken, offerState, offerView, summarizeItems } from "./_logic.js";

export async function findOfferByToken(token) {
  const { data, error } = await sb().from("link_order_drafts").select("*").eq("user_id", COMPANY_USER_ID).eq("token", token).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function expireOffer(row) {
  const { error } = await sb().from("link_order_drafts").update({ status: "expired" }).eq("id", row.id).eq("user_id", COMPANY_USER_ID).eq("status", "offered");
  if (error) console.warn("[link/offer] 만료 표시 실패", error);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  if (!gate(req, res)) return;
  const token = String(req.query?.t || "").trim();
  if (!isValidToken(token)) return fail(res, 404, "주문서를 찾을 수 없습니다");
  try {
    const row = await findOfferByToken(token);
    const state = offerState(row);
    if (state === "missing") return fail(res, 404, "주문서를 찾을 수 없습니다");
    if (state === "confirmed") return fail(res, 409, "이미 주문하셨습니다.");
    if (state === "expired") { if (row.status === "offered") await expireOffer(row); return fail(res, 410, "링크가 만료되었습니다. 셀러에게 다시 요청해 주세요."); }
    if (state === "closed") return fail(res, 410, "더 이상 쓸 수 없는 주문서입니다. 셀러에게 다시 요청해 주세요.");

    // 합배송 대상 주문 — 날짜·품목 요약만. 그 고객 본인의 주문이다.
    let mergeWith = null;
    if (row.merge_with_order_id) {
      const { data } = await sb().from("orders").select("id, date, items, status").eq("user_id", COMPANY_USER_ID).eq("id", row.merge_with_order_id).limit(1);
      const o = data?.[0];
      if (o && o.status !== "출고완료") mergeWith = { id: o.id, date: o.date || "", items: summarizeItems(o.items) };
    }
    // 품목 사진 — products 에서. 없어도 그만.
    const ids = [...new Set((Array.isArray(row.items) ? row.items : []).map(i => i?.productId).filter(Boolean))];
    let photos = {};
    if (ids.length) {
      const { data } = await sb().from("products").select("id, photo_url").eq("user_id", COMPANY_USER_ID).in("id", ids);
      photos = Object.fromEntries((data || []).map(p => [p.id, p.photo_url || ""]));
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(offerView(row, { mergeWith, photos }));
  } catch (e) {
    console.error("[link/offer]", e);
    return fail(res, 500, "주문서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
