import { useState, useEffect, useRef } from "react";
import { useTheme } from "../constants.js";

// 왼쪽 가장자리 떠있는 미니 스크롤 위젯.
// - ⬆/⬇ 버튼: 맨 위/맨 아래로 부드럽게 스크롤
// - 가운데 트랙+썸: 드래그로 위치 이동, 트랙 클릭으로 점프
// - 페이지가 스크롤할 만큼 길지 않으면 자동 숨김
// 스크롤을 멈춘 뒤 위젯이 남아 있는 시간. 3초는 길다는 의견이 있어 2초로 줄였다.
const AWAKE_MS = 2000;

export default function SideScroller() {
  const T = useTheme();
  const [scrollPct, setScrollPct] = useState(0);
  const [hasScroll, setHasScroll] = useState(false);
  const [hover, setHover] = useState(false);
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  // 모바일(터치 기기)에선 평소엔 숨기고, 스크롤할 때만 나타났다가 2초 뒤 사라진다 —
  // 좁은 화면에서 늘 떠 있으면 배지·버튼 오른쪽 끝을 가리기 때문이다. PC 는 그대로 상시 표시.
  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const [awake, setAwake] = useState(false);
  const awakeTimer = useRef(null);
  useEffect(() => {
    if (!isTouch) return;
    const wake = () => {
      setAwake(true);
      clearTimeout(awakeTimer.current);
      awakeTimer.current = setTimeout(() => { if (!draggingRef.current) setAwake(false); }, AWAKE_MS);
    };
    window.addEventListener("scroll", wake, { passive: true });
    return () => { window.removeEventListener("scroll", wake); clearTimeout(awakeTimer.current); };
  }, [isTouch]);

  useEffect(() => {
    const update = () => {
      const docH = document.documentElement.scrollHeight - window.innerHeight;
      setHasScroll(docH > 80);
      if (docH <= 0) { setScrollPct(0); return; }
      setScrollPct(Math.max(0, Math.min(1, window.scrollY / docH)));
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    // 콘텐츠가 비동기로 늘어나는 케이스(주문 추가 로딩 등) 대비
    const interval = setInterval(update, 1000);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      clearInterval(interval);
    };
  }, []);

  const scrollToPct = (pct) => {
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: pct * docH, behavior: "auto" });
  };

  const onTrackClick = (e) => {
    if (draggingRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = (e.clientY - rect.top) / rect.height;
    scrollToPct(Math.max(0, Math.min(1, pct)));
  };

  const startDrag = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev) => {
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = (cy - rect.top) / rect.height;
      scrollToPct(Math.max(0, Math.min(1, pct)));
    };
    const onEnd = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  };

  if (!hasScroll) return null;
  const hidden = isTouch && !awake && !draggingRef.current;

  const thumbH = 32;
  // 트랙 길이는 화면 높이에 비례 — 짧은 창에서도 길게, 큰 창에서는 더 길게.
  // 위/아래 버튼 + 헤더 영역까지 고려해 약 140px만 빼고 나머지를 차지.

  return (
    <div
      className="erp-side-scroller"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "fixed",
        right: 8,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        // 100vh 가 아니라 100% — 이 위젯은 .erp-root 안이라 zoom(글씨 배율)이 vh 를
        // 부풀린다(배율 1.3 이면 100vh 가 화면의 130%). fixed 요소의 % 는 안 부푼다.
        height: "calc(100% - 140px)",
        maxHeight: 800,
        opacity: hidden ? 0 : (hover || draggingRef.current ? 1 : 0.55),
        pointerEvents: hidden ? "none" : "auto",
        transition: hidden ? "opacity 0.4s" : "opacity 0.15s",
      }}
    >
      {/* 맨 위로 */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        title="맨 위로"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: `1px solid ${T.border}`,
          background: T.card,
          color: T.copper,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 800,
          boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        ⬆
      </button>

      {/* 트랙 + 썸 — flex:1 로 가운데 영역을 모두 채워 길게 */}
      <div
        ref={trackRef}
        onClick={onTrackClick}
        style={{
          width: 6,
          flex: 1,
          minHeight: 200,
          borderRadius: 3,
          background: T.border,
          position: "relative",
          cursor: "pointer",
        }}
      >
        <div
          onMouseDown={startDrag}
          onTouchStart={startDrag}
          style={{
            position: "absolute",
            left: -5,
            // 트랙 길이가 동적이므로 % + 썸 높이 보정 공식 사용:
            // 0% 일 때 0, 100% 일 때 (track - thumbH) 가 되도록.
            top: `calc(${scrollPct * 100}% - ${scrollPct * thumbH}px)`,
            width: 16,
            height: thumbH,
            borderRadius: 8,
            background: T.copper,
            cursor: "grab",
            boxShadow: "0 2px 6px rgba(0,0,0,0.22)",
            border: `1.5px solid ${T.card}`,
          }}
        />
      </div>

      {/* 맨 아래로 */}
      <button
        onClick={() =>
          window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: "smooth",
          })
        }
        title="맨 아래로"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          border: `1px solid ${T.border}`,
          background: T.card,
          color: T.copper,
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 800,
          boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        ⬇
      </button>
    </div>
  );
}
