// ERP 일일 정합성 검사 — 읽기 전용.
//
// 이 파일의 모든 supabase 호출은 select / count 뿐이다. insert · update · delete · upsert · rpc(쓰기)
// 는 어떤 경우에도 넣지 않는다. 감시 에이전트는 "보고"만 하고 "고치지" 않는다.
//
// 각 검사는 { key, title, count, items: string[], note? } 를 돌려준다.
//   count : 이상 건수 (0 이면 정상)
//   items : 상위 5건 요약. 고객명 + 건수/금액까지만 — 전화번호·주소·메모는 절대 넣지 않는다.
//           (이 문자열이 그대로 텔레그램으로 나간다)

import { createHash } from "node:crypto";

const PAGE = 1000;
const TOP = 5;

// 검사에서 빼는 고객 — 운영 데이터가 아니라 손으로 굴려 보는 계정이다.
// "테스트" 는 배송권 use/restore 를 수십 번 오가며 만든 이중복원 +1 을 늘 달고 있어
// 매일 같은 이상으로 올라온다. 새 이름이 생기면 이 배열에만 넣으면 된다.
// 행수 검사(3번)에는 적용하지 않는다 — 그쪽은 테이블 전체 규모를 보는 눈금이라
// 몇 행 빼면 오히려 급증 판정 기준이 흐려진다.
export const EXCLUDED_CUSTOMERS = ["테스트"];
const EXCLUDED = new Set(EXCLUDED_CUSTOMERS);
const isExcluded = (name) => EXCLUDED.has(String(name || "").trim());
// 보고 메시지에 한 줄로 남긴다 — 조용히 빼면 나중에 왜 안 잡히는지 헷갈린다.
const EXCLUDED_NOTE = EXCLUDED_CUSTOMERS.length
  ? `${EXCLUDED_CUSTOMERS.join("·")} 고객 ${EXCLUDED_CUSTOMERS.length}명 제외`
  : "";

// 페이지 단위로 전부 읽는다. Supabase 는 기본 1000행 상한이라 range 로 끊어 읽어야 전수가 된다.
async function fetchAll(supabase, table, columns, userId, orderBy = null) {
  const rows = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select(columns).eq("user_id", userId).range(from, from + PAGE - 1);
    if (orderBy) q = q.order(orderBy, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

const fmtN = (n) => Number(n || 0).toLocaleString("ko-KR");

// ── 1. 배송권 정합성 ─────────────────────────────────────────────
// 고객별 free_shipping_logs 를 모아 두 가지를 본다.
//   a) restore 횟수 > use 횟수 : 쓴 것보다 더 많이 복원됨 (이중 복원 의심)
//   b) coupons.count ≠ Σ(logs.count) : 보유 테이블과 원장이 어긋남
export async function checkFreeShipping(supabase, userId) {
  const [logs, coupons] = await Promise.all([
    fetchAll(supabase, "free_shipping_logs", "customer,type,count", userId),
    fetchAll(supabase, "free_shipping_coupons", "customer,count", userId),
  ]);
  const agg = {};
  for (const l of logs) {
    if (isExcluded(l.customer)) continue;
    const a = (agg[l.customer] ||= { use: 0, restore: 0, sum: 0 });
    if (l.type === "use") a.use++;
    else if (l.type === "restore") a.restore++;
    a.sum += Number(l.count || 0);
  }
  const held = {};
  for (const c of coupons) { if (isExcluded(c.customer)) continue; held[c.customer] = Number(c.count || 0); }

  const overRestore = Object.entries(agg)
    .filter(([, a]) => a.restore > a.use)
    .map(([customer, a]) => ({ customer, diff: a.restore - a.use, use: a.use, restore: a.restore }))
    .sort((x, y) => y.diff - x.diff);

  // 원장이 있는 고객은 원장 합과, 원장이 없는데 보유만 있는 고객은 0과 비교한다.
  const names = new Set([...Object.keys(agg), ...Object.keys(held)]);
  const mismatch = [];
  for (const customer of names) {
    const sum = agg[customer]?.sum ?? 0;
    const actual = held[customer] ?? 0;
    if (sum !== actual) mismatch.push({ customer, actual, sum, diff: actual - sum });
  }
  mismatch.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  const items = [
    ...overRestore.slice(0, TOP).map((r) => `이중복원 ${r.customer}: use ${r.use} / restore ${r.restore} (+${r.diff})`),
    ...mismatch.slice(0, TOP).map((r) => `불일치 ${r.customer}: 보유 ${r.actual} vs 원장합 ${r.sum}`),
  ].slice(0, TOP);

  return {
    key: "free_shipping",
    title: "배송권 정합성",
    count: overRestore.length + mismatch.length,
    items,
    note: `이중복원 ${overRestore.length}명 · 보유≠원장 ${mismatch.length}명 (원장 ${fmtN(logs.length)}건, 보유 ${fmtN(coupons.length)}명${EXCLUDED_NOTE ? " · " + EXCLUDED_NOTE : ""})`,
  };
}

// ── 2. 적립금 정합성 ─────────────────────────────────────────────
// 고객별 credits 합(적립 − 사용)이 음수인 고객.
// 그리고 환불 사유 행에서 같은 (customer, reason, amount) 가 2건 이상인 고객 — F1 패턴.
// 예전 deleteCreditsByReason 이 이 키로 지워서 환불취소 한 번에 여러 행이 날아갈 수 있었다.
// 코드는 고쳐졌지만 데이터가 그 모양으로 계속 쌓이는지는 지켜본다 (참고용 경고).
const REFUND_REASONS = ["환불→적립금 전환", "환불로 복원"];

export async function checkCredits(supabase, userId) {
  const credits = await fetchAll(supabase, "credits", "customer,type,amount,reason", userId);
  const bal = {};
  const keyCount = {};
  for (const c of credits) {
    if (isExcluded(c.customer)) continue;
    const amt = Number(c.amount || 0);
    bal[c.customer] = (bal[c.customer] || 0) + (c.type === "적립" ? amt : -amt);
    if (REFUND_REASONS.includes(c.reason)) {
      // 키는 JSON 배열 문자열 — 구분자를 따로 두지 않으므로 고객명이나 사유에
      // 어떤 문자가 들어와도 다른 조합과 겹칠 수 없다. 예전엔 NUL 바이트로 이었는데
      // 그 바이트 때문에 git·grep 이 이 파일을 바이너리로 보고 diff 를 안 보여줬다.
      const k = JSON.stringify([c.customer, c.reason, amt]);
      keyCount[k] = (keyCount[k] || 0) + 1;
    }
  }
  const negative = Object.entries(bal)
    .filter(([, b]) => b < 0)
    .map(([customer, b]) => ({ customer, balance: b }))
    .sort((x, y) => x.balance - y.balance);
  const dup = Object.entries(keyCount)
    .filter(([, n]) => n >= 2)
    .map(([k, n]) => { const [customer, reason, amount] = JSON.parse(k); return { customer, reason, amount, n }; })
    .sort((x, y) => y.n - x.n || y.amount - x.amount);

  const items = [
    ...negative.slice(0, TOP).map((r) => `음수잔액 ${r.customer}: ${fmtN(r.balance)}원`),
    ...dup.slice(0, TOP).map((r) => `F1패턴 ${r.customer}: ${r.reason} ${fmtN(r.amount)}원 × ${r.n}건`),
  ].slice(0, TOP);

  return {
    key: "credits",
    title: "적립금 정합성",
    count: negative.length + dup.length,
    items,
    note: `음수잔액 ${negative.length}명 · F1패턴 ${dup.length}건 (원장 ${fmtN(credits.length)}행${EXCLUDED_NOTE ? " · " + EXCLUDED_NOTE : ""})`,
  };
}

// ── 3. 테이블 행수 급증/급감 ─────────────────────────────────────
// 각 테이블의 행수를 세고 지난 실행(state.counts)과 비교한다.
//   급증 : 하루 증가분이 +500 이상, 또는 최근 증가분 평균의 3배 이상(평균이 잡혀 있고 20건 이상일 때)
//   급감 : 하루에 50행 이상 줄어듦 (감시 대상은 원장류라 대량 삭제가 더 위험하다)
// 첫 실행은 기준이 없으니 기록만 한다.
export const COUNT_TABLES = ["orders", "customers", "payment_logs", "credits", "logs", "free_shipping_logs", "order_notes"];
const SPIKE_ABS = 500;
const SPIKE_RATIO = 3;
const SPIKE_MIN = 20;
const DROP_ABS = 50;
const HISTORY_KEEP = 14;

export async function countTables(supabase, userId) {
  const counts = {};
  for (const t of COUNT_TABLES) {
    const { count, error } = await supabase.from(t).select("*", { count: "exact", head: true }).eq("user_id", userId);
    if (error) throw new Error(`${t} 행수 조회 실패: ${error.message}`);
    counts[t] = count ?? 0;
  }
  return counts;
}

// state: { counts: {table: n}, history: {table: number[]}, at: iso } | null
// 돌려주는 값에 nextState 를 같이 실어 run.mjs 가 저장한다 (파일 저장은 run.mjs 몫).
export function compareCounts(counts, state) {
  const prev = state?.counts || null;
  const history = { ...(state?.history || {}) };
  const spikes = [];
  if (prev) {
    for (const t of COUNT_TABLES) {
      if (typeof prev[t] !== "number") continue;
      const delta = counts[t] - prev[t];
      const past = (history[t] || []).filter((d) => d > 0);
      const avg = past.length ? past.reduce((s, d) => s + d, 0) / past.length : null;
      let why = null;
      if (delta >= SPIKE_ABS) why = `+${fmtN(delta)} (하루 +${SPIKE_ABS} 이상)`;
      else if (avg !== null && delta >= SPIKE_MIN && delta >= avg * SPIKE_RATIO) why = `+${fmtN(delta)} (평소 ${avg.toFixed(1)}의 ${(delta / avg).toFixed(1)}배)`;
      else if (delta <= -DROP_ABS) why = `${fmtN(delta)} (하루 ${DROP_ABS}행 이상 감소)`;
      if (why) spikes.push({ table: t, delta, why, prev: prev[t], now: counts[t] });
      history[t] = [...(history[t] || []), delta].slice(-HISTORY_KEEP);
    }
  }
  spikes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const items = spikes.slice(0, TOP).map((s) => `${s.table}: ${fmtN(s.prev)} → ${fmtN(s.now)} ${s.why}`);
  const summary = COUNT_TABLES.map((t) => `${t} ${fmtN(counts[t])}`).join(" / ");
  return {
    key: "row_counts",
    title: "테이블 행수",
    count: spikes.length,
    items,
    note: prev ? summary : `첫 실행 — 기준 기록만 (${summary})`,
    summary,
    nextState: { counts, history, at: new Date().toISOString() },
  };
}

// ── 4. 중복 고객 ─────────────────────────────────────────────────
// 전화번호(숫자만 남김)가 같은데 이름이 다른 고객 묶음. 전화번호 없는 고객은 제외.
//
// 지난 실행보다 '늘어난' 묶음만 보고한다. 예전 고객 정리 때 일부러 남긴 묶음이 50개 넘게
// 있어서 전부 보고하면 매일 같은 소음이 된다. 기준은 state.dupPairs — 번호를 그대로 두지 않고
// sha256 해시로 저장한다(상태 파일이 CI 캐시에 남으므로). 첫 실행은 기준 기록만.
export async function checkDuplicateCustomers(supabase, userId, state) {
  const customers = await fetchAll(supabase, "customers", "name,phone", userId);
  const byPhone = {};
  for (const c of customers) {
    if (isExcluded(c.name)) continue;
    const digits = String(c.phone || "").replace(/\D/g, "");
    if (digits.length < 9) continue; // 비었거나 번호라 보기 어려운 값
    (byPhone[digits] ||= new Set()).add(String(c.name || "").trim());
  }
  const groups = Object.entries(byPhone)
    .map(([digits, names]) => ({ hash: createHash("sha256").update(digits).digest("hex").slice(0, 16), names: [...names].filter(Boolean) }))
    .filter((g) => g.names.length >= 2)
    .sort((x, y) => y.names.length - x.names.length);
  const nowPairs = groups.map((g) => g.hash).sort();

  const prev = Array.isArray(state?.dupPairs) ? new Set(state.dupPairs) : null;
  const added = prev ? groups.filter((g) => !prev.has(g.hash)) : [];
  const removed = prev ? [...prev].filter((h) => !nowPairs.includes(h)).length : 0;

  // 전화번호는 메시지에 싣지 않는다 — 같은 번호라는 사실과 이름 묶음만.
  const items = added.slice(0, TOP).map((g) => `새 묶음: ${g.names.slice(0, 4).join(" · ")}${g.names.length > 4 ? ` 외 ${g.names.length - 4}` : ""}`);
  const base = `현재 ${groups.length}묶음 (고객 ${fmtN(customers.length)}명, 전화번호 있는 고객 기준${EXCLUDED_NOTE ? " · " + EXCLUDED_NOTE : ""})`;
  return {
    key: "dup_customers",
    title: "중복 고객(전화 같고 이름 다름) — 증가분",
    count: added.length,
    items,
    note: prev ? `${base} · 지난번보다 +${added.length} / −${removed}` : `첫 실행 — 기준 기록만 (${base})`,
    nextState: { dupPairs: nowPairs },
  };
}
