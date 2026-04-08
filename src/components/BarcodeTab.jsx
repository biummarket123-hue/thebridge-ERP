import { useState, useRef } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./UI.jsx";
import { G, SF, S, baseInp } from "../constants.js";

function BarcodeTab({inv, setInv, logs, setLogs, barcodeDB, setBarcodeDB, showToast}) {
  const [mode, setMode] = useState("scan"); // scan | register
  const [scanInput, setScanInput] = useState("");
  const [scanResult, setScanResult] = useState(null);
  const [scanQty, setScanQty] = useState(1);
  const [scanType, setScanType] = useState("입고");
  const [regBarcode, setRegBarcode] = useState("");
  const [regFabric, setRegFabric] = useState("");
  const [regColor, setRegColor] = useState("");
  const scanRef = React.useRef();

  // 스캔 처리
  const handleScan = (code) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const item = barcodeDB[trimmed];
    if (item) {
      setScanResult({...item, code: trimmed, found: true});
    } else {
      setScanResult({code: trimmed, found: false});
    }
    setScanInput("");
    setScanQty(1);
  };

  // 입출고 처리
  const processInOut = () => {
    if (!scanResult?.found) return;
    const qty = parseFloat(scanQty) || 1;
    const t = nowT();
    const {fabric, color} = scanResult;
    setInv(p => {
      const ex = p.find(i => i.fabric===fabric && i.color===color);
      const newStock = scanType==="입고" ? (ex?.stock||0)+qty : Math.max(0,(ex?.stock||0)-qty);
      if (ex) return p.map(i => i.fabric===fabric&&i.color===color ? {...i,stock:newStock} : i);
      return [...p, {id:Date.now(), fabric, color, stock:scanType==="입고"?qty:0}];
    });
    setLogs(p => [{id:Date.now(),...t, type:scanType, fabric, color, qty, ref:`바코드:${scanResult.code}`, note:`바코드 ${scanType}`}, ...p]);
    showToast(`${scanType} 완료: ${fabric} ${color} ${qty}마`);
    setScanResult(null); setScanQty(1);
    setTimeout(()=>scanRef.current?.focus(), 100);
  };

  // 바코드 등록
  const registerBarcode = () => {
    if (!regBarcode.trim()||!regFabric.trim()) return;
    setBarcodeDB(p=>({...p, [regBarcode.trim()]:{fabric:regFabric.trim(),color:regColor.trim()}}));
    showToast(`바코드 등록: ${regFabric}`);
    setRegBarcode(""); setRegFabric(""); setRegColor("");
  };

  return (
    <div>
      {/* 모드 전환 */}
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        {[{id:"scan",label:"📷 스캔/입력"},{id:"register",label:"🏷 바코드 등록"}].map(m=>(
          <button key={m.id} onClick={()=>setMode(m.id)} style={{
            flex:1,padding:"10px",borderRadius:10,border:`1.5px solid ${mode===m.id?G.copper:G.border}`,
            background:mode===m.id?G.copperGlow:"transparent",
            color:mode===m.id?G.copper:G.creamMuted,
            fontWeight:mode===m.id?800:500,fontSize:13,cursor:"pointer",fontFamily:S,
          }}>{m.label}</button>
        ))}
      </div>

      {/* ── 스캔 화면 ── */}
      {mode==="scan" && (
        <div>
          {/* 입출고 구분 */}
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {["입고","출고"].map(t=>(
              <button key={t} onClick={()=>setScanType(t)} style={{
                flex:1,padding:"10px",borderRadius:10,cursor:"pointer",fontFamily:S,fontWeight:700,fontSize:14,
                border:`2px solid ${scanType===t?(t==="입고"?G.green:G.copper):G.border}`,
                background:scanType===t?(t==="입고"?G.greenBg:G.copperGlow):"transparent",
                color:scanType===t?(t==="입고"?G.green:G.copper):G.creamMuted,
              }}>{t==="입고"?"📥 입고":"📤 출고"}</button>
            ))}
          </div>

          {/* 바코드 입력 */}
          <Card style={{marginBottom:12}}>
            <div style={{fontSize:12,color:G.creamMuted,marginBottom:8,fontWeight:600}}>
              바코드 스캐너 연결 시 자동 인식 · 직접 입력도 가능
            </div>
            <div style={{display:"flex",gap:8}}>
              <input
                ref={scanRef}
                value={scanInput}
                onChange={e=>setScanInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")handleScan(scanInput);}}
                placeholder="바코드를 스캔하거나 직접 입력 후 Enter"
                autoFocus
                style={{...baseInp, flex:1, fontSize:14, fontWeight:600,
                  border:`2px solid ${G.copper}60`, background:G.surface,
                  letterSpacing:"0.05em"
                }}
              />
              <button onClick={()=>handleScan(scanInput)} style={{
                padding:"10px 16px",borderRadius:10,border:"none",
                background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
                color:G.white,fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:S,
              }}>확인</button>
            </div>
          </Card>

          {/* 스캔 결과 */}
          {scanResult && (
            <Card style={{marginBottom:12, border:`1.5px solid ${scanResult.found?G.copper:G.red}60`}}>
              {scanResult.found ? (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <span style={{fontSize:20}}>✅</span>
                    <div>
                      <div style={{fontWeight:800,fontSize:16}}>{scanResult.fabric}</div>
                      {scanResult.color&&<div style={{fontSize:12,color:G.creamMuted}}>{scanResult.color}</div>}
                    </div>
                    <div style={{marginLeft:"auto",textAlign:"right"}}>
                      <div style={{fontSize:10,color:G.creamMuted}}>현재 재고</div>
                      <div style={{fontFamily:SF,fontSize:18,fontWeight:800,color:G.copper}}>
                        {inv.find(i=>i.fabric===scanResult.fabric&&i.color===scanResult.color)?.stock||0}마
                      </div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
                    <FLabel>수량(마)</FLabel>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
                      <button onClick={()=>setScanQty(q=>Math.max(1,parseFloat(q)-1))}
                        style={{width:36,height:36,borderRadius:8,border:`1.5px solid ${G.border}`,background:"transparent",color:G.cream,fontSize:20,cursor:"pointer",fontFamily:S,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                      <input type="number" value={scanQty} onChange={e=>setScanQty(e.target.value)}
                        style={{...baseInp,textAlign:"center",fontFamily:SF,fontSize:20,fontWeight:800,flex:1}}/>
                      <button onClick={()=>setScanQty(q=>parseFloat(q)+1)}
                        style={{width:36,height:36,borderRadius:8,border:`1.5px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:20,cursor:"pointer",fontFamily:S,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>＋</button>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={processInOut} style={{
                      flex:1,padding:"13px",borderRadius:10,border:"none",fontFamily:S,fontWeight:800,fontSize:15,cursor:"pointer",
                      background:scanType==="입고"?`linear-gradient(135deg,${G.green},#6DBF80)`:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
                      color:G.white,boxShadow:`0 4px 20px ${scanType==="입고"?"rgba(91,158,114,0.3)":G.copperGlow}`,
                    }}>
                      {scanType==="입고"?"📥":"📤"} {scanType} {scanQty}마
                    </button>
                    <button onClick={()=>setScanResult(null)} style={{padding:"13px 16px",borderRadius:10,border:`1.5px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,cursor:"pointer"}}>취소</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                    <span style={{fontSize:20}}>❌</span>
                    <div>
                      <div style={{fontWeight:700,fontSize:14,color:G.red}}>미등록 바코드</div>
                      <div style={{fontSize:12,color:G.creamMuted,fontFamily:"monospace"}}>{scanResult.code}</div>
                    </div>
                  </div>
                  <button onClick={()=>{setMode("register");setRegBarcode(scanResult.code);setScanResult(null);}} style={{
                    width:"100%",padding:"11px",borderRadius:10,border:`1.5px solid ${G.copper}`,
                    background:G.copperGlow,color:G.copper,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:S,
                  }}>🏷 이 바코드 지금 등록하기</button>
                </div>
              )}
            </Card>
          )}

          {/* 최근 내역 */}
          <div style={{fontSize:11,color:G.creamMuted,fontWeight:600,marginBottom:8}}>최근 바코드 내역</div>
          {logs.filter(l=>l.ref?.startsWith("바코드:")).slice(0,5).length===0
            ? <div style={{fontSize:12,color:G.creamMuted,textAlign:"center",padding:"16px 0",opacity:0.5}}>바코드 내역 없음</div>
            : logs.filter(l=>l.ref?.startsWith("바코드:")).slice(0,5).map(l=>(
              <div key={l.id} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:G.card,borderRadius:8,border:`1px solid ${G.border}`,marginBottom:5}}>
                <Tag c={l.type==="입고"?G.green:G.copper} bg={l.type==="입고"?G.greenBg:G.copperGlow}>{l.type}</Tag>
                <span style={{flex:1,fontSize:13,fontWeight:600}}>{l.fabric}{l.color?" · "+l.color:""}</span>
                <span style={{fontFamily:SF,fontSize:15,fontWeight:800,color:l.type==="입고"?G.green:G.copper}}>{l.qty}마</span>
                <span style={{fontSize:10,color:G.creamMuted}}>{l.date}</span>
              </div>
            ))
          }
        </div>
      )}

      {/* ── 바코드 등록 ── */}
      {mode==="register" && (
        <div>
          <Card style={{marginBottom:12}}>
            <SecTitle>바코드 ↔ 원단 연결 등록</SecTitle>
            <div style={{marginBottom:10}}>
              <FLabel>바코드 번호</FLabel>
              <input value={regBarcode} onChange={e=>setRegBarcode(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")document.getElementById("reg-fabric")?.focus();}}
                placeholder="스캐너로 스캔하거나 직접 입력" autoFocus
                style={{...baseInp,fontFamily:"monospace",fontSize:14,letterSpacing:"0.05em"}}
              />
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
              <div>
                <FLabel>원단명</FLabel>
                <input id="reg-fabric" value={regFabric} onChange={e=>setRegFabric(e.target.value)} placeholder="린넨코튼" style={baseInp}/>
              </div>
              <div>
                <FLabel>색상</FLabel>
                <input value={regColor} onChange={e=>setRegColor(e.target.value)} placeholder="베이지" style={baseInp}/>
              </div>
            </div>
            <PrimaryBtn onClick={registerBarcode} full>🏷 바코드 등록</PrimaryBtn>
          </Card>

          {/* 등록된 바코드 목록 */}
          <div style={{fontSize:12,fontWeight:700,color:G.cream,marginBottom:8}}>
            등록된 바코드 ({Object.keys(barcodeDB).length}개)
          </div>
          {Object.keys(barcodeDB).length===0
            ? <Empty text="등록된 바코드 없음" sub="바코드를 스캔해서 원단과 연결하세요"/>
            : Object.entries(barcodeDB).map(([code,item])=>(
              <div key={code} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",background:G.card,borderRadius:10,border:`1px solid ${G.border}`,marginBottom:6}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13}}>{item.fabric}{item.color?" · "+item.color:""}</div>
                  <div style={{fontSize:11,color:G.creamMuted,fontFamily:"monospace",marginTop:2}}>{code}</div>
                </div>
                <button onClick={()=>setBarcodeDB(p=>{const n={...p};delete n[code];return n;})}
                  style={{padding:"4px 8px",borderRadius:6,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:11,cursor:"pointer",fontFamily:S}}>🗑</button>
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

export default BarcodeTab;
