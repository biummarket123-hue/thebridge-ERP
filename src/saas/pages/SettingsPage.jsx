// 회사 설정(/app/settings) — 회사 정보 · 구독 상태 · 운영 값(택배비·재고 기준) · 담당자와 PIN.
// 메뉴 5개 밖의 화면이라 사이드바 아래/프로필 메뉴에서 들어온다. 요금제·기간은 여기서 못 바꾼다(서버 전용, DB 트리거).
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal, ConfirmModal } from "../components/Modal.jsx";
import { PageHead, Panel, Button, StatusBadge, Chip, Empty, nim } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { PICKUP, OLD_ERP_PATH } from "../config.js";
import { CJ, KD, COURIER_SHORT } from "../../lib/courier.js";
import { PLANS, managerSeatsLeft, subscriptionNotice } from "../lib/subscription.js";
import { PinSetupModal, PinVerifyModal } from "../auth/PinGate.jsx";

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "—";
const fmtWon = (n) => `${Number(n || 0).toLocaleString()}원`;

function Field({ label, children, htmlFor, hint }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{hint ? <span className="opt">{hint}</span> : null}</label>{children}</div>;
}

// ── 회사 정보 ─────────────────────────────────────────────────
function CompanyPanel() {
  const { account, config, isAdmin, readOnly, reloadAccount, reloadSettings } = useSaas();
  const toast = useToast();
  const [name, setName] = useState(config.companyName);
  const [contact, setContact] = useState(account?.contact || "");
  useEffect(() => { setName(config.companyName); setContact(account?.contact || ""); }, [config.companyName, account?.contact]);
  const save = async () => {
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

// ── 구독 ─────────────────────────────────────────────────────
function SubscriptionPanel() {
  const { account, subscription, managers } = useSaas();
  const [events, setEvents] = useState([]);
  useEffect(() => { if (account) db.fetchSubscriptionEvents().then(setEvents).catch(() => {}); }, [account]);
  const tone = subscription.readOnly ? "red" : subscription.soon ? "alert" : "green";
  const label = subscription.phase === "none" ? "사내 계정" : subscription.phase === "trial" ? "무료 체험 중" : subscription.phase === "paid" ? "구독 중" : subscription.phase === "grace" ? "결제 대기(유예)" : subscription.phase === "canceled" ? "해지됨" : "만료";
  const seats = managerSeatsLeft(account, managers);
  const notice = subscriptionNotice(subscription);
  return (
    <Panel title="구독" small right={<StatusBadge tone={tone}>{label}</StatusBadge>}>
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
          <div className="notice-box" style={{ marginTop: 14 }}>
            결제 연동은 준비 중입니다. 구독 시작·연장은 운영자에게 연락해 주세요. 입금이 확인되면 기간이 늘어나고, 끝나도 데이터는 지워지지 않습니다(읽기 전용).
          </div>
          {events.length > 0 && (
            <>
              <div className="section-label">이력</div>
              <ul className="events">
                {events.map(ev => (
                  <li key={ev.id}>
                    <span>{{ trial_start: "체험 시작", payment: "결제", extend: "기간 연장", cancel: "해지", plan_change: "요금제 변경", note: "메모" }[ev.kind] || ev.kind}{ev.memo ? ` · ${ev.memo}` : ""}{ev.amount ? ` · ${fmtWon(ev.amount)}` : ""}</span>
                    <small>{fmtDate(ev.created_at)}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

// ── 운영 값 ──────────────────────────────────────────────────
function OpsPanel() {
  const { config, isAdmin, readOnly, reloadSettings } = useSaas();
  const toast = useToast();
  const [cut, setCut] = useState(String(config.shippingFee.cut));
  const [roll, setRoll] = useState(String(config.shippingFee.roll));
  const [low, setLow] = useState(String(config.lowStockM));
  const [prefix, setPrefix] = useState(config.productPrefix);
  useEffect(() => { setCut(String(config.shippingFee.cut)); setRoll(String(config.shippingFee.roll)); setLow(String(config.lowStockM)); setPrefix(config.productPrefix); }, [config]);
  const num = (v) => { const n = Number(String(v).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n >= 0 ? n : null; };
  const save = async () => {
    const c = num(cut), r = num(roll), l = num(low);
    if (c === null || r === null || l === null) return toast("숫자만 넣어 주세요", "error");
    const px = prefix.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,5}$/.test(px)) return toast("품번 접두어는 영문 대문자로 시작하는 영문·숫자 1~6자", "error");
    try {
      await db.saveSaasSettings({ shippingFee: { cut: c, roll: r }, lowStockM: l, productPrefix: px });
      await reloadSettings();
      toast("운영 값을 저장했습니다", "ok");
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
  };
  return (
    <Panel title="운영 값" small>
      <p className="helptext" style={{ margin: "6px 0 0" }}>주문 등록 폼의 택배비 버튼과 재고 "부족" 판정이 이 값을 씁니다. 옛 ERP 화면의 값(택배사 마감 등)은 거기서 그대로 읽습니다.</p>
      <div className="formrow">
        <Field label="택배비 · 소량(마)" htmlFor="st-cut"><input id="st-cut" className="forminput" inputMode="numeric" value={cut} onChange={e => setCut(e.target.value)} disabled={!isAdmin || readOnly} /></Field>
        <Field label="택배비 · 롤" htmlFor="st-roll"><input id="st-roll" className="forminput" inputMode="numeric" value={roll} onChange={e => setRoll(e.target.value)} disabled={!isAdmin || readOnly} /></Field>
      </div>
      <div className="formrow">
        <Field label="재고 부족 기준(마)" htmlFor="st-low" hint="가장 긴 롤이 이보다 짧으면 부족"><input id="st-low" className="forminput" inputMode="numeric" value={low} onChange={e => setLow(e.target.value)} disabled={!isAdmin || readOnly} /></Field>
        <Field label="품번 접두어" htmlFor="st-prefix" hint="영문 1~6자 · 예: TE-2610-0001"><input id="st-prefix" className="forminput" value={prefix} maxLength={6} onChange={e => setPrefix(e.target.value.toUpperCase())} disabled={!isAdmin || readOnly} /></Field>
      </div>
      <dl className="kv">
        <dt>수거 마감</dt><dd>{COURIER_SHORT[CJ]} {PICKUP[CJ]} · {COURIER_SHORT[KD]} {PICKUP[KD]} <small style={{ color: "#8d9aab", fontWeight: 700 }}>(코드 설정 · 다음 단계)</small></dd>
      </dl>
      {isAdmin && <div style={{ marginTop: 18 }}><Button icon="check" onClick={save} disabled={readOnly}>저장</Button></div>}
    </Panel>
  );
}

// ── 담당자 ───────────────────────────────────────────────────
function ManagerForm({ initial, onClose, onSaved }) {
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
      <PageHead eyebrow="SETTINGS" title="회사 설정" subtitle="회사 정보·구독·운영 값·담당자 PIN 을 한 곳에서 관리합니다." />
      {notice && <div className={`sub-banner${subscription.readOnly ? " ro" : ""}`}><span>{notice}</span></div>}
      <div className="settings-grid">
        <CompanyPanel />
        <SubscriptionPanel />
        <OpsPanel />
        <Panel title="옛 ERP 화면" small>
          <p className="helptext" style={{ margin: "6px 0 14px" }}>포장 스캔·라벨 출력·공지·메모 채팅·카카오 설정은 아직 옛 화면에서 처리합니다.</p>
          <a className="btn btn-white" href={OLD_ERP_PATH} style={{ textDecoration: "none", width: "auto" }}><Icon name="layers" /> 기존 ERP 화면 열기</a>
        </Panel>
      </div>
      <div style={{ height: 18 }} />
      <ManagersPanel />
    </>
  );
}
