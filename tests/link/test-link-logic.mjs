// 4단계 — 링크 주문 서버 로직(api/link/_logic.js). 지시서 6절 13번:
// 택배비 계산 · 합배송 후보 조건 · 배송권 동명이인 판정 · 수량 검사 · 인증 창 · 요청 제한.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const L = await import(pathToFileURL(path.join(ROOT, "api", "link", "_logic.js")).href);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const J = (v) => JSON.stringify(v);

// ── 전화번호 ──
check("normPhone: 기호 제거", L.normPhone("010-1234-5678") === "01012345678" && L.normPhone(null) === "");
check("phonesMatch: 형식이 달라도 숫자가 같으면 같은 번호", L.phonesMatch("010-1234-5678", "01012345678") && !L.phonesMatch("", "") && !L.phonesMatch("0101", null));
check("formatPhone: 11자리 → 010-1234-5678", L.formatPhone("01012345678") === "010-1234-5678" && L.formatPhone("0212345678") === "021-234-5678");

// ── 택배비(3단계 규칙) ──
// 2026-10-07 사용자 결정: 택배비는 단위로 고정 — 마 4,000 · 롤 7,000. 설정의 baseFee 는 안 본다.
check("택배비: 마 단독·배송권 없음 → 4000", L.computeShippingFee({ unit: "마" }) === 4000 && L.computeShippingFee({}) === 4000);
check("택배비: 롤 → 7000", L.computeShippingFee({ unit: "롤" }) === 7000 && L.baseFeeForUnit("롤") === 7000 && L.baseFeeForUnit("마") === 4000);
check("택배비: 설정값(baseFee)은 무시", L.computeShippingFee({ baseFee: 3500 }) === 4000);
check("택배비: 합배송 고르면 0 (롤도)", L.computeShippingFee({ mergeWithOrderId: "abc" }) === 0 && L.computeShippingFee({ mergeWithOrderId: "abc", unit: "롤" }) === 0);
check("택배비: 배송권 사용 + 보유 1 → 0 (롤도)", L.computeShippingFee({ useFreeShipping: true, couponCount: 1 }) === 0 && L.computeShippingFee({ useFreeShipping: true, couponCount: 1, unit: "롤" }) === 0);
check("택배비: 배송권 사용 체크했지만 보유 0 → 단위 기본값", L.computeShippingFee({ useFreeShipping: true, couponCount: 0 }) === 4000 && L.computeShippingFee({ useFreeShipping: true, couponCount: 0, unit: "롤" }) === 7000);
// ── 적립금(2026-10-07) ──
check("적립금 잔액: Σ적립 − Σ사용, 음수면 0", L.creditBalanceFor(1, [{ amount: 5000, type: "적립" }, { amount: 2000, type: "사용" }]).balance === 3000 && L.creditBalanceFor(1, [{ amount: 100, type: "사용" }]).balance === 0);
check("적립금 잔액: 동명이인이면 0 + nameAmbiguous", L.creditBalanceFor(2, [{ amount: 5000, type: "적립" }]).balance === 0 && L.creditBalanceFor(2, []).nameAmbiguous === true);
check("적립금 사용: 잔액·주문 금액 중 작은 쪽까지", L.computeCreditUse({ requested: 10000, balance: 3000, orderTotal: 9000 }) === 3000 && L.computeCreditUse({ requested: 10000, balance: 30000, orderTotal: 9000 }) === 9000 && L.computeCreditUse({ requested: 2500.7, balance: 30000, orderTotal: 9000 }) === 2500);
check("적립금 사용: 금액 모르는 롤 주문은 0, 음수·쓰레기 0", L.computeCreditUse({ requested: 5000, balance: 9000, orderTotal: 0, priceKnown: false }) === 0 && L.computeCreditUse({ requested: -5, balance: 9000, orderTotal: 9000 }) === 0 && L.computeCreditUse({ requested: "abc", balance: 9000, orderTotal: 9000 }) === 0);
check("cleanDraftInput: creditUse 정수·음수 0", L.cleanDraftInput({ creditUse: "3000.9" }).creditUse === 3000 && L.cleanDraftInput({ creditUse: -1 }).creditUse === 0 && L.cleanDraftInput({}).creditUse === 0);
check("baseFeeFromSettings: freight.baseFee, 없으면 4000", L.baseFeeFromSettings({ freight: { baseFee: 3000 } }) === 3000 && L.baseFeeFromSettings({}) === 4000 && L.baseFeeFromSettings(null) === 4000);

