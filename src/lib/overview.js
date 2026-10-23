// 전체현황 — 진행 중인 주문에서 "놓치고 있는 것"을 골라낸다.
//
// 화면(OverviewTab)과 떼어 둔 이유: 여기 있는 건 전부 "어떤 주문을 문제로 볼 것인가"라는
// 규칙이다. 규칙은 회의에서 바뀐다(언제부터 볼지, 어떤 건을 뺄지). 화면 코드 사이에
// 흩어져 있으면 바꿀 때마다 빠뜨리는 자리가 생긴다.

import { isBusinessDay, parseYmd, ymd, addDays } from "./shipDate.js";
import { COURIER_SHORT, missedPickups } from "./courier.js";

// 출고 쪽 구역은 "며칠째"가 아니라 "수거를 놓쳤는가"로 본다(missedPickups).
// 택배는 하루에 한 번 온다 — 오후 4시에 싼 박스는 다음 날 수거까지 안 나간 게 정상이다.
// 날짜로 세면 매일 아침 전날 오후 물량이 전부 문제로 떠서, 며칠 뒤엔 아무도 안 본다.
//
// 보관·보류는 본래 오래 두는 것이라 달력일로 센다. 회의에서 정해지면 이 숫자만 바꾸면 된다.
export const OVERVIEW_RULES = {
  heldDays: 7,             // 보관
  parkedDays: 14,          // 보류
};

const SHIPPABLE_PAY = ["입금완료", "부분환불", "환불완료"];
const UNPAID_PAY = ["미입금", "부분입금"];

const dayOf = (v) => {
  if (!v) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return parseYmd(v);
  const d = new Date(v);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** 그날 이후 오늘까지 지난 달력일. 같은 날이면 0. */
export function calDaysSince(v, today = new Date()) {
  const d = dayOf(v);
  if (!d) return 0;
  const t = dayOf(today);
  return Math.max(0, Math.round((t - d) / 86400000));
}

/** 그날 이후 오늘까지 지난 영업일(그날은 빼고 오늘은 넣는다). 금요일 → 월요일 = 1. */
export function bizDaysSince(v, today = new Date()) {
  const d = dayOf(v);
  if (!d) return 0;
  const t = dayOf(today);
  let n = 0;
  // 2년이면 충분하다 — 그보다 오래된 건은 어차피 맨 위에 뜬다.
  for (let x = addDays(d, 1), i = 0; x <= t && i < 730; x = addDays(x, 1), i++) {
    if (isBusinessDay(x)) n++;
  }
  return n;
}

const md = (v) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? `${d.getMonth() + 1}/${d.getDate()}` : "";
};

// 둘 중 늦은 시각. 한쪽이 없으면 있는 쪽.
const later = (a, b) => {
  const x = a ? new Date(a) : null, y = b ? new Date(b) : null;
  if (!x || isNaN(x)) return y && !isNaN(y) ? y : null;
  if (!y || isNaN(y)) return x;
  return x > y ? x : y;
};

/**
 * 구역별로 주문을 골라낸다.
 *
 * @param orders        화면이 들고 있는 주문(활성 건 + _computed)
 * @param shippedMates  합배송 묶음 중 이미 출고완료된 건 (db.fetchShippedGroupMates)
 * @param h             { isHold, isParked, getPayStatus, courierOf, isPickup } — constants.js·courier.js 의
 *                      판정을 그대로 받는다. 여기서 다시 짜면 주문현황과 기준이 어긋난다.
 *                      courierOf(order) 는 미리 지정한 택배사 이름(없으면 null — 송장 뽑을 때 정해진다).
 * @param now           지금 시각. 날짜만이 아니라 시각까지 쓴다 — 수거 마감이 지났는지 봐야 한다.
 * @returns { sections: [{key, icon, short, title, hint, tone, rows:[{order, days, unit, note}]}], flagged, active }
 *          unit 은 숫자 뒤에 붙는 말이다: "번 놓침" / "일째"
 */
