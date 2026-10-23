// 회사 설정(/app/settings) — 회사 정보 · 구독(요금제·카드·자동 결제) · 운영 값 · 발송인 · 경동 송장 기본값 · 화면 · AI · 문자 · 데이터 이관 · 담당자와 PIN.
// 메뉴 5개 밖의 화면이라 사이드바 아래/프로필 메뉴에서 들어온다.
// 요금제·기간은 화면에서 직접 못 바꾼다(DB 트리거) — 결제는 /api/billing(service role)이 토스페이먼츠 빌링키로 처리하고 기간을 늘린다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../saas-settings.css";
import * as db from "../../lib/db.js";
import { supabase } from "../../lib/supabase.js";
import { useSaas, ZOOM_STEPS } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal, ConfirmModal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { PageHead, Panel, Button, StatusBadge, Chip, Segment, Empty, nim } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { CompanyLogo } from "../components/CompanyBrand.jsx";
import { SupportLinks } from "../components/SupportLinks.jsx";
import { postAccount, formatPhone, isMobilePhone } from "../lib/accountApi.js";
import { COURIERS } from "../../lib/courier.js";
import { SMS_MAX_BYTES, SAMPLE_CUSTOMER, SAMPLE_TRACKING, smsBytes, fillTemplate, templateMaxBytes } from "../lib/smsText.js";
import { PLANS, PAID_PLAN_KEYS, PLAN_COMMON, pickablePlanKeys, planDiff, normalizePlan, managerSeatsLeft, subscriptionNotice, validatePassword } from "../lib/subscription.js";
import { BRAND, KD_PAY_TYPES, DEFAULT_CONFIG, COURIER_FORMAT_LABELS, validateCouriers } from "../config.js";
import { PinSetupModal, PinVerifyModal } from "../auth/PinGate.jsx";

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "—";
const fmtWon = (n) => `${Number(n || 0).toLocaleString()}원`;
const DAY = 86400000;
const PERIOD_DAYS = 30;   // api/_billing_logic.js PERIOD_DAYS 와 같은 값 — 화면 미리보기용
const TOSS_CLIENT_KEY = import.meta.env.VITE_TOSS_CLIENT_KEY || "";
const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || "";
const NOT_READY_TEXT = "카드 결제 연동은 준비 중입니다. 구독 시작·연장은 아래 문의로 연락 주시면 계좌이체로 처리해 드립니다(세금계산서 발행). 입금이 확인되면 기간이 늘어나고, 끝나도 데이터는 지워지지 않습니다(읽기 전용).";
export const ZOOM_LABELS = ["작게", "보통", "크게", "더 크게", "최대"];

export function Field({ label, children, htmlFor, hint }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{hint ? <span className="opt">{hint}</span> : null}</label>{children}</div>;
}

// ── 결제 서버 함수 호출(/api/billing) — 세션 토큰을 Authorization 으로 ───────────────
export async function postBilling(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  const res = await fetch("/api/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

// 토스 SDK(v1) 를 필요할 때만 한 번 끼운다
let tossSdkPromise = null;
function loadTossSdk() {
  if (typeof window !== "undefined" && window.TossPayments) return Promise.resolve(window.TossPayments);
  if (!tossSdkPromise) {
    tossSdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://js.tosspayments.com/v1/payment";
      s.async = true;
      s.onload = () => window.TossPayments ? resolve(window.TossPayments) : reject(new Error("결제 모듈을 불러오지 못했습니다"));
      s.onerror = () => { tossSdkPromise = null; reject(new Error("결제 모듈을 불러오지 못했습니다. 네트워크를 확인해 주세요.")); };
      document.head.appendChild(s);
    });
  }
  return tossSdkPromise;
}

/** 지금 결제하면 이용 기간이 어떻게 되나 — 서버(nextPeriodEnd)와 같은 규칙: 남은 기간(체험이면 체험 끝)이 있으면 그 끝에서 +30일, 없으면 지금부터 */
export function previewPeriod(account, now = new Date()) {
  const remaining = !account || account.status === "canceled" ? null : account.plan === "trial" ? account.trial_end : account.current_period_end;
  const t = remaining ? new Date(remaining).getTime() : NaN;
  const base = Number.isFinite(t) && t > now.getTime() ? t : now.getTime();
  return { start: new Date(base), end: new Date(base + PERIOD_DAYS * DAY), extendsRemaining: base !== now.getTime() };
}

// ── 운영 값: 설정 화면과 온보딩이 같은 입력·검증을 쓴다 ─────────────────────
export const opsFromConfig = (config) => ({ cut: String(config.shippingFee.cut), roll: String(config.shippingFee.roll), low: String(config.lowStockM), prefix: config.productPrefix, cutoff: config.pickupCutoff });
const numOf = (v) => { const n = Number(String(v).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n >= 0 ? n : null; };
/** 검증. 틀리면 { error }, 맞으면 { patch }(saveSaasSettings 에 넣을 값) */
export function validateOps(f) {
  const c = numOf(f.cut), r = numOf(f.roll), l = numOf(f.low);
  if (c === null || r === null || l === null) return { error: "숫자만 넣어 주세요" };
  const px = String(f.prefix || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(px)) return { error: "품번 접두어는 영문 대문자로 시작하는 영문·숫자 1~6자" };
  if (!/^\d{1,2}:\d{2}$/.test(String(f.cutoff || "").trim())) return { error: "택배 수거 마감은 15:30 처럼 시:분으로" };
  return { patch: { shippingFee: { cut: c, roll: r }, lowStockM: l, productPrefix: px, pickupCutoff: String(f.cutoff).trim() } };
}
export function OpsFields({ f, setF, disabled, idPrefix = "st" }) {
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="formrow">
        <Field label="택배비 · 소량(마)" htmlFor={`${idPrefix}-cut`}><input id={`${idPrefix}-cut`} className="forminput" inputMode="numeric" value={f.cut} onChange={set("cut")} disabled={disabled} /></Field>
        <Field label="택배비 · 롤" htmlFor={`${idPrefix}-roll`}><input id={`${idPrefix}-roll`} className="forminput" inputMode="numeric" value={f.roll} onChange={set("roll")} disabled={disabled} /></Field>
      </div>
      <div className="formrow">
        <Field label="재고 부족 기준(마)" htmlFor={`${idPrefix}-low`} hint="가장 긴 롤이 이보다 짧으면 부족"><input id={`${idPrefix}-low`} className="forminput" inputMode="numeric" value={f.low} onChange={set("low")} disabled={disabled} /></Field>
        <Field label="품번 접두어" htmlFor={`${idPrefix}-prefix`} hint="영문 1~6자 · 예: TE-2610-0001"><input id={`${idPrefix}-prefix`} className="forminput" value={f.prefix} maxLength={6} onChange={e => setF({ ...f, prefix: e.target.value.toUpperCase() })} disabled={disabled} /></Field>
      </div>
      <div className="formrow">
        <Field label="택배 수거 마감" htmlFor={`${idPrefix}-cutoff`} hint="기사가 오는 시각 · 이 뒤에 포장한 건은 다음 영업일 출고"><input id={`${idPrefix}-cutoff`} className="forminput" value={f.cutoff} onChange={set("cutoff")} placeholder="15:30" disabled={disabled} /></Field>
      </div>
    </>
  );
}

