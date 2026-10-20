// 운영자용 기존 데이터 이관 — 고객이 보낸 엑셀(고객·품번·주문)을 그 회사 DB 에 넣는다. 화면이 아니라 운영팀이 대신 해 주는 서비스(사용자 결정 2026-10-20).
//   node ops-import.mjs <login_id> customers|products|orders <파일.xlsx> [--sheet 이름] [--apply] [--prefix LH] [--offline]
// 기본은 dry-run: 파일을 읽고 컬럼을 자동 매핑해 표로 보여주고, 행마다 검증·중복 판정을 해 요약만 찍고 끝난다. DB 에는 아무것도 쓰지 않는다.
// --offline 은 DB 를 읽지도 않는다(회사 확인·중복 판정 생략) — 고객이 보낸 양식이 읽히는지만 볼 때.
// --apply 를 붙였을 때만 service role(.env.local 의 SUPABASE_SERVICE_ROLE_KEY)로 user_id = company_accounts.owner_id 로 insert 한다.
//   주문은 100건씩 끊어 넣고, 모든 행에 time="00:00" 을 남긴다(옛 ExcelImport 와 같은 표시) — 화면의 "엑셀 업로드 묶음"(fetchExcelUploadBatches)이
//   created_at 1분 창으로 묶음을 알아보고, deleteExcelOrdersByRange(처음~마지막 created_at)로 묶음째 지울 수 있다. 로그에 그 범위를 적는다.
// 실행 로그: ops-import-<login_id>-<YYYYMMDD-HHmmss>.log (저장소 루트). 절차·양식은 docs/saas-data-import.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import XLSXpkg from "xlsx";
import { isChannelDummyRow } from "./src/lib/patterns.js";

const XLSX = XLSXpkg.default || XLSXpkg;   // xlsx 는 CommonJS — Node ESM 에서는 default 로 받아야 utils 까지 온다

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ── 인자 ──
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--apply") flags.apply = true;
  else if (a === "--offline") flags.offline = true;   // DB 를 전혀 읽지 않고 파일·매핑·검증만(회사 확인·중복 판정 생략). 양식 점검용
  else if (a === "--sheet") flags.sheet = argv[++i];
  else if (a === "--prefix") flags.prefix = argv[++i];
  else if (a.startsWith("--")) { console.error(`모르는 옵션: ${a}`); process.exit(1); }
  else pos.push(a);
}
const [loginId, kind, file] = pos;
if (!loginId || !["customers", "products", "orders"].includes(kind) || !file) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).slice(0, 8).map(l => l.slice(3)).join("\n"));
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`파일이 없습니다: ${file}`); process.exit(1); }

// ── 로그(콘솔 + 파일) ──
const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
const LOG_PATH = path.join(ROOT, `ops-import-${String(loginId).toLowerCase()}-${stamp()}.log`);
const logLines = [];
const log = (...a) => { const s = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); logLines.push(s); };
const table = (rows) => { console.table(rows); logLines.push(rows.map(r => Object.entries(r).map(([k, v]) => `${k}=${v}`).join("  ")).join("\n")); };
const flush = () => { try { fs.writeFileSync(LOG_PATH, logLines.join("\n") + "\n", "utf8"); } catch (e) { console.error("로그 저장 실패:", e.message); } };
process.on("exit", flush);

// ── Supabase(service role) ──
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)
  .filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const URL = env.VITE_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (flags.apply && flags.offline) { console.error("--apply 와 --offline 은 같이 쓸 수 없습니다"); process.exit(1); }
