// GET /api/roll?code=LH-2610-0002-R01
// 롤 QR 을 핸드폰으로 찍었을 때 열리는 공개 화면(/r/{롤번호})의 데이터 — 원단명·색상·사진·단가·이 롤의 남은 길이·롤 가격.
// 창고를 둘러보는 방문 고객이 쓴다. 로그인이 없다 — 롤 번호만 알면 누구나 본다.
//
// 보여주는 것: 원단(품번·이름·색상·사진·단위), 마당 단가, 이 롤의 남은 길이, 롤 가격(남은 길이 × 마당 단가).
// 보여주지 않는 것(2026-10-02 결정): 공급처·창고 위치·입고일·검단자·매입가. 응답에 아예 싣지 않는다.
// 모양은 순수 함수 rollPublicView(link/_logic.js)가 정한다 — 여기는 조회만 한다.
import { sb, fail, COMPANY_USER_ID } from "./link/_common.js";
import { rollPublicView } from "./link/_logic.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export default async function handler(req, res) {
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  const code = String(req.query?.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,40}$/.test(code)) return fail(res, 404, "롤을 찾을 수 없습니다");
  if (!SUPABASE_URL || !SERVICE_KEY || !COMPANY_USER_ID) {
    console.error("[roll] 환경변수 누락: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / LINK_COMPANY_USER_ID");
    return fail(res, 500, "준비 중입니다. 직원에게 물어봐 주세요.");
  }
  try {
    const { data: roll, error } = await sb().from("stock_rolls")
      .select("roll_code, status, length_remaining, product_id")
      .eq("user_id", COMPANY_USER_ID).eq("roll_code", code).maybeSingle();
    if (error) throw error;
    if (!roll) return fail(res, 404, "롤을 찾을 수 없습니다");
    const { data: product, error: pErr } = await sb().from("products")
      .select("code, name, color, photo_url, unit, unit_price")
      .eq("user_id", COMPANY_USER_ID).eq("id", roll.product_id).maybeSingle();
    if (pErr) throw pErr;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(rollPublicView(roll, product));
  } catch (e) {
    console.error("[roll]", e);
    return fail(res, 500, "정보를 불러오지 못했습니다. 잠시 후 다시 찍어 주세요.");
  }
}
