// 프롬프트 캐시 — 순수 규칙(import 없음, tests/saas/test-ai-cache.mjs 가 그대로 읽는다).
//
// 사용자 결정(2026-10-23): AI 분석의 공통 지시문(src/constants.js PARSE_SYSTEM, 약 7,455자 ≈ 5,000토큰)을 앤트로픽 쪽에
// 외워 두게 한다. 요청의 system 첫 블록 끝에 cache_control 을 붙이면, 같은 글로 5분 안에 다시 오는 요청은 그 부분을
// 보통 요금의 1/10 로 읽는다(처음 저장은 1.25배). 맞을 때마다 5분이 연장된다.
//
//   · 캐시는 "표시 앞부분이 글자까지 같은가"만 본다. 그래서 바뀌지 않는 공통 지시문이 첫 블록, 회사·주문마다 다른 글은
//     그 뒤(두 번째 블록이나 messages)에 와야 한다. 첫 블록에만 표시를 붙이므로 자유 형식 부록(FREEFORM_ADDENDUM)이
//     두 번째 블록으로 와도 공통 부분은 그대로 맞는다.
//   · 캐시는 우리 API 키 하나에 묶인다 — 회사별이 아니라 서비스 전체가 같이 쓴다. 주문 글(고객 이름·전화)은 표시 뒤라
//     외워지지 않는다.
//   · Haiku 는 2,048토큰부터 캐시된다. 지시문을 크게 줄이면 조용히 캐시가 안 될 수 있으니 cacheSummary 로그를 본다.

/**
 * 화면이 보낸 system(문자열 또는 블록 배열)을 블록 배열로 바꾸고 첫 블록에 캐시 표시를 붙인다.
 * 빈 system 이면 undefined(앤트로픽에 system 을 안 보낸다). 이미 표시가 있는 블록은 그대로 둔다.
 */
export function withPromptCache(system) {
  const blocks = typeof system === "string"
    ? (system.trim() ? [{ type: "text", text: system }] : [])
    : Array.isArray(system) ? system.filter(b => b && typeof b === "object" && typeof b.text === "string" && b.text.trim()).map(b => ({ ...b, type: b.type || "text" })) : [];
  if (!blocks.length) return undefined;
  if (!blocks[0].cache_control) blocks[0] = { ...blocks[0], cache_control: { type: "ephemeral" } };
  return blocks;
}

/** 응답 usage → 로그 한 줄용 요약. hit = 캐시에서 읽은 토큰이 있었나. */
export function cacheSummary(usage = {}) {
  const read = Number(usage.cache_read_input_tokens) || 0;
  const wrote = Number(usage.cache_creation_input_tokens) || 0;
  const fresh = Number(usage.input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  return { hit: read > 0, read, wrote, fresh, out, text: `캐시 ${read > 0 ? "적중" : wrote > 0 ? "저장" : "없음"} · 읽음 ${read} · 저장 ${wrote} · 새 입력 ${fresh} · 출력 ${out}` };
}
