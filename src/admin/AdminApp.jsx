import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const S = "'Noto Sans KR',sans-serif";
const SF = "'Noto Serif KR',serif";
const C = {
  bg: "#07050F", surface: "#110E1E", card: "#1A1630",
  border: "#252040", purple: "#7C3AED", purpleLight: "#A855F7",
  pink: "#EC4899", gold: "#F59E0B", green: "#22C55E",
  red: "#EF4444", cream: "#F0EBF8", muted: "#8B82A8",
  blue: "#3B82F6",
};

const ADMIN_EMAILS = ["admin@thebridge.ai.kr", "biummarket123@gmail.com"];

// ── 스타일 헬퍼 ──
const cardStyle = { background: C.card, borderRadius: 14, border: `1px solid ${C.border}`, padding: "20px 22px", marginBottom: 14 };
const inputStyle = { width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: "rgba(255,255,255,0.05)", color: C.cream, fontSize: 14, fontFamily: S, outline: "none", boxSizing: "border-box" };
const btnPrimary = { padding: "12px 0", borderRadius: 10, border: "none", background: `linear-gradient(135deg,${C.purple},${C.pink})`, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: S, width: "100%" };
const tabBtn = (active) => ({ padding: "10px 16px", borderRadius: 10, border: active ? "none" : `1px solid ${C.border}`, background: active ? C.purple : "transparent", color: active ? "#fff" : C.muted, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: S });

