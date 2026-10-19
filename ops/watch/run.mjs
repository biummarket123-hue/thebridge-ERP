// ERP 감시 진입점.
//
//   node ops/watch/run.mjs             정식 실행 — 이상이 있으면 텔레그램, 없으면 침묵(월요일엔 한 줄)
//   node ops/watch/run.mjs --dry-run   텔레그램 전송 없이 결과를 stdout 에 찍고 상태 파일도 건드리지 않음
//
// 환경변수(GitHub Secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COMPANY_AUTH_EMAIL,
//                           TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// 로컬에선 process.env 에 없는 값만 .env.local 에서 채운다 (SUPABASE_URL 이 없으면 VITE_SUPABASE_URL).
//
// 이 프로그램은 DB 에 아무것도 쓰지 않는다. 쓰는 곳은 ops/watch/last-counts.json(행수 기준) 하나뿐이다.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkFreeShipping, checkCredits, countTables, compareCounts, checkDuplicateCustomers } from "./checks.mjs";
import { sendTelegram, sanitize } from "./notify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "last-counts.json");
const DRY = process.argv.includes("--dry-run");
const FORCE_WEEKLY = process.argv.includes("--weekly"); // 월요일 한 줄 보고를 손으로 확인할 때

// ── 환경변수 ────────────────────────────────────────────────────
function loadEnv() {
  const env = { ...process.env };
  const local = join(__dirname, "..", "..", ".env.local");
  if (existsSync(local)) {
    for (const line of readFileSync(local, "utf-8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!env[k]) env[k] = v;
    }
  }
  return {
    url: env.SUPABASE_URL || env.VITE_SUPABASE_URL,
    key: env.SUPABASE_SERVICE_ROLE_KEY,
    email: env.COMPANY_AUTH_EMAIL,
    tgToken: env.TELEGRAM_BOT_TOKEN,
    tgChat: env.TELEGRAM_CHAT_ID,
  };
}

// ── 시각(KST) ───────────────────────────────────────────────────
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    stamp: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`,
    isMonday: d.getUTCDay() === 1,
  };
}

function readState() {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf-8")) : null; }
  catch { return null; } // 깨진 파일은 첫 실행처럼 취급
}
function writeState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n"); }

async function deliver(cfg, text) {
  if (DRY) { console.log("\n───── 텔레그램으로 나갈 내용 (dry-run, 전송 안 함) ─────\n" + sanitize(text)); return; }
  await sendTelegram({ token: cfg.tgToken, chatId: cfg.tgChat, text });
}

// ── 본체 ────────────────────────────────────────────────────────
async function main() {
  const cfg = loadEnv();
  const { stamp, isMonday } = kstNow();
  const missing = [["SUPABASE_URL", cfg.url], ["SUPABASE_SERVICE_ROLE_KEY", cfg.key], ["COMPANY_AUTH_EMAIL", cfg.email]]
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`환경변수 없음: ${missing.join(", ")}`);
  if (!DRY && (!cfg.tgToken || !cfg.tgChat)) throw new Error("환경변수 없음: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");

  const supabase = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });

  // 회사 계정의 user_id — 모든 테이블이 user_id 로 나뉘어 있어 이 값이 있어야 우리 데이터만 본다.
  let userId = null;
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`사용자 목록 조회 실패: ${error.message}`);
    userId = data.users.find((u) => u.email === cfg.email)?.id || null;
    if (data.users.length < 200) break;
  }
  if (!userId) throw new Error("COMPANY_AUTH_EMAIL 에 해당하는 계정이 없습니다");

  const state = readState();

  // 검사 하나가 터져도 나머지는 돈다. 터진 검사는 그 자체가 '이상 1건'으로 보고된다.
  const runners = [
    () => checkFreeShipping(supabase, userId),
    () => checkCredits(supabase, userId),
    async () => compareCounts(await countTables(supabase, userId), state),
    () => checkDuplicateCustomers(supabase, userId, state),
  ];
  const results = [];
  for (const r of runners) {
    try { results.push(await r()); }
    catch (e) { results.push({ key: "failed", title: "검사 실패", count: 1, items: [sanitize(e?.message || String(e))], failed: true }); }
  }

  // stdout 요약 — Actions 로그와 로컬 dry-run 모두 여기서 본다
  console.log(`ERP 감시 · ${stamp} · 검사 ${results.length}항목`);
  for (const r of results) {
    console.log(`\n[${r.count === 0 ? "정상" : "이상 " + r.count + "건"}] ${r.title}${r.note ? " — " + r.note : ""}`);
    for (const it of r.items) console.log("  · " + it);
  }

  const issues = results.filter((r) => r.count > 0);
  const rowCounts = results.find((r) => r.key === "row_counts");
  // 상태 파일은 검사들이 내놓은 nextState 조각(행수·중복고객 기준)을 합친 것이다.
  // 어떤 검사가 터져 조각을 못 내면 그 부분은 지난 값을 그대로 둔다.
  const nextState = {
    ...(state || {}),
    ...Object.assign({}, ...results.map((r) => r.nextState || {})),
    lastIssueAt: issues.length ? new Date().toISOString() : state?.lastIssueAt || null,
  };

  if (issues.length) {
    const lines = [`🚨 ERP 감시 · ${stamp} · 검사 ${results.length}항목 중 ${issues.length}항목 이상`];
    for (const r of issues) {
      lines.push("", `■ ${r.title} — ${r.count}건${r.note ? ` (${r.note})` : ""}`);
      for (const it of r.items) lines.push(`  · ${it}`);
      if (r.count > r.items.length) lines.push(`  … 외 ${r.count - r.items.length}건`);
    }
    await deliver(cfg, lines.join("\n"));
  } else if (isMonday || FORCE_WEEKLY) {
    const last = state?.lastIssueAt ? new Date(state.lastIssueAt) : null;
    const quietWeek = !last || Date.now() - last.getTime() > 7 * 86400 * 1000;
    const head = quietWeek ? "지난주 정상" : `지난주 이상 보고 있었음(${state.lastIssueAt.slice(0, 10)})`;
    await deliver(cfg, `✅ ERP 감시 · ${stamp} · 검사 ${results.length}항목 · ${head}, 현재 행수: ${rowCounts?.summary || "-"}`);
  } else {
    console.log("\n이상 없음 — 텔레그램 전송 안 함");
  }

  if (!DRY && nextState) writeState(nextState);
  else if (DRY) console.log("\n(dry-run: last-counts.json 저장 안 함)");
}

main().catch(async (e) => {
  // 조용히 죽지 않는다 — 실행 실패 자체를 보고하고, 종료 코드로 Actions 도 빨갛게 만든다.
  const msg = `⛔ ERP 감시 실행 실패 · ${kstNow().stamp}\n${sanitize(e?.message || String(e))}`;
  console.error(msg);
  if (!DRY) {
    try { const cfg = loadEnv(); await sendTelegram({ token: cfg.tgToken, chatId: cfg.tgChat, text: msg }); }
    catch (e2) { console.error("실패 보고 전송도 실패:", sanitize(e2?.message || String(e2))); }
  }
  process.exit(1);
});
