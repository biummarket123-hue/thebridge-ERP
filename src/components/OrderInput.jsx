import { useState } from "react";
import * as XLSX from "xlsx-js-style";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./UI.jsx";
import { G, SF, S, baseInp, aiParseText, uid, nowT, pC } from "../constants.js";
import * as db from "../lib/db.js";

function OrderInput({inv, setInv, orders, setOrders, logs, setLogs, customers, setCustomers, setTab, showToast, kakaoAlert, managers, setManagers, activeManager, setActiveManager}) {
  const [newManager, setNewManager] = useState("");
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [txt, setTxt] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState("");

  const parse = async () => {
    if (!txt.trim()) return;
    setParsing(true); setParsed(null); setErr("");
    try { setParsed(await aiParseText(txt)); }
    catch(e) { setErr(e.message || "분석 실패. 다시 시도해주세요."); }
    finally { setParsing(false); }
  };

  const confirm = async () => {
    if (!parsed) return;
    const t = nowT();

    try {
      // 주문 저장 (id는 Supabase가 자동생성)
      const saved = await db.insertOrder({...t, customer:parsed.customer||"미확인", phone:parsed.phone, items:parsed.items||[], payment:parsed.payment||"미입금", address:parsed.address, addressDetail:parsed.address_detail, links:parsed.links||[], note:parsed.note, status:"접수", manager:activeManager||""});
      setOrders(p=>[saved,...p]);

      // 고객 등록/업데이트
      if (parsed.customer) {
        const ex = customers.find(c=>c.name===parsed.customer);
        if (ex) {
          const updated = await db.updateCustomer(ex.id, {...ex, totalOrders:(ex.totalOrders||0)+1, lastOrder:t.date, phone:parsed.phone||ex.phone, address:parsed.address||ex.address});
          if (updated) setCustomers(p=>p.map(c=>c.id===ex.id?updated:c));
        } else {
          const newCust = await db.insertCustomer({name:parsed.customer, phone:parsed.phone||"", address:parsed.address||"", totalOrders:1, lastOrder:t.date, note:""});
          if (newCust) setCustomers(p=>[...p, newCust]);
        }
      }

      kakaoAlert(`📋 새 주문\n${saved.id} — ${saved.customer}\n${(parsed.items||[]).map(i=>`${i.fabric} ${i.color} ${i.qty}마`).join(", ")}`);
      setParsed(null); setTxt(""); setTab(1); showToast("주문 등록 완료");
    } catch(e) {
      console.error("주문 저장 실패:", e);
      showToast("저장 실패: " + e.message, "error");
    }
  };

  const addManager = async () => {
    if (!newManager.trim() || managers.includes(newManager.trim())) return;
    try {
      await db.addManager(newManager.trim());
      setManagers(p=>[...p, newManager.trim()]);
      setNewManager("");
      showToast("담당자 등록 완료");
    } catch(e) { showToast("등록 실패","error"); }
  };

  return (
    <div>
      <div style={{marginBottom:16}}>
        <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:4}}>주문 접수</div>
        <div style={{fontSize:12,color:G.creamMuted}}>카카오톡 주문 메시지를 그대로 붙여넣으세요</div>
      </div>

      {/* ── 담당자 선택 ─────────────────── */}
      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700,color:G.cream}}>담당자 선택</div>
          <button onClick={()=>setShowManagerForm(s=>!s)} style={{fontSize:11,color:G.copper,background:"none",border:`1px solid ${G.copper}50`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:S,fontWeight:600}}>
            {showManagerForm?"✕ 닫기":"+ 등록"}
          </button>
        </div>

        {/* 담당자 버튼 목록 */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:showManagerForm?12:0}}>
          <button
            onClick={()=>setActiveManager("")}
            style={{padding:"7px 14px",borderRadius:20,border:`1.5px solid ${!activeManager?G.copper:G.border}`,background:!activeManager?G.copperGlow:"transparent",color:!activeManager?G.copper:G.creamMuted,fontSize:12,fontWeight:!activeManager?800:500,cursor:"pointer",fontFamily:S,transition:"all 0.15s"}}>
            전체
          </button>
          {managers.map(m=>(
            <button key={m}
              onClick={()=>setActiveManager(activeManager===m?"":m)}
              style={{padding:"7px 14px",borderRadius:20,border:`1.5px solid ${activeManager===m?G.copper:G.border}`,background:activeManager===m?G.copperGlow:"transparent",color:activeManager===m?G.copper:G.creamMuted,fontSize:12,fontWeight:activeManager===m?800:500,cursor:"pointer",fontFamily:S,transition:"all 0.15s",display:"flex",alignItems:"center",gap:5}}>
              {m}
              {activeManager===m && <span style={{fontSize:10,background:G.copper,color:G.white,borderRadius:"50%",width:14,height:14,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>✓</span>}
            </button>
          ))}
        </div>

        {/* 담당자 등록 폼 */}
        {showManagerForm && (
          <div style={{paddingTop:10,borderTop:`1px solid ${G.border}`}}>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:6,fontWeight:600}}>새 담당자 등록</div>
            <div style={{display:"flex",gap:6}}>
              <input
                value={newManager} onChange={e=>setNewManager(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&addManager()}
                placeholder="담당자 이름 입력"
                style={{...baseInp,flex:1,fontSize:13}}
              />
              <button onClick={addManager} disabled={!newManager.trim()} style={{
                padding:"10px 16px",borderRadius:10,border:"none",fontFamily:S,fontWeight:700,fontSize:13,
                background:newManager.trim()?`linear-gradient(135deg,${G.copper},${G.copperLight})`:G.border,
                color:newManager.trim()?G.white:G.creamMuted,
                cursor:newManager.trim()?"pointer":"not-allowed",whiteSpace:"nowrap",
              }}>등록</button>
            </div>
            {/* 담당자 삭제 */}
            {managers.length > 0 && (
              <div style={{marginTop:10}}>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:6}}>등록된 담당자 (탭하여 삭제)</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {managers.map(m=>(
                    <button key={m} onClick={async()=>{try{await db.removeManager(m);}catch{}setManagers(p=>p.filter(x=>x!==m));if(activeManager===m)setActiveManager("");}}
                      style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:11,cursor:"pointer",fontFamily:S,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>
                      {m} <span style={{fontSize:10}}>✕</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 선택된 담당자 표시 */}
        {activeManager && (
          <div style={{marginTop:showManagerForm?8:0,padding:"6px 12px",background:`${G.copper}15`,borderRadius:8,fontSize:12,color:G.copper,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
            <span>✓</span> <span>{activeManager}</span> 담당으로 주문 등록됩니다
          </div>
        )}
      </Card>

      <Card style={{marginBottom:14}}>
        <textarea
          value={txt} onChange={e=>setTxt(e.target.value)}
          placeholder={"홍길동\n린넨 베이지 3마\n면 화이트 5마\n실크 네이비 2마\n\n입금완료\n배송지: 서울 중구 을지로 100"}
          style={{...baseInp, height:180, resize:"none", lineHeight:2.0,
            background:"transparent", border:`1px solid ${G.border}`, borderRadius:10,
            fontSize:14
          }}
        />
        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={parse} disabled={parsing||!txt.trim()} style={{
            flex:1, padding:"14px", borderRadius:10, border:"none", fontFamily:S,
            fontWeight:800, fontSize:15, letterSpacing:"-0.3px",
            cursor:parsing||!txt.trim()?"not-allowed":"pointer",
            background:parsing||!txt.trim()?G.border:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
            color:parsing||!txt.trim()?G.creamMuted:G.white,
            boxShadow:parsing||!txt.trim()?"none":`0 4px 24px ${G.copperGlow}`,
          }}>
            {parsing ? "⏳  AI 분석 중..." : "✦  AI 주문 분석"}
          </button>
          <button onClick={()=>{setTxt("");setParsed(null);setErr("");}} style={{
            padding:"14px 16px", borderRadius:10, border:`1.5px solid ${G.border}`,
            background:"transparent", color:G.creamMuted, fontFamily:S, fontSize:13, cursor:"pointer",
          }}>초기화</button>
        </div>
        {err && <div style={{color:G.red,fontSize:12,marginTop:10,padding:"8px 12px",background:G.redBg,borderRadius:8}}>{err}</div>}
      </Card>

      {parsed && (
        <Card style={{marginBottom:14,border:`1.5px solid ${G.copper}60`,position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",top:0,right:0,width:120,height:120,background:`radial-gradient(circle at 100% 0%,${G.copperGlow},transparent 70%)`}}/>
          <div style={{fontFamily:SF,fontSize:17,fontWeight:800,marginBottom:14,color:G.copper}}>✓ 분석 완료</div>
          <div style={{background:G.surface,borderRadius:10,overflow:"hidden",border:`1px solid ${G.border}`,marginBottom:14}}>
            {[
              {l:"고객명", v:<span style={{fontWeight:800,fontSize:15}}>{parsed.customer||"—"}</span>},
              ...(parsed.phone?[{l:"연락처",v:<span style={{color:G.creamMuted}}>{parsed.phone}</span>}]:[]),
              {l:"결제", v:<Tag c={pC(parsed.payment)[0]} bg={pC(parsed.payment)[1]}>{parsed.payment||"미입금"}</Tag>},
              ...(parsed.address?[{l:"배송지",v:<span style={{fontSize:12,color:G.creamMuted}}>{parsed.address}{parsed.address_detail ? ` ${parsed.address_detail}` : ""}</span>}]:[]),
              ...((parsed.links||[]).map((lnk,i)=>({l:i===0?"링크":"",v:<a key={i} href={lnk} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:G.blue,textDecoration:"underline"}}>{lnk.length>40?lnk.slice(0,40)+"...":lnk}</a>}))),
              ...(parsed.note?[{l:"메모",v:<span style={{fontSize:12,color:G.creamMuted}}>{parsed.note}</span>}]:[]),
            ].map(({l,v},i)=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",borderTop:i>0?`1px solid ${G.border}`:"none",gap:12}}>
                <span style={{fontSize:12,color:G.creamMuted,whiteSpace:"nowrap",minWidth:44}}>{l}</span>
                <span style={{fontSize:13}}>{v}</span>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:10}}>ORDER ITEMS</div>
          <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:16}}>
            {(parsed.items||[]).map((item,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",background:G.surface,borderRadius:9,border:`1px solid ${G.border}`}}>
                <div>
                  <span style={{fontWeight:700,fontSize:14}}>{item.fabric}</span>
                  {item.color && <span style={{color:G.creamMuted,fontSize:12,marginLeft:6}}>{item.color}</span>}
                </div>
                <span style={{fontFamily:SF,fontSize:20,fontWeight:800,color:G.copper}}>{item.qty}<span style={{fontSize:12,fontWeight:400,color:G.creamMuted,marginLeft:2}}>마</span></span>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={confirm} style={{
              flex:1, padding:"14px", borderRadius:10, border:"none",
              background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
              color:G.white, fontWeight:800, fontSize:15, cursor:"pointer", fontFamily:S,
              boxShadow:`0 4px 24px ${G.copperGlow}`,
            }}>
              ◈  주문등록 + 자동출고
            </button>
            <button onClick={()=>setParsed(null)} style={{
              padding:"14px 16px", borderRadius:10, border:`1.5px solid ${G.border}`,
              background:"transparent", color:G.creamMuted, fontFamily:S, cursor:"pointer",
            }}>✕</button>
          </div>
        </Card>
      )}

      <div style={{padding:"12px 14px",background:`${G.copper}09`,borderRadius:10,border:`1px solid ${G.copper}25`,display:"flex",gap:10,alignItems:"flex-start"}}>
        <span style={{color:G.copper,fontSize:16}}>✦</span>
        <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.9}}>
          카카오톡 주문 채팅을 <b style={{color:G.cream}}>복사 → 붙여넣기</b> 하면<br/>
          고객명 · 원단 · 수량 · 결제 · 배송지를 자동 추출합니다
        </div>
      </div>
    </div>
  );
}

// ════════════════ 적립금 탭 ═══════════════════════════════════
export default OrderInput;
