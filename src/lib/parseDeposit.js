// 입금 목록 붙여넣기 → [{금액, 입금자명, 입금시각}] 뽑아내기.
//
// 관리자는 밴드에 이런 식으로 여러 건을 한 번에 올린다:
//
//   #주문장/미배송
//   8/13(목)
//   08월 10일                22,000
//   황경옥
//   2026-08-12 18:53:39      39,000
//   이정희
//
// 즉 '날짜(시각) + 금액' 한 줄, 그 아래 '입금자명' 한 줄이 짝을 이룬다.
// 머리말(#태그, 날짜만 있는 줄)이 섞이고, 날짜 형식도 줄마다 다르다.
// 은행 알림 문자 한 줄("신한 04/12 홍길동 입금 50,000")도 같은 함수로 받는다.
//
// 완벽한 파싱은 불가능하므로, 뽑은 값은 화면에서 **고칠 수 있는 칸**에 채운다.
// 틀리게 뽑느니 비워두고 사람이 채우는 게 낫다 — 잘못된 금액이 조용히 올라가면
// 그걸 믿고 주문을 만든다.

// 사람 이름 자리에 오면 안 되는 말들. 은행명·문구가 이름으로 잡히는 걸 막는다.
const NOT_NAME = new Set([
  "입금", "출금", "이체", "잔액", "잔고", "거래", "승인", "취소", "결제", "송금", "보냄", "받음",
  "신한", "국민", "우리", "하나", "농협", "기업", "수협", "우체국", "새마을", "신협", "산업",
  "카카오뱅크", "케이뱅크", "토스뱅크", "토스", "카뱅", "대구", "부산", "경남", "광주", "전북",
  "제주", "씨티", "저축은행", "체크", "카드", "계좌", "통장", "원", "님", "고객",
  "주문장", "미배송", "미입금", "합계", "총액", "소계", "입금액", "출금액", "web발신", "발신",
]);

const toNum = (s) => Number(String(s).replace(/[^\d]/g, "")) || 0;

/** 날짜·시각·계좌번호를 지운다 — 안 지우면 2026, 08, 12 같은 수가 금액으로 잡힌다. */
const stripDate = (s) => String(s)
  .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g, " ") // 2026-08-12 18:53:39
  .replace(/\d{1,2}\s*월\s*\d{1,2}\s*일/g, " ")                                     // 08월 10일
  .replace(/\d{1,2}[/.]\d{1,2}(?:\([월화수목금토일]\))?/g, " ")                      // 8/13(목), 04/12
  .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")                                        // 14:23
  .replace(/\d{2,4}-\d{2,4}-\d{3,6}/g, " ");                                        // 123-45-6789 계좌

/** 한 줄에서 금액을 뽑는다. 이 표는 금액이 줄 끝에 오므로 마지막 수를 쓴다. */
function pickAmount(line) {
  // 잔액 뒤 숫자는 금액이 아니다. 안 자르면 통장 잔액이 입금액이 된다.
  const head = String(line).split(/잔액|잔고/)[0] || "";
  const nums = (stripDate(head).match(/\d[\d,]{2,}/g) || []).map(toNum).filter(v => v >= 100);
  return nums.length ? nums[nums.length - 1] : 0;
}

/** 한 줄에서 날짜·시각을 뽑는다. 연도가 없으면 올해로 본다. */
function pickDate(line) {
  const s = String(line);
  let y, mo, d, h = 0, mi = 0;
  let m = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; if (m[4]) { h = +m[4]; mi = +m[5]; } }
  else if ((m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) { mo = +m[1]; d = +m[2]; }
  else if ((m = s.match(/(?:^|\s)(\d{1,2})[/.](\d{1,2})(?![/.\d])/))) { mo = +m[1]; d = +m[2]; }
  else return null;

  const now = new Date();
  if (!y) y = now.getFullYear();
  if (!m[4] && !h) { const t = s.match(/(\d{1,2}):(\d{2})/); if (t) { h = +t[1]; mi = +t[2]; } }
  const dt = new Date(y, mo - 1, d, h, mi);
  if (isNaN(dt)) return null;
  // 연도가 안 적힌 12월/1월 경계에서 미래로 튀면 작년 것이다
  if (dt - now > 86400000 * 7) dt.setFullYear(dt.getFullYear() - 1);
  return dt.toISOString();
}

/**
 * 은행 알림 문자는 이름과 금액이 한 줄에 같이 온다("신한 04/12 홍길동 입금 50,000").
 * 줄 사이를 짝짓는 방식으로는 못 잡으므로 같은 줄에서 따로 뽑는다.
 * 날짜·계좌번호를 먼저 지우는 게 중요하다 — 안 그러면 계좌번호 조각이 이름으로 잡힌다.
 */
