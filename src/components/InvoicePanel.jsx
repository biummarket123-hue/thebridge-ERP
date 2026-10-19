import { useState } from "react";
import { PrimaryBtn, GhostBtn } from "./UI.jsx";
import { SF, S, useTheme } from "../constants.js";
import { CJ, KD, COURIER_SHORT } from "../lib/courier.js";
import { PickupTag } from "./Courier.jsx";

// 택배 송장 출력 — 택배사를 고르면 그 택배사로 나갈 주문만 보인다.
//
// 예전에는 주문을 전부 늘어놓고 사람이 하나씩 골라 택배사를 정했다. 택배사는 주문을
// 받을 때 이미 정해져 있으므로(lib/courier.js) 여기서 다시 판단할 이유가 없고,
// 다시 판단하다 보면 경동 박스를 CJ 송장으로 뽑는 실수가 난다.
//
// 출고완료는 여기서 하지 않는다. 송장을 뽑는 사람은 박스를 보지 않는다 — 실제로 나갔는지는
// 기사에게 건네는 포장팀이 안다(포장 화면의 완료 칸). 예전의 "송장 + 출고"는 송장을 뽑는
// 순간 장부에서 먼저 내보내서, 수거를 놓친 박스가 출고완료로 남았다.
//
// 같은 판을 두 곳에서 쓴다: 관리자의 송장출력 탭(늘 펼쳐져 있다)과 주문현황에서 여는 창.

const SHIPPABLE = ["입금완료", "부분환불", "환불완료"];
const payOf = (o) => o._computed?.paymentStatus || o.payment || "미입금";
const fmtAt = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
};

/**
 * @param orders       대상 주문(진행 중인 것)
 * @param preSelected  주문현황에서 골라 온 주문 id. 없으면 기본 선택을 쓴다
 * @param onExport     (ids, courier) => Promise — 엑셀을 내려받고 출력 표시를 남긴다
 * @param onSetCourier (order, courier) => Promise — 택배사를 옮긴다(박스 전체)
 * @param onClose      창으로 쓸 때만 — 닫기 버튼이 생긴다
 */
