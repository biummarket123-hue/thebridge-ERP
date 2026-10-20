// 포장대 규칙(src/saas/lib/packBoxes.js + src/lib/packing.js) — 박스 만들기·칸 나누기·지표·스캔 판정·autoCutPlan·allItemsPacked. DB 없이 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const pb = await load("src/saas/lib/packBoxes.js");
const pk = await load("src/lib/packing.js");

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const today = new Date(2026, 9, 20, 10, 0);   // 2026-10-20(화)
const iso = (d) => new Date(d).toISOString();

// ── 품번·롤 ──
const products = [
  { id: "p1", code: "LH-2610-0001", name: "린넨", color: "네이비", unit: "마" },
  { id: "p2", code: "LH-2610-0002", name: "옥스포드", color: "아이보리", unit: "마" },
];
const productById = new Map(products.map(p => [p.id, p]));
const rolls = [
  { id: "r1", rollCode: "LH-2610-0001-R01", productId: "p1", status: "available", lengthRemaining: 30, origin: null },
  { id: "r2", rollCode: "LH-2610-0001-R02", productId: "p1", status: "available", lengthRemaining: 2, origin: null },
  { id: "r3", rollCode: "LH-2610-0001-P01", productId: "p1", status: "available", lengthRemaining: 5, origin: "cancel" },   // 조각 롤
  { id: "r4", rollCode: "LH-2610-0002-R01", productId: "p2", status: "sold", lengthRemaining: 0, origin: null },
];

// ── 주문 ──
const orders = [
  // a: 당일, 품목 2개(린넨 3마 · 옥스포드 1롤)
  { id: "a", customer: "김당일", status: "접수", payment: "입금완료", shipDate: "2026-10-20", createdAt: iso(new Date(2026, 9, 19, 9)),
    items: [{ itemId: "a1", productId: "p1", fabric: "린넨", color: "네이비", qty: 3, unit: "마" }, { itemId: "a2", productId: "p2", fabric: "옥스포드", color: "아이보리", qty: 1, unit: "롤" }] },
  // b+c: 합배송 묶음(같은 mergeGroupId), b 는 익일·c 는 긴급 → 묶음은 긴급
  { id: "b", customer: "박합배", status: "접수", payment: "입금완료", mergeGroupId: "g1", shipDate: "2026-10-21", createdAt: iso(new Date(2026, 9, 19, 10)),
    items: [{ itemId: "b1", productId: "p1", fabric: "린넨", color: "네이비", qty: 2, unit: "마" }] },
  { id: "c", customer: "최합배", status: "접수", payment: "입금완료", mergeGroupId: "g1", isUrgent: true, shipDate: "2026-10-21", createdAt: iso(new Date(2026, 9, 19, 11)),
    items: [{ itemId: "c1", productId: "p1", fabric: "린넨", color: "네이비", qty: 1, unit: "마" }] },
  // d: 같은 묶음이지만 분리 출고 → 따로 한 박스. 출고예정일 지남 → 긴급
  { id: "d", customer: "이분리", status: "접수", payment: "미입금", mergeGroupId: "g1", splitShipping: true, shipDate: "2026-10-18", createdAt: iso(new Date(2026, 9, 17)),
    items: [{ itemId: "d1", productId: "p2", fabric: "옥스포드", qty: 2, unit: "마" }] },
  // e: 보관 요청만(heldAt 없음) → 보관 요청 탭
  { id: "e", customer: "정보관", status: "접수", payment: "입금완료", isHolding: true, shipDate: "2026-10-20", createdAt: iso(new Date(2026, 9, 18)), items: [{ itemId: "e1", productId: "p1", fabric: "린넨", qty: 1, unit: "마" }] },
  // f: 보관중(heldAt 있음) → 목록에서 뺀다
  { id: "f", customer: "강보관중", status: "접수", payment: "입금완료", isHolding: true, heldAt: iso(new Date(2026, 9, 18)), shipDate: "2026-10-20", createdAt: iso(new Date(2026, 9, 18)), items: [{ itemId: "f1", productId: "p1", fabric: "린넨", qty: 1, unit: "마" }] },
  // g: 보류 → 뺀다
  { id: "g", customer: "윤보류", status: "접수", payment: "입금완료", isParked: true, parkReason: "주소 확인", shipDate: "2026-10-01", createdAt: iso(new Date(2026, 9, 1)), items: [{ itemId: "g1", productId: "p1", fabric: "린넨", qty: 1, unit: "마" }] },
  // h: 포장완료(오늘), 포장 후 수량 수정됨 → 완료 탭 + 경고
  { id: "h", customer: "한완료", status: "포장완료", payment: "입금완료", shipDate: "2026-10-20", createdAt: iso(new Date(2026, 9, 19)), packedAt: iso(new Date(2026, 9, 20, 9)),
    packedSig: "린넨|네이비|3|마", items: [{ itemId: "h1", productId: "p1", fabric: "린넨", color: "네이비", qty: 5, unit: "마" }] },
  // i: 출고완료 → 뺀다
  { id: "i", customer: "나출고", status: "출고완료", payment: "입금완료", shipDate: "2026-10-19", createdAt: iso(new Date(2026, 9, 18)), items: [{ itemId: "i1", productId: "p1", fabric: "린넨", qty: 1, unit: "마" }] },
  // j: 예약(모레), 원단 없음 호출 중
  { id: "j", customer: "오예약", status: "접수", payment: "입금완료", shipDate: "2026-10-23", createdAt: iso(new Date(2026, 9, 20)), fabricMissing: true, fabricMissingItems: [0], fabricMissingAt: iso(today),
    items: [{ itemId: "j1", productId: "p2", fabric: "옥스포드", qty: 4, unit: "마" }] },
];

