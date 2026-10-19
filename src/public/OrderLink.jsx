// 공개 주문 페이지 — 두 흐름, 같은 파일, 같은 초안 테이블. "셀러가 미리 채웠는가"만 다르다.
//   /o/{품번}?k=     공개 링크(게시글). 4단계 초안판(2026-10-07 되돌림): 전화번호 문자 인증 → 기존 고객이면
//                    이름·주소가 채워지고, 아직 안 나간 내 주문(합배송 후보)과 무료배송권이 보인다.
//                    고객이 "함께 보내기"를 고르면 택배비 0, 배송권을 고르면 택배비 0. 서버가 다시 검증한다.
//                    4단계-B 에서 인증을 뺐다가(어르신 장벽) 합배송을 고객이 고를 수 없어 사용자 결정으로 되돌렸다.
//   /o/t/{토큰}?k=   셀러 링크(쪽지). 셀러가 채운 주문서를 보고 "네, 이대로 주문할게요" 한 번. 토큰이 곧 인증.
//
// 보안 경계(4단계 지시서 1절): 이 파일과 여기서 import 하는 것은 ERP 번들·회사 세션·supabase 클라이언트를
// 절대 들이지 않는다. 데이터는 전부 /api/link/* 서버 함수를 거친다. 전화번호·주소는 POST body 로만.
// import 허용: react, ../lib/postcode.js(주소 검색 스크립트 로더, 의존 없음), ../../api/link/_logic.js(순수 계산).
// 공개 링크는 /api/sms-verify(인증) 와 /api/link/customer(인증 뒤 고객·후보·배송권) 를 다시 부른다.
//
// 어르신 기준: 글자 크게, 입력칸 높이 52px 이상, 버튼 하나.
import { useEffect, useMemo, useState } from "react";
import { loadPostcodeScript } from "../lib/postcode.js";
import { computeShippingFee, baseFeeForUnit, computeTotal, computeCreditUse, validateQty, maxFor, formatPhone, normPhone, groupCandidates, sellerTotal, PRIVACY_NOTICE } from "../../api/link/_logic.js";

const C = { bg: "#F7F4EE", card: "#FFFFFF", line: "#E6E0D4", text: "#2B2622", muted: "#7A7067", accent: "#B4652A", accentBg: "#FBF1E8", red: "#C0392B", green: "#2E7D4F", greenBg: "#EAF5EE", dis: "#D9D2C6" };
const F = "'Noto Sans KR', system-ui, sans-serif";
const won = (n) => `${(Number(n) || 0).toLocaleString()}원`;
const inp = { width: "100%", boxSizing: "border-box", minHeight: 52, padding: "13px 14px", borderRadius: 12, border: `1.5px solid ${C.line}`, fontSize: 18, fontFamily: F, color: C.text, background: "#fff", outline: "none" };
const btn = (primary, disabled) => ({ width: "100%", minHeight: 56, padding: "15px", borderRadius: 14, border: primary ? "none" : `1.5px solid ${C.line}`, background: disabled ? C.dis : primary ? C.accent : "#fff", color: disabled ? "#fff" : primary ? "#fff" : C.text, fontSize: 18, fontWeight: 800, fontFamily: F, cursor: disabled ? "not-allowed" : "pointer" });
const Sec = ({ title, children, hint }) => (
  <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "18px 16px 20px", marginBottom: 12 }}>
    {title && <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 10 }}>{title}</div>}
    {hint && <div style={{ fontSize: 14, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>{hint}</div>}
    {children}
  </section>
);
const Label = ({ children }) => <div style={{ fontSize: 14, color: C.muted, fontWeight: 700, margin: "12px 0 6px" }}>{children}</div>;
const Note = ({ children, kind = "muted" }) => <div style={{ fontSize: 14, color: kind === "error" ? C.red : kind === "ok" ? C.green : C.muted, marginTop: 8, lineHeight: 1.5 }}>{children}</div>;
const Check = ({ checked, onChange, children }) => (
  <label style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", cursor: "pointer", fontSize: 16, lineHeight: 1.5 }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 24, height: 24, marginTop: 1, flexShrink: 0 }} />
    <span>{children}</span>
  </label>
);
const Row = ({ l, r, big }) => <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: big ? 20 : 16, fontWeight: big ? 900 : 500, padding: big ? "10px 0 0" : "5px 0", borderTop: big ? `1px solid ${C.line}` : "none", marginTop: big ? 8 : 0 }}><span>{l}</span><span style={{ textAlign: "right" }}>{r}</span></div>;

function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: F }}>
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "14px 14px 48px" }}>
        <div style={{ fontSize: 13, color: C.muted, fontWeight: 700, letterSpacing: "0.06em", margin: "4px 2px 12px" }}>로하이마켓 · 원단 주문</div>
        {children}
      </div>
    </div>
  );
}

