// 회사별 값 — 새 UI 코드 곳곳에 숫자를 다시 박지 않고 여기 한 파일에 모은다(지시서 1절 4항).
// 2차에서 회사 설정 화면으로 옮길 후보. 옛 코드(constants·courier·freight)가 쓰는 값은 거기서 그대로 읽는다 —
// 여기는 새 UI 가 화면에 보여주거나 기본값으로 쓰는 것만.
import { PICKUP_CUTOFF, CJ, KD } from "../lib/courier.js";
import { PREFIX_RE, DEFAULT_PREFIX } from "../lib/rollStock.js";

export const BRAND = {
  name: "루프",          // 시안의 서비스 이름(가칭). 한 글자도 안 바꾼다 — 시안 재현이 목표다.
  suffix: "ERP",
  caption: "비즈니스를 더 가볍게",
  tenant: "",            // 로그인한 회사 — 회사 계정(company_accounts.name)·설정에서 온다. 비어 있으면 아래 기본 문구.
};

// 재고 기준 — 품번의 최대 재단 가능 길이(가장 긴 롤)가 이 값보다 짧으면 "재고 부족"(지시서 5절).
export const LOW_STOCK_M = 10;

// 택배비 기본값(마 단위 소량 4,000 / 롤 단위 7,000) — 주문 등록 폼의 기본값에만 쓴다.
export const SHIPPING_FEE = { cut: 4000, roll: 7000 };

// 택배 수거 마감 — courier.js 가 단일 출처. 화면 안내 문구용으로 다시 내보낸다.
export const PICKUP = { [CJ]: PICKUP_CUTOFF[CJ], [KD]: PICKUP_CUTOFF[KD] };

// 옛 ERP 로 보내는 링크 — 5메뉴 밖의 기능(포장 스캔·라벨·공지·메모 채팅·링크 관리)은 거기서 처리한다(지시서 1절 5항).
// saas 모드에서는 /legacy(같은 세션), company 모드(사내 배포)에서는 / (사내 게이트).
export const OLD_ERP_PATH = import.meta.env.VITE_MODE === "company" ? "/" : "/legacy";

// 홈의 "최근 주문" 줄 수, 목록 페이지 크기.
export const RECENT_ORDERS = 5;
export const PAGE_SIZE = 30;

// ── 회사별 설정(구독형) ─────────────────────────────────────────
// 위 상수는 "기본값"이다. 실제 값은 회사 설정 화면(/app/settings)이 settings.data.saas 에 저장하고,
// SaasData 가 resolveConfig() 로 합쳐 context.config 로 내려준다. 화면은 상수 대신 config 를 읽는다.
export const DEFAULT_CONFIG = {
  companyName: BRAND.tenant || "내 회사",   // 사이드바 프로필 아래 줄·담당자 선택 화면. company_accounts.name 이 있으면 그게 우선
  lowStockM: LOW_STOCK_M,
  shippingFee: { ...SHIPPING_FEE },
  productPrefix: DEFAULT_PREFIX,   // 품번 접두어(담당자 이니셜이 없을 때). 가입 때 아이디 앞 두 글자로 정해지고 설정에서 바꾼다
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/** settings.data.saas + company_accounts → 화면이 쓰는 설정 */
export function resolveConfig(settings, account) {
  const s = settings?.saas || {};
  return {
    companyName: String(account?.name || s.companyName || DEFAULT_CONFIG.companyName).trim() || DEFAULT_CONFIG.companyName,
    lowStockM: num(s.lowStockM, DEFAULT_CONFIG.lowStockM),
    shippingFee: {
      cut: num(s.shippingFee?.cut, DEFAULT_CONFIG.shippingFee.cut),
      roll: num(s.shippingFee?.roll, DEFAULT_CONFIG.shippingFee.roll),
    },
    productPrefix: PREFIX_RE.test(String(s.productPrefix || "").toUpperCase()) ? String(s.productPrefix).toUpperCase() : DEFAULT_CONFIG.productPrefix,
  };
}