// 포장 기록 — a 의 첫 품목은 롤에서 3마, b1 은 롤 없이
const recs = [
  { orderId: "a", itemId: "a1", rollId: "r1", rollCode: "LH-2610-0001-R01", length: 3, wholeRoll: false, overrideReason: "", packedBy: "포장", packedAt: iso(today) },
  { orderId: "b", itemId: "b1", rollId: null, rollCode: "", length: null, wholeRoll: false, overrideReason: "외주 원단", packedBy: "포장", packedAt: iso(today) },
];
const packingByOrder = pk.indexPacking(recs);

// ── 1. 박스 만들기 ──
const rows = pb.buildBoxes(orders, packingByOrder, { today });
const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
check("출고완료(i)는 박스가 안 된다 · 합배송 b+c 는 한 박스 · 분리(d)는 따로 → 8박스", rows.length === 8 && byKey["g:g1"]?.orders.length === 2 && !!byKey["o:d"] && !byKey["o:i"], `got ${rows.length}: ${rows.map(r => r.key).join(",")}`);
check("합배송 묶음은 가장 급한 건에 맞춘다(c 긴급 → 묶음 긴급)", byKey["g:g1"].bucket === "urgent" && byKey["g:g1"].merged);
check("출고예정일 지난 d → 긴급 + 2일 지남 + 미입금", byKey["o:d"].bucket === "urgent" && byKey["o:d"].overdueDays === 2 && byKey["o:d"].payBlocked, `${byKey["o:d"].bucket}/${byKey["o:d"].overdueDays}`);
check("진행: a 는 1/2, g1 묶음은 1/2(b1 롤 없이 기록)", byKey["o:a"].scanDone === 1 && byKey["o:a"].scanTotal === 2 && byKey["g:g1"].scanDone === 1 && byKey["g:g1"].scanTotal === 2);
check("보관 요청(e)·보관중(f)·보류(g) 판정", byKey["o:e"].holdPending && !byKey["o:e"].heldDone && byKey["o:f"].heldDone && byKey["o:g"].parked);
check("포장 후 수정 감지: h 의 packedSig ≠ 지금 품목", byKey["o:h"].allPacked && byKey["o:h"].editedAfterPack && byKey["o:h"].needsRepack);

// ── 2. 칸 나누기 ──
const split = pb.splitBoxes(rows);
check("긴급: g1·d / 당일: a / 익일: 없음 / 예약: j", split.queue.urgent.map(r => r.key).sort().join() === "g:g1,o:d" && split.queue.today.map(r => r.key).join() === "o:a" && split.queue.tomorrow.length === 0 && split.queue.later.map(r => r.key).join() === "o:j",
  `${JSON.stringify(Object.fromEntries(Object.entries(split.queue).map(([k, v]) => [k, v.map(r => r.key)])))}`);
check("완료 탭 h · 보관 요청 탭 e · 보관중 f 와 보류 g 는 숨김", split.done.map(r => r.key).join() === "o:h" && split.hold.map(r => r.key).join() === "o:e" && split.hidden.map(r => r.key).sort().join() === "o:f,o:g");

// ── 3. 지표 ──
const m = pb.packMetrics(split, today);
check("오늘 포장할 박스 = 긴급 2 + 당일 1 = 3 · 대기 전체 4", m.boxesToday === 3 && m.boxesAll === 4, `${m.boxesToday}/${m.boxesAll}`);
check("찍은 품목 2/6 (a 1/2 · g1 1/2 · d 0/1 · j 0/1)", m.itemsDone === 2 && m.itemsTotal === 6, `${m.itemsDone}/${m.itemsTotal}`);
check("보관 요청 1 · 원단 없음 1(j) · 오늘 완료 1 · 포장 후 수정 1", m.holdRequests === 1 && m.fabricMissing === 1 && m.doneToday === 1 && m.editedAfterPack === 1);

