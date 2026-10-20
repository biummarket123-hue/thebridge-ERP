// 채널 주문 엑셀(쿠팡 윙·네이버 스마트스토어·일반 양식) → 정규화 주문. 순수 함수 — DB·React·엑셀 라이브러리 없음, tests/ 에서 그대로 돈다.
//
// 흐름:  headerRowIndex(aoa) → detectPreset(headers) → autoMap(headers, presetKey) → mapRows(headers, rows, presetKey, mapping) → dedupe(list, existingIds)
//        → toErpOrder(order, ctx) 로 db.insertOrder 에 넣을 모양을 만든다.
// AI 를 쓰지 않는다(사용자 결정 2026-10-20) — 컬럼명을 고정 표로 맞추고, 못 찾은 칸은 화면에서 사람이 고른다.
// 같은 판매처·같은 채널 주문번호는 건너뛴다(orders_channel_order_uq, migrations/saas_features.sql).

/** 화면 매핑 표의 칸. k 는 내부 키, l 은 사람이 보는 이름. req 가 없으면 비워 둬도 된다. */
export const FIELDS = [
  { k: "orderId", l: "주문번호", req: true },
  { k: "customer", l: "수취인(받는 분)", req: true },
  { k: "buyer", l: "구매자" },
  { k: "phone", l: "수취인 연락처" },
  { k: "phone2", l: "구매자 연락처" },
  { k: "zip", l: "우편번호" },
  { k: "address", l: "주소" },
  { k: "addressDetail", l: "상세 주소" },
  { k: "product", l: "상품명", req: true },
  { k: "option", l: "옵션(색상)" },
  { k: "qty", l: "수량" },
  { k: "unitPrice", l: "단가" },
  { k: "amount", l: "상품 금액" },
  { k: "shippingFee", l: "배송비" },
  { k: "deliveryMessage", l: "배송 메시지" },
  { k: "orderedAt", l: "주문일시" },
  { k: "status", l: "주문 상태" },
  { k: "note", l: "메모" },
];

/**
 * 양식. columns[k] 는 그 칸으로 인정할 헤더 이름들 — 앞쪽일수록 우선. 정확히 같은 이름을 먼저 찾고, 없으면 포함(contains)으로 찾는다.
 * signature 는 "이 양식이다" 라고 판정하는 데 쓰는 특징 헤더. detectPreset 이 센다.
 */
export const PRESETS = {
  coupang: {
    key: "coupang", channel: "쿠팡", label: "쿠팡 윙 (발주서·배송관리 엑셀)",
    signature: ["묶음배송번호", "노출상품명(옵션명)", "등록상품명", "등록옵션명", "구매수(수량)", "옵션판매가(판매단가)", "수취인이름", "수취인전화번호", "수취인 주소", "배송메세지", "결제액", "구매자전화번호"],
    columns: {
      orderId: ["주문번호"],
      customer: ["수취인이름", "수취인 이름", "수취인명", "수취인"],
      buyer: ["구매자", "구매자명"],
      phone: ["수취인전화번호", "수취인 전화번호", "수취인연락처"],
      phone2: ["구매자전화번호", "구매자 전화번호", "통관용구매자전화번호"],
      zip: ["우편번호"],
      address: ["수취인 주소", "수취인주소", "주소"],
      product: ["등록상품명", "노출상품명(옵션명)", "노출상품명", "상품명"],
      option: ["등록옵션명", "옵션명"],
      qty: ["구매수(수량)", "구매수", "수량"],
      unitPrice: ["옵션판매가(판매단가)", "옵션판매가", "판매단가"],
      amount: ["결제액"],
      shippingFee: ["배송비"],
      deliveryMessage: ["배송메세지", "배송메시지", "상품별 추가메시지"],
      orderedAt: ["주문일", "주문일시"],
      status: ["주문상태", "배송상태"],
      note: ["주문자 추가메시지", "기타"],
    },
  },
  smartstore: {
    key: "smartstore", channel: "스마트스토어", label: "네이버 스마트스토어 (발주/발송관리 엑셀)",
    signature: ["상품주문번호", "구매자ID", "수취인명", "옵션정보", "상품별 총 주문금액", "배송비 합계", "배송비 묶음번호", "수취인연락처1", "배송지", "클레임상태", "정산예정금액", "발송기한"],
    columns: {
      orderId: ["주문번호", "상품주문번호"],
      customer: ["수취인명", "수취인"],
      buyer: ["구매자명", "구매자"],
      phone: ["수취인연락처1", "수취인연락처", "수취인 연락처"],
      phone2: ["수취인연락처2", "구매자연락처"],
      zip: ["우편번호"],
      address: ["배송지", "기본배송지", "통합배송지"],
      addressDetail: ["상세배송지"],
      product: ["상품명"],
      option: ["옵션정보", "옵션"],
      qty: ["수량"],
      unitPrice: ["상품가격", "옵션가격"],
      amount: ["상품별 총 주문금액", "총 주문금액"],
      shippingFee: ["배송비 합계", "배송비"],
      deliveryMessage: ["배송메세지", "배송메시지", "배송 메모"],
      orderedAt: ["주문일시", "결제일"],
      status: ["클레임상태", "주문상태", "상품주문상태"],
      note: ["판매자 상품코드"],
    },
  },
  generic: {
    key: "generic", channel: "자사몰", label: "일반 양식 (주문번호·고객·상품·수량·금액)",
    signature: ["주문번호", "고객명", "수취인", "상품명", "원단", "수량", "금액"],
    columns: {
      orderId: ["주문번호", "주문 번호", "order id", "order no", "orderid"],
      customer: ["수취인", "받는분", "받는 분", "고객명", "고객", "이름", "성명", "name"],
      buyer: ["구매자", "주문자"],
      phone: ["수취인연락처", "연락처", "전화번호", "전화", "휴대폰", "phone", "tel"],
      phone2: ["구매자연락처", "주문자연락처"],
      zip: ["우편번호", "zip"],
      address: ["배송지", "주소", "address"],
      addressDetail: ["상세주소", "상세 주소"],
      product: ["상품명", "원단명", "원단", "품명", "품목", "product", "item"],
      option: ["옵션", "색상", "컬러", "color", "option"],
      qty: ["수량", "마수", "qty", "quantity"],
      unitPrice: ["단가", "unit price", "price"],
      amount: ["상품금액", "금액", "결제금액", "주문금액", "amount", "total"],
      shippingFee: ["배송비", "운임", "shipping"],
      deliveryMessage: ["배송메시지", "배송메세지", "배송 요청", "요청사항", "message"],
      orderedAt: ["주문일시", "주문일", "날짜", "일자", "date"],
      status: ["주문상태", "상태", "status"],
      note: ["메모", "비고", "note"],
    },
  },
};
export const PRESET_KEYS = ["coupang", "smartstore", "generic"];

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

