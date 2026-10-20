// 채널 주문 가져오기(/app/orders/import) — 쿠팡 윙·스마트스토어 "오늘 주문" 엑셀을 고정 컬럼 매핑으로 읽어 새 주문만 등록한다(AI 없음, 덮어쓰기 없음).
//   파일 선택 → 양식 자동 감지(바꿀 수 있음) → 매핑 확인 → 미리보기(행마다 체크, 문제 행 빨강, 이미 등록은 체크 해제) → n건 등록
// 등록: db.fetchChannelOrderIds 로 한 번 더 거르고 insertOrder(salesChannel·channelOrderId·접수·담당자·출고예정일) + 결제 완료면 addPaymentLog.
// 고객은 insertCustomerIfNew 로만 보강(기존 고객은 손대지 않는다). 포장 담당(isPacker)은 쓸 수 없다.
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { Button, Segment, Empty, StatusBadge, Chip, won } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { defaultShipDate } from "../../lib/shipDate.js";
import { FIELDS, PRESETS, PRESET_KEYS, headerRowIndex, detectPreset, autoMap, mapRows, dedupe, toErpOrder } from "../lib/channelImport.js";
import "../saas-data.css";

const isEmptyRow = (r) => !r || r.every(c => c === null || c === undefined || String(c).trim() === "");

