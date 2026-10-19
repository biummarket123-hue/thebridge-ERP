import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import * as XLSX from "xlsx-js-style";
import { supabase } from "./lib/supabase.js";

const REWARDS_DATA = {points:[],free:[],events:[],date:""};


const G = {
  bg:"#0D0B09", surface:"#161410", card:"#1E1A16",
  border:"#2E2820", copper:"#C8794A", copperLight:"#E8956A",
  copperGlow:"rgba(200,121,74,0.15)", cream:"#F0E6D6", creamMuted:"#A89880",
  white:"#FFFFFF", green:"#5B9E72", greenBg:"rgba(91,158,114,0.12)",
  red:"#C05A4A", redBg:"rgba(192,90,74,0.12)", yellow:"#C4963A",
  yellowBg:"rgba(196,150,58,0.12)", blue:"#4A7EA8", blueBg:"rgba(74,126,168,0.12)",
  purple:"#8A6AB8",
  pink:"#C77DA0", pinkBg:"rgba(199,125,160,0.14)",
  trackBg:"rgba(255,255,255,0.06)", subtleBg:"rgba(255,255,255,0.04)",
  cardShadow:"none", cardShadowHover:"none", inputBg:"#161410",
  filterBg:"#1B1E26", filterBorder:"#333A4A", // 필터 패널 — 카드(웜 브라운)와 구별되는 쿨톤
};
const GL = {
  // ── 미니멀 화이트 디자인 시스템 ──
  bg:"#F8F9FA",           // 아주 연한 쿨그레이 배경
  surface:"#FFFFFF",       // 순백 서피스
  card:"#FFFFFF",          // 순백 카드 (그림자로 깊이감)
  border:"#E5E7EB",        // 연한 그레이 보더
  copper:"#D4722C",        // 선명한 오렌지-카퍼
  copperLight:"#E8884A",   // 밝은 카퍼
  copperGlow:"rgba(212,114,44,0.12)", // 카퍼 글로우
  cream:"#1A1A2E",         // 진한 차콜 네이비 (메인 텍스트)
  creamMuted:"#6B7280",    // 쿨그레이 (보조 텍스트)
  white:"#FFFFFF",         // 버튼 텍스트용
  green:"#059669",         // 에메랄드 그린
  greenBg:"rgba(5,150,105,0.08)",
  red:"#DC2626",           // 선명한 레드
  redBg:"rgba(220,38,38,0.06)",
  yellow:"#D97706",        // 앰버 (가독성 좋은 오렌지계)
  yellowBg:"rgba(217,119,6,0.08)",
  blue:"#2563EB",          // 로열 블루
  blueBg:"rgba(37,99,235,0.06)",
  purple:"#7C3AED",        // 바이올렛
  pink:"#DB2777",          // 로즈/마젠타 (포장완료 — 합배송 보라와 구분)
  pinkBg:"rgba(219,39,135,0.08)",
  trackBg:"#E5E7EB",       // 트랙 배경 (solid gray)
  subtleBg:"#F3F4F6",      // 미세 배경 구분
  // ── 화이트 전용 확장 ──
  cardShadow:"0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
  cardShadowHover:"0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.06)",
  inputBg:"#F9FAFB",       // 입력창 배경 (순백과 미세 구분)
  filterBg:"#EEF1F6", filterBorder:"#D3DAE6", // 필터 패널 — 순백 카드와 구별되는 쿨 그레이
};
const ThemeCtx = createContext(G);
const useTheme = () => useContext(ThemeCtx);
const S = "'Noto Sans KR','Apple SD Gothic Neo',sans-serif";
const SF = "'Noto Serif KR','Apple SD Gothic Neo',serif";
let _n = 100;
const uid = () => `#${String(++_n).padStart(4,"0")}`;
const nowT = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return {
    date: `${y}. ${m}. ${dd}.`,
    time: d.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}),
  };
};
const baseInp = {
  width:"100%", padding:"10px 13px", borderRadius:10,
  border:"1px solid var(--border, #2E2820)",
  background:"var(--inputBg, #161410)",
  fontFamily:S, fontSize:13, color:"var(--cream, #F0E6D6)",
  outline:"none", boxSizing:"border-box",
};

