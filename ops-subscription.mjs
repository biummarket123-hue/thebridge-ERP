// 운영자용 구독 관리 — SQL Editor 없이 터미널에서. service role 키(.env.local)로 company_accounts 를 고친다.
//   node ops-subscription.mjs list                          회사 목록·구독 상태
//   node ops-subscription.mjs extend <아이디> <일수> [요금제] [메모]   기간 연장(+요금제 변경). 체험 중이면 유료로 전환
//   node ops-subscription.mjs plan <아이디> <trial|starter|standard|pro|promax> [담당자수]  요금제·담당자 자리만 변경
//   node ops-subscription.mjs cancel <아이디> [메모]        해지(즉시 읽기 전용)
//   node ops-subscription.mjs resume <아이디>               해지 취소(status=active)
// 모든 변경은 subscription_events 에 남는다. 브라우저에서는 못 바꾸는 칸(트리거)이라 이 스크립트가 유일한 길이다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)
  .filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const URL = env.VITE_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error(".env.local 에 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다"); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
// api/_plans.js 와 같은 값(2026-10-23 4단계). 옛 basic 은 standard 로 읽는다.
const PLANS = { trial: { label: "무료 체험", seats: 3 }, starter: { label: "스타터", seats: 2 }, standard: { label: "스탠다드", seats: 5 }, pro: { label: "프로", seats: 99 }, promax: { label: "프로 MAX", seats: 99 } };
const [cmd, loginId, a3, a4, a5] = process.argv.slice(2);
const DAY = 86400000;
const fmt = (iso) => iso ? new Date(iso).toLocaleDateString("ko-KR") : "-";
const stateOf = (a, now = Date.now()) => {
  if (a.status === "canceled") return "해지";
  if (a.plan === "trial") return new Date(a.trial_end).getTime() > now ? `체험 (${Math.ceil((new Date(a.trial_end) - now) / DAY)}일 남음)` : "체험 끝(읽기 전용)";
  if (!a.current_period_end) return "유료(기간 없음)";
  const end = new Date(a.current_period_end).getTime();
  if (now < end) return `유료 (${Math.ceil((end - now) / DAY)}일 남음)`;
  if (now < end + 3 * DAY) return "유예 중";
  return "만료(읽기 전용)";
};

async function account(id) {
  const { data, error } = await sb.from("company_accounts").select("*").eq("login_id", String(id || "").toLowerCase()).maybeSingle();
  if (error) throw error;
  if (!data) { console.error(`아이디 '${id}' 회사가 없습니다`); process.exit(1); }
  return data;
}
async function event(ownerId, kind, extra = {}) {
  const { error } = await sb.from("subscription_events").insert({ owner_id: ownerId, kind, ...extra });
  if (error) console.warn("이력 기록 실패:", error.message);
}
async function update(ownerId, patch) {
  const { error } = await sb.from("company_accounts").update(patch).eq("owner_id", ownerId);
  if (error) throw error;
}

if (cmd === "list") {
  const { data, error } = await sb.from("company_accounts").select("*").order("created_at");
  if (error) throw error;
  const rows = (data || []).map(a => ({ 아이디: a.login_id, 회사: a.name, 요금제: PLANS[a.plan]?.label || a.plan, 상태: stateOf(a), 체험종료: fmt(a.trial_end), 기간종료: fmt(a.current_period_end), 담당자: a.max_managers, 가입: fmt(a.created_at) }));
  console.table(rows);
} else if (cmd === "extend") {
  const days = parseInt(a3, 10);
  if (!loginId || !Number.isFinite(days) || days <= 0) { console.error("사용법: extend <아이디> <일수> [요금제] [메모]"); process.exit(1); }
  const a = await account(loginId);
  const plan = a4 && PLANS[a4] ? a4 : (a.plan === "trial" || a.plan === "basic" ? "standard" : a.plan);
  const base = a.current_period_end && new Date(a.current_period_end) > new Date() ? new Date(a.current_period_end) : new Date();
  const end = new Date(base.getTime() + days * DAY).toISOString();
  await update(a.owner_id, { plan, status: "active", current_period_end: end, max_managers: PLANS[plan].seats });
  await event(a.owner_id, "extend", { plan, period_start: base.toISOString(), period_end: end, memo: a5 || `${days}일 연장` });
  console.log(`${a.name}(${a.login_id}): ${PLANS[plan].label}, ${fmt(end)} 까지`);
} else if (cmd === "plan") {
  if (!loginId || !PLANS[a3]) { console.error("사용법: plan <아이디> <trial|starter|standard|pro|promax> [담당자수]"); process.exit(1); }
  const a = await account(loginId);
  const seats = a4 ? parseInt(a4, 10) : PLANS[a3].seats;
  await update(a.owner_id, { plan: a3, max_managers: seats });
  await event(a.owner_id, "plan_change", { plan: a3, memo: `${PLANS[a.plan]?.label || a.plan} → ${PLANS[a3].label}, 담당자 ${seats}` });
  console.log(`${a.name}: ${PLANS[a3].label}, 담당자 ${seats}명`);
} else if (cmd === "cancel") {
  if (!loginId) { console.error("사용법: cancel <아이디> [메모]"); process.exit(1); }
  const a = await account(loginId);
  await update(a.owner_id, { status: "canceled" });
  await event(a.owner_id, "cancel", { memo: a3 || "운영자 해지" });
  console.log(`${a.name}: 해지(읽기 전용)`);
} else if (cmd === "resume") {
  if (!loginId) { console.error("사용법: resume <아이디>"); process.exit(1); }
  const a = await account(loginId);
  await update(a.owner_id, { status: "active" });
  await event(a.owner_id, "note", { memo: "해지 취소" });
  console.log(`${a.name}: 다시 활성 — ${stateOf({ ...a, status: "active" })}`);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 7).map(l => l.slice(3)).join("\n"));
}
