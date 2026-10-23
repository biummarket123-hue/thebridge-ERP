// 회사 계정 서버 함수(/api/saas-account)·휴대폰 인증(/api/sms-verify) 호출 — 로그인·가입·비밀번호 재설정·변경·아이디 찾기·PIN 리셋이 같이 쓴다.
// SaasAuth.jsx 에 있던 postAccount 를 떼어 놓은 것(설정 화면의 비밀번호 변경이 로그인 화면 코드를 끌어오지 않게).

export async function postAccount(action, payload) {
  const res = await fetch("/api/saas-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

/** 휴대폰 인증번호 — action "send" | "verify". 서버가 문자를 못 보내는 개발 모드면 devCode 가 돌아온다. */
export async function smsVerify(action, phone, code) {
  const res = await fetch("/api/sms-verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, phone: normPhone(phone), code: code ? String(code).trim() : undefined }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

/** 숫자만 */
export const normPhone = (s) => String(s || "").replace(/\D/g, "");
/** 010-1234-5678 꼴. 숫자가 모자라면 그대로. */
export function formatPhone(s) {
  const d = normPhone(s);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(s || "").trim();
}
/** 휴대폰 번호로 쓸 만한가 — 010·011·016·017·018·019 로 시작하는 10~11자리 */
export const isMobilePhone = (s) => /^01[016789]\d{7,8}$/.test(normPhone(s));
