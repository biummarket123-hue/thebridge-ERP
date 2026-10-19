// window.confirm 대신 — 시안 모달로 묻고 Promise<boolean> 을 돌려준다. 옛 코드의 confirm 자리에 그대로 끼운다.
import { useCallback, useState } from "react";
import { ConfirmModal } from "./Modal.jsx";

export function useAsk() {
  const [ask, setAsk] = useState(null);
  const confirm = useCallback((message, opts = {}) => new Promise(resolve => setAsk({ message, resolve, ...opts })), []);
  const host = ask ? (
    <ConfirmModal title={ask.title || "확인"} message={ask.message} confirmLabel={ask.confirmLabel || "확인"} cancelLabel={ask.cancelLabel || "취소"} danger={ask.danger}
      onConfirm={() => { ask.resolve(true); setAsk(null); }} onClose={() => { ask.resolve(false); setAsk(null); }} />
  ) : null;
  return { confirm, host };
}
