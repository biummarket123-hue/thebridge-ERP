// 빈 Supabase 프로젝트용 "한 번에 붙여 넣는" SQL 을 만든다: migrations/_saas_fresh_db_all.sql
// 순서는 migrations/fresh_db_order.mjs 가 단일 출처. 실행: node scripts-build-fresh-db.mjs
// (tests/saas/test-fresh-db.mjs 가 이 산출물이 최신인지도 검사한다 — 파일을 고쳤으면 다시 돌릴 것)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FRESH_DB_ORDER } from "./migrations/fresh_db_order.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function buildFreshDbSql(root = ROOT) {
  const parts = [`-- ============================================================
-- ERP SaaS — 빈 Supabase 프로젝트 전체 스키마 (자동 생성: node scripts-build-fresh-db.mjs)
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run. ${FRESH_DB_ORDER.length}개 파일을 검증된 순서로 이어 붙였다.
-- 빈 DB 전용. 표가 이미 있는 프로젝트는 먼저 migrations/_saas_reset_public.sql 로 비운다.
-- 각 조각의 출처는 아래 "-- FILE:" 머리말. 손으로 고치지 말고 원본 파일을 고친 뒤 다시 생성할 것.
-- ============================================================
`];
  for (const f of FRESH_DB_ORDER) {
    parts.push(`\n\n-- ────────────────────────────────────────────────────────────\n-- FILE: ${f}\n-- ────────────────────────────────────────────────────────────\n`);
    parts.push(fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n"));
  }
  return parts.join("");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(ROOT, "migrations/_saas_fresh_db_all.sql");
  fs.writeFileSync(out, buildFreshDbSql());
  console.log(`${path.relative(ROOT, out)}  (${FRESH_DB_ORDER.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}
