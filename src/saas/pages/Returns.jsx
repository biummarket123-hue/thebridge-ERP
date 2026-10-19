// 반품·교환 — 목록, 등록(출고완료 주문을 서버에서 찾는다), 진행(반품신청 → 수거중 → 반품입고(롤 재고 복구) → 완료). 옛 ReturnsTab 의 흐름.
// 교환 기록·완료 되돌리기는 옛 화면으로 보낸다.
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
import { OLD_ERP_PATH } from "../config.js";

const TONE = { "반품신청": "wait", "수거중": "progress", "반품입고": "purple", "완료": "done" };

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

export default function Returns() {
  const { returns, setReturns, orders, managers, activeManager, isAdmin, products, reloadRolls, reloadReturns } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [filter, setFilter] = useState("open");
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  const [searching, setSearching] = useState(false);
  const [reg, setReg] = useState(null);
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
        const labelOf = (it) => `${it.fabric || "?"}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`;
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
        <FilterChips style={{ marginBottom: 14 }} value={filter} onChange={setFilter} options={[["open", "진행 중", returns.filter(r => r.status !== "완료").length], ["done", "완료", returns.filter(r => r.status === "완료").length], ["all", "전체", returns.length]]} />
        {list.length === 0 ? <Empty>반품 건이 없어요.</Empty> : list.map(r => {
          const o = orderOf(r.orderId);
          return (
            <div key={r.id} className="item-line" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="badges" style={{ marginBottom: 6 }}><StatusBadge tone={TONE[r.status] || "gray"}>{r.status}</StatusBadge>{(r.exchangeItems || []).length > 0 && <StatusBadge tone="progress">교환{(r.exchangeDiff ?? 0) !== 0 ? ` 차액 ${(r.exchangeDiff > 0 ? "+" : "") + r.exchangeDiff.toLocaleString()}원` : ""}</StatusBadge>}</div>
                <strong>{r.customer}</strong> <span className="mono" style={{ color: "#8d9bab", fontSize: 13 }}>{shortId(r.orderId)}</span>{r.manager ? <span style={{ color: "#8d9bab" }}> · {r.manager}</span> : null}
                <small style={{ display: "block", marginTop: 4 }}>{(r.items || []).map(it => `${it.fabric || ""}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`).join(", ")}{r.reason ? ` · ${r.reason}` : ""}</small>
                <small style={{ display: "block" }}>{new Date(r.createdAt).toLocaleDateString("ko-KR")}{o ? ` · 원 주문 ${o.date}` : ""}</small>
              </div>
              <div className="chiprow">
                {r.status === "반품신청" && <Button size="sm" kind="white" loading={busy === r.id} onClick={() => advance(r, "수거중")}>수거중으로</Button>}
                {r.status === "수거중" && <Button size="sm" loading={busy === r.id} onClick={() => advance(r, "반품입고")}>반품입고 (재고 복구)</Button>}
                {r.status === "반품입고" && <Button size="sm" kind="green" loading={busy === r.id} onClick={() => advance(r, "완료")}>완료</Button>}
                {r.status === "반품입고" && <a className="btn btn-white btn-sm" href={OLD_ERP_PATH} style={{ textDecoration: "none" }}>교환은 옛 화면</a>}
                {r.status === "완료" && isAdmin && <a className="btn btn-white btn-sm" href={OLD_ERP_PATH} style={{ textDecoration: "none" }}>되돌리기는 옛 화면</a>}
              </div>
            </div>
          );
        })}
      </Panel>
      {reg && <RegisterModal order={reg} onClose={() => setReg(null)} onCreated={(saved) => { setReg(null); setQ(""); if (saved) setReturns(p => [saved, ...p]); else reloadReturns(); }} />}
    </>
  );
}
