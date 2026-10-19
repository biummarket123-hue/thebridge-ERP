// 원단 인계 라벨 인쇄 — 셀러가 손으로 쓰던 쪽지를 대신한다.
//
// 쪽지가 하던 일(사용자 확인):
//   포장직원은 셀러 얼굴을 알기 때문에 '누구 건인지'는 쪽지가 없어도 안다.
//   쪽지가 실제로 필요한 이유는 **이 원단이 등록된 주문의 그 원단이 맞는지,
//   수량이 얼마인지** 대조하기 위해서다. 그 내용은 ERP에 이미 다 들어 있으므로
//   손으로 옮겨 적는 단계가 통째로 중복이었다.
//
// 인쇄 방식:
//   Rongta PS100(감열 라벨 프린터)을 윈도우 프린터로 설치해 두고 브라우저 인쇄로 보낸다.
//   웹앱에서 프린터에 직접 명령(TSPL/ESC-POS)을 쏘려면 로컬 프로그램을 따로 깔아야 한다.
//
//   숨긴 iframe 에 따로 문서를 만들어 인쇄한다. 앱 화면을 그대로 인쇄하지 않는 이유는
//   .erp-root 에 zoom(글자 크기 설정, 0.80~1.30)이 걸려 있어서다 — 그대로 두면
//   글자 크기 설정에 따라 라벨 크기가 달라진다. iframe 은 별개 문서라 영향이 없다.
//
// 용지: 감열지 한 장에 라벨 하나.
//
// 처음엔 100×120 용지에 60mm 라벨 두 칸을 넣고 반으로 잘라 썼는데, 자르는 손이
// 매번 들어가는 게 결국 쪽지를 없앤 이유와 어긋났다. 지금은 한 장이 곧 라벨
// 하나라 자를 일이 없다 — 뽑아서 그대로 붙인다.
//
// ── 방향 ──────────────────────────────────────────────────────
// 방향이 세 번 틀어졌는데, 원인은 전부 CSS 가 아니라 **윈도우 드라이버의
// '종이' 칸에 등록된 용지 크기**였다. 감열지를 80×60 으로 바꾸고 드라이버는
// 예전 값 그대로 둔 상태였다.
//
// 드라이버가 아는 폭보다 @page 가 넓으면 드라이버는 페이지를 통째로 눕혀
// 억지로 맞춘다. 그러면 CSS 를 어떻게 돌려도 따라서 같이 돈다 — 여기서
// 회전을 넣고 빼며 헤맨 게 전부 그 탓이다.
//
// 그래서 규칙은 하나다: **@page 는 드라이버 '종이' 칸과 똑같이 준다.**
// 어긋나면 회전으로 덮지 말고 드라이버부터 고친다.
// (오프셋 칸은 위치를 미는 값이라 크기 문제를 못 고친다. 밀린 만큼 반대쪽이 잘린다)
//
// 방향을 눈으로 확인하는 법: 브라우저 머리글(날짜·시간·문서 제목)은 페이지
// 방향 그대로 찍힌다. 머리글이 가로면 페이지는 바로 서 있는 것이다.
//
// 그래도 틀어지면 ROTATE 한 줄만 만진다:
//   0   페이지 방향 그대로 (지금)
//   90  시계방향 / -90 반시계
// 라벨 칸 크기와 글자 크기는 ROTATE 를 따라 저절로 맞춰진다.
//
// ※ 인쇄 대화창의 '머리글/바닥글'은 꺼 두는 게 맞다. 날짜·시간이 라벨 위쪽을
//    차지해 그만큼 내용이 밀린다.

import QRCode from "qrcode";
import { isHold } from "../constants.js";
import { itemQrText } from "./packing.js";

const PAGE_W = 80;     // mm — 폭(롤을 가로지르는 방향). 드라이버 '종이' 칸과 같아야 한다
const PAGE_H = 60;     // mm — 길이(피드 방향)
const ROTATE = 0;      // deg — 0 | 90 | -90

