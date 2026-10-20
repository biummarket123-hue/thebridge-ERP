// 합배송 묶기(MergeModal) + 운임비 조정(FreightModal) — 옛 src/components/MergeModal.jsx 를 새 UI 조각(Modal·row-check·Button)으로 옮긴 것.
// 후보 점수·정렬·그룹 id 재사용·운임비 계산 규칙은 src/saas/lib/orderRules.js(순수)에 있고, DB 쓰기는 actions/orders.js 가 한다.
import { useMemo, useState } from "react";
import { Modal } from "./Modal.jsx";
import { Button, StatusBadge, shortId, won } from "./ui.jsx";
import { rankMergeCandidates, mergeReasons, mergeHintOf } from "../lib/orderRules.js";

const itemsLabel = (o) => (o.items || []).map(i => `${i.fabric || "?"}${i.color ? ` ${i.color}` : ""} ${i.qty}${i.unit || "마"}`).join(", ") || "(품목 없음)";

/**
 * 합배송 묶기 — 같은 고객의 접수 상태 주문이 기본, "다른 고객이랑 묶기"로 전체(연관도순) 확장.
 * 시작 주문은 자동 선택·잠금. onConfirm(ids: 시작 주문을 뺀 선택 id 들) 이 실제로 묶는다(Promise 면 끝날 때까지 버튼 잠김).
 * sameCustomerOnly: 포장 담당자 — 같은 고객만.
 */
