// 3단계 — 합배송 규칙. 지시서 5절 1·2번: 택배비 재계산(순수)과 그룹 출고예정일(가장 늦은 날).
// DB 없이 src/lib 의 순수 함수를 그대로 부른다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const lib = (f) => pathToFileURL(path.join(ROOT, "src", "lib", f)).href;
const fr = await import(lib("freight.js"));
const am = await import(lib("autoMerge.js"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const J = (v) => JSON.stringify(v);

// 주문 흉내 — createdAt 으로 등록 순을 정한다. payment 로 결제 상태.
let n = 0;
const ord = (fee, payment = "미입금", extra = {}) => ({
  id: `o${++n}`, createdAt: `2026-10-01T09:0${n}:00Z`, shippingFee: fee, payment, ...extra,
});
const byId = (res, id) => res.changes.find(c => c.id === id);
const opts = {};

// ── 5-1 (a) 4,000 + 4,000 → 첫 건 4,000 유지, 둘째 0 (김○연 사례 교정) ──
{
  const a = ord(4000), b = ord(4000);
  const r = fr.recomputeGroupFreight([b, a], opts);        // 순서를 섞어 넣어도 등록 순으로 본다
  check("1a. 4000+4000 → 둘째만 0", r.changes.length === 1 && byId(r, b.id)?.shippingFee === 0 && r.bearerId === a.id && !r.conflict, J(r));
}
// ── 5-1 (b) 0 + 0 → 그대로. 택배비 없는 묶음(무료배송권·단골 혜택·보관)에 새로 붙이지 않는다(2026-10-02) ──
{
  const a = ord(0), b = ord(0);
  const r = fr.recomputeGroupFreight([a, b], opts);
  check("1b. 0+0 → 변경 없음, 부담자 없음", r.changes.length === 0 && r.bearerId === null && !r.conflict, J(r));
}
// ── 5-1 (c) 1건만 → 그대로. 혼자 남은 0원 주문에 새로 붙이지 않는다 ──
{
  const a = ord(0);
  const r = fr.recomputeGroupFreight([a], opts);
  check("1c. 혼자 남은 0원 → 0 인 채로", r.changes.length === 0 && r.bearerId === null, J(r));
  const f = ord(0, "미입금", { freeShippingUsed: true });
  const rf = fr.recomputeGroupFreight([f], opts);
  check("1c. 무료배송권이면 0 유지", rf.changes.length === 0, J(rf));
  const k = ord(7000);
  const rk = fr.recomputeGroupFreight([k], opts);
  check("1c. 혼자인데 이미 7,000 들고 있으면 그대로(사람이 정한 값)", rk.changes.length === 0 && rk.bearerId === k.id, J(rk));
}
// ── 5-1 (d) 입금완료 건이 4,000 들고 있고 미입금 건도 4,000 → 미입금 건만 0 ──
{
  const unpaid = ord(4000, "미입금"), paid = ord(4000, "입금완료");   // 미입금이 먼저 등록됐어도 입금완료 건이 부담자
  const r = fr.recomputeGroupFreight([unpaid, paid], opts);
  check("1d. 입금완료 건이 부담자, 미입금 건만 0", r.changes.length === 1 && byId(r, unpaid.id)?.shippingFee === 0 && r.bearerId === paid.id, J(r));
  const paid0 = ord(0, "입금완료"), u = ord(0, "미입금");
  const r2 = fr.recomputeGroupFreight([paid0, u], opts);
  check("1d+. 입금완료 0원 + 미입금 0원 → 아무도 안 든 채로", r2.changes.length === 0 && r2.bearerId === null, J(r2));
  const pr = ord(4000, "부분환불"), u2 = ord(4000, "미입금");
  const r3 = fr.recomputeGroupFreight([pr, u2], { paymentStatusOf: o => o.payment });
  check("1d+. 부분환불도 돈 들어온 건 — 바꾸지 않는다", r3.changes.length === 1 && byId(r3, u2.id)?.shippingFee === 0, J(r3));
}
// ── 5-1 (e) 입금완료 2건 모두 4,000 → 변경 없음 + conflict ──
{
  const a = ord(4000, "입금완료"), b = ord(4000, "입금완료"), c = ord(4000, "미입금");
  const r = fr.recomputeGroupFreight([a, b, c], opts);
  check("1e. 입금완료 2건이 각각 들고 있으면 conflict, 변경 없음", r.conflict && r.changes.length === 0, J(r));
}
// ── 결제 상태는 _computed 를 우선한다 ──
{
  const a = ord(4000, "미입금", { _computed: { paymentStatus: "입금완료" } }), b = ord(4000);
  const r = fr.recomputeGroupFreight([a, b], opts);
  check("1+. _computed.paymentStatus 가 payment 보다 우선", byId(r, b.id)?.shippingFee === 0 && !byId(r, a.id), J(r));
  check("1+. 빈 그룹은 변경 없음", fr.recomputeGroupFreight([], opts).changes.length === 0);
}
// ── patchOrdersWithGroupResult ──
{
  const a = ord(4000), b = ord(4000, "미입금", { shipDate: "2026-10-02" });
  const res = { ids: [a.id, b.id], shipDate: "2026-10-05", isUrgent: false, dateChanged: true, freight: { changes: [{ id: b.id, shippingFee: 0 }] } };
  const next = fr.patchOrdersWithGroupResult([a, b, ord(1000)], res);
  check("1+. 화면 반영 — 날짜·택배비가 바뀐 주문만 바뀐다", next[0].shipDate === "2026-10-05" && next[1].shippingFee === 0 && next[1].shipDate === "2026-10-05" && next[2].shippingFee === 1000, J(next));
}

// ── 택배비가 바뀌면 전체금액도 같은 차액만큼 — 입금 대조는 전체금액으로 한다 ──
{
  const a = ord(4000, "미입금", { totalAmount: 24000 }), b = ord(4000, "미입금", { totalAmount: 34000 });
  const r = fr.recomputeGroupFreight([a, b], opts);
  check("T1. 4000→0 이 된 주문은 전체금액도 4,000 준다(34,000→30,000)", byId(r, b.id)?.shippingFee === 0 && byId(r, b.id)?.totalAmount === 30000 && !byId(r, a.id), J(r));
  const c = ord(0, "미입금", { totalAmount: 20000 });
  const r1 = fr.recomputeGroupFreight([c], opts);
  check("T2. 혼자 남은 0원 주문은 택배비도 전체금액도 그대로", r1.changes.length === 0, J(r1));
  const legacy = ord(4000), first = ord(4000);
  const r2 = fr.recomputeGroupFreight([first, legacy].reverse(), opts);
  check("T3. 전체금액이 없는(0) 옛 주문은 택배비만 바꾼다", r2.changes.length === 1 && !("totalAmount" in r2.changes[0]), J(r2));
  const paid = ord(4000, "입금완료", { totalAmount: 24000 }), u = ord(4000, "미입금", { totalAmount: 14000 });
  const r3 = fr.recomputeGroupFreight([paid, u], opts);
  check("T4. 입금완료 주문은 택배비도 전체금액도 그대로", !byId(r3, paid.id) && byId(r3, u.id)?.totalAmount === 10000, J(r3));
  const next = fr.patchOrdersWithGroupResult([a, b], { freight: { changes: r.changes } });
  check("T5. 화면 반영 — 택배비와 전체금액이 같이 바뀐다", next[1].shippingFee === 0 && next[1].totalAmount === 30000 && next[0].totalAmount === 24000, J(next));
}

// ── 내려놓은 택배비를 기억했다가, 다시 따로 나가게 되면 되돌린다(있던 주문은 있게, 없던 주문은 없게) ──
{
  const a = ord(4000, "미입금", { totalAmount: 24000 }), b = ord(4000, "미입금", { totalAmount: 34000 });
  const r = fr.recomputeGroupFreight([a, b], opts);
  check("H1. 묶여서 0 이 되는 주문은 원래 금액을 적어 둔다(feeHeld 4000)", byId(r, b.id)?.shippingFee === 0 && byId(r, b.id)?.feeHeld === 4000, J(r));
  const bHeld = { ...b, shippingFee: 0, totalAmount: 30000, feeHeld: 4000 };
  const r2 = fr.recomputeGroupFreight([bHeld], opts);
  check("H2. 혼자 남으면 적어 둔 4,000 과 전체금액이 되돌아온다(30,000→34,000), 적어 둔 값은 비운다",
    byId(r2, b.id)?.shippingFee === 4000 && byId(r2, b.id)?.totalAmount === 34000 && byId(r2, b.id)?.feeHeld === null && r2.bearerId === b.id, J(r2));
  const never = ord(0, "미입금", { totalAmount: 17500 });
  check("H3. 원래 택배비가 없던 주문은 혼자 남아도 없는 그대로", fr.recomputeGroupFreight([never], opts).changes.length === 0);
  const paid = { ...bHeld, id: "paidheld", payment: "입금완료" };
  const r4 = fr.recomputeGroupFreight([paid], opts);
  check("H4. 입금완료 주문은 되돌리지 않고 알리기만 한다(heldBack)", r4.changes.length === 0 && r4.heldBack.length === 1 && r4.heldBack[0].fee === 4000, J(r4));
  // 부담 주문 A 가 먼저 출고돼 B·C 만 남았다 — 둘 다 내려놓았던 주문. 먼저 등록된 B 하나만 되돌린다
  const B = ord(0, "미입금", { totalAmount: 10000, feeHeld: 4000 }), C = ord(0, "미입금", { totalAmount: 20000, feeHeld: 4000 });
  const r5 = fr.recomputeGroupFreight([C, B], opts);
  check("H5. 남은 묶음에 부담 주문이 없으면 내려놓았던 첫 주문만 되돌린다", r5.changes.length === 1 && byId(r5, B.id)?.shippingFee === 4000 && byId(r5, B.id)?.totalAmount === 14000 && r5.bearerId === B.id, J(r5));
  const next = fr.patchOrdersWithGroupResult([a, b], { freight: { changes: r.changes } });
  check("H6. 화면 반영 — feeHeld 도 같이 반영된다", next[1].feeHeld === 4000 && next[0].feeHeld === undefined, J(next));
}
// ── 등록 전 안내 — 묶일 주문들과 택배비가 겹치는가 ──
{
  const old = ord(4000, "미입금", { totalAmount: 24000 });
  const fresh = { id: "__new__", createdAt: "2026-10-02T09:00:00Z", shippingFee: 4000, totalAmount: 21500, payment: "미입금" };
  const p = fr.previewFreightOverlap(fresh, [old]);
  check("P1. 기존 4,000 + 새 주문 4,000 → 안내(2건), 새 주문이 0 · 21,500→17,500",
    p && p.holders.length === 2 && p.changes.length === 1 && p.changes[0].order.id === "__new__" && p.changes[0].from === 4000 && p.changes[0].totalTo === 17500 && !p.conflict, J(p));
  check("P2. 새 주문에 택배비가 없으면 안내 없음", fr.previewFreightOverlap({ ...fresh, shippingFee: 0 }, [old]) === null);
  check("P3. 묶일 주문이 없으면 안내 없음", fr.previewFreightOverlap(fresh, []) === null);
  check("P4. 기존 주문이 0원이면 안내 없음", fr.previewFreightOverlap(fresh, [ord(0)]) === null);
  const paidOld = ord(4000, "입금완료"), paidOld2 = ord(4000, "입금완료");
  check("P5. 입금완료 2건이 이미 각각 들고 있으면 conflict 로 알린다", fr.previewFreightOverlap(fresh, [paidOld, paidOld2])?.conflict === true);
}

// ── 1e. 무료배송권을 쓴 주문은 택배비를 내려놓지 않는다 (2026-10-07) ──
// 배송권차감 로그가 "쓸 때의 배송비" 금액으로 남아 있어서, 택배비를 0 으로 내리면 받은 돈이
// 청구액을 넘어 완납으로 잘못 잡힌다. 입금완료 건과 같은 "돈이 들어온 주문" 취급.
{
  const fs = ord(4000, "미입금", { freeShippingUsed: true }), later = ord(4000);
  const r = fr.recomputeGroupFreight([fs, later], opts);
  check("1e. 배송권 쓴 건이 먼저 — 그 건 유지, 뒤 건만 0", r.changes.length === 1 && byId(r, later.id)?.shippingFee === 0 && r.bearerId === fs.id && !r.conflict, J(r));
  const first = ord(4000), fs2 = ord(4000, "미입금", { freeShippingUsed: true });
  const r2 = fr.recomputeGroupFreight([first, fs2], opts);
  check("1e. 미입금 건이 먼저 등록됐어도 배송권 쓴 건이 부담자", r2.changes.length === 1 && byId(r2, first.id)?.shippingFee === 0 && r2.bearerId === fs2.id, J(r2));
  const paid = ord(4000, "입금완료"), fs3 = ord(4000, "미입금", { freeShippingUsed: true });
  const r3 = fr.recomputeGroupFreight([paid, fs3], opts);
  check("1e. 입금완료 + 배송권 둘 다 택배비 → 자동으로 못 정함(conflict)", r3.conflict && r3.changes.length === 0, J(r3));
  const fsHeld = ord(0, "미입금", { freeShippingUsed: true, feeHeld: 4000 });
  const r4 = fr.recomputeGroupFreight([fsHeld], opts);
  check("1e. 배송권 쓴 건은 내려놓은 값도 자동으로 되돌리지 않는다(heldBack 으로만 알림)", r4.changes.length === 0 && r4.heldBack.length === 1, J(r4));
  check("1e. isFreightFrozen — 배송권 사용 건은 고정", fr.isFreightFrozen({ payment: "미입금", freeShippingUsed: true }) && !fr.isFreightFrozen({ payment: "미입금" }));
}

// ── 5-2 그룹 출고예정일: 10/2 · 10/5 → 10/5. 긴급 포함 → 긴급 ──
{
  const t = am.groupShipTarget([{ shipDate: "2026-10-02" }, { shipDate: "2026-10-05" }]);
  check("2. 10/2·10/5 → 10/5 (가장 늦은 날)", t.shipDate === "2026-10-05" && !t.isUrgent, J(t));
  const u = am.groupShipTarget([{ shipDate: "2026-10-02", isUrgent: true }, { shipDate: "2026-10-05" }]);
  check("2. 긴급 포함 → 긴급 유지", u.isUrgent === true, J(u));
  const m = am.groupShipTarget([{ shipDate: "2026-10-05" }, { shipDate: null }, { shipDate: "2026-10-02" }]);
  check("2. 날짜 없는 건은 빼고 본다", m.shipDate === "2026-10-05", J(m));
  check("2. 전부 날짜 없음 → null", am.groupShipTarget([{}, {}]).shipDate === null);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
