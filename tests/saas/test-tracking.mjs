// 송장번호 조회 주소·붙여넣기 풀기(src/saas/lib/tracking.js)
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const t = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/tracking.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

check("CJ대한통운 → cjlogistics", t.trackingUrl("CJ대한통운", "1234-5678-9012").includes("cjlogistics.com") && t.trackingUrl("CJ대한통운", "1234-5678-9012").endsWith("123456789012"));
check("롯데·한진·우체국·경동 각각 그 회사 조회", t.trackingUrl("롯데택배", "1").includes("lotteglogis") && t.trackingUrl("한진택배", "1").includes("hanjin") && t.trackingUrl("우체국택배", "1").includes("epost") && t.trackingUrl("경동화물", "1").includes("kdexp"));
check("모르는 택배사 → 네이버 검색", t.trackingUrl("동네택배", "99").startsWith("https://search.naver.com/") && decodeURIComponent(t.trackingUrl("동네택배", "99")).includes("동네택배 99"));
check("송장번호 없으면 빈 글", t.trackingUrl("CJ대한통운", "") === "" && t.trackingUrl("CJ대한통운", " - ") === "");
const p = t.parseTrackingPaste("홍길동 1234-5678-9012\n이몽룡\t5555-6666-7777\n\n짧은줄 12\n402AB619, 123456789");
check("붙여넣기: 고객명/주문번호 + 송장번호, 짧은 번호는 버림", p.length === 3 && p[0].key === "홍길동" && p[0].no === "123456789012" && p[1].key === "이몽룡" && p[1].no === "555566667777" && p[2].key === "402AB619" && p[2].no === "123456789", JSON.stringify(p));

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