// ── 발송인 정보: 설정과 온보딩 공용 ──────────────────────────────────────
export const senderFromConfig = (config) => ({ name: config.sender?.name || "", phone: config.sender?.phone || "", address: config.sender?.address || "", zip: config.sender?.zip || "" });
export function SenderFields({ f, setF, disabled, idPrefix = "sd" }) {
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="formrow">
        <Field label="보내는 분" htmlFor={`${idPrefix}-name`} hint="기본 회사명"><input id={`${idPrefix}-name`} className="forminput" value={f.name} onChange={set("name")} disabled={disabled} /></Field>
        <Field label="전화" htmlFor={`${idPrefix}-phone`}><input id={`${idPrefix}-phone`} className="forminput" inputMode="tel" value={f.phone} onChange={set("phone")} placeholder="010-" disabled={disabled} /></Field>
      </div>
      <Field label="주소" htmlFor={`${idPrefix}-addr`}><input id={`${idPrefix}-addr`} className="forminput" value={f.address} onChange={set("address")} placeholder="도로명 주소 + 상세" disabled={disabled} /></Field>
      <div className="formrow">
        <Field label="우편번호" htmlFor={`${idPrefix}-zip`} hint="선택"><input id={`${idPrefix}-zip`} className="forminput" inputMode="numeric" maxLength={6} value={f.zip} onChange={e => setF({ ...f, zip: e.target.value.replace(/\D/g, "").slice(0, 6) })} disabled={disabled} /></Field>
        <div />
      </div>
    </>
  );
}
export const senderPatch = (f) => ({ sender: { name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim(), zip: f.zip.trim() } });

// ── 회사 정보 ─────────────────────────────────────────────────
// 로고 그림 → 192px 정사각형 안에 맞춰 작은 데이터 URL 로. settings.data.saas.logo 에 그대로 들어가므로 크기를 꼭 줄인다.
const LOGO_PX = 192, LOGO_MAX_CHARS = 120000;
async function fileToLogo(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error("그림 파일(PNG·JPG·SVG 등)만 올릴 수 있습니다");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("그림을 읽지 못했습니다")); i.src = url; });
    const draw = (white) => {
      const c = document.createElement("canvas"); c.width = LOGO_PX; c.height = LOGO_PX;
      const ctx = c.getContext("2d");
      if (white) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, LOGO_PX, LOGO_PX); }
      const r = Math.min(LOGO_PX / img.width, LOGO_PX / img.height, 1) || 1;
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (LOGO_PX - w) / 2, (LOGO_PX - h) / 2, w, h);
      return c;
    };
    const png = draw(false).toDataURL("image/png");
    if (png.length <= LOGO_MAX_CHARS) return png;
    const jpg = draw(true).toDataURL("image/jpeg", 0.85);   // 사진처럼 큰 그림은 흰 바탕 JPG 로
    if (jpg.length <= LOGO_MAX_CHARS) return jpg;
    throw new Error("그림이 너무 큽니다. 단순한 로고 그림으로 다시 올려 주세요");
  } finally { URL.revokeObjectURL(url); }
}

function CompanyPanel() {
  const { account, config, isAdmin, readOnly, reloadAccount, reloadSettings } = useSaas();
  const toast = useToast();
  const [name, setName] = useState(config.companyName);
  const [contact, setContact] = useState(account?.contact || "");
  const [logo, setLogo] = useState(config.logo || "");
  const fileRef = useRef(null);
  useEffect(() => { setName(config.companyName); setContact(account?.contact || ""); setLogo(config.logo || ""); }, [config.companyName, account?.contact, config.logo]);
  const canEdit = isAdmin && !readOnly;
  const pickLogo = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try { setLogo(await fileToLogo(f)); } catch (e2) { toast(e2.message || "그림을 읽지 못했습니다", "error"); }
  };
  const save = async () => {
    if (!name.trim()) return toast("회사명을 입력해 주세요", "error");
    if (account && contact.trim() && !isMobilePhone(contact)) return toast("대표 휴대폰은 010-0000-0000 꼴로 넣어 주세요", "error");
    try {
      if (account) await db.updateCompanyAccount({ name, contact: contact.trim() ? formatPhone(contact) : "" });
      await db.saveSaasSettings({ companyName: name.trim(), logo });
      await Promise.all([reloadAccount(), reloadSettings()]);
      toast("회사 정보를 저장했습니다", "ok");
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="회사 정보" small>
      <Field label="회사명" htmlFor="st-name" hint="화면 왼쪽 위와 송장·명세서에 들어갑니다"><input id="st-name" className="forminput" value={name} onChange={e => setName(e.target.value)} disabled={!canEdit} /></Field>
      <Field label="로고" hint="선택 · 정사각형 그림이 보기 좋습니다">
        <div className="logo-pick">
          <CompanyLogo logo={logo} />
          <div className="btnrow">
            <Button kind="white" size="sm" icon="camera" onClick={() => fileRef.current?.click()} disabled={!canEdit}>그림 올리기</Button>
            {logo && <Button kind="white" size="sm" icon="refresh" onClick={() => setLogo("")} disabled={!canEdit}>기본 마크로</Button>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={pickLogo} aria-label="로고 그림 고르기" />
        </div>
        <p className="helptext" style={{ margin: "8px 0 0" }}>로고가 없으면 서비스 마크를 씁니다. 저장을 눌러야 적용됩니다.</p>
      </Field>
      {account && <Field label="대표 휴대폰" htmlFor="st-contact" hint="비밀번호 재설정 · 결제·체험 안내 문자를 받는 번호"><input id="st-contact" className="forminput" value={contact} onChange={e => setContact(e.target.value)} inputMode="tel" placeholder="010-0000-0000" disabled={!isAdmin || readOnly} /></Field>}
      <dl className="kv">
        <dt>로그인 아이디</dt><dd>{account?.login_id || <span style={{ color: "#94a3b4" }}>사내 계정(아이디 없음)</span>}</dd>
        {account && <><dt>가입일</dt><dd>{fmtDate(account.created_at)}</dd></>}
      </dl>
      {isAdmin ? <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>
        : <p className="helptext" style={{ marginBottom: 0 }}>회사 정보는 관리자 담당자만 바꿀 수 있습니다.</p>}
      {account && !account.is_demo && isAdmin && <PasswordChange loginId={account.login_id} />}
    </Panel>
  );
}

/** 비밀번호 변경 — 지금 비밀번호로 본인 확인 뒤 새 비밀번호(api/saas-account change-password). 관리자 담당자만. */
function PasswordChange({ loginId }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const why = validatePassword(pw); if (why) return toast(why, "error");
    if (pw !== pw2) return toast("새 비밀번호 확인이 다릅니다", "error");
    if (!cur) return toast("지금 비밀번호를 입력해 주세요", "error");
    setBusy(true);
    try { await postAccount("change-password", { loginId, currentPassword: cur, newPassword: pw }); toast("비밀번호를 바꿨습니다", "ok"); setOpen(false); setCur(""); setPw(""); setPw2(""); }
    catch (e) { toast(e.message || "비밀번호를 바꾸지 못했습니다", "error"); }
    finally { setBusy(false); }
  };
  if (!open) return <div style={{ marginTop: 12 }}><Button kind="white" size="sm" icon="edit" onClick={() => setOpen(true)}>비밀번호 변경</Button></div>;
  return (
    <div className="pw-change" style={{ marginTop: 14 }}>
      <div className="section-label">비밀번호 변경</div>
      <Field label="지금 비밀번호" htmlFor="pw-cur"><input id="pw-cur" className="forminput" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></Field>
      <div className="formrow">
        <Field label="새 비밀번호" htmlFor="pw-new" hint="8자 이상, 영문+숫자"><input id="pw-new" className="forminput" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        <Field label="새 비밀번호 확인" htmlFor="pw-new2"><input id="pw-new2" className="forminput" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></Field>
      </div>
      <p className="helptext" style={{ margin: "6px 0 0" }}>바꾸면 다른 기기에서도 새 비밀번호로 로그인해야 합니다. 잊었을 때는 로그인 화면의 "비밀번호를 잊었어요"에서 대표 휴대폰으로 다시 정합니다.</p>
      <div className="btnrow" style={{ marginTop: 14 }}><Button kind="white" onClick={() => setOpen(false)} disabled={busy}>취소</Button><Button icon="check" onClick={submit} loading={busy}>바꾸기</Button></div>
    </div>
  );
}