const dlXlsx = (wb, filename) => {
  const buf = XLSX.write(wb, {bookType:"xlsx", type:"array"});
  const blob = new Blob([buf], {type:"application/octet-stream"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const sC = (s, T=G) => s==="출고완료" ? [T.green,T.greenBg] : s==="보관" ? [T.yellow,T.yellowBg] : s==="포장완료" ? [T.pink,T.pinkBg] : [T.blue,T.blueBg];
const pC = (p, T=G) => p==="입금완료" ? [T.green,T.greenBg] : p==="부분환불" ? [T.yellow,T.yellowBg] : p==="환불완료" ? [T.purple,"rgba(138,106,184,0.12)"] : p==="환불신청" ? [T.yellow,T.yellowBg] : p==="환불" ? [T.purple,"rgba(138,106,184,0.12)"] : [T.red,T.redBg];

// 결제상태 표시값 — 화면 전역 공용. 환불신청(요청 상태)은 _computed보다 우선,
// 그 외엔 로그기반 _computed.paymentStatus, 없으면 payment 컬럼, 최후 미입금.
// (이전엔 이 식이 DepositTab·ErpApp·DashboardTab에 제각각 복붙돼 불일치 위험이 있었음)
const getPayStatus = (o) => {
  if (o.payment === "환불신청") return "환불신청";
  return o._computed?.paymentStatus || o.payment || "미입금";
};

// 보관중 판정 — 보관은 status와 독립된 토글(is_holding)이라 '포장완료 + 보관'이 동시에 성립한다.
// (포장을 끝내놓고 보관하는 경우가 있어 상호배타 status로는 표현이 안 됨)
// 구주문은 status="보관"으로 저장돼 있어 둘 다 보관으로 인정 — 그 건을 손대면 is_holding으로 승격된다.
const isHold = (o) => !!o && (!!o.isHolding || o.status === "보관");

// 보류 판정 — 몇 달씩 못 나가는 건. 보관과 달리 레거시 status 표기가 없어 플래그 하나로 끝난다.
// 보관과 마찬가지로 status와 독립이라 '포장완료 + 보류'도 성립한다(싸놓고 못 보내는 경우).
const isParked = (o) => !!o && !!o.isParked;

// 원단 미도착 호출 중인가 — 포장직원이 "원단이 안 왔다"를 누른 상태.
// 출고완료된 건은 이미 나갔으니 호출이 남아 있어도 무시한다(해제를 깜빡한 경우 방어).
const isFabricMissing = (o) => !!o && !!o.fabricMissing && o.status !== "출고완료";

// 안 온 품목의 자리번호 — 저장된 값을 그대로 믿지 않고 items 길이로 걸러낸다.
// 호출이 걸린 사이에 품목이 편집되면 번호가 어긋날 수 있는데, 범위를 안 재면
// items[i] 가 undefined 라 카드와 배너가 통째로 터진다.
const missingItemIdx = (o) => {
  if (!isFabricMissing(o)) return [];
  const n = (o?.items || []).length;
  return (o.fabricMissingItems || []).filter(i => Number.isInteger(i) && i >= 0 && i < n);
};

// 호출된 지 몇 분 됐나. 보관·보류의 '며칠째'와 달리 분 단위 — 당일에 끝나는 일이다.
const fabricWaitMins = (o, now = Date.now()) =>
  o?.fabricMissingAt ? Math.max(0, Math.floor((now - new Date(o.fabricMissingAt)) / 60000)) : 0;

// 전화번호 가운데 마스킹 — "010-1234-5678" → "010-****-5678" (명세서 출력·명세서 탭 공용)
const maskPhone = p => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length >= 9) return `${d.slice(0, 3)}-****-${d.slice(-4)}`;
  return d ? "****" : "";
};

// 주문 카드용 💬 메모 정리 — 카드가 이미 필드·배지로 보여주는 내용을 메모에서 걷어낸다.
// 표시 단계에서만 거르므로 DB 원문은 그대로다 (주문수정 폼·검색·송장·엑셀은 원문 사용).
// 보수적으로 동작: 확실히 중복인 줄/토큰만 지우고 애매하면 남긴다.
// @단가·"1,2번각 3마씩" 같은 메모에만 있는 정보를 잃지 않는 쪽이 더 중요하기 때문.
const stripCardDup = (note, o = {}) => {
  const raw = String(note || "");
  if (!raw.trim() || raw.trim() === "None") return "";

  const sq = s => String(s ?? "").replace(/\s+/g, "").toLowerCase();  // 공백 뗀 비교키
  const dg = s => String(s ?? "").replace(/\D/g, "");
  const esc = s => String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const items = Array.isArray(o.items) ? o.items : [];
  const itemsSum = items.reduce((s, i) => s + (i.amount || 0), 0);
  const total = o.totalAmount > 0 ? o.totalAmount : itemsSum + (o.shippingFee || 0) + (o.otherCost || 0);
  const paid = getPayStatus(o) === "입금완료";
  const creditUsed = o._computed?.creditUsed || 0;

  // 품목 칩과 완전히 겹치는 줄인지 — 품번·원단·색·수량·금액을 걷어내고 글자가 안 남으면 중복.
  // 계산식 줄("총6마×@5500+4000=37,000")은 @·×·= 주변 숫자가 남아 살아남는다.
  const isItemEcho = line => {
    if (!items.length) return false;
    let r = line;
    for (const it of items) {
      for (const t of [it.itemNo, it.fabric, it.color]) {
        const v = String(t || "").trim();
        if (v) r = r.split(v).join(" ");
      }
      if (it.qty) r = r.replace(new RegExp(`${esc(it.qty)}\\s*(${esc(it.unit || "마")}|마|y|yd)?`, "gi"), " ");
      if (it.amount) {
        r = r.replace(new RegExp(`${esc(Number(it.amount).toLocaleString())}\\s*원?`, "g"), " ")
             .replace(new RegExp(`${esc(it.amount)}\\s*원?`, "g"), " ");
      }
    }
    return !/[가-힣A-Za-z0-9]/.test(r);
  };

  // 카드가 필드·배지로 이미 보여주는 단독 줄인지
  const isFieldEcho = line => {
    const k = sq(line).replace(/[.·:!~?]+$/g, "");
    if (!k) return true;
    // 🔗 링크 섹션과 중복
    if (/^https?:\/\/\S+$/i.test(line.trim())) return true;
    // 전화번호만 있는 줄 (카드 상단 · 전화)
    if (o.phone && dg(o.phone).length >= 9 && dg(line) === dg(o.phone) && !/[가-힣A-Za-z]/.test(line)) return true;
    // 📦 주소 줄 — 주소(+상세) 말고 남는 게 없을 때만
    const addr = sq(o.address), det = sq(o.addressDetail);
    if (addr.length >= 8 && k.includes(addr) && k.replace(addr, "").replace(det, "").length <= 2) return true;
    // 고객명만 있는 줄
    const cust = sq(o.customer);
    if (cust && (k === cust || k === `${cust}님`)) return true;
    // 판매처 배지와 중복
    if (o.salesChannel && k === sq(o.salesChannel)) return true;
    // 배지로 이미 뜨는 단독 키워드 줄
    if (o.combinedPayment    && /^합입금(요청|건|처리)?$/.test(k)) return true;
    if (o.combinedShipping   && /^(합배|합배송|합배송건|합배요청)$/.test(k)) return true;
    if (o.freeShippingUsed   && /^무료배송권(사용|1장|한장)?$/.test(k)) return true;
    if (creditUsed > 0       && /^적립금?(사용|전액)?([\d,]+원?)?$/.test(k)) return true;
    if (o.receiptType        && /^(현금영수증|지출증빙|세금계산서|계산서)(요청|발행|해주세요|부탁드려요)?$/.test(k)) return true;
    if (paid                 && /^입금(완료|했습니다|했어요|함|완)?$/.test(k)) return true;
    // 🚚 배송비 칩 · 총 금액과 중복 (금액이 실제로 일치할 때만)
    const fee = k.match(/^배송비([\d,]+)원?$/);
    if (fee && (o.shippingFee || 0) > 0 && dg(fee[1]) === String(o.shippingFee)) return true;
    const sum = k.match(/^(?:총|합계|총액|총금액|합계금액)([\d,]+)원?$/);
    if (sum && total > 0 && dg(sum[1]) === String(total)) return true;
    return false;
  };

  // 헤더 꼬리의 합배 표기("-미송님과합배", "(대표님합)")는 걷어내지 않는다.
  // 📦 합배송 배지는 '묶였다'만 알려주고 누구와 묶였는지는 이 꼬리표에만 있다 —
  // 배지와 겹쳐 보이지만 실제로는 배지가 못 담는 정보라 남긴다.

  return raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !isFieldEcho(l) && !isItemEcho(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const PARSE_SYSTEM = `동대문 원단시장 카카오톡 주문 메시지 분석. 순수 JSON만 반환. 마크다운 없이.
{"customer":"고객명(닉네임 포함 원문)","phone":"전화번호 또는 null","customerName":"순수 이름만","customerPhone":"전화번호 또는 null","customerNickname":"닉네임 또는 null","customerMidPhone":"중간번호 4자리 또는 null","items":[{"itemNo":"아이템번호 또는 null","fabric":"원단명","color":"색상/번호","qty":숫자,"unit":"마|세트|필","unitPrice":단가숫자,"amount":총금액숫자}],"payment":"입금완료|미입금","address":"기본주소 또는 null","address_detail":"상세주소 또는 null","deliveryMessage":"배송메시지 또는 null","links":["URL링크들 배열, 없으면 빈배열"],"note":"메모 또는 null","shippingFee":배송비숫자,"totalAmount":주문전체총금액숫자,"combinedPayment":false,"combinedShipping":false,"salesChannel":"판매처 또는 빈문자열"}

고객명(customer) 파싱 규칙:
- 이름 옆에 괄호로 닉네임이 있으면 반드시 함께 포함해라. 절대 닉네임을 제거하지 마라.
- 예: "윤원영4275(유진석현맘)" → customer:"윤원영4275(유진석현맘)"
- 예: "김철수(동대문사장)" → customer:"김철수(동대문사장)"
- 닉네임이 없으면 이름만 넣어라.

고객 식별 필드 파싱 규칙 (매우 중요):
- 고객 정보를 분석하여 customerName, customerMidPhone, customerNickname을 각각 분리해라.
- 패턴: "홍길동3914(방방방)" → customerName:"홍길동", customerMidPhone:"3914", customerNickname:"방방방"
- 패턴: "윤원영4275(유진석현맘)" → customerName:"윤원영", customerMidPhone:"4275", customerNickname:"유진석현맘"
- 패턴: "김철수(동대문사장)" → customerName:"김철수", customerMidPhone:null, customerNickname:"동대문사장"
- 패턴: "홍길동3914" → customerName:"홍길동", customerMidPhone:"3914", customerNickname:null
- 패턴: "홍길동" → customerName:"홍길동", customerMidPhone:null, customerNickname:null
- 괄호 안 내용 → customerNickname
- 이름 뒤 연속된 4자리 숫자 → customerMidPhone (전화번호 중간번호)
- 순서/띄어쓰기 무관하게 인식해라
- customerPhone은 phone과 동일한 값 (전체 전화번호)

items 파싱 규칙 (매우 중요):
- 여러 색상/번호가 묶여 있으면 반드시 각각 개별 항목으로 분리해라. 절대 합치지 마라.
- "1,2번각 3마씩" → items 2개: {fabric:"린넨코튼",color:"1번",qty:3,unit:"마"}, {fabric:"린넨코튼",color:"2번",qty:3,unit:"마"}
- "화이트,베이지 각 5마" → items 2개: {color:"화이트",qty:5,unit:"마"}, {color:"베이지",qty:5,unit:"마"}
- "1~4번 각 2마씩" → items 4개: {color:"1번",qty:2,unit:"마"}, {color:"2번",qty:2,unit:"마"}, {color:"3번",qty:2,unit:"마"}, {color:"4번",qty:2,unit:"마"}
- 총수량이 아닌 개별 수량을 기준으로 파싱해라

수량 단위(unit) 파싱 규칙 (매우 중요):
- 각 아이템마다 unit 필드를 반드시 포함해라. 기본값 "마".
- "3마", "3y", "3야드" → qty:3, unit:"마"
- "1세트", "2세트", "한세트" → qty:1/2/1, unit:"세트"
- "1필", "2필", "한필" → qty:1/2/1, unit:"필"
- 단위가 명시되지 않았거나 애매하면 unit:"마" 기본값 사용
- 절대 "세트"나 "필"을 "마"로 변환하지 마라 (세트·필은 원단 시장 고유 단위, 마 단위와 별개)

결제(payment) 파싱 규칙 (매우 중요):
- 기본값은 "미입금"이다. 입금완료를 명시하는 표현이 있을 때만 "입금완료"로 설정해라.
- "입금완료"로 판단하는 경우(이 표현 중 하나라도 있을 때만):
  · "입금완료", "입금됨", "입금했어요", "입금했습니다", "방금 입금", "입금 끝"
  · "송금완료", "송금했어요", "송금했습니다", "이체완료", "이체했어요"
  · "결제완료", "결제했어요", "결제했습니다", "지급완료", "납부완료", "완납", "paid"
- 그 외(금액만 적혀 있는 경우, 계산식만 있는 경우, 입금 언급이 아예 없는 경우, "미입금/입금전/후불/착불" 등) → 전부 "미입금"
- 금액 계산(50×500=25,000원)이나 총액 표시(=32,000원) 자체는 결제 상태를 바꾸지 않는다 — 별도 입금완료 표현이 있어야만 "입금완료"
- "합입금"/"합 입금"/"합입" 표현이 있으면 payment는 무조건 "미입금" (다른 주문과 합쳐 나중에 입금하겠다는 뜻이지 입금 완료가 아님). combinedPayment=true 와 무관하게 payment="미입금" 강제.
- "무료나눔"/"무료 나눔" 표현이 있으면 payment는 무조건 "미입금" (원단값은 0원이지만 택배비는 받아야 하므로 결제 안 끝남). amount=0 이어도 payment="미입금" 유지.

금액(amount, unitPrice) 파싱 규칙 (매우 중요):
- 각 아이템의 단가를 unitPrice에, 총금액을 amount에 숫자로 넣어라 (콤마 제거, 순수 숫자). 금액 정보가 없으면 0.
- "3,800*10= 38,000원" → unitPrice:3800, qty:10, amount:38000
- "@3,800 × 10" → unitPrice:3800, qty:10, amount:38000
- "3y 5,000= 15,000원" → unitPrice:5000, qty:3, amount:15000
- "린넨 베이지 3마 45,000원" → qty:3, amount:45000, unitPrice:15000 (amount/qty)
- "@5,000 × 3" 또는 "×@5,500" → unitPrice:5000/5500, amount = unitPrice × qty
- "3마씩 총6마×@5500+4000=37,000" → 계산식의 최종 금액을 amount로 사용, unitPrice는 5500
- 단가만 있고 총금액이 없으면: amount = qty × unitPrice
- 총금액만 있고 단가가 없으면: unitPrice = Math.round(amount / qty)
- 둘 다 없으면: unitPrice:0, amount:0
- totalAmount: 모든 아이템 amount의 합계 + shippingFee. 메시지에 전체 총금액이 명시되어 있으면 그 값 사용. 없으면 items의 amount 합계 + shippingFee.

총액 명시 패턴(매우 중요) — 다음 표기가 있으면 무조건 그 숫자를 totalAmount로 사용하고 다른 계산을 무시:
- "총 10,500원" / "총금액 10,500원" / "총액 10,500원" → totalAmount=10500
- "합계 10,500원" → totalAmount=10500
- 메시지 마지막 부근의 단독 줄 "= 10,500원" (아이템 줄과 분리된 자체 줄) → totalAmount=10500
- items.amount 합 + shippingFee와 차이가 나도 명시값을 신뢰. items.amount/shippingFee는 AI 자체 계산값 그대로 두고 totalAmount만 명시값으로 설정.
- 여러 개 명시되어 있으면 가장 마지막에 등장한 값을 사용.

배송비(shippingFee) 파싱 규칙:
- "배송비 3,000원", "택배비 5,000원", "배비 3000", "배송 3000", "택배 5000" 등의 패턴에서 배송비를 추출
- 숫자만 넣어라 (콤마 제거). 배송비 정보가 없으면 0.
- "착불"인 경우에도 금액이 있으면 shippingFee에 넣어라

합입금/합배송(combinedPayment, combinedShipping) 파싱 규칙:
- combinedPayment: "합입금", "합 입금", "합입" 표현이 있으면 true
- combinedShipping: "합배송", "합 배송", "합배" 표현이 있으면 true
- 중요: "OOO님 합", "OOO님과 합", "OOO님과합배", "(OOO 합)" 같은 패턴은 다른 사람과 합쳐서 배송한다는 뜻이므로 combinedShipping: true
- 둘 다 있으면 둘 다 true. 해당 표현이 없으면 false.
- 예: "(미송님 합)" + "합입금" → combinedShipping: true, combinedPayment: true (합 = 합배송, 합입금 = 합입금)
- 예: "미송님과합배" → combinedShipping: true
- 예: "합입금 합배송" → combinedPayment: true, combinedShipping: true
- 예: "20,500원 합입금" → combinedPayment: true
- 예: "(미송님 합)" → combinedShipping: true (다른 사람과 합배송)

판매처(salesChannel) 파싱 규칙:
- 메시지에서 판매처를 자동 인식하여 salesChannel에 저장
- "쿠팡" → salesChannel: "쿠팡"
- "인스타", "인스타그램" → salesChannel: "인스타"
- "스마트스토어", "네이버", "스토어" → salesChannel: "스마트스토어"
- "로하이몰" → salesChannel: "로하이몰"
- "카페24" → salesChannel: "카페24"
- "스레드", "스레즈" → salesChannel: "스레드"
- "밴드", "밴드주문" → salesChannel: "" (밴드는 빈값으로 저장)
- 해당 표현이 없으면 salesChannel: ""
- 제목/헤더에 "P)" 접두사 뒤에 날짜와 함께 판매처가 올 수 있음 (예: "P)4/6 밴드주문")

아이템 No(itemNo) 파싱 규칙:
- 품번은 "S-2610-0005", "A-2610-0006", "LH-2610-0002" 같은 꼴이다(영문 접두어-년월 4자리-번호 4자리). 줄 맨 앞에 오는 것이 보통이지만 원단명 뒤나 괄호 안에 있어도 itemNo로 파싱
- 예: "S-2610-0005 린넨코튼 베이지 3마 @5,500" → {"itemNo":"S-2610-0005","fabric":"린넨코튼","color":"베이지","qty":3,"amount":16500}
- 예: "린넨코튼 베이지 3마 (S-2610-0005)" → itemNo "S-2610-0005" (괄호 안 품번은 색상·메모가 아니다)
- 옛 꼴 "A-001", "B-002" 같은 영문+숫자 아이템 번호도 itemNo로 파싱
- 품번은 원단명(fabric)에 넣지 않는다. 아이템 번호가 없으면 itemNo는 null로 설정

메모(note) 규칙:
- 구조화된 필드(고객명, 전화번호, 주소, items, links)에 들어가지 않는 모든 원문 정보를 메모에 담아라
- 특히 다음을 반드시 메모에 포함:
  1) 첫 줄 제목/헤더 — 절대 생략 금지 (예: "P)4/6 밴드주문-미송님과합배", "W) 7/13 밴드주문 (대표님합)")
  2) 원단별 상세 계산식/단가 (예: "린넨코튼 1,2번각 3마씩 총6마×@5500+4000=37,000")
  3) 합배 정보, 배송 요청사항, 기타 특이사항
- 줄바꿈(\\n)으로 구분해서 원문 그대로 넣어라

주소 파싱 규칙 (address와 address_detail을 반드시 분리):
- address(기본주소): 시/도, 시/군/구, 읍/면/동, 로/길/번지까지
- address_detail(상세주소): 아파트명+동+호수, 건물명+층+호수, 상가명 등 그 이후 부분
예시:
"경기도 성남시 분당구 성남대로 43번길 10 하나ez타워 6층 601호" → address:"경기도 성남시 분당구 성남대로 43번길 10", address_detail:"하나ez타워 6층 601호"
"전남 목포시 남악1로16번길 10 옥암골드클래스 103-1502호" → address:"전남 목포시 남악1로16번길 10", address_detail:"옥암골드클래스 103-1502호"
"서울 노원구 상계동 한글비석로 보람아파트1차 104동 1107호" → address:"서울 노원구 상계동 한글비석로", address_detail:"보람아파트1차 104동 1107호"

배송메시지(deliveryMessage) 파싱 규칙 (매우 중요):
- 주소 줄 옆/아래에 괄호 ()로 적힌 배송 시 전달사항을 deliveryMessage로 분리해라.
- 배송 메시지 후보 표현: "집 앞에 두고 문자", "경비실 맡겨", "부재시", "도착전 연락", "벨 누르지 마세요", "노크", "전화주세요", "택배함", "현관 앞", "문자해주세요", "통화 후" 등 배송 행동 지시 문구.
- 예: "서울 강남구 테헤란로 100 (집 앞에 두고 문자해주세요)" → address:"서울 강남구 테헤란로 100", deliveryMessage:"집 앞에 두고 문자해주세요"
- 예: "서울 강남구 테헤란로 100\\n(부재시 경비실에 맡겨주세요)" → address:"서울 강남구 테헤란로 100", deliveryMessage:"부재시 경비실에 맡겨주세요"
- 예: "서울 강남구 테헤란로 100 래미안 101동 502호 (도착전 연락주세요)" → address:"서울 강남구 테헤란로 100", address_detail:"래미안 101동 502호", deliveryMessage:"도착전 연락주세요"
- 닉네임/이름 옆 괄호 (예: "홍길동(샤크)")는 절대 deliveryMessage 가 아니다 — 이름 식별용이므로 customerNickname으로만 처리.
- 합배송 표시 괄호 (예: "(미송님 합)")도 deliveryMessage 가 아니다 — combinedShipping 플래그로 처리.
- 배송 행동 지시가 아니면 deliveryMessage 는 null.
- deliveryMessage 로 분리한 내용은 note 에 중복 포함하지 마라 (단독 분리).

이미지인 경우 화면에서 주문 정보를 직접 읽어서 파싱하세요.`;

// ── 자유 형식 주문글 전용 부록 ────────────────────────────────────────────
//
// 대부분의 직원은 정해진 틀로 적는다.
//   S) 8/25 밴드주문 - 합배송        ← 헤더(담당자·날짜·채널)
//   (빈 줄)
//   심복선 5598(구절초)              ← 이름 + 중간4자리 + 닉네임
//   010-5598-9519
//   주소
//   (빈 줄)
//   광목20수 야생화 들꽃자수
//   3y × 마당 13,000원              ← 수량 × 단가
//   = 39,000원
//
// 그런데 한 사람은 고객과 주고받은 대화를 그대로 붙여넣는다. 순서가 매번 다르고,
// 수량이 빠지고, 금액은 "37500+4000=51500원" 같은 계산식만 남는다.
// 실측(2026-08-25, 등록된 주문 기준):
//   헤더 없음 98%(다른 직원 0~2%) · 전화 표기 제각각 56%(0~1%)
//   품목 2개 이상인데 하나가 0원 4%(0~1%)
//
// 실제로 재현해 본 오류 두 가지:
//   "밀파+프라다린넨 각한세트 / 37500+4000=51500원"
//     → 배송비 4,000 을 두 번째 품목의 금액으로 읽었다. 배송비는 0 이 됐다.
//   "수입나염 / 17500원"
//     → 수량이 없자 qty:0, amount:0, totalAmount:0 — 금액이 통째로 사라졌다.
//
// 이 부록은 그 사람의 글에만 붙인다. 공통 프롬프트(PARSE_SYSTEM)는 건드리지 않으므로
// 다른 직원의 분석 결과는 한 글자도 달라지지 않는다.
const FREEFORM_ADDENDUM = `[자유 형식 주문글 — 고객과 주고받은 대화를 그대로 옮긴 글이다]

정해진 순서가 없다. 주소가 먼저일 수도, 품목이 먼저일 수도, "입금완료"가 첫 줄일 수도 있다.
순서가 아니라 내용으로 판단해라.

■ 가장 중요: 없는 것을 지어내지 마라. 빈칸이 틀린 숫자보다 낫다.

1) "37500+4000=51500원" 같은 계산식
- 항의 개수가 품목 수보다 하나 많으면 마지막 항은 배송비다.
  예: 품목 2개 + "37500+4000=51500" → 37500 은 품목 합계, 4000 은 shippingFee
- 배송비를 품목으로 만들지 마라. 이게 가장 흔한 실수다.
- 좌변의 합이 우변과 다르면(37500+4000 은 41500 인데 51500 이라 적힌 경우)
  totalAmount 는 우변을 쓰고(고객이 실제로 낸 금액), 품목 amount 는 전부 null 로 둬라.

2) 품목이 둘 이상인데 품목별 금액이 없으면 나누지 마라
- "밀파+프라다린넨 각한세트 / 37500+4000=51500원"
  → items: 밀파(amount:null), 프라다린넨(amount:null), shippingFee:4000, totalAmount:51500
- 한 품목에 몰아넣고 나머지를 0 으로 만들면 틀린 장부가 된다.
- "A+B" 처럼 한 줄에 원단 두 개가 적혀 있으면 items 두 개로 나눠라. fabric 에 "+" 를 넣지 마라.

3) 수량
- "패키지", "세트", "한세트", "1세트" 가 품목명이나 그 줄에 있으면 qty:1, unit:"세트" 다.
  이건 추측이 아니라 글에 적힌 것이다. null 로 두지 마라.
  예: "면패키지 / 35000+8000=43000원" -> qty:1, unit:"세트", amount:35000
  예: "방수코팅 한세트 / 26000+6000=32000원" -> qty:1, unit:"세트", amount:26000
- 단위가 아예 없으면("수입나염 17500원") qty 를 null 로 둬라. 0 도 1 도 아니다.
- 수량을 몰라도 금액은 살려라. amount 와 totalAmount 는 적힌 대로 채운다.

4) 전화번호 표기가 제각각이다 — "010 9384. 8397.", "010. 3742. 9158", "01024034585", "010 -8977-3591"
   숫자만 뽑아 010-XXXX-XXXX 로 정규화해라.

5) 이름 뒤의 "입니다/이에요/예요"는 떼고 이름만 넣어라.
   인사말("감사합니다", "수고하세요", "네~")과 이모지는 note 에만 남기고 다른 필드에 넣지 마라.

6) 품목이 아닌 것을 품목으로 만들지 마라
- "롤묶음 배송", "롤배송", "합배송", "합입금", "보관", "입금완료", "무료배송권 사용" 은
  배송 방식이나 처리 상태다. 원단이 아니다. items 에 넣지 마라.
- 원단명은 소재·조직·무늬 이름이다(면, 린넨, 광목, 인견, 나염, 자수, 체크, 아사 ...).

7) 품목이 하나뿐이면 그 금액을 null 로 두지 마라
- "면패키지 / 35000+8000=43000원" → 면패키지 amount:35000, shippingFee:8000
- amount 를 null 로 두는 건 '여러 품목에 나눌 근거가 없을 때'만이다.
  품목이 하나면 나눌 일이 없으니 계산식 좌변의 첫 항이 그 품목의 금액이다.

8) "5마 15,000" 처럼 수량 뒤에 숫자가 하나뿐이면 그건 그 품목의 합계다
- qty:5, amount:15000, unitPrice:3000 (15000 을 5 로 나눈 값)
- 단가로 보고 수량을 곱하지 마라. 75,000 이 되면 틀린 값이다.
- 곱셈으로 읽어도 되는 건 "10마 3,000 = 30,000" 처럼 결과가 같이 적혀 있을 때뿐이다.

9) "합입금", "합계입금", "총입금" 뒤의 금액은 이 주문의 금액이 아니다
- 여러 주문을 묶어서 한 번에 낸 돈이다. combinedPayment:true 로만 표시해라.
- totalAmount 에 그 숫자를 넣지 마라. 이 주문의 품목 합계 + 배송비가 totalAmount 다.
- 그 숫자에 맞추려고 배송비나 품목 금액을 지어내지 마라. 이게 가장 위험한 실수다.
  예: "베이지 스트라이프 5마 15,000" + "합입금 39,000원"
      -> amount:15000, shippingFee:0, totalAmount:15000, combinedPayment:true
      (39,000 은 note 에만 남긴다)`;

// 자유 형식으로 적는 작성자. 로하톡 메모의 author 와 정확히 일치해야 한다("님" 포함).
// 여기 없는 사람은 부록이 붙지 않으므로 분석 결과가 지금과 완전히 같다.
//
// 한때 '헤더가 없는 글' 조건을 AND 로 걸었다가 뺐다. 다른 직원은 애초에 이 목록에
// 없어서 헤더 조건이 막아줄 게 없었고, 정작 이 사람이 헤더를 붙여 쓴 4건(207건 중)만
// 부록에서 빠졌다. 그 4건을 실제로 돌려보니 부록 쪽이 더 정확했다 —
// "베이지 스트라이프 5마 15,000 / 합입금 39,000원" 을 부록 없이는 배송비 24,000 으로
// 억지로 맞추는데, 부록은 합입금을 총액으로 쓰지 말라는 규칙(9)이 있어 바로잡는다.
// 조건이 하나면 무엇이 왜 걸리는지도 한눈에 보인다.
const FREEFORM_AUTHORS = new Set(["고문님"]);

const isDev = import.meta.env.DEV;
const DEV_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;

async function aiCallAPI(messages, system) {
  if (isDev && DEV_API_KEY) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": DEV_API_KEY,
        "anthropic-version":"2023-06-01",
        "anthropic-dangerous-direct-browser-access":"true",
      },
      body: JSON.stringify({
        model:"claude-haiku-4-5-20251001", max_tokens:4096,
        system: system || "",
        messages,
      }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(d.error?.message || `API 오류 (${res.status})`);
    return d;
  }
  // 서버가 로그인 세션을 확인한다(api/analyze.js). company 모드는 db.js 가 자동 로그인해
  // 두므로 세션은 거의 항상 있다. 없으면 헤더 없이 보내고 서버의 401 메시지를 그대로 띄운다.
  const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  const res = await fetch("/api/analyze", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ system, messages }),
  });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(d.error?.message || `API 오류 (${res.status})`);
  return d;
}

