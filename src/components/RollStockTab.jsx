import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Tag, Card, Empty, PrimaryBtn, GhostBtn, FLabel } from "./UI.jsx";
import { SF, S, baseInp, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { ROLL_STATUS, MOVEMENT_LABEL, CLOSED_STATUSES, PIECE_ORIGIN, isClosedRoll, groupRollsByProduct, matchProduct, fmtLen, round2, rollErrorText } from "../lib/rollStock.js";

// 롤 재고 — 품번별로 묶어 본다. 펼치면 롤이 한 줄씩 나온다.
//
// 가용 표시가 셋이다: 롤 수, 합계 잔량, **최대 재단 가능**(가장 긴 롤의 잔량).
// 세 번째가 실제 가용치다. 재단 주문은 한 롤에서 끊어 나가므로 "주문량 이상 남은 롤이
// 하나라도 있는가"로 받을 수 있는지가 갈린다 — 8·6·5마 롤이 있으면 합계는 19마지만
// 10마 주문은 못 받는다. 합계만 보여주면 받을 수 없는 주문을 받게 된다.
//
// 잔량은 여기서 직접 고치지 않는다. 조정·폐기는 전부 서버의 한 함수를 거치고,
// 그때마다 이력이 남는다 — 잔량이 이상하면 '이력'에서 어디서 틀어졌는지 본다.

const ymd = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
};
const ymdhm = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${ymd(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const signed = (v) => `${v > 0 ? "+" : ""}${fmtLen(v)}`;

function RollStockTab({ products = [], rolls = [], managers = [], reloadRolls, reloadProducts, showToast, activeManager, labelStationRow, labelStationHere }) {
  const G = useTheme();
  const [q, setQ] = useState("");
  // 내 원단만 — 품번 담당자가 작업자인 것. 기본이 '내 원단'이고 전체는 눌러서 연다(사용자 결정 2026-10-08).
  // 탭을 열 때마다 내 원단으로 돌아온다 — 전체 보기는 그때그때 확인용이다.
  const [mineOnly, setMineOnly] = useState(true);
  const [open, setOpen] = useState({});                 // 품번 id → 펼침
  // 구역 탭(2026-10-08 사용자 요청): 재고(검단 대기·판매 가능·예약) / 끝난 롤(판매 완료·폐기).
  // 전에는 "판매 완료·폐기 롤 보기" 토글로 재고 목록에 섞어 보여줬는데, 품절된 롤만 따로 보고 싶다고 해서 갈랐다.
  // 처음엔 판매 완료·폐기를 각각 탭으로 뒀다가 "탭이 너무 많다"고 해서 하나로 합쳤다 — 롤마다 상태 태그가 있어 구분된다.
  const [view, setView] = useState("stock");            // "stock" | "closed"
  const [closedRolls, setClosedRolls] = useState(null); // null = 아직 안 읽음(판매 완료·폐기 탭을 열 때 읽는다)
  const [locEdit, setLocEdit] = useState(null);         // { id, value }
  const [busy, setBusy] = useState(null);               // 처리 중인 롤 id
  const [modal, setModal] = useState(null);             // { type: "adjust"|"scrap"|"history", roll } | { type: "edit", product }
  // 입고된 것 수정(2026-10-13 사용자 요청) — 창 하나에 품번(원단명·색상·가격·사진·담당자·메모)과 롤(위치·공급처)을 같이 둔다.
  // 카드의 ✎ 와 롤 줄의 '수정'이 같은 창을 연다(사용자 결정 — "기능 합쳐줘"). 롤 줄에서 열면 그 롤이 골라져 있다.
  // 품번 글자·수량·상태는 여기서 못 바꾼다: 품번은 찍어 둔 라벨 QR 이 그 값이고, 수량은 '수량 조정'으로만(이력이 남는다).
  const [pe, setPe] = useState(null);                   // 수정 칸 { name, color, unitPrice, note, manager, photoFile, removePhoto, rollId, location, supplier }
  const photoRef = useRef(null);
  const peUrl = useMemo(() => (pe?.photoFile ? URL.createObjectURL(pe.photoFile) : ""), [pe?.photoFile]);
  useEffect(() => () => { if (peUrl) URL.revokeObjectURL(peUrl); }, [peUrl]);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [scrapQty, setScrapQty] = useState("");         // 폐기 수량 — 비우면 전량. 오염·이염으로 몇 마만 버릴 때 적는다(2026-10-08)
  const [history, setHistory] = useState(null);         // null = 읽는 중

  // 끝난 롤은 화면 목록(rolls)에 없어서 따로 읽는다. 처음엔 탭을 눌러야 읽었는데 그러면 누르기 전엔
  // 탭에 숫자가 안 떠서(2026-10-13) 탭을 열 때 바로 읽는다.
  // 다시 읽는 때는 재고 목록에서 롤이 빠져나갔을 때뿐이다(폐기·통째 판매 → 끝난 롤로 넘어감).
  // rolls 가 바뀔 때마다 읽으면 재단·라벨·위치 변경 등 실시간 갱신마다 모든 PC 가 끝난 롤 전체를
  // 다시 받는다 — 지금은 몇 개지만 수천 개가 되면 피크 시간에 부담이 된다.
  // 늦게 온 옛 응답이 새 목록을 덮지 않도록 순번을 둔다.
  const closedSeqRef = useRef(0);
  const loadClosed = useCallback(async () => {
    const seq = ++closedSeqRef.current;
    try {
      const list = await db.fetchRolls({ status: CLOSED_STATUSES });
      if (seq === closedSeqRef.current) setClosedRolls(list);
    } catch (e) { console.warn("[롤] 끝난 롤 조회 실패", e); if (seq === closedSeqRef.current) setClosedRolls([]); }
  }, []);
  const prevIdsRef = useRef(null);
  useEffect(() => {
    const ids = new Set(rolls.map(r => r.id));
    const prev = prevIdsRef.current;
    prevIdsRef.current = ids;
    if (prev === null) { loadClosed(); return; }                 // 처음 한 번
    for (const id of prev) if (!ids.has(id)) { loadClosed(); return; }  // 재고에서 빠진 롤이 있다
  }, [rolls, loadClosed]);

  const groups = useMemo(() => {
    const all = view === "stock" ? rolls : (closedRolls || []).filter(isClosedRoll);
    const s = q.trim().toLowerCase();
    const gs0 = groupRollsByProduct(products, all);
    const gs = mineOnly && activeManager ? gs0.filter(g => g.product?.manager === activeManager) : gs0;
    if (!s) return gs;
    // 품번·원단명·색상이 맞으면 그 품번의 롤을 전부, 아니면 위치·롤번호가 맞는 롤만 남긴다.
    return gs.map(g => {
      if (matchProduct(g.product, s)) return g;
      const hit = g.rolls.filter(r => [r.location, r.rollCode].some(v => String(v || "").toLowerCase().includes(s)));
      return hit.length ? { ...g, rolls: hit, partial: true } : null;
    }).filter(Boolean);
  }, [products, rolls, closedRolls, view, q, mineOnly, activeManager]);

  // 탭 숫자와 요약은 '내 원단' 토글을 따른다(검색은 안 따른다). 전에는 전체를 세서 "끝난 롤 4" 인데 목록엔
  // 1개만 보이는 일이 있었다 — 나머지 3개는 담당자가 빈 품번의 롤이라 내 원단에서 걸러진 것(2026-10-12).
  const scoped = useCallback((list) => {
    if (!mineOnly || !activeManager) return list;
    const mine = new Set(products.filter(p => p.manager === activeManager).map(p => p.id));
    return list.filter(r => mine.has(r.productId));
  }, [mineOnly, activeManager, products]);
  const stockScoped = useMemo(() => scoped(rolls), [scoped, rolls]);
  const closedScoped = useMemo(() => closedRolls === null ? null : scoped(closedRolls.filter(isClosedRoll)), [scoped, closedRolls]);
  const totalAvail = useMemo(() => stockScoped.filter(r => r.status === "available").length, [stockScoped]);
  const totalPending = useMemo(() => stockScoped.filter(r => r.status === "received").length, [stockScoped]);
  const closedCount = (status) => closedScoped === null ? null : closedScoped.filter(r => r.status === status).length;
  const closedTotal = closedScoped === null ? null : closedScoped.length;
  // 탭에는 롤 수와 품번 수를 같이 적는다 — "재고 4" 인데 카드는 2장이라 "왜 4냐"고 물었다(2026-10-13).
  // 카드는 품번 하나에 한 장이고 롤은 그 안에 접혀 있다.
  const countProducts = (list) => new Set(list.map(r => r.productId)).size;
  const VIEWS = [
    { k: "stock", label: "재고", count: stockScoped.length, products: countProducts(stockScoped) },
    { k: "closed", label: "끝난 롤", count: closedTotal, products: closedScoped === null ? null : countProducts(closedScoped) },
  ];

  const by = activeManager || "";
  const run = async (roll, fn, okMsg, failLabel) => {
    if (busy) return false;
    setBusy(roll.id);
    try {
      await fn();
      if (okMsg) showToast(okMsg);
      await reloadRolls?.();
      return true;
    } catch (e) {
      console.error(`${failLabel}:`, e);
      showToast(`${failLabel}: ${rollErrorText(e)}`, "error");
      return false;
    } finally { setBusy(null); }
  };

  // 라벨 요청 취소 — 라벨 PC 가 꺼진 사이 쌓인 요청 중 필요 없는 것을 거둔다. 뽑힌 뒤면 이미 늦어 no-op.
  const cancelLabel = (roll) => run(roll, async () => {
    const n = await db.cancelRollLabelRequest(roll.id);
    if (!n) throw new Error("이미 뽑혔거나 요청이 없습니다");
  }, `라벨 요청 취소 — ${roll.rollCode}`, "취소 실패");

  const reprint = (roll) => run(roll, async () => {
    const n = await db.requestRollLabelPrint([roll.id], by);
    if (!n) throw new Error("요청이 저장되지 않았습니다");
  }, !labelStationRow
    ? null
    : labelStationHere
      ? `🏷️ 라벨 재출력 요청 — ${roll.rollCode} · 이 컴퓨터에서 곧 나옵니다`
      : `🏷️ 라벨 재출력 요청 — ${roll.rollCode} · ${labelStationRow.deviceName || "담당 기기"} 에서 나옵니다`,
  "라벨 요청 실패").then(ok => {
    if (ok && !labelStationRow) {
      showToast(`🏷️ ${roll.rollCode} 요청 — 다만 라벨 출력 PC가 켜져 있지 않습니다. 설정 → 라벨 자동 출력에서 지정해 주세요`, "error");
    }
  });

  const saveLoc = async (roll) => {
    const v = (locEdit?.value || "").trim();
    setLocEdit(null);
    if (v === (roll.location || "")) return;
    await run(roll, () => db.updateRollLocation(roll.id, v),
      v ? `위치 변경 — ${roll.rollCode} → ${v}` : `위치 지움 — ${roll.rollCode}`, "위치 저장 실패");
  };

  // 수정창에서 고를 수 있는 롤 — 그 품번의 재고 롤(끝난 롤은 창고에 없으니 뺀다).
  const editableRolls = (productId) => rolls.filter(r => r.productId === productId && !isClosedRoll(r));
  const openEdit = (p, roll = null) => {
    const r = roll || editableRolls(p.id)[0] || null;
    setPe({ name: p.name || "", color: p.color || "", unitPrice: p.unitPrice ? String(Math.round(Number(p.unitPrice))) : "",
      note: p.note || "", manager: p.manager || "", photoFile: null, removePhoto: false,
      rollId: r?.id || null, location: r?.location || "", supplier: r?.supplier || "" });
    setModal({ type: "edit", product: p });
  };
  // 창 안에서 다른 롤을 고르면 그 롤의 위치·공급처로 칸을 바꾼다(고치던 값은 버린다).
  const pickEditRoll = (rollId) => {
    const r = rolls.find(x => x.id === rollId) || null;
    setPe(s => ({ ...s, rollId: r?.id || null, location: r?.location || "", supplier: r?.supplier || "" }));
  };
  const saveEdit = async () => {
    const p = modal?.product;
    if (!p || !pe || busy) return;
    const name = pe.name.trim();
    if (!name) { showToast("원단명을 입력해 주세요", "error"); return; }
    setBusy(p.id);
    try {
      // 1) 품번 — 바뀐 것이 있을 때만 쓴다
      const patch = { name, color: pe.color.trim(), unitPrice: pe.unitPrice ? Number(pe.unitPrice) : null, note: pe.note.trim(), manager: pe.manager };
      if (pe.removePhoto && !pe.photoFile) patch.photoUrl = null;
      const productChanged = patch.name !== (p.name || "") || patch.color !== (p.color || "") || (patch.unitPrice ?? null) !== (p.unitPrice ?? null)
        || patch.note !== (p.note || "") || patch.manager !== (p.manager || "") || "photoUrl" in patch;
      if (productChanged) await db.updateProduct(p.id, patch);
      let photoWarn = "";
      if (pe.photoFile) {
        try { await db.setProductPhoto(p.id, pe.photoFile); }
        catch (e) { console.warn("[수정] 사진 업로드 실패", e); photoWarn = ` · 사진은 올리지 못했습니다(${rollErrorText(e)})`; }
      }
      // 2) 롤 — 고른 롤의 위치·공급처가 바뀌었을 때만
      const r = pe.rollId ? rolls.find(x => x.id === pe.rollId) : null;
      const loc = pe.location.trim(), sup = pe.supplier.trim();
      const rollChanged = !!r && (loc !== (r.location || "") || sup !== (r.supplier || ""));
      if (rollChanged) await db.updateRoll(r.id, { location: loc, supplier: sup });
      const what = [productChanged || pe.photoFile ? `품번 ${p.code}` : "", rollChanged ? `롤 ${r.rollCode}` : ""].filter(Boolean).join(" · ");
      showToast(what ? `수정 — ${what}${photoWarn}` : "바뀐 것이 없습니다", photoWarn ? "error" : undefined);
      setModal(null); setPe(null);
      if (productChanged || pe.photoFile) await reloadProducts?.();
      if (rollChanged) await reloadRolls?.();
    } catch (e) {
      console.error("수정 실패:", e);
      showToast("수정 실패: " + rollErrorText(e), "error");
    } finally { setBusy(null); }
  };

  const openModal = (type, roll) => {
    setDelta(""); setReason(""); setScrapQty(""); setModal({ type, roll });
    if (type === "history") {
      setHistory(null);
      db.fetchRollMovements(roll.id).then(setHistory).catch(e => {
        console.error("이력 조회 실패:", e);
        showToast("이력 조회 실패: " + rollErrorText(e), "error");
        setHistory([]);
      });
    }
  };

  const deltaNum = /^[+-]?\d+(\.\d{1,2})?$/.test(delta.trim()) ? Number(delta) : NaN;
  const submitAdjust = async () => {
    const roll = modal.roll;
    if (!Number.isFinite(deltaNum) || deltaNum === 0) { showToast("조정할 수량을 입력해 주세요 (줄이면 -, 예: -2.5)", "error"); return; }
    if (!reason.trim()) { showToast("사유를 입력해 주세요", "error"); return; }
    // 잔량이 음수가 되는지는 서버가 막는다. 여기서 먼저 막지 않는 이유: 화면의 잔량은
    // 조금 전에 읽은 값이라, 그 사이 다른 사람이 잘랐으면 여기 계산이 틀린다.
    const ok = await run(roll, () => db.adjustRoll(roll.id, deltaNum, reason.trim(), by),
      `수량 조정 — ${roll.rollCode} ${signed(deltaNum)}`, "수량 조정 실패");
    if (ok) setModal(null);
  };
  // 폐기 수량 — 검단을 마친 롤만 적을 수 있다(검단 전 롤은 잔량이 없어 통째로만). 비우면 전량.
  const scrapRemaining = modal?.type === "scrap" ? Number(modal.roll.lengthRemaining) || 0 : 0;
  const scrapPartialAllowed = modal?.type === "scrap" && scrapRemaining > 0;
  const scrapQtyNum = scrapQty.trim() === "" ? scrapRemaining : (/^\d+(\.\d{1,2})?$/.test(scrapQty.trim()) ? Number(scrapQty) : NaN);
  const scrapIsPartial = scrapPartialAllowed && Number.isFinite(scrapQtyNum) && scrapQtyNum > 0 && scrapQtyNum < scrapRemaining;
  const submitScrap = async () => {
    const roll = modal.roll;
    if (!reason.trim()) { showToast("폐기 사유를 입력해 주세요", "error"); return; }
    if (scrapPartialAllowed && (!Number.isFinite(scrapQtyNum) || scrapQtyNum <= 0)) { showToast("폐기할 수량을 입력해 주세요 (예: 2.5)", "error"); return; }
    if (scrapPartialAllowed && scrapQtyNum > scrapRemaining) { showToast(`잔량 ${fmtLen(scrapRemaining)}${mUnit} 보다 많이 뺄 수 없습니다`, "error"); return; }
    const partial = scrapIsPartial;
    const ok = await run(roll, () => db.scrapRoll(roll.id, reason.trim(), by, partial ? scrapQtyNum : null),
      partial
        ? `폐기 ${fmtLen(scrapQtyNum)}${mUnit} — ${roll.rollCode} · 잔량 ${fmtLen(round2(scrapRemaining - scrapQtyNum))}${mUnit} 는 판매 가능으로 남습니다`
        : `폐기 — ${roll.rollCode}`,
      "폐기 실패");
    if (ok) setModal(null);
  };

  // 롤 삭제 — 잘못 등록한 롤을 없던 일로 한다(폐기와 다르다: 폐기는 기록이 남고, 삭제는 이력까지 지운다).
  // 주문에 잘라 나간 롤은 서버가 거절한다. 그 품번의 마지막 롤이었으면 품번도 지울지 묻는다 —
  // 롤 없는 품번은 이 화면에 안 보여서, 여기서 안 물으면 주문 등록의 제안 목록에만 남는다.
  const removeRoll = async (roll) => {
    if (busy) return;
    const p = products.find(x => x.id === roll.productId);
    if (!window.confirm(`${roll.rollCode} 롤을 삭제할까요?

잘못 등록한 롤을 지우는 기능입니다. 검단·조정 이력도 같이 지워지고 되돌릴 수 없습니다.
원단을 버리는 것이라면 '폐기'를 쓰세요.`)) return;
    setBusy(roll.id);
    try {
      const res = await db.deleteRoll(roll.id);
      showToast(`롤 삭제 — ${roll.rollCode}`);
      await reloadRolls?.();
      if (res.remaining === 0 && window.confirm(`품번 ${p?.code || ""} ${p?.name || ""} 에 남은 롤이 없습니다.
품번도 삭제할까요?

삭제하지 않으면 주문 등록의 품번 제안에 '재고 없음'으로 계속 보입니다.`)) {
        try { await db.deleteProduct(res.productId); showToast(`품번 삭제 — ${p?.code || ""}`); await reloadProducts?.(); }
        catch (e) { console.error("품번 삭제 실패:", e); showToast("품번 삭제 실패: " + rollErrorText(e), "error"); }
      }
    } catch (e) {
      console.error("롤 삭제 실패:", e);
      showToast("롤 삭제 실패: " + rollErrorText(e), "error");
    } finally { setBusy(null); }
  };

  const stat = (label, value, strong) => (
    <div style={{flex:1,minWidth:0,padding:"7px 8px",borderRadius:8,textAlign:"center",
      background: strong ? G.copperGlow : G.subtleBg, border:`1px solid ${strong ? `${G.copper}55` : "transparent"}`}}>
      <div style={{fontSize:10,fontWeight:700,color:strong ? G.copper : G.creamMuted,whiteSpace:"nowrap"}}>{label}</div>
      <div style={{fontFamily:SF,fontSize:strong ? 17 : 14,fontWeight:900,color:strong ? G.copper : G.cream,whiteSpace:"nowrap"}}>{value}</div>
    </div>
  );
  const actBtn = (text, onClick, color, disabled, title) => (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding:"6px 10px",borderRadius:7,border:`1px solid ${disabled ? G.border : color}`,background:"transparent",
      color: disabled ? G.creamMuted : color, fontFamily:S,fontSize:11.5,fontWeight:700,whiteSpace:"nowrap",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1}}>{text}</button>
  );

  const rollRow = (r, unit) => {
    const st = ROLL_STATUS[r.status] || ROLL_STATUS.received;
    const c = G[st.color] || G.creamMuted;
    const closed = isClosedRoll(r);
    const inspected = r.status === "available" || r.status === "reserved";
    const working = busy === r.id;
    const editing = locEdit?.id === r.id;
    return (
      <div key={r.id} style={{padding:"10px 0",borderTop:`1px solid ${G.creamMuted}33`,opacity:closed ? 0.6 : 1}}>
        <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
          <span style={{fontFamily:"monospace",fontSize:13,fontWeight:900,color:G.cream,overflowWrap:"anywhere"}}>{r.rollCode}</span>
          <Tag c={c} bg={`${c}1f`}>{st.label}</Tag>
          {r.origin && <Tag c={G.purple} bg={`${G.purple}1f`}>✂️ {PIECE_ORIGIN[r.origin] || "조각"}</Tag>}
          {r.labelRequestedAt && !r.labelPrintedAt && <Tag c={G.blue} bg={G.blueBg}>🏷️ 라벨 대기</Tag>}
        </div>
        {/* 조각 롤 — 왜 돌아왔는지. 잘려 나갔다가 취소·반품으로 돌아온 원단이다 */}
        {r.origin && r.note && <div style={{fontSize:11.5,color:G.creamMuted,lineHeight:1.6,marginTop:2,overflowWrap:"anywhere"}}>사유: {r.note}</div>}
        <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.7,marginTop:2}}>
          잔량 <b style={{color:G.cream,fontFamily:SF,fontSize:14}}>{fmtLen(r.lengthRemaining)}{r.lengthRemaining === null ? "" : unit}</b>
          {" · "}실측 {fmtLen(r.lengthAvailable)}{r.lengthAvailable === null ? "" : unit}
          {" · "}명세서 {fmtLen(r.lengthReceived)}{unit}
        </div>
        <div style={{fontSize:11.5,color:G.creamMuted,lineHeight:1.7,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <span>위치</span>
          {editing ? (
            <>
              <input autoFocus value={locEdit.value} onChange={e => setLocEdit({ id: r.id, value: e.target.value })}
                onKeyDown={e => { if (e.key === "Enter") saveLoc(r); if (e.key === "Escape") setLocEdit(null); }}
                onBlur={() => saveLoc(r)} placeholder="A-03" aria-label={`${r.rollCode} 위치`}
                style={{...baseInp,width:110,padding:"5px 8px",fontSize:12}}/>
            </>
          ) : (
            <button onClick={() => !closed && setLocEdit({ id: r.id, value: r.location || "" })} disabled={closed || working}
              title={closed ? undefined : "눌러서 위치 바꾸기"} style={{
                padding:"2px 8px",borderRadius:6,border:`1px dashed ${G.border}`,background:"transparent",fontFamily:S,
                fontSize:12,fontWeight:800,color:r.location ? G.cream : G.creamMuted,cursor:closed ? "default" : "pointer"}}>
              {r.location || "없음"}{closed ? "" : " ✎"}
            </button>
          )}
          {r.inspectedAt && <span>· 검단 {ymd(r.inspectedAt)}{r.inspectedBy ? ` ${r.inspectedBy}` : ""}</span>}
          {r.supplier && <span>· {r.supplier}</span>}
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6}}>
          {r.labelRequestedAt && !r.labelPrintedAt
            ? actBtn(working ? "…" : "라벨 요청 취소", () => cancelLabel(r), G.creamMuted, !!busy, "아직 안 뽑힌 라벨 요청을 거둡니다 — 밀린 요청을 줄일 때")
            : actBtn(working ? "…" : "라벨 재출력", () => reprint(r), G.blue, !inspected || !!busy,
              inspected ? "라벨 PC 에서 다시 뽑습니다" : closed ? "끝난 롤입니다" : "검단을 마쳐야 라벨을 뽑을 수 있습니다")}
          {/* 판매 완료 롤도 조정은 된다 — 잘못 센 잔량을 바로잡는 길이 이것뿐(서버도 허용). 잔량이 생기면 판매 가능으로 돌아온다(2026-10-13) */}
          {actBtn("수량 조정", () => openModal("adjust", r), G.copper, !(inspected || r.status === "sold") || !!busy,
            inspected ? undefined : r.status === "sold" ? "판매 완료 롤 — 잘못 센 잔량을 바로잡습니다(잔량이 생기면 판매 가능으로 돌아옵니다)"
              : closed ? "폐기한 롤은 조정할 수 없습니다" : "검단을 마친 뒤에 조정할 수 있습니다")}
          {actBtn("폐기", () => openModal("scrap", r), G.red, closed || !!busy, closed ? "끝난 롤입니다" : undefined)}
          {actBtn("이력", () => openModal("history", r), G.creamMuted, false)}
          {actBtn("수정", () => openEdit(products.find(p => p.id === r.productId) || { id: r.productId }, r), G.creamMuted, closed || !!busy,
            closed ? "끝난 롤입니다" : "원단명 · 가격 · 사진 · 위치 · 공급처 고치기 (수량은 '수량 조정'으로)")}
          {actBtn("삭제", () => removeRoll(r), G.creamMuted, !!busy, "잘못 등록한 롤을 지웁니다 — 주문에 잘라 나간 롤은 지울 수 없습니다")}
        </div>
      </div>
    );
  };

  const overlay = { position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:300,display:"flex",alignItems:"center",
    justifyContent:"center",padding:20,backdropFilter:"blur(4px)" };
  const box = { background:G.card,borderRadius:16,border:`1px solid ${G.border}`,boxShadow:"0 20px 60px rgba(0,0,0,0.15)",
    padding:22,width:"100%",maxWidth:420,maxHeight:"100%",overflowY:"auto",boxSizing:"border-box" };
  const mUnit = modal ? ((modal.product || products.find(p => p.id === modal.roll?.productId))?.unit || "마") : "마";
  const after = modal?.type === "adjust" && Number.isFinite(deltaNum)
    ? round2((modal.roll.lengthRemaining || 0) + deltaNum) : null;

  return (
    <div>
      {/* 머리 — 두 줄로 줄였다(2026-10-08 "필터·탭이 너무 많다").
          1줄: 검색 + 내 원단/전체 토글 하나. 2줄: 재고 / 끝난 롤 탭 + 요약 숫자. */}
      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:8}}>
        <div style={{position:"relative",flex:1,minWidth:0}}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 품번 · 원단명 · 색상 · 위치"
            style={{...baseInp,paddingRight:34,border:`1px solid ${q ? G.copper : "var(--border, #2E2820)"}`}}/>
          {q && <button onClick={() => setQ("")} aria-label="검색어 지우기" style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",
            width:24,height:24,borderRadius:"50%",border:"none",background:"transparent",color:G.creamMuted,fontSize:14,cursor:"pointer",lineHeight:1}}>✕</button>}
        </div>
        {activeManager && (
          <button onClick={() => setMineOnly(v => !v)} aria-pressed={mineOnly} title={mineOnly ? "지금은 내 원단만 보입니다 — 누르면 전체" : "지금은 전체가 보입니다 — 누르면 내 원단만"}
            style={{flexShrink:0,padding:"8px 11px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:11.5,fontWeight:800,whiteSpace:"nowrap",
              border:`1px ${mineOnly ? "solid" : "dashed"} ${mineOnly ? G.copper : G.border}`,background:mineOnly ? G.copperGlow : "transparent",color:mineOnly ? G.copper : G.creamMuted}}>
            {mineOnly ? `👤 ${activeManager}` : "👥 전체"}
          </button>
        )}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:10}}>
        <div role="tablist" style={{display:"flex",gap:6}}>
          {VIEWS.map(v => {
            const on = view === v.k;
            return (
              <button key={v.k} role="tab" aria-selected={on} onClick={() => setView(v.k)} style={{
                padding:"6px 12px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:12,fontWeight:on ? 800 : 600,
                border:`1px solid ${on ? G.copper : G.border}`,background:on ? G.copperGlow : "transparent",color:on ? G.copper : G.creamMuted}}>
                {v.label}{v.count === null ? "" : ` ${v.count}롤 · ${v.products}품번`}
              </button>
            );
          })}
        </div>
        <span style={{marginLeft:"auto",fontSize:11,color:G.creamMuted,fontWeight:700,whiteSpace:"nowrap"}}>
          {view === "stock"
            ? `품번 ${groups.length} · 판매 가능 ${totalAvail}롤${totalPending ? ` · 검단 대기 ${totalPending}롤` : ""}`
            : `품번 ${groups.length} · 판매 완료 ${closedCount("sold") ?? "…"} · 폐기 ${closedCount("scrapped") ?? "…"}`}
        </span>
      </div>

      {groups.length === 0
        ? (view !== "stock" && closedRolls === null
          ? <Empty text="읽는 중…"/>
          : mineOnly && activeManager
            ? <Empty text={q ? `내 원단 중에 "${q}" 이(가) 없습니다` : `${activeManager} 담당 원단이 ${view === "closed" ? "끝난 롤에" : "재고에"} 없습니다`}
                sub="다른 담당자 것까지 보려면 검색 옆 👤 버튼을 눌러 전체로 바꾸세요 · 담당자가 비어 있는 품번은 입고 화면에서 담당자를 정하면 여기 보입니다"/>
            : <Empty text={q ? "찾는 롤이 없습니다" : view === "closed" ? "끝난 롤이 없습니다" : "재고에 롤이 없습니다"}
                sub={q ? undefined : view === "closed" ? "통째로 나갔거나 잔량이 0이 된 롤(판매 완료)과 폐기한 롤이 여기로 옵니다" : "입고·검단 탭에서 롤을 등록하세요"}/>)
        : groups.map(g => {
          const p = g.product;
          const unit = p.unit || "마";
          const isOpen = !!open[p.id] || !!q.trim();
          return (
            <Card key={p.id} style={{marginBottom:8,padding:"12px 14px"}}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={() => setOpen(o => ({ ...o, [p.id]: !o[p.id] }))} aria-expanded={isOpen} style={{
                flex:1,minWidth:0,padding:0,border:"none",background:"transparent",cursor:"pointer",textAlign:"left",fontFamily:S,
                display:"flex",gap:10,alignItems:"center"}}>
                {p.photoUrl
                  ? <img src={p.photoUrl} alt="" style={{width:52,height:52,borderRadius:8,objectFit:"cover",border:`1px solid ${G.border}`,flex:"none",display:"block"}}/>
                  : <div style={{width:52,height:52,borderRadius:8,border:`1px dashed ${G.border}`,flex:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,opacity:0.35}}>🧵</div>}
                <div style={{minWidth:0,flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontFamily:"monospace",fontSize:13,fontWeight:900,color:G.copper,overflowWrap:"anywhere"}}>{p.code || "—"}</span>
                    {p.manager && <Tag c={G.creamMuted} bg={G.subtleBg}>{p.manager}</Tag>}
                    {g.pendingCount > 0 && <Tag c={G.yellow} bg={G.yellowBg}>검단 대기 {g.pendingCount}</Tag>}
                  </div>
                  <div style={{fontSize:14,fontWeight:800,color:G.cream,overflowWrap:"anywhere"}}>{p.name}{p.color ? ` · ${p.color}` : ""}</div>
                  {p.unitPrice ? <div style={{fontSize:11.5,color:G.creamMuted}}>{Number(p.unitPrice).toLocaleString()}원/{unit}</div> : null}
                </div>
                <span style={{flex:"none",fontSize:12,color:G.creamMuted}}>{isOpen ? "▲" : "▼"}</span>
              </button>
              {/* 품번 수정 — 펼침 버튼 안에 버튼을 넣을 수 없어 옆에 따로 둔다 */}
              <button onClick={() => openEdit(p)} disabled={!!busy} aria-label={`${p.code} 수정`} title="원단명 · 색상 · 가격 · 사진 · 담당자 · 메모 · 롤 위치 · 공급처 고치기"
                style={{flex:"none",width:32,height:32,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:13,cursor:"pointer",padding:0,lineHeight:1}}>✎</button>
              </div>
              <div style={{display:"flex",gap:6,marginTop:10}}>
                {view === "stock" ? (
                  <>
                    {stat("판매 가능", `${g.availableCount}롤`)}
                    {stat("합계 잔량", `${fmtLen(g.totalRemaining)}${unit}`)}
                    {stat("최대 재단 가능", `${fmtLen(g.maxRemaining)}${unit}`, true)}
                  </>
                ) : (
                  <>
                    {stat("판매 완료", `${g.rolls.filter(r => r.status === "sold").length}롤`)}
                    {stat("폐기", `${g.rolls.filter(r => r.status === "scrapped").length}롤`)}
                    {/* 끝난 롤의 잔량은 0이라 의미가 없다 — 실측 길이 합계(얼마나 나갔나·버렸나)를 보여준다 */}
                    {stat("실측 합계", `${fmtLen(g.rolls.reduce((a, r) => a + (Number(r.lengthAvailable ?? r.lengthReceived) || 0), 0))}${unit}`, true)}
                  </>
                )}
              </div>
              {isOpen && (
                <div style={{marginTop:10}}>
                  {g.partial && <div style={{fontSize:11,color:G.creamMuted,marginBottom:2}}>검색에 맞는 롤만 보입니다 · 위 숫자는 이 품번 전체를 센 것입니다</div>}
                  {g.rolls.map(r => rollRow(r, unit))}
                </div>
              )}
            </Card>
          );
        })}

      {/* ── 수량 조정 ── */}
      {modal?.type === "adjust" && (
        <div style={overlay} onClick={() => !busy && setModal(null)}>
          <div style={box} onClick={e => e.stopPropagation()}>
            <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.cream,marginBottom:2}}>수량 조정</div>
            <div style={{fontFamily:"monospace",fontSize:12.5,fontWeight:800,color:G.copper,marginBottom:12}}>{modal.roll.rollCode}</div>
            <div style={{marginBottom:10}}>
              <FLabel>바꿀 수량 ({mUnit}) — 줄이면 앞에 - 를 붙입니다</FLabel>
              <input autoFocus type="text" inputMode="text" value={delta}
                onChange={e => setDelta(e.target.value.replace(/,/g, ".").replace(/[^0-9.+-]/g, ""))}
                placeholder="-2.5" style={{...baseInp,fontFamily:SF,fontSize:17,fontWeight:800}}/>
            </div>
            <div style={{marginBottom:10,padding:"9px 12px",borderRadius:9,background:G.subtleBg,fontSize:12.5,color:G.creamMuted}}>
              지금 잔량 <b style={{color:G.cream}}>{fmtLen(modal.roll.lengthRemaining)}{mUnit}</b>
              {after !== null && <> → 조정 후 <b style={{color:after < 0 ? G.red : G.copper}}>{fmtLen(after)}{mUnit}</b></>}
              {after !== null && after < 0 && <div style={{color:G.red,fontWeight:700,marginTop:3}}>잔량보다 많이 뺍니다 — 저장되지 않습니다</div>}
              {after === 0 && <div style={{color:G.yellow,fontWeight:700,marginTop:3}}>잔량이 0 이 되면 판매 완료로 바뀝니다 · 버리는 것이라면 '폐기'를 쓰세요</div>}
            </div>
            <div style={{marginBottom:14}}>
              <FLabel>사유 *</FLabel>
              <input value={reason} onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submitAdjust(); }}
                placeholder="예: 다시 재 보니 짧음, 끝단 오염 잘라냄" style={baseInp}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <PrimaryBtn onClick={submitAdjust} disabled={!!busy} full>{busy ? "저장 중..." : "조정 저장"}</PrimaryBtn>
              <GhostBtn onClick={() => setModal(null)}>취소</GhostBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 폐기 ── */}
      {modal?.type === "scrap" && (
        <div style={overlay} onClick={() => !busy && setModal(null)}>
          <div style={box} onClick={e => e.stopPropagation()}>
            <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.red,marginBottom:2}}>롤 폐기</div>
            <div style={{fontFamily:"monospace",fontSize:12.5,fontWeight:800,color:G.copper,marginBottom:12}}>{modal.roll.rollCode}</div>
            {scrapPartialAllowed ? (
              <>
                {/* 몇 마만 버릴 수도 있다(오염·이염). 비우면 전량 — 적은 수량이 잔량보다 작으면 롤은 판매 가능으로 남는다. */}
                <div style={{marginBottom:10}}>
                  <FLabel>폐기 수량 ({mUnit}) — 비우면 전량</FLabel>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <input autoFocus value={scrapQty} onChange={e => setScrapQty(e.target.value.replace(/,/g, "."))} inputMode="decimal"
                      placeholder={`전량 ${fmtLen(scrapRemaining)}`} aria-label="폐기 수량" style={{...baseInp,flex:1}}/>
                    <GhostBtn onClick={() => setScrapQty("")}>전량</GhostBtn>
                  </div>
                </div>
                <div style={{marginBottom:10,fontSize:12.5,color:G.creamMuted,lineHeight:1.65}}>
                  {scrapQty.trim() !== "" && !Number.isFinite(scrapQtyNum)
                    ? <span style={{color:G.red}}>숫자로 적어 주세요 (소수점 둘째 자리까지)</span>
                    : scrapQtyNum > scrapRemaining
                      ? <span style={{color:G.red}}>잔량 {fmtLen(scrapRemaining)}{mUnit} 보다 많습니다</span>
                      : scrapIsPartial
                        ? <>잔량 {fmtLen(scrapRemaining)}{mUnit} 중 <b style={{color:G.red}}>{fmtLen(scrapQtyNum)}{mUnit}</b> 를 버리고, <b style={{color:G.cream}}>{fmtLen(round2(scrapRemaining - scrapQtyNum))}{mUnit}</b> 는 판매 가능으로 남습니다. 이력에 폐기로 남습니다.</>
                        : <>남은 <b style={{color:G.cream}}>{fmtLen(scrapRemaining)}{mUnit}</b> 를 전부 재고에서 뺍니다. 폐기한 롤은 되살릴 수 없습니다.</>}
                </div>
              </>
            ) : (
              <div style={{marginBottom:10,fontSize:12.5,color:G.creamMuted,lineHeight:1.65}}>
                검단 전 롤이라 잔량이 없습니다 — 롤을 통째로 폐기합니다. 폐기한 롤은 되살릴 수 없습니다.
              </div>
            )}
            <div style={{marginBottom:14}}>
              <FLabel>폐기 사유 *</FLabel>
              <input autoFocus={!scrapPartialAllowed} value={reason} onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submitScrap(); }}
                placeholder="예: 오염, 이염, 불량, 분실" style={baseInp}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={submitScrap} disabled={!!busy} style={{flex:1,padding:"12px",borderRadius:10,border:"none",background:G.red,color:"#fff",
                fontWeight:700,fontSize:14,cursor:busy ? "wait" : "pointer",fontFamily:S,opacity:busy ? 0.6 : 1}}>{busy ? "처리 중..." : scrapIsPartial ? `${fmtLen(scrapQtyNum)}${mUnit} 폐기` : "전량 폐기"}</button>
              <GhostBtn onClick={() => setModal(null)}>취소</GhostBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 수정 — 품번(원단명·색상·가격·사진·담당자·메모) + 롤(위치·공급처) 한 창 (2026-10-13 사용자 요청) ── */}
      {modal?.type === "edit" && pe && (
        <div style={overlay} onClick={() => !busy && setModal(null)}>
          <div style={box} onClick={e => e.stopPropagation()}>
            <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.cream,marginBottom:2}}>수정</div>
            <div style={{fontFamily:"monospace",fontSize:12.5,fontWeight:800,color:G.copper,marginBottom:4}}>{modal.product.code}</div>
            <div style={{fontSize:11,color:G.creamMuted,marginBottom:12,lineHeight:1.5}}>품번 글자는 못 바꿉니다 — 찍어 둔 라벨 QR 이 그 값입니다. 이미 등록한 주문의 품목 이름은 그대로 남습니다.</div>

            <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
              onChange={e => { const f = e.target.files?.[0]; if (f) setPe(s => ({ ...s, photoFile: f, removePhoto: false })); e.target.value = ""; }}/>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              {pe.photoFile
                ? <img src={peUrl} alt="" style={{width:76,height:76,borderRadius:10,objectFit:"cover",border:`1.5px solid ${G.copper}`,flex:"none"}}/>
                : modal.product.photoUrl && !pe.removePhoto
                  ? <img src={modal.product.photoUrl} alt="" style={{width:76,height:76,borderRadius:10,objectFit:"cover",border:`1px solid ${G.border}`,flex:"none"}}/>
                  : <div style={{width:76,height:76,borderRadius:10,border:`1px dashed ${G.border}`,flex:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,opacity:0.35}}>🧵</div>}
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <GhostBtn onClick={() => photoRef.current?.click()} small>📷 {pe.photoFile || (modal.product.photoUrl && !pe.removePhoto) ? "사진 바꾸기" : "사진 찍기"}</GhostBtn>
                {pe.photoFile
                  ? <GhostBtn onClick={() => setPe(s => ({ ...s, photoFile: null }))} small>찍은 사진 빼기</GhostBtn>
                  : modal.product.photoUrl && !pe.removePhoto
                    ? <GhostBtn onClick={() => setPe(s => ({ ...s, removePhoto: true }))} small>사진 지우기</GhostBtn>
                    : modal.product.photoUrl && pe.removePhoto
                      ? <GhostBtn onClick={() => setPe(s => ({ ...s, removePhoto: false }))} small>지우기 취소</GhostBtn>
                      : null}
              </div>
            </div>

            <div style={{marginBottom:10}}>
              <FLabel>원단명 *</FLabel>
              <input autoFocus value={pe.name} onChange={e => setPe(s => ({ ...s, name: e.target.value }))} style={baseInp}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <div><FLabel>색상</FLabel>
                <input value={pe.color} onChange={e => setPe(s => ({ ...s, color: e.target.value }))} placeholder="베이지" style={baseInp}/></div>
              <div><FLabel>가격 (원/{mUnit})</FLabel>
                <input type="text" inputMode="numeric" value={pe.unitPrice ? Number(pe.unitPrice).toLocaleString() : ""}
                  onChange={e => setPe(s => ({ ...s, unitPrice: e.target.value.replace(/[^0-9]/g, "") }))} placeholder="0"
                  style={{...baseInp,fontFamily:SF,fontWeight:800}}/></div>
            </div>
            <div style={{marginBottom:10}}>
              <FLabel>담당자 (이 원단의 주인) — 바꿔도 품번 앞글자는 그대로</FLabel>
              <select value={pe.manager} onChange={e => setPe(s => ({ ...s, manager: e.target.value }))} style={{...baseInp,width:"auto",minWidth:140}}>
                <option value="">없음</option>
                {!managers.some(m => m.name === pe.manager) && pe.manager && <option value={pe.manager}>{pe.manager}</option>}
                {managers.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </div>
            <div style={{marginBottom:12}}>
              <FLabel>메모</FLabel>
              <input value={pe.note} onChange={e => setPe(s => ({ ...s, note: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); }}
                placeholder="비고사항" style={baseInp}/>
            </div>

            {/* 롤 — 위치·공급처. 롤 줄에서 열면 그 롤, ✎ 로 열면 첫 롤이 골라져 있다. 다른 롤로 바꿀 수 있다. */}
            {(() => {
              const list = editableRolls(modal.product.id);
              if (!list.length) return null;
              const cur = list.find(x => x.id === pe.rollId) || null;
              return (
                <div style={{padding:"10px 12px",background:G.subtleBg,borderRadius:10,marginBottom:14}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontWeight:800,color:G.copper,letterSpacing:"0.06em"}}>롤</span>
                    <select value={pe.rollId || ""} onChange={e => pickEditRoll(e.target.value)} aria-label="고칠 롤"
                      style={{...baseInp,width:"auto",padding:"4px 8px",fontSize:12,fontFamily:"monospace",fontWeight:800}}>
                      {list.map(x => <option key={x.id} value={x.id}>{x.rollCode}{x.location ? ` · ${x.location}` : ""}</option>)}
                    </select>
                    {cur && <span style={{fontSize:11,color:G.creamMuted}}>잔량 {fmtLen(cur.lengthRemaining)}{cur.lengthRemaining === null ? "" : mUnit} — 수량은 '수량 조정'으로</span>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><FLabel>위치</FLabel>
                      <input value={pe.location} onChange={e => setPe(s => ({ ...s, location: e.target.value }))} placeholder="A-03" style={baseInp}/></div>
                    <div><FLabel>공급처</FLabel>
                      <input value={pe.supplier} onChange={e => setPe(s => ({ ...s, supplier: e.target.value }))} onKeyDown={e => { if (e.key === "Enter") saveEdit(); }}
                        placeholder="동대문 ○○" style={baseInp}/></div>
                  </div>
                </div>
              );
            })()}
            <div style={{display:"flex",gap:8}}>
              <PrimaryBtn onClick={saveEdit} disabled={!!busy} full>{busy ? (pe.photoFile ? "사진 올리는 중..." : "저장 중...") : "저장"}</PrimaryBtn>
              <GhostBtn onClick={() => { setModal(null); setPe(null); }}>취소</GhostBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 이력 ── */}
      {modal?.type === "history" && (
        <div style={overlay} onClick={() => setModal(null)}>
          <div style={{...box,maxWidth:480}} onClick={e => e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:2}}>
              <span style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.cream}}>잔량 변동 이력</span>
              <button onClick={() => setModal(null)} aria-label="닫기" style={{width:28,height:28,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:13,cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
            </div>
            <div style={{fontFamily:"monospace",fontSize:12.5,fontWeight:800,color:G.copper,marginBottom:4}}>{modal.roll.rollCode}</div>
            <div style={{fontSize:11.5,color:G.creamMuted,marginBottom:10}}>
              명세서 {fmtLen(modal.roll.lengthReceived)}{mUnit} · 지금 잔량 {fmtLen(modal.roll.lengthRemaining)}{modal.roll.lengthRemaining === null ? "" : mUnit} · 최근 것부터
            </div>
            {history === null
              ? <div style={{padding:"24px 0",textAlign:"center",fontSize:12.5,color:G.creamMuted}}>읽는 중…</div>
              : history.length === 0
                ? <div style={{padding:"24px 0",textAlign:"center",fontSize:12.5,color:G.creamMuted}}>아직 기록이 없습니다 — 검단 전입니다</div>
                : history.map(m => (
                  <div key={m.id} style={{padding:"8px 0",borderTop:`1px solid ${G.creamMuted}33`}}>
                    <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
                      <span style={{fontSize:12.5,fontWeight:800,color:G.cream}}>{MOVEMENT_LABEL[m.type] || m.type}</span>
                      <span style={{fontFamily:SF,fontSize:14,fontWeight:900,color:m.type === "inspect" ? G.green : m.qty < 0 ? G.red : G.blue}}>
                        {m.type === "inspect" ? `실측 ${fmtLen(m.qty)}` : signed(m.qty)}{mUnit}
                      </span>
                      <span style={{marginLeft:"auto",fontSize:11,color:G.creamMuted,fontFamily:"monospace"}}>{ymdhm(m.createdAt)}</span>
                    </div>
                    <div style={{fontSize:11.5,color:G.creamMuted,lineHeight:1.6,overflowWrap:"anywhere"}}>
                      {m.createdBy || "담당자 없음"}{m.note ? ` · ${m.note}` : ""}{m.orderId ? ` · 주문 ${m.orderId}` : ""}
                    </div>
                  </div>
                ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default RollStockTab;
