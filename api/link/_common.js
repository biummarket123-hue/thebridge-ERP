// 링크 주문 서버 함수 공통 — service role 클라이언트, 테스트 키, 회사 user_id, 전화 인증 확인.
//
// 보안 경계(지시서 1절):
//  - service role 은 RLS 를 우회한다. 모든 조회·삽입에 코드가 직접 .eq("user_id", COMPANY_USER_ID) 를 건다.
//  - 요청마다 ?k= 테스트 키(LINK_TEST_KEY)를 본다. 불일치면 404 — 페이지가 있다는 사실도 안 알린다.
//  - 고객 정보는 인증된 전화번호(phone_verifications verified, 30분 이내)에만 준다.
//  - 전화번호·주소는 POST body 로만 받는다. GET 쿼리에 싣지 않는다.
import { createClient } from "@supabase/supabase-js";
import { normPhone, isVerifiedRecently, isMergeCandidate, VERIFY_WINDOW_MS } from "./_logic.js";

export const COMPANY_USER_ID = process.env.LINK_COMPANY_USER_ID || "";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TEST_KEY = process.env.LINK_TEST_KEY || "";

let client = null;
export function sb() {
  if (!client) client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  return client;
}

/** JSON 에러 응답. 메시지는 페이지가 그대로 보여준다. */
export const fail = (res, code, message) => res.status(code).json({ error: message });

/**
 * 테스트 키·환경변수 검사. 통과 못 하면 응답을 보내고 false.
 * 키가 없거나 다르면 404 — "준비 중" 페이지와 같은 뜻. 서버 설정이 빠졌으면 500 으로 구분해 알린다.
 */
export function gate(req, res) {
  const k = String(req.query?.k ?? req.body?.k ?? "");
  if (!TEST_KEY || !k || k !== TEST_KEY) { fail(res, 404, "not found"); return false; }
  if (!SUPABASE_URL || !SERVICE_KEY || !COMPANY_USER_ID) {
    console.error("[link] 환경변수 누락: VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / LINK_COMPANY_USER_ID");
    fail(res, 500, "서버 설정이 없습니다. 관리자에게 알려주세요.");
    return false;
  }
  return true;
}

/** 인증된 번호인가 — 30분 이내 verified 행. 숫자만 비교. */
export async function isPhoneVerified(phone) {
  const digits = normPhone(phone);
  if (digits.length < 10) return false;
  const since = new Date(Date.now() - VERIFY_WINDOW_MS).toISOString();
  const { data, error } = await sb().from("phone_verifications")
    .select("verified, created_at").eq("phone", digits).eq("verified", true).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(1);
  if (error) { console.error("[link] 인증 조회 실패", error); return false; }
  return isVerifiedRecently(data || []);
}

/** 전화번호 패턴 — 저장 형식("010-1234-5678" / "01012345678")이 섞여 있어 ilike 로 좁힌 뒤 숫자로 다시 맞춘다. */
function phonePattern(digits) {
  const mid = digits.slice(3, 7), last = digits.slice(-4);
  return `%${mid}%${last}`;
}

/** 전화번호로 고객 1건. 없으면 null. */
export async function findCustomerByPhone(phone) {
  const digits = normPhone(phone);
  const { data, error } = await sb().from("customers")
    .select("id, name, nickname, phone, address, address_detail")
    .eq("user_id", COMPANY_USER_ID).ilike("phone", phonePattern(digits)).limit(20);
  if (error) throw error;
  const hit = (data || []).filter(c => normPhone(c.phone) === digits);
  return hit[0] || null;
}

/** 같은 전화번호의 합배송 후보 주문들(미출고·환불 아님·분리 아님). */
export async function findMergeCandidates(phone) {
  const digits = normPhone(phone);
  const { data, error } = await sb().from("orders")
    .select("id, date, phone, status, payment, payment_status, split_shipping, merge_group_id, ship_date, is_urgent, items, address, address_detail")
    .eq("user_id", COMPANY_USER_ID).neq("status", "출고완료").ilike("phone", phonePattern(digits))
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data || []).filter(o => isMergeCandidate(o, digits));
}

/** 이름으로 무료배송권 — 같은 이름 고객 수와 배송권 행. 판정은 _logic.couponCountFor. */
export async function couponRowsFor(name) {
  const n = String(name || "").trim();
  if (!n) return { sameNameCount: 0, rows: [] };
  const [c, f] = await Promise.all([
    sb().from("customers").select("id", { count: "exact", head: true }).eq("user_id", COMPANY_USER_ID).eq("name", n),
    sb().from("free_shipping_coupons").select("count").eq("user_id", COMPANY_USER_ID).eq("customer", n),
  ]);
  if (c.error) throw c.error;
  if (f.error) throw f.error;
  return { sameNameCount: c.count || 0, rows: f.data || [] };
}

/** 이름으로 적립금 — 같은 이름 고객 수와 credits 행(amount, type). 판정은 _logic.creditBalanceFor. */
export async function creditRowsFor(name) {
  const n = String(name || "").trim();
  if (!n) return { sameNameCount: 0, rows: [] };
  const [c, cr] = await Promise.all([
    sb().from("customers").select("id", { count: "exact", head: true }).eq("user_id", COMPANY_USER_ID).eq("name", n),
    sb().from("credits").select("amount, type").eq("user_id", COMPANY_USER_ID).eq("customer", n),
  ]);
  if (c.error) throw c.error;
  if (cr.error) throw cr.error;
  return { sameNameCount: c.count || 0, rows: cr.data || [] };
}

/** 담당자 id(uuid) → 이름. 없거나 모양이 아니면 "". 회사(user_id)로 한 번 더 묶는다. */
export async function findManagerNameById(id) {
  const n = String(id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n)) return "";
  const { data, error } = await sb().from("managers").select("name").eq("user_id", COMPANY_USER_ID).eq("id", n).maybeSingle();
  if (error) { console.warn("[link] 담당자 조회 실패(무시)", error); return ""; }
  return data?.name || "";
}

/** 품번으로 상품 1건(대소문자 무시). 없으면 null. */
export async function findProductByCode(code) {
  const c = String(code || "").trim();
  if (!c) return null;
  const { data, error } = await sb().from("products")
    .select("id, code, name, color, photo_url, unit, unit_price")
    .eq("user_id", COMPANY_USER_ID).ilike("code", c.replace(/[%_]/g, "")).limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/** 그 품번의 판매 가능 롤들(잔량). */
export async function findAvailableRolls(productId) {
  const { data, error } = await sb().from("stock_rolls")
    .select("id, roll_code, status, length_remaining").eq("user_id", COMPANY_USER_ID).eq("product_id", productId).eq("status", "available");
  if (error) throw error;
  return data || [];
}

/** 설정 data (settings.data). 없으면 null. */
export async function fetchSettingsData() {
  const { data, error } = await sb().from("settings").select("data").eq("user_id", COMPANY_USER_ID).maybeSingle();
  if (error) { console.warn("[link] 설정 조회 실패", error); return null; }
  return data?.data || null;
}
