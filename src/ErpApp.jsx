import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx-js-style";
import { G, SF, S, INIT_DATA, baseInp, dlXlsx, sC, pC, nowT } from "./constants.js";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, ShippingModal } from "./components/UI.jsx";
import OrderInput from "./components/OrderInput.jsx";
import DepositTab from "./components/DepositTab.jsx";
import BarcodeTab from "./components/BarcodeTab.jsx";
import { InoutForm, AutoShipOut } from "./components/InoutForm.jsx";
import CustomerTab from "./components/CustomerTab.jsx";
import ExcelImport from "./components/ExcelImport.jsx";
import * as db from "./lib/db.js";

function ErpApp() {
  // ── 기본값 ─────────────────────────────────────────────────
  const DEFAULT_INV = [];
  const DEFAULT_SETTINGS = {kakaoWebhook:"",lowStockAlert:10,kakaoEnabled:false,senderName:"로하이마켓",senderPhone:"",senderAddr:"서울 중구 동대문 원단시장",anthropicKey:""};
  const DEFAULT_MANAGERS = ["실장님","고문님","장부장님","송미송","김민주","손희우"];

  const APP_VERSION = "v2.1";

  const [tab, setTab] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [newerUrl, setNewerUrl] = useState(null);
  const [orders, setOrders] = useState(INIT_DATA.orders);
  const [inv, setInv] = useState(DEFAULT_INV);
  const [logs, setLogs] = useState([]);
  const [customers, setCustomers] = useState(INIT_DATA.customers.map((c,i)=>({...c,id:i+1})));
  const SETTINGS_KEY = 'erp_settings_v1';
  const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  const [settings, setSettings] = useState({...DEFAULT_SETTINGS, ...savedSettings});
  const [managers, setManagers] = useState(DEFAULT_MANAGERS);
  const [barcodeDB, setBarcodeDB] = useState({});
  const [theme, setTheme] = useState(()=>localStorage.getItem("erp_theme")||"dark");
  const [toast, setToast] = useState({msg:"",type:"ok"});
  const L = {
    bg:"#F5F0E8", surface:"#FFFFFF", card:"#FFFFFF",
    border:"#D9D0C4", copper:"#B06830", copperLight:"#C8794A",
    copperGlow:"rgba(176,104,48,0.12)", cream:"#1A1612", creamMuted:"#6B5E50",
    white:"#FFFFFF", green:"#3D8B55", greenBg:"rgba(61,139,85,0.10)",
    red:"#C05A4A", redBg:"rgba(192,90,74,0.10)", yellow:"#A67E2E",
    yellowBg:"rgba(166,126,46,0.10)", blue:"#3A6E9A", blueBg:"rgba(58,110,154,0.10)",
    purple:"#7A5AA8",
  };
  const T = theme==="dark" ? G : L;
  const [editingOrder, setEditingOrder] = useState(null);
  const [editingInv, setEditingInv] = useState(null);
  const [editingCust, setEditingCust] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [shippingOpen, setShippingOpen] = useState(false);
  const [ioTab, setIoTab] = useState("in");
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [activeManager, setActiveManager] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderFilter, setOrderFilter] = useState({dateFrom:"",dateTo:"",manager:"",status:"",payment:""});
  const [showFilter, setShowFilter] = useState(false);

  // ── Supabase 초기 로드 ──────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        const [o,i,l,c,m,s] = await Promise.all([
          db.fetchOrders(),
          db.fetchInventory(),
          db.fetchLogs(),
          db.fetchCustomers(),
          db.fetchManagers(),
          db.fetchSettings(),
        ]);
        if (o.length) setOrders(o);
        if (i.length) setInv(i);
        if (l.length) setLogs(l);
        if (c.length) setCustomers(c);
        if (m.length) setManagers(m);
        if (s) { setSettings(prev=>({...prev,...s})); localStorage.setItem(SETTINGS_KEY, JSON.stringify({...savedSettings,...s})); }
      } catch(e) {
        console.error("Supabase load error:", e);
      } finally {
        setLoaded(true);
      }
    })();
  },[]);

  // ── settings: localStorage + Supabase 동기화 ─────────────
  useEffect(()=>{
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    db.saveSettings(settings).catch(e=>console.error("Settings save error:", e));
  },[settings]);

  const showToast = (msg, type="ok") => {
    setToast({msg,type});
    setTimeout(()=>setToast({msg:"",type:"ok"}), 2500);
  };

  const kakaoAlert = useCallback(async (message) => {
    if (!settings.kakaoEnabled || !settings.kakaoWebhook) return;
    try {
      await fetch(settings.kakaoWebhook,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:message})});
      showToast("카톡 알림 전송");
    } catch { showToast("카톡 전송 실패","error"); }
  },[settings]);

  useEffect(()=>{
    const low = inv.filter(i=>i.stock>0&&i.stock<=settings.lowStockAlert);
    if (low.length>0 && settings.kakaoEnabled) {
      kakaoAlert(`⚠️ 재고 부족\n${low.map(i=>`${i.fabric} ${i.color}: ${i.stock}마`).join("\n")}`);
    }
  },[inv]);

  const handleShipOut = async (orderId) => {
    const order = orders.find(o=>o.id===orderId);
    if (!order) return;
    if (order.status==="출고완료") { showToast("이미 출고완료된 주문입니다"); return; }
    const t = nowT();
    try {
      for (const item of (order.items||[])) {
        const invItem = inv.find(i=>i.fabric===item.fabric&&i.color===item.color);
        if (invItem) {
          const newStock = Math.max(0, invItem.stock - item.qty);
          await db.updateInventoryItem(invItem.id, { stock: newStock });
          setInv(p=>p.map(i=>i.id===invItem.id?{...i,stock:newStock}:i));
        }
        const log = await db.insertLog({...t, type:"출고", fabric:item.fabric, color:item.color||"", qty:item.qty, ref:orderId, note:`판매출고 — ${order.customer}`});
        if (log) setLogs(p=>[log,...p]);
      }
      await db.updateOrder(orderId, { status:"출고완료" });
      setOrders(p=>p.map(o=>o.id===orderId?{...o,status:"출고완료"}:o));
      showToast("출고 처리 완료");
    } catch(e) { console.error("출고 실패:", e); showToast("출고 실패: "+e.message,"error"); }
  };

  const handleUndoShipOut = async (orderId, newStatus) => {
    const order = orders.find(o=>o.id===orderId);
    if (!order || order.status!=="출고완료") {
      await db.updateOrder(orderId, { status: newStatus });
      setOrders(p=>p.map(o=>o.id===orderId?{...o,status:newStatus}:o));
      return;
    }
    try {
      // 재고 복구
      for (const item of (order.items||[])) {
        const invItem = inv.find(i=>i.fabric===item.fabric&&i.color===item.color);
        if (invItem) {
          const restored = invItem.stock + (item.qty||0);
          await db.updateInventoryItem(invItem.id, { stock: restored });
          setInv(p=>p.map(i=>i.id===invItem.id?{...i,stock:restored}:i));
        }
      }
      // 해당 주문의 출고 로그 삭제
      const shipLogs = logs.filter(l=>l.type==="출고"&&l.ref===orderId);
      for (const sl of shipLogs) {
        await db.deleteLog(sl.id);
      }
      setLogs(p=>p.filter(l=>!(l.type==="출고"&&l.ref===orderId)));
      await db.updateOrder(orderId, { status: newStatus });
      setOrders(p=>p.map(o=>o.id===orderId?{...o,status:newStatus}:o));
      showToast(`출고 취소 → ${newStatus}`);
    } catch(e) { console.error("출고 취소 실패:", e); showToast("출고 취소 실패","error"); }
  };

  const exportOrders = () => {
    const rows = orders.flatMap(o=>o.items.map(it=>({주문번호:o.id,날짜:o.date,고객명:o.customer,원단:it.fabric,색상:it.color,수량:it.qty,결제:o.payment,상태:o.status,배송지:o.address||"",메모:o.note||""})));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"주문현황"); dlXlsx(wb,"로하이마켓_주문현황.xlsx"); showToast("엑셀 다운로드 완료");
  };
  const exportLogs = () => {
    const rows=logs.map(l=>({날짜:l.date,구분:l.type,아이템No:l.itemNo||"",원단:l.fabric,색상:l.color,수량:l.qty,입고가:l.costPrice||0,참조:l.ref,메모:l.note}));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"입출고이력"); dlXlsx(wb,"로하이마켓_입출고이력.xlsx"); showToast("엑셀 다운로드 완료");
  };
  const exportCustomers = () => {
    const rows=customers.map(c=>({고객명:c.name,연락처:c.phone||"",주소:c.address||"",총주문:c.totalOrders||0,메모:c.note||""}));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"고객목록"); dlXlsx(wb,"로하이마켓_고객목록.xlsx"); showToast("엑셀 다운로드 완료");
  };
  const exportShipping = (selIds, courier) => {
    const COLS = {
      "CJ대한통운":{
        cols:["받는분성명","받는분전화번호","받는분기타연락처","받는분우편번호","받는분주소(전체, 분할)","배송메세지1","배송메세지2","품목명"],
        widths:[22,26,22,18,150,24,24,38],
        purple:[0,1,4],
        row:(o,s,c)=>({
          "받는분성명":o.customer,
          "받는분전화번호":o.phone||c.find(x=>x.name===o.customer)?.phone||"",
          "받는분기타연락처":"",
          "받는분우편번호":"",
          "받는분주소(전체, 분할)":o.address||"",
          "배송메세지1":"",
          "배송메세지2":"",
          "품목명":"",
        })
      },
      "경동화물":{
        cols:["받는분","주소","상세주소","운송장번호","고객사주문번호","우편번호","도착영업소","전화번호","기타전화번호","선불후불","품목명","수량","포장상태","가로","세로","높이","무게","개별단가","배송운임","기타운임","별도운임","할증운임","도서운임","메모"],
        widths:[15,41,42,11,15,9,11,14,13,9,7,5,9,5,5,5,5,9,10,9,9,9,9,26],
        blue:[0,1,2,7,12,18],
        row:(o,s,c)=>{
          let base = o.address||"", detail = o.addressDetail||"";
          if(base && !detail){
            const m = base.match(/^(.+?(?:\d+(?:-\d+)?(?:번지|번길)?)\s?)(.+)$/);
            if(m){ base=m[1].trim(); detail=m[2].trim(); }
          }
          return {
          "받는분":o.customer,
          "주소":base,
          "상세주소":detail,
          "운송장번호":"",
          "고객사주문번호":"",
          "우편번호":"",
          "도착영업소":"",
          "전화번호":o.phone||c.find(x=>x.name===o.customer)?.phone||"",
          "기타전화번호":"",
          "선불후불":"선불",
          "품목명":"원단",
          "수량":"",
          "포장상태":"",
          "가로":"","세로":"","높이":"","무게":"",
          "개별단가":100,
          "배송운임":"","기타운임":100,"별도운임":"","할증운임":"","도서운임":"",
          "메모":"",
          };
        }
      },
    };
    const targets = orders.filter(o=>selIds.includes(o.id));
    if (!targets.length) { showToast("선택된 주문이 없습니다","error"); return; }
    const fmt = COLS[courier]||COLS["CJ대한통운"];
    const dataRows = targets.map(o=>{
      const r = fmt.row(o,settings,customers);
      return fmt.cols.map(col=>r[col]!=null?r[col]:"");
    });
    const aoa = [fmt.cols, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"]=(fmt.widths||fmt.cols.map(()=>22)).map(w=>({wch:w}));
    const purpleSet = new Set(fmt.purple||[]);
    const blueSet = new Set(fmt.blue||[]);
    fmt.cols.forEach((_,ci)=>{
      const hAddr = XLSX.utils.encode_cell({r:0,c:ci});
      if(!ws[hAddr]) ws[hAddr]={v:"",t:"s"};
      const isAccent = purpleSet.has(ci) || blueSet.has(ci);
      const accentRgb = purpleSet.has(ci) ? "7030A0" : blueSet.has(ci) ? "0070C0" : "000000";
      ws[hAddr].s = {
        font:{ bold:isAccent, sz:13, color:{ rgb: accentRgb } },
        fill:{ fgColor:{ rgb:"F0F0F0" } },
        alignment:{ horizontal:"center", vertical:"center" },
      };
      for(let ri=1;ri<aoa.length;ri++){
        const dAddr = XLSX.utils.encode_cell({r:ri,c:ci});
        if(!ws[dAddr]) ws[dAddr]={v:"",t:"s"};
        ws[dAddr].s = { font:{ sz:13, color:{ rgb:"000000" } } };
      }
    });
    ws["!rows"]=aoa.map((_,i)=>({hpt: i===0 ? 22 : 20}));
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"송장출력");
    dlXlsx(wb,`로하이마켓_${courier}_송장.xlsx`);
    showToast(`${courier} 송장 ${targets.length}건 출력`);
    setShippingOpen(false);
  };

  const deleteItem = async () => {
    if (!confirmDel) return;
    try {
      if (confirmDel.type==="order") { await db.deleteOrder(confirmDel.id); setOrders(p=>p.filter(o=>o.id!==confirmDel.id)); }
      if (confirmDel.type==="inv") { await db.deleteInventoryItem(confirmDel.id); setInv(p=>p.filter(i=>i.id!==confirmDel.id)); }
      if (confirmDel.type==="log") { await db.deleteLog(confirmDel.id); setLogs(p=>p.filter(l=>l.id!==confirmDel.id)); }
      if (confirmDel.type==="customer") { await db.deleteCustomer(confirmDel.id); setCustomers(p=>p.filter(c=>c.id!==confirmDel.id)); }
      if (confirmDel.type==="reset") {
        await db.clearAllData();
        const [i,m] = await Promise.all([db.fetchInventory(), db.fetchManagers()]);
        setOrders([]);
        setInv(i.length ? i : DEFAULT_INV);
        setLogs([]);
        setCustomers([]);
        setSettings(DEFAULT_SETTINGS);
        setManagers(m.length ? m : DEFAULT_MANAGERS);
        setBarcodeDB({});
        showToast("전체 초기화 완료");
      }
    } catch(e) { console.error("Delete error:", e); }
    setConfirmDel(null);
    if (confirmDel.type!=="reset") showToast("삭제 완료");
  };

  const totalQty = orders.reduce((a,o)=>a+o.items.reduce((b,i)=>b+i.qty,0),0);
  const unpaid = orders.filter(o=>o.payment!=="입금완료").length;
  const low = inv.filter(i=>i.stock<settings.lowStockAlert);
  const TABS = [{icon:"✦",l:"주문입력"},{icon:"◈",l:"주문현황"},{icon:"◉",l:"입출고"},{icon:"♦",l:"고객관리"},{icon:"💰",l:"계약/잔금"},{icon:"◇",l:"대시보드"},{icon:"⚙",l:"설정"}];

  return (
    <div className="erp-root" style={{fontFamily:S,background:T.bg,minHeight:"100vh",color:T.cream,maxWidth:600,margin:"0 auto"}}>
      {!loaded && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:999,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
          <div style={{fontFamily:SF,fontSize:24,fontWeight:800,color:T.copper}}>로하이마켓 ERP</div>
          <div style={{fontSize:11,color:T.creamMuted}}>v2.1</div>
          <div style={{width:40,height:40,border:`3px solid ${T.copper}30`,borderTop:`3px solid ${T.copper}`,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
          <div style={{fontSize:12,color:T.creamMuted}}>데이터 불러오는 중...</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {/* ── 구버전 안내 화면 ── */}
      {loaded && newerUrl && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:998,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20,padding:24,textAlign:"center"}}>
          <div style={{fontSize:48}}>🔄</div>
          <div style={{fontFamily:SF,fontSize:22,fontWeight:800,color:T.copper}}>새 버전이 있습니다</div>
          <div style={{fontSize:14,color:T.creamMuted,lineHeight:1.8}}>
            현재 버전은 구버전입니다.<br/>
            최신 버전으로 이동해서<br/>
            <b style={{color:T.cream}}>동일한 데이터</b>를 이용하세요.
          </div>
          <a href={newerUrl} target="_blank" rel="noreferrer"
            style={{display:"block",width:"100%",maxWidth:320,padding:"16px",borderRadius:12,background:`linear-gradient(135deg,${T.copper},${T.copperLight})`,color:T.white,fontWeight:800,fontSize:16,textDecoration:"none",boxShadow:`0 6px 30px ${T.copperGlow}`,fontFamily:S}}>
            🚀 최신 버전으로 이동
          </a>
          <button onClick={()=>setNewerUrl(null)} style={{padding:"10px 20px",borderRadius:10,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontFamily:S,fontSize:13,cursor:"pointer"}}>
            이 버전으로 계속 사용
          </button>
          <div style={{fontSize:10,color:T.creamMuted}}>현재: {APP_VERSION}</div>
        </div>
      )}

      <style>{`
        .erp-root {
          --bg: ${T.bg};
          --surface: ${T.surface};
          --card: ${T.card};
          --border: ${T.border};
          --copper: ${T.copper};
          --cream: ${T.cream};
          --muted: ${T.creamMuted};
          --green: ${T.green};
          --red: ${T.red};
          background: ${T.bg} !important;
          color: ${T.cream} !important;
        }
        .erp-root * { transition: background 0.25s, border-color 0.25s, color 0.2s; }
        .erp-root input, .erp-root select, .erp-root textarea {
          background: ${T.surface} !important;
          color: ${T.cream} !important;
          border-color: ${T.border} !important;
        }
        .erp-root select option { background: ${T.card}; color: ${T.cream}; }
        .erp-card {
          background: ${T.card} !important;
          border-color: ${T.border} !important;
        }
        .erp-surface { background: ${T.surface} !important; }
        .erp-border { border-color: ${T.border} !important; }
      `}</style>
      <Toast msg={toast.msg} type={toast.type}/>
      {editingOrder && (
        <EditOrderModal
          order={editingOrder}
          onSave={o=>{setOrders(p=>p.map(x=>x.id===o.id?o:x));setEditingOrder(null);showToast("주문 수정 완료");}}
          onClose={()=>setEditingOrder(null)}
        />
      )}
      {editingInv && (
        <EditInvModal
          item={editingInv}
          onSave={it=>{setInv(p=>p.map(x=>x.id===it.id?it:x));setEditingInv(null);showToast("재고 수정 완료");}}
          onClose={()=>setEditingInv(null)}
        />
      )}
      {editingCust && (
        <EditCustModal
          cust={editingCust}
          onSave={c=>{setCustomers(p=>p.map(x=>x.id===c.id?c:x));setEditingCust(null);showToast("고객 수정 완료");}}
          onClose={()=>setEditingCust(null)}
        />
      )}
      {confirmDel && <ConfirmModal item={confirmDel} onConfirm={deleteItem} onCancel={()=>setConfirmDel(null)}/>}
      {shippingOpen && (
        <ShippingModal
          orders={orders} customers={customers} settings={settings}
          preSelected={selectMode && selectedOrders.length>0 ? selectedOrders : null}
          onExport={(ids,c)=>{exportShipping(ids,c);setSelectedOrders([]);setSelectMode(false);}}
          onClose={()=>setShippingOpen(false)}
        />
      )}

      {/* Header */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <span style={{fontFamily:SF,fontSize:16,fontWeight:900,color:T.cream,whiteSpace:"nowrap"}}>로하이마켓</span>
          <span style={{fontSize:9,color:T.white,fontWeight:800,background:T.copper,padding:"2px 6px",borderRadius:4}}>ERP</span>
          <span style={{fontSize:9,color:T.creamMuted}}>v2.1</span>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          {[{l:"주문",v:orders.length,c:G.copper},{l:"미입금",v:unpaid,c:unpaid>0?G.red:G.creamMuted},{l:"부족",v:low.length,c:low.length>0?G.yellow:G.creamMuted}].map(s=>(
            <div key={s.l} style={{display:"flex",alignItems:"center",gap:3,padding:"4px 8px",borderRadius:8,background:T.card,border:`1px solid ${T.border}`}}>
              <span style={{fontWeight:900,fontSize:13,lineHeight:1,color:s.c}}>{s.v}</span>
              <span style={{fontSize:9,color:T.creamMuted}}>{s.l}</span>
            </div>
          ))}
          <button onClick={()=>{
            const url=window.location.href;
            if(navigator.clipboard){
              navigator.clipboard.writeText(url).then(()=>showToast("✓ 링크 복사!")).catch(()=>showToast("주소창에서 복사"));
            } else { showToast("주소창에서 복사"); }
          }} style={{padding:"5px 10px",borderRadius:8,border:`1.5px solid ${T.copper}`,
            background:T.copperGlow,color:T.copper,fontWeight:800,fontSize:11,
            cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>
            🔗
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",position:"sticky",top:50,zIndex:9,overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
        <style>{".erp-tabs::-webkit-scrollbar{display:none}"}</style>
        {TABS.map((t,i)=>(
          <button key={i} onClick={()=>setTab(i)} style={{
            flex:"none",padding:"10px 12px",border:"none",cursor:"pointer",
            borderBottom:tab===i?`2px solid ${G.copper}`:"2px solid transparent",
            background:tab===i?`${G.copper}0D`:"transparent",
            color:tab===i?G.copper:G.creamMuted,
            fontFamily:S,fontWeight:tab===i?700:400,
            fontSize:12,whiteSpace:"nowrap",transition:"all 0.15s"}}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{padding:16}}>
        {tab===0 && (
          <OrderInput
            inv={inv} setInv={setInv} orders={orders} setOrders={setOrders}
            logs={logs} setLogs={setLogs} customers={customers} setCustomers={setCustomers}
            setTab={setTab} showToast={showToast} kakaoAlert={kakaoAlert}
            managers={managers} setManagers={setManagers}
            activeManager={activeManager} setActiveManager={setActiveManager}
          />
        )}

        {tab===1 && (
          <div style={{paddingBottom: selectMode && selectedOrders.length>0 ? 80 : 0}}>
            {/* 헤더 */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontFamily:SF,fontSize:22,fontWeight:800}}>주문 현황</div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <button onClick={()=>{setSelectMode(s=>!s);setSelectedOrders([]);}} style={{padding:"6px 12px",borderRadius:8,border:`1.5px solid ${selectMode?G.copper:G.border}`,background:selectMode?G.copperGlow:"transparent",color:selectMode?G.copper:G.creamMuted,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S}}>
                  {selectMode?"✕ 선택취소":"☑ 선택"}
                </button>
                <GhostBtn onClick={()=>setShippingOpen(true)} small color={G.copper}>🚚 전체송장</GhostBtn>
                <GhostBtn onClick={exportOrders} small>⬇</GhostBtn>
              </div>
            </div>

            {/* 검색 */}
            <div style={{marginBottom:10}}>
              <input value={orderSearch} onChange={e=>setOrderSearch(e.target.value)} placeholder="고객명, 원단, 메모 검색..." style={{...baseInp,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
            </div>

            {/* 필터 토글 */}
            <div style={{marginBottom:10}}>
              <button onClick={()=>setShowFilter(f=>!f)} style={{fontSize:12,color:showFilter?G.copper:T.creamMuted,background:showFilter?G.copperGlow:"transparent",border:`1px solid ${showFilter?G.copper:T.border}`,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:S,fontWeight:600}}>
                🔍 필터 {showFilter?"▲":"▼"} {Object.values(orderFilter).filter(v=>v).length>0?`(${Object.values(orderFilter).filter(v=>v).length})`:""}
              </button>
              {Object.values(orderFilter).filter(v=>v).length>0 && (
                <button onClick={()=>setOrderFilter({dateFrom:"",dateTo:"",manager:"",status:"",payment:""})} style={{fontSize:11,color:T.creamMuted,background:"transparent",border:"none",cursor:"pointer",fontFamily:S,marginLeft:6}}>초기화</button>
              )}
            </div>

            {showFilter && (
              <Card style={{marginBottom:12,background:T.card,border:`1px solid ${T.border}`}}>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>시작일</div>
                    <input type="date" value={orderFilter.dateFrom} onChange={e=>setOrderFilter(f=>({...f,dateFrom:e.target.value}))} style={{...baseInp,fontSize:12,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>종료일</div>
                    <input type="date" value={orderFilter.dateTo} onChange={e=>setOrderFilter(f=>({...f,dateTo:e.target.value}))} style={{...baseInp,fontSize:12,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>담당자</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {["",  ...managers].map(m=>(
                      <button key={m} onClick={()=>setOrderFilter(f=>({...f,manager:m}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.manager===m?G.copper:T.border}`,background:orderFilter.manager===m?G.copperGlow:"transparent",color:orderFilter.manager===m?G.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.manager===m?700:400}}>
                        {m||"전체"}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>상태</div>
                  <div style={{display:"flex",gap:5}}>
                    {["","접수","준비중","출고완료"].map(s=>(
                      <button key={s} onClick={()=>setOrderFilter(f=>({...f,status:s}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.status===s?G.copper:T.border}`,background:orderFilter.status===s?G.copperGlow:"transparent",color:orderFilter.status===s?G.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.status===s?700:400}}>
                        {s||"전체"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>결제</div>
                  <div style={{display:"flex",gap:5}}>
                    {["","입금완료","미입금"].map(p=>(
                      <button key={p} onClick={()=>setOrderFilter(f=>({...f,payment:p}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.payment===p?G.copper:T.border}`,background:orderFilter.payment===p?G.copperGlow:"transparent",color:orderFilter.payment===p?G.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.payment===p?700:400}}>
                        {p||"전체"}
                      </button>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {/* 전체선택 바 */}
            {selectMode && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:G.copperGlow,borderRadius:10,border:`1px solid ${G.copper}40`,marginBottom:12}}>
                <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,fontWeight:600,color:G.copper}}>
                  <input type="checkbox"
                    checked={selectedOrders.length===orders.length && orders.length>0}
                    onChange={e=>setSelectedOrders(e.target.checked?orders.map(o=>o.id):[])}
                    style={{accentColor:G.copper,width:16,height:16}}
                  />
                  전체 선택 ({selectedOrders.length}/{orders.length})
                </label>
                {selectedOrders.length>0 && (
                  <button onClick={()=>{setShippingOpen(true);}} style={{padding:"6px 14px",borderRadius:8,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S,boxShadow:`0 2px 12px ${G.copperGlow}`}}>
                    🚚 {selectedOrders.length}건 송장출력
                  </button>
                )}
              </div>
            )}

            {(()=>{
              const q = orderSearch.trim().toLowerCase();
              const f = orderFilter;
              const filtered = orders.filter(o=>{
                if(q && !(o.customer||"").toLowerCase().includes(q) && !(o.phone||"").includes(q) && !(o.note||"").toLowerCase().includes(q) && !(o.items||[]).some(it=>(it.fabric||"").toLowerCase().includes(q)||(it.color||"").toLowerCase().includes(q))) return false;
                if(f.dateFrom && o.date && o.date.replace(/\./g,"-")<f.dateFrom) return false;
                if(f.dateTo && o.date && o.date.replace(/\./g,"-")>f.dateTo) return false;
                if(f.manager && o.manager!==f.manager) return false;
                if(f.status && o.status!==f.status) return false;
                if(f.payment && o.payment!==f.payment) return false;
                return true;
              });
              return filtered.length===0
              ? <Empty text="검색 결과가 없습니다" sub={orders.length>0?"필터를 조정해보세요":"카톡 주문장을 붙여넣어 시작하세요"}/>
              : filtered.map(o=>{
                  const isSelected = selectedOrders.includes(o.id);
                  return (
                    <Card key={o.id} style={{marginBottom:10,border:`1.5px solid ${isSelected?G.copper:G.border}`,background:isSelected?`${G.copper}08`:G.card,transition:"all 0.15s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:1}}>
                          {selectMode && (
                            <input type="checkbox" checked={isSelected}
                              onChange={e=>setSelectedOrders(p=>e.target.checked?[...p,o.id]:p.filter(x=>x!==o.id))}
                              style={{accentColor:G.copper,width:18,height:18,marginTop:2,flexShrink:0,cursor:"pointer"}}
                            />
                          )}
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                              <span style={{fontFamily:SF,fontSize:11,color:G.copper,fontWeight:700}}>{o.id}</span>
                              <span style={{fontWeight:800,fontSize:16}}>{o.customer}</span>
                              {o.manager && <span style={{fontSize:10,color:G.creamMuted,background:G.surface,padding:"1px 6px",borderRadius:4}}>{o.manager}</span>}
                            </div>
                            <span style={{fontSize:11,color:G.creamMuted}}>{o.date}{(o.phone || customers.find(x=>x.name===o.customer)?.phone) ? ` · ${o.phone || customers.find(x=>x.name===o.customer)?.phone}` : ""}</span>
                          </div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",flexShrink:0}}>
                          <Tag c={pC(o.payment)[0]} bg={pC(o.payment)[1]}>{o.payment}</Tag>
                          <Tag c={sC(o.status)[0]} bg={sC(o.status)[1]}>{o.status}</Tag>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                        {o.items.map((item,i)=>(
                          <div key={i} style={{padding:"4px 10px",background:G.surface,borderRadius:8,border:`1px solid ${G.border}`,fontSize:12}}>
                            <span style={{color:G.creamMuted}}>{item.fabric}{item.color?" "+item.color:""} </span>
                            <span style={{fontWeight:700}}>{item.qty}마</span>
                            {item.amount>0 && <span style={{color:G.copper,marginLeft:4,fontSize:11}}>{item.amount.toLocaleString()}원</span>}
                          </div>
                        ))}
                      </div>
                      {o.address && <div style={{fontSize:11,color:G.creamMuted,marginBottom:6}}>📦 {o.address}{o.addressDetail ? ` ${o.addressDetail}` : ""}</div>}
                      {(o.links||[]).length>0 && <div style={{fontSize:11,marginBottom:6,display:"flex",flexDirection:"column",gap:3}}>{o.links.map((lnk,i)=><a key={i} href={lnk} target="_blank" rel="noopener noreferrer" style={{color:G.blue,textDecoration:"underline"}}>🔗 {lnk.length>50?lnk.slice(0,50)+"...":lnk}</a>)}</div>}
                      {o.note && o.note.trim() && o.note.trim()!=="None" && (
                        <div style={{fontSize:12,color:G.cream,marginBottom:10,padding:"6px 10px",background:G.surface,borderRadius:7,border:`1px solid ${G.border}`,display:"flex",gap:6,alignItems:"flex-start"}}>
                          <span style={{color:G.yellow,fontSize:13,flexShrink:0}}>💬</span>
                          <span style={{lineHeight:1.6,whiteSpace:"pre-wrap"}}>{o.note}</span>
                        </div>
                      )}
                      {!selectMode && <>
                        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                          {["접수","준비중","출고완료"].map(s=>{
                            const [c,bg]=sC(s);
                            return (
                              <button key={s} onClick={()=>{
                                if(s==="출고완료"){ handleShipOut(o.id); }
                                else if(o.status==="출고완료"){ handleUndoShipOut(o.id, s); }
                                else { setOrders(p=>p.map(x=>x.id===o.id?{...x,status:s}:x)); db.updateOrder(o.id,{status:s}); }
                              }} style={{padding:"4px 10px",fontSize:11,borderRadius:20,border:`1px solid ${o.status===s?c:G.border}`,background:o.status===s?bg:"transparent",color:o.status===s?c:G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:o.status===s?700:400}}>
                                {s}
                              </button>
                            );
                          })}
                          {o.payment!=="입금완료" && (
                            <button onClick={()=>{db.updateOrder(o.id,{payment:"입금완료"});setOrders(p=>p.map(x=>x.id===o.id?{...x,payment:"입금완료"}:x));kakaoAlert(`✅ 입금확인\n${o.id} — ${o.customer}`);showToast("입금 확인 완료");}} style={{marginLeft:"auto",padding:"4px 12px",fontSize:11,borderRadius:20,border:`1px solid ${G.green}`,background:G.greenBg,color:G.green,cursor:"pointer",fontFamily:S,fontWeight:700}}>
                              입금확인 ✓
                            </button>
                          )}
                        </div>
                        <div style={{display:"flex",gap:6,paddingTop:8,borderTop:`1px solid ${G.border}`}}>
                          <button onClick={()=>setEditingOrder({...o,items:o.items.map(i=>({...i}))})} style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S}}>✏ 수정</button>
                          <button onClick={()=>setConfirmDel({type:"order",id:o.id,label:`주문 ${o.id} (${o.customer})`})} style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:12,cursor:"pointer",fontFamily:S}}>🗑 삭제</button>
                        </div>
                      </>}
                      {selectMode && (
                        <div onClick={()=>setSelectedOrders(p=>isSelected?p.filter(x=>x!==o.id):[...p,o.id])}
                          style={{paddingTop:8,borderTop:`1px solid ${G.border}40`,textAlign:"center",fontSize:12,color:isSelected?G.copper:G.creamMuted,cursor:"pointer",fontWeight:isSelected?700:400}}>
                          {isSelected?"✓ 선택됨":"탭하여 선택"}
                        </div>
                      )}
                    </Card>
                  );
                })
            })()}

            {/* 플로팅 송장 버튼 */}
            {selectMode && selectedOrders.length>0 && (
              <div style={{position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:50,maxWidth:560,width:"calc(100% - 32px)"}}>
                <button onClick={()=>setShippingOpen(true)} style={{width:"100%",padding:"15px",borderRadius:14,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontWeight:800,fontSize:16,cursor:"pointer",fontFamily:S,boxShadow:"0 6px 30px rgba(200,121,74,0.5)",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <span>🚚</span>
                  <span>{selectedOrders.length}건 선택 — 송장 출력</span>
                </button>
              </div>
            )}
          </div>
        )}

        {tab===2 && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:SF,fontSize:22,fontWeight:800}}>입출고 관리</div>
              <GhostBtn onClick={exportLogs} small>⬇ 엑셀</GhostBtn>
            </div>

            {/* 서브 탭 */}
            <div style={{display:"flex",gap:0,background:G.surface,borderRadius:12,padding:3,marginBottom:16}}>
              {[{id:"in",icon:"📥",label:"입고"},{id:"auto",icon:"🔄",label:"자동출고"},{id:"barcode",icon:"▐▌",label:"바코드"},{id:"stock",icon:"📦",label:"재고현황"},{id:"history",icon:"📋",label:"내역"}].map(t=>(
                <button key={t.id} onClick={()=>setIoTab(t.id)} style={{
                  flex:1,padding:"9px 2px",borderRadius:9,border:"none",cursor:"pointer",fontFamily:S,
                  fontWeight:ioTab===t.id?800:500,fontSize:11,
                  background:ioTab===t.id?`linear-gradient(135deg,${G.copper},${G.copperLight})`:"transparent",
                  color:ioTab===t.id?G.white:G.creamMuted,
                  display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"all 0.15s",
                }}>
                  <span style={{fontSize:14}}>{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>

            {/* ── 입고 ── */}
            {ioTab==="in" && (
              <InoutForm inv={inv} setInv={setInv} logs={logs} setLogs={setLogs} showToast={showToast}/>
            )}

            {/* ── 바코드 ── */}
            {ioTab==="barcode" && (
              <Card style={{padding:"40px 20px",textAlign:"center",background:T.card,border:`1px solid ${T.border}`}}>
                <div style={{fontSize:32,marginBottom:12}}>▐▌</div>
                <div style={{fontSize:15,fontWeight:700,color:G.cream,marginBottom:6}}>서비스 준비중</div>
                <div style={{fontSize:12,color:G.creamMuted}}>바코드 기능은 현재 준비중입니다.</div>
              </Card>
            )}

            {/* ── 자동출고 ── */}
            {ioTab==="auto" && (
              <AutoShipOut
                orders={orders} setOrders={setOrders}
                inv={inv} setInv={setInv}
                logs={logs} setLogs={setLogs}
                showToast={showToast}
                onShipDone={()=>setIoTab("history")}
              />
            )}

            {/* ── 재고현황 ── */}
            {ioTab==="stock" && (
              <div>
                <Card style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <SecTitle>재고 현황 ({inv.length}품목)</SecTitle>
                    <button onClick={()=>{
                      const low=inv.filter(i=>i.stock<settings.lowStockAlert);
                      showToast(low.length>0?`부족 ${low.length}품목: ${low.map(i=>i.fabric).join(", ")}`:"모든 재고 정상");
                    }} style={{fontSize:11,color:G.yellow,background:G.yellowBg,border:`1px solid ${G.yellow}40`,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontFamily:S,fontWeight:600}}>
                      ⚠ 부족확인
                    </button>
                  </div>
                  {inv.length===0
                    ? <Empty text="등록된 재고가 없습니다" sub=""/>
                    : inv.map((i,idx)=>(
                      <div key={i.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderTop:idx>0?`1px solid ${G.border}`:"none"}}>
                        <div>
                          <div style={{fontSize:14,fontWeight:700}}>{i.fabric}</div>
                          {i.color && <div style={{fontSize:11,color:G.creamMuted,marginTop:1}}>{i.color}</div>}
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{textAlign:"right"}}>
                            <span style={{fontFamily:SF,fontSize:20,fontWeight:800,color:i.stock<settings.lowStockAlert?G.red:i.stock<30?G.yellow:G.green}}>{i.stock}</span>
                            <span style={{fontSize:11,color:G.creamMuted,marginLeft:2}}>마{i.stock<settings.lowStockAlert?" ⚠":""}</span>
                          </div>
                          <button onClick={()=>setEditingInv({...i})} style={{padding:"4px 9px",borderRadius:7,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S}}>✏</button>
                          <button onClick={()=>setConfirmDel({type:"inv",id:i.id,label:`${i.fabric} ${i.color}`})} style={{padding:"4px 9px",borderRadius:7,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:12,cursor:"pointer",fontFamily:S}}>🗑</button>
                        </div>
                      </div>
                    ))
                  }
                </Card>
                {/* 재고 바 차트 */}
                <Card>
                  <SecTitle>재고 시각화</SecTitle>
                  {inv.slice(0,12).map(i=>(
                    <div key={i.id} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                        <span style={{fontWeight:600}}>{i.fabric}{i.color?" · "+i.color:""}</span>
                        <span style={{fontWeight:700,color:i.stock<settings.lowStockAlert?G.red:i.stock<30?G.yellow:G.green}}>{i.stock}마</span>
                      </div>
                      <div style={{height:6,background:"rgba(255,255,255,0.05)",borderRadius:3,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.min(100,(i.stock/Math.max(...inv.map(x=>x.stock),1))*100)}%`,background:i.stock<settings.lowStockAlert?G.red:i.stock<30?G.yellow:G.copper,borderRadius:3,transition:"width 0.5s"}}/>
                      </div>
                    </div>
                  ))}
                </Card>
              </div>
            )}

            {/* ── 내역 ── */}
            {ioTab==="history" && (
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontFamily:SF,fontSize:16,fontWeight:700}}>입출고 내역 ({logs.length}건)</div>
                  <div style={{display:"flex",gap:6}}>
                    <Tag c={G.green} bg={G.greenBg}>입고 {logs.filter(l=>l.type==="입고").length}</Tag>
                    <Tag c={G.copper} bg={G.copperGlow}>출고 {logs.filter(l=>l.type==="출고").length}</Tag>
                  </div>
                </div>
                {logs.length===0
                  ? <Empty text="입출고 내역이 없습니다" sub=""/>
                  : logs.map(log=>(
                    <div key={log.id} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background:G.card,borderRadius:10,border:`1px solid ${G.border}`,marginBottom:6}}>
                      <Tag c={log.type==="입고"?G.green:G.copper} bg={log.type==="입고"?G.greenBg:G.copperGlow}>{log.type}</Tag>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:700}}>{log.fabric}{log.color?" · "+log.color:""}</div>
                        <div style={{fontSize:11,color:G.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {log.date} · {log.ref}
                      {log.costPrice>0&&<span style={{color:G.copper,marginLeft:4}}>@{log.costPrice.toLocaleString()}원</span>}
                      {log.note&&log.note!=="—"?<span> · {log.note}</span>:""}
                    </div>
                      </div>
                      <span style={{fontFamily:SF,fontSize:18,fontWeight:800,color:log.type==="입고"?G.green:G.copper}}>{log.qty}<span style={{fontSize:10,color:G.creamMuted,marginLeft:2}}>마</span></span>
                      <button onClick={()=>setConfirmDel({type:"log",id:log.id,label:`${log.type} ${log.fabric} ${log.qty}마`})} style={{padding:"4px 7px",borderRadius:6,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:11,cursor:"pointer",fontFamily:S,flexShrink:0}}>🗑</button>
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        )}

        {tab===3 && (
          <CustomerTab
            customers={customers} setCustomers={setCustomers} orders={orders}
            exportCustomers={exportCustomers} showToast={showToast} kakaoAlert={kakaoAlert}
            setConfirmDel={setConfirmDel} setEditingCust={setEditingCust}
          />
        )}

        {tab===4 && (
          <DepositTab showToast={showToast} customers={customers} />
        )}

        {tab===5 && (
          <div>
            <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:16,color:G.cream}}>대시보드</div>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:14}}>📂 마켓원장_0403.xlsx 데이터 기준 · 총 {INIT_DATA.orders.length.toLocaleString()}건 중 최근 300건 표시</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[{icon:"◈",l:"총 주문",v:orders.length,u:"건",c:G.copper},{icon:"◉",l:"총 수량",v:totalQty,u:"마",c:G.blue},{icon:"◇",l:"미입금",v:unpaid,u:"건",c:unpaid>0?G.red:G.creamMuted},{icon:"♦",l:"고객수",v:customers.length,u:"명",c:G.purple}].map(s=>(
                <div key={s.l} style={{background:G.card,borderRadius:14,border:`1px solid ${G.border}`,padding:"16px 18px",position:"relative",overflow:"hidden"}}>
                  <div style={{position:"absolute",top:-10,right:-10,width:60,height:60,background:`radial-gradient(circle,${s.c}25,transparent 70%)`}}/>
                  <div style={{fontSize:16,marginBottom:8}}>{s.icon}</div>
                  <div style={{fontFamily:SF,fontSize:28,fontWeight:700,color:s.c,lineHeight:1}}>{s.v}<span style={{fontSize:12,fontWeight:400,color:G.creamMuted,marginLeft:3}}>{s.u}</span></div>
                  <div style={{fontSize:11,color:G.creamMuted,marginTop:5}}>{s.l}</div>
                </div>
              ))}
            </div>
            <Card style={{marginBottom:12}}>
              <SecTitle>RECENT ORDERS</SecTitle>
              {orders.length===0
                ? <div style={{color:G.creamMuted,fontSize:13,textAlign:"center",padding:"16px 0"}}>주문 없음</div>
                : orders.slice(0,5).map((o,i)=>(
                  <div key={o.id} style={{display:"flex",alignItems:"center",gap:8,padding:"9px 0",borderTop:i>0?`1px solid ${G.border}`:"none"}}>
                    <span style={{fontFamily:SF,fontSize:11,color:G.copper,fontWeight:700,minWidth:44}}>{o.id}</span>
                    <span style={{fontWeight:600,flex:1,fontSize:13}}>{o.customer}</span>
                    <span style={{fontSize:11,color:G.creamMuted}}>{o.items.reduce((a,i)=>a+i.qty,0)}마</span>
                    <Tag c={sC(o.status)[0]} bg={sC(o.status)[1]}>{o.status}</Tag>
                  </div>
                ))
              }
            </Card>
            <Card>
              <SecTitle>INVENTORY</SecTitle>
              {inv.map(i=>(
                <div key={i.id} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
                    <span style={{fontWeight:600}}>{i.fabric} <span style={{color:G.creamMuted,fontWeight:400}}>{i.color}</span></span>
                    <span style={{fontWeight:700,color:i.stock<settings.lowStockAlert?G.red:i.stock<30?G.yellow:G.green}}>{i.stock}마</span>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,0.05)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${Math.min(100,(i.stock/100)*100)}%`,background:i.stock<settings.lowStockAlert?G.red:i.stock<30?G.yellow:G.copper,borderRadius:2,transition:"width 0.5s"}}/>
                  </div>
                </div>
              ))}
            </Card>

            {/* 월별 매출 차트 */}
            <Card style={{marginBottom:12}}>
              <SecTitle>월별 매출 추이</SecTitle>
              <div style={{display:"flex",alignItems:"flex-end",gap:3,height:80,paddingBottom:4}}>
                {INIT_DATA.monthly.map((m,i)=>{
                  const max=Math.max(...INIT_DATA.monthly.map(x=>x.value));
                  const h=max>0?Math.max(4,Math.round((m.value/max)*72)):4;
                  return (
                    <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                      <div style={{width:"100%",height:h,background:i===INIT_DATA.monthly.length-1?G.copper:`${G.copper}60`,borderRadius:"3px 3px 0 0",transition:"height 0.5s"}}/>
                      <div style={{fontSize:8,color:G.creamMuted,transform:"rotate(-45deg)",whiteSpace:"nowrap"}}>{m.label.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* 온라인 채널 */}
            <Card style={{marginBottom:12}}>
              <SecTitle>온라인 채널별 매출 (2026)</SecTitle>
              {INIT_DATA.online.filter(o=>o.amt2026>0).map((o,i)=>(
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                    <span style={{fontWeight:600}}>{o.platform}</span>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      <span style={{fontSize:11,color:G.creamMuted}}>{o.cnt2026}건</span>
                      <span style={{fontWeight:700,color:G.copper}}>{o.amt2026.toLocaleString()}원</span>
                    </div>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,0.05)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${Math.min(100,(o.amt2026/Math.max(...INIT_DATA.online.map(x=>x.amt2026||1)))*100)}%`,background:G.copper,borderRadius:2}}/>
                  </div>
                </div>
              ))}
            </Card>

            {/* TOP 원단 */}
            <Card style={{marginBottom:12}}>
              <SecTitle>TOP 원단 매출</SecTitle>
              {INIT_DATA.fabrics.slice(0,8).map((f,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderTop:i>0?`1px solid ${G.border}`:"none"}}>
                  <span style={{fontFamily:SF,fontSize:11,color:G.copper,fontWeight:700,minWidth:18}}>{i+1}</span>
                  <span style={{flex:1,fontSize:13,fontWeight:600}}>{f.name}</span>
                  <span style={{fontSize:11,color:G.creamMuted}}>{f.qty.toFixed(0)}마</span>
                  <span style={{fontSize:12,fontWeight:700,color:G.cream}}>{f.amount.toLocaleString()}원</span>
                </div>
              ))}
            </Card>

            {/* 담당자별 매출 */}
            <Card>
              <SecTitle>담당자별 누적 매출</SecTitle>
              {INIT_DATA.staff.filter(s=>s.total>0).map((s,i)=>(
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                    <span style={{fontWeight:600}}>{s.name}</span>
                    <span style={{fontWeight:700,color:G.copper}}>{s.total.toLocaleString()}원</span>
                  </div>
                  <div style={{height:4,background:"rgba(255,255,255,0.05)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${Math.min(100,(s.total/Math.max(...INIT_DATA.staff.map(x=>x.total||1)))*100)}%`,background:G.blue,borderRadius:2}}/>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {tab===6 && (
          <div>
            <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:20,color:T.cream}}>설정</div>

            {/* 테마 */}
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>화면 테마</SecTitle>
              <div style={{display:"flex",gap:10}}>
                {["dark","light"].map(th=>(
                  <button key={th} onClick={()=>{setTheme(th);localStorage.setItem("erp_theme",th);}} style={{
                    flex:1,padding:"14px 0",borderRadius:12,cursor:"pointer",fontFamily:S,fontWeight:700,fontSize:13,
                    border:`2px solid ${theme===th?T.copper:T.border}`,
                    background:theme===th?T.copperGlow:(th==="dark"?"#0D0B09":"#F5F0E8"),
                    color:theme===th?T.copper:(th==="dark"?"#F0E6D6":"#1A1612"),
                    display:"flex",flexDirection:"column",alignItems:"center",gap:6,transition:"all 0.2s",
                  }}>
                    <span style={{fontSize:22}}>{th==="dark"?"🌙":"☀️"}</span>
                    <span>{th==="dark"?"다크 모드":"화이트 모드"}</span>
                  </button>
                ))}
              </div>
            </Card>

            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>더브릿지 소개 페이지</SecTitle>
              <div style={{fontSize:12,color:G.creamMuted,marginBottom:10,lineHeight:1.7}}>
                더브릿지 서비스 소개 · 요금제 · 데모 체험
              </div>
              <button onClick={()=>{
                window.open("https://claude.site/artifacts/8e57d5de-2c70-4783-b7a9-fd0fe8a05e49","_blank");
              }} style={{width:"100%",padding:13,borderRadius:10,border:`1.5px solid ${G.copper}`,
                background:G.copperGlow,color:G.copper,fontWeight:800,fontSize:14,
                cursor:"pointer",fontFamily:S,marginBottom:8}}>
                🌐 더브릿지 랜딩페이지 바로가기
              </button>
              <button onClick={()=>{
                const url = "https://claude.site/artifacts/8e57d5de-2c70-4783-b7a9-fd0fe8a05e49";
                if(navigator.clipboard) navigator.clipboard.writeText(url).then(()=>showToast("✓ 랜딩페이지 링크 복사!"));
                else showToast("위 버튼을 탭해서 접속하세요");
              }} style={{width:"100%",padding:11,borderRadius:10,border:`1px solid ${G.border}`,
                background:"transparent",color:G.creamMuted,fontWeight:700,fontSize:13,
                cursor:"pointer",fontFamily:S}}>
                🔗 링크 복사
              </button>
            </Card>

            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>AI 주문 분석</SecTitle>
              <div style={{marginBottom:10}}>
                <FLabel>Anthropic API Key</FLabel>
                {settings.anthropicKey ? (
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <div style={{...baseInp,flex:1,cursor:"not-allowed",opacity:0.6,letterSpacing:3}}>••••••••••••••••</div>
                    <GhostBtn small color={G.red} onClick={()=>setSettings(s=>({...s,anthropicKey:""}))}>초기화</GhostBtn>
                  </div>
                ) : (
                  <input type="password" value="" onChange={e=>setSettings(s=>({...s,anthropicKey:e.target.value}))} placeholder="sk-ant-..." style={baseInp}/>
                )}
              </div>
              <div style={{fontSize:11,color:G.creamMuted,lineHeight:1.5}}>AI 주문 분석 기능에 사용됩니다. 키는 브라우저에만 저장됩니다.</div>
            </Card>

            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>발송인 정보 (송장 출력용)</SecTitle>
              {[{k:"senderName",l:"상호명",ph:"로하이마켓"},{k:"senderPhone",l:"연락처",ph:"010-0000-0000"},{k:"senderAddr",l:"주소",ph:"서울 중구 동대문"}].map(({k,l,ph})=>(
                <div key={k} style={{marginBottom:10}}>
                  <FLabel>{l}</FLabel>
                  <input value={settings[k]} onChange={e=>setSettings(s=>({...s,[k]:e.target.value}))} placeholder={ph} style={baseInp}/>
                </div>
              ))}
              <PrimaryBtn onClick={()=>setShippingOpen(true)} full>🚚 택배 송장 출력</PrimaryBtn>
            </Card>
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>카카오톡 알림</SecTitle>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <span style={{fontSize:13,color:G.creamMuted}}>{settings.kakaoEnabled?"활성화":"비활성화"}</span>
                <div style={{width:38,height:22,borderRadius:11,background:settings.kakaoEnabled?G.copper:G.border,position:"relative",cursor:"pointer"}} onClick={()=>setSettings(s=>({...s,kakaoEnabled:!s.kakaoEnabled}))}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:G.white,position:"absolute",top:2,left:settings.kakaoEnabled?18:2,transition:"left 0.2s"}}/>
                </div>
              </div>
              <div style={{marginBottom:10}}><FLabel>Webhook URL</FLabel><input value={settings.kakaoWebhook} onChange={e=>setSettings(s=>({...s,kakaoWebhook:e.target.value}))} placeholder="https://n8n.your-server.com/webhook/..." style={baseInp}/></div>
              <div style={{marginBottom:12}}><FLabel>저재고 기준 (마)</FLabel><input type="number" value={settings.lowStockAlert} onChange={e=>setSettings(s=>({...s,lowStockAlert:parseInt(e.target.value)||10}))} style={baseInp}/></div>
              <GhostBtn onClick={()=>kakaoAlert("🔔 로하이마켓 ERP 테스트 알림")} full>테스트 전송</GhostBtn>
            </Card>
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>📂 엑셀 파일 업로드</SecTitle>
              <ExcelImport orders={orders} setOrders={setOrders} customers={customers} setCustomers={setCustomers} showToast={showToast} />
            </Card>

            <Card style={{background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>데이터 내보내기</SecTitle>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <GhostBtn onClick={exportOrders} full>⬇ 주문현황 엑셀</GhostBtn>
                <GhostBtn onClick={exportLogs} full>⬇ 입출고이력 엑셀</GhostBtn>
                <GhostBtn onClick={exportCustomers} full>⬇ 고객목록 엑셀</GhostBtn>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

export default ErpApp;
