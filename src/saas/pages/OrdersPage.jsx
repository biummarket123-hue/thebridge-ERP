// 주문 관리 — 목록·검색·필터, 주문 등록(AI), 상세, 출고 처리(3단계), 반품·교환.
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { PageHead, StatCard, Button, Panel, SearchInput, FilterChips, Segment, LoadingLine } from "../components/ui.jsx";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { orderStats, isActiveOrder, itemsSummary } from "../lib/metrics.js";
import { OrderRows } from "./HomePage.jsx";
import OrderDetail from "./OrderDetail.jsx";
import NewOrder from "./NewOrder.jsx";
import ShipFlow from "./ShipFlow.jsx";
import Returns from "./Returns.jsx";
import { PAGE_SIZE } from "../config.js";

const H = { isHold, isParked, getPayStatus };
const FILTERS = [["all", "전체 주문"], ["wait", "출고 대기"], ["packed", "포장완료"], ["unpaid", "미입금"], ["held", "보관"], ["parked", "보류"], ["refund", "환불 신청"]];

export default function OrdersPage({ route }) {
  const { orders, loaded, activeManager } = useSaas();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [tab, setTab] = useState("orders");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [fetched, setFetched] = useState(null);   // 목록에 없는 주문(출고완료 등)을 경로로 열었을 때
  const go = route.go;
  const st = useMemo(() => orderStats(orders, H), [orders]);
  const active = useMemo(() => orders.filter(isActiveOrder), [orders]);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const digits = ql.replace(/\D/g, "");
    return active.filter(o => {
      if (mine && o.manager !== activeManager) return false;
      const pay = getPayStatus(o);
      if (filter === "wait" && (o.status === "포장완료" || isHold(o) || isParked(o))) return false;
      if (filter === "packed" && o.status !== "포장완료") return false;
      if (filter === "unpaid" && !(pay === "미입금" || pay === "부분입금")) return false;
      if (filter === "held" && !isHold(o)) return false;
      if (filter === "parked" && !isParked(o)) return false;
      if (filter === "refund" && pay !== "환불신청") return false;
      if (!ql) return true;
      return String(o.customer || "").toLowerCase().includes(ql) || (digits.length >= 3 && String(o.phone || "").replace(/\D/g, "").includes(digits))
        || String(o.id).toLowerCase().startsWith(ql) || itemsSummary(o, 99).toLowerCase().includes(ql) || String(o.manager || "").toLowerCase().includes(ql) || String(o.address || "").toLowerCase().includes(ql);
    }).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [active, filter, q, mine, activeManager]);
  useEffect(() => { setShown(PAGE_SIZE); }, [filter, q, mine]);

  const special = ["new", "ship"].includes(route.id);
  const selected = route.id && !special ? (orders.find(o => o.id === route.id) || (fetched?.id === route.id ? fetched : null)) : null;
  useEffect(() => {
    if (!route.id || special || orders.some(o => o.id === route.id) || fetched?.id === route.id) return;
    db.fetchOrdersByIds([route.id]).then(rows => { if (rows[0]) setFetched(rows[0]); else toast("주문을 찾을 수 없습니다", "error"); }).catch(e => toast(e.message, "error"));
  }, [route.id, special, orders, fetched, toast]);

  return (
    <>
      <PageHead eyebrow="ORDERS" title="주문 관리" subtitle="주문을 찾고, 진행 상태를 확인하세요." right={<Button icon="plus" onClick={() => go("/app/orders/new")}>주문 등록</Button>} />
      <div className="stats">
        <StatCard title="오늘 주문" value={st.todayCount} unit="건" icon="orders" note={st.yesterdayCount ? `어제 ${st.yesterdayCount}건` : "접수 기준"} noteTone="muted" />
        <StatCard title="출고 대기" value={st.shipWaiting} unit="건" icon="clock" tone="orange" note="보관·보류 제외" noteTone="alert" onClick={() => setFilter("wait")} />
        <StatCard title="포장완료" value={st.packed} unit="건" icon="truck" note="송장·출고 대기" noteTone="muted" onClick={() => setFilter("packed")} />
        <StatCard title="미입금" value={st.unpaidCount} unit="건" icon="finance" tone="mint" note={`보관 ${st.held} · 보류 ${st.parked} · 환불 신청 ${st.refundRequested}`} noteTone="muted" onClick={() => setFilter("unpaid")} />
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <Segment options={[["orders", `주문 ${active.length}`], ["returns", "반품·교환"]]} value={tab} onChange={setTab} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button kind="white" size="sm" icon="truck" onClick={() => go("/app/orders/ship")}>출고 처리</Button>
        </div>
      </div>
      {tab === "orders" ? (
        <>
          <div className="searchline">
            <FilterChips value={filter} onChange={setFilter} options={FILTERS} />
            <SearchInput value={q} onChange={setQ} placeholder="고객명 · 연락처 · 품목 · 담당자 · 주문번호" />
          </div>
          <Panel title="주문 목록" full right={
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <small style={{ color: "#8b9bb0", fontSize: 14, fontWeight: 650 }}>{list.length}건 · 최근 접수 순</small>
              <Segment options={[["all", "전체"], ["mine", "내 담당"]]} value={mine ? "mine" : "all"} onChange={(v) => setMine(v === "mine")} />
            </div>}>
            {!loaded ? <LoadingLine /> : <OrderRows list={list} limit={shown} onOpen={(o) => go(`/app/orders/${o.id}`)} />}
            {list.length > shown && <div className="pager"><Button kind="white" onClick={() => setShown(s => s + PAGE_SIZE)}>더 보기 ({list.length - shown}건 남음)</Button></div>}
          </Panel>
        </>
      ) : <Returns />}
      {selected && <OrderDetail order={selected} onClose={() => go("/app/orders")} go={go} />}
      {route.id === "new" && <NewOrder onClose={() => go("/app/orders")} onRegistered={(o) => go(`/app/orders/${o.id}`, { replace: true })} />}
      {route.id === "ship" && <ShipFlow onClose={() => go("/app/orders")} go={go} />}
    </>
  );
}