function parseAiJson(d) {
  const raw = (d.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (d.stop_reason === "max_tokens") {
      throw new Error("주문 내용이 너무 길어 분석이 잘렸어요. 메시지를 나눠서 다시 시도해주세요.");
    }
    throw e;
  }
}

// AI 호출 전 입력 정규화 — 흔한 표기 오류를 자동 보정해 파싱 정확도를 높인다.
// 담당자가 자유롭게 입력해도 표준 폼에 가깝게 변환되어 AI 학습 패턴과 일치.

// 1. 점 천단위 → 콤마 (3.500 → 3,500). 가장 치명적이라 가장 먼저.
//    뒤가 숫자가 아닐 때만 매칭 → 진짜 소수점(1.5마, 0.5마)은 유지.
//    연쇄(3.500.000) 처리 위해 변화 없을 때까지 반복.
function fixThousandSeparator(text) {
  let s = text;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/(\d+)\.(\d{3})(?=\D|$)/g, "$1,$2");
  }
  return s;
}

// 2. ₩ 기호 → 원 (₩20,000 → 20,000원). AI 프롬프트는 "원" 단어 기준이라
//    ₩ 그대로면 단가 오인 (5×20,000=100,000 사고).
function fixWonSymbol(text) {
  return text.replace(/₩\s*([\d,]+)\s*원?/g, "$1원");
}

