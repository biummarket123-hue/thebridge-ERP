// 구독·로그인·PIN 게이트의 순수 규칙 — DB 없이 돈다(tests/saas/test-subscription.mjs).
// 활성 판정은 migrations/saas_company_accounts.sql 의 is_company_active() 와 같은 규칙이어야 한다.
// 거기가 강제(쓰기 차단)이고 여기는 화면 안내(배너·버튼 숨김)다.

export const LOGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/;
export const EMAIL_DOMAIN = "thebridge.erp";
export const PIN_RE = /^\d{4}$/;
export const GRACE_DAYS = 3;            // 유료 기간 끝난 뒤 유예
export const EXPIRING_SOON_DAYS = 7;    // 이 안이면 배너
export const PIN_IDLE_MS = 30 * 60 * 1000;   // 마지막 PIN 확인 뒤 이 시간이 지나면 다시 묻는다

// price 는 화면 기본값(원/월). 실제 청구 금액은 서버(api/_billing_logic.js · SAAS_PRICE_*)가 정하고 /api/billing status 가 내려준다.
// 2026-10-23 사용자 결정 — 4단계. 서버 단일 출처는 api/_plans.js(값이 같아야 한다). ai·sms 는 월 할당량(0 = 없음).
export const PLANS = {
  trial: { label: "무료 체험", maxManagers: 3, price: 0, ai: 0, sms: 0, desc: "14일 동안 모든 기능(AI 분석·문자 제외)" },
  starter: { label: "스타터", maxManagers: 2, price: 9900, ai: 10, sms: 0, desc: "담당자 2명 · 주문·재고·거래처·정산·포장대 · AI 분석 맛보기 월 10회",
    fit: "혼자 또는 둘이서 운영하는 작은 매장. 주문·재고·정산을 손으로 적던 일을 그대로 옮깁니다.",
    notes: ["AI 분석은 맛보기 월 10회 — 다 쓰면 그 달은 직접 입력으로 등록합니다.", "출고 안내 문자는 없습니다. 문자가 필요하면 스탠다드부터입니다."] },
  standard: { label: "스탠다드", maxManagers: 5, price: 39000, ai: 300, sms: 200, desc: "담당자 5명 · AI 분석 월 300회 · 출고 안내 문자 월 200건",
    fit: "담당자 3~5명이 함께 쓰는 매장. 카톡·문자로 들어온 주문을 AI 가 읽어 넣고, 출고하면 고객에게 문자가 갑니다.",
    notes: ["하루 10건 안팎의 AI 분석과 출고 문자에 맞춘 한도입니다."] },
  pro: { label: "프로", maxManagers: 99, price: 89000, ai: 2000, sms: 1000, desc: "담당자 무제한 · AI 분석 월 2,000회 · 문자 월 1,000건",
    fit: "담당자가 많고 AI 분석·출고 문자를 매일 수십 건 쓰는 회사. 담당자 수 제한이 없습니다.",
    notes: ["AI 분석 하루 60~70회, 출고 문자 하루 30건 안팎에 맞춘 한도입니다.", "문자·AI 가 더 필요하면 프로 MAX 로 올릴 수 있습니다(프로 구독 회사에만 보입니다)."] },
  promax: { label: "프로 MAX", maxManagers: 99, price: 149000, ai: 3000, sms: 2000, desc: "담당자 무제한 · AI 분석 월 3,000회 · 문자 월 2,000건",
    fit: "프로의 문자·AI 한도가 모자라는 회사를 위한 윗단계. 프로를 구독 중인 회사만 고를 수 있습니다.",
    notes: ["AI 분석 하루 100회, 출고 문자 하루 70건 안팎에 맞춘 한도입니다. 프로보다 문자가 2배입니다."] },
};
/** 모든 요금제에 들어 있는 기능 — 요금제 자세히 보기 창 */
export const PLAN_COMMON = [
  "주문 등록·수정·검색, 입금·출고 상태 관리",
  "원단 재고(롤·마 단위)와 입고·출고 기록",
  "거래처 장부·미수금·정산(월별 매출)",
  "포장대(출고 작업 화면)·합배송·운임·취소·교환",
  "변경 기록(누가 언제 무엇을 바꿨는지)",
  "엑셀 내보내기·데이터 백업, 휴대폰·태블릿 화면",
  "첫 구독 때 쓰던 엑셀(거래처·품번·주문 이력) 이관 무료 — 운영팀이 대신 넣어 드립니다",
];
const seatText = (n) => (n >= 99 ? "무제한" : `${n}명`);
const capText = (n, unit) => (n > 0 ? `월 ${n.toLocaleString()}${unit}` : "없음");
/** 두 요금제의 차이(담당자·AI·문자)를 "항목 전 → 후" 글줄로. 같으면 빈 배열. */
export function planDiff(from, to) {
  if (!from || !to) return [];
  const out = [];
  if (from.maxManagers !== to.maxManagers) out.push(`담당자 ${seatText(from.maxManagers)} → ${seatText(to.maxManagers)}`);
  if (from.ai !== to.ai) out.push(`AI 분석 ${capText(from.ai, "회")} → ${capText(to.ai, "회")}`);
  if (from.sms !== to.sms) out.push(`출고 안내 문자 ${capText(from.sms, "건")} → ${capText(to.sms, "건")}`);
  return out;
}
export const PAID_PLAN_KEYS = ["starter", "standard", "pro", "promax"];
/** 이 회사가 고를 수 있는 요금제(요금제 카드) — 프로 MAX 는 프로(또는 프로 MAX) 구독 회사에만 보인다. 서버 api/_plans.js canPickPlan 과 같은 규칙. */
export const pickablePlanKeys = (account) => ["pro", "promax"].includes(normalizePlan(account?.plan)) ? PAID_PLAN_KEYS : PAID_PLAN_KEYS.filter(k => k !== "promax");
/** 옛 이름(basic, 2026-10-23 이전) → 지금 이름 */
export const normalizePlan = (p) => (p === "basic" ? "standard" : String(p || ""));
export const planOf = (account) => PLANS[normalizePlan(account?.plan)];

