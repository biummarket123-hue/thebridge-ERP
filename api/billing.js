// 구독 결제(토스페이먼츠 빌링) 서버 함수 — /api/billing  POST { action, ... }
//
// 왜 서버에서 하나:
//   · 토스 비밀키(TOSS_SECRET_KEY)와 빌링키(saas_billing.billing_key)는 브라우저에 절대 내려가지 않는다.
//     saas_billing 표는 브라우저 정책이 없어 service role 로만 읽고 쓴다(migrations/saas_features.sql).
//   · company_accounts 의 요금제·기간은 트리거가 브라우저 수정을 막는다 — 여기(service role)만 바꾼다.
//   · 세션 검증은 api/analyze.js 와 같다: Authorization: Bearer <Supabase access token> → GoTrue 가 확인한 유저 = 회사(owner_id).
//
// 환경변수(VITE_ 접두사 없는 것은 서버만 읽는다):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   TOSS_SECRET_KEY        토스 API 비밀키(test_sk_… / live_sk_…). 없으면 결제 연동 꺼짐(enabled=false).
//   VITE_TOSS_CLIENT_KEY   토스 클라이언트키 — 브라우저 SDK 가 카드 등록 창을 띄울 때 쓴다. 둘 다 있어야 켜진다.
//   SAAS_PRICE_BASIC, SAAS_PRICE_PRO   월 요금(원). 기본 99,000 / 199,000 (api/_billing_logic.js).
//
// action:
//   status                         → { enabled, customerKey, hasCard, cardLabel, plan, nextChargeAt, lastPaidAt, lastError, prices, labels, seats }
//   issue  { authKey, customerKey } → 토스 빌링키 발급 → 저장. { ok, cardLabel }
//   charge { plan: basic|pro }     → 빌링키로 결제 → 기간 +30일(남은 기간 끝에서). { ok, periodEnd, amount }
//   cancel-auto                    → saas_billing.plan=null (다음 달 자동 결제 안 함, 기간은 그대로)
//   remove-card                    → billing_key=null (자동 결제도 꺼진다)
// 키가 없을 때: status 는 enabled=false 로 200, 나머지 action 은 400 "결제 연동 준비 중" — 화면이 깨지지 않는다.

import { createClient } from "@supabase/supabase-js";
import {
  isBillingEnabled, pricesFromEnv, makeCustomerKey, applyCharge, makeOrderId, makeOrderName,
  cardLabelFrom, tossErrorMessage, isPaidPlan, publicBillingStatus, PLAN_LABELS,
} from "./_billing_logic.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const VERIFY_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOSS_API = "https://api.tosspayments.com/v1";
const NOT_READY = "결제 연동 준비 중입니다. 구독 시작·연장은 운영자에게 연락해 주세요.";

const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function getSessionUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { user: null, reason: "no-token" };
  if (!SUPABASE_URL || !VERIFY_KEY) return { user: null, reason: "env-missing" };
  const sb = createClient(SUPABASE_URL, VERIFY_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.getUser(m[1]);
  if (error || !data?.user) return { user: null, reason: "invalid" };
  return { user: data.user, reason: null };
}

