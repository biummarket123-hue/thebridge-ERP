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
check("가격 기본값 9,900 / 39,000 / 89,000 / 149,000", (() => { const p = b.pricesFromEnv({}); return p.starter === 9900 && p.standard === 39000 && p.pro === 89000 && p.promax === 149000; })());
check("가격 환경변수가 덮는다·이상한 값은 기본값", (() => { const p = b.pricesFromEnv({ SAAS_PRICE_STANDARD: "45000", SAAS_PRICE_PRO: "abc", SAAS_PRICE_PROMAX: "199000" }); return p.standard === 45000 && p.pro === 89000 && p.promax === 199000 && p.starter === 9900; })());
check("키 둘 다 있어야 켜진다", b.isBillingEnabled({ TOSS_SECRET_KEY: "test_sk_x", VITE_TOSS_CLIENT_KEY: "test_ck_x" }) === true
  && b.isBillingEnabled({ TOSS_SECRET_KEY: "test_sk_x" }) === false && b.isBillingEnabled({}) === false && b.isBillingEnabled({ TOSS_SECRET_KEY: " ", VITE_TOSS_CLIENT_KEY: "x" }) === false);

// ── 기간 계산 ──
check("남은 기간 없음(null) → 지금부터 30일", (() => { const r = b.nextPeriodEnd(null, now); return sameTime(r.start, now) && sameTime(r.end, days(30)); })());
check("남은 기간 있음 → 그 끝에서 30일", (() => { const r = b.nextPeriodEnd(days(10), now); return sameTime(r.start, days(10)) && sameTime(r.end, days(40)); })());
check("기간이 지났으면 지금부터 30일", (() => { const r = b.nextPeriodEnd(days(-2), now); return sameTime(r.start, now) && sameTime(r.end, days(30)); })());
check("일수 바꿔서", sameTime(b.nextPeriodEnd(null, now, 7).end, days(7)));
check("체험 회사의 남은 끝은 trial_end, 유료는 current_period_end, 해지는 없음",
  b.remainingEnd({ plan: "trial", status: "active", trial_end: "T", current_period_end: null }) === "T"
  && b.remainingEnd({ plan: "standard", status: "active", trial_end: "T", current_period_end: "P" }) === "P"
  && b.remainingEnd({ plan: "pro", status: "canceled", current_period_end: "P" }) === null);

// ── 결제 적용 ──
check("체험 5일 남은 회사가 베이직 결제 → 체험 끝 + 30일, 유료 전환, 담당자 3", (() => {
  const r = b.applyCharge({ plan: "trial", status: "active", trial_end: days(5) }, "standard", now);
  return r.patch.plan === "standard" && r.patch.status === "active" && r.patch.max_managers === 5 && sameTime(r.patch.current_period_end, days(35)) && r.fromTrial && sameTime(r.periodStart, days(5));
})());
check("유료 20일 남은 회사가 프로 결제 → 끝 + 30일, 담당자 99", (() => {
  const r = b.applyCharge({ plan: "standard", status: "active", trial_end: days(-100), current_period_end: days(20) }, "pro", now);
  return r.patch.plan === "pro" && r.patch.max_managers === 99 && sameTime(r.patch.current_period_end, days(50)) && !r.fromTrial;
})());
check("만료된 회사가 결제 → 지금부터 30일, 다시 활성", (() => {
  const r = b.applyCharge({ plan: "standard", status: "active", trial_end: days(-100), current_period_end: days(-10) }, "standard", now);
  return sameTime(r.patch.current_period_end, days(30)) && r.patch.status === "active";
})());
check("해지된 회사가 결제 → 지금부터 30일, status active", (() => {
  const r = b.applyCharge({ plan: "pro", status: "canceled", current_period_end: days(15) }, "pro", now);
  return sameTime(r.patch.current_period_end, days(30)) && r.patch.status === "active";
})());
check("요금제가 이상하면 예외", (() => { try { b.applyCharge({}, "trial", now); return false; } catch { return true; } })());

// ── orderId · orderName · customerKey ──
check("orderId = sub_<owner 앞8>_<KST yyyymmddHHMM>", b.makeOrderId("3f2a9c1e-7b4d-4e0a-9f1b-000000000000", now) === "sub_3f2a9c1e_202610201400");
check("orderName", b.makeOrderName("standard") === "THE BRIDGE ERP 스탠다드 1개월" && b.makeOrderName("pro") === "THE BRIDGE ERP 프로 1개월" && b.makeOrderName("basic") === "THE BRIDGE ERP 스탠다드 1개월");
check("옛 basic → standard: applyCharge 가 이름을 옮기고 자리 5", (() => { const r = b.applyCharge({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }, "basic", now); return r.patch.plan === "standard" && r.patch.max_managers === 5; })());
check("canPickPlan: 프로 MAX 는 프로·프로 MAX 회사만, 다른 요금제는 누구나", b.canPickPlan("promax", "pro") && b.canPickPlan("promax", "promax") && !b.canPickPlan("promax", "standard") && !b.canPickPlan("promax", "trial") && !b.canPickPlan("promax", undefined) && b.canPickPlan("pro", "trial") && b.pickablePlans("standard").join() === "starter,standard,pro" && b.pickablePlans("pro").join() === "starter,standard,pro,promax");
check("스타터 자리 2 · 프로 MAX 자리 99", b.applyCharge({ plan: "trial", status: "active", trial_end: days(1) }, "starter", now).patch.max_managers === 2 && b.applyCharge({ plan: "trial", status: "active", trial_end: days(1) }, "promax", now).patch.max_managers === 99);
check("customerKey 꼴", (() => { const k = b.makeCustomerKey("3f2a9c1e-7b4d-4e0a-9f1b-000000000000", "abc123"); return k === "co_3f2a9c1e7b4d_abc123" && /^[a-zA-Z0-9_-]{2,50}$/.test(k); })());