/** 아이디 정리 — 소문자, 앞뒤 공백 제거. 형식이 틀리면 "" */
export function normalizeLoginId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return LOGIN_ID_RE.test(s) ? s : "";
}

/** 로그인 아이디 ↔ Supabase 가상 이메일 */
export const loginIdToEmail = (id) => `${id}@${EMAIL_DOMAIN}`;
export const emailToLoginId = (email) => {
  const m = /^([^@]+)@/.exec(String(email || ""));
  return m && String(email).endsWith("@" + EMAIL_DOMAIN) ? m[1] : "";
};

/** 입력이 이메일 꼴인지(그대로 쓸지) 아이디인지 */
export const isEmailLike = (s) => /@/.test(String(s || ""));

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "비밀번호는 8자 이상이어야 합니다";
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return "비밀번호에 영문과 숫자를 함께 넣어 주세요";
  return "";
}

export const isValidPin = (pin) => PIN_RE.test(String(pin || ""));

const DAY = 86400000;
const daysLeft = (end, now) => Math.ceil((new Date(end).getTime() - now.getTime()) / DAY);

/**
 * 구독 상태.
 *  account 가 null(행 없음) → { phase: "none", active: true }  — 사내 계정·가입 전 이식 데이터
 *  체험: trial_end 전이면 active. 유료: current_period_end + 유예 전이면 active. canceled 면 비활성.
 * 돌려주는 값: { phase: none|trial|paid|grace|expired|canceled, active, daysLeft, planLabel, readOnly }
 */
export function subscriptionState(account, now = new Date()) {
  if (!account) return { phase: "none", active: true, daysLeft: null, planLabel: "사내 계정", readOnly: false, soon: false };
  const planLabel = planOf(account)?.label || account.plan;
  if (account.status === "canceled") return { phase: "canceled", active: false, daysLeft: 0, planLabel, readOnly: true, soon: false };
  if (account.plan === "trial") {
    const d = daysLeft(account.trial_end, now);
    const active = new Date(account.trial_end).getTime() > now.getTime();
    return { phase: active ? "trial" : "expired", active, daysLeft: Math.max(0, d), planLabel, readOnly: !active, soon: active && d <= EXPIRING_SOON_DAYS };
  }
  if (!account.current_period_end) return { phase: "paid", active: true, daysLeft: null, planLabel, readOnly: false, soon: false };
  const endMs = new Date(account.current_period_end).getTime();
  const graceEnd = endMs + GRACE_DAYS * DAY;
  if (now.getTime() < endMs) {
    const d = daysLeft(account.current_period_end, now);
    return { phase: "paid", active: true, daysLeft: d, planLabel, readOnly: false, soon: d <= EXPIRING_SOON_DAYS };
  }
  if (now.getTime() < graceEnd) return { phase: "grace", active: true, daysLeft: Math.ceil((graceEnd - now.getTime()) / DAY), planLabel, readOnly: false, soon: true };
  return { phase: "expired", active: false, daysLeft: 0, planLabel, readOnly: true, soon: false };
}

