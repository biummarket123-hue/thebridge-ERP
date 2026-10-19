// 홈(/) — 로그인과 체험, 두 갈래. 체험은 방문자마다 1시간짜리 임시 회사를 만들어 샘플 데이터로 써 보게 한다.
// 체험 회사는 1시간 뒤 읽기 전용이 되고(trial_end), 브라우저는 자동 로그아웃, 서버 크론이 통째로 지운다 — 남는 게 없다.
import { useEffect, useState } from "react";
import "./tokens.css";
import "./saas.css";
import * as db from "../lib/db.js";
import { supabase } from "../lib/supabase.js";
import { Button } from "./components/ui.jsx";
import { BrandMark, Icon } from "./icons.jsx";
import { BRAND } from "./config.js";
import { postAccount } from "./auth/SaasAuth.jsx";

export const DEMO_UNTIL_KEY = "erp_demo_until";

const FEATURES = [
  ["sparkle", "주문 붙여넣기 → AI 분석", "카톡·밴드 주문 글을 그대로 붙여 넣으면 고객·품목·금액·주소를 읽어 등록합니다."],
  ["truck", "입금 → 포장 → 출고 3단계", "입금 확인 전에는 출고가 안 되는 업무 규칙이 화면에 들어 있습니다."],
  ["box", "롤 단위 재고", "품번·롤·잔량·위치를 관리하고 QR 라벨로 찍습니다."],
  ["pin", "담당자 PIN", "회사 계정 하나로 들어와 직원은 이름과 4자리 PIN 으로 작업합니다."],
];

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const expired = typeof location !== "undefined" && /[?&]expired=1/.test(location.search);

  useEffect(() => {
    document.body.setAttribute("data-saas", "1");
    document.title = `${BRAND.name} ${BRAND.suffix}`;
    return () => document.body.removeAttribute("data-saas");
  }, []);

  const startDemo = async () => {
    setErr(""); setBusy(true);
    try {
      // 이전 세션·토큰이 남아 있으면 지운다 — 체험 회사와 섞이지 않게
      try { await db.revokeManagerToken(); } catch { /* 무시 */ }
      try { await supabase.auth.signOut({ scope: "local" }); } catch { /* 무시 */ }
      const r = await postAccount("demo", {});
      const { error } = await supabase.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token });
      if (error) throw error;
      // 담당자 선택·PIN 확인을 대신 해 둔다(체험자는 PIN 을 모른다). 기기 고정이라 30분 뒤 다시 묻지 않는다.
      localStorage.setItem("erp_manager", r.manager.name);
      localStorage.setItem("erp_manager_pinned", "1");
      localStorage.setItem("erp_manager_pin_at", String(Date.now()));
      localStorage.setItem(DEMO_UNTIL_KEY, String(new Date(r.expiresAt).getTime()));
      try { const v = await db.verifyManagerPin(r.manager.id, r.manager.pin); if (v?.ok && v.token) db.setManagerToken(v.token); } catch { /* 토큰 없이도 둘러보기는 된다 */ }
      window.location.href = "/app";
    } catch (e) { setErr(e.message || "체험 환경을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."); setBusy(false); }
  };

  return (
    <div className="saas">
      <div className="landing">
        <header className="landing-top">
          <div className="brand" style={{ margin: 0 }}>
            <div className="logo"><BrandMark /></div>
            <div><div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div><div className="brand-caption">{BRAND.caption}</div></div>
          </div>
          <a className="btn btn-white btn-sm" href="/app" style={{ textDecoration: "none" }}>로그인</a>
        </header>

        <section className="landing-hero">
          <p className="eyebrow">원단 도매 전용 ERP</p>
          <h1>주문부터 출고까지,<br />원단 가게 일을 한 화면에.</h1>
          <p className="lead">카톡 주문 붙여넣기, 입금·포장·출고 3단계, 롤 단위 재고, 담당자 PIN. 동대문 원단 매장에서 실제로 쓰는 흐름 그대로입니다.</p>
          {expired && <p className="helptext warn" style={{ maxWidth: 520, margin: "0 auto 18px" }}>체험 1시간이 끝났습니다. 체험 중 입력한 내용은 저장되지 않습니다. 다시 체험하거나 회사 계정으로 로그인해 주세요.</p>}
          {err && <p className="helptext err" style={{ maxWidth: 520, margin: "0 auto 18px" }}>{err}</p>}
          <div className="landing-cta">
            <Button icon="sparkle" loading={busy} onClick={startDemo}>1시간 체험해 보기</Button>
            <a className="btn btn-white" href="/app" style={{ textDecoration: "none" }}><Icon name="user" /> 회사 계정 로그인</a>
          </div>
          <p className="landing-note">체험은 가입 없이 바로 시작됩니다. 샘플 주문·재고가 들어 있는 임시 회사가 만들어지고, 1시간 뒤 자동으로 끝나며 입력한 내용은 남지 않습니다.</p>
        </section>

        <section className="landing-features">
          {FEATURES.map(([icon, title, desc]) => (
            <div className="panel" key={title}>
              <div className="feat-icon"><Icon name={icon} /></div>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </section>

        <footer className="landing-foot">
          <span>{BRAND.name} {BRAND.suffix} · 구독형 원단 ERP</span>
          <a href="/app">새 회사 가입은 로그인 화면에서</a>
        </footer>
      </div>
    </div>
  );
}