// ── 카드 라벨 ──
check("카드 라벨: cardCompany + 끝 4자리", b.cardLabelFrom({ cardCompany: "신한", cardNumber: "433012******1234" }) === "신한 ****1234");
check("카드 라벨: card 객체 꼴", b.cardLabelFrom({ card: { company: "국민", number: "9410********5678" } }) === "국민 ****5678");
check("카드 라벨: 정보 없으면 '등록된 카드'", b.cardLabelFrom({}) === "등록된 카드" && b.cardLabelFrom(null) === "등록된 카드");
check("토스 오류 문구", b.tossErrorMessage({ code: "INVALID_CARD", message: "카드 정보가 올바르지 않습니다" }, 400) === "카드 정보가 올바르지 않습니다 (INVALID_CARD)" && b.tossErrorMessage({}, 502) === "결제사 응답 오류 (502)");

// ── 자동 결제 대상 ──
const acc = (end, extra = {}) => ({ plan: "standard", status: "active", trial_end: days(-100), current_period_end: end, ...extra });
const bil = (extra = {}) => ({ plan: "standard", billing_key: "bk_1", ...extra });
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
  const s = b.publicBillingStatus({ enabled: true, billing: { customer_key: "co_x", billing_key: "bk_secret", card_label: "신한 ****1234", plan: "pro", last_error: "" }, account: { current_period_end: "2026-11-20T00:00:00Z" }, prices: { standard: 1, pro: 2 } });
  return JSON.stringify(s).includes("bk_secret") === false && s.hasCard && s.cardLabel === "신한 ****1234" && s.plan === "pro" && s.nextChargeAt === "2026-11-20T00:00:00Z" && s.prices.pro === 2 && s.enabled;
})());
check("status: 카드 없으면 hasCard false·라벨 빈칸·plan null", (() => {
  const s = b.publicBillingStatus({ enabled: true, billing: { customer_key: "co_x", billing_key: null, card_label: "", plan: null }, account: null });
  return !s.hasCard && s.cardLabel === "" && s.plan === null && s.nextChargeAt === null && s.prices.standard === 39000 && s.aiCalls.standard === 300 && s.sms.starter === 0;
})());

// ── 안내 문자(2026-10-23) ──
const bytes = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
const trial = (endOffsetDays, extra = {}) => ({ plan: "trial", status: "active", is_demo: false, trial_end: new Date(now.getTime() + endOffsetDays * DAY).toISOString(), ...extra });
check("체험 안내: 끝나기 2일 전 → D-3 안내, 이미 보냈으면 null", b.trialReminderDue(trial(2), now) === b.TRIAL_SMS_D3 && b.trialReminderDue(trial(2), now, [b.TRIAL_SMS_D3]) === null);
check("체험 안내: 5일 전은 아직 아님 · 끝난 지 1일 → 종료 안내 · 3일 지나면 안 보냄", b.trialReminderDue(trial(5), now) === null && b.trialReminderDue(trial(-1), now) === b.TRIAL_SMS_END && b.trialReminderDue(trial(-3), now) === null);
check("체험 안내: 데모·유료·해지 회사는 null", b.trialReminderDue(trial(1, { is_demo: true }), now) === null && b.trialReminderDue({ plan: "standard", status: "active", current_period_end: days(1) }, now) === null && b.trialReminderDue(trial(1, { status: "canceled" }), now) === null);
check("안내 문자 셋 다 90바이트 안", bytes(b.smsTrialD3(days(2))) <= 90 && bytes(b.smsTrialEnded()) <= 90 && bytes(b.smsChargeFailed("카드 한도 초과로 승인이 거절되었습니다 아주 긴 사유")) <= 90, `${bytes(b.smsTrialD3(days(2)))}/${bytes(b.smsTrialEnded())}/${bytes(b.smsChargeFailed("카드 한도 초과로 승인이 거절되었습니다 아주 긴 사유"))}`);
check("결제 실패 문자에 날짜·사유가 들어간다", b.smsTrialD3("2026-10-25T00:00:00Z").includes("10/25") && b.smsChargeFailed("한도 초과").includes("(한도 초과)"));

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
