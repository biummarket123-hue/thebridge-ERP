// 모달(.sheetbg/.sheet) — 바깥 클릭·×·Escape 로 닫힌다. 열릴 때 첫 입력칸(없으면 닫기 버튼)에 포커스,
// 닫히면 열기 전 요소로 포커스를 돌려준다. 뒤 화면 스크롤은 잠근다. 모바일에서는 아래에서 올라온다(CSS).
import { useEffect, useRef, useState } from "react";

let openCount = 0;

export function Modal({ title, onClose, children, width, closing: closingProp, labelledBy }) {
  const boxRef = useRef(null);
  const prevFocus = useRef(null);
  const [closing, setClosing] = useState(false);

  const requestClose = () => {
    if (closing) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { onClose?.(); return; }
    setClosing(true);
    setTimeout(() => onClose?.(), 170);
  };

  useEffect(() => {
    prevFocus.current = document.activeElement;
    openCount += 1;
    document.body.style.overflow = "hidden";
    const first = boxRef.current?.querySelector("input:not([type=hidden]):not([disabled]), textarea, select, [data-autofocus]");
    (first || boxRef.current?.querySelector(".xbtn"))?.focus?.({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); requestClose(); }
      if (e.key === "Tab" && boxRef.current) {
        // 포커스를 창 안에 가둔다
        const f = [...boxRef.current.querySelectorAll("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])")].filter(el => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const firstEl = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openCount -= 1;
      if (openCount <= 0) { document.body.style.overflow = ""; openCount = 0; }
      prevFocus.current?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cls = width === "wide" ? "sheet wide" : width === "xwide" ? "sheet xwide" : "sheet";
  return (
    <div className={`sheetbg${closing || closingProp ? " closing" : ""}`} onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className={cls} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} aria-labelledby={labelledBy} ref={boxRef}>
        <div className="sheethead">
          <h2>{title}</h2>
          <button className="xbtn" onClick={requestClose} aria-label="닫기">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 확인 창 — window.confirm 대신. onConfirm 이 Promise 면 끝날 때까지 버튼이 잠긴다. */
export function ConfirmModal({ title = "확인", message, confirmLabel = "확인", cancelLabel = "취소", danger, onConfirm, onClose, children }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      {message ? <p className="helptext" style={{ whiteSpace: "pre-line" }}>{message}</p> : null}
      {children}
      <div className="btnrow">
        <button className="btn btn-white" onClick={onClose} disabled={busy}>{cancelLabel}</button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}${busy ? " loading" : ""}`} disabled={busy} onClick={async () => {
          setBusy(true);
          try { await onConfirm?.(); } finally { setBusy(false); }
        }}>{busy ? <span className="spin" /> : null}{confirmLabel}</button>
      </div>
    </Modal>
  );
}
