// 포장대 스캔 판정 — 포장 화면(PackingTab)이 쓰는 순수 함수 모음. DB 도 React 도 없다.
import { baseProductCode } from "./productCodes.js";
// 화면에서 떼어 둔 이유: 거부·후보·게이트 규칙이 화면 코드에 섞이면 시험할 방법이
// 브라우저에서 직접 찍어 보는 것뿐이다. 여기 있으면 tests/ 에서 그대로 돌린다.
//
// 흐름: 스캔값 → 롤 → 그 롤의 품번 → 그 품번을 기다리는 주문 품목(후보)
//   후보 1개 → 확인창 / 여러 개 → 고르기 / 0개 → 거부(이 주문의 원단이 아님)

// 한글 자판(두벌식) → 같은 자리의 영문 글쇠. 스캐너는 글쇠를 누르는 기계라, 태블릿이 한글 입력
// 상태면 'LH-2610-0001-R01' 이 'ㅣㅗ-2610-0001-ㄱ01' 로 들어온다. 롤 코드에는 한글이 없으므로
// (rollStock.js SCAN_SAFE) 한글이 보이면 전부 자판이 바뀐 것이다 — 되돌려 읽는다.
const KEY_OF = {
  ㄱ:"r", ㄲ:"R", ㄴ:"s", ㄷ:"e", ㄸ:"E", ㄹ:"f", ㅁ:"a", ㅂ:"q", ㅃ:"Q", ㅅ:"t", ㅆ:"T", ㅇ:"d", ㅈ:"w", ㅉ:"W",
  ㅊ:"c", ㅋ:"z", ㅌ:"x", ㅍ:"v", ㅎ:"g",
  ㄳ:"rt", ㄵ:"sw", ㄶ:"sg", ㄺ:"fr", ㄻ:"fa", ㄼ:"fq", ㄽ:"ft", ㄾ:"fx", ㄿ:"fv", ㅀ:"fg", ㅄ:"qt",
  ㅏ:"k", ㅐ:"o", ㅑ:"i", ㅒ:"O", ㅓ:"j", ㅔ:"p", ㅕ:"u", ㅖ:"P", ㅗ:"h", ㅘ:"hk", ㅙ:"ho", ㅚ:"hl", ㅛ:"y",
  ㅜ:"n", ㅝ:"nj", ㅞ:"np", ㅟ:"nl", ㅠ:"b", ㅡ:"m", ㅢ:"ml", ㅣ:"l",
};
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", ..."ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"];
/** 한글로 들어온 글쇠를 영문으로 되돌린다. 한글이 없으면 그대로. 완성된 글자(가~힣)는 낱자로 풀어서 바꾼다. */
export function hangulToKeys(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const n = code - 0xAC00;
      out += KEY_OF[CHO[Math.floor(n / 588)]] + KEY_OF[JUNG[Math.floor((n % 588) / 28)]] + (KEY_OF[JONG[n % 28]] || "");
    } else out += KEY_OF[ch] ?? ch;
  }
  return out;
}

/**
 * 스캔 입력값 → 롤 번호. 스캐너는 대문자로 주지만 사람이 타이핑하면 아니다. 한글 자판 상태로 들어온 값도 되돌린다.
 * 라벨 QR 이 주소(https://…/r/{롤번호})면 끝의 롤 번호만 떼어 낸다 — 2026-10-02 부터 QR 에 주소가 들어간다.
 */
export const normalizeScan = (v) => {
  const s = hangulToKeys(String(v || "").trim()).toUpperCase();
  const m = s.match(/\/R\/([A-Z0-9-]+)/);
  return m ? m[1] : s;
};

/** 찍어서 잘라 나갈 수 있는 롤 상태. 검단 전(received)·끝난 롤(sold·scrapped)은 아니다. */
export const SCANNABLE_STATUSES = ["available", "reserved"];
export const isScannableRoll = (roll) => SCANNABLE_STATUSES.includes(roll?.status);

/** 사람이 읽을 롤 상태 */
export const ROLL_STATUS_LABEL = {
  received: "검단 전", available: "판매 가능", reserved: "예약됨", sold: "판매 완료", scrapped: "폐기됨",
};

