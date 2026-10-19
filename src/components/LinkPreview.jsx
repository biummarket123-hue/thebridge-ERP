import { useState, useEffect } from "react";

// 링크 미리보기 이미지 — 첨부된 URL의 og:image 를 /api/og-image 서버 함수로 뽑아
// 주문현황 카드에 썸네일로 표시. CORS 때문에 클라이언트가 직접 못 읽으므로 서버 경유.
//
// 캐시 계층:
//  1) 모듈 메모리(_mem)  — 같은 세션 렌더 간 재요청 방지
//  2) sessionStorage    — 새로고침 후에도 재요청 방지 (탭 유지 동안)
//  3) Vercel CDN(s-maxage) — 사용자/기기 간 공유 (서버 함수쪽)

const _mem = new Map();      // url -> string|null (해결된 이미지 URL / 없음)
const _inflight = new Map(); // url -> Promise<string|null>
const SS_PREFIX = "ogimg2:"; // v2: http→https 승격 반영 (이전 http 캐시 무효화)

function readSession(url) {
  try {
    const v = sessionStorage.getItem(SS_PREFIX + url);
    if (v === null) return undefined;    // 캐시 없음
    return v === "" ? null : v;          // "" = 이미지 없음으로 확정
  } catch { return undefined; }
}
function writeSession(url, img) {
  try { sessionStorage.setItem(SS_PREFIX + url, img || ""); } catch { /* quota 등 무시 */ }
}

async function resolveOgImage(url) {
  if (_mem.has(url)) return _mem.get(url);
  const ss = readSession(url);
  if (ss !== undefined) { _mem.set(url, ss); return ss; }
  if (_inflight.has(url)) return _inflight.get(url);

  const p = (async () => {
    try {
      const r = await fetch(`/api/og-image?url=${encodeURIComponent(url)}`);
      // 서버가 에러를 돌려준 것도 실패로 친다.
      // fetch 는 500 에 대해 던지지 않는다. 이 줄이 없으면 그대로 아래로 내려가
      // image=null 이 되고, 그게 writeSession 으로 "이 링크는 썸네일 없음 확정"이라고
      // 세션에 박힌다 — 서버가 잠깐 삐끗한 것뿐인데 그 탭에서는 새로고침해도 썸네일이
      // 돌아오지 않는다(탭을 닫아야 풀린다). 아래 catch 의 "일시적 오류는 세션에 기록하지
      // 않는다"는 의도가 HTTP 에러에는 닿지 않고 있었다.
      // shipDate.js 의 휴일 조회가 같은 이유로 !r.ok 를 검사한다.
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = await r.json().catch(() => ({}));
      const img = data?.image || null;
      _mem.set(url, img);
      writeSession(url, img);
      return img;
    } catch {
      _mem.set(url, null);
      // 세션엔 기록하지 않음 — 일시적 네트워크 오류일 수 있어 다음 로드 때 재시도
      return null;
    } finally {
      _inflight.delete(url);
    }
  })();
  _inflight.set(url, p);
  return p;
}

// 외부 이미지는 우리 서버 프록시를 거쳐 로드 — http/인증서(CN) 문제로 브라우저가
// 직접 못 부르는(mixed-content / ERR_CERT_COMMON_NAME_INVALID) 이미지를 우회.
function proxied(imgUrl) {
  return `/api/img-proxy?url=${encodeURIComponent(imgUrl)}`;
}

function OneLinkThumb({ url, T, onOpenImage }) {
  const [img, setImg] = useState(() => (_mem.has(url) ? _mem.get(url) : readSession(url)) ?? undefined);

  useEffect(() => {
    let alive = true;
    if (img !== undefined) return;              // 이미 확정(이미지 or null)
    resolveOgImage(url).then((v) => { if (alive) setImg(v); });
    return () => { alive = false; };
  }, [url]);

  if (!img) return null;                         // 로딩중(undefined) 또는 없음(null) → 표시 안 함

  const src = proxied(img);
  return (
    <div
      // 뷰어에 원본 주소도 함께 넘긴다 — 썸네일은 og:image 라 원글로 갈 단서가 사라진다.
      onClick={() => (onOpenImage ? onOpenImage(src, url) : window.open(url, "_blank", "noopener"))}
      title={url}
      style={{
        position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden",
        border: `1px solid ${T.border}`, cursor: "pointer", background: T.surface,
      }}
    >
      <img src={src} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }}
        onError={(e) => { e.currentTarget.parentElement.style.display = "none"; }} />
      <span style={{
        position: "absolute", top: 3, left: 3, fontSize: 10, lineHeight: 1,
        background: "rgba(0,0,0,0.55)", color: "#fff", padding: "2px 4px", borderRadius: 4,
      }}>🔗</span>
    </div>
  );
}

// 링크 정규화 — 프로토콜 없는 도메인형(band.us/..., www...)에도 https:// 를 붙여준다.
// 텍스트 링크는 http 없이도 저장될 수 있어, 걸러내지 말고 살려서 미리보기 시도.
function normalizeUrl(l) {
  if (typeof l !== "string") return null;
  const s = l.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s)) return "https://" + s; // 도메인.tld[/경로]
  return null;
}

// links: string[] — 여러 링크의 썸네일을 그리드로.
// onOpenImage(imgSrc, linkUrl): 있으면 클릭 시 전체화면 뷰어로, 없으면 링크 새 탭 열기.
//   두 번째 인자는 썸네일의 출처 링크 — 뷰어가 '🔗 원본 열기'를 띄우는 데 쓴다.
// minSize: 썸네일 최소 폭(px). 주문현황은 72(기본), 포장 화면은 원단을 눈으로
//          확인해야 해서 훨씬 크게 쓴다.
// fit:     "auto-fill"(기본)은 빈 칸을 남겨 크기를 고정하고,
//          "auto-fit"은 빈 칸을 접어 이미지가 1장일 때 전체 폭으로 늘어난다.
// className: 넘기면 그리드 배치를 CSS 에 맡긴다(인라인 스타일로는 미디어 쿼리를 못 써서,
//            화면 폭에 따라 열 수를 바꿔야 하는 포장 화면이 이 경로를 쓴다).
// minSize/fit: className 이 없을 때의 기본 배치. 주문현황 카드가 쓰는 기존 동작.
export default function LinkPreview({ links, T, onOpenImage, minSize = 72, fit = "auto-fill", className }) {
  const list = [...new Set((links || []).map(normalizeUrl).filter(Boolean))];
  if (list.length === 0) return null;
  const style = className
    ? undefined
    : { display: "grid", gridTemplateColumns: `repeat(${fit},minmax(${minSize}px,1fr))`, gap: 5, marginBottom: 10 };
  return (
    <div className={className} style={style}>
      {list.map((lnk, i) => <OneLinkThumb key={lnk + i} url={lnk} T={T} onOpenImage={onOpenImage} />)}
    </div>
  );
}
