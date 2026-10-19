// 택배사 판정 — 어느 박스가 CJ 로 가고 어느 박스가 경동으로 가는가.
//
// 택배사는 송장을 뽑을 때가 아니라 주문을 받을 때 정해진다. 소량(재단해서 봉지에 담는 것)은
// CJ, 롤 단위 대량은 경동이다. 그런데 ERP 에는 택배사를 적는 칸이 없어서, 셀러가 머릿속으로
// 정한 것을 관리자가 송장 출력 창에서 주문을 하나씩 골라 다시 판단하고 있었다.
//
// 그래서 메모의 '롤'로 자동 판정하고(롤이면 경동, 아니면 CJ), 안 맞는 경우만 사람이 고른다.
// 전에는 배송비 7,000원부터 경동으로도 잡았는데, 2026-10-12 사용자 결정으로 뺐다 —
// 기준은 '직접 지정 → 메모의 롤' 둘뿐이다. 배송비는 택배사와 무관하다.

import { isBusinessDay, addDays } from "./shipDate.js";

export const CJ = "CJ대한통운";
export const KD = "경동화물";
export const COURIERS = [CJ, KD];
export const COURIER_SHORT = { [CJ]: "CJ", [KD]: "경동" };

// 택배를 거치지 않고 나가는 길. 인계 화면의 '직접 전달'에서 고른다.
export const DIRECT_METHODS = ["퀵", "직접 배달", "방문 수령"];

// 수거 마감 — 이 시각이 지났는데 남아 있으면 그날 수거를 놓친 것이다.
// 기사가 오는 시각은 매일 조금씩 다르다(CJ 14:30~15:30, 경동 16:00~17:30).
// 가장 늦은 쪽에 맞춘다: 이르게 잡으면 아직 기사가 안 왔는데 '놓쳤다'고 뜬다.
export const PICKUP_CUTOFF = { [CJ]: "15:30", [KD]: "17:30" };
/** 회사 설정(settings.data.saas.pickupCutoff)으로 마감 시각을 바꾼다 — SaasData 가 로드 때 부른다. "HH:MM" 만 받는다. */
export function setPickupCutoffs(map) {
  for (const [k, v] of Object.entries(map || {})) {
    if ((k === CJ || k === KD) && /^\d{1,2}:\d{2}$/.test(String(v))) PICKUP_CUTOFF[k] = String(v);
  }
}

// ── 메모에서 읽는 신호 ───────────────────────────────────────
// 일반 메모(note)와 담당자 메모(memo)만 본다. 배송지 메모(deliveryMessage)는 보지 않는다 —
// 그건 송장에 찍혀 기사가 읽는 글이라 "방문 전 연락 주세요" 같은 말이 흔하다.
// 그걸 '방문 수령'으로 읽으면 멀쩡한 택배 주문이 직접 전달로 빠진다.
const memoOf = (o) => `${o?.note || ""}\n${o?.memo || ""}`;

/**
 * 메모에 '롤'이 있는가 — 롤발송·롤배송·1롤 등. 롤 단위는 경동으로 나간다.
 * 컨트롤·스크롤처럼 다른 낱말에 든 '롤'은 뺀다.
 * (정규식 뒤보기(?<!)는 쓰지 않는다 — 옛 아이폰 사파리가 못 읽어 화면이 통째로 안 뜬다)
 */
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
 * 주문마다 택배사를 정한다 → Map(주문 id → { courier, manual, why, pickup })
 *
 * 정하는 순서: 사람이 직접 고른 값 → 메모의 '롤' → 그 외는 CJ.
 *   why: "manual" 직접 지정 / "roll" 메모에 롤 / "default" 둘 다 아님(CJ)
 *
 * 박스 단위로 판정한다. 합배송 묶음은 한 박스로 나가니 한 건에만 '롤'이 적혀 있어도 묶음 전체가
 * 경동이고, 직접 지정도 묶음 중 한 건의 값이 전체에 적용된다.
 *
 * 분리 배송으로 지정된 건은 따로 나가는 박스라 혼자 판정한다.
 *
 * pickup: 방문·픽업 주문이고 아직 송장을 안 뽑은 박스. 송장을 뽑았으면 택배로 나가는
 * 것이다 — 메모의 '방문'이 다른 뜻이었던 경우("방문 상담 후 주문")를 그렇게 걸러낸다.
 */
export function courierMap(orders) {
  const boxes = new Map();
  for (const o of orders || []) {
    const k = boxKey(o);
    if (!boxes.has(k)) boxes.set(k, []);
    boxes.get(k).push(o);
  }
  const out = new Map();
  for (const os of boxes.values()) {
    const manual = os.map(o => o.courier).find(c => COURIERS.includes(c));
    const pickup = os.some(isPickupOrder) && !os.some(o => o.invoicePrintedAt);
    const v = manual ? { courier: manual, why: "manual" }
      : os.some(isRollOrder) ? { courier: KD, why: "roll" }
      : { courier: CJ, why: "default" };
    const full = { ...v, manual: v.why === "manual", pickup };
    for (const o of os) out.set(o.id, full);
  }
  return out;
}

/** 주문 하나의 택배사. 목록을 돌 때는 courierMap 을 한 번 만들어 쓰는 게 빠르다. */
export function courierOf(order, orders) {
  return courierMap(orders && orders.length ? orders : [order]).get(order.id);
}

/** 등록 화면용 — 아직 저장 전인 값으로 '자동'이 무엇이 될지. */
export function autoCourier(memoText) {
  return hasRollWord(memoText) ? { courier: KD, why: "roll" } : { courier: CJ, why: "default" };
}

/**
 * 그 시각 이후 지금까지 놓친 수거 횟수.
 *
 * "며칠째"로 세면 안 되는 이유: 오후 4시에 싼 CJ 박스는 다음 날 오후 3시 반까지
 * 안 나간 게 정상이다. 날짜로 세면 다음 날 아침에 이미 '1일째'가 되어, 매일 아침
 * 전날 오후 물량이 전부 문제로 뜬다. 수거를 한 번이라도 놓쳤을 때만 문제다.
 *
 * 수거는 영업일에만 온다 — 주말·공휴일·회사휴무일은 세지 않는다.
 */
export function missedPickups(since, courier, now = new Date()) {
  const from = since ? new Date(since) : null;
  if (!from || isNaN(from)) return 0;
  const [hh, mm] = (PICKUP_CUTOFF[courier] || PICKUP_CUTOFF[CJ]).split(":").map(Number);
  let n = 0;
  // 하루씩 넘기며 그날의 마감 시각이 (since, now] 안에 드는지 본다. 2년이면 충분하다.
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()), i = 0; i < 730; d = addDays(d, 1), i++) {
    const cut = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
    if (cut > now) break;
    if (cut > from && isBusinessDay(d)) n++;
  }
  return n;
}
