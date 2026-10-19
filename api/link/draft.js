// POST /api/link/draft?k=...   공개 링크(게시글)의 "주문하기".
// body { code, qty, unit, phone, customerName, depositorName, address, addressDetail, deliveryMessage,
//        mergeWithOrderId, useFreeShipping, creditUse, rollIds, managerId, privacyAgreed }
// managerId(링크 ?m=) 는 링크를 복사한 담당자 — 이름으로 바꿔 created_by 에 둔다. 전환 때 그 담당자로 등록된다.
// 롤 주문(unit=롤)은 qty 대신 rollIds 로 "어느 롤"을 고른다 — qty 는 고른 롤 수, 금액은 단가 × 고른 롤 길이 합.
//
// 4단계 초안판(2026-10-07 되돌림): 전화번호가 30분 안에 인증된 번호여야 한다(/api/sms-verify).
// 합배송 대상은 그 번호의 후보 조건을 서버가 다시 만족하는지 본다. 배송권은 기존 고객 카드의 이름으로만 센다.
// 택배비는 computeShippingFee(클라이언트와 같은 함수)로 서버가 다시 찍는다 — 클라이언트 값 안 믿음. 마 4,000 · 롤 7,000 고정.
// use_last_address·wants_merge 칸은 4단계-B 흔적 — 항상 false.
// orders 에 쓰지 않는다. link_order_drafts 에만. 셀러가 ERP 에서 전환해야 주문이 된다.
import { gate, fail, sb, COMPANY_USER_ID, isPhoneVerified, findCustomerByPhone, findMergeCandidates, couponRowsFor, creditRowsFor, findProductByCode, findAvailableRolls, findManagerNameById } from "./_common.js";
import { cleanDraftInput, validateQty, maxRemainingOf, maxFor, pickRolls, computeShippingFee, computeTotal, couponCountFor, creditBalanceFor, computeCreditUse, tooManyRecent, DRAFT_RATE_LIMIT } from "./_logic.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  if (!gate(req, res)) return;
  const input = cleanDraftInput(req.body);
  if (!input.code) return fail(res, 400, "품번이 없습니다");
  if (input.phone.length < 10) return fail(res, 400, "올바른 전화번호를 입력해 주세요");
  if (!input.customerName) return fail(res, 400, "이름을 입력해 주세요");
  if (!input.address) return fail(res, 400, "주소를 입력해 주세요");
  if (!input.privacyAgreed) return fail(res, 400, "개인정보 수집·이용에 동의해 주세요");
  try {
    if (!(await isPhoneVerified(input.phone))) return fail(res, 403, "전화번호 인증이 필요합니다 (인증 후 30분 안에 진행해 주세요)");

    // 같은 번호로 1분 안에 3건 넘으면 429
    const since = new Date(Date.now() - DRAFT_RATE_LIMIT.windowMs).toISOString();
    const recent = await sb().from("link_order_drafts").select("created_at").eq("user_id", COMPANY_USER_ID).eq("phone", input.phone).gte("created_at", since);
    if (recent.error) throw recent.error;
    if (tooManyRecent((recent.data || []).map(r => r.created_at))) return fail(res, 429, "잠시 후 다시 시도해 주세요 (1분에 3건까지)");

    // 상품·재고 — 서버가 다시 본다
    const product = await findProductByCode(input.code);
    if (!product) return fail(res, 404, "상품을 찾을 수 없습니다");
    const rolls = await findAvailableRolls(product.id);
    const stock = maxRemainingOf(rolls);
    // 롤 주문은 고른 롤이 지금도 판매 가능한지 본다. 마 주문은 수량이 가장 긴 롤 안인지 본다.
    let q, picked = null;
    if (input.unit === "롤") {
      picked = pickRolls(input.rollIds, rolls);
      if (!picked.ok) return fail(res, 400, picked.reason);
      q = { ok: true, value: picked.rolls.length };
    } else {
      q = validateQty(input.qty, maxFor(input.unit, stock), input.unit);
      if (!q.ok) return fail(res, 400, q.reason);
    }

    // 합배송 대상 — 그 번호의 후보 조건을 다시 만족해야 한다(그 사이 나갔거나 묶을 수 없게 됐을 수 있다)
    let mergeWithOrderId = null;
    if (input.mergeWithOrderId) {
      const cands = await findMergeCandidates(input.phone);
      const hit = cands.find(o => String(o.id) === String(input.mergeWithOrderId));
      if (!hit) return fail(res, 400, "함께 보낼 주문을 다시 골라 주세요 (이미 출고됐거나 합배송할 수 없는 주문입니다)");
      mergeWithOrderId = String(hit.id);
    }

    // 고객·배송권 — 이름은 고객이 적은 것, 배송권은 기존 고객 카드의 이름으로만(동명이인이면 0)
    const customer = await findCustomerByPhone(input.phone);
    let couponCount = 0;
    if (input.useFreeShipping && customer?.name) {
      const { sameNameCount, rows } = await couponRowsFor(customer.name);
      couponCount = couponCountFor(sameNameCount, rows).count;
    }
    // 택배비는 단위로 고정(마 4,000 · 롤 7,000) — 설정값을 안 본다
    const shippingFee = computeShippingFee({ useFreeShipping: input.useFreeShipping, couponCount, mergeWithOrderId, unit: input.unit });
    // 단가는 마당. 롤 주문은 고른 롤 길이 합 × 단가(롤을 골랐으니 금액이 선다).
    const unitPrice = product.unit_price === null || product.unit_price === undefined ? null : Number(product.unit_price);
    const { total, priceKnown } = computeTotal(unitPrice, picked ? picked.totalLength : q.value, shippingFee);

    // 적립금 — 기존 고객 카드의 이름으로만(배송권과 같다). 잔액·주문 금액 안으로 깎는다. 초안 단계에서는 차감하지 않는다 —
    // 셀러가 전환해 등록할 때 db.applyOrderCredit 가 잔액을 다시 보고 실제로 뺀다.
    let creditUse = 0;
    if (input.creditUse > 0 && customer?.name) {
      const { sameNameCount, rows } = await creditRowsFor(customer.name);
      const { balance } = creditBalanceFor(sameNameCount, rows);
      creditUse = computeCreditUse({ requested: input.creditUse, balance, orderTotal: total, priceKnown });
    }

    const createdBy = await findManagerNameById(input.managerId);
    const { data, error } = await sb().from("link_order_drafts").insert({
      user_id: COMPANY_USER_ID, status: "new", source: "public", created_by: createdBy || null,
      product_id: product.id, product_code: product.code, product_name: `${product.name}${product.color ? ` ${product.color}` : ""}`,
      unit_price: unitPrice, qty: q.value, unit: input.unit,
      phone: input.phone, customer_name: input.customerName, customer_id: customer?.id || null, depositor_name: input.depositorName,
      address: input.address, address_detail: input.addressDetail,
      delivery_message: input.deliveryMessage,
      use_last_address: false, wants_merge: false,
      merge_with_order_id: mergeWithOrderId, use_free_shipping: input.useFreeShipping && couponCount > 0,
      credit_use: creditUse,
      rolls: picked ? picked.rolls : null,
      shipping_fee: shippingFee, total_amount: total,
      privacy_agreed_at: new Date().toISOString(),
    }).select("id").single();
    if (error) throw error;
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ draftId: data.id, creditUse, shippingFee, totalAmount: total });
  } catch (e) {
    console.error("[link/draft]", e);
    return fail(res, 500, "주문 접수에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