// ── 4. 품목 상태 배지 ──
const stA1 = pb.itemPackState(orders[0], 0, packingByOrder), stA2 = pb.itemPackState(orders[0], 1, packingByOrder);
const stB1 = pb.itemPackState(orders[1], 0, packingByOrder), stJ1 = pb.itemPackState(orders[9], 0, packingByOrder);
check("품목 배지: 롤코드·길이 / 미기록 / 롤 없이·사유 / 원단 없음", stA1.kind === "roll" && stA1.label === "LH-2610-0001-R01 · 3마" && stA2.kind === "none" && stB1.kind === "override" && stB1.label.includes("외주 원단") && stJ1.kind === "missing",
  `${stA1.label} | ${stA2.label} | ${stB1.label} | ${stJ1.label}`);

// ── 5. 스캔 판정(packing.js) ──
const p1 = productById.get("p1");
const r1 = pk.resolveScan({ roll: rolls[0], product: p1, activeRow: byKey["o:a"], visibleRows: split.queue.today, allRows: rows, packingByOrder });
check("활성 박스 a 에서 린넨 롤을 찍으면 — a1 은 이미 기록됐고 a2 는 옥스포드 → 거부 + '→ 누구 주문 것' 힌트", r1.kind === "reject" && r1.wrongBox === true && /최합배/.test(r1.hint || ""), `${r1.kind} ${r1.message} ${r1.hint}`);
const r2 = pk.resolveScan({ roll: rolls[0], product: p1, activeRow: byKey["g:g1"], visibleRows: split.queue.urgent, allRows: rows, packingByOrder });
check("활성 박스 g1 에서 린넨 롤 → 후보 하나(c1) → confirm", r2.kind === "confirm" && r2.candidate.item.itemId === "c1", `${r2.kind}`);
const r3 = pk.resolveScan({ roll: rolls[0], product: p1, activeRow: null, visibleRows: split.queueAll, allRows: rows, packingByOrder });
check("활성 박스 없이 대기 전체에서 린넨 롤 → 후보 c1 하나 → confirm", r3.kind === "confirm" && r3.candidate.item.itemId === "c1", `${r3.kind} ${r3.candidates?.length ?? ""}`);
const r4 = pk.resolveScan({ roll: rolls[3], product: productById.get("p2"), activeRow: null, visibleRows: split.queueAll, allRows: rows, packingByOrder });
check("판매 완료 롤은 거부(상태 안내)", r4.kind === "reject" && r4.status === "sold" && r4.message.includes("판매 완료"));
const r5 = pk.resolveScan({ roll: rolls[2], product: p1, activeRow: byKey["g:g1"], visibleRows: split.queue.urgent, allRows: rows, packingByOrder });
check("조각 롤도 마 단위 품목(c1)에는 쓸 수 있다", r5.kind === "confirm");
const r6 = pk.resolveScan({ roll: { ...rolls[2], productId: "p2" }, product: productById.get("p2"), activeRow: byKey["o:a"], visibleRows: split.queue.today, allRows: rows, packingByOrder });
check("조각 롤을 롤 단위 품목(a2 옥스포드 1롤)에 찍으면 거부", r6.kind === "reject" && /조각 롤/.test(r6.message), `${r6.kind} ${r6.message}`);
const sc = pk.parseScan("https://info.lowhigh-market.com/r/LH-2610-0001-R01");
check("QR 주소에서 롤 번호를 떼어 읽는다 · 한글 자판도 되돌린다", sc.kind === "roll" && sc.code === "LH-2610-0001-R01" && pk.normalizeScan("ㅣㅗ-2610-0001-ㄱ01") === "LH-2610-0001-R01");

// ── 6. autoCutPlan ──
const c1 = { item: orders[2].items[0] };
check("마 단위 + 수량 1 + 잔량 30 → 확인창 없이 1마", pk.autoCutPlan(c1.item, rolls[0]).auto === true && pk.autoCutPlan(c1.item, rolls[0]).len === 1);
check("롤 단위(a2) + 입고 롤 → 롤 통째", pk.autoCutPlan(orders[0].items[1], { ...rolls[0], productId: "p2" }).whole === true);
check("롤 단위 + 조각 롤 → reject", pk.autoCutPlan(orders[0].items[1], rolls[2]).reject === true);
check("잔량 2 < 주문 3마 → 확인창(auto false)", pk.autoCutPlan(orders[0].items[0], rolls[1]).auto === false);

// ── 7. allItemsPacked ──
check("g1 묶음: b1 기록 + c1 방금 기록(justDone) → 다 찍음", pk.allItemsPacked(byKey["g:g1"], packingByOrder, [{ orderId: "c", itemId: "c1" }]) === true);
check("g1 묶음: c1 아직 → false · 포장완료 박스 h → false · 보관 e → false", pk.allItemsPacked(byKey["g:g1"], packingByOrder) === false && pk.allItemsPacked(byKey["o:h"], packingByOrder) === false && pk.allItemsPacked(byKey["o:e"], packingByOrder) === false);

// ── 8. 검색 ──
check("검색: 고객·원단·주문번호", pb.filterBoxes(rows, "합배").length === 1 && pb.filterBoxes(rows, "옥스포드").length === 3 && pb.filterBoxes(rows, "a").some(r => r.key === "o:a"));

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