/** 개인정보 수집·이용 동의 — 두 흐름이 같은 칸을 쓴다. */
function Privacy({ agreed, setAgreed }) {
  const [open, setOpen] = useState(false);
  return (
    <Sec title={PRIVACY_NOTICE.title}>
      <Check checked={agreed} onChange={setAgreed}><b>[필수]</b> 주문 처리를 위한 개인정보 수집·이용에 동의합니다.</Check>
      <button onClick={() => setOpen(v => !v)} style={{ padding: 0, border: "none", background: "transparent", color: C.muted, fontSize: 14, fontFamily: F, cursor: "pointer", textDecoration: "underline" }}>{open ? "내용 접기" : "내용 보기"}</button>
      {open && (
        <div style={{ marginTop: 8, padding: "10px 12px", background: C.bg, borderRadius: 10, fontSize: 13, lineHeight: 1.7, color: C.text }}>
          {PRIVACY_NOTICE.items.map(([k, v]) => <div key={k} style={{ display: "flex", gap: 8 }}><span style={{ flex: "0 0 92px", color: C.muted, fontWeight: 700 }}>{k}</span><span style={{ flex: 1 }}>{v}</span></div>)}
          <div style={{ marginTop: 6, color: C.muted }}>{PRIVACY_NOTICE.footer}</div>
        </div>
      )}
    </Sec>
  );
}

/** 주소 입력 — 다음 우편번호 검색 + 상세주소. 두 흐름이 같이 쓴다. */
function AddressFields({ address, setAddress, addressDetail, setAddressDetail, onError }) {
  const search = async () => {
    try {
      await loadPostcodeScript();
      new window.daum.Postcode({ oncomplete: (d) => { setAddress(d.roadAddress || d.jibunAddress || d.address || ""); setAddressDetail(""); } }).open();
    } catch (e) { onError?.(e.message); }
  };
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={address} onChange={e => setAddress(e.target.value)} placeholder="주소" autoComplete="street-address" style={{ ...inp, flex: 1 }} />
        <button onClick={search} style={{ ...btn(false, false), width: "auto", minHeight: 52, whiteSpace: "nowrap", padding: "0 16px", fontSize: 16 }}>주소 검색</button>
      </div>
      <input value={addressDetail} onChange={e => setAddressDetail(e.target.value)} placeholder="상세 주소 (동·호수)" style={{ ...inp, marginTop: 8 }} />
    </>
  );
}

function useApi(k) {
  return async (path, { method = "GET", body } = {}) => {
    const url = `/api/link/${path}${path.includes("?") ? "&" : "?"}k=${encodeURIComponent(k)}`;
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* 본문 없음 */ }
    if (!r.ok) { const e = new Error(json?.error || `요청 실패 (${r.status})`); e.status = r.status; throw e; }
    return json;
  };
}

