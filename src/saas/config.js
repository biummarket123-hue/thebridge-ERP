// 회사별 값 — 새 UI 코드 곳곳에 숫자를 다시 박지 않고 여기 한 파일에 모은다(지시서 1절 4항).
// 2차에서 회사 설정 화면으로 옮길 후보. 옛 코드(constants·courier·freight)가 쓰는 값은 거기서 그대로 읽는다 —
// 여기는 새 UI 가 화면에 보여주거나 기본값으로 쓰는 것만.
import { CJ, KD, DEFAULT_COURIERS, DEFAULT_PICKUP_CUTOFF, COURIER_FORMATS } from "../lib/courier.js";
import { PREFIX_RE, DEFAULT_PREFIX } from "../lib/rollStock.js";

// 고객 문의 창구(2026-10-23) — 환경변수로 넣는다. 하나도 없으면 화면의 문의 조각(components/SupportLinks.jsx)이 비워진다.
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
export const SUPPORT = {
  phone: String(ENV.VITE_SUPPORT_PHONE || "").trim(),    // 예: 010-1234-5678
  kakao: String(ENV.VITE_SUPPORT_KAKAO || "").trim(),    // 카카오톡 채널 주소 예: https://pf.kakao.com/_abc
  email: String(ENV.VITE_SUPPORT_EMAIL || "").trim(),
  hours: String(ENV.VITE_SUPPORT_HOURS || "").trim(),    // 예: 평일 10~18시
};
SUPPORT.any = !!(SUPPORT.phone || SUPPORT.kakao || SUPPORT.email);

export const BRAND = {
  name: "THE BRIDGE",    // 서비스 이름(2026-10-23 사용자 결정: 루프 → THE BRIDGE). 접미사와 띄어 쓴다 — 화면은 {BRAND.name} <span>{BRAND.suffix}</span>
  suffix: "ERP",
  caption: "비즈니스를 더 가볍게",
  tenant: "",            // 로그인한 회사 — 회사 계정(company_accounts.name)·설정에서 온다. 비어 있으면 아래 기본 문구.
};

// 재고 기준 — 품번의 최대 재단 가능 길이(가장 긴 롤)가 이 값보다 짧으면 "재고 부족"(지시서 5절).
export const LOW_STOCK_M = 10;

// 택배비 기본값(마 단위 소량 4,000 / 롤 단위 7,000) — 주문 등록 폼의 기본값에만 쓴다.
export const SHIPPING_FEE = { cut: 4000, roll: 7000 };



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
  pickupCutoff: DEFAULT_PICKUP_CUTOFF,   // 택배 수거 마감(회사에 하나) — 출고예정일 안내·전체현황 "수거 놓침" 판정. lib/courier.js setPickupCutoff 에 들어간다
  // 택배사 목록(사용자 결정 2026-10-23: CJ·경동만이 아니고, 자동 배정 없이 송장 뽑을 때 고른다). 회사 설정 > 택배사에서 이름·줄임·송장 양식을 정한다.
  couriers: DEFAULT_COURIERS.map(c => ({ ...c })),
  // 발송인 정보(송장·명세서) — name 이 비면 회사명, phone 이 비면 company_accounts.contact
  sender: { name: "", phone: "", address: "", zip: "" },
  // 경동화물 송장 기본값 — actions/invoice.js 의 경동 행이 쓴다
  kd: { payType: "선불", itemName: "원단", unitPrice: 100, extraFee: 100 },   // payType 은 택배사 항목(couriers[].payType)이 우선 — 설정 화면은 거기서만 고른다(2026-10-23)
  // 출고 안내 문자(유료 전용). 문자 발송 API 는 따로 만든다 — 여기는 켜짐 여부와 문구만.
  logo: "",   // 회사 로고(작은 데이터 URL). 비면 서비스 마크. 회사 설정 > 회사 정보에서 올린다
  notifySms: false,
  notifySmsTemplate: "[{회사명}] {고객명}님, 주문하신 원단이 오늘 {택배사}로 출고되었습니다.",
};
export const KD_PAY_TYPES = ["선불", "후불"];
const hhmm = (v, d) => /^\d{1,2}:\d{2}$/.test(String(v || "")) ? String(v) : d;

