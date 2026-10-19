// 지표 계산 — 순수 함수. 화면이 보여주는 숫자의 정의는 전부 여기(지시서 5절). DB·React 없음, tests/ 에서 그대로 돈다.
//
// 모든 날짜는 로컬 기준이다(한국 +9). toISOString 으로 자르면 UTC 로 밀려 하루가 어긋난다.
import { ymd, parseYmd, addDays } from "../../lib/shipDate.js";
import { summarizeRolls } from "../../lib/rollStock.js";

export { ymd };

/** Date|ISO → 로컬 "YYYY-MM-DD". 못 읽으면 "". */
export function dayKey(v) {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d) ? "" : ymd(d);
}

/** 이번 달의 시작·끝(로컬 자정 기준 Date) */
export function monthRange(now = new Date(), offset = 0) {
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { start, end, key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}` };
}

/** 이번 주(월요일 시작) 7일의 날짜 키. 오늘이 포함된 주. */
export function weekDays(now = new Date()) {
  const dow = (now.getDay() + 6) % 7;   // 월=0 … 일=6
  const mon = addDays(now, -dow);
  return Array.from({ length: 7 }, (_, i) => ymd(addDays(mon, i)));
}

/** 진행 중인 주문 — 출고완료·전액환불로 끝난 건은 뺀다(옛 ErpApp.isActiveOrder 와 같은 기준). */
export function isActiveOrder(o) {
  if (!o) return false;
  const cs = o._computed?.paymentStatus || o.payment;
  return o.status !== "출고완료" && o.payment !== "환불" && cs !== "환불완료";
}

/** 주문 금액 — 전체금액이 있으면 그것, 없으면 품목합 + 배송비 + 기타. */
export function orderTotal(o) {
  if (!o) return 0;
  if (Number(o.totalAmount) > 0) return Number(o.totalAmount);
  const items = (o.items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  return items + (Number(o.shippingFee) || 0) + (Number(o.otherCost) || 0);
}

/** 미수금 — _computed 가 있으면 그 값, 없으면 전체금액에서 저장된 입금액을 뺀 것. */
export function orderUnpaid(o) {
  if (o?._computed) return Number(o._computed.balanceAmount) || 0;
  return Math.max(0, orderTotal(o) - (Number(o?.depositAmount) || 0) - (Number(o?.balanceAmount) || 0));
}

export function orderPaid(o) {
  if (o?._computed) return Number(o._computed.depositAmount) || 0;
  return (Number(o?.depositAmount) || 0) + (Number(o?.balanceAmount) || 0);
}

/** 품목 한 줄 요약 — "린넨 베이지 3마 외 2종" */
export function itemsSummary(o, max = 1) {
  const items = (o?.items || []).filter(Boolean);
  if (!items.length) return "(품목 없음)";
  const line = (i) => `${i.fabric || ""}${i.color ? ` ${i.color}` : ""} ${i.qty || 0}${i.unit || "마"}`.trim();
  const head = items.slice(0, max).map(line).join(", ");
  return items.length > max ? `${head} 외 ${items.length - max}종` : head;
}

/** 품목 수량 합(마 단위만). 세트·필·롤은 길이가 아니라 넣지 않는다. */
export function itemsLengthSum(o) {
  return (o?.items || []).reduce((s, i) => s + ((i.unit || "마") === "마" ? (Number(i.qty) || 0) : 0), 0);
}

/**
 * 홈·주문 지표.
 *   todayCount    활성 주문 중 createdAt 이 오늘
 *   shipWaiting   활성 주문 중 보관·보류 아님(출고완료는 활성에 없다)
 *   packed        포장완료
 *   held / parked 보관 / 보류
 *   unpaidCount   미입금·부분입금
 *   refundRequested 환불 신청 대기
 */
export function orderStats(orders, h, now = new Date()) {
  const { isHold, isParked, getPayStatus } = h;
  const today = ymd(now);
  const yesterday = ymd(addDays(now, -1));
  let todayCount = 0, yesterdayCount = 0, shipWaiting = 0, packed = 0, held = 0, parked = 0, unpaidCount = 0, unpaidSum = 0, refundRequested = 0, active = 0;
  for (const o of orders || []) {
    if (o.payment === "환불신청") refundRequested++;
    if (!isActiveOrder(o)) continue;
    active++;
    const ck = dayKey(o.createdAt);
    if (ck === today) todayCount++;
    else if (ck === yesterday) yesterdayCount++;
    const hold = isHold(o), park = isParked(o);
    if (hold) held++;
    if (park) parked++;
    if (!hold && !park) shipWaiting++;
    if (o.status === "포장완료") packed++;
    const pay = getPayStatus(o);
    if (pay === "미입금" || pay === "부분입금") { unpaidCount++; unpaidSum += orderUnpaid(o); }
  }
  return { todayCount, yesterdayCount, shipWaiting, packed, held, parked, unpaidCount, unpaidSum, refundRequested, active };
}

/**
 * 입금 로그 합계 — type "입금" 만(적립금·배송권 차감은 돈이 들어온 게 아니다). 이번 달 매출 = 입금 기준(지시서 5절).
 * logs: payment_logs 행(snake_case 그대로: type, amount, created_at)
 */
export function depositSum(logs, start, end) {
  let sum = 0, count = 0;
  for (const l of logs || []) {
    if ((l.type || "") !== "입금") continue;
    const d = new Date(l.created_at);
    if (isNaN(d) || d < start || d >= end) continue;
    sum += Number(l.amount) || 0;
    count++;
  }
  return { sum, count };
}

/** 최근 n 개월 입금 합 — 정산의 월별 매출 막대. 오래된 달부터. */
export function monthlyDeposits(logs, now = new Date(), n = 6) {
  return Array.from({ length: n }, (_, i) => {
    const r = monthRange(now, i - (n - 1));
    return { key: r.key, label: `${r.start.getMonth() + 1}월`, value: depositSum(logs, r.start, r.end).sum, selected: i === n - 1 };
  });
}

/** 이번 주 요일별 출고 건수 — shippedAt 기준. 같은 묶음도 주문 건수로 센다(시안 단위: 건). */
export function weeklyShipped(shipped, now = new Date()) {
  const days = weekDays(now);
  const count = Object.fromEntries(days.map(d => [d, 0]));
  for (const o of shipped || []) {
    const k = dayKey(o.shippedAt);
    if (k in count) count[k]++;
  }
  const todayKey = ymd(now);
  const labels = ["월", "화", "수", "목", "금", "토", "일"];
  const bars = days.map((d, i) => ({ key: d, label: labels[i], value: count[d], selected: d === todayKey }));
  return { bars, total: bars.reduce((s, b) => s + b.value, 0) };
}

/** 지난주 같은 기간(월~오늘 요일) 출고 건수 — "지난주 대비" 증감용 */
export function lastWeekShippedToDate(shipped, now = new Date()) {
  const days = weekDays(addDays(now, -7));
  const dow = (now.getDay() + 6) % 7;
  const set = new Set(days.slice(0, dow + 1));
  let n = 0;
  for (const o of shipped || []) if (set.has(dayKey(o.shippedAt))) n++;
  return n;
}

/** 이번 달 출고완료 주문의 마 수량 합(지시서 5절 "이번 달 판매") */
export function monthShippedLength(shipped, now = new Date()) {
  const { start, end } = monthRange(now);
  let sum = 0;
  for (const o of shipped || []) {
    const d = new Date(o.shippedAt);
    if (isNaN(d) || d < start || d >= end) continue;
    sum += itemsLengthSum(o);
  }
  return Math.round(sum * 100) / 100;
}

/**
 * 재고 요약 — groups: lib/rollStock.groupRollsByProduct 의 결과(품번 + 롤 + summarizeRolls).
 *   productCount    products 수(롤이 없는 품번 포함)
 *   totalRemaining  판매 가능 롤 잔량 합(마)
 *   low             최대 재단 가능 길이가 lowM 미만(0 초과)인 품번 수
 *   out             판매 가능 롤이 0 인 품번 수(롤이 등록된 품번 중)
 */
export function stockStats(products, groups, lowM) {
  let totalRemaining = 0, low = 0, out = 0;
  for (const g of groups || []) {
    totalRemaining += g.totalRemaining || 0;
    if (g.availableCount === 0) out++;
    else if (g.maxRemaining < lowM) low++;
  }
  return { productCount: (products || []).length, totalRemaining: Math.round(totalRemaining * 100) / 100, low, out };
}

/** 품번 한 줄의 상태 — out(품절) · low(부족) · ok */
export function stockStatus(group, lowM) {
  if (!group || group.availableCount === 0) return "out";
  return group.maxRemaining < lowM ? "low" : "ok";
}

/** 재고량 표시 바(0~1) — 잔량 합 ÷ 입고 총 길이. 입고 길이를 모르면 null. */
export function stockRatio(group) {
  const received = (group?.rolls || []).reduce((s, r) => s + (Number(r.lengthReceived) || 0), 0);
  if (!(received > 0)) return null;
  return Math.max(0, Math.min(1, (group.totalRemaining || 0) / received));
}

/** 보관 위치 — 롤마다 적힌 위치를 모아 한 줄로. 없으면 "" */
export function stockLocations(group) {
  const locs = [...new Set((group?.rolls || []).filter(r => r.status === "available").map(r => String(r.location || "").trim()).filter(Boolean))];
  return locs.join(", ");
}

/** 거래처 카드의 "지역" — 주소 앞 두 어절("서울 동대문구") */
export function regionOf(address) {
  const parts = String(address || "").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

/** 두 전화번호가 같은 사람인가 — 둘 다 10자리 이상이면 전체 일치, 아니면 가운데 4자리. 한쪽이 없으면 null. */
export function samePhone(a, b) {
  const ad = String(a || "").replace(/\D/g, ""), bd = String(b || "").replace(/\D/g, "");
  if (!ad || !bd) return null;
  if (ad.length >= 10 && bd.length >= 10) return ad === bd;
  const am = ad.length >= 10 ? ad.slice(3, 7) : ad;
  const bm = bd.length >= 10 ? bd.slice(3, 7) : bd;
  return am === bm;
}

/** 주문이 이 고객의 것인가 — 번호로 가르고, 번호가 없으면 이름·닉네임(옛 CustomerTab.isSameCustomer). */
export function orderBelongsTo(o, c) {
  if (!o || !c) return false;
  const ph = samePhone(o.phone, c.phone);
  if (ph === true) return true;
  if (ph === false) return false;
  const oName = o.customer || "", cName = c.name || "";
  if (cName && (oName === cName || oName.includes(cName))) return true;
  if (c.nickname && oName.includes(c.nickname)) return true;
  return false;
}

/** 거래처 통계 — 고객별 주문 묶기(전화번호 가운데 4자리로 먼저 묶고 그 칸만 본다). */
export function customerStats(customers, orders, now = new Date()) {
  const dg = s => String(s || "").replace(/\D/g, "");
  const byMid = new Map(); const noPhone = [];
  for (const o of orders || []) {
    const d = dg(o.phone);
    const p = { o, d, name: o.customer || "" };
    if (!d) { noPhone.push(p); continue; }
    const mid = d.length >= 10 ? d.slice(3, 7) : d;
    if (!byMid.has(mid)) byMid.set(mid, []);
    byMid.get(mid).push(p);
  }
  const nameHit = (p, c) => (!!c.name && (p.name === c.name || p.name.includes(c.name))) || (!!c.nickname && p.name.includes(c.nickname));
  const { start, end } = monthRange(now);
  const map = new Map();
  for (const c of customers || []) {
    const cd = dg(c.phone);
    let hits;
    if (!cd) hits = noPhone.filter(p => nameHit(p, c));
    else {
      const cmid = cd.length >= 10 ? cd.slice(3, 7) : cd;
      hits = [...(byMid.get(cmid) || []).filter(p => (cd.length >= 10 && p.d.length >= 10) ? p.d === cd : true), ...noPhone.filter(p => nameHit(p, c))];
    }
    const list = hits.map(p => p.o);
    let monthSum = 0, lastAt = "", unpaid = 0, activeCount = 0;
    for (const o of list) {
      const ck = dayKey(o.createdAt) || dayKey(parseKoDate(o.date));
      if (ck && ck > lastAt) lastAt = ck;
      const d = o.createdAt ? new Date(o.createdAt) : parseKoDate(o.date);
      if (d && !isNaN(d) && d >= start && d < end) monthSum += orderTotal(o);
      if (isActiveOrder(o)) { activeCount++; unpaid += orderUnpaid(o); }
    }
    map.set(c.id, { count: Math.max(Number(c.totalOrders) || 0, list.length), monthSum, lastAt, unpaid, activeCount, orders: list });
  }
  return map;
}

/** "2026. 10. 19." 또는 "2026-10-19" → Date(로컬 자정). 못 읽으면 null. */
export function parseKoDate(s) {
  const m = String(s || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

/** 주문 표의 "접수일" — 오늘 09:24 / 어제 16:20 / 10/15 */
export function relativeWhen(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const k = ymd(d), t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (k === ymd(now)) return `오늘 ${t}`;
  if (k === ymd(addDays(now, -1))) return `어제 ${t}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

export const parseYmdLocal = parseYmd;
export { summarizeRolls };
