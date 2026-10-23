// 요금제 — 서버 쪽 단일 출처(2026-10-23 사용자 결정). 순수 상수만, import 없음(tests 가 그대로 읽는다).
// 화면 쪽 src/saas/lib/subscription.js PLANS 와 값이 같아야 한다(화면은 안내, 여기가 강제).
//
//   스타터   9,900  담당자 2  AI 월 10회(맛보기)   문자 없음
//   스탠다드 39,000 담당자 5  AI 월 300회          문자 월 200건
//   프로     89,000 담당자 무제한 AI 월 2,000회     문자 월 1,000건
//   프로 MAX 149,000(가격 미정 — 환경변수 SAAS_PRICE_PROMAX 로 바꾼다) 담당자 무제한 AI 월 3,000회 문자 월 2,000건
//            — 프로를 구독 중인 회사에만 보이고 고를 수 있다(canPickPlan). 다른 회사는 프로까지만.
//
// 돈이 드는 것(AI 토큰·문자 원가)은 월 할당량으로 막는다. 넘기면 그 달은 막고 상위 요금제를 안내한다(건당 추가 과금 없음).
// 옛 이름 basic(2026-10-23 이전) 은 standard 로 읽는다 — migrations/saas_plans_v2.sql 이 DB 값도 옮긴다.
//
// 파일 이름이 _ 로 시작해 Vercel 이 서버 함수로 배포하지 않는다.

export const PAID_PLANS = ["starter", "standard", "pro", "promax"];
export const PLAN_LABELS = { trial: "무료 체험", starter: "스타터", standard: "스탠다드", pro: "프로", promax: "프로 MAX" };
export const PLAN_SEATS = { trial: 3, starter: 2, standard: 5, pro: 99, promax: 99 };          // max_managers(공용 담당자 제외)
export const PLAN_AI_CALLS = { trial: 0, starter: 10, standard: 300, pro: 2000, promax: 3000 };  // 월 AI 분석 호출 수(체험은 SAAS_TRIAL_AI_CALLS 가 따로)
export const PLAN_SMS = { trial: 0, starter: 0, standard: 200, pro: 1000, promax: 2000 };        // 월 출고 안내 문자 건수(2026-10-23 원가 계산 뒤 조정 — 문자 원가 약 20원/건)
export const DEFAULT_PRICES = { starter: 9900, standard: 39000, pro: 89000, promax: 149000 };    // 원/월 · 부가세 별도
export const PRICE_ENV = { starter: "SAAS_PRICE_STARTER", standard: "SAAS_PRICE_STANDARD", pro: "SAAS_PRICE_PRO", promax: "SAAS_PRICE_PROMAX" };

const LEGACY = { basic: "standard" };
/** 옛 요금제 이름 → 지금 이름. 모르는 값은 그대로. */
export const normalizePlan = (p) => LEGACY[String(p || "")] || String(p || "");
export const isPaidPlan = (p) => PAID_PLANS.includes(normalizePlan(p));
/** 프로 MAX 는 프로(또는 이미 프로 MAX)인 회사만. currentPlan 은 company_accounts.plan */
export const canPickPlan = (plan, currentPlan) => normalizePlan(plan) !== "promax" || ["pro", "promax"].includes(normalizePlan(currentPlan));
/** 회사가 고를 수 있는 유료 요금제 — 화면의 요금제 카드 목록 */
export const pickablePlans = (currentPlan) => PAID_PLANS.filter(k => canPickPlan(k, currentPlan));
export const MSG_PROMAX_ONLY = "프로 MAX 는 프로를 구독 중인 회사만 고를 수 있습니다. 먼저 프로로 바꿔 주세요.";
