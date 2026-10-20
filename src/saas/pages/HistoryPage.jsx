// 변경 기록(/app/history) — 누가 언제 어느 화면에서 무엇을 바꿨는지. 쓰는 건 DB 트리거(migrations/add_order_events.sql), 여기는 읽기만.
// 옛 전체현황 탭(src/components/OverviewTab.jsx 의 RecentEvents·OrderEvents)을 새 UI 로 옮긴 것.
//   /app/history       최근 기록(새것부터 100건, "더 보기"로 +100). 고객명 검색은 서버(ilike), 담당자·종류·기간은 화면에서 거른다.
//   /app/history/:id   그 주문의 기록만(오래된 것부터 — 이야기 순서) + "전체 기록으로".
// 출고완료되거나 삭제돼서 주문 목록에 없는 건도 여기서는 찾을 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { describeEvent, fmtWhen } from "../../lib/overview.js";
import { PageHead, Panel, Button, SearchInput, FilterChips, Segment, Chip, StatusBadge, Empty, LoadingLine, shortId } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import "../saas-history.css";

const PAGE = 100;
const KINDS = [["all", "전체"], ["insert", "등록"], ["update", "변경"], ["delete", "삭제"], ["ship", "출고"], ["pay", "입금"]];
const PERIODS = [["today", "오늘"], ["7d", "7일"], ["30d", "30일"], ["all", "전체"]];
const KIND_BADGE = { insert: ["progress", "등록"], delete: ["late", "삭제"], ship: ["done", "출고"], pay: ["purple", "입금"], update: ["gray", "변경"] };
const NO_ACTOR = "\u0000none";   // 담당자 도장이 없는 기록을 거르는 칩의 키

/** 기록 하나가 어느 종류인가 — 한 기록이 여러 종류일 수 있다(상태 출고완료 + 결제 변경). */
function kindsOf(ev) {
  const s = new Set();
  if (ev.op === "INSERT") { s.add("insert"); return s; }
  if (ev.op === "DELETE") { s.add("delete"); return s; }
  const c = ev.changes || {};
  s.add("update");
  if (c.status?.to === "출고완료" || (c.shipped_via && c.shipped_via.to) || (c.shipped_at && c.shipped_at.to)) s.add("ship");
  if (c.payment) s.add("pay");
  return s;
}
/** 목록 줄에 붙일 대표 종류 하나 — 출고·입금이 있으면 그것, 아니면 등록·삭제·변경 */
function mainKind(ks) { return ks.has("ship") ? "ship" : ks.has("pay") ? "pay" : ks.has("insert") ? "insert" : ks.has("delete") ? "delete" : "update"; }

