import { useState } from "react";
import { supabase } from "./lib/supabase.js";

const G = {
  bg: "#0D0B09", surface: "#161410", card: "#1E1A16",
  border: "#2E2820", copper: "#C8794A", copperLight: "#E8956A",
  copperGlow: "rgba(200,121,74,0.15)", cream: "#F0E6D6", creamMuted: "#A89880",
  white: "#FFFFFF", red: "#C05A4A", green: "#5B9E72",
};
const S = "'Noto Sans KR','Apple SD Gothic Neo',sans-serif";
const SF = "'Noto Serif KR','Apple SD Gothic Neo',serif";

const inp = {
  width: "100%", padding: "14px 16px", borderRadius: 12,
  border: `1px solid ${G.border}`, background: G.surface,
  fontFamily: S, fontSize: 14, color: G.cream,
  outline: "none", boxSizing: "border-box",
};

// ── 샘플 데이터 (체험판용) ──
const DEMO_DATA = {
  orders: [
    { id: "DEMO-0001", date: "2026. 4. 8.", time: "오전 10:30", customer: "김사장", phone: "010-1234-5678", items: [{ fabric: "린넨코튼", color: "백아이보리", qty: 10 }], payment: "입금완료", address: "서울 중구 을지로3가", note: "샘플 주문", status: "접수", manager: "실장님" },
    { id: "DEMO-0002", date: "2026. 4. 8.", time: "오전 11:00", customer: "박과장", phone: "010-9876-5432", items: [{ fabric: "쉬폰", color: "블랙", qty: 5 }, { fabric: "쉬폰", color: "화이트", qty: 3 }], payment: "미입금", address: "경기 성남시 분당구", note: "", status: "준비중", manager: "고문님" },
    { id: "DEMO-0003", date: "2026. 4. 7.", time: "오후 2:15", customer: "이부장", phone: "010-5555-1234", items: [{ fabric: "트위드", color: "그레이", qty: 20 }], payment: "입금완료", address: "서울 종로구 종로5가", note: "급배송 요청", status: "출고완료", manager: "장부장님" },
  ],
  inventory: [
    { id: 1, fabric: "린넨코튼", color: "", stock: 421 },
    { id: 2, fabric: "쉬폰", color: "", stock: 370 },
    { id: 3, fabric: "트위드", color: "", stock: 229 },
    { id: 4, fabric: "강화소창", color: "", stock: 93 },
    { id: 5, fabric: "라미60수", color: "", stock: 56 },
  ],
  customers: [
    { id: 1, name: "김사장", phone: "010-1234-5678", address: "서울 중구 을지로3가", totalOrders: 15, lastOrder: "2026. 4. 8.", note: "VIP 고객" },
    { id: 2, name: "박과장", phone: "010-9876-5432", address: "경기 성남시 분당구", totalOrders: 8, lastOrder: "2026. 4. 8.", note: "" },
    { id: 3, name: "이부장", phone: "010-5555-1234", address: "서울 종로구 종로5가", totalOrders: 22, lastOrder: "2026. 4. 7.", note: "대량주문 위주" },
  ],
  logs: [],
  managers: ["실장님", "고문님", "장부장님", "송미송", "김민주", "손희우"],
};

