import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, Tag } from "./UI.jsx";
import { S, SF, useTheme, isHold, isParked, getPayStatus, sC, pC } from "../constants.js";
import * as db from "../lib/db.js";
import { buildOverview, describeEvent, fmtWhen } from "../lib/overview.js";

// 전체현황 — 아침에 한 번 보는 화면. 전 직원이 본다(처음에는 관리자 전용이었다).
// 읽기만 하는 화면이다 — 여기서는 주문을 고치지 않는다. 고치는 버튼을 넣으려면
// 누구에게 열려 있는 화면인지부터 다시 따져야 한다.
//
// 출고완료된 과거 주문은 빼고, 지금 진행 중인 주문 가운데 "놓치고 있는 것"만 모은다.
// 지금까지는 이 정보가 조각나 있었다 — 헤더의 미입금 칩, 포장탭의 지연 경고, 보관 탭.
// 어느 것도 "물건은 나갔는데 상태만 안 바뀐 주문"을 보여주지 않았고, 그런 주문은 누가
// 일일이 찾기 전까지 주문현황에 남았다.
//
// 이 화면이 하는 일은 '당일 안에 발견'까지다. 발생 자체를 막지는 못한다 — 그건 실물을
// 건네는 사람이 출고를 확정하는 구조가 있어야 한다. 대신 어떤 유형이 실제로 많이
// 생기는지를 숫자로 보여주므로, 그 결정을 내릴 근거가 된다.
//
// 어떤 주문을 문제로 볼지(며칠째부터, 무엇을 뺄지)는 lib/overview.js 에 있다.

const shortId = (id) => `#${String(id).slice(0, 8)}`;
const itemsLine = (o) => (o.items || [])
  .map(i => `${i.fabric || ""}${i.color ? " " + i.color : ""} ${i.qty || 0}${i.unit || "마"}`.trim())
  .filter(Boolean).join(", ");

// 기록 테이블이 아직 없는 DB — 마이그레이션 전. 에러 대신 할 일을 알려준다.
const isNoTable = (e) => e?.code === "PGRST205" || e?.code === "42P01" || /could not find the table|does not exist/i.test(e?.message || "");

function EventLine({ ev, showCustomer }) {
  const T = useTheme();
  const tone = ev.op === "DELETE" ? T.red : ev.op === "INSERT" ? T.green : T.cream;
  return (
    <div style={{display:"flex",gap:8,padding:"7px 0",borderTop:`1px solid ${T.border}`,fontSize:12,lineHeight:1.55}}>
      <div style={{flex:"none",width:74,color:T.creamMuted,fontFamily:"monospace",fontSize:11}}>{fmtWhen(ev.createdAt)}</div>
      <div style={{flex:1,minWidth:0}}>
        {showCustomer && (
          <div style={{fontWeight:700,color:T.cream}}>
            {ev.customer || "(고객명 없음)"} <span style={{color:T.copper,fontFamily:SF,fontWeight:600,fontSize:11}}>{shortId(ev.orderId)}</span>
          </div>
        )}
        {describeEvent(ev).map((line, i) => (
          <div key={i} style={{color:tone,overflowWrap:"anywhere"}}>{line}</div>
        ))}
        <div style={{color:T.creamMuted,fontSize:11}}>
          {/* 작업자가 비어 있으면 도장 없이 바뀐 것이다 — 감추지 않고 그대로 보여준다 */}
          {ev.actor || "작업자 기록 없음"}{ev.route ? ` · ${ev.route}` : ""}
        </div>
      </div>
    </div>
  );
}

