// 구독·로그인·PIN 규칙(src/saas/lib/subscription.js). DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const s = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/subscription.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const now = new Date(2026, 9, 19, 14, 0);
const days = (n) => new Date(now.getTime() + n * 86400000).toISOString();

// ── 아이디 ──
check("아이디 정리: 공백·대문자", s.normalizeLoginId("  Rohi_Market ") === "rohi_market");
check("아이디 거부: 2자·특수문자·숫자시작 아님 허용", s.normalizeLoginId("ab") === "" && s.normalizeLoginId("ro hi") === "" && s.normalizeLoginId("1abc") === "1abc" && s.normalizeLoginId("-abc") === "");
check("아이디 ↔ 이메일", s.loginIdToEmail("rohi") === "rohi@thebridge.erp" && s.emailToLoginId("rohi@thebridge.erp") === "rohi" && s.emailToLoginId("a@b.com") === "");
check("비밀번호 규칙", s.validatePassword("abc12345") === "" && s.validatePassword("short1") !== "" && s.validatePassword("abcdefgh") !== "");
check("PIN 4자리", s.isValidPin("0412") && !s.isValidPin("041") && !s.isValidPin("12a4"));

// ── 구독 상태 ──
const st = (a) => s.subscriptionState(a, now);
check("행 없음 → 사내 계정, 활성", st(null).phase === "none" && st(null).active && !st(null).readOnly);
check("체험 10일 남음 → 활성, 배너 없음", (() => { const r = st({ plan: "trial", status: "active", trial_end: days(10) }); return r.phase === "trial" && r.active && !r.soon && r.daysLeft === 10; })());
check("체험 3일 남음 → 배너", (() => { const r = st({ plan: "trial", status: "active", trial_end: days(3) }); return r.soon && s.subscriptionNotice(r).includes("3일"); })());
check("체험 끝 → 읽기 전용", (() => { const r = st({ plan: "trial", status: "active", trial_end: days(-1) }); return r.phase === "expired" && r.readOnly && !r.active; })());
check("유료 기간 안 → 활성", (() => { const r = st({ plan: "standard", status: "active", trial_end: days(-100), current_period_end: days(20) }); return r.phase === "paid" && r.active && !r.soon && r.planLabel === "스탠다드"; })());
check("옛 basic 은 스탠다드로 읽는다", st({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }).planLabel === "스탠다드");
// ── 요금제 월 할당량(2026-10-23) ──
const paid = (plan) => ({ plan, status: "active", trial_end: days(-100), current_period_end: days(20) });
check("aiAccess: 스타터 10회 다 쓰면 거부, 9회면 허용", !s.aiAccess(paid("starter"), st(paid("starter")), 10).allowed && s.aiAccess(paid("starter"), st(paid("starter")), 9).allowed);
check("aiAccess: 스탠다드 cap 300", s.aiAccess(paid("standard"), st(paid("standard")), 0).cap === 300);
check("smsAccess: 스타터 없음 · 스탠다드 200건 · 프로 MAX 2,000건", !s.smsAccess(paid("starter"), st(paid("starter")), 0).allowed && s.smsAccess(paid("standard"), st(paid("standard")), 199).allowed && !s.smsAccess(paid("standard"), st(paid("standard")), 200).allowed && s.smsAccess(paid("promax"), st(paid("promax")), 1999).allowed && !s.smsAccess(paid("promax"), st(paid("promax")), 2000).allowed);
check("smsAccess: 프로 1,000건", s.smsAccess(paid("pro"), st(paid("pro")), 999).allowed && !s.smsAccess(paid("pro"), st(paid("pro")), 1000).allowed);
check("요금제 카드: 체험·스타터·스탠다드는 프로 MAX 안 보임, 프로·프로 MAX·옛 basic→스탠다드", s.pickablePlanKeys({ plan: "trial" }).join() === "starter,standard,pro" && s.pickablePlanKeys(paid("standard")).join() === "starter,standard,pro" && s.pickablePlanKeys(paid("pro")).join() === "starter,standard,pro,promax" && s.pickablePlanKeys(paid("promax")).includes("promax") && !s.pickablePlanKeys(paid("basic")).includes("promax") && !s.pickablePlanKeys(null).includes("promax"));
check("planDiff: 스탠다드→프로 3줄, 같은 요금제 빈 배열, 스타터→스탠다드 문자 '없음 → 월 200건'", s.planDiff(s.PLANS.standard, s.PLANS.pro).length === 3 && s.planDiff(s.PLANS.pro, s.PLANS.pro).length === 0 && s.planDiff(s.PLANS.starter, s.PLANS.standard).some(x => x === "출고 안내 문자 없음 → 월 200건") && s.planDiff(s.PLANS.standard, s.PLANS.pro).some(x => x === "담당자 5명 → 무제한"));
check("모든 유료 요금제에 fit·notes 가 있고 공통 기능 목록이 있다", s.PAID_PLAN_KEYS.every(k => s.PLANS[k].fit && Array.isArray(s.PLANS[k].notes)) && s.PLAN_COMMON.length >= 5);
check("PLANS 가격: 9,900 / 39,000 / 89,000 / 149,000", s.PLANS.starter.price === 9900 && s.PLANS.standard.price === 39000 && s.PLANS.pro.price === 89000 && s.PLANS.promax.price === 149000);
check("유료 끝난 뒤 2일(유예 3일) → 아직 활성, 경고", (() => { const r = st({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: days(-2) }); return r.phase === "grace" && r.active && r.soon && r.daysLeft === 1; })());
check("유료 끝난 뒤 4일 → 읽기 전용", (() => { const r = st({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: days(-4) }); return r.phase === "expired" && r.readOnly; })());
check("기간 없음(수동 운영) → 활성", st({ plan: "standard", status: "active", trial_end: days(-100), current_period_end: null }).active === true);
check("해지 → 읽기 전용(기간 남아도)", (() => { const r = st({ plan: "pro", status: "canceled", trial_end: days(-100), current_period_end: days(20) }); return r.phase === "canceled" && r.readOnly; })());