// 3. 닉네임 순서 (홍장미(장미)8749 → 홍장미8749(장미)). customerMidPhone/Nickname 분리 안정화.
//    이름+숫자 공백제거(아래 #4)보다 먼저 실행 — 이게 4자리를 이름 뒤로 옮긴다.
function fixNicknameOrder(text) {
  return text.replace(
    /([가-힣]{2,4})\s*(\([^)]+\))\s*(\d{4})(?!\d)/g,
    "$1$3$2"
  );
}

// 4. 이름과 4자리 사이 공백 제거 (장영진 4804 → 장영진4804).
function fixCustomerNameDigits(text) {
  return text.replace(/([가-힣]{2,4})\s+(\d{4})(?!\d)/g, "$1$2");
}

// 5. 동/호 띄어쓰기 (1005동1603호 → 1005동 1603호). address_detail 분리 정확도 ↑.
function fixAddressFormat(text) {
  return text.replace(/(\d+동)(\d+호)/g, "$1 $2");
}

// 6. 배송비 표기 통일 (+4,000배송비 / +4,000[배송비] / +5,000택배 → 배송비/택배 N원).
function fixShippingFee(text) {
  return text.replace(
    /\+\s*([\d,]+)\s*\[?(배송비?|택배비?)\]?/g,
    "$2 $1원"
  );
}

