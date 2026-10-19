// company 계정 세션 발급 — Supabase 자격증명을 브라우저 번들에서 빼기 위한 서버 함수.
//
// 예전에는 db.js 에 company 계정 이메일·비밀번호가 평문으로 있었고, 그게 운영 번들에 그대로
// 들어갔다(2026-09-17 보안 진단 C3). 번들을 한 번 받은 누구나 anon 키로 로그인해 전체 데이터를
// 읽고 쓸 수 있었다. 이제 자격증명은 서버 환경변수(COMPANY_AUTH_EMAIL / COMPANY_AUTH_PASSWORD,
// VITE_ 접두사 없음)에만 두고, 이 함수가 대신 로그인해 세션(access/refresh token)만 돌려준다.
//
// 이 함수 자체의 게이트 — 아무나 부를 수 있으면 자격증명만 옮긴 셈이 된다:
//   1) action=login  : 직원 비밀번호(설정의 VITE_COMPANY_PASSWORD, 서버가 읽음)를 검사하고
//                      30일짜리 HMAC 서명 게이트 토큰 + 세션을 준다.
//   2) action=session: X-Company-Gate 헤더의 게이트 토큰이 유효하면 세션을 준다.
//                      라벨 PC·포장 패드처럼 사람이 없는 기기가 세션을 스스로 회복하는 길이다.
// 게이트 토큰은 기기 localStorage 에만 남고 번들에는 아무 비밀도 없다. 서명 키는
// COMPANY_AUTH_PASSWORD 에서 파생하므로(2단계 비밀번호 교체 시) 자동으로 전부 무효화된다.
//
// 직원별 계정(진단 M1)이 완성될 때까지의 중간 단계다 — 4자리 공유 비밀번호가 남아 있으므로
// 실패 지연 + IP 별 시도 제한으로 무차별 대입만 늦춘다.

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const AUTH_EMAIL = process.env.COMPANY_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.COMPANY_AUTH_PASSWORD;
const GATE_PASSWORD = process.env.COMPANY_GATE_PASSWORD || process.env.VITE_COMPANY_PASSWORD;
const GATE_SECRET = process.env.COMPANY_GATE_SECRET || (AUTH_PASSWORD && crypto.createHash("sha256").update(`gate:${AUTH_EMAIL}:${AUTH_PASSWORD}`).digest("hex"));

const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일 — 예전 localStorage 플래그와 같은 수명
const FAIL_DELAY_MS = 600;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILS = 10;

// 함수 인스턴스가 살아 있는 동안만 유지되는 간이 제한 — 완벽하진 않지만 4자리 대입을 실질적으로 늦춘다.
const fails = new Map(); // ip → { count, first }
function tooManyFails(ip) {
  const now = Date.now();
  const r = fails.get(ip);
  if (!r || now - r.first > RATE_WINDOW_MS) return false;
  return r.count >= RATE_MAX_FAILS;
}
function noteFail(ip) {
  const now = Date.now();
  const r = fails.get(ip);
  if (!r || now - r.first > RATE_WINDOW_MS) fails.set(ip, { count: 1, first: now });
  else r.count += 1;
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signGate(expMs) {
  const sig = crypto.createHmac("sha256", GATE_SECRET).update(String(expMs)).digest("hex");
  return `${expMs}.${sig}`;
}
function verifyGate(token) {
  const m = String(token || "").match(/^(\d{10,16})\.([0-9a-f]{64})$/);
  if (!m) return false;
  const expMs = Number(m[1]);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = crypto.createHmac("sha256", GATE_SECRET).update(String(expMs)).digest("hex");
  return safeEqual(m[2], expected);
}

async function issueSession() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email: AUTH_EMAIL, password: AUTH_PASSWORD });
  if (error || !data?.session) throw new Error(error?.message || "no session");
  const s = data.session;
  // setSession 에 필요한 것만 돌려준다.
  return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user_id: s.user?.id || null };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !AUTH_EMAIL || !AUTH_PASSWORD || !GATE_PASSWORD) {
    console.error("[company-session] 환경변수 누락: COMPANY_AUTH_EMAIL / COMPANY_AUTH_PASSWORD / VITE_COMPANY_PASSWORD / VITE_SUPABASE_*");
    return res.status(500).json({ error: "서버 인증 설정이 없습니다. 관리자에게 알려주세요." });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "unknown";
  const { action, password } = req.body || {};

  if (action === "login") {
    if (tooManyFails(ip)) return res.status(429).json({ error: "시도가 너무 많습니다. 10분 뒤 다시 해주세요." });
    if (typeof password !== "string" || !safeEqual(password, GATE_PASSWORD)) {
      noteFail(ip);
      await new Promise(r => setTimeout(r, FAIL_DELAY_MS));
      return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
    }
    try {
      const session = await issueSession();
      const gateExpiresAt = Date.now() + GATE_TTL_MS;
      return res.status(200).json({ session, gateToken: signGate(gateExpiresAt), gateExpiresAt });
    } catch (e) {
      console.error("[company-session] 로그인 실패:", e.message);
      return res.status(502).json({ error: "인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  }

  if (action === "session") {
    const gate = req.headers["x-company-gate"];
    if (!verifyGate(gate)) return res.status(401).json({ error: "gate-invalid" });
    try {
      const session = await issueSession();
      return res.status(200).json({ session });
    } catch (e) {
      console.error("[company-session] 세션 발급 실패:", e.message);
      return res.status(502).json({ error: "인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  }

  return res.status(400).json({ error: "Invalid action" });
}