export function buildOverview(orders, shippedMates, h, now = new Date(), rules = OVERVIEW_RULES) {
  const { isHold, isParked, getPayStatus } = h;
  const courierOf = h.courierOf || (() => null);
  const isPickup = h.isPickup || (() => false);
  const canShipOf = h.canShip || ((o) => SHIPPABLE_PAY.includes(getPayStatus(o)));   // 외상 거래처면 입금 전에도 출고 가능(actions/ship.js)
  const today = now;
  const todayStr = ymd(dayOf(today));

  // 진행 중인 주문만 — 출고완료·전액환불로 끝난 건은 과거 데이터다.
  const active = (orders || []).filter(o => {
    const cs = o._computed?.paymentStatus || o.payment;
    return o.status !== "출고완료" && o.payment !== "환불" && cs !== "환불완료";
  });

  const matesByGroup = new Map();
  for (const m of (shippedMates || [])) {
    if (!m.mergeGroupId || m.splitShipping) continue;   // 분리로 따로 나간 건은 묶음 출고가 아니다
    if (!matesByGroup.has(m.mergeGroupId)) matesByGroup.set(m.mergeGroupId, []);
    matesByGroup.get(m.mergeGroupId).push(m);
  }

  const S = {
    invoice: [], partial: [], packedUnshipped: [], packedUnpaid: [],
    shipRequest: [], held: [], parked: [], dueUnpacked: [], overdueUnpaid: [],
  };

  for (const o of active) {
    const pay = getPayStatus(o);
    const held = isHold(o);
    const parked = isParked(o);
    const packed = o.status === "포장완료";
    const canShip = canShipOf(o);
    const unpaid = UNPAID_PAY.includes(pay);
    const courier = courierOf(o) || null;
    const cs = courier ? `${COURIER_SHORT[courier] || courier} ` : "";
    const missed = (since) => missedPickups(since, now);   // 수거 마감은 회사에 하나
    // 출고예정일이 아직 안 온 건은 그날 0시부터 센다 — 일찍 싸 뒀다고 늦은 게 아니다.
    const dueFrom = (since) => later(since, o.shipDate ? parseYmd(o.shipDate) : null);

    // 보관·보류는 일부러 잡아둔 것이라 아래 출고 구역에서 뺀다(각자 구역에서 따로 본다).
    // 방문·픽업 주문도 뺀다 — 택배로 안 나가므로 수거를 놓칠 일이 없다. 고객이 오는 날이 곧 나가는 날이다.
    const moving = !held && !parked && !isPickup(o);

    if (o.invoicePrintedAt && moving) {
      const n = missed(o.invoicePrintedAt);
      if (n >= 1) S.invoice.push({ order: o, days: n, unit: "번 놓침",
        note: `${cs}송장 출력 ${md(o.invoicePrintedAt)} — 그 뒤 수거가 ${n}번 지나감` });
    }

    if (o.mergeGroupId && !o.splitShipping && matesByGroup.has(o.mergeGroupId)) {
      const mates = matesByGroup.get(o.mergeGroupId);
      const last = mates.map(m => m.shippedAt).filter(Boolean).sort().pop();
      S.partial.push({ order: o, days: calDaysSince(last, today), unit: "일째",
        note: `같은 묶음 ${mates.length}건은 ${md(last) || "이미"} 출고완료` });
    }

    // 송장까지 나온 건은 위 구역에서 이미 잡힌다 — 여기는 송장도 없이 남은 박스만.
    if (packed && canShip && moving && !o.invoicePrintedAt) {
      const n = missed(dueFrom(o.packedAt || o.createdAt));
      if (n >= 1) S.packedUnshipped.push({ order: o, days: n, unit: "번 놓침",
        note: `포장완료 ${md(o.packedAt || o.createdAt)} · 송장 없음` });
    }

    if (packed && unpaid) {
      const since = o.packedAt || o.createdAt;
      S.packedUnpaid.push({ order: o, days: calDaysSince(since, today), unit: "일째", note: `${pay} · 포장완료 ${md(since)}` });
    }

    if (o.shipRequestedAt && moving) {
      const n = missed(o.shipRequestedAt);
      if (n >= 1) S.shipRequest.push({ order: o, days: n, unit: "번 놓침",
        note: `출고요청 ${md(o.shipRequestedAt)}${o.shipRequestedBy ? ` · ${o.shipRequestedBy}` : ""}` });
    }

    if (held) {
      const since = o.heldAt || o.createdAt;
      const days = calDaysSince(since, today);
      if (days >= rules.heldDays) S.held.push({ order: o, days, unit: "일째",
        note: o.heldAt ? `보관중 · ${md(o.heldAt)} 입고` : "보관 요청만 — 창고에 넣은 기록 없음" });
    }

    if (parked) {
      const since = o.parkedAt || o.createdAt;
      const days = calDaysSince(since, today);
      if (days >= rules.parkedDays) S.parked.push({ order: o, days, unit: "일째", note: `보류 · ${o.parkReason || "사유 없음"}` });
    }

    // 회사 기준은 익일 배송이다. 당일에 못 싼 건 문제가 아니고, 출고예정일의 수거를
    // 놓쳤을 때가 문제다. 출고요청·송장 출력 건은 위 구역에서 따로 본다.
    if (pay === "입금완료" && !packed && moving && !o.shipRequestedAt && !o.invoicePrintedAt) {
      const paidAt = o._computed?.paidAt || o.createdAt;
      const n = missed(dueFrom(paidAt));
      if (n >= 1) S.dueUnpacked.push({ order: o, days: n, unit: "번 놓침",
        note: `${o.shipDate ? `출고예정 ${md(parseYmd(o.shipDate))}` : `입금 ${md(paidAt)}`} · 아직 미포장` });
    }

    if (unpaid && !packed && moving && o.shipDate && o.shipDate < todayStr) {
      S.overdueUnpaid.push({ order: o, days: bizDaysSince(o.shipDate, today), unit: "일째",
        note: `${pay} · 출고예정 ${md(parseYmd(o.shipDate))}` });
    }
  }

  const byDays = (a, b) => b.days - a.days || String(a.order.createdAt || "").localeCompare(String(b.order.createdAt || ""));
  // short: 맨 위 요약 칸에 들어가는 짧은 이름. 칸이 좁아 제목을 그대로 넣으면 두세 줄로 꺾인다.
  const sec = (key, icon, short, title, hint, tone) => ({ key, icon, short, title, hint, tone, rows: S[key].sort(byDays) });

  // 위험한 순서. 위쪽일수록 "물건은 이미 나갔을 가능성"이 높다.
  const sections = [
    sec("invoice", "📮", "송장 후 미출고", "송장은 나갔는데 출고완료가 아님", "송장을 뽑은 뒤 수거가 지나갔는데 인계가 안 된 주문 — 물건은 나갔을 수 있습니다", "red"),
    sec("partial", "🔗", "묶음 일부 출고", "합배송 묶음 중 일부만 출고됨", "같은 묶음의 다른 주문은 이미 출고완료입니다", "red"),
    sec("packedUnshipped", "📦", "포장 후 미출고", "포장완료인데 출고 안 됨", "입금도 포장도 끝났는데 송장 없이 수거를 놓친 주문", "red"),
    sec("packedUnpaid", "💰", "포장·미입금", "포장완료인데 미입금", "물건은 준비됐는데 입금 때문에 못 나가는 주문", "yellow"),
    sec("shipRequest", "🚚", "출고요청 방치", "출고요청 후 방치", "보관분을 내보내라고 요청했는데 수거를 놓친 주문", "yellow"),
    sec("dueUnpacked", "🧾", "예정일 지난 미포장", "출고예정일이 지났는데 미포장", "입금은 끝났는데 출고예정일의 수거까지 포장이 안 된 주문", "yellow"),
    sec("overdueUnpaid", "💸", "예정일 지난 미입금", "출고예정일 지났는데 미입금", "예정일이 지나도록 입금이 안 들어온 주문", "yellow"),
    sec("held", "🗄️", "보관 오래됨", "보관이 오래됨", `보관한 지 ${rules.heldDays}일이 넘은 주문`, "blue"),
    sec("parked", "⏸️", "보류 오래됨", "보류가 오래됨", `보류한 지 ${rules.parkedDays}일이 넘은 주문`, "blue"),
  ];

  const flagged = new Set(sections.flatMap(s => s.rows.map(r => r.order.id))).size;
  return { sections, flagged, active: active.length };
}

