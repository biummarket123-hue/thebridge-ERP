// 송장 엑셀 — 옛 ErpApp.exportShipping 의 onExport 경로를 그대로 옮긴 것(CJ LOIS 16열 · 경동 24열) + 범용 양식(그 밖의 택배사). 출력 뒤 db.markInvoicePrinted.
// 어느 양식을 쓸지는 택배사 이름이 아니라 회사 설정의 택배사 목록(format: cj|kd|generic, lib/courier.js courierFormat)이 정한다.
// 출고완료는 여기서 하지 않는다 — 송장을 뽑는 사람은 박스를 보지 않는다(옛 InvoicePanel 주석).
import * as XLSX from "xlsx-js-style";
import * as db from "../../lib/db.js";
import { dlXlsx } from "../../constants.js";
import { COURIER_SHORT, courierFormat, courierInfo } from "../../lib/courier.js";
import { shipGroupOf } from "./ship.js";

const COLS = {
  // 범용 — CJ·경동이 아닌 택배사. 대부분의 택배사 업로드 양식에 이 칸들이 있어 열 이름만 맞추면 된다.
  generic: {
    cols: ["받는분", "전화번호", "우편번호", "주소", "상세주소", "품목명", "수량", "배송메세지", "보내는분", "보내는분 전화"],
    widths: [14, 16, 9, 40, 24, 14, 6, 26, 14, 16],
    blue: [0, 1, 3],
    row: (o, c, cfg) => [o.customer, o.phone || c.find(x => x.name === o.customer)?.phone || "", "", o.address || "", o.addressDetail || "", "원단", 1, o.deliveryMessage || "", cfg?.sender?.name || cfg?.companyName || "", cfg?.sender?.phone || ""],
  },
  cj: {
    cols: ["예약구분", "집하예정일", "받는분성명", "받는분전화번호", "받는분기타연락처", "받는분우편번호", "받는분주소(전체, 분할)", "운송장번호", "고객주문번호", "품목명", "박스수량", "박스타입", "기본운임", "배송메세지1", "배송메세지2", "품목명"],
    widths: [{ wch: 10 }, { wch: 13 }, { wch: 15.375 }, { wch: 15.375 }, { wch: 18 }, { wch: 14 }, { wch: 73.375 }, { wch: 10, hidden: true }, { wch: 10, hidden: true }, { wch: 10, hidden: true }, { wch: 10, hidden: true }, { wch: 10, hidden: true }, { wch: 10, hidden: true }, { wch: 16 }, { wch: 16 }, { wch: 12 }],
    purple: [2, 3, 6],
    row: (o, c) => {
      const phone = o.phone || c.find(x => x.name === o.customer)?.phone || "";
      const addr = [o.address, o.addressDetail].filter(Boolean).join(" ") || "";
      return ["", "", o.customer, phone, "", "", addr, "", "", "", "", "", "", o.deliveryMessage || "", "", ""];
    },
  },
  kd: {
    cols: ["받는분", "주소", "상세주소", "운송장번호", "고객사주문번호", "우편번호", "도착영업소", "전화번호", "기타전화번호", "선불후불", "품목명", "수량", "포장상태", "가로", "세로", "높이", "무게", "개별단가", "배송운임", "기타운임", "별도운임", "할증운임", "도서운임", "메모"],
    widths: [15, 41, 42, 11, 15, 9, 11, 14, 13, 9, 7, 5, 9, 5, 5, 5, 5, 9, 10, 9, 9, 9, 9, 26],
    blue: [0, 1, 2, 7, 12, 18],
    row: (o, c, cfg, courier) => {
      // 선불/후불은 택배사 항목(회사 설정 > 택배사)에서, 나머지 세 칸은 기본값(원단·100·100)
      const kd = { ...(cfg?.kd || {}), payType: courierInfo(courier)?.payType || cfg?.kd?.payType || "선불" };
      let base = o.address || "", detail = o.addressDetail || "";
      if (base && detail) {
        const alreadyComplete = /[로길]$/.test(base) || /[로길]\s*\d+(?:-\d+)?$/.test(base);
        if (!alreadyComplete) {
          const fix = detail.match(/^(로|길)\s*(\d+(?:-\d+)?)\s*(.*)$/);
          if (fix) { const [, suffix, num, rest] = fix; base = `${base}${suffix} ${num}`; detail = rest.trim(); }
        }
      }
      if (base && !detail) {
        const m = base.match(/^(.+\s\d+(?:-\d+)?(?:번지|번길)?)\s+(.+)$/);
        if (m) { base = m[1].trim(); detail = m[2].trim(); }
      }
      return {
        "받는분": o.customer, "주소": base, "상세주소": detail, "운송장번호": "", "고객사주문번호": "", "우편번호": "", "도착영업소": "",
        "전화번호": o.phone || c.find(x => x.name === o.customer)?.phone || "", "기타전화번호": "", "선불후불": kd.payType || "선불", "품목명": kd.itemName || "원단", "수량": "", "포장상태": "",
        "가로": "", "세로": "", "높이": "", "무게": "", "개별단가": kd.unitPrice ?? 100, "배송운임": "", "기타운임": kd.extraFee ?? 100, "별도운임": "", "할증운임": "", "도서운임": "", "메모": o.deliveryMessage || "",
      };
    },
  },
};