function OrderHistory({ orderId }) {
  const T = useTheme();
  const [state, setState] = useState({ loading: true, events: [], error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, events: [], error: null });
    db.fetchOrderEvents(orderId)
      .then(events => { if (alive) setState({ loading: false, events, error: null }); })
      .catch(error => { if (alive) setState({ loading: false, events: [], error }); });
    return () => { alive = false; };
  }, [orderId]);

  if (state.loading) return <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0"}}>기록 불러오는 중…</div>;
  if (state.error) return (
    <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0",lineHeight:1.6}}>
      {isNoTable(state.error)
        ? "변경 기록이 아직 켜지지 않았습니다 — migrations/add_order_events.sql 을 실행해야 합니다"
        : `기록을 불러오지 못했습니다: ${state.error.message}`}
    </div>
  );
  if (state.events.length === 0) return (
    <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0",lineHeight:1.6}}>
      남은 기록이 없습니다 — 기록을 켜기 전에 등록·변경된 주문입니다
    </div>
  );
  return <div>{state.events.map(ev => <EventLine key={ev.id} ev={ev} />)}</div>;
}

function Row({ row, open, onToggle, onOpenOrder }) {
  const T = useTheme();
  const o = row.order;
  const pay = getPayStatus(o);
  // 수거를 두 번 놓쳤거나 사흘 넘게 묵은 건은 빨갛게
  const hot = row.unit === "번 놓침" ? row.days >= 2 : row.days >= 3;
  return (
    <div style={{borderTop:`1px solid ${T.border}`}}>
      <div onClick={onToggle} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 2px",cursor:"pointer"}}>
        <div style={{flex:"none",minWidth:54,textAlign:"center",padding:"4px 6px",borderRadius:8,
          background:hot?T.redBg:T.subtleBg,color:hot?T.red:T.creamMuted,fontWeight:800,fontSize:12,lineHeight:1.3}}>
          {row.days > 0 ? <>{row.days}<span style={{fontSize:9,fontWeight:600,display:"block",whiteSpace:"nowrap"}}>{row.unit}</span></> : "오늘"}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <span style={{fontWeight:800,fontSize:14,color:T.cream}}>{o.customer}</span>
            <span style={{fontFamily:SF,fontSize:11,color:T.copper}}>{shortId(o.id)}</span>
            <Tag c={sC(o.status,T)[0]} bg={sC(o.status,T)[1]}>{o.status || "접수"}</Tag>
            <Tag c={pC(pay,T)[0]} bg={pC(pay,T)[1]}>{pay}</Tag>
            {isHold(o) && <Tag c={T.blue} bg={T.blueBg}>보관</Tag>}
            {isParked(o) && <Tag c={T.creamMuted} bg={T.subtleBg}>보류</Tag>}
            {o.mergeGroupId && <Tag c={T.purple} bg="rgba(138,106,184,0.12)">{o.splitShipping ? "합배송·분리" : "합배송"}</Tag>}
          </div>
          <div style={{fontSize:12,color:T.creamMuted,marginTop:3,overflowWrap:"anywhere"}}>{row.note}</div>
          <div style={{fontSize:11.5,color:T.creamMuted,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {o.manager ? `${o.manager} · ` : ""}{itemsLine(o) || "(품목 없음)"}
          </div>
        </div>
        <div style={{flex:"none",color:T.creamMuted,fontSize:11,paddingTop:4}}>{open ? "▲" : "▼"}</div>
      </div>
      {open && (
        <div style={{padding:"2px 2px 12px"}}>
          <div style={{fontSize:11,fontWeight:800,color:T.copper,letterSpacing:"0.06em",marginBottom:2}}>변경 기록</div>
          <OrderHistory orderId={o.id} />
          <button onClick={() => onOpenOrder?.(o)} style={{marginTop:10,width:"100%",padding:"9px",borderRadius:8,
            border:`1px solid ${T.copper}80`,background:T.copperGlow,color:T.copper,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S}}>
            주문현황에서 이 주문 보기
          </button>
        </div>
      )}
    </div>
  );
}

// shippedMates: 합배송 묶음 중 이미 출고완료된 건. ErpApp 이 읽어서 내려준다 —
// 작업자 바의 건수 버튼과 이 화면이 같은 숫자를 봐야 해서 한 곳에서 읽는다.
// 보는 범위 — "전체" 또는 "내 담당". 기기에 기억한다(localStorage).
// 기본값은 역할로 가른다: 관리자는 놓친 주문을 전부 봐야 하는 사람이라 전체,
// 셀러는 남의 주문까지 섞이면 내 것이 묻히므로 내 담당. (사용자 요청 2026-10-19)
// 상태는 ErpApp 이 들고 있다(scope·setScope 로 받는다) — 헤더의 전체현황 건수 배지도
// 같은 범위로 세야 배지 숫자와 화면 숫자가 맞는다(사용자 요청 2026-10-19).
export const SCOPE_KEY = "erp_overview_scope";
// isAdmin 에 null 을 주면 저장된 값만 돌려준다(없으면 null) — 기본값은 부르는 쪽이 역할로 정한다.
export const readScope = (isAdmin) => {
  try { const v = localStorage.getItem(SCOPE_KEY); if (v === "all" || v === "mine") return v; } catch {}
  return isAdmin === null ? null : (isAdmin ? "all" : "mine");
};
// 담당자 이름이 없으면(로그인 전) '내 담당'은 빈 화면이 된다 — 그때는 전체로 본다.
export const isMineScope = (scope, activeManager) => scope === "mine" && !!activeManager;
// 구역 계산에 넘기기 전에 거른다. 구역 판정(lib/overview.js)은 주문 한 건씩 보므로
// 여기서 줄여도 기준은 그대로다. 담당자가 비어 있는 주문은 '내 담당'에 안 잡힌다.
export const scopeOrders = (orders, scope, activeManager) =>
  isMineScope(scope, activeManager) ? (orders || []).filter(o => o.manager === activeManager) : (orders || []);

function OverviewTab({ orders = [], shippedMates = [], courierById, reloadMates, reloadOrders, onOpenOrder, showToast,
  activeManager = "", scope = "all", setScope = () => {} }) {
  const T = useTheme();
  const [sel, setSel] = useState(null);           // 아래에 펼친 구역. 처음에는 건수만 보여준다
  const [openRow, setOpenRow] = useState(null);   // "구역:주문id"
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState(() => new Date());

  const mineOn = isMineScope(scope, activeManager);
  const scoped = useMemo(() => scopeOrders(orders, scope, activeManager), [orders, scope, activeManager]);

  const view = useMemo(
    () => buildOverview(scoped, shippedMates,
      { isHold, isParked, getPayStatus,
        courierOf: (o) => courierById?.get(o.id)?.courier, isPickup: (o) => !!courierById?.get(o.id)?.pickup }, checkedAt),
    [scoped, shippedMates, courierById, checkedAt]);

  const refresh = async () => {
    setBusy(true);
    try { await reloadOrders?.(); await reloadMates?.(); setCheckedAt(new Date()); }
    catch (e) { showToast?.("새로고침 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const toneColor = (tone) => tone === "red" ? [T.red, T.redBg] : tone === "yellow" ? [T.yellow, T.yellowBg] : [T.blue, T.blueBg];
  const picked = view.sections.find(s => s.key === sel) || null;

  return (
    <div>
      <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",gap:10,marginBottom:10}}>
        <div>
          <div style={{fontFamily:SF,fontSize:22,fontWeight:800,color:T.cream}}>전체현황</div>
          <div style={{fontSize:12,color:T.creamMuted,marginTop:2}}>
            {mineOn ? <b style={{color:T.pink}}>{activeManager} 담당</b> : "전체"} · 진행 중 {view.active}건 · 확인 필요 <b style={{color:view.flagged>0?T.red:T.green}}>{view.flagged}건</b> · {fmtWhen(checkedAt)} 기준
          </div>
        </div>
        <div style={{display:"flex",gap:6,flex:"none",alignItems:"center"}}>
          {/* 전체 / 내 담당 — 건수·목록이 전부 이 범위로 바뀐다. 아래 '최근 변경 기록'은
              "그 주문 어디 갔지"를 찾는 자리라 범위와 무관하게 전체를 보여준다. */}
          <div role="group" aria-label="보는 범위" style={{display:"flex",border:`1px solid ${T.border}`,borderRadius:8,overflow:"hidden"}}>
            {[["all","전체"],["mine","내 담당"]].map(([k,label]) => {
              const on = k === "mine" ? mineOn : !mineOn;   // 담당자 없이 '내 담당'을 골라도 실제로는 전체다
              return (
                <button key={k} onClick={() => { setScope(k); setSel(null); setOpenRow(null); }} aria-pressed={on}
                  title={k==="mine" && !activeManager ? "담당자를 고르면 내 주문만 볼 수 있습니다" : undefined}
                  style={{padding:"8px 11px",border:"none",fontFamily:S,fontSize:12,fontWeight:800,cursor:"pointer",
                    background:on?T.copper:"transparent",color:on?"#fff":T.creamMuted}}>
                  {label}
                </button>
              );
            })}
          </div>
          <button onClick={refresh} disabled={busy} style={{flex:"none",padding:"8px 12px",borderRadius:8,border:`1px solid ${T.border}`,
            background:"transparent",color:T.creamMuted,fontWeight:700,fontSize:12,cursor:busy?"default":"pointer",fontFamily:S,opacity:busy?0.5:1}}>
            {busy ? "불러오는 중…" : "↻ 새로고침"}
          </button>
        </div>
      </div>

      {/* 요약 판 — 탭을 열면 스크롤 없이 아홉 구역의 건수가 한눈에 들어온다.
          목록은 여기 없다. 칸을 누르면 아래에 그 구역만 펼쳐진다 — 구역마다 목록을
          달고 늘어놓으면 첫 구역이 길 때 나머지 건수는 스크롤 아래로 밀려 안 보인다. */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:6,marginBottom:10}}>
        {view.sections.map(s => {
          const [c, bg] = toneColor(s.tone);
          const n = s.rows.length;
          const on = sel === s.key;
          return (
            <button key={s.key} onClick={() => { setSel(on ? null : s.key); setOpenRow(null); }}
              aria-pressed={on} title={s.title}
              style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,
                minHeight:68,padding:"7px 4px",borderRadius:10,cursor:"pointer",fontFamily:S,boxSizing:"border-box",
                border:`2px solid ${on ? (n>0?c:T.copper) : (n>0?c+"66":T.border)}`,
                background: n>0 ? bg : (on ? T.subtleBg : T.card),
                boxShadow: on ? `0 0 0 2px ${(n>0?c:T.copper)}33` : "none"}}>
              <span style={{fontSize:21,fontWeight:900,lineHeight:1.1,color:n>0?c:T.creamMuted}}>{n}</span>
              <span style={{fontSize:11,fontWeight:700,lineHeight:1.25,textAlign:"center",wordBreak:"keep-all",
                color:n>0?T.cream:T.creamMuted}}>{s.icon} {s.short}</span>
            </button>
          );
        })}
      </div>

      {view.flagged === 0 && (
        <div style={{marginBottom:10,padding:"10px 14px",borderRadius:10,border:`1px solid ${T.green}`,background:T.greenBg,
          fontSize:13,fontWeight:800,color:T.green,textAlign:"center"}}>
          ✅ 오늘 이상 없음 <span style={{fontWeight:500,color:T.creamMuted}}>— 놓치고 있는 주문이 없습니다</span>
        </div>
      )}

      {picked ? (() => {
        const [c] = toneColor(picked.tone);
        const n = picked.rows.length;
        return (
          <Card style={{marginBottom:10,padding:"12px 14px",border:`1px solid ${n>0?c:T.border}`}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:18,flex:"none"}}>{picked.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:800,color:T.cream}}>{picked.title} <span style={{color:n>0?c:T.creamMuted}}>{n}건</span></div>
                <div style={{fontSize:11.5,color:T.creamMuted,marginTop:1,lineHeight:1.5}}>{picked.hint}</div>
              </div>
              <button onClick={() => { setSel(null); setOpenRow(null); }} aria-label="목록 닫기"
                style={{flex:"none",padding:"4px 9px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",
                  color:T.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S}}>닫기</button>
            </div>
            <div style={{marginTop:10}}>
              {n === 0
                ? <div style={{borderTop:`1px solid ${T.border}`,padding:"14px 0 4px",fontSize:12.5,color:T.creamMuted,textAlign:"center"}}>해당하는 주문이 없습니다</div>
                : picked.rows.map(r => {
                    const k = `${picked.key}:${r.order.id}`;
                    return <Row key={k} row={r} open={openRow === k} onToggle={() => setOpenRow(openRow === k ? null : k)} onOpenOrder={onOpenOrder} />;
                  })}
            </div>
          </Card>
        );
      })() : (
        <div style={{marginBottom:10,padding:"12px 0",fontSize:12,color:T.creamMuted,textAlign:"center"}}>
          위 칸을 누르면 해당 주문 목록이 여기에 펼쳐집니다
        </div>
      )}

      <RecentEvents />
    </div>
  );
}