/** 포장 기록 목록 → Map<orderId, Map<itemId, 기록>>. 화면은 이 모양으로 들고 다닌다. */
export function indexPacking(records = []) {
  const m = new Map();
  for (const r of records) {
    const oid = String(r.orderId);
    if (!m.has(oid)) m.set(oid, new Map());
    m.get(oid).set(String(r.itemId), r);
  }
  return m;
}

/** 한 주문의 한 품목의 포장 기록. 없으면 null. */
export const packingOf = (packingByOrder, orderId, itemId) =>
  (itemId && packingByOrder?.get(String(orderId))?.get(String(itemId))) || null;

/**
 * 한 박스(합배송이면 주문 여럿)의 스캔 진행.
 *   scanTotal  itemId 가 있는 품목 수 — 옛 주문의 품목(itemId 없음)은 세지 않는다
 *   scanDone   그중 포장 기록이 있는 수
 * scanTotal 이 0 이면 게이트가 없다(옛 방식대로 포장완료가 바로 눌린다).
 */
export function scanStats(orders, packingByOrder) {
  let scanTotal = 0, scanDone = 0;
  for (const o of orders || []) {
    for (const it of o?.items || []) {
      if (!it?.itemId) continue;
      scanTotal++;
      if (packingOf(packingByOrder, o.id, it.itemId)) scanDone++;
    }
  }
  return { scanTotal, scanDone };
}

/**
 * 포장완료 게이트를 실제로 잠글 것인가.
 * 전환 기간(2026-10 ~)에는 false — 스캐너도 없고 롤 등록도 한 달 넘게 걸린다. 스캔은 "하면
 * 기록이 남는" 선택 사항이고, 포장완료는 지금처럼 바로 눌린다. 롤이 충분히 등록되고 포장팀이
 * 스캐너로 일하게 되면 true 로 바꾼다 — 그때부터 다 찍어야 포장완료가 열린다.
 */
export const PACK_GATE_ENFORCED = false;

/**
 * 포장완료 게이트 — 잠겼으면 버튼을 못 누른다. 라벨에 진행률을 붙인다.
 *   enforce  잠글 것인가(기본 PACK_GATE_ENFORCED). 안 잠그는 동안은 진행률도 "찍기 시작한 박스"에만
 *            붙인다 — 하나도 안 찍은 박스는 2단계 전과 똑같이 보여야 한다.
 */
export function packGate({ scanTotal = 0, scanDone = 0 } = {}, enforce = PACK_GATE_ENFORCED) {
  const locked = enforce && scanTotal > 0 && scanDone < scanTotal;
  const show = scanTotal > 0 && (enforce || scanDone > 0);
  return { locked, progress: show ? `${scanDone}/${scanTotal}` : "" };
}

/**
 * 이 품목이 이 품번의 원단인가.
 * productId 가 있으면 그것으로, 없으면(품번을 손으로 친 옛 방식) itemNo 와 코드를 대소문자 무시로 맞춘다.
 * itemNo 에 롤 번호가 붙어 있어도(S-2610-0010-R01 — 로하톡 글을 그대로 읽은 것) 품번 S-2610-0010 으로 본다.
 */
export function itemMatchesProduct(item, product) {
  if (!item || !product) return false;
  if (item.productId) return item.productId === product.id;
  const no = baseProductCode(item.itemNo);
  return !!no && no === baseProductCode(product.code);
}

/**
 * rows(박스들) 안에서 이 품번을 기다리는 품목을 찾는다.
 * (a) 포장 기록이 없고 (b) itemId 가 있고 (c) 품번이 맞는 것.
 * 반환: [{ row, order, item, itemIdx }]
 */
export function findScanCandidates(rows, product, packingByOrder) {
  const out = [];
  for (const row of rows || []) {
    for (const order of row.orders || []) {
      (order.items || []).forEach((item, itemIdx) => {
        if (!item?.itemId) return;
        if (packingOf(packingByOrder, order.id, item.itemId)) return;
        if (!itemMatchesProduct(item, product)) return;
        out.push({ row, order, item, itemIdx });
      });
    }
  }
  return out;
}

/**
 * 스캔 한 번의 판정.
 *   roll·product     찍은 롤과 그 품번
 *   activeRow        사람이 누른 박스(없으면 null)
 *   visibleRows      지금 화면에 보이는 박스들 — 활성 박스가 없을 때 여기서 찾는다
 *   allRows          거부할 때 "→ 누구 주문 것"이라고 알려주려고 전체에서 찾는다
 * 반환:
 *   { kind: "reject", message, hint? }      — 배너 + 경고음
 *   { kind: "confirm", candidate }           — 확인창
 *   { kind: "choose", candidates }           — 고르는 목록
 */
