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
check("유료 기간 안 → 활성", (() => { const r = st({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }); return r.phase === "paid" && r.active && !r.soon; })());
check("유료 끝난 뒤 2일(유예 3일) → 아직 활성, 경고", (() => { const r = st({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: days(-2) }); return r.phase === "grace" && r.active && r.soon && r.daysLeft === 1; })());
check("유료 끝난 뒤 4일 → 읽기 전용", (() => { const r = st({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: days(-4) }); return r.phase === "expired" && r.readOnly; })());
check("기간 없음(수동 운영) → 활성", st({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: null }).active === true);
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
check("담당자 자리: 공용 제외 2명 사용, 최대 3 → 1 남음", s.managerSeatsLeft({ plan: "basic", max_managers: 3 }, mgrs) === 1);
check("행 없으면 무제한", s.managerSeatsLeft(null, mgrs) === Infinity);

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
