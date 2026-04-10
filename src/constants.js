import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import * as XLSX from "xlsx-js-style";

const REWARDS_DATA = {points:[],free:[],events:[],date:""};


const G = {
  bg:"#0D0B09", surface:"#161410", card:"#1E1A16",
  border:"#2E2820", copper:"#C8794A", copperLight:"#E8956A",
  copperGlow:"rgba(200,121,74,0.15)", cream:"#F0E6D6", creamMuted:"#A89880",
  white:"#FFFFFF", green:"#5B9E72", greenBg:"rgba(91,158,114,0.12)",
  red:"#C05A4A", redBg:"rgba(192,90,74,0.12)", yellow:"#C4963A",
  yellowBg:"rgba(196,150,58,0.12)", blue:"#4A7EA8", blueBg:"rgba(74,126,168,0.12)",
  purple:"#8A6AB8",
  trackBg:"rgba(255,255,255,0.06)", subtleBg:"rgba(255,255,255,0.04)",
  cardShadow:"none", cardShadowHover:"none", inputBg:"#161410",
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
  trackBg:"#E5E7EB",       // 트랙 배경 (solid gray)
  subtleBg:"#F3F4F6",      // 미세 배경 구분
  // ── 화이트 전용 확장 ──
  cardShadow:"0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
  cardShadowHover:"0 4px 12px rgba(0,0,0,0.10), 0 2px 4px rgba(0,0,0,0.06)",
  inputBg:"#F9FAFB",       // 입력창 배경 (순백과 미세 구분)
};
const ThemeCtx = createContext(G);
const useTheme = () => useContext(ThemeCtx);
const S = "'Noto Sans KR','Apple SD Gothic Neo',sans-serif";
const SF = "'Noto Serif KR','Apple SD Gothic Neo',serif";
let _n = 100;
const uid = () => `#${String(++_n).padStart(4,"0")}`;
const nowT = () => {
  const d = new Date();
  return { date: d.toLocaleDateString("ko-KR"), time: d.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}) };
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

const sC = (s, T=G) => s==="출고완료" ? [T.green,T.greenBg] : s==="준비중" ? [T.yellow,T.yellowBg] : [T.blue,T.blueBg];
const pC = (p, T=G) => p==="입금완료" ? [T.green,T.greenBg] : [T.red,T.redBg];

const PARSE_SYSTEM = `동대문 원단시장 카카오톡 주문 메시지 분석. 순수 JSON만 반환. 마크다운 없이.
{"customer":"고객명","phone":"전화번호 또는 null","items":[{"fabric":"원단명","color":"색상/번호","qty":숫자}],"payment":"입금완료|미입금","address":"기본주소 또는 null","address_detail":"상세주소 또는 null","links":["URL링크들 배열, 없으면 빈배열"],"note":"메모 또는 null"}

items 파싱 규칙 (매우 중요):
- 여러 색상/번호가 묶여 있으면 반드시 각각 개별 항목으로 분리해라. 절대 합치지 마라.
- "1,2번각 3마씩" → items 2개: {fabric:"린넨코튼",color:"1번",qty:3}, {fabric:"린넨코튼",color:"2번",qty:3}
- "화이트,베이지 각 5마" → items 2개: {color:"화이트",qty:5}, {color:"베이지",qty:5}
- "1~4번 각 2마씩" → items 4개: {color:"1번",qty:2}, {color:"2번",qty:2}, {color:"3번",qty:2}, {color:"4번",qty:2}
- 총수량이 아닌 개별 수량을 기준으로 파싱해라

메모(note) 규칙:
- 구조화된 필드(고객명, 전화번호, 주소, items, links)에 들어가지 않는 모든 원문 정보를 메모에 담아라
- 특히 다음을 반드시 메모에 포함:
  1) 첫 줄 제목/헤더 (예: "P)4/6 밴드주문-미송님과합배")
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
이미지인 경우 화면에서 주문 정보를 직접 읽어서 파싱하세요.`;

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
        model:"claude-haiku-4-5-20251001", max_tokens:1024,
        system: system || "",
        messages,
      }),
    });
    const d = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(d.error?.message || `API 오류 (${res.status})`);
    return d;
  }
  const res = await fetch("/api/analyze", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ system, messages }),
  });
  const d = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(d.error?.message || `API 오류 (${res.status})`);
  return d;
}

async function aiParseText(text) {
  const d = await aiCallAPI([{role:"user",content:text}], PARSE_SYSTEM);
  return JSON.parse((d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim());
}

async function aiParseImage(base64, mimeType) {
  const d = await aiCallAPI([{role:"user",content:[
    {type:"image",source:{type:"base64",media_type:mimeType,data:base64}},
    {type:"text",text:"이 이미지에서 원단 주문 정보를 추출해서 JSON으로 반환하세요."},
  ]}], PARSE_SYSTEM);
  return JSON.parse((d.content?.[0]?.text||"{}").replace(/```json|```/g,"").trim());
}

// ── atoms ────────────────────────────────────────────────────
export { G, GL, SF, S, REWARDS_DATA, baseInp, uid, nowT, dlXlsx, sC, pC, aiParseText, aiParseImage, ThemeCtx, useTheme };
