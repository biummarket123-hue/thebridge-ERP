// 채널 주문 엑셀 → 주문 정규화(src/saas/lib/channelImport.js). DB·엑셀 파일 없이 헤더·행 배열로 돈다.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ci = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/channelImport.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

// ── 쿠팡 윙 양식 ──
const CP_H = ["번호", "묶음배송번호", "주문번호", "택배사", "운송장번호", "분리배송 Y/N", "주문시 출고예정일", "주문일", "등록상품명", "등록옵션명", "노출상품명(옵션명)", "결제액", "배송비구분", "배송비", "구매수(수량)", "옵션판매가(판매단가)", "구매자", "구매자전화번호", "수취인이름", "수취인전화번호", "우편번호", "수취인 주소", "배송메세지", "주문자 추가메시지"];
const CP_ROWS = [
  [1, "B1", "27000012345678", "", "", "N", "", "2026-10-20 09:12:33", "린넨 워싱 원단", "베이지, 1마", "린넨 워싱 원단, 베이지", 12000, "유료", 3000, 2, 6000, "김구매", "010-1111-2222", "김수취", "0503-1234-5678", "04524", "서울 중구 을지로 123 4층", "문 앞에 두세요", ""],
  [2, "B1", "27000012345678", "", "", "N", "", "2026-10-20 09:12:33", "린넨 워싱 원단", "네이비, 1마", "린넨 워싱 원단, 네이비", 6000, "유료", 3000, 1, 6000, "김구매", "010-1111-2222", "김수취", "0503-1234-5678", "04524", "서울 중구 을지로 123 4층", "문 앞에 두세요", ""],
  [3, "B2", "27000099999999", "", "", "N", "", new Date(2026, 9, 20, 11, 5), "면 20수 평직", "화이트, 3마", "면 20수 평직, 화이트", "15,000원", "무료", 0, 3, "5,000", "박구매", "01033334444", "", "", "", "", "", ""],
];
check("쿠팡 헤더 감지", ci.detectPreset(CP_H) === "coupang", ci.detectPreset(CP_H));
const cpMap = ci.autoMap(CP_H, "coupang");
check("쿠팡 자동 매핑: 주문번호·수취인·상품·옵션·수량·단가·배송비·주소", cpMap.orderId === "주문번호" && cpMap.customer === "수취인이름" && cpMap.product === "등록상품명" && cpMap.option === "등록옵션명" && cpMap.qty === "구매수(수량)" && cpMap.unitPrice === "옵션판매가(판매단가)" && cpMap.shippingFee === "배송비" && cpMap.address === "수취인 주소", JSON.stringify(cpMap));
const cp = ci.mapRows(CP_H, CP_ROWS, "coupang");
check("같은 주문번호 두 행 → 주문 1건에 품목 2개 (총 2건)", cp.orders.length === 2 && cp.orders[0].items.length === 2, `${cp.orders.length}/${cp.orders[0]?.items.length}`);
const o1 = cp.orders[0];
check("합친 주문: 금액 12000+6000, 배송비는 반복값이라 3000 한 번 → 합계 21000", o1.totalAmount === 21000 && o1.shippingFee === 3000, `${o1.totalAmount}/${o1.shippingFee}`);
check("안심번호 0503 12자리 → 0503-1234-5678, 주문일시 문자열 → 2026-10-20 09:12", o1.phone === "0503-1234-5678" && o1.orderedAt === "2026-10-20 09:12", `${o1.phone}/${o1.orderedAt}`);
check("품목: 원단=등록상품명, 색상=등록옵션명, 단가 6000", o1.items[0].fabric === "린넨 워싱 원단" && o1.items[0].color === "베이지, 1마" && o1.items[0].unitPrice === 6000);
const o2 = cp.orders[1];
check("'15,000원'·'5,000'·'01033334444' 정규화, 수취인 비면 구매자로 채움", o2.items[0].amount === 15000 && o2.items[0].unitPrice === 5000 && o2.customer === "박구매" && o2.phone === "010-3333-4444", `${o2.items[0].amount}/${o2.customer}/${o2.phone}`);
check("Date 셀 주문일시 → 2026-10-20 11:05", o2.orderedAt === "2026-10-20 11:05", o2.orderedAt);
check("문제 행: 주소 없음은 problems 에, 정상 주문은 problems 비어 있음", o2.problems.includes("주소 없음") && o1.problems.length === 0, JSON.stringify(o2.problems));

