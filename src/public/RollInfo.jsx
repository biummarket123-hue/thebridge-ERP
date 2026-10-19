// 롤 정보 공개 화면 — /r/{롤번호}. 롤 라벨의 QR 을 핸드폰 카메라로 찍으면 열린다.
// 창고를 둘러보는 방문 고객이 "이게 무슨 원단이고, 몇 마 남았고, 얼마인가"를 본다. 로그인 없음.
//
// 보안 경계는 OrderLink.jsx 와 같다: ERP 번들·회사 세션·supabase 클라이언트를 들이지 않는다.
// 데이터는 /api/roll 하나로만 받는다. import 허용: react 뿐.
//
// 어르신 기준: 글자 크게, 숫자는 더 크게.
import { useEffect, useMemo, useState } from "react";

const C = { bg: "#F7F4EE", card: "#FFFFFF", line: "#E6E0D4", text: "#2B2622", muted: "#7A7067", accent: "#B4652A", accentBg: "#FBF1E8", red: "#C0392B", green: "#2E7D4F", greenBg: "#EAF5EE" };
const F = "'Noto Sans KR', system-ui, sans-serif";
const won = (n) => `${(Number(n) || 0).toLocaleString()}원`;
const len = (v) => String(Math.round((Number(v) || 0) * 100) / 100);

function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: F }}>
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "14px 14px 48px" }}>
        <div style={{ fontSize: 13, color: C.muted, fontWeight: 700, letterSpacing: "0.06em", margin: "4px 2px 12px" }}>로하이마켓 · 원단 정보</div>
        {children}
      </div>
    </div>
  );
}
const Card = ({ children }) => (
  <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "18px 16px 20px", marginBottom: 12 }}>{children}</section>
);
const Line = ({ l, r, big }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, padding: "9px 0", borderTop: `1px solid ${C.line}` }}>
    <span style={{ fontSize: 16, color: C.muted, fontWeight: 700 }}>{l}</span>
    <span style={{ fontSize: big ? 26 : 20, fontWeight: 900, color: big ? C.accent : C.text, textAlign: "right" }}>{r}</span>
  </div>
);

// 상태별 안내 — 판매 가능이 아니면 길이·가격 대신 이 말을 보여준다.
const STATUS_NOTE = {
  reserved: { text: "예약된 롤입니다 — 직원에게 문의해 주세요", color: C.accent },
  received: { text: "검단 전인 롤입니다 — 길이를 재는 중이라 곧 판매됩니다", color: C.muted },
  sold: { text: "판매가 끝난 롤입니다", color: C.red },
  scrapped: { text: "판매하지 않는 롤입니다", color: C.red },
};

export default function RollInfo() {
  const code = useMemo(() => {
    try { return decodeURIComponent(location.pathname.replace(/^\/r\/?/, "").split("/")[0] || "").trim().toUpperCase(); }
    catch { return ""; }
  }, []);
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  useEffect(() => { if (state.data?.name) document.title = `${state.data.name}${state.data.color ? ` ${state.data.color}` : ""} · 로하이마켓`; }, [state.data]);

  useEffect(() => {
    if (!code) { setState({ loading: false, data: null, error: "롤 번호가 없습니다" }); return; }
    let alive = true;
    fetch(`/api/roll?code=${encodeURIComponent(code)}`)
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "정보를 불러오지 못했습니다"); return j; })
      .then(d => { if (alive) setState({ loading: false, data: d, error: "" }); })
      .catch(e => { if (alive) setState({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [code]);

  if (state.loading) return <Shell><Card><div style={{ fontSize: 17, color: C.muted }}>불러오는 중…</div></Card></Shell>;
  if (state.error) return (
    <Shell><Card>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 6 }}>{state.error}</div>
      <div style={{ fontSize: 15, color: C.muted, lineHeight: 1.6 }}>라벨의 롤 번호({code || "—"})를 직원에게 보여 주세요.</div>
    </Card></Shell>
  );

  const d = state.data;
  const note = STATUS_NOTE[d.status];
  return (
    <Shell>
      <Card>
        {d.photoUrl && <img src={d.photoUrl} alt="" style={{ width: "100%", maxHeight: 340, objectFit: "cover", borderRadius: 12, marginBottom: 14, display: "block", background: C.bg }} />}
        <div style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.3, wordBreak: "keep-all" }}>{d.name}</div>
        {d.color && <div style={{ fontSize: 20, fontWeight: 700, color: C.muted, marginTop: 2 }}>{d.color}</div>}
        <div style={{ fontSize: 14, color: C.muted, marginTop: 8, fontFamily: "monospace" }}>품번 {d.productCode} · 롤 {d.rollCode}</div>
      </Card>

      <Card>
        {note && (
          <div style={{ fontSize: 17, fontWeight: 800, color: note.color, marginBottom: d.available ? 10 : 0, lineHeight: 1.5 }}>{note.text}</div>
        )}
        {d.lengthRemaining !== null && <Line l="이 롤에 남은 길이" r={`${len(d.lengthRemaining)}${d.unit}`} big />}
        {d.unitPrice !== null
          ? <Line l={`${d.unit}당 가격`} r={won(d.unitPrice)} />
          : <Line l="가격" r="직원에게 문의" />}
        {d.rollPrice !== null && <Line l={`롤 전체 (${len(d.lengthRemaining)}${d.unit})`} r={won(d.rollPrice)} />}
      </Card>

      {d.available && (
        <div style={{ fontSize: 15, color: C.muted, lineHeight: 1.6, padding: "0 4px" }}>
          필요한 만큼 잘라 드립니다. 원하시는 길이를 직원에게 말씀해 주세요.
        </div>
      )}
    </Shell>
  );
}
