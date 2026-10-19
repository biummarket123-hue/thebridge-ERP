// 주문 등록 — 카톡·밴드 글 붙여넣기 → AI 분석 → 폼에 채움 → 고객 매칭 확인 → 등록(지시서 3절 "가장 중요한 차별점").
// 분석·등록 로직은 actions/register.js(옛 OrderInput 의 경로). 여기는 화면만.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { Button, Chip, StatusBadge, won } from "../components/ui.jsx";
import { Icon } from "../icons.jsx";
import { matchCustomer, addressMatches } from "../lib/customerMatch.js";
import { analyzeText, analyzeImage, registerOrder } from "../actions/register.js";
import { defaultShipDate, todayYmd, holidayName } from "../../lib/shipDate.js";
import { autoCourier, COURIER_SHORT, CJ, KD } from "../../lib/courier.js";
import { matchProduct } from "../../lib/rollStock.js";
import { OLD_ERP_PATH } from "../config.js";

const UNIT_OPTS = ["마", "세트", "필", "롤", "kg"];
const RECEIPTS = [[null, "발행 안 함"], ["cash", "현금영수증"], ["business", "지출증빙"], ["tax_invoice", "계산서"]];
const emptyItem = () => ({ itemNo: "", fabric: "", color: "", qty: "", unit: "마", amount: "", unitPrice: "" });

function Field({ label, children, opt, htmlFor }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{opt ? <span className="opt">선택</span> : null}</label>{children}</div>;
}

