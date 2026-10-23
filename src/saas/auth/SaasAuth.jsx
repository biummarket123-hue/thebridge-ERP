// 새 UI(/app) 의 회사 로그인 게이트 — 아이디·비밀번호 → Supabase 세션. 끝나면 SaasApp 을 그린다.
//
// 1단계(회사) 인증만 여기서 한다. 2단계(담당자 PIN)는 SaasApp 안의 PinGate.
// 세션이 이미 있으면(이 기기에서 전에 로그인·옛 게이트 토큰으로 db.js 가 세션을 회복) 바로 들어간다.
// 세션을 잃으면(db.js 의 company-gate-lost, supabase 의 SIGNED_OUT) 다시 로그인 화면.
// 사내 모드(VITE_MODE=company)에서는 예전 "사내 비밀번호" 로그인(api/company-session)도 같이 보여준다 —
// 로하이마켓이 company_accounts 에 아이디를 만들기 전까지의 다리.
//
// 2026-10-23: 가입 때 휴대폰을 문자로 인증한다(필수). 그 번호로 "비밀번호를 잊었어요"(재설정)·"아이디 찾기"가 된다.
// 서버는 api/saas-account.js(가입·재설정·찾기)와 api/sms-verify.js(인증번호).
import { useEffect, useState, lazy, Suspense } from "react";
import "../tokens.css";
import "../saas.css";
import { supabase } from "../../lib/supabase.js";
import * as db from "../../lib/db.js";
import { Button } from "../components/ui.jsx";
import { SaasLoader } from "../components/Loading.jsx";
import { SupportLinks } from "../components/SupportLinks.jsx";
import { BrandMark } from "../icons.jsx";
import { BRAND } from "../config.js";
import { normalizeLoginId, isEmailLike, validatePassword, isValidPin } from "../lib/subscription.js";
import { postAccount, smsVerify, normPhone, formatPhone, isMobilePhone } from "../lib/accountApi.js";

export { postAccount };   // PinGate·Landing 이 여기서 가져간다(옛 경로 유지)

const SaasApp = lazy(() => import("../SaasApp.jsx"));
const LEGACY_LOGIN = import.meta.env.VITE_MODE === "company";

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
      <div><div className="brand-name">{BRAND.name} <span>{BRAND.suffix}</span></div><div className="brand-caption">{caption || BRAND.caption}</div></div>
    </div>
  );
}

/**
 * 휴대폰 인증 조각 — 번호 입력 → "인증번호 받기" → 6자리 입력 → "확인". 가입·재설정·아이디 찾기가 같이 쓴다.
 *   send(phone)        인증번호를 보내는 함수(가입은 /api/sms-verify, 재설정·찾기는 /api/saas-account 의 *-send). { devCode? } 를 돌려준다.
 *   onVerified(code)   코드가 맞다고 확인됐을 때(가입은 서버 verify 뒤, 재설정·찾기는 코드를 다음 단계로 넘길 뿐이라 verify 생략)
 */
function PhoneVerify({ phone, setPhone, send, verify, verified, setVerified, disabled, idPrefix = "pv" }) {
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [msg, setMsg] = useState({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);
  const doSend = async () => {
    if (!isMobilePhone(phone)) return setMsg({ text: "휴대폰 번호를 확인해 주세요(010-0000-0000)", kind: "err" });
    setBusy(true); setMsg({ text: "", kind: "" });
    try {
      const r = await send(phone);
      setSent(true); setDevCode(r?.devCode || ""); setCode("");
      setMsg({ text: r?.devCode ? "개발 모드 — 문자는 안 가고 인증번호가 아래에 보입니다" : "인증번호를 보냈습니다. 3분 안에 입력해 주세요.", kind: "ok" });
    } catch (e) { setMsg({ text: e.message || "인증번호를 보내지 못했습니다", kind: "err" }); }
    finally { setBusy(false); }
  };
  const doVerify = async () => {
    if (!/^\d{6}$/.test(code)) return setMsg({ text: "인증번호 6자리를 입력해 주세요", kind: "err" });
    setBusy(true); setMsg({ text: "", kind: "" });
    try {
      if (verify) await verify(phone, code);
      setVerified(code); setMsg({ text: "인증되었습니다", kind: "ok" });
    } catch (e) { setMsg({ text: e.message || "인증번호가 올바르지 않습니다", kind: "err" }); }
    finally { setBusy(false); }
  };
  return (
    <div className="phone-verify">
      <Field label="휴대폰" htmlFor={`${idPrefix}-phone`} hint={verified ? "인증됨" : "문자 인증 · 비밀번호 재설정과 결제·체험 안내를 이 번호로 받습니다"}>
        <div className="inline-field">
          <input id={`${idPrefix}-phone`} className="forminput" value={phone} onChange={e => { setPhone(e.target.value); setVerified(""); setSent(false); }} inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" disabled={disabled || !!verified} />
          {!verified && <Button type="button" kind="white" size="sm" onClick={doSend} loading={busy} disabled={disabled}>{sent ? "다시 받기" : "인증번호 받기"}</Button>}
        </div>
      </Field>
      {sent && !verified && (
        <Field label="인증번호" htmlFor={`${idPrefix}-code`} hint="6자리">
          <div className="inline-field">
            <input id={`${idPrefix}-code`} className="forminput" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder={devCode || "000000"} />
            <Button type="button" size="sm" onClick={doVerify} loading={busy}>확인</Button>
          </div>
        </Field>
      )}
      {msg.text && <p className={`helptext${msg.kind === "err" ? " err" : ""}`} style={{ margin: "6px 0 0" }} role={msg.kind === "err" ? "alert" : undefined}>{msg.text}</p>}
    </div>
  );
}

function LoginForm({ onDone, onSignup, onReset, onFindId, notice }) {
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
      {notice && <p className="helptext" style={{ color: "#23986f", fontWeight: 700 }}>{notice}</p>}
      {mode === "id" && (
        <Field label="회사 아이디" htmlFor="login-id">
          <input id="login-id" className="forminput" autoComplete="username" autoCapitalize="none" spellCheck={false} value={id} onChange={e => setId(e.target.value)} placeholder="예: mycompany" />
        </Field>
      )}
      <Field label={mode === "id" ? "비밀번호" : "사내 비밀번호"} htmlFor="login-pw">
        <input id="login-pw" className="forminput" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
      </Field>
      {err && <p className="helptext err" role="alert">{err}</p>}
      <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="check">로그인</Button></div>
      <div className="link-old" style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <a href="#signup" onClick={e => { e.preventDefault(); onSignup(); }}>새 회사 가입</a>
        <a href="#reset" onClick={e => { e.preventDefault(); onReset(); }}>비밀번호를 잊었어요</a>
        <a href="#findid" onClick={e => { e.preventDefault(); onFindId(); }}>아이디 찾기</a>
        <a href="/">가입 없이 1시간 체험</a>
        {LEGACY_LOGIN && <a href="#legacy" onClick={e => { e.preventDefault(); setErr(""); setMode(mode === "id" ? "legacy" : "id"); }}>{mode === "id" ? "사내 비밀번호로 로그인" : "회사 아이디로 로그인"}</a>}
      </div>
      <SupportLinks compact title="" />
    </form>
  );
}

