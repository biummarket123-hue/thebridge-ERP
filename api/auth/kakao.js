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
  const redirectUri = `${origin}/api/auth/kakao`;
  const { code, error: oauthError } = req.query;

  // 에러 처리
  if (oauthError) {
    return res.redirect(`${origin}/?error=kakao_denied`);
  }

  // Step 1: 코드 없으면 카카오 로그인 페이지로 리다이렉트
  if (!code) {
    const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?client_id=${process.env.KAKAO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
    return res.redirect(kakaoAuthUrl);
  }

  try {
    // Step 2: 인가 코드로 토큰 교환
    const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code,
      }),
    });
    const tokens = await tokenRes.json();

    if (!tokens.access_token) {
      return res.redirect(`${origin}/?error=kakao_token_failed`);
    }

    // Step 3: 사용자 정보 조회
    const userRes = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const kakaoUser = await userRes.json();

    const email = kakaoUser.kakao_account?.email;
    const nickname = kakaoUser.properties?.nickname || "카카오 사용자";
    const avatar = kakaoUser.properties?.profile_image || "";

    if (!email) {
      return res.redirect(`${origin}/?error=kakao_no_email`);
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
          provider: "kakao",
          kakao_id: kakaoUser.id,
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
    return res.redirect(`${origin}/?error=kakao_server_error`);
  }
}