// ── PIN 게이트 ──
const t0 = now.getTime();
check("PIN 없는 담당자는 안 묻는다", s.pinNeeded({ hasPin: false, verifiedAt: 0, now: t0 }) === false);
check("처음(확인 기록 없음) → 묻는다", s.pinNeeded({ hasPin: true, verifiedAt: 0, now: t0 }) === true);
check("10분 전 확인 → 안 묻는다", s.pinNeeded({ hasPin: true, verifiedAt: t0 - 10 * 60000, now: t0 }) === false);
check("40분 전 확인 → 묻는다", s.pinNeeded({ hasPin: true, verifiedAt: t0 - 40 * 60000, now: t0 }) === true);
check("기기 고정이면 한 번 확인 뒤 안 묻는다", s.pinNeeded({ hasPin: true, verifiedAt: t0 - 5 * 86400000, pinned: true, now: t0 }) === false);
check("기기 고정이라도 확인 기록이 없으면 묻는다", s.pinNeeded({ hasPin: true, verifiedAt: 0, pinned: true, now: t0 }) === true);

// ── 담당자 수 ──
const mgrs = [{ name: "a" }, { name: "b", isPublic: true }, { name: "c" }];
check("담당자 자리: 공용 제외 2명 사용, 최대 3 → 1 남음", s.managerSeatsLeft({ plan: "standard", max_managers: 3 }, mgrs) === 1);
check("담당자 자리: max_managers 없으면 요금제 기본(스타터 2) → 0 남음", s.managerSeatsLeft({ plan: "starter" }, mgrs) === 0);
check("행 없으면 무제한", s.managerSeatsLeft(null, mgrs) === Infinity);

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
