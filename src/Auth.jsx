import { useState } from "react";

const G = {
  copper: "#C8794A", copperLight: "#E8956A",
  cream: "#F0E6D6", creamMuted: "#A89880", white: "#FFFFFF",
};
const S = "'Noto Sans KR','Apple SD Gothic Neo',sans-serif";
const SF = "'Noto Serif KR','Apple SD Gothic Neo',serif";

// 체험판 타이머 배너
export function TrialBanner() {
  const [remaining, setRemaining] = useState("");
  const [expired, setExpired] = useState(false);

  useState(() => {
    const interval = setInterval(() => {
      const start = parseInt(sessionStorage.getItem("trial_start") || "0", 10);
      if (!start) return;
      const elapsed = Date.now() - start;
      const limit = 60 * 60 * 1000;
      const left = limit - elapsed;
      if (left <= 0) {
        setExpired(true);
        setRemaining("만료됨");
        clearInterval(interval);
        return;
      }
      const mins = Math.floor(left / 60000);
      const secs = Math.floor((left % 60000) / 1000);
      setRemaining(`${mins}분 ${String(secs).padStart(2, "0")}초 남음`);
    }, 1000);
    return () => clearInterval(interval);
  });

  if (expired) {
    return (
      <div style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ textAlign: "center", color: G.cream }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>&#9202;</div>
          <div style={{ fontFamily: SF, fontSize: 22, fontWeight: 700, marginBottom: 8 }}>체험 시간이 만료되었습니다</div>
          <div style={{ fontSize: 14, color: G.creamMuted, marginBottom: 24 }}>회원가입 후 계속 이용해보세요!</div>
          <button onClick={() => { sessionStorage.clear(); window.location.reload(); }}
            style={{
              padding: "14px 32px", borderRadius: 12, border: "none",
              background: `linear-gradient(135deg, ${G.copper}, ${G.copperLight})`,
              color: G.white, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: S,
            }}>
            로그인 / 회원가입으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      padding: "8px 16px", textAlign: "center",
      background: "rgba(124,58,237,0.15)", backdropFilter: "blur(8px)",
      borderBottom: "1px solid rgba(124,58,237,0.3)",
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "#C084FC", fontFamily: S }}>
        &#9202; 체험판 {remaining}
      </span>
    </div>
  );
}
