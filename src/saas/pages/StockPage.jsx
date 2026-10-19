// 재고 관리 — 품번별 롤 목록·잔량·최대 재단 가능·입고 등록·조정·폐기·이력(지시서 3절 A, 4절 재고 관리).
// 잔량은 서버 함수(db.adjustRoll / db.scrapRoll / receiveRolls→inspect)로만 바뀐다. updateRoll 로 직접 고치지 않는다(업무 규칙 4).
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal, ConfirmModal } from "../components/Modal.jsx";
import { PageHead, StatCard, Button, Panel, SearchInput, FilterChips, StatusBadge, Empty, LoadingLine, won } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { stockStats, stockStatus, stockRatio, stockLocations, monthShippedLength } from "../lib/metrics.js";
import { matchProduct, fmtLen, parseMeasured, prefixForManager, ROLL_STATUS, MOVEMENT_LABEL, PIECE_ORIGIN, rollErrorText, round2 } from "../../lib/rollStock.js";
import { OLD_ERP_PATH } from "../config.js";

// 시안의 원단 텍스처 — 사진이 없는 품번은 색상 이름으로 비슷한 색을 고른다. 사진이 있으면 사진.
const SWATCHES = [
  [/네이비|남색|navy/i, "linear-gradient(135deg,#1b3154,#496d9e)"],
  [/아이보리|ivory|크림|cream/i, "linear-gradient(135deg,#e2d9c9,#faf5e9)"],
  [/차콜|charcoal|그레이|회색|gray|grey/i, "linear-gradient(135deg,#33383e,#81868e)"],
  [/블랙|검정|black/i, "linear-gradient(135deg,#191c27,#444b59)"],
  [/베이지|beige|카키|khaki|브라운|갈색|brown/i, "linear-gradient(135deg,#b59e79,#e7d6b8)"],
  [/화이트|흰|white/i, "linear-gradient(135deg,#e9ecf0,#ffffff)"],
  [/레드|빨강|red|와인|버건디/i, "linear-gradient(135deg,#7a2a35,#c05463)"],
  [/핑크|분홍|pink/i, "linear-gradient(135deg,#d99aa8,#f5d3db)"],
  [/옐로|노랑|yellow|머스타드/i, "linear-gradient(135deg,#c9a23a,#f0d77a)"],
  [/그린|초록|green|올리브|민트/i, "linear-gradient(135deg,#3f6b4f,#8fb79a)"],
  [/블루|파랑|blue|하늘|sky/i, "linear-gradient(135deg,#3b5f8f,#7fa3d1)"],
  [/체크|check|스트라이프|stripe/i, "repeating-linear-gradient(0deg,#5275a1,#5275a1 16px,#e9ecf2 17px,#587399 20px)"],
];
const swatchOf = (p) => {
  const key = `${p?.name || ""} ${p?.color || ""}`;
  for (const [re, bg] of SWATCHES) if (re.test(key)) return bg;
  return "linear-gradient(135deg,#1f3b67,#365785)";
};

const statusLabel = { ok: ["progress", "판매 중"], low: ["late", "재고 부족"], out: ["done", "품절"] };

function InvCard({ g, onOpen }) {
  const { config } = useSaas();
  const st = stockStatus(g, config.lowStockM);
  const [tone, label] = statusLabel[st];
  const ratio = stockRatio(g);
  const pct = ratio === null ? 0 : Math.round(ratio * 100);
  const loc = stockLocations(g);
  const p = g.product;
  return (
    <button className="invcard" onClick={() => onOpen(g)}>
      <div className={`swatch${p.photoUrl ? " photo" : ""}`} style={p.photoUrl ? { backgroundImage: `url(${p.photoUrl})` } : { background: swatchOf(p) }}>
        <span className="code">{p.code}</span>
      </div>
      <div className="invrow"><strong>{p.name}{p.color ? ` ${p.color}` : ""}</strong><StatusBadge tone={tone}>{label}</StatusBadge></div>
      <small>혼용률 — · {p.color || "색상 미기재"} · 롤 {g.availableCount}개{g.pendingCount ? ` · 검단 대기 ${g.pendingCount}` : ""}</small>
      <div className="invrow">
        <span className="invstock">{fmtLen(g.totalRemaining)}<em>{p.unit || "마"}</em><em style={{ marginLeft: 8 }}>최대 재단 {fmtLen(g.maxRemaining)}</em></span>
        <small>{loc ? `보관 ${loc}` : "보관 —"}</small>
      </div>
      <div className="progressbar" title={ratio === null ? "입고 길이 기록 없음" : `입고 대비 ${pct}%`}><span style={{ width: `${pct}%`, background: pct < 25 ? "#ec9875" : "#4988f6" }} /></div>
    </button>
  );
}

