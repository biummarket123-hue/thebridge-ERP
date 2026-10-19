import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Coolsms API (https://coolsms.co.kr)
async function sendSms(to, text) {
  const apiKey = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from = process.env.COOLSMS_SENDER || "01000000000";

  if (!apiKey || !apiSecret) {
    console.log(`[DEV] SMS to ${to}: ${text}`);
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
    body: JSON.stringify({ message: { to, from, text, type: "SMS" } }),
  });
  const data = await res.json();
  return { success: res.ok, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, phone, code } = req.body || {};

  if (action === "send") {
    if (!phone) return res.status(400).json({ error: "전화번호를 입력해주세요." });

    const cleanPhone = phone.replace(/[^0-9]/g, "");
    if (cleanPhone.length < 10) return res.status(400).json({ error: "올바른 전화번호를 입력해주세요." });

    // 6자리 인증번호 생성
    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // 3분

    // 기존 미인증 코드 삭제
    await supabase.from("phone_verifications").delete().eq("phone", cleanPhone).eq("verified", false);

    // 인증번호 저장
    await supabase.from("phone_verifications").insert({
      phone: cleanPhone,
      code: verifyCode,
      expires_at: expiresAt,
    });

    // SMS 발송
    const smsResult = await sendSms(cleanPhone, `[더브릿지] 인증번호: ${verifyCode}`);

    return res.json({
      success: true,
      message: "인증번호를 발송했습니다.",
      ...(smsResult.dev ? { devCode: verifyCode } : {}),
    });
  }

  if (action === "verify") {
    if (!phone || !code) return res.status(400).json({ error: "전화번호와 인증번호를 입력해주세요." });

    const cleanPhone = phone.replace(/[^0-9]/g, "");

    const { data } = await supabase
      .from("phone_verifications")
      .select("*")
      .eq("phone", cleanPhone)
      .eq("code", code)
      .eq("verified", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!data) return res.status(400).json({ error: "인증번호가 올바르지 않거나 만료되었습니다." });

    // 인증 완료 처리
    await supabase.from("phone_verifications").update({ verified: true }).eq("id", data.id);

    return res.json({ success: true, verified: true });
  }

  return res.status(400).json({ error: "Invalid action" });
}
