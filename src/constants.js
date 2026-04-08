import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx-js-style";

const REWARDS_DATA = {points:[],free:[],events:[],date:""};
const INIT_DATA = {orders:[],customers:[],monthly:[],online:[],fabrics:[],staff:[]};


const G = {
  bg:"#0D0B09", surface:"#161410", card:"#1E1A16",
  border:"#2E2820", copper:"#C8794A", copperLight:"#E8956A",
  copperGlow:"rgba(200,121,74,0.15)", cream:"#F0E6D6", creamMuted:"#A89880",
  white:"#FFFFFF", green:"#5B9E72", greenBg:"rgba(91,158,114,0.12)",
  red:"#C05A4A", redBg:"rgba(192,90,74,0.12)", yellow:"#C4963A",
  yellowBg:"rgba(196,150,58,0.12)", blue:"#4A7EA8", blueBg:"rgba(74,126,168,0.12)",
  purple:"#8A6AB8",
};
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
  border:`1px solid ${G.border}`, background:G.surface,
  fontFamily:S, fontSize:13, color:G.cream,
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

const sC = s => s==="출고완료" ? [G.green,G.greenBg] : s==="준비중" ? [G.yellow,G.yellowBg] : [G.blue,G.blueBg];
const pC = p => p==="입금완료" ? [G.green,G.greenBg] : [G.red,G.redBg];

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
export { G, SF, S, REWARDS_DATA, INIT_DATA, baseInp, uid, nowT, dlXlsx, sC, pC, aiParseText, aiParseImage };
