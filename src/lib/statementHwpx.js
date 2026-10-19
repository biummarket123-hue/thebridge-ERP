// 거래명세서 HWPX 생성 — 시안 B (미니멀 스탬프) 디자인.
// A4 세로 용지 상단 절반(210×148.5mm)에 명세서가 들어가며, 여러 주문을 넘기면
// 주문당 1페이지씩(pageBreak) 이어지는 하나의 한글 파일이 된다.
// 합배송 그룹(mergeGroupId, 분리배송 제외)은 한 장으로 병합: 품목을 합치고
// 주문일이 섞이면 품목표에 주문일 열이 추가되며 헤더 주문일은 범위로 표기.
// 발송일은 명세서를 출력하는 당일 날짜. 개인정보 보호: 연락처 가운데 마스킹, 상세주소 미출력.
//
// hwp-convert(htmlToHwpx) 사용 시 주의 (전부 실제로 겪은 제약):
// 1. 태그 사이 공백 텍스트 노드가 있으면 grid→표 변환이 무시됨 → HTML minify 필수.
// 2. 이미지는 원본 px 그대로 그려지고 프레임에 잘림 → natural=표시 크기로 임베드.
//    (로고/도장은 인쇄 전용 에셋, TOTAL 박스는 canvas로 실측 생성)
// 3. 빈 문단(테두리만 있는 div)은 필터로 제거됨 → 구분선은 표 셀 테두리로,
//    빈 줄 스페이서는 zero-width space(&#8203;) 문단으로 (zwsp는 trim에 안 지워짐).
// 4. div 배경색은 블록 자식이 있으면 유실 → 배경 박스는 셀 배경이나 이미지로.
// 5. 일반 <table> 열 너비는 무조건 균등분할 → 생성 후 section0.xml의 cellSz를 직접 패치.
// 6. 한글 폰트가 함초롬바탕으로 고정 → header.xml에서 맑은 고딕으로 치환.
// 7. 셀 hasMargin="0"이면 한글이 cellMargin을 무시 → "1"로 패치해야 padding 적용.
// 8. 떠 있는 개체의 음수 vertOffset(PARA)은 한글이 무시 → 용지(PAPER) 기준 절대값 사용.
import { htmlToHwpx } from "hwp-convert";
import JSZip from "jszip";
import { maskPhone } from "../constants.js";

const THANKS_LINES = [
  "주문해 주셔서 진심으로 감사합니다.",
  "정성껏 준비한 원단, 예쁘게 사용해 주세요.",
];

// 하단 안내 문구 — TOTAL 박스 아래 가는 구분선 밑에 작은 회색 글씨(fine print)로
const NOTICE_LINES = [
  "상품 수령 후 주문 내역과 수량을 먼저 확인해 주세요.",
  "오배송이나 원단 이상이 있는 경우, 재단·세탁 전에 연락 주시면 신속히 처리해 드립니다.",
];

