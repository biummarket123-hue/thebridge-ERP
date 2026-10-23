// 새 SaaS UI 의 루트 — /app 아래. 회사 로그인(AppEntry.CompanyRoot)이 끝난 뒤 그려진다.
// 담당자(작업자)를 아직 고르지 않았으면 먼저 고르게 한다 — 변경 기록·담당자 잠금이 그 이름을 쓴다.
import { useEffect, useState } from "react";
import "./tokens.css";
import "./saas.css";
import * as db from "../lib/db.js";
import { supabase } from "../lib/supabase.js";
import { SaasDataProvider, useSaas } from "./data/SaasData.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { AppLayout } from "./components/AppLayout.jsx";
import { Modal } from "./components/Modal.jsx";
import { Button } from "./components/ui.jsx";
import { SaasLoader } from "./components/Loading.jsx";
import { CompanyBrand } from "./components/CompanyBrand.jsx";
import { HelpButton } from "./components/SupportLinks.jsx";
import { useRoute, ALL_ROUTES, menuPath } from "./router.js";
import { BRAND } from "./config.js";
import { BrandMark, Icon } from "./icons.jsx";
import HomePage from "./pages/HomePage.jsx";
import OrdersPage from "./pages/OrdersPage.jsx";
import StockPage from "./pages/StockPage.jsx";
import CustomersPage from "./pages/CustomersPage.jsx";
import SettlementPage from "./pages/SettlementPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import PackPage from "./pages/PackPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import Onboarding from "./pages/Onboarding.jsx";
import { PinGate } from "./auth/PinGate.jsx";
import { subscriptionNotice } from "./lib/subscription.js";
import { DEMO_UNTIL_KEY } from "./Landing.jsx";