// 6-1. 인라인 배송비 (10마×@3500+4000=39,000 → 10마×@3500, 배송비 4000원).
//      "단가+배송비=합계" 형태로 한 줄에 묶인 패턴. '=합계' 부분은 제거 —
//      그 값은 단지 (단가×수량+배송비)일 뿐 주문 총액이 아니라
//      extractExplicitTotal에 잘못 잡힐 위험이 있음. 배송비만 키워드로 노출.
function fixInlineShipping(text) {
  return text.replace(
    /([×x*]\s*@?\s*[\d,]+)\s*\+\s*([\d,]+)\s*원?\s*=\s*([\d,]+)\s*원?/g,
    (_, prefix, ship) => `${prefix}, 배송비 ${ship.replace(/,/g, "")}원`
  );
}

// 6-2. 주문 합계 수식 (35,000 + 4,000 = 39,000원 → 배송비 4000원, 합계 39000원).
//      한 줄 단독으로 적힌 "상품합 + 배송비 = 총액" 표기 패턴.
//      라인 전체가 숫자/연산자로만 구성된 경우만 매칭 — 본문 중간 우연 매칭 방지.
//      "$1(상품합)" 부분은 버림: AI가 items.amount 합으로 자체 산출.
function fixOrderTotalEquation(text) {
  return text.replace(
    /^[ \t]*([\d,]+)\s*원?\s*\+\s*([\d,]+)\s*원?\s*=\s*([\d,]+)\s*원?[ \t]*$/gm,
    (_, _items, ship, total) =>
      `배송비 ${ship.replace(/,/g, "")}원, 합계 ${total.replace(/,/g, "")}원`
  );
}

