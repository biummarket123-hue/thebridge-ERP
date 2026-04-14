import { supabase } from "./supabase.js";

// ── company 모드: Supabase Auth 자동 로그인 ──────────────────
const isCompanyMode = import.meta.env.VITE_MODE === "company";
const COMPANY_EMAIL = "company@thebridge.erp";
const COMPANY_PASS  = "company_bridge_2026";

let _companyUserId = null;

async function ensureCompanyAuth() {
  if (_companyUserId) return _companyUserId;
  try {
    // 1) 기존 세션 확인
    const { data: { session } } = await supabase.auth.getSession();
    if (session) { _companyUserId = session.user.id; return _companyUserId; }

    // 2) 로그인 시도
    const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({
      email: COMPANY_EMAIL, password: COMPANY_PASS,
    });
    if (signIn?.session) { _companyUserId = signIn.session.user.id; return _companyUserId; }

    // 3) 유저 없으면 회원가입
    console.log("[company-auth] 로그인 실패, 회원가입 시도:", signInErr?.message);
    const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
      email: COMPANY_EMAIL, password: COMPANY_PASS,
    });
    if (signUp?.session) { _companyUserId = signUp.session.user.id; return _companyUserId; }

    // 4) 이메일 인증 없이 재로그인
    if (signUp?.user) {
      const { data: retry } = await supabase.auth.signInWithPassword({
        email: COMPANY_EMAIL, password: COMPANY_PASS,
      });
      if (retry?.session) { _companyUserId = retry.session.user.id; return _companyUserId; }
    }

    console.error("[company-auth] 모든 인증 실패:", signUpErr?.message);
    return null;
  } catch (e) {
    console.error("[company-auth] 예외:", e);
    return null;
  }
}

// ── 현재 로그인 사용자 id 조회 (멀티테넌트 격리용) ────────────
async function getUserId() {
  if (isCompanyMode) return ensureCompanyAuth();
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id || null;
  } catch {
    return null;
  }
}

// ── helpers: snake_case <-> camelCase ─────────────────────────
const toCamel = (row) => ({
  id: row.id,
  date: row.date,
  time: row.time,
  customer: row.customer,
  phone: row.phone,
  items: row.items || [],
  payment: row.payment,
  address: row.address,
  addressDetail: row.address_detail,
  links: row.links || [],
  note: row.note,
  status: row.status,
  manager: row.manager,
});

const toLogCamel = (row) => ({
  id: row.id,
  date: row.date,
  time: row.time,
  type: row.type,
  itemNo: row.item_no,
  fabric: row.fabric,
  color: row.color,
  qty: row.qty,
  costPrice: row.cost_price,
  ref: row.ref,
  note: row.note,
});

const toCustCamel = (row) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  address: row.address,
  totalOrders: row.total_orders,
  lastOrder: row.last_order,
  note: row.note,
});

const toDepositCamel = (row) => ({
  id: row.id,
  customer: row.customer,
  phone: row.phone,
  content: row.content,
  total: row.total,
  deposit: row.deposit,
  depositDate: row.deposit_date,
  balancePaid: row.balance_paid,
  balanceDate: row.balance_date,
  regDate: row.reg_date,
  note: row.note,
});

// ── Orders ────────────────────────────────────────────────────
export async function fetchOrders() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toCamel);
}