/** 토스 API 호출 — Basic base64(secretKey + ":") */
export async function tossPost(path, body, secretKey = process.env.TOSS_SECRET_KEY) {
  const auth = Buffer.from(`${secretKey}:`).toString("base64");
  const res = await fetch(`${TOSS_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(tossErrorMessage(json, res.status)); e.status = res.status; e.body = json; throw e; }
  return json;
}

export async function loadAccount(sb, ownerId) {
  const { data, error } = await sb.from("company_accounts").select("owner_id, login_id, name, plan, status, trial_end, current_period_end, max_managers, is_demo").eq("owner_id", ownerId).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function loadBilling(sb, ownerId) {
  const { data, error } = await sb.from("saas_billing").select("*").eq("owner_id", ownerId).maybeSingle();
  if (error) throw error;
  return data || null;
}

/** 빌링 행이 없으면 customerKey 를 만들어 넣고 돌려준다 */
async function ensureBilling(sb, ownerId) {
  const cur = await loadBilling(sb, ownerId);
  if (cur) return cur;
  const row = { owner_id: ownerId, customer_key: makeCustomerKey(ownerId), card_label: "", plan: null, last_error: "" };
  const { data, error } = await sb.from("saas_billing").insert(row).select("*").single();
  if (error) {
    // 동시에 두 번 눌렀을 때 — 이미 있으면 그걸 읽는다
    const again = await loadBilling(sb, ownerId);
    if (again) return again;
    throw error;
  }
  return data;
}

async function saveBilling(sb, ownerId, patch) {
  const { error } = await sb.from("saas_billing").update({ ...patch, updated_at: new Date().toISOString() }).eq("owner_id", ownerId);
  if (error) throw error;
}

async function addEvent(sb, ownerId, kind, extra = {}) {
  const { error } = await sb.from("subscription_events").insert({ owner_id: ownerId, kind, ...extra });
  if (error) console.warn("[billing] 이력 기록 실패:", error.message);
}

/**
 * 빌링키로 한 달 결제하고 기간을 늘린다. 화면(charge)과 크론(billing-cron)이 같은 함수를 쓴다.
 * 성공 → { ok: true, amount, periodEnd }. 실패 → 예외(last_error 는 여기서 저장).
 */
export async function chargeWithBillingKey(sb, { account, billing, plan, now = new Date(), prices, memo }) {
  if (!isPaidPlan(plan)) throw new Error("요금제를 골라 주세요 (베이직 또는 프로)");
  if (!billing?.billing_key) throw new Error("등록된 카드가 없습니다. 카드를 먼저 등록해 주세요.");
  const amount = (prices || pricesFromEnv(process.env))[plan];
  const orderId = makeOrderId(account.owner_id, now);
  const orderName = makeOrderName(plan);
  let pay;
  try {
    pay = await tossPost(`/billing/${encodeURIComponent(billing.billing_key)}`, {
      customerKey: billing.customer_key, amount, orderId, orderName,
      customerName: account.name || account.login_id || undefined,
    });
  } catch (e) {
    const msg = e.message || "결제에 실패했습니다";
    await saveBilling(sb, account.owner_id, { last_error: msg }).catch(() => {});
    await addEvent(sb, account.owner_id, "note", { plan, amount, memo: `카드 결제 실패 · ${msg}` });
    throw e;
  }
  const { patch, periodStart, periodEnd, fromTrial } = applyCharge(account, plan, now);
  const { error: aErr } = await sb.from("company_accounts").update(patch).eq("owner_id", account.owner_id);
  if (aErr) {
    // 돈은 나갔는데 기간을 못 늘린 상태 — 이력에 남겨 운영자가 수동으로 맞춘다
    console.error("[billing] 결제 뒤 기간 갱신 실패:", aErr.message, pay?.paymentKey);
    await saveBilling(sb, account.owner_id, { last_error: `결제는 됐으나 기간 갱신 실패: ${aErr.message}` }).catch(() => {});
    await addEvent(sb, account.owner_id, "note", { plan, amount, memo: `결제 성공(paymentKey ${pay?.paymentKey || "?"}) 뒤 기간 갱신 실패 — 운영자 확인 필요` });
    throw new Error("결제는 됐지만 기간을 늘리지 못했습니다. 운영자에게 연락해 주세요.");
  }
  await saveBilling(sb, account.owner_id, { plan, last_paid_at: now.toISOString(), last_error: "" });
  await addEvent(sb, account.owner_id, "billing", {
    amount, plan, period_start: periodStart, period_end: periodEnd,
    memo: [memo || "카드 결제", `${PLAN_LABELS[plan]} 1개월`, fromTrial ? "체험 → 유료 전환" : "", pay?.paymentKey ? `paymentKey ${pay.paymentKey}` : ""].filter(Boolean).join(" · "),
  });
  return { ok: true, amount, periodEnd, paymentKey: pay?.paymentKey || null };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const enabled = isBillingEnabled(process.env);
  const prices = pricesFromEnv(process.env);
  const action = String(req.body?.action || "");

  const { user, reason } = await getSessionUser(req);
  if (!user) {
    if (reason === "env-missing") return res.status(500).json({ error: "서버 인증 설정이 없습니다. 관리자에게 알려주세요." });
    return res.status(401).json({ error: "로그인 세션이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요." });
  }
  if (!SERVICE_KEY) {
    // service role 이 없으면 saas_billing 을 읽을 수 없다 — 화면은 "준비 중" 으로 떨어진다
    if (action === "status") return res.status(200).json(publicBillingStatus({ enabled: false, billing: null, account: null, prices }));
    return res.status(400).json({ error: NOT_READY });
  }

  const sb = admin();
  const ownerId = user.id;
  try {
    const account = await loadAccount(sb, ownerId);

    if (action === "status") {
      if (!account) return res.status(200).json(publicBillingStatus({ enabled: false, billing: null, account: null, prices }));
      // customerKey 는 결제 연동이 켜져 있고 체험(데모)이 아닐 때만 만든다 — 데모 회사는 1시간 뒤 지워진다
      const billing = enabled && !account.is_demo ? await ensureBilling(sb, ownerId) : await loadBilling(sb, ownerId);
      return res.status(200).json(publicBillingStatus({ enabled: enabled && !account.is_demo, billing, account, prices }));
    }

    if (!enabled) return res.status(400).json({ error: NOT_READY });
    if (!account) return res.status(400).json({ error: "구독 정보가 없는 사내 계정입니다." });
    if (account.is_demo) return res.status(400).json({ error: "체험 환경에서는 결제할 수 없습니다. 회사 가입 뒤 이용해 주세요." });

    // ── 카드 등록: 토스 SDK 가 successUrl 로 돌려준 authKey·customerKey 로 빌링키 발급 ──
    if (action === "issue") {
      const authKey = String(req.body?.authKey || "").trim();
      const customerKey = String(req.body?.customerKey || "").trim();
      if (!authKey || !customerKey) return res.status(400).json({ error: "카드 등록 정보가 없습니다. 다시 시도해 주세요." });
      const billing = await ensureBilling(sb, ownerId);
      if (billing.customer_key !== customerKey) return res.status(400).json({ error: "카드 등록 정보가 이 회사의 것이 아닙니다. 다시 시도해 주세요." });
      let issued;
      try { issued = await tossPost("/billing/authorizations/issue", { authKey, customerKey }); }
      catch (e) {
        await saveBilling(sb, ownerId, { last_error: e.message || "카드 등록 실패" }).catch(() => {});
        return res.status(400).json({ error: e.message || "카드를 등록하지 못했습니다." });
      }
      if (!issued?.billingKey) return res.status(502).json({ error: "결제사에서 빌링키를 받지 못했습니다." });
      const cardLabel = cardLabelFrom(issued);
      await saveBilling(sb, ownerId, { billing_key: issued.billingKey, card_label: cardLabel, last_error: "" });
      await addEvent(sb, ownerId, "note", { memo: `카드 등록 · ${cardLabel}` });
      return res.status(200).json({ ok: true, cardLabel });
    }

    // ── 지금 결제(시작·연장) ──
    if (action === "charge") {
      const plan = String(req.body?.plan || "");
      if (!isPaidPlan(plan)) return res.status(400).json({ error: "요금제를 골라 주세요 (베이직 또는 프로)" });
      const billing = await ensureBilling(sb, ownerId);
      if (!billing.billing_key) return res.status(400).json({ error: "등록된 카드가 없습니다. 카드를 먼저 등록해 주세요." });
      try {
        const r = await chargeWithBillingKey(sb, { account, billing, plan, prices, memo: "카드 결제(화면)" });
        return res.status(200).json(r);
      } catch (e) {
        return res.status(400).json({ error: e.message || "결제에 실패했습니다." });
      }
    }

    // ── 자동 결제 해지(기간은 그대로, 다음 달부터 안 긁음) ──
    if (action === "cancel-auto") {
      const billing = await loadBilling(sb, ownerId);
      if (!billing) return res.status(200).json({ ok: true });
      await saveBilling(sb, ownerId, { plan: null });
      await addEvent(sb, ownerId, "note", { memo: `자동 결제 해지 · ${account.current_period_end ? "남은 기간까지 사용" : ""}`.trim() });
      return res.status(200).json({ ok: true });
    }

    // ── 카드 삭제(자동 결제도 꺼진다) ──
    if (action === "remove-card") {
      const billing = await loadBilling(sb, ownerId);
      if (!billing) return res.status(200).json({ ok: true });
      await saveBilling(sb, ownerId, { billing_key: null, card_label: "", plan: null, last_error: "" });
      await addEvent(sb, ownerId, "note", { memo: "카드 삭제 · 자동 결제 꺼짐" });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (e) {
    console.error("[billing]", action, e?.message || e);
    // saas_billing 표가 아직 없는 DB(saas_features.sql 미적용) → 준비 중으로 보여준다
    if (/saas_billing/.test(String(e?.message || "")) && action === "status") return res.status(200).json(publicBillingStatus({ enabled: false, billing: null, account: null, prices }));
    return res.status(500).json({ error: "결제 처리 중 오류가 났습니다. 잠시 후 다시 시도해 주세요." });
  }
}
