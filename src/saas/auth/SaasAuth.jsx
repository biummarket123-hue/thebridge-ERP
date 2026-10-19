// 새 UI(/app) 의 회사 로그인 게이트 — 아이디·비밀번호 → Supabase 세션. 끝나면 SaasApp 을 그린다.
//
// 1단계(회사) 인증만 여기서 한다. 2단계(담당자 PIN)는 SaasApp 안의 PinGate.
// 세션이 이미 있으면(이 기기에서 전에 로그인·옛 게이트 토큰으로 db.js 가 세션을 회복) 바로 들어간다.
// 세션을 잃으면(db.js 의 company-gate-lost, supabase 의 SIGNED_OUT) 다시 로그인 화면.
// 사내 모드(VITE_MODE=company)에서는 예전 "사내 비밀번호" 로그인(api/company-session)도 같이 보여준다 —
// 로하이마켓이 company_accounts 에 아이디를 만들기 전까지의 다리.
import { useEffect, useState, lazy, Suspense } from "react";
import "../tokens.css";
import "../saas.css";
import { supabase } from "../../lib/supabase.js";
import * as db from "../../lib/db.js";
import { Button } from "../components/ui.jsx";
import { BrandMark } from "../icons.jsx";
import { BRAND } from "../config.js";
import { normalizeLoginId, isEmailLike, validatePassword, isValidPin } from "../lib/subscription.js";

const SaasApp = lazy(() => import("../SaasApp.jsx"));
const LEGACY_LOGIN = import.meta.env.VITE_MODE === "company";

