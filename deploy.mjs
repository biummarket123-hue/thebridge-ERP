// 운영 배포 한 줄: npm run deploy
//   1) vercel --prod --yes  (이 폴더는 .vercel/project.json 으로 thebridge-erp 에 연결돼 있다)
//   2) 출력의 Production 주소를 erp.thebridge.ai.kr 에 alias
// 왜 2) 가 필요한가: 이 프로젝트의 커스텀 도메인은 2026-04 에 특정 배포에 고정(alias)돼 있어서
// --prod 로 올려도 도메인이 자동으로 따라오지 않았다(2026-10-19 확인). Git 자동 배포도 끊겨 있다.
// 사전 조건: vercel CLI 설치(npm i -g vercel) + vercel login.
import { spawnSync } from "node:child_process";

const DOMAIN = process.env.DEPLOY_DOMAIN || "erp.thebridge.ai.kr";
const run = (args) => {
  const r = spawnSync(["vercel", ...args].join(" "), { stdio: ["inherit", "pipe", "inherit"], shell: true, encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) { console.error(`\nvercel ${args.join(" ")} 실패 (exit ${r.status})`); process.exit(r.status || 1); }
  return r.stdout || "";
};

console.log("1/2 운영 배포 중…");
const out = run(["--prod", "--yes"]);
const m = out.match(/Production\s+(https:\/\/[^\s]+\.vercel\.app)/) || out.match(/"url":\s*"(https:\/\/[^"]+)"/);
if (!m) { console.error("배포 주소를 출력에서 찾지 못했습니다. 위 출력의 Production 주소로 직접: vercel alias set <주소> " + DOMAIN); process.exit(1); }
const url = m[1];
console.log(`\n2/2 ${DOMAIN} → ${url}`);
run(["alias", "set", url, DOMAIN]);
console.log(`\n완료: https://${DOMAIN}`);
