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
import { CJ, KD, COURIER_SHORT } from "../../lib/courier.js";
import { PLANS, managerSeatsLeft, subscriptionNotice } from "../lib/subscription.js";
import { KD_PAY_TYPES, DEFAULT_CONFIG } from "../config.js";
import { PinSetupModal, PinVerifyModal } from "../auth/PinGate.jsx";

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "—";
const fmtWon = (n) => `${Number(n || 0).toLocaleString()}원`;
const DAY = 86400000;
const PERIOD_DAYS = 30;   // api/_billing_logic.js PERIOD_DAYS 와 같은 값 — 화면 미리보기용
const TOSS_CLIENT_KEY = import.meta.env.VITE_TOSS_CLIENT_KEY || "";
const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || "";
const NOT_READY_TEXT = "결제 연동은 준비 중입니다. 구독 시작·연장은 운영자에게 연락해 주세요. 입금이 확인되면 기간이 늘어나고, 끝나도 데이터는 지워지지 않습니다(읽기 전용).";
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
export const opsFromConfig = (config) => ({ cut: String(config.shippingFee.cut), roll: String(config.shippingFee.roll), low: String(config.lowStockM), prefix: config.productPrefix, cjCut: config.pickupCutoff[CJ], kdCut: config.pickupCutoff[KD] });
const numOf = (v) => { const n = Number(String(v).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n >= 0 ? n : null; };
/** 검증. 틀리면 { error }, 맞으면 { patch }(saveSaasSettings 에 넣을 값) */
export function validateOps(f) {
  const c = numOf(f.cut), r = numOf(f.roll), l = numOf(f.low);
  if (c === null || r === null || l === null) return { error: "숫자만 넣어 주세요" };
  const px = String(f.prefix || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(px)) return { error: "품번 접두어는 영문 대문자로 시작하는 영문·숫자 1~6자" };
  if (!/^\d{1,2}:\d{2}$/.test(f.cjCut) || !/^\d{1,2}:\d{2}$/.test(f.kdCut)) return { error: "수거 마감은 15:30 처럼 시:분으로" };
  return { patch: { shippingFee: { cut: c, roll: r }, lowStockM: l, productPrefix: px, pickupCutoff: { [CJ]: f.cjCut, [KD]: f.kdCut } } };
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
        <Field label={`${COURIER_SHORT[CJ]} 수거 마감`} htmlFor={`${idPrefix}-cj`} hint="이 시각 전 포장완료면 당일 출고"><input id={`${idPrefix}-cj`} className="forminput" value={f.cjCut} onChange={set("cjCut")} placeholder="15:30" disabled={disabled} /></Field>
        <Field label={`${COURIER_SHORT[KD]} 수거 마감`} htmlFor={`${idPrefix}-kd`}><input id={`${idPrefix}-kd`} className="forminput" value={f.kdCut} onChange={set("kdCut")} placeholder="17:30" disabled={disabled} /></Field>
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
function CompanyPanel() {
  const { account, config, isAdmin, readOnly, reloadAccount, reloadSettings } = useSaas();
  const toast = useToast();
  const [name, setName] = useState(config.companyName);
  const [contact, setContact] = useState(account?.contact || "");
  useEffect(() => { setName(config.companyName); setContact(account?.contact || ""); }, [config.companyName, account?.contact]);
  const save = async () => {
    if (!name.trim()) return toast("회사명을 입력해 주세요", "error");
    try {
      if (account) await db.updateCompanyAccount({ name, contact });
      await db.saveSaasSettings({ companyName: name.trim() });
      await Promise.all([reloadAccount(), reloadSettings()]);
      toast("회사 정보를 저장했습니다", "ok");
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="회사 정보" small>
      <Field label="회사명" htmlFor="st-name"><input id="st-name" className="forminput" value={name} onChange={e => setName(e.target.value)} disabled={!isAdmin || readOnly} /></Field>
      {account && <Field label="담당 연락처" htmlFor="st-contact" hint="선택"><input id="st-contact" className="forminput" value={contact} onChange={e => setContact(e.target.value)} inputMode="tel" disabled={!isAdmin || readOnly} /></Field>}
      <dl className="kv">
        <dt>로그인 아이디</dt><dd>{account?.login_id || <span style={{ color: "#94a3b4" }}>사내 계정(아이디 없음)</span>}</dd>
        {account && <><dt>가입일</dt><dd>{fmtDate(account.created_at)}</dd></>}
      </dl>
      {isAdmin ? <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>
        : <p className="helptext" style={{ marginBottom: 0 }}>회사 정보는 관리자 담당자만 바꿀 수 있습니다.</p>}
    </Panel>
  );
}

// ── 구독 · 결제 ─────────────────────────────────────────────────
const EVENT_LABEL = { trial_start: "체험 시작", payment: "결제", extend: "기간 연장", cancel: "해지", plan_change: "요금제 변경", note: "메모", billing: "카드 결제" };

function PlanCard({ plan, price, current, on, onClick, disabled }) {
  const p = PLANS[plan];
  return (
    <button type="button" className={`plan-card${on ? " on" : ""}`} onClick={onClick} disabled={disabled} aria-pressed={on}>
      <span className="plan-name">{p.label}{current && <StatusBadge tone="green">현재</StatusBadge>}</span>
      <span className="plan-price">{fmtWon(price)}<small>/ 월</small></span>
      <span className="plan-desc">{p.desc}</span>
    </button>
  );
}

function SubscriptionPanel() {
  const { account, subscription, managers, isAdmin, isDemo, reloadAccount } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [events, setEvents] = useState([]);
  const [billing, setBilling] = useState(null);   // null = 확인 중 · { enabled:false } = 연동 없음
  const [plan, setPlan] = useState(() => account?.plan === "pro" ? "pro" : "basic");
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
  useEffect(() => { if (account?.plan === "pro") setPlan("pro"); }, [account?.plan]);

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
  const prices = billing?.prices || { basic: PLANS.basic.price, pro: PLANS.pro.price };
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
            <dt>요금제</dt><dd>{PLANS[account.plan]?.label || account.plan}</dd>
            {account.plan === "trial"
              ? <><dt>체험 종료</dt><dd>{fmtDate(account.trial_end)}{subscription.daysLeft != null ? <small style={{ color: "#8d9aab", fontWeight: 700 }}> · {subscription.daysLeft}일 남음</small> : null}</dd></>
              : <><dt>이용 기간</dt><dd>{account.current_period_end ? `${fmtDate(account.current_period_end)} 까지` : "기간 제한 없음"}</dd></>}
            <dt>담당자 자리</dt><dd>{managers.filter(m => !m.isPublic).length} / {account.max_managers}명 <small style={{ color: "#8d9aab", fontWeight: 700 }}>(공용 담당자 제외 · {seats}자리 남음)</small></dd>
          </dl>
          {notice && <p className={`helptext ${subscription.readOnly ? "err" : "warn"}`} style={{ marginBottom: 0 }}>{notice}</p>}

          <div className="section-label">요금제</div>
          <div className="plan-cards">
            {["basic", "pro"].map(k => (
              <PlanCard key={k} plan={k} price={prices[k]} current={account.plan === k} on={plan === k} onClick={() => setPlan(k)} disabled={!billing?.enabled || !isAdmin} />
            ))}
          </div>
          <p className="helptext" style={{ margin: "6px 0 0" }}>모든 요금제: 주문·재고·거래처·정산·포장대·변경 기록. 유료 요금제만 AI 분석(글·사진 읽기)과 출고 안내 문자를 쓸 수 있습니다. 부가세 별도.</p>

          {billing === null ? (
            <p className="helptext" style={{ margin: "14px 0 0" }}>결제 정보를 확인하는 중…</p>
          ) : !billing.enabled ? (
            <div className="notice-box" style={{ marginTop: 14 }}>{isDemo ? "체험 환경에서는 결제할 수 없습니다. 회사 가입 뒤 구독할 수 있습니다." : NOT_READY_TEXT}</div>
          ) : !isAdmin ? (
            <div className="notice-box" style={{ marginTop: 14 }}>결제·카드 관리는 관리자 담당자만 할 수 있습니다.</div>
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
              <Button icon="check" onClick={charge} disabled={!billing.hasCard} data-ro-ok="1">
                {isPaidPhase ? "지금 결제하고 연장" : "지금 결제하고 시작"} · {PLANS[plan].label} {fmtWon(prices[plan])}
              </Button>

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
      {removing && <ConfirmModal title="카드 삭제" message="등록된 카드를 삭제합니다. 자동 결제도 꺼지고, 남은 기간은 그대로 쓸 수 있습니다." confirmLabel="삭제" danger onConfirm={removeCard} onClose={() => setRemoving(false)} />}
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
      <p className="helptext" style={{ margin: "6px 0 0" }}>주문 등록 폼의 택배비 버튼, 재고 "부족" 판정, 품번 발급, 출고예정일 계산이 이 값을 씁니다.</p>
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

// ── 경동화물 송장 기본값 ──────────────────────────────────────
function KdPanel() {
  const { config, isAdmin, readOnly, reloadSettings } = useSaas();
  const toast = useToast();
  const from = (c) => ({ payType: c.kd.payType, itemName: c.kd.itemName, unitPrice: String(c.kd.unitPrice), extraFee: String(c.kd.extraFee) });
  const [f, setF] = useState(() => from(config));
  useEffect(() => { setF(from(config)); }, [config]);
  const dis = !isAdmin || readOnly;
  const save = async () => {
    const u = numOf(f.unitPrice), x = numOf(f.extraFee);
    if (u === null || x === null) return toast("단가·운임은 숫자만", "error");
    const itemName = f.itemName.trim() || DEFAULT_CONFIG.kd.itemName;
    try { await db.saveSaasSettings({ kd: { payType: f.payType, itemName, unitPrice: u, extraFee: x } }); await reloadSettings(); toast("경동 송장 기본값을 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title={`${COURIER_SHORT[KD]} 송장 기본값`} small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>경동화물 송장 엑셀의 "선불후불·품목명·개별단가·기타운임" 칸에 자동으로 들어가는 값입니다.</p>
      <div className="formlabel">선불 / 후불</div>
      <Segment options={KD_PAY_TYPES.map(k => [k, k])} value={f.payType} onChange={v => !dis && setF({ ...f, payType: v })} />
      <Field label="품목명" htmlFor="kd-item"><input id="kd-item" className="forminput" value={f.itemName} onChange={e => setF({ ...f, itemName: e.target.value })} disabled={dis} /></Field>
      <div className="formrow">
        <Field label="개별단가" htmlFor="kd-unit"><input id="kd-unit" className="forminput" inputMode="numeric" value={f.unitPrice} onChange={e => setF({ ...f, unitPrice: e.target.value })} disabled={dis} /></Field>
        <Field label="기타운임" htmlFor="kd-extra"><input id="kd-extra" className="forminput" inputMode="numeric" value={f.extraFee} onChange={e => setF({ ...f, extraFee: e.target.value })} disabled={dis} /></Field>
      </div>
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
  const { config, isAdmin, readOnly, reloadSettings, aiAllowed, account } = useSaas();
  const toast = useToast();
  const [on, setOn] = useState(config.notifySms);
  const [tpl, setTpl] = useState(config.notifySmsTemplate);
  useEffect(() => { setOn(config.notifySms); setTpl(config.notifySmsTemplate); }, [config.notifySms, config.notifySmsTemplate]);
  const paidOnly = !!account && !aiAllowed;   // 유료 전용 — AI 분석과 같은 기준(사내 계정은 허용)
  const dis = !isAdmin || readOnly || paidOnly;
  const save = async () => {
    const t = tpl.trim() || DEFAULT_CONFIG.notifySmsTemplate;
    if (t.length > 300) return toast("문자 문구는 300자 안으로", "error");
    try { await db.saveSaasSettings({ notifySms: on && !paidOnly, notifySmsTemplate: t }); await reloadSettings(); toast("알림 설정을 저장했습니다", "ok"); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  const preview = tpl.replace("{회사명}", config.companyName).replace("{고객명}", "홍길동").replace("{택배사}", COURIER_SHORT[CJ]);
  return (
    <Panel title="알림(문자)" small right={<StatusBadge tone={config.notifySms && !paidOnly ? "green" : "gray"}>{config.notifySms && !paidOnly ? "켜짐" : "꺼짐"}</StatusBadge>}>
      <button type="button" className="switch" role="switch" aria-checked={on && !paidOnly} onClick={() => !dis && setOn(v => !v)} disabled={dis}>
        <span className="knob" aria-hidden="true" /><span>출고 안내 문자 보내기</span>
      </button>
      <p className="helptext" style={{ margin: "4px 0 0" }}>출고완료로 바꾸면 고객 전화번호로 안내 문자를 보냅니다. 문자 건당 요금은 통신사 기준으로 따로 정산됩니다.</p>
      {paidOnly && <p className="helptext warn" style={{ margin: "12px 0 0" }}>출고 안내 문자는 유료 구독 회사 전용입니다. 구독하면 바로 켤 수 있습니다.</p>}
      <Field label="문자 문구" htmlFor="sms-tpl" hint="{회사명} {고객명} {택배사} 를 바꿔 넣습니다">
        <textarea id="sms-tpl" className="forminput" style={{ minHeight: 96 }} value={tpl} onChange={e => setTpl(e.target.value)} disabled={dis} maxLength={300} />
      </Field>
      <div className="notice-box">미리보기 · {preview}</div>
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly || paidOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 데이터 이관 ──────────────────────────────────────────────
function DataImportPanel() {
  const { account, config } = useSaas();
  const subject = encodeURIComponent(`[루프 ERP] 데이터 이관 요청 · ${account?.login_id || config.companyName}`);
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
      <p className="helptext" style={{ margin: "0 0 12px" }}>양식과 자세한 방법은 저장소의 <code>docs/saas-data-import.md</code> 에 있습니다. 보내신 자료는 이관이 끝나면 지웁니다.</p>
      {mailto
        ? <a className="btn btn-primary" href={mailto} style={{ textDecoration: "none" }}><Icon name="file" />이관 요청 메일 보내기</a>
        : <div className="notice-box">이관 요청은 가입할 때 안내받은 운영자 연락처로 보내 주세요. 제목에 회사 아이디(<b>{account?.login_id || config.companyName}</b>)를 적어 주시면 빠릅니다.</div>}
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
      <div className="settings-grid">
        <CompanyPanel />
        <SubscriptionPanel />
        <OpsPanel />
        <SenderPanel />
        <KdPanel />
        <DisplayPanel />
        <AiPanel />
        <SmsPanel />
        <DataImportPanel />
      </div>
      <div style={{ height: 18 }} />
      <ManagersPanel />
    </>
  );
}
