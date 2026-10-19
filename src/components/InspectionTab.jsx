import { useState, useEffect, useMemo, useRef } from "react";
import { SecTitle, Card, Empty, PrimaryBtn, GhostBtn, FLabel } from "./UI.jsx";
import { SF, S, baseInp, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { matchProduct, parseMeasured, fmtLen, isScanSafe, rollErrorText, prefixForManager } from "../lib/rollStock.js";

// 입고·검단 — 롤을 들이고(입고), 재서 실측을 적고(검단), QR 라벨을 뽑는다.
//
// 입고와 검단을 한 화면에 세로로 둔 이유: 같은 사람이 같은 자리에서 이어서 한다.
// 원단이 들어오면 롤 수만큼 등록하고, 하나씩 펴서 재고, 잰 값을 적으면 라벨이 나온다.
//
// 입고 화면은 바로 등록 칸(원단명·가격·롤 수·롤 길이·위치)으로 연다(2026-10-08 사용자 결정).
// 2026-10-02 판은 사진 찍기부터 시작했는데, 사진 있이·없이 등록하는 일이 반반이라 첫 화면의 사진 관문을 뺐다 —
// 사진은 위쪽 '사진 찍기'로 언제든 붙인다(선택). 공급처·색상·메모는 '더보기'에 접어 둔다.
// 품번 고르기와 입고 등록은 한 번이다: 원단명 칸에 치다가 목록에서 고르면 기존 품번,
// 안 고르고 그대로 등록하면 그 이름으로 새 품번을 발급하고 곧바로 롤을 넣는다. '품번 등록' 버튼이 따로 없다.
// 2026-10-02 부터 검단 단계를 생략한다 — 입고할 때 롤마다 길이를 적으면 그 값으로 바로 판매 가능이 되고
// 라벨이 나온다. 롤 수를 늘리면 길이 칸이 그만큼 늘어난다(롤마다 길이가 다르다).
// 아래 '검단 대기'는 그 전에 입고만 해 둔 롤이나, 입고 중 판매 가능 처리에 실패한 롤이 있을 때만 보인다.

const mdhm = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const EMPTY_NEW = { name: "", color: "", unitPrice: "", note: "" };

/**
 * @param labelStationRow  서버에 등록된 라벨 출력 담당 기기(없으면 null)
 * @param labelStationHere 그 담당이 이 컴퓨터인가
 */
function InspectionTab({ products = [], rolls = [], managers = [], reloadProducts, reloadRolls, showToast, activeManager, labelStationRow, labelStationHere }) {
  const G = useTheme();
  // 품번 담당자(2026-10-08) — 입고하는 사람이 곧 파는 사람이 대부분이라 작업자가 기본. 다른 사람 원단을 대신 넣을 때만 바꾼다.
  // 품번 앞글자도 이 담당자의 이니셜을 따른다(rollStock.prefixForManager). 등록 뒤에도 그대로 둔다(다음 원단도 같은 사람일 때가 많다).
  const [owner, setOwner] = useState("");
  const ownerName = owner || activeManager || "";
  const ownerPrefix = prefixForManager(managers, ownerName);

  // ── 섹션 A: 입고 등록 — 사진 → 원단·가격·롤·위치 → 등록 한 번 ──
  const [q, setQ] = useState("");                 // 원단명(또는 품번) — 치다가 목록에서 고르면 기존 품번
  const [qFocus, setQFocus] = useState(false);
  const [picked, setPicked] = useState(null);     // 고른 기존 품번
  const [np, setNp] = useState(EMPTY_NEW);        // 새 원단의 색상·단가·메모
  const [price, setPrice] = useState("");         // 가격(원/마) — 기존 품번이면 그 단가로 채워 두고, 바꾸면 품번 단가도 바꾼다
  const [photo, setPhoto] = useState(null);       // 찍은 사진(File)
  const [more, setMore] = useState(false);        // 더보기 — 공급처·색상·메모
  const [savingProduct, setSavingProduct] = useState(false);
  const [rf, setRf] = useState({ count: "1", lengths: [""], supplier: "", location: "" });
  const [savingRolls, setSavingRolls] = useState(false);
  const [lastDone, setLastDone] = useState(null); // 방금 등록한 것 — 다음 원단 사진을 찍는 동안 위에 남겨 둔다
  const fileRef = useRef(null);

  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  // 고른 품번은 목록에서 다시 찾는다 — 다른 PC 에서 이름·사진을 고치면 여기도 따라간다.
  const pickedNow = picked ? (productById.get(picked.id) || picked) : null;
  // 아무것도 안 적은 상태 — 방금 등록한 것을 위에 보여주고, 붙여넣기를 사진으로 받는 때.
  const idle = !photo && !q.trim() && !pickedNow;
  // 새 원단 — 목록에서 고르지 않고 이름을 적었다. 등록 버튼이 품번 발급과 입고를 한 번에 한다.
  const newName = pickedNow ? "" : q.trim();
  // 품번 모양(LH-2610-0001)으로 쳤는데 목록에 없으면 새 원단이 아니라 잘못 친 품번이다 — 그 이름으로 만들지 않는다.
  const looksLikeCode = /^[A-Za-z]{1,4}-\d{3,}/.test(newName);
  const newOpen = !!newName && !looksLikeCode;
  // 같은 이름(·색상)의 품번이 이미 있으면 새로 만들기 전에 묻는다 — 고르는 걸 잊고 등록하면 품번이 둘이 된다.
  const sameProduct = newOpen
    ? products.find(p => String(p.name || "").trim() === newName && String(p.color || "").trim() === String(np.color || "").trim()) || null
    : null;

  const suggestions = (qFocus && q.trim() && !picked)
    ? products.filter(p => matchProduct(p, q)).slice(0, 8)
    : [];

  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : ""), [photo]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  // 붙여넣기 → 사진(PC 에서 쓸 때). 사진 단계이거나 새 원단을 적는 중일 때만 듣는다 —
  // 늘 듣고 있으면 다른 칸에 글자를 붙여넣다가 클립보드의 그림이 여기로 들어온다.
  const listenPaste = idle || newOpen;
  useEffect(() => {
    if (!listenPaste) return;
    const onPaste = (e) => {
      for (const it of e.clipboardData?.items || []) {
        if (it.kind !== "file") continue;
        const f = it.getAsFile();
        if (f && f.type?.startsWith("image/")) { e.preventDefault(); setPhoto(f); return; }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [listenPaste]);

  const pick = (p) => {
    setPicked(p); setQ(p.code); setQFocus(false);
    setPrice(p.unitPrice ? String(Math.round(Number(p.unitPrice))) : "");
  };
  const unpick = () => { setPicked(null); setQ(""); setPrice(""); };
  // 처음(빈 등록 칸)으로 — 등록이 끝났거나 사람이 '처음부터'를 눌렀다. 공급처·위치는 남긴다(같은 거래처를 이어서 넣는다).
  const resetForm = () => {
    setPicked(null); setQ(""); setPrice(""); setNp(EMPTY_NEW); setPhoto(null); setMore(false);
    setRf(p => ({ ...p, count: "1", lengths: [""] }));
  };

  // 품번 삭제 — 롤이 하나도 없는 품번만(끝난 롤이 남아 있어도 서버가 거절한다). 잘못 발급한 품번을 거둔다.
  const removeProduct = async (p) => {
    if (savingProduct) return;
    if (!window.confirm(`품번 ${p.code} ${p.name}${p.color ? ` ${p.color}` : ""} 을(를) 삭제할까요?\n\n되돌릴 수 없습니다. 이 품번을 골라 등록한 주문은 그대로 남습니다.`)) return;
    setSavingProduct(true);
    try {
      await db.deleteProduct(p.id);
      showToast(`품번 삭제 — ${p.code}`);
      unpick();
      await reloadProducts?.();
    } catch (e) {
      console.error("품번 삭제 실패:", e);
      showToast("품번 삭제 실패: " + rollErrorText(e), "error");
    } finally { setSavingProduct(false); }
  };

  const count = Math.min(99, Math.floor(Number(rf.count)) || 0);
  // 롤 수를 바꾸면 길이 칸 수도 따라간다. 이미 적은 값은 남기고 늘어난 칸은 비운다.
  const setCount = (v) => setRf(p => {
    const n = Math.min(99, Math.max(0, Math.floor(Number(v)) || 0));
    const lengths = Array.from({ length: Math.max(n, 0) }, (_, i) => p.lengths[i] ?? "");
    return { ...p, count: v, lengths };
  });
  // 쉼표는 소수점으로 읽는다 — "28,5" 를 쉼표만 지워 285 로 받으면 285마 롤이 생기고 라벨까지 나간다(2026-10-13 점검).
  const setLen = (i, v) => setRf(p => ({ ...p, lengths: p.lengths.map((x, j) => j === i ? v.replace(/,/g, ".").replace(/[^0-9.]/g, "") : x) }));
  const fillAll = () => setRf(p => ({ ...p, lengths: p.lengths.map(() => p.lengths[0]) }));
  const parsedLens = rf.lengths.slice(0, count).map(v => parseMeasured(v));
  const lensOk = count >= 1 && parsedLens.length === count && parsedLens.every(p => p.ok && p.value > 0);
  const lensTotal = lensOk ? parsedLens.reduce((s, p) => s + p.value, 0) : 0;
  const canReceive = (!!pickedNow || newOpen) && lensOk && !savingRolls && !savingProduct;
  const priceNum = parseInt(String(price).replace(/[^0-9]/g, "")) || null;
  const unitOf = (p) => p?.unit || "마";

  const receive = async () => {
    if (!canReceive) return;
    let product = pickedNow, isNew = false;
    if (!product) {
      // 같은 이름·색상의 품번이 있으면 그걸 쓸지 묻는다
      if (sameProduct && window.confirm(`이미 있는 품번입니다 — ${sameProduct.code} ${sameProduct.name}${sameProduct.color ? ` ${sameProduct.color}` : ""}\n\n이 품번에 롤을 넣을까요?\n(취소하면 같은 이름으로 새 품번을 하나 더 만듭니다)`)) {
        product = sameProduct;
      } else {
        setSavingProduct(true);
        try {
          product = await db.insertProduct({ name: newName, color: np.color, note: np.note, unitPrice: priceNum, photoFile: photo, manager: ownerName, prefix: ownerPrefix });
          isNew = true;
          if (product.photoError) showToast(`품번 ${product.code} 발급 — 다만 사진을 올리지 못했습니다 (${product.photoError})`, "error");
          await reloadProducts?.();
        } catch (e) {
          console.error("품번 등록 실패:", e);
          showToast("품번 등록 실패: " + rollErrorText(e), "error");
          return;
        } finally { setSavingProduct(false); }
      }
      // 여기서부터는 그 품번을 고른 상태다 — 아래 입고가 실패해도 다시 누르면 품번을 또 만들지 않는다.
      setPicked(product); setQ(product.code);
    }
    // 기존 품번 — 가격을 바꿨으면 품번 단가도 바꾸고, 사진이 없던 품번이면 찍은 사진을 붙인다(있던 사진은 그대로).
    if (!isNew) {
      try {
        if (priceNum && Number(product.unitPrice || 0) !== priceNum) await db.updateProduct(product.id, { unitPrice: priceNum });
        if (photo && !product.photoUrl) await db.setProductPhoto(product.id, photo);
        await reloadProducts?.();
      } catch (e) { console.warn("[입고] 품번 가격·사진 저장 실패", e); showToast("품번 가격·사진 저장 실패 — 롤은 계속 등록합니다: " + rollErrorText(e), "error"); }
    }
    setSavingRolls(true);
    try {
      const { rolls: made, failed, labelRequested } = await db.receiveRolls(product.id, {
        lengths: parsedLens.map(p => p.value), supplier: rf.supplier, location: rf.location,
      }, activeManager || "");
      const range = made.length ? `${made[0].rollCode}${made.length > 1 ? ` ~ ${made[made.length - 1].rollCode.slice(-3)}` : ""}` : "";
      if (failed.length) {
        showToast(`입고 ${made.length}롤 판매 가능 — 다만 ${failed.join(", ")} 은(는) 처리에 실패해 아래 검단 대기에 있습니다`, "error");
      } else if (!labelRequested) {
        showToast(`📥 입고 ${made.length}롤 (${range}) — 라벨 요청에 실패했습니다. 롤 재고에서 '라벨 재출력'을 눌러 주세요`, "error");
      } else if (!labelStationRow) {
        showToast(`📥 입고 ${made.length}롤 (${range}) · 판매 가능 — 다만 라벨 출력 PC가 켜져 있지 않습니다`, "error");
      } else {
        showToast(`📥 입고 ${made.length}롤 (${range}) · 판매 가능 · 라벨 출력 요청됨`);
      }
      // 다음 원단으로 — 빈 등록 칸. 방금 것은 위에 남겨 둔다(새 품번이면 번호를 크게).
      setLastDone({ product, isNew, count: made.length, total: lensTotal, range });
      resetForm();
      await reloadRolls?.();
    } catch (e) {
      console.error("입고 등록 실패:", e);
      showToast("입고 등록 실패: " + rollErrorText(e), "error");
    } finally { setSavingRolls(false); }
  };

  // ── 섹션 B: 검단 대기 ──
  const [measured, setMeasured] = useState({});   // 롤 id → 입력 중인 실측값
  const [busyRoll, setBusyRoll] = useState(null);

  // 오래 기다린 롤부터. 같은 때 들어온 롤은 순번대로.
  const pending = useMemo(() => rolls
    .filter(r => r.status === "received")
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.rollCode.localeCompare(b.rollCode)),
  [rolls]);

  const inspect = async (roll) => {
    if (busyRoll) return;
    const parsed = parseMeasured(measured[roll.id]);
    if (!parsed.ok) { showToast(parsed.reason, "error"); return; }
    const v = parsed.value;
    const unit = productById.get(roll.productId)?.unit || "마";
    const by = activeManager || "";

    if (v === 0) {
      if (!window.confirm(`${roll.rollCode}\n\n실측이 0 입니다 — 전량 폐기로 처리할까요?\n\n폐기한 롤은 재고에서 빠지고 라벨도 나오지 않습니다.`)) return;
      setBusyRoll(roll.id);
      try {
        await db.scrapRoll(roll.id, "검단 전량 폐기", by);
        showToast(`전량 폐기 — ${roll.rollCode}`);
        await reloadRolls?.();
      } catch (e) {
        console.error("폐기 실패:", e);
        showToast("폐기 실패: " + rollErrorText(e), "error");
      } finally { setBusyRoll(null); }
      return;
    }

    if (v > (roll.lengthReceived || 0)
      && !window.confirm(`명세서보다 많습니다. 맞습니까?\n\n${roll.rollCode}\n명세서 ${fmtLen(roll.lengthReceived)}${unit} → 실측 ${fmtLen(v)}${unit}`)) return;

    setBusyRoll(roll.id);
    try {
      const { labelRequested } = await db.inspectRoll(roll.id, v, by);
      setMeasured(p => { const n = { ...p }; delete n[roll.id]; return n; });
      if (!labelRequested) {
        showToast(`검단 완료 — 다만 라벨 요청에 실패했습니다. 롤 재고에서 ${roll.rollCode} 의 '라벨 재출력'을 눌러 주세요`, "error");
      } else if (!labelStationRow) {
        // 담당 기기가 없으면 요청이 아무 데도 안 간다. 조용히 넘어가면 사람은 뽑힌 줄 알고
        // 프린터 앞에서 라벨을 찾는다.
        showToast("검단 완료 — 라벨 출력 요청됨 · 다만 라벨 출력 PC가 켜져 있지 않습니다", "error");
      } else {
        showToast("검단 완료 — 라벨 출력 요청됨");
      }
      await reloadRolls?.();
    } catch (e) {
      console.error("검단 실패:", e);
      showToast("검단 실패: " + rollErrorText(e), "error");
    } finally { setBusyRoll(null); }
  };

  const bigBtn = (on) => ({
    width: "100%", padding: "14px", borderRadius: 10, border: "none",
    fontFamily: S, fontWeight: 800, fontSize: 15, cursor: on ? "pointer" : "not-allowed",
    background: on ? `linear-gradient(135deg,${G.copper},${G.copperLight})` : G.border,
    color: on ? G.white : G.creamMuted,
    boxShadow: on ? `0 4px 20px ${G.copperGlow}` : "none",
  });
  const thumb = (url, size = 56) => url
    ? <img src={url} alt="" onClick={() => window.open(url, "_blank")} style={{width:size,height:size,borderRadius:8,objectFit:"cover",border:`1px solid ${G.border}`,cursor:"zoom-in",flex:"none",display:"block"}}/>
    : <div style={{width:size,height:size,borderRadius:8,border:`1px dashed ${G.border}`,flex:"none",display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.4,opacity:0.35}}>🧵</div>;

  return (
    <div>
      {/* ── 섹션 A: 입고 등록 — 원단·가격·롤·위치 → 등록 (사진은 선택) ── */}
      <Card style={{marginBottom:12}}>
        <SecTitle>입고 등록</SecTitle>

        {/* 방금 등록한 것 — 다음 원단을 적기 시작할 때까지 남겨 둔다 */}
        {lastDone && idle && (
          <div style={{marginBottom:12,padding:"10px 12px",background:G.greenBg,borderRadius:10,display:"flex",alignItems:"center",gap:10}}>
            {thumb(productById.get(lastDone.product.id)?.photoUrl || lastDone.product.photoUrl, 44)}
            <div style={{minWidth:0,flex:1,fontSize:12.5,color:G.cream,lineHeight:1.5}}>
              <div style={{fontWeight:800,color:G.green}}>✓ 방금 등록 — {lastDone.count}롤 · {fmtLen(lastDone.total)}{unitOf(lastDone.product)}{lastDone.isNew ? " · 새 품번" : ""}</div>
              <div><span style={{fontFamily:"monospace",fontWeight:900,color:G.copper,fontSize:lastDone.isNew ? 16 : 13}}>{lastDone.product.code}</span> {lastDone.product.name}{lastDone.product.color ? ` · ${lastDone.product.color}` : ""}</div>
            </div>
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
          onChange={e => { const f = e.target.files?.[0]; if (f) setPhoto(f); e.target.value = ""; }}/>

        {(
          <div>
            {/* 사진 — 선택. 휴대폰이면 바로 카메라가 열린다. PC 에서는 그림을 붙여넣어도 된다 */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              {photo
                ? <img src={photoUrl} alt="" style={{width:76,height:76,borderRadius:10,objectFit:"cover",border:`1.5px solid ${G.copper}`,flex:"none"}}/>
                : thumb(pickedNow?.photoUrl, 76)}
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <GhostBtn onClick={() => fileRef.current?.click()} small>📷 {photo ? "다시 찍기" : "사진 찍기 (선택)"}</GhostBtn>
                {photo && <GhostBtn onClick={() => setPhoto(null)} small>사진 빼기</GhostBtn>}
              </div>
              <button onClick={resetForm} style={{marginLeft:"auto",alignSelf:"flex-start",padding:"4px 8px",border:"none",background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:11.5,textDecoration:"underline",cursor:"pointer"}}>처음부터</button>
            </div>
            {photo && pickedNow?.photoUrl && (
              <div style={{fontSize:11,color:G.creamMuted,marginTop:-6,marginBottom:10}}>이 품번에는 사진이 이미 있어 찍은 사진은 붙이지 않습니다</div>
            )}

            {/* 원단명 — 있는 원단은 목록에서 고르고, 처음 들어온 원단은 이름만 */}
            <div style={{marginBottom:10}}>
              <FLabel>원단명 *</FLabel>
              <div style={{display:"flex",gap:6}}>
                <div style={{position:"relative",flex:1,minWidth:0}}>
                  <input value={q}
                    onChange={e => { setQ(e.target.value); setPicked(null); }}
                    onFocus={() => setQFocus(true)}
                    onBlur={() => setTimeout(() => setQFocus(false), 150)}
                    placeholder="예: 린넨코튼 (있는 원단은 목록에서 고르기)"
                    style={{...baseInp,fontWeight:700,fontSize:15,border:`1px solid ${pickedNow || newOpen ? G.copper : "var(--border, #2E2820)"}`}}/>
                  {suggestions.length > 0 && (
                    <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:60,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,marginTop:2,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",maxHeight:280,overflowY:"auto"}}>
                      {suggestions.map(p => (
                        <div key={p.id} onMouseDown={() => pick(p)}
                          style={{padding:"8px 12px",cursor:"pointer",borderBottom:`1px solid ${G.border}`,fontFamily:S,display:"flex",alignItems:"center",gap:9}}
                          onMouseEnter={e => e.currentTarget.style.background = G.surface}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          {thumb(p.photoUrl, 34)}
                          <div style={{minWidth:0}}>
                            <div style={{fontSize:12,fontWeight:800,color:G.copper,fontFamily:"monospace"}}>{p.code}</div>
                            <div style={{fontSize:12.5,fontWeight:700,color:G.cream,overflowWrap:"anywhere"}}>{p.name}{p.color ? ` · ${p.color}` : ""}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {pickedNow && <GhostBtn onClick={unpick}>다시 고르기</GhostBtn>}
              </div>
              {pickedNow ? (
                <div style={{display:"flex",alignItems:"center",gap:8,marginTop:5,fontSize:12,color:G.cream,flexWrap:"wrap"}}>
                  <span>✓ 기존 원단 <b style={{fontFamily:"monospace",color:G.copper}}>{pickedNow.code}</b> {pickedNow.name}{pickedNow.color ? ` · ${pickedNow.color}` : ""}</span>
                  {/* 기존 품번의 담당자 — 바꾸면 바로 저장된다(품번 앞글자는 그대로). */}
                  <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11.5,color:G.creamMuted}}>담당
                    <select value={pickedNow.manager || ""} disabled={savingProduct || savingRolls}
                      onChange={async e => { const v = e.target.value; try { await db.updateProduct(pickedNow.id, { manager: v }); await reloadProducts?.(); showToast(`품번 담당자 — ${v || "없음"}`); } catch (err) { showToast("담당자 저장 실패: " + rollErrorText(err), "error"); } }}
                      style={{...baseInp,width:"auto",padding:"3px 6px",fontSize:11.5}}>
                      <option value="">없음</option>
                      {managers.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                    </select>
                  </label>
                  {!rolls.some(r => r.productId === pickedNow.id) && (
                    <button onClick={() => removeProduct(pickedNow)} disabled={savingProduct || savingRolls} title="롤이 하나도 없는 품번을 지웁니다"
                      style={{marginLeft:"auto",padding:"3px 8px",borderRadius:6,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>품번 삭제</button>
                  )}
                </div>
              ) : looksLikeCode && suggestions.length === 0 ? (
                <div style={{fontSize:11.5,color:G.red,fontWeight:700,marginTop:4}}>없는 품번입니다 — 처음 들어온 원단이면 원단명을 적어 주세요</div>
              ) : newOpen ? (
                <div style={{fontSize:11.5,color:sameProduct ? G.yellow : G.creamMuted,fontWeight:700,marginTop:4,lineHeight:1.5}}>
                  {sameProduct ? `⚠ 같은 이름의 품번이 이미 있습니다 — ${sameProduct.code}. 그 원단이면 목록에서 고르세요` : "새 원단 — 등록하면 품번이 자동으로 발급됩니다"}
                </div>
              ) : null}
            </div>

            {/* 가격 */}
            <div style={{marginBottom:10}}>
              <FLabel>가격 (원/{unitOf(pickedNow)}){pickedNow ? " — 바꾸면 이 원단 가격도 바뀝니다" : ""}</FLabel>
              <input type="text" inputMode="numeric"
                value={price ? Number(String(price).replace(/[^0-9]/g, "")).toLocaleString() : ""}
                onChange={e => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="0" style={{...baseInp,fontFamily:SF,fontSize:16,fontWeight:800}}/>
            </div>

            {/* 품번 담당자 — 새 원단일 때만 고른다. 품번 앞글자가 이 사람의 이니셜로 발급된다. */}
            {newOpen && !pickedNow && (
              <div style={{marginBottom:10}}>
                <FLabel>담당자 (이 원단의 주인)</FLabel>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <select value={ownerName} onChange={e => setOwner(e.target.value)} style={{...baseInp,width:"auto",minWidth:120}}>
                    {!managers.some(m => m.name === ownerName) && <option value={ownerName}>{ownerName || "없음"}</option>}
                    {managers.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                  </select>
                  <span style={{fontSize:11.5,color:G.creamMuted}}>품번은 <b style={{fontFamily:"monospace",color:G.copper}}>{ownerPrefix}-YYMM-####</b> 로 발급됩니다{ownerPrefix === "LH" ? " (이니셜 없음 — 설정 > 담당자에서 정할 수 있습니다)" : ""}</span>
                </div>
              </div>
            )}

            {/* 롤 수 — − / + 로 바꾸면 아래 길이 칸이 그만큼 늘고 준다 */}
            <FLabel>롤 수 *</FLabel>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <button type="button" onClick={() => setCount(Math.max(1, count - 1))} disabled={count <= 1} aria-label="롤 하나 빼기"
                style={{width:44,height:44,borderRadius:10,border:`1px solid ${G.border}`,background:"transparent",color:G.cream,fontSize:22,fontWeight:800,cursor:count<=1?"not-allowed":"pointer",opacity:count<=1?0.4:1}}>−</button>
              <input type="number" min="1" max="99" step="1" inputMode="numeric" value={rf.count} onChange={e => setCount(e.target.value)}
                style={{...baseInp,width:70,textAlign:"center",fontFamily:SF,fontSize:18,fontWeight:800}}/>
              <button type="button" onClick={() => setCount(Math.min(99, count + 1))} disabled={count >= 99} aria-label="롤 하나 더하기"
                style={{width:44,height:44,borderRadius:10,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:22,fontWeight:800,cursor:"pointer"}}>＋</button>
              <span style={{fontSize:12,color:G.creamMuted}}>롤</span>
            </div>

            {/* 롤마다 길이 — 이 값이 그대로 남은 길이가 되어 바로 판매 가능, 라벨에도 찍힌다 */}
            <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:8}}>
              <FLabel>롤마다 길이 ({unitOf(pickedNow)}) *</FLabel>
              {count > 1 && rf.lengths[0] && (
                <button type="button" onClick={fillAll} style={{padding:"3px 9px",borderRadius:7,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:11.5,fontWeight:700,cursor:"pointer"}}>
                  1번 값으로 모두 채우기
                </button>
              )}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(104px, 1fr))",gap:8,marginBottom:10}}>
              {rf.lengths.slice(0, count).map((v, i) => {
                const p = v ? parseMeasured(v) : null;
                return (
                  <div key={i}>
                    <div style={{fontSize:11,color:G.creamMuted,fontWeight:700,marginBottom:3}}>{i + 1}번 롤</div>
                    <div style={{position:"relative"}}>
                      <input type="text" inputMode="decimal" value={v} onChange={e => setLen(i, e.target.value)} placeholder="0"
                        aria-label={`${i + 1}번 롤 길이`}
                        style={{...baseInp,fontFamily:SF,fontSize:16,fontWeight:800,paddingRight:30,borderColor: p && !(p.ok && p.value > 0) ? G.red : baseInp.borderColor}}/>
                      <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:11,color:G.creamMuted}}>{unitOf(pickedNow)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 위치 */}
            <div style={{marginBottom:10}}>
              <FLabel>위치</FLabel>
              <input value={rf.location} onChange={e => setRf(p => ({...p,location:e.target.value}))} placeholder="A-03" style={baseInp}/>
            </div>

            {/* 더보기 — 공급처·색상·메모 */}
            <button type="button" onClick={() => setMore(v => !v)} style={{padding:"10px 12px",borderRadius:9,border:`1px dashed ${G.border}`,background:"transparent",color:G.creamMuted,fontFamily:S,fontSize:12.5,fontWeight:800,cursor:"pointer"}}>
              {more ? "▲ 접기" : "▼ 더보기 — 공급처 · 색상 · 메모"}
            </button>
            {more && (
              <div style={{marginTop:4,marginBottom:10,padding:"10px 12px",background:G.surface,borderRadius:10}}>
                <div style={{marginBottom:8}}><FLabel>공급처</FLabel>
                  <input value={rf.supplier} onChange={e => setRf(p => ({...p,supplier:e.target.value}))} placeholder="동대문 ○○" style={baseInp}/></div>
                {pickedNow ? (
                  <div style={{fontSize:11.5,color:G.creamMuted}}>색상·메모는 새 원단을 등록할 때만 적습니다 — 이 원단: {pickedNow.color || "색상 없음"}</div>
                ) : (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <div><FLabel>색상</FLabel>
                      <input value={np.color} onChange={e => setNp(p => ({...p,color:e.target.value}))} placeholder="베이지" style={baseInp}/></div>
                    <div><FLabel>메모</FLabel>
                      <input value={np.note} onChange={e => setNp(p => ({...p,note:e.target.value}))} placeholder="비고사항" style={baseInp}/></div>
                  </div>
                )}
              </div>
            )}

            {/* 더보기와 등록 버튼 사이를 띄우고 선을 긋는다 — 더보기를 누르려다 등록을 누르지 않게(2026-10-02) */}
            <div style={{height:1,background:G.border,margin:"22px 0 14px"}}/>
            {lensOk && (
              <div style={{fontSize:11.5,color:G.creamMuted,margin:"0 0 8px"}}>
                {count}롤 · 합계 <b style={{color:G.cream}}>{fmtLen(lensTotal)}{unitOf(pickedNow)}</b> · 등록하면 바로 판매 가능, 라벨이 나옵니다
              </div>
            )}
            <button onClick={receive} disabled={!canReceive} style={bigBtn(canReceive)}>
              {savingProduct ? (photo ? "사진 올리는 중..." : "품번 발급 중...") : savingRolls ? "등록 중..."
                : !pickedNow && !newOpen ? "📥 입고 등록 — 원단명을 적어 주세요"
                : !lensOk ? "📥 입고 등록 — 롤마다 길이를 적어 주세요"
                : newOpen ? `📥 새 원단 + 입고 등록 — ${count}롤 · 라벨 출력` : `📥 입고 등록 — ${count}롤 · 라벨 출력`}
            </button>
          </div>
        )}
      </Card>

      {/* ── 섹션 B: 검단 대기 — 입고만 해 둔 옛 롤·처리에 실패한 롤이 있을 때만 ── */}
      <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:8,flexWrap:"wrap",margin:"18px 0 8px"}}>
        <div style={{fontSize:11,color:G.copper,fontWeight:800,letterSpacing:"0.08em"}}>{pending.length ? `검단 대기 (${pending.length}롤)` : ""}</div>
        {labelStationRow && (
          <div style={{fontSize:11,color:G.creamMuted}}>
            🏷️ 라벨 출력 — <b style={{color:G.cream}}>{labelStationRow.deviceName || "이름 없는 기기"}</b>
            {labelStationHere ? " (이 컴퓨터)" : ""}
          </div>
        )}
      </div>
      {!labelStationRow && (
        <div role="alert" style={{marginBottom:10,padding:"9px 12px",borderRadius:9,border:`1px solid ${G.yellow}`,background:G.yellowBg,
          fontSize:12,fontWeight:700,color:G.yellow,lineHeight:1.55}}>
          라벨 출력 PC가 켜져 있지 않습니다. — 입고는 할 수 있지만 라벨은 담당 기기를 지정한 뒤에 나옵니다 (설정 → 라벨 자동 출력)
        </div>
      )}

      {pending.length === 0
        ? null
        : pending.map(r => {
          const p = productById.get(r.productId);
          const unit = p?.unit || "마";
          const busy = busyRoll === r.id;
          const val = measured[r.id] ?? "";
          const parsed = val ? parseMeasured(val) : null;
          return (
            <Card key={r.id} style={{marginBottom:8,border:`1px solid ${G.yellow}40`}}>
              <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                {thumb(p?.photoUrl, 48)}
                <div style={{minWidth:0,flex:1}}>
                  <div style={{fontFamily:"monospace",fontSize:14,fontWeight:900,color:G.copper,overflowWrap:"anywhere"}}>{r.rollCode}</div>
                  <div style={{fontSize:13,fontWeight:700,color:G.cream,overflowWrap:"anywhere"}}>{p?.name || "(품번 정보 없음)"}{p?.color ? ` · ${p.color}` : ""}</div>
                  <div style={{fontSize:11.5,color:G.creamMuted,lineHeight:1.6}}>
                    명세서 <b style={{color:G.cream}}>{fmtLen(r.lengthReceived)}{unit}</b> · 입고 {mdhm(r.createdAt)}
                    {r.supplier ? ` · ${r.supplier}` : ""}{r.location ? ` · 위치 ${r.location}` : ""}
                  </div>
                </div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",marginTop:10}}>
                <div style={{position:"relative",flex:1,minWidth:0}}>
                  <input type="text" inputMode="decimal" value={val} disabled={busy}
                    onChange={e => setMeasured(m => ({...m,[r.id]:e.target.value.replace(/[^0-9.]/g, "")}))}
                    onKeyDown={e => { if (e.key === "Enter") inspect(r); }}
                    placeholder="실측 수량" aria-label={`${r.rollCode} 실측 수량`}
                    style={{...baseInp,fontFamily:SF,fontSize:17,fontWeight:800,paddingRight:36}}/>
                  <span style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:12,color:G.creamMuted}}>{unit}</span>
                </div>
                <button onClick={() => inspect(r)} disabled={busy || !!busyRoll || !val} style={{
                  flex:"none",padding:"12px 18px",borderRadius:10,border:"none",fontFamily:S,fontSize:14,fontWeight:900,whiteSpace:"nowrap",
                  cursor: busy ? "wait" : val ? "pointer" : "not-allowed",
                  background: val ? G.copper : G.border, color: val ? "#fff" : G.creamMuted, opacity: busy ? 0.6 : 1}}>
                  {busy ? "처리 중…" : "검단 완료"}
                </button>
              </div>
              {parsed && !parsed.ok && <div style={{fontSize:11,color:G.red,fontWeight:700,marginTop:4}}>{parsed.reason}</div>}
              {parsed?.ok && parsed.value === 0 && <div style={{fontSize:11,color:G.red,fontWeight:700,marginTop:4}}>0 을 입력하면 전량 폐기로 처리합니다</div>}
              {parsed?.ok && parsed.value > 0 && parsed.value !== r.lengthReceived && (
                <div style={{fontSize:11,color:parsed.value > r.lengthReceived ? G.yellow : G.creamMuted,fontWeight:700,marginTop:4}}>
                  명세서보다 {fmtLen(Math.abs(parsed.value - r.lengthReceived))}{unit} {parsed.value > r.lengthReceived ? "많습니다" : "적습니다"}
                </div>
              )}
            </Card>
          );
        })}
    </div>
  );
}

export default InspectionTab;