// ── 구독 · 결제 ─────────────────────────────────────────────────
const EVENT_LABEL = { trial_start: "체험 시작", payment: "결제", extend: "기간 연장", cancel: "해지", plan_change: "요금제 변경", note: "메모", billing: "카드 결제" };

// 요금제 카드 — 누르면 자세히 보기 창이 뜬다(선택은 창 안에서). on = 결제에 고른 요금제.
function PlanCard({ plan, price, current, on, onClick }) {
  const p = PLANS[plan];
  return (
    <button type="button" className={`plan-card${on ? " on" : ""}`} onClick={onClick} aria-pressed={on} aria-haspopup="dialog">
      <span className="plan-name">{p.label}{current && <StatusBadge tone="green">현재</StatusBadge>}{on && !current && <StatusBadge tone="progress">결제할 요금제</StatusBadge>}</span>
      <span className="plan-price">{fmtWon(price)}<small>/ 월</small></span>
      <span className="plan-desc">{p.desc}</span>
      <span className="plan-more">자세히 보기 ›</span>
    </button>
  );
}

/** 요금제 자세히 보기 — 가격·누구에게 맞는지·담당자/AI/문자 한도·현재 요금제와의 차이·공통 기능. canSelect 면 "이 요금제 선택" 단추. */
function PlanDetailModal({ plan, price, account, canSelect, onSelect, onClose }) {
  const p = PLANS[plan];
  const curKey = normalizePlan(account?.plan);
  const cur = PAID_PLAN_KEYS.includes(curKey) ? PLANS[curKey] : null;
  const isCurrent = curKey === plan;
  const diff = cur && !isCurrent ? planDiff(cur, p) : [];
  return (
    <Modal title={`${p.label} 요금제`} onClose={onClose}>
      <div className="plan-detail">
        <div className="pd-price">{fmtWon(price)}<small>/ 월 · 부가세 별도</small>{isCurrent && <StatusBadge tone="green">현재 요금제</StatusBadge>}</div>
        <p className="pd-fit">{p.fit}</p>
        <dl className="kv pd-kv">
          <dt>담당자</dt><dd>{p.maxManagers >= 99 ? "무제한" : `${p.maxManagers}명`} <small>공용 담당자 제외</small></dd>
          <dt>AI 분석</dt><dd>{p.ai > 0 ? `월 ${p.ai.toLocaleString()}회` : "없음"} <small>주문 글·사진을 읽어 자동 입력</small></dd>
          <dt>출고 안내 문자</dt><dd>{p.sms > 0 ? `월 ${p.sms.toLocaleString()}건` : "없음"} <small>출고 처리하면 고객에게 발송</small></dd>
        </dl>
        {p.notes?.length > 0 && <ul className="pd-notes">{p.notes.map(n => <li key={n}>{n}</li>)}</ul>}
        {diff.length > 0 && (
          <div className="pd-diff">
            <b>{cur.label} → {p.label} 로 바꾸면</b>
            <ul>{diff.map(d => <li key={d}>{d}</li>)}</ul>
          </div>
        )}
        <div className="section-label">모든 요금제 공통</div>
        <ul className="pd-list">{PLAN_COMMON.map(f => <li key={f}><Icon name="check" />{f}</li>)}</ul>
        <p className="helptext" style={{ margin: "10px 0 0" }}>AI 분석·문자 한도는 매달 1일에 새로 열립니다. 다 쓰면 그 달은 막히고, 상위 요금제로 바꾸면 바로 늘어납니다. 요금제는 결제할 때 고른 것으로 바뀝니다.</p>
      </div>
      <div className="btnrow">
        <button className="btn btn-white" onClick={onClose}>닫기</button>
        {canSelect && <button className="btn btn-primary" data-autofocus onClick={() => { onSelect(plan); onClose(); }}>{isCurrent ? "이 요금제로 연장" : "이 요금제 선택"}</button>}
      </div>
    </Modal>
  );
}

