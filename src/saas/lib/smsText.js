// 출고 안내 문자 — 설정 화면용 바이트 규칙. 서버 api/_sms_text.js 와 같은 규칙의 복사본(서버는 화면 코드를 import 하지 않는다).
// 사용자 결정(2026-10-23): 자동 발송 문자는 LMS 로 넘어가면 안 된다 → 90바이트를 넘는 문구는 저장을 막는다. 강제는 서버(api/notify.js).

export const SMS_MAX_BYTES = 90;
export const SAMPLE_CUSTOMER = "홍길동";
export const SAMPLE_COURIER = "CJ대한통운";

/** 쿨SMS 기준 바이트 수(한글 2, 그 외 1) */
export const smsBytes = (s) => [...String(s || "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);

/** {회사명} {고객명} {택배사} 를 바꿔 넣는다. */
export const SAMPLE_TRACKING = "123456789012";
export const fillTemplate = (tpl, vars = {}) => String(tpl || "").replace(/\{(회사명|고객명|택배사|송장번호)\}/g, (_, k) => String(vars[k] ?? ""));

/** 이 문구를 가장 긴 값(회사명·3글자 이름·가장 긴 택배사)으로 채우면 몇 바이트인가 */
export function templateMaxBytes(template, { companyName = "", couriers = [SAMPLE_COURIER] } = {}) {
  const longest = [...(couriers || []), SAMPLE_COURIER].reduce((a, b) => (smsBytes(b) > smsBytes(a) ? b : a), "");
  return smsBytes(fillTemplate(template, { 회사명: companyName, 고객명: SAMPLE_CUSTOMER, 택배사: longest, 송장번호: SAMPLE_TRACKING }));
}
