// 회사별 값 — 새 UI 코드 곳곳에 숫자를 다시 박지 않고 여기 한 파일에 모은다(지시서 1절 4항).
// 2차에서 회사 설정 화면으로 옮길 후보. 옛 코드(constants·courier·freight)가 쓰는 값은 거기서 그대로 읽는다 —
// 여기는 새 UI 가 화면에 보여주거나 기본값으로 쓰는 것만.
import { PICKUP_CUTOFF, CJ, KD } from "../lib/courier.js";

export const BRAND = {
  name: "루프",          // 시안의 서비스 이름(가칭). 한 글자도 안 바꾼다 — 시안 재현이 목표다.
  suffix: "ERP",
  caption: "비즈니스를 더 가볍게",
  tenant: "로하이마켓",   // 로그인한 회사. 사이드바 프로필 아래 줄.
};

// 재고 기준 — 품번의 최대 재단 가능 길이(가장 긴 롤)가 이 값보다 짧으면 "재고 부족"(지시서 5절).
export const LOW_STOCK_M = 10;

// 택배비 기본값(마 단위 소량 4,000 / 롤 단위 7,000) — 주문 등록 폼의 기본값에만 쓴다.
export const SHIPPING_FEE = { cut: 4000, roll: 7000 };

// 택배 수거 마감 — courier.js 가 단일 출처. 화면 안내 문구용으로 다시 내보낸다.
export const PICKUP = { [CJ]: PICKUP_CUTOFF[CJ], [KD]: PICKUP_CUTOFF[KD] };

// 옛 ERP 로 보내는 링크 — 5메뉴 밖의 기능(포장 스캔·라벨·공지·메모 채팅·링크 관리)은 거기서 처리한다(지시서 1절 5항).
export const OLD_ERP_PATH = "/";

// 홈의 "최근 주문" 줄 수, 목록 페이지 크기.
export const RECENT_ORDERS = 5;
export const PAGE_SIZE = 30;
