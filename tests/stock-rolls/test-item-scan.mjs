// 주문 라벨 QR (2026-10-08) — 인계 라벨의 품목 QR 과 포장대 판정(lib/packing.js 주문 라벨 QR 절).
// 사용자 결정: 포장직원은 원단 한 개에 한 번만 찍는다. 라벨 QR 로 품목을 잡고, 그 품번에 진행 중인 롤이
// 둘 이상일 때만 롤 QR 을 이어서 찍는다. 롤 QR 을 먼저 찍는 옛 흐름(resolveScan)은 그대로다.
//
// DB 없이 돈다 — packing.js 는 순수 함수, labelPrint.js 는 Vite 로 불러 HTML 만 본다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FAKE = path.join(HERE, "fake-supabase.mjs").replace(/\\/g, "/");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const pk = await import(pathToFileURL(path.join(ROOT, "src/lib/packing.js")).href);

// ── QR 값·파싱 ──
const ID = "3f2b9c10-aaaa-4bbb-8ccc-0123456789ab";
check("QR 값은 OI: + 하이픈 뺀 대문자 id(영숫자 모드)", pk.itemQrText(ID) === "OI:3F2B9C10AAAA4BBB8CCC0123456789AB", pk.itemQrText(ID));
check("QR 값에 대문자·숫자·':' 뿐", /^[A-Z0-9:]+$/.test(pk.itemQrText(ID)));
check("파싱: 스캐너가 준 값 → item", JSON.stringify(pk.parseScan(pk.itemQrText(ID))) === JSON.stringify({ kind: "item", key: "3F2B9C10AAAA4BBB8CCC0123456789AB" }));
check("파싱: 한글 자판 상태로 들어온 라벨 QR(ㅐㅑ:…)도 item", pk.parseScan("ㅐㅑ:3F2B9C10AAAA4BBB8CCC0123456789AB")?.kind === "item"
  && pk.parseScan("ㅐㅑ:3F2B9C10AAAA4BBB8CCC0123456789AB").key === "3F2B9C10AAAA4BBB8CCC0123456789AB");
check("파싱: 롤 QR 주소 → roll + 롤 번호", JSON.stringify(pk.parseScan("https://info.lowhigh-market.com/r/LH-2610-0001-R01")) === JSON.stringify({ kind: "roll", code: "LH-2610-0001-R01" }));
check("파싱: 손으로 친 소문자 롤 번호 → roll 대문자", pk.parseScan(" lh-2610-0001-r02 ")?.code === "LH-2610-0001-R02");
check("파싱: 빈 값 → null", pk.parseScan("") === null && pk.parseScan("OI:") === null);
check("파싱: 라벨 둘이 붙어 들어오면(앞 Enter 유실) 마지막 것", pk.parseScan(pk.itemQrText(ID) + pk.itemQrText("b".repeat(32))).key === "B".repeat(32));
check("파싱: 롤 둘이 붙어 들어오면 마지막 것", pk.parseScan("https://info.lowhigh-market.com/r/LH-2610-0001-R01https://info.lowhigh-market.com/r/LH-2610-0001-R02").code === "LH-2610-0001-R02");
check("파싱: 라벨 뒤에 롤이 붙으면 롤(마지막)", pk.parseScan(pk.itemQrText(ID) + "https://info.lowhigh-market.com/r/LH-2610-0001-R02").code === "LH-2610-0001-R02");
check("파싱: 롤 뒤에 라벨이 붙으면 라벨(마지막)", pk.parseScan("https://info.lowhigh-market.com/r/LH-2610-0001-R02" + pk.itemQrText(ID)).key === "3F2B9C10AAAA4BBB8CCC0123456789AB");
check("uuid 가 아닌 대체 id(소문자 base36)도 같은 열쇠", pk.itemScanKey("m1x2y3-abcd1234-efgh5678") === "M1X2Y3ABCD1234EFGH5678"
  && pk.parseScan(pk.itemQrText("m1x2y3-abcd1234-efgh5678")).key === pk.itemScanKey("m1x2y3-abcd1234-efgh5678"));