// ── 스마트스토어 양식 ──
const SS_H = ["상품주문번호", "주문번호", "배송방법", "택배사", "송장번호", "발송일", "주문상태", "클레임상태", "구매자명", "구매자ID", "수취인명", "주문일시", "상품번호", "상품명", "옵션정보", "수량", "옵션가격", "상품가격", "상품별 총 주문금액", "배송비 합계", "배송비 묶음번호", "수취인연락처1", "수취인연락처2", "배송지", "구매자연락처", "우편번호", "배송메세지"];
const SS_ROWS = [
  ["2026102012345", "2026102000001", "택배", "", "", "", "발주확인", "", "이구매", "abc***", "이수취", "2026.10.20 08:30", "P1", "옥스포드 원단", "색상: 그레이", 2, 0, 8000, 16000, 3000, "G1", "010-5555-6666", "", "경기 성남시 분당구 판교로 1 101동 202호", "010-5555-6666", "13494", "부재 시 경비실"],
  ["2026102012346", "2026102000001", "택배", "", "", "", "발주확인", "", "이구매", "abc***", "이수취", "2026.10.20 08:30", "P2", "옥스포드 원단", "색상: 블랙", 1, 0, 8000, 8000, 3000, "G1", "010-5555-6666", "", "경기 성남시 분당구 판교로 1 101동 202호", "010-5555-6666", "13494", "부재 시 경비실"],
  ["2026102012347", "2026102000002", "택배", "", "", "", "취소요청", "취소요청", "최구매", "zzz***", "최수취", "2026.10.20 10:00", "P3", "린넨", "색상: 베이지", 1, 0, 9000, 9000, 0, "G2", "010-7777-8888", "", "부산 해운대구 해운대로 1", "", "48094", ""],
];
check("스마트스토어 헤더 감지", ci.detectPreset(SS_H) === "smartstore", ci.detectPreset(SS_H));
const ss = ci.mapRows(SS_H, SS_ROWS, "smartstore");
check("스마트스토어: 주문번호(묶음) 기준으로 합쳐 2건, 첫 주문 품목 2개·합계 16000+8000+3000", ss.orders.length === 2 && ss.orders[0].items.length === 2 && ss.orders[0].totalAmount === 27000, `${ss.orders.length}/${ss.orders[0]?.totalAmount}`);
check("스마트스토어: '2026.10.20 08:30' → 2026-10-20 08:30, 채널 이름 스마트스토어", ss.orders[0].orderedAt === "2026-10-20 08:30" && ss.orders[0].channel === "스마트스토어", ss.orders[0].orderedAt);
check("취소요청 상태는 문제로 표시", ss.orders[1].problems.some(p => p.includes("취소")), JSON.stringify(ss.orders[1].problems));

// ── 일반 양식 + 필수 칸 누락 ──
const G_H = ["주문번호", "고객명", "연락처", "주소", "원단명", "색상", "수량", "금액"];
check("일반 양식 감지(generic)", ci.detectPreset(G_H) === "generic");
const g = ci.mapRows(G_H, [["A-1", "홍길동", "010-1234-5678", "서울", "린넨", "베이지", 3, 15000], ["", "임꺽정", "", "", "", "", 0, 0]], "generic");
check("일반 양식: 정상 1건 + 문제 행(주문번호·상품명 없음·수량 0·금액 0)", g.orders.length === 2 && g.orders[0].problems.length === 0 && g.orders[1].problems.includes("주문번호 없음") && g.orders[1].problems.includes("상품명 없음") && g.orders[1].problems.includes("수량 0"), JSON.stringify(g.orders[1].problems));
const noId = ci.mapRows(["고객명", "상품명"], [["a", "b"]], "generic");
check("필수 칸(주문번호) 못 찾으면 missing 에 든다", noId.missing.some(f => f.k === "orderId"));
check("사람이 고른 매핑이 자동 매핑을 덮는다", ci.mapRows(["번호", "이름", "품명"], [["X9", "김", "면"]], "generic", { orderId: "번호", customer: "이름", product: "품명" }).orders[0].channelOrderId === "X9");

// ── 헤더 행 찾기 ──
const aoa = [["쿠팡 발주서", "", ""], ["", "", ""], CP_H, CP_ROWS[0]];
check("안내문 2행 뒤의 헤더 행을 찾는다(index 2)", ci.headerRowIndex(aoa) === 2, String(ci.headerRowIndex(aoa)));

// ── 중복 걸러내기 ──
const dd = ci.dedupe(cp.orders, new Set(["27000012345678"]));
check("이미 들어온 주문번호는 skipped(exists=true), 나머지는 fresh", dd.fresh.length === 1 && dd.skipped.length === 1 && dd.skipped[0].exists === true && dd.fresh[0].channelOrderId === "27000099999999");
const dd2 = ci.dedupe([{ channelOrderId: "1" }, { channelOrderId: "1" }, { channelOrderId: "" }], []);
check("목록 안 중복은 뒤의 것만 걸러지고, 주문번호 없는 건 그대로 둔다", dd2.fresh.length === 2 && dd2.skipped.length === 1);

// ── ERP 주문 모양 ──
const now = new Date(2026, 9, 20, 14, 7);
const erp = ci.toErpOrder(o1, { manager: "민수", shipDate: "2026-10-21", paid: true, now });
check("toErpOrder: 접수·입금완료·판매처 쿠팡·채널주문번호·출고예정일·담당자·오늘 날짜", erp.status === "접수" && erp.payment === "입금완료" && erp.salesChannel === "쿠팡" && erp.channelOrderId === "27000012345678" && erp.shipDate === "2026-10-21" && erp.manager === "민수" && erp.date === "2026. 10. 20." && erp.time === "14:07", JSON.stringify([erp.date, erp.time]));
check("toErpOrder: note 에 채널·주문번호·주문일시 요약, 미결제면 미입금", erp.note.includes("[쿠팡] 주문번호 27000012345678") && erp.note.includes("2026-10-20 09:12") && ci.toErpOrder(o1, { paid: false }).payment === "미입금");

// ── 전화번호·숫자 ──
check("normalizePhone: 02 지역번호·빈값·이상한 길이", ci.normalizePhone("0212345678") === "02-1234-5678" && ci.normalizePhone("") === "" && ci.normalizePhone("12345") === "12345");
check("toNumber: '₩1,234'·숫자·빈값", ci.toNumber("₩1,234") === 1234 && ci.toNumber(5) === 5 && ci.toNumber("") === 0);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
