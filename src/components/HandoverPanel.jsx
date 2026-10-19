import { useState, useEffect, useMemo, useCallback } from "react";
import { Card } from "./UI.jsx";
import { S, SF, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { CJ, KD, COURIERS, COURIER_SHORT, DIRECT_METHODS, PICKUP_CUTOFF } from "../lib/courier.js";
import { courierColor } from "./Courier.jsx";

// 포장 화면의 '완료' 칸 — 싼 박스를 기사에게 건네고 출고완료까지 여기서 한다.
//
// 지금까지 출고완료는 관리자가 송장을 뽑으면서 눌렀다. 관리자는 박스를 보지 않으므로
// 그건 "송장을 뽑았다"는 뜻이었지 "나갔다"는 뜻이 아니었다. 수거를 놓친 박스는 출고완료인
// 채 바닥에 남고, 나간 박스는 접수인 채 주문현황에 남았다.
//
// 박스마다 누르게 하지 않는다. 포장팀은 이미 박스마다 포장완료를 누르고 있어서 같은 걸
// 한 번 더 누르게 하면 일이 두 배가 된다. 대신 "나간 것"이 아니라 "안 나간 것"을 표시한다 —
// 기사가 다녀간 뒤 바닥에 남은 박스는 눈에 보이고, 대개 0개다.
//
// 한 번에 전체를 넘기는 버튼과 다른 점:
//  · 목록에 올 수 있는 박스가 미리 걸러져 있다(포장완료 + 송장 출력 + 입금완료).
//    송장이 없는 박스는 붙일 게 없어 못 나가므로, 수거 뒤에 싼 박스는 저절로 빠진다.
//    다만 송장 없이도 내보내야 할 때가 있어, 포장팀이 '못 나가는 박스 해제'로 직접 풀 수 있다.
//  · 버튼에 박스 수가 적혀 있다. 기사가 가져간 수와 다르면 그 자리에서 알아챈다.
//
// '완료'와 '인계'를 따로 두지 않는 이유: 둘 다 "싼 박스"를 보는 화면이다. 나눠 놓으면
// 방금 싼 박스를 되돌리러 한 칸, 넘기러 또 한 칸을 오가야 한다.

const TABS = [
  { k: CJ, label: "CJ" },
  { k: KD, label: "경동" },
  { k: "direct", label: "직접 전달" },
];

const itemText = (row) => row.orders.flatMap(o => o.items || [])
  .map(it => `${it.fabric}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`).join(", ");
const hhmm = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// 주문 등록 정보 — 언제 누가 넣은 주문인지. 포장 카드(PackingTab)와 같은 모양으로 적는다.
// 합배송은 주문마다 다를 수 있어 건별로 보여주되, 완전히 같으면 한 번만 적는다.
const fmtReg = (o) =>
  `${String(o.date || "").replace(/^\d{4}\.\s*/, "").replace(/\.$/, "").trim()} ${o.time || ""} · ${o.manager || "담당자 없음"}`.trim();
const regsOf = (row) => [...new Set(row.orders.map(fmtReg).filter(Boolean))];

const isPickupRow = (r, courierById) => !!courierById.get(r.orders[0].id)?.pickup;

/**
 * 택배로 나갈 박스를 구역으로 나눈다.
 *   go     나갈 박스 (포장완료 + 송장 출력 + 입금완료) — 기본으로 체크
 *   toPack 수거 전에 쌀 박스 (송장은 있는데 미포장) — 싸서 보냈으면 체크
 *   stuck  못 나가는 박스 — 이유(why)와 종류(kind: unpaid·noInvoice·repack)와 함께
 * 보관·보류 중인 박스는 어디에도 넣지 않는다. 일부러 잡아둔 것이라 오늘 나갈 게 아니다.
 * 방문·픽업 박스도 뺀다 — 택배로 안 나가므로 '직접 전달'에서 따로 본다.
 */
export function splitForHandover(rows, courierById, courier) {
  const go = [], toPack = [], stuck = [];
  // 송장 출력 시각 칸이 아직 없는 DB(마이그레이션 전)에서는 송장 조건을 뺀다.
  // 조건을 그대로 두면 어떤 박스도 '송장 출력됨'이 될 수 없어 목록이 늘 비고,
  // 포장팀이 출고 처리를 못 한다. 그동안은 포장완료 + 입금완료만으로 넘긴다.
  const trackInvoice = db.hasOrderColumn("invoice_printed_at");
  for (const r of rows || []) {
    if (r.parked || r.held) continue;
    if (isPickupRow(r, courierById)) continue;
    if ((courierById.get(r.orders[0].id)?.courier || CJ) !== courier) continue;
    const invoiced = trackInvoice ? r.orders.some(o => o.invoicePrintedAt) : r.allPacked;
    if (r.payBlocked) {
      // 돈이 덜 들어온 박스는 송장이 있든 없든 못 나간다. 쌌거나 송장을 뽑은 것만 보여준다 —
      // 아직 손도 안 댄 미입금 주문까지 늘어놓으면 목록이 그걸로 찬다.
      if (invoiced || r.allPacked) stuck.push({ row: r, kind: "unpaid", why: "입금 확인 전" });
      continue;
    }
    if (!invoiced) {
      if (r.allPacked) stuck.push({ row: r, kind: "noInvoice", why: "송장 없음 — 관리자가 송장을 뽑아야 합니다" });
      continue;
    }
    if (r.needsRepack) { stuck.push({ row: r, kind: "repack", why: "재포장 필요 — 박스를 다시 확인해 주세요" }); continue; }
    (r.allPacked ? go : toPack).push(r);
  }
  return { go, toPack, stuck };
}

/** 직접 전달 대상 — 방문·픽업 박스. 택배 송장을 뽑은 박스는 여기 안 온다(courierMap 이 거른다). */
export function directRows(rows, courierById) {
  return (rows || []).filter(r => !r.parked && !r.held && isPickupRow(r, courierById));
}

/**
 * @param rows      박스 목록(PackingTab 이 만든 것 — 검색·정렬이 이미 적용돼 있다)
 * @param onUnpack  (row) => 포장완료를 되돌린다. 방금 싼 박스를 되돌리는 일이 잦다.
 */
function HandoverPanel({ rows = [], courierById, nickOf, onHandover, onUnpack, busyKey, showToast, searching = false, sortHint = "" }) {
  const T = useTheme();
  // 처음에는 전체를 연다 — 완료 칸을 여는 이유는 대개 방금 싼 박스를 확인하거나 되돌리는 것이다.
  const [tab, setTab] = useState("all");
  // 기본값과 다르게 바꾼 박스만 적는다(박스 key → 체크 여부). 목록이 바뀌어도 기본값이 따라간다.
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [methodOf, setMethodOf] = useState({});   // 직접 전달: 박스 key → 방법
  const [today, setToday] = useState([]);
  // 못 나가는 박스 해제 — 송장이 없어도 포장팀 판단으로 내보내기로 한 박스(박스 key → true).
  // 화면에만 둔다. 넘기고 나면 출고완료가 되어 목록에서 빠지므로 따로 저장할 게 없다.
  const [released, setReleased] = useState({});

  const loadToday = useCallback(async () => { setToday(await db.fetchTodayHandovers()); }, []);
  useEffect(() => { loadToday(); }, [loadToday]);

  const parts = useMemo(() => {
    // 해제한 박스를 '못 나가는 박스'에서 '나갈 박스'로 옮긴다. 풀 수 있는 건 송장 없음뿐이다 —
    // 미입금은 돈 문제라 출고 처리에서도 막히고, 재포장은 다시 싸야 풀린다.
    const open = (p) => {
      const isFreed = (s) => s.kind === "noInvoice" && released[s.row.key];
      const freedRows = p.stuck.filter(isFreed).map(s => s.row);
      return {
        go: [...p.go, ...freedRows], toPack: p.toPack, stuck: p.stuck.filter(s => !isFreed(s)),
        freed: new Set(freedRows.map(r => r.key)),
      };
    };
    return {
      [CJ]: open(splitForHandover(rows, courierById, CJ)),
      [KD]: open(splitForHandover(rows, courierById, KD)),
    };
  }, [rows, courierById, released]);
  const direct = useMemo(() => directRows(rows, courierById), [rows, courierById]);
  // 칸의 숫자.
  //  · 전체      싼 박스 전부 — 못 나가는 박스까지. 모든 상황을 보는 칸이다.
  //  · CJ·경동   지금 나갈 수 있는 박스만('나갈 박스' 구역과 같은 수). 기사에게 건넬 수를 세는
  //              칸이라, 못 나가는 박스가 섞이면 8이라 적혀 있는데 건넬 건 5개인 일이 생긴다.
  //  · 직접 전달 싼 박스(아직 안 싼 방문·픽업 주문은 안 센다).
  // 그래서 세 칸을 더해도 전체와 같지 않을 수 있다 — 차이는 못 나가는 박스다.
  const counts = useMemo(() => ({
    [CJ]: parts[CJ].go.length,
    [KD]: parts[KD].go.length,
    direct: direct.filter(r => r.allPacked && !r.needsRepack).length,
  }), [parts, direct]);

  // 전체 — 싼 박스 전부. 나갈 수 있든 없든 다 센다.
  const allDone = useMemo(
    () => rows.filter(r => r.allPacked && !r.needsRepack && !r.held && !r.parked),
    [rows]);

  // 오늘 넘긴 기록 — 같은 경로·같은 분에 나간 건을 한 번의 인계로 묶는다.
  const history = useMemo(() => {
    const m = new Map();
    for (const e of today) {
      if (!/인계|직접 전달/.test(e.route)) continue;
      const k = `${e.route}|${hhmm(e.createdAt)}|${e.actor}`;
      if (!m.has(k)) m.set(k, { route: e.route, at: hhmm(e.createdAt), actor: e.actor, n: 0 });
      m.get(k).n++;
    }
    return [...m.values()];
  }, [today]);

  const isOn = (r, dflt) => touched[r.key] ?? dflt;
  const toggle = (r, dflt) => setTouched(p => ({ ...p, [r.key]: !(p[r.key] ?? dflt) }));
  const working = busy || !!busyKey;

  const submit = async (courier) => {
    const { go, toPack, freed } = parts[courier];
    const picked = [...go.filter(r => isOn(r, true)), ...toPack.filter(r => isOn(r, false))];
    const left = go.filter(r => !isOn(r, true));
    if (picked.length === 0) { showToast?.("넘길 박스를 골라 주세요", "error"); return; }
    const unpackedN = toPack.filter(r => isOn(r, false)).length;
    const noInv = picked.filter(r => freed.has(r.key));
    const msg = `${courier} 기사에게 ${picked.length}박스를 건넸습니까?\n`
      + (searching ? `\n⚠ 검색 중입니다 — 지금 보이는 박스만 넘깁니다.\n` : "")
      + (left.length ? `\n남긴 박스 ${left.length}개는 목록에 그대로 남습니다:\n${left.map(r => `· ${r.orders[0].customer}`).join("\n")}\n` : "")
      + (unpackedN ? `\n포장완료를 안 누른 박스 ${unpackedN}개도 함께 출고 처리합니다.\n` : "")
      + (noInv.length ? `\n⚠ 송장 없이 나가는 박스 ${noInv.length}개:\n${noInv.map(r => `· ${r.orders[0].customer}`).join("\n")}\n` : "")
      + `\n[확인]을 누르면 출고완료가 되고 재고가 빠집니다.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await onHandover?.(picked.map(r => r.orders), courier,
        { noInvoice: new Set(noInv.map(r => r.orders[0].id)) });
      setTouched({});
      setReleased({});
      await loadToday();
    } finally { setBusy(false); }
  };

  const submitDirect = async (r) => {
    const via = methodOf[r.key];
    if (!via) { showToast?.("어떻게 전달했는지 골라 주세요", "error"); return; }
    if (!window.confirm(`${r.orders[0].customer} 박스를 '${via}'(으)로 전달했습니까?\n\n[확인]을 누르면 출고완료가 되고 재고가 빠집니다.`)) return;
    setBusy(true);
    try {
      await onHandover?.([r.orders], via);
      await loadToday();
    } finally { setBusy(false); }
  };

  // 포장취소 — 포장완료를 취소한다. 싼 박스에만 붙는다.
  const undo = (r) => r.allPacked && onUnpack ? (
    <button onClick={() => onUnpack(r)} disabled={working} title="포장완료를 취소합니다" style={{
      flex:"none",padding:"5px 10px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",
      color:T.creamMuted,fontFamily:S,fontSize:11.5,cursor:working?"wait":"pointer",whiteSpace:"nowrap"}}>
      {busyKey === r.key ? "…" : "포장취소"}
    </button>
  ) : null;

  // 컴포넌트가 아니라 함수로 부른다. 안에서 정의한 컴포넌트는 렌더마다 새것이라 매번 다시 mount 된다.
  // 고객명만으로는 동명이인을 못 가른다 — 되돌릴 박스를 정확히 집을 수 있게 품목·전화·주소까지 붙인다.
  const line = (r, left, dim = false, right = undo(r)) => {
    const h = r.orders[0];
    const nick = nickOf?.(h);
    return (
      <div key={r.key} style={{display:"flex",alignItems:"flex-start",gap:9,padding:"10px 0",borderTop:`1px solid ${T.creamMuted}44`,opacity:dim?0.65:1}}>
        {left}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13.5,fontWeight:800,color:T.cream,lineHeight:1.4}}>
            {h.customer}
            {nick && <span style={{color:T.copper,fontWeight:700}}> ({nick})</span>}
            {r.merged && <span style={{color:T.purple,fontSize:11,fontWeight:800}}> · 📦 합배송 {r.orders.length}건</span>}
            {!r.allPacked && <span style={{color:T.yellow,fontSize:11,fontWeight:800}}> · 미포장</span>}
          </div>
          <div style={{fontSize:12,color:T.cream,lineHeight:1.5,overflowWrap:"anywhere"}}>{itemText(r) || "(품목 없음)"}</div>
          <div style={{fontSize:11,color:T.creamMuted,lineHeight:1.5,overflowWrap:"anywhere"}}>
            {h.phone || "연락처 없음"} · {h.address || "주소 없음"}{h.addressDetail ? ` ${h.addressDetail}` : ""}
          </div>
          {/* 언제 들어온 주문인지 — 며칠 묵은 박스인지, 누구에게 물어볼지가 여기서 보인다 */}
          <div style={{fontSize:11,color:T.creamMuted,lineHeight:1.5}}>
            🗓 등록 {regsOf(r).join(" / ")}
          </div>
        </div>
        {right}
      </div>
    );
  };
  const check = (r, dflt) => (
    <input type="checkbox" checked={isOn(r, dflt)} onChange={() => toggle(r, dflt)} disabled={working}
      aria-label={`${r.orders[0].customer} 박스`}
      style={{accentColor:T.copper,width:20,height:20,flex:"none",marginTop:2,cursor:"pointer"}}/>
  );
  const secHead = (text, n, color) => (
    <div style={{display:"flex",alignItems:"center",gap:7,margin:"14px 0 2px",fontSize:12,fontWeight:900,color:color||T.cream}}>
      <span>{text}</span><span style={{fontFamily:SF}}>{n}</span>
    </div>
  );

  const courierView = (courier) => {
    const { go, toPack, stuck, freed } = parts[courier];
    const [c] = courierColor(courier, T);
    const smallBtn = (text, onClick, color, title) => (
      <button onClick={onClick} disabled={working} title={title} style={{
        padding:"5px 10px",borderRadius:7,border:`1px solid ${color}`,background:"transparent",
        color,fontFamily:S,fontSize:11.5,fontWeight:800,cursor:working?"wait":"pointer",whiteSpace:"nowrap"}}>
        {text}
      </button>
    );
    const pickedN = go.filter(r => isOn(r, true)).length + toPack.filter(r => isOn(r, false)).length;
    const nothing = go.length + toPack.length + stuck.length === 0;
    return (
      <Card style={{padding:"12px 14px",border:`1px solid ${c}66`}}>
        <div style={{fontSize:11.5,color:T.creamMuted,lineHeight:1.55}}>
          기사가 다녀간 뒤에 누릅니다 · <b style={{color:T.cream}}>바닥에 남은 박스만 체크를 풀고</b> 나갈 박스 밑의 버튼을 한 번 누르세요
          <span style={{whiteSpace:"nowrap"}}> · 수거 마감 {PICKUP_CUTOFF[courier]}</span>
          {sortHint && <span> · {sortHint}</span>}
        </div>
        {nothing && (
          <div style={{padding:"26px 0 14px",textAlign:"center",fontSize:13,color:T.creamMuted}}>
            {searching ? "찾는 박스가 이 칸에는 없습니다" : `${COURIER_SHORT[courier]}로 나갈 박스가 없습니다`}
          </div>
        )}
        {go.length > 0 && <>
          {secHead("나갈 박스", go.length, c)}
          {go.map(r => !freed.has(r.key) ? line(r, check(r, true), !isOn(r, true)) : (
            <div key={r.key}>
              {line(r, check(r, true), !isOn(r, true))}
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",margin:"-6px 0 9px 29px"}}>
                <span style={{fontSize:11.5,fontWeight:700,color:T.yellow}}>송장 없이 나갑니다 — 포장팀 판단</span>
                {smallBtn("해제 취소", () => setReleased(p => ({ ...p, [r.key]: false })), T.creamMuted, "다시 못 나가는 박스로 돌립니다")}
              </div>
            </div>
          ))}
        </>}
        {/* 출고완료 버튼은 나갈 박스 바로 밑에 둔다. 맨 아래에 두면 못 나가는 박스가 쌓인 날
            버튼을 찾아 한참 내려가야 한다. 아래 구역에서 체크한 박스도 이 버튼 숫자에 더해진다. */}
        {(go.length > 0 || toPack.length > 0) && (
          <button onClick={() => submit(courier)} disabled={working || pickedN === 0} style={{
            width:"100%",margin:"12px 0 6px",padding:"14px",borderRadius:10,border:"none",fontFamily:S,fontSize:15.5,fontWeight:900,
            cursor: working ? "wait" : pickedN === 0 ? "not-allowed" : "pointer",
            background: pickedN === 0 ? T.border : c, color: pickedN === 0 ? T.creamMuted : "#fff",
            opacity: working ? 0.6 : 1}}>
            {busy ? "처리 중…" : `🚚 ${COURIER_SHORT[courier]} ${pickedN}박스 출고완료`}
          </button>
        )}
        {toPack.length > 0 && <>
          {secHead("수거 전에 쌀 박스 — 송장은 나왔는데 아직 포장 전", toPack.length, T.yellow)}
          <div style={{fontSize:11,color:T.creamMuted,marginBottom:2,lineHeight:1.5}}>
            싸서 같이 보냈으면 체크하세요. 위 버튼의 박스 수에 더해지고, 포장완료와 출고완료가 함께 처리됩니다
          </div>
          {toPack.map(r => line(r, check(r, false)))}
        </>}
        {stuck.length > 0 && <>
          {secHead("못 나가는 박스 — 위 숫자에는 안 들어갑니다", stuck.length, T.red)}
          {stuck.map(({ row: r, why, kind }) => (
            <div key={r.key}>
              {line(r, <span style={{flex:"none",width:20,textAlign:"center",color:T.red,fontWeight:900,marginTop:1}}>✕</span>, true)}
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",margin:"-6px 0 9px 29px"}}>
                <span style={{fontSize:11.5,fontWeight:700,color:T.red}}>{why}</span>
                {/* 송장 없음만 풀 수 있다. 미입금은 출고 처리에서도 막히고, 재포장은 다시 싸야 풀린다 */}
                {kind === "noInvoice" && smallBtn("못 나가는 박스 해제",
                  () => setReleased(p => ({ ...p, [r.key]: true })), c, "송장 없이 나갈 박스로 옮깁니다")}
              </div>
            </div>
          ))}
        </>}
      </Card>
    );
  };

  // 직접 전달 — 방문 수령·퀵·직접 배달. 택배 송장이 없어 위 목록에는 들어올 수 없다.
  // 담당자가 '방문고객'이거나 메모에 방문·픽업이 적힌 주문만 보인다. 전부 늘어놓으면
  // 택배로 나갈 박스와 섞여, 택배 박스를 직접 전달로 잘못 처리하게 된다.
  // 전체 — 택배사 구분 없이 싼 박스를 전부. 박스마다 어느 칸에서 넘기는지, 넘길 수 있는지를 붙인다.
  const allView = () => (
    <Card style={{padding:"12px 14px",border:`1px solid ${T.green}66`}}>
      <div style={{fontSize:11.5,color:T.creamMuted,lineHeight:1.55}}>
        포장은 끝났고 아직 출고되지 않은 박스입니다 · 넘길 때는 위의 <b style={{color:T.cream}}>CJ · 경동 · 직접 전달</b> 칸에서 합니다
        {sortHint && <span> · {sortHint}</span>}
      </div>
      {allDone.length === 0 && (
        <div style={{padding:"26px 0 14px",textAlign:"center",fontSize:13,color:T.creamMuted}}>
          {searching ? "찾는 박스가 없습니다" : "아직 포장완료된 주문이 없습니다"}
        </div>
      )}
      {allDone.map(r => {
        const info = courierById.get(r.orders[0].id);
        const invoiced = r.orders.some(o => o.invoicePrintedAt);
        const where = info?.pickup ? "직접 전달" : (COURIER_SHORT[info?.courier] || "CJ");
        const [c, bg] = info?.pickup ? [T.copper, T.copperGlow] : courierColor(info?.courier, T);
        const tag = (text, color, back) => (
          <span style={{fontSize:10.5,fontWeight:800,color,background:back,padding:"1px 6px",borderRadius:4,whiteSpace:"nowrap"}}>{text}</span>
        );
        return (
          <div key={r.key}>
            {line(r, null)}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",margin:"-5px 0 9px"}}>
              {tag(where, c, bg)}
              {r.payBlocked
                ? tag("입금 확인 전 — 못 나감", T.red, T.redBg)
                : info?.pickup
                  ? tag("고객에게 건넨 뒤 전달 완료", T.creamMuted, T.subtleBg)
                  : invoiced || !db.hasOrderColumn("invoice_printed_at")
                    ? tag("송장 ✓ 나갈 수 있음", T.green, T.greenBg)
                    : tag("송장 없음", T.yellow, T.yellowBg)}
            </div>
          </div>
        );
      })}
    </Card>
  );

  const directItem = (r) => (
        <div key={r.key}>
          {line(r, null)}
          {r.payBlocked ? (
            <div style={{fontSize:11.5,fontWeight:700,color:T.red,margin:"-4px 0 10px"}}>입금 확인 전 — 출고할 수 없습니다</div>
          ) : (
            <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center",margin:"-2px 0 10px"}}>
              {DIRECT_METHODS.map(m => {
                const on = methodOf[r.key] === m;
                return (
                  <button key={m} onClick={() => setMethodOf(p => ({ ...p, [r.key]: on ? null : m }))} disabled={working}
                    aria-pressed={on} style={{padding:"7px 11px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:12,
                      fontWeight:on?900:700,border:`1px ${on?"solid":"dashed"} ${on?T.copper:T.border}`,
                      background:on?T.copperGlow:"transparent",color:on?T.copper:T.creamMuted}}>{m}</button>
                );
              })}
              <button onClick={() => submitDirect(r)} disabled={working || !methodOf[r.key]} style={{
                marginLeft:"auto",padding:"8px 14px",borderRadius:8,border:"none",fontFamily:S,fontSize:12.5,fontWeight:900,
                cursor: methodOf[r.key] ? "pointer" : "not-allowed",
                background: methodOf[r.key] ? T.copper : T.border, color: methodOf[r.key] ? "#fff" : T.creamMuted}}>
                전달 완료
              </button>
            </div>
          )}
        </div>
  );

  const directView = () => {
    // 싼 박스와 아직 안 싼 주문을 나눈다. 칸의 숫자는 싼 박스만 센 것이다(위 counts).
    // 안 싼 주문도 보여주는 이유: 고객이 와서 그 자리에서 싸 주고 보내는 경우가 있다.
    const packed = direct.filter(r => r.allPacked && !r.needsRepack);
    const notYet = direct.filter(r => !(r.allPacked && !r.needsRepack));
    return (
      <Card style={{padding:"12px 14px",border:`1px solid ${T.copper}66`}}>
        <div style={{fontSize:11.5,color:T.creamMuted,lineHeight:1.55}}>
          담당자가 <b style={{color:T.cream}}>방문고객</b>이거나 메모에 <b style={{color:T.cream}}>방문·픽업</b>이 적힌 주문입니다 —
          건넨 방법을 고르고 <b style={{color:T.cream}}>전달 완료</b>를 누르세요
        </div>
        {direct.length === 0 && (
          <div style={{padding:"26px 0 14px",textAlign:"center",fontSize:13,color:T.creamMuted,lineHeight:1.7}}>
            {searching ? "찾는 박스가 이 칸에는 없습니다" : "직접 전달할 주문이 없습니다"}
            <div style={{fontSize:11.5}}>여기 안 보이는 주문을 직접 건넸다면, 주문 메모에 '픽업'을 적으면 나타납니다</div>
          </div>
        )}
        {packed.length > 0 && <>
          {secHead("건넬 박스", packed.length, T.copper)}
          {packed.map(directItem)}
        </>}
        {notYet.length > 0 && <>
          {secHead("아직 포장 전 — 위 숫자에는 안 들어갑니다", notYet.length, T.yellow)}
          <div style={{fontSize:11,color:T.creamMuted,marginBottom:2,lineHeight:1.5}}>
            그 자리에서 싸서 건넸으면 여기서 바로 전달 완료를 눌러도 됩니다
          </div>
          {notYet.map(directItem)}
        </>}
      </Card>
    );
  };

  return (
    <div>
      {/* 전체 — 세 칸 위에 길게. 싼 박스를 택배사 구분 없이 한 줄로 본다(예전 완료 목록).
          넘기는 일은 아래 세 칸에서 한다. 여기서까지 넘기게 하면 CJ 기사에게 경동 박스를
          같이 넘긴 것으로 처리할 수 있다. */}
      <button onClick={() => setTab("all")} aria-pressed={tab === "all"} style={{
        width:"100%",marginBottom:6,padding:"10px 6px",borderRadius:10,cursor:"pointer",fontFamily:S,
        border:`2px solid ${tab === "all" ? T.green : `${T.green}55`}`,background:tab === "all" ? T.greenBg : "transparent",
        display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
        <span style={{fontSize:13,fontWeight:tab === "all" ? 900 : 700,color:tab === "all" ? T.green : T.creamMuted}}>전체</span>
        <span style={{fontFamily:SF,fontSize:16,fontWeight:900,color:tab === "all" ? T.green : (allDone.length ? T.cream : T.creamMuted)}}>{allDone.length}</span>
      </button>
      <div style={{display:"flex",gap:6,marginBottom:10}}>
        {TABS.map(t => {
          const on = tab === t.k;
          const c = COURIERS.includes(t.k) ? courierColor(t.k, T)[0] : T.copper;
          const n = counts[t.k] || 0;
          return (
            <button key={t.k} onClick={() => setTab(t.k)} aria-pressed={on} style={{
              flex:1,minWidth:0,padding:"10px 6px",borderRadius:10,cursor:"pointer",fontFamily:S,
              border:`2px solid ${on ? c : `${c}55`}`,background:on?`${c}1f`:"transparent",
              display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              <span style={{fontSize:13,fontWeight:on?900:700,color:on?c:T.creamMuted,whiteSpace:"nowrap"}}>{t.label}</span>
              <span style={{fontFamily:SF,fontSize:16,fontWeight:900,color:on?c:(n?T.cream:T.creamMuted)}}>{n}</span>
            </button>
          );
        })}
      </div>

      {!db.hasOrderColumn("invoice_printed_at") && (
        <div style={{marginBottom:10,padding:"9px 12px",borderRadius:9,border:`1px solid ${T.yellow}`,background:T.yellowBg,
          fontSize:11.5,fontWeight:700,color:T.yellow,lineHeight:1.55}}>
          송장 출력 기록이 아직 켜지지 않았습니다 — 포장완료된 박스를 전부 보여줍니다. 송장이 안 붙은 박스는 체크를 풀어 주세요
        </div>
      )}

      {tab === "all" ? allView() : tab === "direct" ? directView() : courierView(tab)}

      {history.length > 0 && (
        <div style={{marginTop:12,padding:"10px 13px",borderRadius:10,border:`1px solid ${T.border}`,background:T.surface}}>
          <div style={{fontSize:11,fontWeight:800,color:T.copper,letterSpacing:"0.06em",marginBottom:4}}>오늘 넘긴 기록</div>
          {history.map((h, i) => (
            <div key={i} style={{fontSize:12,color:T.cream,lineHeight:1.7}}>
              <span style={{fontFamily:"monospace",color:T.creamMuted}}>{h.at}</span> {h.route} <b>{h.n}건</b>
              {h.actor && <span style={{color:T.creamMuted}}> · {h.actor}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default HandoverPanel;
