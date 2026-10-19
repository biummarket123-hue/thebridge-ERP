// 출고예정일(ship_date) 계산 — 영업일 판정, 기본값, 포장 화면 칸 배치.
//
// 휴일 정보는 연차 앱(yeoncha-app)이 단일 출처다.
//   연차 달력(회사 휴무일) + 한국천문연구원 특일정보 API(법정공휴일)
//     → yeoncha-app/api/holidays  → ERP api/holidays.js(프록시)  → 여기
// 연차 달력에서 여름휴가를 등록하면 ERP 출고예정일이 자동으로 그 날을 건너뛴다.
//
// 네트워크가 죽어도 출고일 계산은 멈추면 안 되므로 정적 폴백 표를 갖고 있다.
// 아래 표는 연차 앱 src/lib/holidays.ts 의 폴백 표를 그대로 옮긴 것이다(특일정보 API 공식 응답).
// 연 1회 갱신 필요 — 다만 평상시엔 프록시 값이 우선이라 표가 낡아도 즉시 문제되진 않는다.

const FALLBACK_HOLIDAYS = {
  // 2025
  "2025-01-01": "1월1일", "2025-01-27": "임시공휴일",
  "2025-01-28": "설날", "2025-01-29": "설날", "2025-01-30": "설날",
  "2025-03-01": "삼일절", "2025-03-03": "대체공휴일",
  "2025-05-05": "부처님오신날", "2025-05-06": "대체공휴일",
  "2025-06-03": "임시공휴일(제21대 대통령 선거)", "2025-06-06": "현충일",
  "2025-08-15": "광복절", "2025-10-03": "개천절",
  "2025-10-05": "추석", "2025-10-06": "추석", "2025-10-07": "추석",
  "2025-10-08": "대체공휴일", "2025-10-09": "한글날", "2025-12-25": "기독탄신일",
  // 2026
  "2026-01-01": "1월1일",
  "2026-02-16": "설날", "2026-02-17": "설날", "2026-02-18": "설날",
  "2026-03-01": "삼일절", "2026-03-02": "대체공휴일(삼일절)",
  "2026-05-01": "노동절", "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날", "2026-05-25": "대체공휴일(부처님오신날)",
  "2026-06-03": "전국동시지방선거", "2026-06-06": "현충일",
  "2026-07-17": "제헌절", "2026-08-15": "광복절", "2026-08-17": "대체공휴일(광복절)",
  "2026-09-24": "추석", "2026-09-25": "추석", "2026-09-26": "추석",
  "2026-10-03": "개천절", "2026-10-05": "대체공휴일(개천절)",
  "2026-10-09": "한글날", "2026-12-25": "기독탄신일",
  // 2027
  "2027-01-01": "1월1일",
  "2027-02-06": "설날", "2027-02-07": "설날", "2027-02-08": "설날",
  "2027-02-09": "대체공휴일(설날)",
  "2027-03-01": "삼일절", "2027-05-01": "노동절", "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날", "2027-06-06": "현충일", "2027-07-17": "제헌절",
  "2027-08-15": "광복절", "2027-08-16": "대체공휴일(광복절)",
  "2027-09-14": "추석", "2027-09-15": "추석", "2027-09-16": "추석",
  "2027-10-03": "개천절", "2027-10-04": "대체공휴일(개천절)",
  "2027-10-09": "한글날", "2027-10-11": "대체공휴일(한글날)",
  "2027-12-25": "기독탄신일", "2027-12-27": "대체공휴일(기독탄신일)",
};

// ── 날짜 헬퍼 ────────────────────────────────────────────────
// 전부 로컬 시간 기준. toISOString()을 쓰면 UTC로 밀려 하루가 어긋난다(한국은 +9).

