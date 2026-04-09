import { useState, useEffect } from "react";
import { supabaseAuth, supabaseDB } from "./lib/supabase.js";
import Landing from "./Landing.jsx";
import ErpApp from "./ErpApp.jsx";
import { TrialBanner } from "./Auth.jsx";

const S = "'Noto Sans KR',sans-serif";
const SF = "'Noto Serif KR',serif";

// ── 구독 만료 결제 유도 화면 ──
function ExpiredScreen({ company, onLogout, onSubscribe }) {
  return (
    <div style={{ minHeight: "100vh", background: "#07050F", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: S }}>
      <div style={{ width: 380, padding: "48px 32px", borderRadius: 20, background: "#110E1E", border: "1px solid #252040", textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⏰</div>
        <div style={{ fontFamily: SF, fontSize: 22, fontWeight: 900, color: "#F0EBF8", marginBottom: 8 }}>
          무료체험이 종료되었습니다
        </div>
        <div style={{ fontSize: 13, color: "#8B82A8", marginBottom: 32, lineHeight: 1.6 }}>
          {company?.name || "회사"}의 무료체험 기간이 만료되었습니다.<br />
          구독을 시작하여 더브릿지 ERP를 계속 사용하세요.
        </div>

        <div style={{ background: "#1A1630", borderRadius: 16, border: "1px solid #252040", padding: "24px 20px", marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: "#8B82A8", marginBottom: 4 }}>더브릿지 ERP 프로</div>
          <div style={{ fontFamily: SF, fontSize: 36, fontWeight: 900, background: "linear-gradient(135deg,#7C3AED,#EC4899)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 4 }}>
            월 9,900원
          </div>
          <div style={{ fontSize: 11, color: "#8B82A8" }}>부가세 별도 · 언제든 해지 가능</div>
          <div style={{ marginTop: 16, fontSize: 12, color: "#A855F7", textAlign: "left", lineHeight: 2 }}>
            ✓ AI 주문 자동 분석<br />
            ✓ 무제한 주문/재고 관리<br />
            ✓ CJ/경동 송장 출력<br />
            ✓ 엑셀 업로드/다운로드<br />
            ✓ 담당자 관리 · 고객 관리
          </div>
        </div>

        <button onClick={onSubscribe} style={{
          width: "100%", padding: "14px 0", borderRadius: 12, border: "none",
          background: "linear-gradient(135deg,#7C3AED,#EC4899)", color: "#fff",
          fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: S,
          boxShadow: "0 4px 20px rgba(124,58,237,.4)", marginBottom: 12,
        }}>
          구독 시작하기
        </button>
        <button onClick={onLogout} style={{
          width: "100%", padding: "12px 0", borderRadius: 12,
          border: "1px solid #252040", background: "transparent",
          color: "#8B82A8", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: S,
        }}>
          로그아웃
        </button>
      </div>
    </div>
  );
}

// ── 만료 임박 배너 ──
function ExpiryBanner({ daysLeft }) {
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      background: "linear-gradient(90deg,#F59E0B,#EC4899)", padding: "8px 16px",
      display: "flex", justifyContent: "center", alignItems: "center", gap: 10,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", fontFamily: S }}>
        ⚠️ 무료체험 {daysLeft}일 남았습니다.
      </span>
      <button onClick={() => alert("결제 페이지 준비 중입니다.")} style={{
        padding: "4px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,.5)",
        background: "rgba(255,255,255,.15)", color: "#fff", fontSize: 11,
        fontWeight: 700, cursor: "pointer", fontFamily: S,
      }}>
        구독하기
      </button>
    </div>
  );
}

export default function SaasRoot() {
  const [session, setSession] = useState(undefined);
  const [loginSource, setLoginSource] = useState(null);
  const [trialMode, setTrialMode] = useState(false);
  const [company, setCompany] = useState(null);
  const [subStatus, setSubStatus] = useState("loading"); // loading | active | expiring | expired

  // 비움마켓 → SaaS DB 미러 동기화
  const syncBiumToSaasDB = async (biumUser) => {
    const email = biumUser.email;
    const syncPass = `bium_sync_${email}_bridge2026`;
    const { data: signInData } = await supabaseDB.auth.signInWithPassword({ email, password: syncPass });
    if (signInData?.session) return;
    await fetch("/api/sync-bium-user", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    await supabaseDB.auth.signInWithPassword({ email, password: syncPass });
  };

  // 구독 상태 체크
  const checkSubscription = async (userEmail) => {
    const { data } = await supabaseDB.from("companies").select("*").eq("owner_email", userEmail).single();
    if (!data) { setSubStatus("active"); return; } // 회사 정보 없으면 일단 허용
    setCompany(data);

    // 유료 구독은 항상 활성
    if (["basic", "pro", "enterprise"].includes(data.plan)) {
      setSubStatus("active");
      return;
    }

    // trial 상태
    if (!data.trial_end) { setSubStatus("active"); return; }
    const now = new Date();
    const end = new Date(data.trial_end);
    const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));

    if (daysLeft <= 0) {
      setSubStatus("expired");
    } else if (daysLeft <= 7) {
      setSubStatus("expiring");
    } else {
      setSubStatus("active");
    }
  };

  useEffect(() => {
    if (sessionStorage.getItem("trial_mode") === "true") {
      const start = parseInt(sessionStorage.getItem("trial_start") || "0", 10);
      if (Date.now() - start < 60 * 60 * 1000) {
        setTrialMode(true);
        setSession(null);
        setSubStatus("active");
        return;
      }
      sessionStorage.clear();
    }

    async function checkSessions() {
      const { data: { session: dbSession } } = await supabaseDB.auth.getSession();
      if (dbSession) {
        setSession(dbSession);
        setLoginSource("thebridge");
        await checkSubscription(dbSession.user.email);
        return;
      }

      const { data: { session: authSession } } = await supabaseAuth.auth.getSession();
      if (authSession) {
        await syncBiumToSaasDB(authSession.user);
        setSession(authSession);
        setLoginSource("biummarket");
        await checkSubscription(authSession.user.email);
        return;
      }

      setSession(null);
    }

    checkSessions();

    const { data: { subscription: dbSub } } = supabaseDB.auth.onAuthStateChange((_event, s) => {
      if (s) {
        setSession(s);
        setLoginSource("thebridge");
        checkSubscription(s.user.email);
      } else if (!trialMode) {
        supabaseAuth.auth.getSession().then(({ data: { session: authS } }) => {
          if (authS) {
            setSession(authS);
            setLoginSource("biummarket");
            checkSubscription(authS.user.email);
          } else {
            setSession(null);
            setLoginSource(null);
          }
        });
      }
    });

    const { data: { subscription: authSub } } = supabaseAuth.auth.onAuthStateChange((_event, s) => {
      if (s && !session) {
        syncBiumToSaasDB(s.user).then(() => {
          setSession(s);
          setLoginSource("biummarket");
          checkSubscription(s.user.email);
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
    await supabaseDB.auth.signOut();
    await supabaseAuth.auth.signOut();
    setSession(null);
    setLoginSource(null);
    setSubStatus("loading");
    setCompany(null);
  };

  // 로딩
  if ((session === undefined && !trialMode) || (session && subStatus === "loading")) {
    return (
      <div style={{ minHeight: "100vh", background: "#07050F", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#C084FC", fontSize: 15, fontFamily: S }}>로딩 중...</div>
      </div>
    );
  }

  // 구독 만료 → 결제 유도
  if (session && subStatus === "expired") {
    return (
      <ExpiredScreen
        company={company}
        onLogout={handleLogout}
        onSubscribe={() => alert("결제 페이지 준비 중입니다.")}
      />
    );
  }

  // 로그인 완료 → ERP
  if (session || trialMode) {
    const daysLeft = company?.trial_end
      ? Math.ceil((new Date(company.trial_end) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const showExpiryBanner = subStatus === "expiring" && daysLeft > 0;
    const topOffset = (trialMode ? 36 : 0) + (showExpiryBanner ? 36 : 0);

    return (
      <>
        {trialMode && <TrialBanner />}
        {showExpiryBanner && <ExpiryBanner daysLeft={daysLeft} />}
        <div style={{
          position: "fixed", top: topOffset, left: 0, right: 0, zIndex: 900,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 16px",
          background: "rgba(13,11,9,0.85)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid #2E2820",
        }}>
          <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 900, background: "linear-gradient(135deg,#7C3AED,#EC4899,#F59E0B)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
            더브릿지 ERP
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {session && (
              <span style={{ fontSize: 11, color: "#A89880" }}>
                {session.user?.email?.replace("@thebridge.erp", "")}
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
              cursor: "pointer", fontFamily: S,
            }}>
              {trialMode ? "체험 종료" : "로그아웃"}
            </button>
          </div>
        </div>
        <div style={{ paddingTop: topOffset + 44 }}>
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
          supabaseAuth.auth.getSession().then(({ data: { session: s } }) => {
            setSession(s);
            checkSubscription(user.email);
          });
        } else {
          supabaseDB.auth.getSession().then(({ data: { session: s } }) => {
            setSession(s);
            checkSubscription(user.email);
          });
        }
      }}
      onTrial={() => { setTrialMode(true); setSubStatus("active"); }}
    />
  );
}
