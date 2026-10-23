// 휴대폰 인증번호 — phone_verifications 표(migrations/add_link_order_drafts.sql, service role 전용).
// 공개 주문 링크(api/sms-verify.js)와 회사 계정(api/saas-account.js: 가입·비밀번호 재설정·아이디 찾기)이 같이 쓴다.
//   issueCode     6자리 번호를 만들어 저장하고 문자로 보낸다(3분). 개발 모드면 devCode 를 돌려준다.
//   checkCode     번호가 맞고 안 지났으면 verified=true 로 바꾸고 true.
//   recentlyVerified  이 번호가 최근 N분 안에 인증을 마쳤나(가입 때 서버가 다시 확인).
import { sendSms, cleanPhone, SMS_BRAND } from "./_sms.js";

export const CODE_TTL_MS = 3 * 60 * 1000;
export const VERIFIED_WINDOW_MS = 30 * 60 * 1000;

export async function issueCode(sb, phoneRaw, purpose = "인증번호") {
  const phone = cleanPhone(phoneRaw);
  if (phone.length < 10) return { error: "올바른 휴대폰 번호를 입력해 주세요." };
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await sb.from("phone_verifications").delete().eq("phone", phone).eq("verified", false);
  const { error } = await sb.from("phone_verifications").insert({ phone, code, expires_at: expiresAt });
  if (error) return { error: "인증번호를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  const r = await sendSms(phone, `${SMS_BRAND} ${purpose}: ${code}`);
  if (!r.success) return { error: `문자를 보내지 못했습니다: ${r.error || "발송 실패"}` };
  return { ok: true, ...(r.dev ? { devCode: code } : {}) };
}

export async function checkCode(sb, phoneRaw, codeRaw) {
  const phone = cleanPhone(phoneRaw);
  const code = String(codeRaw || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) return false;
  const { data } = await sb.from("phone_verifications").select("id")
    .eq("phone", phone).eq("code", code).eq("verified", false).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return false;
  await sb.from("phone_verifications").update({ verified: true }).eq("id", data.id);
  return true;
}

export async function recentlyVerified(sb, phoneRaw, windowMs = VERIFIED_WINDOW_MS) {
  const phone = cleanPhone(phoneRaw);
  if (!phone) return false;
  const { data } = await sb.from("phone_verifications").select("id")
    .eq("phone", phone).eq("verified", true).gt("created_at", new Date(Date.now() - windowMs).toISOString())
    .limit(1).maybeSingle();
  return !!data;
}
