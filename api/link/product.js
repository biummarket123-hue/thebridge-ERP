// GET /api/link/product?code=LH-2609-0142&k=...
// 공개 주문 페이지의 첫 화면 — 품번 하나의 이름·사진·단가·지금 주문 가능 최대(가장 긴 롤)·기본 택배비.
// 인증 없이 준다(상품 정보는 밴드 게시글에도 있는 것). 고객 정보는 여기서 절대 안 섞인다.
import { gate, fail, findProductByCode, findAvailableRolls, fetchSettingsData } from "./_common.js";
import { productView, baseFeeFromSettings } from "./_logic.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  if (!gate(req, res)) return;
  const code = String(req.query?.code || "").trim();
  if (!code) return fail(res, 400, "품번이 없습니다");
  try {
    const product = await findProductByCode(code);
    if (!product) return fail(res, 404, "상품을 찾을 수 없습니다");
    const [rolls, settings] = await Promise.all([findAvailableRolls(product.id), fetchSettingsData()]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(productView(product, rolls, baseFeeFromSettings(settings)));
  } catch (e) {
    console.error("[link/product]", e);
    return fail(res, 500, "상품 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
