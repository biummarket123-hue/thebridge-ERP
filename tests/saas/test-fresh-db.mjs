// 새 SaaS Supabase 프로젝트를 "빈 DB 에서" 만드는 순서(docs/saas-db-setup.md)를 PGlite 로 검증한다.
//  · saas_init_schema.sql → migrations/ 기능별 파일 → saas_company_accounts → saas_readonly 가 그 순서로 에러 없이 돌고
//  · 전부 두 번 돌려도 안전하며
//  · 끝난 스키마에 db.js 가 select/row 로 읽는 칸이 전부 있어야 한다(칸 누락 = 화면이 조용히 비는 원인)
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FRESH_DB_ORDER = [
  "migrations/saas_init_schema.sql",
  "migrations/add_stock_rolls.sql",
  "migrations/add_product_manager.sql",
  "migrations/add_item_packing.sql",
  "migrations/add_roll_pieces.sql",
  "migrations/add_manager_flags.sql",
  "migrations/add_packer_flag.sql",
  "migrations/add_customer_address_detail.sql",
  "migrations/add_customer_address2.sql",
  "migrations/add_delivery_message.sql",
  "migrations/add_delivery_message_presets.sql",
  "migrations/add_fabric_missing.sql",
  "migrations/add_held_at.sql",
  "migrations/add_merge_group.sql",
  "migrations/add_orders_images.sql",
  "migrations/add_other_cost.sql",
  "migrations/add_packed_at.sql",
  "migrations/add_parked.sql",
  "migrations/add_receipt_issued.sql",
  "migrations/add_receipt_type.sql",
  "migrations/add_ship_date.sql",
  "migrations/add_ship_request.sql",
  "migrations/add_shipped_at.sql",
  "migrations/add_shipping_fee_held.sql",
  "migrations/add_refund_request.sql",
  "migrations/add_refund_history.sql",
  "migrations/add_credits_order_id.sql",
  "migrations/add_credits_manager_memo.sql",
  "migrations/add_order_events.sql",
  "migrations/add_order_events_retention.sql",
  "migrations/add_order_notes.sql",
  "migrations/add_order_notes_customer.sql",
  "migrations/add_note_reactions.sql",
  "migrations/add_notices.sql",
  "migrations/add_order_returns.sql",
  "migrations/alter_order_returns_exchange.sql",
  "migrations/alter_order_returns_exchange_items.sql",
  "migrations/add_label_printed.sql",
  "migrations/add_label_request.sql",
  "migrations/add_label_station.sql",
  "migrations/add_thanks_label.sql",
  "migrations/add_link_order_drafts.sql",
  "migrations/add_link_drafts_offer.sql",
  "migrations/add_link_drafts_credit.sql",
  "migrations/saas_company_accounts.sql",
  "migrations/saas_readonly_when_expired.sql",
];

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const U1 = "11111111-1111-1111-1111-111111111111";
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  insert into auth.users values ('${U1}', 'test@thebridge.erp');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.email() returns text language sql stable as $$ select '' $$;
  create role authenticated; create role anon; create role service_role;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create publication supabase_realtime;
