// 주문 상세 모달 — 품목·금액·결제 상태(getPayStatus)·배송지·담당자, 상태 변경(접수/포장완료)·보관(요청→창고에 넣음)·보류·출고요청·출고완료·출고 취소·
// 입금 확인·입금 취소·환불 신청·합배송(묶기·해제·분리·운임비)·택배사·사진·수정·삭제·변경 기록.
// 섹션별 컴포넌트로 나눴다(MergeSection·CourierChips·PhotoSection). 옛 ErpApp 주문현황 카드의 버튼을 한 화면에 모은 것.
import { useMemo, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { MergeModal, FreightModal } from "../components/MergeModal.jsx";
import { Button, StatusBadge, Chip, won, shortId } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { isHold, isParked, getPayStatus, maskPhone } from "../../constants.js";
import { orderTotal, orderUnpaid, orderPaid, relativeWhen } from "../lib/metrics.js";
import { shipBucket, BUCKETS } from "../../lib/shipDate.js";
import { COURIER_SHORT, COURIERS } from "../../lib/courier.js";
import { trackingUrl, cleanTrackingNo } from "../lib/tracking.js";
import { patchOrdersWithGroupResult } from "../../lib/freight.js";
import { orderBadges } from "./HomePage.jsx";
import * as act from "../actions/orders.js";
import { shipOut, canShipByPayment } from "../actions/ship.js";
import { shippedMatesOf, canCancelDeposit } from "../lib/orderRules.js";
import "../saas-orders.css";

const UNIT_OPTS = ["마", "세트", "필", "롤", "kg"];

function Field({ label, children, opt }) {
  return <div><label className="formlabel">{label}{opt ? <span className="opt">선택</span> : null}</label>{children}</div>;
}

function EditForm({ order, onSaved, onCancel }) {
  const { orders, managers, activeManager, isAdmin, isPacker, setOrders } = useSaas();
  const toast = useToast();
  const [f, setF] = useState(() => ({
    items: (order.items || []).map(i => ({ ...i })), address: order.address || "", address_detail: order.addressDetail || "", deliveryMessage: order.deliveryMessage || "",
    shippingFee: order.shippingFee || 0, otherCost: order.otherCost || 0, totalAmount: order.totalAmount || 0, note: order.note || "", memo: order.memo || "", phone: order.phone || "", shipDate: order.shipDate || "",
  }));
  const [busy, setBusy] = useState(false);
  const setItem = (i, k, v) => setF(p => { const items = p.items.map((it, j) => j === i ? { ...it, [k]: v } : it); return { ...p, items }; });
  const itemsSum = f.items.reduce((s, i) => s + (parseInt(i.amount) || 0), 0);
  const calcTotal = itemsSum + (parseInt(f.shippingFee) || 0) + (parseInt(f.otherCost) || 0);
  const save = async () => {
    setBusy(true);
    try {
      const items = f.items.filter(i => String(i.fabric || "").trim()).map(i => ({ ...i, qty: parseFloat(i.qty) || 0, amount: parseInt(i.amount) || 0, unitPrice: parseInt(i.unitPrice) || 0 }));
      const patch = { items: db.ensureItemIds(items), address: f.address, addressDetail: f.address_detail, deliveryMessage: f.deliveryMessage, shippingFee: parseInt(f.shippingFee) || 0, otherCost: parseInt(f.otherCost) || 0,
        totalAmount: parseInt(f.totalAmount) || calcTotal, note: f.note, memo: f.memo, phone: f.phone, ...(f.shipDate ? { shipDate: f.shipDate } : {}) };
      const r = await act.editOrder(order, patch, { orders, managers, activeManager, isAdmin, isPacker });
      setOrders(p => p.map(o => o.id === order.id ? { ...o, ...patch } : o));
      toast(r.msg); onSaved();
    } catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <>
      <p className="helptext warn">실제 주문(운영 DB)이 바뀝니다. 금액을 바꾸면 미수금·입금 대조가 달라집니다.</p>
      <div className="section-label">품목</div>
      {f.items.map((it, i) => (
        <div key={i} className="notice-box" style={{ marginBottom: 8 }}>
          <div className="formrow">
            <Field label="품번"><input className="forminput" value={it.itemNo || ""} onChange={e => setItem(i, "itemNo", e.target.value)} /></Field>
            <Field label="원단명"><input className="forminput" value={it.fabric || ""} onChange={e => setItem(i, "fabric", e.target.value)} /></Field>
            <Field label="색상"><input className="forminput" value={it.color || ""} onChange={e => setItem(i, "color", e.target.value)} /></Field>
            <Field label="수량 · 단위"><div style={{ display: "flex", gap: 6 }}><input className="forminput" inputMode="decimal" value={it.qty ?? ""} onChange={e => setItem(i, "qty", e.target.value)} /><select className="forminput" style={{ width: 90 }} value={it.unit || "마"} onChange={e => setItem(i, "unit", e.target.value)}>{UNIT_OPTS.map(u => <option key={u}>{u}</option>)}</select></div></Field>
            <Field label="단가"><input className="forminput" inputMode="numeric" value={it.unitPrice ?? ""} onChange={e => setItem(i, "unitPrice", e.target.value)} /></Field>
            <Field label="금액"><input className="forminput" inputMode="numeric" value={it.amount ?? ""} onChange={e => setItem(i, "amount", e.target.value)} /></Field>
          </div>
          <button className="text-link" style={{ padding: "8px 0 0" }} onClick={() => setF(p => ({ ...p, items: p.items.filter((_, j) => j !== i) }))}>이 품목 빼기</button>
        </div>
      ))}
      <button className="text-link" style={{ padding: "4px 0 10px" }} onClick={() => setF(p => ({ ...p, items: [...p.items, { itemNo: "", fabric: "", color: "", qty: 0, unit: "마", amount: 0, unitPrice: 0 }] }))}>+ 품목 추가</button>
      <div className="formrow">
        <Field label="배송비"><input className="forminput" inputMode="numeric" value={f.shippingFee} onChange={e => setF({ ...f, shippingFee: e.target.value })} /></Field>
        <Field label="기타 비용"><input className="forminput" inputMode="numeric" value={f.otherCost} onChange={e => setF({ ...f, otherCost: e.target.value })} /></Field>
        <Field label={`전체 금액 (품목합+배송비 = ${won(calcTotal)})`}><input className="forminput" inputMode="numeric" value={f.totalAmount} onChange={e => setF({ ...f, totalAmount: e.target.value })} /></Field>
        <Field label="출고예정일" opt><input className="forminput" type="date" value={f.shipDate} onChange={e => setF({ ...f, shipDate: e.target.value })} /></Field>
        <Field label="연락처"><input className="forminput" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="배송 메시지" opt><input className="forminput" value={f.deliveryMessage} onChange={e => setF({ ...f, deliveryMessage: e.target.value })} /></Field>
      </div>
      <Field label="주소"><input className="forminput" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="상세 주소" opt><input className="forminput" value={f.address_detail} onChange={e => setF({ ...f, address_detail: e.target.value })} /></Field>
      <Field label="메모(원문)" opt><textarea className="forminput" style={{ minHeight: 90 }} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></Field>
      <Field label="담당자 메모" opt><input className="forminput" value={f.memo} onChange={e => setF({ ...f, memo: e.target.value })} /></Field>
      <div className="btnrow" style={{ marginTop: 20 }}><Button kind="white" onClick={onCancel}>취소</Button><Button icon="check" onClick={save} loading={busy}>저장</Button></div>
    </>
  );
}

function RefundForm({ order, onDone, onCancel }) {
  const { orders, managers, activeManager, isAdmin, isPacker, reloadOrders } = useSaas();
  const toast = useToast();
  const paid = orderPaid(order) > 0 ? orderPaid(order) : orderTotal(order);
  const [method, setMethod] = useState("cash");
  const [kind, setKind] = useState("full");
  const [amount, setAmount] = useState(String(paid));
  const [reason, setReason] = useState("");
  const [bank, setBank] = useState(""); const [accountNumber, setAccountNumber] = useState(""); const [accountHolder, setAccountHolder] = useState(order.customer || "");
  const amt = kind === "full" ? paid : (parseInt(String(amount).replace(/\D/g, "")) || 0);
  const over = amt > paid;
  const submit = async () => {
    try {
      const r = await act.requestRefund(order, { method, kind, amount: amt, reason: reason.trim(), ...(method === "cash" ? { bank: bank.trim(), accountNumber: accountNumber.trim(), accountHolder: accountHolder.trim() } : {}) }, { orders, managers, activeManager, isAdmin, isPacker });
      await reloadOrders(); toast(r.msg); onDone();
    } catch (e) { toast(e.message, "error"); }
  };
  return (
    <>
      <p className="helptext">{order.customer} · 입금액 {won(paid)}. 신청하면 대표가 정산에서 확인 후 승인합니다.</p>
      <div className="section-label">환불 방식</div>
      <div className="chiprow"><Chip on={method === "cash"} onClick={() => setMethod("cash")}>💵 현금환불</Chip><Chip on={method === "credit"} onClick={() => setMethod("credit")}>🪙 적립금환불</Chip></div>
      {method === "cash" && (
        <div className="formrow" style={{ marginTop: 6 }}>
          <Field label="은행"><input className="forminput" value={bank} onChange={e => setBank(e.target.value)} /></Field>
          <Field label="예금주"><input className="forminput" value={accountHolder} onChange={e => setAccountHolder(e.target.value)} /></Field>
          <Field label="계좌번호"><input className="forminput mono" inputMode="numeric" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} /></Field>
        </div>
      )}
      <div className="section-label">환불 범위</div>
      <div className="chiprow"><Chip on={kind === "full"} onClick={() => { setKind("full"); setAmount(String(paid)); }}>전액환불</Chip><Chip on={kind === "partial"} onClick={() => setKind("partial")}>부분환불</Chip></div>
      <Field label="환불 금액"><input className="forminput" inputMode="numeric" disabled={kind === "full"} value={kind === "full" ? paid.toLocaleString() : amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} /></Field>
      {over && <p className="helptext err">입금액({won(paid)})을 초과할 수 없습니다</p>}
      <Field label="사유" opt><input className="forminput" value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 단순변심 · 불량 · 오배송" /></Field>
      <div className="btnrow" style={{ marginTop: 20 }}><Button kind="white" onClick={onCancel}>취소</Button><Button kind="danger" onClick={submit} disabled={amt <= 0 || over} icon="undo">{won(amt)} 환불 신청</Button></div>
    </>
  );
}

