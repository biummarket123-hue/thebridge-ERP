import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { SF, S, baseInp, useTheme } from "../constants.js";
import { Empty } from "./UI.jsx";
import LinkPreview from "./LinkPreview.jsx";

// 주문 메모 — 카카오톡형 채팅 UI (팝업 창 전용).
// · 입력창은 하단, 메시지는 위로 쌓임(최신이 맨 아래) — 스크롤 올리면 예전 메모.
// · 검색, 링크 이미지 미리보기, 입력창 고객검색 지원.
// · 말풍선의 "주문 등록"을 누르면 부모(ERP 본 창)가 주문입력 AI 분석으로 넘김.
//
// props: notes(최신순 배열), activeManager, customers, onSend, onRegister,
//        onUpdateBody, onDelete, showToast

const URL_TOKEN = /^(https?:\/\/[^\s]+|[\w-]+(?:\.[\w-]+)+(?:[/?#][^\s]*)?)$/i;
function extractUrls(text) {
  return (text || "").split(/\s+/).filter((t) => URL_TOKEN.test(t));
}

// 전화 가운데 4자리 (풀번호면 slice(3,7), 4자리만 저장된 경우 그대로)
function extractMidPhone(phone) {
  if (!phone) return null;
  const c = String(phone).replace(/[^0-9]/g, "");
  if (c.length >= 10) return c.slice(3, 7);
  if (c.length === 4) return c;
  return null;
}
// "YYYY. M. D." 형태 → ms (정렬용)
function parseOrderDate(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}
// 날짜 구분선용 — 같은 날 판정 키 + 라벨(오늘/어제/YYYY년 M월 D일 (요일))
const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"];
function dayKey(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "오늘";
  if (same(d, yest)) return "어제";
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK_KO[d.getDay()]})`;
}

// 카카오톡 팔레트 — 메모장은 다크/화이트 테마와 무관하게 카톡 채팅방 룩 고정
const KK = {
  bg: "#BACEE0",          // 채팅방 하늘색 배경
  myBubble: "#FEE500",    // 내 말풍선 노랑
  otherBubble: "#FFFFFF", // 상대 말풍선 흰색
  text: "#1E1E1E",        // 본문 검정
  sub: "#556677",         // 보조 텍스트 (시간·안내)
  line: "rgba(0,0,0,0.12)",
};

// 리액션 이모지 — 메시지에 마우스를 올리면 나오는 바 (카톡 반응 느낌)
const REACTION_EMOJIS = ["✅", "👍", "❤️", "😂", "😢"];

// onClose: 모바일 전체화면 층으로 띄웠을 때만 온다 — 제목 왼쪽에 ← 를 달아 닫는 길을 준다.
function OrderNotesTab({ notes = [], activeManager = "", customers = [], orders = [], isAdmin = false, onSend, onRegister, onUpdateBody, onDelete, onToggleReaction, onSearch, showToast, onClose }) {
  const G = useTheme();
  const [draft, setDraft] = useState("");
  const [view, setView] = useState("all");        // all | mine
  const [pendingOnly, setPendingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [sending, setSending] = useState(false);
  const [custQuery, setCustQuery] = useState("");
  const [custFocus, setCustFocus] = useState(false);
  const [previewCustId, setPreviewCustId] = useState(null); // 우클릭 시 최근주문 미리보기
  const [pendingCustomer, setPendingCustomer] = useState(null); // 이 메모에 연결된 고객(검색으로 선택)
  const [addrPick, setAddrPick] = useState(null); // 배송지 2곳 고객 — 어느 주소를 넣을지 선택 대기
  const [confirmDelId, setConfirmDelId] = useState(null); // 삭제 2단계 확인 (팝업 창에서 window.confirm 불가)
  const [reRegId, setReRegId] = useState(null); // 등록됨 클릭 시 재등록 안내 표시
  const [hoverId, setHoverId] = useState(null); // 마우스 올린 메시지 — 리액션 바 표시용
  const scrollRef = useRef(null);
  const taRef = useRef(null);

  // 모바일(좁은 화면) 감지 — PC 팝업 레이아웃은 그대로, 모바일에서만 카톡 앱처럼 키움
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= 640);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 특정 고객의 최근 주문 5건 (이름 기준)
  const recentOrdersOf = (name) =>
    orders.filter((o) => o.customer === name)
      .sort((a, b) => parseOrderDate(b.date) - parseOrderDate(a.date))
      .slice(0, 5);

  const mineCount = useMemo(() => notes.filter((n) => n.author === activeManager).length, [notes, activeManager]);
  const pendingCount = useMemo(() => notes.filter((n) => n.status !== "등록됨").length, [notes]);

  // 한 번에 그리는 말풍선 수. 메모 1,600건을 전부 그리면 말풍선 하나가
  // 20~35개 노드라 DOM 이 3만 개를 넘고, 그 뒤로는 화면이 한 번 다시 그려질 때마다
  // 그게 통째로 재조정된다 (팝업은 다른 창이라 더 느리다). 최근 것부터 잘라 그린다.
  const PAGE = 100;
  const [limit, setLimit] = useState(PAGE);
  // 필터를 바꾸면 다시 처음부터 — 이전 필터에서 늘려둔 만큼을 물고 가지 않게.
  useEffect(() => { setLimit(PAGE); }, [view, pendingOnly, search]);

  // 검색어가 이름·닉네임에 걸린 고객. 고객검색으로 고객만 붙이고 본문에 이름을 안 적은
  // 메모는 본문만 봐서는 못 찾는다 — 붙은 고객으로도 찾는다.
  const searchCustIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return new Set();
    return new Set(customers
      .filter((c) => (c.name || "").toLowerCase().includes(q) || (c.nickname || "").toLowerCase().includes(q))
      .map((c) => c.id));
  }, [search, customers]);

  // 서버 검색 — 화면이 들고 있는 건 최근 500건 + 미등록뿐이라, 그 밖의 옛 메모는
  // 서버에 물어 가져온다. 결과는 부모의 notes 에 합쳐져 위 filtered 로 그대로 걸린다.
  // 타자 중에는 부르지 않고(350ms), 늦게 도착한 옛 검색이 상태를 덮지 않게 번호를 매긴다.
  const [searchState, setSearchState] = useState(null); // null | "loading" | "done" | "capped" | "error"
  const searchSeq = useRef(0);
  useEffect(() => {
    const q = search.trim();
    const seq = ++searchSeq.current;
    // 한 글자는 거의 모든 메모에 걸려 상한(200건)만 채운다 — 화면에 있는 것만 거른다
    if (!onSearch || q.length < 2) { setSearchState(null); return; }
    setSearchState("loading");
    const t = setTimeout(async () => {
      try {
        const r = await onSearch(q, [...searchCustIds]);
        if (seq === searchSeq.current) setSearchState(r?.capped ? "capped" : "done");
      } catch (e) {
        console.error("메모 서버 검색 실패:", e);
        if (seq === searchSeq.current) setSearchState("error");
      }
    }, 350);
    return () => clearTimeout(t);
    // searchCustIds 는 search 에서 파생된다 — customers 가 실시간으로 바뀔 때마다 다시 부르지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, onSearch]);

  const filtered = useMemo(() => {
    let list = notes;
    if (view === "mine") list = list.filter((n) => n.author === activeManager);
    if (pendingOnly) list = list.filter((n) => n.status !== "등록됨");
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((n) => (n.body || "").toLowerCase().includes(q) || (n.author || "").toLowerCase().includes(q)
      || (n.customerId != null && searchCustIds.has(n.customerId)));
    // 오래된 → 최신 (위 → 아래)
    return [...list].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  }, [notes, view, pendingOnly, search, activeManager, searchCustIds]);

  // 잘라내는 건 '등록됨'뿐이다. 미등록은 나이와 상관없이 항상 남긴다 —
  // 아직 처리 안 된 주문이 스크롤 밖으로 밀려 안 보이게 되는 것이 이 화면에서 가장 위험하다.
  const visible = useMemo(() => {
    if (filtered.length <= limit) return filtered;
    const tail = filtered.slice(filtered.length - limit);
    const kept = new Set(tail.map((n) => n.id));
    const olderPending = filtered
      .slice(0, filtered.length - limit)
      .filter((n) => n.status !== "등록됨" && !kept.has(n.id));
    return [...olderPending, ...tail];
  }, [filtered, limit]);
  // 실제로 안 그린 개수. filtered - limit 으로 세면 위로 끌어올린 옛 미등록까지
  // 숨은 것으로 세어져 버튼 숫자가 사실과 달라진다.
  const hiddenCount = filtered.length - visible.length;

  // 최신 메시지로 스크롤.
  // '더 보기'로 늘어난 경우는 예외 — 위쪽 옛 메모를 보려고 누른 건데 맨 아래로
  // 끌어내리면 누른 의미가 없다. 그때는 스크롤을 건드리지 않는다.
  const skipScrollRef = useRef(false);
  const loadMore = () => { skipScrollRef.current = true; setLimit((v) => v + PAGE); };
  useEffect(() => {
    if (skipScrollRef.current) { skipScrollRef.current = false; return; }
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, view, pendingOnly, search]);

  // 키보드가 뜨고 내리는 것을 따라가기 위한 "보이는 높이" — 입력창 최대 높이 계산에 쓴다
  const [vvH, setVvH] = useState(() => (typeof window !== "undefined" ? (window.visualViewport?.height || window.innerHeight) : 0));
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const upd = () => setVvH(vv.height);
    vv.addEventListener("resize", upd);
    return () => vv.removeEventListener("resize", upd);
  }, []);

  // 입력창 자동 높이 — 내용이 길어지면 칸도 같이 커지고, 최대치 넘으면 칸 안에서 스크롤.
  // PC 는 250px. 모바일은 키보드를 뺀 보이는 높이의 38% 까지만 — 250px 까지 키우면 키보드 위에
  // 남은 영역보다 커져 아랫줄(커서)이 키보드 뒤로 들어갔다. 칸 안에서 스크롤되면 커서 줄은 늘 보인다.
  // px 는 .erp-root 의 zoom(글씨 배율)만큼 커지므로 배율로 나눈다. PC 팝업창엔 .erp-root 가 없어 1.
  const taMaxHeight = () => {
    if (!isMobile) return 250;
    const root = taRef.current?.closest(".erp-root");
    const z = root ? (parseFloat(getComputedStyle(root).zoom) || 1) : 1;
    return Math.max(88, Math.floor((vvH * 0.38) / z));
  };
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, taMaxHeight()) + "px";
  }, [draft, vvH, isMobile]);

  // ── 고객 자동완성 ──
  const cq = custQuery.trim().toLowerCase();
  const custSuggestions = (custFocus && cq)
    ? customers.filter((c) => {
        const d = cq.replace(/\D/g, "");
        return (c.name && c.name.toLowerCase().includes(cq))
          || (c.nickname && c.nickname.toLowerCase().includes(cq))
          || (d && c.phone && c.phone.replace(/\D/g, "").includes(d));
      }).slice(0, 8)
    : [];

  const insertCustomerBlock = (c, addr, addrDetail) => {
    const line1 = [c.name, c.phone].filter(Boolean).join(" ");
    const line2 = [addr, addrDetail].filter(Boolean).join(" ");
    const block = [line1, line2].filter(Boolean).join("\n");

    // 커서 자리에 끼워 넣는다. 맨 앞에 붙이면 쓰던 내용이 아래로 밀려서,
    // '쓰다가 고객만 넣고 이어서 쓰는' 흐름이 끊긴다.
    // 고객 검색창으로 포커스가 옮겨가 있어도 textarea 는 마지막 커서 위치를 기억한다.
    const ta = taRef.current;
    const at = typeof ta?.selectionStart === "number"
      ? Math.min(ta.selectionStart, draft.length)
      : draft.length;
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    // 쓰던 줄 끝에 그대로 이어붙지 않게 앞쪽 줄바꿈을 보충한다.
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const inserted = `${lead}${block}\n`;
    setDraft(`${before}${inserted}${after}`);

    setPendingCustomer(c);
    setCustQuery(""); setCustFocus(false); setPreviewCustId(null);
    // 끼워 넣은 블록 바로 뒤로 커서를 옮겨, 주문 내용을 이어서 쓸 수 있게 한다.
    const caret = before.length + inserted.length;
    setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const pickCustomer = (c) => {
    // 배송지 2곳 보유 고객 — 어느 주소를 메모에 넣을지 먼저 물어봄
    if (c.address2) {
      setAddrPick(c);
      setCustQuery(""); setCustFocus(false); setPreviewCustId(null);
      return;
    }
    insertCustomerBlock(c, c.address, c.addressDetail);
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try { await onSend?.(body, pendingCustomer?.id ?? null); setDraft(""); setPendingCustomer(null); }
    finally { setSending(false); }
  };

  // 리액션 토글 — 본인 포함 누구나, 같은 이모지 다시 누르면 취소
  const toggleReaction = (n, emoji) => {
    if (!activeManager) { showToast?.("작업자 미선택 — ERP 본 창에서 담당자를 골라주세요", "error"); return; }
    onToggleReaction?.(n.id, emoji);
  };

  const startEdit = (n) => { setEditingId(n.id); setEditBody(n.body); };
  const saveEdit = async () => {
    const body = editBody.trim();
    if (!body) return;
    await onUpdateBody?.(editingId, body);
    setEditingId(null); setEditBody("");
  };

  const fmtTime = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
      return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    } catch { return ""; }
  };

  const chip = (active, color) => ({
    padding: isMobile ? "7px 13px" : "5px 11px", borderRadius: 16, fontSize: isMobile ? 12 : 11, fontFamily: S, cursor: "pointer",
    border: `1px solid ${active ? color : KK.line}`, background: active ? `${color}18` : "rgba(255,255,255,0.5)",
    color: active ? color : KK.sub, fontWeight: active ? 700 : 500, whiteSpace: "nowrap",
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: KK.bg, borderRadius: isMobile ? 0 : 12, padding: isMobile ? "8px 6px" : "10px 10px" }}>
      {/* ── 헤더 ── */}
      <div style={{ flexShrink: 0, borderBottom: `1px solid ${KK.line}`, paddingBottom: 8, marginBottom: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {onClose && (
              <button onClick={onClose} aria-label="주문입력으로 돌아가기"
                style={{ flexShrink: 0, height: 34, padding: "0 12px", borderRadius: 9, border: `1px solid ${KK.line}`, background: "rgba(255,255,255,0.6)", color: KK.text, fontFamily: S, fontSize: 13, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>
                ← 주문입력
              </button>
            )}
            <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: KK.text, whiteSpace: "nowrap" }}>📝 로하톡</div>
          </div>
          <button onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setSearch(""); }} title="검색"
            style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${searchOpen ? G.copper : KK.line}`, background: searchOpen ? "#fff" : "rgba(255,255,255,0.5)", color: searchOpen ? G.copper : KK.sub, fontSize: 14, cursor: "pointer" }}>🔍</button>
        </div>
        {searchOpen && (
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="메모 검색 (내용 · 작성자 · 연결된 고객)"
            style={{ ...baseInp, width: "100%", boxSizing: "border-box", marginBottom: 8, fontSize: isMobile ? 16 : 13, padding: isMobile ? "10px 12px" : "8px 10px", background: "#fff", color: KK.text, border: `1px solid ${KK.line}` }} />
        )}
        {/* 서버 검색 상태 — 없으면 "아직 찾는 중"과 "정말 없음"이 같은 빈 화면이다 */}
        {searchOpen && searchState && (
          <div style={{ fontSize: 11, color: searchState === "error" ? G.red : KK.sub, margin: "-4px 2px 8px", fontFamily: S }}>
            {searchState === "loading" ? "전체 메모에서 찾는 중…"
              : searchState === "capped" ? "전체 메모 검색 — 결과가 많아 최신 200건까지만 가져왔어요. 검색어를 더 길게 적어 보세요"
              : searchState === "error" ? "전체 메모 검색 실패 — 지금 화면에 있는 메모에서만 찾았어요"
              : "전체 메모에서 찾았어요"}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => setView("all")} style={chip(view === "all", G.copper)}>전체 {notes.length}</button>
          <button onClick={() => setView("mine")} style={chip(view === "mine", G.copper)}>내 메모 {mineCount}</button>
          <button onClick={() => setPendingOnly((v) => !v)} style={{ ...chip(pendingOnly, G.blue), marginLeft: "auto" }}>{pendingOnly ? "✓ " : ""}미등록 {pendingCount}</button>
        </div>
      </div>

      {/* ── 메시지 (채팅) ── */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 2px", display: "flex", flexDirection: "column", gap: 12 }}>
        {hiddenCount > 0 && (
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
            <button onClick={loadMore}
              style={{ padding: "6px 16px", borderRadius: 14, border: `1px solid ${KK.line}`, background: "rgba(255,255,255,0.75)",
                color: KK.sub, fontSize: 11, fontWeight: 700, fontFamily: S, cursor: "pointer" }}>
              ↑ 이전 메모 {hiddenCount}건 더 보기
            </button>
          </div>
        )}
        {visible.length === 0 ? (
          <div style={{ margin: "auto 0" }}><Empty>{search ? (searchState === "loading" ? "찾는 중…" : "검색 결과가 없어요") : pendingOnly ? "미등록 메모가 없어요" : view === "mine" ? "내가 쓴 메모가 없어요" : "아직 메모가 없어요 — 아래에 첫 메모를 남겨보세요"}</Empty></div>
        ) : visible.map((n, i) => {
          const registered = n.status === "등록됨";
          const mine = n.author === activeManager;
          const canManage = isAdmin || mine; // 본인 메모 또는 관리자만 등록·수정·삭제
          const editing = editingId === n.id;
          const urls = extractUrls(n.body);
          const showDate = i === 0 || dayKey(n.createdAt) !== dayKey(visible[i - 1]?.createdAt);
          return (
            <Fragment key={n.id}>
            {showDate && (
              <div style={{ display: "flex", justifyContent: "center", margin: "2px 0 6px" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#44505C", background: "rgba(0,0,0,0.10)", borderRadius: 12, padding: "3px 12px" }}>{dateLabel(n.createdAt)}</span>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
              <span style={{ fontSize: 14, color: "#3D4A57", marginBottom: 4, marginLeft: mine ? 0 : 4, marginRight: mine ? 4 : 0, fontWeight: 800 }}>{n.author || "(미지정)"}</span>
              <div onMouseEnter={() => setHoverId(n.id)} onMouseLeave={() => setHoverId((id) => (id === n.id ? null : id))}
                onClick={() => { if (isMobile) setHoverId((id) => (id === n.id ? null : n.id)); }} /* 터치에는 hover가 없어서 탭으로 리액션 바 토글 */
                style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 5, flexDirection: mine ? "row-reverse" : "row", maxWidth: "88%" }}>
                <div style={{
                  background: mine ? KK.myBubble : KK.otherBubble, color: KK.text,
                  border: "none", boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
                  borderRadius: 14, borderTopRightRadius: mine ? 4 : 14, borderTopLeftRadius: mine ? 14 : 4,
                  padding: isMobile ? "10px 13px" : "9px 12px", fontSize: isMobile ? 15 : 14, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0,
                }}>
                  {editing ? (
                    <div>
                      <textarea value={editBody}
                        ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 320) + "px"; } }}
                        onChange={(e) => { setEditBody(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 320) + "px"; }}
                        style={{ ...baseInp, width: isMobile ? "72vw" : 300, maxWidth: "100%", boxSizing: "border-box", minHeight: 90, resize: "none", lineHeight: 1.5, fontSize: isMobile ? 16 : 14, background: "#fff", color: KK.text, border: `1px solid ${KK.line}` }} />
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <button onClick={saveEdit} style={{ padding: "5px 12px", borderRadius: 7, border: "none", background: G.copperLight, color: "#fff", fontSize: 12, fontWeight: 700, fontFamily: S, cursor: "pointer" }}>저장</button>
                        <button onClick={() => setEditingId(null)} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${KK.line}`, background: "transparent", color: KK.sub, fontSize: 12, fontFamily: S, cursor: "pointer" }}>취소</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {n.body}
                      {urls.length > 0 && <div style={{ marginTop: 7, width: 200 }}><LinkPreview links={urls} T={G} /></div>}
                    </>
                  )}
                </div>
                <span style={{ fontSize: 9, color: KK.sub, whiteSpace: "nowrap", paddingBottom: 2 }}>{fmtTime(n.createdAt)}</span>
                {/* 리액션 바 — 마우스 올리면 표시. absolute로 띄워서 채팅 레이아웃 크기를 밀지 않음.
                    내 메시지는 말풍선 옆(왼쪽), 다른 담당자 메시지는 말풍선 아래에 뜸 */}
                {!editing && hoverId === n.id && (
                  /* 바깥 래퍼가 말풍선 가장자리에 딱 붙고, 간격은 padding으로 확보 —
                     margin(빈 틈)이면 말풍선→바 이동 중 mouseleave가 떠서 바가 사라짐 */
                  <div style={{
                    position: "absolute", zIndex: 20,
                    ...(mine
                      ? { right: "100%", bottom: 0, paddingRight: 6 }
                      : { top: "100%", left: 0, paddingTop: 4 }),
                  }}>
                    <div style={{ display: "flex", gap: 1, background: "#fff", borderRadius: 14, padding: "2px 5px", boxShadow: "0 2px 8px rgba(0,0,0,0.18)" }}>
                      {REACTION_EMOJIS.map((em) => {
                        const on = ((n.reactions || {})[em] || []).includes(activeManager);
                        return (
                          <button key={em} onClick={() => toggleReaction(n, em)} title={on ? "리액션 취소" : "리액션 달기"}
                            style={{ border: "none", background: on ? KK.myBubble : "none", borderRadius: 8, cursor: "pointer", fontSize: 13, padding: "1px 3px", lineHeight: 1.4 }}>{em}</button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {/* 달린 리액션 칩 — 이모지+인원수, 마우스 올리면 누른 사람 이름, 클릭하면 나도 토글 */}
              {(() => {
                const entries = Object.entries(n.reactions || {}).filter(([, names]) => Array.isArray(names) && names.length > 0);
                if (entries.length === 0) return null;
                return (
                  <div style={{ display: "flex", gap: 4, marginTop: 4, flexDirection: mine ? "row-reverse" : "row", flexWrap: "wrap" }}>
                    {entries.map(([em, names]) => {
                      const iDid = names.includes(activeManager);
                      return (
                        <button key={em} onClick={() => toggleReaction(n, em)} title={names.join(", ")}
                          style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, fontFamily: SF, fontWeight: 700, padding: "2px 7px", borderRadius: 10, cursor: "pointer",
                            border: `1px solid ${iDid ? G.copper : KK.line}`, background: iDid ? G.copperGlow : "rgba(255,255,255,0.75)", color: iDid ? G.copper : KK.sub }}>
                          <span style={{ fontSize: 12 }}>{em}</span>{names.length}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              {!editing && (
                <div style={{ display: "flex", gap: 5, marginTop: 5, alignItems: "center", flexDirection: mine ? "row-reverse" : "row", flexWrap: "wrap" }}>
                  {registered
                    ? (canManage
                        ? <button onClick={() => setReRegId((id) => (id === n.id ? null : n.id))} title="눌러서 재등록" style={{ fontSize: 10, fontWeight: 800, color: G.green, background: G.greenBg, border: `1px solid ${G.green}40`, borderRadius: 6, padding: "2px 7px", cursor: "pointer", fontFamily: S }}>✓ 등록됨</button>
                        : <span style={{ fontSize: 10, fontWeight: 800, color: G.green, background: G.greenBg, border: `1px solid ${G.green}40`, borderRadius: 6, padding: "2px 7px" }}>✓ 등록됨</span>)
                    : <span style={{ fontSize: 10, fontWeight: 800, color: KK.sub, background: "#fff", border: `1px solid ${KK.line}`, borderRadius: 6, padding: "2px 7px" }}>미등록</span>}
                  {registered && canManage && reRegId === n.id && (
                    <>
                      <span style={{ fontSize: 10, color: KK.sub }}>이미 등록된 주문이에요 · 다시 등록하면 중복될 수 있어요</span>
                      <button onClick={() => { onRegister?.(n); setReRegId(null); }} style={{ padding: "3px 10px", borderRadius: 7, border: "none", background: `linear-gradient(135deg,${G.copper},${G.copperLight})`, color: "#fff", fontSize: 11, fontWeight: 800, fontFamily: S, cursor: "pointer" }}>↻ 재등록</button>
                    </>
                  )}
                  {canManage && !registered && <button onClick={() => onRegister?.(n)} style={{ padding: "3px 10px", borderRadius: 7, border: "none", background: `linear-gradient(135deg,${G.copper},${G.copperLight})`, color: "#fff", fontSize: 11, fontWeight: 800, fontFamily: S, cursor: "pointer" }}>📥 주문 등록</button>}
                  {/* 수정 — 등록된 메모도 내용 수정 가능 (이미 등록된 주문에는 영향 없음) */}
                  {canManage && <button onClick={() => startEdit(n)} style={{ padding: "3px 8px", borderRadius: 7, border: `1px solid ${KK.line}`, background: "rgba(255,255,255,0.6)", color: KK.sub, fontSize: 11, fontFamily: S, cursor: "pointer" }}>수정</button>}
                  {canManage && <button onClick={() => { if (confirmDelId === n.id) { onDelete?.(n.id); setConfirmDelId(null); } else { setConfirmDelId(n.id); } }}
                    onBlur={() => setConfirmDelId((id) => (id === n.id ? null : id))}
                    style={{ padding: "3px 8px", borderRadius: 7, border: `1px solid ${G.red}${confirmDelId === n.id ? "" : "40"}`, background: confirmDelId === n.id ? G.red : "transparent", color: confirmDelId === n.id ? "#fff" : G.red, fontSize: 11, fontWeight: confirmDelId === n.id ? 800 : 400, fontFamily: S, cursor: "pointer" }}>{confirmDelId === n.id ? "정말 삭제?" : "삭제"}</button>}
                  {!canManage && !registered && <span style={{ fontSize: 10, color: KK.sub }}>· {n.author} 담당</span>}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}
      </div>

      {/* ── 입력창 (하단) — 카톡처럼 흰색 바 ── */}
      <div style={{ flexShrink: 0, marginTop: 8, position: "relative", background: "#FFFFFF", borderRadius: isMobile ? 14 : 12, padding: isMobile ? "10px 10px calc(10px + env(safe-area-inset-bottom))" : 10, boxShadow: "0 1px 3px rgba(0,0,0,0.10)" }}>
        {/* 고객 검색 */}
        <div style={{ position: "relative", marginBottom: 6 }}>
          <input value={custQuery} onChange={(e) => { setCustQuery(e.target.value); setPreviewCustId(null); }}
            onFocus={() => setCustFocus(true)} onBlur={() => setTimeout(() => { setCustFocus(false); setPreviewCustId(null); }, 150)}
            placeholder={isMobile ? "🔍 고객 검색" : "🔍 고객 검색 — 선택하면 이름·연락처·배송지가 메모에 들어가요"}
            style={{ ...baseInp, width: "100%", boxSizing: "border-box", fontSize: isMobile ? 16 : 12, padding: isMobile ? "10px 12px" : "8px 10px", background: "#F7F8FA", color: KK.text, border: `1px solid ${KK.line}` }} />
          {custSuggestions.length > 0 && (
            <div onMouseDown={(e) => e.preventDefault()} /* 입력창 포커스 유지 → 우클릭 미리보기 동안 드롭다운 유지 */
              style={{ position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 4, background: "#fff", border: `1px solid ${KK.line}`, borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.18)", overflow: "hidden", maxHeight: 260, overflowY: "auto", zIndex: 30 }}>
              {custSuggestions.map((c) => {
                const mid = extractMidPhone(c.phone);
                const recent = previewCustId === c.id ? recentOrdersOf(c.name) : null;
                return (
                  <div key={c.id} style={{ borderBottom: `1px solid ${KK.line}` }}>
                    <div onClick={() => pickCustomer(c)}
                      onContextMenu={(e) => { e.preventDefault(); setPreviewCustId((p) => (p === c.id ? null : c.id)); }}
                      title="우클릭: 최근 주문 미리보기"
                      style={{ padding: "8px 11px", cursor: "pointer", fontFamily: S }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#F5F7F9")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: KK.text, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span>{c.name}</span>
                        {c.nickname ? <span style={{ fontSize: 11, color: KK.sub, fontWeight: 500 }}>{c.nickname}</span> : null}
                        {mid && <span style={{ fontSize: 11, fontWeight: 700, fontFamily: SF, color: G.copper, background: G.copperGlow, border: `1px solid ${G.copper}40`, borderRadius: 6, padding: "1px 6px" }}>{mid}</span>}
                        {c.address2 && <span style={{ fontSize: 10, fontWeight: 700, color: "#2563EB", background: "rgba(37,99,235,0.08)", border: "1px solid rgba(37,99,235,0.25)", borderRadius: 6, padding: "1px 6px" }}>📍 배송지 2곳</span>}
                      </div>
                      <div style={{ fontSize: 11, color: KK.sub, marginTop: 1 }}>{c.phone || "연락처 없음"}{c.address ? ` · ${c.address}` : ""}</div>
                    </div>
                    {recent && (
                      <div onClick={(e) => e.stopPropagation()} style={{ padding: "6px 11px 8px", background: "#F8FAFC", borderTop: `1px dashed ${KK.line}` }}>
                        <div style={{ fontSize: 10, color: G.copper, fontWeight: 800, marginBottom: 4 }}>최근 주문 {recent.length}건</div>
                        {recent.length === 0
                          ? <div style={{ fontSize: 11, color: KK.sub }}>주문 내역이 없어요</div>
                          : recent.map((o) => (
                            <div key={o.id} style={{ fontSize: 11, color: KK.text, padding: "3px 0", display: "flex", justifyContent: "space-between", gap: 8 }}>
                              <span style={{ color: KK.sub, whiteSpace: "nowrap" }}>{o.date}</span>
                              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(o.items || []).map((i) => `${i.fabric}${i.color ? ` ${i.color}` : ""} ${i.qty}${i.unit || "마"}`).join(", ") || "—"}</span>
                              <span style={{ color: G.copper, fontWeight: 700, whiteSpace: "nowrap" }}>{(o.totalAmount || 0).toLocaleString()}원</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {/* 배송지 2곳 고객 선택 팝업 — 어느 주소를 메모에 넣을지 (팝업 창이라 window.confirm 불가 → 자체 오버레이) */}
        {addrPick && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setAddrPick(null)}>
            <div style={{ background: "#fff", borderRadius: 14, boxShadow: "0 8px 30px rgba(0,0,0,0.25)", padding: 18, width: "100%", maxWidth: 400, boxSizing: "border-box" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontSize: 14, fontWeight: 800, color: KK.text, marginBottom: 4 }}>📦 {addrPick.name} — 배송지가 2곳입니다</div>
              <div style={{ fontSize: 11, color: KK.sub, marginBottom: 12 }}>어느 주소를 메모에 넣을까요?</div>
              {[
                { l: "🏠 기본 배송지", a: addrPick.address || "", d: addrPick.addressDetail || "" },
                { l: `📍 배송지 2${addrPick.address2Label ? ` (${addrPick.address2Label})` : ""}`, a: addrPick.address2 || "", d: addrPick.address2Detail || "" },
              ].map((opt) => (
                <button key={opt.l} type="button"
                  onClick={() => { insertCustomerBlock(addrPick, opt.a, opt.d); setAddrPick(null); }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 13px", marginBottom: 8, borderRadius: 10, border: `1px solid ${KK.line}`, background: "#F7F8FA", cursor: "pointer", fontFamily: S }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#EEF2F6")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#F7F8FA")}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: KK.text, marginBottom: 2 }}>{opt.l}</div>
                  <div style={{ fontSize: 11, color: KK.sub, lineHeight: 1.5, wordBreak: "break-all" }}>{[opt.a, opt.d].filter(Boolean).join(" ") || "주소 없음"}</div>
                </button>
              ))}
              <button type="button" onClick={() => setAddrPick(null)} style={{ width: "100%", padding: "9px", borderRadius: 10, border: "none", background: "transparent", color: KK.sub, fontSize: 12, cursor: "pointer", fontFamily: S }}>취소</button>
            </div>
          </div>
        )}
        {/* 연결된 고객 표시 — 주문 등록 시 이 고객이 그대로 선택됨 */}
        {pendingCustomer && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: G.copper, background: G.copperGlow, border: `1px solid ${G.copper}40`, borderRadius: 12, padding: "3px 10px" }}>👤 {pendingCustomer.name} 연결됨 — 등록 시 이 고객으로</span>
            <button onClick={() => setPendingCustomer(null)} style={{ fontSize: 11, color: G.red, background: "none", border: "none", cursor: "pointer", fontFamily: S }}>해제</button>
          </div>
        )}
        {/* 메시지 입력 — 흰 배경 + 카톡 노랑 전송 버튼 */}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea ref={taRef} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
            placeholder={isMobile ? "주문 내용을 적어주세요" : "주문 내용을 적어주세요 (Ctrl+Enter 전송)"}
            style={{ ...baseInp, flex: 1, minWidth: 0, boxSizing: "border-box", minHeight: isMobile ? 88 : 60, height: isMobile ? 88 : 60, overflowY: "auto", resize: "none", lineHeight: 1.5, fontSize: isMobile ? 16 : 14, padding: isMobile ? "11px 12px" : "9px 11px", background: "#FFFFFF", color: KK.text, border: "none", outline: "none" }} />
          <button onClick={send} disabled={sending || !draft.trim()} style={{
            flexShrink: 0, height: isMobile ? 48 : 60, alignSelf: "flex-end", padding: isMobile ? "0 22px" : "0 18px", borderRadius: isMobile ? 24 : 10, border: "none", fontFamily: S, fontWeight: 800, fontSize: isMobile ? 15 : 14,
            cursor: sending || !draft.trim() ? "not-allowed" : "pointer",
            background: sending || !draft.trim() ? "#F0F1F3" : KK.myBubble,
            color: sending || !draft.trim() ? "#AAB2BC" : KK.text,
          }}>{sending ? "…" : "전송"}</button>
        </div>
        {!activeManager && <div style={{ fontSize: 10, color: KK.sub, marginTop: 4 }}>작업자 미선택 — ERP 본 창 상단에서 담당자를 골라주세요</div>}
      </div>
    </div>
  );
}

export default OrderNotesTab;
