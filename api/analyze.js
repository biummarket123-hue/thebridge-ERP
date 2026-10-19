import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// 로그인 세션 검증 — 이 프록시는 서버의 앤트로픽 키로 돈을 쓰는 자리라, 누구나 POST 할 수
// 있으면 키 예산을 남이 태울 수 있다(2026-09-17 보안 진단 H4). 브라우저가 Supabase
// access token 을 Authorization: Bearer 로 보내고, 서버가 GoTrue 에 물어 유효한 세션인지
// 확인한 뒤에만 앤트로픽을 부른다.
//
// 검증 키: service_role 이 있으면 그것을, 없으면 anon 키를 쓴다. getUser(jwt) 는 apikey 가
// 무엇이든 그 jwt 자체를 GoTrue 가 검증하므로 둘 다 유효하다. 운영 Vercel 에는 현재
// service_role 이 없고 VITE_SUPABASE_ANON_KEY 만 있어서 폴백이 있어야 배포 직후에도 동작한다.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const VERIFY_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

async function getSessionUser(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return { user: null, reason: "no-token" };
  if (!SUPABASE_URL || !VERIFY_KEY) return { user: null, reason: "env-missing" };
  const sb = createClient(SUPABASE_URL, VERIFY_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.getUser(m[1]);
  if (error || !data?.user) return { user: null, reason: "invalid" };
  return { user: data.user, reason: null };
}

// 주문 메시지 분석 프록시 — 브라우저가 앤트로픽 키를 들고 있지 않도록 서버를 한 번 거친다.
//
// raw fetch 로 직접 부르던 자리다. 그러면 앤트로픽이 잠깐 흔들릴 때(529 overloaded,
// 429 rate limit, 일시적 5xx) 그게 곧바로 직원 화면의 "품목 자동 분석 실패"가 됐다.
// 이런 오류는 원래 1~2초 뒤에 다시 부르면 대개 통과하는 종류인데, 다시 부르는 코드가
// 어디에도 없었다. SDK 는 그 재시도를 기본으로 갖고 있어서 그대로 쓴다.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // 408/409/429/5xx(529 포함)와 연결 오류를 지수 백오프로 다시 부른다.
  maxRetries: 3,
  // 밀리초 단위. 주문 1건 분석은 보통 2~5초라 25초면 충분히 넉넉하고,
  // 응답이 오지 않는 연결에 직원을 오래 붙잡아두지 않는다.
  timeout: 25_000,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const { user, reason } = await getSessionUser(req);
  if (!user) {
    if (reason === "env-missing") {
      console.error("[analyze] 세션 검증용 SUPABASE_URL/KEY 환경변수가 없습니다");
      return res.status(500).json({ error: { message: "서버 인증 설정이 없습니다. 관리자에게 알려주세요." } });
    }
    return res.status(401).json({ error: { message: "로그인 세션이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요." } });
  }

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages 가 비어 있습니다" } });
  }

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      // 4096 이었다. 실제 메모는 가장 긴 것이 703자라 잘릴 일이 거의 없지만,
      // 품목이 많은 주문에서 여유를 둔다. 쓴 만큼만 과금되므로 올려도 비용 차이는 없다.
      max_tokens: 8000,
      system: system || "",
      messages,
    });
    // 클라이언트(parseAiJson)가 content[0].text 와 stop_reason 을 그대로 읽는다.
    return res.status(200).json(message);
  } catch (error) {
    // 무엇 때문에 실패했는지 화면에서 구분할 수 있어야 한다.
    // 재시도를 다 쓰고도 실패한 것이라 여기까지 온 것 자체가 이미 드문 경우다.
    if (error instanceof Anthropic.APIError) {
      const msg =
        error.status === 429 ? "요청이 몰려 잠시 제한됐어요. 잠시 후 다시 시도해 주세요."
        : error.status === 529 ? "AI 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요."
        : error.status === 401 ? "AI 키 설정에 문제가 있습니다. 관리자에게 알려주세요."
        : error.message;
      console.error(`[analyze] ${error.status} ${error.message}`);
      return res.status(error.status || 500).json({ error: { message: msg } });
    }
    console.error("[analyze] 실패:", error);
    return res.status(500).json({ error: { message: error?.message || "분석 서버 오류" } });
  }
}
