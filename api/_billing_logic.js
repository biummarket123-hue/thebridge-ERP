// 토스페이먼츠 빌링(자동 결제)의 순수 계산 — DB 도 fetch 도 없다. api/billing.js·api/billing-cron.js 가 쓰고
// tests/saas/test-billing-logic.mjs 가 그대로 돌린다.
//
// 확장자는 .js 여야 한다(.mjs 아님) — api/link/_logic.js 머리말 참고(Vercel 이 api/*.js 를 CJS 로 묶는다).
// 파일 이름이 _ 로 시작하면 Vercel 이 서버 함수로 배포하지 않는다.
//
// 기간 규칙은 ops-subscription.mjs 의 extend 와 같다: 남은 기간이 있으면 그 끝에서 +N일, 없으면 지금부터 +N일.
// 체험 중인 회사가 결제하면 체험이 끝난 뒤부터 30일 — 화면 문구("체험 끝난 뒤부터 30일")와 이 함수가 같은 답을 내야 한다.

export const DAY = 86400000;
export const PERIOD_DAYS = 30;          // 한 번 결제 = 30일
export const GRACE_DAYS = 3;            // 기간이 지난 뒤 유예(subscription.js GRACE_DAYS 와 같은 값)
export const AUTO_CHARGE_BEFORE_DAYS = 1; // 기간 끝 하루 전부터 자동 결제 대상

// 요금제(이름·가격·담당자 수·AI·문자 한도)는 api/_plans.js 가 단일 출처(2026-10-23). 여기서 다시 내보낸다.
import { PAID_PLANS, PLAN_LABELS, PLAN_SEATS, PLAN_AI_CALLS, PLAN_SMS, DEFAULT_PRICES, PRICE_ENV, isPaidPlan, normalizePlan, canPickPlan, pickablePlans, MSG_PROMAX_ONLY } from "./_plans.js";
export { PAID_PLANS, PLAN_LABELS, PLAN_SEATS, PLAN_AI_CALLS, PLAN_SMS, DEFAULT_PRICES, isPaidPlan, normalizePlan, canPickPlan, pickablePlans, MSG_PROMAX_ONLY };
export const SERVICE_NAME = "THE BRIDGE ERP";

