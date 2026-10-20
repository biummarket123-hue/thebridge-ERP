// 주문 상세 처리의 순수 규칙(src/saas/lib/orderRules.js) — 합배송 후보 점수·정렬, 그룹 id 재사용, 운임비 조정, 출고 취소, 입금 취소, 사진 빼기. DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const r = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/orderRules.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ── 합배송 후보 점수·정렬 ──
const src = { id: "S", customer: "미송", status: "접수", address: "서울 마포구 성산동 1-2", phone: "010-1234-5678", note: "", items: [{ fabric: "린넨", qty: 3, unit: "마" }], date: "2026-10-19" };
const pool = [
  { id: "A", customer: "미송", status: "접수", address: "부산", phone: "", date: "2026-10-18", items: [] },                                  // 같은 고객 100
  { id: "B", customer: "하늘", status: "접수", address: "서울마포구 성산동 1-2", phone: "", date: "2026-10-17", items: [] },                  // 같은 배송지 80
  { id: "C", customer: "하늘", status: "접수", address: "", phone: "", memo: "(미송님 합)", date: "2026-10-16", items: [] },                  // 상대 메모에 내 고객명 70
  { id: "D", customer: "바다", status: "접수", address: "", phone: "010 1234 5678", date: "2026-10-15", items: [] },                         // 같은 연락처 60
  { id: "E", customer: "강", status: "접수", address: "", phone: "", combinedShipping: true, date: "2026-10-14", items: [] },                 // 합배송 표시 30
  { id: "F", customer: "미송", status: "포장완료", address: "", phone: "", date: "2026-10-19", items: [] },                                   // 접수 아님 → 후보 아님
  { id: "G", customer: "미송", status: "출고완료", address: "", phone: "", date: "2026-10-19", items: [] },                                   // 출고완료 → 후보 아님
  { id: "S", customer: "미송", status: "접수", items: [] },                                                                                   // 자기 자신 → 후보 아님
  { id: "H", customer: "미송", status: "접수", address: "", phone: "", date: "2026-10-20", items: [{ fabric: "면", color: "네이비", qty: 1 }] },  // 같은 고객 100, 더 최신
];
check("점수: 같은 고객 100 · 같은 배송지 80 · 메모 언급 70 · 같은 연락처 60 · 합배송 표시 30",
  r.mergeCandidateScore(src, pool[0]) === 100 && r.mergeCandidateScore(src, pool[1]) === 80 && r.mergeCandidateScore(src, pool[2]) === 70 && r.mergeCandidateScore(src, pool[3]) === 60 && r.mergeCandidateScore(src, pool[4]) === 30,
  pool.slice(0, 5).map(o => r.mergeCandidateScore(src, o)).join("/"));
const ranked = r.rankMergeCandidates(src, pool);
check("후보: 접수 상태만, 자기 자신·포장완료·출고완료 제외", ranked.every(({ o }) => !["F", "G", "S"].includes(o.id)) && ranked.length === 6, ranked.map(x => x.o.id).join(","));
check("정렬: 점수 내림차순, 같은 점수(미송 100)는 날짜 최신순 → H, A, B, C, D, E", ranked.map(x => x.o.id).join(",") === "H,A,B,C,D,E", ranked.map(x => x.o.id).join(","));
check("검색어로 좁히기: '네이비'(색상) → H 만", r.rankMergeCandidates(src, pool, { q: "네이비" }).map(x => x.o.id).join(",") === "H");
check("검색어: 닉네임(nickOf) 으로도 찾는다", r.rankMergeCandidates(src, pool, { q: "바다님", nickOf: (n) => n === "바다" ? "바다님" : "" }).map(x => x.o.id).join(",") === "D");
check("limit 으로 자른다", r.rankMergeCandidates(src, pool, { limit: 2 }).length === 2);
const reasons = r.mergeReasons(src, pool[1]);
check("사유 배지: 같은 배송지(같은 고객 아님) · 메모 언급 아님", reasons.sameAddr && !reasons.sameCust && !reasons.mentioned);
check("메모 힌트: '합'이 든 메모만", r.mergeHintOf(pool[2]) === "(미송님 합)" && r.mergeHintOf(src) === "");

