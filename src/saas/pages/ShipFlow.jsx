// 출고 처리 — 포장완료 → 송장 → 출고완료 3단계를 한 화면에(업무 규칙 1: 버튼 하나로 출고완료를 찍지 않는다).
// 1단계 포장완료: 입금이 끝난 주문 중 아직 포장 전. 2단계 송장: 포장완료 + 송장 안 뽑힘 → 택배사별 엑셀(관리자). 3단계 출고완료: 송장 뽑힌 박스(관리자).
import { useMemo, useState } from "react";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { Button, Segment, StatusBadge, Empty, shortId, won } from "../components/ui.jsx";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { CJ, KD, COURIER_SHORT } from "../../lib/courier.js";
import { patchOrdersWithGroupResult } from "../../lib/freight.js";
import { itemsSummary, orderTotal, isActiveOrder } from "../lib/metrics.js";
import { shipOut, canShipByPayment, shipGroupOf } from "../actions/ship.js";
import { exportInvoices } from "../actions/invoice.js";
import * as act from "../actions/orders.js";
import { supabase } from "../../lib/supabase.js";

// 출고 안내 문자(/api/notify) — 서버가 Coolsms 키를 들고 있고, 유료 구독 회사만 통과시킨다(api/_ai_gate.js).
// 세션 토큰을 Bearer 로 보내는 방식은 src/constants.js 의 /api/analyze 호출과 같다.
async function sendShipNotice(orderIds) {
  const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  const res = await fetch("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify({ action: "ship", orderIds }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error?.message || `문자 서버 오류 (${res.status})`);
  return d;
}

export default function ShipFlow({ onClose, go }) {
  const { orders, customers, managers, activeManager, isAdmin, isPacker, setOrders, reloadOrders, courierById, config, aiAllowed } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [step, setStep] = useState("pack");
  const [courier, setCourier] = useState(CJ);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState("");
  const ctx = { orders, managers, activeManager, isAdmin, isPacker };

  const moving = useMemo(() => orders.filter(o => isActiveOrder(o) && !isHold(o) && !isParked(o)), [orders]);
  const toPack = useMemo(() => moving.filter(o => canShipByPayment(o) && o.status !== "포장완료"), [moving]);
  const toInvoice = useMemo(() => moving.filter(o => canShipByPayment(o) && o.status === "포장완료" && !o.invoicePrintedAt && !courierById.get(o.id)?.pickup), [moving, courierById]);
  const toShip = useMemo(() => moving.filter(o => canShipByPayment(o) && o.status === "포장완료" && (o.invoicePrintedAt || courierById.get(o.id)?.pickup)), [moving, courierById]);
  const unpaid = useMemo(() => moving.filter(o => !canShipByPayment(o)).length, [moving]);
  const invoiceList = toInvoice.filter(o => (courierById.get(o.id)?.courier || CJ) === courier);
  const boxes = (list) => {   // 묶음은 한 박스
    const seen = new Set(); const out = [];
    for (const o of list) { if (o.mergeGroupId && !o.splitShipping) { if (seen.has(o.mergeGroupId)) continue; seen.add(o.mergeGroupId); } out.push(o); }
    return out;
  };
  const toggle = (id) => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selIn = (list) => [...sel].filter(id => list.some(o => o.id === id));

  const packSelected = async () => {
    const ids = selIn(toPack); if (!ids.length) return;
    setBusy("pack");
    let ok = 0;
    for (const id of ids) {
      const o = orders.find(x => x.id === id);
      try { await act.setStatus(o, "포장완료", ctx); ok++; } catch (e) { toast(`${o.customer}: ${e.message}`, "error"); }
    }
    await reloadOrders(); setSel(new Set()); setBusy("");
    if (ok) toast(`${ok}건 포장완료`);
  };
  const exportSel = async () => {
    const ids = selIn(invoiceList); if (!ids.length) return;
    setBusy("inv");
    try {
      const r = await exportInvoices(ids, courier, { orders, customers, config });
      if (r.printedAt) setOrders(p => p.map(o => r.printedIds.includes(o.id) ? { ...o, invoicePrintedAt: r.printedAt } : o));
      toast(`${COURIER_SHORT[courier]} 송장 ${r.count}장 출력`); setSel(new Set());
    } catch (e) { toast(e.message, "error"); }
    finally { setBusy(""); }
  };
  const shipSelected = async () => {
    const ids = selIn(toShip); if (!ids.length) return;
    setBusy("ship");
    let n = 0;
    const done = new Set();
    for (const id of ids) {
      if (done.has(id)) continue;
      const o = orders.find(x => x.id === id); if (!o) continue;
      const r = await shipOut(o, { orders, isAdmin, confirm, onShipped: (ord, patch) => { done.add(ord.id); setOrders(p => p.map(x => x.id === ord.id ? { ...x, ...patch } : x)); }, onPatched: (res) => setOrders(p => patchOrdersWithGroupResult(p, res)), toast });
      if (r.ok) n += r.shipped.length; else toast(`${o.customer}: ${r.reason}`, "error");
    }
    await reloadOrders(); setSel(new Set()); setBusy("");
    if (n) toast(`${n}건 출고완료`);
    // 출고 안내 문자 — 회사 설정에서 켜 둔(notifySms) 유료 회사만 묻는다. 꺼져 있으면 아무것도 묻지 않는다.
    if (n && config?.notifySms && aiAllowed) {
      const targets = [...done].map(id => orders.find(x => x.id === id)).filter(o => o && String(o.phone || "").replace(/\D/g, "").length >= 10);
      if (targets.length && await confirm(`${targets.length}명에게 출고 안내 문자를 보낼까요?`)) {
        setBusy("sms");
        try {
          const r = await sendShipNotice(targets.map(o => o.id));
          const fails = Array.isArray(r.failed) ? r.failed : [];
          if (r.sent) toast(`출고 안내 문자 ${r.sent}건 발송${r.dev ? " (개발 모드 — 실제로는 안 나감)" : ""}`);
          if (fails.length) toast(`문자 ${fails.length}건 못 보냄: ${fails.slice(0, 3).map(f => `${orders.find(x => x.id === f.id)?.customer || shortId(f.id)} (${f.reason})`).join(", ")}${fails.length > 3 ? " …" : ""}`, "error");
          if (!r.sent && !fails.length) toast("보낼 문자가 없습니다");
        } catch (e) { toast(e.message, "error"); }
        finally { setBusy(""); }
      }
    }
  };

  const Row = ({ o, extra }) => {
    const grp = shipGroupOf(o, orders);
    const info = courierById.get(o.id);
    return (
      <label className="row-check">
        <input type="checkbox" checked={sel.has(o.id)} onChange={() => toggle(o.id)} />
        <span className="left">
          <strong>{o.customer}{grp.length > 1 ? <span style={{ color: "#8a69da", fontSize: 13 }}> · 합배송 {grp.length}건</span> : null}</strong>
          <small><span className="mono">{shortId(o.id)}</span> · {itemsSummary(o, 2)} · {won(orderTotal(o))}{o.manager ? ` · ${o.manager}` : ""}</small>
          <small>{o.address || "배송지 없음"}{info ? ` · ${info.pickup ? "방문·픽업" : COURIER_SHORT[info.courier]}` : ""}{extra ? ` · ${extra}` : ""}</small>
        </span>
        <StatusBadge tone={getPayStatus(o) === "입금완료" ? "done" : "gray"}>{getPayStatus(o)}</StatusBadge>
      </label>
    );
  };

  const steps = [["pack", `1 포장완료 ${toPack.length}`], ["invoice", `2 송장 ${toInvoice.length}`], ["ship", `3 출고완료 ${toShip.length}`]];
  return (
    <Modal title="출고 처리" onClose={onClose} width="wide">
      {host}
      <p className="helptext">입금이 끝난 주문만 보입니다{unpaid > 0 ? ` (입금 확인 전 ${unpaid}건은 정산에서 처리)` : ""}. 포장완료 → 송장 → 출고완료 순서로 진행합니다. 송장 출력과 출고완료는 관리자만 할 수 있습니다.</p>
      <Segment options={steps} value={step} onChange={(s) => { setStep(s); setSel(new Set()); }} />
      <div style={{ marginTop: 14 }}>
        {step === "pack" && (
          <>
            {toPack.length === 0 ? <Empty small>포장할 주문이 없어요.</Empty> : toPack.map(o => <Row key={o.id} o={o} />)}
            <div className="inline-actions">
              <Button kind="white" className="narrow" onClick={() => setSel(new Set(toPack.map(o => o.id)))}>전체 선택</Button>
              <Button icon="check" onClick={packSelected} loading={busy === "pack"} disabled={selIn(toPack).length === 0}>{selIn(toPack).length}건 포장완료</Button>
            </div>
          </>
        )}
        {step === "invoice" && (
          <>
            {!isAdmin ? <p className="helptext warn">송장 출력은 관리자만 할 수 있습니다.</p> : null}
            <Segment options={[[CJ, `📦 CJ ${toInvoice.filter(o => (courierById.get(o.id)?.courier || CJ) === CJ).length}`], [KD, `🚛 경동 ${toInvoice.filter(o => courierById.get(o.id)?.courier === KD).length}`]]} value={courier} onChange={(c) => { setCourier(c); setSel(new Set()); }} />
            <div style={{ marginTop: 10 }}>
              {invoiceList.length === 0 ? <Empty small>{COURIER_SHORT[courier]}로 나갈 포장완료 주문이 없어요.</Empty> : invoiceList.map(o => <Row key={o.id} o={o} extra={!o.address ? "⚠ 배송지 없음" : ""} />)}
            </div>
            <div className="inline-actions">
              <Button kind="white" className="narrow" onClick={() => setSel(new Set(invoiceList.filter(o => o.address).map(o => o.id)))}>배송지 있는 것 전체</Button>
              <Button icon="download" onClick={exportSel} loading={busy === "inv"} disabled={!isAdmin || selIn(invoiceList).length === 0}>{COURIER_SHORT[courier]} 송장 {boxes(invoiceList.filter(o => sel.has(o.id))).length}장 엑셀</Button>
            </div>
          </>
        )}
        {step === "ship" && (
          <>
            {!isAdmin ? <p className="helptext warn">출고완료는 관리자만 할 수 있습니다.</p> : null}
            {toShip.length === 0 ? <Empty small>송장이 나간 포장완료 박스가 없어요.</Empty> : toShip.map(o => <Row key={o.id} o={o} extra={o.invoicePrintedAt ? `송장 ${new Date(o.invoicePrintedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""} />)}
            <div className="inline-actions">
              <Button kind="white" className="narrow" onClick={() => setSel(new Set(toShip.map(o => o.id)))}>전체 선택</Button>
              <Button kind="green" icon="truck" onClick={shipSelected} loading={busy === "ship"} disabled={!isAdmin || selIn(toShip).length === 0}>{boxes(toShip.filter(o => sel.has(o.id))).length}박스 출고완료</Button>
            </div>
          </>
        )}
      </div>
      <div style={{ marginTop: 10 }}><button className="text-link" style={{ padding: "6px 0" }} onClick={() => go("/app/orders")}>주문 목록으로</button></div>
    </Modal>
  );
}