// ── 판정 ──
const P1 = { id: "p1", code: "LH-2610-0001", name: "린넨코튼", color: "베이지", unit: "마" };
const P2 = { id: "p2", code: "LH-2610-0002", name: "쉬폰", color: "네이비", unit: "마" };
const products = new Map([[P1.id, P1], [P2.id, P2]]);
const roll = (id, productId, code, status = "available", lengthRemaining = 20) => ({ id, productId, rollCode: code, status, lengthRemaining });
const itemA = { itemId: ID, fabric: "린넨코튼", color: "베이지", qty: 3, unit: "마", productId: "p1" };
const itemB = { itemId: "b".repeat(32), fabric: "쉬폰", color: "네이비", qty: 2, unit: "마", itemNo: "lh-2610-0002" };   // productId 없음 — itemNo 로 맞춘다
const itemOld = { fabric: "옛 원단", qty: 1, unit: "마" };   // itemId 없음(옛 주문)
const orderK = { id: "o1", customer: "김고객", items: [itemA, itemB] };
const orderL = { id: "o2", customer: "이고객", items: [{ ...itemA, itemId: "c".repeat(32) }] };   // 같은 원단을 기다리는 다른 박스
const orderOld = { id: "o3", customer: "옛고객", items: [itemOld] };
const row = (key, orders, flags = {}) => ({ key, orders, allPacked: false, parked: false, held: false, ...flags });
const rows = [row("r1", [orderK]), row("r2", [orderL]), row("r3", [orderOld])];
const keyA = pk.itemScanKey(ID), keyB = pk.itemScanKey(itemB.itemId);
const none = new Map();

check("찾기: 소문자 uuid 로 저장된 품목을 대문자 열쇠로 찾는다", pk.findItemByKey(rows, keyA)?.item === itemA && pk.findItemByKey(rows, keyA).order === orderK && pk.findItemByKey(rows, keyA).itemIdx === 0);
check("찾기: 모르는 열쇠 → null", pk.findItemByKey(rows, "ZZZ") === null);

let r = pk.resolveItemScan({ key: "ZZZ", rows, packingByOrder: none, products, rolls: [] });
check("거부: 목록에 없는 라벨", r.kind === "reject" && /포장 목록에 없습니다/.test(r.message), r.message);

r = pk.resolveItemScan({ key: keyA, rows, packingByOrder: none, products, rolls: [roll("x1", "p1", "LH-2610-0001-R01")] });
check("롤 1개 → pack(그 롤), 같은 원단을 기다리는 다른 박스(이고객)가 있어도 김고객 품목으로", r.kind === "pack" && r.roll.id === "x1" && r.candidate.order === orderK && r.candidate.item === itemA && r.product === P1, `${r.kind} ${r.roll?.id} ${r.candidate?.order?.customer}`);

r = pk.resolveItemScan({ key: keyA, rows, packingByOrder: none, products, rolls: [
  roll("x2", "p1", "LH-2610-0001-R02"), roll("x1", "p1", "LH-2610-0001-R01"),
  roll("x3", "p1", "LH-2610-0001-R03", "received"), roll("x4", "p1", "LH-2610-0001-R04", "sold"),
  roll("x5", "p1", "LH-2610-0001-R05", "available", 0), roll("y1", "p2", "LH-2610-0002-R01"),
] });
check("롤 2개 이상 → pick-roll, 검단 전·판매 완료·잔량 0·다른 품번은 빠지고 롤 번호순", r.kind === "pick-roll" && r.rolls.map(x => x.id).join() === "x1,x2", JSON.stringify(r.rolls?.map(x => x.id)));
check("예약(reserved) 롤도 후보", pk.rollsForProduct(P1, [roll("x9", "p1", "LH-2610-0001-R09", "reserved")]).length === 1);