const ZW = "&#8203;"; // zero-width space — 빈 문단 필터를 통과하는 스페이서
const won = n => (Number(n) || 0).toLocaleString("ko-KR");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// "2026. 07. 14." / "2026-07-14" → "20260714"
const dateKey8 = d => String(d || "").replace(/\D/g, "").slice(0, 8);
// "20260714" → "07. 14"
const shortDate = d => {
  const k = dateKey8(d);
  return k.length >= 8 ? `${k.slice(4, 6)}. ${k.slice(6, 8)}` : String(d || "");
};
// "20260714" → "2026. 07. 14"
const fullDate = d => {
  const k = dateKey8(d);
  return k.length >= 8 ? `${k.slice(0, 4)}. ${k.slice(4, 6)}. ${k.slice(6, 8)}` : String(d || "");
};
// 출력 당일 → "2026. 07. 16" (발송일 표기용)
const todayFull = () => {
  const d = new Date();
  return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, "0")}. ${String(d.getDate()).padStart(2, "0")}`;
};

// 주문 고객의 닉네임 — 동명이인은 전화번호 가운데 4자리로 판별 (주문현황 카드와 동일 규칙)
export function resolveNickname(order, customers) {
  const extractMid = p => {
    if (!p) return "";
    const d = String(p).replace(/\D/g, "");
    if (d.length === 4) return d;
    if (d.length >= 10) return d.slice(3, 7);
    return "";
  };
  const list = (customers || []).filter(c => c.name === order.customer);
  if (list.length === 0) return "";
  let matched = list.length === 1 ? list[0] : null;
  if (!matched) {
    const oMid = extractMid(order.phone);
    if (oMid) matched = list.find(c => extractMid(c.phone) === oMid) || null;
  }
  return matched?.nickname?.trim() || "";
}

// 주소 정리 — 상세주소는 둘째 줄로, 없는데 길면 공백 기준 자동 분할
export function splitAddress(address, detail) {
  const a = (address || "").trim();
  const d = (detail || "").trim();
  if (d) return [a, d];
  if (a.length <= 22) return [a, ""];
  const cut = a.lastIndexOf(" ", 22);
  if (cut < 8) return [a, ""];
  return [a.slice(0, cut), a.slice(cut + 1)];
}

export function orderTotal(order) {
  const itemsSum = (order.items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  return order.totalAmount > 0
    ? order.totalAmount
    : itemsSum + (Number(order.shippingFee) || 0) + (Number(order.otherCost) || 0);
}

// 합배송 그룹(분리배송 제외)을 한 단위로 묶는다 — 단위 하나가 명세서 1페이지
export function groupForStatement(orderList) {
  const units = [];
  const idx = new Map();
  for (const o of orderList) {
    const key = o.mergeGroupId && !o.splitShipping ? `g:${o.mergeGroupId}` : `s:${o.id}`;
    if (idx.has(key)) units[idx.get(key)].push(o);
    else { idx.set(key, units.length); units.push([o]); }
  }
  // 단위 내부는 주문일 오름차순 (첫 주문이 대표)
  for (const u of units) u.sort((a, b) => (dateKey8(a.date) + a.id).localeCompare(dateKey8(b.date) + b.id));
  return units;
}

const _assetCache = {};
async function fetchDataUri(path) {
  if (_assetCache[path]) return _assetCache[path];
  const res = await fetch(path);
  if (!res.ok) throw new Error(`이미지(${path})를 불러오지 못했습니다`);
  const blob = await res.blob();
  _assetCache[path] = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("이미지 인코딩 실패"));
    fr.readAsDataURL(blob);
  });
  return _assetCache[path];
}

// TOTAL 검정 박스 — 금액 길이에 딱 맞는 둥근 모서리 박스를 canvas로 그려 이미지화
function makeTotalBoxDataUri(amountText) {
  const label = "TOTAL (KRW)";
  const labelFont = "600 11px 'Malgun Gothic', sans-serif";
  const amtFont = "700 17px 'Malgun Gothic', sans-serif";
  const padX = 16, gap = 14, h = 40, r = 9;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d");
  ctx.font = labelFont;
  const lw = ctx.measureText(label).width;
  ctx.font = amtFont;
  const aw = ctx.measureText(amountText).width;
  canvas.width = Math.ceil(padX * 2 + lw + gap + aw);
  canvas.height = h;
  ctx = canvas.getContext("2d"); // width 변경으로 컨텍스트 상태 초기화됨
  const w = canvas.width;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, w, h, r);
  } else {
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r);
    ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r);
    ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r);
    ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
  }
  ctx.fillStyle = "#1A1A1A";
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.font = labelFont;
  ctx.fillStyle = "#D8D8D2";
  ctx.fillText(label, padX, h / 2 + 1);
  ctx.font = amtFont;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(amountText, padX + lw + gap, h / 2 + 1);
  return { uri: canvas.toDataURL("image/png"), width: w };
}

// 단위(주문 1건 또는 합배송 그룹) 하나의 명세서 블록 HTML (루트 div 제외)
function buildUnitBlock(unit, { nickname, logo, stamp, totalBox }) {
  const rep = unit[0];
  // 그룹이면 값이 비어있는 대표 필드는 다른 멤버에서 보충
  const pick = f => { for (const o of unit) { const v = f(o); if (v && String(v).trim()) return v; } return ""; };

  const allItems = unit.flatMap(o => (o.items || []).map(it => ({ ...it, _date: o.date })));
  const dates = [...new Set(unit.map(o => dateKey8(o.date)).filter(Boolean))].sort();
  const datesMixed = dates.length > 1;
  // 헤더 주문일 — 단일이면 날짜 하나, 섞이면 범위 (같은 해면 뒤쪽은 월·일만)
  let orderDateText;
  if (datesMixed) {
    const a = dates[0], b = dates[dates.length - 1];
    orderDateText = `${fullDate(a)} ~ ${a.slice(0, 4) === b.slice(0, 4) ? shortDate(b) : fullDate(b)}`;
  } else {
    orderDateText = fullDate(rep.date);
  }

  const itemsSum = allItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const shipping = unit.reduce((s, o) => s + (Number(o.shippingFee) || 0), 0);
  const other = unit.reduce((s, o) => s + (Number(o.otherCost) || 0), 0);
  const memo = pick(o => o.deliveryMessage?.trim());
  // 개인정보 보호 — 상세주소는 명세서에 싣지 않음 (긴 기본주소의 자동 줄나눔은 유지)
  const [addr1, addr2] = splitAddress(pick(o => o.address), "");

  const thCss = "background-color:#F4F4F1; border-top:1px solid #C9C9C4; border-bottom:1px solid #C9C9C4; padding:9px 9px; font-size:11px;";
  const tdCss = "border-bottom:1px solid #E3E3DE; padding:17px 9px; font-size:14px;";
  const rows = allItems.map(it => `
    <tr>
      ${datesMixed ? `<td style="${tdCss} text-align:center;"><span style="color:#8A8A84; font-size:12px;">${esc(shortDate(it._date))}</span></td>` : ""}
      <td style="${tdCss}">${esc(it.fabric)}${it.color ? " · " + esc(it.color) : ""}</td>
      <td style="${tdCss} text-align:center;">${esc(it.qty)}${esc(it.unit || "마")}</td>
      <td style="${tdCss} text-align:right;">${won(it.unitPrice)}</td>
      <td style="${tdCss} text-align:right;">${won(it.amount)}</td>
    </tr>`).join("");

  const subs = [`소계 <b>${won(itemsSum)}</b>`, `배송비 <b>${won(shipping)}</b>`];
  if (other > 0) subs.push(`기타 <b>${won(other)}</b>`);

  const lineSp = `<p style="font-size:5px;">${ZW}</p>`; // 받는 분 줄 사이 간격

  return `
    <div style="display:grid; grid-template-columns: 430px 273px;">
      <div>
        <img src="${logo}">
        <p style="font-size:11px; color:#6E6E6A; font-weight:bold; margin-top:8px;">거래명세서 · TRANSACTION STATEMENT</p>
      </div>
      <div>
        <p style="text-align:right; font-size:15px; font-weight:bold; color:#1A1A1A;">#${esc(String(rep.id).slice(0, 8))}${unit.length > 1 ? ` 외 ${unit.length - 1}건` : ""}</p>
        <p style="text-align:right; font-size:12px; color:#55554F;">주문일 ${esc(orderDateText)}</p>
        <p style="text-align:right; font-size:12px; color:#55554F;">발송일 ${esc(todayFull())}</p>
      </div>
    </div>
    <table style="border-collapse:collapse; width:703px;"><tr>
      <td style="border-top:2px solid #1A1A1A; border-bottom:1px solid #1A1A1A; font-size:2px;">${ZW}RULE-MARKER</td>
    </tr></table>
    <img src="${stamp}">
    <div style="display:grid; grid-template-columns: 320px 383px;">
      <div>
        <p style="font-size:11px; color:#55554F; font-weight:bold;">받는 분</p>
        <p style="font-size:8px;">${ZW}</p>
        <p style="font-size:14px;">이름&nbsp;&nbsp;&nbsp;&nbsp;<b>${esc(rep.customer)}${nickname ? " (" + esc(nickname) + ")" : ""}</b></p>
        ${lineSp}
        <p style="font-size:14px;">연락처&nbsp;&nbsp;<b>${esc(maskPhone(pick(o => o.phone)) || "—")}</b></p>
        ${lineSp}
        <p style="font-size:14px;">주소&nbsp;&nbsp;&nbsp;&nbsp;<b>${esc(addr1 || "—")}</b></p>
        ${addr2 ? `${lineSp}<p style="font-size:14px;">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>${esc(addr2)}</b></p>` : ""}
      </div>
      <div>
        <p style="font-size:11px; color:#55554F; font-weight:bold;">배송 메모</p>
        <p style="font-size:8px;">${ZW}</p>
        <p style="font-size:14px;">${esc(memo || "—")}</p>
      </div>
    </div>
    <p style="font-size:6px;">${ZW}</p>
    <table style="border-collapse:collapse; width:703px;">
      <tr>
        ${datesMixed ? `<th style="${thCss} text-align:center;">주문일</th>` : ""}
        <th style="${thCss} text-align:left;">제품명</th>
        <th style="${thCss} text-align:center;">수량</th>
        <th style="${thCss} text-align:right;">단가</th>
        <th style="${thCss} text-align:right;">금액</th>
      </tr>
      ${rows}
    </table>
    <p style="text-align:right; font-size:12px; color:#6E6E6A;">${subs.join(" · ")}</p>
    <p style="font-size:14px;">${ZW}</p>
    <div style="display:grid; grid-template-columns: ${703 - totalBox.width}px ${totalBox.width}px;">
      <div>
        ${THANKS_LINES.map(l => `<p style="font-size:14px; color:#55554F;">${l}</p>`).join("")}
      </div>
      <div>
        <img src="${totalBox.uri}">
      </div>
    </div>
    <p style="font-size:10px;">${ZW}</p>
    <table style="border-collapse:collapse; width:703px;"><tr>
      <td style="border-top:1px solid #D8D8D2; font-size:2px;">${ZW}RULE-MARKER</td>
    </tr></table>
    <p style="font-size:4px;">${ZW}</p>
    ${NOTICE_LINES.map(l => `<p style="font-size:11px; color:#8A8A84;">※&nbsp; ${l}</p>`).join("")}`;
}

// markerText 를 포함하는 모든 <hp:tbl> 블록을 fn 으로 변환
function patchTbls(xml, markerText, fn) {
  let count = 0;
  const out = xml.replace(/<hp:tbl [^>]*>[\s\S]*?<\/hp:tbl>/g, m => {
    if (!m.includes(markerText)) return m;
    count++;
    return fn(m);
  });
  if (count === 0) throw new Error(`명세서 표 패치 실패: ${markerText}`);
  return out;
}

// 균등분할된 열 너비를 colAddr 별 지정 폭(px 비율)으로 재배분
function setColWidths(tblXml, pxWidths) {
  const totalHwp = [...tblXml.matchAll(/<hp:cellAddr colAddr="\d+" rowAddr="0"\/><hp:cellSpan[^>]*\/><hp:cellSz width="(\d+)"/g)]
    .reduce((s, m) => s + Number(m[1]), 0);
  const pxSum = pxWidths.reduce((a, b) => a + b, 0);
  const w = pxWidths.map(p => Math.floor((p / pxSum) * totalHwp));
  w[w.length - 1] += totalHwp - w.reduce((a, b) => a + b, 0);
  return tblXml.replace(/(<hp:cellAddr colAddr="(\d+)" rowAddr="\d+"\/><hp:cellSpan[^>]*\/><hp:cellSz width=")\d+"/g,
    (m, pre, col) => `${pre}${w[Number(col)]}"`);
}

