// 월 리포트 — 인쇄용 HTML 을 만들어 새 창에서 print(). 숫자 정의는 metrics.js 와 같다(입금 기준 매출 = payment_logs "입금" 합).
// buildMonthlyReport 는 순수 함수(문자열 반환) — 테스트·미리보기에 쓸 수 있다.
import { monthRange, depositSum, orderTotal, orderPaid, orderUnpaid, isActiveOrder, dayKey } from "./metrics.js";

export const CHANNEL_DIRECT = "직접·밴드";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const payOf = (o) => o.payment === "환불신청" ? "환불신청" : (o._computed?.paymentStatus || o.payment || "미입금");
/** 받은 돈 — _computed 가 없는 출고완료 주문(최근 출고 목록)은 입금완료면 전액으로 본다 */
export const paidOf = (o) => o._computed ? orderPaid(o) : (o.payment === "입금완료" ? orderTotal(o) : orderPaid(o));

/** 그 달에 접수된 주문 중 입금완료·부분입금(환불 종결 제외) — 판매처별·품목별·고객별 집계의 모집단 */
export function monthOrders(orders, range) {
  const s = range.start.getTime(), e = range.end.getTime();
  return (orders || []).filter(o => {
    const t = o.createdAt ? new Date(o.createdAt).getTime() : NaN;
    if (!(t >= s && t < e)) return false;
    const p = payOf(o);
    return p === "입금완료" || p === "부분입금";
  });
}

/** 판매처별 매출(받은 돈 합). 빈 판매처는 "직접·밴드". 큰 순. */
export function salesByChannel(orders, range) {
  const m = new Map();
  for (const o of monthOrders(orders, range)) {
    const k = o.salesChannel || CHANNEL_DIRECT;
    const cur = m.get(k) || { channel: k, count: 0, sum: 0 };
    cur.count += 1; cur.sum += paidOf(o);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.sum - a.sum);
}

