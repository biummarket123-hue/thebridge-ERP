import { useState, useEffect } from "react";
import { supabaseAuth, supabaseDB } from "./lib/supabase.js";
import Landing from "./Landing.jsx";
import ErpApp from "./ErpApp.jsx";
import { TrialBanner } from "./Auth.jsx";

export default function SaasRoot() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [loginSource, setLoginSource] = useState(null); // "biummarket" | "thebridge"
  const [trialMode, setTrialMode] = useState(false);

  // 비움마켓 → SaaS DB 미러 동기화
  const syncBiumToSaasDB = async (biumUser) => {
    const email = biumUser.email;
    const syncPass = `bium_sync_${email}_bridge2026`;
    const { data: signInData } = await supabaseDB.auth.signInWithPassword({ email, password: syncPass });
    if (signInData?.session) return;
    // 서버에서 미러 계정 생성 후 로그인
    await fetch("/api/sync-bium-user", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    await supabaseDB.auth.signInWithPassword({ email, password: syncPass });
  };

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

    // 두 Supabase 모두 세션 체크
    async function checkSessions() {
      // 1. 더브릿지 자체 세션 확인
      const { data: { session: dbSession } } = await supabaseDB.auth.getSession();
      if (dbSession) {
        setSession(dbSession);
        setLoginSource("thebridge");
        return;
      }

      // 2. 비움마켓 세션 확인 → SaaS DB 동기화
      const { data: { session: authSession } } = await supabaseAuth.auth.getSession();
      if (authSession) {
        await syncBiumToSaasDB(authSession.user);
        setSession(authSession);
        setLoginSource("biummarket");
        return;
      }

      setSession(null);
    }

    checkSessions();

    // 더브릿지 auth 상태 변경 감지
    const { data: { subscription: dbSub } } = supabaseDB.auth.onAuthStateChange((_event, s) => {
      if (s) {
        setSession(s);
        setLoginSource("thebridge");
      } else if (!trialMode) {
        supabaseAuth.auth.getSession().then(({ data: { session: authS } }) => {
          if (authS) {
            setSession(authS);
            setLoginSource("biummarket");
          } else {
            setSession(null);
            setLoginSource(null);
          }
        });
      }
    });

    // 비움마켓 auth 상태 변경 감지 → SaaS DB 동기화
    const { data: { subscription: authSub } } = supabaseAuth.auth.onAuthStateChange((_event, s) => {
      if (s && !session) {
        syncBiumToSaasDB(s.user).then(() => {
          setSession(s);
          setLoginSource("biummarket");
        });
      } else if (!s && loginSource === "biummarket") {
        setSession(null);
        setLoginSource(null);
      }
    });

    return () => {
      dbSub.unsubscribe();
      authSub.unsubscribe();
    };
  }, []);

  const handleLogout = async () => {
    if (trialMode) {
      sessionStorage.clear();
      window.location.reload();
      return;
    }
    // 둘 다 로그아웃
    await supabaseDB.auth.signOut();
    await supabaseAuth.auth.signOut();
    setSession(null);
    setLoginSource(null);
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
                {loginSource === "biummarket" && <span style={{ color: "#C084FC", marginLeft: 4 }}>(비움마켓)</span>}
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

  // 미로그인 → 랜딩
  return (
    <Landing
      onLogin={(user, source) => {
        setLoginSource(source);
        if (source === "biummarket") {
          supabaseAuth.auth.getSession().then(({ data: { session: s } }) => setSession(s));
        } else {
          supabaseDB.auth.getSession().then(({ data: { session: s } }) => setSession(s));
        }
      }}
      onTrial={() => setTrialMode(true)}
    />
  );
}