async function postProcess(bytes) {
  const zip = await JSZip.loadAsync(bytes);

  let header = await zip.file("Contents/header.xml").async("string");
  header = header.replaceAll("함초롬바탕", "맑은 고딕").replaceAll("Times New Roman", "맑은 고딕");

  let sec = await zip.file("Contents/section0.xml").async("string");
  // 구분선 표: 행 높이 최소화(140 HWPUNIT ≈ 0.5mm) + 마커 제거
  sec = patchTbls(sec, "RULE-MARKER", t =>
    t.replace(/RULE-MARKER/g, "")
     .replace(/(<hp:cellSz width="\d+" height=")\d+"/g, '$1140"')
     .replace(/(<hp:sz width="\d+" [^>]*height=")\d+"/, '$1140"'));
  // 품목표: 4열(제품명 320|수량 110|단가 128|금액 145) 또는
  // 주문일 열이 붙은 5열(주문일 70|제품명 250|수량 110|단가 128|금액 145)
  // hasMargin="1" 필수 — 0이면 한글이 cellMargin(상하 여백)을 무시하고 기본값(0.5mm)을 씀
  sec = patchTbls(sec, "제품명", t => {
    const cols = [...t.matchAll(/<hp:cellAddr colAddr="\d+" rowAddr="0"\//g)].length;
    const widths = cols === 5 ? [70, 250, 110, 128, 145] : [320, 110, 128, 145];
    return setColWidths(t, widths).replaceAll('hasMargin="0"', 'hasMargin="1"');
  });
  // 감사멘트+TOTAL 그리드: 셀 기본 여백(좌우 1.8mm) 때문에 셀폭=이미지폭인 TOTAL
  // 박스 오른쪽이 잘림 → 여백 0으로 고정해 박스가 표 오른쪽 끝선에 딱 붙게
  sec = patchTbls(sec, "주문해 주셔서", t =>
    t.replaceAll('hasMargin="0"', 'hasMargin="1"')
     .replace(/<hp:cellMargin [^>]*\/>/g, '<hp:cellMargin left="0" right="0" top="0" bottom="0"/>'));
  // 최상단 빈 문단(secPr 홀더)이 한 줄을 차지 → 2px 글자로 줄여 사실상 0줄로
  const tinyId = (header.match(/<hh:charPr id="(\d+)" height="150"/) || [])[1];
  if (tinyId) {
    const p0 = sec.match(/<hp:p [^>]*>[\s\S]*?<\/hp:p>/)[0];
    const p0Patched = p0
      .replace(/(<hp:run charPrIDRef=")\d+("><hp:secPr)/, `$1${tinyId}$2`)
      .replace(/(<hp:lineseg textpos="0" vertpos="0" vertsize=")\d+(" textheight=")\d+(" baseline=")\d+(" spacing=")\d+(")/,
        "$1150$2150$3130$490$5");
    sec = sec.replace(p0, p0Patched);
  }
  // 도장(80px = curSz 6000×6000이 유일)을 떠 있는 개체로 — 매 페이지,
  // 구분선 오른쪽 끝·글 앞으로·용지 기준 8950(실측 피드백으로 수렴한 값)
  let stampCount = 0;
  sec = sec.replace(/<hp:pic [\s\S]*?<\/hp:pic>/g, m => {
    if (!m.includes('<hp:curSz width="6000" height="6000"/>')) return m;
    stampCount++;
    return m
      .replace('textWrap="TOP_AND_BOTTOM"', 'textWrap="IN_FRONT_OF_TEXT"')
      .replace(/<hp:pos [^>]*\/>/, '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="RIGHT" vertOffset="8950" horzOffset="0"/>');
  });
  if (stampCount === 0) throw new Error("명세서 도장 위치 패치 실패");
  // 단위 사이 페이지 나눔 — PGBRK 마커 문단에 pageBreak="1"
  sec = sec.replace(/(<hp:p [^>]*?)pageBreak="0"([^>]*>(?:(?!<hp:p )[\s\S])*?)PGBRK/g, '$1pageBreak="1"$2');

  // mimetype 은 첫 엔트리 + STORED 유지 (HWPX 패키지 규칙)
  const out = new JSZip();
  out.file("mimetype", await zip.file("mimetype").async("uint8array"), { compression: "STORE" });
  for (const name of Object.keys(zip.files)) {
    if (name === "mimetype" || zip.files[name].dir) continue;
    const data = name === "Contents/header.xml" ? header
      : name === "Contents/section0.xml" ? sec
      : await zip.file(name).async("uint8array");
    out.file(name, data, { compression: "DEFLATE" });
  }
  return out.generateAsync({ type: "uint8array" });
}

// 여러 주문 → 합배송 그룹은 한 장으로 병합, 단위당 1페이지짜리 HWPX 하나로 다운로드
export async function downloadStatementsHwpx(orderList, customers) {
  const list = (orderList || []).filter(Boolean);
  if (list.length === 0) throw new Error("출력할 주문이 없습니다");
  const units = groupForStatement(list);
  const [logo, stamp] = await Promise.all([
    fetchDataUri("/lohi-logo-print.png"),
    fetchDataUri("/lohi-stamp-print.png"),
  ]);
  const blocks = units.map(unit => buildUnitBlock(unit, {
    nickname: resolveNickname(unit[0], customers),
    logo,
    stamp,
    totalBox: makeTotalBoxDataUri(won(unit.reduce((s, o) => s + orderTotal(o), 0))),
  }));
  // PGBRK 마커 문단(2px)이 후처리에서 pageBreak="1"이 되어 다음 단위가 새 페이지에서 시작
  const html = (`<div style="width:703px">` + blocks.join(`<p style="font-size:2px;">PGBRK</p>`) + `</div>`)
    .replace(/>\s+</g, "><").trim();
  let bytes = await htmlToHwpx(html, {
    title: units.length === 1 ? `거래명세서 ${units[0][0].id}` : `거래명세서 ${units.length}건`,
    creator: "로하이마켓",
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { left: 12, right: 12, top: 12, bottom: 12, header: 0, footer: 0 },
    },
  });
  bytes = await postProcess(bytes);
  const blob = new Blob([bytes], { type: "application/hwp+zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = units.length === 1
    ? `로하이마켓_거래명세서_${String(units[0][0].id).slice(0, 8)}_${units[0][0].customer || ""}.hwpx`
    : `로하이마켓_거래명세서_${units.length}건.hwpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { orders: list.length, pages: units.length };
}

export async function downloadStatementHwpx(order, customers) {
  return downloadStatementsHwpx([order], customers);
}