/** 합배송 섹션 — 묶음 멤버 목록 + 묶기·해제·분리·운임비 조정. 묶기는 출고완료 제외(접수 상태만 후보). */
function MergeSection({ o, ctx, lock, busy, run, onPatched, toast, setOrders, customers }) {
  const { orders, isPacker } = ctx;
  const [modal, setModal] = useState(null);   // merge | freight
  const members = useMemo(() => o.mergeGroupId ? orders.filter(x => x.mergeGroupId === o.mergeGroupId).sort((a, b) => String(a.id).localeCompare(String(b.id))) : [], [o.mergeGroupId, orders]);
  const live = members.filter(x => x.status !== "출고완료");
  const shipped = o.status === "출고완료";

  const doMerge = async (ids) => {
    const r = await run("merge", async () => {
      const r = await act.mergeOrders(o, ids, ctx);
      setOrders(p => patchOrdersWithGroupResult(p.map(x => r.ids.includes(x.id) ? { ...x, mergeGroupId: r.groupId } : x), r.res));
      if (r.warn) toast(r.warn, "error");
      return r.conflict ? { ...r, err: r.msg, msg: "" } : r;
    });
    if (r) setModal(null);
  };
  const doLeave = async () => {
    const ok = await ctx.confirm(`#${shortId(o.id)} (${o.customer}) 주문만 합배송 그룹에서 뺍니다.\n남은 ${live.length - 1}건은 그대로 묶여 있고, 출고일·택배비는 다시 계산됩니다.`, { title: "묶음 해제", confirmLabel: "이 주문만 빼기" });
    if (!ok) return;
    await run("leave", () => act.leaveGroup(o, ctx, { onPatched, toast }));   // 그룹 표시는 reloadOrders 가 되돌린다
  };
  const doSplit = () => run("split", async () => {
    const r = await act.toggleSplit(o, ctx, { onPatched, toast });
    setOrders(p => p.map(x => x.id === o.id ? { ...x, splitShipping: r.splitShipping } : x));
    return r;
  });
  const doFreight = async ({ bearerId, amount }) => {
    const r = await run("freight", async () => {
      const r = await act.adjustFreight(o, members, bearerId, amount, ctx);
      setOrders(p => p.map(x => { const c = r.plan.find(c => c.id === x.id); return c ? { ...x, shippingFee: c.shippingFee, feeHeld: null } : x; }));
      return r;
    });
    if (r) setModal(null);
  };

  return (
    <>
      <div className="section-label">합배송</div>
      {members.length > 0 ? (
        <div className="od-members">
          {members.map(g => (
            <div key={g.id} className={`od-member${g.id === o.id ? " me" : ""}`}>
              <span className="mono od-id">{shortId(g.id)}</span>
              <span className="who">{g.customer}</span>
              <span className="what">{(g.items || []).map(it => `${it.fabric || ""}${it.color ? ` ${it.color}` : ""} ${it.qty || 0}${it.unit || "마"}`).join(", ") || "(품목 없음)"}</span>
              <span className="badges">
                <StatusBadge tone={g.status === "출고완료" ? "done" : g.status === "포장완료" ? "progress" : "wait"}>{g.status}</StatusBadge>
                {g.splitShipping && <StatusBadge tone="late">분리</StatusBadge>}
                {g.shippingFee > 0 && <StatusBadge tone="gray">택배비 {won(g.shippingFee)}</StatusBadge>}
              </span>
            </div>
          ))}
        </div>
      ) : <p className="helptext" style={{ margin: "0 0 8px" }}>합배송 묶음이 아닙니다. 같은 고객의 접수 주문을 한 박스로 보내려면 묶어 주세요.</p>}
      <div className="chiprow">
        {!shipped && o.status === "접수" && <Chip disabled={!!busy || !!lock} onClick={() => setModal("merge")}>🔗 합배송 묶기</Chip>}
        {!shipped && o.mergeGroupId && !isPacker && <Chip danger disabled={!!busy || !!lock} onClick={doLeave}>묶음 해제</Chip>}
        {!shipped && o.mergeGroupId && <Chip on={!!o.splitShipping} disabled={!!busy || !!lock} onClick={doSplit} title={o.splitShipping ? "다시 묶음과 함께 나가게" : "이 주문만 따로 나가게"}>{o.splitShipping ? "분리 해제" : "분리 배송"}</Chip>}
        {o.mergeGroupId && !isPacker && <Chip disabled={!!busy || !!lock} onClick={() => setModal("freight")}>💰 운임비 조정</Chip>}
      </div>
      {modal === "merge" && <MergeModal sourceOrder={o} orders={orders} customers={customers} sameCustomerOnly={isPacker} onConfirm={doMerge} onClose={() => setModal(null)} />}
      {modal === "freight" && <FreightModal targetOrder={o} groupOrders={members} onConfirm={doFreight} onClose={() => setModal(null)} />}
    </>
  );
}

