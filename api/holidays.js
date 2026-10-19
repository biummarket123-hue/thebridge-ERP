// 공휴일·회사휴무일 프록시 — 연차 앱(yeoncha-app)의 /api/holidays 를 서버가 대신 받아 넘긴다.
//
// 왜 프록시인가:
//  - 브라우저에서 직접 부르면 교차 출처라 CORS 에 막힌다. 연차 앱은 별도 배포(다른 도메인)라
//    그쪽 코드를 고쳐야 하는데, 서버가 대신 받으면 CORS 자체가 적용되지 않는다.
//    (api/img-proxy.js 와 같은 이유·같은 패턴)
//  - 연차 앱 응답은 법정공휴일(한국천문연구원 특일정보 API) + 회사 지정 휴일이 이미 병합된 값이다.
//    연차 달력에서 여름휴가를 등록하면 여기로도 그대로 넘어온다.
//
// 실패 시 502 를 준다. 호출 측(src/lib/shipDate.js)이 정적 폴백 표로 넘어가
// 출고예정일 계산이 멈추지 않게 하기 위함 — 빈 목록을 주면 공휴일이 없는 것으로
// 오인해 휴일에 출고일이 잡히는 사고가 난다.

const UPSTREAM = "https://yeoncha-app.vercel.app/api/holidays";

export default async function handler(req, res) {
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "잘못된 연도입니다." });
  }
  try {
    const r = await fetch(`${UPSTREAM}?year=${year}`);
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const json = await r.json();
    const holidays = json?.holidays;
    if (!holidays || typeof holidays !== "object") throw new Error("unexpected payload");
    // 회사 휴무일 변경이 1시간 안에 반영되면 충분 — 출고일 계산은 날짜 단위라서.
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    // events(회사 일정 라벨)는 휴무가 아니므로 버린다. 출고일 계산에 필요한 건 빨간날뿐.
    return res.status(200).json({ holidays, source: json.source || "none" });
  } catch (e) {
    console.error("[holidays] 연차 앱 조회 실패:", e.message);
    return res.status(502).json({ error: "휴일 정보를 가져오지 못했습니다" });
  }
}
