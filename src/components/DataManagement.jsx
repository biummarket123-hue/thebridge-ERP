import { useState, useEffect, useCallback } from "react";
import { Card, SecTitle, CuteLoader } from "./UI.jsx";
import { S, SF, nowT, useTheme } from "../constants.js";
import * as db from "../lib/db.js";

const CONFIRM_TEXT = "모든 데이터 삭제";

function fmtTs(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d)) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtMoney(n) {
  return (n || 0).toLocaleString() + "원";
}

export default function DataManagement({ showToast, reloadOrders, activeManager = "" }) {
  const T = useTheme();

  const [batches, setBatches] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [excelTotal, setExcelTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); // 어떤 삭제가 진행 중

  const [batchConfirm, setBatchConfirm] = useState(null); // 단일 batch 삭제 확인
  const [excelAllConfirm, setExcelAllConfirm] = useState(false);
  const [allConfirm1, setAllConfirm1] = useState(false);
  const [allConfirm2, setAllConfirm2] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  // 고아 고객(orders에 없는 customers)
  const [orphans, setOrphans] = useState([]);
  const [orphanLoading, setOrphanLoading] = useState(false);
  const [orphanConfirm, setOrphanConfirm] = useState(false);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, all] = await Promise.all([db.fetchExcelUploadBatches(), db.countAllOrders()]);
      setBatches(bs);
      setExcelTotal(bs.reduce((s, b) => s + b.count, 0));
      setTotalCount(all);
    } catch (e) {
      console.error("[데이터관리] 카운트/배치 조회 실패:", e);
      showToast?.("조회 실패: " + e.message, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const refreshOrphans = useCallback(async () => {
    setOrphanLoading(true);
    try {
      const list = await db.fetchOrphanCustomers();
      setOrphans(list);
    } catch (e) {
      console.error("[데이터관리] 고아 고객 조회 실패:", e);
      showToast?.("조회 실패: " + e.message, "error");
    } finally {
      setOrphanLoading(false);
    }
  }, [showToast]);

  useEffect(() => { refreshAll(); refreshOrphans(); }, [refreshAll, refreshOrphans]);

  const onDeleteBatch = async (batch) => {
    setBusy(true);
    try {
      const deleted = await db.deleteExcelOrdersByRange(batch.firstCreatedAt, batch.lastCreatedAt);
      console.log(`[데이터관리] 업로드 삭제: ${deleted}건 / ${fmtTs(batch.firstCreatedAt)} (${new Date().toLocaleString("ko-KR")})`);
      showToast?.(`✓ ${deleted.toLocaleString()}건 삭제 (${fmtTs(batch.firstCreatedAt)} 업로드)`);
      setBatchConfirm(null);
      await refreshAll();
      await reloadOrders?.();
    } catch (e) {
      console.error("[데이터관리] 배치 삭제 실패:", e);
      showToast?.("삭제 중 오류가 발생했습니다. 다시 시도해주세요.", "error");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteAllExcel = async () => {
    setBusy(true);
    try {
      const deleted = await db.deleteExcelOrders();
      console.log(`[데이터관리] 엑셀 업로드분 일괄 삭제: ${deleted}건 (${new Date().toLocaleString("ko-KR")})`);
      showToast?.(`✓ ${deleted.toLocaleString()}건의 엑셀 업로드 데이터가 모두 삭제되었습니다`);
      setExcelAllConfirm(false);
      await refreshAll();
      await reloadOrders?.();
    } catch (e) {
      console.error("[데이터관리] 엑셀 일괄 삭제 실패:", e);
      showToast?.("삭제 중 오류가 발생했습니다. 다시 시도해주세요.", "error");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteOrphans = async () => {
    setBusy(true);
    try {
      const ids = orphans.map(o => o.id);
      const deleted = await db.deleteOrphanCustomers(ids);
      console.log(`[데이터관리] 고아 고객 삭제: ${deleted}건 (${new Date().toLocaleString("ko-KR")})`);
      // 감사 기록 — 일괄 정리도 누가·몇 명·누구를 지웠는지 입출고 로그에 남김
      try {
        const names = orphans.slice(0, 20).map(o => o.name).filter(Boolean).join(", ");
        await db.insertLog({...nowT(), type:"고객삭제", fabric:`고아 고객 일괄 정리 ${deleted}명`, ref:"데이터관리", note:`${names}${orphans.length > 20 ? ` 외 ${orphans.length - 20}명` : ""} — 삭제자: ${activeManager||"미지정"}`});
      } catch (auditErr) { console.error("고아 고객 삭제 기록 실패:", auditErr); }
      showToast?.(`✓ 거래 기록 없는 고객 ${deleted.toLocaleString()}명 정리 완료`);
      setOrphanConfirm(false);
      await refreshOrphans();
    } catch (e) {
      console.error("[데이터관리] 고아 고객 삭제 실패:", e);
      showToast?.("삭제 중 오류: " + e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const onDeleteAll = async () => {
    setBusy(true);
    try {
      const deleted = await db.deleteAllOrdersFull();
      console.log(`[데이터관리] 모든 주문 삭제: ${deleted}건 (${new Date().toLocaleString("ko-KR")})`);
      showToast?.(`✓ 모든 주문(${deleted.toLocaleString()}건)이 삭제되었습니다`);
      setAllConfirm2(false);
      setConfirmInput("");
      await refreshAll();
      await reloadOrders?.();
    } catch (e) {
      console.error("[데이터관리] 전체 삭제 실패:", e);
      showToast?.("삭제 중 오류가 발생했습니다. 다시 시도해주세요.", "error");
    } finally {
      setBusy(false);
    }
  };

  const labelStyle = { fontSize: 12, color: T.creamMuted, marginBottom: 4 };
  const safeOrange = "#E67E22";

  return (
    <Card style={{ marginBottom: 14, background: T.card, border: `1px solid ${T.border}` }}>
      <SecTitle>⚠️ 데이터 관리</SecTitle>

      {/* 엑셀 업로드 데이터 영역 */}
      <div style={{ padding: 12, background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.copper, letterSpacing: ".06em", marginBottom: 10, textTransform: "uppercase" }}>
          엑셀 업로드 데이터
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
          <div>
            <div style={labelStyle}>총 업로드분</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.cream }}>
              {loading ? <CuteLoader size="sm" /> : `${excelTotal.toLocaleString()}건`}
              <span style={{ fontSize: 12, fontWeight: 600, color: T.creamMuted, marginLeft: 6 }}>
                · 업로드 {batches.length}회
              </span>
            </div>
          </div>
          <button
            onClick={() => refreshAll()}
            disabled={busy || loading}
            style={{
              padding: "6px 11px", fontSize: 11, borderRadius: 7,
              border: `1px solid ${T.border}`, background: "transparent",
              color: T.creamMuted, fontWeight: 600, fontFamily: S,
              cursor: busy || loading ? "not-allowed" : "pointer",
            }}
          >
            ↻ 새로고침
          </button>
        </div>

        {/* 업로드별 목록 */}
        {loading ? (
          <div style={{ padding: "24px 0", textAlign: "center" }}><CuteLoader text="불러오는 중..." size="md" /></div>
        ) : batches.length === 0 ? (
          <div style={{ padding: "24px 0", textAlign: "center", color: T.creamMuted, fontSize: 12 }}>
            엑셀 업로드 데이터가 없습니다.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {batches.map((b, i) => (
              <div
                key={b.id}
                style={{
                  padding: 11, background: T.card, borderRadius: 9,
                  border: `1px solid ${T.border}`,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: T.cream, marginBottom: 3 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: T.copper, background: T.copperGlow, padding: "1px 6px", borderRadius: 4, marginRight: 6 }}>
                        #{batches.length - i}
                      </span>
                      {fmtTs(b.firstCreatedAt)} 업로드
                    </div>
                    <div style={{ fontSize: 11, color: T.creamMuted, lineHeight: 1.6 }}>
                      <b style={{ color: T.cream }}>{b.count.toLocaleString()}건</b>
                      {" · "}
                      고객 {b.customerCount.toLocaleString()}명
                      {b.orderDateMin && (
                        <> · 주문일 {b.orderDateMin}{b.orderDateMin !== b.orderDateMax ? ` ~ ${b.orderDateMax}` : ""}</>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: T.creamMuted, lineHeight: 1.6, marginTop: 2 }}>
                      매출 합계: <b style={{ color: T.copper }}>{fmtMoney(b.totalAmount)}</b>
                      {b.channels.length > 0 && (
                        <> · 판매처: {b.channels.slice(0, 3).join(", ")}{b.channels.length > 3 ? ` 외 ${b.channels.length - 3}` : ""}</>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setBatchConfirm(b)}
                    disabled={busy}
                    style={{
                      flexShrink: 0, padding: "7px 11px", borderRadius: 7,
                      border: `1px solid ${T.red}55`, background: T.redBg,
                      color: T.red, fontWeight: 700, fontSize: 11,
                      cursor: busy ? "not-allowed" : "pointer", fontFamily: S,
                      whiteSpace: "nowrap",
                    }}
                  >
                    🗑️ 삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={() => setExcelAllConfirm(true)}
          disabled={busy || loading || excelTotal === 0}
          style={{
            width: "100%", padding: 12, borderRadius: 10, border: "none",
            background: busy || loading || excelTotal === 0 ? T.border : `linear-gradient(135deg,${safeOrange},#D35400)`,
            color: busy || loading || excelTotal === 0 ? T.creamMuted : "#fff",
            fontWeight: 800, fontSize: 13,
            cursor: busy || loading || excelTotal === 0 ? "not-allowed" : "pointer",
            fontFamily: S,
            boxShadow: busy || loading || excelTotal === 0 ? "none" : "0 2px 8px rgba(230,126,34,0.3)",
          }}
        >
          🗑️ 엑셀 업로드분 전체 일괄 삭제
        </button>
        <div style={{ fontSize: 11, color: T.creamMuted, marginTop: 8, lineHeight: 1.5 }}>
          엑셀로 일괄 업로드된 모든 주문(time="00:00")을 한 번에 삭제합니다.<br/>
          ERP에서 직접 입력한 주문은 유지됩니다.
        </div>
      </div>

      {/* 고객 데이터 정리 */}
      <div style={{ padding: 12, background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.copper, letterSpacing: ".06em", marginBottom: 10, textTransform: "uppercase" }}>
          고객 데이터 정리
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
          <div>
            <div style={labelStyle}>거래 기록 없는 고객</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.cream }}>
              {orphanLoading ? <CuteLoader size="sm" /> : `${orphans.length.toLocaleString()}명`}
            </div>
          </div>
          <button
            onClick={() => refreshOrphans()}
            disabled={busy || orphanLoading}
            style={{
              padding: "6px 11px", fontSize: 11, borderRadius: 7,
              border: `1px solid ${T.border}`, background: "transparent",
              color: T.creamMuted, fontWeight: 600, fontFamily: S,
              cursor: busy || orphanLoading ? "not-allowed" : "pointer",
            }}
          >
            ↻ 새로고침
          </button>
        </div>

        {!orphanLoading && orphans.length > 0 && (
          <div style={{ padding: 10, background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, marginBottom: 12, fontSize: 11, color: T.creamMuted, lineHeight: 1.6 }}>
            상위 5명: <span style={{ color: T.cream }}>{orphans.slice(0, 5).map(o => o.name).join(", ")}</span>
            {orphans.length > 5 && <> 외 {orphans.length - 5}명</>}
          </div>
        )}

        <button
          onClick={() => setOrphanConfirm(true)}
          disabled={busy || orphanLoading || orphans.length === 0}
          style={{
            width: "100%", padding: 12, borderRadius: 10, border: "none",
            background: busy || orphanLoading || orphans.length === 0 ? T.border : `linear-gradient(135deg,${safeOrange},#D35400)`,
            color: busy || orphanLoading || orphans.length === 0 ? T.creamMuted : "#fff",
            fontWeight: 800, fontSize: 13,
            cursor: busy || orphanLoading || orphans.length === 0 ? "not-allowed" : "pointer",
            fontFamily: S,
            boxShadow: busy || orphanLoading || orphans.length === 0 ? "none" : "0 2px 8px rgba(230,126,34,0.3)",
          }}
        >
          🗑️ 거래 없는 고객 일괄 정리
        </button>
        <div style={{ fontSize: 11, color: T.creamMuted, marginTop: 8, lineHeight: 1.5 }}>
          엑셀로 들어왔지만 ERP 주문 기록이 한 번도 없는 고객을 정리합니다.<br/>
          이름·연락처(가운데 4자리)로 매칭하며, 주문 1건이라도 있으면 보존됩니다.
        </div>
      </div>

      {/* 위험 영역 */}
      <div style={{ padding: 12, background: `${T.red}0D`, borderRadius: 10, border: `2px solid ${T.red}` }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.red, letterSpacing: ".06em", marginBottom: 10, textTransform: "uppercase" }}>
          🚨 위험 영역
        </div>
        <div style={labelStyle}>현재 전체 주문</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.cream, marginBottom: 12 }}>
          {loading ? <CuteLoader size="sm" /> : `${totalCount.toLocaleString()}건`}
        </div>
        <button
          onClick={() => setAllConfirm1(true)}
          disabled={busy || loading || totalCount === 0}
          style={{
            width: "100%", padding: 12, borderRadius: 10, border: "none",
            background: busy || loading || totalCount === 0 ? T.border : T.red,
            color: busy || loading || totalCount === 0 ? T.creamMuted : "#fff",
            fontWeight: 800, fontSize: 13,
            cursor: busy || loading || totalCount === 0 ? "not-allowed" : "pointer",
            fontFamily: S,
            boxShadow: busy || loading || totalCount === 0 ? "none" : `0 2px 8px ${T.red}66`,
          }}
        >
          🚨 모든 주문 삭제 (초기화)
        </button>
        <div style={{ fontSize: 11, color: T.red, marginTop: 8, lineHeight: 1.5, fontWeight: 600 }}>
          ERP 직접 입력 + 엑셀 업로드 + 입출고 로그 + 적립금 모두 삭제됩니다.<br/>
          이 작업은 되돌릴 수 없습니다.
        </div>
      </div>

      {/* 단일 배치 삭제 확인 모달 */}
      {batchConfirm && (
        <Modal onClose={() => !busy && setBatchConfirm(null)} T={T}>
          <div style={{ fontSize: 30, marginBottom: 10, textAlign: "center" }}>🗑️</div>
          <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: T.cream, marginBottom: 12, textAlign: "center" }}>
            업로드 삭제 확인
          </div>
          <div style={{ fontSize: 13, color: T.cream, marginBottom: 8, lineHeight: 1.7 }}>
            <b style={{ color: safeOrange }}>{fmtTs(batchConfirm.firstCreatedAt)}</b>에 업로드된<br/>
            <b style={{ color: safeOrange }}>{batchConfirm.count.toLocaleString()}건</b>의 주문이 삭제됩니다.
          </div>
          <div style={{ fontSize: 12, color: T.creamMuted, marginBottom: 18, lineHeight: 1.6, padding: 10, background: T.surface, borderRadius: 8 }}>
            고객 {batchConfirm.customerCount}명<br/>
            {batchConfirm.orderDateMin && (
              <>주문일: {batchConfirm.orderDateMin}
                {batchConfirm.orderDateMin !== batchConfirm.orderDateMax ? ` ~ ${batchConfirm.orderDateMax}` : ""}<br/></>
            )}
            매출 합계: {fmtMoney(batchConfirm.totalAmount)}<br/>
            연관된 입금 이력도 함께 삭제됩니다.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => !busy && setBatchConfirm(null)} disabled={busy} style={btnGhost(T, busy)}>취소</button>
            <button onClick={() => onDeleteBatch(batchConfirm)} disabled={busy} style={btnDanger(T, busy, safeOrange)}>
              {busy ? "삭제 중..." : "삭제"}
            </button>
          </div>
        </Modal>
      )}

      {/* 엑셀 일괄 삭제 확인 모달 */}
      {excelAllConfirm && (
        <Modal onClose={() => !busy && setExcelAllConfirm(false)} T={T}>
          <div style={{ fontSize: 30, marginBottom: 10, textAlign: "center" }}>🗑️</div>
          <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: T.cream, marginBottom: 12, textAlign: "center" }}>
            엑셀 업로드 전체 삭제
          </div>
          <div style={{ fontSize: 13, color: T.cream, marginBottom: 8, lineHeight: 1.7 }}>
            <b style={{ color: safeOrange }}>{excelTotal.toLocaleString()}건</b>(업로드 {batches.length}회 분)의 엑셀 데이터가 모두 삭제됩니다.
          </div>
          <div style={{ fontSize: 12, color: T.creamMuted, marginBottom: 18, lineHeight: 1.6 }}>
            ERP에서 직접 입력한 주문은 유지됩니다.<br/><br/>
            계속하시겠습니까?
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => !busy && setExcelAllConfirm(false)} disabled={busy} style={btnGhost(T, busy)}>취소</button>
            <button onClick={onDeleteAllExcel} disabled={busy} style={btnDanger(T, busy, safeOrange)}>
              {busy ? "삭제 중..." : "전체 삭제"}
            </button>
          </div>
        </Modal>
      )}

      {/* 고아 고객 정리 확인 모달 */}
      {orphanConfirm && (
        <Modal onClose={() => !busy && setOrphanConfirm(false)} T={T}>
          <div style={{ fontSize: 30, marginBottom: 10, textAlign: "center" }}>🗑️</div>
          <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: T.cream, marginBottom: 12, textAlign: "center" }}>
            거래 없는 고객 정리
          </div>
          <div style={{ fontSize: 13, color: T.cream, marginBottom: 8, lineHeight: 1.7 }}>
            ERP 주문 기록이 한 번도 없는<br/>
            <b style={{ color: safeOrange }}>{orphans.length.toLocaleString()}명</b>의 고객 데이터가 삭제됩니다.
          </div>
          <div style={{ fontSize: 12, color: T.creamMuted, marginBottom: 10, lineHeight: 1.6, padding: 10, background: T.surface, borderRadius: 8, maxHeight: 150, overflowY: "auto" }}>
            {orphans.slice(0, 30).map(o => (
              <div key={o.id} style={{ padding: "2px 0" }}>
                · {o.name} {o.phone && <span style={{ color: T.creamMuted, opacity: 0.7 }}>({o.phone})</span>}
              </div>
            ))}
            {orphans.length > 30 && <div style={{ color: T.creamMuted, marginTop: 4 }}>... 외 {orphans.length - 30}명</div>}
          </div>
          <div style={{ fontSize: 11, color: T.creamMuted, marginBottom: 18, lineHeight: 1.5 }}>
            주문 1건이라도 있는 고객은 자동 보존됩니다.<br/>
            이 작업은 되돌릴 수 없습니다.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => !busy && setOrphanConfirm(false)} disabled={busy} style={btnGhost(T, busy)}>취소</button>
            <button onClick={onDeleteOrphans} disabled={busy} style={btnDanger(T, busy, safeOrange)}>
              {busy ? "정리 중..." : "정리"}
            </button>
          </div>
        </Modal>
      )}

      {/* 모든 주문 삭제 — 1차 확인 */}
      {allConfirm1 && (
        <Modal onClose={() => !busy && setAllConfirm1(false)} T={T}>
          <div style={{ fontSize: 30, marginBottom: 10, textAlign: "center" }}>⚠️</div>
          <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: T.red, marginBottom: 12, textAlign: "center" }}>
            위험한 작업입니다
          </div>
          <div style={{ fontSize: 13, color: T.cream, marginBottom: 18, lineHeight: 1.7 }}>
            전체 <b style={{ color: T.red }}>{totalCount.toLocaleString()}건</b>의 모든 주문이 삭제됩니다.<br/>
            연관된 입금이력 / 적립금 / 입출고 로그도 함께 삭제됩니다.<br/>
            이 작업은 되돌릴 수 없습니다.<br/><br/>
            계속하시겠습니까?
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setAllConfirm1(false)} style={btnGhost(T, false)}>취소</button>
            <button
              onClick={() => { setAllConfirm1(false); setAllConfirm2(true); setConfirmInput(""); }}
              style={btnDanger(T, false, T.red)}
            >
              다음
            </button>
          </div>
        </Modal>
      )}

      {/* 모든 주문 삭제 — 2차 확인 (텍스트 입력) */}
      {allConfirm2 && (
        <Modal onClose={() => { if (!busy) { setAllConfirm2(false); setConfirmInput(""); } }} T={T}>
          <div style={{ fontSize: 30, marginBottom: 10, textAlign: "center" }}>🚨</div>
          <div style={{ fontFamily: SF, fontSize: 16, fontWeight: 800, color: T.red, marginBottom: 12, textAlign: "center" }}>
            최종 확인
          </div>
          <div style={{ fontSize: 13, color: T.cream, marginBottom: 12, lineHeight: 1.7 }}>
            확인을 위해 다음 문구를 정확히 입력하세요:
          </div>
          <div style={{
            fontSize: 14, color: T.red, fontWeight: 800, marginBottom: 10,
            padding: 10, background: `${T.red}1A`, borderRadius: 8,
            textAlign: "center", letterSpacing: 2,
          }}>
            {CONFIRM_TEXT}
          </div>
          <input
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="여기에 입력"
            disabled={busy}
            autoFocus
            style={{
              width: "100%", padding: 12, borderRadius: 8,
              border: `1.5px solid ${confirmInput === CONFIRM_TEXT ? T.red : T.border}`,
              background: T.inputBg, color: T.cream, fontFamily: S, fontSize: 14,
              marginBottom: 18, outline: "none", boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { if (!busy) { setAllConfirm2(false); setConfirmInput(""); } }}
              disabled={busy}
              style={btnGhost(T, busy)}
            >
              취소
            </button>
            <button
              onClick={onDeleteAll}
              disabled={busy || confirmInput !== CONFIRM_TEXT}
              style={btnDanger(T, busy || confirmInput !== CONFIRM_TEXT, T.red)}
            >
              {busy ? "삭제 중..." : "최종 삭제"}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Modal({ children, onClose, T }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: T.card, borderRadius: 16, border: `1px solid ${T.border}`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)", padding: 24,
          width: "100%", maxWidth: 380, boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function btnGhost(T, disabled) {
  return {
    flex: 1, padding: 12, borderRadius: 10,
    border: `1px solid ${T.border}`, background: "transparent",
    color: T.creamMuted, fontWeight: 600, fontSize: 14,
    cursor: disabled ? "not-allowed" : "pointer", fontFamily: S,
  };
}

function btnDanger(T, disabled, color) {
  return {
    flex: 1, padding: 12, borderRadius: 10, border: "none",
    background: disabled ? T.border : color,
    color: disabled ? T.creamMuted : "#fff",
    fontWeight: 800, fontSize: 14,
    cursor: disabled ? "not-allowed" : "pointer", fontFamily: S,
  };
}