/** AOA(첫 행부터) 에서 헤더 행 번호를 찾는다 — 앞쪽 10행 중 양식 특징 헤더가 가장 많이 맞는 행. 하나도 안 맞으면 0. */
export function headerRowIndex(aoa, limit = 10) {
  const sigs = PRESET_KEYS.flatMap(k => PRESETS[k].signature).map(norm);
  let best = 0, bestHits = 0;
  for (let i = 0; i < Math.min(limit, aoa.length); i++) {
    const cells = (aoa[i] || []).map(norm).filter(Boolean);
    if (cells.length < 3) continue;
    const hits = cells.filter(c => sigs.includes(c)).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  }
  return best;
}

/** 헤더 목록으로 양식을 판정한다. 특징 헤더가 2개 이상 맞는 양식 중 가장 많이 맞는 것, 없으면 generic. */
export function detectPreset(headers) {
  const hs = (headers || []).map(norm);
  let best = "generic", bestScore = 1;
  for (const key of ["coupang", "smartstore"]) {
    const score = PRESETS[key].signature.filter(s => hs.includes(norm(s))).length;
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

/** 양식의 컬럼 표로 헤더를 자동 매핑한다. 반환 { field: 헤더이름 } — 못 찾은 칸은 빠진다. 한 헤더는 한 칸에만 쓴다. */
export function autoMap(headers, presetKey = "generic") {
  const preset = PRESETS[presetKey] || PRESETS.generic;
  const hs = (headers || []).map(h => String(h ?? "").trim());
  const used = new Set();
  const map = {};
  const pick = (cands, exact) => {
    for (const c of cands) {
      const found = hs.find(h => h && !used.has(h) && (exact ? norm(h) === norm(c) : norm(h).includes(norm(c))));
      if (found) return found;
    }
    return "";
  };
  for (const f of FIELDS) {
    const cands = preset.columns[f.k] || [];
    if (!cands.length) continue;
    const h = pick(cands, true) || pick(cands, false);
    if (h) { map[f.k] = h; used.add(h); }
  }
  return map;
}

/** 전화번호 정규화 — 숫자만 남기고 010-1234-5678 꼴로. 안심번호(0503…·050 12자리)도 하이픈만 붙인다. 모르는 길이는 숫자 그대로. */
export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return d.startsWith("02") ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 12 && d.startsWith("050")) return `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}`;
  return d;
}

