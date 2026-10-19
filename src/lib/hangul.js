// 한글 두벌식 조합 — ERP 자체 화면 키보드(ScreenKeyboard)가 쓴다. DB·React 없음, tests/ 에서 그대로 돈다.
//
// 왜 만드는가(2026-10-15): 포장팀 아이패드에 블루투스 스캐너가 붙어 있으면 아이패드가 그걸 키보드로 보고
// 화면 키보드를 숨긴다. 검색·사유를 치려면 매번 ⌨︎ 버튼을 눌러야 해서 ERP 안에 키보드를 둔다.
// 외부 라이브러리 없이 글 끝 한 글자만 보고 자모를 붙이는 방식 — 실제 입력기(IME)와 같은 결과가 난다.
//   typeJamo("가", "ㄱ") → "각"     typeJamo("각", "ㅏ") → "가가"     typeJamo("ㅗ", "ㅏ") → "ㅘ"
//   backspace("각") → "가"          backspace("가") → "ㄱ"            backspace("ㄱ") → ""

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";                       // 초성 19
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";                   // 중성 21
const JONG = "\0ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";       // 종성 28 (0 = 받침 없음)
const BASE = 0xac00;

// 겹모음·겹받침: "앞+뒤 → 합친 것". 거꾸로(합친 것 → 앞·뒤)는 지우기에 쓴다.
const VOWEL_PAIRS = { "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ", "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ", "ㅡㅣ": "ㅢ" };
const FINAL_PAIRS = { "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ", "ㄹㄱ": "ㄺ", "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ", "ㄹㅅ": "ㄽ", "ㄹㅌ": "ㄾ", "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ", "ㅂㅅ": "ㅄ" };
const splitPair = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [v, [k[0], k[1]]]));
const VOWEL_SPLIT = splitPair(VOWEL_PAIRS);
const FINAL_SPLIT = splitPair(FINAL_PAIRS);

export const isConsonant = (ch) => CHO.includes(ch) || JONG.includes(ch);
export const isVowel = (ch) => JUNG.includes(ch);
export const isJamo = (ch) => !!ch && (isConsonant(ch) || isVowel(ch));

/** 완성 글자를 (초, 중, 종) 글자로 푼다. 완성 글자가 아니면 null. */
export function decompose(ch) {
  const code = (ch || "").charCodeAt(0) - BASE;
  if (!(code >= 0 && code < 11172)) return null;
  const cho = Math.floor(code / 588), jung = Math.floor((code % 588) / 28), jong = code % 28;
  return { cho: CHO[cho], jung: JUNG[jung], jong: jong ? JONG[jong] : "" };
}

/** (초, 중, 종) 글자로 완성 글자를 만든다. 못 만들면 null. */
export function compose(cho, jung, jong = "") {
  const c = CHO.indexOf(cho), j = JUNG.indexOf(jung), f = jong ? JONG.indexOf(jong) : 0;
  if (c < 0 || j < 0 || f < 0) return null;
  return String.fromCharCode(BASE + (c * 21 + j) * 28 + f);
}

/**
 * 글 끝에 자모 하나를 친다. 자모가 아니면(숫자·영문·공백 등) 그냥 붙인다.
 * 실제 입력기처럼 글 끝 한 글자와만 합친다 — 받침 있는 글자 뒤에 모음이 오면 받침이 다음 글자 초성으로 넘어간다.
 */
export function typeJamo(text, jamo) {
  const s = String(text || "");
  if (!isJamo(jamo)) return s + jamo;
  const last = s.slice(-1), head = s.slice(0, -1);
  const d = decompose(last);

  if (isVowel(jamo)) {
    // 홀로 있는 자음 + 모음 → 글자
    if (last && CHO.includes(last) && !d) {
      const made = compose(last, jamo);
      return made ? head + made : s + jamo;
    }
    if (d) {
      if (d.jong) {
        // 받침을 떼어 다음 글자 초성으로. 겹받침이면 뒷부분만 넘어간다 (앉+ㅏ → 안자)
        const [keep, move] = FINAL_SPLIT[d.jong] || ["", d.jong];
        const next = compose(move, jamo);
        if (next) return head + compose(d.cho, d.jung, keep) + next;
        return s + jamo;
      }
      // 받침 없는 글자의 모음과 겹모음이 되면 합친다 (고+ㅏ → 과)
      const merged = VOWEL_PAIRS[d.jung + jamo];
      if (merged) return head + compose(d.cho, merged);
      return s + jamo;
    }
    // 홀로 있는 모음끼리 겹모음 (ㅗ+ㅏ → ㅘ)
    const merged = VOWEL_PAIRS[last + jamo];
    if (merged) return head + merged;
    return s + jamo;
  }

  // 자음
  if (d) {
    if (!d.jong) {
      // 받침으로 들어간다 (가+ㄱ → 각). 받침이 못 되는 자음(ㄸㅃㅉ)은 새 글자 시작
      const made = compose(d.cho, d.jung, jamo);
      if (made) return head + made;
      return s + jamo;
    }
    // 겹받침 (갑+ㅅ → 값)
    const merged = FINAL_PAIRS[d.jong + jamo];
    if (merged) return head + compose(d.cho, d.jung, merged);
    return s + jamo;
  }
  return s + jamo;
}

/** 글 끝에서 자모 하나를 지운다. 완성 글자는 받침→모음→초성 순으로 풀리고, 겹받침·겹모음은 뒷부분만 빠진다. */
export function backspace(text) {
  const s = String(text || "");
  if (!s) return s;
  const last = s.slice(-1), head = s.slice(0, -1);
  const d = decompose(last);
  if (d) {
    if (d.jong) {
      const pair = FINAL_SPLIT[d.jong];
      return head + compose(d.cho, d.jung, pair ? pair[0] : "");
    }
    const pair = VOWEL_SPLIT[d.jung];
    if (pair) return head + compose(d.cho, pair[0]);
    return head + d.cho;
  }
  const pair = VOWEL_SPLIT[last] || FINAL_SPLIT[last];
  if (pair) return head + pair[0];
  return head;
}

/** 자모 열을 차례로 친 결과 — 테스트·시연용. typeText("", "ㅇㅣㄴㅎㅢ") → "인희" */
export function typeText(text, jamos) {
  let s = String(text || "");
  for (const j of jamos) s = typeJamo(s, j);
  return s;
}