`);

// 누락 파일 확인
const missing = FRESH_DB_ORDER.filter(f => !fs.existsSync(path.join(ROOT, f)));
check("0. 순서에 적힌 파일이 전부 있음", missing.length === 0, missing.join(", "));
const listed = new Set(FRESH_DB_ORDER.map(f => path.basename(f)));
const unlisted = fs.readdirSync(path.join(ROOT, "migrations")).filter(f => f.endsWith(".sql") && !listed.has(f));
check("0b. migrations/ 의 모든 파일이 순서에 들어 있음", unlisted.length === 0, unlisted.join(", "));

// 1회차
let firstFail = null;
for (const f of FRESH_DB_ORDER) {
  try { await db.exec(fs.readFileSync(path.join(ROOT, f), "utf8")); }
  catch (e) { firstFail = `${f}: ${e.message}`; break; }
}
check("1. 빈 DB 에 순서대로 전부 실행", !firstFail, firstFail);

// 2회차(재실행 안전)
let secondFail = null;
if (!firstFail) {
  for (const f of FRESH_DB_ORDER) {
    try { await db.exec(fs.readFileSync(path.join(ROOT, f), "utf8")); }
    catch (e) {
      // 옛 기능 파일 몇 개는 realtime publication 등록을 if 없이 한다 — 두 번째 실행에서 그 한 줄만 막힌다. 해롭지 않다.
      if (/already member of publication/.test(e.message)) continue;
      secondFail = `${f}: ${e.message}`; break;
    }
  }
}
check("2. 같은 순서로 다시 실행해도 에러 없음(publication 중복 등록은 무해)", !firstFail && !secondFail, secondFail);

// 3. db.js 가 읽는 칸이 전부 있는가
const cols = new Map();
for (const r of (await db.query(`select table_name, column_name from information_schema.columns where table_schema='public'`)).rows) {
  if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
  cols.get(r.table_name).add(r.column_name);
}
const src = fs.readFileSync(path.join(ROOT, "src/lib/db.js"), "utf8");
const need = new Map();
const add = (t, c) => { if (!need.has(t)) need.set(t, new Set()); need.get(t).add(c); };
// .from("t") … .select("a, b, c")
// 같은 체인 안의 select 만 — 중간에 다른 .from( 이 나오면 다른 쿼리다
const re = /\.from\("(\w+)"\)((?:(?!\.from\()[\s\S]){0,400}?)\.select\(\s*"([^"]*)"/g;
let m;
while ((m = re.exec(src))) {
  for (let c of m[3].split(",")) {
    c = c.trim();
    if (!c || c === "*" || c.includes("(") || c.startsWith("count")) continue;
    add(m[1], c.replace(/::.*$/, "").split(":").pop().trim());
  }
}
// orders 의 toCamel(row.xxx)
const tc0 = src.indexOf("const toCamel = (row) =>");
const toCamelBody = src.slice(tc0, src.indexOf("\n});", tc0));
for (const r of toCamelBody.matchAll(/row\.([a-z_]+)/g)) add("orders", r[1]);
const missingCols = [];
for (const [t, cs] of need) {
  if (!cols.has(t)) { missingCols.push(`${t}(표 없음)`); continue; }
  for (const c of cs) if (!cols.get(t).has(c)) missingCols.push(`${t}.${c}`);
}
check(`3. db.js 가 읽는 ${[...need.values()].reduce((n, s) => n + s.size, 0)}개 칸이 전부 존재`, missingCols.length === 0, missingCols.join(", "));

// 4. 회사 격리·구독 함수가 살아 있음
if (firstFail) { console.log("(마이그레이션 실패로 4단계 생략)"); process.exit(1); }
await db.exec(`set test.uid = '${U1}'`);
const tables = (await db.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map(r => r.tablename);
const noRls = (await db.query(`select tablename from pg_tables where schemaname='public' and not rowsecurity`)).rows.map(r => r.tablename);
check(`4a. public 표 ${tables.length}개 전부 RLS 켜짐`, noRls.length === 0, noRls.join(", "));
check("4b. is_company_active() 가 행 없는 회사에 참", (await db.query(`select is_company_active() a`)).rows[0].a === true);
await db.exec(`insert into managers (user_id, name, is_admin) values ('${U1}', '관리자', true)`);
const mid = (await db.query(`select id from managers limit 1`)).rows[0].id;
const pin = (await db.query(`select set_manager_pin($1, '1234') r`, [mid])).rows[0].r;
check("4c. 담당자 PIN 설정 RPC 동작", pin.ok === true, JSON.stringify(pin));
const code = (await db.query(`select next_product_code() c`)).rows[0].c;
check("4d. 품번 채번 RPC 동작", /^[A-Z]+-\d{4}-\d{4}$/.test(code), code);

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
