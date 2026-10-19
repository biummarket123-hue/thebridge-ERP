// 구독형 SaaS 회사 계정 — 가입·로그인·관리자 PIN 리셋 서버 함수 (/api/saas-account)
//
// 왜 서버에서 하나:
//   · 로그인 아이디(rohi) → 실제 Supabase 이메일을 브라우저가 알 필요가 없다. 아이디만 받아 서버가 찾는다.
//     그래서 1호 고객사(로하이마켓)처럼 이메일이 {id}@thebridge.erp 꼴이 아닌 계정도 아이디로 들어온다.
//   · 가입은 service role 로만 — 익명 signUp 을 열면 체험 계정이 무한 생성된다. 초대 코드(SAAS_SIGNUP_CODE)로 막는다.
//   · 관리자 PIN 을 잃었을 때는 회사 비밀번호로 본인 확인 뒤 service_reset_manager_pin RPC 를 부른다.
//   · 실패 지연 + IP 별 시도 제한(api/company-session.js 와 같은 방식).
//
// 환경변수(VITE_ 접두사 없는 것은 서버만 읽는다):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   SAAS_SIGNUP_CODE  — 가입 초대 코드. 비어 있고 SAAS_SIGNUP_OPEN=1 도 아니면 가입이 닫힌다.
//   SAAS_SIGNUP_OPEN  — "1" 이면 초대 코드 없이 누구나 가입(체험 14일).
//   SAAS_TRIAL_DAYS   — 체험 기간(기본 14).
//
// 요청: POST { action: "login" | "signup" | "reset-admin-pin", ... }  응답은 아래 각 action 참고.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_DOMAIN = "thebridge.erp";
const LOGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const PIN_RE = /^\d{4}$/;

const FAIL_DELAY_MS = 600;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILS = 10;
const fails = new Map(); // ip → { count, first }
function tooManyFails(ip) {
  const r = fails.get(ip);
  return !!r && Date.now() - r.first <= RATE_WINDOW_MS && r.count >= RATE_MAX_FAILS;
}
function noteFail(ip) {
  const now = Date.now(), r = fails.get(ip);
  if (!r || now - r.first > RATE_WINDOW_MS) fails.set(ip, { count: 1, first: now });
  else r.count += 1;
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const normId = (s) => String(s || "").trim().toLowerCase();
const pickSession = (s) => ({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user_id: s.user?.id || null });

function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "비밀번호는 8자 이상이어야 합니다";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "비밀번호에 영문과 숫자를 함께 넣어 주세요";
  return "";
}

// 아이디 → 이메일. 이메일을 그대로 넣었으면 그걸 쓴다. company_accounts 에 없는 아이디는 가상 이메일 규칙으로 시도한다.
async function resolveEmail(loginIdOrEmail) {
  const raw = String(loginIdOrEmail || "").trim();
  if (raw.includes("@")) return raw.toLowerCase();
  const id = normId(raw);
  if (!LOGIN_ID_RE.test(id)) return null;
  const sb = admin();
  const { data: acc } = await sb.from("company_accounts").select("owner_id").eq("login_id", id).maybeSingle();
  if (acc?.owner_id) {
    const { data } = await sb.auth.admin.getUserById(acc.owner_id);
    if (data?.user?.email) return data.user.email;
  }
  return `${id}@${EMAIL_DOMAIN}`;
}

async function signIn(email, password) {
  const { data, error } = await anon().auth.signInWithPassword({ email, password });
  if (error || !data?.session) return null;
  return data.session;
}

