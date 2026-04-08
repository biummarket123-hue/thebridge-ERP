import { useState } from "react";
import { G, SF, S, baseInp } from "../constants.js";

function Tag({c, bg, children}) {
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 9px",borderRadius:20,fontSize:11,fontWeight:700,fontFamily:S,color:c,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
}
function SecTitle({children}) {
  return <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.08em",marginBottom:12,textTransform:"uppercase"}}>{children}</div>;
}
function Card({children, style}) {
  return <div className="erp-card" style={{background:G.card,borderRadius:14,border:`1px solid ${G.border}`,padding:16,...style}}>{children}</div>;
}
function Empty({text, sub}) {
  return (
    <div style={{padding:"50px 0",textAlign:"center"}}>
      <div style={{fontSize:28,opacity:.2,marginBottom:10}}>◇</div>
      <div style={{fontSize:14,color:"rgba(240,230,214,0.4)",fontWeight:600}}>{text}</div>
      {sub && <div style={{fontSize:12,color:"rgba(240,230,214,0.2)",marginTop:5}}>{sub}</div>}
    </div>
  );
}
function Toast({msg, type}) {
  if (!msg) return null;
  return (
    <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",padding:"11px 20px",borderRadius:12,background:type==="error"?G.red:G.green,color:G.white,fontWeight:700,fontSize:13,zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.4)",fontFamily:S,whiteSpace:"nowrap"}}>
      {type==="error" ? "✕ " : "✓ "}{msg}
    </div>
  );
}
function PrimaryBtn({onClick, disabled, children, full}) {
  return (
    <button onClick={disabled ? undefined : onClick} style={{padding:"12px 20px",width:full?"100%":"auto",borderRadius:10,border:"none",background:disabled?G.border:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:disabled?G.creamMuted:G.white,fontWeight:700,fontSize:14,cursor:disabled?"not-allowed":"pointer",fontFamily:S,boxShadow:disabled?"none":`0 4px 20px ${G.copperGlow}`}}>
      {children}
    </button>
  );
}
function GhostBtn({onClick, children, small, color, full}) {
  return (
    <button onClick={onClick} style={{padding:small?"6px 11px":"11px 16px",width:full?"100%":"auto",borderRadius:small?7:10,border:`1px solid ${color||G.border}`,background:color?`${color}18`:"transparent",color:color||G.creamMuted,fontWeight:600,fontSize:small?11:13,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",boxSizing:"border-box"}}>
      {children}
    </button>
  );
}
function FLabel({children}) {
  return <div style={{fontSize:11,color:G.creamMuted,marginBottom:4}}>{children}</div>;
}

// ── Modals ───────────────────────────────────────────────────
function ConfirmModal({item, onConfirm, onCancel}) {
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{background:G.card,borderRadius:16,border:`1px solid ${G.red}50`,padding:24,width:"100%",maxWidth:320,textAlign:"center"}}>
        <div style={{fontSize:30,marginBottom:10}}>🗑</div>
        <div style={{fontFamily:SF,fontSize:16,fontWeight:700,marginBottom:8}}>삭제 확인</div>
        <div style={{fontSize:13,color:G.creamMuted,marginBottom:20,lineHeight:1.7}}>
          <b style={{color:G.cream}}>{item.label}</b><br/>삭제하시겠습니까?
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onConfirm} style={{flex:1,padding:"12px",borderRadius:10,border:"none",background:G.red,color:G.white,fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:S}}>삭제</button>
          <button onClick={onCancel} style={{flex:1,padding:"12px",borderRadius:10,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:14,cursor:"pointer",fontFamily:S}}>취소</button>
        </div>
      </div>
    </div>
  );
}

