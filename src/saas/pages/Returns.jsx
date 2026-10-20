// 반품·교환 — 목록, 등록(출고완료 주문을 서버에서 찾는다), 진행(반품신청 → 수거중 → 반품입고(롤 재고 복구) → 완료 또는 교환).
// 옛 ReturnsTab 의 흐름 그대로. 돈 계산은 src/saas/lib/returnRules.js(순수 함수)에 있다.
//   교환: 반품입고 건에 교환 품목을 적으면 완료로 넘어간다. 차액 > 0 은 원 주문 금액에 가산(선택 시 적립금으로 바로 차감),
//         차액 < 0 은 주문 상세의 환불 신청으로 잇는다.
//   정정(관리자만): 완료 되돌리기(교환 기록 취소 + 가산분 차감), 수거중 → 반품신청 되돌리기, 삭제.
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { Button, Panel, SearchInput, StatusBadge, Empty, FilterChips, TaskRow, shortId, won } from "../components/ui.jsx";
import { checkOrderLock } from "../../lib/managerLock.js";
import { nowT } from "../../constants.js";
import { rollErrorText } from "../../lib/rollStock.js";
import { itemsSummary } from "../lib/metrics.js";
import { navigate } from "../router.js";
import { EXCHANGE_UNITS, calcExchange, canUseCredit, creditBalanceOf, diffText, exchangeLabel, itemLabel, totalAfterExchange, totalAfterUndo, undoMessage } from "../lib/returnRules.js";

const TONE = { "반품신청": "wait", "수거중": "progress", "반품입고": "purple", "완료": "done" };
const orderPath = (id) => `/app/orders/${id}`;
const emptyRow = () => ({ fabric: "", color: "", qty: "", unit: "마", unitPrice: 0 });

