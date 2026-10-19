// 채널/카드사/은행 정산 행 패턴 — 마켓원장 엑셀 업로드 시 더미 행 자동 차단용
//
// 원본 마켓원장에 가계부 정산 입금 행이 주문 행 사이에 끼어 있는 경우가 있어
// (입금자명="쿠팡"/"Npay정산"/"KB11511684" 등 + 마수=0 + 매출=0)
// import 시 이런 행을 skip 한다.

export const CHANNEL_PATTERNS = [
  // 마켓플레이스
  /^쿠팡/,
  /^스마트스토어/,
  /^Npay/,
  /^11번가|11st|11ST/i,
  /^카페24/,
  /^페이앱/,
  // 카드사 (이름 + 숫자 / 숫자 + BC)
  /^삼성카드/,
  /^BC카드/,
  /^국민카드/,
  /^우리카드/,
  /^현\d{6,}/,        // 현116160913 — 현+6자리 이상 숫자
  /^\d{6,}BC/,        // 738442563BC — 6자리+BC
  // 은행 (이름 + 숫자 reference)
  /^KB\d+/,           // KB11511684
  /^롯데\d+/,
  /^하나(\d+|파워온)/, // 하나92041156, 하나파워온
  /^농협\d*/,
  /^신한\d*/,
  /^NH\d+/,           // NH17328309
  /^SHC\d+/,          // SHC0136266
  /^KEB\d+/,
  /^IBK\d+/,
  /^SC\d+/,
];

// 더미 정산 행 판정 — 패턴 매칭 + (수량 0 AND 금액 0)
// 진짜 고객 주문(예: "성하나" 5마 12,000원)은 mat 안 됨
export function isChannelDummyRow(customer, qty, amount) {
  const name = String(customer || "").trim();
  if (!name) return false;
  const isChannel = CHANNEL_PATTERNS.some(p => p.test(name));
  if (!isChannel) return false;
  const isEmpty = (!qty || Number(qty) === 0) && (!amount || Number(amount) === 0);
  return isEmpty;
}