// 최근 변경 기록 — 출고완료되거나 삭제돼서 주문 목록에 없는 건도 여기서는 찾을 수 있다.
// "그 주문 어디 갔지?"에 답하는 자리다.
function RecentEvents() {
  const T = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [state, setState] = useState({ loading: false, events: null, error: null });

  const load = useCallback(async (customer) => {
    setState(s => ({ ...s, loading: true, error: null }));
    try { setState({ loading: false, events: await db.fetchRecentOrderEvents({ customer, limit: 100 }), error: null }); }
    catch (error) { setState({ loading: false, events: null, error }); }
  }, []);

  return (
    <Card style={{marginTop:18,padding:"12px 14px"}}>
      <div onClick={() => { const next = !open; setOpen(next); if (next && !state.events) load(q); }}
        style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
        <span style={{fontSize:18,flex:"none"}}>📜</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,fontWeight:800,color:T.cream}}>최근 변경 기록</div>
          <div style={{fontSize:11.5,color:T.creamMuted,marginTop:1,lineHeight:1.5}}>누가 언제 어느 화면에서 바꿨는지 — 출고완료·삭제된 주문도 찾을 수 있습니다</div>
        </div>
        <span style={{flex:"none",color:T.creamMuted,fontSize:11}}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{marginTop:12}}>
          <form onSubmit={(e) => { e.preventDefault(); load(q); }} style={{display:"flex",gap:6,marginBottom:6}}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="고객명으로 찾기 (비우면 최근 100건)"
              style={{flex:1,minWidth:0,padding:"9px 11px",borderRadius:8,border:`1px solid ${T.border}`,background:T.inputBg,color:T.cream,fontFamily:S,fontSize:16,boxSizing:"border-box"}} />
            <button type="submit" disabled={state.loading} style={{flex:"none",padding:"9px 14px",borderRadius:8,border:"none",background:T.copper,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S}}>조회</button>
          </form>
          {state.loading && <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0"}}>불러오는 중…</div>}
          {state.error && (
            <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0",lineHeight:1.6}}>
              {isNoTable(state.error)
                ? "변경 기록이 아직 켜지지 않았습니다 — migrations/add_order_events.sql 을 실행해야 합니다"
                : `기록을 불러오지 못했습니다: ${state.error.message}`}
            </div>
          )}
          {!state.loading && !state.error && state.events && (
            state.events.length === 0
              ? <div style={{fontSize:12,color:T.creamMuted,padding:"8px 0"}}>기록이 없습니다</div>
              : state.events.map(ev => <EventLine key={ev.id} ev={ev} showCustomer />)
          )}
        </div>
      )}
    </Card>
  );
}

export default OverviewTab;
