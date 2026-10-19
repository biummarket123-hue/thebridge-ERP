// 진입점 — 경로만 보고 둘 중 하나를 lazy 로 부른다.
//   /o/{품번}  → 공개 주문 페이지(src/public/OrderLink.jsx). ERP·회사 세션·supabase 를 한 줄도 안 내려받는다.
//   /r/{롤번호} → 롤 정보 공개 화면(src/public/RollInfo.jsx). 롤 라벨 QR 을 핸드폰으로 찍으면 열린다. 같은 경계.
//   그 외      → ERP(src/AppEntry.jsx — 예전 main.jsx 의 CompanyRoot / SaaS 분기).
// 여기에 ErpApp·db.js·supabase.js 를 정적으로 import 하면 안 된다 — 그 순간 공개 페이지 청크에 딸려 간다
// (4단계 지시서 1절·완료 기준 11).
import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const isOrderLink = typeof location !== "undefined" && /^\/o(\/|$)/.test(location.pathname);
const isRollInfo = typeof location !== "undefined" && /^\/r(\/|$)/.test(location.pathname);
const OrderLink = lazy(() => import("./public/OrderLink.jsx"));
const RollInfo = lazy(() => import("./public/RollInfo.jsx"));
const AppEntry = lazy(() => import("./AppEntry.jsx"));

// 두 화면의 테마가 달라(ERP 는 어두운 배경, 공개 페이지는 밝은 배경) 로더는 중립적인 글자 하나만 둔다.
const Fallback = () => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#A89880", fontSize: 13, fontFamily: "'Noto Sans KR',sans-serif" }}>
    불러오는 중…
  </div>
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={<Fallback />}>
      {isOrderLink ? <OrderLink /> : isRollInfo ? <RollInfo /> : <AppEntry />}
    </Suspense>
  </StrictMode>
);
