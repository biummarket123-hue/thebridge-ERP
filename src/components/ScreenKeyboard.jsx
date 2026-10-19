import { useState } from "react";
import { S, SF, useTheme } from "../constants.js";
import { typeJamo, backspace } from "../lib/hangul.js";

// ERP 자체 화면 키보드 (2026-10-15, 사용자 결정 A안).
//
// 왜: 포장팀 아이패드에 블루투스 스캐너가 붙어 있으면 아이패드가 스캐너를 키보드로 보고 화면 키보드를 숨긴다.
// 아이패드 설정엔 켜는 항목이 없고, 스캐너는 애플용이 아니라 키보드 토글 바코드도 없다. 매번 ⌨︎ 버튼을 눌러
// 키보드를 부르는 건 너무 번거롭다 — 그래서 적는 칸 옆 ⌨ 버튼을 누르면 이 키보드가 화면 아래에 뜬다.
//
// 쓰는 법: <ScreenKeyboard value onChange mode="text"|"number" title presets onDone />
//   · 입력칸에 커서를 두지 않는다 — 커서가 가면 아이패드가 또 제 키보드 막대를 띄우고, 스캔칸이 커서를 잃는다.
//     값은 onChange 로만 오간다. 스캐너는 여전히 스캔칸에 친다.
//   · 한글은 lib/hangul.js 가 조합한다(두벌식). 영문·숫자·기호 자판도 있다.
//   · presets: 자주 쓰는 사유 버튼 — 누르면 값에 붙는다(비어 있으면 그대로, 있으면 " · " 로 이어서).
//   · 모든 키는 <button> 이라 PackingTab 의 "빈 곳 누르면 스캔칸으로" 처리에 안 걸린다.

const KO = [
  ["ㅂ", "ㅈ", "ㄷ", "ㄱ", "ㅅ", "ㅛ", "ㅕ", "ㅑ", "ㅐ", "ㅔ"],
  ["ㅁ", "ㄴ", "ㅇ", "ㄹ", "ㅎ", "ㅗ", "ㅓ", "ㅏ", "ㅣ"],
  ["ㅋ", "ㅌ", "ㅊ", "ㅍ", "ㅠ", "ㅜ", "ㅡ"],
];
const KO_SHIFT = { "ㅂ": "ㅃ", "ㅈ": "ㅉ", "ㄷ": "ㄸ", "ㄱ": "ㄲ", "ㅅ": "ㅆ", "ㅐ": "ㅒ", "ㅔ": "ㅖ" };
const EN = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];
const SYM = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "₩", "&", "@"],
  [".", ",", "?", "!", "'", "\"", "~"],
];
const NUM = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "⌫"]];

