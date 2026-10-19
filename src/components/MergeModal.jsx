import { useState, useMemo, useEffect } from "react";
import { Card } from "./UI.jsx";
import { SF, S, baseInp, useTheme } from "../constants.js";
import * as db from "../lib/db.js";

// 합배송 묶기 모달
// - 접수 상태 주문 전체가 후보 (합배송은 다른 고객끼리 묶는 경우가 많음)
// - 같은 고객 > 같은 배송지 > 메모에 서로 언급 > 같은 연락처 > 합배송 표시 순으로 위에 정렬
// - 시작 주문(sourceOrder)은 자동 선택 + 잠금
// - 같은 그룹 기존 멤버가 있으면 그 그룹에 합류 (새 UUID 생성 안 함)
//
// commit=false 모드 (주문 등록 전 미리 묶을 대상 선택용):
//   - DB 호출 없음 — 선택된 ID 배열만 onConfirm({ ids, initialIds })로 반환
//   - sourceOrder._isNew 면 헤더에 "현재 입력 중인 주문" 으로 표시
// sameCustomerOnly: 포장 담당자 등 — 같은 고객 묶기만 허용 ('다른 고객이랑 묶기' 확장 숨김)
export function MergeModal({ sourceOrder, orders, customers, onConfirm, onClose, showToast, commit = true, initialIds, sameCustomerOnly = false }) {
  const G = useTheme();
  const [q, setQ] = useState("");
  const [showOthers, setShowOthers] = useState(false); // 기본은 같은 고객만 — '다른 고객이랑 묶기'로 확장

  const normAddr = s => (s || "").replace(/\s+/g, "").toLowerCase();
  const digits = s => String(s || "").replace(/\D/g, "");
  const nickOf = name => (customers || []).find(c => c.name === name)?.nickname || "";
  // 메모류에서 합배송 언급 힌트 추출 — "(미송님 합)" 같은 문구
  const hintOf = o => [o.note, o.memo, o.deliveryMessage].filter(t => t && /합/.test(t))[0] || "";
  const srcHintAll = `${sourceOrder.note || ""} ${sourceOrder.memo || ""} ${sourceOrder.deliveryMessage || ""}`;

  // 접수 상태 전체 후보 + 연관도 점수 정렬 (검색어로 좁히기 가능)
  const candidates = useMemo(() => {
    const base = (orders || []).filter(o => o.status === "접수" && o.id !== sourceOrder.id);
    const score = o => {
      let s = 0;
      if (sourceOrder.customer && o.customer === sourceOrder.customer) s += 100;
      if (normAddr(o.address) && normAddr(o.address) === normAddr(sourceOrder.address)) s += 80;
      const hint = `${o.note || ""} ${o.memo || ""} ${o.deliveryMessage || ""}`;
      if (sourceOrder.customer && hint.includes(sourceOrder.customer)) s += 70; // 상대 메모에 내 고객명
      if (o.customer && srcHintAll.includes(o.customer)) s += 70;               // 내 메모에 상대 고객명
      if (digits(o.phone) && digits(o.phone) === digits(sourceOrder.phone)) s += 60;
      if (o.combinedShipping) s += 30;
      return s;
    };
    const ql = q.trim().toLowerCase();
    return base
      .filter(o => !ql
        || (o.customer || "").toLowerCase().includes(ql)
        || nickOf(o.customer).toLowerCase().includes(ql)
        || (o.phone || "").includes(ql)
        || (o.address || "").toLowerCase().includes(ql)
        || (o.items || []).some(i => (i.fabric || "").toLowerCase().includes(ql) || (i.color || "").toLowerCase().includes(ql)))
      .map(o => ({ o, s: score(o) }))
      .sort((a, b) => b.s - a.s || String(b.o.date || "").localeCompare(String(a.o.date || "")))
      .slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, sourceOrder, q, customers]);

  // 기본 노출은 같은 고객 주문만 — showOthers 켜면 전체(연관도순)
  const visible = showOthers ? candidates : candidates.filter(({ o }) => sourceOrder.customer && o.customer === sourceOrder.customer);

  const [selected, setSelected] = useState(() => {
    const s = new Set([sourceOrder.id]);
    (initialIds || []).forEach(id => s.add(id));
    return s;
  });
  const toggle = (id) => {
    if (id === sourceOrder.id) return; // 본인 강제 포함
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const onConfirmClick = async () => {
    if (selected.size < 2) { showToast?.("합배송하려면 2건 이상 선택", "error"); return; }
    const allIds = Array.from(selected);
    const otherIds = allIds.filter(id => id !== sourceOrder.id);

    if (!commit) {
      // 미리보기 모드: DB 변경 없이 선택 결과만 반환
      onConfirm?.({ ids: otherIds });
      onClose?.();
      return;
    }
    try {
      // 선택된 주문 중 기존 그룹 ID가 있으면 재사용, 없으면 새 UUID 생성
      const existing = allIds
        .map(id => orders.find(o => o.id === id))
        .filter(o => o?.mergeGroupId)
        .map(o => o.mergeGroupId)[0];
      const groupId = existing || (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `mg_${Date.now()}_${Math.random().toString(36).slice(2,10)}`);
      await db.setMergeGroup(allIds, groupId);
      // 묶인 뒤 출고일(가장 늦은 날)·택배비(한 건만)를 규칙대로 — 3단계. 실패해도 묶음 자체는 됐다.
      let res = null;
      try {
        const members = allIds.map(id => orders.find(o => o.id === id)).filter(Boolean).map(o => ({ ...o, mergeGroupId: groupId }));
        res = await db.afterGroupChange(members, { route: "합배송 묶기" });
      } catch (e) {
        console.error("합배송 출고일·택배비 조정 실패:", e);
        showToast?.("묶였지만 출고일·택배비 자동 조정에 실패했습니다: " + e.message, "error");
      }
      onConfirm?.(groupId, allIds, res);
      showToast?.(res?.freight?.conflict
        ? `${allIds.length}건 합배송 묶음 — 입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다`
        : `${allIds.length}건 합배송 묶음`, res?.freight?.conflict ? "error" : undefined);
      onClose?.();
    } catch (e) {
      showToast?.("합배송 실패: " + e.message, "error");
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: G.card, borderRadius: 16, border: `1px solid ${G.border}`, padding: 20, width: "100%", maxWidth: 480, maxHeight: "100%", overflow: "auto" /* 85vh -> 100%: .erp-root 의 zoom(글씨 배율) 이 vh 를 그만큼 부풀린다 — 배율 1.3 이면 85vh 가 화면의 110% 가 되어 모달 위아래가 잘렸다. 오버레이(position:fixed, inset:0)는 배율에 안 부풀므로 그 100%(패딩 16 제외)를 기준으로 삼는다. */ }}>
        <div style={{ fontFamily: SF, fontSize: 18, fontWeight: 800, color: G.purple, marginBottom: 6 }}>🔗 합배송 묶기</div>
        <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 10 }}>
          {showOthers
            ? <>함께 묶을 접수 상태 주문을 선택하세요. <b style={{ color: G.cream }}>같은 배송지 · 메모에 서로를 언급한 주문</b>이 위로 정렬됩니다.</>
            : <>같은 고객(<b style={{ color: G.cream }}>{sourceOrder.customer}</b>)의 접수 상태 주문을 함께 묶습니다.</>}
          {commit && <div style={{ marginTop: 4 }}>묶으면 출고예정일은 <b style={{ color: G.cream }}>가장 늦은 주문</b>에 맞춰지고(긴급 건 제외), 택배비는 한 건에만 남습니다.</div>}
        </div>

        {/* 본인(시작 주문) — 잠금 */}
        <div style={{ padding: "10px 12px", background: G.copperGlow, borderRadius: 8, border: `1px solid ${G.copper}`, marginBottom: 8, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input type="checkbox" checked readOnly style={{ accentColor: G.copper }} />
            <span style={{ fontWeight: 700, color: G.copper }}>{sourceOrder._isNew ? "🆕 현재 입력 중인 주문" : "현재 주문 (자동 포함)"}</span>
            <span style={{ fontWeight: 800, color: G.cream }}>{sourceOrder.customer}{nickOf(sourceOrder.customer) ? ` (${nickOf(sourceOrder.customer)})` : ""}</span>
          </div>
          <div style={{ fontSize: 11, color: G.cream, marginTop: 6, marginLeft: 24 }}>
            {sourceOrder._isNew ? "" : `#${String(sourceOrder.id).slice(0, 8)} · `}{sourceOrder.date} · {(sourceOrder.items || []).map(i => `${i.fabric || "?"} ${i.qty}${i.unit || "마"}`).join(", ")}
          </div>
          {(sourceOrder.address || hintOf(sourceOrder)) && (
            <div style={{ fontSize: 10, color: G.creamMuted, marginTop: 3, marginLeft: 24 }}>
              {sourceOrder.address ? `📍 ${sourceOrder.address}${sourceOrder.addressDetail ? ` ${sourceOrder.addressDetail}` : ""}` : ""}
              {hintOf(sourceOrder) && <span style={{ color: G.purple, fontWeight: 700 }}> · 📝 {hintOf(sourceOrder)}</span>}
            </div>
          )}
        </div>

        {/* 후보 검색 — 다른 고객 후보를 볼 때만 필요 */}
        {showOthers && (
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="고객명 · 닉네임 · 연락처 · 주소 · 원단으로 검색"
            style={{ ...baseInp, width: "100%", boxSizing: "border-box", fontSize: 12, marginBottom: 8, background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }} />
        )}

        {/* 후보 주문 — 연관도순 */}
        {visible.length === 0 ? (
          <div style={{ padding: 12, background: G.surface, borderRadius: 8, fontSize: 12, color: G.creamMuted, textAlign: "center" }}>
            {showOthers ? "함께 묶을 다른 접수 주문이 없습니다." : "같은 고객의 다른 접수 주문이 없습니다."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visible.map(({ o, s }) => {
              const checked = selected.has(o.id);
              const inGroup = !!o.mergeGroupId;
              const nick = nickOf(o.customer);
              const sameCust = sourceOrder.customer && o.customer === sourceOrder.customer;
              const sameAddr = !sameCust && normAddr(o.address) && normAddr(o.address) === normAddr(sourceOrder.address);
              const mentioned = !sameCust && ((sourceOrder.customer && `${o.note || ""} ${o.memo || ""} ${o.deliveryMessage || ""}`.includes(sourceOrder.customer)) || (o.customer && srcHintAll.includes(o.customer)));
              const hint = hintOf(o);
              return (
                <label key={o.id} onClick={() => toggle(o.id)} style={{
                  padding: "10px 12px", background: checked ? G.copperGlow : G.surface,
                  borderRadius: 8, border: `1px solid ${checked ? G.copper : (s >= 60 ? `${G.purple}66` : G.border)}`,
                  fontSize: 12, cursor: "pointer", display: "block",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <input type="checkbox" checked={checked} readOnly style={{ accentColor: G.copper }} />
                    <span style={{ fontWeight: 800, color: checked ? G.copper : G.cream }}>{o.customer}{nick ? <span style={{ fontWeight: 500, color: G.creamMuted, fontSize: 11 }}> ({nick})</span> : null}</span>
                    <span style={{ fontFamily: SF, fontSize: 10, color: G.copper, fontWeight: 700 }}>#{String(o.id).slice(0, 8)}</span>
                    <span style={{ fontSize: 10, color: G.creamMuted }}>{o.date}</span>
                    {sameCust && <span style={{ fontSize: 9, fontWeight: 800, color: G.green, background: G.greenBg, padding: "1px 5px", borderRadius: 4 }}>같은 고객</span>}
                    {sameAddr && <span style={{ fontSize: 9, fontWeight: 800, color: G.green, background: G.greenBg, padding: "1px 5px", borderRadius: 4 }}>📍 같은 배송지</span>}
                    {mentioned && <span style={{ fontSize: 9, fontWeight: 800, color: G.purple, background: "rgba(138,106,184,0.14)", padding: "1px 5px", borderRadius: 4 }}>📝 메모에 언급</span>}
                    {o.combinedShipping && <span style={{ fontSize: 9, fontWeight: 700, color: G.copper, background: G.copperGlow, padding: "1px 5px", borderRadius: 4 }}>📦 합배송</span>}
                    {inGroup && <span style={{ fontSize: 9, fontWeight: 800, color: G.purple, background: "rgba(138,106,184,0.12)", padding: "1px 5px", borderRadius: 4 }}>🔗 기존 그룹</span>}
                  </div>
                  <div style={{ fontSize: 11, color: G.creamMuted, marginTop: 4, marginLeft: 24 }}>
                    {(o.items || []).map(i => `${i.fabric || "?"}${i.color ? ` ${i.color}` : ""} ${i.qty}${i.unit || "마"}`).join(", ")}
                  </div>
                  {(o.address || o.phone) && (
                    <div style={{ fontSize: 10, color: G.creamMuted, marginTop: 2, marginLeft: 24, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.address ? `📍 ${o.address}${o.addressDetail ? ` ${o.addressDetail}` : ""}` : ""}{o.address && o.phone ? " · " : ""}{o.phone || ""}
                    </div>
                  )}
                  {hint && (
                    <div style={{ fontSize: 10, color: G.purple, fontWeight: 700, marginTop: 2, marginLeft: 24, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      📝 {hint}
                    </div>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {/* 다른 고객 주문과 묶기 — 작게, 필요할 때만 확장 (sameCustomerOnly 모드에선 숨김) */}
        {!showOthers && !sameCustomerOnly && (
          <button onClick={() => setShowOthers(true)} style={{ marginTop: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, color: G.purple, background: "transparent", border: `1px dashed ${G.purple}66`, borderRadius: 7, cursor: "pointer", fontFamily: S }}>
            👥 다른 고객이랑 묶기
          </button>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${G.border}`, background: "transparent", color: G.creamMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: S }}>
            취소
          </button>
          <button onClick={onConfirmClick} disabled={selected.size < 2} style={{
            flex: 2, padding: "10px", borderRadius: 8, border: "none",
            background: selected.size >= 2 ? `linear-gradient(135deg,${G.purple},#A084C8)` : G.border,
            color: selected.size >= 2 ? "#fff" : G.creamMuted,
            fontWeight: 800, fontSize: 13, cursor: selected.size >= 2 ? "pointer" : "not-allowed", fontFamily: S,
          }}>
            🔗 {selected.size}건 합배송 묶기
          </button>
        </div>
      </div>
    </div>
  );
}

// 합배송 그룹 운임비 조정 모달
// 그룹 전체 운임비 = 사용자 입력값 1건만 (선택한 주문에 부여, 나머지는 0)
export function FreightModal({ targetOrder, groupOrders, onConfirm, onClose, showToast }) {
  const G = useTheme();
  const initial = (targetOrder?.shippingFee || 0).toString();
  const [amount, setAmount] = useState(initial);
  const [bearer, setBearer] = useState(targetOrder?.id);

  useEffect(() => { setBearer(targetOrder?.id); }, [targetOrder]);

  const onConfirmClick = async () => {
    const n = parseInt(String(amount).replace(/[^0-9]/g, ""), 10) || 0;
    if (n < 0) { showToast?.("운임비는 0 이상", "error"); return; }
    try {
      // 모든 그룹 멤버 shipping_fee = 0, 선택한 1건만 = n.
      // 사람이 정한 값이다 — 자동으로 내려놓았던 금액(feeHeld)은 지운다. 남겨 두면 나중에 풀릴 때 옛 금액이 되살아난다.
      await Promise.all(groupOrders.map(o =>
        db.updateOrder(o.id, { shipping_fee: o.id === bearer ? n : 0, feeHeld: null })
      ));
      onConfirm?.({ bearerId: bearer, amount: n });
      showToast?.(`그룹 운임비 ${n.toLocaleString()}원 부여 완료`);
      onClose?.();
    } catch (e) {
      showToast?.("운임비 조정 실패: " + e.message, "error");
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, backdropFilter: "blur(4px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: G.card, borderRadius: 16, border: `1px solid ${G.border}`, padding: 20, width: "100%", maxWidth: 440 }}>
        <div style={{ fontFamily: SF, fontSize: 18, fontWeight: 800, color: G.copper, marginBottom: 6 }}>💰 합배송 운임비 조정</div>
        <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 14 }}>
          그룹 전체 운임비를 한 주문에 1건만 부여합니다. 나머지는 0원으로 자동 설정.
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 4, fontWeight: 600 }}>운임비 (원)</div>
          <input value={amount} onChange={e => setAmount(e.target.value)} type="text" inputMode="numeric"
            style={{ ...baseInp, fontSize: 14, fontWeight: 700, background: G.inputBg, border: `1px solid ${G.border}`, color: G.cream }}
            placeholder="3000" />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: G.creamMuted, marginBottom: 6, fontWeight: 600 }}>운임비 부여 대상 주문</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {groupOrders.map(o => (
              <label key={o.id} onClick={() => setBearer(o.id)} style={{
                padding: "8px 10px", background: bearer === o.id ? G.copperGlow : G.surface,
                borderRadius: 6, border: `1px solid ${bearer === o.id ? G.copper : G.border}`,
                fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
              }}>
                <input type="radio" checked={bearer === o.id} readOnly style={{ accentColor: G.copper }} />
                <span style={{ fontWeight: 700, color: bearer === o.id ? G.copper : G.cream, flex: 1 }}>
                  #{String(o.id).slice(0, 8)} · {o.customer}
                </span>
                <span style={{ fontSize: 10, color: G.creamMuted }}>현재 {(o.shippingFee || 0).toLocaleString()}원</span>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", borderRadius: 8, border: `1px solid ${G.border}`, background: "transparent", color: G.creamMuted, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: S }}>
            취소
          </button>
          <button onClick={onConfirmClick} style={{
            flex: 2, padding: "10px", borderRadius: 8, border: "none",
            background: `linear-gradient(135deg,${G.copper},${G.copperLight})`,
            color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: S,
          }}>
            적용
          </button>
        </div>
      </div>
    </div>
  );
}
