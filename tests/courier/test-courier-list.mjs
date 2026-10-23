// 회사별 택배사 목록(src/lib/courier.js setCouriers · src/saas/config.js validateCouriers/resolveCouriers) — 이름·줄임·송장 양식(·경동 선불/후불)만(2026-10-23).
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const C = await import(pathToFileURL(path.join(ROOT, "src", "lib", "courier.js")).href);
const G = await import(pathToFileURL(path.join(ROOT, "src", "saas", "config.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const o = (id, extra = {}) => ({ id, note: "", memo: "", ...extra });

// ── 기본 목록 ──
check("기본 목록: CJ·경동, 경동은 선불", C.COURIERS.join() === `${C.CJ},${C.KD}` && C.COURIER_SHORT[C.KD] === "경동" && C.courierInfo(C.KD).payType === "선불" && !("payType" in C.courierInfo(C.CJ)));
check("양식: CJ→cj · 경동→kd · 모르는 이름→generic", C.courierFormat(C.CJ) === "cj" && C.courierFormat(C.KD) === "kd" && C.courierFormat("롯데택배") === "generic");

// ── 회사 목록으로 바꾸기 ──
const set = C.setCouriers([
  { name: "롯데택배", short: "롯데", format: "generic" },
  { name: "경동화물", short: "경동", format: "kd", payType: "후불" },
  { name: "CJ대한통운", short: "CJ", format: "cj", payType: "후불" },   // cj 양식엔 payType 없음
  { name: "  ", short: "x" },                                           // 이름 없음 → 버림
  { name: "롯데택배", short: "중복" },                                    // 중복 → 버림
  { name: "한진택배" },                                                   // 줄임 없음 → 앞 두 글자
]);
check("setCouriers: 이상한 항목 버리고 4개, 줄임 자동", set.length === 4 && C.COURIERS.join() === "롯데택배,경동화물,CJ대한통운,한진택배" && C.COURIER_SHORT["한진택배"] === "한진", C.COURIERS.join());
check("살아 있는 값이 바뀐다: COURIER_SHORT", C.COURIER_SHORT["롯데택배"] === "롯데" && !("경동" in C.COURIER_SHORT));
check("payType 은 경동 양식에만", C.courierInfo("경동화물").payType === "후불" && !("payType" in C.courierInfo("CJ대한통운")));
const m = C.courierMap([o("a"), o("b", { courier: "한진택배" }), o("c", { courier: "우체국택배" })]);
check("판정: 지정 없음→null, 목록의 지정→그대로, 목록에 없는 지정→null", m.get("a").courier === null && m.get("b").courier === "한진택배" && m.get("b").manual && m.get("c").courier === null);
check("courierMap 에 목록을 직접 주면 그 목록으로", C.courierMap([o("z", { courier: "우체국택배" })], [{ name: "우체국택배" }]).get("z").courier === "우체국택배");
check("빈 목록 → 기본 둘로 복귀", (C.setCouriers([]), C.COURIERS.join() === `${C.CJ},${C.KD}`));

// ── 설정 검증(config.js) ──
check("validateCouriers: 빈 목록 거부", !!G.validateCouriers([]).error);
check("validateCouriers: 이름 없음·중복·줄임 길이 거부", !!G.validateCouriers([{ name: "" }]).error && !!G.validateCouriers([{ name: "A" }, { name: "A" }]).error && !!G.validateCouriers([{ name: "A", short: "1234567" }]).error);
const v = G.validateCouriers([{ name: " 롯데 택배 ", format: "이상", payType: "후불" }, { name: "경동화물", format: "kd", payType: "후불" }, { name: "대신화물", format: "kd", payType: "몰라" }, { name: "CJ대한통운" }]);
check("validateCouriers: 공백 정리·줄임 자동·양식 보정·payType 은 kd 만(이상한 값은 선불)·CJ 이름이면 cj", !v.error && v.couriers[0].name === "롯데 택배" && v.couriers[0].short === "롯데" && v.couriers[0].format === "generic" && !("payType" in v.couriers[0]) && v.couriers[1].payType === "후불" && v.couriers[2].payType === "선불" && v.couriers[3].format === "cj", JSON.stringify(v));
check("resolveCouriers: 저장값 없으면 기본 둘", (() => { const r = G.resolveCouriers(undefined); return r.length === 2 && r[0].name === C.CJ && r[1].payType === "선불"; })());

// ── 수거 마감은 회사에 하나 ──
check("resolveConfig: 문자열 pickupCutoff", G.resolveConfig({ saas: { pickupCutoff: "16:00" } }, null).pickupCutoff === "16:00");
check("resolveConfig: 옛 객체 저장값({CJ: …})도 읽는다", G.resolveConfig({ saas: { pickupCutoff: { [C.CJ]: "14:00", [C.KD]: "17:30" } } }, null).pickupCutoff === "14:00");
check("resolveConfig: 이상한 값은 15:30", G.resolveConfig({ saas: { pickupCutoff: "오후" } }, null).pickupCutoff === "15:30" && G.resolveConfig({}, null).pickupCutoff === "15:30");
check("resolveConfig: couriers 기본·저장값", G.resolveConfig({}, null).couriers.map(c => c.name).join() === `${C.CJ},${C.KD}` && G.resolveConfig({ saas: { couriers: [{ name: "롯데택배" }] } }, null).couriers.length === 1);

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