if (!flags.offline && (!URL || !KEY)) { console.error(".env.local 에 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다"); process.exit(1); }
const sb = flags.offline ? null : createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function account(id) {
  if (flags.offline) return { owner_id: "(offline)", login_id: String(id).toLowerCase(), name: "(offline — 회사 확인 생략)", plan: "-", status: "-" };
  const { data, error } = await sb.from("company_accounts").select("owner_id, login_id, name, plan, status").eq("login_id", String(id || "").toLowerCase()).maybeSingle();
  if (error) throw error;
  if (!data) { console.error(`아이디 '${id}' 회사가 없습니다`); process.exit(1); }
  return data;
}
/** 1000건씩 전부 읽기(Supabase REST 기본 max-rows 우회). offline 이면 빈 목록. */
async function fetchAll(tableName, select, ownerId) {
  if (flags.offline) return [];
  const all = [];
  for (let cursor = 0; ; cursor += 1000) {
    const { data, error } = await sb.from(tableName).select(select).eq("user_id", ownerId).range(cursor, cursor + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ── 엑셀 읽기 ──
const wb = XLSX.read(fs.readFileSync(file), { type: "buffer", cellDates: true });
const sheetName = flags.sheet || wb.SheetNames[0];
const ws = wb.Sheets[sheetName];
if (!ws) { console.error(`시트 '${sheetName}' 가 없습니다. 있는 시트: ${wb.SheetNames.join(", ")}`); process.exit(1); }
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
const isEmptyCell = (c) => c === null || c === undefined || (typeof c === "string" && c.trim() === "");
const isEmptyRow = (r) => !r || r.length === 0 || r.every(isEmptyCell);

// 옛 ExcelImport 의 힌트 + 품번용 힌트. 헤더에 힌트 문자열이 "포함"되면 그 칸(앞 힌트 우선, 정확히 같은 이름 우선).
const HINTS = {
  customers: {
    name: { l: "고객명", req: true, h: ["고객명", "이름", "성명", "입금자명", "name", "customer"] },
    phone: { l: "연락처", h: ["연락처", "전화", "휴대폰", "phone", "tel"] },
    nickname: { l: "닉네임", h: ["닉네임", "별명", "nickname", "alias"] },
    address: { l: "주소", h: ["배송지", "주소", "address"] },
    addressDetail: { l: "상세주소", h: ["상세주소", "상세 주소"] },
    note: { l: "메모", h: ["메모", "비고", "note", "특이"] },
  },
  products: {
    code: { l: "품번", h: ["품번", "코드", "code", "sku"] },
    name: { l: "원단명", req: true, h: ["원단명", "원단", "품명", "상품명", "품목", "name", "fabric"] },
    color: { l: "색상", h: ["색상", "컬러", "색", "color"] },
    unit: { l: "단위", h: ["단위", "unit"] },
    unitPrice: { l: "단가", h: ["단가", "판매가", "가격", "price"] },
    note: { l: "메모", h: ["메모", "비고", "note"] },
  },
  orders: {
    date: { l: "날짜", req: true, h: ["주문일", "날짜", "일자", "date"] },
    customer: { l: "고객명", req: true, h: ["고객명", "입금자명", "고객", "이름", "성명", "name", "customer"] },
    phone: { l: "연락처", h: ["연락처", "전화", "휴대폰", "phone", "tel"] },
    fabric: { l: "원단명", req: true, h: ["원단명", "원단", "품명", "품목", "상품명", "fabric", "item"] },
    color: { l: "색상", h: ["색상", "컬러", "color"] },
    qty: { l: "수량", h: ["수량", "마수", "qty", "quantity"] },
    unitPrice: { l: "단가", h: ["단가", "입고가", "unit price"] },
    amount: { l: "금액", h: ["금액", "매출", "상품금액", "amount", "price"] },
    shippingFee: { l: "배송비", h: ["배송비", "운임비", "운임", "shipping"] },
    totalAmount: { l: "합계", h: ["운임비포함매출", "합계", "총액", "total"] },
    payment: { l: "결제", h: ["결제", "입금", "payment"] },
    status: { l: "상태", h: ["상태", "status"] },
    address: { l: "배송지", h: ["배송지", "주소", "address"] },
    manager: { l: "담당자", h: ["담당자", "담당", "manager"] },
    salesChannel: { l: "판매처", h: ["판매처", "채널", "channel"] },
    note: { l: "메모", h: ["메모", "비고", "note"] },
  },
}[kind];

const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
function autoMap(headers) {
  const used = new Set(), map = {};
  for (const [k, f] of Object.entries(HINTS)) {
    let found = "";
    for (const exact of [true, false]) {
      for (const h of f.h) {
        found = headers.find(c => c && !used.has(c) && (exact ? norm(c) === norm(h) : norm(c).includes(norm(h)))) || "";
        if (found) break;
      }
      if (found) break;
    }
    if (found) { map[k] = found; used.add(found); }
  }
  return map;
}
// 헤더 행: 앞 10행 중 힌트가 가장 많이 맞는 행(마켓원장처럼 안내문이 앞에 있는 경우)
let headerIdx = 0, bestHits = -1;
for (let i = 0; i < Math.min(10, aoa.length); i++) {
  const hs = (aoa[i] || []).map(c => String(c ?? "").trim());
  if (hs.filter(Boolean).length < 2) continue;
  const hits = Object.keys(autoMap(hs)).length;
  if (hits > bestHits) { bestHits = hits; headerIdx = i; }
}
const headers = (aoa[headerIdx] || []).map(c => String(c ?? "").trim());
const rows = aoa.slice(headerIdx + 1).filter(r => !isEmptyRow(r));
const map = autoMap(headers);
const col = (row, k) => { const h = map[k]; const i = h ? headers.indexOf(h) : -1; return i >= 0 ? row[i] : ""; };
const str = (row, k) => String(col(row, k) ?? "").trim();
const num = (row, k) => { const v = col(row, k); if (typeof v === "number") return v; const s = String(v ?? "").replace(/[^0-9.\-]/g, ""); const n = Number(s); return s && Number.isFinite(n) ? n : 0; };

// ── 정규화 ──
const fmtPhone = (raw) => { const d = String(raw ?? "").replace(/\D/g, ""); if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`; if (d.length === 10) return d.startsWith("02") ? `02-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; return d; };
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const p2 = (n) => String(n).padStart(2, "0");
/** 엑셀 날짜 → "YYYY. MM. DD." (ERP 표기). 미래면 작년으로(연도 없는 "12/30" 사례). 못 읽으면 "". */
function toErpDate(v) {
  let y, m, d;
  if (v instanceof Date && !isNaN(v)) { const s = new Date(v.getTime() + 12 * 3600 * 1000); y = s.getFullYear(); m = s.getMonth() + 1; d = s.getDate(); }
  else if (typeof v === "number" && v > 20000) { const u = new Date(Math.round((v - 25569) * 86400 * 1000) + 12 * 3600 * 1000); y = u.getUTCFullYear(); m = u.getUTCMonth() + 1; d = u.getUTCDate(); }
  else {
    const s = String(v ?? "").trim();
    let mt = s.match(/(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/);
    if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = s.match(/^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/))) { y = 2000 + +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = s.match(/^(\d{1,2})[.\-/](\d{1,2})\.?$/))) { y = new Date().getFullYear(); m = +mt[1]; d = +mt[2]; }
    else return "";
  }
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (new Date(y, m - 1, d) > today) y -= 1;
  if (y < 2000 || y > 2099) return "";
  return `${y}. ${p2(m)}. ${p2(d)}.`;
}

// ── 시작 ──
const acct = await account(loginId);
const owner = acct.owner_id;
log(`회사: ${acct.name} (${acct.login_id}) · owner ${owner} · 요금제 ${acct.plan}/${acct.status}`);
log(`파일: ${path.resolve(file)} · 시트 '${sheetName}' · 헤더 ${headerIdx + 1}행 · 데이터 ${rows.length}행 · 모드 ${flags.apply ? "APPLY(실제 저장)" : flags.offline ? "OFFLINE(파일만 검사)" : "DRY-RUN(저장 안 함)"}`);
log(`종류: ${kind}`);
log("\n[컬럼 매핑]");
table(Object.entries(HINTS).map(([k, f]) => ({ 칸: f.l + (f.req ? " *" : ""), 엑셀헤더: map[k] || "(못 찾음)" })));
const missingReq = Object.entries(HINTS).filter(([k, f]) => f.req && !map[k]);
if (missingReq.length) { log(`\n필수 칸을 못 찾았습니다: ${missingReq.map(([, f]) => f.l).join(", ")} — 엑셀 헤더를 양식(docs/saas-data-import.md)에 맞춰 주세요. 헤더: ${headers.filter(Boolean).join(" | ")}`); process.exit(1); }

const problems = [];   // { row, reason }
const toInsert = [];
let dupInDb = 0, dupInFile = 0, dummySkipped = 0, emptySkipped = 0;

if (kind === "customers") {
  const existing = await fetchAll("customers", "id, name, phone", owner);
  const have = new Set(existing.map(c => `${String(c.name || "").trim()}|${digits(c.phone)}`));
  log(`\nDB 의 기존 고객: ${existing.length}명`);
  const seen = new Map();
  rows.forEach((row, i) => {
    const rn = headerIdx + i + 2;
    const name = str(row, "name");
    if (!name) { emptySkipped++; return; }
    if (isChannelDummyRow(name, 0, 0)) { dummySkipped++; return; }
    const phone = fmtPhone(col(row, "phone"));
    const rawPhone = digits(col(row, "phone"));
    if (rawPhone && ![9, 10, 11, 12].includes(rawPhone.length)) problems.push({ row: rn, reason: `연락처 자릿수 이상 '${str(row, "phone")}' (그대로 넣음)` });
    const key = `${name}|${digits(phone)}`;
    if (have.has(key)) { dupInDb++; return; }
    const rec = { user_id: owner, name, phone, nickname: str(row, "nickname"), address: str(row, "address"), address_detail: str(row, "addressDetail"), note: str(row, "note"), total_orders: 0, last_order: null };
    const prev = seen.get(key);
    if (prev) { dupInFile++; for (const k of ["nickname", "address", "address_detail", "note"]) if (!prev[k]) prev[k] = rec[k]; return; }
    seen.set(key, rec); toInsert.push(rec);
  });
} else if (kind === "products") {
  const existing = await fetchAll("products", "id, code, name, color", owner);
  const haveCode = new Set(existing.map(p => norm(p.code)));
  const haveNC = new Set(existing.map(p => `${norm(p.name)}|${norm(p.color)}`));
  log(`\nDB 의 기존 품번: ${existing.length}개`);
  let prefix = flags.prefix || "";
  if (!prefix && !flags.offline) {
    const { data: st } = await sb.from("settings").select("data").eq("user_id", owner).maybeSingle();
    prefix = st?.data?.saas?.productPrefix || "";
  }
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(prefix)) prefix = "LH";
  log(`품번이 비어 있는 행은 next_product_code('${prefix}') 로 발급합니다 (--prefix 로 바꿀 수 있음)`);
  const seenCode = new Set(), seenNC = new Set();
  rows.forEach((row, i) => {
    const rn = headerIdx + i + 2;
    const name = str(row, "name"), color = str(row, "color"), code = str(row, "code");
    if (!name && !code) { emptySkipped++; return; }
    if (!name) { problems.push({ row: rn, reason: "원단명 없음" }); return; }
    const unitPrice = num(row, "unitPrice");
    if (str(row, "unitPrice") && !(unitPrice > 0)) problems.push({ row: rn, reason: `단가를 못 읽음 '${str(row, "unitPrice")}' (비워서 넣음)` });
    const nc = `${norm(name)}|${norm(color)}`;
    if ((code && haveCode.has(norm(code))) || haveNC.has(nc)) { dupInDb++; return; }
    if ((code && seenCode.has(norm(code))) || seenNC.has(nc)) { dupInFile++; return; }
    if (code) seenCode.add(norm(code)); seenNC.add(nc);
    toInsert.push({ user_id: owner, code: code || null, name, color, unit: str(row, "unit") || "마", unit_price: unitPrice > 0 ? unitPrice : null, note: str(row, "note") || null, _prefix: prefix });
  });
} else {
  const existing = await fetchAll("orders", "id, date, customer, items, total_amount", owner);
  // 지문: 날짜|고객|원단|수량|금액 — 기존 주문의 품목마다 하나씩
  const fp = (date, customer, fabric, qty, amount) => `${date}|${norm(customer)}|${norm(fabric)}|${Number(qty) || 0}|${Math.round(Number(amount) || 0)}`;
  const have = new Set();
  for (const o of existing) for (const it of (o.items || [])) have.add(fp(o.date, o.customer, it.fabric, it.qty, it.amount));
  log(`\nDB 의 기존 주문: ${existing.length}건`);
  const seen = new Set();
  rows.forEach((row, i) => {
    const rn = headerIdx + i + 2;
    const customer = str(row, "customer"), fabric = str(row, "fabric");
    const qty = num(row, "qty"), amount = Math.round(num(row, "amount"));
    const dateRaw = col(row, "date");
    if (!customer && !fabric && !dateRaw) { emptySkipped++; return; }
    if (isChannelDummyRow(customer, qty, amount)) { dummySkipped++; return; }
    const date = toErpDate(dateRaw);
    const reasons = [];
    if (!date) reasons.push(`날짜를 못 읽음 '${String(dateRaw)}'`);
    if (!customer) reasons.push("고객명 없음");
    if (!fabric) reasons.push("원단명 없음");
    if (!(qty > 0)) reasons.push("수량 0");
    if (!(amount > 0)) reasons.push("금액 0");
    if (reasons.length) { problems.push({ row: rn, reason: reasons.join(", ") }); return; }
    const key = fp(date, customer, fabric, qty, amount);
    if (have.has(key)) { dupInDb++; return; }
    if (seen.has(key)) { dupInFile++; problems.push({ row: rn, reason: "파일 안에 같은 행(날짜·고객·품목·수량·금액)이 또 있음 — 그래도 넣음" }); }
    seen.add(key);
    // 운임비 칸에 "합배"(합배송) 글자가 있으면 배송비 0 + combined_shipping (옛 ExcelImport 와 같은 규칙)
    const combined = /합배/.test(str(row, "shippingFee"));
    const shippingFee = combined ? 0 : Math.round(num(row, "shippingFee"));
    const totalAmount = Math.round(num(row, "totalAmount")) || amount + shippingFee;
    const pmt = str(row, "payment");
    const payment = !pmt ? "입금완료" : /완료|입금|paid/i.test(pmt) ? "입금완료" : "미입금";
    const stRaw = str(row, "status");
    const status = !stRaw ? "출고완료" : /출고완료|완료|배송/.test(stRaw) ? "출고완료" : /포장/.test(stRaw) ? "포장완료" : "접수";
    toInsert.push({
      user_id: owner, date, time: "00:00", customer, phone: fmtPhone(col(row, "phone")) || null,
      items: [{ itemId: `imp-${Date.now().toString(36)}-${i}`, fabric, color: str(row, "color"), qty, unit: "마", unitPrice: Math.round(num(row, "unitPrice")) || 0, amount }],
      payment, payment_status: payment === "입금완료" ? "paid" : "unpaid",
      address: str(row, "address") || null, note: str(row, "note") || null, status, manager: str(row, "manager"),
      total_amount: totalAmount, shipping_fee: shippingFee, combined_shipping: combined, sales_channel: str(row, "salesChannel"), links: [], images: [],
    });
  });
}

