import { useState } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal } from "./UI.jsx";
import { SF, S, baseInp, nowT, useTheme } from "../constants.js";
import * as db from "../lib/db.js";

function InoutForm({inv, setInv, logs, setLogs, showToast}) {
  const G = useTheme();
  const [f, setF] = useState({itemNo:"",fabric:"",color:"",qty:"",costPrice:"",supplier:"",note:""});

  const add = async () => {
    if (!f.fabric||!f.qty) return;
    const qty = parseFloat(f.qty)||0;
    const costPrice = parseFloat(f.costPrice)||0;
    const t = nowT();
    try {
      const noKey = f.itemNo?.toLowerCase();
      const ex = noKey
        ? inv.find(i=>(i.item_no||"").toLowerCase()===noKey) || inv.find(i=>i.fabric===f.fabric&&i.color===f.color)
        : inv.find(i=>i.fabric===f.fabric&&i.color===f.color);
      if (ex) {
        const label = ex.item_no ? ex.item_no.toUpperCase()+" " : "";
        if (!window.confirm(`이미 존재하는 원단입니다.\n\n${label}${ex.fabric} ${ex.color||""}\n현재 재고: ${ex.stock}마\n\n+${qty}마 추가하여 ${ex.stock+qty}마로 변경하시겠습니까?`)) return;
        const updates = { stock: ex.stock+qty };
        if (f.itemNo && !ex.item_no) updates.item_no = f.itemNo;
        if (costPrice > 0) updates.unit_price = costPrice;
        await db.updateInventoryItem(ex.id, updates);
        setInv(p=>p.map(i=>i.id===ex.id?{...i, stock:i.stock+qty, ...(f.itemNo&&!ex.item_no?{item_no:f.itemNo}:{})}:i));
      } else {
        const saved = await db.insertInventoryItem({ fabric:f.fabric, color:f.color, stock:qty, itemNo:f.itemNo||"", unitPrice:costPrice||0 });
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

export { InoutForm };
