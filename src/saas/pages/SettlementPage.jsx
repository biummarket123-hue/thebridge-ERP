// 정산 — 미입금 목록·입금 처리·적립금 등록/사용·환불 신청 처리·거래명세서 출력·월별 매출(지시서 4절 정산).
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { PageHead, StatCard, Button, Panel, SearchInput, Segment, BarChart, TaskRow, StatusBadge, Empty, Chip, won, manwon, shortId } from "../components/ui.jsx";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { checkOrderLock } from "../../lib/managerLock.js";
import { settlePackingBefore, settleMessage } from "../../lib/packingGuard.js";
import { orderStats, depositSum, monthRange, monthlyDeposits, orderTotal, orderUnpaid, orderPaid, itemsSummary, relativeWhen, isActiveOrder } from "../lib/metrics.js";
import * as act from "../actions/orders.js";
import { salesByChannel, printMonthlyReport } from "../lib/monthlyReport.js";
import "../saas-data.css";

const H = { isHold, isParked, getPayStatus };
function Field({ label, children, opt, htmlFor }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{opt ? <span className="opt">선택</span> : null}</label>{children}</div>;
}

/** 환불 승인 — 옛 DepositTab.handleRefund 를 그대로(현금환불/적립금전환, 전액이면 종결·적립금 복원·배송권 복원·묶음 해제). */
async function approveRefund(order, mode, amt, ctx) {
  const { activeManager, confirm } = ctx;
  const label = mode === "cash" ? "현금환불" : "적립금전환";
  const total = orderTotal(order);
  const logs = await db.fetchOrderLogs(order.id);
  const willBeFull = db.calcOrderMoney([...logs, { type: label, amount: amt }], total, order.payment).paymentStatus === "환불완료";
  let packMsg = "";
  if (willBeFull) {
    const settled = await settlePackingBefore(order.id, { what: "환불 처리", by: activeManager, confirm });
    if (!settled) return { cancelled: true };
    packMsg = settleMessage(settled);
  }
  let creditUsed = 0;
  for (const l of logs) { if (l.type === "적립금차감") creditUsed += (l.amount || 0); if (l.type === "적립금복원") creditUsed -= (l.amount || 0); }
  await db.addPaymentLog(order.id, label, amt, `${label} ${amt.toLocaleString()}원`, order.customer);
  if (mode === "credit") await db.insertCredit({ customer: order.customer, amount: amt, type: "적립", reason: "환불→적립금 전환", manager: activeManager, orderId: order.id });
  const updatedLogs = await db.fetchOrderLogs(order.id);
  const computed = db.calcOrderMoney(updatedLogs, total, order.payment);
  if (creditUsed > 0 && computed.paymentStatus === "환불완료") {
    await db.addPaymentLog(order.id, "적립금복원", creditUsed, "환불로 적립금 복원", order.customer);
    await db.insertCredit({ customer: order.customer, amount: creditUsed, type: "적립", reason: "환불로 복원", manager: activeManager, orderId: order.id });
  }
  const baseUpdate = order.mergeGroupId ? { merge_group_id: null } : {};
  const archived = db.archiveRefundRequest(order, "승인", { resolvedMethod: label, resolvedAmount: amt });
  if (computed.paymentStatus === "환불완료") await db.updateOrder(order.id, { payment: "환불", refund_note: label, refund_request: null, ...archived, ...baseUpdate }, { route: "환불 승인 · 새 UI" });
  else {
    const partial = { refund_note: label, refund_request: null, ...archived, ...baseUpdate };
    if (order.payment === "환불신청") { partial.payment = "입금완료"; partial.payment_status = "paid"; }
    await db.updateOrder(order.id, partial, { route: "부분 환불 · 새 UI" });
  }
  let fsMsg = "";
  if (order.freeShippingUsed && computed.paymentStatus === "환불완료") {
    try { const nc = await db.restoreFreeShippingForRefund(order.customer, order.id); if (nc !== null) fsMsg = " · 무료배송권 1장 복원"; } catch (e) { console.warn("무료배송권 복원 실패:", e); }
  }
  return { msg: `${amt.toLocaleString()}원 ${label} 처리${fsMsg}${packMsg}` };
}