export async function postAccount(action, payload) {
  const res = await fetch("/api/saas-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

async function plantSession(session) {
  if (!session?.access_token || !session?.refresh_token) throw new Error("세션을 받지 못했습니다");
  const { error } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw error;
}

function Field({ label, children, htmlFor, hint }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{hint ? <span className="opt">{hint}</span> : null}</label>{children}</div>;
}

function Brand({ caption }) {
  return (
    <div className="brand" style={{ margin: "0 0 18px" }}>
      <div className="logo"><BrandMark /></div>
      <div><div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div><div className="brand-caption">{caption || BRAND.caption}</div></div>
    </div>
  );
}

function LoginForm({ onDone, onSignup }) {
  const [mode, setMode] = useState("id");   // id | legacy
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    setErr("");
    if (mode === "id") {
      const lid = isEmailLike(id) ? id.trim() : normalizeLoginId(id);
      if (!lid) return setErr("아이디를 확인해 주세요 — 영문 소문자·숫자·_·- 3~20자");
      if (!pw) return setErr("비밀번호를 입력해 주세요");
      setBusy(true);
      try {
        const body = await postAccount("login", { loginId: lid, password: pw });
        await plantSession(body.session);
        onDone();
      } catch (e2) { setErr(e2.message || "로그인하지 못했습니다"); }
      finally { setBusy(false); }
      return;
    }
    // 사내 비밀번호(옛 방식)
    if (!pw) return setErr("사내 비밀번호를 입력해 주세요");
    setBusy(true);
    try {
      const res = await fetch("/api/company-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", password: pw }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `로그인 실패 (${res.status})`);
      localStorage.setItem(db.GATE_TOKEN_KEY, body.gateToken);
      localStorage.setItem(db.GATE_UNTIL_KEY, String(body.gateExpiresAt));
      await plantSession(body.session);
      onDone();
    } catch (e2) { setErr(e2.message || "로그인하지 못했습니다"); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="sheet login-sheet" aria-label="회사 로그인">
      <Brand />
      <div className="sheethead"><h2>{mode === "id" ? "회사 계정으로 로그인" : "사내 비밀번호로 로그인"}</h2></div>
      <p className="helptext" style={{ marginTop: 8 }}>{mode === "id" ? "회사 아이디와 비밀번호를 넣어 주세요. 담당자는 다음 화면에서 PIN 으로 고릅니다." : "로하이마켓 사내 기기용 예전 방식입니다."}</p>
      {mode === "id" && (
        <Field label="회사 아이디" htmlFor="login-id">
          <input id="login-id" className="forminput" autoComplete="username" autoCapitalize="none" spellCheck={false} value={id} onChange={e => setId(e.target.value)} placeholder="예: rohi" />
        </Field>
      )}
      <Field label={mode === "id" ? "비밀번호" : "사내 비밀번호"} htmlFor="login-pw">
        <input id="login-pw" className="forminput" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
      </Field>
      {err && <p className="helptext err" role="alert">{err}</p>}
      <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="check">로그인</Button></div>
      <div className="link-old" style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <a href="#signup" onClick={e => { e.preventDefault(); onSignup(); }}>새 회사 가입</a>
        <a href="/">가입 없이 1시간 체험</a>
        {LEGACY_LOGIN && <a href="#legacy" onClick={e => { e.preventDefault(); setErr(""); setMode(mode === "id" ? "legacy" : "id"); }}>{mode === "id" ? "사내 비밀번호로 로그인" : "회사 아이디로 로그인"}</a>}
      </div>
    </form>
  );
}

function SignupForm({ onDone, onBack }) {
  const [f, setF] = useState({ inviteCode: "", companyName: "", loginId: "", password: "", password2: "", contact: "", adminName: "", adminPin: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    const loginId = normalizeLoginId(f.loginId);
    if (!f.companyName.trim()) return setErr("회사명을 입력해 주세요");
    if (!loginId) return setErr("아이디는 영문 소문자·숫자·_·- 로 3~20자");
    const pwErr = validatePassword(f.password);
    if (pwErr) return setErr(pwErr);
    if (f.password !== f.password2) return setErr("비밀번호 확인이 다릅니다");
    if (!isValidPin(f.adminPin)) return setErr("관리자 PIN 은 숫자 4자리");
    setBusy(true);
    try {
      const body = await postAccount("signup", { inviteCode: f.inviteCode.trim(), companyName: f.companyName.trim(), loginId, password: f.password, contact: f.contact.trim(), adminName: f.adminName.trim() || "관리자", adminPin: f.adminPin });
      if (body.session) await plantSession(body.session);
      else { const r = await postAccount("login", { loginId, password: f.password }); await plantSession(r.session); }
      onDone();
    } catch (e2) { setErr(e2.message || "가입하지 못했습니다"); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="sheet login-sheet" aria-label="회사 가입">
      <Brand caption="새 회사 가입 · 14일 무료 체험" />
      <div className="sheethead"><h2>회사 계정 만들기</h2></div>
      <p className="helptext" style={{ marginTop: 8 }}>회사 하나에 계정 하나입니다. 직원은 계정을 따로 만들지 않고, 로그인 뒤 담당자 이름과 4자리 PIN 으로 작업합니다.</p>
      <Field label="초대 코드" htmlFor="su-code" hint="운영자에게 받은 코드"><input id="su-code" className="forminput" value={f.inviteCode} onChange={set("inviteCode")} autoCapitalize="none" /></Field>
      <Field label="회사명" htmlFor="su-company"><input id="su-company" className="forminput" value={f.companyName} onChange={set("companyName")} placeholder="예: 로하이마켓" /></Field>
      <div className="formrow">
        <Field label="회사 아이디" htmlFor="su-id"><input id="su-id" className="forminput" value={f.loginId} onChange={set("loginId")} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="영문·숫자 3~20자" /></Field>
        <Field label="연락처" htmlFor="su-contact" hint="선택"><input id="su-contact" className="forminput" value={f.contact} onChange={set("contact")} inputMode="tel" placeholder="010-" /></Field>
      </div>
      <div className="formrow">
        <Field label="비밀번호" htmlFor="su-pw" hint="8자 이상, 영문+숫자"><input id="su-pw" className="forminput" type="password" autoComplete="new-password" value={f.password} onChange={set("password")} /></Field>
        <Field label="비밀번호 확인" htmlFor="su-pw2"><input id="su-pw2" className="forminput" type="password" autoComplete="new-password" value={f.password2} onChange={set("password2")} /></Field>
      </div>
      <div className="formrow">
        <Field label="관리자 이름" htmlFor="su-admin" hint="첫 담당자"><input id="su-admin" className="forminput" value={f.adminName} onChange={set("adminName")} placeholder="예: 사장님" /></Field>
        <Field label="관리자 PIN" htmlFor="su-pin" hint="숫자 4자리"><input id="su-pin" className="forminput" inputMode="numeric" maxLength={4} value={f.adminPin} onChange={e => setF({ ...f, adminPin: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></Field>
      </div>
      {err && <p className="helptext err" role="alert">{err}</p>}
      <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="sparkle">가입하고 시작하기</Button></div>
      <div className="link-old"><a href="#login" onClick={e => { e.preventDefault(); onBack(); }}>이미 계정이 있어요 — 로그인</a></div>
    </form>
  );
}

export default function SaasAuth() {
  const [authed, setAuthed] = useState(null);   // null = 확인 중
  const [view, setView] = useState("login");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) { if (alive) setAuthed(true); return; }
        // 옛 게이트 토큰이 있는 기기 — db.js 가 서버에서 세션을 받아 심는다
        if (localStorage.getItem(db.GATE_TOKEN_KEY)) {
          const id = await db.getUserId();
          if (alive) setAuthed(!!id);
          return;
        }
      } catch (e) { console.warn("[saas-auth] 세션 확인 실패", e); }
      if (alive) setAuthed(false);
    })();
    const onLost = () => setAuthed(false);
    window.addEventListener("company-gate-lost", onLost);
    const { data: sub } = supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") setAuthed(false); });
    return () => { alive = false; window.removeEventListener("company-gate-lost", onLost); sub?.subscription?.unsubscribe?.(); };
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-saas", "1");
    return () => document.body.removeAttribute("data-saas");
  }, []);

  if (authed === null) return <div className="saas"><div className="gate"><div className="loading-line">확인 중…</div></div></div>;
  if (authed) {
    return (
      <Suspense fallback={<div className="saas"><div className="gate"><div className="loading-line">불러오는 중…</div></div></div>}>
        <SaasApp />
      </Suspense>
    );
  }
  return (
    <div className="saas">
      <div className="gate">
        {view === "login"
          ? <LoginForm onDone={() => setAuthed(true)} onSignup={() => setView("signup")} />
          : <SignupForm onDone={() => setAuthed(true)} onBack={() => setView("login")} />}
      </div>
    </div>
  );
}