// 7. 입금 마크 표시 ([…원 입금] → …원 입금완료). "입금완료" 키워드로 정규화.
function fixPaymentMark(text) {
  return text.replace(
    /\[([\d,]+\s*원\s*[,\s]*[\d,]*\s*원?\s*입금)\]/g,
    "$1완료"
  );
}

// 8. 폰번호 공백 → 하이픈 (010  5745  4966 → 010-5745-4966).
function fixPhoneNumber(text) {
  return text.replace(/(010)\s+(\d{3,4})\s+(\d{4})/g, "$1-$2-$3");
}

// 9. y → 마 단위 통일 (5y → 5마, 10.5y → 10.5마). yard 같은 영어 단어는 영향 X.
function fixYardUnit(text) {
  return text.replace(/(\d+(?:\.\d+)?)y(?![a-zA-Z])/g, "$1마");
}

export function preprocessOrderText(text) {
  if (!text) return text;
  let result = text;
  result = fixThousandSeparator(result);   // 1. 점 천단위 (가장 먼저)
  result = fixWonSymbol(result);           // 2. ₩ → 원
  result = fixNicknameOrder(result);       // 3. 닉네임 순서
  result = fixCustomerNameDigits(result);  // 4. 이름+숫자 공백
  result = fixAddressFormat(result);       // 5. 동/호 띄어쓰기
  result = fixShippingFee(result);         // 6. 배송비 표기
  result = fixInlineShipping(result);      // 6-1. 인라인 배송비 (qty×@단가+배송비=합계)
  result = fixOrderTotalEquation(result);  // 6-2. 주문 합계 수식 (상품합+배송비=총액)
  result = fixPaymentMark(result);         // 7. 입금 마크
  result = fixPhoneNumber(result);         // 8. 폰번호 공백
  result = fixYardUnit(result);            // 9. y → 마

  if (result !== text) {
    console.log("[주문분석] prepass 적용됨");
    console.log("  원본:", text.slice(0, 200));
    console.log("  정리:", result.slice(0, 200));
  }
  return result;
}