// ── 로그인 화면 ──
function AdminLogin({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    if (!ADMIN_EMAILS.includes(data.user.email)) {
      await supabase.auth.signOut();
      setError("관리자 권한이 없습니다.");
      return;
    }
    onLogin(data.session);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: S }}>
      <div style={{ width: 380, ...cardStyle, padding: "48px 36px" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontFamily: SF, fontSize: 24, fontWeight: 900, background: `linear-gradient(135deg,${C.purple},${C.pink},${C.gold})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            더브릿지 ADMIN
          </div>
          <div style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>관리자 전용</div>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="관리자 이메일" style={inputStyle} autoFocus />
          </div>
          <div style={{ marginBottom: 14 }}>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="비밀번호" style={inputStyle} />
          </div>
          {error && <div style={{ color: C.red, fontSize: 12, marginBottom: 14, textAlign: "center" }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ ...btnPrimary, opacity: loading ? 0.5 : 1 }}>
            {loading ? "로그인 중..." : "관리자 로그인"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── 통계 카드 ──
function StatCard({ icon, label, value, unit, color }) {
  return (
    <div style={{ ...cardStyle, position: "relative", overflow: "hidden", marginBottom: 0 }}>
      <div style={{ position: "absolute", top: -10, right: -10, width: 60, height: 60, background: `radial-gradient(circle,${color}25,transparent 70%)` }} />
      <div style={{ fontSize: 18, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontFamily: SF, fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>
        {value}<span style={{ fontSize: 12, fontWeight: 400, color: C.muted, marginLeft: 3 }}>{unit}</span>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>{label}</div>
    </div>
  );
}

// ── 대시보드 ──
function Dashboard({ companies, users, subscriptions }) {
  const activeCompanies = companies.filter(c => {
    if (c.plan === "trial") return new Date(c.trial_end) > new Date();
    return ["basic", "pro", "enterprise"].includes(c.plan);
  });
  const trialExpiring = companies.filter(c => {
    if (c.plan !== "trial") return false;
    const end = new Date(c.trial_end);
    const now = new Date();
    const diff = (end - now) / (1000 * 60 * 60 * 24);
    return diff > 0 && diff <= 7;
  });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <StatCard icon="🏢" label="총 가입 회사" value={companies.length} unit="개" color={C.purple} />
        <StatCard icon="👤" label="총 사용자" value={users.length} unit="명" color={C.blue} />
        <StatCard icon="✅" label="활성 구독" value={activeCompanies.length} unit="개" color={C.green} />
        <StatCard icon="⏰" label="만료 예정 (7일)" value={trialExpiring.length} unit="개" color={C.gold} />
      </div>

      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>최근 가입</div>
        {companies.length === 0
          ? <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 16 }}>가입된 회사가 없습니다</div>
          : companies.slice(0, 10).map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.cream }}>{c.name}</span>
              <span style={{ fontSize: 11, color: C.muted }}>{c.owner_email}</span>
              <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: c.plan === "trial" ? `${C.gold}20` : `${C.green}20`, color: c.plan === "trial" ? C.gold : C.green, fontWeight: 600 }}>
                {c.plan}
              </span>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── 회원 관리 ──
function Members({ companies, users, onRefresh }) {
  const [search, setSearch] = useState("");
  const filtered = companies.filter(c =>
    c.name.includes(search) || c.owner_email.includes(search)
  );

  const togglePlan = async (company) => {
    const newPlan = company.plan === "trial" ? "basic" : "trial";
    await supabase.from("companies").update({ plan: newPlan }).eq("id", company.id);
    onRefresh();
  };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="회사명 또는 이메일 검색" style={inputStyle} />
      </div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>
          회원 목록 ({filtered.length})
        </div>
        {filtered.length === 0
          ? <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 16 }}>결과 없음</div>
          : filtered.map((c, i) => {
            const user = users.find(u => u.email === c.owner_email);
            const isExpired = c.plan === "trial" && new Date(c.trial_end) < new Date();
            return (
              <div key={c.id} style={{ padding: "14px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.cream, flex: 1 }}>{c.name}</span>
                  <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: isExpired ? `${C.red}20` : c.plan === "trial" ? `${C.gold}20` : `${C.green}20`, color: isExpired ? C.red : c.plan === "trial" ? C.gold : C.green, fontWeight: 600 }}>
                    {isExpired ? "만료" : c.plan}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11 }}>
                  <div>
                    <span style={{ color: C.muted }}>{c.owner_email}</span>
                    {c.trial_end && <span style={{ color: C.muted, marginLeft: 8 }}>만료: {new Date(c.trial_end).toLocaleDateString("ko")}</span>}
                  </div>
                  <button onClick={() => togglePlan(c)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: c.plan === "trial" ? C.green : C.gold, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: S }}>
                    {c.plan === "trial" ? "구독 활성화" : "체험판으로"}
                  </button>
                </div>
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ── 구독 관리 ──
function Subscriptions({ companies, subscriptions, onRefresh }) {
  const expiringSoon = companies.filter(c => {
    if (!c.trial_end) return false;
    const diff = (new Date(c.trial_end) - new Date()) / (1000 * 60 * 60 * 24);
    return diff > 0 && diff <= 30;
  }).sort((a, b) => new Date(a.trial_end) - new Date(b.trial_end));

  const expired = companies.filter(c => c.trial_end && new Date(c.trial_end) < new Date());

  const extendTrial = async (company, days) => {
    const newEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("companies").update({ trial_end: newEnd }).eq("id", company.id);
    onRefresh();
  };

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.gold, marginBottom: 14 }}>
          만료 예정 ({expiringSoon.length})
        </div>
        {expiringSoon.length === 0
          ? <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 16 }}>만료 예정 없음</div>
          : expiringSoon.map((c, i) => {
            const days = Math.ceil((new Date(c.trial_end) - new Date()) / (1000 * 60 * 60 * 24));
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.cream }}>{c.name}</span>
                <span style={{ fontSize: 11, color: days <= 7 ? C.red : C.gold, fontWeight: 700 }}>D-{days}</span>
                <button onClick={() => extendTrial(c, 30)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.green, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: S }}>+30일</button>
                <button onClick={() => extendTrial(c, 90)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.blue, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: S }}>+90일</button>
              </div>
            );
          })
        }
      </div>

      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.red, marginBottom: 14 }}>
          만료됨 ({expired.length})
        </div>
        {expired.length === 0
          ? <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 16 }}>만료된 구독 없음</div>
          : expired.map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.cream }}>{c.name}</span>
              <span style={{ fontSize: 11, color: C.muted }}>{c.owner_email}</span>
              <button onClick={() => extendTrial(c, 90)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.purple}`, background: "transparent", color: C.purple, fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: S }}>재활성화</button>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── 공지사항 ──
