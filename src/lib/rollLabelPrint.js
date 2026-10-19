// 롤 라벨 인쇄 — 검단을 마친 롤에 붙이는 QR 라벨.
//
// 인계 라벨(labelPrint.js)과 같은 프린터·같은 용지·같은 방식이다. 내용물만 다르다.
// 방향이 틀어지거나 크기가 안 맞을 때 볼 것은 labelPrint.js 머리말에 적혀 있다 —
// 규칙은 하나다: **@page 는 드라이버 '종이' 칸과 똑같이 준다.**
//
// QR 에 들어가는 값은 롤 정보 화면 주소다 — https://info.lowhigh-market.com/r/{roll_code} (2026-10-02 변경, 고객용 브랜드 주소).
// 핸드폰 카메라로 찍으면 원단·남은 길이·가격이 열리고(방문 고객용), 포장대 스캐너는 이 주소를 키보드처럼
// 그대로 입력한다 — packing.normalizeScan 이 끝의 롤 번호만 떼어 읽는다. 그 전에 뽑은 라벨(번호만 든 QR)도 읽힌다.
// 라벨에 사람이 읽는 롤 번호는 그대로 찍는다(QR 이 안 읽힐 때 손으로 친다).
//
// QR 은 SVG 로 만들어 문서 안에 바로 넣는다. 그림 파일을 따로 불러오면 다 받기 전에
// 인쇄가 나가 QR 자리가 빈 라벨이 나올 수 있다 — 감열지는 되돌릴 수 없다.

import QRCode from "qrcode";
import { fmtLen, rollQrText } from "./rollStock.js";
import { labelManager } from "./labelPrint.js";

const PAGE_W = 80;     // mm — 폭(롤을 가로지르는 방향). 드라이버 '종이' 칸과 같아야 한다
const PAGE_H = 60;     // mm — 길이(피드 방향)
const ROTATE = 0;      // deg — 0 | 90 | -90

// 돌리면 라벨의 가로·세로가 페이지와 뒤바뀐다. 한 곳에서만 정하고 전부 여기서 끌어 쓴다.
const LABEL_W = ROTATE ? PAGE_H : PAGE_W;
const LABEL_H = ROTATE ? PAGE_W : PAGE_H;

// QR 한 변 — 비율이 아니라 mm 로 못 박는다. 스캐너가 읽는 건 글자가 아니라 칸의 크기라,
// 라벨 방향을 바꿨다고 같이 줄어들면 안 된다.
const QR_MM = 28;

// 글자·여백은 라벨 가로폭에 대한 비율로 잡는다 (labelPrint.js 와 같은 방식).
const u = (pct) => `${(LABEL_W * pct / 100).toFixed(2)}mm`;

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 검단일 — 라벨에는 'YY.MM.DD'. 롤은 몇 달씩 창고에 있으므로 연도가 있어야 한다. */
export function shortInspectDate(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(t.getFullYear() % 100)}.${p(t.getMonth() + 1)}.${p(t.getDate())}`;
}

/**
 * 롤 하나 → 라벨에 찍을 글자.
 * 품번 정보를 못 찾아도 라벨은 뽑는다 — QR 과 roll_code 만 있어도 롤을 찾을 수 있다.
 */
export function buildRollLabel(roll, product, company = "") {
  return {
    key: roll.id,
    code: roll.rollCode || "",
    name: `${product?.name || ""}${product?.color ? ` ${product.color}` : ""}`.trim(),
    // 실측 수량. 라벨은 검단 뒤에 뽑으므로 늘 있지만, 없으면 명세서 수량으로 물러선다.
    qty: `${fmtLen(roll.lengthAvailable ?? roll.lengthReceived)}${product?.unit || "마"}`,
    date: shortInspectDate(roll.inspectedAt),
    location: roll.location || "",
    // 품번 담당자 — 창고에서 라벨만 보고 누구 원단인지 알게. 인계 라벨과 같은 표(labelManager)로 이름을 바꾼다.
    manager: labelManager(product?.manager || ""),
    // 단가 — QR 밑에 찍는다(2026-10-12 사용자 요청). 창고에서 라벨만 보고 값을 답하게. 단가가 없으면 빈 줄.
    price: product?.unitPrice > 0 ? `${Number(product.unitPrice).toLocaleString()}원/${product?.unit || "마"}` : "",
    company,
  };
}

function labelHtml(L) {
  return `
  <div class="label">
    <div class="main">
      <div class="left">
        <div class="qr">${L.qrSvg}</div>
        ${L.price ? `<div class="price">${esc(L.price)}</div>` : ""}
      </div>
      <div class="info">
        <div class="code">${esc(L.code)}</div>
        <div class="name">${esc(L.name)}</div>
        <div class="qty">${esc(L.qty)}</div>
        <div class="meta">
          ${L.manager ? `<span class="mgr">${esc(L.manager)}</span>` : ""}
          ${L.date ? `<span>검단 ${esc(L.date)}</span>` : ""}
          ${L.location ? `<span class="loc">${esc(L.location)}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="foot">${esc(L.company)}</div>
  </div>`;
}

