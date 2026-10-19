// 담당자 4자리 PIN — 2단계 인증. 검증·잠금은 DB(verify_manager_pin)가 하고 여기는 키패드와 안내만.
//
//  PinPad          숫자 키패드 + 점 4개. 키보드로도 친다.
//  PinVerifyModal  "{이름}님 PIN" — 4자리가 차면 바로 검사
//  PinSetupModal   새 PIN 만들기/바꾸기(두 번 입력). 이미 있으면 본인 현재 PIN 또는 관리자 PIN 으로 증명
//  PinResetModal   PIN 을 잊었을 때 — 회사 아이디·비밀번호로 본인 확인(서버) 뒤 새 PIN
//  PinGate         전체 화면 게이트 — Shell 이 pinRequired 일 때 그린다
import { useEffect, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { Modal } from "../components/Modal.jsx";
import { Button } from "../components/ui.jsx";
import { BrandMark, Icon } from "../icons.jsx";
import { BRAND } from "../config.js";
import { isValidPin } from "../lib/subscription.js";
import { postAccount } from "./SaasAuth.jsx";

const fmtUntil = (iso) => { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };

export function PinPad({ value, onChange, disabled, label }) {
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);
  const push = (d) => { if (disabled || value.length >= 4) return; onChange(value + d); };
  const pop = () => { if (disabled) return; onChange(value.slice(0, -1)); };
  return (
    <div className="pinpad" aria-label={label || "PIN 입력"}>
      <input ref={inputRef} className="pin-hidden" inputMode="numeric" autoComplete="one-time-code" value={value} aria-label={label || "PIN"}
        onChange={e => !disabled && onChange(e.target.value.replace(/\D/g, "").slice(0, 4))} onKeyDown={e => { if (e.key === "Backspace") { e.preventDefault(); pop(); } }} />
      <div className="pindots" onClick={() => inputRef.current?.focus()} aria-hidden="true">
        {[0, 1, 2, 3].map(i => <span key={i} className={i < value.length ? "on" : ""} />)}
      </div>
      <div className="pinkeys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => <button type="button" key={d} onClick={() => push(d)} disabled={disabled}>{d}</button>)}
        <span />
        <button type="button" onClick={() => push("0")} disabled={disabled}>0</button>
        <button type="button" onClick={pop} disabled={disabled} aria-label="지우기" className="del"><Icon name="back" /></button>
      </div>
    </div>
  );
}

