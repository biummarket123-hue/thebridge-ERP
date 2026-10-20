// 포장대(/app/pack) — 롤 QR·주문 라벨 QR 을 찍어 재단을 기록하고, 사람이 "포장완료"로 박스를 확정한다.
//
// 판정 규칙은 lib/packing.js(옛 PackingTab 과 같은 함수), 박스 묶기·칸 나누기는 saas/lib/packBoxes.js, DB 호출은 saas/actions/pack.js.
// 여기는 상태와 그림만. 재고 차감은 롤을 찍는 순간(pack_item_from_roll) 일어나고, 출고완료는 ShipFlow 가 한다.
//
// 스캔: HID 스캐너는 키보드처럼 글자를 치고 Enter 를 보낸다. 화면 어디에 커서가 있든 document keydown 에서 물리 키(e.code)로
// 글자를 모은다(옛 PackingTab 방식 — 한글 입력기 상태여도 안 섞인다). 다른 입력칸(검색·사유)에 치는 중이면 건드리지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { Modal } from "../components/Modal.jsx";
import { PageHead, StatCard, Button, Panel, StatusBadge, Chip, SearchInput, Empty, LoadingLine, shortId } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { useRealtimeItemPacking } from "../../lib/realtime.js";
import { indexPacking, allItemsPacked, ROLL_STATUS_LABEL } from "../../lib/packing.js";
import { fmtLen, PIECE_ORIGIN } from "../../lib/rollStock.js";
import { BUCKETS } from "../../lib/shipDate.js";
import { buildBoxes, splitBoxes, packMetrics, itemPackState, filterBoxes, boxTitle, missingItemIdx } from "../lib/packBoxes.js";
import * as pack from "../actions/pack.js";
import "../saas-pack.css";

const BANNER_MS = 5000;
const QUEUE_TABS = ["urgent", "today", "tomorrow", "later"];
const TABS = [
  ...QUEUE_TABS.map(k => [k, `${BUCKETS[k].emoji} ${BUCKETS[k].label}`]),
  ["done", "✅ 완료"], ["hold", "📦 보관 요청"],
];

// 짧은 경고음 — 거부(낮고 거친 소리) · ask(높은 두 음: 롤 QR 을 이어서 찍으라는 신호). 소리가 안 나는 환경이면 조용히 넘어간다.
function beep(kind = "error") {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const osc = ac.createOscillator(), gain = ac.createGain();
    const ask = kind === "ask";
    osc.type = ask ? "sine" : "square"; osc.frequency.value = ask ? 880 : 520;
    gain.gain.value = 0.12;
    osc.connect(gain); gain.connect(ac.destination);
    osc.start();
    if (ask) osc.frequency.setValueAtTime(1175, ac.currentTime + 0.12);
    osc.stop(ac.currentTime + (ask ? 0.24 : 0.3));
    osc.onended = () => { try { ac.close(); } catch { /* 이미 닫힘 */ } };
  } catch { /* 소리는 보조 수단 — 배너가 있다 */ }
}

