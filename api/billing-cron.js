// 자동 결제 크론 — Vercel 크론(vercel.json crons)이 매일 KST 01:00(UTC 16:00 전날)에 부른다.
// saas_billing.plan 이 있고 빌링키가 있는 회사 중 기간 끝이 하루 안이거나(또는 지났지만 유예 3일 안) 인 회사를 돌며
// 화면의 "지금 결제" 와 같은 처리(api/billing.js chargeWithBillingKey)를 한다. 실패하면 last_error 를 남기고 다음 회사로.
// 보호: CRON_SECRET 이 있으면 Authorization: Bearer <CRON_SECRET> 가 맞아야 한다(api/demo-cleanup.js 와 같은 방식).
// 토스 키가 없으면 아무것도 하지 않고 200.
import { createClient } from "@supabase/supabase-js";
import { isBillingEnabled, pricesFromEnv, shouldAutoCharge } from "./_billing_logic.js";
import { chargeWithBillingKey } from "./billing.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!isBillingEnabled(process.env)) return res.status(200).json({ ok: true, skipped: "billing-disabled", charged: 0 });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "서버 설정 없음" });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const prices = pricesFromEnv(process.env);
  const now = new Date();

  const { data: rows, error } = await sb.from("saas_billing").select("*").not("billing_key", "is", null).in("plan", ["basic", "pro"]);
  if (error) return res.status(500).json({ error: error.message });
  const ids = (rows || []).map(r => r.owner_id);
  const accounts = new Map();
  if (ids.length) {
    const { data: accs, error: aErr } = await sb.from("company_accounts").select("owner_id, login_id, name, plan, status, trial_end, current_period_end, max_managers, is_demo").in("owner_id", ids);
    if (aErr) return res.status(500).json({ error: aErr.message });
    for (const a of accs || []) accounts.set(a.owner_id, a);
  }

  let charged = 0;
  const failed = [];
  let targets = 0;
  for (const billing of rows || []) {
    const account = accounts.get(billing.owner_id);
    if (!account || account.is_demo || !shouldAutoCharge(account, billing, now)) continue;
    targets += 1;
    try {
      await chargeWithBillingKey(sb, { account, billing, plan: billing.plan, now, prices, memo: "자동 결제" });
      charged += 1;
    } catch (e) {
      failed.push({ login_id: account.login_id, error: e?.message || String(e) });
    }
  }
  console.log(`[billing-cron] 대상 ${targets}곳 중 ${charged}곳 결제, ${failed.length}곳 실패`);
  return res.status(200).json({ ok: true, targets, charged, failed });
}
