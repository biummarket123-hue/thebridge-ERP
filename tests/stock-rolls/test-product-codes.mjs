// 로하톡 글 → 품번 붙이기 (lib/productCodes.js, 2026-10-08). DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pc = await import(pathToFileURL(path.join(ROOT, "src/lib/productCodes.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const products = [
  { id: "p1", code: "S-2610-0005", name: "린넨코튼", color: "베이지" },
  { id: "p2", code: "A-2610-0006", name: "쉬폰", color: "네이비" },
  { id: "p3", code: "LH-2610-0002", name: "테스트 린넨", color: "베이지" },
];

// ── 찾기 ──
check("찾기: 새 품번 꼴만, 대문자로, 중복 제거", pc.findProductCodes("s-2610-0005 린넨 / A-001 옛번호 / S-2610-0005 또").join() === "S-2610-0005");
check("찾기: 옛 아이템 번호(A-001)·전화번호(010-1234-5678)는 안 잡힘", pc.findProductCodes("A-001 010-1234-5678 2026-10-08").length === 0);
check("찾기: 10000 번째(5자리)도 잡힘", pc.findProductCodes("LH-2610-10000").join() === "LH-2610-10000");

// ── 다듬기 ──
check("다듬기: 원단명(품번) → 품번 원단명", pc.normalizeProductCodes("김고객 린넨코튼(s-2610-0005) 3마") === "김고객 S-2610-0005 린넨코튼 3마");
check("다듬기: 대괄호도", pc.normalizeProductCodes("쉬폰 [A-2610-0006] 2마") === "A-2610-0006 쉬폰 2마");
check("다듬기: 품번만 괄호에 → 괄호 벗김", pc.normalizeProductCodes("(S-2610-0005) 3마") === "S-2610-0005 3마");
check("다듬기: 소문자 품번 → 대문자, 나머지는 그대로", pc.normalizeProductCodes("s-2610-0005 린넨코튼 베이지 3마 @5,500") === "S-2610-0005 린넨코튼 베이지 3마 @5,500");
check("다듬기: 빈 글", pc.normalizeProductCodes("") === "" && pc.normalizeProductCodes(null) === null);
check("다듬기: 롤 번호 붙은 품번(S-2610-0005-R01) → 품번만", pc.normalizeProductCodes("s-2610-0005-r01 린넨코튼 (베이지) 5마") === "S-2610-0005 린넨코튼 (베이지) 5마", pc.normalizeProductCodes("s-2610-0005-r01 린넨코튼 (베이지) 5마"));

// ── 롤 번호 떼기 (2026-10-15 — 로하톡에 롤 라벨 코드를 그대로 적은 주문이 포장대 스캔에서 안 잡혔다) ──
check("baseProductCode: 롤 번호를 뗀다·대문자", pc.baseProductCode("s-2610-0010-r01") === "S-2610-0010" && pc.baseProductCode(" S-2610-0010-R12 ") === "S-2610-0010");
check("baseProductCode: 롤 번호 없으면 그대로(대문자), 빈 값은 빈 글", pc.baseProductCode("lh-2610-10000") === "LH-2610-10000" && pc.baseProductCode("") === "" && pc.baseProductCode(null) === "");
check("baseProductCode: 품번 꼴이 아니면 안 건드린다", pc.baseProductCode("A-001-R01") === "A-001-R01" && pc.baseProductCode("S-2610-0010-RX") === "S-2610-0010-RX");
check("productByCode: 롤 번호 붙은 코드로도 품번을 찾는다", pc.productByCode(products, "S-2610-0005-R02")?.id === "p1" && pc.productByCode(products, "S-2610-0005-R02 ")?.id === "p1");
check("productByCode: 다른 품번은 안 잡힌다", pc.productByCode(products, "S-2610-0006-R01") === null);
let outR = pc.attachProductCodes("S-2610-0005-R01 린넨코튼 5마", [{ itemNo: "S-2610-0005-R01", fabric: "린넨코튼", qty: 5 }], products);
check("붙이기: AI 가 롤 코드를 품번으로 읽어도 itemNo 는 등록 품번으로", outR[0].itemNo === "S-2610-0005", outR[0].itemNo);
outR = pc.fillPriceFromProduct([{ itemNo: "S-2610-0005-R01", fabric: "린넨코튼", qty: 5, unitPrice: 0, amount: 0 }], [{ ...products[0], unitPrice: 3500 }]);
check("단가 채우기: 롤 코드 itemNo 도 productId·품번이 맞춰진다", outR[0].productId === "p1" && outR[0].itemNo === "S-2610-0005" && outR[0].unitPrice === 3500 && outR[0].amount === 17500, JSON.stringify(outR[0]));