// ══ 공개 링크 — /o/{품번} ══════════════════════════════════════════════
function PublicOrder({ code, k, managerId = "" }) {
  const api = useApi(k);
  const [product, setProduct] = useState(null);
  const [productErr, setProductErr] = useState("");
  useEffect(() => {
    if (!code) { setProductErr("상품을 찾을 수 없습니다"); return; }
    api(`product?code=${encodeURIComponent(code)}`).then(setProduct).catch(e => setProductErr(e.message));
  }, [code]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 2. 수량 — 마는 1 단위 정수(가장 긴 롤에서 재단). 롤은 수량이 아니라 "어느 롤"을 고른다(2026-10-07) —
  //    롤마다 길이가 달라서 고르면 금액이 선다. qtyCheck.value 는 마 수량 또는 고른 롤 수.
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("마");
  const [rollIds, setRollIds] = useState([]);
  const unitMax = product ? maxFor(unit, product) : 0;
  const rollList = product?.rolls || [];
  const pickedRolls = rollList.filter(r => rollIds.includes(r.id));
  const pickedLen = Math.round(pickedRolls.reduce((s, r) => s + (Number(r.length) || 0), 0) * 100) / 100;
  const toggleRoll = (id) => setRollIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const qtyCheck = !product ? { ok: false, reason: "" }
    : unit === "롤" ? (pickedRolls.length ? { ok: true, value: pickedRolls.length } : { ok: false, reason: "롤을 하나 이상 골라 주세요" })
    : validateQty(qty, unitMax, unit);

  // 3. 전화 인증 — 인증이 돼야 아래(고객 정보·합배송·배송권)가 열린다
  const [phone, setPhone] = useState("");
  const [smsSent, setSmsSent] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [smsMsg, setSmsMsg] = useState({ text: "", kind: "muted" });
  const [smsBusy, setSmsBusy] = useState(false);
  const sendSms = async () => {
    if (normPhone(phone).length < 10) { setSmsMsg({ text: "올바른 전화번호를 입력해 주세요", kind: "error" }); return; }
    setSmsBusy(true); setSmsMsg({ text: "", kind: "muted" });
    try {
      const r = await fetch("/api/sms-verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send", phone: normPhone(phone) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "인증번호 발송 실패");
      setSmsSent(true); setDevCode(j.devCode || "");
      setSmsMsg({ text: j.devCode ? "개발 모드 — 문자는 안 가고 인증번호가 아래에 보입니다" : "인증번호를 보냈습니다 (3분 안에 입력)", kind: "ok" });
    } catch (e) { setSmsMsg({ text: e.message, kind: "error" }); }
    finally { setSmsBusy(false); }
  };
  const verifySms = async () => {
    setSmsBusy(true); setSmsMsg({ text: "", kind: "muted" });
    try {
      const r = await fetch("/api/sms-verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", phone: normPhone(phone), code: smsCode.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.verified) throw new Error(j.error || "인증번호가 올바르지 않습니다");
      setVerified(true); setSmsMsg({ text: "인증되었습니다", kind: "ok" });
      await loadCustomer();
    } catch (e) { setSmsMsg({ text: e.message, kind: "error" }); }
    finally { setSmsBusy(false); }
  };

  // 4. 고객 정보 — 인증 뒤에만. 기존 고객이면 이름·주소를 채운다
  const [cust, setCust] = useState(null);        // 서버 응답 그대로
  const [custErr, setCustErr] = useState("");
  const [name, setName] = useState("");
  const [depositor, setDepositor] = useState("");   // 입금자명 — 주문자와 다를 때만
  const [address, setAddress] = useState("");
  const [addressDetail, setAddressDetail] = useState("");
  const [deliveryMessage, setDeliveryMessage] = useState("");
  const [addrErr, setAddrErr] = useState("");
  const loadCustomer = async () => {
    setCustErr("");
    try {
      const c = await api("customer", { method: "POST", body: { phone: normPhone(phone) } });
      setCust(c);
      if (c.name) setName(c.name);
      if (c.address) { setAddress(c.address); setAddressDetail(c.addressDetail || ""); }
    } catch (e) { setCustErr(e.message); setCust({ customerId: null, mergeCandidates: [], freeShippingCount: 0, nameAmbiguous: false }); }
  };

  // 5. 합배송 — 고르면 주소가 그 주문의 주소로 잠긴다. 이미 묶인 주문들은 한 박스 = 한 선택지.
  const candidates = cust?.mergeCandidates || [];
  const units = useMemo(() => groupCandidates(candidates), [candidates]);
  const [mergeWith, setMergeWith] = useState("");   // "" = 따로 보내기, 아니면 대표 주문 id
  const mergedUnit = units.find(u => String(u.orderId) === mergeWith) || null;
  const merged = mergedUnit ? mergedUnit.orders[0] : null;
  useEffect(() => {
    if (merged) { setAddress(merged.address || ""); setAddressDetail(merged.addressDetail || ""); }
  }, [mergeWith]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 6. 무료배송권
  const couponCount = cust?.freeShippingCount || 0;
  const [useCoupon, setUseCoupon] = useState(false);

  // 6-2. 적립금 — 잔액이 있을 때만 보인다. 요청액은 서버가 잔액·주문 금액 안으로 다시 깎는다.
  const creditBalance = cust?.creditBalance || 0;
  const [creditInput, setCreditInput] = useState("");

  // 7. 합계 — 서버와 같은 함수(computeShippingFee). 택배비는 단위로 고정: 마 4,000 · 롤 7,000(경동).
  //    롤 주문은 원단 금액을 못 정한다 — 셀러가 안내
  const baseFee = baseFeeForUnit(unit);
  const fee = computeShippingFee({ useFreeShipping: useCoupon, couponCount, mergeWithOrderId: merged ? merged.id : null, unit });
  // 금액 — 마는 단가 × 수량, 롤은 단가 × 고른 롤 길이 합
  const money = computeTotal(product?.unitPrice ?? null, qtyCheck.ok ? (unit === "롤" ? pickedLen : qtyCheck.value) : 0, fee);
  // 적립금은 금액을 아는 주문(마)에서만 — 롤은 금액을 셀러가 정하므로 전환 때 셀러가 적는다
  const creditMax = computeCreditUse({ requested: Infinity, balance: creditBalance, orderTotal: money.total, priceKnown: money.priceKnown });
  const creditUse = computeCreditUse({ requested: creditInput, balance: creditBalance, orderTotal: money.total, priceKnown: money.priceKnown });
  const payAmount = Math.max(0, money.total - creditUse);

  // 8. 제출 — 개인정보 동의는 필수(서버도 거부한다)
  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState("");
  const [done, setDone] = useState(null);
  const canSubmit = !!product && product.maxRemaining > 0 && qtyCheck.ok && verified && !!name.trim() && !!address.trim() && privacyAgreed && !submitting;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true); setSubmitErr("");
    try {
      const r = await api("draft", { method: "POST", body: {
        code: product.code, qty: String(qtyCheck.value), unit, rollIds: unit === "롤" ? rollIds : [], phone: normPhone(phone), customerName: name.trim(), depositorName: depositor.trim(),
        address: address.trim(), addressDetail: addressDetail.trim(), deliveryMessage: deliveryMessage.trim(),
        mergeWithOrderId: merged ? merged.id : null, useFreeShipping: useCoupon && couponCount > 0,
        creditUse, managerId,
        privacyAgreed,
      } });
      setDone(r);
    } catch (e) { setSubmitErr(e.message); }
    finally { setSubmitting(false); }
  };

  if (productErr) return <Sec title={productErr}><Note>링크의 품번을 확인해 주세요. ({code || "품번 없음"})</Note></Sec>;
  if (!product) return <Sec title="상품을 불러오는 중…" />;
  if (done) return (
    <Sec title="주문이 접수되었습니다">
      <Note kind="ok">셀러가 확인 후 입금 안내를 드립니다.</Note>
      <div style={{ marginTop: 12, fontSize: 16, lineHeight: 1.8 }}>
        <div>접수 번호 <b style={{ fontFamily: "monospace" }}>{String(done.draftId).slice(0, 8)}</b></div>
        <div>{product.name}{product.color ? ` ${product.color}` : ""} {qtyCheck.value}{unit}{unit === "롤" ? ` (${pickedRolls.map(r => `${r.rollCode.replace(/^.*-R/, "R")} ${r.length}마`).join(", ")} = ${pickedLen}마)` : ""} · 택배비 {won(done.shippingFee)}</div>
        {merged && <div>이전 주문과 함께 보냅니다</div>}
        {money.priceKnown && <div>합계 {won(done.totalAmount)}{(done.creditUse || 0) > 0 ? ` · 적립금 ${won(done.creditUse)} 사용 → 입금하실 금액 ${won(Math.max(0, (done.totalAmount || 0) - (done.creditUse || 0)))}` : ""}</div>}
      </div>
      <Note>(내부 테스트용 문구 — 고객 공개 전에 바뀝니다)</Note>
    </Sec>
  );

  const soldOut = !(product.maxRemaining > 0);
  return (
    <>
      {/* 1. 상품 */}
      <Sec title={`${product.name}${product.color ? ` · ${product.color}` : ""}`}>
        {product.photoUrl ? <img src={product.photoUrl} alt="" style={{ width: "100%", borderRadius: 12, marginBottom: 10, display: "block" }} /> : null}
        <div style={{ fontSize: 13, color: C.muted, fontFamily: "monospace" }}>{product.code}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 8, gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 22, fontWeight: 900 }}>{product.unitPrice === null ? <span style={{ fontSize: 16, color: C.muted }}>가격은 셀러가 안내드립니다</span> : <>{won(product.unitPrice)}<span style={{ fontSize: 14, color: C.muted, fontWeight: 600 }}> / {product.unit}</span></>}</div>
          <div style={{ fontSize: 15, color: soldOut ? C.red : C.green, fontWeight: 800 }}>{soldOut ? "품절" : `지금 주문 가능 최대 ${product.maxRemaining}${product.unit}`}</div>
        </div>
      </Sec>

      {/* 2. 수량 — 마는 숫자, 롤은 목록에서 고른다 */}
      <Sec title={unit === "롤" ? "롤 고르기" : "수량"} hint={unit === "롤" ? "받으실 롤을 고르세요. 롤마다 길이가 달라 고른 만큼 금액이 정해집니다. 택배비는 롤 7,000원입니다." : "1 단위로 입력합니다. 택배비는 마 4,000원 · 롤 7,000원입니다."}>
        <div style={{ display: "flex", gap: 8 }}>
          {unit === "롤"
            ? <div style={{ ...inp, flex: 1, display: "flex", alignItems: "center", color: pickedRolls.length ? C.text : C.muted, fontWeight: 800 }}>{pickedRolls.length ? `${pickedRolls.length}롤 · ${pickedLen}마` : "아래에서 골라 주세요"}</div>
            : <input value={qty} onChange={e => setQty(e.target.value)} inputMode="numeric" placeholder={`최대 ${unitMax}${unit}`} disabled={soldOut} style={{ ...inp, flex: 1 }} />}
          <div style={{ display: "flex", border: `1.5px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
            {["마", "롤"].map(u => (
              <button key={u} onClick={() => { setUnit(u); setQty(""); setRollIds([]); }} disabled={soldOut} style={{ padding: "0 18px", border: "none", background: unit === u ? C.accent : "#fff", color: unit === u ? "#fff" : C.text, fontSize: 17, fontWeight: 800, fontFamily: F, cursor: "pointer" }}>{u}</button>
            ))}
          </div>
        </div>
        {unit === "롤" ? (
          rollList.length === 0
            ? <Note kind="error">지금 통째로 드릴 수 있는 롤이 없습니다. 마 단위로 주문해 주세요.</Note>
            : <div style={{ marginTop: 10 }}>
                {rollList.map(r => {
                  const on = rollIds.includes(r.id);
                  return (
                    <label key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 10px", borderRadius: 12, border: `1.5px solid ${on ? C.accent : C.line}`, background: on ? C.accentBg : "#fff", marginBottom: 8, cursor: "pointer" }}>
                      <input type="checkbox" checked={on} onChange={() => toggleRoll(r.id)} style={{ width: 24, height: 24, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 17, fontWeight: 800 }}>{r.rollCode.replace(/^.*-R/, "롤 R")}</span>
                      <span style={{ fontSize: 17, fontWeight: 900 }}>{r.length}마</span>
                      {product.unitPrice !== null && <span style={{ fontSize: 15, color: C.muted, minWidth: 72, textAlign: "right" }}>{won(Math.round(product.unitPrice * r.length))}</span>}
                    </label>
                  );
                })}
              </div>
        ) : (
          <Note>지금 주문 가능 최대 {product.maxRemaining}마</Note>
        )}
        {unit !== "롤" && qty && !qtyCheck.ok && <Note kind="error">{qtyCheck.reason}</Note>}
      </Sec>

      {/* 3. 전화 인증 */}
      <Sec title="전화번호 인증" hint="주문자 확인을 위해 인증번호를 보냅니다. 번호는 주문 안내에만 씁니다.">
        <div style={{ display: "flex", gap: 8 }}>
          <input value={phone} onChange={e => { setPhone(e.target.value); if (verified) { setVerified(false); setCust(null); setSmsSent(false); setMergeWith(""); setUseCoupon(false); } }} inputMode="tel" autoComplete="tel" placeholder="010-0000-0000" disabled={verified} style={{ ...inp, flex: 1 }} />
          <button onClick={sendSms} disabled={smsBusy || verified} style={{ ...btn(false, smsBusy || verified), width: "auto", minHeight: 52, whiteSpace: "nowrap", padding: "0 16px", fontSize: 16 }}>{smsSent ? "다시 받기" : "인증번호 받기"}</button>
        </div>
        {smsSent && !verified && (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input value={smsCode} onChange={e => setSmsCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="인증번호 6자리" style={{ ...inp, flex: 1 }} onKeyDown={e => { if (e.key === "Enter") verifySms(); }} />
            <button onClick={verifySms} disabled={smsBusy || smsCode.trim().length < 4} style={{ ...btn(true, smsBusy || smsCode.trim().length < 4), width: "auto", minHeight: 52, padding: "0 18px", fontSize: 16 }}>확인</button>
          </div>
        )}
        {devCode && !verified && <Note>개발 모드 인증번호: <b style={{ fontFamily: "monospace", fontSize: 16 }}>{devCode}</b></Note>}
        {smsMsg.text && <Note kind={smsMsg.kind}>{smsMsg.text}</Note>}
        {verified && <Note kind="ok">✓ {formatPhone(normPhone(phone))} 인증됨</Note>}
      </Sec>

      {verified && (
        <>
          {/* 4. 고객 정보 */}
          <Sec title={cust?.customerId ? "주문하시는 분 (기존 고객)" : "주문하시는 분"} hint={cust?.customerId ? "저장된 정보를 채웠습니다. 바뀐 곳이 있으면 고쳐 주세요." : undefined}>
            {custErr && <Note kind="error">{custErr}</Note>}
            <Label>이름</Label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="이름" autoComplete="name" style={inp} />
            <Label>입금자명 (주문자와 다를 때만)</Label>
            <input value={depositor} onChange={e => setDepositor(e.target.value)} placeholder="입금하실 분 이름" style={inp} />
            <Label>주소</Label>
            {merged ? (
              <>
                <input value={address} disabled style={inp} />
                <input value={addressDetail} disabled style={{ ...inp, marginTop: 8 }} />
                <Note>함께 보낼 주문의 주소로 고정됩니다. 다른 곳으로 보내려면 '따로 보내기'를 고르세요.</Note>
              </>
            ) : (
              <AddressFields address={address} setAddress={setAddress} addressDetail={addressDetail} setAddressDetail={setAddressDetail} onError={setAddrErr} />
            )}
            {addrErr && <Note kind="error">{addrErr}</Note>}
            <Label>배송 메모 (선택)</Label>
            <input value={deliveryMessage} onChange={e => setDeliveryMessage(e.target.value)} placeholder="예: 문 앞에 두세요" style={inp} />
          </Sec>

          {/* 5. 합배송 — 아직 안 나간 내 주문이 있을 때만 */}
          {candidates.length > 0 && (
            <Sec title="아직 출고 전인 주문이 있어요" hint="함께 보내면 택배비가 없습니다. 출고일은 늦은 주문에 맞춰집니다.">
              <label style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderBottom: `1px solid ${C.line}`, cursor: "pointer" }}>
                <input type="radio" name="merge" checked={mergeWith === ""} onChange={() => setMergeWith("")} style={{ width: 24, height: 24, marginTop: 1, flexShrink: 0 }} />
                <div><div style={{ fontWeight: 800, fontSize: 16 }}>따로 보내기</div><div style={{ fontSize: 14, color: C.muted }}>택배비 {won(useCoupon && couponCount > 0 ? 0 : baseFee)}</div></div>
              </label>
              {units.map(u => {
                const first = u.orders[0];
                const packed = u.orders.some(c => c.status === "포장완료");
                const dates = u.orders.map(c => c.isUrgent ? "긴급" : c.shipDate).filter(Boolean).sort();
                const when = dates.includes("긴급") ? "긴급" : dates.length ? `출고예정 ${dates[dates.length - 1]}` : "";
                return (
                  <label key={u.key} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 0", borderBottom: `1px solid ${C.line}`, cursor: "pointer" }}>
                    <input type="radio" name="merge" checked={mergeWith === String(u.orderId)} onChange={() => setMergeWith(String(u.orderId))} style={{ width: 24, height: 24, marginTop: 1, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 16 }}>함께 보내기{u.grouped ? ` (묶음 ${u.orders.length}건)` : ""} <span style={{ color: C.green }}>(택배비 0원)</span></div>
                      {u.orders.map(c => <div key={c.id} style={{ fontSize: 14, color: C.text, marginTop: 2 }}>{c.date} · {c.items || "품목 없음"}</div>)}
                      <div style={{ fontSize: 14, color: C.muted }}>{when}{first.address ? ` · ${first.address}` : ""}</div>
                      {packed && <div style={{ fontSize: 13, color: C.accent, marginTop: 2 }}>포장 완료된 주문 — 다시 포장됩니다</div>}
                    </div>
                  </label>
                );
              })}
            </Sec>
          )}

          {/* 6. 무료배송권 — 보유했을 때만. 동명이인이면 셀러에게 */}
          {(couponCount > 0 || cust?.nameAmbiguous) && (
            <Sec title="무료배송권">
              {cust?.nameAmbiguous
                ? <Note>배송권 확인은 셀러에게 문의해 주세요.</Note>
                : <Check checked={useCoupon} onChange={setUseCoupon}>보유 <b>{couponCount}장</b> · 이번 주문에 사용하기{merged ? " (함께 보내기라 택배비가 이미 0원입니다)" : ""}</Check>}
            </Sec>
          )}

          {/* 6-2. 적립금 — 보유했을 때만. 동명이인이면 배송권과 같이 셀러에게 */}
          {creditBalance > 0 && !cust?.nameAmbiguous && (
            <Sec title="적립금" hint={money.priceKnown ? `보유 ${won(creditBalance)} · 이번 주문에 쓸 금액을 적어 주세요` : `보유 ${won(creditBalance)} · 가격이 정해진 뒤 셀러가 적용해 드립니다`}>
              {money.priceKnown && (
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={creditInput ? Number(creditInput).toLocaleString() : ""} onChange={e => setCreditInput(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="0" style={{ ...inp, flex: 1, textAlign: "right", fontWeight: 800 }} />
                  <button onClick={() => setCreditInput(String(creditMax))} style={{ ...btn(false, false), width: "auto", minHeight: 52, whiteSpace: "nowrap", padding: "0 16px", fontSize: 16 }}>전액</button>
                </div>
              )}
              {money.priceKnown && creditInput && Number(creditInput) > creditUse && <Note>최대 {won(creditMax)}까지 쓸 수 있어 {won(creditUse)}만 적용됩니다</Note>}
              {creditUse > 0 && <Note kind="ok">적립금 {won(creditUse)} 사용 → 입금하실 금액 {won(payAmount)}</Note>}
            </Sec>
          )}

          {/* 7. 합계 */}
          <Sec title="합계">
            <Row l={`${product.name} ${qtyCheck.ok ? (unit === "롤" ? `${qtyCheck.value}롤 (${pickedLen}마)` : `${qtyCheck.value}${unit}`) : "—"}`} r={money.priceKnown ? won(money.goods) : "셀러가 안내"} />
            <Row l="택배비" r={won(fee)} />
            {creditUse > 0 && <Row l="적립금" r={`−${won(creditUse)}`} />}
            <Row big l={creditUse > 0 ? "입금하실 금액" : "합계"} r={money.priceKnown ? won(payAmount) : `택배비 ${won(fee)} + 원단 금액`} />
          </Sec>

          <Privacy agreed={privacyAgreed} setAgreed={setPrivacyAgreed} />

          {/* 8. 주문하기 */}
          {submitErr && <Note kind="error">{submitErr}</Note>}
          <button onClick={submit} disabled={!canSubmit} style={{ ...btn(true, !canSubmit), marginTop: 6 }}>{submitting ? "접수 중…" : "주문하기"}</button>
          <Note>주문하기를 누르면 셀러에게 접수됩니다. 재고는 셀러 확인 후 확정됩니다. 입력하신 정보는 주문 처리에만 사용합니다.</Note>
        </>
      )}
    </>
  );
}

// ══ 셀러 링크 — /o/t/{토큰} ═══════════════════════════════════════════
function OfferOrder({ token, k }) {
  const api = useApi(k);
  const [offer, setOffer] = useState(null);
  const [err, setErr] = useState(null);     // { status, message }
  useEffect(() => {
    api(`offer?t=${encodeURIComponent(token)}`).then(setOffer).catch(e => setErr({ status: e.status || 0, message: e.message }));
  }, [token]);  // eslint-disable-line react-hooks/exhaustive-deps

  const [editAddr, setEditAddr] = useState(false);
  const [address, setAddress] = useState("");
  const [addressDetail, setAddressDetail] = useState("");
  const [addrErr, setAddrErr] = useState("");
  useEffect(() => { if (offer) { setAddress(offer.address || ""); setAddressDetail(offer.addressDetail || ""); setEditAddr(!offer.address); } }, [offer]);

  const [privacyAgreed, setPrivacyAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState("");
  const [done, setDone] = useState(null);
  const changedAddr = offer && (address.trim() !== (offer.address || "") || addressDetail.trim() !== (offer.addressDetail || ""));
  const canSubmit = !!offer && !!address.trim() && privacyAgreed && !submitting;
  const confirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true); setSubmitErr("");
    try {
      const body = { token };
      if (changedAddr) { body.address = address.trim(); body.addressDetail = addressDetail.trim(); }
      const r = await api("confirm", { method: "POST", body });
      setDone(r);
    } catch (e) {
      if (e.status === 409) setErr({ status: 409, message: e.message });
      else if (e.status === 410) setErr({ status: 410, message: e.message });
      else setSubmitErr(e.message);
    } finally { setSubmitting(false); }
  };

  if (err) return (
    <Sec title={err.status === 409 ? "이미 주문하셨습니다" : err.status === 410 ? "링크가 만료되었습니다" : err.status === 404 ? "주문서를 찾을 수 없습니다" : "불러오지 못했습니다"}>
      <Note>{err.status === 409 ? "셀러가 확인 후 입금 안내를 드립니다." : err.status === 410 ? "셀러에게 다시 요청해 주세요." : err.message}</Note>
    </Sec>
  );
  if (!offer) return <Sec title="주문서를 불러오는 중…" />;
  if (done) return (
    <Sec title="주문이 접수되었습니다">
      <Note kind="ok">입금 안내는 셀러가 쪽지로 드립니다.</Note>
      <div style={{ marginTop: 12, fontSize: 16, lineHeight: 1.8 }}>
        <div>접수 번호 <b style={{ fontFamily: "monospace" }}>{String(done.draftId).slice(0, 8)}</b></div>
        {offer.priceKnown && <div>합계 {won(offer.totalAmount)}</div>}
      </div>
    </Sec>
  );

  const totals = sellerTotal(offer.items, offer.shippingFee);
  const exp = offer.expiresAt ? new Date(offer.expiresAt) : null;
  return (
    <>
      <Sec>
        <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.4 }}>{offer.customerName}님,<br />셀러가 보낸 주문서입니다</div>
        <Note>내용을 확인하고 아래 버튼을 한 번 눌러 주세요.{exp ? ` ${exp.getMonth() + 1}/${exp.getDate()} ${String(exp.getHours()).padStart(2, "0")}:${String(exp.getMinutes()).padStart(2, "0")}까지 유효합니다.` : ""}</Note>
      </Sec>

      {/* 품목 */}
      <Sec title="주문 내용">
        {offer.items.map((it, i) => (
          <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < offer.items.length - 1 ? `1px solid ${C.line}` : "none" }}>
            {it.photoUrl ? <img src={it.photoUrl} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} /> : null}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{it.name}{it.color ? ` · ${it.color}` : ""}</div>
              <div style={{ fontSize: 13, color: C.muted, fontFamily: "monospace" }}>{it.code}</div>
              <div style={{ fontSize: 16, marginTop: 4 }}><b>{it.qty}{it.unit || "마"}</b>{it.unitPrice > 0 ? <span style={{ color: C.muted }}> × {won(it.unitPrice)} = <b style={{ color: C.text }}>{won(it.amount)}</b></span> : <span style={{ color: C.muted }}> · 금액은 셀러가 안내</span>}</div>
            </div>
          </div>
        ))}
      </Sec>

      {/* 배송지 */}
      <Sec title="배송지">
        {!editAddr ? (
          <>
            <div style={{ fontSize: 17, lineHeight: 1.5 }}>{offer.address}{offer.addressDetail ? ` ${offer.addressDetail}` : ""}</div>
            <button onClick={() => setEditAddr(true)} style={{ marginTop: 10, padding: "8px 14px", borderRadius: 10, border: `1.5px solid ${C.line}`, background: "#fff", color: C.text, fontSize: 15, fontWeight: 700, fontFamily: F, cursor: "pointer" }}>주소 바꾸기</button>
          </>
        ) : (
          <>
            <AddressFields address={address} setAddress={setAddress} addressDetail={addressDetail} setAddressDetail={setAddressDetail} onError={setAddrErr} />
            {addrErr && <Note kind="error">{addrErr}</Note>}
            {offer.address && <button onClick={() => { setAddress(offer.address); setAddressDetail(offer.addressDetail || ""); setEditAddr(false); }} style={{ marginTop: 10, padding: 0, border: "none", background: "transparent", color: C.muted, fontSize: 14, fontFamily: F, cursor: "pointer", textDecoration: "underline" }}>원래 주소로</button>}
          </>
        )}
        {offer.mergeWith && <Note kind="ok">이전 주문({offer.mergeWith.date} {offer.mergeWith.items})과 함께 보냅니다 · 택배비 0원</Note>}
        {offer.deliveryMessage && <Note>배송 메모: {offer.deliveryMessage}</Note>}
      </Sec>

      {/* 합계 */}
      <Sec title="합계">
        <Row l="원단" r={offer.priceKnown ? won(totals.goods) : "셀러가 안내"} />
        <Row l="택배비" r={offer.useFreeShipping ? "0원 (무료배송권)" : won(offer.shippingFee)} />
        <Row big l="합계" r={offer.priceKnown ? won(totals.total) : `택배비 ${won(offer.shippingFee)} + 원단 금액`} />
      </Sec>

      <Privacy agreed={privacyAgreed} setAgreed={setPrivacyAgreed} />

      {submitErr && <Note kind="error">{submitErr}</Note>}
      <button onClick={confirm} disabled={!canSubmit} style={{ ...btn(true, !canSubmit), minHeight: 64, fontSize: 20, marginTop: 6 }}>{submitting ? "접수 중…" : "네, 이대로 주문할게요"}</button>
      <Note>누르면 셀러에게 접수되고, 입금 안내는 쪽지로 드립니다.</Note>
    </>
  );
}

export default function OrderLink() {
  // URL — /o/{품번} 또는 /o/t/{토큰}. 키는 ?k=. 그 외 어떤 개인정보도 URL 에 싣지 않는다.
  const { mode, code, token } = useMemo(() => {
    try {
      const segs = location.pathname.replace(/^\/o\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
      if (segs[0] === "t") return { mode: "offer", code: "", token: segs[1] || "" };
      return { mode: "public", code: segs[0] || "", token: "" };
    } catch { return { mode: "public", code: "", token: "" }; }
  }, []);
  const k = useMemo(() => new URLSearchParams(location.search).get("k") || "", []);
  // 담당자 — 링크를 복사한 셀러의 managers.id(uuid). 이 링크로 들어온 주문은 그 담당자 것이 된다(2026-10-07).
  const m = useMemo(() => (new URLSearchParams(location.search).get("m") || "").replace(/[^0-9a-fA-F-]/g, "").slice(0, 36), []);

  if (!k) return <Shell><Sec title="준비 중인 페이지입니다"><Note>곧 열립니다. 주문은 밴드 댓글이나 셀러에게 직접 해 주세요.</Note></Sec></Shell>;
  return <Shell>{mode === "offer" ? <OfferOrder token={token} k={k} /> : <PublicOrder code={code} k={k} managerId={m} />}</Shell>;
}
