// 뼈대 — PC: 사이드바 + 상단 헤더 + 본문. 모바일(≤720px): 상단 브랜드 바 + 본문 + 하단 고정 메뉴.
// 어느 쪽이 보일지는 CSS 가 정한다(둘 다 그려 두고 media query 로 숨긴다).
import { useEffect } from "react";
import { BRAND, OLD_ERP_PATH } from "../config.js";
import { MENUS } from "../router.js";
import { Icon, BrandMark } from "../icons.jsx";

const fmtDate = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${["일", "월", "화", "수", "목", "금", "토"][d.getDay()]}요일`;

export function Sidebar({ active, counts = {}, go, manager, onProfile }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo"><BrandMark /></div>
        <div>
          <div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div>
          <div className="brand-caption">{BRAND.caption}</div>
        </div>
      </div>
      <div className="nav-section">메뉴</div>
      <nav aria-label="주 메뉴">
        {MENUS.map(m => (
          <button key={m.key} className={`nav${active === m.key ? " active" : ""}`} onClick={() => go(m.path)} aria-current={active === m.key ? "page" : undefined}>
            <Icon name={m.icon} /><span>{m.label}</span>
            {counts[m.key] > 0 ? <span className="count">{counts[m.key]}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="support">
          <strong>옛 화면이 필요하신가요?</strong>
          <p>포장 스캔·라벨 출력·공지·메모 채팅은<br /><a href={OLD_ERP_PATH}>기존 ERP 화면</a>에서 처리합니다.</p>
        </div>
        <button className="profile" onClick={onProfile} title="담당자 바꾸기 · 로그아웃">
          <div className="avatar">{(manager || "?").slice(0, 1)}</div>
          <div style={{ minWidth: 0 }}>
            <strong>{manager ? `${manager}님` : "담당자 선택"}</strong>
            <small>{BRAND.tenant}</small>
          </div>
        </button>
      </div>
    </aside>
  );
}

export function Header({ crumb, manager, onBell, onProfile, bellCount }) {
  return (
    <>
      <header className="topbar">
        <div className="crumb">전체 메뉴 <span>›</span> <strong>{crumb}</strong></div>
        <div className="top-actions">
          <div className="datepill">{fmtDate(new Date())}</div>
          <button className="iconbtn" title="처리할 일" aria-label="처리할 일" onClick={onBell}><Icon name="bell" />{bellCount > 0 ? <span className="dot" /> : null}</button>
          <button className="avatar" onClick={onProfile} title="담당자 바꾸기 · 로그아웃" aria-label="담당자">{(manager || "?").slice(0, 1)}</button>
        </div>
      </header>
      <header className="mobtop">
        <div className="brand">
          <div className="logo"><BrandMark /></div>
          <div className="brand-name">{BRAND.name}<span>{BRAND.suffix}</span></div>
        </div>
        <div className="right">
          <button className="iconbtn" aria-label="처리할 일" onClick={onBell}><Icon name="bell" />{bellCount > 0 ? <span className="dot" /> : null}</button>
          <button className="avatar" onClick={onProfile} aria-label="담당자">{(manager || "?").slice(0, 1)}</button>
        </div>
      </header>
    </>
  );
}

export function MobileNavigation({ active, go, counts = {} }) {
  return (
    <nav className="mobile-bottom" aria-label="하단 메뉴">
      {MENUS.map(m => (
        <button key={m.key} className={`mobile-nav${active === m.key ? " active" : ""}`} onClick={() => go(m.path)} aria-current={active === m.key ? "page" : undefined}>
          <Icon name={m.icon} /><span>{m.short}</span>
          {counts[m.key] > 0 ? <span className="count">{counts[m.key]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function AppLayout({ active, crumb, counts, go, manager, onBell, onProfile, bellCount, children }) {
  // 화면이 바뀌면 맨 위로 — 시안의 go() 가 하던 일
  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [active]);
  return (
    <div className="app">
      <Sidebar active={active} counts={counts} go={go} manager={manager} onProfile={onProfile} />
      <main className="main">
        <Header crumb={crumb} manager={manager} onBell={onBell} onProfile={onProfile} bellCount={bellCount} />
        <section className="content" id="saas-content">{children}</section>
      </main>
      <MobileNavigation active={active} go={go} counts={counts} />
    </div>
  );
}
