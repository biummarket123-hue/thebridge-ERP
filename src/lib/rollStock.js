// 롤 재고 계산 — 화면(RollStockTab·InspectionTab)과 db.js 가 같이 쓰는 순수 함수.
// DB 도 화면도 안 건드린다. 그래야 숫자가 맞는지 따로 떼어 확인할 수 있다.
// (migrations/add_stock_rolls.sql)

// 롤 상태 — DB 의 check 제약과 같은 다섯 가지.
export const ROLL_STATUS = {
  received:  { label: "검단 대기", color: "yellow" },
  available: { label: "판매 가능", color: "green" },
  reserved:  { label: "예약",     color: "blue" },
  sold:      { label: "판매 완료", color: "creamMuted" },
  scrapped:  { label: "폐기",     color: "red" },
};
// 잔량 변동 종류 — stock_movements.type. 1단계 화면이 만드는 건 검단·조정·폐기뿐이고
// 나머지는 2단계(재단 스캔)부터 쌓인다. 이력에는 전부 읽을 수 있게 이름을 붙여 둔다.
export const MOVEMENT_LABEL = {
  inspect: "검단", cut: "재단", sell_whole: "통판매", adjust: "조정",
  scrap: "폐기", reserve: "예약", release: "예약 해제",
};

/**
 * DB 오류를 사람이 읽을 말로. 모르는 오류는 원문을 그대로 돌려준다.
 * 가장 흔한 두 가지만 옮긴다 — 잔량 부족(서버가 막은 것)과 마이그레이션 전(테이블 없음).
 */
export function rollErrorText(e) {
  const msg = String(e?.message || e || "오류");
  if (/remaining below zero/i.test(msg)) return "잔량보다 많이 뺄 수 없습니다 — 변경되지 않았습니다";
  if (/roll not found/i.test(msg)) return "롤을 찾을 수 없습니다 — 새로고침 후 다시 해 주세요";
  if (["42P01", "42883", "PGRST202", "PGRST205"].includes(e?.code)
    && /products|stock_rolls|stock_movements|roll_apply_movement|next_product_code/.test(msg)) {
    return "롤 재고 DB 가 아직 준비되지 않았습니다 — migrations/add_stock_rolls.sql 을 먼저 실행해 주세요";
  }
  if (["42883", "PGRST202"].includes(e?.code) && /roll_add_piece|unpack_item_cut/.test(msg)) {
    return "조각 롤 기능이 아직 켜지지 않았습니다 — migrations/add_roll_pieces.sql 을 먼저 실행해 주세요";
  }
  return msg;
}

// 롤 라벨 QR 에 넣는 주소 — 핸드폰 카메라로 찍으면 롤 정보 화면(/r/{롤번호})이 열린다(2026-10-02).
// 고객용 브랜드 주소다. ERP 주소(company.thebridge.ai.kr)는 고객에게 드러내지 않는다 — 이 호스트로는 ERP 가
// 열리지 않는다(vercel.json → info.html → src/public/main.jsx). 라벨은 몇 달씩 붙어 있으므로 도메인을 못 박는다.
// 포장대 스캐너는 이 주소를 통째로 입력하는데, packing.normalizeScan 이 끝의 롤 번호만 떼어 읽는다.
export const ROLL_PUBLIC_ORIGIN = "https://info.lowhigh-market.com";
export const rollQrText = (rollCode) => `${ROLL_PUBLIC_ORIGIN}/r/${String(rollCode || "").trim()}`;

// 조각 롤의 출처 — 입고한 롤이 아니라 잘려 나갔다가 돌아온 원단. (migrations/add_roll_pieces.sql)
export const PIECE_ORIGIN = { cancel: "취소 조각", return: "반품 조각" };

// 끝난 롤 — 더 팔 것도 옮길 것도 없다. 재고 화면에서 기본으로 숨긴다.
export const CLOSED_STATUSES = ["sold", "scrapped"];
export const isClosedRoll = (r) => CLOSED_STATUSES.includes(r?.status);

// roll_code 는 스캐너가 키보드처럼 그대로 타이핑할 값이다. 공백·한글·특수문자가
// 섞이면 스캐너 설정(자판 배열)에 따라 다른 글자가 들어온다.
export const SCAN_SAFE = /^[A-Z0-9-]+$/;