export function MergeModal({ sourceOrder, orders, customers, onConfirm, onClose, sameCustomerOnly = false }) {
  const [q, setQ] = useState("");
  const [showOthers, setShowOthers] = useState(false);
  const [selected, setSelected] = useState(() => new Set([sourceOrder.id]));
  const [busy, setBusy] = useState(false);
  const nickOf = (name) => (customers || []).find(c => c.name === name)?.nickname || "";

  const candidates = useMemo(() => rankMergeCandidates(sourceOrder, orders, { q, nickOf }), [orders, sourceOrder, q, customers]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = showOthers ? candidates : candidates.filter(({ o }) => sourceOrder.customer && o.customer === sourceOrder.customer);
  const toggle = (id) => { if (id === sourceOrder.id) return; setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const srcHint = mergeHintOf(sourceOrder);

  const submit = async () => {
    if (selected.size < 2) return;
    setBusy(true);
    try { await onConfirm?.([...selected].filter(id => id !== sourceOrder.id)); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="🔗 합배송 묶기" onClose={onClose} width="wide">
      <p className="helptext" style={{ margin: "0 0 12px" }}>
        {showOthers ? <>함께 묶을 접수 상태 주문을 고르세요. <b>같은 배송지 · 메모에 서로를 언급한 주문</b>이 위로 옵니다.</> : <>같은 고객(<b>{sourceOrder.customer}</b>)의 접수 상태 주문을 함께 묶습니다.</>}
        {" "}묶으면 출고예정일은 <b>가장 늦은 주문</b>에 맞춰지고(긴급 건 제외), 택배비는 한 건에만 남습니다.
      </p>
      <div className="od-source">
        <div className="badges"><StatusBadge tone="progress">현재 주문 (자동 포함)</StatusBadge><strong>{sourceOrder.customer}{nickOf(sourceOrder.customer) ? ` (${nickOf(sourceOrder.customer)})` : ""}</strong></div>
        <small><span className="mono">{shortId(sourceOrder.id)}</span> · {sourceOrder.date} · {itemsLabel(sourceOrder)}</small>
        {(sourceOrder.address || srcHint) && <small>{sourceOrder.address ? `📍 ${sourceOrder.address}${sourceOrder.addressDetail ? ` ${sourceOrder.addressDetail}` : ""}` : ""}{srcHint ? <span className="od-hint"> · 📝 {srcHint}</span> : null}</small>}
      </div>
      {showOthers && <input className="forminput" style={{ margin: "10px 0" }} value={q} onChange={e => setQ(e.target.value)} placeholder="고객명 · 닉네임 · 연락처 · 주소 · 원단으로 검색" />}
      {visible.length === 0 ? (
        <div className="notice-box" style={{ marginTop: 10, textAlign: "center" }}>{showOthers ? "함께 묶을 다른 접수 주문이 없습니다." : "같은 고객의 다른 접수 주문이 없습니다."}</div>
      ) : (
        <div className="od-candidates">
          {visible.map(({ o, s }) => {
            const on = selected.has(o.id);
            const r = mergeReasons(sourceOrder, o);
            const hint = mergeHintOf(o);
            return (
              <label key={o.id} className={`row-check${on ? " on" : ""}${s >= 60 ? " od-related" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(o.id)} />
                <span className="left">
                  <strong>{o.customer}{nickOf(o.customer) ? <span className="od-nick"> ({nickOf(o.customer)})</span> : null} <span className="mono od-id">{shortId(o.id)}</span> <span className="od-date">{o.date}</span></strong>
                  <span className="badges od-reasons">
                    {r.sameCust && <StatusBadge tone="done">같은 고객</StatusBadge>}
                    {r.sameAddr && <StatusBadge tone="done">📍 같은 배송지</StatusBadge>}
                    {r.mentioned && <StatusBadge tone="purple">📝 메모에 언급</StatusBadge>}
                    {r.combined && <StatusBadge tone="wait">📦 합배송</StatusBadge>}
                    {r.inGroup && <StatusBadge tone="purple">🔗 기존 그룹</StatusBadge>}
                  </span>
                  <small>{itemsLabel(o)}</small>
                  {(o.address || o.phone) && <small>{o.address ? `📍 ${o.address}${o.addressDetail ? ` ${o.addressDetail}` : ""}` : ""}{o.address && o.phone ? " · " : ""}{o.phone || ""}</small>}
                  {hint && <small className="od-hint">📝 {hint}</small>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {!showOthers && !sameCustomerOnly && <button className="text-link" style={{ marginTop: 8 }} onClick={() => setShowOthers(true)}>👥 다른 고객이랑 묶기</button>}
      <div className="btnrow" style={{ marginTop: 16 }}>
        <Button kind="white" onClick={onClose} disabled={busy}>취소</Button>
        <Button icon="layers" onClick={submit} loading={busy} disabled={selected.size < 2}>{selected.size}건 합배송 묶기</Button>
      </div>
    </Modal>
  );
}

/**
 * 운임비 조정 — 그룹 전체 운임비를 한 주문에만 부여, 나머지는 0원.
 * onConfirm({ bearerId, amount }) 가 실제로 쓴다(Promise 면 버튼 잠김).
 */
export function FreightModal({ targetOrder, groupOrders, onConfirm, onClose }) {
  const [amount, setAmount] = useState(String(targetOrder?.shippingFee || 0));
  const [bearer, setBearer] = useState(targetOrder?.id);
  const [busy, setBusy] = useState(false);
  const n = parseInt(String(amount).replace(/[^0-9]/g, ""), 10) || 0;
  const submit = async () => {
    setBusy(true);
    try { await onConfirm?.({ bearerId: bearer, amount: n }); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="💰 합배송 운임비 조정" onClose={onClose}>
      <p className="helptext" style={{ margin: "0 0 4px" }}>그룹 전체 운임비를 한 주문에 1건만 부여합니다. 나머지는 0원이 되고, 묶이면서 자동으로 내려놓았던 금액은 지워집니다(사람이 정한 값이 우선).</p>
      <label className="formlabel" htmlFor="od-freight">운임비 (원)</label>
      <input id="od-freight" className="forminput" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="3000" />
      <div className="section-label">운임비 부담 주문</div>
      <div className="od-candidates">
        {(groupOrders || []).map(o => (
          <label key={o.id} className={`row-check${bearer === o.id ? " on" : ""}`}>
            <input type="radio" name="od-bearer" checked={bearer === o.id} onChange={() => setBearer(o.id)} />
            <span className="left"><strong><span className="mono od-id">{shortId(o.id)}</span> · {o.customer}</strong><small>현재 {won(o.shippingFee)}{o.status === "출고완료" ? " · 출고완료" : ""}</small></span>
            <span className="od-fee-next">{bearer === o.id ? won(n) : "0원"}</span>
          </label>
        ))}
      </div>
      <div className="btnrow" style={{ marginTop: 16 }}>
        <Button kind="white" onClick={onClose} disabled={busy}>취소</Button>
        <Button icon="check" onClick={submit} loading={busy} disabled={!bearer}>{won(n)} 적용</Button>
      </div>
    </Modal>
  );
}
