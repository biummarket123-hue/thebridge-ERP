// 홈 — 요약 지표 4 · 빠른 실행 3 · 지금 처리할 일(전체현황 9구역) · 이번 주 출고 차트 · 최근 주문. 전부 실데이터(지시서 4·5절).
import { useMemo, useState } from "react";
import { useSaas } from "../data/SaasData.jsx";
import { PageHead, TextLink, StatCard, Button, Panel, TaskRow, BarChart, StatusBadge, Empty, Segment, won, manwon, shortId, nim } from "../components/ui.jsx";
import { Modal } from "../components/Modal.jsx";
import { Icon } from "../icons.jsx";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { orderStats, depositSum, monthRange, weeklyShipped, lastWeekShippedToDate, stockStats, relativeWhen, itemsSummary, orderTotal, isActiveOrder } from "../lib/metrics.js";
import { RECENT_ORDERS } from "../config.js";
import { fmtWhen } from "../../lib/overview.js";

const H = { isHold, isParked, getPayStatus };
const DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const MON = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const greet = (h) => h < 5 ? "늦은 시간까지 수고 많으세요" : h < 12 ? "좋은 아침이에요" : h < 18 ? "좋은 오후예요" : "좋은 저녁이에요";
const sun = (h) => h < 5 ? "🌙" : h < 12 ? "☀" : h < 18 ? "🌤" : "🌙";

/** 주문 상태 배지 — 주문 표·상세가 같은 규칙을 쓴다 */
export function orderBadges(o) {
  const out = [];
  if (o.status === "출고완료") out.push(["done", "출고완료"]);
  else if (isParked(o)) out.push(["gray", "보류"]);
  else if (isHold(o)) out.push(["purple", o.heldAt ? "보관중" : "보관 요청"]);
  else if (o.status === "포장완료") out.push(["progress", "포장완료"]);
  else out.push(["wait", "출고 대기"]);
  const pay = getPayStatus(o);
  if (pay !== "입금완료") out.push([pay === "환불신청" ? "late" : pay === "환불완료" || pay === "부분환불" ? "gray" : "late", pay]);
  if (o.mergeGroupId && !o.splitShipping) out.push(["purple", "합배송"]);
  return out;
}

