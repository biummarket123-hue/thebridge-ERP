// 출고 안내 문자(/api/notify) — 출고완료 뒤 고객에게 "발송되었습니다" 문자를 보낸다.
//
// 왜 서버에서 하나: Coolsms 키는 브라우저에 두지 않는다. 그리고 문자는 건당 돈이 들어서
// 유료 구독 회사만(사용자 결정 2026-10-20) — api/_ai_gate.js 의 smsGate 로 판정한다(체험·데모 거부, SAAS_TRIAL_AI_CALLS 는 적용 안 함).
//
// 요청: POST { action: "ship", orderIds: [uuid…] }  Authorization: Bearer <Supabase access token>
// 응답: { sent, failed: [{ id, reason }], dev }   dev=true 면 COOLSMS 키가 없어 로그만 남긴 것.
//
// 읽는 것(service role): 그 유저의 orders(id in orderIds, user_id = user.id), settings.data.saas(notifySms, notifySmsTemplate),
// company_accounts.name. 템플릿 치환: {회사명} {고객명} {택배사} — 택배사는 orders.courier → shipped_via → "택배".
// 같은 주문에 10분 안에 두 번 보내지 않는다(메모리 Map — 서버 인스턴스마다 따로지만, 더블클릭·재시도 정도는 막힌다).
//
// 환경변수: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(필수), COOLSMS_API_KEY, COOLSMS_API_SECRET, COOLSMS_SENDER(발신번호)
import { createClient } from "@supabase/supabase-js";
import { smsGate } from "./_ai_gate.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VERIFY_KEY = SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const MAX_IDS = 200;
const DEDUPE_MS = 10 * 60 * 1000;
const DEFAULT_TEMPLATE = "[{회사명}] {고객명}님, 주문하신 상품이 {택배사}(으)로 발송되었습니다. 감사합니다.";

const recent = new Map();   // orderId → 마지막 발송 시각(ms)
function sentRecently(id, now) {
  const t = recent.get(id);
  if (t && now - t < DEDUPE_MS) return true;
  // 오래된 항목 정리 — 무한히 자라지 않게
  if (recent.size > 5000) for (const [k, v] of recent) if (now - v >= DEDUPE_MS) recent.delete(k);
  return false;
}

async function getSessionUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { user: null, reason: "no-token" };
  if (!SUPABASE_URL || !VERIFY_KEY) return { user: null, reason: "env-missing" };
  const sb = createClient(SUPABASE_URL, VERIFY_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.getUser(m[1]);
  if (error || !data?.user) return { user: null, reason: "invalid" };
  return { user: data.user, reason: null };
}

// Coolsms API (https://coolsms.co.kr) — api/sms-verify.js 와 같은 방식. 90바이트를 넘으면 LMS 로 보낸다.
const byteLen = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
async function sendSms(to, text) {
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_SENDER || "";
  if (!apiKey || !apiSecret || !from) {
    console.log(`[DEV] SMS to ${to}: ${text}`);
    return { success: true, dev: true };
  }
  const date = new Date().toISOString();
  const crypto = await import("crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hmac = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  const auth = `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${hmac}`;
  const res = await fetch("https://api.coolsms.co.kr/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ message: { to, from, text, type: byteLen(text) > 90 ? "LMS" : "SMS" } }),
  });
  const data = await res.json().catch(() => ({}));
  return { success: res.ok, data, error: res.ok ? "" : (data?.errorMessage || data?.message || `Coolsms ${res.status}`) };
}

const cleanPhone = (p) => String(p || "").replace(/[^0-9]/g, "");
const fill = (tpl, vars) => String(tpl || "").replace(/\{(회사명|고객명|택배사)\}/g, (_, k) => vars[k] ?? "");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Method not allowed" } });

  const { user, reason } = await getSessionUser(req);
  if (!user) {
    if (reason === "env-missing") {
      console.error("[notify] 세션 검증용 SUPABASE_URL/KEY 환경변수가 없습니다");
      return res.status(500).json({ error: { message: "서버 인증 설정이 없습니다. 관리자에게 알려주세요." } });
    }
    return res.status(401).json({ error: { message: "로그인 세션이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요." } });
  }
  if (!SERVICE_KEY) {
    console.error("[notify] SUPABASE_SERVICE_ROLE_KEY 가 없습니다");
    return res.status(500).json({ error: { message: "서버 설정이 없어 문자를 보낼 수 없습니다. 관리자에게 알려주세요." } });
  }

  const body = req.body || {};
  if (body.action !== "ship") return res.status(400).json({ error: { message: "Invalid action" } });
  const ids = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map(String).filter(Boolean))].slice(0, MAX_IDS);
  if (!ids.length) return res.status(400).json({ error: { message: "orderIds 가 비어 있습니다" } });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = new Date();

  // ── 유료 회사만 ──
  const { data: account, error: aErr } = await sb.from("company_accounts").select("*").eq("owner_id", user.id).maybeSingle();
  if (aErr) console.warn("[notify] company_accounts 읽기 실패(사내 계정으로 간주):", aErr.message);
  const gate = smsGate({ account: aErr ? null : account, now });
  if (!gate.allow) return res.status(403).json({ error: { message: gate.reason, code: "AI_NOT_ALLOWED" } });

  // ── 회사 설정 ──
  const { data: st, error: sErr } = await sb.from("settings").select("data").eq("user_id", user.id).maybeSingle();
  if (sErr) {
    console.error("[notify] settings 읽기 실패:", sErr.message);
    return res.status(500).json({ error: { message: "회사 설정을 읽지 못했습니다. 잠시 후 다시 시도해 주세요." } });
  }
  const saas = st?.data?.saas || {};
  if (!saas.notifySms) return res.status(400).json({ error: { message: "출고 안내 문자가 꺼져 있습니다. 회사 설정에서 켜 주세요." } });
  const template = String(saas.notifySmsTemplate || "").trim() || DEFAULT_TEMPLATE;
  const companyName = String(account?.name || saas.companyName || st?.data?.senderName || "").trim();

  // ── 주문 ──
  const { data: orders, error: oErr } = await sb.from("orders").select("id, customer, phone, courier, shipped_via").eq("user_id", user.id).in("id", ids);
  if (oErr) {
    console.error("[notify] orders 읽기 실패:", oErr.message);
    return res.status(500).json({ error: { message: "주문을 읽지 못했습니다. 잠시 후 다시 시도해 주세요." } });
  }
  const byId = new Map((orders || []).map(o => [String(o.id), o]));

  let sent = 0, dev = false;
  const failed = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) { failed.push({ id, reason: "주문을 찾을 수 없습니다" }); continue; }
    const to = cleanPhone(o.phone);
    if (to.length < 10) { failed.push({ id, reason: "전화번호 없음" }); continue; }
    if (sentRecently(id, now.getTime())) { failed.push({ id, reason: "10분 안에 이미 보냈습니다" }); continue; }
    const text = fill(template, { 회사명: companyName, 고객명: String(o.customer || "고객").trim(), 택배사: o.courier || o.shipped_via || "택배" });
    try {
      const r = await sendSms(to, text);
      if (r.success) { sent += 1; recent.set(id, now.getTime()); if (r.dev) dev = true; }
      else { console.warn(`[notify] ${id} 발송 실패:`, r.error); failed.push({ id, reason: r.error || "발송 실패" }); }
    } catch (e) {
      console.warn(`[notify] ${id} 발송 오류:`, e?.message || e);
      failed.push({ id, reason: e?.message || "발송 오류" });
    }
  }
  return res.status(200).json({ sent, failed, dev });
}