export default function ChannelImport({ onClose }) {
  const { activeManager, isPacker, reloadOrders, reloadCustomers } = useSaas();
  const toast = useToast();
  const [file, setFile] = useState(null);           // { name, headers, rows }
  const [preset, setPreset] = useState("generic");
  const [mapping, setMapping] = useState({});
  const [step, setStep] = useState("file");          // file | map | preview
  const [checked, setChecked] = useState(new Set());  // 등록할 주문 index
  const [existing, setExisting] = useState(null);    // 이미 들어온 채널 주문번호 Set
  const [paid, setPaid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const readFile = async (f) => {
    if (!f) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
      const hi = headerRowIndex(aoa);
      const headers = (aoa[hi] || []).map(h => String(h ?? "").trim());
      const rows = aoa.slice(hi + 1).filter(r => !isEmptyRow(r));
      if (!headers.filter(Boolean).length || !rows.length) { toast("읽을 행이 없습니다 — 첫 시트에 헤더와 주문 행이 있어야 합니다", "error"); return; }
      const p = detectPreset(headers);
      setFile({ name: f.name, headers, rows });
      setPreset(p); setMapping(autoMap(headers, p));
      setStep("map");
      toast(`${PRESETS[p].label.split(" (")[0]} 양식 · ${rows.length}행${hi > 0 ? ` (앞 ${hi}행 안내문 건너뜀)` : ""}`);
    } catch (e) { toast("파일 읽기 실패: " + (e.message || e), "error"); }
  };
  const changePreset = (p) => { setPreset(p); if (file) setMapping(autoMap(file.headers, p)); };

  const parsed = useMemo(() => file ? mapRows(file.headers, file.rows, preset, mapping) : null, [file, preset, mapping]);
  const orders = parsed?.orders || [];
  const channel = PRESETS[preset]?.channel || "자사몰";

  // 미리보기로 넘어오면 이미 들어온 주문번호를 묻고, 문제 없는 새 주문만 체크해 둔다
  useEffect(() => {
    if (step !== "preview" || !parsed) return;
    let alive = true;
    setExisting(null);
    db.fetchChannelOrderIds(channel, orders.map(o => o.channelOrderId)).then(set => {
      if (!alive) return;
      setExisting(set);
      const { fresh } = dedupe(orders, set);
      const freshIds = new Set(fresh.map(o => o.channelOrderId));
      setChecked(new Set(orders.map((o, i) => [o, i]).filter(([o]) => o.problems.length === 0 && o.channelOrderId && freshIds.has(o.channelOrderId)).map(([, i]) => i)));
    }).catch(e => { if (alive) { setExisting(new Set()); toast("기존 주문 확인 실패: " + e.message, "error"); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const existsOf = (o) => !!(existing && o.channelOrderId && existing.has(String(o.channelOrderId)));
  const dupInFile = useMemo(() => { const seen = new Set(), dup = new Set(); for (const o of orders) { if (!o.channelOrderId) continue; if (seen.has(o.channelOrderId)) dup.add(o.channelOrderId); seen.add(o.channelOrderId); } return dup; }, [orders]);
  const toggle = (i) => setChecked(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const selCount = checked.size;
  const selTotal = [...checked].reduce((s, i) => s + (orders[i]?.totalAmount || 0), 0);

  const register = async () => {
    const targets = [...checked].sort((a, b) => a - b).map(i => orders[i]).filter(Boolean);
    if (!targets.length) { toast("등록할 주문을 골라 주세요", "error"); return; }
    setBusy(true);
    let done = 0, skipped = 0, failed = 0, newCust = 0;
    const errors = [];
    try {
      // 미리보기 뒤에 다른 사람이 같은 파일을 넣었을 수 있다 — 등록 직전에 한 번 더 거른다
      const again = await db.fetchChannelOrderIds(channel, targets.map(o => o.channelOrderId));
      const { fresh, skipped: sk } = dedupe(targets, again);
      skipped = sk.length;
      const shipDate = defaultShipDate();
      for (let i = 0; i < fresh.length; i++) {
        const o = fresh[i];
        setProgress(`${i + 1}/${fresh.length} 등록 중…`);
        try {
          try { const r = await db.insertCustomerIfNew({ name: o.customer, phone: o.phone, address: o.address, note: `${channel} 주문에서 추가` }); if (r.status === "inserted") newCust++; }
          catch (e) { console.warn("[채널 가져오기] 고객 보강 실패", e); }
          const saved = await db.insertOrder(toErpOrder(o, { manager: activeManager, shipDate, paid }), { route: "채널 주문 가져오기" });
          if (!saved) throw new Error("저장 결과가 비어 있습니다");
          if (paid && saved.totalAmount > 0) await db.addPaymentLog(saved.id, "입금", saved.totalAmount, `${channel} 결제 완료 (주문번호 ${o.channelOrderId})`, saved.customer);
          done++;
        } catch (e) {
          // 유일 인덱스(같은 판매처·주문번호)에 걸리면 그 사이 누가 넣은 것 — 건너뛴 것으로 센다
          if (String(e?.code) === "23505" || /orders_channel_order_uq|duplicate key/i.test(String(e?.message))) skipped++;
          else { failed++; errors.push(`${o.channelOrderId} ${o.customer}: ${e.message || e}`); }
        }
      }
    } finally {
      setBusy(false); setProgress("");
    }
    await Promise.all([reloadOrders(), reloadCustomers()]);
    const parts = [`${channel} 주문 ${done}건 등록`];
    if (skipped) parts.push(`이미 있어 건너뜀 ${skipped}건`);
    if (newCust) parts.push(`새 고객 ${newCust}명`);
    if (failed) parts.push(`실패 ${failed}건`);
    toast(parts.join(" · "), failed ? "error" : undefined);
    if (errors.length) console.error("[채널 가져오기] 실패 목록", errors);
    if (!failed) onClose();
    else setStep("preview");
  };

  if (isPacker) return <Modal title="채널 주문 가져오기" onClose={onClose}><Empty>포장 담당은 주문을 가져올 수 없습니다. 담당자를 바꿔 주세요.</Empty></Modal>;

  return (
    <Modal title="채널 주문 가져오기" onClose={onClose} width="xwide">
      <p className="helptext" style={{ marginTop: 0 }}>쿠팡 윙·스마트스토어에서 내려받은 주문 엑셀을 그대로 올리면 됩니다. 같은 판매처의 같은 주문번호는 두 번 들어가지 않고, 기존 주문은 바꾸지 않습니다.</p>

      {step === "file" && (
        <label className="ci-drop">
          <Icon name="file" size={34} />
          <strong>엑셀 파일 선택</strong>
          <small>.xlsx · .xls · .csv — 첫 시트의 헤더를 자동으로 읽습니다</small>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={e => { readFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      )}

      {file && step !== "file" && (
        <div className="ci-file"><Icon name="file" /><strong>{file.name}</strong><small style={{ color: "#8b9bb0" }}>{file.rows.length}행 · {file.headers.filter(Boolean).length}열</small><Chip onClick={() => { setFile(null); setStep("file"); setChecked(new Set()); }}>다른 파일</Chip></div>
      )}

      {step === "map" && parsed && (
        <>
          <div className="section-label">양식</div>
          <Segment options={PRESET_KEYS.map(k => [k, PRESETS[k].channel])} value={preset} onChange={changePreset} />
          <p className="helptext">{PRESETS[preset].label} · 판매처는 <b>{channel}</b> 으로 저장됩니다. 자동으로 못 찾은 칸은 아래에서 골라 주세요.</p>
          <div className="ci-map">
            {FIELDS.map(f => (
              <label key={f.k} className={`${f.req ? "req" : ""}${f.req && !mapping[f.k] ? " miss" : ""}`}>
                <span>{f.l}{f.req ? " *" : ""}</span>
                <select className="forminput" value={mapping[f.k] || ""} onChange={e => setMapping(m => ({ ...m, [f.k]: e.target.value }))}>
                  <option value="">— 없음 —</option>
                  {file.headers.filter(Boolean).map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          {parsed.missing.length > 0 && <p className="helptext err">필수 칸을 못 찾았습니다: {parsed.missing.map(f => f.l).join(", ")}</p>}
          <div className="ci-sum"><span>주문 <b>{orders.length}</b>건</span><span>품목 <b>{orders.reduce((s, o) => s + o.items.length, 0)}</b>개</span><span>문제 행 <b>{orders.filter(o => o.problems.length).length}</b>건</span></div>
          <div className="btnrow"><Button kind="white" onClick={onClose}>취소</Button><Button icon="chevron" disabled={parsed.missing.length > 0 || !orders.length} onClick={() => setStep("preview")}>미리보기</Button></div>
        </>
      )}

      {step === "preview" && parsed && (
        <>
          <div className="ci-sum">
            <span>판매처 <b>{channel}</b></span>
            <span>새 주문 <b>{existing ? orders.filter(o => !existsOf(o)).length : "…"}</b>건</span>
            <span>이미 등록 <b>{existing ? orders.filter(existsOf).length : "…"}</b>건</span>
            <span>문제 행 <b>{orders.filter(o => o.problems.length).length}</b>건</span>
            <Chip onClick={() => setChecked(new Set(orders.map((o, i) => [o, i]).filter(([o]) => !existsOf(o) && !dupInFile.has(o.channelOrderId)).map(([, i]) => i)))}>문제 행도 모두 선택</Chip>
            <Chip onClick={() => setChecked(new Set())}>모두 해제</Chip>
          </div>
          <div className="ci-rows">
            {orders.map((o, i) => {
              const ex = existsOf(o);
              const bad = o.problems.length > 0;
              return (
                <label key={i} className={`row-check${bad ? " bad" : ""}${ex ? " dim" : ""}`}>
                  <input type="checkbox" checked={checked.has(i)} disabled={ex || busy} onChange={() => toggle(i)} />
                  <span className="left">
                    <strong>{o.customer || "(수취인 없음)"}{o.phone ? <small style={{ display: "inline", marginLeft: 8, color: "#8b9bb0" }}>{o.phone}</small> : null}</strong>
                    <small>{o.channelOrderId || "주문번호 없음"} · {o.items.map(it => `${it.fabric}${it.color ? ` ${it.color}` : ""} ${it.qty}`).join(", ")}{o.orderedAt ? ` · ${o.orderedAt}` : ""}{o.address ? ` · ${o.address}` : ""}</small>
                    {bad ? <small style={{ color: "#d76964" }}>⚠ {o.problems.join(" · ")}{o.rows.length ? ` (${o.rows.length}행: ${o.rows.slice(0, 5).join(",")}${o.rows.length > 5 ? "…" : ""})` : ""}</small> : null}
                  </span>
                  <span className="amt">{won(o.totalAmount)}</span>
                  {ex ? <StatusBadge tone="gray">이미 등록</StatusBadge> : bad ? <StatusBadge tone="late">확인 필요</StatusBadge> : <StatusBadge tone="done">새 주문</StatusBadge>}
                </label>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
            <label className="ci-toggle"><input type="checkbox" checked={paid} onChange={e => setPaid(e.target.checked)} />결제 완료 주문으로 등록 (입금완료 + 입금 기록)</label>
            <small style={{ color: "#8b9bb0" }}>담당 {activeManager || "없음"} · 출고예정일 {defaultShipDate()}</small>
          </div>
          <div className="btnrow" style={{ marginTop: 14 }}>
            <Button kind="white" onClick={() => setStep("map")} disabled={busy}>매핑으로</Button>
            <Button icon="check" loading={busy} disabled={!selCount || !existing} onClick={register}>{progress || `${selCount}건 등록 (${won(selTotal)})`}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
