// 명세서 탭 — 입금완료(출고 전) 주문 목록에서 거래명세서를 일괄/선택/날짜별로 출력.
// 파일은 한글(HWPX) 하나로 내려가며 주문당 1페이지씩 담긴다.
import React, { useMemo, useState } from "react";
import { S, SF, baseInp, getPayStatus } from "../constants.js";

const dateKey = d => String(d || "").replace(/\D/g, ""); // "2026. 07. 14." / "2026-07-14" → "20260714"
// 연락처 가운데 4자리만 노출 — "010-1234-5678" → "1234" (동명이인 판별 기준과 동일 자리)
const midPhone = p => {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length === 4) return d;
  if (d.length >= 10) return d.slice(3, 7);
  return "";
};

export default function StatementTab({ orders, customers, showToast, T }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  // 입금완료 + 아직 출고 전 주문만 (주문현황과 같은 제외 규칙).
  // excluded: 활성 주문인데 입금 상태 때문에 빠진 것들의 상태별 건수 — 주문현황 건수와의
  // 차이가 어디서 났는지 화면에서 바로 보이게 한다.
  const { eligible, excluded } = useMemo(() => {
    const list = [];
    const excludedCnt = {};
    for (const o of orders || []) {
      if (o.status === "출고완료") continue;
      const cs = o._computed?.paymentStatus || o.payment;
      if (o.payment === "환불" || cs === "환불완료") continue;
      const pay = getPayStatus(o);
      if (pay === "입금완료") list.push(o);
      else excludedCnt[pay || "미입금"] = (excludedCnt[pay || "미입금"] || 0) + 1;
    }
    list.sort((a, b) => (dateKey(b.date) + (b.time || "")).localeCompare(dateKey(a.date) + (a.time || "")));
    return { eligible: list, excluded: excludedCnt };
  }, [orders]);

  const list = useMemo(() => {
    const f = dateKey(dateFrom), t = dateKey(dateTo);
    const q = search.trim().toLowerCase();
    return eligible.filter(o => {
      const k = dateKey(o.date);
      if (f && (!k || k < f)) return false;
      if (t && (!k || k > t)) return false;
      if (q && !(
        (o.customer || "").toLowerCase().includes(q) ||
        (o.phone || "").includes(q) ||
        String(o.id).toLowerCase().includes(q) ||
        (o.items || []).some(it => (it.fabric || "").toLowerCase().includes(q))
      )) return false;
      return true;
    });
  }, [eligible, dateFrom, dateTo, search]);

  const listIds = useMemo(() => new Set(list.map(o => o.id)), [list]);
  const selectedInList = [...selected].filter(id => listIds.has(id));
  const allChecked = list.length > 0 && selectedInList.length === list.length;

  const toggle = id => setSelected(p => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(list.map(o => o.id)));

  const download = async targets => {
    if (busy) return;
    if (targets.length === 0) { showToast("출력할 주문이 없습니다", "error"); return; }
    setBusy(true);
    try {
      const { downloadStatementsHwpx } = await import("../lib/statementHwpx.js");
      const r = await downloadStatementsHwpx(targets, customers);
      showToast(r.pages < r.orders
        ? `주문 ${r.orders}건 → 명세서 ${r.pages}장 다운로드 완료 (합배송 병합)`
        : `거래명세서 ${r.pages}건 다운로드 완료 — 한글에서 열어 인쇄하세요`);
    } catch (e) {
      console.error("[명세서]", e);
      showToast("명세서 생성 실패: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const orderSum = o => {
    const itemsSum = (o.items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    return o.totalAmount > 0 ? o.totalAmount : itemsSum + (Number(o.shippingFee) || 0) + (Number(o.otherCost) || 0);
  };

  const btn = (label, onClick, { primary = false, disabled = false } = {}) => (
    <button onClick={onClick} disabled={disabled || busy} style={{
      padding: "9px 14px", borderRadius: 10, fontFamily: S, fontSize: 12, fontWeight: 700,
      cursor: disabled || busy ? "not-allowed" : "pointer", opacity: disabled || busy ? 0.45 : 1,
      border: primary ? "none" : `1px solid ${T.copper}60`,
      background: primary ? `linear-gradient(135deg,${T.copper},${T.copperLight})` : T.copperGlow,
      color: primary ? T.white : T.copper,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800 }}>🧾 명세서 출력 대기 <span style={{ color: T.copper }}>{eligible.length}건</span></div>
        <div style={{ fontSize: 11, color: T.creamMuted }}>
          입금완료된 주문만 표시 · 출고완료는 자동 제외
          {Object.keys(excluded).length > 0 && (
            <span> · 입금 상태로 제외: {Object.entries(excluded).map(([k, v]) => `${k} ${v}건`).join(", ")}</span>
          )}
        </div>
      </div>

      {/* 필터 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...baseInp, width: 150, background: T.surface, color: T.cream, border: `1px solid ${T.border}` }} />
        <span style={{ color: T.creamMuted, fontSize: 12 }}>~</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...baseInp, width: 150, background: T.surface, color: T.cream, border: `1px solid ${T.border}` }} />
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={{ fontSize: 11, color: T.creamMuted, background: "transparent", border: "none", cursor: "pointer", fontFamily: S }}>날짜 초기화</button>
        )}
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="고객명·연락처·주문번호·원단 검색" style={{ ...baseInp, flex: 1, minWidth: 180, background: T.surface, color: T.cream, border: `1px solid ${T.border}` }} />
      </div>

      {/* 출력 버튼 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {btn(busy ? "생성 중..." : `🧾 전체 출력 (${list.length}건)`, () => download(list), { primary: true, disabled: list.length === 0 })}
        {btn(`☑ 선택 출력 (${selectedInList.length}건)`, () => download(list.filter(o => selected.has(o.id))), { disabled: selectedInList.length === 0 })}
        {(dateFrom || dateTo) && <span style={{ fontSize: 11, color: T.creamMuted }}>날짜 필터 적용 중 — 전체 출력은 필터된 {list.length}건 기준</span>}
      </div>

      {/* 목록 */}
      {list.length === 0 ? (
        <div style={{ padding: "36px 0", textAlign: "center", color: T.creamMuted, fontSize: 13, background: T.surface, borderRadius: 12, border: `1px solid ${T.border}` }}>
          조건에 맞는 입금완료 주문이 없습니다
        </div>
      ) : (
        <div style={{ background: T.card, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: T.surface, borderBottom: `1px solid ${T.border}`, fontSize: 11, color: T.creamMuted, fontWeight: 700 }}>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ accentColor: T.copper, width: 15, height: 15, cursor: "pointer" }} />
            <span style={{ width: 90 }}>고객</span>
            <span style={{ width: 56 }}>연락처</span>
            <span style={{ flex: 1 }}>품목</span>
            <span style={{ width: 84, textAlign: "right" }}>주문일</span>
            <span style={{ width: 80, textAlign: "right" }}>총액</span>
            <span style={{ width: 34 }}></span>
          </div>
          {list.map(o => {
            const checked = selected.has(o.id);
            const itemsLabel = (o.items || []).map(it => `${it.fabric || ""}${it.color ? " " + it.color : ""} ${it.qty || 0}${it.unit || "마"}`).filter(s => s.trim()).join(", ");
            return (
              <div key={o.id} onClick={() => toggle(o.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${T.border}40`, cursor: "pointer", background: checked ? T.copperGlow : "transparent" }}>
                <input type="checkbox" checked={checked} readOnly style={{ accentColor: T.copper, width: 15, height: 15, cursor: "pointer", flexShrink: 0 }} />
                <span style={{ width: 90, fontSize: 12, fontWeight: 700, color: T.cream, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.customer}</span>
                <span style={{ width: 56, fontFamily: SF, fontSize: 14, fontWeight: 700, color: T.copper, flexShrink: 0 }}>{midPhone(o.phone) || "—"}</span>
                <span style={{ flex: 1, fontSize: 12, color: T.creamMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{itemsLabel || "(상품 없음)"}</span>
                <span style={{ width: 84, textAlign: "right", fontSize: 11, color: T.creamMuted, flexShrink: 0 }}>{o.date}</span>
                <span style={{ width: 80, textAlign: "right", fontSize: 12, fontWeight: 700, color: T.cream, flexShrink: 0 }}>{orderSum(o).toLocaleString()}원</span>
                <button onClick={e => { e.stopPropagation(); download([o]); }} title="이 주문만 출력" style={{ width: 34, padding: "4px 0", borderRadius: 6, border: `1px solid ${T.border}`, background: "transparent", color: T.creamMuted, fontSize: 12, cursor: "pointer", flexShrink: 0 }}>🧾</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