function topItems(list, n = 10) {
  const m = new Map();
  for (const o of list) for (const it of o.items || []) {
    const k = `${it.fabric || "(원단 없음)"}${it.color ? ` ${it.color}` : ""}`;
    const cur = m.get(k) || { name: k, qty: 0, amount: 0, unit: it.unit || "마" };
    cur.qty += Number(it.qty) || 0; cur.amount += Number(it.amount) || 0;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, n);
}
function topCustomers(list, n = 10) {
  const m = new Map();
  for (const o of list) {
    const k = o.customer || "(고객 없음)";
    const cur = m.get(k) || { name: k, count: 0, sum: 0 };
    cur.count += 1; cur.sum += paidOf(o);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.sum - a.sum).slice(0, n);
}
function dailyDeposits(logs, range) {
  const m = new Map();
  const s = range.start.getTime(), e = range.end.getTime();
  for (const l of logs || []) {
    if (l.type !== "입금") continue;
    const t = new Date(l.created_at).getTime();
    if (!(t >= s && t < e)) continue;
    const k = dayKey(l.created_at);
    const cur = m.get(k) || { day: k, count: 0, sum: 0 };
    cur.count += 1; cur.sum += Number(l.amount) || 0;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * 인쇄용 HTML 문자열. { companyName, now, offset(0 이번 달 / -1 지난달), orders(활성+최근 출고완료 합친 것), paymentLogs }
 * 반환 { html, data } — data 는 화면 미리보기·테스트용 집계.
 */
export function buildMonthlyReport({ companyName, now = new Date(), offset = 0, orders = [], paymentLogs = [] }) {
  const range = monthRange(now, offset);
  const dep = depositSum(paymentLogs, range.start, range.end);
  const unpaidList = (orders || []).filter(o => isActiveOrder(o) && orderUnpaid(o) > 0);
  const unpaid = unpaidList.reduce((s, o) => s + orderUnpaid(o), 0);
  const list = monthOrders(orders, range);
  const data = { range, deposit: dep, unpaid, unpaidCount: unpaidList.length, channels: salesByChannel(orders, range), items: topItems(list), customers: topCustomers(list), daily: dailyDeposits(paymentLogs, range), orderCount: list.length };
  const title = `${range.start.getFullYear()}년 ${range.start.getMonth() + 1}월 리포트`;
  const period = `${range.start.getFullYear()}-${String(range.start.getMonth() + 1).padStart(2, "0")}-01 ~ ${dayKey(new Date(range.end.getTime() - 1))}`;
  const table = (heads, rows, empty) => rows.length ? `<table><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i > 0 && typeof c === "number" ? "num" : ""}">${typeof c === "number" ? c.toLocaleString("ko-KR") : esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p class="empty">${esc(empty)}</p>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(companyName)} ${esc(title)}</title>
<style>
  body{font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1f2d3d;margin:0;padding:28px 32px;font-size:13px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:#6b7a8c;margin:0 0 18px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
  .stat{border:1px solid #dfe6ef;border-radius:10px;padding:12px 14px}.stat small{display:block;color:#6b7a8c;margin-bottom:4px}.stat strong{font-size:18px}
  h2{font-size:15px;margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid #1f2d3d}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}th,td{border-bottom:1px solid #e6ebf1;padding:6px 8px;text-align:left}th{background:#f4f7fa;font-weight:700}td.num{text-align:right;font-variant-numeric:tabular-nums}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:20px}.empty{color:#8b9bb0}.foot{margin-top:24px;color:#8b9bb0;font-size:11px}
  @media print{body{padding:0}.two{break-inside:avoid}}
</style></head><body>
<h1>${esc(companyName)} · ${esc(title)}</h1><p class="sub">기간 ${esc(period)} · 출력 ${esc(now.toLocaleString("ko-KR"))}</p>
<div class="stats">
  <div class="stat"><small>월 매출(입금 기준)</small><strong>${esc(won(dep.sum))}</strong></div>
  <div class="stat"><small>입금 건수</small><strong>${dep.count}건</strong></div>
  <div class="stat"><small>미수금(현재, 진행 중 주문)</small><strong>${esc(won(unpaid))}</strong><small>${data.unpaidCount}건</small></div>
  <div class="stat"><small>이 달 접수·결제된 주문</small><strong>${data.orderCount}건</strong></div>
</div>
<h2>판매처별 매출</h2>${table(["판매처", "주문", "매출(받은 돈)"], data.channels.map(c => [c.channel, c.count, c.sum]), "이 달에 결제된 주문이 없습니다.")}
<div class="two">
  <div><h2>상위 품목 10</h2>${table(["품목", "수량", "금액"], data.items.map(i => [i.name, i.qty, i.amount]), "품목 기록이 없습니다.")}</div>
  <div><h2>상위 고객 10</h2>${table(["고객", "주문", "금액"], data.customers.map(c => [c.name, c.count, c.sum]), "고객 기록이 없습니다.")}</div>
</div>
<h2>일별 입금</h2>${table(["날짜", "건수", "입금액"], data.daily.map(d => [d.day, d.count, d.sum]), "이 달 입금 기록이 없습니다.")}
<p class="foot">매출은 payment_logs 의 "입금" 합(적립금·환불 제외). 판매처·품목·고객 집계는 이 달에 접수된 주문 중 입금완료·부분입금 건의 받은 돈. 미수금은 출력 시점의 진행 중 주문 기준.</p>
</body></html>`;
  return { html, data };
}

/** 새 창을 열어 인쇄한다. 팝업이 막히면 Error. */
export function printMonthlyReport(opts) {
  const { html, data } = buildMonthlyReport(opts);
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) throw new Error("팝업이 막혀 있습니다 — 이 사이트의 팝업을 허용해 주세요");
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* 사용자가 창을 먼저 닫음 */ } }, 300);
  return data;
}