function EditOrderModal({order, onSave, onClose}) {
  const [o, setO] = useState({...order, items: order.items.map(i=>({...i}))});
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box",maxHeight:"85vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,marginBottom:16}}>주문 수정 — {o.id}</div>
        <div style={{marginBottom:10}}><FLabel>고객명</FLabel><input value={o.customer} onChange={e=>setO(p=>({...p,customer:e.target.value}))} style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>연락처</FLabel><input value={o.phone||""} onChange={e=>setO(p=>({...p,phone:e.target.value}))} style={baseInp}/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div>
            <FLabel>결제상태</FLabel>
            <select value={o.payment} onChange={e=>setO(p=>({...p,payment:e.target.value}))} style={{...baseInp,background:G.surface,color:G.cream}}>
              <option style={{background:G.surface}}>미입금</option>
              <option style={{background:G.surface}}>입금완료</option>
            </select>
          </div>
          <div>
            <FLabel>처리상태</FLabel>
            <select value={o.status} onChange={e=>setO(p=>({...p,status:e.target.value}))} style={{...baseInp,background:G.surface,color:G.cream}}>
              {["접수","준비중","출고완료"].map(s=><option key={s} style={{background:G.surface}}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{marginBottom:10}}><FLabel>배송지</FLabel><input value={o.address||""} onChange={e=>setO(p=>({...p,address:e.target.value}))} style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>메모</FLabel><input value={o.note||""} onChange={e=>setO(p=>({...p,note:e.target.value}))} placeholder="메모 입력" style={baseInp}/></div>
        <div style={{marginBottom:4}}>
          <FLabel>원단 항목</FLabel>
          {o.items.map((item,i)=>(
            <div key={i} style={{display:"flex",gap:5,marginBottom:6,alignItems:"center"}}>
              <input value={item.fabric} onChange={e=>setO(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,fabric:e.target.value}:x)}))} placeholder="원단" style={{...baseInp,flex:1}}/>
              <input value={item.color} onChange={e=>setO(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,color:e.target.value}:x)}))} placeholder="색상" style={{...baseInp,flex:1}}/>
              <input type="number" value={item.qty} onChange={e=>setO(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,qty:parseFloat(e.target.value)||0}:x)}))} placeholder="마" style={{...baseInp,width:54}}/>
              <button onClick={()=>setO(p=>({...p,items:p.items.filter((_,j)=>j!==i)}))} style={{padding:"0 8px",height:38,borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S,fontSize:14,flexShrink:0}}>✕</button>
            </div>
          ))}
          <button onClick={()=>setO(p=>({...p,items:[...p.items,{fabric:"",color:"",qty:0}]}))} style={{width:"100%",marginTop:2,padding:"8px",fontSize:12,color:G.copper,background:"transparent",border:`1px dashed ${G.copper}50`,borderRadius:8,cursor:"pointer",fontFamily:S}}>
            + 항목 추가
          </button>
        </div>
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <PrimaryBtn onClick={()=>onSave(o)} full>저장</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
    </div>
  );
}

function EditInvModal({item, onSave, onClose}) {
  const [it, setIt] = useState({...item});
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,marginBottom:16}}>재고 수정</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          <div><FLabel>원단명</FLabel><input value={it.fabric} onChange={e=>setIt(p=>({...p,fabric:e.target.value}))} style={baseInp}/></div>
          <div><FLabel>색상</FLabel><input value={it.color} onChange={e=>setIt(p=>({...p,color:e.target.value}))} style={baseInp}/></div>
        </div>
        <div style={{marginBottom:16}}><FLabel>재고 수량 (마)</FLabel><input type="number" value={it.stock} onChange={e=>setIt(p=>({...p,stock:parseFloat(e.target.value)||0}))} style={baseInp}/></div>
        <div style={{display:"flex",gap:8}}>
          <PrimaryBtn onClick={()=>onSave(it)} full>저장</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
    </div>
  );
}

