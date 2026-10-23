// 문자 발송(쿨SMS) — api/notify.js(출고 안내)·api/sms-verify.js(인증번호)·api/billing-cron.js(결제 실패·체험 종료 안내)가 같이 쓴다.
// 항상 SMS(90바이트) 로만 보낸다(사용자 결정 2026-10-23: LMS 금지). 넘치는 글은 보내지 않고 error 를 돌려준다.
// 환경변수 COOLSMS_API_KEY / COOLSMS_API_SECRET / COOLSMS_SENDER 가 하나라도 비면 실제 발송 없이 로그만 남기고 { success: true, dev: true }.
import { smsBytes, SMS_MAX_BYTES } from "./_sms_text.js";

export const SMS_BRAND = "[THE BRIDGE ERP]";   // 17바이트 — 안내 문자 머리
export const cleanPhone = (p) => String(p || "").replace(/[^0-9]/g, "");

export async function sendSms(to, text) {
  const phone = cleanPhone(to);
  if (phone.length < 10) return { success: false, error: "전화번호가 없거나 짧습니다" };
  if (smsBytes(text) > SMS_MAX_BYTES) return { success: false, error: `문자가 ${SMS_MAX_BYTES}바이트를 넘습니다(${smsBytes(text)})` };
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_SENDER || "";
  if (!apiKey || !apiSecret || !from) {
    console.log(`[DEV] SMS to ${phone}: ${text}`);
    return { success: true, dev: true };
  }
  const date = new Date().toISOString();
  const crypto = await import("crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hmac = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");
  const auth = `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${hmac}`;
  const res = await fetch("https://api.coolsms.co.kr/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ message: { to: phone, from, text, type: "SMS" } }),
  });
  const data = await res.json().catch(() => ({}));
  return { success: res.ok, data, error: res.ok ? "" : (data?.errorMessage || data?.message || `Coolsms ${res.status}`) };
}
