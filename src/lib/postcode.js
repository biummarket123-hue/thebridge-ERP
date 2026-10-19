// 다음(카카오) 우편번호 서비스 로더
// 스크립트를 최초 1회만 로드하고, 이후엔 캐시된 Promise를 재사용한다.
// 사용처: 고객 등록/수정, 주문입력 배송지 — AddressSearchModal(UI.jsx)에서 embed.

const SCRIPT_SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
let loadPromise = null;

export function loadPostcodeScript() {
  if (typeof window !== "undefined" && window.daum && window.daum.Postcode) {
    return Promise.resolve();
  }
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loadPromise = null; reject(new Error("주소 검색 스크립트 로드 실패")); };
    document.head.appendChild(s);
  });
  return loadPromise;
}
