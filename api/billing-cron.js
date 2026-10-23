// 매일 도는 크론 — Vercel 크론(vercel.json crons)이 매일 KST 01:00(UTC 16:00 전날)에 부른다.
//
//   1. 자동 결제: saas_billing.plan 이 유료 요금제이고 빌링키가 있는 회사 중 기간 끝이 하루 안이거나(또는 지났지만 유예 3일 안) 인 회사를
//      화면의 "지금 결제" 와 같은 처리(api/billing.js chargeWithBillingKey)로 결제한다. 실패하면 last_error 를 남기고 회사 휴대폰으로 문자를 보낸다.
//      토스 키가 없으면 이 단계는 건너뛴다.
//   2. 체험 종료 안내: 14일 체험 회사에 끝나기 3일 전과 끝난 날 문자를 한 번씩 보낸다(subscription_events 의 note 로 "보냈음"을 기억).
//   문자는 회사 계정의 contact(가입 때 인증한 휴대폰)로 간다. 번호가 없으면 못 보낸다(2026-10-23 부터는 가입 때 필수).
//
// 보호: CRON_SECRET 이 있으면 Authorization: Bearer <CRON_SECRET> 가 맞아야 한다(api/demo-cleanup.js 와 같은 방식).
import { createClient } from "@supabase/supabase-js";
import { isBillingEnabled, pricesFromEnv, shouldAutoCharge, PAID_PLANS, trialReminderDue, smsTrialD3, smsTrialEnded, smsChargeFailed, CHARGE_FAIL_SMS } from "./_billing_logic.js";
import { chargeWithBillingKey } from "./billing.js";
import { sendSms, cleanPhone } from "./_sms.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAY = 86400000;

async function note(sb, ownerId, memo, extra = {}) {
  const { error } = await sb.from("subscription_events").insert({ owner_id: ownerId, kind: "note", memo, ...extra });
  if (error) console.warn("[billing-cron] 이력 기록 실패:", error.message);
}

/** 회사 휴대폰으로 안내 문자. 번호가 없거나 실패하면 false. 보낸 뒤 이력에 남긴다(같은 안내를 두 번 안 보내게). */
async function notify(sb, account, memo, text) {
  const to = cleanPhone(account.contact);
  if (!to) { console.warn(`[billing-cron] ${account.login_id}: 휴대폰 없음 — ${memo} 못 보냄`); return false; }
  const r = await sendSms(to, text);
  if (!r.success) { console.warn(`[billing-cron] ${account.login_id}: 문자 실패 — ${r.error}`); return false; }
  await note(sb, account.owner_id, memo + (r.dev ? " (개발 모드)" : ""));
  return true;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "unauthorized" });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: "서버 설정 없음" });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const now = new Date();
  const out = { ok: true, charged: 0, targets: 0, failed: [], trialSms: 0, skipped: "" };

  // ── 1. 자동 결제 ──
  if (!isBillingEnabled(process.env)) out.skipped = "billing-disabled";
  else {
    const prices = pricesFromEnv(process.env);
    const { data: rows, error } = await sb.from("saas_billing").select("*").not("billing_key", "is", null).in("plan", PAID_PLANS);
    if (error) return res.status(500).json({ error: error.message });
    const ids = (rows || []).map(r => r.owner_id);
    const accounts = new Map();
    if (ids.length) {
      const { data: accs, error: aErr } = await sb.from("company_accounts").select("owner_id, login_id, name, contact, plan, status, trial_end, current_period_end, max_managers, is_demo").in("owner_id", ids);
      if (aErr) return res.status(500).json({ error: aErr.message });
      for (const a of accs || []) accounts.set(a.owner_id, a);
    }
    for (const billing of rows || []) {
      const account = accounts.get(billing.owner_id);
      if (!account || account.is_demo || !shouldAutoCharge(account, billing, now)) continue;
      out.targets += 1;
      try {
        await chargeWithBillingKey(sb, { account, billing, plan: billing.plan, now, prices, memo: "자동 결제" });
        out.charged += 1;
      } catch (e) {
        const msg = e?.message || String(e);
        out.failed.push({ login_id: account.login_id, error: msg });
        // 같은 실패 안내는 하루 한 번만 — 오늘 보낸 기록이 있으면 건너뛴다
        const { data: today } = await sb.from("subscription_events").select("id").eq("owner_id", account.owner_id).eq("kind", "note").like("memo", `${CHARGE_FAIL_SMS}%`).gt("created_at", new Date(now.getTime() - DAY).toISOString()).limit(1).maybeSingle();
        if (!today) await notify(sb, account, CHARGE_FAIL_SMS, smsChargeFailed(msg));
      }
    }
  }

  // ── 2. 체험 종료 안내 (D-3 · 끝난 날) ──
  const { data: trials, error: tErr } = await sb.from("company_accounts")
    .select("owner_id, login_id, name, contact, plan, status, trial_end, is_demo")
    .eq("plan", "trial").eq("is_demo", false).neq("status", "canceled")
    .gte("trial_end", new Date(now.getTime() - 2 * DAY).toISOString()).lte("trial_end", new Date(now.getTime() + 3 * DAY).toISOString());
  if (tErr) console.warn("[billing-cron] 체험 회사 읽기 실패:", tErr.message);
  for (const account of trials || []) {
    const { data: sent } = await sb.from("subscription_events").select("memo").eq("owner_id", account.owner_id).eq("kind", "note").like("memo", "[문자]%");
    const due = trialReminderDue(account, now, (sent || []).map(s => String(s.memo || "").replace(/ \(개발 모드\)$/, "")));
    if (!due) continue;
    const text = due === "[문자] 체험 종료 안내" ? smsTrialEnded() : smsTrialD3(account.trial_end);
    if (await notify(sb, account, due, text)) out.trialSms += 1;
  }

  console.log(`[billing-cron] 결제 대상 ${out.targets}곳 중 ${out.charged}곳 결제, ${out.failed.length}곳 실패 · 체험 안내 문자 ${out.trialSms}건${out.skipped ? ` · ${out.skipped}` : ""}`);
  return res.status(200).json(out);
}
