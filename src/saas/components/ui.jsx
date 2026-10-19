// 공통 조각 — Button · StatCard · Panel · StatusBadge · SearchInput · FilterChips · TaskRow · BarChart · Empty · PageHead.
// 모양은 전부 saas.css(시안 CSS)에 있고, 여기는 그 클래스를 붙이는 얇은 껍데기다.
import { useRef, useState } from "react";
import { Icon } from "../icons.jsx";

/** 시안의 Ripple — 눌린 자리에 70px 원이 퍼진다(.55s). */
function spawnRipple(e, el) {
  if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = "70px";
  const x = e.clientX ? e.clientX - r.left - 35 : r.width / 2 - 35;
  const y = e.clientY ? e.clientY - r.top - 35 : r.height / 2 - 35;
  s.style.left = `${x}px`;
  s.style.top = `${y}px`;
  el.appendChild(s);
  setTimeout(() => s.remove(), 580);
}

/**
 * 버튼. kind: primary | white | danger | green. loading 이면 두 번 못 누르고 회전 표시.
 * onClick 이 Promise 를 돌려주면 끝날 때까지 알아서 loading 으로 둔다.
 */
/** 이름 + 님 — "사장님"처럼 이미 님으로 끝나면 붙이지 않는다 */
export const nim = (name) => { const n = String(name || "").trim(); return !n ? "" : n.endsWith("님") ? n : n + "님"; };

export function Button({ kind = "primary", icon, children, className = "", onClick, loading, disabled, size, type = "button", ...rest }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const isLoading = loading || busy;
  const handle = async (e) => {
    if (isLoading || disabled) return;
    spawnRipple(e, ref.current);
    if (!onClick) return;
    const r = onClick(e);
    if (r && typeof r.then === "function") {
      setBusy(true);
      try { await r; } finally { setBusy(false); }
    }
  };
  return (
    <button ref={ref} type={type} onClick={handle} disabled={disabled} aria-busy={isLoading || undefined}
      className={`btn btn-${kind}${size === "sm" ? " btn-sm" : ""}${isLoading ? " loading" : ""} ${className}`.trim()} {...rest}>
      {isLoading ? <span className="spin" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function PageHead({ eyebrow, title, subtitle, right, children }) {
  return (
    <div className="greeting">
      <div style={{ minWidth: 0 }}>
        {eyebrow && <p className="hello">{eyebrow}</p>}
        <h1 className="title">{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
        {children}
      </div>
      {right}
    </div>
  );
}

export function TextLink({ children, onClick, icon = "chevron" }) {
  return <button className="text-link" onClick={onClick}>{children}<Icon name={icon} /></button>;
}

/**
 * 지표 카드. value 가 null 이면 "—"(실데이터 연결 안 됨 · 지시서 8절).
 * sub: 숫자 아래 둘째 줄(총 재고의 "128개 품목" 처럼 두 줄로 보여야 할 때).
 */
export function StatCard({ title, value, unit, icon, tone = "", note, noteTone = "", sub, onClick, loading }) {
  const Tag = onClick ? "button" : "div";
  const shown = loading ? "…" : (value === null || value === undefined) ? "—" : typeof value === "number" ? value.toLocaleString("ko-KR") : value;
  return (
    <Tag className="stat" onClick={onClick} style={onClick ? { cursor: "pointer", border: "1px solid #edf1f6", width: "100%" } : undefined}>
      <div className="stat-top"><span>{title}</span><span className={`miniicon ${tone}`}><Icon name={icon} /></span></div>
      <div className="stat-number">{shown}{unit && shown !== "—" && shown !== "…" ? <small>{unit}</small> : null}{sub ? <span className="sub">{sub}</span> : null}</div>
      {note ? <div className={`delta ${noteTone}`}>{note}</div> : null}
    </Tag>
  );
}

export function Panel({ title, small, right, children, full, className = "", style }) {
  return (
    <section className={`panel${full ? " full" : ""} ${className}`.trim()} style={style}>
      {(title || right || small) && (
        <div className="panelhead">
          <h2>{title}</h2>
          {right || (small ? <small>{small}</small> : null)}
        </div>
      )}
      {children}
    </section>
  );
}

/** 상태 배지 — tone: wait(주황) · done(초록) · progress(파랑) · late(빨강) · gray · purple */
export function StatusBadge({ tone = "gray", children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function SearchInput({ value, onChange, placeholder, autoFocus, id }) {
  return (
    <div className="search">
      <Icon name="search" />
      <input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} autoComplete="off" />
      {value ? <button type="button" className="clear" onClick={() => onChange("")} aria-label="지우기">×</button> : null}
    </div>
  );
}

export function FilterChips({ options, value, onChange, style }) {
  return (
    <div className="filterline" style={style}>
      {options.map(([id, label, count]) => (
        <button key={id} className={`filter${value === id ? " active" : ""}`} onClick={() => onChange(id)} aria-pressed={value === id}>
          {label}{count !== undefined && count !== null ? ` ${count}` : ""}
        </button>
      ))}
    </div>
  );
}

export function TaskRow({ icon, emoji, tone = "", title, hint, count, onClick, arrow = true }) {
  return (
    <button className="task" onClick={onClick}>
      <span className={`taskicon ${tone}`}>{emoji ? emoji : <Icon name={icon} />}</span>
      <span className="tasktext"><strong>{title}</strong>{hint ? <small>{hint}</small> : null}</span>
      {count !== undefined ? <span className="taskcount">{count}</span> : null}
      {arrow ? <Icon name="chevron" className="taskarrow" /> : null}
    </button>
  );
}

/** 막대 차트 — bars: [{label, value, selected}]. 시안의 .chart(.chartmonth) 그대로. 값은 막대 위에 작게. */
export function BarChart({ bars, month = false, showValues = true }) {
  const max = Math.max(1, ...bars.map(b => b.value || 0));
  return (
    <div className={month ? "chartmonth" : "chart"}>
      {bars.map((b, i) => (
        <div key={i} className="baritem" data-label={b.label}>
          <div className={`bar${b.selected ? " selected" : ""}`} style={{ height: `${Math.max(2, Math.round((b.value || 0) / max * 100))}%` }}>
            {showValues && b.value > 0 ? <span className="val">{b.value.toLocaleString("ko-KR")}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ children, small }) {
  return <div className={`empty${small ? " small" : ""}`}>{children}</div>;
}

export function LoadingLine({ children = "불러오는 중…" }) {
  return <div className="loading-line">{children}</div>;
}

/** 두 값 세그먼트(전체 / 내 담당 등) */
export function Segment({ options, value, onChange, className = "" }) {
  return (
    <div className={`seg ${className}`.trim()} role="group">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? "active" : ""} onClick={() => onChange(k)} aria-pressed={value === k}>{label}</button>
      ))}
    </div>
  );
}

export function Chip({ on, onClick, children, danger, disabled, title }) {
  return <button className={`chip${on ? " on" : ""}${danger ? " danger" : ""}`} onClick={onClick} disabled={disabled} title={title} aria-pressed={on}>{children}</button>;
}

export const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
export const manwon = (n) => Math.round((Number(n) || 0) / 10000).toLocaleString("ko-KR");
export const shortId = (id) => String(id || "").slice(0, 8).toUpperCase();
