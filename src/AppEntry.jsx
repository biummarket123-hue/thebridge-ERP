// ERP 쪽 진입점 — main.jsx 가 React.lazy 로 부른다(공개 페이지 /o, /r 는 이 파일을 내려받지 않는다).
//
// 모드(VITE_MODE):
//   saas    (기본, 구독형 상품)  모든 경로 → 새 UI(/app). 회사 로그인·세션은 src/saas/auth/SaasAuth.jsx 가 맡는다.
//                               옛 화면(ErpApp)은 SaaS 상품에서 쓰지 않는다(2026-10-19 사용자 결정).
//   company (사내 배포 호환용)  / → 사내 비밀번호 게이트 + 옛 ErpApp.  /app → 새 UI.
// 두 모드는 코드만 같이 있을 뿐 서로 다른 Supabase 프로젝트를 가리킨다(.env.local).
import { useState, useEffect, lazy, Suspense } from "react";
import ErpApp from "./ErpApp.jsx";
import CompanyLogin from "./CompanyLogin.jsx";
import { CuteFullLoader } from "./components/UI.jsx";
import { GATE_TOKEN_KEY, GATE_UNTIL_KEY } from "./lib/db.js";
import { supabase } from "./lib/supabase.js";
import { BRAND } from "./saas/config.js";

const MODE = (() => { try { return import.meta.env.VITE_MODE || "saas"; } catch { return "saas"; } })();
const BRAND_LABEL = MODE === "company" ? "로하이마켓 ERP" : `${BRAND.name} ${BRAND.suffix}`;

const SaasAuth = lazy(() => import("./saas/auth/SaasAuth.jsx"));
const Landing = lazy(() => import("./saas/Landing.jsx"));

const LoadingScreen = () => <CuteFullLoader brand={BRAND_LABEL} />;

// 새 UI — 회사 세션을 스스로 확인한다(옛 게이트 토큰 기기도 통과).
function SaasRootGate() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SaasAuth />
    </Suspense>
  );
}

// 옛 화면 틀 — 위 44px 바(브랜드·로그아웃) + ErpApp. 두 모드가 같이 쓴다.
function LegacyShell({ onLogout }) {
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
          {BRAND_LABEL}
        </div>
        {/* 가운데 자리 — 휴대폰에서 ErpApp 이 여기에 '입고' 버튼을 그려 넣는다(createPortal). PC 에서는 비어 있다. */}
        <div id="app-top-slot" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)" }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onLogout} style={{
            padding: "6px 12px", borderRadius: 8,
            border: "1px solid #2E2820", background: "transparent",
            color: "#A89880", fontWeight: 600, fontSize: 11,
            cursor: "pointer", fontFamily: "'Noto Sans KR',sans-serif",
          }}>
            로그아웃
          </button>
        </div>
      </div>
      <div style={{ paddingTop: 44 }}>
        <ErpApp trialMode={false} />
      </div>
    </>
  );
}

// company 모드의 / — 사내 비밀번호 게이트(api/company-session) 뒤 옛 ErpApp.
function LegacyCompanyRoot() {
  const [authenticated, setAuthenticated] = useState(() => {
    // 만료시각까지 로그인 유지. 게이트 토큰(서버가 세션을 내주는 근거)이 함께 있어야 한다 —
    // 예전 플래그만 있는 기기는 세션을 받을 수 없으므로 한 번 다시 로그인한다.
    const until = parseInt(localStorage.getItem(GATE_UNTIL_KEY) || "0", 10);
    const hasGate = !!localStorage.getItem(GATE_TOKEN_KEY);
    if (until > Date.now() && hasGate) return true;
    localStorage.removeItem(GATE_UNTIL_KEY);
    localStorage.removeItem(GATE_TOKEN_KEY);
    sessionStorage.removeItem("company_authenticated");
    return false;
  });
  // db.js 가 게이트 토큰을 거부당하면(만료·키 교체) 로그인 화면으로 돌아간다.
  useEffect(() => {
    const onLost = () => setAuthenticated(false);
    window.addEventListener("company-gate-lost", onLost);
    return () => window.removeEventListener("company-gate-lost", onLost);
  }, []);

  if (!authenticated) return <CompanyLogin onSuccess={() => setAuthenticated(true)} />;

  return (
    <LegacyShell onLogout={async () => {
      // 반드시 scope:"local". 기본값 global 은 서버에서 이 계정의 refresh token 을 전부 폐기하는데,
      // 매장 전 기기가 같은 company 계정을 쓰므로 한 명의 로그아웃이 모든 기기를 끊는다.
      try { await supabase.auth.signOut({ scope: "local" }); } catch (e) { console.warn("[logout] signOut 실패", e); }
      localStorage.removeItem(GATE_UNTIL_KEY);
      localStorage.removeItem(GATE_TOKEN_KEY);
      sessionStorage.removeItem("company_authenticated");
      window.location.reload();
    }} />
  );
}

// saasUi: 경로가 /app… 인가. landing: 루트(/) 인가. main.jsx 가 정한다.
export default function AppEntry({ saasUi = false, landing = false }) {
  if (MODE === "company") return saasUi ? <SaasRootGate /> : <LegacyCompanyRoot />;
  if (landing) return <Suspense fallback={<LoadingScreen />}><Landing /></Suspense>;
  return <SaasRootGate />;
}
