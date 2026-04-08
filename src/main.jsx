import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase.js";
import Auth, { TrialBanner } from "./Auth.jsx";
import App from "./App.jsx";
import "./index.css";

function Root() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [trialMode, setTrialMode] = useState(false);

  useEffect(() => {
    // 체험판 복원
    if (sessionStorage.getItem("trial_mode") === "true") {
      const start = parseInt(sessionStorage.getItem("trial_start") || "0", 10);
      const elapsed = Date.now() - start;
      if (elapsed < 60 * 60 * 1000) {
        setTrialMode(true);
        setSession(null);
        return;
      } else {
        sessionStorage.clear();
      }
    }

    // Supabase 세션 체크
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) setTrialMode(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // 로딩 중
  if (session === undefined && !trialMode) {
    return (
      <div style={{ minHeight: "100vh", background: "#0D0B09", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#C8794A", fontSize: 16, fontFamily: "'Noto Sans KR', sans-serif" }}>
          로딩 중...
        </div>
      </div>
    );
  }

  // 로그인 안 됨 + 체험판 아님
  if (!session && !trialMode) {
    return (
      <Auth
        onLogin={() => {
          supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s));
        }}
        onTrial={() => setTrialMode(true)}
      />
    );
  }

  // 체험판 모드
  if (trialMode) {
    return (
      <>
        <TrialBanner />
        <App trialMode={true} />
      </>
    );
  }

  // 로그인 완료
  return <App trialMode={false} session={session} />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
