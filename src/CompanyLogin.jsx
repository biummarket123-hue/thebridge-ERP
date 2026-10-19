import { useState } from "react";
import { supabase } from "./lib/supabase.js";
import { GATE_TOKEN_KEY, GATE_UNTIL_KEY } from "./lib/db.js";

export default function CompanyLogin({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 비밀번호 검사는 서버(/api/company-session)가 한다 — 예전엔 번들에 든 값과 브라우저에서
  // 비교했고, 그 번들에 Supabase 계정 비밀번호까지 있었다. 이제 맞으면 30일짜리 게이트 토큰과
  // 세션을 받아 심는다. 세션이 죽어도 db.js 가 게이트 토큰으로 스스로 다시 받아온다.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/company-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `로그인 실패 (${res.status})`);
        setLoading(false);
        return;
      }
      // localStorage + 만료시각 — sessionStorage는 모바일에서 앱 전환만 해도 지워져 재로그인이 필요했음
      localStorage.setItem(GATE_TOKEN_KEY, body.gateToken);
      localStorage.setItem(GATE_UNTIL_KEY, String(body.gateExpiresAt));
      if (body.session?.access_token && body.session?.refresh_token) {
        await supabase.auth.setSession({ access_token: body.session.access_token, refresh_token: body.session.refresh_token });
      }
      onSuccess();
    } catch {
      setError("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#07050F",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Noto Sans KR', sans-serif",
    }}>
      <div style={{
        width: 380,
        maxWidth: "calc(100vw - 96px)", // 모바일: 패딩(72px) 포함해도 화면 안에 들어오게. PC는 380 그대로
        padding: "48px 36px",
        borderRadius: 16,
        background: "rgba(20, 16, 28, 0.95)",
        border: "1px solid #2E2820",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            fontFamily: "'Noto Serif KR', serif",
            fontSize: 28,
            fontWeight: 900,
            background: "linear-gradient(135deg, #7C3AED, #EC4899, #F59E0B)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            marginBottom: 8,
          }}>
            로하이마켓 ERP
          </div>
          <div style={{ color: "#A89880", fontSize: 13 }}>
            사내 전용 시스템
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#A89880", fontSize: 12, marginBottom: 8 }}>
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력하세요"
              autoFocus
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 10,
                border: "1px solid #2E2820",
                background: "#0D0B09",
                color: "#F5F0EB",
                fontSize: 14,
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => e.target.style.borderColor = "#7C3AED"}
              onBlur={(e) => e.target.style.borderColor = "#2E2820"}
            />
          </div>

          {error && (
            <div style={{
              color: "#EF4444",
              fontSize: 12,
              marginBottom: 16,
              textAlign: "center",
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: "100%",
              padding: "12px 0",
              borderRadius: 10,
              border: "none",
              background: loading || !password
                ? "rgba(124, 58, 237, 0.3)"
                : "linear-gradient(135deg, #7C3AED, #EC4899)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              cursor: loading || !password ? "not-allowed" : "pointer",
              fontFamily: "'Noto Sans KR', sans-serif",
              transition: "opacity 0.2s",
            }}
          >
            {loading ? "확인 중..." : "입장하기"}
          </button>
        </form>
      </div>
    </div>
  );
}