// ── 품목 QR (2026-10-08) ──────────────────────────────────────
// 라벨 오른쪽 위에 품목 QR 이 붙는다. 포장직원이 이걸 찍으면 "어느 주문의 어느 품목"이 바로 잡혀
// 같은 원단을 기다리는 박스가 여럿이어도 다른 박스에 기록될 일이 없다(lib/packing.js 주문 라벨 QR 절).
// 값은 "OI:" + 품목 id — 대문자·숫자뿐이라 QR 이 영숫자 모드(25칸)로 찍혀 16mm 면 충분히 읽힌다.
// 롤 라벨(28mm)보다 작은 이유: 이 라벨은 세로가 빠듯하다(아래 세로 예산). 머리 부분(날짜+이름 줄)의
// 높이가 16.14mm 라 그 안에 들어가는 크기로 못 박았다 — 세로 예산을 안 건드린다.
// 옛 주문(품목 id 없음)과 품번이 안 이어진 품목은 QR 없이 나온다. QR 을 못 만들어도 라벨은 나온다(QR 만 빈다).
const QR_MM = 16;

// 돌리면 라벨의 가로·세로가 페이지와 뒤바뀐다. 한 곳에서만 정하고 전부 여기서 끌어 쓴다.
const LABEL_W = ROTATE ? PAGE_H : PAGE_W;
const LABEL_H = ROTATE ? PAGE_W : PAGE_H;

// 글자·여백은 라벨 가로폭에 대한 비율로 잡는다. 80mm 로 눕든 60mm 로 서든
// 같은 균형이 나오고, 방향을 바꿀 때 숫자를 하나씩 다시 재지 않아도 된다.
const u = (pct) => `${(LABEL_W * pct / 100).toFixed(2)}mm`;

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 라벨에 찍을 담당자 이름 (2026-08-19).
 *
 * ERP 안에서 쓰는 호칭과 라벨에 나가는 이름을 갈랐다. 라벨은 포장대와 창고를
 * 거쳐 물건에 붙어 다니는 종이라 부르는 이름이 따로 있다.
 *
 * **여기서만 바꾼다.** 주문현황·포장탭·정산·대시보드·엑셀은 전부 원래 이름
 * 그대로다 — DB 에 저장되는 값도 안 건드린다. 라벨을 그리는 순간에만 갈아 끼운다.
 *
 * 표에 없는 이름(방문고객·마켓24, 나중에 들어올 담당자)은 손대지 않고 그대로
 * 찍는다. 담당자가 바뀌면 이 표만 고치면 된다.
 *
 * ※ '실장님 → 옥정점' 은 옥정점이라는 담당자가 따로 있는데도 일부러 같은
 *    이름을 쓴 것이다(사용자 지정). 그래서 둘은 라벨에서 구분되지 않는다.
 */
const LABEL_MANAGER = {
  "고문님": "매니저",
  "실장님": "옥정점",
  "장향숙": "장부장",
  "송미송": "송희",
  "손희우": "희우",
};

export function labelManager(name) {
  const n = String(name || "").trim();
  return LABEL_MANAGER[n] || n;
}

/** 전화 가운데 4자리 — 동명이인을 가르는 이 가게의 관행. 풀번호는 라벨에 안 적는다. */
export function midPhone(phone) {
  const c = String(phone || "").replace(/\D/g, "");
  if (c.length >= 10) return c.slice(3, 7);
  if (c.length === 4) return c;
  return "";
}

/**
 * 등록일 — 라벨에는 '8/19' 처럼 월/일만 적는다.
 *
 * 연도를 뺀 건 자리 때문이 아니라, 라벨이 등록 직후에 뽑히기 때문이다.
 * 해를 넘긴 건이 라벨을 달고 돌아다니는 경우가 드물어 월/일만으로 안 헷갈린다.
 * (몇 달 묵는 보관 건은 라벨이 아니라 ERP 에서 본다 — 거기엔 연도가 다 있다)
 *
 * order.date 는 "2026. 08. 19." 꼴이다(constants.js 의 nowT).
 * 그 꼴이 아니면 createdAt 으로 물러선다 — 옛 주문이 여기로 온다.
 */
export function shortDate(order) {
  const m = String(order?.date || "").match(/([0-9]{4})[^0-9]+([0-9]{1,2})[^0-9]+([0-9]{1,2})/);
  if (m) return `${+m[2]}/${+m[3]}`;
  const t = order?.createdAt ? new Date(order.createdAt) : null;
  return t && !isNaN(t) ? `${t.getMonth() + 1}/${t.getDate()}` : "";
}