/** 송장번호 — 보기·조회 링크·고치기. 출고 안내 문자의 {송장번호}에도 들어간다. */
function TrackingCell({ o, info, run, setOrders, busy }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(o.trackingNo || "");
  const url = trackingUrl(info?.courier || o.courier, o.trackingNo);
  const save = () => run("track", async () => {
    const no = cleanTrackingNo(v);
    await db.updateOrder(o.id, { trackingNo: no }, { route: "송장번호 입력 · 새 UI" });
    setOrders(p => p.map(x => x.id === o.id ? { ...x, trackingNo: no } : x));
    setEdit(false);
    return { msg: no ? `송장번호 ${no}` : "송장번호 지움" };
  }, { reload: false });
  if (edit) return (
    <span className="inline-field" style={{ maxWidth: 360 }}>
      <input className="forminput" value={v} onChange={e => setV(e.target.value)} inputMode="numeric" placeholder="송장번호" autoFocus />
      <Button size="sm" onClick={save} loading={busy === "track"}>저장</Button>
      <Button size="sm" kind="white" onClick={() => { setEdit(false); setV(o.trackingNo || ""); }}>취소</Button>
    </span>
  );
  return (
    <>
      {o.trackingNo ? <span className="mono">{o.trackingNo}</span> : <span style={{ color: "#94a3b4" }}>없음</span>}
      {url && <a href={url} target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontWeight: 800 }}>배송 조회 ↗</a>}
      <button type="button" className="text-link" style={{ marginLeft: 8, padding: 0 }} onClick={() => setEdit(true)}>{o.trackingNo ? "고치기" : "입력"}</button>
    </>
  );
}

