// 진입점 — 경로만 보고 둘 중 하나를 lazy 로 부른다.
//   /o/{품번}  → 공개 주문 페이지(src/public/OrderLink.jsx). ERP·회사 세션·supabase 를 한 줄도 안 내려받는다.
//   /r/{롤번호} → 롤 정보 공개 화면(src/public/RollInfo.jsx). 롤 라벨 QR 을 핸드폰으로 찍으면 열린다. 같은 경계.
//   /app/…     → 새 SaaS UI(src/saas). 회사 로그인은 src/saas/auth/SaasAuth.jsx.
//   /          → saas 모드에서는 /app 으로 보낸다. company 모드(로하이마켓 사내 배포)에서는 옛 게이트 + ErpApp.
//   그 외      → src/AppEntry.jsx 가 모드에 따라 정한다.
// 여기에 ErpApp·db.js·supabase.js 를 정적으로 import 하면 안 된다 — 그 순간 공개 페이지 청크에 딸려 간다
// (4단계 지시서 1절·완료 기준 11).
import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { SaasLoader } from "./saas/components/Loading.jsx";   // 로고·CSS 만 — db·supabase 는 안 딸려 온다

const isOrderLink = typeof location !== "undefined" && /^\/o(\/|$)/.test(location.pathname);
const isRollInfo = typeof location !== "undefined" && /^\/r(\/|$)/.test(location.pathname);
const MODE = import.meta.env.VITE_MODE || "saas";
// SaaS 화면(홈·/app)은 첫 프레임부터 밝은 바탕이어야 한다 — index.css 의 어두운 body(옛 ERP·공개 페이지용)가
// 청크를 받는 동안 비치지 않도록, 그리기 전에 body 에 표시를 붙인다(index.html 의 인라인 스크립트와 같은 규칙).
const isSaasScreen = typeof location !== "undefined" && !isOrderLink && !isRollInfo && (MODE !== "company" || /^\/app(\/|$)/.test(location.pathname));
if (isSaasScreen) document.body.setAttribute("data-saas", "1");
if (typeof location !== "undefined" && MODE !== "company" && !/^\/(app|o|r)(\/|$)/.test(location.pathname) && !/^\/?$/.test(location.pathname)) {
  // 구독형 상품: / 는 홈(로그인·체험 갈림길), /app 은 ERP. 그 밖의 경로는 /app 으로.
  history.replaceState(null, "", "/app" + location.search + location.hash);
}
const isSaasUi = typeof location !== "undefined" && /^\/app(\/|$)/.test(location.pathname);
const isLanding = typeof location !== "undefined" && /^\/?$/.test(location.pathname);
const OrderLink = lazy(() => import("./public/OrderLink.jsx"));
const RollInfo = lazy(() => import("./public/RollInfo.jsx"));
const AppEntry = lazy(() => import("./AppEntry.jsx"));

// SaaS 화면은 새 UI 로더(로고·진행 막대). 공개 페이지(/o, /r)와 company 모드의 옛 화면은 테마가 제각각이라 중립적인 글자 하나만.
const Fallback = () => isSaasScreen ? <SaasLoader /> : (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#A89880", fontSize: 13, fontFamily: "'Noto Sans KR',sans-serif" }}>
    불러오는 중…
  </div>
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={<Fallback />}>
      {isOrderLink ? <OrderLink /> : isRollInfo ? <RollInfo /> : <AppEntry saasUi={isSaasUi} landing={isLanding} />}
    </Suspense>
  </StrictMode>
);