function periodStart(key, now = new Date()) {
  if (key === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (key === "7d") return now.getTime() - 7 * 86400000;
  if (key === "30d") return now.getTime() - 30 * 86400000;
  return 0;
}
const dateLabel = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`; };
const relDay = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return "";
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.floor((t.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  return diff === 0 ? "오늘" : diff === 1 ? "어제" : diff < 7 ? `${diff}일 전` : dateLabel(iso);
};
const errorText = (e) => {
  const m = String(e?.message || e || "");
  return /order_events|does not exist|42P01/i.test(m) ? "변경 기록이 아직 켜지지 않았습니다 — migrations/add_order_events.sql 을 실행해야 합니다" : `기록을 불러오지 못했습니다: ${m}`;
};

function EventRow({ ev, showCustomer, onOpen }) {
  const ks = kindsOf(ev);
  const [tone, label] = KIND_BADGE[mainKind(ks)];
  return (
    <article className={`hist-row${onOpen ? "" : " single"}`}>
      <div className="hist-when">{fmtWhen(ev.createdAt)}<small>{relDay(ev.createdAt)}</small></div>
      <div className="hist-main">
        <div className="hist-head">
          <StatusBadge tone={tone}>{label}</StatusBadge>
          <span className={`hist-actor${ev.actor ? "" : " none"}`}>{ev.actor || "작업자 기록 없음"}</span>
          {showCustomer ? <strong>{ev.customer || "(고객명 없음)"}</strong> : null}
          <span className="mono">{shortId(ev.orderId)}</span>
          {ev.route ? <span className="hist-route">{ev.route}</span> : null}
        </div>
        <ul className="hist-lines">{describeEvent(ev).map((line, i) => <li key={i}>{line}</li>)}</ul>
      </div>
      {onOpen ? <div className="hist-open"><Button kind="white" size="sm" icon="orders" onClick={() => onOpen(ev.orderId)}>주문 열기</Button></div> : null}
    </article>
  );
}

/** 주문 하나의 기록(/app/history/:id) */
function OrderHistory({ orderId, go }) {
  const [state, setState] = useState({ loading: true, events: [], error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, events: [], error: null });
    db.fetchOrderEvents(orderId)
      .then(events => { if (alive) setState({ loading: false, events, error: null }); })
      .catch(error => { if (alive) setState({ loading: false, events: [], error }); });
    return () => { alive = false; };
  }, [orderId]);
  const customer = state.events.find(e => e.customer)?.customer || "";
  return (
    <>
      <PageHead eyebrow="HISTORY" title="주문 변경 기록" subtitle="이 주문 하나에 있었던 일을 오래된 것부터 봅니다."
        right={<button className="text-link" onClick={() => go("/app/history")}><Icon name="back" /> 전체 기록으로</button>} />
      <Panel>
        <div className="hist-order-head">
          <div><strong>{customer || "주문"}</strong> <span className="mono" style={{ color: "#7b89a0" }}>{shortId(orderId)}</span></div>
          <div className="hist-open" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button kind="white" size="sm" icon="orders" onClick={() => go(`/app/orders/${orderId}`)}>주문 열기</Button>
            <Button kind="white" size="sm" icon="back" onClick={() => go("/app/history")}>전체 기록으로</Button>
          </div>
        </div>
        {state.loading ? <LoadingLine>기록 불러오는 중…</LoadingLine>
          : state.error ? <p className="helptext err">{errorText(state.error)}</p>
          : state.events.length === 0 ? <Empty small>남은 기록이 없습니다 — 기록을 켜기 전에 등록·변경된 주문이거나, 주문번호가 틀렸을 수 있어요.</Empty>
          : <div className="hist-list">{state.events.map(ev => <EventRow key={ev.id} ev={ev} />)}</div>}
      </Panel>
    </>
  );
}

export default function HistoryPage({ route }) {
  const go = route.go;
  if (route.id) return <OrderHistory orderId={route.id} go={go} />;
  return <RecentHistory go={go} />;
}

function RecentHistory({ go }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");          // 서버에 보낸 검색어(입력을 300ms 늦춰 보낸다)
  const [limit, setLimit] = useState(PAGE);
  const [actor, setActor] = useState("all");
  const [kind, setKind] = useState("all");
  const [period, setPeriod] = useState("7d");
  const [state, setState] = useState({ loading: true, events: [], error: null });
  const seq = useRef(0);

  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const events = await db.fetchRecentOrderEvents({ customer: term, limit });
      if (my !== seq.current) return;   // 낡은 응답은 버린다
      setState({ loading: false, events, error: null });
    } catch (error) { if (my === seq.current) setState({ loading: false, events: [], error }); }
  }, [term, limit]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setLimit(PAGE); }, [term]);   // 검색어가 바뀌면 처음부터

  const events = state.events;
  const actors = useMemo(() => {
    const m = new Map();
    for (const ev of events) { const k = ev.actor || NO_ACTOR; m.set(k, (m.get(k) || 0) + 1); }
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [events]);
  // 담당자 칩에서 고른 사람이 결과에서 사라지면(검색어 변경) 전체로 되돌린다
  useEffect(() => { if (actor !== "all" && !actors.some(([k]) => k === actor)) setActor("all"); }, [actors, actor]);

  const inPeriod = useMemo(() => { const from = periodStart(period); return from ? events.filter(ev => new Date(ev.createdAt).getTime() >= from) : events; }, [events, period]);
  const byActor = useMemo(() => actor === "all" ? inPeriod : inPeriod.filter(ev => (ev.actor || NO_ACTOR) === actor), [inPeriod, actor]);
  const kindCounts = useMemo(() => {
    const c = { all: byActor.length };
    for (const ev of byActor) for (const k of kindsOf(ev)) c[k] = (c[k] || 0) + 1;
    return c;
  }, [byActor]);
  const list = useMemo(() => kind === "all" ? byActor : byActor.filter(ev => kindsOf(ev).has(kind)), [byActor, kind]);
  const canMore = events.length >= limit;
  const oldest = events.length ? events[events.length - 1].createdAt : null;

  return (
    <>
      <PageHead eyebrow="HISTORY" title="변경 기록" subtitle="누가 언제 어느 화면에서 무엇을 바꿨는지 봅니다. 출고완료·삭제된 주문도 여기서는 찾을 수 있어요."
        right={<Button kind="white" size="sm" icon="refresh" onClick={load} loading={state.loading && events.length > 0}>다시 읽기</Button>} />
      <Panel full>
        <div className="hist-tools">
          <SearchInput value={q} onChange={setQ} placeholder="고객명으로 찾기" id="hist-q" />
          <Segment options={PERIODS} value={period} onChange={setPeriod} />
        </div>
        <FilterChips options={KINDS.map(([k, l]) => [k, l, kindCounts[k] || 0])} value={kind} onChange={setKind} style={{ marginBottom: 12 }} />
        {actors.length > 1 && (
          <div className="hist-chips">
            <span className="lbl"><Icon name="user" /></span>
            <Chip on={actor === "all"} onClick={() => setActor("all")}>모든 담당자</Chip>
            {actors.map(([k, n]) => <Chip key={k} on={actor === k} onClick={() => setActor(actor === k ? "all" : k)}>{k === NO_ACTOR ? "기록 없음" : k} {n}</Chip>)}
          </div>
        )}
        {!state.loading && !state.error && events.length > 0 && (
          <p className="hist-count">
            {list.length === events.length ? `${events.length}건` : `${list.length}건 (불러온 ${events.length}건 중)`}
            {term ? ` · "${term}" 검색` : ""}{oldest ? ` · ${dateLabel(oldest)} 이후` : ""}{canMore ? " · 더 오래된 기록은 아래 '더 보기'" : ""}
          </p>
        )}
        {state.error ? <p className="helptext err">{errorText(state.error)}</p>
          : state.loading && events.length === 0 ? <LoadingLine>기록 불러오는 중…</LoadingLine>
          : events.length === 0 ? <Empty>{term ? `"${term}" 고객의 기록이 없어요.` : "아직 기록이 없어요. 주문을 등록·변경하면 여기에 쌓입니다."}</Empty>
          : list.length === 0 ? <Empty small>조건에 맞는 기록이 없어요. 기간을 넓히거나{canMore ? " '더 보기'로 더 불러오거나" : ""} 필터를 바꿔 보세요.</Empty>
          : <div className="hist-list">{list.map(ev => <EventRow key={ev.id} ev={ev} showCustomer onOpen={(id) => go(`/app/orders/${id}`)} />)}</div>}
        {canMore && !state.error && (
          <div className="pager"><Button kind="white" onClick={() => setLimit(l => l + PAGE)} loading={state.loading}>더 보기 (+{PAGE}건)</Button></div>
        )}
      </Panel>
    </>
  );
}