// ── 합계 ──
check("합계: 단가 5500 × 2.5 + 4000 = 17750", J(L.computeTotal(5500, 2.5, 4000)) === J({ goods: 13750, total: 17750, priceKnown: true }));
check("합계: 단가 null → 원단 0, 택배비만, priceKnown false", J(L.computeTotal(null, 3, 4000)) === J({ goods: 0, total: 4000, priceKnown: false }));
check("합계: 반올림", L.computeTotal(3333, 1.5, 0).goods === 5000);

// ── 합배송 후보 조건(autoMerge.findMergeCandidates 의 제외 조건) ──
const base = { phone: "010-1111-2222", status: "접수", payment: "미입금", split_shipping: false };
check("후보: 접수·같은 번호 → 후보", L.isMergeCandidate(base, "01011112222"));
check("후보: 포장완료도 후보(규칙 1)", L.isMergeCandidate({ ...base, status: "포장완료" }, "01011112222"));
check("후보: 출고완료 제외", !L.isMergeCandidate({ ...base, status: "출고완료" }, "01011112222"));
check("후보: 환불 제외", !L.isMergeCandidate({ ...base, payment: "환불" }, "01011112222") && !L.isMergeCandidate({ ...base, payment_status: "환불완료" }, "01011112222"));
check("후보: 분리배송 제외", !L.isMergeCandidate({ ...base, split_shipping: true }, "01011112222"));
check("후보: 다른 번호 제외 — 남의 주문이 섞이지 않는다", !L.isMergeCandidate(base, "01099998888") && !L.isMergeCandidate({ ...base, phone: null }, "01011112222"));
check("후보 보기: 필요한 칸만", J(Object.keys(L.candidateView({ ...base, id: "x", date: "2026-10-01", items: [{ fabric: "린넨", color: "베이지", qty: 3 }], ship_date: "2026-10-05", address: "서울", address_detail: "101호", note: "비밀메모", total_amount: 99999 }))) === J(["id", "date", "items", "status", "shipDate", "isUrgent", "address", "addressDetail", "mergeGroupId"]));
{
  const cs = [{ id: "a", mergeGroupId: "g1" }, { id: "b", mergeGroupId: null }, { id: "c", mergeGroupId: "g1" }, { id: "d", mergeGroupId: "g2" }];
  const u = L.groupCandidates(cs);
  check("후보 묶기: 같은 그룹은 한 선택지, 대표 주문은 첫 번째", u.length === 3 && u[0].key === "g:g1" && u[0].grouped && u[0].orderId === "a" && u[0].orders.map(x => x.id).join() === "a,c", J(u));
  check("후보 묶기: 그룹 없는 건은 각각, 혼자 남은 그룹은 보통 주문처럼", !u[1].grouped && u[1].orderId === "b" && !u[2].grouped && u[2].orderId === "d");
  check("후보 묶기: 빈 목록", L.groupCandidates([]).length === 0 && L.groupCandidates(null).length === 0);
}
check("품목 요약", L.summarizeItems([{ fabric: "린넨", color: "베이지", qty: 3 }, { fabric: "쉬폰", qty: 2, unit: "yd" }]) === "린넨 베이지 3마, 쉬폰 2yd");

// ── 무료배송권 동명이인 ──
check("배송권: 이름 1명·보유 2 → 2", J(L.couponCountFor(1, [{ count: 2 }])) === J({ count: 2, nameAmbiguous: false }));
check("배송권: 동명이인 2명 → 0 + nameAmbiguous", J(L.couponCountFor(2, [{ count: 5 }])) === J({ count: 0, nameAmbiguous: true }));
check("배송권: 행 없음 → 0", J(L.couponCountFor(1, [])) === J({ count: 0, nameAmbiguous: false }) && L.couponCountFor(0, null).count === 0);

// ── 재고 ──
const rolls = [{ status: "available", length_remaining: 12.5 }, { status: "available", length_remaining: 30 }, { status: "received", length_remaining: 50 }, { status: "sold", length_remaining: 0 }];
check("maxRemaining: available 중 가장 긴 롤, 롤 수", J(L.maxRemainingOf(rolls)) === J({ maxRemaining: 30, availableCount: 2 }));
check("maxRemaining: 롤 없음 → 0", J(L.maxRemainingOf([])) === J({ maxRemaining: 0, availableCount: 0 }));
const pv = L.productView({ code: "LH-2609-0001", name: "린넨", color: "베이지", photo_url: null, unit: "마", unit_price: "5500.00" }, rolls, 4000);
check("productView: 모양", pv.code === "LH-2609-0001" && pv.unitPrice === 5500 && pv.maxRemaining === 30 && pv.availableCount === 2 && pv.baseFee === 4000 && pv.photoUrl === "", J(pv));
check("productView: 단가 null 유지", L.productView({ code: "A", name: "B", unit_price: null }, [], 4000).unitPrice === null);

