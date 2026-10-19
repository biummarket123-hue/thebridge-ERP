import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../constants.js";

// 새 브라우저 창(팝업)에 children 을 렌더한다 (React createPortal).
// 포털이라 메인 앱과 같은 React 트리 — 상태·컨텍스트(테마)·실시간이 그대로 공유된다.
// ERP 본 창과 나란히 띄워 카톡 플로팅 창처럼 사용.
//
// props:
//   title    : 창 제목
//   width/height : 초기 크기
//   onClose  : 사용자가 창을 닫거나 팝업 차단 시 호출 (부모가 open 상태를 false 로)
//   onBlocked: 팝업 차단됐을 때 호출 (선택)
function DetachedWindow({ title = "주문 메모", width = 430, height = 680, onClose, onBlocked, children }) {
  const T = useTheme();
  const [container, setContainer] = useState(null);

  useEffect(() => {
    const features = `width=${width},height=${height},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;
    let win;
    try { win = window.open("", "erp_order_notes_popup", features); } catch { win = null; }
    if (!win) { onBlocked?.(); onClose?.(); return; }

    win.document.title = title;
    const head = win.document.head;

    // 폰트 (없어도 시스템 폰트로 폴백)
    const font = win.document.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@700;900&family=Noto+Sans+KR:wght@300;400;500;700;900&display=swap";
    head.appendChild(font);

    // 기본 리셋 + 배경(테마) — 채팅 UI가 창을 꽉 채우도록 전체 높이 레이아웃
    const style = win.document.createElement("style");
    style.textContent =
      `*{box-sizing:border-box;} html,body{height:100%;} ` +
      `body{margin:0;overflow:hidden;font-family:'Noto Sans KR',sans-serif;background:${T.bg};color:${T.cream};} ` +
      `::-webkit-scrollbar{width:8px;height:8px;} ` +
      `::-webkit-scrollbar-thumb{background:${T.border};border-radius:4px;}`;
    head.appendChild(style);

    const el = win.document.createElement("div");
    el.style.height = "100%";
    el.style.padding = "12px";
    el.style.display = "flex";
    el.style.flexDirection = "column";
    win.document.body.appendChild(el);
    setContainer(el);

    // 팝업이 사용자에 의해 닫힘 감지 (폴링) — 반드시 "메인 창" 타이머로 확인해야 함.
    // 팝업 창의 setInterval 은 팝업이 닫히면 같이 죽어서 닫힘을 감지하지 못한다.
    const timer = setInterval(() => {
      if (win.closed) { clearInterval(timer); onClose?.(); }
    }, 500);

    // 메인 창이 닫히거나 새로고침되면 팝업도 닫는다
    const closePopup = () => { try { win.close(); } catch { /* noop */ } };
    window.addEventListener("beforeunload", closePopup);

    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", closePopup);
      try { win.close(); } catch { /* noop */ }
    };
    // 최초 1회만 창 생성 (title/크기 변경으로 재생성하지 않음)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!container) return null;
  return createPortal(children, container);
}

export default DetachedWindow;