function OrderMoneyModal({ order: o, onClose, go }) {
  const { orders, managers, activeManager, isAdmin, isPacker, reloadOrders, reloadCredits, reloadFreeShipping, credits } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [tab, setTab] = useState("pay");
  const [amount, setAmount] = useState("");
  const [reject, setReject] = useState("");
  const [hist, setHist] = useState(null);
  const [busy, setBusy] = useState(false);
  const ctx = { orders, managers, activeManager, isAdmin, isPacker, confirm };
  const pay = getPayStatus(o);
  const unpaid = orderUnpaid(o), paid = orderPaid(o), total = orderTotal(o);
  const bal = useMemo(() => (credits || []).filter(c => c.customer === o.customer).reduce((s, c) => s + (c.type === "적립" ? c.amount : -c.amount), 0), [credits, o.customer]);
  const lock = checkOrderLock(o, activeManager, managers, orders);
  useEffect(() => { db.fetchOrderLogs(o.id).then(setHist).catch(() => setHist([])); }, [o.id, o._computed]);
  const rr = o.refundRequest;
  const run = async (fn, after) => {
    setBusy(true);
    try { const r = await fn(); if (r?.cancelled) return; await reloadOrders(); reloadCredits(); reloadFreeShipping(); if (r?.msg) toast(r.msg); after?.(); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="입금 · 환불 처리" onClose={onClose} width="wide">
      {host}
      <p className="helptext"><b>{o.customer}</b> · <span className="mono">{shortId(o.id)}</span> · {o.date}{o.manager ? ` · 담당 ${o.manager}` : ""} · {itemsSummary(o, 2)}</p>
      <div className="kv" style={{ margin: "6px 0 16px" }}>
        <div className="invrow"><span>주문 금액</span><strong>{won(total)}</strong></div>
        <div className="invrow"><span>받은 돈</span><strong>{won(paid)}{o._computed?.creditUsed ? <small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>적립금 {won(o._computed.creditUsed)} 포함</small> : null}</strong></div>
        <div className="invrow"><span>미수금</span><strong style={{ color: unpaid > 0 ? "#d76964" : "#23986f" }}>{won(unpaid)}</strong></div>
        <div className="invrow"><span>상태</span><StatusBadge tone={pay === "입금완료" ? "done" : pay === "환불신청" ? "late" : "wait"}>{pay}</StatusBadge></div>
      </div>
      {lock && <p className="helptext warn">🔒 {lock}</p>}
      {pay === "환불신청" && rr ? (
        <>
          <div className="notice-box">환불 신청: {rr.kind === "full" ? "전액" : "부분"} · {rr.method === "credit" ? "적립금" : "현금"} · <b>{won(rr.amount)}</b>{rr.reason ? ` · ${rr.reason}` : ""}<br />{rr.method === "cash" ? `${rr.bank || ""} ${rr.accountNumber || ""} ${rr.accountHolder || ""}` : ""}{rr.requestedBy ? ` · 신청 ${rr.requestedBy}` : ""}</div>
          {isAdmin ? (
            <>
              <div className="inline-actions">
                <Button kind="green" icon="check" loading={busy} onClick={() => run(() => approveRefund(o, rr.method === "credit" ? "credit" : "cash", Math.min(parseInt(rr.amount) || 0, paid), ctx), onClose)}>승인 — {rr.method === "credit" ? "적립금 전환" : "현금 환불"} {won(Math.min(parseInt(rr.amount) || 0, paid))}</Button>
              </div>
              <Field label="반려 사유" opt><input className="forminput" value={reject} onChange={e => setReject(e.target.value)} /></Field>
              <div className="inline-actions">
                <Button kind="danger" loading={busy} onClick={() => run(async () => { await db.updateOrder(o.id, { payment: "입금완료", payment_status: "paid", refund_request: null, ...db.archiveRefundRequest(o, "반려", { rejectReason: reject.trim() }), ...(reject.trim() ? { memo: `${o.memo ? o.memo + "\n" : ""}[환불 반려] ${reject.trim()}` } : {}) }, { route: "환불 반려 · 새 UI" }); return { msg: "환불 신청 반려 — 입금완료로 복원" }; }, onClose)}>반려</Button>
              </div>
            </>
          ) : <p className="helptext">승인·반려는 관리자가 합니다.</p>}
        </>
      ) : (
        <>
          <Segment options={[["pay", "입금"], ["credit", `적립금 (잔액 ${won(bal)})`], ["refund", "환불"]]} value={tab} onChange={(t) => { setTab(t); setAmount(t === "pay" ? String(unpaid) : t === "credit" ? String(Math.min(bal, unpaid)) : String(paid)); }} />
          {tab === "pay" && (unpaid > 0 ? (
            <>
              <Field label={`입금 금액 (미수금 ${won(unpaid)})`}><input className="forminput" inputMode="numeric" value={amount || unpaid} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} /></Field>
              <div className="inline-actions"><Button kind="green" icon="check" loading={busy} disabled={isPacker} onClick={() => run(() => act.addDeposit(o, amount || unpaid, ctx))}>입금 처리</Button><Button kind="white" onClick={() => setAmount(String(unpaid))}>전액</Button></div>
            </>
          ) : <div className="notice-box">완납된 주문입니다.</div>)}
          {tab === "credit" && (unpaid > 0 && bal > 0 ? (
            <>
              <Field label={`차감 금액 (잔액 ${won(bal)} · 미수금 ${won(unpaid)})`}><input className="forminput" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} /></Field>
              <div className="inline-actions"><Button icon="check" loading={busy} disabled={!!lock || isPacker} onClick={() => run(() => act.useCredit(o, amount, ctx))}>적립금 차감</Button></div>
            </>
          ) : <div className="notice-box">{bal <= 0 ? "이 고객의 적립금이 없습니다." : "미수금이 없습니다."}</div>)}
          {tab === "refund" && (paid > 0 ? (
            <>
              <p className="helptext warn">관리자가 바로 환불을 확정합니다(신청 없이). 전액이면 주문이 종결되고 적립금·배송권이 복원됩니다.</p>
              <Field label={`환불 금액 (받은 돈 ${won(paid)})`}><input className="forminput" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} /></Field>
              <div className="inline-actions">
                <Button kind="danger" loading={busy} disabled={!isAdmin || !!lock} onClick={async () => { const a = parseInt(amount) || 0; if (a <= 0 || a > paid) { toast("금액을 확인해 주세요", "error"); return; } if (!await confirm(`${won(a)} 현금환불 하시겠습니까?`)) return; run(() => approveRefund(o, "cash", a, ctx), onClose); }}>💵 현금환불</Button>
                <Button kind="danger" loading={busy} disabled={!isAdmin || !!lock} onClick={async () => { const a = parseInt(amount) || 0; if (a <= 0 || a > paid) { toast("금액을 확인해 주세요", "error"); return; } if (!await confirm(`${won(a)} 적립금으로 전환하시겠습니까?`)) return; run(() => approveRefund(o, "credit", a, ctx), onClose); }}>🪙 적립금 전환</Button>
              </div>
              {!isAdmin && <p className="helptext">직원은 주문 상세에서 환불 신청을 올립니다.</p>}
            </>
          ) : <div className="notice-box">받은 돈이 없어 환불할 금액이 없습니다.</div>)}
        </>
      )}
      <div className="section-label">처리 내역</div>
      <div className="items-list">
        {hist === null ? <div className="loading-line">불러오는 중…</div> : hist.length === 0 ? <Empty small>기록이 없습니다.</Empty> : [...hist].reverse().map(l => (
          <div key={l.id} className="item-line"><div><strong>{l.type}</strong><small>{relativeWhen(l.created_at)}{l.note ? ` · ${l.note}` : ""}</small></div><span className="amt" style={{ color: /환불|복원|전환/.test(l.type) ? "#d76964" : "#23986f" }}>{won(l.amount)}</span></div>
        ))}
      </div>
      <div className="inline-actions"><Button kind="white" onClick={() => go(`/app/orders/${o.id}`)}>주문 상세</Button></div>
    </Modal>
  );
}