export function resolveScan({ roll, product, activeRow, visibleRows, allRows, packingByOrder }) {
  if (!roll) return { kind: "reject", message: "등록되지 않은 롤 코드입니다" };
  if (!isScannableRoll(roll)) {
    const st = ROLL_STATUS_LABEL[roll.status] || roll.status;
    const rem = roll.lengthRemaining === null || roll.lengthRemaining === undefined ? "—" : roll.lengthRemaining;
    return { kind: "reject", message: `이 롤은 ${st}입니다 — 잔량 ${rem}`, status: roll.status };
  }
  if (!product) return { kind: "reject", message: `롤 ${roll.rollCode} 의 품번 정보가 없습니다 — 새로고침 후 다시 찍어 주세요` };

  const scope = activeRow ? [activeRow] : (visibleRows || []);
  let cands = findScanCandidates(scope, product, packingByOrder);
  // 조각 롤을 먼저 찍었으면 롤 단위(통째) 품목은 후보에서 뺀다 — 2마 조각이 "1롤"로 팔리면 안 된다(2026-10-13).
  if (isPieceRoll(roll)) {
    const wholeOnly = cands.filter(c => ROLL_UNITS.includes(c.item?.unit));
    cands = cands.filter(c => !ROLL_UNITS.includes(c.item?.unit));
    if (!cands.length && wholeOnly.length) {
      return { kind: "reject", message: `${roll.rollCode} 은 조각 롤입니다 — 롤 단위 품목(${itemLabel(wholeOnly[0])})은 입고한 롤을 통째로 찍어야 합니다`, hint: "입고 롤을 찍어 주세요" };
    }
  }
  if (cands.length === 1) return { kind: "confirm", candidate: cands[0] };
  if (cands.length > 1) return { kind: "choose", candidates: cands };

  // 0개 — 이 롤이 맞는 품목이 다른 박스에 있으면 그 고객을 알려준다.
  const others = findScanCandidates((allRows || []).filter(r => r !== activeRow), product, packingByOrder);
  const names = [...new Set(others.map(c => c.order.customer).filter(Boolean))];
  const hint = names.length ? `→ ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 외 ${names.length - 3}명` : ""} 주문 것입니다` : "";
  const what = `${product.code} ${product.name}${product.color ? ` ${product.color}` : ""}`.trim();
  if (activeRow) return { kind: "reject", message: `이 주문의 원단이 아닙니다 — ${what}`, hint, wrongBox: true };
  return { kind: "reject", message: `오늘 포장 목록에 이 원단 품목이 없습니다 — ${what}`, hint };
}

/** 통째로 나가는 단위 — rollStock.isRollUnit 과 같은 정의('필'은 '롤'과 같은 뜻). 여기는 import 없이 둔다. */
const ROLL_UNITS = ["롤", "필"];

/**
 * 스캔 한 번으로 바로 자를 수 있는가(재단 확인창 없이) — 2026-10-02 결정: 찍으면 주문 수량대로 바로 기록한다.
 * 확인창이 필요한 건 사람이 숫자를 정해야 할 때뿐이다.
 * 반환 { auto: true, len, whole } 또는 { auto: false, reason }
 *   · 롤·필 단위 → 롤 통째(len 은 서버가 잔량으로 정한다)
 *   · 마 등     → 주문 수량만큼. 수량이 비었거나 이상하면, 롤 잔량이 모자라면 확인창
 */
export function autoCutPlan(item, roll) {
  if (ROLL_UNITS.includes(item?.unit)) {
    // 마지막 방어선 — 어느 길로 왔든 조각 롤을 통째로 팔지 않는다. reject 는 확인창도 안 띄운다.
    if (isPieceRoll(roll)) return { auto: false, reject: true, reason: `${roll.rollCode} 은 조각 롤입니다 — 롤 단위 품목은 입고한 롤을 찍어 주세요` };
    const rem = Number(roll?.lengthRemaining);
    return rem > 0 ? { auto: true, len: null, whole: true } : { auto: false, reason: "롤 잔량이 없습니다" };
  }
  const p = parseCutLength(item?.qty);
  if (!p.ok) return { auto: false, reason: "주문 수량을 확인해 주세요" };
  const rem = roll?.lengthRemaining;
  if (rem !== null && rem !== undefined && p.value > Number(rem)) return { auto: false, reason: `롤 잔량 ${rem} — 주문 수량보다 적습니다` };
  return { auto: true, len: p.value, whole: false };
}

/**
 * 이 박스의 모든 품목에 포장 기록(스캔 또는 롤 없이 포장)이 있는가.
 * 2026-10-15 사용자 결정: 마지막 품목을 찍어도 포장완료는 저절로 되지 않는다 — 박스가 바로 완료 탭으로 가 버리면
 * 포장직원이 한 번 더 확인할 틈이 없다. 스캔은 원단 하나하나의 기록이고, 주문 전체의 포장완료는 사람이 버튼을
 * 눌러 확정한다. 이 함수는 "다 찍었으니 포장완료를 누르세요" 안내에만 쓴다.
 * 품목 id 가 없는 옛 주문이 섞였거나, 보관·보류 중이거나, 이미 포장완료면 false.
 * justDone: 방금 기록한 품목들 [{ orderId, itemId }] — 화면의 포장 기록이 아직 다시 읽히기 전이라 같이 센다.
 */
export function allItemsPacked(row, packingByOrder, justDone = []) {
  if (!row || row.allPacked || row.parked || row.held) return false;
  const done = new Set(justDone.map(d => `${d.orderId}:${d.itemId}`));
  let any = false;
  for (const o of row.orders || []) {
    for (const it of o?.items || []) {
      if (!it?.itemId) return false;
      any = true;
      if (!packingOf(packingByOrder, o.id, it.itemId) && !done.has(`${o.id}:${it.itemId}`)) return false;
    }
  }
  return any;
}

/**
 * 자른 길이 입력값. 소수 둘째 자리까지(DB 가 numeric(10,2)).
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function parseCutLength(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: false, reason: "자른 길이를 입력해 주세요" };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, reason: "숫자로, 소수 둘째 자리까지만 (예: 3.5)" };
  const v = Number(s);
  if (!(v > 0)) return { ok: false, reason: "0보다 커야 합니다" };
  return { ok: true, value: v };
}

// ── 주문 라벨 QR (2026-10-08) ─────────────────────────────────
// 인계 라벨(labelPrint.js)에 품목 QR 이 붙는다. 포장직원은 원단 한 개에 라벨 QR **한 번**을 찍는 것이
// 기본이고, 그 품번에 진행 중인 롤이 둘 이상일 때만 롤 QR 을 이어서 찍는다(사용자 결정 2026-10-08:
// "원단 한 개당 한 번"). 롤이 하나면 그 롤에서 바로 빠진다.
//
// 라벨 QR 로 찍으면 어느 주문의 어느 품목인지가 바로 정해지므로, 같은 원단을 기다리는 박스가
// 여럿이어도 고르는 창이 안 뜨고 다른 박스에 기록될 일이 없다. 롤 QR 을 먼저 찍는 옛 흐름(resolveScan)은
// 그대로 남는다 — QR 없는 옛 라벨이 섞여 있어도 막히지 않는다.
//
// QR 값: "OI:" + 품목 id(하이픈 뺀 대문자). 대문자·숫자·':' 만 쓰면 QR 이 영숫자 모드로 더 성글게
// 찍혀 16mm 로도 읽힌다. 롤 QR 은 주소(…/r/롤번호)라 앞글자로 구분된다. 한글 자판 상태로 들어와도
// hangulToKeys 가 되돌린다(ㅐ→O, ㅑ→I).
export const ITEM_QR_PREFIX = "OI:";
/** 품목 id → 견주는 열쇠. 저장된 id 는 소문자 uuid 이고 스캐너는 대문자로 주므로 양쪽을 같은 꼴로. */
export const itemScanKey = (itemId) => String(itemId || "").replace(/-/g, "").toUpperCase();
export const itemQrText = (itemId) => `${ITEM_QR_PREFIX}${itemScanKey(itemId)}`;

/**
 * 스캔 입력값 → 무엇을 찍었는가.
 *   { kind: "item", key }   주문 라벨 QR — key 는 itemScanKey 와 견준다
 *   { kind: "roll", code }  롤 QR 또는 손으로 친 롤 번호(normalizeScan 과 같은 규칙)
 *   null                    빈 값
 */
export function parseScan(v) {
  const s = hangulToKeys(String(v || "").trim()).toUpperCase();
  if (!s) return null;
  // 한 입력에 코드가 둘 이상 붙어 있으면(앞 스캔의 Enter 가 먹히지 않아 다음 스캔이 이어 붙은 경우) 마지막 것을 읽는다 —
  // 마지막이 방금 찍은 것이다.
  const iItem = s.lastIndexOf(ITEM_QR_PREFIX);
  const rollMatches = [...s.matchAll(/\/R\/([A-Z0-9-]+)/g)];
  const iRoll = rollMatches.length ? rollMatches[rollMatches.length - 1].index : -1;
  if (iItem >= 0 && iItem > iRoll) {
    const key = s.slice(iItem + ITEM_QR_PREFIX.length).replace(/[^A-Z0-9]/g, "");
    return key ? { kind: "item", key } : null;
  }
  if (iRoll >= 0) return { kind: "roll", code: rollMatches[rollMatches.length - 1][1] };
  return { kind: "roll", code: s };
}

/** 품목의 품번. productId 가 있으면 그것, 없으면 itemNo 로 코드를 맞춘다(대소문자·롤 번호 무시). 없으면 null. */
export function productOfItem(item, products) {
  if (!item) return null;
  const list = products instanceof Map ? [...products.values()] : (products || []);
  if (item.productId) {
    const p = products instanceof Map ? products.get(item.productId) : list.find(p => p.id === item.productId);
    if (p) return p;
  }
  const no = baseProductCode(item.itemNo);
  return (no && list.find(p => baseProductCode(p.code) === no)) || null;
}

/** 조각 롤(취소·반품으로 돌아온 원단)인가 — 입고한 롤이 아니라 "1롤" 주문을 채울 수 없다. */
export const isPieceRoll = (roll) => !!roll?.origin;

/**
 * 이 품번에서 지금 잘라 나갈 수 있는 롤들 — 판매 가능·예약 상태이고 잔량이 남은 것. 롤 번호순.
 * forWhole: 롤·필 단위 품목(통째로 나감)의 후보 — 조각 롤은 뺀다. 안 빼면 2마 조각이 "1롤"로
 * 통째 팔린 것으로 기록되고 실제 롤은 재고에 남는다(2026-10-13 점검).
 */
export function rollsForProduct(product, rolls, { forWhole = false } = {}) {
  if (!product) return [];
  return (rolls || [])
    .filter(r => r?.productId === product.id && isScannableRoll(r)
      && (r.lengthRemaining === null || r.lengthRemaining === undefined || Number(r.lengthRemaining) > 0)
      && !(forWhole && isPieceRoll(r)))
    .sort((a, b) => String(a.rollCode || "").localeCompare(String(b.rollCode || "")));
}

/** rows 전체에서 라벨 QR 의 품목을 찾는다. 반환 { row, order, item, itemIdx } 또는 null. */
export function findItemByKey(rows, key) {
  if (!key) return null;
  for (const row of rows || []) {
    for (const order of row.orders || []) {
      const items = order.items || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it?.itemId && itemScanKey(it.itemId) === key) return { row, order, item: it, itemIdx: i };
      }
    }
  }
  return null;
}

const itemLabel = (c) => `${c.order.customer || "고객"} · ${`${c.item.fabric || ""}${c.item.color ? ` ${c.item.color}` : ""}`.trim() || "품목"}`;

/**
 * 주문 라벨 QR 한 번의 판정.
 *   key            parseScan 이 준 품목 열쇠
 *   rows           포장 화면의 박스 전부(완료·보관·보류 포함) — 라벨은 박스를 특정하므로 화면에 보이는지는 안 따진다
 *   packingByOrder 포장 기록
 *   products       품번 목록(배열 또는 Map)
 *   rolls          진행 중인 롤 목록
 * 반환:
 *   { kind: "reject", message, hint?, candidate? }  — 배너 + 경고음. candidate 가 있으면 라벨의 주문은 찾았다
 *                                                     (이미 포장·완료·보류·보관) — 화면은 그 박스로 간다(2026-10-15 사용자 요청:
 *                                                     "이미 포장됐다"는 알림만으론 어느 주문인지 찾기 힘들다)
 *   { kind: "pack", candidate, product, roll }       — 롤이 하나: 바로 재단 기록으로
 *   { kind: "pick-roll", candidate, product, rolls } — 롤이 둘 이상: 롤 QR 을 이어서 찍는다
 *   { kind: "no-roll", candidate, product }          — 진행 중인 롤이 없다: 롤을 찍거나 롤 없이 포장
 */
export function resolveItemScan({ key, rows, packingByOrder, products, rolls }) {
  const c = findItemByKey(rows, key);
  if (!c) return { kind: "reject", message: "이 라벨의 주문이 포장 목록에 없습니다", hint: "이미 나간 주문이거나 다른 날짜의 주문입니다" };
  const rec = packingOf(packingByOrder, c.order.id, c.item.itemId);
  if (rec) return { kind: "reject", candidate: c, message: `이미 포장된 품목입니다 — ${itemLabel(c)}`, hint: rec.rollCode ? `${rec.rollCode} 에서 ${rec.length ?? ""}${c.item.unit || "마"}` : "" };
  if (c.row.allPacked) return { kind: "reject", candidate: c, message: `이미 포장완료된 박스입니다 — ${c.order.customer || ""}` };
  if (c.row.parked) return { kind: "reject", candidate: c, message: `보류 중인 주문입니다 — ${c.order.customer || ""}`, hint: "보류를 풀고 나서 찍어 주세요" };
  if (c.row.held) return { kind: "reject", candidate: c, message: `보관 주문입니다 — ${c.order.customer || ""}`, hint: "보관 건은 포장 기록 없이 선반으로 갑니다" };
  const product = productOfItem(c.item, products);
  if (!product) return { kind: "reject", message: `품번을 모르는 품목입니다 — ${itemLabel(c)}`, hint: "롤 QR 을 찍거나 '롤 없이 포장'으로 기록해 주세요" };
  const cands = rollsForProduct(product, rolls, { forWhole: ROLL_UNITS.includes(c.item?.unit) });
  if (cands.length === 1) return { kind: "pack", candidate: c, product, roll: cands[0] };
  if (cands.length > 1) return { kind: "pick-roll", candidate: c, product, rolls: cands };
  return { kind: "no-roll", candidate: c, product };
}

/**
 * 라벨을 찍어 둔 품목(pending)이 있는 상태에서 롤 QR 이 들어왔을 때의 판정.
 * 롤이 그 품목의 품번이면 바로 재단으로, 아니면 거부(기다리는 품목은 그대로 둔다 — 맞는 롤을 다시 찍으면 된다).
 */
export function resolvePendingRoll({ pending, roll, product }) {
  if (!roll) return { kind: "reject", message: "등록되지 않은 롤 코드입니다" };
  if (!isScannableRoll(roll)) {
    const st = ROLL_STATUS_LABEL[roll.status] || roll.status;
    const rem = roll.lengthRemaining === null || roll.lengthRemaining === undefined ? "—" : roll.lengthRemaining;
    return { kind: "reject", message: `이 롤은 ${st}입니다 — 잔량 ${rem}`, status: roll.status };
  }
  if (!product) return { kind: "reject", message: `롤 ${roll.rollCode} 의 품번 정보가 없습니다 — 새로고침 후 다시 찍어 주세요` };
  if (!itemMatchesProduct(pending.candidate.item, product)) {
    const what = `${product.code} ${product.name}${product.color ? ` ${product.color}` : ""}`.trim();
    return { kind: "reject", message: `이 롤은 ${itemLabel(pending.candidate)} 의 원단이 아닙니다 — 찍은 롤: ${what}`, hint: "맞는 롤을 다시 찍거나 '취소'를 누르세요", wrongRoll: true };
  }
  if (ROLL_UNITS.includes(pending.candidate.item?.unit) && isPieceRoll(roll)) {
    return { kind: "reject", message: `${roll.rollCode} 은 조각 롤입니다 — 롤 단위 품목(${itemLabel(pending.candidate)})은 입고한 롤을 통째로 찍어야 합니다`, hint: "입고 롤을 찍어 주세요", wrongRoll: true };
  }
  return { kind: "pack", candidate: pending.candidate, product, roll };
}