/**
 * 라벨 한 장 = 원단 하나.
 * @param order 대상 주문
 * @param allOrders 전체 주문 (합배송 상대를 찾는 데 쓴다)
 */
export function buildLabels(order, allOrders = []) {
  // 합배송은 고객이 늘 같고 담당자가 다르다(실데이터 44묶음 중 35묶음).
  // 그래서 '누구와 함께 나가는지'는 상대 셀러 이름으로 적는다.
  //
  // 자기 이름은 뺀다. 한 셀러가 같은 고객의 주문 여러 건을 묶은 경우(9묶음)
  // 그대로 두면 "고문님 건과 함께"를 고문님이 읽게 되어 아무 정보가 안 된다.
  // 그때는 이름 대신 몇 건짜리 박스인지만 적는다.
  const group = order.mergeGroupId
    ? allOrders.filter(o => o.mergeGroupId === order.mergeGroupId)
    : [];
  // 합배송 상대도 담당자 칸과 같은 표를 거친다. 한쪽만 바꾸면 한 라벨 안에
  // "송희"(담당자)와 "송미송님과 함께"(합배송)가 나란히 찍혀 오히려 더 헷갈린다.
  //
  // 자기 이름 빼기는 바꾼 뒤의 이름으로 견준다. 실장님과 옥정점이 같은 '옥정점'
  // 으로 찍히는데 원래 이름으로 견주면, 옥정점이 실장님과 묶였을 때 자기 라벨에서
  // "옥정점님과 함께"를 읽게 된다 — 이 줄이 없애려던 바로 그 상황이다.
  // 바꾼 이름으로 견주면 서로를 자기 자신으로 보고 빠져 '합배송 2건' 으로 떨어진다.
  // 이름은 못 적지만 틀린 말은 아니다.
  const me = labelManager(order.manager);
  const mates = [...new Set(group
    .map(o => labelManager(o.manager))
    .filter(m => m && m !== me))];
  const groupSize = group.length;

  // 묶기 전 합배송 — 메모에 "합배", "OOO님 합" 이 있어 combinedShipping 이 붙었지만
  // 아직 주문현황에서 묶지 않은 건이다. 상대를 모르니 이름은 못 적지만, 포장직원이
  // "이건 따로 나가는 게 아니다"를 알아야 박스를 성급히 닫지 않는다.
  // 실제로 묶인 건은 위에서 이미 상대·건수를 적으므로 여기까지 오지 않는다.
  const combined = !!order.combinedShipping;

  // 보관 — 이 원단은 나가지 않고 창고 선반으로 간다. 요청 단계든 이미 넣은 뒤든
  // 라벨을 든 사람이 할 일은 같으므로 한 가지로 적는다.
  const hold = isHold(order);

  return (order.items || []).map((it, i) => ({
    key: `${order.id}:${i}`,
    date: shortDate(order),
    customer: order.customer || "",
    phone: midPhone(order.phone),
    itemId: it.itemId || null,
    // 품번(2026-10-08 사용자 요청) — 주문 저장 때 품번이 이어진 품목은 itemNo 에 품번이 들어 있다. 롤 라벨의 품번과 맞춰 본다.
    code: it.itemNo || "",
    // 품번이 이어진 품목만 QR 을 찍는다(2026-10-08 사용자 결정). 품번 없는 품목은 QR 을 찍어도 뺄 롤이 없어 거부만
    // 뜨니, 아예 안 찍어 "QR 있으면 스캔, 없으면 롤 없이 포장"으로 가른다.
    linked: !!(it.productId || it.itemNo),
    manager: labelManager(order.manager),
    fabric: `${it.fabric || ""}${it.color ? ` ${it.color}` : ""}`.trim(),
    qty: `${it.qty ?? ""}${it.unit || "마"}`,
    seq: (order.items || []).length > 1 ? `${i + 1}/${order.items.length}` : "",
    mates, groupSize, combined, hold,
  }));
}

