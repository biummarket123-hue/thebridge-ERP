// 주문 등록 — 옛 OrderInput.handleRegister 의 핵심 경로를 옮긴 것(지시서 4절 "주문 관리 · AI 분석 / 등록").
//   분석:  normalizeProductCodes → preprocessOrderText → aiParseText → attachProductCodes/fillPriceFromProduct → validateAndCorrectAmounts
//   등록:  고객 확정(서버에서 한 번 더 찾는다 db.findCustomersFresh) → 택배비 겹침 안내 → db.insertOrder → 고객 등록/갱신
//          → 같은 고객 자동 합배송(findMergeCandidates → updateOrdersBulk + applyGroupFreight) → 적립금(applyOrderCredit)
// 옛 코드에 있던 이미지 첨부·무료배송권 자동 사용·링크 초안·메모 등록·방문고객 즉시 출고는 뺐다 — 옛 화면에서 처리(보고서에 적는다).
import * as db from "../../lib/db.js";
import { aiParseText, aiParseImage, preprocessOrderText, nowT } from "../../constants.js";
import { validateAndCorrectAmounts } from "../../lib/validation.js";
import { normalizeProductCodes, attachProductCodes, fillPriceFromProduct, codeNameMismatch, productByCode } from "../../lib/productCodes.js";
import { defaultShipDate } from "../../lib/shipDate.js";
import { findMergeCandidates, groupShipTarget } from "../../lib/autoMerge.js";
import { previewFreightOverlap, patchOrdersWithGroupResult } from "../../lib/freight.js";
import { detectReceiptType, cleanName, normLoose, addressMatches } from "../lib/customerMatch.js";

/** 글 → 분석 결과. products 가 있으면 품번을 붙이고 단가를 채운다. */
export async function analyzeText(text, products) {
  const cleaned = preprocessOrderText(normalizeProductCodes(text));
  const result = await aiParseText(cleaned);
  if (Array.isArray(result?.items)) result.items = fillPriceFromProduct(attachProductCodes(cleaned, result.items, products), products);
  const detected = detectReceiptType(text);
  if (detected) result.receiptType = detected;
  const validated = validateAndCorrectAmounts(result);
  // 품번의 원단명과 적은 이름이 다르면 알린다(숫자 하나 틀린 품번을 잡는 길)
  const mismatches = (validated.items || []).map(it => { const p = productByCode(products, it.itemNo); return p && codeNameMismatch(it, p) ? `${it.itemNo} 는 "${p.name}" 인데 "${it.fabric}" 로 적혀 있습니다` : null; }).filter(Boolean);
  return { parsed: validated, mismatches };
}

export async function analyzeImage(base64, mimeType, products) {
  const result = await aiParseImage(base64, mimeType);
  if (Array.isArray(result?.items)) result.items = fillPriceFromProduct(result.items, products);
  return { parsed: validateAndCorrectAmounts(result), mismatches: [] };
}