/**
 * 고른 주문(selIds)의 송장 엑셀을 내려받고 출력 표시를 남긴다. 반환 { count, printedIds, printedAt }
 * config(회사 설정, SaasData 의 config): 경동 행의 선불후불·품목명·개별단가·기타운임(config.kd)과 파일명의 회사명. 없으면 기본값.
 */
export async function exportInvoices(selIds, courier, { orders, customers, config }) {
  const seenGroups = new Set();
  const invoiceIds = selIds.filter(id => {
    const o = orders.find(x => x.id === id);
    if (!o) return false;
    if (!o.mergeGroupId || o.splitShipping) return true;
    if (seenGroups.has(o.mergeGroupId)) return false;
    seenGroups.add(o.mergeGroupId);
    return true;
  });
  const targets = orders.filter(o => invoiceIds.includes(o.id)).sort((a, b) => (a.customer || "").localeCompare(b.customer || "", "ko-KR"));
  if (!targets.length) throw new Error("선택된 주문이 없습니다");
  const format = courierFormat(courier);
  const fmt = COLS[format] || COLS.generic;
  const dataRows = targets.map(o => {
    const r = fmt.row(o, customers || [], config, courier);
    if (Array.isArray(r)) return r.map(v => v != null ? v : "");
    return fmt.cols.map(col => r[col] != null ? r[col] : "");
  });
  const aoa = [fmt.cols, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = (fmt.widths || fmt.cols.map(() => 22)).map(w => typeof w === "object" ? w : { wch: w });
  const purpleSet = new Set(fmt.purple || []), blueSet = new Set(fmt.blue || []);
  fmt.cols.forEach((_, ci) => {
    const hAddr = XLSX.utils.encode_cell({ r: 0, c: ci });
    if (!ws[hAddr]) ws[hAddr] = { v: "", t: "s" };
    const isAccent = purpleSet.has(ci) || blueSet.has(ci);
    const accentRgb = purpleSet.has(ci) ? "7030A0" : blueSet.has(ci) ? "0070C0" : "000000";
    ws[hAddr].s = { font: { bold: isAccent, sz: 13, color: { rgb: accentRgb } }, fill: { fgColor: { rgb: "F0F0F0" } }, alignment: { horizontal: "center", vertical: "center" } };
    for (let ri = 1; ri < aoa.length; ri++) {
      const dAddr = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (!ws[dAddr]) ws[dAddr] = { v: "", t: "s" };
      ws[dAddr].s = { font: { sz: 13, color: { rgb: "000000" } } };
    }
  });
  ws["!rows"] = aoa.map((_, i) => ({ hpt: i === 0 ? 22 : 20 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, format === "cj" ? "sheet1" : "송장출력");
  dlXlsx(wb, `${String(config?.companyName || "").trim() || "주문"}_${courier}_송장.xlsx`);

  const printedIds = [...new Set(selIds.flatMap(id => {
    const o = orders.find(x => x.id === id);
    return (!o || o.status === "출고완료") ? [] : shipGroupOf(o, orders).map(x => x.id);
  }))];
  const printedAt = await db.markInvoicePrinted(printedIds, `${COURIER_SHORT[courier] || courier} 송장 출력 · 새 UI`);
  return { count: targets.length, printedIds, printedAt };
}
