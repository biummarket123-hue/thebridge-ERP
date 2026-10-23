// 휴대폰 인증번호 — /api/sms-verify  POST { action: "send" | "verify", phone, code? }
// 공개 주문 링크(src/public/OrderLink.jsx)와 회사 가입(src/saas/auth/SaasAuth.jsx)이 쓴다. 저장·검사는 api/_phone_verify.js.
import { createClient } from "@supabase/supabase-js";
import { issueCode, checkCode } from "./_phone_verify.js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// IP 당 10분에 보내기 10번 — 인증 문자 남발 방지
const RATE_WINDOW_MS = 10 * 60 * 1000, RATE_MAX = 10;
const sends = new Map();
function tooMany(ip) {
  const now = Date.now(), r = sends.get(ip);
  if (!r || now - r.first > RATE_WINDOW_MS) { sends.set(ip, { count: 1, first: now }); return false; }
  r.count += 1;
  return r.count > RATE_MAX;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { action, phone, code } = req.body || {};
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

  if (action === "send") {
    if (!phone) return res.status(400).json({ error: "전화번호를 입력해주세요." });
    if (tooMany(ip)) return res.status(429).json({ error: "인증번호 요청이 너무 많습니다. 10분 뒤 다시 해주세요." });
    const r = await issueCode(supabase, phone);
    if (r.error) return res.status(400).json({ error: r.error });
    return res.json({ success: true, message: "인증번호를 발송했습니다.", ...(r.devCode ? { devCode: r.devCode } : {}) });
  }

  if (action === "verify") {
    if (!phone || !code) return res.status(400).json({ error: "전화번호와 인증번호를 입력해주세요." });
    const ok = await checkCode(supabase, phone, code);
    if (!ok) return res.status(400).json({ error: "인증번호가 올바르지 않거나 만료되었습니다." });
    return res.json({ success: true, verified: true });
  }

  return res.status(400).json({ error: "Invalid action" });
}
