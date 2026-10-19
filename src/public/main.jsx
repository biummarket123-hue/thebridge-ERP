// 고객용 공개 주소(info.lowhigh-market.com)의 진입점 — info.html 이 부른다.
//   /r/{롤번호} → 롤 정보(RollInfo.jsx)   /o/…  → 링크 주문(OrderLink.jsx)   그 외 → 로하이마켓 안내 한 장
// ERP(AppEntry·ErpApp·db.js·supabase.js)는 이 진입점에서 아예 닿지 않는다 — 주소를 지워 첫 화면으로 가도
// 로그인 화면이 나오지 않게 하려는 것이다(2026-10-02, ERP 주소를 고객에게 드러내지 않기로 함).
// vercel.json 이 그 호스트의 모든 경로(api·assets 빼고)를 info.html 로 보낸다.
import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

const path = typeof location !== "undefined" ? location.pathname : "/";
const RollInfo = lazy(() => import("./RollInfo.jsx"));
const OrderLink = lazy(() => import("./OrderLink.jsx"));

const Home = () => (
  <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F7F4EE", fontFamily: "'Noto Sans KR', system-ui, sans-serif", color: "#2B2622", padding: 24, boxSizing: "border-box" }}>
    <div style={{ textAlign: "center" }}>
      <img src="/lohi-logo.png" alt="" style={{ width: 96, height: "auto", marginBottom: 14 }} />
      <div style={{ fontSize: 24, fontWeight: 900 }}>로하이마켓</div>
      <div style={{ fontSize: 15, color: "#7A7067", marginTop: 8, lineHeight: 1.6 }}>원단 롤의 QR 을 찍으면 원단 정보를 볼 수 있습니다.</div>
    </div>
  </div>
);
const Fallback = () => <div style={{ minHeight: "100vh", background: "#F7F4EE" }} />;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={<Fallback />}>
      {/^\/r\/./.test(path) ? <RollInfo /> : /^\/o(\/|$)/.test(path) ? <OrderLink /> : <Home />}
    </Suspense>
  </StrictMode>
);
