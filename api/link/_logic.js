// 링크 주문 서버 함수의 판정 로직 — 순수 함수. DB 도 Node 도 없다.
//
// 확장자는 .js 여야 한다(.mjs 아님). Vercel 이 api/*.js 를 CommonJS 로 묶는데, 거기서 .mjs 를 부르면
// require() of ES Module 오류로 함수가 통째로 죽는다(2026-10-02 첫 배포에서 /api/roll·/api/link/* 가 전부 500).
//
// 서버 함수(product·customer·draft)는 PGlite 로 못 돌리므로 "무엇을 어떻게 판정하는가"를
// 여기 떼어 두고 tests/link/ 에서 그대로 돌린다. 핸들러는 조회·응답만 한다.
// 공개 페이지(src/public/OrderLink.jsx)도 택배비 표시에 같은 함수를 쓴다 — 서버와 어긋나지 않게.

export const DEFAULT_BASE_FEE = 4000;
export const VERIFY_WINDOW_MS = 30 * 60 * 1000;   // 인증 뒤 30분 안에만 고객 조회·초안 저장
export const DRAFT_RATE_LIMIT = { limit: 3, windowMs: 60 * 1000 };   // 같은 번호로 1분 안에 3건까지

/** 숫자만. "010-1234-5678" → "01012345678" */
export const normPhone = (s) => String(s || "").replace(/\D/g, "");

/** 둘 다 번호가 있고 숫자만 비교해 같은가 */
export const phonesMatch = (a, b) => { const x = normPhone(a), y = normPhone(b); return !!x && !!y && x === y; };

/** 보기 좋은 전화번호. 11자리면 010-1234-5678, 아니면 그대로 */
export function formatPhone(digits) {
  const d = normPhone(digits);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

/** 설정에서 기본 택배비. settings.data.freight.baseFee, 없거나 0 이면 4000 (3단계와 같은 정의) */
export const baseFeeFromSettings = (data) => Number(data?.freight?.baseFee) || DEFAULT_BASE_FEE;

/**
 * 인증된 번호인가 — phone_verifications 의 그 번호 행들 중 verified=true 이고
 * created_at 이 30분 이내인 것이 하나라도 있으면 true.
 */
export function isVerifiedRecently(rows, now = Date.now()) {
  return (rows || []).some(r => {
    if (!r?.verified) return false;
    const t = Date.parse(r.created_at || r.createdAt || "");
    return Number.isFinite(t) && now - t <= VERIFY_WINDOW_MS && now - t >= -60_000;
  });
}

/**
 * 합배송 후보 조건 — src/lib/autoMerge.js findMergeCandidates 의 제외 조건을 옮긴 것
 * (그 함수는 브라우저용 주문 모양을 받아 여기서 import 하지 않는다. 조건이 바뀌면 둘 다 고친다):
 *   출고완료 아님 · 환불 아님 · 분리배송 아님 · 같은 전화번호.
 * 3단계 규칙 1: 포장완료도 후보다(박스를 다시 연다).
 */
export function isMergeCandidate(row, phone) {
  if (!row) return false;
  if (row.status === "출고완료") return false;
  if (row.payment === "환불") return false;
  if (row.payment_status === "환불완료" || row.paymentStatus === "환불완료") return false;
  if (row.split_shipping || row.splitShipping) return false;
  return phonesMatch(row.phone, phone);
}

/** 품목 한 줄 요약 — "린넨 베이지 3마, 쉬폰 2마" */
export function summarizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(i => `${i?.fabric || ""}${i?.color ? ` ${i.color}` : ""} ${i?.qty ?? ""}${i?.unit || "마"}`.trim())
    .filter(Boolean).join(", ");
}

/** 고객에게 보여줄 후보 한 건. 다른 고객 정보가 섞이지 않게 필요한 칸만. */
export function candidateView(row) {
  return {
    id: row.id, date: row.date || "", items: summarizeItems(row.items), status: row.status || "",
    shipDate: row.ship_date ?? row.shipDate ?? null, isUrgent: !!(row.is_urgent ?? row.isUrgent),
    address: row.address || "", addressDetail: row.address_detail ?? row.addressDetail ?? "",
    mergeGroupId: row.merge_group_id ?? row.mergeGroupId ?? null,
  };
}

/**
 * 후보를 "함께 보내기" 선택지로 묶는다 — 이미 합배송으로 묶인 주문들은 한 박스이므로 한 선택지.
 * 고객이 그 박스에 넣겠다고 고르면 되지, 그 안의 어느 주문인지 고를 이유가 없다.
 * 반환: [{ key, orderId(대표 — 서버에 보내는 merge_with_order_id), orders: [후보…], grouped }]
 * 그룹이 아닌 후보는 각각 한 선택지. 순서는 들어온 순서(최근 주문 먼저)를 유지한다.
 */