/** 배너 문구. 없으면 "" */
export function subscriptionNotice(state) {
  switch (state.phase) {
    case "trial": return state.soon ? `무료 체험이 ${state.daysLeft}일 남았습니다. 계속 쓰려면 구독을 시작해 주세요.` : "";
    case "paid": return state.soon ? `구독 기간이 ${state.daysLeft}일 남았습니다.` : "";
    case "grace": return `구독 기간이 지났습니다. ${state.daysLeft}일 안에 결제하지 않으면 읽기 전용으로 바뀝니다.`;
    case "expired": return "구독이 끝나 읽기 전용입니다. 데이터는 그대로 있고, 결제하면 바로 다시 쓸 수 있습니다.";
    case "canceled": return "구독이 해지되어 읽기 전용입니다.";
    default: return "";
  }
}

/**
 * PIN 게이트 — 다시 물어야 하나.
 *  verifiedAt: 마지막 확인 시각(ms). pinned: 이 기기에 담당자 고정(한 번 확인하면 다시 묻지 않음).
 */
export function pinNeeded({ hasPin, verifiedAt, pinned, now = Date.now(), idleMs = PIN_IDLE_MS }) {
  if (!hasPin) return false;
  if (!verifiedAt) return true;
  if (pinned) return false;
  return now - verifiedAt > idleMs;
}

/**
 * AI 분석(토큰 비용) 허용 — 사용자 결정(2026-10-20): 유료 구독 회사만. 사내 계정(행 없음)은 허용.
 * 체험·데모는 화면에서 "구독 후 사용 가능" 안내. 서버(api/analyze.js)가 같은 규칙으로 막고, SAAS_TRIAL_AI_CALLS 가 있으면 그만큼만 열어 준다.
 * 돌려주는 값 { allowed, reason } — reason 은 안내 문구(허용이면 "").
 */
export function aiAccess(account, state, usage = 0) {
  const used = Math.max(0, Number(usage) || 0);
  if (!account) return { allowed: true, reason: "", used, cap: Infinity };
  if (account.is_demo) return { allowed: false, reason: "체험 환경에서는 AI 분석이 꺼져 있습니다. 직접 입력으로 등록해 보세요 — 구독하면 바로 켜집니다." };
  if (state?.readOnly) return { allowed: false, reason: "구독이 끝나 AI 분석을 쓸 수 없습니다." };
  if (account.plan === "trial") return { allowed: false, reason: "AI 분석(글·사진 읽기)은 구독 회사 전용입니다. 체험 중에는 직접 입력으로 등록할 수 있습니다.", used, cap: 0 };
  // 요금제 월 할당량(2026-10-23). 서버(api/_ai_gate.js)가 같은 규칙으로 강제한다.
  const p = planOf(account);
  const cap = Number.isFinite(p?.ai) ? p.ai : Infinity;
  if (used >= cap) return { allowed: false, reason: `이번 달 AI 분석 ${cap.toLocaleString()}회(${p.label})를 모두 썼습니다. 다음 달 1일에 다시 열리고, 상위 요금제로 바꾸면 바로 늘어납니다.`, used, cap };
  return { allowed: true, reason: "", used, cap };
}

/**
 * 출고 안내 문자 — 유료 회사만, 요금제 월 건수 안에서(스타터는 없음). 화면 안내용 — 서버(api/notify.js)가 강제한다.
 * 돌려주는 값 { allowed, reason, used, cap }
 */
export function smsAccess(account, state, usage = 0) {
  const used = Math.max(0, Number(usage) || 0);
  if (!account) return { allowed: true, reason: "", used, cap: Infinity };
  if (account.is_demo || account.plan === "trial") return { allowed: false, reason: "출고 안내 문자는 구독 회사 전용입니다. 구독하면 바로 켜집니다.", used, cap: 0 };
  if (state?.readOnly) return { allowed: false, reason: "구독이 끝나 문자를 보낼 수 없습니다.", used, cap: 0 };
  const p = planOf(account);
  const cap = Number.isFinite(p?.sms) ? p.sms : Infinity;
  if (cap === 0) return { allowed: false, reason: `${p.label} 요금제에는 출고 안내 문자가 없습니다. 스탠다드부터 쓸 수 있습니다.`, used, cap };
  if (used >= cap) return { allowed: false, reason: `이번 달 문자 ${cap.toLocaleString()}건(${p.label})을 모두 썼습니다. 다음 달 1일에 다시 열리고, 상위 요금제로 바꾸면 바로 늘어납니다.`, used, cap };
  return { allowed: true, reason: "", used, cap };
}

/** 담당자 수 제한 — 공용 담당자는 세지 않는다 */
export function managerSeatsLeft(account, managers) {
  if (!account) return Infinity;
  const used = (managers || []).filter(m => !m.isPublic).length;
  return Math.max(0, (account.max_managers ?? planOf(account)?.maxManagers ?? 3) - used);
}