export async function insertOrder(order) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("orders").insert({
    user_id: userId,
    date: order.date,
    time: order.time,
    customer: order.customer,
    phone: order.phone || null,
    items: order.items || [],
    payment: order.payment || "미입금",
    address: order.address || null,
    address_detail: order.addressDetail || null,
    links: order.links || [],
    note: order.note || null,
    status: order.status || "접수",
    manager: order.manager || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toCamel(data[0]) : null;
}

export async function updateOrder(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("orders")
    .update(fields)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteOrder(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Inventory ─────────────────────────────────────────────────
export async function fetchInventory() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("inventory")
    .select("*")
    .eq("user_id", userId)
    .order("id");
  if (error) throw error;
  return data || [];
}

export async function updateInventoryItem(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("inventory")
    .update(fields)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function insertInventoryItem(item) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("inventory").insert({
    user_id: userId,
    fabric: item.fabric,
    color: item.color || "",
    stock: item.stock,
  }).select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function deleteInventoryItem(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("inventory")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Customers ─────────────────────────────────────────────────
export async function fetchCustomers() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("user_id", userId)
    .order("id");
  if (error) throw error;
  return (data || []).map(toCustCamel);
}

export async function insertCustomer(c) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("customers").insert({
    user_id: userId,
    name: c.name,
    phone: c.phone || "",
    address: c.address || "",
    total_orders: c.totalOrders || 0,
    last_order: c.lastOrder || null,
    note: c.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toCustCamel(data[0]) : null;
}

export async function updateCustomer(id, c) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("customers").update({
    name: c.name,
    phone: c.phone || "",
    address: c.address || "",
    total_orders: c.totalOrders || 0,
    last_order: c.lastOrder || null,
    note: c.note || "",
  })
    .eq("id", id)
    .eq("user_id", userId)
    .select();
  if (error) throw error;
  return data?.[0] ? toCustCamel(data[0]) : null;
}

export async function deleteCustomer(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("customers")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Logs ──────────────────────────────────────────────────────
export async function fetchLogs() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toLogCamel);
}

export async function insertLog(log) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("logs").insert({
    user_id: userId,
    date: log.date,
    time: log.time,
    type: log.type,
    item_no: log.itemNo || "",
    fabric: log.fabric,
    color: log.color || "",
    qty: log.qty || 0,
    cost_price: log.costPrice || 0,
    ref: log.ref || "",
    note: log.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toLogCamel(data[0]) : null;
}

export async function deleteLog(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("logs")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Managers ──────────────────────────────────────────────────
export async function fetchManagers() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("managers")
    .select("*")
    .eq("user_id", userId)
    .order("id");
  if (error) throw error;
  return (data || []).map((m) => m.name);
}

export async function addManager(name) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("managers")
    .insert({ user_id: userId, name });
  if (error && error.code !== "23505") throw error;
}

export async function removeManager(name) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("managers")
    .delete()
    .eq("name", name)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Settings (per-user) ───────────────────────────────────────
export async function fetchSettings() {
  const userId = await getUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("settings")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data?.data || null;
}

export async function saveSettings(settings) {
  const userId = await getUserId();
  if (!userId) return; // 로그인 전/체험판에서는 무시
  const { error } = await supabase.from("settings").upsert(
    {
      user_id: userId,
      data: settings,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// ── Deposits (계약금/잔금) ────────────────────────────────────
export async function fetchDeposits() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("deposits")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toDepositCamel);
}

export async function insertDeposit(d) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("deposits").insert({
    user_id: userId,
    customer: d.customer,
    phone: d.phone || "",
    content: d.content || "",
    total: d.total || 0,
    deposit: d.deposit || 0,
    deposit_date: d.depositDate || "",
    balance_paid: !!d.balancePaid,
    balance_date: d.balanceDate || "",
    reg_date: d.regDate || "",
    note: d.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toDepositCamel(data[0]) : null;
}

export async function updateDeposit(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if ("customer" in fields) row.customer = fields.customer;
  if ("phone" in fields) row.phone = fields.phone;
  if ("content" in fields) row.content = fields.content;
  if ("total" in fields) row.total = fields.total;
  if ("deposit" in fields) row.deposit = fields.deposit;
  if ("depositDate" in fields) row.deposit_date = fields.depositDate;
  if ("balancePaid" in fields) row.balance_paid = fields.balancePaid;
  if ("balanceDate" in fields) row.balance_date = fields.balanceDate;
  if ("regDate" in fields) row.reg_date = fields.regDate;
  if ("note" in fields) row.note = fields.note;
  const { error } = await supabase
    .from("deposits")
    .update(row)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteDeposit(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("deposits")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Bulk: 본인 데이터만 초기화 ────────────────────────────────
export async function clearAllData() {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  await supabase.from("orders").delete().eq("user_id", userId);
  await supabase.from("logs").delete().eq("user_id", userId);
  await supabase.from("customers").delete().eq("user_id", userId);
  await supabase.from("deposits").delete().eq("user_id", userId);
}