async function loadAccount(ownerId) {
  const { data } = await admin().from("company_accounts").select("owner_id, login_id, name, plan, status, trial_end, current_period_end, max_managers").eq("owner_id", ownerId).maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    console.error("[saas-account] 환경변수 누락: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
    return res.status(500).json({ error: "서버 인증 설정이 없습니다. 관리자에게 알려주세요." });
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || "unknown";
  const body = req.body || {};
  const action = body.action;

  // ── 로그인: { loginId, password } → { session, account } ──
  if (action === "login") {
    if (tooManyFails(ip)) return res.status(429).json({ error: "시도가 너무 많습니다. 10분 뒤 다시 해주세요." });
    const email = await resolveEmail(body.loginId);
    const session = email && typeof body.password === "string" ? await signIn(email, body.password) : null;
    if (!session) {
      noteFail(ip);
      await delay(FAIL_DELAY_MS);
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    const account = await loadAccount(session.user.id);
    return res.status(200).json({ session: pickSession(session), account });
  }

  // ── 가입: { inviteCode?, loginId, password, companyName, contact?, adminName, adminPin } → { session, account } ──
  if (action === "signup") {
    const open = process.env.SAAS_SIGNUP_OPEN === "1";
    const code = process.env.SAAS_SIGNUP_CODE || "";
    if (!open && !code) return res.status(403).json({ error: "지금은 가입을 받지 않습니다. 문의해 주세요." });
    if (!open && String(body.inviteCode || "") !== code) {
      noteFail(ip);
      await delay(FAIL_DELAY_MS);
      return res.status(403).json({ error: "초대 코드가 맞지 않습니다." });
    }
    if (tooManyFails(ip)) return res.status(429).json({ error: "시도가 너무 많습니다. 10분 뒤 다시 해주세요." });

    const loginId = normId(body.loginId);
    if (!LOGIN_ID_RE.test(loginId)) return res.status(400).json({ error: "아이디는 영문 소문자·숫자·_·- 로 3~20자, 첫 글자는 영문이나 숫자여야 합니다." });
    const pwErr = passwordProblem(body.password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const companyName = String(body.companyName || "").trim();
    if (!companyName) return res.status(400).json({ error: "회사명을 입력해 주세요." });
    const adminName = String(body.adminName || "").trim() || "관리자";
    const adminPin = String(body.adminPin || "");
    if (!PIN_RE.test(adminPin)) return res.status(400).json({ error: "관리자 PIN 은 숫자 4자리여야 합니다." });
    const contact = String(body.contact || "").trim();
    const trialDays = Math.max(1, parseInt(process.env.SAAS_TRIAL_DAYS || "14", 10) || 14);

    const sb = admin();
    const { data: dup } = await sb.from("company_accounts").select("owner_id").eq("login_id", loginId).maybeSingle();
    if (dup) return res.status(409).json({ error: "이미 쓰는 아이디입니다." });

    const email = `${loginId}@${EMAIL_DOMAIN}`;
    const { data: created, error: cErr } = await sb.auth.admin.createUser({
      email, password: body.password, email_confirm: true,
      user_metadata: { company_name: companyName, login_id: loginId, saas: true },
    });
    if (cErr || !created?.user) {
      console.error("[saas-account] createUser 실패:", cErr?.message);
      const taken = /already|exists|registered/i.test(cErr?.message || "");
      return res.status(taken ? 409 : 502).json({ error: taken ? "이미 쓰는 아이디입니다." : "계정을 만들지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
    const ownerId = created.user.id;

    // 아래가 하나라도 실패하면 만든 계정을 지운다 — 반쯤 만들어진 회사가 남지 않게.
    try {
      const trialEnd = new Date(Date.now() + trialDays * 86400000).toISOString();
      let r = await sb.from("company_accounts").insert({ owner_id: ownerId, login_id: loginId, name: companyName, contact, plan: "trial", status: "active", trial_end: trialEnd });
      if (r.error) throw r.error;
      r = await sb.from("subscription_events").insert({ owner_id: ownerId, kind: "trial_start", plan: "trial", period_start: new Date().toISOString(), period_end: trialEnd, memo: `가입 · 체험 ${trialDays}일` });
      if (r.error) throw r.error;
      // 담당자: 관리자 1명 + 공용 '방문고객'
      const { data: mgrs, error: mErr } = await sb.from("managers")
        .insert([{ user_id: ownerId, name: adminName, is_admin: true, is_public: false }, { user_id: ownerId, name: "방문고객", is_admin: false, is_public: true }])
        .select("id, name, is_admin");
      if (mErr) throw mErr;
      const adminRow = (mgrs || []).find(m => m.is_admin);
      if (!adminRow) throw new Error("관리자 담당자 생성 실패");
      const { data: pinRes, error: pErr } = await sb.rpc("service_reset_manager_pin", { p_owner_id: ownerId, p_manager_id: adminRow.id, p_pin: adminPin });
      if (pErr || !pinRes?.ok) throw pErr || new Error(pinRes?.error || "PIN 설정 실패");
      // 회사 설정 기본값(새 UI 의 config 가 읽는다)
      r = await sb.from("settings").upsert({ user_id: ownerId, data: { senderName: companyName, saas: { companyName } }, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (r.error) console.warn("[saas-account] settings 기본값 실패(무시):", r.error.message);
    } catch (e) {
      console.error("[saas-account] 가입 후속 실패, 계정 되돌림:", e?.message || e);
      try { await sb.auth.admin.deleteUser(ownerId); } catch (e2) { console.error("[saas-account] 되돌림 실패:", e2?.message); }
      return res.status(502).json({ error: "회사 정보를 만들지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }

    const session = await signIn(email, body.password);
    const account = await loadAccount(ownerId);
    return res.status(200).json({ session: session ? pickSession(session) : null, account });
  }

  // ── 관리자 PIN 리셋: { loginId, password, managerId, pin } → { ok } ──
  // 회사 비밀번호가 본인 확인이다. 관리자가 PIN 을 잃어 잠겼을 때 쓴다.
  if (action === "reset-admin-pin") {
    if (tooManyFails(ip)) return res.status(429).json({ error: "시도가 너무 많습니다. 10분 뒤 다시 해주세요." });
    const email = await resolveEmail(body.loginId);
    const session = email && typeof body.password === "string" ? await signIn(email, body.password) : null;
    if (!session) {
      noteFail(ip);
      await delay(FAIL_DELAY_MS);
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    const pin = String(body.pin || "");
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: "PIN 은 숫자 4자리여야 합니다." });
    const managerId = Number(body.managerId);
    if (!Number.isFinite(managerId)) return res.status(400).json({ error: "담당자를 선택해 주세요." });
    const { data, error } = await admin().rpc("service_reset_manager_pin", { p_owner_id: session.user.id, p_manager_id: managerId, p_pin: pin });
    if (error || !data?.ok) return res.status(400).json({ error: data?.error || error?.message || "PIN 을 바꾸지 못했습니다." });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Invalid action" });
}
