// 주문 관리 — 목록·검색·필터, 주문 등록(AI), 상세, 출고 처리(3단계), 반품·교환.
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { PageHead, StatCard, Button, Panel, SearchInput, FilterChips, Segment, LoadingLine, Chip } from "../components/ui.jsx";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { orderStats, isActiveOrder, itemsSummary } from "../lib/metrics.js";
import { OrderRows } from "./HomePage.jsx";
import OrderDetail from "./OrderDetail.jsx";
import NewOrder from "./NewOrder.jsx";
import ShipFlow from "./ShipFlow.jsx";
import Returns from "./Returns.jsx";
import ChannelImport from "./ChannelImport.jsx";
import { PAGE_SIZE } from "../config.js";
import { downloadXlsx, orderRows, orderItemRows, safeName, todayStamp } from "../lib/xlsx.js";
import "../saas-data.css";

const H = { isHold, isParked, getPayStatus };
const FILTERS = [["all", "전체 주문"], ["wait", "출고 대기"], ["packed", "포장완료"], ["unpaid", "미입금"], ["held", "보관"], ["parked", "보류"], ["refund", "환불 신청"], ["shipped", "출고완료(60일)"]];
const DIRECT = "직접·밴드";   // salesChannel 이 빈 주문(밴드·전화·방문)의 표시 이름

export default function OrdersPage({ route }) {
  const { orders, shipped, loaded, activeManager, config, isPacker } = useSaas();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const [chan, setChan] = useState("all");   // 판매처 칩: all | "" (직접·밴드) | 판매처 이름
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [tab, setTab] = useState("orders");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [dlOpen, setDlOpen] = useState(false);
  const [fetched, setFetched] = useState(null);   // 목록에 없는 주문(출고완료 등)을 경로로 열었을 때
  const go = route.go;
  const st = useMemo(() => orderStats(orders, H), [orders]);
  const active = useMemo(() => orders.filter(isActiveOrder), [orders]);
  // 판매처 칩 — 활성 주문의 salesChannel 값에서 동적으로. 빈값은 "직접·밴드".
  const channels = useMemo(() => {
    const m = new Map();
    for (const o of active) { const k = o.salesChannel || ""; m.set(k, (m.get(k) || 0) + 1); }
    const list = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return list.length > 1 ? list.map(([k, n]) => [k === "" ? "ch:" : `ch:${k}`, k || DIRECT, n]) : [];
  }, [active]);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const digits = ql.replace(/\D/g, "");
    // 출고완료 칩은 최근 60일 출고완료(shipped) 를 보여 준다 — 활성 목록에는 없는 주문(2026-10-20). 더 오래된 건은 변경 기록·반품 검색에서.
    const pool = filter === "shipped" ? shipped : active;
    return pool.filter(o => {
      if (mine && o.manager !== activeManager) return false;
      if (chan !== "all" && (o.salesChannel || "") !== chan) return false;
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
    }).sort((a, b) => filter === "shipped" ? String(b.shippedAt || "").localeCompare(String(a.shippedAt || "")) : String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [active, shipped, filter, chan, q, mine, activeManager]);
  useEffect(() => { setShown(PAGE_SIZE); }, [filter, chan, q, mine]);

  // 엑셀 내려받기 — 지금 보이는 목록 / 활성 주문 전체 / 출고완료 포함 전체(db.fetchAllOrders). 파일명은 회사명.
  const download = async (scope) => {
    let rows = list, label = "주문_목록";
    try {
      if (scope === "active") { rows = active; label = "주문_진행중"; }
      else if (scope === "all") { toast("출고완료까지 전부 읽는 중…"); rows = await db.fetchAllOrders(); label = "주문_전체"; }
      if (!rows.length) { toast("내려받을 주문이 없습니다", "error"); return; }
      const fileName = `${safeName(config.companyName)}_${label}_${todayStamp()}.xlsx`;
      downloadXlsx({ sheets: [{ name: "주문", rows: orderRows(rows) }, { name: "품목", rows: orderItemRows(rows) }], fileName });
      toast(`${rows.length}건 → ${fileName}`);
      setDlOpen(false);
    } catch (e) { toast("내려받기 실패: " + e.message, "error"); }
  };

  const special = ["new", "ship", "import"].includes(route.id);
  const selected = route.id && !special ? (orders.find(o => o.id === route.id) || (fetched?.id === route.id ? fetched : null)) : null;
  useEffect(() => {
    if (!route.id || special || orders.some(o => o.id === route.id) || fetched?.id === route.id) return;
    // 목록 밖 주문(출고완료 등)은 입금 계산(_computed)이 없어 상세의 입금·미수금이 틀리게 보인다 — 입금 로그로 같이 계산한다(2026-10-20)
    db.fetchOrdersByIds([route.id]).then(async rows => {
      const o = rows[0];
      if (!o) { toast("주문을 찾을 수 없습니다", "error"); return; }
      try {
        const logs = await db.fetchOrderLogs(o.id);
        const total = o.totalAmount > 0 ? o.totalAmount : (o.items || []).reduce((s, i) => s + (i.amount || 0), 0);
        setFetched({ ...o, _computed: db.calcOrderMoney(logs, total, o.payment) });
      } catch { setFetched(o); }
    }).catch(e => toast(e.message, "error"));
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
          {!isPacker && <Button kind="white" size="sm" icon="file" onClick={() => go("/app/orders/import")}>채널 주문 가져오기</Button>}
          <Button kind="white" size="sm" icon="download" onClick={() => setDlOpen(v => !v)} aria-expanded={dlOpen}>엑셀 내려받기</Button>
          <Button kind="white" size="sm" icon="truck" onClick={() => go("/app/orders/ship")}>출고 처리</Button>
        </div>
      </div>
      {dlOpen && (
        <div className="dl-menu">
          <small>내려받을 범위</small>
          <Chip onClick={() => download("list")}>지금 보이는 목록 ({list.length}건)</Chip>
          <Chip onClick={() => download("active")}>진행 중 주문 전체 ({active.length}건)</Chip>
          <Chip onClick={() => download("all")}>출고완료 포함 전체</Chip>
          <Chip onClick={() => setDlOpen(false)}>닫기</Chip>
        </div>
      )}
      {tab === "orders" ? (
        <>
          <div className="searchline">
            <FilterChips value={filter} onChange={setFilter} options={FILTERS} />
            <SearchInput value={q} onChange={setQ} placeholder="고객명 · 연락처 · 품목 · 담당자 · 주문번호" />
          </div>
          {channels.length > 0 && (
            <FilterChips style={{ marginBottom: 12 }} value={chan === "all" ? "all" : `ch:${chan}`} onChange={(id) => setChan(id === "all" ? "all" : id.slice(3))} options={[["all", "모든 판매처"], ...channels]} />
          )}
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
      {route.id === "import" && <ChannelImport onClose={() => go("/app/orders")} />}
    </>
  );
}
