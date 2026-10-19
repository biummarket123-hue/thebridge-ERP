import { useState, useEffect, useRef } from "react";
import { CourierField } from "./Courier.jsx";
import { SF, S, baseInp, useTheme } from "../constants.js";
import { loadPostcodeScript } from "../lib/postcode.js";
import { isRollUnit } from "../lib/rollStock.js";

function Tag({c, bg, children}) {
  return <span style={{display:"inline-flex",alignItems:"center",padding:"2px 9px",borderRadius:20,fontSize:11,fontWeight:700,fontFamily:S,color:c,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
}
function SecTitle({children}) {
  const G = useTheme();
  return <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.08em",marginBottom:12,textTransform:"uppercase"}}>{children}</div>;
}
// onClick·className 을 받는다 — 주문현황 선택 모드에서 카드 전체가 선택 버튼이 된다.
function Card({children, style, onClick, className = ""}) {
  const G = useTheme();
  return <div className={`erp-card${className ? " " + className : ""}`} onClick={onClick}
    style={{background:G.card,borderRadius:14,border:`1px solid ${G.border}`,boxShadow:G.cardShadow,padding:16,...style}}>{children}</div>;
}
function Empty({text, sub}) {
  const G = useTheme();
  return (
    <div style={{padding:"50px 0",textAlign:"center"}}>
      <div style={{fontSize:28,opacity:.18,marginBottom:10}}>◇</div>
      <div style={{fontSize:14,color:G.creamMuted,fontWeight:600}}>{text}</div>
      {sub && <div style={{fontSize:12,color:G.creamMuted,opacity:0.6,marginTop:5}}>{sub}</div>}
    </div>
  );
}
function Toast({msg, type}) {
  const G = useTheme();
  if (!msg) return null;
  return (
    // 좁은 화면에서 잘리지 않게 — 예전엔 whiteSpace:nowrap 에 폭 제한이 없어서
    // "📦 보관 요청 — 포장직원이 창고에 넣으면 보관중이 됩니다" 같은 긴 안내가
    // 화면 밖으로 삐져나갔다. 정작 그 긴 문장들이 사람이 읽어야 하는 내용이다.
    // 이제 화면 폭에 맞춰 줄바꿈한다(좌우 16px 은 여백).
    <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",padding:"11px 20px",borderRadius:12,background:type==="error"?G.red:G.green,color:"#fff",fontWeight:700,fontSize:13,zIndex:999,boxShadow:"0 4px 20px rgba(0,0,0,0.25)",fontFamily:S,maxWidth:"calc(100% - 32px)",width:"max-content",boxSizing:"border-box",textAlign:"center",lineHeight:1.45,wordBreak:"keep-all"}}>
      {type==="error" ? "✕ " : "✓ "}{msg}
    </div>
  );
}
function PrimaryBtn({onClick, disabled, children, full}) {
  const G = useTheme();
  return (
    <button onClick={disabled ? undefined : onClick} style={{padding:"12px 20px",width:full?"100%":"auto",borderRadius:10,border:"none",background:disabled?G.border:G.copper,color:disabled?G.creamMuted:"#fff",fontWeight:700,fontSize:14,cursor:disabled?"not-allowed":"pointer",fontFamily:S,boxShadow:disabled?"none":`0 2px 8px ${G.copperGlow}`}}>
      {children}
    </button>
  );
}
function GhostBtn({onClick, children, small, color, full}) {
  const G = useTheme();
  return (
    <button onClick={onClick} style={{padding:small?"6px 11px":"11px 16px",width:full?"100%":"auto",borderRadius:small?7:10,border:`1px solid ${color||G.border}`,background:color?`${color}10`:"transparent",color:color||G.creamMuted,fontWeight:600,fontSize:small?11:13,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",boxSizing:"border-box"}}>
      {children}
    </button>
  );
}
function FLabel({children}) {
  const G = useTheme();
  return <div style={{fontSize:11,color:G.creamMuted,marginBottom:4,fontWeight:500}}>{children}</div>;
}

// 고객 검색용 — 전화번호 가운데 4자리 추출 (OrderInput과 동일 로직)
function extractMidPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^0-9]/g,"");
  if (cleaned.length >= 10) return cleaned.slice(3,7);
  if (cleaned.length === 4) return cleaned;  // 마켓원장 import: 가운데 4자리만 저장된 케이스
  return null;
}

// ── Modals ───────────────────────────────────────────────────
function ConfirmModal({item, onConfirm, onCancel}) {
  const G = useTheme();
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20,backdropFilter:"blur(4px)"}}>
      <div style={{background:G.card,borderRadius:16,border:`1px solid ${G.border}`,boxShadow:"0 20px 60px rgba(0,0,0,0.15)",padding:24,width:"100%",maxWidth:320,textAlign:"center"}}>
        <div style={{fontSize:30,marginBottom:10}}>🗑</div>
        <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.cream,marginBottom:8}}>삭제 확인</div>
        <div style={{fontSize:13,color:G.creamMuted,marginBottom:20,lineHeight:1.7}}>
          <b style={{color:G.cream}}>{item.label}</b><br/>삭제하시겠습니까?
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onConfirm} style={{flex:1,padding:"12px",borderRadius:10,border:"none",background:G.red,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:S}}>삭제</button>
          <button onClick={onCancel} style={{flex:1,padding:"12px",borderRadius:10,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:14,cursor:"pointer",fontFamily:S}}>취소</button>
        </div>
      </div>
    </div>
  );
}

