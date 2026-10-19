// ERP 쪽 진입점 — main.jsx 에 있던 CompanyRoot / SaaS 분기가 그대로 옮겨온 것.
//
// main.jsx 에서 떼어 낸 이유: 공개 주문 페이지(/o/…)는 ERP 번들·회사 세션·supabase 클라이언트를
// 한 줄도 내려받으면 안 된다(4단계 지시서 1절). main.jsx 가 이 파일을 React.lazy 로 부르므로
// /o/ 경로에서는 여기(그리고 ErpApp·db.js·supabase.js)가 아예 로드되지 않는다.
import { useState, useEffect, lazy, Suspense } from "react";
import ErpApp from "./ErpApp.jsx";
import CompanyLogin from "./CompanyLogin.jsx";
import { CuteFullLoader } from "./components/UI.jsx";
import { GATE_TOKEN_KEY, GATE_UNTIL_KEY } from "./lib/db.js";
import { supabase } from "./lib/supabase.js";

const SaasRoot = lazy(() => import("./SaasRoot.jsx"));
// 새 SaaS UI(/app) — 회사 아이디·비밀번호 로그인(또는 이미 있는 세션) 뒤 담당자 PIN. 자기 게이트(SaasAuth)를 갖는다(2026-10-19).
const SaasAuth = lazy(() => import("./saas/auth/SaasAuth.jsx"));

// saasUi: main.jsx 가 경로(/app)로 정한다. 참이면 로그인 뒤 옛 ErpApp 대신 새 UI 를 그린다.
function CompanyRoot({ saasUi = false }) {
  if (saasUi) return <SaasRootGate />;
  return <LegacyCompanyRoot />;
}

// /app — 새 UI 는 회사 세션을 스스로 확인한다(옛 게이트 토큰 기기도 통과).
function SaasRootGate() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SaasAuth />
    </Suspense>
  );
}

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
          로하이마켓 ERP
        </div>
        {/* 가운데 자리 — 휴대폰에서 ErpApp 이 여기에 '입고' 버튼을 그려 넣는다(createPortal). PC 에서는 비어 있다. */}
        <div id="app-top-slot" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)" }} />
        <button onClick={async () => {
          // 이 브라우저의 Supabase 세션도 지운다 — 예전엔 플래그만 지워서 세션이 localStorage 에 남았다.
          // 반드시 scope:"local". 기본값 global 은 서버에서 이 계정의 refresh token 을 전부 폐기하는데,
          // 매장 전 기기가 같은 company 계정을 쓰므로 한 명의 로그아웃이 모든 기기를 끊는다.
          try { await supabase.auth.signOut({ scope: "local" }); } catch (e) { console.warn("[logout] signOut 실패", e); }
          localStorage.removeItem(GATE_UNTIL_KEY);
          localStorage.removeItem(GATE_TOKEN_KEY);
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

const LoadingScreen = () => <CuteFullLoader brand="로하이마켓 ERP" />;

export default function AppEntry({ saasUi = false }) {
  // 런타임 체크 - Vite tree-shaking 방지를 위해 컴포넌트 내부에서 분기
  const [mode] = useState(() => {
    try { return import.meta.env.VITE_MODE || "saas"; } catch { return "saas"; }
  });

  if (mode === "company") {
    return <CompanyRoot saasUi={saasUi} />;
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <SaasRoot />
    </Suspense>
  );
}