/** 택배사 미리 지정(선택) — 비워 두면 송장 뽑을 때 고른다. 같은 박스(묶음)에 함께 적용된다. */
function CourierChips({ o, ctx, info, lock, busy, run, setOrders }) {
  const { config } = useSaas();
  const manual = info?.why === "manual" ? info.courier : null;
  const pick = (c) => run("courier", async () => {
    const r = await act.setCourier(o, c, ctx);
    setOrders(p => p.map(x => r.ids.includes(x.id) ? { ...x, courier: r.courier } : x));
    return r;
  }, { reload: false });
  return (
    <>
      <div className="section-label">택배사 미리 지정 <small style={{ color: "#94a3b4", fontWeight: 700 }}>선택 · 비워 두면 송장 뽑을 때 고릅니다</small></div>
      <div className="chiprow">
        <Chip on={!manual} disabled={!!busy || !!lock} onClick={() => manual && pick(null)}>{info?.pickup ? "방문·픽업" : "송장 뽑을 때 고름"}</Chip>
        {config.couriers.map(c => <Chip key={c.name} on={manual === c.name} disabled={!!busy || !!lock} onClick={() => manual !== c.name && pick(c.name)}>{c.name}</Chip>)}
      </div>
    </>
  );
}

/** 사진 — 여러 장 올리기(압축 후 스토리지), 썸네일(새 탭), 한 장 빼기. */
function PhotoSection({ o, ctx, busy, run, setOrders, confirm }) {
  const fileRef = useRef(null);
  const images = Array.isArray(o.images) ? o.images : [];
  const onFiles = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    run("photo", async () => {
      const r = await act.addImages(o, files, ctx);
      setOrders(p => p.map(x => x.id === o.id ? { ...x, images: r.images } : x));
      return r;
    }, { reload: false });
  };
  const remove = async (i) => {
    if (!await confirm("이 사진을 주문에서 뺍니다. 되돌릴 수 없습니다.", { danger: true, confirmLabel: "빼기" })) return;
    run("photo", async () => {
      const r = await act.removeImage(o, i, ctx);
      setOrders(p => p.map(x => x.id === o.id ? { ...x, images: r.images } : x));
      return r;
    }, { reload: false });
  };
  return (
    <>
      <div className="section-label">사진{images.length ? ` ${images.length}장` : ""}</div>
      <div className="od-photos">
        {images.map((url, i) => (
          <div key={`${url}-${i}`} className="od-photo">
            <a href={url} target="_blank" rel="noreferrer" title="새 탭에서 크게 보기"><img src={url} alt={`주문 사진 ${i + 1}`} loading="lazy" /></a>
            {o.status !== "출고완료" && <button type="button" className="x" aria-label="사진 빼기" disabled={!!busy} onClick={() => remove(i)}>×</button>}
          </div>
        ))}
        {o.status !== "출고완료" && (
          <button type="button" className="od-photo-add" disabled={!!busy} onClick={() => fileRef.current?.click()}><Icon name="camera" />{busy === "photo" ? "올리는 중…" : "사진 올리기"}</button>
        )}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      </div>
      {images.length === 0 && o.status === "출고완료" && <p className="helptext" style={{ margin: 0 }}>출고완료 때 사진은 지워집니다.</p>}
    </>
  );
}