export function groupCandidates(candidates) {
  const out = [], byGid = new Map();
  for (const c of candidates || []) {
    const gid = c?.mergeGroupId || null;
    if (!gid) { out.push({ key: `o:${c.id}`, orderId: c.id, orders: [c], grouped: false }); continue; }
    if (!byGid.has(gid)) { const u = { key: `g:${gid}`, orderId: c.id, orders: [], grouped: true }; byGid.set(gid, u); out.push(u); }
    byGid.get(gid).orders.push(c);
  }
  for (const u of out) if (u.grouped && u.orders.length === 1) u.grouped = false;   // 그룹인데 혼자 남은 건 — 보통 주문처럼
  return out;
}

/**
 * 무료배송권 — 이름으로 찾는다(free_shipping_coupons.customer = 이름).
 * 같은 이름의 고객이 둘 이상이면 남의 배송권이 보일 수 있으므로 0 + nameAmbiguous.
 *   sameNameCount  customers 에서 그 이름인 고객 수
 *   couponRows     그 이름의 free_shipping_coupons 행들
 */
export function couponCountFor(sameNameCount, couponRows) {
  if ((sameNameCount || 0) >= 2) return { count: 0, nameAmbiguous: true };
  const count = (couponRows || []).reduce((s, r) => s + (Number(r?.count) || 0), 0);
  return { count: Math.max(0, count), nameAmbiguous: false };
}

/**
 * 적립금 잔액 — 배송권과 같은 규칙(이름으로 묶여 있어 동명이인이면 0 + nameAmbiguous).
 *   creditRows  그 이름의 credits 행들 { amount, type }  — 잔액 = Σ(적립) − Σ(사용). DepositTab getCreditBalance 와 같은 계산.
 */
export function creditBalanceFor(sameNameCount, creditRows) {
  if ((sameNameCount || 0) >= 2) return { balance: 0, nameAmbiguous: true };
  const balance = (creditRows || []).reduce((s, r) => s + ((r?.type === "적립" ? 1 : -1) * (Number(r?.amount) || 0)), 0);
  return { balance: Math.max(0, balance), nameAmbiguous: false };
}

/**
 * 이번 주문에 쓸 적립금 — 요청액을 잔액과 주문 금액(원단 + 택배비) 안으로 깎는다.
 * 롤 주문처럼 금액을 모르면(priceKnown=false) 0 — 얼마까지 쓸 수 있는지 알 수 없다. 셀러가 전환할 때 적는다.
 */
export function computeCreditUse({ requested = 0, balance = 0, orderTotal = 0, priceKnown = true } = {}) {
  if (!priceKnown) return 0;
  const want = Math.max(0, Math.floor(Number(requested) || 0));
  return Math.max(0, Math.min(want, Number(balance) || 0, Number(orderTotal) || 0));
}

/** 롤 목록 → 지금 주문 가능 최대(가장 긴 available 롤)와 롤 수. rollStock.js summarizeRolls 와 같은 정의. */
export function maxRemainingOf(rolls) {
  const avail = (rolls || []).filter(r => r?.status === "available");
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const maxRemaining = Math.round(avail.reduce((m, r) => Math.max(m, num(r.length_remaining ?? r.lengthRemaining)), 0) * 100) / 100;
  return { maxRemaining, availableCount: avail.length };
}

/** 고객에게 보여줄 롤 목록 — 판매 가능하고 잔량이 있는 것만, 롤 번호 순. { id, rollCode, length } */
export function publicRollsView(rolls) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return (rolls || [])
    .filter(r => r?.status === "available" && num(r.length_remaining ?? r.lengthRemaining) > 0 && (r.id !== undefined && r.id !== null))
    .map(r => ({ id: String(r.id), rollCode: r.roll_code || r.rollCode || "", length: Math.round(num(r.length_remaining ?? r.lengthRemaining) * 100) / 100 }))
    .sort((a, b) => a.rollCode.localeCompare(b.rollCode));
}

/**
 * 고객이 고른 롤 — 지금 판매 가능한 롤 안에서만, 중복 없이, 1개 이상.
 * 반환 { ok, rolls: [{ id, rollCode, length }], totalLength, reason }
 */