export default function ScreenKeyboard({ value, onChange, mode = "text", title = "", presets = [], onDone }) {
  const T = useTheme();
  const [layout, setLayout] = useState("ko");   // ko | en | sym
  const [shift, setShift] = useState(false);
  const v = String(value ?? "");

  const press = (ch) => {
    if (mode === "number") { onChange(v + ch); return; }
    if (layout === "ko") {
      const j = shift ? (KO_SHIFT[ch] || ch) : ch;
      onChange(typeJamo(v, j));
    } else if (layout === "en") {
      onChange(v + (shift ? ch.toUpperCase() : ch));
    } else onChange(v + ch);
    if (shift) setShift(false);
  };
  const del = () => onChange(mode === "number" ? v.slice(0, -1) : backspace(v));
  const preset = (p) => onChange(v.trim() ? `${v.trim()} · ${p}` : p);

  const keyBase = {
    flex: 1, minWidth: 0, minHeight: 46, padding: 0, borderRadius: 9, cursor: "pointer",
    border: `1px solid ${T.border}`, background: T.surface, color: T.cream,
    fontFamily: S, fontSize: 19, fontWeight: 800, lineHeight: 1, touchAction: "manipulation",
    WebkitUserSelect: "none", userSelect: "none",
  };
  const fnKey = { ...keyBase, background: T.subtleBg || "transparent", color: T.creamMuted, fontSize: 14 };
  const row = { display: "flex", gap: 5, marginTop: 5 };
  const rows = mode === "number" ? NUM : layout === "ko" ? KO : layout === "en" ? EN : SYM;

  return (
    <div role="group" aria-label="화면 키보드" style={{
      position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 65,
      background: T.card || T.surface, borderTop: `2px solid ${T.copper}`,
      boxShadow: "0 -8px 28px rgba(0,0,0,0.45)",
      padding: "8px 10px calc(10px + env(safe-area-inset-bottom))",
      fontFamily: S,
    }}>
      <div style={{ maxWidth: mode === "number" ? 360 : 720, margin: "0 auto" }}>
        {/* 지금 값 — 가로로 쓰는 아이패드에선 키보드가 입력칸을 가린다. 여기서 크게 보여준다(2026-10-15 사용자: 작아서 안 보임) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ flex: 1, minWidth: 0, padding: "6px 12px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.surface }}>
            {title && <div style={{ fontSize: 11.5, fontWeight: 800, color: T.creamMuted, marginBottom: 1 }}>{title}</div>}
            <div style={{ fontSize: 24, lineHeight: 1.3, fontWeight: 900, color: T.cream, fontFamily: mode === "number" ? SF : S,
              wordBreak: "keep-all", overflowWrap: "anywhere", maxHeight: 62, overflow: "hidden" }}>
              {v || <span style={{ color: T.creamMuted, fontWeight: 600, fontSize: 16 }}>여기에 치는 글이 보입니다</span>}
              {v && <span style={{ display: "inline-block", width: 2, height: "1em", background: T.copper, marginLeft: 2, verticalAlign: "-0.15em", animation: "packBlink 1s infinite" }} />}
            </div>
          </div>
          {v && <button onClick={() => onChange("")} style={{ ...fnKey, flex: "0 0 auto", minHeight: 32, padding: "0 10px", fontSize: 12 }}>모두 지우기</button>}
          <button onClick={onDone} style={{ ...keyBase, flex: "0 0 auto", minHeight: 32, padding: "0 14px", fontSize: 13, background: T.copper, color: "#fff", border: "none" }}>완료</button>
        </div>
        {presets.length > 0 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
            {presets.map(p => (
              <button key={p} onClick={() => preset(p)} style={{ ...fnKey, flex: "0 0 auto", minHeight: 34, padding: "0 11px", fontSize: 12.5, color: T.copper, borderColor: T.copper }}>{p}</button>
            ))}
          </div>
        )}
        {rows.map((keys, i) => (
          <div key={i} style={{ ...row, paddingLeft: mode === "number" ? 0 : i * 14, paddingRight: mode === "number" ? 0 : i * 14 }}>
            {keys.map(k => k === "⌫"
              ? <button key={k} onClick={del} style={fnKey}>⌫</button>
              : <button key={k} onClick={() => press(k)} style={keyBase}>
                  {layout === "ko" && shift && mode !== "number" ? (KO_SHIFT[k] || k) : layout === "en" && shift ? k.toUpperCase() : k}
                </button>)}
            {mode !== "number" && i === 2 && <button onClick={del} style={{ ...fnKey, flex: "0 0 60px", fontSize: 18 }}>⌫</button>}
          </div>
        ))}
        {mode !== "number" && (
          <div style={row}>
            <button onClick={() => setShift(s => !s)} aria-pressed={shift}
              style={{ ...fnKey, flex: "0 0 64px", color: shift ? T.copper : T.creamMuted, borderColor: shift ? T.copper : T.border }}>
              {layout === "ko" ? "쌍자음" : layout === "en" ? "ABC" : "⇧"}
            </button>
            <button onClick={() => { setLayout(l => l === "sym" ? "ko" : "sym"); setShift(false); }} style={{ ...fnKey, flex: "0 0 64px" }}>
              {layout === "sym" ? "한글" : "123"}
            </button>
            <button onClick={() => { setLayout(l => l === "en" ? "ko" : "en"); setShift(false); }} style={{ ...fnKey, flex: "0 0 64px" }}>
              {layout === "en" ? "한글" : "영문"}
            </button>
            <button onClick={() => onChange(v + " ")} style={{ ...keyBase, fontSize: 13, color: T.creamMuted }}>띄어쓰기</button>
            <button onClick={onDone} style={{ ...keyBase, flex: "0 0 88px", fontSize: 15, background: T.copper, color: "#fff", border: "none" }}>완료</button>
          </div>
        )}
      </div>
    </div>
  );
}