// ── 요약 ──
log("\n[요약]");
log(`넣을 건수: ${toInsert.length}`);
const skippedProblems = problems.filter(p => !/그래도 넣음|그대로 넣음|비워서 넣음/.test(p.reason)).length;
log(`건너뜀: 이미 DB 에 있음 ${dupInDb} · 파일 안 중복 ${dupInFile}${kind === "orders" ? "(넣음)" : ""} · 빈 행 ${emptySkipped} · 정산 더미 행 ${dummySkipped} · 문제로 건너뜀 ${skippedProblems}`);
if (problems.length) {
  log(`\n[문제 행 ${problems.length}건 — 건너뜀 ${skippedProblems} · 경고만(넣음) ${problems.length - skippedProblems}] (엑셀 행 번호)`);
  for (const p of problems.slice(0, 200)) log(`  ${p.row}행: ${p.reason}`);
  if (problems.length > 200) log(`  … ${problems.length - 200}건 더 (로그 파일 참고)`);
}
if (toInsert.length) {
  log("\n[넣을 행 미리보기 (앞 5건)]");
  for (const r of toInsert.slice(0, 5)) { const { user_id, _prefix, ...rest } = r; log("  " + JSON.stringify(rest)); }
}
if (!flags.apply) { log(`\n${flags.offline ? "OFFLINE 끝 — DB 를 읽지 않아 중복 판정은 빠져 있습니다. --offline 없이 돌리면 DB 와 대조합니다." : "DRY-RUN 끝 — 저장하지 않았습니다. 확인했으면 --apply 를 붙여 다시 실행하세요."} 로그: ${LOG_PATH}`); process.exit(0); }
if (!toInsert.length) { log("\n넣을 행이 없습니다."); process.exit(0); }

