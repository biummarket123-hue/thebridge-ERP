// 프롬프트 캐시 규칙(api/_ai_cache.js) — DB·SDK 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const c = await import(pathToFileURL(path.join(ROOT, "api/_ai_cache.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const s1 = c.withPromptCache("공통 지시문");
check("문자열 system → 블록 하나 + 캐시 표시", Array.isArray(s1) && s1.length === 1 && s1[0].type === "text" && s1[0].text === "공통 지시문" && s1[0].cache_control?.type === "ephemeral", JSON.stringify(s1));

const s2 = c.withPromptCache([{ type: "text", text: "공통" }, { type: "text", text: "부록" }]);
check("블록 배열 → 첫 블록에만 표시(부록은 그대로)", s2.length === 2 && s2[0].cache_control?.type === "ephemeral" && !s2[1].cache_control && s2[1].text === "부록", JSON.stringify(s2));

check("빈 system 은 undefined", c.withPromptCache("") === undefined && c.withPromptCache("   ") === undefined && c.withPromptCache([]) === undefined && c.withPromptCache(undefined) === undefined);
check("이미 표시가 있으면 그대로", (() => { const r = c.withPromptCache([{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }]); return r[0].cache_control.ttl === "1h"; })());
check("이상한 블록(글 없음)은 버린다", c.withPromptCache([{ type: "text", text: "" }, null, { text: "b" }]).length === 1);
check("원본 배열을 바꾸지 않는다", (() => { const src = [{ type: "text", text: "a" }]; c.withPromptCache(src); return !src[0].cache_control; })());

const u1 = c.cacheSummary({ input_tokens: 420, cache_read_input_tokens: 5012, cache_creation_input_tokens: 0, output_tokens: 380 });
check("usage 요약: 적중", u1.hit && u1.read === 5012 && u1.text.startsWith("캐시 적중"), u1.text);
const u2 = c.cacheSummary({ input_tokens: 420, cache_creation_input_tokens: 5012, output_tokens: 380 });
check("usage 요약: 저장", !u2.hit && u2.wrote === 5012 && u2.text.startsWith("캐시 저장"), u2.text);
check("usage 요약: 없음·빈 값", !c.cacheSummary().hit && c.cacheSummary({}).text.startsWith("캐시 없음"));

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