// ── 변경 기록을 사람 말로 ─────────────────────────────────────
// 기록은 {"칸": {"from","to"}} 로 쌓여 있다(migrations/add_order_events.sql).
// 화면에는 "무슨 일이 있었는지"로 풀어서 보여준다.

const isoLike = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
const val = (v) => {
  if (v === null || v === undefined || v === "") return "없음";
  if (v === true) return "예";
  if (v === false) return "아니오";
  if (isoLike(v)) return fmtWhen(v);
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
};
const arrow = (c) => `${val(c.from)} → ${val(c.to)}`;
const on = (c) => c.to !== null && c.to !== undefined && c.to !== false && c.to !== "";

export function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const itemsLabel = (items) => Array.isArray(items)
  ? items.map(i => `${i.fabric || ""}${i.color ? " " + i.color : ""} ${i.qty || 0}${i.unit || "마"}`.trim()).join(", ")
  : "";

/** 기록 한 줄이 뜻하는 일들 — 문장 배열로. */
export function describeEvent(ev) {
  if (ev.op === "INSERT") return [`주문 등록 (${ev.statusTo || "접수"})`];
  if (ev.op === "DELETE") {
    const items = itemsLabel(ev.changes?.items);
    return [`주문 삭제 — 삭제 전 상태 ${ev.statusFrom || "없음"}${items ? ` · ${items}` : ""}`];
  }
  const c = ev.changes || {};
  const out = [];
  if (c.status) out.push(`상태 ${arrow(c.status)}`);
  if (c.shipped_via && on(c.shipped_via)) out.push(`${c.shipped_via.to}(으)로 출고`);
  if (c.payment) out.push(`결제 ${arrow(c.payment)}`);
  if (c.invoice_printed_at) out.push(on(c.invoice_printed_at) ? "송장 출력" : "송장 출력 표시 지움");
  if (c.is_holding) out.push(on(c.is_holding) ? "보관 요청" : "보관 해제");
  // held_at 이 채워지는 게 '실제로 창고에 넣었다'. 비는 건 보관 해제에 딸려 오므로 따로 적지 않는다.
  if (c.held_at && on(c.held_at)) out.push("보관 완료(창고 입고)");
  if (c.is_parked) out.push(on(c.is_parked) ? "보류" : "보류 해제");
  if (c.park_reason && on(c.park_reason)) out.push(`보류 사유: ${c.park_reason.to}`);
  if (c.ship_requested_at) out.push(on(c.ship_requested_at) ? "출고요청" : "출고요청 취소");
  // 포장 시각·출고 시각은 상태 변경에 딸려 온다. 상태가 같이 바뀌었으면 되풀이하지 않는다.
  if (c.packed_at && !c.status) out.push(on(c.packed_at) ? "포장 시각 기록" : "포장 시각 지움");
  if (c.shipped_at && !c.status) out.push(on(c.shipped_at) ? "출고 시각 기록" : "출고 시각 지움");
  if (c.merge_group_id) out.push(on(c.merge_group_id) ? "합배송 묶음" : "합배송 해제");
  if (c.split_shipping) out.push(on(c.split_shipping) ? "분리 배송 지정" : "분리 배송 해제");
  if (c.courier) out.push(on(c.courier) ? `택배사 ${c.courier.to}(으)로 직접 지정` : "택배사 지정을 비움(송장 뽑을 때 고름)");
  if (c.ship_date) out.push(`출고예정일 ${arrow(c.ship_date)}`);
  if (c.is_urgent) out.push(on(c.is_urgent) ? "긴급 지정" : "긴급 해제");
  if (c.items) out.push(`품목 수정: ${itemsLabel(c.items.from) || "없음"} → ${itemsLabel(c.items.to) || "없음"}`);
  if (c.total_amount) out.push(`금액 ${arrow(c.total_amount)}`);
  if (c.manager) out.push(`담당자 ${arrow(c.manager)}`);
  if (c.customer) out.push(`고객명 ${arrow(c.customer)}`);
  if (c.address || c.address_detail) out.push("배송지 수정");
  return out.length ? out : ["변경"];
}