export function InvoicePanel({ orders, preSelected, courierById, onExport, onSetCourier, onClose }) {
  const G = useTheme();
  const infoOf = (o) => courierById?.get(o.id) || { courier: CJ, why: "default", pickup: false };
  const courierOfOrder = (o) => infoOf(o).courier;
  // 고른 주문이 있으면 그중 많은 쪽 택배사로 연다 — 경동 주문을 골라 놓고 열었는데
  // CJ 칸이 떠 있으면 목록이 비어 보인다.
  const [courier, setCourier] = useState(() => {
    if (!preSelected?.length) return CJ;
    const n = { [CJ]: 0, [KD]: 0 };
    for (const o of orders) if (preSelected.includes(o.id)) n[courierOfOrder(o)]++;
    return n[KD] > n[CJ] ? KD : CJ;
  });
  // 택배사마다 따로 고른다. null 이면 아직 손대지 않은 것 — 아래 기본값을 쓴다.
  const [picked, setPicked] = useState({ [CJ]: null, [KD]: null });
  const [busy, setBusy] = useState(null);

  const all = orders.filter(o => courierOfOrder(o) === courier);
  // 아직 안 뽑은 것을 위로. 뽑을 게 남았는지가 목록 맨 위에서 보여야 한다.
  const list = [...all].sort((a, b) => (a.invoicePrintedAt ? 1 : 0) - (b.invoicePrintedAt ? 1 : 0));

  // 기본 선택 — 직접 고른 게 있으면 그것. 없으면 "지금 송장을 뽑아야 하는 주문":
  //   · 배송지가 있고
  //   · 입금이 끝났고 (돈이 안 들어온 주문은 어차피 못 나간다)
  //   · 아직 송장을 안 뽑았고 (넣으면 추가 출력할 때마다 앞서 뽑은 송장이 또 나온다)
  //   · 방문·픽업이 아닌 것 (택배로 안 나간다)
  const isDue = (o) => !!o.address && SHIPPABLE.includes(payOf(o)) && !o.invoicePrintedAt && !infoOf(o).pickup;
  const defaults = preSelected?.length
    ? list.filter(o => preSelected.includes(o.id)).map(o => o.id)
    : list.filter(isDue).map(o => o.id);
  const sel = (picked[courier] ?? defaults).filter(id => list.some(o => o.id === id));
  const setSel = (next) => setPicked(p => ({ ...p, [courier]: typeof next === "function" ? next(sel) : next }));

  const dueOf = (c) => orders.filter(o => courierOfOrder(o) === c && isDue(o)).length;
  const other = courier === CJ ? KD : CJ;
  const others = preSelected?.length
    ? orders.filter(o => preSelected.includes(o.id) && courierOfOrder(o) !== courier).length : 0;
  const skipped = preSelected?.length ? null : {
    unpaid: list.filter(o => o.address && !o.invoicePrintedAt && !infoOf(o).pickup && !SHIPPABLE.includes(payOf(o))).length,
    pickup: list.filter(o => infoOf(o).pickup).length,
    noAddr: list.filter(o => !o.address && !o.invoicePrintedAt && !infoOf(o).pickup).length,
  };

  // 분리 배송(splitShipping=true) 주문은 그룹 무시하고 각각 1장. 그 외는 묶음당 1장.
  const splitCount = sel.reduce((n, id) => n + (orders.find(x => x.id === id)?.splitShipping ? 1 : 0), 0);
  const invoiceCount = (() => {
    const groups = new Set();
    let count = 0;
    for (const id of sel) {
      const o = orders.find(x => x.id === id);
      if (!o) continue;
      if (!o.mergeGroupId || o.splitShipping) { count++; continue; }
      if (groups.has(o.mergeGroupId)) continue;
      groups.add(o.mergeGroupId);
      count++;
    }
    return count;
  })();

  const move = async (o) => {
    setBusy(o.id);
    try { await onSetCourier?.(o, other); } finally { setBusy(null); }
  };
  const print = async () => {
    if (sel.length === 0 || busy) return;
    setBusy("print");
    try {
      await onExport?.(sel, courier);
      // 고른 것을 비운다 — 방금 뽑은 주문은 '출력됨'이 되어 기본 선택에서 빠진다.
      setPicked(p => ({ ...p, [courier]: null }));
    } finally { setBusy(null); }
  };

  return (
    <div>
      <div style={{display:"flex",gap:10,marginBottom:10}}>
        {[
          { id: CJ, icon: "📦", desc: "소량 · 봉지 포장" },
          { id: KD, icon: "🚛", desc: "롤 단위 · 대량" },
        ].map(c => {
          const on = courier === c.id;
          const n = dueOf(c.id);
          return (
            <button key={c.id} onClick={() => setCourier(c.id)} aria-pressed={on} style={{
              flex:1, padding:"12px 8px", borderRadius:12,
              border:`2px solid ${on ? G.copper : G.border}`,
              background: on ? G.copperGlow : "transparent",
              color: on ? G.copper : G.creamMuted,
              cursor:"pointer", fontFamily:S,
              display:"flex", flexDirection:"column", alignItems:"center", gap:3,
            }}>
              <span style={{fontSize:22}}>{c.icon}</span>
              <span style={{fontSize:13,fontWeight:on?800:600}}>{c.id}</span>
              <span style={{fontSize:11,fontWeight:800,color:n>0?G.red:G.creamMuted}}>뽑을 송장 <b style={{fontFamily:SF,fontSize:14}}>{n}</b>건</span>
              <span style={{fontSize:10,color:G.creamMuted}}>{c.desc}</span>
            </button>
          );
        })}
      </div>
      {others > 0 && (
        <div style={{fontSize:11,color:G.copper,fontWeight:700,marginBottom:8}}>
          고른 주문 중 {others}건은 {COURIER_SHORT[other]}입니다 — {COURIER_SHORT[other]} 칸에서 따로 뽑아 주세요
        </div>
      )}
      {skipped && (skipped.unpaid + skipped.pickup + skipped.noAddr > 0) && (
        <div style={{fontSize:11,color:G.creamMuted,marginBottom:8,lineHeight:1.6}}>
          선택에서 뺀 주문 —
          {skipped.unpaid > 0 && <> 입금 확인 전 <b style={{color:G.cream}}>{skipped.unpaid}건</b></>}
          {skipped.pickup > 0 && <> · 방문·픽업 <b style={{color:G.cream}}>{skipped.pickup}건</b></>}
          {skipped.noAddr > 0 && <> · 배송지 없음 <b style={{color:G.red}}>{skipped.noAddr}건</b></>}
          <span> · 필요하면 직접 체크하세요</span>
        </div>
      )}

      <div style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
          <div style={{fontSize:11,color:G.creamMuted}}>{COURIER_SHORT[courier]} 주문 {list.length}건 · 선택 {sel.length}건</div>
          <button onClick={() => setSel(sel.length === list.length ? [] : list.map(o => o.id))} style={{fontSize:11,color:G.copper,background:"none",border:"none",cursor:"pointer",fontFamily:S,fontWeight:600}}>
            {sel.length === list.length && list.length > 0 ? "전체 해제" : "전체 선택"}
          </button>
        </div>
        <div style={{maxHeight: onClose ? 260 : "none", overflowY: onClose ? "auto" : "visible", display:"flex",flexDirection:"column",gap:5}}>
          {list.length === 0
            ? <div style={{padding:"16px 0",textAlign:"center",color:G.creamMuted,fontSize:13}}>{COURIER_SHORT[courier]}로 나갈 주문이 없습니다</div>
            : list.map(o => {
              const on = sel.includes(o.id);
              const pay = payOf(o);
              const info = infoOf(o);
              return (
                <div key={o.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:G.subtleBg,borderRadius:8,
                  border:`1px solid ${on ? G.copper : G.border}`,opacity:(!o.address || o.invoicePrintedAt) && !on ? 0.6 : 1}}>
                  <label style={{display:"flex",alignItems:"center",gap:9,flex:1,minWidth:0,cursor:"pointer"}}>
                    <input type="checkbox" checked={on} onChange={e => setSel(p => e.target.checked ? [...p, o.id] : p.filter(x => x !== o.id))}
                      style={{accentColor:G.copper,width:16,height:16,flex:"none"}}/>
                    <span style={{flex:1,minWidth:0}}>
                      <span style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span style={{fontWeight:700,fontSize:13,color:G.cream}}>{o.customer}</span>
                        {o.mergeGroupId && !o.splitShipping && <span style={{fontSize:10,fontWeight:700,color:G.purple}}>합배송</span>}
                        <span style={{fontSize:10,fontWeight:700,color:o.status==="포장완료"?G.green:G.creamMuted}}>{o.status==="포장완료"?"✅ 포장완료":"미포장"}</span>
                        {!SHIPPABLE.includes(pay) && <span style={{fontSize:10,fontWeight:800,color:G.red}}>{pay}</span>}
                        {o.invoicePrintedAt && <span style={{fontSize:10,fontWeight:700,color:G.copper}}>출력됨 {fmtAt(o.invoicePrintedAt)}</span>}
                        {info.pickup && <PickupTag/>}
                        {info.why === "manual" && <span style={{fontSize:10,color:G.creamMuted}}>직접 지정</span>}
                        {info.why === "roll" && <span style={{fontSize:10,color:G.creamMuted}}>메모에 롤</span>}
                      </span>
                      <span style={{display:"block",fontSize:11,color:o.address?G.creamMuted:G.red,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.address||"배송지 없음"}</span>
                    </span>
                  </label>
                  {/* 등록할 때 택배사를 잘못 넣었거나 빠뜨린 주문 — 여기서 바로 옮긴다 */}
                  <button onClick={() => move(o)} disabled={!!busy} title={`${COURIER_SHORT[other]}로 나갈 주문이면 옮깁니다`}
                    style={{flex:"none",padding:"5px 8px",borderRadius:7,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,
                      fontSize:10.5,fontWeight:700,cursor:busy?"wait":"pointer",fontFamily:S,whiteSpace:"nowrap"}}>
                    {busy === o.id ? "…" : `→ ${COURIER_SHORT[other]}`}
                  </button>
                </div>
              );
            })}
        </div>
      </div>

      {/* 안내: 합배송/분리 배송은 주문별 설정값을 자동 적용 */}
      {(invoiceCount !== sel.length || splitCount > 0) && (
        <div style={{padding:"9px 12px",marginBottom:12,borderRadius:10,background:G.subtleBg||G.card,border:`1px solid ${G.border}`,fontSize:11,color:G.creamMuted,lineHeight:1.5}}>
          선택 <b style={{color:G.cream}}>{sel.length}건</b> → 송장 <b style={{color:G.copper}}>{invoiceCount}장</b>
          <span style={{color:G.creamMuted}}> (합배송 묶음 자동 적용{splitCount>0?`, 분리 배송 ${splitCount}건 별도`:""})</span>
        </div>
      )}
      <div style={{display:"flex",gap:8,position: onClose ? "static" : "sticky", bottom: onClose ? undefined : 12}}>
        <PrimaryBtn onClick={print} disabled={sel.length === 0 || !!busy} full>
          {busy === "print" ? "출력 중…" : `🚚 ${COURIER_SHORT[courier]} 송장 ${invoiceCount}장 출력`}
        </PrimaryBtn>
        {onClose && <GhostBtn onClick={onClose}>닫기</GhostBtn>}
      </div>
      <div style={{fontSize:10.5,color:G.creamMuted,marginTop:8,lineHeight:1.55}}>
        출고완료는 여기서 하지 않습니다 — 기사에게 건넨 뒤 포장팀이 포장 화면의 <b style={{color:G.cream}}>완료</b> 칸에서 넘깁니다
      </div>
    </div>
  );
}

/** 주문현황에서 여는 창 — 같은 판을 아래에서 올라오는 창에 담는다. */
export function ShippingModal({ onClose, ...rest }) {
  const G = useTheme();
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,boxShadow:"0 -8px 30px rgba(0,0,0,0.12)",padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box",maxHeight:"calc(100% - 20px)",overflowY:"auto",overscrollBehavior:"contain"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,color:G.cream,marginBottom:4}}>🚚 택배 송장 출력</div>
        <div style={{fontSize:12,color:G.creamMuted,marginBottom:16}}>택배사를 고르면 그 택배사로 나갈 주문만 보입니다</div>
        <InvoicePanel onClose={onClose} {...rest}/>
      </div>
    </div>
  );
}
