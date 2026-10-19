import { S, useTheme } from "../constants.js";
import { CJ, KD, COURIERS, COURIER_SHORT, autoCourier } from "../lib/courier.js";

// 택배사 색 — CJ 는 파랑, 경동은 보라. 포장대에서 박스를 어느 쪽에 쌓을지
// 글자를 읽지 않고 색으로 가르게 한다.
export const courierColor = (courier, T) =>
  courier === KD ? [T.purple, "rgba(138,106,184,0.14)"] : [T.blue, T.blueBg];

const WHY = { manual: "직접 지정", roll: "메모에 '롤'", default: "메모에 '롤'이 없어 CJ" };

/**
 * 카드에 붙는 택배사 표시. 왜 그 택배사인지를 표시로 알린다 — ✎ 직접 지정, 롤 은 메모에서 읽은 것.
 */
export function CourierTag({ courier, why = "default", manual = false, size = 10 }) {
  const T = useTheme();
  const [c, bg] = courierColor(courier, T);
  const reason = manual ? "manual" : why;
  return (
    <span title={`${courier} — ${WHY[reason] || WHY.default}`}
      style={{fontSize:size,fontWeight:800,color:c,background:bg,padding:"1px 6px",borderRadius:4,
        border:`1px solid ${c}55`,whiteSpace:"nowrap",fontFamily:S}}>
      🚚 {COURIER_SHORT[courier] || courier}{reason === "manual" ? " ✎" : reason === "roll" ? " 롤" : ""}
    </span>
  );
}

/** 방문·픽업 표시 — 택배로 안 나가는 박스. */
export function PickupTag({ size = 10 }) {
  const T = useTheme();
  return (
    <span title="담당자가 방문고객이거나 메모에 방문·픽업이 적힌 주문입니다"
      style={{fontSize:size,fontWeight:800,color:T.copper,background:T.copperGlow,padding:"1px 6px",borderRadius:4,
        border:`1px solid ${T.copper}55`,whiteSpace:"nowrap",fontFamily:S}}>
      🙋 방문·픽업
    </span>
  );
}

/**
 * 택배사 고르기 — 주문 등록·수정 화면용.
 *
 * value 가 null 이면 '자동'이다: 메모에 '롤'이 있으면 경동, 아니면 CJ (배송비는 안 본다 — 2026-10-12).
 * 대부분의 주문은 손댈 필요가 없고, 그래도 안 맞는 주문만 고른다.
 *
 * memo: 일반 메모와 담당자 메모를 이어 붙인 글. '자동'이 무엇이 될지 미리 보여주는 데 쓴다.
 */
export function CourierField({ memo = "", value = null, onChange }) {
  const T = useTheme();
  const auto = autoCourier(memo);
  const picked = COURIERS.includes(value) ? value : null;
  const opts = [
    { v: null, l: `자동 (${COURIER_SHORT[auto.courier]})`, c: T.copper, bg: T.copperGlow },
    { v: CJ, l: "CJ", c: courierColor(CJ, T)[0], bg: courierColor(CJ, T)[1] },
    { v: KD, l: "경동", c: courierColor(KD, T)[0], bg: courierColor(KD, T)[1] },
  ];
  return (
    <div style={{marginTop:10}}>
      <div style={{fontSize:11,color:T.creamMuted,marginBottom:5,fontWeight:600}}>🚚 택배사</div>
      <div style={{display:"flex",gap:5}}>
        {opts.map(o => {
          const on = picked === o.v;
          return (
            <button key={o.l} type="button" onClick={() => onChange?.(o.v)} aria-pressed={on}
              style={{flex:1,padding:"8px 4px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12,
                fontWeight: on ? 800 : 500, whiteSpace:"nowrap",
                border:`1px solid ${on ? o.c : T.border}`,
                background: on ? o.bg : "transparent",
                color: on ? o.c : T.creamMuted}}>
              {o.l}
            </button>
          );
        })}
      </div>
      <div style={{fontSize:10,color:T.creamMuted,marginTop:4,lineHeight:1.5}}>
        {picked
          ? `${COURIER_SHORT[picked]}로 직접 지정했습니다 — 메모가 바뀌어도 그대로입니다`
          : auto.why === "roll"
            ? "메모에 '롤'이 있어 경동으로 나갑니다"
            : "메모에 '롤'이 있으면 경동, 아니면 CJ 입니다"}
      </div>
    </div>
  );
}