function EditCustModal({cust, onSave, onClose}) {
  const [c, setC] = useState({...cust});
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,marginBottom:16}}>고객 정보 수정</div>
        {[{k:"name",l:"고객명"},{k:"phone",l:"연락처"},{k:"address",l:"주소"},{k:"note",l:"메모"}].map(({k,l})=>(
          <div key={k} style={{marginBottom:10}}><FLabel>{l}</FLabel><input value={c[k]||""} onChange={e=>setC(p=>({...p,[k]:e.target.value}))} style={baseInp}/></div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <PrimaryBtn onClick={()=>onSave(c)} full>저장</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
    </div>
  );
}

function ShippingModal({orders, customers, settings, onExport, onClose, preSelected}) {
  const [courier, setCourier] = useState("CJ대한통운");
  const eligible = orders.filter(o=>o.address);
  const allIds = orders.map(o=>o.id);
  const [sel, setSel] = useState(preSelected || eligible.map(o=>o.id));
  const hasAddr = sel.filter(id=>orders.find(o=>o.id===id&&o.address));
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,marginBottom:4}}>🚚 택배 송장 출력</div>
        <div style={{fontSize:12,color:G.creamMuted,marginBottom:16}}>{preSelected?`선택된 ${preSelected.length}건 주문을 출력합니다`:"배송지가 입력된 주문을 택배사 양식으로 출력합니다"}</div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,color:G.creamMuted,marginBottom:10}}>택배사 선택</div>
          <div style={{display:"flex",gap:10}}>
            {[
                {id:"CJ대한통운", icon:"📦", desc:"일반 택배"},
                {id:"경동화물", icon:"🚛", desc:"화물 운송"},
              ].map(c=>(
              <button key={c.id} onClick={()=>setCourier(c.id)} style={{
                flex:1, padding:"14px 8px", borderRadius:12,
                border:`2px solid ${courier===c.id?G.copper:G.border}`,
                background:courier===c.id?G.copperGlow:"transparent",
                color:courier===c.id?G.copper:G.creamMuted,
                cursor:"pointer", fontFamily:S,
                display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                transition:"all 0.15s",
              }}>
                <span style={{fontSize:24}}>{c.icon}</span>
                <span style={{fontSize:13,fontWeight:courier===c.id?800:600}}>{c.id}</span>
                <span style={{fontSize:10,opacity:0.7}}>{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:11,color:G.creamMuted}}>주문 선택 ({eligible.length}건)</div>
            <button onClick={()=>setSel(sel.length===eligible.length?[]:eligible.map(o=>o.id))} style={{fontSize:11,color:G.copper,background:"none",border:"none",cursor:"pointer",fontFamily:S,fontWeight:600}}>
              {sel.length===eligible.length?"전체 해제":"전체 선택"}
            </button>
          </div>
          <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:5}}>
            {orders.length===0
              ? <div style={{padding:"16px 0",textAlign:"center",color:G.creamMuted,fontSize:13}}>주문이 없습니다</div>
              : orders.map(o=>(
                <label key={o.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:G.surface,borderRadius:8,border:`1px solid ${sel.includes(o.id)?G.copper:G.border}`,cursor:"pointer",opacity:!o.address?0.6:1}}>
                  <input type="checkbox" checked={sel.includes(o.id)} onChange={e=>setSel(p=>e.target.checked?[...p,o.id]:p.filter(x=>x!==o.id))} style={{accentColor:G.copper,width:15,height:15}}/>
                  <span style={{fontWeight:700,fontSize:13,minWidth:60}}>{o.customer}</span>
                  <span style={{fontSize:11,color:o.address?G.creamMuted:G.red,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.address||"배송지 없음"}</span>
                  <span style={{fontSize:11,color:G.copper,fontWeight:700,flexShrink:0}}>{o.id}</span>
                </label>
              ))
            }
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <PrimaryBtn onClick={()=>onExport(sel,courier)} full>🚚 {sel.length}건 송장 출력</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
    </div>
  );
}


// ── Light theme ──────────────────────────────────────────────
const GL = {
  bg:"#F5F0E8", surface:"#FDFAF4", card:"#FFFFFF",
  border:"#DDD5C4", copper:"#C4603A", copperLight:"#E8856A",
  copperGlow:"rgba(196,96,58,0.12)", cream:"#1A1612", creamMuted:"#6B5E52",
  white:"#1A1612", green:"#3D7A52", greenBg:"rgba(61,122,82,0.1)",
  red:"#C0392B", redBg:"rgba(192,57,43,0.08)", yellow:"#B8940A",
  yellowBg:"rgba(184,148,10,0.1)", blue:"#2C5F8A", blueBg:"rgba(44,95,138,0.08)",
  purple:"#6A4B9A",
};
export { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal };
