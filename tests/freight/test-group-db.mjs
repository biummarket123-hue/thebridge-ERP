// 3단계 — 합배송 규칙을 DB 계층(db.afterGroupChange·applyGroupFreight)까지 돌려 본다.
// 지시서 5절 3~7번을 코드 경로로 확인한다(화면 버튼은 사람이 누른다). PGlite + fake-supabase.
import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FAKE = path.join(ROOT, "tests", "stock-rolls", "fake-supabase.mjs").replace(/\\/g, "/");
const U1 = "11111111-1111-1111-1111-111111111111";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const pg = new PGlite();
globalThis.__pg = pg;
globalThis.__uid = U1;
await pg.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  insert into auth.users values ('${U1}');
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('test.uid', true), '')::uuid $$;
  create table orders (
    id uuid primary key default gen_random_uuid(), user_id uuid, date text, time text, customer text, phone text,
    items jsonb default '[]', payment text, address text, address_detail text, delivery_message text, links jsonb default '[]',
    note text, status text, manager text, total_amount numeric, shipping_fee numeric, shipping_fee_held numeric, combined_payment boolean,
    combined_shipping boolean, deposit_amount numeric, balance_amount numeric, refund_amount numeric, refund_note text,
    payment_status text, sales_channel text, images jsonb default '[]', receipt_type text, receipt_issued boolean,
    memo text, other_cost numeric, free_shipping_used boolean, ship_date text, is_urgent boolean, courier text,
    merge_group_id text, split_shipping boolean default false,
    packed_at timestamptz, packed_sig text, shipped_at timestamptz, shipped_via text, is_holding boolean, held_at timestamptz,
    is_parked boolean, parked_at timestamptz, park_reason text, ship_requested_at timestamptz, ship_requested_by text,
    fabric_missing boolean, fabric_missing_items jsonb default '[]', fabric_missing_at timestamptz,
    last_actor text, last_route text, last_actor_at timestamptz, created_at timestamptz default now());
  set test.uid = '${U1}';