// ── 롤 고르기(2026-10-07) — 롤 주문은 수량이 아니라 어느 롤인지 ──
const rollsWithIds = [
  { id: "r2", roll_code: "LH-1-R02", status: "available", length_remaining: 30 },
  { id: "r1", roll_code: "LH-1-R01", status: "available", length_remaining: 12.5 },
  { id: "r3", roll_code: "LH-1-R03", status: "received", length_remaining: 50 },
  { id: "r4", roll_code: "LH-1-R04", status: "available", length_remaining: 0 },
];
check("publicRollsView: 판매 가능·잔량 있는 롤만, 번호 순", J(L.publicRollsView(rollsWithIds).map(r => r.rollCode)) === J(["LH-1-R01", "LH-1-R02"]) && L.publicRollsView(rollsWithIds)[0].length === 12.5);
check("productView 에 rolls", L.productView({ code: "A", name: "B", unit_price: 1000 }, rollsWithIds, 4000).rolls.length === 2);
check("pickRolls: 고른 롤 길이 합", J(L.pickRolls(["r1", "r2"], rollsWithIds).rolls.map(r => r.id)) === J(["r1", "r2"]) && L.pickRolls(["r1", "r2"], rollsWithIds).totalLength === 42.5);
check("pickRolls: 중복은 한 번만", L.pickRolls(["r1", "r1"], rollsWithIds).rolls.length === 1);
check("pickRolls: 없는·판매 불가 롤이면 거부", !L.pickRolls(["r3"], rollsWithIds).ok && !L.pickRolls(["r4"], rollsWithIds).ok && !L.pickRolls(["zz"], rollsWithIds).ok);
check("pickRolls: 빈 선택 거부", !L.pickRolls([], rollsWithIds).ok && !L.pickRolls(null, rollsWithIds).ok);
check("cleanDraftInput: rollIds 문자열 배열, 아니면 빈 배열", J(L.cleanDraftInput({ rollIds: ["a", 5, ""] }).rollIds) === J(["a", "5"]) && J(L.cleanDraftInput({ rollIds: "x" }).rollIds) === J([]));
check("롤 금액: 단가 × 고른 길이 합 + 택배비", J(L.computeTotal(5000, 42.5, 7000)) === J({ goods: 212500, total: 219500, priceKnown: true }));

// ── 수량 ──
check("수량: 3마 OK (정수)", J(L.validateQty("3", 30)) === J({ ok: true, value: 3 }));
check("수량: 소수는 거부 — 1 단위", !L.validateQty("2.5", 30).ok && /1 단위/.test(L.validateQty("2.5", 30).reason));
check("수량: 최대 초과 → '최대 재단 가능 N마'", L.validateQty("31", 30).reason === "최대 재단 가능 30마");
check("수량: 0·음수·글자 거부", !L.validateQty("0", 30).ok && !L.validateQty("-1", 30).ok && !L.validateQty("abc", 30).ok);
check("수량: 재고 0 → 어떤 수량도 거부", !L.validateQty("1", 0).ok);
check("수량(롤): 2롤 OK, 3롤이면 '주문 가능한 롤은 2롤'", L.validateQty("2", 2, "롤").ok && L.validateQty("3", 2, "롤").reason === "주문 가능한 롤은 2롤입니다");
check("단위: 마·롤만, 그 외는 마", L.normUnit("롤") === "롤" && L.normUnit("yd") === "마" && L.normUnit(null) === "마");
check("단위별 최대: 마=가장 긴 롤, 롤=롤 수", L.maxFor("마", { maxRemaining: 30, availableCount: 2 }) === 30 && L.maxFor("롤", { maxRemaining: 30, availableCount: 2 }) === 2);