// 명시 총액 추출 — "총 N원", "총금액 N원", "합계 N원", 단독 줄의 "= N원" 패턴.
// 여러 개 있으면 가장 마지막 매치 사용 (메시지 끝부분에 합계가 적히는 패턴).
function extractExplicitTotal(text) {
  const patterns = [
    /총\s*(?:금액|액)?\s*([\d,]+)\s*원/g,  // 총 N원, 총금액 N원, 총액 N원
    /합계\s*([\d,]+)\s*원/g,                // 합계 N원
    /^\s*=\s*([\d,]+)\s*원\s*$/gm,         // 단독 줄의 = N원
  ];
  let last = null;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = parseInt(m[1].replace(/,/g, ""), 10);
      if (val > 0) last = val;
    }
  }
  return last;
}

// AI 결과 후처리 — 프롬프트가 규칙을 무시할 경우를 대비한 안전망.
// 합입금: "합입금/합 입금/합입" 표현이 있으면 payment="미입금" 강제 (입금 완료 아님).
// 무료나눔: 원단값은 0원이지만 택배비는 받아야 하므로 payment="미입금" 강제.
// 명시 총액: "총 N원" / "합계 N원" / 단독 "= N원" 있으면 totalAmount 강제 덮어씀.
function normalizeParsed(parsed, sourceText) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const text = String(sourceText || "");
  const hasCombinedPayment = parsed.combinedPayment === true || /합\s*입(금)?/.test(text);
  const isFreeGiveaway = /무료\s*나눔/.test(text);
  if (hasCombinedPayment) {
    parsed.combinedPayment = true;
    parsed.payment = "미입금";
  }
  if (isFreeGiveaway) {
    parsed.payment = "미입금";
  }
  const explicitTotal = extractExplicitTotal(text);
  if (explicitTotal !== null && explicitTotal > 0) {
    parsed.totalAmount = explicitTotal;
  }
  // 첫 줄 제목/헤더 보정 — "W) 7/13 밴드주문 (대표님합)", "P)4/6 밴드주문" 같은 헤더는
  // AI가 note에 빠뜨리는 경우가 있어 코드에서 강제로 note 맨 앞에 포함시킨다.
  const firstLine = text.split("\n").map(s => s.trim()).find(Boolean) || "";
  const looksHeader = firstLine && firstLine.length <= 60 &&
    (/^[A-Za-z]{1,3}\s*\)/.test(firstLine)                     // "W)" "P)" 같은 채널 접두사
      || (/주문/.test(firstLine) && !/\d+\s*마/.test(firstLine))); // "7/13 밴드주문 ..." (아이템 줄 제외)
  if (looksHeader) {
    const note = String(parsed.note || "").trim();
    if (!note.includes(firstLine)) parsed.note = note ? `${firstLine}\n${note}` : firstLine;
  }
  // 도로명 끝부분("길 N"/"로 N")이 address_detail로 잘못 분리된 경우 보정.
  // 예: "다가9길 22" → AI가 address="다가9", address_detail="길 22"로 분리하는 케이스.
  //     → address="다가9길 22", address_detail="" 로 다시 합친다.
  if (parsed.address && parsed.address_detail) {
    const a = String(parsed.address).trim();
    const d = String(parsed.address_detail).trim();
    const alreadyComplete = /[로길]$/.test(a) || /[로길]\s*\d+(?:-\d+)?$/.test(a);
    if (!alreadyComplete) {
      const m = d.match(/^(로|길)\s*(\d+(?:-\d+)?)\s*(.*)$/);
      if (m) {
        const [, suffix, num, rest] = m;
        parsed.address = `${a}${suffix} ${num}`;
        parsed.address_detail = rest.trim() || null;
      }
    }
  }
  return parsed;
}