`);

const { createServer } = await import(pathToFileURL(`${ROOT}/node_modules/vite/dist/node/index.js`).href);
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: "error", appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
  optimizeDeps: { disabled: true },
  plugins: [{
    name: "fake-supabase", enforce: "pre",
    resolveId(src, importer) {
      if (/(^|\/)supabase\.js$/.test(src) && importer && /\/src\/lib\//.test(importer.replace(/\\/g, "/"))) return FAKE;
    },
  }],
});
const db = await vite.ssrLoadModule("/src/lib/db.js");
const fake = await import(pathToFileURL(FAKE).href);
const sql = async (q, p) => (await pg.query(q, p)).rows;
const row = async (id) => (await sql("select shipping_fee::int fee, shipping_fee_held::int held, ship_date, is_urgent, merge_group_id gid from orders where id=$1", [id]))[0];

// 주문 만들기 — 등록 순서를 created_at 으로 못 박는다(같은 ms 에 들어가도 순서가 흔들리지 않게).
let seq = 0;
async function mk({ fee = 0, payment = "미입금", shipDate = null, isUrgent = false, gid = null, free = false }) {
  const o = await db.insertOrder({ date: "2026-10-01", time: "09:00", customer: `고객${++seq}`, items: [{ fabric: "린넨", qty: 2 }],
    payment, shippingFee: fee, shipDate, isUrgent, freeShippingUsed: free });
  await sql("update orders set created_at = $2, merge_group_id = $3 where id = $1", [o.id, `2026-10-01T00:00:${String(seq).padStart(2, "0")}Z`, gid]);
  return { ...o, createdAt: `2026-10-01T00:00:${String(seq).padStart(2, "0")}Z`, mergeGroupId: gid, payment, shippingFee: fee, shipDate, isUrgent, freeShippingUsed: free };
}
const opts = { paymentStatusOf: o => o.payment };
const updates = () => fake.calls.filter(c => c.op === "update" || /update/.test(String(c.sql || c.op || ""))).length;

// ── 기준 3·4: 묶기 → 출고일은 늦은 날, 택배비는 한 건만 ──
{
  const A = await mk({ fee: 4000, shipDate: "2026-10-02" });
  const B = await mk({ fee: 4000, shipDate: "2026-10-05" });
  const res = await db.afterGroupChange([A, B], { ...opts, route: "테스트 묶기" });
  const a = await row(A.id), b = await row(B.id);
  check("3. 묶으면 두 건 모두 출고일 10/5(늦은 날)", a.ship_date === "2026-10-05" && b.ship_date === "2026-10-05" && res.dateChanged, JSON.stringify({ a, b }));
  check("3. 택배비는 먼저 등록된 A 에만 4,000 — B 는 0", a.fee === 4000 && b.fee === 0 && res.freight.bearerId === A.id, JSON.stringify({ a, b }));
  check("3. 반환값으로 화면 반영 가능(ids·shipDate·freight.changes)", res.ids.length === 2 && res.shipDate === "2026-10-05" && res.freight.changes.length === 1);
  const n0 = fake.calls.length;
  const again = await db.afterGroupChange([{ ...A, shipDate: "2026-10-05", shippingFee: 4000 }, { ...B, shipDate: "2026-10-05", shippingFee: 0 }], opts);
  check("3+. 이미 규칙대로면 DB 요청을 보내지 않는다", fake.calls.length === n0 && again.freight.changes.length === 0 && !again.dateChanged, `calls +${fake.calls.length - n0}`);

  // 긴급이 섞이면 긴급 유지
  const U = await mk({ fee: 0, shipDate: "2026-10-01", isUrgent: true });
  const V = await mk({ fee: 0, shipDate: "2026-10-07" });
  const r2 = await db.afterGroupChange([U, V], opts);
  const u = await row(U.id), v = await row(V.id);
  check("3+. 긴급 포함 묶음 → 둘 다 긴급·10/7, 택배비는 0+0 그대로", u.is_urgent === true && v.is_urgent === true && v.ship_date === "2026-10-07" && u.fee === 0 && v.fee === 0, JSON.stringify({ u, v, r2 }));
}

// ── 기준 5: 그룹 해제 → 풀린 주문의 택배비는 그대로(새로 붙이지 않는다), 입금완료 주문도 그대로 ──
{
  const P = await mk({ fee: 4000, payment: "입금완료", gid: "g5" });   // 부담자(입금 끝)
  const Q = await mk({ fee: 0, payment: "미입금", gid: "g5" });
  const R = await mk({ fee: 0, payment: "입금완료", gid: "g5" });      // 0원으로 입금 끝난 건
  // Q 가 그룹에서 빠진다 → Q 혼자 1건 그룹, 남은 [P, R] 재계산
  await db.clearMergeGroup(Q.id);
  await db.afterGroupChange([{ ...Q, mergeGroupId: null }], opts);
  await db.afterGroupChange([P, R], opts);
  const p = await row(P.id), q = await row(Q.id), r = await row(R.id);
  check("5. 풀린 미입금 Q 는 0 인 채로", q.fee === 0 && q.gid === null, JSON.stringify(q));
  check("5. 입금완료 P(4,000)·R(0) 은 그대로", p.fee === 4000 && r.fee === 0, JSON.stringify({ p, r }));
  // 입금완료 0원 건이 혼자 남아도 안 건드린다
  await db.afterGroupChange([R], opts);
  check("5+. 입금완료 0원 건이 혼자 남아도 바꾸지 않는다", (await row(R.id)).fee === 0);
  // 무료배송권 건이 혼자 남으면 0 유지
  const F = await mk({ fee: 0, free: true });
  await db.afterGroupChange([F], opts);
  check("5+. 무료배송권 건은 혼자 남아도 0 유지", (await row(F.id)).fee === 0);
}

// ── 기준 6: 그룹에서 1건만 출고(나머지 미입금) → 남은 건은 그대로 ──
{
  const S = await mk({ fee: 4000, payment: "입금완료", gid: "g6", shipDate: "2026-10-03" });
  const T = await mk({ fee: 0, payment: "미입금", gid: "g6", shipDate: "2026-10-03" });
  // S 가 나갔다(출고완료). 남은 미출고 멤버 [T] 로 재계산 — ErpApp.settleGroupId 가 하는 일.
  await sql("update orders set status='출고완료' where id=$1", [S.id]);
  const remaining = [T].filter(o => o.status !== "출고완료");
  const res = await db.afterGroupChange(remaining, opts);
  const s = await row(S.id), t = await row(T.id);
  check("6. 남은 미입금 T 는 0 인 채로", t.fee === 0 && res.freight.bearerId === null, JSON.stringify(t));
  check("6. 나간 S(입금완료 4,000)는 그대로", s.fee === 4000, JSON.stringify(s));
  check("6. 1건 그룹은 출고일을 건드리지 않는다", t.ship_date === "2026-10-03" && !res.dateChanged);
}

// ── 기준 7: 운임비 조정으로 사람이 정한 값은 재계산이 덮지 않는다 ──
{
  const X = await mk({ fee: 4000, gid: "g7" });
  const Y = await mk({ fee: 0, gid: "g7" });
  // FreightModal 이 하는 일: 멤버 전부 0, 고른 1건만 n (경동 7,000 을 Y 에게)
  await db.updateOrder(X.id, { shipping_fee: 0 });
  await db.updateOrder(Y.id, { shipping_fee: 7000 });
  // 그 뒤 어떤 이유로 재계산이 돌아도(예: 같은 그룹에 Z 가 더 붙음) 사람이 정한 부담자·금액은 유지된다
  const Z = await mk({ fee: 4000, gid: "g7" });
  await db.afterGroupChange([{ ...X, shippingFee: 0 }, { ...Y, shippingFee: 7000 }, Z], opts);
  const x = await row(X.id), y = await row(Y.id), z = await row(Z.id);
  check("7. 사람이 정한 Y 7,000 유지, 새로 붙은 Z 는 0", y.fee === 7000 && x.fee === 0 && z.fee === 0, JSON.stringify({ x, y, z }));
}

// ── 1e 를 DB 에서: 입금완료 2건이 각각 들고 있으면 변경 없이 conflict ──
{
  const M = await mk({ fee: 4000, payment: "입금완료", gid: "g8" });
  const N = await mk({ fee: 4000, payment: "입금완료", gid: "g8" });
  const n0 = fake.calls.length;
  const res = await db.applyGroupFreight([M, N], opts);
  check("1e(DB). conflict 면 DB 에 아무것도 안 쓴다", res.conflict && fake.calls.length === n0 && (await row(M.id)).fee === 4000 && (await row(N.id)).fee === 4000);
}

// ── 택배비가 자동으로 바뀌면 전체금액(total_amount)도 같은 차액만큼 DB 에 쓴다 ──
{
  const tot = async (id) => Number((await sql("select total_amount::int t from orders where id=$1", [id]))[0].t);
  const A = await mk({ fee: 4000 }), B = await mk({ fee: 4000 });
  await sql("update orders set total_amount = 24000 where id = $1", [A.id]);
  await sql("update orders set total_amount = 34000 where id = $1", [B.id]);
  const res = await db.afterGroupChange([{ ...A, totalAmount: 24000 }, { ...B, totalAmount: 34000 }], opts);
  check("T(DB). 묶여서 0원이 된 B 는 전체금액 34,000→30,000, A 는 그대로", (await row(B.id)).fee === 0 && (await tot(B.id)) === 30000 && (await tot(A.id)) === 24000, JSON.stringify(res.freight));
  check("T(DB). B 가 내려놓은 4,000 이 DB 에 적힌다(shipping_fee_held)", (await row(B.id)).held === 4000 && (await row(A.id)).held === null);
  // B 가 풀려 혼자 남으면 적어 둔 택배비와 전체금액이 같이 돌아온다
  const bNow = (await db.fetchOrdersByIds([B.id]))[0];
  check("T(DB). 다시 읽은 주문에 feeHeld 가 실려 온다", bNow.feeHeld === 4000 && bNow.shippingFee === 0, JSON.stringify({ feeHeld: bNow.feeHeld }));
  await db.afterGroupChange([bNow], opts);
  check("T(DB). 풀리면 4,000·34,000 으로 되돌아오고 적어 둔 값은 비워진다", (await row(B.id)).fee === 4000 && (await tot(B.id)) === 34000 && (await row(B.id)).held === null);
  // 원래 택배비가 없던 주문은 풀려도 없는 그대로
  const Z0 = await mk({ fee: 0 });
  await db.afterGroupChange([Z0], opts);
  check("T(DB). 원래 0원이던 주문은 혼자 남아도 0", (await row(Z0.id)).fee === 0);
}

// ── add_shipping_fee_held.sql 을 안 돌린 DB — 그 칸만 빼고 저장한다(내리기는 되고, 되돌리기만 안 된다) ──
{
  await sql("alter table orders drop column shipping_fee_held");
  const A = await mk({ fee: 4000 }), B = await mk({ fee: 4000 });
  await db.afterGroupChange([A, B], opts);
  const b = (await sql("select shipping_fee::int fee from orders where id=$1", [B.id]))[0];
  check("칸 없음. 묶으면 택배비는 여전히 한 건만 남는다(저장이 막히지 않는다)", b.fee === 0, JSON.stringify(b));
  await sql("alter table orders add column shipping_fee_held numeric");
}

// ── shippingFee(camel) 가 updateOrdersBulk 를 지나 shipping_fee 로 저장된다 ──
{
  const W = await mk({ fee: 0 });
  await db.updateOrdersBulk([W.id], { shippingFee: 2500 });
  check("db. updateOrdersBulk 의 shippingFee → shipping_fee", (await row(W.id)).fee === 2500);
}

await vite.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
