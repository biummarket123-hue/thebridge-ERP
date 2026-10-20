// AI 게이트 규칙(api/_ai_gate.js) — DB 없이 돈다. 화면 쪽 subscription.js 의 aiAccess 와 같은 결론이 나야 한다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const g = await import(pathToFileURL(path.join(ROOT, "api/_ai_gate.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const now = new Date(2026, 9, 20, 11, 0);
const days = (n) => new Date(now.getTime() + n * 86400000).toISOString();
const gate = (account, extra = {}) => g.aiGate({ account, now, ...extra });

// ── 사내 계정 ──
check("행 없음(사내 계정) → 허용, 세지 않음", (() => { const r = gate(null); return r.allow && !r.countUsage && r.reason === ""; })());

// ── 체험(trial) ──
check("체험 활성, 한도 0(기본) → 거부 '구독 회사 전용'", (() => { const r = gate({ plan: "trial", status: "active", trial_end: days(10) }); return !r.allow && !r.countUsage && r.reason.includes("구독 회사 전용"); })());
check("체험 활성, 한도 5, 사용 2 → 허용, 세기", (() => { const r = gate({ plan: "trial", status: "active", trial_end: days(10) }, { usage: 2, trialCalls: 5 }); return r.allow && r.countUsage; })());
check("체험 활성, 한도 5, 사용 5 → 거부", (() => { const r = gate({ plan: "trial", status: "active", trial_end: days(10) }, { usage: 5, trialCalls: 5 }); return !r.allow && r.reason.includes("구독 회사 전용"); })());
check("체험 끝남, 한도 5, 사용 0 → 거부", (() => { const r = gate({ plan: "trial", status: "active", trial_end: days(-1) }, { usage: 0, trialCalls: 5 }); return !r.allow; })());
check("데모(is_demo), 한도 0 → 거부", (() => { const r = gate({ plan: "trial", status: "active", trial_end: days(0.04), is_demo: true }); return !r.allow && r.reason.includes("구독 회사 전용"); })());
check("데모(is_demo), 한도 3, 사용 1 → 허용, 세기", (() => { const r = gate({ plan: "basic", status: "active", trial_end: days(0.04), is_demo: true }, { usage: 1, trialCalls: 3 }); return r.allow && r.countUsage; })());

// ── 유료 ──
check("유료 기간 안 → 허용, 세기", (() => { const r = gate({ plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }); return r.allow && r.countUsage; })());
check("유료 기간 없음(수동 운영) → 허용", gate({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: null }).allow === true);
check("유료 끝난 뒤 2일(유예 3일) → 허용", gate({ plan: "pro", status: "active", trial_end: days(-100), current_period_end: days(-2) }).allow === true);
check("유료 끝난 뒤 4일 → 거부 '구독이 끝나'", (() => { const r = gate({ plan: "pro", status: "past_due", trial_end: days(-100), current_period_end: days(-4) }); return !r.allow && r.reason.includes("구독이 끝나"); })());
check("해지(canceled) → 거부(기간 남아도)", (() => { const r = gate({ plan: "pro", status: "canceled", trial_end: days(-100), current_period_end: days(20) }); return !r.allow && r.reason.includes("구독이 끝나"); })());
check("해지된 체험 → 거부 '구독이 끝나'(체험 한도와 무관)", (() => { const r = gate({ plan: "trial", status: "canceled", trial_end: days(10) }, { usage: 0, trialCalls: 5 }); return !r.allow && r.reason.includes("구독이 끝나"); })());

// ── 문자 게이트: 유료만, 체험 한도 무관 ──
check("문자: 유료 활성 → 허용", g.smsGate({ account: { plan: "basic", status: "active", trial_end: days(-100), current_period_end: days(20) }, now }).allow === true);
check("문자: 체험 → 거부(문자 문구)", (() => { const r = g.smsGate({ account: { plan: "trial", status: "active", trial_end: days(10) }, now }); return !r.allow && r.reason.includes("문자"); })());
check("문자: 데모 → 거부", g.smsGate({ account: { plan: "basic", status: "active", trial_end: days(0.04), is_demo: true }, now }).allow === false);
check("문자: 사내 계정 → 허용", g.smsGate({ account: null, now }).allow === true);

// ── 보조 ──
check("monthKey → 'YYYY-MM'", g.monthKey(now) === "2026-10" && g.monthKey(new Date(2026, 0, 5)) === "2026-01");
check("SAAS_TRIAL_AI_CALLS 읽기: 없음 0 · '5' 5 · 'abc' 0 · '-3' 0", g.readTrialCalls({}) === 0 && g.readTrialCalls({ SAAS_TRIAL_AI_CALLS: "5" }) === 5 && g.readTrialCalls({ SAAS_TRIAL_AI_CALLS: "abc" }) === 0 && g.readTrialCalls({ SAAS_TRIAL_AI_CALLS: "-3" }) === 0);
check("isPaidActive: trial 거짓 · basic 기간 안 참 · canceled 거짓", !g.isPaidActive({ plan: "trial", status: "active", trial_end: days(5) }, now) && g.isPaidActive({ plan: "basic", status: "active", current_period_end: days(5) }, now) && !g.isPaidActive({ plan: "basic", status: "canceled", current_period_end: days(5) }, now));

// ── loadGateInput: 가짜 클라이언트로 읽기 모양만 확인 ──
const fakeSb = (rows) => ({
  from(table) {
    const q = { _t: table, _f: {} };
    q.select = () => q; q.eq = (k, v) => { q._f[k] = v; return q; };
    q.maybeSingle = async () => rows[table] ? rows[table](q._f) : { data: null, error: { message: `relation "${table}" does not exist` } };
    return q;
  },
});
{
  const sb = fakeSb({
    company_accounts: (f) => ({ data: f.owner_id === "u1" ? { owner_id: "u1", plan: "trial", status: "active", trial_end: days(3) } : null, error: null }),
    saas_ai_usage: (f) => ({ data: f.month === "2026-10" ? { count: 4 } : null, error: null }),
  });
  const r = await g.loadGateInput(sb, "u1", now);
  check("loadGateInput: 계정·이번 달 사용량을 읽는다", r.account?.plan === "trial" && r.usage === 4);
  const r2 = await g.loadGateInput(fakeSb({}), "u1", now);
  check("loadGateInput: 표가 없으면 사내 계정·0 으로 기운다", r2.account === null && r2.usage === 0);
}

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
