// 주문 상세 모달 — 품목·금액·결제 상태(getPayStatus)·배송지·담당자, 상태 변경(접수/포장완료)·보관·보류·출고요청·출고완료·입금 확인·환불 신청·수정·삭제.
import { useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { Button, StatusBadge, Chip, won, shortId } from "../components/ui.jsx";
import { isHold, isParked, getPayStatus, maskPhone } from "../../constants.js";
import { orderTotal, orderUnpaid, orderPaid, relativeWhen } from "../lib/metrics.js";
import { shipBucket, BUCKETS } from "../../lib/shipDate.js";
import { COURIER_SHORT, COURIERS } from "../../lib/courier.js";
import { patchOrdersWithGroupResult } from "../../lib/freight.js";
import { orderBadges } from "./HomePage.jsx";
import * as act from "../actions/orders.js";
import { shipOut, canShipByPayment } from "../actions/ship.js";
import { OLD_ERP_PATH } from "../config.js";

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

export default function OrderDetail({ order, onClose, go }) {
  const saas = useSaas();
  const { orders, managers, activeManager, isAdmin, isPacker, setOrders, reloadOrders, courierById, credits } = saas;
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [mode, setMode] = useState(null);   // edit | refund | park | deposit | credit
  const [parkReason, setParkReason] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const ctx = { orders, managers, activeManager, isAdmin, isPacker };
  const o = order;
  const pay = getPayStatus(o);
  const held = isHold(o), parked = isParked(o);
  const total = orderTotal(o), unpaid = orderUnpaid(o), paid = orderPaid(o);
  const lock = act.lockOf(o, ctx);
  const info = courierById.get(o.id);
  const group = useMemo(() => act.groupOf(o, orders).filter(x => x.id !== o.id), [o, orders]);
  const creditBal = useMemo(() => (credits || []).filter(c => c.customer === o.customer).reduce((s, c) => s + (c.type === "적립" ? c.amount : -c.amount), 0), [credits, o.customer]);
  const bucket = BUCKETS[shipBucket(o)];

  const run = async (key, fn, { reload = true } = {}) => {
    setBusy(key);
    try { const r = await fn(); if (reload) await reloadOrders(); if (r?.msg) toast(r.msg); return r; }
    catch (e) { toast(e.message || String(e), "error"); return null; }
    finally { setBusy(""); }
  };
  const onShipped = (ord, patch) => setOrders(p => p.map(x => x.id === ord.id ? { ...x, ...patch } : x));
  const doShip = () => run("ship", async () => {
    const r = await shipOut(o, { orders, isAdmin, confirm, onShipped, onPatched: (res) => setOrders(p => patchOrdersWithGroupResult(p, res)), toast });
    if (!r.ok) throw new Error(r.reason);
    return { msg: r.shipped.length > 1 ? `합배송 ${r.shipped.length}건 출고 완료` : "출고 처리 완료" };
  });

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
              {info ? <StatusBadge tone="gray">{info.pickup ? "방문·픽업" : COURIER_SHORT[info.courier]}{info.why === "manual" ? " (직접 지정)" : ""}</StatusBadge> : null}
              {o.invoicePrintedAt ? <StatusBadge tone="done">송장 출력됨</StatusBadge> : null}
              {o.shipRequestedAt ? <StatusBadge tone="purple">출고요청</StatusBadge> : null}
            </div>
            {lock && <p className="helptext warn" style={{ margin: "10px 0" }}>🔒 {lock}</p>}
            <div className="kv">
              <div className="invrow"><span>거래처</span><strong>{o.customer}{o.phone ? <small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>{isAdmin ? o.phone : maskPhone(o.phone)}</small> : null}</strong></div>
              <div className="invrow"><span>배송지</span><strong style={{ fontWeight: 600 }}>{o.address ? `${o.address}${o.addressDetail ? ` ${o.addressDetail}` : ""}` : "—"}{o.deliveryMessage ? <small style={{ display: "block", color: "#8d9bab" }}>📝 {o.deliveryMessage}</small> : null}</strong></div>
              <div className="invrow"><span>주문 금액</span><strong>{won(total)}<small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>배송비 {won(o.shippingFee)}{o.otherCost ? ` · 기타 ${won(o.otherCost)}` : ""}</small></strong></div>
              <div className="invrow"><span>결제</span><strong>{pay}<small style={{ display: "block", fontWeight: 600, color: unpaid > 0 ? "#d76964" : "#8d9bab" }}>입금 {won(paid)} · 미수금 {won(unpaid)}{o._computed?.creditUsed ? ` · 적립금 ${won(o._computed.creditUsed)}` : ""}</small></strong></div>
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

            {o.status !== "출고완료" && (
              <>
                <div className="section-label">상태</div>
                <div className="chiprow">
                  <Chip on={o.status !== "포장완료"} disabled={!!busy || held && !!o.heldAt} onClick={() => o.status !== "접수" && run("st", () => act.setStatus(o, "접수", ctx))}>접수</Chip>
                  <Chip on={o.status === "포장완료"} disabled={!!busy || held && !!o.heldAt} onClick={() => o.status !== "포장완료" && run("st", () => act.setStatus(o, "포장완료", ctx))}>포장완료</Chip>
                  {!isPacker && <Chip on={held} disabled={!!busy} onClick={() => run("hold", () => act.toggleHold(o, ctx))}>📦 {held ? (o.heldAt ? "보관중" : "보관 요청") : "보관"}</Chip>}
                  {held && !o.shipRequestedAt && !isPacker && <Chip disabled={!!busy} onClick={() => run("req", () => act.requestShipOut(o, ctx))}>🚚 출고요청</Chip>}
                  {!parked ? <Chip disabled={!!busy} onClick={() => setMode("park")}>⏸ 보류</Chip> : <Chip on danger disabled={!!busy} onClick={() => run("unpark", () => act.unpark(o, ctx))}>보류 해제</Chip>}
                </div>
                {mode === "park" && (
                  <div className="notice-box" style={{ marginTop: 10 }}>
                    <Field label="보류 사유 (필수)"><input className="forminput" value={parkReason} onChange={e => setParkReason(e.target.value)} placeholder="몇 달 뒤 꺼낼 때 이 한 줄이 유일한 단서입니다" /></Field>
                    <div className="btnrow" style={{ marginTop: 10 }}><Button kind="white" onClick={() => setMode(null)}>취소</Button><Button onClick={() => run("park", () => act.park(o, parkReason, ctx)).then(r => r && setMode(null))} loading={busy === "park"}>보류함에 넣기{group.length ? ` (묶음 ${group.length + 1}건)` : ""}</Button></div>
                  </div>
                )}
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
                    {paid > 0 && !isPacker && (pay === "입금완료" || pay === "부분입금") && <Chip danger onClick={() => setMode("refund")}>환불 신청</Chip>}
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
                <div className="section-label">출고</div>
                <div className="chiprow">
                  {isAdmin
                    ? <Chip disabled={!!busy || !canShipByPayment(o)} title={!canShipByPayment(o) ? "입금확인 후 출고 가능" : undefined} onClick={doShip}>🚚 출고완료{group.length ? ` (묶음 ${group.length + 1}건)` : ""}</Chip>
                    : <StatusBadge tone="gray">출고완료는 관리자만</StatusBadge>}
                  <Chip onClick={() => go("/app/orders/ship")}>출고 처리 화면</Chip>
                </div>
                {!canShipByPayment(o) && <p className="helptext" style={{ margin: "8px 0 0" }}>입금 확인 전에는 출고완료가 되지 않습니다(업무 규칙).</p>}
              </>
            )}
            {o.status === "출고완료" && <div className="notice-box" style={{ marginTop: 14 }}>출고완료 {o.shippedAt ? new Date(o.shippedAt).toLocaleString("ko-KR") : ""}{o.shippedVia ? ` · ${o.shippedVia}` : ""}. 출고 취소·반품은 옛 화면 또는 반품 탭에서 처리합니다.</div>}

            <div className="inline-actions">
              {!isPacker && o.status !== "출고완료" && <Button kind="white" icon="edit" onClick={() => setMode("edit")} disabled={!!lock}>수정</Button>}
              {isAdmin && o.status !== "출고완료" && <Button kind="danger" icon="trash" onClick={async () => {
                const ok = await confirm(`주문 #${shortId(o.id)} (${o.customer})을 삭제합니다. 되돌릴 수 없습니다.`, { danger: true, confirmLabel: "삭제" });
                if (!ok) return;
                const r = await run("del", () => act.deleteOrder(o, ctx), { reload: false });
                if (r) { setOrders(p => p.filter(x => x.id !== o.id)); onClose(); }
              }}>삭제</Button>}
              <Button kind="white" icon="users" onClick={() => go(`/app/customers?q=${encodeURIComponent(o.customer)}`)}>거래처 보기</Button>
            </div>
            <div className="link-old">합배송 묶기·분리, 운임비 조정, 택배사 변경, 원단 호출, 라벨·메모 채팅은 <a href={OLD_ERP_PATH}>옛 화면(주문현황)</a>에서 처리합니다.</div>
          </>
        )}
    </Modal>
  );
}

export { COURIERS };