export default function Auth({ onLogin, onTrial }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    onLogin(data.user);
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (!companyName.trim()) { setError("회사명을 입력해주세요."); return; }
    setError(""); setLoading(true);
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { company_name: companyName.trim() } },
    });
    setLoading(false);
    if (err) { setError(err.message); return; }
    if (data.user?.identities?.length === 0) {
      setError("이미 가입된 이메일입니다.");
      return;
    }
    setSuccess("확인 이메일을 발송했습니다. 이메일을 확인해주세요.");
  };

  const startTrial = () => {
    sessionStorage.setItem("trial_mode", "true");
    sessionStorage.setItem("trial_start", Date.now().toString());
    sessionStorage.setItem("trial_data", JSON.stringify(DEMO_DATA));
    onTrial(DEMO_DATA);
  };

  return (
    <div style={{ minHeight: "100vh", background: G.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* 로고 */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ fontSize: 14, letterSpacing: "0.3em", color: G.copper, fontWeight: 700, marginBottom: 8 }}>
            THE BRIDGE
          </div>
          <div style={{ fontFamily: SF, fontSize: 28, fontWeight: 700, color: G.cream }}>
            더브릿지 ERP
          </div>
          <div style={{ fontSize: 13, color: G.creamMuted, marginTop: 8 }}>
            동대문 원단시장 전용 AI 업무관리 플랫폼
          </div>
        </div>

        {/* 카드 */}
        <div style={{ background: G.card, borderRadius: 20, border: `1px solid ${G.border}`, padding: 32 }}>
          {/* 탭 */}
          <div style={{ display: "flex", marginBottom: 24, borderRadius: 10, overflow: "hidden", border: `1px solid ${G.border}` }}>
            {[["login", "로그인"], ["signup", "회원가입"]].map(([key, label]) => (
              <button key={key} onClick={() => { setMode(key); setError(""); setSuccess(""); }}
                style={{
                  flex: 1, padding: "12px 0", border: "none", fontFamily: S,
                  fontSize: 14, fontWeight: 700, cursor: "pointer",
                  background: mode === key ? `linear-gradient(135deg, ${G.copper}, ${G.copperLight})` : "transparent",
                  color: mode === key ? G.white : G.creamMuted,
                }}>
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={mode === "login" ? handleLogin : handleSignup}>
            {mode === "signup" && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 6 }}>회사명</div>
                <input value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="예: 로하이마켓" style={inp} />
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 6 }}>이메일</div>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="email@example.com" required style={inp} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 6 }}>비밀번호</div>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="6자 이상" required minLength={6} style={inp} />
            </div>

            {error && (
              <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(192,90,74,0.12)", color: G.red, fontSize: 13, marginBottom: 14, fontWeight: 600 }}>
                {error}
              </div>
            )}
            {success && (
              <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(91,158,114,0.12)", color: G.green, fontSize: 13, marginBottom: 14, fontWeight: 600 }}>
                {success}
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{
                width: "100%", padding: "14px 0", borderRadius: 12, border: "none",
                background: loading ? G.border : `linear-gradient(135deg, ${G.copper}, ${G.copperLight})`,
                color: loading ? G.creamMuted : G.white, fontWeight: 700, fontSize: 15,
                cursor: loading ? "not-allowed" : "pointer", fontFamily: S,
                boxShadow: loading ? "none" : `0 4px 20px ${G.copperGlow}`,
              }}>
              {loading ? "처리 중..." : mode === "login" ? "로그인" : "회원가입"}
            </button>
          </form>

          {/* 구분선 */}
          <div style={{ display: "flex", alignItems: "center", margin: "24px 0", gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: G.border }} />
            <span style={{ fontSize: 12, color: G.creamMuted }}>또는</span>
            <div style={{ flex: 1, height: 1, background: G.border }} />
          </div>

          {/* 체험판 버튼 */}
          <button onClick={startTrial}
            style={{
              width: "100%", padding: "14px 0", borderRadius: 12,
              border: `1px solid ${G.border}`, background: "transparent",
              color: G.cream, fontWeight: 700, fontSize: 14,
              cursor: "pointer", fontFamily: S,
            }}>
            둘러보기 (체험판)
          </button>
          <div style={{ fontSize: 11, color: G.creamMuted, textAlign: "center", marginTop: 8 }}>
            샘플 데이터로 1시간 동안 체험할 수 있습니다
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: G.creamMuted }}>
          &copy; 2026 더브릿지 ERP. All rights reserved.
        </div>
      </div>
    </div>
  );
}

// ── 체험판 타이머 배너 ──
export function TrialBanner() {
  const [remaining, setRemaining] = useState("");
  const [expired, setExpired] = useState(false);

  useState(() => {
    const interval = setInterval(() => {
      const start = parseInt(sessionStorage.getItem("trial_start") || "0", 10);
      if (!start) return;
      const elapsed = Date.now() - start;
      const limit = 60 * 60 * 1000; // 1시간
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
      position: "fixed", top: 0, right: 0, zIndex: 1000,
      padding: "8px 16px", borderRadius: "0 0 0 12px",
      background: "rgba(200,121,74,0.15)", backdropFilter: "blur(8px)",
      border: `1px solid ${G.copper}30`, borderTop: "none", borderRight: "none",
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: G.copper, fontFamily: S }}>
        &#9202; {remaining}
      </span>
    </div>
  );
}
