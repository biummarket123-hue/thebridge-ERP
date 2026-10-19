// 로하톡 글에서 품번을 읽어 품목에 붙인다 (2026-10-08). 순수 함수 — DB·React 없음, tests/ 에서 그대로 돈다.
//
// 배경: 주문 링크는 창고 원단이 80% 쯤 입고된 뒤에 쓰기로 했고, 그때까지는 로하톡으로 주문을 받는다.
// 원단명은 겹치는 게 있어 품번으로 가려야 한다. 셀러는 로하톡에 품목을 "품번 원단명 색상 수량" 꼴로 적는다 —
//   S-2610-0005 린넨코튼 베이지 3마
// AI 파서(constants.aiParseText)가 맨 앞 품번을 itemNo 로 읽지만, AI 에 기대지 않는 안전망이 여기다:
//   1. normalizeProductCodes — AI 에 넣기 전에 글을 다듬는다. "원단명(품번)" 처럼 괄호에 넣은 것도 "품번 원단명" 으로
//      바꾸고(괄호는 AI 가 색상·메모로 오해한다), 소문자 품번은 대문자로.
//   2. attachProductCodes — AI 가 돌려준 품목에 품번이 안 붙었으면, 같은 줄에 적힌 품번을 찾아 붙인다.
//      등록된 품번(products)에 있는 것만 붙인다 — 오타 품번이 조용히 들어가지 않게.
//   3. codeNameMismatch — 품번의 원단명과 적은 이름이 다르면 등록 전에 알린다(숫자 하나 틀린 품번을 잡는 길).
// 저장 때 productId 를 잇는 건 OrderInput.linkProduct 가 itemNo 로 한다(지금 그대로).

// 품번 꼴: 접두어(영문으로 시작, 영문·숫자 1~6) - 년월 4자리 - 일련번호 4자리 이상.
// 옛 아이템 번호(A-001)는 안 잡히고, 접두어가 영문으로 시작해야 전화번호(010-1234-5678)가 안 걸린다.
export const PRODUCT_CODE_RE = /\b([A-Z][A-Z0-9]{0,5}-\d{4}-\d{4,})\b/gi;

const upper = (s) => String(s || "").trim().toUpperCase();
const sq = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

/**
 * 품번 끝의 롤 번호를 뗀다. 'S-2610-0010-R01' → 'S-2610-0010'. 롤 번호가 없으면 그대로(대문자, 양끝 공백 제거).
 * 셀러가 로하톡에 롤 라벨의 코드(품번-R01)를 그대로 적는 일이 잦다(2026-10-15 이인희 주문). 사람은 "같은 원단
 * S-2610-0010 의 1번 롤"로 읽지만, 글자 그대로 비교하면 등록 품번과 안 맞아 포장대 스캔이 품목을 못 찾았다.
 * 품번 꼴(접두어-년월-일련번호) 뒤에 붙은 '-R숫자'만 뗀다 — 다른 글자는 건드리지 않는다.
 */
export function baseProductCode(code) {
  return upper(code).replace(/^([A-Z][A-Z0-9]{0,5}-\d{4}-\d{4,})-R\d+$/, "$1");
}