// 물리 키 → 글자(옛 PackingTab.charFromKey). 스캔 코드에 쓰이는 글자만: 영숫자·-·/·:·. 등. Space 는 받지 않는다(버튼 누름을 막지 않게).
function charFromKey(e) {
  const c = e.code || "";
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return e.shiftKey ? ({ 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*", 9: "(", 0: ")" })[c.slice(5)] : c.slice(5);
  if (/^Numpad[0-9]$/.test(c)) return c.slice(6);
  const PUNCT = { Semicolon: [";", ":"], Minus: ["-", "_"], Slash: ["/", "?"], Period: [".", ">"], Equal: ["=", "+"], Comma: [",", "<"], Backslash: ["\\", "|"], Quote: ["'", "\""], Backquote: ["`", "~"] };
  if (PUNCT[c]) return PUNCT[c][e.shiftKey ? 1 : 0];
  return null;
}
const isEditable = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

const itemLine = (it) => `${it?.fabric || ""}${it?.color ? ` ${it.color}` : ""}`.trim() || "품목";
const qtyLine = (it) => `${it?.qty ?? ""}${it?.unit || "마"}`;

/** 박스 카드(목록) */
function BoxCard({ row, active, flash, packingByOrder, onSelect }) {
  const prog = row.scanTotal > 0 ? `${row.scanDone}/${row.scanTotal}` : "";
  return (
    <button id={`pk-${row.key}`} className={`pk-box${active ? " active" : ""}${flash ? " flash" : ""}`} onClick={() => onSelect(row)} aria-pressed={active}>
      <div className="pk-box-head">
        <strong>{boxTitle(row)}</strong>
        <span className="id">#{shortId(row.orders[0]?.id)}</span>
        {row.merged && <StatusBadge tone="progress">합배송 {row.orders.length}건</StatusBadge>}
        {prog && <span className={`prog${row.scanDone === row.scanTotal ? " full" : ""}`}>{prog}</span>}
      </div>
      <div className="pk-badges">
        <StatusBadge tone={row.bucket === "urgent" ? "late" : row.bucket === "today" ? "wait" : row.bucket === "tomorrow" ? "progress" : "gray"}>{BUCKETS[row.bucket].emoji} {BUCKETS[row.bucket].label}{row.overdueDays ? ` · ${row.overdueDays}일 지남` : ""}</StatusBadge>
        {row.shipRequested && <StatusBadge tone="purple">출고요청 · 선반에서 꺼냄</StatusBadge>}
        {row.payBlocked && <StatusBadge tone="late">미입금</StatusBadge>}
        {row.fabricMissing && <StatusBadge tone="late">원단 없음</StatusBadge>}
        {row.mergeRepack && <StatusBadge tone="wait">합배송 일부만 포장됨</StatusBadge>}
        {row.editedAfterPack && <StatusBadge tone="late">⚠ 포장 후 수정됨</StatusBadge>}
        {row.allPacked && !row.editedAfterPack && <StatusBadge tone="done">포장완료</StatusBadge>}
        {row.holdPending && <StatusBadge tone="purple">보관 요청</StatusBadge>}
      </div>
      <div className="pk-items">
        {row.orders.flatMap(o => (o.items || []).map((it, i) => {
          const st = itemPackState(o, i, packingByOrder);
          return (
            <div key={`${o.id}:${i}`} className="pk-item">
              <div className="main"><strong>{itemLine(it)}</strong><small>{qtyLine(it)}{it.itemNo ? ` · ${it.itemNo}` : ""}{row.merged ? ` · ${o.customer}` : ""}</small></div>
              <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
            </div>
          );
        }))}
      </div>
    </button>
  );
}

export default function PackPage() {
  const { userId, orders, rolls, productById, managers, activeManager, isAdmin, isPacker, reloadOrders, loaded } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();

  const [tab, setTab] = useState("today");
  const [q, setQ] = useState("");
  const [activeKey, setActiveKey] = useState(null);
  const [flashKey, setFlashKey] = useState(null);
  const [recs, setRecs] = useState([]);
  const [packReady, setPackReady] = useState(null);   // null 로딩 · true · false(order_item_packing 없음)
  const [banner, setBanner] = useState(null);         // { message, hint, tone, id }
  const [modal, setModal] = useState(null);           // cut · choose · pick · override · unpack
  const [pending, setPending] = useState(null);       // 라벨 QR 뒤 롤 QR 을 기다리는 품목
  const [busy, setBusy] = useState(false);
  const [scanShown, setScanShown] = useState("");
  const [tick, setTick] = useState(() => Date.now());

  const packingByOrder = useMemo(() => indexPacking(recs), [recs]);
  const today = useMemo(() => new Date(tick), [tick]);
  const rows = useMemo(() => buildBoxes(orders, packingByOrder, { today, sigOf: db.itemsSig }), [orders, packingByOrder, today]);
  const split = useMemo(() => splitBoxes(rows), [rows]);
  const metrics = useMemo(() => packMetrics(split, today), [split, today]);
  const tabRows = tab === "done" ? split.done : tab === "hold" ? split.hold : split.queue[tab];
  const shownRows = useMemo(() => filterBoxes(tabRows, q), [tabRows, q]);
  const activeRow = useMemo(() => (activeKey ? rows.find(r => r.key === activeKey) || null : null), [rows, activeKey]);
  // 스캔 범위 — 완료·보관 탭을 보고 있으면 대기 전체에서 찾는다(그 탭의 박스는 찍을 대상이 아니다). 활성 박스도 대기 중일 때만.
  const scanScope = QUEUE_TABS.includes(tab) ? split.queue[tab] : split.queueAll;
  const scanActiveRow = activeRow && !activeRow.allPacked && !activeRow.held && !activeRow.parked ? activeRow : null;
  const ctx = useMemo(() => ({ orders, managers, activeManager, isAdmin, isPacker }), [orders, managers, activeManager, isAdmin, isPacker]);

  // ── 포장 기록 읽기 — 출고 전 주문 전부. 실시간 구독 + 30초마다 + 기록 뒤. ──
  const idsKey = useMemo(() => orders.filter(o => o.status !== "출고완료").map(o => o.id).join(","), [orders]);
  const reloadPacking = useCallback(async () => {
    if (!idsKey) { setRecs([]); setPackReady(true); return; }
    try { setRecs(await db.fetchItemPacking(idsKey.split(","))); setPackReady(true); }
    catch (e) {
      console.warn("[포장대] 포장 기록 읽기 실패", e);
      if (["42P01", "PGRST205"].includes(e?.code)) setPackReady(false);
    }
  }, [idsKey]);
  useEffect(() => { reloadPacking(); }, [reloadPacking]);
  useRealtimeItemPacking(userId, { onAny: reloadPacking });
  useEffect(() => { const t = setInterval(() => { reloadPacking(); setTick(Date.now()); }, 30000); return () => clearInterval(t); }, [reloadPacking]);

  // ── 배너 ──
  const bannerTimer = useRef(0);
  const showBanner = useCallback((message, hint = "", tone = "reject") => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBanner({ message, hint, tone, id: Date.now() });
    bannerTimer.current = setTimeout(() => { bannerTimer.current = 0; setBanner(null); }, BANNER_MS);
  }, []);
  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // ── 라벨 QR 뒤 롤을 기다리는 품목 — 2분 지나면 조용히 풀린다 ──
  const pendingTimer = useRef(0);
  const clearPending = useCallback(() => { if (pendingTimer.current) clearTimeout(pendingTimer.current); pendingTimer.current = 0; setPending(null); }, []);
  const keepPending = useCallback((p) => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    setPending(p);
    pendingTimer.current = setTimeout(() => { pendingTimer.current = 0; setPending(null); }, pack.PENDING_MS);
  }, []);
  useEffect(() => () => { if (pendingTimer.current) clearTimeout(pendingTimer.current); }, []);

  // ── 박스로 화면 옮기기 — 탭을 바꾸고 카드로 스크롤, 잠깐 초록 테두리 ──
  const flashTimer = useRef(0);
  const reveal = useCallback((key, { activate = true } = {}) => {
    if (!key) return;
    if (activate) setActiveKey(key);
    const where = QUEUE_TABS.find(k => split.queue[k].some(r => r.key === key)) || (split.done.some(r => r.key === key) ? "done" : split.hold.some(r => r.key === key) ? "hold" : null);
    if (where) setTab(where);
    setTimeout(() => {
      document.getElementById(`pk-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashKey(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => { flashTimer.current = 0; setFlashKey(null); }, 2500);
    }, 60);
  }, [split]);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // ── 기록 ──
  const doPack = useCallback(async (candidate, roll, len, whole) => {
    setBusy(true);
    try {
      const r = await pack.packFromRoll(candidate, roll, len, whole, { activeManager, packingByOrder, reloadOrders });
      await reloadPacking();
      setModal(null); clearPending();
      toast(r.msg);
      showBanner(r.msg, "", "ok");
      reveal(candidate.row?.key);
    } catch (e) { toast(pack.errText(e), "error"); showBanner(pack.errText(e)); beep(); }
    finally { setBusy(false); }
  }, [activeManager, packingByOrder, reloadOrders, reloadPacking, clearPending, toast, showBanner, reveal]);

  /** 판정 결과 → 화면 동작 */
  const applyDecision = useCallback((res) => {
    if (!res) return;
    if (res.kind === "reject") { showBanner(res.message, res.hint); beep(); if (res.revealKey) reveal(res.revealKey, { activate: false }); return; }
    if (res.kind === "pending") { keepPending(res.pending); setActiveKey(res.pending.candidate.row.key); reveal(res.pending.candidate.row.key); showBanner(res.message, res.hint, "info"); beep("ask"); return; }
    if (res.kind === "auto") { clearPending(); doPack(res.candidate, res.roll, res.len, res.whole); return; }
    if (res.kind === "confirm") { clearPending(); showBanner(`확인이 필요합니다 — ${res.reason}`, "", "warn"); setModal({ type: "cut", roll: res.roll, product: res.product, candidate: res.candidate, reason: res.reason, cutLen: res.defaultLen, whole: res.defaultWhole }); return; }
    if (res.kind === "choose") { setBanner(null); setModal({ type: "choose", roll: res.roll, product: res.product, candidates: res.candidates }); }
  }, [showBanner, reveal, keepPending, clearPending, doPack]);

  const handleScan = useCallback(async (raw) => {
    const s = String(raw || "").trim();
    if (!s) return;
    if (busy) { showBanner(`처리 중이라 ${s} 은(는) 받지 못했습니다 — 잠시 뒤 다시 찍어 주세요`); beep(); return; }
    if (modal) { showBanner("열린 창을 먼저 닫아 주세요", "창을 닫고 다시 찍으면 됩니다"); beep(); return; }
    setBusy(true);
    try {
      const res = await pack.decideScan(s, { rows, visibleRows: scanScope, activeRow: scanActiveRow, packingByOrder, productById, rolls, pending });
      setBusy(false);
      applyDecision(res);
    } catch (e) { setBusy(false); showBanner("스캔 처리 실패: " + pack.errText(e)); beep(); }
  }, [busy, modal, rows, scanScope, scanActiveRow, packingByOrder, productById, rolls, pending, showBanner, applyDecision]);
  const scanRef = useRef(null);
  const handlerRef = useRef(handleScan);
  handlerRef.current = handleScan;

  // ── 전역 키 수집 — 스캐너가 치는 글자를 어디서나 받는다 ──
  useEffect(() => {
    const b = { s: "", at: 0, enterAt: 0, lastCode: "", lastAt: 0, lastIme: false };
    const onKeyDown = (e) => {
      const t = e.target;
      const inScan = t === scanRef.current;
      if (isEditable(t) && !inScan) return;           // 검색·사유 칸에 치는 중 — 건드리지 않는다
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = Date.now();
      if (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") {
        const typed = b.s; const fromBox = inScan ? String(scanRef.current?.value || "") : "";
        if (!typed && !fromBox) return;              // 버튼 위의 Enter 는 버튼 것
        e.preventDefault();
        b.s = ""; b.lastCode = ""; b.enterAt = now;
        setScanShown("");
        if (scanRef.current) scanRef.current.value = "";
        handlerRef.current(typed || fromBox);
        return;
      }
      const ch = charFromKey(e);
      if (ch === null) {
        if (e.key === "Backspace" && (inScan || b.s)) { b.s = b.s.slice(0, -1); setScanShown(b.s); if (scanRef.current) scanRef.current.value = b.s; e.preventDefault(); }
        return;
      }
      if (now - b.at > 1500) b.s = "";                 // 사람이 느리게 치다 만 것은 버린다
      // 한글 입력기가 같은 키를 60ms 안에 두 번 알리면(조합 끝 신호) 한 번만 센다
      const ime = e.keyCode === 229 || e.key === "Process" || e.key === "Unidentified" || !!e.isComposing;
      const dup = b.lastCode === e.code && now - b.lastAt < 60 && (ime || b.lastIme);
      if (!dup) b.s += ch;
      b.lastCode = e.code; b.lastAt = now; b.lastIme = ime; b.at = now;
      setScanShown(b.s);
      if (scanRef.current) scanRef.current.value = b.s;   // 커서가 어디 있든 스캔칸에 보인다
      e.preventDefault();
    };
    // 화면 키보드의 Enter 는 keydown 이 229 로 와서 위에서 못 잡는다 — keyup 에서 받되 방금 처리한 것은 건너뛴다
    const onKeyUp = (e) => {
      if (e.target !== scanRef.current) return;
      if ((e.key === "Enter" || e.keyCode === 13) && Date.now() - b.enterAt > 300) {
        const v = String(scanRef.current?.value || "").trim();
        if (!v) return;
        scanRef.current.value = ""; setScanShown("");
        handlerRef.current(v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("keyup", onKeyUp); };
  }, []);
  const submitScanBox = () => { const v = String(scanRef.current?.value || scanShown || "").trim(); if (scanRef.current) scanRef.current.value = ""; setScanShown(""); handleScan(v); };

  // ── 박스 동작 ──
  const run = async (fn) => {
    setBusy(true);
    try { const r = await fn(); if (r?.msg) toast(r.msg); await reloadOrders(); await reloadPacking(); }
    catch (e) { toast(pack.errText(e), "error"); }
    finally { setBusy(false); }
  };
  const markPacked = async (row) => {
    if (row.scanTotal > 0 && row.scanDone < row.scanTotal) {
      const ok = await confirm(`아직 찍지 않은 품목이 ${row.scanTotal - row.scanDone}개 있습니다.\n\n그래도 ${boxTitle(row)} 을(를) 포장완료로 확정할까요?`, { title: "포장완료", confirmLabel: "포장완료" });
      if (!ok) return;
    } else if (row.scanTotal === 0) {
      const ok = await confirm(`${boxTitle(row)} — 롤 기록 없이 포장완료로 확정합니다.`, { title: "포장완료", confirmLabel: "포장완료" });
      if (!ok) return;
    }
    await run(() => pack.markBoxPacked(row, ctx));
    setActiveKey(null);
  };
  const unmarkPacked = async (row) => {
    const ok = await confirm(`${boxTitle(row)} 의 포장완료를 취소하고 접수로 돌립니다.\n품목별 롤 기록은 그대로 남습니다 — 다시 찍을 필요 없이 포장완료만 다시 누르면 됩니다.`, { title: "포장완료 취소", confirmLabel: "접수로 되돌림", danger: true });
    if (!ok) return;
    await run(() => pack.unmarkBoxPacked(row, ctx));
  };
  const holdConfirm = async (row) => {
    const ok = await confirm(`${boxTitle(row)} 의 원단을 창고에 넣었습니까?\n보관중으로 바뀌고 포장 목록에서 빠집니다.`, { title: "보관 확정", confirmLabel: "창고에 넣음" });
    if (!ok) return;
    await run(() => pack.confirmHold(row));
    setActiveKey(null);
  };
  const toggleFabric = (order, itemIdx) => run(() => pack.toggleFabric(order, itemIdx, { productById }));

  const openPickRoll = (row, order, item, itemIdx) => {
    const candidate = { row, order, item, itemIdx };
    const c = pack.rollChoices(item, productById, rolls);
    if (!c) { toast("품번이 연결되지 않은 품목입니다 — 롤 QR 을 찍거나 '롤 없이 포장'으로 기록해 주세요", "error"); return; }
    setModal({ type: "pick", candidate, product: c.product, rolls: c.rolls });
  };
  const pickRoll = (roll) => { const m = modal; setModal(null); applyDecision(pack.planCut(roll, m.product, m.candidate)); };
  const submitCut = async () => {
    const m = modal; if (!m || m.type !== "cut") return;
    const v = pack.validateCut(m.cutLen, m.whole, m.roll);
    if (!v.ok) { toast(v.reason, "error"); return; }
    await doPack(m.candidate, m.roll, v.len, m.whole);
  };
  const submitOverride = async () => {
    const m = modal; if (!m || m.type !== "override") return;
    setBusy(true);
    try {
      const r = await pack.packWithoutRoll(m.candidate, m.reason, { activeManager, packingByOrder, reloadOrders });
      await reloadPacking(); setModal(null); clearPending(); toast(r.msg); reveal(m.candidate.row?.key);
    } catch (e) { toast(pack.errText(e), "error"); }
    finally { setBusy(false); }
  };
  const submitUnpack = async (asPiece) => {
    const m = modal; if (!m || m.type !== "unpack") return;
    setBusy(true);
    try {
      const r = await pack.unpackItem(m.order, m.item, { asPiece, reason: m.reason }, { activeManager });
      await reloadPacking(); setModal(null); toast(r.msg);
    } catch (e) { toast(pack.errText(e), "error"); }
    finally { setBusy(false); }
  };

  // ── 상세 패널 ──
  const detail = activeRow;
  const detailAllDone = detail ? allItemsPacked(detail, packingByOrder) : false;
  const renderDetail = () => {
    if (!detail) return (
      <Panel title="박스 상세">
        <Empty small>왼쪽 목록에서 박스를 누르거나, 롤 QR 을 찍으면 그 박스가 열립니다.{"\n"}박스를 고르면 다음 스캔은 그 박스에서만 품목을 찾습니다.</Empty>
      </Panel>
    );
    const inQueue = !detail.allPacked && !detail.holdPending;
    const memos = [...new Set(detail.orders.flatMap(o => [o.memo, o.deliveryMessage].map(s => String(s || "").trim())).filter(Boolean))];
    return (
      <Panel>
        <div className="pk-dhead">
          <h2>{boxTitle(detail)}</h2>
          {detail.merged && <StatusBadge tone="progress">합배송 {detail.orders.length}건</StatusBadge>}
          {detail.editedAfterPack && <StatusBadge tone="late">⚠ 포장 후 수정됨 — 박스를 다시 확인</StatusBadge>}
          <div className="meta">{BUCKETS[detail.bucket].emoji} {BUCKETS[detail.bucket].label}{detail.orders[0]?.shipDate ? ` · 출고예정 ${detail.orders[0].shipDate}` : ""}{detail.orders[0]?.address ? ` · ${detail.orders[0].address}` : ""}</div>
        </div>
        {memos.length > 0 && <div className="pk-memo">{memos.join("\n")}</div>}
        {detail.orders.map(o => (
          <div key={o.id} className="pk-order">
            <div className="pk-order-head"><span>{o.customer}</span><span className="mono">#{shortId(o.id)}</span><span>{o.manager || ""}</span>{o.status === "포장완료" && <StatusBadge tone="done">포장완료</StatusBadge>}</div>
            {(o.items || []).map((it, i) => {
              const st = itemPackState(o, i, packingByOrder);
              const candidate = { row: detail, order: o, item: it, itemIdx: i };
              const missing = missingItemIdx(o).includes(i);
              return (
                <div key={`${o.id}:${i}`} className="pk-ditem">
                  <div className="top"><strong>{itemLine(it)}</strong><span className="qty">{qtyLine(it)}</span></div>
                  <div className="state">
                    <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                    {it.itemNo && <small className="mono">{it.itemNo}</small>}
                    {st.rec?.packedBy && <small>{st.rec.packedBy} · {new Date(st.rec.packedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</small>}
                  </div>
                  {packReady !== false && it.itemId && (
                    <div className="acts">
                      {st.rec ? (
                        <Button kind="white" size="sm" icon="undo" disabled={busy} onClick={() => setModal({ type: "unpack", order: o, item: it, rec: st.rec, reason: "" })}>포장 취소</Button>
                      ) : (
                        <>
                          <Button kind="white" size="sm" icon="layers" disabled={busy} onClick={() => openPickRoll(detail, o, it, i)}>롤 고르기</Button>
                          <Button kind="white" size="sm" icon="edit" disabled={busy} onClick={() => setModal({ type: "override", candidate, reason: "" })}>롤 없이 포장</Button>
                          <Chip on={missing} danger disabled={busy} onClick={() => toggleFabric(o, i)} title="원단이 안 왔을 때 담당자에게 알립니다">{missing ? "원단 없음 해제" : "원단 없음"}</Chip>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {inQueue && detailAllDone && <div className="pk-alldone">{pack.ALL_DONE_HINT}</div>}
        <div className="pk-dfoot">
          {inQueue && <Button icon="box" loading={busy} onClick={() => markPacked(detail)}>{detail.mergeRepack ? "합쳐서 포장완료" : "포장완료"}{detail.scanTotal ? ` (${detail.scanDone}/${detail.scanTotal})` : ""}</Button>}
          {detail.allPacked && !detail.holdPending && <Button kind="danger" icon="undo" loading={busy} onClick={() => unmarkPacked(detail)}>포장 취소 (접수로)</Button>}
          {detail.holdPending && <Button kind="green" icon="archive" loading={busy} onClick={() => holdConfirm(detail)}>창고에 넣음 (보관 확정)</Button>}
          <Button kind="white" onClick={() => setActiveKey(null)}>선택 해제</Button>
        </div>
      </Panel>
    );
  };

  // ── 모달 ──
  const renderModal = () => {
    if (!modal) return null;
    const m = modal;
    const close = () => setModal(null);
    if (m.type === "cut") {
      const it = m.candidate.item;
      return (
        <Modal title="재단 확인" onClose={close}>
          <p className="helptext warn">{m.reason}</p>
          <div className="pk-roll-info">
            <div>롤 <b>{m.roll.rollCode}</b> · 잔량 {fmtLen(m.roll.lengthRemaining)}{it.unit || "마"}{m.roll.origin ? ` · ${PIECE_ORIGIN[m.roll.origin] || "조각"}` : ""}</div>
            <div>{m.candidate.order.customer} · {itemLine(it)} · 주문 {qtyLine(it)}</div>
          </div>
          <label className="pk-check"><input type="checkbox" checked={!!m.whole} onChange={e => setModal({ ...m, whole: e.target.checked })} /> 롤 통째로 (잔량 전부)</label>
          {!m.whole && (
            <>
              <label className="formlabel" htmlFor="pk-cut">자를 길이 ({it.unit || "마"})</label>
              <input id="pk-cut" className="forminput" inputMode="decimal" value={m.cutLen} onChange={e => setModal({ ...m, cutLen: e.target.value })} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submitCut(); } }} />
            </>
          )}
          <div className="btnrow" style={{ marginTop: 18 }}>
            <Button kind="white" onClick={close}>취소</Button>
            <Button icon="check" loading={busy} onClick={submitCut}>기록</Button>
          </div>
        </Modal>
      );
    }
    if (m.type === "choose") {
      return (
        <Modal title="어느 품목입니까?" onClose={close}>
          <p className="helptext">롤 <b className="mono">{m.roll.rollCode}</b> ({m.product?.code} {m.product?.name}) 을 기다리는 품목이 여럿입니다. 지금 싸는 박스의 것을 고르세요.</p>
          <div className="pk-pick">
            {m.candidates.map((c, i) => (
              <button key={i} type="button" onClick={() => { close(); setActiveKey(c.row.key); applyDecision(pack.planCut(m.roll, m.product, c)); }}>
                <span><span className="code">{c.order.customer}</span> <span className="sub">#{shortId(c.order.id)} · {BUCKETS[c.row.bucket]?.label}</span><br /><span className="sub">{itemLine(c.item)}</span></span>
                <span className="len">{qtyLine(c.item)}</span>
              </button>
            ))}
          </div>
          <div className="btnrow"><Button kind="white" onClick={close}>취소</Button></div>
        </Modal>
      );
    }
    if (m.type === "pick") {
      const it = m.candidate.item;
      return (
        <Modal title="롤 고르기" onClose={close}>
          <p className="helptext">{m.candidate.order.customer} · {itemLine(it)} {qtyLine(it)} — {m.product.code} {m.product.name}{m.product.color ? ` ${m.product.color}` : ""}. 자른 롤을 고르면 주문 수량대로 기록합니다.</p>
          {m.rolls.length === 0 ? <Empty small>진행 중인 롤이 없습니다. 롤 QR 을 찍거나 '롤 없이 포장'으로 기록해 주세요.</Empty> : (
            <div className="pk-pick">
              {m.rolls.map(r => (
                <button key={r.id} type="button" onClick={() => pickRoll(r)}>
                  <span><span className="code">{r.rollCode}</span>{r.origin ? <span className="sub"> · {PIECE_ORIGIN[r.origin] || "조각"}</span> : null}<br /><span className="sub">{ROLL_STATUS_LABEL[r.status] || r.status}{r.location ? ` · ${r.location}` : ""}</span></span>
                  <span className="len">{fmtLen(r.lengthRemaining)}{m.product.unit || "마"}</span>
                </button>
              ))}
            </div>
          )}
          <div className="btnrow"><Button kind="white" onClick={close}>취소</Button></div>
        </Modal>
      );
    }
    if (m.type === "override") {
      const it = m.candidate.item;
      return (
        <Modal title="롤 없이 포장" onClose={close}>
          <p className="helptext">{m.candidate.order.customer} · {itemLine(it)} {qtyLine(it)} — 롤을 안 찍고 기록합니다(옛 재고·외주·급한 건). 재고는 줄지 않습니다.</p>
          <label className="formlabel" htmlFor="pk-why">사유</label>
          <input id="pk-why" className="forminput" value={m.reason} onChange={e => setModal({ ...m, reason: e.target.value })} placeholder="예: 옛 재고 · 외주 원단" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submitOverride(); } }} />
          <div className="btnrow" style={{ marginTop: 18 }}>
            <Button kind="white" onClick={close}>취소</Button>
            <Button icon="check" loading={busy} onClick={submitOverride} disabled={!String(m.reason || "").trim()}>기록</Button>
          </div>
        </Modal>
      );
    }
    if (m.type === "unpack") {
      const hasRoll = !!m.rec?.rollId;
      return (
        <Modal title="포장 취소" onClose={close}>
          <p className="helptext">{m.order.customer} · {itemLine(m.item)} — {hasRoll ? `${m.rec.rollCode} 에서 ${m.rec.wholeRoll ? "롤 통째" : `${fmtLen(m.rec.length)}${m.item.unit || "마"}`}` : `롤 없이 · ${m.rec?.overrideReason || ""}`}</p>
          {hasRoll ? (
            <>
              <p className="helptext warn">잘라 낸 원단은 원래 롤로 못 돌아갑니다. 실제로 잘랐는지에 따라 고르세요.</p>
              <label className="formlabel" htmlFor="pk-unwhy">사유<span className="opt">이미 잘랐을 때 필수 — 조각 롤에 남습니다</span></label>
              <input id="pk-unwhy" className="forminput" value={m.reason} onChange={e => setModal({ ...m, reason: e.target.value })} placeholder="예: 잘못 찍음 · 주문 취소" />
              <div className="pk-unpack-choice">
                <Button kind="white" icon="undo" loading={busy} onClick={() => submitUnpack(false)}>아직 안 잘랐어요 — 롤에 길이를 되돌립니다</Button>
                <Button kind="danger" icon="layers" loading={busy} onClick={() => submitUnpack(true)} disabled={!String(m.reason || "").trim()}>이미 잘랐어요 — 조각 롤로 다시 입고합니다</Button>
              </div>
            </>
          ) : (
            <div className="btnrow" style={{ marginTop: 18 }}>
              <Button kind="white" onClick={close}>닫기</Button>
              <Button kind="danger" icon="trash" loading={busy} onClick={() => submitUnpack(false)}>기록 삭제</Button>
            </div>
          )}
        </Modal>
      );
    }
    return null;
  };

  return (
    <>
      <PageHead eyebrow="PACKING" title="포장대" subtitle="롤 QR 을 찍어 재단을 기록하고, 다 쌌으면 포장완료를 눌러 확정합니다." />
      <div className="stats">
        <StatCard title="오늘 포장할 박스" value={metrics.boxesToday} unit="박스" icon="box" note={`대기 전체 ${metrics.boxesAll}박스 · 오늘 완료 ${metrics.doneToday}`} noteTone="muted" onClick={() => setTab("today")} loading={!loaded} />
        <StatCard title="찍은 품목" value={metrics.itemsTotal ? `${metrics.itemsDone}/${metrics.itemsTotal}` : "0/0"} icon="check" tone="mint" note="대기 박스의 롤 기록" noteTone="muted" loading={!loaded} />
        <StatCard title="보관 요청" value={metrics.holdRequests} unit="건" icon="archive" tone="purple" note="창고에 넣고 확정" noteTone="muted" onClick={() => setTab("hold")} loading={!loaded} />
        <StatCard title="원단 없음" value={metrics.fabricMissing} unit="박스" icon="alert" tone="orange" note={metrics.editedAfterPack ? `포장 후 수정 ${metrics.editedAfterPack}건` : "담당자 호출 중"} noteTone={metrics.editedAfterPack ? "alert" : "muted"} loading={!loaded} />
      </div>

      <div className={`pk-scan${busy ? " busy" : ""}`}>
        <Icon name="search" />
        <input ref={scanRef} defaultValue="" placeholder={pending ? `${pending.candidate.order.customer} · ${itemLine(pending.candidate.item)} — 롤 QR 을 찍어 주세요` : "롤 QR · 주문 라벨 QR 을 찍거나 롤 번호를 치고 Enter"} aria-label="스캔 입력" autoComplete="off" autoCapitalize="characters" spellCheck={false}
          onChange={e => setScanShown(e.target.value)} />
        {scanShown && <span className="mono" style={{ color: "#8d9bab", fontSize: 13 }}>{scanShown.length}자</span>}
        {pending ? <Button kind="white" size="sm" onClick={clearPending}>대기 취소</Button> : null}
        <Button size="sm" icon="check" onClick={submitScanBox} loading={busy}>입력</Button>
      </div>
      <p className="pk-scan-hint">
        {packReady === false ? <span className="helptext err" style={{ display: "inline-block", margin: 0 }}>롤 스캔 DB(order_item_packing)가 아직 없습니다 — migrations/add_item_packing.sql 을 먼저 실행해 주세요. 그전까지는 포장완료만 누릅니다.</span>
          : scanActiveRow ? <>다음 스캔은 <b>{boxTitle(scanActiveRow)}</b> 박스에서만 품목을 찾습니다.</>
          : <>박스를 고르지 않으면 이 탭의 모든 박스에서 품목을 찾습니다. 찍은 롤은 그 자리에서 잔량이 빠집니다.</>}
      </p>

      {banner && (
        <div className={`pk-banner ${banner.tone}`} role="alert" key={banner.id}>
          <Icon name={banner.tone === "reject" ? "alert" : banner.tone === "ok" ? "check" : "bell"} />
          <div>{banner.message}{banner.hint ? <small>{banner.hint}</small> : null}</div>
          <button className="x" onClick={() => setBanner(null)} aria-label="닫기">×</button>
        </div>
      )}

      <div className="pk-tabs" role="tablist">
        {TABS.map(([k, label]) => {
          const n = k === "done" ? split.done.length : k === "hold" ? split.hold.length : split.queue[k].length;
          return <button key={k} role="tab" aria-selected={tab === k} className={`pk-tab${tab === k ? " active" : ""}${k === "urgent" && n ? " hot" : ""}`} onClick={() => setTab(k)}>{label}<span className="n">{n}</span></button>;
        })}
        <div style={{ marginLeft: "auto", minWidth: 220, flex: "1 1 220px" }}><SearchInput value={q} onChange={setQ} placeholder="고객 · 원단 · 품번 검색" id="pk-search" /></div>
      </div>

      <div className="pk-layout">
        <div>
          {!loaded ? <LoadingLine /> : shownRows.length === 0 ? (
            <Panel><Empty>{tab === "done" ? "포장완료된 박스가 없습니다." : tab === "hold" ? "보관 요청이 없습니다." : q ? "검색 결과가 없습니다." : `${BUCKETS[tab].label} 칸에 포장할 박스가 없습니다.`}</Empty></Panel>
          ) : (
            <div className="pk-list">
              {shownRows.map(r => <BoxCard key={r.key} row={r} active={activeKey === r.key} flash={flashKey === r.key} packingByOrder={packingByOrder} onSelect={(row) => setActiveKey(k => k === row.key ? null : row.key)} />)}
            </div>
          )}
        </div>
        <div className="pk-detail">{renderDetail()}</div>
      </div>

      {renderModal()}
      {host}
    </>
  );
}
