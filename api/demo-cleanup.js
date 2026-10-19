// 체험 회사 정리 — Vercel 크론(vercel.json crons, 매시간)이 부른다. 1시간이 지난 체험 회사의 auth 유저를 지우면
// company_accounts·managers·orders… 가 전부 cascade 로 사라진다(migrations/saas_demo.sql).
// 보호: CRON_SECRET 환경변수가 있으면 Authorization: Bearer <CRON_SECRET> 가 맞아야 한다(Vercel 크론이 자동으로 붙인다).
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "서버 설정 없음" });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await sb.rpc("demo_expired_owners");
  if (error) return res.status(500).json({ error: error.message });
  const ids = Array.isArray(data) ? data : [];
  let deleted = 0;
  const failed = [];
  for (const id of ids) {
    const { error: e } = await sb.auth.admin.deleteUser(id);
    if (e) failed.push({ id, error: e.message }); else deleted += 1;
  }
  console.log(`[demo-cleanup] 지난 체험 회사 ${ids.length}곳 중 ${deleted}곳 삭제`);
  return res.status(200).json({ ok: true, expired: ids.length, deleted, failed });
}
