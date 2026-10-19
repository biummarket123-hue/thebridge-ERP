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
import { useRoute, MENUS, menuPath } from "./router.js";
import { BRAND, OLD_ERP_PATH } from "./config.js";
import { BrandMark } from "./icons.jsx";
import HomePage from "./pages/HomePage.jsx";
import OrdersPage from "./pages/OrdersPage.jsx";
import StockPage from "./pages/StockPage.jsx";
import CustomersPage from "./pages/CustomersPage.jsx";
import SettlementPage from "./pages/SettlementPage.jsx";
import { TodoModal } from "./pages/HomePage.jsx";

async function logout() {
  try { await supabase.auth.signOut({ scope: "local" }); } catch (e) { console.warn("[logout]", e); }
  localStorage.removeItem(db.GATE_UNTIL_KEY);
  localStorage.removeItem(db.GATE_TOKEN_KEY);
  sessionStorage.removeItem("company_authenticated");
  window.location.href = OLD_ERP_PATH;
}

function ManagerPicker({ onClose, required }) {
  const { managers, activeManager, setActiveManager } = useSaas();
  const personal = managers.filter(m => !m.isPublic);
  const body = (
    <>
      <p className="helptext">{required ? "작업을 시작하기 전에 누가 처리하는지 골라 주세요. 변경 기록과 담당자 잠금이 이 이름을 씁니다." : "다른 담당자로 바꾸거나 로그아웃할 수 있습니다."}</p>
      <div className="manager-pick">
        {personal.length === 0 && <div className="empty small">등록된 담당자가 없습니다 — 옛 화면의 설정에서 담당자를 먼저 등록해 주세요.</div>}
        {personal.map(m => (
          <button key={m.name} className={activeManager === m.name ? "on" : ""} onClick={() => { setActiveManager(m.name); onClose?.(); }}>
            <span className="avatar" style={{ width: 34, height: 34, borderRadius: 11, fontSize: 14 }}>{m.name.slice(0, 1)}</span>
            <span>{m.name}</span>
            {m.isAdmin ? <span className="tag">관리자</span> : m.isPacker ? <span className="tag" style={{ background: "#eaf2ff", color: "#2e6ee8" }}>포장</span> : null}
          </button>
        ))}
      </div>
      {!required && (
        <div className="btnrow" style={{ marginTop: 22 }}>
          <Button kind="white" icon="logout" onClick={logout}>로그아웃</Button>
          <a className="btn btn-white" href={OLD_ERP_PATH} style={{ textDecoration: "none" }}>옛 ERP 화면 열기</a>
        </div>
      )}
    </>
  );
  if (required) {
    return (
      <div className="gate">
        <div className="sheet" role="dialog" aria-modal="true" aria-label="담당자 선택">
          <div className="brand" style={{ margin: "0 0 18px" }}>
            <div className="logo"><BrandMark /></div>
            <div><div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div><div className="brand-caption">{BRAND.tenant}</div></div>
          </div>
          <div className="sheethead"><h2>누가 작업하나요?</h2></div>
          {body}
          <div style={{ marginTop: 18 }}><Button kind="white" icon="logout" onClick={logout} className="btn-sm">로그아웃</Button></div>
        </div>
      </div>
    );
  }
  return <Modal title="담당자" onClose={onClose}>{body}</Modal>;
}

function Shell() {
  const route = useRoute();
  const { loaded, error, activeManager, managers, overview, orders, syncLost, reloadOrders } = useSaas();
  const [picker, setPicker] = useState(false);
  const [todo, setTodo] = useState(false);
  const menu = MENUS.find(m => m.key === route.menu) || MENUS[0];

  // 변경 기록에 "어느 화면에서" — 옛 화면의 탭 이름과 구별되게 접두어를 붙인다
  db.setScreen(`새 UI · ${menu.label}`);

  useEffect(() => { document.title = `${menu.label} · ${BRAND.name}${BRAND.suffix}`; }, [menu.label]);

  if (error) {
    return (
      <div className="gate"><div className="sheet">
        <div className="sheethead"><h2>연결이 끊겼습니다</h2></div>
        <p className="helptext err">{error}</p>
        <Button onClick={() => window.location.reload()} icon="refresh">다시 불러오기</Button>
      </div></div>
    );
  }
  if (!loaded) return <div className="gate"><div className="loading-line">불러오는 중…</div></div>;
  if (!activeManager && managers.length > 0) return <ManagerPicker required />;

  const counts = { orders: orders.filter(o => o.status !== "출고완료" && o.payment !== "환불").length };
  const pages = { home: HomePage, orders: OrdersPage, stock: StockPage, customers: CustomersPage, settlement: SettlementPage };
  const Page = pages[menu.key] || HomePage;

  return (
    <AppLayout active={menu.key} crumb={menu.crumb} counts={counts} go={route.go} manager={activeManager}
      onBell={() => setTodo(true)} onProfile={() => setPicker(true)} bellCount={overview.flagged}>
      {syncLost && (
        <div className="sync-lost">
          <span>서버와 연결이 끊겨 목록이 최신이 아닐 수 있습니다.</span>
          <Button kind="white" size="sm" icon="refresh" onClick={reloadOrders}>다시 읽기</Button>
        </div>
      )}
      <div className="fadein" key={menu.key}>
        <Page route={route} />
      </div>
      {picker && <ManagerPicker onClose={() => setPicker(false)} />}
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
