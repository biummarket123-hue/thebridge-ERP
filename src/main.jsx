import { StrictMode, useState, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import ErpApp from "./ErpApp.jsx";
import CompanyLogin from "./CompanyLogin.jsx";
import "./index.css";

const SaasRoot = lazy(() => import("./SaasRoot.jsx"));

function CompanyRoot() {
  const [authenticated, setAuthenticated] = useState(
    () => sessionStorage.getItem("company_authenticated") === "true"
  );

  if (!authenticated) {
    return <CompanyLogin onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <>
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 900,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "8px 16px",
        background: "rgba(13,11,9,0.85)", backdropFilter: "blur(8px)",
        borderBottom: "1px solid #2E2820",
      }}>
        <div style={{ fontFamily: "'Noto Serif KR',serif", fontSize: 15, fontWeight: 900, background: "linear-gradient(135deg,#7C3AED,#EC4899,#F59E0B)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
          더브릿지 ERP
        </div>
        <button onClick={() => {
          sessionStorage.removeItem("company_authenticated");
          window.location.reload();
        }} style={{
          padding: "6px 12px", borderRadius: 8,
          border: "1px solid #2E2820", background: "transparent",
          color: "#A89880", fontWeight: 600, fontSize: 11,
          cursor: "pointer", fontFamily: "'Noto Sans KR',sans-serif",
        }}>
          로그아웃
        </button>
      </div>
      <div style={{ paddingTop: 44 }}>
        <ErpApp trialMode={false} />
      </div>
    </>
  );
}

const LoadingScreen = () => (
  <div style={{ minHeight: "100vh", background: "#07050F", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div style={{ color: "#C084FC", fontSize: 15, fontFamily: "'Noto Sans KR',sans-serif" }}>로딩 중...</div>
  </div>
);

function App() {
  // 런타임 체크 - Vite tree-shaking 방지를 위해 컴포넌트 내부에서 분기
  const [mode] = useState(() => {
    try { return import.meta.env.VITE_MODE || "saas"; } catch { return "saas"; }
  });

  if (mode === "company") {
    return <CompanyRoot />;
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <SaasRoot />
    </Suspense>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
