// 구독·로그인·PIN 게이트의 순수 규칙 — DB 없이 돈다(tests/saas/test-subscription.mjs).
// 활성 판정은 migrations/saas_company_accounts.sql 의 is_company_active() 와 같은 규칙이어야 한다.
// 거기가 강제(쓰기 차단)이고 여기는 화면 안내(배너·버튼 숨김)다.

export const LOGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/;
export const EMAIL_DOMAIN = "thebridge.erp";
export const PIN_RE = /^\d{4}$/;
export const GRACE_DAYS = 3;            // 유료 기간 끝난 뒤 유예
export const EXPIRING_SOON_DAYS = 7;    // 이 안이면 배너
export const PIN_IDLE_MS = 30 * 60 * 1000;   // 마지막 PIN 확인 뒤 이 시간이 지나면 다시 묻는다

export const PLANS = {
  trial: { label: "무료 체험", maxManagers: 3 },
  basic: { label: "베이직", maxManagers: 3 },
  pro: { label: "프로", maxManagers: 99 },
};

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
  const planLabel = PLANS[account.plan]?.label || account.plan;
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

/** 담당자 수 제한 — 공용 담당자는 세지 않는다 */
export function managerSeatsLeft(account, managers) {
  if (!account) return Infinity;
  const used = (managers || []).filter(m => !m.isPublic).length;
  return Math.max(0, (account.max_managers ?? PLANS[account.plan]?.maxManagers ?? 3) - used);
}
