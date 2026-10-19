import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx-js-style";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, AddressSearchModal, CuteLoader } from "./UI.jsx";
import { SF, S, baseInp, aiParseText, preprocessOrderText, uid, nowT, pC, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { CourierField } from "./Courier.jsx";
import { uploadOrderImages } from "../lib/storage.js";
import OrderNotesTab from "./OrderNotesTab.jsx";
import DetachedWindow from "./DetachedWindow.jsx";
import { validateAndCorrectAmounts } from "../lib/validation.js";
import { MergeModal } from "./MergeModal.jsx";
import { defaultShipDate, todayYmd, parseYmd, holidayName } from "../lib/shipDate.js";
import { findMergeCandidates, groupShipTarget, shipDateChoices } from "../lib/autoMerge.js";
import { patchOrdersWithGroupResult, previewFreightOverlap } from "../lib/freight.js";
import { matchProduct, fmtLen, isRollUnit, proposeSplit, splitFits, splitItemLines } from "../lib/rollStock.js";
import { normalizeProductCodes, attachProductCodes, codeNameMismatch, productLineText, fillPriceFromProduct, baseProductCode } from "../lib/productCodes.js";
import { baseFeeForUnit as linkBaseFee } from "../../api/link/_logic.js";   // 순수 함수뿐(supabase 없음) — 링크 초안 전환 때 택배비 기본값

const MAX_IMAGES = 10;

// 원본 텍스트에서 영수증 종류 자동 감지
// 우선순위: 현금영수증 → 지출증빙 → (세금)계산서
// "현금영수증/지출증빙/계산서" 같은 슬래시 표기는 첫 번째만 채택
// 단어 사이 공백·탭 허용("현금 영수증" 등). 줄바꿈은 별개 문장으로 보고 매칭하지 않음.
function detectReceiptType(text) {
  if (!text) return null;
  if (/현금[ \t]*영수증/.test(text)) return "cash";
  if (/지출[ \t]*증빙/.test(text)) return "business";
  if (/세금[ \t]*계산서|계산서/.test(text)) return "tax_invoice";
  return null;
}

// 배송지 메모 입력 — 자주 쓰는 메모를 프리셋으로 재사용/검색/삭제.
// 입력값으로 필터링된 후보를 드롭다운으로 보여주고, 각 후보는 클릭 선택 + ✕ 삭제.
function DeliveryMessageInput({value, onChange, presets, onDeletePreset, G}) {
  const [focus, setFocus] = useState(false);
  const q = (value || "").trim().toLowerCase();
  const list = (presets || []);
  const suggestions = (focus
    ? (q ? list.filter(p => p.text.toLowerCase().includes(q) && p.text.toLowerCase() !== q) : list)
    : []
  ).slice(0, 8);
  return (
    <div style={{position:"relative"}}>
      <input
        value={value}
        onChange={e=>onChange(e.target.value)}
        onFocus={()=>setFocus(true)}
        onBlur={()=>setTimeout(()=>setFocus(false),150)}
        placeholder="배송지 메모 (예: 부재시 경비실 · 문 앞에 두고 문자)"
        style={{...baseInp,width:"100%",boxSizing:"border-box"}}/>
      {suggestions.length>0 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:60,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden",maxHeight:220,overflowY:"auto"}}>
          {suggestions.map(p=>(
            <div key={p.id}
              style={{display:"flex",alignItems:"center",gap:6,padding:"8px 10px",borderBottom:`1px solid ${G.border}`,fontFamily:S}}
              onMouseEnter={e=>e.currentTarget.style.background=G.surface}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div onMouseDown={()=>onChange(p.text)} style={{flex:1,minWidth:0,cursor:"pointer",fontSize:12,color:G.cream,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                📦 {p.text}
              </div>
              <button type="button" onMouseDown={e=>{e.preventDefault();e.stopPropagation();onDeletePreset?.(p.id);}}
                title="이 기록 삭제"
                style={{flexShrink:0,width:20,height:20,borderRadius:6,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,fontSize:11,cursor:"pointer",fontFamily:S,lineHeight:1,padding:0}}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerMatchPopup({type, matchedCustomer, matchedList, parsed, onConfirm, onNewCustomer, onCancel, onUpdatePhone, G}) {
  if (type === "confirmed") return null;
  const overlayStyle = {position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"};
  const modalStyle = {background:G.card,borderRadius:16,border:`1px solid ${G.border}`,boxShadow:"0 8px 30px rgba(0,0,0,0.2)",padding:22,width:"90%",maxWidth:400,boxSizing:"border-box"};
  const btnBase = {padding:"10px 16px",borderRadius:10,border:"none",fontFamily:S,fontWeight:700,fontSize:13,cursor:"pointer"};

  if (type === "phone_changed") {
    return (
      <div style={overlayStyle} onClick={onCancel}>
        <div style={modalStyle} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:15,fontWeight:800,color:G.copper,marginBottom:12}}>전화번호 변경 감지</div>
          <div style={{fontSize:13,color:G.cream,marginBottom:6}}>
            <b>{matchedCustomer.name}</b> 고객의 번호가 다릅니다.
          </div>
          <div style={{fontSize:12,color:G.creamMuted,marginBottom:4}}>기존: {matchedCustomer.phone||"없음"}</div>
          <div style={{fontSize:12,color:G.creamMuted,marginBottom:8}}>신규: {parsed.phone||"없음"}</div>
          {matchedCustomer.address && <div style={{fontSize:12,color:G.creamMuted,marginBottom:4}}>📍 등록 주소: {matchedCustomer.address}</div>}
          {parsed.address && <div style={{fontSize:12,color:G.creamMuted,marginBottom:16}}>📦 입력 주소: {parsed.address}{parsed.address_detail?` ${parsed.address_detail}`:""}</div>}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>onUpdatePhone(matchedCustomer)} style={{...btnBase,background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white}}>번호 업데이트</button>
            <button onClick={onCancel} style={{...btnBase,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted}}>다른 고객</button>
            <button onClick={onNewCustomer} style={{...btnBase,border:`1px solid ${G.blue}`,background:G.blueBg,color:G.blue}}>신규 등록</button>
          </div>
        </div>
      </div>
    );
  }

  if (type === "maybe") {
    // 기본 배송지 또는 배송지2 중 하나라도 일치하면 같은 고객으로 인식
    const addrSame = parsed.address && (addressMatches(parsed.address, matchedCustomer.address) || addressMatches(parsed.address, matchedCustomer.address2));
    return (
      <div style={overlayStyle} onClick={onCancel}>
        <div style={modalStyle} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:15,fontWeight:800,color:G.copper,marginBottom:12}}>혹시 이 고객인가요?</div>
          <div style={{padding:12,background:G.surface,borderRadius:10,border:`1px solid ${G.border}`,marginBottom:12}}>
            <div style={{fontWeight:700,fontSize:14}}>{matchedCustomer.name}</div>
            <div style={{fontSize:12,color:G.creamMuted,marginTop:4}}>{matchedCustomer.phone||"연락처 없음"}{matchedCustomer.nickname?` · 닉네임: ${matchedCustomer.nickname}`:""}</div>
            {matchedCustomer.address && <div style={{fontSize:12,color:G.creamMuted,marginTop:4}}>📍 {matchedCustomer.address}</div>}
          </div>
          {parsed.address && (
            <div style={{padding:10,background:addrSame?`${G.green}1A`:`${G.yellow}1A`,borderRadius:8,border:`1px solid ${addrSame?G.green:G.yellow}40`,marginBottom:16,fontSize:11,lineHeight:1.6}}>
              <div style={{color:G.creamMuted,marginBottom:2}}>📦 이번 주문 배송지</div>
              <div style={{color:G.cream}}>{parsed.address}{parsed.address_detail?` ${parsed.address_detail}`:""}</div>
              {!addrSame && matchedCustomer.address && <div style={{color:G.yellow,marginTop:4,fontWeight:700}}>⚠ 등록 주소와 다릅니다 — 다른 사람일 수 있어요</div>}
            </div>
          )}
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>onConfirm(matchedCustomer)} style={{...btnBase,flex:1,background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white}}>맞습니다</button>
            <button onClick={onNewCustomer} style={{...btnBase,flex:1,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted}}>아닙니다</button>
          </div>
        </div>
      </div>
    );
  }

  if (type === "name_list") {
    return (
      <div style={overlayStyle} onClick={onCancel}>
        <div style={modalStyle} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:15,fontWeight:800,color:G.copper,marginBottom:6}}>동명이인 목록</div>
          <div style={{fontSize:12,color:G.creamMuted,marginBottom:8}}>이름이 같은 고객이 {matchedList.length}명 있습니다.</div>
          {parsed.address && (
            <div style={{padding:8,background:G.surface,borderRadius:8,border:`1px dashed ${G.border}`,marginBottom:10,fontSize:11,color:G.creamMuted}}>
              📦 이번 주문 배송지: <span style={{color:G.cream}}>{parsed.address}{parsed.address_detail?` ${parsed.address_detail}`:""}</span>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16,maxHeight:240,overflowY:"auto"}}>
            {matchedList.map(c=>{
              const addrSame = parsed.address && (addressMatches(parsed.address, c.address) || addressMatches(parsed.address, c.address2));
              return (
                <button key={c.id} onClick={()=>onConfirm(c)} style={{padding:12,background:G.surface,borderRadius:10,border:`1px solid ${addrSame?G.green:G.border}`,cursor:"pointer",textAlign:"left",fontFamily:S}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontWeight:700,fontSize:13,color:G.cream}}>{c.name}</div>
                    {addrSame && <span style={{fontSize:9,fontWeight:700,color:G.green,background:`${G.green}1A`,padding:"1px 6px",borderRadius:4}}>주소 일치</span>}
                  </div>
                  <div style={{fontSize:11,color:G.creamMuted,marginTop:2}}>{c.phone||"연락처 없음"}{c.nickname?` · ${c.nickname}`:""}</div>
                  {c.address && <div style={{fontSize:11,color:G.creamMuted,marginTop:2}}>📍 {c.address}</div>}
                </button>
              );
            })}
          </div>
          <button onClick={onNewCustomer} style={{...btnBase,width:"100%",border:`1px solid ${G.blue}`,background:G.blueBg,color:G.blue}}>신규 고객 등록</button>
        </div>
      </div>
    );
  }

  if (type === "new") {
    return (
      <div style={overlayStyle} onClick={onCancel}>
        <div style={modalStyle} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:15,fontWeight:800,color:G.copper,marginBottom:12}}>신규 고객입니다</div>
          <div style={{fontSize:13,color:G.cream,marginBottom:16}}>등록할까요?</div>
          <div style={{padding:12,background:G.surface,borderRadius:10,border:`1px solid ${G.border}`,marginBottom:16,fontSize:12,color:G.creamMuted,lineHeight:1.7}}>
            <div>이름: {parsed.customerName||parsed.customer||"—"}</div>
            {parsed.phone && <div>연락처: {parsed.phone}</div>}
            {parsed.customerNickname && <div>닉네임: {parsed.customerNickname}</div>}
            {parsed.address && <div>📍 주소: {parsed.address}{parsed.address_detail?` ${parsed.address_detail}`:""}</div>}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onNewCustomer} style={{...btnBase,flex:1,background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white}}>등록</button>
            <button onClick={onCancel} style={{...btnBase,flex:1,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted}}>취소</button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// 로하톡 메모 → 등록 폼으로 넘어갈 때, 글에 적힌 주소·전화가 고객 카드와 다르면 어느 쪽을 쓸지 묻는 창.
// 지금까지는 고객 카드 값이 무조건 이겨서, 담당자가 "이번엔 여기로 보내주세요"라고 적어둔 주소가 조용히 사라졌다.
// 실측(주소 적힌 메모 372건): 17건이 등록 주소와 달랐고 그중 6건이 진짜 다른 곳이었다.
function NoteConflictModal({ conflict, onResolve, G }) {
  const { cust, parsed, addrConflict, phoneConflict } = conflict;
  const [addrPick, setAddrPick] = useState("note");   // note | card | card2
  const [phonePick, setPhonePick] = useState("card"); // note(+고객정보 갱신) | card
  const overlayStyle = {position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"};
  const modalStyle = {background:G.card,borderRadius:16,border:`1px solid ${G.border}`,boxShadow:"0 8px 30px rgba(0,0,0,0.2)",padding:22,width:"90%",maxWidth:420,maxHeight:"86vh",overflowY:"auto",boxSizing:"border-box"};
  const pickStyle = (on) => ({padding:"11px 13px",borderRadius:10,border:`1px solid ${on?G.copper:G.border}`,background:on?G.copperGlow:"transparent",
    cursor:"pointer",textAlign:"left",fontFamily:S,width:"100%",boxSizing:"border-box",lineHeight:1.55});
  const tag = (t,color) => <div style={{fontSize:10,fontWeight:800,color,marginBottom:3}}>{t}</div>;
  const noteAddr = [parsed.address, parsed.address_detail].filter(Boolean).join(" ");
  const cardAddr = [cust.address, cust.addressDetail].filter(Boolean).join(" ");
  const card2Addr = [cust.address2, cust.address2Detail].filter(Boolean).join(" ");
  // body 포탈 — 주문입력 탭은 display:none으로만 감춰지는데, 그 안의 fixed 요소는 통째로
  // 사라진다(AutoMergeAskModal과 같은 제약). 창이 안 보이면 프리필이 조용히 멈춘다.
  return createPortal((
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{fontSize:15,fontWeight:800,color:G.copper,marginBottom:4}}>글과 등록 정보가 다릅니다</div>
        <div style={{fontSize:12,color:G.creamMuted,marginBottom:14}}><b style={{color:G.cream}}>{cust.name}</b> 고객 — 어느 쪽으로 등록할까요?</div>

        {addrConflict && (
          <div style={{marginBottom:phoneConflict?16:18}}>
            <div style={{fontSize:12,fontWeight:800,color:G.cream,marginBottom:7}}>📦 배송지</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              <button onClick={()=>setAddrPick("note")} style={pickStyle(addrPick==="note")}>
                {tag("글에 적힌 주소 — 이번 주문만", G.copper)}
                <div style={{fontSize:12,color:G.cream}}>{noteAddr}</div>
              </button>
              <button onClick={()=>setAddrPick("card")} style={pickStyle(addrPick==="card")}>
                {tag("등록된 주소", G.creamMuted)}
                <div style={{fontSize:12,color:G.cream}}>{cardAddr || "없음"}</div>
              </button>
              {card2Addr && (
                <button onClick={()=>setAddrPick("card2")} style={pickStyle(addrPick==="card2")}>
                  {tag(`배송지2${cust.address2Label?` · ${cust.address2Label}`:""}`, G.creamMuted)}
                  <div style={{fontSize:12,color:G.cream}}>{card2Addr}</div>
                </button>
              )}
            </div>
          </div>
        )}

        {phoneConflict && (
          <div style={{marginBottom:18}}>
            <div style={{fontSize:12,fontWeight:800,color:G.cream,marginBottom:7}}>📞 연락처</div>
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              <button onClick={()=>setPhonePick("note")} style={pickStyle(phonePick==="note")}>
                {tag("글에 적힌 번호 — 고객 정보도 갱신", G.copper)}
                <div style={{fontSize:12,color:G.cream}}>{parsed.phone}</div>
              </button>
              <button onClick={()=>setPhonePick("card")} style={pickStyle(phonePick==="card")}>
                {tag("등록된 번호 유지", G.creamMuted)}
                <div style={{fontSize:12,color:G.cream}}>{cust.phone || "없음"}</div>
              </button>
            </div>
          </div>
        )}

        <button onClick={()=>onResolve({ address: addrConflict ? addrPick : null, phone: phoneConflict ? phonePick : null })}
          style={{padding:"12px 16px",borderRadius:10,border:"none",width:"100%",fontFamily:S,fontWeight:800,fontSize:13,cursor:"pointer",
            background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white}}>
          이대로 등록 폼 열기
        </button>
      </div>
    </div>
  ), document.body);
}

// 주소 표기 차이(같은 곳)와 진짜 다른 주소를 가르는 판정.
// "안산 상록구…" / "안산시 상록구…" 처럼 몇 글자만 다른 건 같은 곳으로 본다.
// 앞뒤로 겹치는 부분이 8할을 넘으면 표기 차이로 간주.
function addrRoughlySame(a, b) {
  const x = String(a || "").replace(/\s+/g, "").toLowerCase();
  const y = String(b || "").replace(/\s+/g, "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return (p + s) / Math.max(x.length, y.length) >= 0.8;
}

// 글에 적힌 주소·전화가 고객 카드와 어긋나는지 — 어긋나면 NoteConflictModal 로 물어본다.
function detectNoteConflicts(parsed, cust) {
  if (!cust) return null;
  const noteAddr = [parsed.address, parsed.address_detail].filter(Boolean).join(" ");
  const cardAddr = [cust.address, cust.addressDetail].filter(Boolean).join(" ");
  const card2Addr = [cust.address2, cust.address2Detail].filter(Boolean).join(" ");
  const addrConflict = !!(parsed.address && cust.address
    && !addressMatches(parsed.address, cust.address) && !addressMatches(parsed.address, cust.address2)
    && !addrRoughlySame(noteAddr, cardAddr) && !(card2Addr && addrRoughlySame(noteAddr, card2Addr)));
  // 전화는 양쪽 다 풀 번호일 때만 비교 — 중간 4자리만 있는 legacy 고객은 판단 불가
  const pd = String(parsed.phone || "").replace(/\D/g, "");
  const cd = String(cust.phone || "").replace(/\D/g, "");
  const phoneConflict = pd.length >= 10 && cd.length >= 10 && pd !== cd;
  return (addrConflict || phoneConflict) ? { addrConflict, phoneConflict } : null;
}

// 고객 매칭 로직: 중간번호 추출 헬퍼
function extractMidPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[^0-9]/g,"");
  if (cleaned.length >= 10) return cleaned.slice(3,7);
  if (cleaned.length === 4) return cleaned;  // 마켓원장 import: 가운데 4자리만 저장된 케이스
  return null;
}

// 주소 부분 매칭 — 동명이인+같은 가운데번호 케이스에서 추가 식별 신호로 사용.
// 양쪽 공백 제거 후 한쪽이 다른 쪽에 포함되면 매칭 (4자 이상). 부분 일치라
// "강릉시 종합운동장길92" vs "강릉시" 또는 "강릉" vs "강릉시 종합운동장길92" 모두 매칭.
function addressMatches(addrA, addrB) {
  if (!addrA || !addrB) return false;
  const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();
  const a = norm(addrA);
  const b = norm(addrB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return false;
}

// 전화번호 매칭: 둘 다 풀 폰(10자리 이상)이면 전체 비교, 그 외엔 가운데 4자리 fallback.
// 기존 버그: 가운데 4자리만 비교해서 전혀 다른 고객을 같은 사람으로 인식.
function phoneMatches(orderPhone, custPhone, parsedMid) {
  const oDigits = String(orderPhone || "").replace(/\D/g, "");
  const cDigits = String(custPhone || "").replace(/\D/g, "");
  // 둘 다 풀 폰 → 전체 일치해야 매치 (앞자리·뒷자리 모두 동일 요구)
  if (oDigits.length >= 10 && cDigits.length >= 10) {
    return oDigits === cDigits;
  }
  // 한쪽이라도 가운데 4자리만 보유 → mid 4 fallback (마켓원장 legacy 데이터 호환)
  const oMid = oDigits.length >= 10 ? oDigits.slice(3, 7) : (oDigits.length === 4 ? oDigits : parsedMid || null);
  const cMid = cDigits.length >= 10 ? cDigits.slice(3, 7) : (cDigits.length === 4 ? cDigits : null);
  return !!(oMid && cMid && oMid === cMid);
}

// 출고예정일 선택 — 주문등록(AI 분석 / 직접입력) 양쪽에서 쓰는 공통 컨트롤.
//
// 기본은 '익일'(= 다음 영업일. 토·일·공휴일·회사휴무일은 건너뜀).
// 셀러가 등록 직전에 긴급/당일/날짜지정으로 바꿀 수 있다.
// 저장은 날짜(shipDate)로 하고 칸 라벨은 저장하지 않는다 — 익일로 등록한 주문이
// 다음날 자동으로 '당일' 칸으로 올라와야 하기 때문.
function ShipDateField({ shipDate, isUrgent, onChange, G }) {
  const today = todayYmd();
  const nextBiz = defaultShipDate();
  // 값만으로 모드를 정하면 '날짜 지정'을 누를 수 없다 — 기본값(익일)에서 눌러도
  // shipDate 가 그대로라 다시 '익일'로 판정돼 입력칸이 안 열린다.
  // 그래서 '지금 날짜를 고르는 중'인지는 별도 상태로 둔다.
  const derived = isUrgent ? "urgent"
    : shipDate === today ? "today"
    : shipDate === nextBiz ? "next" : "pick";
  const [picking, setPicking] = useState(derived === "pick");
  const mode = (picking && !isUrgent) ? "pick" : derived;

  const d = parseYmd(shipDate);
  const hName = shipDate ? holidayName(shipDate) : null;
  const isWeekend = d ? (d.getDay() === 0 || d.getDay() === 6) : false;
  const desc = d
    ? `${d.getMonth() + 1}/${d.getDate()}(${["일","월","화","수","목","금","토"][d.getDay()]})${hName ? ` · ${hName}` : ""}`
    : "";

  const OPTS = [
    { k: "urgent", l: "🔴 긴급", c: G.red,    next: { shipDate: today,   isUrgent: true  } },
    { k: "today",  l: "당일",    c: G.copper, next: { shipDate: today,   isUrgent: false } },
    { k: "next",   l: "익일",    c: G.blue,   next: { shipDate: nextBiz, isUrgent: false } },
    { k: "pick",   l: "날짜 지정", c: G.purple, next: null },
  ];

  return (
    <div style={{marginTop:10}}>
      <FLabel>🚚 출고예정일</FLabel>
      <div style={{display:"flex",gap:5}}>
        {OPTS.map(o => (
          <button key={o.k} type="button" className="oi-ship-opt"
            onClick={() => {
              setPicking(!o.next);
              if (o.next) onChange(o.next);
              else onChange({ shipDate: shipDate || nextBiz, isUrgent: false });
            }}
            style={{flex:1,padding:"8px 4px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12,
              fontWeight: mode===o.k ? 800 : 500,
              border:`1px solid ${mode===o.k ? o.c : G.border}`,
              background: mode===o.k ? `${o.c}1f` : "transparent",
              color: mode===o.k ? o.c : G.creamMuted}}>
            {o.l}
          </button>
        ))}
      </div>
      {mode === "pick" && (
        <input type="date" value={shipDate || ""} min={today}
          onChange={e => onChange({ shipDate: e.target.value, isUrgent: false })}
          style={{...baseInp, marginTop:6, fontFamily:S, fontSize:13}}/>
      )}
      {desc && (
        <div style={{marginTop:5,fontSize:11,fontWeight:700,
          color: isUrgent ? G.red : (hName || isWeekend) ? G.red : G.creamMuted}}>
          {isUrgent ? `⚡ 긴급 — 즉시 출고 (${desc})` : desc}
          {!isUrgent && (hName || isWeekend) && " — 휴무일입니다. 이 날짜가 맞나요?"}
        </div>
      )}
    </div>
  );
}

// 수량·금액이 빈 채로 등록하려 할 때 뜨는 확인창.
//
// 하단 경고만으로는 그냥 지나친다는 현장 지적이 있었다 — 등록 버튼 옆에 있어도
// 누르는 손이 이미 버튼에 가 있으면 안 읽힌다. 그래서 등록을 한 번 막고 묻는다.
// 막되 못 하게 하지는 않는다: 세트 상품이나 무료나눔처럼 비어 있는 게 맞는 경우가 있고,
// 그 판단은 파는 사람이 한다.
//
// ⚠️ createPortal 로 body 에 붙인다. 주문입력 탭은 언마운트하지 않고 display:none 으로만
//    감추는데(ErpApp.jsx), 그건 position:fixed 자식까지 통째로 지운다.
//    AutoMergeAskModal 이 같은 이유로 body 에 붙어 있다.
function MissingFieldAskModal({ ask, onResolve, G }) {
  const { needCheck, noteTotal, total } = ask;
  return createPortal((
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:120,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:G.card,borderRadius:14,padding:"20px 18px",maxWidth:420,width:"100%",maxHeight:"85vh",overflowY:"auto",border:`1px solid ${G.yellow}66`}}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:G.yellow,marginBottom:6}}>
          ⚠️ 비어 있는 값이 있습니다
        </div>
        <div style={{fontSize:12.5,color:G.creamMuted,lineHeight:1.7,marginBottom:12}}>
          주문글에 안 적혀 있어 채우지 못한 값입니다. 확인하고 진행해 주세요.
        </div>

        <div style={{border:`1px solid ${G.border}`,borderRadius:10,overflow:"hidden",marginBottom:12}}>
          {needCheck.map((it,i)=>(
            <div key={i} style={{padding:"9px 11px",borderTop:i?`1px solid ${G.border}`:"none",display:"flex",gap:8,alignItems:"baseline",flexWrap:"wrap"}}>
              <b style={{fontSize:13,color:G.cream}}>{(it.fabric||it.itemNo||"이름 없음")}{it.color?` ${it.color}`:""}</b>
              <span style={{fontSize:11.5,color:G.yellow,fontWeight:700}}>{it.missing.join(" · ")} 없음</span>
            </div>
          ))}
        </div>

        {noteTotal > 0 && noteTotal !== total && (
          <div style={{fontSize:12.5,color:G.cream,background:G.yellowBg||"rgba(217,164,65,0.12)",border:`1px solid ${G.yellow}44`,borderRadius:9,padding:"9px 11px",marginBottom:12,lineHeight:1.7}}>
            주문글의 총액은 <b style={{color:G.yellow}}>{noteTotal.toLocaleString()}원</b>인데
            지금 <b style={{color:G.red}}>{total.toLocaleString()}원</b>으로 등록됩니다.
            <div style={{fontSize:11,color:G.creamMuted,marginTop:3}}>
              금액을 안 채우면 이 차이가 그대로 장부에 남습니다.
            </div>
          </div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>onResolve(false)} style={{
            flex:1.4,padding:"12px",borderRadius:9,border:"none",
            background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
            color:G.white,fontFamily:S,fontSize:13,fontWeight:800,cursor:"pointer"}}>
            돌아가서 채우기
          </button>
          <button onClick={()=>onResolve(true)} style={{
            flex:1,padding:"12px",borderRadius:9,border:`1px solid ${G.border}`,background:"transparent",
            color:G.creamMuted,fontFamily:S,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            이대로 등록
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

// 자동 합배송 확인창 — 예약(날짜 지정) 건이 끼었을 때만 뜬다.
// 고객이 일부러 늦게 받겠다고 한 날짜를 시스템이 당기거나, 급한 주문을 그 날짜까지
// 미루는 건 사람이 판단할 일이라 셀러에게 묻는다.
//
// ⚠️ 이 창은 반드시 document.body 에 붙인다(createPortal).
//    주문입력 탭은 언마운트하지 않고 display:none 으로만 감춘다(ErpApp.jsx). 그런데
//    display:none 은 position:fixed 자식까지 통째로 지운다 — 등록 직후 주문현황으로
//    넘어간 상태에서 이 창이 뜨면, 화면에는 아무것도 없는데 submitOrder 는 사람 답을
//    기다리며 영원히 멈춘다(폼도 안 풀리고 합배송도 안 묶인다).
// 방금 만든 셀러 링크 — 링크 전체 + 복사. 24시간 안에 확인 안 하면 만료.
function SellerLinkModal({ made, onClose, showToast, G }) {
  if (!made) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(made.url); showToast?.("링크를 복사했습니다"); } catch { window.prompt("링크를 복사하세요", made.url); } };
  const exp = made.expiresAt ? new Date(made.expiresAt) : null;
  return createPortal((
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:G.card,borderRadius:14,padding:"20px 18px",maxWidth:480,width:"100%",border:`1px solid ${G.border}`}}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:G.purple,marginBottom:4}}>📨 주문 링크를 만들었습니다</div>
        <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.6,marginBottom:12}}>
          <b style={{color:G.cream}}>{made.customer}</b>님께 쪽지로 보내세요. 고객이 "이대로 주문"을 누르면 초안 카드가 <b style={{color:G.green}}>고객 확인 ✓</b>로 바뀝니다.
          {exp ? <> <b style={{color:G.red}}>{exp.getMonth()+1}/{exp.getDate()} {String(exp.getHours()).padStart(2,"0")}:{String(exp.getMinutes()).padStart(2,"0")}</b>까지(24시간 안에) 확인하지 않으면 만료됩니다.</> : null}
        </div>
        <div style={{padding:"10px 12px",borderRadius:8,background:G.surface,border:`1px solid ${G.border}`,fontFamily:"monospace",fontSize:11,color:G.cream,wordBreak:"break-all",lineHeight:1.5}}>{made.url}</div>
        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={copy} style={{flex:1,padding:"11px",borderRadius:8,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:S}}>복사</button>
          <button onClick={onClose} style={{padding:"11px 16px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:S}}>닫기</button>
        </div>
      </div>
    </div>
  ), document.body);
}