function CreditModal({ onClose }) {
  const { customers, activeManager, reloadCredits } = useSaas();
  const toast = useToast();
  const [f, setF] = useState({ customer: "", amount: "", reason: "", memo: "" });
  const [busy, setBusy] = useState(false);
  const sug = f.customer.trim().length >= 1 ? customers.filter(c => c.name.includes(f.customer.trim()) || (c.nickname || "").includes(f.customer.trim())).slice(0, 6) : [];
  const [picked, setPicked] = useState(null);
  const save = async () => {
    const amt = parseInt(String(f.amount).replace(/\D/g, "")) || 0;
    const name = (picked?.name || f.customer).trim();
    if (!name || amt <= 0) { toast("고객과 금액을 적어 주세요", "error"); return; }
    setBusy(true);
    try { await db.insertCredit({ customer: name, amount: amt, type: "적립", reason: f.reason.trim() || "적립", manager: activeManager, memo: f.memo.trim() }); await reloadCredits(); toast(`${name} 적립금 ${won(amt)} 등록`); onClose(); }
    catch (e) { toast("등록 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="적립금 등록" onClose={onClose}>
      <p className="helptext warn">실제 적립금 원장(credits)에 "적립" 한 줄이 들어갑니다.</p>
      <Field label="고객" htmlFor="cr-cust"><div style={{ position: "relative" }}>
        <input id="cr-cust" className="forminput" value={picked ? picked.name : f.customer} onChange={e => { setPicked(null); setF({ ...f, customer: e.target.value }); }} autoComplete="off" />
        {!picked && sug.length > 0 && <div style={{ position: "absolute", left: 0, right: 0, top: "100%", zIndex: 6, background: "#fff", border: "1px solid #dfe6ef", borderRadius: 12, boxShadow: "0 12px 30px #1b31552a", overflow: "hidden" }}>
          {sug.map(c => <button key={c.id} type="button" onClick={() => setPicked(c)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: 0, background: "#fff", borderBottom: "1px solid #f0f3f7", fontSize: 14 }}>{c.name}{c.nickname ? ` (${c.nickname})` : ""} <span style={{ color: "#8d9bab" }}>{c.phone || ""}</span></button>)}
        </div>}
      </div></Field>
      <Field label="금액"><input className="forminput" inputMode="numeric" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value.replace(/\D/g, "") })} /></Field>
      <Field label="사유"><input className="forminput" value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="예: 이벤트 적립, 불량 보상" /></Field>
      <Field label="메모" opt><input className="forminput" value={f.memo} onChange={e => setF({ ...f, memo: e.target.value })} /></Field>
      <div className="btnrow" style={{ marginTop: 18 }}><Button kind="white" onClick={onClose}>취소</Button><Button icon="check" onClick={save} loading={busy}>등록</Button></div>
    </Modal>
  );
}

