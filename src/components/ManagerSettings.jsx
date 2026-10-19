import { useState } from "react";
import { Card, SecTitle, Tag } from "./UI.jsx";
import * as db from "../lib/db.js";
import { checkAdminOnly } from "../lib/managerLock.js";
import { PREFIX_RE } from "../lib/rollStock.js";

export default function ManagerSettings({ T, S, SF, baseInp, managers, setManagers, activeManager, setActiveManager, showToast }) {
  const [newName, setNewName] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [newIsPublic, setNewIsPublic] = useState(false);
  const [newIsPacker, setNewIsPacker] = useState(false);
  const [newCode, setNewCode] = useState("");            // 품번 이니셜(2026-10-08)
  const [codeEdit, setCodeEdit] = useState(null);        // { name, value } — 이니셜 고치는 중
  const [editingName, setEditingName] = useState(null);

  // 품번 이니셜 — 영문 대문자·숫자 1~6, 비우면 LH. 다른 담당자와 같으면 안 된다(품번만 보고 누구인지 알자는 것).
  const normCode = (v) => String(v || "").trim().toUpperCase();
  const codeProblem = (v, selfName) => {
    const c = normCode(v);
    if (!c) return "";
    if (!PREFIX_RE.test(c)) return "영문으로 시작하는 영문 대문자·숫자 1~6자만 됩니다 (한글은 스캐너가 못 읽습니다)";
    if (c === "LH") return "LH 는 이니셜이 없는 담당자 공통 접두어입니다 — 비워 두세요";
    const dup = managers.find(m => m.name !== selfName && normCode(m.code) === c);
    return dup ? `${dup.name} 담당자가 이미 ${c} 를 씁니다` : "";
  };
  const saveCode = async (m) => {
    if (!codeEdit || codeEdit.name !== m.name) return;
    const v = normCode(codeEdit.value);
    setCodeEdit(null);
    if (v === normCode(m.code)) return;
    if (!guardAdmin()) return;
    const why = codeProblem(v, m.name);
    if (why) { showToast(why, "error"); return; }
    try {
      await db.updateManager(m.name, { code: v });
      setManagers(p => p.map(x => x.name === m.name ? { ...x, code: v } : x));
      showToast(v ? `${m.name} 품번 이니셜 — ${v}` : `${m.name} 품번 이니셜 지움 (LH 로 발급)`);
    } catch (e) { showToast("변경 실패: " + e.message, "error"); }
  };

  const guardAdmin = () => {
    const reason = checkAdminOnly(activeManager, managers);
    if (reason) { showToast(reason, "error"); return false; }
    return true;
  };

  const onAdd = async () => {
    if (!guardAdmin()) return;
    const name = newName.trim();
    if (!name) return;
    if (managers.find(m => m.name === name)) { showToast("이미 등록된 이름입니다", "error"); return; }
    const codeWhy = codeProblem(newCode, null);
    if (codeWhy) { showToast(codeWhy, "error"); return; }
    try {
      const saved = await db.addManager({ name, isAdmin: newIsAdmin, isPublic: newIsPublic, isPacker: newIsPacker, code: normCode(newCode) });
      if (saved) setManagers(p => [...p, { ...saved, code: saved.code || normCode(newCode) }]);
      setNewName(""); setNewCode(""); setNewIsAdmin(false); setNewIsPublic(false); setNewIsPacker(false);
      showToast("담당자 등록 완료");
    } catch (e) { showToast("등록 실패: " + e.message, "error"); }
  };

  const onRemove = async (m) => {
    if (!guardAdmin()) return;
    if (m.isAdmin) {
      const adminCount = managers.filter(x => x.isAdmin).length;
      if (adminCount <= 1) { showToast("마지막 관리자는 삭제할 수 없습니다", "error"); return; }
    }
    if (!window.confirm(`"${m.name}" 담당자를 삭제하시겠습니까?`)) return;
    try {
      await db.removeManager(m.name);
      setManagers(p => p.filter(x => x.name !== m.name));
      if (activeManager === m.name) setActiveManager("");
      showToast("삭제 완료");
    } catch (e) { showToast("삭제 실패: " + e.message, "error"); }
  };

  const onToggle = async (m, key) => {
    if (!guardAdmin()) return;
    if (key === "isAdmin" && m.isAdmin) {
      const adminCount = managers.filter(x => x.isAdmin).length;
      if (adminCount <= 1) { showToast("마지막 관리자 권한은 해제할 수 없습니다", "error"); return; }
    }
    try {
      await db.updateManager(m.name, { [key]: !m[key] });
      setManagers(p => p.map(x => x.name === m.name ? { ...x, [key]: !x[key] } : x));
    } catch (e) { showToast("변경 실패: " + e.message, "error"); }
  };

  return (
    <Card style={{ marginBottom: 14, background: T.card, border: `1px solid ${T.border}` }}>
      <SecTitle>담당자 관리</SecTitle>
      <div style={{ fontSize: 11, color: T.creamMuted, marginBottom: 10 }}>
        관리자만 추가/삭제/수정할 수 있습니다. 공용 담당자(방문고객/마켓24 등)는 누구나 처리 가능.
        포장 담당자는 메모·담당자 메모(공유) 편집과 상태 '접수'·'포장완료' 변경만 할 수 있고, 주문 수정/삭제·합배송·입금/환불 등은 불가합니다.
        <br/>품번 이니셜은 이 담당자가 입고한 원단의 품번 앞글자입니다(예: S-2610-0005). 비우면 LH. 영문 대문자·숫자만, 서로 달라야 합니다.
      </div>

      {/* 목록 */}
      {managers.length === 0 ? (
        <div style={{ fontSize: 12, color: T.creamMuted, padding: "10px 0", textAlign: "center" }}>등록된 담당자 없음</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {managers.map(m => (
            <div key={m.name} className="mgr-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: T.surface, borderRadius: 8, border: `1px solid ${T.border}` }}>
              <span className="mgr-name" style={{ fontWeight: 700, fontSize: 13, flex: 1, color: T.cream, wordBreak: "keep-all" }}>{m.name}</span>
              {/* 품번 이니셜 — 누르면 고친다. 비면 LH. */}
              {codeEdit?.name === m.name ? (
                <input autoFocus value={codeEdit.value} maxLength={6} aria-label={`${m.name} 품번 이니셜`}
                  onChange={e => setCodeEdit({ name: m.name, value: e.target.value.toUpperCase() })}
                  onKeyDown={e => { if (e.key === "Enter") saveCode(m); if (e.key === "Escape") setCodeEdit(null); }}
                  onBlur={() => saveCode(m)}
                  style={{ ...baseInp, width: 72, padding: "3px 6px", fontSize: 12, fontFamily: "monospace", textAlign: "center" }} />
              ) : (
                <button onClick={() => setCodeEdit({ name: m.name, value: m.code || "" })} title="품번 이니셜 — 이 담당자가 입고한 원단의 품번 앞글자" style={{
                  padding: "3px 8px", fontSize: 11, fontWeight: 800, borderRadius: 6, fontFamily: "monospace",
                  border: `1px dashed ${m.code ? T.copper : T.border}`, background: "transparent",
                  color: m.code ? T.copper : T.creamMuted, cursor: "pointer",
                }}>{m.code || "LH"}</button>
              )}
              <button onClick={() => onToggle(m, "isAdmin")} style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 700, borderRadius: 6,
                border: `1px solid ${m.isAdmin ? T.copper : T.border}`,
                background: m.isAdmin ? T.copperGlow : "transparent",
                color: m.isAdmin ? T.copper : T.creamMuted,
                cursor: "pointer", fontFamily: S,
              }}>관리자</button>
              <button onClick={() => onToggle(m, "isPublic")} style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 700, borderRadius: 6,
                border: `1px solid ${m.isPublic ? T.blue : T.border}`,
                background: m.isPublic ? T.blueBg : "transparent",
                color: m.isPublic ? T.blue : T.creamMuted,
                cursor: "pointer", fontFamily: S,
              }}>공용</button>
              <button onClick={() => onToggle(m, "isPacker")} style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 700, borderRadius: 6,
                border: `1px solid ${m.isPacker ? T.green : T.border}`,
                background: m.isPacker ? T.greenBg : "transparent",
                color: m.isPacker ? T.green : T.creamMuted,
                cursor: "pointer", fontFamily: S,
              }}>포장</button>
              <button onClick={() => onRemove(m)} style={{
                padding: "3px 8px", fontSize: 11, borderRadius: 6,
                border: `1px solid ${T.red}40`, background: T.redBg, color: T.red,
                cursor: "pointer", fontFamily: S,
              }}>🗑</button>
            </div>
          ))}
        </div>
      )}

      {/* 추가 */}
      <div style={{ paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 11, color: T.creamMuted, marginBottom: 6, fontWeight: 600 }}>새 담당자 추가</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && onAdd()}
            placeholder="이름" style={{ ...baseInp, flex: 1, fontSize: 13, background: T.inputBg, border: `1px solid ${T.border}`, color: T.cream }} />
          <input value={newCode} onChange={e => setNewCode(e.target.value.toUpperCase())} maxLength={6}
            onKeyDown={e => e.key === "Enter" && onAdd()}
            placeholder="이니셜" title="품번 이니셜(영문 대문자·숫자 1~6). 비우면 LH" style={{ ...baseInp, width: 88, fontSize: 13, fontFamily: "monospace", background: T.inputBg, border: `1px solid ${T.border}`, color: T.cream }} />
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", color: newIsAdmin ? T.copper : T.creamMuted, cursor: "pointer", fontWeight: newIsAdmin ? 700 : 500 }}>
            <input type="checkbox" checked={newIsAdmin} onChange={e => setNewIsAdmin(e.target.checked)} style={{ accentColor: T.copper }} />
            관리자
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", color: newIsPublic ? T.blue : T.creamMuted, cursor: "pointer", fontWeight: newIsPublic ? 700 : 500 }}>
            <input type="checkbox" checked={newIsPublic} onChange={e => setNewIsPublic(e.target.checked)} style={{ accentColor: T.blue }} />
            공용
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", color: newIsPacker ? T.green : T.creamMuted, cursor: "pointer", fontWeight: newIsPacker ? 700 : 500 }}>
            <input type="checkbox" checked={newIsPacker} onChange={e => setNewIsPacker(e.target.checked)} style={{ accentColor: T.green }} />
            포장
          </label>
        </div>
        <button onClick={onAdd} disabled={!newName.trim()} style={{
          width: "100%", padding: "10px", borderRadius: 8, border: "none",
          background: newName.trim() ? `linear-gradient(135deg,${T.copper},${T.copperLight})` : T.border,
          color: newName.trim() ? T.white : T.creamMuted, fontWeight: 800, fontSize: 13,
          cursor: newName.trim() ? "pointer" : "not-allowed", fontFamily: S,
        }}>+ 담당자 추가</button>
      </div>
    </Card>
  );
}