function labelHtml(L) {
  return `
  <div class="label">
    <div class="head">
      <div class="headL">
        <div class="date"><span>${esc(L.date)}</span><span class="mgr">${esc(L.manager)}</span></div>
        <div class="row1">
          <span class="cust">${esc(L.customer)}</span>
          ${L.phone ? `<span class="phone">${esc(L.phone)}</span>` : ""}
        </div>
      </div>
      ${L.qrSvg ? `<div class="qr">${L.qrSvg}</div>` : ""}
    </div>
    <div class="row2">
      <span class="fabric">${esc(L.fabric)}</span>
      <span class="qty">${esc(L.qty)}</span>
    </div>
    <div class="row3">
      ${L.code ? `<span class="pcode">${esc(L.code)}</span>` : ""}
      ${L.hold ? `<span class="hold">📦 보관</span>` : ""}
      ${L.mates.length
        ? `<span class="merge">📦 합배송 · ${esc(L.mates.join("·"))}님과 함께</span>`
        : L.groupSize > 1
          ? `<span class="merge">📦 합배송 ${L.groupSize}건</span>`
          : L.combined
            ? `<span class="merge">📦 합배송</span>`
            : `<span></span>`}
      ${L.seq ? `<span class="seq">${esc(L.seq)}</span>` : ""}
    </div>
  </div>`;
}

// 품목 QR 을 SVG 로 문서 안에 바로 넣는다(그림 파일을 따로 부르면 다 받기 전에 인쇄가 나갈 수 있다 — 감열지는 되돌릴 수 없다).
// 오류 정정 M — 조각에 붙어 포장대까지 가는 종이라 많이 구겨지지는 않지만 손은 탄다.
// 못 만들면 QR 없이 뽑는다 — 라벨이 아예 안 나오는 것보다 낫고, 롤 QR 을 먼저 찍는 옛 흐름으로 포장은 된다.
async function withQr(L) {
  if (!L.itemId || !L.linked) return { ...L, qrSvg: "" };
  try {
    const qrSvg = await QRCode.toString(itemQrText(L.itemId), { type: "svg", errorCorrectionLevel: "M", margin: 0 });
    return { ...L, qrSvg };
  } catch (e) {
    console.warn("[라벨] 품목 QR 생성 실패 — QR 없이 뽑는다", L.key, e);
    return { ...L, qrSvg: "" };
  }
}

/** 인쇄용 문서 HTML. 인쇄를 띄우지 않고 그대로 그려볼 수 있어야 검증·미리보기가 된다. QR 을 만드느라 비동기다. */
export async function labelDocHtml(order, allOrders = []) {
  return docHtml(await Promise.all(buildLabels(order, allOrders).map(withQr)));
}