export default function SettlementPage({ route }) {
  const { orders, paymentLogs, customers, loaded, shipped, config, managers, activeManager, isAdmin, isPacker, reloadOrders } = useSaas();
  const toast = useToast();
  const { confirm, host: askHost } = useAsk();
  const [tab, setTab] = useState("unpaid");
  const [reportMonth, setReportMonth] = useState("this");   // this | last
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [creditOpen, setCreditOpen] = useState(false);
  const [stmtSel, setStmtSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const go = route.go;
  const now = new Date();
  const st = useMemo(() => orderStats(orders, H), [orders]);
  const month = useMemo(() => { const r = monthRange(now); return depositSum(paymentLogs, r.start, r.end); }, [paymentLogs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const lastMonth = useMemo(() => { const r = monthRange(now, -1); return depositSum(paymentLogs, r.start, r.end).sum; }, [paymentLogs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const months = useMemo(() => monthlyDeposits(paymentLogs, now, 6), [paymentLogs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const monthDelta = lastMonth > 0 ? Math.round((month.sum - lastMonth) / lastMonth * 1000) / 10 : null;
  // 미입금·환불 목록의 모집단: 진행 중 주문 + 출고완료 뒤에도 돈이 남은 주문(외상 거래처) + 출고 뒤 환불 신청(2026-10-23)
  const base = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const o of [...orders, ...(shipped || [])]) {
      if (seen.has(o.id)) continue; seen.add(o.id);
      const p = getPayStatus(o);
      if (p === "환불신청" || isActiveOrder(o) || (o.status === "출고완료" && (p === "미입금" || p === "부분입금"))) out.push(o);
    }
    return out;
  }, [orders, shipped]);
  const [paySel, setPaySel] = useState(() => new Set());   // 미입금 탭에서 고른 주문 — 여러 건 한 번에 입금 확인
  const [groupByCustomer, setGroupByCustomer] = useState(false);
  const depositSelected = async () => {
    const targets = lists.unpaid.filter(o => paySel.has(o.id));
    if (!targets.length) return;
    const sum = targets.reduce((s, o) => s + orderUnpaid(o), 0);
    const names = [...new Set(targets.map(o => o.customer))];
    if (!await confirm(`${targets.length}건의 미수금 ${won(sum)}을 전액 입금 처리합니다.\n거래처: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` 외 ${names.length - 5}곳` : ""}\n\n실제 입금 기록(payment_logs)이 건마다 남습니다.`, { title: "여러 건 입금 확인", confirmLabel: "입금 처리" })) return;
    setBusy(true);
    let ok = 0; const fails = [];
    for (const o of targets) {
      try { await act.addDeposit(o, null, { orders, managers, activeManager, isAdmin, isPacker, confirm }); ok += 1; }
      catch (e) { fails.push(`${o.customer}(${e.message})`); }
    }
    await reloadOrders(); setPaySel(new Set()); setBusy(false);
    if (ok) toast(`${ok}건 입금 처리 — ${won(sum)}`);
    if (fails.length) toast(`${fails.length}건 실패: ${fails.slice(0, 3).join(", ")}`, "error");
  };
  const lists = useMemo(() => {
    const ql = q.trim().toLowerCase(); const digits = ql.replace(/\D/g, "");
    const hit = (o) => !ql || String(o.customer || "").toLowerCase().includes(ql) || (digits.length >= 3 && String(o.phone || "").replace(/\D/g, "").includes(digits)) || String(o.id).toLowerCase().startsWith(ql);
    const by = (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    return {
      unpaid: base.filter(o => { const p = getPayStatus(o); return (p === "미입금" || p === "부분입금") && hit(o); }).sort(by),
      refund: base.filter(o => getPayStatus(o) === "환불신청" && hit(o)).sort(by),
      paid: base.filter(o => getPayStatus(o) === "입금완료" && o.status !== "출고완료" && hit(o)).sort(by),
    };
  }, [base, q]);
  const recentDeposits = useMemo(() => paymentLogs.filter(l => l.type === "입금").slice(0, 6), [paymentLogs]);
  // 판매처별 매출·월 리포트의 모집단: 활성 주문 + 최근 60일 출고완료(이번 달 접수 뒤 이미 나간 건). id 로 한 번만.
  const allRecent = useMemo(() => { const seen = new Set(); const out = []; for (const o of [...orders, ...(shipped || [])]) { if (seen.has(o.id)) continue; seen.add(o.id); out.push(o); } return out; }, [orders, shipped]);
  const byChannel = useMemo(() => salesByChannel(allRecent, monthRange(now)), [allRecent]);   // eslint-disable-line react-hooks/exhaustive-deps
  const channelTotal = byChannel.reduce((s, c) => s + c.sum, 0);
  const printReport = () => {
    try { printMonthlyReport({ companyName: config.companyName, now, offset: reportMonth === "last" ? -1 : 0, orders: allRecent, paymentLogs }); }
    catch (e) { toast(e.message, "error"); }
  };
  const selected = sel ? orders.find(o => o.id === sel) : null;
  const downloadStatements = async (targets) => {
    if (!targets.length) { toast("출력할 주문이 없습니다", "error"); return; }
    setBusy(true);
    try {
      const { downloadStatementsHwpx } = await import("../../lib/statementHwpx.js");
      const r = await downloadStatementsHwpx(targets, customers);
      toast(r.pages < r.orders ? `주문 ${r.orders}건 → 명세서 ${r.pages}장 다운로드 (합배송 병합)` : `거래명세서 ${r.pages}건 다운로드 — 한글에서 열어 인쇄하세요`);
    } catch (e) { toast("명세서 생성 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };
  const downloadLedger = () => {
    const rows = [["일시", "종류", "고객", "금액", "메모", "주문"], ...paymentLogs.map(l => [new Date(l.created_at).toLocaleString("ko-KR"), l.type, l.customer || "", l.amount || 0, l.note || "", l.order_id ? shortId(l.order_id) : ""])];
    const csv = "﻿" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `정산내역_최근6개월_${now.toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("최근 6개월 입금·환불 내역을 내려받았습니다");
  };

  const Row = ({ o, right }) => (
    <TaskRow icon="finance" tone={getPayStatus(o) === "환불신청" ? "alert" : "mint"} title={`${o.customer} · ${shortId(o.id)}`} hint={`${relativeWhen(o.createdAt) || o.date} · ${itemsSummary(o, 2)}${o.manager ? ` · ${o.manager}` : ""}`} count={right} onClick={() => setSel(o.id)} />
  );
  // 미입금 줄 — 체크(여러 건 입금) + 누르면 처리 창. 출고완료 뒤 남은 돈(외상)은 배지로 표시.
  const UnpaidRow = ({ o }) => (
    <div className="unpaid-row">
      <input type="checkbox" checked={paySel.has(o.id)} onChange={() => setPaySel(p => { const n = new Set(p); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })} aria-label={`${o.customer} 선택`} />
      <div style={{ flex: 1, minWidth: 0 }}><Row o={o} right={`미수금 ${won(orderUnpaid(o))}${o.status === "출고완료" ? " · 출고됨(외상)" : ""}`} /></div>
    </div>
  );

  return (
    <>
      {askHost}
      <PageHead eyebrow="SETTLEMENT" title="정산" subtitle="매출과 입금 내역을 쉽게 확인하세요." right={<Button kind="white" icon="download" onClick={downloadLedger}>내역 내려받기</Button>} />
      <div className="stats">
        <StatCard title="이번 달 매출" value={manwon(month.sum)} unit="만원" icon="trend" note={monthDelta === null ? `입금 ${month.count}건 기준` : `지난달 대비 ${monthDelta >= 0 ? "+" : ""}${monthDelta}%`} noteTone={monthDelta === null || monthDelta < 0 ? "muted" : ""} />
        <StatCard title="입금 확인" value={month.count} unit="건" icon="check" tone="mint" note="이번 달 입금 처리 건수" noteTone="muted" />
        <StatCard title="미수금" value={manwon(st.unpaidSum)} unit="만원" icon="finance" tone="orange" note={`미입금·부분입금 ${st.unpaidCount}건`} noteTone="alert" onClick={() => setTab("unpaid")} />
        <StatCard title="환불 신청" value={st.refundRequested} unit="건" icon="clock" tone="purple" note="승인 대기" noteTone="muted" onClick={() => setTab("refund")} />
      </div>
      <div className="panels">
        <Panel title="월별 매출 현황" small="단위: 원 · 입금 기준">
          <div className="chartsum"><strong>{won(month.sum)}</strong>{monthDelta === null ? <small className="flat">지난달 {won(lastMonth)}</small> : <small className={monthDelta < 0 ? "down" : ""}>{monthDelta >= 0 ? "↗" : "↘"} {Math.abs(monthDelta)}%</small>}</div>
          <BarChart bars={months.map(m => ({ ...m, value: Math.round(m.value / 10000) }))} month />
          <div className="chartfoot" style={{ marginTop: 0 }}>막대 숫자는 만원. 최근 6개월 payment_logs 의 "입금" 합.</div>
        </Panel>
        <Panel title="최근 입금" right={<Button kind="white" size="sm" icon="plus" onClick={() => setCreditOpen(true)}>적립금 등록</Button>}>
          <div className="tasklist">
            {recentDeposits.length === 0 ? <Empty small>최근 입금 기록이 없어요.</Empty> : recentDeposits.map(l => (
              <TaskRow key={l.id} icon="finance" tone="mint" title={l.customer || "(고객 없음)"} hint={`${relativeWhen(l.created_at)}${l.note ? ` · ${l.note}` : ""}`} count={won(l.amount)} arrow={!!l.order_id} onClick={() => l.order_id && (orders.some(o => o.id === l.order_id) ? setSel(l.order_id) : go(`/app/orders/${l.order_id}`))} />
            ))}
          </div>
        </Panel>
      </div>
      <div className="panels">
        <Panel title="판매처별 매출" small={`${now.getMonth() + 1}월 접수 · 받은 돈 기준`} className="chan-list">
          {byChannel.length === 0 ? <Empty small>이번 달 결제된 주문이 아직 없어요.</Empty> : (
            <div className="kv">
              {byChannel.map(c => <div key={c.channel} className="invrow"><span>{c.channel}<small>{c.count}건</small></span><strong>{won(c.sum)}{channelTotal ? <small>{Math.round(c.sum / channelTotal * 100)}%</small> : null}</strong></div>)}
              <div className="invrow"><span>합계</span><strong>{won(channelTotal)}</strong></div>
            </div>
          )}
          <div className="chartfoot" style={{ marginTop: 8 }}>판매처가 빈 주문(밴드·전화·방문)은 "직접·밴드". 주문 등록 때 판매처를 적으면 여기 나뉩니다.</div>
        </Panel>
        <Panel title="월 리포트" small="회사명 · 기간 · 매출 · 미수금 · 판매처 · 상위 품목/고객 · 일별 입금">
          <p className="helptext" style={{ marginTop: 0 }}>인쇄용 화면이 새 창으로 열립니다. 브라우저 인쇄 창에서 PDF 로 저장할 수도 있어요.</p>
          <Segment options={[["this", `이번 달 (${now.getMonth() + 1}월)`], ["last", `지난달 (${monthRange(now, -1).start.getMonth() + 1}월)`]]} value={reportMonth} onChange={setReportMonth} />
          <div className="inline-actions"><Button icon="file" onClick={printReport}>월 리포트 인쇄</Button></div>
        </Panel>
      </div>
      <Panel full title="입금 · 환불 처리" right={<Segment options={[["unpaid", `미입금 ${lists.unpaid.length}`], ["refund", `환불 신청 ${lists.refund.length}`], ["paid", `명세서 ${lists.paid.length}`]]} value={tab} onChange={setTab} />}>
        <div style={{ marginBottom: 12 }}><SearchInput value={q} onChange={setQ} placeholder="고객명 · 연락처 · 주문번호" /></div>
        {!loaded ? <div className="loading-line">불러오는 중…</div> : tab === "unpaid" ? (
          <>
            {lists.unpaid.length > 0 && (
              <div className="inline-actions" style={{ marginTop: 0, marginBottom: 10 }}>
                <Button kind="white" size="sm" onClick={() => setPaySel(new Set(lists.unpaid.map(o => o.id)))}>전체 선택</Button>
                <Button kind="white" size="sm" onClick={() => setPaySel(new Set())} disabled={!paySel.size}>선택 해제</Button>
                <Chip on={groupByCustomer} onClick={() => setGroupByCustomer(v => !v)}>거래처별 모아 보기</Chip>
                <Button kind="green" size="sm" icon="check" loading={busy} disabled={isPacker || ![...paySel].some(id => lists.unpaid.some(o => o.id === id))} onClick={depositSelected}>선택 {[...paySel].filter(id => lists.unpaid.some(o => o.id === id)).length}건 전액 입금 확인</Button>
              </div>
            )}
            {lists.unpaid.length === 0 ? <Empty>미입금 주문이 없어요.</Empty> : (groupByCustomer
              ? Object.entries(lists.unpaid.reduce((m, o) => { (m[o.customer] ||= []).push(o); return m; }, {})).sort((a, b) => a[0].localeCompare(b[0], "ko-KR")).map(([name, os]) => (
                <div key={name} className="unpaid-group">
                  <div className="unpaid-group-head">
                    <label className="row-check" style={{ padding: 0, border: 0 }}><input type="checkbox" checked={os.every(o => paySel.has(o.id))} onChange={e => setPaySel(p => { const n = new Set(p); os.forEach(o => e.target.checked ? n.add(o.id) : n.delete(o.id)); return n; })} /><strong>{name}</strong></label>
                    <span>{os.length}건 · 미수금 <b>{won(os.reduce((s, o) => s + orderUnpaid(o), 0))}</b></span>
                  </div>
                  {os.map(o => <UnpaidRow key={o.id} o={o} />)}
                </div>
              ))
              : lists.unpaid.map(o => <UnpaidRow key={o.id} o={o} />))}
          </>
        ) : tab === "refund" ? (
          <div className="tasklist">{lists.refund.length === 0 ? <Empty>환불 신청이 없어요.</Empty> : lists.refund.map(o => <Row key={o.id} o={o} right={o.refundRequest ? `${o.refundRequest.method === "credit" ? "적립금" : "현금"} ${won(o.refundRequest.amount)}` : "환불 신청"} />)}</div>
        ) : (
          <>
            <p className="helptext" style={{ marginTop: 0 }}>입금완료(출고 전) 주문의 거래명세서를 한글(HWPX) 파일로 내려받습니다. 주문당 1장, 합배송은 병합.</p>
            <div className="inline-actions" style={{ marginTop: 0, marginBottom: 10 }}>
              <Button icon="file" loading={busy} onClick={() => downloadStatements(lists.paid)} disabled={!lists.paid.length}>전체 출력 ({lists.paid.length}건)</Button>
              <Button kind="white" icon="file" loading={busy} onClick={() => downloadStatements(lists.paid.filter(o => stmtSel.has(o.id)))} disabled={![...stmtSel].some(id => lists.paid.some(o => o.id === id))}>선택 출력 ({[...stmtSel].filter(id => lists.paid.some(o => o.id === id)).length}건)</Button>
            </div>
            {lists.paid.length === 0 ? <Empty>입금완료된 출고 전 주문이 없어요.</Empty> : lists.paid.map(o => (
              <label key={o.id} className="row-check">
                <input type="checkbox" checked={stmtSel.has(o.id)} onChange={() => setStmtSel(p => { const n = new Set(p); n.has(o.id) ? n.delete(o.id) : n.add(o.id); return n; })} />
                <span className="left"><strong>{o.customer}</strong><small>{o.date} · {itemsSummary(o, 2)} · {won(orderTotal(o))}</small></span>
                <Chip onClick={(e) => { e.preventDefault(); downloadStatements([o]); }}>🧾 이것만</Chip>
              </label>
            ))}
          </>
        )}
      </Panel>
      {selected && <OrderMoneyModal order={selected} onClose={() => setSel(null)} go={go} />}
      {creditOpen && <CreditModal onClose={() => setCreditOpen(false)} />}
    </>
  );
}
