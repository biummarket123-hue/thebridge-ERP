import { useState } from "react";
import * as XLSX from "xlsx-js-style";

function ExcelImport({orders, setOrders, customers, setCustomers, showToast}) {
  const SF="'Noto Serif KR',serif";
  const S="'Noto Sans KR',sans-serif";
  const G={bg:"#0D0B09",surface:"#161410",card:"#1E1A16",border:"#2E2820",
    copper:"#C8794A",copperLight:"#E8956A",copperGlow:"rgba(200,121,74,0.15)",
    cream:"#F0E6D6",creamMuted:"#A89880",white:"#FFFFFF",
    green:"#5B9E72",greenBg:"rgba(91,158,114,0.12)",
    red:"#C05A4A",redBg:"rgba(192,90,74,0.12)",
    yellow:"#C4963A",yellowBg:"rgba(196,150,58,0.12)",
    blue:"#4A7EA8",blueBg:"rgba(74,126,168,0.12)"};
  const baseInp={width:"100%",padding:"10px 13px",borderRadius:10,border:`1px solid ${G.border}`,
    background:G.surface,fontFamily:S,fontSize:13,color:G.cream,outline:"none",boxSizing:"border-box"};

  const [step, setStep] = useState("idle"); // idle | preview | done
  const [preview, setPreview] = useState(null); // {orders:[], customers:[]}
  const [mode, setMode] = useState("orders"); // orders | customers
  const [colMap, setColMap] = useState({});
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [importType, setImportType] = useState("append"); // append | replace

  const ORDER_FIELDS = [
    {k:"date",l:"날짜",req:true},
    {k:"customer",l:"고객명",req:true},
    {k:"phone",l:"연락처(뒤4자리)"},
    {k:"fabric",l:"원단명",req:true},
    {k:"qty",l:"수량(마)"},
    {k:"amount",l:"금액"},
    {k:"payment",l:"결제구분"},
    {k:"address",l:"배송지"},
    {k:"note",l:"메모"},
    {k:"manager",l:"담당자"},
    {k:"status",l:"상태"},
  ];
  const CUST_FIELDS = [
    {k:"name",l:"고객명",req:true},
    {k:"phone",l:"연락처"},
    {k:"address",l:"주소"},
    {k:"note",l:"메모"},
  ];

  // 자동 컬럼 매핑
  const autoMap = (hdrs, type) => {
    const map = {};
    const hints = {
      date:["날짜","일자","주문일","date"],
      customer:["고객명","고객","이름","name","customer","성명"],
      phone:["연락처","전화","phone","tel","뒤4","휴대폰"],
      fabric:["원단","원단명","품명","품목","상품명","fabric","item"],
      qty:["수량","마","qty","quantity"],
      amount:["금액","단가","가격","amount","price","원"],
      payment:["결제","입금","결제구분","payment"],
      address:["배송지","주소","address","배송"],
      note:["메모","비고","note","notes","특이"],
      manager:["담당자","담당","manager"],
      status:["상태","status"],
      name:["고객명","이름","name","성명"],
    };
    const fields = type==="orders" ? ORDER_FIELDS : CUST_FIELDS;
    fields.forEach(f=>{
      const h=f.k; const kws=hints[h]||[h];
      const found=hdrs.find(col=>kws.some(kw=>col&&col.toString().toLowerCase().includes(kw.toLowerCase())));
      if(found) map[h]=found;
    });
    return map;
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if(!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, {type:"binary"});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1,defval:""});
        if(rows.length<2){showToast("데이터가 없습니다","error");return;}
        const hdrs = rows[0].map(h=>String(h).trim());
        const dataRows = rows.slice(1).filter(r=>r.some(c=>c!==""));
        setHeaders(hdrs);
        setRawRows(dataRows);
        const autoM = autoMap(hdrs, mode);
        setColMap(autoM);
        setStep("preview");
        showToast(`✓ ${dataRows.length}행 감지 · 컬럼 자동 매핑`);
      } catch(err) {
        showToast("파일 읽기 오류: "+err.message,"error");
      }
    };
    reader.readAsBinaryString(file);
    e.target.value="";
  };

  const getCell = (row, col) => {
    if(!col) return "";
    const idx = headers.indexOf(col);
    return idx>=0 ? String(row[idx]||"").trim() : "";
  };

  const buildOrders = () => {
    const now = new Date().toLocaleDateString("ko-KR");
    return rawRows.map((row,i) => {
      const fabric = getCell(row, colMap.fabric) || "원단 미입력";
      const qty = parseFloat(getCell(row, colMap.qty))||0;
      const amount = parseInt(String(getCell(row, colMap.amount)).replace(/[^0-9]/g,""))||0;
      const pmt = getCell(row, colMap.payment);
      let payment = "미입금";
      if(pmt && (pmt.includes("완료")||pmt.includes("입금")||pmt.includes("paid"))) payment="입금완료";
      else if(pmt) payment=pmt;
      const status = getCell(row,colMap.status)||"접수";
      return {
        id:`#I${String(Date.now()).slice(-4)}${i}`,
        date:getCell(row,colMap.date)||now,
        time:"00:00",
        customer:getCell(row,colMap.customer)||"미입력",
        phone:getCell(row,colMap.phone)||"",
        items:[{fabric, color:"", qty, amount}],
        payment, address:getCell(row,colMap.address)||"",
        note:getCell(row,colMap.note)||"",
        status, manager:getCell(row,colMap.manager)||"",
      };
    });
  };

  const buildCustomers = () => {
    return rawRows.map((row,i) => {
      const name = getCell(row,colMap.name)||"미입력";
      return {
        id:name+i,
        name, phone:getCell(row,colMap.phone)||"",
        address:getCell(row,colMap.address)||"",
        totalOrders:0,total:0,lastOrder:"",
        note:getCell(row,colMap.note)||"",
      };
    });
  };

  const doImport = () => {
    if(mode==="orders"){
      const newOrders = buildOrders();
      if(importType==="replace") setOrders(newOrders);
      else setOrders(prev=>[...newOrders,...prev]);
      showToast(`✓ 주문 ${newOrders.length}건 ${importType==="replace"?"교체":"추가"} 완료!`);
    } else {
      const newCusts = buildCustomers();
      // 중복 제거
      const unique = importType==="replace" ? newCusts :
        [...newCusts, ...customers].filter((c,i,arr)=>arr.findIndex(x=>x.name===c.name)===i);
      setCustomers(unique);
      showToast(`✓ 고객 ${newCusts.length}명 ${importType==="replace"?"교체":"추가"} 완료!`);
    }
    setStep("done");
  };

  const reset = () => {
    setStep("idle");setPreview(null);setHeaders([]);setRawRows([]);
    setColMap({});setFileName("");
  };

  const fields = mode==="orders" ? ORDER_FIELDS : CUST_FIELDS;
  const previewRows = rawRows.slice(0,5);

  return (
    <div>
      <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.7,marginBottom:12}}>
        기존 사용하던 엑셀 파일(.xlsx/.xls/.csv)을 업로드하면<br/>
        컬럼을 자동 인식해서 ERP에 불러옵니다.
      </div>

      {/* 가져올 데이터 종류 */}
      <div style={{display:"flex",gap:0,background:"rgba(255,255,255,.04)",borderRadius:9,padding:3,marginBottom:12}}>
        {[{k:"orders",l:"📋 주문 데이터"},{k:"customers",l:"👥 고객 데이터"}].map(t=>(
          <button key={t.k} onClick={()=>{setMode(t.k);setStep("idle");setColMap({});setHeaders([]);setRawRows([]);}}
            style={{flex:1,padding:"9px 4px",borderRadius:7,border:"none",cursor:"pointer",
              fontFamily:S,fontWeight:mode===t.k?800:500,fontSize:12,
              background:mode===t.k?G.copper:"transparent",
              color:mode===t.k?"#fff":G.creamMuted,transition:"all .15s"}}>
            {t.l}
          </button>
        ))}
      </div>

      {step==="idle"&&(
        <label style={{display:"block",cursor:"pointer"}}>
          <div style={{border:`2px dashed ${G.copper}`,borderRadius:13,padding:"28px 20px",textAlign:"center",
            background:G.copperGlow,transition:"all .2s"}}>
            <div style={{fontSize:32,marginBottom:10}}>📂</div>
            <div style={{fontWeight:800,fontSize:15,color:G.cream,marginBottom:5}}>엑셀 파일 선택</div>
            <div style={{fontSize:12,color:G.creamMuted}}>.xlsx · .xls · .csv 지원</div>
          </div>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{display:"none"}}/>
        </label>
      )}

      {step==="preview"&&(
        <div>
          <div style={{background:G.surface,border:`1px solid ${G.border}`,borderRadius:10,padding:11,marginBottom:12,fontSize:12,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>📄</span>
            <div>
              <div style={{fontWeight:700,color:G.cream}}>{fileName}</div>
              <div style={{color:G.creamMuted,marginTop:2}}>{rawRows.length}행 감지 · 컬럼 {headers.length}개</div>
            </div>
          </div>

          {/* 컬럼 매핑 */}
          <div style={{fontSize:11,fontWeight:800,color:G.copper,letterSpacing:".06em",marginBottom:8,textTransform:"uppercase"}}>컬럼 매핑</div>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
            {fields.map(f=>(
              <div key={f.k} style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:90,fontSize:11,color:f.req?G.cream:G.creamMuted,fontWeight:f.req?700:400,flexShrink:0}}>
                  {f.l}{f.req&&<span style={{color:G.copper}}>*</span>}
                </div>
                <select value={colMap[f.k]||""} onChange={e=>setColMap(m=>({...m,[f.k]:e.target.value}))}
                  style={{flex:1,padding:"7px 10px",borderRadius:8,border:`1px solid ${G.border}`,
                    background:G.surface,fontFamily:S,fontSize:12,color:G.cream,outline:"none"}}>
                  <option value="">-- 매핑 안함 --</option>
                  {headers.map(h=><option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* 미리보기 */}
          <div style={{fontSize:11,fontWeight:800,color:G.copper,letterSpacing:".06em",marginBottom:8}}>미리보기 (상위 5행)</div>
          <div style={{overflowX:"auto",marginBottom:12}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,minWidth:300}}>
              <thead>
                <tr style={{background:G.surface}}>
                  {fields.filter(f=>colMap[f.k]).map(f=>(
                    <th key={f.k} style={{padding:"6px 8px",textAlign:"left",color:G.copper,fontWeight:700,borderBottom:`1px solid ${G.border}`,whiteSpace:"nowrap"}}>{f.l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row,ri)=>(
                  <tr key={ri} style={{borderBottom:`1px solid ${G.border}`}}>
                    {fields.filter(f=>colMap[f.k]).map(f=>(
                      <td key={f.k} style={{padding:"6px 8px",color:G.cream,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {getCell(row,colMap[f.k])||"-"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 추가/교체 옵션 */}
          <div style={{display:"flex",gap:0,background:"rgba(255,255,255,.04)",borderRadius:9,padding:3,marginBottom:14}}>
            {[{k:"append",l:"기존 데이터에 추가"},{k:"replace",l:"기존 데이터 교체"}].map(t=>(
              <button key={t.k} onClick={()=>setImportType(t.k)}
                style={{flex:1,padding:"8px 4px",borderRadius:7,border:"none",cursor:"pointer",
                  fontFamily:S,fontWeight:importType===t.k?700:400,fontSize:11,
                  background:importType===t.k?(t.k==="replace"?G.red:G.green):"transparent",
                  color:importType===t.k?"#fff":G.creamMuted,transition:"all .15s"}}>
                {t.l}
              </button>
            ))}
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={reset}
              style={{flex:1,padding:11,borderRadius:10,border:`1px solid ${G.border}`,
                background:"transparent",color:G.creamMuted,fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:S}}>
              취소
            </button>
            <button onClick={doImport}
              style={{flex:2,padding:11,borderRadius:10,border:"none",
                background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
                color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S,
                boxShadow:"0 4px 20px rgba(200,121,74,.4)"}}>
              ✓ {rawRows.length}건 불러오기
            </button>
          </div>
        </div>
      )}

      {step==="done"&&(
        <div style={{textAlign:"center",padding:"24px 0"}}>
          <div style={{fontSize:40,marginBottom:10}}>✅</div>
          <div style={{fontWeight:800,fontSize:16,color:G.cream,marginBottom:8}}>불러오기 완료!</div>
          <div style={{fontSize:13,color:G.creamMuted,marginBottom:20}}>데이터가 ERP에 반영됐습니다.</div>
          <button onClick={reset}
            style={{padding:"11px 28px",borderRadius:10,border:`1px solid ${G.border}`,
              background:"transparent",color:G.creamMuted,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:S}}>
            다시 업로드
          </button>
        </div>
      )}
    </div>
  );
}

export default ExcelImport;
