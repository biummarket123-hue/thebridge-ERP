// 엑셀 내려받기 공용 — 시트마다 {name, rows:[{열이름: 값}]} 을 받아 xlsx 로 저장한다(xlsx-js-style + constants.dlXlsx).
// 파일명은 회사명으로 만든다(config.companyName) — 고정 문자열은 쓰지 않는다.
import * as XLSX from "xlsx-js-style";
import { dlXlsx } from "../../constants.js";
import { itemsSummary, orderTotal, orderPaid, orderUnpaid } from "./metrics.js";

/** 파일 이름에 못 쓰는 글자를 뺀다 */
export const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, "").trim() || "회사";
export const todayStamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 열 너비 — 각 열의 가장 긴 값 기준(최대 50자) */
function widths(rows, cols) {
  return cols.map(c => ({ wch: Math.min(50, Math.max(8, c.length * 2, ...rows.map(r => String(r[c] ?? "").length * 1.4))) }));
}

/**
 * sheets: [{ name, rows:[{...}], cols?:[열 순서] }], fileName: "xxx.xlsx"
 * rows 가 비면 헤더만 있는 시트가 된다(cols 를 주면). 헤더는 굵게·회색 배경.
 */
export function downloadXlsx({ sheets, fileName }) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets || []) {
    const rows = s.rows || [];
    const cols = s.cols || Array.from(rows.reduce((set, r) => { Object.keys(r).forEach(k => set.add(k)); return set; }, new Set()));
    const ws = XLSX.utils.json_to_sheet(rows, { header: cols });
    ws["!cols"] = widths(rows, cols);
    cols.forEach((_, ci) => {
      const a = XLSX.utils.encode_cell({ r: 0, c: ci });
      if (!ws[a]) ws[a] = { v: cols[ci], t: "s" };
      ws[a].s = { font: { bold: true, sz: 11 }, fill: { fgColor: { rgb: "EEF2F7" } }, alignment: { horizontal: "center" } };
    });
    XLSX.utils.book_append_sheet(wb, ws, String(s.name || "Sheet").slice(0, 31));
  }
  dlXlsx(wb, fileName);
}

const payOf = (o) => o.payment === "환불신청" ? "환불신청" : (o._computed?.paymentStatus || o.payment || "미입금");

/** 주문 → 엑셀 행(품목은 한 줄 요약 + 품목 시트용 펼친 행은 orderItemRows) */
export function orderRows(orders) {
  return (orders || []).map(o => ({
    "주문번호": String(o.id || "").slice(0, 8).toUpperCase(),
    "접수일": o.date || "", "시각": o.time || "",
    "고객": o.customer || "", "연락처": o.phone || "",
    "판매처": o.salesChannel || "직접·밴드", "채널 주문번호": o.channelOrderId || "",
    "품목": itemsSummary(o, 99), "품목 수": (o.items || []).length,
    "주문 금액": orderTotal(o), "배송비": Number(o.shippingFee) || 0,
    "받은 돈": orderPaid(o), "미수금": orderUnpaid(o),
    "결제": payOf(o), "상태": o.status || "", "담당자": o.manager || "",
    "출고예정일": o.shipDate || "", "출고일": o.shippedAt ? new Date(o.shippedAt).toLocaleString("ko-KR") : "",
    "주소": [o.address, o.addressDetail].filter(Boolean).join(" "), "배송 메시지": o.deliveryMessage || "",
    "메모": o.note || "", "등록일시": o.createdAt ? new Date(o.createdAt).toLocaleString("ko-KR") : "",
  }));
}

/** 주문의 품목을 한 줄씩 펼친 행 — 품목별 집계용 두 번째 시트 */
export function orderItemRows(orders) {
  const out = [];
  for (const o of orders || []) {
    for (const it of o.items || []) {
      out.push({ "주문번호": String(o.id || "").slice(0, 8).toUpperCase(), "접수일": o.date || "", "고객": o.customer || "", "판매처": o.salesChannel || "직접·밴드", "품번": it.itemNo || it.productCode || "", "원단": it.fabric || "", "색상": it.color || "", "수량": Number(it.qty) || 0, "단위": it.unit || "마", "단가": Number(it.unitPrice) || 0, "금액": Number(it.amount) || 0 });
    }
  }
  return out;
}

/** 고객 → 엑셀 행. stats 는 customerStats 의 Map(id → {count, lastAt, unpaid}) — 없어도 된다. */
export function customerRows(customers, stats) {
  return (customers || []).map(c => {
    const s = stats?.get?.(c.id);
    return {
      "이름": c.name || "", "닉네임": c.nickname || "", "연락처": c.phone || "",
      "기본 배송지": c.address || "", "상세 주소": c.addressDetail || "",
      "배송지 2": c.address2 || "", "배송지 2 상세": c.address2Detail || "",
      "주문 수": s?.count ?? c.totalOrders ?? 0, "최근 주문": s?.lastAt || c.lastOrder || "", "미수금": s?.unpaid || 0,
      "메모": c.note || "",
    };
  });
}
