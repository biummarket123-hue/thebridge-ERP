import { useState } from "react";
import { supabase } from "./lib/supabase.js";
import Landing from "./Landing.jsx";
import ErpApp from "./ErpApp.jsx";

export default function App({ trialMode = false, session = null }) {
  const [view, setView] = useState("landing");

  const handleLogout = async () => {
    if (trialMode) {
      sessionStorage.clear();
      window.location.reload();
      return;
    }
    await supabase.auth.signOut();
  };

  if (view === "erp") {
    return (
      <div>
        {/* 상단 바 */}
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 900,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 16px",
          background: "rgba(13,11,9,0.85)", backdropFilter: "blur(8px)",
          borderBottom: "1px solid #2E2820",
        }}>
          <button onClick={() => setView("landing")} style={{
            padding: "6px 12px", borderRadius: 8,
            background: "linear-gradient(135deg,#7C3AED,#A855F7)",
            color: "#fff", fontWeight: 800, fontSize: 11,
            border: "none", cursor: "pointer",
            fontFamily: "'Noto Sans KR',sans-serif",
          }}>
            &#8592; 홈
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {session && (
              <span style={{ fontSize: 11, color: "#A89880" }}>
                {session.user?.email}
              </span>
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
        <div style={{ paddingTop: 44 }}>
          <ErpApp trialMode={trialMode} />
        </div>
      </div>
    );
  }

  return <Landing onStart={() => setView("erp")} />;
}