// 품번 접두어 — 담당자 이니셜(2026-10-08 사용자 지정: 장향숙 A→P(10-13 변경)·송미송 S·손희우 W·고문님 H·실장님 L·테스트 TEST).
// 값은 managers.code 에 있고 설정 화면(ManagerSettings)에서 고친다 — 바꿔도 이미 만든 품번은 그대로다.
// 영문으로 시작하는 영문 대문자·숫자 1~6 만. 한글은 스캐너가 자판대로 쳐서 깨지고 주소에도 못 들어간다.
// 숫자로 시작하면 로하톡 글에서 전화번호(010-1234-5678)가 품번 꼴에 걸린다(lib/productCodes.js). 안 맞으면 LH.
// 서버(next_product_code)도 같은 규칙으로 한 번 더 거른다 — 여기는 화면에 미리 보여주기 위한 것.
export const PREFIX_RE = /^[A-Z][A-Z0-9]{0,5}$/;
export const DEFAULT_PREFIX = "LH";
export function codePrefixOf(managerCode) {
  const c = String(managerCode || "").trim().toUpperCase();
  return PREFIX_RE.test(c) ? c : DEFAULT_PREFIX;
}
/** 담당자 이름 → 품번 접두어. managers 목록에서 code 를 찾는다. */
export function prefixForManager(managers, name) {
  return codePrefixOf((managers || []).find(m => m?.name === name)?.code);
}
export const isScanSafe = (code) => SCAN_SAFE.test(String(code || ""));

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
// 소수 둘째 자리까지(DB 가 numeric(10,2)). 0.1+0.2 같은 부동소수 꼬리를 잘라낸다.
export const round2 = (v) => Math.round(num(v) * 100) / 100;

/** 수량 표시 — 42.5 → "42.5", 40 → "40". 없으면 "—". */
export const fmtLen = (v) => (v === null || v === undefined || v === "") ? "—" : String(round2(v));

