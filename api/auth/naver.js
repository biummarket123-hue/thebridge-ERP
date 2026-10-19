import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.AUTH_SUPABASE_URL,
  process.env.AUTH_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

function getOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  const origin = getOrigin(req);
  const redirectUri = `${origin}/api/auth/naver`;
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${origin}/?error=naver_denied`);
  }

  // Step 1: 코드 없으면 네이버 로그인 페이지로 리다이렉트
  if (!code) {
    const naverState = Math.random().toString(36).substring(2, 15);
    const naverAuthUrl = `https://nid.naver.com/oauth2.0/authorize?client_id=${process.env.NAVER_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${naverState}`;
    return res.redirect(naverAuthUrl);
  }

  try {
    // Step 2: 인가 코드로 토큰 교환
    const tokenRes = await fetch("https://nid.naver.com/oauth2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.NAVER_CLIENT_ID,
        client_secret: process.env.NAVER_CLIENT_SECRET,
        code,
        state: state || "",
      }),
    });
    const tokens = await tokenRes.json();

    if (!tokens.access_token) {
      return res.redirect(`${origin}/?error=naver_token_failed`);
    }

    // Step 3: 사용자 정보 조회
    const userRes = await fetch("https://openapi.naver.com/v1/nid/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const naverData = await userRes.json();
    const naverUser = naverData.response;

    const email = naverUser?.email;
    const nickname = naverUser?.name || naverUser?.nickname || "네이버 사용자";
    const avatar = naverUser?.profile_image || "";

    if (!email) {
      return res.redirect(`${origin}/?error=naver_no_email`);
    }

    // Step 4: Supabase 사용자 생성 또는 조회
    const { data: existingList } = await supabaseAdmin.auth.admin.listUsers();
    let user = existingList?.users?.find(u => u.email === email);

    if (!user) {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          full_name: nickname,
          avatar_url: avatar,
          provider: "naver",
          naver_id: naverUser?.id,
        },
      });
      if (createErr) {
        return res.redirect(`${origin}/?error=create_failed`);
      }
      user = created?.user;
    }

    // Step 5: 매직 링크 생성 → 자동 로그인
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: origin },
    });

    if (linkErr || !linkData?.properties?.action_link) {
      return res.redirect(`${origin}/?error=link_failed`);
    }

    return res.redirect(linkData.properties.action_link);
  } catch (err) {
    return res.redirect(`${origin}/?error=naver_server_error`);
  }
}