/** 고객 매칭 확인창 — 옛 CustomerMatchPopup 의 네 가지(phone_changed · maybe · name_list · new) */
function MatchPopup({ match, parsed, onConfirm, onNew, onCancel }) {
  const c = match.match;
  const addrSame = (cust) => parsed.address && (addressMatches(parsed.address, cust.address) || addressMatches(parsed.address, cust.address2));
  const custBox = (cust, hl) => (
    <div className="notice-box" style={{ border: hl ? "1px solid #c9ecdc" : undefined }}>
      <strong style={{ fontSize: 16 }}>{cust.name}</strong>{cust.nickname ? <span style={{ color: "#8d9bab" }}> · {cust.nickname}</span> : null}
      <div style={{ marginTop: 4 }}>{cust.phone || "연락처 없음"}</div>
      {cust.address ? <div>📍 {cust.address}</div> : null}
      {addrSame(cust) ? <StatusBadge tone="done">주소 일치</StatusBadge> : null}
    </div>
  );
  if (match.type === "phone_changed") return (
    <Modal title="전화번호 변경 감지" onClose={onCancel}>
      <p className="helptext"><b>{c.name}</b> 고객의 번호가 다릅니다. 기존 {c.phone || "없음"} → 신규 {parsed.phone || "없음"}</p>
      {custBox(c)}
      <div className="btnrow" style={{ marginTop: 16 }}><Button onClick={() => onConfirm(c, { updatePhone: true })}>번호 업데이트</Button><Button kind="white" onClick={onNew}>신규 등록</Button></div>
      <div style={{ marginTop: 8 }}><Button kind="white" onClick={onCancel}>다른 고객</Button></div>
    </Modal>
  );
  if (match.type === "maybe") return (
    <Modal title="혹시 이 고객인가요?" onClose={onCancel}>
      {custBox(c, addrSame(c))}
      {parsed.address && !addrSame(c) && c.address ? <p className="helptext warn" style={{ margin: "10px 0 0" }}>⚠ 이번 주문 배송지({parsed.address})가 등록 주소와 다릅니다 — 다른 사람일 수 있어요</p> : null}
      <div className="btnrow" style={{ marginTop: 16 }}><Button onClick={() => onConfirm(c)}>맞습니다</Button><Button kind="white" onClick={onNew}>아닙니다 (신규)</Button></div>
    </Modal>
  );
  if (match.type === "name_list") return (
    <Modal title="동명이인 목록" onClose={onCancel}>
      <p className="helptext">이름이 같은 고객이 {match.list.length}명 있습니다.{parsed.address ? ` 이번 주문 배송지: ${parsed.address}` : ""}</p>
      <div className="manager-pick">
        {match.list.map(cust => (
          <button key={cust.id} onClick={() => onConfirm(cust)} className={addrSame(cust) ? "on" : ""}>
            <span style={{ minWidth: 0 }}>{cust.name}{cust.nickname ? ` (${cust.nickname})` : ""}<small style={{ display: "block", color: "#8d9bab", fontWeight: 600 }}>{cust.phone || "연락처 없음"}{cust.address ? ` · ${cust.address}` : ""}</small></span>
            {addrSame(cust) ? <span className="tag" style={{ background: "#e9f8f1", color: "#23986f" }}>주소 일치</span> : null}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 14 }}><Button kind="white" onClick={onNew}>신규 고객 등록</Button></div>
    </Modal>
  );
  return (
    <Modal title="신규 고객입니다" onClose={onCancel}>
      <div className="notice-box">이름: {parsed.customerName || parsed.customer || "—"}{parsed.phone ? <><br />연락처: {parsed.phone}</> : null}{parsed.customerNickname ? <><br />닉네임: {parsed.customerNickname}</> : null}{parsed.address ? <><br />📍 {parsed.address}{parsed.address_detail ? ` ${parsed.address_detail}` : ""}</> : null}</div>
      <div className="btnrow" style={{ marginTop: 16 }}><Button onClick={onNew}>등록 진행</Button><Button kind="white" onClick={onCancel}>취소</Button></div>
    </Modal>
  );
}

export default function NewOrder({ onClose, onRegistered }) {
  const { products, customers, orders, activeManager, setOrders, setCustomers, reloadOrders, reloadCredits, isPacker, groups, config } = useSaas();
  const SHIPPING_FEE = config.shippingFee;
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [txt, setTxt] = useState("");
  const [step, setStep] = useState("paste");   // paste | form
  const [parsing, setParsing] = useState(false);
  const [err, setErr] = useState("");
  const [f, setF] = useState(null);
  const [match, setMatch] = useState(null);
  const [resolved, setResolved] = useState(null);   // 확정 고객
  const [mismatches, setMismatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const rollSummary = useMemo(() => new Map(groups.map(g => [g.product.id, g])), [groups]);

  const fillFrom = (p) => {
    const items = (p.items || []).map(i => ({ ...emptyItem(), ...i, qty: i.qty ?? "", amount: i.amount ?? "", unitPrice: i.unitPrice ?? "" }));
    setF({
      customer: p.customer || p.customerName || "", customerName: p.customerName || "", customerMidPhone: p.customerMidPhone || "", customerNickname: p.customerNickname || "",
      phone: p.phone || "", items: items.length ? items : [emptyItem()], payment: p.payment === "입금완료" ? "입금완료" : "미입금",
      address: p.address || "", address_detail: p.address_detail || "", deliveryMessage: p.deliveryMessage || "", note: p.note || "", memo: "",
      shippingFee: p.shippingFee ?? "", otherCost: 0, totalAmount: p.totalAmount ?? "", combinedPayment: !!p.combinedPayment, combinedShipping: !!p.combinedShipping,
      salesChannel: p.salesChannel || "", receiptType: p.receiptType || null, shipDate: defaultShipDate(), isUrgent: false, courier: "", creditUse: "", links: p.links || [],
      _validation: p._validation || null,
    });
  };

  const analyze = async (source) => {
    const text = typeof source === "string" ? source : txt;
    if (!text.trim()) return;
    setParsing(true); setErr(""); setResolved(null); setMatch(null);
    try {
      const { parsed, mismatches: mm } = await analyzeText(text, products);
      fillFrom(parsed); setMismatches(mm); setStep("form");
      const m = matchCustomer(parsed, customers);
      if (m.type === "confirmed") { setResolved(m.match); toast(`기존 고객 확인: ${m.match.name}`); }
      else setMatch({ ...m, parsed });
    } catch (e) { setErr(e.message || "분석 실패. 다시 시도해주세요."); }
    finally { setParsing(false); }
  };
  const analyzeImg = async (file) => {
    if (!file) return;
    setParsing(true); setErr("");
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
      const { parsed } = await analyzeImage(b64, file.type || "image/jpeg", products);
      fillFrom(parsed); setMismatches([]); setStep("form");
      const m = matchCustomer(parsed, customers);
      if (m.type === "confirmed") { setResolved(m.match); toast(`기존 고객 확인: ${m.match.name}`); } else setMatch({ ...m, parsed });
    } catch (e) { setErr(e.message || "이미지 분석 실패"); }
    finally { setParsing(false); }
  };
  // 붙여넣기 — 붙여넣기 화면에서 Ctrl+V 하면 바로 분석(옛 화면과 같다)
  useEffect(() => {
    if (step !== "paste") return;
    const onPaste = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      const t = e.clipboardData?.getData("text");
      if (t && t.trim()) { setTxt(t); analyze(t); }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, products, customers]);

  const setItem = (i, k, v) => setF(p => ({ ...p, items: p.items.map((it, j) => j === i ? { ...it, [k]: v } : it) }));
  const pickProduct = (i, p) => setItem(i, "_pick", null) || setF(prev => ({ ...prev, items: prev.items.map((it, j) => j === i ? { ...it, itemNo: p.code, productId: p.id, fabric: it.fabric || p.name, color: it.color || p.color || "", unitPrice: it.unitPrice || p.unitPrice || "", amount: it.amount || ((parseFloat(it.qty) || 0) * (p.unitPrice || 0) || ""), _pick: null } : it) }));
  const itemsSum = (f?.items || []).reduce((s, i) => s + (parseInt(i.amount) || 0), 0);
  const calcTotal = itemsSum + (parseInt(f?.shippingFee) || 0) + (parseInt(f?.otherCost) || 0);
  const auto = f ? autoCourier(`${f.note || ""}\n${f.memo || ""}`) : null;
  const nextBiz = defaultShipDate();

  const submit = async () => {
    if (isPacker) { toast("포장 담당자는 주문을 등록할 수 없습니다", "error"); return; }
    if (!activeManager) { toast("담당자를 먼저 골라 주세요", "error"); return; }
    const items = f.items.filter(i => String(i.fabric || "").trim()).map(i => ({ itemNo: i.itemNo || "", productId: i.productId || undefined, fabric: i.fabric.trim(), color: i.color || "", qty: parseFloat(i.qty) || 0, unit: i.unit || "마", amount: parseInt(i.amount) || 0, unitPrice: parseInt(i.unitPrice) || 0 }));
    if (!String(f.customer || "").trim()) { toast("고객명을 적어 주세요", "error"); return; }
    if (!items.length) { toast("품목을 1개 이상 적어 주세요", "error"); return; }
    if (items.some(i => !(i.qty > 0))) { toast("수량이 0인 품목이 있습니다", "error"); return; }
    if (!f.address.trim() && !await confirm("배송지가 비어 있습니다. 그대로 등록할까요? (방문·픽업이면 메모에 적어 주세요)")) return;
    setBusy(true);
    try {
      const data = { ...f, items, shippingFee: parseInt(f.shippingFee) || 0, otherCost: parseInt(f.otherCost) || 0, totalAmount: parseInt(f.totalAmount) || calcTotal, courier: f.courier || null, creditUse: parseInt(f.creditUse) || 0 };
      const r = await registerOrder(data, resolved, { orders, customers, activeManager, confirm, toast });
      if (!r) return;   // 안내창에서 취소
      setOrders(p => r.patches.reduce((acc, fn) => fn(acc), [r.saved, ...p]));
      if (r.customerPatch?.kind === "insert") setCustomers(p => [...p, r.customerPatch.customer]);
      if (r.customerPatch?.kind === "update") setCustomers(p => p.map(c => c.id === r.customerPatch.customer.id ? r.customerPatch.customer : c));
      toast("주문 등록 완료");
      for (const [m, t] of r.messages) setTimeout(() => toast(m, t), 400);
      reloadOrders(); reloadCredits();
      onRegistered?.(r.finalOrder);
    } catch (e) { console.error("[saas] 등록 실패", e); toast("저장 실패: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={step === "paste" ? "새 주문 등록" : "주문 내용 확인"} onClose={onClose} width="xwide">
      {host}
      {step === "paste" ? (
        <>
          <p className="helptext">카톡·밴드 주문 글을 붙여넣으면 AI 가 고객·품목·금액·주소를 읽어 폼에 채웁니다. 이 화면 아무 데서나 <b>Ctrl+V</b> 해도 됩니다.</p>
          <textarea className="forminput" value={txt} onChange={e => setTxt(e.target.value)} placeholder={"예)\n홍길동3914(방방방)\n010-3914-5678\n서울 중구 을지로 123 상가 2층\n린넨코튼 베이지 3마 @5,500\n= 20,500원 (배송비 4,000 포함)\n입금완료"} rows={9} />
          {err && <p className="helptext err">{err}</p>}
          <div className="btnrow" style={{ marginTop: 16 }}>
            <Button icon="sparkle" onClick={() => analyze()} loading={parsing} disabled={!txt.trim()}>AI 분석</Button>
            <Button kind="white" icon="camera" className="narrow" onClick={() => fileRef.current?.click()} loading={parsing}>이미지로 분석</Button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { analyzeImg(e.target.files?.[0]); e.target.value = ""; }} />
            <Button kind="white" className="narrow" onClick={() => { fillFrom({}); setStep("form"); }}>직접 입력</Button>
          </div>
          <div className="link-old">로하톡 메모·링크 주문 초안·이미지 첨부가 필요하면 <a href={OLD_ERP_PATH}>옛 화면(주문입력)</a>을 쓰세요.</div>
        </>
      ) : (
        <>
          <p className="helptext warn">등록하면 실제 운영 DB 에 주문이 저장됩니다. 고객 등록·갱신, 같은 고객 자동 합배송, 적립금 차감이 함께 처리됩니다.</p>
          {f._validation?.status === "auto-corrected" && <p className="helptext warn">{f._validation.message} ({won(f._validation.before)} → {won(f._validation.after)})</p>}
          {f._validation?.status === "mismatch" && <p className="helptext err">{f._validation.message} — 품목 금액과 전체 금액을 확인해 주세요</p>}
          {mismatches.map(m => <p key={m} className="helptext err">{m}</p>)}
          {resolved ? <div className="notice-box" style={{ marginBottom: 6 }}>기존 고객 <b>{resolved.name}</b>{resolved.nickname ? ` (${resolved.nickname})` : ""} · {resolved.phone || "연락처 없음"} <button className="text-link" style={{ display: "inline-flex", padding: "0 6px" }} onClick={() => setResolved(null)}>해제</button></div>
            : <div className="notice-box" style={{ marginBottom: 6 }}>신규 고객으로 등록됩니다(저장 직전에 서버에서 같은 이름·번호를 한 번 더 확인합니다).</div>}
          <div className="formrow">
            <Field label="고객명" htmlFor="no-cust"><input id="no-cust" className="forminput" value={f.customer} onChange={e => setF({ ...f, customer: e.target.value })} /></Field>
            <Field label="연락처" htmlFor="no-phone"><input id="no-phone" className="forminput" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="닉네임" opt><input className="forminput" value={f.customerNickname} onChange={e => setF({ ...f, customerNickname: e.target.value })} /></Field>
            <Field label="판매처" opt><input className="forminput" value={f.salesChannel} onChange={e => setF({ ...f, salesChannel: e.target.value })} placeholder="밴드는 비움" /></Field>
          </div>
          <Field label="주소"><input className="forminput" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></Field>
          <div className="formrow">
            <Field label="상세 주소" opt><input className="forminput" value={f.address_detail} onChange={e => setF({ ...f, address_detail: e.target.value })} /></Field>
            <Field label="배송 메시지" opt><input className="forminput" value={f.deliveryMessage} onChange={e => setF({ ...f, deliveryMessage: e.target.value })} /></Field>
          </div>
          <div className="section-label">품목</div>
          {f.items.map((it, i) => {
            const sug = it._pick ? products.filter(p => matchProduct(p, it._pick)).slice(0, 6) : [];
            const g = it.productId ? rollSummary.get(it.productId) : null;
            return (
              <div key={i} className="notice-box" style={{ marginBottom: 8 }}>
                <div className="formrow">
                  <Field label="품번 (찾기)"><div style={{ position: "relative" }}>
                    <input className="forminput mono" value={it._pick ?? it.itemNo ?? ""} placeholder="품번·원단명" autoComplete="off" onChange={e => setItem(i, "_pick", e.target.value)} onBlur={() => setTimeout(() => setItem(i, "_pick", null), 150)} />
                    {sug.length > 0 && <div style={{ position: "absolute", left: 0, right: 0, top: "100%", zIndex: 6, background: "#fff", border: "1px solid #dfe6ef", borderRadius: 12, boxShadow: "0 12px 30px #1b31552a", overflow: "hidden" }}>
                      {sug.map(p => <button key={p.id} type="button" onMouseDown={() => pickProduct(i, p)} style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", border: 0, background: "#fff", borderBottom: "1px solid #f0f3f7", fontSize: 14 }}><b className="mono">{p.code}</b> {p.name}{p.color ? ` ${p.color}` : ""}{p.unitPrice ? ` · ${won(p.unitPrice)}` : ""}</button>)}
                    </div>}
                  </div></Field>
                  <Field label="원단명"><input className="forminput" value={it.fabric} onChange={e => setItem(i, "fabric", e.target.value)} /></Field>
                  <Field label="색상"><input className="forminput" value={it.color} onChange={e => setItem(i, "color", e.target.value)} /></Field>
                  <Field label="수량 · 단위"><div style={{ display: "flex", gap: 6 }}><input className="forminput" inputMode="decimal" value={it.qty} onChange={e => setItem(i, "qty", e.target.value)} /><select className="forminput" style={{ width: 90 }} value={it.unit} onChange={e => setItem(i, "unit", e.target.value)}>{UNIT_OPTS.map(u => <option key={u}>{u}</option>)}</select></div></Field>
                  <Field label="단가"><input className="forminput" inputMode="numeric" value={it.unitPrice} onChange={e => setItem(i, "unitPrice", e.target.value)} /></Field>
                  <Field label="금액"><input className="forminput" inputMode="numeric" value={it.amount} onChange={e => setItem(i, "amount", e.target.value)} /></Field>
                </div>
                {g ? <p className="helptext" style={{ margin: "8px 0 0" }}>재고: 판매 가능 롤 {g.availableCount}개 · 최대 재단 {g.maxRemaining}마{parseFloat(it.qty) > g.maxRemaining ? " — ⚠ 한 롤로 못 끊는 수량입니다(나눠 등록하거나 옛 화면에서 확인)" : ""}</p> : null}
                {f.items.length > 1 && <button className="text-link" style={{ padding: "8px 0 0" }} onClick={() => setF(p => ({ ...p, items: p.items.filter((_, j) => j !== i) }))}>이 품목 빼기</button>}
              </div>
            );
          })}
          <button className="text-link" style={{ padding: "4px 0 10px" }} onClick={() => setF(p => ({ ...p, items: [...p.items, emptyItem()] }))}>+ 품목 추가</button>
          <div className="formrow">
            <Field label="배송비"><div style={{ display: "flex", gap: 6 }}><input className="forminput" inputMode="numeric" value={f.shippingFee} onChange={e => setF({ ...f, shippingFee: e.target.value })} /><Chip onClick={() => setF({ ...f, shippingFee: SHIPPING_FEE.cut })}>{SHIPPING_FEE.cut.toLocaleString()}</Chip><Chip onClick={() => setF({ ...f, shippingFee: SHIPPING_FEE.roll })}>{SHIPPING_FEE.roll.toLocaleString()}</Chip></div></Field>
            <Field label={`전체 금액 (계산값 ${won(calcTotal)})`}><input className="forminput" inputMode="numeric" value={f.totalAmount} onChange={e => setF({ ...f, totalAmount: e.target.value })} placeholder={String(calcTotal)} /></Field>
            <Field label="결제"><div className="chiprow"><Chip on={f.payment === "미입금"} onClick={() => setF({ ...f, payment: "미입금" })}>미입금</Chip><Chip on={f.payment === "입금완료"} onClick={() => setF({ ...f, payment: "입금완료" })}>입금완료</Chip></div></Field>
            <Field label="적립금 사용" opt><input className="forminput" inputMode="numeric" value={f.creditUse} onChange={e => setF({ ...f, creditUse: e.target.value })} placeholder="원" /></Field>
            <Field label="출고예정일"><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Chip on={!f.isUrgent && f.shipDate === nextBiz} onClick={() => setF({ ...f, isUrgent: false, shipDate: nextBiz })}>익일 {nextBiz.slice(5)}</Chip>
              <Chip on={!f.isUrgent && f.shipDate === todayYmd()} onClick={() => setF({ ...f, isUrgent: false, shipDate: todayYmd() })}>당일</Chip>
              <Chip on={f.isUrgent} danger onClick={() => setF({ ...f, isUrgent: true, shipDate: todayYmd() })}>긴급</Chip>
              <input className="forminput" type="date" style={{ width: 170, height: 44 }} value={f.shipDate} onChange={e => setF({ ...f, isUrgent: false, shipDate: e.target.value })} />
            </div>{holidayName(f.shipDate) ? <p className="helptext err" style={{ margin: "6px 0 0" }}>{f.shipDate} 는 {holidayName(f.shipDate)} 입니다</p> : null}</Field>
            <Field label="택배사"><div className="chiprow"><Chip on={!f.courier} onClick={() => setF({ ...f, courier: "" })}>자동 ({auto ? COURIER_SHORT[auto.courier] : "CJ"})</Chip><Chip on={f.courier === CJ} onClick={() => setF({ ...f, courier: CJ })}>CJ</Chip><Chip on={f.courier === KD} onClick={() => setF({ ...f, courier: KD })}>경동</Chip></div></Field>
            <Field label="영수증"><div className="chiprow">{RECEIPTS.map(([v, l]) => <Chip key={String(v)} on={f.receiptType === v} onClick={() => setF({ ...f, receiptType: v })}>{l}</Chip>)}</div></Field>
            <Field label="표시"><div className="chiprow"><Chip on={f.combinedPayment} onClick={() => setF({ ...f, combinedPayment: !f.combinedPayment })}>합입금</Chip><Chip on={f.combinedShipping} onClick={() => setF({ ...f, combinedShipping: !f.combinedShipping })}>합배송</Chip></div></Field>
          </div>
          <Field label="메모(원문)" opt><textarea className="forminput" style={{ minHeight: 90 }} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="담당자 메모" opt><input className="forminput" value={f.memo} onChange={e => setF({ ...f, memo: e.target.value })} /></Field>
          <div className="btnrow" style={{ marginTop: 22 }}>
            <Button kind="white" className="narrow" icon="back" onClick={() => setStep("paste")}>다시 분석</Button>
            <Button icon="check" onClick={submit} loading={busy}>주문 등록 ({won(parseInt(f.totalAmount) || calcTotal)})</Button>
          </div>
          {match && <MatchPopup match={match} parsed={match.parsed}
            onConfirm={(c, opt) => { setResolved(c); setMatch(null); if (opt?.updatePhone) toast(`${c.name} 고객의 번호가 등록 시 ${f.phone} 로 갱신됩니다`); setF(p => ({ ...p, customer: c.name })); }}
            onNew={() => { setResolved(null); setMatch(null); }} onCancel={() => setMatch(null)} />}
        </>
      )}
      <Icon name="paste" className="hidden" />
    </Modal>
  );
}