/** Date → "YYYY-MM-DD" */
export function ymd(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "YYYY-MM-DD" → Date (로컬 자정) */
export function parseYmd(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

export const todayYmd = () => ymd(new Date());

// ── 휴일 로딩 ────────────────────────────────────────────────
// 연도별로 한 번만 조회하고 메모리에 캐시. localStorage 에도 남겨
// 새로고침 직후 네트워크를 기다리지 않고 바로 계산할 수 있게 한다.

const LS_KEY = y => `erp_holidays_${y}`;
const memCache = new Map();   // year -> {[ymd]: name}
const inflight = new Map();   // year -> Promise

function fallbackFor(year) {
  const out = {};
  const prefix = `${year}-`;
  for (const [k, v] of Object.entries(FALLBACK_HOLIDAYS)) {
    if (k.startsWith(prefix)) out[k] = v;
  }
  return out;
}

/** 해당 연도 휴일맵을 반환. 실패 시 정적 폴백. 절대 throw 하지 않는다. */
export async function loadHolidays(year) {
  if (memCache.has(year)) return memCache.get(year);
  if (inflight.has(year)) return inflight.get(year);

  const p = (async () => {
    // 1) localStorage 선반영 — 있으면 즉시 쓰고, 아래에서 신선한 값으로 덮는다
    try {
      const cached = JSON.parse(localStorage.getItem(LS_KEY(year)) || "null");
      if (cached && typeof cached === "object" && Object.keys(cached).length) {
        memCache.set(year, cached);
      }
    } catch { /* 캐시 파손은 무시 — 아래 네트워크/폴백으로 처리 */ }

    try {
      const r = await fetch(`/api/holidays?year=${year}`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const json = await r.json();
      const h = json?.holidays;
      if (!h || typeof h !== "object" || !Object.keys(h).length) throw new Error("empty");
      memCache.set(year, h);
      try { localStorage.setItem(LS_KEY(year), JSON.stringify(h)); } catch { /* 용량 초과 무시 */ }
      return h;
    } catch (e) {
      if (memCache.has(year)) return memCache.get(year);   // localStorage 값으로 버틴다
      console.warn(`[shipDate] ${year}년 휴일 조회 실패 — 내장 표 사용:`, e.message);
      const fb = fallbackFor(year);
      memCache.set(year, fb);
      return fb;
    }
  })();

  inflight.set(year, p);
  try { return await p; } finally { inflight.delete(year); }
}

/** 계산에 필요한 연도들을 미리 받아둔다(올해·내년). 앱 시작 시 1회 호출. */
export async function preloadHolidays(base = new Date()) {
  const y = base.getFullYear();
  await Promise.all([loadHolidays(y), loadHolidays(y + 1)]);
}

/**
 * 동기 판정용 휴일맵 — preload 이후에만 정확하다.
 * 아직 안 받았으면 폴백 표로 답한다(계산이 멈추는 것보다 낫다).
 */
function holidaysSync(year) {
  return memCache.get(year) || fallbackFor(year);
}

/** 공휴일·회사휴무일이면 이름, 아니면 null */
export function holidayName(dateStr) {
  const y = Number(String(dateStr).slice(0, 4));
  return holidaysSync(y)[dateStr] || null;
}

/** 영업일인가 — 토·일·공휴일·회사휴무일이 아니면 true */
export function isBusinessDay(d) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;      // 일·토
  return !holidayName(ymd(d));
}

/** from 다음의 첫 영업일 (from 당일은 제외) */
export function nextBusinessDay(from = new Date()) {
  let d = addDays(from, 1);
  // 연휴가 길어야 열흘 남짓 — 60일이면 무한루프 방지용으로 충분하다.
  for (let i = 0; i < 60 && !isBusinessDay(d); i++) d = addDays(d, 1);
  return d;
}

/**
 * 신규 주문의 기본 출고예정일 = 다음 영업일.
 * 마감시간 개념은 없다 — 밤 11시에 등록해도 기본값은 내일(영업일).
 */
export function defaultShipDate(from = new Date()) {
  return ymd(nextBusinessDay(from));
}

// ── 포장 화면 칸 배치 ────────────────────────────────────────

export const BUCKETS = {
  urgent:   { key: "urgent",   label: "긴급", emoji: "🔴" },
  today:    { key: "today",    label: "당일", emoji: "🟠" },
  tomorrow: { key: "tomorrow", label: "익일", emoji: "🔵" },
  later:    { key: "later",    label: "예약", emoji: "📅" },
};

/**
 * 주문이 들어갈 칸. 라벨을 저장하지 않고 매번 오늘 기준으로 계산하므로,
 * 익일로 등록한 주문이 다음날 자동으로 당일 칸으로 올라온다.
 *
 * ship_date 가 없는(NULL) 기존 주문은 '당일'로 본다 — 이미 밀린 건들이라
 * 익일/예약으로 숨으면 영영 안 나간다.
 */
export function shipBucket(order, today = new Date()) {
  if (order?.isUrgent) return "urgent";
  const sd = order?.shipDate;
  if (!sd) return "today";
  const t = ymd(today);
  if (sd <= t) return "today";
  return sd === ymd(addDays(today, 1)) ? "tomorrow" : "later";
}

/** 목록 정렬용 — 긴급 → 당일 → 익일 → 예약, 같은 칸이면 출고예정일 빠른 순 */
export function shipSortKey(order, today = new Date()) {
  const order_ = ["urgent", "today", "tomorrow", "later"].indexOf(shipBucket(order, today));
  return [order_, order?.shipDate || "0000-00-00"];
}