/** 입고 등록 — 옛 InspectionTab.receive 를 그대로 옮긴 흐름: 품번 고르기(없으면 insertProduct) → receiveRolls(롤마다 길이). */
function ReceiveModal({ onClose, initialProduct }) {
  const { products, managers, activeManager, reloadProducts, reloadRolls, config } = useSaas();
  const toast = useToast();
  const [q, setQ] = useState(initialProduct ? initialProduct.code : "");
  const [picked, setPicked] = useState(initialProduct || null);
  const [newOpen, setNewOpen] = useState(false);
  const [np, setNp] = useState({ name: "", color: "", unitPrice: "", note: "" });
  const [count, setCount] = useState(1);
  const [lengths, setLengths] = useState([""]);
  const [supplier, setSupplier] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const suggestions = useMemo(() => !q.trim() || picked ? [] : products.filter(p => matchProduct(p, q)).slice(0, 8), [products, q, picked]);
  const ownerPrefix = prefixForManager(managers, activeManager, config.productPrefix);
  const parsed = lengths.slice(0, count).map(v => parseMeasured(v));
  const lensOk = count >= 1 && parsed.every(p => p.ok && p.value > 0);
  const canGo = (picked || (newOpen && np.name.trim())) && lensOk && !busy;
  const setCountSafe = (n) => { const c = Math.max(1, Math.min(99, parseInt(n) || 1)); setCount(c); setLengths(p => Array.from({ length: c }, (_, i) => p[i] ?? "")); };

  const receive = async () => {
    if (!canGo) return;
    setBusy(true);
    try {
      let product = picked;
      if (!product) {
        const same = products.find(p => p.name.trim() === np.name.trim() && (p.color || "").trim() === (np.color || "").trim());
        if (same && window.confirm(`이미 있는 품번입니다 — ${same.code} ${same.name}${same.color ? ` ${same.color}` : ""}\n\n이 품번에 롤을 넣을까요?\n(취소하면 같은 이름으로 새 품번을 하나 더 만듭니다)`)) product = same;
        else {
          product = await db.insertProduct({ name: np.name.trim(), color: np.color, note: np.note, unitPrice: parseInt(String(np.unitPrice).replace(/\D/g, "")) || null, manager: activeManager, prefix: ownerPrefix });
          await reloadProducts();
        }
        setPicked(product); setQ(product.code); setNewOpen(false);
      }
      const { rolls: made, failed, labelRequested } = await db.receiveRolls(product.id, { lengths: parsed.map(p => p.value), supplier, location }, activeManager || "");
      const range = made.length ? `${made[0].rollCode}${made.length > 1 ? ` ~ ${made[made.length - 1].rollCode.slice(-3)}` : ""}` : "";
      if (failed.length) toast(`입고 ${made.length}롤 판매 가능 — ${failed.join(", ")} 은(는) 실패해 검단 대기로 남았습니다(옛 화면 입고·검단에서 마저 처리)`, "error");
      else if (!labelRequested) toast(`📥 입고 ${made.length}롤 (${range}) — 라벨 요청에 실패했습니다. 옛 화면 롤 재고에서 다시 요청해 주세요`, "error");
      else toast(`📥 입고 ${made.length}롤 (${range}) · 판매 가능 · 라벨 출력 요청됨`);
      await reloadRolls();
      onClose();
    } catch (e) {
      console.error("[saas] 입고 실패", e);
      toast("입고 등록 실패: " + rollErrorText(e), "error");
    } finally { setBusy(false); }
  };

  return (
    <Modal title="입고 등록" onClose={onClose} width="wide">
      <p className="helptext warn">실제 운영 재고(stock_rolls)에 저장됩니다. 롤마다 길이를 적으면 바로 판매 가능 상태가 되고 라벨 출력이 요청됩니다.</p>
      <label className="formlabel" htmlFor="rcv-q">품번 · 원단명</label>
      <div style={{ position: "relative" }}>
        <input id="rcv-q" className="forminput" value={q} placeholder="품번이나 원단명으로 찾기" autoComplete="off"
          onChange={e => { setQ(e.target.value); setPicked(null); setNewOpen(false); }} />
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", left: 0, right: 0, top: "100%", zIndex: 5, background: "#fff", border: "1px solid #dfe6ef", borderRadius: 13, boxShadow: "0 12px 30px #1b31552a", marginTop: 6, overflow: "hidden" }}>
            {suggestions.map(p => (
              <button key={p.id} type="button" onClick={() => { setPicked(p); setQ(p.code); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", border: 0, background: "#fff", borderBottom: "1px solid #f0f3f7", fontSize: 15 }}>
                <strong className="mono">{p.code}</strong> · {p.name}{p.color ? ` ${p.color}` : ""}{p.unitPrice ? <span style={{ color: "#8d9bab" }}> · {won(p.unitPrice)}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
      {picked ? <div className="notice-box" style={{ marginTop: 8 }}>선택: <b className="mono">{picked.code}</b> {picked.name}{picked.color ? ` ${picked.color}` : ""} <button className="text-link" style={{ display: "inline-flex", padding: "0 6px" }} onClick={() => { setPicked(null); setQ(""); }}>바꾸기</button></div>
        : !newOpen ? <div style={{ marginTop: 8 }}><button className="text-link" style={{ padding: "6px 0" }} onClick={() => { setNewOpen(true); setNp(p => ({ ...p, name: q })); }}><Icon name="plus" /> 새 품번으로 등록 (접두어 {ownerPrefix})</button></div>
        : (
          <div className="notice-box" style={{ marginTop: 8 }}>
            <div className="formrow">
              <div><label className="formlabel" htmlFor="np-name" style={{ marginTop: 4 }}>원단명</label><input id="np-name" className="forminput" value={np.name} onChange={e => setNp({ ...np, name: e.target.value })} /></div>
              <div><label className="formlabel" htmlFor="np-color" style={{ marginTop: 4 }}>색상</label><input id="np-color" className="forminput" value={np.color} onChange={e => setNp({ ...np, color: e.target.value })} /></div>
              <div><label className="formlabel" htmlFor="np-price" style={{ marginTop: 4 }}>단가 (원/마)<span className="opt">선택</span></label><input id="np-price" className="forminput" inputMode="numeric" value={np.unitPrice} onChange={e => setNp({ ...np, unitPrice: e.target.value })} /></div>
              <div><label className="formlabel" htmlFor="np-note" style={{ marginTop: 4 }}>메모<span className="opt">선택</span></label><input id="np-note" className="forminput" value={np.note} onChange={e => setNp({ ...np, note: e.target.value })} /></div>
            </div>
            <p className="helptext" style={{ margin: "10px 0 0" }}>품번은 서버가 발급합니다({ownerPrefix}-년월-번호). 사진은 옛 화면의 입고·검단에서 붙일 수 있습니다.</p>
          </div>
        )}
      <div className="formrow">
        <div><label className="formlabel" htmlFor="rcv-count">롤 수</label><input id="rcv-count" className="forminput" type="number" min={1} max={99} value={count} onChange={e => setCountSafe(e.target.value)} /></div>
        <div><label className="formlabel" htmlFor="rcv-loc">보관 위치<span className="opt">선택</span></label><input id="rcv-loc" className="forminput" value={location} onChange={e => setLocation(e.target.value)} placeholder="예: A-01" /></div>
      </div>
      <label className="formlabel">롤마다 길이 (마)</label>
      <div className="formrow">
        {Array.from({ length: count }, (_, i) => (
          <input key={i} className="forminput" inputMode="decimal" placeholder={`${i + 1}번 롤`} value={lengths[i] ?? ""} aria-label={`${i + 1}번 롤 길이`}
            onChange={e => setLengths(p => { const n = [...p]; n[i] = e.target.value; return n; })} />
        ))}
      </div>
      {count > 1 && <button className="text-link" style={{ padding: "8px 0" }} onClick={() => setLengths(p => p.map(() => p[0]))}>전부 1번 롤 길이로</button>}
      <label className="formlabel" htmlFor="rcv-sup">공급처<span className="opt">선택</span></label>
      <input id="rcv-sup" className="forminput" value={supplier} onChange={e => setSupplier(e.target.value)} />
      <div className="btnrow" style={{ marginTop: 22 }}>
        <Button kind="white" onClick={onClose}>취소</Button>
        <Button icon="check" onClick={receive} disabled={!canGo} loading={busy}>입고 등록</Button>
      </div>
    </Modal>
  );
}

/** 원단 상세 — 롤 목록(잔량·위치), 조정·폐기, 이력. */
function StockDetail({ group, onClose, onReceive }) {
  const { activeManager, reloadRolls, config } = useSaas();
  const LOW_STOCK_M = config.lowStockM;
  const toast = useToast();
  const [mode, setMode] = useState(null);   // {kind:"adjust"|"scrap"|"history", roll}
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [scrapQty, setScrapQty] = useState("");
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const p = group.product;
  const open = group.rolls.filter(r => !["sold", "scrapped"].includes(r.status));
  const closed = group.rolls.length - open.length;
  const st = stockStatus(group, LOW_STOCK_M);
  const [tone, label] = statusLabel[st];

  useEffect(() => {
    if (mode?.kind !== "history") return;
    setHistory(null);
    db.fetchRollMovements(mode.roll.id).then(setHistory).catch(e => { toast("이력 조회 실패: " + rollErrorText(e), "error"); setHistory([]); });
  }, [mode, toast]);

  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); toast(ok); await reloadRolls(); setMode(null); setDelta(""); setReason(""); setScrapQty(""); }
    catch (e) { toast("처리 실패: " + rollErrorText(e), "error"); }
    finally { setBusy(false); }
  };
  const submitAdjust = () => {
    const d = round2(parseFloat(delta));
    if (!Number.isFinite(d) || d === 0) { toast("변화량을 적어 주세요 (줄이면 음수)", "error"); return; }
    if (!reason.trim()) { toast("조정 사유를 적어 주세요", "error"); return; }
    return run(() => db.adjustRoll(mode.roll.id, d, reason.trim(), activeManager || ""), `${mode.roll.rollCode} 잔량 ${d > 0 ? "+" : ""}${d} 조정`);
  };
  const submitScrap = () => {
    if (!reason.trim()) { toast("폐기 사유를 적어 주세요", "error"); return; }
    const q = scrapQty.trim() ? parseFloat(scrapQty) : null;
    return run(() => db.scrapRoll(mode.roll.id, reason.trim(), activeManager || "", q), q ? `${mode.roll.rollCode} ${q}${p.unit || "마"} 폐기` : `${mode.roll.rollCode} 전량 폐기`);
  };

  return (
    <Modal title="원단 상세" onClose={onClose} width="wide">
      <div className={`swatch${p.photoUrl ? " photo" : ""}`} style={{ height: 130, marginTop: 20, ...(p.photoUrl ? { backgroundImage: `url(${p.photoUrl})` } : { background: swatchOf(p) }) }}><span className="code">{p.code}</span></div>
      <p className="helptext">혼용률 — · {p.color || "색상 미기재"} · 보관 위치 {stockLocations(group) || "—"}{p.unitPrice ? ` · 단가 ${won(p.unitPrice)}` : ""}{p.manager ? ` · 담당 ${p.manager}` : ""}</p>
      <div className="invrow" style={{ margin: "16px 0 10px" }}>
        <strong style={{ fontSize: 19 }}>{p.name}{p.color ? ` ${p.color}` : ""}</strong>
        <span className="invstock">{fmtLen(group.totalRemaining)}<em>{p.unit || "마"}</em></span>
      </div>
      <div className="chiprow" style={{ marginBottom: 6 }}>
        <StatusBadge tone={tone}>{label}</StatusBadge>
        <StatusBadge tone="gray">최대 재단 가능 {fmtLen(group.maxRemaining)}{p.unit || "마"}</StatusBadge>
        <StatusBadge tone="gray">판매 가능 롤 {group.availableCount}개</StatusBadge>
        {group.pendingCount > 0 && <StatusBadge tone="wait">검단 대기 {group.pendingCount}</StatusBadge>}
      </div>
      {!mode && (
        <>
          <div className="section-label">롤 목록 {closed > 0 ? `(끝난 롤 ${closed}개는 숨김)` : ""}</div>
          {open.length === 0 ? <Empty small>남은 롤이 없습니다.</Empty> : open.map(r => (
            <div key={r.id} className="roll-row">
              <span className="code mono">{r.rollCode}{r.origin ? <small style={{ color: "#8a69da", marginLeft: 6 }}>{PIECE_ORIGIN[r.origin] || "조각"}</small> : null}</span>
              <span className="loc">{ROLL_STATUS[r.status]?.label || r.status}{r.location ? ` · ${r.location}` : ""}</span>
              <span className="len">{fmtLen(r.lengthRemaining)}{p.unit || "마"}</span>
              <Button kind="white" size="sm" onClick={() => setMode({ kind: "history", roll: r })} title="이력">이력</Button>
              {r.status === "available" && <Button kind="white" size="sm" onClick={() => setMode({ kind: "adjust", roll: r })}>조정</Button>}
              {r.status === "available" && <Button kind="danger" size="sm" onClick={() => setMode({ kind: "scrap", roll: r })}>폐기</Button>}
            </div>
          ))}
          <div className="inline-actions">
            <Button icon="plus" onClick={() => onReceive(p)}>이 품번 입고</Button>
          </div>
          <div className="link-old">검단 대기 롤·라벨 재출력·품번 사진·삭제는 <a href={OLD_ERP_PATH}>옛 화면(입고·검단, 롤 재고)</a>에서 처리합니다.</div>
        </>
      )}
      {mode?.kind === "adjust" && (
        <>
          <div className="section-label">잔량 조정 — {mode.roll.rollCode} (지금 {fmtLen(mode.roll.lengthRemaining)}{p.unit || "마"})</div>
          <label className="formlabel" htmlFor="adj-delta">변화량 (줄이면 음수, 예: -2.5)</label>
          <input id="adj-delta" className="forminput" inputMode="decimal" value={delta} onChange={e => setDelta(e.target.value)} />
          <label className="formlabel" htmlFor="adj-reason">사유</label>
          <input id="adj-reason" className="forminput" value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 실측 오차" />
          <div className="btnrow" style={{ marginTop: 18 }}><Button kind="white" onClick={() => setMode(null)}>취소</Button><Button onClick={submitAdjust} loading={busy} icon="check">조정 저장</Button></div>
        </>
      )}
      {mode?.kind === "scrap" && (
        <>
          <div className="section-label">폐기 — {mode.roll.rollCode} (잔량 {fmtLen(mode.roll.lengthRemaining)}{p.unit || "마"})</div>
          <label className="formlabel" htmlFor="scr-qty">폐기 수량<span className="opt">비우면 전량</span></label>
          <input id="scr-qty" className="forminput" inputMode="decimal" value={scrapQty} onChange={e => setScrapQty(e.target.value)} placeholder="전량" />
          <label className="formlabel" htmlFor="scr-reason">사유</label>
          <input id="scr-reason" className="forminput" value={reason} onChange={e => setReason(e.target.value)} placeholder="예: 오염" />
          <div className="btnrow" style={{ marginTop: 18 }}><Button kind="white" onClick={() => setMode(null)}>취소</Button><Button kind="danger" onClick={submitScrap} loading={busy} icon="trash">폐기</Button></div>
        </>
      )}
      {mode?.kind === "history" && (
        <>
          <div className="section-label">이력 — {mode.roll.rollCode}</div>
          {history === null ? <LoadingLine /> : history.length === 0 ? <Empty small>기록이 없습니다.</Empty> : history.map(m => (
            <div key={m.id} className="roll-row">
              <span className="loc" style={{ minWidth: 92 }}>{new Date(m.createdAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="code">{MOVEMENT_LABEL[m.type] || m.type}{m.note ? ` · ${m.note}` : ""}{m.createdBy ? ` · ${m.createdBy}` : ""}</span>
              <span className="len" style={{ color: (m.qty || 0) < 0 ? "#d76964" : "#23986f" }}>{(m.qty || 0) > 0 ? "+" : ""}{fmtLen(m.qty)}</span>
            </div>
          ))}
          <div className="btnrow" style={{ marginTop: 18 }}><Button kind="white" onClick={() => setMode(null)}>닫기</Button></div>
        </>
      )}
    </Modal>
  );
}

export default function StockPage({ route }) {
  const { products, groups, shipped, loaded, config } = useSaas();
  const LOW_STOCK_M = config.lowStockM;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [receive, setReceive] = useState(null);   // false | {product}
  const go = route.go;
  const stats = useMemo(() => stockStats(products, groups, LOW_STOCK_M), [products, groups, LOW_STOCK_M]);
  const monthSold = useMemo(() => monthShippedLength(shipped), [shipped]);
  const list = useMemo(() => groups.filter(g => {
    const st = stockStatus(g, LOW_STOCK_M);
    if (filter === "low" && st !== "low") return false;
    if (filter === "out" && st !== "out") return false;
    return matchProduct(g.product, q) || (g.rolls || []).some(r => String(r.location || "").toLowerCase().includes(q.trim().toLowerCase()) && q.trim());
  }), [groups, filter, q]);
  const selected = route.id && route.id !== "receive" ? groups.find(g => String(g.product.id) === route.id) : null;
  const receiveOpen = route.id === "receive" || !!receive;

  return (
    <>
      <PageHead eyebrow="INVENTORY" title="재고 관리" subtitle="원단의 수량과 보관 위치를 편하게 확인하세요." />
      <div className="stats">
        <StatCard title="총 원단 품목" value={stats.productCount} unit="개" icon="layers" note="현재 관리 중" noteTone="muted" />
        <StatCard title="총 재고 수량" value={stats.totalRemaining} unit="마" icon="box" tone="mint" note="판매 가능 롤 잔량 합산" noteTone="muted" />
        <StatCard title="부족한 원단" value={stats.low} unit="개" icon="alert" tone="orange" note={`최대 재단 가능 ${LOW_STOCK_M}마 미만 · 품절 ${stats.out}개`} noteTone="alert" onClick={() => setFilter("low")} />
        <StatCard title="이번 달 판매" value={monthSold} unit="마" icon="trend" tone="purple" note="이번 달 출고완료 주문의 마 수량" />
      </div>
      <div className="searchline">
        <SearchInput value={q} onChange={setQ} placeholder="원단명 · 품번 · 색상 · 위치 검색" id="stockSearch" />
        <Button icon="plus" onClick={() => go("/app/stock/receive")}>재고 등록</Button>
      </div>
      <Panel title="원단 목록" small={`${list.length}개 품목${groups.length !== products.length ? ` · 롤이 없는 품번 ${products.length - groups.length}개는 숨김` : ""}`}>
        <FilterChips style={{ marginBottom: 19 }} value={filter} onChange={setFilter}
          options={[["all", "전체", groups.length], ["low", "재고 부족", stats.low], ["out", "품절", stats.out]]} />
        {!loaded ? <LoadingLine /> : list.length === 0 ? <Empty>{groups.length === 0 ? "등록된 롤이 없어요. 재고 등록으로 첫 롤을 넣어 보세요." : "검색 결과가 없어요."}</Empty> : (
          <div className="inv-grid">{list.map(g => <InvCard key={g.product.id} g={g} onOpen={(g) => go(`/app/stock/${g.product.id}`)} />)}</div>
        )}
      </Panel>
      {selected && <StockDetail group={selected} onClose={() => go("/app/stock")} onReceive={(p) => { setReceive({ product: p }); }} />}
      {receiveOpen && <ReceiveModal initialProduct={receive?.product || null} onClose={() => { setReceive(null); if (route.id === "receive") go("/app/stock"); }} />}
    </>
  );
}