const newGroupId = () => (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `mg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * 등록. data: 폼 값(customer, phone, items, payment, address, address_detail, deliveryMessage, note, memo, totalAmount, shippingFee, otherCost,
 *       combinedPayment, combinedShipping, salesChannel, receiptType, shipDate, isUrgent, courier, creditUse, customerNickname)
 * resolvedCust: 고객 매칭 창에서 확정한 고객(없으면 null → 서버에서 한 번 더 찾는다)
 * ctx: { orders, customers, activeManager, confirm(msg)→Promise<bool>, toast }
 * 반환 { saved, finalOrder, patches: [fn(orders)=>orders…], messages: [] }
 */
export async function registerOrder(data, resolvedCustIn, ctx) {
  const { orders, customers, activeManager, confirm } = ctx;
  const messages = [];
  const t = nowT();
  let resolvedCust = resolvedCustIn || null;
  let keepBaseAddress = false;
  const nameForNew = cleanName(data.customer) || data.customer || "";

  // ── 중복 고객 방어선(옛 코드와 같은 규칙, 확인창만 confirm 콜백) ──
  let custPool = customers || [];
  if (!resolvedCust) {
    try {
      const fresh = await db.findCustomersFresh({ phoneDigits: data.phone, name: nameForNew });
      const have = new Set(custPool.map(c => c.id));
      custPool = [...custPool, ...fresh.filter(c => !have.has(c.id))];
    } catch (e) { console.warn("[saas] 고객 서버 조회 실패 — 화면 목록으로 판단", e); }
    const nName = normLoose(nameForNew);
    const nPhone = String(data.phone || "").replace(/\D/g, "");
    if (nName && nName !== "미확인") {
      const sameName = custPool.filter(c => normLoose(c.name) === nName);
      const exact = nPhone ? sameName.find(c => String(c.phone || "").replace(/\D/g, "") === nPhone) : null;
      if (exact) {
        resolvedCust = exact;
        const newAddr = String(data.address || "").trim();
        const differs = newAddr && String(exact.address || "").trim() && !addressMatches(newAddr, exact.address) && !addressMatches(newAddr, exact.address2);
        if (differs) {
          const changeBase = await confirm(`기존 고객으로 등록합니다.\n\n${exact.name}${exact.nickname ? ` (${exact.nickname})` : ""}\n${exact.phone || "연락처 없음"}\n\n등록된 배송지:\n  ${exact.address}\n이번 주문 배송지:\n  ${newAddr}\n\n[확인] 기본 배송지를 이번 주소로 변경\n[취소] 기존 배송지 유지 (이번 주문만 새 주소로 발송)`);
          keepBaseAddress = !changeBase;
        }
      } else {
        const ambiguous = sameName.filter(c => !nPhone || !String(c.phone || "").replace(/\D/g, ""));
        if (ambiguous.length > 0) {
          const pNick = normLoose(data.customerNickname || "");
          const ranked = [...ambiguous].sort((a, b) => {
            const an = pNick && normLoose(a.nickname) === pNick ? 1 : 0, bn = pNick && normLoose(b.nickname) === pNick ? 1 : 0;
            if (an !== bn) return bn - an;
            return (b.totalOrders || 0) - (a.totalOrders || 0);
          });
          const c = ranked[0];
          const ok = await confirm(`이미 등록된 고객일 수 있습니다.\n\n${c.name}${c.nickname ? ` (${c.nickname})` : ""}\n${c.phone || "연락처 없음"}${c.address ? `\n${c.address}` : ""}\n주문 ${c.totalOrders || 0}건\n\n[확인] 이 고객의 주문으로 등록\n[취소] 다른 사람 — 새 고객으로 등록${ranked.length > 1 ? `\n\n※ 같은 이름의 고객이 ${ranked.length}명 있습니다.` : ""}`);
          if (ok) { resolvedCust = c; keepBaseAddress = true; }
        }
      }
    }
  }
  let custRoute = null, typedAsNick = "";
  if (!resolvedCust) {
    const nPhone = String(data.phone || "").replace(/\D/g, "");
    if (nPhone.length >= 9) {
      const nName = normLoose(nameForNew);
      const samePhone = custPool.filter(c => String(c.phone || "").replace(/\D/g, "") === nPhone && normLoose(c.name) !== nName).sort((a, b) => (b.totalOrders || 0) - (a.totalOrders || 0));
      if (samePhone.length > 0) {
        const c = samePhone[0];
        const ok = await confirm(`같은 전화번호의 고객이 이미 있습니다.\n\n입력한 이름:  ${nameForNew || "(없음)"}\n등록된 고객:  ${c.name}${c.nickname ? ` (${c.nickname})` : ""} · 주문 ${c.totalOrders || 0}건\n\n[확인] 같은 사람 — ${c.name} 님의 주문으로 등록\n[취소] 다른 사람 — 새 고객으로 등록 (가족·같은 공방 등)`);
        if (ok) { resolvedCust = c; keepBaseAddress = true; if (!c.nickname && !data.customerNickname && nameForNew && nameForNew !== "미확인") typedAsNick = nameForNew; }
        else custRoute = `주문입력(새 UI) · 같은 번호 고객(${samePhone.slice(0, 3).map(o => o.name).join(", ")})이 있었지만 새 고객으로 등록`;
      }
    }
  }
  const customerForOrder = resolvedCust?.name || nameForNew || "미확인";
  const orderPayment = data.payment || "미입금";

  // ── 합배송 택배비 안내 ──
  {
    const NEW_ID = "__new__";
    const fresh = { id: NEW_ID, createdAt: new Date().toISOString(), customer: customerForOrder, phone: data.phone, address: data.address, payment: orderPayment, shippingFee: parseInt(data.shippingFee) || 0, totalAmount: data.totalAmount || 0 };
    const base = findMergeCandidates(fresh, orders).candidates;
    const gids = new Set(base.map(o => o.mergeGroupId).filter(Boolean));
    const group = orders.filter(o => o.status !== "출고완료" && !o.splitShipping && (base.includes(o) || (o.mergeGroupId && gids.has(o.mergeGroupId))));
    const pre = previewFreightOverlap(fresh, group);
    if (pre) {
      const wonf = (n) => `${Number(n || 0).toLocaleString()}원`;
      const label = (o) => o.id === NEW_ID ? "지금 등록하는 주문" : `${o.date || ""} 주문`.trim();
      const after = pre.conflict ? "입금완료 주문 2건에 택배비가 각각 있어 자동으로 정리되지 않습니다. 등록 후 운임비 조정으로 직접 정해 주세요."
        : pre.changes.length ? "묶이면 먼저 등록된 한 건의 택배비만 남습니다:\n" + pre.changes.map(c => `• ${label(c.order)} — 택배비 ${wonf(c.from)} → 0원${c.totalTo !== undefined ? ` · 전체금액 ${wonf(c.totalFrom)} → ${wonf(c.totalTo)}` : ""}`).join("\n")
        : "입금이 끝난 주문이라 택배비가 그대로 남습니다.";
      const ok = await confirm(`합배송 택배비 안내\n\n${customerForOrder} 님의 합배송 주문에 택배비가 ${pre.holders.length}건 있습니다:\n${pre.holders.map(o => `• ${label(o)} — 택배비 ${wonf(o.shippingFee)}`).join("\n")}\n\n${after}\n\n이대로 등록할까요?`);
      if (!ok) return null;
    }
  }

  // ── 1) 저장 ──
  const saved = await db.insertOrder({
    ...t, customer: customerForOrder, phone: data.phone || null, items: data.items || [], payment: orderPayment,
    address: data.address || null, addressDetail: data.address_detail || null, deliveryMessage: data.deliveryMessage || "", links: data.links || [],
    note: data.note || null, memo: (data.memo && data.memo.trim()) ? data.memo.trim() : null, status: "접수", manager: activeManager || "",
    totalAmount: data.totalAmount || 0, shippingFee: data.shippingFee || 0, courier: data.courier || null, otherCost: data.otherCost || 0,
    combinedPayment: !!data.combinedPayment, combinedShipping: !!data.combinedShipping, salesChannel: data.salesChannel || "", receiptType: data.receiptType || null,
    shipDate: data.shipDate || defaultShipDate(), isUrgent: !!data.isUrgent,
  }, { route: custRoute || "주문 등록 · 새 UI" });
  let finalOrder = saved;
  const patches = [];
  const patch = (fields) => { finalOrder = { ...finalOrder, ...fields }; patches.push(os => os.map(o => o.id === saved.id ? { ...o, ...fields } : o)); };

  // ── 2) 적립금 ──
  const creditUse = parseInt(data.creditUse) || 0;
  if (creditUse > 0) {
    if (orderPayment === "입금완료") messages.push(["이미 완납 주문이라 적립금은 적용하지 않았습니다", "error"]);
    else {
      try {
        const orderTotal = data.totalAmount > 0 ? data.totalAmount : (data.items || []).reduce((s, i) => s + (i.amount || 0), 0) + (data.shippingFee || 0) + (data.otherCost || 0);
        const r = await db.applyOrderCredit({ customer: customerForOrder, orderId: saved.id, requested: creditUse, orderTotal, manager: activeManager, fallbackPayment: orderPayment });
        if (r.useAmt <= 0) messages.push([`${customerForOrder}님 적립금을 적용하지 않았습니다 — ${r.skipped}`, "error"]);
        else { if (r.computed.paymentStatus === "입금완료") patch({ payment: "입금완료" }); patch({ _computed: r.computed }); messages.push([`적립금 ${r.useAmt.toLocaleString()}원 사용 (잔여 ${(r.bal - r.useAmt).toLocaleString()}원)`]); }
      } catch (e) { messages.push(["주문은 등록됐지만 적립금 적용 실패: " + e.message, "error"]); }
    }
  }

  // ── 3) 고객 ──
  let customerPatch = null;
  try {
    if (resolvedCust) {
      const isSecondAddr = !!(resolvedCust.address2 && data.address && addressMatches(data.address, resolvedCust.address2));
      const sameAddr = !data.address || addressMatches(data.address, resolvedCust.address);
      const updated = await db.updateCustomer(resolvedCust.id, {
        ...resolvedCust, totalOrders: (resolvedCust.totalOrders || 0) + 1, lastOrder: t.date, phone: data.phone || resolvedCust.phone,
        address: (isSecondAddr || keepBaseAddress) ? resolvedCust.address : (data.address || resolvedCust.address),
        addressDetail: (isSecondAddr || keepBaseAddress) ? resolvedCust.addressDetail : (data.address_detail || (sameAddr ? resolvedCust.addressDetail : "")),
        nickname: data.customerNickname || resolvedCust.nickname || typedAsNick,
      });
      if (updated) customerPatch = { kind: "update", customer: updated };
    } else if (data.customer) {
      let nick = data.customerNickname || "";
      if (!nick) { const m = (data.customer || "").match(/\(([^)]+)\)/); if (m) nick = m[1]; }
      const newCust = await db.insertCustomer({ name: nameForNew, phone: data.phone || "", address: data.address || "", addressDetail: data.address_detail || "", totalOrders: 1, lastOrder: t.date, note: "", nickname: nick });
      if (newCust) customerPatch = { kind: "insert", customer: newCust };
    }
  } catch (e) { messages.push(["주문은 등록됐지만 고객정보 저장 실패: " + e.message, "error"]); }

  // ── 4) 같은 고객 자동 합배송 ──
  try {
    const { candidates, needsAsk } = findMergeCandidates(finalOrder, orders);
    if (candidates.length > 0) {
      let doMerge = true;
      const target = groupShipTarget([finalOrder, ...candidates]);
      if (needsAsk) doMerge = await confirm(`같은 고객의 주문 ${candidates.length}건이 아직 안 나갔습니다. 그중 예약(모레 이후) 건이 있어 묻습니다.\n\n묶으면 출고예정일이 ${target.shipDate || "미정"} 로 맞춰집니다.\n\n[확인] 합배송으로 묶기\n[취소] 따로 보내기`);
      if (doMerge) {
        const groupId = candidates.map(o => o.mergeGroupId).find(Boolean) || newGroupId();
        const allIds = [finalOrder.id, ...candidates.map(o => o.id)];
        await db.updateOrdersBulk(allIds, { mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent }, { route: "자동 합배송 · 새 UI" });
        patches.push(os => os.map(o => allIds.includes(o.id) ? { ...o, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent } : o));
        finalOrder = { ...finalOrder, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent };
        try {
          const members = [finalOrder, ...candidates.map(o => ({ ...o, mergeGroupId: groupId, shipDate: target.shipDate, isUrgent: target.isUrgent }))];
          const freight = await db.applyGroupFreight(members, { route: "자동 합배송 · 새 UI" });
          const res = { ids: allIds, dateChanged: false, freight };
          patches.push(os => patchOrdersWithGroupResult(os, res));
          if (freight.conflict) messages.push(["입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다", "error"]);
        } catch (e) { messages.push(["묶였지만 택배비 자동 조정 실패: " + e.message, "error"]); }
        const packed = candidates.filter(o => o.status === "포장완료").length;
        messages.push([packed > 0 ? `📦 자동 합배송 ${allIds.length}건 — 포장완료 ${packed}건 포함, 박스를 다시 열어 합쳐야 합니다` : `📦 같은 고객 주문 ${allIds.length}건 자동 합배송`, packed > 0 ? "error" : "ok"]);
      }
    }
  } catch (e) { messages.push(["주문은 등록됐지만 자동 합배송 실패: " + e.message, "error"]); }

  return { saved, finalOrder, patches, customerPatch, messages };
}