/** 환경변수 → 가격표. 숫자가 아니거나 0 이하이면 기본값. */
export function pricesFromEnv(env = {}) {
  const pick = (v, d) => { const n = parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return Object.fromEntries(PAID_PLANS.map(k => [k, pick(env[PRICE_ENV[k]], DEFAULT_PRICES[k])]));
}

/** 결제 연동이 켜져 있나 — 서버 비밀키와 브라우저 클라이언트키가 둘 다 있어야 한다. */
export function isBillingEnabled(env = {}) {
  return !!(String(env.TOSS_SECRET_KEY || "").trim() && String(env.VITE_TOSS_CLIENT_KEY || "").trim());
}

/** 토스 customerKey — 회사마다 하나. `co_<owner_id 앞 12자>_<랜덤>` (영문·숫자·_·- 만, 2~50자 — 토스 규칙 안) */
export function makeCustomerKey(ownerId, rand = Math.random().toString(36).slice(2, 10)) {
  const head = String(ownerId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "unknown";
  const tail = String(rand || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "x";
  return `co_${head}_${tail}`;
}

const ms = (v) => { const t = v instanceof Date ? v.getTime() : Date.parse(String(v || "")); return Number.isFinite(t) ? t : NaN; };

/**
 * 다음 기간 끝. currentEnd 가 지금보다 뒤면 그 끝에서 +days, 아니면(없거나 지났으면) 지금부터 +days.
 * 반환 { start: Date, end: Date } — start 가 기준점(이력의 period_start).
 */
export function nextPeriodEnd(currentEnd, now = new Date(), days = PERIOD_DAYS) {
  const nowMs = ms(now);
  const curMs = ms(currentEnd);
  const base = Number.isFinite(curMs) && curMs > nowMs ? curMs : nowMs;
  return { start: new Date(base), end: new Date(base + days * DAY) };
}

/** 회사 계정에서 "남은 기간의 끝" — 체험이면 trial_end, 유료면 current_period_end. 해지면 null(지금부터). */
export function remainingEnd(account) {
  if (!account || account.status === "canceled") return null;
  return account.plan === "trial" ? account.trial_end || null : account.current_period_end || null;
}

/** 결제 성공 뒤 company_accounts 에 넣을 값 + 이력에 쓸 기간. */
export function applyCharge(account, planIn, now = new Date(), days = PERIOD_DAYS) {
  const plan = normalizePlan(planIn);
  if (!isPaidPlan(plan)) throw new Error("요금제가 올바르지 않습니다");
  const { start, end } = nextPeriodEnd(remainingEnd(account), now, days);
  return {
    patch: { plan, status: "active", current_period_end: end.toISOString(), max_managers: PLAN_SEATS[plan] },
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    fromTrial: account?.plan === "trial",
  };
}

/** KST 기준 yyyymmddHHMM */
export function kstStamp(now = new Date()) {
  const d = new Date(ms(now) + 9 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** 토스 orderId — `sub_<owner 앞8>_<yyyymmddHHMM>` (6~64자, 영문·숫자·_·-) */
export function makeOrderId(ownerId, now = new Date()) {
  const head = String(ownerId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "unknown";
  return `sub_${head}_${kstStamp(now)}`;
}

/** 토스 orderName — "THE BRIDGE ERP 스탠다드 1개월" */
export function makeOrderName(plan) {
  return `${SERVICE_NAME} ${PLAN_LABELS[normalizePlan(plan)] || plan} 1개월`;
}

/**
 * 토스 빌링키 발급 응답에서 화면에 보여줄 카드 라벨("신한 ****1234").
 * 응답은 { card: { number, issuerCode, ... }, cardCompany, cardNumber } 꼴 — 버전에 따라 어느 쪽이 있는지 달라서 둘 다 본다.
 */
export function cardLabelFrom(resp) {
  const r = resp || {};
  const company = String(r.cardCompany || r.card?.company || r.card?.issuerName || "").trim();
  const number = String(r.cardNumber || r.card?.number || "").replace(/[^0-9*]/g, "");
  const last4 = number.length >= 4 ? number.slice(-4) : "";
  const parts = [];
  if (company) parts.push(company);
  if (last4 && /^\d{4}$/.test(last4)) parts.push(`****${last4}`);
  return parts.join(" ") || "등록된 카드";
}

/** 토스 오류 응답 → 사람이 읽을 문구 */
export function tossErrorMessage(body, status) {
  const msg = String(body?.message || "").trim();
  const code = String(body?.code || "").trim();
  if (msg) return code ? `${msg} (${code})` : msg;
  return status ? `결제사 응답 오류 (${status})` : "결제사 응답 오류";
}

/**
 * 자동 결제 대상인가 — 크론이 매일 한 번 묻는다.
 *  · billing.plan 이 유료 요금제(api/_plans.js PAID_PLANS)이고 billing_key 가 있어야 한다(해지하면 plan=null → 대상 아님)
 *  · account 가 있고 status 가 canceled 가 아니어야 한다
 *  · current_period_end 가 있고, 지금이 [끝 - 1일, 끝 + 유예 3일) 안이어야 한다
 *    (체험 회사는 current_period_end 가 없어 대상이 아니다 — 첫 결제는 화면에서 직접)
 */
export function shouldAutoCharge(account, billing, now = new Date()) {
  if (!account || !billing) return false;
  if (!isPaidPlan(billing.plan) || !billing.billing_key) return false;
  if (account.status === "canceled") return false;
  const end = ms(account.current_period_end);
  if (!Number.isFinite(end)) return false;
  const t = ms(now);
  return t >= end - AUTO_CHARGE_BEFORE_DAYS * DAY && t < end + GRACE_DAYS * DAY;
}

/** 화면 status 응답에 넣을 값(빌링 행·계정 → 공개해도 되는 것만. billing_key 는 절대 내보내지 않는다) */
// ── 안내 문자(순수) — api/billing-cron.js 가 쓴다. 90바이트(SMS) 안에 맞춘 짧은 글. 머리 "[THE BRIDGE ERP] " 는 17바이트. ──
export const TRIAL_SMS_D3 = "[문자] 체험 종료 3일 전 안내";
export const TRIAL_SMS_END = "[문자] 체험 종료 안내";
export const CHARGE_FAIL_SMS = "[문자] 결제 실패 안내";
const SMS_HEAD = "[THE BRIDGE ERP]";
const mdOf = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}` : ""; };
/**
 * 체험 회사에 지금 보낼 안내가 있나 → TRIAL_SMS_D3 | TRIAL_SMS_END | null
 *   sentMemos: 이미 보낸 안내의 memo 목록(subscription_events kind=note). 같은 안내는 한 번만.
 *   D-3: 끝나기 3일 안(아직 안 끝남). END: 끝난 뒤 2일 안.
 */
export function trialReminderDue(account, now = new Date(), sentMemos = []) {
  if (!account || account.is_demo || account.plan !== "trial" || account.status === "canceled") return null;
  const end = ms(account.trial_end);
  if (!Number.isFinite(end)) return null;
  const left = end - now.getTime();
  const sent = new Set(sentMemos);
  if (left <= 0 && left > -2 * DAY) return sent.has(TRIAL_SMS_END) ? null : TRIAL_SMS_END;
  if (left > 0 && left <= 3 * DAY) return sent.has(TRIAL_SMS_D3) ? null : TRIAL_SMS_D3;
  return null;
}
export const smsTrialD3 = (trialEnd) => `${SMS_HEAD} 무료체험 ${mdOf(trialEnd)} 종료. 회사설정>구독에서 이어쓰기`;
export const smsTrialEnded = () => `${SMS_HEAD} 무료체험 종료, 읽기전용. 회사설정>구독 결제시 바로 복구`;
/** 결제 실패 — 사유는 16바이트 안으로 자른다(한글 8자) */
export function smsChargeFailed(reason = "") {
  let r = String(reason || "").replace(/\s+/g, " ").trim();
  let bytes = 0, cut = "";
  for (const ch of r) { const b = ch.charCodeAt(0) > 127 ? 2 : 1; if (bytes + b > 16) break; bytes += b; cut += ch; }
  return `${SMS_HEAD} 자동결제 실패${cut ? `(${cut})` : ""}. 3일내 회사설정>구독에서 카드확인`;
}

export function publicBillingStatus({ enabled, billing, account, prices }) {
  return {
    enabled: !!enabled,
    customerKey: billing?.customer_key || null,
    hasCard: !!billing?.billing_key,
    cardLabel: billing?.billing_key ? billing.card_label || "등록된 카드" : "",
    plan: isPaidPlan(billing?.plan) ? normalizePlan(billing.plan) : null,     // 자동 결제할 요금제(null = 자동 결제 꺼짐)
    nextChargeAt: account?.current_period_end || null,
    lastPaidAt: billing?.last_paid_at || null,
    lastError: billing?.last_error || "",
    prices: prices || DEFAULT_PRICES,
    labels: PLAN_LABELS,
    seats: PLAN_SEATS,
    aiCalls: PLAN_AI_CALLS,
    sms: PLAN_SMS,
  };
}
