import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });

  const syncPass = `bium_sync_${email}_bridge2026`;

  try {
    // 기존 유저 확인
    const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
    const existing = users.find(u => u.email === email);

    if (existing) {
      // 이미 존재 → 비밀번호 업데이트 + 이메일 확인 보장
      await supabaseAdmin.auth.admin.updateUser(existing.id, {
        password: syncPass,
        email_confirm: true,
      });
      return res.json({ status: "existing", email });
    }

    // 신규 생성 (이메일 자동 확인)
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: syncPass,
      email_confirm: true,
      user_metadata: { company_name: email.split("@")[0], source: "biummarket" },
    });

    if (error) return res.status(400).json({ error: error.message });
    return res.json({ status: "created", email, userId: data.user.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