function docHtml(labels) {
  const sheets = labels.map(L => `<div class="sheet">${labelHtml(L)}</div>`);
  const xform = ROTATE === 90 ? `translateX(${PAGE_W}mm) rotate(90deg)`
    : ROTATE === -90 ? `translateY(${PAGE_H}mm) rotate(-90deg)`
    : "none";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>롤 라벨</title>
<style>
  /* 감열 프린터는 회색을 못 찍는다 — 전부 검정, 굵게. */
  /* 페이지 크기는 드라이버에 잡힌 값(폭 ${PAGE_W} × 피드 ${PAGE_H})과 같아야 한다. */
  @page { size: ${PAGE_W}mm ${PAGE_H}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#fff; color:#000;
    font-family:'Noto Sans KR','Malgun Gothic',sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { width:${PAGE_W}mm; height:${PAGE_H}mm; position:relative; overflow:hidden;
    page-break-after:always; }
  .sheet:last-child { page-break-after:auto; }
  /* ── 세로 예산 ──────────────────────────────────────────────
     .label 은 overflow:hidden 이라 넘치면 아랫줄이 조용히 잘린다. 줄 높이를 전부
     못 박아 계산으로 확인한다(labelPrint.js 와 같은 이유).

       쓸 수 있는 높이   ${LABEL_H} − 여백 ${u(4.5)}×2            = 52.80mm
       회사명           ${u(4)} × 1.2 + 위여백 ${u(1)}           =  4.64mm
       본문에 남는 높이                                         = 48.16mm

       오른쪽 칸(최악)
         품번           ${u(5.4)} × 1.15 × 2줄                  =  9.94mm
         원단명         ${u(6.4)} × 1.2 × 2줄                   = 12.29mm
         수량           ${u(12)} × 1.05                         = 10.08mm
         검단일·위치     ${u(4.8)} × 1.2 × 2줄                   =  9.22mm
         ──────────────────────────────────────────────────────
         합계                                                  = 41.53mm  (6.63mm 남음)

     왼쪽 칸: QR ${QR_MM}mm + 단가 ${u(5.2)} × 1.2 + 위여백 ${u(1)} = 33.79mm — 본문 높이보다 작다.
     숫자를 키우려면 이 표를 먼저 고쳐 잔여가 음수가 아닌지 보고 나서 만진다. */
  .label { width:${LABEL_W}mm; height:${LABEL_H}mm; padding:${u(4.5)}; overflow:hidden;
    position:absolute; top:0; left:0; transform-origin:0 0; transform:${xform};
    display:flex; flex-direction:column; }
  .main { flex:1; min-height:0; display:flex; align-items:center; gap:${u(3.5)}; }
  /* QR 둘레의 흰 여백(quiet zone)은 SVG 에 넣지 않고(margin:0) 라벨 여백과 옆 칸과의
     간격으로 준다. 그만큼 QR 자체를 크게 찍을 수 있다. */
  .left { flex:none; width:${QR_MM}mm; display:flex; flex-direction:column; align-items:center; }
  .qr { flex:none; width:${QR_MM}mm; height:${QR_MM}mm; }
  .qr svg { display:block; width:100%; height:100%; }
  /* 단가 — QR 바로 밑. QR 폭(28mm) 안에 한 줄로. "12,000원/마" 가 ${u(5.2)} 글자로 약 22mm. */
  .price { margin-top:${u(1)}; font-size:${u(5.2)}; font-weight:800; line-height:1.2; white-space:nowrap;
    max-width:100%; overflow:hidden; }
  .info { flex:1; min-width:0; align-self:stretch; display:flex; flex-direction:column;
    justify-content:space-between; }
  /* 품번은 사람이 읽는 값이다(QR 이 안 읽힐 때 손으로 친다). 글자 폭이 고른 글꼴로 찍어
     0 과 O, 1 과 I 가 헷갈리지 않게 한다. 한 줄에 안 들어가면 '-' 에서 꺾인다. */
  .code { font-family:'Consolas','Courier New',monospace; font-size:${u(5.4)}; font-weight:800;
    line-height:1.15; letter-spacing:-0.02em; overflow-wrap:anywhere;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  /* 원단명이 길면 두 줄까지 줄이고 넘치면 자른다 — 칸 높이가 고정이라 밀리면 안 된다 */
  .name { font-size:${u(6.4)}; font-weight:800; line-height:1.2; word-break:keep-all; overflow-wrap:anywhere;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .qty { font-size:${u(12)}; font-weight:800; line-height:1.05; white-space:nowrap; }
  .meta { display:flex; flex-wrap:wrap; column-gap:${u(2.5)}; font-size:${u(4.8)}; font-weight:700;
    line-height:1.2; max-height:${(LABEL_W * 4.8 / 100 * 1.2 * 2).toFixed(2)}mm; overflow:hidden; }
  /* 위치는 창고에서 이 롤을 제자리에 꽂을 때 보는 값이라 반전으로 띄운다.
     감열지는 색도 회색도 못 찍으니 반전이 유일한 강조다. */
  .loc { background:#000; color:#fff; padding:0 ${u(1.5)}; border-radius:${u(1)}; }
  .mgr { font-weight:800; }
  .foot { flex:none; margin-top:${u(1)}; font-size:${u(4)}; font-weight:700; line-height:1.2;
    white-space:nowrap; overflow:hidden; text-align:right; }
</style></head><body>${sheets.join("")}</body></html>`;
}

// QR 을 SVG 문자열로. 오류 정정은 M(15%) — 롤에 붙은 라벨은 구겨지고 긁힌다.
async function withQr(L) {
  const qrSvg = await QRCode.toString(rollQrText(L.code), { type: "svg", errorCorrectionLevel: "M", margin: 0 });
  return { ...L, qrSvg };
}

async function buildAll(rolls, products, company) {
  const productById = new Map((products || []).map(p => [p.id, p]));
  const labels = (rolls || [])
    .filter(r => r?.rollCode)
    .map(r => buildRollLabel(r, productById.get(r.productId), company));
  return Promise.all(labels.map(withQr));
}

/** 인쇄용 문서 HTML. 인쇄를 띄우지 않고 그대로 그려볼 수 있어야 검증·미리보기가 된다. */
export async function rollLabelDocHtml(rolls, products, { company = "로하이마켓" } = {}) {
  return docHtml(await buildAll(rolls, products, company));
}

/**
 * 롤 라벨 인쇄창을 띄운다. 여러 롤을 한 번에 받아 한 장씩 페이지를 나눈다.
 * 뽑은 장수를 돌려준다(롤 하나 = 한 장). QR 을 만드느라 비동기다.
 *
 * QR 을 못 만들면 던진다 — 부르는 쪽이 출력권을 놓아줘야 다시 뽑을 수 있다.
 * 실제 인쇄 여부(사용자가 취소했는지)는 브라우저가 알려주지 않으므로 확인하지 않는다.
 */
export async function printRollLabels(rolls, products, { company = "로하이마켓" } = {}) {
  const labels = await buildAll(rolls, products, company);
  if (!labels.length) return 0;

  const iframe = document.createElement("iframe");
  // display:none 이면 일부 브라우저가 인쇄를 건너뛴다 — 화면 밖으로 밀어 두는 쪽이 안전하다.
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;";
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  doc.open(); doc.write(docHtml(labels)); doc.close();

  const go = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error("[롤라벨] 인쇄 실패", e);
    } finally {
      // 인쇄 대화창이 닫히기 전에 지우면 내용이 비어 나온다 — 넉넉히 두고 치운다.
      setTimeout(() => iframe.remove(), 60000);
    }
  };
  // 폰트가 로드되기 전에 인쇄하면 글자 크기가 어긋난다
  if (iframe.contentWindow.document.fonts?.ready) {
    iframe.contentWindow.document.fonts.ready.then(go).catch(go);
  } else {
    setTimeout(go, 300);
  }
  return labels.length;
}