// 체험 세션: 홈에서 시작할 때 localStorage 에 만료 시각을 적는다. 지나면 로그아웃하고 홈으로.
const readDemoUntil = () => { try { return Number(localStorage.getItem(DEMO_UNTIL_KEY)) || 0; } catch { return 0; } };
async function endDemo() {
  try { await db.revokeManagerToken(); } catch { /* 무시 */ }
  try { await supabase.auth.signOut({ scope: "local" }); } catch { /* 무시 */ }
  for (const k of [DEMO_UNTIL_KEY, "erp_manager", "erp_manager_pinned", "erp_manager_pin_at"]) { try { localStorage.removeItem(k); } catch { /* 무시 */ } }
  window.location.href = "/?expired=1";
}
function DemoBanner() {
  const [left, setLeft] = useState(() => readDemoUntil() - Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const l = readDemoUntil() - Date.now();
      setLeft(l);
      if (l <= 0) { clearInterval(t); endDemo(); }
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const m = Math.max(0, Math.floor(left / 60000)), s = Math.max(0, Math.floor((left % 60000) / 1000));
  return (
    <div className="sub-banner demo">
      <span>🧪 체험 중 — 남은 시간 <b>{m}:{String(s).padStart(2, "0")}</b>. 입력한 내용은 1시간 뒤 자동으로 지워집니다.</span>
      <Button kind="white" size="sm" icon="logout" onClick={endDemo}>체험 끝내기</Button>
    </div>
  );
}
import { TodoModal } from "./pages/HomePage.jsx";

async function logout() {
  if (readDemoUntil() > 0) return endDemo();
  try { await db.revokeManagerToken(); } catch { /* 무시 */ }
  try { await supabase.auth.signOut({ scope: "local" }); } catch (e) { console.warn("[logout]", e); }
  localStorage.removeItem(db.GATE_UNTIL_KEY);
  localStorage.removeItem(db.GATE_TOKEN_KEY);
  sessionStorage.removeItem("company_authenticated");
  localStorage.removeItem("erp_manager_pin_at");
  window.location.href = "/app";   // 새 UI 의 회사 로그인 화면으로
}

function ManagerPicker({ onClose, required, go }) {
  const { managers, activeManager, setActiveManager, config, pinOf } = useSaas();
  const personal = managers.filter(m => !m.isPublic);
  const body = (
    <>
      <p className="helptext">{required ? "작업을 시작하기 전에 누가 처리하는지 골라 주세요. 변경 기록과 담당자 잠금이 이 이름을 씁니다." : "다른 담당자로 바꾸거나 로그아웃할 수 있습니다."}</p>
      <div className="manager-pick">
        {personal.length === 0 && <div className="empty small">등록된 담당자가 없습니다 — 회사 설정에서 담당자를 먼저 등록해 주세요.</div>}
        {personal.map(m => (
          <button key={m.name} className={activeManager === m.name ? "on" : ""} onClick={() => { setActiveManager(m.name); onClose?.(); }}>
            <span className="avatar" style={{ width: 34, height: 34, borderRadius: 11, fontSize: 14 }}>{m.name.slice(0, 1)}</span>
            <span>{m.name}</span>
            {pinOf(m)?.has_pin ? <span className="pin-mark" title="PIN 있음"><Icon name="pin" /></span> : null}
            {m.isAdmin ? <span className="tag">관리자</span> : m.isPacker ? <span className="tag" style={{ background: "#eaf2ff", color: "#2e6ee8" }}>포장</span> : null}
          </button>
        ))}
      </div>
      {!required && (
        <>
          <div className="btnrow" style={{ marginTop: 22 }}>
            <Button kind="white" icon="settings" onClick={() => { onClose?.(); go?.("/app/settings"); }}>회사 설정</Button>
            <HelpButton className="btn btn-white">도움말 · 문의</HelpButton>
            <Button kind="white" icon="logout" onClick={logout}>로그아웃</Button>
          </div>
        </>
      )}
    </>
  );
  if (required) {
    return (
      <div className="gate">
        <div className="sheet" role="dialog" aria-modal="true" aria-label="담당자 선택">
          <CompanyBrand style={{ margin: "0 0 18px" }} />
          <div className="sheethead"><h2>누가 작업하나요?</h2></div>
          {body}
          <div className="btnrow" style={{ marginTop: 18 }}>
            {personal.length === 0 && <Button kind="white" icon="settings" className="btn-sm" onClick={() => go?.("/app/settings")}>회사 설정</Button>}
            <Button kind="white" icon="logout" onClick={logout} className="btn-sm">로그아웃</Button>
          </div>
        </div>
      </div>
    );
  }
  return <Modal title="담당자" onClose={onClose}>{body}</Modal>;
}

function Shell() {
  const route = useRoute();
  const { loaded, error, activeManager, managers, overview, orders, syncLost, reloadOrders, pinRequired, subscription, readOnly, account, settings, isAdmin } = useSaas();
  const [picker, setPicker] = useState(false);
  const [todo, setTodo] = useState(false);
  const menu = ALL_ROUTES.find(m => m.key === route.menu) || ALL_ROUTES[0];
  const isDemo = readDemoUntil() > 0;
  const subNotice = isDemo ? "" : subscriptionNotice(subscription);

  // 변경 기록에 "어느 화면에서" — 옛 화면의 탭 이름과 구별되게 접두어를 붙인다
  db.setScreen(`새 UI · ${menu.label}`);

  useEffect(() => { document.title = `${menu.label} · ${BRAND.name} ${BRAND.suffix}`; }, [menu.label]);

  if (error) {
    return (
      <div className="gate"><div className="sheet">
        <div className="sheethead"><h2>연결이 끊겼습니다</h2></div>
        <p className="helptext err">{error}</p>
        <Button onClick={() => window.location.reload()} icon="refresh">다시 불러오기</Button>
      </div></div>
    );
  }
  if (!loaded) return <SaasLoader text="회사 데이터를 불러오는 중…" />;
  // 담당자가 한 명도 없는 새 회사 → 설정 화면으로 보낸다(가입 직후 서버가 관리자를 만들어 주므로 드물다)
  const noManagers = managers.filter(m => !m.isPublic).length === 0;
  if (!activeManager && managers.length > 0 && !(noManagers && menu.key === "settings")) return <ManagerPicker required go={route.go} />;
  if (activeManager && pinRequired) return <PinGate />;
  // 가입 직후 첫 설정(온보딩) — 구독 회사의 관리자에게 한 번. 체험(데모)·사내 계정은 건너뛴다. settings 를 아직 못 읽었으면 기다린다.
  if (account && !account.is_demo && !isDemo && isAdmin && settings && !settings.saas?.onboardingDone && menu.key !== "settings") return <Onboarding go={route.go} />;

  const counts = { orders: orders.filter(o => o.status !== "출고완료" && o.payment !== "환불").length };
  const pages = { home: HomePage, orders: OrdersPage, stock: StockPage, customers: CustomersPage, settlement: SettlementPage, settings: SettingsPage, pack: PackPage, history: HistoryPage };
  const Page = pages[menu.key] || HomePage;

  return (
    <AppLayout active={menu.key} crumb={menu.crumb} counts={counts} go={route.go} manager={activeManager}
      onBell={() => setTodo(true)} onProfile={() => setPicker(true)} bellCount={overview.flagged}>
      {isDemo && <DemoBanner />}
      {subNotice && menu.key !== "settings" && (
        <div className={`sub-banner${readOnly ? " ro" : ""}`}>
          <span>{subNotice}</span>
          <Button kind="white" size="sm" icon="settings" onClick={() => route.go("/app/settings")}>구독 보기</Button>
        </div>
      )}
      {syncLost && (
        <div className="sync-lost">
          <span>서버와 연결이 끊겨 목록이 최신이 아닐 수 있습니다.</span>
          <Button kind="white" size="sm" icon="refresh" onClick={reloadOrders}>다시 읽기</Button>
        </div>
      )}
      <div className="fadein" key={menu.key}>
        <Page route={route} />
      </div>
      {picker && <ManagerPicker onClose={() => setPicker(false)} go={route.go} />}
      {todo && <TodoModal onClose={() => setTodo(false)} go={(p) => { setTodo(false); route.go(p); }} />}
    </AppLayout>
  );
}

export default function SaasApp() {
  useEffect(() => {
    document.body.setAttribute("data-saas", "1");
    // 옛 ErpApp 이 body 배경을 인라인으로 박아 두고 떠난 경우를 대비해 비운다
    const prevBg = document.body.style.background, prevColor = document.body.style.color;
    document.body.style.background = ""; document.body.style.color = "";
    return () => { document.body.removeAttribute("data-saas"); document.body.style.background = prevBg; document.body.style.color = prevColor; };
  }, []);
  return (
    <div className="saas">
      <ToastProvider>
        <SaasDataProvider>
          <Shell />
        </SaasDataProvider>
      </ToastProvider>
    </div>
  );
}

export { menuPath };
