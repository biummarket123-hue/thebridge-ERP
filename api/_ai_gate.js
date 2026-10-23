// AI(토큰 비용)·문자(원가) 기능 게이트 — 서버 판정의 순수 규칙. DB·SDK 를 import 하지 않는다(tests/saas/test-ai-gate.mjs 가 그대로 돈다).
//
// 화면 쪽 src/saas/lib/subscription.js 의 aiAccess()/smsAccess() 와 같은 규칙을 서버에서 따로 구현한 것 — 화면 코드는 import 하지 않는다.
// 화면은 안내(버튼 숨김)이고 여기가 강제다.
//   · 사용자 결정(2026-10-20): API 토큰이 드는 기능(AI 주문·이미지 분석, 문자 발송)은 유료 구독 회사만. 14일 체험·1시간 데모는 "직접 입력"만.
//     환경변수 SAAS_TRIAL_AI_CALLS(월 기준, 기본 0)가 있으면 체험에 그만큼만.
//   · 사용자 결정(2026-10-23): 유료 회사도 요금제별 월 할당량(api/_plans.js PLAN_AI_CALLS·PLAN_SMS)까지만. 넘기면 그 달은 막고 상위 요금제 안내.
//
// 파일 이름이 _ 로 시작해 Vercel 이 서버 함수로 배포하지 않는다(api/analyze.js·api/notify.js 가 import).
import { PLAN_AI_CALLS, PLAN_SMS, PLAN_LABELS, normalizePlan } from "./_plans.js";

export const GRACE_DAYS = 3;   // 유료 기간이 끝난 뒤 유예 — migrations/saas_company_accounts.sql 의 is_company_active() 와 같다
const DAY = 86400000;

export const MSG_TRIAL = "AI 분석은 구독 회사 전용입니다. 체험 중에는 직접 입력으로 등록할 수 있고, 구독하면 바로 켜집니다.";
export const MSG_EXPIRED = "구독이 끝나 AI 분석을 쓸 수 없습니다. 결제하면 바로 다시 쓸 수 있습니다.";
export const MSG_SMS_TRIAL = "출고 안내 문자는 구독 회사 전용입니다. 구독하면 바로 켜집니다.";
export const MSG_SMS_EXPIRED = "구독이 끝나 문자를 보낼 수 없습니다. 결제하면 바로 다시 쓸 수 있습니다.";
export const msgAiQuota = (label, cap) => `이번 달 AI 분석 ${cap.toLocaleString()}회(${label})를 모두 썼습니다. 다음 달 1일에 다시 열리고, 상위 요금제로 바꾸면 바로 늘어납니다. 그동안은 직접 입력으로 등록할 수 있습니다.`;
export const msgSmsNone = (label) => `${label} 요금제에는 출고 안내 문자가 없습니다. 스탠다드부터 쓸 수 있습니다.`;
export const msgSmsQuota = (label, cap, left) => left > 0
  ? `이번 달 문자 ${cap.toLocaleString()}건(${label}) 중 ${left}건만 남아 한꺼번에 보낼 수 없습니다. 주문을 줄여 보내거나 상위 요금제로 바꿔 주세요.`
  : `이번 달 문자 ${cap.toLocaleString()}건(${label})을 모두 썼습니다. 다음 달 1일에 다시 열리고, 상위 요금제로 바꾸면 바로 늘어납니다.`;

const ms = (v) => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };

/** 'YYYY-MM' — saas_ai_usage·saas_sms_usage 의 month 키 */
export function monthKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 환경변수 SAAS_TRIAL_AI_CALLS → 0 이상 정수(없거나 이상하면 0) */
export function readTrialCalls(env = {}) {
  const n = parseInt(String(env.SAAS_TRIAL_AI_CALLS ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 유료 구독이 살아 있나 — canceled 면 거짓, trial·demo 는 거짓(유료가 아니다),
 * current_period_end 가 없으면(수동 운영) 참, 있으면 끝난 뒤 유예 3일까지 참.
 */
export function isPaidActive(account, now = new Date()) {
  if (!account) return false;
  if (account.status === "canceled") return false;
  if (account.is_demo || account.plan === "trial") return false;
  if (!account.current_period_end) return true;
  return now.getTime() < ms(account.current_period_end) + GRACE_DAYS * DAY;
}

/** 요금제의 월 AI 호출 한도. 모르는 요금제(사내 운영 값 등)는 무제한. */
export const aiCapOf = (plan) => { const c = PLAN_AI_CALLS[normalizePlan(plan)]; return Number.isFinite(c) ? c : Infinity; };
/** 요금제의 월 문자 한도. 모르는 요금제는 무제한. */
export const smsCapOf = (plan) => { const c = PLAN_SMS[normalizePlan(plan)]; return Number.isFinite(c) ? c : Infinity; };
const labelOf = (plan) => PLAN_LABELS[normalizePlan(plan)] || String(plan || "");

/**
 * AI 분석 허용 판정.
 *   account    company_accounts 행(없으면 null = 사내 계정 → 허용, 세지 않음)
 *   usage      이번 달 saas_ai_usage.count (없으면 0)
 *   trialCalls 체험 회사에 허용할 월 호출 수(SAAS_TRIAL_AI_CALLS, 기본 0)
 *   now        판정 시각
 * 돌려주는 값 { allow, reason, countUsage, cap, used }
 *   · 행 없음(사내 계정)                        → 허용, 세지 않음
 *   · is_demo 또는 plan=trial                   → trial_end 전이고 usage < trialCalls 면 허용(세기), 아니면 거부(MSG_TRIAL)
 *   · canceled, 또는 유료 기간 + 유예 3일 지남   → 거부(MSG_EXPIRED)
 *   · 유료 활성, usage < 요금제 월 한도          → 허용(세기)
 *   · 유료 활성, 한도 다 씀                      → 거부(msgAiQuota)
 */
export function aiGate({ account, usage = 0, trialCalls = 0, now = new Date(), messages } = {}) {
  const M = { trial: MSG_TRIAL, expired: MSG_EXPIRED, ...(messages || {}) };
  const used = Math.max(0, Number(usage) || 0);
  if (!account) return { allow: true, reason: "", countUsage: false, cap: Infinity, used };
  if (account.status === "canceled") return { allow: false, reason: M.expired, countUsage: false, cap: 0, used };
  if (account.is_demo || account.plan === "trial") {
    const active = ms(account.trial_end) > now.getTime();
    const n = Math.max(0, parseInt(trialCalls, 10) || 0);
    if (active && used < n) return { allow: true, reason: "", countUsage: true, cap: n, used };
    return { allow: false, reason: M.trial, countUsage: false, cap: n, used };
  }
  if (!isPaidActive(account, now)) return { allow: false, reason: M.expired, countUsage: false, cap: 0, used };
  const cap = aiCapOf(account.plan);
  if (used >= cap) return { allow: false, reason: msgAiQuota(labelOf(account.plan), cap), countUsage: false, cap, used };
  return { allow: true, reason: "", countUsage: true, cap, used };
}

/**
 * 문자 발송 게이트 — 유료 회사만, 요금제 월 한도 안에서. 체험·데모는 SAAS_TRIAL_AI_CALLS 와 무관하게 거부.
 *   usage  이번 달 saas_sms_usage.count,  count  지금 보내려는 건수(기본 1)
 * 돌려주는 값 { allow, reason, countUsage, cap, used, left }
 */
export function smsGate({ account, usage = 0, count = 1, now = new Date() } = {}) {
  const used = Math.max(0, Number(usage) || 0);
  const n = Math.max(1, parseInt(count, 10) || 1);
  const base = aiGate({ account, usage: 0, trialCalls: 0, now, messages: { trial: MSG_SMS_TRIAL, expired: MSG_SMS_EXPIRED } });
  if (!account) return { ...base, cap: Infinity, used, left: Infinity };
  if (!base.allow) return { ...base, cap: 0, used, left: 0 };
  const cap = smsCapOf(account.plan);
  const left = Math.max(0, cap - used);
  if (cap === 0) return { allow: false, reason: msgSmsNone(labelOf(account.plan)), countUsage: false, cap, used, left };
  if (n > left) return { allow: false, reason: msgSmsQuota(labelOf(account.plan), cap, left), countUsage: false, cap, used, left };
  return { allow: true, reason: "", countUsage: true, cap, used, left };
}

/**
 * service role 클라이언트로 판정 재료를 읽는다 — company_accounts 행과 이번 달 AI 호출 수.
 * sb 는 supabase-js 클라이언트(여기서 만들지 않는다 — 이 모듈은 SDK import 가 없다).
 * 표·칸이 아직 없는 DB(마이그레이션 전)면 경고만 남기고 { account: null, usage: 0 } 쪽으로 기운다.
 */
export async function loadGateInput(sb, ownerId, now = new Date()) {
  let account = null, usage = 0;
  const a = await sb.from("company_accounts").select("*").eq("owner_id", ownerId).maybeSingle();
  if (a.error) console.warn("[ai-gate] company_accounts 읽기 실패(사내 계정으로 간주):", a.error.message);
  else account = a.data || null;
  const u = await sb.from("saas_ai_usage").select("count").eq("owner_id", ownerId).eq("month", monthKey(now)).maybeSingle();
  if (u.error) console.warn("[ai-gate] saas_ai_usage 읽기 실패(0 으로 간주):", u.error.message);
  else usage = Number(u.data?.count) || 0;
  return { account, usage };
}

/** 이번 달 문자 발송 건수(saas_sms_usage). 표가 없으면 0. */
export async function loadSmsUsage(sb, ownerId, now = new Date()) {
  const u = await sb.from("saas_sms_usage").select("count").eq("owner_id", ownerId).eq("month", monthKey(now)).maybeSingle();
  if (u.error) { console.warn("[sms-gate] saas_sms_usage 읽기 실패(0 으로 간주):", u.error.message); return 0; }
  return Number(u.data?.count) || 0;
}
