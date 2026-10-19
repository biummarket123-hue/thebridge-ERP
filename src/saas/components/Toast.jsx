// 토스트(.toast) — 아래에서 올라와 2.6초 뒤 사라진다. 성공/실패 두 가지.
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Icon } from "../icons.jsx";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [t, setT] = useState({ msg: "", type: "ok", show: false });
  const timer = useRef(0);
  const toast = useCallback((msg, type = "ok") => {
    clearTimeout(timer.current);
    setT({ msg: String(msg || ""), type: type === "error" ? "error" : "ok", show: true });
    timer.current = setTimeout(() => setT(p => ({ ...p, show: false })), type === "error" ? 4200 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast${t.show ? " show" : ""}${t.type === "error" ? " error" : ""}`} role="status" aria-live="polite">
        <Icon name={t.type === "error" ? "alert" : "check"} /><span>{t.msg}</span>
      </div>
    </ToastCtx.Provider>
  );
}