// 품목 줄 나누기 확인창 — 한 줄의 수량이 한 롤에서 다 나올 수 없을 때.
// 포장 기록은 품목 한 줄에 롤 하나라, 10마 주문을 6마·4마 두 롤에서 자르려면 줄이 둘이어야 롤마다 찍힌다.
// 가장 긴 롤부터 채운 값을 미리 넣어 두고, 셀러가 고칠 수 있다. 어느 롤에서 자를지는 여기서 정하지 않는다 —
// 포장하는 사람이 찍는 롤이 기록된다.
//   ask.rows: [{ idx, item, lengths, rollUnit, available, parts(null = 롤을 다 합쳐도 모자람) }]
//   onResolve: { split: { [idx]: [수량…] } } 나눠서 등록 · { split: null } 그대로 등록 · null 돌아가기
function SplitAskModal({ ask, onResolve, G }) {
  const [vals, setVals] = useState(() => Object.fromEntries(ask.rows.filter(r => r.parts).map(r => [r.idx, r.parts.map(String)])));
  const name = (it) => `${it.fabric || it.itemNo || "품목"}${it.color ? ` ${it.color}` : ""}`;
  const check = (r) => {
    const parts = (vals[r.idx] || []).map(v => Number(v));
    if (parts.some(v => !(v > 0))) return "수량을 채워 주세요";
    const sum = Math.round(parts.reduce((s, v) => s + v, 0) * 100) / 100;
    const qty = parseFloat(r.item.qty) || 0;
    if (sum !== qty) return `합계 ${fmtLen(sum)}${r.item.unit || "마"} — 주문 ${fmtLen(qty)}${r.item.unit || "마"} 와 다릅니다`;
    if (r.rollUnit) return parts.every(v => v === 1) ? "" : "롤은 한 줄에 1개씩입니다";
    return splitFits(parts, r.lengths) ? "" : "이 나눔은 롤에 안 맞습니다 — 줄 하나는 롤 하나에서 나와야 합니다";
  };
  const canSplit = ask.rows.some(r => r.parts) && ask.rows.filter(r => r.parts).every(r => !check(r));
  // 롤 2개 이상을 한 줄로 두면 포장대가 품목당 롤 하나만 기록해(DB 유일 제약) 두 번째 롤이 재고에 남는다.
  // 롤이 모자라 나눌 수 없는 건(옛 재고·외주)만 그대로 등록을 허용한다(2026-10-13 점검).
  const mustSplit = ask.rows.some(r => r.rollUnit && r.parts);
  const setVal = (idx, i, v) => setVals(p => ({ ...p, [idx]: p[idx].map((x, j) => j === i ? v.replace(/,/g, ".").replace(/[^0-9.]/g, "") : x) }));
  const inp = { ...baseInp, width: 74, padding: "8px 8px", fontSize: 14, fontWeight: 800, textAlign: "right", fontFamily: SF };
  return createPortal((
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:120,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:G.card,borderRadius:14,padding:"20px 18px",maxWidth:460,width:"100%",maxHeight:"85vh",overflowY:"auto",border:`1px solid ${G.yellow}66`}}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:G.yellow,marginBottom:6}}>✂️ 한 롤에서 다 안 나오는 품목이 있습니다</div>
        <div style={{fontSize:12.5,color:G.creamMuted,lineHeight:1.7,marginBottom:12}}>
          줄을 나눠 등록하면 포장할 때 롤마다 따로 찍을 수 있습니다. 금액 합계는 그대로입니다.
        </div>
        {ask.rows.map(r => {
          const unit = r.item.unit || "마";
          const why = r.parts ? check(r) : "";
          return (
            <div key={r.idx} style={{border:`1px solid ${G.border}`,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
              <div style={{fontSize:13.5,fontWeight:800,color:G.cream}}>{name(r.item)} <span style={{color:G.copper}}>{r.item.qty}{unit}</span></div>
              <div style={{fontSize:11.5,color:G.creamMuted,marginTop:2,lineHeight:1.6}}>
                {r.rollUnit
                  ? <>판매 가능한 롤 <b style={{color:G.cream}}>{r.available}개</b></>
                  : <>판매 가능한 롤 <b style={{color:G.cream}}>{r.lengths.length ? r.lengths.map(v => fmtLen(v)).join(" · ") + "마" : "없음"}</b></>}
              </div>
              {r.parts ? (
                <>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginTop:8}}>
                    {(vals[r.idx] || []).map((v, i) => (
                      <span key={i} style={{display:"inline-flex",alignItems:"center",gap:4}}>
                        {i > 0 && <span style={{color:G.creamMuted,fontWeight:800}}>+</span>}
                        <input value={v} onChange={e => setVal(r.idx, i, e.target.value)} inputMode="decimal" disabled={r.rollUnit} style={{...inp, opacity: r.rollUnit ? 0.7 : 1}}/>
                        <span style={{fontSize:12,color:G.creamMuted}}>{unit}</span>
                      </span>
                    ))}
                    {!r.rollUnit && (vals[r.idx] || []).length < r.lengths.length && (
                      <button type="button" onClick={() => setVals(p => ({ ...p, [r.idx]: [...p[r.idx], ""] }))} style={{padding:"6px 10px",borderRadius:7,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:11.5,fontWeight:700,cursor:"pointer"}}>＋ 줄</button>
                    )}
                    {!r.rollUnit && (vals[r.idx] || []).length > 2 && (
                      <button type="button" onClick={() => setVals(p => ({ ...p, [r.idx]: p[r.idx].slice(0, -1) }))} style={{padding:"6px 10px",borderRadius:7,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:11.5,fontWeight:700,cursor:"pointer"}}>－ 줄</button>
                    )}
                  </div>
                  {why && <div style={{fontSize:11.5,fontWeight:800,color:G.red,marginTop:5}}>{why}</div>}
                </>
              ) : (
                <div style={{fontSize:12,fontWeight:800,color:G.red,marginTop:6}}>
                  {r.rollUnit ? `롤이 ${r.available}개뿐입니다 — 나눠도 다 못 채웁니다` : `롤을 다 합쳐도 ${fmtLen(r.lengths.reduce((s, v) => s + v, 0))}마 — 나눠도 다 못 채웁니다`}
                </div>
              )}
            </div>
          );
        })}
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={() => onResolve({ split: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.map(Number)])) })} disabled={!canSplit} style={{
            flex:"1.4 1 150px",padding:"12px",borderRadius:9,border:"none",background:canSplit ? `linear-gradient(135deg,${G.copper},${G.copperLight})` : G.border,
            color:canSplit ? G.white : G.creamMuted,fontFamily:S,fontSize:13,fontWeight:800,cursor:canSplit ? "pointer" : "not-allowed"}}>
            줄을 나눠서 등록
          </button>
          <button onClick={() => onResolve({ split: null })} disabled={mustSplit}
            title={mustSplit ? "롤 2개 이상은 줄을 나눠야 포장할 때 롤을 하나씩 찍을 수 있습니다" : undefined}
            style={{flex:"1 1 110px",padding:"12px",borderRadius:9,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:13,fontWeight:700,cursor:mustSplit ? "not-allowed" : "pointer",opacity:mustSplit ? 0.45 : 1}}>
            그대로 등록
          </button>
          {mustSplit && <div style={{flexBasis:"100%",fontSize:11.5,fontWeight:700,color:G.red}}>롤 2개 이상은 줄을 나눠서 등록해야 합니다 — 포장할 때 롤을 하나씩 찍습니다</div>}
          <button onClick={() => onResolve(null)} style={{flex:"0 0 auto",padding:"12px 14px",borderRadius:9,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            돌아가기
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

function AutoMergeAskModal({ ask, onResolve, G }) {
  const all = [ask.newOrder, ...ask.candidates];
  const choices = shipDateChoices(all);
  // 기본 선택은 규칙과 같게 — 긴급이 있으면 긴급, 아니면 가장 늦은 날(묶는다 = 한 번에 받는다).
  const [pick, setPick] = useState(() => (choices.find(c => c.isUrgent) || choices[choices.length - 1])?.key);

  const fmt = (o) => {
    if (o.isUrgent) return "🔴 긴급";
    if (!o.shipDate) return "날짜 없음";
    const d = parseYmd(o.shipDate);
    return d ? `${d.getMonth()+1}/${d.getDate()}(${["일","월","화","수","목","금","토"][d.getDay()]})` : o.shipDate;
  };
  const itemText = (o) => (o.items||[]).map(i=>`${i.fabric}${i.color?` ${i.color}`:""} ${i.qty}${i.unit||"마"}`).join(", ") || "품목 없음";

  return createPortal((
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:G.card,borderRadius:14,padding:"20px 18px",maxWidth:460,width:"100%",maxHeight:"85vh",overflowY:"auto",border:`1px solid ${G.border}`}}>
        <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:G.copper,marginBottom:4}}>📦 합배송으로 묶을까요?</div>
        <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.6,marginBottom:14}}>
          <b style={{color:G.cream}}>{ask.newOrder.customer}</b>님의 미출고 주문이 {ask.candidates.length}건 더 있습니다.
          날짜를 지정해 둔 주문이 있어 자동으로 묶지 않았습니다.
        </div>

        <div style={{border:`1px solid ${G.border}`,borderRadius:10,overflow:"hidden",marginBottom:14}}>
          {all.map((o,i) => (
            <div key={o.id} style={{padding:"9px 11px",borderTop:i?`1px solid ${G.border}`:"none",
              background:o.id===ask.newOrder.id?G.copperGlow:"transparent"}}>
              <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:2}}>
                <span style={{fontSize:11,fontWeight:800,color:o.isUrgent?G.red:G.blue}}>{fmt(o)}</span>
                {o.id===ask.newOrder.id && <span style={{fontSize:10,fontWeight:800,color:G.copper}}>방금 등록</span>}
                {o.status==="포장완료" && <span style={{fontSize:10,fontWeight:800,color:G.green}}>포장완료</span>}
              </div>
              <div style={{fontSize:12,color:G.cream,lineHeight:1.5}}>{itemText(o)}</div>
            </div>
          ))}
        </div>

        <div style={{fontSize:12,fontWeight:700,color:G.cream,marginBottom:2}}>묶으면 어느 날짜에 맞출까요?</div>
        <div style={{fontSize:11,color:G.creamMuted,marginBottom:7}}>기본은 가장 늦은 날입니다(긴급 건이 있으면 긴급). 택배비는 묶는 순간 한 건에만 남습니다.</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
          {choices.map(c => (
            <button key={c.key} type="button" onClick={()=>setPick(c.key)} style={{
              textAlign:"left",padding:"9px 11px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12.5,
              border:`1px solid ${pick===c.key?G.copper:G.border}`,
              background:pick===c.key?G.copperGlow:"transparent",
              color:pick===c.key?G.copper:G.creamMuted,fontWeight:pick===c.key?800:500}}>
              {pick===c.key?"◉":"○"} {fmt(c)} 에 맞춰 함께 출고 ({c.orders.length}건)
            </button>
          ))}
        </div>

        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>onResolve({ merge:false })} style={{
            flex:1,padding:"12px",borderRadius:9,border:`1px solid ${G.border}`,background:"transparent",
            color:G.creamMuted,fontFamily:S,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            따로 보내기
          </button>
          <button onClick={()=>onResolve({ merge:true, target: choices.find(c=>c.key===pick) })} style={{
            flex:1,padding:"12px",borderRadius:9,border:"none",
            background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
            color:G.white,fontFamily:S,fontSize:13,fontWeight:800,cursor:"pointer"}}>
            합배송으로 묶기
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

// 닉네임/이름 비교용 정규화 — 공백·대소문자 차이만으로 같은 고객이 다른 사람으로 갈리는 것 방지.
// 실제 사고 사례: "골목길 공방"/"골목길공방", "모갱2  5572"/"모갱2 5572",
//                "이서영 용인"/"이서영용인" → 매번 고객이 새로 등록돼 완전 중복 발생.
const normLoose = raw => String(raw || "").replace(/\s+/g, "").toLowerCase();

// 로하톡 메모에 붙은 고객연결이 본문과 맞는지 검사.
// 이름·전화(풀)·중간 4자리·닉네임 중 하나라도 본문에 있으면 인정, 하나도 없으면 잘못 붙은 것으로 본다.
// 사유: 로하톡 입력창에서 고객검색으로 골라만 놓고 그 내용을 지운 뒤 다른 주문 글을 보내면,
//       고른 고객이 그대로 딸려가 등록 화면이 엉뚱한 사람으로 뜬다.
//       실제 사고: 박선영 주문 메모에 문숙희가 붙어 문숙희로 떴다 (2026-08-21).
// 실측(고객연결 408건): 404건 인정 / 4건 차단 — 차단된 4건은 전부 오연결이었다.
function noteMentionsCustomer(body, c) {
  const text = String(body || "");
  if (!c || !text) return false;
  const digits = text.replace(/\D/g, "");
  const cd = String(c.phone || "").replace(/\D/g, "");
  if (c.name && text.includes(c.name)) return true;
  if (cd.length >= 10 && digits.includes(cd)) return true;
  if (cd.length >= 10 && digits.includes(cd.slice(3, 7))) return true; // 본문이 "이름5717" 처럼 중간 4자리만 적는 경우
  if (cd.length === 4 && digits.includes(cd)) return true;             // 중간 4자리만 저장된 legacy 고객
  const nick = normLoose(c.nickname);
  if (nick && normLoose(text).includes(nick)) return true;
  return false;
}

function matchCustomer(parsed, customers) {
  const pName = parsed.customerName || null;
  const pMid = parsed.customerMidPhone || null;
  const pNick = parsed.customerNickname || null;
  const pPhone = parsed.phone || null;
  const pAddr = parsed.address || null;

  if (!pName && !pMid && !pNick && !pPhone && !pAddr) return { type: "new", match: null, list: [] };

  // 각 고객에 대해 매칭 점수 계산
  const scored = customers.map(c => {
    let score = 0;
    let nameMatch = false, midMatch = false, nickMatch = false, addrMatch = false;

    // 닉네임 명시 충돌 — 입력에 닉네임이 있고 후보의 닉네임이 있는데 다르면
    // 명시적으로 다른 사람으로 간주하여 매칭 후보에서 제외.
    // 예: "김양희 6750(초보일꾼)" 입력 시 nickname="김양희"인 김양희는 제외하고
    //     nickname="초보일꾼"인 김애숙만 후보로 남게 함 (mid 4자리가 같은 동명이인 사고 방지).
    // 비교는 정규화 후 — 공백 차이는 같은 닉네임으로 본다.
    if (pNick && c.nickname && normLoose(c.nickname) !== normLoose(pNick)) {
      return { customer: c, score: 0, nameMatch, midMatch, nickMatch, addrMatch };
    }

    if (pName && c.name && c.name.includes(pName)) { score++; nameMatch = true; }
    // 폰 매칭은 phoneMatches로 — 풀 폰 동시 보유 시 전체 일치 강제, 그 외엔 mid 4 fallback
    if (phoneMatches(pPhone, c.phone, pMid)) { score++; midMatch = true; }
    if (pNick && c.nickname && normLoose(c.nickname) === normLoose(pNick)) { score++; nickMatch = true; }
    // 주소 부분 매칭 — 동명이인 식별 보조 신호 (mid 4자리만 같고 닉네임 없는 케이스에서 유효)
    // 배송지2 일치도 동일 신호로 인정
    if (addressMatches(pAddr, c.address) || addressMatches(pAddr, c.address2)) { score++; addrMatch = true; }

    return { customer: c, score, nameMatch, midMatch, nickMatch, addrMatch };
  }).filter(s => s.score > 0).sort((a,b) => b.score - a.score);

  if (scored.length === 0) return { type: "new", match: null, list: [] };

  const best = scored[0];

  // 2가지 이상 일치 + 이름 일치 → 자동 확정.
  // 이름 불일치 시(midMatch+nickMatch만 일치)엔 점수가 높아도 자동 확정 X — maybe 팝업으로 사용자 확인 받기.
  // 사유: 이전에 잘못 확정된 다른 고객의 닉네임이 덮어쓰기로 같아져 있을 때, 같은 중간번호 가진 다른 고객으로
  //      자동 확정되는 사고를 막기 위함 (예: 김애숙 주문이 동일 mid+동일 닉네임 가진 김양희로 자동 등록).
  if (best.score >= 2 && best.nameMatch) {
    // 번호 변경 감지 — 둘 다 풀 폰(10+자리)이고 digit 일치하지 않을 때만.
    // 표기 차이(010-0000-0000 / 01000000000 / 010.0000.0000)는 같은 번호로 처리.
    // 한쪽이 가운데 4자리만 있으면(legacy) 변경 여부 판단 불가 → 트리거 X.
    const oDigits = String(pPhone || "").replace(/\D/g, "");
    const cDigits = String(best.customer.phone || "").replace(/\D/g, "");
    const bothFull = oDigits.length >= 10 && cDigits.length >= 10;
    if (bothFull && oDigits !== cDigits) {
      return { type: "phone_changed", match: best.customer, list: [] };
    }
    return { type: "confirmed", match: best.customer, list: [] };
  }

  // 이름 불일치 + mid/nick 매치 → 사용자 확인 필요
  if (best.score >= 2 && !best.nameMatch) {
    return { type: "maybe", match: best.customer, list: [] };
  }

  // 1가지만 일치
  if (best.midMatch || best.nickMatch) {
    return { type: "maybe", match: best.customer, list: [] };
  }

  // 이름만 일치 → 동명이인 목록
  if (best.nameMatch) {
    const nameMatches = scored.filter(s => s.nameMatch).map(s => s.customer);
    if (nameMatches.length === 1) {
      return { type: "maybe", match: nameMatches[0], list: [] };
    }
    return { type: "name_list", match: null, list: nameMatches };
  }

  return { type: "new", match: null, list: [] };
}

const RECEIPT_OPTS = [
  {v:null,         l:"발행 안 함",   c:"creamMuted", bg:"transparent"},
  {v:"cash",       l:"🧾 현금영수증", c:"red",        bg:"redBg"},
  {v:"business",   l:"📋 지출증빙",   c:"blue",       bg:"blueBg"},
  {v:"tax_invoice",l:"📄 계산서",     c:"green",      bg:"greenBg"},
];

const UNIT_OPTS = ["마","세트","필","롤","kg"];
const emptyItem = () => ({itemNo:"",fabric:"",color:"",qty:0,unit:"마",amount:0,unitPrice:0});

// ── 품번(products) 자동완성 — 롤 재고 1단계의 품번 마스터 기준 ────────────────
// 옛 inventory(원단 종류당 수량 하나)는 아무도 쓰지 않아 0행이다. 이제 품목은 products 에
// 맞추고, "얼마나 있나"는 롤 요약(rollSummary: productId → {maxRemaining, ...})에서 본다.
// 가용치는 합계가 아니라 가장 긴 롤(최대 재단 가능)이다 — 재단 주문은 한 롤에서 끊어 나간다.
// 롤 번호가 붙어 있어도(S-2610-0010-R01) 품번 S-2610-0010 으로 찾는다 — 로하톡 글에 롤 라벨 코드를 그대로 적는 셀러가 있다.
const productByCode = (products, code) => {
  const k = baseProductCode(code);
  return k ? (products || []).find(p => baseProductCode(p.code) === k) || null : null;
};
const productById = (products, id) => (id ? (products || []).find(p => p.id === id) || null : null);
// 품목이 가리키는 품번 — productId 우선, 없으면 손으로 친 품번(itemNo)으로.
const productOfItem = (products, item) =>
  productById(products, item?.productId) || productByCode(products, item?.itemNo);
// 제안 목록 — 코드·원단명·색상 어느 것으로든. 정확히 일치하는 코드가 맨 앞.
const suggestProducts = (products, q, limit = 6) => {
  const s = String(q || "").trim();
  if (!s) return [];
  const k = s.toLowerCase();
  return (products || []).filter(p => matchProduct(p, s))
    .sort((a, b) => (String(b.code).toLowerCase() === k) - (String(a.code).toLowerCase() === k))
    .slice(0, limit);
};
// 제안을 골랐을 때 품목에 넣을 값. 단가는 비어 있을 때만 품번의 것을 쓴다.
const pickProductPatch = (p, item) => {
  const patch = { itemNo: p.code, fabric: p.name, color: p.color || "", productId: p.id };
  if (!(parseInt(item?.unitPrice) || 0) && p.unitPrice) {
    const qty = parseFloat(item?.qty) || 0;
    patch.unitPrice = p.unitPrice;
    if (qty > 0) patch.amount = Math.round(p.unitPrice * qty);
  }
  return patch;
};
// 제안 한 줄의 재고 표시 — "최대 재단 N마", 없으면 빨간 "재고 없음"
const stockHint = (rollSummary, p, G) => {
  const s = rollSummary?.get?.(p.id);
  const max = s ? s.maxRemaining : 0;
  return max > 0
    ? <span style={{fontSize:10,color:G.creamMuted,whiteSpace:"nowrap"}}>최대 재단 {fmtLen(max)}{p.unit || "마"}</span>
    : <span style={{fontSize:10,color:G.red,fontWeight:800,whiteSpace:"nowrap"}}>재고 없음</span>;
};
// 직접입력 품목의 아이템 No·색상 입력 표시 여부 — 당분간 미사용이라 가림.
// 기능·데이터(프리필/등록/재고매칭)는 그대로 유지되며, true로 바꾸면 다시 보임.
const SHOW_ITEM_NO_COLOR = false;
// 직접입력 결제상태(미입금/입금완료) 탭 표시 여부 — 직접입력은 전부 미입금으로 등록하므로 가림.
// false면 결제상태가 항상 '미입금'으로 고정됨(메모 프리필의 입금완료도 무시). true로 바꾸면 원래대로.
const SHOW_PAYMENT_TABS = false;
// AI 붙여넣기 모드 — 2026-10-07 사용자 결정으로 탭에서 뺐다(그 자리에 🔗 주문 링크). 코드는 남겨 두고 스위치로만 끈다.
// 로하톡 메모 → 등록 경로는 같은 aiParseText 를 쓰지만 직접입력 폼으로 들어가므로 이 스위치와 무관하다.
const SHOW_AI_PASTE = false;

// 직접입력 폼 구역 헤더 — 번호 칩 + 제목. first가 아니면 카드 전체 폭 구분선으로 구역을 나눔.
function SecHead({n, title, G, first = false}) {
  return (
    <div style={{margin:first?"0 0 10px":"16px -16px 10px",padding:first?0:"14px 16px 0",borderTop:first?"none":`1px solid ${G.border}`,display:"flex",alignItems:"center",gap:7}}>
      <span style={{width:18,height:18,borderRadius:"50%",background:G.copperGlow,border:`1px solid ${G.copper}`,color:G.copper,fontSize:10,fontWeight:800,display:"inline-flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontFamily:SF}}>{n}</span>
      <span style={{fontSize:12,fontWeight:800,color:G.cream,letterSpacing:"0.03em",fontFamily:S}}>{title}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 직접 입력 폼 — AI 분석 없이 구조화된 필드로 주문 작성.
// 등록 자체는 부모의 submitOrder(onSubmit)에 위임 (고객 upsert·이미지·합산 등 공유).
// ──────────────────────────────────────────────────────────────
function ManualOrderForm({products = [], rollSummary = null, customers, credits, activeManager, showToast, onSubmit, onCreateLink, deliveryPresets, onDeletePreset, G, initial = null}) {
  const [noteId, setNoteId] = useState(initial?.noteId || null); // 메모에서 넘어온 경우 등록 성공 시 그 메모를 '등록됨' 처리 — 초기화하면 연결 해제
  // 링크 주문 초안에서 넘어온 경우 — 등록 성공 시 그 초안을 '전환됨' 처리. 고객이 고른 합배송 대상은 mergeIds 로 등록 경로에 넘긴다.
  const draftId = initial?.draftId || null;
  const draftMergeIds = initial?.mergeIds || [];
  const [name, setName] = useState(initial?.name || "");
  const [selectedCust, setSelectedCust] = useState(initial?.selectedCust || null);
  const [nickname, setNickname] = useState(initial?.nickname || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [address, setAddress] = useState(initial?.address || "");
  const [addressDetail, setAddressDetail] = useState(initial?.addressDetail || "");
  const [deliveryMessage, setDeliveryMessage] = useState(initial?.deliveryMessage || "");   // 링크 초안의 배송 메모가 송장 배송메시지로
  const [salesChannel] = useState(initial?.salesChannel || "");   // 판매처 — 링크 초안("밴드 링크"/"쪽지 링크")에서만 들어온다. 폼에서 바꾸진 않는다
  const [links, setLinks] = useState(initial?.links?.length ? [...initial.links, ""] : [""]);
  const [payment, setPayment] = useState(SHOW_PAYMENT_TABS ? (initial?.payment || "미입금") : "미입금");
  const [items, setItems] = useState(initial?.items?.length ? initial.items : [emptyItem()]);
  const [shippingFee, setShippingFee] = useState(initial?.shippingFee || 0);
  // 택배사 — null 이면 자동(배송비로 판정). 배송비와 안 맞는 주문만 셀러가 직접 고른다.
  const [courier, setCourier] = useState(initial?.courier || null);
  const [otherCost, setOtherCost] = useState(initial?.otherCost || 0);
  const [creditUse, setCreditUse] = useState(initial?.creditUse || 0); // 적립금 사용액 — 기존 고객 선택 + 잔액 보유 시에만 노출
  const [memo, setMemo] = useState(initial?.memo || "");
  const [note, setNote] = useState(initial?.note || ""); // 일반 메모(주문 카드 💬) — 메모장 원문 헤더 등이 프리필됨
  const [receiptType, setReceiptType] = useState(initial?.receiptType ?? null);
  const [custEditing, setCustEditing] = useState(false); // 기존 고객 카드 → 필드 수정 모드
  const [wantFreeShipping, setWantFreeShipping] = useState(initial?.wantFreeShipping || false); // 메모에 무료배송권 언급 → 등록 시 자동 차감
  const [combinedShipping, setCombinedShipping] = useState(!!initial?.combinedShipping); // 메모에서 합배송 감지 → 주문에 📦 합배송 표시
  // 출고예정일 — 기본은 다음 영업일. 등록 직전에 긴급/당일/날짜지정으로 변경 가능
  const [shipDate, setShipDate] = useState(initial?.shipDate || defaultShipDate());
  const [isUrgent, setIsUrgent] = useState(!!initial?.isUrgent);
  const [combinedPayment, setCombinedPayment] = useState(!!initial?.combinedPayment); // 메모에서 합입금 감지 → 주문에 🔗 합입금 표시
  const [images, setImages] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [missingAsk, setMissingAsk] = useState(false); // 수량·금액 빈칸 확인창
  const [custFocus, setCustFocus] = useState(false);
  const [fabricFocus, setFabricFocus] = useState(null); // 품번 제안이 열린 품목 자리번호
  const [addrOpen, setAddrOpen] = useState(false);
  const fileRef = useRef(null);

  const itemsSum = items.reduce((s,x)=>s+(parseInt(x.amount)||0),0);
  const total = itemsSum + (parseInt(shippingFee)||0) + (parseInt(otherCost)||0);

  // ── 등록 전 확인이 필요한 품목 ──────────────────────────────────────────
  // 자유 형식으로 적은 주문글에서 AI 가 수량·금액을 못 채우는 일이 있다.
  //  · "수입나염 / 17500원" — 몇 마인지 글에 없다 → 수량이 빈다
  //  · "밀파+프라다린넨 각한세트 / 37500+4000=51500원" — 품목별 금액이 없어
  //    한쪽에 몰리고 다른 쪽이 0원이 된다
  // 폼의 지금 값으로 본다(프리필이 아니라). 사람이 채우는 순간 경고가 사라진다.
  //
  // 금액이 빈 것을 언제 잡을지가 까다롭다. 전부 0 인 주문은 무료나눔·배송권 사용처럼
  // 정상인 경우가 있어서 무턱대고 잡으면 안 된다. 그래서 두 신호 중 하나가 있을 때만 잡는다.
  //
  //  · 섞임(someHasAmount) — 어떤 품목엔 금액이 있는데 이것만 0. 명백히 빠진 것.
  //  · 돈이 덜 들어옴(moneyMissing) — 주문글에 적힌 총액이 폼 합계보다 크다.
  //
  // 두 번째가 없으면 정작 고치려던 경우를 놓친다. "밀파+프라다린넨 / 37500+4000=51500원"
  // 은 두 품목이 모두 비어 섞임이 성립하지 않는데, 글에는 51,500원이라 적혀 있고
  // 폼 합계는 배송비 4,000원뿐이다 — 여기서 잡아야 한다.
  //
  // 수동으로 새로 치는 주문에는 noteTotal 이 없어 moneyMissing 이 false 다.
  // 금액을 아직 안 친 것뿐인데 경고가 뜨는 일은 없다.
  const filledItems = items.filter(it => (it.fabric||"").trim() || (it.itemNo||"").trim());
  const someHasAmount = filledItems.some(it => (parseInt(it.amount)||0) > 0);
  const noteTotal = parseInt(initial?.noteTotal) || 0;
  const moneyMissing = noteTotal > 0 && noteTotal > total;
  const needCheck = filledItems.map(it => {
    const missing = [];
    if (!((parseFloat(it.qty)||0) > 0)) missing.push("수량");
    if ((someHasAmount || moneyMissing) && !((parseInt(it.amount)||0) > 0)) missing.push("금액");
    return missing.length ? { ...it, missing } : null;
  }).filter(Boolean);

  // 선택된 기존 고객의 적립금 잔액 (DepositTab getCreditBalance와 동일 계산)
  const creditBal = selectedCust
    ? (credits||[]).filter(c=>c.customer===selectedCust.name).reduce((s,c)=>s+(c.type==="적립"?c.amount:-c.amount),0)
    : 0;

  // 선택된 기존 고객의 무료배송권 보유 수 (null=조회 전/조회중)
  // 보유 확인이 안 되면(고객 미연결·0장) 사용 플래그를 강제 해제 — 메모에 '무료배송권'이
  // 적혀 있어도 실제 보유 고객이 아니면 할인 미리보기/차감 시도가 생기지 않게 함.
  const [fsBal, setFsBal] = useState(null);
  useEffect(() => {
    if (!selectedCust) { setFsBal(null); setWantFreeShipping(false); return; }
    let alive = true;
    db.getCustomerFreeShipping(selectedCust.name)
      .then(n => { if (alive) { setFsBal(n); if (n < 1) setWantFreeShipping(false); } })
      .catch(() => { if (alive) { setFsBal(0); setWantFreeShipping(false); } });
    return () => { alive = false; };
  }, [selectedCust]);

  // 고객 자동완성 — 이름/닉네임/연락처 부분 일치 (최대 8명)
  const q = name.trim().toLowerCase();
  const suggestions = (custFocus && q && !selectedCust)
    ? customers.filter(c => {
        const digits = q.replace(/\D/g,"");
        return (c.name && c.name.toLowerCase().includes(q))
          || (c.nickname && c.nickname.toLowerCase().includes(q))
          || (digits && c.phone && c.phone.replace(/\D/g,"").includes(digits));
      }).slice(0, 8)
    : [];

  const pickCustomer = (c) => {
    setSelectedCust(c);
    setName(c.name || "");
    setNickname(c.nickname || "");
    setPhone(c.phone || "");
    setAddress(c.address || "");
    setAddressDetail(c.addressDetail || "");
    setCreditUse(0); // 고객이 바뀌면 이전 고객 기준 적립금 사용액은 무효
    setCustFocus(false);
    setCustEditing(false); // 선택 즉시 간략 카드로 표시
  };

  const setItem = (i, patch) => setItems(p => p.map((x,j)=>j===i?{...x,...patch}:x));

  const addImages = (fileList) => {
    const files = Array.from(fileList).filter(f => f.type?.startsWith("image/"));
    if (files.length === 0) return;
    setImages(prev => {
      const merged = [...prev, ...files].slice(0, MAX_IMAGES);
      if (prev.length + files.length > MAX_IMAGES) showToast?.(`최대 ${MAX_IMAGES}장까지 첨부 가능`, "error");
      return merged;
    });
  };

  // 폼 전체 초기화 — 입력 내용이 있으면 확인 후 빈 폼으로. 메모 프리필 연결(noteId)도 해제
  const resetForm = () => {
    const hasContent = name.trim() || nickname.trim() || phone.trim() || address.trim() || addressDetail.trim()
      || deliveryMessage.trim() || memo.trim() || note.trim() || links.some(l=>l.trim()) || images.length>0
      || items.some(it=>(it.fabric||"").trim() || (it.itemNo||"").trim() || (it.color||"").trim() || it.qty || it.amount)
      || (parseInt(shippingFee)||0) || (parseInt(otherCost)||0) || (parseInt(creditUse)||0) || receiptType;
    if (hasContent && !window.confirm("입력한 내용을 모두 지우고 초기화할까요?")) return;
    setNoteId(null);
    setName(""); setSelectedCust(null); setNickname(""); setPhone(""); setAddress(""); setAddressDetail("");
    setDeliveryMessage(""); setLinks([""]); setPayment("미입금"); setItems([emptyItem()]);
    setShippingFee(0); setCourier(null); setOtherCost(0); setCreditUse(0); setMemo(""); setNote(""); setReceiptType(null);
    setImages([]); setCustEditing(false); setWantFreeShipping(false); setCombinedShipping(false); setCombinedPayment(false);
    setShipDate(defaultShipDate()); setIsUrgent(false);
  };

  // 등록 버튼 → 검증 → (빈칸 있으면) 확인창 → doSubmit
  const handleSubmit = () => {
    if (!name.trim()) { showToast?.("고객명을 입력하세요", "error"); return; }
    const validItems = items.filter(it => (it.fabric||"").trim() || (it.itemNo||"").trim());
    if (validItems.length === 0) { showToast?.("원단 항목을 1개 이상 입력하세요", "error"); return; }
    // 적립금 사용 검증 — 기존 고객 선택 시에만 유효 (연결 해제되면 0으로 리셋되지만 방어적으로 재확인)
    const cu = selectedCust ? (parseInt(creditUse)||0) : 0;
    if (cu > 0) {
      if (payment === "입금완료") { showToast?.("입금완료 주문에는 적립금을 사용할 수 없습니다", "error"); return; }
      if (cu > creditBal) { showToast?.(`적립금 잔액(${creditBal.toLocaleString()}원)을 초과할 수 없습니다`, "error"); return; }
      if (cu > total) { showToast?.("적립금 사용액이 주문 금액을 초과합니다", "error"); return; }
    }
    // 수량·금액이 빈 품목이 있으면 한 번 묻는다.
    // 하단 경고만으로는 지나친다 — 누르는 손이 이미 버튼에 가 있으면 안 읽힌다.
    if (needCheck.length > 0) { setMissingAsk(true); return; }
    doSubmit();
  };

  // 폼 → 등록 데이터. 등록(doSubmit)과 주문 링크 만들기(makeLink)가 같은 것을 쓴다.
  const buildData = () => {
    const cu = selectedCust ? (parseInt(creditUse)||0) : 0;
    const validItems = items.filter(it => (it.fabric||"").trim() || (it.itemNo||"").trim());
    return {
      customer: name.trim(),
      customerNickname: nickname.trim(),
      phone: phone.trim(),
      address: address.trim(),
      address_detail: addressDetail.trim(),
      deliveryMessage: deliveryMessage.trim(),
      payment,
      items: validItems.map(it => {
        const qv = parseFloat(it.qty)||0;
        const av = parseInt(it.amount)||0;
        return {
          itemNo: (it.itemNo||"").trim(),
          fabric: (it.fabric||"").trim(),
          color: (it.color||"").trim(),
          qty: qv,
          unit: it.unit||"마",
          amount: av,
          unitPrice: (parseInt(it.unitPrice)||0) || (qv>0 ? Math.round(av/qv) : 0),  // 마켓원장 단가 컬럼용
          ...(it.productId ? { productId: it.productId } : {}),   // 롤 재고의 품번. 포장대 스캔이 이걸로 대조한다
        };
      }),
      links: links.map(l=>l.trim()).filter(Boolean),
      memo: memo.trim() || null,
      note: note.trim() || null,
      receiptType,
      combinedShipping,
      combinedPayment,
      shipDate,
      isUrgent,
      shippingFee: parseInt(shippingFee)||0,
      courier,
      otherCost: parseInt(otherCost)||0,
      totalAmount: total,
      creditUse: cu,
      ...(salesChannel ? { salesChannel } : {}),   // 대시보드 채널별 매출·엑셀 B열
    };
  };

  const doSubmit = async () => {
    const data = buildData();
    setSubmitting(true);
    try {
      // 무료배송권은 보유가 확인된 고객만 — 메모 감지만으로는 차감 시도하지 않음
      await onSubmit(data, selectedCust, { skipItemNoCheck: true, imgs: images, noteId, draftId, mergeIds: draftMergeIds, wantFreeShipping: wantFreeShipping && !!selectedCust && (fsBal||0) >= 1 });
    } finally {
      setSubmitting(false);
    }
  };

  // 주문 링크 만들기(4단계-B 셀러 링크) — 폼 내용을 초안으로 저장하고 링크를 띄운다. orders 에는 안 쓴다.
  // 막는 이유를 돌려준다. 품번 없는 품목은 링크 불가 — 고객 화면에 재고 수량을 보여줘야 한다.
  const linkBlockReason = () => {
    if (!name.trim()) return "고객명을 입력하세요";
    if (!selectedCust && String(phone || "").replace(/\D/g, "").length < 10) return "기존 고객을 고르거나 이름과 전화번호를 입력하세요";
    const validItems = items.filter(it => (it.fabric||"").trim() || (it.itemNo||"").trim());
    if (validItems.length === 0) return "원단 항목을 1개 이상 입력하세요";
    const noPid = validItems.filter(it => !it.productId);
    if (noPid.length) return `품번이 없는 품목 ${noPid.length}개 — 링크는 품번이 있는 품목만 됩니다 (원단명 칸에서 품번을 고르세요)`;
    for (const it of validItems) {
      const q = parseFloat(it.qty) || 0;
      if (!(q > 0)) return `${it.fabric || it.itemNo} 수량을 입력하세요`;
      const s = rollSummary?.get?.(it.productId);
      const max = isRollUnit(it.unit) ? (s?.availableCount || 0) : (s?.maxRemaining || 0);
      if (q > max) return `${it.fabric || it.itemNo} — 최대 ${max}${it.unit || "마"} (주문 ${q})`;
    }
    return "";
  };
  const [linking, setLinking] = useState(false);
  const makeLink = async () => {
    const why = linkBlockReason();
    if (why) { showToast?.(why, "error"); return; }
    setLinking(true);
    try {
      await onCreateLink?.(buildData(), selectedCust, { mergeIds: draftMergeIds, wantFreeShipping: wantFreeShipping && !!selectedCust && (fsBal||0) >= 1 });
    } finally { setLinking(false); }
  };

  const moneyInput = (val, setVal, opts={}) => (
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <input type="text" inputMode="numeric"
        value={val?Number(val).toLocaleString():""}
        onChange={e=>setVal(parseInt(e.target.value.replace(/[^0-9]/g,""))||0)}
        placeholder="0"
        style={{...baseInp,flex:1,fontFamily:SF,fontWeight:700,fontSize:14,...(opts.inputStyle||{})}}/>
      <span style={{fontSize:12,color:G.creamMuted}}>원</span>
    </div>
  );

  return (
    <Card style={{marginBottom:14,paddingBottom:0}}>
      {/* ① 고객 · 배송 — 기존 고객 선택 시 간략 카드로 압축, 수정/연결해제 시 필드로 복귀 */}
      <SecHead n="1" title="고객 · 배송" G={G} first/>
      <div>
        {selectedCust && !custEditing ? (
          <div style={{padding:"10px 12px",background:G.greenBg,border:`1px solid ${G.green}40`,borderRadius:10}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:800,color:G.green,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span>✓ {name}</span>
                  {nickname && <span style={{fontSize:11,color:G.creamMuted,fontWeight:600,wordBreak:"break-all"}}>{nickname}</span>}
                  {phone && <span style={{fontSize:11,color:G.cream,fontWeight:600,fontFamily:SF}}>{phone}</span>}
                </div>
                {/* 모바일에서 긴 주소가 ...으로 잘리지 않도록 줄바꿈 허용 */}
                <div style={{fontSize:11,color:G.creamMuted,marginTop:3,lineHeight:1.5,wordBreak:"break-all"}}>
                  {(address || addressDetail) ? `${address}${addressDetail?` ${addressDetail}`:""}` : "배송지 미입력"}
                </div>
                {/* 배송지 2 보유 고객 — 어느 주소로 보낼지 선택 (선택한 주소가 주문에 들어감) */}
                {selectedCust.address2 && (
                  <div style={{display:"flex",gap:6,marginTop:7,flexWrap:"wrap"}}>
                    {[
                      {k:"1",l:"🏠 기본 배송지",a:selectedCust.address||"",d:selectedCust.addressDetail||""},
                      {k:"2",l:`📍 배송지 2${selectedCust.address2Label?` (${selectedCust.address2Label})`:""}`,a:selectedCust.address2||"",d:selectedCust.address2Detail||""},
                    ].map(opt=>{
                      const active = address===opt.a && addressDetail===opt.d;
                      return (
                        <button key={opt.k} type="button" onClick={()=>{setAddress(opt.a);setAddressDetail(opt.d);}}
                          style={{padding:"5px 11px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?G.green:G.border}`,background:active?`${G.green}1A`:"transparent",color:active?G.green:G.creamMuted,fontWeight:active?800:600,cursor:"pointer",fontFamily:S}}>
                          {active?"✓ ":""}{opt.l}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button onClick={()=>setCustEditing(true)} style={{flexShrink:0,fontSize:10,color:G.copper,background:G.copperGlow,border:`1px solid ${G.copper}40`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:S,fontWeight:700}}>수정</button>
              <button onClick={()=>{setSelectedCust(null);setCreditUse(0);setCustEditing(false);}} style={{flexShrink:0,fontSize:10,color:G.red,background:"none",border:`1px solid ${G.red}40`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:S,fontWeight:700}}>연결 해제</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{position:"relative"}}>
              <input
                value={name}
                onChange={e=>{setName(e.target.value);setSelectedCust(null);setCreditUse(0);}}
                onFocus={()=>setCustFocus(true)}
                onBlur={()=>setTimeout(()=>setCustFocus(false),150)}
                placeholder="고객 검색 — 이름 · 닉네임 · 연락처 (신규는 그대로 입력)"
                style={{...baseInp,width:"100%",boxSizing:"border-box"}}/>
              {suggestions.length>0 && (
                <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:60,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden",maxHeight:240,overflowY:"auto"}}>
                  {suggestions.map(c=>(
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
            {selectedCust && (
              <div style={{marginTop:6,fontSize:11,color:G.green,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
                <span>✓ 기존 고객</span>
                <button onClick={()=>setCustEditing(false)} style={{fontSize:10,color:G.copper,background:G.copperGlow,border:`1px solid ${G.copper}40`,borderRadius:6,padding:"2px 8px",cursor:"pointer",fontFamily:S}}>간략히</button>
                <button onClick={()=>{setSelectedCust(null);setCreditUse(0);setCustEditing(false);}} style={{fontSize:10,color:G.red,background:"none",border:`1px solid ${G.red}40`,borderRadius:6,padding:"2px 8px",cursor:"pointer",fontFamily:S}}>연결 해제</button>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
              <input value={nickname} onChange={e=>setNickname(e.target.value)} placeholder="닉네임" style={{...baseInp,width:"100%",boxSizing:"border-box"}}/>
              <input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="연락처 010-0000-0000" style={{...baseInp,width:"100%",boxSizing:"border-box"}}/>
            </div>
            <div style={{display:"flex",gap:6,marginTop:8}}>
              <input value={address} onChange={e=>setAddress(e.target.value)} placeholder="배송지 — 주소 검색을 눌러주세요" style={{...baseInp,flex:1,minWidth:0,boxSizing:"border-box"}}/>
              <button onClick={()=>setAddrOpen(true)} style={{flexShrink:0,padding:"0 14px",borderRadius:10,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:12,fontWeight:700,fontFamily:S,cursor:"pointer",whiteSpace:"nowrap"}}>🔍 검색</button>
            </div>
            <div style={{marginTop:8}}>
              <input value={addressDetail} onChange={e=>setAddressDetail(e.target.value)} placeholder="상세주소 (동/호 등)" style={{...baseInp,width:"50%",minWidth:200,boxSizing:"border-box"}}/>
            </div>
          </>
        )}
        {/* 배송지 메모 — 주문별 입력이라 카드 모드에서도 항상 표시 */}
        <div style={{marginTop:8}}>
          <DeliveryMessageInput value={deliveryMessage} onChange={setDeliveryMessage} presets={deliveryPresets} onDeletePreset={onDeletePreset} G={G}/>
          <div style={{fontSize:10,color:G.creamMuted,marginTop:4}}>📦 배송지 메모는 송장에 인쇄됩니다 (CJ <b style={{color:G.creamMuted}}>배송메세지1</b> · 경동 <b style={{color:G.creamMuted}}>메모</b>) · 입력한 메모는 기록되어 다음에 검색됩니다</div>
        </div>
        {addrOpen && <AddressSearchModal onComplete={({address})=>setAddress(address)} onClose={()=>setAddrOpen(false)}/>}
      </div>

      {/* ② 주문 품목 */}
      <SecHead n="2" title="주문 품목" G={G}/>
      <div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {items.map((item,i)=>{
            const noKey = (item.itemNo||"").trim().toLowerCase();
            // 이 품목이 가리키는 품번. 골랐거나(productId) 품번을 쳤거나(itemNo).
            const matched = productOfItem(products, item);
            const matchedSum = matched ? rollSummary?.get?.(matched.id) : null;
            // 제안 — 원단명 칸에 치는 글자로 찾는다(품번 칸은 가려져 있다). 이미 고른 품번의
            // 이름 그대로면 다시 띄우지 않는다. 칸에 커서가 있을 때만 보인다.
            const fabricQ = (item.fabric||"").trim();
            const fabricSugg = (fabricFocus === i && fabricQ && !(matched && matched.name === fabricQ))
              ? suggestProducts(products, fabricQ) : [];
            const invSugg = (noKey && !matched) ? suggestProducts(products, noKey, 5) : [];
            const pick = (p) => setItem(i, pickProductPatch(p, item));
            const qty = parseFloat(item.qty)||0;
            const amt = parseInt(item.amount)||0;
            // 단가는 별도 저장값 우선 — 수량 0일 때 먼저 입력해도 보존됨. 없으면 합금액/수량으로 역산.
            // 롤·필 줄의 '단가'는 롤 1개 가격이다(2026-10-07). 마당 가격을 넣어 두면 수량×단가≠금액이라 수정 때 금액이
            // 깨졌다(1롤 125,000원이 단가 칸을 건드리는 순간 5,000원). 롤은 금액에서 역산한 값을 단가로 본다 —
            // 옛 주문의 마당 단가도 한 번 손대면 롤 가격으로 바뀐다.
            const roll = isRollUnit(item.unit);
            const unitPrice = roll && qty>0 && amt>0 ? Math.round(amt/qty) : ((parseInt(item.unitPrice)||0) || (qty>0 ? Math.round(amt/qty) : 0));
            return (
              <div key={i} style={{padding:"10px 12px",background:G.surface,borderRadius:9,border:`1px solid ${G.border}`}}>
                {/* 1줄: 원단명 · 단가 · 수량 · 단위 */}
                <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                  <div style={{flex:"3 1 150px",minWidth:120,position:"relative"}}>
                    {/* 원단명을 고치면 골랐던 품번과의 연결을 푼다 — 이름은 바꿨는데 다른 품번의 롤을 찍게 되면 안 된다 */}
                    <input value={item.fabric} onChange={e=>setItem(i, item.productId ? {fabric:e.target.value, productId:null, itemNo:""} : {fabric:e.target.value})}
                      onFocus={()=>setFabricFocus(i)} onBlur={()=>setFabricFocus(f=>f===i?null:f)}
                      placeholder="원단명 (품번·원단명·색상으로 찾기)" style={{...baseInp,width:"100%",boxSizing:"border-box",fontSize:13,borderColor: matched ? G.green : baseInp.borderColor}}/>
                    {matched && (
                      <div style={{fontSize:10,marginTop:3,fontWeight:600,color:G.green}}>
                        ✓ <span style={{fontFamily:"monospace"}}>{matched.code}</span> {matched.name}{matched.color?` ${matched.color}`:""} ·{" "}
                        {(matchedSum?.maxRemaining || 0) > 0
                          ? <span>최대 재단 {fmtLen(matchedSum.maxRemaining)}{matched.unit || "마"}</span>
                          : <span style={{color:G.red,fontWeight:800}}>재고 없음</span>}
                      </div>
                    )}
                    {fabricSugg.length>0 && (
                      <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden"}}>
                        {fabricSugg.map(p=>(
                          <div key={p.id} onMouseDown={(e)=>{ e.preventDefault(); pick(p); }}
                            style={{padding:"8px 10px",cursor:"pointer",borderBottom:`1px solid ${G.border}`,fontSize:11,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,fontFamily:S}}
                            onMouseEnter={e=>e.currentTarget.style.background=G.surface}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <span><span style={{fontFamily:"monospace",fontWeight:700,color:G.copper,marginRight:6}}>{p.code}</span><span style={{color:G.cream}}>{p.name}{p.color?` ${p.color}`:""}</span></span>
                            {stockHint(rollSummary, p, G)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <input type="text" inputMode="numeric" value={unitPrice?unitPrice.toLocaleString():""} onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setItem(i,{unitPrice:v,amount:Math.round(v*qty)});}} placeholder="단가" style={{...baseInp,flex:"1 1 76px",minWidth:68,fontSize:13,padding:"9px 8px",textAlign:"right"}}/>
                  <input type="number" value={item.qty||""} onChange={e=>{const q=parseFloat(e.target.value)||0;const up=roll?unitPrice:(parseInt(item.unitPrice)||0);setItem(i,up>0?{qty:q,amount:Math.round(up*q),unitPrice:up}:{qty:q});}} placeholder="수량" style={{...baseInp,width:70,fontSize:13,padding:"9px 8px"}}/>
                  <select value={item.unit||"마"} onChange={e=>setItem(i,{unit:e.target.value})} style={{...baseInp,width:52,fontSize:12,padding:"9px 2px"}}>
                    {UNIT_OPTS.map(u=><option key={u}>{u}</option>)}
                  </select>
                  {items.length>1 && <button onClick={()=>setItems(p=>p.filter((_,j)=>j!==i))} style={{padding:"0 9px",height:38,borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S,fontSize:14,flexShrink:0}}>✕</button>}
                </div>
                {/* 2줄: (아이템 No · 색상 — 플래그로 숨김) + 합금액 표시. 합금액은 단가×수량 자동 계산이라 입력칸 대신 읽기 전용 표시 */}
                <div style={{display:"flex",gap:6,marginTop:6,alignItems:"center",flexWrap:"wrap"}}>
                  {SHOW_ITEM_NO_COLOR && <div style={{flex:"0 0 66px",width:66,position:"relative"}}>
                    <input value={item.itemNo||""} onChange={e=>setItem(i,{itemNo:e.target.value})} placeholder="No" style={{...baseInp,width:"100%",boxSizing:"border-box",height:38,fontSize:11,padding:"0 8px",fontFamily:"monospace",borderColor:noKey&&matched?G.green:noKey&&!matched?G.red:G.border}}/>
                    {noKey && matched && <div style={{fontSize:10,color:G.green,marginTop:3,fontWeight:600}}>✓ {matched.name}{matched.color?` ${matched.color}`:""}</div>}
                    {invSugg.length>0 && (
                      <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden"}}>
                        {invSugg.map(p=>(
                          <div key={p.id} onMouseDown={(e)=>{ e.preventDefault(); pick(p); }}
                            style={{padding:"8px 10px",cursor:"pointer",borderBottom:`1px solid ${G.border}`,fontSize:11,display:"flex",justifyContent:"space-between",gap:8,fontFamily:S}}
                            onMouseEnter={e=>e.currentTarget.style.background=G.surface}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <span><span style={{fontFamily:"monospace",fontWeight:700,color:G.copper,marginRight:6}}>{p.code}</span><span style={{color:G.cream}}>{p.name}{p.color?` ${p.color}`:""}</span></span>
                            {stockHint(rollSummary, p, G)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>}
                  {SHOW_ITEM_NO_COLOR && <input value={item.color} onChange={e=>setItem(i,{color:e.target.value})} placeholder="색상" style={{...baseInp,flex:"1 1 110px",minWidth:90,height:38,fontSize:12,padding:"0 8px"}}/>}
                  <div style={{marginLeft:"auto",display:"flex",alignItems:"baseline",gap:4}}>
                    <span style={{fontSize:10,color:G.creamMuted,fontWeight:600}}>합금액</span>
                    <span style={{fontFamily:SF,fontWeight:800,fontSize:14,color:amt?G.copper:G.creamMuted}}>{amt.toLocaleString()}</span>
                    <span style={{fontSize:10,color:G.creamMuted}}>원</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <button onClick={()=>setItems(p=>[...p,emptyItem()])} style={{width:"100%",marginTop:8,padding:"9px",fontSize:12,color:G.copper,background:"transparent",border:`1px dashed ${G.border}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>+ 항목 추가</button>
      </div>

      {/* ③ 금액 · 결제 · 영수증 */}
      <SecHead n="3" title={SHOW_PAYMENT_TABS ? "금액 · 결제 · 영수증" : "금액 · 영수증"} G={G}/>
      <div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div><FLabel>배송비</FLabel>{moneyInput(shippingFee,setShippingFee,{inputStyle:{color:G.blue}})}</div>
          <div><FLabel>기타비용</FLabel>{moneyInput(otherCost,setOtherCost,{inputStyle:{color:G.cream}})}</div>
        </div>
        <ShipDateField shipDate={shipDate} isUrgent={isUrgent} G={G}
          onChange={v => { setShipDate(v.shipDate); setIsUrgent(v.isUrgent); }}/>
        <CourierField memo={`${note}\n${memo}`} value={courier} onChange={setCourier}/>
        {/* 합배송 표시 — 메모 프리필에서 감지 시 주문에 📦 합배송 플래그로 저장 */}
        {combinedShipping && (
          <div style={{marginTop:8,padding:"8px 12px",background:G.copperGlow,borderRadius:8,border:`1px solid ${G.copper}40`,display:"flex",alignItems:"center",gap:8}}>
            <span style={{flex:1,fontSize:11,color:G.copper,fontWeight:700}}>📦 합배송 표시 — 메모에서 감지됨 · 등록 후 주문현황 '합배송 모아보기'에서 묶어주세요</span>
            <button type="button" onClick={()=>setCombinedShipping(false)} style={{flexShrink:0,fontSize:10,color:G.red,background:"none",border:`1px solid ${G.red}40`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:S,fontWeight:700}}>해제</button>
          </div>
        )}
        {/* 합입금 표시 — 메모 프리필에서 감지 시 주문에 🔗 합입금 플래그로 저장 */}
        {combinedPayment && (
          <div style={{marginTop:8,padding:"8px 12px",background:G.blueBg,borderRadius:8,border:`1px solid ${G.blue}40`,display:"flex",alignItems:"center",gap:8}}>
            <span style={{flex:1,fontSize:11,color:G.blue,fontWeight:700}}>🔗 합입금 표시 — 메모에서 감지됨 · 다른 주문과 입금이 합쳐진 건입니다</span>
            <button type="button" onClick={()=>setCombinedPayment(false)} style={{flexShrink:0,fontSize:10,color:G.red,background:"none",border:`1px solid ${G.red}40`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:S,fontWeight:700}}>해제</button>
          </div>
        )}
        {salesChannel && (
          <div style={{marginTop:8,padding:"6px 10px",background:`${G.purple}12`,borderRadius:8,border:`1px solid ${G.purple}40`,fontSize:11,color:G.purple,fontWeight:700}}>
            📢 판매처 {salesChannel} — 링크로 들어온 주문입니다{initial?.wantFreeShipping ? " · 고객이 무료배송권 사용을 골랐습니다(등록 때 1장 차감)" : ""}{(initial?.mergeIds||[]).length ? " · 고객이 이전 주문과 함께 보내기를 골랐습니다" : ""}
          </div>
        )}
        {/* 적립금(좌) · 무료배송권(우) — 보유한 것만 표시. 둘 다 있으면 나란히, 하나면 전체 폭 */}
        {selectedCust && (creditBal > 0 || (fsBal||0) >= 1) && (
          <div style={{display:"grid",gridTemplateColumns:(creditBal > 0 && (fsBal||0) >= 1)?"1fr 1fr":"1fr",gap:8,marginTop:8}}>
            {/* 적립금 사용 — 주문 등록과 동시에 적립금차감 처리 */}
            {creditBal > 0 && (
              <div style={{padding:"10px 12px",background:`${G.purple}12`,borderRadius:8,border:`1px solid ${G.purple}40`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:G.purple,fontWeight:800,letterSpacing:"0.04em"}}>💰 적립금</span>
                  <span style={{fontSize:11,color:G.purple,fontWeight:700}}>보유 {creditBal.toLocaleString()}원</span>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <div style={{flex:1,minWidth:0}}>{moneyInput(creditUse,setCreditUse,{inputStyle:{color:G.purple}})}</div>
                  <button type="button" onClick={()=>setCreditUse(Math.min(creditBal,total))}
                    style={{padding:"9px 10px",borderRadius:8,border:`1px solid ${G.purple}`,background:`${G.purple}1A`,color:G.purple,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S,flexShrink:0,whiteSpace:"nowrap"}}>
                    전액
                  </button>
                </div>
                {(parseInt(creditUse)||0) > 0 && payment==="입금완료" && (
                  <div style={{fontSize:10,color:G.red,marginTop:5,fontWeight:600}}>⚠ 입금완료 주문에는 사용 불가</div>
                )}
              </div>
            )}
            {/* 무료배송권 — 사용 선택 시 등록과 동시에 1장 자동 차감 (미입금 + 배송비>0 조건) */}
            {(fsBal||0) >= 1 && (
              <div style={{padding:"10px 12px",background:G.greenBg,borderRadius:8,border:`1px solid ${G.green}40`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:4,marginBottom:6,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:G.green,fontWeight:800,letterSpacing:"0.04em"}}>🎫 무료배송권</span>
                  <span style={{fontSize:11,color:G.green,fontWeight:700}}>보유 {fsBal}장</span>
                </div>
                <div style={{display:"flex",gap:5}}>
                  {[{v:false,l:"사용 안 함"},{v:true,l:"사용"}].map(o=>{
                    const active = wantFreeShipping===o.v;
                    return (
                      <button key={String(o.v)} type="button" onClick={()=>setWantFreeShipping(o.v)}
                        style={{flex:1,minWidth:0,padding:"8px 4px",borderRadius:8,border:`1.5px solid ${active?(o.v?G.green:`${G.creamMuted}88`):G.border}`,background:active?(o.v?G.greenBg:G.subtleBg):"transparent",color:active?(o.v?G.green:G.cream):G.creamMuted,fontWeight:active?800:600,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                        {o.v&&active?"✓ ":""}{o.l}
                      </button>
                    );
                  })}
                </div>
                {wantFreeShipping && (
                  <div style={{fontSize:10,color:G.creamMuted,marginTop:5}}>등록 시 1장 차감 (미입금 + 배송비 있을 때)</div>
                )}
              </div>
            )}
          </div>
        )}
        {/* 결제 상태 — 직접입력은 전부 미입금 등록이라 기본 숨김 (SHOW_PAYMENT_TABS) */}
        {SHOW_PAYMENT_TABS && (
          <div style={{display:"flex",gap:6,marginTop:8}}>
            {["미입금","입금완료"].map(p=>{
              const active = payment===p;
              return (
                <button key={p} type="button" onClick={()=>setPayment(p)}
                  style={{flex:1,padding:"9px",borderRadius:8,border:`1.5px solid ${active?(p==="입금완료"?G.green:G.copper):G.border}`,background:active?(p==="입금완료"?G.greenBg:G.copperGlow):"transparent",color:active?(p==="입금완료"?G.green:G.copper):G.creamMuted,fontWeight:active?800:600,fontSize:13,cursor:"pointer",fontFamily:S}}>
                  {p}
                </button>
              );
            })}
          </div>
        )}
        {/* 영수증 — 넓은 화면 한 줄 4개, 좁으면 2×2 */}
        <div style={{display:"flex",gap:5,marginTop:6,flexWrap:"wrap"}}>
          {RECEIPT_OPTS.map(opt=>{
            const active = receiptType===opt.v;
            const c = G[opt.c], bg = opt.bg==="transparent"?"transparent":G[opt.bg];
            return (
              <button key={String(opt.v)} type="button" onClick={()=>setReceiptType(opt.v)}
                style={{flex:"1 1 calc(25% - 4px)",minWidth:104,padding:"8px 6px",borderRadius:8,border:`1.5px solid ${active?c:G.border}`,background:active?bg:"transparent",color:active?c:G.creamMuted,fontWeight:active?800:600,fontSize:11,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                {opt.l}
              </button>
            );
          })}
        </div>
        <div style={{fontSize:10,color:G.creamMuted,marginTop:6}}>상품 {itemsSum.toLocaleString()} + 배송 {(parseInt(shippingFee)||0).toLocaleString()} + 기타 {(parseInt(otherCost)||0).toLocaleString()} = 합계는 하단에 자동 표시</div>
      </div>

      {/* ④ 부가정보 — 링크 · 담당자 메모 · 이미지 */}
      <SecHead n="4" title="부가정보" G={G}/>
      <div style={{marginBottom:14}}>
            {/* URL 링크 (여러 개 첨부 가능) */}
            <div style={{marginBottom:10}}>
              <FLabel>🔗 URL 링크 (밴드글 · 상품 등)</FLabel>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {links.map((lnk,i)=>(
                  <div key={i} style={{display:"flex",gap:6,alignItems:"center"}}>
                    <input value={lnk} onChange={e=>setLinks(p=>p.map((x,j)=>j===i?e.target.value:x))} placeholder="https://band.us/band/..." style={{...baseInp,flex:1,minWidth:0,boxSizing:"border-box",fontSize:12}}/>
                    {links.length>1 && <button onClick={()=>setLinks(p=>p.filter((_,j)=>j!==i))} style={{padding:"0 10px",height:38,borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S,fontSize:14,flexShrink:0}}>✕</button>}
                  </div>
                ))}
              </div>
              <button onClick={()=>setLinks(p=>[...p,""])} style={{width:"100%",marginTop:6,padding:"7px",fontSize:12,color:G.copper,background:"transparent",border:`1px dashed ${G.border}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>+ 링크 추가</button>
            </div>
            {/* 일반 메모 — 원문 헤더("W) 7/13 밴드주문") · 계산식 등, 주문 카드에 💬로 표시 */}
            <div style={{marginBottom:10}}>
              <FLabel>💬 메모</FLabel>
              <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="예: W) 7/13 밴드주문 (대표님합) — 원문 제목·계산식 등" rows={2}
                style={{...baseInp,width:"100%",boxSizing:"border-box",fontSize:12,padding:"8px 10px",resize:"vertical",minHeight:52,fontFamily:"inherit",lineHeight:1.45}}/>
            </div>
            {/* 담당자 메모 */}
            <div style={{marginBottom:10}}>
              <FLabel>📝 담당자 메모 (공유)</FLabel>
              <textarea value={memo} onChange={e=>setMemo(e.target.value)} placeholder="예: 고객 부재 시 경비실 맡김, 색상 다시 확인 등" rows={2}
                style={{...baseInp,width:"100%",boxSizing:"border-box",fontSize:12,padding:"8px 10px",resize:"vertical",minHeight:52,fontFamily:"inherit",lineHeight:1.45}}/>
            </div>
            {/* 이미지 첨부 */}
            <div>
              <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:6,display:"flex",justifyContent:"space-between"}}>
                <span>📷 이미지 첨부 (선택)</span><span style={{fontSize:10,color:G.creamMuted,fontWeight:500}}>{images.length}/{MAX_IMAGES}</span>
              </div>
              <div onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();addImages(e.dataTransfer?.files||[]);}}
                onClick={()=>fileRef.current?.click()}
                style={{border:`1.5px dashed ${G.border}`,borderRadius:10,padding:"11px",textAlign:"center",cursor:"pointer",background:G.surface,fontSize:11,color:G.creamMuted,marginBottom:8}}>
                파일 선택 · 드래그
              </div>
              <input ref={fileRef} type="file" multiple accept="image/*" onChange={e=>{addImages(e.target.files);e.target.value="";}} style={{display:"none"}}/>
              {images.length>0 && (
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(70px,1fr))",gap:6}}>
                  {images.map((f,i)=>{
                    const url=URL.createObjectURL(f);
                    return (
                      <div key={i} style={{position:"relative",aspectRatio:"1/1",borderRadius:8,overflow:"hidden",border:`1px solid ${G.border}`}}>
                        <img src={url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onLoad={()=>URL.revokeObjectURL(url)}/>
                        <button onClick={e=>{e.stopPropagation();setImages(prev=>prev.filter((_,j)=>j!==i));}} style={{position:"absolute",top:2,right:2,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(0,0,0,0.6)",color:"#fff",fontSize:11,cursor:"pointer"}}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
      </div>

      {/* 등록을 누르면 뜨는 확인창 — 하단 경고를 지나치는 것을 막는다 */}
      {missingAsk && (
        <MissingFieldAskModal
          ask={{ needCheck, noteTotal, total }} G={G}
          onResolve={(proceed) => { setMissingAsk(false); if (proceed) doSubmit(); }}
        />
      )}

      {/* 수량·금액이 빈 품목 경고 — 등록 버튼 바로 위. 막지는 않는다.
          세트 상품이나 무료나눔처럼 0 이 정상인 경우가 있어 사람이 판단해야 한다. */}
      {needCheck.length > 0 && (
        <div style={{margin:"0 0 10px",padding:"10px 12px",borderRadius:10,background:G.yellowBg||"rgba(217,164,65,0.12)",border:`1px solid ${G.yellow}55`}}>
          <div style={{fontSize:12,fontWeight:800,color:G.yellow,marginBottom:4}}>
            ⚠️ 확인이 필요한 품목 {needCheck.length}개
          </div>
          {needCheck.map((it,i)=>(
            <div key={i} style={{fontSize:11,color:G.creamMuted,lineHeight:1.7}}>
              · <b style={{color:G.cream}}>{(it.fabric||it.itemNo||"이름 없음")}{it.color?` ${it.color}`:""}</b>
              {" — "}{it.missing.join("·")}이 비어 있습니다
            </div>
          ))}
          {/* 주문글의 총액과 지금 합계가 다르면 나란히 보여준다. 금액을 못 채운 탓에
              합계가 배송비만 남은 경우를 사람이 바로 알아채라고. */}
          {noteTotal > 0 && noteTotal !== total && (
            <div style={{fontSize:11.5,color:G.cream,marginTop:5,paddingTop:5,borderTop:`1px solid ${G.yellow}33`}}>
              주문글의 총액은 <b style={{color:G.yellow}}>{noteTotal.toLocaleString()}원</b>
              <span style={{color:G.creamMuted}}> · 지금 </span>
              <b style={{color:G.creamMuted}}>{total.toLocaleString()}원</b>
            </div>
          )}
          <div style={{fontSize:10.5,color:G.creamMuted,marginTop:4}}>
            주문글에 안 적혀 있어 못 채운 값입니다. 세트 상품이면 그대로 두셔도 됩니다.
          </div>
        </div>
      )}

      {/* 하단 고정 바 — 합계 · 신규/기존 안내 · 등록 버튼. 스크롤 중에도 항상 보임.
          카드 위에 copperGlow를 겹쳐 불투명한 카퍼 톤 배경 — 다크/화이트 모드 모두 토큰에서 파생 */}
      <div className="oi-bottom-bar" style={{position:"sticky",bottom:0,zIndex:5,background:`linear-gradient(0deg, ${G.copperGlow}, ${G.copperGlow}), ${G.card}`,margin:"0 -16px",padding:"11px 16px 14px",borderTop:`2px solid ${G.copper}66`,borderRadius:"0 0 14px 14px",boxShadow:"0 -4px 14px rgba(0,0,0,0.12)",display:"flex",alignItems:"center",gap:12}}>
        <div className="oi-bottom-amt" style={{flex:1,minWidth:0}}>
          {name.trim() && (selectedCust
            ? <div style={{fontSize:10,fontWeight:700,color:G.green,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>✓ 기존 고객 {selectedCust.name} 님에게 추가</div>
            : <div style={{fontSize:10,fontWeight:700,color:G.blue,marginBottom:2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>🆕 {name.trim()} 님 신규 등록</div>)}
          {/* 금액 — 적립금·배송권 차감이 있으면 '실제 결제액'을 가장 크게, 차감 내역(총액 포함)은 위에 작게.
              차감이 없으면 종전대로 총액만 크게 (같은 숫자를 두 줄로 반복하지 않게) */}
          {(() => {
            const cu = (selectedCust && creditBal > 0) ? (parseInt(creditUse)||0) : 0;
            const fsFee = (wantFreeShipping && (fsBal||0) >= 1 && payment !== "입금완료") ? (parseInt(shippingFee)||0) : 0;
            const hasDeduct = cu > 0 || fsFee > 0;
            const payable = Math.max(0, total - cu - fsFee);
            return (
              <>
                {hasDeduct && (
                  <div style={{fontSize:10,fontWeight:700,marginBottom:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                    <span style={{color:G.creamMuted}}>총 {total.toLocaleString()}</span>
                    {cu > 0 && <><span style={{color:G.creamMuted}}> · </span><span style={{color:G.purple}}>적립금 -{cu.toLocaleString()}</span></>}
                    {fsFee > 0 && <><span style={{color:G.creamMuted}}> · </span><span style={{color:G.green}}>배송권 -{fsFee.toLocaleString()}</span></>}
                  </div>
                )}
                <div style={{fontFamily:SF,fontWeight:800,fontSize:20,color:G.copper,lineHeight:1.1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {(hasDeduct ? payable : total).toLocaleString()}
                  <span style={{fontSize:11,fontWeight:400,color:G.creamMuted,marginLeft:3}}>원</span>
                  {hasDeduct && <span style={{fontFamily:S,fontSize:10,fontWeight:800,color:G.green,marginLeft:6,letterSpacing:"0.04em"}}>결제</span>}
                </div>
                {wantFreeShipping && (fsBal||0) >= 1 && fsFee === 0 && (
                  <div style={{fontSize:10,color:G.yellow,fontWeight:600,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>🎫 배송권: {payment === "입금완료" ? "입금완료 주문엔 적용 안 됨" : "배송비가 없어 적용 안 됨"}</div>
                )}
              </>
            );
          })()}
        </div>
        <button type="button" onClick={resetForm} disabled={submitting} title="입력 내용 모두 지우기"
          className="oi-bottom-reset" style={{flexShrink:0,padding:"13px 12px",borderRadius:10,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontWeight:700,fontSize:12,cursor:submitting?"not-allowed":"pointer",fontFamily:S,opacity:submitting?0.5:1}}>
          ↺ 초기화
        </button>
        <button onClick={handleSubmit} disabled={submitting}
          className="oi-bottom-submit" style={{flexShrink:0,padding:"13px 26px",borderRadius:10,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontWeight:800,fontSize:15,cursor:submitting?"not-allowed":"pointer",fontFamily:S,boxShadow:`0 4px 24px ${G.copperGlow}`,opacity:submitting?0.6:1}}>
          {submitting ? <CuteLoader text="등록 중..." size="sm" color="#fff" /> : "◈  주문등록"}
        </button>
        {/* 주문 링크 만들기 — 셀러가 채운 주문서를 고객에게 쪽지로 보내 "이대로 주문" 한 번만 누르게 한다(4단계-B).
            막히는 이유는 누를 때 토스트로(태블릿엔 툴팁이 없다). 폼은 비우지 않는다 — 같은 고객에게 또 만들 수 있게. */}
        {onCreateLink && (() => { const why = linkBlockReason(); return (
          <button type="button" onClick={makeLink} disabled={submitting || linking} title={why || "고객에게 보낼 주문 링크를 만듭니다"}
            style={{flexShrink:0,padding:"13px 14px",borderRadius:10,border:`1px solid ${why ? G.border : G.purple}`,background:why ? "transparent" : "rgba(138,106,184,0.12)",color:why ? G.creamMuted : G.purple,fontWeight:800,fontSize:13,cursor:(submitting||linking)?"not-allowed":"pointer",fontFamily:S,opacity:why ? 0.7 : 1}}>
            {linking ? "만드는 중…" : "📨 주문 링크"}
          </button>
        ); })()}
      </div>
    </Card>
  );
}

function OrderInput({products = [], rollSummary = null, orders, setOrders, logs, setLogs, customers, setCustomers, setTab, showToast, kakaoAlert, managers, setManagers, activeManager, setActiveManager, shipOneOrder, reloadFreeShipping, credits, setCredits, tabActive = true, noteToRegister = null, onConsumeNote, onNoteRegistered, linkDrafts = [], draftToConvert = null, onConsumeDraft, onDraftConverted, onConvertDraft, onRejectDraft, onDeleteDraft, notes = [], onSendNote, onUpdateNoteBody, onDeleteNote, onRegisterNote, onSearchNotes, onToggleNoteReaction}) {
  const G = useTheme();
  const [inputMode, setInputMode] = useState("manual"); // "memo"(메모장) | "manual"(직접 입력) | "link"(주문 링크) | "ai"(AI 붙여넣기 — SHOW_AI_PASTE)
  const [manualKey, setManualKey] = useState(0); // 등록 성공 시 bump → 직접입력 폼 초기화
  const [linkMade, setLinkMade] = useState(null);     // 방금 만든 셀러 링크 { url, expiresAt, customer }
  const [manualNotice, setManualNotice] = useState(null); // 전환 폼 상단 안내 { kind, text } — 지난번 배송지·합배송 희망
  const [notesPopupOpen, setNotesPopupOpen] = useState(false); // 메모장 새 창(팝업) 열림 — PC 전용
  // 모바일에서는 팝업 대신 로하톡을 화면에 바로 띄움 (모바일 브라우저 팝업은 새 탭으로 열려 불편)
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= 640);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 모바일 로하톡 층의 세로 범위 — "키보드를 뺀 실제 보이는 영역"(visualViewport)에 맞춘다.
  // 안드로이드 크롬은 viewport 메타(interactive-widget=resizes-content)로 키보드가 뜨면
  // 화면 자체가 줄어 fixed 층도 따라 줄지만, iOS 사파리(카톡·밴드 안 브라우저 포함)는
  // 그 설정을 무시해 키보드가 위에 덮이기만 한다 → 맨 아래 입력창이 키보드 뒤로 들어갔다.
  // 값은 layout viewport(window.innerHeight) 대비 % 로 넣는다. fixed 요소의 % 는 .erp-root 의
  // zoom(글씨 배율)에 부풀지 않지만 px 는 배율만큼 커져 다시 넘친다(e31f360 실측).
  // 안드로이드처럼 innerHeight 가 같이 줄어드는 환경에선 자연히 0% / 100% 가 된다.
  const [vvBox, setVvBox] = useState({ top: 0, height: 100 });
  useEffect(() => {
    if (!isMobile || inputMode !== "memo") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const upd = () => {
      const H = window.innerHeight || 1;
      setVvBox({ top: (vv.offsetTop / H) * 100, height: (vv.height / H) * 100 });
    };
    upd();
    vv.addEventListener("resize", upd);
    vv.addEventListener("scroll", upd);
    return () => { vv.removeEventListener("resize", upd); vv.removeEventListener("scroll", upd); setVvBox({ top: 0, height: 100 }); };
  }, [isMobile, inputMode]);
  const [newManager, setNewManager] = useState("");
  const [showManagerForm, setShowManagerForm] = useState(false);
  const [txt, setTxt] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState("");
  const [skipItemNo, setSkipItemNo] = useState(true);
  const [custMatch, setCustMatch] = useState(null); // {type, match, list}
  // 메모 등록 시 글/고객카드 충돌 확인창 — {note, parsed, cust, addrConflict, phoneConflict}
  const [noteConflict, setNoteConflict] = useState(null);
  const [resolvedCustomer, setResolvedCustomer] = useState(null); // 확정된 고객
  // AI 분석 경로의 출고예정일 — 기본은 다음 영업일, 등록 직전에 변경 가능
  const [aiShipDate, setAiShipDate] = useState(defaultShipDate());
  const [aiUrgent, setAiUrgent] = useState(false);
  // 자동 합배송 확인창 — {newOrder, candidates, resolve}. resolve 로 submitOrder 를 다시 진행시킨다.
  const [mergeAsk, setMergeAsk] = useState(null);
  const [splitAsk, setSplitAsk] = useState(null);   // 품목 줄 나누기 확인창 { rows, resolve }
  // 등록 뒷정리(적립금·배송권·고객·합배송)를 한 줄로 세우는 대기열.
  // 화면은 주문이 저장되는 즉시 풀리므로 주문을 연달아 넣을 수 있는데, 같은 고객의
  // 뒷정리가 겹치면 totalOrders 를 둘 다 옛 값에서 +1 해 한 건이 사라진다.
  const tailQueueRef = useRef(Promise.resolve());
  const [images, setImages] = useState([]); // File[] — 업로드 대기중인 이미지
  const [imageUploading, setImageUploading] = useState(false);
  const fileRef = useRef(null);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [pendingMergeIds, setPendingMergeIds] = useState([]); // 등록 시 묶을 대상 주문 id[]
  const [deliveryPresets, setDeliveryPresets] = useState([]); // 자주 쓰는 배송지 메모 프리셋
  const [manualPrefill, setManualPrefill] = useState(null); // 메모 → 직접입력 폼 프리필 데이터
  const [notePrefilling, setNotePrefilling] = useState(false); // 메모 품목 분석중
  // 프리필 요청 일련번호 — 주문등록을 연속으로 누르면 AI 호출이 겹친다.
  // 가드가 없으면 늦게 끝난 쪽이 폼을 덮어써서, A를 눌렀는데 B 내용이 뜬다.
  const prefillSeq = useRef(0);

  // 배송지 메모 프리셋 로드
  useEffect(() => {
    let alive = true;
    db.fetchDeliveryPresets().then(p => { if (alive) setDeliveryPresets(p); }).catch(e => console.warn("배송메모 프리셋 로드 실패:", e));
    return () => { alive = false; };
  }, []);

  // 배송지 메모 기록 — 주문 등록 시 입력값을 프리셋으로 upsert
  const recordDeliveryPreset = async (text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    try {
      const saved = await db.addDeliveryPreset(trimmed);
      if (saved) setDeliveryPresets(prev => [saved, ...prev.filter(p => p.text !== saved.text)]);
    } catch (e) { console.warn("배송메모 기록 실패:", e); }
  };

  const deleteDeliveryPreset = async (id) => {
    setDeliveryPresets(prev => prev.filter(p => p.id !== id)); // 낙관적 제거
    try { await db.deleteDeliveryPreset(id); }
    catch (e) { console.warn("배송메모 삭제 실패:", e); showToast?.("배송메모 삭제 실패", "error"); }
  };

  // 이미지 추가 공통 로직 (파일/드래그/붙여넣기 공용)
  const addImages = (fileList) => {
    const files = Array.from(fileList).filter(f => f.type?.startsWith("image/"));
    if (files.length === 0) return;
    setImages(prev => {
      const merged = [...prev, ...files].slice(0, MAX_IMAGES);
      if (prev.length + files.length > MAX_IMAGES) {
        showToast?.(`최대 ${MAX_IMAGES}장까지 첨부 가능 — 초과분은 제외됨`, "error");
      }
      return merged;
    });
  };

  // 붙여넣기 → 이미지 첨부 (주문 분석 결과가 노출된 동안 + 현재 탭이 활성일 때만)
  useEffect(() => {
    if (!parsed || !tabActive) return;
    const onPaste = (e) => {
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addImages(files);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [parsed, tabActive]);

  const parse = async (overrideText) => {
    const source = (typeof overrideText === "string" ? overrideText : txt);
    if (!source.trim()) return;
    setParsing(true); setParsed(null); setErr(""); setCustMatch(null); setResolvedCustomer(null); setImages([]);
    setAiShipDate(defaultShipDate()); setAiUrgent(false);
    try {
      // AI 호출 전 prepass — 점 천단위/₩기호/닉네임순서/배송비표기 등 9가지 자동 정리. 품번 다듬기(괄호 품번 → 앞으로, 대문자)도.
      const cleanedText = preprocessOrderText(normalizeProductCodes(source));
      const result = await aiParseText(cleanedText);
      // AI 가 품번을 놓쳐도 글에 적힌 등록 품번을 같은 줄의 품목에 붙인다(lib/productCodes.js).
      if (Array.isArray(result?.items)) result.items = fillPriceFromProduct(attachProductCodes(cleanedText, result.items, products), products);
      // 영수증 종류 자동 감지 (AI가 못 잡아도 키워드 기반으로 보정)
      // 원본 source 사용 — prepass가 영수증 키워드를 건드리지 않지만 안전상 원본 유지.
      const detected = detectReceiptType(source);
      if (detected) result.receiptType = detected;
      // 합계 검증 + 자동 보정 (사용자가 totalAmount 명시한 경우만 작동)
      const validated = validateAndCorrectAmounts(result);
      setParsed(validated);
      // AI 분석 후 고객 매칭 실행
      const match = matchCustomer(validated, customers);
      if (match.type === "confirmed") {
        setResolvedCustomer(match.match);
        showToast(`기존 고객 확인: ${match.match.name}`);
      } else {
        setCustMatch({ ...match, parsed: result });
      }
    }
    catch(e) { setErr(e.message || "분석 실패. 다시 시도해주세요."); }
    finally { setParsing(false); }
  };

  // 주문 메모 → 직접입력 폼으로 연결.
  //  · 고객검색으로 붙인 메모(customerId 있음)는 그 고객을 분석 없이 그대로 선택
  //  · 나머지 품목·결제는 AI로 파싱해 직접입력 폼에 채워 넣음
  //  · 등록 성공 시 opts.noteId 로 해당 메모를 '등록됨' 처리 (ManualOrderForm이 전달)
  useEffect(() => {
    if (!noteToRegister) return;
    const note = noteToRegister;
    onConsumeNote?.();            // 부모의 noteToRegister 초기화 (재실행 방지)
    const seq = ++prefillSeq.current;   // 이 요청의 번호. 더 최신 클릭이 오면 이 결과는 버린다.
    setInputMode("manual");
    setNotePrefilling(true);
    // 분석 중에는 폼이 잠기지만, 커서가 이미 칸 안에 있으면 키 입력은 계속 들어간다.
    // 그 내용은 결과가 도착할 때 리마운트로 지워지므로, 아예 포커스를 빼둔다.
    try { document.activeElement?.blur?.(); } catch { /* noop */ }
    (async () => {
      let parsed = {};
      try {
        // 작성자를 같이 넘긴다 — FREEFORM_AUTHORS 에 있는 사람이면 전용 규칙이 붙는다.
        // 그 외에는 지금까지와 완전히 같은 프롬프트로 분석된다.
        // 품번 다듬기(lib/productCodes.js) → prepass → AI → AI 가 놓친 품번을 같은 줄에서 붙이기
        const bodyText = preprocessOrderText(normalizeProductCodes(note.body || ""));
        const r = await aiParseText(bodyText, { author: note.author });
        if (Array.isArray(r?.items)) r.items = attachProductCodes(bodyText, r.items, products);
        parsed = validateAndCorrectAmounts(r) || r || {};
      } catch (e) {
        console.error("메모 품목 분석 실패:", e);
        // 이미 지나간 요청의 실패로 최신 작업을 방해하지 않는다.
        if (seq === prefillSeq.current) showToast?.("품목 자동 분석 실패 — 직접 입력해 주세요", "error");
      }
      // 고객: 메모에 붙은 고객(customerId)이면 그대로, 없으면 파싱결과로 매칭.
      // 단, 붙은 고객의 흔적이 본문에 하나도 없으면 그 연결은 버리고 본문을 믿는다 (noteMentionsCustomer 참고).
      let selectedCust = null;
      if (note.customerId != null) {
        const linked = customers.find(c => c.id === note.customerId) || null;
        if (linked && noteMentionsCustomer(note.body, linked)) selectedCust = linked;
        else if (linked) {
          console.warn("메모 고객연결 무시 — 본문에 흔적 없음:", linked.name, note.id);
          showToast?.(`메모에 ${linked.name} 고객이 잘못 연결돼 있어 무시했어요 — 글 내용으로 찾습니다`, "error");
        }
      }
      if (!selectedCust) {
        try {
          const m = matchCustomer(parsed, customers);
          // phone_changed(이름·주소는 맞고 번호만 다름)도 그 고객으로 본다 — 전에는 빈 고객으로 떨어져
          // 같은 사람이 새 고객으로 하나 더 생겼다. 번호를 갱신할지는 아래 확인창에서 고른다.
          if (m.type === "confirmed" || m.type === "phone_changed") selectedCust = m.match;
        } catch { /* noop */ }
      }
      // 글에 적힌 주소·전화가 고객 카드와 다르면 어느 쪽을 쓸지 물어본다 (표기 차이는 묻지 않음)
      // 내가 더 이상 최신 요청이 아니면 여기서 멈춘다 — 뒤늦게 도착해 최신 결과를 덮지 않게.
      if (seq !== prefillSeq.current) return;
      const conflicts = detectNoteConflicts(parsed, selectedCust);
      if (conflicts) {
        setNoteConflict({ note, parsed, cust: selectedCust, ...conflicts });
        setNotePrefilling(false);
        return;
      }
      applyNotePrefill(note, parsed, selectedCust);
      setNotePrefilling(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteToRegister]);

  // 메모 → 등록 폼 프리필 적용.
  // choice 는 NoteConflictModal 에서 고른 값({address, phone}) — 없으면 기존 규칙대로 고객 카드 우선.
  // 링크 주문 초안 → 직접입력 폼. 메모 핸드오프와 같은 자리이되 AI 분석이 없다 — 초안은 이미 구조화돼 있다.
  // 새 orders insert 코드를 따로 쓰지 않는다: 폼을 채우고 셀러가 등록 버튼을 누르면 기존 흐름
  // (고객 중복 방어·합배송 3단계 규칙·배송권 차감·라벨 요청)이 전부 그대로 돈다.
  useEffect(() => {
    if (!draftToConvert) return;
    const draft = draftToConvert;
    onConsumeDraft?.();
    applyDraftPrefill(draft);
  }, [draftToConvert]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 셀러 링크 URL — 테스트 키는 VITE_LINK_TEST_KEY(내부 테스트 동안만 번들에. 고객 공개 때 제거).
  const sellerLinkUrl = (token) => {
    const k = (import.meta.env.VITE_LINK_TEST_KEY || "").trim();
    return `${location.origin}/o/t/${token}${k ? `?k=${encodeURIComponent(k)}` : ""}`;
  };
  // 공개 링크 URL(게시글) — 품번이 곧 주소. 만드는 단계가 따로 없어서, 🔗 주문 링크 탭에서 원단을 찾아 복사만 한다(2026-10-07).
  // ?m= 담당자 id — 이 링크로 들어온 주문은 복사한 담당자 것이 된다. 담당자를 안 골랐으면 링크를 못 만든다.
  // 담당자는 품번 담당자(입고한 사람)가 기본이고, 없으면 지금 작업자(2026-10-08).
  const linkOwnerOf = (p) => (p?.manager && managers.some(x => x.name === p.manager)) ? p.manager : activeManager;
  const publicLinkUrl = (code, ownerName = activeManager) => {
    const k = (import.meta.env.VITE_LINK_TEST_KEY || "").trim();
    const mid = managers.find(x => x.name === ownerName)?.id;
    const qs = [k ? `k=${encodeURIComponent(k)}` : "", mid ? `m=${mid}` : ""].filter(Boolean).join("&");
    return `${location.origin}/o/${encodeURIComponent(code)}${qs ? `?${qs}` : ""}`;
  };
  const linkManagerOk = !!(activeManager && managers.find(x => x.name === activeManager)?.id);
  const [linkQ, setLinkQ] = useState("");            // 🔗 주문 링크 탭 — 원단 검색어
  const [linkCopied, setLinkCopied] = useState("");  // 방금 복사한 품번(버튼 표시용)
  const copyText = async (text, okMsg) => {
    try { await navigator.clipboard.writeText(text); showToast?.(okMsg); return true; }
    catch { window.prompt("복사하세요", text); return false; }
  };
  const createSellerLink = async (data, cust, opts = {}) => {
    try {
      const items = (data.items || []).map(it => ({ productId: it.productId, code: it.itemNo, name: it.fabric, color: it.color, qty: it.qty, unit: it.unit, unitPrice: it.unitPrice, amount: it.amount }));
      const d = await db.createSellerLinkDraft({
        items, customerName: data.customer, phone: data.phone, customerId: cust?.id || null,
        address: data.address, addressDetail: data.address_detail, deliveryMessage: data.deliveryMessage,
        mergeWithOrderId: opts.mergeIds?.[0] || null, useFreeShipping: !!opts.wantFreeShipping,
        shippingFee: data.shippingFee, totalAmount: data.totalAmount, createdBy: activeManager || "",
      });
      setLinkMade({ url: sellerLinkUrl(d.token), expiresAt: d.expiresAt, customer: data.customer });
    } catch (e) {
      console.error("주문 링크 만들기 실패:", e);
      showToast?.("주문 링크 만들기 실패: " + e.message, "error");
    }
  };

  const applyDraftPrefill = (draft) => {
    // 담당자 — 링크를 만든(복사한) 담당자가 초안에 적혀 있으면 그 사람으로 등록되게 담당자 선택을 맞춘다.
    // 전환하는 사람이 다른 사람이어도 주문은 링크 주인 것이다(2026-10-07).
    if (draft.createdBy && managers.some(x => x.name === draft.createdBy) && draft.createdBy !== activeManager) {
      setActiveManager(draft.createdBy);
      showToast?.(`담당자를 ${draft.createdBy} 으로 맞췄습니다 (링크를 만든 담당자)`);
    }
    const product = (products || []).find(p => p.id === draft.productId) || null;
    const cust = draft.customerId ? (customers.find(c => c.id === draft.customerId) || null) : null;
    const qv = Number(draft.qty) || 0;
    const up = draft.unitPrice === null || draft.unitPrice === undefined ? 0 : Number(draft.unitPrice);
    // 롤 주문 — 고객이 고른 롤. 롤마다 한 줄(1롤, 금액 = 단가 × 그 롤 길이)로 만든다. 등록의 "롤은 한 줄에 1개씩"
    // 분할창이 안 뜨고, 줄별 금액이 맞는다(분할 코드는 첫 줄에 단가×1 을 넣어 틀어진다). 어느 롤인지는 메모에도 적어 포장대가 본다.
    const pickedRolls = Array.isArray(draft.rolls) && draft.rolls.length ? draft.rolls : null;
    const pickedLen = pickedRolls ? Math.round(pickedRolls.reduce((s, r) => s + (Number(r.length) || 0), 0) * 100) / 100 : 0;
    // 택배비 — 고객이 배송권이나 합배송을 골라 초안이 0원이면 단위 기본값(마 4,000 · 롤 7,000)으로 올린다.
    // 배송권은 택배비가 있어야 등록 때 1장 차감되고(로그로 상쇄), 합배송은 3단계 규칙이 겹치는 택배비를 내려놓으며
    // 금액을 기억해야 나중에 되돌린다. 로하톡·직접 입력에서 셀러가 0원으로 등록하는 길은 건드리지 않는다.
    const feeZeroByChoice = (draft.source !== "seller") && (!!draft.useFreeShipping || !!draft.mergeWithOrderId) && !(Number(draft.shippingFee) > 0);
    const prefillFee = feeZeroByChoice ? linkBaseFee(draft.unit) : (Number(draft.shippingFee) || 0);
    const digits = String(draft.phone || "").replace(/\D/g, "");
    const phone = digits.length === 11 ? `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}` : (draft.phone || "");
    const mergeIds = draft.mergeWithOrderId && orders.find(o => o.id === draft.mergeWithOrderId) ? [draft.mergeWithOrderId] : [];
    if (draft.mergeWithOrderId && mergeIds.length === 0) showToast?.("합배송 대상 주문을 지금 목록에서 찾지 못했습니다 — 등록 전에 확인해 주세요", "error");
    // 공개 링크 초안의 택배비는 보여주기용(baseFee). 등록하면 미출고 주문이 있을 때 자동 합배송과 3단계 규칙이 다시 정한다.
    const address = draft.address || "", addressDetail = draft.addressDetail || "";
    setManualNotice(null);
    // 셀러 링크(items 전부) / 공개 링크(품목 1개)
    const draftItems = Array.isArray(draft.items) && draft.items.length ? draft.items.map(it => {
      const p = (products || []).find(x => x.id === it.productId) || null;
      const q2 = Number(it.qty) || 0, up2 = Number(it.unitPrice) || 0;
      return { itemNo: it.code || p?.code || "", fabric: it.name || p?.name || "", color: it.color || p?.color || "", qty: q2, unit: it.unit || p?.unit || "마", unitPrice: up2, amount: up2 > 0 ? Math.round(up2 * q2) : (Number(it.amount) || 0), ...(it.productId ? { productId: it.productId } : {}) };
    }) : null;
    setInputMode("manual");
    setManualPrefill({
      draftId: draft.id,
      selectedCust: cust,
      name: draft.customerName || cust?.name || "",
      nickname: cust?.nickname || "",
      phone,
      address, addressDetail,
      payment: "미입금",
      shippingFee: prefillFee,
      deliveryMessage: draft.deliveryMessage || "",
      salesChannel: draft.source === "seller" ? "쪽지 링크" : "밴드 링크",
      mergeIds,
      combinedShipping: mergeIds.length > 0,
      wantFreeShipping: !!draft.useFreeShipping,
      // 고객이 링크에서 적은 적립금 — 폼의 적립금 칸에 들어가고, 등록 때 잔액·미수금 안으로 다시 깎인다(기존 고객일 때만 유효)
      creditUse: Number(draft.creditUse) || 0,
      // 입금자명·배송 메모는 주문 메모로 — orders 에 입금자 칸이 없다. 입금 대조 때 메모에서 본다.
      note: [pickedRolls ? `선택 롤: ${pickedRolls.map(r => `${r.rollCode}(${r.length}마)`).join(", ")} = ${pickedLen}마` : "", draft.depositorName && draft.depositorName !== draft.customerName ? `입금자명: ${draft.depositorName}` : ""].filter(Boolean).join(" / "),
      items: draftItems || (pickedRolls ? pickedRolls.map(r => ({
        itemNo: draft.productCode || "", fabric: product?.name || draft.productName || "", color: product?.color || "",
        // 롤 줄의 단가 = 롤 1개 가격(마당 단가 × 그 롤 길이). 수량 1 × 단가 = 금액이 어디서나 맞는다
        qty: 1, unit: "롤", unitPrice: Math.round(up * (Number(r.length) || 0)), amount: Math.round(up * (Number(r.length) || 0)),
        ...(draft.productId ? { productId: draft.productId } : {}),
      })) : [{
        itemNo: draft.productCode || "", fabric: product?.name || draft.productName || "", color: product?.color || "",
        qty: qv, unit: draft.unit || product?.unit || "마", unitPrice: up, amount: Math.round(up * qv),
        ...(draft.productId ? { productId: draft.productId } : {}),
      }]),
    });
    setManualKey(k => k + 1);   // ManualOrderForm 리마운트 → initial 반영
  };

  const applyNotePrefill = (note, parsed, selectedCust, choice = null) => {
    // 품번이 맞은 품목은 빈 단가·금액을 품번 단가로 채운다(lib/productCodes.fillPriceFromProduct) — 로하톡에 금액을 안 적는 게 보통이다.
    const items = fillPriceFromProduct((parsed.items || []).map(it => {
      const qv = parseFloat(it.qty) || 0, av = parseInt(it.amount) || 0;
      return { itemNo: it.itemNo || "", fabric: it.fabric || "", color: it.color || "", qty: qv, unit: it.unit || "마", amount: av, unitPrice: (parseInt(it.unitPrice) || 0) || (qv > 0 ? Math.round(av / qv) : 0) };
    }), products);
    // URL 링크 — AI 파싱 결과 우선, 없으면 메모 본문에서 직접 추출
    const bodyLinks = (note.body || "").split(/\s+/).filter(t => /^https?:\/\//i.test(t) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(t));
    const links = (Array.isArray(parsed.links) && parsed.links.length) ? parsed.links : bodyLinks;
    // 적립금 사용 — 메모에 '적립' 언급 + 기존 고객 + 미완납일 때. 명시 금액 없으면 전액.
    // 잔액·주문총액 내로 캡해 등록 검증에 걸리지 않게 함.
    let creditUse = 0;
    if (selectedCust && (parsed.payment || "미입금") !== "입금완료" && /적립/.test(note.body || "")) {
      const bal = (credits || []).filter(c => c.customer === selectedCust.name).reduce((s, c) => s + (c.type === "적립" ? c.amount : -c.amount), 0);
      const orderTotal = items.reduce((s, it) => s + (it.amount || 0), 0) + (parsed.shippingFee || 0) + (parsed.otherCost || 0);
      const m = (note.body || "").match(/적립금?\s*([\d,]+)/);
      const want = m ? (parseInt(m[1].replace(/,/g, "")) || 0) : bal;
      creditUse = Math.max(0, Math.min(want, bal, orderTotal));
    }
    setManualPrefill({
      noteId: note.id,
      // 주문글에 적힌 총액. 폼의 합계(품목합+배송비)를 대신하지 않는다 — 경고에만 쓴다.
      // 품목 금액을 못 채운 주문은 하단 합계가 배송비만 남아 실제보다 훨씬 작게 보인다.
      // (예: "밀파+프라다린넨 / 37500+4000=51500원" → 품목 금액이 비어 합계가 4,000원)
      // 그 상태로 등록되면 장부가 조용히 틀어지므로, 글에 적힌 금액을 나란히 보여준다.
      noteTotal: parseInt(parsed.totalAmount) || 0,
      selectedCust,
      links,
      creditUse,
      wantFreeShipping: /무료\s*배송권/.test(note.body || ""), // 메모에 무료배송권 언급 시 등록 때 자동 차감 시도
      combinedShipping: !!parsed.combinedShipping || /합\s*배송|합배/.test(note.body || ""), // AI 감지("OOO님 합" 포함) 우선 + 키워드 보정
      combinedPayment: !!parsed.combinedPayment || /합\s*입금/.test(note.body || ""), // 합입금 감지 — AI 우선 + 키워드 보정
      name: selectedCust?.name || parsed.customer || "",
      nickname: selectedCust?.nickname || parsed.customerNickname || "",
      phone: choice?.phone === "note" ? (parsed.phone || "") : (selectedCust?.phone || parsed.phone || ""),
      // 확인창에서 고른 배송지가 있으면 그대로. 없으면 기존 규칙 —
      // 메모 주소가 배송지2와 일치하면 배송지2로 프리필(기본 주소가 메모 주소를 덮지 않게), 아니면 고객 카드 주소.
      ...(choice?.address === "note"  ? { address: parsed.address || "", addressDetail: parsed.address_detail || "" }
        : choice?.address === "card"  ? { address: selectedCust?.address || "", addressDetail: selectedCust?.addressDetail || "" }
        : choice?.address === "card2" ? { address: selectedCust?.address2 || "", addressDetail: selectedCust?.address2Detail || "" }
        : selectedCust?.address2 && parsed.address && addressMatches(parsed.address, selectedCust.address2)
          ? { address: selectedCust.address2, addressDetail: selectedCust.address2Detail || "" }
          : { address: selectedCust?.address || parsed.address || "", addressDetail: selectedCust?.addressDetail || parsed.address_detail || "" }),
      payment: parsed.payment || "미입금",
      shippingFee: parsed.shippingFee || 0,
      otherCost: parsed.otherCost || 0,
      note: parsed.note || "", // 일반 메모 — 원문 헤더/계산식 (AI note 규칙 + normalizeParsed 헤더 보정)
      // 담당자 메모는 프리필하지 않음 — 메모장 본문이 담당자 메모로 흘러들어가는 것 방지
      receiptType: parsed.receiptType || detectReceiptType(note.body) || null,
      items,
    });
    setManualKey(k => k + 1);   // ManualOrderForm 리마운트 → initial 반영
  };

  // 확인창에서 고른 대로 폼을 연다. 번호를 갱신하기로 했으면 고객 정보도 같이 고친다.
  const handleNoteConflictResolve = async (choice) => {
    const c = noteConflict;
    setNoteConflict(null);
    if (!c) return;
    let cust = c.cust;
    if (choice.phone === "note" && c.parsed.phone) {
      try {
        const updated = await db.updateCustomer(cust.id, { ...cust, phone: c.parsed.phone });
        if (updated) { setCustomers(p => p.map(x => x.id === cust.id ? updated : x)); cust = updated; }
        showToast?.(`${cust.name} 전화번호 업데이트 완료`);
      } catch (e) { showToast?.("번호 업데이트 실패: " + e.message, "error"); }
    }
    applyNotePrefill(c.note, c.parsed, cust, choice);
  };

  const handleMatchConfirm = (customer) => {
    setResolvedCustomer(customer);
    setCustMatch(null);
    showToast(`기존 고객 확인: ${customer.name}`);
  };

  const handleNewCustomer = async () => {
    setCustMatch(null);
    setResolvedCustomer(null); // 신규로 등록 (confirm 시 처리)
  };

  const handleUpdatePhone = async (customer) => {
    try {
      const updated = await db.updateCustomer(customer.id, { ...customer, phone: parsed.phone });
      if (updated) setCustomers(p => p.map(c => c.id === customer.id ? updated : c));
      setResolvedCustomer(updated || customer);
      setCustMatch(null);
      showToast("전화번호 업데이트 완료");
    } catch (e) {
      showToast("업데이트 실패: " + e.message, "error");
    }
  };

  // AI 분석 결과(parsed) 기반 등록 — 직접입력 폼과 공유하는 submitOrder 래퍼
  const confirm = () => submitOrder({ ...parsed, shipDate: aiShipDate, isUrgent: aiUrgent }, resolvedCustomer, {
    skipItemNoCheck: skipItemNo,
    imgs: images,
    mergeIds: pendingMergeIds,
    wantFreeShipping: /무료\s*배송권\s*사용/.test(txt),
  });

  // 주문 등록 핵심 로직 — AI 분석(parsed)·직접입력 폼 양쪽에서 호출.
  // data: parsed 형태 객체({customer, customerNickname, phone, items, address, ...})
  // resolvedCust: 매칭된 기존 고객(없으면 null → 신규 등록)
  const submitOrder = async (data, resolvedCust, opts = {}) => {
    const { skipItemNoCheck = true, imgs = [], mergeIds = [], wantFreeShipping = false, onSuccess, noteId = null, draftId = null } = opts;
    if (!data) return;
    // 아이템 No 미입력 체크
    if (!skipItemNoCheck) {
      const missing = (data.items||[]).filter(item=>!item.itemNo);
      if (missing.length > 0) {
        window.alert(`아이템 No가 입력되지 않은 항목이 ${missing.length}개 있습니다.\n\n${missing.map(m=>`• ${m.fabric} ${m.color||""} ${m.qty}${m.unit||"마"}`).join("\n")}\n\n아이템 No를 입력하거나, "아이템 No 없이 등록" 체크 후 등록하세요.`);
        return;
      }
    }
    // 품번 연결 — 골랐으면(productId) 그대로, 품번을 손으로 쳤으면 코드가 맞는 품번을 잇는다.
    // 원단명·색상만 적었어도 정확히 하나의 품번과 같으면 잇는다 — 안 이으면 포장대에서 롤을 찍어도
    // 이 품목을 못 찾아 "롤 없이 포장"으로 빠진다.
    const sq = (s) => String(s || "").trim().toLowerCase();
    const linkProduct = (item) => {
      if (item.productId) return item;
      let p = productByCode(products, item.itemNo);
      if (!p && sq(item.fabric)) {
        const same = (products || []).filter(x => sq(x.name) === sq(item.fabric) && (!sq(item.color) || sq(x.color) === sq(item.color)));
        if (same.length === 1) p = same[0];
      }
      // itemNo 는 등록 품번 그대로 저장한다 — 'S-2610-0010-R01' 처럼 롤 번호가 붙어 들어와도 'S-2610-0010' 으로.
      return p ? { ...item, productId: p.id, itemNo: p.code } : item;
    };
    data = { ...data, items: (data.items || []).map(linkProduct) };
    // 재고 확인 — 품번에 없는 품목을 알리고, 한 롤에서 다 안 나오는 품목은 줄을 나눌지 묻는다.
    // 막지는 않는다: 옛 재고·외주·급한 건이 있다.
    const unmatchedItems = [], splitRows = [];
    data.items.forEach((item, idx) => {
      const p = productById(products, item.productId);
      if (!p) { unmatchedItems.push(item); return; }
      const sum = rollSummary?.get?.(p.id);
      const qty = parseFloat(item.qty) || 0;
      const lengths = sum?.lengths || [];
      if (isRollUnit(item.unit)) {
        // 롤·필은 통째로 나간다 — 수량은 롤의 개수. 2롤 이상이면 줄마다 1롤이어야 롤을 하나씩 찍는다.
        const available = sum?.availableCount || 0;
        if (qty > 1 || qty > available) splitRows.push({ idx, item, lengths, rollUnit: true, available,
          parts: Number.isInteger(qty) && qty > 1 && qty <= available ? Array.from({ length: qty }, () => 1) : null });
      } else if (qty > (sum?.maxRemaining || 0)) {
        splitRows.push({ idx, item, lengths, rollUnit: false, available: sum?.availableCount || 0, parts: proposeSplit(qty, lengths) });
      }
    });
    if (unmatchedItems.length > 0) {
      const fmtItem = (m) => `${m.itemNo ? `[${m.itemNo}] ` : ""}${m.fabric} ${m.color||""} ${m.qty}${m.unit||"마"}`;
      if (!window.confirm(`품번에 없는 아이템이 ${unmatchedItems.length}개 있습니다:\n${unmatchedItems.map(m => "• " + fmtItem(m)).join("\n")}\n\n그래도 등록할까요?`)) return;
    }
    // 품번은 맞는데 적은 원단명이 그 품번의 원단과 다르다 — 숫자 하나 틀린 품번일 가능성. 막지는 않고 묻는다.
    const mismatched = data.items.map(item => ({ item, p: productById(products, item.productId) })).filter(({ item, p }) => p && codeNameMismatch(item, p));
    if (mismatched.length > 0) {
      const lines = mismatched.map(({ item, p }) => `• 적은 것: ${item.fabric} ${item.color||""} → 품번 ${p.code} 은(는) ${p.name}${p.color ? ` ${p.color}` : ""}`);
      if (!window.confirm(`품번과 원단명이 다른 품목이 ${mismatched.length}개 있습니다:\n${lines.join("\n")}\n\n품번이 맞으면 품번의 원단으로 등록됩니다. 그대로 등록할까요?`)) return;
    }
    if (splitRows.length > 0) {
      const answer = await new Promise(resolve => setSplitAsk({ rows: splitRows, resolve }));
      setSplitAsk(null);
      if (!answer) return;                       // 돌아가기
      if (answer.split) {
        data = { ...data, items: data.items.flatMap((item, idx) => answer.split[idx] ? splitItemLines(item, answer.split[idx]) : [item]) };
      }
    }
    const t = nowT();

    // customer 필드 순화: "이명화4767(샤크)" 같은 복합 문자열에서 괄호/숫자 제거.
    // resolvedCust(기존 고객 매칭됨)가 있으면 그 이름을 우선.
    const cleanName = (raw) => String(raw||"").replace(/\([^)]*\)/g,"").replace(/\d+/g,"").trim();
    const nameForNew = cleanName(data.customer) || data.customer || "";

    // ── 중복 고객 생성 방어선 ──────────────────────────────────────────────
    // AI/수기/메모 세 경로가 모두 이 함수를 지나므로 여기 한 곳에서만 막는다.
    // (메모 경로는 inputMode="manual"이라 CustomerMatchPopup이 렌더되지 않고,
    //  수기 입력은 자동완성으로 고객을 안 고르면 매칭 자체가 없어 그냥 신규 생성됐다.)
    //   · 이름+전화 완전 일치  → 확인 없이 기존 고객으로 흡수 (완전 중복의 주원인)
    //   · 이름만 같고 한쪽에 전화 없음 → 확인 1회 (동명이인 3중 등록 방지)
    //   · 이름 같고 전화가 둘 다 있는데 다름 → 확실히 다른 사람, 묻지 않고 신규
    // 방어선에서 흡수된 고객의 기본 배송지를 이번 주소로 덮어쓸지 여부.
    // true면 고객 마스터의 주소를 건드리지 않는다 (주문은 새 주소로 정상 발송).
    let keepBaseAddress = false;
    // 방어선이 보는 고객 목록. 화면 목록(customers)은 기기가 잠든 사이나 다른 직원이 몇 초 전에
    // 만든 고객이 빠져 있을 수 있어, 저장 직전에 서버에서 같은 번호·같은 이름을 한 번 더 받아
    // 합친다(2026-10-13: 이름·번호·주소까지 같은 중복이 전부 이 틈으로 생겼다). 조회가 실패하면
    // 들고 있던 목록으로 그대로 간다 — 등록이 막히면 안 된다.
    let custPool = customers || [];
    if (!resolvedCust) {
      try {
        const fresh = await db.findCustomersFresh({ phoneDigits: data.phone, name: nameForNew });
        if (fresh.length) {
          const have = new Set(custPool.map(c => c.id));
          const add = fresh.filter(c => !have.has(c.id));
          if (add.length) {
            custPool = [...custPool, ...add];
            setCustomers?.(p => { const h = new Set(p.map(c => c.id)); const a = add.filter(c => !h.has(c.id)); return a.length ? [...p, ...a] : p; });
          }
        }
      } catch (e) { console.warn("[주문입력] 고객 서버 조회 실패 — 화면 목록으로 판단", e); }
    }
    if (!resolvedCust) {
      const nName = normLoose(nameForNew);
      const nPhone = String(data.phone || "").replace(/\D/g, "");
      if (nName && nName !== "미확인") {
        const sameName = custPool.filter(c => normLoose(c.name) === nName);
        const exact = nPhone
          ? sameName.find(c => String(c.phone || "").replace(/\D/g, "") === nPhone)
          : null;
        if (exact) {
          resolvedCust = exact;
          // 배송지가 다르면 기본 배송지를 조용히 덮어쓰지 않고 한 번 묻는다.
          // 이사한 경우와 이번만 다른 곳(선물·직장)으로 보내는 경우를 시스템은 구분할 수 없다.
          // 기존 주소가 비어 있으면 채우는 것뿐이므로 묻지 않는다.
          const newAddr = String(data.address || "").trim();
          const differs = newAddr
            && String(exact.address || "").trim()
            && !addressMatches(newAddr, exact.address)
            && !addressMatches(newAddr, exact.address2);
          if (differs) {
            const who = `${exact.name}${exact.nickname ? ` (${exact.nickname})` : ""}\n${exact.phone || "연락처 없음"}`;
            const changeBase = window.confirm(
              `기존 고객으로 등록합니다.\n\n${who}\n\n` +
              `등록된 배송지:\n  ${exact.address}\n` +
              `이번 주문 배송지:\n  ${newAddr}\n\n` +
              `[확인] 기본 배송지를 이번 주소로 변경\n` +
              `[취소] 기존 배송지 유지 (이번 주문만 새 주소로 발송)`
            );
            keepBaseAddress = !changeBase;
          }
        } else {
          // 번호로 구분이 불가능한 후보만 확인 대상.
          const ambiguous = sameName.filter(c => !nPhone || !String(c.phone || "").replace(/\D/g, ""));
          if (ambiguous.length > 0) {
            // 후보가 여럿이면 가장 유력한 사람을 제시 — 닉네임 일치 우선, 그다음 주문 많은 순.
            const pNick = normLoose(data.customerNickname || "");
            const ranked = [...ambiguous].sort((a, b) => {
              const an = pNick && normLoose(a.nickname) === pNick ? 1 : 0;
              const bn = pNick && normLoose(b.nickname) === pNick ? 1 : 0;
              if (an !== bn) return bn - an;
              return (b.totalOrders || 0) - (a.totalOrders || 0);
            });
            const c = ranked[0];
            const label = `${c.name}${c.nickname ? ` (${c.nickname})` : ""}\n${c.phone ? c.phone : "연락처 없음"}${c.address ? `\n${c.address}` : ""}\n주문 ${c.totalOrders || 0}건`;
            const more = ranked.length > 1
              ? `\n\n※ 같은 이름의 고객이 ${ranked.length}명 있습니다:\n` +
                ranked.slice(1, 4).map(o => `  · ${o.name}${o.nickname ? ` (${o.nickname})` : ""} ${o.phone || "연락처 없음"}`).join("\n") +
                `\n다른 사람이면 [취소] 후 고객관리에서 확인해 주세요.`
              : "";
            const ok = window.confirm(
              `이미 등록된 고객일 수 있습니다.\n\n${label}\n\n` +
              `[확인] 이 고객의 주문으로 등록\n[취소] 다른 사람 — 새 고객으로 등록${more}`
            );
            // 이 경로는 이미 확인을 1회 받았으므로 주소를 또 묻지 않는다.
            // 대신 보수적으로 기본 배송지를 유지 — 이름만 보고 고른 고객의
            // 마스터 주소를 덮어쓰는 게 더 위험하다. (이사면 고객관리에서 수정)
            if (ok) { resolvedCust = c; keepBaseAddress = true; }
          }
        }
      }
    }

    // ── 같은 번호, 다른 이름 ──────────────────────────────────────────────
    // 위 방어선은 이름이 같은 고객 안에서만 찾는다. 그래서 이미 있는 고객의 번호로
    // 이름만 다르게 적으면(호칭·별명 — "고문님", "사장님") 아무것도 묻지 않고 새 고객이
    // 생겼다. 감시가 "전화 같고 이름 다름"으로 잡아내던 묶음이 이 길로 만들어졌다.
    //
    // 막지 않고 묻는다. 한 번호를 가족이나 같은 공방 사람이 함께 쓰는 경우가 실제로 있다.
    // 새 고객으로 등록하기로 했으면 그 사실을 이 주문의 등록 기록에 같이 적는다 —
    // 전체현황의 '최근 변경 기록'에서 고객명으로 찾으면 누가 그렇게 등록했는지 나온다.
    let custRoute = null;
    // 확인 후 기존 고객으로 등록할 때, 적어 넣은 이름을 닉네임으로 남길지
    let typedAsNick = "";
    if (!resolvedCust) {
      const nPhone = String(data.phone || "").replace(/\D/g, "");
      if (nPhone.length >= 9) {
        const nName = normLoose(nameForNew);
        const samePhone = custPool
          .filter(c => String(c.phone || "").replace(/\D/g, "") === nPhone && normLoose(c.name) !== nName)
          .sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0));
        if (samePhone.length > 0) {
          const c = samePhone[0];
          const label = `${c.name}${c.nickname ? ` (${c.nickname})` : ""} · 주문 ${c.totalOrders || 0}건${c.address ? `\n              ${c.address}` : ""}`;
          const more = samePhone.length > 1
            ? `\n\n※ 이 번호를 쓰는 고객이 ${samePhone.length}명 있습니다:\n` +
              samePhone.slice(1, 4).map(o => `  · ${o.name}${o.nickname ? ` (${o.nickname})` : ""}`).join("\n")
            : "";
          const ok = window.confirm(
            `같은 전화번호의 고객이 이미 있습니다.\n\n` +
            `입력한 이름:  ${nameForNew || "(없음)"}\n` +
            `등록된 고객:  ${label}\n\n` +
            `[확인] 같은 사람 — ${c.name} 님의 주문으로 등록\n` +
            `[취소] 다른 사람 — 새 고객으로 등록 (가족·같은 공방 등)${more}`
          );
          if (ok) {
            resolvedCust = c; keepBaseAddress = true;
            // 적어 넣은 이름이 호칭이었던 것이다. 닉네임이 비어 있으면 거기에 남겨 둔다 —
            // 다음에 같은 호칭으로 찾으면 자동완성에 이 고객이 나온다.
            if (!c.nickname && !data.customerNickname && nameForNew && nameForNew !== "미확인") typedAsNick = nameForNew;
          } else {
            custRoute = `주문입력 · 같은 번호 고객(${samePhone.slice(0, 3).map(o => o.name).join(", ")})이 있었지만 새 고객으로 등록`;
          }
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    const customerForOrder = resolvedCust?.name || nameForNew || "미확인";

    // 방문고객 = 매장 직접 판매 → 입금완료/출고완료 자동 처리.
    // shipOneOrder의 입금 검증 통과를 위해 INSERT 시점에 payment="입금완료" 강제.
    const isVisitor = activeManager === "방문고객";
    const orderPayment = isVisitor ? "입금완료" : (data.payment || "미입금");

    // ── 합배송 택배비 안내 — 묶일 주문들과 이 주문에 택배비가 겹치면 등록 전에 한 번 알린다 ──
    // 등록 뒤 자동으로 한 건만 남는다(lib/freight.js). 그걸 모르는 채 금액이 바뀌면 고객에게 틀린 금액을
    // 안내하게 된다. 취소하면 입력 화면으로 돌아가 택배비를 고칠 수 있다.
    if (!isVisitor) {
      const NEW_ID = "__new__";
      const fresh = { id: NEW_ID, createdAt: new Date().toISOString(), customer: customerForOrder, phone: data.phone, address: data.address,
        payment: orderPayment, shippingFee: parseInt(data.shippingFee) || 0, totalAmount: data.totalAmount || 0 };
      const picked = mergeIds.map(id => orders.find(o => o.id === id)).filter(Boolean);
      const base = picked.length ? picked : findMergeCandidates(fresh, orders).candidates;
      const gids = new Set(base.map(o => o.mergeGroupId).filter(Boolean));
      const group = orders.filter(o => o.status !== "출고완료" && !o.splitShipping && (base.includes(o) || (o.mergeGroupId && gids.has(o.mergeGroupId))));
      const pre = previewFreightOverlap(fresh, group);
      if (pre) {
        const won = (n) => `${Number(n || 0).toLocaleString()}원`;
        const label = (o) => o.id === NEW_ID ? "지금 등록하는 주문" : `${o.date || ""} 주문`.trim();
        const holderLines = pre.holders.map(o => `• ${label(o)} — 택배비 ${won(o.shippingFee)}`).join("\n");
        const after = pre.conflict
          ? "입금완료 주문 2건에 택배비가 각각 있어 자동으로 정리되지 않습니다. 등록 후 운임비 조정으로 직접 정해 주세요."
          : pre.changes.length
            ? "묶이면 먼저 등록된 한 건의 택배비만 남습니다:\n" + pre.changes.map(c => `• ${label(c.order)} — 택배비 ${won(c.from)} → 0원${c.totalTo !== undefined ? ` · 전체금액 ${won(c.totalFrom)} → ${won(c.totalTo)}` : ""}`).join("\n")
            : "입금이 끝난 주문이라 택배비가 그대로 남습니다. 등록 후 운임비 조정으로 직접 정해 주세요.";
        if (!window.confirm(`합배송 택배비 안내\n\n${customerForOrder} 님의 합배송 주문에 택배비가 ${pre.holders.length}건 있습니다:\n${holderLines}\n\n${after}\n\n이대로 등록할까요?\n(취소하면 입력 화면으로 돌아갑니다)`)) return;
      }
    }

    // ── 1) 주문 저장 ─────────────────────────────────────────────
    // 여기까지가 "등록됐다"의 기준이다. 이게 성공하면 주문은 DB 에 있다.
    let saved;
    try {
      saved = await db.insertOrder({...t, customer:customerForOrder, phone:data.phone, items:data.items||[], payment:orderPayment, address:data.address, addressDetail:data.address_detail, deliveryMessage:data.deliveryMessage||"", links:data.links||[], note:data.note, memo:(data.memo&&data.memo.trim())?data.memo.trim():null, status:"접수", manager:activeManager||"", totalAmount:data.totalAmount||0, shippingFee:data.shippingFee||0, courier:data.courier||null, otherCost:data.otherCost||0, combinedPayment:!!data.combinedPayment, combinedShipping:!!data.combinedShipping, salesChannel:data.salesChannel||"", receiptType:data.receiptType||null, shipDate:data.shipDate||defaultShipDate(), isUrgent:!!data.isUrgent}, custRoute ? { route: custRoute } : {});
    } catch(e) {
      console.error("주문 저장 실패:", e);
      showToast("저장 실패: " + e.message, "error");
      return;
    }

    // ── 2) 화면을 먼저 넘긴다 ────────────────────────────────────
    // 예전에는 적립금·배송권·고객정보·합배송을 전부 저장한 뒤에야 주문현황으로 넘어갔다.
    // 그 사이 사람은 "등록 중..." 만 보고 있었다. 로하톡에서 넘어온 주문은 메모 본문에서
    // 적립금·무료배송권·합배송을 자동으로 감지해 채워 넣기 때문에 그 분기가 다 켜지고,
    // 왕복이 열댓 번씩 줄줄이 붙어 3초를 넘겼다 — 주문현황에 늦게 뜨는 것처럼 보이던
    // 이유다. 주문은 이미 저장됐으니 화면은 지금 넘어가면 된다. 나머지는 아래에서 잇는다.
    setOrders(p=>[saved,...p]);

    // 배송지 메모 기록 — 다음 입력 때 자동완성 후보로 재사용
    recordDeliveryPreset(data.deliveryMessage);
    kakaoAlert(`📋 새 주문\n${saved.id} — ${saved.customer}\n${(data.items||[]).map(i=>`${i.fabric} ${i.color} ${i.qty}${i.unit||"마"}`).join(", ")}`);
    // 주문 메모에서 넘어온 등록이면 해당 메모를 '등록됨'으로 표시
    if (noteId) onNoteRegistered?.(noteId, saved);
    // 링크 주문 초안에서 넘어온 등록이면 해당 초안을 '전환됨'으로 표시
    if (draftId) onDraftConverted?.(draftId, saved);
    setParsed(null); setTxt(""); setSkipItemNo(true); setCustMatch(null); setResolvedCustomer(null); setImages([]); setPendingMergeIds([]);
    onSuccess?.();
    // 방문판매는 매장 연속 등록 워크플로우라 입력 탭 유지 + 출고까지 끝난 뒤에 알린다.
    // 일반 주문은 주문현황으로 바로 이동.
    if (!isVisitor) { setTab(1); showToast("주문 등록 완료"); }

    // ── 3) 뒷정리 ───────────────────────────────────────────────
    // 이미 등록된 주문에 붙는 부수 작업들. 실패해도 주문은 남아 있으므로 "저장 실패"가
    // 아니라 무엇이 안 됐는지를 알린다.
    //
    // 한 줄로 세워서 돌린다(tailQueueRef). 화면이 즉시 풀리니 주문을 연달아 넣을 수 있는데,
    // 같은 고객의 뒷정리가 겹치면 customers 의 totalOrders 를 둘 다 옛 값에서 +1 해
    // 한 건이 사라진다. 버튼 잠금이 대신 해주던 직렬화를 여기서 유지한다.
    const tail = async () => {
      let finalOrder = saved;
      // 뒷정리로 바뀐 값은 목록에 이미 올라간 그 카드에도 곧바로 반영한다.
      const patch = (fields) => {
        finalOrder = { ...finalOrder, ...fields };
        setOrders(p => p.map(o => o.id === saved.id ? { ...o, ...fields } : o));
      };

      // 첨부 이미지 업로드 후 order.images 업데이트
      if (imgs.length > 0) {
        setImageUploading(true);
        try {
          const urls = await uploadOrderImages(imgs, saved.id);
          await db.updateOrder(saved.id, { images: urls });
          patch({ images: urls });
        } catch (err) {
          console.error("이미지 업로드 실패:", err);
          showToast?.("이미지 업로드 실패 — 주문은 저장됨", "error");
        } finally {
          setImageUploading(false);
        }
      }

      // ── 무료배송권 자동 사용 ── ("무료배송권 사용" 명시 + 배송비>0 + 미완납 주문 + 고객 보유≥1)
      // 입금완료(방문고객 등) 주문은 배송권차감이 입금완료 플래그-폴백과 충돌하므로 제외.
      if (wantFreeShipping) {
        const fee = data.shippingFee || 0;
        if (orderPayment === "입금완료") {
          showToast?.("이미 완납 주문이라 무료배송권 자동 적용은 건너뜀", "error");
        } else if (fee <= 0) {
          showToast?.("배송비가 없어 무료배송권은 적용하지 않았습니다", "error");
        } else {
          try {
            const bal = await db.getCustomerFreeShipping(customerForOrder);
            if (bal >= 1) {
              await db.useFreeShipping(customerForOrder, saved.id, fee);
              patch({ freeShippingUsed: true });
              await reloadFreeShipping?.();
              showToast?.(`무료배송권 1장 자동 사용 (잔여 ${bal - 1}장)`);
            } else {
              showToast?.(`${customerForOrder}님 무료배송권 0장 — 자동 적용 안 됨`, "error");
            }
          } catch (fsErr) {
            console.error("무료배송권 자동 사용 실패:", fsErr);
            showToast?.("무료배송권 자동 적용 실패: " + fsErr.message, "error");
          }
        }
      }

      // ── 적립금 사용 ── (직접입력 폼에서 지정 — 정산관리 '적립금 차감'·주문현황 수정창과 같은 db.applyOrderCredit)
      // 입금완료(방문고객 포함) 주문은 이미 완납이라 차감할 미수금이 없으므로 제외.
      const creditUse = parseInt(data.creditUse)||0;
      if (creditUse > 0) {
        if (orderPayment === "입금완료") {
          showToast?.("이미 완납 주문이라 적립금은 적용하지 않았습니다", "error");
        } else {
          try {
            const orderTotal = (data.totalAmount>0 ? data.totalAmount
              : (data.items||[]).reduce((s,i)=>s+(i.amount||0),0)+(data.shippingFee||0)+(data.otherCost||0));
            // 잔액·미수금 한도는 함수 안에서 저장 직전에 다시 깎는다 — 다른 기기에서 잔액이 바뀌었을 수 있음
            const r = await db.applyOrderCredit({ customer: customerForOrder, orderId: saved.id, requested: creditUse, orderTotal, manager: activeManager, fallbackPayment: orderPayment });
            if (r.useAmt <= 0) {
              showToast?.(`${customerForOrder}님 적립금을 적용하지 않았습니다 — ${r.skipped}`, "error");
            } else {
              if (r.savedCredit) setCredits?.(p=>[r.savedCredit,...p]);
              if (r.computed.paymentStatus === "입금완료") patch({ payment: "입금완료" });
              // 적립금으로 완납되는 주문은 카드가 잠깐 '미입금'으로 보였다가 여기서 바뀐다 —
              // 주문은 이미 목록에 올라가 있고 _computed 는 이 계산이 끝나야 나오기 때문이다.
              patch({ _computed: r.computed });
              if (r.useAmt < creditUse) showToast?.(`잔액 변동으로 적립금 ${r.useAmt.toLocaleString()}원만 적용됨`, "error");
              else showToast?.(`적립금 ${r.useAmt.toLocaleString()}원 사용 (잔여 ${(r.bal-r.useAmt).toLocaleString()}원)${r.computed.paymentStatus==="입금완료"?" — 완납 처리됨":""}`);
            }
          } catch (cErr) {
            console.error("적립금 사용 실패:", cErr);
            showToast?.("주문은 등록됐지만 적립금 적용 실패: " + cErr.message, "error");
          }
        }
      }

      // 고객 등록/업데이트
      try {
        if (resolvedCust) {
          // 기존 고객 업데이트
          // 배송지2로 나간 주문은 기본 배송지를 덮어쓰지 않음 — 두 주소가 같아져 기본 주소가 유실되는 사고 방지
          const isSecondAddr = !!(resolvedCust.address2 && data.address && addressMatches(data.address, resolvedCust.address2));
          // 상세주소 오염 방지 — 주소가 기존과 다른 곳으로 갱신되면 옛 상세주소(다른 건물의 동/호)는 버린다.
          // 유지하면 "새 주소 + 옛 건물명" 조합이 고객 레코드에 남아 이후 주문마다 계속 따라붙는다. (안영미 '세린아고라' 사례)
          const sameAddr = !data.address || addressMatches(data.address, resolvedCust.address);
          const updated = await db.updateCustomer(resolvedCust.id, {
            ...resolvedCust,
            totalOrders: (resolvedCust.totalOrders||0)+1,
            lastOrder: t.date,
            phone: data.phone || resolvedCust.phone,
            // keepBaseAddress: 중복 방어선에서 흡수된 고객이고 사용자가 기존 배송지 유지를 택함
            address: (isSecondAddr || keepBaseAddress) ? resolvedCust.address : (data.address || resolvedCust.address),
            addressDetail: (isSecondAddr || keepBaseAddress) ? resolvedCust.addressDetail : (data.address_detail || (sameAddr ? resolvedCust.addressDetail : "")),
            nickname: data.customerNickname || resolvedCust.nickname || typedAsNick,
          });
          if (updated) setCustomers(p=>p.map(c=>c.id===resolvedCust.id?updated:c));
        } else if (data.customer) {
          // 신규 고객 등록 — 닉네임 폴백: customer 필드에서 괄호 안 추출
          let nick = data.customerNickname || "";
          if (!nick) {
            const m = (data.customer||"").match(/\(([^)]+)\)/);
            if (m) nick = m[1];
          }
          const newCust = await db.insertCustomer({
            name: nameForNew,
            phone: data.phone||"",
            address: data.address||"",
            addressDetail: data.address_detail||"",
            totalOrders: 1,
            lastOrder: t.date,
            note: "",
            nickname: nick,
          });
          if (newCust) setCustomers(p=>[...p, newCust]);
        }
      } catch (custErr) {
        console.error("고객 저장 실패:", custErr);
        showToast?.("주문은 등록됐지만 고객정보 저장 실패: " + custErr.message, "error");
      }

      // 합배송 묶기 적용 — 미리 선택된 pendingMergeIds 가 있으면 새 주문 + 그들에게 동일 mergeGroupId 부여
      let mergedCount = 0;
      if (mergeIds.length > 0 && finalOrder?.id) {
        try {
          const validIds = mergeIds.filter(id => orders.find(o => o.id === id));
          if (validIds.length > 0) {
            // 기존 그룹 ID가 있으면 재사용, 없으면 새 UUID
            const existingGroup = validIds
              .map(id => orders.find(o => o.id === id))
              .filter(o => o?.mergeGroupId)
              .map(o => o.mergeGroupId)[0];
            const groupId = existingGroup || (typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `mg_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
            const allIds = [finalOrder.id, ...validIds];
            await db.setMergeGroup(allIds, groupId);
            setOrders(p => p.map(o => allIds.includes(o.id) ? { ...o, mergeGroupId: groupId } : o));
            finalOrder = { ...finalOrder, mergeGroupId: groupId };
            mergedCount = allIds.length;
            // 묶인 뒤 출고일(가장 늦은 날)·택배비(한 건만)를 규칙대로 — 3단계
            try {
              // 고른 주문이 이미 묶음에 들어 있으면 그 묶음의 나머지 멤버도 같이 본다 — 택배비를 든 주문이 거기 있을 수 있다
              const members = orders.filter(o => validIds.includes(o.id) || (existingGroup && o.mergeGroupId === existingGroup && o.status !== "출고완료" && !o.splitShipping))
                .map(o => ({ ...o, mergeGroupId: groupId }));
              const res = await db.afterGroupChange([finalOrder, ...members], { route: "합배송 묶기 (주문 등록)" });
              if (res) {
                setOrders(p => patchOrdersWithGroupResult(p, res));
                finalOrder = patchOrdersWithGroupResult([finalOrder], res)[0];
                if (res.freight?.conflict) showToast?.("입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다", "error");
              }
            } catch (grpErr) {
              console.error("합배송 출고일·택배비 조정 실패:", grpErr);
              showToast?.("묶였지만 출고일·택배비 자동 조정 실패: " + grpErr.message, "error");
            }
            showToast?.(`🔗 합배송 ${mergedCount}건 묶음`);
          }
        } catch (mergeErr) {
          console.error("합배송 묶기 실패:", mergeErr);
          showToast?.("주문은 등록됐지만 합배송 묶기 실패: " + mergeErr.message, "error");
        }
      }

      // ── 같은 고객 자동 합배송 ────────────────────────────────
      // 수동으로 묶은 게 없을 때만. 이미 묶었으면 셀러 의사가 명시된 것이라 건드리지 않는다.
      if (mergedCount === 0) {
        try {
          const { candidates, needsAsk } = findMergeCandidates(finalOrder, orders);
          if (candidates.length > 0) {
            let target = groupShipTarget([finalOrder, ...candidates]);
            let doMerge = true;
            if (needsAsk) {
              // 예약 건이 끼었다 — 셀러가 정한다. 모달이 닫힐 때까지 여기서 대기.
              // 이 시점엔 이미 주문현황 탭으로 넘어가 있다. 확인창이 주문입력 탭 안에 그려지면
              // display:none 에 같이 묻혀 화면에 안 나오는데, 여기는 그 답을 기다리는 자리라
              // 그대로 멈춘다 — 그래서 AutoMergeAskModal 은 createPortal 로 body 에 붙인다.
              const answer = await new Promise(resolve => setMergeAsk({ newOrder: finalOrder, candidates, resolve }));
              setMergeAsk(null);
              doMerge = !!answer?.merge;
              if (doMerge && answer.target) target = { shipDate: answer.target.shipDate, isUrgent: answer.target.isUrgent };
            }
            if (doMerge) {
              const existingGroup = candidates.map(o => o.mergeGroupId).find(Boolean);
              const groupId = existingGroup || (typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : `mg_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
              const allIds = [finalOrder.id, ...candidates.map(o => o.id)];
              // 묶음 표시와 출고예정일을 한 번에 쓴다. 그룹은 같은 날 같은 박스로 나가므로
              // 출고예정일도 하나로 맞춘다.
              // 하나씩 돌면 묶인 건수만큼 왕복하고(3건이면 4번), 중간에 실패하면
              // "묶이긴 했는데 날짜는 제각각"인 반쪽 상태가 남는다.
              await db.updateOrdersBulk(allIds, {
                mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent,
              });
              setOrders(p => p.map(o => allIds.includes(o.id)
                ? { ...o, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent }
                : o));
              finalOrder = { ...finalOrder, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent };
              mergedCount = allIds.length;
              // 택배비는 한 건에만 — 3단계. 날짜는 위에서 썼다(셀러가 확인창에서 고른 값일 수 있어
              // afterGroupChange 로 다시 정하지 않는다).
              try {
                const members = [finalOrder, ...candidates.map(o => ({ ...o, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent }))];
                const freight = await db.applyGroupFreight(members, { route: "자동 합배송" });
                const res = { ids: allIds, dateChanged: false, freight };
                setOrders(p => patchOrdersWithGroupResult(p, res));
                finalOrder = patchOrdersWithGroupResult([finalOrder], res)[0];
                if (freight.conflict) showToast?.("입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다", "error");
              } catch (feeErr) {
                console.error("자동 합배송 택배비 조정 실패:", feeErr);
                showToast?.("묶였지만 택배비 자동 조정 실패: " + feeErr.message, "error");
              }
              const packed = candidates.filter(o => o.status === "포장완료").length;
              showToast?.(packed > 0
                ? `📦 자동 합배송 ${allIds.length}건 — 포장완료 ${packed}건 포함, 박스를 다시 열어 합쳐야 합니다`
                : `📦 같은 고객 주문 ${allIds.length}건 자동 합배송`,
                packed > 0 ? "error" : undefined);
            }
          }
        } catch (autoErr) {
          console.error("자동 합배송 실패:", autoErr);
          showToast?.("주문은 등록됐지만 자동 합배송 실패: " + autoErr.message, "error");
        }
      }

      // 방문고객 = 매장 직접 판매 → 즉시 출고 처리 (재고 차감 + 출고 로그 + status="출고완료").
      // shipOneOrder는 order 객체를 직접 받으므로 setOrders state 반영 시점과 무관하게 동작.
      if (isVisitor && shipOneOrder) {
        try {
          const r = await shipOneOrder(finalOrder, new Date().toISOString());
          if (!r?.ok) {
            showToast(`방문판매 자동출고 실패: ${r?.reason||"알 수 없는 오류"}`, "error");
          }
        } catch (e) {
          console.error("방문판매 자동출고 오류:", e);
          showToast(`방문판매 출고처리 오류: ${e.message}`, "error");
        }
      }
      if (isVisitor) showToast("방문판매 출고완료");
    };

    tailQueueRef.current = tailQueueRef.current
      .then(tail)
      .catch(err => {
        console.error("주문 뒷정리 실패:", err);
        showToast("주문은 등록됐지만 이후 처리에 실패했습니다: " + (err?.message || err), "error");
      });
  };

  const addManager = async () => {
    const name = newManager.trim();
    if (!name || managers.find(m => m.name === name)) return;
    try {
      const saved = await db.addManager({ name });
      if (saved) setManagers(p => [...p, saved]);
      setNewManager("");
      showToast("담당자 등록 완료");
    } catch(e) { console.error("담당자 등록 오류:", e); showToast(`등록 실패: ${e.message||e}`,"error"); }
  };

  return (
    <div>
      <div style={{marginBottom:16}}>
        <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:4}}>주문 접수</div>
        <div style={{fontSize:12,color:G.creamMuted}}>{inputMode==="memo" ? "주문을 메모에 적어 실시간 공유하고, 눌러서 바로 등록하세요" : inputMode==="manual" ? "필드를 직접 입력해 정확하게 접수하세요" : inputMode==="link" ? "고객에게 보낸 주문 링크와 고객이 넣은 주문이 여기에 모입니다" : "카카오톡 주문 메시지를 그대로 붙여넣으세요"}</div>
      </div>

      {/* ── 입력 방식 전환 ─────────────────── */}
      <div style={{display:"flex",gap:6,marginBottom:12,padding:4,background:G.surface,borderRadius:12,border:`1px solid ${G.border}`}}>
        {[
          {k:"memo",l:"📝 로하톡"},
          {k:"manual",l:"✍️ 직접 입력"},
          // 처리할 것(고객 확인된 new)이 있으면 수를 붙인다 — 탭 안에 들어가 안 보이게 됐으니 여기서 알린다
          {k:"link",l:`🔗 주문 링크${linkDrafts.filter(d => d.status === "new").length ? ` ${linkDrafts.filter(d => d.status === "new").length}` : ""}`},
          ...(SHOW_AI_PASTE ? [{k:"ai",l:"✦ AI 붙여넣기"}] : []),
        ].map(m=>{
          const active = inputMode===m.k;
          return (
            <button key={m.k} type="button" className="oi-mode-btn" onClick={()=>setInputMode(m.k)}
              style={{flex:1,padding:"10px",borderRadius:9,border:"none",background:active?`linear-gradient(135deg,${G.copper},${G.copperLight})`:"transparent",color:active?G.white:G.creamMuted,fontWeight:active?800:600,fontSize:13,cursor:"pointer",fontFamily:S,transition:"all 0.15s",boxShadow:active?`0 2px 12px ${G.copperGlow}`:"none"}}>
              {m.l}
            </button>
          );
        })}
      </div>

      {/* ── 담당자 선택 ─────────────────── */}
      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:700,color:G.cream}}>담당자 선택</div>
        </div>

        {/* 담당자 버튼 — 본인 + 공용(방문고객/마켓24) 한 줄 */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          {(() => {
            const ownPersonal = managers.find(m => m.name === activeManager && !m.isPublic);
            if (!ownPersonal) return null;
            return (
              <button key={ownPersonal.name}
                onClick={()=>setActiveManager("")}
                style={{padding:"7px 14px",borderRadius:20,border:`1.5px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:S,transition:"all 0.15s",display:"flex",alignItems:"center",gap:5}}>
                {ownPersonal.name}{ownPersonal.isAdmin?<span style={{fontSize:9,fontWeight:800,background:G.copper,color:G.white,padding:"1px 4px",borderRadius:3}}>관</span>:null}
                <span style={{fontSize:10,background:G.copper,color:G.white,borderRadius:"50%",width:14,height:14,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>✓</span>
              </button>
            );
          })()}
          {managers.filter(m=>m.isPublic).map(m=>(
            <button key={m.name}
              onClick={()=>setActiveManager(activeManager===m.name?"":m.name)}
              style={{padding:"7px 14px",borderRadius:20,border:`1.5px solid ${activeManager===m.name?G.blue:G.border}`,background:activeManager===m.name?G.blueBg:"transparent",color:activeManager===m.name?G.blue:G.creamMuted,fontSize:12,fontWeight:activeManager===m.name?800:500,cursor:"pointer",fontFamily:S,transition:"all 0.15s",display:"flex",alignItems:"center",gap:5}}>
              {m.name}
              {activeManager===m.name && <span style={{fontSize:10,background:G.blue,color:G.white,borderRadius:"50%",width:14,height:14,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>✓</span>}
            </button>
          ))}
        </div>

        {/* 선택된 담당자 표시 */}
        {activeManager && (
          <div style={{marginTop:8,padding:"6px 12px",background:G.copperGlow,borderRadius:8,fontSize:12,color:G.copper,fontWeight:700,display:"flex",alignItems:"center",gap:6}}>
            <span>✓</span> <span>{activeManager}</span> 담당으로 주문 등록됩니다
          </div>
        )}
      </Card>

      {/* ── 🔗 주문 링크 탭(2026-10-07, AI 붙여넣기 자리) — 링크 주문 초안(4단계). 고객 확인된 건은 전환(폼 채우기), 등록은 기존 경로 ──
          링크 만들기는 직접 입력 폼의 📨 주문 링크 버튼이다(고객·품목을 채워야 만들 수 있어서 거기 둔다). */}
      {inputMode === "link" && (
        <Card style={{marginBottom:12,border:`1px solid ${G.purple}60`}}>
          {/* 공개 링크 만들기 — 원단을 찾아 링크를 복사한다. 품번만 있으면 되고 서버에 뭘 만들지 않는다. */}
          <div style={{marginBottom:12,padding:"10px 12px",borderRadius:10,background:G.surface,border:`1px solid ${G.border}`}}>
            <div style={{fontSize:12,fontWeight:800,color:G.cream,marginBottom:6}}>📢 게시글용 공개 링크 — 원단을 찾아 복사</div>
            {linkManagerOk
              ? <div style={{fontSize:11,color:G.creamMuted,marginBottom:6}}>이 링크로 들어온 주문은 <b style={{color:G.copper}}>{activeManager}</b> 담당으로 잡힙니다</div>
              : <div style={{fontSize:11,color:G.red,fontWeight:700,marginBottom:6}}>아래 담당자 선택에서 본인을 먼저 고르세요 — 링크에 담당자가 실립니다</div>}
            <input value={linkQ} onChange={e=>setLinkQ(e.target.value)} placeholder="원단명 · 색상 · 품번 검색" style={{...baseInp,width:"100%",boxSizing:"border-box",fontSize:13}}/>
            {(() => {
              const q = linkQ.trim().toLowerCase();
              // 팔 수 있는 롤이 있는 품번만(2026-10-08 사용자 결정). 롤 재고 탭도 롤이 있는 품번만 보여주므로
              // 두 화면이 같은 목록이 된다 — 롤이 0개인 품번이 여기만 나오면 "재고 탭엔 없는데 왜 보이나"가 된다.
              const sellable = (products || []).map(p => ({ p, s: rollSummary?.get?.(p.id) || null })).filter(({ s }) => (s?.availableCount || 0) > 0);
              const list = sellable
                .filter(({ p }) => !q || [p.code, p.name, p.color].some(v => String(v || "").toLowerCase().includes(q)))
                // 최근 품번부터
                .sort((a, b) => String(b.p.code).localeCompare(String(a.p.code)))
                .slice(0, q ? 8 : 5);
              if (!(products || []).length) return <div style={{fontSize:11,color:G.creamMuted,marginTop:8}}>등록된 품번이 없습니다 — 입고에서 원단을 먼저 등록하세요</div>;
              if (!sellable.length) return <div style={{fontSize:11,color:G.creamMuted,marginTop:8}}>판매 가능한 롤이 있는 품번이 없습니다 — 입고에서 롤을 먼저 등록하세요 (롤이 없는 품번은 여기 안 나옵니다)</div>;
              if (!list.length) return <div style={{fontSize:11,color:G.creamMuted,marginTop:8}}>"{linkQ}" 에 맞는 원단이 없습니다 — 롤이 없는 품번은 여기 안 나옵니다</div>;
              return (
                <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
                  {list.map(({ p, s }) => {
                    const avail = s?.availableCount || 0;
                    const noPrice = !(Number(p.unitPrice) > 0);
                    const owner = linkOwnerOf(p);
                    const ownerOk = !!(owner && managers.find(x => x.name === owner)?.id);
                    const url = publicLinkUrl(p.code, owner);
                    const copied = linkCopied === p.code;
                    return (
                      <div key={p.id} style={{display:"flex",gap:8,alignItems:"center",padding:"8px 10px",borderRadius:8,background:G.card,border:`1px solid ${avail > 0 ? G.border : `${G.red}40`}`}}>
                        {p.photoUrl ? <img src={p.photoUrl} alt="" style={{width:36,height:36,borderRadius:6,objectFit:"cover",flexShrink:0}}/> : <div style={{width:36,height:36,borderRadius:6,background:G.surface,flexShrink:0}}/>}
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:800,color:G.cream,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                            <span style={{fontFamily:"monospace",color:G.copper,marginRight:6}}>{p.code}</span>{p.name}{p.color ? ` ${p.color}` : ""}
                          </div>
                          <div style={{fontSize:11,color:avail > 0 ? G.creamMuted : G.red}}>
                            {avail > 0 ? `판매 가능 ${avail}롤 · 최대 ${s.maxRemaining}마` : "판매 가능한 롤 없음 — 링크를 열면 품절로 보입니다"}
                            {noPrice ? <span style={{color:G.red}}> · 단가 없음(금액이 안 섭니다)</span> : <span> · {Number(p.unitPrice).toLocaleString()}원/{p.unit || "마"}</span>}
                            {owner ? <span> · 담당 {owner}{p.manager === owner ? "" : " (작업자)"}</span> : <span style={{color:G.red}}> · 담당자 없음</span>}
                          </div>
                        </div>
                        <button type="button" disabled={!ownerOk} onClick={async()=>{ if (!ownerOk) { showToast?.("담당자를 먼저 고르세요", "error"); return; } if (await copyText(url, `${p.code} 공개 링크를 복사했습니다 (${owner} 담당)`)) { setLinkCopied(p.code); setTimeout(()=>setLinkCopied(c=>c===p.code?"":c), 2000); } }}
                          style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${copied?G.green:ownerOk?G.purple:G.border}`,background:copied?G.greenBg:"transparent",color:copied?G.green:ownerOk?G.purple:G.creamMuted,fontSize:11,fontWeight:800,cursor:ownerOk?"pointer":"not-allowed",fontFamily:S,whiteSpace:"nowrap",flexShrink:0}}>
                          {copied ? "✓ 복사됨" : "🔗 링크 복사"}
                        </button>
                        {/* 로하톡에 붙여 넣을 "품번 원단명 색상" — 손으로 치다 틀리는 일을 막는다(2026-10-08) */}
                        <button type="button" onClick={async()=>{ await copyText(productLineText(p), `품번을 복사했습니다 — ${productLineText(p)}`); }} title="로하톡에 붙여 넣을 '품번 원단명 색상'을 복사합니다"
                          style={{padding:"7px 9px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap",flexShrink:0}}>품번 복사</button>
                        <button type="button" onClick={()=>window.open(url, "_blank")} title="고객이 보는 화면 미리보기"
                          style={{padding:"7px 9px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S,flexShrink:0}}>↗</button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{fontSize:12,fontWeight:800,color:G.purple}}>🔗 링크 주문 {linkDrafts.length}건</div>
            <button type="button" onClick={()=>setInputMode("manual")} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:S}}>📨 쪽지용 셀러 링크 → 직접 입력</button>
          </div>
          {linkDrafts.length === 0 ? (
            <div style={{marginTop:12,padding:"18px 12px",textAlign:"center",fontSize:12,color:G.creamMuted,lineHeight:1.8,background:G.surface,borderRadius:10}}>
              아직 링크 주문이 없습니다.<br/>
              위에서 원단을 찾아 <b style={{color:G.purple}}>🔗 링크 복사</b> → 밴드 게시글에 올리면 고객이 넣은 주문이 "게시글"로 여기 쌓이고,<br/>
              <b style={{color:G.cream}}>직접 입력</b>에서 고객과 품목을 채워 <b style={{color:G.copper}}>📨 주문 링크</b>를 만들어 쪽지로 보내면 고객 확인 뒤 "쪽지"로 올라옵니다.
            </div>
          ) : (
            <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8}}>
              {linkDrafts.map(d => {
                const fmtT = (iso) => { const w = iso ? new Date(iso) : null; return w ? `${w.getMonth()+1}/${w.getDate()} ${String(w.getHours()).padStart(2,"0")}:${String(w.getMinutes()).padStart(2,"0")}` : ""; };
                const t = fmtT(d.createdAt);
                const tail4 = String(d.phone||"").replace(/\D/g,"").slice(-4);
                const seller = d.source === "seller";
                const expMs = d.expiresAt ? Date.parse(d.expiresAt) - Date.now() : null;
                const waiting = d.status === "offered" && (expMs === null || expMs > 0);     // 고객 확인 대기
                const expired = d.status === "offered" && expMs !== null && expMs <= 0;      // 만료(DB 는 offer API 가 열릴 때 갱신)
                const left = expMs !== null && expMs > 0 ? (expMs >= 3600e3 ? `${Math.floor(expMs/3600e3)}시간 ${Math.floor((expMs%3600e3)/60e3)}분` : `${Math.max(1, Math.floor(expMs/60e3))}분`) : "";
                const lines = Array.isArray(d.items) && d.items.length ? d.items : null;
                const copyLink = async () => { const url = sellerLinkUrl(d.token); try { await navigator.clipboard.writeText(url); showToast?.("링크를 복사했습니다"); } catch { window.prompt("링크를 복사하세요", url); } };
                return (
                  <div key={d.id} style={{padding:"10px 12px",borderRadius:10,border:`1px solid ${waiting || expired ? G.border : d.status === "new" && seller ? G.green : G.border}`,background:G.surface,fontSize:12,lineHeight:1.6,opacity: expired ? 0.6 : 1}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                      <div>
                        <span style={{fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:4,marginRight:6,background:seller ? "rgba(138,106,184,0.15)" : G.copperGlow,color:seller ? G.purple : G.copper}}>{seller ? "쪽지" : "게시글"}</span>
                        <b style={{color:G.cream}}>{d.customerName}</b> <span style={{color:G.creamMuted}}>····{tail4}</span>{!d.customerId && <span style={{marginLeft:6,fontSize:10,fontWeight:800,color:G.copper}}>신규</span>}
                      </div>
                      <div style={{color:G.creamMuted,fontSize:11}}>{t}</div>
                    </div>
                    {lines ? lines.map((it, i) => (
                      <div key={i} style={{color:G.cream}}><span style={{fontFamily:"monospace"}}>{it.code}</span> {it.name}{it.color ? ` ${it.color}` : ""} · <b>{it.qty}{it.unit || "마"}</b>{it.amount ? <span style={{color:G.creamMuted}}> · {Number(it.amount).toLocaleString()}원</span> : null}</div>
                    )) : (
                      <div style={{color:G.cream}}><span style={{fontFamily:"monospace"}}>{d.productCode}</span> {d.productName} · <b>{d.qty}{d.unit || "마"}</b>{Array.isArray(d.rolls) && d.rolls.length ? <span style={{marginLeft:6,color:G.creamMuted,fontSize:11}}>({d.rolls.map(r => `${String(r.rollCode || "").replace(/^.*-R/, "R")} ${r.length}마`).join(" · ")})</span> : null}{d.depositorName && d.depositorName !== d.customerName ? <span style={{marginLeft:8,color:G.creamMuted}}>입금자 {d.depositorName}</span> : null}</div>
                    )}
                    <div style={{color:G.creamMuted}}>
                      {d.mergeWithOrderId ? `합배송 #${String(d.mergeWithOrderId).slice(0,8)}` : "단독"} · 택배비 {(d.shippingFee||0).toLocaleString()}원{d.useFreeShipping ? " (배송권)" : ""}{seller || d.unitPrice !== null ? ` · 합계 ${(d.totalAmount||0).toLocaleString()}원` : " · 단가 미정"}
                    </div>
                    {d.address ? <div style={{color:G.creamMuted,fontSize:11}}>📍 {d.address}{d.addressDetail ? ` ${d.addressDetail}` : ""}</div> : null}
                    {seller && d.status === "new" && <div style={{color:G.green,fontWeight:800,fontSize:11,marginTop:2}}>고객 확인 ✓ {fmtT(d.confirmedAt)}</div>}
                    {!seller && <div style={{color:d.createdBy?G.copper:G.red,fontWeight:700,fontSize:11,marginTop:2}}>{d.createdBy ? `담당 ${d.createdBy} (링크 복사한 사람)` : "담당자 없는 링크 — 전환하는 사람 담당으로 등록됩니다"}</div>}
                    {waiting && <div style={{color:G.creamMuted,fontWeight:700,fontSize:11,marginTop:2}}>고객 확인 대기 · 만료까지 {left}{d.createdBy ? ` · ${d.createdBy}` : ""}</div>}
                    {expired && <div style={{color:G.red,fontWeight:800,fontSize:11,marginTop:2}}>만료 — 고객이 확인하지 않았습니다. 링크를 다시 만들어 보내세요.</div>}
                    <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                      {d.status === "new" && <button onClick={()=>onConvertDraft?.(d)} style={{padding:"6px 12px",borderRadius:8,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:S}}>주문으로 전환</button>}
                      {waiting && d.token && <button onClick={copyLink} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.purple}`,background:"transparent",color:G.purple,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:S}}>링크 다시 복사</button>}
                      {d.status === "new" && <button onClick={()=>onRejectDraft?.(d)} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:S}}>거절</button>}
                      {/* 고객 확인 전(대기·만료) 링크는 삭제로 거둔다 — 확인된 초안은 사유가 남는 거절로 */}
                      {d.status === "offered" && onDeleteDraft && <button onClick={()=>onDeleteDraft(d)} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:S}}>삭제</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {inputMode === "memo" && (
        isMobile ? (
          /* 모바일 — 카톡처럼 화면 전체를 덮는 층으로 띄운다.
             예전엔 이 자리에 72dvh 상자로 넣었는데, 위에 헤더·탭바·입력방식·담당자 카드가
             먼저 쌓여 정작 채팅은 화면의 절반도 못 썼다. 층으로 띄우면 그게 전부 사라진다.
             ← 버튼은 직접입력 모드로 되돌려 층을 닫고, 메모의 '등록' 도 같은 경로
             (noteToRegister → setInputMode("manual"))라 등록 폼으로 자연스럽게 넘어간다.

             zIndex 950: 앱 바깥 셸의 상단 바(fixed·900)까지 덮어 화면을 다 쓴다.
             토스트(999)는 그대로 위에 뜬다. vh/dvh 를 쓰지 않는다 — .erp-root 의
             zoom(글씨 크기) 때문에 부풀어 넘친다(ErpApp 이미지 뷰어와 같은 사정).
             안쪽은 absolute inset:0 으로 높이를 확정해 OrderNotesTab 의 height:100% 가 잡히게 한다.
             top/height 는 키보드를 뺀 보이는 영역(vvBox) — 위 주석 참고. */
          <div style={{position:"fixed",left:0,right:0,top:`${vvBox.top}%`,height:`${vvBox.height}%`,zIndex:950,display:"flex",flexDirection:"column",background:G.bg}}>
            <div style={{flex:1,minHeight:0,position:"relative"}}>
              <div style={{position:"absolute",inset:0}}>
                <OrderNotesTab
                  onClose={()=>setInputMode("manual")}
                  notes={notes}
                  activeManager={activeManager}
                  customers={customers}
                  orders={orders}
                  isAdmin={!!managers.find(m => m.name === activeManager)?.isAdmin}
                  onSend={onSendNote}
                  onRegister={onRegisterNote}
                  onUpdateBody={onUpdateNoteBody}
                  onToggleReaction={onToggleNoteReaction}
                  onDelete={onDeleteNote}
                  onSearch={onSearchNotes}
                  showToast={showToast}
                />
              </div>
            </div>
          </div>
        ) : (
        <Card style={{marginBottom:14,textAlign:"center",padding:"28px 18px"}}>
          <div style={{fontSize:34,marginBottom:10}}>🗒️</div>
          <div style={{fontSize:13,color:G.creamMuted,marginBottom:16,lineHeight:1.6}}>로하톡은 새 창으로 열어<br/>ERP와 나란히 보며 작성·등록하세요</div>
          <button onClick={()=>setNotesPopupOpen(true)} style={{
            padding:"13px 28px",borderRadius:11,border:"none",fontFamily:S,fontWeight:800,fontSize:15,cursor:"pointer",
            background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:G.white,boxShadow:`0 4px 20px ${G.copperGlow}`,
          }}>🗗 로하톡 열기</button>
          {notesPopupOpen && <div style={{marginTop:14,fontSize:12,color:G.green,fontWeight:700}}>✓ 로하톡이 새 창에서 열려 있어요</div>}
        </Card>
        )
      )}

      {/* 메모장 새 창(팝업) — 어느 서브탭에 있든 계속 떠 있음 (PC 전용) */}
      {notesPopupOpen && !isMobile && (
        <DetachedWindow
          title="로하톡"
          onClose={()=>setNotesPopupOpen(false)}
          onBlocked={()=>showToast("팝업이 차단됐어요 — 브라우저에서 팝업을 허용한 뒤 다시 눌러주세요","error")}
        >
          <OrderNotesTab
            notes={notes}
            activeManager={activeManager}
            customers={customers}
            orders={orders}
            isAdmin={!!managers.find(m => m.name === activeManager)?.isAdmin}
            onSend={onSendNote}
            onRegister={onRegisterNote}
            onUpdateBody={onUpdateNoteBody}
            onToggleReaction={onToggleNoteReaction}
            onDelete={onDeleteNote}
            onSearch={onSearchNotes}
            showToast={showToast}
          />
        </DetachedWindow>
      )}

      {/* 자동 합배송 확인창 — AI/수기/메모 어느 경로에서 등록해도 떠야 하므로
          inputMode 블록 밖(최상위)에 둔다. (CustomerMatchPopup 이 ai 모드에서만
          렌더돼 메모 경로에서 안 뜨던 것과 같은 실수를 반복하지 않기 위함) */}
      <SellerLinkModal made={linkMade} onClose={()=>setLinkMade(null)} showToast={showToast} G={G} />
      {splitAsk && (
        <SplitAskModal ask={splitAsk} G={G}
          onResolve={(answer) => { const r = splitAsk.resolve; setSplitAsk(null); r?.(answer); }}/>
      )}
      {mergeAsk && (
        <AutoMergeAskModal ask={mergeAsk} G={G}
          onResolve={(answer) => { const r = mergeAsk.resolve; setMergeAsk(null); r?.(answer); }}/>
      )}

      {/* 주소·전화 충돌 확인창 — 로하톡 등록은 직접입력(manual) 모드로 진입하므로
          ai 블록 안에 두면 영영 안 뜬다. 프리필은 이 창의 답을 기다리며 멈추기 때문에,
          창이 안 뜨면 빈 폼만 남는다 (실제 사고: 김주희 주문 2026-08-27). */}
      {noteConflict && (
        <NoteConflictModal conflict={noteConflict} onResolve={handleNoteConflictResolve} G={G} />
      )}

      {inputMode === "manual" && (
        <>
          {notePrefilling && (
            <Card style={{marginBottom:12,display:"flex",alignItems:"center",gap:8,padding:"12px 16px",border:`1px solid ${G.copper}55`}}>
              <CuteLoader size="sm" /> <span style={{fontSize:13,color:G.copper,fontWeight:700}}>메모에서 불러오는 중… 잠시만 기다려 주세요</span>
            </Card>
          )}
          {/* 분석이 끝나면 폼을 리마운트해 내용을 채운다 — 그 사이에 친 글자는 리마운트로 지워진다.
              그래서 기다리는 동안에는 아예 못 쓰게 막는다. fieldset[disabled]는 안쪽 input·button·select를
              브라우저가 통째로 비활성화해줘서, 칸마다 disabled를 다는 것보다 빠뜨릴 여지가 없다. */}
          <fieldset disabled={notePrefilling}
            style={{border:0,margin:0,padding:0,minWidth:0,display:"block",opacity:notePrefilling?0.55:1,transition:"opacity 0.15s"}}>
          {manualNotice && manualNotice.map((n, i) => (
            <div key={i} style={{marginBottom:8,padding:"9px 12px",borderRadius:8,fontSize:12,fontWeight:700,lineHeight:1.5,
              border:`1px solid ${n.kind === "error" ? G.red : n.kind === "ok" ? G.green : G.border}`,
              background: n.kind === "error" ? G.redBg : n.kind === "ok" ? G.greenBg : G.surface,
              color: n.kind === "error" ? G.red : n.kind === "ok" ? G.green : G.cream}}>
              {n.text}
            </div>
          ))}
          <ManualOrderForm
            key={`manual-${manualKey}`}
            initial={manualPrefill}
            onCreateLink={createSellerLink}
            products={products}
            rollSummary={rollSummary}
            customers={customers}
            credits={credits}
            activeManager={activeManager}
            showToast={showToast}
            deliveryPresets={deliveryPresets}
            onDeletePreset={deleteDeliveryPreset}
            G={G}
            onSubmit={(data, resolvedCust, opts)=>submitOrder(data, resolvedCust, {...opts, onSuccess:()=>{setManualKey(k=>k+1); setManualPrefill(null); setManualNotice(null);}})}
          />
          </fieldset>
        </>
      )}

      {inputMode === "ai" && (<>
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
            {parsing ? <CuteLoader text="AI가 읽는 중..." size="sm" color="#fff" /> : "✦  AI 주문 분석"}
          </button>
          <button onClick={()=>{setTxt("");setParsed(null);setErr("");}} style={{
            padding:"14px 16px", borderRadius:10, border:`1.5px solid ${G.border}`,
            background:"transparent", color:G.creamMuted, fontFamily:S, fontSize:13, cursor:"pointer",
          }}>초기화</button>
        </div>
        {err && <div style={{color:G.red,fontSize:12,marginTop:10,padding:"8px 12px",background:G.redBg,borderRadius:8}}>{err}</div>}
      </Card>

      {custMatch && custMatch.type !== "confirmed" && (
        <CustomerMatchPopup
          type={custMatch.type}
          matchedCustomer={custMatch.match}
          matchedList={custMatch.list}
          parsed={parsed}
          onConfirm={handleMatchConfirm}
          onNewCustomer={handleNewCustomer}
          onCancel={()=>setCustMatch(null)}
          onUpdatePhone={handleUpdatePhone}
          G={G}
        />
      )}

      {parsed && (
        <Card style={{marginBottom:14,border:`1.5px solid ${G.copper}60`,position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",top:0,right:0,width:120,height:120,background:`radial-gradient(circle at 100% 0%,${G.copperGlow},transparent 70%)`}}/>
          <div style={{fontFamily:SF,fontSize:17,fontWeight:800,marginBottom:14,color:G.copper}}>✓ 분석 완료</div>

          {/* 합계 검증 알림 */}
          {parsed._validation?.status === "auto-corrected" && (
            <div style={{
              marginBottom:12, padding:"10px 14px", borderRadius:8,
              background:G.yellowBg, borderLeft:`4px solid ${G.yellow}`,
            }}>
              <div style={{fontSize:13,fontWeight:800,color:G.yellow,marginBottom:4}}>⚠️ 자동 보정됨</div>
              <div style={{fontSize:12,color:G.cream,marginBottom:4}}>{parsed._validation.message}</div>
              <div style={{fontSize:11,color:G.creamMuted,lineHeight:1.5}}>
                AI 계산 <b style={{color:G.cream}}>{parsed._validation.before.toLocaleString()}원</b>
                {" → 보정 후 "}
                <b style={{color:G.cream}}>{parsed._validation.after.toLocaleString()}원</b>
                {" (입력한 총액 "}
                <b style={{color:G.copper}}>{parsed._validation.expected.toLocaleString()}원</b>
                {"과 일치)"}
              </div>
            </div>
          )}
          {parsed._validation?.status === "mismatch" && (
            <div style={{
              marginBottom:12, padding:"10px 14px", borderRadius:8,
              background:G.redBg, borderLeft:`4px solid ${G.red}`,
            }}>
              <div style={{fontSize:13,fontWeight:800,color:G.red,marginBottom:4}}>🚨 합계 불일치</div>
              <div style={{fontSize:12,color:G.cream,marginBottom:4}}>{parsed._validation.message}</div>
              <div style={{fontSize:11,color:G.creamMuted,lineHeight:1.5}}>
                계산값 <b style={{color:G.cream}}>{parsed._validation.calculated.toLocaleString()}원</b>
                {" / 입력값 "}
                <b style={{color:G.cream}}>{parsed._validation.expected.toLocaleString()}원</b>
                {" (차이 "}
                <b style={{color:G.red}}>{parsed._validation.diff.toLocaleString()}원</b>
                {")"}
              </div>
              <div style={{fontSize:11,color:G.creamMuted,marginTop:4,fontStyle:"italic"}}>상품가/배송비/총액을 확인해주세요</div>
            </div>
          )}

          {/* 고객 매칭 상태 표시 */}
          {resolvedCustomer && (
            <div style={{padding:"10px 14px",background:G.greenBg,borderRadius:10,border:`1px solid ${G.green}40`,marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{color:G.green,fontSize:14}}>✓</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:G.green}}>기존 고객 확인됨</div>
                  <div style={{fontSize:11,color:G.creamMuted}}>{resolvedCustomer.name} · {resolvedCustomer.phone||"연락처 없음"}{resolvedCustomer.nickname?` · ${resolvedCustomer.nickname}`:""}</div>
                </div>
                <button onClick={()=>{setResolvedCustomer(null);setCustMatch({type:"new",match:null,list:[],parsed});}} style={{marginLeft:"auto",fontSize:11,color:G.red,background:"none",border:`1px solid ${G.red}40`,borderRadius:6,padding:"3px 8px",cursor:"pointer",fontFamily:S}}>변경</button>
              </div>
              {/* 배송지 2곳 보유 고객 — 어느 주소로 보낼지 선택 (선택하면 아래 배송지에 반영되어 주문에 들어감) */}
              {resolvedCustomer.address2 && (()=>{
                const opts=[
                  {k:"1",l:"🏠 기본 배송지",a:resolvedCustomer.address||"",d:resolvedCustomer.addressDetail||""},
                  {k:"2",l:`📍 배송지 2${resolvedCustomer.address2Label?` (${resolvedCustomer.address2Label})`:""}`,a:resolvedCustomer.address2||"",d:resolvedCustomer.address2Detail||""},
                ];
                // 현재 파싱된 주소가 어느 쪽인지 하이라이트 — 배송지2 우선 판정(더 구체적)
                const activeK = parsed.address
                  ? (addressMatches(parsed.address, resolvedCustomer.address2) ? "2"
                    : addressMatches(parsed.address, resolvedCustomer.address) ? "1" : null)
                  : null;
                return (
                  <div style={{marginTop:9,paddingTop:9,borderTop:`1px solid ${G.green}30`}}>
                    <div style={{fontSize:11,fontWeight:700,color:G.cream,marginBottom:6}}>📦 배송지가 2곳입니다 — 어느 주소로 보낼까요?</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {opts.map(opt=>{
                        const active = activeK===opt.k;
                        return (
                          <button key={opt.k} type="button" onClick={()=>setParsed(p=>({...p,address:opt.a,address_detail:opt.d}))}
                            style={{padding:"5px 11px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?G.green:G.border}`,background:active?`${G.green}1A`:G.card,color:active?G.green:G.creamMuted,fontWeight:active?800:600,cursor:"pointer",fontFamily:S}}>
                            {active?"✓ ":""}{opt.l}
                          </button>
                        );
                      })}
                    </div>
                    {!activeK && <div style={{fontSize:10,color:G.yellow,fontWeight:600,marginTop:5}}>{parsed.address?"⚠ 메모의 주소가 등록된 두 배송지와 달라요 — 그대로 두면 메모 주소로 등록됩니다":"주소 미선택 — 버튼을 눌러 배송지를 지정하세요"}</div>}
                  </div>
                );
              })()}
            </div>
          )}
          {!resolvedCustomer && parsed.customer && (
            <div style={{padding:"10px 14px",background:G.blueBg,borderRadius:10,border:`1px solid ${G.blue}40`,marginBottom:12,fontSize:12,color:G.blue,fontWeight:600}}>
              신규 고객으로 등록됩니다
            </div>
          )}
          <div style={{background:G.surface,borderRadius:10,overflow:"hidden",border:`1px solid ${G.border}`,marginBottom:14}}>
            {[
              {l:"고객명", v:<span style={{fontWeight:800,fontSize:15}}>{parsed.customer||"—"}</span>},
              ...(parsed.phone?[{l:"연락처",v:<span style={{color:G.creamMuted}}>{parsed.phone}</span>}]:[]),
              {l:"결제", v:(()=>{const cur=parsed.payment||"미입금";const next=cur==="입금완료"?"미입금":"입금완료";return <span onClick={()=>setParsed(p=>({...p,payment:next}))} title={`클릭해서 ${next}(으)로 변경`} style={{cursor:"pointer"}}><Tag c={pC(cur,G)[0]} bg={pC(cur,G)[1]}>{cur}</Tag></span>;})()},
              ...(parsed.address?[{l:"배송지",v:<span style={{fontSize:12,color:G.creamMuted}}>{parsed.address}{parsed.address_detail ? ` ${parsed.address_detail}` : ""}</span>}]:[]),
              ...((parsed.links||[]).map((lnk,i)=>({l:i===0?"링크":"",v:<a key={i} href={lnk} target="_blank" rel="noopener noreferrer" style={{fontSize:12,color:G.blue,textDecoration:"underline"}}>{lnk.length>40?lnk.slice(0,40)+"...":lnk}</a>}))),
              ...(parsed.shippingFee?[{l:"배송비",v:<span style={{fontFamily:SF,fontWeight:700,fontSize:13,color:G.blue}}>{parsed.shippingFee.toLocaleString()}<span style={{fontSize:11,fontWeight:400,color:G.creamMuted,marginLeft:2}}>원</span></span>}]:[]),
              ...(parsed.totalAmount?[{l:"총금액",v:<span style={{fontFamily:SF,fontWeight:800,fontSize:15,color:G.copper}}>{parsed.totalAmount.toLocaleString()}<span style={{fontSize:11,fontWeight:400,color:G.creamMuted,marginLeft:2}}>원</span></span>}]:[]),
              ...(parsed.salesChannel?[{l:"판매처",v:<span style={{fontSize:12,fontWeight:700,color:G.purple}}>{parsed.salesChannel}</span>}]:[]),
              ...(parsed.combinedPayment?[{l:"합입금",v:<span style={{fontSize:12,fontWeight:700,color:G.blue}}>🔗 합입금</span>}]:[]),
              ...(parsed.combinedShipping?[{l:"합배송",v:(
                <button onClick={()=>setMergePickerOpen(true)} style={{
                  padding:"4px 10px", fontSize:11, fontWeight:700, borderRadius:14,
                  border:`1px solid ${pendingMergeIds.length>0?G.purple:G.copper}`,
                  background: pendingMergeIds.length>0 ? "rgba(138,106,184,0.12)" : G.copperGlow,
                  color: pendingMergeIds.length>0 ? G.purple : G.copper,
                  cursor:"pointer", fontFamily:S, display:"inline-flex", alignItems:"center", gap:4,
                }}>
                  {pendingMergeIds.length>0 ? `🔗 합배송 ${pendingMergeIds.length}건 묶음 예정` : "📦 합배송 묶기"}
                </button>
              )}]:[]),
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
              <div key={i} style={{padding:"11px 14px",background:G.surface,borderRadius:9,border:`1px solid ${G.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    {item.itemNo && <span style={{fontSize:11,color:G.copper,fontWeight:700,marginRight:6,fontFamily:"monospace"}}>{item.itemNo}</span>}
                    <span style={{fontWeight:700,fontSize:14}}>{item.fabric}</span>
                    {item.color && <span style={{color:G.creamMuted,fontSize:12,marginLeft:6}}>{item.color}</span>}
                    {item._autoCorrected && (
                      <span title="자동 보정됨 — 단가/합계 해석을 수정함" style={{
                        marginLeft:6, fontSize:10, fontWeight:800, color:G.yellow,
                        background:G.yellowBg, padding:"1px 6px", borderRadius:4,
                        border:`1px solid ${G.yellow}40`,
                      }}>✏️ 보정</span>
                    )}
                  </div>
                  <div style={{textAlign:"right",display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                    <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                      <span style={{fontFamily:SF,fontSize:20,fontWeight:800,color:G.copper}}>{item.qty}</span>
                      <select value={item.unit||"마"} onChange={e=>setParsed(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,unit:e.target.value}:x)}))}
                        style={{fontSize:11,padding:"2px 4px",borderRadius:6,border:`1px solid ${G.border}`,background:G.surface,color:G.creamMuted,fontFamily:S,cursor:"pointer"}}>
                        <option>마</option>
                        <option>세트</option>
                        <option>필</option>
                        <option>롤</option>
                        <option>kg</option>
                      </select>
                    </div>
                    {item.amount>0 && <div style={{fontSize:11,color:G.copper,fontWeight:700,marginTop:2}}>{item.amount.toLocaleString()}원</div>}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,marginTop:8}}>
                  {(()=>{
                    const noKey = (item.itemNo||"").trim().toLowerCase();
                    const matched = productOfItem(products, item);
                    const matchedMax = matched ? (rollSummary?.get?.(matched.id)?.maxRemaining || 0) : 0;
                    const hasInput = !!noKey;
                    const borderColor = !hasInput && !skipItemNo ? G.red : hasInput && matched ? G.green : hasInput && !matched ? G.red : G.border;
                    const suggestions = hasInput && !matched ? suggestProducts(products, noKey, 5) : [];
                    const pickAi = (p) => setParsed(pp=>({...pp,items:pp.items.map((x,j)=>j===i?{...x,...pickProductPatch(p, x)}:x)}));
                    return (
                      <div style={{flex:1,position:"relative"}}>
                        {/* 품번을 고치면 골랐던 연결(productId)을 푼다 */}
                        <input value={item.itemNo||""} onChange={e=>{const v=e.target.value;setParsed(p=>({...p,items:p.items.map((x,j)=>j===i?{...x,itemNo:v,productId:null}:x)}));}}
                          placeholder="품번 (예: LH-2609-0001) · 원단명으로도 찾기" style={{...baseInp,width:"100%",fontSize:11,padding:"6px 10px",fontFamily:"monospace",borderColor}}/>
                        {matched && <div style={{fontSize:10,color:G.green,marginTop:3,fontWeight:600}}>✓ {matched.name}{matched.color?` ${matched.color}`:""} · {matchedMax > 0 ? `최대 재단 ${fmtLen(matchedMax)}${matched.unit || "마"}` : <span style={{color:G.red,fontWeight:800}}>재고 없음</span>}</div>}
                        {hasInput && !matched && suggestions.length===0 && <div style={{fontSize:10,color:G.red,marginTop:3,fontWeight:600}}>품번에 없는 번호입니다</div>}
                        {suggestions.length>0 && (
                          <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",overflow:"hidden"}}>
                            {suggestions.map(p=>(
                              <div key={p.id} onClick={()=>pickAi(p)}
                                style={{padding:"8px 10px",cursor:"pointer",borderBottom:`1px solid ${G.border}`,fontSize:11,display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,fontFamily:S}}
                                onMouseEnter={e=>e.currentTarget.style.background=G.surface}
                                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                                <div>
                                  <span style={{fontFamily:"monospace",fontWeight:700,color:G.copper,marginRight:6}}>{p.code}</span>
                                  <span style={{color:G.cream}}>{p.name}{p.color?` ${p.color}`:""}</span>
                                </div>
                                {stockHint(rollSummary, p, G)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  <input value={item.amount||""} onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setParsed(p=>{const items=p.items.map((x,j)=>j===i?{...x,amount:v}:x);return{...p,items,totalAmount:items.reduce((s,x)=>s+(x.amount||0),0)+(p.shippingFee||0)};});}}
                    placeholder="금액 (원)" type="text" inputMode="numeric" style={{...baseInp,width:90,fontSize:11,padding:"6px 10px",borderColor:G.border}}/>
                </div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,padding:"8px 12px",background:G.surface,borderRadius:8,border:`1px solid ${G.border}`}}>
            <span style={{fontSize:12,color:G.creamMuted,fontWeight:600,whiteSpace:"nowrap"}}>배송비</span>
            <input value={parsed.shippingFee||""} onChange={e=>{const v=parseInt(e.target.value.replace(/[^0-9]/g,""))||0;setParsed(p=>{const itemsTotal=(p.items||[]).reduce((s,x)=>s+(x.amount||0),0);return{...p,shippingFee:v,totalAmount:itemsTotal+v};});}}
              placeholder="0" type="text" inputMode="numeric" style={{...baseInp,flex:1,fontSize:12,padding:"6px 10px",borderColor:G.border}}/>
            <span style={{fontSize:11,color:G.creamMuted}}>원</span>
          </div>
          <div style={{marginTop:-4,marginBottom:12}}>
            <CourierField memo={`${parsed.note||""}\n${parsed.memo||""}`} value={parsed.courier||null} onChange={v=>setParsed(p=>({...p,courier:v}))}/>
          </div>
          <label style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,cursor:"pointer",padding:"8px 12px",background:skipItemNo?G.copperGlow:"transparent",borderRadius:8,border:`1px solid ${skipItemNo?G.copper:G.border}`,transition:"all 0.15s"}}>
            <input type="checkbox" checked={skipItemNo} onChange={e=>setSkipItemNo(e.target.checked)} style={{accentColor:G.copper,width:16,height:16}}/>
            <span style={{fontSize:12,color:skipItemNo?G.copper:G.creamMuted,fontWeight:skipItemNo?700:400}}>아이템 No 없이 등록</span>
          </label>

          {/* 배송지 메모 — 송장 출력 시 CJ 배송메세지1 / 경동 메모로 들어감 */}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:6}}>📦 배송지 메모</div>
            <DeliveryMessageInput
              value={parsed.deliveryMessage || ""}
              onChange={v => setParsed(p => ({...p, deliveryMessage: v}))}
              presets={deliveryPresets}
              onDeletePreset={deleteDeliveryPreset}
              G={G}
            />
            <div style={{fontSize:10,color:G.creamMuted,marginTop:3}}>송장 출력 시 CJ는 <b style={{color:G.creamMuted}}>배송메세지1</b>, 경동은 <b style={{color:G.creamMuted}}>메모</b>에 들어갑니다 · 입력한 메모는 기록되어 다음에 검색됩니다</div>
          </div>

          {/* 담당자 메모 (공유) — 등록 전 미리 적어둘 수 있음 */}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:6}}>📝 담당자 메모 (공유)</div>
            <textarea
              value={parsed.memo || ""}
              onChange={e => setParsed(p => ({...p, memo: e.target.value}))}
              placeholder="예: 고객 부재 시 경비실 맡김, 색상 다시 확인 등"
              rows={2}
              style={{...baseInp, width:"100%", boxSizing:"border-box", fontSize:12, padding:"8px 10px", resize:"vertical", minHeight:52, fontFamily:"inherit", lineHeight:1.45}}
            />
            <div style={{fontSize:10,color:G.creamMuted,marginTop:3}}>담당자들이 함께 볼 수 있는 메모입니다 (등록 후에도 수정 가능)</div>
          </div>

          {/* 영수증 종류 */}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:6}}>🧾 영수증</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {[
                {v:null,         l:"발행 안 함",   c:G.creamMuted, bg:"transparent"},
                {v:"cash",       l:"🧾 현금영수증", c:G.red,        bg:G.redBg},
                {v:"business",   l:"📋 지출증빙",   c:G.blue,       bg:G.blueBg},
                {v:"tax_invoice",l:"📄 계산서",     c:G.green,      bg:G.greenBg},
              ].map(opt => {
                const active = (parsed.receiptType||null) === opt.v;
                return (
                  <button key={String(opt.v)} type="button"
                    onClick={()=>setParsed(p=>({...p,receiptType:opt.v}))}
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

          {/* 이미지 첨부 */}
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.06em",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>📷 이미지 첨부 (선택, 최대 {MAX_IMAGES}장)</span>
              <span style={{fontSize:10,color:G.creamMuted,fontWeight:500}}>{images.length}/{MAX_IMAGES}</span>
            </div>
            <div
              onDragOver={e=>{e.preventDefault();e.stopPropagation();}}
              onDrop={e=>{e.preventDefault();e.stopPropagation();addImages(e.dataTransfer?.files||[]);}}
              onClick={()=>fileRef.current?.click()}
              style={{border:`1.5px dashed ${G.border}`,borderRadius:10,padding:"14px 12px",textAlign:"center",cursor:"pointer",background:G.surface,fontSize:11,color:G.creamMuted,marginBottom:8}}>
              파일 선택 · 드래그 · Ctrl+V 붙여넣기
            </div>
            <input ref={fileRef} type="file" multiple accept="image/*" onChange={e=>{addImages(e.target.files);e.target.value="";}} style={{display:"none"}}/>
            {images.length>0 && (
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(70px,1fr))",gap:6}}>
                {images.map((f,i)=>{
                  const url = URL.createObjectURL(f);
                  return (
                    <div key={i} style={{position:"relative",aspectRatio:"1/1",borderRadius:8,overflow:"hidden",border:`1px solid ${G.border}`}}>
                      <img src={url} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}} onLoad={()=>URL.revokeObjectURL(url)}/>
                      <button onClick={(e)=>{e.stopPropagation();setImages(prev=>prev.filter((_,j)=>j!==i));}} style={{position:"absolute",top:2,right:2,width:20,height:20,borderRadius:"50%",border:"none",background:"rgba(0,0,0,0.6)",color:"#fff",fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <ShipDateField shipDate={aiShipDate} isUrgent={aiUrgent} G={G}
            onChange={v => { setAiShipDate(v.shipDate); setAiUrgent(v.isUrgent); }}/>

          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={()=>confirm()} disabled={imageUploading} style={{
              flex:1, padding:"14px", borderRadius:10, border:"none",
              background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
              color:G.white, fontWeight:800, fontSize:15, cursor:imageUploading?"not-allowed":"pointer", fontFamily:S,
              boxShadow:`0 4px 24px ${G.copperGlow}`, opacity:imageUploading?0.6:1,
            }}>
              {imageUploading ? <CuteLoader text="이미지 올리는 중..." size="sm" color="#fff" /> : (pendingMergeIds.length>0 ? `◈ 주문등록 (🔗 ${pendingMergeIds.length}건과 묶기)` : "◈  주문등록")}
            </button>
            <button onClick={()=>{setParsed(null);setImages([]);setPendingMergeIds([]);}} style={{
              padding:"14px 16px", borderRadius:10, border:`1.5px solid ${G.border}`,
              background:"transparent", color:G.creamMuted, fontFamily:S, cursor:"pointer",
            }}>✕</button>
          </div>
        </Card>
      )}

      <div style={{padding:"12px 14px",background:G.copperGlow,borderRadius:10,border:`1px solid ${G.copper}`,display:"flex",gap:10,alignItems:"flex-start"}}>
        <span style={{color:G.copper,fontSize:16}}>✦</span>
        <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.9,flex:1,minWidth:0}}>
          카카오톡 주문 채팅을 <b style={{color:G.cream}}>복사 → 붙여넣기</b> 하면<br/>
          고객명 · 원단 · 수량 · 결제 · 배송지를 자동 추출합니다
          <details style={{marginTop:8}}>
            <summary style={{cursor:"pointer",color:G.copper,fontWeight:700,fontSize:11,letterSpacing:"0.04em",listStyle:"none",userSelect:"none"}}>📋 작성 규칙 자세히 보기</summary>
            <div style={{marginTop:10,fontSize:11.5,lineHeight:1.75,color:G.creamMuted}}>
              <div style={{marginBottom:10}}>
                <div style={{color:G.cream,fontWeight:700,marginBottom:3}}>1️⃣ 주소 — 두 줄로</div>
                · 1줄: 도로명 주소<br/>
                · 2줄: 단지명 + 동/호<br/>
                · 배송 메시지는 괄호 <span style={{color:G.creamMuted,opacity:0.7}}>(선택)</span>
              </div>
              <div style={{marginBottom:10}}>
                <div style={{color:G.cream,fontWeight:700,marginBottom:3}}>2️⃣ 상품 — 한 줄에 하나</div>
                · 색상이 다르면 줄을 나누어 입력
              </div>
              <div style={{marginBottom:10}}>
                <div style={{color:G.cream,fontWeight:700,marginBottom:3}}>3️⃣ 단가 / 총금액</div>
                · 단가는 <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>@</span> 기호 또는 그냥 숫자 (자유)<br/>
                · 상품 총금액 명시:&nbsp;
                <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>= 10,500원</span>{" "}/{" "}
                <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>총 10,500원</span>{" "}/{" "}
                <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>합계 10,500원</span>
              </div>
              <div>
                <div style={{color:G.cream,fontWeight:700,marginBottom:3}}>4️⃣ 배송비 — 다음 중 하나</div>
                · <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>배송비 N원</span> 형식<br/>
                · 수식 표기 <span style={{fontFamily:"monospace",background:G.surface,padding:"1px 5px",borderRadius:4,color:G.cream}}>10,000 + 3,000 = 13,000원</span>
              </div>
            </div>
          </details>
        </div>
      </div>

      {mergePickerOpen && parsed && (
        <MergeModal
          commit={false}
          initialIds={pendingMergeIds}
          sourceOrder={{
            id: "__new__",
            _isNew: true,
            customer: (parsed.customer && (resolvedCustomer?.name || parsed.customer)) || "",
            date: nowT().date,
            items: parsed.items || [],
            address: resolvedCustomer?.address || parsed.address || "",
            phone: resolvedCustomer?.phone || parsed.phone || "",
            note: parsed.note || "",
            status: "접수",
          }}
          orders={orders}
          customers={customers}
          showToast={showToast}
          onConfirm={({ ids })=>setPendingMergeIds(ids)}
          onClose={()=>setMergePickerOpen(false)}
        />
      )}
      </>)}
    </div>
  );
}

// ════════════════ 적립금 탭 ═══════════════════════════════════
export default OrderInput;
