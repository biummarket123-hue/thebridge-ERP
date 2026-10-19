import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, Empty, SecTitle } from "./UI.jsx";
import { SF, S, baseInp, nowT, useTheme } from "../constants.js";
import { checkOrderLock } from "../lib/managerLock.js";
import * as db from "../lib/db.js";
import { rollErrorText } from "../lib/rollStock.js";

// 반품 등록 폼 — 품목별 수량(부분 반품) + 사유. 입출고 반품 탭과 대시보드 모달에서 공용.
export function ReturnRegisterForm({ order, activeManager, showToast, onCreated, onCancel }) {
  const G = useTheme();
  const [retQty, setRetQty] = useState(() => Object.fromEntries((order.items || []).map((_, i) => [i, 0])));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const src = order.items || [];
    const items = [];
    for (let i = 0; i < src.length; i++) {
      const want = parseFloat(retQty[i]) || 0;
      if (want <= 0) continue;
      const orig = parseFloat(src[i].qty) || 0;
      if (want > orig) { showToast(`${src[i].fabric} 반품 수량이 주문 수량(${orig})을 초과합니다`, "error"); return; }
      // 부분 반품이면 금액도 수량 비율로 환산 — 교환 차액 계산의 기준값
      const amount = orig > 0 ? Math.round((parseInt(src[i].amount) || 0) * (want / orig)) : 0;
      items.push({ ...src[i], qty: want, amount });
    }
    if (items.length === 0) { showToast("반품 수량을 1개 이상 입력하세요", "error"); return; }
    setBusy(true);
    try {
      const saved = await db.insertReturn({ orderId: order.id, customer: order.customer, items, reason: reason.trim(), manager: activeManager || "" });
      showToast("반품 신청 등록 완료 — 재고/반품 탭에서 진행됩니다");
      onCreated?.(saved);
    } catch (e) { console.error(e); showToast("반품 등록 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 15, color: G.cream }}>{order.customer}</span>
        <span style={{ fontFamily: SF, fontSize: 10, color: G.copper, fontWeight: 700 }}>#{String(order.id).slice(0, 8)}</span>
        {onCancel && <button onClick={onCancel} style={{ marginLeft: "auto", fontSize: 11, color: G.creamMuted, background: "none", border: `1px solid ${G.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontFamily: S }}>✕ 취소</button>}
      </div>
      <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 6 }}>반품할 품목의 수량을 입력하세요 (부분 반품 가능)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
        {(order.items || []).map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: G.surface, borderRadius: 8, border: `1px solid ${G.border}` }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: G.cream, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.fabric}{it.color ? ` ${it.color}` : ""} <span style={{ color: G.creamMuted, fontWeight: 500 }}>(주문 {it.qty}{it.unit || "마"})</span>
            </span>
            <input type="number" min={0} max={parseFloat(it.qty) || 0} value={retQty[i] ?? 0}
              onChange={e => setRetQty(p => ({ ...p, [i]: e.target.value }))}
              style={{ ...baseInp, width: 70, fontSize: 13, padding: "7px 8px", textAlign: "right", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
            <button onClick={() => setRetQty(p => ({ ...p, [i]: parseFloat(it.qty) || 0 }))}
              style={{ flexShrink: 0, fontSize: 10, color: G.copper, background: G.copperGlow, border: `1px solid ${G.copper}40`, borderRadius: 6, padding: "5px 9px", cursor: "pointer", fontFamily: S, fontWeight: 700 }}>전량</button>
          </div>
        ))}
      </div>
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="반품 사유 (예: 색상 불량, 고객 변심)"
        style={{ ...baseInp, width: "100%", boxSizing: "border-box", fontSize: 12, marginBottom: 10, background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
      <button onClick={submit} disabled={busy} style={{ width: "100%", padding: "11px", borderRadius: 9, border: "none", background: `linear-gradient(135deg,${G.copper},${G.copperLight})`, color: G.white, fontWeight: 800, fontSize: 13, cursor: busy ? "not-allowed" : "pointer", fontFamily: S, opacity: busy ? 0.6 : 1 }}>
        ↩️ 반품 신청 등록
      </button>
    </div>
  );
}

// 반품 등록 모달 — 대시보드 등 다른 화면에서 주문 하나를 바로 반품 신청할 때 사용
export function ReturnRegisterModal({ order, onClose, onCreated, activeManager, showToast }) {
  const G = useTheme();
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: G.card, borderRadius: 16, border: `1px solid ${G.border}`, padding: 20, width: "100%", maxWidth: 440, maxHeight: "100%", overflow: "auto" /* 85vh -> 100%: .erp-root 의 zoom(글씨 배율) 이 vh 를 그만큼 부풀린다 — 배율 1.3 이면 85vh 가 화면의 110% 가 되어 모달 위아래가 잘렸다. 오버레이(position:fixed, inset:0)는 배율에 안 부풀므로 그 100%(패딩 16 제외)를 기준으로 삼는다. */ }}>
        <div style={{ fontFamily: SF, fontSize: 18, fontWeight: 800, color: G.copper, marginBottom: 10 }}>↩️ 반품 신청</div>
        <ReturnRegisterForm order={order} activeManager={activeManager} showToast={showToast}
          onCancel={onClose} onCreated={(saved) => { onCreated?.(saved); onClose?.(); }} />
      </div>
    </div>
  );
}

const EX_UNIT_OPTS = ["마", "세트", "필", "롤", "kg"];

// 교환 모달 — 별도 주문을 만들지 않고 반품 레코드에 교환 품목·차액을 기록한다.
// 차액(교환액 - 반품액) > 0 → 원 주문 금액에 가산해 미수금으로 표시(추가 결제 수금),
// 차액 < 0 → 원 주문 환불신청으로 연결해 차액을 돌려준다.
export function ExchangeModal({ ret, order, activeManager, showToast, onClose, onDone, credits, setCredits }) {
  const G = useTheme();
  const [rows, setRows] = useState([{ fabric: "", color: "", qty: 0, unit: "마", unitPrice: 0 }]);
  const [useCredit, setUseCredit] = useState(false); // 차액(+)을 고객 적립금으로 차감
  const [busy, setBusy] = useState(false);

  // 고객 적립금 잔액 — 차액 추가 결제를 적립금으로 대체할 수 있는지 판단
  const creditBal = (credits || []).filter(c => c.customer === order.customer).reduce((s, c) => s + (c.type === "적립" ? c.amount : -c.amount), 0);

  const retSum = (ret.items || []).reduce((s, it) => s + (parseInt(it.amount) || 0), 0);
  const exItems = rows
    .map(rw => ({ fabric: (rw.fabric || "").trim(), color: (rw.color || "").trim(), qty: parseFloat(rw.qty) || 0, unit: rw.unit || "마", unitPrice: parseInt(rw.unitPrice) || 0 }))
    .filter(rw => rw.fabric && rw.qty > 0)
    .map(rw => ({ itemNo: "", ...rw, amount: Math.round(rw.unitPrice * rw.qty) }));
  const exSum = exItems.reduce((s, it) => s + it.amount, 0);
  const diff = exSum - retSum;
  const setRow = (i, patch) => setRows(p => p.map((x, j) => j === i ? { ...x, ...patch } : x));

  const submit = async () => {
    if (busy) return;
    if (exItems.length === 0) { showToast("교환 품목을 1개 이상 입력하세요", "error"); return; }
    setBusy(true);
    try {
      // 교환 내용을 반품 레코드에 기록 — 별도 주문 생성 없음
      await db.updateReturn(ret.id, { status: "완료", completed_at: new Date().toISOString(), exchange_items: exItems, exchange_diff: diff });
      // 차액 양수면 원 주문 금액에 가산 → 정산에서 미수금으로 자연스럽게 표시됨
      let newTotal = null;
      let usedCredit = false;
      if (diff > 0) {
        const curTotal = order.totalAmount > 0 ? order.totalAmount : (order.items || []).reduce((s, i) => s + (i.amount || 0), 0);
        newTotal = curTotal + diff;
        await db.updateOrder(order.id, { total_amount: newTotal });
        // 적립금 차감 선택 시 — 차액만큼 적립금 사용 처리 (미수금 즉시 정산)
        if (useCredit && creditBal >= diff) {
          const savedCredit = await db.insertCredit({ customer: order.customer, amount: diff, type: "사용", reason: "교환 차액 차감", manager: activeManager, orderId: order.id });
          if (savedCredit) setCredits?.(p => [savedCredit, ...p]);
          await db.addPaymentLog(order.id, "적립금차감", diff, `교환 차액 적립금 ${diff.toLocaleString()}원 차감`, order.customer);
          const logs = await db.fetchOrderLogs(order.id);
          const computed = db.calcOrderMoney(logs, newTotal, order.payment);
          if (computed.paymentStatus === "입금완료") await db.updateOrder(order.id, { payment: "입금완료" });
          usedCredit = true;
        }
      }
      onDone?.(exItems, diff, newTotal, usedCredit);
      onClose?.();
    } catch (e) { console.error(e); showToast("교환 처리 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: G.card, borderRadius: 16, border: `1px solid ${G.border}`, padding: 20, width: "100%", maxWidth: 480, maxHeight: "100%", overflow: "auto" }}>
        <div style={{ fontFamily: SF, fontSize: 18, fontWeight: 800, color: G.copper, marginBottom: 6 }}>🔄 교환 처리</div>
        <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 12 }}>
          <b style={{ color: G.cream }}>{ret.customer}</b> 님에게 대신 보낼 교환 품목을 입력하세요. 별도 주문 없이 원 주문의 반품/교환 기록으로 남습니다.
        </div>

        {/* 반품 품목 요약 */}
        <div style={{ padding: "9px 12px", background: G.surface, borderRadius: 8, border: `1px solid ${G.border}`, marginBottom: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: G.creamMuted, marginBottom: 4 }}>반품 받은 품목 (합계 {retSum.toLocaleString()}원)</div>
          <div style={{ fontSize: 11, color: G.cream }}>
            {(ret.items || []).map(it => `${it.fabric || "?"}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`).join(", ")}
          </div>
        </div>

        {/* 교환 품목 입력 */}
        <div style={{ fontSize: 10, fontWeight: 800, color: G.copper, marginBottom: 6, letterSpacing: "0.04em" }}>교환으로 보낼 품목</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 }}>
          {rows.map((rw, i) => {
            const amt = Math.round((parseInt(rw.unitPrice) || 0) * (parseFloat(rw.qty) || 0));
            return (
              <div key={i} style={{ padding: "8px 10px", background: G.surface, borderRadius: 8, border: `1px solid ${G.border}` }}>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                  <input value={rw.fabric} onChange={e => setRow(i, { fabric: e.target.value })} placeholder="원단명" style={{ ...baseInp, flex: "2 1 110px", minWidth: 100, fontSize: 12, padding: "8px", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
                  <input value={rw.color} onChange={e => setRow(i, { color: e.target.value })} placeholder="색상" style={{ ...baseInp, flex: "1 1 70px", minWidth: 60, fontSize: 12, padding: "8px", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
                  <input type="number" value={rw.qty || ""} onChange={e => setRow(i, { qty: e.target.value })} placeholder="수량" style={{ ...baseInp, width: 58, fontSize: 12, padding: "8px 6px", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
                  <select value={rw.unit} onChange={e => setRow(i, { unit: e.target.value })} style={{ ...baseInp, width: 52, fontSize: 11, padding: "8px 2px", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }}>
                    {EX_UNIT_OPTS.map(u => <option key={u}>{u}</option>)}
                  </select>
                  <input type="text" inputMode="numeric" value={rw.unitPrice ? Number(rw.unitPrice).toLocaleString() : ""} onChange={e => setRow(i, { unitPrice: parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0 })} placeholder="단가" style={{ ...baseInp, width: 74, fontSize: 12, padding: "8px 6px", textAlign: "right", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
                  {rows.length > 1 && <button onClick={() => setRows(p => p.filter((_, j) => j !== i))} style={{ padding: "0 8px", height: 34, borderRadius: 7, border: `1px solid ${G.red}40`, background: G.redBg, color: G.red, cursor: "pointer", fontFamily: S, fontSize: 13, flexShrink: 0 }}>✕</button>}
                </div>
                <div style={{ fontSize: 10, color: amt ? G.copper : G.creamMuted, fontWeight: 700, textAlign: "right", marginTop: 4 }}>합 {amt.toLocaleString()}원</div>
              </div>
            );
          })}
        </div>
        <button onClick={() => setRows(p => [...p, { fabric: "", color: "", qty: 0, unit: "마", unitPrice: 0 }])} style={{ width: "100%", padding: "7px", fontSize: 12, color: G.copper, background: "transparent", border: `1px dashed ${G.border}`, borderRadius: 8, cursor: "pointer", fontFamily: S, marginBottom: 10 }}>+ 품목 추가</button>

        {/* 차액 안내 */}
        <div style={{ padding: "10px 12px", borderRadius: 8, marginBottom: 12, background: diff > 0 ? G.redBg : diff < 0 ? G.blueBg : G.greenBg, border: `1px solid ${diff > 0 ? G.red : diff < 0 ? G.blue : G.green}40` }}>
          <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 2 }}>반품액 {retSum.toLocaleString()} → 교환액 {exSum.toLocaleString()}</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: diff > 0 ? G.red : diff < 0 ? G.blue : G.green }}>
            {diff > 0 ? (useCredit && creditBal >= diff ? `추가 결제 ${diff.toLocaleString()}원 — 적립금에서 바로 차감됩니다` : `추가 결제 ${diff.toLocaleString()}원 — 원 주문 금액에 가산되어 미수금으로 표시됩니다`)
              : diff < 0 ? `환불할 차액 ${Math.abs(diff).toLocaleString()}원 — 기록 후 환불신청으로 연결됩니다`
              : "차액 없음 — 교환 기록만 남습니다"}
          </div>
          {/* 적립금으로 차액 차감 — 잔액이 차액 이상일 때만 선택 가능 */}
          {diff > 0 && creditBal > 0 && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, cursor: creditBal >= diff ? "pointer" : "not-allowed", opacity: creditBal >= diff ? 1 : 0.55 }}>
              <input type="checkbox" checked={useCredit && creditBal >= diff} disabled={creditBal < diff}
                onChange={e => setUseCredit(e.target.checked)} style={{ accentColor: G.purple, width: 15, height: 15 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: G.purple }}>💰 적립금으로 차감 (보유 {creditBal.toLocaleString()}원{creditBal < diff ? " — 잔액 부족" : ""})</span>
            </label>
          )}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${G.border}`, background: "transparent", color: G.creamMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: S }}>취소</button>
          <button onClick={submit} disabled={busy || exItems.length === 0} style={{ flex: 2, padding: "10px", borderRadius: 8, border: "none", background: exItems.length > 0 ? `linear-gradient(135deg,${G.copper},${G.copperLight})` : G.border, color: exItems.length > 0 ? "#fff" : G.creamMuted, fontWeight: 800, fontSize: 13, cursor: exItems.length > 0 && !busy ? "pointer" : "not-allowed", fontFamily: S, opacity: busy ? 0.6 : 1 }}>
            🔄 교환 기록 저장
          </button>
        </div>
      </div>
    </div>
  );
}

// 반품 관리 — 부분 반품 지원.
// 흐름: 반품신청 → 수거중 → 반품입고(재고 복구 + 입출고 로그 '반품입고') → 완료(또는 교환)
// 진행 단계(수거중·반품입고·완료·교환)는 모든 담당자 가능. 되돌리기·삭제 같은 정정은 관리자만.
// 반품입고 시 품목별로 롤 재고에 다시 넣는다 — 잘라 나갔던 품목은 조각 롤 하나, 롤 통째로 나갔던 품목은
// 원래 롤을 되살린다(db.restockReturnedItem). 품번이 연결되지 않은 품목은 건너뛴다.
// (옛 inventory 를 복구하던 자리다. 그 테이블은 0행이라 늘 "복구 생략"이었다.)
export default function ReturnsTab({ orders, setOrders, products = [], reloadRolls, setLogs, returns, setReturns, showToast, activeManager, isAdmin, onRefundRequest, credits, setCredits, managers = [] }) {
  const G = useTheme();
  const [q, setQ] = useState("");
  const [regOrder, setRegOrder] = useState(null); // 반품 등록 대상 주문
  const [exchangeFor, setExchangeFor] = useState(null); // 교환 모달 대상 반품 건
  const [busy, setBusy] = useState(false);

  // ── 이 화면이 다루는 주문은 '이미 나간 주문'이다 ──────────────────────
  // 화면이 공유하는 orders 목록에는 활성 주문만 들어 있다(db.fetchOrders).
  // 반품은 본래 출고완료 건에 거는 것이라, 필요한 주문은 여기서 직접 읽는다.
  // 대시보드가 자기 데이터를 따로 읽는 것과 같은 구조다.

  // 반품 목록이 가리키는 원 주문 중 활성 목록에 없는 것들.
  // + 그 주문들의 합배송 그룹원까지 — 담당자 락의 '같은 그룹에 내 주문이 있으면 허용'
  //   예외를 제대로 판정하려면 그룹이 통째로 보여야 한다(그룹은 같이 출고된다).
  const [relatedOrders, setRelatedOrders] = useState([]);
  const neededIds = useMemo(() => {
    const have = new Set((orders || []).map(o => o.id));
    return [...new Set((returns || []).map(r => r.orderId).filter(id => id && !have.has(id)))].sort();
  }, [returns, orders]);
  const neededKey = neededIds.join(",");
  useEffect(() => {
    if (!neededKey) { setRelatedOrders([]); return; }
    let alive = true;
    (async () => {
      try {
        const rows = await db.fetchOrdersByIds(neededKey.split(","));
        const groupIds = [...new Set(rows.map(o => o.mergeGroupId).filter(Boolean))];
        const mates = groupIds.length ? await db.fetchOrdersByMergeGroups(groupIds) : [];
        if (!alive) return;
        const byId = new Map();
        for (const o of [...rows, ...mates]) byId.set(o.id, o);
        setRelatedOrders([...byId.values()]);
      } catch (e) {
        console.warn("[반품] 원 주문 조회 실패:", e);
        if (alive) showToast?.("반품의 원 주문을 불러오지 못했습니다 — 새로고침해 주세요", "error");
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey]);

  // 주문 한 건 찾기 — 활성 목록 우선, 없으면 위에서 따로 읽어온 것에서.
  const orderOf = useCallback(
    (id) => (orders || []).find(o => o.id === id) || relatedOrders.find(o => o.id === id) || null,
    [orders, relatedOrders]
  );
  // 담당자 락이 합배송 그룹을 훑을 때 볼 범위
  const lockScope = useMemo(() => [...(orders || []), ...relatedOrders], [orders, relatedOrders]);

  // 등록 대상 후보 — 출고완료 주문을 서버에서 검색(고객명·연락처).
  // 예전에는 활성 목록에서 걸렀는데, 거기 출고완료가 더는 없다.
  const ql = q.trim();
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (ql.length < 2) { setCandidates([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    // 타이핑 중에 매 글자마다 서버를 부르지 않는다.
    const timer = setTimeout(async () => {
      try {
        const rows = await db.searchShippedOrders(ql);
        if (alive) setCandidates(rows.slice(0, 8));
      } catch (e) {
        console.error("[반품] 후보 검색 실패:", e);
        if (alive) { setCandidates([]); showToast?.("검색 실패: " + e.message, "error"); }
      } finally {
        if (alive) setSearching(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ql]);

  // 담당자 락 — 본인 담당(또는 관리자·공용) 주문만 반품/교환 처리 가능
  const lockOf = (r) => {
    const order = orderOf(r.orderId);
    if (order) return checkOrderLock(order, activeManager, managers, lockScope);
    // 원 주문이 없으면 반품 등록 담당자 기준으로 판정
    const current = (managers || []).find(m => m.name === activeManager);
    if (current?.isAdmin || !r.manager || r.manager === activeManager) return null;
    return `이 반품은 ${r.manager} 담당입니다. 담당자에게 문의해주세요`;
  };

  const startRegister = async (o) => {
    // 검색으로 갓 찾은 주문이라 그룹원이 아직 손에 없다. 합배송 건이면 이 순간에만
    // 그룹을 읽어 온다 — 안 그러면 그룹 예외가 안 걸려 열리던 것이 잠긴다.
    let scope = lockScope;
    if (o.mergeGroupId) {
      try { scope = [...scope, ...(await db.fetchOrdersByMergeGroups([o.mergeGroupId]))]; }
      catch (e) { console.warn("[반품] 합배송 그룹 조회 실패:", e); }
    }
    const lock = checkOrderLock(o, activeManager, managers, scope);
    if (lock) { showToast(lock, "error"); return; }
    setRegOrder(o);
    setQ("");
  };

  // 상태 진행 — 반품입고 시 롤 재고에 다시 넣기 + 입출고 로그 기록. 본인 담당 주문만(관리자는 전체)
  const advance = async (r, next) => {
    const lock = lockOf(r);
    if (lock) { showToast(lock, "error"); return; }
    if (busy) return;
    setBusy(true);
    try {
      if (next === "반품입고" && !r.restocked) {
        const labelOf = (it) => `${it.fabric || "?"}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`;
        if (!window.confirm(`반품입고 처리합니다.\n\n${(r.items || []).map(it => "• " + labelOf(it)).join("\n")}\n\n품번이 연결된 품목은 롤 재고에 다시 들어갑니다 — 잘라 나갔던 것은 조각 롤 하나(바로 판매 가능, 라벨 출력), 롤 통째로 나갔던 것은 원래 롤이 되살아납니다.\n진행할까요?`)) { setBusy(false); return; }
        // restocked를 먼저 기록 — 넣는 도중 실패해도 재시도로 인한 '중복 입고(재고 부풀림)'를 막는다.
        await db.updateReturn(r.id, { status: "반품입고", restocked: true });
        setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "반품입고", restocked: true } : x));
        const t = nowT();
        const done = [], skipped = [], failed = [];
        const note = `반품입고${r.reason ? ` — ${r.reason}` : ""}${r.customer ? ` (${r.customer})` : ""}`;
        for (const it of (r.items || [])) {
          try {
            const res = await db.restockReturnedItem({ orderId: r.orderId, item: it, qty: it.qty, products, note, by: activeManager || "" });
            if (res.kind === "skipped") { skipped.push(`${labelOf(it)} — ${res.why}`); continue; }
            done.push(res.kind === "piece" ? `조각 롤 ${res.roll.rollCode}` : `${res.roll.rollCode} 되살림`);
            const savedLog = await db.insertLog({ date: t.date, time: t.time, type: "반품입고", itemNo: it.itemNo || "", fabric: it.fabric || "", color: it.color || "", qty: it.qty || 0, ref: `반품 #${String(r.orderId || "").slice(0, 8)}`, note: `${res.roll.rollCode}${r.reason ? ` · ${r.reason}` : ""}` });
            if (savedLog) setLogs(p => [savedLog, ...p]);
          } catch (itemErr) {
            console.error("반품 롤 입고 실패:", labelOf(it), itemErr);
            failed.push(`${labelOf(it)} — ${rollErrorText(itemErr)}`);
          }
        }
        if (done.length) reloadRolls?.();
        // 품번이 하나도 연결되지 않은 반품(롤 등록 전의 주문 대부분)은 예전처럼 조용히 넘어간다.
        const nothingLinked = done.length === 0 && failed.length === 0 && skipped.every(s => s.includes("품번이 연결되지 않은"));
        if (nothingLinked) showToast("반품입고 처리 완료 (품번이 연결된 품목이 없어 롤 재고는 그대로)");
        else if (failed.length || skipped.length) {
          // 사람이 손으로 채워야 할 것이 남았다 — 토스트는 금방 사라지므로 창으로 알린다.
          window.alert([
            done.length ? `롤 재고에 넣은 것 ${done.length}건:\n${done.map(s => "• " + s).join("\n")}` : "",
            skipped.length ? `롤 재고에 넣지 않은 것 ${skipped.length}건:\n${skipped.map(s => "• " + s).join("\n")}` : "",
            failed.length ? `실패 ${failed.length}건 — 입고·검단에서 직접 넣어 주세요:\n${failed.map(s => "• " + s).join("\n")}` : "",
          ].filter(Boolean).join("\n\n"));
        } else showToast(`반품입고 — ${done.join(", ")}`);
      } else {
        const fields = next === "완료" ? { status: "완료", completed_at: new Date().toISOString() } : { status: next };
        await db.updateReturn(r.id, fields);
        setReturns(p => p.map(x => x.id === r.id ? { ...x, status: next, completedAt: fields.completed_at || x.completedAt } : x));
        showToast(`반품 상태: ${next}`);
      }
    } catch (e) { console.error(e); showToast("처리 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  // 완료 되돌리기 — 반품입고 상태로 복귀. 교환 기록이 있으면 함께 취소하고,
  // 차액 가산(양수)분은 원 주문 금액에서 차감. 이미 신청한 차액 환불은 정산관리에서 별도 취소.
  const undoComplete = async (r) => {
    if (!isAdmin) { showToast("되돌리기는 관리자만 가능합니다", "error"); return; }
    if (busy) return;
    const hasEx = (r.exchangeItems || []).length > 0;
    const diff = r.exchangeDiff ?? 0;
    const order = orderOf(r.orderId);
    let msg = hasEx ? "교환 기록을 취소하고 '반품입고' 상태로 되돌릴까요?" : "이 반품 건을 '반품입고' 상태로 되돌릴까요?";
    if (hasEx && diff > 0) msg += order ? `\n(원 주문 금액에 가산됐던 ${diff.toLocaleString()}원도 차감됩니다)` : `\n(원 주문을 찾지 못해 가산됐던 ${diff.toLocaleString()}원은 수동 확인이 필요합니다)`;
    if (hasEx && diff < 0) msg += "\n(차액 환불신청을 이미 했다면 정산관리에서 별도로 취소하세요)";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      if (hasEx && diff > 0 && order) {
        const curTotal = order.totalAmount > 0 ? order.totalAmount : (order.items || []).reduce((s, i) => s + (i.amount || 0), 0);
        const newTotal = Math.max(0, curTotal - diff);
        await db.updateOrder(order.id, { total_amount: newTotal });
        // 원 주문은 활성 목록에 없을 수도 있다(출고완료). 양쪽 다 갱신해야 화면이 맞는다.
        setOrders?.(p => p.map(o => o.id === order.id ? { ...o, totalAmount: newTotal } : o));
        setRelatedOrders(p => p.map(o => o.id === order.id ? { ...o, totalAmount: newTotal } : o));
      }
      await db.updateReturn(r.id, { status: "반품입고", completed_at: null, exchange_items: [], exchange_diff: null });
      setReturns(p => p.map(x => x.id === r.id ? { ...x, status: "반품입고", completedAt: null, exchangeItems: [], exchangeDiff: null } : x));
      showToast(hasEx ? "교환 기록 취소 — 반품입고 상태로 되돌렸습니다" : "반품입고 상태로 되돌렸습니다");
    } catch (e) { console.error(e); showToast("되돌리기 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const removeReturn = async (r) => {
    if (!isAdmin) { showToast("반품 삭제는 관리자만 가능합니다", "error"); return; }
    if (!window.confirm(`${r.customer} 반품 건을 삭제할까요?${r.restocked ? "\n(이미 복구된 재고는 되돌리지 않습니다)" : ""}`)) return;
    try {
      await db.deleteReturn(r.id);
      setReturns(p => p.filter(x => x.id !== r.id));
      showToast("반품 삭제됨");
    } catch (e) { showToast("삭제 실패: " + e.message, "error"); }
  };

  // 반품 상태 색 — 대시보드 출고 태그의 반품 색과 통일 (기존 주문 태그 색과 안 겹침)
  const stColor = { "반품신청": G.copper, "수거중": "#14B8A6", "반품입고": "#6366F1", "완료": G.creamMuted };
  const stBg = { "반품신청": G.copperGlow, "수거중": "rgba(20,184,166,0.14)", "반품입고": "rgba(99,102,241,0.14)", "완료": G.subtleBg };
  const active = (returns || []).filter(r => r.status !== "완료");
  const done = (returns || []).filter(r => r.status === "완료");

  const renderCard = (r) => {
    const order = orderOf(r.orderId);
    return (
      <Card key={r.id} style={{ marginBottom: 8, border: `1px solid ${stColor[r.status]}40` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: G.cream }}>{r.customer}</span>
          {r.orderId && <span style={{ fontFamily: SF, fontSize: 10, color: G.copper, fontWeight: 700 }}>#{String(r.orderId).slice(0, 8)}</span>}
          <span style={{ fontSize: 10, fontWeight: 800, color: stColor[r.status], background: stBg[r.status], padding: "2px 8px", borderRadius: 10, border: `1px solid ${stColor[r.status]}40` }}>{r.status}</span>
          {r.restocked && <span style={{ fontSize: 9, fontWeight: 700, color: G.green, background: G.greenBg, padding: "1px 6px", borderRadius: 4 }}>재고복구됨</span>}
          {((r.exchangeItems || []).length > 0 || r.exchangeOrderId) && <span style={{ fontSize: 9, fontWeight: 700, color: G.blue, background: G.blueBg, padding: "1px 6px", borderRadius: 4 }}>🔄 교환{(r.exchangeDiff ?? 0) !== 0 ? ` (차액 ${(r.exchangeDiff > 0 ? "+" : "") + r.exchangeDiff.toLocaleString()}원)` : ""}</span>}
          {isAdmin && <button onClick={() => removeReturn(r)} style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 11, borderRadius: 6, border: `1px solid ${G.red}40`, background: G.redBg, color: G.red, cursor: "pointer", fontFamily: S }}>🗑</button>}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
          {(r.items || []).map((it, i) => (
            <span key={i} style={{ fontSize: 11, padding: "3px 8px", background: G.surface, borderRadius: 6, border: `1px solid ${G.border}`, color: G.creamMuted }}>
              {it.fabric}{it.color ? ` ${it.color}` : ""} <b style={{ color: G.cream }}>{it.qty}{it.unit || "마"}</b>
            </span>
          ))}
        </div>
        {(r.exchangeItems || []).length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: G.blue }}>교환 →</span>
            {r.exchangeItems.map((it, i) => (
              <span key={i} style={{ fontSize: 11, padding: "3px 8px", background: G.blueBg, borderRadius: 6, border: `1px solid ${G.blue}30`, color: G.creamMuted }}>
                {it.fabric}{it.color ? ` ${it.color}` : ""} <b style={{ color: G.cream }}>{it.qty}{it.unit || "마"}</b>
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 8 }}>
          {String(r.createdAt || "").slice(0, 10)}{r.manager ? ` · ${r.manager}` : ""}{r.reason ? ` · 사유: ${r.reason}` : ""}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r.status === "반품신청" && (
            <button onClick={() => advance(r, "수거중")} disabled={busy} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.yellow}`, background: G.yellowBg, color: G.yellow, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>🚚 수거중으로</button>
          )}
          {r.status === "수거중" && (
            <button onClick={() => advance(r, "반품입고")} disabled={busy} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.blue}`, background: G.blueBg, color: G.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>📥 반품입고 (재고 복구)</button>
          )}
          {/* 교환 차액 환불 — 완료된 교환 건에서 환불 모달을 놓쳤을 때 다시 열 수 있는 경로 */}
          {r.status === "완료" && (r.exchangeDiff ?? 0) < 0 && order && order.payment !== "환불신청" && order.payment !== "환불" && onRefundRequest && (
            <button onClick={() => { const lock = lockOf(r); if (lock) { showToast(lock, "error"); return; } onRefundRequest(order, { initialAmount: Math.abs(r.exchangeDiff), initialReason: "교환 차액 환불" }); }}
              style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.red}`, background: G.redBg, color: G.red, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>
              💸 차액 환불신청 ({Math.abs(r.exchangeDiff).toLocaleString()}원)
            </button>
          )}
          {/* 완료 되돌리기 — 반품입고 상태로 복귀 (교환 기록·차액 가산도 함께 취소) */}
          {r.status === "완료" && isAdmin && (
            <button onClick={() => undoComplete(r)} disabled={busy}
              style={{ flexShrink: 0, padding: "9px 12px", borderRadius: 8, border: `1px dashed ${G.border}`, background: "transparent", color: G.creamMuted, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>
              ↩ 되돌리기
            </button>
          )}
          {r.status === "반품입고" && (
            <>
              <button onClick={() => advance(r, "완료")} disabled={busy} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.green}`, background: G.greenBg, color: G.green, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>✓ 완료</button>
              {order && (
                <button onClick={() => { const lock = lockOf(r); if (lock) { showToast(lock, "error"); return; } setExchangeFor(r); }}
                  style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.blue}`, background: G.blueBg, color: G.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>🔄 교환</button>
              )}
              {order && order.payment !== "환불신청" && order.payment !== "환불" && onRefundRequest && (
                <button onClick={() => {
                  const lock = lockOf(r);
                  if (lock) { showToast(lock, "error"); return; }
                  // 환불 기본값 = 반품된 품목 금액 합계 (부분 반품은 수량 비례 환산액)
                  const retSum = (r.items || []).reduce((s, it) => s + (parseInt(it.amount) || 0), 0);
                  onRefundRequest(order, retSum > 0 ? { initialAmount: retSum, initialReason: "반품 환불" } : {});
                }} style={{ flex: 1, padding: "9px", borderRadius: 8, border: `1px solid ${G.red}`, background: G.redBg, color: G.red, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S }}>💸 환불신청 연결</button>
              )}
            </>
          )}
        </div>
      </Card>
    );
  };

  return (
    <div>
      {/* ── 반품 등록 ── */}
      <SecTitle>반품 등록</SecTitle>
      {!regOrder ? (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 6 }}>출고완료된 주문을 검색해서 반품을 등록하세요</div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="고객명 · 주문번호 · 연락처 검색"
            style={{ ...baseInp, width: "100%", boxSizing: "border-box", background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
          {candidates.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
              {candidates.map(o => (
                <button key={o.id} onClick={() => startRegister(o)} style={{ textAlign: "left", padding: "9px 11px", borderRadius: 8, border: `1px solid ${G.border}`, background: G.surface, cursor: "pointer", fontFamily: S }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: G.cream }}>{o.customer}</span>
                  <span style={{ fontFamily: SF, fontSize: 10, color: G.copper, fontWeight: 700, marginLeft: 8 }}>#{String(o.id).slice(0, 8)}</span>
                  <span style={{ fontSize: 10, color: G.creamMuted, marginLeft: 8 }}>{o.date}</span>
                  <div style={{ fontSize: 11, color: G.creamMuted, marginTop: 2 }}>{(o.items || []).map(it => `${it.fabric || "?"} ${it.qty}${it.unit || "마"}`).join(", ")}</div>
                </button>
              ))}
            </div>
          )}
          {ql.length === 1 && <div style={{ fontSize: 11, color: G.creamMuted, marginTop: 8, textAlign: "center" }}>두 글자 이상 입력해 주세요</div>}
          {ql.length >= 2 && searching && <div style={{ fontSize: 11, color: G.creamMuted, marginTop: 8, textAlign: "center" }}>찾는 중…</div>}
          {ql.length >= 2 && !searching && candidates.length === 0 && <div style={{ fontSize: 11, color: G.creamMuted, marginTop: 8, textAlign: "center" }}>일치하는 출고완료 주문이 없습니다</div>}
        </Card>
      ) : (
        <Card style={{ marginBottom: 16, border: `1px solid ${G.copper}55` }}>
          <ReturnRegisterForm order={regOrder} activeManager={activeManager} showToast={showToast}
            onCancel={() => setRegOrder(null)}
            onCreated={(saved) => { if (saved) setReturns(p => [saved, ...p]); setRegOrder(null); }} />
        </Card>
      )}

      {/* ── 진행 중 반품 ── */}
      <SecTitle>진행 중 반품 ({active.length}건)</SecTitle>
      {active.length === 0
        ? <Empty text="진행 중인 반품이 없습니다" sub="위에서 출고완료 주문을 검색해 등록하세요" />
        : active.map(renderCard)}

      {/* ── 완료된 반품 ── */}
      {done.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ fontSize: 12, fontWeight: 700, color: G.creamMuted, cursor: "pointer", padding: "6px 0" }}>완료된 반품 {done.length}건 보기</summary>
          <div style={{ marginTop: 8 }}>{done.slice(0, 30).map(renderCard)}</div>
        </details>
      )}

      {/* 🔄 교환 모달 */}
      {exchangeFor && (() => {
        const origOrder = orderOf(exchangeFor.orderId);
        if (!origOrder) { return null; }
        return (
          <ExchangeModal
            ret={exchangeFor}
            order={origOrder}
            activeManager={activeManager}
            showToast={showToast}
            credits={credits}
            setCredits={setCredits}
            onClose={() => setExchangeFor(null)}
            onDone={(exItems, diff, newTotal, usedCredit) => {
              setReturns(p => p.map(x => x.id === exchangeFor.id ? { ...x, status: "완료", exchangeItems: exItems, exchangeDiff: diff, completedAt: new Date().toISOString() } : x));
              if (newTotal != null) setOrders?.(p => p.map(o => o.id === origOrder.id ? { ...o, totalAmount: newTotal } : o));
              if (diff > 0 && usedCredit) showToast(`교환 기록 저장 — 차액 ${diff.toLocaleString()}원 적립금으로 차감 완료`);
              else if (diff > 0) showToast(`교환 기록 저장 — 원 주문에 추가 결제 ${diff.toLocaleString()}원 반영(미수)`);
              else if (diff < 0) {
                showToast(`교환 기록 저장 — 차액 ${Math.abs(diff).toLocaleString()}원 환불신청으로 이동`);
                if (onRefundRequest && origOrder.payment !== "환불신청" && origOrder.payment !== "환불") onRefundRequest(origOrder, { initialAmount: Math.abs(diff), initialReason: "교환 차액 환불" });
              }
              else showToast("교환 기록 저장 완료 (차액 없음)");
            }}
          />
        );
      })()}
    </div>
  );
}
