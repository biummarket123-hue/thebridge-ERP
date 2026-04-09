import { useState } from "react";

export default function CompanyLogin({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const correctPassword = import.meta.env.VITE_COMPANY_PASSWORD;

    if (password === correctPassword) {
      sessionStorage.setItem("company_authenticated", "true");
      onSuccess();
    } else {
      setError("비밀번호가 올바르지 않습니다.");
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
            더브릿지 ERP
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