function RegisterModal({ order, onClose, onCreated }) {
  const { activeManager } = useSaas();
  const toast = useToast();
  const [qty, setQty] = useState(() => Object.fromEntries((order.items || []).map((_, i) => [i, 0])));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const src = order.items || []; const items = [];
    for (let i = 0; i < src.length; i++) {
      const want = parseFloat(qty[i]) || 0; if (want <= 0) continue;
      const orig = parseFloat(src[i].qty) || 0;
      if (want > orig) { toast(`${src[i].fabric} 반품 수량이 주문 수량(${orig})을 초과합니다`, "error"); return; }
      items.push({ ...src[i], qty: want, amount: orig > 0 ? Math.round((parseInt(src[i].amount) || 0) * (want / orig)) : 0 });
    }
    if (!items.length) { toast("반품 수량을 1개 이상 입력하세요", "error"); return; }
    setBusy(true);
    try { const saved = await db.insertReturn({ orderId: order.id, customer: order.customer, items, reason: reason.trim(), manager: activeManager || "" }); toast("반품 신청 등록 완료"); onCreated(saved); }
    catch (e) { toast("반품 등록 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="반품 신청" onClose={onClose}>
      <p className="helptext"><b>{order.customer}</b> · <span className="mono">{shortId(order.id)}</span> · 반품할 품목의 수량을 입력하세요(부분 반품 가능).</p>
      <div className="items-list">
        {(order.items || []).map((it, i) => (
          <div key={i} className="item-line">
            <div style={{ minWidth: 0 }}><strong>{it.fabric}{it.color ? ` ${it.color}` : ""}</strong><small>주문 {it.qty}{it.unit || "마"}</small></div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input className="forminput" style={{ width: 90, height: 44 }} inputMode="decimal" value={qty[i] ?? 0} onChange={e => setQty(p => ({ ...p, [i]: e.target.value }))} aria-label={`${it.fabric} 반품 수량`} />
              <button className="chip" onClick={() => setQty(p => ({ ...p, [i]: parseFloat(it.qty) || 0 }))}>전량</button>
            </div>
          </div>
        ))}
      </div>
      <label className="formlabel" htmlFor="ret-reason">사유</label>
      <input id="ret-reason" className="forminput" value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 색상 불량, 고객 변심" />
      <div className="btnrow" style={{ marginTop: 18 }}><Button kind="white" onClick={onClose}>취소</Button><Button icon="undo" onClick={submit} loading={busy}>반품 신청 등록</Button></div>
    </Modal>
  );
}

// 교환 처리 — 별도 주문을 만들지 않고 반품 레코드에 교환 품목·차액을 기록하고 완료로 넘긴다(옛 ExchangeModal).
// order 가 null 이면(원 주문을 못 찾음) 기록만 남기고 금액 가산은 건너뛴다.
function ExchangeModal({ ret, order, onClose, onDone }) {
  const { activeManager, credits, reloadCredits } = useSaas();
  const toast = useToast();
  const [rows, setRows] = useState([emptyRow()]);
  const [useCredit, setUseCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const creditBal = creditBalanceOf(credits, ret.customer);
  const { items: exItems, retSum, exSum, diff } = calcExchange(ret.items, rows);
  const creditOk = canUseCredit(diff, creditBal);
  const setRow = (i, patch) => setRows(p => p.map((x, j) => j === i ? { ...x, ...patch } : x));
  const inp = { height: 44, fontSize: 15, padding: "0 10px" };

  const submit = async () => {
    if (busy) return;
    if (!exItems.length) { toast("교환 품목을 1개 이상 입력하세요", "error"); return; }
    setBusy(true);
    try {
      await db.updateReturn(ret.id, { status: "완료", completed_at: new Date().toISOString(), exchange_items: exItems, exchange_diff: diff });
      let newTotal = null, usedCredit = false;
      const target = order && order.id === ret.orderId ? order : null;
      if (diff > 0 && target) {
        newTotal = totalAfterExchange(target, diff);
        await db.updateOrder(target.id, { totalAmount: newTotal }, { route: "교환 차액 가산 · 새 UI" });
        if (useCredit && creditOk) {
          await db.insertCredit({ customer: target.customer, amount: diff, type: "사용", reason: "교환 차액 차감", manager: activeManager || "", orderId: target.id });
          await db.addPaymentLog(target.id, "적립금차감", diff, `교환 차액 적립금 ${diff.toLocaleString("ko-KR")}원 차감`, target.customer);
          const logs = await db.fetchOrderLogs(target.id);
          if (db.calcOrderMoney(logs, newTotal, target.payment).paymentStatus === "입금완료") await db.updateOrder(target.id, { payment: "입금완료" }, { route: "교환 차액 적립금 완납 · 새 UI" });
          reloadCredits();
          usedCredit = true;
        }
      }
      onDone({ items: exItems, diff, newTotal, usedCredit, orderMissing: diff > 0 && !target });
    } catch (e) { toast("교환 처리 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="🔄 교환 처리" onClose={onClose} width="wide">
      <p className="helptext"><b>{ret.customer}</b> 님에게 대신 보낼 교환 품목을 입력하세요. 별도 주문 없이 원 주문의 반품/교환 기록으로 남습니다.</p>
      <div className="notice-box">
        <b>반품 받은 품목</b> (합계 {won(retSum)})<br />
        {(ret.items || []).map(itemLabel).join(", ")}
      </div>
      <label className="formlabel">교환으로 보낼 품목</label>
      <div className="items-list" style={{ margin: 0 }}>
        {rows.map((rw, i) => {
          const amt = Math.round((parseInt(rw.unitPrice) || 0) * (parseFloat(rw.qty) || 0));
          return (
            <div key={i} className="item-line" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input className="forminput" style={{ ...inp, flex: 2, minWidth: 0 }} value={rw.fabric} onChange={e => setRow(i, { fabric: e.target.value })} placeholder="원단명" aria-label={`교환 ${i + 1} 원단명`} />
                <input className="forminput" style={{ ...inp, flex: 1, minWidth: 0 }} value={rw.color} onChange={e => setRow(i, { color: e.target.value })} placeholder="색상" aria-label={`교환 ${i + 1} 색상`} />
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input className="forminput" style={{ ...inp, width: 70, flex: "none" }} inputMode="decimal" value={rw.qty} onChange={e => setRow(i, { qty: e.target.value })} placeholder="수량" aria-label={`교환 ${i + 1} 수량`} />
                <select className="forminput" style={{ ...inp, width: 76, flex: "none", padding: "0 6px" }} value={rw.unit} onChange={e => setRow(i, { unit: e.target.value })} aria-label={`교환 ${i + 1} 단위`}>
                  {EXCHANGE_UNITS.map(u => <option key={u}>{u}</option>)}
                </select>
                <input className="forminput" style={{ ...inp, flex: 1, minWidth: 0, textAlign: "right" }} inputMode="numeric" value={rw.unitPrice ? Number(rw.unitPrice).toLocaleString("ko-KR") : ""} onChange={e => setRow(i, { unitPrice: parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0 })} placeholder="단가" aria-label={`교환 ${i + 1} 단가`} />
                <span className="amt" style={{ fontSize: 14, color: amt ? "#2e6ee8" : "#8d9bab", minWidth: 72, textAlign: "right" }}>{won(amt)}</span>
                {rows.length > 1 && <button className="chip danger" style={{ padding: "0 10px", minHeight: 40 }} onClick={() => setRows(p => p.filter((_, j) => j !== i))} aria-label="줄 삭제">✕</button>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="chiprow" style={{ marginTop: 8 }}><button className="chip" onClick={() => setRows(p => [...p, emptyRow()])}>＋ 품목 추가</button></div>

      <div className={`helptext ${diff > 0 ? "warn" : diff < 0 ? "err" : ""}`} style={{ marginTop: 16, marginBottom: 0 }}>
        <div>반품액 {won(retSum)} → 교환액 {won(exSum)} · 차액 <b>{diffText(diff)}</b></div>
        <div style={{ fontWeight: 800, marginTop: 4 }}>
          {diff > 0 ? (!order ? `추가 결제 ${won(diff)} — 원 주문을 찾지 못해 금액 가산은 건너뜁니다(수동 확인 필요)` : useCredit && creditOk ? `추가 결제 ${won(diff)} — 적립금에서 바로 차감됩니다` : `추가 결제 ${won(diff)} — 원 주문 금액에 가산되어 미수금으로 표시됩니다`)
            : diff < 0 ? `환불할 차액 ${won(Math.abs(diff))} — 기록 후 주문 상세에서 차액 환불을 신청하세요`
            : "차액 없음 — 교환 기록만 남습니다"}
        </div>
        {diff > 0 && order && creditBal > 0 && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: creditOk ? "pointer" : "not-allowed", opacity: creditOk ? 1 : 0.6 }}>
            <input type="checkbox" checked={useCredit && creditOk} disabled={!creditOk} onChange={e => setUseCredit(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span style={{ fontWeight: 800 }}>💰 적립금으로 차액 차감 (보유 {won(creditBal)}{creditOk ? "" : " — 잔액 부족"})</span>
          </label>
        )}
      </div>

      <div className="btnrow" style={{ marginTop: 18 }}>
        <Button kind="white" onClick={onClose}>취소</Button>
        <Button icon="refresh" onClick={submit} loading={busy} disabled={!exItems.length}>교환 기록 저장</Button>
      </div>
    </Modal>
  );
}

export default function Returns() {
  const { returns, setReturns, orders, setOrders, managers, activeManager, isAdmin, products, reloadRolls, reloadReturns } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [filter, setFilter] = useState("open");
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState(false);
  const [reg, setReg] = useState(null);
  const [exFor, setExFor] = useState(null);       // 교환 모달 대상 반품 건
  const [refundHint, setRefundHint] = useState(null); // 교환 차액 < 0 → 주문 상세로 안내
  const [busy, setBusy] = useState("");
  const [orderCache, setOrderCache] = useState({});

  useEffect(() => {
    const ql = q.trim();
    if (ql.length < 2) { setFound([]); return; }
    let alive = true; setSearching(true);
    const t = setTimeout(() => db.searchShippedOrders(ql).then(r => { if (alive) setFound(r); }).catch(e => toast("검색 실패: " + e.message, "error")).finally(() => alive && setSearching(false)), 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q, toast]);
  const ids = useMemo(() => returns.map(r => r.orderId).filter(id => id && !orders.some(o => o.id === id) && !(id in orderCache)), [returns, orders, orderCache]);
  useEffect(() => {
    if (!ids.length) return;
    db.fetchOrdersByIds(ids).then(rows => setOrderCache(p => ({ ...p, ...Object.fromEntries(ids.map(id => [id, rows.find(r => r.id === id) || null])) }))).catch(() => {});
  }, [ids]);
  const orderOf = (id) => orders.find(o => o.id === id) || orderCache[id] || null;
  // 원 주문은 활성 목록에 없을 수도 있다(출고완료). 양쪽 다 갱신해야 화면이 맞는다.
  const patchOrderTotal = (id, totalAmount) => {
    setOrders(p => p.map(o => o.id === id ? { ...o, totalAmount } : o));
    setOrderCache(p => p[id] ? { ...p, [id]: { ...p[id], totalAmount } } : p);
  };
  const lockOf = (r) => {
    const o = orderOf(r.orderId);
    if (o) return checkOrderLock(o, activeManager, managers, orders);
    const cur = managers.find(m => m.name === activeManager);
    if (cur?.isAdmin || !r.manager || r.manager === activeManager) return null;
    return `이 반품은 ${r.manager} 담당입니다`;
  };
  const list = returns.filter(r => filter === "all" || (filter === "open" ? r.status !== "완료" : r.status === "완료"));

  const advance = async (r, next) => {
    const lock = lockOf(r); if (lock) { toast(lock, "error"); return; }
    setBusy(r.id);
    try {
      if (next === "반품입고" && !r.restocked) {
        const labelOf = itemLabel;
        if (!await confirm(`반품입고 처리합니다.\n\n${(r.items || []).map(it => "• " + labelOf(it)).join("\n")}\n\n품번이 연결된 품목은 롤 재고에 다시 들어갑니다(잘라 나갔던 것은 조각 롤, 통째는 원래 롤 되살림).`)) { setBusy(""); return; }
        await db.updateReturn(r.id, { status: "반품입고", restocked: true });
        setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "반품입고", restocked: true } : x));
        const t = nowT(); const done = [], skipped = [], failed = [];
        const note = `반품입고${r.reason ? ` — ${r.reason}` : ""}${r.customer ? ` (${r.customer})` : ""}`;
        for (const it of (r.items || [])) {
          try {
            const res = await db.restockReturnedItem({ orderId: r.orderId, item: it, qty: it.qty, products, note, by: activeManager || "" });
            if (res.kind === "skipped") { skipped.push(`${labelOf(it)} — ${res.why}`); continue; }
            done.push(res.kind === "piece" ? `조각 롤 ${res.roll.rollCode}` : `${res.roll.rollCode} 되살림`);
            await db.insertLog({ date: t.date, time: t.time, type: "반품입고", itemNo: it.itemNo || "", fabric: it.fabric || "", color: it.color || "", qty: it.qty || 0, ref: `반품 #${String(r.orderId || "").slice(0, 8)}`, note: `${res.roll.rollCode}${r.reason ? ` · ${r.reason}` : ""}` });
          } catch (e) { failed.push(`${labelOf(it)} — ${rollErrorText(e)}`); }
        }
        if (done.length) reloadRolls();
        if (failed.length || (skipped.length && !skipped.every(s => s.includes("품번이 연결되지 않은")))) toast([done.length ? `넣음: ${done.join(", ")}` : "", skipped.length ? `안 넣음: ${skipped.join(", ")}` : "", failed.length ? `실패: ${failed.join(", ")}` : ""].filter(Boolean).join("\n"), "error");
        else toast(done.length ? `반품입고 — ${done.join(", ")}` : "반품입고 처리 완료 (품번이 연결된 품목이 없어 롤 재고는 그대로)");
      } else {
        const fields = next === "완료" ? { status: "완료", completed_at: new Date().toISOString() } : { status: next };
        await db.updateReturn(r.id, fields);
        setReturns(p => p.map(x => x.id === r.id ? { ...x, status: next, completedAt: fields.completed_at || x.completedAt } : x));
        toast(`반품 상태: ${next}`);
      }
    } catch (e) { toast("처리 실패: " + e.message, "error"); }
    finally { setBusy(""); }
  };

  // 교환 모달 열기 — 담당자 잠금은 진행 단계와 같이 적용
  const openExchange = (r) => {
    const lock = lockOf(r); if (lock) { toast(lock, "error"); return; }
    setExFor(r);
  };
  const onExchanged = (r, { items, diff, newTotal, usedCredit, orderMissing }) => {
    setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "완료", completedAt: new Date().toISOString(), exchangeItems: items, exchangeDiff: diff } : x));
    if (newTotal !== null) patchOrderTotal(r.orderId, newTotal);
    setExFor(null);
    if (diff < 0) { setRefundHint({ orderId: r.orderId, customer: r.customer, amount: Math.abs(diff) }); toast(`교환 기록 저장 — 차액 ${won(Math.abs(diff))} 환불은 주문 상세에서 신청하세요`); }
    else if (orderMissing) toast(`교환 기록 저장 — 원 주문을 찾지 못해 차액 ${won(diff)} 가산은 건너뛰었습니다`, "error");
    else if (diff > 0) toast(usedCredit ? `교환 기록 저장 — 차액 ${won(diff)} 적립금 차감` : `교환 기록 저장 — 차액 ${won(diff)} 원 주문에 가산(미수금)`);
    else toast("교환 기록 저장");
  };

  // 완료 되돌리기(관리자) — 반품입고로 복귀. 교환 기록이 있으면 함께 취소하고 가산분(> 0)은 원 주문 금액에서 차감.
  const undoComplete = async (r) => {
    if (!isAdmin) { toast("되돌리기는 관리자만 가능합니다", "error"); return; }
    const o = orderOf(r.orderId);
    const hasEx = (r.exchangeItems || []).length > 0;
    const diff = r.exchangeDiff ?? 0;
    if (!await confirm(undoMessage(r, o), { title: "완료 되돌리기", confirmLabel: "되돌리기" })) return;
    setBusy(r.id);
    try {
      const newTotal = hasEx ? totalAfterUndo(o, diff) : null;
      if (newTotal !== null) {
        await db.updateOrder(o.id, { totalAmount: newTotal }, { route: "교환 되돌리기 차액 차감 · 새 UI" });
        patchOrderTotal(o.id, newTotal);
      }
      await db.updateReturn(r.id, { status: "반품입고", completed_at: null, exchange_items: [], exchange_diff: null });
      setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "반품입고", completedAt: null, exchangeItems: [], exchangeDiff: null } : x));
      toast(hasEx ? "교환 기록 취소 — 반품입고 상태로 되돌렸습니다" : "반품입고 상태로 되돌렸습니다");
    } catch (e) { toast("되돌리기 실패: " + e.message, "error"); }
    finally { setBusy(""); }
  };

  // 수거중 → 반품신청(관리자) — 단순 상태 되돌림(재고·돈 변화 없음)
  const undoCollecting = async (r) => {
    if (!isAdmin) { toast("되돌리기는 관리자만 가능합니다", "error"); return; }
    if (!await confirm(`${r.customer} 반품 건을 '반품신청' 상태로 되돌릴까요?`, { confirmLabel: "되돌리기" })) return;
    setBusy(r.id);
    try {
      await db.updateReturn(r.id, { status: "반품신청" });
      setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "반품신청" } : x));
      toast("반품신청 상태로 되돌렸습니다");
    } catch (e) { toast("되돌리기 실패: " + e.message, "error"); }
    finally { setBusy(""); }
  };

  const removeReturn = async (r) => {
    if (!isAdmin) { toast("반품 삭제는 관리자만 가능합니다", "error"); return; }
    if (!await confirm(`${r.customer} 반품 건을 삭제할까요?${r.restocked ? "\n(이미 복구된 재고는 되돌리지 않습니다)" : ""}${(r.exchangeDiff ?? 0) > 0 ? "\n(원 주문에 가산된 교환 차액도 되돌리지 않습니다 — 먼저 '되돌리기'를 쓰세요)" : ""}`, { title: "반품 삭제", confirmLabel: "삭제", danger: true })) return;
    setBusy(r.id);
    try {
      await db.deleteReturn(r.id);
      setReturns(p => p.filter(x => x.id !== r.id));
      toast("반품 삭제됨");
    } catch (e) { toast("삭제 실패: " + e.message, "error"); }
    finally { setBusy(""); }
  };

  return (
    <>
      {host}
      <Panel title="반품 등록" small="출고완료 주문을 고객명·전화번호로 찾습니다">
        <SearchInput value={q} onChange={setQ} placeholder="고객명 · 전화번호 (2자 이상)" />
        <div className="tasklist" style={{ marginTop: 10 }}>
          {searching && <div className="loading-line">찾는 중…</div>}
          {found.slice(0, 8).map(o => <TaskRow key={o.id} icon="orders" title={`${o.customer} · ${shortId(o.id)}`} hint={`${o.date} · ${itemsSummary(o, 2)}`} count={won(o.totalAmount)} onClick={() => {
            const lock = checkOrderLock(o, activeManager, managers, orders); if (lock) { toast(lock, "error"); return; } setReg(o);
          }} />)}
          {q.trim().length >= 2 && !searching && found.length === 0 && <Empty small>출고완료 주문 중 일치하는 것이 없어요.</Empty>}
        </div>
      </Panel>
      <Panel title="반품·교환 목록" small={`${list.length}건`} style={{ marginTop: 20 }}>
        {refundHint && (
          <div className="helptext err" style={{ margin: "0 0 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 180 }}><b>{refundHint.customer}</b> 교환 차액 {won(refundHint.amount)} 을 돌려줘야 합니다.</span>
            <Button size="sm" kind="white" icon="wallet" onClick={() => { setRefundHint(null); navigate(orderPath(refundHint.orderId)); }}>차액 환불 신청은 주문 상세에서</Button>
            <button className="chip" onClick={() => setRefundHint(null)} aria-label="안내 닫기">닫기</button>
          </div>
        )}
        <FilterChips style={{ marginBottom: 14 }} value={filter} onChange={setFilter} options={[["open", "진행 중", returns.filter(r => r.status !== "완료").length], ["done", "완료", returns.filter(r => r.status === "완료").length], ["all", "전체", returns.length]]} />
        {list.length === 0 ? <Empty>반품 건이 없어요.</Empty> : list.map(r => {
          const o = orderOf(r.orderId);
          const hasEx = (r.exchangeItems || []).length > 0;
          const diff = r.exchangeDiff ?? 0;
          const isBusy = busy === r.id;
          return (
            <div key={r.id} className="item-line" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="badges" style={{ marginBottom: 6 }}>
                  <StatusBadge tone={TONE[r.status] || "gray"}>{r.status}</StatusBadge>
                  {hasEx && <StatusBadge tone="progress">교환</StatusBadge>}
                  {hasEx && diff !== 0 && <StatusBadge tone={diff > 0 ? "late" : "purple"}>차액 {diffText(diff)}</StatusBadge>}
                </div>
                <strong>{r.customer}</strong> <span className="mono" style={{ color: "#8d9bab", fontSize: 13 }}>{shortId(r.orderId)}</span>{r.manager ? <span style={{ color: "#8d9bab" }}> · {r.manager}</span> : null}
                <small style={{ display: "block", marginTop: 4 }}>반품: {(r.items || []).map(itemLabel).join(", ")}{r.reason ? ` · ${r.reason}` : ""}</small>
                {hasEx && <small style={{ display: "block", color: "#2e6ee8" }}>교환 → {exchangeLabel(r.exchangeItems)}{diff !== 0 ? ` · 차액 ${diffText(diff)}${diff > 0 ? " (원 주문 가산)" : " (환불)"}` : ""}</small>}
                <small style={{ display: "block" }}>{new Date(r.createdAt).toLocaleDateString("ko-KR")}{o ? ` · 원 주문 ${o.date}` : ""}{r.completedAt ? ` · 완료 ${new Date(r.completedAt).toLocaleDateString("ko-KR")}` : ""}</small>
              </div>
              <div className="chiprow">
                {r.status === "반품신청" && <Button size="sm" kind="white" loading={isBusy} onClick={() => advance(r, "수거중")}>수거중으로</Button>}
                {r.status === "수거중" && <Button size="sm" loading={isBusy} onClick={() => advance(r, "반품입고")}>반품입고 (재고 복구)</Button>}
                {r.status === "수거중" && isAdmin && <Button size="sm" kind="danger" icon="undo" loading={isBusy} onClick={() => undoCollecting(r)}>반품신청으로</Button>}
                {r.status === "반품입고" && <Button size="sm" kind="green" icon="check" loading={isBusy} onClick={() => advance(r, "완료")}>완료</Button>}
                {r.status === "반품입고" && <Button size="sm" icon="refresh" loading={isBusy} onClick={() => openExchange(r)}>교환</Button>}
                {r.status === "완료" && hasEx && diff < 0 && <Button size="sm" kind="white" icon="wallet" onClick={() => navigate(orderPath(r.orderId))}>차액 환불은 주문 상세에서</Button>}
                {r.status === "완료" && isAdmin && <Button size="sm" kind="danger" icon="undo" loading={isBusy} onClick={() => undoComplete(r)}>되돌리기</Button>}
                {isAdmin && <Button size="sm" kind="danger" icon="trash" loading={isBusy} onClick={() => removeReturn(r)}>삭제</Button>}
              </div>
            </div>
          );
        })}
      </Panel>
      {reg && <RegisterModal order={reg} onClose={() => setReg(null)} onCreated={(saved) => { setReg(null); setQ(""); if (saved) setReturns(p => [saved, ...p]); else reloadReturns(); }} />}
      {exFor && <ExchangeModal ret={exFor} order={orderOf(exFor.orderId)} onClose={() => setExFor(null)} onDone={(res) => onExchanged(exFor, res)} />}
    </>
  );
}
