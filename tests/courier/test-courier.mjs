// 택배사 판정(src/lib/courier.js) — 직접 지정 → 메모의 '롤' → CJ. 배송비는 안 본다(2026-10-12 사용자 결정).
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const C = await import(pathToFileURL(path.join(ROOT, "src", "lib", "courier.js")).href);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const o = (id, extra = {}) => ({ id, shippingFee: 0, note: "", memo: "", ...extra });

// 배송비는 택배사와 무관
const m1 = C.courierMap([o("a", { shippingFee: 7000 }), o("b", { shippingFee: 20000 }), o("c", { shippingFee: 0 })]);
check("배송비 7,000·20,000·0 — 전부 CJ(why default)", ["a", "b", "c"].every(id => m1.get(id).courier === C.CJ && m1.get(id).why === "default"));
check("courierMap 결과에 fee 칸 없음", !("fee" in m1.get("a")));

// 메모의 '롤'
const m2 = C.courierMap([o("r1", { note: "롤발송" }), o("r2", { memo: "1롤 보내주세요" }), o("r3", { deliveryMessage: "롤로 주세요" }), o("r4", { note: "스크롤 컨트롤 캐롤" })]);
check("일반 메모·담당자 메모의 '롤' → 경동(why roll)", m2.get("r1").courier === C.KD && m2.get("r1").why === "roll" && m2.get("r2").courier === C.KD);
check("배송지 메모의 '롤'은 안 본다 → CJ", m2.get("r3").courier === C.CJ);
check("스크롤·컨트롤·캐롤의 '롤'은 아니다 → CJ", m2.get("r4").courier === C.CJ);

// 직접 지정이 최우선
const m3 = C.courierMap([o("x", { courier: C.CJ, note: "롤" }), o("y", { courier: C.KD })]);
check("직접 지정 CJ 는 메모에 롤이 있어도 CJ(why manual)", m3.get("x").courier === C.CJ && m3.get("x").why === "manual" && m3.get("x").manual === true);
check("직접 지정 경동", m3.get("y").courier === C.KD && m3.get("y").manual === true);

// 합배송 묶음은 한 박스
const m4 = C.courierMap([o("g1", { mergeGroupId: "G", note: "롤" }), o("g2", { mergeGroupId: "G" }), o("g3", { mergeGroupId: "G", splitShipping: true })]);
check("묶음 중 한 건에 '롤' → 묶음 전체 경동", m4.get("g1").courier === C.KD && m4.get("g2").courier === C.KD);
check("분리 배송 건은 혼자 판정 → CJ", m4.get("g3").courier === C.CJ);
const m5 = C.courierMap([o("h1", { mergeGroupId: "H", courier: C.CJ }), o("h2", { mergeGroupId: "H", note: "롤" })]);
check("묶음 중 한 건의 직접 지정이 전체에", m5.get("h2").courier === C.CJ && m5.get("h2").why === "manual");

// 등록 화면용 autoCourier — 메모만 받는다
check("autoCourier('롤 배송') → 경동", C.autoCourier("롤 배송").courier === C.KD && C.autoCourier("롤 배송").why === "roll");
check("autoCourier('') → CJ(default)", C.autoCourier("").courier === C.CJ && C.autoCourier("").why === "default");
check("배송비 기준 함수는 없다(courierByFee·feeLine·setFeeLine·boxFee)", !C.courierByFee && !C.feeLine && !C.setFeeLine && !C.boxFee && C.DEFAULT_FEE_LINE === undefined);

const fail = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 통과`);
process.exit(fail ? 1 : 0);
