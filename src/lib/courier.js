// 택배사 — 어느 양식으로 송장을 뽑고, 수거를 놓쳤는지 보는 데 쓴다.
//
// 사용자 결정(2026-10-23): 택배사는 ERP 가 정해 주는 것이 아니라 송장을 뽑을 때 고른다.
//   · 예전의 "메모에 롤이 있으면 경동, 아니면 CJ" 자동 판정은 우리 회사 방식이라 뺐다. 주문은 택배사 없이 들어온다.
//   · 주문 상세에서 미리 지정해 둘 수는 있다(선택 사항) — 송장 단계에서 그 택배사 탭에 먼저 들어간다.
//   · 송장을 뽑는 순간 고른 택배사가 주문에 기록된다(출고 안내 문자의 {택배사}, 변경 기록).
//   · 수거 마감은 회사에 하나(config.pickupCutoff) — 출고예정일 안내와 전체현황의 "수거 놓침" 판정에 쓴다.
//
// 택배사 목록은 회사 설정(settings.data.saas.couriers)이 정하고 SaasData 가 setCouriers() 로 여기에 넣는다.
// COURIERS·COURIER_SHORT 는 그 목록을 비추는 "살아 있는" 값이라 import 해 둔 쪽에서도 바뀐 목록이 보인다
// (배열·객체를 새로 만들지 않고 안을 갈아 끼운다).
//   { name: "CJ대한통운", short: "CJ", format: "cj"|"kd"|"generic", payType?: "선불"|"후불"(kd 양식만) }
//   · format — 송장 엑셀 양식(actions/invoice.js). CJ LOIS·경동 양식이 아니면 범용(generic).

import { isBusinessDay, addDays } from "./shipDate.js";

export const CJ = "CJ대한통운";
export const KD = "경동화물";
export const COURIER_FORMATS = ["cj", "kd", "generic"];
export const DEFAULT_COURIERS = Object.freeze([
  Object.freeze({ name: CJ, short: "CJ", format: "cj" }),
  Object.freeze({ name: KD, short: "경동", format: "kd", payType: "선불" }),
]);
export const DEFAULT_PICKUP_CUTOFF = "15:30";

// 택배를 거치지 않고 나가는 길. 인계 화면의 '직접 전달'에서 고른다.
export const DIRECT_METHODS = ["퀵", "직접 배달", "방문 수령"];

// ── 살아 있는 목록 ──────────────────────────────────────────
let registry = DEFAULT_COURIERS.map(c => ({ ...c }));
export const COURIERS = registry.map(c => c.name);                                   // 이름 배열(안을 갈아 끼운다)
export const COURIER_SHORT = Object.fromEntries(registry.map(c => [c.name, c.short])); // 이름 → 줄임말
let pickupCutoff = DEFAULT_PICKUP_CUTOFF;                                            // 회사 하나의 수거 마감 "HH:MM"

const HHMM = /^\d{1,2}:\d{2}$/;
const formatFor = (name, f) => COURIER_FORMATS.includes(f) ? f : name === CJ ? "cj" : name === KD ? "kd" : "generic";

/** 회사 설정의 택배사 목록을 넣는다(SaasData 가 config.couriers 로 부른다). 이상한 항목은 버리고, 비면 기본 둘. */
export function setCouriers(list) {
  const seen = new Set();
  let next = (Array.isArray(list) ? list : []).map(c => {
    const name = String(c?.name || "").trim();
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const format = formatFor(name, c?.format);
    return { name, short: String(c?.short || "").trim() || name.slice(0, 2), format, ...(format === "kd" && (c?.payType === "선불" || c?.payType === "후불") ? { payType: c.payType } : {}) };
  }).filter(Boolean);
  if (!next.length) next = DEFAULT_COURIERS.map(c => ({ ...c }));
  registry = next;
  COURIERS.splice(0, COURIERS.length, ...next.map(c => c.name));
  for (const k of Object.keys(COURIER_SHORT)) delete COURIER_SHORT[k];
  for (const c of next) COURIER_SHORT[c.name] = c.short;
  return courierList();
}
/** 지금 목록(복사본) */
export const courierList = () => registry.map(c => ({ ...c }));
export const courierInfo = (name) => { const c = registry.find(x => x.name === name); return c ? { ...c } : null; };
/** 송장 엑셀 양식 — 목록에 없는 이름은 CJ·경동이면 그 양식, 아니면 범용 */
export const courierFormat = (name) => formatFor(name, registry.find(c => c.name === name)?.format);

/** 회사 설정(config.pickupCutoff)의 수거 마감을 넣는다 — SaasData 가 로드 때 부른다. "HH:MM" 만 받는다. */
export function setPickupCutoff(v) { if (HHMM.test(String(v || ""))) pickupCutoff = String(v); return pickupCutoff; }
export const getPickupCutoff = () => pickupCutoff;

// ── 메모에서 읽는 신호 ───────────────────────────────────────
// 일반 메모(note)와 담당자 메모(memo)만 본다. 배송지 메모(deliveryMessage)는 보지 않는다 —
// 그건 송장에 찍혀 기사가 읽는 글이라 "방문 전 연락 주세요" 같은 말이 흔하다.
// 그걸 '방문 수령'으로 읽으면 멀쩡한 택배 주문이 직접 전달로 빠진다.
const memoOf = (o) => `${o?.note || ""}\n${o?.memo || ""}`;

/** 메모에 '롤'이 있는가 — 택배사 판정에는 더 안 쓴다(2026-10-23). 컨트롤·스크롤처럼 다른 낱말에 든 '롤'은 뺀다. */
export const hasRollWord = (text) => String(text || "").replace(/컨트롤|스크롤|캐롤|롤러|롤링/g, "").includes("롤");
export const isRollOrder = (o) => hasRollWord(memoOf(o));