function docHtml(labels) {
  // 라벨 하나가 곧 한 장이다. 채우다 남는 칸이 없으니 빈 칸을 넣을 일도 없다.
  const sheets = labels.map(L => `<div class="sheet">${labelHtml(L)}</div>`);
  // ROTATE 가 0 이면 라벨을 그대로 얹는다 — 페이지 방향이 곧 라벨 방향이다.
  // 돌릴 때는 원점을 왼쪽 위에 두므로 라벨이 페이지 밖으로 나간다. 90도(시계)는
  // 왼쪽으로 나가니 폭만큼 오른쪽으로, -90 은 위로 나가니 길이만큼 아래로 되돌린다.
  const xform = ROTATE === 90 ? `translateX(${PAGE_W}mm) rotate(90deg)`
    : ROTATE === -90 ? `translateY(${PAGE_H}mm) rotate(-90deg)`
    : "none";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>원단 라벨</title>
<style>
  /* 감열 프린터는 회색을 못 찍는다 — 전부 검정, 굵게. 옅은 색은 아예 안 나온다. */
  /* 페이지 크기는 드라이버에 잡힌 값(폭 ${PAGE_W} × 피드 ${PAGE_H})과 같아야 한다.
     다르게 주면 브라우저가 용지와 안 맞는다고 보고 축소하거나 통째로 눕힌다. */
  @page { size: ${PAGE_W}mm ${PAGE_H}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#fff; color:#000;
    font-family:'Noto Sans KR','Malgun Gothic',sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { width:${PAGE_W}mm; height:${PAGE_H}mm; position:relative; overflow:hidden;
    page-break-after:always; }
  .sheet:last-child { page-break-after:auto; }
  /* 라벨 칸은 ${LABEL_W} × 세로 ${LABEL_H}. 자르는 선은 없다(한 장이 곧 라벨 하나).

     글자를 전체적으로 키웠다(2026-08-14). 세로로 남던 공간을 글자로 돌린 것이다.
     여백은 조금 좁혀(5% → 4.5%) 가로로도 자리를 벌었다.

     ── 세로 예산 ──────────────────────────────────────────────
     날짜(2026-08-19)와 합배송 두 줄(2026-08-19)이 들어오면서 세로가 빠듯해졌다.
     .label 은 overflow:hidden 이라 넘치면 아랫줄이 조용히 잘린다 — 잘린 걸
     알아채는 방법이 종이를 보는 것뿐이라, 넘치지 않는다는 걸 계산으로 못 박는다.

     그래서 줄 높이(line-height)를 전부 못 박았다. 브라우저 기본값(normal)은
     글꼴마다 달라서 예산을 세울 수가 없다 — 라벨 PC 의 글꼴이 바뀌면 계산이
     통째로 어긋난다.

       쓸 수 있는 높이   ${LABEL_H} − 여백 ${u(4.5)}×2       = 52.80mm
       날짜+담당자      ${u(7)} × 1.1 + 아래여백 ${u(1)}    =  6.96mm  (담당자 글자가 날짜보다 커서 그 높이)
       이름 줄          ${u(10.5)} × 1.25                  = 10.50mm
       원단 칸          테두리 1.0 + 안여백 4.8 + 글자 ${u(9.5)}×1.15×2줄
                                                          = 23.28mm
       아랫줄 두 줄     ${u(6)} × 1.2 × 2줄                =  11.52mm
       ────────────────────────────────────────────────────────
       최악의 경우 합계                                     = 52.26mm  (0.54mm 남음)

     한 줄로 끝나는 보통 건은 여기서 5.76mm 를 더 던다. 위 숫자 중 하나라도
     키우려면 이 표를 먼저 고쳐 잔여가 음수가 아닌지 보고 나서 만진다. */
  .label { width:${LABEL_W}mm; height:${LABEL_H}mm; padding:${u(4.5)}; overflow:hidden;
    position:absolute; top:0; left:0; transform-origin:0 0; transform:${xform};
    display:flex; flex-direction:column; justify-content:space-between; }
  /* 등록일은 고객명 위에 얹는다. 아랫줄(보관·합배송·순번)은 이미 세 덩어리가
     자리를 다투는데 거기에 넷째를 넣으면 합배송 문구가 그만큼 더 잘린다.
     위쪽은 가로로 비어 있어 아무것도 밀어내지 않는다.
     선반에 놓인 라벨을 훑을 때 날짜가 늘 같은 자리에 있는 것도 이 편이 낫다. */
  /* 머리: 왼쪽은 날짜·전화와 이름 줄, 오른쪽은 품목 QR. QR 은 머리 높이(16.14mm) 안에 들어가는
     크기라 세로 예산이 그대로다. 왼쪽 글자와 QR 사이 ${u(3)} 는 QR 의 흰 여백(quiet zone)이기도 하다 —
     QR 둘레 여백은 SVG 에 안 넣고(margin:0) 라벨 여백과 이 간격으로 준다.
     QR 이 가로 16mm 를 가져가서 이름 줄에 이름·전화·담당자를 다 두면 세 자 이름도 말줄임이 된다.
     전화 가운데 자리는 이름 옆에 그대로 두고(사용자 지시 2026-10-08 — 동명이인을 가르는 자리라 이름과
     붙어 있어야 한다), 담당자를 날짜 줄 오른쪽으로 올렸다. 날짜 줄은 가로가 거의 비어 있었다.
     이름 줄 = 이름 + 전화(≈ 네 자 이름까지 그대로), 날짜 줄 = 날짜 + 담당자. */
  .head { display:flex; align-items:flex-start; gap:${u(3)}; }
  .headL { flex:1; min-width:0; display:flex; flex-direction:column; }
  .qr { flex:none; width:${QR_MM}mm; height:${QR_MM}mm; }
  .qr svg { display:block; width:100%; height:100%; }
  /* 감열지엔 회색이 없어 '연하게'가 안 된다 — 작고 좁게 만드는 것이 유일한 방법이다.
     본론(이름·원단)보다 뒤로 물러나되 읽히기는 해야 하므로 여기서 더 줄이지 않는다. */
  .date { display:flex; align-items:baseline; gap:${u(2)}; font-size:${u(5.5)}; font-weight:700; letter-spacing:0.02em;
    line-height:1.1; margin-bottom:${u(1)}; }
  .row1 { display:flex; align-items:baseline; gap:${u(2.5)}; line-height:1.25; }
  /* 이름이 길면 담당자를 밀어내는 대신 이름 쪽을 줄인다 — 이름 네 자까지는
     그대로 들어가고, 그보다 길 때만 말줄임이 붙는다. 글자를 키운 뒤로
     한 줄이 꽉 차서 이 장치가 없으면 담당자가 칸 밖으로 나간다. */
  .cust { flex:0 1 auto; min-width:0; font-size:${u(10.5)}; font-weight:800;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .phone { flex-shrink:0; font-size:${u(7)}; font-weight:700; }
  .mgr { flex-shrink:0; margin-left:auto; padding-left:${u(2)}; font-size:${u(7)}; font-weight:700; }
  .row2 { display:flex; align-items:center; gap:${u(3)}; border:0.5mm solid #000;
    border-radius:1.5mm; padding:${u(3)} ${u(3.3)}; }
  /* 원단명이 길면 두 줄까지 줄이고 넘치면 자른다 — 칸 높이가 고정이라 밀리면 안 된다 */
  .fabric { flex:1; min-width:0; font-size:${u(9.5)}; font-weight:800; line-height:1.15;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .qty { flex-shrink:0; font-size:${u(13)}; font-weight:800; }
  .row3 { display:flex; align-items:baseline; gap:${u(2.5)}; font-size:${u(6)}; font-weight:700;
    min-height:${u(6)}; line-height:1.2; }
  /* 보관은 '나가지 않는다'는 뜻이라 나머지 글자와 같은 무게면 그냥 지나친다.
     감열지는 색도 회색도 못 찍으니 반전(검정 바탕에 흰 글자)이 유일한 강조다. */
  .hold { flex-shrink:0; background:#000; color:#fff; padding:${u(0.8)} ${u(2)};
    border-radius:${u(1.2)}; }
  /* 합배송 문구는 상대가 여럿이면 길어진다. 한 줄에 가두고 말줄임으로 잘랐더니
     정작 중요한 상대 이름이 "미송·은재…" 처럼 날아갔다 — 누구와 함께 나가는지가
     이 줄의 전부인데 그걸 잘라 버리면 줄을 적을 이유가 없다.

     그래서 자리가 모자라면 두 줄까지 내려 쓴다. 원단명(.fabric)이 쓰는 것과 같은
     장치다. 두 줄로도 모자라면 그때는 자른다 — 세로 예산이 거기까지다(위 표).

     보관 칩과 순번은 첫 줄에 그대로 있는다. 줄바꿈이 일어나는 건 이 문구 안쪽뿐이라
     오른쪽 순번(1/3)이 칸 밖으로 밀려 사라질 일은 여전히 없다.

     낱말 중간에서 꺾이면 "미송·은재님과 함 / 께" 처럼 읽히니 keep-all 로 막는다. */
  .merge { flex:0 1 auto; min-width:0; word-break:keep-all;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .seq { flex-shrink:0; margin-left:auto; padding-left:${u(2)}; }
  /* 품번 — 아랫줄 맨 앞. 롤 라벨의 품번과 같은 글꼴이라 창고에서 둘을 맞춰 보기 쉽다. 아랫줄은 두 줄까지 허용돼
     있어(합배송 문구) 세로 예산은 그대로다. 품번이 길어지면 합배송 문구가 그만큼 먼저 줄바꿈된다. */
  .pcode { flex-shrink:0; font-family:'Consolas','Courier New',monospace; font-size:${u(6)}; font-weight:800; letter-spacing:0.02em; }
</style></head><body>${sheets.join("")}</body></html>`;
}

/**
 * 라벨 인쇄창을 띄운다. 성공하면 인쇄한 장수를 돌려준다(비동기 — 품목 QR 을 먼저 만든다).
 * 실제 인쇄 여부(사용자가 취소했는지)는 브라우저가 알려주지 않으므로 확인하지 않는다.
 */
export async function printFabricLabels(orderOrList, allOrders = []) {
  // 여러 주문을 한 번에 받으면 라벨을 이어붙여 한 번에 뽑는다 —
  // 원단 개수가 곧 장수다. 품목 QR 을 만드느라 비동기다(2026-10-08).
  const list = Array.isArray(orderOrList) ? orderOrList : [orderOrList];
  const labels = await Promise.all(list.flatMap(o => buildLabels(o, allOrders)).map(withQr));
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
      console.error("[라벨] 인쇄 실패", e);
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

// ── 감사 라벨(💌) ─────────────────────────────────────────────
// 선물 상자에 붙이는 라벨. 디자인은 public/thankyou-label1.png 한 장(1448×1086, 80:60 과 같은 비율)에
// 문구까지 다 들어 있어서, 글자를 따로 얹지 않고 그림을 통째로 찍는다.
// 용지·방향·인쇄 방식은 원단 라벨과 똑같다(같은 PS100, 같은 @page). 그림은 가장자리 1.5mm 를
// 비우고 비율을 지켜 넣는다 — 용지가 조금씩 밀려서 끝까지 채우면 잘린다.
const THANKS_IMG = "/thankyou-label1.png";   // 2026-10-07 사용자가 파일을 바꿈(옛 thankyou-label.png 는 지움)
const THANKS_PAD = 1.5; // mm

function thanksDocHtml(count) {
  const xform = ROTATE === 90 ? `translateX(${PAGE_W}mm) rotate(90deg)`
    : ROTATE === -90 ? `translateY(${PAGE_H}mm) rotate(-90deg)`
    : "none";
  const sheets = Array.from({ length: count }, () =>
    `<div class="sheet"><div class="label"><img src="${THANKS_IMG}" alt=""></div></div>`);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>감사 라벨</title>
<style>
  @page { size: ${PAGE_W}mm ${PAGE_H}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#fff; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .sheet { width:${PAGE_W}mm; height:${PAGE_H}mm; position:relative; overflow:hidden; page-break-after:always; }
  .sheet:last-child { page-break-after:auto; }
  .label { width:${LABEL_W}mm; height:${LABEL_H}mm; padding:${THANKS_PAD}mm; overflow:hidden;
    position:absolute; top:0; left:0; transform-origin:0 0; transform:${xform};
    display:flex; align-items:center; justify-content:center; }
  img { width:100%; height:100%; object-fit:contain; display:block; }
</style></head><body>${sheets.join("")}</body></html>`;
}

/**
 * 감사 라벨을 count 장 뽑는다. 원단 라벨과 같은 숨긴 iframe 방식.
 * 그림이 다 내려오기 전에 인쇄하면 빈 종이가 나오므로, 모든 img 가 로드된 뒤에 print() 를 부른다.
 * 돌려주는 값은 장수.
 */
export function printThanksLabels(count) {
  const n = Math.max(0, parseInt(count) || 0);
  if (!n) return 0;
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;border:0;";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open(); doc.write(thanksDocHtml(n)); doc.close();

  const go = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      console.error("[감사라벨] 인쇄 실패", e);
    } finally {
      setTimeout(() => iframe.remove(), 60000);
    }
  };
  const imgs = Array.from(doc.images || []);
  const waits = imgs.map(img => img.complete ? Promise.resolve()
    : new Promise(res => { img.onload = res; img.onerror = res; }));
  // 그림이 끝내 안 오면(경로 오류 등) 3초 뒤에라도 인쇄한다 — 빈 종이가 나와야 뭐가 잘못됐는지 보인다
  Promise.race([Promise.all(waits), new Promise(res => setTimeout(res, 3000))]).then(go, go);
  return n;
}
