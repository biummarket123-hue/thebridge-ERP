// 송장번호 → 배송 조회 주소. 택배사 이름에 들어 있는 낱말로 고른다. 모르는 택배사는 네이버 검색("택배사 송장번호")으로.
// 순수 함수 — tests/saas/test-tracking.mjs 가 그대로 읽는다.
const RULES = [
  [/CJ|씨제이|대한통운/i, (n) => `https://www.cjlogistics.com/ko/tool/parcel/tracking?gnbInvcNo=${n}`],
  [/롯데/, (n) => `https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=${n}`],
  [/한진/, (n) => `https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=${n}`],
  [/우체국|우편/, (n) => `https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=${n}`],
  [/로젠/, (n) => `https://www.ilogen.com/web/personal/trace/${n}`],
  [/경동/, (n) => `https://kdexp.com/service/delivery/etc/delivery.do?barcode=${n}`],
  [/대신/, (n) => `https://www.ds3211.co.kr/freight/internalFreightSearch.ht?billno=${n}`],
];

/** 숫자·영문만 남긴 송장번호(공백·하이픈 제거). 비면 "" */
export const cleanTrackingNo = (s) => String(s || "").replace(/[^0-9A-Za-z]/g, "");

/** 조회 주소. 송장번호가 비면 "" */
export function trackingUrl(courier, trackingNo) {
  const n = cleanTrackingNo(trackingNo);
  if (!n) return "";
  const c = String(courier || "");
  for (const [re, f] of RULES) if (re.test(c)) return f(n);
  return `https://search.naver.com/search.naver?query=${encodeURIComponent(`${c} ${n}`.trim())}`;
}

/**
 * "고객명 송장번호" 또는 "주문번호 송장번호" 를 줄마다 적은 글을 풀어 { key, no } 배열로.
 * 구분은 공백·탭·쉼표. 송장번호는 뒤쪽 토큰(숫자·영문 8자 이상).
 */
export function parseTrackingPaste(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const no = cleanTrackingNo(parts[parts.length - 1]);
    if (no.length < 8) continue;
    out.push({ key: parts.slice(0, -1).join(" "), no });
  }
  return out;
}
