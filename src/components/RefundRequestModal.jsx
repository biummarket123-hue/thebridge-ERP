import { useState } from "react";
import { S, SF, baseInp } from "../constants.js";

// 직원 환불 신청 모달 — 방식(현금/적립금) · 범위(전액/부분) · 금액 · 사유를 담아
// 대표(정산관리)에게 넘긴다. 대표는 이 정보를 확인/조정 후 승인한다.
// initialAmount: 교환 차액 등 특정 금액이 정해진 채 열릴 때 — 부분환불 + 해당 금액이 기본값이 된다.
export default function RefundRequestModal({ order, paid, requestedBy, onSubmit, onClose, G, initialAmount = null, initialReason = "" }) {
  const useInit = initialAmount != null && initialAmount > 0 && initialAmount < (paid || 0);
  const [method, setMethod] = useState("cash");   // cash | credit
  const [kind, setKind] = useState(useInit ? "partial" : "full");        // full | partial
  const [amountInput, setAmountInput] = useState(useInit ? String(initialAmount) : String(paid || ""));
  const [reason, setReason] = useState(initialReason || "");
  // 현금환불 계좌 정보 — 계좌명(예금주)은 고객명이 기본값, 수정 가능
  const [bank, setBank] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountHolder, setAccountHolder] = useState(order?.customer || "");
  const [submitting, setSubmitting] = useState(false);

  // 전액이면 금액 = 입금액(paid) 자동, 부분이면 입력값
  const amount = kind === "full" ? (paid || 0) : (parseInt(String(amountInput).replace(/[^0-9]/g, "")) || 0);

  const overlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)", padding: 16 };
  const modal = { background: G.card, borderRadius: 16, border: `1px solid ${G.border}`, boxShadow: "0 8px 30px rgba(0,0,0,0.3)", padding: 22, width: "100%", maxWidth: 380, boxSizing: "border-box" };

  const seg = (active, color) => ({
    flex: 1, padding: "10px 8px", borderRadius: 9, fontSize: 13, fontWeight: active ? 800 : 600,
    border: `1.5px solid ${active ? color : G.border}`, background: active ? `${color}1A` : "transparent",
    color: active ? color : G.creamMuted, cursor: "pointer", fontFamily: S,
  });

  const submit = async () => {
    if (amount <= 0) return;
    if (amount > (paid || 0)) return;
    setSubmitting(true);
    try {
      await onSubmit({
        method, kind, amount,
        reason: reason.trim(),
        // 현금환불일 때만 계좌 정보 포함 (적립금환불은 계좌 불필요)
        ...(method === "cash" ? {
          bank: bank.trim(),
          accountNumber: accountNumber.trim(),
          accountHolder: accountHolder.trim(),
        } : {}),
        requestedBy: requestedBy || "",
        requestedAt: new Date().toISOString(),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const overLimit = amount > (paid || 0);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 800, color: G.red, marginBottom: 4 }}>환불 신청</div>
        <div style={{ fontSize: 12, color: G.creamMuted, marginBottom: 16 }}>
          <b style={{ color: G.cream }}>{order.customer}</b> · 입금액 {(paid || 0).toLocaleString()}원
        </div>

        {/* 환불 방식 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: G.creamMuted, marginBottom: 6 }}>환불 방식</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => setMethod("cash")} style={seg(method === "cash", G.red)}>💵 현금환불</button>
            <button type="button" onClick={() => setMethod("credit")} style={seg(method === "credit", G.purple)}>🪙 적립금환불</button>
          </div>
        </div>

        {/* 환불 계좌 — 현금환불일 때만 */}
        {method === "cash" && (
          <div style={{ marginBottom: 14, padding: "10px 12px", background: G.surface, borderRadius: 10, border: `1px solid ${G.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: G.red, marginBottom: 8 }}>🏦 환불 계좌</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="은행명"
                style={{ ...baseInp, flex: 1, minWidth: 0, fontSize: 13 }} />
              <input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} placeholder="계좌명 (예금주)"
                style={{ ...baseInp, flex: 1.4, minWidth: 0, fontSize: 13 }} />
            </div>
            <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="계좌번호"
              type="text" inputMode="numeric"
              style={{ ...baseInp, width: "100%", boxSizing: "border-box", fontSize: 14, fontFamily: SF, fontWeight: 700 }} />
            <div style={{ fontSize: 10, color: G.creamMuted, marginTop: 5 }}>계좌명은 고객명이 기본값이며 수정할 수 있습니다</div>
          </div>
        )}

        {/* 환불 범위 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: G.creamMuted, marginBottom: 6 }}>환불 범위</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => { setKind("full"); setAmountInput(String(paid || "")); }} style={seg(kind === "full", G.copper)}>전액환불</button>
            <button type="button" onClick={() => setKind("partial")} style={seg(kind === "partial", G.copper)}>부분환불</button>
          </div>
        </div>

        {/* 금액 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: G.creamMuted, marginBottom: 6 }}>환불 금액</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              value={kind === "full" ? (paid || 0).toLocaleString() : amountInput}
              onChange={(e) => setAmountInput(e.target.value.replace(/[^0-9]/g, ""))}
              disabled={kind === "full"}
              type="text" inputMode="numeric" placeholder="0"
              style={{ ...baseInp, flex: 1, fontFamily: SF, fontWeight: 700, fontSize: 15, textAlign: "right", background: kind === "full" ? G.surface : G.inputBg, color: G.cream, opacity: kind === "full" ? 0.8 : 1 }}
            />
            <span style={{ fontSize: 12, color: G.creamMuted }}>원</span>
          </div>
          {overLimit && <div style={{ fontSize: 11, color: G.red, marginTop: 4 }}>입금액({(paid || 0).toLocaleString()}원)을 초과할 수 없습니다</div>}
        </div>

        {/* 사유 (선택) */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: G.creamMuted, marginBottom: 6 }}>사유 <span style={{ fontWeight: 400 }}>(선택)</span></div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 단순변심 · 불량 · 오배송" style={{ ...baseInp, width: "100%", boxSizing: "border-box", fontSize: 13 }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "12px 16px", borderRadius: 10, border: `1px solid ${G.border}`, background: "transparent", color: G.creamMuted, fontFamily: S, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>취소</button>
          <button onClick={submit} disabled={submitting || amount <= 0 || overLimit}
            style={{ flex: 1, padding: "12px", borderRadius: 10, border: "none", background: (submitting || amount <= 0 || overLimit) ? G.border : G.red, color: "#fff", fontWeight: 800, fontSize: 14, cursor: (submitting || amount <= 0 || overLimit) ? "not-allowed" : "pointer", fontFamily: S }}>
            {submitting ? "신청 중..." : `${amount.toLocaleString()}원 환불 신청`}
          </button>
        </div>
        <div style={{ fontSize: 10, color: G.creamMuted, marginTop: 10, textAlign: "center" }}>신청하면 대표님이 정산관리에서 확인 후 승인합니다</div>
      </div>
    </div>
  );
}