function pickNameInline(line) {
  const head = String(line).split(/잔액|잔고/)[0] || "";
  const t = stripDate(head).replace(/[[\]()]/g, " ");
  const NAME = "([가-힣A-Za-z*][가-힣A-Za-z*]{1,11})";
  const P = [
    new RegExp(NAME + "\\s*님?\\s*입금"),                    // 홍길동 입금 50,000
    new RegExp("입금\\s*[\\d,]+\\s*원?\\s*" + NAME),          // 입금 50,000원 홍길동
    new RegExp(NAME + "\\s*님?\\s*[\\d,]+\\s*원?\\s*입금"),   // 홍길동 50,000원 입금
    new RegExp(NAME + "\\s*님이?\\s*[\\d,]+\\s*원"),          // 홍길동님이 50,000원을
  ];
  for (const re of P) {
    const m = t.match(re);
    if (m && isNameLine(m[1])) return m[1].trim();
  }
  return "";
}

/** 이 줄이 사람 이름 한 덩어리인가 — 숫자가 섞이면 이름이 아니다. */
function isNameLine(line) {
  const n = String(line).trim();
  if (n.length < 2 || n.length > 14) return false;
  if (/\d/.test(n)) return false;
  if (NOT_NAME.has(n) || NOT_NAME.has(n.toLowerCase())) return false;
  return /^[가-힣A-Za-z*()\s.]+$/.test(n);
}

/**
 * 붙여넣은 덩어리에서 입금 건들을 뽑는다.
 * 날짜+금액 줄과 이름 줄이 어느 쪽이 먼저 와도 짝지어 준다.
 * @returns {Array<{amount:number, depositor:string, at:string|null, raw:string}>}
 */
export function parseDepositList(raw) {
  const lines = String(raw || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  let pendingAmt = null;   // 금액은 찾았고 이름을 기다리는 중
  let pendingName = null;  // 이름이 먼저 온 경우

  const flush = () => { if (pendingAmt) { out.push(pendingAmt); pendingAmt = null; } };

  for (const line of lines) {
    if (/^[#>*\-=]/.test(line)) continue;              // #주문장/미배송 같은 머리말

    const amount = pickAmount(line);
    if (amount) {
      flush();                                          // 앞 건이 이름 없이 끝났으면 그대로 담는다
      pendingAmt = { amount, at: pickDate(line), depositor: "", raw: line };
      const inline = pickNameInline(line);
      if (inline) {                                     // 은행 문자처럼 한 줄에 다 있는 형식
        pendingAmt.depositor = inline;
        out.push(pendingAmt); pendingAmt = null;
      } else if (pendingName) {                         // 이름이 먼저 와 있던 형식
        pendingAmt.depositor = pendingName;
        pendingAmt.raw = pendingName + "\n" + line;
        pendingName = null;
        out.push(pendingAmt); pendingAmt = null;
      }
      continue;
    }

    if (isNameLine(line)) {
      if (pendingAmt) {                                 // 흔한 형식: 금액 줄 → 이름 줄
        pendingAmt.depositor = line;
        pendingAmt.raw += "\n" + line;
        out.push(pendingAmt); pendingAmt = null;
      } else {
        pendingName = line;
      }
      continue;
    }
    // 날짜만 있는 줄(8/13(목))이나 잡줄은 버린다
  }
  flush();
  return out;
}

/**
 * 입금자명으로 담당 셀러를 추측한다 — 이게 밴드로는 못 하고 ERP라서 되는 일이다.
 * "이 입금 누구 거예요?"를 묻는 일 자체를 대부분 없앤다.
 *
 * 확정이 아니라 힌트다. 가족 이름으로 입금하는 경우가 있어 못 맞히는 건도 있고,
 * 그때는 아무 표시도 하지 않는다(틀린 이름을 붙이면 그 사람이 헛걸음한다).
 * @returns {Array<{name:string, n:number}>} 많이 맡은 순, 최대 3명
 */
export function guessManagers(depositor, orders) {
  const key = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
  const k = key(depositor);
  if (k.length < 2) return [];
  const cnt = new Map();
  for (const o of orders || []) {
    if (key(o.customer) !== k) continue;
    const m = (o.manager || "").trim();
    if (!m) continue;
    cnt.set(m, (cnt.get(m) || 0) + 1);
  }
  return [...cnt].map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n).slice(0, 3);
}