// ── 택배사 목록 ──
export const COURIER_FORMAT_LABELS = { generic: "범용(받는분·전화·주소)", cj: "CJ대한통운 양식", kd: "경동화물 양식" };
const fmtOf = (name, f) => COURIER_FORMATS.includes(f) ? f : name === CJ ? "cj" : name === KD ? "kd" : "generic";
/**
 * 설정 화면의 입력을 검사해 저장할 목록을 만든다. 틀리면 { error }, 맞으면 { couriers }.
 *   이름 1~20자·중복 없음, 줄임 1~6자(비면 이름 앞 두 글자), 양식 generic|cj|kd, 경동 양식이면 선불/후불(이상하면 선불).
 */
export function validateCouriers(list) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return { error: "택배사를 하나 이상 두어야 합니다" };
  const out = [], seen = new Set();
  for (const c of rows) {
    const name = String(c?.name || "").replace(/\s+/g, " ").trim();
    if (!name) return { error: "택배사 이름이 비어 있습니다" };
    if (name.length > 20) return { error: `택배사 이름은 20자 안으로: ${name}` };
    if (seen.has(name)) return { error: `같은 택배사가 두 번 있습니다: ${name}` };
    seen.add(name);
    const short = String(c?.short || "").trim() || name.slice(0, 2);
    if (short.length > 6) return { error: `줄임말은 6자 안으로: ${short}` };
    const format = fmtOf(name, c?.format);
    out.push({ name, short, format, ...(format === "kd" ? { payType: KD_PAY_TYPES.includes(c?.payType) ? c.payType : KD_PAY_TYPES[0] } : {}) });
  }
  return { couriers: out };
}
/** 저장된 값 → 화면 목록. 저장된 목록이 없거나 이상하면 기본 둘. */
export function resolveCouriers(raw) {
  const v = validateCouriers(raw);
  return v.error ? DEFAULT_COURIERS.map(c => ({ ...c })) : v.couriers;
}
/** 수거 마감 — 문자열 "HH:MM". 옛 저장값(택배사별 객체 { "CJ대한통운": "15:30", … })이면 첫 값을 쓴다. */
export function resolvePickupCutoff(raw) {
  if (typeof raw === "string") return hhmm(raw, DEFAULT_PICKUP_CUTOFF);
  if (raw && typeof raw === "object") { const first = raw[CJ] || Object.values(raw).find(v => /^\d{1,2}:\d{2}$/.test(String(v || ""))); return hhmm(first, DEFAULT_PICKUP_CUTOFF); }
  return DEFAULT_PICKUP_CUTOFF;
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const str = (v, d = "") => (v === undefined || v === null) ? d : String(v).trim();

/** settings.data.saas + company_accounts → 화면이 쓰는 설정 */
export function resolveConfig(settings, account) {
  const s = settings?.saas || {};
  const companyName = String(account?.name || s.companyName || DEFAULT_CONFIG.companyName).trim() || DEFAULT_CONFIG.companyName;
  const couriers = resolveCouriers(s.couriers);
  return {
    companyName,
    lowStockM: num(s.lowStockM, DEFAULT_CONFIG.lowStockM),
    shippingFee: {
      cut: num(s.shippingFee?.cut, DEFAULT_CONFIG.shippingFee.cut),
      roll: num(s.shippingFee?.roll, DEFAULT_CONFIG.shippingFee.roll),
    },
    productPrefix: PREFIX_RE.test(String(s.productPrefix || "").toUpperCase()) ? String(s.productPrefix).toUpperCase() : DEFAULT_CONFIG.productPrefix,
    couriers,
    pickupCutoff: resolvePickupCutoff(s.pickupCutoff),
    sender: {
      name: str(s.sender?.name) || companyName,
      phone: str(s.sender?.phone) || str(account?.contact),
      address: str(s.sender?.address),
      zip: str(s.sender?.zip),
    },
    kd: {
      payType: KD_PAY_TYPES.includes(s.kd?.payType) ? s.kd.payType : DEFAULT_CONFIG.kd.payType,
      itemName: str(s.kd?.itemName) || DEFAULT_CONFIG.kd.itemName,
      unitPrice: num(s.kd?.unitPrice, DEFAULT_CONFIG.kd.unitPrice),
      extraFee: num(s.kd?.extraFee, DEFAULT_CONFIG.kd.extraFee),
    },
    logo: String(s.logo || "").startsWith("data:image/") ? String(s.logo) : "",
    notifySms: s.notifySms === true,
    notifySmsTemplate: str(s.notifySmsTemplate) || DEFAULT_CONFIG.notifySmsTemplate,
  };
}