/** 글에 든 품번들(대문자, 순서대로, 중복 제거). */
export function findProductCodes(text) {
  const out = [];
  for (const m of String(text || "").matchAll(PRODUCT_CODE_RE)) {
    const c = m[1].toUpperCase();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * AI 에 넣기 전 다듬기.
 *   "린넨코튼(S-2610-0005) 3마"  → "S-2610-0005 린넨코튼 3마"
 *   "린넨코튼 [s-2610-0005] 3마" → "S-2610-0005 린넨코튼 3마"
 *   "s-2610-0005 린넨코튼"       → "S-2610-0005 린넨코튼"
 * 괄호 앞의 한 낱말(원단명)만 품번 뒤로 옮긴다 — 그 앞의 다른 글(고객명 등)은 건드리지 않는다.
 */
export function normalizeProductCodes(text) {
  if (!text) return text;
  let s = String(text);
  // 괄호·대괄호 안의 품번 → 품번을 앞 낱말 앞으로
  s = s.replace(/([^\s()\[\]]+)\s*[(\[]\s*([A-Za-z][A-Za-z0-9]{0,5}-\d{4}-\d{4,})\s*[)\]]/g, (_, word, code) => `${code.toUpperCase()} ${word}`);
  // 낱개 괄호 품번(앞에 낱말이 없을 때) → 괄호만 벗긴다
  s = s.replace(/[(\[]\s*([A-Za-z][A-Za-z0-9]{0,5}-\d{4}-\d{4,})\s*[)\]]/g, (_, code) => code.toUpperCase());
  // 남은 소문자 품번 → 대문자
  s = s.replace(PRODUCT_CODE_RE, (m) => m.toUpperCase());
  // 롤 번호가 붙은 품번(S-2610-0010-R01) → 품번만. AI 가 롤 코드를 통째로 품번으로 읽지 않게.
  s = s.replace(/\b([A-Z][A-Z0-9]{0,5}-\d{4}-\d{4,})-R\d+\b/gi, (_, code) => code.toUpperCase());
  return s;
}

/** 품번으로 등록 품번 찾기(대소문자 무시). 롤 번호가 붙어 있어도(S-2610-0010-R01) 품번으로 찾는다. */
export function productByCode(products, code) {
  const k = baseProductCode(code);
  return k ? (products || []).find(p => upper(p.code) === k) || null : null;
}

/**
 * AI 가 돌려준 품목에 품번을 붙인다.
 *   · 이미 itemNo 가 등록 품번이면 그대로(대문자로만 맞춘다)
 *   · 아니면 그 품목의 원단명이 적힌 줄에서 품번을 찾는다
 *   · 그래도 없고, 글의 품번 수와 품목 수가 같으면 순서대로 붙인다
 * 등록되지 않은 품번은 붙이지 않는다. 원단명이 비어 있으면 품번의 원단명·색상을 채운다.
 * 반환: 새 items 배열(원본은 안 바꾼다).
 */
export function attachProductCodes(text, items, products) {
  const codes = findProductCodes(text).filter(c => productByCode(products, c));
  const lines = String(text || "").split(/\r?\n/);
  const used = new Set();
  const out = (items || []).map(it => ({ ...it }));
  // 1) 이미 적힌 itemNo
  for (const it of out) {
    const p = productByCode(products, it.itemNo);
    if (p) { it.itemNo = p.code; used.add(upper(p.code)); }
  }
  // 2) 같은 줄의 품번
  for (const it of out) {
    if (productByCode(products, it.itemNo)) continue;
    const name = sq(it.fabric);
    if (!name) continue;
    const line = lines.find(l => sq(l).includes(name) && findProductCodes(l).some(c => productByCode(products, c)));
    if (!line) continue;
    const c = findProductCodes(line).find(c => productByCode(products, c) && !used.has(c)) || findProductCodes(line).find(c => productByCode(products, c));
    if (c) { it.itemNo = c; used.add(c); }
  }
  // 3) 수가 같으면 순서대로
  const left = out.filter(it => !productByCode(products, it.itemNo));
  const unused = codes.filter(c => !used.has(c));
  if (left.length && left.length === unused.length) {
    left.forEach((it, i) => { it.itemNo = unused[i]; used.add(unused[i]); });
  }
  // 빈 원단명은 품번에서 채운다
  for (const it of out) {
    const p = productByCode(products, it.itemNo);
    if (p && !String(it.fabric || "").trim()) { it.fabric = p.name || ""; if (!String(it.color || "").trim()) it.color = p.color || ""; }
  }
  return out;
}

/**
 * 품번의 원단명과 적은 이름이 다른가. 적은 이름이 없으면 다르지 않다(품번만 적은 것).
 * 띄어쓰기·대소문자는 무시하고, 한쪽이 다른 쪽을 품으면 같다고 본다("린넨코튼" vs "린넨코튼 베이지").
 */
export function codeNameMismatch(item, product) {
  if (!item || !product) return false;
  const a = sq(item.fabric), b = sq(product.name);
  if (!a || !b) return false;
  const ab = sq(`${item.fabric} ${item.color || ""}`), pb = sq(`${product.name} ${product.color || ""}`);
  return !(a.includes(b) || b.includes(a) || ab.includes(b) || pb.includes(a));
}

/**
 * 품번이 맞은 품목의 빈 단가·금액을 품번 단가로 채운다(2026-10-08 — 로하톡 "LH-2610-0005 테스트 원단 5마"가 단가 0 으로 들어왔다).
 * 손으로 품번을 고를 때(OrderInput.pickProductPatch)만 단가가 채워지고, 로하톡·AI 경로는 AI 가 읽은 금액만 썼다.
 * 원단명·색상은 적은 그대로 둔다 — 등록 전 품번↔원단명 대조(codeNameMismatch)에 쓴다. productId·itemNo 는 맞춘다.
 * 적은 단가·금액이 있으면 그걸 믿는다(세일가 등).
 */
export function fillPriceFromProduct(items, products) {
  return (items || []).map(it => {
    const p = productByCode(products, it?.itemNo) || (it?.productId ? (products || []).find(x => x.id === it.productId) : null);
    if (!p) return it;
    const out = { ...it, productId: p.id, itemNo: p.code };
    const price = Number(p.unitPrice);
    if (!(parseInt(it.unitPrice) || 0) && price > 0) {
      out.unitPrice = price;
      const qty = parseFloat(it.qty) || 0;
      if (!(parseInt(it.amount) || 0) && qty > 0) out.amount = Math.round(price * qty);
    }
    return out;
  });
}

/** 로하톡에 붙여 넣을 한 줄 — "품번 원단명 색상". 🔗 링크 탭의 '품번 복사'가 쓴다. */
export function productLineText(p) {
  return `${p?.code || ""} ${p?.name || ""}${p?.color ? ` ${p.color}` : ""}`.trim();
}