// opts.author / opts.rawBody 를 주면 자유 형식 부록을 붙일지 스스로 판단한다.
// 주지 않으면(AI 붙여넣기 경로) 지금까지와 완전히 동일하게 동작한다.
//
// system 을 블록 배열로 넘긴다. 공통 프롬프트를 항상 첫 블록에 두는 게 중요하다 —
// 나중에 프롬프트 캐시를 다시 붙일 때 두 변형이 같은 접두사를 공유하게 된다.
async function aiParseText(text, opts = {}) {
  // prepass는 호출자(OrderInput.jsx)에서 명시적으로 적용 — preprocessOrderText export 사용.
  // normalizeParsed의 합입금/무료나눔 정규식 매칭은 입력받은 text 그대로 사용.
  const freeform = !!opts.author && FREEFORM_AUTHORS.has(String(opts.author).trim());
  const system = freeform
    ? [{ type: "text", text: PARSE_SYSTEM }, { type: "text", text: FREEFORM_ADDENDUM }]
    : PARSE_SYSTEM;
  const d = await aiCallAPI([{role:"user",content:text}], system);
  return normalizeParsed(parseAiJson(d), text);
}

async function aiParseImage(base64, mimeType) {
  const d = await aiCallAPI([{role:"user",content:[
    {type:"image",source:{type:"base64",media_type:mimeType,data:base64}},
    {type:"text",text:"이 이미지에서 원단 주문 정보를 추출해서 JSON으로 반환하세요."},
  ]}], PARSE_SYSTEM);
  // 이미지는 원문 텍스트가 없어 sourceText 빈값. AI가 추출한 combinedPayment 플래그만으로 판단.
  return normalizeParsed(parseAiJson(d), "");
}

// ── atoms ────────────────────────────────────────────────────
export { G, GL, SF, S, REWARDS_DATA, baseInp, uid, nowT, dlXlsx, sC, pC, getPayStatus, isHold, isParked, isFabricMissing, missingItemIdx, fabricWaitMins, maskPhone, stripCardDup, aiParseText, aiParseImage, ThemeCtx, useTheme };
// preprocessOrderText는 위에서 inline export 됨 (export function preprocessOrderText...).
