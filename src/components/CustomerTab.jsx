import { useState } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./UI.jsx";
import { G, SF, S, baseInp, sC } from "../constants.js";
import * as db from "../lib/db.js";

function CustomerTab({customers, setCustomers, orders, exportCustomers, showToast, kakaoAlert, setConfirmDel, setEditingCust}) {
  const [form, setForm] = useState({name:"",phone:"",address:"",note:""});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);

  const add = async () => {
    if (!form.name.trim()) return;
    if (customers.find(c=>c.name===form.name)) { showToast("이미 등록된 고객명","error"); return; }
    try {
      const saved = await db.insertCustomer({...form, totalOrders:0, lastOrder:"—"});
      if (saved) setCustomers(p=>[...p, saved]);
      setForm({name:"",phone:"",address:"",note:""}); showToast("고객 등록 완료");
    } catch(e) { showToast("등록 실패","error"); }
  };

  const filtered = customers.filter(c=>c.name.includes(search)||(c.phone||"").includes(search));
  const custOrders = name => orders.filter(o=>o.customer===name);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontFamily:SF,fontSize:20,fontWeight:700}}>고객 관리</div>
        <GhostBtn onClick={exportCustomers} small>⬇ 엑셀</GhostBtn>
      </div>
      <div style={{marginBottom:12,position:"relative"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="고객명 / 연락처 검색" style={{...baseInp,paddingLeft:34}}/>
        <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:G.creamMuted,fontSize:13}}>🔍</span>
      </div>
      {selected && (
        <Card style={{marginBottom:12,border:`1px solid ${G.copper}40`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontFamily:SF,fontSize:16,fontWeight:700}}>{selected.name}</div>
            <div style={{display:"flex",gap:5}}>
              <button onClick={()=>setEditingCust({...selected})} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,cursor:"pointer",fontFamily:S}}>✏ 수정</button>
              <button onClick={()=>kakaoAlert(`[로하이마켓] ${selected.name} 고객님 메시지 테스트`)} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.yellow}`,background:G.yellowBg,color:G.yellow,cursor:"pointer",fontFamily:S}}>카톡</button>
              <button onClick={()=>{setConfirmDel({type:"customer",id:selected.id,label:selected.name});setSelected(null);}} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S}}>🗑</button>
              <button onClick={()=>setSelected(null)} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,cursor:"pointer",fontFamily:S}}>✕</button>
            </div>
          </div>
          <div style={{background:G.surface,borderRadius:10,overflow:"hidden",border:`1px solid ${G.border}`,marginBottom:12}}>
            {[{l:"연락처",v:selected.phone||"—"},{l:"배송지",v:selected.address||"—"},{l:"총주문",v:`${selected.totalOrders||0}건`},{l:"최근주문",v:selected.lastOrder||"—"}].map(({l,v},i)=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"9px 14px",borderTop:i>0?`1px solid ${G.border}`:"none",fontSize:13}}>
                <span style={{color:G.creamMuted}}>{l}</span>
                <span style={{fontWeight:500}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:G.copper,fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>주문 이력</div>
          {custOrders(selected.name).length===0
            ? <div style={{color:G.creamMuted,fontSize:12,textAlign:"center",padding:"8px 0"}}>주문 없음</div>
            : custOrders(selected.name).slice(0,4).map((o,i)=>(
              <div key={o.id} style={{display:"flex",gap:8,alignItems:"center",padding:"7px 0",borderTop:i>0?`1px solid ${G.border}`:"none",fontSize:12}}>
                <span style={{color:G.copper,fontWeight:700,fontSize:11}}>{o.id}</span>
                <span style={{color:G.creamMuted}}>{o.date}</span>
                <span style={{flex:1}}>{o.items.map(i=>`${i.fabric} ${i.qty}마`).join(", ")}</span>
                <Tag c={sC(o.status)[0]} bg={sC(o.status)[1]}>{o.status}</Tag>
              </div>
            ))
          }
        </Card>
      )}
      <div style={{marginBottom:12}}>
        {filtered.length===0
          ? <Empty text={search?"검색 결과 없음":"등록된 고객이 없습니다"} sub={search?"":"주문 등록 시 자동으로 추가됩니다"}/>
          : filtered.map(c=>(
            <div key={c.id} onClick={()=>setSelected(c)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",background:G.card,borderRadius:12,border:`1px solid ${selected?.id===c.id?G.copper+"60":G.border}`,marginBottom:6,cursor:"pointer"}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:G.copperGlow,border:`1px solid ${G.copper}40`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:SF,fontSize:14,fontWeight:700,color:G.copper,flexShrink:0}}>
                {c.name.slice(0,1)}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,marginBottom:2}}>{c.name}</div>
                <div style={{fontSize:11,color:G.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.phone||"연락처 없음"} · {c.address||"주소 없음"}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.copper}}>{c.totalOrders||0}</div>
                <div style={{fontSize:10,color:G.creamMuted}}>주문</div>
              </div>
            </div>
          ))
        }
      </div>
      <Card>
        <SecTitle>신규 고객 등록</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div><FLabel>고객명 *</FLabel><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={baseInp}/></div>
          <div><FLabel>연락처</FLabel><input value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} style={baseInp}/></div>
        </div>
        <div style={{marginBottom:8}}><FLabel>주소</FLabel><input value={form.address} onChange={e=>setForm(f=>({...f,address:e.target.value}))} style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>메모</FLabel><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} style={baseInp}/></div>
        <PrimaryBtn onClick={add} full>고객 등록</PrimaryBtn>
      </Card>
    </div>
  );
}


// ══════════════════════════════════════════
export default CustomerTab;