function SignupForm({ onDone, onBack }) {
  const [f, setF] = useState({ inviteCode: "", companyName: "", loginId: "", password: "", password2: "", adminName: "", adminPin: "", agree: false });
  const [phone, setPhone] = useState("");
  const [verified, setVerified] = useState("");   // 인증된 코드(빈 글 = 아직)
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
    if (!isMobilePhone(phone)) return setErr("휴대폰 번호를 입력해 주세요");
    if (!verified) return setErr("휴대폰 인증을 먼저 해 주세요");
    if (!isValidPin(f.adminPin)) return setErr("관리자 PIN 은 숫자 4자리");
    if (!f.agree) return setErr("이용약관과 개인정보 처리방침에 동의해 주세요");
    setBusy(true);
    try {
      const body = await postAccount("signup", { inviteCode: f.inviteCode.trim(), companyName: f.companyName.trim(), loginId, password: f.password, contact: formatPhone(phone), adminName: f.adminName.trim() || "관리자", adminPin: f.adminPin });
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
      <p className="helptext" style={{ marginTop: 8 }}>회사 하나에 계정 하나입니다. 직원은 계정을 따로 만들지 않고, 로그인 뒤 담당자 이름과 4자리 PIN 으로 작업합니다. 가입 즉시 14일 무료 체험이 시작되고 카드는 필요 없습니다.</p>
      <Field label="회사명" htmlFor="su-company"><input id="su-company" className="forminput" value={f.companyName} onChange={set("companyName")} placeholder="예: 우리 원단" /></Field>
      <Field label="회사 아이디" htmlFor="su-id" hint="로그인에 씁니다"><input id="su-id" className="forminput" value={f.loginId} onChange={set("loginId")} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="영문·숫자 3~20자" /></Field>
      <div className="formrow">
        <Field label="비밀번호" htmlFor="su-pw" hint="8자 이상, 영문+숫자"><input id="su-pw" className="forminput" type="password" autoComplete="new-password" value={f.password} onChange={set("password")} /></Field>
        <Field label="비밀번호 확인" htmlFor="su-pw2"><input id="su-pw2" className="forminput" type="password" autoComplete="new-password" value={f.password2} onChange={set("password2")} /></Field>
      </div>
      <PhoneVerify idPrefix="su" phone={phone} setPhone={setPhone} verified={verified} setVerified={setVerified}
        send={(p) => smsVerify("send", p)} verify={(p, c) => smsVerify("verify", p, c)} />
      <div className="formrow">
        <Field label="관리자 이름" htmlFor="su-admin" hint="첫 담당자"><input id="su-admin" className="forminput" value={f.adminName} onChange={set("adminName")} placeholder="예: 사장님" /></Field>
        <Field label="관리자 PIN" htmlFor="su-pin" hint="숫자 4자리"><input id="su-pin" className="forminput" inputMode="numeric" maxLength={4} value={f.adminPin} onChange={e => setF({ ...f, adminPin: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></Field>
      </div>
      <Field label="초대 코드" htmlFor="su-code" hint="선택 · 받은 코드가 있을 때만"><input id="su-code" className="forminput" value={f.inviteCode} onChange={set("inviteCode")} autoCapitalize="none" /></Field>
      <label className="agree-row">
        <input type="checkbox" checked={f.agree} onChange={e => setF({ ...f, agree: e.target.checked })} />
        <span><a href="/terms" target="_blank" rel="noreferrer">이용약관</a>과 <a href="/privacy" target="_blank" rel="noreferrer">개인정보 처리방침</a>에 동의합니다. 휴대폰 번호는 비밀번호 재설정과 결제·체험 안내 문자에만 씁니다.</span>
      </label>
      {err && <p className="helptext err" role="alert">{err}</p>}
      <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="sparkle">가입하고 시작하기</Button></div>
      <div className="link-old"><a href="#login" onClick={e => { e.preventDefault(); onBack(); }}>이미 계정이 있어요 — 로그인</a></div>
      <SupportLinks compact title="" note="" />
    </form>
  );
}

/** 비밀번호 재설정 — 아이디 + 가입한 휴대폰으로 인증번호 → 새 비밀번호 */
function ResetForm({ onBack, onDone }) {
  const [id, setId] = useState("");
  const [phone, setPhone] = useState("");
  const [verified, setVerified] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const lid = () => isEmailLike(id) ? id.trim() : normalizeLoginId(id);
  const send = async (p) => {
    if (!lid()) throw new Error("회사 아이디를 먼저 입력해 주세요");
    return postAccount("reset-password-send", { loginId: lid(), phone: normPhone(p) });
  };
  const submit = async (e) => {
    e.preventDefault(); setErr("");
    if (!lid()) return setErr("회사 아이디를 입력해 주세요");
    if (!verified) return setErr("휴대폰 인증번호를 확인해 주세요");
    const pwErr = validatePassword(pw); if (pwErr) return setErr(pwErr);
    if (pw !== pw2) return setErr("비밀번호 확인이 다릅니다");
    setBusy(true);
    try {
      await postAccount("reset-password", { loginId: lid(), phone: normPhone(phone), code: verified, password: pw });
      onDone("비밀번호를 바꿨습니다. 새 비밀번호로 로그인해 주세요.");
    } catch (e2) { setErr(e2.message || "비밀번호를 바꾸지 못했습니다"); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="sheet login-sheet" aria-label="비밀번호 재설정">
      <Brand caption="비밀번호 재설정" />
      <div className="sheethead"><h2>비밀번호를 잊었어요</h2></div>
      <p className="helptext" style={{ marginTop: 8 }}>회사 아이디와 가입할 때 인증한 휴대폰 번호를 넣으면 인증번호를 문자로 보냅니다. 번호가 바뀌었으면 아래 문의로 연락해 주세요.</p>
      <Field label="회사 아이디" htmlFor="rs-id"><input id="rs-id" className="forminput" value={id} onChange={e => setId(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
      <PhoneVerify idPrefix="rs" phone={phone} setPhone={setPhone} verified={verified} setVerified={setVerified} send={send} />
      {verified && (
        <div className="formrow">
          <Field label="새 비밀번호" htmlFor="rs-pw" hint="8자 이상, 영문+숫자"><input id="rs-pw" className="forminput" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
          <Field label="새 비밀번호 확인" htmlFor="rs-pw2"><input id="rs-pw2" className="forminput" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></Field>
        </div>
      )}
      {err && <p className="helptext err" role="alert">{err}</p>}
      <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="check" disabled={!verified}>비밀번호 바꾸기</Button></div>
      <div className="link-old"><a href="#login" onClick={e => { e.preventDefault(); onBack(); }}>로그인으로 돌아가기</a></div>
      <SupportLinks compact title="" />
    </form>
  );
}

/** 아이디 찾기 — 가입한 휴대폰으로 인증하면 그 번호의 회사 아이디를 보여 준다 */
function FindIdForm({ onBack }) {
  const [phone, setPhone] = useState("");
  const [verified, setVerified] = useState("");
  const [found, setFound] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (p) => postAccount("find-id-send", { phone: normPhone(p) });
  const lookup = async () => {
    setErr(""); setBusy(true);
    try { const r = await postAccount("find-id", { phone: normPhone(phone), code: verified }); setFound(r.accounts || []); }
    catch (e) { setErr(e.message || "아이디를 찾지 못했습니다"); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={e => { e.preventDefault(); if (verified && !found) lookup(); }} className="sheet login-sheet" aria-label="아이디 찾기">
      <Brand caption="아이디 찾기" />
      <div className="sheethead"><h2>아이디 찾기</h2></div>
      <p className="helptext" style={{ marginTop: 8 }}>가입할 때 인증한 휴대폰 번호로 인증하면 그 번호로 만든 회사 아이디를 보여 드립니다.</p>
      <PhoneVerify idPrefix="fi" phone={phone} setPhone={setPhone} verified={verified} setVerified={setVerified} send={send} />
      {found && (
        <div className="notice-box" style={{ marginTop: 14 }}>
          {found.length ? <>이 번호로 가입한 회사 아이디:<ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{found.map(a => <li key={a.loginId}><b>{a.loginId}</b>{a.name ? ` · ${a.name}` : ""}</li>)}</ul></> : "이 번호로 가입한 회사가 없습니다."}
        </div>
      )}
      {err && <p className="helptext err" role="alert">{err}</p>}
      {verified && !found && <div style={{ marginTop: 22 }}><Button type="submit" loading={busy} icon="search">아이디 보기</Button></div>}
      <div className="link-old"><a href="#login" onClick={e => { e.preventDefault(); onBack(); }}>로그인으로 돌아가기</a></div>
      <SupportLinks compact title="" />
    </form>
  );
}

export default function SaasAuth() {
  const [authed, setAuthed] = useState(null);   // null = 확인 중
  const [view, setView] = useState("login");    // login | signup | reset | findid
  const [notice, setNotice] = useState("");

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

  if (authed === null) return <SaasLoader text="로그인 확인 중…" />;
  if (authed) {
    return (
      <Suspense fallback={<SaasLoader />}>
        <SaasApp />
      </Suspense>
    );
  }
  const toLogin = (msg = "") => { setNotice(msg); setView("login"); };
  return (
    <div className="saas">
      <div className="gate">
        {view === "signup" ? <SignupForm onDone={() => setAuthed(true)} onBack={() => toLogin()} />
          : view === "reset" ? <ResetForm onBack={() => toLogin()} onDone={toLogin} />
          : view === "findid" ? <FindIdForm onBack={() => toLogin()} />
          : <LoginForm onDone={() => setAuthed(true)} onSignup={() => { setNotice(""); setView("signup"); }} onReset={() => { setNotice(""); setView("reset"); }} onFindId={() => { setNotice(""); setView("findid"); }} notice={notice} />}
      </div>
    </div>
  );
}
