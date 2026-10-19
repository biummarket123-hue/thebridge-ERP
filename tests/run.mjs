// npm test — tests/ 아래의 test-*.mjs 를 차례로 돈다. 하나라도 실패하면 1 로 끝난다.
//
// 이 테스트들은 실제 DB 를 쓰지 않는다. PGlite(메모리 Postgres)에 마이그레이션을 돌리고,
// supabase-js 를 흉내(fake-supabase.mjs)로 바꿔 끼워 src/lib 의 앱 코드를 그대로 부른다.
// 그래서 Supabase 없이, 인터넷 없이 돈다. 처음 한 번은 `npm install` 이 필요하다(@electric-sql/pglite).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];   // npm test -- packing  → 이름에 'packing' 이 든 것만

const files = [];
for (const dir of fs.readdirSync(HERE, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(HERE, dir.name))) {
    if (/^test-.*\.mjs$/.test(f) && (!only || f.includes(only))) files.push(path.join(dir.name, f));
  }
}
if (!files.length) { console.error("돌릴 테스트가 없습니다"); process.exit(1); }

let failed = 0;
for (const f of files) {
  console.log(`\n━━ ${f} ━━`);
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n${files.length - failed}/${files.length} 파일 통과`);
process.exit(failed ? 1 : 0);
