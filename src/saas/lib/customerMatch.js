// AI 분석 결과 ↔ 고객 매칭 — 옛 OrderInput.jsx 의 matchCustomer·phoneMatches·addressMatches 를 그대로 옮긴 순수 함수.
// OrderInput 안에 갇혀 있어(export 없음) 가져다 쓸 수 없었다. 규칙은 한 글자도 바꾸지 않았다 — 두 화면이 같은 사람을 골라야 한다.
export const normLoose = (raw) => String(raw || "").replace(/\s+/g, "").toLowerCase();

export function addressMatches(addrA, addrB) {
  if (!addrA || !addrB) return false;
  const norm = (s) => String(s).replace(/\s+/g, "").toLowerCase();
  const a = norm(addrA), b = norm(addrB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  return false;
}

export function phoneMatches(orderPhone, custPhone, parsedMid) {
  const oDigits = String(orderPhone || "").replace(/\D/g, "");
  const cDigits = String(custPhone || "").replace(/\D/g, "");
  if (oDigits.length >= 10 && cDigits.length >= 10) return oDigits === cDigits;
  const oMid = oDigits.length >= 10 ? oDigits.slice(3, 7) : (oDigits.length === 4 ? oDigits : parsedMid || null);
  const cMid = cDigits.length >= 10 ? cDigits.slice(3, 7) : (cDigits.length === 4 ? cDigits : null);
  return !!(oMid && cMid && oMid === cMid);
}

/**
 * @returns { type: "confirmed"|"phone_changed"|"maybe"|"name_list"|"new", match, list }
 */
export function matchCustomer(parsed, customers) {
  const pName = parsed.customerName || null;
  const pMid = parsed.customerMidPhone || null;
  const pNick = parsed.customerNickname || null;
  const pPhone = parsed.phone || null;
  const pAddr = parsed.address || null;
  if (!pName && !pMid && !pNick && !pPhone && !pAddr) return { type: "new", match: null, list: [] };

  const scored = (customers || []).map(c => {
    let score = 0, nameMatch = false, midMatch = false, nickMatch = false, addrMatch = false;
    if (pNick && c.nickname && normLoose(c.nickname) !== normLoose(pNick)) return { customer: c, score: 0, nameMatch, midMatch, nickMatch, addrMatch };
    if (pName && c.name && c.name.includes(pName)) { score++; nameMatch = true; }
    if (phoneMatches(pPhone, c.phone, pMid)) { score++; midMatch = true; }
    if (pNick && c.nickname && normLoose(c.nickname) === normLoose(pNick)) { score++; nickMatch = true; }
    if (addressMatches(pAddr, c.address) || addressMatches(pAddr, c.address2)) { score++; addrMatch = true; }
    return { customer: c, score, nameMatch, midMatch, nickMatch, addrMatch };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { type: "new", match: null, list: [] };
  const best = scored[0];
  if (best.score >= 2 && best.nameMatch) {
    const oDigits = String(pPhone || "").replace(/\D/g, "");
    const cDigits = String(best.customer.phone || "").replace(/\D/g, "");
    if (oDigits.length >= 10 && cDigits.length >= 10 && oDigits !== cDigits) return { type: "phone_changed", match: best.customer, list: [] };
    return { type: "confirmed", match: best.customer, list: [] };
  }
  if (best.score >= 2 && !best.nameMatch) return { type: "maybe", match: best.customer, list: [] };
  if (best.midMatch || best.nickMatch) return { type: "maybe", match: best.customer, list: [] };
  if (best.nameMatch) {
    const nameMatches = scored.filter(s => s.nameMatch).map(s => s.customer);
    if (nameMatches.length === 1) return { type: "maybe", match: nameMatches[0], list: [] };
    return { type: "name_list", match: null, list: nameMatches };
  }
  return { type: "new", match: null, list: [] };
}

/** 영수증 종류 자동 감지(옛 OrderInput.detectReceiptType) */
export function detectReceiptType(text) {
  if (!text) return null;
  if (/현금[ \t]*영수증/.test(text)) return "cash";
  if (/지출[ \t]*증빙/.test(text)) return "business";
  if (/세금[ \t]*계산서|계산서/.test(text)) return "tax_invoice";
  return null;
}

/** "이명화4767(샤크)" → "이명화" */
export const cleanName = (raw) => String(raw || "").replace(/\([^)]*\)/g, "").replace(/\d+/g, "").trim();