/**
 * 택배를 거치지 않는 주문인가 — 담당자가 '방문고객'이거나 메모에 방문·픽업이 적힌 주문.
 * 포장 화면의 '직접 전달'에 이 주문들만 보인다.
 */
export const hasPickupWord = (text) => /픽업|방문/.test(String(text || ""));
export const isPickupOrder = (o) => (o?.manager || "").trim() === "방문고객" || hasPickupWord(memoOf(o));

const boxKey = (o) => (o.mergeGroupId && !o.splitShipping ? `g:${o.mergeGroupId}` : `o:${o.id}`);

/**
 * 주문마다 택배사를 본다 → Map(주문 id → { courier, manual, why, pickup })
 *
 *   courier: 미리 지정했거나 송장을 뽑으며 기록된 택배사(목록에 있는 것만). 없으면 null — 송장 뽑을 때 고른다.
 *   why: "manual" 지정됨 / "none" 아직 없음
 *
 * 박스 단위로 본다. 합배송 묶음은 한 박스로 나가니 묶음 중 한 건의 지정이 전체에 적용된다.
 * 분리 배송으로 지정된 건은 따로 나가는 박스라 혼자 본다.
 *
 * pickup: 방문·픽업 주문이고 아직 송장을 안 뽑은 박스. 송장을 뽑았으면 택배로 나가는
 * 것이다 — 메모의 '방문'이 다른 뜻이었던 경우("방문 상담 후 주문")를 그렇게 걸러낸다.
 *
 * list 를 주면 그 목록으로 본다(SaasData 가 config.couriers 를 넘긴다 — 설정이 바뀌면 다시 계산되게).
 */
export function courierMap(orders, list) {
  const L = Array.isArray(list) && list.length ? list : registry;
  const names = new Set(L.map(c => c.name));
  const boxes = new Map();
  for (const o of orders || []) {
    const k = boxKey(o);
    if (!boxes.has(k)) boxes.set(k, []);
    boxes.get(k).push(o);
  }
  const out = new Map();
  for (const os of boxes.values()) {
    const manual = os.map(o => o.courier).find(c => names.has(c)) || null;
    const pickup = os.some(isPickupOrder) && !os.some(o => o.invoicePrintedAt);
    const full = { courier: manual, why: manual ? "manual" : "none", manual: !!manual, pickup };
    for (const o of os) out.set(o.id, full);
  }
  return out;
}

/** 주문 하나의 택배사. 목록을 돌 때는 courierMap 을 한 번 만들어 쓰는 게 빠르다. */
export function courierOf(order, orders) {
  return courierMap(orders && orders.length ? orders : [order]).get(order.id);
}

/**
 * 그 시각 이후 지금까지 놓친 수거 횟수(회사 수거 마감 기준).
 *
 * "며칠째"로 세면 안 되는 이유: 오후 4시에 싼 박스는 다음 날 오후 3시 반까지
 * 안 나간 게 정상이다. 날짜로 세면 다음 날 아침에 이미 '1일째'가 되어, 매일 아침
 * 전날 오후 물량이 전부 문제로 뜬다. 수거를 한 번이라도 놓쳤을 때만 문제다.
 *
 * 수거는 영업일에만 온다 — 주말·공휴일·회사휴무일은 세지 않는다.
 */
export function missedPickups(since, now = new Date()) {
  const from = since ? new Date(since) : null;
  if (!from || isNaN(from)) return 0;
  const [hh, mm] = pickupCutoff.split(":").map(Number);
  let n = 0;
  // 하루씩 넘기며 그날의 마감 시각이 (since, now] 안에 드는지 본다. 2년이면 충분하다.
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()), i = 0; i < 730; d = addDays(d, 1), i++) {
    const cut = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
    if (cut > now) break;
    if (cut > from && isBusinessDay(d)) n++;
  }
  return n;
}

// ── 옛 회사 모드(ErpApp·src/components) 전용 ─────────────────────────────
// 우리 회사(로하이마켓)는 "메모에 롤이면 경동, 아니면 CJ" 규칙과 택배사별 수거 마감을 그대로 쓴다. 구독형 화면은 쓰지 않는다.
export const PICKUP_CUTOFF = { [CJ]: "15:30", [KD]: "17:30" };
/** 옛 자동 판정 — 등록 화면용. 메모만 받는다. */
export function autoCourier(memoText) {
  return hasRollWord(memoText) ? { courier: KD, why: "roll" } : { courier: CJ, why: "default" };
}
/** 옛 판정: 직접 지정 → 메모의 '롤'(경동) → CJ. 박스(묶음) 단위. ErpApp·PackingTab 이 courierMap 대신 쓴다. */
export function legacyCourierMap(orders) {
  const boxes = new Map();
  for (const o of orders || []) {
    const k = boxKey(o);
    if (!boxes.has(k)) boxes.set(k, []);
    boxes.get(k).push(o);
  }
  const out = new Map();
  for (const os of boxes.values()) {
    const manual = os.map(o => o.courier).find(c => c === CJ || c === KD);
    const pickup = os.some(isPickupOrder) && !os.some(o => o.invoicePrintedAt);
    const v = manual ? { courier: manual, why: "manual" } : os.some(isRollOrder) ? { courier: KD, why: "roll" } : { courier: CJ, why: "default" };
    const full = { ...v, manual: v.why === "manual", pickup };
    for (const o of os) out.set(o.id, full);
  }
  return out;
}