export function OrderRows({ list, onOpen, limit }) {
  const rows = limit ? list.slice(0, limit) : list;
  if (!rows.length) return <Empty>조건에 맞는 주문이 없어요.</Empty>;
  return (
    <>
      <div className="tablewrap">
        <table className="dtable">
          <thead><tr><th>주문번호</th><th>거래처</th><th>품목</th><th>접수일</th><th>주문금액</th><th>상태</th></tr></thead>
          <tbody>
            {rows.map(o => (
              <tr key={o.id} onClick={() => onOpen(o)}>
                <td><strong className="mono">{shortId(o.id)}</strong></td>
                <td className="nowrap">{o.customer}{o.manager ? <small style={{ display: "block", color: "#9aabba", fontSize: 13 }}>{o.manager}</small> : null}</td>
                <td><span className="ellip">{itemsSummary(o, 2)}</span></td>
                <td className="nowrap">{relativeWhen(o.createdAt) || o.date}</td>
                <td><strong>{won(orderTotal(o))}</strong></td>
                <td><span className="badges">{orderBadges(o).map(([t, l]) => <StatusBadge key={l} tone={t}>{l}</StatusBadge>)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-list">
        {rows.map(o => (
          <button key={o.id} className="mobile-row" onClick={() => onOpen(o)}>
            <div className="left">
              <strong>{o.customer}</strong>
              <small><span className="mono">{shortId(o.id)}</span> · {itemsSummary(o, 1)}</small>
              <small>{relativeWhen(o.createdAt) || o.date}{o.manager ? ` · ${o.manager}` : ""}</small>
            </div>
            <div className="right">
              <span className="badges" style={{ justifyContent: "flex-end" }}>{orderBadges(o).slice(0, 2).map(([t, l]) => <StatusBadge key={l} tone={t}>{l}</StatusBadge>)}</span>
              <div className="amount">{won(orderTotal(o))}</div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

/** 처리할 일 — 전체현황 9구역 + 재고 부족 + 미입금. 구역을 누르면 그 주문들이 펼쳐진다. */
export function TodoModal({ onClose, go }) {
  const { overview, overviewScope, setOverviewScope, activeManager, groups, orders, mineOn, config } = useSaas();
  const LOW_STOCK_M = config.lowStockM;
  const [sel, setSel] = useState(null);
  const stock = useMemo(() => stockStats([], groups, LOW_STOCK_M), [groups, LOW_STOCK_M]);
  const st = useMemo(() => orderStats(orders, H), [orders]);
  const picked = overview.sections.find(s => s.key === sel);
  const tone = (t) => t === "red" ? "red" : t === "yellow" ? "alert" : "";
  return (
    <Modal title={picked ? picked.title : "지금 처리할 일"} onClose={onClose} width="wide">
      {!picked ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "12px 0 6px" }}>
            <p className="helptext" style={{ margin: 0, flex: 1, minWidth: 180 }}>
              {mineOn ? <b>{activeManager} 담당</b> : "전체"} · 진행 중 {overview.active}건 · 확인 필요 <b style={{ color: overview.flagged ? "#d76964" : "#23986f" }}>{overview.flagged}건</b>
            </p>
            <Segment options={[["all", "전체"], ["mine", "내 담당"]]} value={overviewScope} onChange={setOverviewScope} />
          </div>
          {overview.flagged === 0 && <div className="notice-box" style={{ marginBottom: 10 }}>✅ 오늘 이상 없음 — 놓치고 있는 주문이 없습니다.</div>}
          <div className="tasklist">
            {overview.sections.filter(s => s.rows.length > 0).map(s => (
              <TaskRow key={s.key} emoji={s.icon} tone={tone(s.tone)} title={s.title} hint={s.hint} count={`${s.rows.length}건`} onClick={() => setSel(s.key)} />
            ))}
            {stock.low + stock.out > 0 && <TaskRow icon="alert" title="재고가 부족한 품목" hint={`최대 재단 가능 길이 ${LOW_STOCK_M}마 미만 ${stock.low}개 · 품절 ${stock.out}개`} count={`${stock.low + stock.out}개`} onClick={() => go("/app/stock")} />}
            {st.unpaidCount > 0 && <TaskRow icon="finance" tone="mint" title="입금 확인이 안 된 주문" hint={`미수금 ${won(st.unpaidSum)}`} count={`${st.unpaidCount}건`} onClick={() => go("/app/settlement")} />}
            {st.refundRequested > 0 && <TaskRow icon="undo" tone="alert" title="환불 신청 대기" hint="정산에서 승인·반려" count={`${st.refundRequested}건`} onClick={() => go("/app/settlement")} />}
          </div>
        </>
      ) : (
        <>
          <p className="helptext">{picked.hint}</p>
          <button className="text-link" onClick={() => setSel(null)} style={{ padding: "6px 0", marginBottom: 6 }}><Icon name="back" /> 목록으로</button>
          <div className="tasklist">
            {picked.rows.map(r => (
              <TaskRow key={r.order.id} emoji={picked.icon} tone={tone(picked.tone)} title={`${r.order.customer} · ${shortId(r.order.id)}`} hint={r.note}
                count={r.days > 0 ? `${r.days}${r.unit}` : "오늘"} onClick={() => go(`/app/orders/${r.order.id}`)} />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

export default function HomePage({ route }) {
  const { orders, products, groups, paymentLogs, shipped, overview, activeManager, loaded, overviewScope, setOverviewScope, mineOn, config } = useSaas();
  const LOW_STOCK_M = config.lowStockM;
  const now = new Date();
  const st = useMemo(() => orderStats(orders, H, now), [orders]);   // eslint-disable-line react-hooks/exhaustive-deps
  const stock = useMemo(() => stockStats(products, groups, LOW_STOCK_M), [products, groups, LOW_STOCK_M]);
  const month = useMemo(() => { const r = monthRange(now); return depositSum(paymentLogs, r.start, r.end); }, [paymentLogs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const lastMonth = useMemo(() => { const r = monthRange(now, -1); return depositSum(paymentLogs, r.start, r.end).sum; }, [paymentLogs]);   // eslint-disable-line react-hooks/exhaustive-deps
  const week = useMemo(() => weeklyShipped(shipped, now), [shipped]);   // eslint-disable-line react-hooks/exhaustive-deps
  const lastWeek = useMemo(() => lastWeekShippedToDate(shipped, now), [shipped]);   // eslint-disable-line react-hooks/exhaustive-deps
  const recent = useMemo(() => [...orders].filter(isActiveOrder).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))), [orders]);
  const [todo, setTodo] = useState(false);
  const go = route.go;

  const deltaToday = st.todayCount - st.yesterdayCount;
  const monthDelta = lastMonth > 0 ? Math.round((month.sum - lastMonth) / lastMonth * 1000) / 10 : null;
  const weekDelta = lastWeek > 0 ? Math.round((week.total - lastWeek) / lastWeek * 1000) / 10 : null;
  const flaggedSections = overview.sections.filter(s => s.rows.length > 0);

  return (
    <>
      <PageHead eyebrow={`${DOW[now.getDay()]}, ${MON[now.getMonth()]} ${now.getDate()}`}
        title={<>{greet(now.getHours())}, {nim(activeManager || "관리자")} <span style={{ fontSize: ".75em" }}>{sun(now.getHours())}</span></>}
        subtitle="오늘 처리할 업무를 한눈에 확인해 보세요."
        right={<TextLink onClick={() => go("/app/orders")}>주문 전체 보기</TextLink>} />

      <div className="stats">
        <StatCard title="오늘 들어온 주문" value={st.todayCount} unit="건" icon="orders"
          note={deltaToday === 0 ? "어제와 같아요" : `어제보다 ${Math.abs(deltaToday)}건 ${deltaToday > 0 ? "증가" : "감소"}`} noteTone={deltaToday > 0 ? "" : "muted"} onClick={() => go("/app/orders")} />
        <StatCard title="출고 대기" value={st.shipWaiting} unit="건" icon="truck" tone="orange"
          note={st.packed > 0 ? `포장완료 ${st.packed}건 포함` : "확인이 필요해요"} noteTone="alert" onClick={() => go("/app/orders")} />
        <StatCard title="총 재고" value={stock.totalRemaining} unit="마" icon="box" tone="mint"
          note={`${stock.productCount.toLocaleString()}개 품목 관리 중`} noteTone="muted" onClick={() => go("/app/stock")} />
        <StatCard title="이번 달 매출" value={manwon(month.sum)} unit="만원" icon="trend" tone="purple"
          note={monthDelta === null ? `입금 ${month.count}건 기준` : `지난달 대비 ${monthDelta >= 0 ? "+" : ""}${monthDelta}%`} noteTone={monthDelta === null || monthDelta < 0 ? "muted" : ""} onClick={() => go("/app/settlement")} />
      </div>

      <section className="quick">
        <div className="quick-caption"><strong>무엇을 도와드릴까요?</strong><span>자주 쓰는 업무를 바로 시작하세요</span></div>
        <div className="actions">
          <Button className="action" icon="plus" onClick={() => go("/app/orders/new")}>주문 등록</Button>
          <Button className="action" kind="white" icon="box" onClick={() => go("/app/stock/receive")}>입고 등록</Button>
          <Button className="action" kind="white" icon="truck" onClick={() => go("/app/orders/ship")}>출고 처리</Button>
        </div>
      </section>

      <div className="panels">
        <Panel title="지금 처리할 일" right={<TextLink onClick={() => setTodo(true)}>전체 보기</TextLink>}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <small style={{ color: "#8b9bb0", fontSize: 14, fontWeight: 650, flex: 1 }}>
              {mineOn ? `${activeManager} 담당` : "전체"} · 진행 중 {overview.active}건 · 확인 필요 <b style={{ color: overview.flagged ? "#d76964" : "#23986f" }}>{overview.flagged}건</b>
            </small>
            <Segment options={[["all", "전체"], ["mine", "내 담당"]]} value={overviewScope} onChange={setOverviewScope} />
          </div>
          <div className="tasklist">
            {flaggedSections.slice(0, 4).map(s => (
              <TaskRow key={s.key} emoji={s.icon} tone={s.tone === "red" ? "red" : s.tone === "yellow" ? "alert" : ""} title={s.title} hint={s.hint} count={`${s.rows.length}건`} onClick={() => setTodo(true)} />
            ))}
            {flaggedSections.length === 0 && <div className="notice-box">✅ 오늘 이상 없음 — 놓치고 있는 주문이 없습니다.</div>}
            {stock.low + stock.out > 0 && <TaskRow icon="alert" title="재고가 부족한 품목" hint={`최대 재단 가능 길이 ${LOW_STOCK_M}마 미만 · 품절 ${stock.out}개`} count={`${stock.low + stock.out}개`} onClick={() => go("/app/stock")} />}
            {st.unpaidCount > 0 && <TaskRow icon="finance" tone="mint" title="확인하지 않은 입금" hint={`미입금·부분입금 주문 · 미수금 ${won(st.unpaidSum)}`} count={`${st.unpaidCount}건`} onClick={() => go("/app/settlement")} />}
          </div>
        </Panel>
        <Panel title="이번 주 출고 현황" small="단위: 건">
          <div className="chartsum">
            <strong>{week.total.toLocaleString()}건</strong>
            {weekDelta === null ? <small className="flat">지난주 같은 기간 {lastWeek}건</small>
              : <small className={weekDelta < 0 ? "down" : ""}>{weekDelta >= 0 ? "↗" : "↘"} 지난주 대비 {Math.abs(weekDelta)}%</small>}
          </div>
          <BarChart bars={week.bars} />
          <div className="chartfoot">{loaded ? "출고완료 처리된 시각(shipped_at) 기준 · 월요일부터" : "불러오는 중…"}</div>
        </Panel>
      </div>

      <Panel title="최근 주문" full right={<TextLink onClick={() => go("/app/orders")}>모든 주문</TextLink>}>
        <OrderRows list={recent} limit={RECENT_ORDERS} onOpen={(o) => go(`/app/orders/${o.id}`)} />
      </Panel>

      {todo && <TodoModal onClose={() => setTodo(false)} go={(p) => { setTodo(false); go(p); }} />}
    </>
  );
}

export { fmtWhen };