// ── APPLY ──
log(`\n[APPLY] ${acct.name} 에 ${toInsert.length}건 저장 시작 ${new Date().toISOString()}`);
let inserted = 0, firstAt = null, lastAt = null;
try {
  if (kind === "customers") {
    for (let i = 0; i < toInsert.length; i += 100) {
      const slice = toInsert.slice(i, i + 100);
      const { data, error } = await sb.from("customers").insert(slice).select("id, created_at");
      if (error) throw error;
      inserted += data.length;
      firstAt = firstAt || data[0]?.created_at; lastAt = data[data.length - 1]?.created_at || lastAt;
      log(`  고객 ${inserted}/${toInsert.length}`);
    }
  } else if (kind === "products") {
    for (const r of toInsert) {
      const { _prefix, ...row } = r;
      if (!row.code) {
        const { data: code, error: ce } = await sb.rpc("next_product_code", { p_prefix: _prefix });
        if (ce) throw ce;
        row.code = code;
      }
      const { data, error } = await sb.from("products").insert(row).select("id, code, created_at");
      if (error) throw error;
      inserted++;
      firstAt = firstAt || data[0]?.created_at; lastAt = data[0]?.created_at || lastAt;
      if (inserted % 50 === 0 || inserted === toInsert.length) log(`  품번 ${inserted}/${toInsert.length} (마지막 ${data[0]?.code})`);
    }
  } else {
    const logRows = [];
    for (let i = 0; i < toInsert.length; i += 100) {
      const slice = toInsert.slice(i, i + 100);
      const { data, error } = await sb.from("orders").insert(slice).select("id, customer, total_amount, payment, created_at");
      if (error) throw error;
      inserted += data.length;
      firstAt = firstAt || data[0]?.created_at; lastAt = data[data.length - 1]?.created_at || lastAt;
      for (const r of data) if (r.payment === "입금완료" && (r.total_amount || 0) > 0) logRows.push({ user_id: owner, order_id: r.id, customer: r.customer || "", type: "입금", amount: r.total_amount, note: "엑셀 이관 일괄입금" });
      log(`  주문 ${inserted}/${toInsert.length}`);
    }
    for (let i = 0; i < logRows.length; i += 100) {
      const { error } = await sb.from("payment_logs").insert(logRows.slice(i, i + 100));
      if (error) throw new Error(`주문 ${inserted}건은 저장됐지만 입금 기록(payment_logs) ${i}/${logRows.length}건째에서 실패: ${error.message}`);
    }
    log(`  입금 기록 ${logRows.length}건`);
  }
  log(`\n완료 — ${kind} ${inserted}건 저장. created_at 범위 ${firstAt} ~ ${lastAt}`);
  if (kind === "orders") log(`되돌리기: 화면의 엑셀 업로드 묶음 삭제(이 범위) 또는 deleteExcelOrdersByRange('${firstAt}', '${lastAt}') — time='00:00' 인 행만 지운다.`);
} catch (e) {
  log(`\n실패 — ${inserted}/${toInsert.length}건까지 들어갔습니다. created_at 범위 ${firstAt || "-"} ~ ${lastAt || "-"}`);
  log(`오류: ${e.message || e}${e.details ? ` · ${e.details}` : ""}${e.hint ? ` · ${e.hint}` : ""}`);
  log(`다시 돌리면 이미 들어간 ${inserted}건은 중복 판정으로 건너뜁니다(고객: 이름+전화 / 품번: 코드 또는 이름+색상 / 주문: 날짜+고객+품목 지문).`);
  process.exitCode = 1;
}
log(`로그: ${LOG_PATH}`);