// 조각 롤(취소·반품으로 돌아온 원단)은 마 단위 재단 후보에는 들지만 롤·필 단위(통째) 후보에는 안 든다(2026-10-13 점검)
const piece = { ...roll("pc1", "p1", "LH-2610-0001-R07"), origin: "cancel", lengthRemaining: 2 };
check("조각 롤: 마 단위 후보에는 든다", pk.rollsForProduct(P1, [piece]).length === 1);
check("조각 롤: 통째(forWhole) 후보에서는 빠진다", pk.rollsForProduct(P1, [piece], { forWhole: true }).length === 0);
{
  const itemRoll = { itemId: "c".repeat(32), fabric: "린넨코튼", color: "베이지", qty: 1, unit: "롤", productId: "p1" };
  const orderR = { id: "oR", customer: "롤고객", status: "접수", items: [itemRoll] };
  const rowsR = [{ orders: [orderR], allPacked: false, parked: false, held: false }];
  let rr = pk.resolveItemScan({ key: pk.itemScanKey(itemRoll.itemId), rows: rowsR, packingByOrder: none, products, rolls: [piece] });
  check("롤 단위 품목 + 조각 롤만 있음 → no-roll(조각을 통째로 팔지 않는다)", rr.kind === "no-roll", rr.kind);
  rr = pk.resolveItemScan({ key: pk.itemScanKey(itemRoll.itemId), rows: rowsR, packingByOrder: none, products, rolls: [piece, roll("x1", "p1", "LH-2610-0001-R01")] });
  check("롤 단위 품목 + 조각·입고 롤 → 입고 롤 하나로 pack", rr.kind === "pack" && rr.roll.id === "x1", `${rr.kind} ${rr.roll?.id}`);
  const pendingR = { candidate: { row: rowsR[0], order: orderR, item: itemRoll, itemIdx: 0 } };
  rr = pk.resolvePendingRoll({ pending: pendingR, roll: piece, product: P1 });
  check("롤 단위 품목을 기다리는 중 조각 롤 QR → reject", rr.kind === "reject" && rr.wrongRoll === true, rr.message);
  rr = pk.resolvePendingRoll({ pending: pendingR, roll: roll("x1", "p1", "LH-2610-0001-R01"), product: P1 });
  check("롤 단위 품목을 기다리는 중 입고 롤 QR → pack", rr.kind === "pack");
  // 롤을 먼저 찍는 옛 흐름 — 조각 롤이면 롤 단위 품목은 후보에서 빠지고, 그것뿐이면 거부
  rr = pk.resolveScan({ roll: piece, product: P1, activeRow: rowsR[0], visibleRows: rowsR, allRows: rowsR, packingByOrder: none });
  check("조각 롤 QR 먼저 + 롤 단위 품목뿐 → reject", rr.kind === "reject" && /조각 롤/.test(rr.message), rr.message);
  const plan = pk.autoCutPlan(itemRoll, piece);
  check("autoCutPlan: 롤 단위 + 조각 롤 → reject(확인창 없이)", plan.auto === false && plan.reject === true, JSON.stringify(plan));
  check("autoCutPlan: 마 단위 + 조각 롤 → 그대로 재단", pk.autoCutPlan({ ...itemA, qty: 1 }, piece).auto === true);
}

r = pk.resolveItemScan({ key: keyA, rows, packingByOrder: none, products, rolls: [roll("y1", "p2", "LH-2610-0002-R01")] });
check("진행 중인 롤 없음 → no-roll(품목·품번은 잡힘)", r.kind === "no-roll" && r.candidate.item === itemA && r.product === P1);

r = pk.resolveItemScan({ key: keyB, rows, packingByOrder: none, products, rolls: [roll("y1", "p2", "LH-2610-0002-R01")] });
check("productId 없는 품목은 itemNo(대소문자 무시)로 품번을 찾는다", r.kind === "pack" && r.product === P2 && r.roll.id === "y1", `${r.kind} ${r.product?.code} ${r.roll?.id}`);

const packedA = pk.indexPacking([{ orderId: "o1", itemId: ID, rollCode: "LH-2610-0001-R01", length: 3 }]);
r = pk.resolveItemScan({ key: keyA, rows, packingByOrder: packedA, products, rolls: [roll("x1", "p1", "LH-2610-0001-R01")] });
check("거부: 이미 포장된 품목(같은 라벨 두 번)", r.kind === "reject" && /이미 포장된 품목/.test(r.message) && /R01/.test(r.hint), r.message + " / " + r.hint);
check("거부해도 그 주문(candidate)을 돌려준다 — 화면이 그 박스로 간다(2026-10-15)", r.candidate?.order?.id === "o1" && r.candidate?.row?.key === rows[0].key, JSON.stringify(r.candidate?.order?.id));

for (const [flag, re] of [["allPacked", /포장완료된 박스/], ["parked", /보류/], ["held", /보관/]]) {
  const rr = pk.resolveItemScan({ key: keyA, rows: [row("r1", [orderK], { [flag]: true })], packingByOrder: none, products, rolls: [roll("x1", "p1", "LH-2610-0001-R01")] });
  check(`거부: ${flag} 박스`, rr.kind === "reject" && re.test(rr.message), rr.message);
  check(`거부: ${flag} 박스도 candidate 를 돌려준다`, rr.candidate?.row?.key === "r1", JSON.stringify(rr.candidate?.row?.key));
}
r = pk.resolveItemScan({ key: keyA, rows, packingByOrder: none, products: new Map(), rolls: [] });
check("거부: 품번을 모르는 품목(힌트로 롤 QR·롤 없이 포장 안내)", r.kind === "reject" && /품번을 모르는/.test(r.message) && /롤 없이 포장/.test(r.hint));
check("거부: 모르는 라벨은 candidate 없음(갈 데가 없다)", pk.resolveItemScan({ key: "ZZZ", rows, packingByOrder: none, products, rolls: [] }).candidate === undefined);