export default function OrderDetail({ order, onClose, go }) {
  const saas = useSaas();
  const { orders, managers, activeManager, isAdmin, isPacker, setOrders, reloadOrders, courierById, credits, customers } = saas;
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [mode, setMode] = useState(null);   // edit | refund | park | deposit | credit
  const [parkReason, setParkReason] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const ctx = { orders, managers, activeManager, isAdmin, isPacker, confirm };
  const o = order;
  const pay = getPayStatus(o);
  const held = isHold(o), parked = isParked(o);
  const total = orderTotal(o), unpaid = orderUnpaid(o), paid = orderPaid(o);
  const lock = act.lockOf(o, ctx);
  const info = courierById.get(o.id);
  const group = useMemo(() => act.groupOf(o, orders).filter(x => x.id !== o.id), [o, orders]);
  const creditBal = useMemo(() => (credits || []).filter(c => c.customer === o.customer).reduce((s, c) => s + (c.type === "적립" ? c.amount : -c.amount), 0), [credits, o.customer]);
  const bucket = BUCKETS[shipBucket(o)];
  const shipped = o.status === "출고완료";

  const run = async (key, fn, { reload = true } = {}) => {
    setBusy(key);
    try { const r = await fn(); if (reload) await reloadOrders(); if (r?.err) toast(r.err, "error"); else if (r?.msg) toast(r.msg); return r; }
    catch (e) { toast(e.message || String(e), "error"); return null; }
    finally { setBusy(""); }
  };
  const onShipped = (ord, patch) => setOrders(p => p.map(x => x.id === ord.id ? { ...x, ...patch } : x));
  const onPatched = (res) => setOrders(p => patchOrdersWithGroupResult(p, res));
  const doShip = () => run("ship", async () => {
    const r = await shipOut(o, { orders, isAdmin, confirm, onShipped, onPatched, toast });
    if (!r.ok) throw new Error(r.reason);
    return { msg: r.shipped.length > 1 ? `합배송 ${r.shipped.length}건 출고 완료` : "출고 처리 완료" };
  });
  const doUndoShip = async () => {
    const ok = await confirm(`주문 #${shortId(o.id)} (${o.customer})의 출고완료를 취소합니다.\n상태는 포장완료로 돌아가고, 출고 시각·입출고 이력(출고 로그)이 지워집니다. 재고는 되돌리지 않습니다(포장대에서 이미 빠짐).`, { title: "출고 취소", danger: true, confirmLabel: "출고 취소" });
    if (!ok) return;
    const mates = shippedMatesOf(o, orders);
    let withGroup = false;
    if (mates.length) withGroup = await confirm(`같이 나간 합배송 묶음 ${mates.length}건도 함께 되돌릴까요?\n\n${mates.map(m => `· ${m.customer} ${shortId(m.id)}`).join("\n")}\n\n[취소]를 누르면 이 주문만 되돌립니다.`, { title: "묶음도 함께", confirmLabel: `묶음 ${mates.length + 1}건 모두`, cancelLabel: "이 주문만" });
    await run("undo", () => act.undoShipOut(o, ctx, { withGroup }));
  };
  const doCancelDeposit = async () => {
    const ok = await confirm(`주문 #${shortId(o.id)} (${o.customer})의 입금 ${won(paid)}을 취소합니다.\n입금 기록(payment_logs 의 "입금")이 전부 지워지고 미입금으로 돌아갑니다. 적립금·배송권 차감 기록은 그대로 둡니다.`, { title: "입금 취소", danger: true, confirmLabel: "입금 취소" });
    if (!ok) return;
    await run("cancelPay", () => act.cancelDeposit(o, pay, ctx));
  };
  const doDelete = async () => {
    const ok = await confirm(`주문 #${shortId(o.id)} (${o.customer})을 삭제합니다. 되돌릴 수 없습니다.${o.mergeGroupId ? "\n합배송 묶음의 다른 주문은 남습니다." : ""}`, { danger: true, confirmLabel: "삭제" });
    if (!ok) return;
    const r = await run("del", () => act.deleteOrder(o, ctx), { reload: false });
    if (r && !r.cancelled) { setOrders(p => p.filter(x => x.id !== o.id)); onClose(); }
  };

  const title = mode === "edit" ? "주문 수정" : mode === "refund" ? "환불 신청" : "주문 상세";
  return (
    <Modal title={title} onClose={onClose} width="wide">
      {host}
      {mode === "edit" ? <EditForm order={o} onSaved={() => setMode(null)} onCancel={() => setMode(null)} />
        : mode === "refund" ? <RefundForm order={o} onDone={() => setMode(null)} onCancel={() => setMode(null)} />
        : (
          <>
            <p className="helptext" style={{ marginBottom: 8 }}><span className="mono">{shortId(o.id)}</span> · {relativeWhen(o.createdAt) || `${o.date} ${o.time || ""}`}{o.manager ? ` · 담당 ${o.manager}` : " · 담당자 없음"}{o.salesChannel ? ` · ${o.salesChannel}` : ""}</p>
            <div className="badges" style={{ marginBottom: 6 }}>
              {orderBadges(o).map(([t, l]) => <StatusBadge key={l} tone={t}>{l}</StatusBadge>)}
              {o.isUrgent ? <StatusBadge tone="late">긴급</StatusBadge> : o.shipDate ? <StatusBadge tone="gray">{bucket.emoji} {bucket.label} {o.shipDate}</StatusBadge> : null}
              {info && (info.pickup || info.courier) ? <StatusBadge tone="gray">{info.pickup ? "방문·픽업" : (COURIER_SHORT[info.courier] || info.courier)}</StatusBadge> : null}
              {o.invoicePrintedAt ? <StatusBadge tone="done">송장 출력됨</StatusBadge> : null}
              {o.shipRequestedAt ? <StatusBadge tone="purple">출고요청</StatusBadge> : null}
              {o.splitShipping ? <StatusBadge tone="late">분리 배송</StatusBadge> : null}
            </div>
            {lock && <p className="helptext warn" style={{ margin: "10px 0" }}>🔒 {lock}</p>}
            <div className="kv">
              <div className="invrow"><span>거래처</span><strong>{o.customer}{o.phone ? <small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>{isAdmin ? o.phone : maskPhone(o.phone)}</small> : null}</strong></div>
              <div className="invrow"><span>배송지</span><strong style={{ fontWeight: 600 }}>{o.address ? `${o.address}${o.addressDetail ? ` ${o.addressDetail}` : ""}` : "—"}{o.deliveryMessage ? <small style={{ display: "block", color: "#8d9bab" }}>📝 {o.deliveryMessage}</small> : null}</strong></div>
              <div className="invrow"><span>주문 금액</span><strong>{won(total)}<small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>배송비 {won(o.shippingFee)}{o.feeHeld ? ` (묶여서 ${won(o.feeHeld)} 내려놓음)` : ""}{o.otherCost ? ` · 기타 ${won(o.otherCost)}` : ""}</small></strong></div>
              <div className="invrow"><span>결제</span><strong>{pay}<small style={{ display: "block", fontWeight: 600, color: unpaid > 0 ? "#d76964" : "#8d9bab" }}>입금 {won(paid)} · 미수금 {won(unpaid)}{o._computed?.creditUsed ? ` · 적립금 ${won(o._computed.creditUsed)}` : ""}</small></strong></div>
              {(shipped || o.trackingNo) && <div className="invrow"><span>송장번호</span><strong style={{ fontWeight: 600 }}><TrackingCell o={o} info={info} run={run} setOrders={setOrders} busy={busy} /></strong></div>}
              {group.length > 0 && <div className="invrow"><span>합배송</span><strong style={{ fontWeight: 600 }}>{group.map(g => g.customer).join(", ")} 외 함께 {group.length}건</strong></div>}
              {parked && <div className="invrow"><span>보류 사유</span><strong style={{ fontWeight: 600 }}>{o.parkReason || "사유 없음"}</strong></div>}
            </div>
            <div className="section-label">품목</div>
            <div className="items-list">
              {(o.items || []).map((it, i) => (
                <div key={it.itemId || i} className="item-line">
                  <div style={{ minWidth: 0 }}><strong>{it.fabric}{it.color ? ` ${it.color}` : ""}</strong><small>{it.itemNo ? <span className="mono">{it.itemNo} · </span> : null}{it.qty}{it.unit || "마"}{it.unitPrice ? ` × ${won(it.unitPrice)}` : ""}</small></div>
                  <span className="amt">{won(it.amount)}</span>
                </div>
              ))}
            </div>
            {o.note && <><div className="section-label">원문 메모</div><div className="notice-box" style={{ whiteSpace: "pre-wrap" }}>{o.note}</div></>}
            {o.memo && <><div className="section-label">담당자 메모</div><div className="notice-box">{o.memo}</div></>}

            <PhotoSection o={o} ctx={ctx} busy={busy} run={run} setOrders={setOrders} confirm={confirm} />

            {!shipped && (
              <>
                <div className="section-label">상태</div>
                <div className="chiprow">
                  <Chip on={o.status !== "포장완료"} disabled={!!busy || held && !!o.heldAt} onClick={() => o.status !== "접수" && run("st", () => act.setStatus(o, "접수", ctx))}>접수</Chip>
                  <Chip on={o.status === "포장완료"} disabled={!!busy || held && !!o.heldAt} onClick={() => o.status !== "포장완료" && run("st", () => act.setStatus(o, "포장완료", ctx))}>포장완료</Chip>
                  {!isPacker && <Chip on={held} disabled={!!busy} onClick={() => run("hold", () => act.toggleHold(o, ctx))}>📦 {held ? (o.heldAt ? "보관중" : "보관 요청") : "보관"}</Chip>}
                  {held && !o.heldAt && <Chip disabled={!!busy} title="원단을 실제로 창고 선반에 올렸을 때 누릅니다" onClick={() => run("held", () => act.confirmHold(o, ctx))}>🏬 창고에 넣음</Chip>}
                  {held && !o.shipRequestedAt && !isPacker && <Chip disabled={!!busy} onClick={() => run("req", () => act.requestShipOut(o, ctx))}>🚚 출고요청</Chip>}
                  {!parked ? <Chip disabled={!!busy} onClick={() => setMode("park")}>⏸ 보류</Chip> : <Chip on danger disabled={!!busy} onClick={() => run("unpark", () => act.unpark(o, ctx))}>보류 해제</Chip>}
                </div>
                {held && !o.heldAt && <p className="helptext" style={{ margin: "8px 0 0" }}>보관 요청 상태입니다 — 창고에 넣으면 '보관중'이 되고, 그 뒤엔 보관을 풀어야 접수·포장완료를 바꿀 수 있습니다.</p>}
                {mode === "park" && (
                  <div className="notice-box" style={{ marginTop: 10 }}>
                    <Field label="보류 사유 (필수)"><input className="forminput" value={parkReason} onChange={e => setParkReason(e.target.value)} placeholder="몇 달 뒤 꺼낼 때 이 한 줄이 유일한 단서입니다" /></Field>
                    <div className="btnrow" style={{ marginTop: 10 }}><Button kind="white" onClick={() => setMode(null)}>취소</Button><Button onClick={() => run("park", () => act.park(o, parkReason, ctx)).then(r => r && setMode(null))} loading={busy === "park"}>보류함에 넣기{group.length ? ` (묶음 ${group.length + 1}건)` : ""}</Button></div>
                  </div>
                )}
              </>
            )}

            {/* 결제(입금·적립금·환불)는 출고 뒤에도 — 외상 거래처의 입금 확인, 출고된 주문의 환불 신청(2026-10-23 점검) */}
            <>
                <div className="section-label">결제</div>
                {pay === "환불신청" ? (
                  <div className="chiprow">
                    <StatusBadge tone="late">환불 신청 중{o.refundRequest ? ` · ${o.refundRequest.kind === "full" ? "전액" : "부분"} ${o.refundRequest.method === "credit" ? "적립금" : "현금"} ${won(o.refundRequest.amount)}` : ""}</StatusBadge>
                    {!isPacker && <Chip danger disabled={!!busy} onClick={() => run("rc", () => act.cancelRefundRequest(o, ctx))}>신청 취소</Chip>}
                    {isAdmin && <Chip onClick={() => go("/app/settlement")}>정산에서 처리</Chip>}
                  </div>
                ) : (
                  <div className="chiprow">
                    {unpaid > 0 && !isPacker && <Chip on={mode === "deposit"} onClick={() => { setMode(mode === "deposit" ? null : "deposit"); setAmount(String(unpaid)); }}>💰 입금 확인</Chip>}
                    {unpaid > 0 && creditBal > 0 && !isPacker && <Chip on={mode === "credit"} onClick={() => { setMode(mode === "credit" ? null : "credit"); setAmount(String(Math.min(creditBal, unpaid))); }}>🪙 적립금 사용 (잔액 {won(creditBal)})</Chip>}
                    {paid > 0 && !isPacker && (pay === "입금완료" || pay === "부분입금") && <Chip danger onClick={() => setMode("refund")}>환불 신청{shipped ? " (반품·차액)" : ""}</Chip>}
                    {isAdmin && !shipped && !canCancelDeposit(o, pay, ctx) && <Chip danger disabled={!!busy} title="입금 기록을 지우고 미입금으로" onClick={doCancelDeposit}>입금 취소</Chip>}
                    {shipped && unpaid > 0 && <StatusBadge tone="wait">외상 미수금 {won(unpaid)}</StatusBadge>}
                    {unpaid === 0 && pay !== "환불신청" && <StatusBadge tone="done">완납</StatusBadge>}
                  </div>
                )}
                {(mode === "deposit" || mode === "credit") && (
                  <div className="notice-box" style={{ marginTop: 10 }}>
                    <Field label={mode === "deposit" ? `입금 금액 (미수금 ${won(unpaid)})` : `적립금 차감 금액 (잔액 ${won(creditBal)} · 미수금 ${won(unpaid)})`}><input className="forminput" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} /></Field>
                    <p className="helptext" style={{ margin: "8px 0 0" }}>실제 입금 기록(payment_logs)에 남습니다. 완납이 되면 주문이 입금완료로 바뀝니다.</p>
                    <div className="btnrow" style={{ marginTop: 10 }}>
                      <Button kind="white" onClick={() => setMode(null)}>취소</Button>
                      <Button kind="green" icon="check" loading={busy === "pay"} onClick={() => run("pay", () => mode === "deposit" ? act.addDeposit(o, amount, ctx) : act.useCredit(o, amount, ctx)).then(async r => { if (r) { setMode(null); if (mode === "credit") saas.reloadCredits(); } })}>{mode === "deposit" ? "입금 처리" : "적립금 차감"}</Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 포장 담당자는 같은 고객 묶기만(접수 상태) — 해제·분리·운임비는 섹션 안에서 숨긴다 */}
            {(!isPacker || o.status === "접수") && <MergeSection o={o} ctx={ctx} lock={isPacker ? null : lock} busy={busy} run={run} onPatched={onPatched} toast={toast} setOrders={setOrders} customers={customers} />}

            {!shipped && !isPacker && <CourierChips o={o} ctx={ctx} info={info} lock={lock} busy={busy} run={run} setOrders={setOrders} />}

            <div className="section-label">출고</div>
            {!shipped ? (
              <>
                <div className="chiprow">
                  {isAdmin
                    ? <Chip disabled={!!busy || !canShipByPayment(o)} title={!canShipByPayment(o) ? "입금확인 후 출고 가능" : undefined} onClick={doShip}>🚚 출고완료{group.length && !o.splitShipping ? ` (묶음 ${group.filter(g => !g.splitShipping).length + 1}건)` : ""}</Chip>
                    : <StatusBadge tone="gray">출고완료는 관리자만</StatusBadge>}
                  <Chip onClick={() => go("/app/orders/ship")}>출고 처리 화면</Chip>
                </div>
                {!canShipByPayment(o) && <p className="helptext" style={{ margin: "8px 0 0" }}>입금 확인 전에는 출고완료가 되지 않습니다(업무 규칙).</p>}
              </>
            ) : (
              <>
                <div className="notice-box">출고완료 {o.shippedAt ? new Date(o.shippedAt).toLocaleString("ko-KR") : ""}{o.shippedVia ? ` · ${o.shippedVia}` : ""}. 반품은 주문 관리의 반품·교환 탭에서 처리합니다.</div>
                {isAdmin && (
                  <div className="chiprow" style={{ marginTop: 10 }}>
                    <Chip danger disabled={!!busy} title="포장완료로 되돌리고 출고 이력을 지웁니다" onClick={doUndoShip}>↩ 출고 취소</Chip>
                  </div>
                )}
              </>
            )}

            <div className="inline-actions">
              {!isPacker && !shipped && <Button kind="white" icon="edit" onClick={() => setMode("edit")} disabled={!!lock}>수정</Button>}
              {isAdmin && !shipped && <Button kind="danger" icon="trash" onClick={doDelete} loading={busy === "del"}>삭제</Button>}
              <Button kind="white" icon="users" onClick={() => go(`/app/customers?q=${encodeURIComponent(o.customer)}`)}>거래처 보기</Button>
              <Button kind="white" icon="clock" onClick={() => go(`/app/history/${o.id}`)}>이 주문의 변경 기록</Button>
            </div>
          </>
        )}
    </Modal>
  );
}

export { COURIERS };