function Notices() {
  const [notices, setNotices] = useState([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { loadNotices(); }, []);

  const loadNotices = async () => {
    const { data } = await supabase.from("notices").select("*").order("created_at", { ascending: false });
    setNotices(data || []);
  };

  const addNotice = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    await supabase.from("notices").insert({ title: title.trim(), content: content.trim() });
    setTitle(""); setContent(""); setLoading(false);
    loadNotices();
  };

  const deleteNotice = async (id) => {
    await supabase.from("notices").delete().eq("id", id);
    loadNotices();
  };

  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>공지 작성</div>
        <form onSubmit={addNotice}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="제목" style={{ ...inputStyle, marginBottom: 10 }} />
          <textarea value={content} onChange={e => setContent(e.target.value)} placeholder="내용" rows={4} style={{ ...inputStyle, resize: "vertical" }} />
          <button type="submit" disabled={loading} style={{ ...btnPrimary, marginTop: 10 }}>공지 등록</button>
        </form>
      </div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>공지 목록 ({notices.length})</div>
        {notices.length === 0
          ? <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: 16 }}>공지사항 없음</div>
          : notices.map((n, i) => (
            <div key={n.id} style={{ padding: "14px 0", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.cream }}>{n.title}</span>
                <button onClick={() => deleteNotice(n.id)} style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.red, fontSize: 10, cursor: "pointer", fontFamily: S }}>삭제</button>
              </div>
              <div style={{ fontSize: 12, color: C.muted, whiteSpace: "pre-wrap", marginBottom: 4 }}>{n.content}</div>
              <div style={{ fontSize: 10, color: C.muted }}>{new Date(n.created_at).toLocaleString("ko")}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── 설정 ──
function Settings({ session, onLogout }) {
  return (
    <div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>관리자 정보</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>이메일: {session.user.email}</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>로그인: {new Date(session.user.last_sign_in_at).toLocaleString("ko")}</div>
        <button onClick={onLogout} style={{ ...btnPrimary, background: C.red }}>로그아웃</button>
      </div>
      <div style={cardStyle}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 700, color: C.cream, marginBottom: 14 }}>시스템 정보</div>
        <div style={{ fontSize: 12, color: C.muted }}>DB: SaaS (dcitethfhwqdautonnmo)</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>버전: 1.0.0</div>
      </div>
    </div>
  );
}

// ── 메인 ──
export default function AdminApp() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(0);
  const [companies, setCompanies] = useState([]);
  const [users, setUsers] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (s && ADMIN_EMAILS.includes(s.user.email)) setSession(s);
      setLoading(false);
    });
  }, []);

  const loadData = async () => {
    const [c, u, s] = await Promise.all([
      supabase.from("companies").select("*").order("created_at", { ascending: false }),
      supabase.from("users").select("*").order("created_at", { ascending: false }),
      supabase.from("subscriptions").select("*").order("started_at", { ascending: false }),
    ]);
    setCompanies(c.data || []);
    setUsers(u.data || []);
    setSubscriptions(s.data || []);
  };

  useEffect(() => { if (session) loadData(); }, [session]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: C.purple, fontSize: 15, fontFamily: S }}>로딩 중...</div>
      </div>
    );
  }

  if (!session) return <AdminLogin onLogin={setSession} />;

  const tabs = [
    { icon: "📊", label: "대시보드" },
    { icon: "👥", label: "회원 관리" },
    { icon: "💳", label: "구독 관리" },
    { icon: "📢", label: "공지사항" },
    { icon: "⚙️", label: "설정" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: S, color: C.cream }}>
      {/* 헤더 */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 900, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "rgba(7,5,15,0.9)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontFamily: SF, fontSize: 15, fontWeight: 900, background: `linear-gradient(135deg,${C.purple},${C.pink},${C.gold})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          ADMIN
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>{session.user.email}</div>
      </div>

      {/* 탭 */}
      <div style={{ position: "fixed", top: 44, left: 0, right: 0, zIndex: 899, padding: "10px 12px", background: "rgba(7,5,15,0.9)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 6, overflowX: "auto" }}>
        {tabs.map((t, i) => (
          <button key={i} onClick={() => setTab(i)} style={tabBtn(tab === i)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* 컨텐츠 */}
      <div style={{ paddingTop: 100, padding: "100px 14px 40px" }}>
        {tab === 0 && <Dashboard companies={companies} users={users} subscriptions={subscriptions} />}
        {tab === 1 && <Members companies={companies} users={users} onRefresh={loadData} />}
        {tab === 2 && <Subscriptions companies={companies} subscriptions={subscriptions} onRefresh={loadData} />}
        {tab === 3 && <Notices />}
        {tab === 4 && <Settings session={session} onLogout={handleLogout} />}
      </div>
    </div>
  );
}
