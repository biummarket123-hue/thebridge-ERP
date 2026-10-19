// 한글 두벌식 조합 (lib/hangul.js, 2026-10-15). DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const h = await import(pathToFileURL(path.join(ROOT, "src/lib/hangul.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const eq = (name, got, want) => check(name, got === want, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);

// ── 풀기·만들기 ──
check("decompose: 각 → ㄱ ㅏ ㄱ", JSON.stringify(h.decompose("각")) === JSON.stringify({ cho: "ㄱ", jung: "ㅏ", jong: "ㄱ" }));
check("decompose: 완성 글자가 아니면 null", h.decompose("ㄱ") === null && h.decompose("a") === null && h.decompose("") === null);
eq("compose: ㅇ ㅣ ㄴ → 인", h.compose("ㅇ", "ㅣ", "ㄴ"), "인");
check("compose: 받침이 못 되는 ㄸ 은 null", h.compose("ㄱ", "ㅏ", "ㄸ") === null);

// ── 치기 ──
eq("빈 글에 모음 → 모음만", h.typeJamo("", "ㅏ"), "ㅏ");
eq("빈 글에 자음 → 자음만", h.typeJamo("", "ㄱ"), "ㄱ");
eq("ㄱ + ㅏ → 가", h.typeJamo("ㄱ", "ㅏ"), "가");
eq("가 + ㄱ → 각", h.typeJamo("가", "ㄱ"), "각");
eq("각 + ㅏ → 가가 (받침이 다음 글자로)", h.typeJamo("각", "ㅏ"), "가가");
eq("갑 + ㅅ → 값 (겹받침)", h.typeJamo("갑", "ㅅ"), "값");
eq("값 + ㅏ → 갑사 (겹받침 뒷부분만 넘어감)", h.typeJamo("값", "ㅏ"), "갑사");
eq("고 + ㅏ → 과 (겹모음)", h.typeJamo("고", "ㅏ"), "과");
eq("ㅗ + ㅏ → ㅘ (홀로 있는 모음끼리)", h.typeJamo("ㅗ", "ㅏ"), "ㅘ");
eq("가 + ㄸ → 가ㄸ (받침 못 됨)", h.typeJamo("가", "ㄸ"), "가ㄸ");
eq("각 + ㄱ → 각ㄱ (겹받침 안 됨)", h.typeJamo("각", "ㄱ"), "각ㄱ");
eq("가 + ㅏ → 가ㅏ (겹모음 안 됨)", h.typeJamo("가", "ㅏ"), "가ㅏ");
eq("자모 아닌 글자는 그냥 붙는다", h.typeJamo("가", "1"), "가1");
eq("공백 뒤 자음은 새 글자", h.typeJamo("가 ", "ㄱ"), "가 ㄱ");
eq("영문 뒤 모음은 그냥 붙는다", h.typeJamo("a", "ㅏ"), "aㅏ");

// ── 이름 치기 ──
eq("이인희", h.typeText("", "ㅇㅣㅇㅣㄴㅎㅢ"), "이인희");
eq("한상경", h.typeText("", "ㅎㅏㄴㅅㅏㅇㄱㅕㅇ"), "한상경");
eq("워싱린넨", h.typeText("", "ㅇㅜㅓㅅㅣㅇㄹㅣㄴㄴㅔㄴ"), "워싱린넨");
eq("옛 재고 (띄어쓰기 포함)", h.typeText("", "ㅇㅖㅅ ㅈㅐㄱㅗ"), "옛 재고");
eq("없음 (겹받침 ㅄ)", h.typeText("", "ㅇㅓㅂㅅㅇㅡㅁ"), "없음");
eq("닭 (겹받침 ㄺ)", h.typeText("", "ㄷㅏㄹㄱ"), "닭");

// ── 지우기 ──
eq("각 ← 가", h.backspace("각"), "가");
eq("가 ← ㄱ", h.backspace("가"), "ㄱ");
eq("ㄱ ← 빈 글", h.backspace("ㄱ"), "");
eq("값 ← 갑 (겹받침 뒷부분만)", h.backspace("값"), "갑");
eq("과 ← 고 (겹모음 뒷부분만)", h.backspace("과"), "고");
eq("ㅘ ← ㅗ", h.backspace("ㅘ"), "ㅗ");
eq("가1 ← 가", h.backspace("가1"), "가");
eq("빈 글은 그대로", h.backspace(""), "");
eq("치고 지우면 되돌아간다", h.backspace(h.typeJamo("인", "ㅎ")), "인");

const fails = results.filter(x => !x).length;
console.log(`\n${results.length - fails}/${results.length} 통과`);
process.exit(fails ? 1 : 0);