// ── 인증 창(30분) ──
const now = Date.parse("2026-10-01T10:00:00Z");
const at = (min) => new Date(now - min * 60_000).toISOString();
check("인증: 10분 전 verified → OK", L.isVerifiedRecently([{ verified: true, created_at: at(10) }], now));
check("인증: 31분 전 → 만료", !L.isVerifiedRecently([{ verified: true, created_at: at(31) }], now));
check("인증: verified=false 만 있으면 거부", !L.isVerifiedRecently([{ verified: false, created_at: at(1) }], now));
check("인증: 행 없음 → 거부", !L.isVerifiedRecently([], now) && !L.isVerifiedRecently(null, now));

// ── 요청 제한(1분 3건) ──
check("제한: 1분 안 2건 → 통과", !L.tooManyRecent([at(0.5), at(0.8)], now));
check("제한: 1분 안 3건 → 429", L.tooManyRecent([at(0.1), at(0.5), at(0.9)], now));
check("제한: 오래된 건은 안 센다", !L.tooManyRecent([at(2), at(3), at(0.5)], now));

// ── 입력 정리 ──
const ci = L.cleanDraftInput({ code: " lh-1 ", qty: " 2.5 ", phone: "010-1234-5678", customerName: "  홍길동 ", mergeWithOrderId: "", useFreeShipping: "yes", address: "서울" });
check("입력 정리: 공백 제거·전화 숫자만·빈 merge → null·useFreeShipping boolean·단위 기본 마·입금자명", ci.code === "lh-1" && ci.qty === "2.5" && ci.phone === "01012345678" && ci.customerName === "홍길동" && ci.mergeWithOrderId === null && ci.useFreeShipping === true && ci.addressDetail === "" && ci.unit === "마" && ci.depositorName === "", J(ci));
check("입력 정리: 개인정보 동의는 boolean true 만", L.cleanDraftInput({ privacyAgreed: true }).privacyAgreed === true && L.cleanDraftInput({ privacyAgreed: "true" }).privacyAgreed === false && L.cleanDraftInput({}).privacyAgreed === false);
check("개인정보 안내 문구: 항목·목적·기간·제3자·거부 다섯 줄", L.PRIVACY_NOTICE.items.length === 5 && L.PRIVACY_NOTICE.items.map(i => i[0]).join() === "수집 항목,수집·이용 목적,보유·이용 기간,제3자 제공,동의 거부");
check("입력 정리: unit 롤·입금자명", L.cleanDraftInput({ unit: "롤", depositorName: " 김입금 " }).unit === "롤" && L.cleanDraftInput({ depositorName: " 김입금 " }).depositorName === "김입금");

// ── 공개 링크: 체크 두 개는 걷어냈다 — 입력에서 받지 않는다 ──
check("입력 정리: useLastAddress·wantsMerge 는 더 이상 받지 않는다", !("useLastAddress" in L.cleanDraftInput({ useLastAddress: true })) && !("wantsMerge" in L.cleanDraftInput({ wantsMerge: true })));

