// 출고 안내 문자 글 만들기 — 순수 규칙(import 없음, tests/saas/test-sms-text.mjs 가 그대로 읽는다).
//
// 사용자 결정(2026-10-23): 자동 발송 문자는 LMS(긴 문자)로 넘어가면 안 된다. 쿨SMS 는 90바이트를 넘으면
// LMS 로 보내고 단가가 2.5배(약 20원 → 50원)라 요금제 원가가 깨진다. 그래서
//   · 서버(api/notify.js)는 항상 type "SMS" 로만 보내고, 90바이트 안에 못 들어가는 글은 보내지 않는다.
//   · 회사 문구가 길면 기본 문구 → 짧은 문구 → 회사명 줄이기 순으로 맞춘다(composeSms).
//   · 설정 화면(src/saas/lib/smsText.js, 같은 규칙의 복사본)은 가장 긴 값으로 채워 봐서 90바이트를 넘는 문구는 저장을 막는다.
// 한글은 2바이트, 영문·숫자·기호는 1바이트(EUC-KR 기준 — 쿨SMS 와 같다).

export const SMS_MAX_BYTES = 90;
export const DEFAULT_TEMPLATE = "[{회사명}] {고객명}님, 주문하신 상품이 {택배사}(으)로 발송되었습니다. 감사합니다.";
export const SHORT_TEMPLATE = "[{회사명}] {고객명}님, 주문하신 상품이 발송되었습니다.";
/** 설정 화면이 "가장 길 때" 를 재는 값 — 4글자 이름, 가장 긴 택배사 이름 */
export const SAMPLE_CUSTOMER = "홍길동님";
export const SAMPLE_COURIER = "CJ대한통운";

/** 쿨SMS 기준 바이트 수(한글 2, 그 외 1) */
export const smsBytes = (s) => [...String(s || "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);

/** {회사명} {고객명} {택배사} 를 바꿔 넣는다. 모르는 자리표시자는 그대로. */
export const SAMPLE_TRACKING = "123456789012";
export const fillTemplate = (tpl, vars = {}) => String(tpl || "").replace(/\{(회사명|고객명|택배사|송장번호)\}/g, (_, k) => String(vars[k] ?? ""));

/** 설정 화면용 — 이 문구를 가장 긴 값(회사명·4글자 이름·가장 긴 택배사)으로 채우면 몇 바이트인가 */
export function templateMaxBytes(template, { companyName = "", couriers = [SAMPLE_COURIER] } = {}) {
  const longest = [...(couriers || []), SAMPLE_COURIER].reduce((a, b) => (smsBytes(b) > smsBytes(a) ? b : a), "");
  return smsBytes(fillTemplate(template, { 회사명: companyName, 고객명: SAMPLE_CUSTOMER.replace(/님$/, ""), 택배사: longest, 송장번호: SAMPLE_TRACKING }));
}

/**
 * 90바이트 안에 들어가는 발송 글을 만든다.
 *   1. 회사 문구 그대로            → fallback ""
 *   2. 기본 문구                   → fallback "default"
 *   3. 짧은 문구(택배사 없음)       → fallback "short"
 *   4. 짧은 문구 + 회사명을 줄여서  → fallback "trimmed"
 * 그래도 안 들어가면 null(보내지 않는다 — api/notify.js 가 failed 로 돌려준다).
 */
export function composeSms(template, vars = {}) {
  const v = { 회사명: String(vars.회사명 || "").trim(), 고객명: String(vars.고객명 || "고객").trim(), 택배사: String(vars.택배사 || "택배").trim(), 송장번호: String(vars.송장번호 || "").trim() };
  const tries = [
    [String(template || "").trim() || DEFAULT_TEMPLATE, ""],
    [DEFAULT_TEMPLATE, "default"],
    [SHORT_TEMPLATE, "short"],
  ];
  for (const [tpl, fallback] of tries) {
    const text = fillTemplate(tpl, v);
    if (smsBytes(text) <= SMS_MAX_BYTES) return { text, bytes: smsBytes(text), fallback };
  }
  // 회사명을 한 글자씩 줄여 본다(최소 2글자). 고객 이름은 건드리지 않는다.
  for (let name = v.회사명; [...name].length >= 2; name = [...name].slice(0, -1).join("").trim()) {
    const text = fillTemplate(SHORT_TEMPLATE, { ...v, 회사명: name });
    if (smsBytes(text) <= SMS_MAX_BYTES) return { text, bytes: smsBytes(text), fallback: "trimmed" };
  }
  return null;
}