function SubscriptionPanel() {
  const { account, subscription, managers, isAdmin, isDemo, reloadAccount, usage, reloadUsage } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [events, setEvents] = useState([]);
  const [billing, setBilling] = useState(null);   // null = 확인 중 · { enabled:false } = 연동 없음
  // 결제할 요금제 — 미리 고르지 않는다(사용자 결정 2026-10-23: 미리 골라 두면 구독 중인 것처럼 보여 헷갈린다). 자세히 보기 창에서 "이 요금제 선택"을 눌러야 채워진다.
  const [plan, setPlan] = useState("");
  const [detail, setDetail] = useState("");   // 자세히 보기 창에 띄운 요금제 키("" = 닫힘)
  useEffect(() => { reloadUsage(); }, [reloadUsage]);
  const [removing, setRemoving] = useState(false);
  const handledReturn = useRef(false);
  const loginId = account?.login_id;

  const reloadEvents = useCallback(async () => { if (account) setEvents(await db.fetchSubscriptionEvents().catch(() => [])); }, [account]);
  const loadBilling = useCallback(async () => {
    if (!loginId || isDemo) { setBilling({ enabled: false }); return; }
    try { setBilling(await postBilling("status")); }
    catch (e) { console.warn("[settings] billing status", e); setBilling({ enabled: false }); }
  }, [loginId, isDemo]);
  useEffect(() => { reloadEvents(); }, [reloadEvents]);
  useEffect(() => { loadBilling(); }, [loadBilling]);

  // 토스 카드 등록 창에서 돌아온 경우(?billing=ok&authKey=…&customerKey=… / ?billing=fail&message=…)
  useEffect(() => {
    if (!loginId || handledReturn.current) return;
    const q = new URLSearchParams(window.location.search);
    const b = q.get("billing");
    if (!b) return;
    handledReturn.current = true;
    const clear = () => window.history.replaceState(null, "", window.location.pathname);
    if (b === "ok" && q.get("authKey") && q.get("customerKey")) {
      (async () => {
        try {
          const r = await postBilling("issue", { authKey: q.get("authKey"), customerKey: q.get("customerKey") });
          toast(`카드를 등록했습니다 (${r.cardLabel})`, "ok");
          await Promise.all([loadBilling(), reloadEvents()]);
        } catch (e) { toast(e.message || "카드를 등록하지 못했습니다", "error"); }
        finally { clear(); }
      })();
    } else {
      toast(q.get("message") || "카드 등록을 취소했거나 실패했습니다", "error");
      clear();
    }
  }, [loginId, toast, loadBilling, reloadEvents]);

  const registerCard = async () => {
    if (!billing?.enabled || !billing.customerKey || !TOSS_CLIENT_KEY) return toast("결제 연동 준비 중입니다. 운영자에게 연락해 주세요.", "error");
    try {
      const Toss = await loadTossSdk();
      await Toss(TOSS_CLIENT_KEY).requestBillingAuth("카드", {
        customerKey: billing.customerKey,
        successUrl: `${window.location.origin}/app/settings?billing=ok`,
        failUrl: `${window.location.origin}/app/settings?billing=fail`,
      });
    } catch (e) {
      if (e?.code === "USER_CANCEL") return;
      toast(e?.message || "카드 등록 창을 열지 못했습니다", "error");
    }
  };
  const removeCard = async () => {
    try { await postBilling("remove-card"); toast("카드를 삭제했습니다", "ok"); await Promise.all([loadBilling(), reloadEvents()]); }
    catch (e) { toast(e.message || "삭제하지 못했습니다", "error"); }
    setRemoving(false);
  };
  const cancelAuto = async () => {
    const ok = await confirm(`자동 결제를 해지합니다. 남은 기간(${account?.current_period_end ? fmtDate(account.current_period_end) + " 까지" : "현재 기간"})은 그대로 쓸 수 있고, 그 뒤에는 읽기 전용이 됩니다. 언제든 다시 결제하면 이어서 쓸 수 있습니다.`, { title: "자동 결제 해지", confirmLabel: "해지", danger: true });
    if (!ok) return;
    try { await postBilling("cancel-auto"); toast("자동 결제를 해지했습니다", "ok"); await Promise.all([loadBilling(), reloadEvents()]); }
    catch (e) { toast(e.message || "해지하지 못했습니다", "error"); }
  };
  const charge = async () => {
    if (!billing?.hasCard) return toast("카드를 먼저 등록해 주세요", "error");
    if (!PLANS[plan]) return toast("요금제 카드를 눌러 결제할 요금제를 먼저 골라 주세요", "error");
    const price = billing.prices?.[plan] ?? PLANS[plan].price;
    const pv = previewPeriod(account);
    const ok = await confirm(
      `${PLANS[plan].label} 1개월 ${fmtWon(price)}을 등록된 카드(${billing.cardLabel})로 결제합니다.\n이용 기간: ${fmtDate(pv.start)} ~ ${fmtDate(pv.end)}\n이후 매달 기간이 끝나기 전날 같은 카드로 자동 결제됩니다(여기서 해지할 수 있습니다).`,
      { title: subscription.phase === "paid" || subscription.phase === "grace" ? "지금 결제하고 연장" : "지금 결제하고 시작", confirmLabel: "결제" },
    );
    if (!ok) return;
    try {
      const r = await postBilling("charge", { plan });
      toast(`결제했습니다 — ${fmtDate(r.periodEnd)} 까지`, "ok");
      await Promise.all([reloadAccount(), loadBilling(), reloadEvents()]);
    } catch (e) { toast(e.message || "결제하지 못했습니다", "error"); await loadBilling(); }
  };

  const tone = subscription.readOnly ? "red" : subscription.soon ? "alert" : "green";
  const label = subscription.phase === "none" ? "사내 계정" : subscription.phase === "trial" ? "무료 체험 중" : subscription.phase === "paid" ? "구독 중" : subscription.phase === "grace" ? "결제 대기(유예)" : subscription.phase === "canceled" ? "해지됨" : "만료";
  const seats = managerSeatsLeft(account, managers);
  const notice = subscriptionNotice(subscription);
  const prices = { ...Object.fromEntries(PAID_PLAN_KEYS.map(k => [k, PLANS[k].price])), ...(billing?.prices || {}) };
  const cur = PLANS[normalizePlan(account?.plan)];
  const fmtCap = (n) => Number.isFinite(n) ? n.toLocaleString() : "무제한";
  const pv = account ? previewPeriod(account) : null;
  const isPaidPhase = subscription.phase === "paid" || subscription.phase === "grace";
  const periodHint = !account ? "" : subscription.phase === "trial"
    ? `체험 ${subscription.daysLeft}일 남음 — 지금 구독하면 체험이 끝난 뒤(${fmtDate(account.trial_end)})부터 30일입니다.`
    : isPaidPhase && pv?.extendsRemaining ? `남은 기간 끝(${fmtDate(account.current_period_end)})에서 30일 연장됩니다 — ${fmtDate(pv.end)} 까지.`
    : `결제하면 오늘부터 30일(${fmtDate(pv?.end)} 까지) 바로 다시 쓸 수 있습니다.`;

  return (
    <Panel title="구독" small right={<StatusBadge tone={tone}>{label}</StatusBadge>} className="settings-subscription">
      <div id="settings-subscription" style={{ scrollMarginTop: 90 }} />
      {!account ? (
        <p className="helptext" style={{ margin: "8px 0 0" }}>이 계정은 구독 정보가 없는 사내 계정입니다. 요금제·기간 제한 없이 그대로 쓸 수 있습니다.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>요금제</dt><dd>{cur?.label || account.plan}</dd>
            {account.plan === "trial"
              ? <><dt>체험 종료</dt><dd>{fmtDate(account.trial_end)}{subscription.daysLeft != null ? <small style={{ color: "#8d9aab", fontWeight: 700 }}> · {subscription.daysLeft}일 남음</small> : null}</dd></>
              : <><dt>이용 기간</dt><dd>{account.current_period_end ? `${fmtDate(account.current_period_end)} 까지` : "기간 제한 없음"}</dd></>}
            <dt>담당자 자리</dt><dd>{managers.filter(m => !m.isPublic).length} / {account.max_managers}명 <small style={{ color: "#8d9aab", fontWeight: 700 }}>(공용 담당자 제외 · {seats}자리 남음)</small></dd>
            {account.plan !== "trial" && cur && <>
              <dt>이번 달 AI 분석</dt><dd>{usage.ai.toLocaleString()} / {fmtCap(cur.ai)}회{cur.ai > 0 && usage.ai >= cur.ai ? <small style={{ color: "#c85a52", fontWeight: 700 }}> · 다 썼습니다</small> : null}</dd>
              <dt>이번 달 문자</dt><dd>{cur.sms === 0 ? <span style={{ color: "#94a3b4" }}>이 요금제에는 없음</span> : <>{usage.sms.toLocaleString()} / {fmtCap(cur.sms)}건{usage.sms >= cur.sms ? <small style={{ color: "#c85a52", fontWeight: 700 }}> · 다 썼습니다</small> : null}</>}</dd>
            </>}
          </dl>
          {notice && <p className={`helptext ${subscription.readOnly ? "err" : "warn"}`} style={{ marginBottom: 0 }}>{notice}</p>}

          <div className="section-label">요금제</div>
          <div className="plan-cards">
            {pickablePlanKeys(account).map(k => (
              <PlanCard key={k} plan={k} price={prices[k]} current={normalizePlan(account.plan) === k} on={plan === k} onClick={() => setDetail(k)} />
            ))}
          </div>
          <p className="helptext" style={{ margin: "6px 0 0" }}>카드를 누르면 자세한 내용이 뜹니다. 모든 요금제: 주문·재고·거래처·정산·포장대·변경 기록. AI 분석(글·사진 읽기)과 출고 안내 문자는 요금제별 월 한도 안에서 쓰고, 다 쓰면 다음 달 1일에 다시 열립니다. 부가세 별도.{normalizePlan(account.plan) === "pro" ? " 문자·AI 가 더 필요하면 프로 MAX(프로 구독 회사 전용)로 올릴 수 있습니다." : ""}</p>

          {billing === null ? (
            <p className="helptext" style={{ margin: "14px 0 0" }}>결제 정보를 확인하는 중…</p>
          ) : !billing.enabled ? (
            <div className="notice-box" style={{ marginTop: 14 }}>{isDemo ? "체험 환경에서는 결제할 수 없습니다. 회사 가입 뒤 구독할 수 있습니다." : <>{NOT_READY_TEXT}<SupportLinks compact title="" /></>}</div>
          ) : !isAdmin ? (
            <div className="notice-box" style={{ marginTop: 14 }}>결제·카드 관리는 관리자 담당자({managers.filter(m => m.isAdmin).map(m => m.name).join(", ") || "없음"})만 할 수 있습니다.</div>
          ) : (
            <>
              <div className="section-label">결제 수단</div>
              <div className="card-row">
                <span className="card-ic"><Icon name="wallet" /></span>
                <span className="card-text">
                  {billing.hasCard ? <><strong>{billing.cardLabel}</strong><small>자동 결제에 쓰는 카드</small></> : <><strong>등록된 카드가 없습니다</strong><small>카드를 등록하면 바로 결제할 수 있습니다</small></>}
                </span>
                <span className="acts">
                  <Button size="sm" kind={billing.hasCard ? "white" : "primary"} icon={billing.hasCard ? "edit" : "plus"} onClick={registerCard} data-ro-ok="1">{billing.hasCard ? "카드 변경" : "카드 등록"}</Button>
                  {billing.hasCard && <Button size="sm" kind="danger" icon="trash" onClick={() => setRemoving(true)} aria-label="카드 삭제" data-ro-ok="1" />}
                </span>
              </div>
              {billing.lastError && <p className="helptext err" style={{ margin: "10px 0 0" }}>마지막 결제 오류: {billing.lastError}</p>}

              <div className="section-label">결제</div>
              <p className="helptext" style={{ margin: "0 0 10px" }}>{periodHint}</p>
              <Button icon="check" onClick={charge} disabled={!billing.hasCard || !PLANS[plan]} data-ro-ok="1">
                {!PLANS[plan] ? "요금제를 먼저 골라 주세요" : <>{isPaidPhase ? "지금 결제하고 연장" : "지금 결제하고 시작"} · {PLANS[plan].label} {fmtWon(prices[plan])}</>}
              </Button>
              {!PLANS[plan] && <p className="helptext" style={{ margin: "8px 0 0" }}>위 요금제 카드를 눌러 내용을 보고 "이 요금제 선택"을 누르면 여기서 결제할 수 있습니다.</p>}

              <div className="card-row">
                <span className="card-ic"><Icon name="refresh" /></span>
                <span className="card-text">
                  {billing.plan
                    ? <><strong>자동 결제 켜짐 · {PLANS[billing.plan]?.label}</strong><small>다음 결제: {billing.nextChargeAt ? `${fmtDate(billing.nextChargeAt)} 전날` : "기간 끝 전날"} · {fmtWon(prices[billing.plan])}</small></>
                    : <><strong>자동 결제 꺼짐</strong><small>{billing.hasCard ? "결제하면 다음 달부터 자동으로 이어집니다" : "카드를 등록하고 결제하면 켜집니다"}</small></>}
                </span>
                {billing.plan && <span className="acts"><Button size="sm" kind="white" onClick={cancelAuto} data-ro-ok="1">자동 결제 해지</Button></span>}
              </div>
            </>
          )}

          {events.length > 0 && (
            <>
              <div className="section-label">이력</div>
              <ul className="events">
                {events.map(ev => (
                  <li key={ev.id}>
                    <span>{EVENT_LABEL[ev.kind] || ev.kind}{ev.memo ? ` · ${ev.memo}` : ""}{Number(ev.amount) ? ` · ${fmtWon(ev.amount)}` : ""}{ev.period_end && (ev.kind === "billing" || ev.kind === "extend" || ev.kind === "payment") ? ` · ${fmtDate(ev.period_end)} 까지` : ""}</span>
                    <small>{fmtDate(ev.created_at)}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {host}
      {detail && <PlanDetailModal plan={detail} price={prices[detail]} account={account} canSelect={!!billing?.enabled && isAdmin} onSelect={setPlan} onClose={() => setDetail("")} />}
      {removing && <ConfirmModal title="카드 삭제" message="등록된 카드를 삭제합니다. 자동 결제도 꺼지고, 남은 기간은 그대로 쓸 수 있습니다." confirmLabel="삭제" danger onConfirm={removeCard} onClose={() => setRemoving(false)} />}
    </Panel>
  );
}

// ── 택배사 ──────────────────────────────────────────────────
// 송장 엑셀을 뽑을 때 고를 택배사(사용자 결정 2026-10-23: 자동 배정 없음, 이름·줄임·송장 양식만). 하나뿐이면 고를 일도 없다.
const EMPTY_COURIER = { name: "", short: "", format: "generic" };
function CourierPanel() {
  const { config, isAdmin, readOnly, reloadSettings } = useSaas();
  const toast = useToast();
  const [list, setList] = useState(() => config.couriers.map(c => ({ ...c })));
  useEffect(() => { setList(config.couriers.map(c => ({ ...c }))); }, [config.couriers]);
  const dis = !isAdmin || readOnly;
  const upd = (i, patch) => setList(p => p.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i) => setList(p => p.filter((_, j) => j !== i));
  const add = () => setList(p => [...p, { ...EMPTY_COURIER }]);
  const save = async () => {
    const v = validateCouriers(list);
    if (v.error) return toast(v.error, "error");
    try { await db.saveSaasSettings({ couriers: v.couriers }); await reloadSettings(); toast("택배사를 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="택배사" small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>송장 엑셀을 뽑을 때 고를 택배사입니다. 하나뿐이면 고를 일 없이 바로 그 양식으로 나갑니다.</p>
      <div className="courier-list">
        {list.map((c, i) => (
          <div className="courier-row" key={i}>
            <Field label="택배사" htmlFor={`cr-name-${i}`}><input id={`cr-name-${i}`} className="forminput" value={c.name} maxLength={20} placeholder="예: 롯데택배" onChange={e => upd(i, { name: e.target.value })} disabled={dis} /></Field>
            <Field label="줄임" htmlFor={`cr-short-${i}`}><input id={`cr-short-${i}`} className="forminput" value={c.short} maxLength={6} placeholder={c.name.slice(0, 2) || "롯데"} onChange={e => upd(i, { short: e.target.value })} disabled={dis} /></Field>
            <Field label="송장 엑셀 양식" htmlFor={`cr-fmt-${i}`}>
              <select id={`cr-fmt-${i}`} className="forminput" value={c.format} onChange={e => upd(i, { format: e.target.value })} disabled={dis}>
                {Object.entries(COURIER_FORMAT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <div className="courier-acts">{!dis && <Button size="sm" kind="danger" icon="trash" onClick={() => remove(i)} aria-label="택배사 빼기" disabled={list.length <= 1} />}</div>
            {c.format === "kd" && (
              <div className="courier-kd">
                <span className="formlabel">운임 <span className="opt">경동 송장의 선불후불 칸 · 품목명·개별단가·기타운임은 원단·100·100 으로 고정</span></span>
                <Segment options={KD_PAY_TYPES.map(k => [k, k])} value={KD_PAY_TYPES.includes(c.payType) ? c.payType : KD_PAY_TYPES[0]} onChange={v => !dis && upd(i, { payType: v })} />
              </div>
            )}
          </div>
        ))}
      </div>
      {!dis && <div style={{ marginTop: 10 }}><Button size="sm" kind="white" icon="plus" onClick={add}>택배사 추가</Button></div>}
      <p className="helptext" style={{ margin: "10px 0 0" }}>CJ대한통운(LOIS)·경동화물은 그 회사 업로드 양식 그대로, 그 밖의 택배사는 받는분·전화·주소·품목이 든 범용 양식으로 나옵니다. 택배사를 빼면 그 택배사로 미리 지정해 둔 주문은 지정이 풀립니다.</p>
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 운영 값 ──────────────────────────────────────────────────
function OpsPanel() {
  const { config, isAdmin, readOnly, reloadSettings } = useSaas();
  const toast = useToast();
  const [f, setF] = useState(() => opsFromConfig(config));
  useEffect(() => { setF(opsFromConfig(config)); }, [config]);
  const save = async () => {
    const v = validateOps(f);
    if (v.error) return toast(v.error, "error");
    try { await db.saveSaasSettings(v.patch); await reloadSettings(); toast("운영 값을 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="운영 값" small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>주문 등록 폼의 택배비 버튼, 재고 "부족" 판정, 품번 발급, 출고예정일과 "수거 놓침" 판정이 이 값을 씁니다.</p>
      <OpsFields f={f} setF={setF} disabled={!isAdmin || readOnly} />
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 발송인 정보 ───────────────────────────────────────────────
function SenderPanel() {
  const { config, isAdmin, readOnly, reloadSettings } = useSaas();
  const toast = useToast();
  const [f, setF] = useState(() => senderFromConfig(config));
  useEffect(() => { setF(senderFromConfig(config)); }, [config]);
  const save = async () => {
    try { await db.saveSaasSettings(senderPatch(f)); await reloadSettings(); toast("발송인 정보를 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="발송인 정보" small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>송장과 거래명세서의 "보내는 분" 칸에 들어갑니다. 비워 두면 회사명과 담당 연락처를 씁니다.</p>
      <SenderFields f={f} setF={setF} disabled={!isAdmin || readOnly} />
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 화면(글씨 크기) ───────────────────────────────────────────
function DisplayPanel() {
  const { uiZoom, setUiZoom } = useSaas();
  return (
    <Panel title="화면" small>
      <p className="helptext" style={{ margin: "6px 0 12px" }}>글씨와 버튼을 한꺼번에 키웁니다. 창고 태블릿처럼 멀리서 보는 기기는 크게 두세요.</p>
      <div className="chiprow" role="group" aria-label="글씨 크기">
        {ZOOM_STEPS.map((z, i) => <Chip key={z} on={uiZoom === z} onClick={() => setUiZoom(z)}>{ZOOM_LABELS[i] || `${Math.round(z * 100)}%`}</Chip>)}
      </div>
      <p className="helptext" style={{ margin: "12px 0 0" }}>이 설정은 지금 쓰는 이 기기(브라우저)에만 저장됩니다. 다른 기기는 따로 맞춰 주세요.</p>
    </Panel>
  );
}

// ── AI 분석 ──────────────────────────────────────────────────
function AiPanel() {
  const { aiAllowed, aiReason, account, subscription } = useSaas();
  const toSubscription = () => document.getElementById("settings-subscription")?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <Panel title="AI 분석" small right={<StatusBadge tone={aiAllowed ? "green" : "gray"}>{aiAllowed ? "사용 가능" : "꺼짐"}</StatusBadge>}>
      <p className="helptext" style={{ margin: "6px 0 0" }}>주문 등록에서 카톡·문자 글이나 사진을 붙여 넣으면 품목·수량·주소를 읽어 채워 줍니다. 토큰 비용이 들어 유료 구독 회사 전용입니다.</p>
      {aiAllowed
        ? <p className="helptext" style={{ margin: "12px 0 0" }}>이 회사는 AI 분석을 쓸 수 있습니다. 주문 등록 › "글·사진으로 등록" 에서 바로 쓰세요.</p>
        : <>
            <p className="helptext warn" style={{ margin: "12px 0 0" }}>{aiReason}</p>
            {account && !account.is_demo && (subscription.phase === "trial" || subscription.readOnly) && <div style={{ marginTop: 12 }}><Button kind="white" icon="sparkle" onClick={toSubscription}>구독하고 AI 분석 켜기</Button></div>}
          </>}
    </Panel>
  );
}

// ── 알림(문자) ───────────────────────────────────────────────
function SmsPanel() {
  const { config, isAdmin, readOnly, reloadSettings, sms, account } = useSaas();
  const toast = useToast();
  const [on, setOn] = useState(config.notifySms);
  const [tpl, setTpl] = useState(config.notifySmsTemplate);
  useEffect(() => { setOn(config.notifySms); setTpl(config.notifySmsTemplate); }, [config.notifySms, config.notifySmsTemplate]);
  // 유료 요금제의 월 건수 안에서만(스타터는 없음) — smsAccess 가 판정, 서버(api/notify.js)가 강제. 사내 계정은 허용.
  const paidOnly = !!account && !sms.allowed;
  const dis = !isAdmin || readOnly || paidOnly;
  // 자동 문자는 LMS 로 넘어가지 않게 90바이트 안에서만(사용자 결정 2026-10-23). 가장 긴 값(회사명·3글자 이름·가장 긴 택배사)으로 채워 잰다. 서버(api/notify.js)는 넘치면 기본·짧은 문구로 바꿔 보낸다.
  const maxBytes = templateMaxBytes(tpl.trim() || DEFAULT_CONFIG.notifySmsTemplate, { companyName: config.companyName, couriers: COURIERS });
  const tooLong = maxBytes > SMS_MAX_BYTES;
  const save = async () => {
    const t = tpl.trim() || DEFAULT_CONFIG.notifySmsTemplate;
    if (t.length > 300) return toast("문자 문구는 300자 안으로", "error");
    if (tooLong) return toast(`문구가 ${SMS_MAX_BYTES}바이트를 넘어 문자(SMS)로 보낼 수 없습니다. ${maxBytes - SMS_MAX_BYTES}바이트(한글 ${Math.ceil((maxBytes - SMS_MAX_BYTES) / 2)}자) 줄여 주세요.`, "error");
    try { await db.saveSaasSettings({ notifySms: on && !paidOnly, notifySmsTemplate: t }); await reloadSettings(); toast("알림 설정을 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  const preview = fillTemplate(tpl, { 회사명: config.companyName, 고객명: SAMPLE_CUSTOMER, 택배사: config.couriers[0]?.name || "택배", 송장번호: SAMPLE_TRACKING });
  return (
    <Panel title="알림(문자)" small right={<StatusBadge tone={config.notifySms && !paidOnly ? "green" : "gray"}>{config.notifySms && !paidOnly ? "켜짐" : "꺼짐"}</StatusBadge>}>
      <button type="button" className="switch" role="switch" aria-checked={on && !paidOnly} onClick={() => !dis && setOn(v => !v)} disabled={dis}>
        <span className="knob" aria-hidden="true" /><span>출고 안내 문자 보내기</span>
      </button>
      <p className="helptext" style={{ margin: "4px 0 0" }}>출고완료로 바꾸면 고객 전화번호로 안내 문자를 보냅니다. 요금제마다 월 건수가 정해져 있고, 다 쓰면 다음 달 1일에 다시 열립니다.</p>
      {account && Number.isFinite(sms.cap) && sms.cap > 0 && <p className="helptext" style={{ margin: "8px 0 0" }}>이번 달 {sms.used.toLocaleString()} / {sms.cap.toLocaleString()}건 보냈습니다.</p>}
      {paidOnly && <p className="helptext warn" style={{ margin: "12px 0 0" }}>{sms.reason}</p>}
      <Field label="문자 문구" htmlFor="sms-tpl" hint="{회사명} {고객명} {택배사} {송장번호} 를 바꿔 넣습니다">
        <textarea id="sms-tpl" className="forminput" style={{ minHeight: 96 }} value={tpl} onChange={e => setTpl(e.target.value)} disabled={dis} maxLength={300} aria-invalid={tooLong || undefined} />
      </Field>
      <p className={`helptext${tooLong ? " err" : ""}`} style={{ margin: "6px 0 0" }}>
        가장 길 때 <b>{maxBytes}</b> / {SMS_MAX_BYTES}바이트 <small>(한글 2바이트 · 회사명과 가장 긴 택배사 이름 기준)</small>
        {tooLong ? ` — ${SMS_MAX_BYTES}바이트를 넘으면 긴 문자(LMS)가 되어 보내지 않습니다. ${maxBytes - SMS_MAX_BYTES}바이트 줄여 주세요.` : " — 짧은 문자(SMS) 한 통에 들어갑니다."}
      </p>
      <div className="notice-box">미리보기 · {preview} <small style={{ color: "#8d9aab" }}>({smsBytes(preview)}바이트)</small></div>
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly || paidOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 데이터 이관 ──────────────────────────────────────────────
function DataImportPanel() {
  const { account, config } = useSaas();
  const subject = encodeURIComponent(`[${BRAND.name} ${BRAND.suffix}] 데이터 이관 요청 · ${account?.login_id || config.companyName}`);
  const body = encodeURIComponent(`회사명: ${config.companyName}\n회사 아이디: ${account?.login_id || "(사내 계정)"}\n연락처: ${account?.contact || ""}\n\n넣어 주실 자료(고객 / 품번·재고 / 주문)를 첨부해 주세요.`);
  const mailto = SUPPORT_EMAIL ? `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}` : "";
  return (
    <Panel title="데이터 이관" small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>쓰던 엑셀·장부의 데이터는 운영팀이 대신 넣어 드립니다. 아래 세 가지 양식으로 보내 주시면 됩니다(있는 것만).</p>
      <div className="import-forms">
        <div><b>① 고객(거래처)</b> — 상호·담당자·전화·주소·메모. 적립금 잔액이 있으면 같이.</div>
        <div><b>② 품번·재고</b> — 품번(또는 이름)·사진·단가·롤별 길이(마). 롤이 여러 개면 한 줄에 하나씩.</div>
        <div><b>③ 주문</b> — 진행 중인 주문만: 고객·품목·수량·택배사·결제 여부·주문일.</div>
      </div>
      <p className="helptext" style={{ margin: "0 0 12px" }}>엑셀(xlsx)이나 CSV 면 됩니다. 첫 줄에 칸 이름(고객명·연락처·주소 / 품번·원단명·색상·단가 / 주문일·고객명·품목·수량·금액)을 적어 주시면 쓰던 양식 그대로 보내셔도 됩니다. 처음 구독한 회사는 무료(1회)이고, 보통 영업일 1~2일 안에 끝납니다. 보내신 자료는 이관이 끝나면 지웁니다.</p>
      {mailto
        ? <a className="btn btn-primary" href={mailto} style={{ textDecoration: "none" }}><Icon name="file" />이관 요청 메일 보내기</a>
        : <div className="notice-box">이관 요청은 아래 문의로 보내 주세요. 회사 아이디(<b>{account?.login_id || config.companyName}</b>)를 함께 적어 주시면 빠릅니다.</div>}
      <SupportLinks compact title="문의" note="문의 연락처가 아직 설정되지 않았습니다(운영자: VITE_SUPPORT_PHONE / VITE_SUPPORT_KAKAO / VITE_SUPPORT_EMAIL)." />
    </Panel>
  );
}

// ── 담당자 ───────────────────────────────────────────────────
export function ManagerForm({ initial, onClose, onSaved }) {
  const { managers, account } = useSaas();
  const toast = useToast();
  const isNew = !initial;
  const [f, setF] = useState({ name: initial?.name || "", isAdmin: !!initial?.isAdmin, isPacker: !!initial?.isPacker, isPublic: !!initial?.isPublic, code: initial?.code || "" });
  const seats = managerSeatsLeft(account, managers);
  const save = async () => {
    const name = f.name.trim();
    if (!name) return toast("이름을 입력해 주세요", "error");
    if (isNew && managers.some(m => m.name === name)) return toast("같은 이름의 담당자가 있습니다", "error");
    if (isNew && !f.isPublic && seats <= 0) return toast(`담당자 자리가 없습니다 (요금제 최대 ${account.max_managers}명)`, "error");
    try {
      if (isNew) await db.addManager({ name, isAdmin: f.isAdmin, isPacker: f.isPacker, isPublic: f.isPublic, code: f.code });
      else await db.updateManager(initial.name, { name, isAdmin: f.isAdmin, isPacker: f.isPacker, isPublic: f.isPublic, code: f.code });
      await onSaved();
      toast(isNew ? "담당자를 추가했습니다" : "담당자를 수정했습니다", "ok");
      onClose();
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Modal title={isNew ? "담당자 추가" : "담당자 수정"} onClose={onClose}>
      <Field label="이름" htmlFor="mf-name"><input id="mf-name" className="forminput" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="품번 이니셜" htmlFor="mf-code" hint="선택 · 영문 1~2자"><input id="mf-code" className="forminput" value={f.code} maxLength={2} onChange={e => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
      <div className="section-label">역할</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Chip on={f.isAdmin} onClick={() => setF({ ...f, isAdmin: !f.isAdmin })}>관리자</Chip>
        <Chip on={f.isPacker} onClick={() => setF({ ...f, isPacker: !f.isPacker })}>포장 담당</Chip>
        <Chip on={f.isPublic} onClick={() => setF({ ...f, isPublic: !f.isPublic })}>공용(PIN 없음)</Chip>
      </div>
      <p className="helptext">관리자: 모든 주문 수정·출고완료·담당자 관리. 포장: 상태 변경과 메모만. 공용: 방문고객처럼 여러 사람이 쓰는 이름 — PIN 을 묻지 않습니다.</p>
      <div className="btnrow"><Button kind="white" onClick={onClose}>취소</Button><Button icon="check" onClick={save}>{isNew ? "추가" : "저장"}</Button></div>
    </Modal>
  );
}

function ManagersPanel() {
  const { managers, manager, isAdmin, readOnly, pinOf, reloadManagers, reloadPinStatus, activeManager, account } = useSaas();
  const toast = useToast();
  const [form, setForm] = useState(null);        // null | "new" | manager
  const [pinFor, setPinFor] = useState(null);    // 대상 담당자
  const [adminProof, setAdminProof] = useState(null); // 관리자 PIN 확인 뒤 다른 사람 PIN 설정
  const [removing, setRemoving] = useState(null);
  const refresh = async () => { await Promise.all([reloadManagers(), reloadPinStatus()]); };
  const seats = managerSeatsLeft(account, managers);

  const startPin = (m) => {
    const st = pinOf(m);
    if (!st?.has_pin || m.name === activeManager) { setPinFor({ m, proofBy: m }); return; }
    // 다른 사람의 기존 PIN 을 바꾸려면 관리자 PIN 으로 증명
    if (!isAdmin || !manager) return toast("다른 담당자의 PIN 은 관리자만 바꿀 수 있습니다", "error");
    setPinFor({ m, proofBy: manager });
  };
  const remove = async (m) => {
    try { await db.removeManager(m.name); await refresh(); toast(`${m.name} 담당자를 삭제했습니다`, "ok"); }
    catch (e) { toast(e.message || "삭제하지 못했습니다", "error"); }
    setRemoving(null);
  };

  return (
    <Panel title="담당자와 PIN" full right={isAdmin && !readOnly ? <Button size="sm" icon="plus" onClick={() => setForm("new")} disabled={seats <= 0 && !!account} title={seats <= 0 && account ? "담당자 자리가 없습니다" : undefined}>담당자 추가</Button> : null}>
      <p className="helptext" style={{ margin: "6px 0 4px" }}>직원은 회사 계정 하나로 들어와 자기 이름과 4자리 PIN 으로 작업합니다. PIN 은 본인이 바꾸고, 잃으면 관리자가 새로 놓아 줍니다.</p>
      {managers.length === 0 && <Empty small>등록된 담당자가 없습니다.</Empty>}
      {managers.map(m => {
        const st = pinOf(m);
        const locked = st?.locked_until && new Date(st.locked_until) > new Date();
        return (
          <div className="mgr-row" key={m.id ?? m.name}>
            <span className="avatar" style={{ width: 38, height: 38, borderRadius: 12 }}>{m.name.slice(0, 1)}</span>
            <div className="who">
              <strong>{m.name}{m.name === activeManager ? <small style={{ display: "inline", marginLeft: 6, color: "#2e6ee8", fontSize: 12 }}>· 나</small> : null}</strong>
              <small>{m.isAdmin ? "관리자" : m.isPacker ? "포장 담당" : m.isPublic ? "공용" : "담당자"}{m.code ? ` · 이니셜 ${m.code}` : ""}</small>
            </div>
            <span className="badges">
              {m.isPublic ? <StatusBadge tone="gray">PIN 없음(공용)</StatusBadge>
                : locked ? <StatusBadge tone="red">잠김</StatusBadge>
                : st?.has_pin ? <StatusBadge tone="green">PIN 설정됨</StatusBadge>
                : <StatusBadge tone="alert">PIN 없음</StatusBadge>}
            </span>
            <div className="acts">
              {!m.isPublic && !readOnly && (m.name === activeManager || isAdmin || !st?.has_pin) && (
                <Button size="sm" kind="white" icon="pin" onClick={() => startPin(m)}>{st?.has_pin ? "PIN 변경" : "PIN 만들기"}</Button>
              )}
              {isAdmin && !readOnly && <Button size="sm" kind="white" icon="edit" onClick={() => setForm(m)}>수정</Button>}
              {isAdmin && !readOnly && m.name !== activeManager && <Button size="sm" kind="danger" icon="trash" onClick={() => setRemoving(m)} aria-label={`${m.name} 삭제`} />}
            </div>
          </div>
        );
      })}
      {form && <ManagerForm initial={form === "new" ? null : form} onClose={() => setForm(null)} onSaved={refresh} />}
      {pinFor && <PinSetupModal manager={pinFor.m} proofBy={pinFor.proofBy} hasPin={!!pinOf(pinFor.m)?.has_pin}
        onDone={() => { setPinFor(null); toast(`${nim(pinFor.m.name)}의 PIN 을 저장했습니다`, "ok"); }} onClose={() => setPinFor(null)} />}
      {adminProof && <PinVerifyModal manager={manager} title="관리자 PIN 확인" onOk={() => setAdminProof(null)} onClose={() => setAdminProof(null)} />}
      {removing && <ConfirmModal title="담당자 삭제" message={`${removing.name} 담당자를 삭제할까요? 이 이름이 달린 주문은 그대로 남고 담당자만 비워집니다.`} confirmLabel="삭제" danger onConfirm={() => remove(removing)} onClose={() => setRemoving(null)} />}
    </Panel>
  );
}

export default function SettingsPage() {
  const { subscription } = useSaas();
  const notice = subscriptionNotice(subscription);
  return (
    <>
      <PageHead eyebrow="SETTINGS" title="회사 설정" subtitle="회사 정보·구독·운영 값·발송인·알림·담당자 PIN 을 한 곳에서 관리합니다." />
      {notice && <div className={`sub-banner${subscription.readOnly ? " ro" : ""}`}><span>{notice}</span></div>}
      {/* 두 기둥을 따로 쌓는다 — 한 격자에 넣으면 줄마다 가장 긴 카드에 맞춰 빈 공간이 생긴다. 왼쪽은 회사·운영, 오른쪽은 구독·기능. */}
      <div className="settings-grid">
        <div className="settings-col">
          <CompanyPanel />
          <OpsPanel />
          <CourierPanel />
          <SenderPanel />
        </div>
        <div className="settings-col">
          <SubscriptionPanel />
          <AiPanel />
          <SmsPanel />
          <DataImportPanel />
          <DisplayPanel />
        </div>
      </div>
      <div style={{ height: 18 }} />
      <ManagersPanel />
    </>
  );
}
