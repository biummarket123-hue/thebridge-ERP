// 텔레그램 전송 — 이 파일은 DB 를 전혀 모른다. 문자열을 받아 봇 API 로 보낼 뿐이다.

const TG_MAX = 4096; // 텔레그램 메시지 길이 상한

// 메시지에 비밀이 섞여 나가지 않게 지운다. 에러 메시지는 특히 위험하다 —
// supabase-js 가 URL 이나 키 조각을 그대로 박아 넣는 경우가 있다.
export function sanitize(text) {
  return String(text ?? "")
    .replace(/\d{6,}:[A-Za-z0-9_-]{25,}/g, "[봇토큰]")            // 텔레그램 봇 토큰 (123456:ABC-...)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*/g, "[JWT]") // supabase 키(JWT)
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[SB키]") // 새 형식 supabase 키
    .replace(/https?:\/\/[^\s?#]+(\?[^\s]*)?/g, (m) => {           // URL 은 호스트만 남기고 파라미터·경로 제거
      try { return new URL(m).host; } catch { return "[URL]"; }
    })
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[가림]");
}

export function truncate(text, max = TG_MAX) {
  if (text.length <= max) return text;
  const tail = "\n… (길어서 잘림)";
  return text.slice(0, max - tail.length) + tail;
}

// 성공하면 true. 실패하면 예외 — 호출한 쪽(run.mjs)이 stderr 로 남기고 종료 코드로 알린다.
export async function sendTelegram({ token, chatId, text }) {
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 없습니다");
  const body = truncate(sanitize(text));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    // 응답 본문에 토큰이 들어올 일은 없지만, 습관적으로 sanitize 를 거친다.
    const detail = sanitize(await res.text().catch(() => ""));
    throw new Error(`텔레그램 전송 실패 HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}