// ── 라벨 뒤 롤 QR ──
const pending = { candidate: { row: rows[0], order: orderK, item: itemA, itemIdx: 0 }, product: P1, rolls: [] };
r = pk.resolvePendingRoll({ pending, roll: roll("x2", "p1", "LH-2610-0001-R02"), product: P1 });
check("기다리는 품목 + 맞는 롤 → pack(그 품목, 그 롤)", r.kind === "pack" && r.candidate.item === itemA && r.roll.id === "x2");
r = pk.resolvePendingRoll({ pending, roll: roll("y1", "p2", "LH-2610-0002-R01"), product: P2 });
check("기다리는 품목 + 다른 품번 롤 → 거부(원단 섞임 차단), 찍은 롤의 품번을 알려준다", r.kind === "reject" && r.wrongRoll && /김고객/.test(r.message) && /LH-2610-0002/.test(r.message), r.message);
r = pk.resolvePendingRoll({ pending, roll: roll("x4", "p1", "LH-2610-0001-R04", "sold", 0), product: P1 });
check("기다리는 품목 + 판매 완료 롤 → 거부", r.kind === "reject" && /판매 완료/.test(r.message), r.message);
r = pk.resolvePendingRoll({ pending, roll: null, product: null });
check("기다리는 품목 + 모르는 롤 → 거부", r.kind === "reject");

// ── 인계 라벨 HTML — QR 이 품목마다 붙는가 ──
const { createServer } = await import(pathToFileURL(`${ROOT}/node_modules/vite/dist/node/index.js`).href);
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: "error", appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
  optimizeDeps: { disabled: true },
  plugins: [{
    name: "fake-supabase", enforce: "pre",
    resolveId(src, importer) {
      if (/(^|\/)supabase\.js$/.test(src) && importer && /\/src\/lib\//.test(importer.replace(/\\/g, "/"))) return FAKE;
    },
  }],
});
try {
  const lp = await vite.ssrLoadModule("/src/lib/labelPrint.js");
  const order = { id: "o1", date: "2026. 10. 08.", customer: "김고객", phone: "010-1234-5678", manager: "고문님", items: [itemA, itemB] };
  const labels = lp.buildLabels(order, []);
  check("라벨 한 장 = 원단 하나, 품목 id 가 실린다", labels.length === 2 && labels[0].itemId === ID && labels[1].itemId === itemB.itemId);
  const html = await lp.labelDocHtml(order, []);
  check("라벨 HTML: 장수 2", (html.match(/class="sheet"/g) || []).length === 2);
  check("라벨 HTML: 품목마다 QR(svg) 하나", (html.match(/<div class="qr"><svg/g) || []).length === 2);
  check("라벨 HTML: 품번(itemNo)이 아랫줄에 찍힌다 — 없는 품목은 안 찍힘", html.includes('<span class="pcode">lh-2610-0002</span>') && (html.match(/class="pcode"/g) || []).length === 1);
  check("라벨 HTML: QR 칸은 16mm 로 못 박힘", /\.qr \{ flex:none; width:16mm; height:16mm; \}/.test(html));
  check("라벨 HTML: 날짜 줄 = 날짜 + 담당자", /<div class="date"><span>10\/8<\/span><span class="mgr">매니저<\/span><\/div>/.test(html));
  check("라벨 HTML: 이름 줄 = 이름 + 전화 가운데 자리(예전 자리)", /<span class="cust">김고객<\/span>\s*<span class="phone">1234<\/span>/.test(html));
  const oldHtml = await lp.labelDocHtml({ ...orderOld, date: "2026. 10. 08.", manager: "고문님" }, []);
  check("옛 주문(품목 id 없음)은 QR 없이 전처럼", (oldHtml.match(/class="sheet"/g) || []).length === 1 && !/class="qr"/.test(oldHtml));
  const unlinkedHtml = await lp.labelDocHtml({ id: "o9", date: "2026. 10. 08.", customer: "박고객", manager: "고문님", items: [{ itemId: "d".repeat(32), fabric: "품번 없는 원단", qty: 2, unit: "마" }] }, []);
  check("품번 안 이어진 품목(id 는 있음)은 QR 없이 — 찍어도 뺄 롤이 없다(사용자 결정)", (unlinkedHtml.match(/class="sheet"/g) || []).length === 1 && !/class="qr"/.test(unlinkedHtml) && !/class="pcode"/.test(unlinkedHtml));
  // QR 안의 값이 스캐너 판정과 맞물리는가 — qrcode 로 같은 값을 다시 만들어 같은 svg 인지 본다
  const QRCode = (await import(pathToFileURL(`${ROOT}/node_modules/qrcode/lib/index.js`).href)).default;
  const svg = await QRCode.toString(pk.itemQrText(ID), { type: "svg", errorCorrectionLevel: "M", margin: 0 });
  check("라벨 QR 의 값 = itemQrText(품목 id) — 찍으면 parseScan 이 그 품목으로 푼다", html.includes(svg.trim()) && pk.parseScan(pk.itemQrText(ID)).key === keyA);
} finally {
  await vite.close();
}

const failed = results.filter(x => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