/** 검증 — 4자리가 차면 자동으로 검사. onOk() / 실패 시 안내. */
export function PinVerifyModal({ manager, title, onOk, onClose, onForgot, inline }) {
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { reloadPinStatus } = useSaas();

  useEffect(() => {
    if (pin.length !== 4 || busy) return;
    let alive = true;
    (async () => {
      setBusy(true);
      try {
        const r = await db.verifyManagerPin(manager.id, pin);
        if (!alive) return;
        if (r.ok) { onOk(pin); return; }
        if (r.locked_until) { setMsg(`너무 많이 틀렸습니다. ${fmtUntil(r.locked_until)} 이후 다시 시도하세요.`); reloadPinStatus(); }
        else if (r.no_pin) setMsg("이 담당자는 아직 PIN 이 없습니다.");
        else if (r.attempts_left !== undefined) setMsg(`PIN 이 맞지 않습니다. ${r.attempts_left}번 더 틀리면 10분 잠깁니다.`);
        else setMsg(r.error || "PIN 이 맞지 않습니다.");
        setPin("");
      } catch (e) { if (alive) { setMsg(e.message || "확인하지 못했습니다"); setPin(""); } }
      finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  const body = (
    <>
      <div className="pin-who"><span className="avatar">{manager.name.slice(0, 1)}</span><div><strong>{manager.name}님</strong><small>{title || "PIN 4자리를 눌러 주세요"}</small></div></div>
      <PinPad value={pin} onChange={setPin} disabled={busy} label={`${manager.name} PIN`} />
      {msg && <p className="helptext err" role="alert" style={{ marginTop: 10 }}>{msg}</p>}
      {onForgot && <div className="link-old" style={{ textAlign: "center" }}><a href="#forgot" onClick={e => { e.preventDefault(); onForgot(); }}>PIN 을 잊었어요</a></div>}
    </>
  );
  if (inline) return body;
  return <Modal title="PIN 확인" onClose={onClose}>{body}</Modal>;
}

/**
 * 새 PIN 만들기/바꾸기.
 *  manager: 대상.  proofBy: 증명할 담당자(본인 또는 관리자) — 대상이 이미 PIN 을 갖고 있을 때만 필요.
 */
export function PinSetupModal({ manager, proofBy, hasPin, onDone, onClose }) {
  const needProof = !!hasPin;
  const [step, setStep] = useState(needProof ? "proof" : "new");  // proof → new → confirm
  const [proofPin, setProofPin] = useState("");
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { reloadPinStatus } = useSaas();

  useEffect(() => {
    if (step === "proof" && proofPin.length === 4) { setMsg(""); setStep("new"); }
  }, [step, proofPin]);
  useEffect(() => {
    if (step === "new" && p1.length === 4) { setMsg(""); setStep("confirm"); }
  }, [step, p1]);
  useEffect(() => {
    if (step !== "confirm" || p2.length !== 4 || busy) return;
    if (p1 !== p2) { setMsg("두 번 입력한 PIN 이 다릅니다. 처음부터 다시 눌러 주세요."); setP1(""); setP2(""); setStep("new"); return; }
    if (!isValidPin(p1)) { setMsg("숫자 4자리여야 합니다"); setP1(""); setP2(""); setStep("new"); return; }
    let alive = true;
    (async () => {
      setBusy(true);
      try {
        const r = await db.setManagerPin(manager.id, p1, needProof ? proofBy?.id ?? null : null, needProof ? proofPin : null);
        if (!alive) return;
        if (r.ok) { await reloadPinStatus(); onDone?.(p1); return; }
        setMsg(r.error || "PIN 을 저장하지 못했습니다");
        if (r.verify?.locked_until) setMsg(`확인 PIN 을 너무 많이 틀렸습니다. ${fmtUntil(r.verify.locked_until)} 이후 다시 시도하세요.`);
        setProofPin(""); setP1(""); setP2(""); setStep(needProof ? "proof" : "new");
      } catch (e) { if (alive) { setMsg(e.message || "저장하지 못했습니다"); setP1(""); setP2(""); setStep(needProof ? "proof" : "new"); } }
      finally { if (alive) setBusy(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, p2]);

  const proofLabel = proofBy && proofBy.id !== manager.id ? `관리자 ${proofBy.name}님의 PIN` : "현재 PIN";
  const sub = step === "proof" ? `${proofLabel}을 먼저 눌러 주세요` : step === "new" ? "새 PIN 4자리" : "한 번 더 눌러 확인";
  const cur = step === "proof" ? [proofPin, setProofPin] : step === "new" ? [p1, setP1] : [p2, setP2];
  return (
    <Modal title={hasPin ? "PIN 바꾸기" : "PIN 만들기"} onClose={onClose}>
      <div className="pin-who"><span className="avatar">{manager.name.slice(0, 1)}</span><div><strong>{manager.name}님</strong><small>{sub}</small></div></div>
      <PinPad key={step} value={cur[0]} onChange={cur[1]} disabled={busy} label={sub} />
      {msg && <p className="helptext err" role="alert" style={{ marginTop: 10 }}>{msg}</p>}
      <p className="helptext" style={{ margin: "12px 0 0" }}>생년월일·1234 같은 쉬운 번호는 피해 주세요. 5번 틀리면 10분 잠깁니다.</p>
    </Modal>
  );
}

/** PIN 을 잊었을 때 — 회사 아이디·비밀번호로 본인 확인 뒤 새 PIN(서버 api/saas-account reset-admin-pin) */
export function PinResetModal({ manager, onDone, onClose }) {
  const { account } = useSaas();
  const [id, setId] = useState(account?.login_id || "");
  const [pw, setPw] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { reloadPinStatus } = useSaas();
  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!id.trim() || !pw) return setErr("회사 아이디와 비밀번호를 넣어 주세요");
    if (!isValidPin(pin)) return setErr("새 PIN 은 숫자 4자리");
    setBusy(true);
    try {
      await postAccount("reset-admin-pin", { loginId: id.trim(), password: pw, managerId: manager.id, pin });
      await reloadPinStatus();
      onDone?.();
    } catch (e2) { setErr(e2.message || "다시 설정하지 못했습니다"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="PIN 다시 설정" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="helptext" style={{ marginTop: 8 }}><b>{manager.name}</b>님의 PIN 을 새로 놓습니다. 회사 계정 비밀번호로 본인 확인을 합니다. 사내 계정(아이디 없음)은 관리자 담당자에게 요청해 주세요.</p>
        <label className="formlabel" htmlFor="pr-id">회사 아이디</label>
        <input id="pr-id" className="forminput" value={id} onChange={e => setId(e.target.value)} autoCapitalize="none" autoComplete="username" />
        <label className="formlabel" htmlFor="pr-pw">회사 비밀번호</label>
        <input id="pr-pw" className="forminput" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
        <label className="formlabel" htmlFor="pr-pin">새 PIN</label>
        <input id="pr-pin" className="forminput" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
        {err && <p className="helptext err" role="alert">{err}</p>}
        <div style={{ marginTop: 20 }}><Button type="submit" loading={busy} icon="check">새 PIN 저장</Button></div>
      </form>
    </Modal>
  );
}

/** 전체 화면 게이트 — 담당자는 골랐는데 PIN 확인이 필요할 때 */
export function PinGate() {
  const { manager, managerHasPin, markPinVerified, setActiveManager, pinned, setPinned, config, account, pinOf } = useSaas();
  const [forgot, setForgot] = useState(false);
  const [setup, setSetup] = useState(false);
  const [skip, setSkip] = useState(() => { try { return sessionStorage.getItem("erp_pin_skip_" + manager?.name) === "1"; } catch { return false; } });
  if (!manager) return null;
  const locked = pinOf(manager)?.locked_until;

  // PIN 이 아직 없는 담당자 — 구독 회사면 만들라고 권한다(사내 계정은 묻지 않는다). 건너뛰면 이 세션에선 다시 안 묻는다.
  if (!managerHasPin) {
    if (!account || skip) { markPinVerified(); return null; }
    return (
      <div className="gate">
        <div className="sheet" role="dialog" aria-modal="true" aria-label="PIN 만들기">
          <div className="brand" style={{ margin: "0 0 18px" }}><div className="logo"><BrandMark /></div><div><div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div><div className="brand-caption">{config.companyName}</div></div></div>
          <div className="sheethead"><h2>{manager.name}님, PIN 을 만들어 주세요</h2></div>
          <p className="helptext">담당자 이름만으로는 누구나 그 이름으로 작업할 수 있습니다. 4자리 PIN 을 만들면 다음부터는 PIN 만 누르고 들어옵니다.</p>
          <Button icon="pin" onClick={() => setSetup(true)}>PIN 만들기</Button>
          <div className="btnrow" style={{ marginTop: 10 }}>
            <Button kind="white" onClick={() => { try { sessionStorage.setItem("erp_pin_skip_" + manager.name, "1"); } catch {} setSkip(true); }}>나중에</Button>
            <Button kind="white" icon="user" onClick={() => setActiveManager("")}>다른 담당자</Button>
          </div>
          {setup && <PinSetupModal manager={manager} hasPin={false} onDone={() => { setSetup(false); markPinVerified(); }} onClose={() => setSetup(false)} />}
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="PIN 확인">
        <div className="brand" style={{ margin: "0 0 18px" }}><div className="logo"><BrandMark /></div><div><div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div><div className="brand-caption">{config.companyName}</div></div></div>
        <div className="sheethead"><h2>PIN 을 눌러 주세요</h2></div>
        <PinVerifyModal inline manager={manager} title={locked ? `${fmtUntil(locked)} 까지 잠겨 있습니다` : "PIN 4자리"} onOk={() => markPinVerified()} onForgot={() => setForgot(true)} />
        <label className="row-check" style={{ marginTop: 14, borderBottom: 0 }}>
          <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} />
          <span className="left"><strong>이 기기에 {manager.name} 고정</strong><small>포장 패드처럼 사람이 바뀌지 않는 기기용 — 다시 묻지 않습니다</small></span>
        </label>
        <div style={{ marginTop: 14 }}><Button kind="white" icon="user" onClick={() => setActiveManager("")} className="btn-sm">다른 담당자</Button></div>
        {forgot && <PinResetModal manager={manager} onDone={() => setForgot(false)} onClose={() => setForgot(false)} />}
      </div>
    </div>
  );
}