/** roll_code 끝의 순번. 'LH-2609-0142-R03' → 3. 형식이 다르면 0. */
export function rollSeqOf(rollCode) {
  const m = String(rollCode || "").match(/-R(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 새로 만들 roll_code 목록.
 * 순번은 그 품번의 기존 롤 수 + 1 부터. 다만 기존 롤 중 더 큰 순번이 있으면 그 다음부터
 * 센다 — 롤 수만 세면 중간 번호가 빈 품번에서 이미 있는 번호를 다시 만든다.
 * @param bump 충돌해서 다시 시도할 때 밀어낼 칸 수
 */
export function nextRollCodes(productCode, existingRollCodes = [], count = 1, bump = 0) {
  const maxSeq = existingRollCodes.reduce((m, c) => Math.max(m, rollSeqOf(c)), 0);
  const start = Math.max(existingRollCodes.length, maxSeq) + 1 + bump;
  return Array.from({ length: count }, (_, i) =>
    `${productCode}-R${String(start + i).padStart(2, "0")}`);
}

/**
 * 실측 수량 입력값을 읽는다. 소수 한 자리까지 받는다(줄자로 재는 단위가 거기까지다).
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function parseMeasured(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: false, reason: "실측 수량을 입력해 주세요" };
  if (!/^\d+(\.\d)?$/.test(s)) return { ok: false, reason: "숫자로, 소수 한 자리까지만 입력해 주세요 (예: 42.5)" };
  return { ok: true, value: Number(s) };
}

/**
 * 한 품번의 롤들을 요약한다.
 *   availableCount  판매 가능한 롤 수
 *   totalRemaining  그 롤들의 잔량 합 — 참고값
 *   maxRemaining    가장 긴 롤의 잔량 — 실제 가용치("최대 재단 가능")
 *   pendingCount    검단 대기 롤 수
 *
 * 합계가 아니라 가장 긴 롤을 가용치로 보는 이유: 재단 주문은 한 롤에서 끊어 나간다.
 * 8·6·5마 롤이 있어도 10마 주문은 못 받는다.
 */
export function summarizeRolls(rolls = []) {
  const avail = rolls.filter(r => r.status === "available");
  return {
    // 판매 가능한 롤들의 잔량, 긴 것부터. 주문 등록이 "몇 마씩 나눠야 하나"를 여기서 본다.
    lengths: avail.map(r => round2(r.lengthRemaining)).filter(v => v > 0).sort((a, b) => b - a),
    availableCount: avail.length,
    totalRemaining: round2(avail.reduce((s, r) => s + num(r.lengthRemaining), 0)),
    maxRemaining: round2(avail.reduce((m, r) => Math.max(m, num(r.lengthRemaining)), 0)),
    pendingCount: rolls.filter(r => r.status === "received").length,
    lastReceivedAt: rolls.reduce((m, r) => (r.createdAt && r.createdAt > m ? r.createdAt : m), ""),
  };
}

/**
 * 품번별로 묶는다. 롤이 하나도 없는 품번은 넣지 않는다 — 옛 재고에서 옮겨온 품번이
 * 수백 개라, 전부 늘어놓으면 실제로 창고에 있는 원단이 그 사이에 묻힌다.
 * 정렬: 검단 대기가 있는 품번 먼저, 그다음 최근 입고순.
 */
export function groupRollsByProduct(products = [], rolls = []) {
  const byProduct = new Map();
  for (const r of rolls) {
    if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
    byProduct.get(r.productId).push(r);
  }
  const productById = new Map(products.map(p => [p.id, p]));
  const groups = [];
  for (const [productId, list] of byProduct) {
    list.sort((a, b) => rollSeqOf(a.rollCode) - rollSeqOf(b.rollCode) || String(a.rollCode).localeCompare(String(b.rollCode)));
    groups.push({
      product: productById.get(productId) || { id: productId, code: "", name: "(품번 정보 없음)", color: "", unit: "마" },
      rolls: list,
      ...summarizeRolls(list),
    });
  }
  groups.sort((a, b) =>
    ((b.pendingCount > 0) - (a.pendingCount > 0))
    || String(b.lastReceivedAt).localeCompare(String(a.lastReceivedAt)));
  return groups;
}

// ── 롤 단위 · 품목 줄 나누기 ─────────────────────────────────────────
// 포장 기록은 품목 한 줄에 롤 하나다(order_item_packing 의 unique). 그래서 한 줄의 수량이 한 롤에서
// 다 나올 수 없으면 등록할 때 줄을 나눠야 포장대에서 롤마다 찍을 수 있다.

/** 통째로 나가는 단위인가. '필'과 '롤'은 같은 뜻으로 쓴다(2026-10-02 확인) — 수량은 롤의 개수다. */
export const isRollUnit = (unit) => unit === "롤" || unit === "필";

/**
 * 수량을 롤에 맞춰 나눈다 — 가장 긴 롤부터 채운다. 10마 · 롤 [6, 4, 3] → [6, 4].
 * 판매 가능한 롤을 다 합쳐도 모자라면 null(나눠도 못 채운다).
 */
export function proposeSplit(qty, lengths = []) {
  let left = round2(qty);
  if (!(left > 0)) return null;
  const out = [];
  for (const r of [...lengths].filter(v => v > 0).sort((a, b) => b - a)) {
    if (left <= 0) break;
    const take = Math.min(r, left);
    out.push(round2(take));
    left = round2(left - take);
  }
  return left > 0 ? null : out;
}

/**
 * 나눈 수량이 실제로 롤에 들어가는가 — 큰 줄부터 큰 롤에 하나씩 맞춰 본다.
 * 줄 하나는 롤 하나에서 나와야 하므로 [6, 6] 은 6마 넘는 롤이 둘 있어야 한다.
 */
export function splitFits(parts = [], lengths = []) {
  const p = [...parts].map(Number).sort((a, b) => b - a);
  const r = [...lengths].sort((a, b) => b - a);
  if (p.length === 0 || p.length > r.length) return false;
  return p.every((v, i) => v > 0 && v <= r[i]);
}

/**
 * 품목 한 줄을 여러 줄로. 금액은 단가가 있으면 단가×수량, 없으면 수량 비율로 나누고,
 * 끝전은 마지막 줄에 몰아 합계가 원래 금액과 같게 한다. itemId 는 떼어 낸다 — 새 줄마다 새로 받는다.
 */
export function splitItemLines(item, parts = []) {
  const qty = parts.reduce((s, v) => s + Number(v), 0);
  const total = parseInt(item?.amount) || 0;
  const up = parseInt(item?.unitPrice) || 0;
  let used = 0;
  return parts.map((v, i) => {
    const q = Number(v);
    const last = i === parts.length - 1;
    const amount = last && total > 0 ? total - used : (up > 0 ? Math.round(up * q) : (qty > 0 ? Math.round(total * q / qty) : 0));
    used += amount;
    const { itemId, ...rest } = item;
    return { ...rest, qty: q, amount };
  });
}

/** 품번 검색 — 코드·이름·색상. 자동완성과 재고 화면이 같은 기준을 쓴다. */
export function matchProduct(p, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;
  return [p?.code, p?.name, p?.color].some(v => String(v || "").toLowerCase().includes(s));
}