export function pickRolls(rollIds, rolls) {
  const avail = publicRollsView(rolls);
  const byId = new Map(avail.map(r => [r.id, r]));
  const ids = [...new Set((Array.isArray(rollIds) ? rollIds : []).map(v => String(v || "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, rolls: [], totalLength: 0, reason: "롤을 하나 이상 골라 주세요" };
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) return { ok: false, rolls: [], totalLength: 0, reason: "고른 롤 중 지금은 주문할 수 없는 롤이 있습니다. 목록을 다시 확인해 주세요." };
  const picked = ids.map(id => byId.get(id));
  const totalLength = Math.round(picked.reduce((s, r) => s + r.length, 0) * 100) / 100;
  return { ok: true, rolls: picked, totalLength, reason: "" };
}

/** 상품 응답 — 공개 페이지가 받는 모양. 가격 없으면 unitPrice null. rolls 는 고객이 고를 롤 목록. */
export function productView(product, rolls, baseFee) {
  const { maxRemaining, availableCount } = maxRemainingOf(rolls);
  const up = product?.unit_price ?? product?.unitPrice;
  return {
    code: product.code, name: product.name, color: product.color || "", photoUrl: product.photo_url ?? product.photoUrl ?? "",
    unit: product.unit || "마", unitPrice: up === null || up === undefined || up === "" ? null : Number(up),
    maxRemaining, availableCount, baseFee: Number(baseFee) || DEFAULT_BASE_FEE,
    rolls: publicRollsView(rolls),
  };
}

/** 주문 단위. 마 = 롤에서 잘라 나감(최대 = 가장 긴 롤), 롤 = 통째(최대 = 판매 가능 롤 수). */
export const ORDER_UNITS = ["마", "롤"];
export const normUnit = (u) => (ORDER_UNITS.includes(String(u || "").trim()) ? String(u).trim() : "마");

/** 단위별 최대 — 마는 가장 긴 롤의 잔량, 롤은 판매 가능 롤 수. */
export function maxFor(unit, { maxRemaining = 0, availableCount = 0 } = {}) {
  return normUnit(unit) === "롤" ? (Number(availableCount) || 0) : (Number(maxRemaining) || 0);
}

/**
 * 수량 검사 — 정수만(마든 롤이든 1 단위). 0 이하 거부. 단위별 최대를 넘으면 거부.
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function validateQty(qty, max, unit = "마") {
  const u = normUnit(unit);
  const s = String(qty ?? "").trim();
  if (!s) return { ok: false, reason: "수량을 입력해 주세요" };
  if (!/^\d+$/.test(s)) return { ok: false, reason: "수량은 1 단위 정수로 입력해 주세요" };
  const v = Number(s);
  if (!(v > 0)) return { ok: false, reason: "수량은 0보다 커야 합니다" };
  const m = Number(max) || 0;
  if (v > m) return { ok: false, reason: u === "롤" ? `주문 가능한 롤은 ${m}롤입니다` : `최대 재단 가능 ${m}마` };
  return { ok: true, value: v };
}

/**
 * 택배비 — 3단계 규칙.
 *   무료배송권을 쓰고 보유가 있으면 0.
 *   합배송 대상을 골랐으면 0 (그 그룹의 부담자가 이미 있다. 등록 때 재계산이 다시 확인한다).
 *   아니면 단위별 고정값(마 4,000 · 롤 7,000).
 */
export const ROLL_BASE_FEE = 7000;   // 롤은 부피가 커서 경동 — 7,000원부터 경동(실제 출고 업무)

/** 공개 링크 택배비 기본값 — 단위로 고정(2026-10-07 사용자 결정): 마 4,000 · 롤 7,000. 설정의 baseFee 는 안 본다. */
export const baseFeeForUnit = (unit) => (String(unit || "").trim() === "롤" ? ROLL_BASE_FEE : DEFAULT_BASE_FEE);

export function computeShippingFee({ useFreeShipping = false, couponCount = 0, mergeWithOrderId = null, unit = "마" } = {}) {
  if (useFreeShipping && (Number(couponCount) || 0) > 0) return 0;
  if (mergeWithOrderId) return 0;
  return baseFeeForUnit(unit);
}

/** 합계 — round(단가 × 수량) + 택배비. 단가 없으면 원단 금액은 0(셀러가 안내). */
export function computeTotal(unitPrice, qty, shippingFee) {
  const up = unitPrice === null || unitPrice === undefined || unitPrice === "" ? null : Number(unitPrice);
  const goods = up === null ? 0 : Math.round(up * (Number(qty) || 0));
  return { goods, total: goods + (Number(shippingFee) || 0), priceKnown: up !== null };
}

/** 같은 번호로 1분 안에 limit 건 이상이면 true (429). createdAts: 최근 초안들의 created_at */
export function tooManyRecent(createdAts, now = Date.now(), { limit, windowMs } = DRAFT_RATE_LIMIT) {
  const n = (createdAts || []).filter(t => { const x = Date.parse(t); return Number.isFinite(x) && now - x <= windowMs; }).length;
  return n >= limit;
}

/** 초안 입력값 정리 — 서버가 믿는 것은 이것뿐. 가격·재고·택배비는 서버가 다시 찍는다. */
export function cleanDraftInput(body) {
  const b = body || {};
  const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  return {
    code: str(b.code, 64), qty: str(b.qty, 16), unit: normUnit(b.unit), phone: normPhone(b.phone),
    customerName: str(b.customerName, 60), depositorName: str(b.depositorName, 60),
    address: str(b.address, 200), addressDetail: str(b.addressDetail, 200),
    deliveryMessage: str(b.deliveryMessage, 300), mergeWithOrderId: str(b.mergeWithOrderId, 64) || null,
    useFreeShipping: !!b.useFreeShipping,
    creditUse: Math.max(0, Math.floor(Number(b.creditUse) || 0)),   // 적립금 사용 요청액 — 서버가 잔액·금액 안으로 다시 깎는다
    rollIds: (Array.isArray(b.rollIds) ? b.rollIds : []).map(v => str(v, 64)).filter(Boolean).slice(0, 50),   // 롤 주문: 고른 롤 id
    managerId: String(b.managerId ?? "").replace(/[^0-9a-fA-F-]/g, "").slice(0, 36),   // 링크를 복사한 담당자(managers.id, uuid) — 서버가 이름으로 바꿔 created_by 에
    privacyAgreed: b.privacyAgreed === true,   // 문자열 "true" 같은 건 안 받는다 — 체크박스가 보낸 boolean 만
  };
}

// ── 셀러 링크(쪽지) — 토큰이 곧 인증 ──
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

/** 토큰 모양 — randomUUID 둘을 이어 '-' 를 뺀 64자 hex(지시서 3-1). 그보다 짧은 32자 hex 도 받는다. */
export const isValidToken = (t) => /^[0-9a-f]{32,64}$/i.test(String(t || ""));

/**
 * 주문서 상태 판정.
 *   missing   행 없음 → 404
 *   expired   offered 인데 expires_at 지남(또는 이미 expired) → 410
 *   confirmed new·converted → 409 "이미 주문하셨습니다"
 *   closed    rejected → 410
 *   ok        offered, 안 지남
 */
export function offerState(row, now = Date.now()) {
  if (!row) return "missing";
  if (row.status === "expired") return "expired";
  if (row.status === "new" || row.status === "converted") return "confirmed";
  if (row.status === "rejected") return "closed";
  const exp = Date.parse(row.expires_at || row.expiresAt || "");
  if (Number.isFinite(exp) && exp < now) return "expired";
  return row.status === "offered" ? "ok" : "closed";
}

/** 셀러 링크 품목 — ERP 폼의 품목을 초안 items 로. 금액은 단가×수량(없으면 적힌 금액). */
export function sellerItems(items) {
  return (items || []).filter(it => it && (it.productId || it.code || it.itemNo)).map(it => {
    const qty = Number(it.qty) || 0, unitPrice = Number(it.unitPrice) || 0;
    return {
      productId: it.productId || null, code: it.code || it.itemNo || "", name: it.name || it.fabric || "", color: it.color || "",
      qty, unit: it.unit || "마", unitPrice, amount: unitPrice > 0 ? Math.round(unitPrice * qty) : (Number(it.amount) || 0),
    };
  });
}

/** 셀러 링크 합계 — 품목 금액 합 + 택배비 */
export function sellerTotal(items, shippingFee) {
  const goods = (items || []).reduce((s, i) => s + (Number(i?.amount) || 0), 0);
  return { goods, total: goods + (Number(shippingFee) || 0) };
}

/** 고객에게 보여줄 주문서 — 전화는 뒷4자리만. 토큰이 인증이라 주소는 그대로. */
export function offerView(row, { mergeWith = null, photos = {} } = {}) {
  const items = (Array.isArray(row.items) && row.items.length ? row.items : [{
    productId: row.product_id, code: row.product_code, name: row.product_name, color: "", qty: Number(row.qty) || 0, unit: row.unit || "마",
    unitPrice: row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    amount: row.unit_price === null || row.unit_price === undefined ? 0 : Math.round(Number(row.unit_price) * (Number(row.qty) || 0)),
  }]).map(i => ({ ...i, photoUrl: photos[i.productId] || "" }));
  const phone = normPhone(row.phone);
  return {
    draftId: row.id, customerName: row.customer_name || "", phoneTail: phone.slice(-4),
    items, address: row.address || "", addressDetail: row.address_detail || "", deliveryMessage: row.delivery_message || "",
    shippingFee: Number(row.shipping_fee) || 0, useFreeShipping: !!row.use_free_shipping,
    mergeWith, totalAmount: Number(row.total_amount) || 0,
    priceKnown: items.every(i => i.unitPrice !== null && i.unitPrice !== undefined && Number(i.unitPrice) > 0),
    expiresAt: row.expires_at || null, createdBy: row.created_by || "",
  };
}

/** confirm 입력 정리 — 안 보낸 칸은 null(그대로 둔다는 뜻). */
export function cleanConfirmInput(body) {
  const b = body || {};
  const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
  const has = (k) => b[k] !== undefined && b[k] !== null;
  return {
    token: str(b.token, 80),
    qty: has("qty") && str(b.qty, 16) !== "" ? str(b.qty, 16) : null,
    address: has("address") ? str(b.address, 200) : null,
    addressDetail: has("addressDetail") ? str(b.addressDetail, 200) : null,
    deliveryMessage: has("deliveryMessage") ? str(b.deliveryMessage, 300) : null,
  };
}

/**
 * 고객이 주문서의 수량을 고쳤을 때 — 줄이는 것만. 늘리면 400(셀러가 정한 양을 넘지 못한다).
 * 최대 재단 가능도 다시 본다(그 사이 롤이 팔렸을 수 있다).
 */
export function confirmQtyCheck(newQty, originalQty, max, unit = "마") {
  const v = validateQty(newQty, max, unit);
  if (!v.ok) return v;
  const orig = Number(originalQty) || 0;
  if (v.value > orig) return { ok: false, reason: `수량은 ${orig}${unit}까지만 가능합니다. 더 필요하면 셀러에게 말씀해 주세요.` };
  return v;
}

/** 개인정보 수집·이용 안내 — 페이지가 보여주는 문구. 서버와 페이지가 같은 내용을 가리키도록 여기 둔다. */
export const PRIVACY_NOTICE = {
  title: "개인정보 수집·이용 동의",
  items: [
    ["수집 항목", "이름, 전화번호, 주소(상세주소 포함), 입금자명, 배송 메모"],
    ["수집·이용 목적", "주문 확인, 입금 안내, 상품 배송, 배송 관련 연락"],
    ["보유·이용 기간", "주문 처리 완료 후 전자상거래법 등 관련 법령이 정한 기간(계약·결제·공급 기록 5년)까지 보관 후 파기"],
    ["제3자 제공", "배송을 위해 택배사(CJ대한통운·경동화물 등)에 이름·전화번호·주소를 제공하며, 그 외 목적으로 제공하지 않습니다"],
    ["동의 거부", "동의하지 않을 수 있으나, 동의하지 않으면 주문 접수가 되지 않습니다"],
  ],
  footer: "수집한 개인정보는 위 목적 외에 사용하지 않으며, 마케팅·광고에 쓰지 않습니다.",
};

// ── 롤 정보 공개 화면(/r/{롤번호}) — 핸드폰으로 롤 QR 을 찍은 방문 고객이 본다 ──
/**
 * 고객에게 보여줄 롤 정보. 공급처·위치·입고일·검단자·매입가는 싣지 않는다(2026-10-02 결정).
 * 남은 길이와 롤 가격(남은 길이 × 마당 단가)은 판매 가능·예약 롤에만 — 끝난 롤·검단 전 롤은 상태만.
 *   roll     stock_rolls 행 { roll_code, status, length_remaining }
 *   product  products 행 { code, name, color, photo_url, unit, unit_price } — 없으면 이름 "원단"
 */
export function rollPublicView(roll, product) {
  const status = String(roll?.status || "received");
  const showLength = status === "available" || status === "reserved";
  const rem = Number(roll?.length_remaining);
  const lengthRemaining = showLength && Number.isFinite(rem) && rem > 0 ? Math.round(rem * 100) / 100 : null;
  const up = product?.unit_price;
  const unitPrice = up === null || up === undefined || up === "" || !(Number(up) > 0) ? null : Number(up);
  return {
    rollCode: roll?.roll_code || "",
    productCode: product?.code || "",
    name: product?.name || "원단",
    color: product?.color || "",
    photoUrl: product?.photo_url || "",
    unit: product?.unit || "마",
    status,
    available: status === "available" && lengthRemaining !== null,
    lengthRemaining,
    unitPrice,
    rollPrice: unitPrice !== null && lengthRemaining !== null ? Math.round(unitPrice * lengthRemaining) : null,
  };
}
