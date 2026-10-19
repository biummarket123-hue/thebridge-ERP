// POST /api/link/customer?k=...   body { phone }
// 인증된 전화번호의 고객 정보 — 기존 고객이면 이름·주소, 합배송 후보(그 번호의 미출고 주문만),
// 무료배송권(그 이름만 · 동명이인이면 0 + nameAmbiguous). 인증 안 된 번호면 403.
import { gate, fail, isPhoneVerified, findCustomerByPhone, findMergeCandidates, couponRowsFor, creditRowsFor } from "./_common.js";
import { normPhone, candidateView, couponCountFor, creditBalanceFor } from "./_logic.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "Method not allowed");
  if (!gate(req, res)) return;
  const phone = normPhone(req.body?.phone);
  if (phone.length < 10) return fail(res, 400, "올바른 전화번호를 입력해 주세요");
  try {
    if (!(await isPhoneVerified(phone))) return fail(res, 403, "전화번호 인증이 필요합니다 (인증 후 30분 안에 진행해 주세요)");
    const [customer, candidates] = await Promise.all([findCustomerByPhone(phone), findMergeCandidates(phone)]);
    let coupons = { count: 0, nameAmbiguous: false };
    let credit = { balance: 0, nameAmbiguous: false };
    if (customer?.name) {
      const [cp, cr] = await Promise.all([couponRowsFor(customer.name), creditRowsFor(customer.name)]);
      coupons = couponCountFor(cp.sameNameCount, cp.rows);
      credit = creditBalanceFor(cr.sameNameCount, cr.rows);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      customerId: customer?.id || null,
      name: customer?.name || "", nickname: customer?.nickname || "",
      address: customer?.address || "", addressDetail: customer?.address_detail || "",
      mergeCandidates: candidates.map(candidateView),
      freeShippingCount: coupons.count, nameAmbiguous: coupons.nameAmbiguous,
      creditBalance: credit.balance,   // 적립금 잔액(동명이인이면 0 — nameAmbiguous 가 같이 true)
    });
  } catch (e) {
    console.error("[link/customer]", e);
    return fail(res, 500, "고객 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