function EditOrderModal({order, onSave, onClose, memoOnly=false, customers=[], creditBal=0, fsBal=0}) {
  const G = useTheme();
  const [o, setO] = useState({...order, items: order.items.map(i=>({...i}))});
  const [creditUse, setCreditUse] = useState(0); // 이 저장에서 새로 쓸 적립금 — 저장 뒤 db.applyOrderCredit 로 차감
  const [creditKeep, setCreditKeep] = useState(true); // 이미 쓴 적립금 — false 면 저장 시 사용 취소(돌려주고 로그 삭제)
  const [fsUse, setFsUse] = useState(!!order.freeShippingUsed); // 무료배송권 — 저장 시 켜면 1장 차감, 끄면 1장 복원
  const [links, setLinks] = useState(order.links?.length ? [...order.links] : [""]); // URL 링크 편집 (빈 값은 저장 시 제거)
  const [newImgs, setNewImgs] = useState([]); // File[] — 저장 시 업로드할 새 이미지
  const [saving, setSaving] = useState(false); // 이미지 업로드 포함 저장 중 (중복 저장 방지)
  const [custFocus, setCustFocus] = useState(false);
  const [custDirty, setCustDirty] = useState(false); // 모달 열린 후 고객명을 실제로 타이핑했을 때만 검색 드롭다운 표시
  const [pickedCust, setPickedCust] = useState(null); // 검색으로 선택한 고객 — 연락처·배송지 자동 반영 안내용
  const imgFileRef = useRef(null);
  const MAX_ORDER_IMAGES = 10;

  // 고객 자동완성 — 이름/닉네임/연락처 부분 일치 (최대 8명, OrderInput과 동일)
  const custQ = (o.customer||"").trim().toLowerCase();
  const custSuggestions = (custFocus && custDirty && custQ)
    ? customers.filter(c => {
        const digits = custQ.replace(/\D/g,"");
        return (c.name && c.name.toLowerCase().includes(custQ))
          || (c.nickname && c.nickname.toLowerCase().includes(custQ))
          || (digits && c.phone && c.phone.replace(/\D/g,"").includes(digits));
      }).slice(0, 8)
    : [];

  const pickCustomer = (c) => {
    setO(p=>({...p, customer:c.name||"", phone:c.phone||"", address:c.address||"", addressDetail:c.addressDetail||""}));
    setPickedCust(c);
    setCustDirty(false);
    setCustFocus(false);
  };

  const addImgs = (fileList) => {
    const files = Array.from(fileList||[]).filter(f=>f.type?.startsWith("image/"));
    if (!files.length) return;
    setNewImgs(prev=>{
      const room = MAX_ORDER_IMAGES - (o.images||[]).length - prev.length;
      return room > 0 ? [...prev, ...files.slice(0, room)] : prev;
    });
  };
  // ── 적립금 — 수정창에서도 쓸 수 있다 (2026-10-07). 돈 계산이 틀어질 길은 전부 여기서 막는다.
  //  · 돈이 들어온 주문(입금완료·부분환불·환불완료·환불신청)에는 안 보인다. 플래그만 입금완료인
  //    옛 주문에 차감 로그를 넣으면 입금완료 폴백이 꺼져 '부분입금'으로 되돌아간다.
  //  · 결제상태 칸을 입금완료로 바꾼 채로도 안 보인다.
  //  · 고객명을 바꾼 저장에는 안 쓴다 — 적립금은 고객 이름으로 묶여 있어 어느 잔액인지 애매하다.
  //  · 한도 = min(잔액, 바뀐 총액 기준 미수금). 총액을 같은 창에서 낮추면 한도도 같이 줄어든다.
  //    저장 직전 잔액은 db.applyOrderCredit 가 한 번 더 깎는다.
  const paidStatus = ["입금완료", "부분환불", "환불완료"];
  const statusNow = order._computed?.paymentStatus || order.payment;
  const moneyIn = paidStatus.includes(statusNow) || order.payment === "환불신청" || order.payment === "환불";
  const customerChanged = (o.customer || "").trim() !== (order.customer || "").trim();
  const newTotal = parseInt(o.totalAmount) || 0;
  // ── 무료배송권 — 카드 토글 대신 여기서(2026-10-07). 적립금과 같은 가드.
  //  · 켜기: 보유 ≥1 + 저장할 배송비 > 0. 배송권차감 로그는 "저장할 배송비" 금액으로 남는다.
  //  · 끄기(이미 쓴 주문): 저장 시 1장 복원 + 로그 삭제. 입금완료가 된 주문도 끌 수는 있다(미수금이 다시 생긴다).
  //  · 켠 채로 배송비를 바꾸면 저장 시 취소 후 새 금액으로 다시 적용한다(장수는 그대로).
  //  · 켠 채로 배송비를 0 으로 바꾸면 저장 못 한다 — 먼저 끄거나 배송비를 돌려놓아야 한다.
  const wasUsed = !!order.freeShippingUsed;
  const newFee = parseInt(o.shippingFee) || 0;
  const oldFee = parseInt(order.shippingFee) || 0;
  const fsVisible = !memoOnly && (!moneyIn || (wasUsed && statusNow === "입금완료")) && (o.payment !== "입금완료" || wasUsed);
  const fsOn = fsVisible && !customerChanged ? fsUse : wasUsed;      // 저장 뒤 상태
  const fsCanTurnOn = !wasUsed && (fsBal || 0) >= 1 && !moneyIn && o.payment !== "입금완료";
  const fsFeeZero = fsOn && newFee <= 0;                              // 켠 채 배송비 0 → 저장 막음
  // 적립금 한도 — 바뀐 총액에서 이미 받은 돈을 빼고, 이 저장에서 배송권이 바뀌는 만큼도 미리 반영한다.
  const fsDelta = (fsOn ? newFee : 0) - (wasUsed ? oldFee : 0);      // 배송권으로 '받은 돈'이 이 저장에서 얼마나 바뀌나
  const unpaidBase = Math.max(0, newTotal - (order._computed?.rawDepositAmount || 0) - fsDelta);
  // 이미 쓴 적립금 — 무료배송권처럼 "사용 유지 / 사용 취소". 취소하면 그 금액이 미수금으로 되돌아온다.
  // 적립금으로 완납된 주문도 취소는 할 수 있다(배송권과 같은 조건). 환불이 걸린 주문은 못 한다.
  const creditUsedNow = order._computed?.creditUsed || 0;
  const creditCancelable = !memoOnly && creditUsedNow > 0 && !customerChanged && (!moneyIn || statusNow === "입금완료");
  const creditCancel = creditCancelable && !creditKeep;
  const unpaid = creditCancel ? unpaidBase + creditUsedNow : unpaidBase;   // 취소하면 그만큼 미수금이 돌아온다
  const creditMax = Math.max(0, Math.min(creditBal || 0, unpaid));
  // 잔액이 0 이어도 칸은 보인다("보유 0원") — 숨기면 기능이 있는지조차 모른다. 입력칸만 안 준다.
  const creditVisible = !memoOnly && ((!moneyIn && o.payment !== "입금완료") || creditCancelable);
  const creditAddable = creditVisible && !moneyIn && o.payment !== "입금완료" && !creditCancel;   // 새로 더 쓸 수 있는가
  const creditWant = creditAddable && !customerChanged && (creditBal || 0) > 0 ? (parseInt(creditUse) || 0) : 0;
  const creditOver = creditWant > creditMax;
  // 적립금·배송권을 이미 쓴 주문은 고객명을 못 바꾼다 — 둘 다 고객 이름으로 묶여 있어서,
  // 이름을 바꾸면 삭제·취소 때 복원이 새 이름으로 들어가고 원래 고객 잔액은 빈다.
  const nameLocked = !memoOnly && ((order._computed?.creditUsed || 0) > 0 || !!order.freeShippingUsed);

  const save = async () => {
    if (saving) return;
    if (creditOver || fsFeeZero) return; // 칸 아래 빨간 글이 이유를 보여준다
    setSaving(true);
    try { await onSave({...o, links: links.map(l=>l.trim()).filter(Boolean), _creditUse: creditWant, _creditCancel: creditCancel, _fsUse: fsOn}, newImgs); } finally { setSaving(false); }
  };

  // 모달 열려있는 동안 뒤 화면(body) 스크롤 잠금 — 모달 내부 스크롤이 배경으로 전파되지 않게
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // 포장 담당자용 — 메모 / 담당자 메모(공유) 만 편집 가능한 축소 모드
  if (memoOnly) {
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}} onClick={onClose}>
        <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,boxShadow:"0 -8px 30px rgba(0,0,0,0.12)",padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box",maxHeight:"calc(100% - 20px)",overflowY:"auto",overscrollBehavior:"contain"}} onClick={e=>e.stopPropagation()}>
          <div style={{fontFamily:SF,fontSize:17,fontWeight:700,color:G.cream,marginBottom:4}}>메모 수정 — #{String(o.id).slice(0,8)}</div>
          <div style={{fontSize:12,color:G.creamMuted,marginBottom:16}}>{o.customer}{(o.items||[]).length>0?` · ${o.items.map(i=>`${i.fabric}${i.qty?` ${i.qty}${i.unit||"마"}`:""}`).join(", ")}`:""}</div>
          <div style={{marginBottom:10}}><FLabel>메모</FLabel><input value={o.note||""} onChange={e=>setO(p=>({...p,note:e.target.value}))} placeholder="메모 입력" style={baseInp}/></div>
          <div style={{marginBottom:10}}>
            <FLabel>📝 담당자 메모 (공유)</FLabel>
            <textarea
              value={o.memo||""}
              onChange={e=>setO(p=>({...p,memo:e.target.value}))}
              placeholder="예: 고객 부재 시 경비실 맡김, 색상 다시 확인 등"
              rows={3}
              style={{...baseInp,resize:"vertical",minHeight:60,fontFamily:"inherit",lineHeight:1.5}}
            />
            <div style={{fontSize:10,color:G.creamMuted,marginTop:3}}>담당자들이 함께 볼 수 있는 메모입니다</div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:16}}>
            <PrimaryBtn onClick={()=>onSave(o)} full>저장</PrimaryBtn>
            <GhostBtn onClick={onClose}>취소</GhostBtn>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,boxShadow:"0 -8px 30px rgba(0,0,0,0.12)",padding:"0 22px 22px",width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box",maxHeight:"calc(100% - 20px)",overflowY:"auto",overscrollBehavior:"contain"}} onClick={e=>e.stopPropagation()}>
        {/* 제목 줄 — sticky로 고정해서 스크롤해도 상단이 잘리지 않고, 언제든 ✕로 닫기 가능 */}
        <div style={{position:"sticky",top:0,zIndex:5,background:G.card,padding:"20px 0 12px",marginBottom:4,display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${G.border}`}}>
          <span style={{fontFamily:SF,fontSize:17,fontWeight:700,color:G.cream}}>주문 수정 — #{String(o.id).slice(0,8)}</span>
          <button onClick={onClose} style={{width:28,height:28,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:13,cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
        </div>
        <div style={{marginBottom:10}}>
          <FLabel>고객명</FLabel>
          <div style={{position:"relative"}}>
            <input
              value={o.customer}
              onChange={e=>{setO(p=>({...p,customer:e.target.value}));setCustDirty(true);setPickedCust(null);}}
              onFocus={()=>setCustFocus(true)}
              onBlur={()=>setTimeout(()=>setCustFocus(false),150)}
              placeholder="고객 검색 — 이름 · 닉네임 · 연락처"
              readOnly={nameLocked}
              title={nameLocked ? "적립금·무료배송권을 쓴 주문은 고객명을 바꿀 수 없습니다" : undefined}
              style={{...baseInp,width:"100%",boxSizing:"border-box",...(nameLocked?{opacity:0.6,cursor:"not-allowed"}:{})}}/>
            {custSuggestions.length>0 && (
              <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:60,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden",maxHeight:240,overflowY:"auto"}}>
                {custSuggestions.map(c=>(
                  <div key={c.id} onMouseDown={()=>pickCustomer(c)}
                    style={{padding:"9px 12px",cursor:"pointer",borderBottom:`1px solid ${G.border}`,fontFamily:S}}
                    onMouseEnter={e=>e.currentTarget.style.background=G.surface}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{fontSize:13,fontWeight:700,color:G.cream,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span>{c.name}</span>
                      {c.nickname?<span style={{fontSize:11,color:G.creamMuted,fontWeight:500}}>{c.nickname}</span>:null}
                      {extractMidPhone(c.phone) && <span style={{fontSize:11,fontWeight:700,fontFamily:SF,color:G.copper,background:G.copperGlow,border:`1px solid ${G.copper}40`,borderRadius:6,padding:"1px 6px"}}>{extractMidPhone(c.phone)}</span>}
                    </div>
                    <div style={{fontSize:11,color:G.creamMuted,marginTop:2}}>{c.phone||"연락처 없음"}{c.address?` · ${c.address}`:""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {pickedCust && <div style={{fontSize:10,color:G.green,fontWeight:700,marginTop:3}}>✓ {pickedCust.name} 고객 정보로 연락처·배송지가 채워졌습니다</div>}
          {nameLocked && <div style={{fontSize:10,color:G.creamMuted,marginTop:3}}>적립금·무료배송권을 쓴 주문이라 고객명은 바꿀 수 없습니다</div>}
        </div>
        <div style={{marginBottom:10}}><FLabel>연락처</FLabel><input value={o.phone||""} onChange={e=>setO(p=>({...p,phone:e.target.value}))} style={baseInp}/></div>
        {/* 처리상태는 여기서 못 바꾼다. 이 창에서 출고완료를 고르면 관리자 확인·입금 확인·
            합배송 묶음·재고 차감·출고 시각을 전부 건너뛰고 상태만 바뀌었다 — 미아 주문이
            생기는 길이었다. 상태는 주문 카드의 버튼(접수·포장완료·보관·출고완료)으로만 바꾼다. */}
        <div style={{marginBottom:10}}>
          <FLabel>결제상태</FLabel>
          <select value={o.payment} onChange={e=>setO(p=>({...p,payment:e.target.value}))} style={{...baseInp}}>
            <option>미입금</option>
            <option>입금완료</option>
          </select>
        </div>
        <div style={{marginBottom:10}}>
          <CourierField memo={`${o.note||""}\n${o.memo||""}`} value={o.courier||null} onChange={v=>setO(p=>({...p,courier:v}))}/>
        </div>
        {/* 주소/상세주소 분리 편집 — 한 칸으로 합쳐 편집하면 안 보이는 address_detail에 잘못된 값이 남는 사고 방지 */}
        <div style={{marginBottom:10}}><FLabel>배송지 주소</FLabel><input value={o.address||""} onChange={e=>setO(p=>({...p,address:e.target.value}))} placeholder="도로명/지번 주소" style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>상세주소</FLabel><input value={o.addressDetail||""} onChange={e=>setO(p=>({...p,addressDetail:e.target.value}))} placeholder="동·호수 등 (없으면 비워두세요)" style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>메모</FLabel><input value={o.note||""} onChange={e=>setO(p=>({...p,note:e.target.value}))} placeholder="메모 입력" style={baseInp}/></div>
        <div style={{marginBottom:10}}>
          <FLabel>📝 담당자 메모 (공유)</FLabel>
          <textarea
            value={o.memo||""}
            onChange={e=>setO(p=>({...p,memo:e.target.value}))}
            placeholder="예: 고객 부재 시 경비실 맡김, 색상 다시 확인 등"
            rows={3}
            style={{...baseInp,resize:"vertical",minHeight:60,fontFamily:"inherit",lineHeight:1.5}}
          />
          <div style={{fontSize:10,color:G.creamMuted,marginTop:3}}>담당자들이 함께 볼 수 있는 메모입니다</div>
        </div>
        <div style={{marginBottom:10}}>
          <FLabel>영수증</FLabel>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[
              {v:null,         l:"발행 안 함",   c:G.creamMuted, bg:"transparent"},
              {v:"cash",       l:"🧾 현금영수증", c:G.red,        bg:G.redBg},
              {v:"business",   l:"📋 지출증빙",   c:G.blue,       bg:G.blueBg},
              {v:"tax_invoice",l:"📄 계산서",     c:G.green,      bg:G.greenBg},
            ].map(opt => {
              const active = (o.receiptType||null) === opt.v;
              return (
                <button key={String(opt.v)} type="button"
                  onClick={()=>setO(p=>({...p,receiptType:opt.v}))}
                  style={{
                    flex:"1 1 calc(50% - 3px)", minWidth:0,
                    padding:"9px 8px", borderRadius:8,
                    border:`1.5px solid ${active?opt.c:G.border}`,
                    background:active?opt.bg:"transparent",
                    color:active?opt.c:G.creamMuted,
                    fontWeight:active?800:600, fontSize:12,
                    cursor:"pointer", fontFamily:S, transition:"all .15s",
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
                  }}>
                  {opt.l}
                </button>
              );
            })}
          </div>
        </div>
        {/* URL 링크 편집 — OrderInput과 동일 UX (추가/수정/삭제, 빈 값은 저장 시 제거) */}
        <div style={{marginBottom:10}}>
          <FLabel>🔗 URL 링크 (밴드글 · 상품 등)</FLabel>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {links.map((lnk,i)=>(
              <div key={i} style={{display:"flex",gap:6,alignItems:"center"}}>
                <input value={lnk} onChange={e=>setLinks(p=>p.map((x,j)=>j===i?e.target.value:x))} placeholder="https://band.us/band/..." style={{...baseInp,flex:1,minWidth:0,boxSizing:"border-box",fontSize:12}}/>
                {lnk.trim() && <button type="button" onClick={()=>window.open(lnk,"_blank")} title="새 창에서 열기" style={{padding:"0 10px",height:38,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.blue,cursor:"pointer",fontFamily:S,fontSize:13,flexShrink:0}}>↗</button>}
                {links.length>1 && <button onClick={()=>setLinks(p=>p.filter((_,j)=>j!==i))} style={{padding:"0 10px",height:38,borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S,fontSize:14,flexShrink:0}}>✕</button>}
              </div>
            ))}
          </div>
          <button onClick={()=>setLinks(p=>[...p,""])} style={{width:"100%",marginTop:6,padding:"7px",fontSize:12,color:G.copper,background:"transparent",border:`1px dashed ${G.border}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>+ 링크 추가</button>
        </div>
        <div style={{marginBottom:10}}>
          <FLabel>📷 이미지 ({(o.images||[]).length + newImgs.length}/{MAX_ORDER_IMAGES})</FLabel>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {/* 기존 이미지 (URL) — ✕ 누르면 목록에서 제거 (저장 시 반영) */}
            {(o.images||[]).map((url,i)=>(
              <div key={url} style={{position:"relative",width:64,height:64,borderRadius:8,overflow:"hidden",border:`1px solid ${G.border}`,flexShrink:0}}>
                <img src={url} alt="" onClick={()=>window.open(url,"_blank")} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"zoom-in",display:"block"}}/>
                <button onClick={()=>setO(p=>({...p,images:(p.images||[]).filter((_,j)=>j!==i)}))} style={{position:"absolute",top:2,right:2,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(0,0,0,0.6)",color:"#fff",fontSize:11,cursor:"pointer",padding:0,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            ))}
            {/* 새로 첨부한 이미지 (File) — 저장 시 업로드 */}
            {newImgs.map((f,i)=>(
              <div key={i} style={{position:"relative",width:64,height:64,borderRadius:8,overflow:"hidden",border:`1.5px dashed ${G.copper}`,flexShrink:0}}>
                <img src={URL.createObjectURL(f)} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                <button onClick={()=>setNewImgs(prev=>prev.filter((_,j)=>j!==i))} style={{position:"absolute",top:2,right:2,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(0,0,0,0.6)",color:"#fff",fontSize:11,cursor:"pointer",padding:0,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            ))}
            {(o.images||[]).length + newImgs.length < MAX_ORDER_IMAGES && (
              <button onClick={()=>imgFileRef.current?.click()} title="이미지 추가"
                style={{width:64,height:64,borderRadius:8,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:22,cursor:"pointer",flexShrink:0}}>＋</button>
            )}
          </div>
          <input ref={imgFileRef} type="file" multiple accept="image/*" onChange={e=>{addImgs(e.target.files);e.target.value="";}} style={{display:"none"}}/>
          {newImgs.length>0 && <div style={{fontSize:10,color:G.copper,marginTop:3}}>새 이미지 {newImgs.length}장 — 저장을 누르면 업로드됩니다</div>}
        </div>
        <div style={{marginBottom:10}}>
          <FLabel>원단 항목</FLabel>
          {o.items.length>0 && (
            <div style={{display:"flex",gap:4,marginBottom:4,alignItems:"center",fontSize:10,color:G.creamMuted,fontWeight:700,letterSpacing:"0.04em",paddingLeft:2}}>
              <div style={{width:56,textAlign:"center"}}>No</div>
              <div style={{flex:"1 1 100px",minWidth:80,paddingLeft:4}}>원단명</div>
              <div style={{width:50,textAlign:"center"}}>수량</div>
              <div style={{width:56,textAlign:"center"}}>단위</div>
              <div style={{width:70,textAlign:"center"}}>단가</div>
              <div style={{width:80,textAlign:"center"}}>합금액</div>
              <div style={{width:32}}></div>
            </div>
          )}
          {o.items.map((item,i)=>{
            const qty = parseFloat(item.qty)||0;
            const amt = parseInt(item.amount)||0;
            // 단가는 저장값 우선, 없으면 합금액/수량 역산 (legacy 호환)
            // 롤·필 줄의 '단가'는 롤 1개 가격(2026-10-07) — 금액에서 역산. 마당 단가가 저장된 옛 주문도 여기서 수량이나 단가를
            // 고치면 롤 가격 기준으로 다시 쓰인다(전에는 단가 칸을 건드리는 순간 125,000원이 5,000원이 됐다).
            const roll = isRollUnit(item.unit);
            const unitPrice = roll && qty>0 && amt>0 ? Math.round(amt/qty) : ((parseInt(item.unitPrice)||0) || (qty>0 ? Math.round(amt/qty) : 0));
            const setItem = (patch)=>setO(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,...patch}:x)}));
            // 항목 금액 변경 → 전체금액(항목합+배송비+기타비용) 자동 재계산
            const setItemMoney = (patch)=>setO(p=>{
              const items = p.items.map((x,j)=>j===i?{...x,...patch}:x);
              const itemsSum = items.reduce((s,x)=>s+(parseInt(x.amount)||0),0);
              return {...p, items, totalAmount: itemsSum + (parseInt(p.shippingFee)||0) + (parseInt(p.otherCost)||0)};
            });
            return (
              <div key={i} style={{display:"flex",gap:4,marginBottom:6,alignItems:"center",flexWrap:"wrap"}}>
                <input value={item.itemNo||""} onChange={e=>setItem({itemNo:e.target.value})} placeholder="No" style={{...baseInp,width:56,fontFamily:"monospace",fontSize:11,padding:"9px 6px"}}/>
                <input value={item.fabric} onChange={e=>setItem({fabric:e.target.value})} placeholder="원단명" style={{...baseInp,flex:"1 1 100px",minWidth:80,fontSize:12}}/>
                <input type="number" value={item.qty} onChange={e=>{const q=parseFloat(e.target.value)||0;setItemMoney(unitPrice>0?{qty:q,amount:Math.round(unitPrice*q),unitPrice}:{qty:q});}} placeholder="수량" style={{...baseInp,width:50,fontSize:12,padding:"9px 6px"}}/>
                <select value={item.unit||"마"} onChange={e=>setItem({unit:e.target.value})} style={{...baseInp,width:56,fontSize:12,padding:"9px 4px"}}>
                  <option>마</option>
                  <option>세트</option>
                  <option>필</option>
                  <option>롤</option>
                  <option>kg</option>
                </select>
                <input type="text" inputMode="numeric" value={unitPrice||""} onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setItemMoney({unitPrice:v,amount:Math.round(v*qty)});}} placeholder="단가" style={{...baseInp,width:70,fontSize:12,padding:"9px 6px"}}/>
                <input type="text" inputMode="numeric" value={amt||""} onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setItemMoney(qty>0?{amount:v,unitPrice:Math.round(v/qty)}:{amount:v});}} placeholder="합금액" style={{...baseInp,width:80,fontSize:12,padding:"9px 6px"}}/>
                <button onClick={()=>setO(p=>({...p,items:p.items.filter((_,j)=>j!==i)}))} style={{padding:"0 8px",height:38,borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S,fontSize:14,flexShrink:0}}>✕</button>
              </div>
            );
          })}
          <button onClick={()=>setO(p=>({...p,items:[...p.items,{itemNo:"",fabric:"",qty:0,unit:"마",amount:0,unitPrice:0}]}))} style={{width:"100%",marginTop:2,padding:"8px",fontSize:12,color:G.copper,background:"transparent",border:`1px dashed ${G.border}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>
            + 항목 추가
          </button>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            <div>
              <FLabel>배송비</FLabel>
              <input type="text" inputMode="numeric"
                value={o.shippingFee?Number(o.shippingFee).toLocaleString():""}
                onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setO(p=>{const itemsSum=(p.items||[]).reduce((s,x)=>s+(parseInt(x.amount)||0),0);return {...p,shippingFee:v,totalAmount:itemsSum+v+(parseInt(p.otherCost)||0)};});}}
                placeholder="0"
                style={{...baseInp,width:"100%",boxSizing:"border-box",fontFamily:SF,fontWeight:700,fontSize:13,color:G.blue,padding:"9px 8px",textAlign:"right"}}/>
            </div>
            <div>
              <FLabel>기타비용</FLabel>
              <input type="text" inputMode="numeric"
                value={o.otherCost?Number(o.otherCost).toLocaleString():""}
                onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setO(p=>{const itemsSum=(p.items||[]).reduce((s,x)=>s+(parseInt(x.amount)||0),0);return {...p,otherCost:v,totalAmount:itemsSum+(parseInt(p.shippingFee)||0)+v};});}}
                placeholder="0"
                style={{...baseInp,width:"100%",boxSizing:"border-box",fontFamily:SF,fontWeight:700,fontSize:13,color:G.cream,padding:"9px 8px",textAlign:"right"}}/>
            </div>
            <div>
              <FLabel>전체 금액</FLabel>
              <input type="text" inputMode="numeric"
                value={o.totalAmount?Number(o.totalAmount).toLocaleString():""}
                onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setO(p=>({...p,totalAmount:v}));}}
                placeholder="0"
                style={{...baseInp,width:"100%",boxSizing:"border-box",fontFamily:SF,fontWeight:700,fontSize:14,color:G.copper,padding:"9px 8px",textAlign:"right"}}/>
            </div>
          </div>
          {(()=>{
            const itemsSum = (o.items||[]).reduce((s,x)=>s+(parseInt(x.amount)||0),0);
            const ship = parseInt(o.shippingFee)||0;
            const other = parseInt(o.otherCost)||0;
            const expected = itemsSum + ship + other;
            if (expected === (parseInt(o.totalAmount)||0)) return null;
            return (
              <div style={{fontSize:10,color:G.creamMuted,marginTop:4,display:"flex",alignItems:"center",gap:6}}>
                <span>항목 합 + 배송비{other>0?" + 기타":""} = {expected.toLocaleString()}원</span>
                <button type="button" onClick={()=>setO(p=>({...p,totalAmount:expected}))}
                  style={{padding:"2px 8px",borderRadius:6,border:`1px solid ${G.copper}40`,background:"transparent",color:G.copper,fontSize:10,cursor:"pointer",fontFamily:S}}>
                  ↺ 자동
                </button>
              </div>
            );
          })()}
        </div>
        {/* 적립금(좌) · 무료배송권(우) — 주문등록과 같은 배치. 미입금 주문이면 둘 다 보인다. */}
        {(creditVisible || fsVisible) && (
          <div style={{display:"grid",gridTemplateColumns:(creditVisible && fsVisible)?"1fr 1fr":"1fr",gap:8,marginBottom:10}}>
            {creditVisible && (
              <div style={{padding:"10px 12px",background:`${G.purple}12`,borderRadius:8,border:`1px solid ${G.purple}40`,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:G.purple,fontWeight:800,letterSpacing:"0.04em"}}>💰 적립금</span>
                  <span style={{fontSize:11,color:G.purple,fontWeight:700}}>보유 {Number(creditBal||0).toLocaleString()}원{creditUsedNow > 0 ? ` · 이 주문에 ${creditUsedNow.toLocaleString()}원 사용 중` : ""}</span>
                </div>
                {creditCancelable && (
                  <div style={{display:"flex",gap:5,marginBottom:creditAddable?8:0}}>
                    {[{v:false,l:"사용 취소"},{v:true,l:"사용 유지"}].map(opt=>{
                      const active = creditKeep===opt.v;
                      return (
                        <button key={String(opt.v)} type="button" onClick={()=>{setCreditKeep(opt.v); if(!opt.v) setCreditUse(0);}}
                          style={{flex:1,minWidth:0,padding:"8px 4px",borderRadius:8,border:`1.5px solid ${active?(opt.v?G.purple:`${G.creamMuted}88`):G.border}`,background:active?(opt.v?`${G.purple}1A`:G.subtleBg):"transparent",color:active?(opt.v?G.purple:G.cream):G.creamMuted,fontWeight:active?800:600,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                          {opt.v&&active?"✓ ":""}{opt.l}
                        </button>
                      );
                    })}
                  </div>
                )}
                {creditCancel ? (
                  <div style={{fontSize:10,color:G.creamMuted}}>저장하면 {creditUsedNow.toLocaleString()}원을 돌려주고 미수금이 {unpaid.toLocaleString()}원이 됩니다</div>
                ) : !creditAddable ? (
                  null
                ) : (creditBal || 0) <= 0 ? (
                  <div style={{fontSize:11,color:G.creamMuted}}>쓸 적립금이 없습니다</div>
                ) : customerChanged ? (
                  <div style={{fontSize:11,color:G.creamMuted}}>고객명을 바꾼 저장에서는 쓸 수 없습니다</div>
                ) : (
                  <>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <input type="text" inputMode="numeric"
                        value={creditUse?Number(creditUse).toLocaleString():""}
                        onChange={e=>setCreditUse(parseInt(e.target.value.replace(/[^0-9]/g,""))||0)}
                        placeholder="0"
                        style={{...baseInp,flex:1,minWidth:0,boxSizing:"border-box",fontFamily:SF,fontWeight:700,fontSize:13,color:G.purple,padding:"9px 8px",textAlign:"right"}}/>
                      <button type="button" onClick={()=>setCreditUse(creditMax)}
                        style={{padding:"9px 10px",borderRadius:8,border:`1px solid ${G.purple}`,background:`${G.purple}1A`,color:G.purple,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S,flexShrink:0,whiteSpace:"nowrap"}}>
                        전액
                      </button>
                    </div>
                    {creditOver
                      ? <div style={{fontSize:10,color:G.red,marginTop:5,fontWeight:600}}>⚠ 최대 {creditMax.toLocaleString()}원 (잔액·미수금 중 적은 쪽)</div>
                      : <div style={{fontSize:10,color:G.creamMuted,marginTop:5}}>미수금 {unpaid.toLocaleString()}원{creditWant > 0 ? ` → 저장하면 ${(unpaid-creditWant).toLocaleString()}원` : ""}</div>}
                  </>
                )}
              </div>
            )}
            {fsVisible && (
              <div style={{padding:"10px 12px",background:G.greenBg,borderRadius:8,border:`1px solid ${G.green}40`,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:G.green,fontWeight:800,letterSpacing:"0.04em"}}>🎫 무료배송권</span>
                  <span style={{fontSize:11,color:G.green,fontWeight:700}}>보유 {fsBal||0}장{wasUsed ? " · 이 주문에 1장 사용 중" : ""}</span>
                </div>
                {customerChanged ? (
                  <div style={{fontSize:11,color:G.creamMuted}}>고객명을 바꾼 저장에서는 바꿀 수 없습니다</div>
                ) : (!wasUsed && !fsCanTurnOn) ? (
                  <div style={{fontSize:11,color:G.creamMuted}}>{(fsBal||0) < 1 ? "보유한 무료배송권이 없습니다" : "이 주문에는 쓸 수 없습니다"}</div>
                ) : (
                  <>
                    <div style={{display:"flex",gap:5}}>
                      {[{v:false,l:wasUsed?"사용 취소":"사용 안 함"},{v:true,l:wasUsed?"사용 유지":"사용"}].map(opt=>{
                        const active = fsUse===opt.v;
                        return (
                          <button key={String(opt.v)} type="button" onClick={()=>setFsUse(opt.v)}
                            style={{flex:1,minWidth:0,padding:"8px 4px",borderRadius:8,border:`1.5px solid ${active?(opt.v?G.green:`${G.creamMuted}88`):G.border}`,background:active?(opt.v?G.greenBg:G.subtleBg):"transparent",color:active?(opt.v?G.green:G.cream):G.creamMuted,fontWeight:active?800:600,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                            {opt.v&&active?"✓ ":""}{opt.l}
                          </button>
                        );
                      })}
                    </div>
                    {fsFeeZero
                      ? <div style={{fontSize:10,color:G.red,marginTop:5,fontWeight:600}}>⚠ 배송비가 0원이면 쓸 수 없습니다 — 끄거나 배송비를 넣으세요</div>
                      : wasUsed && !fsUse
                        ? <div style={{fontSize:10,color:G.creamMuted,marginTop:5}}>저장하면 1장 복원 · 미수금 {oldFee.toLocaleString()}원 다시 생김</div>
                        : wasUsed && fsUse && newFee !== oldFee
                          ? <div style={{fontSize:10,color:G.creamMuted,marginTop:5}}>배송비가 바뀌어 저장 시 {newFee.toLocaleString()}원으로 다시 적용</div>
                          : !wasUsed && fsUse
                            ? <div style={{fontSize:10,color:G.creamMuted,marginTop:5}}>저장하면 1장 차감 · 배송비 {newFee.toLocaleString()}원만큼 입금 인정</div>
                            : null}
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <PrimaryBtn onClick={save} disabled={saving||creditOver||fsFeeZero} full>{saving ? (newImgs.length>0 ? "이미지 올리는 중..." : "저장 중...") : "저장"}</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
    </div>
  );
}

function EditInvModal({item, onSave, onClose}) {
  const G = useTheme();
  const [it, setIt] = useState({...item});
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,boxShadow:"0 -8px 30px rgba(0,0,0,0.12)",padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,color:G.cream,marginBottom:16}}>재고 수정</div>
        <div style={{marginBottom:10}}><FLabel>아이템 No</FLabel><input value={it.item_no||""} onChange={e=>setIt(p=>({...p,item_no:e.target.value}))} placeholder="예: A-001" style={{...baseInp,fontFamily:"monospace"}}/></div>
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
  const G = useTheme();
  const [c, setC] = useState({...cust});
  const [addrTarget, setAddrTarget] = useState(null); // "address" | "address2" — 주소 검색 결과를 채울 필드
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div style={{background:G.card,borderRadius:"20px 20px 0 0",border:`1px solid ${G.border}`,boxShadow:"0 -8px 30px rgba(0,0,0,0.12)",padding:22,width:"100%",maxWidth:600,margin:"0 auto",boxSizing:"border-box",maxHeight:"calc(100% - 20px)",overflowY:"auto",overscrollBehavior:"contain"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:700,color:G.cream,marginBottom:16}}>고객 정보 수정</div>
        {[{k:"name",l:"고객명"},{k:"phone",l:"연락처",type:"tel"},{k:"nickname",l:"닉네임"},{k:"address",l:"배송지"},{k:"addressDetail",l:"상세주소"},{k:"note",l:"메모"}].map(({k,l,type})=>(
          <div key={k} style={{marginBottom:10}}>
            <FLabel>{l}</FLabel>
            {k==="address" ? (
              <div style={{display:"flex",gap:6}}>
                <input value={c.address||""} onChange={e=>setC(p=>({...p,address:e.target.value}))} placeholder="주소 검색을 눌러주세요" style={{...baseInp,flex:1,minWidth:0}}/>
                <button onClick={()=>setAddrTarget("address")} style={{flexShrink:0,padding:"0 14px",borderRadius:10,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:12,fontWeight:700,fontFamily:S,cursor:"pointer",whiteSpace:"nowrap"}}>🔍 검색</button>
              </div>
            ) : (
              <input type={type||"text"} inputMode={type==="tel"?"tel":undefined} value={c[k]||""} onChange={e=>setC(p=>({...p,[k]:e.target.value}))} style={baseInp}/>
            )}
          </div>
        ))}
        {/* ── 배송지 2 (선택) — 여기서만 입력/수정. 주문 등록으로 자동 변경되지 않는 고정 주소 ── */}
        <div style={{marginTop:14,marginBottom:10,padding:"12px 14px",background:G.surface,borderRadius:10,border:`1px dashed ${G.border}`}}>
          <div style={{fontSize:12,fontWeight:800,color:G.copper,marginBottom:8}}>📍 배송지 2 (선택)</div>
          <div style={{marginBottom:8}}>
            <FLabel>주소</FLabel>
            <div style={{display:"flex",gap:6}}>
              <input value={c.address2||""} onChange={e=>setC(p=>({...p,address2:e.target.value}))} placeholder="두 번째 배송지 — 없으면 비워두세요" style={{...baseInp,flex:1,minWidth:0}}/>
              <button onClick={()=>setAddrTarget("address2")} style={{flexShrink:0,padding:"0 14px",borderRadius:10,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:12,fontWeight:700,fontFamily:S,cursor:"pointer",whiteSpace:"nowrap"}}>🔍 검색</button>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:6}}>
            <div>
              <FLabel>상세주소</FLabel>
              <input value={c.address2Detail||""} onChange={e=>setC(p=>({...p,address2Detail:e.target.value}))} placeholder="동/호 등" style={baseInp}/>
            </div>
            <div>
              <FLabel>표시명 (예: 매장, 회사)</FLabel>
              <input value={c.address2Label||""} onChange={e=>setC(p=>({...p,address2Label:e.target.value}))} placeholder="주문 시 구분용" style={baseInp}/>
            </div>
          </div>
          <div style={{fontSize:10,color:G.creamMuted,lineHeight:1.5}}>주문 입력에서 이 고객을 선택하면 기본 배송지와 배송지 2 중 고를 수 있어요. 배송지 2는 주문 등록으로 자동 변경되지 않습니다.</div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <PrimaryBtn onClick={()=>onSave(c)} full>저장</PrimaryBtn>
          <GhostBtn onClick={onClose}>취소</GhostBtn>
        </div>
      </div>
      {addrTarget && <AddressSearchModal onComplete={({address})=>setC(p=>addrTarget==="address2"?{...p,address2:address}:{...p,address})} onClose={()=>setAddrTarget(null)}/>}
    </div>
  );
}

// 다음 우편번호 검색 모달 — embed 방식(팝업차단 영향 없음).
// onComplete({address, zonecode}) 로 선택 결과 전달, 선택/닫기 시 자동 close.
function AddressSearchModal({onComplete, onClose}) {
  const G = useTheme();
  const boxRef = useRef(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadPostcodeScript().then(() => {
      if (cancelled || !boxRef.current) return;
      new window.daum.Postcode({
        oncomplete: (data) => {
          const address = data.roadAddress || data.jibunAddress || data.address || "";
          onComplete({ address, zonecode: data.zonecode || "" });
          onClose();
        },
        width: "100%",
        height: "100%",
      }).embed(boxRef.current);
    }).catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, []);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:250,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)",padding:16,boxSizing:"border-box"}} onClick={e=>{e.stopPropagation();onClose();}}>
      {/* maxHeight 100% + overflow auto — 안쪽 우편번호 화면이 440px 고정이라
          짧은 폰(특히 글씨 배율을 올린 상태)에서는 모달이 화면보다 커진다.
          예전엔 overflow:hidden 이라 넘친 아래쪽이 그냥 잘렸고 스크롤도 안 됐다.
          임베드 높이는 그대로 둔다 — 그쪽을 건드리면 주소 검색 자체가 깨질 수 있다.
          100%(=화면 높이 - 오버레이 패딩 32) 기준인 이유는 vh 가 zoom 에 부풀기 때문. */}
      <div style={{background:G.card,borderRadius:16,border:`1px solid ${G.border}`,boxShadow:"0 8px 30px rgba(0,0,0,0.2)",width:"100%",maxWidth:480,maxHeight:"100%",overflow:"auto",overscrollBehavior:"contain"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",borderBottom:`1px solid ${G.border}`}}>
          <span style={{fontFamily:SF,fontSize:15,fontWeight:700,color:G.cream}}>🔍 주소 검색</span>
          <button onClick={onClose} style={{width:28,height:28,borderRadius:8,border:"none",background:G.surface,color:G.creamMuted,fontSize:15,cursor:"pointer"}}>✕</button>
        </div>
        {err
          ? <div style={{padding:"40px 20px",textAlign:"center",fontSize:13,color:G.creamMuted,fontFamily:S}}>주소 검색을 불러오지 못했습니다.<br/>네트워크 연결을 확인해 주세요.</div>
          : <div ref={boxRef} style={{width:"100%",height:440}} />}
      </div>
    </div>
  );
}

// ── Cute loaders ─────────────────────────────────────────────
// 어디서든 쓸 수 있는 통일된 로딩 표시.
//   <CuteLoader text="..."/>      — 인라인(작은 점 3개 + 텍스트)
//   <CuteFullLoader text="..."/>  — 전체화면(🧶 바운싱 + 점 + 메시지)
const CUTE_KEYFRAMES = `
@keyframes cuteBounce {
  0%, 80%, 100% { transform: translateY(0) scale(0.85); opacity: 0.55; }
  40% { transform: translateY(-7px) scale(1); opacity: 1; }
}
@keyframes cuteFloat {
  0%, 100% { transform: translateY(0) rotate(-6deg); }
  50% { transform: translateY(-14px) rotate(6deg); }
}
@keyframes cuteFade {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
`;

function CuteLoader({ text, size = "md", color }) {
  const G = useTheme();
  const dot = size === "sm" ? 5 : size === "lg" ? 9 : 7;
  const fontSize = size === "sm" ? 11 : size === "lg" ? 14 : 12;
  const c = color || G.copper;
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:8,fontFamily:S}}>
      <span style={{display:"inline-flex",gap:dot*0.55,alignItems:"center"}}>
        {[0,1,2].map(i=>(
          <span key={i} style={{
            width:dot, height:dot, borderRadius:"50%", background:c,
            display:"inline-block",
            animation:`cuteBounce 1.1s ${i*0.14}s infinite ease-in-out`,
          }}/>
        ))}
      </span>
      {text && <span style={{fontSize,color:G.creamMuted,fontWeight:500}}>{text}</span>}
      <style>{CUTE_KEYFRAMES}</style>
    </span>
  );
}

const CUTE_MESSAGES = [
  "잠시만요... 데이터 펼치는 중 🧵",
  "원단 정리 중이에요 🧶",
  "주문장 넘기는 중 📋",
  "계산기 두드리는 중 🧮",
  "조금만 기다려 주세요 ☁️",
];
function pickCuteMessage() {
  return CUTE_MESSAGES[Math.floor(Math.random() * CUTE_MESSAGES.length)];
}

function CuteFullLoader({ text, brand }) {
  const G = useTheme();
  const msg = text || pickCuteMessage();
  return (
    <div style={{
      position:"fixed", inset:0, background:G.bg, zIndex:999,
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      gap:14, fontFamily:S,
    }}>
      {brand && <div style={{fontFamily:SF,fontSize:22,fontWeight:800,color:G.copper}}>{brand}</div>}
      <div style={{fontSize:54,animation:"cuteFloat 1.6s infinite ease-in-out",lineHeight:1}}>🧶</div>
      <CuteLoader text={msg} size="md" />
      <style>{CUTE_KEYFRAMES}</style>
    </div>
  );
}

export { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, AddressSearchModal, CuteLoader, CuteFullLoader };
