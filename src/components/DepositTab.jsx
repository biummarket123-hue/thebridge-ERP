import { useState } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./UI.jsx";
import { G, SF, S } from "../constants.js";

function DepositTab({showToast, customers}) {
  const SF="'Noto Serif KR','Apple SD Gothic Neo',serif";
  const S="'Noto Sans KR','Apple SD Gothic Neo',sans-serif";
  const G={bg:"#0D0B09",surface:"#161410",card:"#1E1A16",border:"#2E2820",
    copper:"#C8794A",copperLight:"#E8956A",copperGlow:"rgba(200,121,74,0.15)",
    cream:"#F0E6D6",creamMuted:"#A89880",white:"#FFFFFF",
    green:"#5B9E72",greenBg:"rgba(91,158,114,0.12)",
    red:"#C05A4A",redBg:"rgba(192,90,74,0.12)",
    yellow:"#C4963A",yellowBg:"rgba(196,150,58,0.12)",
    blue:"#4A7EA8",blueBg:"rgba(74,126,168,0.12)",purple:"#8A6AB8"};
  const baseInp={width:"100%",padding:"10px 13px",borderRadius:10,
    border:`1px solid ${G.border}`,background:G.surface,
    fontFamily:S,fontSize:13,color:G.cream,outline:"none",boxSizing:"border-box"};

  const [sub, setSub] = useState("list"); // list | add | balance
  const [deposits, setDeposits] = useState(() => {
    try { const v=localStorage.getItem("bium:deposits"); return v?JSON.parse(v):[]; } catch{return [];}
  });
  const saveDeposits = (d) => {
    setDeposits(d);
    try { localStorage.setItem("bium:deposits", JSON.stringify(d)); } catch{}
  };

  const emptyForm = {customer:"",phone:"",content:"",total:"",deposit:"",depositDate:"",note:""};
  const [form, setForm] = useState(emptyForm);
  const [balForm, setBalForm] = useState({id:"",balanceDate:""});
  const [search, setSearch] = useState("");

  const residual = (d) => d.total - d.deposit;
  const totalUnpaid = deposits.filter(d=>!d.balancePaid).reduce((a,d)=>a+residual(d),0);
  const totalPaid = deposits.filter(d=>d.balancePaid).reduce((a,d)=>a+d.total,0);
  const filtered = deposits.filter(d=>
    !search || d.customer.includes(search) || d.content.includes(search)
  ).sort((a,b)=>b.id-a.id);

  const addDeposit = () => {
    if(!form.customer.trim()||!form.total||!form.deposit){
      showToast("고객명·총금액·계약금은 필수입니다","error"); return;
    }
    const total=parseInt(form.total.replace(/,/g,""))||0;
    const dep=parseInt(form.deposit.replace(/,/g,""))||0;
    if(dep>total){showToast("계약금이 총금액보다 클 수 없습니다","error");return;}
    const now=new Date().toLocaleDateString("ko-KR");
    const rec={id:Date.now(),customer:form.customer.trim(),phone:form.phone.trim(),
      content:form.content.trim(),total,deposit:dep,depositDate:form.depositDate||now,
      note:form.note,balancePaid:dep===total,balanceDate:dep===total?now:"",
      regDate:now};
    saveDeposits([rec,...deposits]);
    setForm(emptyForm);
    showToast("계약금 등록 완료!");
    setSub("list");
  };

  const payBalance = () => {
    if(!balForm.id){showToast("거래를 선택해주세요","error");return;}
    const now=new Date().toLocaleDateString("ko-KR");
    saveDeposits(deposits.map(d=>d.id===parseInt(balForm.id)?
      {...d,balancePaid:true,balanceDate:balForm.balanceDate||now}:d));
    setBalForm({id:"",balanceDate:""});
    showToast("잔금 완납 처리 완료!");
    setSub("list");
  };

  const deleteDeposit = (id) => {
    saveDeposits(deposits.filter(d=>d.id!==id));
    showToast("삭제 완료");
  };

  const subTabs=[{k:"list",l:"📋 현황"},{k:"add",l:"➕ 계약금 등록"},{k:"balance",l:"💳 잔금 처리"}];

  return (
    <div>
      <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:16,color:G.cream}}>계약금 · 잔금 관리</div>

      {/* KPI */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[
          {l:"총 계약",v:deposits.length+"건",c:G.copper},
          {l:"미납 잔금",v:(totalUnpaid/10000).toFixed(0)+"만원",c:totalUnpaid>0?G.red:G.creamMuted},
          {l:"완납 누계",v:(totalPaid/10000).toFixed(0)+"만원",c:G.green},
        ].map(s=>(
          <div key={s.l} style={{background:G.card,borderRadius:12,border:`1px solid ${G.border}`,padding:"12px 10px",textAlign:"center"}}>
            <div style={{fontWeight:900,fontSize:16,color:s.c,lineHeight:1}}>{s.v}</div>
            <div style={{fontSize:10,color:G.creamMuted,marginTop:4}}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* 서브탭 */}
      <div style={{display:"flex",gap:0,background:"rgba(255,255,255,.04)",borderRadius:10,padding:3,marginBottom:14}}>
        {subTabs.map(t=>(
          <button key={t.k} onClick={()=>setSub(t.k)} style={{
            flex:1,padding:"9px 4px",borderRadius:8,border:"none",cursor:"pointer",
            fontFamily:S,fontWeight:sub===t.k?800:500,fontSize:11,
            background:sub===t.k?G.copper:"transparent",
            color:sub===t.k?"#fff":G.creamMuted,transition:"all .15s"
          }}>{t.l}</button>
        ))}
      </div>

      {/* ── 현황 ── */}
      {sub==="list" && (
        <div>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="고객명·계약내용 검색" style={{...baseInp,marginBottom:10}}/>
          {filtered.length===0 && (
            <div style={{textAlign:"center",padding:"40px 0",color:"rgba(240,230,214,.3)",fontSize:14}}>
              등록된 계약이 없습니다
            </div>
          )}
          {filtered.map(d=>{
            const bal=residual(d);
            return (
              <div key={d.id} style={{background:G.card,borderRadius:12,border:`1px solid ${G.border}`,padding:14,marginBottom:9}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div>
                    <span style={{fontWeight:800,fontSize:15,color:G.cream}}>{d.customer}</span>
                    {d.phone&&<span style={{fontSize:10,color:G.creamMuted,marginLeft:6}}>·{d.phone}</span>}
                    <div style={{fontSize:11,color:G.creamMuted,marginTop:2}}>{d.regDate} 등록</div>
                  </div>
                  <span style={{padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:700,
                    color:d.balancePaid?G.green:G.red,
                    background:d.balancePaid?G.greenBg:G.redBg}}>
                    {d.balancePaid?"완납":"잔금미납"}
                  </span>
                </div>
                {d.content&&<div style={{fontSize:12,color:G.creamMuted,marginBottom:8,padding:"5px 8px",background:G.surface,borderRadius:6}}>{d.content}</div>}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:8}}>
                  {[
                    {l:"총금액",v:d.total.toLocaleString()+"원",c:G.copper},
                    {l:"계약금",v:d.deposit.toLocaleString()+"원",c:G.blue},
                    {l:"잔금",v:bal.toLocaleString()+"원",c:bal>0?G.red:G.green},
                  ].map(s=>(
                    <div key={s.l} style={{background:G.surface,borderRadius:8,padding:"8px 6px",textAlign:"center",border:`1px solid ${G.border}`}}>
                      <div style={{fontWeight:800,fontSize:13,color:s.c}}>{s.v}</div>
                      <div style={{fontSize:9,color:G.creamMuted,marginTop:2}}>{s.l}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:8}}>
                  계약금 입금: <b style={{color:G.cream}}>{d.depositDate}</b>
                  {d.balancePaid&&d.balanceDate&&<span style={{marginLeft:12}}>잔금 완납: <b style={{color:G.green}}>{d.balanceDate}</b></span>}
                </div>
                {!d.balancePaid&&(
                  <button onClick={()=>{setSub("balance");setBalForm({id:String(d.id),balanceDate:""});}}
                    style={{width:"100%",padding:10,borderRadius:9,border:`1px solid ${G.blue}`,
                      background:G.blueBg,color:G.blue,fontWeight:700,fontSize:13,
                      cursor:"pointer",fontFamily:S,marginBottom:6}}>
                    💳 잔금 완납 처리
                  </button>
                )}
                <button onClick={()=>deleteDeposit(d.id)}
                  style={{width:"100%",padding:8,borderRadius:9,border:`1px solid ${G.border}`,
                    background:"transparent",color:G.red,fontWeight:700,fontSize:12,
                    cursor:"pointer",fontFamily:S}}>
                  🗑 삭제
                </button>
                {d.note&&<div style={{fontSize:11,color:G.creamMuted,marginTop:6}}>💬 {d.note}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 계약금 등록 ── */}
      {sub==="add" && (
        <div style={{background:G.card,borderRadius:14,border:`1px solid ${G.border}`,padding:16}}>
          <div style={{fontSize:12,fontWeight:800,color:G.copper,marginBottom:14,letterSpacing:".06em"}}>계약금 등록</div>

          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>고객명 *</div>
            <input value={form.customer} onChange={e=>setForm({...form,customer:e.target.value})}
              placeholder="고객명 입력" style={baseInp}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>연락처 (뒤 4자리)</div>
            <input value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}
              placeholder="1234" style={baseInp}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>계약 내용</div>
            <input value={form.content} onChange={e=>setForm({...form,content:e.target.value})}
              placeholder="예) 린넨코튼 300마 대량주문" style={baseInp}/>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
            <div>
              <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>총금액 (원) *</div>
              <input value={form.total} onChange={e=>setForm({...form,total:e.target.value})}
                placeholder="500000" type="number" style={baseInp}/>
            </div>
            <div>
              <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>계약금 (원) *</div>
              <input value={form.deposit} onChange={e=>setForm({...form,deposit:e.target.value})}
                placeholder="100000" type="number" style={baseInp}/>
            </div>
          </div>

          {/* 자동 잔금 계산 표시 */}
          {form.total&&form.deposit&&(
            <div style={{padding:"10px 12px",background:G.surface,borderRadius:8,
              border:`1px solid ${G.border}`,marginBottom:10,
              display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
              {[
                {l:"총금액",v:(parseInt(form.total)||0).toLocaleString()+"원",c:G.copper},
                {l:"계약금",v:(parseInt(form.deposit)||0).toLocaleString()+"원",c:G.blue},
                {l:"잔금",v:Math.max(0,(parseInt(form.total)||0)-(parseInt(form.deposit)||0)).toLocaleString()+"원",
                  c:(parseInt(form.total)||0)===(parseInt(form.deposit)||0)?G.green:G.red},
              ].map(s=>(
                <div key={s.l}>
                  <div style={{fontWeight:900,fontSize:14,color:s.c}}>{s.v}</div>
                  <div style={{fontSize:9,color:G.creamMuted,marginTop:2}}>{s.l}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>계약금 입금일</div>
            <input value={form.depositDate} onChange={e=>setForm({...form,depositDate:e.target.value})}
              placeholder={new Date().toLocaleDateString("ko-KR")} style={baseInp}/>
          </div>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>메모</div>
            <input value={form.note} onChange={e=>setForm({...form,note:e.target.value})}
              placeholder="특이사항 메모" style={baseInp}/>
          </div>

          <button onClick={addDeposit} style={{
            width:"100%",padding:14,borderRadius:10,border:"none",
            background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
            color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:S,
            boxShadow:"0 4px 20px rgba(200,121,74,.4)"}}>
            💰 계약금 등록
          </button>
        </div>
      )}

      {/* ── 잔금 처리 ── */}
      {sub==="balance" && (
        <div style={{background:G.card,borderRadius:14,border:`1px solid ${G.border}`,padding:16}}>
          <div style={{fontSize:12,fontWeight:800,color:G.copper,marginBottom:14,letterSpacing:".06em"}}>잔금 완납 처리</div>

          {deposits.filter(d=>!d.balancePaid).length===0?(
            <div style={{textAlign:"center",padding:"30px 0",color:G.green,fontSize:14,fontWeight:700}}>
              🎉 미납 잔금이 없습니다!
            </div>
          ):(
            <>
              <div style={{marginBottom:10}}>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>미납 계약 선택 *</div>
                <select value={balForm.id} onChange={e=>setBalForm({...balForm,id:e.target.value})}
                  style={{...baseInp,appearance:"none"}}>
                  <option value="">-- 선택하세요 --</option>
                  {deposits.filter(d=>!d.balancePaid).map(d=>(
                    <option key={d.id} value={String(d.id)}>
                      {d.customer} | 잔금 {residual(d).toLocaleString()}원 | {d.content||d.depositDate}
                    </option>
                  ))}
                </select>
              </div>

              {balForm.id&&(()=>{
                const d=deposits.find(x=>x.id===parseInt(balForm.id));
                if(!d) return null;
                return (
                  <div style={{padding:"12px",background:G.surface,borderRadius:10,
                    border:`1px solid ${G.border}`,marginBottom:12}}>
                    <div style={{fontWeight:800,color:G.cream,marginBottom:6}}>{d.customer}</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                      <div style={{textAlign:"center"}}>
                        <div style={{fontSize:18,fontWeight:900,color:G.copper}}>{d.total.toLocaleString()}원</div>
                        <div style={{fontSize:10,color:G.creamMuted}}>총금액</div>
                      </div>
                      <div style={{textAlign:"center"}}>
                        <div style={{fontSize:18,fontWeight:900,color:G.red}}>{residual(d).toLocaleString()}원</div>
                        <div style={{fontSize:10,color:G.creamMuted}}>납부할 잔금</div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>잔금 입금일</div>
                <input value={balForm.balanceDate} onChange={e=>setBalForm({...balForm,balanceDate:e.target.value})}
                  placeholder={new Date().toLocaleDateString("ko-KR")} style={baseInp}/>
              </div>
              <button onClick={payBalance} style={{
                width:"100%",padding:14,borderRadius:10,border:"none",
                background:G.green,color:"#fff",fontWeight:800,fontSize:15,
                cursor:"pointer",fontFamily:S,boxShadow:"0 4px 20px rgba(91,158,114,.4)"}}>
                ✓ 잔금 완납 처리
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}


export default DepositTab;
