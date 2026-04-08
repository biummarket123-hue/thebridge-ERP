import { useState } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./UI.jsx";
import { G, SF, S, baseInp, nowT, sC } from "../constants.js";
import * as db from "../lib/db.js";

function InoutForm({inv, setInv, logs, setLogs, showToast}) {
  const [f, setF] = useState({itemNo:"",fabric:"",color:"",qty:"",costPrice:"",supplier:"",note:""});

  const add = async () => {
    if (!f.fabric||!f.qty) return;
    const qty = parseFloat(f.qty)||0;
    const costPrice = parseFloat(f.costPrice)||0;
    const t = nowT();
    try {
      const ex = inv.find(i=>i.fabric===f.fabric&&i.color===f.color);
      if (ex) {
        await db.updateInventoryItem(ex.id, { stock: ex.stock+qty });
        setInv(p=>p.map(i=>i.id===ex.id?{...i, stock:i.stock+qty}:i));
      } else {
        const saved = await db.insertInventoryItem({ fabric:f.fabric, color:f.color, stock:qty });
        if (saved) setInv(p=>[...p, saved]);
      }
      const log = await db.insertLog({...t, type:"입고", fabric:f.fabric, color:f.color, qty, itemNo:f.itemNo, costPrice, ref:f.itemNo?`No.${f.itemNo}`:"수동입고", note:[f.supplier,f.note].filter(Boolean).join(" | ")||"—"});
      if (log) setLogs(p=>[log,...p]);
      setF({itemNo:"",fabric:"",color:"",qty:"",costPrice:"",supplier:"",note:""});
      showToast("입고 등록 완료");
    } catch(e) { console.error("입고 저장 실패:", e); showToast("저장 실패","error"); }
  };

  const totalAmt = (parseFloat(f.qty)||0) * (parseFloat(f.costPrice)||0);

  return (
    <Card style={{marginBottom:12}}>
      <SecTitle>원단 입고 등록</SecTitle>

      {/* 아이템 No + 원단명 */}
      <div style={{display:"grid",gridTemplateColumns:"100px 1fr",gap:8,marginBottom:8}}>
        <div>
          <FLabel>아이템 No</FLabel>
          <input value={f.itemNo} onChange={e=>setF(p=>({...p,itemNo:e.target.value}))}
            placeholder="A-001" style={{...baseInp,fontFamily:"monospace",fontWeight:700,letterSpacing:"0.05em"}}/>
        </div>
        <div>
          <FLabel>원단명 *</FLabel>
          <input value={f.fabric} onChange={e=>setF(p=>({...p,fabric:e.target.value}))}
            placeholder="린넨코튼" style={baseInp}/>
        </div>
      </div>

      {/* 색상 + 공급처 */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <div>
          <FLabel>색상</FLabel>
          <input value={f.color} onChange={e=>setF(p=>({...p,color:e.target.value}))}
            placeholder="베이지" style={baseInp}/>
        </div>
        <div>
          <FLabel>공급처</FLabel>
          <input value={f.supplier} onChange={e=>setF(p=>({...p,supplier:e.target.value}))}
            placeholder="동대문 ○○" style={baseInp}/>
        </div>
      </div>

      {/* 수량 + 입고가 */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <div>
          <FLabel>수량 (마) *</FLabel>
          <input type="number" value={f.qty} onChange={e=>setF(p=>({...p,qty:e.target.value}))}
            placeholder="0" style={{...baseInp,fontFamily:SF,fontSize:15,fontWeight:700}}/>
        </div>
        <div>
          <FLabel>입고가 (원/마)</FLabel>
          <input type="number" value={f.costPrice} onChange={e=>setF(p=>({...p,costPrice:e.target.value}))}
            placeholder="0" style={{...baseInp,fontFamily:SF,fontSize:15,fontWeight:700}}/>
        </div>
      </div>

      {/* 총 입고금액 미리보기 */}
      {totalAmt > 0 && (
        <div style={{padding:"8px 14px",background:G.copperGlow,borderRadius:8,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:12,color:G.creamMuted}}>총 입고금액</span>
          <span style={{fontFamily:SF,fontSize:16,fontWeight:800,color:G.copper}}>{totalAmt.toLocaleString()}원</span>
        </div>
      )}

      {/* 메모 */}
      <div style={{marginBottom:12}}>
        <FLabel>메모</FLabel>
        <input value={f.note} onChange={e=>setF(p=>({...p,note:e.target.value}))}
          placeholder="비고사항" style={baseInp}/>
      </div>

      <button onClick={add} disabled={!f.fabric||!f.qty} style={{
        width:"100%", padding:"14px", borderRadius:10, border:"none",
        fontFamily:S, fontWeight:800, fontSize:15, cursor:!f.fabric||!f.qty?"not-allowed":"pointer",
        background:!f.fabric||!f.qty?G.border:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
        color:!f.fabric||!f.qty?G.creamMuted:G.white,
        boxShadow:!f.fabric||!f.qty?"none":`0 4px 20px ${G.copperGlow}`,
      }}>
        📥 입고 등록{f.itemNo?` (No.${f.itemNo})`:""}
      </button>
    </Card>
  );
}

// ════════════════ 자동출고 컴포넌트 ══════════════════════════
function AutoShipOut({orders, setOrders, inv, setInv, logs, setLogs, showToast, onShipDone}) {
  const [selOrders, setSelOrders] = useState([]);
  const pending = orders.filter(o=>o.status!=="출고완료");

  const doShipOut = async () => {
    if (selOrders.length===0) { showToast("출고할 주문을 선택하세요","error"); return; }
    const t = nowT();
    const newLogs = [];
    try {
      for (const oid of selOrders) {
        const order = orders.find(o=>o.id===oid);
        if (!order) continue;
        for (const item of (order.items||[])) {
          const invItem = inv.find(i=>i.fabric===item.fabric&&i.color===item.color);
          if (invItem) {
            const newStock = Math.max(0, invItem.stock - item.qty);
            await db.updateInventoryItem(invItem.id, { stock: newStock });
          }
          setInv(p=>p.map(i=>i.fabric===item.fabric&&i.color===item.color?{...i,stock:Math.max(0,i.stock-item.qty)}:i));
          const log = await db.insertLog({...t, type:"출고", fabric:item.fabric, color:item.color||"", qty:item.qty, ref:order.id, note:`판매출고 — ${order.customer}`});
          if (log) newLogs.push(log);
        }
        await db.updateOrder(oid, { status:"출고완료" });
        setOrders(p=>p.map(o=>o.id===oid?{...o,status:"출고완료"}:o));
      }
      setLogs(p=>[...newLogs,...p]);
      setSelOrders([]);
      showToast(`${selOrders.length}건 자동출고 완료`);
      if (onShipDone) onShipDone();
    } catch(e) { console.error("출고 실패:", e); showToast("출고 실패","error"); }
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontFamily:SF,fontSize:15,fontWeight:700}}>판매 자동 출고</div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button onClick={()=>setSelOrders(selOrders.length===pending.length?[]:pending.map(o=>o.id))} style={{fontSize:11,color:G.copper,background:"none",border:`1px solid ${G.copper}50`,borderRadius:6,padding:"4px 9px",cursor:"pointer",fontFamily:S,fontWeight:600}}>
            {selOrders.length===pending.length&&pending.length>0?"전체해제":"전체선택"}
          </button>
        </div>
      </div>

      {pending.length===0
        ? <Empty text="출고 대기 주문이 없습니다" sub="모든 주문이 출고완료 상태입니다"/>
        : <div style={{marginBottom:12}}>
            {pending.map(o=>{
              const sel = selOrders.includes(o.id);
              return (
                <div key={o.id} onClick={()=>setSelOrders(p=>sel?p.filter(x=>x!==o.id):[...p,o.id])}
                  style={{display:"flex",alignItems:"flex-start",gap:10,padding:"13px 14px",background:sel?`${G.copper}10`:G.card,borderRadius:10,border:`1.5px solid ${sel?G.copper:G.border}`,marginBottom:7,cursor:"pointer",transition:"all 0.15s"}}>
                  <input type="checkbox" checked={sel} onChange={()=>{}} style={{accentColor:G.copper,width:17,height:17,marginTop:2,flexShrink:0,cursor:"pointer"}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                      <span style={{fontSize:11,color:G.copper,fontWeight:700}}>{o.id}</span>
                      <span style={{fontWeight:800,fontSize:14}}>{o.customer}</span>
                      <Tag c={sC(o.status)[0]} bg={sC(o.status)[1]}>{o.status}</Tag>
                    </div>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {o.items.map((item,i)=>(
                        <span key={i} style={{fontSize:11,padding:"2px 8px",background:G.surface,borderRadius:6,border:`1px solid ${G.border}`,color:G.creamMuted}}>
                          {item.fabric}{item.color?" "+item.color:""} <b style={{color:G.cream}}>{item.qty}마</b>
                        </span>
                      ))}
                    </div>
                    <div style={{fontSize:10,color:G.creamMuted,marginTop:4}}>{o.date}</div>
                  </div>
                </div>
              );
            })}
          </div>
      }

      {selOrders.length>0 && (
        <div style={{position:"sticky",bottom:16}}>
          <button onClick={doShipOut} style={{width:"100%",padding:"14px",borderRadius:12,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:S,boxShadow:`0 6px 24px ${G.copperGlow}`}}>
            🔄 {selOrders.length}건 자동 출고 처리
          </button>
        </div>
      )}
    </div>
  );
}

export { InoutForm, AutoShipOut };