// ── 붙이기 ──
const text = `김고객 010-1234-5678
S-2610-0005 린넨코튼 베이지 3마
쉬폰 네이비 2마 (A-2610-0006)
입금완료`;
const items = [
  { itemNo: null, fabric: "린넨코튼", color: "베이지", qty: 3 },
  { itemNo: "", fabric: "쉬폰", color: "네이비", qty: 2 },
];
let out = pc.attachProductCodes(text, items, products);
check("붙이기: 같은 줄의 품번을 품목에", out[0].itemNo === "S-2610-0005" && out[1].itemNo === "A-2610-0006", JSON.stringify(out.map(i => i.itemNo)));
check("붙이기: 원본 배열은 안 바꾼다", items[0].itemNo === null);

out = pc.attachProductCodes("s-2610-0005 3마", [{ itemNo: "s-2610-0005", fabric: "", qty: 3 }], products);
check("붙이기: AI 가 소문자로 준 itemNo 는 대문자로 맞추고, 빈 원단명은 품번에서 채운다", out[0].itemNo === "S-2610-0005" && out[0].fabric === "린넨코튼" && out[0].color === "베이지");

out = pc.attachProductCodes("S-2610-0005 3마\nA-2610-0006 2마", [{ fabric: "린넨", qty: 3 }, { fabric: "쉬폰", qty: 2 }], products);
check("붙이기: 줄에서 못 찾아도 품번 수 = 품목 수면 순서대로", out[0].itemNo === "S-2610-0005" && out[1].itemNo === "A-2610-0006");

out = pc.attachProductCodes("S-2610-0005 3마\nA-2610-0006 2마", [{ fabric: "린넨", qty: 3 }, { fabric: "쉬폰", qty: 2 }, { fabric: "면", qty: 1 }], products);
check("붙이기: 수가 다르면 순서로 넘겨짚지 않는다", out.every(i => !i.itemNo));

out = pc.attachProductCodes("Z-2610-9999 린넨코튼 3마", [{ fabric: "린넨코튼", qty: 3 }], products);
check("붙이기: 등록되지 않은 품번(오타)은 안 붙인다", !out[0].itemNo);

out = pc.attachProductCodes("S-2610-0005 린넨코튼 3마\nS-2610-0005 린넨코튼 2마", [{ fabric: "린넨코튼", qty: 3 }, { fabric: "린넨코튼", qty: 2 }], products);
check("붙이기: 같은 품번 두 줄 → 둘 다 붙는다", out[0].itemNo === "S-2610-0005" && out[1].itemNo === "S-2610-0005");

// ── 이름 대조 ──
const p1 = products[0];
check("대조: 같은 이름 → 괜찮음", !pc.codeNameMismatch({ fabric: "린넨코튼", color: "베이지" }, p1));
check("대조: 띄어쓰기·색상 포함 → 괜찮음", !pc.codeNameMismatch({ fabric: "린넨 코튼 베이지" }, p1) && !pc.codeNameMismatch({ fabric: "린넨코튼" }, p1));
check("대조: 품번만 적어 이름이 비면 → 괜찮음", !pc.codeNameMismatch({ fabric: "" }, p1));
check("대조: 다른 이름(숫자 틀린 품번) → 다름", pc.codeNameMismatch({ fabric: "쉬폰", color: "네이비" }, p1));

// ── 단가 채우기 ──
const prodsP = [{ id: "p1", code: "LH-2610-0005", name: "테스트 원단", color: "", unitPrice: 5000 }, { id: "p2", code: "S-2610-0006", name: "쉬폰", color: "", unitPrice: null }];
let fp = pc.fillPriceFromProduct([{ itemNo: "lh-2610-0005", fabric: "테스트 원단", qty: 5, amount: 0, unitPrice: 0 }], prodsP);
check("단가: 품번이 맞고 단가가 비면 품번 단가·금액(5000×5)을 채우고 productId·대문자 품번", fp[0].unitPrice === 5000 && fp[0].amount === 25000 && fp[0].productId === "p1" && fp[0].itemNo === "LH-2610-0005", JSON.stringify(fp[0]));
fp = pc.fillPriceFromProduct([{ itemNo: "LH-2610-0005", fabric: "테스트 원단", qty: 5, amount: 20000, unitPrice: 4000 }], prodsP);
check("단가: 적은 단가·금액이 있으면 그대로(세일가)", fp[0].unitPrice === 4000 && fp[0].amount === 20000);
fp = pc.fillPriceFromProduct([{ itemNo: "LH-2610-0005", fabric: "테스트원단", qty: 5, amount: 0, unitPrice: 0 }], prodsP);
check("단가: 원단명은 적은 그대로(대조용)", fp[0].fabric === "테스트원단");
fp = pc.fillPriceFromProduct([{ itemNo: "S-2610-0006", fabric: "쉬폰", qty: 2, amount: 0, unitPrice: 0 }, { itemNo: "", fabric: "면", qty: 1, amount: 0, unitPrice: 0 }], prodsP);
check("단가: 품번 단가가 없거나 품번이 없으면 안 건드린다", fp[0].unitPrice === 0 && fp[0].productId === "p2" && fp[1].unitPrice === 0 && !fp[1].productId);

check("복사 줄: 품번 원단명 색상", pc.productLineText(p1) === "S-2610-0005 린넨코튼 베이지" && pc.productLineText({ code: "X", name: "면" }) === "X 면");

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
