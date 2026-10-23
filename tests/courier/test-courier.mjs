// 택배사(src/lib/courier.js) — 자동 판정 없음(2026-10-23 사용자 결정): 미리 지정한 값만 보고, 없으면 null(송장 뽑을 때 고른다).
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

// 배송비·메모의 롤은 택배사와 무관 — 지정이 없으면 null
const m1 = C.courierMap([o("a", { shippingFee: 7000 }), o("b", { note: "롤발송" }), o("c", { memo: "1롤 보내주세요" })]);
check("배송비·메모의 '롤'로는 정하지 않는다 → courier null, why none", ["a", "b", "c"].every(id => m1.get(id).courier === null && m1.get(id).why === "none" && m1.get(id).manual === false));
check("구독형 판정엔 자동 규칙이 없다(defaultCourier·rollCourier·courierByFee 없음)", !C.defaultCourier && !C.rollCourier && !C.courierByFee);
// 옛 회사 모드(ErpApp)만 쓰는 규칙은 따로 남아 있다
const lm = C.legacyCourierMap([o("l1", { note: "롤발송" }), o("l2"), o("l3", { courier: C.CJ, note: "롤" })]);
check("legacyCourierMap: 롤→경동, 아니면 CJ, 직접 지정 우선 (옛 회사 모드 전용)", lm.get("l1").courier === C.KD && lm.get("l1").why === "roll" && lm.get("l2").courier === C.CJ && lm.get("l3").courier === C.CJ && lm.get("l3").why === "manual");
check("autoCourier 는 옛 회사 모드 전용으로만 남아 있다", C.autoCourier("롤").courier === C.KD && C.autoCourier("").courier === C.CJ && C.PICKUP_CUTOFF[C.KD] === "17:30");

// 미리 지정
const m3 = C.courierMap([o("x", { courier: C.CJ, note: "롤" }), o("y", { courier: C.KD }), o("z", { courier: "없는택배" })]);
check("지정 CJ → CJ(why manual)", m3.get("x").courier === C.CJ && m3.get("x").why === "manual" && m3.get("x").manual === true);
check("지정 경동", m3.get("y").courier === C.KD && m3.get("y").manual === true);
check("목록에 없는 지정은 없는 것으로", m3.get("z").courier === null && m3.get("z").why === "none");

// 합배송 묶음은 한 박스
const m4 = C.courierMap([o("g1", { mergeGroupId: "G", courier: C.KD }), o("g2", { mergeGroupId: "G" }), o("g3", { mergeGroupId: "G", splitShipping: true })]);
check("묶음 중 한 건의 지정이 묶음 전체에", m4.get("g1").courier === C.KD && m4.get("g2").courier === C.KD && m4.get("g2").why === "manual");
check("분리 배송 건은 혼자 → 지정 없음", m4.get("g3").courier === null);

// 방문·픽업
const m5 = C.courierMap([o("p1", { manager: "방문고객" }), o("p2", { memo: "매장 픽업" }), o("p3", { memo: "픽업", invoicePrintedAt: "2026-10-19T10:00:00Z" }), o("p4", { deliveryMessage: "방문 전 연락" })]);
check("방문고객 담당·메모의 픽업 → pickup, 송장 뽑힌 건은 아님, 배송지 메모는 안 본다", m5.get("p1").pickup && m5.get("p2").pickup && !m5.get("p3").pickup && !m5.get("p4").pickup);

// 수거 마감은 회사에 하나
check("기본 수거 마감 15:30", C.getPickupCutoff() === C.DEFAULT_PICKUP_CUTOFF && C.DEFAULT_PICKUP_CUTOFF === "15:30");
check("setPickupCutoff: HH:MM 만 받는다", C.setPickupCutoff("9시") === "15:30" && C.setPickupCutoff("17:30") === "17:30" && C.getPickupCutoff() === "17:30");
// 2026-10-19(월) 09:00 에 송장 출력 → 같은 날 17:30 이 지난 20:00 에는 1번 놓침, 17:00 에는 0번
check("missedPickups(since, now): 마감이 지나면 1, 아직이면 0", C.missedPickups(new Date(2026, 9, 19, 9, 0).toISOString(), new Date(2026, 9, 19, 20, 0)) === 1 && C.missedPickups(new Date(2026, 9, 19, 9, 0).toISOString(), new Date(2026, 9, 19, 17, 0)) === 0);
check("missedPickups: 주말은 세지 않는다(금 18:00 → 월 09:00 = 0)", C.missedPickups(new Date(2026, 9, 16, 18, 0).toISOString(), new Date(2026, 9, 19, 9, 0)) === 0);
C.setPickupCutoff("15:30");
check("missedPickups: 이상한 since 는 0", C.missedPickups("", new Date()) === 0 && C.missedPickups("abc", new Date()) === 0);

const fail = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fail}/${results.length} 통과`);
process.exit(fail ? 1 : 0);
