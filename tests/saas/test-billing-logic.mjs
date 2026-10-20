// 결제(빌링) 순수 계산(api/_billing_logic.js). DB 도 토스도 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const b = await import(pathToFileURL(path.join(ROOT, "api/_billing_logic.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const now = new Date("2026-10-20T05:00:00.000Z");   // KST 2026-10-20 14:00
const DAY = 86400000;
const days = (n) => new Date(now.getTime() + n * DAY).toISOString();
const sameTime = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1000;

// ── 가격표·연동 여부 ──
check("가격 기본값 99,000 / 199,000", b.pricesFromEnv({}).basic === 99000 && b.pricesFromEnv({}).pro === 199000);
check("가격 환경변수가 덮는다·이상한 값은 기본값", (() => { const p = b.pricesFromEnv({ SAAS_PRICE_BASIC: "120000", SAAS_PRICE_PRO: "abc" }); return p.basic === 120000 && p.pro === 199000; })());
check("키 둘 다 있어야 켜진다", b.isBillingEnabled({ TOSS_SECRET_KEY: "test_sk_x", VITE_TOSS_CLIENT_KEY: "test_ck_x" }) === true
  && b.isBillingEnabled({ TOSS_SECRET_KEY: "test_sk_x" }) === false && b.isBillingEnabled({}) === false && b.isBillingEnabled({ TOSS_SECRET_KEY: " ", VITE_TOSS_CLIENT_KEY: "x" }) === false);

// ── 기간 계산 ──
check("남은 기간 없음(null) → 지금부터 30일", (() => { const r = b.nextPeriodEnd(null, now); return sameTime(r.start, now) && sameTime(r.end, days(30)); })());
check("남은 기간 있음 → 그 끝에서 30일", (() => { const r = b.nextPeriodEnd(days(10), now); return sameTime(r.start, days(10)) && sameTime(r.end, days(40)); })());
check("기간이 지났으면 지금부터 30일", (() => { const r = b.nextPeriodEnd(days(-2), now); return sameTime(r.start, now) && sameTime(r.end, days(30)); })());
check("일수 바꿔서", sameTime(b.nextPeriodEnd(null, now, 7).end, days(7)));
check("체험 회사의 남은 끝은 trial_end, 유료는 current_period_end, 해지는 없음",
  b.remainingEnd({ plan: "trial", status: "active", trial_end: "T", current_period_end: null }) === "T"
  && b.remainingEnd({ plan: "basic", status: "active", trial_end: "T", current_period_end: "P" }) === "P"
  && b.remainingEnd({ plan: "pro", status: "canceled", current_period_end: "P" }) === null);

// ── 결제 적용 ──
check("체험 5일 남은 회사가 베이직 결제 → 체험 끝 + 30일, 유료 전환, 담당자 3", (() => {
  const r = b.applyCharge({ plan: "trial", status: "active", trial_end: days(5) }, "basic", now);
  return r.patch.plan === "basic" && r.patch.status === "active" && r.patch.max_managers === 3 && sameTime(r.patch.current_period_end, days(35)) && r.fromTrial && sameTime(r.periodStart, days(5));
})());
check("유료 20일 남은 회사가 프로 결제 → 끝 + 30일, 담당자 99", (() => {
  const r = b.applyCharge({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }, "pro", now);
  return r.patch.plan === "pro" && r.patch.max_managers === 99 && sameTime(r.patch.current_period_end, days(50)) && !r.fromTrial;
})());
check("만료된 회사가 결제 → 지금부터 30일, 다시 활성", (() => {
  const r = b.applyCharge({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(-10) }, "basic", now);
  return sameTime(r.patch.current_period_end, days(30)) && r.patch.status === "active";
})());
check("해지된 회사가 결제 → 지금부터 30일, status active", (() => {
  const r = b.applyCharge({ plan: "pro", status: "canceled", current_period_end: days(15) }, "pro", now);
  return sameTime(r.patch.current_period_end, days(30)) && r.patch.status === "active";
})());
check("요금제가 이상하면 예외", (() => { try { b.applyCharge({}, "trial", now); return false; } catch { return true; } })());