/** "12,000원" · 12000 · "₩12,000" → 12000. 못 읽으면 0. */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").replace(/[^0-9.\-]/g, "");
  if (!s || s === "-" || s === ".") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const p2 = (n) => String(n).padStart(2, "0");
/** 주문일시 → "YYYY-MM-DD HH:mm". Date·엑셀 시리얼·"2026-10-20 09:12:33"·"2026.10.20"·"10/20" 을 받는다. 못 읽으면 "". */
export function toDateTime(v) {
  if (v === null || v === undefined || v === "") return "";
  let d = null;
  // SheetJS(cellDates) 는 1899년 기준 시간대(서울 LMT) 때문에 52초 이른 Date 를 준다(ExcelImport 주석의 14:59:08 사례). 52초를 더하고 분 단위로 자른다.
  if (v instanceof Date) d = isNaN(v) ? null : new Date(v.getTime() + 52 * 1000);
  else if (typeof v === "number") {
    // 1900 시스템 시리얼. 셀 값은 시간대 없는 벽시계 시각이라 UTC 성분으로 읽어야 기기 시간대와 무관하다.
    const u = new Date(Math.round((v - 25569) * 86400 * 1000) + 30 * 1000);   // 부동소수 오차 반올림용 30초
    return isNaN(u) ? "" : `${u.getUTCFullYear()}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())} ${p2(u.getUTCHours())}:${p2(u.getUTCMinutes())}`;
  } else {
    const s = String(v).trim();
    const m = s.match(/(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})[일.]?(?:\s*(?:T|\s)?\s*(\d{1,2}):(\d{2}))?/);
    if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}${m[4] ? ` ${p2(m[4])}:${m[5]}` : ""}`;
    const m2 = s.match(/^(\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (m2) { const y = new Date().getFullYear(); return `${y}-${p2(m2[1])}-${p2(m2[2])}${m2[3] ? ` ${p2(m2[3])}:${m2[4]}` : ""}`; }
    const t = Date.parse(s);
    d = isNaN(t) ? null : new Date(t);
  }
  if (!d) return "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const CANCEL_RE = /취소|반품|환불|철회|cancel|return/i;

/**
 * 행들을 주문으로 합친다. 같은 주문번호의 여러 행 = 한 주문의 여러 품목.
 * rows 는 AOA(헤더 다음 행부터), headers 는 헤더 행. mapping 을 안 주면 autoMap.
 * 반환 { orders, mapping, missing } — missing 은 필수인데 못 찾은 칸(FIELDS 항목).
 * 주문 모양: { channel, channelOrderId, customer, buyer, phone, phone2, zip, address, addressDetail, deliveryMessage,
 *             items:[{ fabric, color, qty, unit, unitPrice, amount }], shippingFee, totalAmount, orderedAt, status, note, rows:[원본 행 번호], problems:[] }
 */
export function mapRows(headers, rows, presetKey = "generic", mapping = null) {
  const preset = PRESETS[presetKey] || PRESETS.generic;
  const map = mapping || autoMap(headers, presetKey);
  const hs = (headers || []).map(h => String(h ?? "").trim());
  const idx = {};
  for (const f of FIELDS) { const h = map[f.k]; idx[f.k] = h ? hs.indexOf(h) : -1; }
  const missing = FIELDS.filter(f => f.req && idx[f.k] < 0);
  const raw = (row, k) => idx[k] >= 0 ? row[idx[k]] : "";
  const str = (row, k) => String(raw(row, k) ?? "").trim();

  const byId = new Map();
  const orders = [];
  (rows || []).forEach((row, i) => {
    if (!row || row.every(c => c === null || c === undefined || String(c).trim() === "")) return;
    const id = str(row, "orderId");
    const product = str(row, "product");
    const option = str(row, "option");
    const qty = toNumber(raw(row, "qty")) || 0;
    const unitPrice = Math.round(toNumber(raw(row, "unitPrice")));
    let amount = Math.round(toNumber(raw(row, "amount")));
    if (!amount && qty && unitPrice) amount = Math.round(qty * unitPrice);
    const shippingFee = Math.round(toNumber(raw(row, "shippingFee")));
    const status = str(row, "status");
    const key = id || `__row${i}`;
    let o = byId.get(key);
    if (!o) {
      o = {
        channel: preset.channel, channelOrderId: id,
        customer: str(row, "customer"), buyer: str(row, "buyer"),
        phone: normalizePhone(raw(row, "phone")), phone2: normalizePhone(raw(row, "phone2")),
        zip: str(row, "zip"), address: str(row, "address"), addressDetail: str(row, "addressDetail"),
        deliveryMessage: str(row, "deliveryMessage"),
        items: [], shippingFee: 0, totalAmount: 0,
        orderedAt: toDateTime(raw(row, "orderedAt")), status, note: str(row, "note"),
        rows: [], problems: [],
      };
      if (!o.customer && o.buyer) o.customer = o.buyer;
      if (!o.phone && o.phone2) o.phone = o.phone2;
      byId.set(key, o);
      orders.push(o);
    } else {
      // 뒤 행이 앞 행의 빈 칸을 채운다(쿠팡은 모든 행에 수취인이 있지만 혹시 모를 빈 칸)
      for (const k of ["customer", "phone", "address", "addressDetail", "deliveryMessage", "orderedAt"]) if (!o[k]) o[k] = k === "phone" ? normalizePhone(raw(row, k)) : k === "orderedAt" ? toDateTime(raw(row, k)) : str(row, k);
      if (!o.note && str(row, "note")) o.note = str(row, "note");
    }
    o.rows.push(i + 1);
    o.items.push({ fabric: product, color: option, qty, unit: "마", unitPrice, amount });
    // 배송비는 묶음마다 같은 값이 모든 행에 반복된다 — 더하면 두 배가 되므로 큰 값 하나만
    o.shippingFee = Math.max(o.shippingFee, shippingFee);
    if (status && CANCEL_RE.test(status) && !o.problems.includes(`상태 "${status}"`)) o.problems.push(`상태 "${status}"`);
  });

  for (const o of orders) {
    o.totalAmount = o.items.reduce((s, it) => s + (it.amount || 0), 0) + (o.shippingFee || 0);
    if (!o.channelOrderId) o.problems.unshift("주문번호 없음");
    if (!o.customer) o.problems.push("수취인 없음");
    if (o.items.some(it => !it.fabric)) o.problems.push("상품명 없음");
    if (o.items.some(it => !(it.qty > 0))) o.problems.push("수량 0");
    if (!o.items.some(it => it.amount > 0)) o.problems.push("금액 0");
    if (!o.address) o.problems.push("주소 없음");
  }
  return { orders, mapping: map, missing };
}

/**
 * 이미 들어온 채널 주문번호를 걸러낸다. existingIds 는 Set|배열(문자열). 반환 { fresh, skipped } — skipped 는 exists=true 가 붙는다.
 * 목록 안에서 같은 주문번호가 두 번 나오면(합치기 전 호출 등) 뒤의 것도 skipped.
 */
export function dedupe(list, existingIds) {
  const have = new Set([...(existingIds instanceof Set ? existingIds : (existingIds || []))].map(String));
  const seen = new Set();
  const fresh = [], skipped = [];
  for (const o of list || []) {
    const id = String(o.channelOrderId || "");
    if (id && (have.has(id) || seen.has(id))) { skipped.push({ ...o, exists: true }); continue; }
    if (id) seen.add(id);
    fresh.push(o);
  }
  return { fresh, skipped };
}

const erpDate = (d) => `${d.getFullYear()}. ${p2(d.getMonth() + 1)}. ${p2(d.getDate())}.`;

/**
 * 정규화 주문 → db.insertOrder 에 넣을 주문. ctx: { manager, shipDate, paid, now }
 * 접수일·시각은 등록 시점(now) — 홈의 "오늘 주문" 은 등록 기준이다. 채널의 주문일시·주문번호는 note 에 남긴다.
 */
export function toErpOrder(o, { manager = "", shipDate = null, paid = true, now = new Date() } = {}) {
  const items = o.items.map(it => ({ fabric: it.fabric || "상품 미입력", color: it.color || "", qty: it.qty || 0, unit: it.unit || "마", unitPrice: it.unitPrice || 0, amount: it.amount || 0 }));
  const summary = [`[${o.channel}] 주문번호 ${o.channelOrderId}`, o.orderedAt ? `주문 ${o.orderedAt}` : "", o.buyer && o.buyer !== o.customer ? `구매자 ${o.buyer}` : "", o.note ? o.note : ""].filter(Boolean).join(" · ");
  return {
    date: erpDate(now), time: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
    customer: o.customer || "미입력", phone: o.phone || "",
    items,
    payment: paid ? "입금완료" : "미입금", paymentStatus: paid ? "paid" : "unpaid",
    address: o.address || "", addressDetail: o.addressDetail || "",
    deliveryMessage: o.deliveryMessage || "",
    links: [], note: summary,
    status: "접수", manager,
    totalAmount: o.totalAmount || 0, shippingFee: o.shippingFee || 0,
    salesChannel: o.channel, channelOrderId: String(o.channelOrderId),
    shipDate, isUrgent: false,
  };
}