// ── 그룹 id 재사용 ──
check("기존 그룹 멤버가 있으면 그 id 를 재사용(새 UUID 안 만듦)", r.pickGroupId([{ id: 1 }, { id: 2, mergeGroupId: "g-old" }], () => "g-new") === "g-old");
check("기존 그룹이 없으면 새 id", r.pickGroupId([{ id: 1 }, { id: 2 }], () => "g-new") === "g-new");

// ── 운임비 조정 ──
const grp = [{ id: "a", shippingFee: 4000, feeHeld: null }, { id: "b", shippingFee: 4000, feeHeld: 3000 }, { id: "c", shippingFee: 0, feeHeld: 4000 }];
const plan = r.freightAdjustPlan(grp, "b", "3,500");
check("운임비 조정: 부담 주문만 금액, 나머지 0, feeHeld 는 전부 null", plan.length === 3 && plan.find(c => c.id === "b").shippingFee === 3500 && plan.filter(c => c.id !== "b").every(c => c.shippingFee === 0) && plan.every(c => c.feeHeld === null), JSON.stringify(plan));
check("운임비 조정: 금액 빈 값은 0원", r.freightAdjustPlan(grp, "a", "").find(c => c.id === "a").shippingFee === 0);
check("운임비 조정: 그룹에 없는 주문을 부담자로 고르면 오류", throws(() => r.freightAdjustPlan(grp, "zzz", 3000)));

// ── 출고 취소 ──
const shippedPool = [
  { id: "x", mergeGroupId: "g1", status: "출고완료", customer: "A" },
  { id: "y", mergeGroupId: "g1", status: "출고완료", customer: "B" },
  { id: "z", mergeGroupId: "g1", status: "접수", customer: "C" },        // 같은 그룹이지만 아직 안 나감 → 되돌릴 대상 아님
  { id: "w", mergeGroupId: "g2", status: "출고완료", customer: "D" },    // 다른 그룹
];
check("출고 취소: 같이 나간 묶음 멤버(출고완료)만 — y", r.shippedMatesOf(shippedPool[0], shippedPool).map(o => o.id).join(",") === "y");
check("출고 취소: 묶음 아니면 빈 배열", r.shippedMatesOf({ id: "q", status: "출고완료" }, shippedPool).length === 0);
const up = r.undoShipPatch();
check("출고 취소 패치: 포장완료 · shippedAt/shippedVia/출고요청 null", up.status === "포장완료" && up.shippedAt === null && up.shippedVia === null && up.shipRequestedAt === null);
check("출고 취소 권한: 관리자만 · 출고완료만", r.canUndoShip(shippedPool[0], { isAdmin: true }) === null && !!r.canUndoShip(shippedPool[0], { isAdmin: false }) && !!r.canUndoShip(shippedPool[2], { isAdmin: true }));

// ── 입금 취소 ──
check("입금 취소: 관리자 + 입금완료/부분입금만, 미입금·출고완료는 막는다",
  r.canCancelDeposit({ status: "접수" }, "입금완료", { isAdmin: true }) === null
  && r.canCancelDeposit({ status: "접수" }, "부분입금", { isAdmin: true }) === null
  && !!r.canCancelDeposit({ status: "접수" }, "미입금", { isAdmin: true })
  && !!r.canCancelDeposit({ status: "접수" }, "입금완료", { isAdmin: false })
  && !!r.canCancelDeposit({ status: "출고완료" }, "입금완료", { isAdmin: true }));

// ── 사진 · 택배사 ──
check("사진 빼기: 가운데 한 장만, 원본 배열은 그대로", (() => { const imgs = ["u1", "u2", "u3"]; const out = r.removeImageAt(imgs, 1); return out.join() === "u1,u3" && imgs.length === 3 && r.removeImageAt(imgs, 9).length === 3; })());
check("택배사 정규화: 목록에 없는 값은 자동(null)", r.normalizeCourier("CJ대한통운", ["CJ대한통운", "경동화물"]) === "CJ대한통운" && r.normalizeCourier("롯데", ["CJ대한통운", "경동화물"]) === null && r.normalizeCourier(null, ["CJ대한통운"]) === null);

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