// ── 4단계-B: 셀러 링크 ──
check("토큰 모양: 64자 hex OK, 짧거나 글자 섞이면 거부", L.isValidToken("a".repeat(64)) && L.isValidToken("0123456789abcdef".repeat(2)) && !L.isValidToken("abc") && !L.isValidToken("g".repeat(64)) && !L.isValidToken(""));
{
  const base = { status: "offered", expires_at: new Date(now + 60_000).toISOString() };
  check("주문서 상태: offered·안 지남 → ok", L.offerState(base, now) === "ok");
  check("주문서 상태: 지남 → expired, status expired → expired", L.offerState({ ...base, expires_at: new Date(now - 1000).toISOString() }, now) === "expired" && L.offerState({ status: "expired" }, now) === "expired");
  check("주문서 상태: new/converted → confirmed, rejected → closed, 없음 → missing", L.offerState({ status: "new" }, now) === "confirmed" && L.offerState({ status: "converted" }, now) === "confirmed" && L.offerState({ status: "rejected" }, now) === "closed" && L.offerState(null, now) === "missing");
}
{
  const items = L.sellerItems([{ productId: "p1", itemNo: "LH-1", fabric: "린넨", color: "베이지", qty: 3, unit: "마", unitPrice: 5500 }, { productId: "p2", itemNo: "LH-2", fabric: "쉬폰", qty: 2, amount: 9000 }, { fabric: "" }]);
  check("셀러 품목: 단가×수량, 단가 없으면 적힌 금액, 빈 줄 제외", items.length === 2 && items[0].amount === 16500 && items[0].code === "LH-1" && items[1].amount === 9000, J(items));
  check("셀러 합계: 품목 합 + 택배비", J(L.sellerTotal(items, 4000)) === J({ goods: 25500, total: 29500 }));
  const row = { id: "d1", status: "offered", items, phone: "01012345678", customer_name: "홍길동", address: "서울", address_detail: "1동", shipping_fee: 4000, total_amount: 29500, unit_price: 5500, expires_at: "2026-10-02T00:00:00Z", created_by: "상민" };
  const v = L.offerView(row, { mergeWith: { id: "o1", date: "2026-10-01", items: "면 2마" }, photos: { p1: "http://x/1.jpg" } });
  check("주문서 보기: 전화 뒷4자리만, 품목 사진, 합배송 요약, 만료", v.phoneTail === "5678" && !("phone" in v) && v.items[0].photoUrl === "http://x/1.jpg" && v.mergeWith.items === "면 2마" && v.expiresAt === "2026-10-02T00:00:00Z" && v.priceKnown === false, J(v));
  const v1 = L.offerView({ ...row, items: null, product_id: "p1", product_code: "LH-1", product_name: "린넨 베이지", qty: 3, unit: "마", unit_price: 5500 });
  check("주문서 보기: items 없으면 product_id·qty 로 1품목", v1.items.length === 1 && v1.items[0].amount === 16500 && v1.priceKnown === true, J(v1));
}
{
  const ci = L.cleanConfirmInput({ token: " abc ", qty: "", address: "부산", deliveryMessage: undefined });
  check("confirm 입력: 안 보낸 칸은 null, 빈 qty 는 null", ci.token === "abc" && ci.qty === null && ci.address === "부산" && ci.addressDetail === null && ci.deliveryMessage === null, J(ci));
  check("confirm 수량: 줄이기 OK", L.confirmQtyCheck("2", 3, 30).ok && L.confirmQtyCheck("2", 3, 30).value === 2);
  check("confirm 수량: 늘리면 400", !L.confirmQtyCheck("4", 3, 30).ok && /셀러/.test(L.confirmQtyCheck("4", 3, 30).reason));
  check("confirm 수량: 그 사이 롤이 팔려 최대가 줄었으면 거부", !L.confirmQtyCheck("3", 3, 2).ok);
}

// ── 롤 정보 공개 화면(/r/{롤번호}) ──
{
  const prod = { code: "LH-1", name: "린넨", color: "베이지", photo_url: "p.jpg", unit: "마", unit_price: 5000 };
  const v = L.rollPublicView({ roll_code: "LH-1-R01", status: "available", length_remaining: 22, supplier: "동대문", location: "A-03" }, prod);
  check("롤화면. 남은 22마 · 마당 5,000 · 롤 전체 110,000", v.lengthRemaining === 22 && v.unitPrice === 5000 && v.rollPrice === 110000 && v.available, JSON.stringify(v));
  check("롤화면. 공급처·위치는 싣지 않는다", !("supplier" in v) && !("location" in v) && !JSON.stringify(v).includes("동대문") && !JSON.stringify(v).includes("A-03"));
  const sold = L.rollPublicView({ roll_code: "LH-1-R02", status: "sold", length_remaining: 0 }, prod);
  check("롤화면. 판매 끝난 롤은 길이·롤 가격 없음", sold.lengthRemaining === null && sold.rollPrice === null && !sold.available && sold.unitPrice === 5000);
  const recv = L.rollPublicView({ roll_code: "LH-1-R03", status: "received", length_remaining: null }, prod);
  check("롤화면. 검단 전 롤은 길이 없음", recv.lengthRemaining === null && !recv.available);
  const resv = L.rollPublicView({ roll_code: "LH-1-R04", status: "reserved", length_remaining: 7.5 }, prod);
  check("롤화면. 예약 롤은 길이는 보이되 판매 가능은 아님", resv.lengthRemaining === 7.5 && resv.rollPrice === 37500 && !resv.available);
  const noPrice = L.rollPublicView({ roll_code: "LH-1-R05", status: "available", length_remaining: 10 }, { ...prod, unit_price: null });
  check("롤화면. 단가가 없으면 가격 null(직원 문의)", noPrice.unitPrice === null && noPrice.rollPrice === null && noPrice.lengthRemaining === 10);
  check("롤화면. 소수 잔량 × 단가는 반올림(3.33마 × 3,333 = 11,099)", L.rollPublicView({ roll_code: "x", status: "available", length_remaining: 3.33 }, { ...prod, unit_price: 3333 }).rollPrice === 11099);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
