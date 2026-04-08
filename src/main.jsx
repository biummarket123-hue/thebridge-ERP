import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { supabaseAuth } from "./lib/supabase.js";
import Landing from "./Landing.jsx";
import ErpApp from "./ErpApp.jsx";
import { TrialBanner } from "./Auth.jsx";
import "./index.css";

function Root() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [trialMode, setTrialMode] = useState(false);

  useEffect(() => {
    // 체험판 복원
    if (sessionStorage.getItem("trial_mode") === "true") {
      const start = parseInt(sessionStorage.getItem("trial_start") || "0", 10);
      if (Date.now() - start < 60 * 60 * 1000) {
        setTrialMode(true);
        setSession(null);
        return;
      }
      sessionStorage.clear();
    }

    supabaseAuth.auth.getSession().then(({ data: { session: s } }) => setSession(s));

    const { data: { subscription } } = supabaseAuth.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) setTrialMode(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    if (trialMode) {
      sessionStorage.clear();
      window.location.reload();
      return;
    }
    await supabaseAuth.auth.signOut();
  };

  // 로딩
  if (session === undefined && !trialMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#07050F", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#C084FC", fontSize: 15, fontFamily: "'Noto Sans KR',sans-serif" }}>로딩 중...</div>
      </div>
    );
  }

  // 로그인 완료 또는 체험판 → ErpApp
  if (session || trialMode) {
    return (
      <>
        {trialMode && <TrialBanner />}
        {/* 상단 바 */}
        <div style={{
          position: "fixed", top: trialMode ? 36 : 0, left: 0, right: 0, zIndex: 900,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 16px",
          background: "rgba(13,11,9,0.85)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid #2E2820",
        }}>
          <div style={{ fontFamily: "'Noto Serif KR',serif", fontSize: 15, fontWeight: 900, background: "linear-gradient(135deg,#7C3AED,#EC4899,#F59E0B)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
            더브릿지 ERP
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {session && (
              <span style={{ fontSize: 11, color: "#A89880" }}>
                {session.user?.email}
              </span>
            )}
            {trialMode && (
              <span style={{ fontSize: 11, color: "#C084FC", fontWeight: 600 }}>체험판</span>
            )}
            <button onClick={handleLogout} style={{
              padding: "6px 12px", borderRadius: 8,
              border: "1px solid #2E2820", background: "transparent",
              color: "#A89880", fontWeight: 600, fontSize: 11,
              cursor: "pointer", fontFamily: "'Noto Sans KR',sans-serif",
            }}>
              {trialMode ? "체험 종료" : "로그아웃"}
            </button>
          </div>
        </div>
        <div style={{ paddingTop: trialMode ? 80 : 44 }}>
          <ErpApp trialMode={trialMode} />
        </div>
      </>
    );
  }

  // 미로그인 → 랜딩 페이지 (로그인 모달 내장)
  return (
    <Landing
      onLogin={() => supabaseAuth.auth.getSession().then(({ data: { session: s } }) => setSession(s))}
      onTrial={() => setTrialMode(true)}
    />
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