// ── orderId · orderName · customerKey ──
check("orderId = sub_<owner 앞8>_<KST yyyymmddHHMM>", b.makeOrderId("3f2a9c1e-7b4d-4e0a-9f1b-000000000000", now) === "sub_3f2a9c1e_202610201400");
check("orderName", b.makeOrderName("basic") === "루프 ERP 베이직 1개월" && b.makeOrderName("pro") === "루프 ERP 프로 1개월");
check("customerKey 꼴", (() => { const k = b.makeCustomerKey("3f2a9c1e-7b4d-4e0a-9f1b-000000000000", "abc123"); return k === "co_3f2a9c1e7b4d_abc123" && /^[a-zA-Z0-9_-]{2,50}$/.test(k); })());

// ── 카드 라벨 ──
check("카드 라벨: cardCompany + 끝 4자리", b.cardLabelFrom({ cardCompany: "신한", cardNumber: "433012******1234" }) === "신한 ****1234");
check("카드 라벨: card 객체 꼴", b.cardLabelFrom({ card: { company: "국민", number: "9410********5678" } }) === "국민 ****5678");
check("카드 라벨: 정보 없으면 '등록된 카드'", b.cardLabelFrom({}) === "등록된 카드" && b.cardLabelFrom(null) === "등록된 카드");
check("토스 오류 문구", b.tossErrorMessage({ code: "INVALID_CARD", message: "카드 정보가 올바르지 않습니다" }, 400) === "카드 정보가 올바르지 않습니다 (INVALID_CARD)" && b.tossErrorMessage({}, 502) === "결제사 응답 오류 (502)");

// ── 자동 결제 대상 ──
const acc = (end, extra = {}) => ({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: end, ...extra });
const bil = (extra = {}) => ({ plan: "basic", billing_key: "bk_1", ...extra });
check("끝까지 12시간 → 대상", b.shouldAutoCharge(acc(days(0.5)), bil(), now) === true);
check("끝까지 2일 → 아직 아님", b.shouldAutoCharge(acc(days(2)), bil(), now) === false);
check("끝난 지 2일(유예 안) → 대상", b.shouldAutoCharge(acc(days(-2)), bil(), now) === true);
check("끝난 지 4일(유예 지남) → 아님", b.shouldAutoCharge(acc(days(-4)), bil(), now) === false);
check("자동 결제 해지(plan null) → 아님", b.shouldAutoCharge(acc(days(0.5)), bil({ plan: null }), now) === false);
check("카드 없음 → 아님", b.shouldAutoCharge(acc(days(0.5)), bil({ billing_key: null }), now) === false);
check("회사 해지 → 아님", b.shouldAutoCharge(acc(days(0.5), { status: "canceled" }), bil(), now) === false);
check("기간 없음(수동 운영·체험) → 아님", b.shouldAutoCharge(acc(null), bil(), now) === false && b.shouldAutoCharge({ plan: "trial", status: "active", trial_end: days(0.5) }, bil(), now) === false);
check("행 없음 → 아님", b.shouldAutoCharge(null, bil(), now) === false && b.shouldAutoCharge(acc(days(0.5)), null, now) === false);

// ── 화면 status ──
check("status 응답에 billing_key 가 새지 않는다", (() => {
  const s = b.publicBillingStatus({ enabled: true, billing: { customer_key: "co_x", billing_key: "bk_secret", card_label: "신한 ****1234", plan: "pro", last_error: "" }, account: { current_period_end: "2026-11-20T00:00:00Z" }, prices: { basic: 1, pro: 2 } });
  return JSON.stringify(s).includes("bk_secret") === false && s.hasCard && s.cardLabel === "신한 ****1234" && s.plan === "pro" && s.nextChargeAt === "2026-11-20T00:00:00Z" && s.prices.pro === 2 && s.enabled;
})());
check("status: 카드 없으면 hasCard false·라벨 빈칸·plan null", (() => {
  const s = b.publicBillingStatus({ enabled: true, billing: { customer_key: "co_x", billing_key: null, card_label: "", plan: null }, account: null });
  return !s.hasCard && s.cardLabel === "" && s.plan === null && s.nextChargeAt === null && s.prices.basic === 99000;
})());

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
